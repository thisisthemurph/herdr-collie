# Collie — Agent Reporting Protocol & Inbox Format

## Scope and assumptions

One controller process hosts every run, all state is scoped to a run, and a ticket can be active in only one run at a time. The MVP allows one active run per board.

- **One controller.** A single long-lived process, kept alive as a herdr-core terminal, holds `controller.lock` and is the only arbiter of leases and global limits.
- **Run-scoped state.** Each run owns a directory. Once a run ends, its directory is read-only. Retrying means a new run that can carry over completed tickets.
- **Ticket leases.** A ticket key maps to at most one active run. Branch and worktree names derive from the ticket key, so leases also prevent branch collisions.
- **One writer per file.** The `collie` CLI, called by an agent, writes only that agent's inbox. The controller writes everything else.
- **One entry point.** Agents and the Herdr mod both talk to the controller through the `collie` CLI: agents through agent commands, the mod through `collie ctl` via `exec()`. Validation lives in one place.
- **Local only.** Runs, worktrees and agents live on this machine for the MVP. Remote machines are deferred.

## Actions

Three actors act on a run: agents report through the CLI, the person steers through the mod, and the controller does all real work. Agents never start other Collie agents, touch Jira or open PRs.

**Agent actions** (via `collie`, inside an execution)

| Action | Command | Who uses it | Effect |
| --- | --- | --- | --- |
| Read the brief | `collie show task` | All | Prints the ticket, acceptance criteria and constraints |
| Read prior output | `collie show findings` / `collie show answers` | Developer, remediation | Prints findings to fix and answers already given |
| Report progress | `collie status` | All | UI only; no state change |
| Record a finding | `collie finding` | Reviewers | Adds a finding to the ticket run |
| Record an artifact | `collie artifact` | Developer | Records a commit, branch, test report or file |
| Ask a question | `collie ask` | All | Execution and ticket move to Needs input |
| Finish | `collie done` | All | Terminal success, with a structured result |
| Give up | `collie fail` | All | Terminal failure, with a reason and a retryable flag |

**Person actions** (via the mod, which runs `collie ctl`)

| Action | Command | Effect |
| --- | --- | --- |
| Create a board, import tickets | `collie ctl board create` / `import` | Board config written |
| Start a run | `collie ctl run start` | Snapshots config, leases tickets, begins scheduling |
| Pause / resume a run | `collie ctl run pause` / `resume` | Pause stops new dispatch; running agents continue |
| Cancel a run | `collie ctl run cancel` | Kills agents, releases leases, run ends |
| Answer a question | `collie ctl question.answer` | Answer delivered to the waiting agent |
| Cancel / retry an execution | `collie ctl exec cancel` / `retry` | Kills it, or starts a new attempt |
| Override a dependency | `collie ctl dep override` | Recorded; ticket readiness recalculated |
| Exclude a ticket | `collie ctl ticket exclude` | Ticket skipped; downstream stays blocked |

**Controller actions** (internal, each logged as an event)

- Run: acquire and release ticket leases, snapshot board, workflow and profiles, end the run.
- Scheduling: compute readiness from the DAG, apply concurrency limits, pick the next ticket.
- Execution: create the worktree, write `task.md`, launch the agent with `hc run` (env + labels; see *Launching an agent*), deliver answers and nudges with `hc send` (see *Talking to an agent*), kill with `hc kill`.
- Workflow: dispatch reviewers after the developer is done, aggregate findings, dispatch remediation, cap remediation rounds.
- Delivery: verify commits, push the branch, create or update the PR, update Jira.
- Recovery: rebuild state from the event log and reconcile with `hc ls --json` on start.

## Storage layout and inbox format

Agent inboxes are append-only JSONL files, one per execution, written only by the CLI and read by the controller from a saved byte offset.

```
~/.collie/
  controller.lock              # {v, pid, started_at}; one controller
  controller.log               # the controller's own log (never secrets)
  leases.json                  # {v, leases: ticket key -> run id, updated_at} (controller)
  profiles/<profile-id>.json   # reusable agent profiles
  workflows/<workflow-id>.json # reusable workflows
  boards/<board-id>/
    board.json                 # config, tickets, overrides
    prep/                      # board preparation: the requirements analyst
      events.jsonl             # its log, kept like a run's (controller events carry the board id as run_id)
      state.json               # materialised state: executions, questions, findings
      <exec-id>/               # analyst executions (same files as below)
  control/
    pending/<cmd-id>.json      # written by `collie ctl`
    done/<cmd-id>.json         # moved here by controller, with result
  runs/<run-id>/               # ULID: sorts by time
    run.json                   # board id, status, config snapshot
    events.jsonl               # controller's canonical log
    state.json                 # materialised state, derivable from events
    executions/<exec-id>/
      execution.json           # profile, ticket, terminal, worktree, attempt
      task.md                  # the brief given to the agent
      inbox.jsonl              # written only by the collie CLI
      attachments/             # large bodies referenced from events
```

**Inbox rules**

1. UTF-8 JSONL: one event per line, every line ends with `\n`.
2. Append-only. Never rewritten, truncated or deleted while the run lives.
3. The CLI takes an exclusive `flock` on the file, then writes the whole line in one `write()`. Agents may run CLI calls in parallel, so the lock is required.
4. The controller keeps a byte offset per inbox in `state.json`. A final line without `\n` is incomplete: skip it and re-read on the next change.
5. A line is capped at 64 KB. Longer bodies (a detailed finding, a test log) go to `attachments/<event-id>.md` and the event carries `body_ref`.
6. Event ids are ULIDs. The controller de-duplicates by id, so a CLI retry after an uncertain write is safe.
7. The controller never edits an inbox. It records acceptance or rejection of each line as its own event in `events.jsonl`, with `caused_by` set to the inbox event id (null for a line with no readable id) and `offset` set to the inbox byte offset just after the line. An accepted line is copied into `events.jsonl` just before its `agent.event_accepted`; a rejected line isn't copied, so it can never change state. A line's events are written in one append, so after a crash the controller resumes reading exactly after the last line it judged.

**Control commands** use one file per command rather than an append log, because the mod needs a reply. The command line is `collie ctl <command> '<args as JSON>'` (or `--args-file <path|->`), with `--json` to print the reply. A refused command exits 2 with its error code and message. `collie ctl` writes `pending/<cmd-id>.json` atomically (write temp, rename), then waits for `done/<cmd-id>.json`, which holds `ok` or an error. It times out after 10 seconds with a clear message if the controller isn't running.

