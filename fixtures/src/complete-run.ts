// One complete run, event by event: the events.jsonl a controller would write.
//
// Board: PAY-101 (standard feature: developer + required security reviewer) and PAY-102
// (small bug fix, no reviewers), which is blocked by PAY-101 and by the outside ticket OPS-77
// (already Done in Jira). complete_at is pr_created, so PAY-102 starts once PAY-101's PR opens.
//
// It covers: leases, a question answered by a person, a blocking finding, one remediation
// round, a nudge, a done rejected by controller verification, an hc permission block,
// pause/resume commands, stacked PRs, a conflict check, Jira write-back (applied and
// skipped) and run completion.
import type { DonePayload, ExecutionFile, RunFile } from "@collie/schema";
import { BOARD_ID, board, developer, securityReviewer, smallBugFix, standardFeature } from "./config.ts";
import { FixtureClock } from "./ids.ts";

type Json = Record<string, unknown>;
export type FixtureEvent = {
  v: 1;
  id: string;
  type: string;
  ts: string;
  source: "agent" | "controller" | "human";
  run_id: string;
  execution_id: string | null;
  ticket: string | null;
  caused_by: string | null;
  payload: Json;
};

export function buildCompleteRun() {
  const clock = new FixtureClock("2026-11-08T10:00:00.000Z", 1500);
  clock.tick();
  const RUN = clock.id();
  const events: FixtureEvent[] = [];
  const executions: ExecutionFile[] = [];
  const runStartedAt = clock.now();

  const emit = (
    type: string,
    payload: Json,
    o: {
      ticket?: string | null;
      exec?: string | null;
      cause?: string | null;
      source?: FixtureEvent["source"];
    } = {},
  ): string => {
    clock.tick();
    const id = clock.id();
    events.push({
      v: 1,
      id,
      type,
      ts: clock.now(),
      source: o.source ?? "controller",
      run_id: RUN,
      execution_id: o.exec ?? null,
      ticket: o.ticket ?? null,
      caused_by: o.cause ?? null,
      payload,
    });
    return id;
  };

  const ticketState = (
    ticket: string,
    from: string | null,
    to: string,
    reason: string,
    cause: string | null = null,
  ) => emit("ticket.state_changed", { from, to, reason }, { ticket, cause });

  const execState = (
    ticket: string,
    exec: string,
    from: string | null,
    to: string,
    reason: string,
    cause: string | null = null,
  ) => emit("execution.state_changed", { from, to, reason }, { ticket, exec, cause });

  /** An agent line copied from its inbox, then the controller's verdict on it. */
  const agent = (ticket: string, exec: string, type: string, payload: Json, reject?: string): string => {
    const id = emit(type, payload, { ticket, exec, source: "agent" });
    if (reject)
      emit("agent.event_rejected", { event_type: type, reason: reject }, { ticket, exec, cause: id });
    else emit("agent.event_accepted", { event_type: type }, { ticket, exec, cause: id });
    return id;
  };

  let terminal = 17;
  const launch = (
    ticket: string,
    profile: string,
    role: ExecutionFile["role"],
    kind: ExecutionFile["kind"],
    round: number,
    branch: string,
    base = "main",
  ): string => {
    clock.tick();
    const exec = clock.id();
    const worktree = `~/.herdr/worktrees/[REPO]/${branch}`;
    terminal += 1;
    const t = `t${terminal}`;
    executions.push({
      v: 1,
      id: exec,
      run_id: RUN,
      ticket,
      profile,
      role,
      kind,
      round,
      attempt: 1,
      worktree,
      branch,
      base,
      terminal: t,
      created_at: clock.now(),
    });
    const created = emit(
      "execution.created",
      { profile, role, kind, round, attempt: 1, worktree, branch, base },
      { ticket, exec },
    );
    execState(ticket, exec, null, "created", "worktree and task.md written", created);
    const started = emit("execution.started", { terminal: t }, { ticket, exec });
    execState(ticket, exec, "created", "starting", "hc run issued", started);
    execState(ticket, exec, "starting", "working", `terminal ${t} reports turn 1`);
    return exec;
  };

  const finish = (ticket: string, exec: string, result: DonePayload) => {
    const done = agent(ticket, exec, "done", result);
    emit("execution.completed", { result }, { ticket, exec, cause: done });
    execState(ticket, exec, "working", "completed", "done accepted", done);
    return done;
  };

  const command = (name: string): string => {
    clock.tick();
    const id = clock.id();
    emit("command.applied", { command: name }, { cause: id, source: "human" });
    return id;
  };

  // --- start
  emit("run.started", { board_id: BOARD_ID, number: 1, carried_over_from: null });
  emit("ticket.leased", {}, { ticket: "PAY-101" });
  emit("ticket.leased", {}, { ticket: "PAY-102" });
  ticketState("PAY-101", null, "ready", "preparation ready; no blockers");
  ticketState("PAY-102", null, "blocked", "blocked by PAY-101 (in run, not at pr_created)");

  // --- PAY-101: develop
  const dev1 = launch("PAY-101", "developer", "developer", "develop", 1, "pay-101-persistence");
  ticketState("PAY-101", "ready", "in_progress", "developer dispatched");
  emit("jira.updated", { transition: "In Progress" }, { ticket: "PAY-101" });
  agent("PAY-101", dev1, "status", { message: "Reading the existing storage code", phase: "investigating" });
  agent("PAY-101", dev1, "artifact", {
    kind: "commit",
    ref: "a1b2c3d",
    description: "Add payments table and repository",
  });
  const dev1Done = finish("PAY-101", dev1, {
    summary: "Added the payments repository with migrations and tests",
    commits: ["a1b2c3d"],
    tests: { command: "go test ./src/payments/...", passed: true },
  });
  ticketState("PAY-101", "in_progress", "reviewing", "developer done; workflow has reviewers", dev1Done);

  // --- PAY-101: review round 1, with a question and a blocking finding
  const rev1 = launch("PAY-101", "security-reviewer", "reviewer", "review", 1, "pay-101-persistence");
  const ask = agent("PAY-101", rev1, "ask", {
    question: "Should payment amounts be stored as integer minor units or as decimals?",
    options: ["integer minor units", "decimal(19,4)"],
  });
  emit(
    "question.opened",
    {
      question_id: ask,
      question: "Should payment amounts be stored as integer minor units or as decimals?",
      options: ["integer minor units", "decimal(19,4)"],
    },
    { ticket: "PAY-101", exec: rev1, cause: ask },
  );
  execState("PAY-101", rev1, "working", "needs_input", "question opened", ask);
  ticketState("PAY-101", "reviewing", "needs_input", `question ${ask.slice(-6)}`, ask);
  const answerCmd = command("question.answer");
  emit(
    "question.answered",
    { question_id: ask, answer: "Integer minor units.", by: "human", share_with_ticket: true },
    { ticket: "PAY-101", cause: answerCmd, source: "human" },
  );
  const delivered = emit("question.delivered", { question_id: ask }, { ticket: "PAY-101", exec: rev1 });
  execState("PAY-101", rev1, "needs_input", "working", "answer delivered with hc send", delivered);
  ticketState("PAY-101", "needs_input", "reviewing", "attention cleared", delivered);
  agent("PAY-101", rev1, "finding", {
    severity: "high",
    category: "security",
    title: "Payment id not checked against caller's account",
    file: "src/payments/repo.go",
    line: 88,
    body: "FindPayment returns any payment by id, regardless of the caller's account.",
    suggestion: "Scope the lookup by account id.",
    blocking: true,
  });
  const rev1Done = finish("PAY-101", rev1, {
    summary: "One blocking authz issue",
    verdict: "request_changes",
  });
  ticketState(
    "PAY-101",
    "reviewing",
    "remediating",
    "security-reviewer requested changes; round 1 of 2",
    rev1Done,
  );

  // --- PAY-101: remediation, with one nudge
  const rem = launch("PAY-101", "developer", "developer", "remediate", 1, "pay-101-persistence");
  emit("execution.nudged", { nudge: 1 }, { ticket: "PAY-101", exec: rem });
  const remDone = finish("PAY-101", rem, {
    summary: "Scoped FindPayment by account id and added a test",
    commits: ["b2c3d4e"],
    tests: { command: "go test ./src/payments/...", passed: true },
  });
  ticketState("PAY-101", "remediating", "reviewing", "remediation done; round 2", remDone);

  // --- PAY-101: review round 2
  const rev2 = launch("PAY-101", "security-reviewer", "reviewer", "review", 2, "pay-101-persistence");
  const rev2Done = finish("PAY-101", rev2, {
    summary: "Finding addressed; no new issues",
    verdict: "approve",
  });
  ticketState("PAY-101", "reviewing", "delivering", "all required reviewers approved", rev2Done);

  // --- PAY-101: delivery
  const pr1 = emit(
    "pr.created",
    {
      number: 147,
      url: "https://bitbucket.org/[WORKSPACE]/[REPO]/pull-requests/147",
      base: "main",
      head: "pay-101-persistence",
      draft: false,
    },
    { ticket: "PAY-101" },
  );
  emit("jira.updated", { transition: "In Review", comment: true }, { ticket: "PAY-101" });
  ticketState("PAY-101", "delivering", "completed", "PR created (complete_at pr_created)", pr1);

  // --- PAY-102: unblocked by PAY-101's PR; OPS-77 is outside the run and already Done
  ticketState("PAY-102", "blocked", "ready", "PAY-101 at pr_created; OPS-77 done_or_resolved", pr1);
  const dev2 = launch(
    "PAY-102",
    "developer",
    "developer",
    "develop",
    1,
    "pay-102-api",
    "pay-101-persistence",
  );
  ticketState("PAY-102", "ready", "in_progress", "developer dispatched");
  emit("jira.updated", { transition: "In Progress" }, { ticket: "PAY-102" });
  const pause = command("run.pause");
  emit("run.paused", { reason: "lunch" }, { cause: pause, source: "human" });
  emit(
    "execution.agent_blocked",
    { kind: "permission", message: "approve Bash: go test ./..." },
    { ticket: "PAY-102", exec: dev2 },
  );
  emit("execution.agent_unblocked", {}, { ticket: "PAY-102", exec: dev2 });
  const resume = command("run.resume");
  emit("run.resumed", {}, { cause: resume, source: "human" });
  agent(
    "PAY-102",
    dev2,
    "done",
    { summary: "Added the endpoints" },
    "developer done needs at least one commit ahead of pay-101-persistence",
  );
  const dev2Done = finish("PAY-102", dev2, {
    summary: "Added GET and POST /payments with handler tests",
    commits: ["c3d4e5f"],
    tests: { command: "go test ./src/payments/...", passed: true },
  });
  ticketState("PAY-102", "in_progress", "delivering", "developer done; workflow has no reviewers", dev2Done);

  // --- PAY-102: stacked delivery
  const pr2 = emit(
    "pr.created",
    {
      number: 148,
      url: "https://bitbucket.org/[WORKSPACE]/[REPO]/pull-requests/148",
      base: "pay-101-persistence",
      head: "pay-102-api",
      draft: true,
    },
    { ticket: "PAY-102" },
  );
  emit("pr.conflict_checked", { number: 148, conflicted: false, paths: [] }, { ticket: "PAY-102" });
  emit(
    "jira.writeback_skipped",
    { target: "In Review", available: ["To Do", "Done"] },
    { ticket: "PAY-102" },
  );
  ticketState("PAY-102", "delivering", "completed", "PR created (complete_at pr_created)", pr2);

  // --- end
  emit("ticket.released", {}, { ticket: "PAY-101" });
  emit("ticket.released", {}, { ticket: "PAY-102" });
  emit("run.completed", { reason: "every ticket completed" });

  const run: RunFile = {
    v: 1,
    id: RUN,
    board_id: BOARD_ID,
    number: 1,
    status: "completed",
    started_at: runStartedAt,
    ended_at: clock.now(),
    end_reason: "every ticket completed",
    carried_over_from: null,
    snapshot: {
      settings: board.settings,
      tickets: board.tickets,
      overrides: board.overrides,
      workflows: { "standard-feature": standardFeature, "small-bug-fix": smallBugFix },
      profiles: { developer, "security-reviewer": securityReviewer },
    },
  };

  return { runId: RUN, events, executions, run };
}
