# Herdr Collie

Collie delivers a set of Jira tickets with coordinated AI agents. It is a Herdr
mod (the UI) plus a background controller.

You import tickets into a board. Collie works out their dependencies, then runs a developer agent
for each ready ticket in its own git worktree and Herdr terminal, reviews the work with parallel
reviewer agents, has the developer fix what they find, and opens Bitbucket Cloud pull requests.
Tickets that depend on each other become stacked PRs. Jira follows along.

```
Jira tickets ─> board ─> dependency graph ─> run
                                              │  per ticket: developer ─> reviewers ─> remediation
                                              ▼
                              push + Bitbucket PR (stacked when tickets depend on each other)
                                              ▼
                              Jira status + comment, PR tracking until merged
```

## What it will and won't do

- Agents write code and report through the `collie` command. **Agents never push, open PRs,
  touch Jira or start other agents.** The controller does all of that.
- Nothing is treated as done because a process exited or a terminal went idle. Only an accepted
  `collie done` completes an execution.
- Jira and Bitbucket tokens come from the macOS keychain at the moment of use. They are never
  written to events, logs, state files, agent environments or git remotes.
- Collie opens PRs. It does not merge them, and it does not rebase stacked PRs for you.

## Status

Phases 0 to 7 of [`docs/plan.md`](docs/plan.md) are built. The automated suite runs against fake
`hc`, fake agents and recorded Jira and Bitbucket exchanges. The MVP also has to pass a manual run
on a real Herdr, Jira project and Bitbucket repository:
[`docs/manual-acceptance.md`](docs/manual-acceptance.md).

## Get started

See [`docs/setup.md`](docs/setup.md): requirements, the keychain items, `make install`, and your
first board.

```sh
make install                                   # builds and installs collie, the controller and the mod
herdr-app do tab.new --name Collie --mod collie  # opens Collie; starts the controller if needed
```

## Repository layout

| Path | What |
| --- | --- |
| `packages/schema` | Types and validators for every file and event: the single source of truth for contracts |
| `packages/board` | Pure board logic: Jira links, graph, readiness, scheduling, layout, run metrics |
| `packages/cli` | The `collie` binary agents use, plus `collie ctl` for control commands |
| `packages/controller` | The controller process, harness adapters and templates |
| `mod/` | The Herdr mod |
| `fixtures/` | Valid and invalid events, sample runs, recorded HTTP |
| `tools/fake-hc`, `tools/fake-agent` | Stand-ins for `hc` and a real agent, used by the tests |
| `docs/` | Plan, protocol, hand-off reports, ADRs, the Herdr API snapshot |

## Working on it

```sh
make check    # lint, typecheck and every test: must be green before a PR
make test     # tests only
make build    # dist/collie and dist/collie-controller
```

The stack is TypeScript on Bun, with Biome for lint. Start with [`CLAUDE.md`](CLAUDE.md): it lists
the docs to read and the rules that are easy to break. The contracts are in
[`docs/protocol.md`](docs/protocol.md), and each finished phase has a report in
[`docs/handoff/`](docs/handoff/).
