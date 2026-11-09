#!/bin/bash
# Phase 0 spike, experiment 5: does Bitbucket Cloud support what Phase 6 needs?
#
#   spike/exp5-bitbucket.sh <WORKSPACE> <REPO>            run the checks
#   spike/exp5-bitbucket.sh <WORKSPACE> <REPO> --conflict re-check conflict signals on the last run's PRs
#   spike/exp5-bitbucket.sh <WORKSPACE> <REPO> --probe-conflict  try diffstat forms that might show conflicts
#   spike/exp5-bitbucket.sh <WORKSPACE> <REPO> --cleanup  decline the spike PRs, delete the spike branches
#
# Creates branches spike-collie-<ts>-{parent,child,conflict,push} with one file each, via the API (and
# one via git push for 5b). Never writes to the default branch. PRs are titled "[collie spike] ...".
#
# Token: keychain service collie-bitbucket, account $USER, read once at start and held in memory only.
# It reaches curl through stdin (--config -) and git through an inline credential helper that reads the
# keychain itself, so it is never in argv, the environment, a file, or the output.
# Output: a transcript in spike/work/exp5/ (git-ignored); raw response bodies next to it.
set -uo pipefail
WS=${1:?workspace}; REPO=${2:?repo}; MODE=${3:-run}
ROOT=$(cd "$(dirname "$0")/.." && pwd); OUT=$ROOT/spike/work/exp5; mkdir -p "$OUT"
API=https://api.bitbucket.org/2.0/repositories/$WS/$REPO
exec > >(tee -a "$OUT/output.txt") 2>&1
echo "=== exp5 $(date -u +%FT%TZ) mode=$MODE"

TOKEN=$(security find-generic-password -s collie-bitbucket -a "$USER" -w) || { echo "FAIL keychain: no collie-bitbucket item for $USER"; exit 1; }
trap 'unset TOKEN' EXIT

# bb <METHOD> <path> <outname> [curl args...]  -> prints HTTP status; body in $OUT/<outname>.json, headers in .hdr
bb() {
  local m=$1 p=$2 n=$3; shift 3
  printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" |
    curl -sS -L --config - -X "$m" -o "$OUT/$n.json" -D "$OUT/$n.hdr" -w '%{http_code}' "$@" "$API$p"
}
j() { jq -r "$2" "$OUT/$1.json" 2>/dev/null; }
check() { if [ "$1" = "$2" ]; then echo "PASS $3 (HTTP $1)"; else echo "FAIL $3 (HTTP $1, want $2): $(jq -c '.error // .' "$OUT/$4.json" 2>/dev/null | cut -c1-300)"; fi; }
json() { bb "$1" "$2" "$3" -H 'Content-Type: application/json' --data "$4"; }

STATE=$OUT/state.env
if [ "$MODE" = "--conflict" ]; then   # re-check merge-conflict signals on the PRs from the last run
  # shellcheck disable=SC1090
  . "$STATE" || { echo "no state file"; exit 1; }
  for id in $PR_CONFLICT $PR_STACK; do
    s=$(bb GET "/pullrequests/$id/diffstat" ds-$id)
    echo "PR $id diffstat HTTP $s: $(jq -c '[.values[]? | {status, path: (.new.path // .old.path)}]' "$OUT/ds-$id.json")"
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -sS -L --config - -o "$OUT/diff-$id.txt" "$API/pullrequests/$id/diff"
    echo "  conflict markers in diff: $(grep -cE '^\+(<<<<<<<|>>>>>>>)' "$OUT/diff-$id.txt")"
    s=$(bb GET "/pullrequests/$id" pr-$id); echo "  PR keys: $(jq -c 'keys' "$OUT/pr-$id.json")"
  done
  echo "  remotes saved in $OUT/git/.git/config: $(git -C "$OUT/git" remote -v | wc -l | tr -d ' ')"
  if grep -rqF -f <(printf '%s\n' "$TOKEN") "$OUT" 2>/dev/null; then echo "FAIL token found on disk under spike/work/exp5"; else echo "PASS token not found on disk under spike/work/exp5"; fi
  exit 0
