import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatIssues, MAX_INBOX_LINE_BYTES, parseInboxLine } from "@collie/schema";
import { lockExclusive, unlock } from "../src/flock.ts";
import { CLI_SRC, collie, normalizeInbox, type Scratch, scratchExecution } from "./helpers.ts";

const FIXTURES = join(import.meta.dir, "../../../fixtures");
const FAKE_AGENT = join(import.meta.dir, "../../../tools/fake-agent/bin/fake-agent");

let s: Scratch;
const run = (args: string[], opts: { stdin?: string; env?: Record<string, string | undefined> } = {}) => {
  const env = { ...s.env, ...opts.env } as Record<string, string>;
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v === undefined) delete env[k];
  return collie(CLI_SRC, args, env, { cwd: s.worktree, stdin: opts.stdin });
};
const inboxLines = () =>
  existsSync(s.inbox) ? readFileSync(s.inbox, "utf8").split("\n").filter(Boolean) : [];
const commit = (msg = "PAY-102: work") => {
  writeFileSync(join(s.worktree, `f${Math.random()}.txt`), "x\n");
  Bun.spawnSync(["git", "add", "-A"], { cwd: s.worktree, env: s.env });
  Bun.spawnSync(["git", "commit", "-q", "-m", msg], { cwd: s.worktree, env: s.env });
};

describe.each(["developer", "reviewer"] as const)("fake-agent scenario: %s", (role) => {
  beforeEach(() => {
    s = scratchExecution(role);
  });
  afterEach(() => s.cleanup());

  test("writes an inbox identical to the expected fixture, apart from ids and timestamps", () => {
    const p = Bun.spawnSync([FAKE_AGENT, join(FIXTURES, `scenarios/${role}.json`)], {
      cwd: s.worktree,
      env: { ...s.env, COLLIE_BIN: CLI_SRC },
    });
    if (p.exitCode !== 0) throw new Error(`fake-agent failed:\n${p.stdout}\n${p.stderr}`);
    const expectedPath = join(FIXTURES, `scenarios/${role}.expected.jsonl`);
    const actual = readFileSync(s.inbox, "utf8");
    if (process.env.UPDATE_EXPECTED) writeFileSync(expectedPath, actual);
    expect(normalizeInbox(actual)).toEqual(normalizeInbox(readFileSync(expectedPath, "utf8")));
    for (const l of actual.split(/(?<=\n)/)) {
      const r = parseInboxLine(l);
      if (!r.ok) throw new Error(formatIssues(r.issues));
    }
  });
});

