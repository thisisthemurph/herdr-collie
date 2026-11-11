import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Board } from "@collie/schema";
import { formatIssues, validateCommand } from "@collie/schema";
import {
  alerts,
  answerAction,
  blankDraft,
  boardModel,
  buildProfile,
  COMPLETE_AT_OPTIONS,
  decodeLines,
  defaultActivityRun,
  deleteRun,
  describeEvent,
  describeReply,
  draftOf,
  duplicateDraft,
  encodeLines,
  eventKinds,
  eventRows,
  eventTickets,
  excludeAction,
  execChipLabel,
  execLine,
  externalActions,
  findingRows,
  findingTickets,
  formatDuration,
  investigateAction,
  investigateTargets,
  isPruned,
  jiraStepsText,
  metricsLines,
  needsConfirm,
  needsYou,
  newRunFrom,
  nextPreparation,
  nextWorkflow,
  PR_DRAFT_OPTIONS,
  parseEvents,
  parseImport,
  prBadges,
  prepModel,
  prRows,
  questionRows,
  type RunRecord,
  type RunView,
  runHistory,
  runMetrics,
  runModel,
  saveProfileAction,
  settingAction,
  startAction,
  ticketRunActions,
  watchCommand,
} from "../src/model.ts";

const fixture = (name: string): Board =>
  JSON.parse(readFileSync(join(import.meta.dir, `../../fixtures/boards/${name}.json`), "utf8"));

describe("boardModel", () => {
  test("rows, readiness counts and outside blockers with their links", () => {
    const m = boardModel(fixture("external-blockers"));
    expect(m.rows.map((r) => `${r.key}:${r.readiness}`)).toEqual([
      "PAY-1:blocked",
      "PAY-2:blocked",
      "PAY-3:blocked",
    ]);
    expect(m.counts).toEqual({ excluded: 0, pending: 0, blocked: 3, ready: 0 });
    expect(m.externals).toEqual([
      {
        key: "OPS-77",
        summary: "Ticket OPS-77",
        jiraStatus: "To Do",
        satisfied: false,
        blocks: [
          { key: "PAY-1", overridden: false },
          { key: "PAY-3", overridden: false },
        ],
      },
      {
        key: "SEC-9",
        summary: "Ticket SEC-9",
        jiraStatus: "Done",
        satisfied: true,
        blocks: [{ key: "PAY-2", overridden: false }],
      },
    ]);
    expect(m.startBlocked).toBeNull();
  });

  test("a cycle blocks Start run and says how to fix it", () => {
    expect(boardModel(fixture("cycle")).startBlocked).toBe(
      "Dependency cycle: PAY-1 -> PAY-2 -> PAY-3 -> PAY-1. Override one link, or fix it in Jira and refresh.",
    );
  });

  test("an empty board says to import first", () => {
    const b = fixture("single");
    b.tickets = {};
    expect(boardModel(b).startBlocked).toBe("Import tickets first.");
  });

  test("keys sort numerically and the critical path is marked", () => {
    const m = boardModel(fixture("islands"));
    expect(m.rows.map((r) => r.key)).toEqual(["PAY-1", "PAY-2", "PAY-10", "PAY-11", "PAY-12", "PAY-20"]);
    expect(m.rows.filter((r) => r.critical).map((r) => r.key)).toEqual(["PAY-1", "PAY-2"]);
  });

  test("the same board.json gives the same model: reloading the mod loses nothing", () => {
    const b = fixture("spike-20");
    expect(boardModel(JSON.parse(JSON.stringify(b)))).toEqual(boardModel(b));
  });
});

test("the preparation chip cycles through every status", () => {
  const seen = ["unreviewed"];
  for (let i = 0; i < 5; i++) seen.push(nextPreparation(seen.at(-1) as never));
  expect(seen).toEqual(["unreviewed", "investigating", "needs_input", "ready", "excluded", "unreviewed"]);
});

test.each([
  ["PAY-1, PAY-2", { keys: ["PAY-1", "PAY-2"] }],
  ["pay-3 PAY-3", { keys: ["PAY-3"] }],
  ["project = PAY AND sprint in openSprints()", { jql: "project = PAY AND sprint in openSprints()" }],
  ["   ", null],
] as const)("parseImport(%p)", (text, expected) => {
  expect(parseImport(text)).toEqual(expected as never);
});

test("replies read as sentences", () => {
  expect(
    describeReply("board.import", { ok: true, result: { added: ["A-1", "A-2"], external: ["X-1"] } }),
  ).toBe("Imported 2 ticket(s), and found 1 outside blocker(s).");
  expect(
    describeReply("board.refresh", {
      ok: true,
      result: { changed: ["X-1"], readiness_changed: ["A-3"], missing: [] },
    }),
  ).toBe("Refreshed: X-1 changed in Jira. Readiness changed for A-3.");
  expect(
    describeReply("run.start", { ok: false, error: { code: "cycle_detected", message: "a cycle" } }),
  ).toBe("run.start: a cycle");
});

describe("button actions", () => {
  const BOARD_ID = "01JC8XW0000000000000000001";
  const asCommand = (a: { command: string; args: unknown }) =>
    validateCommand({
      v: 1,
      id: "01JC9A0C000000000000000001",
      command: a.command,
      at: "2026-11-09T10:00:00Z",
      args: a.args,
    });

  test("an outside blocker offers Pull in and an Override for each ticket it holds up", () => {
    const x = boardModel(fixture("external-blockers")).externals[0];
    if (!x) throw new Error("no outside blocker");
    expect(externalActions(BOARD_ID, x).map((a) => [a.id, a.label, a.command, a.args])).toEqual([
      ["pull-OPS-77", "Pull in", "ticket.pull_in", { board_id: BOARD_ID, ticket: "OPS-77" }],
      [
        "ovr-OPS-77-PAY-1",
        "Override → PAY-1",
        "dep.override",
        { board_id: BOARD_ID, blocker: "OPS-77", blocked: "PAY-1" },
      ],
      [
        "ovr-OPS-77-PAY-3",
        "Override → PAY-3",
        "dep.override",
        { board_id: BOARD_ID, blocker: "OPS-77", blocked: "PAY-3" },
      ],
    ]);
  });

  test("an overridden link offers Restore instead", () => {
    const b = fixture("external-blockers");
    b.overrides.push({ blocker: "OPS-77", blocked: "PAY-1", by: "human", at: "2026-11-09T10:00:00Z" });
    const x = boardModel(b).externals[0];
    if (!x) throw new Error("no outside blocker");
    const labels = externalActions(BOARD_ID, x).map((a) => `${a.label} (${a.command})`);
    expect(labels).toContain("Restore → PAY-1 (dep.restore)");
    expect(labels).toContain("Override → PAY-3 (dep.override)");
  });

  test("Exclude and Include flip the ticket's preparation", () => {
    expect(excludeAction(BOARD_ID, "PAY-1", "ready")).toMatchObject({
      label: "Exclude from runs",
      args: { preparation: "excluded" },
    });
    expect(excludeAction(BOARD_ID, "PAY-1", "excluded")).toMatchObject({
      label: "Include again",
      args: { preparation: "unreviewed" },
    });
  });

  test("every button sends a command the controller accepts", () => {
    for (const name of ["external-blockers", "spike-20"]) {
      const m = boardModel(fixture(name));
      const actions = [
        ...m.externals.flatMap((x) => externalActions(BOARD_ID, x)),
        ...m.rows.map((r) => excludeAction(BOARD_ID, r.key, r.preparation)),
      ];
      expect(actions.length).toBeGreaterThan(0);
      for (const a of actions) {
        const r = asCommand(a);
        if (!r.ok) throw new Error(`${a.id}: ${formatIssues(r.issues)}`);
      }
    }
  });
});

