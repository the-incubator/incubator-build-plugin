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
  rm -f "$REPO/deploy.md"   # no window rule by default -> just deploy
  unset GH_FAIL MERGE_GATES_SIGNALS_OVERRIDE
  DOW=2; HOUR=14   # Tuesday 2pm ET (only used for the emitted TIME context now)
}

run() {
  ( cd "$REPO" && PATH="$BIN:$PATH" \
    MERGE_GATES_FRESHNESS_BIN="$WORK/freshness" \
    MERGE_GATES_THREADCACHE_BIN="$WORK/threadcache" \
    MERGE_GATES_ENVCHECK_BIN="$WORK/envcheck" \
    GH_FIXTURES="$FIX" GH_FAIL="${GH_FAIL:-}" \
    MERGE_GATES_DOW_OVERRIDE="$DOW" MERGE_GATES_HOUR_OVERRIDE="$HOUR" \
    MERGE_GATES_SIGNALS_OVERRIDE="${MERGE_GATES_SIGNALS_OVERRIDE:-}" \
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

# assert full stdout contains $2 on some line (not just the VERDICT line).
check_out() {
  local name="$1" want="$2" out
  out=$(run)
  if printf '%s\n' "$out" | grep -qF "$want"; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1)); echo "FAIL - $name"; echo "    want substring: $want"
    echo "    got GATE3 lines: $(printf '%s\n' "$out" | grep -E 'GATE3_WINDOW|RULE=|RISK=' | tr '\n' ' ')"
  fi
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

# Gate 3 is now team-configured via a `Deploy window:` line in deploy.md.
# With no deploy.md (the reset_case default) there is no window rule, so the
# default is to just deploy - GO on any day/hour.
reset_case; rm -f "$REPO/deploy.md"; DOW=6; HOUR=3   # Saturday 3am
check "no window rule -> GO regardless of time" "VERDICT: GO"

reset_case; rm -f "$REPO/deploy.md"; DOW=2; HOUR=14  # Tuesday 2pm
check "no window rule (weekday) -> GO" "VERDICT: GO"

# An explicit "none" rule is treated the same as no rule.
reset_case; printf '## Deploy Configuration\n- Deploy window: none\n' > "$REPO/deploy.md"; DOW=6; HOUR=3
check "explicit none window -> GO" "VERDICT: GO"

# A trailing HTML comment on the field must not defeat the "none" normalization.
reset_case; printf '## Deploy Configuration\n- Deploy window: none  <!-- deploy anytime -->\n' > "$REPO/deploy.md"; DOW=6; HOUR=3
check "none with trailing comment -> GO" "VERDICT: GO"

# Non-standard casing: the detect grep is case-insensitive, so the prefix strip
# must be too - an uppercased "NONE" field must still normalize to no-rule.
reset_case; printf '## Deploy Configuration\n- DEPLOY WINDOW: none\n' > "$REPO/deploy.md"; DOW=6; HOUR=3
check "uppercase field + none -> GO" "VERDICT: GO"

# The emitted RULE= must have the label prefix stripped cleanly (no leading
# space, no "- Deploy window:" residue) so the orchestrator reads a clean rule.
reset_case; printf '## Deploy Configuration\n- Deploy window: Mon-Thu after 1pm ET; freeze Fri-Sun\n' > "$REPO/deploy.md"
check_out "RULE prefix stripped clean" "RULE=Mon-Thu after 1pm ET; freeze Fri-Sun"

# Fallback chain: with no deploy.md, a rule in CLAUDE.md is still honored.
reset_case; rm -f "$REPO/deploy.md"; printf '# repo\n- Deploy window: Mon-Thu after 1pm ET\n' > "$REPO/CLAUDE.md"
check "window rule via CLAUDE.md fallback -> NEEDS_DECISION" "gate3-window-decision"
rm -f "$REPO/CLAUDE.md"

# A real window rule -> NEEDS_DECISION so the orchestrator evaluates now-vs-rule.
reset_case; printf '## Deploy Configuration\n- Deploy window: Mon-Thu after 1pm ET; freeze Fri-Sun\n' > "$REPO/deploy.md"; DOW=2; HOUR=14
check "window rule present -> NEEDS_DECISION" "NEEDS_DECISION" "BLOCK"
check "window rule reason" "gate3-window-decision"

# A window rule does not override a hard gate: env-var block still BLOCKs.
reset_case; printf '## Deploy Configuration\n- Deploy window: Mon-Thu after 1pm ET\n' > "$REPO/deploy.md"
mkenv 'echo "STATUS: warn"; echo "NEW_VARS:"; echo "  - FOO"; echo "PASTE_BLOCK:"; echo "FOO="'
check "hard gate outranks window rule -> BLOCK" "BLOCK" "NEEDS_DECISION"
rm -f "$REPO/deploy.md"

# Default posture (no window rule) is risk-adaptive: a low-risk change (no
# signals) just ships; an elevated-risk change prompts a confirm.
reset_case; MERGE_GATES_SIGNALS_OVERRIDE="none"
check "no rule + low risk -> GO" "VERDICT: GO"

reset_case; MERGE_GATES_SIGNALS_OVERRIDE="largediff"
check "no rule + elevated risk -> NEEDS_DECISION" "NEEDS_DECISION" "BLOCK"
check "no rule + elevated risk reason" "gate3-risk-confirm"

reset_case; MERGE_GATES_SIGNALS_OVERRIDE="schema backfill"
check "no rule + schema/backfill -> risk-confirm" "gate3-risk-confirm"

# A hard gate still outranks an elevated-risk confirm.
reset_case; MERGE_GATES_SIGNALS_OVERRIDE="largediff"; mkfresh 'exit 1'
check "hard gate outranks risk-confirm -> BLOCK" "BLOCK" "NEEDS_DECISION"

# A configured window rule takes precedence over the risk-confirm path (the rule
# branch already weighs risk signals when the window is closed).
reset_case; printf '## Deploy Configuration\n- Deploy window: Mon-Thu after 1pm ET\n' > "$REPO/deploy.md"
MERGE_GATES_SIGNALS_OVERRIDE="largediff"
check "window rule wins over risk-confirm" "gate3-window-decision" "gate3-risk-confirm"
rm -f "$REPO/deploy.md"

# Real risk-signal computation (no override): a .sql file in the diff vs
# origin/main fires the `schema` signal -> elevated -> gate3-risk-confirm. This
# exercises the actual classifier, not the MERGE_GATES_SIGNALS_OVERRIDE hook.
# Placed last because it mutates the test repo's git state (adds a commit + an
# origin/main ref); nothing runs after it except the summary.
reset_case
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse main)"
printf 'CREATE TABLE t (id int);\n' > "$REPO/migration.sql"
git -C "$REPO" add migration.sql 2>/dev/null; git -C "$REPO" commit -q -m "add schema migration"
check "real .sql diff -> schema signal -> risk-confirm" "gate3-risk-confirm"
check_out "real schema signal emitted" "SIGNALS=schema"

