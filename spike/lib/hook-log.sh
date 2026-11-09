#!/bin/bash
# Claude Code hook: appends "<ms> <event> <detail>" to $SPIKE_HOOK_LOG (ground truth for turn boundaries).
in=$(cat)
ts=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
ev=$(printf '%s' "$in" | jq -r '.hook_event_name // "?"')
detail=$(printf '%s' "$in" | jq -c '{tool: .tool_name, prompt: (.prompt // null), msg: (.message // null)} | with_entries(select(.value != null))')
echo "$ts $ev $detail" >> "${SPIKE_HOOK_LOG:-/dev/null}"
exit 0
