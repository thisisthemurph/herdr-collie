# Phase 0 hand-off: repo, contracts and fixtures

Branch `phase-0`, based on `main` at `29c1c6c` (the spike and the accepted changes C1–C11).

## What was built

| Part | Where | Notes |
| --- | --- | --- |
| Repo layout and tooling | `package.json`, `tsconfig.json`, `biome.json`, `Makefile` | Bun workspaces for `packages/*`, `tools/*` and `fixtures`. `packages/cli`, `packages/controller` and `mod/` are placeholders with a README. |
| Contracts | `packages/schema` | Types plus runtime validators for the envelope, the 6 agent events, all 32 controller events, the 21 `ctl` commands and their replies, profiles, workflows, boards, `run.json`, `execution.json` and `state.json`. Inbox line parsing (newline rule, 64 KB cap). `SCHEMA_VERSION = 1`. |
| Fixtures | `fixtures/` | 161 generated files: valid and invalid inbox lines for every agent event type, one valid line per controller event type, valid and invalid config, runtime and control files, and one complete two-ticket run (`runs/complete/`). Plus `fixtures/hc/`: recorded real `hc` output. |
| Fake `hc` | `tools/fake-hc` | `run`, `send`, `wait`, `get`, `ls`, `label`, `kill`, `rm`. Plays back a scripted status sequence per terminal, logs every call to `calls.jsonl`, copies real hc's output shapes, error kinds and exit codes, and can really spawn a program (`"spawn": true`) and deliver `hc send` text to it. |
| Fake agent | `tools/fake-agent` | Runs `collie` and shell commands from a scenario, checks exit codes and output, and waits for messages delivered through fake-hc. |
| ADRs | `docs/adr/0001`–`0008` | One per decision in the plan's table, with the spike's findings folded in. |
| CI | `bitbucket-pipelines.yml` | `make check` on every push and pull request (see *Known gaps*). |

**Validators.** Each `validateX` returns `{ ok: true, value }` or `{ ok: false, issues }`.
It reports every problem at once, each naming its field, for example
`payload.commits[0]: must be a git commit sha (7-40 lowercase hex characters), got "HEAD"`.
Unknown fields are ignored, and an unknown major `v` is rejected
(`v: unsupported schema version 2; this reader understands 1`).

**The complete run** (`fixtures/runs/complete/events.jsonl`, 95 events) covers:
- leases, a person's answer to a reviewer's question, a blocking finding, one remediation round and a nudge;
- a `done` rejected by controller verification, an hc permission block, and pause and resume commands;
- a stacked draft PR, a conflict check, and Jira write-back, both applied and skipped;
- run completion.

A test checks that ids are unique and in order, every `caused_by` resolves, and both tickets reach `completed`.

## Done when

| Item | Status | Test |
| --- | --- | --- |
| Every valid fixture passes validation, and every invalid one fails with a message naming the field | ✅ | `packages/schema/test/fixtures.test.ts`. Each `invalid/expected.json` names the field, and the test checks both the issue path and the `<field>: ` prefix of the message. |
| The fake `hc` logs its calls and plays back a scripted agent status sequence | ✅ | `tools/fake-hc/test/fake-hc.test.ts`: "plays back a scripted agent status sequence" and "logs every call with argv, caller, exit code and output" |
| `make check` is green in CI | ⚠️ Local only | `make check` passes locally: 212 tests, lint, typecheck. There is no remote repository yet, so Pipelines hasn't run. |

## Deviations from the docs, and why

1. **`docs/protocol.md` updated** (additive):
   - the exact payload keys the event table left open: `event_type`, `nudge`, `result`, `message`, `code`;
   - a Retention row in the controller events table;
   - `run_id` may be null for analyst executions;
   - `ts` carries milliseconds;
   - a pointer to `packages/schema` and `fixtures/` as the exact shapes;
   - recovery step 3 changed (item 2 below).
2. **`hc ls --json` entries have no labels** (finding from live hc). The protocol said recovery matches terminals "by the `collie.execution` label" from `hc ls`. That still works, but only via `hc ls --json --label collie.run=<id>` followed by `hc get` on each terminal. Recovery step 3 now says so.
3. **The envelope's `run_id` "always set" conflicts with analyst executions**, which the protocol gives `run_id: null`. The schema allows null on agent events only; controller events always need a `run_id`.
4. **fake-hc was built from live hc as well as `docs/herdr/`.** CLAUDE.md names `docs/herdr/` as the only source of truth. But `hc-skill.md` doesn't list flags, JSON shapes or most exit codes, so I recorded them from real hc 0.1.17 (`fixtures/hc/`) using throwaway `sleep` terminals. Nothing in the recordings contradicts `docs/herdr/`; they fill gaps. **Suggestion:** add `hc <cmd> --help` output to the snapshot at the next re-sync.
5. **fake-hc supports `get` and `rm`** on top of the plan's list. The protocol needs `get` for `turn` and labels, and `rm` for cleanup.

## Every `DECISION:`

