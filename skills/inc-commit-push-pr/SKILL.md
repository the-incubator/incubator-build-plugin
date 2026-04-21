---
name: inc:commit-push-pr-4
description: Commit, push, and open a PR with an adaptive, value-first description. Use when the user says "commit and PR", "push and open a PR", "ship this", "create a PR", "open a pull request", "commit push PR", or wants to go from working changes to an open pull request in one step. Also use when the user says "update the PR description", "refresh the PR description", "freshen the PR", or wants to rewrite an existing PR description. Produces PR descriptions that scale in depth with the complexity of the change, avoiding cookie-cutter templates.
---

# Git Commit, Push, and PR

Go from working changes to an open pull request, or rewrite an existing PR description.

**Asking the user:** When this skill says "ask the user", use the platform's blocking question tool (`AskUserQuestion` in Claude Code, `request_user_input` in Codex, `ask_user` in Gemini). If unavailable, present the question and wait for a reply.

## Mode detection

If the user is asking to update, refresh, or rewrite an existing PR description (with no mention of committing or pushing), this is a **description-only update**. The user may also provide a focus (e.g., "update the PR description and add the benchmarking results"). Note any focus for DU-3.

For description-only updates, follow the Description Update workflow below. Otherwise, follow the full workflow.

## Context

**On platforms other than Claude Code**, skip to the "Context fallback" section below and run the command there to gather context.

**In Claude Code**, the six labeled sections below contain pre-populated data. Use them directly -- do not re-run these commands.

**Git status:**
!`git status`

**Working tree diff:**
!`git diff HEAD`

**Current branch:**
!`git branch --show-current`

**Recent commits:**
!`git log --oneline -10`

**Remote default branch:**
!`git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo 'DEFAULT_BRANCH_UNRESOLVED'`

**Existing PR check:**
!`gh pr view --json url,title,state 2>/dev/null || echo 'NO_OPEN_PR'`

### Context fallback

**In Claude Code, skip this section — the data above is already available.**

Run this single command to gather all context:

```bash
printf '=== STATUS ===\n'; git status; printf '\n=== DIFF ===\n'; git diff HEAD; printf '\n=== BRANCH ===\n'; git branch --show-current; printf '\n=== LOG ===\n'; git log --oneline -10; printf '\n=== DEFAULT_BRANCH ===\n'; git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo 'DEFAULT_BRANCH_UNRESOLVED'; printf '\n=== PR_CHECK ===\n'; gh pr view --json url,title,state 2>/dev/null || echo 'NO_OPEN_PR'
```

---

## Description Update workflow

### DU-1: Confirm intent

Ask the user: "Update the PR description for this branch?" If declined, stop.

### DU-2: Find the PR

Use the current branch and existing PR check from context. If the current branch is empty (detached HEAD), report no branch and stop. If the PR check returned `state: OPEN`, note the PR `url` from the context block — this is the unambiguous reference to pass downstream — and proceed to DU-3. Otherwise, report no open PR and stop.

### DU-3: Write and apply the updated description

Read the current PR description to drive the compare-and-confirm step later:

```bash
gh pr view --json body --jq '.body'
```

**Generate the updated title and body** — load the `pr-description` skill with the PR URL from DU-2 (e.g., `https://github.com/owner/repo/pull/123`). The URL preserves repo/PR identity even when invoked from a worktree or subdirectory where the current repo is ambiguous. If the user provided a focus (e.g., "include the benchmarking results"), append it as free-text steering after the URL. The skill returns a `{title, body_file}` block (body in an OS temp file) without applying or prompting.

If `pr-description` returns a "not open" or other graceful-exit message instead of a `{title, body_file}` pair, report that message and stop.

**Evidence decision:** `pr-description` preserves any existing `## Demo` or `## Screenshots` block from the current body by default. If the user's focus asks to refresh or remove evidence, pass that intent as steering text — the skill will honor it. If no evidence block exists and one would benefit the reader, invoke `demo-reel` separately to capture, then re-invoke `pr-description` with updated steering that references the captured evidence.

**Test-plan decision.** Check the current PR body for an existing `## Test plan` (or `## How to test`) section that covers core scenarios, secondary scenarios, and unhappy paths with concrete steps. Three paths:

- **Existing plan is complete** — pass `preserve-test-plan` as steering so `pr-description` keeps it verbatim. Skip the interview.
- **Existing plan is thin, outdated, or missing** — run the full test-plan interview described in the Full workflow Step 6 ("Test-plan interview"), using the same three buckets (core / secondary / unhappy) and the same structured `test-plan:` steering block. Pass that block to `pr-description` in place of `preserve-test-plan`.
- **User's focus explicitly asks to refresh the test plan** — run the interview regardless of the existing plan's completeness.

