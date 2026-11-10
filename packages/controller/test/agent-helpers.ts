// Test harness for agent execution: a scratch git repo, a board, a controller whose hc is
// tools/fake-hc, and helpers that play the part of a developer agent.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board, StateFile } from "@collie/schema";
import { type Adapters, defaultAdapters } from "../src/adapters/index.ts";
import { Controller } from "../src/controller.ts";
import { Hc, spawnHc } from "../src/hc.ts";
import type { BriefSource } from "../src/jira.ts";
import type { RunLog } from "../src/runlog.ts";
import {
  agentLine,
  command,
  fakeClock,
  ok,
  readEvents,
  type Scratch,
  saveBoard,
  scratchHome,
} from "./helpers.ts";

export const FAKE_HC = join(import.meta.dir, "../../../tools/fake-hc/bin/hc");
export const FAKE_AGENT = join(import.meta.dir, "../../../tools/fake-agent/src/main.ts");
export const CLI_BIN = join(import.meta.dir, "../../cli/bin/collie");
let commits = 0;
export const BOARD = "01JC8XW0000000000000000001";

export type Agent = {
  match?: { name?: string; labels?: Record<string, string> };
  spawn?: boolean;
  screen?: string;
  run_error?: { kind: string; message: string };
  steps?: Record<string, unknown>[];
};

/** A developer that boots idle, then works. */
export const WORKING: Agent = {
  steps: [
    { on: "run", state: "idle", turn: 0 },
    { on: "get", state: "working", turn: 1 },
  ],
};

export type Harness = {
  s: Scratch;
  c: Controller;
  clock: ReturnType<typeof fakeClock>;
  log: string[];
  repo: string;
  worktrees: string;
  hcDir: string;
  /** Rewrites fake-hc's scenario. */
  scenario: (agents: Agent[]) => void;
  /** hc calls so far. */
  calls: () => { argv: string[]; code: number; from: string | null }[];
  /** A fresh controller on the same home and hc (a restart). */
  restart: () => Controller;
  startRun: () => Promise<string>;
  /** Ticks (advancing the fake clock) until `until` holds. */
  settle: (until: () => boolean, what: string, stepMs?: number) => Promise<void>;
  rl: (runId: string) => RunLog;
  state: (runId: string) => StateFile;
  /** Plays a developer finishing: commits in the ticket's worktree and reports `done`. */
  finish: (runId: string, ticket: string) => string;
  /** Appends an agent event to an execution's inbox, as the collie CLI would. */
  report: (runId: string, execId: string, type: string, payload: Record<string, unknown>) => void;
  /** The ticket's executions of one kind, oldest first. */
  execs: (
    runId: string,
    ticket: string,
    kind?: string,
  ) => { id: string; round: number; attempt: number; state: string }[];
  cleanup: () => Promise<void>;
};

export function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

