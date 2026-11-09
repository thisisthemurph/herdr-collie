// Configuration files: agent profiles, workflows and boards (docs/protocol.md, "Configuration files").
import {
  COMPLETE_AT,
  COMPLETION_MODES,
  count,
  nonEmpty,
  PR_DRAFT_POLICIES,
  PREPARATION_STATES,
  role,
  STATUS_CATEGORIES,
  schemaVersion,
  slug,
  TICKET_RE,
  ticketKey,
  timestamp,
  ulid,
} from "./common.ts";
import {
  arr,
  bool,
  type Infer,
  int,
  join,
  lit,
  nullable,
  obj,
  oneOf,
  partial,
  record,
  str,
} from "./validate.ts";

export const profile = obj({
  v: schemaVersion,
  id: slug,
  name: nonEmpty,
  role,
  harness: slug,
  model: nonEmpty,
  args: arr(str()),
  instructions: str(),
  permissions: obj({ write_worktree: bool, shell: bool, network: bool }),
  timeout_min: int({ min: 1 }),
  max_attempts: int({ min: 1 }),
  updated_at: timestamp,
});
export type Profile = Infer<typeof profile>;

export const workflow = obj({
  v: schemaVersion,
  id: slug,
  name: nonEmpty,
  developer: slug,
  reviewers: arr(obj({ profile: slug, required: bool })),
  max_remediation_rounds: count,
});
export type Workflow = Infer<typeof workflow>;

export const completionPolicy = obj(
  {
    mode: oneOf(COMPLETION_MODES),
    statuses: arr(nonEmpty),
  },
  (p, path, issues) => {
    if (p.mode === "custom" && p.statuses.length === 0) {
      issues.push({
        path: join(path, "statuses"),
        message: "must list at least one Jira status when mode is custom",
      });
    }
  },
);

const statusName = nullable(nonEmpty);

const boardSettingsShape = {
  workflow: slug,
  max_tickets: int({ min: 1 }),
  max_agents: int({ min: 1 }),
  completion_policy: completionPolicy,
  complete_at: oneOf(COMPLETE_AT),
  pr_draft_policy: oneOf(PR_DRAFT_POLICIES),
  // Target Jira status names; null means don't move the issue at that point.
  jira_writeback: obj({ on_start: statusName, on_pr: statusName, comment: bool }),
};
export const boardSettings = obj(boardSettingsShape);
export type BoardSettings = Infer<typeof boardSettings>;

export const boardTicket = obj({
  summary: str(),
  jira_status: nonEmpty,
  status_category: oneOf(STATUS_CATEGORIES),
  resolution: nullable(nonEmpty),
  blocked_by: arr(ticketKey),
  on_board: bool,
  preparation: oneOf(PREPARATION_STATES),
  workflow: nullable(slug),
  fetched_at: timestamp,
});
export type BoardTicket = Infer<typeof boardTicket>;

export const override = obj({ blocker: ticketKey, blocked: ticketKey, by: lit("human"), at: timestamp });

export const ticketMap = record(
  str({ pattern: TICKET_RE, what: "a Jira issue key such as PAY-102" }),
  boardTicket,
);

export const jiraLink = obj({
  site: str({ pattern: /^[^\s/]+\.atlassian\.net$/, what: "a Jira Cloud host such as [SITE].atlassian.net" }),
  cloud_id: nonEmpty,
  project: str({ pattern: /^[A-Z][A-Z0-9_]*$/, what: "a Jira project key such as PAY" }),
});

export const repoLink = obj({
  workspace: nonEmpty,
  slug: nonEmpty,
  default_branch: nonEmpty,
  local_path: nonEmpty,
});

export const board = obj({
  v: schemaVersion,
  id: ulid,
  name: nonEmpty,
  jira: jiraLink,
  repo: repoLink,
  settings: boardSettings,
  tickets: ticketMap,
  overrides: arr(override),
  updated_at: timestamp,
});
export type Board = Infer<typeof board>;

/** Board settings where every field may be left out (board.create, board.update_settings). */
export const partialBoardSettings = partial(boardSettingsShape);
