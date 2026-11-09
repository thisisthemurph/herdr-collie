// The event envelope, the six agent events and the controller events (docs/protocol.md,
// "Event envelope", "Agent events", "Controller events and answer delivery", "Retention").
import {
  ARTIFACT_KINDS,
  ATTENTION_KINDS,
  BLOCKED_KINDS,
  commitSha,
  count,
  EVENT_SOURCES,
  EXECUTION_KINDS,
  EXECUTION_STATES,
  eventTimestamp,
  FAIL_CATEGORIES,
  FINDING_CATEGORIES,
  nonEmpty,
  PR_STATES,
  role,
  SEVERITIES,
  STATUS_PHASES,
  schemaVersion,
  slug,
  TICKET_STATES,
  ticketKey,
  ulid,
  VERDICTS,
} from "./common.ts";
import {
  anyObject,
  arr,
  bool,
  type Infer,
  type InferShape,
  int,
  join,
  lit,
  nullable,
  obj,
  oneOf,
  opt,
  type Schema,
  str,
  tagged,
} from "./validate.ts";

// --- envelope

const envelopeShape = {
  v: schemaVersion,
  id: ulid,
  type: nonEmpty,
  ts: eventTimestamp,
  source: oneOf(EVENT_SOURCES),
  run_id: nullable(ulid),
  execution_id: nullable(ulid),
  ticket: nullable(ticketKey),
  caused_by: nullable(ulid),
  payload: anyObject,
};
export const envelope = obj(envelopeShape);
export type Envelope = Infer<typeof envelope>;

// --- agent event payloads

export const statusPayload = obj({
  message: str({ min: 1, max: 200 }),
  phase: opt(oneOf(STATUS_PHASES)),
});

export const findingPayload = obj(
  {
    severity: oneOf(SEVERITIES),
    title: str({ min: 1, max: 200 }),
    body: opt(nonEmpty),
    body_ref: opt(nonEmpty),
    file: opt(nonEmpty),
    line: opt(int({ min: 1 })),
    end_line: opt(int({ min: 1 })),
    category: opt(oneOf(FINDING_CATEGORIES)),
    suggestion: opt(nonEmpty),
    blocking: opt(bool),
  },
  (p, path, issues) => {
    // DECISION: exactly one of body and body_ref; a long body moves to an attachment.
    if (p.body === undefined && p.body_ref === undefined) {
      issues.push({
        path: join(path, "body"),
        message: "is required (or body_ref for a body stored in attachments/)",
      });
    } else if (p.body !== undefined && p.body_ref !== undefined) {
      issues.push({ path: join(path, "body_ref"), message: "must not be set together with body" });
    }
    if (p.end_line !== undefined && p.line === undefined) {
      issues.push({ path: join(path, "line"), message: "is required when end_line is set" });
    } else if (p.end_line !== undefined && p.line !== undefined && p.end_line < p.line) {
      issues.push({
        path: join(path, "end_line"),
        message: `must be at least line (${p.line}), got ${p.end_line}`,
      });
    }
    // DECISION: a line number means nothing without its file.
    if ((p.line !== undefined || p.end_line !== undefined) && p.file === undefined) {
      issues.push({ path: join(path, "file"), message: "is required when line is set" });
    }
  },
);

export const artifactPayload = obj({
  kind: oneOf(ARTIFACT_KINDS),
  ref: nonEmpty,
  description: opt(nonEmpty),
});

export const askPayload = obj({
  question: nonEmpty,
  options: opt(arr(nonEmpty)),
  context: opt(nonEmpty),
});

export const testsResult = obj({ command: nonEmpty, passed: bool });

export const donePayload = obj({
  summary: nonEmpty,
  verdict: opt(oneOf(VERDICTS)),
  commits: opt(arr(commitSha)),
  tests: opt(testsResult),
});

export const failPayload = obj({
  reason: nonEmpty,
  category: oneOf(FAIL_CATEGORIES),
  retryable: bool,
  details: opt(nonEmpty),
});

export const AGENT_PAYLOADS = {
  status: statusPayload,
  finding: findingPayload,
  artifact: artifactPayload,
  ask: askPayload,
  done: donePayload,
  fail: failPayload,
} as const;
export type AgentEventType = keyof typeof AGENT_PAYLOADS;
export const AGENT_EVENT_TYPES = Object.keys(AGENT_PAYLOADS) as AgentEventType[];

