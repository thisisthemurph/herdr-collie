// Phase 7: the MVP acceptance scenario (docs/plan.md, steps 1-23) as ONE ordered run through the
// real controller: fake hc (tools/fake-hc), agents and inbox lines played by the harness, Jira as
// recorded HTTP (fixtures/jira) plus a fake write-back, a fake code host for Bitbucket, real git
// with a local bare repository as the push remote. No network, no real Herdr.
//
// The tests below share one run and must run in order; a failure names its step. The same steps,
// by hand against real Herdr, Claude Code, Jira and Bitbucket, are in docs/manual-acceptance.md.
//
// Determinism: background delivery work races state changes. So nothing here holds an `rl.state`
// object across an await (`st()` reads a fresh one each time), and every wait is a `h.settle` on an
// explicit state condition, never a sleep.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { edges, layout } from "@collie/board";
import type { AnyEvent, Board, StateFile } from "@collie/schema";
import type { CodeHost, NewPr, PrInfo } from "../src/bitbucket.ts";
import { JiraClient, type JiraTransition, type JiraWriteback } from "../src/jira.ts";
import { rebuild } from "../src/reducer.ts";
import { GitRemote } from "../src/remote.ts";
import { type Agent, git, type Harness, harness, readEvents, ready, WORKING } from "./agent-helpers.ts";
import { command, FIXTURES, ok } from "./helpers.ts";

setDefaultTimeout(240_000);

// ---- fakes ----------------------------------------------------------------------------------