## Event envelope

Every event, in an inbox or in `events.jsonl`, shares one envelope. The CLI fills in everything except `payload`, so agents never write ids or timestamps.

```json
{
  "v": 1,
  "id": "01JC8Z4Q7R2M5T9VX3KB6N1HDA",
  "type": "finding",
  "ts": "2026-11-08T10:25:13.412Z",
  "source": "agent",
  "run_id": "01JC8YQ0P4E2W7H5S8D3F6G9KB",
  "execution_id": "01JC8Z1A9C4V6B2N8M5X7Z3QWE",
  "ticket": "PAY-102",
  "caused_by": null,
  "payload": { }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `v` | integer | Schema major version. Additive changes don't bump it |
| `id` | ULID string | Unique; used for de-duplication and `caused_by` links |
| `type` | string | Event type, e.g. `finding`, `ticket.state_changed` |
| `ts` | RFC 3339 UTC | Writer's clock, with milliseconds (`2026-11-08T10:25:13.412Z`) |
| `source` | `agent` / `controller` / `human` | Who produced it |
| `run_id` | ULID or null | Always set, even though the path implies it, except for analyst executions, which belong to board preparation and have no run |
| `execution_id` | ULID or null | Null for run- and ticket-level controller events |
| `ticket` | string or null | Jira key; null for run-level events |
| `caused_by` | ULID or null | The event or command that triggered this one |
| `payload` | object | Type-specific; see the next sections |

Readers ignore unknown fields and reject an unknown major `v`. Agent event types are bare words (`done`); controller event types are dotted (`execution.completed`), so the two never collide.

`packages/schema` holds the exact shape of every event, file and command; `fixtures/` has a valid example of each and invalid ones that show the error messages.

## Agent events

Agents can emit six event types. Only `done` and `fail` end an execution, and after either one the CLI refuses further writes for that execution.

| Type | Required payload | Optional payload | Controller effect |
| --- | --- | --- | --- |
| `status` | `message` (≤ 200 chars) | `phase`: `investigating` / `implementing` / `testing` / `reviewing` / `remediating` | UI only |
| `finding` | `severity`, `title`, `body` or `body_ref` | `file`, `line`, `end_line`, `category`, `suggestion`, `blocking` | Added to the ticket run's findings |
| `artifact` | `kind`, `ref` | `description` | Recorded; commits verified before delivery |
| `ask` | `question` | `options`, `context` | Execution and ticket move to Needs input; person notified |
| `done` | `summary` | `verdict`, `commits`, `tests` | Execution completed; workflow advances |
| `fail` | `reason`, `category`, `retryable` | `details` | Execution failed; retry policy applies |

**Enumerations**

- `severity`: `critical`, `high`, `medium`, `low`, `info`. `blocking` defaults to true for `critical` and `high`.
- `category` (finding): `security`, `correctness`, `tests`, `performance`, `design`, `style`.
- `kind` (artifact): `commit`, `branch`, `test_report`, `file`.
- `verdict` (done): `approve` or `request_changes`. Required when the profile's role is reviewer.
- `category` (fail): `blocked_external`, `cannot_implement`, `tooling`, `environment`, `other`.

**A reviewer finding**

```json
{"type": "finding", "payload": {
  "severity": "high",
  "category": "security",
  "title": "Payment id not checked against caller's account",
  "file": "src/payments/api.go", "line": 88,
  "body": "GET /payments/{id} returns any payment by id ...",
  "suggestion": "Scope the lookup by account id from the auth context."
}}
```

**A developer finishing**

```json
{"type": "done", "payload": {
  "summary": "Added payment API endpoints with handler tests",
  "commits": ["a1b2c3d"],
  "tests": {"command": "go test ./src/payments/...", "passed": true}
}}
```

Role rules the controller enforces: a developer's `done` needs at least one commit on the ticket branch and a clean worktree; a reviewer's `done` needs a `verdict`, and `request_changes` needs at least one blocking finding.

## Controller events and answer delivery

The controller's `events.jsonl` is the run's single source of truth; `state.json` and the mod's views are both rebuilt from it.

| Group | Event types | Key payload |
| --- | --- | --- |
| Run | `run.started`, `run.paused`, `run.resumed`, `run.completed`, `run.cancelled` | `reason` |
| Lease | `ticket.leased`, `ticket.released` | — |
| Ticket | `ticket.state_changed` | `from`, `to`, `reason` |
| Execution | `execution.created`, `execution.started`, `execution.state_changed`, `execution.nudged`, `execution.completed`, `execution.failed`, `execution.killed` | `profile`, `attempt`, `terminal`, `worktree`, `from`, `to`, `nudge`, `result` |
| Agent input | `agent.event_accepted`, `agent.event_rejected` | `event_type`, `offset`; `reason` on rejection |
| Attention | `ticket.attention_added`, `ticket.attention_removed` | `kind` (`round_cap`, `execution_failed`, `delivery_error`), optional `id`; questions use the question events |
| Questions | `question.opened`, `question.answered`, `question.delivered` | `question_id`, `answer`, `by` |
| Execution status | `execution.agent_blocked`, `execution.agent_unblocked` | `kind` (`permission` or `question`, from hc), optional `message` (hc's `status.msg`) |
| Delivery | `pr.created`, `pr.updated`, `pr.conflict_checked`, `jira.updated`, `jira.writeback_skipped` | `number`, `url`, `base`, `head`, `transition`; `conflicted` and `paths` for a conflict check; `target` and `available` for a skipped write-back |
| Commands | `command.applied`, `command.rejected` | `command`; `code` and `reason` on rejection |
| Retention | `worktree.kept`, `worktree.removed`, `retention.pruned` | `worktree`, `reason`, `paths` (see *Retention*) |

**How an answer reaches an agent**

1. The agent runs `collie ask "..."`. The CLI appends an `ask` event, whose id becomes the question id, and prints: *Question 01JC8Z7Q… recorded. End your turn now; the answer will arrive as your next message.*
2. The controller emits `question.opened`, moves the execution and ticket to Needs input, and the mod raises a Herdr notification.
3. The person answers in the mod, which runs `collie ctl question.answer` with the question id and the text.
4. The controller emits `question.answered`, then waits until the agent's turn has ended (`idle` or `done`, see *Talking to an agent*), so it never types into a working agent.
5. It sends the answer with `hc send`, formatted as `[collie] Answer to your question <last six characters of the id>: ... Continue the task.`, emits `question.delivered`, and moves the execution back to Working.

`collie show answers` lists every answer for the execution, so an agent that loses context can recover them.

**Launching an agent** (settled by the Phase 0 spike, `docs/spike.md` 3 and 3b)

```
hc run --bg --json --no-parent --no-notify --name <exec-slug> --cwd <worktree> \
  --label collie.run=<run-id> --label collie.execution=<exec-id> --label collie.ticket=<key> \
  [--label herdr.space=<id> --label herdr.tab=<id>] \
  -- env COLLIE_HOME=… COLLIE_INBOX=… COLLIE_RUN_ID=… COLLIE_EXECUTION_ID=… COLLIE_TICKET=… COLLIE_ROLE=… \
     <harness argv built by the adapter>
