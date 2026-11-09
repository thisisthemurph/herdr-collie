#!/bin/bash
# Usage: ALLOWED="Read Bash(sleep:*)" launch.sh <name> [first task]
# Starts Claude Code in spike/work/<name> under hc, shown as a tab in the collie-spike space.
# Default permission mode + acceptEdits, with a narrow per-experiment tool allowlist.
# The first task (if any) goes BEFORE the options: --allowedTools is variadic and would swallow it.
# Extra env for the agent can be passed as AGENT_ENV="K=V K2=V2".
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd); name=$1; shift
SPACE=$(herdr-app ls | jq -r '.spaces[] | select(.name=="collie-spike") | .id')
dir=$ROOT/spike/work/$name; mkdir -p "$dir"; : > "$dir/hooks.log"
# shellcheck disable=SC2086
hc run --bg --json --no-parent --no-notify --name "$name" --cwd "$dir" \
  --label collie.spike=1 --label herdr.space="$SPACE" --label herdr.tab="$name" ${LABELS:-} \
  -- env SPIKE_HOOK_LOG="$dir/hooks.log" ${AGENT_ENV:-} "$HOME/.local/bin/claude" "$@" \
     --settings "$ROOT/spike/lib/hooks-settings.json" --permission-mode acceptEdits \
     --allowedTools "${ALLOWED:-Read}"
