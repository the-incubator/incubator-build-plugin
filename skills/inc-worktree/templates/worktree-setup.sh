#!/usr/bin/env bash
#
# Worktree infrastructure for this repo. Installed by /inc:worktree (incubator-build).
# Self-contained on purpose: collaborators without the plugin get the same behavior.
#
# Two modes:
#
#   1. Hook mode (default) - Claude Code WorktreeCreate hook contract:
#        - stdin  : JSON `{ "name": "<suggested worktree slug>" }`
#        - stdout : MUST be exactly the absolute path to the created worktree
#        - exit 0 : success; any non-zero exit aborts worktree creation
#      Creates `.worktrees/<slug>` on a fresh branch cut from origin's default
#      branch (fetched first, so worktrees are never born behind), symlinks
#      local .env / .env.local files from the main checkout, and installs
#      dependencies. Before creating, it opportunistically prunes stale
#      worktrees (see below), so cleanup needs no cron and no manual step.
#
#   2. Prune mode - `worktree-setup.sh --prune [--dry-run]`:
#      Removes worktrees that are safe to delete. A worktree is pruned only if
#      ALL of these hold:
#        - it is a linked worktree on a branch (main checkout and detached
#          HEADs are never touched)
#        - its working tree is clean (no tracked changes, no untracked files;
#          ignored files like node_modules do not count as dirty)
#        - a MERGED pull request exists whose head branch is this branch
#        - the merged PR's head commit equals the local branch tip (nothing
#          was committed locally after the PR merged)
#      Squash merges make `git branch --merged` useless here; PR state is the
#      source of truth. Prune iterates `git worktree list`, never directory
#      names, so it also cleans up worktrees from older placement conventions.
#
# Repo-specific extras belong in `scripts/worktree-post-setup.sh` (optional,
# executable, receives the worktree path as $1); this file stays generic.
#
# IMPORTANT: in hook mode Claude reads stdout as the path, so every diagnostic
# goes to stderr. Only the final worktree path may touch stdout.

set -euo pipefail

log() { echo "[worktree-setup] $*" >&2; }

# python3 is required for prune (PR matching, activity check) and preferred
# for slug parsing. Prune fails loudly without it rather than silently keeping
# everything; hook mode degrades to basic slug parsing with a warning.
PYTHON3_OK=""
command -v python3 >/dev/null 2>&1 && PYTHON3_OK=1

# --- Resolve the main checkout root ------------------------------------------
# Anchor everything at the MAIN worktree even if invoked from a linked one:
# the common git dir lives in the main checkout at <main-root>/.git. Derive
# from cwd first; CLAUDE_PROJECT_DIR is only a fallback for when the hook
# fires outside the repo, because in CLI mode it can name a different repo
# (the session's project) than the one being pruned.
if common_dir="$(git rev-parse --git-common-dir 2>/dev/null)"; then
  common_dir="$(cd "$common_dir" && pwd -P)"
  repo_root="$(dirname "$common_dir")"
else
  repo_root="${CLAUDE_PROJECT_DIR:?not inside a git repository and CLAUDE_PROJECT_DIR unset}"
fi

# --- Default branch detection ------------------------------------------------
default_branch() {
  local ref
  if ref="$(git -C "$repo_root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"; then
    echo "${ref#origin/}"
    return
  fi
  for b in main master; do
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$b"; then
      echo "$b"
      return
    fi
  done
  git -C "$repo_root" rev-parse --abbrev-ref HEAD
}

