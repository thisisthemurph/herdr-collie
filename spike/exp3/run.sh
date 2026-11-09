#!/bin/bash
# Experiment 3: do env vars and labels set at launch reach the agent's own shell commands?
# Variant A: hc run ... -- env K=V claude ...      (argv form)
# Variant B: hc run "K=V claude ..."               (one quoted string = shell command)
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd); L=$ROOT/spike/lib; R=$ROOT/spike/exp3/results; mkdir -p "$R"
unset HC_TERMINAL_ID
SPACE=$(herdr-app ls | jq -r '.spaces[] | select(.name=="collie-spike") | .id')
TASK='Run these shell commands in order and nothing else: (1) env | grep -E "^(COLLIE|HC_)" | sort   (2) ./collie-fake status "hello from agent"   (3) hc get $HC_TERMINAL_ID --json . Then reply E3-OK followed by the value of COLLIE_INBOX as you saw it.'
ALLOW='Bash(env:*) Bash(./collie-fake:*) Bash(hc get:*)'

prep() { # prep <dir> : fake collie that appends to $COLLIE_INBOX, refusing if unset
  mkdir -p "$1/inbox"; : > "$1/hooks.log"; rm -f "$1/inbox/inbox.jsonl"
  cat > "$1/collie-fake" <<'EOF'
#!/bin/bash
[ -n "${COLLIE_INBOX:-}" ] || { echo "collie-fake: COLLIE_INBOX is not set" >&2; exit 3; }
printf '{"type":"%s","body":"%s","run":"%s","execution":"%s","ticket":"%s","role":"%s"}\n' \
  "$1" "$2" "${COLLIE_RUN_ID:-}" "${COLLIE_EXECUTION_ID:-}" "${COLLIE_TICKET:-}" "${COLLIE_ROLE:-}" >> "$COLLIE_INBOX"
echo "appended to $COLLIE_INBOX"
EOF
  chmod +x "$1/collie-fake"
}

envs() { # envs <dir>
  echo "COLLIE_HOME=$1/home COLLIE_INBOX=$1/inbox/inbox.jsonl COLLIE_RUN_ID=01SPIKERUN COLLIE_EXECUTION_ID=01SPIKEEXEC COLLIE_TICKET=SPIKE-1 COLLIE_ROLE=developer"
}

labels="--label collie.run=01SPIKERUN --label collie.execution=01SPIKEEXEC --label collie.ticket=SPIKE-1"

# ---- Variant A: argv with env(1)
A=$ROOT/spike/work/spike-e3a; prep "$A"
AGENT_ENV="$(envs "$A")" LABELS="$labels" ALLOWED="$ALLOW" "$L/launch.sh" spike-e3a "$TASK" > "$R/a.launch"
# ---- Variant B: one shell string
B=$ROOT/spike/work/spike-e3b; prep "$B"
hc run --bg --json --no-parent --no-notify --name spike-e3b --cwd "$B" \
  --label collie.spike=1 --label herdr.space="$SPACE" --label herdr.tab=spike-e3b $labels \
  "$(envs "$B") SPIKE_HOOK_LOG=$B/hooks.log $HOME/.local/bin/claude '$TASK' --settings $L/hooks-settings.json --permission-mode acceptEdits --allowedTools '$ALLOW'" > "$R/b.launch"

for v in a b; do
  t=spike-e3$v
  # the first turn may block on a permission prompt if the allowlist misses something; record it
  hc wait $t --json --timeout 120 > "$R/$v.wait"; sleep 3; hc wait $t --json --timeout 60 >> "$R/$v.wait"
  hc get $t --json | jq '{argv, labels, status}' > "$R/$v.get"
  hc read $t --lines 80 > "$R/$v.screen"
done
cp "$A/inbox/inbox.jsonl" "$R/a.inbox" 2>/dev/null || echo "no inbox" > "$R/a.inbox"
cp "$B/inbox/inbox.jsonl" "$R/b.inbox" 2>/dev/null || echo "no inbox" > "$R/b.inbox"
# Does the labels' presence also leak into env? (expect: no; labels are hc metadata only)
hc ls --json | jq -c '.terminals[] | select((.name // "")|test("spike-e3")) | {name, address}' > "$R/ls.txt"
