#!/usr/bin/env bash
# merge-gates - run every deterministic merge-pr gate in one pass and emit a
# single structured verdict block.
#
# Replaces ~12 separate model-mediated Bash calls (freshness, env vars, the four
# Gate 2 sub-checks, Gate 3 signals) with one call the orchestrator reads once.
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

echo "=== MERGE GATES ==="

# Per-gate blocked flags drive the verdict. 1 = this gate blocks the merge.
PREFLIGHT_BLOCKED=0   # default-branch, path overlap, or freshness error
GATE1_BLOCKED=0       # new env vars, or env-check could not run
GATE2_BLOCKED=0       # draft / CI / threads / mergeable / could not verify
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
  | sed -E 's/^[-*[:space:]]*[Dd]eploy [Ww]indow:[[:space:]]*//; s/<!--.*-->//' \
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
git diff --name-only "origin/$DEFAULT_BRANCH" 2>/dev/null \
  | grep -iqE '(^|/)(schema|migrations?|drizzle|prisma)(/|\.|$)|\.sql$' && SIGNALS="$SIGNALS schema"
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
# Verdict - computed purely from the per-gate blocked flags + GATE3_CLASS.
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
