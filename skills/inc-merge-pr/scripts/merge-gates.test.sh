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
  # head.sha = the real current HEAD so EVAL_HEAD resolves (== local HEAD) rather
  # than tripping the "PR head SHA not present locally" fail-safe. Cases that need
  # a distinct fetched head set head.sha to a real other commit explicitly.
  RHEAD=$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo abc)
  printf '{"draft":false,"mergeable_state":"clean","head":{"sha":"%s"},"user":{"login":"author"}}' "$RHEAD" > "$FIX/pull.json"
  printf '%s' '{"check_runs":[{"name":"build","status":"completed","conclusion":"success"}]}' > "$FIX/checkruns.json"
  printf '%s' '[]'                                                         > "$FIX/comments.json"
  mkfresh  'echo "DEFAULT=main"; echo "BEHIND=0"; echo "AHEAD=0"'          # no overlap
  mkthread 'echo "[]"; exit 0'                                            # empty thread map
  mkenv    'echo "STATUS: pass"'                                          # no new env vars
  git -C "$REPO" remote set-url origin git@github.com:acme/widgets.git 2>/dev/null
  rm -f "$REPO/deploy.md"   # no window rule by default -> just deploy
  unset GH_FAIL MERGE_GATES_SIGNALS_OVERRIDE
  RUNNER=run_drift   # default drift runner; real-git cases opt into run_drift_real
  ASSUME_CLEAN=1     # harness writes untracked fixtures; the dirty-tree test sets 0
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
    MERGE_GATES_ASSUME_CLEAN="${ASSUME_CLEAN:-1}" \
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
# Gate 4 engages only when the repo exposes a `db:check-drift` script AND the PR
# changes a DATABASE schema file. Two test hooks keep it hermetic:
#   MERGE_GATES_DB_SCHEMA_OVERRIDE (via $DB_OVR) injects the changed DB-schema
#     file list; MERGE_GATES_DRIFT_CMD_OVERRIDE injects the per-package check cmd.
# Real-git variants (run_drift_real) exercise the classifier + merge-base diff.

mkdrift() { printf '#!/usr/bin/env bash\n%s\n' "$1" > "$WORK/drift"; chmod +x "$WORK/drift"; }
DB_OVR=""
run_drift() {  # override-driven: $DB_OVR is the changed-DB-schema list
  ( cd "$REPO" && PATH="${PMBIN:+$PMBIN:}$BIN:$PATH" \
    MERGE_GATES_FRESHNESS_BIN="$WORK/freshness" \
    MERGE_GATES_THREADCACHE_BIN="$WORK/threadcache" \
    MERGE_GATES_ENVCHECK_BIN="$WORK/envcheck" \
    GH_FIXTURES="$FIX" GH_FAIL="${GH_FAIL:-}" \
    MERGE_GATES_DOW_OVERRIDE="$DOW" MERGE_GATES_HOUR_OVERRIDE="$HOUR" \
    MERGE_GATES_SIGNALS_OVERRIDE="${MERGE_GATES_SIGNALS_OVERRIDE:-}" \
    MERGE_GATES_DRIFT_CMD_OVERRIDE="${MERGE_GATES_DRIFT_CMD_OVERRIDE:-}" \
    MERGE_GATES_DB_SCHEMA_OVERRIDE="$DB_OVR" \
    MERGE_GATES_ASSUME_CLEAN="${ASSUME_CLEAN:-1}" \
    bash "$TARGET" 2>/dev/null )
}
run_drift_real() {  # real git: no DB/CMD/SIGNALS override; optional $PMBIN on PATH
  ( cd "$REPO" && PATH="${PMBIN:+$PMBIN:}$BIN:$PATH" \
    MERGE_GATES_FRESHNESS_BIN="$WORK/freshness" \
    MERGE_GATES_THREADCACHE_BIN="$WORK/threadcache" \
    MERGE_GATES_ENVCHECK_BIN="$WORK/envcheck" \
    GH_FIXTURES="$FIX" GH_FAIL="${GH_FAIL:-}" \
    MERGE_GATES_DOW_OVERRIDE="$DOW" MERGE_GATES_HOUR_OVERRIDE="$HOUR" \
    MERGE_GATES_ASSUME_CLEAN="${ASSUME_CLEAN:-1}" \
    bash "$TARGET" 2>/dev/null )
}
# assert VERDICT line; $2 want, $3 must-not; RUNNER selects run_drift|run_drift_real
check_drift() { local n="$1" w="$2" mn="${3:-}" r="${RUNNER:-run_drift}" got
  got=$($r | grep '^VERDICT:' || echo "<no verdict>")
  if ! printf '%s' "$got" | grep -qF "$w"; then FAIL=$((FAIL+1)); echo "FAIL - $n"; echo "    want: $w"; echo "    got: $got"; return; fi
  if [ -n "$mn" ] && printf '%s' "$got" | grep -qF "$mn"; then FAIL=$((FAIL+1)); echo "FAIL - $n (must-not '$mn')"; echo "    got: $got"; return; fi
  PASS=$((PASS+1)); }
