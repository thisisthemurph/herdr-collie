// One run's log: events.jsonl is the truth, and state.json a cache of it. Every state change
// is an event first: emit() appends the events with one write(), then reduces them into the
// live state. state.json is rewritten at most every 250 ms, and always on flush().
import { existsSync, readFileSync, truncateSync } from "node:fs";
import {
  type AnyEvent,
  formatIssues,
  parseEventLine,
  type RunFile,
  type StateFile,
  validateRun,
  validateState,
} from "@collie/schema";
import { appendDurable, type Home, readJson, writeJsonAtomic } from "./home.ts";
import { emptyState, rebuild, reduce } from "./reducer.ts";

export const STATE_WRITE_INTERVAL_MS = 250;

export type Logger = (message: string) => void;

export class RunLog {
  state: StateFile;
  run: RunFile;
  /** Every event id in the log, for de-duplicating inbox lines. */
  readonly ids = new Set<string>();
  /** execution id -> role, from execution.created. */
  readonly roles = new Map<string, string>();
  /** Command ids already logged as command.applied or command.rejected. */
  readonly commandIds = new Set<string>();
  /** When and why the run ended, from run.completed or run.cancelled. */
  ended: { at: string; reason: string } | null = null;
  private dirty = false;
  private lastWrite = 0;

  private constructor(
    private readonly home: Home,
    run: RunFile,
    state: StateFile,
  ) {
    this.run = run;
    this.state = state;
  }

  get id() {
    return this.run.id;
  }

  /** A new run: writes run.json, then the given first events. */
  static create(home: Home, run: RunFile, first: AnyEvent[], now: number): RunLog {
    writeJsonAtomic(home.runFile(run.id), run);
    const log = new RunLog(home, run, emptyState(run.id));
    log.emit(first, now);
    log.flush(now);
    return log;
  }

  /**
   * An existing run, rebuilt from events.jsonl. A torn final line (a crash mid-append) is cut
   * off: the controller is the only writer, so nothing else can still be writing it.
   */
  static load(home: Home, runId: string, log: Logger): RunLog {
    const runR = validateRun(readJson(home.runFile(runId)));
    if (!runR.ok) throw new Error(`run.json of ${runId} is invalid: ${formatIssues(runR.issues)}`);
    const path = home.events(runId);
    let text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const end = text.lastIndexOf("\n") + 1;
    if (end < text.length) {
      // DECISION: truncate a torn tail of events.jsonl on recovery.
      log(`run ${runId}: cut a torn final line of ${text.length - end} bytes from events.jsonl`);
      truncateSync(path, Buffer.byteLength(text.slice(0, end)));
      text = text.slice(0, end);
    }
    const events: AnyEvent[] = [];
    for (const [i, line] of text.split(/(?<=\n)/).entries()) {
      if (!line) continue;
      const r = parseEventLine(line);
      if (!r.ok) {
        log(`run ${runId}: events.jsonl line ${i + 1} is invalid and was skipped: ${formatIssues(r.issues)}`);
        continue;
      }
      events.push(r.value);
    }
    const state = rebuild(runId, events);
    const rl = new RunLog(home, runR.value, state);
    for (const ev of events) rl.track(ev);
    const cached = existsSync(home.state(runId)) ? validateState(readJson(home.state(runId))) : null;
    if (!cached?.ok || JSON.stringify(cached.value) !== JSON.stringify(state)) {
      log(
        `run ${runId}: state.json ${cached ? "was behind events.jsonl" : "was missing"}; rewritten from the event log`,
      );
    }
    rl.dirty = true;
    return rl;
  }

  private track(ev: AnyEvent) {
    this.ids.add(ev.id);
    if (ev.type === "execution.created" && ev.execution_id) this.roles.set(ev.execution_id, ev.payload.role);
    if ((ev.type === "command.applied" || ev.type === "command.rejected") && ev.caused_by)
      this.commandIds.add(ev.caused_by);
    if (ev.type === "run.completed" || ev.type === "run.cancelled") {
      this.ended = { at: ev.ts, reason: (ev.payload as { reason?: string }).reason ?? ev.type };
    }
  }

  /** Appends events in one write, then applies them. */
  emit(events: AnyEvent[], now: number): void {
    if (events.length === 0) return;
    appendDurable(this.home.events(this.id), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    for (const ev of events) {
      reduce(this.state, ev);
      this.track(ev);
    }
    this.dirty = true;
    this.maybeFlush(now);
  }

  maybeFlush(now: number): void {
    if (this.dirty && now - this.lastWrite >= STATE_WRITE_INTERVAL_MS) this.flush(now);
  }

  flush(now: number): void {
    if (!this.dirty) return;
    writeJsonAtomic(this.home.state(this.id), this.state);
    this.dirty = false;
    this.lastWrite = now;
  }

  /** Rewrites run.json, e.g. when the run's status changes. */
  saveRun(patch: Partial<RunFile>): void {
    this.run = { ...this.run, ...patch };
    writeJsonAtomic(this.home.runFile(this.id), this.run);
  }
}