```

- `hc run` has no option for environment variables, so they go through an `env` argv wrapper. Use argv, not a shell string, so nothing is re-quoted.
- `--no-parent`: the controller runs in an hc terminal itself, and a child started from it dies with it by default. Agents must outlive a controller restart.
- `--no-notify`: otherwise hc types notes about the child into the controller's own terminal.
- Never put a secret in this command line or its environment: the environment is readable by the same user (`ps -E`).
- A terminal is named `<ticket>-<last six characters of the execution id>`, lower case, within hc's 32 characters.
- **Trust dialog (found against real Claude Code).** A new worktree makes Claude Code ask whether to trust the folder. hc reports the agent `idle`, not `blocked`, so the controller reads the screen (`hc read --lines 0`) once the agent has been at turn 0 for 10 seconds; if it shows the dialog, it logs `execution.agent_blocked` (`permission`) and does not start the 60-second timeout. Collie doesn't answer the dialog: the person does, in the agent's terminal. Trusting the parent folder (`~/.herdr/worktrees`) in Claude Code's settings does **not** stop the dialog for a new worktree; Claude Code remembers trust once per repository, so the dialog appears on a repository's first run. Time spent waiting on it doesn't count against the 60 seconds.
- The execution moves to `working` only once `hc get` shows `turn >= 1` or `working`. An agent still at `idle`, turn 0, 60 seconds after launch means its first message never arrived: fail the execution as `tooling`, retryable.

**Talking to an agent**

- **Turn ended** means hc status `idle` or `done`. `done` is only "finished while nobody looked" and is treated the same as `idle`. Wait for it with `hc wait <terminal>`; don't poll the screen.
- **Send** answers and nudges with `hc send <terminal> "<text>"` only when the status is `idle` or `done`. Run `hc send` with `HC_TERMINAL_ID` removed from its environment, or the agent receives the text wrapped in `<hc from="…">…</hc>`.
- Never use `hc send --if idle` (it refuses `done`) or `--force` (it would answer a permission or question dialog).
- Exit code 9 (`blocked`) or 10 (`status_mismatch`) means nothing was typed: keep the message pending and retry at the next turn end.
- **Blocked:** when hc reports `blocked`, the controller logs `execution.agent_blocked` with its `kind` (`permission` or `question`) and the mod shows it on the execution. It clears with `execution.agent_unblocked` when the status leaves `blocked`. It is not an execution state; the person resolves it in the agent's terminal.
- The `turn` counter from `hc get` rises once per turn. A rise after a send confirms the agent took it.

## CLI design

The CLI is written for agents first: plain-text output that says exactly what happened and what to do next, and errors that tell the agent how to fix the call.

**Environment** (set by the controller on launch)

| Variable | Example | Used for |
| --- | --- | --- |
| `COLLIE_HOME` | `~/.collie` | Root of all state |
| `COLLIE_INBOX` | `.../executions/<id>/inbox.jsonl` | Where agent events go |
| `COLLIE_RUN_ID` | ULID | Envelope field |
| `COLLIE_EXECUTION_ID` | ULID | Envelope field |
| `COLLIE_TICKET` | `PAY-102` | Envelope field, `show task` |
| `COLLIE_ROLE` | `developer` / `reviewer` / `analyst` | Role checks before writing |

The same ids also go on the terminal as `hc` labels (`collie.run`, `collie.execution`, `collie.ticket`), so the controller can rediscover agents after a restart. `hc run` can't set environment variables itself; see *Launching an agent* for the `env` wrapper. Labels aren't visible as environment variables; an agent can read them with `hc get $HC_TERMINAL_ID --json`.

**Long text** comes from `--body-file <path>` or `-` for stdin, never a giant flag value. Bodies over 64 KB are moved to `attachments/` automatically.

**Checks before writing** (cheap, local, and they save a round trip)

- `done` as developer: refuses if `git status` shows uncommitted or untracked files, or there are no commits ahead of the base branch (`base` in `execution.json`). Without `--commit`, it records every commit ahead of base.
- `done` as reviewer: refuses without `--verdict`, `request_changes` with no blocking findings recorded, or `approve` with blocking findings recorded. Only reviewers give a verdict.
- `finding` is for reviewers and analysts; `artifact` is for developers.
- `finding` always writes `blocking`: `--blocking` or `--not-blocking` when given, otherwise true for `critical` and `high`.
- Any write: refuses if the execution already has a `done` or `fail`. The CLI checks this under the inbox lock.
- A final inbox line without `\n` can only be left by a writer that died mid-write. The next write closes it off with a newline first, so the torn line is rejected on its own instead of corrupting the new one.

**Exit codes**

| Code | Meaning |
| --- | --- |
| 0 | Written (or, for `ctl`, applied) |
| 2 | Invalid arguments; the message says what to change |
| 3 | Not inside a Collie execution (environment missing) |
| 4 | Execution already ended |
| 5 | I/O error; safe to retry. The CLI has already retried the write with the same event id, checking first whether the line landed. |
| 6 | `ctl` only: controller not running or command timed out |

Output is human-readable by default. `--json` prints the written event or command result, for the mod.

The controller writes a short usage block into each agent's instructions, and `collie --help` stays under a screen so agents read it fully.

## Lifecycle rules

An execution ends only through `done`, `fail`, or the controller killing it; a process exiting or going idle never counts as success.

- **Idle without a report.** When the agent's turn has ended (`idle` or `done`) and the inbox has no `done` or `fail`, wait 30 seconds; if the turn is still ended, nudge with `hc send` (rules under *Talking to an agent*): *You haven't reported a result. Run `collie done` or `collie fail`.* After 2 nudges, fail the execution with category `tooling`, retryable.
- **Exit without a report.** If the terminal exits first, fail with category `tooling`, retryable.
- **Timeouts.** Each profile has a wall-clock limit. On expiry, kill the terminal and fail as retryable.
- **Retries.** A retry is a new execution with `attempt` + 1, in the same worktree. The profile's retry policy caps attempts.
- **Remediation rounds.** Capped per workflow (default 2). Hitting the cap moves the ticket to Needs input instead of looping.
- **Pause and cancel.** Pause stops new dispatch and leaves running agents alone. Cancel kills agents, releases leases and ends the run.
- **Recovery on controller start.**
  1. Acquire `controller.lock`; refuse to start if another controller holds it.
  2. For each run not ended, rebuild state from `events.jsonl`, checking it against `state.json`. A torn final line in `events.jsonl` (a crash mid-append) is cut off first; the controller is its only writer.
  3. Reconcile with hc: `hc ls --json --label collie.run=<run-id>` lists the run's live terminals, and `hc get <terminal> --json` gives each one's labels, matched by `collie.execution`. (`hc ls` entries carry no labels themselves; see `fixtures/hc/`.) Agents were started with `--no-parent`, so they survive the old controller.
  4. Resume reading each inbox from its saved offset.
  5. Fail as retryable any execution whose terminal is gone, then re-apply leases.
- **Versioning.** The CLI and controller ship from one repo and share the schema. The controller rejects an unknown major `v` with `agent.event_rejected`; minor additions are just new optional fields.

## Configuration files

Profiles, workflows and boards are configuration: the person edits them through `collie ctl`, the controller writes them, and a run copies them into its snapshot at start so later edits never change a running run.

Shared conventions for every file in this section and the next: a top-level `"v": 1`, ULIDs for generated ids, slugs (`[a-z0-9-]`) for human-named ids, RFC 3339 UTC timestamps, and atomic writes (temp file, then rename). Workflows live in `~/.collie/workflows/<workflow-id>.json`, beside `profiles/`.

**Agent profile** — `profiles/<profile-id>.json`

```json
{
  "v": 1,
  "id": "security-reviewer",
  "name": "Security reviewer",
  "role": "reviewer",
  "harness": "claude-code",
  "model": "[MODEL]",
  "args": ["--permission-mode", "plan"],
  "instructions": "Review the diff for authz, injection, secrets ...",
  "permissions": { "write_worktree": false, "shell": true, "network": false },
  "timeout_min": 30,
  "max_attempts": 2,
  "updated_at": "2026-11-08T10:00:00Z"
}
```

- `role`: `developer`, `reviewer` or `analyst`. It decides which CLI checks apply and which workflow slots the profile can fill.
- `harness`: names a controller-side adapter that knows how to build the command line, pass the brief, and detect idle for that tool. The MVP ships `claude-code`. `args` are appended to what the adapter builds.
- The `claude-code` adapter (from the Phase 0 spike):
  - it resolves `claude` to an absolute path, because `hc run` doesn't expand shell aliases
  - it adds `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` to the `env` wrapper; background shells end the turn while work is still running, so status would read `done` early
  - it puts the first message before any options (`claude "<first message>" --settings … <args>`), because variadic options such as `--allowedTools` swallow a trailing prompt silently
- `instructions` are the profile's own text. The controller appends the standard Collie reporting block after them, so profiles never repeat it.
- `max_attempts` counts the first attempt: 2 means one automatic retry.

**Workflow** — `workflows/<workflow-id>.json`

```json
{
  "v": 1,
  "id": "standard-feature",
  "name": "Standard feature",
  "developer": "developer",
  "reviewers": [
    { "profile": "security-reviewer", "required": true },
    { "profile": "backend-reviewer", "required": true },
    { "profile": "frontend-reviewer", "required": false }
  ],
  "max_remediation_rounds": 2
}
```

- A workflow with no reviewers goes straight from development to delivery (the Small bug fix workflow).
- Optional reviewers run in parallel with required ones. Their findings reach the developer during remediation, but only required reviewers' verdicts decide the gate.
- **Remediation trigger, resolved:** a reviewer may only `approve` with no blocking findings of its own, and may only `request_changes` with at least one. Verdict and findings therefore always agree, and remediation starts when any required reviewer requests changes.

**Board** — `boards/<board-id>/board.json`

```json
{
  "v": 1,
  "id": "01JC8XW0...",
  "name": "Payments API – Q4",
  "jira": { "site": "[SITE].atlassian.net", "cloud_id": "[CLOUD-ID]", "project": "PAY" },
  "repo": {
    "workspace": "[WORKSPACE]", "slug": "[REPO]",
    "default_branch": "main", "local_path": "~/code/[REPO]"
  },
  "settings": {
    "workflow": "standard-feature",
    "max_tickets": 3,
    "max_agents": 6,
    "completion_policy": { "mode": "done_or_resolved", "statuses": [] },
    "complete_at": "pr_created",
    "pr_draft_policy": "draft_when_stacked",
    "jira_writeback": { "on_start": "In Progress", "on_pr": "In Review", "comment": true }
  },
  "tickets": {
    "PAY-102": {
      "summary": "Payment API endpoints",
      "jira_status": "In Progress", "status_category": "indeterminate", "resolution": null,
      "blocked_by": ["PAY-101"],
      "on_board": true,
      "preparation": "ready",
      "workflow": null,
      "fetched_at": "2026-11-08T09:40:00Z"
    }
  },
  "overrides": [
    { "blocker": "OPS-77", "blocked": "PAY-106", "by": "human", "at": "2026-11-08T09:52:00Z" }
  ],
  "updated_at": "2026-11-08T09:52:00Z"
}
```

- `tickets` holds every ticket on the board plus every external blocker (`on_board: false`), so the graph can draw outside blockers and readiness can check them. Pulling a blocker in sets `on_board` to true.
- `preparation`: `unreviewed`, `investigating`, `needs_input`, `ready` or `excluded`.
- `workflow`: null means the board default.
- Two different completion rules, deliberately: `completion_policy` decides whether a blocker **outside the run** is satisfied, from its Jira status; `complete_at` (`implemented`, `pr_created`, `pr_approved` or `merged`) decides when a ticket **inside the run** counts as done for its dependents.
- `completion_policy.mode`: `done_only`, `done_or_resolved`, `done_or_testing` or `custom`, where `statuses` lists the Jira statuses that count.
- `pr_draft_policy`: `draft_when_stacked` or `always_draft`.
- `jira.cloud_id`: looked up once from `https://[SITE].atlassian.net/_edge/tenant_info` when the board is created. Every Jira call goes through `https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/…`, because a scoped token is rejected on the site URL.
- `completion_policy` modes map to Jira's `statusCategory.key` (`new`, `indeterminate`, `done`) for `done_only`; `done_or_resolved` adds a non-null `resolution`; `done_or_testing` adds any status whose name mentions "test" or "QA"; `custom` matches the listed status names, ignoring case.
- Dependencies come from Jira's **Blocks** links only. On issue A, `{type: Blocks, outwardIssue: B}` means A blocks B, and `{inwardIssue: B}` means B blocks A (confirmed against real issues; `fixtures/jira/`). A link seen from either end counts. A linked issue not on the board becomes a ticket with `on_board: false`; links carry its summary and status but not its resolution, so that stays null until it's pulled in or refreshed.
- `board.create` without `jira.cloud_id` looks it up from the site's `/_edge/tenant_info`. `run.start` refuses a board whose in-scope tickets have a dependency cycle (`cycle_detected`, naming the cycle); an overridden link doesn't count.
- In an active run, readiness is recalculated whenever the board changes (`board.refresh`, `board.import`, `ticket.pull_in`, `ticket.set_preparation`, `dep.override`/`dep.restore`): outside blockers use the board's current Jira data and overrides, in-run blockers count once `completed` in the run.
- `jira_writeback` values are **target status names**. Each write lists the issue's transitions and picks the one whose `to.name` matches, preferring an exact transition `name` when there's more than one. If none matches, the controller logs `jira.writeback_skipped` with the available targets and carries on; the ticket isn't failed.
- An entry in `overrides` makes the scheduler ignore that one blocking link.

