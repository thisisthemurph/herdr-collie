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
export type RunView = { id: string; number: number; status: RunState; boardId: string; state: StateFile };

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

function execView(id: string, e: StateFile["executions"][string]): ExecView {
  const r = e.result as { summary?: string; reason?: string } | null;
  const blocked = e.agent_blocked
    ? `waiting for ${e.agent_blocked.kind === "question" ? "an answer in its terminal" : "permission"}${e.agent_blocked.message ? `: ${e.agent_blocked.message}` : ""}`
    : null;
  return {
    id,
    attempt: e.attempt,
    kind: e.kind,
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

export function runModel(run: RunView | null): RunModel | null {
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
      executions: t.executions.flatMap((id) => (st.executions[id] ? [execView(id, st.executions[id])] : [])),
      attention: t.attention.map((a) => ATTENTION_TEXT[a.kind] ?? a.kind),
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
  if (t.state === "needs_input" && t.attention.includes(ATTENTION_TEXT.execution_failed as string))
    out.push({
      id: `retry-${t.key}`,
      label: "Retry with a new agent",
      command: "ticket.retry",
      args: { run_id: runId, ticket: t.key },
    });
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
  const bits = [`attempt ${e.attempt}`, e.state.replaceAll("_", " ")];
  if (e.terminal) bits.push(e.terminal);
  if (e.nudges) bits.push(`nudged ${e.nudges}×`);
  if (e.blocked) bits.push(e.blocked);
  return bits.join(" · ");
}