export function harness(
  opts: {
    tickets?: string[];
    /** blocked -> its blockers */
    blocked_by?: Record<string, string[]>;
    settings?: Partial<Board["settings"]>;
    agents?: Agent[];
    adapters?: Adapters;
    briefs?: BriefSource | null;
    hcEnv?: Record<string, string>;
    options?: Record<string, unknown>;
    profile?: Record<string, unknown>;
    repoPath?: string;
  } = {},
): Harness {
  const s = scratchHome();
  const root = mkdtempSync(join(tmpdir(), "collie-agents-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  const hcDir = join(root, "hc");
  mkdirSync(repo, { recursive: true });
  mkdirSync(hcDir, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "dev@example.com");
  git(repo, "config", "user.name", "Dev");
  writeFileSync(join(repo, "README.md"), "scratch\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");

  const tickets = opts.tickets ?? ["PAY-101", "PAY-102", "PAY-103"];
  const board = saveBoard(s.home, BOARD, tickets, {
    repo: {
      workspace: "[WORKSPACE]",
      slug: "scratch",
      default_branch: "main",
      local_path: opts.repoPath ?? repo,
    },
  });
  board.settings = { ...board.settings, workflow: "small-bug-fix", ...opts.settings };
  for (const [k, v] of Object.entries(opts.blocked_by ?? {}))
    (board.tickets[k] as { blocked_by: string[] }).blocked_by = v;
  writeFileSync(s.home.board(BOARD), JSON.stringify(board, null, 2));
  if (opts.profile) {
    const p = JSON.parse(readFileSync(s.home.profile("developer"), "utf8"));
    writeFileSync(s.home.profile("developer"), JSON.stringify({ ...p, ...opts.profile }, null, 2));
  }

  const scenario = (agents: Agent[]) =>
    writeFileSync(join(hcDir, "scenario.json"), JSON.stringify({ v: 1, agents }, null, 2));
  scenario(opts.agents ?? tickets.flatMap(() => [WORKING, WORKING, WORKING]));

  const clock = fakeClock();
  const log: string[] = [];
  const hc = new Hc(spawnHc(FAKE_HC), {
    ...process.env,
    FAKE_HC_DIR: hcDir,
    COLLIE_BIN: CLI_BIN,
    // The controller runs inside an hc terminal. `hc send` must drop this, or agents get wrapped text.
    HC_TERMINAL_ID: "t99",
    ...opts.hcEnv,
  });
  const make = () =>
    new Controller(s.home, clock, (m) => log.push(m), null, {
      hc,
      adapters: opts.adapters ?? defaultAdapters(() => "/usr/local/bin/claude"),
      briefs: opts.briefs ?? null,
      worktreeRoot: worktrees,
      pollMs: 1_000,
      graceMs: 30_000,
      startTimeoutMs: 60_000,
      waitSeconds: 1,
      ...opts.options,
    });
  const h: Harness = {
    s,
    c: make(),
    clock,
    log,
    repo,
    worktrees,
    hcDir,
    scenario,
    calls: () =>
      existsSync(join(hcDir, "calls.jsonl"))
        ? readFileSync(join(hcDir, "calls.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
    restart: () => {
      h.c = make();
      h.c.recover();
      return h.c;
    },
    startRun: async () => ok(await command(h.c, "run.start", { board_id: BOARD })).run_id as string,
    async settle(until, what, stepMs = 5_000) {
      for (let i = 0; i < 400; i++) {
        if (until()) return;
        h.c.tick();
        await Bun.sleep(12);
        clock.advance(stepMs);
      }
      throw new Error(
        `gave up waiting for ${what}\ncontroller log:\n${log.join("\n")}\nlast events:\n${JSON.stringify(
          readEvents(s.home, [...h.c.runs.keys()][0] ?? "").slice(-8),
          null,
          1,
        )}`,
      );
    },
    rl: (runId) => {
      const rl = h.c.runs.get(runId);
      if (!rl) throw new Error(`run ${runId} has ended`);
      return rl;
    },
    state: (runId) => h.c.runs.get(runId)?.state ?? JSON.parse(readFileSync(s.home.state(runId), "utf8")),
    report: (runId, execId, type, payload) => {
      const ticket = h.state(runId).executions[execId]?.ticket as string;
      appendFileSync(s.home.inbox(runId, execId), agentLine(runId, execId, ticket, type, payload));
    },
    execs: (runId, ticket, kind) => {
      const st = h.state(runId);
      return (st.tickets[ticket]?.executions ?? [])
        .map((id) => ({ id, ...(st.executions[id] as NonNullable<(typeof st.executions)[string]>) }))
        .filter((e) => !kind || e.kind === kind);
    },
    finish: (runId, ticket) => {
      const st = h.state(runId);
      const execId = st.tickets[ticket]?.executions.at(-1) as string;
      const exec = JSON.parse(readFileSync(s.home.executionFile(runId, execId), "utf8"));
      writeFileSync(join(exec.worktree, `${ticket}.txt`), `work on ${ticket} #${++commits}\n`);
      git(exec.worktree, "add", "-A");
      git(exec.worktree, "commit", "-q", "-m", `${ticket}: work`);
      const sha = git(exec.worktree, "rev-parse", "HEAD");
      appendFileSync(
        s.home.inbox(runId, execId),
        agentLine(runId, execId, ticket, "done", { summary: `did ${ticket}`, commits: [sha] }),
      );
      return sha;
    },
    cleanup: async () => {
      // Background work (a kill, a launch) may still be writing to the run's folder.
      await h.c.agents?.drain();
      s.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
  h.c.recover();
  return h;
}

/** Marks start-up reconciliation done (a fresh in-process controller has nothing to reconcile). */
export const ready = async (h: Harness) => h.c.reconcile();

export { agentLine, command, ok, readEvents };
