// A layered, left-to-right layout of a board's dependency graph. Pure: board in, geometry
// out, so it is unit-tested apart from rendering (docs/plan.md, Phase 3).
//
// 1. Layers: longest path from the sources, so every edge points right.
// 2. An edge spanning several layers gets an empty "dummy" slot in each layer it crosses, and
//    is routed through them. Between columns an edge is a curve that stays inside the gap; in a
//    column it runs straight through its own empty slot. So no edge can cross a node.
// 3. Order within each layer: barycenter sweeps, to cut crossings.
// 4. In a cycle, the edges that close it are laid out reversed, then drawn the right way.
import type { Board } from "@collie/schema";
import { edges as boardEdges, criticalPath } from "./graph.ts";

export const NODE_W = 180;
export const NODE_H = 56;
export const GAP_X = 96;
export const GAP_Y = 22;
export const PAD = 32;

export type Point = { x: number; y: number };
/** A curve between columns (control points at mid x) or a straight run through a column. */
export type Segment = { kind: "curve" | "line"; from: Point; to: Point };

export type LayoutNode = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  external: boolean;
};
export type LayoutEdge = {
  from: string;
  to: string;
  segments: Segment[];
  external: boolean;
  overridden: boolean;
  critical: boolean;
  /** Drawn right to left: it closes a cycle. */
  back: boolean;
};
export type Layout = { nodes: LayoutNode[]; edges: LayoutEdge[]; width: number; height: number };

type Slot = { id: string; real: boolean };

