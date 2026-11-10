// Tests against real controller processes: the lock, kill -9 recovery, and `collie ctl`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Subprocess, spawn, spawnSync } from "bun";
import { rebuild } from "../src/reducer.ts";
import {
  agentLine,
  CLI_BIN,
  CONTROLLER_BIN,
  command,
  inProcess,
  ok,
  readEvents,
  type Scratch,
  saveBoard,
  scratchHome,
  seedExecution,
} from "./helpers.ts";

const BOARD = "01JC8XW0000000000000000001";
let s: Scratch;
const procs: Subprocess[] = [];

beforeEach(() => {
  s = scratchHome();
});
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  s.cleanup();
});

function startController(): Subprocess {
  const p = spawn([CONTROLLER_BIN, "--home", s.root], {
    stdout: "pipe",
    stderr: "pipe",
    // These tests seed executions by hand: the controller must not look for them in a real Herdr.
    env: { ...process.env, COLLIE_NO_AGENTS: "1" },
  });
  procs.push(p);
  return p;
}

async function until(what: string, cond: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

const lockPid = () => {
  try {
    return JSON.parse(readFileSync(s.home.lock, "utf8")).pid as number;
  } catch {
    return null;
  }
};

const ctl = (args: string[], env: Record<string, string> = {}) => {
  const p = spawnSync([CLI_BIN, "ctl", ...args], { env: { ...process.env, COLLIE_HOME: s.root, ...env } });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

describe("controller.lock", () => {
  test("a second controller refuses to start while the first holds the lock", async () => {
    const first = startController();
    await until("the lock", () => lockPid() === first.pid);
    const second = spawnSync([CONTROLLER_BIN, "--home", s.root]);
    expect(second.exitCode).toBe(1);
    expect(second.stderr.toString()).toContain(`another controller is running (pid ${first.pid}`);
    expect(lockPid()).toBe(first.pid);
  });

  test("a stale lock (dead pid) is replaced, and SIGTERM releases the lock", async () => {
    const dead = spawnSync(["true"]).pid;
    writeFileSync(s.home.lock, JSON.stringify({ v: 1, pid: dead, started_at: "2026-11-09T09:00:00Z" }));
    const p = startController();
    await until("the lock", () => lockPid() === p.pid);
    expect(readFileSync(s.home.log, "utf8")).toContain(`replaced a stale lock left by pid ${dead}`);
    p.kill("SIGTERM");
    await p.exited;
    expect(existsSync(s.home.lock)).toBe(false);
  });
});

describe("kill -9", () => {
  test("killing the controller mid-run and restarting it gives the same state as a rebuild from events.jsonl", async () => {
    // A run with three working executions (seeded in-process, then handed to real controllers).
    saveBoard(s.home, BOARD, ["PAY-101", "PAY-102", "PAY-103"]);
    const { c } = inProcess(s);
    const runId = ok(await command(c, "run.start", { board_id: BOARD })).run_id as string;
    const rl = c.runs.get(runId);
    if (!rl) throw new Error("no run");
    const execs = ["PAY-101", "PAY-102", "PAY-103"].map(
      (t) => [t, seedExecution(c, rl, t, "developer")] as const,
    );
    c.flushAll();

    const PER_EXEC = 150;
    let written = 0;
    const ids = new Set<string>();
    const writeSome = (n: number) => {
      for (let i = 0; i < n && written < PER_EXEC * execs.length; i++) {
        const [ticket, exec] = execs[written % execs.length] as readonly [string, string];
        const line = agentLine(runId, exec, ticket, "status", { message: `line ${written}` });
        ids.add(JSON.parse(line).id);
        appendFileSync(s.home.inbox(runId, exec), line);
        written++;
      }
    };
    const verdicts = () => readEvents(s.home, runId).filter((e) => e.type.startsWith("agent.event_"));

    // Three controllers in a row; the first two are killed with -9 while lines keep arriving.
    for (let round = 0; round < 3; round++) {
      const p = startController();
      await until("the lock", () => lockPid() === p.pid);
      if (round < 2) {
        const target = verdicts().length + 60;
        while (verdicts().length < target) {
          writeSome(15);
          await Bun.sleep(15);
        }
        p.kill("SIGKILL");
        await p.exited;
        writeSome(30); // lines that arrive while no controller runs
      } else {
        writeSome(Number.MAX_SAFE_INTEGER);
        await until("every line judged", () => verdicts().length >= written, 20_000);
        p.kill("SIGTERM");
        await p.exited;
      }
    }

    const events = readEvents(s.home, runId);
    // Every inbox line was judged exactly once, and accepted.
    const judged = events.filter((e) => e.type.startsWith("agent.event_"));
    expect(judged.length).toBe(written);
    expect(judged.every((e) => e.type === "agent.event_accepted")).toBe(true);
    expect(new Set(judged.map((e) => e.caused_by))).toEqual(ids);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    // The controller's state equals a rebuild from the log, and the offsets reach the end of each inbox.
    const stateJson = JSON.parse(readFileSync(s.home.state(runId), "utf8"));
    expect(stateJson).toEqual(rebuild(runId, events));
    for (const [, exec] of execs)
      expect(stateJson.inbox_offsets[exec]).toBe(readFileSync(s.home.inbox(runId, exec)).length);
    expect(readFileSync(s.home.log, "utf8")).toContain(`recovered run ${runId}`);
  }, 60_000);
});

describe("collie ctl", () => {
  test("exits 6 at once when no controller is running", async () => {
    const t0 = Date.now();
    const r = ctl(["run.pause", '{"run_id":"01JC8YQ0P4E2W7H5S8D3F6G9KB"}']);
    expect(r.code).toBe(6);
    expect(r.stderr).toContain("the controller isn't running");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("exits 6 within 10 seconds when the lock's process never answers", async () => {
    // A live pid that isn't a controller: this test process.
    writeFileSync(
      s.home.lock,
      JSON.stringify({ v: 1, pid: process.pid, started_at: "2026-11-09T09:00:00Z" }),
    );
    const t0 = Date.now();
    const r = ctl(["run.pause", '{"run_id":"01JC8YQ0P4E2W7H5S8D3F6G9KB"}']);
    const took = Date.now() - t0;
    expect(r.code).toBe(6);
    expect(r.stderr).toContain("didn't reply within 10 seconds");
    expect(took).toBeGreaterThanOrEqual(10_000);
    expect(took).toBeLessThan(11_500);
  }, 15_000);

  test("validates arguments before sending, naming the field", async () => {
    const r = ctl(["question.answer", '{"run_id":"01JC8YQ0P4E2W7H5S8D3F6G9KB"}']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("args.question_id: is required");
  });

  test("drives a real controller: board, run, a lease conflict, cancel", async () => {
    const p = startController();
    await until("the lock", () => lockPid() === p.pid);
    saveBoard(s.home, BOARD, ["PAY-101", "PAY-102"]);
    saveBoard(s.home, "01JC8XW0000000000000000002", ["PAY-102"]);
    const start = ctl(["run.start", JSON.stringify({ board_id: BOARD }), "--json"]);
    expect(start.code, start.stderr).toBe(0);
    const runId = JSON.parse(start.stdout).result.run_id;
    const conflict = ctl(["run.start", '{"board_id":"01JC8XW0000000000000000002"}']);
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain(
      `lease_conflict: ticket PAY-102 (run ${runId}) is leased by another active run`,
    );
    const json = ctl(["run.start", '{"board_id":"01JC8XW0000000000000000002"}', "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: "lease_conflict" } });
    expect(ctl(["run.cancel", JSON.stringify({ run_id: runId, reason: "demo" })]).stdout).toBe(
      "Applied run.cancel.\n",
    );
    expect(ctl(["run.start", '{"board_id":"01JC8XW0000000000000000002"}']).code).toBe(0);
  }, 20_000);
});
