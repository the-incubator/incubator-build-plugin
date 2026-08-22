#!/usr/bin/env bash
# merge-gates - run every deterministic merge-pr gate in one pass and emit a
# single structured verdict block.
#
# Replaces ~12 separate model-mediated Bash calls (freshness, env vars, the four
# Gate 2 sub-checks, the conditional Gate 4 schema-drift check, Gate 3 signals)
# with one call the orchestrator reads once.
# The script does the deterministic work; the SKILL.md keeps only the branches
# that need judgment (env-var paste confirmation, unresolved-thread handling,
# evaluating a configured deploy-window rule against the clock). Deploy-observation
# readiness (auth probe, AskUserQuestion) is interactive and stays in the skill.
#
# Usage:
#   merge-gates.sh
#
# Resolves its own location to find sibling helpers (branch-freshness,
# gh-thread-cache at <plugin root>/scripts/, check-env-vars.sh alongside this
# file). No arguments; it reads the current branch and git remote.
#
# Output: a single `=== MERGE GATES ===` block of stable KV lines on stdout.
# Exit code is advisory only (0 = GO, 1 = BLOCK, 2 = NEEDS_DECISION); the
# orchestrator branches on the VERDICT line, not the exit code.
#
# FAIL-SAFE INVARIANT: a gate that cannot be verified (helper crashed, gh
# errored, quota exhausted, unparseable input) is treated as a BLOCK, never as
# a pass. Every gate carries an explicit blocked flag; the verdict is computed
# from those flags, never from a string sentinel that an equality test might
# miss. The script never aborts mid-gate, so one failing call cannot leave the
# orchestrator without a verdict block to read.
#
# Test hooks (all optional; default to the real dependency):
#   MERGE_GATES_DOW_OVERRIDE / MERGE_GATES_HOUR_OVERRIDE  - inject day/hour
#   MERGE_GATES_SIGNALS_OVERRIDE  - inject the Gate 3 risk signals ("none" or a
#     space-separated list) instead of computing them from the diff
#   MERGE_GATES_DRIFT_CMD_OVERRIDE  - replace the detected `<pm> run db:check-drift`
#     invocation for Gate 4 with an arbitrary command (drive the gate from a stub)
#   MERGE_GATES_DB_SCHEMA_OVERRIDE  - inject the changed DB-schema file list for
#     Gate 4 instead of computing it from the merge-base diff
#   MERGE_GATES_FRESHNESS_BIN / MERGE_GATES_THREADCACHE_BIN / MERGE_GATES_ENVCHECK_BIN
#   plus stubbing `gh` / `git` on PATH - drive the gate logic from fixtures.

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# <plugin root>/scripts holds the shared helpers; this file is at
# <plugin root>/skills/inc-merge-pr/scripts/.
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/../../.." && pwd)
SHARED="$PLUGIN_ROOT/scripts"

FRESHNESS_BIN="${MERGE_GATES_FRESHNESS_BIN:-$SHARED/branch-freshness}"
THREADCACHE_BIN="${MERGE_GATES_THREADCACHE_BIN:-$SHARED/gh-thread-cache}"
ENVCHECK_BIN="${MERGE_GATES_ENVCHECK_BIN:-$SCRIPT_DIR/check-env-vars.sh}"

# run_bounded SECS CMD... - run a command under a wall-clock limit, portably.
# Prefers coreutils `timeout`/`gtimeout`; on stock macOS (neither installed) it
# falls back to a bash watchdog that puts the command in its own process group
# (`set -m`) and SIGTERMs the whole group - so an unreachable-DB drift check that
# spawns a grandchild client can't outlive the deadline and wedge the gate pass.
# Returns the command's exit code, or 124 if the deadline fired (matching timeout).
run_bounded() {
  local secs="$1"; shift
  # -k 5: if TERM is caught/ignored, follow with KILL 5s later (a resistant DB
  # client must not survive the deadline). Same escalation in the bash fallback.
  if command -v timeout >/dev/null 2>&1; then timeout -k 5 "$secs" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout -k 5 "$secs" "$@"; return $?; fi
  local had_m=0; case "$-" in *m*) had_m=1;; esac
  set -m
  local fired; fired=$(mktemp)
  "$@" & local cmd_pid=$!
  # On deadline: mark fired, TERM the whole group, then KILL 5s later if TERM was
  # caught/ignored. The marker (not "is the watchdog still alive?") tells us it
  # fired, since the watchdog now lingers during the KILL grace period.
  { sleep "$secs"; echo 1 > "$fired"; kill -TERM -"$cmd_pid" 2>/dev/null; sleep 5; kill -KILL -"$cmd_pid" 2>/dev/null; } >/dev/null 2>&1 & local wd_pid=$!
  wait "$cmd_pid" 2>/dev/null; local rc=$?
  [ -s "$fired" ] && rc=124                              # deadline fired -> timed out
  # KILL the ENTIRE process group before returning. When the leader exits on TERM
  # but a DB-client descendant ignores it, that descendant would otherwise keep
  # the command-substitution output pipe open and hang the caller past both
  # deadlines. Signalling the group (-cmd_pid, valid while any member lives)
  # reaps it now rather than cancelling the watchdog and hoping.
  kill -KILL -"$cmd_pid" 2>/dev/null
  kill -KILL "$wd_pid" 2>/dev/null; wait "$wd_pid" 2>/dev/null   # reap the watchdog itself
  rm -f "$fired"
  [ "$had_m" = "0" ] && set +m
  return $rc
}

echo "=== MERGE GATES ==="

# Per-gate blocked flags drive the verdict. 1 = this gate blocks the merge.
PREFLIGHT_BLOCKED=0   # default-branch, path overlap, or freshness error
GATE1_BLOCKED=0       # new env vars, or env-check could not run
GATE2_BLOCKED=0       # draft / CI / threads / mergeable / could not verify
GATE4_BLOCKED=0       # schema drift vs production, or drift check could not run
OVERLAP=""

