// Board commands that talk to Jira, and readiness inside a running run (docs/plan.md, Phase 3).
import { describeCycle, findCycles, mergeTickets, readiness, ticketsFromIssues } from "@collie/board";
import type { AnyEvent, Board, TicketState } from "@collie/schema";
import { CommandError, type Controller, isoSeconds, type Ok } from "./controller.ts";
import type { RunLog } from "./runlog.ts";

export function requireNoCycle(board: Pick<Board, "tickets" | "overrides">): void {
  const cycles = findCycles(board);
  if (cycles.length) {
    throw new CommandError(
      "cycle_detected",
      `the board's dependencies have ${cycles.length === 1 ? "a cycle" : `${cycles.length} cycles`}: ${cycles.map(describeCycle).join("; ")}. Remove a link in Jira and refresh, or override one link.`,
    );
  }
}

/** board.import: adds the issues to the board (on_board) and their outside blockers (off it). */
export async function boardImport(
  c: Controller,
  boardId: string,
  a: { keys?: string[]; jql?: string },
): Promise<Ok> {
  const board = c.loadBoard(boardId);
  const jira = c.requireJira();
  const issues = a.keys
    ? await jira.issues(board.jira.cloud_id, a.keys)
    : await jira.search(board.jira.cloud_id, a.jql as string);
  if (a.keys) {
    const found = new Set(issues.map((i) => i.key));
    const missing = a.keys.filter((k) => !found.has(k));
    if (missing.length)
      throw new CommandError(
        "not_found",
        `Jira has no issue ${missing.join(", ")} (or this token can't see it)`,
      );
  }
  const fresh = ticketsFromIssues(issues, isoSeconds(c.clock.now()));
  const before = c.loadBoard(boardId); // re-read: another command may have saved meanwhile
  const merged = mergeTickets(before.tickets, fresh, fresh.fetched);
  const added = fresh.fetched.filter((k) => !before.tickets[k]?.on_board);
  const external = fresh.linked.filter((k) => !before.tickets[k] && !merged.tickets[k]?.on_board);
  c.saveBoard({ ...before, tickets: merged.tickets });
  reevaluateRun(c, boardId, null);
  return { added, external };
}

/** board.refresh: re-reads every ticket on the board, and every outside blocker, from Jira. */
export async function boardRefresh(c: Controller, boardId: string, cause: string): Promise<Ok> {
  const board = c.loadBoard(boardId);
  const keys = Object.keys(board.tickets).sort();
  const issues = keys.length ? await c.requireJira().issues(board.jira.cloud_id, keys) : [];
  const fresh = ticketsFromIssues(issues, isoSeconds(c.clock.now()));
  const before = c.loadBoard(boardId);
  const merged = mergeTickets(before.tickets, fresh);
  const found = new Set(issues.map((i) => i.key));
  c.saveBoard({ ...before, tickets: merged.tickets });
  const moved = reevaluateRun(c, boardId, cause);
  return { changed: merged.changed, missing: keys.filter((k) => !found.has(k)), readiness_changed: moved };
}

/** ticket.pull_in: an outside blocker joins the board, with its own links fetched. */
export async function pullIn(c: Controller, boardId: string, key: string): Promise<Ok> {
  const board = c.loadBoard(boardId);
  const t = board.tickets[key];
  if (!t) throw new CommandError("not_found", `${key} is not on board ${boardId}, not even as a blocker`);
  if (t.on_board) throw new CommandError("invalid_state", `${key} is already on the board`);
  const issues = await c.requireJira().issues(board.jira.cloud_id, [key]);
  const fresh = ticketsFromIssues(issues, isoSeconds(c.clock.now()));
  const before = c.loadBoard(boardId);
  const merged = mergeTickets(before.tickets, fresh, [key]);
  const ticket = merged.tickets[key];
  if (ticket) ticket.on_board = true;
  c.saveBoard({ ...before, tickets: merged.tickets });
  reevaluateRun(c, boardId, null);
  const added = fresh.linked.filter((k) => !before.tickets[k]);
  return { added: [key], external: added };
}

/**
 * The readiness transitions a run's tickets need now (protocol, "Ticket" state machine):
 * pending -> blocked/ready, blocked -> ready, ready -> blocked. Outside blockers use the
 * board's current Jira data and overrides; in-run blockers count once completed in the run.
 * Once a ticket leaves `ready`, regressions are only logged (the protocol's rule).
 */
export function readinessEvents(c: Controller, rl: RunLog, board: Board, cause: string | null): AnyEvent[] {
  const leased = new Set(rl.state.leases);
  // The run's tickets as the board has them now, with off-run tickets marked off-board so
  // they count as outside blockers.
  const view: Board = {
    ...board,
    tickets: Object.fromEntries(
      Object.entries(board.tickets).map(([k, t]) => [k, { ...t, on_board: leased.has(k) }]),
    ),
  };
  const runStates = Object.fromEntries(Object.entries(rl.state.tickets).map(([k, t]) => [k, t.state]));
  const r = readiness(view, runStates);
  const out: AnyEvent[] = [];
  for (const key of [...leased].sort()) {
    const now = rl.state.tickets[key]?.state as TicketState | undefined;
    const want = r[key]?.state;
    if (!now || !want) continue;
    const waiting =
      r[key]?.blockers.filter((b) => b.status === "waiting" || b.status === "unknown").map((b) => b.key) ??
      [];
    let to: TicketState | null = null;
    if (now === "pending" && (want === "ready" || want === "blocked")) to = want;
    else if (now === "blocked" && want === "ready") to = "ready";
    else if (now === "ready" && want === "blocked") to = "blocked";
    if (!to) continue;
    const reason = to === "ready" ? "every blocker is satisfied" : `waiting on ${waiting.join(", ")}`;
    out.push(c.ticketTo(rl, key, to, reason, { cause }));
  }
  return out;
}

/** Re-checks readiness in the board's active run, if there is one. Returns the tickets moved. */
export function reevaluateRun(c: Controller, boardId: string, cause: string | null): string[] {
  const rl = [...c.runs.values()].find((r) => r.run.board_id === boardId);
  if (!rl || rl.state.status === "completed" || rl.state.status === "cancelled") return [];
  const events = readinessEvents(c, rl, c.loadBoard(boardId), cause);
  c.emit(rl, events);
  return events.map((e) => e.ticket as string);
}
