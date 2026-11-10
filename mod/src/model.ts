// The Collie mod's view model: everything the Board setup and Graph screens show, worked out
// from a board.json. Pure (no Herdr calls), so it is unit-tested apart from rendering.
import {
  computeMetrics,
  criticalPath,
  describeCycle,
  edges,
  findCycles,
  type Layout,
  layout,
  type Readiness,
  type RunMetrics,
  readiness,
  satisfiesPolicy,
} from "@collie/board";
import type {
  Board,
  BoardTicket,
  ExecutionState,
  Profile,
  RunState,
  StateFile,
  TicketState,
} from "@collie/schema";
import { formatIssues, validateProfile } from "@collie/schema";

export const PREPARATIONS: BoardTicket["preparation"][] = [
  "unreviewed",
  "investigating",
  "needs_input",
  "ready",
  "excluded",
];

/** The next preparation status when the chip is clicked (set by hand in Phase 3). */
export const nextPreparation = (p: BoardTicket["preparation"]) =>
  PREPARATIONS[(PREPARATIONS.indexOf(p) + 1) % PREPARATIONS.length] as BoardTicket["preparation"];

export type TicketRow = {
  key: string;
  summary: string;
  jiraStatus: string;
  preparation: BoardTicket["preparation"];
  /** The workflow this ticket uses from the next run on; null is the board's default. */
  workflow: string | null;
  readiness: Readiness["state"];
  blockers: Readiness["blockers"];
  critical: boolean;
};

export type ExternalRow = {
  key: string;
  summary: string;
  jiraStatus: string;
  /** Done by the board's completion policy: it no longer holds anything up. */
  satisfied: boolean;
  /** The on-board tickets it blocks, and whether a person overrode that link. */
  blocks: { key: string; overridden: boolean }[];
};

/** A button: what it says, and the `collie ctl` command it runs. */
export type Action = { id: string; label: string; command: string; args: Record<string, unknown> };

/** Pull in, and Override or Restore for each ticket the outside blocker holds up. */
export function externalActions(boardId: string, x: ExternalRow, prefix = ""): Action[] {
  return [
    {
      id: `${prefix}pull-${x.key}`,
      label: "Pull in",
      command: "ticket.pull_in",
      args: { board_id: boardId, ticket: x.key },
    },
    ...x.blocks.map((b) => ({
      id: `${prefix}ovr-${x.key}-${b.key}`,
      label: `${b.overridden ? "Restore" : "Override"} → ${b.key}`,
      command: b.overridden ? "dep.restore" : "dep.override",
      args: { board_id: boardId, blocker: x.key, blocked: b.key },
    })),
  ];
}

/** Exclude a ticket from runs, or include it again. */
export function excludeAction(boardId: string, key: string, preparation: BoardTicket["preparation"]): Action {
  const excluded = preparation === "excluded";
  return {
    id: `exclude-${key}`,
    label: excluded ? "Include again" : "Exclude from runs",
    command: "ticket.set_preparation",
    args: { board_id: boardId, ticket: key, preparation: excluded ? "unreviewed" : "excluded" },
  };
}

export type BoardModel = {
  rows: TicketRow[];
  externals: ExternalRow[];
  cycles: string[][];
  /** Why Start run can't be used, or null when it can (from Phase 4). */
  startBlocked: string | null;
  counts: Record<Readiness["state"], number>;
  layout: Layout;
  critical: string[];
};

export function boardModel(board: Board): BoardModel {
  const r = readiness(board);
  const crit = criticalPath(board);
  const cycles = findCycles(board);
  const rows: TicketRow[] = Object.entries(board.tickets)
    .filter(([, t]) => t.on_board)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, t]) => ({
      key,
      summary: t.summary,
      jiraStatus: t.jira_status,
      preparation: t.preparation,
      workflow: t.workflow,
      readiness: r[key]?.state ?? "pending",
      blockers: r[key]?.blockers ?? [],
      critical: crit.includes(key),
    }));
  const all = edges(board);
  const externals: ExternalRow[] = Object.entries(board.tickets)
    .filter(([key, t]) => !t.on_board && all.some((e) => e.from === key))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, t]) => ({
      key,
      summary: t.summary,
      jiraStatus: t.jira_status,
      satisfied: satisfiesPolicy(t, board.settings.completion_policy),
      blocks: all.filter((e) => e.from === key).map((e) => ({ key: e.to, overridden: e.overridden })),
    }));
  const counts = { excluded: 0, pending: 0, blocked: 0, ready: 0 };
  for (const row of rows) counts[row.readiness] += 1;
  return {
    rows,
    externals,
    cycles,
    startBlocked: cycles.length
      ? `Dependency cycle: ${cycles.map(describeCycle).join("; ")}. Override one link, or fix it in Jira and refresh.`
      : rows.length === 0
        ? "Import tickets first."
        : null,
    counts,
    layout: layout(board),
    critical: crit,
  };
}

const KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

/** What the import box holds: a list of issue keys, or else a JQL query. */
export function parseImport(text: string): { keys: string[] } | { jql: string } | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(/[\s,]+/).filter(Boolean);
  if (parts.every((p) => KEY.test(p.toUpperCase())))
    return { keys: [...new Set(parts.map((p) => p.toUpperCase()))] };
  return { jql: t };
}

