import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "@collie/schema";
import {
  criticalPath,
  describeCycle,
  edges,
  findCycles,
  type JiraIssue,
  mergeTickets,
  readiness,
  satisfiesPolicy,
  ticketsFromIssues,
} from "../src/index.ts";

const fixture = (name: string): Board =>
  JSON.parse(readFileSync(join(import.meta.dir, `../../../fixtures/boards/${name}.json`), "utf8"));

const issue = (
  key: string,
  links: JiraIssue["fields"]["issuelinks"] = [],
  status = "To Do",
  cat = "new",
): JiraIssue => ({
  key,
  fields: {
    summary: `S ${key}`,
    status: { name: status, statusCategory: { key: cat } },
    resolution: null,
    issuelinks: links,
  },
});
const blocks = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
const linked = (key: string, status = "To Do", cat = "new") => ({
  key,
  fields: { summary: `S ${key}`, status: { name: status, statusCategory: { key: cat } } },
});

describe("Jira links", () => {
  test("outwardIssue on A means A blocks B; inwardIssue on A means B blocks A", () => {
    const r = ticketsFromIssues(
      [
        issue("A-1", [{ type: blocks, outwardIssue: linked("A-2") }]),
        issue("A-2", [{ type: blocks, inwardIssue: linked("A-1") }]),
        issue("A-3", [{ type: blocks, inwardIssue: linked("X-9", "Done", "done") }]),
      ],
      "2026-11-09T10:00:00Z",
    );
    expect(r.tickets["A-2"]?.blocked_by).toEqual(["A-1"]);
    expect(r.tickets["A-1"]?.blocked_by).toEqual([]);
    expect(r.tickets["A-3"]?.blocked_by).toEqual(["X-9"]);
    expect(r.linked).toEqual(["X-9"]);
    expect(r.tickets["X-9"]).toMatchObject({
      on_board: false,
      jira_status: "Done",
      status_category: "done",
      resolution: null,
    });
  });

  test("a link seen from only one end still counts", () => {
    const r = ticketsFromIssues(
      [issue("A-1", [{ type: blocks, outwardIssue: linked("A-2") }]), issue("A-2")],
      "t",
    );
    expect(r.tickets["A-2"]?.blocked_by).toEqual(["A-1"]);
  });

  test("only Blocks links order work", () => {
    const r = ticketsFromIssues(
      [
        issue("A-1", [
          {
            type: { name: "Relates", inward: "relates to", outward: "relates to" },
            inwardIssue: linked("A-2"),
          },
        ]),
        issue("A-2"),
      ],
      "t",
    );
    expect(r.tickets["A-1"]?.blocked_by).toEqual([]);
    expect(r.linked).toEqual([]);
  });

  test("merging keeps Collie's fields and reports what changed", () => {
    const board = fixture("chain");
    const fresh = ticketsFromIssues(
      [issue("PAY-2", [{ type: blocks, inwardIssue: linked("PAY-1") }], "Done", "done")],
      "2026-11-09T11:00:00Z",
    );
    const m = mergeTickets(board.tickets, fresh);
    expect(m.tickets["PAY-2"]).toMatchObject({
      jira_status: "Done",
      status_category: "done",
      preparation: "ready",
      on_board: true,
    });
    // PAY-1's summary arrives via the link and differs from the board's, so it changed too.
    expect(m.changed).toEqual(["PAY-1", "PAY-2"]);
    // PAY-1 is only seen via a link: its status updates, its own blockers are kept.
    expect(m.tickets["PAY-1"]?.blocked_by).toEqual([]);
  });
});

