// The fake hc's behaviour, as a pure function of (state, scenario, argv, env, clock).
// Output shapes, error kinds and exit codes copy real hc 0.1.17 (fixtures/hc/).
import type { AgentScript, Scenario, StatusState, Step, Trigger } from "./scenario.ts";

export type Status = { app: string; state: StatusState; kind?: string; msg?: string };

export type Terminal = {
  address: string;
  name: string | null;
  argv: string[];
  cwd: string;
  labels: Record<string, string>;
  parent: string | null;
  die_with_parent: boolean;
  notify: boolean;
  created_ms: number;
  state: "live" | "finished";
  status: Status | null;
  status_ms: number | null;
  turn: number;
  exit_code: number | null;
  signal: number | null;
  reason: "exited" | "killed" | null;
  finished_ms: number | null;
  pid: number | null;
  /** Index into the scenario's agents, or null for a plain program. */
  agent: number | null;
  cursor: number;
  /** Every text delivered by `hc send`, as the program received it. */
  received: string[];
};

export type State = { next: number; used: number[]; terminals: Terminal[] };
export const emptyState = (): State => ({ next: 1, used: [], terminals: [] });

/** Side effects the caller performs after the state is saved. */
export type Effect =
  | { kind: "spawn"; address: string; argv: string[]; cwd: string; env: Record<string, string> }
  | { kind: "kill"; address: string; pid: number }
  | { kind: "deliver"; address: string; text: string };

export type Outcome = { code: number; stdout?: unknown; stderr?: unknown; effects: Effect[] };

type Ctx = {
  state: State;
  scenario: Scenario;
  env: Record<string, string | undefined>;
  now: number;
  effects: Effect[];
};

class HcError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly hint: string,
    readonly code: number,
  ) {
    super(message);
  }
}

const usage = (message: string) => new HcError("usage", message, "see `hc --help`", 2);
const notFound = (t: string) =>
  new HcError("not_found", `no terminal ${JSON.stringify(t)}`, "see `hc ls --all`", 3);
const unsupported = (what: string) =>
  new HcError(
    "unsupported",
    `fake-hc does not support ${what}`,
    "extend tools/fake-hc if a test needs it",
    2,
  );

// --- argument parsing

type Parsed = { flags: Record<string, string | true>; multi: Record<string, string[]>; rest: string[] };

/**
 * Options may come anywhere, as with real hc, except for `run`, whose program argv starts at
 * the first positional (`stopAtPositional`). Everything after `--` is positional.
 */
function parse(
  args: string[],
  spec: { bool: string[]; value: string[]; multi?: string[]; stopAtPositional?: boolean },
): Parsed {
  const out: Parsed = { flags: {}, multi: {}, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      out.rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && !(spec.stopAtPositional && out.rest.length > 0)) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (spec.bool.includes(name)) out.flags[name] = true;
      else if (spec.value.includes(name) || spec.multi?.includes(name)) {
        const v = inline ?? args[++i];
        if (v === undefined) throw usage(`--${name} needs a value`);
        if (spec.multi?.includes(name)) out.multi[name] = [...(out.multi[name] ?? []), v];
        else out.flags[name] = v;
      } else throw usage(`unknown option --${name}`);
      continue;
    }
    out.rest.push(a);
  }
  return out;
}

function labelPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) throw usage(`label must be key=value, got ${JSON.stringify(p)}`);
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

// --- terminal helpers

function find(ctx: Ctx, target: string | undefined): Terminal {
  if (!target) throw new HcError("needs_target", "which terminal?", "give a terminal: t7 or a name", 7);
  const byAddr = ctx.state.terminals.find((t) => t.address === target);
  if (byAddr) return byAddr;
  // Names are unique among live terminals; a finished one keeps its name until removed.
  const byName = ctx.state.terminals.filter((t) => t.name === target);
  const t = byName.find((x) => x.state === "live") ?? byName.at(-1);
  if (!t) throw notFound(target);
  return t;
}

function script(ctx: Ctx, t: Terminal): AgentScript | undefined {
  return t.agent === null ? undefined : ctx.scenario.agents[t.agent];
}

