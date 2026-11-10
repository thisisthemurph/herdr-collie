// The controller: owns runs, processes control commands and inboxes, survives being killed.
// Phase 2 scope: no scheduling, no agents, no Jira, no Herdr (docs/plan.md).
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type AnyEvent,
  type Board,
  type CommandReply,
  type ErrorCode,
  formatIssues,
  type Profile,
  type RunFile,
  validateBoard,
  validateCommand,
  validateProfile,
} from "@collie/schema";
import { type AgentOptions, Agents } from "./agents.ts";
import { handleCommand } from "./commands.ts";
import { Delivery, type DeliveryOptions } from "./delivery.ts";
import { type Clock, type EventOpts, makeEvent } from "./events.ts";
import { type Home, readJson, writeJsonAtomic } from "./home.ts";
import { processInbox, resumeTicketIfClear } from "./inbox.ts";
import type { JiraClient } from "./jira.ts";
import {
  EXECUTION_TRANSITIONS,
  isExecutionFinal,
  isLegal,
  isTicketFinal,
  TICKET_TRANSITIONS,
} from "./machines.ts";
import { type Logger, RunLog } from "./runlog.ts";

export class CommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type Ok = Record<string, unknown>;
type Outcome = { ok: true; result: Ok } | { ok: false; code: ErrorCode; message: string };

export class Controller {
  /** Runs that haven't ended: their inboxes are watched. */
  readonly runs = new Map<string, RunLog>();
  /** Boards' preparation logs (the requirements analyst), by board id. They aren't runs. */
  readonly preps = new Map<string, RunLog>();
  /** Ended runs that still have an open PR: they stay loaded so its tracking can be written down. */
  readonly tracked = new Map<string, RunLog>();
  /** Delivery to the code host (Phase 6). Null without one: tickets complete as they pass the gate. */
  readonly delivery: Delivery | null;
  /** The command being handled, so a run it ends can log it before ending. */
  private currentCommand: { id: string; command: string } | null = null;

  /** Agent execution (Phase 4). Null when the controller has no hc to start agents with. */
  readonly agents: Agents | null;

  constructor(
    readonly home: Home,
    readonly clock: Clock,
    readonly log: Logger,
    private readonly jira: JiraClient | null = null,
    agentOptions: AgentOptions | null = null,
    deliveryOptions: DeliveryOptions | null = null,
  ) {
    this.agents = agentOptions ? new Agents(this, agentOptions) : null;
    this.delivery = deliveryOptions ? new Delivery(this, deliveryOptions) : null;
  }

  /** Every log with executions to watch: the live runs, then the boards' preparation logs. */
  allLogs(): RunLog[] {
    return [...this.runs.values(), ...this.preps.values()];
  }

  isLive(rl: RunLog): boolean {
    return rl.prep ? this.preps.get(rl.id) === rl : this.runs.get(rl.id) === rl;
  }

  /** A run, or a board's preparation log, by the id a command names it with. */
  logFor(id: string): RunLog | undefined {
    return this.runs.get(id) ?? this.preps.get(id);
  }

  /** Runs the inbox watcher over one execution now (and returns how many lines it judged). */
  sweepInbox(rl: RunLog, execId: string): number {
    return processInbox(rl, execId, this.clock, this.agents?.hooks);
  }

  /** After recover(): reattach to what hc is running, and finish what a crash left half done. */
  async reconcile(): Promise<void> {
    if (this.agents) await this.agents.reconcile();
  }

  requireJira(): JiraClient {
    if (!this.jira) throw new CommandError("unsupported", "this controller has no Jira client");
    return this.jira;
  }

  // --- start-up

  /** Recovery on start (protocol, "Lifecycle rules"), without Herdr reconciliation. */
  recover(): void {
    this.home.ensureLayout();
    for (const id of readdirSync(this.home.runs).sort()) {
      if (!existsSync(this.home.runFile(id))) continue;
      const run = readJson(this.home.runFile(id)) as RunFile;
      if (run.status !== "running" && run.status !== "paused") {
        this.recoverTracked(id);
        continue;
      }
      const rl = RunLog.load(this.home, id, this.log);
      // A crash between the final event and the run.json rewrite: the log wins.
      if (rl.state.status !== rl.run.status) this.syncRunFile(rl);
      if (rl.state.status === "running" || rl.state.status === "paused") this.runs.set(id, rl);
      rl.flush(this.clock.now());
      this.log(`recovered run ${id} (${rl.state.status}, ${rl.ids.size} events)`);
    }
    this.saveLeases();
    this.recoverPreps();
  }

