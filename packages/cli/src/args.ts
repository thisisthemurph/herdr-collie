// A small option parser. Options may come anywhere; `--name=value` and `--name value` both
// work; everything after `--` is positional. Errors say exactly which option is wrong.
import { invalid } from "./errors.ts";

export type OptionSpec = {
  /** Options that take no value, e.g. --json. */
  flags?: string[];
  /** Options that take one value. */
  values?: string[];
  /** Options that may repeat, each with a value. */
  multi?: string[];
  /** Number of positional arguments allowed: [min, max]. */
  positionals?: [number, number];
  /** Names of the positionals, for messages. */
  positionalNames?: string[];
};

export type Parsed = {
  flags: Set<string>;
  values: Map<string, string>;
  multi: Map<string, string[]>;
  positionals: string[];
};

export function parseArgs(command: string, args: string[], spec: OptionSpec): Parsed {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const positionals: string[] = [];
  const help = `Run \`collie ${command} --help\` for every option.`;
  const known = [...(spec.flags ?? []), ...(spec.values ?? []), ...(spec.multi ?? [])];

  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("--") || a === "-") {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    if (spec.flags?.includes(name)) {
      if (inline !== undefined) throw invalid(`--${name} takes no value; give just --${name}. ${help}`);
      flags.add(name);
      continue;
    }
    if (spec.values?.includes(name) || spec.multi?.includes(name)) {
      const v = inline ?? args[++i];
      if (v === undefined) throw invalid(`--${name} needs a value, e.g. --${name} "...". ${help}`);
      if (spec.multi?.includes(name)) multi.set(name, [...(multi.get(name) ?? []), v]);
      else if (values.has(name)) throw invalid(`--${name} was given twice; give it once. ${help}`);
      else values.set(name, v);
      continue;
    }
    const options = known.length ? ` Options: ${known.map((k) => `--${k}`).join(", ")}.` : "";
    throw invalid(`unknown option --${name}.${options} ${help}`);
  }

  const [min, max] = spec.positionals ?? [0, 0];
  const names = spec.positionalNames ?? [];
  if (positionals.length < min) {
    throw invalid(`missing ${names[positionals.length] ?? "argument"}. ${help}`);
  }
  if (positionals.length > max) {
    const extra = positionals[max] as string;
    const hint =
      max === 0
        ? ""
        : ` Quote the ${names[max - 1] ?? "argument"} if it has spaces: collie ${command} "${positionals.slice(max - 1).join(" ")}".`;
    throw invalid(`unexpected argument ${JSON.stringify(extra)}.${hint} ${help}`);
  }
  return { flags, values, multi, positionals };
}