describe("a run in progress", () => {
  const RUN = "01JC8YQ0000000000000000001";
  const E1 = "01JC8Z1A000000000000000001";
  const E2 = "01JC8Z1A000000000000000002";
  const view = (status: "running" | "paused" | "completed" = "running"): RunView => ({
    id: RUN,
    number: 3,
    status,
    boardId: "01JC8XW0000000000000000001",
    state: {
      v: 1,
      run_id: RUN,
      last_event_id: null,
      status,
      leases: ["PAY-1", "PAY-2", "PAY-3"],
      tickets: {
        "PAY-1": {
          state: "completed",
          resume_state: null,
          attention: [],
          round: 1,
          branch: "pay-1",
          base: "main",
          executions: [E1],
          pr: null,
        },
        "PAY-2": {
          state: "needs_input",
          resume_state: "in_progress",
          attention: [{ kind: "execution_failed", id: E2 }],
          round: 1,
          branch: "pay-2",
          base: "pay-1",
          executions: [E2],
          pr: null,
        },
        "PAY-3": {
          state: "in_progress",
          resume_state: null,
          attention: [],
          round: 1,
          branch: null,
          base: null,
          executions: [],
          pr: null,
        },
      },
      executions: {
        [E1]: {
          ticket: "PAY-1",
          profile: "developer",
          kind: "develop",
          state: "completed",
          attempt: 1,
          round: 1,
          terminal: "t4",
          nudges: 0,
          started_at: null,
          ended_at: null,
          result: { summary: "Added the table", commits: ["a1b2c3d"] },
        },
        [E2]: {
          ticket: "PAY-2",
          profile: "developer",
          kind: "develop",
          state: "failed",
          attempt: 2,
          round: 1,
          terminal: "t5",
          nudges: 2,
          started_at: null,
          ended_at: null,
          result: { reason: "no report after 2 nudges", category: "tooling", retryable: true },
        },
      },
      questions: {},
      findings: [],
      inbox_offsets: {},
    },
  });

  test("tickets read as words and tones, with their executions", () => {
    const m = runModel(view());
    if (!m) throw new Error("no model");
    expect(m.progress).toBe("1 of 3 done");
    expect(Object.values(m.tickets).map((t) => [t.key, t.label, t.tone])).toEqual([
      ["PAY-1", "Done", "done"],
      ["PAY-2", "Needs you", "blocked"],
      ["PAY-3", "Developing", "working"],
    ]);
    expect(m.tickets["PAY-2"]?.attention).toEqual(["its agent failed with no attempts left"]);
    expect(m.tickets["PAY-1"]?.executions.map((e) => [e.outcome, execLine(e)])).toEqual([
      ["Added the table", "Developer, development · attempt 1 · completed · t4"],
    ]);
    expect(m.tickets["PAY-2"]?.executions.map(execLine)).toEqual([
      "Developer, development · attempt 2 · failed · t5 · nudged 2×",
    ]);
  });

  test("a blocked agent says what it waits for", () => {
    const v = view();
    const e = v.state.executions[E2];
    if (!e) throw new Error("no execution");
    e.state = "working";
    e.agent_blocked = { kind: "permission", message: "approve Bash: go test" };
    expect(runModel(v)?.tickets["PAY-2"]?.executions[0]?.blocked).toBe(
      "waiting for permission: approve Bash: go test",
    );
  });

  test("Pause, Resume and Cancel follow the run's status", () => {
    const labels = (s: "running" | "paused" | "completed") => runModel(view(s))?.actions.map((a) => a.label);
    expect(labels("running")).toEqual(["Pause run", "Cancel run"]);
    expect(labels("paused")).toEqual(["Resume run", "Cancel run"]);
    expect(labels("completed")).toEqual([]);
  });

  test("Start run is blocked by a cycle, an empty board, or a run already going", () => {
    const board = fixture("single");
    const bm = boardModel(board);
    expect(startAction(board.id, bm, null)).toMatchObject({
      disabled: null,
      action: { command: "run.start" },
    });
    expect(startAction(board.id, boardModel(fixture("cycle")), null).disabled).toContain("Dependency cycle");
    expect(startAction(board.id, bm, runModel(view()))?.disabled).toBe("Run 3 is running.");
    expect(startAction(board.id, bm, runModel(view("completed")))?.disabled).toBeNull();
  });

  test("a held ticket offers Retry; every button sends a command the controller accepts", () => {
    const m = runModel(view());
    if (!m) throw new Error("no model");
    const held = ticketRunActions(RUN, m.tickets["PAY-2"] as never);
    expect(held.map((a) => a.label)).toEqual(["Retry with a new agent", "Cancel ticket"]);
    const running = ticketRunActions(RUN, m.tickets["PAY-3"] as never);
    expect(running.map((a) => a.label)).toEqual(["Cancel ticket"]);
    expect(ticketRunActions(RUN, m.tickets["PAY-1"] as never)).toEqual([]);
    const live = view();
    const e = live.state.executions[E2];
    if (!e) throw new Error("no execution");
    e.state = "working";
    const withLive = runModel(live);
    const stop = ticketRunActions(RUN, withLive?.tickets["PAY-2"] as never);
    expect(stop.map((a) => a.label)).toEqual([
      "Retry with a new agent",
      "Stop agent (attempt 2)",
      "Cancel ticket",
    ]);
    for (const a of [
      ...held,
      ...stop,
      ...(m.actions ?? []),
      startAction("01JC8XW0000000000000000001", { startBlocked: null }, null).action,
    ]) {
      const r = validateCommand({
        v: 1,
        id: "01JC9A0C000000000000000001",
        command: a.command,
        at: "2026-11-09T10:00:00Z",
        args: a.args,
      });
      if (!r.ok) throw new Error(`${a.id}: ${formatIssues(r.issues)}`);
    }
  });

  test("watching an agent peeks at its terminal in Herdr", () => {
    expect(watchCommand("t5")).toEqual({ name: "terminal.peek", args: { terminal: "t5" } });
  });

  test("no run, no model", () => {
    expect(runModel(null)).toBeNull();
  });
});

