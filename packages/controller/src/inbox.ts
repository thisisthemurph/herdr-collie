// The inbox watcher (docs/protocol.md, "Inbox rules"): reads each execution's inbox from its
// saved byte offset, judges every complete line, and logs `agent.event_accepted` or
// `agent.event_rejected` with the offset just after the line. A line's events go out in one
// append, so after a crash reading resumes exactly after the last judged line.
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { type AgentEvent, type AnyEvent, formatIssues, parseInboxLine } from "@collie/schema";
import { type Clock, makeEvent } from "./events.ts";
import { isExecutionFinal } from "./machines.ts";
import type { RunLog } from "./runlog.ts";

const WORKING_TICKET = ["in_progress", "reviewing", "remediating", "delivering"];

/** Bytes of `path` from `offset` to the end, or null when there is nothing new. */
function readFrom(path: string, offset: number): Buffer | null {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return null;
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}

/** What the controller adds to judging an inbox line (the checks that need a worktree). */
export type InboxHooks = {
  /** Checks a developer's `done` against the ticket's worktree. Returns the reason to reject it. */
  verifyDeveloper?: (execId: string, commits: string[]) => string | null;
  /** Called when a `done` is rejected by controller verification, so the agent can be told why. */
  rejectedDone?: (execId: string, reason: string) => void;
};

/** Processes the new complete lines of one execution's inbox. Returns how many it judged. */
export function processInbox(rl: RunLog, execId: string, clock: Clock, hooks: InboxHooks = {}): number {
  const start = rl.state.inbox_offsets[execId] ?? 0;
  const buf = readFrom(rl.inboxFile(execId), start);
  if (!buf) return 0;
  let pos = 0;
  let judged = 0;
  for (;;) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break; // an incomplete final line: wait for the rest (inbox rule 4)
    const line = buf.subarray(pos, nl + 1).toString("utf8");
    pos = nl + 1;
    rl.emit(judge(rl, execId, line, start + pos, clock, hooks), clock.now());
    judged += 1;
  }
  return judged;
}

