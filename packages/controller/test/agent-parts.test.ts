// The small parts of agent execution: templates, the Claude Code adapter, Jira's rich text,
// the ticket brief and the hc wrapper.
import { describe, expect, test } from "bun:test";
import { AdapterError, defaultAdapters } from "../src/adapters/index.ts";
import { adfToText, splitDescription } from "../src/adf.ts";
import { terminalName } from "../src/agents.ts";
import { branchName } from "../src/git.ts";
import { Hc, type HcRunner } from "../src/hc.ts";
import { type HttpRequest, JiraClient } from "../src/jira.ts";
import { FIRST_MESSAGE, render, systemPrompt, taskBrief } from "../src/templates.ts";

const profile = {
  v: 1 as const,
  id: "developer",
  name: "Developer",
  role: "developer" as const,
  harness: "claude-code",
  model: "claude-opus-5-5",
  args: ["--permission-mode", "acceptEdits", "--allowedTools", "Bash(collie:*)"],
  instructions: "Implement the ticket.",
  permissions: { write_worktree: true, shell: true, network: false },
  timeout_min: 45,
  max_attempts: 2,
  updated_at: "2026-11-08T09:00:00Z",
};

describe("templates", () => {
  test("a block is left out when its slot has nothing to show", () => {
    const t = "A\n{{#x}}\nx is {{x}}\n{{/x}}\nB\n{{#y}}\ny is {{y}}\n{{/y}}\n";
    expect(render(t, { x: "1", y: "" })).toBe("A\nx is 1\nB\n");
    expect(render(t, { x: "", y: "2" })).toBe("A\nB\ny is 2\n");
  });

  test("the first message and the system prompt are the protocol's text", () => {
    expect(FIRST_MESSAGE).toBe("Your Collie brief is ready. Run `collie show task` and follow it.");
    const p = systemPrompt(profile);
    expect(p.startsWith("Implement the ticket.\n\n## Working inside Collie")).toBe(true);
    expect(p).toContain("Run long commands (builds, test suites) in the foreground and wait");
    expect(p).toContain("Never push, open pull requests, change\n   Jira, or start other agents.");
  });

  test("task.md has the protocol's sections, and omits the empty ones", () => {
    const brief = (over = {}) =>
      taskBrief({
        ticket: "PAY-102",
        summary: "Payment API endpoints",
        profileName: "Developer",
        kind: "develop",
        round: 1,
        attempt: 2,
        description: "Add the endpoints.",
        criteria: "",
        clarifications: "",
        comments: "",
        repository: "acme/payments",
        worktree: "/w/pay-102",
        branch: "pay-102-api",
        base: "main",
        stacked: "",
        blockedBy: "",
        blocks: "",
        findings: "",
        permissions: profile.permissions,
        timeoutMin: 45,
        ...over,
      });
    expect(brief()).toBe(`# PAY-102 · Payment API endpoints

You are the Developer on PAY-102.
Kind: develop · round 1 · attempt 2

## Ticket
Add the endpoints.

## Context
- Repository: acme/payments
- Working directory: /w/pay-102
- Branch: pay-102-api, based on main

## Your task
Implement the ticket on this branch so every acceptance criterion is met. Add or update tests and run the relevant ones. Commit with messages starting \`PAY-102: \`.

## Limits
You may edit files inside your worktree. You may run shell commands. Do not use the network.
Time limit: 45 minutes.
`);
    const full = brief({
      criteria: "- c1",
      comments: "- Sam: hi",
      blockedBy: "PAY-101 · x (completed)",
      findings: "- high: a",
    });
    expect(full).toContain("### Acceptance criteria\n- c1");
    expect(full).toContain("- Blocked by: PAY-101 · x (completed)");
    expect(full).toContain("## Findings to address\n- high: a");
  });

  test("a read-only profile says so", () => {
    const text = taskBrief({
      ticket: "A-1",
      summary: "s",
      profileName: "Reviewer",
      kind: "review",
      round: 1,
      attempt: 1,
      description: "",
      criteria: "",
      clarifications: "",
      comments: "",
      repository: "r",
      worktree: "w",
      branch: "b",
      base: "main",
      stacked: "",
      blockedBy: "",
      blocks: "",
      findings: "",
      timeoutMin: 30,
      permissions: { write_worktree: false, shell: true, network: false },
    });
    expect(text).toContain("Read-only: do not modify files.");
    expect(text).toContain("(this ticket has no description)");
    expect(text).toContain("`git diff main...HEAD`");
  });
});