/** A code host keeping its PRs in memory (the same shape as in delivery.test.ts). */
class FakeHost implements CodeHost {
  prs: PrInfo[] = [];
  calls: string[] = [];
  async checkAccess() {
    this.calls.push("checkAccess");
  }
  async findOpenPr(_r: unknown, source: string) {
    return this.prs.find((p) => p.source === source && p.state === "OPEN") ?? null;
  }
  async createPr(_r: unknown, pr: NewPr) {
    this.calls.push(`create ${pr.source} -> ${pr.destination}${pr.draft ? " (draft)" : ""}`);
    const n = this.prs.length + 1;
    const info: PrInfo = {
      number: n,
      url: `https://bitbucket.org/[WORKSPACE]/[REPO]/pull-requests/${n}`,
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
    this.calls.push(`update ${n} ${JSON.stringify(c)}`);
    Object.assign(this.pr(n), c);
    return { ...this.pr(n) };
  }
}

/** Jira's write side: lists transitions, applies one, adds a comment. Records what it was asked. */
class FakeJira implements JiraWriteback {
  done: string[] = [];
  async transitions(): Promise<JiraTransition[]> {
    return [
      { id: "11", name: "Start progress", to: "In Progress" },
      { id: "12", name: "Request review", to: "In Review" },
    ];
  }
  async transition(_c: string, key: string, id: string) {
    this.done.push(`${key} transition ${id}`);
  }
  async comment(_c: string, key: string, text: string) {
    this.done.push(`${key} comment ${text}`);
  }
}

type Exchange = {
  request: { method: string; url: string; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
};

/** Plays back recorded Jira exchanges (fixtures/jira): each request matches one, once. */
class Playback {
  queue: Exchange[] = [];
  load(...names: string[]) {
    for (const n of names)
      this.queue.push(...JSON.parse(readFileSync(join(FIXTURES, `jira/${n}.json`), "utf8")).exchanges);
  }
  http = async (req: { method: string; url: string; body?: string }) => {
    const body = req.body === undefined ? null : JSON.parse(req.body);
    const i = this.queue.findIndex(
      (x) =>
        x.request.method === req.method &&
        x.request.url === req.url &&
        JSON.stringify(x.request.body) === JSON.stringify(body),
    );
    if (i === -1) throw new Error(`no recorded exchange for ${req.method} ${req.url} ${req.body ?? ""}`);
    const [x] = this.queue.splice(i, 1) as [Exchange];
    return { status: x.response.status, headers: x.response.headers, body: JSON.stringify(x.response.body) };
  };
}

// ---- scripted agents -------------------------------------------------------------------------

/** Ends its turn (idle) after a few polls, and takes a typed message back to work. */
const ASKER: Agent = {
  steps: [
    { on: "run", state: "idle", turn: 0 },
    { on: "get", state: "working", turn: 1 },
    { on: "get", state: "working", turn: 1 },
    { on: "get", state: "idle", turn: 1 },
    { on: "send", state: "working", turn: "+1" },
  ],
};
/** Ends its turn without ever reporting (state done), so it is nudged twice and then failed. */
const SILENT: Agent = {
  steps: [
    { on: "run", state: "idle", turn: 0 },
    { on: "get", state: "working", turn: 1 },
    { on: "get", state: "done", turn: 1 },
  ],
};
/** Agents are matched to a ticket by label, in the order they are launched for it. */
const forTicket = (key: string, ...agents: Agent[]): Agent[] =>
  agents.map((a) => ({ ...a, match: { labels: { "collie.ticket": key } } }));
const workers = (key: string, n: number) => forTicket(key, ...Array.from({ length: n }, () => WORKING));

// ---- state ------------------------------------------------------------------------------------

// Five imported tickets, plus TST-6: the blocker outside the board that step 4 pulls in. It is a
// real ticket in the run (a pulled-in blocker is delivered like any other).
const IMPORTED = ["TST-1", "TST-2", "TST-3", "TST-4", "TST-5"];
const KEYS = [...IMPORTED, "TST-6"];
const pb = new Playback();
const host = new FakeHost();
const jira = new FakeJira();
let h: Harness;
let bare = "";
let boardId = "";
let runId = "";
let clone = "";
let tst4Base = ""; // the blocker branch TST-4 is stacked on
const SECRET = "not-a-real-token";

const st = (): StateFile => h.state(runId);
const events = (): AnyEvent[] => readEvents(h.s.home, runId);
const tstate = (k: string) => st().tickets[k]?.state;
const prOf = (k: string) => st().tickets[k]?.pr;
const runCalls = () => h.calls().filter((c) => c.argv[0] === "run");
const sends = () => h.calls().filter((c) => c.argv[0] === "send");
const board = (): Board => JSON.parse(readFileSync(h.s.home.board(boardId), "utf8"));
const branchOf = (k: string) => st().tickets[k]?.branch as string;
const execFile = (execId: string) => JSON.parse(readFileSync(h.s.home.executionFile(runId, execId), "utf8"));
const lastExec = (k: string, kind: string) => h.execs(runId, k, kind).at(-1) as { id: string };
const working =
  (k: string, kind: string, round = 1, n = 1) =>
  () =>
    h.execs(runId, k, kind).filter((e) => e.round === round && e.state === "working").length >= n;
const withPr = (k: string) => () => !!prOf(k);
const jiraSteps = (k: string) => st().tickets[k]?.jira_steps ?? [];
const reviewerOf = (ticket: string, profile: string, round = 1) =>
  Object.entries(st().executions).find(
    ([, e]) => e.ticket === ticket && e.kind === "review" && e.profile === profile && e.round === round,
  )?.[0] as string;

/** A ticket's developer is working: commit a file and report done. Returns the commit. */
async function develop(k: string) {
  await h.settle(working(k, "develop"), `${k}'s developer to work`);
  return h.finish(runId, k);
}

/** Both required reviewers of round 1 approve. */
async function approveReviews(k: string) {
  await h.settle(working(k, "review", 1, 2), `${k}'s two reviewers to work`);
  for (const p of ["security-reviewer", "backend-reviewer"])
    h.report(runId, reviewerOf(k, p), "done", { summary: "ok", verdict: "approve" });
}

/** The host merges a PR: the source lands in the remote's main as a merge commit. */
function mergeOnHost(prNumber: number) {
  const p = (...a: string[]) => git(clone, ...a);
  p("fetch", "-q", "origin");
  p("checkout", "-q", "-B", "main", "origin/main");
  p("merge", "-q", "--no-ff", "-m", `merge PR ${prNumber}`, `origin/${host.pr(prNumber).source}`);
  p("push", "-q", "origin", "main");
  host.pr(prNumber).state = "MERGED";
}

/** Every file under a directory, as [path, text]; binary or unreadable files are skipped. */
function textFiles(dir: string): [string, string][] {
  const out: [string, string][] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const s = statSync(p);
      if (s.isDirectory()) out.push(...textFiles(p));
      else if (s.size < 5_000_000) out.push([p, readFileSync(p, "utf8")]);
    } catch {
      // a file that went away between listing and reading (a git lock): nothing to scan
    }
  }
  return out;
}

beforeAll(() => {
  h = harness({
    tickets: [],
    agents: [
      // TST-3: the analyst (asks, then finishes), then a developer that goes quiet, then its retry.
      ...forTicket("TST-3", ASKER, SILENT, WORKING, WORKING, WORKING, WORKING),
      ...workers("TST-6", 5),
      // TST-1: the developer (its first `done` is refused, so it idles and is told), two reviewers,
      // the remediation, the round 2 reviewer.
      ...forTicket("TST-1", ASKER, ASKER, ASKER, WORKING, WORKING, WORKING),
      ...workers("TST-2", 5),
      ...workers("TST-4", 5),
      ...workers("TST-5", 5),
    ],
    jira: new JiraClient(pb.http, { jira: async () => ({ email: "agent@example.com", token: SECRET }) }),
    delivery: {
      host,
      remote: new GitRemote({ url: () => bare, helper: null }),
      jira,
      skipGitCheck: false,
    },
  });
  // The Standard feature workflow: two required reviewers that run in parallel.
  const base = JSON.parse(readFileSync(h.s.home.profile("security-reviewer"), "utf8"));
  writeFileSync(
    h.s.home.profile("backend-reviewer"),
    JSON.stringify({ ...base, id: "backend-reviewer", name: "Backend reviewer" }),
  );
  writeFileSync(
    h.s.home.workflow("standard-feature"),
    JSON.stringify({
      v: 1,
      id: "standard-feature",
      name: "Standard feature",
      developer: "developer",
      reviewers: [
        { profile: "security-reviewer", required: true },
        { profile: "backend-reviewer", required: true },
      ],
      max_remediation_rounds: 2,
    }),
  );
  // The remote Bitbucket stands in for, and a clone of it where "the host" merges PRs.
  bare = join(dirname(h.worktrees), "remote.git");
  git(h.repo, "init", "--bare", "-q", bare);
  git(h.repo, "push", "-q", bare, "main");
  clone = mkdtempSync(join(tmpdir(), "collie-host-"));
  execFileSync("git", ["clone", "-q", bare, clone]);
  git(clone, "config", "user.email", "host@example.com");
  git(clone, "config", "user.name", "Host");
});

