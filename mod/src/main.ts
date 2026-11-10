// The Collie mod: the Collie tab (header, view tabs), Board setup and the dependency graph.
// It holds no state of its own beyond what's on screen: boards come from ~/.collie, changes go
// through `collie ctl`, and the folder watch redraws it, so reloading the mod loses nothing.

import type { Board } from "@collie/schema";
import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { div, PathBuilder, View } from "gpui-kit";
import { props as herdrProps, theme, watchFolder } from "herdr";
import { collieHome, controllerAlive, ctl, ensureController, loadBoards } from "./collie.ts";
import {
  type Action,
  type BoardModel,
  boardModel,
  describeReply,
  type ExternalRow,
  excludeAction,
  externalActions,
  nextPreparation,
  parseImport,
  type TicketRow,
} from "./model.ts";

type Screen = "setup" | "graph" | "new";
/** Herdr's theme colors are hex strings; gpui-kit types colors as `#...`. */
type Theme = Record<string, `#${string}`>;
const colors = () => theme() as unknown as Theme;
// biome-ignore lint/suspicious/noExplicitAny: gpui-kit elements share no exported base type.
type El = any;

const READINESS_LABEL: Record<string, string> = {
  ready: "Ready",
  blocked: "Blocked",
  pending: "Not prepared",
  excluded: "Excluded",
};

export default class Collie extends View {
  boards: Board[] = [];
  boardId: string | null = null;
  screen: Screen = "setup";
  selected: string | null = null;
  message: { text: string; error: boolean } | null = null;
  busy = false;
  alive = false;
  importBox!: InputState;
  fields!: Record<string, InputState>;

  init(_initArg: unknown, cx: El) {
    // Where you were: the last screen, board and selection, so reloading the mod puts you back.
    // Props win (open a tab straight on the graph: `tab.new --mod collie --props '{"screen":"graph"}'`).
    // FINDING: init's first argument is undefined for a tab mod, contrary to docs/herdr/AGENTS.md;
    // the props are only reachable through props().
    const props = (herdrProps() ?? {}) as { screen?: Screen; board?: string; selected?: string };
    const saved = this.recall();
    this.screen = props.screen ?? saved.screen ?? "setup";
    this.boardId = props.board ?? saved.board ?? null;
    this.selected = props.selected ?? saved.selected ?? null;
    this.importBox = InputState.new({ placeholder: "Issue keys (PAY-1, PAY-2) or JQL, then Import" });
    this.importBox.on("submit", (_e, cx) => this.doImport(cx));
    this.fields = {
      name: InputState.new({ placeholder: "Board name, e.g. Payments API – Q4" }),
      site: InputState.new({ placeholder: "Jira site, e.g. example.atlassian.net" }),
      project: InputState.new({ placeholder: "Jira project key, e.g. PAY" }),
      workspace: InputState.new({ placeholder: "Bitbucket workspace" }),
      slug: InputState.new({ placeholder: "Repository slug" }),
      branch: InputState.new({ placeholder: "Default branch", value: "main" }),
      path: InputState.new({ placeholder: "Local checkout, e.g. ~/code/payments" }),
    };
    cx.spawn(async (cx: El) => {
      const err = await ensureController();
      if (err) this.message = { text: err, error: true };
      await this.reload();
      cx.notify();
      this.watch(cx);
    });
    // The lock can vanish without a change we'd notice soon, and ~/.collie may not exist yet
    // when the tab opens (the controller makes it): check gently, and (re)start the watch.
    cx.timer.every(3_000, (cx: El) => {
      cx.spawn(async (cx: El) => {
        const alive = await controllerAlive();
        const wasAlive = this.alive;
        this.alive = alive;
        if (wasAlive && !alive) {
          // DECISION: restart a controller that dies while the tab is open, once. If that fails
          // (collie-controller not on PATH, say) the message and the Start button take over.
          this.message = { text: "The controller stopped; restarting it…", error: false };
          const err = await ensureController();
          if (err) this.message = { text: err, error: true };
        }
        if (!this.watching) {
          await this.reload();
          this.watch(cx);
          cx.notify();
        } else if (wasAlive !== alive) cx.notify();
      });
    });
  }

  watching = false;
  private remembered = "";