describe("claude-code adapter", () => {
  const claude = (resolve: (n: string) => string | null) => {
    const a = defaultAdapters(resolve)["claude-code"];
    if (!a) throw new Error("no adapter");
    return a;
  };

  test("an absolute path, the first message before every option, background tasks off", () => {
    const l = claude(() => "/home/u/.local/bin/claude").launch({
      profile,
      systemPrompt: "SYS",
      firstMessage: "go",
    });
    expect(l.argv).toEqual([
      "/home/u/.local/bin/claude",
      "go",
      "--model",
      "claude-opus-5-5",
      "--append-system-prompt",
      "SYS",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash(collie:*)",
    ]);
    expect(l.env).toEqual({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });
  });

  test("a machine without claude gets a message that says what to do", () => {
    expect(() => claude(() => null).launch({ profile, systemPrompt: "", firstMessage: "" })).toThrow(
      AdapterError,
    );
    expect(() => claude(() => null).launch({ profile, systemPrompt: "", firstMessage: "" })).toThrow(
      "couldn't find `claude` on the controller's PATH. Install Claude Code, or set COLLIE_CLAUDE to its full path, and retry",
    );
  });
});

describe("Jira's rich text", () => {
  const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
  const p = (...c: unknown[]) => ({ type: "paragraph", content: c });
  const t = (text: string, marks?: unknown[]) => ({ type: "text", text, ...(marks ? { marks } : {}) });

  test("paragraphs, lists, code and links read as text", () => {
    const text = adfToText(
      doc(
        p(
          t("Add the "),
          t("endpoint", [{ type: "code" }]),
          t(" per "),
          t("the spec", [{ type: "link", attrs: { href: "https://x.test/s" } }]),
          t("."),
        ),
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [p(t("one"))] },
            { type: "listItem", content: [p(t("two"))] },
          ],
        },
        { type: "orderedList", content: [{ type: "listItem", content: [p(t("first"))] }] },
        { type: "codeBlock", attrs: { language: "go" }, content: [t("func main() {}")] },
        p({ type: "mention", attrs: { text: "@sam" } }, t(" please check")),
      ),
    );
    expect(text).toBe(
      "Add the `endpoint` per the spec (https://x.test/s).\n\n- one\n- two\n\n1. first\n\n```go\nfunc main() {}\n```\n\n@sam please check",
    );
  });

  test("null, strings and unknown nodes don't throw", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText("plain")).toBe("plain");
    expect(adfToText(doc({ type: "somethingNew", content: [p(t("kept"))] }))).toBe("kept");
  });

  test("the acceptance criteria section is split out of the description", () => {
    const heading = (level: number, s: string) => ({ type: "heading", attrs: { level }, content: [t(s)] });
    const r = splitDescription(
      doc(
        p(t("Intro")),
        heading(2, "Acceptance criteria"),
        { type: "bulletList", content: [{ type: "listItem", content: [p(t("it works"))] }] },
        heading(2, "Notes"),
        p(t("A note")),
      ),
    );
    expect(r).toEqual({ description: "Intro\n\n#### Notes\n\nA note", criteria: "- it works" });
    expect(splitDescription(doc(p(t("Only this")))).criteria).toBe("");
  });
});

describe("the ticket brief from Jira", () => {
  test("fetches description and comments, newest ten comments first", async () => {
    const seen: HttpRequest[] = [];
    const comments = Array.from({ length: 12 }, (_, i) => ({
      author: { displayName: `Person ${i}` },
      created: `2026-11-${String(i + 1).padStart(2, "0")}T10:00:00.000+0000`,
      body: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: `comment ${i}` }] }],
      },
    }));
    const jira = new JiraClient(
      async (req) => {
        seen.push(req);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            fields: {
              description: {
                type: "doc",
                version: 1,
                content: [{ type: "paragraph", content: [{ type: "text", text: "Do it." }] }],
              },
              comment: { comments },
            },
          }),
        };
      },
      { jira: async () => ({ email: "me@example.com", token: "tok" }) },
    );
    const b = await jira.brief("[CLOUD-ID]", "PAY-102");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      "https://api.atlassian.com/ex/jira/[CLOUD-ID]/rest/api/3/issue/PAY-102?fields=description,comment",
    );
    expect(b.description).toBe("Do it.");
    expect(b.comments).toHaveLength(10);
    expect(b.comments[0]).toEqual({ author: "Person 11", created: "2026-11-12", text: "comment 11" });
    expect(b.comments.at(-1)?.text).toBe("comment 2");
  });
});

describe("names", () => {
  test("branch and terminal names", () => {
    expect(branchName("PAY-102", "Payment API endpoints!")).toBe("pay-102-payment-api-endpoints");
    expect(branchName("PAY-1", "")).toBe("pay-1");
    expect(branchName("PAY-1", "A very long summary that keeps going and going on")).toBe(
      "pay-1-a-very-long-summary-that-keeps-g",
    );
    const name = terminalName("PAY-102", "01JC8Z1A9C4V6B2N8M5X7Z3QWE");
    expect(name).toMatch(/^pay-102-[a-z0-9]{6}$/);
    expect(terminalName("A-1".repeat(20), "01JC8Z1A9C4V6B2N8M5X7Z3QWE").length).toBeLessThanOrEqual(32);
  });
});