afterAll(async () => {
  await h?.cleanup();
});

// ---- Setup -----------------------------------------------------------------------------------

describe("MVP acceptance: setup", () => {
  test("step 1: a board is created, linked to the Jira project and the Bitbucket repository", async () => {
    await ready(h);
    pb.load("01-board-create", "02-import-five");
    boardId = ok(
      await command(h.c, "board.create", {
        name: "Collie test board",
        jira: { site: "[SITE].atlassian.net", project: "TST" },
        repo: {
          workspace: "[WORKSPACE]",
          slug: "[REPO]",
          default_branch: "main",
          local_path: h.repo,
        },
      }),
    ).board_id as string;
    expect(board().jira).toEqual({ site: "[SITE].atlassian.net", cloud_id: "[CLOUD-ID]", project: "TST" });
    expect(board().repo).toMatchObject({ workspace: "[WORKSPACE]", slug: "[REPO]", default_branch: "main" });
    // The run's settings: Standard feature, draft when stacked, complete at PR created.
    ok(
      await command(h.c, "board.update_settings", {
        board_id: boardId,
        settings: {
          workflow: "standard-feature",
          pr_draft_policy: "draft_when_stacked",
          complete_at: "pr_created",
        },
      }),
    );
    // DECISION: the token scope check runs at run.start (Phase 6), not at board creation, so it is
    // asserted in step 6 (the code host's checkAccess ran before any agent started).
    expect(board().settings).toMatchObject({
      workflow: "standard-feature",
      pr_draft_policy: "draft_when_stacked",
      complete_at: "pr_created",
    });
  });

  test("step 2: five tickets are imported by JQL", async () => {
    // DECISION: the recorded import is `key in (...)` JQL; a JQL import sends the same search.
    const r = ok(
      await command(h.c, "board.import", {
        board_id: boardId,
        jql: "key in (TST-1, TST-2, TST-3, TST-4, TST-5) ORDER BY key",
      }),
    );
    expect(r).toEqual({ added: IMPORTED, external: ["TST-6"] });
    expect(Object.keys(board().tickets).sort()).toEqual(KEYS);
  });

  test("step 3: the dependency graph includes one blocker that isn't on the board", () => {
    // Jira links: 1 blocks 2, 2 blocks 4, 3 blocks 4, X (TST-6) blocks 3, 4 blocks 5; a Relates link orders nothing.
    expect(edges(board()).map((e) => `${e.from}>${e.to}${e.external ? " (external)" : ""}`)).toEqual([
      "TST-1>TST-2",
      "TST-6>TST-3 (external)",
      "TST-2>TST-4",
      "TST-3>TST-4",
      "TST-4>TST-5",
    ]);
    expect(board().tickets["TST-6"]?.on_board).toBe(false);
    expect(
      layout(board())
        .nodes.map((n) => `${n.key}@${n.layer}`)
        .sort(),
    ).toEqual(["TST-1@0", "TST-2@1", "TST-3@1", "TST-4@2", "TST-5@3", "TST-6@0"]);
  });

  test("step 4: pulling in the outside blocker updates the graph and readiness", async () => {
    // The recorded pull-in (fixtures/jira/05) has TST-6 already Done, which would make it no blocker
    // at all. The scenario needs a blocker that still has to be delivered, so the recorded response
    // is replayed with TST-6's status and resolution from the earlier "To Do" refresh (03).
    pb.load("03-refresh-blocker-todo");
    const todo = (pb.queue[0] as Exchange).response.body as { issues: { key: string; fields: unknown }[] };
    const todoFields = todo.issues.find((i) => i.key === "TST-6")?.fields as { status: unknown };
    pb.load("05-pull-in");
    const pull = pb.queue.pop() as Exchange;
    const issue = (pull.response.body as { issues: { fields: Record<string, unknown> }[] }).issues[0];
    Object.assign(issue?.fields as object, { status: todoFields.status, resolution: null });
    pb.queue.push(pull);
    ok(await command(h.c, "board.refresh", { board_id: boardId }));
    expect(board().tickets["TST-6"]?.on_board).toBe(false);
    expect(ok(await command(h.c, "ticket.pull_in", { board_id: boardId, ticket: "TST-6" }))).toEqual({
      added: ["TST-6"],
      external: [],
    });
    expect(board().tickets["TST-6"]).toMatchObject({ on_board: true, jira_status: "To Do" });
    expect(edges(board()).every((e) => !e.external)).toBe(true);
    expect(edges(board())).toContainEqual(expect.objectContaining({ from: "TST-6", to: "TST-3" }));
    expect(pb.queue).toEqual([]);
  });

  test("step 5: the analyst marks one ticket Needs input with a question; the answer makes it Ready", async () => {
    // Everything but TST-3 is prepared by hand; the analyst investigates TST-3 only.
    for (const k of ["TST-1", "TST-2", "TST-4", "TST-5", "TST-6"])
      ok(
        await command(h.c, "ticket.set_preparation", { board_id: boardId, ticket: k, preparation: "ready" }),
      );
    const prep = () => h.c.preps.get(boardId);
    const prepOf = () => h.c.loadBoard(boardId).tickets["TST-3"]?.preparation;
    const analyst = () =>
      Object.entries(prep()?.state.executions ?? {}).at(-1) as [string, { state: string }];
    const reports = (execId: string, type: string, payload: Record<string, unknown>) =>
      require("node:fs").appendFileSync(
        `${h.s.home.prepExecDir(boardId, execId)}/inbox.jsonl`,
        `${JSON.stringify({ v: 1, id: require("@collie/schema").newUlid(), type, ts: new Date().toISOString(), source: "agent", run_id: null, execution_id: execId, ticket: "TST-3", caused_by: null, payload })}\n`,
      );

    ok(await command(h.c, "ticket.investigate", { board_id: boardId, tickets: ["TST-3"] }));
    expect(prepOf()).toBe("investigating");
    await h.settle(() => analyst()[1].state === "working", "the analyst to work");
    const execId = analyst()[0];
    reports(execId, "ask", { question: "Should refunds be partial?", options: ["yes", "no"] });
    await h.settle(() => prepOf() === "needs_input", "TST-3 to need input");
    const qid = Object.keys(prep()?.state.questions ?? {})[0] as string;
    expect(prep()?.state.questions[qid]).toMatchObject({ ticket: "TST-3", state: "open" });

    ok(
      await command(h.c, "question.answer", {
        run_id: boardId,
        question_id: qid,
        answer: "Yes, partial refunds.",
        share_with_ticket: true,
      }),
    );
    await h.settle(() => prep()?.state.questions[qid]?.state === "delivered", "the answer to be delivered");
    reports(execId, "done", { summary: "Scope: refunds endpoint." });
    await h.settle(() => prepOf() === "ready", "TST-3 to be ready");
    for (const k of KEYS) expect(board().tickets[k]?.preparation).toBe("ready");
    await h.c.agents?.drain();
  });
});