  /** The saved screen, board and selection (localStorage is per viewer; it may be unavailable). */
  recall(): { screen?: Screen; board?: string; selected?: string } {
    try {
      return JSON.parse(localStorage.getItem("collie.view") ?? "{}");
    } catch {
      return {};
    }
  }

  remember() {
    const now = JSON.stringify({
      screen: this.screen === "new" ? "setup" : this.screen,
      board: this.boardId,
      selected: this.selected,
    });
    if (now === this.remembered) return;
    this.remembered = now;
    try {
      localStorage.setItem("collie.view", now);
    } catch {}
  }

  /** Redraws on any change under ~/.collie: board edits, runs, the lock. */
  watch(cx: El) {
    if (this.watching) return;
    this.watching = true;
    cx.spawn(async (cx: El) => {
      for (;;) {
        try {
          await watchFolder(collieHome());
        } catch {
          // Missing folder, or a watch the OS refused: the timer above polls and retries.
          this.watching = false;
          return;
        }
        await this.reload();
        cx.notify();
      }
    });
  }

  async reload() {
    this.boards = await loadBoards();
    this.alive = await controllerAlive();
    if (!this.boards.some((b) => b.id === this.boardId)) this.boardId = this.boards[0]?.id ?? null;
    if (this.selected && !this.board?.tickets[this.selected]) this.selected = null;
  }

  get board(): Board | null {
    return this.boards.find((b) => b.id === this.boardId) ?? null;
  }

  /** Runs a ctl command, shows its outcome, and reloads. */
  run(cx: El, command: string, args: Record<string, unknown>, after?: (ok: boolean) => void) {
    if (this.busy) return;
    this.busy = true;
    this.message = { text: `${command}…`, error: false };
    cx.notify();
    cx.spawn(async (cx: El) => {
      const reply = await ctl(command, args);
      this.message = { text: describeReply(command, reply), error: !reply.ok };
      this.busy = false;
      if (reply.ok && command === "board.create")
        this.boardId = String(reply.result?.board_id ?? this.boardId);
      await this.reload();
      after?.(reply.ok);
      cx.notify();
    });
  }

  doImport(cx: El) {
    const board = this.board;
    const what = parseImport(this.importBox.value());
    if (!board || !what) return;
    this.run(cx, "board.import", { board_id: board.id, ...what }, (ok) => {
      if (ok) this.importBox.set_value("");
    });
  }

  // --- rendering

  render(_cx: El) {
    this.remember();
    const t = colors();
    const board = this.board;
    const model = board ? boardModel(board) : null;
    return v_flex()
      .id("root")
      .size_full()
      .bg(t.canvas)
      .text_color(t.foreground)
      .child(this.header(t))
      .child(this.tabs(t, board))
      .when(!!this.message, (el: El) =>
        el.child(
          div()
            .px(16)
            .py(6)
            .text_size(12)
            .text_color(this.message?.error ? t.blocked : t.muted)
            .child(this.message?.text ?? ""),
        ),
      )
      .child(
        div()
          .id("body")
          .flex_1()
          .min_h(0)
          .child(
            this.screen === "new" || !board || !model
              ? this.newBoard(t, !board)
              : this.screen === "graph"
                ? this.graph(t, board, model)
                : this.setup(t, board, model),
          ),
      );
  }

