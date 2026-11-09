// Scenario files for fake-hc: which terminals exist and the agent status each one plays back.
//
// {
//   "v": 1,
//   "agents": [
//     {
//       "match": { "name": "pay-101-dev", "labels": { "collie.ticket": "PAY-101" } },
//       "app": "claude-code",
//       "spawn": false,
//       "run_error": { "kind": "spawn_failed", "message": "cannot start ..." },
//       "steps": [
//         { "on": "run",  "state": "idle", "turn": 0 },
//         { "on": "get",  "state": "working", "turn": 1 },
//         { "on": "wait", "state": "done" },
//         { "on": "send", "state": "working", "turn": "+1" },
//         { "on": "wait", "state": "blocked", "kind": "permission", "msg": "approve Bash: go test" },
//         { "on": "wait", "exit": 0 }
//       ]
//     }
//   ]
// }
//
// Each `hc run` takes the first unused agent whose `match` fits (every given field must
// equal; an empty match fits anything). A terminal with no agent behaves like a plain
// program: status null, live until killed.
//
// Steps play back in order. Each command that targets the terminal applies the step at the
// cursor if that step's `on` is the command (or "any"), then answers from the resulting
// state: one step per call, so a test scripts exactly what each successive `hc get` or
// `hc wait` sees. `hc run` applies every leading "run" step; `ls` applies "ls" steps to every
// live terminal. `send` checks the state before its step (so a blocked agent refuses it),
// `wait` after (so it returns the status the turn ended in). Once the steps run out, the
// terminal keeps its last state.

export const STATUS_STATES = ["idle", "working", "done", "blocked", "error"] as const;
export type StatusState = (typeof STATUS_STATES)[number];
export const TRIGGERS = ["run", "send", "wait", "get", "ls", "label", "any"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export type Step = {
  on: Trigger;
  /** New agent status; null clears it (a plain program). */
  state?: StatusState | null;
  kind?: "permission" | "question";
  msg?: string;
  /** A number sets the turn counter; "+1" increments it. */
  turn?: number | "+1";
  /** The program exits with this code; the terminal becomes finished. */
  exit?: number;
};

export type AgentScript = {
  match?: { name?: string; labels?: Record<string, string> };
  app?: string;
  /** Really start the argv in the background (for end-to-end tests with fake-agent). */
  spawn?: boolean;
  run_error?: { kind: string; message: string; hint?: string };
  steps?: Step[];
};

export type Scenario = { v: 1; agents: AgentScript[] };

/** Checks a parsed scenario and returns a list of problems, each naming the field. */
export function checkScenario(s: unknown): string[] {
  const problems: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObj(s)) return ["scenario: must be an object"];
  if (s.v !== 1) problems.push(`v: must be 1, got ${JSON.stringify(s.v)}`);
  if (!Array.isArray(s.agents)) return [...problems, "agents: must be an array"];
  s.agents.forEach((a: unknown, i: number) => {
    const p = `agents[${i}]`;
    if (!isObj(a)) {
      problems.push(`${p}: must be an object`);
      return;
    }
    if (a.match !== undefined && !isObj(a.match)) problems.push(`${p}.match: must be an object`);
    if (a.run_error !== undefined && (!isObj(a.run_error) || typeof a.run_error.kind !== "string")) {
      problems.push(`${p}.run_error.kind: must be a string`);
    }
    if (a.steps === undefined) return;
    if (!Array.isArray(a.steps)) {
      problems.push(`${p}.steps: must be an array`);
      return;
    }
    a.steps.forEach((st: unknown, j: number) => {
      const q = `${p}.steps[${j}]`;
      if (!isObj(st)) {
        problems.push(`${q}: must be an object`);
        return;
      }
      if (!TRIGGERS.includes(st.on as Trigger))
        problems.push(`${q}.on: must be one of ${TRIGGERS.join(", ")}`);
      if (st.state !== undefined && st.state !== null && !STATUS_STATES.includes(st.state as StatusState)) {
        problems.push(`${q}.state: must be one of ${STATUS_STATES.join(", ")} or null`);
      }
      if (
        st.turn !== undefined &&
        st.turn !== "+1" &&
        !(Number.isInteger(st.turn) && (st.turn as number) >= 0)
      ) {
        problems.push(`${q}.turn: must be a non-negative integer or "+1"`);
      }
      if (st.exit !== undefined && !Number.isInteger(st.exit)) problems.push(`${q}.exit: must be an integer`);
      if (st.kind !== undefined && st.kind !== "permission" && st.kind !== "question") {
        problems.push(`${q}.kind: must be permission or question`);
      }
    });
  });
  return problems;
}