export type DonePayload = Infer<typeof donePayload>;
export type FailPayload = Infer<typeof failPayload>;

type EnvelopeOf<T extends string, P> = Omit<Envelope, "type" | "payload"> & { type: T; payload: P };
export type AgentEvent = {
  [K in AgentEventType]: EnvelopeOf<K, Infer<(typeof AGENT_PAYLOADS)[K]>>;
}[AgentEventType];

// DECISION: run_id is null only for analyst executions, which belong to board preparation and
// have no run (protocol, "Execution"). Agent events always carry execution_id and ticket.
function agentEnvelope<T extends string>(type: T, payload: Schema<unknown>) {
  return obj({
    ...envelopeShape,
    type: lit(type),
    source: lit("agent"),
    execution_id: ulid,
    ticket: ticketKey,
    payload,
  });
}

export const agentEvent: Schema<AgentEvent> = tagged(
  "type",
  Object.fromEntries(Object.entries(AGENT_PAYLOADS).map(([t, p]) => [t, agentEnvelope(t, p)])),
  "agent event type",
);

// --- controller event payloads

const reasonOnly = obj({ reason: opt(nonEmpty) });
const empty = obj({});
const ticketState = oneOf(TICKET_STATES);
const executionState = oneOf(EXECUTION_STATES);

export const CONTROLLER_PAYLOADS = {
  // Run
  "run.started": obj({ board_id: ulid, number: int({ min: 1 }), carried_over_from: nullable(ulid) }),
  "run.paused": reasonOnly,
  "run.resumed": reasonOnly,
  "run.completed": reasonOnly,
  "run.cancelled": reasonOnly,
  // Lease
  "ticket.leased": empty,
  "ticket.released": empty,
  // Ticket
  // DECISION: `from` is null for a ticket's first state in a run.
  "ticket.state_changed": obj({ from: nullable(ticketState), to: ticketState, reason: nonEmpty }),
  // Something holding the ticket in Needs input, other than a question (question.* events
  // cover those): round_cap, execution_failed, delivery_error.
  "ticket.attention_added": obj({ kind: oneOf(ATTENTION_KINDS), id: opt(nonEmpty) }),
  "ticket.attention_removed": obj({ kind: oneOf(ATTENTION_KINDS), id: opt(nonEmpty) }),
  // Execution
  "execution.created": obj({
    profile: slug,
    role,
    kind: oneOf(EXECUTION_KINDS),
    round: count,
    attempt: int({ min: 1 }),
    worktree: nonEmpty,
    branch: nonEmpty,
    base: opt(nonEmpty),
  }),
  "execution.started": obj({ terminal: nonEmpty }),
  "execution.state_changed": obj({ from: nullable(executionState), to: executionState, reason: nonEmpty }),
  "execution.nudged": obj({ nudge: int({ min: 1 }) }),
  "execution.completed": obj({ result: donePayload }),
  "execution.failed": obj({ reason: nonEmpty, category: oneOf(FAIL_CATEGORIES), retryable: bool }),
  "execution.killed": reasonOnly,
  // Execution status from hc, not an execution state (protocol, "Talking to an agent")
  "execution.agent_blocked": obj({ kind: oneOf(BLOCKED_KINDS), message: opt(nonEmpty) }),
  "execution.agent_unblocked": empty,
  // Agent input: caused_by is the inbox event's id
  // `offset`: the inbox byte offset just after the line, so a rebuild knows where reading stopped.
  "agent.event_accepted": obj({ event_type: nonEmpty, offset: opt(count) }),
  "agent.event_rejected": obj({ event_type: opt(nonEmpty), reason: nonEmpty, offset: opt(count) }),
  // Questions
  "question.opened": obj({ question_id: ulid, question: nonEmpty, options: arr(nonEmpty) }),
  "question.answered": obj({
    question_id: ulid,
    answer: nonEmpty,
    by: nonEmpty,
    share_with_ticket: bool,
  }),
  "question.delivered": obj({ question_id: ulid }),
  // Delivery
  "pr.created": obj({ number: int({ min: 1 }), url: nonEmpty, base: nonEmpty, head: nonEmpty, draft: bool }),
  "pr.updated": obj({
    number: int({ min: 1 }),
    base: opt(nonEmpty),
    draft: opt(bool),
    state: opt(oneOf(PR_STATES)),
    approvals: opt(count),
  }),
  "pr.conflict_checked": obj({ number: int({ min: 1 }), conflicted: bool, paths: arr(nonEmpty) }),
  // DECISION: `transition` is the target status moved to; `comment` is true when a comment was added.
  "jira.updated": obj({ transition: opt(nonEmpty), comment: opt(bool) }),
  "jira.writeback_skipped": obj({ target: nonEmpty, available: arr(nonEmpty) }),
  // Commands: caused_by is the command id
  "command.applied": obj({ command: nonEmpty }),
  "command.rejected": obj({ command: nonEmpty, code: nonEmpty, reason: nonEmpty }),
  // Retention
  "worktree.kept": obj({ worktree: nonEmpty, reason: nonEmpty }),
  "worktree.removed": obj({ worktree: nonEmpty }),
  "retention.pruned": obj({ paths: arr(nonEmpty, { min: 1 }) }),
} as const;

