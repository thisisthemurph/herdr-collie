// Done when: layout unit tests place every fixture board with no overlapping nodes and no
// edge crossing a node.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "@collie/schema";
import { type Layout, layout, NODE_H, NODE_W, samplePoints } from "../src/index.ts";

const BOARDS = join(import.meta.dir, "../../../fixtures/boards");
const boards = readdirSync(BOARDS)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map(
    (f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(join(BOARDS, f), "utf8")) as Board] as const,
  );

const inside = (p: { x: number; y: number }, n: Layout["nodes"][number], margin = 1) =>
  p.x > n.x + margin && p.x < n.x + n.w - margin && p.y > n.y + margin && p.y < n.y + n.h - margin;

test("there are fixture boards to check", () => expect(boards.length).toBeGreaterThanOrEqual(10));

describe.each(boards)("%s", (_name, board) => {
  const l = layout(board);

  test("every on-board ticket and every blocker it names has a node", () => {
    const expected = new Set(
      Object.entries(board.tickets)
        .filter(([, t]) => t.on_board)
        .map(([k]) => k),
    );
    for (const t of Object.values(board.tickets))
      if (t.on_board) for (const b of t.blocked_by) if (board.tickets[b]) expected.add(b);
    expect(l.nodes.map((n) => n.key).sort()).toEqual([...expected].sort());
  });

  test("no two nodes overlap", () => {
    for (const [i, a] of l.nodes.entries()) {
      for (const b of l.nodes.slice(i + 1)) {
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.key} and ${b.key} overlap`).toBe(true);
      }
    }
  });

  test("no edge crosses a node other than its own two", () => {
    for (const e of l.edges) {
      for (const seg of e.segments) {
        for (const p of samplePoints(seg, 40)) {
          for (const n of l.nodes) {
            if (n.key === e.from || n.key === e.to) continue;
            expect(
              inside(p, n),
              `${e.from} -> ${e.to} crosses ${n.key} at (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`,
            ).toBe(false);
          }
        }
      }
    }
  });

  test("each edge leaves its blocker's right side and enters the blocked ticket's left side", () => {
    const at = new Map(l.nodes.map((n) => [n.key, n]));
    for (const e of l.edges) {
      const from = at.get(e.from);
      const to = at.get(e.to);
      if (!from || !to) throw new Error(`edge ${e.from} -> ${e.to} has no node`);
      const first = e.segments[0]?.from;
      const last = e.segments.at(-1)?.to;
      if (e.back) {
        // A cycle-closing edge runs right to left: it leaves the blocker's left side.
        expect(first).toEqual({ x: from.x, y: from.y + NODE_H / 2 });
        expect(last).toEqual({ x: to.x + NODE_W, y: to.y + NODE_H / 2 });
      } else {
        expect(first).toEqual({ x: from.x + NODE_W, y: from.y + NODE_H / 2 });
        expect(last).toEqual({ x: to.x, y: to.y + NODE_H / 2 });
        expect(to.layer).toBeGreaterThan(from.layer);
      }
      // Segments join up.
      for (let i = 1; i < e.segments.length; i++)
        expect(e.segments[i]?.from).toEqual(e.segments[i - 1]?.to as never);
    }
  });

  test("everything fits inside the canvas", () => {
    for (const n of l.nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w).toBeLessThanOrEqual(l.width);
      expect(n.y + n.h).toBeLessThanOrEqual(l.height);
    }
  });

  test("is deterministic", () => {
    expect(layout(structuredClone(board))).toEqual(l);
  });
});

test("long edges route through empty slots, so the spike graph keeps its 24 edges", () => {
  const spike = boards.find(([n]) => n === "spike-20")?.[1] as Board;
  const l = layout(spike);
  expect(l.nodes).toHaveLength(20);
  expect(l.edges).toHaveLength(24);
  expect(l.edges.filter((e) => e.external).map((e) => `${e.from}>${e.to}`)).toEqual(["EXT-9>PAY-106"]);
});

test("the cycle board marks the edge that closes the cycle", () => {
  const cycle = boards.find(([n]) => n === "cycle")?.[1] as Board;
  expect(layout(cycle).edges.filter((e) => e.back).length).toBe(1);
});
