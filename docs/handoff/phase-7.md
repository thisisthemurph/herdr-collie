# Phase 7 hand-off: hardening and MVP acceptance

## What was built

| Area | Where |
| --- | --- |
| Retention: the prune pass (inboxes and attachments at 90 days, worktrees, terminals), run every start and daily | `packages/controller/src/retention.ts`, wired in `controller.ts` and `main.ts` |
| Run metrics (pure) | `packages/board/src/metrics.ts` |
| Second harness: a Cursor adapter and a seeded `developer-cursor` profile | `packages/controller/src/adapters/cursor.ts`, `defaults.ts` |
| Mod: Activity view and run history, metrics, New run from a previous run, agent profile editor, retry and cancel controls | `mod/src/{model,main,collie}.ts` |
| MVP acceptance scenario as one end-to-end test (23 ordered tests) | `packages/controller/test/acceptance.test.ts` |
| Manual checklist for the real run | `docs/manual-acceptance.md` |
| Docs | `README.md`, `docs/setup.md`, `docs/protocol.md` ("Phase 7 rules the controller applies") |

## Done-when evidence

| Item | Evidence |
| --- | --- |
| The end-to-end scenario passes in CI | `acceptance.test.ts`, steps 1 to 22 plus a secrets check. Run 10 times in a row, and 10 times under heavy CPU load. Steps 8 and 20 and the Herdr notification in step 11 need real Herdr and are checked at the controller's contract only (see below) |
| A manual run on a real board with five tickets | **Not done.** `docs/manual-acceptance.md` is the checklist; nothing in it is ticked |
| Retention rules | `retention.test.ts` (7 tests): a worktree is kept while its PR is open (logged once), removed after a merge, kept with uncommitted changes or unpushed commits; a cancelled ticket's worktree goes after 7 days, not before; an active ticket's is untouched; inboxes and attachments go after 90 days with one `retention.pruned`; terminals of finished tickets are closed; `run.delete` is refused while running or while a PR is open |

`make check`: lint, typecheck and all tests green (634), three times in a row.

## Every `DECISION:`

| Where | Decision |
| --- | --- |
| `retention.ts` / protocol | A completed ticket with no PR (no code host) waits 7 days before its worktree goes, like a cancelled one |
| `retention.ts` | `worktree.kept` is logged when the reason changes, not on every daily pass |
| protocol | The analyst's detached `prep-*` worktrees and board preparation folders aren't pruned |
| `metrics.ts` | An *intervention* is any human-sourced event on a ticket other than the command's own `command.applied` or `command.rejected` |
| `adapters/cursor.ts` | Cursor's documented flags include no system prompt or rules option, so the instructions go in front of the first message; the binary is looked for as `cursor-agent`, then `agent`, or `$COLLIE_CURSOR` |
| `defaults.ts` | The seeded Cursor profile's model, `auto`, is a placeholder, and its arguments are empty: no `--force`, so the agent asks before running commands and a person answers in its terminal (Cursor has no command allowlist like Claude's) |
| mod | A run counts as pruned only when more than 90 days past its end with no `inbox.jsonl`; Delete is pre-blocked only for running or paused runs (open PRs are left to the controller's refusal); `agent.event_accepted` rows are hidden in the event list; the list shows the newest 300 matching events; `run.cancel` also gets a confirm step |
| mod | The mod's `Input` is single-line (the pinned `gpui-kit.d.ts` has no multi-line state), so profile instructions and arguments are written on one line with `\n` for a line break and `\\` for a backslash |
| mod | A saved profile's role and id are fixed; harness choices are `claude-code` and `codex` (any other saved value still shows) |
| acceptance test | The token scope check is asserted at `run.start`, where Phase 6 runs it, not at board creation |

## Deviations from the docs

1. `docs/wireframes/` isn't in the repository, so the Activity view and the profile editor (wireframes 6 and 5) were designed from the plan's description.
2. The acceptance scenario's outside blocker (step 3 and 4) is a sixth ticket delivered through the run. The recorded pull-in fixture has it already Done, and a Done ticket isn't leased; step 4 replays that fixture with its To Do status copied from another recording, so it is a modified recording.
3. The second harness is Cursor, as you chose. I started on Codex before you said, and replaced it.

## Known gaps

- **Never run against anything real.** Real Herdr, Claude Code, Codex, Jira and Bitbucket haven't been touched. The manual checklist is the check, and it has to be done before the MVP is called done.
- **Not drawn or clicked in real Herdr:** everything new in `mod/src/main.ts` is only typechecked: the Activity layout, run cards, filters, event rows, the profile editor inputs, pills and toggles, the Yes/No confirms, the scroll areas, and the loading of `~/.collie` files. Mod unit tests cover the pure rules and that every new button sends a command the schema accepts.
- **Cursor has never been launched.** Its adapter follows Cursor's CLI reference (`agent [prompt]`, `--model`), but the placeholder model name, the prompt-in-first-message approach and how `hc` reads a Cursor turn ending are unchecked; check them with the manual checklist. Without `--force` it will stop at every command waiting for someone to answer in its terminal.
- The event list in the Activity view doesn't scroll to the newest rows (no scroll-to-bottom API in `docs/herdr/`), and the Profiles tab needs a board to exist.
- `ticket.retry` and `ticket.cancel` are refused on a run that is tracked only for open PRs, so a `delivery_error` on an ended run can't be retried from the UI.
- **A ticket that is already Done in Jira but still on the board (not excluded) is leased and gets a developer agent**, and its dependents stay blocked until that agent finishes. Cause: board setup judges an on-board blocker by Jira status and the completion policy, but a run judges it only by its state in the run, and `run.start` leases every on-board, non-excluded ticket whatever its Jira status. Confirmed with a throwaway test. Setting the ticket to Excluded makes it count as done by the board's policy and avoids both. (An earlier version of this note said such a ticket is never leased; that was wrong.)
- Jira write-back is tested against a fake Jira; there is no recorded write traffic.
- Retention doesn't prune the analyst's detached worktrees.

## Suggestions (not built)

- A scripted "real run" helper that creates the scratch Jira tickets and checks the checklist.
- Write the Jira write-back recordings during the manual run, and replace the hand-written Bitbucket fixtures with real captures.
- Auto-scroll the Activity view, and a multi-line field once Herdr's kit has one.

## Demo

```sh
make install
herdr-app do tab.new --name Collie --mod collie
# then follow docs/manual-acceptance.md, step by step
# automated: bun test packages/controller/test/acceptance.test.ts packages/controller/test/retention.test.ts
```
