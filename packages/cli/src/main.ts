// collie: the command agents use to report to Collie (docs/protocol.md, "CLI design").
// `collie ctl` arrives in Phase 2.
import { readFileSync } from "node:fs";
import { readEnv } from "./env.ts";
import { CliError, EXIT } from "./errors.ts";
import { COMMAND_HELP, MAIN_HELP } from "./help.ts";
import { endedBy, parseInbox } from "./inbox.ts";
import { type Output, REPORT_COMMANDS } from "./report.ts";
import { show } from "./show.ts";

export function run(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): { code: number; stdout: string; stderr: string } {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    return { code: EXIT.ok, stdout: `${MAIN_HELP}\n`, stderr: "" };
  }
  if (args.includes("--help") || args.includes("-h")) {
    const help = COMMAND_HELP[command];
    if (help) return { code: EXIT.ok, stdout: `${help}\n`, stderr: "" };
  }
  const json = args.includes("--json");
  try {
    let out: Output;
    if (command === "show") {
      out = show(readEnv(env), args);
    } else if (command in REPORT_COMMANDS) {
      const ctx = readEnv(env);
      refuseIfEnded(ctx.inbox, ctx.executionId);
      out = REPORT_COMMANDS[command as keyof typeof REPORT_COMMANDS](ctx, args).out;
    } else if (command === "ctl") {
      throw new CliError(EXIT.invalid, "collie ctl is not available yet (Phase 2).");
    } else {
      throw new CliError(
        EXIT.invalid,
        `unknown command ${JSON.stringify(command)}. Run \`collie --help\` for the list.`,
      );
    }
    return { code: EXIT.ok, stdout: `${json ? JSON.stringify(out.json) : out.text}\n`, stderr: "" };
  } catch (e) {
    if (e instanceof CliError)
      return { code: e.code, stdout: "", stderr: `collie ${command}: ${e.message}\n` };
    if (e instanceof Error && "code" in e && typeof (e as { code: unknown }).code === "string") {
      return {
        code: EXIT.io,
        stdout: "",
        stderr: `collie ${command}: ${e.message}. Run the same command again.\n`,
      };
    }
    throw e;
  }
}

/** A cheap first check, before git and argument checks; the write re-checks under the lock. */
function refuseIfEnded(inbox: string, executionId: string) {
  let text = "";
  try {
    text = readFileSync(inbox, "utf8");
  } catch {
    return;
  }
  const ended = endedBy(parseInbox(text), executionId);
  if (ended) {
    throw new CliError(
      EXIT.ended,
      `this execution already ended with \`collie ${ended.type}\` (event ${ended.id}). Nothing more can be recorded; end your turn.`,
    );
  }
}

if (import.meta.main) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.code);
}
