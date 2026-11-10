// Phase 6: delivery (push, PRs, tracking, stacks, Jira) against a fake code host, real git with a
// local bare repository as the remote, and tools/fake-hc. No network, no Bitbucket, no Jira.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodeHost, NewPr, PrInfo } from "../src/bitbucket.ts";
import type { JiraTransition, JiraWriteback } from "../src/jira.ts";
import { GitRemote } from "../src/remote.ts";
import { git, type Harness, harness, readEvents, ready, WORKING } from "./agent-helpers.ts";
import { command, ok } from "./helpers.ts";

setDefaultTimeout(120_000);
let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

/** A code host that keeps its PRs in memory and records what it was asked. */
class FakeHost implements CodeHost {
  prs: PrInfo[] = [];
  calls: string[] = [];
  failCreate = 0;
  denyAccess: string | null = null;
  async checkAccess() {
    this.calls.push("checkAccess");
    if (this.denyAccess) throw new Error(this.denyAccess);
  }
  async findOpenPr(_r: unknown, source: string) {
    return this.prs.find((p) => p.source === source && p.state === "OPEN") ?? null;
  }
  async createPr(_r: unknown, pr: NewPr) {
    this.calls.push(`create ${pr.source} -> ${pr.destination}${pr.draft ? " (draft)" : ""}`);
    this.lastDescription = pr.description;
    if (this.failCreate > 0) {
      this.failCreate -= 1;
      throw new Error("Bitbucket returned HTTP 500");
    }
    const info: PrInfo = {
      number: this.prs.length + 1,
      url: `https://bitbucket.org/[WORKSPACE]/scratch/pull-requests/${this.prs.length + 1}`,
      state: "OPEN",
      draft: pr.draft,
      source: pr.source,
      destination: pr.destination,
      approvals: 0,
    };
    this.prs.push(info);
    return { ...info };
  }
  lastDescription = "";
  pr(n: number) {
    const p = this.prs.find((x) => x.number === n);
    if (!p) throw new Error(`no PR ${n}`);
    return p;
  }
  async getPr(_r: unknown, n: number) {
    return { ...this.pr(n) };
  }
  async updatePr(_r: unknown, n: number, c: { destination?: string; draft?: boolean }) {
    this.calls.push(`update ${n} ${JSON.stringify(c)}`);
    Object.assign(this.pr(n), c);
    return { ...this.pr(n) };
  }
}

let bare = "";
const remote = () => new GitRemote({ url: () => bare, helper: null });

/** A bare repository standing in for Bitbucket, holding `main`. */
function makeRemote() {
  bare = join(dirname(h.worktrees), "remote.git");
  git(h.repo, "init", "--bare", "-q", bare);
  git(h.repo, "push", "-q", bare, "main");
}

const TWO = { PAY: [] };
void TWO;

/** Plays the developer of `key` finishing, once it is working. */
async function develop(runId: string, key: string) {
  await h.settle(() => h.execs(runId, key, "develop")[0]?.state === "working", `${key}'s developer to work`);
  h.finish(runId, key);
}
const prOf = (runId: string, key: string) => h.state(runId).tickets[key]?.pr;
const withPr = (runId: string, key: string) => () => !!prOf(runId, key);

function setup(host: FakeHost, o: Parameters<typeof harness>[0] = {}, jira?: JiraWriteback) {
  h = harness({
    tickets: ["PAY-101", "PAY-102", "PAY-103"],
    blocked_by: { "PAY-102": ["PAY-101"] },
    agents: Array.from({ length: 9 }, () => WORKING),
    delivery: { host, remote: remote(), jira: jira ?? null, skipGitCheck: false },
    ...o,
  });
}

