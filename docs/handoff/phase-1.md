# Phase 1 hand-off: `collie` CLI and inbox

Branch `phase-1`, based on `main` at `aa53279` (Phase 0).

## What was built

`packages/cli`: the `collie` command agents use to report. One module per job:

| Module | Job |
| --- | --- |
| `src/main.ts` | Dispatch, exit codes, `--json`, help |
| `src/args.ts` | Option parser: options anywhere, `--x=v` or `--x v`, errors that name the option and list the valid ones |
| `src/env.ts` | Reads and checks `COLLIE_HOME`, `COLLIE_INBOX`, `COLLIE_RUN_ID`, `COLLIE_EXECUTION_ID`, `COLLIE_TICKET` and `COLLIE_ROLE`; reads `execution.json` next to the inbox |
| `src/inbox.ts` | Appends one line: `flock`, an "already ended" check under the lock, one `write()`, retries with the same id |
| `src/flock.ts` | Exclusive `flock(2)` through Bun's FFI (libSystem on macOS, libc on Linux) |
| `src/report.ts` | `status`, `finding`, `artifact`, `ask`, `done`, `fail`: build the event, validate it with `packages/schema`, run local checks, append. Schema errors are mapped back to options (`payload.severity` → `--severity`). |
| `src/git.ts` | A developer's `done`: clean worktree, commits ahead of base |
| `src/show.ts` | `show task` (task.md), `show findings` (open findings from `state.json`, with body and suggestion looked up in `events.jsonl`), `show answers` |
| `src/help.ts` | `collie --help` (19 lines, 77 columns) and per-command help |

`make build` compiles `dist/collie` (about 89 MB; it bundles the Bun runtime).
`packages/cli/bin/collie` runs the source, for tests and development.

Other changes:

- **Schema:** `newUlid()` and `eventTs()` in `packages/schema/src/ulid.ts`.
  `execution.json` and `execution.created` gain an optional `base` field: additive, so no
  version bump.
- **Fixtures:**
  - `fixtures/home/` (generated): a `COLLIE_HOME` in mid-remediation, with open and
    addressed findings, one body stored as an attachment, and answered, shared, unshared and
    open questions.
  - `fixtures/scenarios/` (hand-written): developer and reviewer fake-agent scenarios, each
    with the inbox it must produce.
- **Protocol:** `base` added to `execution.json`, the checks the CLI makes before writing
  spelled out, and exit code 5 explained.

## Done when

| Item | Test (`packages/cli/test/cli.test.ts`) |
| --- | --- |
| 20 parallel `collie finding` calls produce exactly 20 intact lines | "20 parallel collie finding calls…" runs the compiled binary with 20 KB bodies. A second test, "waits for the inbox lock…", proves the CLI takes the lock: it holds `flock` itself, and checks that `collie` doesn't write until it is released, then sees the execution has ended (exit 4). I checked that this test fails with locking disabled. The 20-line test alone wouldn't catch that: single appending writes are atomic on macOS. |
| Each invalid fixture's equivalent call exits 2 with a fix-it message | "each invalid inbox fixture's equivalent call…": one call per fixture, checking exit 2 and the message, and that nothing was written. Fixtures the CLI can't express (it writes `v`, `id`, `ts`, `source` and `retryable` itself), or that come from the environment (exit 3), are listed with the reason. A test fails if a new invalid fixture is in neither list. |
| `done` in a dirty worktree exits 2; any write after `done` or `fail` exits 4; a missing environment exits 3 | "developer done", "after done or fail, every write exits 4" (every write command, after each ender), "environment" (each variable missing or malformed) |
| The `show` commands print from fixture files | "show prints from fixture files": exact text for `task`, `findings` and `answers` against `fixtures/home/` |
| A fake-agent scenario writes an inbox identical to its expected fixture, apart from ids and timestamps | "fake-agent scenario: developer / reviewer". These runs also check refused calls along the way: a dirty `done`, a bad `--kind`, a reviewer approving with a blocking finding, and writes after the end. |

`make check`: lint, typecheck and 291 tests, all green.

## Deviations from the docs, and why

1. **`execution.json` has a new optional `base` field.** A developer's `done` must
   refuse "no commits ahead of the base branch". But nothing an agent can read named the
   base: the env has no `COLLIE_BASE`, and `state.json` is a cache the CLI shouldn't depend
   on. `execution.json` is written at creation, next to the inbox. The field is additive, so
   `v` doesn't bump. The schema, fixtures and protocol are all updated.