/** A short, human line for a `collie ctl` reply (the mod shows it under the header). */
export function describeReply(
  command: string,
  reply: { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } },
): string {
  if (!reply.ok) return reply.error ? `${command}: ${reply.error.message}` : `${command} failed`;
  const r = reply.result ?? {};
  const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as string[]) : []);
  switch (command) {
    case "board.import":
      return `Imported ${list("added").length} ticket(s)${list("external").length ? `, and found ${list("external").length} outside blocker(s)` : ""}.`;
    case "board.refresh": {
      const changed = list("changed");
      const moved = list("readiness_changed");
      const missing = list("missing");
      return [
        changed.length
          ? `Refreshed: ${changed.join(", ")} changed in Jira.`
          : "Refreshed: nothing changed in Jira.",
        moved.length ? `Readiness changed for ${moved.join(", ")}.` : "",
        missing.length ? `Not found in Jira: ${missing.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "ticket.pull_in":
      return `Pulled ${list("added").join(", ")} onto the board.`;
    case "board.create":
      return "Board created.";
    default:
      return "Done.";
  }
}

// --- runs (Phase 4): what the Delivery graph and the inspector show of a run in progress

/** A run as the mod reads it: run.json's header and state.json. */
export type RunView = {
  id: string;
  number: number;
  status: RunState;
  boardId: string;
  state: StateFile;
  /** Profile id -> display name, from the run's snapshot (falls back to a prettified id). */
  profiles?: Record<string, string>;
};

/** How a ticket's run state is drawn: a theme color name. */
export type Tone = "working" | "blocked" | "done" | "idle" | "muted" | "dim";

const TICKET_LABEL: Record<TicketState, [string, Tone]> = {
  pending: ["Not prepared", "dim"],
  blocked: ["Blocked", "muted"],
  ready: ["Queued", "idle"],
  in_progress: ["Developing", "working"],
  reviewing: ["Reviewing", "working"],
  remediating: ["Remediating", "working"],
  delivering: ["Delivering", "working"],
  needs_input: ["Needs you", "blocked"],
  completed: ["Done", "done"],
  cancelled: ["Cancelled", "dim"],
};

export const ticketLabel = (s: TicketState) => TICKET_LABEL[s][0];
export const ticketTone = (s: TicketState): Tone => TICKET_LABEL[s][1];

const EXEC_LIVE: ExecutionState[] = ["created", "starting", "working", "needs_input"];

export type ExecView = {
  id: string;
  attempt: number;
  kind: string;
  round: number;
  /** The profile's display name, e.g. "Security reviewer". */
  profile: string;
  /** Who and what, e.g. "Security reviewer, review round 1". */
  title: string;
  state: ExecutionState;
  live: boolean;
  terminal: string | null;
  nudges: number;
  /** "waiting for permission", set while hc reports the agent blocked. */
  blocked: string | null;
  /** Its summary when done, or why it failed. */
  outcome: string | null;
};

export type TicketRunView = {
  key: string;
  state: TicketState;
  label: string;
  tone: Tone;
  branch: string | null;
  executions: ExecView[];
  /** Why the ticket waits for a person, in words. */
  attention: string[];
  /** The kinds of its attention entries (question, round_cap, execution_failed, delivery_error). */
  attentionKinds: string[];
  openFindings: FindingRow[];
  openQuestions: QuestionRow[];
  /** The ticket's pull request, when it has one (Phase 6). */
  pr: PrRow | null;
  /** The Jira write-backs already made: "start", "pr". */
  jiraSteps: string[];
};

export type RunModel = {
  id: string;
  number: number;
  status: RunState;
  active: boolean;
  tickets: Record<string, TicketRunView>;
  /** "2 of 5 done" */
  progress: string;
  /** Run-level buttons: Pause or Resume, and Cancel. */
  actions: Action[];
};

/** "security-reviewer" -> "Security reviewer", for a profile the run has no name for. */
const prettySlug = (slug: string) => {
  const words = slug.replaceAll(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The kind of work in words: "review round 2". */
export function kindWords(kind: string, round: number): string {
  switch (kind) {
    case "develop":
      return "development";
    case "review":
      return `review round ${round}`;
    case "remediate":
      return `remediation round ${round}`;
    case "analyse":
      return "analysis";
    default:
      return kind;
  }
}

function execView(
  id: string,
  e: StateFile["executions"][string],
  names: Record<string, string> = {},
): ExecView {
  const profile = names[e.profile] ?? prettySlug(e.profile);
  const r = e.result as { summary?: string; reason?: string } | null;
  const blocked = e.agent_blocked
    ? `waiting for ${e.agent_blocked.kind === "question" ? "an answer in its terminal" : "permission"}${e.agent_blocked.message ? `: ${e.agent_blocked.message}` : ""}`
    : null;
  return {
    id,
    attempt: e.attempt,
    kind: e.kind,
    round: e.round,
    profile,
    title: `${profile}, ${kindWords(e.kind, e.round)}`,
    state: e.state,
    live: EXEC_LIVE.includes(e.state),
    terminal: e.terminal,
    nudges: e.nudges,
    blocked,
    outcome: r?.summary ?? r?.reason ?? null,
  };
}

const ATTENTION_TEXT: Record<string, string> = {
  question: "an agent asked a question",
  round_cap: "reviews found issues again at the last allowed round",
  execution_failed: "its agent failed with no attempts left",
  delivery_error: "delivery failed: pushing the branch or opening the pull request",
};

export function runModel(run: RunView | null, summaries: Summaries = {}): RunModel | null {
  if (!run) return null;
  const st = run.state;
  const tickets: Record<string, TicketRunView> = {};
  for (const [key, t] of Object.entries(st.tickets)) {
    tickets[key] = {
      key,
      state: t.state,
      label: ticketLabel(t.state),
      tone: ticketTone(t.state),
      branch: t.branch,
      executions: t.executions.flatMap((id) =>
        st.executions[id] ? [execView(id, st.executions[id], run.profiles)] : [],
      ),
      attention: t.attention.map((a) => ATTENTION_TEXT[a.kind] ?? a.kind),
      attentionKinds: t.attention.map((a) => a.kind),
      openFindings: findingRows(st, summaries).filter((f) => f.ticket === key && !f.addressed),
      openQuestions: questionRows(st, "run", summaries, run.profiles).filter(
        (q) => q.ticket === key && q.state === "open",
      ),
      pr: prRow(run.id, key, t, summaries),
      jiraSteps: t.jira_steps ?? [],
    };
  }
  const all = Object.values(tickets);
  const done = all.filter((t) => t.state === "completed").length;
  const active = run.status === "running" || run.status === "paused";
  const actions: Action[] = [];
  if (run.status === "running")
    actions.push({ id: "run-pause", label: "Pause run", command: "run.pause", args: { run_id: run.id } });
  if (run.status === "paused")
    actions.push({ id: "run-resume", label: "Resume run", command: "run.resume", args: { run_id: run.id } });
  if (active)
    actions.push({ id: "run-cancel", label: "Cancel run", command: "run.cancel", args: { run_id: run.id } });
  return {
    id: run.id,
    number: run.number,
    status: run.status,
    active,
    tickets,
    progress: `${done} of ${all.length} done`,
    actions,
  };
}

/** Start run, or why it can't start. The board's own problems come first (a cycle, nothing imported). */
export function startAction(
  boardId: string,
  m: Pick<BoardModel, "startBlocked">,
  run: RunModel | null,
): { action: Action; disabled: string | null } {
  const action: Action = {
    id: "start-run",
    label: "Start run",
    command: "run.start",
    args: { board_id: boardId },
  };
  if (run?.active) return { action, disabled: `Run ${run.number} is ${run.status}.` };
  return { action, disabled: m.startBlocked };
}

/** Cancels and deletes are destructive: the UI asks twice before sending one. */
export const needsConfirm = (command: string) =>
  ["ticket.cancel", "exec.cancel", "run.cancel", "run.delete"].includes(command);

/** The controller's `requireRun`: only a running or paused run takes ticket and run commands. */
export const runIsActive = (status: RunState) => status === "running" || status === "paused";

/**
 * What a person can do to one ticket of a run, following the controller's rules
 * (packages/controller/src/commands.ts):
 * - `ticket.cancel`: the run is running or paused and the ticket isn't completed or cancelled.
 * - `exec.cancel`: the execution isn't completed, failed or cancelled.
 * - `ticket.retry`: the run is *running* (a paused run says "resume it first") and the ticket is held
 *   for a failed execution or the round cap, or carries a delivery error.
 */
export function ticketRunActions(runId: string, t: TicketRunView, runStatus: RunState = "running"): Action[] {
  const out: Action[] = [];
  const retry = (label: string): Action => ({
    id: `retry-${t.key}`,
    label,
    command: "ticket.retry",
    args: { run_id: runId, ticket: t.key },
  });
  const active = runIsActive(runStatus);
  if (runStatus === "running") {
    if (t.state === "needs_input" && t.attentionKinds.includes("execution_failed"))
      out.push(retry("Retry with a new agent"));
    else if (t.state === "needs_input" && t.attentionKinds.includes("round_cap"))
      out.push(retry("Retry (one more round)"));
    // A completed ticket can carry delivery_error too (delivery goes on behind it), so no state check.
    if (t.attentionKinds.includes("delivery_error") && t.state !== "cancelled")
      out.push(retry("Retry delivery"));
  }
  for (const e of t.executions.filter((x) => x.live))
    out.push({
      id: `cancel-exec-${e.id}`,
      label: `Stop agent (attempt ${e.attempt})`,
      command: "exec.cancel",
      args: { run_id: runId, execution_id: e.id },
    });
  if (active && t.state !== "completed" && t.state !== "cancelled")
    out.push({
      id: `cancel-${t.key}`,
      label: "Cancel ticket",
      command: "ticket.cancel",
      args: { run_id: runId, ticket: t.key },
    });
  return out;
}

/** The Herdr command that shows an agent's live terminal over the current tab. */
export const watchCommand = (terminal: string) => ({ name: "terminal.peek", args: { terminal } });

/** One short line for an execution in a list. */
export function execLine(e: ExecView): string {
  const bits = [e.title, `attempt ${e.attempt}`, e.state.replaceAll("_", " ")];
  if (e.terminal) bits.push(e.terminal);
  if (e.nudges) bits.push(`nudged ${e.nudges}×`);
  if (e.blocked) bits.push(e.blocked);
  return bits.join(" · ");
}

// --- questions, findings and the Needs you banner (Phase 5)

/** Ticket key -> its Jira summary, for rows that name a ticket (state.json holds only keys). */
export type Summaries = Record<string, string>;
export const summariesOf = (board: Board | null): Summaries =>
  Object.fromEntries(Object.entries(board?.tickets ?? {}).map(([k, t]) => [k, t.summary]));

export type QuestionRow = {
  id: string;
  /** "run": answered with the run's id. "prep": the analyst's, answered with the BOARD's id. */
  scope: "run" | "prep";
  ticket: string;
  summary: string;
  question: string;
  options: string[];
  state: "open" | "answered" | "delivered" | "withdrawn";
  answer: string | null;
  share: boolean;
  /** Which agent asked: "Security reviewer, review round 1". */
  asker: string;
};

/** Every question in a state file, open ones first, then by ticket and id. */
export function questionRows(
  st: Pick<StateFile, "questions" | "executions">,
  scope: "run" | "prep",
  summaries: Summaries = {},
  names: Record<string, string> = {},
): QuestionRow[] {
  const rows = Object.entries(st.questions).map(([id, q]) => {
    const e = st.executions[q.execution_id];
    const profile = e ? (names[e.profile] ?? prettySlug(e.profile)) : "An agent";
    return {
      id,
      scope,
      ticket: q.ticket,
      summary: summaries[q.ticket] ?? "",
      question: q.question,
      options: q.options,
      state: q.state,
      answer: q.answer,
      share: q.share_with_ticket,
      asker: e ? `${profile}, ${kindWords(e.kind, e.round)}` : profile,
    };
  });
  const open = (r: QuestionRow) => (r.state === "open" ? 0 : 1);
  return rows.sort(
    (a, b) =>
      open(a) - open(b) ||
      a.ticket.localeCompare(b.ticket, undefined, { numeric: true }) ||
      a.id.localeCompare(b.id),
  );
}

export type FindingRow = {
  id: string;
  ticket: string;
  summary: string;
  severity: string;
  blocking: boolean;
  title: string;
  /** "src/a.ts:42" */
  where: string | null;
  round: number;
  addressed: boolean;
  addressedInRound: number | null;
};

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];

/** Findings, blocking and unaddressed first, then by severity, ticket and round. */
export function findingRows(
  st: Pick<StateFile, "findings">,
  summaries: Summaries = {},
  ticket: string | null = null,
): FindingRow[] {
  const rows = st.findings
    .filter((f) => !ticket || f.ticket === ticket)
    .map((f) => ({
      id: f.id,
      ticket: f.ticket,
      summary: summaries[f.ticket] ?? "",
      severity: f.severity,
      blocking: f.blocking,
      title: f.title,
      where: f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : null,
      round: f.round,
      addressed: f.addressed_in_round !== null,
      addressedInRound: f.addressed_in_round,
    }));
  const rank = (r: FindingRow) => (r.addressed ? 2 : r.blocking ? 0 : 1);
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.ticket.localeCompare(b.ticket, undefined, { numeric: true }) ||
      a.round - b.round ||
      a.id.localeCompare(b.id),
  );
}

/** The tickets that have findings, with how many are still open, for the Findings tab's filter. */
export function findingTickets(st: Pick<StateFile, "findings">): { key: string; open: number }[] {
  const by = new Map<string, number>();
  for (const f of st.findings)
    by.set(f.ticket, (by.get(f.ticket) ?? 0) + (f.addressed_in_round === null ? 1 : 0));
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, open]) => ({ key, open }));
}

/** One button on a banner item. */
export type NeedAction =
  | { id: string; label: string; type: "answer"; scope: "run"; questionId: string }
  | { id: string; label: string; type: "ctl"; command: string; args: Record<string, unknown> }
  | { id: string; label: string; type: "watch"; terminal: string };

export type NeedItem = {
  /** Stable across reloads, so a banner item that was already there isn't announced again. */
  key: string;
  kind: "question" | "round_cap" | "execution_failed" | "delivery_error" | "agent_blocked";
  ticket: string;
  summary: string;
  /** One line: why this waits for a person. */
  reason: string;
  actions: NeedAction[];
};

/**
 * Everything in a run that waits for a person: open questions, held tickets (round cap, failed
 * agent, delivery error) and agents hc reports blocked on a dialog. Empty means the banner hides.
 */
export function needsYou(run: RunView, summaries: Summaries = {}): NeedItem[] {
  const st = run.state;
  const out: NeedItem[] = [];
  const summary = (t: string) => summaries[t] ?? "";
  for (const q of questionRows(st, "run", summaries, run.profiles).filter((x) => x.state === "open"))
    out.push({
      key: `question:${q.id}`,
      kind: "question",
      ticket: q.ticket,
      summary: q.summary,
      reason: `${q.asker} asks: ${q.question}`,
      actions: [{ id: `answer-${q.id}`, label: "Answer", type: "answer", scope: "run", questionId: q.id }],
    });
  for (const [ticket, t] of Object.entries(st.tickets)) {
    if (t.state === "cancelled") continue;
    for (const a of t.attention) {
      // A completed ticket is only listed for a delivery that failed behind it.
      if (t.state === "completed" && a.kind !== "delivery_error") continue;
      const retry = (label: string): NeedAction => ({
        id: `retry-${ticket}-${a.kind}`,
        label,
        type: "ctl",
        command: "ticket.retry",
        args: { run_id: run.id, ticket },
      });
      const cancel: NeedAction[] =
        runIsActive(run.status) && t.state !== "completed"
          ? [
              {
                id: `cancel-${ticket}-${a.kind}`,
                label: "Cancel ticket",
                type: "ctl",
                command: "ticket.cancel",
                args: { run_id: run.id, ticket },
              },
            ]
          : [];
      // The controller refuses a retry unless the run is running ("resume it first").
      const retries = (label: string): NeedAction[] => (run.status === "running" ? [retry(label)] : []);
      const failed = a.id ? st.executions[a.id] : undefined;
      const watch: NeedAction[] = failed?.terminal
        ? [
            {
              id: `watch-${ticket}-${a.id}`,
              label: "Watch terminal",
              type: "watch",
              terminal: failed.terminal,
            },
          ]
        : [];
      if (a.kind === "round_cap")
        out.push({
          key: `attention:${ticket}:round_cap`,
          kind: "round_cap",
          ticket,
          summary: summary(ticket),
          reason: `Reviews still found blocking issues after round ${t.round}, the last allowed.`,
          actions: [...retries("Retry (one more round)"), ...cancel],
        });
      else if (a.kind === "execution_failed") {
        const r = failed?.result as { reason?: string } | null | undefined;
        out.push({
          key: `attention:${ticket}:execution_failed:${a.id ?? ""}`,
          kind: "execution_failed",
          ticket,
          summary: summary(ticket),
          reason: `${failed ? failed.profile : "An agent"} failed with no attempts left${r?.reason ? `: ${r.reason}` : ""}.`,
          actions: [...retries("Retry"), ...watch, ...cancel],
        });
      } else if (a.kind === "delivery_error")
        out.push({
          key: `attention:${ticket}:delivery_error`,
          kind: "delivery_error",
          ticket,
          summary: summary(ticket),
          reason: "Delivery failed: pushing the branch or opening the pull request.",
          actions: [...retries("Retry delivery"), ...cancel],
        });
    }
  }
  for (const [id, e] of Object.entries(st.executions)) {
    if (!e.agent_blocked || !EXEC_LIVE.includes(e.state)) continue;
    const view = execView(id, e, run.profiles);
    out.push({
      key: `blocked:${id}:${e.agent_blocked.kind}`,
      kind: "agent_blocked",
      ticket: e.ticket,
      summary: summary(e.ticket),
      reason: `${view.title} is ${view.blocked}`,
      actions: e.terminal
        ? [{ id: `watch-${id}`, label: "Watch terminal", type: "watch", terminal: e.terminal }]
        : [],
    });
  }
  return out;
}

// --- notifications

export type Alert = {
  /** Never announced twice: the same key in both views means it was already there. */
  key: string;
  title: string;
  body: string;
  level: "info" | "success" | "warning" | "error";
};

const ENDED: RunState[] = ["completed", "cancelled"];

/**
 * What to announce when a run's view changes from `prev` to `next`: a new item that needs a
 * person, and the run ending. The first load (prev null) and a different run say nothing, so
 * opening or reloading the mod never repeats what was already there.
 */
export function alerts(prev: RunView | null, next: RunView, summaries: Summaries = {}): Alert[] {
  if (!prev || prev.id !== next.id) return [];
  const before = new Set(needsYou(prev, summaries).map((n) => n.key));
  const out: Alert[] = needsYou(next, summaries)
    .filter((n) => !before.has(n.key))
    .map((n) => ({
      key: n.key,
      title: `${n.ticket} needs you`,
      body: n.summary ? `${n.summary}: ${n.reason}` : n.reason,
      level: "warning" as const,
    }));
  for (const [ticket, t] of Object.entries(next.state.tickets)) {
    const was = prev.state.tickets[ticket]?.pr ?? null;
    const pr = t.pr;
    if (!pr) continue;
    const body = summaries[ticket] ?? pr.url;
    if (!was)
      out.push({
        key: `pr:${ticket}:${pr.id}:opened`,
        title: `${ticket}: PR #${pr.id} opened`,
        body,
        level: "info",
      });
    if (pr.state === "MERGED" && was?.state !== "MERGED")
      out.push({
        key: `pr:${ticket}:${pr.id}:merged`,
        title: `${ticket}: PR #${pr.id} merged`,
        body,
        level: "success",
      });
    if (pr.needs_rebase && !was?.needs_rebase)
      out.push({
        key: `pr:${ticket}:${pr.id}:needs_rebase`,
        title: `${ticket}: PR #${pr.id} needs a rebase`,
        body: `${body}: its parent merged; rebase ${pr.source} onto ${pr.destination}.`,
        level: "warning",
      });
  }
  if (!ENDED.includes(prev.status) && ENDED.includes(next.status)) {
    const tickets = Object.values(next.state.tickets);
    const done = tickets.filter((t) => t.state === "completed").length;
    out.push({
      key: `run:${next.id}:${next.status}`,
      title:
        next.status === "completed" ? `Run ${next.number} is complete` : `Run ${next.number} was cancelled`,
      body: `${done} of ${tickets.length} tickets done.`,
      level: next.status === "completed" ? "success" : "info",
    });
  }
  return out;
}