## Runtime files

A run's files are written only by the controller. `events.jsonl` is the truth; `state.json` is a cache of it that the mod reads, and can always be thrown away and rebuilt.

**Run** — `runs/<run-id>/run.json`, written at start and whenever the run's status changes

```json
{
  "v": 1,
  "id": "01JC8YQ0...",
  "board_id": "01JC8XW0...",
  "number": 3,
  "status": "running",
  "started_at": "2026-11-08T10:01:00Z",
  "ended_at": null,
  "end_reason": null,
  "carried_over_from": null,
  "snapshot": {
    "settings": { "...": "board settings at start" },
    "tickets": { "...": "board tickets at start" },
    "overrides": [],
    "workflows": { "standard-feature": { "...": "full workflow" } },
    "profiles": { "developer": { "...": "full profile" } }
  }
}
```

- `number` counts runs per board, for display ("Run 3").
- `carried_over_from`: the run id whose completed tickets this run starts as completed.

**Execution** — `runs/<run-id>/executions/<exec-id>/execution.json`, written at creation and again when the terminal starts

```json
{
  "v": 1,
  "id": "01JC8Z1A...",
  "run_id": "01JC8YQ0...",
  "ticket": "PAY-102",
  "profile": "frontend-reviewer",
  "role": "reviewer",
  "kind": "review",
  "round": 1,
  "attempt": 1,
  "worktree": "~/.herdr/worktrees/[REPO]/pay-102-api",
  "branch": "pay-102-api",
  "base": "pay-101-persistence",
  "terminal": "t18",
  "created_at": "2026-11-08T10:19:00Z"
}
```

