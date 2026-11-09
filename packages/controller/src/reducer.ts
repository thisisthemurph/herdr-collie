// state.json from events.jsonl: a pure reducer. The controller applies each event as it
// writes it, and recovery replays the whole log, so the live state and a rebuild are equal
// by construction. Events are trusted here: the controller checked them before writing.
import { type AnyEvent, SCHEMA_VERSION, type StateFile } from "@collie/schema";
import { isExecutionFinal } from "./machines.ts";

type TicketRun = StateFile["tickets"][string];
type ExecRun = StateFile["executions"][string];

export function emptyState(runId: string): StateFile {
  return {
    v: SCHEMA_VERSION,
    run_id: runId,
    last_event_id: null,
    status: "running",
    leases: [],
    tickets: {},
    executions: {},
    questions: {},
    findings: [],
    inbox_offsets: {},
  };
}

const newTicket = (state: TicketRun["state"]): TicketRun => ({
  state,
  resume_state: null,
  attention: [],
  round: 0,
  branch: null,
  base: null,
  executions: [],
  pr: null,
});

function ticketOf(s: StateFile, key: string | null): TicketRun {
  if (!key) throw new Error("event has no ticket");
  s.tickets[key] ??= newTicket("pending");
  return s.tickets[key];
}

function execOf(s: StateFile, id: string | null): ExecRun {
  const e = id ? s.executions[id] : undefined;
  if (!e) throw new Error(`event names unknown execution ${id}`);
  return e;
}

/**
 * Closes an ended execution's open questions and drops them from the ticket's attention.
 * DECISION: no event of its own; "an open question is closed as withdrawn" follows from the
 * execution's final state change, so the reducer applies it there.
 */
function withdrawQuestions(s: StateFile, execId: string) {
  for (const [qid, q] of Object.entries(s.questions)) {
    if (q.execution_id !== execId || q.state === "delivered" || q.state === "withdrawn") continue;
    q.state = "withdrawn";
    const t = s.tickets[q.ticket];
    if (t) t.attention = t.attention.filter((a) => !(a.kind === "question" && a.id === qid));
  }
}

