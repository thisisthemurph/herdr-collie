import { describe, expect, test } from "bun:test";
import {
  AGENT_EVENT_TYPES,
  CONTROLLER_EVENT_TYPES,
  formatIssues,
  MAX_INBOX_LINE_BYTES,
  parseInboxLine,
  SCHEMA_VERSION,
  splitLines,
  validateAgentEvent,
} from "../src/index.ts";

const status = {
  v: 1,
  id: "01JC8Z4Q7R2M5T9VX3KB6N1HDA",
  type: "status",
  ts: "2026-11-08T10:25:13.412Z",
  source: "agent",
  run_id: "01JC8YQ0P4E2W7H5S8D3F6G9KB",
  execution_id: "01JC8Z1A9C4V6B2N8M5X7Z3QWE",
  ticket: "PAY-102",
  caused_by: null,
  payload: { message: "hello" },
};

test("SCHEMA_VERSION is 1", () => expect(SCHEMA_VERSION).toBe(1));

test("agent types are bare words and controller types are dotted", () => {
  expect(AGENT_EVENT_TYPES.sort()).toEqual(["artifact", "ask", "done", "fail", "finding", "status"]);
  expect(CONTROLLER_EVENT_TYPES.every((t) => t.includes("."))).toBe(true);
  expect(AGENT_EVENT_TYPES.some((t) => t.includes("."))).toBe(false);
});

test("unknown fields are ignored, at the top level and in payloads", () => {
  const r = validateAgentEvent({ ...status, extra: 1, payload: { message: "hi", future_field: true } });
  expect(r.ok).toBe(true);
});

test("an unknown major version is rejected with a clear message", () => {
  const r = validateAgentEvent({ ...status, v: 2 });
  expect(r.ok).toBe(false);
  if (!r.ok)
    expect(formatIssues(r.issues)).toBe("v: unsupported schema version 2; this reader understands 1");
});

test("all problems are reported at once", () => {
  const r = validateAgentEvent({ ...status, id: "x", ts: "yesterday" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.issues.map((i) => i.path).sort()).toEqual(["id", "ts"]);
});

test("an impossible date is rejected", () => {
  expect(validateAgentEvent({ ...status, ts: "2026-02-30T10:00:00.000Z" }).ok).toBe(false);
  expect(validateAgentEvent({ ...status, ts: "2026-13-45T99:00:00.000Z" }).ok).toBe(false);
  expect(validateAgentEvent({ ...status, ts: "2028-02-29T23:59:59.999Z" }).ok).toBe(true);
});

describe("inbox line limits", () => {
  test("a line at exactly 64 KB is accepted", () => {
    const base = `${JSON.stringify({ ...status, payload: { message: "x" }, pad: "" })}\n`;
    const pad = "y".repeat(MAX_INBOX_LINE_BYTES - Buffer.byteLength(base));
    const line = `${JSON.stringify({ ...status, payload: { message: "x" }, pad })}\n`;
    expect(Buffer.byteLength(line)).toBe(MAX_INBOX_LINE_BYTES);
    expect(parseInboxLine(line).ok).toBe(true);
  });

  test("a line over 64 KB is rejected and points at body_ref", () => {
    const line = `${JSON.stringify({ ...status, pad: "y".repeat(MAX_INBOX_LINE_BYTES) })}\n`;
    const r = parseInboxLine(line);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(formatIssues(r.issues)).toContain("body_ref");
  });

  test("a line without a newline is flagged incomplete, not invalid", () => {
    const r = parseInboxLine(JSON.stringify(status));
    expect(r.ok).toBe(false);
    expect(r.incomplete).toBe(true);
  });
});

test("splitLines keeps complete lines and returns the partial tail", () => {
  expect(splitLines('{"a":1}\n{"b":2}\n{"c"')).toEqual({
    lines: ['{"a":1}\n', '{"b":2}\n'],
    partial: '{"c"',
  });
  expect(splitLines("")).toEqual({ lines: [], partial: "" });
});