check_drift_out() { local n="$1" w="$2" r="${RUNNER:-run_drift}" out
  out=$($r)   # capture fully; a `run | grep -q` pipe would SIGPIPE + pipefail-mask a match
  if printf '%s\n' "$out" | grep -qF "$w"; then PASS=$((PASS+1))
  else FAIL=$((FAIL+1)); echo "FAIL - $n"; echo "    want: $w"; echo "    GATE4: $(printf '%s\n' "$out" | grep -E 'GATE4_DRIFT|PKG\[|REASON=|NOTE=' | tr '\n' ' ')"; fi; }

# No DB-schema file changed -> clean no-op even with a check present. GO.
reset_case; unset MERGE_GATES_DRIFT_CMD_OVERRIDE; DB_OVR=""; MERGE_GATES_SIGNALS_OVERRIDE="none"
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
check_drift_out "no DB-schema change -> skip" "REASON=no database schema files changed in this PR"
check_drift "no DB-schema change -> GO" "VERDICT: GO"
rm -f "$REPO/package.json"

# DB-schema changed but no check covers it -> clean skip (no gate4 block).
reset_case; unset MERGE_GATES_DRIFT_CMD_OVERRIDE; rm -f "$REPO/package.json"
DB_OVR="apps/web/drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"
check_drift_out "DB-schema, no check -> skip" "REASON=no db:check-drift script covers the changed schema files"
check_drift "DB-schema, no check -> no gate4 block" "VERDICT: GO" "gate4-drift"

# Root check + DB-schema + pass -> GATE4 pass, GO (SIGNALS forced low to isolate).
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
check_drift_out "check passes -> GATE4 pass" "GATE4_DRIFT: pass"
check_drift "check passes -> GO" "VERDICT: GO" "gate4-drift"
rm -f "$REPO/package.json"

# Real drift -> hard BLOCK, output passed through per-package.
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"
mkdrift 'echo "Schema drift detected: production is missing column \"plans.plan_id\""; exit 1'
check_drift "real drift -> BLOCK" "gate4-drift"
check_drift_out "real drift -> classified drift" "GATE4_DRIFT: drift"
check_drift_out "real drift -> output passthrough" 'DRIFT[.]| Schema drift detected'
rm -f "$REPO/package.json"

# Missing DATABASE_URL -> unverifiable (not silent pass, not false drift).
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"
mkdrift 'echo "DATABASE_URL is not set; refuses to run"; exit 1'
check_drift "missing creds -> BLOCK" "gate4-drift"
check_drift_out "missing creds -> unverifiable" "GATE4_DRIFT: unverifiable"
rm -f "$REPO/package.json"

# Operational crash (not a drift report) -> unverifiable, never confirmed drift.
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"
mkdrift 'echo "Error: Cannot find module tsx"; exit 1'
check_drift_out "crash -> unverifiable not drift" "GATE4_DRIFT: unverifiable"
rm -f "$REPO/package.json"

# Package manager binary missing -> unverifiable block.
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="definitely-not-a-real-pm-bin-xyz run db:check-drift"
check_drift "missing PM binary -> BLOCK" "gate4-drift"
check_drift_out "missing PM binary -> unverifiable" "GATE4_DRIFT: unverifiable"
rm -f "$REPO/package.json"

# Monorepo: check lives in a workspace package (apps/web), discovered by walking
# up from the changed schema file, and run from that dir.
reset_case; rm -f "$REPO/package.json"; mkdir -p "$REPO/apps/web"
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/apps/web/package.json"
DB_OVR="apps/web/drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
check_drift_out "monorepo workspace -> discovered + PKG named" "PKG[apps/web]: pass"
rm -rf "$REPO/apps"

