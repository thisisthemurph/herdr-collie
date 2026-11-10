// Phase 7: retention (docs/protocol.md, "Retention") against real git with a local bare repository
// as the remote, a fake code host, and tools/fake-hc.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CodeHost, NewPr, PrInfo } from "../src/bitbucket.ts";
import { GitRemote } from "../src/remote.ts";
import { Retention } from "../src/retention.ts";
import { git, type Harness, harness, readEvents, ready, WORKING } from "./agent-helpers.ts";
import { command, ok } from "./helpers.ts";

setDefaultTimeout(120_000);
const DAY = 86_400_000;
let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

class FakeHost implements CodeHost {
  prs: PrInfo[] = [];
  async checkAccess() {}
  async findOpenPr(_r: unknown, source: string) {
    return this.prs.find((p) => p.source === source && p.state === "OPEN") ?? null;
  }
  async createPr(_r: unknown, pr: NewPr) {
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
  pr(n: number) {
    const p = this.prs.find((x) => x.number === n);
    if (!p) throw new Error(`no PR ${n}`);
    return p;
  }
  async getPr(_r: unknown, n: number) {
    return { ...this.pr(n) };
  }
  async updatePr(_r: unknown, n: number, c: { destination?: string; draft?: boolean }) {
    Object.assign(this.pr(n), c);
    return { ...this.pr(n) };
  }
}

let bare = "";
const remote = () => new GitRemote({ url: () => bare, helper: null });
const killed: string[] = [];
const retention = () =>
  new Retention(h.c, {
    remote: remote(),
    hc: {
      get: async (t: string) => ({ terminal: t }) as never,
      kill: async (t: string) => {
        killed.push(t);
      },
    },
  });

function setup(host: FakeHost, tickets = ["PAY-101", "PAY-102"]) {
  h = harness({
    tickets,
    agents: Array.from({ length: 9 }, () => WORKING),
    delivery: { host, remote: remote(), jira: null, skipGitCheck: false },
  });
  bare = join(dirname(h.worktrees), "remote.git");
  git(h.repo, "init", "--bare", "-q", bare);
  git(h.repo, "push", "-q", bare, "main");
  killed.length = 0;
}

const worktreeOf = (runId: string, key: string) =>
  join(h.worktrees, "scratch", h.state(runId).tickets[key]?.branch as string);

/** Runs every ticket to an open PR and waits for the run to end. Returns the run id. */
async function deliver(keys: string[]): Promise<string> {
  await ready(h);
  const runId = await h.startRun();
  for (const key of keys) {
    await h.settle(() => h.execs(runId, key, "develop")[0]?.state === "working", `${key} to work`);
    h.finish(runId, key);
  }
  await h.settle(() => !h.c.runs.has(runId), "the run to end");
  return runId;
}

const types = (runId: string, type: string) => readEvents(h.s.home, runId).filter((e) => e.type === type);

describe("worktrees", () => {
  test("kept while the PR is open (logged once), removed after it merges, never with unpushed work", async () => {
    const host = new FakeHost();
    setup(host);
    const runId = await deliver(["PAY-101", "PAY-102"]);
    const [w1, w2] = [worktreeOf(runId, "PAY-101"), worktreeOf(runId, "PAY-102")];
    expect(existsSync(w1)).toBe(true);

    const first = await retention().pass();
    expect(first.removed).toEqual([]);
    expect(first.kept.map((k) => k.reason)).toEqual(["its PR is still open", "its PR is still open"]);
    // The same pass again doesn't log the same reason again.
    const r = retention();
    await r.pass();
    await r.pass();
    expect(types(runId, "worktree.kept").length).toBe(4); // two passes by two instances, two worktrees each

    // PAY-101 merges; PAY-102 also does, but has work the remote hasn't seen.
    host.pr(1).state = "MERGED";
    host.pr(2).state = "MERGED";
    await h.settle(
      () =>
        h.state(runId).tickets["PAY-101"]?.pr?.state === "MERGED" &&
        h.state(runId).tickets["PAY-102"]?.pr?.state === "MERGED",
      "both PRs to merge",
    );
    writeFileSync(join(w2, "extra.txt"), "work not pushed\n");
    const dirty = await retention().pass();
    expect(dirty.removed).toEqual([w1]);
    expect(dirty.kept).toEqual([{ worktree: w2, reason: "it has uncommitted changes" }]);
    expect(existsSync(w1)).toBe(false);
    expect(existsSync(w2)).toBe(true);

    git(w2, "add", "-A");
    git(w2, "commit", "-q", "-m", "unpushed");
    const unpushed = await retention().pass();
    expect(unpushed.removed).toEqual([]);
    expect(unpushed.kept[0]?.reason).toBe("it has commits that aren't on the remote branch");
    expect(existsSync(w2)).toBe(true);
    expect(types(runId, "worktree.removed").map((e) => e.payload)).toEqual([{ worktree: w1 }]);
  });

  test("a cancelled ticket's worktree stays 7 days, then goes if its work is on the remote", async () => {
    const host = new FakeHost();
    setup(host, ["PAY-101"]);
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => h.execs(runId, "PAY-101", "develop")[0]?.state === "working", "the developer");
    const w = worktreeOf(runId, "PAY-101");
    ok(await command(h.c, "run.cancel", { run_id: runId }));
    await h.settle(() => !h.c.runs.has(runId), "the run to end");

    h.clock.advance(6 * DAY);
    const early = await retention().pass();
    expect(early.removed).toEqual([]);
    expect(early.kept[0]?.reason).toContain("kept 7 days");
    h.clock.advance(2 * DAY);
    const late = await retention().pass();
    expect(late.removed).toEqual([w]);
    expect(existsSync(w)).toBe(false);
  });

  test("a ticket that is still active keeps its worktree without a word", async () => {
    const host = new FakeHost();
    setup(host, ["PAY-101"]);
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => h.execs(runId, "PAY-101", "develop")[0]?.state === "working", "the developer");
    h.clock.advance(30 * DAY);
    const r = await retention().pass();
    expect(r).toMatchObject({ removed: [], kept: [], pruned: [] });
    expect(types(runId, "worktree.kept")).toEqual([]);
  });
});

