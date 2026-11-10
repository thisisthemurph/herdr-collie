import { describe, expect, test } from "bun:test";
import { dispatchNow, rankReady, type ScheduleInput } from "../src/schedule.ts";

const base = (tickets: ScheduleInput["tickets"], extra: Partial<ScheduleInput> = {}): ScheduleInput => ({
  tickets,
  overrides: [],
  active: 0,
  agents: 0,
  maxTickets: 10,
  maxAgents: 10,
  ...extra,
});
const t = (state: string, blocked_by: string[] = []) => ({ state, blocked_by });

describe("priority", () => {
  test("the critical path starts first, whatever the keys say", () => {
    // A-1 -> A-2 -> A-3 is the longest chain; B-1 stands alone.
    const order = rankReady(
      base({
        "A-1": t("ready"),
        "A-2": t("blocked", ["A-1"]),
        "A-3": t("blocked", ["A-2"]),
        "B-1": t("ready"),
      }),
    );
    expect(order.map((r) => [r.key, r.critical])).toEqual([
      ["A-1", true],
      ["B-1", false],
    ]);
    // and with the keys the other way round
    const flipped = rankReady(
      base({
        "Z-1": t("ready"),
        "Z-2": t("blocked", ["Z-1"]),
        "Z-3": t("blocked", ["Z-2"]),
        "A-9": t("ready"),
      }),
    );
    expect(flipped.map((r) => r.key)).toEqual(["Z-1", "A-9"]);
  });

  test("then the most downstream work unblocked", () => {
    // Two equally short chains: X-1 unblocks three tickets, Y-1 one.
    const order = rankReady(
      base({
        "X-1": t("ready"),
        "X-2": t("blocked", ["X-1"]),
        "X-3": t("blocked", ["X-1"]),
        "X-4": t("blocked", ["X-1"]),
        "Y-1": t("ready"),
        "Y-2": t("blocked", ["Y-1"]),
      }),
    );
    expect(order.map((r) => [r.key, r.downstream])).toEqual([
      ["X-1", 3],
      ["Y-1", 1],
    ]);
  });

  test("then the longest waiting, then the key", () => {
    const tickets = { "P-1": t("ready"), "P-2": t("ready"), "P-3": t("ready") };
    expect(
      rankReady(base(tickets, { readySince: { "P-1": 300, "P-2": 100, "P-3": 200 } })).map((r) => r.key),
    ).toEqual(["P-2", "P-3", "P-1"]);
    expect(rankReady(base(tickets)).map((r) => r.key)).toEqual(["P-1", "P-2", "P-3"]);
  });

  test("keys sort numerically", () => {
    expect(rankReady(base({ "P-10": t("ready"), "P-9": t("ready") })).map((r) => r.key)).toEqual([
      "P-9",
      "P-10",
    ]);
  });

  test("finished tickets and overridden links don't count", () => {
    // P-1 is done, so P-2's chain is one long; the overridden link doesn't lengthen Q-1's.
    const order = rankReady(
      base(
        {
          "P-1": t("completed"),
          "P-2": t("ready", ["P-1"]),
          "Q-1": t("ready"),
          "Q-2": t("blocked", ["Q-1"]),
        },
        { overrides: [{ blocker: "Q-1", blocked: "Q-2" }] },
      ),
    );
    expect(order.map((r) => [r.key, r.downstream])).toEqual([
      ["P-2", 0],
      ["Q-1", 0],
    ]);
  });

  test("a cycle can't hang it", () => {
    const order = rankReady(base({ "C-1": t("ready", ["C-2"]), "C-2": t("blocked", ["C-1"]) }));
    expect(order.map((r) => r.key)).toEqual(["C-1"]);
  });
});

describe("limits", () => {
  const four = { "T-1": t("ready"), "T-2": t("ready"), "T-3": t("ready"), "T-4": t("ready") };

  test("ticket limit, counting tickets already in flight", () => {
    expect(dispatchNow(base(four, { maxTickets: 3, active: 1 }))).toEqual(["T-1", "T-2"]);
    expect(dispatchNow(base(four, { maxTickets: 3, active: 3 }))).toEqual([]);
  });

  test("agent limit", () => {
    expect(dispatchNow(base(four, { maxAgents: 2, agents: 1 }))).toEqual(["T-1"]);
    expect(dispatchNow(base(four, { maxAgents: 4, agents: 1, agentsPerTicket: 2 }))).toEqual(["T-1"]);
  });

  test("a paused run starts nothing", () => {
    expect(dispatchNow(base(four, { paused: true }))).toEqual([]);
  });

  test("only ready tickets start", () => {
    expect(dispatchNow(base({ "T-1": t("blocked"), "T-2": t("pending"), "T-3": t("in_progress") }))).toEqual(
      [],
    );
  });
});