- `kind`: `analyse`, `develop`, `review` or `remediate`. Remediation is a developer execution with the open findings in its brief.
- `base`: the branch `branch` is based on. The CLI reads it for a developer's "commits ahead of base" check; without it, that check is left to the controller.
- Analyst executions belong to board preparation and have `run_id: null`; they live under `boards/<board-id>/prep/<exec-id>/` with the same files.

**Materialised state** — `runs/<run-id>/state.json`

```json
{
  "v": 1,
  "run_id": "01JC8YQ0...",
  "last_event_id": "01JC8Z9K...",
  "status": "running",
  "leases": ["PAY-102", "PAY-103"],
  "tickets": {
    "PAY-102": {
      "state": "needs_input",
      "resume_state": "reviewing",
      "attention": [{ "kind": "question", "id": "01JC8Z7Q..." }],
      "round": 1,
      "branch": "pay-102-api",
      "base": "pay-101-persistence",
      "executions": ["01JC8Z1A..."],
      "pr": {
        "id": 147, "url": "https://bitbucket.org/...",
        "source": "pay-102-api", "destination": "pay-101-persistence",
        "draft": true, "state": "OPEN", "approvals": 0, "conflicted": false, "conflict_checked_at": null
      }
    }
  },
  "executions": {
    "01JC8Z1A...": {
      "ticket": "PAY-102", "profile": "frontend-reviewer", "kind": "review",
      "state": "needs_input", "attempt": 1, "round": 1,
      "terminal": "t18", "nudges": 0,
      "started_at": "2026-11-08T10:19:04Z", "ended_at": null,
      "result": null
    }
  },
  "questions": {
    "01JC8Z7Q...": {
      "execution_id": "01JC8Z1A...", "ticket": "PAY-102",
      "question": "Should GET /payments/{id} return 404 ...", "options": [],
      "state": "open", "answer": null, "share_with_ticket": false
    }
  },
  "findings": [
    {
      "id": "01JC8Z6F...", "ticket": "PAY-102", "execution_id": "01JC8Z1B...",
      "round": 1, "severity": "high", "blocking": true,
      "title": "Payment id not checked against caller's account",
      "file": "src/payments/api.go", "line": 88,
      "addressed_in_round": null
    }
  ],
  "inbox_offsets": { "01JC8Z1A...": 1834 }
}
```

