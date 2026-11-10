// Delivery (docs/plan.md, Phase 6; docs/protocol.md, "Phase 6 rules the controller applies"):
// a ticket that passed its gate is pushed and opened as a PR, its PR is tracked until it is merged
// or declined, stacked PRs follow their parent, and Jira hears about progress.
//
// Everything is decided from the run's state each tick (level-triggered), so a restart picks up
// where a crash left off. Work that talks to Bitbucket, git or Jira runs in the background, one
// piece per ticket at a time, and writes its result as events when it finishes.
import { homedir } from "node:os";
import { join } from "node:path";
import type { Board, StateFile } from "@collie/schema";
import type { CodeHost, PrInfo, Repo } from "./bitbucket.ts";
import { CommandError, type Controller } from "./controller.ts";
import { expandHome, verifyDeveloperDone } from "./git.ts";
import type { JiraWriteback } from "./jira.ts";
import { checkGitVersion, isAncestor, mergeConflicts, type Remote } from "./remote.ts";
import type { RunLog } from "./runlog.ts";

export type DeliveryOptions = {
  host: CodeHost;
  remote: Remote;
  jira?: JiraWriteback | null;
  worktreeRoot?: string;
  /** Waits before a delivery step's second and third tries. */
  backoffMs?: number[];
  /** How often an open PR is polled. */
  pollMs?: number;
  /** How long to wait before trying a failed Jira write again; it gives up after three tries. */
  jiraRetryMs?: number;
  /** Skips the git version check on run.start (tests that don't need merge-tree). */
  skipGitCheck?: boolean;
};

type Ticket = StateFile["tickets"][string];
const MAX_TRIES = 3;

export class Delivery {
  readonly o: Required<Omit<DeliveryOptions, "jira">> & { jira: JiraWriteback | null };
  /** Work in flight, by a key naming what it does for which ticket, so no two overlap. */
  private readonly busy = new Set<string>();
  private readonly background = new Set<Promise<unknown>>();
  /** Failed delivery steps: tries so far and when the next is allowed. */
  private readonly tries = new Map<string, { n: number; next: number }>();
  private readonly polled = new Map<string, number>();
  private readonly jiraTries = new Map<string, { n: number; next: number }>();

  constructor(
    private readonly c: Controller,
    options: DeliveryOptions,
  ) {
    this.o = {
      worktreeRoot: join(homedir(), ".herdr", "worktrees"),
      backoffMs: [2_000, 10_000],
      pollMs: 30_000,
      jiraRetryMs: 30_000,
      skipGitCheck: false,
      jira: null,
      ...options,
    };
  }

  /** Resolves when no background work is in flight. */
  async drain(): Promise<void> {
    while (this.background.size) await Promise.all([...this.background]);
  }

  private bg(what: string, key: string, work: () => Promise<unknown>): void {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    const p = work()
      .catch((e) => this.c.log(`${what}: ${(e as Error).stack ?? e}`))
      .finally(() => {
        this.busy.delete(key);
        this.background.delete(p);
      });
    this.background.add(p);
  }

  /** `run.start`: the token can open PRs, and git can check for conflicts. Throws naming what's wrong. */
  async preflight(board: Board): Promise<void> {
    await this.o.host.checkAccess(board.repo);
    if (!this.o.skipGitCheck) {
      const why = await checkGitVersion();
      if (why) throw new CommandError("upstream_error", why);
    }
  }

  /** A person asked for the retry of a held delivery. */
  reset(runId: string, ticket: string): void {
    this.tries.delete(`${runId}:${ticket}`);
  }

  /** True while a ticket of the run still has a PR to open: the run mustn't end yet. */
  pending(rl: RunLog): boolean {
    return rl.state.leases.some((k) => this.needsPr(rl.state.tickets[k]));
  }

  private needsPr(t: Ticket | undefined): boolean {
    return !!t && (t.state === "delivering" || t.state === "completed") && !t.pr && !!t.branch;
  }

  // --- the pass

  /** Called every tick for each live run and each ended run with open PRs. */
  tick(rl: RunLog): void {
    if (rl.prep) return;
    const board = this.board(rl);
    if (!board) return;
    const settings = rl.run.snapshot.settings;
    const running = rl.state.status === "running";
    for (const [key, t] of Object.entries(rl.state.tickets)) {
      if (running && this.needsPr(t) && !t.attention.some((a) => a.kind === "delivery_error")) {
        this.deliver(rl, board, key);
      }
      if (t.pr && t.state === "delivering") this.settle(rl, key, t, settings.complete_at);
      if (t.pr?.state === "OPEN") this.track(rl, board, key);
      this.upkeep(rl, board, key, t, settings.pr_draft_policy);
      if (this.o.jira) this.writeBack(rl, board, key, t);
    }
  }

