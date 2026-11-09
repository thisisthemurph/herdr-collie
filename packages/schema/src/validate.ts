// A small validator toolkit: each schema checks a value and reports every problem with the
// path of the field that caused it, e.g. `payload.severity: must be one of critical, high, ...`.
//
// DECISION: hand-written instead of a library such as zod, so packages/schema has no runtime
// dependencies and can be bundled into the Herdr mod, which runs plain JS.

export type Issue = { path: string; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export interface Schema<T> {
  readonly optional?: boolean;
  check(value: unknown, path: string, issues: Issue[]): void;
  /** Phantom field that carries the static type; never set at runtime. */
  readonly _type?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type AnySchema = Schema<unknown>;
type Shape = Record<string, AnySchema>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends { optional: true } ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type Flatten<T> = { [K in keyof T]: T[K] } & {};
export type InferShape<S extends Shape> = Flatten<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

export function join(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

function label(path: string): string {
  return path || "(value)";
}

export function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function make<T>(check: Schema<T>["check"]): Schema<T> {
  return { check };
}

export function runSchema<T>(schema: Schema<T>, value: unknown, path = ""): Result<T> {
  const issues: Issue[] = [];
  schema.check(value, path, issues);
  return issues.length ? { ok: false, issues } : { ok: true, value: value as T };
}

export function formatIssues(issues: Issue[]): string {
  return issues.map((i) => `${label(i.path)}: ${i.message}`).join("; ");
}

// --- primitives

export function str(
  opts: { min?: number; max?: number; pattern?: RegExp; what?: string } = {},
): Schema<string> {
  return make((v, path, issues) => {
    if (typeof v !== "string") {
      issues.push({ path, message: `must be a string, got ${typeName(v)}` });
      return;
    }
    const min = opts.min ?? 0;
    if (v.length < min) {
      issues.push({ path, message: min === 1 ? "must not be empty" : `must be at least ${min} characters` });
    } else if (opts.max !== undefined && v.length > opts.max) {
      issues.push({ path, message: `must be at most ${opts.max} characters, got ${v.length}` });
    } else if (opts.pattern && !opts.pattern.test(v)) {
      issues.push({
        path,
        message: `must be ${opts.what ?? `a string matching ${opts.pattern}`}, got ${JSON.stringify(v)}`,
      });
    }
  });
}

export function int(opts: { min?: number; max?: number } = {}): Schema<number> {
  return make((v, path, issues) => {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      issues.push({ path, message: `must be an integer, got ${typeName(v)}` });
    } else if (opts.min !== undefined && v < opts.min) {
      issues.push({ path, message: `must be at least ${opts.min}, got ${v}` });
    } else if (opts.max !== undefined && v > opts.max) {
      issues.push({ path, message: `must be at most ${opts.max}, got ${v}` });
    }
  });
}

export const bool: Schema<boolean> = make((v, path, issues) => {
  if (typeof v !== "boolean") issues.push({ path, message: `must be true or false, got ${typeName(v)}` });
});

/** Any JSON object; its contents aren't checked. */
export const anyObject: Schema<Record<string, unknown>> = make((v, path, issues) => {
  if (typeName(v) !== "object") issues.push({ path, message: `must be an object, got ${typeName(v)}` });
});

export function lit<const T extends string | number | boolean>(value: T): Schema<T> {
  return make((v, path, issues) => {
    if (v !== value)
      issues.push({ path, message: `must be ${JSON.stringify(value)}, got ${JSON.stringify(v)}` });
  });
}

export function oneOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  return make((v, path, issues) => {
    if (typeof v !== "string" || !values.includes(v)) {
      issues.push({ path, message: `must be one of ${values.join(", ")}, got ${JSON.stringify(v)}` });
    }
  });
}

// --- combinators

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return make((v, path, issues) => {
    if (v !== null) inner.check(v, path, issues);
  });
}

/** Marks an object field as optional: it may be missing; if present it must match. */
export function opt<T>(inner: Schema<T>): Schema<T> & { optional: true } {
  return { optional: true, check: (v, path, issues) => inner.check(v, path, issues) };
}

export function arr<T>(item: Schema<T>, opts: { min?: number; max?: number } = {}): Schema<T[]> {
  return make((v, path, issues) => {
    if (!Array.isArray(v)) {
      issues.push({ path, message: `must be an array, got ${typeName(v)}` });
      return;
    }
    if (opts.min !== undefined && v.length < opts.min) {
      issues.push({
        path,
        message: opts.min === 1 ? "must not be empty" : `must have at least ${opts.min} items`,
      });
    }
    if (opts.max !== undefined && v.length > opts.max) {
      issues.push({ path, message: `must have at most ${opts.max} items` });
    }
    v.forEach((item_, i) => {
      item.check(item_, join(path, i), issues);
    });
  });
}

/** An object with known fields. Unknown fields are ignored: readers must tolerate additions. */
export function obj<S extends Shape>(
  shape: S,
  refine?: (v: InferShape<S>, path: string, issues: Issue[]) => void,
): Schema<InferShape<S>> & { shape: S } {
  return {
    shape,
    check(v, path, issues) {
      if (typeName(v) !== "object") {
        issues.push({ path, message: `must be an object, got ${typeName(v)}` });
        return;
      }
      const o = v as Record<string, unknown>;
      const before = issues.length;
      for (const [key, schema] of Object.entries(shape)) {
        const p = join(path, key);
        if (!(key in o) || o[key] === undefined) {
          if (!schema.optional) issues.push({ path: p, message: "is required" });
          continue;
        }
        schema.check(o[key], p, issues);
      }
      if (refine && issues.length === before) refine(o as InferShape<S>, path, issues);
    },
  };
}

/** Like obj, but every field may be left out. */
export function partial<S extends Shape>(shape: S): Schema<Partial<InferShape<S>>> {
  const loose: Shape = {};
  for (const [k, s] of Object.entries(shape)) loose[k] = opt(s);
  return obj(loose) as Schema<Partial<InferShape<S>>>;
}

/** A map from keys matching `key` to values matching `value`. */
export function record<V>(key: Schema<string>, value: Schema<V>): Schema<Record<string, V>> {
  return make((v, path, issues) => {
    if (typeName(v) !== "object") {
      issues.push({ path, message: `must be an object, got ${typeName(v)}` });
      return;
    }
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      const p = join(path, k);
      const keyIssues: Issue[] = [];
      key.check(k, p, keyIssues);
      for (const i of keyIssues) issues.push({ path: p, message: `key ${i.message}` });
      value.check(item, p, issues);
    }
  });
}

/** Picks a schema by the string value of `field`, e.g. an event's `type`. */
export function tagged<T>(field: string, cases: Record<string, Schema<unknown>>, what: string): Schema<T> {
  const names = Object.keys(cases);
  return make((v, path, issues) => {
    if (typeName(v) !== "object") {
      issues.push({ path, message: `must be an object, got ${typeName(v)}` });
      return;
    }
    const tag = (v as Record<string, unknown>)[field];
    const schema = typeof tag === "string" && Object.hasOwn(cases, tag) ? cases[tag] : undefined;
    if (!schema) {
      const known = names.length <= 12 ? `: ${names.join(", ")}` : " (see docs/protocol.md)";
      issues.push({
        path: join(path, field),
        message: `must be a known ${what}${known}; got ${JSON.stringify(tag)}`,
      });
      return;
    }
    schema.check(v, path, issues);
  });
}
