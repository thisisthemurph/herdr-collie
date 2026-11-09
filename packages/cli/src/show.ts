// `collie show task | findings | answers`: read-only views of what the controller wrote.
// task.md sits next to the inbox; findings and answers come from the run's state.json, with
// each finding's body and suggestion looked up in events.jsonl (state.json keeps only a
// summary of each finding).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SEVERITIES, type StateFile, validateState } from "@collie/schema";
import { parseArgs } from "./args.ts";
import type { CollieEnv } from "./env.ts";
import { CliError, EXIT, invalid } from "./errors.ts";
import type { Output } from "./report.ts";

const runDir = (env: CollieEnv) => (env.runId ? join(env.home, "runs", env.runId) : null);

function readState(env: CollieEnv): StateFile | null {
  const dir = runDir(env);
  if (!dir || !existsSync(join(dir, "state.json"))) return null;
  const r = validateState(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")));
  if (!r.ok)
    throw new CliError(EXIT.io, `${join(dir, "state.json")} is unreadable right now; run the command again.`);
  return r.value;
}

/** Finding events from events.jsonl, by id, for their body and suggestion. */
function findingEvents(env: CollieEnv): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const dir = runDir(env);
  const path = dir && join(dir, "events.jsonl");
  if (!path || !existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"finding"')) continue;
    try {
      const e = JSON.parse(line);
      if (e.type === "finding") out.set(e.id, { ...e.payload, execution_id: e.execution_id });
    } catch {}
  }
  return out;
}

const short = (id: string) => id.slice(-6);

function task(env: CollieEnv): Output {
  const path = join(env.execDir, "task.md");
  if (!existsSync(path)) {
    throw new CliError(
      EXIT.env,
      `there is no brief at ${path}. Collie writes it before starting you; report this with collie fail --category tooling.`,
    );
  }
  const text = readFileSync(path, "utf8");
  return { text: text.endsWith("\n") ? text.slice(0, -1) : text, json: { path, task: text } };
}

function findings(env: CollieEnv): Output {
  const state = readState(env);
  const bodies = findingEvents(env);
  const rank = (s: string) => SEVERITIES.indexOf(s as (typeof SEVERITIES)[number]);
  const open = (state?.findings ?? [])
    .filter((f) => f.ticket === env.ticket && f.addressed_in_round === null)
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || rank(a.severity) - rank(b.severity));
  const items = open.map((f) => {
    const ev = bodies.get(f.id) ?? {};
    const bodyRef =
      typeof ev.body_ref === "string" && runDir(env)
        ? join(runDir(env) as string, "executions", String(ev.execution_id), ev.body_ref)
        : undefined;
    return {
      id: f.id,
      severity: f.severity,
      blocking: f.blocking,
      title: f.title,
      file: f.file ?? null,
      line: f.line ?? null,
      round: f.round,
      category: (ev.category as string | undefined) ?? null,
      body: (ev.body as string | undefined) ?? null,
      body_path: bodyRef ?? null,
      suggestion: (ev.suggestion as string | undefined) ?? null,
    };
  });
  if (items.length === 0)
    return { text: `No open findings for ${env.ticket}.`, json: { ticket: env.ticket, findings: [] } };
  const lines = [
    `${items.length} open finding${items.length === 1 ? "" : "s"} for ${env.ticket}, blocking first:`,
    "",
  ];
  items.forEach((f, i) => {
    lines.push(`${i + 1}. [${f.severity}${f.blocking ? ", blocking" : ""}] ${f.title}`);
    if (f.file) lines.push(`   ${f.file}${f.line ? `:${f.line}` : ""}`);
    if (f.body)
      lines.push(
        ...f.body
          .trimEnd()
          .split("\n")
          .map((l) => `   ${l}`),
      );
    if (f.body_path) lines.push(`   Full text: ${f.body_path}`);
    if (f.suggestion) lines.push(`   Suggestion: ${f.suggestion}`);
    lines.push(`   (finding ${short(f.id)}, round ${f.round})`, "");
  });
  return { text: lines.join("\n").trimEnd(), json: { ticket: env.ticket, findings: items } };
}

function answers(env: CollieEnv): Output {
  const state = readState(env);
  // DECISION: an execution sees its own answers plus every answer shared with its ticket.
  const items = Object.entries(state?.questions ?? {})
    .filter(
      ([, q]) =>
        q.answer !== null &&
        (q.execution_id === env.executionId || (q.ticket === env.ticket && q.share_with_ticket)),
    )
    .map(([id, q]) => ({
      id,
      question: q.question,
      answer: q.answer as string,
      mine: q.execution_id === env.executionId,
    }));
  if (items.length === 0)
    return { text: `No answers yet for ${env.ticket}.`, json: { ticket: env.ticket, answers: [] } };
  const lines: string[] = [];
  for (const a of items) {
    lines.push(
      `Question ${short(a.id)}${a.mine ? "" : " (asked by another agent on this ticket)"}: ${a.question}`,
    );
    lines.push(`Answer: ${a.answer}`, "");
  }
  return { text: lines.join("\n").trimEnd(), json: { ticket: env.ticket, answers: items } };
}

const VIEWS = { task, findings, answers } as const;

export function show(env: CollieEnv, args: string[]): Output {
  const p = parseArgs("show", args, {
    flags: ["json"],
    positionals: [1, 1],
    positionalNames: ["task, findings or answers"],
  });
  const what = p.positionals[0] as string;
  const view = VIEWS[what as keyof typeof VIEWS];
  if (!view) throw invalid(`collie show takes task, findings or answers, not ${JSON.stringify(what)}.`);
  return view(env);
}
