---
name: inc:worktree
description: Manage git worktrees in a repo - bootstrap the worktree infrastructure when missing (a WorktreeCreate hook plus scripts/worktree-setup.sh that branches fresh from origin's default branch, symlinks .env files, installs dependencies, and prunes stale worktrees on every creation), show worktree status, and prune worktrees whose PRs have merged (squash-merge aware; PR state is the source of truth, so this cleans up worktrees that "could not be removed" by the harness). Triggers on "setup worktrees", "init worktrees", "worktree setup", "initialize worktrees for this repo", "clean up worktrees", "prune worktrees", "remove old worktrees", "stale worktrees", "worktree status", "my worktrees are behind main", "worktree could not be removed", or "/inc:worktree".
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion, Bash(git *), Bash(gh *), Bash(jq *), Bash(bash *), Bash(cp *), Bash(chmod *), Bash(mkdir *), Bash(cat *), Bash(printf *), Bash(du *), Bash(test *)
argument-hint: "[init|status|prune] (default: auto-detect)"
---

# Worktree - Bootstrap, Status, Prune

One skill for the whole worktree lifecycle in a repo, solving two chronic problems:

1. **Worktrees born behind.** Creating a worktree from a stale local `main` (or a stale `origin/main` tracking ref) starts every job dozens of commits behind.
   The fix is fetch-then-branch: the installed setup script fetches origin's default branch at creation time and branches from `origin/<default>`, never from local refs.
2. **Worktrees that never get cleaned up.** Squash-merged PRs never appear in local `main`, so every worktree looks like it holds unmerged work, harness cleanup declines to delete it ("Worktree could not be removed - kept at ..."), and node_modules-filled worktrees pile up into tens of GB.
   The fix is PR-state-based pruning: a worktree is stale when a merged PR's head is exactly its branch tip.
   Pruning runs opportunistically on every worktree creation (no cron, no manual step) and on demand via this skill.

**Plugin scripts:** Commands that use `<plugin root>` need the installed `incubator-build` plugin directory. In Claude Code, use `${CLAUDE_PLUGIN_ROOT}`. In Codex, resolve it from the loaded skill path: the plugin root is two directories above this `SKILL.md`.

## User-invocable

When the user types `/inc:worktree`, run this skill.
An optional argument picks the mode directly: `init`, `status`, or `prune`.

## Mode routing

With no argument, detect the repo's state and route:

```bash
test -f scripts/worktree-setup.sh && echo HAS_SCRIPT
jq -e '.hooks.WorktreeCreate | length > 0' .claude/settings.json >/dev/null 2>&1 && echo HAS_HOOK
```

(The `length > 0` matters: a bare `"WorktreeCreate": []` is not an installed hook and must route to repair, not Status.)

- Neither present: run **Init**.
- Both present: run **Status**, and offer **Prune** if there are candidates.
  Also diff the installed script against the plugin template (`diff scripts/worktree-setup.sh "${CLAUDE_PLUGIN_ROOT}/skills/inc-worktree/templates/worktree-setup.sh"`); if it is an older or custom version, offer migration to the current template (Step 1 of Init governs how to ask).
- One present without the other (half-installed or a custom setup): report exactly what exists, then confirm with the user before repairing via **Init**.

## Init - install the worktree infrastructure

### Step 1 - Respect existing customization

If `scripts/worktree-setup.sh` already exists and differs from the plugin template, do NOT overwrite it silently.
Read it, summarize how its behavior differs from the template (worktree placement, env copy vs symlink, prune support), and ask the user whether to replace it.
Two facts to state when asking:

- Changing placement does not move existing worktrees; they stay where they are.
- Prune still covers them regardless, because it iterates `git worktree list`, never directory names.

### Step 2 - Install the script

```bash
mkdir -p scripts
cp "${CLAUDE_PLUGIN_ROOT}/skills/inc-worktree/templates/worktree-setup.sh" scripts/worktree-setup.sh
chmod +x scripts/worktree-setup.sh
```

### Step 3 - Wire the WorktreeCreate hook

Merge into `.claude/settings.json` without clobbering existing keys (create the file if missing):

```bash
mkdir -p .claude
target='.claude/settings.json'
test -f "$target" || echo '{}' > "$target"
jq '.hooks.WorktreeCreate = [{"hooks": [{"type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/scripts/worktree-setup.sh\""}]}]' \
  "$target" > "$target.tmp" && mv "$target.tmp" "$target"
```

If the file has an existing `WorktreeCreate` entry pointing elsewhere, stop and confirm before replacing it (Step 1 rules apply).

### Step 4 - Gitignore the worktree directory

Ensure `.gitignore` contains a `.worktrees/` line (check with `git check-ignore -q .worktrees/` - trailing slash matters); append it if missing.

### Step 5 - Smoke test

Prove the install works end to end, then clean up the evidence.
Capture the script's stdout: on a name collision it suffixes (`inc-worktree-smoke-2`), so cleanup must target exactly the path it returned, never a hardcoded one - removing a hardcoded path could delete a pre-existing worktree.

```bash
SMOKE_PATH=$(printf '{"name":"inc-worktree-smoke"}' | bash scripts/worktree-setup.sh)
```

Verify: `$SMOKE_PATH` is one path under `.worktrees/`, the worktree exists on branch `$(basename "$SMOKE_PATH")`, and any gitignored `.env` / `.env.local` files are symlinked inside it.
Then remove exactly what was created:

```bash
git worktree remove --force "$SMOKE_PATH"
git branch -D "$(basename "$SMOKE_PATH")"
```

If the repo has a large dependency tree, warn the user the smoke test runs a real install and offer to skip it.

### Step 6 - Report

List the files added or changed (`scripts/worktree-setup.sh`, `.claude/settings.json`, `.gitignore`) and the smoke test result.
Do not commit; the user lands changes through their normal flow (for example `/inc:review-and-pr`).
If the repo needs extra per-worktree setup beyond env files and dependency install (codegen, database prep), point the user at the `scripts/worktree-post-setup.sh` extension point instead of editing the installed script.

## Status

Probe before running the installed script with flags: a legacy hook script treats unknown arguments as hook mode, so it can hang waiting on stdin or create a stray worktree.
Only use it when it demonstrably supports `--prune`; otherwise run the plugin template directly.

```bash
git worktree list
if grep -q -- '--prune' scripts/worktree-setup.sh 2>/dev/null; then
  bash scripts/worktree-setup.sh --prune --dry-run
else
  bash "${CLAUDE_PLUGIN_ROOT}/skills/inc-worktree/templates/worktree-setup.sh" --prune --dry-run
fi
```

Present a compact table: path, branch, and verdict (`WOULD-PRUNE` with PR number, or `KEEP` with the reason).
If anything is prunable, offer to run Prune.
For a disk-usage figure, `du -sh` the prunable paths (run in the background if there are many).

## Prune

Works in any repo, even one that never ran Init: the template script anchors itself via the git common dir, so it can run straight from the plugin:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/inc-worktree/templates/worktree-setup.sh" --prune --dry-run
```

(Prefer the repo's installed `scripts/worktree-setup.sh` only when `grep -q -- '--prune' scripts/worktree-setup.sh` confirms support; a legacy script would treat the flags as hook mode.)

1. **Dry-run first.** Run with `--prune --dry-run` and present the plan: every `WOULD-PRUNE` line (with PR number) and every `KEEP` line (with reason).
2. **Confirm.** Deleting worktrees is destructive; confirm with AskUserQuestion before applying, showing the count and, when cheap to compute, the disk it frees.
   Never skip this confirmation.
3. **Apply.** Run `--prune` (no `--dry-run`) and report the `PRUNED` lines.
4. **Explain what was kept.** `KEEP` reasons are: uncommitted changes, no merged PR for the branch, local commits after the PR merged, active within the last hour, or detached HEAD.
   Worktrees kept for "uncommitted changes" or "local commits after the PR merged" may hold real work; surface them for manual review, never force-delete them.

### Prune safety invariants (also enforced by the script)

- A worktree is removed only when ALL hold: linked worktree on a branch, clean working tree (ignored files like node_modules do not count as dirty), a merged PR whose head branch matches, that PR's head commit equals the local branch tip, no process has its working directory inside the worktree (lsof check), and no recent git index activity (24 hours for automatic prune-on-create, 1 hour for on-demand prune, which is dry-run + human-confirmed).
- The main checkout, detached HEADs, and the worktree the command runs from are never touched.
- `git branch --merged` is useless under squash merges; PR state via `gh` is the source of truth.
- Everything keys off `git worktree list`, so worktrees from older placement conventions (for example sibling directories) are covered too.

## The installed script's contract

`scripts/worktree-setup.sh` is self-contained (no plugin dependency at runtime) so collaborators without the plugin get identical behavior.

- **Hook mode** (Claude Code `WorktreeCreate`): stdin JSON `{"name": "<slug>"}`, stdout exactly the created worktree's absolute path, exit 0 on success.
  Creates `.worktrees/<slug>` on branch `<slug>` cut from a freshly fetched `origin/<default-branch>`, symlinks `.env` / `.env.local` from the main checkout, installs dependencies by lockfile (pnpm, yarn, bun, or npm), runs `scripts/worktree-post-setup.sh <path>` if present, and best-effort prunes stale worktrees first.
- **CLI mode**: `--prune [--dry-run]` as described above.
- Env symlink caveat: editing `.env` inside a worktree edits the shared file; a repo that needs isolation instead switches `ln -sfn` to `cp` in its installed copy.
