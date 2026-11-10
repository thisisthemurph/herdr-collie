// The controller's view of `hc` (herdr-core): start, observe, talk to and kill agent terminals.
// The program runner is one injected function, so tests use tools/fake-hc.
// Rules from docs/protocol.md ("Launching an agent", "Talking to an agent"):
//   - agents start with --no-parent --no-notify, so they outlive a controller restart;
//   - `hc send` runs without HC_TERMINAL_ID (or the agent gets the text wrapped in <hc from=…>),
//     never with --if idle (it refuses `done`) or --force (it would answer a permission dialog);
//   - exit codes 9 (blocked) and 10 (status mismatch) mean nothing was typed.

export type HcResult = { code: number; stdout: string; stderr: string };
export type HcRunner = (argv: string[], env: Record<string, string>) => Promise<HcResult>;

/** hc as a real program (`hc` from PATH, or `bin`). */
export function spawnHc(bin = "hc"): HcRunner {
  return async (argv, env) => {
    const p = Bun.spawn([bin, ...argv], { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { code, stdout, stderr };
  };
}

export type HcStatus = {
  state: "idle" | "working" | "done" | "blocked" | "error";
  kind?: string;
  msg?: string;
};

export type HcTerminal = {
  address: string;
  state: "live" | "finished";
  status: HcStatus | null;
  turn: number;
  labels: Record<string, string>;
  exit_code: number | null;
  reason: string | null;
};

export class HcError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export type SendOutcome = "sent" | "blocked" | "status_mismatch" | "finished" | "not_found";

export class Hc {
  constructor(
    private readonly runner: HcRunner,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  private async call(argv: string[], dropTerminalId = false): Promise<HcResult> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.env)) {
      if (v !== undefined && !(dropTerminalId && k === "HC_TERMINAL_ID")) env[k] = v;
    }
    try {
      return await this.runner(argv, env);
    } catch (e) {
      throw new HcError("unavailable", `couldn't run hc: ${(e as Error).message}`, 127);
    }
  }

  private static fail(r: HcResult): HcError {
    try {
      const e = (JSON.parse(r.stderr) as { error?: { kind?: string; message?: string } }).error;
      if (e) return new HcError(e.kind ?? "error", e.message ?? `hc exited ${r.code}`, r.code);
    } catch {}
    return new HcError("error", r.stderr.trim() || `hc exited ${r.code}`, r.code);
  }

  /** Starts an agent in the background. Returns its terminal address. */
  async run(o: {
    name: string;
    cwd: string;
    labels: Record<string, string>;
    argv: string[];
    env: Record<string, string>;
  }): Promise<string> {
    const args = ["run", "--bg", "--json", "--no-parent", "--no-notify", "--name", o.name, "--cwd", o.cwd];
    for (const [k, v] of Object.entries(o.labels)) args.push("--label", `${k}=${v}`);
    // hc run has no option for environment variables, so they go through an `env` argv wrapper.
    args.push("--", "env", ...Object.entries(o.env).map(([k, v]) => `${k}=${v}`), ...o.argv);
    const r = await this.call(args);
    if (r.code !== 0) throw Hc.fail(r);
    const address = (JSON.parse(r.stdout) as { address?: string }).address;
    if (!address) throw new HcError("error", "hc run printed no terminal address", 0);
    return address;
  }

  /** One terminal's state, or null when it doesn't exist (any more). */
  async get(terminal: string): Promise<HcTerminal | null> {
    const r = await this.call(["get", terminal, "--json"]);
    if (r.code === 3) return null;
    if (r.code !== 0) throw Hc.fail(r);
    return JSON.parse(r.stdout) as HcTerminal;
  }

  /** Blocks until the agent's turn ends, it exits, or `seconds` pass. Errors are the caller's to ignore. */
  async wait(terminal: string, seconds: number): Promise<void> {
    const r = await this.call(["wait", terminal, "--timeout", String(seconds), "--json"]);
    if (r.code !== 0 && r.code !== 3) throw Hc.fail(r);
  }

  /** Types `text` into an agent. Nothing is typed unless the outcome is "sent". */
  async send(terminal: string, text: string): Promise<SendOutcome> {
    const r = await this.call(["send", terminal, text], true);
    if (r.code === 0) return "sent";
    if (r.code === 9) return "blocked";
    if (r.code === 10) return "status_mismatch";
    if (r.code === 11) return "finished";
    if (r.code === 3) return "not_found";
    throw Hc.fail(r);
  }

  /** The text on a terminal's visible screen. */
  async screen(terminal: string): Promise<string> {
    const r = await this.call(["read", terminal, "--lines", "0"]);
    if (r.code !== 0) throw Hc.fail(r);
    return r.stdout;
  }

  /** Ends a terminal. A terminal that is already gone is fine. */
  async kill(terminal: string): Promise<void> {
    const r = await this.call(["kill", terminal, "--json"]);
    if (r.code !== 0 && r.code !== 3) throw Hc.fail(r);
  }

  /** Addresses of the live terminals carrying every given label. */
  async list(labels: Record<string, string>): Promise<string[]> {
    const args = ["ls", "--json"];
    for (const [k, v] of Object.entries(labels)) args.push("--label", `${k}=${v}`);
    const r = await this.call(args);
    if (r.code !== 0) throw Hc.fail(r);
    return (
      (JSON.parse(r.stdout) as { terminals?: { address: string }[] }).terminals?.map((t) => t.address) ?? []
    );
  }
}
