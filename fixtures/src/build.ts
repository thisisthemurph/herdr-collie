// Writes every fixture under fixtures/ from the definitions below.
//
//   bun fixtures/src/build.ts           write the files
//   bun fixtures/src/build.ts --check   exit 1 if a committed file differs (run by the tests)
//
// Layout:
//   inbox/{valid,invalid}/*.jsonl     one inbox line each (an agent event)
//   events/{valid,invalid}/*.jsonl    one controller event line each
//   files/<kind>/{valid,invalid}/*.json   config, runtime and control files
//   runs/complete/                    events.jsonl, run.json, state.json and executions/ for one complete run
//   home/                             a COLLIE_HOME for `collie show` (one run, mid-remediation)
//   boards/                           boards of many shapes, for the graph and layout tests
// Every invalid/ folder has expected.json: file name -> the field path the error must name
// ("" for whole-line problems such as a missing newline).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { rebuild } from "@collie/controller/reducer";
import { type AnyEvent, type Board, CONTROLLER_EVENT_TYPES } from "@collie/schema";
import { buildCompleteRun, type FixtureEvent } from "./complete-run.ts";
import { analyst, board, developer, securityReviewer, smallBugFix, standardFeature } from "./config.ts";
import { FixtureClock } from "./ids.ts";

const ROOT = join(import.meta.dir, "..");
const GENERATED_DIRS = ["inbox", "events", "files", "runs", "home", "boards"];

type Json = Record<string, unknown>;
const out = new Map<string, string>();
const put = (path: string, content: string) => out.set(path, content);
const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const clone = <T>(v: T): T => structuredClone(v);

/** Returns a copy of `v` with the dotted `path` set to `value`, or removed when value is DELETE. */
const DELETE = Symbol("delete");
function mutate<T>(v: T, path: string, value: unknown): T {
  const copy = clone(v) as Json;
  const keys = path.split(".");
  let cur: Json = copy;
  for (const k of keys.slice(0, -1)) cur = cur[k] as Json;
  const last = keys.at(-1) as string;
  if (value === DELETE) delete cur[last];
  else cur[last] = value;
  return copy as T;
}

// --- ids for standalone fixtures
const clock = new FixtureClock("2026-11-08T10:20:00.000Z", 1000);
clock.tick();
const RUN = "01JC8YQ0P4E2W7H5S8D3F6G9KB";
const EXEC = "01JC8Z1A9C4V6B2N8M5X7Z3QWE";

function agentLine(type: string, payload: Json): FixtureEvent {
  clock.tick();
  return {
    v: 1,
    id: clock.id(),
    type,
    ts: clock.now(),
    source: "agent",
    run_id: RUN,
    execution_id: EXEC,
    ticket: "PAY-102",
    caused_by: null,
    payload,
  };
}

// --- inbox lines
const inboxValid: Record<string, FixtureEvent> = {
  "status-minimal": agentLine("status", { message: "Reading the payments handler" }),
  "status-with-phase": agentLine("status", { message: "Running the test suite", phase: "testing" }),
  "finding-minimal": agentLine("finding", {
    severity: "low",
    title: "Unused import",
    body: "fmt is imported but unused.",
  }),
  "finding-full": agentLine("finding", {
    severity: "high",
    category: "security",
    title: "Payment id not checked against caller's account",
    file: "src/payments/api.go",
    line: 88,
    end_line: 94,
    body: "GET /payments/{id} returns any payment by id.",
    suggestion: "Scope the lookup by account id from the auth context.",
    blocking: true,
  }),
  "finding-body-ref": agentLine("finding", {
    severity: "medium",
    category: "tests",
    title: "Handler tests miss the error paths",
    body_ref: "attachments/01JC8Z6F0000000000000000AA.md",
    blocking: false,
  }),
  "artifact-commit": agentLine("artifact", { kind: "commit", ref: "a1b2c3d" }),
  "artifact-test-report": agentLine("artifact", {
    kind: "test_report",
    ref: "reports/junit.xml",
    description: "go test -json output",
  }),
  "ask-minimal": agentLine("ask", {
    question: "Should GET /payments/{id} return 404 or 403 for another account's payment?",
  }),
  "ask-with-options": agentLine("ask", {
    question: "Which status for a missing payment?",
    options: ["404 with the standard error body", "403"],
    context: "The API guidelines don't cover cross-account reads.",
  }),
  "done-developer": agentLine("done", {
    summary: "Added payment API endpoints with handler tests",
    commits: ["a1b2c3d"],
    tests: { command: "go test ./src/payments/...", passed: true },
  }),
  "done-reviewer-approve": agentLine("done", { summary: "No issues in my area", verdict: "approve" }),
  "done-reviewer-request-changes": agentLine("done", {
    summary: "One blocking issue",
    verdict: "request_changes",
  }),
  "fail-retryable": agentLine("fail", {
    reason: "go toolchain missing from PATH",
    category: "environment",
    retryable: true,
  }),
  "fail-final": agentLine("fail", {
    reason: "The ticket needs a schema change owned by another team",
    category: "blocked_external",
    retryable: false,
    details: "OPS-77 must add the column first.",
  }),
};
// An analyst execution belongs to board preparation and has no run.
inboxValid["analyst-no-run"] = {
  ...agentLine("done", { summary: "Ready: scope is two endpoints" }),
  run_id: null as unknown as string,
};

