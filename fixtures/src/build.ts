// Writes every fixture under fixtures/ from the definitions below.
//
//   bun fixtures/src/build.ts           write the files
//   bun fixtures/src/build.ts --check   exit 1 if a committed file differs (run by the tests)
//
// Layout:
//   inbox/{valid,invalid}/*.jsonl     one inbox line each (an agent event)
//   events/{valid,invalid}/*.jsonl    one controller event line each
//   files/<kind>/{valid,invalid}/*.json   config, runtime and control files
//   runs/complete/                    events.jsonl, run.json and executions/ for one complete run
// Every invalid/ folder has expected.json: file name -> the field path the error must name
// ("" for whole-line problems such as a missing newline).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CONTROLLER_EVENT_TYPES } from "@collie/schema";
import { buildCompleteRun, type FixtureEvent } from "./complete-run.ts";
import { analyst, board, developer, securityReviewer, smallBugFix, standardFeature } from "./config.ts";
import { FixtureClock } from "./ids.ts";

const ROOT = join(import.meta.dir, "..");
const GENERATED_DIRS = ["inbox", "events", "files", "runs"];

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

// --- the complete run
put("runs/complete/events.jsonl", complete.events.map(line).join(""));
put("runs/complete/run.json", pretty(complete.run));
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
