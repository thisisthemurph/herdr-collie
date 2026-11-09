// Test helpers: a scratch COLLIE_HOME with profiles, a workflow and a board; an in-process
// controller on a fake clock; and seeding of executions (Phase 2 has no launcher, so tests
// write the events Phase 4's launcher will write).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnyEvent,
  type Board,
  type Command,
  type CommandReply,
  newUlid,
  parseEventLine,
} from "@collie/schema";
import { Controller } from "../src/controller.ts";
import { Home, writeJsonAtomic } from "../src/home.ts";
import type { RunLog } from "../src/runlog.ts";

export const FIXTURES = join(import.meta.dir, "../../../fixtures");
export const CONTROLLER_BIN = join(import.meta.dir, "../bin/collie-controller");
export const CLI_BIN = join(import.meta.dir, "../../cli/bin/collie");
const fixture = (p: string) => JSON.parse(readFileSync(join(FIXTURES, p), "utf8"));

export type Scratch = { root: string; home: Home; cleanup: () => void };

/** A COLLIE_HOME with the fixture profiles and workflows saved. */
export function scratchHome(): Scratch {
  const root = mkdtempSync(join(tmpdir(), "collie-ctl-"));
  const home = new Home(root);
  home.ensureLayout();
  for (const p of ["developer", "security-reviewer", "requirements-analyst"]) {
    writeJsonAtomic(home.profile(p), fixture(`files/profile/valid/${p}.json`));
  }
  for (const w of ["standard-feature", "small-bug-fix"])
    writeJsonAtomic(home.workflow(w), fixture(`files/workflow/valid/${w}.json`));
  return { root, home, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Saves a board with the given on-board tickets (summary only matters for display). */
export function saveBoard(home: Home, id: string, tickets: string[], extra: Partial<Board> = {}): Board {
  const base = fixture("files/board/valid/board.json") as Board;
  const t = base.tickets["PAY-101"] as Board["tickets"][string];
  const board: Board = {
    ...base,
    id,
    tickets: Object.fromEntries(tickets.map((k) => [k, { ...t, summary: `Ticket ${k}`, blocked_by: [] }])),
    ...extra,
  };
  writeJsonAtomic(home.board(id), board);
  return board;
}

/** A clock that only moves when told, with ids that sort by creation. */
export function fakeClock(start = Date.parse("2026-11-09T10:00:00.000Z")) {
  let now = start;
  return { now: () => now, id: () => newUlid(now), advance: (ms: number) => (now += ms) };
}

export function inProcess(s: Scratch, log: string[] = []) {
  const clock = fakeClock();
  const c = new Controller(s.home, clock, (m) => log.push(m));
  c.recover();
  return { c, clock, log };
}

/** Sends a command through control/pending and runs one tick; returns the reply. */
export function command(
  c: Controller,
  command: Command["command"],
  args: unknown,
  id = newUlid(),
): CommandReply {
  writeJsonAtomic(join(c.home.pending, `${id}.json`), {
    v: 1,
    id,
    command,
    at: "2026-11-09T10:00:00Z",
    args,
  });
  c.processCommands();
  return JSON.parse(readFileSync(join(c.home.done, `${id}.json`), "utf8"));
}

export function ok(r: CommandReply): Record<string, unknown> {
  if (!r.ok) throw new Error(`command failed: ${r.error.code}: ${r.error.message}`);
  return r.result;
}

/** Adds a started, working execution to a run, as Phase 4's launcher will. Returns its id. */
export function seedExecution(
  c: Controller,
  rl: RunLog,
  ticket: string,
  role: "developer" | "reviewer" | "analyst",
  opts: { state?: "working" | "starting"; kind?: string; id?: string } = {},
): string {
  const exec = opts.id ?? c.clock.id();
  const kind = opts.kind ?? (role === "reviewer" ? "review" : role === "analyst" ? "analyse" : "develop");
  const o = { ticket, exec };
  const events: AnyEvent[] = [
    c.event(
      rl.id,
      "execution.created",
      {
        profile: role === "reviewer" ? "security-reviewer" : "developer",
        role,
        kind,
        round: 1,
        attempt: 1,
        worktree: `~/.herdr/worktrees/[REPO]/${ticket.toLowerCase()}`,
        branch: ticket.toLowerCase(),
        base: "main",
      },
      o,
    ),
    c.event(rl.id, "execution.state_changed", { from: null, to: "created", reason: "seeded by a test" }, o),
    c.event(rl.id, "execution.started", { terminal: "t1" }, o),
    c.event(
      rl.id,
      "execution.state_changed",
      { from: "created", to: "starting", reason: "seeded by a test" },
      o,
    ),
  ];
  if ((opts.state ?? "working") === "working") {
    events.push(
      c.event(
        rl.id,
        "execution.state_changed",
        { from: "starting", to: "working", reason: "seeded by a test" },
        o,
      ),
    );
  }
  c.emit(rl, events);
  mkdirSync(c.home.execDir(rl.id, exec), { recursive: true });
  return exec;
}

/** Moves a seeded ticket from pending to in_progress (scheduling arrives in Phase 3 and 4). */
export function seedTicketInProgress(c: Controller, rl: RunLog, ticket: string) {
  c.emit(rl, [
    c.event(
      rl.id,
      "ticket.state_changed",
      { from: "pending", to: "ready", reason: "seeded by a test" },
      { ticket },
    ),
    c.event(
      rl.id,
      "ticket.state_changed",
      { from: "ready", to: "in_progress", reason: "seeded by a test" },
      { ticket },
    ),
  ]);
}

export function readEvents(home: Home, runId: string): AnyEvent[] {
  return readFileSync(home.events(runId), "utf8")
    .split(/(?<=\n)/)
    .filter(Boolean)
    .map((l) => {
      const r = parseEventLine(l);
      if (!r.ok) throw new Error(`invalid event line: ${l}`);
      return r.value;
    });
}

/** An agent inbox line for an execution, as the CLI writes it. */
export function agentLine(
  runId: string,
  execId: string,
  ticket: string,
  type: string,
  payload: Record<string, unknown>,
  id = newUlid(),
) {
  return `${JSON.stringify({ v: 1, id, type, ts: new Date().toISOString(), source: "agent", run_id: runId, execution_id: execId, ticket, caused_by: null, payload })}\n`;
}