for (const [name, ev] of Object.entries(inboxValid)) put(`inbox/valid/${name}.jsonl`, line(ev));

const base = inboxValid;
const longMessage = "x".repeat(201);
const inboxInvalid: Record<string, string> = {};
const bad = (name: string, ev: unknown, field: string, raw?: string) => {
  put(`inbox/invalid/${name}.jsonl`, raw ?? line(ev));
  inboxInvalid[`${name}.jsonl`] = field;
};
const s = base["status-minimal"] as FixtureEvent;
const f = base["finding-full"] as FixtureEvent;
const a = base["artifact-commit"] as FixtureEvent;
const k = base["ask-with-options"] as FixtureEvent;
const d = base["done-developer"] as FixtureEvent;
const r = base["done-reviewer-approve"] as FixtureEvent;
const x = base["fail-final"] as FixtureEvent;
bad("status-message-too-long", mutate(s, "payload.message", longMessage), "payload.message");
bad("status-unknown-phase", mutate(s, "payload.phase", "coding"), "payload.phase");
bad("finding-missing-title", mutate(f, "payload.title", DELETE), "payload.title");
bad("finding-unknown-severity", mutate(f, "payload.severity", "blocker"), "payload.severity");
bad("finding-no-body", mutate(mutate(f, "payload.body", DELETE), "payload.body_ref", DELETE), "payload.body");
bad("finding-body-and-body-ref", mutate(f, "payload.body_ref", "attachments/x.md"), "payload.body_ref");
bad("finding-end-line-before-line", mutate(f, "payload.end_line", 80), "payload.end_line");
bad("finding-line-without-file", mutate(f, "payload.file", DELETE), "payload.file");
bad("finding-unknown-category", mutate(f, "payload.category", "naming"), "payload.category");
bad("finding-blocking-not-boolean", mutate(f, "payload.blocking", "yes"), "payload.blocking");
bad("artifact-unknown-kind", mutate(a, "payload.kind", "pr"), "payload.kind");
bad("artifact-missing-ref", mutate(a, "payload.ref", DELETE), "payload.ref");
bad("ask-missing-question", mutate(k, "payload.question", DELETE), "payload.question");
bad("ask-options-not-array", mutate(k, "payload.options", "404 or 403"), "payload.options");
bad("done-missing-summary", mutate(d, "payload.summary", DELETE), "payload.summary");
bad("done-unknown-verdict", mutate(r, "payload.verdict", "lgtm"), "payload.verdict");
bad("done-bad-commit-sha", mutate(d, "payload.commits", ["HEAD"]), "payload.commits[0]");
bad(
  "done-tests-missing-passed",
  mutate(d, "payload.tests", { command: "go test ./..." }),
  "payload.tests.passed",
);
bad("fail-missing-retryable", mutate(x, "payload.retryable", DELETE), "payload.retryable");
bad("fail-unknown-category", mutate(x, "payload.category", "flaky"), "payload.category");
bad("envelope-unknown-type", mutate(s, "type", "progress"), "type");
bad("envelope-controller-type", mutate(s, "type", "execution.completed"), "type");
bad("envelope-future-version", mutate(s, "v", 2), "v");
bad("envelope-bad-id", mutate(s, "id", "not-a-ulid"), "id");
bad("envelope-ts-without-ms", mutate(s, "ts", "2026-11-08T10:25:13Z"), "ts");
bad("envelope-ts-not-utc", mutate(s, "ts", "2026-11-08T10:25:13.412+01:00"), "ts");
bad("envelope-source-controller", mutate(s, "source", "controller"), "source");
bad("envelope-missing-execution-id", mutate(s, "execution_id", null), "execution_id");
bad("envelope-lowercase-ticket", mutate(s, "ticket", "pay-102"), "ticket");
bad("envelope-missing-payload", mutate(s, "payload", DELETE), "payload");
bad("line-no-newline", null, "", JSON.stringify(s));
bad("line-not-json", null, "", '{"v": 1, "type": "status",\n');
put("inbox/invalid/expected.json", pretty(inboxInvalid));

