// The ~/.collie storage layout (docs/protocol.md, "Storage layout and inbox format"), and the
// file primitives the controller uses: every JSON write is atomic (temp file, then rename).
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function defaultHome(env: Record<string, string | undefined> = process.env): string {
  const h = env.COLLIE_HOME;
  if (!h) return join(homedir(), ".collie");
  return h === "~" || h.startsWith("~/") ? join(homedir(), h.slice(1)) : h;
}

export class Home {
  constructor(readonly root: string) {}
  get lock() {
    return join(this.root, "controller.lock");
  }
  get leases() {
    return join(this.root, "leases.json");
  }
  /** DECISION: the controller's own log (not in the protocol's layout). Never holds secrets. */
  get log() {
    return join(this.root, "controller.log");
  }
  get pending() {
    return join(this.root, "control", "pending");
  }
  get done() {
    return join(this.root, "control", "done");
  }
  get runs() {
    return join(this.root, "runs");
  }
  get boards() {
    return join(this.root, "boards");
  }
  profile(id: string) {
    return join(this.root, "profiles", `${id}.json`);
  }
  workflow(id: string) {
    return join(this.root, "workflows", `${id}.json`);
  }
  board(id: string) {
    return join(this.boards, id, "board.json");
  }
  runDir(runId: string) {
    return join(this.runs, runId);
  }
  runFile(runId: string) {
    return join(this.runDir(runId), "run.json");
  }
  events(runId: string) {
    return join(this.runDir(runId), "events.jsonl");
  }
  state(runId: string) {
    return join(this.runDir(runId), "state.json");
  }
  execDir(runId: string, execId: string) {
    return join(this.runDir(runId), "executions", execId);
  }
  inbox(runId: string, execId: string) {
    return join(this.execDir(runId, execId), "inbox.jsonl");
  }

  ensureLayout() {
    for (const d of [
      this.pending,
      this.done,
      this.runs,
      this.boards,
      join(this.root, "profiles"),
      join(this.root, "workflows"),
    ]) {
      mkdirSync(d, { recursive: true });
    }
  }
}

/** Writes JSON atomically: a temp file in the same folder, fsync, then rename over the target. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readJsonIfExists(path: string): unknown | undefined {
  return existsSync(path) ? readJson(path) : undefined;
}

/** Appends text with one write() and fsyncs it. */
export function appendDurable(path: string, text: string): void {
  const fd = openSync(path, "a");
  try {
    const buf = Buffer.from(text);
    const n = writeSync(fd, buf);
    if (n !== buf.length) throw new Error(`short write to ${path}: ${n} of ${buf.length} bytes`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
