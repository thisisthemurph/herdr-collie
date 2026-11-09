# fake-agent

A scripted stand-in for a harness such as Claude Code. It runs `collie` commands, and plain
shell commands, from a scenario file in order, checking each exit code.

```sh
tools/fake-agent/bin/fake-agent scenario.json ["first message"]
```

```json
{
  "v": 1,
  "steps": [
    { "collie": ["status", "Reading the code"] },
    { "shell": "git commit --allow-empty -m '${COLLIE_TICKET}: work'" },
    { "collie": ["done", "--summary", "x"], "expect_exit": 2, "expect_output": "uncommitted" },
    { "collie": ["finding", "--body-file", "-"], "stdin": "a long body" },
    { "await_message": { "contains": "Answer to your question", "timeout_ms": 10000 } },
    { "sleep_ms": 200 },
    { "exit": 0 }
  ]
}
```

- `${NAME}` in any string becomes that environment variable.
- `expect_exit` defaults to 0. A mismatch, or `expect_output` missing from stdout and
  stderr, stops the agent with exit code 1, naming the step.
- `await_message` waits for the next text `hc send` delivered. Under `tools/fake-hc` with
  `"spawn": true`, those arrive in the file named by `FAKE_HC_INPUT`.
- Environment: `COLLIE_BIN` (default `collie`), `FAKE_AGENT_LOG` (a JSONL copy of the
  step results it prints).
