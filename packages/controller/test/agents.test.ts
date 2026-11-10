// Phase 4: agent execution, against tools/fake-hc and real git worktrees.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Agent, git, type Harness, harness, readEvents, ready, WORKING } from "./agent-helpers.ts";
import { command, ok } from "./helpers.ts";

// Each test drives a real controller, real git and a fake hc that is a process per call.
setDefaultTimeout(90_000);
let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const types = (runId: string) =>
  readEvents(h.s.home, runId).map((e) => `${e.type}${e.ticket ? ` ${e.ticket}` : ""}`);
const runCalls = () => h.calls().filter((c) => c.argv[0] === "run");
const labelOf = (argv: string[], key: string) =>
  argv.find((a) => a.startsWith(`collie.${key}=`))?.split("=")[1];
const cwdOf = (call?: { argv: string[] }) => call?.argv[(call?.argv.indexOf("--cwd") ?? -2) + 1];
const execState = (runId: string, ticket: string) => {
  const st = h.state(runId);
  return (st.tickets[ticket]?.executions ?? []).map((id) => st.executions[id]?.state);
};

describe("three tickets, one dependency", () => {
  test("the blocked ticket starts only after its blocker is done, stacked on its branch", async () => {
    h = harness({ blocked_by: { "PAY-102": ["PAY-101"] } });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => runCalls().length >= 2, "the two unblocked tickets to start");

    // PAY-101 and PAY-103 are dispatched; PAY-102 waits.
    expect(
      runCalls()
        .map((c) => labelOf(c.argv, "ticket"))
        .sort(),
    ).toEqual(["PAY-101", "PAY-103"]);
    expect(h.state(runId).tickets["PAY-102"]?.state).toBe("blocked");
    await h.settle(
      () =>
        h.state(runId).tickets["PAY-101"]?.state === "in_progress" &&
        execState(runId, "PAY-101")[0] === "working",
      "PAY-101 working",
    );

    // The brief names the ticket and where the agent works.
    const e1 = h.state(runId).tickets["PAY-101"]?.executions[0] as string;
    const task = readFileSync(h.s.home.taskFile(runId, e1), "utf8");
    expect(task).toContain("# PAY-101 · Ticket PAY-101");
    expect(task).toContain("Kind: develop · round 1 · attempt 1");
    expect(task).toContain("Branch: pay-101-ticket-pay-101, based on main");
    expect(task).toContain("Blocks: PAY-102 · Ticket PAY-102");

    // PAY-101 finishes: it completes, PAY-102 becomes ready and starts.
    h.finish(runId, "PAY-101");
    await h.settle(() => h.state(runId).tickets["PAY-101"]?.state === "completed", "PAY-101 completed");
    await h.settle(() => types(runId).includes("execution.started PAY-102"), "PAY-102 to start");
    const events = types(runId);
    const completed = events.indexOf(
      "ticket.state_changed PAY-101",
      events.lastIndexOf("execution.completed PAY-101"),
    );
    const started102 = events.indexOf("execution.started PAY-102");
    expect(completed).toBeGreaterThan(-1);
    expect(started102).toBeGreaterThan(completed);

    // PAY-102's worktree is on its own branch, stacked on PAY-101's work.
    const st = h.state(runId);
    expect(st.tickets["PAY-102"]).toMatchObject({
      branch: "pay-102-ticket-pay-102",
      base: "pay-101-ticket-pay-101",
    });
    const w2 = join(h.worktrees, "scratch", "pay-102-ticket-pay-102");
    expect(git(w2, "log", "--format=%s", "-3")).toContain("PAY-101: work");
    const t2 = readFileSync(h.s.home.taskFile(runId, st.tickets["PAY-102"]?.executions[0] as string), "utf8");
    expect(t2).toContain("pay-101-ticket-pay-101 contains unmerged work from PAY-101: Ticket PAY-101");
    expect(t2).toContain("Blocked by: PAY-101 · Ticket PAY-101 (completed)");

    // The rest finish, and the run completes and releases its leases.
    h.finish(runId, "PAY-103");
    await h.settle(
      () =>
        h.state(runId).tickets["PAY-102"]?.state === "in_progress" &&
        execState(runId, "PAY-102")[0] === "working",
      "PAY-102 working",
    );
    h.finish(runId, "PAY-102");
    await h.settle(() => !h.c.runs.has(runId), "the run to complete");
    const final = h.state(runId);
    expect(final.status).toBe("completed");
    expect(Object.values(final.tickets).map((t) => t.state)).toEqual(["completed", "completed", "completed"]);
    expect(JSON.parse(readFileSync(h.s.home.runFile(runId), "utf8")).status).toBe("completed");
    expect(JSON.parse(readFileSync(h.s.home.leases, "utf8")).leases).toEqual({});
    // Finished tickets' terminals are ended.
    await h.settle(
      () => h.calls().filter((c) => c.argv[0] === "kill").length === 3,
      "terminals to be killed",
    );
  });

  test("hc run carries the env wrapper, the labels and the flags the protocol requires", async () => {
    h = harness({ tickets: ["PAY-101"] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => runCalls().length === 1, "the agent to start");
    const call = runCalls()[0];
    if (!call) throw new Error("no hc run");
    const a = call.argv;
    const execId = h.state(runId).tickets["PAY-101"]?.executions[0] as string;
    expect(a.slice(0, 5)).toEqual(["run", "--bg", "--json", "--no-parent", "--no-notify"]);
    expect(a).toContain("--name");
    expect(a[a.indexOf("--name") + 1]).toMatch(/^pay-101-[a-z0-9]{6}$/);
    expect(a[a.indexOf("--cwd") + 1]).toBe(join(h.worktrees, "scratch", "pay-101-ticket-pay-101"));
    expect(labelOf(a, "run")).toBe(runId);
    expect(labelOf(a, "execution")).toBe(execId);
    const sep = a.indexOf("--");
    expect(a[sep + 1]).toBe("env");
    const env = a.slice(sep + 2, a.indexOf("/usr/local/bin/claude"));
    expect(env).toEqual(
      expect.arrayContaining([
        `COLLIE_HOME=${h.s.root}`,
        `COLLIE_INBOX=${h.s.home.inbox(runId, execId)}`,
        `COLLIE_RUN_ID=${runId}`,
        `COLLIE_EXECUTION_ID=${execId}`,
        "COLLIE_TICKET=PAY-101",
        "COLLIE_ROLE=developer",
        "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1",
      ]),
    );
    // The claude adapter: absolute path, the first message before any option.
    const cmd = a.slice(a.indexOf("/usr/local/bin/claude"));
    expect(cmd[0]).toBe("/usr/local/bin/claude");
    expect(cmd[1]).toBe("Your Collie brief is ready. Run `collie show task` and follow it.");
    expect(cmd[2]).toBe("--model");
    expect(cmd).toContain("--append-system-prompt");
    expect(cmd.at(-2)).toBe("--permission-mode");
    expect(cmd.join(" ")).toContain("Working inside Collie");
    // No secret anywhere in the command line.
    expect(a.join(" ")).not.toMatch(/token|password|secret/i);
  });
});