  private board(rl: RunLog): Board | null {
    try {
      return this.c.loadBoard(rl.run.board_id);
    } catch {
      return null;
    }
  }

  private repoPath = (board: Board) => expandHome(board.repo.local_path);

  // --- opening the PR

  private deliver(rl: RunLog, board: Board, key: string): void {
    const t = rl.state.tickets[key];
    if (!t?.branch) return;
    const tk = `${rl.id}:${key}`;
    const due = this.tries.get(tk);
    if (due && this.c.clock.now() < due.next) return;
    // A stacked ticket's PR can only target its parent's branch once the parent's PR has put it
    // on the host.
    const parent = this.parentOf(rl, key);
    if (parent && !rl.state.tickets[parent]?.pr) return;
    this.bg(`delivering ${key}`, `deliver:${tk}`, async () => {
      try {
        await this.openPr(rl, board, key, t.branch as string, parent);
        this.tries.delete(tk);
      } catch (e) {
        this.failed(rl, key, "pr", (e as Error).message, tk);
      }
    });
  }

  /** The ticket whose branch this ticket is stacked on, if it is stacked. */
  private parentOf(rl: RunLog, key: string): string | null {
    const base = rl.state.tickets[key]?.base;
    if (!base) return null;
    return (
      Object.entries(rl.state.tickets).find(
        ([k, t]) => k !== key && t.branch === base && t.state !== "cancelled",
      )?.[0] ?? null
    );
  }

  private async openPr(rl: RunLog, board: Board, key: string, branch: string, parent: string | null) {
    const base = rl.state.tickets[key]?.base ?? board.repo.default_branch;
    const destination = parent ? base : board.repo.default_branch;
    const worktree = join(this.o.worktreeRoot, board.repo.slug, branch);
    const bad = verifyDeveloperDone({ worktree, base, commits: [] });
    if (bad) throw new Error(`the branch isn't ready to push: ${bad}`);
    await this.o.remote.push(this.repoPath(board), board.repo, branch);

    const draft =
      rl.run.snapshot.settings.pr_draft_policy === "always_draft" ||
      destination !== board.repo.default_branch;
    const pr =
      (await this.o.host.findOpenPr(board.repo, branch)) ??
      (await this.o.host.createPr(board.repo, {
        title: `${key}: ${rl.run.snapshot.tickets[key]?.summary ?? board.tickets[key]?.summary ?? ""}`.trim(),
        description: this.describe(rl, board, key),
        source: branch,
        destination,
        draft,
      }));
    this.c.emit(rl, [
      this.c.event(
        rl.id,
        "pr.created",
        { number: pr.number, url: pr.url, base: pr.destination, head: pr.source, draft: pr.draft },
        { ticket: key },
      ),
    ]);
    this.c.agents?.afterPrCreated(rl);
  }

  /** The PR description: the ticket, and what the reviewers found. */
  private describe(rl: RunLog, board: Board, key: string): string {
    const summary = rl.run.snapshot.tickets[key]?.summary ?? "";
    const findings = rl.state.findings.filter((f) => f.ticket === key);
    const rounds = new Set(findings.map((f) => f.round)).size;
    const open = findings.filter((f) => f.addressed_in_round === null);
    const lines = [
      `Jira: https://${board.jira.site}/browse/${key}`,
      "",
      summary,
      "",
      "### Review findings",
      findings.length === 0
        ? "No findings."
        : `${findings.length} finding${findings.length === 1 ? "" : "s"} over ${rounds} review round${rounds === 1 ? "" : "s"}; ${open.length} still open.`,
      ...open.map(
        (f) =>
          `- **${f.severity}**${f.blocking ? " (blocking)" : ""}: ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`,
      ),
      "",
      "Opened by Herdr Collie.",
    ];
    return lines.join("\n");
  }

  /** A delivery step failed: backed off up to three tries, then the ticket waits for a person. */
  private failed(
    rl: RunLog,
    key: string,
    step: "push" | "pr" | "retarget" | "ready",
    reason: string,
    tk: string,
  ) {
    const n = (this.tries.get(tk)?.n ?? 0) + 1;
    const final = n >= MAX_TRIES;
    const wait = this.o.backoffMs[Math.min(n - 1, this.o.backoffMs.length - 1)] ?? 0;
    this.tries.set(tk, { n, next: this.c.clock.now() + wait });
    this.c.log(`${key}: delivery step ${step} failed (try ${n}): ${reason}`);
    const t = rl.state.tickets[key];
    const o = { ticket: key };
    const events = [this.c.event(rl.id, "delivery.failed", { step, reason, attempt: n, final }, o)];
    if (final && t) {
      events.push(this.c.event(rl.id, "ticket.attention_added", { kind: "delivery_error" }, o));
      if (t.state === "delivering")
        events.push(this.c.ticketTo(rl, key, "needs_input", `delivery failed: ${reason}`));
    }
    this.c.emit(rl, events);
  }

