import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "@collie/schema";
import { formatIssues, validateCommand } from "@collie/schema";
import {
  boardModel,
  describeReply,
  excludeAction,
  execLine,
  externalActions,
  nextPreparation,
  parseImport,
  type RunView,
  runModel,
  startAction,
  ticketRunActions,
  watchCommand,
} from "../src/model.ts";

const fixture = (name: string): Board =>
  JSON.parse(readFileSync(join(import.meta.dir, `../../fixtures/boards/${name}.json`), "utf8"));

describe("boardModel", () => {
  test("rows, readiness counts and outside blockers with their links", () => {
    const m = boardModel(fixture("external-blockers"));
    expect(m.rows.map((r) => `${r.key}:${r.readiness}`)).toEqual([
      "PAY-1:blocked",
      "PAY-2:blocked",
      "PAY-3:blocked",
    ]);
    expect(m.counts).toEqual({ excluded: 0, pending: 0, blocked: 3, ready: 0 });
    expect(m.externals).toEqual([
      {
        key: "OPS-77",
        summary: "Ticket OPS-77",
        jiraStatus: "To Do",
        satisfied: false,
        blocks: [
          { key: "PAY-1", overridden: false },
          { key: "PAY-3", overridden: false },
        ],
      },
      {
        key: "SEC-9",
        summary: "Ticket SEC-9",
        jiraStatus: "Done",
        satisfied: true,
        blocks: [{ key: "PAY-2", overridden: false }],
      },
    ]);
    expect(m.startBlocked).toBeNull();
  });

  test("a cycle blocks Start run and says how to fix it", () => {
    expect(boardModel(fixture("cycle")).startBlocked).toBe(
      "Dependency cycle: PAY-1 -> PAY-2 -> PAY-3 -> PAY-1. Override one link, or fix it in Jira and refresh.",
    );
  });

  test("an empty board says to import first", () => {
    const b = fixture("single");
    b.tickets = {};
    expect(boardModel(b).startBlocked).toBe("Import tickets first.");
  });

  test("keys sort numerically and the critical path is marked", () => {
    const m = boardModel(fixture("islands"));
    expect(m.rows.map((r) => r.key)).toEqual(["PAY-1", "PAY-2", "PAY-10", "PAY-11", "PAY-12", "PAY-20"]);
    expect(m.rows.filter((r) => r.critical).map((r) => r.key)).toEqual(["PAY-1", "PAY-2"]);
  });

  test("the same board.json gives the same model: reloading the mod loses nothing", () => {
    const b = fixture("spike-20");
    expect(boardModel(JSON.parse(JSON.stringify(b)))).toEqual(boardModel(b));
  });
});

test("the preparation chip cycles through every status", () => {
  const seen = ["unreviewed"];
  for (let i = 0; i < 5; i++) seen.push(nextPreparation(seen.at(-1) as never));
  expect(seen).toEqual(["unreviewed", "investigating", "needs_input", "ready", "excluded", "unreviewed"]);
});

test.each([
  ["PAY-1, PAY-2", { keys: ["PAY-1", "PAY-2"] }],
  ["pay-3 PAY-3", { keys: ["PAY-3"] }],
  ["project = PAY AND sprint in openSprints()", { jql: "project = PAY AND sprint in openSprints()" }],
  ["   ", null],
] as const)("parseImport(%p)", (text, expected) => {
  expect(parseImport(text)).toEqual(expected as never);
});

test("replies read as sentences", () => {
  expect(
    describeReply("board.import", { ok: true, result: { added: ["A-1", "A-2"], external: ["X-1"] } }),
  ).toBe("Imported 2 ticket(s), and found 1 outside blocker(s).");
  expect(
    describeReply("board.refresh", {
      ok: true,
      result: { changed: ["X-1"], readiness_changed: ["A-3"], missing: [] },
    }),
  ).toBe("Refreshed: X-1 changed in Jira. Readiness changed for A-3.");
  expect(
    describeReply("run.start", { ok: false, error: { code: "cycle_detected", message: "a cycle" } }),
  ).toBe("run.start: a cycle");
});