// --- answering

/** The `question.answer` command for what the dialog holds, or why it can't be sent yet. */
export function answerAction(
  scopeId: string,
  questionId: string,
  text: string,
  share: boolean,
): { action: Action } | { error: string } {
  const answer = text.trim();
  if (!answer) return { error: "Type an answer, or pick one of the options." };
  return {
    action: {
      id: "send-answer",
      label: "Send",
      command: "question.answer",
      args: { run_id: scopeId, question_id: questionId, answer, share_with_ticket: share },
    },
  };
}

// --- Board setup: the analyst and workflows (Phase 5)

/** A ticket's workflow when the chip is clicked: null (the board's default), then each in turn. */
export function nextWorkflow(current: string | null, ids: string[]): string | null {
  if (ids.length === 0) return null;
  if (current === null) return ids[0] ?? null;
  const i = ids.indexOf(current);
  return i < 0 || i === ids.length - 1 ? null : (ids[i + 1] ?? null);
}

/** The tickets "Investigate" applies to when nothing is selected: not yet looked at. */
export const investigateTargets = (rows: Pick<TicketRow, "key" | "preparation">[]): string[] =>
  rows.filter((r) => r.preparation === "unreviewed").map((r) => r.key);

export const investigateAction = (boardId: string, tickets: string[]): Action => ({
  id: `investigate-${tickets.join("-")}`,
  label: tickets.length === 1 ? "Investigate" : `Investigate ${tickets.length} unreviewed`,
  command: "ticket.investigate",
  args: { board_id: boardId, tickets },
});