# --- Prune -------------------------------------------------------------------
# $1 = "apply" | "dry-run" | "best-effort" (hook mode: apply, but never fail)
prune_worktrees() {
  local mode="$1"
  if ! command -v gh >/dev/null 2>&1; then
    log "prune: gh not found, skipping"
    return 0
  fi
  if [[ -z "$PYTHON3_OK" ]]; then
    if [[ "$mode" == "best-effort" ]]; then
      log "prune: python3 not found, skipping"
      return 0
    fi
    echo "ERROR: prune unavailable: python3 is required for PR matching" >&2
    return 1
  fi
  # `local` is dynamically scoped: origin_url and cwd_list are visible in
  # prune_one below. cwd_list snapshots every process's working directory once
  # so each candidate worktree can be checked for live occupants.
  local origin_url merged cwd_list
  origin_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)"
  cwd_list=""
  if command -v lsof >/dev/null 2>&1; then
    cwd_list="$(lsof -a -d cwd -Fn 2>/dev/null || true)"
  fi
  if ! merged="$(gh pr list --repo "$origin_url" \
      --state merged --limit 300 --json headRefName,headRefOid,number 2>/dev/null)"; then
    log "prune: could not list merged PRs (no GitHub remote or gh auth), skipping"
    return 0
  fi
  local self_root
  self_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"

  local path="" sha="" branch=""
  while IFS= read -r line; do
    case "$line" in
      worktree\ *) path="${line#worktree }"; sha=""; branch="" ;;
      HEAD\ *)     sha="${line#HEAD }" ;;
      branch\ *)   branch="${line#branch refs/heads/}" ;;
      "")
        prune_one "$mode" "$path" "$sha" "$branch" "$merged" "$self_root" || true
        path=""; sha=""; branch=""
        ;;
    esac
  done < <(git -C "$repo_root" worktree list --porcelain; echo)
  git -C "$repo_root" worktree prune >/dev/null 2>&1 || true
}

prune_one() {
  local mode="$1" path="$2" sha="$3" branch="$4" merged="$5" self_root="$6"
  [[ -z "$path" || "$path" == "$repo_root" ]] && return 0
  [[ -n "$self_root" && "$path" == "$self_root" ]] && return 0
  if [[ -z "$branch" ]]; then
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path (detached HEAD)"
    return 0
  fi
  if [[ ! -d "$path" ]]; then
    return 0  # stale registration; `git worktree prune` at the end handles it
  fi
  # A live session may sit in a merged+clean worktree; deleting it underneath
  # that session breaks it. Two guards: (1) no process may have its cwd inside
  # the worktree, (2) recent index activity is a proxy for "in use". The index
  # window is 1 hour for on-demand prune (dry-run + human-confirmed) but 24
  # hours for hook-mode auto-prune, because an editor can sit in a clean
  # worktree for hours without a git operation touching the index. The index
  # check runs before `git status` (and status uses --no-optional-locks below)
  # because a plain status refresh can itself rewrite the index and fake
  # recent activity.
  if [[ -n "$cwd_list" ]] && printf '%s\n' "$cwd_list" | grep -q "^n${path}"; then
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (a process is running inside it)"
    return 0
  fi
  local idx max_idle=3600
  [[ "$mode" == "best-effort" ]] && max_idle=86400
  idx="$(git -C "$path" rev-parse --absolute-git-dir 2>/dev/null)/index"
  if [[ -f "$idx" ]] && python3 -c '
import os, sys, time
sys.exit(0 if time.time() - os.path.getmtime(sys.argv[1]) < int(sys.argv[2]) else 1)
' "$idx" "$max_idle" 2>/dev/null; then
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (git activity within the last hour)"
    return 0
  fi
  if [[ -n "$(git --no-optional-locks -C "$path" status --porcelain 2>/dev/null)" ]]; then
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (uncommitted changes)"
    return 0
  fi
  local pr
  pr="$(printf '%s' "$merged" | python3 -c '
import json, sys
branch, tip = sys.argv[1], sys.argv[2]
for pr in json.load(sys.stdin):
    if pr.get("headRefName") == branch:
        if pr.get("headRefOid") == tip:
            print(pr.get("number"))
        else:
            print("SHA_MISMATCH")
        break
' "$branch" "$sha" 2>/dev/null || true)"
  # The bulk list caps at the 300 most recent merged PRs; an old worktree can
  # fall past it and become unprunable. In CLI modes, fall back to an exact
  # per-branch lookup. Hook mode skips this to keep worktree creation fast.
  if [[ -z "$pr" && "$mode" != "best-effort" ]]; then
    pr="$(gh pr list --repo "$origin_url" --head "$branch" --state merged \
        --limit 1 --json headRefOid,number 2>/dev/null | python3 -c '
import json, sys
tip = sys.argv[1]
prs = json.load(sys.stdin)
if prs:
    print(prs[0]["number"] if prs[0].get("headRefOid") == tip else "SHA_MISMATCH")
' "$sha" 2>/dev/null || true)"
  fi
  if [[ -z "$pr" ]]; then
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (no merged PR for this branch)"
    return 0
  fi
  if [[ "$pr" == "SHA_MISMATCH" ]]; then
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (local commits after the PR merged)"
    return 0
  fi
  if [[ "$mode" == "dry-run" ]]; then
    echo "WOULD-PRUNE $path branch=$branch (PR #$pr merged)"
    return 0
  fi
  # Clean was verified above via `git status`; --force only bypasses git's
  # refusal over ignored files such as node_modules.
  if git -C "$repo_root" worktree remove --force "$path" >&2 2>/dev/null; then
    git -C "$repo_root" branch -D "$branch" >/dev/null 2>&1 || true
    if [[ "$mode" == "best-effort" ]]; then
      log "pruned $path (branch $branch, PR #$pr merged)"
    else
      echo "PRUNED $path branch=$branch (PR #$pr merged)"
    fi
  else
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (git worktree remove failed)"
  fi
  return 0
}

