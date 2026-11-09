// `collie ctl` control commands and their replies (docs/protocol.md, "Control commands").

import { nonEmpty, PREPARATION_STATES, schemaVersion, ticketKey, timestamp, ulid } from "./common.ts";
import { jiraLink, partialBoardSettings, profile, repoLink, workflow } from "./config.ts";
import {
  anyObject,
  arr,
  bool,
  type Infer,
  join,
  lit,
  obj,
  oneOf,
  opt,
  type Schema,
  str,
  tagged,
} from "./validate.ts";

const reasonArgs = obj({ run_id: ulid, reason: opt(nonEmpty) });
const depArgs = obj({ board_id: ulid, blocker: ticketKey, blocked: ticketKey });
const runTicket = obj({ run_id: ulid, ticket: ticketKey });

export const COMMAND_ARGS = {
  // DECISION: board.create takes the Jira site and project; the controller looks up cloud_id
  // itself, so it is optional here. Settings may be partial; missing ones take board defaults.
  "board.create": obj({
    name: nonEmpty,
    jira: obj({ site: jiraLink.shape.site, project: jiraLink.shape.project, cloud_id: opt(nonEmpty) }),
    repo: repoLink,
    settings: opt(partialBoardSettings),
  }),
  "board.import": obj(
    { board_id: ulid, keys: opt(arr(ticketKey, { min: 1 })), jql: opt(str({ min: 1 })) },
    (a, path, issues) => {
      if ((a.keys === undefined) === (a.jql === undefined)) {
        issues.push({ path: join(path, "keys"), message: "give exactly one of keys and jql" });
      }
    },
  ),
  "board.refresh": obj({ board_id: ulid }),
  "board.update_settings": obj({ board_id: ulid, settings: partialBoardSettings }),
  "ticket.set_preparation": obj({
    board_id: ulid,
    ticket: ticketKey,
    preparation: oneOf(PREPARATION_STATES),
  }),
  "ticket.pull_in": obj({ board_id: ulid, ticket: ticketKey }),
  "ticket.investigate": obj({ board_id: ulid, tickets: arr(ticketKey, { min: 1 }) }),
  "dep.override": depArgs,
  "dep.restore": depArgs,
  "profile.save": profile,
  "workflow.save": workflow,
  "run.start": obj({ board_id: ulid, carry_over_from: opt(ulid) }),
  "run.pause": reasonArgs,
  "run.resume": reasonArgs,
  "run.cancel": reasonArgs,
  "run.delete": obj({ run_id: ulid }),
  "ticket.cancel": runTicket,
  "ticket.retry": runTicket,
  "exec.cancel": obj({ run_id: ulid, execution_id: ulid }),
  "question.answer": obj({ run_id: ulid, question_id: ulid, answer: nonEmpty, share_with_ticket: bool }),
  "pr.mark_ready": runTicket,
} as const;

export type CommandName = keyof typeof COMMAND_ARGS;
export const COMMAND_NAMES = Object.keys(COMMAND_ARGS) as CommandName[];

export type Command = {
  [K in CommandName]: { v: 1; id: string; command: K; at: string; args: Infer<(typeof COMMAND_ARGS)[K]> };
}[CommandName];

export const command: Schema<Command> = tagged(
  "command",
  Object.fromEntries(
    Object.entries(COMMAND_ARGS).map(([name, args]) => [
      name,
      obj({ v: schemaVersion, id: ulid, command: lit(name), at: timestamp, args }),
    ]),
  ),
  "command",
);

export const ERROR_CODES = [
  "invalid_args",
  "not_found",
  "invalid_state",
  "lease_conflict",
  "cycle_detected",
  "unsupported",
  "upstream_error",
  "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const okReply = obj({ v: schemaVersion, id: ulid, ok: lit(true), result: anyObject });
const errReply = obj({
  v: schemaVersion,
  id: ulid,
  ok: lit(false),
  error: obj({ code: oneOf(ERROR_CODES), message: nonEmpty }),
});

export type CommandReply = Infer<typeof okReply> | Infer<typeof errReply>;

export const commandReply: Schema<CommandReply> = {
  check(v, path, issues) {
    const ok = typeof v === "object" && v !== null ? (v as Record<string, unknown>).ok : undefined;
    if (ok === true) okReply.check(v, path, issues);
    else if (ok === false) errReply.check(v, path, issues);
    else issues.push({ path: join(path, "ok"), message: `must be true or false, got ${JSON.stringify(ok)}` });
  },
};
