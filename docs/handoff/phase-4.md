# Phase 4 hand-off: agent execution

Branch `phase-4`, based on `main` at `de5b8a0` (Phase 3).

## What was built

**`packages/board`** (pure): `src/schedule.ts`: the dispatch order (critical path, then most downstream work unblocked, then longest waiting, then key) and the ticket and agent limits.

**`packages/controller`:**

| Module | Job |
| --- | --- |
| `src/hc.ts` | The `hc` wrapper: `run` (with the `env` argv wrapper, `--no-parent --no-notify`, labels), `get`, `wait`, `send` (without `HC_TERMINAL_ID`; never `--if` or `--force`; exits 9, 10, 11 become outcomes), `kill`, `ls`, `read`. The program runner is injected. |
| `src/git.ts` | Worktrees under `~/.herdr/worktrees/<repo>/<branch>` (idempotent), stacking on a finished blocker's branch, and the controller's checks on a developer's `done` |
| `src/adapters/` | The `claude-code` adapter: absolute `claude` path, first message before every option, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` |
| `src/templates.ts`, `templates/` | First message, reporting block, `task.md` and the kind instructions, embedded in the compiled binary |
| `src/adf.ts`, `jira.ts` | Jira's rich text as text; `JiraClient.brief()` (description, acceptance criteria, newest 10 comments) |
| `src/agents.ts` | Dispatch, launch, watching, nudges, timeouts, retries, ticket completion, killing terminals, restart reconciliation |
| `controller.ts`, `commands.ts` | Wiring; `ticket.retry`; cancel commands now kill terminals |

**Lifecycle** (all of it level-triggered: each tick looks at the run's state and does what is missing, so a crash loses nothing):
- **Launch:** `execution.json`, then the `created` events, then the worktree, `task.md` and `hc run`, then `started` and `starting`.
- **Working:** `starting → working` when `hc get` shows `turn >= 1` or `working`.
- **Idle without a report:** after 30 s, nudge; after 2 nudges and another 30 s, fail as `tooling`, retryable.
- **Other ends:** exit without a report, 60 s idle at turn 0, and the profile's time limit all fail it as retryable. A `done` written just before an exit is judged first.
- **Retry:** a retryable failure with attempts left starts attempt + 1 in the same worktree. Otherwise the ticket goes to `needs_input` with `execution_failed`, and `ticket.retry` starts a fresh developer.
- **Blocked:** hc's `blocked` is logged with its kind and cleared when it passes.

**Mod:** Start run (enabled), Pause, Resume and Cancel run; the graph colours and chips by the ticket's run state; a delivery bar under the graph with an empty pull request panel; the inspector's run section (state, why it waits, each agent with its attempt, nudges, outcome, "Watch terminal", Stop agent, Retry, Cancel ticket); an "In run" column in the ticket table.

## Done when

| Item | Test |
| --- | --- |
| With fake `hc`: a three-ticket run with one dependency completes, and the blocked ticket starts only after its blocker is done | `agents.test.ts`, "the blocked ticket starts only after its blocker is done, stacked on its branch": PAY-102's `execution.started` comes after PAY-101's completion in the log, and its worktree holds PAY-101's commit. `agents-e2e.test.ts` runs two real fake-agent processes that call the real `collie` CLI. |
| With real Herdr and Claude Code: one ticket in a scratch repo reaches developer done with a commit on its branch | **Demo, run by me** (below): the real `TST-1` ticket, a scratch repo, Claude Code (`sonnet`). Commit `TST-1: add SMOKE.md` on `tst-1-collie-test`; the run completed and the terminal was killed. |
| An agent that goes idle without reporting is nudged twice, then failed as retryable | `agents.test.ts`: two nudges with the protocol's text, typed bare; then `execution.failed` (`tooling`, retryable) and attempt 2 |
| Restarting the controller mid-run reattaches without a duplicate; the agent's terminal survives the controller's terminal being killed | `agents.test.ts` "reattaches…" (one `hc run` in total). **In real Herdr:** I killed the controller's terminal while Claude was working; the agent's terminal stayed `live`/`working`, the new controller recovered the run, started nothing, and the run completed with one execution. |
| Reloading the mod mid-run loses nothing | The mod keeps no state; `model.test.ts` checks the same `state.json` gives the same model. I opened a fresh copy of the mod on a finished run in Herdr. I did **not** reload it mid-run by hand. |

`make check`: lint, typecheck and 506 tests, all green.

## Finding from real Claude Code

**A new worktree makes Claude Code ask "trust this folder?", and hc reports the agent `idle`, not `blocked`.** The first real run sat at turn 0 and was failed by the 60-second rule, twice. The spike had warned of a dialog but expected `blocked`. Now:
- after 10 s at turn 0 the controller reads the screen, and a trust dialog is logged as `execution.agent_blocked` (`permission`, with a message) and doesn't start the 60-second timeout;
- **Collie does not answer it**; accepting a trust prompt is your decision. In my demo I answered it by hand (`hc keys <t> down enter`) on the scratch worktree.

Every ticket's first run in a new worktree will need that click until you decide how to handle it (see *Decisions for you*).

## Deviations from the docs, and why

1. **`docs/protocol.md` updated** (additive): the trust dialog, terminal names, `ticket.retry`, and a "Phase 4 rules" section (branch and base, `done` verification, killing terminals, limits).
2. **`fake-hc` gained `hc read`** (prints a scenario's `screen`), needed to test the dialog. Real `hc read --lines 0` is in `docs/herdr/hc-skill.md`.
3. **`COLLIE_NO_AGENTS=1` and `COLLIE_HC`** control the controller binary: the first runs no agents (the Phase 2 process tests seed executions by hand and must not reach a real Herdr), the second names the `hc` program.
4. **The Jira brief isn't recorded from real traffic.** `brief()` is tested against hand-written responses in the documented shape. In the real run it fetched the live `TST-1` successfully, but I didn't add a recording.

## Every `DECISION:`

| Where | Decision |
| --- | --- |
| `agents.ts` | The workflow is developer-only; reviewers are ignored and a finished developer completes the ticket (delivery is Phase 6) |
| `agents.ts` | Edges for scheduling come from the run's snapshot, not the live board |
| `agents.ts` | A ticket stacks on the first finished blocker's branch and merges the others in; a merge conflict fails the execution as `environment`, not retryable |
| `agents.ts` | Collie doesn't answer a trust dialog; it shows it as waiting for permission |
| `agents.ts` | Messages owed to an agent (a rejected `done`) live in memory; after a restart the ordinary nudge covers it |
| `agents.ts` | A run's terminals are killed after it ends; the kill is in `controller.log`, as the run's log is read-only by then |
| `agents.ts` | Terminal name: `<ticket>-<last six of the execution id>` |
| `git.ts` | Branch is the key plus a 32-character slug of the summary; the base is a local branch (nothing is fetched) |
| `claude-code.ts` | `claude` comes from the controller's PATH or `$COLLIE_CLAUDE` |
| `jira.ts`/`adf.ts` | Acceptance criteria are the section under a heading called "Acceptance criteria"; the rest is the description |

## Known gaps

- **Trust dialog** (above), until you choose.
- **No default profile or workflow ships.** `profile.save` and `workflow.save` are the way in (the editor is Phase 7). A working developer profile for real Claude Code needs `args` such as `--permission-mode acceptEdits --allowedTools "Bash(collie:*)" "Bash(git add:*)" "Bash(git commit:*)"`, or the agent stops at permission prompts. Phase 7's default profiles should settle this.
- **`collie` must be on the agent's PATH** (`make install` puts it in `~/.local/bin`).
- **`needs_input` executions wait forever** (no timeout while a person is meant to answer); answers are delivered in Phase 5.
- **`hc` unreachable** (Herdr closed): the controller logs it once and keeps trying; it doesn't fail executions on a guess.
- **Completed tickets' terminals are killed at once**, since a ticket completes as soon as its developer is done. When Phase 6 delivers, they live until delivery, as the retention rule says.
- **Mod:** "Watch terminal" uses Herdr's `terminal.peek`; I haven't pressed it in Herdr (the call is the documented one). The Delivery graph's PR panel is an empty line, as the plan says.
- **Pagination and Jira rate limits** are unchanged from Phase 3.

## Decisions for you

- **Trust dialog:** accept it by hand each time (today), have Collie accept it for worktrees it created (about ten lines, but it is your security prompt), or pre-trust `~/.herdr/worktrees` in Claude Code's own settings once?

## Suggestions (out of scope)

- Run a real agent test in CI-less form as an opt-in script (`tools/`), since the smoke setup I used took several manual steps.
- Re-sync `docs/herdr/` and re-record `fixtures/hc/` together, including `hc read`.

## New dependencies

None.

## Demo

```sh
make install                                    # collie, collie-controller, the mod
# A scratch repo, a profile and a workflow (real Claude Code; costs a few cents)
git init -b main /tmp/smoke && git -C /tmp/smoke commit --allow-empty -m init
collie ctl profile.save --args-file my-developer.json     # role developer, harness claude-code, args as above
collie ctl workflow.save '{"v":1,"id":"smoke","name":"Smoke","developer":"my-developer","reviewers":[],"max_remediation_rounds":0}'
herdr-app do tab.new --name Collie --mod collie           # New board (workflow: smoke), Import, set tickets ready
# Start run in the mod. Answer Claude's "trust this folder" dialog in the agent's terminal
# (Watch terminal in the inspector). Then:
git -C /tmp/smoke log --all --oneline                     # the ticket's commit
# Restart check: while an agent works, `hc kill collie-controller`; the agent keeps going.
# Start the controller again (open the Collie tab); it reattaches without a second agent.
```
Fake `hc` tests: `bun test packages/controller/test/agents.test.ts packages/controller/test/agents-e2e.test.ts`.