  /**
   * An ended run is read-only, except that while one of its PRs is open the controller keeps
   * tracking it (protocol, "Phase 6 rules"). The cheap check is the saved state.json.
   */
  private recoverTracked(id: string): void {
    if (!this.delivery || !existsSync(this.home.state(id))) return;
    try {
      const s = readJson(this.home.state(id)) as {
        tickets?: Record<string, { pr?: { state?: string } | null }>;
      };
      if (!Object.values(s.tickets ?? {}).some((t) => t.pr?.state === "OPEN")) return;
      const rl = RunLog.load(this.home, id, this.log);
      if (this.delivery.hasOpenPrs(rl)) {
        this.tracked.set(id, rl);
        this.log(`tracking the open PRs of ended run ${id}`);
      }
    } catch (e) {
      this.log(`run ${id}: couldn't load it to track its PRs: ${(e as Error).message}`);
    }
  }

  /** Boards that have analyst executions get their preparation log back. */
  private recoverPreps(): void {
    for (const id of readdirSync(this.home.boards).sort()) {
      if (!existsSync(this.home.prepEvents(id))) continue;
      try {
        this.prepLog(id);
        this.log(`recovered the preparation log of board ${id}`);
      } catch (e) {
        this.log(`board ${id}: couldn't recover its preparation log: ${(e as Error).message}`);
      }
    }
  }

  /** A board's preparation log, loaded or started. */
  prepLog(boardId: string): RunLog {
    const have = this.preps.get(boardId);
    if (have) return have;
    const board = this.loadBoard(boardId);
    const profiles: Record<string, Profile> = {};
    for (const id of existsSync(join(this.home.root, "profiles"))
      ? readdirSync(join(this.home.root, "profiles"))
      : []) {
      if (!id.endsWith(".json")) continue;
      const r = validateProfile(readJson(join(this.home.root, "profiles", id)));
      if (r.ok && r.value.role === "analyst") profiles[r.value.id] = r.value;
    }
    const rl = RunLog.prep(this.home, board, profiles, this.log);
    this.preps.set(boardId, rl);
    return rl;
  }

  // --- the loop

  /**
   * One pass: start on pending commands (they run one at a time, and may wait on Jira), then
   * every watched inbox, then due state.json writes. State only changes between awaits, so a
   * command and the inbox watcher never see each other half-done.
   */
  tick(): void {
    if (!this.commandsBusy) {
      this.processCommands().catch((e) => this.log(`command loop failed: ${(e as Error).stack ?? e}`));
    }
    for (const rl of [...this.runs.values(), ...this.preps.values()]) {
      for (const execId of Object.keys(rl.state.executions)) this.sweepInbox(rl, execId);
      this.agents?.tick(rl);
      if (!rl.prep) this.delivery?.tick(rl);
      rl.maybeFlush(this.clock.now());
    }
    for (const [id, rl] of this.tracked) {
      this.delivery?.tick(rl);
      rl.maybeFlush(this.clock.now());
      if (!this.delivery?.hasOpenPrs(rl)) {
        rl.flush(this.clock.now());
        this.tracked.delete(id);
        this.log(`run ${id}: no open PRs left to track`);
      }
    }
  }

  flushAll(): void {
    for (const rl of [...this.allLogs(), ...this.tracked.values()]) rl.flush(this.clock.now());
  }

  // --- control commands

  private commandsBusy: Promise<void> | null = null;

  /** Handles every pending command in id order, one at a time. */
  processCommands(): Promise<void> {
    // A pass already running may have listed the folder before a new file arrived: wait for
    // it, then look again.
    if (this.commandsBusy) return this.commandsBusy.then(() => this.processCommands());
    const work = async () => {
      let files: string[];
      try {
        files = readdirSync(this.home.pending)
          .filter((f) => f.endsWith(".json"))
          .sort();
      } catch {
        return;
      }
      for (const f of files) await this.processCommandFile(join(this.home.pending, f));
    };
    // Cleared in .finally(), which always runs after this assignment, even when `work`
    // finishes synchronously (no pending files).
    this.commandsBusy = work().finally(() => {
      this.commandsBusy = null;
    });
    return this.commandsBusy;
  }