describe("the hc wrapper", () => {
  const record = (outcomes: Record<string, { code: number; stdout?: string; stderr?: string }> = {}) => {
    const calls: { argv: string[]; env: Record<string, string> }[] = [];
    const runner: HcRunner = async (argv, env) => {
      calls.push({ argv, env });
      const o = outcomes[argv[0] as string] ?? { code: 0, stdout: "{}" };
      return { code: o.code, stdout: o.stdout ?? "", stderr: o.stderr ?? "" };
    };
    return { calls, hc: new Hc(runner, { PATH: "/bin", HC_TERMINAL_ID: "t99" }) };
  };

  test("send runs without HC_TERMINAL_ID, and never with --if or --force", async () => {
    const { hc, calls } = record();
    await hc.send("t5", "hello");
    expect(calls[0]?.argv).toEqual(["send", "t5", "hello"]);
    expect(calls[0]?.env).toEqual({ PATH: "/bin" });
    await hc.get("t5");
    expect(calls[1]?.env.HC_TERMINAL_ID).toBe("t99");
  });

  test("hc's exit codes become outcomes", async () => {
    const out = async (code: number) =>
      record({
        send: { code, stderr: JSON.stringify({ error: { kind: "x", message: "m", hint: "" } }) },
      }).hc.send("t", "x");
    expect(await out(0)).toBe("sent");
    expect(await out(9)).toBe("blocked");
    expect(await out(10)).toBe("status_mismatch");
    expect(await out(11)).toBe("finished");
    expect(await out(3)).toBe("not_found");
    await expect(out(2)).rejects.toThrow("m");
  });

  test("get returns null for a terminal that doesn't exist; list reads addresses", async () => {
    const gone = record({ get: { code: 3, stderr: "{}" } });
    expect(await gone.hc.get("t1")).toBeNull();
    const l = record({
      ls: { code: 0, stdout: JSON.stringify({ terminals: [{ address: "t1" }, { address: "t4" }] }) },
    });
    expect(await l.hc.list({ "collie.run": "R" })).toEqual(["t1", "t4"]);
    expect(l.calls[0]?.argv).toEqual(["ls", "--json", "--label", "collie.run=R"]);
  });

  test("run puts the environment in an env wrapper, before the program", async () => {
    const { hc, calls } = record({ run: { code: 0, stdout: JSON.stringify({ address: "t7" }) } });
    const t = await hc.run({
      name: "n",
      cwd: "/w",
      labels: { "collie.run": "R" },
      argv: ["claude", "hi"],
      env: { COLLIE_ROLE: "developer" },
    });
    expect(t).toBe("t7");
    expect(calls[0]?.argv).toEqual([
      "run",
      "--bg",
      "--json",
      "--no-parent",
      "--no-notify",
      "--name",
      "n",
      "--cwd",
      "/w",
      "--label",
      "collie.run=R",
      "--",
      "env",
      "COLLIE_ROLE=developer",
      "claude",
      "hi",
    ]);
  });

  test("an hc that can't be started is reported as unavailable", async () => {
    const hc = new Hc(async () => {
      throw new Error("ENOENT");
    });
    await expect(hc.get("t1")).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("cursor adapter", () => {
  const cursor = (resolve: (n: string) => string | null) => {
    const a = defaultAdapters(resolve).cursor;
    if (!a) throw new Error("no adapter");
    return a;
  };
  const cp = { ...profile, harness: "cursor", model: "auto", args: ["--force"] };

  test("the instructions go in front of the first message, which comes before every option", () => {
    const l = cursor((n) => `/opt/bin/${n}`).launch({ profile: cp, systemPrompt: "SYS", firstMessage: "go" });
    expect(l.argv).toEqual(["/opt/bin/cursor-agent", "SYS\n\ngo", "--model", "auto", "--force"]);
    expect(l.env).toEqual({});
  });

  test("falls back to `agent` when there is no cursor-agent", () => {
    const l = cursor((n) => (n === "agent" ? "/opt/bin/agent" : null)).launch({
      profile: cp,
      systemPrompt: "S",
      firstMessage: "g",
    });
    expect(l.argv[0]).toBe("/opt/bin/agent");
  });

  test("a machine without Cursor's CLI gets a message that says what to do", () => {
    expect(() => cursor(() => null).launch({ profile: cp, systemPrompt: "S", firstMessage: "g" })).toThrow(
      /COLLIE_CURSOR/,
    );
  });
});