When in doubt between the first two paths, run the interview. A PO needs concrete steps more than a clean diff.

**Compare and confirm** — briefly explain what the new description covers differently from the old one. This helps the user decide whether to apply; the description itself does not narrate these differences. Summarize from the body already in context (from the bash call that wrote `body_file`); do not `cat` the temp file, which would re-emit the body.

- If the user provided a focus, confirm it was addressed.
- Ask the user to confirm before applying.

**If confirmed, perform these two actions in order.** They are separate steps with a hand-off boundary between them — do not stop after action 1.

1. `pr-description` has already returned its `=== TITLE ===` / `=== BODY_FILE ===` block and stopped; it does not apply on its own.
2. Apply the returned title and body file yourself. This is this skill's responsibility, not the delegated skill's. Substitute `<TITLE>` and `<BODY_FILE>` verbatim from the return block; if `<TITLE>` contains `"`, `` ` ``, `$`, or `\`, escape them or switch to single quotes:

   ```bash
   gh pr edit --title "<TITLE>" --body "$(cat "<BODY_FILE>")"
   ```

Report the PR URL.

---

## Full workflow

### Step 1: Gather context

Use the context above. All data needed for this step and Step 3 is already available -- do not re-run those commands.

The remote default branch value returns something like `origin/main`. Strip the `origin/` prefix. If it returned `DEFAULT_BRANCH_UNRESOLVED` or a bare `HEAD`, try:

```bash
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
```

If both fail, fall back to `main`.

If the current branch is empty (detached HEAD), explain that a branch is required. Ask whether to create a feature branch now.
- If yes, derive a branch name from the change content, create with `git checkout -b <branch-name>`, and use that for the rest of the workflow.
- If no, stop.

If the working tree is clean (no staged, modified, or untracked files), determine the next action:

1. Run `git rev-parse --abbrev-ref --symbolic-full-name @{u}` to check upstream.
2. If upstream exists, run `git log <upstream>..HEAD --oneline` for unpushed commits.

Decision tree:

- **On default branch, unpushed commits or no upstream** -- ask whether to create a feature branch (pushing default directly is not supported). If yes, create and continue from Step 5. If no, stop.
- **On default branch, all pushed, no open PR** -- report no feature branch work. Stop.
- **Feature branch, no upstream** -- skip Step 4, continue from Step 5.
- **Feature branch, unpushed commits** -- skip Step 4, continue from Step 5.
- **Feature branch, all pushed, no open PR** -- skip Steps 4-5, continue from Step 6.
- **Feature branch, all pushed, open PR** -- report up to date. Stop.

### Step 2: Determine conventions

Priority order for commit messages and PR titles:

1. **Repo conventions in context** -- follow project instructions if they specify conventions. Do not re-read; they load at session start.
2. **Recent commit history** -- match the pattern in the last 10 commits.
3. **Default** -- `type(scope): description` (conventional commits).

### Step 3: Check for existing PR

Use the current branch and existing PR check from context. If the branch is empty, report detached HEAD and stop.

If the PR check returned `state: OPEN`, note the URL -- this is the existing-PR flow. Continue to Step 4 and 5 (commit any pending work and push), then go to Step 7 to ask whether to rewrite the description. Only run Step 6 (which generates a new description via `pr-description`) if the user confirms the rewrite; Step 7's existing-PR sub-path consumes the `{title, body_file}` that Step 6 produces. Otherwise (no open PR), continue through Steps 6, 7, and 8 in order.

### Step 4: Branch, stage, and commit

1. If on the default branch, create a feature branch first with `git checkout -b <branch-name>`.
2. Scan changed files for naturally distinct concerns. If files clearly group into separate logical changes, create separate commits (2-3 max). Group at the file level only (no `git add -p`). When ambiguous, one commit is fine.
3. Stage and commit each group in a single call. Avoid `git add -A` or `git add .`. Follow conventions from Step 2:
   ```bash
   git add file1 file2 file3 && git commit -m "$(cat <<'EOF'
   commit message here
   EOF
   )"
   ```

### Step 5: Push

```bash
git push -u origin HEAD
```

### Step 6: Generate the PR title and body

The working-tree diff from Step 1 only shows uncommitted changes at invocation time. The PR description must cover **all commits** in the PR.

**Detect the base branch and remote.** Resolve both the base branch and the remote (fork-based PRs may use a remote other than `origin`). Stop at the first that succeeds:

1. **PR metadata** (if existing PR found in Step 3):
   ```bash
   gh pr view --json baseRefName,url
   ```
   Extract `baseRefName`. Match `owner/repo` from the PR URL against `git remote -v` fetch URLs to find the base remote. Fall back to `origin`.
2. **Remote default branch from context** -- if resolved, strip `origin/` prefix. Use `origin`.
3. **GitHub metadata:**
   ```bash
   gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
   ```
   Use `origin`.
4. **Common names** -- check `main`, `master`, `develop`, `trunk` in order:
   ```bash
   git rev-parse --verify origin/<candidate>
   ```
   Use `origin`.

If none resolve, ask the user to specify the target branch.

**Gather the full branch diff (before evidence decision).** The working-tree diff from Step 1 only reflects uncommitted changes at invocation time — on the common "feature branch, all pushed, open PR" path, Step 1 skips the commit/push steps and the working-tree diff is empty. The evidence decision below needs the real branch diff to judge whether behavior is observable, so compute it explicitly against the base resolved above. Only fetch when the local ref isn't available — if `<base-remote>/<base-branch>` already resolves locally, run the diff from local state so offline / restricted-network / expired-auth environments don't hard-fail:

```bash
git rev-parse --verify <base-remote>/<base-branch> >/dev/null 2>&1 \
  || git fetch --no-tags <base-remote> <base-branch>
