# 0006 · Test against a fake `hc` and a fake agent

Status: accepted, 2026-11-09

## Decision

Tests never touch real Herdr or a model. `tools/fake-hc` stands in for `hc` (run, send,
wait, get, ls, label, kill, rm) and plays back a scripted status sequence per terminal.
`tools/fake-agent` stands in for a harness and runs `collie` commands from a scenario.
Tests needing real Herdr, Claude Code, Jira or Bitbucket are opt-in and skipped by default.

## Consequences

- Most phases are testable in CI in seconds.
- fake-hc copies real hc's output shapes, error kinds and exit codes. Its tests compare
  against recordings of real hc in `fixtures/hc/`, which must be re-recorded whenever
  `docs/herdr/` is re-synced.
- With `"spawn": true`, fake-hc really runs fake-agent and passes it `hc send` messages, so
  end-to-end tests cover the whole loop: launch, report, ask, answer, done.
- The fakes can drift from real behaviour; the opt-in real-hc tests and phase gates catch
  that.

## Alternative

Real hc only: highest fidelity, but slow, flaky and impossible in CI.
