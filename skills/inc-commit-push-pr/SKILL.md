---
name: inc:commit-push-pr-4
description: Commit, push, and open a PR with an adaptive, value-first description, then watch CI + AI reviewers and auto-resolve feedback in a loop until the PR is feedback-clean (pausing only for items needing a human call; skip with "just PR"/"don't watch"). Use when the user says "commit and PR", "push and open a PR", "ship this", "create a PR", "open a pull request", "commit push PR", or wants to go from working changes to an open pull request in one step. Also use when the user says "update the PR description", "refresh the PR description", "freshen the PR", or wants to rewrite an existing PR description. Produces PR descriptions that scale in depth with the complexity of the change, avoiding cookie-cutter templates.
---

# Git Commit, Push, and PR

Go from working changes to an open pull request, or rewrite an existing PR description. PR descriptions are intent-focused — tight, high-signal, and never a kitchen sink of file lists or code narration.

**Plugin scripts:** Commands that use `<plugin root>` need the installed `incubator-build` plugin directory. In Claude Code, use `${CLAUDE_PLUGIN_ROOT}`. In Codex, resolve it from the loaded skill path: the plugin root is two directories above this `SKILL.md`.

**Asking the user:** When this skill says "ask the user", use the platform's blocking question tool (`AskUserQuestion` in Claude Code, `request_user_input` in Codex, `ask_user` in Gemini). If unavailable, present the question and wait for a reply.

## Mode detection

If the user is asking to update, refresh, or rewrite an existing PR description (with no mention of committing or pushing), this is a **description-only update**. The user may also provide a focus (e.g., "refresh the description and mention the perf win"). Follow the Description Update workflow below. Otherwise, follow the Full workflow.

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

Use this workflow when the user wants to rewrite an existing PR description without committing or pushing new work.

### DU-1: Confirm intent

Ask: "Update the PR description for this branch?" If declined, stop.

### DU-2: Find the PR

Use the current branch and the existing-PR check from context. If the branch is empty (detached HEAD), report and stop. If the PR check returned `state: OPEN`, note the PR URL and `baseRefName`:

```bash
gh pr view --json url,baseRefName --jq '{url, baseRefName}'
```

Otherwise, report no open PR and stop.

### DU-3: Preserve existing evidence

Read the current PR body so any existing `## Demo` or `## Screenshots` block can be carried over verbatim. Evidence is sticky — never drop a previously captured reel or screenshot on a rewrite unless the user explicitly asks to refresh it:

```bash
gh pr view --json body --jq '.body'
```

Extract the `## Demo` and/or `## Screenshots` blocks (start of heading through the next `##`/`###` heading or end of body). Hold them for step DU-5.

### DU-4: Gather the real branch diff

The working-tree diff in context only reflects uncommitted changes. Compute the full PR diff against the PR's actual base:

```bash
git rev-parse --verify origin/<baseRefName> >/dev/null 2>&1 \
  || git fetch --no-tags origin <baseRefName>
git diff origin/<baseRefName>...HEAD
```

### DU-5: Run the inlined body writer

