// The Collie mod's view model: everything the Board setup and Graph screens show, worked out
// from a board.json. Pure (no Herdr calls), so it is unit-tested apart from rendering.
import {
  criticalPath,
  describeCycle,
  edges,
  findCycles,
  type Layout,
  layout,
  type Readiness,
  readiness,
  satisfiesPolicy,
} from "@collie/board";
import type { Board, BoardTicket, ExecutionState, RunState, StateFile, TicketState } from "@collie/schema";

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
  delivery_error: "pushing or opening the pull request failed",
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

/** What a person can do to one ticket of a run. */
export function ticketRunActions(runId: string, t: TicketRunView): Action[] {
  const out: Action[] = [];
  const retry = (label: string): Action => ({
    id: `retry-${t.key}`,
    label,
    command: "ticket.retry",
    args: { run_id: runId, ticket: t.key },
  });
  if (t.state === "needs_input" && t.attentionKinds.includes("execution_failed"))
    out.push(retry("Retry with a new agent"));
  else if (t.state === "needs_input" && t.attentionKinds.includes("round_cap"))
    out.push(retry("Retry (one more round)"));
  for (const e of t.executions.filter((x) => x.live))
    out.push({
      id: `cancel-exec-${e.id}`,
      label: `Stop agent (attempt ${e.attempt})`,
      command: "exec.cancel",
      args: { run_id: runId, execution_id: e.id },
    });
  if (t.state !== "completed" && t.state !== "cancelled")
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
    if (t.state === "completed" || t.state === "cancelled") continue;
    for (const a of t.attention) {
      const retry = (label: string): NeedAction => ({
        id: `retry-${ticket}-${a.kind}`,
        label,
        type: "ctl",
        command: "ticket.retry",
        args: { run_id: run.id, ticket },
      });
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
          actions: [retry("Retry (one more round)")],
        });
      else if (a.kind === "execution_failed") {
        const r = failed?.result as { reason?: string } | null | undefined;
        out.push({
          key: `attention:${ticket}:execution_failed:${a.id ?? ""}`,
          kind: "execution_failed",
          ticket,
          summary: summary(ticket),
          reason: `${failed ? failed.profile : "An agent"} failed with no attempts left${r?.reason ? `: ${r.reason}` : ""}.`,
          actions: [retry("Retry"), ...watch],
        });
      } else if (a.kind === "delivery_error")
        out.push({
          key: `attention:${ticket}:delivery_error`,
          kind: "delivery_error",
          ticket,
          summary: summary(ticket),
          reason: "Pushing or opening the pull request failed.",
          actions: [],
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
