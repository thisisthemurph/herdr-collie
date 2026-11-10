// `collie ctl` command handlers (docs/protocol.md, "Control commands"). Each returns its result
// or throws CommandError with the protocol's error code and a message naming the broken rule.
import { existsSync, readdirSync, rmSync } from "node:fs";
import {
  type Board,
  type BoardSettings,
  type Command,
  formatIssues,
  type Profile,
  type Result,
  type RunFile,
  validateBoard,
  validateProfile,
  validateWorkflow,
  type Workflow,
} from "@collie/schema";
import {
  boardImport,
  boardRefresh,
  pullIn,
  readinessEvents,
  reevaluateRun,
  requireNoCycle,
} from "./boards.ts";
import { CommandError, type Controller, isoSeconds, type Ok } from "./controller.ts";
import { reviewRound } from "./gate.ts";
import { readJson, writeJsonAtomic } from "./home.ts";
import { isExecutionFinal, isTicketFinal } from "./machines.ts";
import { RunLog } from "./runlog.ts";

/** DECISION: board defaults, from the protocol's example board. */
export const DEFAULT_SETTINGS: BoardSettings = {
  workflow: "standard-feature",
  max_tickets: 3,
  max_agents: 6,
  completion_policy: { mode: "done_or_resolved", statuses: [] },
  complete_at: "pr_created",
  pr_draft_policy: "draft_when_stacked",
  jira_writeback: { on_start: "In Progress", on_pr: "In Review", comment: true },
};

const unsupported = (what: string, phase: number) =>
  new CommandError("unsupported", `${what} is not supported yet; it arrives in Phase ${phase}`);

type Args<K extends Command["command"]> = Extract<Command, { command: K }>["args"];

export function handleCommand(c: Controller, cmd: Command): Ok | Promise<Ok> {
  switch (cmd.command) {
    case "board.create":
      return boardCreate(c, cmd.id, cmd.args);
    case "board.update_settings": {
      const board = c.loadBoard(cmd.args.board_id);
      const next = { ...board, settings: { ...board.settings, ...cmd.args.settings } as BoardSettings };
      checkBoard(next);
      c.saveBoard(next);
      return {};
    }
    case "ticket.set_preparation": {
      const r = editTicket(c, cmd.args.board_id, cmd.args.ticket, (t) => {
        t.preparation = cmd.args.preparation;
      });
      reevaluateRun(c, cmd.args.board_id, cmd.id);
      return r;
    }
    case "ticket.pull_in":
      return pullIn(c, cmd.args.board_id, cmd.args.ticket);
    case "ticket.set_workflow": {
      const wf = cmd.args.workflow;
      if (wf !== null && !existsSync(c.home.workflow(wf)))
        throw new CommandError("not_found", `workflow ${wf} doesn't exist; save it first with workflow.save`);
      // Takes effect in the next run: a running run keeps its snapshot.
      return editTicket(c, cmd.args.board_id, cmd.args.ticket, (t) => {
        t.workflow = wf;
      });
    }
    case "dep.override":
    case "dep.restore": {
      const r = depOverride(c, cmd.command === "dep.override", cmd.args);
      reevaluateRun(c, cmd.args.board_id, cmd.id);
      return r;
    }
    case "profile.save":
      writeJsonAtomic(c.home.profile(cmd.args.id), cmd.args);
      return {};
    case "workflow.save":
      writeJsonAtomic(c.home.workflow(cmd.args.id), cmd.args);
      return {};
    case "run.start":
      return runStart(c, cmd.id, cmd.args);
    case "run.pause":
    case "run.resume": {
      const rl = c.requireRun(cmd.args.run_id);
      // The run state machine: running -> paused (pause), paused -> running (resume).
      const [from, type] =
        cmd.command === "run.pause" ? ["running", "run.paused"] : ["paused", "run.resumed"];
      if (rl.state.status !== from)
        throw new CommandError("invalid_state", `run ${rl.id} is ${rl.state.status}, not ${from}`);
      c.emit(rl, [
        c.event(rl.id, type, cmd.args.reason ? { reason: cmd.args.reason } : {}, {
          cause: cmd.id,
          source: "human",
        }),
      ]);
      c.syncRunFile(rl);
      return {};
    }
    case "run.cancel":
      return runCancel(c, cmd.id, cmd.args);
    case "run.delete":
      return runDelete(c, cmd.args.run_id);
    case "ticket.cancel":
      return ticketCancel(c, cmd.id, cmd.args);
    case "exec.cancel": {
      const rl = c.requireLog(cmd.args.run_id);
      const e = rl.state.executions[cmd.args.execution_id];
      if (!e)
        throw new CommandError("not_found", `execution ${cmd.args.execution_id} is not in run ${rl.id}`);
      if (isExecutionFinal(e.state))
        throw new CommandError("invalid_state", `execution ${cmd.args.execution_id} is already ${e.state}`);
      c.cancelExecution(rl, cmd.args.execution_id, "cancelled by a person", cmd.id);
      return c.killTerminals(rl, [cmd.args.execution_id], "cancelled by a person").then(() => ({}));
    }
    case "question.answer": {
      // A board id names the board's preparation log: the analyst's questions are answered here too.
      const rl = c.requireLog(cmd.args.run_id);
      const q = rl.state.questions[cmd.args.question_id];
      if (!q) throw new CommandError("not_found", `question ${cmd.args.question_id} is not in run ${rl.id}`);
      if (q.state !== "open")
        throw new CommandError(
          "invalid_state",
          `question ${cmd.args.question_id.slice(-6)} is already ${q.state}`,
        );
      c.emit(rl, [
        c.event(
          rl.id,
          "question.answered",
          {
            question_id: cmd.args.question_id,
            answer: cmd.args.answer,
            by: "human",
            share_with_ticket: cmd.args.share_with_ticket,
          },
          { ticket: q.ticket, cause: cmd.id, source: "human" },
        ),
      ]);
      // Delivery to the agent happens when its turn has ended (Agents.deliverAnswer).
      return { delivered: false };
    }
    case "board.import":
      return boardImport(c, cmd.args.board_id, cmd.args);
    case "board.refresh":
      return boardRefresh(c, cmd.args.board_id, cmd.id);
    case "ticket.investigate":
      return ticketInvestigate(c, cmd.args);
    case "ticket.retry":
      return ticketRetry(c, cmd.id, cmd.args);
    case "pr.mark_ready":
      throw unsupported("pr.mark_ready (needs Bitbucket)", 6);
  }
}