  header(t: Theme): El {
    return h_flex()
      .px(16)
      .py(10)
      .gap(10)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(div().text_size(15).font_semibold().child("Collie"))
      .children(
        this.boards.map((b) =>
          pill(t, `board-${b.id}`, b.name, b.id === this.boardId && this.screen !== "new", (cx: El) => {
            this.boardId = b.id;
            this.selected = null;
            if (this.screen === "new") this.screen = "setup";
            cx.notify();
          }),
        ),
      )
      .child(div().flex_1())
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .text_size(12)
          .text_color(t.muted)
          .child(
            div()
              .w(8)
              .h(8)
              .rounded(4)
              .bg(this.alive ? t.done : t.blocked),
          )
          .child(this.alive ? "Controller running" : "Controller stopped")
          .when(!this.alive, (el: El) =>
            el.child(
              button(t, "start-controller", "Start", false, (cx: El) => {
                cx.spawn(async (cx: El) => {
                  const err = await ensureController();
                  this.message = err
                    ? { text: err, error: true }
                    : { text: "Starting the controller…", error: false };
                  cx.notify();
                });
              }),
            ),
          ),
      )
      .child(
        button(t, "new-board", "New board", false, (cx: El) => {
          this.screen = "new";
          cx.notify();
        }),
      );
  }

  tabs(t: Theme, board: Board | null): El {
    const tab = (id: Screen, label: string) =>
      div()
        .id(`tab-${id}`)
        .px(12)
        .py(6)
        .text_size(13)
        .cursor_pointer()
        .border_b(2)
        .border_color(this.screen === id ? t.accent : t.canvas)
        .text_color(this.screen === id ? t.foreground : t.muted)
        .on_click((_e: unknown, cx: El) => {
          this.screen = id;
          cx.notify();
        })
        .child(label);
    return h_flex()
      .px(10)
      .gap(4)
      .border_b(1)
      .border_color(t.border)
      .when(!!board, (el: El) => el.child(tab("setup", "Board setup")).child(tab("graph", "Graph")));
  }

  setup(t: Theme, board: Board, m: BoardModel): El {
    const s = board.settings;
    return v_flex()
      .id("setup")
      .size_full()
      .overflow_y_scrollbar()
      .p(16)
      .gap(14)
      .child(
        div()
          .text_size(12)
          .text_color(t.muted)
          .child(
            `${board.jira.project} on ${board.jira.site} · repo ${board.repo.workspace}/${board.repo.slug} (${board.repo.default_branch}) · workflow ${s.workflow} · complete at ${s.complete_at} · outside blockers count when ${s.completion_policy.mode.replaceAll("_", " ")}`,
          ),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .flex_1()
              .h(30)
              .px(8)
              .rounded(6)
              .border(1)
              .border_color(t.input)
              .bg(t.surface)
              .child(Input.new(this.importBox).h_full().w_full().text_size(13)),
          )
          .child(button(t, "import", "Import", this.busy, (cx: El) => this.doImport(cx)))
          .child(
            button(t, "refresh", "Refresh from Jira", this.busy, (cx: El) =>
              this.run(cx, "board.refresh", { board_id: board.id }),
            ),
          ),
      )
      .when(m.cycles.length > 0, (el: El) =>
        el.child(
          div()
            .p(10)
            .rounded(6)
            .border(1)
            .border_color(t.blocked)
            .text_size(13)
            .text_color(t.blocked)
            .child(m.startBlocked ?? ""),
        ),
      )
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(button(t, "start-run", "Start run", true, () => {}))
          .child(
            div()
              .text_size(12)
              .text_color(t.muted)
              .child(
                m.startBlocked ??
                  `${m.counts.ready} ready · ${m.counts.blocked} blocked · ${m.counts.pending} not prepared · ${m.counts.excluded} excluded. Starting runs from Herdr arrives in Phase 4.`,
              ),
          ),
      )
      .child(section(t, `Tickets (${m.rows.length})`))
      .child(this.ticketTable(t, board, m.rows))
      .when(m.externals.length > 0, (el: El) =>
        el
          .child(section(t, `Outside blockers (${m.externals.length})`))
          .child(this.externalTable(t, board, m)),
      );
  }

  ticketTable(t: Theme, board: Board, rows: TicketRow[]): El {
    const head = h_flex()
      .gap(10)
      .px(8)
      .py(4)
      .text_size(11)
      .text_color(t.dim)
      .child(div().w(90).child("KEY"))
      .child(div().flex_1().child("SUMMARY"))
      .child(div().w(110).child("JIRA STATUS"))
      .child(div().w(120).child("PREPARATION"))
      .child(div().w(110).child("READINESS"))
      .child(div().w(200).child("BLOCKED BY"));
    return v_flex()
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .bg(t.surface)
      .child(head)
      .children(
        rows.map((r) =>
          h_flex()
            .id(`row-${r.key}`)
            .gap(10)
            .px(8)
            .py(6)
            .items_center()
            .text_size(13)
            .border_t(1)
            .border_color(t.border)
            .bg(this.selected === r.key ? t.selected : t.surface)
            .hover((h: El) => h.bg(t.hover))
            .on_click((_e: unknown, cx: El) => {
              this.selected = r.key;
              cx.notify();
            })
            .child(
              div()
                .w(90)
                .font_semibold()
                .text_color(r.critical ? t.blocked : t.foreground)
                .child(r.key),
            )
            .child(div().flex_1().min_w(0).truncate().child(r.summary))
            .child(div().w(110).text_color(t.muted).truncate().child(r.jiraStatus))
            .child(
              div()
                .w(120)
                .child(
                  pill(
                    t,
                    `prep-${r.key}`,
                    r.preparation.replaceAll("_", " "),
                    r.preparation === "ready",
                    (cx: El) =>
                      this.run(cx, "ticket.set_preparation", {
                        board_id: board.id,
                        ticket: r.key,
                        preparation: nextPreparation(r.preparation),
                      }),
                  ),
                ),
            )
            .child(div().w(110).child(readinessBadge(t, r.readiness)))
            .child(
              div()
                .w(200)
                .text_size(12)
                .text_color(t.muted)
                .truncate()
                .child(
                  r.blockers.length
                    ? r.blockers
                        .map(
                          (b) =>
                            `${b.key}${b.status === "satisfied" ? " ✓" : b.status === "overridden" ? " (overridden)" : ""}`,
                        )
                        .join(", ")
                    : "—",
                ),
            ),
        ),
      );
  }

  externalTable(t: Theme, board: Board, m: BoardModel): El {
    return v_flex()
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .bg(t.surface)
      .children(
        m.externals.map((x) =>
          h_flex()
            .id(`ext-${x.key}`)
            .gap(10)
            .px(8)
            .py(6)
            .items_center()
            .text_size(13)
            .border_b(1)
            .border_color(t.border)
            .child(div().w(90).font_semibold().child(x.key))
            .child(div().flex_1().min_w(0).truncate().child(x.summary))
            .child(
              div()
                .w(110)
                .text_color(x.satisfied ? t.done : t.muted)
                .child(x.jiraStatus),
            )
            .children(this.actionButtons(t, externalActions(board.id, x))),
        ),
      );
  }

  graph(t: Theme, board: Board, m: BoardModel): El {
    const l = m.layout;
    const sel = this.selected;
    const readinessOf = new Map(m.rows.map((r) => [r.key, r.readiness]));
    const styles = {
      normal: { color: t.border, width: 1.5, dash: null as number[] | null },
      critical: { color: t.blocked, width: 2.5, dash: null },
      external: { color: t.muted, width: 1.5, dash: [6, 4] },
      overridden: { color: t.dim, width: 1, dash: [2, 4] },
      selected: { color: t.accent, width: 3, dash: null },
    };
    const groups: Record<keyof typeof styles, typeof l.edges> = {
      normal: [],
      critical: [],
      external: [],
      overridden: [],
      selected: [],
    };
    for (const e of l.edges) {
      if (sel && (e.from === sel || e.to === sel)) groups.selected.push(e);
      else if (e.overridden) groups.overridden.push(e);
      else if (e.external) groups.external.push(e);
      else if (e.critical) groups.critical.push(e);
      else groups.normal.push(e);
    }
    const layers: El[] = [];
    const nodeAt = new Map(l.nodes.map((n) => [n.key, n]));
    for (const [name, list] of Object.entries(groups) as [keyof typeof styles, typeof l.edges][]) {
      if (!list.length) continue;
      const st = styles[name];
      let line = PathBuilder.stroke(st.width);
      if (st.dash) line = line.dash_array(st.dash);
      let head = PathBuilder.fill();
      for (const e of list) {
        for (const seg of e.segments) {
          line = line.move_to(seg.from.x, seg.from.y);
          if (seg.kind === "line") line = line.line_to(seg.to.x, seg.to.y);
          else {
            const mx = (seg.from.x + seg.to.x) / 2;
            line = line.cubic_bezier_to(seg.to.x, seg.to.y, mx, seg.from.y, mx, seg.to.y);
          }
        }
        // The arrowhead sits on the blocked ticket's edge, pointing into it.
        const end = e.segments.at(-1)?.to;
        const target = nodeAt.get(e.to);
        if (end && target) {
          const dir = e.back ? -1 : 1;
          head = head.add_polygon(
            [
              [end.x - dir * 9, end.y - 5],
              [end.x, end.y],
              [end.x - dir * 9, end.y + 5],
            ],
            true,
          );
        }
      }
      layers.push(window.paint_path(line.build(), st.color).absolute().left(0).top(0).w(l.width).h(l.height));
      layers.push(window.paint_path(head.build(), st.color).absolute().left(0).top(0).w(l.width).h(l.height));
    }
    const color = (s?: string) =>
      s === "ready" ? t.done : s === "blocked" ? t.blocked : s === "excluded" ? t.dim : t.idle;
    const nodes = l.nodes.map((n) => {
      const ticket = board.tickets[n.key];
      const isSel = n.key === sel;
      const state = readinessOf.get(n.key);
      return (
        div()
          .id(`node-${n.key}`)
          .absolute()
          .left(n.x)
          .top(n.y)
          .w(n.w)
          .h(n.h)
          .px(10)
          .py(6)
          .rounded(8)
          .bg(n.external ? t.canvas : t.surface)
          .border(isSel ? 2 : 1)
          .border_color(isSel ? t.accent : m.critical.includes(n.key) ? t.blocked : t.border)
          .when(n.external, (el: El) => el.border_dashed())
          .cursor_pointer()
          .hover((h: El) => h.bg(t.hover))
          .on_click((_e: unknown, cx: El) => {
            this.selected = this.selected === n.key ? null : n.key;
            cx.notify();
          })
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(
                div()
                  .w(8)
                  .h(8)
                  .rounded(4)
                  .bg(n.external ? t.muted : color(state)),
              )
              .child(div().text_size(13).font_semibold().child(n.key))
              .child(
                div()
                  .text_size(11)
                  .text_color(t.muted)
                  .child(n.external ? "outside" : READINESS_LABEL[state ?? "pending"]),
              ),
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.muted)
              .truncate()
              .child(ticket?.summary ?? ""),
          )
          // Room for agent chips (Phase 4 draws them here).
          .child(h_flex().id(`chips-${n.key}`).gap(4))
      );
    });
    const canvas = div().relative().flex_none().w(l.width).h(l.height).children(layers).children(nodes);
    return h_flex()
      .size_full()
      .child(div().id("graph-scroll").flex_1().min_w(0).h_full().overflow_scrollbar().child(canvas))
      .when(!!sel && !!board.tickets[sel ?? ""], (el: El) =>
        el.child(this.inspector(t, board, m, sel as string)),
      );
  }

  inspector(t: Theme, board: Board, m: BoardModel, key: string): El {
    const ticket = board.tickets[key];
    if (!ticket) return div();
    const row = m.rows.find((r) => r.key === key);
    const ext = m.externals.find((x) => x.key === key);
    const blocks = Object.entries(board.tickets)
      .filter(([, x]) => x.blocked_by.includes(key))
      .map(([k]) => k);
    return v_flex()
      .id("inspector")
      .w(300)
      .h_full()
      .p(14)
      .gap(8)
      .bg(t.surface)
      .border_l(1)
      .border_color(t.border)
      .overflow_y_scrollbar()
      .child(div().text_size(15).font_semibold().child(key))
      .child(div().text_size(13).child(ticket.summary))
      .child(
        kv(t, "Jira status", `${ticket.jira_status}${ticket.resolution ? ` (${ticket.resolution})` : ""}`),
      )
      .child(kv(t, "On the board", ticket.on_board ? "yes" : "no: an outside blocker"))
      .when(!!row, (el: El) =>
        el
          .child(kv(t, "Preparation", ticket.preparation.replaceAll("_", " ")))
          .child(kv(t, "Readiness", READINESS_LABEL[row?.readiness ?? "pending"] ?? ""))
          .child(
            kv(
              t,
              "Blocked by",
              row?.blockers.map((b) => `${b.key} (${b.status}${b.external ? ", outside" : ""})`).join(", ") ||
                "nothing",
            ),
          ),
      )
      .child(kv(t, "Blocks", blocks.join(", ") || "nothing"))
      .when(!!ext, (el: El) =>
        el.children(this.actionButtons(t, externalActions(board.id, ext as ExternalRow, "insp-"))),
      )
      .when(!!row, (el: El) =>
        el.children(this.actionButtons(t, [excludeAction(board.id, key, ticket.preparation)])),
      );
  }

  /** Buttons for model actions; each runs its `collie ctl` command. */
  actionButtons(t: Theme, actions: Action[]): El[] {
    return actions.map((a) =>
      button(t, a.id, a.label, this.busy, (cx: El) => this.run(cx, a.command, a.args)),
    );
  }

  newBoard(t: Theme, first: boolean): El {
    const f = this.fields;
    const field = (label: string, state: InputState) =>
      v_flex()
        .gap(4)
        .child(div().text_size(12).text_color(t.muted).child(label))
        .child(
          div()
            .h(30)
            .px(8)
            .rounded(6)
            .border(1)
            .border_color(t.input)
            .bg(t.surface)
            .child(Input.new(state).h_full().w_full().text_size(13)),
        );
    return v_flex()
      .id("new-board")
      .p(20)
      .gap(12)
      .max_w(560)
      .child(
        div()
          .text_size(15)
          .font_semibold()
          .child(first ? "Create your first board" : "New board"),
      )
      .child(
        div()
          .text_size(12)
          .text_color(t.muted)
          .child(
            "Collie reads Jira with the token in your collie-jira keychain item; its account field must be your Atlassian email.",
          ),
      )
      .child(field("Name", f.name as InputState))
      .child(field("Jira site", f.site as InputState))
      .child(field("Jira project key", f.project as InputState))
      .child(field("Bitbucket workspace", f.workspace as InputState))
      .child(field("Repository slug", f.slug as InputState))
      .child(field("Default branch", f.branch as InputState))
      .child(field("Local checkout", f.path as InputState))
      .child(
        h_flex()
          .gap(8)
          .child(
            button(t, "create-board", "Create board", this.busy, (cx: El) => {
              const v = (k: string) => (f[k] as InputState).value().trim();
              this.run(
                cx,
                "board.create",
                {
                  name: v("name"),
                  jira: {
                    site: v("site")
                      .replace(/^https?:\/\//, "")
                      .replace(/\/.*$/, ""),
                    project: v("project").toUpperCase(),
                  },
                  repo: {
                    workspace: v("workspace"),
                    slug: v("slug"),
                    default_branch: v("branch") || "main",
                    local_path: v("path"),
                  },
                },
                (ok) => {
                  if (ok) this.screen = "setup";
                },
              );
            }),
          )
          .when(!first, (el: El) =>
            el.child(
              button(t, "cancel-new", "Cancel", false, (cx: El) => {
                this.screen = "setup";
                cx.notify();
              }),
            ),
          ),
      );
  }
}