// --- controller events: one valid line per type
const complete = buildCompleteRun();
const firstOfType = new Map<string, FixtureEvent>();
for (const ev of complete.events) if (!firstOfType.has(ev.type)) firstOfType.set(ev.type, ev);

function controllerLine(type: string, payload: Json, o: Partial<FixtureEvent> = {}): FixtureEvent {
  clock.tick();
  return {
    v: 1,
    id: clock.id(),
    type,
    ts: clock.now(),
    source: "controller",
    run_id: RUN,
    execution_id: null,
    ticket: null,
    caused_by: null,
    payload,
    ...o,
  };
}
const extra: Record<string, FixtureEvent> = {
  "run.cancelled": controllerLine(
    "run.cancelled",
    { reason: "cancelled from the mod" },
    { source: "human", caused_by: "01JC9A0C000000000000000001" },
  ),
  "execution.failed": controllerLine(
    "execution.failed",
    { reason: "nudged twice without a report", category: "tooling", retryable: true },
    { ticket: "PAY-102", execution_id: EXEC },
  ),
  "execution.killed": controllerLine(
    "execution.killed",
    { reason: "run cancelled" },
    { ticket: "PAY-102", execution_id: EXEC },
  ),
  "pr.updated": controllerLine(
    "pr.updated",
    { number: 148, base: "main", draft: false, state: "OPEN", approvals: 1 },
    { ticket: "PAY-102" },
  ),
  "command.rejected": controllerLine(
    "command.rejected",
    { command: "question.answer", code: "invalid_state", reason: "Question already answered at 10:28." },
    { source: "human", caused_by: "01JC9A0C000000000000000002" },
  ),
  "ticket.attention_added": controllerLine(
    "ticket.attention_added",
    { kind: "round_cap" },
    { ticket: "PAY-102" },
  ),
  "ticket.attention_removed": controllerLine(
    "ticket.attention_removed",
    { kind: "round_cap" },
    { ticket: "PAY-102", source: "human", caused_by: "01JC9A0C000000000000000003" },
  ),
  "worktree.kept": controllerLine("worktree.kept", {
    worktree: "~/.herdr/worktrees/[REPO]/pay-102-api",
    reason: "2 commits not on origin/pay-102-api",
  }),
  "worktree.removed": controllerLine("worktree.removed", {
    worktree: "~/.herdr/worktrees/[REPO]/pay-101-persistence",
  }),
  "retention.pruned": controllerLine("retention.pruned", {
    paths: [`executions/${EXEC}/inbox.jsonl`, `executions/${EXEC}/attachments`],
  }),
};
for (const type of CONTROLLER_EVENT_TYPES) {
  const ev = firstOfType.get(type) ?? extra[type];
  if (!ev) throw new Error(`no valid fixture for controller event ${type}`);
  put(`events/valid/${type}.jsonl`, line(ev));
}

const evInvalid: Record<string, string> = {};
const badEv = (name: string, ev: unknown, field: string) => {
  put(`events/invalid/${name}.jsonl`, line(ev));
  evInvalid[`${name}.jsonl`] = field;
};
const ts = firstOfType.get("ticket.state_changed") as FixtureEvent;
const acc = firstOfType.get("agent.event_accepted") as FixtureEvent;
const prc = firstOfType.get("pr.created") as FixtureEvent;
const exc = firstOfType.get("execution.created") as FixtureEvent;
const qa = firstOfType.get("question.answered") as FixtureEvent;
const rs = firstOfType.get("run.started") as FixtureEvent;
badEv("unknown-type", mutate(rs, "type", "run.exploded"), "type");
badEv("run-id-null", mutate(rs, "run_id", null), "run_id");
badEv("source-agent", mutate(rs, "source", "agent"), "source");
badEv("ticket-state-unknown", mutate(ts, "payload.to", "done"), "payload.to");
badEv("ticket-state-missing-ticket", mutate(ts, "ticket", null), "ticket");
badEv("accepted-without-caused-by", mutate(acc, "caused_by", null), "caused_by");
badEv("pr-number-zero", mutate(prc, "payload.number", 0), "payload.number");
badEv("execution-created-missing-worktree", mutate(exc, "payload.worktree", DELETE), "payload.worktree");
badEv("execution-created-attempt-zero", mutate(exc, "payload.attempt", 0), "payload.attempt");
badEv("question-answered-missing-answer", mutate(qa, "payload.answer", DELETE), "payload.answer");
badEv(
  "blocked-unknown-kind",
  mutate(firstOfType.get("execution.agent_blocked"), "payload.kind", "dialog"),
  "payload.kind",
);
put("events/invalid/expected.json", pretty(evInvalid));

// --- files: config, runtime and control
const files: Record<string, { valid: Record<string, unknown>; invalid: Record<string, [unknown, string]> }> =
  {};