describe("opening PRs", () => {
  test("two dependent tickets give stacked PRs with the right destinations; an independent one targets the default branch", async () => {
    const host = new FakeHost();
    setup(host);
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(withPr(runId, "PAY-101"), "PAY-101's PR");
    await develop(runId, "PAY-102");
    await develop(runId, "PAY-103");
    await h.settle(() => !h.c.runs.has(runId), "the run to end");

    const st0 = h.state(runId);
    const b = (k: string) => st0.tickets[k]?.branch as string;
    expect(host.calls.filter((c) => c.startsWith("create")).sort()).toEqual(
      [
        `create ${b("PAY-101")} -> main`,
        `create ${b("PAY-102")} -> ${b("PAY-101")} (draft)`,
        `create ${b("PAY-103")} -> main`,
      ].sort(),
    );
    const st = h.state(runId);
    expect(st.tickets["PAY-102"]?.pr).toMatchObject({
      destination: st.tickets["PAY-101"]?.branch,
      draft: true,
    });
    expect(st.tickets["PAY-101"]?.pr).toMatchObject({ destination: "main", draft: false });
    expect(Object.values(st.tickets).every((t) => t.state === "completed")).toBe(true);
    // The branches were pushed to the remote, and nothing was saved in the repository's config.
    const branches = git(bare, "branch", "--list")
      .split("\n")
      .map((l) => l.trim().replace("* ", ""));
    expect(branches).toEqual(
      expect.arrayContaining([
        "main",
        ...["PAY-101", "PAY-102", "PAY-103"].map((k) => st.tickets[k]?.branch as string),
      ]),
    );
    expect(readFileSync(join(h.repo, ".git", "config"), "utf8")).not.toContain("remote.git");
    // The PR description links the ticket.
    expect(host.lastDescription).toContain("/browse/PAY-");
  });

  test("always draft opens every PR as a draft", async () => {
    const host = new FakeHost();
    setup(host, {
      settings: { pr_draft_policy: "always_draft" },
      tickets: ["PAY-101", "PAY-102"],
      blocked_by: { "PAY-102": ["PAY-101"] },
    });
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(withPr(runId, "PAY-101"), "the first PR");
    await develop(runId, "PAY-102");
    await h.settle(withPr(runId, "PAY-102"), "the second PR");
    expect(host.prs.map((p) => p.draft)).toEqual([true, true]);
  });

  test("a failing delivery is retried, then holds the ticket with delivery_error until ticket.retry", async () => {
    const host = new FakeHost();
    host.failCreate = 3;
    setup(host, { tickets: ["PAY-101"], blocked_by: {} });
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(() => h.state(runId).tickets["PAY-101"]?.state === "needs_input", "the ticket to be held");
    const t = h.state(runId).tickets["PAY-101"];
    expect(t?.attention).toEqual([{ kind: "delivery_error" }]);
    const failures = readEvents(h.s.home, runId).filter((e) => e.type === "delivery.failed");
    expect(failures.map((e) => (e.payload as { final: boolean }).final)).toEqual([false, false, true]);
    expect(failures[2]?.payload).toMatchObject({
      step: "pr",
      attempt: 3,
      reason: "Bitbucket returned HTTP 500",
    });

    ok(await command(h.c, "ticket.retry", { run_id: runId, ticket: "PAY-101" }));
    await h.settle(() => !h.c.runs.has(runId), "the run to end after the retry");
    expect(h.state(runId).tickets["PAY-101"]).toMatchObject({ state: "completed", attention: [] });
    expect(host.prs).toHaveLength(1);
  });

  test("run.start refuses before any agent starts when the token check fails", async () => {
    const host = new FakeHost();
    host.denyAccess = "the collie-bitbucket token lacks the pullrequest:write scope";
    setup(host, { tickets: ["PAY-101"], blocked_by: {} });
    await ready(h);
    const r = await command(h.c, "run.start", { board_id: "01JC8XW0000000000000000001" });
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringContaining("pullrequest:write") } });
    expect(h.calls().filter((c) => c.argv[0] === "run")).toHaveLength(0);
  });
});