export function layout(board: Pick<Board, "tickets" | "overrides" | "settings">): Layout {
  const all = boardEdges(board);
  const keys = new Set<string>();
  for (const [k, t] of Object.entries(board.tickets)) if (t.on_board) keys.add(k);
  for (const e of all) keys.add(e.from);
  const sorted = [...keys].sort();
  const external = (k: string) => !board.tickets[k]?.on_board;

  // Back edges (closing a cycle), found by DFS in key order, are reversed for layering.
  const out = new Map<string, string[]>(sorted.map((k) => [k, []]));
  for (const e of all) out.get(e.from)?.push(e.to);
  const back = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const dfs = (v: string) => {
    state.set(v, 1);
    for (const w of [...(out.get(v) ?? [])].sort()) {
      if (state.get(w) === 1) back.add(`${v}>${w}`);
      else if (!state.has(w)) dfs(w);
    }
    state.set(v, 2);
  };
  for (const k of sorted) if (!state.has(k)) dfs(k);
  const dir = all.map((e) =>
    back.has(`${e.from}>${e.to}`)
      ? { ...e, u: e.to, v: e.from, back: true }
      : { ...e, u: e.from, v: e.to, back: false },
  );

  // 1. Layers by longest path.
  const preds = new Map<string, string[]>(sorted.map((k) => [k, []]));
  for (const e of dir) preds.get(e.v)?.push(e.u);
  const layerOf = new Map<string, number>();
  const layerFor = (k: string, seen = new Set<string>()): number => {
    const known = layerOf.get(k);
    if (known !== undefined) return known;
    if (seen.has(k)) return 0; // unreachable after back-edge removal; a guard only
    seen.add(k);
    const ps = preds.get(k) ?? [];
    const l = ps.length ? Math.max(...ps.map((p) => layerFor(p, seen))) + 1 : 0;
    layerOf.set(k, l);
    return l;
  };
  for (const k of sorted) layerFor(k);
  const depth = Math.max(0, ...layerOf.values()) + 1;

  // 2. Dummy slots for long edges.
  const layers: Slot[][] = Array.from({ length: depth }, () => []);
  for (const k of sorted) layers[layerOf.get(k) as number]?.push({ id: k, real: true });
  const chains = dir.map((e, i) => {
    const lu = layerOf.get(e.u) as number;
    const lv = layerOf.get(e.v) as number;
    const chain = [e.u];
    for (let l = lu + 1; l < lv; l++) {
      const id = `~${i}:${l}`;
      layers[l]?.push({ id, real: false });
      chain.push(id);
    }
    chain.push(e.v);
    return { e, chain };
  });
  const adjUp = new Map<string, string[]>();
  const adjDown = new Map<string, string[]>();
  for (const { chain } of chains) {
    for (let i = 0; i + 1 < chain.length; i++) {
      const a = chain[i] as string;
      const b = chain[i + 1] as string;
      adjDown.set(a, [...(adjDown.get(a) ?? []), b]);
      adjUp.set(b, [...(adjUp.get(b) ?? []), a]);
    }
  }

  // 3. Barycenter ordering: sweep right using predecessors, then left using successors.
  const pos = new Map<string, number>();
  const index = () => {
    for (const layer of layers) {
      for (const [i, s] of layer.entries()) pos.set(s.id, i);
    }
  };
  index();
  const bary = (id: string, adj: Map<string, string[]>) => {
    const ns = adj.get(id) ?? [];
    return ns.length ? ns.reduce((sum, n) => sum + (pos.get(n) ?? 0), 0) / ns.length : (pos.get(id) ?? 0);
  };
  for (let sweep = 0; sweep < 6; sweep++) {
    const down = sweep % 2 === 0;
    const order = down
      ? layers.map((_, i) => i).slice(1)
      : layers
          .map((_, i) => i)
          .reverse()
          .slice(1);
    for (const l of order) {
      const layer = layers[l] as Slot[];
      const b = new Map(layer.map((s) => [s.id, bary(s.id, down ? adjUp : adjDown)]));
      layer.sort((x, y) => (b.get(x.id) as number) - (b.get(y.id) as number) || x.id.localeCompare(y.id));
      for (const [i, s] of layer.entries()) pos.set(s.id, i);
    }
  }

  // Coordinates: columns by layer; slots stacked, each layer centered on the tallest.
  const tallest = Math.max(1, ...layers.map((l) => l.length));
  const colX = (l: number) => PAD + l * (NODE_W + GAP_X);
  const slotY = new Map<string, number>();
  layers.forEach((layer) => {
    const offset = ((tallest - layer.length) * (NODE_H + GAP_Y)) / 2;
    for (const [i, s] of layer.entries()) slotY.set(s.id, PAD + offset + i * (NODE_H + GAP_Y));
  });
  const layerOfSlot = (id: string) =>
    id.startsWith("~") ? Number(id.split(":")[1]) : (layerOf.get(id) as number);

  const nodes: LayoutNode[] = sorted.map((k) => ({
    key: k,
    x: colX(layerOf.get(k) as number),
    y: slotY.get(k) as number,
    w: NODE_W,
    h: NODE_H,
    layer: layerOf.get(k) as number,
    external: external(k),
  }));

  const crit = criticalPath(board);
  const critPairs = new Set(crit.slice(1).map((k, i) => `${crit[i]}>${k}`));
  const mid = (id: string) => (slotY.get(id) as number) + NODE_H / 2;
  const edgesOut: LayoutEdge[] = chains.map(({ e, chain }) => {
    const segments: Segment[] = [];
    let at: Point = { x: colX(layerOfSlot(chain[0] as string)) + NODE_W, y: mid(chain[0] as string) };
    for (let i = 1; i < chain.length; i++) {
      const id = chain[i] as string;
      const x = colX(layerOfSlot(id));
      const y = mid(id);
      segments.push({ kind: "curve", from: at, to: { x, y } });
      if (i < chain.length - 1) {
        segments.push({ kind: "line", from: { x, y }, to: { x: x + NODE_W, y } });
        at = { x: x + NODE_W, y };
      }
    }
    // A reversed (back) edge runs u -> v on screen; flip it so it reads blocker -> blocked.
    const drawn = e.back
      ? segments.reverse().map((s) => ({ kind: s.kind, from: s.to, to: s.from }))
      : segments;
    return {
      from: e.from,
      to: e.to,
      segments: drawn,
      external: e.external,
      overridden: e.overridden,
      critical: critPairs.has(`${e.from}>${e.to}`),
      back: e.back,
    };
  });

  return {
    nodes,
    edges: edgesOut,
    width: PAD * 2 + depth * NODE_W + (depth - 1) * GAP_X,
    height: PAD * 2 + tallest * NODE_H + (tallest - 1) * GAP_Y,
  };
}

/** Points along a segment, for drawing checks and hit tests. */
export function samplePoints(s: Segment, steps = 24): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (s.kind === "line") {
      pts.push({ x: s.from.x + (s.to.x - s.from.x) * t, y: s.from.y + (s.to.y - s.from.y) * t });
    } else {
      // Cubic Bezier with control points (mx, y1) and (mx, y2): the curve the mod draws.
      const mx = (s.from.x + s.to.x) / 2;
      const u = 1 - t;
      const x = u * u * u * s.from.x + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * s.to.x;
      const y = u * u * u * s.from.y + 3 * u * u * t * s.from.y + 3 * u * t * t * s.to.y + t * t * t * s.to.y;
      pts.push({ x, y });
    }
  }
  return pts;
}