Run the writer from Step 11 ("Inlined body writer") using the branch diff from DU-4. For intent, use what the user provided in conversation when they asked to refresh the description (or re-ask if they didn't); skip the diff-vs-intent check — existing PRs have already been framed. Splice the preserved evidence blocks from DU-3 back into the body.

If the user's focus explicitly asks to refresh evidence, skip the splice and run Step 9 ("Evidence gate") from the full workflow instead.

### DU-6: Compare, confirm, apply

Summarize what the new body covers differently from the old one (based on the body in context, not by re-reading the temp file). Show the new title length and the first two sentences of `### Why?`. Ask to apply.

If confirmed, apply — `<TITLE>` and `<BODY_FILE>` come verbatim from the writer; escape `"`, `` ` ``, `$`, `\` in the title or switch to single quotes:

```bash
gh pr edit --title "<TITLE>" --body "$(cat "<BODY_FILE>")"
```

Report the PR URL. Do not run the CI/AI watch (Step 14) — body edits don't re-trigger reviewers.

---

## Full workflow

### Step 1: Gather context

Use the context above — all required data is already populated. Resolve the default branch: if the remote-default-branch block returned `origin/main` or similar, strip the `origin/` prefix. If it returned `DEFAULT_BRANCH_UNRESOLVED` or a bare `HEAD`, fall back in order:

```bash
gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'
```

If that also fails, default to `main`.

### Step 2: Branch identity gate

**Detached HEAD.** A branch is required. Ask whether to create a feature branch now. If yes, derive a name from the change content and run `git checkout -b <name>`. If no, stop.

**On the default branch.**

- Check upstream: `git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null`.
- If upstream exists, check for unpushed commits: `git log <upstream>..HEAD --oneline`.
- **Clean tree, all pushed, no open PR** → nothing to ship. Stop.
- **Unpushed commits or no upstream** → ask whether to create a feature branch. If yes, create and continue. If no, stop.

**On a feature branch.** Check the prior-PR state:

```bash
gh pr list --head "$(git branch --show-current)" --state all --limit 1 --json state,url
```

- **No open PR on this branch AND the most recent prior PR is `MERGED` or `CLOSED`** → **auto-create a new branch off `<default>`** derived from the change content:
  ```bash
  git fetch origin <default>
  git checkout -b <new-branch-name> origin/<default>
  ```
  Announce the switch in one sentence so the user can recover with `git checkout -` if they meant to reuse the branch. Do not ask first.
- **No open PR AND no prior PR** → stay on the current branch.
- **Open PR exists** → stay on the branch. Note the URL for the existing-PR sub-path in Step 12.

If the working tree is clean and there are unpushed commits on a feature branch, skip Step 4 and continue from Step 5.

### Step 3: Determine conventions

Priority for commit messages and PR titles:

1. **Repo conventions in context** — follow project instructions if they specify conventions. Do not re-read them; they load at session start.
2. **Recent commit history** — match the pattern in the last 10 commits.
3. **Default** — `type(scope): description` (conventional commits).

### Step 4: Stage and commit

1. Scan changed files for naturally distinct concerns. If files clearly group into separate logical changes, create separate commits (2-3 max). Group at the file level only (no `git add -p`). When ambiguous, one commit is fine.
2. Stage and commit each group in a single call. Avoid `git add -A` or `git add .`. Follow conventions from Step 3:
   ```bash
   git add file1 file2 file3 && git commit -m "$(cat <<'EOF'
   commit message here
   EOF
   )"
   ```

### Step 5: Branch freshness

Check how far the branch is behind the default branch. Pushing a stale branch opens a PR whose CI ran against an outdated base.

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<plugin root>}"
OUT=$(bash "$PLUGIN_ROOT/scripts/branch-freshness")
BEHIND=$(printf '%s\n' "$OUT" | sed -n 's/^BEHIND=//p')
```

If `BEHIND` ≥ **10**, ask the user whether to update the branch before pushing. If yes, invoke the `inc:update-code` skill via the `Skill` tool — the working tree is clean at this point so it can proceed without stashing. After it returns cleanly, continue. If it hands off to `git-merge-expert` for conflicts, let that finish first.

If the user declines or `BEHIND` < 10, continue.

### Step 5.5: Replay CI checks before push

