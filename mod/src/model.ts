// The Collie mod's view model: everything the Board setup and Graph screens show, worked out
// from a board.json. Pure (no Herdr calls), so it is unit-tested apart from rendering.
import {
  criticalPath,
  describeCycle,
  edges,
  findCycles,
  type Layout,
  layout,
  type Readiness,
  readiness,
  satisfiesPolicy,
} from "@collie/board";
import type { Board, BoardTicket } from "@collie/schema";

export const PREPARATIONS: BoardTicket["preparation"][] = [
  "unreviewed",
  "investigating",
  "needs_input",
  "ready",
  "excluded",
];

/** The next preparation status when the chip is clicked (set by hand in Phase 3). */
export const nextPreparation = (p: BoardTicket["preparation"]) =>
  PREPARATIONS[(PREPARATIONS.indexOf(p) + 1) % PREPARATIONS.length] as BoardTicket["preparation"];

export type TicketRow = {
  key: string;
  summary: string;
  jiraStatus: string;
  preparation: BoardTicket["preparation"];
  readiness: Readiness["state"];
  blockers: Readiness["blockers"];
  critical: boolean;
};

export type ExternalRow = {
  key: string;
  summary: string;
  jiraStatus: string;
  /** Done by the board's completion policy: it no longer holds anything up. */
  satisfied: boolean;
  /** The on-board tickets it blocks, and whether a person overrode that link. */
  blocks: { key: string; overridden: boolean }[];
};

/** A button: what it says, and the `collie ctl` command it runs. */
export type Action = { id: string; label: string; command: string; args: Record<string, unknown> };

/** Pull in, and Override or Restore for each ticket the outside blocker holds up. */
export function externalActions(boardId: string, x: ExternalRow, prefix = ""): Action[] {
  return [
    {
      id: `${prefix}pull-${x.key}`,
      label: "Pull in",
      command: "ticket.pull_in",
      args: { board_id: boardId, ticket: x.key },
    },
    ...x.blocks.map((b) => ({
      id: `${prefix}ovr-${x.key}-${b.key}`,
      label: `${b.overridden ? "Restore" : "Override"} → ${b.key}`,
      command: b.overridden ? "dep.restore" : "dep.override",
      args: { board_id: boardId, blocker: x.key, blocked: b.key },
    })),
  ];
}

/** Exclude a ticket from runs, or include it again. */
export function excludeAction(boardId: string, key: string, preparation: BoardTicket["preparation"]): Action {
  const excluded = preparation === "excluded";
  return {
    id: `exclude-${key}`,
    label: excluded ? "Include again" : "Exclude from runs",
    command: "ticket.set_preparation",
    args: { board_id: boardId, ticket: key, preparation: excluded ? "unreviewed" : "excluded" },
  };
}

export type BoardModel = {
  rows: TicketRow[];
  externals: ExternalRow[];
  cycles: string[][];
  /** Why Start run can't be used, or null when it can (from Phase 4). */
  startBlocked: string | null;
  counts: Record<Readiness["state"], number>;
  layout: Layout;
  critical: string[];
};

export function boardModel(board: Board): BoardModel {
  const r = readiness(board);
  const crit = criticalPath(board);
  const cycles = findCycles(board);
  const rows: TicketRow[] = Object.entries(board.tickets)
    .filter(([, t]) => t.on_board)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, t]) => ({
      key,
      summary: t.summary,
      jiraStatus: t.jira_status,
      preparation: t.preparation,
      readiness: r[key]?.state ?? "pending",
      blockers: r[key]?.blockers ?? [],
      critical: crit.includes(key),
    }));
  const all = edges(board);
  const externals: ExternalRow[] = Object.entries(board.tickets)
    .filter(([key, t]) => !t.on_board && all.some((e) => e.from === key))
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([key, t]) => ({
      key,
      summary: t.summary,
      jiraStatus: t.jira_status,
      satisfied: satisfiesPolicy(t, board.settings.completion_policy),
      blocks: all.filter((e) => e.from === key).map((e) => ({ key: e.to, overridden: e.overridden })),
    }));
  const counts = { excluded: 0, pending: 0, blocked: 0, ready: 0 };
  for (const row of rows) counts[row.readiness] += 1;
  return {
    rows,
    externals,
    cycles,
    startBlocked: cycles.length
      ? `Dependency cycle: ${cycles.map(describeCycle).join("; ")}. Override one link, or fix it in Jira and refresh.`
      : rows.length === 0
        ? "Import tickets first."
        : null,
    counts,
    layout: layout(board),
    critical: crit,
  };
}

const KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

/** What the import box holds: a list of issue keys, or else a JQL query. */
export function parseImport(text: string): { keys: string[] } | { jql: string } | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(/[\s,]+/).filter(Boolean);
  if (parts.every((p) => KEY.test(p.toUpperCase())))
    return { keys: [...new Set(parts.map((p) => p.toUpperCase()))] };
  return { jql: t };
}

/** A short, human line for a `collie ctl` reply (the mod shows it under the header). */
export function describeReply(
  command: string,
  reply: { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string } },
): string {
  if (!reply.ok) return reply.error ? `${command}: ${reply.error.message}` : `${command} failed`;
  const r = reply.result ?? {};
  const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as string[]) : []);
  switch (command) {
    case "board.import":
      return `Imported ${list("added").length} ticket(s)${list("external").length ? `, and found ${list("external").length} outside blocker(s)` : ""}.`;
    case "board.refresh": {
      const changed = list("changed");
      const moved = list("readiness_changed");
      const missing = list("missing");
      return [
        changed.length
          ? `Refreshed: ${changed.join(", ")} changed in Jira.`
          : "Refreshed: nothing changed in Jira.",
        moved.length ? `Readiness changed for ${moved.join(", ")}.` : "",
        missing.length ? `Not found in Jira: ${missing.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" ");
    }
    case "ticket.pull_in":
      return `Pulled ${list("added").join(", ")} onto the board.`;
    case "board.create":
      return "Board created.";
    default:
      return "Done.";
  }
}
