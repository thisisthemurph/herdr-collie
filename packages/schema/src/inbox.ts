// Inbox and events.jsonl line parsing (docs/protocol.md, "Inbox rules").
import { MAX_INBOX_LINE_BYTES } from "./common.ts";
import { type AgentEvent, type AnyEvent, agentEvent, anyEvent } from "./events.ts";
import { type Issue, type Result, runSchema, type Schema } from "./validate.ts";

export type LineResult<T> = Result<T> & { incomplete?: boolean };

function parseLine<T>(schema: Schema<T>, line: string): LineResult<T> {
  if (!line.endsWith("\n")) {
    // Rule 4: a final line without "\n" is incomplete: skip it and re-read on the next change.
    return {
      ok: false,
      incomplete: true,
      issues: [{ path: "", message: "line has no trailing newline (incomplete write)" }],
    };
  }
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_INBOX_LINE_BYTES) {
    return {
      ok: false,
      issues: [
        {
          path: "",
          message: `line is ${bytes} bytes, over the ${MAX_INBOX_LINE_BYTES}-byte limit; move long bodies to attachments/ and use body_ref`,
        },
      ],
    };
  }
  const text = line.slice(0, -1);
  if (text.includes("\n")) return { ok: false, issues: [{ path: "", message: "must be exactly one line" }] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, issues: [{ path: "", message: `is not valid JSON: ${(e as Error).message}` }] };
  }
  return runSchema(schema, value);
}

/** One inbox line, including its trailing "\n". */
export function parseInboxLine(line: string): LineResult<AgentEvent> {
  return parseLine(agentEvent, line);
}

/** One events.jsonl line (agent or controller event), including its trailing "\n". */
export function parseEventLine(line: string): LineResult<AnyEvent> {
  return parseLine(anyEvent, line);
}

/**
 * Splits JSONL text into complete lines (each keeping its "\n"). A trailing fragment without
 * "\n" is returned separately so the reader can retry it later.
 */
export function splitLines(text: string): { lines: string[]; partial: string } {
  const lines: string[] = [];
  let start = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", start)) {
    lines.push(text.slice(start, i + 1));
    start = i + 1;
  }
  return { lines, partial: text.slice(start) };
}

export type { Issue };