  // --- completion levels

  /** A `delivering` ticket with a PR completes once the board's `complete_at` level is reached. */
  private settle(rl: RunLog, key: string, t: Ticket, level: Board["settings"]["complete_at"]): void {
    const pr = t.pr;
    if (!pr) return;
    const reached =
      level === "implemented" || level === "pr_created"
        ? true
        : level === "pr_approved"
          ? pr.approvals >= 1 || pr.state === "MERGED"
          : pr.state === "MERGED";
    if (reached) this.c.agents?.completeTicket(rl, key, `the PR reached ${level.replace("_", " ")}`);
  }

  // --- tracking an open PR

  private track(rl: RunLog, board: Board, key: string): void {
    const tk = `${rl.id}:${key}`;
    const last = this.polled.get(tk);
    if (last !== undefined && this.c.clock.now() - last < this.o.pollMs) return;
    this.polled.set(tk, this.c.clock.now());
    this.bg(`tracking ${key}`, `track:${tk}`, async () => {
      const t = rl.state.tickets[key];
      if (!t?.pr) return;
      try {
        const before = t.pr.destination;
        const info = await this.o.host.getPr(board.repo, t.pr.id);
        // A retarget that landed while this request was out makes its destination stale.
        this.recordPr(rl, key, info, rl.state.tickets[key]?.pr?.destination === before);
      } catch (e) {
        this.c.log(`${key}: couldn't read PR #${t.pr.id}: ${(e as Error).message}`);
        return;
      }
      if (rl.state.tickets[key]?.pr?.state === "OPEN") await this.checkConflicts(rl, board, key);
    });
  }

  /** `pr.updated` for what changed since the last poll. */
  private recordPr(rl: RunLog, key: string, info: PrInfo, destinationIsCurrent = true): void {
    const pr = rl.state.tickets[key]?.pr;
    if (!pr) return;
    const change: Record<string, unknown> = {};
    if (info.state !== pr.state) change.state = info.state;
    if (info.draft !== pr.draft) change.draft = info.draft;
    if (destinationIsCurrent && info.destination !== pr.destination) change.base = info.destination;
    if (info.approvals !== pr.approvals) change.approvals = info.approvals;
    if (Object.keys(change).length === 0) return;
    this.c.emit(rl, [this.c.event(rl.id, "pr.updated", { number: pr.id, ...change }, { ticket: key })]);
  }

  /** Fetches the destination and asks git whether the PR still merges cleanly. */
  private async checkConflicts(rl: RunLog, board: Board, key: string): Promise<void> {
    const pr = rl.state.tickets[key]?.pr;
    if (!pr) return;
    // `pr` is live state that the reducer changes in place, so keep what this check is about.
    const { id, source, destination } = pr;
    try {
      const dest = await this.o.remote.fetchBranch(this.repoPath(board), board.repo, destination);
      const r = await mergeConflicts(this.repoPath(board), dest, source);
      const now = rl.state.tickets[key]?.pr;
      // The destination may have been retargeted while git ran; that result is about the old one.
      if (!now || now.destination !== destination) return;
      if (now && (now.conflicted !== r.conflicted || now.conflict_checked_at === null)) {
        this.c.emit(rl, [
          this.c.event(
            rl.id,
            "pr.conflict_checked",
            { number: id, conflicted: r.conflicted, paths: r.paths },
            { ticket: key },
          ),
        ]);
      }
      if (now.needs_rebase && (await isAncestor(this.repoPath(board), dest, source))) {
        if (rl.state.tickets[key]?.pr?.destination !== destination) return;
        this.c.emit(rl, [
          this.c.event(rl.id, "pr.updated", { number: id, needs_rebase: false }, { ticket: key }),
        ]);
      }
    } catch (e) {
      this.c.log(`${key}: couldn't check PR #${pr.id} for conflicts: ${(e as Error).message}`);
    }
  }

  // --- stacks