/** The events for one inbox line. */
export function judge(
  rl: RunLog,
  execId: string,
  line: string,
  offset: number,
  clock: Clock,
  hooks: InboxHooks = {},
): AnyEvent[] {
  const exec = rl.state.executions[execId];
  const ticket = exec?.ticket ?? null;
  const ev = (type: string, payload: Record<string, unknown>, cause: string | null = null) =>
    makeEvent(clock, rl.id, type, payload, { ticket, exec: execId, cause });
  // DECISION: only accepted agent events are copied into events.jsonl; a rejected line stays
  // in the inbox, named by the rejection's caused_by (when it has a readable id) and reason.
  const reject = (reason: string, id: string | null, eventType?: string): AnyEvent[] => [
    ev("agent.event_rejected", { ...(eventType ? { event_type: eventType } : {}), reason, offset }, id),
  ];

  let raw: Record<string, unknown> | null = null;
  try {
    raw = JSON.parse(line);
  } catch {}
  const looseId = typeof raw?.id === "string" && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(raw.id) ? raw.id : null;
  const looseType = typeof raw?.type === "string" ? raw.type : undefined;

  const parsed = parseInboxLine(line);
  if (!parsed.ok) return reject(`invalid line: ${formatIssues(parsed.issues)}`, looseId, looseType);
  const a = parsed.value;
  if (rl.ids.has(a.id))
    return reject(`duplicate of event ${a.id}, which was already processed`, a.id, a.type);
  if (!exec) return reject(`execution ${execId} is not part of run ${rl.id}`, a.id, a.type);
  // An analyst belongs to board preparation, not to a run: its events carry no run id.
  const runOk = rl.prep ? a.run_id === null : a.run_id === rl.id;
  if (a.execution_id !== execId || !runOk || a.ticket !== exec.ticket) {
    return reject(
      `the event is for execution ${a.execution_id} of run ${a.run_id} on ${a.ticket}, but it is in the inbox of execution ${execId} of run ${rl.id} on ${exec.ticket}`,
      a.id,
      a.type,
    );
  }
  if (isExecutionFinal(exec.state)) {
    return reject(`execution already ended (${exec.state}); nothing more can be recorded`, a.id, a.type);
  }
  if (exec.state === "created") return reject("execution has not been started yet", a.id, a.type);

  const role = rl.roles.get(execId);
  if (a.type === "done") {
    const why = verifyDone(rl, execId, role, a, hooks);
    if (why) {
      hooks.rejectedDone?.(execId, why);
      return reject(why, a.id, a.type);
    }
  }

  const out: AnyEvent[] = [];
  // DECISION: an agent can report before hc shows it working; that report starts it.
  if (exec.state === "starting") {
    out.push(
      ev("execution.state_changed", {
        from: "starting",
        to: "working",
        reason: "the agent reported before hc showed it working",
      }),
    );
  }
  out.push(a, ev("agent.event_accepted", { event_type: a.type, offset }, a.id));
  const execState = exec.state === "starting" ? "working" : exec.state;
  const t = rl.state.tickets[exec.ticket];

  if (a.type === "ask") {
    out.push(
      ev(
        "question.opened",
        { question_id: a.id, question: a.payload.question, options: a.payload.options ?? [] },
        a.id,
      ),
    );
    if (execState === "working") {
      out.push(
        ev(
          "execution.state_changed",
          { from: "working", to: "needs_input", reason: `question ${a.id.slice(-6)}` },
          a.id,
        ),
      );
    }
    if (t && WORKING_TICKET.includes(t.state)) {
      out.push(
        makeEvent(
          clock,
          rl.id,
          "ticket.state_changed",
          { from: t.state, to: "needs_input", reason: `question ${a.id.slice(-6)}` },
          { ticket: exec.ticket, cause: a.id },
        ),
      );
    }
  } else if (a.type === "done" || a.type === "fail") {
    if (a.type === "done") out.push(ev("execution.completed", { result: a.payload }, a.id));
    else
      out.push(
        ev(
          "execution.failed",
          { reason: a.payload.reason, category: a.payload.category, retryable: a.payload.retryable },
          a.id,
        ),
      );
    const to = a.type === "done" ? "completed" : "failed";
    out.push(ev("execution.state_changed", { from: execState, to, reason: `${a.type} accepted` }, a.id));
    out.push(...resumeTicketIfClear(rl, execId, clock, a.id));
    // DECISION: what a finished execution means for its ticket (review, remediation, delivery)
    // is the workflow's job, from Phase 4 on. Phase 2 records the result only.
  }
  return out;
}

/** Controller-side verification of a `done` (protocol, "Agent events": role rules). */
function verifyDone(
  rl: RunLog,
  execId: string,
  role: string | undefined,
  a: AgentEvent,
  hooks: InboxHooks,
): string | null {
  if (a.type !== "done") return null;
  const blocking = rl.state.findings.filter((f) => f.execution_id === execId && f.blocking).length;
  if (role === "reviewer") {
    if (!a.payload.verdict) return "a reviewer's done needs a verdict";
    if (a.payload.verdict === "request_changes" && blocking === 0)
      return "request_changes needs at least one blocking finding";
    if (a.payload.verdict === "approve" && blocking > 0)
      return `approve isn't allowed with ${blocking} blocking finding(s) recorded`;
  }
  if (role === "developer") {
    if (!a.payload.commits?.length)
      return "a developer's done needs at least one commit on the ticket branch";
    // Phase 4: the commits are checked against the worktree by the controller (see git.ts).
    return hooks.verifyDeveloper?.(execId, a.payload.commits) ?? null;
  }
  return null;
}

/**
 * When an execution ends, its open questions are withdrawn. If that empties the ticket's
 * attention while it waits in needs_input, the ticket resumes where it was.
 */
export function resumeTicketIfClear(
  rl: RunLog,
  execId: string,
  clock: Clock,
  cause: string | null,
): AnyEvent[] {
  const exec = rl.state.executions[execId];
  const t = exec && rl.state.tickets[exec.ticket];
  if (!exec || t?.state !== "needs_input" || !t.resume_state) return [];
  const remaining = t.attention.filter(
    (x) => !(x.kind === "question" && x.id && rl.state.questions[x.id]?.execution_id === execId),
  );
  if (remaining.length > 0) return [];
  return [
    makeEvent(
      clock,
      rl.id,
      "ticket.state_changed",
      { from: "needs_input", to: t.resume_state, reason: "attention cleared" },
      { ticket: exec.ticket, cause },
    ),
  ];
}
