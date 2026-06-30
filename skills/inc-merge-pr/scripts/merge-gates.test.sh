#!/usr/bin/env bash
# merge-gates.test.sh - golden-output tests for merge-gates.sh.
#
# Stubs gh + the three helpers (branch-freshness, gh-thread-cache,
# check-env-vars.sh) + the clock, so the verdict logic runs entirely from
# fixtures. Asserts the exact VERDICT line for each case - especially the
# fail-open holes a review of this script flagged: a rate-limited CI query and
# an unparseable git remote must BLOCK, never GO.
#
# Run: bash skills/inc-merge-pr/scripts/merge-gates.test.sh
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TARGET="$SCRIPT_DIR/merge-gates.sh"
PASS=0; FAIL=0
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# A real git repo so git rev-parse/config/diff work; only external deps stubbed.
REPO="$WORK/repo"; mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email t@t.t; git -C "$REPO" config user.name t
git -C "$REPO" remote add origin git@github.com:acme/widgets.git
git -C "$REPO" commit -q --allow-empty -m init
git -C "$REPO" branch -M main
git -C "$REPO" checkout -q -b feature/x

# Stub `gh` on PATH; serves fixtures from $GH_FIXTURES, honors GH_FAIL=<substr>.
BIN="$WORK/bin"; mkdir -p "$BIN"
cat > "$BIN/gh" <<'EOF'
#!/usr/bin/env bash
path="$*"
emit() { cat "$GH_FIXTURES/$1" 2>/dev/null || printf '%s' "$2"; }
if [ -n "${GH_FAIL:-}" ] && [[ "$path" == *"${GH_FAIL}"* ]]; then
  printf '%s' '{"message":"API rate limit exceeded"}'; exit 1
fi
case "$path" in
  *"/pulls?state=open"*)        emit pulls_list.json '[]' ;;
  *"/pulls/"*"/comments"*)      emit comments.json '[]' ;;
  *"/commits/"*"/check-runs"*)  emit checkruns.json '{"check_runs":[]}' ;;
  *"/pulls/"*)                  emit pull.json '{}' ;;
  *) printf '%s' '{}' ;;
esac
EOF
chmod +x "$BIN/gh"

# Helper-stub writers.
mkfresh()  { printf '#!/usr/bin/env bash\n%s\n' "$1" > "$WORK/freshness";   chmod +x "$WORK/freshness"; }
mkthread() { printf '#!/usr/bin/env bash\n%s\n' "$1" > "$WORK/threadcache"; chmod +x "$WORK/threadcache"; }
mkenv()    { printf '#!/usr/bin/env bash\n%s\n' "$1" > "$WORK/envcheck";    chmod +x "$WORK/envcheck"; }

# Default-happy fixtures + stubs (each case overrides what it needs).
reset_case() {
  FIX="$WORK/fix"; rm -rf "$FIX"; mkdir -p "$FIX"
  printf '%s' '[{"number":1,"head":{"ref":"feature/x"}}]'                 > "$FIX/pulls_list.json"
  printf '%s' '{"draft":false,"mergeable_state":"clean","head":{"sha":"abc"},"user":{"login":"author"}}' > "$FIX/pull.json"
  printf '%s' '{"check_runs":[{"name":"build","status":"completed","conclusion":"success"}]}' > "$FIX/checkruns.json"
  printf '%s' '[]'                                                         > "$FIX/comments.json"
  mkfresh  'echo "DEFAULT=main"; echo "BEHIND=0"; echo "AHEAD=0"'          # no overlap
  mkthread 'echo "[]"; exit 0'                                            # empty thread map
  mkenv    'echo "STATUS: pass"'                                          # no new env vars
  git -C "$REPO" remote set-url origin git@github.com:acme/widgets.git 2>/dev/null
  unset GH_FAIL
  DOW=2; HOUR=14   # Tuesday 2pm ET -> window open
}

run() {
  ( cd "$REPO" && PATH="$BIN:$PATH" \
    MERGE_GATES_FRESHNESS_BIN="$WORK/freshness" \
    MERGE_GATES_THREADCACHE_BIN="$WORK/threadcache" \
    MERGE_GATES_ENVCHECK_BIN="$WORK/envcheck" \
    GH_FIXTURES="$FIX" GH_FAIL="${GH_FAIL:-}" \
    MERGE_GATES_DOW_OVERRIDE="$DOW" MERGE_GATES_HOUR_OVERRIDE="$HOUR" \
    bash "$TARGET" 2>/dev/null )
}

