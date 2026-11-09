// The environment Collie sets when it starts an agent (docs/protocol.md, "CLI design").
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ExecutionFile, ROLES, type Role, TICKET_RE, ULID_RE, validateExecution } from "@collie/schema";
import { CliError, EXIT } from "./errors.ts";

export type CollieEnv = {
  home: string;
  inbox: string;
  /** null for analyst executions, which belong to board preparation (COLLIE_RUN_ID=""). */
  runId: string | null;
  executionId: string;
  ticket: string;
  role: Role;
  /** The execution's folder: task.md, execution.json and attachments/ live here. */
  execDir: string;
};

const VARS = [
  "COLLIE_HOME",
  "COLLIE_INBOX",
  "COLLIE_RUN_ID",
  "COLLIE_EXECUTION_ID",
  "COLLIE_TICKET",
  "COLLIE_ROLE",
] as const;

function notInsideThrow(detail: string): never {
  throw new CliError(
    EXIT.env,
    `not inside a Collie execution: ${detail}. Collie sets these variables when it starts an agent; run collie only from an agent Collie launched.`,
  );
}

export const expandHome = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);

export function readEnv(env: Record<string, string | undefined> = process.env): CollieEnv {
  // DECISION: COLLIE_RUN_ID may be set but empty, for analyst executions that have no run.
  const missing = VARS.filter((v) => env[v] === undefined || (env[v] === "" && v !== "COLLIE_RUN_ID"));
  if (missing.length) notInsideThrow(`${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set`);
  const get = (v: (typeof VARS)[number]) => env[v] as string;

  const runId = get("COLLIE_RUN_ID") === "" ? null : get("COLLIE_RUN_ID");
  if (runId !== null && !ULID_RE.test(runId))
    notInsideThrow(`COLLIE_RUN_ID is not a ULID: ${JSON.stringify(runId)}`);
  const executionId = get("COLLIE_EXECUTION_ID");
  if (!ULID_RE.test(executionId))
    notInsideThrow(`COLLIE_EXECUTION_ID is not a ULID: ${JSON.stringify(executionId)}`);
  const ticket = get("COLLIE_TICKET");
  if (!TICKET_RE.test(ticket))
    notInsideThrow(`COLLIE_TICKET is not a Jira issue key: ${JSON.stringify(ticket)}`);
  const role = get("COLLIE_ROLE");
  if (!(ROLES as readonly string[]).includes(role)) {
    notInsideThrow(`COLLIE_ROLE must be one of ${ROLES.join(", ")}, got ${JSON.stringify(role)}`);
  }
  if (runId === null && role !== "analyst")
    notInsideThrow("COLLIE_RUN_ID is empty, which only an analyst may have");
  const inbox = expandHome(get("COLLIE_INBOX"));
  const execDir = dirname(inbox);
  if (!existsSync(execDir)) notInsideThrow(`the folder of COLLIE_INBOX does not exist: ${execDir}`);
  return {
    home: expandHome(get("COLLIE_HOME")),
    inbox,
    runId,
    executionId,
    ticket,
    role: role as Role,
    execDir,
  };
}

/** execution.json next to the inbox, or null when the controller hasn't written one. */
export function readExecutionFile(env: CollieEnv): ExecutionFile | null {
  const path = join(env.execDir, "execution.json");
  if (!existsSync(path)) return null;
  const r = validateExecution(JSON.parse(readFileSync(path, "utf8")));
  return r.ok ? r.value : null;
}