// --- small pieces

function button(t: Theme, id: string, label: string, disabled: boolean, onClick: (cx: El) => void): El {
  return div()
    .id(id)
    .px(10)
    .py(5)
    .rounded(6)
    .text_size(12)
    .border(1)
    .border_color(t.border)
    .bg(disabled ? t.canvas : t.raised)
    .text_color(disabled ? t.dim : t.foreground)
    .when(!disabled, (el: El) =>
      el
        .cursor_pointer()
        .hover((h: El) => h.bg(t.hover))
        .on_click((_e: unknown, cx: El) => onClick(cx)),
    )
    .child(label);
}

function pill(t: Theme, id: string, label: string, active: boolean, onClick: (cx: El) => void): El {
  return div()
    .id(id)
    .px(8)
    .py(3)
    .rounded(10)
    .text_size(12)
    .cursor_pointer()
    .bg(active ? t.accent : t.raised)
    .text_color(active ? t.accent_foreground : t.foreground)
    .hover((h: El) => h.opacity(0.85))
    .on_click((_e: unknown, cx: El) => onClick(cx))
    .child(label);
}

function readinessBadge(t: Theme, state: string): El {
  const color =
    state === "ready" ? t.done : state === "blocked" ? t.blocked : state === "excluded" ? t.dim : t.idle;
  return h_flex()
    .gap(6)
    .items_center()
    .text_size(12)
    .child(div().w(8).h(8).rounded(4).bg(color))
    .child(READINESS_LABEL[state] ?? state);
}

function section(t: Theme, label: string): El {
  return div().text_size(12).font_semibold().text_color(t.muted).child(label.toUpperCase());
}

function kv(t: Theme, k: string, v: string): El {
  return v_flex()
    .gap(2)
    .child(div().text_size(11).text_color(t.dim).child(k))
    .child(div().text_size(13).child(v));
}
