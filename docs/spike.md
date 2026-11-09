# Phase 0 spike — results

Run on 2026-11-09 against hc 0.1.17, herdr-app 0.1.12 (both match `docs/herdr/VERSION`) and
Claude Code 2.1.319, on macOS. The code is in `spike/` and is throwaway; scratch output goes to
the git-ignored `spike/work/`.

| # | Assumption | Result |
|---|---|---|
| 1 | `hc send` delivers to an idle Claude Code session and submits it | **Yes**, with three caveats |
| 2 | Herdr's agent status reliably shows when a turn ends | **Yes**, if background tasks are disabled |
| 3 | Env vars and labels from `hc run` reach the agent's shell | **Yes for env, via a wrapper** (`hc run` has no `--env`); labels are readable through `hc get` |
| 3b | (added) Agents survive a controller restart | **No by default**: they need `--no-parent` |
| 4 | gpui-kit can draw the dependency graph | **Yes** |
| 5 | Bitbucket Cloud supports the Phase 6 PR operations | **Yes, except conflict state**: the API has none; use a local `git merge-tree` |
| 6 | A scoped Jira token works through `api.atlassian.com/ex/jira/{cloudId}` | **Yes**, and only through that gateway; the site URL returns 401 |

## How the agent experiments were run

- `spike/lib/launch.sh` starts Claude Code with
  `hc run --bg --json --no-parent --no-notify --name … --cwd … --label collie.spike=1 --label herdr.space=… --label herdr.tab=… -- env K=V … ~/.local/bin/claude "<task>" --settings hooks.json --permission-mode acceptEdits --allowedTools "<narrow list>"`.
  The agents appeared as tabs in a `collie-spike` Herdr space.
- **Ground truth** comes from Claude Code hooks (`spike/lib/hooks-settings.json`), which append
  `<ms> <event>` to a log for UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStop and
  Notification.
- **Observed** status comes from `spike/lib/status-log.sh`, which polls `hc get --json` every 200 ms.
  `hc get` also reports the exact time of the last status change (`status_ms`) and a `turn`
  counter.
- Permissions: the planned `bypassPermissions` launch was refused by this machine's own
  safety policy, so every agent ran in default mode with `acceptEdits` and a per-experiment
  `--allowedTools` list. That suited the spike better anyway, because permission prompts could
  be triggered on purpose.

## 1. `hc send` delivers and submits — **yes**

**What I ran:** by hand from the shell, with `spike/lib/launch.sh`, `hc send` (with and without `HC_TERMINAL_ID`, `--if idle` and `--wait`), `hc wait` and `spike/lib/slow.sh` as a 40 s foreground command. The hook and status logs are in the git-ignored `spike/work/spike-e1*/`.

**What I observed:**

- **Boot:** `hc run` returned in about 350 ms. `hc wait <t>` returned `idle` 0.86 s after launch.
  There was no folder-trust dialog, because the folder sits inside an already-trusted repo.
  Expect one in a fresh worktree: check for `blocked` after launch.