# assert the VERDICT line contains $2; assert it does NOT contain $3 (optional).
check() {
  local name="$1" want="$2" mustnot="${3:-}" out got
  out=$(run); got=$(printf '%s\n' "$out" | grep '^VERDICT:' || echo "<no verdict>")
  if ! printf '%s' "$got" | grep -qF "$want"; then
    FAIL=$((FAIL+1)); echo "FAIL - $name"; echo "    want substring: $want"; echo "    got:            $got"; return
  fi
  if [ -n "$mustnot" ] && printf '%s' "$got" | grep -qF "$mustnot"; then
    FAIL=$((FAIL+1)); echo "FAIL - $name (must-not matched '$mustnot')"; echo "    got: $got"; return
  fi
  PASS=$((PASS+1))
}

# --- cases ---------------------------------------------------------------

reset_case
check "all-clear -> GO" "VERDICT: GO"

reset_case; mkfresh 'echo "DEFAULT=main"; echo "BEHIND=1"; echo "AHEAD=1"; echo "OVERLAP=src/app.ts"'
check "path overlap -> BLOCK" "BLOCK" ; check "path overlap reason" "preflight-overlap"

# Freshness helper crash/empty output must fail-safe to BLOCK, never emit a
# false "ok" that lets GO through without verifying path overlap.
reset_case; mkfresh 'exit 1'
check "freshness helper failure -> BLOCK not GO" "BLOCK" "GO"
check "freshness helper failure -> preflight reason" "preflight"

reset_case; mkenv 'echo "STATUS: warn"; echo "NEW_VARS:"; echo "  - FOO"; echo "PASTE_BLOCK:"; echo "FOO="'
check "new env var -> BLOCK" "gate1-env"

reset_case; printf '%s' '{"draft":true,"mergeable_state":"clean","head":{"sha":"abc"},"user":{"login":"author"}}' > "$FIX/pull.json"
check "draft PR -> BLOCK" "gate2-health"

reset_case; printf '%s' '{"check_runs":[{"name":"test","status":"completed","conclusion":"failure"}]}' > "$FIX/checkruns.json"
check "CI failing -> BLOCK" "gate2-health"

# P0 #1: rate-limited check-runs returns an error body on a non-zero exit.
# Must BLOCK, never GO (the bug: jq parsed the error body as an empty run set).
reset_case; GH_FAIL="/check-runs"
check "CI rate-limit -> BLOCK not GO" "BLOCK" "GO"
check "CI rate-limit -> gate2-health" "gate2-health"

# P0 #2: unparseable git remote -> Gate 2 cannot be evaluated. Must BLOCK.
reset_case; git -C "$REPO" remote set-url origin "file:///local/only"
check "unparseable remote -> BLOCK not GO" "BLOCK" "GO"

reset_case
printf '%s' '[{"number":1,"head":{"ref":"feature/x"}}]' > "$FIX/pulls_list.json"
mkthread 'echo "{\"threads\":[{\"path\":\"a.ts\",\"isResolved\":false,\"isOutdated\":false,\"comments\":[{\"id\":\"N1\",\"author\":\"greptile-apps[bot]\"}]}]}"; exit 0'
printf '%s' '[{"node_id":"N1","id":1,"in_reply_to_id":null,"path":"a.ts","created_at":"2026-01-01T00:00:00Z","user":{"login":"greptile-apps[bot]"},"body":"risky"}]' > "$FIX/comments.json"
check "unresolved precise thread -> BLOCK" "gate2-health"

# Degraded thread path: thread cache unavailable (exit 1), reviewer left the last
# comment -> unresolved -> BLOCK.
reset_case; mkthread 'echo "[]"; exit 1'
printf '%s' '[{"node_id":"N2","id":2,"in_reply_to_id":null,"path":"b.ts","created_at":"2026-01-01T00:00:00Z","user":{"login":"reviewer"},"body":"please fix"}]' > "$FIX/comments.json"
check "unresolved degraded thread -> BLOCK" "gate2-health"

reset_case; DOW=2; HOUR=10   # Tue 10am -> too early
check "too-early -> NEEDS_DECISION" "NEEDS_DECISION" "BLOCK"
check "too-early reason" "gate3-too-early"

reset_case; DOW=6; HOUR=15   # Saturday -> off-hours
check "off-hours -> NEEDS_DECISION" "NEEDS_DECISION"
check "off-hours reason" "gate3-offhours-decision"

reset_case; DOW=2; HOUR=13   # exactly 1pm -> window open
check "1pm boundary -> GO" "VERDICT: GO"

reset_case; DOW=2; HOUR=12   # 12pm -> too early
check "12pm boundary -> NEEDS_DECISION" "gate3-too-early"

# --- summary -------------------------------------------------------------
echo "-----------------------------------------"
echo "merge-gates.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