function applyStep(ctx: Ctx, t: Terminal, step: Step) {
  if (step.state !== undefined) {
    const prev = t.status?.state ?? null;
    t.status =
      step.state === null
        ? null
        : {
            app: script(ctx, t)?.app ?? "claude-code",
            state: step.state,
            ...(step.kind ? { kind: step.kind } : {}),
            ...(step.msg ? { msg: step.msg } : {}),
          };
    if (prev !== step.state) t.status_ms = ctx.now;
  }
  if (step.turn !== undefined) t.turn = step.turn === "+1" ? t.turn + 1 : step.turn;
  if (step.exit !== undefined) finish(ctx, t, "exited", step.exit, null);
}

/**
 * Applies the step at the cursor if `on` triggers it: one step per call, so a test can script
 * exactly what each successive `hc get` or `hc wait` sees. `hc run` applies every leading
 * "run" step, to set up the starting state.
 */
function advance(ctx: Ctx, t: Terminal, on: Trigger) {
  const steps = script(ctx, t)?.steps ?? [];
  do {
    const step = steps[t.cursor];
    if (t.state !== "live" || !step || (step.on !== on && !(step.on === "any" && on !== "ls"))) return;
    t.cursor += 1;
    applyStep(ctx, t, step);
  } while (on === "run");
}

function finish(
  ctx: Ctx,
  t: Terminal,
  reason: "exited" | "killed",
  exit: number | null,
  signal: number | null,
) {
  if (t.state === "finished") return;
  t.state = "finished";
  t.reason = reason;
  t.exit_code = exit;
  t.signal = signal;
  t.finished_ms = ctx.now;
}

function getView(t: Terminal) {
  return {
    address: t.address,
    argv: t.argv,
    cols: 200,
    created_ms: t.created_ms,
    cwd: t.cwd,
    die_with_parent: t.die_with_parent,
    exit_code: t.exit_code,
    finished_ms: t.finished_ms,
    identity: "fake-hc",
    keep: false,
    labels: t.labels,
    name: t.name,
    notify: t.notify,
    parent: t.parent,
    pid: t.pid,
    reason: t.reason,
    reported: t.status !== null,
    rm: false,
    rows: 120,
    screen: "exact",
    signal: t.signal,
    state: t.state,
    status: t.status,
    status_ms: t.status_ms,
    template: null,
    title: "",
    turn: t.turn,
  };
}

function lsView(t: Terminal) {
  return {
    address: t.address,
    agent: basename(t.argv[0] ?? ""),
    cwd: t.cwd,
    name: t.name,
    state: t.state,
    turn: t.turn,
  };
}

function waitView(t: Terminal) {
  const finished = t.state === "finished";
  const settled = !finished && t.status !== null && t.status.state !== "working";
  return {
    children: [],
    ended: finished || settled,
    exit_code: t.exit_code,
    reason: finished ? "exit" : settled ? "status" : "timeout",
    signal: t.signal,
    status: t.status?.state ?? null,
    terminal: t.address,
    turn: t.turn,
  };
}

const basename = (p: string) => p.split("/").at(-1) ?? p;

function matches(a: AgentScript, name: string | null, labels: Record<string, string>): boolean {
  const m = a.match ?? {};
  if (m.name !== undefined && m.name !== name) return false;
  return Object.entries(m.labels ?? {}).every(([k, v]) => labels[k] === v);
}

// --- commands

