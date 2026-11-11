# Manual acceptance checklist

The MVP is done when the scenario in `docs/plan.md` ("MVP acceptance scenario") passes twice: automated
(`packages/controller/test/acceptance.test.ts`, run by `make check`) and once by hand, with this list.
Nothing here is ticked. Tick a box only when you saw the result described.

Steps 8 and 20 can only be checked here: the automated test covers their controller-side contract
(terminals labelled `collie.*`; `state.json` intact and identical to what the event log replays to).

## Prerequisites

- Real Herdr running, with `hc` on PATH, and Claude Code (`claude`) installed and logged in.
- git 2.38 or later (`git --version`); Collie uses `git merge-tree --write-tree`.
- A **scratch** Jira project, `[SITE].atlassian.net`, and a **scratch** Bitbucket Cloud repository,
  `[WORKSPACE]/[REPO]`, with a `main` branch. Never use a real project or repository.
- A local clone of `[REPO]` whose `origin` is the scratch repository, on `main`, clean.
- Keychain items (macOS Keychain). Never write the real values into this file, a commit, or a shell history you keep:
  - `collie-jira`: account = your Atlassian email, password = an API token. It needs read access (`read:jira-work`) and
    `write:jira-work` for transitions and comments.
    `security add-generic-password -s collie-jira -a <your Atlassian email> -w`
  - `collie-bitbucket`: password = a repository access token with the `pullrequest:write` scope
    (it includes `repository:write`). The account field is ignored. Exactly one item may have this name.
    `security add-generic-password -s collie-bitbucket -a collie -w`
- Five Jira tickets in the scratch project, small and independent of any real code, linked in Jira as:
  1 blocks 2, 2 blocks 4, 3 blocks 4, 4 blocks 5, and a sixth ticket (X) that is **not** among the five and blocks 3.
  Make ticket 3 deliberately vague (for example "Handle refunds" with no acceptance criteria) so the analyst has a question.
  Leave all six in the first status of the workflow (To Do).
- The Jira workflow has the statuses named in the board's write-back policy (default "In Progress" on start, "In Review" on PR).

## Build and install

```sh
make check      # must be green first
make install    # builds collie and collie-controller into ~/.local/bin and installs the mod into Herdr
herdr-app do tab.new --name Collie --mod collie
```

`~/.local/bin` must be on PATH, because agents run `collie`.
Claude Code will ask once per repository whether to trust a new worktree folder. Answer it in the agent's terminal
(Watch terminal); Collie does not answer it for you.

## Setup

- [ ] **1. Create a board** linked to `[SITE]` project `[KEY]` and `[WORKSPACE]/[REPO]` (local path = your clone).
  In run settings choose workflow Standard feature, PR draft policy Draft when stacked, complete at PR created.
  See: the board appears. At Start run (step 6) the token scope check passes; a wrong or missing scope would stop the run and name it.
- [ ] **2. Import the five tickets** by JQL, for example `key in (X-1, X-2, X-3, X-4, X-5)` with your project key.
  See: five tickets on the board, status To Do, preparation Unreviewed.
- [ ] **3. Read the dependency graph.**
  See: edges 1>2, 2>4, 3>4, 4>5 and one dashed/external edge from the sixth ticket into 3; the sixth is not on the board.
- [ ] **4. Pull in the outside blocker.** Use Pull in on the external ticket.
  See: it is now on the board, the edge is solid, and ticket 3 shows as waiting on it. Mark it Ready.
