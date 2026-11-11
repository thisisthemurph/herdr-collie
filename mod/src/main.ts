// The Collie mod: the Collie tab (header, view tabs), Board setup and the dependency graph.
// It holds no state of its own beyond what's on screen: boards come from ~/.collie, changes go
// through `collie ctl`, and the folder watch redraws it, so reloading the mod loses nothing.

import type { Board, Profile, StateFile } from "@collie/schema";
import { h_flex, Input, InputState, v_flex } from "gpui-base";
import { div, PathBuilder, View } from "gpui-kit";
import { props as herdrProps, run as herdrRun, notify, panes, theme, watchFolder } from "herdr";
import {
  collieHome,
  controllerAlive,
  ctl,
  ensureController,
  loadBoards,
  loadPrep,
  loadProfiles,
  loadRun,
  loadRunEvents,
  loadRuns,
  loadWorkflows,
} from "./collie.ts";
import {
  type Action,
  alerts,
  answerAction,
  type BoardModel,
  blankDraft,
  boardModel,
  buildProfile,
  COMPLETE_AT_LABEL,
  COMPLETE_AT_OPTIONS,
  defaultActivityRun,
  deleteRun,
  describeReply,
  draftOf,
  duplicateDraft,
  EVENT_KIND_LABEL,
  EVENT_KINDS,
  EVENT_LIMIT,
  type EventFilter,
  type ExecView,
  type ExternalRow,
  eventRows,
  eventTickets,
  excludeAction,
  execChipLabel,
  execLine,
  externalActions,
  type FindingRow,
  findingRows,
  findingTickets,
  HARNESSES,
  investigateAction,
  investigateTargets,
  jiraStepsText,
  type LogEvent,
  metricsLines,
  type NeedAction,
  type NeedItem,
  needsConfirm,
  needsYou,
  newRunFrom,
  nextPreparation,
  nextWorkflow,
  PR_DRAFT_LABEL,
  PR_DRAFT_OPTIONS,
  type ProfileDraft,
  type PrRow,
  parseImport,
  prBadges,
  prepModel,
  prRows,
  prStateTone,
  type QuestionRow,
  questionRows,
  ROLE_OPTIONS,
  type RunHistoryRow,
  type RunModel,
  type RunRecord,
  type RunView,
  runHistory,
  runMetrics,
  runModel,
  type Summaries,
  saveProfileAction,
  settingAction,
  startAction,
  summariesOf,
  type TicketRow,
  type TicketRunView,
  type Tone,
  ticketRunActions,
  watchCommand,
} from "./model.ts";