export type PrepTicket = {
  key: string;
  summary: string;
  preparation: BoardTicket["preparation"];
  /** Open questions, answered with the board's id. */
  questions: QuestionRow[];
  /** The analyst's notes (its findings): suggestions such as a split or a missing blocker. */
  notes: FindingRow[];
};

/** The analyst's questions and notes per ticket, for the Board setup "Preparation" section. */
export function prepModel(board: Board, prep: StateFile | null): PrepTicket[] {
  if (!prep) return [];
  const summaries = summariesOf(board);
  const qs = questionRows(prep, "prep", summaries).filter((q) => q.state === "open");
  const notes = findingRows(prep, summaries);
  const keys = new Set([...qs.map((q) => q.ticket), ...notes.map((n) => n.ticket)]);
  return [...keys]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((key) => ({
      key,
      summary: board.tickets[key]?.summary ?? "",
      preparation: board.tickets[key]?.preparation ?? "unreviewed",
      questions: qs.filter((q) => q.ticket === key),
      notes: notes.filter((n) => n.ticket === key),
    }));
}

/** The short marker under a graph node: the newest agent, or how many are going at once. */
export function execChipLabel(t: Pick<TicketRunView, "executions">): { text: string; exec: ExecView | null } {
  const live = t.executions.filter((e) => e.live);
  if (live.length > 1) return { text: `${live.length} agents`, exec: live[0] ?? null };
  const e = live[0] ?? t.executions.at(-1);
  if (!e) return { text: "", exec: null };
  const word = { develop: "dev", review: "rev", remediate: "fix", analyse: "ana" }[e.kind] ?? e.kind;
  const bits = [word, e.kind === "review" || e.kind === "remediate" ? `r${e.round}` : String(e.attempt)];
  return { text: `${bits.join(" ")}${e.blocked ? " ⏸" : ""}`, exec: e };
}

