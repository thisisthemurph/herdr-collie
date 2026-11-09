// Appends one event to the execution's inbox (docs/protocol.md, "Inbox rules"):
// take an exclusive flock, check the execution hasn't ended, then write the whole line in one
// write(). An I/O error is retried with the same event id, after checking whether the line
// already landed, so the controller never sees a duplicate.
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type AgentEvent, MAX_INBOX_LINE_BYTES, splitLines } from "@collie/schema";
import type { CollieEnv } from "./env.ts";
import { CliError, EXIT } from "./errors.ts";
import { lockExclusive, unlock } from "./flock.ts";

/** An inbox line, parsed loosely: lines are the CLI's own, but a reader never trusts a file. */
export type InboxEntry = {
  id?: string;
  type?: string;
  execution_id?: string;
  payload?: Record<string, unknown>;
};

export function parseInbox(text: string): InboxEntry[] {
  const out: InboxEntry[] = [];
  for (const line of splitLines(text).lines) {
    try {
      out.push(JSON.parse(line) as InboxEntry);
    } catch {
      // A corrupt line is the controller's to reject; the CLI only needs the well-formed ones.
    }
  }
  return out;
}

export const endedBy = (entries: InboxEntry[], executionId: string) =>
  entries.find((e) => e.execution_id === executionId && (e.type === "done" || e.type === "fail"));

// DECISION: "retry with the same id" happens inside one call: up to 3 attempts reuse the
// event id, and each retry first checks whether the earlier attempt's line landed. Exit 5
// only after all three fail; the next call is a new event with a new id.
const RETRIES = 3;

export type AppendOptions = {
  /** Runs under the lock, after the ended check, with the inbox as it stands. Throw to refuse. */
  check?: (entries: InboxEntry[]) => void;
};

export function appendEvent(env: CollieEnv, event: AgentEvent, opts: AppendOptions = {}): void {
  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line) > MAX_INBOX_LINE_BYTES) {
    throw new CliError(
      EXIT.invalid,
      `the event is ${Buffer.byteLength(line)} bytes, over the 64 KB line limit. Shorten the longest text, or pass long text with --body-file.`,
    );
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      writeLocked(env, event, line, opts, attempt > 1);
      return;
    } catch (e) {
      if (e instanceof CliError) throw e;
      lastError = e;
      if (attempt < RETRIES) Bun.sleepSync(50 * attempt);
    }
  }
  throw new CliError(
    EXIT.io,
    `could not write to ${env.inbox}: ${(lastError as Error).message}. Nothing is lost; run the same command again.`,
  );
}

function writeLocked(env: CollieEnv, event: AgentEvent, line: string, opts: AppendOptions, retry: boolean) {
  const fd = openSync(env.inbox, "a");
  try {
    lockExclusive(fd);
    const text = fstatSync(fd).size > 0 ? readFileSync(env.inbox, "utf8") : "";
    const entries = parseInbox(text);
    // A retry after an uncertain write: if the line is there, the first attempt worked.
    if (retry && entries.some((e) => e.id === event.id)) return;
    const ended = endedBy(entries, env.executionId);
    if (ended) {
      throw new CliError(
        EXIT.ended,
        `this execution already ended with \`collie ${ended.type}\` (event ${ended.id}). Nothing more can be recorded; end your turn.`,
      );
    }
    opts.check?.(entries);
    // DECISION: a final line without "\n" can only be left by a writer that died mid-write
    // (we hold the lock). Close it off in the same write so it can't swallow this line; the
    // controller rejects it as invalid instead of waiting for the rest.
    const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    const buf = Buffer.from(prefix + line);
    const n = writeSync(fd, buf);
    if (n !== buf.length) throw new Error(`short write: ${n} of ${buf.length} bytes`);
  } finally {
    try {
      unlock(fd);
    } finally {
      closeSync(fd);
    }
  }
}

/** Writes a long body to attachments/<event-id>.md and returns the body_ref for the event. */
export function writeAttachment(env: CollieEnv, eventId: string, body: string): string {
  const dir = join(env.execDir, "attachments");
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(join(dir, `${eventId}.md`), "w");
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    throw new CliError(
      EXIT.io,
      `could not write the attachment in ${dir}: ${(e as Error).message}. Run the same command again.`,
    );
  }
  return `attachments/${eventId}.md`;
}