git diff <base-remote>/<base-branch>...HEAD
```

Use this branch diff (not the working-tree diff) for the evidence decision. If the branch diff is empty (e.g., HEAD is already merged into the base or the branch has no unique commits), skip the evidence prompt and continue to delegation.

**Evidence decision (before delegation).** If the branch diff changes observable behavior (UI, CLI output, API behavior with runnable code, generated artifacts, workflow output) and evidence is not otherwise blocked (unavailable credentials, paid services, deploy-only infrastructure, hardware), ask: "This PR has observable behavior. Capture evidence for the PR description?"

- **Capture now** -- load the `demo-reel` skill with a target description inferred from the branch diff. `demo-reel` returns `Tier`, `Description`, and `URL`. Note the captured evidence so it can be passed as free-text steering to `pr-description` (e.g., "include the captured demo: <URL> as a `## Demo` section") or spliced into the returned body before apply. If capture returns `Tier: skipped` or `URL: "none"`, proceed with no evidence.
- **Use existing evidence** -- ask for the URL or markdown embed, then pass it as free-text steering to `pr-description` or splice in before apply.
- **Skip** -- proceed with no evidence section.

When evidence is not possible (docs-only, markdown-only, changelog-only, release metadata, CI/config-only, test-only, or pure internal refactors), skip without asking.

**Test-plan interview (before delegation).** Humans reviewing this PR are primarily checking product acceptance — they need a concrete plan they can execute. Do not skip this gate for anything non-trivial. Skip only when the branch diff is docs-only, markdown-only, changelog-only, release metadata, CI/config-only, pure internal refactor with no observable behavior change, or a small+simple change per the `pr-description` sizing table.

Ask the user for the concrete test plan the product owner (or a reviewer standing in for one) will execute. Structure the prompt around three buckets — every test plan must cover all three:

1. **Core scenarios** — the primary happy-path flows the PR exists to enable. "What is the main thing a user should be able to do now? Walk me through it."
2. **Secondary scenarios (higher-likelihood variants)** — realistic adjacent cases: alternate input types, common user configurations, role variants, neighboring flows this PR touches. "What other realistic paths through this should we verify?"
3. **Unhappy paths (critical ones)** — the failure modes that matter: invalid input, permission denied, network failure, missing prerequisite state, expired session. Not an exhaustive error catalog — the ones where silent failure or wrong behavior would be a product incident. "Which error or edge cases must behave correctly for this to ship?"

For each scenario across all three buckets, collect enough for a reviewer to actually run it without guessing:
- URL or route (or CLI command / API endpoint)
- Inputs or setup data
- Prerequisite state (seed data, feature flag, account type, role)
- Expected observable outcome

If the user gives a thin answer ("test the form submits"), push once for concrete inputs and the expected observable outcome. If they push back ("just use your judgment"), infer what you can from the diff and mark any inferred step with `(inferred — please verify)` so the product owner can spot-check it.

Format the collected plan as a structured block to pass as steering to `pr-description`. Use this exact shape so the downstream skill can render it verbatim:

```
test-plan:
## Core scenarios
- [scenario]: [steps with URL/inputs/prereqs] → [expected outcome]

## Secondary scenarios
- [scenario]: [steps] → [expected outcome]

## Unhappy paths
- [scenario]: [steps] → [expected outcome]
```

Omit a bucket only if the user explicitly confirmed it has no applicable cases ("no unhappy paths matter for this chore PR"). Do not silently drop a bucket.

**Delegate title and body generation to `pr-description`.** Load the `pr-description` skill:

- **For a new PR** (no existing PR found in Step 3): invoke with `base:<base-remote>/<base-branch>` using the already-resolved base from earlier in this step, so `pr-description` describes the correct commit range even when the branch targets a non-default base (e.g., `develop`, `release/*`). Append any captured-evidence context, test-plan block, or user focus as free-text steering (e.g., "include the captured demo: <URL> as a `## Demo` section").
- **For an existing PR** (found in Step 3): invoke with the full PR URL from the Step 3 context (e.g., `https://github.com/owner/repo/pull/123`). The URL preserves repo/PR identity even when invoked from a worktree or subdirectory; the skill reads the PR's own `baseRefName` so no `base:` override is needed. Append the test-plan block and any focus steering as free text after the URL.

**Steering discipline.** Pass only what the diff cannot reveal: a user focus ("emphasize the performance win"), a specific framing concern ("this needs to read as a migration not a feature"), the test-plan block from the interview above, or a pointer to institutional knowledge. Do NOT dump an exhaustive scope summary or a numbered list of every change — `pr-description` reads the diff itself. Over-specified steering encourages the downstream skill to cover everything passed in, producing verbose output. Cap non-test-plan steering at roughly 100 words; the test-plan block is exempt from that cap since it is a user-authored artifact that must be preserved verbatim.

`pr-description` returns a `{title, body_file}` block (body in an OS temp file). It applies the value-first writing principles, commit classification, sizing, narrative framing, writing voice, visual communication, numbering rules internally. Use the returned values verbatim in Step 7; do not layer manual edits onto them unless a focused adjustment is required (e.g., splicing an evidence block captured in this step that was not passed as steering text — in that case, edit the body file directly before applying).

If `pr-description` returns a graceful-exit message instead of `{title, body_file}` (e.g., closed PR, no commits to describe, base ref unresolved), report the message and stop — do not create or edit the PR.

### Step 7: Create or update the PR

#### New PR (no existing PR from Step 3)

Using the `=== TITLE ===` / `=== BODY_FILE ===` block returned by `pr-description`, substitute `<TITLE>` and `<BODY_FILE>` verbatim. If `<TITLE>` contains `"`, `` ` ``, `$`, or `\`, escape them or switch to single quotes:

```bash
gh pr create --title "<TITLE>" --body "$(cat "<BODY_FILE>")"
```

Keep the title under 72 characters; `pr-description` already emits a conventional-commit title in that range.

#### Existing PR (found in Step 3)

The new commits are already on the PR from Step 5. Report the PR URL, then ask whether to rewrite the description.

- If **no** -- skip Step 6 entirely and finish. Do not run delegation or evidence capture when the user declined the rewrite.
- If **yes**, perform these three actions in order. They are separate steps with a hand-off boundary between them -- do not stop between actions.
  1. Run Step 6 to generate via `pr-description` (passing the existing PR URL as `pr:`). `pr-description` explicitly does not apply on its own; it returns its `=== TITLE ===` / `=== BODY_FILE ===` block and stops.
  2. **Preview and confirm.** Read the first two sentences of the Summary from the body file, plus the total line count. Ask the user (per the "Asking the user" convention at the top of this skill): "New title: `<title>` (`<N>` chars). Summary leads with: `<first two sentences>`. Total body: `<L>` lines. Apply?" The first two sentences of the Summary carry most of the reviewer's attention; they are the single highest-leverage text in the description, so they are what the preview spotlights. If the user declines, they may pass steering text back for a regenerate; do not apply.
  3. If confirmed, apply the returned title and body file yourself. This is this skill's responsibility, not the delegated skill's. Substitute `<TITLE>` and `<BODY_FILE>` verbatim from the return block; if `<TITLE>` contains `"`, `` ` ``, `$`, or `\`, escape them or switch to single quotes:

     ```bash
     gh pr edit --title "<TITLE>" --body "$(cat "<BODY_FILE>")"
     ```

  Then report the PR URL (Step 8).

### Step 8: Report

Output the PR URL.