export type ControllerEventType = keyof typeof CONTROLLER_PAYLOADS;
export const CONTROLLER_EVENT_TYPES = Object.keys(CONTROLLER_PAYLOADS) as ControllerEventType[];

export type ControllerEvent = {
  [K in ControllerEventType]: EnvelopeOf<K, Infer<(typeof CONTROLLER_PAYLOADS)[K]>>;
}[ControllerEventType];

// DECISION: the protocol says execution_id and ticket are null only for run- and ticket-level
// events, so ticket.*, execution.*, question.*, pr.* and jira.* must name their ticket, and
// execution.* and agent.* their execution.
/** Events whose `ticket` must be set. */
const TICKET_EVENTS = (t: string) =>
  t.startsWith("ticket.") ||
  t.startsWith("execution.") ||
  t.startsWith("question.") ||
  t.startsWith("pr.") ||
  t.startsWith("jira.");
/** Events whose `caused_by` must be set: they answer an inbox line or a command. */
// DECISION: agent.event_rejected may have caused_by null, for a line with no readable id.
const CAUSED_EVENTS = new Set(["agent.event_accepted", "command.applied", "command.rejected"]);

function controllerEnvelope(type: string, payload: Schema<unknown>) {
  const base = {
    ...envelopeShape,
    type: lit(type),
    // DECISION: controller events are written by the controller; `human` marks those a person caused
    // through `collie ctl` (an answer, a cancel). Agents never appear in events.jsonl as a source.
    source: oneOf(["controller", "human"] as const),
    run_id: ulid,
    payload,
  };
  const withTicket = TICKET_EVENTS(type) ? { ...base, ticket: ticketKey } : base;
  const withExec =
    type.startsWith("execution.") || type.startsWith("agent.")
      ? { ...withTicket, execution_id: ulid }
      : withTicket;
  const shape = CAUSED_EVENTS.has(type) ? { ...withExec, caused_by: ulid } : withExec;
  return obj(shape);
}

export const controllerEvent: Schema<ControllerEvent> = tagged(
  "type",
  Object.fromEntries(Object.entries(CONTROLLER_PAYLOADS).map(([t, p]) => [t, controllerEnvelope(t, p)])),
  "controller event type",
);

export type AnyEvent = AgentEvent | ControllerEvent;

/** Agent types are bare words and controller types are dotted, so the type alone picks the schema. */
export const anyEvent: Schema<AnyEvent> = tagged(
  "type",
  {
    ...Object.fromEntries(AGENT_EVENT_TYPES.map((t) => [t, agentEvent])),
    ...Object.fromEntries(CONTROLLER_EVENT_TYPES.map((t) => [t, controllerEvent])),
  },
  "event type",
);

export type EventPayload<T extends AgentEventType | ControllerEventType> = T extends AgentEventType
  ? InferShape<(typeof AGENT_PAYLOADS)[T]["shape"]>
  : T extends ControllerEventType
    ? Infer<(typeof CONTROLLER_PAYLOADS)[T]>
    : never;