describe("graph", () => {
  test("edges run blocker -> blocked and flag external and overridden ones", () => {
    const b = fixture("external-blockers");
    expect(edges(b).map((e) => `${e.from}>${e.to}${e.external ? " ext" : ""}`)).toEqual([
      "OPS-77>PAY-1 ext",
      "PAY-1>PAY-2",
      "SEC-9>PAY-2 ext",
      "OPS-77>PAY-3 ext",
      "PAY-2>PAY-3",
    ]);
  });

  test("cycles are found, ordered along the links, and broken by an override", () => {
    expect(findCycles(fixture("cycle"))).toEqual([["PAY-1", "PAY-2", "PAY-3"]]);
    expect(describeCycle(["PAY-1", "PAY-2", "PAY-3"])).toBe("PAY-1 -> PAY-2 -> PAY-3 -> PAY-1");
    expect(findCycles(fixture("cycle-overridden"))).toEqual([]);
    expect(findCycles(fixture("random-40"))).toEqual([]);
  });

  test("a self-link is a cycle", () => {
    const b = fixture("single");
    (b.tickets["PAY-1"] as Board["tickets"][string]).blocked_by = ["PAY-1"];
    expect(findCycles(b)).toEqual([["PAY-1"]]);
  });

  test("the critical path is the longest unfinished chain", () => {
    expect(criticalPath(fixture("chain"))).toEqual(["PAY-1", "PAY-2", "PAY-3", "PAY-4"]);
    expect(criticalPath(fixture("long-edges"))).toEqual(["PAY-1", "PAY-2", "PAY-3", "PAY-4", "PAY-5"]);
    expect(criticalPath(fixture("cycle"))).toEqual([]);
  });
});

describe("readiness", () => {
  test("a ticket is ready when every blocker is satisfied or overridden", () => {
    const r = readiness(fixture("external-blockers"));
    expect(r["PAY-1"]).toMatchObject({
      state: "blocked",
      blockers: [{ key: "OPS-77", status: "waiting", external: true }],
    });
    expect(r["PAY-2"]?.state).toBe("blocked"); // PAY-1 not done; SEC-9 done
    expect(r["PAY-2"]?.blockers.map((b) => b.status)).toEqual(["waiting", "satisfied"]);
  });

  test("an override satisfies a link; preparation gates readiness", () => {
    const b = fixture("external-blockers");
    b.overrides.push({ blocker: "OPS-77", blocked: "PAY-1", by: "human", at: "2026-11-09T10:00:00Z" });
    expect(readiness(b)["PAY-1"]?.state).toBe("ready");
    (b.tickets["PAY-1"] as Board["tickets"][string]).preparation = "needs_input";
    expect(readiness(b)["PAY-1"]?.state).toBe("pending");
    (b.tickets["PAY-1"] as Board["tickets"][string]).preparation = "excluded";
    expect(readiness(b)["PAY-1"]?.state).toBe("excluded");
  });

  test("in a run, an on-board blocker counts only once it is completed in the run", () => {
    const b = fixture("chain");
    expect(readiness(b, { "PAY-1": "in_progress" })["PAY-2"]?.state).toBe("blocked");
    expect(readiness(b, { "PAY-1": "completed" })["PAY-2"]?.state).toBe("ready");
  });

  test.each([
    ["done_only", "Done", "done", null, true],
    ["done_only", "Won't Do", "done", "Won't Do", true],
    ["done_only", "In Review", "indeterminate", null, false],
    ["done_or_resolved", "Closed", "indeterminate", "Fixed", true],
    ["done_or_resolved", "In Review", "indeterminate", null, false],
    ["done_or_testing", "In Testing", "indeterminate", null, true],
    ["done_or_testing", "Ready for QA", "indeterminate", null, true],
    ["done_or_testing", "In Progress", "indeterminate", null, false],
    ["custom", "Deployed", "indeterminate", null, true],
    ["custom", "Done", "done", null, false],
  ] as const)("%s: %s (%s, resolution %s) -> %s", (mode, status, cat, resolution, expected) => {
    const t = {
      ...fixture("single").tickets["PAY-1"],
      jira_status: status,
      status_category: cat,
      resolution,
    } as Board["tickets"][string];
    expect(satisfiesPolicy(t, { mode, statuses: mode === "custom" ? ["Deployed"] : [] })).toBe(expected);
  });
});