function checkBoard(board: Board): void {
  const r = validateBoard(board);
  if (!r.ok) throw new CommandError("invalid_args", formatIssues(r.issues));
}

async function boardCreate(c: Controller, cmdId: string, a: Args<"board.create">): Promise<Ok> {
  // DECISION: the board id is the command id, so a command re-run after a crash is a no-op.
  if (existsSync(c.home.board(cmdId))) return { board_id: cmdId };
  // The cloud id is looked up once, here, and cached on the board (protocol, "Board").
  const cloudId = a.jira.cloud_id ?? (await c.requireJira().cloudId(a.jira.site));
  const board: Board = {
    v: 1,
    id: cmdId,
    name: a.name,
    jira: { site: a.jira.site, cloud_id: cloudId, project: a.jira.project },
    repo: a.repo,
    settings: { ...DEFAULT_SETTINGS, ...a.settings } as BoardSettings,
    tickets: {},
    overrides: [],
    updated_at: isoSeconds(c.clock.now()),
  };
  checkBoard(board);
  c.saveBoard(board);
  return { board_id: cmdId };
}

function editTicket(
  c: Controller,
  boardId: string,
  key: string,
  edit: (t: Board["tickets"][string]) => void,
): Ok {
  const board = c.loadBoard(boardId);
  const t = board.tickets[key];
  if (!t) throw new CommandError("not_found", `${key} is not on board ${boardId}`);
  edit(t);
  c.saveBoard(board);
  return { added: true };
}

function depOverride(c: Controller, override: boolean, a: Args<"dep.override">): Ok {
  const board = c.loadBoard(a.board_id);
  const blocked = board.tickets[a.blocked];
  if (!blocked) throw new CommandError("not_found", `${a.blocked} is not on board ${a.board_id}`);
  if (!blocked.blocked_by.includes(a.blocker))
    throw new CommandError("not_found", `${a.blocked} isn't blocked by ${a.blocker}`);
  const has = board.overrides.some((o) => o.blocker === a.blocker && o.blocked === a.blocked);
  if (override) {
    if (has)
      throw new CommandError("invalid_state", `the link ${a.blocker} -> ${a.blocked} is already overridden`);
    board.overrides.push({
      blocker: a.blocker,
      blocked: a.blocked,
      by: "human",
      at: isoSeconds(c.clock.now()),
    });
  } else {
    if (!has)
      throw new CommandError("invalid_state", `the link ${a.blocker} -> ${a.blocked} isn't overridden`);
    board.overrides = board.overrides.filter((o) => !(o.blocker === a.blocker && o.blocked === a.blocked));
  }
  // Readiness is recalculated from Phase 3 on; a running run keeps its snapshot.
  c.saveBoard(board);
  return {};
}

