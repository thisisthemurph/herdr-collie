# Recorded `hc` output

Real output from hc (herdr-core) 0.1.17, recorded on 2026-11-09 against throwaway
terminals (`sleep`) and the spike's Claude Code agents. Home paths, space ids and
names were replaced with placeholders. `tools/fake-hc` tests compare its output to
these shapes, so a re-sync of `docs/herdr/` should re-record them.

Each `*.stdout.json` is what `--json` printed on stdout with exit code 0. Each
`*.stderr.json` is the error printed on stderr; its exit code is in `exit-codes.json`.

Notes from recording:

- `get-blocked-agent.stdout.json` keeps only `argv`, `labels` and `status`; the rest of
  that object matched `get-live-agent`.
- `hc ls --json` entries carry no labels. Filter with `hc ls --json --label k=v`, then
  `hc get` each terminal for its labels.
- A program that exits normally finishes with `reason: "exited"` and its `exit_code`;
  `hc kill` gives `reason: "killed"`, `signal: 1`. `hc kill` on a finished terminal
  succeeds and prints it again.
- `hc send` to a plain program (no agent status) succeeds with `started: null`.
- `hc run` without `--bg` waits, then prints the run object plus `output` and `wait`.