describe("inboxes and attachments", () => {
  test("90 days after the run ends they go, logged once; events and state stay", async () => {
    const host = new FakeHost();
    setup(host, ["PAY-101"]);
    const runId = await deliver(["PAY-101"]);
    const execId = h.execs(runId, "PAY-101", "develop")[0]?.id as string;
    const inbox = h.s.home.inbox(runId, execId);
    writeFileSync(join(h.s.home.execDir(runId, execId), "attachments.keep"), "");
    expect(existsSync(inbox)).toBe(true);

    h.clock.advance(89 * DAY);
    expect((await retention().pass()).pruned).toEqual([]);
    h.clock.advance(2 * DAY);
    const pass = await retention().pass();
    expect(pass.pruned).toEqual([`executions/${execId}/inbox.jsonl`]);
    expect(existsSync(inbox)).toBe(false);
    expect(types(runId, "retention.pruned").length).toBe(1);
    expect(types(runId, "retention.pruned")[0]?.payload).toEqual({
      paths: [`executions/${execId}/inbox.jsonl`],
    });
    expect(existsSync(h.s.home.executionFile(runId, execId))).toBe(true);
    expect(existsSync(h.s.home.taskFile(runId, execId))).toBe(true);
    // Nothing left to prune, nothing more logged.
    expect((await retention().pass()).pruned).toEqual([]);
    expect(types(runId, "retention.pruned").length).toBe(1);
  });
});

describe("terminals", () => {
  test("a finished ticket's terminals are closed; a live ticket's are not", async () => {
    const host = new FakeHost();
    setup(host, ["PAY-101"]);
    const runId = await deliver(["PAY-101"]);
    const terminals = Object.values(h.state(runId).executions).map((e) => e.terminal);
    const report = await retention().pass();
    expect(report.terminals.sort()).toEqual(terminals.filter(Boolean).sort() as string[]);
    expect(killed.sort()).toEqual(report.terminals.sort());
  });
});

describe("run.delete", () => {
  test("refused while a PR is open, allowed once it has merged; the whole run folder goes", async () => {
    const host = new FakeHost();
    setup(host, ["PAY-101"]);
    const runId = await deliver(["PAY-101"]);
    const refused = await command(h.c, "run.delete", { run_id: runId });
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(existsSync(h.s.home.runDir(runId))).toBe(true);

    host.pr(1).state = "MERGED";
    await h.settle(() => h.state(runId).tickets["PAY-101"]?.pr?.state === "MERGED", "the merge");
    // The tracked run is released a tick later; the command works on what is on disk.
    await h.settle(() => !h.c.tracked.has(runId), "the run to be released");
    ok(await command(h.c, "run.delete", { run_id: runId }));
    expect(existsSync(h.s.home.runDir(runId))).toBe(false);
  });

  test("refused while the run is running", async () => {
    const host = new FakeHost();
    setup(host, ["PAY-101"]);
    await ready(h);
    const runId = await h.startRun();
    const r = await command(h.c, "run.delete", { run_id: runId });
    expect(r).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });
});