function loadConfig<T>(path: string, what: string, validate: (v: unknown) => Result<T>): T {
  if (!existsSync(path))
    throw new CommandError(
      "not_found",
      `${what} doesn't exist; save it first with ${what.split(" ")[0]}.save`,
    );
  const r = validate(readJson(path));
  if (!r.ok) throw new CommandError("internal", `${what} is invalid on disk: ${formatIssues(r.issues)}`);
  return r.value;
}

function runStart(c: Controller, cmdId: string, a: Args<"run.start">): Ok {
  // DECISION: the run id is the command id, so a command re-run after a crash is a no-op.
  if (existsSync(c.home.runFile(cmdId))) return { run_id: cmdId };
  const board = c.loadBoard(a.board_id);
  for (const rl of c.runs.values()) {
    if (rl.run.board_id === board.id) {
      throw new CommandError(
        "invalid_state",
        `board ${board.id} already has an active run (${rl.id}); a board has one active run at a time`,
      );
    }
  }
  const keys = Object.entries(board.tickets)
    .filter(([, t]) => t.on_board && t.preparation !== "excluded")
    .map(([k]) => k)
    .sort();
  if (keys.length === 0) throw new CommandError("invalid_state", `board ${board.id} has no tickets to run`);
  requireNoCycle(board);
  const held = c.leases();
  const conflicts = keys.filter((k) => held.has(k));
  if (conflicts.length) {
    const detail = conflicts.map((k) => `${k} (run ${held.get(k)})`).join(", ");
    throw new CommandError(
      "lease_conflict",
      `ticket${conflicts.length > 1 ? "s" : ""} ${detail} ${conflicts.length > 1 ? "are" : "is"} leased by another active run; a ticket can be in one run at a time. Finish or cancel that run first.`,
    );
  }

  // Snapshot: the workflows in use and the profiles they name.
  const workflowIds = new Set([
    board.settings.workflow,
    ...keys.map((k) => board.tickets[k]?.workflow).filter((w): w is string => !!w),
  ]);
  const workflows: Record<string, Workflow> = {};
  const profiles: Record<string, Profile> = {};
  for (const w of [...workflowIds].sort()) {
    const wf = loadConfig(c.home.workflow(w), `workflow ${w}`, validateWorkflow);
    workflows[w] = wf;
    for (const p of [wf.developer, ...wf.reviewers.map((r) => r.profile)]) {
      profiles[p] ??= loadConfig(c.home.profile(p), `profile ${p}`, validateProfile);
    }
  }

  let carried = new Set<string>();
  if (a.carry_over_from) {
    const prev = a.carry_over_from;
    if (!existsSync(c.home.runFile(prev))) throw new CommandError("not_found", `run ${prev} doesn't exist`);
    if (c.runs.has(prev))
      throw new CommandError("invalid_state", `run ${prev} hasn't ended; carry over from an ended run`);
    const prevLog = RunLog.load(c.home, prev, () => {});
    carried = new Set(
      Object.entries(prevLog.state.tickets)
        .filter(([, t]) => t.state === "completed")
        .map(([k]) => k),
    );
  }

  const number =
    readdirSync(c.home.runs).filter((id) => {
      try {
        return (readJson(c.home.runFile(id)) as RunFile).board_id === board.id;
      } catch {
        return false;
      }
    }).length + 1;
  const now = c.clock.now();
  const run: RunFile = {
    v: 1,
    id: cmdId,
    board_id: board.id,
    number,
    status: "running",
    started_at: new Date(now).toISOString(),
    ended_at: null,
    end_reason: null,
    carried_over_from: a.carry_over_from ?? null,
    snapshot: {
      settings: board.settings,
      tickets: board.tickets,
      overrides: board.overrides,
      workflows,
      profiles,
    },
  };
  const o = { cause: cmdId, source: "human" as const };
  const first = [
    c.event(
      cmdId,
      "run.started",
      { board_id: board.id, number, carried_over_from: run.carried_over_from },
      o,
    ),
    ...keys.map((k) => c.event(cmdId, "ticket.leased", {}, { ticket: k, cause: cmdId })),
    ...keys.map((k) =>
      c.event(
        cmdId,
        "ticket.state_changed",
        carried.has(k)
          ? { from: null, to: "completed", reason: `completed in run ${a.carry_over_from}` }
          : {
              from: null,
              to: "pending",
              reason: "leased at run start",
            },
        { ticket: k, cause: cmdId },
      ),
    ),
    c.event(cmdId, "command.applied", { command: "run.start" }, o),
  ];
  const rl = RunLog.create(c.home, run, first, now);
  c.runs.set(rl.id, rl);
  c.saveLeases();
  c.emit(rl, readinessEvents(c, rl, board, cmdId));
  c.completeRunIfDone(rl, cmdId);
  return { run_id: rl.id };
}