describe("with a scratch developer execution", () => {
  beforeEach(() => {
    s = scratchExecution("developer");
  });
  afterEach(() => s.cleanup());

  describe("each invalid inbox fixture's equivalent call exits 2 with a fix-it message", () => {
    // fixture -> [role, argv, text the message must contain]
    const CALLS: Record<string, [string, string[], string]> = {
      "status-message-too-long.jsonl": [
        "developer",
        ["status", "x".repeat(201)],
        "<message> argument must be at most 200 characters",
      ],
      "status-unknown-phase.jsonl": [
        "developer",
        ["status", "hi", "--phase", "coding"],
        "--phase must be one of investigating",
      ],
      "finding-missing-title.jsonl": [
        "reviewer",
        ["finding", "--severity", "high", "--body", "b"],
        "--title is required",
      ],
      "finding-unknown-severity.jsonl": [
        "reviewer",
        ["finding", "--severity", "blocker", "--title", "t", "--body", "b"],
        "--severity must be one of critical",
      ],
      "finding-no-body.jsonl": [
        "reviewer",
        ["finding", "--severity", "low", "--title", "t"],
        "--body or --body-file is required",
      ],
      "finding-body-and-body-ref.jsonl": [
        "reviewer",
        ["finding", "--severity", "low", "--title", "t", "--body", "b", "--body-file", "-"],
        "give --body or --body-file, not both",
      ],
      "finding-end-line-before-line.jsonl": [
        "reviewer",
        [
          "finding",
          "--severity",
          "low",
          "--title",
          "t",
          "--body",
          "b",
          "--file",
          "a.go",
          "--line",
          "88",
          "--end-line",
          "80",
        ],
        "--end-line must be at least line (88)",
      ],
      "finding-line-without-file.jsonl": [
        "reviewer",
        ["finding", "--severity", "low", "--title", "t", "--body", "b", "--line", "8"],
        "--file is required when line is set",
      ],
      "finding-unknown-category.jsonl": [
        "reviewer",
        ["finding", "--severity", "low", "--title", "t", "--body", "b", "--category", "naming"],
        "--category must be one of security",
      ],
      "finding-blocking-not-boolean.jsonl": [
        "reviewer",
        ["finding", "--severity", "low", "--title", "t", "--body", "b", "--blocking=yes"],
        "--blocking takes no value",
      ],
      "artifact-unknown-kind.jsonl": [
        "developer",
        ["artifact", "--kind", "pr", "--ref", "x"],
        "--kind must be one of commit",
      ],
      "artifact-missing-ref.jsonl": ["developer", ["artifact", "--kind", "commit"], "--ref is required"],
      "ask-missing-question.jsonl": ["developer", ["ask"], "missing <question>"],
      "ask-options-not-array.jsonl": ["developer", ["ask", "q?", "--option"], "--option needs a value"],
      "done-missing-summary.jsonl": ["reviewer", ["done", "--verdict", "approve"], "--summary is required"],
      "done-unknown-verdict.jsonl": [
        "reviewer",
        ["done", "--summary", "s", "--verdict", "lgtm"],
        "--verdict must be one of approve, request_changes",
      ],
      "done-bad-commit-sha.jsonl": [
        "analyst",
        ["done", "--summary", "s", "--commit", "HEAD"],
        "--commit must be a git commit sha",
      ],
      "done-tests-missing-passed.jsonl": [
        "analyst",
        ["done", "--summary", "s", "--tests-command", "go test ./..."],
        "--tests-passed or --tests-failed is required",
      ],
      "fail-unknown-category.jsonl": [
        "developer",
        ["fail", "--reason", "r", "--category", "flaky"],
        "--category must be one of blocked_external",
      ],
      "envelope-unknown-type.jsonl": ["developer", ["progress", "hi"], 'unknown command "progress"'],
      "envelope-controller-type.jsonl": ["developer", ["execution.completed"], "unknown command"],
    };
    // Fixtures the CLI can't express: it fills these fields itself, or reports them as exit 3.
    const NOT_EXPRESSIBLE: Record<string, string> = {
      "fail-missing-retryable.jsonl": "the CLI always writes retryable (true with --retryable, else false)",
      "envelope-future-version.jsonl": "the CLI writes v",
      "envelope-bad-id.jsonl": "the CLI writes id",
      "envelope-ts-without-ms.jsonl": "the CLI writes ts",
      "envelope-ts-not-utc.jsonl": "the CLI writes ts",
      "envelope-source-controller.jsonl": "the CLI writes source",
      "envelope-missing-payload.jsonl": "the CLI writes payload",
      "line-no-newline.jsonl": "the CLI writes whole lines",
      "line-not-json.jsonl": "the CLI writes JSON",
      "envelope-missing-execution-id.jsonl": "comes from COLLIE_EXECUTION_ID: exit 3, tested below",
      "envelope-lowercase-ticket.jsonl": "comes from COLLIE_TICKET: exit 3, tested below",
    };

    test("every invalid inbox fixture is covered", () => {
      const all = Object.keys(
        JSON.parse(readFileSync(join(FIXTURES, "inbox/invalid/expected.json"), "utf8")),
      ).sort();
      expect([...Object.keys(CALLS), ...Object.keys(NOT_EXPRESSIBLE)].sort()).toEqual(all);
    });

    for (const [fixture, [role, argv, message]] of Object.entries(CALLS)) {
      test(fixture, () => {
        const r = run(argv, { env: { COLLIE_ROLE: role }, stdin: "" });
        expect(r.code, r.stderr).toBe(2);
        expect(r.stderr).toContain(message);
        expect(r.stderr).toMatch(
          /collie --help|collie \w+ --help|not both|takes no value|needs a value|missing/,
        );
        expect(inboxLines()).toEqual([]);
      });
    }
  });

  describe("environment", () => {
    for (const v of [
      "COLLIE_HOME",
      "COLLIE_INBOX",
      "COLLIE_RUN_ID",
      "COLLIE_EXECUTION_ID",
      "COLLIE_TICKET",
      "COLLIE_ROLE",
    ]) {
      test(`missing ${v} exits 3 and names it`, () => {
        const r = run(["status", "hi"], { env: { [v]: undefined } });
        expect(r.code).toBe(3);
        expect(r.stderr).toContain(`${v} is not set`);
      });
    }
    test.each([
      ["COLLIE_TICKET", "pay-102", "not a Jira issue key"],
      ["COLLIE_EXECUTION_ID", "exec-1", "not a ULID"],
      ["COLLIE_ROLE", "tester", "must be one of developer, reviewer, analyst"],
      ["COLLIE_INBOX", "/nonexistent/dir/inbox.jsonl", "does not exist"],
    ])("bad %s exits 3", (name, value, message) => {
      const r = run(["status", "hi"], { env: { [name]: value } });
      expect([r.code, r.stderr.includes(message)]).toEqual([3, true]);
    });
    test("an empty COLLIE_RUN_ID is allowed only for analysts", () => {
      expect(run(["status", "hi"], { env: { COLLIE_RUN_ID: "" } }).code).toBe(3);
      const r = run(["status", "hi"], { env: { COLLIE_RUN_ID: "", COLLIE_ROLE: "analyst" } });
      expect(r.code).toBe(0);
      expect(JSON.parse(inboxLines()[0] as string).run_id).toBe(null);
    });
  });

  describe("developer done", () => {
    test("in a dirty worktree exits 2 and lists the files", () => {
      commit();
      writeFileSync(join(s.worktree, "wip.go"), "x");
      const r = run(["done", "--summary", "s"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("uncommitted changes");
      expect(r.stderr).toContain("?? wip.go");
      expect(inboxLines()).toEqual([]);
    });
    test("with no commits ahead of base exits 2", () => {
      const r = run(["done", "--summary", "s"]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("no commits on your branch ahead of main");
    });
    test("fills in the commits ahead of base", () => {
      commit("PAY-102: one");
      commit("PAY-102: two");
      const r = run(["done", "--summary", "s", "--json"]);
      expect(r.code, r.stderr).toBe(0);
      const shas = Bun.spawnSync(["git", "rev-list", "--reverse", "main..HEAD"], { cwd: s.worktree })
        .stdout.toString()
        .trim()
        .split("\n");
      expect(JSON.parse(r.stdout).payload.commits).toEqual(shas);
    });
    test("a missing base branch exits 3", () => {
      commit();
      const exec = JSON.parse(readFileSync(join(s.execDir, "execution.json"), "utf8"));
      writeFileSync(join(s.execDir, "execution.json"), JSON.stringify({ ...exec, base: "nope" }));
      expect(run(["done", "--summary", "s"]).code).toBe(3);
    });
    test("a verdict from a developer exits 2", () => {
      commit();
      expect(run(["done", "--summary", "s", "--verdict", "approve"]).stderr).toContain(
        "only reviewers give a --verdict",
      );
    });
  });

  describe("after done or fail, every write exits 4", () => {
    const writes: [string, string[]][] = [
      ["status", ["status", "x"]],
      ["artifact", ["artifact", "--kind", "file", "--ref", "a"]],
      ["ask", ["ask", "q?"]],
      ["done", ["done", "--summary", "again"]],
      ["fail", ["fail", "--reason", "r", "--category", "other"]],
    ];
    for (const ender of ["done", "fail"]) {
      for (const [name, argv] of writes) {
        test(`${name} after ${ender}`, () => {
          commit();
          const first =
            ender === "done"
              ? run(["done", "--summary", "s"])
              : run(["fail", "--reason", "r", "--category", "tooling", "--retryable"]);
          expect(first.code, first.stderr).toBe(0);
          writeFileSync(join(s.worktree, "dirty.txt"), "x"); // done's own checks must not run first
          const r = run(argv);
          expect(r.code).toBe(4);
          expect(r.stderr).toContain(`already ended with \`collie ${ender}\``);
          expect(inboxLines().length).toBe(1);
        });
      }
    }
    test("finding after a reviewer's done", () => {
      s.cleanup();
      s = scratchExecution("reviewer");
      expect(run(["done", "--summary", "ok", "--verdict", "approve"]).code).toBe(0);
      expect(run(["finding", "--severity", "low", "--title", "t", "--body", "b"]).code).toBe(4);
    });
  });

  test("--json prints the recorded event, which is a valid inbox line", () => {
    const r = run(["status", "hello", "--json"]);
    const event = JSON.parse(r.stdout);
    expect(inboxLines()).toEqual([JSON.stringify(event)]);
    expect(event).toMatchObject({
      v: 1,
      type: "status",
      source: "agent",
      run_id: s.env.COLLIE_RUN_ID,
      ticket: "PAY-102",
    });
    expect(parseInboxLine(`${inboxLines()[0]}\n`).ok).toBe(true);
  });

  test("ask prints the question id and tells the agent to end its turn", () => {
    const r = run(["ask", "404 or 403?"]);
    const id = JSON.parse(inboxLines()[0] as string).id;
    expect(r.stdout).toBe(
      `Question ${id} recorded. End your turn now; the answer will arrive as your next message.\n`,
    );
  });

  test("an unwritable inbox exits 5 and says to run it again", () => {
    writeFileSync(s.inbox, "");
    chmodSync(s.inbox, 0o444);
    const r = run(["status", "x"]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("run the same command again");
  });

  test("a torn final line from a crashed writer is closed off, not merged into", () => {
    writeFileSync(s.inbox, '{"v":1,"type":"stat');
    expect(run(["status", "after a crash"]).code).toBe(0);
    const lines = readFileSync(s.inbox, "utf8").split("\n");
    expect(lines[0]).toBe('{"v":1,"type":"stat');
    expect(JSON.parse(lines[1] as string).payload.message).toBe("after a crash");
  });

  test("roles: developers don't record findings; reviewers don't record artifacts", () => {
    expect(run(["finding", "--severity", "low", "--title", "t", "--body", "b"]).stderr).toContain(
      "for reviewer and analyst agents",
    );
    expect(
      run(["artifact", "--kind", "file", "--ref", "a"], { env: { COLLIE_ROLE: "reviewer" } }).stderr,
    ).toContain("for developer agents");
  });

  test("an unknown option lists the valid ones", () => {
    const r = run(["status", "x", "--phaze", "testing"]);
    expect([r.code, r.stderr]).toEqual([
      2,
      "collie status: unknown option --phaze. Options: --json, --phase. Run `collie status --help` for every option.\n",
    ]);
  });

  test("an unquoted multi-word message gets a hint to quote it", () => {
    expect(run(["status", "reading", "the", "code"]).stderr).toContain('collie status "reading the code"');
  });
});

describe("reviewer findings and verdicts", () => {
  beforeEach(() => {
    s = scratchExecution("reviewer");
  });
  afterEach(() => s.cleanup());

  test("blocking defaults to true for critical and high, false otherwise; flags override", () => {
    const blocking = (args: string[]) =>
      JSON.parse(run(["finding", "--title", "t", "--body", "b", "--json", ...args]).stdout).payload.blocking;
    expect(blocking(["--severity", "critical"])).toBe(true);
    expect(blocking(["--severity", "high"])).toBe(true);
    expect(blocking(["--severity", "medium"])).toBe(false);
    expect(blocking(["--severity", "high", "--not-blocking"])).toBe(false);
    expect(blocking(["--severity", "info", "--blocking"])).toBe(true);
  });

  test("request_changes without a blocking finding exits 2", () => {
    run(["finding", "--severity", "low", "--title", "t", "--body", "b"]);
    const r = run(["done", "--summary", "s", "--verdict", "request_changes"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs at least one blocking finding");
  });

  test("a body that would pass 64 KB moves to attachments/", () => {
    const body = "x".repeat(MAX_INBOX_LINE_BYTES);
    const r = run(["finding", "--severity", "low", "--title", "big", "--body-file", "-", "--json"], {
      stdin: body,
    });
    expect(r.code, r.stderr).toBe(0);
    const event = JSON.parse(r.stdout);
    expect(event.payload.body).toBeUndefined();
    expect(event.payload.body_ref).toBe(`attachments/${event.id}.md`);
    expect(readFileSync(join(s.execDir, event.payload.body_ref), "utf8")).toBe(body);
    expect(Buffer.byteLength(readFileSync(s.inbox))).toBeLessThan(1024);
  });

  test("a body just under the limit stays inline", () => {
    const r = run(["finding", "--severity", "low", "--title", "t", "--body-file", "-", "--json"], {
      stdin: "y".repeat(60_000),
    });
    expect(JSON.parse(r.stdout).payload.body.length).toBe(60_000);
  });
});

describe("show prints from fixture files", () => {
  const HOME = join(FIXTURES, "home");
  const R = "01JC8YQ0P4E2W7H5S8D3F6G9KB";
  const X = "01JC8ZA0000000000000000001";
  const env = {
    ...(process.env as Record<string, string>),
    COLLIE_HOME: HOME,
    COLLIE_INBOX: join(HOME, "runs", R, "executions", X, "inbox.jsonl"),
    COLLIE_RUN_ID: R,
    COLLIE_EXECUTION_ID: X,
    COLLIE_TICKET: "PAY-102",
    COLLIE_ROLE: "developer",
  };
  const show = (...a: string[]) => collie(CLI_SRC, ["show", ...a], env);

  test("task prints task.md", () => {
    const r = show("task");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(readFileSync(join(HOME, "runs", R, "executions", X, "task.md"), "utf8"));
  });

  test("findings lists open findings, blocking first, with body, suggestion and attachment path", () => {
    const r = show("findings");
    expect(r.stdout).toBe(`2 open findings for PAY-102, blocking first:

1. [high, blocking] Payment id not checked against caller's account
   src/payments/api.go:88
   GET /payments/{id} returns any payment by id.
   Another account's payment is readable.
   Suggestion: Scope the lookup by account id from the auth context.
   (finding 4F2A1C, round 1)

2. [medium] Handler tests miss the error paths
   Full text: ${HOME}/runs/${R}/executions/01JC8Z90000000000000000001/attachments/01JC8Z920000000000007KQ9D3.md
   (finding 7KQ9D3, round 1)
`);
  });

  test("answers lists this execution's answers and those shared with the ticket", () => {
    expect(show("answers").stdout).toBe(`Question 3QWE7P: Should the 404 body include the payment id?
Answer: No: never echo ids back.

Question 9XRT5V (asked by another agent on this ticket): Is cross-account access ever allowed for admins?
Answer: No, not even for admins.
`);
  });

  test("--json gives the same data", () => {
    const j = JSON.parse(show("findings", "--json").stdout);
    expect(j.findings.map((f: { id: string }) => f.id.slice(-6))).toEqual(["4F2A1C", "7KQ9D3"]);
    expect(JSON.parse(show("answers", "--json").stdout).answers.length).toBe(2);
  });

  test("with no state yet, findings and answers say so", () => {
    const r = collie(CLI_SRC, ["show", "findings"], { ...env, COLLIE_RUN_ID: "01JC8YQ0P4E2W7H5S8D3F6G9KC" });
    expect(r.stdout).toBe("No open findings for PAY-102.\n");
  });

  test("an unknown view exits 2", () => {
    expect(show("brief").code).toBe(2);
  });
});

describe("help", () => {
  test("collie --help fits on one screen (24 lines, 80 columns)", () => {
    const r = collie(CLI_SRC, ["--help"], process.env as Record<string, string>);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(24);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80);
  });
  test.each(["show", "status", "finding", "artifact", "ask", "done", "fail"])(
    "collie %s --help works outside an execution",
    (cmd) => {
      const r = collie(CLI_SRC, [cmd, "--help"], { PATH: process.env.PATH ?? "" });
      expect(r.code).toBe(0);
      expect(r.stdout).toStartWith(`collie ${cmd}`);
    },
  );
});

describe("compiled binary", () => {
  let dir: string;
  let bin: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "collie-bin-"));
    bin = join(dir, "collie");
    const p = Bun.spawnSync(
      ["bun", "build", "--compile", join(import.meta.dir, "../src/main.ts"), "--outfile", bin],
      { cwd: dir },
    ); // bun build --compile leaves temporary .bun-build files in its working folder
    if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    // The first launch of a new binary is slow on macOS (it gets scanned); get that over with.
    Bun.spawnSync([bin, "--help"]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => {
    s = scratchExecution("reviewer");
  });
  afterEach(() => s.cleanup());

  test("20 parallel collie finding calls produce exactly 20 intact lines", async () => {
    const body = "z".repeat(20_000); // big enough that unlocked writes could interleave
    const procs = Array.from({ length: 20 }, (_, i) =>
      Bun.spawn([bin, "finding", "--severity", "low", "--title", `finding ${i}`, "--body", body], {
        env: s.env,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual(Array(20).fill(0));
    const text = readFileSync(s.inbox, "utf8");
    const lines = text.split(/(?<=\n)/);
    expect(lines.length).toBe(20);
    for (const l of lines) {
      const r = parseInboxLine(l);
      if (!r.ok) throw new Error(formatIssues(r.issues));
    }
    const titles = lines.map((l) => JSON.parse(l).payload.title).sort();
    expect(titles).toEqual(Array.from({ length: 20 }, (_, i) => `finding ${i}`).sort());
    expect(new Set(lines.map((l) => JSON.parse(l).id)).size).toBe(20);
  });

  test("waits for the inbox lock before checking and writing", async () => {
    writeFileSync(s.inbox, "");
    const fd = openSync(s.inbox, "a");
    lockExclusive(fd);
    const p = Bun.spawn([bin, "status", "after the lock"], { env: s.env, stdout: "pipe", stderr: "pipe" });
    let exited = false;
    p.exited.then(() => {
      exited = true;
    });
    await Bun.sleep(1000);
    expect(exited).toBe(false);
    expect(readFileSync(s.inbox, "utf8")).toBe("");
    // While we hold the lock, the execution ends; the waiting writer must see that.
    writeFileSync(
      s.inbox,
      `${JSON.stringify({ id: "X", type: "done", execution_id: s.env.COLLIE_EXECUTION_ID })}\n`,
    );
    unlock(fd);
    closeSync(fd);
    expect(await p.exited).toBe(4);
  });

  test("runs without bun on PATH", () => {
    const r = collie(bin, ["status", "from the binary"], { ...s.env, PATH: "/usr/bin:/bin" });
    expect(r.code, r.stderr).toBe(0);
  });
});