// --- pull requests (Phase 6)

type TicketPr = NonNullable<StateFile["tickets"][string]["pr"]>;

export type PrRow = {
  ticket: string;
  summary: string;
  id: number;
  url: string;
  state: TicketPr["state"];
  draft: boolean;
  source: string;
  destination: string;
  /** "source → destination" */
  branches: string;
  approvals: number;
  conflicted: boolean;
  needsRebase: boolean;
  /** Set only on a draft PR that is still open. */
  markReady: Action | null;
};

/** Mark ready: only for a draft PR that is still open. */
export const markReadyAction = (runId: string, ticket: string): Action => ({
  id: `ready-${ticket}`,
  label: "Mark ready",
  command: "pr.mark_ready",
  args: { run_id: runId, ticket },
});

export function prRow(
  runId: string,
  ticket: string,
  t: Pick<StateFile["tickets"][string], "pr">,
  summaries: Summaries = {},
): PrRow | null {
  const pr = t.pr;
  if (!pr) return null;
  return {
    ticket,
    summary: summaries[ticket] ?? "",
    id: pr.id,
    url: pr.url,
    state: pr.state,
    draft: pr.draft,
    source: pr.source,
    destination: pr.destination,
    branches: `${pr.source} → ${pr.destination}`,
    approvals: pr.approvals,
    conflicted: pr.conflicted,
    needsRebase: pr.needs_rebase === true,
    markReady: pr.draft && pr.state === "OPEN" ? markReadyAction(runId, ticket) : null,
  };
}

/** One row per ticket that has a pull request, by ticket key. Works for an ended run too. */
export function prRows(run: RunView | null, summaries: Summaries = {}): PrRow[] {
  if (!run) return [];
  return Object.entries(run.state.tickets)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .flatMap(([key, t]) => {
      const r = prRow(run.id, key, t, summaries);
      return r ? [r] : [];
    });
}

/** The badges on a PR row, in order: Draft, Conflicted, Needs rebase. */
export const prBadges = (r: PrRow): { label: string; tone: Tone }[] => [
  ...(r.draft ? [{ label: "Draft", tone: "muted" as Tone }] : []),
  ...(r.conflicted ? [{ label: "Conflicted", tone: "blocked" as Tone }] : []),
  ...(r.needsRebase ? [{ label: "Needs rebase", tone: "blocked" as Tone }] : []),
];