describe("button actions", () => {
  const BOARD_ID = "01JC8XW0000000000000000001";
  const asCommand = (a: { command: string; args: unknown }) =>
    validateCommand({
      v: 1,
      id: "01JC9A0C000000000000000001",
      command: a.command,
      at: "2026-11-09T10:00:00Z",
      args: a.args,
    });

  test("an outside blocker offers Pull in and an Override for each ticket it holds up", () => {
    const x = boardModel(fixture("external-blockers")).externals[0];
    if (!x) throw new Error("no outside blocker");
    expect(externalActions(BOARD_ID, x).map((a) => [a.id, a.label, a.command, a.args])).toEqual([
      ["pull-OPS-77", "Pull in", "ticket.pull_in", { board_id: BOARD_ID, ticket: "OPS-77" }],
      [
        "ovr-OPS-77-PAY-1",
        "Override → PAY-1",
        "dep.override",
        { board_id: BOARD_ID, blocker: "OPS-77", blocked: "PAY-1" },
      ],
      [
        "ovr-OPS-77-PAY-3",
        "Override → PAY-3",
        "dep.override",
        { board_id: BOARD_ID, blocker: "OPS-77", blocked: "PAY-3" },
      ],
    ]);
  });

  test("an overridden link offers Restore instead", () => {
    const b = fixture("external-blockers");
    b.overrides.push({ blocker: "OPS-77", blocked: "PAY-1", by: "human", at: "2026-11-09T10:00:00Z" });
    const x = boardModel(b).externals[0];
    if (!x) throw new Error("no outside blocker");
    const labels = externalActions(BOARD_ID, x).map((a) => `${a.label} (${a.command})`);
    expect(labels).toContain("Restore → PAY-1 (dep.restore)");
    expect(labels).toContain("Override → PAY-3 (dep.override)");
  });

  test("Exclude and Include flip the ticket's preparation", () => {
    expect(excludeAction(BOARD_ID, "PAY-1", "ready")).toMatchObject({
      label: "Exclude from runs",
      args: { preparation: "excluded" },
    });
    expect(excludeAction(BOARD_ID, "PAY-1", "excluded")).toMatchObject({
      label: "Include again",
      args: { preparation: "unreviewed" },
    });
  });

  test("every button sends a command the controller accepts", () => {
    for (const name of ["external-blockers", "spike-20"]) {
      const m = boardModel(fixture(name));
      const actions = [
        ...m.externals.flatMap((x) => externalActions(BOARD_ID, x)),
        ...m.rows.map((r) => excludeAction(BOARD_ID, r.key, r.preparation)),
      ];
      expect(actions.length).toBeGreaterThan(0);
      for (const a of actions) {
        const r = asCommand(a);
        if (!r.ok) throw new Error(`${a.id}: ${formatIssues(r.issues)}`);
      }
    }
  });
});

