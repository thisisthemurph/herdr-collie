# Phase 5 hand-off: reviews, remediation, questions

Branch `phase-5`, based on `main` at `20b7eeb` (Phase 4).

## What was built

**Controller** (`packages/controller`)

| Module | Job |
| --- | --- |
| `src/gate.ts` (pure) | The review gate: which reviewers run in a round, retries, holds, and whether a round passes, remediates or hits the cap |
| `src/agents.ts` | Reviewers in parallel, remediation, the gate, answer delivery, the analyst; `launch` now takes any kind of execution |
| `src/runlog.ts`, `controller.ts`, `home.ts` | A board's preparation log (`boards/<id>/prep/`), laid out and kept like a run's |
| `src/commands.ts` | `ticket.investigate`, `ticket.set_workflow` (new), `ticket.retry` for any failed execution or the round cap, `question.answer` and `exec.cancel` for the analyst |
| `src/defaults.ts` | Saves the default profiles and the `standard-feature` and `small-bug-fix` workflows when missing |
| `src/reducer.ts` | Findings become addressed when a remediation that saw them completes |

**Mod** (`mod/`): Needs you banner, question dialog, Findings and Questions tabs, notifications (`alerts()` is pure), analyst and workflow controls in Board setup, kind and round in the inspector. Details in the mod section below.

**Schema**: one additive command, `ticket.set_workflow` (fixture and protocol row added). No bump of `v`.

## Done when

| Item | Evidence |
| --- | --- |
| A blocking finding triggers one remediation round, after which the reviewer approves and the ticket passes the gate | `workflow.test.ts` (fake hc, real git). **Real Claude Code:** a ticket told to "eval its first argument" got a blocking high security finding, `request_changes`, a remediation, then round 2 `approve`, and completed |
| Hitting the round cap moves the ticket to Needs input instead of looping | `workflow.test.ts`: `round_cap` attention, nothing starts afterwards, `ticket.retry` grants one more round |
| An answered question reaches the waiting agent, which continues the task | `workflow.test.ts` (typed once, bare, in the protocol's format; also across a restart). **Real Claude Code:** a developer told to ask which config format to use called `collie ask`; the answer was delivered; it wrote the file in that format |
| The analyst marks an under-specified ticket Needs input with its questions | `workflow.test.ts`: `investigating` → `needs_input` with the question → answer → `ready`. **Not run against real Claude Code** |

`make check`: lint, typecheck and all tests green.

## Findings from real Claude Code

1. **Pre-trusting `~/.herdr/worktrees` does not stop the trust dialog.** I tested it (the setting was in `~/.claude.json`): the first worktree of a repository still asked. Claude Code remembers trust once per repository: the second and third worktrees of the same repository did not ask. So the dialog appears once per repository.
2. **Bug fixed (Phase 4):** time spent waiting on that dialog counted against the 60 s start timeout, so answering it late failed the first attempt. The clock now restarts when the dialog clears (test added).
3. **Permission prompts are common.** Claude Code's own heuristics ask about some compound shell commands (a `git commit` with a multi-line message: "Contains brace with quote character"), whatever the allow list says. Collie shows the agent as blocked, and the person answers in its terminal. The default profiles allow `collie` and `git` and let everything else ask.
4. The default reviewer profile (`--allowedTools` for `collie` and read-only git, default permission mode) worked: reviewers reported findings and verdicts through the real CLI without prompts.

## Every `DECISION:`

| Where | Decision |
| --- | --- |
| `gate.ts` | The gate waits for every reviewer of the round, optional ones too; only required verdicts decide it |
| `gate.ts` | "Capped per workflow" counts remediation rounds: the default 2 allows two remediations; at the cap, `ticket.retry` starts one more |
| `gate.ts` | Round 2 onwards runs only the reviewers that asked for changes, optional ones included |
| `reducer.ts` | Findings are addressed by the completion of a remediation, with no event of its own |
| `agents.ts` | An answer is typed as one line (newlines become spaces) |
| `agents.ts` | The analyst works in a detached read-only worktree `prep-<ticket>` of the default branch; a ticket's `preparation` is moved only while it is `investigating` or `needs_input` |
| `commands.ts` | The analyst's profile is the one called `requirements-analyst` |
| `defaults.ts` | Default profiles and workflows are written only when missing |
| mod | The question dialog is drawn inside the view; "share" starts unchecked; the Investigate-all button targets only `unreviewed` tickets; notifications cover run events only |

## Deviations from the docs

1. The analyst's log is `boards/<id>/prep/events.jsonl` + `state.json` (the protocol named only the folder). Its controller events carry the board id as `run_id` (controller events require a ULID there); the analyst's own events carry `run_id: null` as the protocol says.
2. `ticket.retry` returns `execution_ids` as well as `execution_id`.
3. Herdr notifications are raised by the mod, as the protocol says, not by the controller.

## Known gaps

- Reviewers are read-only by their profile only; the controller doesn't check that a reviewer left the worktree unchanged.
- `delivery_error` has no retry yet (Phase 6).
- The mod reads no finding bodies (they are in `events.jsonl`; the Activity view is Phase 7). The analyst's design findings can't be told from other findings in `state.json`, which has no category.
- Not pressed by hand in real Herdr: Send, Retry, Investigate, the workflow chips, Answer, the share checkbox, "Watch terminal", and whether a notification toast and its action appear. Layout of the banner, tabs, dialog and Board setup was checked with screenshots against a hand-made home.
- The analyst was not run against real Claude Code.
- A rejected `done` message and nudges are still in memory (Phase 4).

## Decisions for you

- **Trust dialog:** pre-trusting the folder doesn't work. Either accept it by hand once per repository, or have Collie accept it for worktrees it creates (a few lines; your security prompt, so not done).
- **Permission prompts:** accept the default profiles as they are (anything but `collie` and `git` asks), or widen the developer's allow list (for example your test runner).

## Suggestions (out of scope)

- Kill an agent's terminal once its execution ends rather than when the ticket completes (reviewers' terminals stay open through remediation, as the retention rule says).
- A `collie finding` category in `state.json`.

## New dependencies

None.

## Demo

```sh
make install
collie ctl workflow.save '{"v":1,"id":"smoke-review","name":"Smoke review","developer":"developer","reviewers":[{"profile":"security-reviewer","required":true}],"max_remediation_rounds":1}'
# New board with workflow smoke-review, import a ticket, set it ready, Start run.
# Answer Claude's trust dialog once per repository in the agent's terminal.
# Fake hc tests: bun test packages/controller/test/workflow.test.ts packages/controller/test/gate.test.ts
```