# --- CLI mode: --prune -------------------------------------------------------
if [[ "${1:-}" == "--prune" ]]; then
  if [[ "${2:-}" == "--dry-run" ]]; then
    prune_worktrees dry-run
  else
    prune_worktrees apply
  fi
  exit 0
fi

# =============================================================================
# Hook mode: create a worktree
# =============================================================================

# --- Parse the suggested slug from the stdin JSON ----------------------------
input="$(cat || true)"
slug=""
if [[ -n "$input" && -n "$PYTHON3_OK" ]]; then
  slug="$(printf '%s' "$input" | python3 -c 'import json,sys
try:
    v = json.load(sys.stdin).get("name", "")
    print(v if isinstance(v, str) else "")
except Exception:
    print("")' 2>/dev/null || true)"
elif [[ -n "$input" ]]; then
  log "WARN python3 not found, using basic slug parsing"
  slug="$(printf '%s' "$input" \
    | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
fi
# Sanitize to a safe git branch / directory token. LC_ALL=C forces byte-mode so
# multibyte input collapses to dashes rather than leaking through. The sed pass
# removes patterns git refuses in a ref name: runs of dots, a leading or
# trailing dot/dash, and a trailing ".lock".
slug="$(printf '%s' "$slug" \
  | LC_ALL=C tr -c '[:alnum:]._-' '-' \
  | sed -E 's/\.{2,}/-/g; s/\.lock$/-lock/; s/^[-.]+//; s/[-.]+$//')"
if [[ -z "$slug" ]]; then
  slug="wt-$$"
fi

# --- Opportunistic prune (never blocks creation) -----------------------------
log "pruning stale worktrees (merged PR + clean tree)"
prune_worktrees best-effort || true

# --- Freshness: fetch, then branch from origin's default branch --------------
base_branch="$(default_branch)"
base_ref="$base_branch"
log "fetching origin/$base_branch"
if git -C "$repo_root" fetch origin "$base_branch" --quiet 2>/dev/null; then
  base_ref="origin/$base_branch"
elif git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$base_branch"; then
  # Deliberate tradeoff: offline/auth-failed creation still works, from the
  # best base available. The age makes the staleness visible instead of silent.
  cached_age="$(git -C "$repo_root" log -1 --format=%cr "refs/remotes/origin/$base_branch" 2>/dev/null || echo 'unknown age')"
  log "WARN fetch failed (offline?); using cached origin/$base_branch (last commit: $cached_age) - this worktree may start behind the true remote tip"
  base_ref="origin/$base_branch"
else
  log "WARN no origin/$base_branch, branching from local $base_branch"
fi

# --- Pick a free branch name and worktree path -------------------------------
worktrees_dir="$repo_root/.worktrees"
if ! git -C "$repo_root" check-ignore -q .worktrees/ 2>/dev/null; then
  log "WARN .worktrees/ is not gitignored, add it to .gitignore"