describe("a run in progress", () => {
  const RUN = "01JC8YQ0000000000000000001";
  const E1 = "01JC8Z1A000000000000000001";
  const E2 = "01JC8Z1A000000000000000002";
  const view = (status: "running" | "paused" | "completed" = "running"): RunView => ({
    id: RUN,
    number: 3,
    status,
    boardId: "01JC8XW0000000000000000001",
    state: {
      v: 1,
      run_id: RUN,
      last_event_id: null,
      status,
      leases: ["PAY-1", "PAY-2", "PAY-3"],
      tickets: {
        "PAY-1": {
          state: "completed",
          resume_state: null,
          attention: [],
          round: 1,
          branch: "pay-1",
          base: "main",
          executions: [E1],
          pr: null,
        },
        "PAY-2": {
          state: "needs_input",
          resume_state: "in_progress",
          attention: [{ kind: "execution_failed", id: E2 }],
          round: 1,
          branch: "pay-2",
          base: "pay-1",
          executions: [E2],
          pr: null,
        },
        "PAY-3": {
          state: "in_progress",
          resume_state: null,
          attention: [],
          round: 1,
          branch: null,
          base: null,
          executions: [],
          pr: null,
        },
      },
      executions: {
        [E1]: {
          ticket: "PAY-1",
          profile: "developer",
          kind: "develop",
          state: "completed",
          attempt: 1,
          round: 1,
          terminal: "t4",
          nudges: 0,
          started_at: null,
          ended_at: null,
          result: { summary: "Added the table", commits: ["a1b2c3d"] },
        },
        [E2]: {
          ticket: "PAY-2",
          profile: "developer",
          kind: "develop",
          state: "failed",
          attempt: 2,
          round: 1,
          terminal: "t5",
          nudges: 2,
          started_at: null,
          ended_at: null,
          result: { reason: "no report after 2 nudges", category: "tooling", retryable: true },
        },
      },
      questions: {},
      findings: [],
      inbox_offsets: {},
    },
  });

  test("tickets read as words and tones, with their executions", () => {
    const m = runModel(view());
    if (!m) throw new Error("no model");
    expect(m.progress).toBe("1 of 3 done");
    expect(Object.values(m.tickets).map((t) => [t.key, t.label, t.tone])).toEqual([
      ["PAY-1", "Done", "done"],
      ["PAY-2", "Needs you", "blocked"],
      ["PAY-3", "Developing", "working"],
    ]);
    expect(m.tickets["PAY-2"]?.attention).toEqual(["its agent failed with no attempts left"]);
    expect(m.tickets["PAY-1"]?.executions.map((e) => [e.outcome, execLine(e)])).toEqual([
      ["Added the table", "attempt 1 · completed · t4"],
    ]);
    expect(m.tickets["PAY-2"]?.executions.map(execLine)).toEqual(["attempt 2 · failed · t5 · nudged 2×"]);
  });

  test("a blocked agent says what it waits for", () => {
    const v = view();
    const e = v.state.executions[E2];
    if (!e) throw new Error("no execution");
    e.state = "working";
    e.agent_blocked = { kind: "permission", message: "approve Bash: go test" };
    expect(runModel(v)?.tickets["PAY-2"]?.executions[0]?.blocked).toBe(
      "waiting for permission: approve Bash: go test",
    );
  });

  test("Pause, Resume and Cancel follow the run's status", () => {
    const labels = (s: "running" | "paused" | "completed") => runModel(view(s))?.actions.map((a) => a.label);
    expect(labels("running")).toEqual(["Pause run", "Cancel run"]);
    expect(labels("paused")).toEqual(["Resume run", "Cancel run"]);
    expect(labels("completed")).toEqual([]);
  });

  test("Start run is blocked by a cycle, an empty board, or a run already going", () => {
    const board = fixture("single");
    const bm = boardModel(board);
    expect(startAction(board.id, bm, null)).toMatchObject({
      disabled: null,
      action: { command: "run.start" },
    });
    expect(startAction(board.id, boardModel(fixture("cycle")), null).disabled).toContain("Dependency cycle");
    expect(startAction(board.id, bm, runModel(view()))?.disabled).toBe("Run 3 is running.");
    expect(startAction(board.id, bm, runModel(view("completed")))?.disabled).toBeNull();
  });

  test("a held ticket offers Retry; every button sends a command the controller accepts", () => {
    const m = runModel(view());
    if (!m) throw new Error("no model");
    const held = ticketRunActions(RUN, m.tickets["PAY-2"] as never);
    expect(held.map((a) => a.label)).toEqual(["Retry with a new agent", "Cancel ticket"]);
    const running = ticketRunActions(RUN, m.tickets["PAY-3"] as never);
    expect(running.map((a) => a.label)).toEqual(["Cancel ticket"]);
    expect(ticketRunActions(RUN, m.tickets["PAY-1"] as never)).toEqual([]);
    const live = view();
    const e = live.state.executions[E2];
    if (!e) throw new Error("no execution");
    e.state = "working";
    const withLive = runModel(live);
    const stop = ticketRunActions(RUN, withLive?.tickets["PAY-2"] as never);
    expect(stop.map((a) => a.label)).toEqual([
      "Retry with a new agent",
      "Stop agent (attempt 2)",
      "Cancel ticket",
    ]);
    for (const a of [
      ...held,
      ...stop,
      ...(m.actions ?? []),
      startAction("01JC8XW0000000000000000001", { startBlocked: null }, null).action,
    ]) {
      const r = validateCommand({
        v: 1,
        id: "01JC9A0C000000000000000001",
        command: a.command,
        at: "2026-11-09T10:00:00Z",
        args: a.args,
      });
      if (!r.ok) throw new Error(`${a.id}: ${formatIssues(r.issues)}`);
    }
  });

  test("watching an agent peeks at its terminal in Herdr", () => {
    expect(watchCommand("t5")).toEqual({ name: "terminal.peek", args: { terminal: "t5" } });
  });

  test("no run, no model", () => {
    expect(runModel(null)).toBeNull();
  });
});
