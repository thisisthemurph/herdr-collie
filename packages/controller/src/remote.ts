// Git against the code host's remote (docs/plan.md, Phase 6; docs/spike.md, experiment 5b):
// push a ticket's branch, fetch a destination branch, and the local merge check that stands in
// for Bitbucket's missing conflict state.
//
// The token never reaches git as an argument, an environment variable or a saved remote. git is
// given an inline credential helper that reads the keychain when git asks for a password, and
// the push URL is plain `https://bitbucket.org/<workspace>/<slug>.git`. The empty first
// `credential.helper=` stops any configured helper (osxkeychain) from remembering the token.

import type { Repo } from "./bitbucket.ts";
import { BITBUCKET_SERVICE } from "./credentials.ts";
import { type GitResult, git } from "./git.ts";

export interface Remote {
  /** Pushes `branch` to the host. Throws an Error whose message says why it failed. */
  push(repoPath: string, repo: Repo, branch: string): Promise<void>;
  /** Fetches `branch` of the host into `refs/collie/dest/<branch>` and returns that ref. */
  fetchBranch(repoPath: string, repo: Repo, branch: string): Promise<string>;
}

/** The credential helper: a shell function that prints the user and, from the keychain, the token. */
export const KEYCHAIN_HELPER = `!f() { echo username=x-token-auth; echo "password=$(security find-generic-password -s ${BITBUCKET_SERVICE} -w)"; }; f`;

export const httpsUrl = (repo: Repo) => `https://bitbucket.org/${repo.workspace}/${repo.slug}.git`;

export const destRef = (branch: string) => `refs/collie/dest/${branch}`;

export class GitRemote implements Remote {
  /**
   * `url` and `helper` are what tests change: a local bare repository as the remote, and no
   * helper. The defaults are the real thing.
   */
  constructor(private readonly o: { url?: (repo: Repo) => string; helper?: string | null } = {}) {}

  private args(rest: string[]): string[] {
    const helper = this.o.helper === undefined ? KEYCHAIN_HELPER : this.o.helper;
    return [...(helper ? ["-c", "credential.helper=", "-c", `credential.helper=${helper}`] : []), ...rest];
  }

  private url(repo: Repo) {
    return (this.o.url ?? httpsUrl)(repo);
  }

  async push(repoPath: string, repo: Repo, branch: string): Promise<void> {
    const r = await git(
      repoPath,
      this.args(["push", this.url(repo), `refs/heads/${branch}:refs/heads/${branch}`]),
    );
    if (r.code !== 0) throw new Error(`git push of ${branch} failed: ${firstLines(r)}`);
  }

  async fetchBranch(repoPath: string, repo: Repo, branch: string): Promise<string> {
    const ref = destRef(branch);
    const r = await git(
      repoPath,
      this.args(["fetch", "--no-tags", this.url(repo), `+refs/heads/${branch}:${ref}`]),
    );
    if (r.code !== 0) throw new Error(`git fetch of ${branch} failed: ${firstLines(r)}`);
    return ref;
  }
}

const firstLines = (r: GitResult) => (r.stderr || r.stdout).split("\n").slice(0, 3).join(" ").slice(0, 300);

/** `git merge-tree --write-tree` needs git 2.38. Returns a reason when the installed git is older. */
export async function checkGitVersion(): Promise<string | null> {
  const r = await git(process.cwd(), ["--version"]);
  const m = r.stdout.match(/(\d+)\.(\d+)/);
  if (r.code !== 0 || !m) return "couldn't run git --version";
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 2 || (major === 2 && minor >= 38)
    ? null
    : `git ${major}.${minor} is too old: Collie checks PRs for conflicts with git merge-tree --write-tree, which needs git 2.38 or later`;
}

/** Whether merging `source` into `dest` conflicts, with the conflicting paths. No checkout needed. */
export async function mergeConflicts(
  repoPath: string,
  dest: string,
  source: string,
): Promise<{ conflicted: boolean; paths: string[] }> {
  const r = await git(repoPath, ["merge-tree", "--write-tree", "--name-only", dest, source]);
  if (r.code === 0) return { conflicted: false, paths: [] };
  if (r.code !== 1) throw new Error(`git merge-tree failed: ${firstLines(r)}`);
  // Line 1 is the tree; then the conflicted file names up to a blank line; then messages.
  const [, ...rest] = r.stdout.split("\n");
  const paths: string[] = [];
  for (const line of rest) {
    if (!line.trim()) break;
    paths.push(line.trim());
  }
  return { conflicted: true, paths };
}

/** Whether `ancestor` is in the history of `ref`. */
export async function isAncestor(repoPath: string, ancestor: string, ref: string): Promise<boolean> {
  return (await git(repoPath, ["merge-base", "--is-ancestor", ancestor, ref])).code === 0;
}
