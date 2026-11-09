// Help text. `collie --help` must fit on one screen, so agents read all of it.

export const MAIN_HELP = `collie: report to Collie from inside an agent run.

  collie show task                 your brief: read it first
  collie show findings             open review findings to address
  collie show answers              answers to questions on this ticket
  collie status "<message>"        progress for the UI (--phase testing)
  collie finding --severity high --title "..." --body "..."    (reviewers)
  collie artifact --kind commit --ref <sha>                     (developers)
  collie ask "<question>" [--option "..."]...   then end your turn
  collie done --summary "..."      finish; reviewers add --verdict approve
                                   or --verdict request_changes
  collie fail --reason "..." --category <category> [--retryable]

Long text: --body-file <path> (or - for stdin) instead of --body.
Add --json to print the recorded event as JSON.
Run \`collie <command> --help\` for a command's options.
collie ctl <command> '<args JSON>' steers the controller (used by the mod).

Exit codes: 0 recorded · 2 fix the call (the message says how) · 3 not in a
Collie run · 4 this execution already ended · 5 I/O error, run it again.`;

export const COMMAND_HELP: Record<string, string> = {
  show: `collie show task|findings|answers [--json]

  task       your brief (task.md)
  findings   open findings for your ticket, blocking first, with suggestions
  answers    answers to your questions, and those shared with your ticket`,

  status: `collie status "<message>" [--phase <phase>] [--json]

  <message>  what you're doing, at most 200 characters (shown in a UI)
  --phase    investigating | implementing | testing | reviewing | remediating`,

  finding: `collie finding --severity <s> --title "<t>" (--body "<b>" | --body-file <path|->) [options]

  --severity      critical | high | medium | low | info
  --title         one line, at most 200 characters
  --body          the detail; --body-file reads a file, or stdin with -
  --file, --line, --end-line   where it is (line needs file)
  --category      security | correctness | tests | performance | design | style
  --suggestion    how to fix it
  --blocking / --not-blocking  must it be fixed before merge? (default: yes for
                  critical and high, no otherwise)
  --json`,

  artifact: `collie artifact --kind <kind> --ref <ref> [--description "<d>"] [--json]

  --kind   commit | branch | test_report | file
  --ref    a commit sha, branch name or path`,

  ask: `collie ask "<question>" [--option "<choice>"]... [--context "<c>"] [--json]

  Ask one specific question a person must decide, then end your turn.
  The answer arrives as your next message; collie show answers lists them all.`,

  done: `collie done --summary "<s>" [options]

  --summary, --summary-file <path|->   what you did
  --verdict approve | request_changes  required for reviewers; request_changes
                                       needs a blocking finding, approve needs none
  --commit <sha>                       repeatable; developers default to every
                                       commit ahead of the base branch
  --tests-command "<cmd>" --tests-passed | --tests-failed
  --json

  Developers: commit everything first; done refuses a dirty worktree.`,

  fail: `collie fail --reason "<r>" --category <c> [--retryable] [--details "<d>"] [--json]

  --category   blocked_external | cannot_implement | tooling | environment | other
  --retryable  another attempt could succeed
  --details, --details-file <path|->   more context`,
};
