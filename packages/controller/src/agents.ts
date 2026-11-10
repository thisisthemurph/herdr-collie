// Agent execution (docs/plan.md, Phase 4): dispatching ready tickets to developer agents, each in
// its own worktree and hc terminal; watching them; nudging, timing out and retrying them; and
// moving a ticket on when its developer is done. Everything here is level-triggered: each tick
// looks at the run's state and does what is missing, so a crash or a restart loses nothing. The
// only memory that isn't in events.jsonl is `Mon`, per-execution timers that can be rebuilt.
//
// DECISION (Phase 4): the workflow is developer-only. The snapshot's reviewers are ignored until
// Phase 5, a finished developer takes the ticket through `delivering` to `completed` at once, and
// delivery (push, PR, Jira) arrives in Phase 6.
import { homedir } from "node:os";
import { join } from "node:path";
import { dispatchNow, type ScheduleInput } from "@collie/board";
import type { AnyEvent, Board, ExecutionFile, Profile } from "@collie/schema";
import { AdapterError, type Adapters } from "./adapters/index.ts";
import { reevaluateRun } from "./boards.ts";
import { type Controller, isoSeconds } from "./controller.ts";
import { branchName, ensureWorktree, expandHome, verifyDeveloperDone, WorktreeError } from "./git.ts";
import { type Hc, HcError, type HcTerminal } from "./hc.ts";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./home.ts";
import { type InboxHooks, resumeTicketIfClear } from "./inbox.ts";
import type { BriefSource } from "./jira.ts";
import { isExecutionFinal, isTicketFinal } from "./machines.ts";
import type { RunLog } from "./runlog.ts";
import { FIRST_MESSAGE, systemPrompt, taskBrief } from "./templates.ts";

export type AgentOptions = {
  hc: Hc;
  adapters: Adapters;
  /** Where ticket descriptions come from; null briefs agents from the summary alone. */
  briefs?: BriefSource | null;
  /** Herdr's worktree convention: <root>/<repo>/<branch>. */
  worktreeRoot?: string;
  /** How long a finished turn waits before a nudge (protocol: 30 s). */
  graceMs?: number;
  /** How long an agent may sit idle at turn 0 before its launch counts as failed (protocol: 60 s). */
  startTimeoutMs?: number;
  /** Time between looks at one terminal. */
  pollMs?: number;
  /** Nudges before an execution fails (protocol: 2). */
  maxNudges?: number;
  /** How long one `hc wait` may block. */
  waitSeconds?: number;
  /** How long an agent may sit at turn 0 before its screen is checked for a trust dialog. */
  promptCheckMs?: number;
  /** How long to wait for Jira's description before briefing the agent without it. */
  briefTimeoutMs?: number;
};

const NUDGE = "You haven't reported a result. Run `collie done` or `collie fail`.";

type Mon = {
  busy: boolean;
  nextAt: number;
  launchedAt: number;
  /** When the agent's turn was first seen ended with no report. */
  endedAt: number | null;
  lastState: string | null;
  blocked: boolean;
  /** Messages for the agent, sent at its next turn end (a rejected `done`). */
  pending: string[];
  logged: boolean;
};

const ACTIVE_TICKET = ["in_progress", "reviewing", "remediating", "delivering", "needs_input"];
const LIVE_EXEC = ["starting", "working", "needs_input"];

export class Agents {
  /** Tickets whose agent is being set up (worktree, brief, hc run). */
  private readonly launching = new Set<string>();
  private readonly mon = new Map<string, Mon>();
  /** Terminals already sent `hc kill` by this controller. */
  private readonly killed = new Set<string>();
  /** Set once start-up reconciliation has run; until then nothing is dispatched or observed. */
  reconciled = false;
  readonly o: Required<Omit<AgentOptions, "briefs">> & { briefs: BriefSource | null };

  constructor(
    private readonly c: Controller,
    options: AgentOptions,
  ) {
    this.o = {
      worktreeRoot: join(homedir(), ".herdr", "worktrees"),
      graceMs: 30_000,
      startTimeoutMs: 60_000,
      pollMs: 1_000,
      maxNudges: 2,
      waitSeconds: 10,
      briefTimeoutMs: 15_000,
      promptCheckMs: 10_000,
      briefs: null,
      ...options,
    };
  }

  // --- the pass

