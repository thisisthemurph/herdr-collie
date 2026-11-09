// Done when: every valid fixture passes validation, and every invalid one fails with a
// message naming the field.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatIssues,
  type Issue,
  parseEventLine,
  parseInboxLine,
  type Result,
  VALIDATORS,
  type ValidatorKind,
} from "../src/index.ts";

const FIXTURES = join(import.meta.dir, "../../../fixtures");
const read = (p: string) => readFileSync(join(FIXTURES, p), "utf8");
const list = (dir: string) =>
  readdirSync(join(FIXTURES, dir))
    .filter((f) => f !== "expected.json")
    .sort();
const expected = (dir: string): Record<string, string> => JSON.parse(read(`${dir}/expected.json`));

function expectValid(name: string, r: Result<unknown>) {
  if (!r.ok) throw new Error(`${name} should be valid but: ${formatIssues(r.issues)}`);
}

function expectInvalid(name: string, r: Result<unknown>, field: string) {
  expect(r.ok, `${name} should be invalid`).toBe(false);
  const issues = (r as { issues: Issue[] }).issues;
  const message = formatIssues(issues);
  if (field === "") {
    expect(
      issues.some((i) => i.path === ""),
      `${name}: expected a whole-line error, got: ${message}`,
    ).toBe(true);
  } else {
    expect(
      issues.map((i) => i.path),
      `${name}: expected an error on ${field}, got: ${message}`,
    ).toContain(field);
    expect(message).toContain(`${field}: `);
  }
}

describe("inbox lines", () => {
  for (const file of list("inbox/valid")) {
    test(`valid ${file}`, () => expectValid(file, parseInboxLine(read(`inbox/valid/${file}`))));
  }
  const want = expected("inbox/invalid");
  test("every invalid inbox fixture has an expected field", () => {
    expect(Object.keys(want).sort()).toEqual(list("inbox/invalid"));
  });
  for (const file of list("inbox/invalid")) {
    test(`invalid ${file} names ${want[file] || "the line"}`, () =>
      expectInvalid(file, parseInboxLine(read(`inbox/invalid/${file}`)), want[file] as string));
  }
});

describe("controller events", () => {
  for (const file of list("events/valid")) {
    test(`valid ${file}`, () => expectValid(file, parseEventLine(read(`events/valid/${file}`))));
  }
  const want = expected("events/invalid");
  test("every invalid event fixture has an expected field", () => {
    expect(Object.keys(want).sort()).toEqual(list("events/invalid"));
  });
  for (const file of list("events/invalid")) {
    test(`invalid ${file} names ${want[file]}`, () =>
      expectInvalid(file, parseEventLine(read(`events/invalid/${file}`)), want[file] as string));
  }
});

describe("files", () => {
  for (const kind of readdirSync(join(FIXTURES, "files")).sort()) {
    const validate = VALIDATORS[kind as ValidatorKind];
    test(`${kind} is a known validator`, () => expect(validate).toBeDefined());
    if (!validate) continue;
    for (const file of list(`files/${kind}/valid`)) {
      test(`valid ${kind}/${file}`, () =>
        expectValid(file, validate(JSON.parse(read(`files/${kind}/valid/${file}`)))));
    }
    const want = expected(`files/${kind}/invalid`);
    test(`every invalid ${kind} fixture has an expected field`, () => {
      expect(Object.keys(want).sort()).toEqual(list(`files/${kind}/invalid`));
    });
    for (const file of list(`files/${kind}/invalid`)) {
      test(`invalid ${kind}/${file} names ${want[file]}`, () =>
        expectInvalid(
          file,
          validate(JSON.parse(read(`files/${kind}/invalid/${file}`))),
          want[file] as string,
        ));
    }
  }
});

describe("complete run", () => {
  const lines = read("runs/complete/events.jsonl").split(/(?<=\n)/);

  test("every line is a valid event", () => {
    for (const [i, l] of lines.entries()) {
      const r = parseEventLine(l);
      if (!r.ok) throw new Error(`events.jsonl line ${i + 1}: ${formatIssues(r.issues)}`);
    }
  });

  const events = lines.map((l) => JSON.parse(l));

  test("ids are unique and in order; timestamps never go back", () => {
    const ids = events.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (let i = 1; i < events.length; i++) expect(events[i].ts >= events[i - 1].ts).toBe(true);
  });

  test("every caused_by points at an earlier event or a command", () => {
    const seen = new Set<string>();
    const commands = new Set(events.filter((e) => e.type.startsWith("command.")).map((e) => e.caused_by));
    for (const e of events) {
      // A rejected inbox line isn't copied into the log, so its rejection points at the inbox.
      const external = commands.has(e.caused_by) || e.type === "agent.event_rejected";
      if (e.caused_by) expect(seen.has(e.caused_by) || external, `${e.type} ${e.id}`).toBe(true);
      seen.add(e.id);
    }
  });

  test("every event belongs to the run, and the run ends completed", () => {
    const run = JSON.parse(read("runs/complete/run.json"));
    expect(events.every((e) => e.run_id === run.id)).toBe(true);
    expect(events[0].type).toBe("run.started");
    expect(events.at(-1).type).toBe("run.completed");
    expect(run.status).toBe("completed");
  });

  test("covers every agent event type and both tickets reach completed", () => {
    const types = new Set(events.map((e) => e.type));
    for (const t of ["status", "artifact", "ask", "finding", "done"]) expect(types.has(t)).toBe(true);
    const completed = events.filter((e) => e.type === "ticket.state_changed" && e.payload.to === "completed");
    expect(completed.map((e) => e.ticket).sort()).toEqual(["PAY-101", "PAY-102"]);
  });

  test("state.json is valid and shows both tickets completed", () => {
    const st = JSON.parse(read("runs/complete/state.json"));
    expectValid("state.json", VALIDATORS.state(st));
    expect(st.status).toBe("completed");
    expect(Object.values(st.tickets).map((t) => (t as { state: string }).state)).toEqual([
      "completed",
      "completed",
    ]);
  });

  test("execution files validate", () => {
    const dir = "runs/complete/executions";
    for (const id of readdirSync(join(FIXTURES, dir))) {
      expectValid(id, VALIDATORS.execution(JSON.parse(read(`${dir}/${id}/execution.json`))));
    }
  });
});

test("committed fixtures match fixtures/src/build.ts", () => {
  const p = Bun.spawnSync(["bun", join(FIXTURES, "src/build.ts"), "--check"]);
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
});

test("fixtures contain no real site, workspace or repository names", () => {
  // A real Jira host is lowercase letters before .atlassian.net; the placeholder is [SITE].
  const grep = (re: string) =>
    Bun.spawnSync(["grep", "-rhoE", re, FIXTURES]).stdout.toString().split("\n").filter(Boolean);
  expect(grep("[a-z0-9-]+\\.atlassian\\.net")).toEqual([]);
  for (const url of grep('bitbucket\\.org/[^"]+'))
    expect(url, url).toContain("bitbucket.org/[WORKSPACE]/[REPO]");
});
