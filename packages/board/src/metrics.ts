// Run metrics (docs/plan.md, Phase 7): how much of a run needed a person, and how fast it got
// to PRs. Pure, computed from a run's events, so the mod's Activity view and the tests agree.

/** The few fields of an event the metrics read. */
export type MetricEvent = {
  type: string;
  ts: string;
  source: string;
  ticket: string | null;
  payload: Record<string, unknown>;
};

export type TicketMetrics = {
  ticket: string;
  completed: boolean;
  /** Events a person caused on this ticket: answers, retries, cancels. */
  interventions: number;
  /** Milliseconds from the first agent starting to the PR opening; null without a PR. */
  timeToPrMs: number | null;
  /** Remediation rounds that ran. */
  remediations: number;
};

export type RunMetrics = {
  tickets: TicketMetrics[];
  /** Tickets that completed and never needed a person. */
  completedWithoutIntervention: number;
  completed: number;
  total: number;
  /** Interventions divided by tickets (0 for a run with none). */
  interventionsPerTicket: number;
  /** Median time to PR in ms over the tickets that got one; null when none did. */
  medianTimeToPrMs: number | null;
  /** Of the tickets that needed remediation, how many were not cancelled or failed afterwards. */
  remediation: { tickets: number; succeeded: number };
};

// A command's own record (`command.applied`) has no ticket; every other human-sourced event on a
// ticket is something a person did to it. DECISION: that is what "intervention" means.
export function computeMetrics(events: MetricEvent[]): RunMetrics {
  const by = new Map<string, TicketMetrics & { startedAt: number | null; last: string }>();
  const get = (key: string) => {
    let t = by.get(key);
    if (!t) {
      t = {
        ticket: key,
        completed: false,
        interventions: 0,
        timeToPrMs: null,
        remediations: 0,
        startedAt: null,
        last: "pending",
      };
      by.set(key, t);
    }
    return t;
  };
  for (const e of events) {
    if (!e.ticket) continue;
    const t = get(e.ticket);
    const at = Date.parse(e.ts);
    if (e.source === "human" && e.type !== "command.applied" && e.type !== "command.rejected")
      t.interventions++;
    if (e.type === "execution.started" && t.startedAt === null) t.startedAt = at;
    if (e.type === "execution.created" && e.payload.kind === "remediate" && e.payload.attempt === 1)
      t.remediations++;
    if (e.type === "pr.created" && t.startedAt !== null && t.timeToPrMs === null)
      t.timeToPrMs = Math.max(0, at - t.startedAt);
    if (e.type === "ticket.state_changed") t.last = String(e.payload.to);
  }
  const tickets = [...by.values()].map(({ startedAt: _s, last, ...t }) => ({
    ...t,
    completed: last === "completed",
  }));
  const last = new Map([...by.values()].map((t) => [t.ticket, t.last]));
  const completed = tickets.filter((t) => t.completed);
  const times = tickets.flatMap((t) => (t.timeToPrMs === null ? [] : [t.timeToPrMs])).sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  const remediated = tickets.filter((t) => t.remediations > 0);
  return {
    tickets,
    completedWithoutIntervention: completed.filter((t) => t.interventions === 0).length,
    completed: completed.length,
    total: tickets.length,
    interventionsPerTicket: tickets.length
      ? tickets.reduce((n, t) => n + t.interventions, 0) / tickets.length
      : 0,
    medianTimeToPrMs: times.length
      ? times.length % 2
        ? (times[mid] as number)
        : ((times[mid - 1] as number) + (times[mid] as number)) / 2
      : null,
    remediation: {
      tickets: remediated.length,
      succeeded: remediated.filter(
        (t) => !["cancelled", "needs_input", "failed"].includes(last.get(t.ticket) ?? ""),
      ).length,
    },
  };
}