  private async processCommandFile(path: string): Promise<void> {
    const name = path.split("/").at(-1) as string;
    const donePath = join(this.home.done, name);
    if (existsSync(donePath)) {
      // Replied to before a crash; the pending file just wasn't removed yet.
      tryUnlink(path);
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      // `collie ctl` writes atomically, so an unreadable file is garbage: answer and drop it.
      this.reply(path, donePath, name.replace(/\.json$/, ""), {
        ok: false,
        code: "invalid_args",
        message: `unreadable command file: ${(e as Error).message}`,
      });
      return;
    }
    const id =
      typeof (raw as { id?: unknown })?.id === "string"
        ? (raw as { id: string }).id
        : name.replace(/\.json$/, "");
    const v = validateCommand(raw);
    if (!v.ok) {
      this.reply(path, donePath, id, { ok: false, code: "invalid_args", message: formatIssues(v.issues) });
      return;
    }
    const cmd = v.value;
    let outcome: Outcome;
    this.currentCommand = { id: cmd.id, command: cmd.command };
    try {
      outcome = { ok: true, result: await handleCommand(this, cmd) };
    } catch (e) {
      if (e instanceof CommandError) {
        outcome = { ok: false, code: e.code, message: e.message };
      } else {
        this.log(`command ${cmd.id} (${cmd.command}) failed: ${(e as Error).stack ?? e}`);
        outcome = { ok: false, code: "internal", message: `internal error: ${(e as Error).message}` };
      }
    }
    this.currentCommand = null;
    // A run command is logged in the run it acts on (run.start logs its own command.applied).
    const runId = (cmd.args as { run_id?: string }).run_id;
    const rl = runId ? (this.logFor(runId) ?? this.tracked.get(runId)) : undefined;
    if (rl && !rl.commandIds.has(cmd.id)) {
      const o = { cause: cmd.id, source: "human" as const };
      this.emit(rl, [
        outcome.ok
          ? this.event(rl.id, "command.applied", { command: cmd.command }, o)
          : this.event(
              rl.id,
              "command.rejected",
              { command: cmd.command, code: outcome.code, reason: outcome.message },
              o,
            ),
      ]);
    }
    this.reply(path, donePath, cmd.id, outcome);
  }

  private reply(pendingPath: string, donePath: string, id: string, outcome: Outcome) {
    const reply: CommandReply = outcome.ok
      ? { v: 1, id, ok: true, result: outcome.result }
      : { v: 1, id, ok: false, error: { code: outcome.code, message: outcome.message } };
    writeJsonAtomic(donePath, reply);
    tryUnlink(pendingPath);
  }

  // --- helpers for command handlers

  event(runId: string, type: string, payload: Record<string, unknown>, o: EventOpts = {}): AnyEvent {
    return makeEvent(this.clock, runId, type, payload, o);
  }

  emit(rl: RunLog, events: AnyEvent[]): void {
    rl.emit(events, this.clock.now());
  }

  /** A ticket transition event, refused unless the state machine allows it. */
  ticketTo(rl: RunLog, ticket: string, to: string, reason: string, o: EventOpts = {}): AnyEvent {
    const t = rl.state.tickets[ticket];
    const from = t?.state ?? null;
    const legal =
      from === "needs_input" && to !== "cancelled"
        ? to === t?.resume_state
        : isLegal(TICKET_TRANSITIONS, from as never, to as never);
    if (!legal)
      throw new CommandError("invalid_state", `${ticket} can't go from ${from ?? "(new)"} to ${to}`);
    return this.event(rl.id, "ticket.state_changed", { from, to, reason }, { ...o, ticket });
  }

  /** An execution transition event, refused unless the state machine allows it. */
  execTo(rl: RunLog, execId: string, to: string, reason: string, o: EventOpts = {}): AnyEvent {
    const e = rl.state.executions[execId];
    if (!e) throw new CommandError("not_found", `execution ${execId} is not in run ${rl.id}`);
    if (!isLegal(EXECUTION_TRANSITIONS, e.state, to as never)) {
      throw new CommandError("invalid_state", `execution ${execId} can't go from ${e.state} to ${to}`);
    }
    return this.event(
      rl.id,
      "execution.state_changed",
      { from: e.state, to, reason },
      { ...o, ticket: e.ticket, exec: execId },
    );
  }

  /** Cancels every non-final execution of a ticket. Returns their ids, for killing their terminals. */
  cancelExecutions(rl: RunLog, ticket: string, reason: string, cause: string): string[] {
    const ids: string[] = [];
    for (const [id, e] of Object.entries(rl.state.executions)) {
      if (e.ticket === ticket && !isExecutionFinal(e.state)) {
        this.emit(rl, [this.execTo(rl, id, "cancelled", reason, { cause, source: "human" })]);
        ids.push(id);
      }
    }
    return ids;
  }