const kind = (k: string) => {
  files[k] ??= { valid: {}, invalid: {} };
  return files[k];
};

kind("profile").valid = { developer, "security-reviewer": securityReviewer, "requirements-analyst": analyst };
kind("profile").invalid = {
  "unknown-role": [mutate(developer, "role", "tester"), "role"],
  "id-not-slug": [mutate(developer, "id", "Security Reviewer"), "id"],
  "timeout-zero": [mutate(developer, "timeout_min", 0), "timeout_min"],
  "permissions-missing-shell": [mutate(developer, "permissions.shell", DELETE), "permissions.shell"],
  "args-not-strings": [mutate(developer, "args", ["--model", 4]), "args[1]"],
};

kind("workflow").valid = { "standard-feature": standardFeature, "small-bug-fix": smallBugFix };
kind("workflow").invalid = {
  "reviewer-missing-profile": [
    mutate(standardFeature, "reviewers", [{ required: true }]),
    "reviewers[0].profile",
  ],
  "negative-rounds": [mutate(standardFeature, "max_remediation_rounds", -1), "max_remediation_rounds"],
};

const customBoard = mutate(board, "settings.completion_policy", {
  mode: "custom",
  statuses: ["Ready for QA", "Done"],
});
kind("board").valid = { board, "board-custom-completion": customBoard };
kind("board").invalid = {
  "unknown-complete-at": [mutate(board, "settings.complete_at", "deployed"), "settings.complete_at"],
  "custom-without-statuses": [
    mutate(board, "settings.completion_policy", { mode: "custom", statuses: [] }),
    "settings.completion_policy.statuses",
  ],
  "ticket-key-lowercase": [mutate(board, "tickets", { "pay-1": board.tickets["PAY-101"] }), "tickets.pay-1"],
  "ticket-unknown-preparation": [
    mutate(board, "tickets.PAY-101", { ...board.tickets["PAY-101"], preparation: "done" }),
    "tickets.PAY-101.preparation",
  ],
  "override-by-agent": [
    mutate(board, "overrides", [
      { blocker: "OPS-77", blocked: "PAY-102", by: "agent", at: "2026-11-08T09:52:00Z" },
    ]),
    "overrides[0].by",
  ],
  "site-not-atlassian": [mutate(board, "jira.site", "jira.example.com"), "jira.site"],
};

kind("run").valid = { run: complete.run };
kind("run").invalid = {
  "unknown-status": [mutate(complete.run, "status", "finished"), "status"],
  "number-zero": [mutate(complete.run, "number", 0), "number"],
  "snapshot-missing-profiles": [mutate(complete.run, "snapshot.profiles", DELETE), "snapshot.profiles"],
};

const exec0 = complete.executions[0];
kind("execution").valid = Object.fromEntries(
  complete.executions.slice(0, 2).map((e) => [`${e.kind}-${e.ticket}`, e]),
);
kind("execution").valid["analyse-prep"] = {
  ...exec0,
  id: "01JC8XZ0000000000000000001",
  run_id: null,
  profile: "requirements-analyst",
  role: "analyst",
  kind: "analyse",
  round: 0,
};
kind("execution").invalid = {
  "attempt-zero": [mutate(exec0, "attempt", 0), "attempt"],
  "unknown-kind": [mutate(exec0, "kind", "test"), "kind"],
};

