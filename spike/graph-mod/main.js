// Throwaway spike (Phase 0, experiment 4): can gpui-kit draw Collie's dependency graph?
// 20 hardcoded ticket nodes in 5 layers, bezier edges with arrowheads via window.paint_path,
// one dashed external-blocker edge, a critical-path highlight, click-to-select, 2-axis scrolling.
import { View, div, PathBuilder } from "gpui-kit";
import { theme } from "herdr";

const NODE_W = 170, NODE_H = 58, COL_GAP = 270, ROW_GAP = 96, PAD = 40;

// layer -> tickets. EXT-9 is an external blocker (not on the board).
const LAYERS = [
  ["EXT-9", "PAY-101", "PAY-102", "PAY-103"],
  ["PAY-104", "PAY-105", "PAY-106", "PAY-107", "PAY-108"],
  ["PAY-109", "PAY-110", "PAY-111", "PAY-112", "PAY-113"],
  ["PAY-114", "PAY-115", "PAY-116", "PAY-117"],
  ["PAY-118", "PAY-119"],
]; // 1 external + 20 board tickets would be 21; EXT-9 replaces one, so 20 nodes total.
const STATE = {
  "PAY-101": "done", "PAY-102": "done", "PAY-103": "working", "PAY-104": "done", "PAY-105": "working",
  "PAY-106": "blocked", "PAY-107": "ready", "PAY-108": "working", "EXT-9": "external",
};
const EDGES = [ // [blocker, blocked]
  ["PAY-101", "PAY-104"], ["PAY-101", "PAY-105"], ["PAY-102", "PAY-105"], ["PAY-102", "PAY-106"],
  ["EXT-9", "PAY-106"], ["PAY-103", "PAY-107"], ["PAY-103", "PAY-108"],
  ["PAY-104", "PAY-109"], ["PAY-105", "PAY-110"], ["PAY-105", "PAY-111"], ["PAY-106", "PAY-111"],
  ["PAY-107", "PAY-112"], ["PAY-108", "PAY-113"], ["PAY-108", "PAY-112"],
  ["PAY-109", "PAY-114"], ["PAY-110", "PAY-115"], ["PAY-111", "PAY-115"], ["PAY-111", "PAY-116"],
  ["PAY-112", "PAY-117"], ["PAY-113", "PAY-117"],
  ["PAY-115", "PAY-118"], ["PAY-116", "PAY-118"], ["PAY-117", "PAY-119"], ["PAY-114", "PAY-119"],
];
const CRITICAL = new Set(["PAY-102>PAY-105", "PAY-105>PAY-111", "PAY-111>PAY-115", "PAY-115>PAY-118"]);
const CRITICAL_NODES = new Set(["PAY-102", "PAY-105", "PAY-111", "PAY-115", "PAY-118"]);

// Pure layout: node -> {x, y}. Columns by layer, rows centred on the tallest layer.
function layout() {
  const tallest = Math.max(...LAYERS.map((l) => l.length));
  const pos = {};
  LAYERS.forEach((layer, li) => {
    const offset = ((tallest - layer.length) * ROW_GAP) / 2;
    layer.forEach((id, ri) => { pos[id] = { x: PAD + li * COL_GAP, y: PAD + offset + ri * ROW_GAP }; });
  });
  return { pos, width: PAD * 2 + (LAYERS.length - 1) * COL_GAP + NODE_W, height: PAD * 2 + (tallest - 1) * ROW_GAP + NODE_H };
}

export default class SpikeGraph extends View {
  init() {
    this.selected = null;
    this.g = layout();
    this.lastRenderMs = 0;
  }

  edgePath(builder, a, b) {
    const p = this.g.pos[a], q = this.g.pos[b];
    const x1 = p.x + NODE_W, y1 = p.y + NODE_H / 2, x2 = q.x - 8, y2 = q.y + NODE_H / 2, mx = (x1 + x2) / 2;
    return builder.move_to(x1, y1).cubic_bezier_to(x2, y2, mx, y1, mx, y2);
  }

