# fake-hc

A stand-in for herdr-core's `hc`, so tests can run without real Herdr. It supports the
subset Collie uses: `run`, `send`, `wait`, `get`, `ls`, `label`, `kill` and `rm`. Output
shapes, error kinds and exit codes copy real hc 0.1.17; the recordings it is tested against
are in `fixtures/hc/`.

## Use

```sh
export FAKE_HC_DIR=$(mktemp -d)                 # state, logs and terminal files go here
export FAKE_HC_SCENARIO=path/to/scenario.json   # optional; default $FAKE_HC_DIR/scenario.json
export PATH="$PWD/tools/fake-hc/bin:$PATH"
hc run --bg --json --no-parent --label collie.execution=E1 -- env COLLIE_INBOX=… claude "…"
```

Every call is appended to `$FAKE_HC_DIR/calls.jsonl` as
`{ts, argv, cwd, from, code, stdout, stderr}`, where `from` is the caller's
`HC_TERMINAL_ID` (so a test can check the controller unset it before `hc send`).

## Scenario

```json
{
  "v": 1,
  "agents": [
    {
      "match": { "labels": { "collie.ticket": "PAY-101" } },
      "steps": [
        { "on": "run",  "state": "idle", "turn": 0 },
        { "on": "get",  "state": "working", "turn": 1 },
        { "on": "wait", "state": "done" },
        { "on": "send", "state": "working", "turn": "+1" },
        { "on": "wait", "state": "blocked", "kind": "permission", "msg": "approve Bash: go test" },
        { "on": "wait", "exit": 0 }
      ]
    }
  ]
}
```

- Each `hc run` takes the first unused agent whose `match` fits (`name` and/or `labels`;
  empty matches anything). Unmatched terminals act like plain programs: status `null`,
  live until killed.
- `run_error: {kind, message, hint?}` makes that `hc run` fail with exit code 1, like
  `spawn_failed`.
- Steps play back in order, **one step per call**: a call applies the step at the cursor if
  its `on` is that command (or `any`). `hc run` applies every leading `run` step. `ls`
  applies `ls` steps to all live terminals. When the steps run out, the terminal keeps its
  last state.
- `send` checks the status before applying its step, as real hc does: `blocked` refuses with
  exit 9, `--if` mismatch with exit 10, finished with exit 11. Text sent with
  `HC_TERMINAL_ID` set arrives wrapped in `<hc from="…">…</hc>`.
- `wait` returns at once: `reason: "status"` when the agent's turn has ended, `"exit"` when
  the program finished, otherwise `"timeout"`.
- `"spawn": true` really starts the argv in the background with `HC_TERMINAL_ID`,
  `FAKE_HC_INPUT` (messages from `hc send`, one JSON string per line) and its output in
  `$FAKE_HC_DIR/<t>.out`. When it exits, the terminal finishes with its exit code. Use this
  with `tools/fake-agent` for end-to-end tests.

## Not supported

`hc run` without `--bg`, `--on`, `send --wait`, `wait --children` / `--output`, and every
other hc command. Each fails with exit code 2 and `kind: "unsupported"`.
