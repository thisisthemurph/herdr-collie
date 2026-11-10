// Agent execution (docs/plan.md, Phase 4): dispatching ready tickets to developer agents, each in
// its own worktree and hc terminal; watching them; nudging, timing out and retrying them; and
// moving a ticket on through its workflow (Phase 5): developer, parallel reviewers, the gate,
// remediation rounds, and answers to the agents' questions. Everything here is level-triggered:
// each tick looks at the run's state and does what is missing, so a crash or a restart loses
// nothing. The only memory that isn't in events.jsonl is `Mon`, per-execution timers that can be
// rebuilt.
//
// DECISION (Phase 4, kept): a ticket that passes its gate goes through `delivering` to
// `completed` at once; delivery (push, PR, Jira) arrives in Phase 6.
import { homedir } from "node:os";
import { join } from "node:path";
import { dispatchNow, type ScheduleInput } from "@collie/board";
import type { AnyEvent, Board, ExecutionFile, ExecutionKind, Profile, Workflow } from "@collie/schema";
import { AdapterError, type Adapters } from "./adapters/index.ts";
import { reevaluateRun } from "./boards.ts";
import { type Controller, isoSeconds } from "./controller.ts";
import { type ExecView, reviewPlan, reviewRound } from "./gate.ts";
import {
  branchName,
  ensureDetachedWorktree,
  ensureWorktree,
  expandHome,
  verifyDeveloperDone,
  WorktreeError,
} from "./git.ts";
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