export const prStateTone = (s: PrRow["state"]): Tone =>
  s === "OPEN" ? "working" : s === "MERGED" ? "done" : "dim";

/** "start, pr" as words for the inspector: which Jira write-backs are done. */
export function jiraStepsText(steps: string[]): string {
  const label = { start: "moved on start", pr: "moved on PR" } as Record<string, string>;
  const done = (k: string) => steps.includes(k);
  return (["start", "pr"] as const).map((k) => `${label[k]}: ${done(k) ? "done" : "not yet"}`).join(" · ");
}

// --- Board setup: run settings (Phase 6)

export const COMPLETE_AT_OPTIONS = ["implemented", "pr_created", "pr_approved", "merged"] as const;
export const PR_DRAFT_OPTIONS = ["draft_when_stacked", "always_draft"] as const;

export const COMPLETE_AT_LABEL: Record<string, string> = {
  implemented: "Implemented",
  pr_created: "PR created",
  pr_approved: "PR approved",
  merged: "Merged",
};
export const PR_DRAFT_LABEL: Record<string, string> = {
  draft_when_stacked: "Draft when stacked",
  always_draft: "Always draft",
};

/** Change one run setting. The controller merges the partial settings into the board's. */
export const settingAction = (
  boardId: string,
  settings:
    | { complete_at: (typeof COMPLETE_AT_OPTIONS)[number] }
    | { pr_draft_policy: (typeof PR_DRAFT_OPTIONS)[number] },
): Action => ({
  id: `setting-${Object.values(settings)[0]}`,
  label: "Change setting",
  command: "board.update_settings",
  args: { board_id: boardId, settings },
});

// --- Activity: run history, metrics and the event log (Phase 7)

/** A run as the Activity view lists it: run.json's header, state.json, and what retention left. */
export type RunRecord = {
  id: string;
  number: number;
  boardId: string;
  status: RunState;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  carriedOverFrom: string | null;
  state: StateFile | null;
  /** Whether inbox.jsonl still exists in the run's directory. */
  hasInbox: boolean;
};

export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

/**
 * Whether a run's inbox and attachments were pruned (protocol, "Retention": removed 90 days after
 * the run ends). DECISION: "pruned" is read from the files, not assumed from the date alone: an
 * old run that still has inbox.jsonl (the controller hasn't run its prune pass yet) shows normally.
 */
export function isPruned(r: Pick<RunRecord, "endedAt" | "hasInbox">, nowMs: number): boolean {
  if (!r.endedAt || r.hasInbox) return false;
  const ended = Date.parse(r.endedAt);
  return Number.isFinite(ended) && nowMs - ended > RETENTION_DAYS * DAY_MS;
}

/** "2026-11-08T10:01:00Z" -> "2026-11-08 10:01" (UTC). */
export const shortTime = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "");

/** "45 s", "12 min", "1 h 5 min". */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export type RunHistoryRow = {
  id: string;
  number: number;
  status: RunState;
  tone: Tone;
  title: string;
  /** "2026-11-08 10:01 → 2026-11-08 11:30", or "started 2026-11-08 10:01" while it runs. */
  when: string;
  /** "3 of 5 done", with ", 1 cancelled" when some were. */
  tickets: string;
  prs: number;
  openPrs: number;
  endReason: string | null;
  /** The number of the run it carried completed tickets over from, when that run is known. */
  carriedFrom: number | null;
  active: boolean;
  /** Its inbox and attachments were removed after 90 days. */
  pruned: boolean;
};

/** Newest run first. */
export function runHistory(records: RunRecord[], nowMs: number): RunHistoryRow[] {
  const numberOf = new Map(records.map((r) => [r.id, r.number]));
  return [...records]
    .sort((a, b) => b.number - a.number)
    .map((r) => {
      const ts = Object.values(r.state?.tickets ?? {});
      const done = ts.filter((t) => t.state === "completed").length;
      const cancelled = ts.filter((t) => t.state === "cancelled").length;
      const prs = ts.filter((t) => t.pr).length;
      return {
        id: r.id,
        number: r.number,
        status: r.status,
        tone: r.status === "completed" ? "done" : r.status === "cancelled" ? "dim" : "working",
        title: `Run ${r.number}`,
        when: r.endedAt
          ? `${shortTime(r.startedAt)} → ${shortTime(r.endedAt)}`
          : `started ${shortTime(r.startedAt)}`,
        tickets: `${done} of ${ts.length} done${cancelled ? `, ${cancelled} cancelled` : ""}`,
        prs,
        openPrs: ts.filter((t) => t.pr?.state === "OPEN").length,
        endReason: r.endReason,
        carriedFrom: r.carriedOverFrom ? (numberOf.get(r.carriedOverFrom) ?? null) : null,
        active: runIsActive(r.status),
        pruned: isPruned(r, nowMs),
      };
    });
}

/** The run Activity opens on: the one going, else the newest. */
export const defaultActivityRun = (rows: RunHistoryRow[]): string | null =>
  (rows.find((r) => r.active) ?? rows[0])?.id ?? null;

/** New run from a previous run: the board's next run starts with that run's completed tickets done. */
export const newRunFromAction = (boardId: string, runId: string): Action => ({
  id: `new-run-from-${runId}`,
  label: "New run from this run",
  command: "run.start",
  args: { board_id: boardId, carry_over_from: runId },
});

/**
 * New run from an ended run, or why not. The controller needs the previous run to have ended and
 * the board to have no active run; the board's own blockers (a cycle, no tickets) also apply.
 */
export function newRunFrom(
  boardId: string,
  row: Pick<RunHistoryRow, "id" | "active" | "number">,
  startBlocked: string | null,
  activeRun: { number: number; status: RunState } | null,
): { action: Action; disabled: string | null } | null {
  if (row.active) return null;
  const action = newRunFromAction(boardId, row.id);
  const disabled = activeRun ? `Run ${activeRun.number} is ${activeRun.status}.` : startBlocked;
  return { action, disabled };
}

export const deleteRunAction = (runId: string): Action => ({
  id: `delete-run-${runId}`,
  label: "Delete run",
  command: "run.delete",
  args: { run_id: runId },
});