  cancelExecution(rl: RunLog, execId: string, reason: string, cause: string): void {
    this.emit(rl, [this.execTo(rl, execId, "cancelled", reason, { cause, source: "human" })]);
    this.emit(rl, resumeTicketIfClear(rl, execId, this.clock, cause));
  }

  /** Ends the terminals of cancelled executions (hc kill), logging each. */
  async killTerminals(rl: RunLog, execIds: string[], reason: string): Promise<void> {
    await this.agents?.killExecutions(rl, execIds, reason);
  }

  /** Ends a run as completed once every leased ticket is completed or cancelled. */
  completeRunIfDone(rl: RunLog, cause: string | null): void {
    if (rl.state.status !== "running") return;
    const keys = rl.state.leases;
    if (keys.length && !keys.every((k) => isTicketFinal(rl.state.tickets[k]?.state ?? "pending"))) return;
    // A completed ticket whose PR isn't open yet (`implemented`, or a delivery that failed) keeps the run going.
    if (this.delivery?.pending(rl)) return;
    this.endRun(rl, "completed", "every ticket completed or cancelled", cause, "controller");
  }

  endRun(
    rl: RunLog,
    status: "completed" | "cancelled",
    reason: string,
    cause: string | null,
    source: "controller" | "human",
  ) {
    // A run is read-only once it ends, so the command that ended it is logged first.
    const cmd = this.currentCommand;
    const applied =
      cmd && !rl.commandIds.has(cmd.id)
        ? [this.event(rl.id, "command.applied", { command: cmd.command }, { cause: cmd.id, source: "human" })]
        : [];
    this.emit(rl, [
      ...applied,
      ...rl.state.leases.map((k) => this.event(rl.id, "ticket.released", {}, { ticket: k, cause })),
      this.event(rl.id, `run.${status}`, { reason }, { cause, source }),
    ]);
    this.syncRunFile(rl);
    rl.flush(this.clock.now());
    this.runs.delete(rl.id);
    if (this.delivery?.hasOpenPrs(rl)) this.tracked.set(rl.id, rl);
    this.saveLeases();
  }

  /** run.json follows the run's status, end time and end reason from the log. */
  syncRunFile(rl: RunLog): void {
    const ended = rl.state.status === "completed" || rl.state.status === "cancelled";
    rl.saveRun({
      status: rl.state.status,
      ended_at: ended ? (rl.ended?.at ?? null) : null,
      end_reason: ended ? (rl.ended?.reason ?? null) : null,
    });
  }

  /** leases.json: every ticket held by a live run. */
  leases(): Map<string, string> {
    const out = new Map<string, string>();
    for (const rl of this.runs.values()) for (const k of rl.state.leases) out.set(k, rl.id);
    return out;
  }

  saveLeases(): void {
    writeJsonAtomic(this.home.leases, {
      v: 1,
      leases: Object.fromEntries([...this.leases()].sort()),
      updated_at: new Date(this.clock.now()).toISOString(),
    });
  }

  loadBoard(boardId: string): Board {
    const path = this.home.board(boardId);
    if (!existsSync(path)) throw new CommandError("not_found", `board ${boardId} doesn't exist`);
    const r = validateBoard(readJson(path));
    if (!r.ok)
      throw new CommandError("internal", `board ${boardId} is invalid on disk: ${formatIssues(r.issues)}`);
    return r.value;
  }

  saveBoard(board: Board): void {
    writeJsonAtomic(this.home.board(board.id), { ...board, updated_at: isoSeconds(this.clock.now()) });
  }

  /** requireRun, but a board id names its preparation log (for answers and cancels, which work there too). */
  requireLog(id: string): RunLog {
    return this.preps.get(id) ?? this.requireRun(id);
  }

  /** requireRun, but an ended run that still tracks open PRs counts (for pr.mark_ready). */
  requireRunOrTracked(runId: string): RunLog {
    return this.runs.get(runId) ?? this.tracked.get(runId) ?? this.requireRun(runId);
  }

  requireRun(runId: string): RunLog {
    const rl = this.runs.get(runId);
    if (rl) return rl;
    if (existsSync(this.home.runFile(runId))) {
      const run = readJson(this.home.runFile(runId)) as RunFile;
      throw new CommandError("invalid_state", `run ${runId} has ended (${run.status})`);
    }
    throw new CommandError("not_found", `run ${runId} doesn't exist`);
  }
}

export const isoSeconds = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

function tryUnlink(path: string) {
  try {
    unlinkSync(path);
  } catch {}
}
