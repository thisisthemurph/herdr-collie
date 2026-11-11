import { describe, expect, test } from "bun:test";
import { computeMetrics, type MetricEvent } from "../src/metrics.ts";

const ev = (
  type: string,
  ts: string,
  ticket: string | null,
  payload: Record<string, unknown> = {},
  source = "controller",
): MetricEvent => ({ type, ts, source, ticket, payload });
const state = (ts: string, ticket: string, to: string, source = "controller") =>
  ev("ticket.state_changed", ts, ticket, { to }, source);

describe("run metrics", () => {
  const events: MetricEvent[] = [
    // A-1: clean run, PR 10 minutes after the agent started.
    ev("execution.started", "2026-11-10T10:00:00Z", "A-1"),
    ev("pr.created", "2026-11-10T10:10:00Z", "A-1"),
    state("2026-11-10T10:10:01Z", "A-1", "completed"),
    // A-2: a person answered a question, one remediation round, PR after 30 minutes.
    ev("execution.started", "2026-11-10T10:00:00Z", "A-2"),
    ev("question.answered", "2026-11-10T10:05:00Z", "A-2", {}, "human"),
    ev("command.applied", "2026-11-10T10:05:00Z", null, {}, "human"),
    ev("execution.created", "2026-11-10T10:20:00Z", "A-2", { kind: "remediate", attempt: 1 }),
    ev("pr.created", "2026-11-10T10:30:00Z", "A-2"),
    state("2026-11-10T10:30:01Z", "A-2", "completed"),
    // A-3: remediation, then held for a person.
    ev("execution.created", "2026-11-10T10:00:00Z", "A-3", { kind: "remediate", attempt: 1 }),
    state("2026-11-10T10:40:00Z", "A-3", "needs_input"),
  ];

  test("counts tickets that completed without a person, and interventions per ticket", () => {
    const m = computeMetrics(events);
    expect(m.total).toBe(3);
    expect(m.completed).toBe(2);
    expect(m.completedWithoutIntervention).toBe(1);
    expect(m.interventionsPerTicket).toBeCloseTo(1 / 3);
  });

  test("time to PR is from the first agent start; the median covers tickets with a PR", () => {
    const m = computeMetrics(events);
    expect(m.tickets.find((t) => t.ticket === "A-1")?.timeToPrMs).toBe(10 * 60_000);
    expect(m.tickets.find((t) => t.ticket === "A-3")?.timeToPrMs).toBeNull();
    expect(m.medianTimeToPrMs).toBe(20 * 60_000);
  });

  test("remediation success: a remediated ticket that ended held doesn't count", () => {
    expect(computeMetrics(events).remediation).toEqual({ tickets: 2, succeeded: 1 });
  });

  test("an empty run has no metrics, not NaN", () => {
    const m = computeMetrics([]);
    expect(m).toMatchObject({ total: 0, interventionsPerTicket: 0, medianTimeToPrMs: null });
  });
});