describe("completion levels", () => {
  test("merged: the ticket waits in delivering until its PR merges, and the dependent starts from the fetched default branch", async () => {
    const host = new FakeHost();
    setup(host, {
      settings: { complete_at: "merged" },
      tickets: ["PAY-101", "PAY-102"],
      blocked_by: { "PAY-102": ["PAY-101"] },
    });
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(withPr(runId, "PAY-101"), "the PR");
    expect(h.state(runId).tickets["PAY-101"]?.state).toBe("delivering");
    expect(h.execs(runId, "PAY-102")).toHaveLength(0);

    // The PR is merged on the host: the branch lands in the remote's main.
    const branch = h.state(runId).tickets["PAY-101"]?.branch as string;
    git(h.repo, "merge", "-q", "--no-edit", branch);
    git(h.repo, "push", "-q", bare, "main");
    git(h.repo, "reset", "-q", "--hard", "HEAD~1"); // the local main is behind the host's, as it would be
    host.pr(1).state = "MERGED";
    await h.settle(
      () => h.state(runId).tickets["PAY-101"]?.state === "completed",
      "the ticket to complete on merge",
    );
    await h.settle(() => h.execs(runId, "PAY-102")[0]?.state === "working", "the dependent to start");
    const exec = JSON.parse(
      readFileSync(h.s.home.executionFile(runId, h.execs(runId, "PAY-102")[0]?.id as string), "utf8"),
    );
    expect(exec.base).toBe("main");
    // Cut from the fetched main, so the merged work is there although the local main lacks it.
    expect(readFileSync(join(exec.worktree, "PAY-101.txt"), "utf8")).toContain("work on PAY-101");
  });

  test("pr_approved: waits for an approval", async () => {
    const host = new FakeHost();
    setup(host, { settings: { complete_at: "pr_approved" }, tickets: ["PAY-101"], blocked_by: {} });
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(withPr(runId, "PAY-101"), "the PR");
    expect(h.state(runId).tickets["PAY-101"]?.state).toBe("delivering");
    host.pr(1).approvals = 1;
    await h.settle(() => h.state(runId).tickets["PAY-101"]?.state === "completed", "completion on approval");
    expect(prOf(runId, "PAY-101")?.approvals).toBe(1);
  });

  test("implemented: the ticket completes at the gate and its PR is still opened before the run ends", async () => {
    const host = new FakeHost();
    setup(host, { settings: { complete_at: "implemented" }, tickets: ["PAY-101"], blocked_by: {} });
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(() => h.state(runId).tickets["PAY-101"]?.state === "completed", "completion");
    await h.settle(() => !h.c.runs.has(runId), "the run to end");
    expect(host.prs).toHaveLength(1);
    expect(prOf(runId, "PAY-101")).toMatchObject({ state: "OPEN" });
  });
});

describe("tracking after the run ends", () => {
  test("merging the parent retargets the child, flags it for rebase and marks it ready; a conflict is noticed", async () => {
    const host = new FakeHost();
    setup(host, { tickets: ["PAY-101", "PAY-102"], blocked_by: { "PAY-102": ["PAY-101"] } });
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(withPr(runId, "PAY-101"), "the first PR");
    await develop(runId, "PAY-102");
    await h.settle(() => !h.c.runs.has(runId), "the run to end");
    // The run is over but its open PRs are still tracked.
    expect(h.c.tracked.has(runId)).toBe(true);
    expect(prOf(runId, "PAY-102")).toMatchObject({ draft: true });

    // On the host the parent lands in main as a merge commit the child's branch doesn't have.
    git(
      h.repo,
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge PAY-101",
      h.state(runId).tickets["PAY-101"]?.branch as string,
    );
    git(h.repo, "push", "-q", bare, "main");
    host.pr(1).state = "MERGED";
    await h.settle(
      () => prOf(runId, "PAY-102")?.destination === "main" && prOf(runId, "PAY-102")?.needs_rebase === true,
      "the child to be retargeted and flagged",
    );
    expect(prOf(runId, "PAY-102")).toMatchObject({ draft: false, needs_rebase: true, destination: "main" });
    // Once the child has main's head in its history again (rebased or merged by hand), the flag clears.
    const child = h.state(runId).tickets["PAY-102"]?.branch as string;
    git(join(h.worktrees, "scratch", child), "merge", "-q", "--no-edit", "main");
    await h.settle(() => prOf(runId, "PAY-102")?.needs_rebase === false, "the rebase flag to clear");
    expect(host.calls).toContain('update 2 {"destination":"main","draft":false}');
    expect(prOf(runId, "PAY-101")?.state).toBe("MERGED");
    // Restarting the controller picks the tracked run up again.
    const c2 = h.restart();
    expect(c2.tracked.has(runId)).toBe(true);
    host.pr(2).state = "MERGED";
    await h.settle(() => !h.c.tracked.has(runId), "tracking to stop");
    expect(readEvents(h.s.home, runId).some((e) => e.type === "pr.updated")).toBe(true);
  });

  test("a PR that conflicts with its destination is reported, with the paths", async () => {
    const host = new FakeHost();
    setup(host, { tickets: ["PAY-101"], blocked_by: {} });
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(withPr(runId, "PAY-101"), "the PR");
    await h.settle(() => prOf(runId, "PAY-101")?.conflict_checked_at != null, "the first conflict check");
    expect(prOf(runId, "PAY-101")?.conflicted).toBe(false);
    // Main moves on the host with a different PAY-101.txt: an add/add conflict.
    git(h.repo, "checkout", "-q", "-b", "other", "main");
    require("node:fs").writeFileSync(join(h.repo, "PAY-101.txt"), "someone else\n");
    git(h.repo, "add", "-A");
    git(h.repo, "commit", "-q", "-m", "other");
    git(h.repo, "push", "-q", bare, "other:main");
    await h.settle(() => prOf(runId, "PAY-101")?.conflicted === true, "the conflict to be seen");
    const ev = readEvents(h.s.home, runId)
      .filter((e) => e.type === "pr.conflict_checked")
      .at(-1);
    expect(ev?.payload).toMatchObject({ conflicted: true, paths: ["PAY-101.txt"] });
  });

  test("Mark ready publishes a draft PR, also after the run has ended", async () => {
    const host = new FakeHost();
    setup(host, { settings: { pr_draft_policy: "always_draft" }, tickets: ["PAY-101"], blocked_by: {} });
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(() => !h.c.runs.has(runId), "the run to end");
    expect(prOf(runId, "PAY-101")?.draft).toBe(true);
    ok(await command(h.c, "pr.mark_ready", { run_id: runId, ticket: "PAY-101" }));
    expect(host.pr(1).draft).toBe(false);
    expect(prOf(runId, "PAY-101")?.draft).toBe(false);
    expect(await command(h.c, "pr.mark_ready", { run_id: runId, ticket: "PAY-101" })).toMatchObject({
      ok: false,
      error: { code: "invalid_state", message: expect.stringContaining("already ready") },
    });
  });
});