  /** Called every tick for each live run. Starts async work, never waits for it. */
  tick(rl: RunLog): void {
    if (!this.reconciled) return;
    this.advanceTickets(rl);
    this.dispatch(rl);
    this.monitor(rl);
  }

  /** What the inbox watcher needs from the worktree (see inbox.ts). */
  readonly hooks: InboxHooks = {
    verifyDeveloper: (execId, commits) => this.verifyDeveloper(execId, commits),
    rejectedDone: (execId, reason) =>
      this.enqueue(
        execId,
        `[collie] Your \`done\` was rejected: ${reason}. Fix that, then run \`collie done\` again.`,
      ),
  };

  /** Background work in flight, so a caller (a test, a shutdown) can wait for it. */
  private readonly background = new Set<Promise<unknown>>();

  /** Runs `work` in the background. A failure is logged, never thrown: nothing may crash the controller. */
  private bg(what: string, work: Promise<unknown>): void {
    const p = work
      .catch((e) => this.c.log(`${what}: ${(e as Error).stack ?? e}`))
      .finally(() => this.background.delete(p));
    this.background.add(p);
  }

  /** Resolves when no background work is in flight. */
  async drain(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
  }

  private alive(rl: RunLog) {
    return this.c.runs.get(rl.id) === rl;
  }

  private mon_(execId: string): Mon {
    let m = this.mon.get(execId);
    if (!m) {
      const now = this.c.clock.now();
      m = {
        busy: false,
        nextAt: 0,
        launchedAt: now,
        endedAt: null,
        lastState: null,
        blocked: false,
        pending: [],
        logged: false,
      };
      this.mon.set(execId, m);
    }
    return m;
  }

  private enqueue(execId: string, text: string) {
    this.mon_(execId).pending.push(text);
  }

  private verifyDeveloper(execId: string, commits: string[]): string | null {
    for (const rl of this.c.runs.values()) {
      if (!rl.state.executions[execId]) continue;
      let file: ExecutionFile;
      try {
        file = readJson(this.c.home.executionFile(rl.id, execId)) as ExecutionFile;
      } catch {
        return null; // no execution.json: nothing to check against
      }
      return verifyDeveloperDone({ worktree: file.worktree, base: file.base ?? null, commits });
    }
    return null;
  }

  // --- tickets move on when their developer is done

  private advanceTickets(rl: RunLog): void {
    for (const key of [...rl.state.leases].sort()) {
      const t = rl.state.tickets[key];
      if (t?.state !== "in_progress" || this.launching.has(key)) continue;
      const execId = t.executions.at(-1);
      const e = execId ? rl.state.executions[execId] : undefined;
      if (!execId || !e) continue;
      try {
        if (e.state === "completed") this.completeTicket(rl, key);
        else if (e.state === "failed" || e.state === "cancelled") this.afterEnded(rl, key, execId);
      } catch (err) {
        this.c.log(`${key}: ${(err as Error).stack ?? err}`);
      }
    }
  }

  /** Developer done: no reviewers or delivery yet (Phase 4), so the ticket is complete. */
  private completeTicket(rl: RunLog, key: string): void {
    // One step at a time: each transition is checked against the state the last one left.
    this.c.emit(rl, [
      this.c.ticketTo(
        rl,
        key,
        "delivering",
        "developer finished; reviews and delivery arrive in later phases",
      ),
    ]);
    this.c.emit(rl, [this.c.ticketTo(rl, key, "completed", "developer finished")]);
    const executions = rl.state.tickets[key]?.executions ?? [];
    // Completing a ticket may ready its dependents, and may finish the run.
    reevaluateRun(this.c, rl.run.board_id, null);
    this.bg(`ending ${key}`, this.killExecutions(rl, executions, "ticket completed"));
    this.c.completeRunIfDone(rl, null);
  }

  /** A failed or cancelled execution: retry it if the rules allow, else hold the ticket for a person. */
  private afterEnded(rl: RunLog, key: string, execId: string): void {
    const e = rl.state.executions[execId];
    if (!e) return;
    const profile = rl.run.snapshot.profiles[e.profile];
    const retry = e.state === "failed" && e.result && "retryable" in e.result && e.result.retryable;
    if (retry && profile && e.attempt < profile.max_attempts) {
      if (rl.state.status !== "running") return; // a paused run starts nothing; it retries on resume
      this.launch(rl, key, e.attempt + 1);
      return;
    }
    const why =
      e.state === "cancelled"
        ? "its execution was cancelled"
        : `its execution failed: ${e.result && "reason" in e.result ? e.result.reason : "no reason given"}`;
    this.c.emit(rl, [
      this.c.event(
        rl.id,
        "ticket.attention_added",
        { kind: "execution_failed", id: execId },
        { ticket: key },
      ),
      this.c.ticketTo(rl, key, "needs_input", why),
    ]);
  }

