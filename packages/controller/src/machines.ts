// The run, ticket and execution state machines (docs/protocol.md, "State machines"), as data.
// Anything not listed is illegal: the controller refuses it rather than applying it.
import type { ExecutionState, RunState, TicketState } from "@collie/schema";

type Table<S extends string> = ReadonlyArray<readonly [S | null, S]>;

export const RUN_TRANSITIONS: Table<RunState> = [
  [null, "running"],
  ["running", "paused"],
  ["paused", "running"],
  ["running", "completed"],
  ["running", "cancelled"],
  ["paused", "cancelled"],
];

const WORKING: TicketState[] = ["in_progress", "reviewing", "remediating", "delivering"];
const TICKET_NON_FINAL: TicketState[] = [
  "pending",
  "blocked",
  "ready",
  "in_progress",
  "reviewing",
  "remediating",
  "delivering",
  "needs_input",
];

export const TICKET_TRANSITIONS: Table<TicketState> = [
  // DECISION: a ticket enters a run as `pending` (readiness is computed from Phase 3 on), or
  // as `completed` when carried over from an earlier run.
  [null, "pending"],
  [null, "completed"],
  ["pending", "blocked"],
  ["pending", "ready"],
  ["blocked", "ready"],
  ["ready", "blocked"],
  ["ready", "in_progress"],
  ["in_progress", "reviewing"],
  ["in_progress", "delivering"],
  ["reviewing", "remediating"],
  ["reviewing", "delivering"],
  ["remediating", "reviewing"],
  ["delivering", "completed"],
  ...WORKING.map((s) => [s, "needs_input"] as const),
  // needs_input -> resume_state: checked separately (it must go back where it came from).
  ...WORKING.map((s) => ["needs_input", s] as const),
  ...TICKET_NON_FINAL.map((s) => [s, "cancelled"] as const),
];

const EXEC_NON_FINAL: ExecutionState[] = ["created", "starting", "working", "needs_input"];

export const EXECUTION_TRANSITIONS: Table<ExecutionState> = [
  [null, "created"],
  ["created", "starting"],
  ["starting", "working"],
  ["working", "needs_input"],
  ["needs_input", "working"],
  ["working", "completed"],
  ["needs_input", "completed"],
  ["working", "failed"],
  ["needs_input", "failed"],
  ["created", "failed"],
  ["starting", "failed"],
  ...EXEC_NON_FINAL.map((s) => [s, "cancelled"] as const),
];

export const isLegal = <S extends string>(table: Table<S>, from: S | null, to: S) =>
  table.some(([f, t]) => f === from && t === to);

export const TICKET_FINAL: TicketState[] = ["completed", "cancelled"];
export const EXECUTION_FINAL: ExecutionState[] = ["completed", "failed", "cancelled"];
export const RUN_FINAL: RunState[] = ["completed", "cancelled"];
export const isTicketFinal = (s: TicketState) => TICKET_FINAL.includes(s);
export const isExecutionFinal = (s: ExecutionState) => EXECUTION_FINAL.includes(s);
export const isRunFinal = (s: RunState) => RUN_FINAL.includes(s);