type Screen = "setup" | "graph" | "findings" | "questions" | "activity" | "profiles" | "new";
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
  /** The board's run (the one going, else the latest), from ~/.collie/runs. */
  runView: RunView | null = null;
  boardId: string | null = null;
  screen: Screen = "setup";
  selected: string | null = null;
  message: { text: string; error: boolean } | null = null;
  busy = false;
  alive = false;
  importBox!: InputState;
  fields!: Record<string, InputState>;
  /** The analyst's questions, executions and findings for the board (boards/<id>/prep/state.json). */
  prep: StateFile | null = null;
  workflows: { id: string; name: string }[] = [];
  /** The question dialog: which question, and whether it is a run's or the analyst's. */
  dialog: { scope: "run" | "prep"; questionId: string } | null = null;
  answerBox!: InputState;
  // DECISION: "Share this answer with other agents on this ticket" starts unchecked: sharing is
  // opt-in, since a one-off answer can mislead the ticket's other agents.
  share = false;
  dialogError: string | null = null;
  sending = false;
  /** The Findings tab's ticket filter; null shows every ticket. */
  findingsFilter: string | null = null;
  /** Activity: every run of the board, the one open, its events (read on demand) and the filters. */
  runs: RunRecord[] = [];
  activityRun: string | null = null;
  events: LogEvent[] = [];
  eventFilter: EventFilter = { ticket: null, kind: null };
  /** The id of a cancel or delete button that was pressed once and waits for its Yes. */
  confirming: string | null = null;
  /** Agent profiles (~/.collie/profiles), the one being edited and why it can't be saved yet. */
  profiles: Profile[] = [];
  editing: ProfileDraft | null = null;
  profileIssues: string[] = [];
  pf!: Record<"id" | "name" | "model" | "args" | "instructions" | "timeout" | "attempts", InputState>;

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
    this.answerBox = InputState.new({ placeholder: "Type your answer, or pick an option above" });
    this.answerBox.on("submit", (_e, cx) => this.sendAnswer(cx));
    this.fields = {
      name: InputState.new({ placeholder: "Board name, e.g. Payments API – Q4" }),
      site: InputState.new({ placeholder: "Jira site, e.g. example.atlassian.net" }),
      project: InputState.new({ placeholder: "Jira project key, e.g. PAY" }),
      workspace: InputState.new({ placeholder: "Bitbucket workspace" }),
      slug: InputState.new({ placeholder: "Repository slug" }),
      branch: InputState.new({ placeholder: "Default branch", value: "main" }),
      path: InputState.new({ placeholder: "Local checkout, e.g. ~/code/payments" }),
    };
    this.pf = {
      id: InputState.new({ placeholder: "id, e.g. frontend-reviewer (lowercase, dashes)" }),
      name: InputState.new({ placeholder: "Name, e.g. Frontend reviewer" }),
      model: InputState.new({ placeholder: "Model, e.g. sonnet" }),
      args: InputState.new({ placeholder: "Extra arguments, separated by \\n" }),
      instructions: InputState.new({ placeholder: "Instructions (a line break is written \\n)" }),
      timeout: InputState.new({ placeholder: "30" }),
      attempts: InputState.new({ placeholder: "2" }),
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
    const before = this.runView;
    this.runView = this.boardId ? await loadRun(this.boardId) : null;
    this.prep = this.boardId ? await loadPrep(this.boardId) : null;
    this.workflows = await loadWorkflows();
    // The Activity and Profiles screens read more of ~/.collie, so only while they are open.
    if (this.screen === "activity" && this.boardId) {
      this.runs = await loadRuns(this.boardId);
      const rows = runHistory(this.runs, Date.now());
      if (!rows.some((r) => r.id === this.activityRun)) this.activityRun = defaultActivityRun(rows);
      this.events = this.activityRun ? await loadRunEvents(this.activityRun) : [];
    }
    if (this.screen === "profiles") this.profiles = await loadProfiles();
    // Notifications: only what changed since the last look, never what was there when the mod opened.
    if (before && this.runView)
      for (const a of alerts(before, this.runView, summariesOf(this.board))) this.announce(a);
    if (this.selected && !this.board?.tickets[this.selected]) this.selected = null;
  }

  /** Raises a Herdr notification that, when clicked, shows this tab. */
  announce(a: { title: string; body: string; level: "info" | "success" | "warning" | "error" }) {
    try {
      // The tab this mod copy lives in (props().pane is documented for pane mods; if Herdr gives a
      // tab mod no pane, the notification simply has no action).
      const pane = (herdrProps() as { pane?: string } | undefined)?.pane;
      const tab = pane ? panes().find((p) => p.pane === pane)?.tab : undefined;
      notify({ ...a, ...(tab ? { action: { name: "tab.select", args: { id: tab } } } : {}) });
    } catch {}
  }

  get board(): Board | null {
    return this.boards.find((b) => b.id === this.boardId) ?? null;
  }

  /** Runs a ctl command, shows its outcome, and reloads. */
  run(cx: El, command: string, args: Record<string, unknown>, after?: (ok: boolean) => void) {
    if (this.busy) return;
    this.busy = true;
    this.confirming = null;
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

  // --- questions

  openDialog(scope: "run" | "prep", questionId: string, cx: El) {
    this.dialog = { scope, questionId };
    this.answerBox.set_value("");
    this.share = false;
    this.dialogError = null;
    cx.notify();
  }

  /** Sends the dialog's answer. A rejection (say, already answered) is shown in the dialog. */
  sendAnswer(cx: El) {
    const d = this.dialog;
    if (!d || this.sending) return;
    const scopeId = d.scope === "run" ? this.runView?.id : this.boardId;
    if (!scopeId) return;
    const r = answerAction(scopeId, d.questionId, this.answerBox.value(), this.share);
    if ("error" in r) {
      this.dialogError = r.error;
      cx.notify();
      return;
    }
    this.sending = true;
    this.dialogError = null;
    cx.notify();
    cx.spawn(async (cx: El) => {
      const reply = await ctl(r.action.command, r.action.args);
      this.sending = false;
      if (reply.ok) {
        this.dialog = null;
        this.message = { text: "Answer sent.", error: false };
      } else this.dialogError = reply.error?.message ?? "The answer was not accepted.";
      await this.reload();
      cx.notify();
    });
  }

  /** Shows an agent's live terminal over this tab. */
  watchTerminal(terminal: string) {
    const w = watchCommand(terminal);
    try {
      herdrRun(w.name, w.args);
    } catch (err) {
      this.message = { text: `couldn't open ${terminal}: ${(err as Error).message}`, error: true };
    }
  }

  // --- rendering

  render(_cx: El) {
    this.remember();
    const t = colors();
    const board = this.board;
    const model = board ? boardModel(board) : null;
    const summaries = summariesOf(board);
    const run = runModel(this.runView, summaries);
    return v_flex()
      .id("root")
      .relative()
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
                ? this.graph(t, board, model, run, summaries)
                : this.screen === "findings"
                  ? this.findingsView(t, summaries)
                  : this.screen === "questions"
                    ? this.questionsView(t, summaries)
                    : this.screen === "activity"
                      ? this.activityView(t, board, model, summaries)
                      : this.screen === "profiles"
                        ? this.profilesView(t)
                        : this.setup(t, board, model, run),
          ),
      )
      .when(!!this.dialog, (el: El) => el.child(this.dialogView(t, summaries)));
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
            cx.spawn(async (cx: El) => {
              await this.reload();
              cx.notify();
            });
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
          this.confirming = null;
          cx.notify();
          if (id === "activity" || id === "profiles")
            cx.spawn(async (cx: El) => {
              await this.reload();
              cx.notify();
            });
        })
        .child(label);
    const st = this.runView?.state;
    const openQuestions =
      Object.values(st?.questions ?? {}).filter((q) => q.state === "open").length +
      Object.values(this.prep?.questions ?? {}).filter((q) => q.state === "open").length;
    const openFindings = (st?.findings ?? []).filter((f) => f.addressed_in_round === null).length;
    return h_flex()
      .px(10)
      .gap(4)
      .border_b(1)
      .border_color(t.border)
      .when(!!board, (el: El) =>
        el
          .child(tab("setup", "Board setup"))
          .child(tab("graph", "Graph"))
          .child(tab("findings", openFindings ? `Findings (${openFindings})` : "Findings"))
          .child(tab("questions", openQuestions ? `Questions (${openQuestions})` : "Questions"))
          .child(tab("activity", "Activity"))
          .child(tab("profiles", "Agent profiles")),
      );
  }

  setup(t: Theme, board: Board, m: BoardModel, run: RunModel | null): El {
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
            `${board.jira.project} on ${board.jira.site} · repo ${board.repo.workspace}/${board.repo.slug} (${board.repo.default_branch}) · workflow ${s.workflow} · outside blockers count when ${s.completion_policy.mode.replaceAll("_", " ")}`,
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
      .child(this.workflowBar(t, board))
      .child(this.runBar(t, board, m, run))
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(section(t, `Tickets (${m.rows.length})`))
          .when(investigateTargets(m.rows).length > 0, (el: El) => {
            const a = investigateAction(board.id, investigateTargets(m.rows));
            return el.child(
              button(t, a.id, a.label, this.busy || !this.alive, (cx: El) => this.run(cx, a.command, a.args)),
            );
          }),
      )
      .child(this.runSettings(t, board))
      .child(this.ticketTable(t, board, m.rows, run))
      .child(this.prepSection(t, board))
      .when(m.externals.length > 0, (el: El) =>
        el
          .child(section(t, `Outside blockers (${m.externals.length})`))
          .child(this.externalTable(t, board, m)),
      );
  }

  /** Run settings: when a ticket counts as complete, and when a PR opens as a draft. */
  runSettings(t: Theme, board: Board): El {
    const s = board.settings;
    const chips = <K extends string>(
      label: string,
      options: readonly K[],
      names: Record<string, string>,
      current: K,
      pick: (o: K) => Parameters<typeof settingAction>[1],
    ) =>
      h_flex()
        .gap(6)
        .items_center()
        .child(div().w(130).text_size(12).text_color(t.muted).child(label))
        .children(
          options.map((o) =>
            pill(t, `set-${label}-${o}`, names[o] ?? o, o === current, (cx: El) => {
              if (o === current || this.busy) return;
              const a = settingAction(board.id, pick(o));
              this.run(cx, a.command, a.args);
            }),
          ),
        );
    return v_flex()
      .id("run-settings")
      .gap(6)
      .child(
        chips("Complete at", COMPLETE_AT_OPTIONS, COMPLETE_AT_LABEL, s.complete_at, (o) => ({
          complete_at: o,
        })),
      )
      .child(
        chips("Pull request draft", PR_DRAFT_OPTIONS, PR_DRAFT_LABEL, s.pr_draft_policy, (o) => ({
          pr_draft_policy: o,
        })),
      );
  }

  /** The board's default workflow: one chip per workflow found in ~/.collie/workflows. */
  workflowBar(t: Theme, board: Board): El {
    const current = board.settings.workflow;
    const ids = this.workflows.map((w) => w.id);
    return h_flex()
      .gap(6)
      .items_center()
      .child(div().text_size(12).text_color(t.muted).child("Default workflow"))
      .children(
        (ids.includes(current) ? this.workflows : [{ id: current, name: current }, ...this.workflows]).map(
          (w) =>
            pill(t, `wf-${w.id}`, w.name, w.id === current, (cx: El) => {
              if (w.id !== current)
                this.run(cx, "board.update_settings", { board_id: board.id, settings: { workflow: w.id } });
            }),
        ),
      )
      .when(this.workflows.length === 0, (el: El) =>
        el.child(div().text_size(12).text_color(t.dim).child("(none found in ~/.collie/workflows)")),
      );
  }

  /** The analyst's open questions and notes, per ticket (board preparation). */
  prepSection(t: Theme, board: Board): El {
    const items = prepModel(board, this.prep);
    if (items.length === 0) return div();
    return v_flex()
      .gap(8)
      .child(section(t, "Preparation"))
      .children(
        items.map((it) =>
          v_flex()
            .id(`prep-${it.key}`)
            .gap(6)
            .p(10)
            .rounded(6)
            .border(1)
            .border_color(it.questions.length ? t.blocked : t.border)
            .bg(t.surface)
            .child(
              h_flex()
                .gap(8)
                .text_size(13)
                .child(div().font_semibold().child(it.key))
                .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(it.summary))
                .child(div().text_size(12).text_color(t.muted).child(it.preparation.replaceAll("_", " "))),
            )
            .children(
              it.questions.map((q) =>
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(div().flex_1().min_w(0).text_size(13).child(`${q.asker} asks: ${q.question}`))
                  .child(
                    button(t, `prep-answer-${q.id}`, "Answer", false, (cx: El) =>
                      this.openDialog("prep", q.id, cx),
                    ),
                  ),
              ),
            )
            .children(
              it.notes.map((n) =>
                div()
                  .text_size(12)
                  .text_color(t.muted)
                  .child(`Note${n.blocking ? " (blocking)" : ""}: ${n.title}`),
              ),
            ),
        ),
      );
  }

  /** Start run, or the run going now with its Pause, Resume and Cancel buttons. */
  runBar(t: Theme, board: Board, m: BoardModel, run: RunModel | null): El {
    const start = startAction(board.id, m, run);
    return h_flex()
      .gap(10)
      .items_center()
      .when(!run?.active, (el: El) =>
        el.child(
          button(
            t,
            start.action.id,
            start.action.label,
            !!start.disabled || this.busy || !this.alive,
            (cx: El) => this.run(cx, start.action.command, start.action.args),
          ),
        ),
      )
      .when(!!run?.active, (el: El) => el.children(this.actionButtons(t, run?.actions ?? [])))
      .when(!!run && !run.active, (el: El) => {
        // The last run ended: start the next one with its completed tickets carried over.
        const nr = newRunFrom(
          board.id,
          { id: (run as RunModel).id, active: false, number: (run as RunModel).number },
          m.startBlocked,
          null,
        );
        return nr
          ? el.child(
              button(
                t,
                nr.action.id,
                `New run from run ${(run as RunModel).number}`,
                !!nr.disabled || this.busy || !this.alive,
                (cx: El) => this.run(cx, nr.action.command, nr.action.args),
              ),
            )
          : el;
      })
      .child(
        div()
          .text_size(12)
          .text_color(t.muted)
          .child(
            run
              ? `Run ${run.number} · ${run.status} · ${run.progress}`
              : (start.disabled ??
                  `${m.counts.ready} ready · ${m.counts.blocked} blocked · ${m.counts.pending} not prepared · ${m.counts.excluded} excluded.`),
          ),
      )
      .when(!!run && !run.active && !!start.disabled, (el: El) =>
        el.child(
          div()
            .text_size(12)
            .text_color(t.blocked)
            .child(start.disabled ?? ""),
        ),
      )
      .when(!this.alive && !run?.active, (el: El) =>
        el.child(div().text_size(12).text_color(t.blocked).child("Start the controller first.")),
      );
  }

  ticketTable(t: Theme, board: Board, rows: TicketRow[], run: RunModel | null): El {
    const head = h_flex()
      .gap(6)
      .px(8)
      .py(4)
      .text_size(11)
      .text_color(t.dim)
      .child(div().w(64).child("KEY"))
      .child(div().flex_1().child("SUMMARY"))
      .child(div().w(80).child("JIRA"))
      .child(div().w(100).child("PREPARATION"))
      .child(
        div()
          .w(96)
          .child(run ? "IN RUN" : "READINESS"),
      )
      .child(div().w(100).child("WORKFLOW"))
      .child(div().w(64).child("BLOCKED BY"))
      .child(div().w(100));
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
            .gap(6)
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
            .child(div().w(80).text_color(t.muted).truncate().child(r.jiraStatus))
            .child(
              div()
                .w(100)
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
            .child(
              div()
                .w(96)
                .child(
                  run?.tickets[r.key]
                    ? toneBadge(t, run.tickets[r.key]?.tone ?? "dim", run.tickets[r.key]?.label ?? "")
                    : readinessBadge(t, r.readiness),
                ),
            )
            .child(
              div()
                .w(100)
                .child(
                  pill(t, `wf-${r.key}`, r.workflow ?? "default", r.workflow !== null, (cx: El) =>
                    this.run(cx, "ticket.set_workflow", {
                      board_id: board.id,
                      ticket: r.key,
                      workflow: nextWorkflow(
                        r.workflow,
                        this.workflows.map((w) => w.id),
                      ),
                    }),
                  ),
                ),
            )
            .child(
              div()
                .w(64)
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
            )
            .child(
              div()
                .w(100)
                .child(
                  button(
                    t,
                    `inv-${r.key}`,
                    "Investigate",
                    this.busy ||
                      !this.alive ||
                      r.preparation === "investigating" ||
                      r.preparation === "excluded",
                    (cx: El) => {
                      const a = investigateAction(board.id, [r.key]);
                      this.run(cx, a.command, a.args);
                    },
                  ),
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

  graph(t: Theme, board: Board, m: BoardModel, run: RunModel | null, summaries: Summaries): El {
    const needs = this.runView ? needsYou(this.runView, summaries) : [];
    const prs = prRows(this.runView, summaries);
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
    // In a run a node shows where its ticket is (queued, developing, done...), not just readiness.
    const dot = (key: string) => {
      const rt = run?.tickets[key];
      return rt ? tone(t, rt.tone) : color(readinessOf.get(key));
    };
    const nodes = l.nodes.map((n) => {
      const ticket = board.tickets[n.key];
      const isSel = n.key === sel;
      const state = readinessOf.get(n.key);
      return div()
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
                .bg(n.external ? t.muted : dot(n.key)),
            )
            .child(div().text_size(13).font_semibold().child(n.key))
            .child(
              div()
                .text_size(11)
                .text_color(t.muted)
                .child(
                  n.external
                    ? "outside"
                    : (run?.tickets[n.key]?.label ?? READINESS_LABEL[state ?? "pending"]),
                ),
            )
            // The agent going (or how many), or the newest: a dot for its state, and its kind and round.
            .children(
              (() => {
                const rt = run?.tickets[n.key];
                const chip = rt ? execChipLabel(rt) : null;
                return chip?.exec ? [execChip(t, n.key, chip.text, chip.exec)] : [];
              })(),
            ),
        )
        .child(
          div()
            .text_size(11)
            .text_color(t.muted)
            .truncate()
            .child(ticket?.summary ?? ""),
        );
    });
    const canvas = div().relative().flex_none().w(l.width).h(l.height).children(layers).children(nodes);
    return h_flex()
      .size_full()
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .h_full()
          .when(needs.length > 0, (el: El) => el.child(this.needsBanner(t, needs)))
          .child(div().id("graph-scroll").flex_1().min_h(0).overflow_scrollbar().child(canvas))
          .child(this.deliveryBar(t, run, prs)),
      )
      .when(prs.length > 0, (el: El) => el.child(this.prPanel(t, prs)))
      .when(!!sel && !!board.tickets[sel ?? ""], (el: El) =>
        el.child(this.inspector(t, board, m, sel as string, run)),
      );
  }

  /** The Needs you banner: each thing that holds a ticket for a person, with its button. */
  needsBanner(t: Theme, items: NeedItem[]): El {
    return v_flex()
      .id("needs-you")
      .flex_none()
      .gap(6)
      .px(16)
      .py(8)
      .max_h(190)
      .overflow_y_scrollbar()
      .bg(t.surface)
      .border_b(1)
      .border_color(t.blocked)
      .child(div().text_size(12).font_semibold().text_color(t.blocked).child(`NEEDS YOU (${items.length})`))
      .children(
        items.map((i) =>
          h_flex()
            .id(`need-${i.key}`)
            .gap(10)
            .items_center()
            .text_size(12)
            .child(div().w(70).font_semibold().child(i.ticket))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .child(div().truncate().child(i.summary))
                .child(div().truncate().text_color(t.muted).child(i.reason)),
            )
            .children(i.actions.map((a) => this.needButton(t, a))),
        ),
      );
  }

  needButton(t: Theme, a: NeedAction): El {
    if (a.type === "ctl") return this.actionButton(t, { ...a }, a.id);
    return button(t, a.id, a.label, false, (cx: El) => {
      if (a.type === "answer") this.openDialog(a.scope, a.questionId, cx);
      else this.watchTerminal(a.terminal);
    });
  }

  /** Under the graph: the run, and how many pull requests it has (the panel is at the right). */
  deliveryBar(t: Theme, run: RunModel | null, prs: PrRow[]): El {
    return h_flex()
      .id("delivery-bar")
      .gap(14)
      .px(16)
      .py(8)
      .items_center()
      .text_size(12)
      .text_color(t.muted)
      .bg(t.surface)
      .border_t(1)
      .border_color(t.border)
      .child(div().child(run ? `Run ${run.number} · ${run.status} · ${run.progress}` : "No run yet"))
      .when(!!run?.active, (el: El) => el.children(this.actionButtons(t, run?.actions ?? [])))
      .child(div().flex_1())
      .child(
        div().child(
          prs.length
            ? `Pull requests: ${prs.length} (${prs.filter((p) => p.state === "OPEN").length} open)`
            : "Pull requests: none yet",
        ),
      );
  }

  /** The Pull requests panel: the run's PRs, which stay here after the run ends while they're open. */
  prPanel(t: Theme, prs: PrRow[]): El {
    return v_flex()
      .id("pr-panel")
      .w(340)
      .h_full()
      .flex_none()
      .p(14)
      .gap(8)
      .bg(t.surface)
      .border_l(1)
      .border_color(t.border)
      .overflow_y_scrollbar()
      .child(section(t, `Pull requests (${prs.length})`))
      .children(prs.map((p) => this.prCard(t, p, "pr-")));
  }

  /** One PR: ticket, #id, state, badges, branches, approvals, its link and Mark ready. */
  prCard(t: Theme, p: PrRow, prefix: string): El {
    return v_flex()
      .id(`${prefix}${p.ticket}`)
      .gap(4)
      .p(8)
      .rounded(6)
      .border(1)
      .border_color(p.conflicted || p.needsRebase ? t.blocked : t.border)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .text_size(12)
          .child(div().font_semibold().child(p.ticket))
          .child(div().text_color(t.muted).child(`#${p.id}`))
          .child(toneBadge(t, prStateTone(p.state), p.state))
          .children(
            prBadges(p).map((b) =>
              div()
                .px(6)
                .py(1)
                .rounded(8)
                .text_size(11)
                .border(1)
                .border_color(tone(t, b.tone))
                .text_color(tone(t, b.tone))
                .child(b.label),
            ),
          ),
      )
      .child(div().text_size(12).text_color(t.muted).truncate().child(p.branches))
      .child(
        div()
          .text_size(12)
          .text_color(t.muted)
          .child(`${p.approvals} approval${p.approvals === 1 ? "" : "s"}`),
      )
      .child(
        div()
          .id(`${prefix}link-${p.ticket}`)
          .text_size(12)
          .text_color(t.accent)
          .truncate()
          .cursor_pointer()
          .hover((h: El) => h.opacity(0.8))
          .on_click((_e: unknown, cx: El) => {
            // open_url takes an http(s) URL only; if it refuses, the url stays visible as text.
            try {
              cx.open_url(p.url);
            } catch {
              this.message = { text: `Could not open ${p.url}`, error: true };
              cx.notify();
            }
          })
          .child(p.url),
      )
      .when(!!p.markReady, (el: El) => {
        const a = p.markReady as Action;
        return el.child(
          button(t, `${prefix}${a.id}`, a.label, this.busy || !this.alive, (cx: El) =>
            this.run(cx, a.command, a.args),
          ),
        );
      });
  }

  inspector(t: Theme, board: Board, m: BoardModel, key: string, run: RunModel | null): El {
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
          .child(kv(t, "Workflow", ticket.workflow ?? `${board.settings.workflow} (board default)`))
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
      .when(!!run?.tickets[key], (el: El) => el.child(this.runSection(t, run as RunModel, key)))
      .when(!!ext, (el: El) =>
        el.children(this.actionButtons(t, externalActions(board.id, ext as ExternalRow, "insp-"))),
      )
      .when(!!row, (el: El) =>
        el.children(this.actionButtons(t, [excludeAction(board.id, key, ticket.preparation)])),
      );
  }

  /** A ticket's place in the run: its state, why it waits, its agents, and what you can do. */
  runSection(t: Theme, run: RunModel, key: string): El {
    const rt = run.tickets[key] as TicketRunView;
    return v_flex()
      .gap(8)
      .child(section(t, `In run ${run.number}`))
      .child(kv(t, "State", rt.label))
      .when(rt.attention.length > 0, (el: El) =>
        el.child(
          div()
            .p(8)
            .rounded(6)
            .border(1)
            .border_color(t.blocked)
            .text_size(12)
            .text_color(t.blocked)
            .child(`Needs you: ${rt.attention.join("; ")}.`),
        ),
      )
      .when(!!rt.branch, (el: El) => el.child(kv(t, "Branch", rt.branch ?? "")))
      .when(!!rt.pr, (el: El) => el.child(this.prCard(t, rt.pr as PrRow, "insp-pr-")))
      .when(!!rt.pr || rt.jiraSteps.length > 0, (el: El) =>
        el.child(kv(t, "Jira write-back", jiraStepsText(rt.jiraSteps))),
      )
      .when(rt.openQuestions.length > 0, (el: El) =>
        el.children(
          rt.openQuestions.map((q) =>
            v_flex()
              .id(`insp-q-${q.id}`)
              .gap(4)
              .p(8)
              .rounded(6)
              .border(1)
              .border_color(t.blocked)
              .child(div().text_size(11).text_color(t.dim).child(q.asker))
              .child(div().text_size(12).child(q.question))
              .child(
                button(t, `insp-answer-${q.id}`, "Answer", false, (cx: El) =>
                  this.openDialog("run", q.id, cx),
                ),
              ),
          ),
        ),
      )
      .when(rt.openFindings.length > 0, (el: El) =>
        el
          .child(div().text_size(11).text_color(t.dim).child(`Open findings (${rt.openFindings.length})`))
          .children(rt.openFindings.map((f) => this.findingRow(t, f, false))),
      )
      .when(rt.executions.length > 0, (el: El) =>
        el
          .child(div().text_size(11).text_color(t.dim).child("Agents"))
          .children(rt.executions.map((e) => this.execRow(t, e))),
      )
      .children(ticketRunActions(run.id, rt, run.status).map((a) => this.actionButton(t, a, `insp-${a.id}`)));
  }

  /** One agent: where it is, what it said, and a button to watch its terminal. */
  execRow(t: Theme, e: ExecView): El {
    return v_flex()
      .id(`exec-${e.id}`)
      .gap(3)
      .p(8)
      .rounded(6)
      .border(1)
      .border_color(e.blocked ? t.blocked : t.border)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(
            div()
              .w(8)
              .h(8)
              .rounded(4)
              .bg(tone(t, execTone(e))),
          )
          .child(div().text_size(12).child(execLine(e))),
      )
      .when(!!e.outcome, (el: El) =>
        el.child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child(e.outcome ?? ""),
        ),
      )
      .when(!!e.terminal && e.live, (el: El) =>
        el.child(
          button(t, `watch-${e.id}`, "Watch terminal", false, () => this.watchTerminal(e.terminal as string)),
        ),
      );
  }

  /** One finding: severity, blocking, title, where, round; dimmed once addressed. */
  findingRow(t: Theme, f: FindingRow, withTicket = true): El {
    const sev =
      f.severity === "critical" || f.severity === "high"
        ? t.blocked
        : f.severity === "medium"
          ? t.idle
          : t.dim;
    return v_flex()
      .id(`finding-${f.id}`)
      .gap(2)
      .p(8)
      .rounded(6)
      .border(1)
      .border_color(t.border)
      .bg(t.surface)
      .opacity(f.addressed ? 0.5 : 1)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .text_size(12)
          .child(div().font_semibold().text_color(sev).child(f.severity.toUpperCase()))
          .when(f.blocking, (el: El) =>
            el.child(div().font_semibold().text_color(t.blocked).child("BLOCKING")),
          )
          .when(withTicket, (el: El) => el.child(div().font_semibold().child(f.ticket)))
          .child(div().flex_1().min_w(0).text_size(13).child(f.title)),
      )
      .child(
        div()
          .text_size(11)
          .text_color(t.muted)
          .child(
            [f.where, `round ${f.round}`, f.addressed ? `addressed in round ${f.addressedInRound}` : "open"]
              .filter(Boolean)
              .join(" · "),
          ),
      );
  }

  /** The Findings tab: the run's findings, blocking first, filterable by ticket; then the analyst's notes. */
  findingsView(t: Theme, summaries: Summaries): El {
    const st = this.runView?.state;
    const prepNotes = this.prep ? findingRows(this.prep, summaries) : [];
    const filter =
      st && findingTickets(st).some((x) => x.key === this.findingsFilter) ? this.findingsFilter : null;
    const rows = st ? findingRows(st, summaries, filter) : [];
    return v_flex()
      .id("findings")
      .size_full()
      .overflow_y_scrollbar()
      .p(16)
      .gap(8)
      .child(section(t, this.runView ? `Run ${this.runView.number} findings (${rows.length})` : "Findings"))
      .when(!!st && findingTickets(st).length > 0, (el: El) =>
        el.child(
          h_flex()
            .gap(6)
            .flex_wrap()
            .child(
              pill(t, "ff-all", "All", filter === null, (cx: El) => {
                this.findingsFilter = null;
                cx.notify();
              }),
            )
            .children(
              findingTickets(st as StateFile).map((x) =>
                pill(
                  t,
                  `ff-${x.key}`,
                  x.open ? `${x.key} (${x.open})` : x.key,
                  filter === x.key,
                  (cx: El) => {
                    this.findingsFilter = x.key;
                    cx.notify();
                  },
                ),
              ),
            ),
        ),
      )
      .when(rows.length === 0, (el: El) =>
        el.child(div().text_size(13).text_color(t.muted).child("No findings in this run.")),
      )
      .children(rows.map((f) => this.findingRow(t, f)))
      .when(prepNotes.length > 0, (el: El) =>
        el
          .child(section(t, `Preparation (${prepNotes.length})`))
          .children(prepNotes.map((f) => this.findingRow(t, f))),
      );
  }

  /** One question with its state, answer and (when open) an Answer button. */
  questionRow(t: Theme, q: QuestionRow): El {
    return v_flex()
      .id(`question-${q.id}`)
      .gap(3)
      .p(10)
      .rounded(6)
      .border(1)
      .border_color(q.state === "open" ? t.blocked : t.border)
      .bg(t.surface)
      .opacity(q.state === "withdrawn" ? 0.5 : 1)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .text_size(12)
          .child(div().font_semibold().child(q.ticket))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(q.summary))
          .child(
            div()
              .text_color(q.state === "open" ? t.blocked : t.muted)
              .child(q.state),
          ),
      )
      .child(div().text_size(11).text_color(t.dim).child(q.asker))
      .child(div().text_size(13).child(q.question))
      .when(q.answer !== null, (el: El) =>
        el.child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child(`Answer: ${q.answer}${q.share ? " (shared with this ticket's agents)" : ""}`),
        ),
      )
      .when(q.state === "open", (el: El) =>
        el.child(
          h_flex().child(
            button(t, `answer-${q.id}`, "Answer", false, (cx: El) => this.openDialog(q.scope, q.id, cx)),
          ),
        ),
      );
  }

  /** The Questions tab: the run's questions, open first, then the analyst's ("Preparation"). */
  questionsView(t: Theme, summaries: Summaries): El {
    const run = this.runView ? questionRows(this.runView.state, "run", summaries, this.runView.profiles) : [];
    const prep = this.prep ? questionRows(this.prep, "prep", summaries) : [];
    return v_flex()
      .id("questions")
      .size_full()
      .overflow_y_scrollbar()
      .p(16)
      .gap(8)
      .child(section(t, this.runView ? `Run ${this.runView.number} questions (${run.length})` : "Questions"))
      .when(run.length === 0, (el: El) =>
        el.child(div().text_size(13).text_color(t.muted).child("No questions in this run.")),
      )
      .children(run.map((q) => this.questionRow(t, q)))
      .when(prep.length > 0, (el: El) =>
        el
          .child(section(t, `Preparation (${prep.length})`))
          .children(prep.map((q) => this.questionRow(t, q))),
      );
  }

  /** The question dialog: over everything, with the asker, the question, options and an answer box. */
  dialogView(t: Theme, summaries: Summaries): El {
    const d = this.dialog as { scope: "run" | "prep"; questionId: string };
    const st = d.scope === "run" ? this.runView?.state : this.prep;
    const q = st
      ? questionRows(st, d.scope, summaries, this.runView?.profiles).find((x) => x.id === d.questionId)
      : undefined;
    const close = (cx: El) => {
      this.dialog = null;
      cx.notify();
    };
    const card = v_flex()
      .id("question-dialog")
      .w(540)
      .p(18)
      .gap(10)
      .rounded(10)
      .border(1)
      .border_color(t.border)
      .bg(t.popover)
      .on_mouse_down("left", (_e: unknown, cx: El) => cx.stop_propagation());
    const open = q?.state === "open";
    return h_flex()
      .id("dialog-backdrop")
      .absolute()
      .left(0)
      .top(0)
      .size_full()
      .items_center()
      .justify_center()
      .bg("#000000aa")
      .on_mouse_down("left", (_e: unknown, cx: El) => close(cx))
      .child(
        card
          .child(
            h_flex()
              .gap(8)
              .items_baseline()
              .child(
                div()
                  .text_size(15)
                  .font_semibold()
                  .child(q?.ticket ?? "Question"),
              )
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_color(t.muted)
                  .child(q?.summary ?? ""),
              ),
          )
          .when(!!q, (el: El) =>
            el.child(div().text_size(12).text_color(t.dim).child(`${q?.asker} asks`)).child(
              div()
                .p(10)
                .rounded(6)
                .bg(t.surface)
                .border(1)
                .border_color(t.border)
                .text_size(13)
                .child(q?.question ?? ""),
            ),
          )
          .when(!q, (el: El) =>
            el.child(div().text_size(13).text_color(t.muted).child("This question is no longer in the run.")),
          )
          .when(!!q && !open, (el: El) =>
            el.child(
              div()
                .text_size(13)
                .text_color(t.muted)
                .child(`Already ${q?.state}${q?.answer ? `: ${q.answer}` : ""}.`),
            ),
          )
          .when(open && (q?.options.length ?? 0) > 0, (el: El) =>
            el.child(
              h_flex()
                .gap(6)
                .flex_wrap()
                .children(
                  (q?.options ?? []).map((o, i) =>
                    button(t, `opt-${i}`, o, false, (cx: El) => {
                      this.answerBox.set_value(o);
                      cx.notify();
                    }),
                  ),
                ),
            ),
          )
          .when(open, (el: El) =>
            el
              .child(
                div()
                  .h(30)
                  .px(8)
                  .rounded(6)
                  .border(1)
                  .border_color(t.input)
                  .bg(t.surface)
                  .child(Input.new(this.answerBox).h_full().w_full().text_size(13)),
              )
              .child(
                h_flex()
                  .id("share-toggle")
                  .gap(8)
                  .items_center()
                  .text_size(12)
                  .cursor_pointer()
                  .on_click((_e: unknown, cx: El) => {
                    this.share = !this.share;
                    cx.notify();
                  })
                  .child(
                    div()
                      .w(14)
                      .h(14)
                      .rounded(3)
                      .border(1)
                      .border_color(t.input)
                      .bg(this.share ? t.accent : t.surface)
                      .text_color(t.accent_foreground)
                      .text_size(10)
                      .child(this.share ? "✓" : ""),
                  )
                  .child("Share this answer with other agents on this ticket"),
              ),
          )
          .when(!!this.dialogError, (el: El) =>
            el.child(
              div()
                .text_size(12)
                .text_color(t.blocked)
                .child(this.dialogError ?? ""),
            ),
          )
          .child(
            h_flex()
              .gap(8)
              .when(open, (el: El) =>
                el.child(
                  button(t, "send-answer", this.sending ? "Sending…" : "Send", this.sending, (cx: El) =>
                    this.sendAnswer(cx),
                  ),
                ),
              )
              .child(button(t, "close-dialog", open ? "Cancel" : "Close", false, close)),
          ),
      );
  }

  // --- Activity: run history, metrics and the event log (Phase 7)

  /** Pick a run in the history; its events are read now and kept fresh by the folder watch. */
  openRun(id: string, cx: El) {
    this.activityRun = id;
    this.eventFilter = { ticket: null, kind: null };
    this.confirming = null;
    this.events = [];
    cx.notify();
    cx.spawn(async (cx: El) => {
      this.events = await loadRunEvents(id);
      cx.notify();
    });
  }

  activityView(t: Theme, board: Board, m: BoardModel, summaries: Summaries): El {
    const rows = runHistory(this.runs, Date.now());
    const sel = rows.find((r) => r.id === this.activityRun) ?? null;
    const rec = this.runs.find((r) => r.id === this.activityRun) ?? null;
    return h_flex()
      .size_full()
      .child(
        v_flex()
          .id("run-history")
          .w(300)
          .h_full()
          .flex_none()
          .overflow_y_scrollbar()
          .p(14)
          .gap(8)
          .border_r(1)
          .border_color(t.border)
          .child(section(t, `Run history (${rows.length})`))
          .when(rows.length === 0, (el: El) =>
            el.child(
              div().text_size(13).text_color(t.muted).child("No runs yet. Start one from Board setup."),
            ),
          )
          .children(rows.map((r) => this.runCard(t, r, r.id === this.activityRun))),
      )
      .child(
        sel && rec
          ? this.runDetail(t, board, m, sel, rec, summaries)
          : div().p(16).text_size(13).text_color(t.muted).child("Select a run."),
      );
  }

  runCard(t: Theme, r: RunHistoryRow, selected: boolean): El {
    return v_flex()
      .id(`run-card-${r.id}`)
      .gap(3)
      .p(10)
      .rounded(6)
      .border(1)
      .border_color(selected ? t.accent : t.border)
      .bg(selected ? t.selected : t.surface)
      .cursor_pointer()
      .hover((h: El) => h.bg(t.hover))
      .on_click((_e: unknown, cx: El) => this.openRun(r.id, cx))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().text_size(13).font_semibold().child(r.title))
          .child(div().flex_1())
          .child(toneBadge(t, r.tone, r.status)),
      )
      .child(div().text_size(11).text_color(t.muted).child(r.when))
      .child(
        div()
          .text_size(12)
          .child(`${r.tickets}${r.prs ? ` · ${r.prs} PR${r.prs === 1 ? "" : "s"}` : ""}`),
      )
      .when(!!r.endReason, (el: El) =>
        el.child(
          div()
            .text_size(11)
            .text_color(t.muted)
            .truncate()
            .child(r.endReason ?? ""),
        ),
      )
      .when(r.carriedFrom !== null, (el: El) =>
        el.child(div().text_size(11).text_color(t.dim).child(`carried over from run ${r.carriedFrom}`)),
      );
  }

  runDetail(
    t: Theme,
    board: Board,
    m: BoardModel,
    r: RunHistoryRow,
    rec: RunRecord,
    summaries: Summaries,
  ): El {
    const metrics = metricsLines(runMetrics(this.events));
    const filter = this.eventFilter;
    const tickets = eventTickets(this.events);
    const log = eventRows(this.events, filter, r.pruned);
    const view: RunView | null = rec.state
      ? {
          id: rec.id,
          number: rec.number,
          status: rec.status,
          boardId: rec.boardId,
          state: rec.state,
          profiles: this.runView?.id === rec.id ? this.runView.profiles : undefined,
        }
      : null;
    const model = runModel(view, summaries);
    const active = this.runs.find((x) => x.status === "running" || x.status === "paused");
    const nr = newRunFrom(
      board.id,
      r,
      m.startBlocked,
      active ? { number: active.number, status: active.status } : null,
    );
    const del = deleteRun(r);
    const filterPill = (id: string, label: string, on: boolean, set: () => void) =>
      pill(t, id, label, on, (cx: El) => {
        set();
        cx.notify();
      });
    return v_flex()
      .id("run-detail")
      .flex_1()
      .min_w(0)
      .h_full()
      .overflow_y_scrollbar()
      .p(16)
      .gap(12)
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().text_size(15).font_semibold().child(`${r.title} · ${r.status}`))
          .child(div().text_size(12).text_color(t.muted).child(r.when))
          .child(div().flex_1())
          .when(!!nr, (el: El) => {
            const n = nr as NonNullable<typeof nr>;
            return el.child(
              button(t, n.action.id, n.action.label, !!n.disabled || this.busy || !this.alive, (cx: El) =>
                this.run(cx, n.action.command, n.action.args),
              ),
            );
          })
          .child(this.actionButton(t, del.action, del.action.id, !!del.disabled)),
      )
      .when(!!nr?.disabled, (el: El) =>
        el.child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child(`New run from this run is unavailable: ${nr?.disabled}`),
        ),
      )
      .when(!!r.endReason, (el: El) =>
        el.child(div().text_size(12).text_color(t.muted).child(`Ended: ${r.endReason}`)),
      )
      .when(r.openPrs > 0, (el: El) =>
        el.child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child(
              `${r.openPrs} pull request${r.openPrs === 1 ? " is" : "s are"} still open: the run can't be deleted until ${r.openPrs === 1 ? "it is" : "they are"} merged or declined.`,
            ),
        ),
      )
      .when(r.pruned, (el: El) =>
        el.child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child(
              "Inbox and attachments were removed after 90 days; the events below are complete, but long bodies are no longer available.",
            ),
        ),
      )
      .child(section(t, "Metrics"))
      .child(
        h_flex()
          .gap(10)
          .flex_wrap()
          .children(
            metrics.map((x) =>
              v_flex()
                .gap(2)
                .p(10)
                .w(200)
                .rounded(6)
                .border(1)
                .border_color(t.border)
                .bg(t.surface)
                .child(div().text_size(11).text_color(t.dim).child(x.label))
                .child(div().text_size(15).font_semibold().child(x.value)),
            ),
          ),
      )
      .when(!!model && Object.keys(model.tickets).length > 0, (el: El) =>
        el.child(section(t, "Tickets")).child(this.activityTickets(t, model as RunModel, summaries)),
      )
      .child(
        section(t, `Events (${log.total}${log.total > EVENT_LIMIT ? `, newest ${EVENT_LIMIT} shown` : ""})`),
      )
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .child(
            filterPill("ev-all", "All kinds", filter.kind === null, () => {
              this.eventFilter = { ...filter, kind: null };
            }),
          )
          .children(
            EVENT_KINDS.map((k) =>
              filterPill(`ev-${k}`, EVENT_KIND_LABEL[k], filter.kind === k, () => {
                this.eventFilter = { ...filter, kind: k };
              }),
            ),
          ),
      )
      .when(tickets.length > 0, (el: El) =>
        el.child(
          h_flex()
            .gap(6)
            .flex_wrap()
            .child(
              filterPill("evt-all", "All tickets", filter.ticket === null, () => {
                this.eventFilter = { ...filter, ticket: null };
              }),
            )
            .children(
              tickets.map((k) =>
                filterPill(`evt-${k}`, k, filter.ticket === k, () => {
                  this.eventFilter = { ...filter, ticket: k };
                }),
              ),
            ),
        ),
      )
      .when(log.rows.length === 0, (el: El) =>
        el.child(div().text_size(13).text_color(t.muted).child("No events match.")),
      )
      .child(
        v_flex()
          .gap(2)
          .children(
            log.rows.map((e) =>
              h_flex()
                .id(`ev-row-${e.id}`)
                .gap(8)
                .text_size(12)
                .child(div().w(62).flex_none().text_color(t.dim).child(e.time))
                .child(div().w(64).flex_none().font_semibold().child(e.ticket))
                .child(div().w(150).flex_none().truncate().text_color(tone(t, e.tone)).child(e.type))
                .child(div().flex_1().min_w(0).text_color(t.muted).child(e.text)),
            ),
          ),
      );
  }

  /** The tickets of the open run with their state and, while it is active, retry and cancel buttons. */
  activityTickets(t: Theme, run: RunModel, summaries: Summaries): El {
    return v_flex()
      .gap(4)
      .children(
        Object.values(run.tickets)
          .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }))
          .map((rt) =>
            h_flex()
              .id(`act-ticket-${rt.key}`)
              .gap(8)
              .items_center()
              .text_size(12)
              .child(div().w(70).font_semibold().child(rt.key))
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .truncate()
                  .text_color(t.muted)
                  .child(summaries[rt.key] ?? ""),
              )
              .child(toneBadge(t, rt.tone, rt.label))
              .children(
                ticketRunActions(run.id, rt, run.status).map((a) => this.actionButton(t, a, `act-${a.id}`)),
              ),
          ),
      );
  }

  // --- Agent profiles (Phase 7)

  /** Opens a draft in the editor: the text fields are set from it, and the issues cleared. */
  edit(d: ProfileDraft | null, cx: El) {
    this.editing = d;
    this.profileIssues = [];
    if (d) {
      this.pf.id?.set_value(d.id);
      this.pf.name?.set_value(d.name);
      this.pf.model?.set_value(d.model);
      this.pf.args?.set_value(d.args);
      this.pf.instructions?.set_value(d.instructions);
      this.pf.timeout?.set_value(d.timeout_min);
      this.pf.attempts?.set_value(d.max_attempts);
    }
    cx.notify();
  }

  /** The draft with whatever is typed in the fields. */
  typedDraft(): ProfileDraft | null {
    const d = this.editing;
    if (!d) return null;
    return {
      ...d,
      id: this.pf.id?.value() ?? d.id,
      name: this.pf.name?.value() ?? d.name,
      model: this.pf.model?.value() ?? d.model,
      args: this.pf.args?.value() ?? d.args,
      instructions: this.pf.instructions?.value() ?? d.instructions,
      timeout_min: this.pf.timeout?.value() ?? d.timeout_min,
      max_attempts: this.pf.attempts?.value() ?? d.max_attempts,
    };
  }

  /** Validates with the schema, then sends the whole profile; issues stay on screen until fixed. */
  saveProfile(cx: El) {
    const d = this.typedDraft();
    if (!d) return;
    const r = buildProfile(
      d,
      this.profiles.map((p) => p.id),
      new Date().toISOString(),
    );
    if (!r.ok) {
      this.profileIssues = r.issues;
      cx.notify();
      return;
    }
    this.profileIssues = [];
    const a = saveProfileAction(r.profile);
    this.run(cx, a.command, a.args, (ok) => {
      if (ok) {
        // Reload put it in the list; keep it open as a saved profile.
        this.editing = draftOf(r.profile);
        this.message = { text: `Saved profile ${r.profile.name}.`, error: false };
      }
    });
  }

  profilesView(t: Theme): El {
    const d = this.editing;
    const ids = this.profiles.map((p) => p.id);
    const toggle = (id: string, label: string, on: boolean, set: (v: boolean) => void) =>
      h_flex()
        .id(id)
        .gap(8)
        .items_center()
        .text_size(12)
        .cursor_pointer()
        .on_click((_e: unknown, cx: El) => {
          set(!on);
          cx.notify();
        })
        .child(
          div()
            .w(14)
            .h(14)
            .rounded(3)
            .border(1)
            .border_color(t.input)
            .bg(on ? t.accent : t.surface)
            .text_color(t.accent_foreground)
            .text_size(10)
            .child(on ? "✓" : ""),
        )
        .child(label);
    const list = v_flex()
      .id("profile-list")
      .w(300)
      .h_full()
      .flex_none()
      .overflow_y_scrollbar()
      .p(14)
      .gap(8)
      .border_r(1)
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .child(section(t, `Agent profiles (${this.profiles.length})`))
          .child(div().flex_1())
          .child(button(t, "new-profile", "New profile", false, (cx: El) => this.edit(blankDraft(), cx))),
      )
      .when(this.profiles.length === 0, (el: El) =>
        el.child(div().text_size(13).text_color(t.muted).child("No profiles found in ~/.collie/profiles.")),
      )
      .children(
        this.profiles.map((p) => {
          const open = !!d && !d.isNew && d.id === p.id;
          return v_flex()
            .id(`profile-${p.id}`)
            .gap(3)
            .p(10)
            .rounded(6)
            .border(1)
            .border_color(open ? t.accent : t.border)
            .bg(open ? t.selected : t.surface)
            .cursor_pointer()
            .hover((h: El) => h.bg(t.hover))
            .on_click((_e: unknown, cx: El) => this.edit(draftOf(p), cx))
            .child(div().text_size(13).font_semibold().child(p.name))
            .child(div().text_size(11).text_color(t.muted).child(`${p.role} · ${p.harness} · ${p.model}`))
            .child(
              h_flex().child(
                button(t, `dup-${p.id}`, "Duplicate", false, (cx: El) =>
                  this.edit(duplicateDraft(p, ids), cx),
                ),
              ),
            );
        }),
      );
    const editor = (e: ProfileDraft): El =>
      v_flex()
        .id("profile-editor")
        .flex_1()
        .min_w(0)
        .h_full()
        .overflow_y_scrollbar()
        .p(16)
        .gap(10)
        .child(
          div()
            .text_size(15)
            .font_semibold()
            .child(e.isNew ? "New profile" : `Edit ${e.name}`),
        )
        .child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child(
              "Each field is one line: write a line break as \\n. A run uses the profile as it was when the run started.",
            ),
        )
        .when(e.isNew, (el: El) =>
          el.child(field(t, "Id (a slug; blank uses the name)", this.pf.id as InputState)),
        )
        .when(!e.isNew, (el: El) => el.child(kv(t, "Id", e.id)))
        .child(field(t, "Name", this.pf.name as InputState))
        .child(
          v_flex()
            .gap(4)
            .child(div().text_size(12).text_color(t.muted).child("Role"))
            .child(
              e.isNew
                ? h_flex()
                    .gap(6)
                    .children(
                      ROLE_OPTIONS.map((r) =>
                        pill(t, `role-${r}`, r, e.role === r, (cx: El) => {
                          e.role = r;
                          cx.notify();
                        }),
                      ),
                    )
                : div().text_size(13).child(`${e.role} (fixed once saved: workflows rely on it)`),
            ),
        )
        .child(
          v_flex()
            .gap(4)
            .child(div().text_size(12).text_color(t.muted).child("Harness"))
            .child(
              h_flex()
                .gap(6)
                .children(
                  [...new Set<string>([...HARNESSES, e.harness])].map((hn) =>
                    pill(t, `harness-${hn}`, hn, e.harness === hn, (cx: El) => {
                      e.harness = hn;
                      cx.notify();
                    }),
                  ),
                ),
            ),
        )
        .child(field(t, "Model", this.pf.model as InputState))
        .child(field(t, "Extra arguments (one per line, written \\n)", this.pf.args as InputState))
        .child(field(t, "Instructions", this.pf.instructions as InputState))
        .child(
          h_flex()
            .gap(16)
            .child(
              toggle("perm-write", "Write to the worktree", e.write_worktree, (v) => {
                e.write_worktree = v;
              }),
            )
            .child(
              toggle("perm-shell", "Run shell commands", e.shell, (v) => {
                e.shell = v;
              }),
            )
            .child(
              toggle("perm-net", "Use the network", e.network, (v) => {
                e.network = v;
              }),
            ),
        )
        .child(
          h_flex()
            .gap(12)
            .child(
              div()
                .w(200)
                .child(field(t, "Timeout (minutes)", this.pf.timeout as InputState)),
            )
            .child(
              div()
                .w(200)
                .child(field(t, "Max attempts", this.pf.attempts as InputState)),
            ),
        )
        .when(this.profileIssues.length > 0, (el: El) =>
          el.child(
            v_flex()
              .gap(2)
              .p(8)
              .rounded(6)
              .border(1)
              .border_color(t.blocked)
              .text_size(12)
              .text_color(t.blocked)
              .children(this.profileIssues.map((i) => div().child(i))),
          ),
        )
        .child(
          h_flex()
            .gap(8)
            .child(
              button(t, "save-profile", "Save profile", this.busy || !this.alive, (cx: El) =>
                this.saveProfile(cx),
              ),
            )
            .child(button(t, "close-profile", "Close", false, (cx: El) => this.edit(null, cx))),
        );
    return h_flex()
      .size_full()
      .child(list)
      .child(
        d
          ? editor(d)
          : div()
              .p(16)
              .text_size(13)
              .text_color(t.muted)
              .child("Pick a profile to edit, or create a new one."),
      );
  }

  /** Buttons for model actions; each runs its `collie ctl` command. */
  actionButtons(t: Theme, actions: Action[]): El[] {
    return actions.map((a) => this.actionButton(t, a, a.id));
  }

  /**
   * One action as a button. A cancel or delete (needsConfirm) first turns into "<label>? Yes No":
   * the command is sent only on Yes, and any other redraw-causing command clears the question.
   */
  actionButton(
    t: Theme,
    a: { label: string; command: string; args: Record<string, unknown> },
    id: string,
    disabled = false,
  ): El {
    if (needsConfirm(a.command) && this.confirming === id)
      return h_flex()
        .gap(6)
        .items_center()
        .child(div().text_size(12).text_color(t.blocked).child(`${a.label}?`))
        .child(button(t, `${id}-yes`, "Yes", this.busy, (cx: El) => this.run(cx, a.command, a.args)))
        .child(
          button(t, `${id}-no`, "No", false, (cx: El) => {
            this.confirming = null;
            cx.notify();
          }),
        );
    return button(t, id, a.label, this.busy || disabled, (cx: El) => {
      if (needsConfirm(a.command)) {
        this.confirming = id;
        cx.notify();
      } else this.run(cx, a.command, a.args);
    });
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

function field(t: Theme, label: string, state: InputState): El {
  return v_flex()
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

const tone = (t: Theme, name: Tone): `#${string}` => t[name] as `#${string}`;

const execTone = (e: ExecView): Tone =>
  e.blocked
    ? "blocked"
    : e.state === "working" || e.state === "starting" || e.state === "created"
      ? "working"
      : e.state === "completed"
        ? "done"
        : e.state === "failed"
          ? "blocked"
          : "dim";

/** A state in words, with its colored dot. */
function toneBadge(t: Theme, name: Tone, label: string): El {
  return h_flex()
    .gap(6)
    .items_center()
    .text_size(12)
    .child(div().w(8).h(8).rounded(4).bg(tone(t, name)))
    .child(label);
}

/** The small marker under a graph node: its newest agent (or the count), with a dot for its state. */
function execChip(t: Theme, key: string, text: string, e: ExecView): El {
  return h_flex()
    .id(`chip-${key}-${e.id}`)
    .gap(3)
    .items_center()
    .text_size(10)
    .text_color(t.muted)
    .child(
      div()
        .w(6)
        .h(6)
        .rounded(3)
        .bg(tone(t, execTone(e))),
    )
    .child(text);
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