// A run paused on a question, like the protocol's example.
const Q = "01JC8Z7Q000000000000000001";
const E = "01JC8Z1A000000000000000001";
const F = "01JC8Z6F000000000000000001";
const state = {
  v: 1,
  run_id: RUN,
  last_event_id: "01JC8Z9K000000000000000001",
  status: "running",
  leases: ["PAY-102", "PAY-103"],
  tickets: {
    "PAY-102": {
      state: "needs_input",
      resume_state: "reviewing",
      attention: [{ kind: "question", id: Q }],
      round: 1,
      branch: "pay-102-api",
      base: "pay-101-persistence",
      executions: [E],
      pr: {
        id: 147,
        url: "https://bitbucket.org/[WORKSPACE]/[REPO]/pull-requests/147",
        source: "pay-102-api",
        destination: "pay-101-persistence",
        draft: true,
        state: "OPEN",
        approvals: 0,
        conflicted: false,
        conflict_checked_at: null,
      },
    },
    "PAY-103": {
      state: "blocked",
      resume_state: null,
      attention: [],
      round: 0,
      branch: null,
      base: null,
      executions: [],
      pr: null,
    },
  },
  executions: {
    [E]: {
      ticket: "PAY-102",
      profile: "security-reviewer",
      kind: "review",
      state: "needs_input",
      attempt: 1,
      round: 1,
      terminal: "t18",
      nudges: 0,
      started_at: "2026-11-08T10:19:04Z",
      ended_at: null,
      result: null,
    },
  },
  questions: {
    [Q]: {
      execution_id: E,
      ticket: "PAY-102",
      question: "Should GET /payments/{id} return 404 or 403 for another account's payment?",
      options: [],
      state: "open",
      answer: null,
      share_with_ticket: false,
    },
  },
  findings: [
    {
      id: F,
      ticket: "PAY-102",
      execution_id: E,
      round: 1,
      severity: "high",
      blocking: true,
      title: "Payment id not checked against caller's account",
      file: "src/payments/api.go",
      line: 88,
      addressed_in_round: null,
    },
  ],
  inbox_offsets: { [E]: 1834 },
};
const finishedState = mutate(
  mutate(state, "executions", {
    [E]: {
      ...state.executions[E],
      state: "completed",
      ended_at: "2026-11-08T10:40:00Z",
      result: { summary: "Approved", verdict: "approve" },
    },
  }),
  "status",
  "completed",
);
kind("state").valid = { "paused-on-question": state, "with-result": finishedState };
kind("state").invalid = {
  "ticket-unknown-state": [mutate(state, "tickets.PAY-102.state", "waiting"), "tickets.PAY-102.state"],
  "negative-offset": [mutate(state, "inbox_offsets", { [E]: -1 }), `inbox_offsets.${E}`],
  "attention-unknown-kind": [
    mutate(state, "tickets.PAY-102.attention", [{ kind: "nudge" }]),
    "tickets.PAY-102.attention[0].kind",
  ],
  "pr-unknown-state": [mutate(state, "tickets.PAY-102.pr.state", "open"), "tickets.PAY-102.pr.state"],
};

const CMD = "01JC9A0C000000000000000001";
const cmd = (command: string, args: Json) => ({ v: 1, id: CMD, command, at: "2026-11-08T10:29:00Z", args });
const answer = cmd("question.answer", {
  run_id: RUN,
  question_id: Q,
  answer: "Return 404 with the standard error body.",
  share_with_ticket: true,
});
kind("command").valid = {
  "question-answer": answer,
  "board-create": cmd("board.create", {
    name: "Payments API – Q4",
    jira: { site: "[SITE].atlassian.net", project: "PAY" },
    repo: board.repo,
    settings: { complete_at: "pr_created", max_tickets: 3 },
  }),
  "board-import-jql": cmd("board.import", {
    board_id: board.id,
    jql: "project = PAY AND sprint in openSprints()",
  }),
  "board-import-keys": cmd("board.import", { board_id: board.id, keys: ["PAY-101", "PAY-102"] }),
  "run-start": cmd("run.start", { board_id: board.id }),
  "run-pause": cmd("run.pause", { run_id: RUN, reason: "lunch" }),
  "dep-override": cmd("dep.override", { board_id: board.id, blocker: "OPS-77", blocked: "PAY-102" }),
  "profile-save": cmd("profile.save", developer),
  "pr-mark-ready": cmd("pr.mark_ready", { run_id: RUN, ticket: "PAY-102" }),
};
kind("command").invalid = {
  "unknown-command": [cmd("question.reply", {}), "command"],
  "answer-missing-answer": [mutate(answer, "args.answer", DELETE), "args.answer"],
  "import-keys-and-jql": [
    cmd("board.import", { board_id: board.id, keys: ["PAY-1"], jql: "project = PAY" }),
    "args.keys",
  ],
  "run-start-bad-board-id": [cmd("run.start", { board_id: "board-1" }), "args.board_id"],
  "settings-unknown-policy": [
    cmd("board.update_settings", { board_id: board.id, settings: { pr_draft_policy: "never" } }),
    "args.settings.pr_draft_policy",
  ],
};

kind("lock").valid = { lock: { v: 1, pid: 4242, started_at: "2026-11-08T09:59:00.123Z" } };
kind("lock").invalid = {
  "pid-zero": [{ v: 1, pid: 0, started_at: "2026-11-08T09:59:00Z" }, "pid"],
  "missing-started-at": [{ v: 1, pid: 4242 }, "started_at"],
};
kind("leases").valid = {
  leases: { v: 1, leases: { "PAY-101": RUN, "PAY-102": RUN }, updated_at: "2026-11-08T10:01:00Z" },
  empty: { v: 1, leases: {}, updated_at: "2026-11-08T10:01:00Z" },
};
kind("leases").invalid = {
  "run-not-ulid": [
    { v: 1, leases: { "PAY-101": "run-3" }, updated_at: "2026-11-08T10:01:00Z" },
    "leases.PAY-101",
  ],
};

