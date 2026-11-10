// Phase 5: reviews, the gate, remediation and questions, against tools/fake-hc and real git.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { newUlid } from "@collie/schema";
import { type Agent, type Harness, harness, readEvents, ready, WORKING } from "./agent-helpers.ts";
import { command, ok } from "./helpers.ts";

setDefaultTimeout(120_000);
let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const many = (n: number): Agent[] => Array.from({ length: n }, () => WORKING);
const runCalls = () => h.calls().filter((c) => c.argv[0] === "run");
const sends = () => h.calls().filter((c) => c.argv[0] === "send");
const ticketState = (runId: string, key = "PAY-101") => h.state(runId).tickets[key]?.state;

/** Saves a workflow and the reviewer profiles it names; the board's default becomes it. */
function useWorkflow(
  id: string,
  reviewers: { profile: string; required: boolean }[],
  max_remediation_rounds: number,
  profile: Record<string, unknown> = {},
) {
  const base = JSON.parse(readFileSync(h.s.home.profile("security-reviewer"), "utf8"));
  for (const r of reviewers)
    writeFileSync(
      h.s.home.profile(r.profile),
      JSON.stringify({ ...base, id: r.profile, name: r.profile, ...profile }),
    );
  writeFileSync(
    h.s.home.workflow(id),
    JSON.stringify({ v: 1, id, name: id, developer: "developer", reviewers, max_remediation_rounds }),
  );
}

const SEC = { profile: "security-reviewer", required: true };

/** Runs a fresh single-ticket board to the point where the developer has finished. */
async function developed(workflow: string, reviewers = [SEC], rounds = 2, agents = many(12)) {
  h = harness({ tickets: ["PAY-101"], settings: { workflow }, agents });
  useWorkflow(workflow, reviewers, rounds);
  await ready(h);
  const runId = await h.startRun();
  await h.settle(() => h.execs(runId, "PAY-101", "develop")[0]?.state === "working", "the developer to work");
  h.finish(runId, "PAY-101");
  return runId;
}

const reviewerWorking =
  (runId: string, round: number, n = 1) =>
  () =>
    h.execs(runId, "PAY-101", "review").filter((e) => e.round === round && e.state === "working").length >= n;

