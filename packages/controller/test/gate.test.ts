// The review gate as pure functions (docs/protocol.md, "Workflow"): no files, no hc, no clock.
import { describe, expect, test } from "bun:test";
import {
  type ExecView,
  type ReviewerSlot,
  remediationsDone,
  reviewPlan,
  reviewRound,
  slotsFor,
} from "../src/gate.ts";

const SEC: ReviewerSlot = { profile: "security", required: true };
const BACK: ReviewerSlot = { profile: "backend", required: true };
const FRONT: ReviewerSlot = { profile: "frontend", required: false };

let n = 0;
const review = (
  profile: string,
  round: number,
  state: ExecView["state"],
  more: Partial<ExecView> = {},
): ExecView => ({ id: `e${++n}`, kind: "review", profile, round, attempt: 1, state, ...more });
const approve = (profile: string, round: number) =>
  review(profile, round, "completed", { verdict: "approve" });
const changes = (profile: string, round: number) =>
  review(profile, round, "completed", { verdict: "request_changes" });
const remediate = (round: number, state: ExecView["state"] = "completed"): ExecView => ({
  id: `e${++n}`,
  kind: "remediate",
  profile: "developer",
  round,
  attempt: 1,
  state,
});

const plan = (execs: ExecView[], reviewers = [SEC, BACK, FRONT], maxRounds = 2) =>
  reviewPlan({ execs, reviewers, maxRounds, maxAttempts: () => 2 });

describe("review rounds", () => {
  test("round 1 until a remediation completes, then one more for each completed round", () => {
    expect(reviewRound([])).toBe(1);
    expect(reviewRound([changes("security", 1), remediate(1, "working")])).toBe(1);
    expect(reviewRound([remediate(1)])).toBe(2);
    expect(reviewRound([remediate(1), remediate(2)])).toBe(3);
    expect(remediationsDone([remediate(1), remediate(2), remediate(2, "failed")])).toBe(2);
  });

  test("round 1 uses every reviewer; later rounds only those that asked for changes", () => {
    const execs = [approve("security", 1), changes("backend", 1), changes("frontend", 1), remediate(1)];
    expect(slotsFor(1, [SEC, BACK, FRONT], execs).map((s) => s.profile)).toEqual([
      "security",
      "backend",
      "frontend",
    ]);
    expect(slotsFor(2, [SEC, BACK, FRONT], execs).map((s) => s.profile)).toEqual(["backend", "frontend"]);
  });
});

describe("the gate", () => {
  test("launches every reviewer that has no execution yet, all at once", () => {
    const p = plan([]);
    expect(p.launch.map((s) => s.profile)).toEqual(["security", "backend", "frontend"]);
    expect(p.outcome).toBe("wait");
  });

  test("waits while any reviewer, optional ones too, is still working", () => {
    const p = plan([approve("security", 1), approve("backend", 1), review("frontend", 1, "working")]);
    expect(p).toMatchObject({ launch: [], retry: [], hold: [], outcome: "wait" });
  });

  test("passes when every required reviewer approved, whatever an optional reviewer said", () => {
    expect(plan([approve("security", 1), approve("backend", 1), changes("frontend", 1)]).outcome).toBe(
      "pass",
    );
  });

  test("an optional reviewer's request for changes does not start a remediation", () => {
    expect(plan([approve("security", 1), approve("backend", 1), changes("frontend", 1)]).outcome).toBe(
      "pass",
    );
  });

  test("one required request_changes starts a remediation, once everyone has answered", () => {
    expect(plan([changes("security", 1), approve("backend", 1), approve("frontend", 1)]).outcome).toBe(
      "remediate",
    );
    expect(
      plan([changes("security", 1), review("backend", 1, "working"), approve("frontend", 1)]).outcome,
    ).toBe("wait");
  });

  test("round 2 checks only the reviewers that asked for changes", () => {
    const execs = [changes("security", 1), approve("backend", 1), approve("frontend", 1), remediate(1)];
    const p = plan(execs);
    expect(p.launch.map((s) => s.profile)).toEqual(["security"]);
    expect(plan([...execs, approve("security", 2)]).outcome).toBe("pass");
  });

  test("the round cap: the cap is hit when a required reviewer still asks for changes after the allowed remediations", () => {
    const afterOne = [changes("security", 1), remediate(1), changes("security", 2)];
    expect(plan(afterOne, [SEC], 1).outcome).toBe("cap");
    expect(plan(afterOne, [SEC], 2).outcome).toBe("remediate");
    expect(plan([changes("security", 1)], [SEC], 0).outcome).toBe("cap");
  });

  test("a failed reviewer with attempts left is retried; the gate waits for it", () => {
    const failed = review("security", 1, "failed", { retryable: true });
    const p = plan([failed, approve("backend", 1), approve("frontend", 1)]);
    expect(p.retry.map((e) => e.id)).toEqual([failed.id]);
    expect(p.outcome).toBe("wait");
  });

  test("a required reviewer that can't finish holds the ticket; an optional one is skipped", () => {
    const dead = review("security", 1, "failed", { retryable: true, attempt: 2 });
    expect(plan([dead, approve("backend", 1), approve("frontend", 1)]).hold.map((e) => e.id)).toEqual([
      dead.id,
    ]);
    const cancelled = review("security", 1, "cancelled");
    expect(plan([cancelled, approve("backend", 1), approve("frontend", 1)]).hold).toHaveLength(1);
    const optionalDead = review("frontend", 1, "failed", { retryable: false });
    const p = plan([approve("security", 1), approve("backend", 1), optionalDead]);
    expect(p.hold).toEqual([]);
    expect(p.outcome).toBe("pass");
  });
});