# Multi-workspace: two independently-deployed packages each with a check, both
# schemas changed. A pass in one must NOT vouch for the other -> worst wins.
reset_case; rm -f "$REPO/package.json"
mkdir -p "$REPO/apps/good" "$REPO/apps/bad"
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/apps/good/package.json"
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/apps/bad/package.json"
DB_OVR="$(printf 'apps/good/drizzle/schema.ts\napps/bad/drizzle/schema.ts')"
MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"
mkdrift 'case "$PWD" in *bad*) echo "Schema drift detected"; exit 1;; *) exit 0;; esac'
check_drift "multi-workspace, one drifts -> BLOCK" "gate4-drift"
check_drift_out "multi-workspace -> good passes" "PKG[apps/good]: pass"
check_drift_out "multi-workspace -> bad drifts" "PKG[apps/bad]: drift"
check_drift_out "multi-workspace -> worst wins (drift)" "GATE4_DRIFT: drift"
rm -rf "$REPO/apps"

# Per-package PM: a workspace with its own yarn.lock (no root lockfile) must run
# under yarn, not fall through to npm. A yarn stub on PATH proves the selection.
reset_case; unset MERGE_GATES_DRIFT_CMD_OVERRIDE; rm -f "$REPO/package.json"
mkdir -p "$REPO/apps/api" "$WORK/pmbin"
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/apps/api/package.json"
: > "$REPO/apps/api/yarn.lock"
printf '#!/usr/bin/env bash\necho "YARN_SELECTED for $*"; exit 1\n' > "$WORK/pmbin/yarn"; chmod +x "$WORK/pmbin/yarn"
DB_OVR="apps/api/drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; PMBIN="$WORK/pmbin"; unset MERGE_GATES_DRIFT_CMD_OVERRIDE
check_drift_out "per-package PM picks yarn from workspace lockfile" "YARN_SELECTED for run db:check-drift"
unset PMBIN; rm -rf "$REPO/apps" "$WORK/pmbin"

# Security NOTE: when the PR modifies the checker's own code, surface a review note.
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
DB_OVR="scripts/check-db-drift.ts drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
# Give the merge-base diff a checker-file change so CHECK_CODE_CHANGED fires.
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse main)"
mkdir -p "$REPO/scripts"; printf '// drift checker\n' > "$REPO/scripts/check-db-drift.ts"
git -C "$REPO" add scripts/check-db-drift.ts 2>/dev/null; git -C "$REPO" commit -q -m "edit drift checker"
# We committed after reset_case, so refresh the fixture PR head SHA to match local
# HEAD (otherwise EVAL_HEAD would trail local HEAD and trip the stale-checkout guard).
printf '{"draft":false,"mergeable_state":"clean","head":{"sha":"%s"},"user":{"login":"author"}}' "$(git -C "$REPO" rev-parse HEAD)" > "$FIX/pull.json"
check_drift_out "checker-code change -> security NOTE" "NOTE=this PR modifies the drift check's own code"
rm -f "$REPO/package.json"

# --- Real-git classifier + merge-base (fresh branches to avoid earlier commits) ---
# GraphQL / validation "schema" files are NOT database schema -> Gate 4 skips.
git -C "$REPO" checkout -q -B feat-graphql main
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse main)"
printf 'type User { id: ID! }\n' > "$REPO/schema.graphql"
git -C "$REPO" add schema.graphql 2>/dev/null; git -C "$REPO" commit -q -m "add graphql schema"
reset_case; RUNNER=run_drift_real
check_drift_out "graphql schema is not DB schema -> skip" "REASON=no database schema files changed in this PR"

# A Drizzle schema file IS database schema -> Gate 4 engages (here: no check -> skip-for-no-check, proving it got past the classifier).
git -C "$REPO" checkout -q -B feat-drizzle main
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse main)"
mkdir -p "$REPO/drizzle"; printf 'export const t = 1;\n' > "$REPO/drizzle/schema.ts"
git -C "$REPO" add drizzle/schema.ts 2>/dev/null; git -C "$REPO" commit -q -m "add drizzle schema"
reset_case; RUNNER=run_drift_real
check_drift_out "drizzle schema engages classifier" "REASON=no db:check-drift script covers the changed schema files"
rm -rf "$REPO/drizzle"