async function ticketCancel(c: Controller, cmdId: string, a: Args<"ticket.cancel">): Promise<Ok> {
  const rl = c.requireRun(a.run_id);
  const t = rl.state.tickets[a.ticket];
  if (!t) throw new CommandError("not_found", `${a.ticket} is not in run ${rl.id}`);
  if (isTicketFinal(t.state)) throw new CommandError("invalid_state", `${a.ticket} is already ${t.state}`);
  const killed = c.cancelExecutions(rl, a.ticket, "ticket cancelled", cmdId);
  c.emit(rl, [
    c.ticketTo(rl, a.ticket, "cancelled", "cancelled by a person", { cause: cmdId, source: "human" }),
  ]);
  c.completeRunIfDone(rl, cmdId);
  await c.killTerminals(rl, killed, "ticket cancelled");
  return {};
}

/** DECISION: the analyst's profile is the one called `requirements-analyst`. */
export const ANALYST_PROFILE = "requirements-analyst";

/** ticket.investigate: an analyst reads each ticket and the code, asks its questions, and says when it is ready. */
function ticketInvestigate(c: Controller, a: Args<"ticket.investigate">): Ok {
  if (!c.agents) throw new CommandError("unsupported", "this controller can't start agents");
  const board = c.loadBoard(a.board_id);
  for (const key of a.tickets) {
    const t = board.tickets[key];
    if (!t) throw new CommandError("not_found", `${key} is not on board ${board.id}`);
    if (!t.on_board)
      throw new CommandError(
        "invalid_state",
        `${key} is an outside blocker, not a ticket on the board; pull it in first`,
      );
  }
  const path = c.home.profile(ANALYST_PROFILE);
  if (!existsSync(path))
    throw new CommandError(
      "not_found",
      `profile ${ANALYST_PROFILE} doesn't exist; save it with profile.save (role analyst)`,
    );
  const p = validateProfile(readJson(path));
  if (!p.ok)
    throw new CommandError(
      "internal",
      `profile ${ANALYST_PROFILE} is invalid on disk: ${formatIssues(p.issues)}`,
    );
  if (p.value.role !== "analyst")
    throw new CommandError(
      "invalid_state",
      `profile ${ANALYST_PROFILE} has the role ${p.value.role}, not analyst`,
    );
  const rl = c.prepLog(board.id);
  rl.run.snapshot.profiles[ANALYST_PROFILE] = p.value; // the profile as it is now
  const busy = a.tickets.filter((k) =>
    Object.values(rl.state.executions).some(
      (e) => e.ticket === k && e.kind === "analyse" && !isExecutionFinal(e.state),
    ),
  );
  if (busy.length)
    throw new CommandError(
      "invalid_state",
      `${busy.join(", ")} ${busy.length > 1 ? "are" : "is"} already being investigated`,
    );
  const fresh = c.loadBoard(board.id);
  for (const key of a.tickets) (fresh.tickets[key] as { preparation: string }).preparation = "investigating";
  c.saveBoard(fresh);
  const ids = a.tickets.map((key) =>
    (c.agents as NonNullable<typeof c.agents>).launch(rl, {
      ticket: key,
      kind: "analyse",
      profile: ANALYST_PROFILE,
      round: 1,
      attempt: 1,
    }),
  );
  return { execution_ids: ids };
}