describe("scheduling limits", () => {
  test("max_tickets keeps the rest waiting, and a finished ticket frees a slot", async () => {
    h = harness({ settings: { max_tickets: 1 } });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => runCalls().length === 1, "one ticket to start");
    for (let i = 0; i < 6; i++) {
      h.c.tick();
      await Bun.sleep(15);
      h.clock.advance(5_000);
    }
    expect(runCalls()).toHaveLength(1);
    const first = labelOf((runCalls()[0] as { argv: string[] }).argv, "ticket") as string;
    await h.settle(() => execState(runId, first)[0] === "working", `${first} working`);
    h.finish(runId, first);
    await h.settle(() => runCalls().length === 2, "the next ticket to start");
  });

  test("a paused run starts nothing, and resuming starts it", async () => {
    h = harness({ tickets: ["PAY-101"] });
    await ready(h);
    const runId = await h.startRun();
    ok(await command(h.c, "run.pause", { run_id: runId }));
    for (let i = 0; i < 5; i++) {
      h.c.tick();
      await Bun.sleep(15);
      h.clock.advance(5_000);
    }
    expect(runCalls()).toHaveLength(0);
    ok(await command(h.c, "run.resume", { run_id: runId }));
    await h.settle(() => runCalls().length === 1, "the ticket to start after resume");
  });
});

