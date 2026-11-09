// fake-hc entry point: an `hc` stand-in for tests. Put tools/fake-hc/bin first on PATH.
//
// Environment:
//   FAKE_HC_DIR       required: a scratch folder for state.json, calls.jsonl and terminal files
//   FAKE_HC_SCENARIO  the scenario file (default: $FAKE_HC_DIR/scenario.json; none = no agents)
//
// Files in FAKE_HC_DIR:
//   calls.jsonl       one line per call: {ts, argv, cwd, from, code, stdout, stderr}
//   state.json        the terminals; delete it to start over
//   <t>.input         texts delivered by `hc send`, one JSON string per line (spawned agents read it)
//   <t>.out           a spawned program's stdout and stderr
//   <t>.exit          a spawned program's exit code, once it has exited
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { emptyState, execute, reapExited, type State } from "./hc.ts";
import { checkScenario, type Scenario } from "./scenario.ts";

function fail(message: string): never {
  process.stderr.write(
    `${JSON.stringify({ error: { kind: "fake_hc", message, hint: "see tools/fake-hc/README.md" } })}\n`,
  );
  process.exit(2);
}

const dir = process.env.FAKE_HC_DIR;
if (!dir) fail("FAKE_HC_DIR is not set; point it at a scratch folder");
mkdirSync(dir, { recursive: true });
const statePath = join(dir, "state.json");
const scenarioPath = process.env.FAKE_HC_SCENARIO ?? join(dir, "scenario.json");

function loadScenario(): Scenario {
  if (!existsSync(scenarioPath)) return { v: 1, agents: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(scenarioPath, "utf8"));
  } catch (e) {
    fail(`scenario ${scenarioPath} is not valid JSON: ${(e as Error).message}`);
  }
  const problems = checkScenario(parsed);
  if (problems.length) fail(`scenario ${scenarioPath}: ${problems.join("; ")}`);
  return parsed as Scenario;
}

// A mkdir lock: atomic on every filesystem, and enough for tests running hc calls in parallel.
function withLock<T>(fn: () => T): T {
  const lock = join(dir as string, "lock");
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline)
        fail(`could not lock ${lock} within 10 s; remove it if no fake-hc is running`);
      Bun.sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

function exitedPrograms(state: State): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of state.terminals) {
    const f = join(dir as string, `${t.address}.exit`);
    if (t.state === "live" && t.pid !== null && existsSync(f))
      out.set(t.address, Number(readFileSync(f, "utf8").trim()));
  }
  return out;
}

const argv = process.argv.slice(2);
const scenario = loadScenario();
const now = Date.now();

const outcome = withLock(() => {
  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : emptyState();
  reapExited(state, exitedPrograms(state), now);
  const result = execute(state, scenario, argv, process.env, now);
  for (const e of result.effects) {
    if (e.kind === "deliver") {
      appendFileSync(join(dir, `${e.address}.input`), `${JSON.stringify(e.text)}\n`);
    } else if (e.kind === "kill") {
      try {
        process.kill(-e.pid, "SIGHUP");
      } catch {}
    } else if (e.kind === "spawn") {
      const out = openSync(join(dir, `${e.address}.out`), "a");
      const child = spawn("/bin/sh", ["-c", '"$@"; echo $? > "$FAKE_HC_EXIT"', "sh", ...e.argv], {
        cwd: e.cwd,
        detached: true,
        stdio: ["ignore", out, out],
        env: {
          ...process.env,
          ...e.env,
          FAKE_HC_INPUT: join(dir, `${e.address}.input`),
          FAKE_HC_EXIT: join(dir, `${e.address}.exit`),
        },
      });
      child.unref();
      const t = state.terminals.find((x) => x.address === e.address);
      if (t) t.pid = child.pid ?? null;
    }
  }
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath);
  appendFileSync(
    join(dir, "calls.jsonl"),
    `${JSON.stringify({
      ts: new Date(now).toISOString(),
      argv,
      cwd: process.cwd(),
      from: process.env.HC_TERMINAL_ID ?? null,
      code: result.code,
      stdout: result.stdout ?? null,
      stderr: result.stderr ?? null,
    })}\n`,
  );
  return result;
});

if (outcome.stdout !== undefined) process.stdout.write(`${JSON.stringify(outcome.stdout)}\n`);
if (outcome.stderr !== undefined) process.stderr.write(`${JSON.stringify(outcome.stderr)}\n`);
process.exit(outcome.code);