describe("questions, findings and the Needs you banner (Phase 5)", () => {
  const RUN = "01JC8YQ0000000000000000001";
  const BOARD = "01JC8XW0000000000000000001";
  const E_DEV = "01JC8Z1A000000000000000001";
  const E_SEC = "01JC8Z1A000000000000000002";
  const Q1 = "01JC8Z7Q000000000000000001";
  const Q2 = "01JC8Z7Q000000000000000002";
  const F = (n: number) => `01JC8Z9F00000000000000000${n}`;
  const summaries = { "PAY-1": "Add the table", "PAY-2": "Expose the API" };

  const view = (status: RunView["status"] = "running"): RunView => ({
    id: RUN,
    number: 4,
    status,
    boardId: BOARD,
    profiles: { "security-reviewer": "Security reviewer" },
    state: {
      v: 1,
      run_id: RUN,
      last_event_id: null,
      status,
      leases: [],
      tickets: {
        "PAY-1": {
          state: "reviewing",
          resume_state: null,
          attention: [],
          round: 1,
          branch: "pay-1",
          base: "main",
          executions: [E_DEV, E_SEC],
          pr: null,
        },
        "PAY-2": {
          state: "in_progress",
          resume_state: null,
          attention: [],
          round: 1,
          branch: null,
          base: null,
          executions: [],
          pr: null,
        },
      },
      executions: {
        [E_DEV]: {
          ticket: "PAY-1",
          profile: "developer",
          kind: "develop",
          state: "completed",
          attempt: 1,
          round: 1,
          terminal: "t1",
          nudges: 0,
          started_at: null,
          ended_at: null,
          result: { summary: "Done", commits: ["a1b2c3d"] },
        },
        [E_SEC]: {
          ticket: "PAY-1",
          profile: "security-reviewer",
          kind: "review",
          state: "working",
          attempt: 1,
          round: 1,
          terminal: "t2",
          nudges: 0,
          started_at: null,
          ended_at: null,
          result: null,
        },
      },
      questions: {},
      findings: [],
      inbox_offsets: {},
    },
  });

  /** The run with something of every kind that needs a person. */
  const needy = (): RunView => {
    const v = view();
    const sec = v.state.executions[E_SEC];
    if (!sec) throw new Error("fixture");
    v.state.questions[Q1] = {
      execution_id: E_SEC,
      ticket: "PAY-1",
      question: "Should the endpoint return 404 or 410?",
      options: ["404", "410"],
      state: "open",
      answer: null,
      share_with_ticket: false,
    };
    v.state.questions[Q2] = {
      execution_id: E_SEC,
      ticket: "PAY-1",
      question: "Old one",
      options: [],
      state: "delivered",
      answer: "yes",
      share_with_ticket: true,
    };
    const t2 = v.state.tickets["PAY-2"];
    if (!t2) throw new Error("fixture");
    t2.state = "needs_input";
    t2.attention = [{ kind: "round_cap" }];
    return v;
  };

  test("the banner lists open questions and held tickets with their actions", () => {
    const items = needsYou(needy(), summaries);
    expect(items.map((i) => [i.kind, i.ticket, i.actions.map((a) => a.label)])).toEqual([
      ["question", "PAY-1", ["Answer"]],
      ["round_cap", "PAY-2", ["Retry (one more round)", "Cancel ticket"]],
    ]);
    expect(items[0]?.reason).toBe(
      "Security reviewer, review round 1 asks: Should the endpoint return 404 or 410?",
    );
    expect(items[0]?.summary).toBe("Add the table");
    // An answered question no longer holds anyone.
    expect(items.some((i) => i.key === `question:${Q2}`)).toBe(false);
  });

  test("a failed agent offers Retry and Watch terminal; a blocked agent offers Watch terminal", () => {
    const v = view();
    const dev = v.state.executions[E_DEV];
    const sec = v.state.executions[E_SEC];
    const t1 = v.state.tickets["PAY-1"];
    if (!dev || !sec || !t1) throw new Error("fixture");
    dev.state = "failed";
    dev.result = { reason: "no report after 2 nudges", category: "tooling", retryable: true };
    t1.attention = [{ kind: "execution_failed", id: E_DEV }];
    sec.agent_blocked = { kind: "permission", message: "approve Bash: go test" };
    const items = needsYou(v, summaries);
    expect(items.map((i) => [i.kind, i.actions.map((a) => a.label)])).toEqual([
      ["execution_failed", ["Retry", "Watch terminal", "Cancel ticket"]],
      ["agent_blocked", ["Watch terminal"]],
    ]);
    expect(items[1]?.reason).toBe(
      "Security reviewer, review round 1 is waiting for permission: approve Bash: go test",
    );
  });

  test("the banner is empty when nothing needs a person, and for finished tickets", () => {
    expect(needsYou(view())).toEqual([]);
    const v = needy();
    const t2 = v.state.tickets["PAY-2"];
    if (!t2) throw new Error("fixture");
    t2.state = "cancelled";
    expect(needsYou(v).map((i) => i.kind)).toEqual(["question"]);
  });

  test("every banner and inspector command is one the controller accepts", () => {
    const m = runModel(needy(), summaries);
    if (!m) throw new Error("no model");
    const items = needsYou(needy(), summaries);
    const ctls = items.flatMap((i) => i.actions).flatMap((a) => (a.type === "ctl" ? [a] : []));
    expect(ctls.length).toBeGreaterThan(0);
    const answer = answerAction(RUN, Q1, " 404 ", true);
    if ("error" in answer) throw new Error(answer.error);
    expect(answer.action.args).toEqual({
      run_id: RUN,
      question_id: Q1,
      answer: "404",
      share_with_ticket: true,
    });
    const cmds = [
      ...ctls.map((a) => ({ command: a.command, args: a.args })),
      { command: answer.action.command, args: answer.action.args },
      ...ticketRunActions(RUN, m.tickets["PAY-2"] as never),
      investigateAction(BOARD, ["PAY-1", "PAY-2"]),
      {
        command: "ticket.set_workflow",
        args: { board_id: BOARD, ticket: "PAY-1", workflow: "small-bug-fix" },
      },
      { command: "ticket.set_workflow", args: { board_id: BOARD, ticket: "PAY-1", workflow: null } },
      {
        command: "board.update_settings",
        args: { board_id: BOARD, settings: { workflow: "standard-feature" } },
      },
    ];
    for (const a of cmds) {
      const r = validateCommand({
        v: 1,
        id: "01JC9A0C000000000000000001",
        command: a.command,
        at: "2026-11-09T10:00:00Z",
        args: a.args,
      });
      if (!r.ok) throw new Error(`${a.command}: ${formatIssues(r.issues)}`);
    }
  });

  test("an empty answer is refused before anything is sent", () => {
    expect(answerAction(RUN, Q1, "   ", false)).toEqual({
      error: "Type an answer, or pick one of the options.",
    });
  });

  test("questions: open first, with who asked", () => {
    const rows = questionRows(needy().state, "run", summaries, { "security-reviewer": "Security reviewer" });
    expect(rows.map((r) => [r.id, r.state, r.asker])).toEqual([
      [Q1, "open", "Security reviewer, review round 1"],
      [Q2, "delivered", "Security reviewer, review round 1"],
    ]);
    // Without a name from the run's snapshot, the profile id is made readable.
    expect(questionRows(needy().state, "prep")[0]?.asker).toBe(
      "Security-reviewer, review round 1".replace("-", " "),
    );
  });

  test("findings: blocking and open first, addressed last, filterable by ticket", () => {
    const v = view();
    const base = { execution_id: E_SEC, round: 1, file: "src/a.ts", line: 10 };
    v.state.findings = [
      {
        ...base,
        id: F(1),
        ticket: "PAY-1",
        severity: "low",
        blocking: false,
        title: "Nit",
        addressed_in_round: null,
      },
      {
        ...base,
        id: F(2),
        ticket: "PAY-1",
        severity: "high",
        blocking: true,
        title: "SQL injection",
        addressed_in_round: 2,
      },
      {
        ...base,
        id: F(3),
        ticket: "PAY-2",
        severity: "medium",
        blocking: true,
        title: "No auth",
        addressed_in_round: null,
        line: undefined,
      },
    ];
    const rows = findingRows(v.state, summaries);
    expect(rows.map((r) => r.title)).toEqual(["No auth", "Nit", "SQL injection"]);
    expect(rows[0]).toMatchObject({
      where: "src/a.ts",
      blocking: true,
      addressed: false,
      summary: "Expose the API",
    });
    expect(rows[2]).toMatchObject({ where: "src/a.ts:10", addressed: true, addressedInRound: 2 });
    expect(findingRows(v.state, summaries, "PAY-1").map((r) => r.title)).toEqual(["Nit", "SQL injection"]);
    expect(findingTickets(v.state)).toEqual([
      { key: "PAY-1", open: 1 },
      { key: "PAY-2", open: 1 },
    ]);
    // The inspector gets only a ticket's open findings, and its open questions.
    const m = runModel({ ...v, state: needy().state }, summaries);
    expect(m?.tickets["PAY-1"]?.openQuestions.map((q) => q.id)).toEqual([Q1]);
    const m2 = runModel(v, summaries);
    expect(m2?.tickets["PAY-1"]?.openFindings.map((f) => f.title)).toEqual(["Nit"]);
  });

  test("states and executions read sensibly for the new kinds", () => {
    const m = runModel(needy(), summaries);
    if (!m) throw new Error("no model");
    expect(m.tickets["PAY-1"]).toMatchObject({ label: "Reviewing", tone: "working" });
    expect(m.tickets["PAY-2"]).toMatchObject({
      label: "Needs you",
      tone: "blocked",
      attentionKinds: ["round_cap"],
    });
    expect(m.tickets["PAY-1"]?.executions.map(execLine)).toEqual([
      "Developer, development · attempt 1 · completed · t1",
      "Security reviewer, review round 1 · attempt 1 · working · t2",
    ]);
    expect(execChipLabel(m.tickets["PAY-1"] as never).text).toBe("rev r1");
    expect(ticketRunActions(RUN, m.tickets["PAY-2"] as never).map((a) => a.label)).toEqual([
      "Retry (one more round)",
      "Cancel ticket",
    ]);
  });

  describe("alerts", () => {
    test("opening the mod announces nothing, even with questions waiting", () => {
      expect(alerts(null, needy(), summaries)).toEqual([]);
    });

    test("a new question, new attention and a new blocked agent are each announced once", () => {
      const before = view();
      const a = alerts(before, needy(), summaries);
      expect(a.map((x) => [x.key, x.title, x.level])).toEqual([
        [`question:${Q1}`, "PAY-1 needs you", "warning"],
        ["attention:PAY-2:round_cap", "PAY-2 needs you", "warning"],
      ]);
      expect(a[0]?.body).toContain("Should the endpoint return 404 or 410?");
      // Same view again: nothing new.
      expect(alerts(needy(), needy(), summaries)).toEqual([]);
      const blocked = view();
      const sec = blocked.state.executions[E_SEC];
      if (!sec) throw new Error("fixture");
      sec.agent_blocked = { kind: "question", message: "Allow?" };
      expect(alerts(view(), blocked, summaries).map((x) => x.key)).toEqual([`blocked:${E_SEC}:question`]);
    });

    test("a run that ends is announced once; a run already over is not", () => {
      const done = view("completed");
      const t1 = done.state.tickets["PAY-1"];
      if (!t1) throw new Error("fixture");
      t1.state = "completed";
      const a = alerts(view(), done, summaries);
      expect(a).toEqual([
        {
          key: `run:${RUN}:completed`,
          title: "Run 4 is complete",
          body: "1 of 2 tickets done.",
          level: "success",
        },
      ]);
      expect(alerts(done, done, summaries)).toEqual([]);
      expect(alerts(view("paused"), view("cancelled"), summaries)[0]).toMatchObject({
        title: "Run 4 was cancelled",
        level: "info",
      });
    });

    test("another run is a fresh start, not a flood of alerts", () => {
      const other = { ...needy(), id: "01JC8YQ0000000000000000002" };
      expect(alerts(view(), other, summaries)).toEqual([]);
    });
  });

  describe("Board setup: the analyst and workflows", () => {
    test("a ticket's workflow cycles through the default (null) and each workflow", () => {
      const ids = ["standard-feature", "small-bug-fix"];
      expect(nextWorkflow(null, ids)).toBe("standard-feature");
      expect(nextWorkflow("standard-feature", ids)).toBe("small-bug-fix");
      expect(nextWorkflow("small-bug-fix", ids)).toBeNull();
      expect(nextWorkflow("gone", ids)).toBeNull();
      expect(nextWorkflow(null, [])).toBeNull();
    });

    test("Investigate all targets only unreviewed tickets", () => {
      expect(
        investigateTargets([
          { key: "PAY-1", preparation: "unreviewed" },
          { key: "PAY-2", preparation: "ready" },
          { key: "PAY-3", preparation: "needs_input" },
          { key: "PAY-4", preparation: "unreviewed" },
        ]),
      ).toEqual(["PAY-1", "PAY-4"]);
      expect(investigateAction(BOARD, ["PAY-1"]).label).toBe("Investigate");
    });

    test("the analyst's open questions and notes group by ticket, answered with the board id", () => {
      const board = fixture("single");
      const key = Object.keys(board.tickets)[0] as string;
      const prep = view().state;
      const exec = {
        ...(prep.executions[E_SEC] as never as object),
        ticket: key,
        profile: "requirements-analyst",
        kind: "analyse",
        round: 0,
      };
      prep.executions = { [E_SEC]: exec as never };
      prep.questions = {
        [Q1]: {
          execution_id: E_SEC,
          ticket: key,
          question: "Which currency?",
          options: [],
          state: "open",
          answer: null,
          share_with_ticket: false,
        },
      };
      prep.findings = [
        {
          id: F(1),
          ticket: key,
          execution_id: E_SEC,
          round: 0,
          severity: "info",
          blocking: false,
          title: "Split this ticket",
          addressed_in_round: null,
        },
      ];
      const items = prepModel(board, prep);
      expect(items).toHaveLength(1);
      expect(items[0]?.questions[0]).toMatchObject({
        scope: "prep",
        asker: "Requirements analyst, analysis",
      });
      expect(items[0]?.notes.map((n) => n.title)).toEqual(["Split this ticket"]);
      expect(prepModel(board, null)).toEqual([]);
    });
  });
  describe("Phase 6: pull requests and delivery", () => {
    const pr = (over: Partial<NonNullable<RunView["state"]["tickets"][string]["pr"]>> = {}) => ({
      id: 147,
      url: "https://bitbucket.org/[WORKSPACE]/[REPO]/pull-requests/147",
      source: "pay-1",
      destination: "main",
      draft: false,
      state: "OPEN" as const,
      approvals: 0,
      conflicted: false,
      conflict_checked_at: null,
      ...over,
    });
    const withPr = (over = {}, status: RunView["status"] = "running"): RunView => {
      const v = view(status);
      const t = v.state.tickets["PAY-1"];
      if (!t) throw new Error("fixture");
      t.pr = pr(over);
      t.jira_steps = ["start"];
      return v;
    };

    test("one PR row per ticket with a PR; Mark ready only on an open draft", () => {
      expect(prRows(view(), summaries)).toEqual([]);
      const rows = prRows(
        withPr({ draft: true, approvals: 2, conflicted: true, needs_rebase: true }),
        summaries,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ticket: "PAY-1",
        summary: "Add the table",
        id: 147,
        branches: "pay-1 → main",
        approvals: 2,
        markReady: { command: "pr.mark_ready", args: { run_id: RUN, ticket: "PAY-1" } },
      });
      expect(rows[0] && prBadges(rows[0]).map((b) => b.label)).toEqual([
        "Draft",
        "Conflicted",
        "Needs rebase",
      ]);
      expect(prRows(withPr({ draft: false }))[0]?.markReady).toBeNull();
      expect(prRows(withPr({ draft: true, state: "MERGED" }))[0]?.markReady).toBeNull();
      expect(prRows(withPr({ draft: true, state: "DECLINED" }))[0]?.markReady).toBeNull();
    });

    test("an ended run still lists its PRs", () => {
      expect(prRows(withPr({ draft: true }, "completed"))).toHaveLength(1);
    });

    test("the ticket view carries the PR and the Jira steps", () => {
      const t = runModel(withPr(), summaries)?.tickets["PAY-1"];
      expect(t?.pr?.id).toBe(147);
      expect(t?.jiraSteps).toEqual(["start"]);
      expect(jiraStepsText(["start"])).toBe("moved on start: done · moved on PR: not yet");
    });

    test("a delivery error shows on the banner with Retry, also on a completed ticket", () => {
      const v = view();
      const t1 = v.state.tickets["PAY-1"];
      const t2 = v.state.tickets["PAY-2"];
      if (!t1 || !t2) throw new Error("fixture");
      t1.state = "completed";
      t1.attention = [{ kind: "delivery_error" }];
      t2.state = "needs_input";
      t2.attention = [{ kind: "delivery_error" }];
      const items = needsYou(v, summaries);
      expect(items.map((i) => [i.ticket, i.kind])).toEqual([
        ["PAY-1", "delivery_error"],
        ["PAY-2", "delivery_error"],
      ]);
      expect(items[0]?.reason).toContain("Delivery failed");
      expect(items[0]?.actions[0]).toMatchObject({ type: "ctl", command: "ticket.retry" });
      // A completed ticket with no attention is not listed.
      t1.attention = [];
      expect(needsYou(v, summaries).map((i) => i.ticket)).toEqual(["PAY-2"]);
      const m = runModel(v, summaries);
      expect(ticketRunActions(RUN, m?.tickets["PAY-2"] as never).map((a) => a.label)).toEqual([
        "Retry delivery",
        "Cancel ticket",
      ]);
    });

    test("a new PR, a merge and a new needs_rebase are each announced once", () => {
      const opened = alerts(view(), withPr(), summaries);
      expect(opened.map((a) => [a.key, a.title])).toEqual([[`pr:PAY-1:147:opened`, "PAY-1: PR #147 opened"]]);
      expect(alerts(withPr(), withPr(), summaries)).toEqual([]);
      const merged = alerts(withPr(), withPr({ state: "MERGED" }), summaries);
      expect(merged.map((a) => a.title)).toEqual(["PAY-1: PR #147 merged"]);
      expect(alerts(withPr({ state: "MERGED" }), withPr({ state: "MERGED" }), summaries)).toEqual([]);
      const rebase = alerts(withPr(), withPr({ needs_rebase: true }), summaries);
      expect(rebase.map((a) => [a.level, a.title])).toEqual([["warning", "PAY-1: PR #147 needs a rebase"]]);
      expect(alerts(withPr({ needs_rebase: true }), withPr({ needs_rebase: true }), summaries)).toEqual([]);
      expect(alerts(withPr({ needs_rebase: true }), withPr({ needs_rebase: false }), summaries)).toEqual([]);
    });

    test("every new button sends a command the controller accepts", () => {
      const cmds = [
        ...prRows(withPr({ draft: true })).flatMap((r) => (r.markReady ? [r.markReady] : [])),
        ...COMPLETE_AT_OPTIONS.map((o) => settingAction(BOARD, { complete_at: o })),
        ...PR_DRAFT_OPTIONS.map((o) => settingAction(BOARD, { pr_draft_policy: o })),
      ];
      expect(cmds).toHaveLength(7);
      for (const a of cmds) {
        const r = validateCommand({
          v: 1,
          id: "01JC9A0C000000000000000001",
          command: a.command,
          at: "2026-11-09T10:00:00Z",
          args: a.args,
        });
        if (!r.ok) throw new Error(`${a.command}: ${formatIssues(r.issues)}`);
      }
    });
  });
});

