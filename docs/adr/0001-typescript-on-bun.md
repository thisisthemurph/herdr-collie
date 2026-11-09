# 0001 · TypeScript on Bun for the CLI and controller

Status: accepted, 2026-11-09 (decisions table in `docs/plan.md`)

## Context

Collie has three parts: the `collie` CLI that agents call, the controller, and the Herdr
mod. Herdr mods are JavaScript. Every part reads and writes the same files and events.

## Decision

Write the CLI and controller in TypeScript on Bun. Compile the CLI to a single binary with
`bun build --compile`. Contracts live once, in `packages/schema`, as TypeScript types plus
runtime validators.

## Consequences

- The mod, CLI and controller share one set of contract types; nothing is generated twice.
- `packages/schema` has no runtime dependencies (its validators are hand-written), so the
  mod can bundle it as plain JS.
- Tooling: Bun's test runner, `tsc --noEmit` for types, Biome for lint and format.
- Developers and CI need Bun installed (`brew install oven-sh/bun/bun`, or the
  `oven/bun` image).

## Alternative

Go: a fast static CLI, but the types would live in JSON Schema and be generated for both Go
and the mod.