# ---------------------------------------------------------------------------
# Pre-flight: branch freshness (path overlap)
# ---------------------------------------------------------------------------
PR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
DEFAULT_BRANCH=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)
[ "$DEFAULT_BRANCH" = "HEAD" ] && DEFAULT_BRANCH=""
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}

if [ -z "$PR_BRANCH" ]; then
  echo "PREFLIGHT_FRESHNESS: error"
  echo "  REASON=not in a git repo / detached HEAD"
  PREFLIGHT_BLOCKED=1
elif [ "$PR_BRANCH" = "$DEFAULT_BRANCH" ]; then
  # merge-pr operates on a PR's feature branch. On the default branch there's no
  # PR to merge; freshness would compare main against main and pass silently.
  echo "PREFLIGHT_FRESHNESS: block_default_branch"
  echo "  REASON=on default branch ($PR_BRANCH); check out the PR's feature branch and re-run"
  PREFLIGHT_BLOCKED=1
else
  FRESH_OUT=$(bash "$FRESHNESS_BIN" --pr-branch "$PR_BRANCH" 2>/dev/null); FRESH_RC=$?
  if [ "$FRESH_RC" -ne 0 ] || ! printf '%s\n' "$FRESH_OUT" | grep -q '^BEHIND='; then
    # The freshness helper crashed, is missing, or produced no usable output.
    # Without this guard the `|| true` swallow left OVERLAP empty and emitted a
    # false "ok" - letting VERDICT: GO through without ever verifying path
    # overlap. Fail-safe: an unverifiable freshness check blocks.
    echo "PREFLIGHT_FRESHNESS: error"
    echo "  REASON=branch-freshness helper failed or produced no output; path overlap could not be verified"
    PREFLIGHT_BLOCKED=1
  else
    BEHIND=$(printf '%s\n' "$FRESH_OUT" | sed -n 's/^BEHIND=//p' | head -n1)
    OVERLAP=$(printf '%s\n' "$FRESH_OUT" | sed -n 's/^OVERLAP=//p')
    OVERLAP_COUNT=$(printf '%s' "$OVERLAP" | grep -c . || true)
    if [ -n "$OVERLAP" ]; then
      echo "PREFLIGHT_FRESHNESS: block_overlap"
      PREFLIGHT_BLOCKED=1
    else
      echo "PREFLIGHT_FRESHNESS: ok"
    fi
    echo "  DEFAULT=$DEFAULT_BRANCH"
    echo "  BEHIND=${BEHIND:-0}"
    echo "  OVERLAP_COUNT=${OVERLAP_COUNT:-0}"
    if [ -n "$OVERLAP" ]; then
      printf '%s\n' "$OVERLAP" | while IFS= read -r f; do
        [ -n "$f" ] && echo "  OVERLAP=$f"
      done
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Gate 1: new environment variables
# ---------------------------------------------------------------------------
ENV_OUT=$(bash "$ENVCHECK_BIN" 2>/dev/null || true)
ENV_STATUS=$(printf '%s\n' "$ENV_OUT" | sed -n 's/^STATUS: //p' | head -n1)
if [ "$ENV_STATUS" = "pass" ]; then
  echo "GATE1_ENV: pass"
elif [ "$ENV_STATUS" = "warn" ]; then
  echo "GATE1_ENV: block"
  GATE1_BLOCKED=1
  # Pass the script's NEW_VARS + PASTE_BLOCK through verbatim so the orchestrator
  # can render the dotenv paste block without re-running anything.
  printf '%s\n' "$ENV_OUT" | sed 's/^/  ENV| /'
else
  # Could not verify env vars. Fail-safe: block rather than merge unchecked.
  echo "GATE1_ENV: error"
  echo "  REASON=check-env-vars produced no STATUS (diff against origin/main may be unavailable)"
  GATE1_BLOCKED=1
fi

# ---------------------------------------------------------------------------
# Gate 2: PR health - owner/repo/PR resolution, then 4 sub-checks
# ---------------------------------------------------------------------------
ORIGIN=$(git config --get remote.origin.url 2>/dev/null || echo "")
ORIGIN="${ORIGIN%.git}"
ORIGIN="${ORIGIN#git@github.com:}"
ORIGIN="${ORIGIN#https://github.com/}"
OWNER="${ORIGIN%%/*}"
REPO="${ORIGIN#*/}"
REPO="${REPO%%/*}"

if [ -z "$OWNER" ] || [ -z "$REPO" ] || [ "$OWNER" = "$ORIGIN" ]; then
  # Could not verify PR health. Fail-safe: block.
  echo "GATE2_HEALTH: error"
  echo "  REASON=could not parse owner/repo from git remote origin"
  GATE2_BLOCKED=1
elif [ "$PREFLIGHT_BLOCKED" = "1" ] && [ -z "$PR_BRANCH" ]; then
  # No usable branch (detached HEAD / not a repo) - there is no PR to resolve.
  # Pre-flight already blocks; emit a clean skipped marker without claiming pass.
  echo "GATE2_HEALTH: skipped"
  echo "  REASON=pre-flight blocked before a PR branch could be resolved"
  GATE2_BLOCKED=1