- **Idle delivery:** `hc send t "…"` returned `{"started":true}` in about 220–240 ms. The hook saw
  the prompt submitted 0.25–0.47 s after the send. A two-line message containing quotes,
  backticks, `$HOME`, `%`, `&` and `<tag>` (the protocol's answer format) arrived byte for byte
  and was submitted once.
- **Turn end:** `hc wait` and `hc send --wait` returned 35–37 ms after the Stop hook.
- **Mid-turn delivery:** I sent while the agent was running a 40 s foreground command. Claude Code
  **queued** the text ("Press up to edit queued messages"), and the model saw it once the tool
  call finished, inside the same turn: one Stop, and `turn` went up by 1. Nothing was lost or
  interleaved. The UserPromptSubmit hook fired as soon as the text was typed, not when the model
  read it.
- **Blocked agent:** while the agent was `blocked` (on a permission prompt or a question), both plain
  `hc send` and `hc send --if idle` were refused with exit code 9 (`kind: blocked`) and the hint
  "typing would answer its dialog". Nothing was typed.

**Caveats:**

1. **Messages get a wrapper when sent from inside an hc terminal.** If `HC_TERMINAL_ID` is set,
   the agent receives `<hc from="t11t">…</hc>` instead of the bare text. The controller runs in
   an hc terminal (the mod starts it with `hc run`), so its answers and nudges would arrive
   wrapped. With `HC_TERMINAL_ID` unset, the text arrives as is.
2. **`--if idle` treats `done` as not idle.** `hc send --if idle` refuses an agent whose status is
   `done` (exit 10, `status_mismatch`). Claude Code ends almost every turn in `done` (finished
   while nobody looked), so `--if idle` refuses the very case the controller cares about. There is
   no `--if done`.
3. **A mid-turn send isn't lost, but it isn't held back either.** It goes into the current turn,
   so "never type into a working agent" still has to be enforced by the controller.

**Proposed changes:**

- protocol.md, "Questions" step 5 and "Idle without a report": deliver with
  `hc send` only when `hc get` reports `idle` **or** `done`, and never use `--if idle`. Treat exit
  codes 9 (blocked) and 10 as "not delivered, retry later", and never use `--force`.
- Controller harness adapter: run `hc send` with `HC_TERMINAL_ID` removed from its environment,
  so the agent gets the protocol's exact text. (The alternative is to accept the wrapper, but the
  answer template assumes bare text.)
- Close the open question in protocol.md ("Does `hc send` submit the message…"): yes; a mid-turn
  send is queued and handled in the same turn.

## 2. Status shows when a turn ends — **yes, if background tasks are disabled**

**What I ran:** `spike/exp2/run.sh` (analysis in `spike/exp2/analyze.sh`). Each scenario ran 3
times on a fresh agent. The results are in `spike/exp2/summary*.txt` and, raw, in
`spike/exp2/results/`.

| Scenario | Stop hook → `done` (`status_ms`) | False idle mid-turn | Notes |
|---|---|---|---|
| a. plain reply | 19–20 ms | 0 | |
| b. Read, two Edits, Bash | 19–24 ms | 0 | stayed `working` across all tool calls |
| c. 100 s foreground command | 22–26 ms | 0 | `working` for the whole 100 s |
| d. subagent (Agent tool) | 13–18 ms after the final Stop | 0 | the subagent ran in the background; Herdr **kept `working`** until the subagent finished and the follow-up turn ended |
| e. question asked as plain text | 16–37 ms | 0 | indistinguishable from any other finished turn (`done`) |
| f. AskUserQuestion | 17–22 ms | 0 | `blocked (question)` about 1.5 s into the turn; answered with `hc keys <t> enter` |
| g. permission prompt (`python3 -c …`) | 16–23 ms | 0* | `blocked (permission)`. Denying with Esc cancels the turn: `idle` 133 ms later and **no Stop hook** (*the analyzer counted it; it is a real turn end) |
| h. Bash with `run_in_background` | 18–21 ms | — | **`done` for about 30 s while the background job was still running**, then the agent woke itself (a `<task-notification>` prompt), went `working` and finished again |
| h with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | 18 ms | 0 | the background option was gone; the agent offered to run in the foreground instead |

Polling `hc get` every 200 ms saw the change 44–265 ms after the Stop hook. `hc wait <t>` saw it
in 35–37 ms.

Other observations:

