// A scratch Collie execution for CLI tests: COLLIE_HOME with one run and execution, a task
// brief, an execution.json, and a git worktree on branch pay-102-api based on main.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI_SRC = join(import.meta.dir, "../bin/collie");
export const RUN_ID = "01JC8YQ0P4E2W7H5S8D3F6G9KB";
export const EXEC_ID = "01JC8Z1A9C4V6B2N8M5X7Z3QWE";

/** Fixed author, committer and dates, so commit shas are the same on every run. */
export const GIT_ENV = {
  GIT_AUTHOR_NAME: "Collie Test",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "Collie Test",
  GIT_COMMITTER_EMAIL: "agent@example.com",
  GIT_AUTHOR_DATE: "2026-11-08T10:00:00Z",
  GIT_COMMITTER_DATE: "2026-11-08T10:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

export type Scratch = {
  root: string;
  home: string;
  execDir: string;
  inbox: string;
  worktree: string;
  env: Record<string, string>;
  cleanup: () => void;
};

export function scratchExecution(role: "developer" | "reviewer" | "analyst" = "developer"): Scratch {
  const root = mkdtempSync(join(tmpdir(), "collie-cli-"));
  const home = join(root, "home");
  const execDir = join(home, "runs", RUN_ID, "executions", EXEC_ID);
  const worktree = join(root, "worktree");
  mkdirSync(execDir, { recursive: true });
  mkdirSync(worktree);
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", ...args], { cwd: worktree, env: { ...process.env, ...GIT_ENV } });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(worktree, "README.md"), "payments\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  git("checkout", "-q", "-b", "pay-102-api");
  writeFileSync(
    join(execDir, "task.md"),
    "# PAY-102 · Payment API endpoints\n\nYou are the Developer on PAY-102.\n",
  );
  writeFileSync(
    join(execDir, "execution.json"),
    JSON.stringify({
      v: 1,
      id: EXEC_ID,
      run_id: RUN_ID,
      ticket: "PAY-102",
      profile: role,
      role,
      kind: role === "reviewer" ? "review" : "develop",
      round: 1,
      attempt: 1,
      worktree,
      branch: "pay-102-api",
      base: "main",
      terminal: "t18",
      created_at: "2026-11-08T10:19:00Z",
    }),
  );
  const inbox = join(execDir, "inbox.jsonl");
  const env = {
    ...(process.env as Record<string, string>),
    ...GIT_ENV,
    COLLIE_HOME: home,
    COLLIE_INBOX: inbox,
    COLLIE_RUN_ID: RUN_ID,
    COLLIE_EXECUTION_ID: EXEC_ID,
    COLLIE_TICKET: "PAY-102",
    COLLIE_ROLE: role,
  };
  return {
    root,
    home,
    execDir,
    inbox,
    worktree,
    env,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function collie(
  bin: string,
  args: string[],
  env: Record<string, string>,
  opts: { cwd?: string; stdin?: string } = {},
) {
  const p = Bun.spawnSync([bin, ...args], {
    env,
    cwd: opts.cwd,
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
  });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** Inbox lines with id and ts replaced, for comparing against an expected fixture. */
export function normalizeInbox(text: string): unknown[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ ...JSON.parse(l), id: "<id>", ts: "<ts>" }));
}
