// Jira issues -> board tickets. Pure: takes the JSON of `POST /rest/api/3/search/jql` issues
// (fields summary, status, resolution, issuelinks) and returns board tickets.
//
// Only Blocks links affect order (docs/plan.md, Phase 3). On issue A:
//   { type: Blocks, outwardIssue: B }  ->  A blocks B   (B is blocked by A)
//   { type: Blocks, inwardIssue: B }   ->  B blocks A   (A is blocked by B)
// A linked issue's summary and status ride along on the link, so a blocker outside the board
// needs no extra call (its resolution doesn't, so it's null until it's pulled in).
import type { BoardTicket } from "@collie/schema";

export type JiraStatus = { name: string; statusCategory?: { key?: string } };
export type JiraLinkedIssue = { key: string; fields?: { summary?: string; status?: JiraStatus } };
export type JiraLink = {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: JiraLinkedIssue;
  outwardIssue?: JiraLinkedIssue;
};
export type JiraIssue = {
  key: string;
  fields: {
    summary?: string;
    status?: JiraStatus;
    resolution?: { name?: string } | null;
    issuelinks?: JiraLink[];
  };
};

/** The fields Collie asks for in every search. */
export const SEARCH_FIELDS = ["summary", "status", "resolution", "issuelinks"] as const;

/** Whether a link type orders work. Matched by name or its outward verb, so a renamed type still counts. */
export const isBlocksLink = (l: JiraLink) => l.type?.name === "Blocks" || l.type?.outward === "blocks";

const CATEGORIES = ["new", "indeterminate", "done"] as const;
const category = (s?: JiraStatus): BoardTicket["status_category"] => {
  const k = s?.statusCategory?.key;
  return (CATEGORIES as readonly string[]).includes(k ?? "")
    ? (k as BoardTicket["status_category"])
    : "indeterminate";
};

/** Who blocks this issue, and whom it blocks, from its own links. */
export function blockLinks(issue: JiraIssue): { blockedBy: JiraLinkedIssue[]; blocks: JiraLinkedIssue[] } {
  const blockedBy: JiraLinkedIssue[] = [];
  const blocks: JiraLinkedIssue[] = [];
  for (const l of issue.fields.issuelinks ?? []) {
    if (!isBlocksLink(l)) continue;
    if (l.inwardIssue) blockedBy.push(l.inwardIssue);
    if (l.outwardIssue) blocks.push(l.outwardIssue);
  }
  return { blockedBy, blocks };
}

export type ImportResult = {
  /** Every ticket the issues describe: the issues themselves, plus linked issues as external. */
  tickets: Record<string, BoardTicket>;
  /** Keys of the issues fetched (on the board when imported). */
  fetched: string[];
  /** Keys only seen through links. */
  linked: string[];
};

/**
 * Board tickets from fetched issues. A fetched issue's `blocked_by` is the union of its own
 * "is blocked by" links and every other fetched issue's "blocks" link to it, so a link set
 * from either end is seen. Linked-only issues become tickets with on_board: false.
 */
export function ticketsFromIssues(issues: JiraIssue[], fetchedAt: string): ImportResult {
  const tickets: Record<string, BoardTicket> = {};
  const fetched = issues.map((i) => i.key);
  const blockedBy = new Map<string, Set<string>>();
  const add = (blocked: string, blocker: string) => {
    if (blocked === blocker) return;
    const set = blockedBy.get(blocked) ?? new Set<string>();
    set.add(blocker);
    blockedBy.set(blocked, set);
  };
  const linkedSeen = new Map<string, JiraLinkedIssue>();

  for (const issue of issues) {
    const { blockedBy: by, blocks } = blockLinks(issue);
    for (const b of by) {
      add(issue.key, b.key);
      linkedSeen.set(b.key, b);
    }
    for (const b of blocks) {
      add(b.key, issue.key);
      linkedSeen.set(b.key, b);
    }
  }

  for (const issue of issues) {
    tickets[issue.key] = {
      summary: issue.fields.summary ?? "",
      jira_status: issue.fields.status?.name ?? "Unknown",
      status_category: category(issue.fields.status),
      resolution: issue.fields.resolution?.name ?? null,
      blocked_by: [...(blockedBy.get(issue.key) ?? [])].sort(),
      on_board: true,
      preparation: "unreviewed",
      workflow: null,
      fetched_at: fetchedAt,
    };
  }
  const linked: string[] = [];
  for (const [key, l] of linkedSeen) {
    if (tickets[key]) continue;
    linked.push(key);
    tickets[key] = {
      summary: l.fields?.summary ?? "",
      jira_status: l.fields?.status?.name ?? "Unknown",
      status_category: category(l.fields?.status),
      // DECISION: a link doesn't carry resolution; an outside blocker's is null until pulled in.
      resolution: null,
      // Only links among fetched issues are known; an outside ticket's own blockers aren't.
      blocked_by: [...(blockedBy.get(key) ?? [])].sort(),
      on_board: false,
      preparation: "unreviewed",
      workflow: null,
      fetched_at: fetchedAt,
    };
  }
  return { tickets, fetched: fetched.sort(), linked: linked.sort() };
}

/**
 * Merges freshly fetched tickets into a board's tickets. Jira fields (summary, status,
 * resolution, links) come from Jira; Collie's own (on_board, preparation, workflow) are kept.
 * Pass `onBoard` for keys that should now be on the board (an import or a pull-in).
 */
export function mergeTickets(
  current: Record<string, BoardTicket>,
  fresh: ImportResult,
  onBoard: Iterable<string> = [],
): { tickets: Record<string, BoardTicket>; changed: string[] } {
  // A JSON copy, not structuredClone: this package also runs inside the Herdr mod.
  const out: Record<string, BoardTicket> = JSON.parse(JSON.stringify(current));
  const changed: string[] = [];
  const promote = new Set(onBoard);
  for (const [key, t] of Object.entries(fresh.tickets)) {
    const old = out[key];
    const isFetched = fresh.fetched.includes(key);
    const next: BoardTicket = old
      ? {
          ...old,
          summary: t.summary || old.summary,
          jira_status: t.jira_status,
          status_category: t.status_category,
          // A link carries no resolution: keep the fetched one for a ticket seen only via a link.
          resolution: isFetched ? t.resolution : old.resolution,
          // Only a fetched issue's links are complete; a linked-only view would drop blockers.
          blocked_by: isFetched ? t.blocked_by : [...new Set([...old.blocked_by, ...t.blocked_by])].sort(),
          on_board: old.on_board || promote.has(key),
          fetched_at: t.fetched_at,
        }
      : { ...t, on_board: promote.has(key) };
    if (!old || JSON.stringify(stripTime(old)) !== JSON.stringify(stripTime(next))) changed.push(key);
    out[key] = next;
  }
  return { tickets: out, changed: changed.sort() };
}

const stripTime = (t: BoardTicket) => ({ ...t, fetched_at: "" });
