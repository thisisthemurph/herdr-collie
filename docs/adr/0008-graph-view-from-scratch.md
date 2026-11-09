# 0008 · Build the dependency graph view from scratch

Status: accepted, 2026-11-09

## Decision

The Collie mod draws its own dependency graph: a layered layout, critical-path highlight,
external blockers, and Collie's ticket states and agent chips.

## Consequences

- The spike (`docs/spike.md` 4) drew 20 nodes with bezier edges, arrowheads, a dashed
  external edge, selection and two-axis scrolling with gpui-kit's `paint_path`. It was
  judged good enough for the MVP.
- Layout is a pure function, so it is unit-tested (no overlaps, no edge crossing a node)
  without Herdr.
- Drag-to-pan is deferred until after the MVP; scrolling works.

## Alternative

Reuse an existing DAG mod: less code, but not designed around Collie's states.