else
  # PR number via REST (keeps Gate 2 alive when the GraphQL budget is exhausted).
  # Match on .head.ref across all open PRs to cover both same-repo and fork PRs.
  # Use --arg (not -q string interpolation) so a branch name containing a quote
  # or jq metacharacter cannot break or alter the filter.
  PR_LIST_RAW=$(gh api "repos/$OWNER/$REPO/pulls?state=open&per_page=100" 2>/dev/null || echo "")
  PR_NUMBER=$(printf '%s' "$PR_LIST_RAW" \
    | jq -r --arg b "$PR_BRANCH" 'if type=="array" then (map(select(.head.ref==$b)) | .[0].number // empty) else empty end' 2>/dev/null || echo "")
  if [ -z "$PR_NUMBER" ] || [ "$PR_NUMBER" = "null" ]; then
    echo "GATE2_HEALTH: block"
    echo "  PR_NUMBER="
    echo "  REASON=no open PR found for branch $PR_BRANCH (or PR list query failed); check out the PR branch and re-run"
    GATE2_BLOCKED=1
  else
    PR_JSON=$(gh api "repos/$OWNER/$REPO/pulls/$PR_NUMBER" 2>/dev/null || echo "")
    # jq's `//` treats false as empty, so `.draft // "unknown"` would map a
    # non-draft PR (draft:false) to "unknown". Use has()+tostring so false
    # stays "false" and only a genuinely missing/garbage payload is "unknown".
    IS_DRAFT=$(printf '%s' "$PR_JSON" | jq -r 'if (type=="object" and has("draft")) then (.draft|tostring) else "unknown" end' 2>/dev/null || echo "unknown")
    MERGEABLE_STATE=$(printf '%s' "$PR_JSON" | jq -r 'if type=="object" then (.mergeable_state // "unknown") else "unknown" end' 2>/dev/null || echo "unknown")
    HEAD_SHA=$(printf '%s' "$PR_JSON" | jq -r 'if type=="object" then (.head.sha // "") else "" end' 2>/dev/null || echo "")
    PR_AUTHOR=$(printf '%s' "$PR_JSON" | jq -r 'if type=="object" then (.user.login // "") else "" end' 2>/dev/null || echo "")

    # --- 2a: draft ---
    DRAFT_LINE="DRAFT=$IS_DRAFT"
    # Block on draft=true AND on "unknown" (PR_JSON could not be parsed).
    [ "$IS_DRAFT" != "false" ] && GATE2_BLOCKED=1

    # --- 2b: CI status ---
    # Capture the raw response and its exit code BEFORE piping to jq. Piping
    # gh|jq under `set -o pipefail` hides the failure: when gh is rate-limited it
    # writes a JSON error body to stdout and exits non-zero, jq happily parses
    # `(.check_runs // [])` to [] and the gate would read "CI: ok". We instead
    # require a zero exit AND a real check-runs payload (has the check_runs key).
    if [ -z "$HEAD_SHA" ]; then
      CI_LINE="CI: error (no head sha; PR metadata unavailable)"
      GATE2_BLOCKED=1
    else
      CI_RAW=$(gh api "repos/$OWNER/$REPO/commits/$HEAD_SHA/check-runs?per_page=100" 2>/dev/null); CI_RC=$?
      if [ "$CI_RC" -ne 0 ] || ! printf '%s' "$CI_RAW" | jq -e 'type=="object" and has("check_runs")' >/dev/null 2>&1; then
        CI_LINE="CI: error (check-runs query failed or returned no payload)"
        GATE2_BLOCKED=1
      else
        CI_JSON=$(printf '%s' "$CI_RAW" | jq -c '
            (.check_runs // [])
            | (map(select(.status != "completed")) | map(.name)) as $pending |
            (map(select(.status == "completed"
                        and (.conclusion == "failure"
                             or .conclusion == "timed_out"
                             or .conclusion == "action_required"))) | map(.name)) as $fail |
            {failing: $fail, pending: $pending}' 2>/dev/null || echo "")
        FAILING=$(printf '%s' "$CI_JSON" | jq -r '.failing | join(",")' 2>/dev/null || echo "")
        PENDING=$(printf '%s' "$CI_JSON" | jq -r '.pending | join(",")' 2>/dev/null || echo "")
        if [ -n "$FAILING" ]; then
          CI_LINE="CI: failing:$FAILING"; GATE2_BLOCKED=1
        elif [ -n "$PENDING" ]; then
          CI_LINE="CI: pending:$PENDING"; GATE2_BLOCKED=1
        else
          CI_LINE="CI: ok"
        fi
      fi
    fi

    # --- 2c: unresolved review threads (cached GraphQL via gh-thread-cache) ---
    THREAD_MAP_FILE=$(mktemp)
    "$THREADCACHE_BIN" get "$OWNER" "$REPO" "$PR_NUMBER" >"$THREAD_MAP_FILE" 2>/dev/null && THREAD_MAP_OK=1 || THREAD_MAP_OK=0
    THREAD_MAP=$(cat "$THREAD_MAP_FILE" 2>/dev/null || echo "[]"); rm -f "$THREAD_MAP_FILE"
    [ -z "$THREAD_MAP" ] && THREAD_MAP="[]"
    REVIEW_COMMENTS=$(gh api "repos/$OWNER/$REPO/pulls/$PR_NUMBER/comments" --paginate 2>/dev/null || echo "[]")
    [ -z "$REVIEW_COMMENTS" ] && REVIEW_COMMENTS="[]"

    AI_REGEX='^(greptile-apps|greptileai|coderabbitai|copilot-pull-request-reviewer|github-copilot|claude|anthropic|cursor|.+-ai|.+-review[^/]*)\[bot\]$'

    # Sanitize newlines/CR out of every emitted field so a crafted file path or
    # author cannot inject a fake `VERDICT:` / block-terminator line into stdout.
    if [ "$THREAD_MAP_OK" = "1" ]; then
      THREADS_JSON=$(jq -n \
        --argjson tm "$THREAD_MAP" \
        --argjson rc "$REVIEW_COMMENTS" \
        --arg ai "$AI_REGEX" '
        ($rc | map({key: (.node_id // ""), value: .}) | from_entries) as $by_node |
        (if ($tm | type) == "object" then ($tm.threads // []) else $tm end)
        | map(select(.isResolved == false and .isOutdated == false))
        | map({
            path: ((.path // "?") | gsub("[\\n\\r]"; " ")),
            author: (((.comments[0].id // null) as $cid | $by_node[$cid].user.login // .comments[0].author // "unknown") | gsub("[\\n\\r]"; " ")),
            snippet: (((.comments[0].id // null) as $cid | $by_node[$cid].body // "") | gsub("\\s+"; " ") | .[0:80]),
            is_ai: (((.comments[0].id // null) as $cid | $by_node[$cid].user.login // .comments[0].author // "") | test($ai))
          })' 2>/dev/null || echo "ERR")
      THREAD_MODE="precise"
    else
      THREADS_JSON=$(jq -n \
        --argjson rc "$REVIEW_COMMENTS" \
        --arg author "$PR_AUTHOR" \
        --arg ai "$AI_REGEX" '
        ($rc | map(select(.in_reply_to_id == null))) as $roots |
        $roots | map(. as $root |
          ([$root] + ($rc | map(select(.in_reply_to_id == $root.id))))
          | sort_by(.created_at) | last as $latest |
          {root: $root, latest: $latest})
        | map(select(.latest.user.login != $author))
        | map({
            path: ((.root.path // "?") | gsub("[\\n\\r]"; " ")),
            author: ((.latest.user.login // "unknown") | gsub("[\\n\\r]"; " ")),
            snippet: (.latest.body | gsub("\\s+"; " ") | .[0:80]),
            is_ai: ((.latest.user.login // "") | test($ai))
          })' 2>/dev/null || echo "ERR")
      THREAD_MODE="degraded"
    fi
    # Determine the thread count; a non-numeric result means the jq pipeline
    # errored on malformed input. Fail-safe: treat that as "could not verify
    # threads" and block, rather than silently reporting zero.
    THREAD_COUNT=$(printf '%s' "$THREADS_JSON" | jq 'length' 2>/dev/null || echo "")
    case "$THREAD_COUNT" in
      ''|*[!0-9]*)
        THREAD_COUNT="error"; THREAD_AI_COUNT="error"; THREAD_MODE="error"
        GATE2_BLOCKED=1 ;;
      *)
        THREAD_AI_COUNT=$(printf '%s' "$THREADS_JSON" | jq '[.[] | select(.is_ai)] | length' 2>/dev/null || echo 0)
        [ "$THREAD_COUNT" -gt 0 ] && GATE2_BLOCKED=1 ;;
    esac

    # --- 2d: mergeable state ---
    MERGE_LINE="MERGEABLE=$MERGEABLE_STATE"
    case "$MERGEABLE_STATE" in
      clean|unstable) ;;
      *) GATE2_BLOCKED=1 ;;
    esac

    if [ "$GATE2_BLOCKED" = "0" ]; then
      echo "GATE2_HEALTH: ok"
    else
      echo "GATE2_HEALTH: block"
    fi
    echo "  PR_NUMBER=$PR_NUMBER"
    echo "  $DRAFT_LINE"
    echo "  $CI_LINE"
    echo "  THREADS: count=${THREAD_COUNT} ai=${THREAD_AI_COUNT} mode=$THREAD_MODE"
    if [ "$THREAD_COUNT" != "error" ] && [ "${THREAD_COUNT:-0}" -gt 0 ] 2>/dev/null; then
      printf '%s' "$THREADS_JSON" | jq -r '.[] | "  THREAD: \(if .is_ai then "AI" else "human" end) | \(.path) | \(.author) | \(.snippet)"' 2>/dev/null || true
    fi
    echo "  $MERGE_LINE"
  fi
fi

# ---------------------------------------------------------------------------
# Gate 3: deployment window - the policy is team-configured, not hardcoded.
# /inc:setup-deploy persists a one-line `Deploy window:` rule into deploy.md
# (falling back to DEPLOY.md / CLAUDE.md). This script does NOT interpret the
# rule - matching a natural-language policy ("Mon-Thu after 1pm ET; freeze
# during the Dec holiday") against the clock is the orchestrator's job. The
# script only (a) detects whether a rule exists, (b) emits the current Eastern
# time as ground truth, and (c) collects the risk signals the orchestrator uses
# when a window is closed.
#
#   - No rule configured  -> GATE3_WINDOW: none  -> Gate 3 does not gate the
#     merge. The default is to just deploy.
#   - Rule configured      -> GATE3_WINDOW: rules -> the raw rule + current time
#     are emitted and the verdict is NEEDS_DECISION (unless a hard gate already
#     blocked), so the orchestrator evaluates now-vs-rule.
# ---------------------------------------------------------------------------
TIME_HUMAN=$(TZ='America/New_York' date +"%A %Y-%m-%d %H:%M %Z" 2>/dev/null || echo "unknown")
DOW="${MERGE_GATES_DOW_OVERRIDE:-$(TZ='America/New_York' date +"%u" 2>/dev/null || echo "")}"   # 1=Mon..7=Sun
HOUR="${MERGE_GATES_HOUR_OVERRIDE:-$(TZ='America/New_York' date +"%H" 2>/dev/null || echo "")}"

# Read the persisted window rule (first hit wins: deploy.md, DEPLOY.md, CLAUDE.md).
WINDOW_RULE=$(
  { grep -iE '^[-*[:space:]]*deploy window:' deploy.md 2>/dev/null \
    || grep -iE '^[-*[:space:]]*deploy window:' DEPLOY.md 2>/dev/null \
    || grep -iE '^[-*[:space:]]*deploy window:' CLAUDE.md 2>/dev/null; } \
  | head -n1 \
  | sed -E 's/^[^:]*:[[:space:]]*//; s/<!--.*-->//; s/[[:space:]]+$//' \
  | tr -d '\r'
)
# Normalize: an explicit "none"/"any"/"anytime" (or an empty/absent field) means
# no window restriction - the default just-deploy posture.
RULE_NORM=$(printf '%s' "$WINDOW_RULE" | tr '[:upper:]' '[:lower:]' | xargs)
case "$RULE_NORM" in
  ''|none|any|anytime|'any time'|'no restrictions'|'no restriction'|'no rules'|'no rule'|n/a|deploy|'deploy anytime') GATE3_HAS_RULE=0 ;;
  *) GATE3_HAS_RULE=1 ;;
esac

# Risk signals (always collected; consumed by the orchestrator on a closed window).
SIGNALS=""
[ "$ENV_STATUS" = "warn" ] && SIGNALS="$SIGNALS env"
# Schema-touching files in this diff. `.sql.ts` is included because Drizzle
# projects name schema files like `users.sql.ts` (the repo's own
# inc-commit-push-pr SKILL calls this out as the most common drift case), and a
# plain `\.sql$` alone would miss them. This list is reused by Gate 4 below.
CHANGED_SCHEMA=$(git diff --name-only "origin/$DEFAULT_BRANCH" 2>/dev/null \
  | grep -iE '(^|/)(schema|migrations?|drizzle|prisma)(/|\.|$)|\.sql(\.ts)?$' || true)
[ -n "$CHANGED_SCHEMA" ] && SIGNALS="$SIGNALS schema"
git diff "origin/$DEFAULT_BRANCH" 2>/dev/null \
  | grep -iqE 'backfill|sync[_-]?job|seed|populate|one[-_ ]time|migration[_-]?script' && SIGNALS="$SIGNALS backfill"
DIFFSTAT=$(git diff --stat "origin/$DEFAULT_BRANCH" 2>/dev/null | tail -1)
FILES_CHANGED=$(printf '%s' "$DIFFSTAT" | grep -oE '[0-9]+ file' | grep -oE '[0-9]+' || echo 0)
LINES_CHANGED=$(printf '%s' "$DIFFSTAT" | grep -oE '[0-9]+ (insertion|deletion)' | grep -oE '[0-9]+' | awk '{s+=$1} END {print s+0}')
if [ "${FILES_CHANGED:-0}" -ge 10 ] 2>/dev/null || [ "${LINES_CHANGED:-0}" -ge 300 ] 2>/dev/null; then
  SIGNALS="$SIGNALS largediff"
fi
SIGNALS=$(echo "$SIGNALS" | xargs)   # trim
[ -z "$SIGNALS" ] && SIGNALS="none"
SIGNALS="${MERGE_GATES_SIGNALS_OVERRIDE:-$SIGNALS}"   # test hook

# Risk assessment for the *default* posture (no window rule configured). A change
# with no risk signals just ships (GO); one carrying schema/backfill/largediff
# risk gets a quick confirm from the user before it merges.
if [ "$SIGNALS" = "none" ]; then
  GATE3_RISK=low
else
  GATE3_RISK=elevated
fi

if [ "$GATE3_HAS_RULE" = "1" ]; then
  echo "GATE3_WINDOW: rules"
  echo "  RULE=$WINDOW_RULE"
else
  echo "GATE3_WINDOW: none"
fi
echo "  RISK=$GATE3_RISK"
echo "  TIME=$TIME_HUMAN"
echo "  DOW=$DOW HOUR=$HOUR"
echo "  SIGNALS=$SIGNALS"
echo "  DIFFSTAT=${DIFFSTAT:-none}"

# ---------------------------------------------------------------------------
# Gate 4: schema drift vs production (conditional; hard block on drift)
# ---------------------------------------------------------------------------
# Generic across projects: this gate only engages when the target repo actually
# exposes a drift check - a `db:check-drift` script in a package.json (the
# convention the incubator-build-app guard established) - AND this PR changes a
# DATABASE schema file. A schema change must never squash-merge while
# production's database still lacks it, so we run the repo's own read-only drift
# check here, at the merge decision, not only at build/deploy.
#
# The DB-schema classifier is deliberately narrower than the gate-3 `schema` risk
# word: a hard, credential-requiring gate must not fire on non-database "schema"
# files (schema.graphql, a validation-schema module). Any repo without the
# script, or any PR that changes no DB-schema file, is a clean no-op
# (GATE4_DRIFT: skip) - non-schema PRs cannot introduce drift, and forcing every
# merge to reach a live database would block unrelated work in credential-less
# environments for no safety gain.
#
# Diff scope: files are taken from the three-dot merge-base diff (what will
# actually be merged), so a schema commit main gained after divergence is not
# misread as this PR's change.
#
# Monorepo-aware: the script often lives in the schema-owning workspace package
# (e.g. apps/web/package.json), not the repo root. Each changed DB-schema file is
# mapped to the nearest package that owns its check, and EVERY affected workspace
# is run (worst result wins) - a passing workspace must not vouch for a second
# whose database drifts. The package manager is resolved per package (nearest
# lockfile / packageManager field), not assumed from a shared root lockfile.
# Tamper-aware: if a changed schema file's owning package DROPPED a check the base
# branch had, that is a schema PR deleting its own gate - hard block, never a
# silent skip.
#
# The check runs the repo's own command, so it needs whatever DATABASE_URL that
# command needs, pointed at whatever database that environment provides - this
# gate confirms the schema matches THAT database, and cannot itself prove the
# connection targets production (see the SKILL.md caveat). Per its documented
# contract the check refuses to run (non-zero) rather than checking a database
# the deploy never uses - so a merge environment that lacks the credentials fails
# loudly (GATE4_DRIFT: unverifiable) instead of passing silently. Real drift and
# any unrunnable/ambiguous outcome are both hard blocks; only the message
# differs, and only an output that positively reads as a drift report is worded
# as confirmed drift (so an operational crash never tells the user to mutate
# production). Read-only: the check never writes to the database.
#
# SECURITY NOTE: this gate is the one gate that executes the repo's OWN code
# (the db:check-drift script) with whatever DATABASE_URL the merge environment
# carries. Running an unmerged PR's checker/schema against a production
# connection is a real trust boundary - a maintainer merging an untrusted
# contributor's schema PR should review the check-script and schema changes
# before trusting the result. We surface a NOTE when the PR modifies the
# checker's own code; the SKILL.md security note documents the posture. We do not
# re-architect the check into isolated CI here: this skill is a local,
# maintainer-run merge tool and by design runs the repo's own commands.
#
# Test hooks: MERGE_GATES_DRIFT_CMD_OVERRIDE replaces the detected package-manager
# invocation with an arbitrary command (run once per affected package, in that
# package's directory); MERGE_GATES_DB_SCHEMA_OVERRIDE injects the changed
# DB-schema file list instead of computing it from the diff.

# Database-schema classifier - deliberately NARROWER than the gate-3 `schema`
# risk word, which also matches non-database files (schema.graphql, a
# src/schema/*.ts validation module). Gate 4 is a hard, credential-requiring gate,
# so firing it on a non-DB "schema" file would be a false block. Restrict to real
# DB-schema conventions: drizzle/prisma/migrations trees, *.sql / *.sql.ts,
# schema.prisma / schema.sql, and db/-scoped schema modules.
# `db/schema.ts` (single file) and nested `db/schema/**` trees (src/db/schema/
# users.ts is a common Drizzle layout) both count; a bare `src/schema/*.ts`
# validation module does not.
DB_SCHEMA_RE='(^|/)(migrations?|drizzle|prisma)(/|$)|\.sql(\.ts)?$|(^|/)schema\.(prisma|sql)$|(^|/)db/[^/]*schema[^/]*\.(ts|js|mjs|cjs|sql)$|(^|/)db/schema/.*\.(ts|js|mjs|cjs|sql)$'

# Evaluate the commit that will ACTUALLY merge. Gate 2 verified the fetched PR
# head SHA and `gh pr merge` merges that remote ref, so a stale local HEAD (a
# teammate pushed after the local checkout) must not be what Gate 4 diffs. Use the
# PR head SHA from Gate 2 when it is present locally (pre-flight freshness fetched
# origin/<pr-branch>); otherwise fall back to local HEAD.
EVAL_HEAD=HEAD
if [ -n "${HEAD_SHA:-}" ] && git rev-parse -q --verify "$HEAD_SHA^{commit}" >/dev/null 2>&1; then
  EVAL_HEAD="$HEAD_SHA"
fi
# The merge base of that head against the default branch - used for tamper
# ownership so a check the DEFAULT branch ADDED after divergence isn't mistaken
# for one this PR deleted.
DB_MERGE_BASE=$(git merge-base "origin/$DEFAULT_BRANCH" "$EVAL_HEAD" 2>/dev/null || echo "")

# Detection reads EVAL_HEAD, but the drift command EXECUTES in the working tree.
# If EVAL_HEAD is a fetched SHA that differs from the local checkout, running the
# local (stale) checker could vouch for the wrong schema. EVAL_STALE turns the
# execution into an unverifiable block below (detection stays correct regardless).
LOCAL_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
EVAL_STALE=0
if [ "$EVAL_HEAD" != "HEAD" ]; then
  EVAL_RESOLVED=$(git rev-parse "$EVAL_HEAD^{commit}" 2>/dev/null || echo "")
  [ -n "$EVAL_RESOLVED" ] && [ -n "$LOCAL_HEAD" ] && [ "$EVAL_RESOLVED" != "$LOCAL_HEAD" ] && EVAL_STALE=1
fi

# What EVAL_HEAD changes vs the merge base (three-dot: the diff that will actually
# be merged) - not a two-dot working-tree-vs-tip diff, which would also pick up
# schema commits main gained after divergence and read them as this PR's.
# `--no-renames` so a schema file renamed OUT of a recognized tree (e.g.
# drizzle/schema.ts -> archive/schema.ts.bak) still surfaces the old DB path as a
# deletion, engaging the gate. Capture the git exit status separately: a
# `... 2>/dev/null | grep ... || true` would turn a diff that could not be
# computed (shallow clone, missing origin/<default>) into an empty file set and a
# false "no schema changed" skip. DB_DIFF_UNAVAILABLE drives a fail-safe block.
DB_DIFF_UNAVAILABLE=0
if [ -n "${MERGE_GATES_DB_SCHEMA_OVERRIDE+x}" ]; then
  CHANGED_DB_SCHEMA="$MERGE_GATES_DB_SCHEMA_OVERRIDE"
else
  DB_DIFF_RAW=$(git diff --no-renames --name-only "origin/$DEFAULT_BRANCH...$EVAL_HEAD" 2>/dev/null); DB_DIFF_RC=$?
  if [ "$DB_DIFF_RC" -ne 0 ]; then
    DB_DIFF_UNAVAILABLE=1; CHANGED_DB_SCHEMA=""
  else
    CHANGED_DB_SCHEMA=$(printf '%s\n' "$DB_DIFF_RAW" | grep -iE "$DB_SCHEMA_RE" || true)
  fi
fi

# Does the repo expose a db:check-drift script anywhere (HEAD tree)? Used to
# decide whether an unavailable diff must fail-safe (a drift-gated repo) or stay a
# no-op (a repo with no check at all).
repo_exposes_drift() {
  local pj
  { echo "package.json"; git ls-files '*package.json' 2>/dev/null | grep -v node_modules; } \
    | sed 's#^\./##' | awk 'NF && !seen[$0]++' | while IFS= read -r pj; do
      [ -f "$pj" ] && jq -e '(.scripts // {}) | has("db:check-drift")' "$pj" >/dev/null 2>&1 && { echo yes; break; }
    done | grep -q yes
}

# Nearest ancestor package dir ("." == repo root) whose package.json defines
# db:check-drift. $1 = file path, $2 = git ref ("" == working tree).
nearest_drift_pkg() {
  local d ref="$2" rel nd; d=$(dirname "$1")
  while :; do
    rel="$d/package.json"; rel="${rel#./}"
    if [ -z "$ref" ]; then
      [ -f "$rel" ] && jq -e '(.scripts // {}) | has("db:check-drift")' "$rel" >/dev/null 2>&1 && { echo "$d"; return 0; }
    else
      git show "$ref:$rel" 2>/dev/null | jq -e '(.scripts // {}) | has("db:check-drift")' >/dev/null 2>&1 && { echo "$d"; return 0; }
    fi
    [ "$d" = "." ] && break
    nd=$(dirname "$d"); [ "$nd" = "$d" ] && break; d="$nd"
  done
  return 1
}

# Package manager for a given package dir: nearest lockfile / packageManager field
# walking up from the package - a workspace may carry its own, distinct from root.
detect_pm_for() {
  local d="${1:-.}" pm nd
  while :; do
    if [ -f "$d/pnpm-lock.yaml" ]; then echo pnpm; return; fi
    if [ -f "$d/yarn.lock" ]; then echo yarn; return; fi
    if [ -f "$d/bun.lockb" ] || [ -f "$d/bun.lock" ]; then echo bun; return; fi
    if [ -f "$d/package-lock.json" ]; then echo npm; return; fi
    if [ -f "$d/package.json" ]; then
      pm=$(jq -r '.packageManager // empty' "$d/package.json" 2>/dev/null | sed -E 's/@.*//')
      case "$pm" in pnpm|yarn|bun|npm) echo "$pm"; return;; esac
    fi
    [ "$d" = "." ] && break
    nd=$(dirname "$d"); [ "$nd" = "$d" ] && break; d="$nd"
  done
  echo npm
}

# Does an output positively read as a drift report (vs an operational failure)?
# Guard against negated ("No schema drift detected") and error-context ("Schema
# drift check failed: DATABASE_URL is not set") phrasings that contain the drift
# keywords but describe the opposite or a failure - misreading those would tell
# the user to push schema to production off a run that found nothing / never ran.
looks_like_drift() {
  local o="$1"
  printf '%s' "$o" | grep -qiE 'no (schema )?drift|drift check (failed|error|could not|errored)|(failed|unable|could not) to (run|connect|check|introspect)|error:' && return 1
  printf '%s' "$o" | grep -qiE 'drift detected|is missing (a |an )?(column|table|index|constraint|foreign key|enum|sequence|view|type)|missing (column|table|index|constraint|foreign key)|differs from (schema|the schema|expected)|out of sync|not in sync'
}

# Is $1 a proper ancestor dir of $2? ("." is an ancestor of everything.)
proper_ancestor() {
  [ "$1" != "$2" ] || return 1
  [ "$1" = "." ] && return 0
  case "$2" in "$1"/*) return 0;; *) return 1;; esac
}

# Map each changed DB-schema file to the workspace package that owns its drift
# check. Collect the affected packages (dedup). Flag TAMPER whenever a file's
# BASE owner is more specific than its HEAD owner - i.e. this PR removed the
# nearest check and any coverage now comes only from a broader ancestor package,
# which cannot vouch for the workspace whose own guard was deleted. This also
# catches the "no HEAD owner at all, base had one" case.
AFFECTED_PKGS=""; TAMPER=0
if [ -n "$CHANGED_DB_SCHEMA" ]; then
  # Head owner reads the working tree when EVAL_HEAD is the local HEAD (the normal
  # case, and what the tests drive); when EVAL_HEAD is a distinct fetched SHA, read
  # ownership from that tree so detection and evaluation stay consistent.
  HO_REF=""; [ "$EVAL_HEAD" != "HEAD" ] && HO_REF="$EVAL_HEAD"
  # Base owner is compared at the MERGE BASE, not the base tip: a check the default
  # branch added AFTER divergence must not read as one this PR deleted.
  BO_REF="${DB_MERGE_BASE:-origin/$DEFAULT_BRANCH}"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    ho=$(nearest_drift_pkg "$f" "$HO_REF")   # head owner (empty if none)
    bo=$(nearest_drift_pkg "$f" "$BO_REF")   # merge-base owner (empty if none)
    [ -n "$ho" ] && AFFECTED_PKGS="$AFFECTED_PKGS
$ho"
    # A nearer owner existed at the merge base that HEAD no longer has -> this PR
    # deleted the workspace's own guard (even if a broader ancestor still covers it).
    if [ -n "$bo" ] && { [ -z "$ho" ] || proper_ancestor "$ho" "$bo"; }; then
      TAMPER=1
    fi
  done <<EOF
$CHANGED_DB_SCHEMA
EOF
fi
AFFECTED_PKGS=$(printf '%s\n' "$AFFECTED_PKGS" | awk 'NF && !seen[$0]++')

# Note when the PR changes the checker's own code (runs with the ambient
# DATABASE_URL). Two signals: (a) a changed file whose path looks like the
# checker, and (b) the more reliable one - an affected package's db:check-drift
# script VALUE differs between the merge base and EVAL_HEAD (an in-place
# entrypoint change a path heuristic can't see).
CHECK_CODE_CHANGED=0
git diff --no-renames --name-only "origin/$DEFAULT_BRANCH...$EVAL_HEAD" 2>/dev/null \
  | grep -qiE 'check.?db.?drift|drift.?check|check.?drift' && CHECK_CODE_CHANGED=1
drift_script_val() {  # $1 = package dir ("." = root), $2 = git ref
  local rel="$1/package.json"; rel="${rel#./}"
  git show "$2:$rel" 2>/dev/null | jq -r '(.scripts // {})["db:check-drift"] // ""' 2>/dev/null
}
if [ "$CHECK_CODE_CHANGED" = "0" ] && [ -n "$AFFECTED_PKGS" ]; then
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    bv=$(drift_script_val "$pkg" "${DB_MERGE_BASE:-origin/$DEFAULT_BRANCH}")
    hv=$(drift_script_val "$pkg" "$EVAL_HEAD")
    [ "$bv" != "$hv" ] && { CHECK_CODE_CHANGED=1; break; }
  done <<EOF
$AFFECTED_PKGS
EOF
fi

if [ "$DB_DIFF_UNAVAILABLE" = "1" ]; then
  # The merge-base diff could not be computed (shallow clone, missing
  # origin/<default>). Fail-safe only when this repo actually gates on drift -
  # otherwise the gate stays a clean no-op as it would for any non-drift repo.
  if repo_exposes_drift; then
    echo "GATE4_DRIFT: unverifiable"
    echo "  REASON=could not compute the merge-base schema diff (shallow clone or origin/$DEFAULT_BRANCH unavailable); cannot tell whether this PR changes schema, and this repo gates on db:check-drift"
    GATE4_BLOCKED=1
  else
    echo "GATE4_DRIFT: skip"
    echo "  REASON=no db:check-drift script in the repo (schema diff unavailable, but nothing gates on it)"
  fi
elif [ -z "$CHANGED_DB_SCHEMA" ]; then
  echo "GATE4_DRIFT: skip"
  echo "  REASON=no database schema files changed in this PR"
elif [ -z "$AFFECTED_PKGS" ]; then
  if [ "$TAMPER" = "1" ]; then
    echo "GATE4_DRIFT: unverifiable"
    echo "  REASON=base branch defines db:check-drift for the changed schema but this PR's tree no longer does; the drift gate cannot be removed by the same PR it should evaluate"
    GATE4_BLOCKED=1
  else
    echo "GATE4_DRIFT: skip"
    echo "  REASON=no db:check-drift script covers the changed schema files"
  fi
elif [ "$EVAL_STALE" = "1" ]; then
  # A check would run, but the local tree doesn't match the commit that merges.
  echo "GATE4_DRIFT: unverifiable"
  echo "  REASON=the local checkout ($LOCAL_HEAD) is behind the PR head ($EVAL_HEAD) that will merge; the drift check runs in the working tree and would evaluate stale code. Pull the PR head (git pull) and re-run so the check evaluates what actually merges."
  GATE4_BLOCKED=1
else
  # Run the drift check in EVERY affected workspace; the worst result wins. A
  # single passing workspace must not vouch for a second whose database drifts.
  WORST="pass"; DETAIL=""
  if [ "$TAMPER" = "1" ]; then WORST="unverifiable"; GATE4_BLOCKED=1
    DETAIL="  REASON=a changed schema file lost the db:check-drift its base branch had (gate tamper)
"; fi
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    reldir="$pkg"; [ "$reldir" = "." ] && reldir=""
    if [ -n "${MERGE_GATES_DRIFT_CMD_OVERRIDE:-}" ]; then
      PM_CMD="$MERGE_GATES_DRIFT_CMD_OVERRIDE"
    else
      PM_CMD="$(detect_pm_for "$pkg") run db:check-drift"
    fi
    BIN=$(printf '%s' "$PM_CMD" | awk '{print $1}')
    if ! command -v "$BIN" >/dev/null 2>&1; then
      DETAIL="$DETAIL  PKG[$pkg]: unverifiable ('$BIN' not installed)
"
      WORST="unverifiable"; GATE4_BLOCKED=1; continue
    fi
    RUNCMD="$PM_CMD"; [ -n "$reldir" ] && RUNCMD="cd $(printf '%q' "$reldir") && $PM_CMD"
    OUT=$(run_bounded 120 bash -c "$RUNCMD" 2>&1); RC=$?
    # 124 = ordinary timeout; 137 = KILLed (our SIGKILL escalation for a
    # TERM-resistant client, or OOM). Both mean the 120s deadline was hit - label
    # them so the message isn't a blank generic 'unverifiable'.
    if [ "$RC" = "124" ] || [ "$RC" = "137" ]; then OUT="$OUT
drift check exceeded its 120s deadline and was terminated (database likely unreachable)"; fi
    if [ "$RC" = "0" ]; then
      DETAIL="$DETAIL  PKG[$pkg]: pass
"
    else
      GATE4_BLOCKED=1
      if looks_like_drift "$OUT"; then
        DETAIL="$DETAIL  PKG[$pkg]: drift
"; [ "$WORST" = "pass" ] && WORST="drift"
      else
        DETAIL="$DETAIL  PKG[$pkg]: unverifiable
"; WORST="unverifiable"
      fi
      # Pass the check's own output through verbatim: it names exactly what
      # production lacks and prints its documented remediation.
      DETAIL="$DETAIL$(printf '%s\n' "$OUT" | sed "s#^#  DRIFT[$pkg]| #")
"
    fi
  done <<EOF
$AFFECTED_PKGS
EOF
  echo "GATE4_DRIFT: $WORST"
  printf '%s' "$DETAIL"
  [ "$CHECK_CODE_CHANGED" = "1" ] && echo "  NOTE=this PR modifies the drift check's own code, which runs with the environment's DATABASE_URL; review the checker/schema changes before trusting the result (SKILL.md security note)"
fi

# ---------------------------------------------------------------------------
# Verdict - computed purely from the per-gate blocked flags + GATE3_HAS_RULE / GATE3_RISK.
# ---------------------------------------------------------------------------
# Hard blocks (pre-flight, Gate 1, Gate 2) fail outright -> EXIT=1 / BLOCK.
# Gate 3 is the user's call -> EXIT=2 / NEEDS_DECISION, only when no hard gate
# already blocked, in two cases: a configured deploy window (evaluate now-vs-rule)
# or, with no window rule, an elevated-risk change (confirm before shipping). A
# no-rule, low-risk change contributes nothing - the default is to just deploy.
REASONS=""
EXIT=0

[ "$PREFLIGHT_BLOCKED" = "1" ] && { [ -n "$OVERLAP" ] && REASONS="$REASONS preflight-overlap" || REASONS="$REASONS preflight"; EXIT=1; }
[ "$GATE1_BLOCKED" = "1" ] && { REASONS="$REASONS gate1-env"; EXIT=1; }
[ "$GATE2_BLOCKED" = "1" ] && { REASONS="$REASONS gate2-health"; EXIT=1; }
[ "$GATE4_BLOCKED" = "1" ] && { REASONS="$REASONS gate4-drift"; EXIT=1; }

if [ "$GATE3_HAS_RULE" = "1" ]; then
  REASONS="$REASONS gate3-window-decision"; [ "$EXIT" = "0" ] && EXIT=2
elif [ "$GATE3_RISK" = "elevated" ]; then
  REASONS="$REASONS gate3-risk-confirm"; [ "$EXIT" = "0" ] && EXIT=2
fi

REASONS=$(echo "$REASONS" | xargs)
if [ -z "$REASONS" ]; then
  echo "VERDICT: GO"
elif [ "$EXIT" = "2" ]; then
  echo "VERDICT: NEEDS_DECISION reasons=$REASONS"
else
  echo "VERDICT: BLOCK reasons=$REASONS"
fi
echo "=== END MERGE GATES ==="
exit "$EXIT"
