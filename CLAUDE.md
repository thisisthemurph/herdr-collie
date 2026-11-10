# Herdr Collie

Collie is a Herdr mod plus a background controller that delivers a set of Jira
tickets with coordinated AI agents. You import tickets into a board, Collie
works out their dependencies, then runs a developer agent per ready ticket in
its own worktree and Herdr terminal, reviews the work with parallel reviewer
agents, remediates findings, and opens Bitbucket Cloud pull requests.

This repo is built in phases by agents like you. Read this file first, every
session.

## Read before you write code

| Doc | What it's for                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- |----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `docs/plan.md` | The phases, what each one builds, and its "Done when" checks. Your scope comes from here.                                                                                                                                                                                                                                                                                                                            |
| `docs/protocol.md` | The contracts: storage layout, event envelope, agent events, controller events, `ctl` commands, data shapes, state machines, agent templates, retention.                                                                                                                                                                                                                                                             |
| `docs/handoff/` | One report per finished phase. Read all of them; they record decisions and deviations the plan doesn't.                                                                                                                                                                                                                                                                                                              |
| `docs/spike.md` | Results of the Phase 0 spike. Where it contradicts the plan, the spike wins until the plan is updated.                                                                                                                                                                                                                                                                                                               |
| `docs/adr/` | Architecture decision records.                                                                                                                                                                                                                                                                                                                                                                                       |
| `docs/herdr/` | A pinned snapshot of Herdr: `AGENTS.md`, `herdr.d.ts`, `gpui-kit.d.ts`, `hc-skill.md` (output of `hc --skill`), `commands.json` (output of `herdr-app commands`) and `VERSION`. The only source of truth for Herdr and herdr-core APIs. Never guess an API that isn't in these files. If live `hc` or Herdr behaves differently, report it rather than coding around it; the snapshot is re-synced in its own commit. |
| `docs/wireframes/` | One PNG per screen. Layout and content guide the mod; exact styling doesn't.                                                                                                                                                                                                                                                                                                                                         |

If two docs disagree, the order of authority is: latest hand-off report, then
`docs/spike.md`, then `docs/protocol.md`, then `docs/plan.md`. Note the
conflict in your hand-off report.

## How to work a phase

1. You are given a phase number. Build only what that phase lists under
   **Builds**. Respect its **Not in this phase** list.
2. Every **Done when** item maps to at least one automated test, or to a demo
   step when it genuinely needs real Herdr, Jira or Bitbucket.
3. When the spec is ambiguous, take the simplest reading that fits the
   protocol, mark it in code with a `DECISION:` comment, and list it in your
   hand-off report. Stop and ask only when a choice can't be undone cheaply,
   such as a breaking schema change or anything that touches real external
   data.
4. Anything useful but out of scope goes in the hand-off report as a
   suggestion, not into the code.
5. Finish with `make check` green, then write `docs/handoff/phase-N.md` and
   open a PR.

**Hand-off report contents:** what was built; deviations from the docs and
why; every `DECISION:`; known gaps; exact commands to run the phase demo.

## Repo layout

```
packages/schema/       types + runtime validators for every contract
packages/board/        pure board logic: Jira links, graph, cycles, readiness, layout
packages/cli/          the `collie` binary (agent commands + `collie ctl`)
packages/controller/   the controller process, harness adapters, templates
mod/                   the Herdr mod (UI)
fixtures/              valid/invalid events, sample runs, recorded HTTP
tools/fake-hc/         `hc` shim driven by scenario files
tools/fake-agent/      scripted stand-in for a real harness
docs/                  see above
```

Stack: TypeScript on Bun. The CLI is compiled to a single binary. The mod uses
Herdr's mod APIs and gpui-kit only.

## Rules that are easy to break

**Contracts**
- `packages/schema` is the single source of truth for every file and event
  shape. Never define a contract type anywhere else.
- Changing a contract means: update the schema, update fixtures, update
  `docs/protocol.md`, and call it out in the hand-off report. Additive,
  optional fields don't bump `v`; anything else does.

**State**
- The controller is the only writer of everything under `~/.collie` except
  agent inboxes. The CLI only appends to the inbox named by `COLLIE_INBOX`.
- `events.jsonl` is the truth; `state.json` must always be rebuildable from it.
  Every state change is an event first.
- Every JSON file write is atomic: write a temp file, then rename.
- Only transitions listed in the protocol's state machines are legal. Anything
  else is rejected, never silently applied.

**Agents and Herdr**
- Never treat a process exit or an idle terminal as success. Only an accepted
  `done` completes an execution.
- Never type into a working agent. Answers and nudges go through `hc send`
  only when the agent is idle.
- Agents never push, open PRs, touch Jira or start other agents. The
  controller does all of that.

**Secrets**
- Jira and Bitbucket tokens come from the OS keychain at the moment of use.
  They must never appear in events, logs, state files, agent environments,
  command lines visible in `ps`, or saved Git remote URLs.
- Never commit a real token, a real Jira site or a real repository name. Use
  placeholders like `[SITE]`, `[WORKSPACE]` and `[REPO]` in fixtures.

**Tests**
- Tests never hit the network or real Herdr. Use `tools/fake-hc`,
  `tools/fake-agent` and recorded HTTP fixtures.
- Tests that need real Herdr, Claude Code, Jira or Bitbucket are opt-in and
  skipped by default, and say how to run them.

## Commands

Phase 0 sets these up; keep them working in every phase.

- `make check`: lint, typecheck and all tests. Must be green before a PR.
- `make test`: tests only.
- `make build`: builds the `collie` binary and the controller.

If a command you need doesn't exist yet and your phase is the right place for
it, add it to the Makefile and mention it in your hand-off report.

## Style

- Small modules with one job. Pure functions for anything that can be pure
  (readiness, scheduling, graph layout, state reduction), so they're easy to
  unit test.
- Errors from the CLI tell an agent exactly what to change. Errors from the
  controller name the rule that was broken.
- No new dependencies without a line in the hand-off report saying why.