Catches the class of bug where local code passes locally but CI gates the PR on something the agent forgot to run (most common: Drizzle schema drift — `*.sql.ts` edited, `pnpm db:generate` never run, CI's `db:validate` fails). The fix is to run whatever CI runs, locally, before push.

**Source of truth is `.github/workflows/*.yml`.** Do NOT hardcode script names (`db:validate`, `lint`, etc.). The replayer parses the workflow files, keeps only steps that gate PRs, skips slow behavioral checks (build/test/e2e — those stay CI's job), and emits one JSON line per replayable step.

**Discover steps:**

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<plugin root>}"
STEPS_JSON=$(python3 "$PLUGIN_ROOT/skills/inc-commit-push-pr/scripts/replay-ci-checks")
```

Each line of `STEPS_JSON` is a JSON object: `{"step": "...", "dir": "...", "env": {...}, "cmd": "...", "workflow": "...", "job": "..."}`. If the output is empty (no PR-gating workflow, no replayable steps), skip to Step 6.

**Diff-relevance filter.** Compute the changed-file set once: `git diff <base-remote>/<base-branch>...HEAD --name-only` (resolving base the same way the later push/description steps do — try PR metadata first, then remote default branch, then `main`/`master`). For each step, if no changed file falls under `step.dir`, skip that step. Means a frontend-only PR doesn't trigger the api job's `db:validate`. If the base ref can't be resolved (offline, no upstream), skip the filter and run all steps.

**Run each remaining step in order.** Use the `Bash` tool, one call per step, in this shape:

```bash
cd "<repo-root>/<step.dir>" && <env-assignments> <step.cmd>
```

Stream stdout/stderr through. On non-zero exit, stop and enter the self-heal loop below.

**Self-heal loop on failure.** Read the step's output:

- If it suggests a deterministic fix (most common signal: a line starting with `FIX:` or text matching `run [`']pnpm \S+[`']`/`run [`']npm run \S+[`']` near a failure), run that fix command in the same working directory, then `git add` any files it changed and create a new commit on the current branch (do NOT `--amend` — keep history honest about the drift-fix). Then re-run the failed step. If it now passes, continue to the next step.
- If the re-run fails again, or no fix is suggested, surface the step name + last ~30 lines of output to the user and ask whether to (a) abandon push and investigate, or (b) push anyway. Default to (a).

**Run all kept steps before pushing.** Once they all pass, continue to Step 6.

### Step 6: Push

The Step 2 branch-identity gate should already have moved you off the default branch. Re-assert it here as a final guard — pushing commits directly to `main`/`master` bypasses the PR and is unrecoverable once it lands:

```bash
CURRENT=$(git branch --show-current)
test -n "$CURRENT" && test "$CURRENT" != "<default>" || {
  echo "ABORT: refusing to push branch '$CURRENT' (detached or default branch) — re-run Step 2 to create a feature branch." >&2
  exit 1
}
git push -u origin HEAD
```

If the guard fires, return to Step 2 to create a feature branch; do not push.

### Step 7: Intent interview

**Blocking ask** (unless the user already stated intent clearly earlier in this session):

> Before I write the PR description: what problem does this solve, and why?
>
> (One or two sentences is fine. I won't fabricate intent.)

If the answer is thin ("idk, just update it", "do what you think"), re-ask once more for the actual problem. If the second answer is still missing real intent, stop and report that the description needs a user-provided reason. Do not proceed to writing.

Capture any trade-offs or concerns the user mentions in the same exchange — they feed the optional `### Decisions` / `### Risks` sections later.

### Step 8: Diff-vs-intent sanity check

Confirm the real diff matches what was discussed:

```bash
git diff <default>...HEAD --stat
```

If the touched files include anything that wasn't part of the session's discussion or the stated intent, warn:

> The diff includes files we didn't discuss:
> - `<file>`
>
> These may be leftover work. Proceed with all of them, split them into separate commits/PRs, or exclude them?

Wait for direction before continuing. Don't guess.

### Step 9: Evidence gate

Only when the branch diff changes **observable behavior** (UI, CLI output, API behavior with runnable code, generated artifacts, workflow output) and evidence isn't otherwise blocked (unavailable credentials, paid services, deploy-only infrastructure, hardware).

Compute the branch diff against the resolved default once (local ref first, only fetch if missing):

```bash
git rev-parse --verify origin/<default> >/dev/null 2>&1 \
  || git fetch --no-tags origin <default>
git diff origin/<default>...HEAD
```

Ask:

> Capture evidence for the PR description?
>
> 1. Screenshot(s)
> 2. Demo reel (GIF)
> 3. Skip

Invoke `demo-reel` with the chosen intent — screenshots map to Tier 4 (`Static Screenshots`), reels map to Tiers 1-3 (Browser / Terminal / Screenshot Reel). Pass a target description inferred from the branch diff. `demo-reel` returns `Tier`, `Description`, `URL`. Use the returned URL(s) in the body:

- Screenshots → `## Screenshots` section
- Reel → `## Demo` section
- `Tier: skipped` or `URL: "none"` → no evidence section

**Do not offer a "paste a URL" option.** Preview URLs already attach to the PR automatically via deploy bots; the evidence section is for captures the skill produced.

**Skip this gate without asking** for docs-only, markdown-only, changelog-only, release metadata, CI/config-only, test-only, or pure internal refactors.

### Step 10: Find the plan file

Plans referenced in this skill may live in user-global state, not in the repo. Claude Code stores them under `~/.claude/plans/`; Codex may not expose persistent plan files, so skip this section unless the current platform provides a concrete plan path.

1. **Scan the conversation** for a system message containing a path like `~/.claude/plans/<slug>.md` or another platform-specific plan path. When plan mode was used, that path is often injected. If found, read it with the `Read` tool.
2. **In Claude Code only**, otherwise run:
   ```bash
   ls -t ~/.claude/plans/*.md 2>/dev/null | head -5
   ```
   Read the first few lines of each to identify which matches the current work (title, context section). If nothing clearly matches, skip the plan section entirely.

Do **not** use Glob — it sorts alphabetically by filename, not by modification time.

If a plan file is found, paste its full markdown contents into the `<details>` block in the body (Step 11). Do **not** include the file path — plan files are gitignored and won't exist in the PR.

### Step 11: Inlined body writer

Produce `<TITLE>` and `<BODY_FILE>`:

```bash
BODY_FILE="$(mktemp -t pr-body).md"
```

**Title.** Conventional-commit format per Step 3's conventions. ≤ 72 characters. Describes the change, not the process.

**Body.** Use this template exactly. Sections marked **optional** are included only when the trigger condition is met; omit the entire heading if not:

```markdown
### Why?

<1-4 sentences from the Step 7 intent interview, formatted for scannability.
 **Bold 2-4 key nouns or verbs** that name what's being solved or who benefits.
 If the user surfaced 3+ distinct motivations, prefer a short bulleted list
 (one bullet per motivation, one line each) over a paragraph. Never fabricated.>

### How?

<1-3 sentences (or a short bulleted list) on the high-level approach.
 **Bold the key technique, library, or pattern** so it stands out at a glance.
 Bullets are encouraged when the approach has distinct steps or components.
 No file lists. No code narration. No commit-by-commit recap.>

### Decisions    <!-- optional: only if the user surfaced a trade-off during the session -->

- <decision>: <one-line rationale>

### Risks    <!-- optional: only if the user explicitly named a concern -->

- <risk>

## Demo    <!-- optional: only if Step 9 captured a reel -->

<demo-reel URL>

## Screenshots    <!-- optional: only if Step 9 captured screenshots -->

<demo-reel URL(s)>

<details>
<summary>Implementation Plan</summary>

<full markdown contents of the plan file from Step 10 — omit this entire <details> block if no plan was found>

</details>

<sub>Generated with Incubator Build</sub>
```

**Core principle for the writer.** The diff is already visible on GitHub. The description exists to explain what the diff *cannot* show — intent, trade-offs, context, what was rejected and why, what a reviewer would otherwise have to ask. Cut any sentence a reader could reconstruct from the diff. Every hard rule below is a consequence of this principle, not an independent constraint; if a rule and the principle ever disagree, the principle wins.

**Hard rules for the writer. Do not rationalize around these:**

- **Never fabricate intent.** If Step 7's answer is thin, the skill already stopped. If you got here, you have a real answer — use it verbatim or lightly cleaned up. Do not invent motivation.
- **Never list files changed.** GitHub already shows this in the diff view.
- **Never narrate code changes.** No "updated the foo handler to bar". The diff is the implementation.
- **Never speculate on risks.** Only include `### Risks` if the user named specific concerns during Step 7.
- **Never include a `## Test plan` section.** Deliberately dropped. Testing lives in QA process, not in the PR body.
- **Never bullet commits.** Bullets describe distinct motivations or approach components, not "commit 1 did X, commit 2 did Y". The diff already shows that.
- **Prefer scannable formatting.** Bold 2-4 keywords in Why and How — the load-bearing nouns/verbs a reviewer should catch on a skim. Use bullets when the content is genuinely list-shaped (multiple distinct motivations or steps); use prose when it's a single coherent thought. Don't bold every other word.
- **Reference issues/PRs as bullets.** Use `- #123` or `- https://github.com/owner/repo/issues/123` so GitHub renders them as linked cards.
- **Avoid accidental issue links.** `#42` in prose auto-links to issue 42. Only use `#NUMBER` for intentional references; rephrase ("top cause", "third priority") otherwise. If a literal `#NUMBER` is unavoidable, escape it: `\#42`.

Write the finished body to `$BODY_FILE`. Pass `<TITLE>` and `$BODY_FILE` forward to Step 12.

### Step 12: Create or update the PR

**New PR (no existing PR from Step 2).** Substitute `<TITLE>` and `<BODY_FILE>` verbatim. If `<TITLE>` contains `"`, `` ` ``, `$`, or `\`, escape them or switch to single quotes:

```bash
gh pr create --base "<default>" --title "<TITLE>" --body "$(cat "<BODY_FILE>")"
```

**Existing PR (open PR found in Step 2).** New commits make the existing description stale by default — the title and "why" almost certainly no longer cover what was just pushed. **Default action is to rewrite the description**, not to leave it as-is. Treat "leave it as-is" as an explicit opt-out, not the default.

Run the writer (Step 11) against the existing PR's `baseRefName`, preserve any existing `## Demo`/`## Screenshots` blocks per DU-3, then offer:

> Pushed `<N>` new commit(s) to PR #`<n>` (`<url>`). The current description is from before these changes — refreshing it. Preview:
>
> **Title:** `<new title>`
> **Why (first two sentences):** `<…>`
>
> Apply this rewrite, or keep the existing description as-is?

- **Apply** (default) → write with `gh pr edit --title "<TITLE>" --body "$(cat "<BODY_FILE>")"`.
- **Keep as-is** (explicit opt-out only) → skip the edit. Note in the report that the description is stale relative to the new commits.

Skip the rewrite **only** in these cases:
- The user already said in conversation "don't touch the description" / "leave the body alone".
- Step 6 pushed zero new commits (nothing changed since the last description).

### Step 13: Report

Print the PR URL.

**Next.** Step 14 now owns the post-open loop: it watches CI + AI reviewers and, once they're done, **auto-resolves feedback** without stopping for you (only `needs-human` items pause it). When the loop ends with a feedback-clean PR, run `/inc:merge-pr-5` to ship — or use `/inc:ship-it` to chain merge on automatically from the start.

### Step 14: Watch CI + AI reviews, then auto-resolve feedback

Run this step whenever **new commits were pushed** in Step 6 — that includes both newly-created PRs and existing PRs that just received commits. New commits re-trigger CI and may prompt AI reviewers to re-review.

This step does two things as one loop: (1) **watch** CI + AI reviewers via the background watcher, then (2) once they finish, **auto-resolve** the feedback by invoking `inc:resolve-pr-feedback` in unattended mode — fix → commit → push → reply → resolve, no confirmation pause. The only thing that stops the loop is a `needs-human` item (a finding the resolver can't confidently action) or a CI failure. This is on by default.

Skip this step **only** when:
- No new commits were pushed (e.g., the Description Update workflow took only a body edit and no `git push` ran).
- The user opted out in conversation — e.g. "don't watch this one", "just open the PR", "just PR", "don't auto-resolve". In that case print the PR and stop; the user drives `/inc:resolve-pr-feedback` and `/inc:merge-pr-5` themselves.

**Announce and start. Do not ask.** After Step 13, emit one sentence like *"Watching CI and AI reviews on PR #N in the background — I'll notify you on failures or when a reviewer weighs in."* Then launch the watcher via the `Monitor` tool with `run_in_background: true`, `timeout_ms: 3600000`, `persistent: false`.

> ⚠️ **MUST use the `Monitor` tool. NEVER use `Bash` with `run_in_background: true` for this watch.**
>
> `Bash run_in_background` only notifies the agent when the process *completes* — it does not stream stdout lines as they arrive. The watcher emits one event per line over up to an hour, so launching it via Bash means every `CI_FAIL`, `AI_REVIEW`, `PREVIEW_FAIL` sits in a buffer until the process exits. Real ship-it runs have hit this (PR #59, 2026-05): CI failed, no notification, chain silently stalled. `Monitor` streams each stdout line as a notification — that is the only correct surface here.

The watch delegates to [scripts/watch-pr-activity](scripts/watch-pr-activity), which emits one stdout line per state transition:

```bash
PR=<pr-number>
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<plugin root>}"
bash "$PLUGIN_ROOT/skills/inc-commit-push-pr/scripts/watch-pr-activity" "$PR" 3600
```

**Event vocabulary.** Each line is one of:

| Event | Fired when | Push-notify? | Follow-up to offer |
|---|---|---|---|
| `CI_FAIL: <check-name>` | A check transitioned pending → `fail` or `cancel` (one line per newly-failing check). Excludes preview-deploy checks — see `PREVIEW_FAIL` | yes | Stop the loop, surface verbatim; `gh run view --log-failed` for raw logs. CI failures are out of scope for auto-resolve |
| `CI_GREEN` | At least one check exists, none are `pending`, none are `fail`/`cancel` (emitted once per watch) | yes | — |
| `CI_NONE` | First post-initial-wait poll observed zero checks — this repo has no CI configured. Emitted once per watch and satisfies early-stop the same way `CI_GREEN` does (so the watcher won't sit waiting for a signal that will never arrive) | yes | — |
| `AI_REVIEW: <bot-login>` | First comment or review from a known AI reviewer, once per bot per watch. First-contact signal — comments may still be trickling | yes | — wait for `AI_REVIEW_DONE` before triaging |
| `AI_REVIEW_DONE: <bot-login>` | A known AI reviewer **submitted** a review (state `COMMENTED`/`CHANGES_REQUESTED`/`APPROVED`/`DISMISSED`), once per bot per watch. Submission is atomic, so all of that reviewer's inline comments are now attached — this is the green light for resolution | yes | Triggers the auto-resolve pass (see "Drive the loop" below) once CI is green and every announced reviewer is done |
| `PREVIEW_READY[: <projects>]` | A preview-deploy bot comment body matched a "ready" keyword this tick. Monorepo project names are attached when parseable from a Vercel-style sticky table; bare `PREVIEW_READY` otherwise | **no** — informational, stream only | — |
| `PREVIEW_FAIL[: <check-name\|projects>]` | A preview-deploy bot's status check entered `fail`/`cancel` (one line per check, name attached) **OR** a preview-deploy bot comment body matched a "failed" keyword this tick (project names attached when parseable, bare otherwise) | yes | — |
| `PREVIEW_SKIPPED[: <projects>]` | A preview-deploy bot comment body indicated one or more projects were skipped (e.g. monorepo path-based filter — a no-op success, emitted once per watch). Project names attached when parseable | **no** — informational, stream only | — |
| `MODE_FLIP: <new-mode>` | Watcher switched API mode (graphql ↔ rest) after detecting the active mode's quota was exhausted. Emitted at the moment of the switch | **no** — informational, stream only | — |
| `WATCH_QUIET pr=<n>` | `CI_GREEN` or `CI_NONE` has been emitted and two consecutive ticks (at the active tier, not gated on the 600s slow tier) passed with no new events. Watcher exits clean. This is a "watcher can stop" signal, **not** a prerequisite for resolution — resolution keys off `AI_REVIEW_DONE` | yes | — |
| `WATCH_TIMEOUT pr=<n>` | Loop hit its timeout cap (default 1h) without going quiet | yes | — |

**AI reviewer allowlist** (case-insensitive substring on `login`): `greptile`, `coderabbit`, `devin`, `copilot`, `codex`, `sourcery`, `cursor`. **Preview deploy bot allowlist** (provider-agnostic): `vercel`, `netlify`, `cloudflare`, `railway`, `render`, `google-cloud`, `fly`, `aws-amplify`. The preview-deploy allowlist is also matched (case-insensitive substring) against status-check names to distinguish `PREVIEW_FAIL` from `CI_FAIL`.

**Drive the loop — auto-resolve once reviews are in.** The watcher streams events; act on them as follows:

- **Proceed to resolve when** `CI_GREEN` (or `CI_NONE`) has fired **and** every announced `AI_REVIEW: <bot>` has its matching `AI_REVIEW_DONE: <bot>`. Submission is atomic, so all inline comments are attached — do **not** wait for `WATCH_QUIET` (that only signals the watcher can stop). Fallbacks: if `CI_GREEN` fired but no `AI_REVIEW` ever did, proceed at `WATCH_QUIET` or 3 min after `CI_GREEN`, whichever is first; if an `AI_REVIEW` never gets its `AI_REVIEW_DONE`, fall back to `WATCH_QUIET` or 5 min of no new events.
- **Auto-resolve, unattended.** Invoke `inc:resolve-pr-feedback` via the `Skill` tool with the `--auto` argument (e.g. `Skill: inc:resolve-pr-feedback` with arg `--auto`). In this mode it fixes → commits → pushes → replies → resolves every item its resolver agents can confidently handle, with **no confirmation pause**. It leaves only `needs-human` items open and returns them.
- **Loop.** If the resolve pass pushed new commits, those re-trigger CI and may prompt re-review — re-arm the watcher (same Monitor call) and repeat: wait for green + reviewers, run `--auto` resolve again on any new feedback. Continue until a resolve pass makes no changes and no new feedback remains.
- **Stop the loop and surface (do not auto-invoke anything further) when:**
  - a resolve pass returns `needs-human` items — present them (the resolver already posted holding replies and left the threads open) and stop; the user decides, then re-runs resolve or merge,
  - `CI_FAIL` fires — surface the failing checks verbatim and stop; CI failures are out of scope here,
  - `PREVIEW_FAIL` fires (not `PREVIEW_SKIPPED`) — surface and ask (blocking question) whether to continue, since preview failures are sometimes ignorable,
  - `WATCH_TIMEOUT` fires before `CI_GREEN` — surface and ask whether to re-arm or stop.
- **When the loop ends clean** (CI green, threads resolved except any `needs-human`), print the PR as ready and point to `/inc:merge-pr-5`. Send a `PushNotification` at each stop/finish so the user knows the background loop wants attention.

Human reviewer events are intentionally not watched here; those arrive async and aren't a post-open concern. To carry on through merge + deploy automatically, `/inc:ship-it` chains merge on after this loop.

**Render `PREVIEW_*` names verbatim.** When a `PREVIEW_*` event carries a `: <projects>` suffix, include the project names exactly as emitted in the rendered "Noted:" message (e.g. *"Noted: PREVIEW_SKIPPED for **api, worker** — monorepo path filter skipped these projects. Informational, watcher still running."*) so the user can tell which app the signal is about. A bare event (no suffix) means the bot's comment wasn't in a parseable format — render generically as before.

**Silence-is-not-success.** The script emits on failure transitions (`CI_FAIL`, `PREVIEW_FAIL`), not just happy paths — a silent watch that hides a broken build is worse than a noisy one.

**Strategic polling.** The watcher waits **6 minutes** before the first poll (CI and AI reviewers rarely have useful signal that early — polls in the first few minutes just waste quota on "still pending" responses), then polls every **3 minutes for 6 minutes** (active window), then every **5 minutes for 10 minutes** (steady tail), then **exponential backoff** (10 → 20 → 40 min) until the deadline. Once `CI_GREEN` or `CI_NONE` has fired and **two consecutive ticks at the current tier** pass with zero new events, it exits clean with `WATCH_QUIET` — no longer gated on the 600s slow tier, which used to impose a ~22-minute floor even when CI greened at minute 5. Worst case over an hour: ~12 polls, down from ~240 in the old fixed-60s scheme.

**Dual-mode API budget.** The watcher picks REST or GraphQL at startup based on which has more headroom via the free `gh api rate_limit` call, and emits `MODE_FLIP: <mode>` mid-watch if the active mode's quota gets exhausted. The other budget stays untouched, so a watch never bricks other skills (`inc:resolve-pr-feedback`'s review-thread fetch, `inc:merge-pr-5` Gate 2c) regardless of which budget gets hit.

This watch only survives the current Claude session. If the user closes the terminal, the background bash dies; that is acceptable for a same-session "ship then wait" flow. Cross-session watching is out of scope here.

---

## Anti-patterns

| Don't | Why |
|---|---|
| Fabricate intent | The user didn't explain why → ask, don't invent |
| List files changed | GitHub already shows this in the diff view |
| Speculate on risks | Only include `### Risks` if the user raised specific concerns |
| Narrate code changes | The diff is the implementation; prose narration is noise |
| Add a `## Test plan` section | Deliberately dropped from this skill — testing lives in QA |
| Describe the conversation, not the diff | The PR must reflect the actual changes, not just what was discussed |
| Paste a preview URL as "evidence" | Deploy bots already attach preview URLs to the PR; the evidence section is for captures this skill produced |
| Use `#NUMBER` in prose | `#42` auto-links on GitHub — rephrase unless it's an intentional issue/PR reference |
| Reuse a branch whose prior PR merged | Step 2 already switched you off; don't switch back without the user asking |