- **Question ids are the `ask` event's id.** The CLI knows it at write time, so `collie ask` prints it, and the UI shows its last six characters.
- `result` holds the accepted `done` or `fail` payload.
- `pr.conflicted` doesn't come from Bitbucket, whose API has no conflict state. The controller fetches the destination branch and runs `git merge-tree --write-tree <destination> <source>` (git 2.38 or later): exit 1 means conflicted. Each check is logged as `pr.conflict_checked`.
- `pr.approvals` counts approvals from anyone except the PR's author. Collie's own bot can approve its own PR through the API, but Bitbucket doesn't count that approval.
- `attention` lists everything holding the ticket in Needs input; the ticket resumes when the list is empty.
- The controller rewrites `state.json` after each batch of events, at most every 250 ms. The mod watches it and never reads `events.jsonl` except for the Activity view.

**Control commands** — `control/pending/<cmd-id>.json` and `control/done/<cmd-id>.json`

```json
{ "v": 1, "id": "01JC9A0C...", "command": "question.answer", "at": "2026-11-08T10:29:00Z",
  "args": { "run_id": "01JC8YQ0...", "question_id": "01JC8Z7Q...",
            "answer": "Return 404 with the standard error body.", "share_with_ticket": true } }
```

```json
{ "v": 1, "id": "01JC9A0C...", "ok": false,
  "error": { "code": "invalid_state", "message": "Question already answered at 10:28." } }
```

A successful reply is `{"v": 1, "id": …, "ok": true, "result": {…}}`.