| Where | Decision |
| --- | --- |
| `packages/schema/src/validate.ts` | Hand-written validators instead of zod, so the schema has no runtime dependencies and the mod can bundle it as plain JS. |
| `packages/schema/src/common.ts` | Event `ts` must have milliseconds. Config and state timestamps may leave them out, as the protocol's examples do. |
| `packages/schema/src/common.ts` | Question states are `open`, `answered`, `delivered` and `withdrawn`. |
| `packages/schema/src/events.ts` | A finding has exactly one of `body` and `body_ref`. |
| `packages/schema/src/events.ts` | A finding with `line` or `end_line` must have `file`. |
| `packages/schema/src/events.ts` | `run_id` is null only for analyst (board preparation) executions; agent events always carry `execution_id` and `ticket`. |
| `packages/schema/src/events.ts` | `ticket.state_changed` (and `execution.state_changed`) have `from: null` for the first state. |
| `packages/schema/src/events.ts` | `ticket.*`, `execution.*`, `question.*`, `pr.*` and `jira.*` must set `ticket`; `execution.*` and `agent.*` must set `execution_id`; `agent.event_*` and `command.*` must set `caused_by`. |
| `packages/schema/src/events.ts` | Controller events have `source` `controller` or `human` (a person's command); never `agent`. |
| `packages/schema/src/events.ts` | `jira.updated` is `{transition?, comment?}`: the target status moved to, and whether a comment was added. |
| `packages/schema/src/commands.ts` | `board.create` takes the Jira site and project, with `cloud_id` optional (the controller looks it up), and partial settings. |
| `tools/fake-hc/src/hc.ts` | Only `hc run --bg` is supported. |

## Known gaps

- **CI hasn't run.** There is no remote yet. `bitbucket-pipelines.yml` runs `make check`
  in `oven/bun:1.4.4`; enable Pipelines once the repository exists.
- **No state machine tables or reducer.** The schema has the state enums; the legal
  transitions are still only in the protocol. Phase 2 owns the reducer.
- **No events for `attention` changes.** `state.json`'s `attention` has `round_cap`,
  `execution_failed` and `delivery_error` entries, but no event adds or clears them (only
  questions have events). Phase 2 will need either `ticket.attention_added` /
  `ticket.attention_cleared` or attention fields on `ticket.state_changed`. That is an
  additive contract change.
- **`docs/wireframes/`** is referenced by CLAUDE.md and the plan but doesn't exist yet.
  Nothing in Phase 0 needed it; Phase 3 will.
- **No `state.json` for the end of the complete run.** Building one by hand would mean
  writing the reducer. Phase 2's rebuild test should produce it from
  `runs/complete/events.jsonl`.
- **`make build`** prints a notice. There's nothing to build until Phase 1.

## Suggestions (out of scope)

- Put the ticket and execution state transition tables in `packages/schema` as data, so
  the controller (Phase 2) and the mod share one copy.
- At the next Herdr re-sync, re-record `fixtures/hc/` and add `hc --help` output for each
  command to `docs/herdr/`.

## Package registry

`bunfig.toml` pins installs to public npm (`registry.npmjs.org`). This overrides a global
`~/.npmrc` that points at a private registry, so `bun.lock` holds no private URLs and CI
needs no registry credentials.

## New dependencies

Dev only: `typescript` 5.9.3 (typecheck), `@biomejs/biome` 2.6.6 (lint and format),
`@types/bun` 1.4.4 (Bun's types). None at runtime.

## Demo

```sh
brew install oven-sh/bun/bun          # Bun 1.4.4
bun install
make check                            # lint, typecheck, 212 tests

# Contracts: see an error that names the field
bun -e 'import {validateAgentEvent, formatIssues} from "./packages/schema/src/index.ts";
  const r = validateAgentEvent(JSON.parse(require("fs").readFileSync("fixtures/inbox/invalid/done-bad-commit-sha.jsonl","utf8")));
  console.log(r.ok || formatIssues(r.issues))'

# Fixtures are generated; this fails if they drift from fixtures/src/build.ts
make fixtures-check

# fake-hc: a scripted agent
export FAKE_HC_DIR=$(mktemp -d) PATH="$PWD/tools/fake-hc/bin:$PATH"
unset HC_TERMINAL_ID
cat > $FAKE_HC_DIR/scenario.json <<'EOF'
{"v":1,"agents":[{"steps":[{"on":"run","state":"idle"},{"on":"get","state":"working","turn":1},
 {"on":"wait","state":"blocked","kind":"permission","msg":"approve Bash"},{"on":"wait","state":"done"}]}]}
EOF
hc run --bg --json --no-parent --name dev --label collie.ticket=PAY-1 -- claude "hi"
hc get dev --json | jq -c '{status, turn}'   # working, turn 1
hc wait dev --json                           # blocked
hc send dev "hello"; echo "exit $?"          # refused: exit 9
hc wait dev --json                           # done
cat $FAKE_HC_DIR/calls.jsonl
```