# --- Gate 4: schema drift ------------------------------------------------
# The drift gate only engages when the repo exposes a `db:check-drift` script
# AND the diff touches schema. It runs the repo's own read-only check; a stub
# is injected via MERGE_GATES_DRIFT_CMD_OVERRIDE so no real DB is needed.

# Helper: point the drift override at a stub with a given exit + output.
mkdrift() { printf '#!/usr/bin/env bash\n%s\n' "$1" > "$WORK/drift"; chmod +x "$WORK/drift"; }
run_drift() {
  ( cd "$REPO" && PATH="$BIN:$PATH" \
    MERGE_GATES_FRESHNESS_BIN="$WORK/freshness" \
    MERGE_GATES_THREADCACHE_BIN="$WORK/threadcache" \
    MERGE_GATES_ENVCHECK_BIN="$WORK/envcheck" \
    GH_FIXTURES="$FIX" GH_FAIL="${GH_FAIL:-}" \
    MERGE_GATES_DOW_OVERRIDE="$DOW" MERGE_GATES_HOUR_OVERRIDE="$HOUR" \
    MERGE_GATES_SIGNALS_OVERRIDE="${MERGE_GATES_SIGNALS_OVERRIDE:-}" \
    MERGE_GATES_DRIFT_CMD_OVERRIDE="${MERGE_GATES_DRIFT_CMD_OVERRIDE:-}" \
    bash "$TARGET" 2>/dev/null )
}
check_drift() {  # name, want-substring-in-VERDICT, [must-not]
  local name="$1" want="$2" mustnot="${3:-}" got
  got=$(run_drift | grep '^VERDICT:' || echo "<no verdict>")
  if ! printf '%s' "$got" | grep -qF "$want"; then
    FAIL=$((FAIL+1)); echo "FAIL - $name"; echo "    want substring: $want"; echo "    got: $got"; return
  fi
  if [ -n "$mustnot" ] && printf '%s' "$got" | grep -qF "$mustnot"; then
    FAIL=$((FAIL+1)); echo "FAIL - $name (must-not matched '$mustnot')"; echo "    got: $got"; return
  fi
  PASS=$((PASS+1))
}
check_drift_out() {  # name, want-substring-anywhere
  local name="$1" want="$2" out
  out=$(run_drift)   # capture fully first; a `run | grep -q` pipe would SIGPIPE
                     # the script and pipefail would then mask a real match.
  if printf '%s\n' "$out" | grep -qF "$want"; then PASS=$((PASS+1))
  else FAIL=$((FAIL+1)); echo "FAIL - $name"; echo "    want substring: $want"
    echo "    got GATE4 lines: $(printf '%s\n' "$out" | grep 'GATE4_DRIFT' | tr '\n' ' ')"; fi
}

