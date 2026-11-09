// fake-agent scenario steps. See main.ts for the file format.

export type Step =
  | { collie: string[]; stdin?: string; expect_exit?: number; expect_output?: string }
  | { shell: string; stdin?: string; expect_exit?: number; expect_output?: string }
  | { await_message: { contains?: string; timeout_ms?: number } }
  | { sleep_ms: number }
  | { exit: number };

const KINDS = ["collie", "shell", "await_message", "sleep_ms", "exit"] as const;

/** Returns the problems in a parsed scenario, each naming the field. */
export function checkScenario(s: unknown): string[] {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(s)) return ["scenario: must be an object"];
  const problems: string[] = [];
  if (s.v !== 1) problems.push(`v: must be 1, got ${JSON.stringify(s.v)}`);
  if (!Array.isArray(s.steps)) return [...problems, "steps: must be an array"];
  s.steps.forEach((st: unknown, i: number) => {
    const p = `steps[${i}]`;
    if (!isObj(st)) {
      problems.push(`${p}: must be an object`);
      return;
    }
    const kinds = KINDS.filter((k) => k in st);
    if (kinds.length !== 1) {
      problems.push(`${p}: must have exactly one of ${KINDS.join(", ")}`);
      return;
    }
    const kind = kinds[0];
    if (kind === "collie" && !(Array.isArray(st.collie) && st.collie.every((a) => typeof a === "string"))) {
      problems.push(`${p}.collie: must be an array of strings`);
    }
    if (kind === "shell" && typeof st.shell !== "string") problems.push(`${p}.shell: must be a string`);
    if (kind === "sleep_ms" && !(Number.isInteger(st.sleep_ms) && (st.sleep_ms as number) >= 0)) {
      problems.push(`${p}.sleep_ms: must be a non-negative integer`);
    }
    if (kind === "exit" && !Number.isInteger(st.exit)) problems.push(`${p}.exit: must be an integer`);
    if (kind === "await_message" && !isObj(st.await_message))
      problems.push(`${p}.await_message: must be an object`);
    if (st.expect_exit !== undefined && !Number.isInteger(st.expect_exit))
      problems.push(`${p}.expect_exit: must be an integer`);
    if (st.stdin !== undefined && typeof st.stdin !== "string") problems.push(`${p}.stdin: must be a string`);
  });
  return problems;
}