# Merge-base scope: a schema commit main gained AFTER divergence must not be
# attributed to this PR (three-dot diff, not two-dot working-tree-vs-tip).
git -C "$REPO" checkout -q -B feat-nochange main            # branch has no schema change
git -C "$REPO" checkout -q main
printf 'CREATE TABLE late (id int);\n' > "$REPO/late.sql"    # schema lands on main after divergence
git -C "$REPO" add late.sql 2>/dev/null; git -C "$REPO" commit -q -m "late schema on main"
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse main)"
git -C "$REPO" checkout -q feat-nochange
reset_case; RUNNER=run_drift_real
check_drift_out "post-divergence main schema not attributed to PR" "REASON=no database schema files changed in this PR"

# --- Gate 4 round-3: tamper edges, nested classifier, diff fail-safe ----------
# These mutate git heavily; each starts from the repo's root commit (clean of
# earlier tests' commits) so package.json/schema state is fully controlled.
fresh_from_root() {  # $1 = branch name; clean branch off the init commit, origin/main = init
  local root; root=$(git -C "$REPO" rev-list --max-parents=0 HEAD | tail -1)
  git -C "$REPO" checkout -q -f "$root" 2>/dev/null
  git -C "$REPO" clean -fdq 2>/dev/null
  git -C "$REPO" checkout -q -B "$1" 2>/dev/null
  git -C "$REPO" update-ref refs/remotes/origin/main "$root"
}

# Basic tamper: base branch has the only check; this PR removes it while changing
# schema, and no ancestor covers it -> hard block, not a silent skip.
fresh_from_root feat-tamper1
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
git -C "$REPO" add package.json 2>/dev/null; git -C "$REPO" commit -q -m "base has check"
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" rm -q package.json 2>/dev/null; git -C "$REPO" commit -q -m "remove check"
reset_case; RUNNER=run_drift; DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; unset MERGE_GATES_DRIFT_CMD_OVERRIDE
check_drift "removed sole check -> BLOCK" "gate4-drift"
check_drift_out "removed sole check -> tamper" "cannot be removed by the same PR"

# Ancestor-fallback tamper: the workspace deletes its OWN check but the repo root
# still defines one. The root check must NOT authorize the change - the workspace
# lost its guard, so the file's base owner (workspace) is more specific than its
# head owner (root) -> tamper, even though root's check passes.
fresh_from_root feat-tamper2
mkdir -p "$REPO/apps/web"; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/apps/web/package.json"
git -C "$REPO" add apps/web/package.json 2>/dev/null; git -C "$REPO" commit -q -m "base workspace check"
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse HEAD)"
printf '{"scripts":{"build":"tsc"}}' > "$REPO/apps/web/package.json"      # workspace drops its check
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"     # only the root now has one
git -C "$REPO" add -A 2>/dev/null; git -C "$REPO" commit -q -m "workspace drops check, root keeps one"
reset_case; RUNNER=run_drift; DB_OVR="apps/web/drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"
MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
check_drift "ancestor-fallback tamper -> BLOCK" "gate4-drift"
check_drift_out "ancestor-fallback -> gate tamper despite root check" "gate tamper"

# Nested db/schema/ tree (src/db/schema/users.ts) is recognized as DB schema.
fresh_from_root feat-nested
mkdir -p "$REPO/src/db/schema"; printf 'export const users = 1;\n' > "$REPO/src/db/schema/users.ts"
git -C "$REPO" add src/db/schema/users.ts 2>/dev/null; git -C "$REPO" commit -q -m "nested db schema"
reset_case; RUNNER=run_drift_real; unset MERGE_GATES_DRIFT_CMD_OVERRIDE
check_drift_out "nested db/schema tree is DB schema (engages)" "REASON=no db:check-drift script covers the changed schema files"

# Diff fail-safe: the merge-base diff cannot be computed (origin/<default> gone).
# With a check present the gate must BLOCK (unverifiable), not skip to GO.
fresh_from_root feat-nodiff
git -C "$REPO" update-ref -d refs/remotes/origin/main 2>/dev/null   # base ref gone -> diff fails
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
git -C "$REPO" add package.json 2>/dev/null
reset_case; RUNNER=run_drift_real
check_drift_out "uncomputable diff + check present -> BLOCK" "GATE4_DRIFT: unverifiable"
check_drift_out "uncomputable diff -> names the cause" "could not compute the merge-base schema diff"