kind("command_reply").valid = {
  ok: { v: 1, id: CMD, ok: true, result: {} },
  "ok-with-result": { v: 1, id: CMD, ok: true, result: { run_id: RUN } },
  error: {
    v: 1,
    id: CMD,
    ok: false,
    error: { code: "invalid_state", message: "Question already answered at 10:28." },
  },
};
kind("command_reply").invalid = {
  "unknown-error-code": [{ v: 1, id: CMD, ok: false, error: { code: "oops", message: "x" } }, "error.code"],
  "ok-missing": [{ v: 1, id: CMD, result: {} }, "ok"],
};

for (const [k, { valid, invalid }] of Object.entries(files)) {
  for (const [name, v] of Object.entries(valid)) put(`files/${k}/valid/${name}.json`, pretty(v));
  for (const [name, [v]] of Object.entries(invalid)) put(`files/${k}/invalid/${name}.json`, pretty(v));
  put(
    `files/${k}/invalid/expected.json`,
    pretty(Object.fromEntries(Object.entries(invalid).map(([n, [, field]]) => [`${n}.json`, field]))),
  );
}

// --- home/: a COLLIE_HOME mid-run, for `collie show task|findings|answers`
// PAY-102 is in remediation. Its open findings: one blocking (body inline), one not blocking
// (body in an attachment); one finding from round 0 is already addressed. Questions: one
// answered for this execution, one shared from the reviewer, one unshared, one still open.
{
  const HR = "01JC8YQ0P4E2W7H5S8D3F6G9KB";
  const DEV = "01JC8ZA0000000000000000001"; // the remediation execution running `collie show`
  const REV = "01JC8Z90000000000000000001"; // the reviewer that raised the findings
  const OLD = "01JC8Z80000000000000000001"; // an earlier developer execution
  const F1 = "01JC8Z910000000000004F2A1C";
  const F2 = "01JC8Z920000000000007KQ9D3";
  const F0 = "01JC8Z81000000000000B6M2X8";
  const Q1 = "01JC8ZA10000000000003QWE7P";
  const Q2 = "01JC8Z930000000000009XRT5V";
  const Q3 = "01JC8Z940000000000001ZZB4N";
  const Q4 = "01JC8ZA20000000000005HJK8M";
  const runPath = `home/runs/${HR}`;
  const ev = (id: string, exec: string, payload: Json, ts: string) => ({
    v: 1,
    id,
    type: "finding",
    ts,
    source: "agent",
    run_id: HR,
    execution_id: exec,
    ticket: "PAY-102",
    caused_by: null,
    payload,
  });
  const f1 = ev(
    F1,
    REV,
    {
      severity: "high",
      category: "security",
      title: "Payment id not checked against caller's account",
      file: "src/payments/api.go",
      line: 88,
      body: "GET /payments/{id} returns any payment by id.\nAnother account's payment is readable.",
      suggestion: "Scope the lookup by account id from the auth context.",
      blocking: true,
    },
    "2026-11-08T10:30:01.000Z",
  );
  const f2 = ev(
    F2,
    REV,
    {
      severity: "medium",
      category: "tests",
      title: "Handler tests miss the error paths",
      body_ref: `attachments/${F2}.md`,
      blocking: false,
    },
    "2026-11-08T10:30:02.000Z",
  );
  const f0 = ev(
    F0,
    OLD,
    { severity: "low", title: "Typo in a log message", body: "recieved", blocking: false },
    "2026-11-08T10:10:00.000Z",
  );
  put(`${runPath}/events.jsonl`, [f0, f1, f2].map(line).join(""));
  put(
    `${runPath}/executions/${REV}/attachments/${F2}.md`,
    "Missing tests:\n- 404 for an unknown id\n- 400 for a bad amount\n",
  );
  const finding = (
    id: string,
    exec: string,
    round: number,
    severity: string,
    blocking: boolean,
    title: string,
    extra: Json,
    addressed: number | null,
  ) => ({
    id,
    ticket: "PAY-102",
    execution_id: exec,
    round,
    severity,
    blocking,
    title,
    ...extra,
    addressed_in_round: addressed,
  });
  const q = (exec: string, question: string, state: string, answer: string | null, share: boolean) => ({
    execution_id: exec,
    ticket: "PAY-102",
    question,
    options: [],
    state,
    answer,
    share_with_ticket: share,
  });
  const homeState = {
    v: 1,
    run_id: HR,
    last_event_id: Q4,
    status: "running",
    leases: ["PAY-102"],
    tickets: {
      "PAY-102": {
        state: "remediating",
        resume_state: null,
        attention: [],
        round: 1,
        branch: "pay-102-api",
        base: "main",
        executions: [OLD, REV, DEV],
        pr: null,
      },
    },
    executions: {
      [DEV]: {
        ticket: "PAY-102",
        profile: "developer",
        kind: "remediate",
        state: "working",
        attempt: 1,
        round: 1,
        terminal: "t21",
        nudges: 0,
        started_at: "2026-11-08T10:31:00Z",
        ended_at: null,
        result: null,
      },
    },
    questions: {
      [Q1]: q(
        DEV,
        "Should the 404 body include the payment id?",
        "delivered",
        "No: never echo ids back.",
        false,
      ),
      [Q2]: q(
        REV,
        "Is cross-account access ever allowed for admins?",
        "delivered",
        "No, not even for admins.",
        true,
      ),
      [Q3]: q(REV, "Which reviewer owns the tests?", "delivered", "Not shared with the ticket.", false),
      [Q4]: q(DEV, "Is pagination in scope?", "open", null, false),
    },
    findings: [
      finding(F0, OLD, 0, "low", false, "Typo in a log message", {}, 1),
      finding(F2, REV, 1, "medium", false, "Handler tests miss the error paths", {}, null),
      finding(
        F1,
        REV,
        1,
        "high",
        true,
        "Payment id not checked against caller's account",
        { file: "src/payments/api.go", line: 88 },
        null,
      ),
    ],
    inbox_offsets: {},
  };
  put(`${runPath}/state.json`, pretty(homeState));
  put(
    `${runPath}/executions/${DEV}/execution.json`,
    pretty({
      v: 1,
      id: DEV,
      run_id: HR,
      ticket: "PAY-102",
      profile: "developer",
      role: "developer",
      kind: "remediate",
      round: 1,
      attempt: 1,
      worktree: "~/.herdr/worktrees/[REPO]/pay-102-api",
      branch: "pay-102-api",
      base: "main",
      terminal: "t21",
      created_at: "2026-11-08T10:31:00Z",
    }),
  );
  put(
    `${runPath}/executions/${DEV}/task.md`,
    `# PAY-102 · Payment API endpoints

You are the Developer on PAY-102.
Kind: remediate · round 1 · attempt 1

## Ticket
Add GET and POST /payments.

### Acceptance criteria
- GET /payments/{id} returns the caller's payment, or 404.

## Context
- Repository: [WORKSPACE]/[REPO]
- Working directory: ~/.herdr/worktrees/[REPO]/pay-102-api
- Branch: pay-102-api, based on main

## Your task
Address the findings below. Fix every blocking finding. Fix non-blocking ones where it's cheap; otherwise say why in your done summary. Commit as before.

## Findings to address
Run \`collie show findings\`.

## Limits
Time limit: 60 minutes.
`,
  );
  put(`${runPath}/executions/${DEV}/inbox.jsonl`, "");
}

