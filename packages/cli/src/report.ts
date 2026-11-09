// The six agent commands: status, finding, artifact, ask, done, fail. Each builds an event,
// validates it with packages/schema, runs its local checks, and appends it to the inbox.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentEventType,
  eventTs,
  type Issue,
  MAX_INBOX_LINE_BYTES,
  newUlid,
  validateAgentEvent,
} from "@collie/schema";
import { type Parsed, parseArgs } from "./args.ts";
import { type CollieEnv, expandHome, readExecutionFile } from "./env.ts";
import { type CliError, invalid } from "./errors.ts";
import { commitsAhead, requireClean } from "./git.ts";
import { appendEvent, type InboxEntry, writeAttachment } from "./inbox.ts";

export type Output = { text: string; json: unknown };

// --- fix-it messages: schema field paths -> the option an agent can change

const OPTION_FOR: Record<string, string> = {
  message: "the <message> argument",
  question: "the <question> argument",
  options: "--option",
  commits: "--commit",
  "tests.command": "--tests-command",
  "tests.passed": "--tests-passed or --tests-failed",
  body: "--body or --body-file",
  body_ref: "--body-file",
};

function optionName(path: string): string {
  const field = path.replace(/^payload\./, "").replace(/\[\d+\]/g, "");
  return OPTION_FOR[field] ?? `--${field.replace(/_/g, "-")}`;
}

function fixIt(command: string, issues: Issue[]): CliError {
  const lines = issues.map((i) => `${optionName(i.path)} ${i.message}`);
  return invalid(`${lines.join("; ")}. Run \`collie ${command} --help\` for every option.`);
}

// --- shared helpers

/** Text from `--<name>` or `--<name>-file <path|->`; never both. */
function text(p: Parsed, name: string, command: string): string | undefined {
  const inline = p.values.get(name);
  const file = p.values.get(`${name}-file`);
  if (inline !== undefined && file !== undefined) {
    throw invalid(`give --${name} or --${name}-file, not both. Run \`collie ${command} --help\`.`);
  }
  if (file === undefined) return inline;
  try {
    return readFileSync(file === "-" ? 0 : file, "utf8");
  } catch (e) {
    throw invalid(`cannot read --${name}-file ${file}: ${(e as Error).message}`);
  }
}

function intOption(p: Parsed, name: string): number | undefined {
  const v = p.values.get(name);
  if (v === undefined) return undefined;
  if (!/^-?\d+$/.test(v)) throw invalid(`--${name} must be a whole number, got ${JSON.stringify(v)}`);
  return Number(v);
}

function envelope(env: CollieEnv, type: AgentEventType, payload: Record<string, unknown>): AgentEvent {
  const now = Date.now();
  return {
    v: 1,
    id: newUlid(now),
    type,
    ts: eventTs(now),
    source: "agent",
    run_id: env.runId,
    execution_id: env.executionId,
    ticket: env.ticket,
    caused_by: null,
    payload,
  } as AgentEvent;
}

/** Drops undefined fields so the event carries only what the agent gave. */
const compact = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function validated(command: string, event: AgentEvent): AgentEvent {
  const r = validateAgentEvent(event);
  if (!r.ok) throw fixIt(command, r.issues);
  return r.value;
}

function requireRole(env: CollieEnv, command: string, allowed: string[], why: string) {
  if (!allowed.includes(env.role)) {
    throw invalid(
      `collie ${command} is for ${allowed.join(" and ")} agents, and you are the ${env.role}. ${why}`,
    );
  }
}

const blockingOf = (e: InboxEntry) => e.type === "finding" && e.payload?.blocking === true;

// --- commands

export function status(env: CollieEnv, args: string[]): { event: AgentEvent; out: Output } {
  const p = parseArgs("status", args, {
    flags: ["json"],
    values: ["phase"],
    positionals: [1, 1],
    positionalNames: ["<message>"],
  });
  const event = validated(
    "status",
    envelope(env, "status", compact({ message: p.positionals[0], phase: p.values.get("phase") })),
  );
  appendEvent(env, event);
  return { event, out: { text: "Status recorded.", json: event } };
}

export function finding(env: CollieEnv, args: string[]): { event: AgentEvent; out: Output } {
  const p = parseArgs("finding", args, {
    flags: ["json", "blocking", "not-blocking"],
    values: ["severity", "title", "body", "body-file", "file", "line", "end-line", "category", "suggestion"],
  });
  // DECISION: findings are for reviewers and analysts (analysts record design suggestions).
  requireRole(env, "finding", ["reviewer", "analyst"], "Developers fix issues instead of recording them.");
  if (p.flags.has("blocking") && p.flags.has("not-blocking")) {
    throw invalid("give --blocking or --not-blocking, not both. Run `collie finding --help`.");
  }
  const severity = p.values.get("severity");
  // DECISION: the CLI writes `blocking` explicitly, defaulting to true for critical and high,
  // so the controller and the reviewer's own done check read the same value.
  const blocking = p.flags.has("blocking")
    ? true
    : p.flags.has("not-blocking")
      ? false
      : severity === "critical" || severity === "high";
  const event = envelope(
    env,
    "finding",
    compact({
      severity,
      title: p.values.get("title"),
      body: text(p, "body", "finding"),
      file: p.values.get("file"),
      line: intOption(p, "line"),
      end_line: intOption(p, "end-line"),
      category: p.values.get("category"),
      suggestion: p.values.get("suggestion"),
      blocking,
    }),
  );
  // Inbox rule 5: a body that would push the line over 64 KB moves to attachments/.
  const payload = event.payload as Record<string, unknown>;
  if (
    typeof payload.body === "string" &&
    Buffer.byteLength(`${JSON.stringify(event)}\n`) > MAX_INBOX_LINE_BYTES
  ) {
    validated("finding", event); // report argument mistakes before writing a file
    payload.body_ref = writeAttachment(env, event.id, payload.body);
    delete payload.body;
  }
  const checked = validated("finding", event);
  appendEvent(env, checked);
  const where = payload.body_ref
    ? ` The body was long, so it is stored in ${join(env.execDir, payload.body_ref as string)}.`
    : "";
  return {
    event: checked,
    out: {
      text: `Finding recorded (${severity}, ${blocking ? "blocking" : "not blocking"}).${where}`,
      json: checked,
    },
  };
}

