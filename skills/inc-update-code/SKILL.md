---
name: inc:update-code
description: Use when the user wants to pull the latest code from main into their current working branch. Triggers on "update code", "update from main", "sync with main", "pull main", "merge main in", "catch up to main", "rebase on main", or "/inc:update-code". Handles fetch, merge, and conflict-handoff to the merge expert.
allowed-tools: Bash(git *), Bash(gh *), Read, Grep, Glob, Skill, AskUserQuestion
argument-hint: "[optional: 'rebase' to rebase instead of merge]"
---

# Update Code From Main

Bring the latest commits from `main` into the current working branch. Hand off to `git-merge-expert` if conflicts appear.

## Inputs

- Optional argument: `rebase` to rebase the current branch onto `main` instead of merging `main` in. Default is merge.

## Context

**Current branch:**
!`git branch --show-current`

**Working tree state:**
!`git status --short`

**Default remote branch:**
!`git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo 'DEFAULT_REMOTE_UNRESOLVED'`

**Commits behind/ahead of origin/main:**
!`git fetch origin main --quiet && git rev-list --left-right --count HEAD...origin/main 2>/dev/null || echo 'COMPARE_FAILED'`

---

## Step 0: Guard against unsafe states

**Stop and report** if any of these are true:

- Current branch is `main` (or whatever `origin/HEAD` resolves to). Tell the user there is nothing to update — they're already on main. Suggest `git pull` if they meant to update local main.
- Working tree has uncommitted changes (status above is non-empty). Ask the user whether to:
  - **Stash** the changes, run the update, then restore them.
  - **Commit** first, then update.
  - **Cancel.**
- An in-progress merge, rebase, or cherry-pick is detected (`.git/MERGE_HEAD`, `.git/rebase-merge/`, or `.git/CHERRY_PICK_HEAD` exist). Hand off immediately to `git-merge-expert` to resolve the existing operation before starting a new one.

Use `AskUserQuestion` for the dirty-tree case. Do not silently mutate state.

**Success criteria:** Branch is not `main`, working tree is clean (or user-approved stash is in place), no other git operation is in progress.

## Step 1: Check whether an update is even needed

From the context block above, parse the `git rev-list --left-right --count HEAD...origin/main` output. The two numbers are `<ahead> <behind>`:

- If `behind == 0`: already up to date. Report and stop.
- If `behind > 0`: proceed.

Also surface `ahead` to the user so they know how many local commits will be preserved through the merge or replayed through the rebase.

**Success criteria:** User knows exactly how far behind main they are before any mutation.

## Step 2: Choose merge or rebase

Default to **merge** (`git merge origin/main`). Use **rebase** (`git rebase origin/main`) only when:

- The user passed `rebase` as the argument, OR
- The user explicitly asks for it during the conversation.

Warn before rebasing if the current branch is already pushed to a remote and may have collaborators — rebase rewrites history and forces a `--force-with-lease` push later.

**Success criteria:** Strategy is selected and (for rebase on a shared branch) the user has been warned.

## Step 3: Execute the update

Run the chosen command:

- **Merge:** `git merge origin/main --no-edit`
- **Rebase:** `git rebase origin/main`

Capture the exit code and output.

**If the command succeeds with no conflicts:** continue to Step 4.

**If conflicts are reported** (exit code non-zero, output mentions `CONFLICT`, or `git status` shows `Unmerged paths`):

1. Stop. Do not attempt to resolve conflicts inline.
2. Invoke the `git-merge-expert` skill via the `Skill` tool, passing context about the in-progress operation:
   - which branch is being updated
   - merge vs. rebase
   - the conflicting files (`git diff --name-only --diff-filter=U`)
3. After it returns, re-check `git status` to confirm the conflicts are resolved before continuing.

**Success criteria:** The merge or rebase has completed cleanly, either directly or via handoff.

## Step 4: Validate

Confirm coherent state:

- `git status` shows a clean working tree on the original branch.
- For merge: a new merge commit exists at `HEAD` (unless the merge was a fast-forward).
- For rebase: the original commits have been replayed on top of `origin/main`; the new `HEAD` is a descendant of `origin/main`.

If the user stashed changes in Step 0, run `git stash pop` and verify it applied without conflicts. If the pop conflicts, hand off again to `git-merge-expert`.

Do **not** automatically run build, test, or typecheck commands. The user can run those separately if they want.

**Success criteria:** Working tree is clean, branch is up to date with `origin/main`, stashed changes are restored if applicable.

## Step 5: Report

Report:

1. The branch that was updated and the strategy used (merge vs. rebase).
2. How many commits were pulled in from main.
3. Any conflicts that were resolved (and that `git-merge-expert` handled them).
4. Whether stashed changes were restored.
5. The current `HEAD` short SHA.
6. A reminder if the branch was rebased and needs `git push --force-with-lease` to update its remote.

Do **not** push automatically. Pushing is a separate user action.

## Guardrails

- Never run `git push`, `git push --force`, or `git reset --hard` from this skill. Pushing and force-pushing are user decisions.
- Never resolve merge conflicts inline. Always hand off to `git-merge-expert` so conflict logic stays in one place.
- Never `git stash drop` or `git stash clear`. If a stash pop fails, leave it in the stash list for the user.
- Do not switch branches. This skill operates on whatever branch is currently checked out.
- Do not abort an in-progress merge or rebase you did not start. Defer to the user or `git-merge-expert`.

## Output Contract

A short report containing:

- starting branch, strategy chosen, commits pulled, conflicts (if any) and how they were handled, stash restore status, final `HEAD` SHA, and any push reminder.