/**
 * ticket.retry: a ticket held for a failed execution gets that work started again at attempt 1
 * (a developer, a reviewer or a remediation, whichever failed). A ticket held at the round cap
 * gets one more remediation round.
 */
function ticketRetry(c: Controller, cmdId: string, a: Args<"ticket.retry">): Ok {
  const rl = c.requireRun(a.run_id);
  const t = rl.state.tickets[a.ticket];
  if (!t) throw new CommandError("not_found", `${a.ticket} is not in run ${rl.id}`);
  if (!c.agents) throw new CommandError("unsupported", "this controller can't start agents");
  const failed = t.attention.filter((x) => x.kind === "execution_failed");
  const capped = t.attention.some((x) => x.kind === "round_cap");
  if (t.state !== "needs_input" || (failed.length === 0 && !capped))
    throw new CommandError(
      "invalid_state",
      `${a.ticket} is ${t.state}${t.state === "needs_input" ? " and isn't waiting on a failed execution or the round cap; answer its question instead" : ""}; only a ticket held for a failed execution or the round cap can be retried`,
    );
  if (rl.state.status !== "running")
    throw new CommandError("invalid_state", `run ${rl.id} is ${rl.state.status}; resume it first`);
  const o = { ticket: a.ticket, cause: cmdId, source: "human" as const };
  const resume = t.resume_state;
  const events = [
    ...failed.map((x) =>
      c.event(rl.id, "ticket.attention_removed", { kind: "execution_failed", id: x.id }, o),
    ),
    ...(capped ? [c.event(rl.id, "ticket.attention_removed", { kind: "round_cap" }, o)] : []),
  ];
  const left = t.attention.filter((x) => x.kind === "question");
  if (left.length === 0 && resume) events.push(c.ticketTo(rl, a.ticket, resume, "retried by a person", o));
  c.emit(rl, events);

  const ids: string[] = [];
  for (const x of failed) {
    const e = x.id ? rl.state.executions[x.id] : undefined;
    if (!e) continue;
    ids.push(
      c.agents.launch(rl, { ticket: a.ticket, kind: e.kind, profile: e.profile, round: e.round, attempt: 1 }),
    );
  }
  if (capped) {
    // One more round than the workflow allows: the remediation starts now, from the round the
    // reviewers last judged.
    const round = reviewRound(c.agents.views(rl, a.ticket));
    const id = c.agents.startRemediation(rl, a.ticket, round);
    if (id) ids.push(id);
  }
  return { execution_id: ids[0] ?? null, execution_ids: ids };
}

async function runCancel(c: Controller, cmdId: string, a: Args<"run.cancel">): Promise<Ok> {
  const rl = c.requireRun(a.run_id);
  const killed: string[] = [];
  for (const [id, e] of Object.entries(rl.state.executions)) {
    if (!isExecutionFinal(e.state)) {
      c.emit(rl, [c.execTo(rl, id, "cancelled", "run cancelled", { cause: cmdId, source: "human" })]);
      killed.push(id);
    }
  }
  for (const k of rl.state.leases) {
    const t = rl.state.tickets[k];
    if (t && !isTicketFinal(t.state))
      c.emit(rl, [c.ticketTo(rl, k, "cancelled", "run cancelled", { cause: cmdId, source: "human" })]);
  }
  c.endRun(rl, "cancelled", a.reason ?? "cancelled by a person", cmdId, "human");
  await c.killTerminals(rl, killed, "run cancelled");
  return {};
}

function runDelete(c: Controller, runId: string): Ok {
  if (c.runs.has(runId))
    throw new CommandError(
      "invalid_state",
      `run ${runId} is still ${c.runs.get(runId)?.state.status}; cancel it before deleting it`,
    );
  if (!existsSync(c.home.runFile(runId))) throw new CommandError("not_found", `run ${runId} doesn't exist`);
  const rl = RunLog.load(c.home, runId, () => {});
  const open = Object.entries(rl.state.tickets)
    .filter(([, t]) => t.pr?.state === "OPEN")
    .map(([k]) => k);
  if (open.length)
    throw new CommandError(
      "invalid_state",
      `run ${runId} still tracks open PRs (${open.join(", ")}); a run is deleted only once its PRs are merged or declined`,
    );
  rmSync(c.home.runDir(runId), { recursive: true, force: true });
  return {};
}
