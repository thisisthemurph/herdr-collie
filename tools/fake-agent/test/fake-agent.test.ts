import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScenario } from "../src/scenario.ts";

const BIN = join(import.meta.dir, "../bin/fake-agent");
let dir: string;
let record: string;
let stub: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fake-agent-"));
  record = join(dir, "calls.txt");
  stub = join(dir, "collie");
  // A stand-in collie: records its args and stdin; `done` with a dirty marker file exits 2.
  writeFileSync(
    stub,
    `#!/bin/sh
printf '%s|%s\\n' "$*" "$(cat)" >> "${record}"
if [ "$1" = done ] && [ -f "${dir}/dirty" ]; then echo "uncommitted changes in worktree" >&2; exit 2; fi
echo "ok $1"
`,
    { mode: 0o755 },
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function runAgent(steps: unknown[], env: Record<string, string> = {}) {
  const scenario = join(dir, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ v: 1, steps }));
  const log = join(dir, "agent.jsonl");
  const p = Bun.spawnSync([BIN, scenario, "Your Collie brief is ready."], {
    env: {
      ...(process.env as Record<string, string>),
      COLLIE_BIN: stub,
      FAKE_AGENT_LOG: log,
      COLLIE_TICKET: "PAY-9",
      ...env,
    },
  });
  return {
    code: p.exitCode,
    stderr: p.stderr.toString(),
    log: readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l)),
  };
}

test("runs collie and shell steps in order, expanding ${VARS} and passing stdin", () => {
  const r = runAgent([
    { collie: ["status", "on ${COLLIE_TICKET}"] },
    { shell: `touch ${dir}/dirty` },
    { collie: ["done", "--summary", "x"], expect_exit: 2, expect_output: "uncommitted" },
    { shell: `rm ${dir}/dirty` },
    { collie: ["finding", "--body-file", "-"], stdin: "long body for ${COLLIE_TICKET}" },
    { collie: ["done", "--summary", "x"] },
  ]);
  expect(r.code).toBe(0);
  expect(readFileSync(record, "utf8")).toBe(
    "status on PAY-9|\ndone --summary x|\nfinding --body-file -|long body for PAY-9\ndone --summary x|\n",
  );
  expect(r.log.at(-1)).toEqual({ done: true });
});

test("stops with exit 1 and names the step when an exit code is unexpected", () => {
  writeFileSync(join(dir, "dirty"), "");
  const r = runAgent([
    { collie: ["status", "a"] },
    { collie: ["done", "--summary", "x"] },
    { collie: ["status", "never"] },
  ]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("step 1:");
  expect(r.stderr).toContain("exited 2, expected 0");
  expect(readFileSync(record, "utf8")).not.toContain("never");
});

test("await_message reads messages delivered by fake-hc in order", () => {
  const input = join(dir, "t1.input");
  writeFileSync(
    input,
    `${JSON.stringify("first")}\n${JSON.stringify("Answer to your question ABC123: 404")}\n`,
  );
  const r = runAgent(
    [{ await_message: { timeout_ms: 1000 } }, { await_message: { contains: "Answer", timeout_ms: 1000 } }],
    { FAKE_HC_INPUT: input },
  );
  expect(r.code).toBe(0);
  expect(r.log.filter((e) => "message" in e).map((e) => e.message)).toEqual([
    "first",
    "Answer to your question ABC123: 404",
  ]);
});

test("await_message times out with exit 1", () => {
  const r = runAgent([{ await_message: { timeout_ms: 100 } }], { FAKE_HC_INPUT: join(dir, "none") });
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no message within 100 ms");
});

test("exit step ends the agent with that code", () => {
  const r = runAgent([{ exit: 4 }, { collie: ["status", "never"] }]);
  expect(r.code).toBe(4);
});

test("checkScenario names the bad field", () => {
  expect(
    checkScenario({ v: 1, steps: [{ collie: "status" }, { sleep_ms: -1 }, { shell: "x", exit: 0 }] }),
  ).toEqual([
    "steps[0].collie: must be an array of strings",
    "steps[1].sleep_ms: must be a non-negative integer",
    "steps[2]: must have exactly one of collie, shell, await_message, sleep_ms, exit",
  ]);
});
