#!/bin/bash
# analyze.sh <run-id>: compares hook ground truth with hc status for one run; prints one summary line.
R=$(cd "$(dirname "$0")" && pwd)/results
python3 -I - "$R/$1" "$1" <<'EOF'
import sys, json
base, rid = sys.argv[1], sys.argv[2]
hooks = []
for l in open(base + ".hooks"):
    p = l.split(" ", 2)
    if len(p) >= 2: hooks.append((int(p[0]), p[1]))
st = []
for l in open(base + ".status"):
    p = l.split()
    if len(p) >= 5: st.append(dict(obs=int(p[0]), state=p[2], turn=int(p[3]), ms=int(p[4])))
stops = [t for t, e in hooks if e == "Stop"]
subs = [t for t, e in hooks if e == "UserPromptSubmit"]
# turn intervals: each submit to the first Stop after it
intervals = []
for s in subs:
    nxt = [t for t in stops if t > s]
    if nxt: intervals.append((s, nxt[0]))
out = []
for s in stops:
    after = [x for x in st if x["state"] in ("done", "idle", "blocked") and x["ms"] >= s - 50]
    if after:
        x = after[0]; out.append(f"stop->{x['state']} {x['ms']-s}ms (seen +{x['obs']-s}ms)")
    else:
        out.append("stop->NO-IDLE-SEEN")
false_idle = [x for x in st if x["state"] in ("done", "idle")
              and any(a < x["ms"] < b - 50 for a, b in intervals)]
blocked = [x for x in st if x["state"] == "blocked"]
seq = " ".join(f"{x['state']}#{x['turn']}" for x in st)
print(f"{rid}: {'; '.join(out)} | false-idle={len(false_idle)} | blocked={len(blocked)} | {seq}")
EOF