describe("watching an agent", () => {
  const boots: Agent = {
    steps: [
      { on: "run", state: "idle", turn: 0 },
      { on: "get", state: "working", turn: 1 },
      { on: "get", state: "done", turn: 1 },
    ],
  };

  test("an agent that ends its turn without reporting is nudged twice, then failed as retryable", async () => {
    h = harness({ tickets: ["PAY-101"], agents: [boots, WORKING] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => readEvents(h.s.home, runId).some((e) => e.type === "execution.failed"),
      "the execution to fail",
    );
    const events = readEvents(h.s.home, runId);
    expect(
      events.filter((e) => e.type === "execution.nudged").map((e) => (e.payload as { nudge: number }).nudge),
    ).toEqual([1, 2]);
    expect(events.find((e) => e.type === "execution.failed")?.payload).toMatchObject({
      category: "tooling",
      retryable: true,
      reason: expect.stringContaining("no report after 2 nudges"),
    });
    // Both nudges are the protocol's text, typed bare (HC_TERMINAL_ID was set in the controller's env).
    const sends = h.calls().filter((c) => c.argv[0] === "send");
    expect(sends).toHaveLength(2);
    for (const s of sends) {
      expect(s.argv.slice(2)).toEqual(["You haven't reported a result. Run `collie done` or `collie fail`."]);
      expect(s.code).toBe(0);
      expect(s.from).toBeNull();
    }
    // It retried: attempt 2 in the same worktree.
    await h.settle(() => runCalls().length === 2, "the retry to start");
    const st = h.state(runId);
    const [first, second] = (st.tickets["PAY-101"]?.executions ?? []).map((id) => st.executions[id]);
    expect([first?.attempt, first?.state, second?.attempt]).toEqual([1, "failed", 2]);
    expect(runCalls()).toHaveLength(2);
    expect(cwdOf(runCalls()[1])).toBe(cwdOf(runCalls()[0]));
  });

  test("with attempts exhausted the ticket waits for a person, and ticket.retry starts a fresh attempt", async () => {
    h = harness({ tickets: ["PAY-101"], agents: [boots, boots, WORKING], profile: { max_attempts: 2 } });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => h.state(runId).tickets["PAY-101"]?.state === "needs_input",
      "the ticket to need input",
      10_000,
    );
    const t = h.state(runId).tickets["PAY-101"];
    expect(t?.attention).toEqual([{ kind: "execution_failed", id: t?.executions[1] }]);
    expect(t?.resume_state).toBe("in_progress");

    const r = ok(await command(h.c, "ticket.retry", { run_id: runId, ticket: "PAY-101" }));
    expect(h.state(runId).tickets["PAY-101"]).toMatchObject({ state: "in_progress", attention: [] });
    const fresh = h.state(runId).executions[r.execution_id as string];
    expect(fresh).toMatchObject({ attempt: 1, state: "created" });
    await h.settle(
      () => h.state(runId).executions[r.execution_id as string]?.state === "working",
      "the new attempt to work",
    );
    // A ticket that isn't held can't be retried.
    expect(await command(h.c, "ticket.retry", { run_id: runId, ticket: "PAY-101" })).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
  });

  test("a terminal that exits without a report fails the execution", async () => {
    const exits: Agent = {
      steps: [
        { on: "run", state: "idle", turn: 0 },
        { on: "get", state: "working", turn: 1 },
        { on: "get", exit: 1 },
      ],
    };
    h = harness({ tickets: ["PAY-101"], agents: [exits, WORKING] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => readEvents(h.s.home, runId).some((e) => e.type === "execution.failed"),
      "the failure",
    );
    expect(readEvents(h.s.home, runId).find((e) => e.type === "execution.failed")?.payload).toMatchObject({
      category: "tooling",
      retryable: true,
      reason: expect.stringContaining("exited (code 1"),
    });
  });

  test("an exit right after a done is a success, not a failure", async () => {
    const exits: Agent = {
      steps: [
        { on: "run", state: "idle", turn: 0 },
        { on: "get", state: "working", turn: 1 },
        { on: "get", exit: 0 },
      ],
    };
    h = harness({ tickets: ["PAY-101"], agents: [exits] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => execState(runId, "PAY-101")[0] === "starting" || execState(runId, "PAY-101")[0] === "working",
      "the agent to start",
    );
    h.finish(runId, "PAY-101"); // the report lands before the controller sees the exit
    await h.settle(() => !h.c.runs.has(runId), "the run to complete");
    expect(h.state(runId).tickets["PAY-101"]?.state).toBe("completed");
    expect(readEvents(h.s.home, runId).some((e) => e.type === "execution.failed")).toBe(false);
  });

  test("hc refusing to start the agent fails it as tooling, and the retry works", async () => {
    h = harness({
      tickets: ["PAY-101"],
      agents: [{ run_error: { kind: "spawn_failed", message: "cannot start claude" } }, WORKING],
    });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => (h.state(runId).tickets["PAY-101"]?.executions.length ?? 0) === 2, "the retry");
    const events = readEvents(h.s.home, runId);
    expect(events.find((e) => e.type === "execution.failed")?.payload).toMatchObject({
      category: "tooling",
      retryable: true,
      reason: "hc couldn't start the agent: cannot start claude",
    });
    await h.settle(() => execState(runId, "PAY-101")[1] === "working", "the second attempt");
  });

  test("an agent that never takes its first message fails after 60 s, and its terminal is killed", async () => {
    const stuck: Agent = { steps: [{ on: "run", state: "idle", turn: 0 }] };
    h = harness({ tickets: ["PAY-101"], agents: [stuck, WORKING] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => readEvents(h.s.home, runId).some((e) => e.type === "execution.failed"),
      "the failure",
    );
    expect(readEvents(h.s.home, runId).find((e) => e.type === "execution.failed")?.payload).toMatchObject({
      category: "tooling",
      retryable: true,
      reason: expect.stringContaining("first message never arrived"),
    });
    await h.settle(() => h.calls().some((c) => c.argv[0] === "kill"), "the stuck terminal to be killed");
  });

  test("an execution past its profile's time limit is killed and failed as retryable", async () => {
    h = harness({ tickets: ["PAY-101"], profile: { timeout_min: 1 }, agents: [WORKING, WORKING] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => readEvents(h.s.home, runId).some((e) => e.type === "execution.failed"),
      "the timeout",
    );
    expect(readEvents(h.s.home, runId).find((e) => e.type === "execution.failed")?.payload).toMatchObject({
      reason: "timed out after 1 minutes",
      retryable: true,
    });
    await h.settle(() => h.calls().some((c) => c.argv[0] === "kill"), "the terminal to be killed");
  });

  test("a permission block is recorded with its kind, and cleared when it passes", async () => {
    const blocks: Agent = {
      steps: [
        { on: "run", state: "idle", turn: 0 },
        { on: "get", state: "working", turn: 1 },
        { on: "get", state: "blocked", kind: "permission", msg: "approve Bash: go test" },
        { on: "get", state: "working" },
      ],
    };
    h = harness({ tickets: ["PAY-101"], agents: [blocks] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => readEvents(h.s.home, runId).some((e) => e.type === "execution.agent_unblocked"),
      "the block to clear",
    );
    const evs = readEvents(h.s.home, runId).filter((e) => e.type.startsWith("execution.agent_"));
    expect(evs.map((e) => [e.type, e.payload])).toEqual([
      ["execution.agent_blocked", { kind: "permission", message: "approve Bash: go test" }],
      ["execution.agent_unblocked", {}],
    ]);
  });

  test("a trust dialog is shown as waiting for permission, not failed as a launch that never arrived", async () => {
    const dialog: Agent = {
      screen:
        "Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder",
      steps: [
        { on: "run", state: "idle", turn: 0 },
        { on: "get", state: "idle", turn: 0 },
        { on: "get", state: "idle", turn: 0 },
        { on: "get", state: "idle", turn: 0 },
      ],
    };
    h = harness({ tickets: ["PAY-101"], agents: [dialog] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => readEvents(h.s.home, runId).some((e) => e.type === "execution.agent_blocked"),
      "the dialog to be noticed",
      3_000,
    );
    expect(readEvents(h.s.home, runId).find((e) => e.type === "execution.agent_blocked")?.payload).toEqual({
      kind: "permission",
      message: "Claude Code is asking whether to trust the worktree folder; open its terminal and choose Yes",
    });
    // Far past the 60 s start timeout, it is still waiting for the person, not failed.
    for (let i = 0; i < 40; i++) {
      h.c.tick();
      await Bun.sleep(12);
      h.clock.advance(5_000);
    }
    expect(readEvents(h.s.home, runId).some((e) => e.type === "execution.failed")).toBe(false);
    expect(execState(runId, "PAY-101")).toEqual(["starting"]);
  });

  test("a done the worktree contradicts is rejected, and the agent is told why at its next idle", async () => {
    const turns: Agent = {
      steps: [
        { on: "run", state: "idle", turn: 0 },
        { on: "get", state: "working", turn: 1 },
        { on: "get", state: "working" },
        { on: "get", state: "done", turn: 1 },
      ],
    };
    h = harness({ tickets: ["PAY-101"], agents: [turns] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => execState(runId, "PAY-101")[0] === "working", "the agent to work");
    // A done listing a commit that is not on the ticket branch.
    const execId = h.state(runId).tickets["PAY-101"]?.executions[0] as string;
    const stray = git(h.repo, "rev-parse", "HEAD");
    const { agentLine } = await import("./helpers.ts");
    (await import("node:fs")).appendFileSync(
      h.s.home.inbox(runId, execId),
      agentLine(runId, execId, "PAY-101", "done", { summary: "x", commits: [stray] }),
    );
    await h.settle(() => h.calls().some((c) => c.argv[0] === "send"), "the agent to be told");
    expect(readEvents(h.s.home, runId).find((e) => e.type === "agent.event_rejected")?.payload).toMatchObject(
      {
        event_type: "done",
        reason: expect.stringMatching(/^the branch has no commits beyond main|is not on the ticket branch/),
      },
    );
    const sent = h.calls().find((c) => c.argv[0] === "send");
    expect(sent?.argv[2]).toContain("[collie] Your `done` was rejected");
    expect(h.state(runId).executions[execId]?.state).toBe("working");
  });
});

describe("setting an agent up", () => {
  test("a repo that isn't a git repository fails the execution, naming the path, without a retry", async () => {
    h = harness({ tickets: ["PAY-101"], repoPath: "/nonexistent/collie-repo" });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => h.state(runId).tickets["PAY-101"]?.state === "needs_input",
      "the ticket to need input",
    );
    expect(readEvents(h.s.home, runId).find((e) => e.type === "execution.failed")?.payload).toMatchObject({
      category: "environment",
      retryable: false,
      reason: "/nonexistent/collie-repo is not a git repository; check the board's repo local_path",
    });
    expect(h.state(runId).tickets["PAY-101"]?.executions).toHaveLength(1);
    expect(runCalls()).toHaveLength(0);
  });

  test("the description, criteria and comments from Jira go into task.md; a Jira failure doesn't stop the agent", async () => {
    const briefs = {
      brief: async (_: string, key: string) => {
        if (key === "PAY-102") throw new Error("Jira returned HTTP 503");
        return {
          description: "Add the endpoint.\n\n- handles 404",
          criteria: "- returns 404 for unknown ids",
          comments: [{ author: "Sam", created: "2026-11-08", text: "Use the shared error body." }],
        };
      },
    };
    h = harness({ tickets: ["PAY-101", "PAY-102"], briefs });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => runCalls().length === 2, "both agents to start");
    const task = (k: string) =>
      readFileSync(h.s.home.taskFile(runId, h.state(runId).tickets[k]?.executions[0] as string), "utf8");
    expect(task("PAY-101")).toContain(
      "## Ticket\nAdd the endpoint.\n\n- handles 404\n\n### Acceptance criteria\n- returns 404 for unknown ids\n\n### Recent Jira comments\n- Sam (2026-11-08): Use the shared error body.\n\n## Context",
    );
    expect(task("PAY-102")).toContain(
      "couldn't read this ticket's description from Jira: Jira returned HTTP 503",
    );
    expect(task("PAY-102")).not.toContain("### Acceptance criteria");
    expect(h.log.join("\n")).toContain("PAY-102: couldn't read the ticket from Jira");
  });
});

describe("cancelling", () => {
  test("run.cancel cancels every execution and ends their terminals", async () => {
    h = harness({ tickets: ["PAY-101", "PAY-103"] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => ["PAY-101", "PAY-103"].every((k) => execState(runId, k)[0] === "working"),
      "both working",
    );
    ok(await command(h.c, "run.cancel", { run_id: runId }));
    const st = h.state(runId);
    expect(st.status).toBe("cancelled");
    expect(Object.values(st.executions).map((e) => e.state)).toEqual(["cancelled", "cancelled"]);
    expect(h.calls().filter((c) => c.argv[0] === "kill")).toHaveLength(2);
    expect(JSON.parse(readFileSync(h.s.home.leases, "utf8")).leases).toEqual({});
  });

  test("ticket.cancel and exec.cancel kill the terminal; a cancelled execution holds its ticket", async () => {
    h = harness({ tickets: ["PAY-101", "PAY-103"] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () => ["PAY-101", "PAY-103"].every((k) => execState(runId, k)[0] === "working"),
      "both working",
    );
    ok(await command(h.c, "ticket.cancel", { run_id: runId, ticket: "PAY-101" }));
    expect(h.state(runId).tickets["PAY-101"]?.state).toBe("cancelled");
    expect(h.calls().filter((c) => c.argv[0] === "kill")).toHaveLength(1);

    const e3 = h.state(runId).tickets["PAY-103"]?.executions[0] as string;
    ok(await command(h.c, "exec.cancel", { run_id: runId, execution_id: e3 }));
    expect(h.calls().filter((c) => c.argv[0] === "kill")).toHaveLength(2);
    await h.settle(
      () => h.state(runId).tickets["PAY-103"]?.state === "needs_input",
      "PAY-103 to wait for a person",
    );
    expect(h.state(runId).tickets["PAY-103"]?.attention[0]?.kind).toBe("execution_failed");
  });
});

describe("restarting the controller", () => {
  test("reattaches to the running agent without starting a duplicate", async () => {
    h = harness({ tickets: ["PAY-101"] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => execState(runId, "PAY-101")[0] === "working", "the agent to work");
    expect(runCalls()).toHaveLength(1);
    const execId = h.state(runId).tickets["PAY-101"]?.executions[0] as string;
    h.c.flushAll();

    // The old controller dies; the agent's terminal is untouched (it was started --no-parent).
    const c2 = h.restart();
    expect(c2.runs.get(runId)?.state.executions[execId]?.state).toBe("working");
    await c2.reconcile();
    for (let i = 0; i < 6; i++) {
      c2.tick();
      await Bun.sleep(15);
      h.clock.advance(5_000);
    }
    expect(runCalls()).toHaveLength(1);
    expect(h.state(runId).tickets["PAY-101"]?.executions).toEqual([execId]);

    // And the new controller sees the agent through to done.
    h.finish(runId, "PAY-101");
    await h.settle(() => !h.c.runs.has(runId), "the run to complete");
    expect(h.state(runId).tickets["PAY-101"]?.state).toBe("completed");
    expect(runCalls()).toHaveLength(1);
  });

  test("an execution whose launch was logged but whose terminal never started is retried; one whose terminal exists is adopted", async () => {
    h = harness({ tickets: ["PAY-101", "PAY-103"] });
    await ready(h);
    const runId = await h.startRun();
    // Stop right after the executions are created, before hc runs: tick once and kill the controller's work in flight.
    h.c.tick();
    await Bun.sleep(1);
    const st0 = h.state(runId);
    const created = Object.entries(st0.executions);
    expect(created.length).toBe(2);
    await h.settle(
      () => Object.values(h.state(runId).executions).every((e) => e.state !== "created"),
      "setup to finish",
    );
    // Rewind one execution to `created` as a crash between hc run and the log would leave it,
    // by restarting a controller from a log cut before `execution.started` of PAY-103.
    const events = readEvents(h.s.home, runId);
    const iStart = events.findIndex((e) => e.type === "execution.started" && e.ticket === "PAY-103");
    expect(iStart).toBeGreaterThan(-1);
    const { writeFileSync } = await import("node:fs");
    const cut = events
      .slice(0, iStart)
      .concat(events.slice(iStart + 2).filter((e) => e.ticket !== "PAY-103"));
    writeFileSync(h.s.home.events(runId), cut.map((e) => `${JSON.stringify(e)}\n`).join(""));
    const before = runCalls().length;
    const c2 = h.restart();
    expect(
      Object.values(c2.runs.get(runId)?.state.executions ?? {}).filter((e) => e.state === "created"),
    ).toHaveLength(1);
    await c2.reconcile();
    // PAY-103's terminal exists in hc, so it is adopted, not launched again.
    expect(runCalls().length).toBe(before);
    expect(
      Object.entries(c2.runs.get(runId)?.state.executions ?? {})
        .filter(([, e]) => e.ticket === "PAY-103")
        .map(([, e]) => e.state),
    ).toEqual(["starting"]);
  });
});

describe("the files an execution leaves", () => {
  test("execution.json is written first and again with the terminal; the run's events replay to its state", async () => {
    h = harness({ tickets: ["PAY-101"] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => execState(runId, "PAY-101")[0] === "working", "the agent to work");
    const execId = h.state(runId).tickets["PAY-101"]?.executions[0] as string;
    const file = JSON.parse(readFileSync(h.s.home.executionFile(runId, execId), "utf8"));
    expect(file).toMatchObject({
      id: execId,
      run_id: runId,
      ticket: "PAY-101",
      role: "developer",
      kind: "develop",
      attempt: 1,
      base: "main",
      terminal: "t1",
    });
    expect(existsSync(file.worktree)).toBe(true);
    expect(existsSync(h.s.home.taskFile(runId, execId))).toBe(true);
    const { rebuild } = await import("../src/reducer.ts");
    h.c.flushAll();
    expect(rebuild(runId, readEvents(h.s.home, runId))).toEqual(h.state(runId));
  });
});