# No package.json at all -> the gate is a clean no-op (skip), overall GO.
reset_case; rm -f "$REPO/package.json"; MERGE_GATES_SIGNALS_OVERRIDE="none"
check_drift_out "no package.json -> GATE4 skip" "GATE4_DRIFT: skip"
check_drift "no package.json -> GO" "VERDICT: GO"

# package.json without a db:check-drift script -> skip (generic no-op).
reset_case; printf '{"scripts":{"build":"tsc"}}' > "$REPO/package.json"; MERGE_GATES_SIGNALS_OVERRIDE="none"
check_drift_out "no db:check-drift script -> skip" "REASON=no db:check-drift script"
check_drift "no db:check-drift script -> GO" "VERDICT: GO"
rm -f "$REPO/package.json"

# Script present but the diff touches no schema files -> skip (do not run the
# check on non-schema PRs; they cannot introduce drift).
reset_case; printf '{"scripts":{"db:check-drift":"true"}}' > "$REPO/package.json"; MERGE_GATES_SIGNALS_OVERRIDE="none"
check_drift_out "script present, no schema diff -> skip" "REASON=db:check-drift present but this diff touches no schema files"
check_drift "script present, no schema diff -> GO" "VERDICT: GO"
rm -f "$REPO/package.json"

# Script present + schema signal + check passes -> GATE4 pass (no drift block).
# (A schema PR is still NEEDS_DECISION via gate3 risk-confirm; gate4 adds no block.)
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
MERGE_GATES_SIGNALS_OVERRIDE="schema"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
check_drift_out "schema + check passes -> GATE4 pass" "GATE4_DRIFT: pass"
check_drift "schema + check passes -> no drift block" "gate3-risk-confirm" "gate4-drift"
rm -f "$REPO/package.json"

# Script present + schema signal + real drift (production missing a column) ->
# hard BLOCK with gate4-drift, and the check's own output passes through.
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
MERGE_GATES_SIGNALS_OVERRIDE="schema"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"
mkdrift 'echo "production is missing column \"plans.plan_id\""; echo "Run db:push against prod, then re-run."; exit 1'
check_drift "real drift -> BLOCK" "BLOCK" "NEEDS_DECISION"
check_drift "real drift -> gate4-drift reason" "gate4-drift"
check_drift_out "real drift -> classified as drift" "GATE4_DRIFT: drift"
check_drift_out "real drift -> output passed through" 'DRIFT| production is missing column'
rm -f "$REPO/package.json"

# Script present + schema signal + check cannot run (no DATABASE_URL) ->
# hard BLOCK, classified unverifiable (honest degraded behavior, not a silent pass).
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
MERGE_GATES_SIGNALS_OVERRIDE="schema"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"
mkdrift 'echo "DATABASE_URL is not set; refuses to run"; exit 1'
check_drift "missing creds -> BLOCK not GO" "BLOCK" "GO"
check_drift "missing creds -> gate4-drift reason" "gate4-drift"
check_drift_out "missing creds -> classified unverifiable" "GATE4_DRIFT: unverifiable"
rm -f "$REPO/package.json"

# Package manager binary missing -> unverifiable block, not misclassified as drift.
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
MERGE_GATES_SIGNALS_OVERRIDE="schema"; MERGE_GATES_DRIFT_CMD_OVERRIDE="definitely-not-a-real-pm-bin-xyz run db:check-drift"
check_drift "missing PM binary -> BLOCK" "gate4-drift"
check_drift_out "missing PM binary -> unverifiable" "GATE4_DRIFT: unverifiable"
rm -f "$REPO/package.json"

# --- summary -------------------------------------------------------------
echo "-----------------------------------------"
echo "merge-gates.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