export function artifact(env: CollieEnv, args: string[]): { event: AgentEvent; out: Output } {
  const p = parseArgs("artifact", args, { flags: ["json"], values: ["kind", "ref", "description"] });
  // DECISION: artifacts are the developer's (commits, branches, test reports, files).
  requireRole(env, "artifact", ["developer"], "Reviewers report with collie finding.");
  const event = validated(
    "artifact",
    envelope(
      env,
      "artifact",
      compact({
        kind: p.values.get("kind"),
        ref: p.values.get("ref"),
        description: p.values.get("description"),
      }),
    ),
  );
  appendEvent(env, event);
  return {
    event,
    out: { text: `Artifact recorded (${p.values.get("kind")} ${p.values.get("ref")}).`, json: event },
  };
}

export function ask(env: CollieEnv, args: string[]): { event: AgentEvent; out: Output } {
  const p = parseArgs("ask", args, {
    flags: ["json"],
    values: ["context"],
    multi: ["option"],
    positionals: [1, 1],
    positionalNames: ["<question>"],
  });
  const event = validated(
    "ask",
    envelope(
      env,
      "ask",
      compact({
        question: p.positionals[0],
        options: p.multi.get("option"),
        context: p.values.get("context"),
      }),
    ),
  );
  appendEvent(env, event);
  return {
    event,
    out: {
      text: `Question ${event.id} recorded. End your turn now; the answer will arrive as your next message.`,
      json: event,
    },
  };
}

export function done(env: CollieEnv, args: string[]): { event: AgentEvent; out: Output } {
  const p = parseArgs("done", args, {
    flags: ["json", "tests-passed", "tests-failed"],
    values: ["summary", "summary-file", "verdict", "tests-command"],
    multi: ["commit"],
  });
  const verdict = p.values.get("verdict");
  if (p.flags.has("tests-passed") && p.flags.has("tests-failed")) {
    throw invalid("give --tests-passed or --tests-failed, not both. Run `collie done --help`.");
  }
  const testsCommand = p.values.get("tests-command");
  const passed = p.flags.has("tests-passed") ? true : p.flags.has("tests-failed") ? false : undefined;
  if (testsCommand === undefined && passed !== undefined) {
    throw invalid(
      "--tests-passed and --tests-failed need --tests-command, the command you ran. Run `collie done --help`.",
    );
  }
  const tests = testsCommand === undefined ? undefined : { command: testsCommand, passed };

  if (env.role === "reviewer" && verdict === undefined) {
    throw invalid(
      "reviewers must give --verdict approve or --verdict request_changes. Run `collie done --help`.",
    );
  }
  // DECISION: only reviewers give a verdict; a developer's or analyst's verdict is a mistake.
  if (env.role !== "reviewer" && verdict !== undefined) {
    throw invalid(`only reviewers give a --verdict, and you are the ${env.role}. Remove --verdict.`);
  }

  let commits = p.multi.get("commit");
  if (env.role === "developer") {
    const exec = readExecutionFile(env);
    const worktree = exec ? expandHome(exec.worktree) : process.cwd();
    requireClean(worktree, env.ticket);
    // DECISION: base comes from execution.json. Without one, the commits-ahead check is left
    // to the controller. With no --commit, the commits ahead of base are filled in.
    if (exec?.base) {
      const ahead = commitsAhead(worktree, exec.base);
      commits ??= ahead;
    }
  }

  const event = validated(
    "done",
    envelope(env, "done", compact({ summary: text(p, "summary", "done"), verdict, commits, tests })),
  );
  appendEvent(env, event, {
    check: (entries) => {
      if (env.role !== "reviewer") return;
      const mine = entries.filter((e) => e.execution_id === env.executionId && blockingOf(e));
      if (verdict === "request_changes" && mine.length === 0) {
        throw invalid(
          "request_changes needs at least one blocking finding. Record it with collie finding --blocking, or approve.",
        );
      }
      // DECISION: also enforce the protocol's other half: approve only with no blocking findings.
      if (verdict === "approve" && mine.length > 0) {
        throw invalid(
          `you recorded ${mine.length} blocking finding${mine.length === 1 ? "" : "s"}, so your verdict must be request_changes.`,
        );
      }
    },
  });
  return { event, out: { text: "Done recorded. Your part is finished; end your turn.", json: event } };
}

export function fail(env: CollieEnv, args: string[]): { event: AgentEvent; out: Output } {
  const p = parseArgs("fail", args, {
    flags: ["json", "retryable"],
    values: ["reason", "category", "details", "details-file"],
  });
  const event = validated(
    "fail",
    envelope(
      env,
      "fail",
      compact({
        reason: p.values.get("reason"),
        category: p.values.get("category"),
        retryable: p.flags.has("retryable"),
        details: text(p, "details", "fail"),
      }),
    ),
  );
  appendEvent(env, event);
  return { event, out: { text: "Failure recorded. Your part is over; end your turn.", json: event } };
}

export const REPORT_COMMANDS = { status, finding, artifact, ask, done, fail } as const;