| Command | Args | Result |
| --- | --- | --- |
| `board.create` | `name`, `jira`, `repo`, `settings` | `board_id` |
| `board.import` | `board_id`, `keys` or `jql` | `added`, `external` |
| `board.refresh` | `board_id` | `changed`, `missing` (keys Jira no longer returns), `readiness_changed` (tickets moved in the board's active run) |
| `board.update_settings` | `board_id`, partial `settings` | — |
| `ticket.set_preparation` | `board_id`, `ticket`, `preparation` | — |
| `ticket.pull_in` | `board_id`, `ticket` | `added` |
| `ticket.set_workflow` | `board_id`, `ticket`, `workflow` (a workflow id, or null for the board default) | — |
| `ticket.investigate` | `board_id`, `tickets` | `execution_ids`. Starts a requirements analyst on each ticket (see *Requirements analyst*) |
| `dep.override` / `dep.restore` | `board_id`, `blocker`, `blocked` | — |
| `profile.save` / `workflow.save` | the whole object | — |
| `run.start` | `board_id`, optional `carry_over_from` | `run_id` |
| `run.pause` / `run.resume` / `run.cancel` | `run_id`, optional `reason` | — |
| `run.delete` | `run_id` | — |
| `ticket.cancel` / `ticket.retry` | `run_id`, `ticket` | `execution_id` and `execution_ids` for retry. Retry applies to a ticket held for `execution_failed`, which it clears by starting the failed work again (a developer, a reviewer or a remediation, whichever failed) at attempt 1, or held at the `round_cap`, where it starts one more remediation round |
| `exec.cancel` | `run_id`, `execution_id` | — (`run_id` may be a board id for an analyst's execution) |
| `question.answer` | `run_id`, `question_id`, `answer`, `share_with_ticket` | `delivered: false`; the answer reaches the agent when its turn has ended. For an analyst's question `run_id` is the **board** id |
| `pr.mark_ready` | `run_id`, `ticket` | — |

Error codes: `invalid_args`, `not_found`, `invalid_state`, `lease_conflict`, `cycle_detected`, `unsupported`, `upstream_error` (Jira or Bitbucket), `internal`.

## State machines

Three state machines, all owned by the controller: run, ticket and execution. Every transition is caused by exactly one accepted event or command and is logged as a `*.state_changed` event with `from`, `to`, `reason` and `caused_by`. Anything not listed is illegal: a command gets `invalid_state`, an agent event gets `agent.event_rejected`.

**Run**

| From | To | Cause |
| --- | --- | --- |
| — | `running` | `run.start` (snapshot taken, leases acquired) |
| `running` | `paused` | `run.pause`: no new dispatch; running agents continue |
| `paused` | `running` | `run.resume` |
| `running` | `completed` | Every ticket is `completed` or `cancelled` |
| `running`, `paused` | `cancelled` | `run.cancel`: all executions killed, open tickets cancelled |

`completed` and `cancelled` are final; leases are released on entering either. A run's id is the id of the `run.start` command that created it (and a board's id that of its `board.create`), so a command re-applied after a crash is a no-op. A run with tickets stuck behind an outside blocker stays `running` until you cancel it or the blocker clears.

**Ticket** (within a run)

| State | Meaning |
| --- | --- |
| `pending` | Preparation isn't `ready` yet |
| `blocked` | Prepared, but a blocker isn't satisfied |
| `ready` | Eligible; waiting for ticket or agent capacity (the UI's "Queued") |
| `in_progress` | Developer execution running |
| `reviewing` | Reviewer executions running or awaiting the gate |
| `remediating` | Developer addressing findings |
| `delivering` | Pushing, PR open, waiting to reach the board's `complete_at` level |
| `needs_input` | Held for you; `resume_state` remembers where it was |
| `completed` | Reached `complete_at` (final) |
| `cancelled` | Stopped by you or a run cancel (final) |

| From | To | Cause |
| --- | --- | --- |
| — | `pending` | `run.start`: the ticket is leased |
| — | `completed` | `run.start` with `carry_over_from`: completed in that run |
| `pending` | `blocked` or `ready` | Preparation set to `ready`; readiness computed |
| `blocked` | `ready` | Every blocker satisfied: in-run blockers at `complete_at`, outside blockers by `completion_policy`, or overridden |
| `ready` | `blocked` | A blocker regresses before dispatch (Jira reopened, override restored) |
| `ready` | `in_progress` | Scheduler dispatches the developer |
| `in_progress` | `reviewing` | Developer `done` accepted; workflow has reviewers |
| `in_progress` | `delivering` | Developer `done` accepted; workflow has no reviewers |
| `reviewing` | `remediating` | All required reviewers ended, at least one `request_changes`, and `round` < max |
| `reviewing` | `delivering` | All required reviewers approved |
| `remediating` | `reviewing` | Remediation `done` accepted; `round` + 1; only reviewers that requested changes re-run |
| `delivering` | `completed` | PR reaches `complete_at` (immediately for `implemented` and `pr_created`) |
| `in_progress`, `reviewing`, `remediating`, `delivering` | `needs_input` | Something is added to `attention` (below) |
| `needs_input` | `resume_state` | `attention` becomes empty |
| any non-final | `cancelled` | `ticket.cancel` or `run.cancel` |

What goes into `attention`:

- `question`: an execution's `ask` was accepted. Cleared when the answer is delivered.
- `round_cap`: `request_changes` at the last allowed round. Cleared by `ticket.retry`, which grants one more round.
- `execution_failed`: an execution failed with no attempts left. Cleared by `ticket.retry`, which starts a new execution at attempt 1.
- `delivery_error`: Bitbucket or Git failed after three backed-off retries. Cleared by `ticket.retry`.

Once a ticket leaves `ready`, blocker regressions are logged as warnings but don't move it back: the work is already done against the code it saw.

**Execution**

| From | To | Cause |
| --- | --- | --- |
| — | `created` | Controller decides to dispatch; worktree and `task.md` written |
| `created` | `starting` | `hc run` issued |
| `starting` | `working` | Terminal appears in `hc ls` with the execution's label |
| `working` | `needs_input` | `ask` accepted |
| `needs_input` | `working` | Answer delivered with `hc send` |
| `working`, `needs_input` | `completed` | `done` accepted (an open question is closed as withdrawn) |
| `working`, `needs_input` | `failed` | `fail` accepted, nudges exhausted, timeout, terminal exited or vanished without a report |
| `created`, `starting` | `failed` | `hc run` errors or the terminal never appears within 60 seconds |
| any non-final | `cancelled` | `exec.cancel`, `ticket.cancel` or `run.cancel`; terminal killed |

- A `done` that fails controller verification (no commits, or a reviewer verdict that contradicts its findings) is rejected; the execution stays `working`, and the controller tells the agent why with `hc send`.
- On `failed` with attempts left and a retryable cause, the controller immediately creates a new execution with `attempt` + 1 in the same worktree. Otherwise the ticket gets `execution_failed` in `attention`.
- `fail` with `retryable: false` never retries automatically.

## Phase 4 rules the controller applies

- **A ticket that passes its gate** (or has no reviewers) goes `delivering → completed` at once. Delivery (push, PR, Jira) is Phase 6.
- **Branch and base.** The branch is the lower-cased key plus a slug of the summary (`pay-102-payment-api`), in `~/.herdr/worktrees/<repo>/<branch>`. A ticket whose blockers completed in the same run is based on the first one's branch, and merges the others in; otherwise on the board's default branch (a local branch; nothing is fetched).
- **Done verification.** Besides the listed commits, the controller checks they are on the ticket branch, that the branch has commits beyond `base`, and that the worktree is clean. A rejected `done` is explained to the agent with `hc send` at its next turn end.
- **Terminals.** Cancelled executions are killed at once; a timed-out or never-started one is killed; a finished ticket's executions are killed when it completes. Each kill is logged as `execution.killed` while the run is live, and in `controller.log` after it has ended.
- **Dispatch limits** are the board's `max_tickets` (tickets in flight) and `max_agents` (live agents), per run.

## Phase 5 rules the controller applies

**Reviews.** When a developer's `done` is accepted and the workflow has reviewers, the ticket goes to `reviewing` and every reviewer of the round starts in parallel, in the developer's worktree (read-only by their profile), as `review` executions with the round number.
- **The gate waits for every reviewer of the round**, required and optional. Only required reviewers' verdicts decide it. (DECISION: waiting for optional ones keeps their findings complete for the remediation.)
- A required reviewer that ends without a verdict and can't retry holds the ticket (`execution_failed`); an optional one is skipped.
- `max_agents` limits reviewers too: a reviewer waits until there is a free agent slot. A retry replaces an agent that died, so it needs none.

**Remediation and rounds.**
- Any required `request_changes` starts a remediation while fewer than `max_remediation_rounds` remediations have completed. (DECISION: "capped per workflow" counts remediation rounds, so the default of 2 allows two.) At the cap the ticket gets `round_cap`; `ticket.retry` starts one more remediation.
- A remediation is a developer execution of kind `remediate` whose `round` is the review round it answers. When it completes the ticket goes back to `reviewing`, and the review round is one more than the highest completed remediation round.
- Only the reviewers that asked for changes in the previous round run again (DECISION: an optional reviewer that asked for changes is checked again too).
- Findings are **addressed** when a remediation that saw them completes: `addressed_in_round` is set by the reducer, with no event of its own. `collie show findings` lists a ticket's open (unaddressed) findings.
- A remediation's brief lists the ticket's open findings, blocking first, with a pointer to `collie show findings`. A reviewer in round 2 or later gets the last round's findings in its brief, to check they were addressed.

**Questions.** `question.answer` records the answer. As soon as the agent's turn has ended (`idle` or `done`), the controller types `[collie] Answer to your question <last six characters of the id>: <answer on one line> Continue the task.` with `hc send` (without `HC_TERMINAL_ID`), then logs `question.delivered`, returns the execution to `working`, and returns the ticket to its `resume_state` when its attention list is empty. (DECISION: newlines in an answer become spaces, because a newline would submit the message early.) An answer that has been recorded but not delivered survives a controller restart: delivery is decided from the state each tick. Answers shared with the ticket (`share_with_ticket`) go into later briefs, from the preparation as well as from earlier rounds.

**Workflows.** `ticket.set_workflow` sets the workflow a ticket uses from the next run on (the board's `settings.workflow` is the default). The controller saves the profiles `developer`, `security-reviewer`, `backend-reviewer`, `frontend-reviewer` and `requirements-analyst` and the workflows `standard-feature` (security and backend required, frontend optional, two remediation rounds) and `small-bug-fix` (no reviewers) on start, only when they don't exist.

**Requirements analyst.** `ticket.investigate` starts an analyst per ticket under `boards/<board-id>/prep/`, as its own log laid out like a run's. It is not a run: no leases, no `run.json`. Its controller events carry the board id as `run_id`; the analyst's own events carry `run_id: null`, and `COLLIE_RUN_ID` is empty. The analyst's terminal is labelled `collie.board=<board-id>` instead of `collie.run`.
- The analyst works in a detached, read-only worktree of the board's default branch, `~/.herdr/worktrees/<repo>/prep-<ticket>`, with the profile `requirements-analyst`.
- The ticket's `preparation` follows it: `investigating` while it works, `needs_input` while a question of it is open, `ready` when its `done` is accepted, `unreviewed` when it ends without one (after its attempts). A person who sets another preparation meanwhile (for example `excluded`) is left alone.
- Its questions are answered with `question.answer`, giving the board id as `run_id`; answers shared with the ticket go into the developer's brief. Its `finding`s (design suggestions) stay in the preparation log for the Board setup screen.

## Retention

Run records are kept indefinitely; the heavy or duplicated things are cleaned up on fixed rules.

| What | Kept | Removed when |
| --- | --- | --- |
| `run.json`, `events.jsonl`, `state.json`, `execution.json`, `task.md` | Indefinitely | Only by `run.delete` |
| `inbox.jsonl` and `attachments/` | 90 days after the run ends | Pruned; their content is already in `events.jsonl`, apart from long bodies |
| Worktrees | While the ticket's PR is open, or its ticket is active | PR merged or declined, or 7 days after the ticket is cancelled |
| Herdr terminals of ended executions | Until the ticket completes or is cancelled | Closed with `hc kill` |

- **Never lose work.** A worktree with commits not on its remote branch, or with uncommitted changes, is never removed. The controller logs `worktree.kept` with the reason and checks again on the next pass.
- **When it runs.** A prune pass runs on controller start and then daily. Each removal is logged as `retention.pruned` (files) or `worktree.removed` in the run's `events.jsonl`; after a run's own directory is gone, nothing more is logged for it.
- **Deleting a run.** `run.delete` (args: `run_id`) removes a run's whole directory. It's refused with `invalid_state` while the run is running or paused, or while any of its PRs is still tracked as open.
- **Activity view.** Pruned attachments show as "removed after 90 days" rather than as broken links.

## Agent templates

Every agent gets three pieces of text from the controller: a one-line first message, its profile instructions with the standard reporting block appended, and a `task.md` brief it reads through `collie show task`. The templates live in `packages/controller/templates/`, are versioned with the code, and are rendered once when an execution is created; later information reaches the agent through `hc send` and the `collie show` commands, never by editing `task.md`.

**First message**, passed by the harness adapter when the terminal starts:

```
Your Collie brief is ready. Run `collie show task` and follow it.
```

**Reporting block**, appended after every profile's own instructions:

````markdown
## Working inside Collie

You are one agent in an automated delivery pipeline. Collie, not you,
decides what happens next, pushes branches, opens pull requests and
updates Jira. You talk to it only through the `collie` command.

1. Start with `collie show task`. When the brief says there are
   findings or answers, read them with `collie show findings` and
   `collie show answers`.
2. Report progress at milestones with `collie status "<what you're doing>"`.
   Keep it short: it is shown in a UI.
3. If you cannot proceed without a decision from a person, run
   `collie ask "<one specific question>"`, adding `--option "..."` for
   each sensible choice, then end your turn. The answer arrives as your
   next message. Ask about requirements; decide ordinary implementation
   details yourself.
4. Finish with exactly one of:
   - `collie done --summary "..."`. Developers commit first. Reviewers
     add `--verdict approve` or `--verdict request_changes`.
   - `collie fail --reason "..." --category <category>`, adding
     `--retryable` if another attempt could succeed.
5. If a `collie` command fails, read its message, fix the call and run
   it again. Never work around it.
6. Run long commands (builds, test suites) in the foreground and wait
   for them. Don't background them with `&`: Collie reads a finished
   turn as you having stopped.
7. Stay inside your worktree. Never push, open pull requests, change
   Jira, or start other agents.

Run `collie --help` for every option.
````

**Task brief** — `task.md`. Sections in `{{…}}` are filled by the controller; a section with nothing to show is left out rather than shown empty.

````markdown
# {{ticket}} · {{summary}}

You are the {{profile_name}} on {{ticket}}.
Kind: {{kind}} · round {{round}} · attempt {{attempt}}

## Ticket
{{description}}

### Acceptance criteria
{{acceptance_criteria}}

### Clarifications
{{answers shared with this ticket, from preparation and earlier rounds}}

### Recent Jira comments
{{newest 10 comments, author and date}}

## Context
- Repository: {{workspace}}/{{repo}}
- Working directory: {{worktree}}
- Branch: {{branch}}, based on {{base}}
- {{if stacked}}{{base}} contains unmerged work from {{blocker}}: {{blocker_summary}}{{end}}
- Blocked by: {{blockers with summary and state}}
- Blocks: {{dependents with summary}}

## Your task
{{kind instructions, below}}

## Findings to address
{{open findings for this ticket: severity, title, location,
  suggestion; blocking ones first}}

## Limits
{{permissions in words, e.g. "read-only: do not modify files"}}
Time limit: {{timeout_min}} minutes.
````

**Kind instructions** inserted under *Your task*:

| Kind | Instructions |
| --- | --- |
| `develop` | Implement the ticket on this branch so every acceptance criterion is met. Add or update tests and run the relevant ones. Commit with messages starting `{{ticket}}: `. |
| `review` | Review this branch's changes against `{{base}}` (`git diff {{base}}...HEAD`) for your area. Don't modify files. Report each issue with `collie finding`, marking it `--blocking` only if it must be fixed before merge. On round 2 and later: check that the listed findings were addressed, and review only code changed since the last round. |
| `remediate` | Address the findings below. Fix every blocking finding. Fix non-blocking ones where it's cheap; otherwise say why in your done summary. Commit as before. |
| `analyse` | Decide whether this ticket is ready to implement. Read the code it would touch, check that the acceptance criteria are testable, and look for missing dependencies. Don't modify files. Ask about each real ambiguity with `collie ask`. Record suggestions, such as a split or a missing blocker, with `collie finding --category design`. Finish with a summary of scope and risks. |

An analyst's accepted `done` sets the ticket's preparation to `ready`; its design findings appear as issues in Board setup.

## Open questions

- [x] Does `hc send` submit the message in Claude Code, and how does it treat text arriving mid-turn? Yes; mid-turn text is queued into the current turn. See `docs/spike.md` 1 and *Talking to an agent*.
- [x] Is Herdr's agent status reliable enough to detect idle in Claude Code? Yes, about 20 ms after the turn ends, with background tasks disabled; no `hc read` polling. See `docs/spike.md` 2.
- [x] Non-blocking `collie ask --assume`: deferred until after the MVP. Agents ask and wait.
- [x] Remediation trigger: resolved under Configuration files, Workflow.
- [x] Who starts the controller: the mod, when no live lock exists (implementation plan).
- [x] How long ended runs are kept: resolved under Retention.