  /**
   * An open PR aimed at the branch of a PR that has been merged is retargeted to the default
   * branch and flagged for rebase; under "draft when stacked" it is also made ready. Derived from
   * state, so it repeats until it has worked.
   */
  private upkeep(
    rl: RunLog,
    board: Board,
    key: string,
    t: Ticket,
    policy: Board["settings"]["pr_draft_policy"],
  ): void {
    const pr = t.pr;
    if (pr?.state !== "OPEN" || pr.destination === board.repo.default_branch) return;
    const parent = Object.values(rl.state.tickets).find(
      (p) => p.pr?.state === "MERGED" && p.pr.source === pr.destination,
    );
    if (!parent) return;
    const ready = policy === "draft_when_stacked" && pr.draft;
    const tk = `${rl.id}:${key}`;
    this.bg(`retargeting ${key}`, `retarget:${tk}`, async () => {
      try {
        const info = await this.o.host.updatePr(board.repo, pr.id, {
          destination: board.repo.default_branch,
          ...(ready ? { draft: false } : {}),
        });
        this.c.emit(rl, [
          this.c.event(
            rl.id,
            "pr.updated",
            {
              number: pr.id,
              base: info.destination,
              draft: info.draft,
              needs_rebase: true,
            },
            { ticket: key },
          ),
        ]);
      } catch (e) {
        this.c.log(`${key}: couldn't retarget PR #${pr.id}: ${(e as Error).message}`);
      }
    });
  }

  /** `pr.mark_ready`: publishes a draft PR. */
  async markReady(rl: RunLog, key: string): Promise<void> {
    const t = rl.state.tickets[key];
    if (!t) throw new CommandError("not_found", `${key} is not in run ${rl.id}`);
    if (!t.pr) throw new CommandError("invalid_state", `${key} has no pull request yet`);
    if (t.pr.state !== "OPEN")
      throw new CommandError("invalid_state", `${key}'s PR #${t.pr.id} is ${t.pr.state}`);
    if (!t.pr.draft)
      throw new CommandError("invalid_state", `${key}'s PR #${t.pr.id} is already ready for review`);
    const board = this.c.loadBoard(rl.run.board_id);
    const info = await this.o.host.updatePr(board.repo, t.pr.id, { draft: false });
    this.c.emit(rl, [
      this.c.event(
        rl.id,
        "pr.updated",
        { number: t.pr.id, draft: info.draft },
        { ticket: key, source: "human" },
      ),
    ]);
  }

  /** Whether any PR of the run is still open (the run's log stays loaded and written to). */
  hasOpenPrs(rl: RunLog): boolean {
    return Object.values(rl.state.tickets).some((t) => t.pr?.state === "OPEN");
  }

  // --- Jira

  /** Transitions and a comment per the board's policy; each point is done once (`jira_steps`). */
  private writeBack(rl: RunLog, board: Board, key: string, t: Ticket): void {
    const jira = this.o.jira;
    if (!jira) return;
    const wb = rl.run.snapshot.settings.jira_writeback;
    const done = t.jira_steps ?? [];
    const step = !done.includes("start") && t.executions.length > 0 && wb.on_start ? "start" : null;
    const prStep = !done.includes("pr") && t.pr && (wb.on_pr || wb.comment) ? "pr" : null;
    const which = step ?? prStep;
    if (!which) return;
    const tk = `${rl.id}:${key}:${which}`;
    const tried = this.jiraTries.get(tk);
    if (tried && (tried.n >= MAX_TRIES || this.c.clock.now() < tried.next)) return;
    this.bg(`Jira write-back for ${key}`, `jira:${tk}`, async () => {
      try {
        const target = which === "start" ? wb.on_start : wb.on_pr;
        const events = [];
        const o = { ticket: key };
        let transition: string | undefined;
        if (target) {
          const options = await jira.transitions(board.jira.cloud_id, key);
          const pick =
            options.find((x) => x.name === target && x.to === target) ??
            options.find((x) => x.to.toLowerCase() === target.toLowerCase());
          if (pick) {
            await jira.transition(board.jira.cloud_id, key, pick.id);
            transition = pick.to;
          } else {
            events.push(
              this.c.event(
                rl.id,
                "jira.writeback_skipped",
                { target, available: [...new Set(options.map((x) => x.to).filter(Boolean))], step: which },
                o,
              ),
            );
          }
        }
        const comment = which === "pr" && wb.comment && t.pr;
        if (comment) {
          await jira.comment(
            board.jira.cloud_id,
            key,
            `Herdr Collie opened pull request #${t.pr?.id}: ${t.pr?.url}`,
          );
        }
        if (transition || comment) {
          events.unshift(
            this.c.event(
              rl.id,
              "jira.updated",
              { ...(transition ? { transition } : {}), ...(comment ? { comment: true } : {}), step: which },
              o,
            ),
          );
        }
        this.jiraTries.delete(tk);
        this.c.emit(rl, events);
      } catch (e) {
        const n = (tried?.n ?? 0) + 1;
        this.jiraTries.set(tk, { n, next: this.c.clock.now() + this.o.jiraRetryMs });
        this.c.log(`${key}: Jira write-back (${which}) failed, try ${n}: ${(e as Error).message}`);
      }
    });
  }
}

export type { Repo };
