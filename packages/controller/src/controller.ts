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
  type RunFile,
  validateBoard,
  validateCommand,
} from "@collie/schema";
import { handleCommand } from "./commands.ts";
import { type Clock, type EventOpts, makeEvent } from "./events.ts";
import { type Home, readJson, writeJsonAtomic } from "./home.ts";
import { processInbox, resumeTicketIfClear } from "./inbox.ts";
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
  /** The command being handled, so a run it ends can log it before ending. */
  private currentCommand: { id: string; command: string } | null = null;

  constructor(
    readonly home: Home,
    readonly clock: Clock,
    readonly log: Logger,
  ) {}

  // --- start-up

  /** Recovery on start (protocol, "Lifecycle rules"), without Herdr reconciliation. */
  recover(): void {
    this.home.ensureLayout();
    for (const id of readdirSync(this.home.runs).sort()) {
      if (!existsSync(this.home.runFile(id))) continue;
      const run = readJson(this.home.runFile(id)) as RunFile;
      if (run.status !== "running" && run.status !== "paused") continue;
      const rl = RunLog.load(this.home, id, this.log);
      // A crash between the final event and the run.json rewrite: the log wins.
      if (rl.state.status !== rl.run.status) this.syncRunFile(rl);
      if (rl.state.status === "running" || rl.state.status === "paused") this.runs.set(id, rl);
      rl.flush(this.clock.now());
      this.log(`recovered run ${id} (${rl.state.status}, ${rl.ids.size} events)`);
    }
    this.saveLeases();
  }

  // --- the loop

  /** One pass: pending commands, then every watched inbox, then due state.json writes. */
  tick(): void {
    this.processCommands();
    for (const rl of [...this.runs.values()]) {
      for (const execId of Object.keys(rl.state.executions)) processInbox(rl, execId, this.home, this.clock);
      rl.maybeFlush(this.clock.now());
    }
  }

  flushAll(): void {
    for (const rl of this.runs.values()) rl.flush(this.clock.now());
  }

  // --- control commands

  processCommands(): void {
    let files: string[];
    try {
      files = readdirSync(this.home.pending)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return;
    }
    for (const f of files) this.processCommandFile(join(this.home.pending, f));
  }

  private processCommandFile(path: string): void {
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
      outcome = { ok: true, result: handleCommand(this, cmd) };
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
    const rl = runId ? this.runs.get(runId) : undefined;
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

  /** Cancels every non-final execution of a ticket (Phase 4 will also kill their terminals). */
  cancelExecutions(rl: RunLog, ticket: string, reason: string, cause: string): void {
    for (const [id, e] of Object.entries(rl.state.executions)) {
      if (e.ticket === ticket && !isExecutionFinal(e.state)) {
        this.emit(rl, [this.execTo(rl, id, "cancelled", reason, { cause, source: "human" })]);
      }
    }
  }

  cancelExecution(rl: RunLog, execId: string, reason: string, cause: string): void {
    this.emit(rl, [this.execTo(rl, execId, "cancelled", reason, { cause, source: "human" })]);
    this.emit(rl, resumeTicketIfClear(rl, execId, this.clock, cause));
  }

  /** Ends a run as completed once every leased ticket is completed or cancelled. */
  completeRunIfDone(rl: RunLog, cause: string | null): void {
    if (rl.state.status !== "running") return;
    const keys = rl.state.leases;
    if (keys.length && !keys.every((k) => isTicketFinal(rl.state.tickets[k]?.state ?? "pending"))) return;
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
