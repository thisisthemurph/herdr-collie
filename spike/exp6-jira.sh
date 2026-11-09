#!/bin/bash
# Phase 0 spike, experiment 6: does a scoped Jira API token work through api.atlassian.com/ex/jira/{cloudId}?
#
#   spike/exp6-jira.sh <SITE> <TEST-ISSUE> ['<JQL>']                       read-only checks
#     (JQL defaults to: key = <TEST-ISSUE> OR issue in linkedIssues(<TEST-ISSUE>))
#   spike/exp6-jira.sh <SITE> <TEST-ISSUE> '<JQL>' --transition "<name>"   also perform that transition
#   spike/exp6-jira.sh <SITE> <TEST-ISSUE> '<JQL>' --comment               also add a comment
#   (flags combine; SITE is the part before .atlassian.net)
#
# Credentials: keychain service collie-jira; account field = Atlassian email, password = token.
# Both are read at the start and held in memory only; the Basic header reaches curl through stdin
# (--config -), never argv, the environment, a file or the output.
# Output: a transcript in spike/work/exp6/ (git-ignored); raw response bodies next to it.
set -uo pipefail
SITE=${1:?site}; ISSUE=${2:?issue key}; shift 2
JQL="key = $ISSUE OR issue in linkedIssues($ISSUE)"
if [ $# -gt 0 ] && [ "${1#--}" = "$1" ]; then JQL=$1; shift; fi   # optional JQL before the flags
TRANSITION=""; COMMENT=0
while [ $# -gt 0 ]; do case $1 in
  --transition) TRANSITION=${2:?transition name}; shift 2 ;;
  --comment) COMMENT=1; shift ;;
  *) echo "unknown flag $1"; exit 2 ;; esac; done
ROOT=$(cd "$(dirname "$0")/.." && pwd); OUT=$ROOT/spike/work/exp6; mkdir -p "$OUT"
exec > >(tee -a "$OUT/output.txt") 2>&1
echo "=== exp6 $(date -u +%FT%TZ) transition='${TRANSITION}' comment=$COMMENT"

EMAIL=$(security find-generic-password -s collie-jira | sed -n 's/^ *"acct"<blob>="\(.*\)"$/\1/p')
TOKEN=$(security find-generic-password -s collie-jira -w) || { echo "FAIL keychain: no collie-jira item"; exit 1; }
[ -n "$EMAIL" ] || { echo "FAIL keychain: collie-jira account field (email) is empty"; exit 1; }
BASIC=$(printf '%s:%s' "$EMAIL" "$TOKEN" | base64 | tr -d '\n'); unset TOKEN
trap 'unset BASIC' EXIT

# jr <METHOD> <url> <outname> [curl args...] -> prints HTTP status; body in $OUT/<outname>.json
jr() {
  local m=$1 u=$2 n=$3; shift 3
  printf 'header = "Authorization: Basic %s"\n' "$BASIC" |
    curl -sS --config - -X "$m" -H 'Accept: application/json' -o "$OUT/$n.json" -D "$OUT/$n.hdr" -w '%{http_code}' "$@" "$u"
}
j() { jq -r "$2" "$OUT/$1.json" 2>/dev/null; }
check() { if [ "$1" = "$2" ]; then echo "PASS $3 (HTTP $1)"; else echo "FAIL $3 (HTTP $1, want $2): $(jq -c '{errorMessages, errors, message, code}' "$OUT/$4.json" 2>/dev/null | cut -c1-300)"; fi; }
json() { jr "$1" "$2" "$3" -H 'Content-Type: application/json' --data "$4"; }

# --- 1. cloud id (no auth)
s=$(curl -sS -o "$OUT/tenant.json" -w '%{http_code}' "https://$SITE.atlassian.net/_edge/tenant_info")
check "$s" 200 "tenant_info" tenant
CLOUD=$(j tenant .cloudId); echo "  cloudId present: $([ -n "$CLOUD" ] && [ "$CLOUD" != null ] && echo yes || echo no)"
B=https://api.atlassian.com/ex/jira/$CLOUD/rest/api/3

# --- 2. myself
s=$(jr GET "$B/myself" myself); check "$s" 200 "GET /myself via api.atlassian.com" myself
echo "  accountType=$(j myself .accountType) active=$(j myself .active)"
s=$(jr GET "https://$SITE.atlassian.net/rest/api/3/myself" myself-site)
echo "INFO same call on the site URL (scoped tokens are expected to fail here): HTTP $s"

# --- 3. JQL search (enhanced endpoint)
s=$(json POST "$B/search/jql" search "$(jq -n --arg q "$JQL" '{jql:$q, maxResults:10, fields:["summary","status","issuelinks"]}')")
check "$s" 200 "JQL search (POST /search/jql)" search
echo "  issues: $(j search '[.issues[].key] | join(" ")')  nextPageToken: $(j search '.nextPageToken // "none"')"

# --- 4. issue links
s=$(jr GET "$B/issue/$ISSUE?fields=status,issuelinks" issue); check "$s" 200 "read $ISSUE with issuelinks" issue
echo "  status: $(j issue '.fields.status.name') (category $(j issue '.fields.status.statusCategory.key'))"
echo "  links: $(jq -c '[.fields.issuelinks[] | {type: .type.name, inward: .type.inward, outward: .type.outward, in: .inwardIssue.key, out: .outwardIssue.key, other_status: (.inwardIssue // .outwardIssue).fields.status.name}]' "$OUT/issue.json")"
s=$(jr GET "$B/issueLinkType" linktypes); echo "  link types (HTTP $s): $(j linktypes '[.issueLinkTypes[].name] | join(", ")')"

# --- 5. transitions
s=$(jr GET "$B/issue/$ISSUE/transitions" transitions); check "$s" 200 "list transitions" transitions
echo "  available: $(jq -c '[.transitions[] | {id, name, to: .to.name}]' "$OUT/transitions.json")"
if [ -n "$TRANSITION" ]; then
  FROM=$(j issue '.fields.status.name')
  TID=$(jq -r --arg n "$TRANSITION" '.transitions[] | select(.name == $n or .to.name == $n) | .id' "$OUT/transitions.json" | head -1)
  if [ -z "$TID" ]; then echo "FAIL no transition named '$TRANSITION'"; else
    s=$(json POST "$B/issue/$ISSUE/transitions" do-transition "{\"transition\":{\"id\":\"$TID\"}}")
    check "$s" 204 "perform transition '$TRANSITION' (id $TID)" do-transition
    jr GET "$B/issue/$ISSUE?fields=status" issue-after >/dev/null
    echo "  status now: $(j issue-after .fields.status.name) (was $FROM)"
    jr GET "$B/issue/$ISSUE/transitions" transitions-after >/dev/null
    echo "  to revert, re-run with: --transition \"$FROM\"   (available now: $(j transitions-after '[.transitions[].name] | join(", ")'))"
  fi
fi

# --- 6. comment (Atlassian Document Format)
if [ "$COMMENT" = 1 ]; then
  body='{"body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Collie Phase 0 spike: API comment test. Safe to delete."}]}]}}'
  s=$(json POST "$B/issue/$ISSUE/comment" comment "$body"); check "$s" 201 "add comment" comment
  echo "  comment id: $(j comment .id)"
fi
echo "=== done"
