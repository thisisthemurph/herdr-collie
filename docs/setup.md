# Setting up Collie

## Requirements

| Need | Why |
| --- | --- |
| macOS | Tokens are read from the keychain with `security` |
| Herdr with `hc` | Collie is a Herdr mod, and agents run in Herdr terminals. The pinned versions are in `docs/herdr/VERSION` |
| [Bun](https://bun.sh) 1.x | Builds Collie |
| git 2.38 or later | The PR conflict check uses `git merge-tree --write-tree`. `run.start` refuses an older git and says so |
| [Claude Code](https://claude.com/claude-code) (`claude`) | The default agent harness. Codex is the second harness (see below) |
| A Jira Cloud site and a Bitbucket Cloud repository | Where tickets come from and PRs go to |
| A local clone of that repository | Agents work in worktrees of it. Collie never touches your working copy's branch |

## Install

```sh
git clone <this repository> && cd herdr-collie
make install-deps
make install        # builds collie and collie-controller into ~/.local/bin and installs the mod
```

Make sure `~/.local/bin` is on your `PATH`. The mod runs `collie` and `collie-controller` from it.
`make install` stops short of running Herdr: it ends with `herdr-app check`, which validates the mod.

## Credentials

Both live in the macOS keychain. Collie reads them only when it makes a request.

**Jira.** An [Atlassian API token](https://id.atlassian.com/manage-profile/security/api-tokens).
It needs to read issues and, so Collie can move tickets and comment, to write them
(`write:jira-work`). The *account* field is your Atlassian email:

```sh
security add-generic-password -s collie-jira -a <your Atlassian email> -w
```

**Bitbucket.** A repository (or workspace) access token with the `pullrequest:write` scope.
The account field is ignored. Keep exactly one item:

```sh
security add-generic-password -s collie-bitbucket -a collie -w
```

`security … -w` with no value prompts for the secret, so it never lands in your shell history.
If a service name has two items, Collie refuses to guess and names them (not their secrets).

`git push` and `git fetch` get the Bitbucket token through an inline credential helper that
reads the keychain when git asks for it. It never appears in a URL, a command line or a saved remote.

## Open Collie

```sh
herdr-app do tab.new --name Collie --mod collie
```

If no controller is running, the mod starts one in an `hc` terminal labelled `collie.role=controller`.
Closing the mod does not stop it, and a run carries on. Reopen the tab to see where it got to.

## Your first board

1. **New board.** Name it, give the Jira site and project, and the repository's workspace and slug,
   its default branch and the *local path of your clone*. Collie checks the Bitbucket token's scope.
2. **Import** tickets by key or by JQL. Collie reads the Jira links and draws the dependency graph.
   A blocker that isn't on the board shows as *outside*; **Pull in** adds it.
3. **Board setup** holds the choices that matter:
   - the workflow (Standard feature runs a developer and reviewers; Small bug fix runs a developer only);
   - `complete_at`: when a ticket counts as done for starting its dependents. *PR created* lets a
     dependent ticket start, stacked on its blocker's branch, before the blocker's PR merges;
   - the PR draft policy: *Draft when stacked* opens stacked PRs as drafts, then marks them
     ready when the parent merges; *Always draft* drafts every PR;
   - the limits on tickets and agents running at once.
4. Optionally **Investigate** tickets: a requirements analyst reads the code and asks questions
   before a developer starts. Answer in the question dialog.
5. **Start run.** Tickets are leased and the configuration is snapshotted. Watch agents in Herdr's
   sidebar; open a ticket in the inspector and choose *Watch terminal* for its live terminal.
6. Answer questions when Collie asks (the *Needs you* banner), and retry or cancel from the
   inspector. PRs appear in the *Pull requests* panel. Open ones are tracked, even after the run
   ends, until they merge.

## Agent profiles and harnesses

A profile says which harness runs an agent, its model, extra arguments, permissions, a time limit
and its instructions. Collie seeds `developer`, `developer-codex`, three reviewers and
`requirements-analyst`, only when missing, so your edits and deletions are never undone. Edit them in
the profile editor. Workflows pick profiles by id.

| Harness | Program | Notes |
| --- | --- | --- |
| `claude-code` | `claude` on `PATH`, or `$COLLIE_CLAUDE` | Tested against a real Claude Code (Phase 0 spike) |
| `codex` | `codex` on `PATH`, or `$COLLIE_CODEX` | Collie puts the instructions in front of the first message because Codex has no flag for a system prompt. **Not yet run against a real Codex**: check it with the manual checklist before relying on it |

`hc run` doesn't expand shell aliases, so use a real path in `COLLIE_CLAUDE` or `COLLIE_CODEX` if
your command is an alias.

### The instructions Collie adds to every agent

Whatever a profile says, Collie appends the same block, so every agent knows how to report. It
lives in `packages/controller/templates/reporting-block.md` and is rendered into each execution:
start with `collie show task`; report with `collie status`; ask a person with `collie ask`; finish
with exactly one of `collie done` or `collie fail`; never background long commands; stay in the
worktree; never push, open PRs, touch Jira or start other agents. Don't repeat that in a profile.

## Where things are kept

Everything is under `~/.collie` (override with `COLLIE_HOME`): boards, profiles, workflows, and one
folder per run holding `events.jsonl` (the truth) and `state.json` (rebuilt from it). The controller
writes its own log to `~/.collie/controller.log`.

Retention is automatic, on start and then daily: a run's event log is kept until you delete the
run from the Activity view; its inboxes and attachments go 90 days after it ends; a worktree goes
once its PR is merged or declined (or 7 days after a ticket is cancelled), and **never while it has
uncommitted changes or commits the remote doesn't have**. Collie logs why it kept one.

## Environment variables

| Variable | Effect |
| --- | --- |
| `COLLIE_HOME` | Where Collie keeps its files (default `~/.collie`) |
| `COLLIE_CLAUDE`, `COLLIE_CODEX` | Full path to the harness program |
| `COLLIE_HC` | The `hc` program (default: `hc` on `PATH`) |
| `COLLIE_NO_AGENTS=1` | A controller that never starts agents or contacts a code host: for tests |

## Troubleshooting

- **`run.start` is refused.** Its message names what's wrong: a token without `pullrequest:write`,
  a git older than 2.38, a missing keychain item, or a repository path that isn't a clone.
- **A ticket is in *Needs you*.** Open it: a question to answer, an execution that failed and can
  be retried, a delivery (push or PR) that failed three times, or a review loop that hit its round cap.
- **The mod shows nothing after a restart.** The controller keeps running without it. Reopen the tab.
- **A stacked PR says *Needs rebase*.** The parent merged. Rebase or merge the default branch into
  the child's branch yourself; Collie notices and clears the flag.