// --- Phase 7

const asCmd = (a: { command: string; args: unknown }) =>
  validateCommand({
    v: 1,
    id: "01JC9A0C000000000000000001",
    command: a.command,
    at: "2026-11-09T10:00:00Z",
    args: a.args,
  });
const accepted = (a: { id?: string; command: string; args: unknown }) => {
  const r = asCmd(a);
  if (!r.ok) throw new Error(`${a.id ?? a.command}: ${formatIssues(r.issues)}`);
};

describe("retry and cancel follow the controller's rules", () => {
  const RUN = "01JC8YQ0000000000000000001";
  const E1 = "01JC8Z1A000000000000000001";
  const tk = (over: Record<string, unknown>) => ({
    state: "in_progress",
    resume_state: null,
    attention: [] as { kind: string; id?: string }[],
    round: 1,
    branch: null,
    base: null,
    executions: [] as string[],
    pr: null,
    ...over,
  });
  const exec = (state: string) => ({
    ticket: "PAY-1",
    profile: "developer",
    kind: "develop",
    state,
    attempt: 1,
    round: 1,
    terminal: "t1",
    nudges: 0,
    started_at: null,
    ended_at: null,
    result: null,
  });
  const run = (status: RunView["status"], ticket: Record<string, unknown>, execState = "working"): RunView =>
    ({
      id: RUN,
      number: 1,
      status,
      boardId: "01JC8XW0000000000000000001",
      state: {
        v: 1,
        run_id: RUN,
        last_event_id: null,
        status,
        leases: ["PAY-1"],
        tickets: { "PAY-1": tk({ executions: [E1], ...ticket }) },
        executions: { [E1]: exec(execState) },
        questions: {},
        findings: [],
        inbox_offsets: {},
      },
    }) as unknown as RunView;
  const labels = (v: RunView) => {
    const m = runModel(v);
    return ticketRunActions(RUN, m?.tickets["PAY-1"] as never, v.status).map((a) => a.label);
  };

  test("cancel: only in an active run, and only for a ticket that isn't final", () => {
    expect(labels(run("running", {}))).toEqual(["Stop agent (attempt 1)", "Cancel ticket"]);
    expect(labels(run("paused", {}))).toEqual(["Stop agent (attempt 1)", "Cancel ticket"]);
    expect(labels(run("completed", { state: "cancelled" }, "cancelled"))).toEqual([]);
    expect(labels(run("running", { state: "completed" }, "completed"))).toEqual([]);
    expect(labels(run("running", { state: "cancelled" }, "cancelled"))).toEqual([]);
    // A finished agent can't be stopped.
    expect(labels(run("running", {}, "failed"))).toEqual(["Cancel ticket"]);
  });

  test("retry: only while the run is running, and only for a held ticket", () => {
    const held = { state: "needs_input", attention: [{ kind: "execution_failed", id: E1 }] };
    expect(labels(run("running", held, "failed"))).toEqual(["Retry with a new agent", "Cancel ticket"]);
    expect(labels(run("paused", held, "failed"))).toEqual(["Cancel ticket"]);
    expect(
      labels(run("running", { state: "needs_input", attention: [{ kind: "round_cap" }] }, "completed")),
    ).toEqual(["Retry (one more round)", "Cancel ticket"]);
    // A question alone isn't retryable: it is answered.
    expect(
      labels(run("running", { state: "needs_input", attention: [{ kind: "question" }] }, "working")),
    ).toEqual(["Stop agent (attempt 1)", "Cancel ticket"]);
    // Delivery retry, also on a completed ticket (delivery goes on behind it), but not once the run ended.
    const undelivered = { state: "completed", attention: [{ kind: "delivery_error" }] };
    expect(labels(run("running", undelivered, "completed"))).toEqual(["Retry delivery"]);
    expect(labels(run("completed", undelivered, "completed"))).toEqual([]);
  });

  test("the Needs you banner offers Cancel ticket next to Retry, in an active run", () => {
    const held = run(
      "running",
      { state: "needs_input", attention: [{ kind: "execution_failed", id: E1 }] },
      "failed",
    );
    const items = needsYou(held);
    expect(items[0]?.actions.map((a) => a.label)).toEqual(["Retry", "Watch terminal", "Cancel ticket"]);
    const paused = needsYou(
      run("paused", { state: "needs_input", attention: [{ kind: "execution_failed", id: E1 }] }, "failed"),
    );
    expect(paused[0]?.actions.map((a) => a.label)).toEqual(["Watch terminal", "Cancel ticket"]);
    const done = needsYou(
      run("running", { state: "completed", attention: [{ kind: "delivery_error" }] }, "completed"),
    );
    expect(done[0]?.actions.map((a) => a.label)).toEqual(["Retry delivery"]);
  });

  test("cancels and deletes ask for a second click; retries don't", () => {
    for (const c of ["ticket.cancel", "exec.cancel", "run.cancel", "run.delete"])
      expect(needsConfirm(c)).toBe(true);
    for (const c of ["ticket.retry", "run.start", "profile.save", "run.pause"])
      expect(needsConfirm(c)).toBe(false);
  });

  test("every retry and cancel button sends a command the controller accepts", () => {
    const held = run("running", { state: "needs_input", attention: [{ kind: "execution_failed", id: E1 }] });
    const all = [
      ...ticketRunActions(RUN, runModel(held)?.tickets["PAY-1"] as never, "running"),
      ...needsYou(held).flatMap((i) => i.actions.flatMap((a) => (a.type === "ctl" ? [a] : []))),
    ];
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const a of all) accepted(a);
  });
});

