# Phase 3 hand-off: Jira, dependency graph and board setup

Branch `phase-3`, based on `main` at `ca9d270` (Phase 2).

## What was built

**`packages/board`** (new, pure, no Node APIs, so the mod bundles it):

| Module | Job |
| --- | --- |
| `src/jira.ts` | Jira issues to board tickets: Blocks links in both directions, outside blockers, merging a refresh into a board while keeping Collie's own fields |
| `src/graph.ts` | Edges, cycle detection (Tarjan; overridden links don't count), the completion policy, readiness, the critical path |
| `src/layout.ts` | The layered left-to-right layout: layers by longest path; edges that skip layers are routed through empty slots, so no edge can cross a node; barycenter ordering; cycle-closing edges laid out reversed and drawn back |

**`packages/controller`:**
- `src/jira.ts`: the Jira client. Every call goes to `api.atlassian.com/ex/jira/{cloudId}/rest/api/3/…` with Basic auth. It looks up the cloud id from the site, searches with `POST /search/jql` following `nextPageToken`, and fetches by key in batches of 50. A 401 with `x-failure-category: FAILURE_CLIENT_AUTH` says to check the email in the keychain account field and the token. A 400 is `invalid_args` with Jira's own message. The network is one injected function, so tests play back recordings.
- `src/credentials.ts`: reads the `collie-jira` keychain item at the moment of use. The account field is the email. If more than one item has the service name it refuses and names the accounts.
- `src/boards.ts`: `board.import`, `board.refresh`, `ticket.pull_in`, the cycle check, and readiness inside a running run.
- `src/commands.ts` and `src/controller.ts`:
  - **Commands:** `board.create` looks up `cloud_id`; `ticket.set_preparation` (which also excludes a ticket), `dep.override` and `dep.restore` recalculate readiness in the board's active run.
  - **`run.start`:** refuses a cycle (`cycle_detected`, naming it), and puts each ticket in `ready` or `blocked`.
  - **Command loop:** it is now async, because Jira calls take time. Commands still run one at a time, in id order.

**`mod/`** (the Herdr mod, TypeScript against `docs/herdr/*.d.ts`, bundled by `make mod`):
- `src/model.ts`: the view model and the button actions, pure and tested.
- `src/collie.ts`: reads `~/.collie`, runs `collie ctl`, and starts the controller with `hc run` (label `collie.role=controller`) when no live lock exists.
- `src/main.ts`: rendering. The header has the board pills, controller status and New board. Two view tabs:
  - **Board setup:** the import box (keys or JQL), Refresh from Jira, a disabled Start run, the ticket table with a preparation chip that cycles through the five statuses, and the outside blockers with Pull in and Override.
  - **Graph:** columns, arrows, the critical path in red, outside blockers dashed, an inspector on selection, and room under each node for Phase 4's agent chips.
- It keeps no state beyond what's on screen: boards come from `~/.collie` and a folder watch redraws it. The last screen, board and selection are remembered in `localStorage` and can be passed as props.

**Other:**
- `fixtures/boards/`: 11 generated boards. `fixtures/jira/`: 5 recorded, scrubbed Jira steps.
- `tools/jira-record`: the hand-run recorder.
- `make mod`, `mod-install`, `bin-install` and `install`. `make build` still builds both binaries.
- `@collie/schema` no longer uses Node-only APIs (`node:crypto`, `Buffer`), so the mod can use it. The protocol records the Blocks direction, `board.refresh`'s result, cycle refusal, and readiness recalculation.

**Real Jira data.** I created six `[Collie test]` tasks in the project-66 backlog, as you agreed: a chain, a fan-in, one blocker kept off the board, and a Relates link that must not order anything. I linked them by hand and recorded the traffic. Real keys, site, cloud id and account ids are scrubbed (`TST-n`, `[SITE]`, `[CLOUD-ID]`). The recordings confirmed the link direction the plan asked us to check: on issue A, `outwardIssue: B` means A blocks B.

## Done when

| Item | Test |
| --- | --- |
| Importing five tickets with known links produces the expected graph | `jira.test.ts`, "importing five tickets…": plays back the recorded import and checks the edges and layers, including the outside blocker and the ignored Relates link |
| Layout unit tests place every fixture board with no overlapping nodes and no edge crossing a node | `board/test/layout.test.ts`: 11 boards, six checks each. Sampling 40 points along every edge, I confirmed it fails when long edges aren't routed through their reserved slots. |
| A cycle is reported and blocks Start run | `jira.test.ts` (`cycle_detected`, naming `PAY-1 -> PAY-2 -> PAY-3 -> PAY-1`; an override then lets the run start) and `model.test.ts` (the Start run explanation) |
| A blocker outside the board shows Pull in and Override, and both work | `model.test.ts`: the buttons the mod draws are Pull in and an Override for each ticket held up, and every one sends a command the controller accepts. `jira.test.ts`: pulling in fetches the blocker's own status, and an override readies a ticket at once (restore blocks it again). Checked by eye in Herdr as well. |
| Readiness changes when a blocker's Jira status changes and you refresh | `jira.test.ts`: two recordings of the same blocker, before and after it moved to Done in Jira; `readiness_changed: ["TST-3"]` and a logged `blocked → ready` |
| Reloading the mod shows the same board without data loss | `model.test.ts`: the same `board.json` gives the same model. In Herdr: after the controller was killed (overnight) and the mod reloaded, the board came back identical, and the mod started a new controller, which replaced the dead lock. |

`make check`: lint, typecheck (including `mod/tsconfig.json`) and 449 tests, all green. `herdr-app check` passes on the mod.

## Deviations from the docs, and why

1. **No wireframes.** `docs/wireframes/` doesn't exist. As agreed, I laid out the Collie tab and Board setup from the plan's text. Layout is cheap to change once you've seen it.
2. **`init(props, cx)` gets `undefined` for a tab mod** (live Herdr differs from `docs/herdr/AGENTS.md`). The props reach the mod only through `props()` from `herdr`. The mod uses that. Worth fixing in the docs snapshot at the next re-sync.
3. **`bun build --target browser` silently replaces `fs/promises` with an empty stub**, so listing boards would find nothing. `make mod` uses `--target node` with the Herdr modules marked external.
4. **The mod runs `collie` and `collie-controller` from your PATH**, because a mod can't read your environment. `make install` puts them in `~/.local/bin`.
5. **`docs/protocol.md` updated** (additive): the Blocks link direction, the `board.refresh` result, `done_or_testing` and `custom` precisely, `cycle_detected`, and readiness recalculation.

## Every `DECISION:`

| Where | Decision |
| --- | --- |
| `board/jira.ts` | A link doesn't carry `resolution`, so an outside blocker's is null until it's pulled in or refreshed |
| `board/graph.ts` | `done_or_testing` counts any status whose name mentions "test" or "QA" |
| `mod/collie.ts` | The mod runs `collie` and `collie-controller` from PATH, and uses `~/.collie` |
| `mod/main.ts` | A controller that dies while the tab is open is restarted once; after that, the Start button takes over |
| `mod/main.ts` | The screen, board and selection are remembered in `localStorage`, and props override them |
| `controller/boards.ts` | Readiness in a running run uses the board's current tickets, overrides and completion policy, not the start-of-run snapshot. That is what makes "refresh changes readiness" work. In-run blockers count once `completed` in the run. |
| `controller/boards.ts` | Once a ticket leaves `ready`, a regression is not acted on (the protocol's rule) |
| `controller/controller.ts` | Commands run one at a time; one waiting on Jira doesn't block the inbox watcher |

## Known gaps

- **Start run is a disabled button** in the mod. Starting runs from the UI is Phase 4.
- **The controller starts only when the Collie tab is shown.** Herdr starts a mod copy the first time its tab is shown, so a never-opened tab starts nothing.
- **No drag-to-pan** in the graph, as agreed after the spike. A wide graph scrolls under the inspector.
- **No Jira rate-limit handling.** A 429 comes back as an `upstream_error`. Retries and backoff belong in Phase 7.
- **Pagination is exercised only against a fake.** The recordings use 5–6 issues. The spike confirmed `nextPageToken` against the real endpoint.
- **The critical path counts tickets, not effort.** Every unfinished ticket weighs the same.
- **Preparation is set by hand**: the chip cycles through the five statuses. The requirements analyst is Phase 5.

## Suggestions (out of scope)

- Re-sync `docs/herdr/` and re-record `fixtures/hc/` together, and add `hc <cmd> --help` output.
- Phase 4 could pass the board's `complete_at` and run states into `readiness()` for the graph's colours during a run; the function already takes them.

## New dependencies

None.

## Demo

```sh
make install                                          # collie, collie-controller, the mod
herdr-app do tab.new --name Collie --mod collie       # starts the controller if needed
# New board: your Jira site, project key and a repo; Import: issue keys or JQL.
# Board setup: the preparation chips, Pull in, Override, Refresh from Jira.
# Graph: click a node; Pull in and Override are in the inspector too.
# Open straight on the graph:
herdr-app do tab.new --name Collie --mod collie --props '{"screen":"graph"}'
```

Needs the `collie-jira` keychain item: account = your Atlassian email, password = an API token with read access.