/**
 * Delete run, or why not. DECISION: only a running or paused run is blocked here. An ended run
 * with open PRs is sent anyway and the controller's refusal is shown, since the controller owns
 * that rule ("still tracked as open") and the mod's view of it could be stale.
 */
export function deleteRun(row: Pick<RunHistoryRow, "id" | "active" | "status">): {
  action: Action;
  disabled: string | null;
} {
  return {
    action: deleteRunAction(row.id),
    disabled: row.active ? `The run is ${row.status}; cancel it before deleting it.` : null,
  };
}

/** The numbers under a run's header: tickets completed without intervention, and so on. */
export function metricsLines(m: RunMetrics): { label: string; value: string }[] {
  return [
    {
      label: "Completed without intervention",
      value: `${m.completedWithoutIntervention} of ${m.total}`,
    },
    { label: "Interventions per ticket", value: (Math.round(m.interventionsPerTicket * 10) / 10).toString() },
    {
      label: "Median time to PR",
      value: m.medianTimeToPrMs === null ? "no PR yet" : formatDuration(m.medianTimeToPrMs),
    },
    {
      label: "Remediation success",
      value:
        m.remediation.tickets === 0
          ? "none needed"
          : `${m.remediation.succeeded} of ${m.remediation.tickets}`,
    },
  ];
}

/** One line of events.jsonl. Only the fields the Activity view reads are typed. */
export type LogEvent = {
  id: string;
  type: string;
  ts: string;
  source: string;
  run_id: string | null;
  execution_id: string | null;
  ticket: string | null;
  caused_by: string | null;
  payload: Record<string, unknown>;
};

/** The metrics for a run's events (`computeMetrics` from @collie/board). */
export const runMetrics = (events: LogEvent[]): RunMetrics => computeMetrics(events);

/**
 * Parses events.jsonl. A blank line, a line that isn't JSON (a torn final line mid-append) and a
 * line without a type are skipped rather than failing the whole view.
 */
export function parseEvents(text: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Partial<LogEvent>;
      if (e && typeof e.type === "string" && typeof e.ts === "string")
        out.push({
          id: String(e.id ?? ""),
          type: e.type,
          ts: e.ts,
          source: String(e.source ?? ""),
          run_id: e.run_id ?? null,
          execution_id: e.execution_id ?? null,
          ticket: e.ticket ?? null,
          caused_by: e.caused_by ?? null,
          payload: e.payload && typeof e.payload === "object" ? e.payload : {},
        });
    } catch {}
  }
  return out;
}

export const EVENT_KINDS = ["state", "question", "finding", "pr", "error"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  state: "State changes",
  question: "Questions",
  finding: "Findings",
  pr: "PRs",
  error: "Errors",
};

/** Which filter kinds an event belongs to (an event can belong to more than one). */
export function eventKinds(e: Pick<LogEvent, "type">): EventKind[] {
  const t = e.type;
  const out: EventKind[] = [];
  if (
    t.startsWith("run.") ||
    t === "ticket.state_changed" ||
    t === "execution.state_changed" ||
    t === "execution.created" ||
    t === "execution.started" ||
    t === "execution.completed" ||
    t === "execution.killed" ||
    t === "ticket.leased" ||
    t === "ticket.released"
  )
    out.push("state");
  if (t === "ask" || t.startsWith("question.")) out.push("question");
  if (t === "finding") out.push("finding");
  if (t.startsWith("pr.") || t.startsWith("jira.") || t.startsWith("delivery.")) out.push("pr");
  if (
    t === "execution.failed" ||
    t === "fail" ||
    t === "agent.event_rejected" ||
    t === "command.rejected" ||
    t === "delivery.failed"
  )
    out.push("error");
  return out;
}

/** "PAY-1 → needs_input" style text for one event. */
export function describeEvent(e: LogEvent): string {
  const p = e.payload;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const change = () => `${s("from") || "none"} → ${s("to")}${s("reason") ? `: ${s("reason")}` : ""}`;
  switch (e.type) {
    case "ticket.state_changed":
    case "execution.state_changed":
      return change();
    case "run.started":
      return `run ${String(p.number ?? "")} started`;
    case "run.paused":
    case "run.resumed":
    case "run.completed":
    case "run.cancelled":
      return `${e.type.slice(4)}${s("reason") ? `: ${s("reason")}` : ""}`;
    case "status":
      return s("message");
    case "finding":
      return `${s("severity")}${p.blocking ? " blocking" : ""}: ${s("title")}`;
    case "artifact":
      return `${s("kind")} ${s("ref")}`.trim();
    case "ask":
    case "question.opened":
      return s("question");
    case "question.answered":
      return `answered: ${s("answer")}`;
    case "done":
      return s("summary") || "done";
    case "fail":
    case "execution.failed":
    case "execution.killed":
      return s("reason");
    case "execution.created":
      return `${s("profile")} ${kindWords(s("kind"), Number(p.round ?? 0))}, attempt ${String(p.attempt ?? 1)}`;
    case "execution.nudged":
      return `nudge ${String(p.nudge ?? "")}`;
    case "pr.created":
      return `PR #${String(p.number)} ${p.draft ? "(draft) " : ""}${s("head")} → ${s("base")}`;
    case "pr.updated":
      return `PR #${String(p.number)} ${["state", "approvals", "draft", "base", "needs_rebase"]
        .filter((k) => p[k] !== undefined)
        .map((k) => `${k} ${String(p[k])}`)
        .join(", ")}`;
    case "delivery.failed":
      return `${s("step")}: ${s("reason")}`;
    case "agent.event_rejected":
    case "command.rejected":
      return `${s("event_type") || s("command")}: ${s("reason")}`;
    case "command.applied":
      return s("command");
    case "jira.updated":
      return [p.transition ? `moved to ${s("transition")}` : "", p.comment ? "commented" : ""]
        .filter(Boolean)
        .join(", ");
    case "ticket.attention_added":
    case "ticket.attention_removed":
      return s("kind");
    default:
      return "";
  }
}

export type EventRow = {
  id: string;
  /** "10:25:13" (UTC), and the date for the first row of a day. */
  time: string;
  date: string;
  ticket: string;
  type: string;
  text: string;
  kinds: EventKind[];
  tone: Tone;
  /** The full text lives in attachments/ and retention removed it. */
  removed: boolean;
};

export type EventFilter = { ticket: string | null; kind: EventKind | null };