// --- boards/: graph shapes for the layout and readiness tests
{
  const T = board.tickets["PAY-101"] as Board["tickets"][string];
  const mk = (
    name: string,
    links: Record<string, string[]>,
    opts: { external?: string[]; done?: string[]; overrides?: [string, string][] } = {},
  ) => {
    const keys = new Set<string>(Object.keys(links));
    for (const bs of Object.values(links)) for (const b of bs) keys.add(b);
    const tickets: Board["tickets"] = {};
    for (const k of [...keys].sort()) {
      const done = opts.done?.includes(k);
      tickets[k] = {
        ...T,
        summary: `Ticket ${k}`,
        jira_status: done ? "Done" : "To Do",
        status_category: done ? "done" : "new",
        resolution: done ? "Done" : null,
        blocked_by: [...(links[k] ?? [])].sort(),
        on_board: !opts.external?.includes(k),
        preparation: opts.external?.includes(k) ? "unreviewed" : "ready",
      };
    }
    const b: Board = {
      ...board,
      name: `Shape: ${name}`,
      tickets,
      overrides: (opts.overrides ?? []).map(([blocker, blocked]) => ({
        blocker,
        blocked,
        by: "human",
        at: "2026-11-08T09:52:00Z",
      })),
    };
    put(`boards/${name}.json`, pretty(b));
  };
  mk("single", { "PAY-1": [] });
  mk("chain", { "PAY-1": [], "PAY-2": ["PAY-1"], "PAY-3": ["PAY-2"], "PAY-4": ["PAY-3"] });
  mk("fan-in-fan-out", {
    "PAY-1": [],
    "PAY-2": [],
    "PAY-3": [],
    "PAY-4": ["PAY-1", "PAY-2", "PAY-3"],
    "PAY-5": ["PAY-4"],
    "PAY-6": ["PAY-4"],
    "PAY-7": ["PAY-4"],
  });
  mk("diamond", { "PAY-1": [], "PAY-2": ["PAY-1"], "PAY-3": ["PAY-1"], "PAY-4": ["PAY-2", "PAY-3"] });
  // Edges that skip layers: PAY-1 -> PAY-5 spans four columns, past PAY-2..4.
  mk("long-edges", {
    "PAY-1": [],
    "PAY-2": ["PAY-1"],
    "PAY-3": ["PAY-2"],
    "PAY-4": ["PAY-3"],
    "PAY-5": ["PAY-4", "PAY-1"],
    "PAY-6": ["PAY-1", "PAY-3"],
    "PAY-7": ["PAY-2"],
  });
  mk(
    "external-blockers",
    { "PAY-1": ["OPS-77"], "PAY-2": ["PAY-1", "SEC-9"], "PAY-3": ["OPS-77", "PAY-2"] },
    { external: ["OPS-77", "SEC-9"], done: ["SEC-9"] },
  );
  mk("cycle", {
    "PAY-1": ["PAY-3"],
    "PAY-2": ["PAY-1"],
    "PAY-3": ["PAY-2"],
    "PAY-4": ["PAY-3"],
    "PAY-5": [],
  });
  mk(
    "cycle-overridden",
    { "PAY-1": ["PAY-3"], "PAY-2": ["PAY-1"], "PAY-3": ["PAY-2"] },
    { overrides: [["PAY-3", "PAY-1"]] },
  );
  mk("islands", {
    "PAY-1": [],
    "PAY-2": ["PAY-1"],
    "PAY-10": [],
    "PAY-11": ["PAY-10"],
    "PAY-12": ["PAY-10"],
    "PAY-20": [],
  });
  // The spike's 20-node graph (docs/spike.md, experiment 4), with EXT-9 outside the board.
  mk(
    "spike-20",
    {
      "PAY-101": [],
      "PAY-102": [],
      "PAY-103": [],
      "PAY-104": ["PAY-101"],
      "PAY-105": ["PAY-101", "PAY-102"],
      "PAY-106": ["PAY-102", "EXT-9"],
      "PAY-107": ["PAY-103"],
      "PAY-108": ["PAY-103"],
      "PAY-109": ["PAY-104"],
      "PAY-110": ["PAY-105"],
      "PAY-111": ["PAY-105", "PAY-106"],
      "PAY-112": ["PAY-107", "PAY-108"],
      "PAY-113": ["PAY-108"],
      "PAY-114": ["PAY-109"],
      "PAY-115": ["PAY-110", "PAY-111"],
      "PAY-116": ["PAY-111"],
      "PAY-117": ["PAY-112", "PAY-113"],
      "PAY-118": ["PAY-115", "PAY-116"],
      "PAY-119": ["PAY-117", "PAY-114"],
    },
    { external: ["EXT-9"], done: ["PAY-101", "PAY-104"] },
  );
  // A deterministic pseudo-random DAG: 40 tickets, each blocked by up to 3 earlier ones.
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const random: Record<string, string[]> = {};
  for (let i = 1; i <= 40; i++) {
    const k = `PAY-${i}`;
    const n = i === 1 ? 0 : Math.floor(rand() * 4);
    const bs = new Set<string>();
    for (let j = 0; j < n; j++) bs.add(`PAY-${1 + Math.floor(rand() * (i - 1))}`);
    random[k] = [...bs];
  }
  mk("random-40", random);
}

