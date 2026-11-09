// Runtime files written by the controller: run.json, execution.json and state.json
// (docs/protocol.md, "Runtime files").

import {
  ATTENTION_KINDS,
  count,
  EXECUTION_KINDS,
  EXECUTION_STATES,
  nonEmpty,
  PR_STATES,
  QUESTION_STATES,
  RUN_STATES,
  role,
  SEVERITIES,
  SLUG_RE,
  schemaVersion,
  slug,
  TICKET_RE,
  TICKET_STATES,
  ticketKey,
  timestamp,
  ULID_RE,
  ulid,
} from "./common.ts";
import { boardSettings, override, profile, ticketMap, workflow } from "./config.ts";
import { donePayload, failPayload } from "./events.ts";
import {
  arr,
  bool,
  type Infer,
  type Issue,
  int,
  nullable,
  obj,
  oneOf,
  opt,
  record,
  type Schema,
  str,
} from "./validate.ts";

const slugKey = str({ pattern: SLUG_RE, what: "a slug" });
const ulidKey = str({ pattern: ULID_RE, what: "a ULID" });
const ticketKeyKey = str({ pattern: TICKET_RE, what: "a Jira issue key" });

export const runFile = obj({
  v: schemaVersion,
  id: ulid,
  board_id: ulid,
  number: int({ min: 1 }),
  status: oneOf(RUN_STATES),
  started_at: timestamp,
  ended_at: nullable(timestamp),
  end_reason: nullable(nonEmpty),
  carried_over_from: nullable(ulid),
  snapshot: obj({
    settings: boardSettings,
    tickets: ticketMap,
    overrides: arr(override),
    workflows: record(slugKey, workflow),
    profiles: record(slugKey, profile),
  }),
});
export type RunFile = Infer<typeof runFile>;

export const executionFile = obj({
  v: schemaVersion,
  id: ulid,
  run_id: nullable(ulid),
  ticket: ticketKey,
  profile: slug,
  role,
  kind: oneOf(EXECUTION_KINDS),
  round: count,
  attempt: int({ min: 1 }),
  worktree: nonEmpty,
  branch: nonEmpty,
  terminal: nullable(nonEmpty),
  created_at: timestamp,
});
export type ExecutionFile = Infer<typeof executionFile>;

export const prState = obj({
  id: int({ min: 1 }),
  url: nonEmpty,
  source: nonEmpty,
  destination: nonEmpty,
  draft: bool,
  state: oneOf(PR_STATES),
  approvals: count,
  conflicted: bool,
  conflict_checked_at: nullable(timestamp),
});

export const ticketRunState = obj({
  state: oneOf(TICKET_STATES),
  resume_state: nullable(oneOf(TICKET_STATES)),
  attention: arr(obj({ kind: oneOf(ATTENTION_KINDS), id: opt(nonEmpty) })),
  round: count,
  branch: nullable(nonEmpty),
  base: nullable(nonEmpty),
  executions: arr(ulid),
  pr: nullable(prState),
});

/** An accepted `done` or `fail` payload. */
const executionResult: Schema<Infer<typeof donePayload> | Infer<typeof failPayload>> = {
  check(v: unknown, path: string, issues: Issue[]) {
    const isFail = typeof v === "object" && v !== null && "reason" in v && !("summary" in v);
    (isFail ? failPayload : donePayload).check(v, path, issues);
  },
};

export const executionRunState = obj({
  ticket: ticketKey,
  profile: slug,
  kind: oneOf(EXECUTION_KINDS),
  state: oneOf(EXECUTION_STATES),
  attempt: int({ min: 1 }),
  round: count,
  terminal: nullable(nonEmpty),
  nudges: count,
  started_at: nullable(timestamp),
  ended_at: nullable(timestamp),
  result: nullable(executionResult),
});

export const questionState = obj({
  execution_id: ulid,
  ticket: ticketKey,
  question: nonEmpty,
  options: arr(nonEmpty),
  state: oneOf(QUESTION_STATES),
  answer: nullable(nonEmpty),
  share_with_ticket: bool,
});

export const findingState = obj({
  id: ulid,
  ticket: ticketKey,
  execution_id: ulid,
  round: count,
  severity: oneOf(SEVERITIES),
  blocking: bool,
  title: nonEmpty,
  file: opt(nonEmpty),
  line: opt(int({ min: 1 })),
  addressed_in_round: nullable(count),
});

export const stateFile = obj({
  v: schemaVersion,
  run_id: ulid,
  last_event_id: nullable(ulid),
  status: oneOf(RUN_STATES),
  leases: arr(ticketKey),
  tickets: record(ticketKeyKey, ticketRunState),
  executions: record(ulidKey, executionRunState),
  questions: record(ulidKey, questionState),
  findings: arr(findingState),
  inbox_offsets: record(ulidKey, count),
});
export type StateFile = Infer<typeof stateFile>;
