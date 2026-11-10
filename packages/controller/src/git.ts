// Git for agent worktrees: one worktree per ticket, under Herdr's convention
// ~/.herdr/worktrees/<repo>/<branch> (docs/plan.md, Phase 4), and the checks on a developer's `done`.
// Local git only: nothing here touches a remote.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type GitResult = { code: number; stdout: string; stderr: string };

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export function gitSync(cwd: string, args: string[]): GitResult {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    stdin: "ignore",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString().trim(), stderr: p.stderr.toString().trim() };
}

export const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

/** DECISION: the branch is the lower-cased ticket key plus a short slug of its summary. */
export function branchName(key: string, summary: string): string {
  const slug = summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug ? `${key.toLowerCase()}-${slug}` : key.toLowerCase();
}

export class WorktreeError extends Error {}

/**
 * The worktree for a ticket's branch, created if it isn't there. Safe to call again (a retry,
 * or a second run on the same ticket reuses the branch and the work on it).
 *   - the folder already holds a worktree on `branch`: reused;
 *   - `branch` exists: checked out in a new worktree;
 *   - otherwise a new `branch` is cut from `base` (a local branch of the repo).
 * `merge` lists other branches to merge in: a ticket with several finished blockers starts from
 * the first and merges the rest (DECISION: Phase 4 supports that with a plain merge).
 */
export async function ensureWorktree(o: {
  repo: string;
  path: string;
  branch: string;
  base: string;
  merge?: string[];
}): Promise<{ created: boolean }> {
  if (!existsSync(o.repo) || (await git(o.repo, ["rev-parse", "--git-dir"])).code !== 0) {
    throw new WorktreeError(`${o.repo} is not a git repository; check the board's repo local_path`);
  }
  if (existsSync(o.path)) {
    const head = await git(o.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head.code === 0 && head.stdout === o.branch) return { created: false };
    throw new WorktreeError(`${o.path} exists but is not a worktree on ${o.branch}; move it away and retry`);
  }
  const exists =
    (await git(o.repo, ["show-ref", "--verify", "--quiet", `refs/heads/${o.branch}`])).code === 0;
  const args = exists
    ? ["worktree", "add", o.path, o.branch]
    : ["worktree", "add", "-b", o.branch, o.path, o.base];
  const r = await git(o.repo, args);
  if (r.code !== 0) throw new WorktreeError(`git ${args.slice(0, 3).join(" ")} failed: ${r.stderr}`);
  if (!exists) {
    for (const other of o.merge ?? []) {
      const m = await git(o.path, ["merge", "--no-edit", other]);
      if (m.code !== 0) {
        await git(o.path, ["merge", "--abort"]);
        throw new WorktreeError(
          `${o.branch} could not be started from ${o.base}: merging ${other} conflicts (${m.stderr || m.stdout})`,
        );
      }
    }
  }
  return { created: true };
}

/**
 * The controller's checks on a developer's `done` (protocol, "Agent events"): the listed commits
 * are on the ticket's branch, at least one is new since `base`, and the worktree is clean.
 * Returns the reason to reject it, or null. Run synchronously: it is part of judging an inbox line.
 */
export function verifyDeveloperDone(o: {
  worktree: string;
  base: string | null;
  commits: string[];
}): string | null {
  if (!existsSync(o.worktree)) return `the worktree ${o.worktree} no longer exists`;
  for (const c of o.commits) {
    const r = gitSync(o.worktree, ["merge-base", "--is-ancestor", c, "HEAD"]);
    if (r.code !== 0) return `commit ${c} is not on the ticket branch; commit your work on this branch first`;
  }
  if (o.base) {
    const n = gitSync(o.worktree, ["rev-list", "--count", `${o.base}..HEAD`]);
    if (n.code === 0 && Number(n.stdout) === 0) return `the branch has no commits beyond ${o.base}`;
  }
  const status = gitSync(o.worktree, ["status", "--porcelain"]);
  if (status.code === 0 && status.stdout) return "the worktree has uncommitted changes; commit them first";
  return null;
}

/**
 * A detached worktree at `ref` (a local branch), for the analyst, which only reads. A folder that
 * is already a worktree is moved to `ref` when it is clean, and otherwise left as it is.
 */
export async function ensureDetachedWorktree(o: { repo: string; path: string; ref: string }): Promise<void> {
  if (!existsSync(o.repo) || (await git(o.repo, ["rev-parse", "--git-dir"])).code !== 0) {
    throw new WorktreeError(`${o.repo} is not a git repository; check the board's repo local_path`);
  }
  if (existsSync(o.path)) {
    if ((await git(o.path, ["rev-parse", "--git-dir"])).code !== 0)
      throw new WorktreeError(`${o.path} exists but is not a worktree; move it away and retry`);
    if (!(await git(o.path, ["status", "--porcelain"])).stdout)
      await git(o.path, ["checkout", "--detach", o.ref]);
    return;
  }
  const r = await git(o.repo, ["worktree", "add", "--detach", o.path, o.ref]);
  if (r.code !== 0) throw new WorktreeError(`git worktree add --detach failed: ${r.stderr}`);
}