function run(ctx: Ctx, args: string[]): Outcome {
  const p = parse(args, {
    bool: ["json", "bg", "no-parent", "no-notify", "outlive-parent", "rm", "keep"],
    value: ["name", "cwd", "parent", "timeout", "on"],
    multi: ["label"],
    stopAtPositional: true,
  });
  if (p.flags.on) throw unsupported("--on (other machines)");
  // DECISION: only --bg. Collie always starts agents in the background, and a foreground run
  // would need the fake to block until the scripted program exits.
  if (!p.flags.bg) throw unsupported("hc run without --bg");
  if (p.rest.length === 0) throw unsupported("hc run without a program (a login shell)");
  const name = (p.flags.name as string | undefined) ?? null;
  if (name !== null && !/^[a-z0-9_-]{1,32}$/.test(name)) {
    throw usage(`--name must be 1-32 of a-z 0-9 - _, got ${JSON.stringify(name)}`);
  }
  if (name !== null && ctx.state.terminals.some((t) => t.state === "live" && t.name === name)) {
    throw new HcError(
      "name_taken",
      `a live terminal is already named ${JSON.stringify(name)}`,
      "pick another name, or kill the one holding it",
      1,
    );
  }
  const labels = labelPairs(p.multi.label ?? []);
  const agentIndex = ctx.scenario.agents.findIndex(
    (a, i) => !ctx.state.used.includes(i) && matches(a, name, labels),
  );
  const agent = agentIndex >= 0 ? ctx.scenario.agents[agentIndex] : undefined;
  if (agentIndex >= 0) ctx.state.used.push(agentIndex);
  if (agent?.run_error) {
    const e = agent.run_error;
    throw new HcError(e.kind, e.message, e.hint ?? "", 1);
  }
  const caller = ctx.env.HC_TERMINAL_ID ?? null;
  const parent = p.flags["no-parent"] ? null : ((p.flags.parent as string | undefined) ?? caller);
  const t: Terminal = {
    address: `t${ctx.state.next++}`,
    name,
    argv: p.rest,
    cwd: (p.flags.cwd as string | undefined) ?? ctx.env.PWD ?? "/",
    labels,
    parent,
    die_with_parent: parent !== null && !p.flags["outlive-parent"],
    notify: parent !== null && !p.flags["no-notify"],
    created_ms: ctx.now,
    state: "live",
    status: null,
    status_ms: null,
    turn: 0,
    exit_code: null,
    signal: null,
    reason: null,
    finished_ms: null,
    pid: null,
    agent: agentIndex >= 0 ? agentIndex : null,
    cursor: 0,
    received: [],
  };
  ctx.state.terminals.push(t);
  advance(ctx, t, "run");
  if (agent?.spawn) {
    ctx.effects.push({
      kind: "spawn",
      address: t.address,
      argv: t.argv,
      cwd: t.cwd,
      env: { HC_TERMINAL_ID: t.address },
    });
  }
  return { code: 0, stdout: lsView(t), effects: [] };
}

function send(ctx: Ctx, args: string[]): Outcome {
  const p = parse(args, { bool: ["json", "force", "wait"], value: ["if", "timeout"] });
  if (p.flags.wait) throw unsupported("send --wait");
  const [target, text, ...extra] = p.rest;
  if (text === undefined || extra.length) throw usage("hc send <terminal> <text>");
  const t = find(ctx, target);
  if (t.state === "finished")
    throw new HcError("finished", `${t.address} has finished`, `hc read ${t.address}`, 11);
  const st = t.status?.state ?? null;
  if (st === "blocked" && !p.flags.force) {
    throw new HcError(
      "blocked",
      `${t.address} is blocked (${t.status?.kind ?? "permission"})`,
      `typing would answer its dialog; read its screen first (hc read ${t.address}), or --force`,
      9,
    );
  }
  const want = p.flags.if as string | undefined;
  if (want !== undefined && want !== "idle" && want !== "working")
    throw usage("--if must be idle or working");
  if (want !== undefined && st !== want) {
    throw new HcError(
      "status_mismatch",
      `${t.address} is ${st ?? "silent"}, not ${want}`,
      "nothing was typed",
      10,
    );
  }
  // Real hc wraps text sent from inside an hc terminal (docs/spike.md, experiment 1).
  const from = ctx.env.HC_TERMINAL_ID;
  const delivered = from ? `<hc from="${from}">${text}</hc>` : text;
  t.received.push(delivered);
  ctx.effects.push({ kind: "deliver", address: t.address, text: delivered });
  const out = { started: t.status ? true : null, status: st, turn: t.turn };
  advance(ctx, t, "send");
  return { code: 0, stdout: out, effects: [] };
}

