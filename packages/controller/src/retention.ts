// Retention (docs/protocol.md, "Retention"): the prune pass that runs on start and then daily.
// Run records stay; the heavy or duplicated things go, by fixed rules, and work that isn't safe
// on the remote is never removed.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Board, RunFile } from "@collie/schema";
import type { Controller } from "./controller.ts";
import { expandHome, git } from "./git.ts";
import type { Hc } from "./hc.ts";
import { readJson } from "./home.ts";
import { destRef, isAncestor, type Remote } from "./remote.ts";
import { RunLog } from "./runlog.ts";

const DAY = 86_400_000;

export type RetentionOptions = {
  /** What the remote is asked about a branch, to know whether a worktree's commits are pushed. */
  remote: Remote;
  /** Closes terminals that outlived their ticket. Without it, terminals are left alone. */
  hc?: Pick<Hc, "get" | "kill">;
  /** Days after a run ends that its inboxes and attachments go. Default 90. */
  inboxDays?: number;
  /** Days after a cancelled ticket that its worktree goes. Default 7. */
  worktreeDays?: number;
  /** Time between passes. Default one day. */
  intervalMs?: number;
};

export type PassReport = {
  pruned: string[];
  removed: string[];
  kept: { worktree: string; reason: string }[];
  terminals: string[];
};

export class Retention {
  private next = 0;
  private busy: Promise<unknown> | null = null;
  /** worktree -> the reason last logged, so a daily pass doesn't repeat itself. */
  private readonly kept = new Map<string, string>();

  constructor(
    private readonly c: Controller,
    private readonly o: RetentionOptions,
  ) {}

  /** Called every controller tick: starts a pass when one is due. */
  tick(): void {
    const now = this.c.clock.now();
    if (this.busy || now < this.next) return;
    this.next = now + (this.o.intervalMs ?? DAY);
    this.busy = this.pass()
      .catch((e) => this.c.log(`retention pass failed: ${(e as Error).stack ?? e}`))
      .finally(() => {
        this.busy = null;
      });
  }

  async drain(): Promise<void> {
    await this.busy;
  }

  /** One pass over every run on disk. */
  async pass(): Promise<PassReport> {
    const report: PassReport = { pruned: [], removed: [], kept: [], terminals: [] };
    const now = this.c.clock.now();
    for (const id of readdirSync(this.c.home.runs).sort()) {
      if (!existsSync(this.c.home.runFile(id))) continue;
      try {
        await this.run(id, now, report);
      } catch (e) {
        this.c.log(`retention: run ${id}: ${(e as Error).message}`);
      }
    }
    if (report.pruned.length || report.removed.length)
      this.c.log(
        `retention: pruned ${report.pruned.length} files, removed ${report.removed.length} worktrees`,
      );
    return report;
  }

  private async run(id: string, now: number, report: PassReport): Promise<void> {
    const file = readJson(this.c.home.runFile(id)) as RunFile;
    const live = this.c.runs.get(id) ?? this.c.tracked.get(id);
    const rl = live ?? RunLog.load(this.c.home, id, () => {});
    const ended = rl.state.status === "completed" || rl.state.status === "cancelled";
    const endedAt = ended && file.ended_at ? Date.parse(file.ended_at) : null;

    // Inboxes and attachments, 90 days after the run ends.
    if (endedAt !== null && now - endedAt >= (this.o.inboxDays ?? 90) * DAY) {
      const paths: string[] = [];
      for (const execId of Object.keys(rl.state.executions)) {
        for (const name of ["inbox.jsonl", "attachments"]) {
          const p = join(this.c.home.execDir(id, execId), name);
          if (!existsSync(p)) continue;
          rmSync(p, { recursive: true, force: true });
          paths.push(`executions/${execId}/${name}`);
        }
      }
      if (paths.length) {
        this.c.emit(rl, [this.c.event(id, "retention.pruned", { paths }, { source: "controller" })]);
        report.pruned.push(...paths);
      }
    }

    await this.worktrees(rl, file, now, endedAt, report);
    await this.terminals(rl, report);
    if (!live) rl.flush(now);
  }

  // --- worktrees

