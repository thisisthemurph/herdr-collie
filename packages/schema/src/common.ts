// Shared scalar shapes and enumerations from docs/protocol.md.
import { type Issue, int, oneOf, type Schema, str, typeName } from "./validate.ts";

/** Schema major version. Additive, optional fields don't bump it; anything else does. */
export const SCHEMA_VERSION = 1 as const;

/** Inbox lines (including the trailing newline) are capped at 64 KB. */
export const MAX_INBOX_LINE_BYTES = 64 * 1024;

export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const ulid = str({ pattern: ULID_RE, what: "a ULID (26 Crockford base32 characters)" });

/** Human-named ids: profiles, workflows, harnesses. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const slug = str({ pattern: SLUG_RE, what: "a slug of a-z, 0-9 and single dashes" });

/** A Jira issue key such as PAY-102. */
export const TICKET_RE = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
export const ticketKey = str({ pattern: TICKET_RE, what: "a Jira issue key such as PAY-102" });

// DECISION: event timestamps must carry milliseconds ("Writer's clock, milliseconds");
// configuration and state timestamps may omit them, as the protocol's examples do.
const TS_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

function validDate(re: RegExp, what: string) {
  const base = str({ pattern: re, what });
  return {
    check(v: unknown, path: string, issues: Issue[]) {
      const before = issues.length;
      base.check(v, path, issues);
      // Date.parse rolls impossible dates over (Feb 30 -> Mar 2), so compare the round trip.
      const ms = Date.parse(v as string);
      if (
        issues.length === before &&
        (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== (v as string).slice(0, 19))
      ) {
        issues.push({ path, message: `is not a real date and time: ${JSON.stringify(v)}` });
      }
    },
  };
}

/** RFC 3339 UTC with milliseconds, e.g. 2026-11-08T10:25:13.412Z. */
export const eventTimestamp = validDate(
  TS_MS_RE,
  "an RFC 3339 UTC timestamp with milliseconds (2026-11-08T10:25:13.412Z)",
);
/** RFC 3339 UTC, fractional seconds optional. */
export const timestamp = validDate(TS_RE, "an RFC 3339 UTC timestamp (2026-11-08T10:25:13Z)");

/** A short git commit sha (7 to 40 hex characters). */
export const commitSha = str({
  pattern: /^[0-9a-f]{7,40}$/,
  what: "a git commit sha (7-40 lowercase hex characters)",
});

export const nonEmpty = str({ min: 1 });
export const count = int({ min: 0 });

// --- enumerations

export const ROLES = ["developer", "reviewer", "analyst"] as const;
export type Role = (typeof ROLES)[number];
export const role = oneOf(ROLES);

export const EXECUTION_KINDS = ["analyse", "develop", "review", "remediate"] as const;
export type ExecutionKind = (typeof EXECUTION_KINDS)[number];

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_CATEGORIES = [
  "security",
  "correctness",
  "tests",
  "performance",
  "design",
  "style",
] as const;
export const ARTIFACT_KINDS = ["commit", "branch", "test_report", "file"] as const;
export const VERDICTS = ["approve", "request_changes"] as const;
export const FAIL_CATEGORIES = [
  "blocked_external",
  "cannot_implement",
  "tooling",
  "environment",
  "other",
] as const;
export const STATUS_PHASES = [
  "investigating",
  "implementing",
  "testing",
  "reviewing",
  "remediating",
] as const;

export const RUN_STATES = ["running", "paused", "completed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TICKET_STATES = [
  "pending",
  "blocked",
  "ready",
  "in_progress",
  "reviewing",
  "remediating",
  "delivering",
  "needs_input",
  "completed",
  "cancelled",
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export const EXECUTION_STATES = [
  "created",
  "starting",
  "working",
  "needs_input",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const PREPARATION_STATES = [
  "unreviewed",
  "investigating",
  "needs_input",
  "ready",
  "excluded",
] as const;
export const ATTENTION_KINDS = ["question", "round_cap", "execution_failed", "delivery_error"] as const;
export const COMPLETION_MODES = ["done_only", "done_or_resolved", "done_or_testing", "custom"] as const;
export const COMPLETE_AT = ["implemented", "pr_created", "pr_approved", "merged"] as const;
export const PR_DRAFT_POLICIES = ["draft_when_stacked", "always_draft"] as const;
export const STATUS_CATEGORIES = ["new", "indeterminate", "done"] as const;
/** Bitbucket Cloud pull request states. */
export const PR_STATES = ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"] as const;
// DECISION: the protocol names "open" and "withdrawn"; answered and delivered follow its answer steps.
export const QUESTION_STATES = ["open", "answered", "delivered", "withdrawn"] as const;
/** hc's `blocked` kinds (docs/spike.md, experiment 2). */
export const BLOCKED_KINDS = ["permission", "question"] as const;
export const EVENT_SOURCES = ["agent", "controller", "human"] as const;

/** The `v` field: an integer, and the one major version this code understands. */
export const schemaVersion: Schema<typeof SCHEMA_VERSION> = {
  check(v: unknown, path: string, issues: Issue[]) {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      issues.push({ path, message: `must be an integer schema version, got ${typeName(v)}` });
    } else if (v !== SCHEMA_VERSION) {
      issues.push({
        path,
        message: `unsupported schema version ${v}; this reader understands ${SCHEMA_VERSION}`,
      });
    }
  },
};