/** Applies one event to `s` in place and returns it. */
export function reduce(s: StateFile, ev: AnyEvent): StateFile {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case "run.started":
      s.status = "running";
      break;
    case "run.paused":
      s.status = "paused";
      break;
    case "run.resumed":
      s.status = "running";
      break;
    case "run.completed":
    case "run.cancelled":
      s.status = ev.type === "run.completed" ? "completed" : "cancelled";
      s.leases = [];
      break;
    case "ticket.leased":
      if (ev.ticket && !s.leases.includes(ev.ticket)) s.leases.push(ev.ticket);
      break;
    case "ticket.released":
      s.leases = s.leases.filter((k) => k !== ev.ticket);
      break;
    case "ticket.state_changed": {
      const key = ev.ticket as string;
      const to = p.to as TicketRun["state"];
      s.tickets[key] ??= newTicket(to);
      const t = s.tickets[key];
      if (to === "needs_input" && t.state !== "needs_input") t.resume_state = t.state;
      if (to !== "needs_input") t.resume_state = null;
      t.state = to;
      break;
    }
    case "ticket.attention_added": {
      const t = ticketOf(s, ev.ticket);
      const entry = {
        kind: p.kind as TicketRun["attention"][number]["kind"],
        ...(p.id ? { id: p.id as string } : {}),
      };
      if (!t.attention.some((a) => a.kind === entry.kind && a.id === entry.id)) t.attention.push(entry);
      break;
    }
    case "ticket.attention_removed": {
      const t = ticketOf(s, ev.ticket);
      t.attention = t.attention.filter((a) => !(a.kind === p.kind && (p.id === undefined || a.id === p.id)));
      break;
    }
    case "execution.created": {
      const t = ticketOf(s, ev.ticket);
      s.executions[ev.execution_id as string] = {
        ticket: ev.ticket as string,
        profile: p.profile as string,
        kind: p.kind as ExecRun["kind"],
        state: "created",
        attempt: p.attempt as number,
        round: p.round as number,
        terminal: null,
        nudges: 0,
        started_at: null,
        ended_at: null,
        result: null,
      };
      if (!t.executions.includes(ev.execution_id as string)) t.executions.push(ev.execution_id as string);
      t.branch = p.branch as string;
      if (p.base) t.base = p.base as string;
      t.round = Math.max(t.round, p.round as number);
      break;
    }
    case "execution.started": {
      const e = execOf(s, ev.execution_id);
      e.terminal = p.terminal as string;
      e.started_at = ev.ts;
      break;
    }
    case "execution.state_changed": {
      const e = execOf(s, ev.execution_id);
      e.state = p.to as ExecRun["state"];
      if (isExecutionFinal(e.state)) {
        e.ended_at = ev.ts;
        e.agent_blocked = null;
        withdrawQuestions(s, ev.execution_id as string);
      }
      break;
    }
    case "execution.nudged":
      execOf(s, ev.execution_id).nudges = p.nudge as number;
      break;
    case "execution.completed":
      execOf(s, ev.execution_id).result = p.result as ExecRun["result"];
      break;
    case "execution.failed":
      execOf(s, ev.execution_id).result = {
        reason: p.reason as string,
        category: p.category as "other",
        retryable: p.retryable as boolean,
      };
      break;
    case "execution.agent_blocked":
      execOf(s, ev.execution_id).agent_blocked = {
        kind: p.kind as "permission" | "question",
        ...(p.message ? { message: p.message as string } : {}),
      };
      break;
    case "execution.agent_unblocked":
      execOf(s, ev.execution_id).agent_blocked = null;
      break;
    case "finding": {
      const e = execOf(s, ev.execution_id);
      const severity = p.severity as StateFile["findings"][number]["severity"];
      s.findings.push({
        id: ev.id,
        ticket: ev.ticket as string,
        execution_id: ev.execution_id as string,
        round: e.round,
        severity,
        blocking: (p.blocking as boolean | undefined) ?? (severity === "critical" || severity === "high"),
        title: p.title as string,
        ...(p.file ? { file: p.file as string } : {}),
        ...(p.line ? { line: p.line as number } : {}),
        addressed_in_round: null,
      });
      break;
    }
    case "agent.event_accepted":
    case "agent.event_rejected":
      if (typeof p.offset === "number" && ev.execution_id) s.inbox_offsets[ev.execution_id] = p.offset;
      break;
    case "question.opened": {
      const qid = p.question_id as string;
      s.questions[qid] = {
        execution_id: ev.execution_id as string,
        ticket: ev.ticket as string,
        question: p.question as string,
        options: (p.options as string[]) ?? [],
        state: "open",
        answer: null,
        share_with_ticket: false,
      };
      const t = ticketOf(s, ev.ticket);
      if (!t.attention.some((a) => a.kind === "question" && a.id === qid))
        t.attention.push({ kind: "question", id: qid });
      break;
    }
    case "question.answered": {
      const q = s.questions[p.question_id as string];
      if (q) {
        q.state = "answered";
        q.answer = p.answer as string;
        q.share_with_ticket = p.share_with_ticket as boolean;
      }
      break;
    }
    case "question.delivered": {
      const qid = p.question_id as string;
      const q = s.questions[qid];
      if (q) q.state = "delivered";
      const t = s.tickets[ev.ticket as string];
      if (t) t.attention = t.attention.filter((a) => !(a.kind === "question" && a.id === qid));
      break;
    }
    case "pr.created":
      ticketOf(s, ev.ticket).pr = {
        id: p.number as number,
        url: p.url as string,
        source: p.head as string,
        destination: p.base as string,
        draft: p.draft as boolean,
        state: "OPEN",
        approvals: 0,
        conflicted: false,
        conflict_checked_at: null,
      };
      break;
    case "pr.updated": {
      const pr = ticketOf(s, ev.ticket).pr;
      if (pr) {
        if (p.base !== undefined) pr.destination = p.base as string;
        if (p.draft !== undefined) pr.draft = p.draft as boolean;
        if (p.state !== undefined) pr.state = p.state as typeof pr.state;
        if (p.approvals !== undefined) pr.approvals = p.approvals as number;
      }
      break;
    }
    case "pr.conflict_checked": {
      const pr = ticketOf(s, ev.ticket).pr;
      if (pr) {
        pr.conflicted = p.conflicted as boolean;
        pr.conflict_checked_at = ev.ts;
      }
      break;
    }
    // No state of their own: status, artifact, ask, done, fail (their effects arrive as
    // controller events), execution.killed, jira.*, command.*, retention and worktree events.
    default:
      break;
  }
  s.last_event_id = ev.id;
  return s;
}

/** The state of a run from its whole event log. */
export function rebuild(runId: string, events: Iterable<AnyEvent>): StateFile {
  const s = emptyState(runId);
  for (const ev of events) reduce(s, ev);
  return s;
}
