#!/bin/bash
# Usage: status-log.sh <terminal> <outfile>. Polls `hc get` every 200ms; logs status/turn changes until the terminal finishes.
t=$1; out=$2; last=""
while :; do
  j=$(hc get "$t" --json 2>/dev/null) || { echo "$(perl -MTime::HiRes=time -e 'printf "%d", time*1000') GONE" >> "$out"; exit 0; }
  cur=$(printf '%s' "$j" | jq -r '[.state, (.status.state // "none"), .turn, (.status_ms // 0)] | @tsv')
  if [ "$cur" != "$last" ]; then echo "$(perl -MTime::HiRes=time -e 'printf "%d", time*1000') $cur" >> "$out"; last=$cur; fi
  case "$cur" in finished*) exit 0;; esac
  sleep 0.2
done
