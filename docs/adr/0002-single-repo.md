# 0002 · One repository for every part

Status: accepted, 2026-11-09

## Decision

One repository with Bun workspaces: `packages/schema`, `packages/cli`,
`packages/controller`, `mod/`, `fixtures/` and `tools/` (`fake-hc`, `fake-agent`).

## Consequences

- A contract changes in one commit with its schema, fixtures, `docs/protocol.md` and every
  user.
- The CLI and controller always ship from the same commit, so the controller only needs to
  reject an unknown major `v`, never negotiate versions.
- One `make check` covers everything.

## Alternative

Separate repositories per part: independent releases, but cross-repo contract changes and
version skew between the CLI an agent runs and the controller reading its inbox.