  arrow(builder, b) {
    const q = this.g.pos[b], x = q.x, y = q.y + NODE_H / 2;
    return builder.add_polygon([[x - 9, y - 5], [x, y], [x - 9, y + 5]], true);
  }

  render(cx) {
    const t0 = Date.now();
    const t = theme();
    const sel = this.selected;
    const touches = (e) => sel && (e[0] === sel || e[1] === sel);
    // Group edges by style so each style is one path (fewer native elements).
    const groups = { normal: [], critical: [], selected: [], external: [] };
    for (const e of EDGES) {
      const key = `${e[0]}>${e[1]}`;
      if (touches(e)) groups.selected.push(e);
      else if (e[0].startsWith("EXT-")) groups.external.push(e);
      else if (CRITICAL.has(key)) groups.critical.push(e);
      else groups.normal.push(e);
    }
    const styles = {
      normal: { color: t.border, width: 1.5 },
      critical: { color: t.blocked, width: 2.5 },
      selected: { color: t.accent, width: 3 },
      external: { color: t.muted, width: 1.5, dash: [6, 4] },
    };
    const edgeLayers = [];
    for (const [name, list] of Object.entries(groups)) {
      if (!list.length) continue;
      const st = styles[name];
      let line = PathBuilder.stroke(st.width);
      if (st.dash) line = line.dash_array(st.dash);
      let head = PathBuilder.fill();
      for (const [a, b] of list) { line = this.edgePath(line, a, b); head = this.arrow(head, b); }
      edgeLayers.push(window.paint_path(line.build(), st.color).absolute().left(0).top(0).w(this.g.width).h(this.g.height));
      edgeLayers.push(window.paint_path(head.build(), st.color).absolute().left(0).top(0).w(this.g.width).h(this.g.height));
    }
    // Corner marker: tells us whether path coordinates are element-local (it sits at the canvas's top-left).
    const marker = window.paint_path(PathBuilder.fill().add_polygon([[0, 0], [14, 0], [0, 14]], true).build(), t.accent)
      .absolute().left(0).top(0).w(this.g.width).h(this.g.height);

    const stateColor = (s) => ({ done: t.done, working: t.working, blocked: t.blocked, ready: t.accent, external: t.muted }[s] ?? t.idle);
    const nodes = Object.entries(this.g.pos).map(([id, p]) => {
      const s = STATE[id] ?? "waiting";
      const isSel = id === sel, ext = id.startsWith("EXT-");
      return div().id(`n-${id}`).absolute().left(p.x).top(p.y).w(NODE_W).h(NODE_H)
        .bg(ext ? t.canvas : t.surface).rounded(8).border(isSel ? 2 : 1)
        .border_color(isSel ? t.accent : CRITICAL_NODES.has(id) ? t.blocked : t.border)
        .when(ext, (el) => el.border_dashed())
        .px(10).py(6).cursor_pointer().hover((h) => h.bg(t.hover))
        .on_click((_e, cx) => { this.selected = this.selected === id ? null : id; cx.notify(); })
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(id))
        .child(div().flex().items_center().gap(6).text_size(11).text_color(t.muted)
          .child(div().w(8).h(8).rounded(4).bg(stateColor(s)))
          .child(ext ? "external blocker" : s)
          .when(id === "PAY-105" || id === "PAY-108", (el) => el.child(div().px(4).rounded(4).bg(t.raised).child("dev"))));
    });

    const canvas = div().relative().flex_none().w(this.g.width).h(this.g.height)
      .child(marker).children(edgeLayers).children(nodes);

    this.lastRenderMs = Date.now() - t0;
    return div().id("root").size_full().flex().flex_col().bg(t.canvas)
      .child(div().flex().gap(12).px(12).py(6).text_size(12).text_color(t.muted).border_b(1).border_color(t.border)
        .child(`Collie graph spike · ${Object.keys(this.g.pos).length} nodes · ${EDGES.length} edges`)
        .child(sel ? `selected: ${sel}` : "click a node")
        .child(`build ${this.lastRenderMs} ms`))
      .child(div().id("scroller").flex_1().overflow_scrollbar().child(canvas));
  }
}
