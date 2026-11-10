// The text every agent gets (docs/protocol.md, "Agent templates"): a one-line first message,
// the profile's instructions with the standard reporting block appended, and the task.md brief.
// The files live in packages/controller/templates/ and are embedded in the compiled binary.
import type { Profile } from "@collie/schema";
import firstMessageText from "../templates/first-message.txt" with { type: "text" };
import kindAnalyse from "../templates/kind-analyse.md" with { type: "text" };
import kindDevelop from "../templates/kind-develop.md" with { type: "text" };
import kindRemediate from "../templates/kind-remediate.md" with { type: "text" };
import kindReview from "../templates/kind-review.md" with { type: "text" };
import reportingBlock from "../templates/reporting-block.md" with { type: "text" };
import taskTemplate from "../templates/task.md" with { type: "text" };

export const FIRST_MESSAGE = firstMessageText.trim();

const KIND_INSTRUCTIONS: Record<string, string> = {
  develop: kindDevelop,
  review: kindReview,
  remediate: kindRemediate,
  analyse: kindAnalyse,
};

/**
 * Fills `{{name}}` slots. A `{{#name}}…{{/name}}` block (its markers on lines of their own) is
 * left out when `name` has nothing to show, so no section is ever shown empty.
 */
export function render(template: string, vars: Record<string, string>): string {
  const fill = (s: string) => s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
  const blocks = template.replace(
    /^\{\{#(\w+)\}\}\n([\s\S]*?)^\{\{\/\1\}\}\n/gm,
    (_, k: string, body: string) => ((vars[k] ?? "").trim() ? body : ""),
  );
  return `${fill(blocks)
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/** The profile's own instructions, then the standard reporting block. */
export function systemPrompt(profile: Pick<Profile, "instructions">): string {
  return `${profile.instructions.trim()}\n\n${reportingBlock.trim()}\n`;
}

export type BriefInput = {
  ticket: string;
  summary: string;
  profileName: string;
  kind: string;
  round: number;
  attempt: number;
  description: string;
  criteria: string;
  clarifications: string;
  comments: string;
  repository: string;
  worktree: string;
  branch: string;
  base: string;
  stacked: string;
  blockedBy: string;
  blocks: string;
  findingsHeading?: string;
  findings: string;
  permissions: Profile["permissions"];
  timeoutMin: number;
};

/** What the profile's permissions mean, in words (the "Limits" section). */
export function limitsText(p: Profile["permissions"]): string {
  return [
    p.write_worktree ? "You may edit files inside your worktree." : "Read-only: do not modify files.",
    p.shell ? "You may run shell commands." : "Do not run shell commands.",
    p.network ? "You may use the network." : "Do not use the network.",
  ].join(" ");
}

/** task.md for one execution. */
export function taskBrief(i: BriefInput): string {
  const kind = (KIND_INSTRUCTIONS[i.kind] ?? "").trim();
  return render(taskTemplate, {
    ticket: i.ticket,
    summary: i.summary,
    profile_name: i.profileName,
    kind: i.kind,
    round: String(i.round),
    attempt: String(i.attempt),
    description: i.description.trim() || "(this ticket has no description)",
    acceptance_criteria: i.criteria,
    clarifications: i.clarifications,
    comments: i.comments,
    repository: i.repository,
    worktree: i.worktree,
    branch_line:
      i.kind === "analyse"
        ? `${i.base} (detached and read-only: you are not working on a branch)`
        : `${i.branch}, based on ${i.base}`,
    base: i.base,
    stacked: i.stacked,
    blocked_by: i.blockedBy,
    blocks: i.blocks,
    kind_instructions: render(kind, { ticket: i.ticket, base: i.base }).trimEnd(),
    findings_heading: i.findingsHeading ?? "Findings to address",
    findings: i.findings,
    limits: limitsText(i.permissions),
    timeout_min: String(i.timeoutMin),
  });
}