  private async worktrees(
    rl: RunLog,
    file: RunFile,
    now: number,
    endedAt: number | null,
    report: PassReport,
  ): Promise<void> {
    const board = this.board(file.board_id);
    if (!board) return;
    const repo = expandHome(board.repo.local_path);
    const leased = new Set([...this.c.runs.values()].flatMap((r) => (r.id === rl.id ? [] : r.state.leases)));
    for (const [key, t] of Object.entries(rl.state.tickets)) {
      const worktrees = new Set<string>();
      for (const execId of t.executions) {
        try {
          const e = readJson(rl.executionFile(execId)) as { worktree?: string };
          if (e.worktree) worktrees.add(e.worktree);
        } catch {}
      }
      for (const path of worktrees) {
        if (!existsSync(path)) {
          this.kept.delete(path);
          continue;
        }
        const why = this.keepReason(rl, key, t, leased, now, endedAt);
        if (why === "active") continue;
        const reason = why ?? (await this.unsafe(repo, board, path, t.branch ?? t.pr?.source ?? ""));
        if (reason) {
          if (this.kept.get(path) !== reason) {
            this.kept.set(path, reason);
            this.c.emit(rl, [
              this.c.event(rl.id, "worktree.kept", { worktree: path, reason }, { ticket: key }),
            ]);
          }
          report.kept.push({ worktree: path, reason });
          continue;
        }
        const r = await git(repo, ["worktree", "remove", path]);
        if (r.code !== 0) {
          // Refused by git itself (a change appeared since the check): treat it as kept.
          const reason = `git refused to remove it: ${r.stderr.split("\n")[0]}`;
          if (this.kept.get(path) !== reason) {
            this.kept.set(path, reason);
            this.c.emit(rl, [
              this.c.event(rl.id, "worktree.kept", { worktree: path, reason }, { ticket: key }),
            ]);
          }
          report.kept.push({ worktree: path, reason });
          continue;
        }
        this.kept.delete(path);
        this.c.emit(rl, [this.c.event(rl.id, "worktree.removed", { worktree: path }, { ticket: key })]);
        report.removed.push(path);
      }
    }
  }

  /**
   * Whether the ticket's worktree must stay for now: "active" (say nothing), a reason to log, or
   * null when the rules allow removing it (the safety check still follows).
   */
  private keepReason(
    rl: RunLog,
    key: string,
    t: RunLog["state"]["tickets"][string],
    leased: Set<string>,
    now: number,
    endedAt: number | null,
  ): string | null {
    if (leased.has(key)) return "active";
    const final = t.state === "completed" || t.state === "cancelled";
    if (!final)
      return rl.state.status === "running" || rl.state.status === "paused"
        ? "active"
        : "the ticket never finished";
    if (t.pr?.state === "OPEN") return "its PR is still open";
    if (t.pr?.state === "MERGED" || t.pr?.state === "DECLINED") return null;
    // No PR was opened: wait out the cancellation window.
    const ends = Object.values(rl.state.executions)
      .filter((e) => rl.state.tickets[key]?.executions.some((id) => rl.state.executions[id] === e))
      .map((e) => (e.ended_at ? Date.parse(e.ended_at) : 0));
    const since = Math.max(0, endedAt ?? 0, ...ends);
    const waitMs = (this.o.worktreeDays ?? 7) * DAY;
    return since && now - since >= waitMs
      ? null
      : `no PR yet; kept ${this.o.worktreeDays ?? 7} days after the ticket ended`;
  }

  /** Why removing the worktree could lose work, or null when it can't. */
  private async unsafe(repo: string, board: Board, path: string, branch: string): Promise<string | null> {
    const status = await git(path, ["status", "--porcelain"]);
    if (status.code !== 0) return `couldn't read its status: ${status.stderr.split("\n")[0]}`;
    if (status.stdout.trim()) return "it has uncommitted changes";
    const head = (await git(path, ["rev-parse", "HEAD"])).stdout;
    if (!head) return "couldn't read its HEAD";
    let failure = "";
    // The commits are safe if the remote branch has them, or the default branch does (merged).
    for (const name of [branch, board.repo.default_branch]) {
      if (!name) continue;
      try {
        await this.o.remote.fetchBranch(repo, board.repo, name);
        if (await isAncestor(repo, head, destRef(name))) return null;
      } catch (e) {
        failure = (e as Error).message;
      }
    }
    return failure
      ? `couldn't confirm its commits are on the remote: ${failure}`
      : "it has commits that aren't on the remote branch";
  }

  private board(id: string): Board | null {
    try {
      return readJson(this.c.home.board(id)) as Board;
    } catch {
      return null;
    }
  }

  // --- terminals

  /** Closes terminals of finished executions whose ticket is done (completed or cancelled). */
  private async terminals(rl: RunLog, report: PassReport): Promise<void> {
    const hc = this.o.hc;
    if (!hc) return;
    for (const [execId, e] of Object.entries(rl.state.executions)) {
      const t = rl.state.tickets[e.ticket];
      if (!e.terminal || !t || (t.state !== "completed" && t.state !== "cancelled")) continue;
      try {
        if (!(await hc.get(e.terminal))) continue;
        await hc.kill(e.terminal);
        report.terminals.push(e.terminal);
        this.c.log(`retention: closed ${e.terminal} (${execId}), its ticket ${e.ticket} is ${t.state}`);
      } catch (err) {
        this.c.log(`retention: couldn't close ${e.terminal}: ${(err as Error).message}`);
      }
    }
  }
}