// ---- Execution -------------------------------------------------------------------------------

describe("MVP acceptance: execution", () => {
  test("step 6: Start run leases the tickets and snapshots the configuration", async () => {
    const before = runCalls().length;
    runId = ok(await command(h.c, "run.start", { board_id: boardId })).run_id as string;
    // The token scope check ran before any agent started.
    expect(host.calls[0]).toBe("checkAccess");
    expect(runCalls().length).toBe(before);
    expect([...st().leases].sort()).toEqual(expect.arrayContaining(KEYS));
    const run = JSON.parse(readFileSync(h.s.home.runFile(runId), "utf8"));
    expect(run.snapshot.settings).toMatchObject({
      workflow: "standard-feature",
      pr_draft_policy: "draft_when_stacked",
      complete_at: "pr_created",
    });
    expect(Object.keys(run.snapshot.workflows)).toContain("standard-feature");
    expect(Object.keys(run.snapshot.profiles)).toEqual(
      expect.arrayContaining(["developer", "security-reviewer", "backend-reviewer"]),
    );
    const types = events().map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types.filter((t) => t === "ticket.leased").length).toBeGreaterThanOrEqual(KEYS.length);
  });

  test("step 7: independent tickets start concurrently in their own worktrees and terminals; a ticket with an unfinished blocker stays Blocked", async () => {
    await h.settle(
      () =>
        ["TST-1", "TST-6"].every((k) => {
          const e = h.execs(runId, k, "develop")[0];
          return !!e && e.state !== "created";
        }),
      "both independent developers to start",
    );
    const e1 = lastExec("TST-1", "develop");
    const e3 = h.execs(runId, "TST-6", "develop")[0] as { id: string };
    const [f1, f3] = [execFile(e1.id), execFile(e3.id)];
    expect(f1.worktree).not.toBe(f3.worktree);
    expect(f1.terminal).not.toBe(f3.terminal);
    expect(f1.branch).not.toBe(f3.branch);
    expect(f1.base).toBe("main");
    for (const k of ["TST-2", "TST-3", "TST-4", "TST-5"]) {
      expect(tstate(k)).toBe("blocked");
      expect(h.execs(runId, k)).toHaveLength(0);
    }
  });

  test("step 8 (contract only; the sidebar and the live terminal need real Herdr): agents run in terminals labelled collie.*, and the state the mod reads is intact", () => {
    // The mod finds an agent's terminal from state.json and the collie.* labels on `hc run`. The
    // sidebar entry and "Watch terminal" are checked by hand (docs/manual-acceptance.md).
    for (const call of runCalls()) {
      const labels = call.argv.filter((a) => a.startsWith("collie.")).join(" ");
      expect(labels).toMatch(/collie\.execution=\w+/);
      expect(labels).toMatch(/collie\.ticket=(TST-\d|)/);
    }
    const some = runCalls().find((c) => c.argv.includes(`collie.run=${runId}`));
    expect(some).toBeDefined();
    h.c.flushAll();
    const fresh = JSON.parse(readFileSync(h.s.home.state(runId), "utf8"));
    expect(fresh).toEqual(st());
    const e1 = lastExec("TST-1", "develop");
    expect(fresh.executions[e1.id].terminal).toMatch(/^t\d+/);
  });

  test("step 9: a developer calling collie done with uncommitted changes is refused; it commits and reports again", async () => {
    await h.settle(working("TST-1", "develop"), "TST-1's developer to work");
    const dev = lastExec("TST-1", "develop");
    const wt = execFile(dev.id).worktree as string;
    writeFileSync(join(wt, "TST-1-a.txt"), "first part\n");
    git(wt, "add", "TST-1-a.txt");
    git(wt, "commit", "-q", "-m", "TST-1: first part");
    const sha = git(wt, "rev-parse", "HEAD");
    writeFileSync(join(wt, "TST-1-b.txt"), "forgotten\n"); // left uncommitted
    h.report(runId, dev.id, "done", { summary: "all done", commits: [sha] });
    await h.settle(
      () => events().some((e) => e.type === "agent.event_rejected" && e.execution_id === dev.id),
      "the done to be refused",
    );
    const rejected = events().find((e) => e.type === "agent.event_rejected" && e.execution_id === dev.id);
    expect(rejected?.payload).toMatchObject({ reason: expect.stringContaining("uncommitted changes") });
    expect(tstate("TST-1")).toBe("in_progress");
    // The agent is told why once its turn has ended.
    await h.settle(
      () => sends().some((c) => c.argv.join(" ").includes("Your `done` was rejected")),
      "the agent to be told",
    );
    expect(sends().find((c) => c.argv.join(" ").includes("rejected"))?.from).toBeNull();
    // It commits and reports again; the done is accepted and the ticket goes to review.
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "TST-1: the rest");
    h.report(runId, dev.id, "done", { summary: "all done now", commits: [git(wt, "rev-parse", "HEAD")] });
    await h.settle(() => tstate("TST-1") === "reviewing", "TST-1 to be reviewed");
  });

  test("step 10: the finished developer triggers the workflow's reviewers in parallel", async () => {
    await h.settle(working("TST-1", "review", 1, 2), "both reviewers to work at once");
    const revs = h.execs(runId, "TST-1", "review").filter((e) => e.round === 1);
    expect(revs).toHaveLength(2);
    expect(revs.map((r) => st().executions[r.id]?.profile).sort()).toEqual([
      "backend-reviewer",
      "security-reviewer",
    ]);
    // Read-only, in the developer's worktree.
    const dev = execFile(lastExec("TST-1", "develop").id);
    for (const r of revs) expect(execFile(r.id)).toMatchObject({ role: "reviewer", worktree: dev.worktree });
  });

  test("step 11: a reviewer asks a question; the ticket moves to Needs input and the mod has what it needs to notify", async () => {
    // Herdr's notification is raised by the mod from state.json (`alerts()` in the mod's tests); here
    // the controller-side contract: an open question and a `question` attention entry on the ticket.
    h.report(runId, reviewerOf("TST-1", "backend-reviewer"), "done", { summary: "ok", verdict: "approve" });
    h.report(runId, reviewerOf("TST-1", "security-reviewer"), "ask", {
      question: "Is the old endpoint still public?",
      options: ["yes", "no"],
    });
    await h.settle(() => tstate("TST-1") === "needs_input", "TST-1 to need input");
    const qid = Object.keys(st().questions)[0] as string;
    expect(st().questions[qid]).toMatchObject({ state: "open", ticket: "TST-1" });
    expect(st().tickets["TST-1"]).toMatchObject({
      resume_state: "reviewing",
      attention: [{ kind: "question", id: qid }],
    });
  });

  test("step 12: the answer is delivered when the agent is idle, and it continues", async () => {
    const qid = Object.keys(st().questions)[0] as string;
    const answers = () =>
      sends().filter((c) => c.argv.join(" ").includes(`Answer to your question ${qid.slice(-6)}`));
    expect(answers()).toHaveLength(0);
    ok(
      await command(h.c, "question.answer", {
        run_id: runId,
        question_id: qid,
        answer: "No, it was retired.",
        share_with_ticket: false,
      }),
    );
    await h.settle(() => st().questions[qid]?.state === "delivered", "the answer to be delivered");
    expect(answers()).toHaveLength(1);
    expect(answers()[0]?.argv.slice(2)).toEqual([
      `[collie] Answer to your question ${qid.slice(-6)}: No, it was retired. Continue the task.`,
    ]);
    expect(answers()[0]?.from).toBeNull();
    expect(st().tickets["TST-1"]).toMatchObject({ state: "reviewing", attention: [] });
    const types = events().map((e) => e.type);
    expect(types.indexOf("question.opened")).toBeLessThan(types.indexOf("question.answered"));
    expect(types.indexOf("question.answered")).toBeLessThan(types.indexOf("question.delivered"));
  });

  test("step 13: a blocking finding triggers one remediation round, the reviewer re-runs and approves", async () => {
    const sec = reviewerOf("TST-1", "security-reviewer");
    h.report(runId, sec, "finding", {
      severity: "high",
      category: "security",
      title: "Payment id not checked against the caller's account",
      file: "src/payments/api.go",
      line: 88,
      body: "GET /payments/{id} returns any payment.",
    });
    h.report(runId, sec, "done", { summary: "One blocking issue", verdict: "request_changes" });
    await h.settle(working("TST-1", "remediate"), "the remediation to work");
    expect(readFileSync(h.s.home.taskFile(runId, lastExec("TST-1", "remediate").id), "utf8")).toContain(
      "Payment id not checked against the caller's account",
    );
    h.finish(runId, "TST-1");
    // Round 2 re-runs only the reviewer that asked for changes.
    await h.settle(working("TST-1", "review", 2), "the round 2 reviewer to work");
    expect(h.execs(runId, "TST-1", "review").filter((e) => e.round === 2)).toHaveLength(1);
    h.report(runId, h.execs(runId, "TST-1", "review").find((e) => e.round === 2)?.id as string, "done", {
      summary: "Fixed",
      verdict: "approve",
    });
    await h.settle(withPr("TST-1"), "TST-1 to pass the gate and open its PR");
    expect(h.execs(runId, "TST-1", "remediate")).toHaveLength(1);
    expect(st().findings[0]).toMatchObject({ addressed_in_round: 1 });
  });

  test("step 14: an agent that goes idle without reporting is nudged twice, then failed and retried automatically", async () => {
    // TST-6, the other independent ticket, has been working since step 7: it goes through review and
    // opens its PR now. (It is delivered here, not earlier, so that no tick of the fake clock passes
    // while TST-1's developer, which idles on purpose in step 9, waits for the harness.) TST-3 is
    // blocked until that PR exists, then starts and goes quiet.
    await develop("TST-6");
    await approveReviews("TST-6");
    await h.settle(withPr("TST-6"), "TST-6's PR");
    expect(tstate("TST-3")).not.toBe("pending");
    await h.settle(
      () =>
        h.execs(runId, "TST-3", "develop").length === 2 &&
        h.execs(runId, "TST-3", "develop")[1]?.state === "working",
      "TST-3's retry to work",
    );
    const evs = events().filter((e) => e.ticket === "TST-3");
    expect(
      evs.filter((e) => e.type === "execution.nudged").map((e) => (e.payload as { nudge: number }).nudge),
    ).toEqual([1, 2]);
    expect(evs.find((e) => e.type === "execution.failed")?.payload).toMatchObject({
      category: "tooling",
      retryable: true,
      reason: expect.stringContaining("no report after 2 nudges"),
    });
    const [first, second] = h.execs(runId, "TST-3", "develop");
    expect([first?.attempt, first?.state, second?.attempt]).toEqual([1, "failed", 2]);
    expect(execFile(second?.id as string).worktree).toBe(execFile(first?.id as string).worktree);
    // It is stacked on its blocker TST-6's branch, not on the default branch.
    expect(execFile(first?.id as string).base).toBe(branchOf("TST-6"));
    // The retry finishes; its reviewers approve.
    h.finish(runId, "TST-3");
    await approveReviews("TST-3");
    await h.settle(withPr("TST-3"), "TST-3's PR");
  });
});

