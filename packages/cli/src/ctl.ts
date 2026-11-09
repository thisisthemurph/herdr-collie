// `collie ctl`: how the mod (and a person) steers the controller. Writes
// control/pending/<id>.json atomically, then waits for control/done/<id>.json
// (docs/protocol.md, "Control commands").
//
//   collie ctl <command> ['<args as JSON>'] [--args-file <path|->] [--json]
//   collie ctl run.start '{"board_id":"01JC8XW0..."}'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_NAMES,
  type Command,
  formatIssues,
  newUlid,
  validateCommand,
  validateCommandReply,
  validateLock,
} from "@collie/schema";
import { parseArgs } from "./args.ts";
import { CliError, EXIT, invalid } from "./errors.ts";
import type { Output } from "./report.ts";

export const CTL_TIMEOUT_MS = 10_000;

export const CTL_HELP = `collie ctl <command> ['<args JSON>'] [--args-file <path|->] [--json]

  Sends a command to the controller and prints its reply.
  e.g. collie ctl run.start '{"board_id":"01JC8XW0..."}'

  Commands: ${COMMAND_NAMES.join(", ")}.
  Arguments: see docs/protocol.md, "Control commands".
  Exit codes: 0 applied · 2 refused (the message says why) · 6 the controller
  isn't running or didn't reply within 10 seconds.`;

function collieHome(env: Record<string, string | undefined>): string {
  const h = env.COLLIE_HOME;
  if (!h) return join(homedir(), ".collie");
  return h === "~" || h.startsWith("~/") ? join(homedir(), h.slice(1)) : h;
}

/** Whether a live controller holds controller.lock (its pid exists). */
function controllerAlive(home: string): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(home, "controller.lock"), "utf8"));
  } catch {
    return false;
  }
  const r = validateLock(raw);
  if (!r.ok) return false;
  try {
    process.kill(r.value.pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const notRunning = (detail: string) =>
  new CliError(
    EXIT.ctl,
    `${detail}. Start it with collie-controller, or open the Collie mod, which starts it.`,
  );

export function ctl(args: string[], env: Record<string, string | undefined>): Output {
  const p = parseArgs("ctl", args, {
    flags: ["json"],
    values: ["args-file"],
    positionals: [1, 2],
    positionalNames: ["<command>", "<args JSON>"],
  });
  const [command, inline] = p.positionals as [string, string | undefined];
  if (!(COMMAND_NAMES as string[]).includes(command)) {
    throw invalid(`unknown command ${JSON.stringify(command)}. Commands: ${COMMAND_NAMES.join(", ")}.`);
  }
  const file = p.values.get("args-file");
  if (inline !== undefined && file !== undefined)
    throw invalid("give the arguments inline or with --args-file, not both.");
  let argsText = inline ?? "{}";
  if (file !== undefined) {
    try {
      argsText = readFileSync(file === "-" ? 0 : file, "utf8");
    } catch (e) {
      throw invalid(`cannot read --args-file ${file}: ${(e as Error).message}`);
    }
  }
  let cmdArgs: unknown;
  try {
    cmdArgs = JSON.parse(argsText);
  } catch (e) {
    throw invalid(`the arguments must be a JSON object: ${(e as Error).message}`);
  }
  const now = Date.now();
  const cmd = { v: 1, id: newUlid(now), command, at: new Date(now).toISOString(), args: cmdArgs };
  const checked = validateCommand(cmd);
  if (!checked.ok)
    throw invalid(`${formatIssues(checked.issues)}. See docs/protocol.md, "Control commands".`);

  const home = collieHome(env);
  if (!controllerAlive(home))
    throw notRunning(`the controller isn't running (no live controller.lock in ${home})`);
  const reply = send(home, checked.value, Number(env.COLLIE_CTL_TIMEOUT_MS) || CTL_TIMEOUT_MS);
  // DECISION: a refused command exits 2 (the protocol defines no other code for it), with the
  // controller's error code and message.
  if (!reply.ok) {
    throw new CliError(EXIT.invalid, `${reply.error.code}: ${reply.error.message}`, JSON.stringify(reply));
  }
  const text = Object.keys(reply.result).length
    ? `Applied ${command}: ${JSON.stringify(reply.result)}`
    : `Applied ${command}.`;
  return { text, json: reply };
}

function send(home: string, cmd: Command, timeoutMs: number) {
  const pending = join(home, "control", "pending");
  const done = join(home, "control", "done", `${cmd.id}.json`);
  try {
    mkdirSync(pending, { recursive: true });
    // Atomic: the controller only reads *.json, so it never sees a half-written command.
    const tmp = join(pending, `${cmd.id}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(cmd)}\n`);
    renameSync(tmp, join(pending, `${cmd.id}.json`));
  } catch (e) {
    throw new CliError(EXIT.io, `could not write the command to ${pending}: ${(e as Error).message}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(done)) {
      try {
        const r = validateCommandReply(JSON.parse(readFileSync(done, "utf8")));
        if (r.ok) return r.value;
        throw new CliError(EXIT.io, `the controller's reply is malformed: ${formatIssues(r.issues)}`);
      } catch (e) {
        if (e instanceof CliError) throw e;
        // A reply is written atomically; a read error is a race with the rename. Retry.
      }
    }
    Bun.sleepSync(25);
  }
  // DECISION: the command is left in pending/: a slow controller may still apply it.
  throw notRunning(
    `the controller didn't reply within ${Math.round(timeoutMs / 1000)} seconds; it may still apply command ${cmd.id}`,
  );
}