  // --- dispatching

  private dispatch(rl: RunLog): void {
    if (rl.state.status !== "running") return;
    const snap = rl.run.snapshot;
    const tickets: ScheduleInput["tickets"] = {};
    let active = 0;
    for (const key of rl.state.leases) {
      const t = rl.state.tickets[key];
      if (!t) continue;
      const launching = this.launching.has(key);
      tickets[key] = {
        // A ticket being set up is spoken for, whatever its state says yet.
        state: launching ? "launching" : t.state,
        blocked_by: snap.tickets[key]?.blocked_by ?? [],
      };
      if (ACTIVE_TICKET.includes(t.state) || (launching && t.state === "ready")) active += 1;
    }
    const agents =
      Object.values(rl.state.executions).filter((e) => LIVE_EXEC.includes(e.state)).length +
      this.launching.size;
    const readySince = Object.fromEntries(rl.readyAt);
    const pick = dispatchNow({
      tickets,
      overrides: snap.overrides,
      readySince,
      active,
      agents,
      maxTickets: snap.settings.max_tickets,
      maxAgents: snap.settings.max_agents,
    });
    for (const key of pick) {
      try {
        this.launch(rl, key, 1);
      } catch (e) {
        this.c.log(`couldn't dispatch ${key}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Creates an execution for a ticket (its events, execution.json), then sets the agent up in
   * the background. Returns the execution's id. Throws, creating nothing, when the run's own
   * configuration can't start one.
   */
  launch(rl: RunLog, key: string, attempt: number): string {
    const board = this.c.loadBoard(rl.run.board_id);
    const snap = rl.run.snapshot;
    const workflow = snap.workflows[snap.tickets[key]?.workflow ?? snap.settings.workflow];
    const profile = workflow && snap.profiles[workflow.developer];
    if (!workflow || !profile) throw new Error(`the run's snapshot has no developer profile for ${key}`);
    const state = rl.state.tickets[key];
    if (!state) throw new Error(`${key} is not in run ${rl.id}`);

    // The branch is fixed on the ticket's first execution; retries reuse it and its worktree.
    let { branch, base } = state;
    let merge: string[] = [];
    if (!branch) {
      branch = branchName(key, board.tickets[key]?.summary ?? snap.tickets[key]?.summary ?? "");
      const finished = (snap.tickets[key]?.blocked_by ?? [])
        .filter((b) => !snap.overrides.some((o) => o.blocker === b && o.blocked === key))
        .filter((b) => rl.state.tickets[b]?.state === "completed" && rl.state.tickets[b]?.branch)
        .sort()
        .map((b) => rl.state.tickets[b]?.branch as string);
      // DECISION: a ticket whose blockers finished in this run is stacked on the first one's
      // branch, and merges the others in (it needs their code to work).
      base = finished[0] ?? board.repo.default_branch;
      merge = finished.slice(1);
    }
    const worktree = join(this.o.worktreeRoot, board.repo.slug, branch);
    const execId = this.c.clock.id();
    const now = this.c.clock.now();
    const file: ExecutionFile = {
      v: 1,
      id: execId,
      run_id: rl.id,
      ticket: key,
      profile: profile.id,
      role: profile.role,
      kind: "develop",
      round: 1,
      attempt,
      worktree,
      branch,
      ...(base ? { base } : {}),
      terminal: null,
      created_at: isoSeconds(now),
    };
    // execution.json goes down before the event that names the execution.
    writeJsonAtomic(this.c.home.executionFile(rl.id, execId), file);
    const o = { ticket: key, exec: execId };
    const events: AnyEvent[] = [];
    if (state.state === "ready") events.push(this.c.ticketTo(rl, key, "in_progress", "developer dispatched"));
    events.push(
      this.c.event(
        rl.id,
        "execution.created",
        {
          profile: profile.id,
          role: profile.role,
          kind: "develop",
          round: 1,
          attempt,
          worktree,
          branch,
          ...(base ? { base } : {}),
        },
        o,
      ),
      this.c.event(rl.id, "execution.state_changed", { from: null, to: "created", reason: "dispatched" }, o),
    );
    this.c.emit(rl, events);

    this.launching.add(key);
    this.bg(
      `launching ${execId} (${key}) failed unexpectedly`,
      this.setUp(rl, board, profile, file, merge).finally(() => this.launching.delete(key)),
    );
    return execId;
  }

  private stillCreated(rl: RunLog, execId: string) {
    return this.alive(rl) && rl.state.executions[execId]?.state === "created";
  }

  /** Worktree, brief, then `hc run`. A failure ends the execution; nothing here throws. */
  private async setUp(rl: RunLog, board: Board, profile: Profile, file: ExecutionFile, merge: string[]) {
    const execId = file.id;
    const key = file.ticket;
    let terminal: string | null = null;
    try {
      await ensureWorktree({
        repo: expandHome(board.repo.local_path),
        path: file.worktree,
        branch: file.branch,
        base: file.base ?? board.repo.default_branch,
        merge,
      });
      if (!this.stillCreated(rl, execId)) return;

      writeTextAtomic(this.c.home.taskFile(rl.id, execId), await this.brief(rl, board, profile, file));
      if (!this.stillCreated(rl, execId)) return;

      const adapter = this.o.adapters[profile.harness];
      if (!adapter)
        throw new AdapterError(
          `profile ${profile.id} names the harness ${profile.harness}, which Collie doesn't support`,
        );
      const launch = adapter.launch({
        profile,
        systemPrompt: systemPrompt(profile),
        firstMessage: FIRST_MESSAGE,
      });
      terminal = await this.o.hc.run({
        name: terminalName(key, execId),
        cwd: file.worktree,
        labels: { "collie.run": rl.id, "collie.execution": execId, "collie.ticket": key },
        argv: launch.argv,
        env: {
          COLLIE_HOME: this.c.home.root,
          COLLIE_INBOX: this.c.home.inbox(rl.id, execId),
          COLLIE_RUN_ID: rl.id,
          COLLIE_EXECUTION_ID: execId,
          COLLIE_TICKET: key,
          COLLIE_ROLE: profile.role,
          ...launch.env,
        },
      });
      if (!this.stillCreated(rl, execId)) {
        await this.o.hc.kill(terminal).catch(() => {});
        return;
      }
      writeJsonAtomic(this.c.home.executionFile(rl.id, execId), { ...file, terminal });
      this.c.emit(rl, [
        this.c.event(rl.id, "execution.started", { terminal }, { ticket: key, exec: execId }),
        this.c.execTo(rl, execId, "starting", "hc run issued"),
      ]);
      const m = this.mon_(execId);
      m.launchedAt = this.c.clock.now();
    } catch (e) {
      if (terminal) await this.o.hc.kill(terminal).catch(() => {});
      if (!this.stillCreated(rl, execId)) return;
      const message = (e as Error).message;
      if (e instanceof WorktreeError || e instanceof AdapterError)
        this.failExecution(rl, execId, message, "environment", false);
      else if (e instanceof HcError)
        this.failExecution(rl, execId, `hc couldn't start the agent: ${message}`, "tooling", true);
      else this.failExecution(rl, execId, `launching failed: ${message}`, "other", false);
    }
  }

  /** The task.md text: the ticket from Jira (if it can be read), and where the agent works. */
  private async brief(rl: RunLog, board: Board, profile: Profile, file: ExecutionFile): Promise<string> {
    const key = file.ticket;
    const snap = rl.run.snapshot;
    let description = "";
    let criteria = "";
    let comments = "";
    if (this.o.briefs) {
      try {
        const b = await withTimeout(this.o.briefs.brief(board.jira.cloud_id, key), this.o.briefTimeoutMs);
        description = b.description;
        criteria = b.criteria;
        comments = b.comments
          .map((c) => `- ${c.author}${c.created ? ` (${c.created})` : ""}: ${c.text}`)
          .join("\n");
      } catch (e) {
        this.c.log(`${key}: couldn't read the ticket from Jira: ${(e as Error).message}`);
        description = `(Collie couldn't read this ticket's description from Jira: ${(e as Error).message}. Work from the summary, and ask if something is unclear.)`;
      }
    }
    const summaryOf = (k: string) => board.tickets[k]?.summary ?? snap.tickets[k]?.summary ?? "";
    const blockers = (snap.tickets[file.ticket]?.blocked_by ?? []).map((b) => {
      const s = rl.state.tickets[b]?.state ?? board.tickets[b]?.jira_status ?? "unknown";
      return `${b} · ${summaryOf(b)} (${s})`;
    });
    const dependents = Object.entries(snap.tickets)
      .filter(([, t]) => t.blocked_by.includes(key))
      .map(([k]) => `${k} · ${summaryOf(k)}`);
    const stackedOn = (snap.tickets[key]?.blocked_by ?? []).find(
      (b) => rl.state.tickets[b]?.branch === file.base,
    );
    const answers = Object.values(rl.state.questions)
      .filter((q) => q.ticket === key && q.share_with_ticket && q.answer)
      .map((q) => `Q: ${q.question}\nA: ${q.answer}`)
      .join("\n\n");
    return taskBrief({
      ticket: key,
      summary: summaryOf(key),
      profileName: profile.name,
      kind: file.kind,
      round: file.round,
      attempt: file.attempt,
      description,
      criteria,
      clarifications: answers,
      comments,
      repository: `${board.repo.workspace}/${board.repo.slug}`,
      worktree: file.worktree,
      branch: file.branch,
      base: file.base ?? board.repo.default_branch,
      stacked:
        stackedOn && file.base !== board.repo.default_branch
          ? `${file.base} contains unmerged work from ${stackedOn}: ${summaryOf(stackedOn)}`
          : "",
      blockedBy: blockers.join(", "),
      blocks: dependents.join(", "),
      findings: "",
      permissions: profile.permissions,
      timeoutMin: profile.timeout_min,
    });
  }

  // --- watching

  private monitor(rl: RunLog): void {
    const now = this.c.clock.now();
    for (const [execId, e] of Object.entries(rl.state.executions)) {
      if (!LIVE_EXEC.includes(e.state) || !e.terminal) continue;
      const m = this.mon_(execId);
      if (m.busy || now < m.nextAt) continue;
      m.busy = true;
      this.bg(
        `watching ${execId}`,
        this.observe(rl, execId, e.terminal, m).finally(() => {
          m.busy = false;
          m.nextAt = this.c.clock.now() + this.o.pollMs;
        }),
      );
    }
  }

  private async observe(rl: RunLog, execId: string, terminal: string, m: Mon): Promise<void> {
    let t: HcTerminal | null;
    try {
      // While the agent works, hc wait returns the moment its turn ends; otherwise just look.
      if (m.lastState === "working") await this.o.hc.wait(terminal, this.o.waitSeconds);
      t = await this.o.hc.get(terminal);
    } catch (e) {
      // hc itself is unreachable (Herdr closed?): say so once, and try again. The agent may be fine.
      if (!m.logged) this.c.log(`can't reach hc to look at ${terminal}: ${(e as Error).message}`);
      m.logged = true;
      return;
    }
    m.logged = false;
    await this.apply(rl, execId, t, m);
  }

  /** What one look at the terminal means for the execution. */
  private async apply(rl: RunLog, execId: string, t: HcTerminal | null, m: Mon): Promise<void> {
    if (!this.alive(rl)) return;
    // A report written just before the terminal went idle or exited must be judged first.
    this.c.sweepInbox(rl, execId);
    const e = rl.state.executions[execId];
    if (!e || isExecutionFinal(e.state)) return;
    const now = this.c.clock.now();

    if (t === null || t.state === "finished") {
      const how = t ? `exited (code ${t.exit_code ?? "?"}, ${t.reason ?? "ended"})` : "is gone";
      this.failExecution(
        rl,
        execId,
        `the agent's terminal ${how} without reporting a result`,
        "tooling",
        true,
      );
      return;
    }
    const status = t.status?.state ?? null;
    m.lastState = status;

    // FINDING (real Claude Code): a fresh worktree gets a "trust this folder" dialog, and hc
    // reports the agent idle, not blocked, so it would sit at turn 0 until the start timeout.
    // DECISION: Collie doesn't answer a trust prompt for you. It shows the agent as waiting for
    // permission, so you can answer it in the terminal.
    let trustPrompt = false;
    if (
      e.state === "starting" &&
      status !== "working" &&
      t.turn < 1 &&
      now - m.launchedAt >= this.o.promptCheckMs
    ) {
      trustPrompt = await this.o.hc.screen(t.address).then(
        (text) => /trust this folder/i.test(text),
        () => false,
      );
    }
    // Blocked is hc's status, not an execution state: record it so the UI can say why.
    if (status === "blocked" || trustPrompt) {
      if (!m.blocked) {
        m.blocked = true;
        const kind = t.status?.kind === "question" ? "question" : "permission";
        const message = trustPrompt
          ? "Claude Code is asking whether to trust the worktree folder; open its terminal and choose Yes"
          : t.status?.msg;
        this.c.emit(rl, [
          this.c.event(
            rl.id,
            "execution.agent_blocked",
            { kind, ...(message ? { message } : {}) },
            { ticket: e.ticket, exec: execId },
          ),
        ]);
      }
      m.endedAt = null;
      return;
    }
    if (m.blocked || e.agent_blocked) {
      m.blocked = false;
      this.c.emit(rl, [
        this.c.event(rl.id, "execution.agent_unblocked", {}, { ticket: e.ticket, exec: execId }),
      ]);
    }

    if (e.state === "starting") {
      if (status === "working" || t.turn >= 1) {
        this.c.emit(rl, [this.c.execTo(rl, execId, "working", "the agent took its first message")]);
      } else if (now - m.launchedAt >= this.o.startTimeoutMs) {
        this.failExecution(
          rl,
          execId,
          `the agent is idle at turn 0, ${Math.round(this.o.startTimeoutMs / 1000)} s after launch: its first message never arrived`,
          "tooling",
          true,
          true,
        );
        return;
      } else return;
    }

    const profile = rl.run.snapshot.profiles[e.profile];
    const startedAt = e.started_at ? Date.parse(e.started_at) : null;
    if (profile && startedAt !== null && now - startedAt >= profile.timeout_min * 60_000) {
      this.failExecution(rl, execId, `timed out after ${profile.timeout_min} minutes`, "tooling", true, true);
      return;
    }

    const turnEnded = status === "idle" || status === "done";
    if (!turnEnded) {
      m.endedAt = null;
      return;
    }
    // Waiting for a person's answer is not a missing report.
    if (rl.state.executions[execId]?.state === "needs_input") return;

    // A message the controller owes the agent (a rejected `done`) goes out as soon as it's idle.
    const owed = m.pending[0];
    if (owed !== undefined) {
      if (await this.send(execId, t.address, owed, m)) m.pending.shift();
      return;
    }
    if (m.endedAt === null) {
      m.endedAt = now;
      return;
    }
    if (now - m.endedAt < this.o.graceMs) return;
    const nudges = e.nudges;
    if (nudges >= this.o.maxNudges) {
      this.failExecution(
        rl,
        execId,
        `no report after ${nudges} nudges: the agent's turn ended and it never ran collie done or collie fail`,
        "tooling",
        true,
      );
      return;
    }
    if ((await this.send(execId, t.address, NUDGE, m)) && this.alive(rl)) {
      this.c.emit(rl, [
        this.c.event(rl.id, "execution.nudged", { nudge: nudges + 1 }, { ticket: e.ticket, exec: execId }),
      ]);
    }
  }

  /** `hc send` when the turn has ended. True when the text was typed. */
  private async send(execId: string, terminal: string, text: string, m: Mon): Promise<boolean> {
    try {
      const r = await this.o.hc.send(terminal, text);
      if (r === "sent") {
        m.endedAt = null;
        return true;
      }
      // blocked or status_mismatch: nothing was typed, keep the message for the next turn end.
      // finished or not_found: the next look fails the execution.
      return false;
    } catch (e) {
      this.c.log(`couldn't send to ${terminal} (${execId}): ${(e as Error).message}`);
      return false;
    }
  }

  /** Ends an execution as failed. The ticket's retry or attention follows on the next pass. */
  failExecution(
    rl: RunLog,
    execId: string,
    reason: string,
    category: "tooling" | "environment" | "other",
    retryable: boolean,
    kill = false,
  ): void {
    if (!this.alive(rl)) return;
    const e = rl.state.executions[execId];
    if (!e || isExecutionFinal(e.state)) return;
    const o = { ticket: e.ticket, exec: execId };
    this.c.emit(rl, [
      this.c.event(rl.id, "execution.failed", { reason, category, retryable }, o),
      this.c.execTo(rl, execId, "failed", reason),
      ...resumeTicketIfClear(rl, execId, this.c.clock, null),
    ]);
    if (kill) this.bg(`killing ${execId}`, this.killExecutions(rl, [execId], reason));
  }

  // --- ending terminals

  /** Kills the terminals of these executions (a terminal that's gone is fine) and logs each kill. */
  async killExecutions(rl: RunLog, execIds: string[], reason: string): Promise<void> {
    await Promise.all(
      execIds.map(async (execId) => {
        const e = rl.state.executions[execId];
        const terminal = e?.terminal;
        if (!e || !terminal || this.killed.has(terminal)) return;
        this.killed.add(terminal);
        try {
          await this.o.hc.kill(terminal);
        } catch (err) {
          this.killed.delete(terminal);
          this.c.log(`couldn't kill ${terminal} (${execId}): ${(err as Error).message}`);
          return;
        }
        // Once a run has ended its log is read-only: the kill is in controller.log instead.
        if (this.alive(rl)) {
          this.c.emit(rl, [
            this.c.event(rl.id, "execution.killed", { reason }, { ticket: e.ticket, exec: execId }),
          ]);
        } else this.c.log(`killed ${terminal} (${execId}): ${reason}`);
      }),
    );
  }

  /** Every execution of a run that still has a live terminal, for run.cancel. */
  liveExecutions(rl: RunLog): string[] {
    return Object.entries(rl.state.executions)
      .filter(([, e]) => e.terminal && !isExecutionFinal(e.state))
      .map(([id]) => id);
  }

  /** Kills the terminals of an ended run's executions. */
  killRun(rl: RunLog, reason: string): void {
    const ids = Object.entries(rl.state.executions)
      .filter(([, e]) => e.terminal)
      .map(([id]) => id);
    this.bg("ending the run", this.killExecutions(rl, ids, reason));
  }

  // --- start-up

  /**
   * After recovery (protocol, "Recovery on controller start"): finish what a crash left half
   * done, using what hc says is running. Agents started with --no-parent are still there, so a
   * restart reattaches to them. Nothing is started twice, because a launch is matched to its
   * terminal by the collie.execution label.
   */
  async reconcile(): Promise<void> {
    try {
      for (const rl of [...this.c.runs.values()]) await this.reconcileRun(rl);
    } catch (e) {
      // hc is unreachable: look again as the monitors reach it. Executions aren't failed on a guess.
      this.c.log(`couldn't reconcile with hc: ${(e as Error).message}`);
    }
    this.reconciled = true;
  }

  private async reconcileRun(rl: RunLog): Promise<void> {
    for (const execId of Object.keys(rl.state.executions)) this.c.sweepInbox(rl, execId);
    const addresses = await this.o.hc.list({ "collie.run": rl.id });
    const byExec = new Map<string, HcTerminal>();
    for (const address of addresses) {
      const t = await this.o.hc.get(address);
      const execId = t?.labels["collie.execution"];
      if (t && execId) byExec.set(execId, t);
    }
    for (const [execId, e] of Object.entries(rl.state.executions)) {
      const t = byExec.get(execId);
      if (e.state === "created") {
        if (t) {
          // hc run succeeded, and the controller died before it logged the terminal.
          this.c.emit(rl, [
            this.c.event(
              rl.id,
              "execution.started",
              { terminal: t.address },
              { ticket: e.ticket, exec: execId },
            ),
            this.c.execTo(rl, execId, "starting", "found its terminal after a restart"),
          ]);
        } else {
          this.failExecution(
            rl,
            execId,
            "the controller restarted before the agent was launched",
            "tooling",
            true,
          );
        }
      } else if (isExecutionFinal(e.state) && t) {
        const ticketFinal = isTicketFinal(rl.state.tickets[e.ticket]?.state ?? "pending");
        if (e.state === "cancelled" || ticketFinal)
          await this.killExecutions(rl, [execId], "cleaned up after a restart");
      }
    }
    for (const execId of byExec.keys()) {
      if (!rl.state.executions[execId]) this.c.log(`terminal for unknown execution ${execId} left alone`);
    }
  }
}

/** DECISION: `<ticket>-<last six characters of the execution id>`, within hc's 32-character limit. */
export function terminalName(ticket: string, execId: string): string {
  const slug = ticket.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return `${slug.slice(0, 24)}-${execId.slice(-6).toLowerCase()}`;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer from Jira within ${Math.round(ms / 1000)} s`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