// ---- Delivery --------------------------------------------------------------------------------

describe("MVP acceptance: delivery", () => {
  test("step 15: an independent ticket's branch is pushed and its PR opens ready for review against the default branch", () => {
    const branches = git(bare, "branch", "--list")
      .split("\n")
      .map((l) => l.trim().replace("* ", ""));
    for (const k of ["TST-1", "TST-6"]) {
      expect(prOf(k)).toMatchObject({ destination: "main", draft: false, state: "OPEN" });
      expect(branches).toContain(branchOf(k));
      expect(host.calls).toContain(`create ${branchOf(k)} -> main`);
    }
  });

  test("step 16: a dependent ticket started while its blocker's PR was open is based on the blocker's branch, and its PR is a draft against it", async () => {
    // TST-3 is the same case, stacked on TST-6 (step 14 finished it).
    expect(prOf("TST-3")).toMatchObject({ destination: branchOf("TST-6"), draft: true });
    await h.settle(working("TST-2", "develop"), "TST-2's developer to work (stacked on TST-1)");
    const exec = execFile(lastExec("TST-2", "develop").id);
    expect(exec.base).toBe(branchOf("TST-1"));
    // The blocker's commits are in the dependent's worktree.
    expect(readFileSync(join(exec.worktree, "TST-1-a.txt"), "utf8")).toContain("first part");
    h.finish(runId, "TST-2");
    await approveReviews("TST-2");
    await h.settle(withPr("TST-2"), "TST-2's PR");
    expect(prOf("TST-2")).toMatchObject({ destination: branchOf("TST-1"), draft: true });
    expect(host.calls).toContain(`create ${branchOf("TST-2")} -> ${branchOf("TST-1")} (draft)`);
  });

  test("step 17: Jira tickets move to the configured statuses, with a comment linking each PR", async () => {
    for (const k of ["TST-1", "TST-2", "TST-3", "TST-6"])
      await h.settle(() => jiraSteps(k).length === 2, `${k}'s Jira write-back`);
    for (const k of ["TST-1", "TST-2", "TST-3", "TST-6"]) {
      const mine = jira.done.filter((d) => d.startsWith(`${k} `));
      expect(mine).toEqual([
        `${k} transition 11`, // In Progress, when it started
        `${k} transition 12`, // In Review, when its PR opened
        expect.stringContaining(
          `${k} comment Herdr Collie opened pull request #${prOf(k)?.id}: ${prOf(k)?.url}`,
        ),
      ]);
    }
    expect(
      events()
        .filter((e) => e.type === "jira.updated" && e.ticket === "TST-1")
        .map((e) => e.payload),
    ).toEqual([
      { transition: "In Progress", step: "start" },
      { transition: "In Review", comment: true, step: "pr" },
    ]);
  });

  test("step 18: downstream tickets start as soon as their blockers reach PR created", async () => {
    // TST-2 started after TST-1's PR existed, TST-3 after TST-6's; TST-4 needs both TST-2 and TST-3.
    const ev = events();
    const at = (type: string, ticket: string) => ev.findIndex((e) => e.type === type && e.ticket === ticket);
    expect(at("pr.created", "TST-1")).toBeLessThan(at("execution.started", "TST-2"));
    expect(at("pr.created", "TST-6")).toBeLessThan(at("execution.started", "TST-3"));
    await h.settle(working("TST-4", "develop"), "TST-4's developer to work");
    const ev2 = events();
    const at2 = (type: string, ticket: string) =>
      ev2.findIndex((e) => e.type === type && e.ticket === ticket);
    expect(Math.max(at2("pr.created", "TST-2"), at2("pr.created", "TST-3"))).toBeLessThan(
      at2("execution.started", "TST-4"),
    );
    // Neither blocker's PR is merged: this is the completion level, not the merge.
    expect(prOf("TST-2")?.state).toBe("OPEN");
    expect(tstate("TST-5")).toBe("blocked");
    // It stacks on the branch of one of its blockers and merges the other's in.
    tst4Base = execFile(lastExec("TST-4", "develop").id).base;
    expect([branchOf("TST-2"), branchOf("TST-3")]).toContain(tst4Base);
  });

  test("step 19: merging the parent PR retargets the child to the default branch, flags it for rebase and marks it ready", async () => {
    expect(prOf("TST-2")).toMatchObject({ draft: true, destination: branchOf("TST-1") });
    mergeOnHost(prOf("TST-1")?.id as number);
    await h.settle(
      () =>
        prOf("TST-2")?.destination === "main" &&
        prOf("TST-2")?.needs_rebase === true &&
        prOf("TST-2")?.draft === false,
      "the child PR to be retargeted, flagged and marked ready",
    );
    expect(prOf("TST-2")).toMatchObject({ destination: "main", draft: false, needs_rebase: true });
    expect(prOf("TST-1")?.state).toBe("MERGED");
    expect(host.pr(prOf("TST-2")?.id as number)).toMatchObject({ destination: "main", draft: false });
    expect(host.calls).toContain(`update ${prOf("TST-2")?.id} {"destination":"main","draft":false}`);
  });
});

