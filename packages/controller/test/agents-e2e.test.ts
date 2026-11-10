// Agents that really run: fake-hc starts a scripted fake-agent, which calls the real `collie`
// CLI inside a real worktree. Nothing is faked between the agent and the controller's inbox.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter } from "../src/adapters/index.ts";
import { FAKE_AGENT, git, type Harness, harness, readEvents, ready, WORKING } from "./agent-helpers.ts";

setDefaultTimeout(120_000);
let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

const SCENARIO = join(import.meta.dir, "../../../fixtures/scenarios/developer-run.json");
const fakeAgent: Adapter = {
  name: "claude-code",
  launch: () => ({ argv: [process.execPath, FAKE_AGENT, SCENARIO], env: {} }),
};
const running = { ...WORKING, spawn: true };

describe("agents that really run", () => {
  test("a developer reads its brief, commits and reports done, and the ticket completes", async () => {
    h = harness({
      tickets: ["PAY-101", "PAY-102"],
      blocked_by: { "PAY-102": ["PAY-101"] },
      agents: [running, running],
      adapters: { "claude-code": fakeAgent },
    });
    await ready(h);
    const runId = await h.startRun();
    // Real time here: the agent is a real process, so the fake clock only needs to keep moving.
    await h.settle(() => !h.c.runs.has(runId), "both developers to finish", 2_000);
    const st = h.state(runId);
    expect(st.status).toBe("completed");
    expect(Object.values(st.tickets).map((t) => t.state)).toEqual(["completed", "completed"]);

    const events = readEvents(h.s.home, runId);
    // Each agent's reports went through the inbox and were accepted.
    for (const t of ["PAY-101", "PAY-102"]) {
      const kinds = events.filter((e) => e.ticket === t && e.type === "agent.event_accepted");
      expect(kinds.map((e) => (e.payload as { event_type: string }).event_type)).toEqual(["status", "done"]);
    }
    expect(events.some((e) => e.type === "agent.event_rejected")).toBe(false);
    // The commits are on the tickets' branches, PAY-102's on top of PAY-101's.
    const log = git(h.repo, "log", "--format=%s", "pay-102-ticket-pay-102");
    expect(log.split("\n").slice(0, 2)).toEqual(["PAY-102: work", "PAY-101: work"]);
    // The agent ran in its worktree with the controller's environment, and read the brief.
    const e1 = st.tickets["PAY-101"]?.executions[0] as string;
    expect(readFileSync(h.s.home.taskFile(runId, e1), "utf8")).toContain("# PAY-101");
    expect(st.executions[e1]?.terminal).toMatch(/^t\d+$/);
  });
});

describe("restart reconciliation", () => {
  test("an execution created but never started is failed as retryable and relaunched", async () => {
    h = harness({ tickets: ["PAY-101"], agents: [WORKING] });
    await ready(h);
    const runId = await h.startRun();
    // The controller dies after logging the execution and before hc run: nothing is in hc.
    const rl = h.rl(runId);
    const execId = h.c.clock.id();
    h.c.emit(rl, [
      h.c.ticketTo(rl, "PAY-101", "in_progress", "dispatched"),
      h.c.event(
        runId,
        "execution.created",
        {
          profile: "developer",
          role: "developer",
          kind: "develop",
          round: 1,
          attempt: 1,
          worktree: join(h.worktrees, "scratch", "pay-101"),
          branch: "pay-101",
          base: "main",
        },
        { ticket: "PAY-101", exec: execId },
      ),
      h.c.event(
        runId,
        "execution.state_changed",
        { from: null, to: "created", reason: "dispatched" },
        { ticket: "PAY-101", exec: execId },
      ),
    ]);
    h.c.flushAll();
    const c2 = h.restart();
    await c2.reconcile();
    const failed = readEvents(h.s.home, runId).find((e) => e.type === "execution.failed");
    expect(failed?.payload).toMatchObject({
      reason: "the controller restarted before the agent was launched",
      category: "tooling",
      retryable: true,
    });
    await h.settle(() => (h.state(runId).tickets["PAY-101"]?.executions.length ?? 0) === 2, "the retry");
    await h.settle(
      () =>
        h.state(runId).executions[h.state(runId).tickets["PAY-101"]?.executions[1] as string]?.state ===
        "working",
      "the retry to work",
    );
    expect(h.calls().filter((c) => c.argv[0] === "run")).toHaveLength(1);
  });

  test("terminals of cancelled or finished work found after a restart are ended", async () => {
    h = harness({ tickets: ["PAY-101"], agents: [WORKING] });
    await ready(h);
    const runId = await h.startRun();
    await h.settle(
      () =>
        h.state(runId).executions[h.state(runId).tickets["PAY-101"]?.executions[0] as string]?.state ===
        "working",
      "working",
    );
    const execId = h.state(runId).tickets["PAY-101"]?.executions[0] as string;
    // Cancelled in the log, but the controller died before it could kill the terminal.
    const rl = h.rl(runId);
    h.c.emit(rl, [h.c.execTo(rl, execId, "cancelled", "cancelled by a person")]);
    h.c.flushAll();
    expect(h.calls().some((c) => c.argv[0] === "kill")).toBe(false);
    const c2 = h.restart();
    await c2.reconcile();
    await c2.agents?.drain();
    expect(h.calls().filter((c) => c.argv[0] === "kill")).toHaveLength(1);
  });
});
