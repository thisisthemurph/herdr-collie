// The review gate (docs/protocol.md, "Workflow" and the ticket state machine), as pure functions:
// given a ticket's executions, what should the controller do next while the ticket is `reviewing`?
// Nothing here reads a clock, a file or hc, so every rule is a plain unit test.
import type { ExecutionKind, ExecutionState } from "@collie/schema";

export type ExecView = {
  id: string;
  kind: ExecutionKind;
  profile: string;
  round: number;
  attempt: number;
  state: ExecutionState;
  /** From an accepted reviewer `done`. */
  verdict?: "approve" | "request_changes";
  /** From an accepted `fail`, or a failure the controller declared. */
  retryable?: boolean;
};

export type ReviewerSlot = { profile: string; required: boolean };

const FINAL: ExecutionState[] = ["completed", "failed", "cancelled"];
const isFinal = (e: ExecView) => FINAL.includes(e.state);

/** The latest execution of this kind, round and profile (retries come later in the list). */
export function latest(execs: ExecView[], kind: ExecutionKind, round: number, profile: string) {
  return execs.filter((e) => e.kind === kind && e.round === round && e.profile === profile).at(-1);
}

/**
 * The round the ticket's reviewers are on: 1 until a remediation completes, then one more per
 * completed remediation round (a remediation at round r hands the ticket to review round r + 1).
 */
export function reviewRound(execs: ExecView[]): number {
  const done = execs.filter((e) => e.kind === "remediate" && e.state === "completed").map((e) => e.round);
  return done.length ? Math.max(...done) + 1 : 1;
}

/** Remediation rounds already completed, for the cap. */
export function remediationsDone(execs: ExecView[]): number {
  return new Set(execs.filter((e) => e.kind === "remediate" && e.state === "completed").map((e) => e.round))
    .size;
}

/**
 * Which reviewers take part in `round`. Round 1: all of them. Later rounds: only the reviewers
 * that asked for changes in the round before (DECISION: an optional reviewer that asked for
 * changes is checked again too, so its findings aren't left unverified).
 */
export function slotsFor(round: number, reviewers: ReviewerSlot[], execs: ExecView[]): ReviewerSlot[] {
  if (round <= 1) return reviewers;
  return reviewers.filter(
    (r) => latest(execs, "review", round - 1, r.profile)?.verdict === "request_changes",
  );
}

export type ReviewPlan = {
  /** Reviewers with no execution yet this round. */
  launch: ReviewerSlot[];
  /** Failed reviewers that may try again (attempts left, retryable). */
  retry: ExecView[];
  /** Required reviewers that ended without a verdict and can't retry: a person must step in. */
  hold: ExecView[];
  /**
   * What the round amounts to once every slot has answered:
   * `wait` (something is still open), `pass` (the gate is met), `remediate`, or `cap`.
   */
  outcome: "wait" | "pass" | "remediate" | "cap";
};

/**
 * What to do for a `reviewing` ticket (protocol: "reviewing → remediating / delivering").
 *   - every slot of the round has an execution, so a missing one is launched;
 *   - the gate waits for every reviewer of the round, but only required verdicts decide it
 *     (DECISION: waiting for optional ones keeps their findings complete for the remediation);
 *   - a required reviewer that can't finish holds the ticket; an optional one that can't is skipped;
 *   - any required `request_changes` starts a remediation while fewer than
 *     `maxRounds` have completed (DECISION: "capped per workflow" counts remediation rounds), else the cap is hit.
 */
export function reviewPlan(i: {
  execs: ExecView[];
  reviewers: ReviewerSlot[];
  maxRounds: number;
  maxAttempts: (profile: string) => number;
}): ReviewPlan {
  const round = reviewRound(i.execs);
  const plan: ReviewPlan = { launch: [], retry: [], hold: [], outcome: "wait" };
  let open = false;
  let changes = false;
  for (const slot of slotsFor(round, i.reviewers, i.execs)) {
    const e = latest(i.execs, "review", round, slot.profile);
    if (!e) {
      plan.launch.push(slot);
      open = true;
    } else if (!isFinal(e)) {
      open = true;
    } else if (e.state === "completed") {
      if (slot.required && e.verdict === "request_changes") changes = true;
    } else if (e.state === "failed" && e.retryable && e.attempt < i.maxAttempts(e.profile)) {
      plan.retry.push(e);
      open = true;
    } else if (slot.required) {
      plan.hold.push(e);
    }
    // an optional reviewer that ended without a verdict is skipped
  }
  if (open || plan.hold.length) return plan;
  if (changes) plan.outcome = remediationsDone(i.execs) < i.maxRounds ? "remediate" : "cap";
  else plan.outcome = "pass";
  return plan;
}
