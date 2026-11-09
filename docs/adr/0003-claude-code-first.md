# 0003 · Claude Code is the only harness until Phase 7

Status: accepted, 2026-11-09

## Context

Each harness has its own quirks: how it takes a first message, how Herdr detects that its
turn ended, how it treats text typed mid-turn. The Phase 0 spike measured these for Claude
Code (`docs/spike.md` 1–3).

## Decision

The MVP ships one harness adapter, `claude-code`. A second harness arrives in Phase 7,
behind the same adapter interface.

## Consequences

The adapter carries the spike's findings:

- resolve `claude` to an absolute path, because `hc run` doesn't expand shell aliases;
- set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, or the turn ends while a backgrounded
  command still runs and hc reports `done` early;
- put the first message before any options, because variadic options such as
  `--allowedTools` silently swallow a trailing prompt.

## Alternative

Every harness from Phase 4: wider reach, but several sets of quirks before the core loop is
proven.
