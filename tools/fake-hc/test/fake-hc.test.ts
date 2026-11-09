// Done when: the fake hc logs its calls and plays back a scripted agent status sequence.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, execute, type State } from "../src/hc.ts";
import { checkScenario, type Scenario } from "../src/scenario.ts";

const HC = join(import.meta.dir, "../bin/hc");
const FAKE_AGENT = join(import.meta.dir, "../../fake-agent/bin/fake-agent");
const RECORDED = join(import.meta.dir, "../../../fixtures/hc");

const playback: Scenario = {
  v: 1,
  agents: [
    {
      match: { labels: { "collie.execution": "E1" } },
      steps: [
        { on: "run", state: "idle", turn: 0 },
        { on: "get", state: "working", turn: 1 },
        { on: "wait", state: "done" },
        { on: "send", state: "working", turn: "+1" },
        { on: "wait", state: "blocked", kind: "permission", msg: "approve Bash: go test ./..." },
        { on: "get", state: "working" },
        { on: "wait", state: "idle" },
        { on: "wait", exit: 0 },
      ],
    },
  ],
};

describe("execute (pure)", () => {
  let state: State;
  let clock: number;
  const hc = (scenario: Scenario, ...argv: string[]) => {
    clock += 10;
    return execute(state, scenario, argv, {}, clock);
  };
  beforeEach(() => {
    state = emptyState();
    clock = 1_000;
  });

  test("plays back a scripted agent status sequence", () => {
    const run = hc(
      playback,
      "run",
      "--bg",
      "--json",
      "--no-parent",
      "--name",
      "dev",
      "--label",
      "collie.execution=E1",
      "--",
      "claude",
      "go",
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toMatchObject({ address: "t1", agent: "claude", name: "dev", state: "live", turn: 0 });

    const seen: unknown[] = [];
    const get = () =>
      hc(playback, "get", "dev", "--json").stdout as { status: { state: string } | null; turn: number };
    const wait = () =>
      hc(playback, "wait", "dev", "--json").stdout as { reason: string; status: string | null; turn: number };

    seen.push([get().status?.state, get().turn]); // working, 1
    seen.push(wait()); // done
    expect(hc(playback, "send", "dev", "Answer: 404").code).toBe(0); // -> working, turn 2
    const blocked = wait(); // blocked
    seen.push(blocked);
    const refused = hc(playback, "send", "dev", "nudge");
    expect(refused.code).toBe(9);
    expect(refused.stderr).toEqual({
      error: {
        hint: "typing would answer its dialog; read its screen first (hc read t1), or --force",
        kind: "blocked",
        message: "t1 is blocked (permission)",
      },
    });
    seen.push(get().status?.state); // working (person approved)
    seen.push(wait()); // idle
    seen.push(wait()); // exit 0

    expect(seen).toEqual([
      ["working", 1],
      {
        children: [],
        ended: true,
        exit_code: null,
        reason: "status",
        signal: null,
        status: "done",
        terminal: "t1",
        turn: 1,
      },
      {
        children: [],
        ended: true,
        exit_code: null,
        reason: "status",
        signal: null,
        status: "blocked",
        terminal: "t1",
        turn: 2,
      },
      "working",
      {
        children: [],
        ended: true,
        exit_code: null,
        reason: "status",
        signal: null,
        status: "idle",
        terminal: "t1",
        turn: 2,
      },
      {
        children: [],
        ended: true,
        exit_code: 0,
        reason: "exit",
        signal: null,
        status: "idle",
        terminal: "t1",
        turn: 2,
      },
    ]);
  });

  test("status_ms changes only when the status state changes", () => {
    const sc: Scenario = {
      v: 1,
      agents: [
        {
          steps: [
            { on: "run", state: "working" },
            { on: "get", state: "working", msg: "still" },
          ],
        },
      ],
    };
    hc(sc, "run", "--bg", "x");
    const first = (hc(sc, "get", "t1").stdout as { status_ms: number }).status_ms;
    expect(first).toBe(1_010);
    expect((hc(sc, "get", "t1").stdout as { status_ms: number }).status_ms).toBe(first);
  });

  test("send --if refuses a mismatched status with exit 10; never types", () => {
    const sc: Scenario = { v: 1, agents: [{ steps: [{ on: "run", state: "done" }] }] };
    hc(sc, "run", "--bg", "claude");
    const r = hc(sc, "send", "--if", "idle", "t1", "hi");
    expect(r.code).toBe(10);
    expect(r.stderr).toEqual({
      error: { hint: "nothing was typed", kind: "status_mismatch", message: "t1 is done, not idle" },
    });
    expect(state.terminals[0]?.received).toEqual([]);
  });

  test("text sent from inside an hc terminal arrives wrapped", () => {
    hc(playback, "run", "--bg", "claude");
    execute(state, playback, ["send", "t1", "hello"], { HC_TERMINAL_ID: "t9" }, 2_000);
    execute(state, playback, ["send", "t1", "plain"], {}, 2_001);
    expect(state.terminals[0]?.received).toEqual(['<hc from="t9">hello</hc>', "plain"]);
  });

  test("agents are matched by label and name, each used once", () => {
    const sc: Scenario = {
      v: 1,
      agents: [
        { match: { name: "b" }, steps: [{ on: "run", state: "working" }] },
        { match: { labels: { role: "dev" } }, steps: [{ on: "run", state: "idle" }] },
      ],
    };
    hc(sc, "run", "--bg", "--name", "a", "--label", "role=dev", "x");
    hc(sc, "run", "--bg", "--name", "b", "x");
    hc(sc, "run", "--bg", "--name", "c", "--label", "role=dev", "x");
    expect(state.terminals.map((t) => t.status?.state ?? null)).toEqual(["idle", "working", null]);
  });

  test("parent, die_with_parent and notify follow --no-parent and --outlive-parent", () => {
    const env = { HC_TERMINAL_ID: "t50" };
    execute(state, playback, ["run", "--bg", "x"], env, 1);
    execute(state, playback, ["run", "--bg", "--outlive-parent", "--no-notify", "x"], env, 2);
    execute(state, playback, ["run", "--bg", "--no-parent", "x"], env, 3);
    expect(state.terminals.map((t) => [t.parent, t.die_with_parent, t.notify])).toEqual([
      ["t50", true, true],
      ["t50", false, false],
      [null, false, false],
    ]);
  });

  test("errors copy real hc kinds and exit codes", () => {
    hc(playback, "run", "--bg", "--name", "dev", "x");
    expect(hc(playback, "run", "--bg", "--name", "dev", "x")).toMatchObject({
      code: 1,
      stderr: { error: { kind: "name_taken" } },
    });
    expect(hc(playback, "rm", "dev")).toMatchObject({ code: 1, stderr: { error: { kind: "live" } } });
    expect(hc(playback, "get", "nope")).toMatchObject({ code: 3, stderr: { error: { kind: "not_found" } } });
    hc(playback, "kill", "dev");
    expect(hc(playback, "send", "dev", "x")).toMatchObject({
      code: 11,
      stderr: { error: { kind: "finished" } },
    });
    expect(hc(playback, "rm", "dev")).toMatchObject({ code: 0, stdout: { removed: "t1" } });
    expect(hc(playback, "run", "x")).toMatchObject({ code: 2, stderr: { error: { kind: "unsupported" } } });
  });

  test("a scripted run_error fails hc run", () => {
    const sc: Scenario = {
      v: 1,
      agents: [{ run_error: { kind: "spawn_failed", message: 'cannot start "claude"' } }],
    };
    expect(hc(sc, "run", "--bg", "claude")).toMatchObject({
      code: 1,
      stderr: { error: { kind: "spawn_failed" } },
    });
    expect(state.terminals).toEqual([]);
  });

  test("ls filters by label and hides finished terminals unless --all", () => {
    hc(playback, "run", "--bg", "--label", "collie.run=R1", "x");
    hc(playback, "run", "--bg", "--label", "collie.run=R1", "y");
    hc(playback, "run", "--bg", "--label", "collie.run=R2", "z");
    hc(playback, "kill", "t2");
    const ls = (...a: string[]) =>
      hc(playback, "ls", "--json", ...a).stdout as {
        hidden_finished: number;
        terminals: { address: string }[];
      };
    expect(ls("--label", "collie.run=R1")).toMatchObject({
      hidden_finished: 1,
      terminals: [{ address: "t1" }],
    });
    expect(ls("--label", "collie.run=R1", "--all").terminals.map((t) => t.address)).toEqual(["t1", "t2"]);
  });

  test("label sets and removes labels", () => {
    hc(playback, "run", "--bg", "--label", "a=1", "x");
    const out = hc(playback, "label", "t1", "b=2", "a=").stdout as { labels: Record<string, string> };
    expect(out.labels).toEqual({ b: "2" });
  });
});

describe("output shapes match recorded real hc", () => {
  const recorded = (f: string) => JSON.parse(readFileSync(join(RECORDED, f), "utf8"));
  const keys = (v: unknown) => Object.keys(v as object).sort();
  let state: State;
  const hc = (...argv: string[]) => execute(state, playback, argv, {}, 5_000);
  beforeEach(() => {
    state = emptyState();
    hc("run", "--bg", "--name", "p", "sleep", "300");
  });

  test("run --bg", () =>
    expect(keys(hc("run", "--bg", "sleep", "1").stdout)).toEqual(keys(recorded("run-bg.stdout.json"))));
  test("get", () =>
    expect(keys(hc("get", "p").stdout)).toEqual(keys(recorded("get-live-plain.stdout.json"))));
  test("label", () =>
    expect(keys(hc("label", "p", "a=1").stdout)).toEqual(keys(recorded("label.stdout.json"))));
  test("ls", () => {
    const ls = hc("ls", "--json").stdout as { terminals: unknown[] };
    expect(keys(ls)).toEqual(keys(recorded("ls.stdout.json")));
    expect(keys(ls.terminals[0])).toEqual(keys(recorded("ls.stdout.json").terminals[0]));
  });
  test("wait", () =>
    expect(keys(hc("wait", "p").stdout)).toEqual(keys(recorded("wait-timeout.stdout.json"))));
  test("send", () => expect(hc("send", "p", "hi").stdout).toEqual({ ...recorded("send-plain.stdout.json") }));
  test("kill then get", () => {
    expect(keys(hc("kill", "p").stdout)).toEqual(keys(recorded("kill.stdout.json")));
    const g = hc("get", "p").stdout as Record<string, unknown>;
    const real = recorded("get-finished-killed.stdout.json");
    expect([g.state, g.reason, g.signal, g.exit_code]).toEqual([
      real.state,
      real.reason,
      real.signal,
      real.exit_code,
    ]);
  });
  test("rm", () => {
    hc("kill", "p");
    expect(keys(hc("rm", "p").stdout)).toEqual(keys(recorded("rm.stdout.json")));
  });
  test("error kinds and exit codes", () => {
    const codes = recorded("exit-codes.json") as Record<string, number>;
    for (const [file, code] of Object.entries(codes)) {
      state = emptyState();
      hc("run", "--bg", "--name", "p", "sleep", "300");
      const kind = recorded(file).error.kind;
      expect(keys(recorded(file).error)).toEqual(["hint", "kind", "message"]);
      const ours: Record<string, () => ReturnType<typeof hc>> = {
        blocked: () => {
          const s: Scenario = {
            v: 1,
            agents: [{ steps: [{ on: "run", state: "blocked", kind: "permission" }] }],
          };
          execute(state, s, ["run", "--bg", "--name", "b", "x"], {}, 1);
          return execute(state, s, ["send", "b", "x"], {}, 2);
        },
        status_mismatch: () => hc("send", "--if", "working", "p", "x"),
        finished: () => {
          hc("run", "--bg", "--name", "f", "x");
          hc("kill", "f");
          return hc("send", "f", "x");
        },
        not_found: () => hc("get", "nope"),
        name_taken: () => hc("run", "--bg", "--name", "p", "x"),
        live: () => hc("rm", "p"),
        spawn_failed: () =>
          execute(
            state,
            { v: 1, agents: [{ run_error: { kind: "spawn_failed", message: "x" } }] },
            ["run", "--bg", "x"],
            {},
            1,
          ),
      };
      const fn = ours[kind];
      expect(fn, `no check for recorded kind ${kind}`).toBeDefined();
      const r = (fn as () => ReturnType<typeof hc>)();
      expect([r.code, (r.stderr as { error: { kind: string } }).error.kind], file).toEqual([code, kind]);
    }
  });
  test("send to a silent program with --if working matches the recorded message", () => {
    const r = hc("send", "--if", "working", "p", "x");
    expect((r.stderr as { error: { message: string } }).error.message).toBe("t1 is silent, not working");
  });
});

test("checkScenario names the bad field", () => {
  expect(
    checkScenario({
      v: 1,
      agents: [{ steps: [{ on: "poll" }, { on: "get", state: "busy" }, { on: "get", turn: "+2" }] }],
    }),
  ).toEqual([
    "agents[0].steps[0].on: must be one of run, send, wait, get, ls, label, any",
    "agents[0].steps[1].state: must be one of idle, working, done, blocked, error or null",
    'agents[0].steps[2].turn: must be a non-negative integer or "+1"',
  ]);
});

describe("bin/hc (process)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fake-hc-"));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(playback));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const env = (extra: Record<string, string> = {}) => {
    const e: Record<string, string> = { ...(process.env as Record<string, string>), FAKE_HC_DIR: dir };
    delete e.HC_TERMINAL_ID;
    delete e.FAKE_HC_SCENARIO;
    return { ...e, ...extra };
  };
  const run = (args: string[], extra?: Record<string, string>) => {
    const p = Bun.spawnSync([HC, ...args], { env: env(extra) });
    return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  };
  const calls = () =>
    readFileSync(join(dir, "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

  test("logs every call with argv, caller, exit code and output", () => {
    run(["run", "--bg", "--json", "--no-parent", "--label", "collie.execution=E1", "--", "claude", "go"]);
    run(["get", "t1", "--json"]);
    run(["send", "t1", "hello"], { HC_TERMINAL_ID: "t7" });
    run(["get", "nope"]);
    const log = calls();
    expect(log.map((c) => [c.argv[0], c.code, c.from])).toEqual([
      ["run", 0, null],
      ["get", 0, null],
      ["send", 0, "t7"],
      ["get", 3, null],
    ]);
    expect(log[1].stdout.status.state).toBe("working");
    expect(log[3].stderr.error.kind).toBe("not_found");
    expect(log[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readFileSync(join(dir, "t1.input"), "utf8")).toBe(
      `${JSON.stringify('<hc from="t7">hello</hc>')}\n`,
    );
  });

  test("prints JSON on stdout, errors on stderr, with real exit codes", () => {
    const ok = run(["run", "--bg", "--name", "x", "sleep", "1"]);
    expect(JSON.parse(ok.stdout)).toMatchObject({ address: "t1", name: "x" });
    const bad = run(["rm", "x"]);
    expect([bad.code, JSON.parse(bad.stderr).error.kind]).toEqual([1, "live"]);
  });

  test("a bad scenario fails with a message naming the field", () => {
    writeFileSync(
      join(dir, "scenario.json"),
      JSON.stringify({ v: 1, agents: [{ steps: [{ on: "tick" }] }] }),
    );
    const r = run(["ls"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("agents[0].steps[0].on");
  });

  test("parallel calls never lose an update", async () => {
    run(["run", "--bg", "--name", "x", "sleep", "1"]);
    const procs = Array.from({ length: 12 }, (_, i) =>
      Bun.spawn([HC, "label", "x", `k${i}=${i}`], { env: env() }),
    );
    await Promise.all(procs.map((p) => p.exited));
    const labels = JSON.parse(run(["get", "x"]).stdout).labels;
    expect(Object.keys(labels).length).toBe(12);
    expect(calls().length).toBe(14);
  });

  test("spawns a fake-agent, delivers a message to it, and reports its exit", async () => {
    const stub = join(dir, "collie");
    const record = join(dir, "collie-calls.txt");
    writeFileSync(stub, `#!/bin/sh\necho "$*" >> "${record}"\n`, { mode: 0o755 });
    const agentScenario = join(dir, "agent.json");
    writeFileSync(
      agentScenario,
      JSON.stringify({
        v: 1,
        steps: [
          { collie: ["status", "started on ${COLLIE_TICKET}"] },
          { await_message: { contains: "Answer", timeout_ms: 10_000 } },
          { collie: ["done", "--summary", "finished"] },
          { exit: 3 },
        ],
      }),
    );
    writeFileSync(
      join(dir, "scenario.json"),
      JSON.stringify({ v: 1, agents: [{ spawn: true, steps: [{ on: "run", state: "working", turn: 1 }] }] }),
    );
    const r = run([
      "run",
      "--bg",
      "--no-parent",
      "--",
      "env",
      `COLLIE_BIN=${stub}`,
      "COLLIE_TICKET=PAY-7",
      FAKE_AGENT,
      agentScenario,
    ]);
    expect(r.code).toBe(0);
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 300 && !cond(); i++) await Bun.sleep(20);
      expect(cond()).toBe(true);
    };
    await until(() => existsSync(record));
    expect(run(["send", "t1", "Answer to your question 4F2A1C: yes"]).code).toBe(0);
    await until(() => existsSync(join(dir, "t1.exit")));
    expect(readFileSync(record, "utf8")).toBe("status started on PAY-7\ndone --summary finished\n");
    const w = JSON.parse(run(["wait", "t1"]).stdout);
    expect([w.reason, w.exit_code, w.ended]).toEqual(["exit", 3, true]);
    expect(readdirSync(dir)).toContain("t1.out");
  });
});
