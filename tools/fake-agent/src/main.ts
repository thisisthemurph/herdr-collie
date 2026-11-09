// fake-agent: a scripted stand-in for a real harness such as Claude Code. It runs `collie`
// commands (and plain shell commands) from a scenario file, in order, and checks exit codes.
//
//   fake-agent <scenario.json> [first message...]
//
// Scenario:
// {
//   "v": 1,
//   "steps": [
//     { "collie": ["status", "Reading the code"] },
//     { "collie": ["finding", "--severity", "high", "--title", "x", "--body-file", "-"], "stdin": "long body" },
//     { "shell": "git commit --allow-empty -m '${COLLIE_TICKET}: work'" },
//     { "collie": ["done", "--summary", "x"], "expect_exit": 2, "expect_output": "uncommitted" },
//     { "await_message": { "contains": "Answer to your question", "timeout_ms": 10000 } },
//     { "sleep_ms": 200 },
//     { "exit": 0 }
//   ]
// }
//
// - "${NAME}" in any string is replaced with that environment variable ("" when unset).
// - expect_exit defaults to 0. A mismatch, or expect_output not found in stdout+stderr, stops
//   the agent with exit code 1 and a message saying which step failed.
// - await_message waits for the next message `hc send` delivered. Under tools/fake-hc with
//   "spawn": true, messages arrive in the file named by FAKE_HC_INPUT, one JSON string per line.
//
// Environment: COLLIE_BIN (default "collie"), FAKE_AGENT_LOG (optional JSONL of step results),
// FAKE_HC_INPUT (set by fake-hc).
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { checkScenario, type Step } from "./scenario.ts";

const [scenarioPath] = process.argv.slice(2);
if (!scenarioPath) {
  console.error("usage: fake-agent <scenario.json> [first message...]");
  process.exit(2);
}

let parsed: unknown;
try {
  parsed = JSON.parse(readFileSync(scenarioPath, "utf8"));
} catch (e) {
  console.error(`fake-agent: cannot read scenario ${scenarioPath}: ${(e as Error).message}`);
  process.exit(2);
}
const problems = checkScenario(parsed);
if (problems.length) {
  console.error(`fake-agent: scenario ${scenarioPath}: ${problems.join("; ")}`);
  process.exit(2);
}
const steps = (parsed as { steps: Step[] }).steps;

const expand = (s: string) =>
  s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => process.env[n] ?? "");
const log = (entry: Record<string, unknown>) => {
  const line = JSON.stringify(entry);
  console.log(line);
  if (process.env.FAKE_AGENT_LOG) appendFileSync(process.env.FAKE_AGENT_LOG, `${line}\n`);
};

let messagesSeen = 0;
function readMessages(): string[] {
  const f = process.env.FAKE_HC_INPUT;
  if (!f || !existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string);
}

function stop(i: number, message: string): never {
  log({ step: i, error: message });
  console.error(`fake-agent: step ${i}: ${message}`);
  process.exit(1);
}

for (const [i, step] of steps.entries()) {
  if ("collie" in step || "shell" in step) {
    const cmd =
      "collie" in step
        ? [expand(process.env.COLLIE_BIN ?? "collie"), ...step.collie.map(expand)]
        : ["/bin/sh", "-c", expand(step.shell)];
    const p = Bun.spawnSync(cmd, {
      stdin: step.stdin === undefined ? "ignore" : Buffer.from(expand(step.stdin)),
      env: process.env,
    });
    const stdout = p.stdout.toString();
    const stderr = p.stderr.toString();
    log({ step: i, cmd, exit: p.exitCode, stdout, stderr });
    const want = step.expect_exit ?? 0;
    if (p.exitCode !== want)
      stop(i, `${cmd.join(" ")} exited ${p.exitCode}, expected ${want}: ${stderr || stdout}`);
    if (step.expect_output && !`${stdout}${stderr}`.includes(step.expect_output)) {
      stop(i, `output of ${cmd.join(" ")} does not contain ${JSON.stringify(step.expect_output)}`);
    }
  } else if ("await_message" in step) {
    const { contains, timeout_ms = 30_000 } = step.await_message;
    const deadline = Date.now() + timeout_ms;
    let got: string | undefined;
    while (got === undefined) {
      const all = readMessages();
      if (all.length > messagesSeen) {
        got = all[messagesSeen];
        messagesSeen += 1;
      } else if (Date.now() > deadline) {
        stop(i, `no message within ${timeout_ms} ms`);
      } else {
        Bun.sleepSync(20);
      }
    }
    log({ step: i, message: got });
    if (contains && !got.includes(contains))
      stop(i, `message does not contain ${JSON.stringify(contains)}: ${got}`);
  } else if ("sleep_ms" in step) {
    Bun.sleepSync(step.sleep_ms);
  } else if ("exit" in step) {
    log({ step: i, exit: step.exit });
    process.exit(step.exit);
  }
}
log({ done: true });