# Same, but no check anywhere -> stays a clean no-op (skip), not a spurious block.
git -C "$REPO" rm -q --cached package.json 2>/dev/null; rm -f "$REPO/package.json"
git -C "$REPO" update-ref -d refs/remotes/origin/main 2>/dev/null
reset_case; RUNNER=run_drift_real
check_drift_out "uncomputable diff + no check -> skip" "nothing gates on it"

# --- Gate 4 round-4: negated-drift text, renames, fetched head, merge-base tamper
# Negated / error-prefixed drift text must NOT read as confirmed drift (it would
# wrongly recommend a production schema push off a run that found nothing / failed).
reset_case; RUNNER=run_drift; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"
mkdrift 'echo "No schema drift detected"; exit 1'
check_drift_out "negated drift text -> unverifiable" "GATE4_DRIFT: unverifiable"
mkdrift 'echo "Schema drift check failed: DATABASE_URL is not set"; exit 1'
check_drift_out "error-prefixed drift text -> unverifiable" "GATE4_DRIFT: unverifiable"
rm -f "$REPO/package.json"

# Rename OUT of a recognized tree: --no-renames must surface the old DB path so the
# gate still engages (git rename detection would otherwise show only the new path).
fresh_from_root feat-rename
mkdir -p "$REPO/drizzle"; printf 'export const t = 1;\n' > "$REPO/drizzle/schema.ts"
git -C "$REPO" add drizzle/schema.ts 2>/dev/null; git -C "$REPO" commit -q -m "base schema"
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" mv drizzle/schema.ts oldschema.txt 2>/dev/null; git -C "$REPO" commit -q -m "rename schema out of tree"
reset_case; RUNNER=run_drift_real; unset MERGE_GATES_DRIFT_CMD_OVERRIDE
check_drift_out "rename out of tree still engages (old path)" "REASON=no db:check-drift script covers the changed schema files"

# Fetched PR head: Gate 4 evaluates the PR head SHA (from Gate 2), not a stale
# local HEAD. HEAD here has no schema change; the fetched head (commit A) does.
fresh_from_root feat-evalhead
git -C "$REPO" checkout -q -b tmp-prhead
mkdir -p "$REPO/drizzle"; printf 'export const t = 1;\n' > "$REPO/drizzle/schema.ts"
git -C "$REPO" add drizzle/schema.ts 2>/dev/null; git -C "$REPO" commit -q -m "PR head adds schema"
A=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" checkout -q feat-evalhead     # local HEAD: no schema change
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse feat-evalhead)"
reset_case; RUNNER=run_drift_real
printf '%s' '[{"number":1,"head":{"ref":"feat-evalhead"}}]' > "$FIX/pulls_list.json"
printf '{"draft":false,"mergeable_state":"clean","head":{"sha":"'"$A"'"},"user":{"login":"author"}}' > "$FIX/pull.json"
check_drift_out "evaluates fetched PR head, not stale local HEAD" "REASON=no db:check-drift script covers the changed schema files"

# Merge-base tamper: the DEFAULT branch ADDS a workspace check after divergence
# while this PR changes a schema file there. That must NOT read as this PR deleting
# a gate (it never had one) -> no false tamper block.
fresh_from_root feat-basecheck
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"   # root check exists at divergence
git -C "$REPO" add package.json 2>/dev/null; git -C "$REPO" commit -q -m "root check at divergence"
DIV=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" checkout -q -B main-added "$DIV"                          # main branch adds a workspace check LATER
mkdir -p "$REPO/apps/web"; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/apps/web/package.json"
git -C "$REPO" add apps/web/package.json 2>/dev/null; git -C "$REPO" commit -q -m "main adds workspace check"
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse HEAD)"
git -C "$REPO" checkout -q -f feat-basecheck                            # feature: only the root check, no apps/web pkg
git -C "$REPO" clean -fdq 2>/dev/null
reset_case; RUNNER=run_drift; DB_OVR="apps/web/drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"
MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
check_drift_out "base-added check is not tamper (no false block)" "GATE4_DRIFT: pass"
check_drift "base-added check -> no gate4 block" "VERDICT" "gate4-drift"
rm -rf "$REPO/apps" "$REPO/package.json"

