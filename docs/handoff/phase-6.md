# Phase 6 hand-off: delivery (PRs and Jira)

Branch `phase-6`, based on `main` at `d79ec9c` (Phase 5).

## What was built

**Controller** (`packages/controller`)

| Module | Job |
| --- | --- |
| `src/bitbucket.ts` | `CodeHost` interface and `BitbucketCloud`: scope check, find, create, read, update a PR. Bearer token read from the keychain for each request |
| `src/remote.ts` | `Remote` (push, fetch a destination branch) over HTTPS with the inline keychain credential helper; `git merge-tree --write-tree` conflict check; git version check |
| `src/delivery.ts` | The level-triggered delivery pass: push and open PRs, retries, completion levels, PR tracking, conflict checks, stack upkeep, Mark ready, Jira write-back |
| `src/credentials.ts` | `keychainBitbucket()`; one `collie-bitbucket` item, a second is refused |
| `src/jira.ts` | `transitions`, `transition`, `comment` |
| `src/agents.ts`, `controller.ts`, `commands.ts`, `reducer.ts`, `git.ts`, `main.ts` | Gate hands a ticket to delivery; ended runs with open PRs stay tracked; `pr.mark_ready`; preflight on `run.start`; `ticket.retry` for `delivery_error`; the base rule for merged blockers; reducer for `needs_rebase` and `jira_steps` |

**Mod** (`mod/`, built by a subagent): Pull requests panel with Mark ready, PR card and Jira steps in the inspector, `delivery_error` in the Needs you banner with Retry, alerts for a new PR, a merge and a needed rebase, and the `complete_at` and PR draft policy controls in Board setup.

**Schema** (additive, no `v` bump): `delivery.failed` event; optional `step` on both Jira events; optional `needs_rebase` on `pr.updated` and on a ticket's `pr`; optional `jira_steps` on a ticket. Fixture added; `fixtures/bitbucket/` holds the recorded exchanges.

## Done when

| Item | Evidence |
| --- | --- |
| Two dependent tickets give stacked PRs with correct destinations; an independent one targets the default branch | `delivery.test.ts` (fake code host, real git, a local bare repository as the remote): destinations, and the branches are in the remote |
| *Draft when stacked*: independent ready, stacked draft; *Always draft*: both draft | `delivery.test.ts` |
| Merging the parent flags the child for rebase, retargets it and marks it ready | `delivery.test.ts`: also that `needs_rebase` clears once main's head is in the child's history, and that tracking survives a restart |
| Mark ready publishes a draft PR | `delivery.test.ts` (controller command, also after the run ended). The mod button was **not pressed in real Herdr** |
| Jira transitions and comments as the policy says | `delivery.test.ts` with a fake Jira: both write-backs once each (also across a restart), and `jira.writeback_skipped` with the available targets. **Not run against a real test project** |
| The Bitbucket token never appears in events, logs, agent environments or saved remotes | `bitbucket.test.ts`: only the Authorization header and the keychain (`-w`) see it; the push URL and helper carry none (the helper was also run against a fake `security`); errors don't contain it. Nothing hands a token to agents or events |

`make check`: lint, typecheck and all tests green (577).

## Every `DECISION:`

| Where | Decision |
| --- | --- |
| protocol | A run's directory is read-only once it ends, **except** that while one of its PRs is open the controller keeps loading it and appending `pr.*`, `jira.*` and `delivery.*` events (the plan wants tracking after the run ends) |
| `delivery.ts` | `implemented` completes the ticket at the gate and delivery goes on behind it; a run doesn't end while a ticket still has no PR; a delivery error on a completed ticket is an `attention` entry without a state change |
| `delivery.ts` | `pr_approved` means at least one approval from someone other than the author |
| `delivery.ts` | A stacked ticket waits to open its PR until its parent's PR exists |
| `delivery.ts` | Without a code host (tests, `COLLIE_NO_AGENTS`) a ticket completes as it passes the gate, as before |
| `delivery.ts` | Delivery steps retry three times (2 s, 10 s), then `delivery_error`; Jira write-back is best effort: three tries 30 s apart, then logged and left until a restart |
| `delivery.ts` | `needs_rebase` clears when the destination's head is in the PR branch's history (checked on each poll) |
| `delivery.ts` | A declined PR is recorded and left alone |
| `bitbucket.ts` | A token that reports no scopes isn't refused at `run.start`; the first write names what's missing |
| `agents.ts` | When a blocker's PR is merged, the branch is cut from a fresh fetch of the default branch (`refs/collie/dest/<branch>`) rather than the local one |
| `jira.ts` | Transition choice: `to.name` equal to the target, an exact transition name first |

## Deviations from the docs

1. "Read-only once a run ends" narrowed as above (docs/protocol.md "Phase 6 rules").
2. The recorded Bitbucket fixtures were written by hand from the spike's results and the API's shapes, not captured. They say so in `fixtures/bitbucket/README.md`; compare them with a real response during the demo.

## Known gaps

- **Nothing here has run against real Bitbucket or Jira.** The code host, push and Jira write-back are tested against fakes, a local bare repository and recorded shapes. The demo below is the check.
- A declined PR leaves a ticket that waits for approval or a merge waiting; cancel it with `ticket.cancel`.
- A stacked ticket whose parent is cancelled or fails after it started has a base that is never pushed, so its PR never opens (it waits). Rebase or cancel by hand.
- Automatic rebasing is out of scope: Collie flags `needs_rebase` and leaves the rebase to a person.
- The mod, as its builder noted, shows only the active run when a board has one, so an older ended run's open PRs aren't shown while a new run is active.
- Not pressed by hand in real Herdr: the PR panel, Mark ready, Retry delivery, the new settings pills, or the new alerts.
- The Jira token needs `write:jira-work` as well as the read scope; a 401 or 403 on a write is reported as a Jira error in `controller.log` and retried, not shown in the mod.

## Decisions for you

- **Token:** a repository access token with `pullrequest:write` in the keychain item `collie-bitbucket` (the account field is ignored; the item must be unique).
- **Real test project:** which Jira project and Bitbucket repository to use for the demo. I haven't touched any.

## New dependencies

None.

## Demo

```sh
make install
# keychain: collie-jira (email as account, token as password) and collie-bitbucket (the token as password)
# Board setup: a scratch repository whose local_path is a clone, complete_at pr_created, PR draft policy draft_when_stacked
# Import two linked tickets and one independent one; Start run. Expect:
#   - the independent ticket's PR targets main, ready for review
#   - the dependent ticket's PR targets its blocker's branch, as a draft
#   - the issues move to the policy's targets and get a comment with the PR link
# Merge the first PR in Bitbucket: within ~30 s the dependent PR's destination becomes main, it is marked ready,
# and the ticket shows Needs rebase. Mark ready on a draft from the Pull requests panel.
# Fake-host tests: bun test packages/controller/test/delivery.test.ts packages/controller/test/bitbucket.test.ts
```

## CI races found after the first push

`make check` passed locally but failed on CI three times, all from races between background delivery work and state changes:

- A conflict check that began before a retarget could clear `needs_rebase` right after the retarget set it. The check read the PR from live state that the reducer mutates in place; it now keeps the destination it started with.
- A PR poll in flight during a retarget could write the old destination back. It now drops the destination when the PR changed while the request ran.
- `h.calls()` could parse a half-written `fake-hc` line (a Phase 4 test flaked). It now skips a partial last line.

Lesson for later phases: never hold a reference to `rl.state` objects across an `await`; copy the fields the work is about. Run `make check` several times before pushing anything with timing in it.
