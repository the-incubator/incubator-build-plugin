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
#        - no index entry is marked assume-unchanged or skip-worktree, since
#          git stops stat-ing those and an edit to one reports clean
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
# Anchor everything at the MAIN worktree even if invoked from a linked one.
# The main worktree is always the first entry of `git worktree list` - git's
# own metadata, which stays correct where dirname(--git-common-dir) does not
# (submodules and --separate-git-dir checkouts, whose .git is a file pointing
# at external storage). Derive from cwd first; CLAUDE_PROJECT_DIR is only a
# fallback for when the hook fires outside the repo, because in CLI mode it
# can name a different repo (the session's project) than the one being pruned.
# `|| true`: outside a repository this pipeline fails, and under errexit +
# pipefail a bare assignment would abort before the fallback below can run.
repo_root="$(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -1 || true)"
if [[ -z "$repo_root" ]]; then
  repo_root="${CLAUDE_PROJECT_DIR:?not inside a git repository and CLAUDE_PROJECT_DIR unset}"
fi

# --- Default branch detection ------------------------------------------------
default_branch() {
  local ref
  if ref="$(git -C "$repo_root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)"; then
    echo "${ref#origin/}"
    return
  fi
  # origin/HEAD is often unset in older clones; ask the remote directly so a
  # repo whose default branch is trunk/develop never falls through to guesses.
  ref="$(git -C "$repo_root" ls-remote --symref origin HEAD 2>/dev/null | awk '/^ref:/{print $2; exit}')"
  if [[ -n "$ref" ]]; then
    echo "${ref#refs/heads/}"
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
  # `local` is dynamically scoped: cwd_list is visible in prune_one below. It
  # snapshots every process's working directory once so each candidate
  # worktree can be checked for live occupants. Without lsof that guard is
  # blind, so unattended pruning must not run at all; interactive modes warn
  # and rely on the human reviewing the plan. gh runs from $repo_root and
  # infers the repo from the git remote - passing the raw remote URL to
  # --repo breaks on SSH-style remotes (gh expects [HOST/]OWNER/REPO).
  local merged cwd_list lsof_problem=""
  cwd_list=""
  if ! command -v lsof >/dev/null 2>&1; then
    lsof_problem="lsof not found"
  elif ! cwd_list="$(lsof -a -d cwd -Fn 2>/dev/null)"; then
    # An installed lsof can still fail (permissions, /proc restrictions, a
    # transient error). Forcing success with `|| true` would leave cwd_list
    # empty and make the guard silently pass everything.
    lsof_problem="lsof scan failed"
    cwd_list=""
  fi
  if [[ -n "$lsof_problem" ]]; then
    if [[ "$mode" == "best-effort" ]]; then
      log "prune: $lsof_problem (cannot detect live worktrees), skipping"
      return 0
    fi
    echo "WARN: $lsof_problem - the live-process guard is unavailable; review the plan carefully" >&2
  fi
  if ! merged="$(cd "$repo_root" && gh pr list \
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
  # A dry run must not mutate .git/worktrees metadata; only real prune passes
  # clean up stale registrations.
  if [[ "$mode" != "dry-run" ]]; then
    git -C "$repo_root" worktree prune >/dev/null 2>&1 || true
  fi
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
  # Literal comparison, not grep: a path containing regex metacharacters (`[`,
  # `+`, ...) would silently stop matching and disarm this guard. The boundary
  # test also keeps /a/b from matching a sibling /a/bc.
  if [[ -n "$cwd_list" ]]; then
    local cwd_line cwd_path
    while IFS= read -r cwd_line; do
      [[ "$cwd_line" == n* ]] || continue
      cwd_path="${cwd_line#n}"
      if [[ "$cwd_path" == "$path" || "$cwd_path" == "$path"/* ]]; then
        [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (a process is running inside it)"
        return 0
      fi
    done <<< "$cwd_list"
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
  # Two safety details here, both guarding a --force removal:
  #   - a FAILED status (corrupt/unreadable index) must never read as "clean";
  #     capture the exit status separately from the empty-output case
  #   - --untracked-files=all overrides a repo/user `status.showUntrackedFiles`
  #     setting that would otherwise hide uncommitted new files
  #   - --ignore-submodules=none overrides `diff.ignoreSubmodules=all`, which
  #     would otherwise hide uncommitted work inside an initialized submodule
  local status_out
  if ! status_out="$(git --no-optional-locks -C "$path" status --porcelain \
      --untracked-files=all --ignore-submodules=none 2>/dev/null)"; then
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (could not read git status)"
    return 0
  fi
  if [[ -n "$status_out" ]]; then
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (uncommitted changes)"
    return 0
  fi
  # `git status` is blind to files marked assume-unchanged or skip-worktree:
  # both tell git to trust the index and stop stat-ing the file, so an edited
  # file reports clean and a --force removal would destroy work that was never
  # committed and never shown. Those bits are rare and always set deliberately,
  # so their mere presence means "this tree's contents are unverifiable" -- keep
  # it rather than diff every flagged entry. `ls-files -v` lowercases the tag
  # letter for assume-unchanged and prints `S` for skip-worktree; a listing that
  # fails is unreadable index state, which keeps for the same reason as above.
  local flagged_out
  if ! flagged_out="$(git --no-optional-locks -C "$path" ls-files -v 2>/dev/null)"; then
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (could not read index flags)"
    return 0
  fi
  if printf '%s\n' "$flagged_out" | grep -qE '^[a-zS] '; then
    [[ "$mode" != "best-effort" ]] && echo "KEEP $path branch=$branch (assume-unchanged/skip-worktree entries hide their contents from git status)"
    return 0
  fi
  local pr
  # Branch names get reused across PRs: scan every merged PR with this head
  # branch and prune if ANY of them merged exactly this tip. SHA_MISMATCH only
  # when name matches exist but none has this tip.
  pr="$(printf '%s' "$merged" | python3 -c '
import json, sys
branch, tip = sys.argv[1], sys.argv[2]
match = ""
for pr in json.load(sys.stdin):
    if pr.get("headRefName") == branch:
        if pr.get("headRefOid") == tip:
            match = str(pr.get("number"))
            break
        match = match or "SHA_MISMATCH"
print(match)
' "$branch" "$sha" 2>/dev/null || true)"
  # The bulk list caps at the 300 most recent merged PRs; an old worktree can
  # fall past it and become unprunable. In CLI modes, fall back to an exact
  # per-branch lookup. SHA_MISMATCH also triggers it: a newer PR can reuse the
  # branch name while the PR that actually merged this tip sits past the cap.
  # Hook mode skips the fallback to keep worktree creation fast.
  if [[ ( -z "$pr" || "$pr" == "SHA_MISMATCH" ) && "$mode" != "best-effort" ]]; then
    local fallback_pr
    fallback_pr="$(cd "$repo_root" && gh pr list --head "$branch" --state merged \
        --limit 20 --json headRefOid,number 2>/dev/null | python3 -c '
import json, sys
tip = sys.argv[1]
match = ""
for p in json.load(sys.stdin):
    if p.get("headRefOid") == tip:
        match = str(p.get("number"))
        break
    match = match or "SHA_MISMATCH"
print(match)
' "$sha" 2>/dev/null || true)"
    # Only let the fallback improve the verdict, never erase a known mismatch.
    [[ -n "$fallback_pr" ]] && pr="$fallback_pr"
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
  # refusal over ignored files such as node_modules. Capture git's own error so
  # a failed destructive step explains itself instead of just saying "failed".
  local remove_err
  if remove_err="$(git -C "$repo_root" worktree remove --force "$path" 2>&1 >/dev/null)"; then
    git -C "$repo_root" branch -D "$branch" >/dev/null 2>&1 || true
    if [[ "$mode" == "best-effort" ]]; then
      log "pruned $path (branch $branch, PR #$pr merged)"
    else
      echo "PRUNED $path branch=$branch (PR #$pr merged)"
    fi
  else
    remove_err="$(printf '%s' "$remove_err" | head -1)"
    if [[ "$mode" == "best-effort" ]]; then
      log "could not remove $path: ${remove_err:-unknown error}"
    else
      echo "KEEP $path branch=$branch (git worktree remove failed: ${remove_err:-unknown error})"
    fi
  fi
  return 0
}

# --- CLI mode ----------------------------------------------------------------
# Argument handling is strict on purpose. Hook mode takes no arguments and
# reads stdin, so a mistyped flag must never fall through to it (that would
# block on a terminal, then create a stray worktree), and a mistyped
# `--dry-run` must never fall through to the destructive apply path.
usage() {
  cat >&2 <<'USAGE'
usage:
  worktree-setup.sh                      hook mode: reads {"name": "..."} on stdin,
                                         prints the created worktree path on stdout
  worktree-setup.sh --prune [--dry-run]  remove worktrees whose PR has merged
  worktree-setup.sh --help               this message
USAGE
}
case "${1:-}" in
  --prune)
    case "${2:-}" in
      "")         prune_worktrees apply ;;
      --dry-run)  prune_worktrees dry-run ;;
      *)          echo "ERROR: unknown argument '$2' after --prune" >&2; usage; exit 2 ;;
    esac
    exit 0
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  "")
    : # no arguments: fall through to hook mode below
    ;;
  *)
    echo "ERROR: unknown argument '$1'" >&2
    usage
    exit 2
    ;;
esac

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
# Order matters: trim the ends BEFORE rewriting a trailing ".lock", or an
# input like "foo.lock." trims down to "foo.lock" after the rewrite already
# ran and git rejects the ref.
slug="$(printf '%s' "$slug" \
  | LC_ALL=C tr -c '[:alnum:]._-' '-' \
  | sed -E 's/\.{2,}/-/g; s/^[-.]+//; s/[-.]+$//; s/\.lock$/-lock/')"
# Final backstop: whatever survived must actually be a legal branch name, or
# `git worktree add` aborts worktree creation entirely.
if [[ -z "$slug" ]] || ! git check-ref-format --branch "$slug" >/dev/null 2>&1; then
  [[ -n "$slug" ]] && log "WARN slug '$slug' is not a valid branch name, using a generated one"
  slug="wt-$$"
fi

# --- Opportunistic prune (never blocks creation) -----------------------------
log "pruning stale worktrees (merged PR + clean tree)"
prune_worktrees best-effort || true

# --- Freshness: fetch, then branch from origin's default branch --------------
base_branch="$(default_branch)"
base_ref=""
# Explicit destination refspec: with a narrowed remote.origin.fetch config,
# `git fetch origin <branch>` can succeed without updating the remote-tracking
# ref. The + prefix keeps the ref moving even if the remote branch rewound.
fetch_branch() {
  git -C "$repo_root" fetch origin "+refs/heads/$1:refs/remotes/origin/$1" --quiet 2>/dev/null
}
log "fetching origin/$base_branch"
fetched=0
# `if`, not `fetch_branch ... && fetched=1`: under `set -e` the && form makes
# the whole statement fail when the fetch does, aborting an offline creation
# that is supposed to fall back to the cached ref below.
if fetch_branch "$base_branch"; then fetched=1; fi
# A recorded origin/HEAD can itself be stale, and a stale one still fetches
# happily whenever the old branch survives the rename: a remote that switches
# its default from main to develop but keeps main around leaves the cached
# symref working yet wrong, silently basing every worktree on the old default.
# So ask the remote for its current default whenever we can reach it - on the
# fetch-success path too, not only when the cached branch has disappeared.
# Offline runs never pay for this: the fetch above already failed by then.
# `|| true` is load-bearing: `pipefail` propagates ls-remote's failure through
# the pipe, and `set -e` would then abort the script instead of falling through
# to the cached-ref path - an unreachable remote must degrade, not crash.
remote_default="$(git -C "$repo_root" ls-remote --symref origin HEAD 2>/dev/null \
  | awk '/^ref:/{print $2; exit}' || true)"
remote_default="${remote_default#refs/heads/}"
if [[ -n "$remote_default" && "$remote_default" != "$base_branch" ]] \
   && fetch_branch "$remote_default"; then
  log "WARN local origin/HEAD said '$base_branch', but the remote default is '$remote_default' - using it"
  git -C "$repo_root" remote set-head origin "$remote_default" >/dev/null 2>&1 || true
  base_branch="$remote_default"
  base_ref="origin/$remote_default"
elif (( fetched )); then
  base_ref="origin/$base_branch"
fi
if [[ -n "$base_ref" ]]; then
  : # fetched cleanly above
elif git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$base_branch"; then
  # Deliberate tradeoff: offline/auth-failed creation still works, from the
  # best base available. The age makes the staleness visible instead of silent.
  cached_age="$(git -C "$repo_root" log -1 --format=%cr "refs/remotes/origin/$base_branch" 2>/dev/null || echo 'unknown age')"
  log "WARN fetch failed (offline?); using cached origin/$base_branch (last commit: $cached_age) - this worktree may start behind the true remote tip"
  base_ref="origin/$base_branch"
else
  log "WARN no origin/$base_branch, branching from local $base_branch"
  base_ref="$base_branch"
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
# `-b` creates the branch before the checkout phase, so a checkout failure
# (a failing smudge/LFS filter, for example) can leave the branch behind even
# though no worktree exists. Track the name from before the attempt so the
# trap can delete it either way; the name was proven free just above.
branch_claimed="$branch"
cleanup_on_failure() {
  local code=$?
  [[ "$code" -eq 0 ]] && return 0
  if [[ -n "$worktree_created" ]]; then
    log "setup failed (exit $code); removing partially created worktree"
    git -C "$repo_root" worktree remove --force "$worktree_path" >&2 2>/dev/null || true
  fi
  if [[ -n "$branch_claimed" ]] \
     && git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch_claimed"; then
    git -C "$repo_root" branch -D "$branch_claimed" >/dev/null 2>&1 || true
  fi
}
trap cleanup_on_failure EXIT

log "creating worktree '$branch' at $worktree_path from $base_ref"
# --no-track: without it the new branch tracks origin/<default>, so `git
# status` compares against main and push.default=upstream can push to main.
git -C "$repo_root" worktree add --no-track -b "$branch" "$worktree_path" "$base_ref" >&2

worktree_created=1

# --- Symlink local env files (best-effort) -----------------------------------
# Symlinks (not copies) so rotated keys and new vars stay in sync with the
# main checkout. Note the flip side: editing .env inside a worktree edits the
# shared file. Switch `ln -s` to `cp` here if a repo needs isolation instead.
log "symlinking local .env / .env.local files"
# Other worktrees live inside the repo (.worktrees/, or Claude Code's default
# .claude/worktrees/). Their env files belong to unrelated sessions, so the
# scan must never pick them up. The registered-path list covers custom
# placements too; find's -prune below is just the fast path.
other_worktrees="$(git -C "$repo_root" worktree list --porcelain 2>/dev/null \
  | sed -n 's/^worktree //p' | tail -n +2)"
linked=0
while IFS= read -r -d '' src; do
  rel="${src#"$repo_root"/}"
  dest="$worktree_path/$rel"
  skip=""
  while IFS= read -r wt; do
    [[ -n "$wt" && "$src" == "$wt"/* ]] && { skip=1; break; }
  done <<< "$other_worktrees"
  if [[ -n "$skip" ]]; then
    log "    skip $rel (belongs to another worktree)"
    continue
  fi
  # Only gitignored env files get linked. A tracked file is already checked
  # out at dest (a symlink would leave a permanent type-change), and an
  # untracked-but-not-ignored file would show as `?? .env` dirt in every
  # worktree's status, which also blocks pruning.
  #
  # Both questions are asked of the FETCHED worktree, not the main checkout:
  # this hook exists because local main goes stale, so the remote may already
  # track a path that stale main still ignores. Judging by $repo_root there
  # would clobber a tracked file in the new worktree with a local secret.
  if git -C "$worktree_path" ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
    log "    skip $rel (tracked in the fetched tree)"
    continue
  fi
  if ! git -C "$worktree_path" check-ignore -q "$rel" 2>/dev/null; then
    log "    skip $rel (not gitignored in the fetched tree)"
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
    \( -name node_modules -o -name .git -o -name .worktrees \
       -o -path "$repo_root/.claude/worktrees" \) -prune -o \
    \( -type f -o -type l \) \( -name '.env' -o -name '.env.local' \) -print0
)
if [[ "$linked" -eq 0 ]]; then
  log "    (no .env / .env.local files found)"
fi

# --- Copy .worktreeinclude matches (best-effort) ------------------------------
# This hook replaces Claude Code's default worktree creator, which copies
# files that BOTH match .worktreeinclude and are gitignored. Honor the same
# contract: same intersection, and copies (not symlinks) as the default does.
#
# The rules come from the FETCHED worktree (patterns and ignore state), while
# the files themselves are enumerated in the main checkout, which is where
# they live. A stale local main must not decide what the new worktree needs.
if [[ -f "$worktree_path/.worktreeinclude" ]]; then
  log "copying .worktreeinclude matches"
  copied=0
  seen_includes=""
  while IFS= read -r -d '' rel; do
    case "$rel" in .worktrees/* | .claude/worktrees/*) continue ;; esac
    # The two enumerations below can overlap; copy each path once.
    case "$seen_includes" in *"|$rel|"*) continue ;; esac
    seen_includes="$seen_includes|$rel|"
    # --exclude-from makes ls-files match the include patterns, but says
    # nothing about .gitignore; a matched file that is not gitignored would
    # land as `??` dirt in every new worktree.
    if ! git -C "$worktree_path" check-ignore -q "$rel" 2>/dev/null; then
      log "    skip $rel (not gitignored in the fetched tree)"
      continue
    fi
    dest="$worktree_path/$rel"
    [[ -e "$dest" || -L "$dest" ]] && continue
    if mkdir -p "$(dirname "$dest")" && cp "$repo_root/$rel" "$dest"; then
      log "    $rel"
      copied=$((copied + 1))
    else
      log "    WARN failed to copy $rel"
    fi
  done < <(
    # Neither call passes --exclude-standard, so only .worktreeinclude patterns
    # select paths - .gitignore does not widen the set.
    git -C "$repo_root" ls-files -z --others --ignored \
      --exclude-from="$worktree_path/.worktreeinclude" 2>/dev/null
    # `--others` is defined against the stale main index, so it omits paths
    # main still tracks. That is exactly the case where the include rule
    # matters: the fetched tree stopped tracking such a path and now ignores
    # it. Enumerate those too; the fetched-tree checks above still decide.
    git -C "$repo_root" ls-files -z --cached --ignored \
      --exclude-from="$worktree_path/.worktreeinclude" 2>/dev/null
  )
  if [[ "$copied" -eq 0 ]]; then
    log "    (no new files matched .worktreeinclude)"
  fi
fi

# --- Install dependencies (best-effort) --------------------------------------
# Frozen/immutable modes only. A plain `install` can rewrite the tracked
# lockfile (npm upgrading a v1 package-lock, pnpm normalizing, ...), which
# leaves every new worktree dirty and permanently unprunable. Better to
# install exactly what is committed, or fail and let the human decide.
install_cmd=""
install_deps() {
  if [[ -f "$worktree_path/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
    install_cmd="pnpm install --frozen-lockfile"
    log "running pnpm install --frozen-lockfile"
    pnpm --dir "$worktree_path" install --frozen-lockfile >&2
  elif [[ -f "$worktree_path/yarn.lock" ]] && command -v yarn >/dev/null 2>&1; then
    # Yarn 1 spells it --frozen-lockfile; Berry spells it --immutable. Probe
    # from inside the worktree: Corepack and `.yarnrc.yml` pin the generation
    # per directory, so asking the hook's own checkout can report Berry for a
    # tree that actually resolves to Classic (and then --immutable fails).
    if [[ "$( (cd "$worktree_path" && yarn --version) 2>/dev/null | cut -d. -f1)" == "1" ]]; then
      install_cmd="yarn install --frozen-lockfile"
    else
      install_cmd="yarn install --immutable"
    fi
    log "running $install_cmd"
    (cd "$worktree_path" && $install_cmd) >&2
  elif { [[ -f "$worktree_path/bun.lockb" ]] || [[ -f "$worktree_path/bun.lock" ]]; } && command -v bun >/dev/null 2>&1; then
    install_cmd="bun install --frozen-lockfile"
    log "running bun install --frozen-lockfile"
    (cd "$worktree_path" && bun install --frozen-lockfile) >&2
  elif [[ -f "$worktree_path/package-lock.json" ]] && command -v npm >/dev/null 2>&1; then
    install_cmd="npm ci"
    log "running npm ci"
    npm --prefix "$worktree_path" ci >&2
  else
    log "no known lockfile (or package manager missing), skipping install"
    return 0
  fi
}
if ! install_deps; then
  log "WARN dependency install failed - the lockfile may be out of sync with package.json."
  log "     The worktree is ready otherwise; finish it yourself with:"
  log "       cd $worktree_path && ${install_cmd:-<your package manager> install}"
fi

# --- Repo-specific extras (best-effort) --------------------------------------
# Run the copy from the new worktree, not the main checkout: the whole point
# of the fresh base is that the worktree may carry a newer version of this
# script than a stale local main has.
if [[ -x "$worktree_path/scripts/worktree-post-setup.sh" ]]; then
  log "running scripts/worktree-post-setup.sh"
  if ! "$worktree_path/scripts/worktree-post-setup.sh" "$worktree_path" >&2; then
    log "WARN worktree-post-setup.sh failed - continuing"
  fi
fi

# --- Hand the path back to Claude (stdout = path, nothing else) --------------
log "done"
printf '%s\n' "$worktree_path"
