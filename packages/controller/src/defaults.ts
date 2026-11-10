// The profiles and workflows Collie starts with (docs/plan.md, Phase 5: "Standard feature
// (default) and Small bug fix"). They are written to ~/.collie only when missing, so editing or
// deleting one is never undone by a restart.
import { existsSync } from "node:fs";
import type { Profile, Workflow } from "@collie/schema";
import { type Home, writeJsonAtomic } from "./home.ts";

// What a Claude Code agent may do without asking, so it isn't stopped by permission prompts for
// its own bookkeeping. `collie` is how it reports; git is how it delivers. Anything else (a test
// runner, a build) asks, and the person answers in the agent's terminal.
const COLLIE = "Bash(collie:*)";
const GIT_READ = ["Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)"];
const GIT_WRITE = ["Bash(git add:*)", "Bash(git commit:*)"];

const base = {
  v: 1 as const,
  harness: "claude-code",
  model: "sonnet",
  max_attempts: 2,
  updated_at: "2026-11-10T00:00:00Z",
};

const reviewer = (id: string, name: string, instructions: string): Profile => ({
  ...base,
  id,
  name,
  role: "reviewer",
  args: ["--allowedTools", COLLIE, ...GIT_READ],
  instructions: `${instructions} Only report problems in the code this branch changed. Mark a finding blocking only when it must be fixed before merge. You are read-only: never change files.`,
  permissions: { write_worktree: false, shell: true, network: false },
  timeout_min: 30,
});

export const DEFAULT_PROFILES: Profile[] = [
  {
    ...base,
    id: "developer",
    name: "Developer",
    role: "developer",
    args: ["--permission-mode", "acceptEdits", "--allowedTools", COLLIE, ...GIT_READ, ...GIT_WRITE],
    instructions:
      "You are a careful senior software engineer. Match the style of the code around you, keep the change small and focused on the ticket, and add or update tests. Commit your work on the ticket branch before you report it done.",
    permissions: { write_worktree: true, shell: true, network: false },
    timeout_min: 60,
  },
  reviewer(
    "security-reviewer",
    "Security reviewer",
    "Review the change for authorisation gaps, injection, unsafe input handling, secrets in code or logs, and weak defaults.",
  ),
  reviewer(
    "backend-reviewer",
    "Backend reviewer",
    "Review the change for correctness, error handling, data integrity, concurrency, API design and missing tests.",
  ),
  reviewer(
    "frontend-reviewer",
    "Frontend reviewer",
    "Review the change for UI correctness, accessibility, state handling and responsiveness. If the change has no frontend code, approve it.",
  ),
  {
    ...base,
    id: "requirements-analyst",
    name: "Requirements analyst",
    role: "analyst",
    args: ["--allowedTools", COLLIE, ...GIT_READ],
    instructions:
      "You decide whether a ticket is ready to be implemented. Be specific: ask only about real ambiguities that change what gets built, one question at a time, and don't ask what the code or the ticket already answers. You are read-only: never change files.",
    permissions: { write_worktree: false, shell: true, network: false },
    timeout_min: 20,
  },
];

export const DEFAULT_WORKFLOWS: Workflow[] = [
  {
    v: 1,
    id: "standard-feature",
    name: "Standard feature",
    developer: "developer",
    reviewers: [
      { profile: "security-reviewer", required: true },
      { profile: "backend-reviewer", required: true },
      { profile: "frontend-reviewer", required: false },
    ],
    max_remediation_rounds: 2,
  },
  {
    v: 1,
    id: "small-bug-fix",
    name: "Small bug fix",
    developer: "developer",
    reviewers: [],
    max_remediation_rounds: 0,
  },
];

/** Writes each default that doesn't exist yet. Returns what it wrote. */
export function seedDefaults(home: Home): string[] {
  const wrote: string[] = [];
  for (const p of DEFAULT_PROFILES) {
    if (existsSync(home.profile(p.id))) continue;
    writeJsonAtomic(home.profile(p.id), p);
    wrote.push(`profile ${p.id}`);
  }
  for (const w of DEFAULT_WORKFLOWS) {
    if (existsSync(home.workflow(w.id))) continue;
    writeJsonAtomic(home.workflow(w.id), w);
    wrote.push(`workflow ${w.id}`);
  }
  return wrote;
}