/** What one execution is for: who runs it, which kind of work, and in which review round. */
export type Spec = { ticket: string; kind: ExecutionKind; profile: string; round: number; attempt: number };

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
  /** Executions being set up (worktree, brief, hc run), by execution id -> ticket. */
  private readonly launching = new Map<string, string>();
  /** Agent slots left this tick (the board's max_agents), for launches that must wait for room. */
  private free = 0;
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
    if (rl.prep) {
      this.advancePrep(rl);
      this.monitor(rl);
      return;
    }
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

  /** The hc label that ties a terminal to its run, or to its board for an analyst. */
  private scopeLabel(rl: RunLog) {
    return rl.prep ? "collie.board" : "collie.run";
  }

  private alive(rl: RunLog) {
    return this.c.isLive(rl);
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
    for (const rl of this.c.allLogs()) {
      if (!rl.state.executions[execId]) continue;
      let file: ExecutionFile;
      try {
        file = readJson(rl.executionFile(execId)) as ExecutionFile;
      } catch {
        return null; // no execution.json: nothing to check against
      }
      return verifyDeveloperDone({ worktree: file.worktree, base: file.base ?? null, commits });
    }
    return null;
  }

  // --- tickets move on through their workflow

  views(rl: RunLog, key: string): ExecView[] {
    return (rl.state.tickets[key]?.executions ?? []).flatMap((id) => {
      const e = rl.state.executions[id];
      if (!e) return [];
      const r = e.result;
      return [
        {
          id,
          kind: e.kind,
          profile: e.profile,
          round: e.round,
          attempt: e.attempt,
          state: e.state,
          ...(r && "verdict" in r && r.verdict ? { verdict: r.verdict } : {}),
          ...(r && "retryable" in r ? { retryable: r.retryable } : {}),
        },
      ];
    });
  }

  private workflowOf(rl: RunLog, key: string): Workflow {
    const snap = rl.run.snapshot;
    const wf = snap.workflows[snap.tickets[key]?.workflow ?? snap.settings.workflow];
    if (!wf) throw new Error(`the run's snapshot has no workflow for ${key}`);
    return wf;
  }

  private launchingTicket(key: string): boolean {
    for (const t of this.launching.values()) if (t === key) return true;
    return false;
  }

  /** Agents running or being started: what counts against the board's max_agents. */
  private liveAgents(rl: RunLog): number {
    return (
      Object.values(rl.state.executions).filter((e) => LIVE_EXEC.includes(e.state)).length +
      this.launching.size
    );
  }

  private advanceTickets(rl: RunLog): void {
    this.free = rl.run.snapshot.settings.max_agents - this.liveAgents(rl);
    for (const key of [...rl.state.leases].sort()) {
      if (this.launchingTicket(key)) continue;
      try {
        this.advance(rl, key);
      } catch (err) {
        this.c.log(`${key}: ${(err as Error).stack ?? err}`);
      }
    }
  }

  /** One ticket, one step: the state it is in decides what is missing. */
  private advance(rl: RunLog, key: string): void {
    const t = rl.state.tickets[key];
    if (!t) return;
    const execs = this.views(rl, key);
    const last = execs.at(-1);
    const wf = this.workflowOf(rl, key);
    switch (t.state) {
      case "in_progress":
        if (!last) return;
        if (last.state === "completed") this.afterDeveloper(rl, key, wf, "developer finished");
        else if (last.state === "failed" || last.state === "cancelled") this.afterEnded(rl, key, last.id);
        return;
      case "remediating":
        if (last?.kind !== "remediate") {
          // The remediation hasn't been started (no room yet, or a crash): start it.
          if (this.free > 0) this.launchSpec(rl, key, "remediate", wf.developer, reviewRound(execs));
        } else if (last.state === "completed")
          this.afterDeveloper(rl, key, wf, `remediation round ${last.round} finished`);
        else if (last.state === "failed" || last.state === "cancelled") this.afterEnded(rl, key, last.id);
        return;
      case "reviewing":
        this.review(rl, key, wf, execs);
        return;
      default:
        return;
    }
  }

  /** The developer (or a remediation) is done: reviewers next, or straight to delivery. */
  private afterDeveloper(rl: RunLog, key: string, wf: Workflow, why: string): void {
    if (wf.reviewers.length === 0) {
      this.passGate(rl, key, why);
      return;
    }
    this.c.emit(rl, [this.c.ticketTo(rl, key, "reviewing", `${why}; reviewers next`)]);
  }

  /** The reviewing step: launch what's missing, hold the ticket for a reviewer that can't finish, decide the gate. */
  private review(rl: RunLog, key: string, wf: Workflow, execs: ExecView[]): void {
    const profiles = rl.run.snapshot.profiles;
    const plan = reviewPlan({
      execs,
      reviewers: wf.reviewers,
      maxRounds: wf.max_remediation_rounds,
      maxAttempts: (p) => profiles[p]?.max_attempts ?? 1,
    });
    if (plan.hold.length) {
      for (const e of plan.hold) this.holdTicket(rl, key, e.id, "execution_failed", this.whyEnded(rl, e.id));
      return;
    }
    const round = reviewRound(execs);
    // A retry replaces an agent that died, so it needs no free slot.
    for (const e of plan.retry) this.launchSpec(rl, key, "review", e.profile, e.round, e.attempt + 1, true);
    for (const slot of plan.launch) {
      if (this.free <= 0) break;
      this.launchSpec(rl, key, "review", slot.profile, round);
    }
    if (plan.outcome === "pass") this.passGate(rl, key, `every required reviewer approved (round ${round})`);
    else if (plan.outcome === "remediate") this.startRemediation(rl, key, round);
    else if (plan.outcome === "cap") {
      this.holdTicket(
        rl,
        key,
        null,
        "round_cap",
        `a reviewer still asks for changes after ${wf.max_remediation_rounds} remediation round${wf.max_remediation_rounds === 1 ? "" : "s"}`,
      );
    }
  }

  /**
   * Reviews done (or none needed): the ticket goes to delivery. With a code host (Phase 6) it
   * completes when its PR reaches the board's `complete_at` level (at once for `implemented`,
   * with delivery going on behind it); without one it completes now.
   */
  private passGate(rl: RunLog, key: string, why: string): void {
    // One step at a time: each transition is checked against the state the last one left.
    const delivery = this.c.delivery;
    this.c.emit(rl, [
      this.c.ticketTo(rl, key, "delivering", delivery ? `${why}; delivering` : `${why}; no code host`),
    ]);
    if (!delivery || rl.run.snapshot.settings.complete_at === "implemented")
      this.completeTicket(rl, key, why);
  }

  /** The PR is open: a run that was waiting on it may now end. */
  afterPrCreated(rl: RunLog): void {
    this.c.completeRunIfDone(rl, null);
  }

  /** `delivering → completed`: dependents may be ready, terminals are done, the run may end. */
  completeTicket(rl: RunLog, key: string, why: string): void {
    const t = rl.state.tickets[key];
    if (!t || t.state === "completed") return;
    this.c.emit(rl, [this.c.ticketTo(rl, key, "completed", why)]);
    const executions = rl.state.tickets[key]?.executions ?? [];
    // Completing a ticket may ready its dependents, and may finish the run.
    reevaluateRun(this.c, rl.run.board_id, null);
    this.bg(`ending ${key}`, this.killExecutions(rl, executions, "ticket completed"));
    this.c.completeRunIfDone(rl, null);
  }

  /** `reviewing → remediating`: the developer comes back with the open findings. */
  startRemediation(rl: RunLog, key: string, round: number): string | null {
    const wf = this.workflowOf(rl, key);
    const open = rl.state.findings.filter((f) => f.ticket === key && f.addressed_in_round === null);
    const blocking = open.filter((f) => f.blocking).length;
    this.c.emit(rl, [
      this.c.ticketTo(
        rl,
        key,
        "remediating",
        `round ${round}: ${blocking} blocking finding${blocking === 1 ? "" : "s"} (${open.length} open)`,
      ),
    ]);
    return this.launchSpec(rl, key, "remediate", wf.developer, round, 1, true);
  }

  /** Something needs a person: the ticket goes to Needs input (or stays there) with the attention entry. */
  private holdTicket(
    rl: RunLog,
    key: string,
    execId: string | null,
    kind: "execution_failed" | "round_cap",
    why: string,
  ): void {
    const t = rl.state.tickets[key];
    if (!t) return;
    const events: AnyEvent[] = [
      this.c.event(
        rl.id,
        "ticket.attention_added",
        { kind, ...(execId ? { id: execId } : {}) },
        { ticket: key },
      ),
    ];
    if (t.state !== "needs_input") events.push(this.c.ticketTo(rl, key, "needs_input", why));
    this.c.emit(rl, events);
  }

  private whyEnded(rl: RunLog, execId: string): string {
    const e = rl.state.executions[execId];
    if (!e) return "an execution ended";
    if (e.state === "cancelled") return "its execution was cancelled";
    return `its execution failed: ${e.result && "reason" in e.result ? e.result.reason : "no reason given"}`;
  }

  /** A failed or cancelled execution: retry it if the rules allow, else hold the ticket for a person. */
  private afterEnded(rl: RunLog, key: string, execId: string): void {
    const e = rl.state.executions[execId];
    if (!e) return;
    const profile = rl.run.snapshot.profiles[e.profile];
    const retry = e.state === "failed" && e.result && "retryable" in e.result && e.result.retryable;
    if (retry && profile && e.attempt < profile.max_attempts) {
      if (rl.state.status !== "running") return; // a paused run starts nothing; it retries on resume
      this.launchSpec(rl, key, e.kind, e.profile, e.round, e.attempt + 1, true);
      return;
    }
    this.holdTicket(rl, key, execId, "execution_failed", this.whyEnded(rl, execId));
  }

  /** `launch` that keeps count of the free agent slots this tick. */
  private launchSpec(
    rl: RunLog,
    key: string,
    kind: ExecutionKind,
    profile: string,
    round: number,
    attempt = 1,
    replacement = false,
  ): string | null {
    if (rl.state.status !== "running") return null; // a paused run starts nothing
    if (!replacement && this.free <= 0) return null;
    this.free -= 1;
    return this.launch(rl, { ticket: key, kind, profile, round, attempt });
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
      const launching = this.launchingTicket(key);
      tickets[key] = {
        // A ticket being set up is spoken for, whatever its state says yet.
        state: launching ? "launching" : t.state,
        blocked_by: snap.tickets[key]?.blocked_by ?? [],
      };
      if (ACTIVE_TICKET.includes(t.state) || (launching && t.state === "ready")) active += 1;
    }
    const agents = this.liveAgents(rl);
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
        const wf = this.workflowOf(rl, key);
        this.launch(rl, { ticket: key, kind: "develop", profile: wf.developer, round: 1, attempt: 1 });
      } catch (e) {
        this.c.log(`couldn't dispatch ${key}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Creates an execution (its events, execution.json), then sets the agent up in the background.
   * Returns the execution's id. Throws, creating nothing, when the run's own configuration can't
   * start one.
   */
  launch(rl: RunLog, spec: Spec): string {
    if (rl.prep) return this.launchAnalyst(rl, spec);
    const key = spec.ticket;
    const board = this.c.loadBoard(rl.run.board_id);
    const snap = rl.run.snapshot;
    const profile = snap.profiles[spec.profile];
    if (!profile) throw new Error(`the run's snapshot has no profile ${spec.profile} for ${key}`);
    const state = rl.state.tickets[key];
    if (!state) throw new Error(`${key} is not in run ${rl.id}`);

    // The branch is fixed on the ticket's first execution; retries, reviewers and remediations
    // reuse it and its worktree.
    let { branch, base } = state;
    let merge: string[] = [];
    if (!branch) {
      branch = branchName(key, board.tickets[key]?.summary ?? snap.tickets[key]?.summary ?? "");
      const finished = (snap.tickets[key]?.blocked_by ?? [])
        .filter((b) => !snap.overrides.some((o) => o.blocker === b && o.blocked === key))
        .filter((b) => rl.state.tickets[b]?.state === "completed" && rl.state.tickets[b]?.branch)
        // Phase 6: a blocker whose PR is merged is already in the default branch.
        .filter((b) => rl.state.tickets[b]?.pr?.state !== "MERGED")
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
      kind: spec.kind,
      round: spec.round,
      attempt: spec.attempt,
      worktree,
      branch,
      ...(base ? { base } : {}),
      terminal: null,
      created_at: isoSeconds(now),
    };
    // execution.json goes down before the event that names the execution.
    writeJsonAtomic(rl.executionFile(execId), file);
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
          kind: spec.kind,
          round: spec.round,
          attempt: spec.attempt,
          worktree,
          branch,
          ...(base ? { base } : {}),
        },
        o,
      ),
      this.c.event(rl.id, "execution.state_changed", { from: null, to: "created", reason: "dispatched" }, o),
    );
    this.c.emit(rl, events);

    this.launching.set(execId, key);
    this.bg(
      `launching ${execId} (${key}) failed unexpectedly`,
      this.setUp(rl, board, profile, file, merge).finally(() => this.launching.delete(execId)),
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
      if (file.kind === "analyse")
        await ensureDetachedWorktree({
          repo: expandHome(board.repo.local_path),
          path: file.worktree,
          ref: file.branch,
        });
      else {
        const repo = expandHome(board.repo.local_path);
        const base = file.base ?? board.repo.default_branch;
        // A blocker's PR was merged: the default branch on the host has its work, the local one
        // may not, so the branch is cut from a fresh fetch of it.
        const merged = (rl.run.snapshot.tickets[key]?.blocked_by ?? []).some(
          (b) => rl.state.tickets[b]?.pr?.state === "MERGED",
        );
        const startPoint =
          merged && base === board.repo.default_branch && this.c.delivery
            ? await this.c.delivery.o.remote.fetchBranch(repo, board.repo, base)
            : undefined;
        await ensureWorktree({
          repo,
          path: file.worktree,
          branch: file.branch,
          base,
          startPoint,
          merge,
        });
      }
      if (!this.stillCreated(rl, execId)) return;

      writeTextAtomic(rl.taskFile(execId), await this.brief(rl, board, profile, file));
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
        labels: { [this.scopeLabel(rl)]: rl.id, "collie.execution": execId, "collie.ticket": key },
        argv: launch.argv,
        env: {
          COLLIE_HOME: this.c.home.root,
          COLLIE_INBOX: rl.inboxFile(execId),
          COLLIE_RUN_ID: rl.prep ? "" : rl.id,
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
      writeJsonAtomic(rl.executionFile(execId), { ...file, terminal });
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
    // An analyst works from the board as it is now; a run's agents from the run's snapshot.
    const snap = rl.prep ? { ...rl.run.snapshot, tickets: board.tickets } : rl.run.snapshot;
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
    // Answers shared with the ticket, from its preparation and from this run's earlier rounds.
    const answers = [
      ...Object.values(this.c.preps.get(board.id)?.state.questions ?? {}),
      ...(rl.prep ? [] : Object.values(rl.state.questions)),
    ]
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
      findingsHeading: file.kind === "review" ? "Findings from the last round" : "Findings to address",
      findings: this.findingsText(rl, file),
      permissions: profile.permissions,
      timeoutMin: profile.timeout_min,
    });
  }

  /**
   * The findings section of a brief. A remediation sees the ticket's open findings; a reviewer in
   * round 2 or later sees the last round's, to check they were addressed. Blocking ones first;
   * the full text and suggestions are in `collie show findings`.
   */
  private findingsText(rl: RunLog, file: ExecutionFile): string {
    const mine = rl.state.findings.filter((f) => f.ticket === file.ticket);
    const list =
      file.kind === "remediate"
        ? mine.filter((f) => f.addressed_in_round === null)
        : file.kind === "review" && file.round > 1
          ? mine.filter((f) => f.round === file.round - 1)
          : [];
    const rank = ["critical", "high", "medium", "low", "info"];
    return [...list]
      .sort(
        (a, b) =>
          Number(b.blocking) - Number(a.blocking) || rank.indexOf(a.severity) - rank.indexOf(b.severity),
      )
      .map(
        (f) =>
          `- [${f.severity}${f.blocking ? ", blocking" : ""}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`,
      )
      .concat(
        file.kind === "remediate" && list.length
          ? ["", "Run `collie show findings` for the full text and suggestions."]
          : [],
      )
      .join("\n");
  }

  // --- board preparation: the requirements analyst (Phase 5)

  /**
   * Starts an analyst on a ticket. It reads the code in a detached, read-only worktree of the
   * board's default branch, and its brief is the ticket itself. Its log is the board's preparation
   * log, not a run's.
   */
  private launchAnalyst(rl: RunLog, spec: Spec): string {
    const key = spec.ticket;
    const board = this.c.loadBoard(rl.run.board_id);
    const profile = rl.run.snapshot.profiles[spec.profile];
    if (!profile) throw new Error(`there is no analyst profile ${spec.profile}`);
    const branch = board.repo.default_branch;
    const worktree = join(this.o.worktreeRoot, board.repo.slug, `prep-${key.toLowerCase()}`);
    const execId = this.c.clock.id();
    const file: ExecutionFile = {
      v: 1,
      id: execId,
      run_id: null,
      ticket: key,
      profile: profile.id,
      role: profile.role,
      kind: "analyse",
      round: 1,
      attempt: spec.attempt,
      worktree,
      branch,
      base: branch,
      terminal: null,
      created_at: isoSeconds(this.c.clock.now()),
    };
    writeJsonAtomic(rl.executionFile(execId), file);
    const o = { ticket: key, exec: execId };
    this.c.emit(rl, [
      this.c.event(
        rl.id,
        "execution.created",
        {
          profile: profile.id,
          role: profile.role,
          kind: "analyse",
          round: 1,
          attempt: spec.attempt,
          worktree,
          branch,
          base: branch,
        },
        o,
      ),
      this.c.event(
        rl.id,
        "execution.state_changed",
        { from: null, to: "created", reason: "investigating" },
        o,
      ),
    ]);
    this.launching.set(execId, key);
    this.bg(
      `launching analyst ${execId} (${key}) failed unexpectedly`,
      this.setUp(rl, board, profile, file, []).finally(() => this.launching.delete(execId)),
    );
    return execId;
  }

  /** Where each investigated ticket stands, and what it means for the board's `preparation`. */
  private advancePrep(rl: RunLog): void {
    for (const key of Object.keys(rl.state.tickets).sort()) {
      if (this.launchingTicket(key)) continue;
      try {
        this.advanceAnalysis(rl, key);
      } catch (err) {
        this.c.log(`analysis of ${key}: ${(err as Error).stack ?? err}`);
      }
    }
  }

  private advanceAnalysis(rl: RunLog, key: string): void {
    const execs = this.views(rl, key).filter((e) => e.kind === "analyse");
    const last = execs.at(-1);
    if (!last) return;
    const board = this.c.loadBoard(rl.run.board_id);
    const now = board.tickets[key]?.preparation;
    // Only the analyst's own states are moved: a person who excluded the ticket meanwhile wins.
    const owned = now === "investigating" || now === "needs_input";
    if (last.state === "completed") {
      if (owned) this.setPreparation(rl, key, "ready");
      return;
    }
    if (last.state === "failed" || last.state === "cancelled") {
      const profile = rl.run.snapshot.profiles[last.profile];
      if (last.state === "failed" && last.retryable && profile && last.attempt < profile.max_attempts) {
        this.launch(rl, {
          ticket: key,
          kind: "analyse",
          profile: last.profile,
          round: 1,
          attempt: last.attempt + 1,
        });
      } else if (owned) {
        this.setPreparation(rl, key, "unreviewed");
        this.bg(`ending the analyst of ${key}`, this.killExecutions(rl, [last.id], "analysis ended"));
      }
      return;
    }
    const asking = Object.values(rl.state.questions).some(
      (q) => q.execution_id === last.id && q.state === "open",
    );
    const want = asking ? "needs_input" : "investigating";
    if (owned && now !== want) this.setPreparation(rl, key, want);
  }

  private setPreparation(
    rl: RunLog,
    key: string,
    to: "investigating" | "needs_input" | "ready" | "unreviewed",
  ): void {
    const board = this.c.loadBoard(rl.run.board_id);
    const t = board.tickets[key];
    if (!t || t.preparation === to) return;
    t.preparation = to;
    this.c.saveBoard(board);
    if (to === "ready") {
      // A ready ticket may now be dispatched in the board's run; a finished analyst's terminal ends.
      reevaluateRun(this.c, board.id, null);
      const last = this.views(rl, key).at(-1);
      if (last) this.bg(`ending the analyst of ${key}`, this.killExecutions(rl, [last.id], "analysis done"));
    }
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
      // The time a person took to answer (the trust dialog) doesn't count against the start timeout.
      if (e.state === "starting") m.launchedAt = now;
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
    // A person's answer goes to the agent the moment its turn has ended (protocol, "How an
    // answer reaches an agent").
    if (await this.deliverAnswer(rl, execId, t.address, m)) return;
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

  /**
   * Types the oldest answered question's answer into the agent, then records it as delivered and
   * puts the execution (and, once nothing else holds it, the ticket) back to work. True when an
   * answer was sent.
   */
  private async deliverAnswer(rl: RunLog, execId: string, terminal: string, m: Mon): Promise<boolean> {
    const qid = Object.keys(rl.state.questions)
      .sort()
      .find((id) => {
        const q = rl.state.questions[id];
        return q?.execution_id === execId && q.state === "answered";
      });
    const q = qid ? rl.state.questions[qid] : undefined;
    if (!qid || !q?.answer) return false;
    // DECISION: an answer is typed as one line; a newline would submit the message early.
    const text = `[collie] Answer to your question ${qid.slice(-6)}: ${q.answer.replace(/\s+/g, " ").trim()} Continue the task.`;
    if (!(await this.send(execId, terminal, text, m)) || !this.alive(rl)) return false;
    const e = rl.state.executions[execId];
    const t = rl.state.tickets[q.ticket];
    if (!e || !t) return true;
    const o = { ticket: q.ticket, exec: execId };
    const events: AnyEvent[] = [this.c.event(rl.id, "question.delivered", { question_id: qid }, o)];
    if (e.state === "needs_input")
      events.push(this.c.execTo(rl, execId, "working", `answer ${qid.slice(-6)} delivered`));
    const remaining = t.attention.filter((a) => !(a.kind === "question" && a.id === qid));
    if (t.state === "needs_input" && t.resume_state && remaining.length === 0)
      events.push(this.c.ticketTo(rl, q.ticket, t.resume_state, "attention cleared"));
    this.c.emit(rl, events);
    return true;
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
      for (const rl of this.c.allLogs()) await this.reconcileRun(rl);
    } catch (e) {
      // hc is unreachable: look again as the monitors reach it. Executions aren't failed on a guess.
      this.c.log(`couldn't reconcile with hc: ${(e as Error).message}`);
    }
    this.reconciled = true;
  }

  private async reconcileRun(rl: RunLog): Promise<void> {
    for (const execId of Object.keys(rl.state.executions)) this.c.sweepInbox(rl, execId);
    const addresses = await this.o.hc.list({ [this.scopeLabel(rl)]: rl.id });
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
        // An analyst's terminal ends with its analysis; a run's with its ticket.
        if (e.state === "cancelled" || ticketFinal || rl.prep)
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