// --- the complete run
put("runs/complete/events.jsonl", complete.events.map(line).join(""));
put("runs/complete/run.json", pretty(complete.run));
// state.json for the finished run, as the controller's reducer builds it from the log.
put("runs/complete/state.json", pretty(rebuild(complete.runId, complete.events as unknown as AnyEvent[])));
for (const e of complete.executions) put(`runs/complete/executions/${e.id}/execution.json`, pretty(e));

// --- write or check
function listFiles(dir: string): string[] {
  let found: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    found = e.isDirectory() ? found.concat(listFiles(p)) : found.concat(p);
  }
  return found;
}

const existing = GENERATED_DIRS.flatMap((d) => listFiles(join(ROOT, d))).map((p) => relative(ROOT, p));
if (process.argv.includes("--check")) {
  const problems: string[] = [];
  for (const [p, content] of out) {
    let disk: string | null = null;
    try {
      disk = readFileSync(join(ROOT, p), "utf8");
    } catch {}
    if (disk !== content) problems.push(disk === null ? `missing ${p}` : `differs ${p}`);
  }
  for (const p of existing) if (!out.has(p)) problems.push(`stale ${p}`);
  if (problems.length) {
    console.error(`fixtures are out of date (run: bun fixtures/src/build.ts):\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`fixtures up to date (${out.size} files)`);
} else {
  for (const d of GENERATED_DIRS) rmSync(join(ROOT, d), { recursive: true, force: true });
  for (const [p, content] of out) {
    mkdirSync(dirname(join(ROOT, p)), { recursive: true });
    writeFileSync(join(ROOT, p), content);
  }
  console.log(`wrote ${out.size} fixture files`);
}
