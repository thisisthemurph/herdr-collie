// Which ready tickets start next (docs/plan.md, Phase 4: "Scheduler priority"). Pure: the
// controller passes in the run's state and gets back a dispatch order.
//
// Priority, in order:
//   1. tickets on the critical path (the longest chain of unfinished tickets in the run);
//   2. the most downstream work unblocked (unfinished tickets that depend on it, directly or not);
//   3. the longest wait in `ready`;
//   4. the key, so equal tickets always come out in the same order.

export type ScheduleTicket = { state: string; blocked_by: string[] };

export type ScheduleInput = {
  /** Every ticket of the run, with its run state and its blockers (any may be outside the run). */
  tickets: Record<string, ScheduleTicket>;
  /** Links a person overrode, which order nothing. */
  overrides: { blocker: string; blocked: string }[];
  /** When each ready ticket became ready (ms). A ticket with no entry waits the least. */
  readySince?: Record<string, number>;
  /** Tickets in flight: in_progress, reviewing, remediating, delivering, needs_input, or launching. */
  active: number;
  /** Agent terminals live or starting. */
  agents: number;
  /** Board settings: how many tickets and agents may run at once. */
  maxTickets: number;
  maxAgents: number;
  /** Agents one dispatch starts (1 for a developer-only workflow). */
  agentsPerTicket?: number;
  paused?: boolean;
};

export type Ranked = {
  key: string;
  critical: boolean;
  downstream: number;
  waitingSince: number | null;
};

const FINAL = new Set(["completed", "cancelled"]);

/** The ready tickets in the order they should start, before any limit is applied. */
export function rankReady(input: ScheduleInput): Ranked[] {
  const open = Object.entries(input.tickets)
    .filter(([, t]) => !FINAL.has(t.state))
    .map(([k]) => k);
  const isOpen = new Set(open);
  const overridden = new Set(input.overrides.map((o) => `${o.blocker}\u0000${o.blocked}`));

  // blocker -> the open tickets it blocks, ignoring overridden links
  const dependents = new Map<string, string[]>(open.map((k) => [k, []]));
  const blockers = new Map<string, string[]>(open.map((k) => [k, []]));
  for (const k of open) {
    for (const b of input.tickets[k]?.blocked_by ?? []) {
      if (!isOpen.has(b) || overridden.has(`${b}\u0000${k}`)) continue;
      dependents.get(b)?.push(k);
      blockers.get(k)?.push(b);
    }
  }

  // Longest chain (in tickets) ending at, and starting from, each ticket. A cycle would loop
  // forever, so the walk gives up on a ticket it is already inside (run.start refuses cycles).
  const memo = (next: Map<string, string[]>) => {
    const cache = new Map<string, number>();
    const go = (k: string, seen: Set<string>): number => {
      const hit = cache.get(k);
      if (hit !== undefined) return hit;
      if (seen.has(k)) return 0;
      seen.add(k);
      let best = 0;
      for (const n of next.get(k) ?? []) best = Math.max(best, go(n, seen));
      seen.delete(k);
      cache.set(k, best + 1);
      return best + 1;
    };
    return (k: string) => go(k, new Set());
  };
  const down = memo(dependents);
  const up = memo(blockers);
  const longest = Math.max(0, ...open.map((k) => up(k) + down(k) - 1));

  const reach = (k: string): number => {
    const seen = new Set<string>();
    const walk = (x: string) => {
      for (const n of dependents.get(x) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          walk(n);
        }
      }
    };
    walk(k);
    return seen.size;
  };

  return open
    .filter((k) => input.tickets[k]?.state === "ready")
    .map((key) => ({
      key,
      // A lone ticket is a chain of one: it is "critical" only when nothing is longer.
      critical: longest > 0 && up(key) + down(key) - 1 === longest,
      downstream: reach(key),
      waitingSince: input.readySince?.[key] ?? null,
    }))
    .sort(
      (a, b) =>
        Number(b.critical) - Number(a.critical) ||
        b.downstream - a.downstream ||
        (a.waitingSince ?? Number.POSITIVE_INFINITY) - (b.waitingSince ?? Number.POSITIVE_INFINITY) ||
        a.key.localeCompare(b.key, undefined, { numeric: true }),
    );
}

/** The tickets to start now: the ranked ready ones, as many as the ticket and agent limits allow. */
export function dispatchNow(input: ScheduleInput): string[] {
  if (input.paused) return [];
  const per = Math.max(1, input.agentsPerTicket ?? 1);
  const ticketRoom = Math.max(0, input.maxTickets - input.active);
  const agentRoom = Math.max(0, Math.floor((input.maxAgents - input.agents) / per));
  return rankReady(input)
    .slice(0, Math.min(ticketRoom, agentRoom))
    .map((r) => r.key);
}
