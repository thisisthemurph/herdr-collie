// Local git checks for a developer's `done` (docs/protocol.md, "Checks before writing").
import { CliError, EXIT, invalid } from "./errors.ts";

function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString().trim() };
}

/** Refuses when the worktree has uncommitted or untracked (not ignored) files. */
export function requireClean(worktree: string, ticket: string): void {
  const s = git(worktree, ["status", "--porcelain"]);
  if (s.code !== 0) {
    throw new CliError(
      EXIT.env,
      `cannot read git status in ${worktree}: ${s.err}. Run collie from inside your worktree.`,
    );
  }
  const lines = s.out.split("\n").filter(Boolean);
  if (lines.length === 0) return;
  const shown = lines.slice(0, 10).map((l) => `  ${l}`);
  if (lines.length > 10) shown.push(`  ... and ${lines.length - 10} more`);
  throw invalid(
    `your worktree has uncommitted changes:\n${shown.join("\n")}\nCommit them (git add -A && git commit -m "${ticket}: ...") or remove them, then run collie done again.`,
  );
}

/** The commits on HEAD that aren't on `base`, oldest first. Refuses when there are none. */
export function commitsAhead(worktree: string, base: string): string[] {
  const exists = git(worktree, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (exists.code !== 0) {
    // DECISION: a missing base branch is the environment's fault, not the agent's call.
    throw new CliError(
      EXIT.env,
      `the base branch ${base} doesn't exist in ${worktree}. Report this with collie fail --category environment.`,
    );
  }
  const r = git(worktree, ["rev-list", "--reverse", `${base}..HEAD`]);
  if (r.code !== 0) throw new CliError(EXIT.env, `git rev-list failed in ${worktree}: ${r.err}`);
  const commits = r.out.split("\n").filter(Boolean);
  if (commits.length === 0) {
    throw invalid(
      `there are no commits on your branch ahead of ${base}. Commit your work, then run collie done again.`,
    );
  }
  return commits;
}