function wait(ctx: Ctx, args: string[]): Outcome {
  const p = parse(args, { bool: ["json"], value: ["timeout", "output", "children"] });
  if (p.flags.children) throw unsupported("wait --children");
  if (p.flags.output) throw unsupported("wait --output");
  const t = find(ctx, p.rest[0]);
  advance(ctx, t, "wait");
  return { code: 0, stdout: waitView(t), effects: [] };
}

function get(ctx: Ctx, args: string[]): Outcome {
  const p = parse(args, { bool: ["json"], value: [] });
  const t = find(ctx, p.rest[0]);
  advance(ctx, t, "get");
  return { code: 0, stdout: getView(t), effects: [] };
}

function ls(ctx: Ctx, args: string[]): Outcome {
  const p = parse(args, { bool: ["json", "all"], value: [], multi: ["label"] });
  const want = labelPairs(p.multi.label ?? []);
  for (const t of ctx.state.terminals) if (t.state === "live") advance(ctx, t, "ls");
  const labelled = ctx.state.terminals.filter((t) =>
    Object.entries(want).every(([k, v]) => t.labels[k] === v),
  );
  const shown = labelled.filter((t) => p.flags.all || t.state === "live");
  return {
    code: 0,
    stdout: { hidden_finished: labelled.length - shown.length, terminals: shown.map(lsView) },
    effects: [],
  };
}

function label(ctx: Ctx, args: string[]): Outcome {
  const p = parse(args, { bool: ["json"], value: [] });
  const [target, ...pairs] = p.rest;
  if (!pairs.length) throw usage("hc label <terminal> <k=v>...");
  const t = find(ctx, target);
  for (const [k, v] of Object.entries(labelPairs(pairs))) {
    if (v === "") delete t.labels[k];
    else t.labels[k] = v;
  }
  advance(ctx, t, "label");
  return { code: 0, stdout: getView(t), effects: [] };
}

function kill(ctx: Ctx, args: string[]): Outcome {
  const p = parse(args, { bool: ["json"], value: [] });
  const t = find(ctx, p.rest[0]);
  if (t.state === "live" && t.pid !== null)
    ctx.effects.push({ kind: "kill", address: t.address, pid: t.pid });
  finish(ctx, t, "killed", null, 1);
  return { code: 0, stdout: getView(t), effects: [] };
}

function rm(ctx: Ctx, args: string[]): Outcome {
  const p = parse(args, { bool: ["json"], value: [] });
  const t = find(ctx, p.rest[0]);
  if (t.state === "live")
    throw new HcError("live", `${t.address} is still running`, `kill it first: hc kill ${t.address}`, 1);
  ctx.state.terminals = ctx.state.terminals.filter((x) => x !== t);
  return { code: 0, stdout: { removed: t.address }, effects: [] };
}

const COMMANDS: Record<string, (ctx: Ctx, args: string[]) => Outcome> = {
  run,
  send,
  wait,
  get,
  ls,
  label,
  kill,
  rm,
};
export const SUPPORTED = Object.keys(COMMANDS);

/** Runs one hc invocation against `state` (mutated in place). */
export function execute(
  state: State,
  scenario: Scenario,
  argv: string[],
  env: Record<string, string | undefined>,
  now: number,
): Outcome {
  const ctx: Ctx = { state, scenario, env, now, effects: [] };
  const [cmd, ...args] = argv;
  try {
    const fn = cmd ? COMMANDS[cmd] : undefined;
    if (!fn) throw unsupported(`hc ${cmd ?? "(no command)"}; supported: ${SUPPORTED.join(", ")}`);
    const out = fn(ctx, args);
    return { ...out, effects: ctx.effects };
  } catch (e) {
    if (e instanceof HcError) {
      return {
        code: e.code,
        stderr: { error: { hint: e.hint, kind: e.kind, message: e.message } },
        effects: [],
      };
    }
    throw e;
  }
}

/** Marks a spawned program finished once it has exited (called before each command). */
export function reapExited(state: State, exited: Map<string, number>, now: number) {
  for (const t of state.terminals) {
    const code = exited.get(t.address);
    if (t.state === "live" && code !== undefined) {
      t.state = "finished";
      t.reason = "exited";
      t.exit_code = code;
      t.finished_ms = now;
    }
  }
}