/** The tickets that appear in the events, for the filter. */
export const eventTickets = (events: Pick<LogEvent, "ticket">[]): string[] =>
  [...new Set(events.flatMap((e) => (e.ticket ? [e.ticket] : [])))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );

/** How many rows Activity draws at once; the newest are kept. */
export const EVENT_LIMIT = 300;

/**
 * The event log as rows, oldest first so the newest is last, narrowed by ticket and kind.
 * DECISION: `agent.event_accepted` is bookkeeping (the accepted agent event is its own row just
 * before it), so it is left out. A `body_ref` or artifact reference reads "removed after 90 days"
 * once the run's attachments were pruned, instead of pointing at a file that isn't there.
 */
export function eventRows(
  events: LogEvent[],
  filter: EventFilter,
  pruned: boolean,
): { rows: EventRow[]; total: number } {
  const matching = events.filter(
    (e) =>
      e.type !== "agent.event_accepted" &&
      (!filter.ticket || e.ticket === filter.ticket) &&
      (!filter.kind || eventKinds(e).includes(filter.kind)),
  );
  const rows = matching.slice(-EVENT_LIMIT).map((e): EventRow => {
    const kinds = eventKinds(e);
    const ref = typeof e.payload.body_ref === "string" ? e.payload.body_ref : null;
    const removed = pruned && (ref !== null || e.type === "artifact");
    let text = describeEvent(e);
    if (removed) text += `${text ? " " : ""}(full text removed after ${RETENTION_DAYS} days)`;
    else if (ref) text += ` (full text in ${ref})`;
    return {
      id: e.id,
      time: e.ts.slice(11, 19),
      date: e.ts.slice(0, 10),
      ticket: e.ticket ?? "",
      type: e.type,
      text,
      kinds,
      tone: kinds.includes("error") ? "blocked" : kinds.includes("question") ? "idle" : "muted",
      removed,
    };
  });
  return { rows, total: matching.length };
}

// --- Agent profile editor (Phase 7)

export const HARNESSES = ["claude-code", "codex"] as const;
export const ROLE_OPTIONS = ["developer", "reviewer", "analyst"] as const;

/** A profile as the editor holds it: every field as text or a flag, so half-typed input is fine. */
export type ProfileDraft = {
  /** True for a new or duplicated profile (its id and role can be set); false when editing a saved one. */
  isNew: boolean;
  id: string;
  name: string;
  role: Profile["role"];
  harness: string;
  model: string;
  /** One argument per line, written with `\n` between lines (see encodeLines). */
  args: string;
  instructions: string;
  write_worktree: boolean;
  shell: boolean;
  network: boolean;
  timeout_min: string;
  max_attempts: string;
};

/**
 * DECISION: gpui-kit's `Input` is single-line only (docs/herdr/gpui-kit.d.ts has no multi-line
 * state), so "one per line" and multi-line text are written in one line with `\n` marking a line
 * break and `\\` a backslash. These two functions convert both ways.
 */
export const encodeLines = (text: string): string =>
  text.replaceAll("\\", "\\\\").replaceAll("\r\n", "\n").replaceAll("\n", "\\n");
export const decodeLines = (text: string): string =>
  text.replaceAll(/\\(\\|n)/g, (_m, c: string) => (c === "n" ? "\n" : "\\"));

export const blankDraft = (role: Profile["role"] = "developer"): ProfileDraft => ({
  isNew: true,
  id: "",
  name: "",
  role,
  harness: "claude-code",
  model: "sonnet",
  args: "",
  instructions: "",
  write_worktree: role === "developer",
  shell: true,
  network: false,
  timeout_min: "60",
  max_attempts: "2",
});

export const draftOf = (p: Profile): ProfileDraft => ({
  isNew: false,
  id: p.id,
  name: p.name,
  role: p.role,
  harness: p.harness,
  model: p.model,
  args: encodeLines(p.args.join("\n")),
  instructions: encodeLines(p.instructions),
  write_worktree: p.permissions.write_worktree,
  shell: p.permissions.shell,
  network: p.permissions.network,
  timeout_min: String(p.timeout_min),
  max_attempts: String(p.max_attempts),
});

/** "Security reviewer!" -> "security-reviewer": a slug for the id when none was typed. */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

/** A copy of a profile: a new id (`-copy`, `-copy-2`, ...) and name, ready to edit and save. */
export function duplicateDraft(p: Profile, existingIds: string[]): ProfileDraft {
  let id = `${p.id}-copy`;
  for (let n = 2; existingIds.includes(id); n++) id = `${p.id}-copy-${n}`;
  return { ...draftOf(p), isNew: true, id, name: `${p.name} (copy)` };
}

const wholeNumber = (text: string): number => (/^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN);

/**
 * Checks a draft with the schema's `validateProfile` and builds the whole profile object for
 * `profile.save`: `v`, `id`, everything, and a fresh `updated_at`. The issues are the schema's own
 * messages (naming each field), plus one for a new profile whose id is already taken.
 */
export function buildProfile(
  d: ProfileDraft,
  existingIds: string[],
  nowIso: string,
): { ok: true; profile: Profile } | { ok: false; issues: string[] } {
  const id = d.id.trim() || slugify(d.name);
  const candidate = {
    v: 1,
    id,
    name: d.name.trim(),
    role: d.role,
    harness: d.harness,
    model: d.model.trim(),
    args: decodeLines(d.args)
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean),
    instructions: decodeLines(d.instructions),
    permissions: { write_worktree: d.write_worktree, shell: d.shell, network: d.network },
    timeout_min: wholeNumber(d.timeout_min),
    max_attempts: wholeNumber(d.max_attempts),
    updated_at: `${nowIso.slice(0, 19)}Z`,
  };
  const r = validateProfile(candidate);
  const issues = r.ok ? [] : r.issues.map((i) => formatIssues([i]));
  if (d.isNew && existingIds.includes(id))
    issues.push(`id: a profile called "${id}" already exists; pick another id, or edit that one.`);
  if (!HARNESSES.includes(d.harness as (typeof HARNESSES)[number]))
    issues.push(`harness: must be one of ${HARNESSES.join(", ")}.`);
  return issues.length || !r.ok ? { ok: false, issues } : { ok: true, profile: r.value };
}

export const saveProfileAction = (p: Profile): Action => ({
  id: `save-profile-${p.id}`,
  label: "Save profile",
  command: "profile.save",
  args: p as unknown as Record<string, unknown>,
});
