// Valid configuration objects shared by the fixtures. Placeholders only: [SITE], [WORKSPACE], [REPO].
import type { Board, Profile, Workflow } from "@collie/schema";

export const BOARD_ID = "01JC8XW0000000000000000001";

export const developer: Profile = {
  v: 1,
  id: "developer",
  name: "Developer",
  role: "developer",
  harness: "claude-code",
  model: "[MODEL]",
  args: ["--permission-mode", "acceptEdits"],
  instructions: "Implement the ticket. Keep changes small and tested.",
  permissions: { write_worktree: true, shell: true, network: false },
  timeout_min: 60,
  max_attempts: 2,
  updated_at: "2026-11-08T09:00:00Z",
};

export const securityReviewer: Profile = {
  v: 1,
  id: "security-reviewer",
  name: "Security reviewer",
  role: "reviewer",
  harness: "claude-code",
  model: "[MODEL]",
  args: ["--permission-mode", "plan"],
  instructions: "Review the diff for authz, injection, secrets and unsafe input handling.",
  permissions: { write_worktree: false, shell: true, network: false },
  timeout_min: 30,
  max_attempts: 2,
  updated_at: "2026-11-08T09:00:00Z",
};

export const analyst: Profile = {
  v: 1,
  id: "requirements-analyst",
  name: "Requirements analyst",
  role: "analyst",
  harness: "claude-code",
  model: "[MODEL]",
  args: [],
  instructions: "Check the ticket is ready to implement.",
  permissions: { write_worktree: false, shell: true, network: false },
  timeout_min: 20,
  max_attempts: 1,
  updated_at: "2026-11-08T09:00:00Z",
};

export const standardFeature: Workflow = {
  v: 1,
  id: "standard-feature",
  name: "Standard feature",
  developer: "developer",
  reviewers: [{ profile: "security-reviewer", required: true }],
  max_remediation_rounds: 2,
};

export const smallBugFix: Workflow = {
  v: 1,
  id: "small-bug-fix",
  name: "Small bug fix",
  developer: "developer",
  reviewers: [],
  max_remediation_rounds: 0,
};

export const board: Board = {
  v: 1,
  id: BOARD_ID,
  name: "Payments API – Q4",
  jira: { site: "[SITE].atlassian.net", cloud_id: "[CLOUD-ID]", project: "PAY" },
  repo: { workspace: "[WORKSPACE]", slug: "[REPO]", default_branch: "main", local_path: "~/code/[REPO]" },
  settings: {
    workflow: "standard-feature",
    max_tickets: 3,
    max_agents: 6,
    completion_policy: { mode: "done_or_resolved", statuses: [] },
    complete_at: "pr_created",
    pr_draft_policy: "draft_when_stacked",
    jira_writeback: { on_start: "In Progress", on_pr: "In Review", comment: true },
  },
  tickets: {
    "PAY-101": {
      summary: "Payment persistence layer",
      jira_status: "To Do",
      status_category: "new",
      resolution: null,
      blocked_by: [],
      on_board: true,
      preparation: "ready",
      workflow: null,
      fetched_at: "2026-11-08T09:40:00Z",
    },
    "PAY-102": {
      summary: "Payment API endpoints",
      jira_status: "To Do",
      status_category: "new",
      resolution: null,
      blocked_by: ["PAY-101", "OPS-77"],
      on_board: true,
      preparation: "ready",
      workflow: "small-bug-fix",
      fetched_at: "2026-11-08T09:40:00Z",
    },
    "OPS-77": {
      summary: "Provision payments database",
      jira_status: "Done",
      status_category: "done",
      resolution: "Done",
      blocked_by: [],
      on_board: false,
      preparation: "unreviewed",
      workflow: null,
      fetched_at: "2026-11-08T09:40:00Z",
    },
  },
  overrides: [],
  updated_at: "2026-11-08T09:52:00Z",
};