describe("Activity: run history", () => {
  const BOARD = "01JC8XW0000000000000000001";
  const R1 = "01JC8YQ0000000000000000001";
  const R2 = "01JC8YQ0000000000000000002";
  const NOW = Date.parse("2026-11-10T12:00:00Z");
  const rec = (over: Partial<RunRecord>): RunRecord => ({
    id: R1,
    number: 1,
    boardId: BOARD,
    status: "completed",
    startedAt: "2026-11-01T10:00:00Z",
    endedAt: "2026-11-01T11:30:00Z",
    endReason: "all tickets done",
    carriedOverFrom: null,
    state: null,
    hasInbox: true,
    ...over,
  });

  test("runs list newest first with their dates, counts and end reason", () => {
    const rows = runHistory(
      [
        rec({
          state: {
            v: 1,
            run_id: R1,
            last_event_id: null,
            status: "completed",
            leases: [],
            tickets: {
              "PAY-1": { state: "completed", pr: { id: 7, state: "OPEN" } },
              "PAY-2": { state: "cancelled", pr: null },
            },
            executions: {},
            questions: {},
            findings: [],
            inbox_offsets: {},
          } as never,
        }),
        rec({ id: R2, number: 2, status: "running", endedAt: null, endReason: null, carriedOverFrom: R1 }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.title)).toEqual(["Run 2", "Run 1"]);
    expect(rows[0]).toMatchObject({ when: "started 2026-11-01 10:00", active: true, carriedFrom: 1 });
    expect(rows[1]).toMatchObject({
      when: "2026-11-01 10:00 → 2026-11-01 11:30",
      tickets: "1 of 2 done, 1 cancelled",
      prs: 1,
      openPrs: 1,
      endReason: "all tickets done",
      pruned: false,
    });
    expect(defaultActivityRun(rows)).toBe(R2);
    expect(defaultActivityRun(rows.slice(1))).toBe(R1);
    expect(defaultActivityRun([])).toBeNull();
  });

  test("inbox and attachments count as pruned only after 90 days and without inbox.jsonl", () => {
    const old = "2026-07-01T00:00:00Z";
    expect(isPruned({ endedAt: old, hasInbox: false }, NOW)).toBe(true);
    expect(isPruned({ endedAt: old, hasInbox: true }, NOW)).toBe(false);
    expect(isPruned({ endedAt: "2026-11-01T00:00:00Z", hasInbox: false }, NOW)).toBe(false);
    expect(isPruned({ endedAt: null, hasInbox: false }, NOW)).toBe(false);
  });

  test("New run from a run needs an ended run and a free board; Delete refuses an active one", () => {
    const row = { id: R1, active: false, number: 1 };
    expect(newRunFrom(BOARD, row, null, null)).toMatchObject({
      disabled: null,
      action: { command: "run.start", args: { board_id: BOARD, carry_over_from: R1 } },
    });
    expect(newRunFrom(BOARD, row, null, { number: 2, status: "running" })?.disabled).toBe(
      "Run 2 is running.",
    );
    expect(newRunFrom(BOARD, row, "Import tickets first.", null)?.disabled).toBe("Import tickets first.");
    expect(newRunFrom(BOARD, { ...row, active: true }, null, null)).toBeNull();
    expect(deleteRun({ id: R1, active: true, status: "paused" }).disabled).toContain("cancel it");
    expect(deleteRun({ id: R1, active: false, status: "completed" })).toMatchObject({
      disabled: null,
      action: { command: "run.delete", args: { run_id: R1 } },
    });
  });

  test("the history buttons send commands the controller accepts", () => {
    const n = newRunFrom(BOARD, { id: R1, active: false, number: 1 }, null, null);
    if (!n) throw new Error("no action");
    accepted(n.action);
    accepted(deleteRun({ id: R1, active: false, status: "completed" }).action);
  });
});

describe("Activity: events and metrics", () => {
  const line = (type: string, ts: string, ticket: string | null, payload: object, source = "controller") =>
    JSON.stringify({
      v: 1,
      id: `id-${ts}-${type}`,
      type,
      ts,
      source,
      run_id: "r",
      execution_id: null,
      ticket,
      caused_by: null,
      payload,
    });
  const log = [
    line("ticket.state_changed", "2026-11-08T10:00:00.000Z", "PAY-1", {
      from: "ready",
      to: "in_progress",
      reason: "agent started",
    }),
    line("execution.started", "2026-11-08T10:00:01.000Z", "PAY-1", { terminal: "t1" }),
    line(
      "finding",
      "2026-11-08T10:10:00.000Z",
      "PAY-1",
      { severity: "high", title: "Missing check", blocking: true, body_ref: "attachments/x.md" },
      "agent",
    ),
    line("agent.event_accepted", "2026-11-08T10:10:00.100Z", "PAY-1", { event_type: "finding" }),
    line("ask", "2026-11-08T10:11:00.000Z", "PAY-2", { question: "Which table?" }, "agent"),
    line("pr.created", "2026-11-08T10:20:00.000Z", "PAY-1", {
      number: 7,
      url: "u",
      base: "main",
      head: "pay-1",
      draft: false,
    }),
    line("delivery.failed", "2026-11-08T10:21:00.000Z", "PAY-2", {
      step: "push",
      reason: "no network",
      attempt: 1,
      final: false,
    }),
    line("ticket.state_changed", "2026-11-08T10:22:00.000Z", "PAY-1", {
      from: "delivering",
      to: "completed",
      reason: "pr created",
    }),
  ].join("\n");
  const events = parseEvents(`${log}\n\n{"torn":`);

  test("a blank or torn line is skipped, not fatal", () => {
    expect(events).toHaveLength(8);
    expect(parseEvents("not json\n")).toEqual([]);
  });

  test("kinds, ticket filter and ordering (newest last), without the accepted-event bookkeeping", () => {
    const all = eventRows(events, { ticket: null, kind: null }, false);
    expect(all.total).toBe(7);
    expect(all.rows.map((r) => r.type)).toEqual([
      "ticket.state_changed",
      "execution.started",
      "finding",
      "ask",
      "pr.created",
      "delivery.failed",
      "ticket.state_changed",
    ]);
    expect(eventRows(events, { ticket: "PAY-2", kind: null }, false).rows.map((r) => r.type)).toEqual([
      "ask",
      "delivery.failed",
    ]);
    const kind = (k: Parameters<typeof eventRows>[1]["kind"]) =>
      eventRows(events, { ticket: null, kind: k }, false).rows.map((r) => r.type);
    expect(kind("state")).toEqual(["ticket.state_changed", "execution.started", "ticket.state_changed"]);
    expect(kind("question")).toEqual(["ask"]);
    expect(kind("finding")).toEqual(["finding"]);
    expect(kind("pr")).toEqual(["pr.created", "delivery.failed"]);
    expect(kind("error")).toEqual(["delivery.failed"]);
    expect(eventTickets(events)).toEqual(["PAY-1", "PAY-2"]);
    expect(eventKinds({ type: "run.cancelled" })).toEqual(["state"]);
  });

  test("a body that retention removed reads 'removed after 90 days', not a path", () => {
    const text = (pruned: boolean) => eventRows(events, { ticket: null, kind: "finding" }, pruned).rows[0];
    expect(text(false)?.text).toContain("full text in attachments/x.md");
    expect(text(true)?.text).toContain("full text removed after 90 days");
    expect(text(true)?.removed).toBe(true);
    expect(text(true)?.text).not.toContain("attachments/");
  });

  test("only the newest 300 rows are drawn", () => {
    const many = Array.from(
      { length: 450 },
      (_, i) =>
        parseEvents(
          line(
            "status",
            `2026-11-08T10:00:${String(i % 60).padStart(2, "0")}.000Z`,
            "PAY-1",
            { message: `m${i}` },
            "agent",
          ),
        )[0],
    ).filter((e): e is NonNullable<typeof e> => !!e);
    const r = eventRows(
      many.map((e, i) => ({ ...e, id: String(i) })),
      { ticket: null, kind: null },
      false,
    );
    expect(r.total).toBe(450);
    expect(r.rows).toHaveLength(300);
    expect(r.rows.at(-1)?.text).toBe("m449");
  });

  test("describeEvent reads naturally", () => {
    expect(describeEvent(events[0] as never)).toBe("ready → in_progress: agent started");
    expect(describeEvent(events[5] as never)).toBe("PR #7 pay-1 → main");
  });

  test("metrics come from computeMetrics over the log", () => {
    const m = runMetrics(
      parseEvents(
        [
          line("execution.started", "2026-11-08T10:00:00.000Z", "PAY-1", { terminal: "t" }),
          line("pr.created", "2026-11-08T10:12:00.000Z", "PAY-1", {
            number: 1,
            url: "u",
            base: "main",
            head: "h",
            draft: false,
          }),
          line("ticket.state_changed", "2026-11-08T10:13:00.000Z", "PAY-1", {
            from: "delivering",
            to: "completed",
            reason: "x",
          }),
          line("execution.started", "2026-11-08T10:00:00.000Z", "PAY-2", { terminal: "t" }),
          line(
            "question.answered",
            "2026-11-08T10:05:00.000Z",
            "PAY-2",
            { question_id: "q", answer: "a", by: "human", share_with_ticket: false },
            "human",
          ),
        ].join("\n"),
      ),
    );
    expect(metricsLines(m)).toEqual([
      { label: "Completed without intervention", value: "1 of 2" },
      { label: "Interventions per ticket", value: "0.5" },
      { label: "Median time to PR", value: "12 min" },
      { label: "Remediation success", value: "none needed" },
    ]);
    expect(metricsLines(runMetrics([])).map((l) => l.value)).toEqual([
      "0 of 0",
      "0",
      "no PR yet",
      "none needed",
    ]);
    expect(formatDuration(45_000)).toBe("45 s");
    expect(formatDuration(65 * 60_000)).toBe("1 h 5 min");
  });
});

describe("agent profile editor", () => {
  const dev = {
    v: 1 as const,
    id: "developer",
    name: "Developer",
    role: "developer" as const,
    harness: "claude-code",
    model: "sonnet",
    args: ["--permission-mode", "acceptEdits"],
    instructions: "Line one.\nLine two with a \\ backslash.",
    permissions: { write_worktree: true, shell: true, network: false },
    timeout_min: 60,
    max_attempts: 2,
    updated_at: "2026-11-10T00:00:00Z",
  };
  const NOW = "2026-11-10T09:30:15.123Z";

  test("line breaks and backslashes survive the one-line field", () => {
    const text = "a\\nb\nc\\";
    expect(decodeLines(encodeLines(text))).toBe(text);
    expect(encodeLines("x\ny")).toBe("x\\ny");
  });

  test("editing and saving gives the whole profile with a fresh updated_at", () => {
    const d = draftOf(dev);
    const r = buildProfile({ ...d, model: "opus", args: "--a\\n--b" }, ["developer"], NOW);
    if (!r.ok) throw new Error(r.issues.join("; "));
    expect(r.profile).toEqual({
      ...dev,
      model: "opus",
      args: ["--a", "--b"],
      updated_at: "2026-11-10T09:30:15Z",
    });
    accepted(saveProfileAction(r.profile));
  });

  test("a duplicate gets a free id and saves as a new profile", () => {
    const d = duplicateDraft(dev, ["developer", "developer-copy"]);
    expect(d).toMatchObject({ isNew: true, id: "developer-copy-2", name: "Developer (copy)" });
    const r = buildProfile(d, ["developer", "developer-copy"], NOW);
    expect(r.ok).toBe(true);
    if (r.ok) accepted(saveProfileAction(r.profile));
  });

  test("a new profile builds from the name, with cursor as a harness", () => {
    const r = buildProfile(
      { ...blankDraft("reviewer"), name: "Frontend reviewer", harness: "cursor", timeout_min: "30" },
      [],
      NOW,
    );
    if (!r.ok) throw new Error(r.issues.join("; "));
    expect(r.profile).toMatchObject({
      id: "frontend-reviewer",
      role: "reviewer",
      harness: "cursor",
      timeout_min: 30,
    });
  });

  test("the schema's issues are shown, naming each field", () => {
    const r = buildProfile(
      { ...blankDraft(), name: "", timeout_min: "abc", max_attempts: "0", model: "" },
      [],
      NOW,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.issues.join("\n");
    expect(text).toContain("name");
    expect(text).toContain("timeout_min");
    expect(text).toContain("max_attempts");
    expect(text).toContain("model");
  });

  test("a new profile may not silently replace an existing id; an unknown harness is refused", () => {
    const r = buildProfile({ ...blankDraft(), name: "Developer", id: "developer" }, ["developer"], NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join("\n")).toContain("already exists");
    const h = buildProfile({ ...draftOf(dev), harness: "gemini" }, ["developer"], NOW);
    expect(h.ok).toBe(false);
  });
});