fi
if [ "$MODE" = "--probe-conflict" ]; then   # which diffstat form reports the add/add conflict?
  # shellcheck disable=SC1090
  . "$STATE" || { echo "no state file"; exit 1; }
  for id in $PR_CONFLICT $PR_STACK; do
    bb GET "/pullrequests/$id" pr-$id >/dev/null
    SRC=$(j pr-$id .source.commit.hash); DST=$(j pr-$id .destination.commit.hash)
    echo "PR $id ($( [ "$id" = "$PR_CONFLICT" ] && echo 'expect conflict' || echo 'expect clean'))"
    for q in "/pullrequests/$id/diffstat?topic=false" "/diffstat/$SRC..$DST?merge=true" "/diffstat/$SRC..$DST?merge=true&topic=false" "/diffstat/$SRC..$DST"; do
      s=$(bb GET "$q" probe)
      echo "  $q -> HTTP $s: $(jq -c '[.values[]? | {status, path: (.new.path // .old.path)}] // .error.message' "$OUT/probe.json" | cut -c1-200)"
    done
  done
  exit 0
fi
if [ "$MODE" = "--cleanup" ]; then
  # shellcheck disable=SC1090
  . "$STATE" || { echo "no state file"; exit 1; }
  for id in $PR_STACK $PR_CONFLICT; do s=$(bb POST "/pullrequests/$id/decline" decline-$id); echo "decline PR $id: HTTP $s"; done
  for b in parent child conflict push; do s=$(bb DELETE "/refs/branches/$PREFIX-$b" del-$b); echo "delete $PREFIX-$b: HTTP $s"; done
  exit 0
fi

PREFIX=spike-collie-$(date +%s)
echo "PREFIX=$PREFIX" > "$STATE"

# --- 0. repo + token scopes
s=$(bb GET "" repo); check "$s" 200 "read repository" repo
MAIN=$(j repo .mainbranch.name); echo "default branch: $MAIN"
echo "scope headers:"; grep -iE '^x-(oauth-scopes|accepted-oauth-scopes|credential-type)' "$OUT/repo.hdr" | sed 's/^/  /'

# --- 1. branches + commits through the API (POST /src)
commit() { # commit <branch> <content> [parent-hash]
  local extra=(); [ -n "${3:-}" ] && extra=(--form-string "parents=$3")
  bb POST /src "src-$1" --form-string "spike-collie.txt=$2" --form-string "message=collie spike: $1" \
     --form-string "branch=$PREFIX-$1" "${extra[@]}"
}
head_of() { bb GET "/refs/branches/$PREFIX-$1" "ref-$1" >/dev/null; j "ref-$1" .target.hash; }
MAIN_HASH=$(bb GET "/refs/branches/$MAIN" ref-main >/dev/null; j ref-main .target.hash)
s=$(commit parent "parent version" "$MAIN_HASH"); check "$s" 201 "commit on new branch parent" src-parent
P_HASH=$(head_of parent)
s=$(commit child "parent version" "$P_HASH"); check "$s" 201 "commit on new branch child (stacked on parent)" src-child
s=$(commit conflict "conflicting version" "$MAIN_HASH"); check "$s" 201 "commit on new branch conflict" src-conflict

# --- 2. draft PR child -> parent
s=$(json POST /pullrequests pr-create "$(jq -n --arg s "$PREFIX-child" --arg d "$PREFIX-parent" \
  '{title:"[collie spike] stacked draft", source:{branch:{name:$s}}, destination:{branch:{name:$d}}, draft:true, close_source_branch:false}')")
check "$s" 201 "create draft PR" pr-create
PR=$(j pr-create .id); echo "PR_STACK=$PR" >> "$STATE"
echo "  draft=$(j pr-create .draft) state=$(j pr-create .state) dest=$(j pr-create .destination.branch.name)"

# --- 3. change destination branch
s=$(json PUT "/pullrequests/$PR" pr-retarget "$(jq -n --arg d "$MAIN" '{title:"[collie spike] stacked draft", destination:{branch:{name:$d}}}')")
check "$s" 200 "retarget PR to default branch" pr-retarget
echo "  dest=$(j pr-retarget .destination.branch.name) draft=$(j pr-retarget .draft) (draft kept after retarget?)"

# --- 4. mark ready
s=$(json PUT "/pullrequests/$PR" pr-ready '{"title":"[collie spike] stacked draft","draft":false}')
check "$s" 200 "mark ready (draft:false)" pr-ready
echo "  draft=$(j pr-ready .draft) state=$(j pr-ready .state)"
s=$(bb GET "/pullrequests/$PR" pr-reread); echo "  re-read: draft=$(j pr-reread .draft)"