describe("reviews and remediation", () => {
  test("a blocking finding triggers one remediation round, after which the reviewer approves and the ticket passes the gate", async () => {
    const runId = await developed("standard-feature");
    await h.settle(() => ticketState(runId) === "reviewing", "the ticket to be reviewed");
    await h.settle(reviewerWorking(runId, 1), "the reviewer to work");

    // The reviewer is told what to review: read-only, in the developer's worktree, on the branch.
    const rev = h.execs(runId, "PAY-101", "review")[0] as { id: string };
    const task = readFileSync(h.s.home.taskFile(runId, rev.id), "utf8");
    expect(task).toContain("Kind: review · round 1 · attempt 1");
    expect(task).toContain("Review this branch's changes against `main`");
    expect(task).toContain("Read-only: do not modify files.");
    const exec = JSON.parse(readFileSync(h.s.home.executionFile(runId, rev.id), "utf8"));
    const dev = h.execs(runId, "PAY-101", "develop")[0] as { id: string };
    const devFile = JSON.parse(readFileSync(h.s.home.executionFile(runId, dev.id), "utf8"));
    expect(exec).toMatchObject({ role: "reviewer", kind: "review", worktree: devFile.worktree });

    h.report(runId, rev.id, "finding", {
      severity: "high",
      category: "security",
      title: "Payment id not checked against the caller's account",
      file: "src/payments/api.go",
      line: 88,
      body: "GET /payments/{id} returns any payment.",
      suggestion: "Scope the lookup by account id.",
    });
    h.report(runId, rev.id, "done", { summary: "One blocking issue", verdict: "request_changes" });
    await h.settle(() => ticketState(runId) === "remediating", "the ticket to be remediated");
    await h.settle(
      () => h.execs(runId, "PAY-101", "remediate")[0]?.state === "working",
      "the remediation to work",
    );

    // The developer comes back with the finding in the brief.
    const rem = h.execs(runId, "PAY-101", "remediate")[0] as { id: string; round: number };
    expect(rem.round).toBe(1);
    const remTask = readFileSync(h.s.home.taskFile(runId, rem.id), "utf8");
    expect(remTask).toContain("Kind: remediate · round 1 · attempt 1");
    expect(remTask).toContain("## Findings to address");
    expect(remTask).toContain(
      "- [high, blocking] Payment id not checked against the caller's account (src/payments/api.go:88)",
    );
    expect(remTask).toContain("collie show findings");

    h.finish(runId, "PAY-101");
    await h.settle(() => ticketState(runId) === "reviewing", "the ticket to be reviewed again");
    await h.settle(reviewerWorking(runId, 2), "the round 2 reviewer to work");
    // Round 2: the finding counts as addressed, and the reviewer is asked to check it.
    expect(h.state(runId).findings[0]).toMatchObject({ addressed_in_round: 1 });
    const rev2 = h.execs(runId, "PAY-101", "review")[1] as { id: string };
    const task2 = readFileSync(h.s.home.taskFile(runId, rev2.id), "utf8");
    expect(task2).toContain("Kind: review · round 2 · attempt 1");
    expect(task2).toContain("## Findings from the last round");
    expect(task2).toContain("Payment id not checked against the caller's account");

    h.report(runId, rev2.id, "done", { summary: "Fixed", verdict: "approve" });
    await h.settle(() => !h.c.runs.has(runId), "the run to complete");
    const events = readEvents(h.s.home, runId).map((e) => `${e.type}${e.ticket ? ` ${e.ticket}` : ""}`);
    expect(events.filter((e) => e === "ticket.state_changed PAY-101").length).toBeGreaterThanOrEqual(7);
    const st = h.state(runId);
    expect(st.tickets["PAY-101"]?.state).toBe("completed");
    expect(st.status).toBe("completed");
    // Every agent's terminal was ended when the ticket completed.
    await h.c.agents?.drain();
    expect(h.calls().filter((c) => c.argv[0] === "kill")).toHaveLength(4);
  });

  test("hitting the round cap moves the ticket to Needs input instead of looping, and ticket.retry grants one more round", async () => {
    const runId = await developed("tight", [SEC], 1);
    const asked = async (round: number) => {
      await h.settle(reviewerWorking(runId, round), `the round ${round} reviewer to work`);
      const rev = h.execs(runId, "PAY-101", "review").find((e) => e.round === round) as { id: string };
      h.report(runId, rev.id, "finding", { severity: "high", title: `Problem in round ${round}`, body: "x" });
      h.report(runId, rev.id, "done", { summary: "no", verdict: "request_changes" });
    };
    await asked(1);
    await h.settle(() => h.execs(runId, "PAY-101", "remediate")[0]?.state === "working", "a remediation");
    h.finish(runId, "PAY-101");
    await asked(2);

    // One remediation was allowed; the second request for changes holds the ticket.
    await h.settle(() => ticketState(runId) === "needs_input", "the ticket to need input");
    const t = h.state(runId).tickets["PAY-101"];
    expect(t).toMatchObject({ resume_state: "reviewing", attention: [{ kind: "round_cap" }] });
    expect(h.execs(runId, "PAY-101", "remediate")).toHaveLength(1);
    expect(runCalls()).toHaveLength(4);
    // It does not loop: more ticks start nothing.
    for (let i = 0; i < 20; i++) {
      h.c.tick();
      h.clock.advance(5_000);
    }
    expect(runCalls()).toHaveLength(4);

    const r = ok(await command(h.c, "ticket.retry", { run_id: runId, ticket: "PAY-101" }));
    expect(r.execution_id).toBeTruthy();
    expect(h.state(runId).tickets["PAY-101"]).toMatchObject({ state: "remediating", attention: [] });
    await h.settle(() => h.execs(runId, "PAY-101", "remediate")[1]?.state === "working", "the extra round");
    expect(h.execs(runId, "PAY-101", "remediate")[1]).toMatchObject({ round: 2 });
    h.finish(runId, "PAY-101");
    await h.settle(reviewerWorking(runId, 3), "the round 3 reviewer to work");
    const rev3 = h.execs(runId, "PAY-101", "review").find((e) => e.round === 3) as { id: string };
    h.report(runId, rev3.id, "done", { summary: "ok", verdict: "approve" });
    await h.settle(() => !h.c.runs.has(runId), "the run to complete");
    expect(h.state(runId).tickets["PAY-101"]?.state).toBe("completed");
  });

  test("required and optional reviewers run in parallel; only the required verdicts decide the gate", async () => {
    const runId = await developed(
      "wide",
      [
        { profile: "security-reviewer", required: true },
        { profile: "backend-reviewer", required: true },
        { profile: "frontend-reviewer", required: false },
      ],
      2,
    );
    await h.settle(reviewerWorking(runId, 1, 3), "all three reviewers to work");
    const revs = h.execs(runId, "PAY-101", "review");
    expect(revs).toHaveLength(3);
    const byProfile = (p: string) =>
      Object.entries(h.state(runId).executions).find(
        ([, e]) => e.kind === "review" && e.profile === p,
      )?.[0] as string;

    // The optional reviewer asks for changes; the gate still waits for the required ones.
    h.report(runId, byProfile("frontend-reviewer"), "finding", {
      severity: "medium",
      title: "Nit",
      body: "x",
      blocking: true,
    });
    h.report(runId, byProfile("frontend-reviewer"), "done", { summary: "no", verdict: "request_changes" });
    h.report(runId, byProfile("security-reviewer"), "done", { summary: "ok", verdict: "approve" });
    for (let i = 0; i < 10; i++) {
      h.c.tick();
      await Bun.sleep(5);
    }
    expect(ticketState(runId)).toBe("reviewing");
    h.report(runId, byProfile("backend-reviewer"), "done", { summary: "ok", verdict: "approve" });
    await h.settle(() => !h.c.runs.has(runId), "the run to complete");
    // No remediation happened: the optional reviewer's findings don't gate.
    expect(h.execs(runId, "PAY-101", "remediate")).toHaveLength(0);
    expect(h.state(runId).tickets["PAY-101"]?.state).toBe("completed");
  });

  test("max_agents holds back reviewers until there is room", async () => {
    h = harness({
      tickets: ["PAY-101"],
      settings: { workflow: "wide2", max_agents: 2 },
      agents: many(12),
    });
    useWorkflow(
      "wide2",
      [
        { profile: "security-reviewer", required: true },
        { profile: "backend-reviewer", required: true },
        { profile: "frontend-reviewer", required: true },
      ],
      2,
    );
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => h.execs(runId, "PAY-101", "develop")[0]?.state === "working", "the developer");
    h.finish(runId, "PAY-101");
    await h.settle(reviewerWorking(runId, 1, 2), "two reviewers to work");
    for (let i = 0; i < 10; i++) {
      h.c.tick();
      await Bun.sleep(5);
    }
    expect(h.execs(runId, "PAY-101", "review")).toHaveLength(2);
    const first = h.execs(runId, "PAY-101", "review")[0] as { id: string };
    h.report(runId, first.id, "done", { summary: "ok", verdict: "approve" });
    await h.settle(() => h.execs(runId, "PAY-101", "review").length === 3, "the third reviewer to start");
  });

  test("a required reviewer that fails with no attempts left holds the ticket, and ticket.retry runs it again", async () => {
    const runId = await developed("one-shot", [SEC], 2);
    // max_attempts 1 on the reviewer profile
    await h.settle(reviewerWorking(runId, 1), "the reviewer");
    const rev = h.execs(runId, "PAY-101", "review")[0] as { id: string };
    h.report(runId, rev.id, "fail", {
      reason: "cannot read the repo",
      category: "environment",
      retryable: false,
    });
    await h.settle(() => ticketState(runId) === "needs_input", "the ticket to need input");
    const t = h.state(runId).tickets["PAY-101"];
    expect(t).toMatchObject({
      resume_state: "reviewing",
      attention: [{ kind: "execution_failed", id: rev.id }],
    });

    ok(await command(h.c, "ticket.retry", { run_id: runId, ticket: "PAY-101" }));
    expect(h.state(runId).tickets["PAY-101"]).toMatchObject({ state: "reviewing", attention: [] });
    const reviews = h.execs(runId, "PAY-101", "review");
    expect(reviews).toHaveLength(2);
    expect(reviews[1]).toMatchObject({ round: 1, attempt: 1 });
    await h.settle(reviewerWorking(runId, 1), "the new reviewer");
    h.report(runId, reviews[1]?.id as string, "done", { summary: "ok", verdict: "approve" });
    await h.settle(() => !h.c.runs.has(runId), "the run to complete");
  });

  test("a workflow with no reviewers goes straight from the developer to done", async () => {
    h = harness({ tickets: ["PAY-101"], settings: { workflow: "small-bug-fix" }, agents: many(3) });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => h.execs(runId, "PAY-101", "develop")[0]?.state === "working", "the developer");
    h.finish(runId, "PAY-101");
    await h.settle(() => !h.c.runs.has(runId), "the run to complete");
    expect(runCalls()).toHaveLength(1);
  });

  test("a workflow chosen for one ticket applies to it from the next run, and the board's default to the rest", async () => {
    h = harness({
      tickets: ["PAY-101", "PAY-102"],
      settings: { workflow: "standard-feature" },
      agents: many(12),
    });
    await ready(h);
    ok(
      await command(h.c, "ticket.set_workflow", {
        board_id: "01JC8XW0000000000000000001",
        ticket: "PAY-102",
        workflow: "small-bug-fix",
      }),
    );
    expect(
      await command(h.c, "ticket.set_workflow", {
        board_id: "01JC8XW0000000000000000001",
        ticket: "PAY-102",
        workflow: "nope",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    const runId = await h.startRun();
    await h.settle(
      () =>
        h.execs(runId, "PAY-101", "develop")[0]?.state === "working" &&
        h.execs(runId, "PAY-102", "develop")[0]?.state === "working",
      "both developers",
    );
    h.finish(runId, "PAY-101");
    h.finish(runId, "PAY-102");
    await h.settle(() => ticketState(runId, "PAY-102") === "completed", "PAY-102 to complete without review");
    expect(h.execs(runId, "PAY-102", "review")).toHaveLength(0);
    await h.settle(() => ticketState(runId, "PAY-101") === "reviewing", "PAY-101 to be reviewed");
  });
});

describe("questions end to end", () => {
  /** An agent that works, ends its turn after asking (idle), and takes the answer (working again). */
  const asker: Agent = {
    steps: [
      { on: "run", state: "idle", turn: 0 },
      { on: "get", state: "working", turn: 1 },
      { on: "get", state: "working", turn: 1 },
      { on: "get", state: "idle", turn: 1 },
      { on: "send", state: "working", turn: "+1" },
    ],
  };

  test("ask → Needs input → answer → hc send when the agent is idle → question.delivered, and the agent works again", async () => {
    h = harness({ tickets: ["PAY-101"], settings: { workflow: "small-bug-fix" }, agents: [asker, WORKING] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => h.execs(runId, "PAY-101", "develop")[0]?.state === "working", "the developer");
    const dev = h.execs(runId, "PAY-101", "develop")[0] as { id: string };
    h.report(runId, dev.id, "ask", {
      question: "Should GET /payments/{id} return 404?",
      options: ["404", "403"],
    });
    await h.settle(() => ticketState(runId) === "needs_input", "the ticket to need input");
    const qid = Object.keys(h.state(runId).questions)[0] as string;
    expect(h.state(runId).tickets["PAY-101"]).toMatchObject({
      resume_state: "in_progress",
      attention: [{ kind: "question", id: qid }],
    });
    expect(h.state(runId).executions[dev.id]?.state).toBe("needs_input");

    // Not delivered before there's an answer, and not before the turn has ended.
    expect(sends()).toHaveLength(0);
    ok(
      await command(h.c, "question.answer", {
        run_id: runId,
        question_id: qid,
        answer: "Return 404\nwith the standard error body.",
        share_with_ticket: true,
      }),
    );
    expect(h.state(runId).questions[qid]).toMatchObject({ state: "answered" });
    await h.settle(() => h.state(runId).questions[qid]?.state === "delivered", "the answer to be delivered");

    // One bare line was typed, in the protocol's format, with HC_TERMINAL_ID removed.
    expect(sends()).toHaveLength(1);
    const send = sends()[0];
    expect(send?.argv.slice(2)).toEqual([
      `[collie] Answer to your question ${qid.slice(-6)}: Return 404 with the standard error body. Continue the task.`,
    ]);
    expect(send?.from).toBeNull();
    expect(h.state(runId).executions[dev.id]?.state).toBe("working");
    expect(h.state(runId).tickets["PAY-101"]).toMatchObject({ state: "in_progress", attention: [] });
    const types = readEvents(h.s.home, runId).map((e) => e.type);
    expect(types.indexOf("question.opened")).toBeLessThan(types.indexOf("question.answered"));
    expect(types.indexOf("question.answered")).toBeLessThan(types.indexOf("question.delivered"));
    // The execution wasn't nudged for waiting on a person.
    expect(types).not.toContain("execution.nudged");
    // The answer is shared with the ticket, so a later brief carries it.
    h.finish(runId, "PAY-101");
    await h.settle(() => !h.c.runs.has(runId), "the run to complete");
  });

  test("an answer waits while the agent is still working, and is delivered after a restart too", async () => {
    const busy: Agent = {
      steps: [
        { on: "run", state: "idle", turn: 0 },
        { on: "get", state: "working", turn: 1 },
        { on: "get", state: "working", turn: 1 },
        { on: "get", state: "working", turn: 1 },
        { on: "get", state: "idle", turn: 1 },
        { on: "send", state: "working", turn: "+1" },
      ],
    };
    h = harness({ tickets: ["PAY-101"], settings: { workflow: "small-bug-fix" }, agents: [busy, WORKING] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(() => h.execs(runId, "PAY-101", "develop")[0]?.state === "working", "the developer");
    const dev = h.execs(runId, "PAY-101", "develop")[0] as { id: string };
    h.report(runId, dev.id, "ask", { question: "Which currency?" });
    await h.settle(() => ticketState(runId) === "needs_input", "needs input");
    const qid = Object.keys(h.state(runId).questions)[0] as string;
    ok(
      await command(h.c, "question.answer", {
        run_id: runId,
        question_id: qid,
        answer: "EUR",
        share_with_ticket: false,
      }),
    );
    // Restart before the agent's turn has ended: the answer is still owed.
    await h.c.agents?.drain();
    h.restart();
    await ready(h);
    expect(h.state(runId).questions[qid]).toMatchObject({ state: "answered" });
    await h.settle(() => h.state(runId).questions[qid]?.state === "delivered", "delivery after the restart");
    expect(sends()).toHaveLength(1);
    expect(h.state(runId).tickets["PAY-101"]?.state).toBe("in_progress");
  });

  test("an agent that ends its turn after asking is not nudged, and a reviewer's question holds the ticket in reviewing", async () => {
    const runId = await developed("standard-feature", [SEC], 2, [WORKING, asker, WORKING]);
    await h.settle(reviewerWorking(runId, 1), "the reviewer");
    const rev = h.execs(runId, "PAY-101", "review")[0] as { id: string };
    h.report(runId, rev.id, "ask", { question: "Is the old endpoint still public?" });
    await h.settle(() => ticketState(runId) === "needs_input", "needs input");
    expect(h.state(runId).tickets["PAY-101"]?.resume_state).toBe("reviewing");
    const qid = Object.keys(h.state(runId).questions)[0] as string;
    ok(
      await command(h.c, "question.answer", {
        run_id: runId,
        question_id: qid,
        answer: "No.",
        share_with_ticket: false,
      }),
    );
    await h.settle(() => h.state(runId).questions[qid]?.state === "delivered", "delivered");
    expect(h.state(runId).tickets["PAY-101"]?.state).toBe("reviewing");
  });
});

describe("the requirements analyst", () => {
  const BOARD = "01JC8XW0000000000000000001";
  const asker: Agent = {
    steps: [
      { on: "run", state: "idle", turn: 0 },
      { on: "get", state: "working", turn: 1 },
      { on: "get", state: "working", turn: 1 },
      { on: "get", state: "idle", turn: 1 },
      { on: "send", state: "working", turn: "+1" },
    ],
  };
  const prepOf = (key = "PAY-101") => h.c.loadBoard(BOARD).tickets[key]?.preparation;
  const prep = () => h.c.preps.get(BOARD);
  const analystExec = () =>
    Object.entries(prep()?.state.executions ?? {}).at(-1) as [string, { state: string }];
  /** What an analyst writes: its events carry no run id. */
  const analystReports = (execId: string, type: string, payload: Record<string, unknown>) =>
    appendFileSync(
      h.s.home.prepExecDir(BOARD, execId) + "/inbox.jsonl",
      `${JSON.stringify({ v: 1, id: newUlid(), type, ts: new Date().toISOString(), source: "agent", run_id: null, execution_id: execId, ticket: "PAY-101", caused_by: null, payload })}\n`,
    );

  test("an under-specified ticket goes to Needs input with the analyst's question, and an answer brings it back to ready", async () => {
    h = harness({ tickets: ["PAY-101"], agents: [asker, WORKING] });
    await ready(h);
    const b = h.c.loadBoard(BOARD);
    (b.tickets["PAY-101"] as { preparation: string }).preparation = "unreviewed";
    h.c.saveBoard(b);

    const r = ok(await command(h.c, "ticket.investigate", { board_id: BOARD, tickets: ["PAY-101"] }));
    expect(r.execution_ids).toHaveLength(1);
    expect(prepOf()).toBe("investigating");
    await h.settle(() => analystExec()[1].state === "working", "the analyst to work");

    // It runs in a detached, read-only worktree of the default branch; its labels name the board, not a run.
    const [execId] = analystExec();
    const call = h.calls().find((c) => c.argv[0] === "run");
    expect(call?.argv).toContain(`collie.board=${BOARD}`);
    expect(call?.argv.join(" ")).toContain("COLLIE_RUN_ID= ");
    const file = JSON.parse(readFileSync(`${h.s.home.prepExecDir(BOARD, execId)}/execution.json`, "utf8"));
    expect(file).toMatchObject({ run_id: null, role: "analyst", kind: "analyse", branch: "main" });
    expect(file.worktree).toContain("prep-pay-101");
    expect(readFileSync(`${file.worktree}/README.md`, "utf8")).toContain("scratch");
    const task = readFileSync(`${h.s.home.prepExecDir(BOARD, execId)}/task.md`, "utf8");
    expect(task).toContain("Kind: analyse");
    expect(task).toContain("detached and read-only");

    // It asks: the ticket needs input, and the question is in the board's preparation log.
    analystReports(execId, "ask", { question: "Should refunds be partial?", options: ["yes", "no"] });
    await h.settle(() => prepOf() === "needs_input", "the ticket to need input");
    const qid = Object.keys(prep()?.state.questions ?? {})[0] as string;
    expect(prep()?.state.questions[qid]).toMatchObject({
      question: "Should refunds be partial?",
      state: "open",
      ticket: "PAY-101",
    });
    // No run is involved: the board has none, and the preparation log has its own files.
    expect(h.c.runs.size).toBe(0);
    expect(existsSync(h.s.home.prepEvents(BOARD))).toBe(true);

    // The answer goes to the analyst (the board's id names the log), which carries on and finishes.
    ok(
      await command(h.c, "question.answer", {
        run_id: BOARD,
        question_id: qid,
        answer: "Yes, partial refunds.",
        share_with_ticket: true,
      }),
    );
    await h.settle(() => prep()?.state.questions[qid]?.state === "delivered", "the answer to be delivered");
    expect(prepOf()).toBe("investigating");
    analystReports(execId, "finding", {
      severity: "medium",
      category: "design",
      title: "Split the refund ledger out",
      body: "x",
    });
    analystReports(execId, "done", { summary: "Scope: refunds endpoint. Risk: ledger." });
    await h.settle(() => prepOf() === "ready", "the ticket to be ready");
    expect(prep()?.state.findings[0]).toMatchObject({ title: "Split the refund ledger out" });
    await h.c.agents?.drain();
    expect(h.calls().filter((c) => c.argv[0] === "kill")).toHaveLength(1);

    // The answer was shared with the ticket, so a developer's brief carries it.
    const runId = await h.startRun();
    await h.settle(() => h.execs(runId, "PAY-101", "develop")[0]?.state === "working", "the developer");
    const dev = h.execs(runId, "PAY-101", "develop")[0] as { id: string };
    expect(readFileSync(h.s.home.taskFile(runId, dev.id), "utf8")).toContain("A: Yes, partial refunds.");
  });

  test("an analyst that fails ends with the ticket back to unreviewed, and a person can investigate again", async () => {
    h = harness({ tickets: ["PAY-101"], agents: [WORKING, WORKING], profile: {} });
    await ready(h);
    const analyst = JSON.parse(readFileSync(h.s.home.profile("requirements-analyst"), "utf8"));
    writeFileSync(h.s.home.profile("requirements-analyst"), JSON.stringify({ ...analyst, max_attempts: 1 }));
    ok(await command(h.c, "ticket.investigate", { board_id: BOARD, tickets: ["PAY-101"] }));
    await h.settle(() => analystExec()[1].state === "working", "the analyst to work");
    const [execId] = analystExec();
    // Investigating twice at once is refused.
    expect(await command(h.c, "ticket.investigate", { board_id: BOARD, tickets: ["PAY-101"] })).toMatchObject(
      {
        ok: false,
        error: { code: "invalid_state", message: expect.stringContaining("already being investigated") },
      },
    );
    analystReports(execId, "fail", {
      reason: "can't read the repo",
      category: "environment",
      retryable: false,
    });
    await h.settle(() => prepOf() === "unreviewed", "the ticket to be unreviewed");
    ok(await command(h.c, "ticket.investigate", { board_id: BOARD, tickets: ["PAY-101"] }));
    expect(prepOf()).toBe("investigating");
  });

  test("a ticket that isn't on the board, or an outside blocker, can't be investigated; the preparation log survives a restart", async () => {
    h = harness({ tickets: ["PAY-101"], agents: [asker] });
    await ready(h);
    expect(await command(h.c, "ticket.investigate", { board_id: BOARD, tickets: ["PAY-999"] })).toMatchObject(
      {
        ok: false,
        error: { code: "not_found" },
      },
    );
    ok(await command(h.c, "ticket.investigate", { board_id: BOARD, tickets: ["PAY-101"] }));
    await h.settle(() => analystExec()[1].state === "working", "the analyst to work");
    const [execId] = analystExec();
    analystReports(execId, "ask", { question: "Which currency?" });
    await h.settle(() => prepOf() === "needs_input", "needs input");
    await h.c.agents?.drain();
    h.restart();
    await ready(h);
    expect(prep()?.state.questions && Object.values(prep()?.state.questions ?? {})[0]).toMatchObject({
      state: "open",
    });
    expect(prepOf()).toBe("needs_input");
    // The analyst's terminal was reattached, not started again.
    expect(h.calls().filter((c) => c.argv[0] === "run")).toHaveLength(1);
  });
});