# --- Gate 4 round-5: stale-checkout exec guard, rc137 timeout, entrypoint change
# rc 137 (SIGKILL after the deadline) is reported as a timeout, not a blank result.
reset_case; RUNNER=run_drift; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"
mkdrift 'exit 137'
check_drift_out "rc137 -> unverifiable" "GATE4_DRIFT: unverifiable"
check_drift_out "rc137 -> named as deadline" "exceeded its 120s deadline"
rm -f "$REPO/package.json"

# Entrypoint change: the db:check-drift VALUE differs between merge base and head
# -> the security NOTE fires even though no checker-named file path changed.
fresh_from_root feat-entrypoint
printf '{"scripts":{"db:check-drift":"tsx old-checker.ts"}}' > "$REPO/package.json"
git -C "$REPO" add package.json 2>/dev/null; git -C "$REPO" commit -q -m "base checker"
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse HEAD)"
printf '{"scripts":{"db:check-drift":"tsx NEW-checker.ts"}}' > "$REPO/package.json"   # entrypoint changed in place
mkdir -p "$REPO/drizzle"; printf 'x\n' > "$REPO/drizzle/schema.ts"
git -C "$REPO" add -A 2>/dev/null; git -C "$REPO" commit -q -m "change checker entrypoint + schema"
reset_case; RUNNER=run_drift; DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"
MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
check_drift_out "entrypoint value change -> security NOTE" "NOTE=this PR modifies the drift check's own code"
rm -f "$REPO/package.json"; rm -rf "$REPO/drizzle"

# Stale-checkout execution guard: EVAL_HEAD (fetched PR head) has schema + a check,
# but the local checkout is behind it -> block rather than run the stale checker.
fresh_from_root feat-stale
git -C "$REPO" checkout -q -b tmp-stalehead
mkdir -p "$REPO/drizzle"; printf 'x\n' > "$REPO/drizzle/schema.ts"
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
git -C "$REPO" add -A 2>/dev/null; git -C "$REPO" commit -q -m "PR head: schema + check"
A=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" checkout -q feat-stale            # local HEAD is behind A
git -C "$REPO" clean -fdq 2>/dev/null
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse feat-stale)"
reset_case; RUNNER=run_drift_real
printf '%s' '[{"number":1,"head":{"ref":"feat-stale"}}]' > "$FIX/pulls_list.json"
printf '{"draft":false,"mergeable_state":"clean","head":{"sha":"'"$A"'"},"user":{"login":"author"}}' > "$FIX/pull.json"
check_drift_out "stale checkout vs fetched head -> BLOCK" "GATE4_DRIFT: unverifiable"
check_drift_out "stale checkout -> names the cause" "is behind the PR head"

# --- Gate 4 round-6: unresolvable head SHA, dirty tree, evaluated-head emission
# (These run on feature/x so the stubbed PR resolves and HEAD_SHA is populated.)

# GitHub reports a PR head SHA not present locally (fetch failed) -> fail-safe
# block rather than silently evaluating a different local commit.
git -C "$REPO" checkout -q -f feature/x 2>/dev/null; git -C "$REPO" clean -fdq 2>/dev/null
reset_case; RUNNER=run_drift; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
printf '%s' '{"draft":false,"mergeable_state":"clean","head":{"sha":"0000000000000000000000000000000000000000"},"user":{"login":"author"}}' > "$FIX/pull.json"
check_drift_out "unresolvable PR head SHA -> BLOCK" "GATE4_DRIFT: unverifiable"
check_drift_out "unresolvable PR head SHA -> named cause" "not present locally"
rm -f "$REPO/package.json"

# The evaluated head SHA is emitted so the merge step can pin to it.
reset_case; printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
check_drift_out "emits GATE4_EVAL_HEAD for merge pinning" "GATE4_EVAL_HEAD:"
rm -f "$REPO/package.json"

