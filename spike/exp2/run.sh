#!/bin/bash
# Experiment 2: does Herdr's agent status show when a Claude Code turn ends?
# Usage: run.sh [scenario...]   (default: all, 3 runs each)
# Ground truth = Claude Code hooks (UserPromptSubmit/Stop); observed = `hc get` polled every 200ms
# plus the exact `status_ms` hc reports. Results go to spike/exp2/results/.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd); L=$ROOT/spike/lib; N=$L/now_ms
T=spike-e2; W=$ROOT/spike/work/$T; R=$ROOT/spike/exp2/results; mkdir -p "$R"
RUNS=${RUNS:-3}
unset HC_TERMINAL_ID   # send as an outside process (no <hc from> wrapper), like a controller would

start_agent() {
  hc kill $T >/dev/null 2>&1; hc rm $T >/dev/null 2>&1
  ALLOWED="Read Edit Bash(./slow.sh:*) Task Agent" "$L/launch.sh" $T >/dev/null
  cp "$L/slow.sh" "$W/"; printf 'alpha\nsecond line\n' > "$W/notes.txt"
  hc wait $T --json >/dev/null
}

wait_status() { # wait_status <state> <timeout_s>
  for _ in $(seq 1 $(( $2 * 4 ))); do
    [ "$(hc get $T --json | jq -r .status.state)" = "$1" ] && return 0; sleep 0.25; done; return 1
}

prompt_for() {
  case $1 in
    a) echo "Reply with exactly A-OK." ;;
    b) echo "Read notes.txt, then use the Edit tool to change alpha to beta in notes.txt and back to alpha again, then run ./slow.sh 2 in the foreground, then reply B-OK." ;;
    c) echo "Run ./slow.sh 100 in the FOREGROUND with a Bash timeout of 150000 ms (do not background it), then reply C-OK." ;;
    d) echo "Use the Agent/Task tool to start one subagent that reads notes.txt and returns its first line. When it returns, reply D-OK plus that line." ;;
    e) echo "Ask me in plain text whether I prefer red or blue, then end your turn and wait for my answer. Do not use any tool." ;;
    f) echo "Use the AskUserQuestion tool to ask me whether I prefer red or blue (two options). After I answer, reply F-OK." ;;
    g) echo "Run the shell command: python3 -c 'print(41+1)'   (then reply G-OK)." ;;   # date/rm are auto-allowed (read-only / acceptEdits in cwd); python3 needs permission
    h) echo "Run ./slow.sh 30 with run_in_background set to true, reply BG-STARTED immediately, and reply BG-DONE when it finishes." ;;
  esac
}

interact() { # handle blocked scenarios; log what hc does
  local s=$1 log=$2
  case $s in
    f|g)
      if wait_status blocked 60; then
        echo "$($N) BLOCKED-SEEN" >> "$log"
        hc send $T "should be refused" --json >> "$log" 2>&1; rc=$?; echo "$($N) send-no-force rc=$rc" >> "$log"
        hc send --if idle $T "should be refused" --json >> "$log" 2>&1; rc=$?; echo "$($N) send-if-idle rc=$rc" >> "$log"
        sleep 1
        if [ "$s" = f ]; then hc keys $T enter --json >> "$log" 2>&1        # pick first option
        else hc keys $T esc --json >> "$log" 2>&1; fi                         # deny the permission
        echo "$($N) keys-sent" >> "$log"
        if [ "$s" = g ]; then wait_status blocked 2 || true; sleep 2
          hc send $T "Permission denied on purpose; just reply G-OK." --json >> "$log" 2>&1; fi
      else echo "$($N) NEVER-BLOCKED" >> "$log"; fi ;;
    e) hc wait $T --json --timeout 60 >/dev/null
       hc send $T "Blue. Now reply E-OK." --json >> "$log" 2>&1 ;;
  esac
}

one_run() { # one_run <scenario> <i>
  local s=$1 i=$2 id=$1-$2
  : > "$W/hooks.log"; rm -f "$W/status.log"
  "$L/status-log.sh" $T "$W/status.log" & local sl=$!
  sleep 0.5
  local t0; t0=$($N); echo "$t0 SEND" > "$R/$id.driver"
  hc send $T "$(prompt_for "$s")" --json >> "$R/$id.driver" 2>&1
  interact "$s" "$R/$id.driver"
  # wait for the whole thing to settle: hc wait, then make sure nothing restarts for 5s
  while :; do
    hc wait $T --json --timeout 200 >> "$R/$id.driver" 2>&1; echo "$($N) WAIT-RETURNED" >> "$R/$id.driver"
    sleep 5
    st=$(hc get $T --json | jq -r .status.state); [ "$st" = working ] || break
  done
  if [ "$s" = h ]; then sleep 35; hc wait $T --json --timeout 60 >> "$R/$id.driver" 2>&1; sleep 3; fi
  kill $sl 2>/dev/null; wait $sl 2>/dev/null
  cp "$W/hooks.log" "$R/$id.hooks"; cp "$W/status.log" "$R/$id.status"
  hc read $T --lines 0 > "$R/$id.screen" 2>/dev/null
  "$ROOT/spike/exp2/analyze.sh" "$id"
}

scenarios=${*:-a b c d e f g h}
start_agent
for s in $scenarios; do
  for i in $(seq 1 "$RUNS"); do
    one_run "$s" "$i"
    [ "$s" = h ] && break   # background-shell case: one run is enough to show the behaviour
  done
  start_agent   # fresh context per scenario so earlier turns don't bleed in
done
hc kill $T >/dev/null 2>&1; hc rm $T >/dev/null 2>&1