fi
base_path="$worktrees_dir/$slug"
worktree_path="$base_path"
branch="$slug"
i=2
while [[ -e "$worktree_path" ]] || git -C "$repo_root" show-ref --verify --quiet "refs/heads/${branch}"; do
  worktree_path="${base_path}-${i}"
  branch="${slug}-${i}"
  i=$((i + 1))
done

# --- Create the worktree (the one fatal step) --------------------------------
# Once the worktree exists, a later unexpected failure must not leave it
# behind: non-zero exit tells Claude "creation failed", so on-disk state has
# to match. This trap removes the worktree + branch only on a failing exit.
worktree_created=""
cleanup_on_failure() {
  local code=$?
  if [[ -n "$worktree_created" && "$code" -ne 0 ]]; then
    log "setup failed (exit $code); removing partially created worktree"
    git -C "$repo_root" worktree remove --force "$worktree_path" >&2 2>/dev/null || true
    git -C "$repo_root" branch -D "$branch" >&2 2>/dev/null || true
  fi
}
trap cleanup_on_failure EXIT

log "creating worktree '$branch' at $worktree_path from $base_ref"
git -C "$repo_root" worktree add -b "$branch" "$worktree_path" "$base_ref" >&2

worktree_created=1

# --- Symlink local env files (best-effort) -----------------------------------
# Symlinks (not copies) so rotated keys and new vars stay in sync with the
# main checkout. Note the flip side: editing .env inside a worktree edits the
# shared file. Switch `ln -s` to `cp` here if a repo needs isolation instead.
log "symlinking local .env / .env.local files"
linked=0
while IFS= read -r -d '' src; do
  rel="${src#"$repo_root"/}"
  dest="$worktree_path/$rel"
  # A tracked env file is already checked out at dest; replacing it with a
  # symlink would leave a permanent type-change in every worktree's status.
  # Only gitignored env files get linked.
  if git -C "$repo_root" ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
    log "    skip $rel (tracked in git)"
    continue
  fi
  if mkdir -p "$(dirname "$dest")" && ln -sfn "$src" "$dest"; then
    log "    $rel"
    linked=$((linked + 1))
  else
    log "    WARN failed to link $rel"
  fi
done < <(
  find "$repo_root" \
    \( -name node_modules -o -name .git -o -name .worktrees \) -prune -o \
    -type f \( -name '.env' -o -name '.env.local' \) -print0
)
if [[ "$linked" -eq 0 ]]; then
  log "    (no .env / .env.local files found)"
fi

# --- Install dependencies (best-effort) --------------------------------------
install_deps() {
  if [[ -f "$worktree_path/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
    log "running pnpm install"
    pnpm --dir "$worktree_path" install >&2
  elif [[ -f "$worktree_path/yarn.lock" ]] && command -v yarn >/dev/null 2>&1; then
    log "running yarn install"
    (cd "$worktree_path" && yarn install) >&2
  elif { [[ -f "$worktree_path/bun.lockb" ]] || [[ -f "$worktree_path/bun.lock" ]]; } && command -v bun >/dev/null 2>&1; then
    log "running bun install"
    (cd "$worktree_path" && bun install) >&2
  elif [[ -f "$worktree_path/package-lock.json" ]] && command -v npm >/dev/null 2>&1; then
    log "running npm install"
    npm --prefix "$worktree_path" install >&2
  else
    log "no known lockfile (or package manager missing), skipping install"
    return 0
  fi
}
if ! install_deps; then
  log "WARN dependency install failed - run it manually in the worktree"
fi

# --- Repo-specific extras (best-effort) --------------------------------------
if [[ -x "$repo_root/scripts/worktree-post-setup.sh" ]]; then
  log "running scripts/worktree-post-setup.sh"
  if ! "$repo_root/scripts/worktree-post-setup.sh" "$worktree_path" >&2; then
    log "WARN worktree-post-setup.sh failed - continuing"
  fi
fi

# --- Hand the path back to Claude (stdout = path, nothing else) --------------
log "done"
printf '%s\n' "$worktree_path"