// ---- Resilience and completion ---------------------------------------------------------------

describe("MVP acceptance: resilience and completion", () => {
  test("step 20 (contract only; reloading the mod needs real Herdr): a fresh read of state.json is the state the mod saw, rebuilt from events", () => {
    // The mod keeps no state of its own: a reload re-reads state.json, which must equal both what
    // the controller holds and what the event log replays to. The reload itself is checked by hand.
    h.c.flushAll();
    const fresh = JSON.parse(readFileSync(h.s.home.state(runId), "utf8"));
    expect(fresh).toEqual(st());
    expect(fresh).toEqual(rebuild(runId, events()));
    expect(
      Object.values(fresh.executions as StateFile["executions"])
        .filter((e) => e.state === "working")
        .map((e) => e.ticket),
    ).toContain("TST-4");
  });

  test("step 21: killing the controller mid-run and restarting it reattaches to the running agents without duplicates", async () => {
    await h.settle(working("TST-4", "develop"), "TST-4's developer to work");
    const live = Object.entries(st().executions)
      .filter(([, e]) => e.state === "working")
      .map(([id]) => id)
      .sort();
    expect(live.length).toBeGreaterThan(0);
    const launched = runCalls().length;
    // The old controller dies with nothing in flight; the agents' terminals are untouched.
    await h.c.agents?.drain();
    await h.c.delivery?.drain();
    h.c.flushAll();
    const c2 = h.restart();
    expect(c2.runs.has(runId)).toBe(true);
    await c2.reconcile();
    for (let i = 0; i < 8; i++) {
      c2.tick();
      await Bun.sleep(15);
      h.clock.advance(5_000);
    }
    expect(runCalls()).toHaveLength(launched);
    expect(
      Object.entries(st().executions)
        .filter(([, e]) => e.state === "working")
        .map(([id]) => id)
        .sort(),
    ).toEqual(live);
    // One terminal per execution: no execution has two `hc run`s.
    const execLabels = runCalls().map((c) => c.argv.find((a) => a.startsWith("collie.execution=")));
    expect(new Set(execLabels).size).toBe(execLabels.length);
    // The new controller sees TST-4 through.
    h.finish(runId, "TST-4");
  });

  test("step 22: the run completes when every ticket is completed, and the full event history is present", async () => {
    await approveReviews("TST-4");
    await h.settle(withPr("TST-4"), "TST-4's PR");
    expect(prOf("TST-4")).toMatchObject({ draft: true, destination: tst4Base });
    await develop("TST-5");
    await approveReviews("TST-5");
    await h.settle(withPr("TST-5"), "TST-5's PR");
    expect(prOf("TST-5")).toMatchObject({ draft: true, destination: branchOf("TST-4") });
    await h.settle(() => !h.c.runs.has(runId), "the run to end");
    for (const k of KEYS) await h.settle(() => jiraSteps(k).length === 2, `${k}'s Jira write-back`);

    const s = st();
    expect(s.status).toBe("completed");
    expect(KEYS.map((k) => s.tickets[k]?.state)).toEqual(KEYS.map(() => "completed"));
    // Open PRs are still tracked after the run has ended.
    expect(h.c.tracked.has(runId)).toBe(true);
    // Jira: every PR'd ticket was moved and commented exactly once.
    for (const k of KEYS) expect(jira.done.filter((d) => d.startsWith(`${k} `))).toHaveLength(3);

    // The Activity view reads events.jsonl: all of the history is there, and it replays to the state.
    h.c.flushAll();
    const log = events();
    const types = new Set(log.map((e) => e.type));
    for (const t of [
      "run.started",
      "ticket.leased",
      "ticket.state_changed",
      "execution.created",
      "execution.started",
      "execution.nudged",
      "execution.failed",
      "agent.event_accepted",
      "agent.event_rejected",
      "question.opened",
      "question.answered",
      "question.delivered",
      "finding",
      "ask",
      "done",
      "pr.created",
      "pr.updated",
      "jira.updated",
      "run.completed",
    ])
      expect(types).toContain(t as AnyEvent["type"]);
    expect(log[0]?.type).toBe("run.started");
    expect(log.filter((e) => e.type === "run.completed")).toHaveLength(1);
    const ids = log.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rebuild(runId, log)).toEqual(JSON.parse(readFileSync(h.s.home.state(runId), "utf8")));
    // Every ticket's history runs from leased to completed.
    for (const k of KEYS) {
      const mine = log.filter((e) => e.ticket === k).map((e) => e.type);
      expect(mine[0]).toBe("ticket.leased");
      expect(mine).toContain("pr.created");
    }
  });

  test("step 23: the Bitbucket and Jira tokens appear nowhere in the home, the logs, agent environments or saved remotes", async () => {
    await h.c.agents?.drain();
    await h.c.delivery?.drain();
    const hay = [
      ...textFiles(h.s.home.root),
      ...textFiles(h.hcDir),
      ...textFiles(join(h.repo, ".git")).filter(([p]) => p.endsWith("/config")),
      ["controller log", h.log.join("\n")] as [string, string],
    ];
    for (const [p, text] of hay) {
      expect([p, text.includes(SECRET)]).toEqual([p, false]);
      expect([p, /Bearer\s+\S{8,}/.test(text)]).toEqual([p, false]);
    }
    expect(readFileSync(join(h.repo, ".git", "config"), "utf8")).not.toContain("remote.git");
  });
});
