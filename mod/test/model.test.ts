import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "@collie/schema";
import { formatIssues, validateCommand } from "@collie/schema";
import {
  boardModel,
  describeReply,
  excludeAction,
  externalActions,
  nextPreparation,
  parseImport,
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