# Dirty working tree at the right commit: an untracked schema file makes the check
# evaluate code that isn't the committed PR head -> block (ASSUME_CLEAN off).
git -C "$REPO" checkout -q -f feature/x 2>/dev/null
git -C "$REPO" clean -fdq 2>/dev/null
mkdir -p "$REPO/drizzle"; printf 'export const t=1;\n' > "$REPO/drizzle/schema.ts"
printf '{"scripts":{"db:check-drift":"stub"}}' > "$REPO/package.json"
git -C "$REPO" add -A 2>/dev/null; git -C "$REPO" commit -q -m "committed schema + check"
reset_case; RUNNER=run_drift; ASSUME_CLEAN=0
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"; MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
printf '{"draft":false,"mergeable_state":"clean","head":{"sha":"%s"},"user":{"login":"author"}}' "$(git -C "$REPO" rev-parse HEAD)" > "$FIX/pull.json"
printf 'CREATE TABLE dirty (id int);\n' > "$REPO/drizzle/uncommitted.sql"   # untracked, dirty
check_drift_out "dirty working tree -> BLOCK" "GATE4_DRIFT: unverifiable"
check_drift_out "dirty working tree -> named cause" "uncommitted or untracked changes"
git -C "$REPO" clean -fdq 2>/dev/null

# A dirty file OUTSIDE the affected package (e.g. a shared checker the package
# imports) must also block - the whole tree must be clean, not just schema/pkg
# paths. Here the dirty file is neither a schema file nor under the affected dir.
printf 'console.log(1)\n' > "$REPO/shared-checker.js"   # untracked, unrelated path, not schema
check_drift_out "dirty file outside affected pkg -> BLOCK" "GATE4_DRIFT: unverifiable"
git -C "$REPO" clean -fdq 2>/dev/null; rm -f "$REPO/package.json"; rm -rf "$REPO/drizzle"

# --- Gate 4 round-8: unconditional unresolvable-head block, entrypoint-file edit
# Unresolvable head blocks even when the LOCAL tree exposes no check (the
# unavailable head could itself introduce both the schema change and the check).
git -C "$REPO" checkout -q -f feature/x 2>/dev/null; git -C "$REPO" clean -fdq 2>/dev/null
reset_case; RUNNER=run_drift; rm -f "$REPO/package.json"
DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"
printf '%s' '{"draft":false,"mergeable_state":"clean","head":{"sha":"0000000000000000000000000000000000000000"},"user":{"login":"author"}}' > "$FIX/pull.json"
check_drift_out "unresolvable head + no local check -> still BLOCK" "GATE4_DRIFT: unverifiable"
check_drift_out "unresolvable head (no check) -> named cause" "not present locally"

# A stable entrypoint (value unchanged, filename lacks the checker keywords) whose
# own script file the PR edits still fires the security NOTE.
fresh_from_root feat-entry2
printf '{"scripts":{"db:check-drift":"node scripts/db-guard.js"}}' > "$REPO/package.json"
mkdir -p "$REPO/scripts"; printf '// v1\n' > "$REPO/scripts/db-guard.js"
git -C "$REPO" add -A 2>/dev/null; git -C "$REPO" commit -q -m "base: guard + entrypoint"
git -C "$REPO" update-ref refs/remotes/origin/main "$(git -C "$REPO" rev-parse HEAD)"
printf '// v2 edited\n' > "$REPO/scripts/db-guard.js"          # entrypoint file edited, value unchanged
mkdir -p "$REPO/drizzle"; printf 'x\n' > "$REPO/drizzle/schema.ts"
git -C "$REPO" add -A 2>/dev/null; git -C "$REPO" commit -q -m "edit guard impl + schema"
reset_case; RUNNER=run_drift; DB_OVR="drizzle/schema.ts"; MERGE_GATES_SIGNALS_OVERRIDE="none"
MERGE_GATES_DRIFT_CMD_OVERRIDE="$WORK/drift"; mkdrift 'exit 0'
printf '{"draft":false,"mergeable_state":"clean","head":{"sha":"%s"},"user":{"login":"author"}}' "$(git -C "$REPO" rev-parse HEAD)" > "$FIX/pull.json"
check_drift_out "stable entrypoint file edit -> security NOTE" "NOTE=this PR modifies the drift check's own code"
rm -f "$REPO/package.json"; rm -rf "$REPO/scripts" "$REPO/drizzle"

# --- summary -------------------------------------------------------------
echo "-----------------------------------------"
echo "merge-gates.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
