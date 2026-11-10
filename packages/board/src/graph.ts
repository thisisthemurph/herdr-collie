// The dependency graph of a board: edges from blockers to the tickets they block, cycles,
// readiness and the critical path. Pure functions over board tickets.
import type { Board, BoardSettings, BoardTicket } from "@collie/schema";

export type Edge = { from: string; to: string; overridden: boolean; external: boolean };

/** Tickets in the run: on the board and not excluded. */
export const inScope = (t: BoardTicket) => t.on_board && t.preparation !== "excluded";

const isOverridden = (board: Pick<Board, "overrides">, blocker: string, blocked: string) =>
  board.overrides.some((o) => o.blocker === blocker && o.blocked === blocked);

/**
 * Every blocking edge into an on-board ticket. Blockers Collie doesn't know at all (no
 * ticket entry) are left out; an outside blocker has an entry with on_board: false.
 */
export function edges(board: Pick<Board, "tickets" | "overrides">): Edge[] {
  const out: Edge[] = [];
  for (const [key, t] of Object.entries(board.tickets).sort(([a], [b]) => a.localeCompare(b))) {
    if (!t.on_board) continue;
    for (const blocker of t.blocked_by) {
      const b = board.tickets[blocker];
      if (!b) continue;
      out.push({
        from: blocker,
        to: key,
        overridden: isOverridden(board, blocker, key),
        external: !b.on_board,
      });
    }
  }
  return out;
}

/**
 * Dependency cycles among the board's in-scope tickets (Tarjan's strongly connected
 * components). Each cycle is listed from its smallest key, in blocking order. Overridden
 * links don't count: overriding one link is how a person breaks a cycle.
 */
export function findCycles(board: Pick<Board, "tickets" | "overrides">): string[][] {
  const keys = Object.keys(board.tickets)
    .filter((k) => inScope(board.tickets[k] as BoardTicket))
    .sort();
  const inSet = new Set(keys);
  const next = new Map<string, string[]>(keys.map((k) => [k, []]));
  for (const e of edges(board)) {
    if (!e.overridden && inSet.has(e.from) && inSet.has(e.to)) next.get(e.from)?.push(e.to);
  }
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccs: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) as number, idx.get(w) as number));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || next.get(v)?.includes(v)) sccs.push(scc);
    }
  };
  for (const k of keys) if (!idx.has(k)) visit(k);
  // Order each cycle along its edges, starting from its smallest key.
  return sccs
    .map((scc) => {
      const members = new Set(scc);
      const start = [...scc].sort()[0] as string;
      const path = [start];
      for (let cur = start; path.length < scc.length; ) {
        const n = (next.get(cur) ?? []).filter((x) => members.has(x) && !path.includes(x)).sort()[0];
        if (!n) break;
        path.push(n);
        cur = n;
      }
      return path.length === scc.length ? path : [...scc].sort();
    })
    .sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
}

export const describeCycle = (cycle: string[]) => [...cycle, cycle[0]].join(" -> ");

/**
 * Whether a ticket outside the run counts as done, by the board's completion policy
 * (docs/protocol.md, "Board"): statusCategory done; or resolved; or a testing status; or
 * one of a custom list of status names.
 */
export function satisfiesPolicy(t: BoardTicket, policy: BoardSettings["completion_policy"]): boolean {
  const name = t.jira_status.toLowerCase();
  switch (policy.mode) {
    case "done_only":
      return t.status_category === "done";
    case "done_or_resolved":
      return t.status_category === "done" || t.resolution !== null;
    case "done_or_testing":
      // DECISION: a "testing" status is any whose name mentions test or QA.
      return t.status_category === "done" || /\btest|\bqa\b/.test(name);
    case "custom":
      return policy.statuses.some((s) => s.toLowerCase() === name);
  }
}

export type BlockerState = {
  key: string;
  /** satisfied: done by policy or completed in the run; overridden: ignored by a person. */
  status: "satisfied" | "overridden" | "waiting" | "unknown";
  external: boolean;
};

export type Readiness = {
  key: string;
  /** excluded / pending (not prepared) / blocked / ready. */
  state: "excluded" | "pending" | "blocked" | "ready";
  blockers: BlockerState[];
};

/**
 * Readiness of every on-board ticket (docs/protocol.md, "Ticket" state machine).
 * `runStates` gives in-run tickets' states: an in-run blocker is satisfied once it is
 * completed (it only completes on reaching the board's complete_at). Without it (board
 * setup, before a run), an on-board blocker is satisfied by the completion policy.
 */
export function readiness(
  board: Pick<Board, "tickets" | "overrides" | "settings">,
  runStates?: Record<string, string>,
): Record<string, Readiness> {
  const out: Record<string, Readiness> = {};
  for (const [key, t] of Object.entries(board.tickets).sort(([a], [b]) => a.localeCompare(b))) {
    if (!t.on_board) continue;
    const blockers: BlockerState[] = t.blocked_by.map((b) => {
      const bt = board.tickets[b];
      const external = !bt?.on_board || bt.preparation === "excluded";
      if (isOverridden(board, b, key)) return { key: b, status: "overridden", external };
      if (!bt) return { key: b, status: "unknown", external: true };
      const inRun = runStates && !external ? runStates[b] : undefined;
      const done =
        inRun !== undefined ? inRun === "completed" : satisfiesPolicy(bt, board.settings.completion_policy);
      return { key: b, status: done ? "satisfied" : "waiting", external };
    });
    const state: Readiness["state"] =
      t.preparation === "excluded"
        ? "excluded"
        : t.preparation !== "ready"
          ? "pending"
          : blockers.every((b) => b.status === "satisfied" || b.status === "overridden")
            ? "ready"
            : "blocked";
    out[key] = { key, state, blockers };
  }
  return out;
}

/**
 * The critical path: the longest chain of unfinished in-scope tickets, following blocking
 * edges (not overridden). Ties go to the chain whose keys sort first. Empty with a cycle.
 */
export function criticalPath(board: Pick<Board, "tickets" | "overrides" | "settings">): string[] {
  if (findCycles(board).length) return [];
  const unfinished = (k: string) => {
    const t = board.tickets[k];
    return !!t && inScope(t) && !satisfiesPolicy(t, board.settings.completion_policy);
  };
  const next = new Map<string, string[]>();
  for (const e of edges(board)) {
    if (e.overridden || !unfinished(e.from) || !unfinished(e.to)) continue;
    next.set(e.from, [...(next.get(e.from) ?? []), e.to].sort());
  }
  const memo = new Map<string, string[]>();
  const longestFrom = (k: string): string[] => {
    const hit = memo.get(k);
    if (hit) return hit;
    let best: string[] = [];
    for (const n of next.get(k) ?? []) {
      const p = longestFrom(n);
      if (p.length > best.length) best = p;
    }
    const path = [k, ...best];
    memo.set(k, path);
    return path;
  };
  let best: string[] = [];
  for (const k of Object.keys(board.tickets).filter(unfinished).sort()) {
    const p = longestFrom(k);
    if (p.length > best.length) best = p;
  }
  return best.length > 1 ? best : [];
}