- [ ] **5. Run the requirements analyst** on ticket 3 (Investigate); set the others to Ready by hand.
  See: ticket 3 goes Investigating, then Needs input with a question. Answer it in the question dialog; the ticket becomes Ready.
  (Ticket 3's agent terminal appears in the sidebar and closes when it finishes.)

## Execution

- [ ] **6. Start run.**
  See: the run is Running; every ticket is leased (state pending, blocked or ready); `~/.collie/runs/<run>/run.json`
  holds the settings, workflows and profiles you chose. Editing the board now does not change the running run.
- [ ] **7. Independent tickets start together.** See: ticket 1 and the pulled-in blocker each get a developer, each with its own
  worktree under `~/.herdr/worktrees/[REPO]/` and its own terminal. Tickets 2, 3, 4, 5 show Blocked, with no agent.
- [ ] **8. Agents in Herdr.** See: each running agent is a terminal in Herdr's sidebar named `<ticket>-<id>` and labelled
  `collie.*` (`hc ls --label collie.run=<run id>`). In the ticket inspector, Watch terminal opens its live terminal.
- [ ] **9. A refused `done`.** When a developer is working, tell it (in its terminal) to leave one file uncommitted and call `collie done`.
  See: the done is refused with "the worktree has uncommitted changes" (Activity: `agent.event_rejected`); the agent is told when idle,
  commits, reports again, and the ticket moves to Reviewing.
- [ ] **10. Parallel reviewers.** See: when a developer's done is accepted, the security and backend reviewers start at the same time,
  read-only, in the developer's worktree.
- [ ] **11. A reviewer's question.** Tell a reviewer to `collie ask` something (for example whether an endpoint is public).
  See: the ticket moves to Needs input, the Needs you banner shows, and Herdr raises a notification.
- [ ] **12. Answer it.** Answer in the question dialog.
  See: the answer is typed into the reviewer's terminal only once the agent is idle (never while it works), the ticket returns to Reviewing,
  and the reviewer continues.
- [ ] **13. A blocking finding.** Tell a reviewer to report a blocking finding and request changes.
  See: exactly one remediation round (the developer is relaunched with the finding in its brief), the reviewer re-runs and approves,
  and the ticket passes the gate.
- [ ] **14. An idle agent.** Tell a developer to stop and not report (or interrupt it and leave its terminal idle).
  See: after about 30 s it is nudged, again 30 s later, then failed and retried automatically as attempt 2 in the same worktree
  (Activity: two `execution.nudged`, `execution.failed`, a new execution).

## Delivery

- [ ] **15. Independent PRs.** See: the branch is pushed and a Bitbucket PR opens **ready for review** (not draft), destination `main`.
- [ ] **16. Stacked PR.** See: a ticket started while its blocker's PR was open was based on the blocker's branch (its worktree contains the
  blocker's commit) and its PR is a **draft** whose destination is the blocker's branch.
- [ ] **17. Jira.** See: each ticket with a PR moved to the policy's statuses (In Progress on start, In Review on PR) and has one comment
  linking the PR, once.
- [ ] **18. Downstream starts at PR created.** See: ticket 2 started when ticket 1's PR was created, and ticket 4 when both 2 and 3 had PRs,
  without waiting for any merge.
- [ ] **19. Merge the parent.** In Bitbucket, merge ticket 1's PR.
  See: within about 30 s the child PR's destination becomes `main`, it is marked ready for review, and the ticket shows Needs rebase.

## Resilience and completion

- [ ] **20. Reload the mod mid-run.** While an agent works, close and reopen the Collie tab (or reload the mod).
  See: the graph, tickets, PRs, questions and agents are all as before; nothing is lost or duplicated.
- [ ] **21. Kill and restart the controller mid-run.** While an agent works: `hc kill collie-controller`, then reopen the Collie tab.
  See: the agent's terminal keeps running, the new controller reattaches, no second terminal appears for any execution
  (`hc ls --label collie.run=<run id>`).
- [ ] **22. Completion.** Let the remaining tickets finish.
  See: the run completes once every ticket is Completed (PR created), and the Activity view shows the whole event history
  from `run.started` to `run.completed`. PR tracking carries on after the run ends.
- [ ] **23. Secrets.** See: neither token appears anywhere:
  `grep -r -e "<token>" ~/.collie` (use the real value in your shell only; expect no match), the controller log, `ps` output while a push runs,
  an agent's environment (`env` in its terminal), or `git config --get-regexp remote` in your clone and any worktree.

## Record the result

Date, Collie commit, Herdr and Claude Code versions, anything that deviated, and the run id. File deviations in the phase hand-off report.