2. **The CLI writes `attachments/<event-id>.md`.** CLAUDE.md says the CLI only appends to
   the inbox. The protocol has the CLI move long bodies to `attachments/`, so the CLI is
   the writer of those files too. Nothing else writes there.
3. **The CLI reads `state.json` and `events.jsonl`** for `show findings` and
   `show answers` (read-only). "Not in this phase: anything that reads the inbox" means the
   controller's inbox reader. The CLI does read its own inbox, under the lock, for the
   "already ended" and blocking-findings checks.

## Every `DECISION:`

| Where | Decision |
| --- | --- |
| `env.ts` | `COLLIE_RUN_ID` may be set but empty for analyst executions, which have no run. Any other role with an empty run id exits 3. |
| `inbox.ts` | "Retry with the same id" happens inside one call: up to 3 attempts reuse the event id, and each retry first checks whether the earlier line landed. Exit 5 comes only after all three fail. |
| `inbox.ts` | A torn final line (no `\n`) can only come from a writer that died mid-write. The next write puts a newline first, so the torn line becomes one invalid line instead of corrupting the new one. |
| `report.ts` | `finding` is for reviewers and analysts (analysts record design suggestions); `artifact` is for developers. Others get exit 2. |
| `report.ts` | `finding` always writes `blocking` explicitly: true for critical and high unless `--not-blocking`; false otherwise unless `--blocking`. |
| `report.ts` | Only reviewers give `--verdict`; one from a developer or analyst exits 2. |
| `report.ts` | A developer's `done` reads `base` from `execution.json`. With no `--commit`, it records every commit ahead of base. With no `base`, the commits-ahead check is left to the controller. |
| `report.ts` | Besides the plan's "request_changes needs a blocking finding", the CLI also refuses `approve` with blocking findings recorded: the protocol's other half of the verdict rule. |
| `git.ts` | A base branch missing from the worktree exits 3 (environment), since the agent can't fix it. |
| `show.ts` | `show answers` lists this execution's answers plus every answer shared with its ticket. |

## Known gaps

- **`collie ctl`** is Phase 2. Today it exits 2 with "not available yet (Phase 2)".
- **Untracked files count as dirty** for a developer's `done`, gitignored ones excepted.
  If a toolchain leaves untracked build output that isn't ignored, the agent has to delete
  it or ignore it. That matches "clean worktree", but it may surprise; watch for it at the
  Phase 4 gate.
- **The binary is about 89 MB**, because it embeds Bun. `bun build --compile --minify`
  barely changes that. It is fine locally; worth revisiting if Collie ships binaries.
- **The compiled binary loads libc through FFI at runtime.** That works on macOS and glibc
  Linux; on musl (Alpine) `libc.so.6` doesn't exist. CI uses the Debian-based `oven/bun`
  image.

## New dependencies

None.

## Demo

```sh
make build                                   # dist/collie
make check                                   # 291 tests

# A scratch execution (from the test helper) and a short session
cd $(mktemp -d) && git init -q -b main && git commit -q --allow-empty -m init && git checkout -q -b pay-1
R=01JC8YQ0P4E2W7H5S8D3F6G9KB X=01JC8Z1A9C4V6B2N8M5X7Z3QWE H=$PWD/.collie
mkdir -p $H/runs/$R/executions/$X && echo "# PAY-1 brief" > $H/runs/$R/executions/$X/task.md
printf '{"v":1,"id":"%s","run_id":"%s","ticket":"PAY-1","profile":"developer","role":"developer","kind":"develop","round":1,"attempt":1,"worktree":"%s","branch":"pay-1","base":"main","terminal":null,"created_at":"2026-11-09T10:00:00Z"}' $X $R $PWD > $H/runs/$R/executions/$X/execution.json
echo .collie > .gitignore && git add .gitignore && git commit -q -m "PAY-1: ignore"
export COLLIE_HOME=$H COLLIE_INBOX=$H/runs/$R/executions/$X/inbox.jsonl COLLIE_RUN_ID=$R COLLIE_EXECUTION_ID=$X COLLIE_TICKET=PAY-1 COLLIE_ROLE=developer
C=~/projects/herdr-collie/dist/collie
$C show task
$C status "Starting" --phase investigating
touch wip.go; $C done --summary "x"; echo "exit $?"      # 2: uncommitted changes
git add -A && git commit -q -m "PAY-1: work"
$C done --summary "Implemented PAY-1" --json             # commits filled in
$C status "more"; echo "exit $?"                         # 4: already ended
cat $COLLIE_INBOX
```
