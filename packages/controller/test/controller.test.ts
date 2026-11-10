import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatIssues, validateLeases, validateRun, validateState } from "@collie/schema";
import type { Controller } from "../src/controller.ts";
import { rebuild } from "../src/reducer.ts";
import {
  agentLine,
  command,
  FIXTURES,
  inProcess,
  ok,
  readEvents,
  type Scratch,
  saveBoard,
  scratchHome,
  seedExecution,
  seedTicketInProgress,
} from "./helpers.ts";

const BOARD = "01JC8XW0000000000000000001";
const BOARD2 = "01JC8XW0000000000000000002";
let s: Scratch;
let c: Controller;

beforeEach(() => {
  s = scratchHome();
  saveBoard(s.home, BOARD, ["PAY-101", "PAY-102"]);
  c = inProcess(s).c;
});
afterEach(() => s.cleanup());

const startRun = async (board = BOARD, id?: string) =>
  ok(await command(c, "run.start", { board_id: board }, id)).run_id as string;
const state = (runId: string) =>
  c.runs.get(runId)?.state ?? JSON.parse(readFileSync(s.home.state(runId), "utf8"));

describe("run.start", () => {
  test("snapshots config, leases every ticket and logs the start", async () => {
    const runId = await startRun();
    const run = validateRun(JSON.parse(readFileSync(s.home.runFile(runId), "utf8")));
    if (!run.ok) throw new Error(formatIssues(run.issues));
    expect(run.value).toMatchObject({ id: runId, board_id: BOARD, number: 1, status: "running" });
    expect(Object.keys(run.value.snapshot.workflows)).toEqual(["standard-feature"]);
    expect(Object.keys(run.value.snapshot.profiles).sort()).toEqual(["developer", "security-reviewer"]);
    expect(readEvents(s.home, runId).map((e) => e.type)).toEqual([
      "run.started",
      "ticket.leased",
      "ticket.leased",
      "ticket.state_changed",
      "ticket.state_changed",
      "command.applied",
      // Readiness: both tickets are prepared and unblocked.
      "ticket.state_changed",
      "ticket.state_changed",
    ]);
    expect(Object.values(state(runId).tickets).map((t) => (t as { state: string }).state)).toEqual([
      "ready",
      "ready",
    ]);
    expect(state(runId).leases).toEqual(["PAY-101", "PAY-102"]);
    const leases = validateLeases(JSON.parse(readFileSync(s.home.leases, "utf8")));
    expect(leases.ok && leases.value.leases).toEqual({ "PAY-101": runId, "PAY-102": runId });
  });

  test("a later edit to the board doesn't change the running run's snapshot", async () => {
    const runId = await startRun();
    ok(await command(c, "board.update_settings", { board_id: BOARD, settings: { max_agents: 1 } }));
    const run = JSON.parse(readFileSync(s.home.runFile(runId), "utf8"));
    expect(run.snapshot.settings.max_agents).toBe(6);
  });

  test("a ticket leased by another run is refused with a clear reason", async () => {
    const first = await startRun();
    saveBoard(s.home, BOARD2, ["PAY-102", "PAY-103"]);
    const r = await command(c, "run.start", { board_id: BOARD2 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("lease_conflict");
    expect(r.error.message).toBe(
      `ticket PAY-102 (run ${first}) is leased by another active run; a ticket can be in one run at a time. Finish or cancel that run first.`,
    );
    expect(c.runs.size).toBe(1);
    // Once the first run ends, the lease is free.
    ok(await command(c, "run.cancel", { run_id: first }));
    expect(await startRun(BOARD2)).toBeString();
  });

  test("one active run per board", async () => {
    await startRun();
    const r = await command(c, "run.start", { board_id: BOARD });
    expect(!r.ok && r.error.code).toBe("invalid_state");
  });

  test("a missing workflow or profile is named", async () => {
    saveBoard(s.home, BOARD2, ["PAY-201"], {
      settings: { ...JSON.parse(readFileSync(s.home.board(BOARD), "utf8")).settings, workflow: "nope" },
    });
    const r = await command(c, "run.start", { board_id: BOARD2 });
    expect(!r.ok && r.error).toEqual({
      code: "not_found",
      message: "workflow nope doesn't exist; save it first with workflow.save",
    });
  });

  test("running the same command again after a crash is a no-op", async () => {
    const id = "01JC9A0C000000000000000001";
    const runId = await startRun(BOARD, id);
    expect(runId).toBe(id);
    writeFileSync(
      join(s.home.pending, `${id}.json`),
      JSON.stringify({
        v: 1,
        id,
        command: "run.start",
        at: "2026-11-09T10:00:00Z",
        args: { board_id: BOARD },
      }),
    );
    writeFileSync(join(s.home.done, `${id}.json`), "{}");
    await c.processCommands();
    expect(existsSync(join(s.home.pending, `${id}.json`))).toBe(false);
    expect(readEvents(s.home, runId).filter((e) => e.type === "run.started").length).toBe(1);
  });

  test("carry over starts completed tickets as completed", async () => {
    const first = await startRun();
    ok(await command(c, "ticket.cancel", { run_id: first, ticket: "PAY-102" }));
    const rl = c.runs.get(first);
    if (!rl) throw new Error("run ended early");
    // PAY-101 completes in the first run (delivery arrives in Phase 6; written directly here).
    c.emit(
      rl,
      ["in_progress", "delivering", "completed"].map((to, i, all) =>
        c.event(
          first,
          "ticket.state_changed",
          { from: i === 0 ? "ready" : all[i - 1], to, reason: "test" },
          { ticket: "PAY-101" },
        ),
      ),
    );
    c.completeRunIfDone(rl, null);
    expect(c.runs.has(first)).toBe(false);
    const second = ok(await command(c, "run.start", { board_id: BOARD, carry_over_from: first }))
      .run_id as string;
    expect(state(second).tickets["PAY-101"].state).toBe("completed");
    expect(state(second).tickets["PAY-102"].state).toBe("ready");
  });
});

describe("run lifecycle", () => {
  test("pause, resume and cancel follow the run state machine", async () => {
    const runId = await startRun();
    expect((await command(c, "run.resume", { run_id: runId })).ok).toBe(false);
    ok(await command(c, "run.pause", { run_id: runId, reason: "lunch" }));
    expect(state(runId).status).toBe("paused");
    expect(JSON.parse(readFileSync(s.home.runFile(runId), "utf8")).status).toBe("paused");
    ok(await command(c, "run.resume", { run_id: runId }));
    const exec = seedExecution(c, c.runs.get(runId) as never, "PAY-101", "developer");
    ok(await command(c, "run.cancel", { run_id: runId }));
    const st = state(runId);
    expect(st.status).toBe("cancelled");
    expect(st.leases).toEqual([]);
    expect(st.executions[exec].state).toBe("cancelled");
    expect(Object.values(st.tickets).map((t) => (t as { state: string }).state)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    const run = JSON.parse(readFileSync(s.home.runFile(runId), "utf8"));
    expect([run.status, run.end_reason]).toEqual(["cancelled", "cancelled by a person"]);
    expect(await command(c, "run.pause", { run_id: runId })).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
  });

  test("the run completes when every ticket is completed or cancelled", async () => {
    const runId = await startRun();
    ok(await command(c, "ticket.cancel", { run_id: runId, ticket: "PAY-101" }));
    expect(c.runs.has(runId)).toBe(true);
    ok(await command(c, "ticket.cancel", { run_id: runId, ticket: "PAY-102" }));
    expect(c.runs.has(runId)).toBe(false);
    const ev = readEvents(s.home, runId);
    expect(ev.slice(-3).map((e) => e.type)).toEqual(["ticket.released", "ticket.released", "run.completed"]);
    // The command.applied for the last cancel is in the log too, before the run ended.
    expect(ev.filter((e) => e.type === "command.applied").length).toBe(3);
  });

  test("run.delete refuses a live run, then removes an ended one", async () => {
    const runId = await startRun();
    expect(await command(c, "run.delete", { run_id: runId })).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
    ok(await command(c, "run.cancel", { run_id: runId }));
    ok(await command(c, "run.delete", { run_id: runId }));
    expect(existsSync(s.home.runDir(runId))).toBe(false);
  });

  test("commands that need later phases say which phase", async () => {
    const runId = await startRun();
    expect(await command(c, "ticket.retry", { run_id: runId, ticket: "PAY-101" })).toMatchObject({
      ok: false,
      error: {
        code: "unsupported",
        message: "ticket.retry (needs agent execution) is not supported yet; it arrives in Phase 4",
      },
    });
    expect(await command(c, "board.import", { board_id: BOARD, jql: "project = PAY" })).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    // A rejected command is logged in its run.
    expect(readEvents(s.home, runId).at(-1)).toMatchObject({
      type: "command.rejected",
      payload: { command: "ticket.retry", code: "unsupported" },
    });
  });

  test("an invalid command gets invalid_args naming the field", async () => {
    expect(await command(c, "run.start", { board: BOARD })).toMatchObject({
      ok: false,
      error: { code: "invalid_args", message: "args.board_id: is required" },
    });
  });
});

describe("boards", () => {
  test("board.create applies defaults, and its id is the command id", async () => {
    const id = "01JC9A0C000000000000000009";
    const r = ok(
      await command(
        c,
        "board.create",
        {
          name: "Payments",
          jira: { site: "[SITE].atlassian.net", project: "PAY", cloud_id: "[CLOUD-ID]" },
          repo: {
            workspace: "[WORKSPACE]",
            slug: "[REPO]",
            default_branch: "main",
            local_path: "~/code/[REPO]",
          },
          settings: { max_tickets: 5 },
        },
        id,
      ),
    );
    expect(r).toEqual({ board_id: id });
    const b = JSON.parse(readFileSync(s.home.board(id), "utf8"));
    expect([b.settings.max_tickets, b.settings.complete_at]).toEqual([5, "pr_created"]);
  });

  test("dep.override and dep.restore edit overrides, checking the link exists", async () => {
    saveBoard(s.home, BOARD2, ["PAY-201", "PAY-202"]);
    const b = JSON.parse(readFileSync(s.home.board(BOARD2), "utf8"));
    b.tickets["PAY-202"].blocked_by = ["PAY-201"];
    writeFileSync(s.home.board(BOARD2), JSON.stringify(b));
    ok(await command(c, "dep.override", { board_id: BOARD2, blocker: "PAY-201", blocked: "PAY-202" }));
    expect(JSON.parse(readFileSync(s.home.board(BOARD2), "utf8")).overrides).toHaveLength(1);
    expect(
      (await command(c, "dep.override", { board_id: BOARD2, blocker: "PAY-201", blocked: "PAY-202" })).ok,
    ).toBe(false);
    expect(
      await command(c, "dep.override", { board_id: BOARD2, blocker: "PAY-999", blocked: "PAY-202" }),
    ).toMatchObject({
      ok: false,
      error: { code: "not_found", message: "PAY-202 isn't blocked by PAY-999" },
    });
    ok(await command(c, "dep.restore", { board_id: BOARD2, blocker: "PAY-201", blocked: "PAY-202" }));
    expect(JSON.parse(readFileSync(s.home.board(BOARD2), "utf8")).overrides).toEqual([]);
  });
});

describe("inbox watcher", () => {
  const RUN = "01JC8YQ0P4E2W7H5S8D3F6G9KB";
  const EXEC = "01JC8Z1A9C4V6B2N8M5X7Z3QWE";

  test("a fixture inbox produces exactly the expected accept and reject events", async () => {
    await startRun(BOARD, RUN);
    const rl = c.runs.get(RUN);
    if (!rl) throw new Error("no run");
    seedTicketInProgress(c, rl, "PAY-101");
    seedExecution(c, rl, "PAY-101", "reviewer", { id: EXEC });
    const before = readEvents(s.home, RUN).length;
    writeFileSync(s.home.inbox(RUN, EXEC), readFileSync(join(FIXTURES, "scenarios/controller-inbox.jsonl")));
    c.tick();
    c.tick(); // a second pass must not judge anything twice

    const produced = readEvents(s.home, RUN).slice(before);
    const normal = produced.map((e) => ({
      ...e,
      id: e.source === "agent" ? e.id : "<id>",
      ts: e.source === "agent" ? e.ts : "<ts>",
      caused_by: e.caused_by?.startsWith("01JC8Z4Q") ? e.caused_by : e.caused_by ? "<id>" : null,
    }));
    const expectedPath = join(FIXTURES, "scenarios/controller-inbox.expected.jsonl");
    if (process.env.UPDATE_EXPECTED)
      writeFileSync(expectedPath, normal.map((e) => `${JSON.stringify(e)}\n`).join(""));
    const expected = readFileSync(expectedPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(normal).toEqual(expected);

    // The torn final line wasn't judged; the offset stops before it.
    const text = readFileSync(s.home.inbox(RUN, EXEC), "utf8");
    expect(rl.state.inbox_offsets[EXEC]).toBe(Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
    // Completing it later gets it judged, once.
    writeFileSync(
      s.home.inbox(RUN, EXEC),
      `${text.slice(0, text.lastIndexOf("\n") + 1)}${agentLine(RUN, EXEC, "PAY-101", "status", { message: "late" })}`,
    );
    c.tick();
    expect(readEvents(s.home, RUN).at(-1)).toMatchObject({
      type: "agent.event_rejected",
      payload: { reason: "execution already ended (completed); nothing more can be recorded" },
    });
  });

  test("an ask moves the execution and ticket to needs_input; done clears it", async () => {
    const runId = await startRun();
    const rl = c.runs.get(runId);
    if (!rl) throw new Error("no run");
    seedTicketInProgress(c, rl, "PAY-101");
    const exec = seedExecution(c, rl, "PAY-101", "developer");
    const ask = agentLine(runId, exec, "PAY-101", "ask", { question: "404 or 403?" });
    writeFileSync(s.home.inbox(runId, exec), ask);
    c.tick();
    const qid = JSON.parse(ask).id;
    expect(rl.state.executions[exec]?.state).toBe("needs_input");
    expect(rl.state.tickets["PAY-101"]).toMatchObject({
      state: "needs_input",
      resume_state: "in_progress",
      attention: [{ kind: "question", id: qid }],
    });
    ok(
      await command(c, "question.answer", {
        run_id: runId,
        question_id: qid,
        answer: "404",
        share_with_ticket: true,
      }),
    );
    expect(rl.state.questions[qid]).toMatchObject({
      state: "answered",
      answer: "404",
      share_with_ticket: true,
    });
    expect(
      await command(c, "question.answer", {
        run_id: runId,
        question_id: qid,
        answer: "403",
        share_with_ticket: false,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_state" },
    });
    writeFileSync(
      s.home.inbox(runId, exec),
      ask + agentLine(runId, exec, "PAY-101", "done", { summary: "s", commits: ["a1b2c3d"] }),
    );
    c.tick();
    expect(rl.state.executions[exec]?.state).toBe("completed");
    expect(rl.state.questions[qid]?.state).toBe("withdrawn");
    expect(rl.state.tickets["PAY-101"]).toMatchObject({
      state: "in_progress",
      resume_state: null,
      attention: [],
    });
  });

  test("an agent reporting while its execution is still starting moves it to working", async () => {
    const runId = await startRun();
    const rl = c.runs.get(runId);
    if (!rl) throw new Error("no run");
    const exec = seedExecution(c, rl, "PAY-101", "developer", { state: "starting" });
    writeFileSync(s.home.inbox(runId, exec), agentLine(runId, exec, "PAY-101", "status", { message: "hi" }));
    c.tick();
    expect(rl.state.executions[exec]?.state).toBe("working");
  });

  test("exec.cancel ends an execution and releases its question's hold on the ticket", async () => {
    const runId = await startRun();
    const rl = c.runs.get(runId);
    if (!rl) throw new Error("no run");
    seedTicketInProgress(c, rl, "PAY-101");
    const exec = seedExecution(c, rl, "PAY-101", "developer");
    writeFileSync(s.home.inbox(runId, exec), agentLine(runId, exec, "PAY-101", "ask", { question: "q?" }));
    c.tick();
    ok(await command(c, "exec.cancel", { run_id: runId, execution_id: exec }));
    expect(rl.state.executions[exec]?.state).toBe("cancelled");
    expect(rl.state.tickets["PAY-101"]?.state).toBe("in_progress");
  });
});

describe("state", () => {
  test("live state equals a rebuild from events.jsonl, and state.json matches after a flush", async () => {
    const runId = await startRun();
    const rl = c.runs.get(runId);
    if (!rl) throw new Error("no run");
    seedTicketInProgress(c, rl, "PAY-101");
    const exec = seedExecution(c, rl, "PAY-101", "reviewer");
    writeFileSync(
      s.home.inbox(runId, exec),
      agentLine(runId, exec, "PAY-101", "finding", {
        severity: "high",
        title: "t",
        body: "b",
        blocking: true,
      }) + agentLine(runId, exec, "PAY-101", "done", { summary: "s", verdict: "request_changes" }),
    );
    c.tick();
    rl.flush(Date.now() + 1000);
    const rebuilt = rebuild(runId, readEvents(s.home, runId));
    expect(rl.state).toEqual(rebuilt);
    expect(JSON.parse(readFileSync(s.home.state(runId), "utf8"))).toEqual(rebuilt);
    const v = validateState(rebuilt);
    if (!v.ok) throw new Error(formatIssues(v.issues));
  });

  test("state.json is written at most every 250 ms, and on flush", async () => {
    const { c: c2, clock } = inProcess(s);
    const runId = ok(await command(c2, "run.start", { board_id: BOARD })).run_id as string;
    const rl = c2.runs.get(runId);
    if (!rl) throw new Error("no run");
    const before = readFileSync(s.home.state(runId), "utf8");
    clock.advance(100);
    ok(await command(c2, "run.pause", { run_id: runId }));
    expect(readFileSync(s.home.state(runId), "utf8")).toBe(before);
    clock.advance(200);
    c2.tick();
    expect(JSON.parse(readFileSync(s.home.state(runId), "utf8")).status).toBe("paused");
  });
});