describe("Jira write-back", () => {
  class FakeJira implements JiraWriteback {
    done: string[] = [];
    available: JiraTransition[] = [
      { id: "11", name: "Start progress", to: "In Progress" },
      { id: "12", name: "Request review", to: "In Review" },
    ];
    async transitions() {
      return this.available;
    }
    async transition(_c: string, key: string, id: string) {
      this.done.push(`${key} transition ${id}`);
    }
    async comment(_c: string, key: string, text: string) {
      this.done.push(`${key} comment ${text}`);
    }
  }

  test("moves the issue on start and on PR, comments with the link, and does each once, even across a restart", async () => {
    const host = new FakeHost();
    const jira = new FakeJira();
    setup(host, { tickets: ["PAY-101"], blocked_by: {} }, jira);
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(
      () => (h.state(runId).tickets["PAY-101"]?.jira_steps ?? []).length === 2,
      "both write-backs",
    );
    expect(jira.done).toEqual([
      "PAY-101 transition 11",
      "PAY-101 transition 12",
      expect.stringContaining(
        "PAY-101 comment Herdr Collie opened pull request #1: https://bitbucket.org/[WORKSPACE]/scratch/pull-requests/1",
      ),
    ]);
    const updated = readEvents(h.s.home, runId)
      .filter((e) => e.type === "jira.updated")
      .map((e) => e.payload);
    expect(updated).toEqual([
      { transition: "In Progress", step: "start" },
      { transition: "In Review", comment: true, step: "pr" },
    ]);
    const before = jira.done.length;
    h.restart();
    for (let i = 0; i < 10; i++) {
      h.c.tick();
      await Bun.sleep(5);
    }
    expect(jira.done).toHaveLength(before);
  });

  test("a policy target the issue can't reach is logged as skipped with the available targets, and the ticket carries on", async () => {
    const host = new FakeHost();
    const jira = new FakeJira();
    jira.available = [{ id: "21", name: "Done", to: "Done" }];
    setup(host, { tickets: ["PAY-101"], blocked_by: {} }, jira);
    makeRemote();
    await ready(h);
    const runId = await h.startRun();
    await develop(runId, "PAY-101");
    await h.settle(() => !h.c.runs.has(runId), "the run to end");
    const skipped = readEvents(h.s.home, runId)
      .filter((e) => e.type === "jira.writeback_skipped")
      .map((e) => e.payload);
    expect(skipped).toEqual([
      { target: "In Progress", available: ["Done"], step: "start" },
      { target: "In Review", available: ["Done"], step: "pr" },
    ]);
    expect(h.state(runId).tickets["PAY-101"]?.state).toBe("completed");
  });
});