# --- 5. approvals
echo "  participants: $(jq -c '[.participants[] | {role, approved, state}]' "$OUT/pr-reread.json")"
s=$(bb POST "/pullrequests/$PR/approve" pr-approve)
echo "INFO self-approve attempt: HTTP $s $(jq -c '.error.message // .approved' "$OUT/pr-approve.json" 2>/dev/null)"
s=$(bb GET "/pullrequests/$PR" pr-reread2); echo "  participants after: $(jq -c '[.participants[] | {role, approved, state}]' "$OUT/pr-reread2.json")"
[ "$(j pr-approve .approved)" = true ] && bb DELETE "/pullrequests/$PR/approve" pr-unapprove >/dev/null

# --- 6. conflict state: PR conflict -> parent (both add spike-collie.txt with different content)
s=$(json POST /pullrequests pr-conflict "$(jq -n --arg s "$PREFIX-conflict" --arg d "$PREFIX-parent" \
  '{title:"[collie spike] conflict probe", source:{branch:{name:$s}}, destination:{branch:{name:$d}}, draft:true}')")
check "$s" 201 "create conflict-probe PR" pr-conflict
PRC=$(j pr-conflict .id); echo "PR_CONFLICT=$PRC" >> "$STATE"
echo "  PR fields that might carry merge state: $(jq -c '{mergeable: .mergeable, merge_commit, conflicts: .conflicts}' "$OUT/pr-conflict.json")"
sleep 5   # diffstat is computed asynchronously
s=$(bb GET "/pullrequests/$PRC/diffstat" ds-conflict); echo "  diffstat (conflict PR) HTTP $s: $(jq -c '[.values[]? | {status, path: (.new.path // .old.path)}]' "$OUT/ds-conflict.json")"
s=$(bb GET "/pullrequests/$PR/diffstat" ds-clean);    echo "  diffstat (clean PR)    HTTP $s: $(jq -c '[.values[]? | {status, path: (.new.path // .old.path)}]' "$OUT/ds-clean.json")"
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" | curl -sS --config - -L -o "$OUT/diff-conflict.txt" "$API/pullrequests/$PRC/diff"
echo "  conflict markers in diff: $(grep -cE '^\+(<<<<<<<|>>>>>>>)' "$OUT/diff-conflict.txt" 2>/dev/null)"

# --- 5b. HTTPS fetch + push with a credential helper that reads the keychain itself
echo "--- 5b push"
G=$OUT/git; rm -rf "$G"; git init -q "$G"
HELPER='!f() { test "$1" = get || exit 0; echo username=x-token-auth; printf "password=%s\n" "$(security find-generic-password -s collie-bitbucket -a "$USER" -w)"; }; f'
gitc() { GIT_TERMINAL_PROMPT=0 git -C "$G" -c credential.helper= -c "credential.helper=$HELPER" "$@"; }
URL=https://bitbucket.org/$WS/$REPO.git
if gitc fetch -q --depth 1 "$URL" "$MAIN" && git -C "$G" checkout -q -b "$PREFIX-push" FETCH_HEAD; then
  echo "pushed by collie spike" > "$G/spike-collie-push.txt"
  git -C "$G" add spike-collie-push.txt && git -C "$G" -c user.name="collie spike" -c user.email="spike@example.invalid" commit -qm "collie spike: push test"
  if gitc push -q "$URL" "HEAD:refs/heads/$PREFIX-push"; then echo "PASS push over HTTPS via credential helper"; else echo "FAIL push"; fi
else echo "FAIL fetch over HTTPS via credential helper"; fi
echo "  remotes saved in .git/config: $(git -C "$G" remote -v | wc -l | tr -d ' ') (expect 0: URL passed per command)"
# token pattern goes in through an fd, not argv
if grep -rqF -f <(printf '%s\n' "$TOKEN") "$G/.git" "$OUT" 2>/dev/null; then echo "FAIL token found on disk under spike/work/exp5"; else echo "PASS token not found on disk under spike/work/exp5"; fi

echo "=== done. PRs: $PR (stack), $PRC (conflict). Re-check conflicts: $0 $WS $REPO --conflict ; clean up: $0 $WS $REPO --cleanup"