- **Claude Code puts some commands in the background on its own.** Asked to run `sleep 45`, it
  refused a foreground sleep, started a background shell and ended its turn ("1 shell still
  running"). Herdr then showed `done` for 43 s.
- **Claude Code allows some commands without asking.** `date` (read-only) and `rm -f` (in the
  working folder, under acceptEdits) ran without a prompt.
- `hc get --json` gives `status.state`, `status_ms`, `turn` and, while working, `status.msg`
  (Claude's own one-line description of what it is doing). It also gives the reason for a block
  (`blocked (question)` versus `blocked (permission)`) in `hc send` errors.

**Proposed changes:**

- Claude Code adapter: launch with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. Add a line to the
  standard reporting block: "Run long commands in the foreground; don't background them with `&`."
  A shell `&` is the remaining hole.
- Treat `idle` and `done` alike as "turn ended". Use `hc wait <t>` (event-driven) rather than
  polling. A `turn` counter that went up is a cheap check that a nudge or answer was taken.
- Keep the 30 s grace period before the first nudge. It also covers the agent waking itself after
  a background job finishes.
- A plain-text question (scenario e) looks the same as a finished turn. It is caught by the idle
  nudge ("you haven't reported…"), which is what the protocol expects agents to do: use
  `collie ask`. No change needed. Distinguishing the two would mean polling `hc read`, which isn't
  worth it.
- Record `blocked` with its kind on the execution, so the UI can say "waiting for permission".

## 3. Env vars and labels reach the agent's shell — **yes for env, via a wrapper**

**What I ran:** `spike/exp3/run.sh`. Two agents were each given the six `COLLIE_*` variables and
three `collie.*` labels. Each was told to run `env | grep -E '^(COLLIE|HC_)'`, a fake `collie`
script (`collie-fake`) that appends a line to `$COLLIE_INBOX` with every envelope field taken
from the environment, and `hc get $HC_TERMINAL_ID --json`.

**What I observed:**

- **`hc run` has no `--env` option** (live `hc run --help`; hc-skill.md doesn't mention one).
  Both workarounds work:
  - A. argv form: `hc run … -- env COLLIE_INBOX=… COLLIE_ROLE=… claude …`
  - B. shell-string form: `hc run "COLLIE_INBOX=… claude …"`
- In both, the agent's Bash tool saw all six `COLLIE_*` variables plus `HC_TERMINAL_ID`,
  `HC_TERMINAL_SOCKET` and `HC_SCOPE`. `collie-fake` wrote a correct line to each inbox.
- **Labels aren't environment variables**, but the agent can read them with
  `hc get $HC_TERMINAL_ID --json` (`labels`). `hc ls --json` and `hc get` show them, which is
  what restart reconciliation needs. Note: `hc get $HC_TERMINAL_ID` triggered a permission prompt
  ("a variable in this command can't be checked").
- **The environment is visible to the same user:** `ps -E -p <pid>` showed every `COLLIE_*` value.
  That's fine for these ids, but confirms that secrets must never go in the agent's environment
  (already a rule).
- **`--allowedTools` swallows a trailing task.** `claude --allowedTools "A B" "<task>"` treats
  the task as one more tool name, and the agent sits idle at turn 0 with no error. The task has
  to come before the options.

**Proposed changes:**

- protocol.md "Environment" and plan Phase 4: launch with an `env` argv wrapper:
  `hc run … -- env COLLIE_…=… <harness argv>`. Prefer the argv form so nothing goes through a
  shell's quoting.
- Claude Code adapter: put the first message before the options, or end the options with `--`,
  and test that the launch reaches `turn >= 1`.

## 3b. (added) Agents survive a controller restart — **no by default**

**What I ran:** `spike/exp3/fake-controller.sh`, a stand-in "controller" in an hc terminal, started
three `sleep 600` children: one with the default options, one with `--outlive-parent` and one
with `--no-parent`. Then I ran `hc kill` on the controller.

**What I observed:**

- The default child had `die_with_parent: true` and was killed with the controller (signal 1,
  reason `killed`).
- The `--outlive-parent` and `--no-parent` children kept running, with their labels intact.
  `--outlive-parent` keeps `parent` pointing at the dead terminal.
- By default hc also types notes about a child into its parent. For a controller, that would be
  text arriving on its own stdin.

**Proposed change:** protocol.md "Execution" and Phase 4: the controller starts agents with
`--no-parent --no-notify`. It owns their lifecycle through labels and `hc wait <t>`. That is
required for Phase 4's "restarting the controller mid-run reattaches to the running agent" check.

## 4. gpui-kit can draw the dependency graph — **yes**

**What I ran:** the throwaway mod in `spike/graph-mod/` (installed as
`~/.config/herdr-app/mods/collie-spike-graph`, opened with
`herdr-app do tab.new --space … --mod collie-spike-graph`). `herdr-app check` passed.

What it draws:

- 20 nodes in 5 layers, as absolutely positioned `div`s, each with a state dot, colors from
  `theme()` and room for agent chips ("dev")
- 24 cubic edges with arrowheads, drawn with `PathBuilder` and `window.paint_path` (one stroke
  path and one fill path per edge style)
- a dashed external-blocker edge (`dash_array`) and a red critical path
- click to select (the node's edges turn accent, its border thickens; click again to clear)
- an `overflow_scrollbar` viewport around a canvas bigger than the pane

**What I observed:**

- Building one render takes about 1 ms.
- `paint_path` coordinates are **local to the element** (a marker at (0,0) sits at the canvas's
  top-left), so edges can be drawn in canvas coordinates.
- Your review in Herdr: scrolling works, with edges moving together with nodes, but it's a little
  cumbersome. Selection works. It looks right. Good enough for the MVP.

**Suggestion (post-MVP):** click-and-drag panning of the graph canvas, with `on_mouse_down`/move
and a translated canvas, in addition to scrolling.

## 5. Bitbucket Cloud PR operations — **yes, except conflict state**

**What I ran:** `spike/exp5-bitbucket.sh [WORKSPACE] [REPO]`, which you ran with a repository
access token, then its `--conflict` and `--probe-conflict` modes. All of it was on throwaway
branches and PRs (`spike-collie-<ts>-*`); nothing touched the default branch. The transcript is
in `spike/work/exp5/output.txt`.

| Check | Result |
|---|---|
| Read the repository and its default branch | 200 |
| Token type and scopes from response headers | `x-credential-type: repo_access_token`, `x-oauth-scopes: pullrequest:write` (the endpoint's requirement is in `x-accepted-oauth-scopes`) |
| Create branches and commits through the API (`POST /src` with `branch` and `parents`) | 201. A stacked branch can be created on another branch's head with no clone. |
| Create a draft PR (`"draft": true`) on a stacked branch | 201, `draft=true` |
| Change its destination (`PUT` with `destination.branch.name`) | 200. **Draft is kept** after the retarget. |
| Mark ready (`PUT` with `"draft": false`) | 200. A re-read confirms `draft=false`. |
| Read approvals | `participants[] {role, approved, state}`. It's empty until someone takes part. |
| Approve (`POST …/approve`) | 200, and the bot shows as `approved`. According to you, Bitbucket doesn't count an author's own approval toward merge checks, so it's harmless. |
| **Conflict state** | **Not available.** See below. |
| Clean-up: decline PRs (`POST …/decline`), delete branches (`DELETE /refs/branches/{name}`) | 200 / 204 with the same token. Nothing from the spike is left in the repository. |
| 5b. Fetch and push over HTTPS with an inline git credential helper that reads the keychain (`username=x-token-auth`) | Both worked. No remote is saved in `.git/config`, and the token isn't found anywhere on disk under `spike/work/exp5`. |

**Conflict state:**

- I created a PR whose branches both add `spike-collie.txt` with different content, which is an
  add/add conflict. Bitbucket reported nothing:
  - the PR object has no merge or conflict field (`mergeable` is absent)
  - `GET …/pullrequests/{id}/diffstat` (a 302 redirect to a three-dot diffstat), the same with
    `topic=false`, and the two-dot `diffstat/{src}..{dst}` all say `added` for both the
    conflicting PR and a clean one
  - the diff contains no conflict markers
  - `diffstat/{spec}?merge=true` returns **410 Gone**, and with `topic=false` it returns **400**
- A local `git merge-tree --write-tree --name-only <dst> <src>` (git 2.50) does detect it, with no
  checkout: exit 1 with `CONFLICT (add/add): … spike-collie.txt`, and exit 0 for the clean pairs.
  This was checked offline on an equivalent throwaway repo (`spike/work/mergetree`).

**Proposed changes:**

- **Phase 6 conflict tracking:** each poll, fetch the destination branch with the credential
  helper into the ticket's repo and run `git merge-tree --write-tree <dest> <src>`. Exit 1 means
  conflicted, and the conflicting paths go on the event. Record it as `pr.conflict_checked`
  rather than as API state, and note that it needs git 2.38 or later (check at startup).
- **Push:** confirmed as the plan intends (the token never goes in the URL). Pin the exact
  mechanism in the protocol: `git -c credential.helper= -c 'credential.helper=!<reads keychain>' push <url> <ref>`,
  with `GIT_TERMINAL_PROMPT=0`. The first, empty `credential.helper=` stops any configured helper
  (such as osxkeychain) from saving the token.
- **Scope check (Phase 6 "token scopes checked on start"):** read `x-oauth-scopes` and
  `x-credential-type` from a cheap `GET` of the repository. Note that this token reported only
  `pullrequest:write` yet could also read the repository, create branches and commits, and push,
  because in Bitbucket `pullrequest:write` includes `repository:write`. So the check should accept
  `pullrequest:write` alone as enough, rather than look for separate repository and pull request
  scopes.
- **Self-approval:** the bot's own approval is accepted but doesn't count in Bitbucket, so there's no
  risk. Collie still has no reason to call `approve`. When tracking "PR approved", ignore the
  author's own entry in `participants` so Collie's view matches Bitbucket's.

## 6. Scoped Jira token through `api.atlassian.com` — **yes**

**What I ran:** `spike/exp6-jira.sh [SITE] [TEST-ISSUE] ['<JQL>'] [--transition <name>] [--comment]`,
which you ran. The token comes from the keychain item `collie-jira`, and its account field holds
the Atlassian email. The transcript is in `spike/work/exp6/output.txt`.

| Check | Result |
|---|---|
| `GET https://[SITE].atlassian.net/_edge/tenant_info` (no auth) | 200, `cloudId` returned |
| `GET https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/myself`, Basic `email:token` | 200, `accountType=atlassian` |
| Same call on `https://[SITE].atlassian.net/rest/api/3/myself` | 401, as expected for a scoped token. **Only the `api.atlassian.com` gateway works.** |
| JQL search: `POST …/rest/api/3/search/jql` with `fields: [summary, status, issuelinks]` | 200. Paginated with `nextPageToken` and `isLast`; there's no `total`. |
| Read an issue with `fields=status,issuelinks` | 200 |
| `GET …/issueLinkType` | 200. This site has `Blocks` (inward "is blocked by", outward "blocks"), `Relates`, `Duplicate`, `Cloners` and others. |
| List transitions on [TEST-ISSUE] | 200, 8 transitions, each `{id, name, to}` |
| Perform the "In Progress" transition (`POST …/transitions` with `{transition: {id}}`) | 204, status To Do → In Progress |
| Add a comment (ADF body) | 201 |
| Revert: "To Do" transition (id 13) | 204, status back to To Do. The spike comment is left on the issue; it says it's safe to delete. |

**Issue links:** a JQL search for issues with `Blocks` links returned 10 issues with 39 links.

- Each link has `type.{name, inward, outward}` and exactly one of `inwardIssue` or
  `outwardIssue`.
- That other issue comes with `key` and `fields.{status (with statusCategory), summary, issuetype, priority}`.
- So readiness, external blockers included, can be computed from the search results alone,
  without one request per issue.

**Observations:**

- **Transitions depend on the workflow and on the current status.** The list changed after the
  move (To Do offered 8, In Progress offered a different 8).
- **Status categories:** To Do is `new`, In Progress is `indeterminate`, and the done statuses are
  `done`. The Phase 3 completion policy can rely on `statusCategory.key` for "done only" and use
  status names for the custom mappings ("done or testing").
- **Two transitions can lead to the same status.** "In Progress" (id 12) and "Activity In
  Progress" (id 4) both end in In Progress, so a write-back policy has to name the target and
  resolve it each time.
- **Auth failures are generic.** A wrong email, a wrong token, or a duplicate keychain item all
  return the same bare `401 Unauthorized` with `x-failure-category: FAILURE_CLIENT_AUTH`. The first
  two runs failed exactly this way:
  - first, the item's account field held a placeholder address ending in `@example.com`
  - then two `collie-jira` items existed (an older one with account `mike`), and
    `security find-generic-password -s collie-jira` returned the old one first

**Proposed changes:**

- **Phase 3 Jira client:** always call `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…`.
  Look up `cloudId` once per board from `_edge/tenant_info` and cache it in the board's settings.
  Use `POST /search/jql` with `nextPageToken` pagination, asking only for the fields Collie needs,
  `issuelinks` included.
- **Link direction:** on issue A, a `Blocks` link with `outwardIssue: B` reads "A blocks B", and one
  with `inwardIssue: B` reads "A is blocked by B". That's Jira's standard reading, but the spike
  didn't check it against a pair you know. Make it the first recorded fixture in Phase 3, from two
  real test issues linked by hand.
- **Jira write-back policy (Phase 6):** set it by **target status name**. For each write, list the
  transitions and pick the one whose `to.name` matches, preferring an exact `name` match when
  there's more than one. If none matches, record a `jira.writeback_skipped` event that names the
  available targets, rather than failing the ticket.
- **Credentials:** when looking up a Collie secret, refuse to continue if more than one keychain
  item has that service. Name the accounts found in the error, but never print the secrets. On a
  401 with `FAILURE_CLIENT_AUTH`, the error should say "check the email in the `collie-jira`
  keychain item's account field, and the token". The same duplicate rule should apply to
  `collie-bitbucket`.

## Other findings

- **The live Herdr is newer than the snapshot is about to be.** Herdr is offering an update to
  0.1.14 and herdr-core 0.1.19. The snapshot (0.1.12 / 0.1.17) matched what ran during the spike.
  Re-sync `docs/herdr/` in its own commit before Phase 0 if you update.
- **`claude` is a shell alias on this machine.** `hc run` doesn't expand aliases, so the adapter
  needs a real path. Resolve it once, for example from the agent profile's `command`, or use
  `knownAgents()`'s `run`.
- **An unknown `herdr.tab` id creates a new tab.** Labeling an agent with an unknown
  `herdr.tab` id created a new tab in that space (as AGENTS.md says). That gives Collie a cheap
  way to show each execution as its own tab in a run's space.

## Changes agreed before Phase 0

All eleven changes were **accepted on 2026-11-09**. They're folded into `docs/plan.md` and
`docs/protocol.md` (the protocol's *Launching an agent* and *Talking to an agent* sections, and
its Configuration, Runtime files and Agent templates sections). Those docs are now the authority;
this table records where each change came from.

| # | Change | Where | Because of |
|---|---|---|---|
| C1 | Launch agents as `hc run --no-parent --no-notify … -- env COLLIE_…=… <harness argv>` | protocol "Environment", "Execution"; plan Phase 4 | 3, 3b |
| C2 | Claude Code adapter: set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; put the first message before the options; resolve `claude` to a real path; check that the launch reaches `turn >= 1` | adapter, Phase 4 | 2, 3 |
| C3 | Deliver answers and nudges only when status is `idle` or `done`; no `--if idle`, no `--force`; exit 9 or 10 means retry later; run `hc send` with `HC_TERMINAL_ID` unset | protocol "Questions", "Idle without a report" | 1 |
| C4 | Treat `idle` and `done` alike as "turn ended", observed with `hc wait <t>`; record `blocked` and its kind | protocol state notes, Phase 4 | 2 |
| C5 | Reporting block: "run long commands in the foreground" | protocol agent templates | 2 |
| C6 | PR conflict state from a local `git merge-tree --write-tree` after fetching the destination branch; require git 2.38 or later | plan Phase 6 | 5 |
| C7 | Pin the push mechanism (an empty `credential.helper=`, then an inline helper that reads the keychain, plus `GIT_TERMINAL_PROMPT=0`); scope check accepts `pullrequest:write` alone as enough; ignore the author's own approval | plan Phase 6, protocol | 5 |
| C8 | Jira through `api.atlassian.com/ex/jira/{cloudId}` only; `cloudId` cached per board; `/search/jql` with `nextPageToken` | plan Phase 3 | 6 |
| C9 | Jira write-back by target status name, resolved per call; `jira.writeback_skipped` when no transition matches | plan Phase 6, protocol events | 6 |
| C10 | Refuse duplicate keychain items per service; specific error text for a Jira 401 | plan Phase 3 and Phase 6 | 6 |
| C11 | Re-sync `docs/herdr/` if Herdr is updated to 0.1.14 / core 0.1.19 before Phase 0 | `docs/herdr/` | other findings |
| — | Post-MVP suggestion: drag-to-pan in the graph view | hand-off suggestion | 4 |
