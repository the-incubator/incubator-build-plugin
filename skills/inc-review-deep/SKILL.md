---
name: inc:review-deep-3b
description: "Structured code review using tiered persona agents, confidence-gated findings, and a merge/dedup pipeline. Use when reviewing code changes before creating a PR."
argument-hint: "[blank to review current branch, or provide PR link]"
---

# Code Review

Reviews code changes using dynamically selected reviewer personas. Spawns parallel sub-agents that return structured JSON, then merges and deduplicates findings into a single report.

## When to Use

- Before creating a PR
- After completing a task during iterative implementation
- When feedback is needed on any code changes
- Can be invoked standalone
- Can run as a read-only or autofix review step inside larger workflows

## Argument Parsing

Parse `$ARGUMENTS` for the following optional tokens. Strip each recognized token before interpreting the remainder as the PR number, GitHub URL, or branch name.

| Token | Example | Effect |
|-------|---------|--------|
| `mode:autofix` | `mode:autofix` | Select autofix mode (see Mode Detection below) |
| `mode:report-only` | `mode:report-only` | Select report-only mode |
| `mode:headless` | `mode:headless` | Select headless mode for programmatic callers (see Mode Detection below) |
| `base:<sha-or-ref>` | `base:abc1234` or `base:origin/main` | Skip scope detection — use this as the diff base directly |
| `plan:<path>` | `plan:docs/plans/2026-03-25-001-feat-foo-plan.md` | Load this plan for requirements verification |

All tokens are optional. Each one present means one less thing to infer. When absent, fall back to existing behavior for that stage.

**Conflicting mode flags:** If multiple mode tokens appear in arguments, stop and do not dispatch agents. If `mode:headless` is one of the conflicting tokens, emit the headless error envelope: `Review failed (headless mode). Reason: conflicting mode flags — <mode_a> and <mode_b> cannot be combined.` Otherwise emit the generic form: `Review failed. Reason: conflicting mode flags — <mode_a> and <mode_b> cannot be combined.`

## Mode Detection

| Mode | When | Behavior |
|------|------|----------|
| **Interactive** (default) | No mode token present | Review, apply auto_apply fixes automatically, present the report (auto-applied fixes, then informational context, with the `ask_user` findings for your review placed just above the verdict), then stop. No routing question, no walk-through, no ticket-filing |
| **Autofix** | `mode:autofix` in arguments | No user interaction. Review, apply only policy-allowed `auto_apply` fixes, re-review in bounded rounds, write a run artifact, and emit residual downstream work when needed |
| **Report-only** | `mode:report-only` in arguments | Strictly read-only. Review and report only, then stop with no edits, artifacts, todos, commits, pushes, or PR actions |
| **Headless** | `mode:headless` in arguments | Programmatic mode for skill-to-skill invocation. Apply `auto_apply` fixes silently (single pass), return all other findings as structured text output, write run artifacts, skip todos, and return "Review complete" signal. No interactive prompts. |

### Autofix mode rules

- **Skip all user questions.** Never pause for approval or clarification once scope has been established.
- **Apply only `auto_apply -> review-fixer` findings.** Leave `ask_user` and informational (`human` / `release`) work unresolved.
- **Write a run artifact** under `.context/incubator/inc-review/<run-id>/` summarizing findings, applied fixes, residual actionable work, and fyi outputs.
- **Create durable todo files only for unresolved actionable findings** whose final owner is `human`.
- **Never commit, push, or create a PR** from autofix mode. Parent workflows own those decisions.

### Report-only mode rules

- **Skip all user questions.** Infer intent conservatively if the diff metadata is thin.
- **Never edit files or externalize work.** Do not write `.context/incubator/inc-review/<run-id>/`, do not create todo files, and do not commit, push, or create a PR.
- **Safe for parallel read-only verification.** `mode:report-only` is the only mode that is safe to run concurrently with browser testing on the same checkout.
- **Do not switch the shared checkout.** If the caller passes an explicit PR or branch target, `mode:report-only` must run in an isolated checkout/worktree or stop instead of running `gh pr checkout` / `git checkout`.
- **Do not overlap mutating review with browser testing on the same checkout.** If a future orchestrator wants fixes, run the mutating review phase after browser testing or in an isolated checkout/worktree.

### Headless mode rules

- **Skip all user questions.** Never use the platform question tool (`AskUserQuestion` in Claude Code, `request_user_input` in Codex, `ask_user` in Gemini) or other interactive prompts. Infer intent conservatively if the diff metadata is thin.
- **Require a determinable diff scope.** If headless mode cannot determine a diff scope (no branch, PR, or `base:` ref determinable without user interaction), emit `Review failed (headless mode). Reason: no diff scope detected. Re-invoke with a branch name, PR number, or base:<ref>.` and stop without dispatching agents.
- **Apply only `auto_apply -> review-fixer` findings in a single pass.** No bounded re-review rounds. Leave `ask_user` and informational (`human` / `release`) work unresolved and return them in the structured output.
- **Return all non-auto findings as structured text output.** Use the headless output envelope format (see Stage 6 below) preserving severity, autofix_class, owner, requires_verification, confidence, pre_existing, and suggested_fix per finding. Enrich with detail-tier fields (why_it_matters, evidence[]) from the per-agent artifact files on disk (see Detail enrichment in Stage 6).
- **Write a run artifact** under `.context/incubator/inc-review/<run-id>/` summarizing findings, applied fixes, and fyi outputs. Include the artifact path in the structured output.
- **Do not create todo files.** The caller receives structured findings and routes downstream work itself.
- **Do not switch the shared checkout.** If the caller passes an explicit PR or branch target, `mode:headless` must run in an isolated checkout/worktree or stop instead of running `gh pr checkout` / `git checkout`. When stopping, emit `Review failed (headless mode). Reason: cannot switch shared checkout. Re-invoke with base:<ref> to review the current checkout, or run from an isolated worktree.`
- **Not safe for concurrent use on a shared checkout.** Unlike `mode:report-only`, headless mutates files (applies `auto_apply` fixes). Callers must not run headless concurrently with other mutating operations on the same checkout.
- **Never commit, push, or create a PR** from headless mode. The caller owns those decisions.
- **End with "Review complete" as the terminal signal** so callers can detect completion. If all reviewers fail or time out, emit `Code review degraded (headless mode). Reason: 0 of N reviewers returned results.` followed by "Review complete".

### Interactive mode rules

- **No blocking questions, ever.** Interactive mode never uses `AskUserQuestion` / `request_user_input` / `ask_user` or any other blocking prompt. It applies `auto_apply` fixes, presents the report (auto-applied fixes, then informational, with the `ask_user` findings for the user to act on placed just above the verdict), and stops. There is no routing question, no per-finding walk-through, and no ticket-filing. The report *is* the interaction.
- **Infer, don't ask.** When intent, scope, or plan is ambiguous, infer conservatively from explicit tokens, git state, PR metadata, and conversation, and note the uncertainty in Coverage or the verdict — never stop to ask.

## Severity Scale

All reviewers use P0-P3:

| Level | Meaning | Action |
|-------|---------|--------|
| **P0** | Critical breakage, exploitable vulnerability, data loss/corruption | Must fix before merge |
| **P1** | High-impact defect likely hit in normal usage, breaking contract | Should fix |
| **P2** | Moderate issue with meaningful downside (edge case, perf regression, maintainability trap) | Fix if straightforward |
| **P3** | Low-impact, narrow scope, minor improvement | User's discretion |

## Action Routing

Severity answers **urgency**. Routing answers **who acts next**. There are exactly three buckets:

| `autofix_class` | Default owner | Meaning |
|-----------------|---------------|---------|
| `auto_apply` | `review-fixer` | Local, deterministic fix safe to apply automatically — correctness, error handling, security, performance, mechanical code quality, with no question about the author's intent. Applied (in mutating modes) and reported. |
| `ask_user` | `human` | A concrete issue the user should review: it changes behavior, contracts, permissions, product decisions, or otherwise touches the author's deliberate intent. Presented in "Needs your call" and left for the user — never auto-applied. Use this for anything that previously would have been "needs input" *or* "defer". |
| `fyi` | `human` or `release` | Informational only — learnings, rollout notes, residual risk, acknowledged tradeoffs. No action required. |

Routing rules:

- **Synthesis owns the final route.** Persona-provided routing metadata is input, not the last word.
- **Choose the more conservative route on disagreement.** A merged finding may move from `auto_apply` to `ask_user`, but never the other way without stronger evidence.
- **Only `auto_apply -> review-fixer` enters the in-skill fixer queue automatically.** `ask_user` is presented, never auto-applied; `fyi` is informational.
- **`requires_verification: true` means a fix is not complete without targeted tests, a focused re-review, or operational validation.**

## Reviewers

17 reviewer personas in layered conditionals, plus CE-specific agents. See the persona catalog included below for the full catalog.

**Always-on (every review):**

| Agent | Focus |
|-------|-------|
| `review:inc-correctness-reviewer` | Logic errors, edge cases, state bugs, error propagation |
| `review:inc-testing-reviewer` | Coverage gaps, weak assertions, brittle tests |
| `review:inc-maintainability-reviewer` | Coupling, complexity, naming, dead code, abstraction debt |
| `review:inc-project-standards-reviewer` | CLAUDE.md and AGENTS.md compliance -- frontmatter, references, naming, portability |
| `review:inc-agent-native-reviewer` | Verify new features are agent-accessible |
| `research:inc-learnings-researcher` | Search docs/solutions/ for past issues related to this PR |

**Cross-cutting conditional (selected per diff):**

| Agent | Select when diff touches... |
|-------|---------------------------|
| `review:inc-security-reviewer` | Auth, public endpoints, user input, permissions |
| `review:inc-performance-reviewer` | DB queries, data transforms, caching, async |
| `review:inc-api-contract-reviewer` | Routes, serializers, type signatures, versioning |
| `review:inc-data-migrations-reviewer` | Migrations, schema changes, backfills |
| `review:inc-reliability-reviewer` | Error handling, retries, timeouts, background jobs |
| `review:inc-adversarial-reviewer` | Diff >=50 changed non-test/non-generated/non-lockfile lines, or auth, payments, data mutations, external APIs |
| `review:inc-cli-readiness-reviewer` | CLI command definitions, argument parsing, CLI framework usage, command handler implementations |
| `review:inc-previous-comments-reviewer` | Reviewing a PR that has existing review comments or threads |

**Stack-specific conditional (selected per diff):**

| Agent | Select when diff touches... |
|-------|---------------------------|
| `review:inc-dhh-rails-reviewer` | Rails architecture, service objects, session/auth choices, or Hotwire-vs-SPA boundaries |
| `review:inc-kieran-rails-reviewer` | Rails application code where conventions, naming, and maintainability are in play |
| `review:inc-kieran-python-reviewer` | Python modules, endpoints, scripts, or services |
| `review:inc-kieran-typescript-reviewer` | TypeScript components, services, hooks, utilities, or shared types |
| `review:inc-julik-frontend-races-reviewer` | Stimulus/Turbo controllers, DOM events, timers, animations, or async UI flows |

**CE conditional (migration-specific):**

| Agent | Select when diff includes migration files |
|-------|------------------------------------------|
| `review:inc-schema-drift-detector` | Cross-references schema.rb against included migrations |
| `review:inc-deployment-verification-agent` | Produces deployment checklist with SQL verification queries |

## Review Scope

Every review spawns all 4 always-on personas plus the 2 CE always-on agents, then adds whichever cross-cutting and stack-specific conditionals fit the diff. The model naturally right-sizes: a small config change triggers 0 conditionals = 6 reviewers. A Rails auth feature might trigger security + reliability + kieran-rails + dhh-rails = 10 reviewers.

## Protected Artifacts

The following paths are intentional living documents and must never be flagged for deletion, removal, or gitignore by any reviewer:

- `docs/brainstorms/*` -- requirements documents
- `docs/plans/*.md` -- plan files (living documents with progress checkboxes)
- `docs/solutions/*.md` -- solution documents

If a reviewer flags any file in these directories for cleanup or removal, discard that finding during synthesis.

## How to Run

### Stage 1: Determine scope

Compute the diff range, file list, and diff. Minimize permission prompts by combining into as few commands as possible.

**If `base:` argument is provided (fast path):**

The caller already knows the diff base. Skip all base-branch detection, remote resolution, and merge-base computation. Use the provided value directly:

```
BASE_ARG="{base_arg}"
BASE=$(git merge-base HEAD "$BASE_ARG" 2>/dev/null) || BASE="$BASE_ARG"
```

Then produce the same output as the other paths:

```
echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard
```

This path works with any ref — a SHA, `origin/main`, a branch name. Automated callers (ce-work, lfg, slfg) should prefer this to avoid the detection overhead. **Do not combine `base:` with a PR number or branch target.** If both are present, stop with an error: "Cannot use `base:` with a PR number or branch target — `base:` implies the current checkout is already the correct branch. Pass `base:` alone, or pass the target alone and let scope detection resolve the base." This avoids scope/intent mismatches where the diff base comes from one source but the code and metadata come from another.

**If a PR number or GitHub URL is provided as an argument:**

If `mode:report-only` or `mode:headless` is active, do **not** run `gh pr checkout <number-or-url>` on the shared checkout. For `mode:report-only`, tell the caller: "mode:report-only cannot switch the shared checkout to review a PR target. Run it from an isolated worktree/checkout for that PR, or run report-only with no target argument on the already checked out branch." For `mode:headless`, emit `Review failed (headless mode). Reason: cannot switch shared checkout. Re-invoke with base:<ref> to review the current checkout, or run from an isolated worktree.` Stop here unless the review is already running in an isolated checkout.

First, verify the worktree is clean before switching branches:

```
git status --porcelain
```

If the output is non-empty, inform the user: "You have uncommitted changes on the current branch. Stash or commit them before reviewing a PR, or use standalone mode (no argument) to review the current branch as-is." Do not proceed with checkout until the worktree is clean.

Then check out the PR branch so persona agents can read the actual code (not the current checkout):

```
gh pr checkout <number-or-url>
```

Then fetch PR metadata. Capture the base branch name and the PR base repository identity, not just the branch name:

```
gh pr view <number-or-url> --json title,body,baseRefName,headRefName,url
```

Use the repository portion of the returned PR URL as `<base-repo>` (for example, `owner/repo` from `https://github.com/owner/repo/pull/123`).

Then compute a local diff against the PR's base branch so re-reviews also include local fix commits and uncommitted edits. Substitute the PR base branch from metadata (shown here as `<base>`) and the PR base repository identity derived from the PR URL (shown here as `<base-repo>`). Resolve the base ref from the PR's actual base repository, not by assuming `origin` points at that repo:

```
PR_BASE_REMOTE=$(git remote -v | awk 'index($2, "github.com:<base-repo>") || index($2, "github.com/<base-repo>") {print $1; exit}')
if [ -n "$PR_BASE_REMOTE" ]; then PR_BASE_REMOTE_REF="$PR_BASE_REMOTE/<base>"; else PR_BASE_REMOTE_REF=""; fi
PR_BASE_REF=$(git rev-parse --verify "$PR_BASE_REMOTE_REF" 2>/dev/null || git rev-parse --verify <base> 2>/dev/null || true)
if [ -z "$PR_BASE_REF" ]; then
  if [ -n "$PR_BASE_REMOTE_REF" ]; then
    git fetch --no-tags "$PR_BASE_REMOTE" <base>:refs/remotes/"$PR_BASE_REMOTE"/<base> 2>/dev/null || git fetch --no-tags "$PR_BASE_REMOTE" <base> 2>/dev/null || true
    PR_BASE_REF=$(git rev-parse --verify "$PR_BASE_REMOTE_REF" 2>/dev/null || git rev-parse --verify <base> 2>/dev/null || true)
  else
    if git fetch --no-tags https://github.com/<base-repo>.git <base> 2>/dev/null; then
      PR_BASE_REF=$(git rev-parse --verify FETCH_HEAD 2>/dev/null || true)
    fi
    if [ -z "$PR_BASE_REF" ]; then PR_BASE_REF=$(git rev-parse --verify <base> 2>/dev/null || true); fi
  fi
fi
if [ -n "$PR_BASE_REF" ]; then BASE=$(git merge-base HEAD "$PR_BASE_REF" 2>/dev/null) || BASE=""; else BASE=""; fi
```

```
if [ -n "$BASE" ]; then echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard; else echo "ERROR: Unable to resolve PR base branch <base> locally. Fetch the base branch and rerun so the review scope stays aligned with the PR."; fi
```

Extract PR title/body, base branch, and PR URL from `gh pr view`, then extract the base marker, file list, diff content, and `UNTRACKED:` list from the local command. Do not use `gh pr diff` as the review scope after checkout -- it only reflects the remote PR state and will miss local fix commits until they are pushed. If the base ref still cannot be resolved from the PR's actual base repository after the fetch attempt, stop instead of falling back to `git diff HEAD`; a PR review without the PR base branch is incomplete.

**If a branch name is provided as an argument:**

Check out the named branch, then diff it against the base branch. Substitute the provided branch name (shown here as `<branch>`).

If `mode:report-only` or `mode:headless` is active, do **not** run `git checkout <branch>` on the shared checkout. For `mode:report-only`, tell the caller: "mode:report-only cannot switch the shared checkout to review another branch. Run it from an isolated worktree/checkout for `<branch>`, or run report-only on the current checkout with no target argument." For `mode:headless`, emit `Review failed (headless mode). Reason: cannot switch shared checkout. Re-invoke with base:<ref> to review the current checkout, or run from an isolated worktree.` Stop here unless the review is already running in an isolated checkout.

First, verify the worktree is clean before switching branches:

```
git status --porcelain
```

If the output is non-empty, inform the user: "You have uncommitted changes on the current branch. Stash or commit them before reviewing another branch, or provide a PR number instead." Do not proceed with checkout until the worktree is clean.

```
git checkout <branch>
```

Then detect the review base branch and compute the merge-base. Run the `references/resolve-base.sh` script, which handles fork-safe remote resolution with multi-fallback detection (PR metadata -> `origin/HEAD` -> `gh repo view` -> common branch names):

```
RESOLVE_OUT=$(bash references/resolve-base.sh) || { echo "ERROR: resolve-base.sh failed"; exit 1; }
if [ -z "$RESOLVE_OUT" ] || echo "$RESOLVE_OUT" | grep -q '^ERROR:'; then echo "${RESOLVE_OUT:-ERROR: resolve-base.sh produced no output}"; exit 1; fi
BASE=$(echo "$RESOLVE_OUT" | sed 's/^BASE://')
```

If the script outputs an error, stop instead of falling back to `git diff HEAD`; a branch review without the base branch would only show uncommitted changes and silently miss all committed work.

On success, produce the diff:

```
echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard
```

You may still fetch additional PR metadata with `gh pr view` for title, body, and linked issues, but do not fail if no PR exists.

**If no argument (standalone on current branch):**

Detect the review base branch and compute the merge-base using the same `references/resolve-base.sh` script as branch mode:

```
RESOLVE_OUT=$(bash references/resolve-base.sh) || { echo "ERROR: resolve-base.sh failed"; exit 1; }
if [ -z "$RESOLVE_OUT" ] || echo "$RESOLVE_OUT" | grep -q '^ERROR:'; then echo "${RESOLVE_OUT:-ERROR: resolve-base.sh produced no output}"; exit 1; fi
BASE=$(echo "$RESOLVE_OUT" | sed 's/^BASE://')
```

If the script outputs an error, stop instead of falling back to `git diff HEAD`; a standalone review without the base branch would only show uncommitted changes and silently miss all committed work on the branch.

On success, produce the diff:

```
echo "BASE:$BASE" && echo "FILES:" && git diff --name-only $BASE && echo "DIFF:" && git diff -U10 $BASE && echo "UNTRACKED:" && git ls-files --others --exclude-standard
```

Using `git diff $BASE` (without `..HEAD`) diffs the merge-base against the working tree, which includes committed, staged, and unstaged changes together.

**Untracked file handling:** Always inspect the `UNTRACKED:` list, even when `FILES:`/`DIFF:` are non-empty. Untracked files are outside review scope until staged. If the list is non-empty, tell the user which files are excluded. If any of them should be reviewed, stop and tell the user to `git add` them first and rerun. Only continue when the user is intentionally reviewing tracked changes only. In `mode:headless` or `mode:autofix`, do not stop to ask — proceed with tracked changes only and note the excluded untracked files in the Coverage section of the output.

### Stage 2: Intent discovery

Understand what the change is trying to accomplish. The source of intent depends on which Stage 1 path was taken:

**PR/URL mode:** Use the PR title, body, and linked issues from `gh pr view` metadata. Supplement with commit messages from the PR if the body is sparse.

**Branch mode:** Run `git log --oneline ${BASE}..<branch>` using the resolved merge-base from Stage 1.

**Standalone (current branch):** Run:

```
echo "BRANCH:" && git rev-parse --abbrev-ref HEAD && echo "COMMITS:" && git log --oneline ${BASE}..HEAD
```

Combined with conversation context (plan section summary, PR description), write a 2-3 line intent summary:

```
Intent: Simplify tax calculation by replacing the multi-tier rate lookup
with a flat-rate computation. Must not regress edge cases in tax-exempt handling.
```

Pass this to every reviewer in their spawn prompt. Intent shapes *how hard each reviewer looks*, not which reviewers are selected.

**When intent is ambiguous:** In every mode, infer intent conservatively from the branch name, commits, diff, PR metadata, `plan:`, and conversation context. Note the uncertainty in Coverage or the Verdict reasoning instead of blocking. Never stop to ask a clarifying question — the skill has no blocking prompts.

### Stage 2b: Plan discovery (requirements verification)

Locate the plan document so Stage 6 can verify requirements completeness. Check these sources in priority order — stop at the first hit:

1. **`plan:` argument.** If the caller passed a plan path, use it directly. Read the file to confirm it exists.
2. **PR body.** If PR metadata was fetched in Stage 1, scan the body for paths matching `docs/plans/*.md`. If exactly one match is found and the file exists, use it as `plan_source: explicit`. If multiple plan paths appear, treat as ambiguous — demote to `plan_source: inferred` for the most recent match that exists on disk, or skip if none exist or none clearly relate to the PR title/intent. Always verify the selected file exists before using it — stale or copied plan links in PR descriptions are common.
3. **Auto-discover.** Extract 2-3 keywords from the branch name (e.g., `feat/onboarding-skill` -> `onboarding`, `skill`). Glob `docs/plans/*` and filter filenames containing those keywords. If exactly one match, use it. If multiple matches or the match looks ambiguous (e.g., generic keywords like `review`, `fix`, `update` that could hit many plans), **skip auto-discovery** — a wrong plan is worse than no plan. If zero matches, skip.

**Confidence tagging:** Record how the plan was found:
- `plan:` argument -> `plan_source: explicit` (high confidence)
- Single unambiguous PR body match -> `plan_source: explicit` (high confidence)
- Multiple/ambiguous PR body matches -> `plan_source: inferred` (lower confidence)
- Auto-discover with single unambiguous match -> `plan_source: inferred` (lower confidence)

If a plan is found, read its **Requirements Trace** (R1, R2, etc.) and **Implementation Units** (checkbox items). Store the extracted requirements list and `plan_source` for Stage 6. Do not block the review if no plan is found — requirements verification is additive, not required.

### Stage 3: Select reviewers

Read the diff and file list from Stage 1. The 4 always-on personas and 2 CE always-on agents are automatic. For each cross-cutting and stack-specific conditional persona in the persona catalog included below, decide whether the diff warrants it. This is agent judgment, not keyword matching.

**File-type awareness for conditional selection:** Instruction-prose files (Markdown skill definitions, JSON schemas, config files) are product code but do not benefit from runtime-focused reviewers. The adversarial reviewer's techniques (race conditions, cascade failures, abuse cases) target executable code behavior. For diffs that only change instruction-prose files, skip adversarial unless the prose describes auth, payment, or data-mutation behavior. Count only executable code lines toward line-count thresholds.

**`previous-comments` is PR-only.** Only select this persona when Stage 1 gathered PR metadata (PR number or URL was provided as an argument, or `gh pr view` returned metadata for the current branch). Skip it entirely for standalone branch reviews with no associated PR -- there are no prior comments to check.

Stack-specific personas are additive. A Rails UI change may warrant `kieran-rails` plus `julik-frontend-races`; a TypeScript API diff may warrant `kieran-typescript` plus `api-contract` and `reliability`.

For CE conditional agents, check if the diff includes files matching `db/migrate/*.rb`, `db/schema.rb`, or data backfill scripts.

Announce the team before spawning:

```
Review team:
- correctness (always)
- testing (always)
- maintainability (always)
- project-standards (always)
- inc-agent-native-reviewer (always)
- inc-learnings-researcher (always)
- security -- new endpoint in routes.rb accepts user-provided redirect URL
- kieran-rails -- controller and Turbo flow changed in app/controllers and app/views
- dhh-rails -- diff adds service objects around ordinary Rails CRUD
- data-migrations -- adds migration 20260303_add_index_to_orders
- inc-schema-drift-detector -- migration files present
```

This is progress reporting, not a blocking confirmation.

### Stage 3b: Discover project standards paths

Before spawning sub-agents, find the file paths (not contents) of all relevant standards files for the `project-standards` persona. Use the native file-search/glob tool to locate:

1. Use the native file-search tool (e.g., Glob in Claude Code) to find all `**/CLAUDE.md` and `**/AGENTS.md` in the repo.
2. Filter to those whose directory is an ancestor of at least one changed file. A standards file governs all files below it (e.g., `plugins/my-plugin/AGENTS.md` applies to everything under `plugins/my-plugin/`).

Pass the resulting path list to the `project-standards` persona inside a `<standards-paths>` block in its review context (see Stage 4). The persona reads the files itself, targeting only the sections relevant to the changed file types. This keeps the orchestrator's work cheap (path discovery only) and avoids bloating the subagent prompt with content the reviewer may not fully need.

### Stage 4: Spawn sub-agents

#### Model tiering

Persona sub-agents do focused, scoped work and should use a fast mid-tier model to reduce cost and latency without sacrificing review quality. The orchestrator itself stays on the default (most capable) model.

Use the platform's mid-tier model for all persona and CE sub-agents. In Claude Code, pass `model: "sonnet"` in the Agent tool call. On other platforms, use the equivalent mid-tier (e.g., `gpt-4o` in Codex). If the platform has no model override mechanism or the available model names are unknown, omit the model parameter and let agents inherit the default -- a working review on the parent model is better than a broken dispatch from an unrecognized model name.

CE always-on agents (inc-agent-native-reviewer, inc-learnings-researcher) and CE conditional agents (inc-schema-drift-detector, inc-deployment-verification-agent) also use the mid-tier model since they perform scoped, focused work.

The orchestrator (this skill) stays on the default model because it handles intent discovery, reviewer selection, finding merge/dedup, and synthesis -- tasks that benefit from stronger reasoning.

#### Run ID

Generate a unique run identifier before dispatching any agents. This ID scopes all agent artifact files and the post-review run artifact to the same directory.

```bash
RUN_ID=$(date +%Y%m%d-%H%M%S)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' ')
mkdir -p ".context/incubator/inc-review/$RUN_ID"
```

Pass `{run_id}` to every persona sub-agent so they can write their full analysis to `.context/incubator/inc-review/{run_id}/{reviewer_name}.json`.

**Report-only mode:** Skip run-id generation and directory creation. Do not pass `{run_id}` to agents. Agents return compact JSON only with no file write, consistent with report-only's no-write contract.

#### Spawning

Omit the `mode` parameter when dispatching sub-agents so the user's configured permission settings apply. Do not pass `mode: "auto"`.

Spawn each selected persona reviewer as a parallel sub-agent using the subagent template included below. Each persona sub-agent receives:

1. Their persona file content (identity, failure modes, calibration, suppress conditions)
2. Shared diff-scope rules from the diff-scope reference included below
3. The JSON output contract from the findings schema included below
4. PR metadata: title, body, and URL when reviewing a PR (empty string otherwise). Passed in a `<pr-context>` block so reviewers can verify code against stated intent
5. Review context: intent summary, file list, diff
6. Run ID and reviewer name for the artifact file path
7. **For `project-standards` only:** the standards file path list from Stage 3b, wrapped in a `<standards-paths>` block appended to the review context

Persona sub-agents are **read-only** with respect to the project: they review and return structured JSON. They do not edit project files or propose refactors. The one permitted write is saving their full analysis to the `.context/` artifact path specified in the output contract.

Read-only here means **non-mutating**, not "no shell access." Reviewer sub-agents may use non-mutating inspection commands when needed to gather evidence or verify scope, including read-oriented `git` / `gh` usage such as `git diff`, `git show`, `git blame`, `git log`, and `gh pr view`. They must not edit project files, change branches, commit, push, create PRs, or otherwise mutate the checkout or repository state.

Each persona sub-agent writes full JSON (all schema fields) to `.context/incubator/inc-review/{run_id}/{reviewer_name}.json` and returns compact JSON with merge-tier fields only:

```json
{
  "reviewer": "security",
  "findings": [
    {
      "title": "User-supplied ID in account lookup without ownership check",
      "severity": "P0",
      "file": "orders_controller.rb",
      "line": 42,
      "confidence": 100,
      "autofix_class": "ask_user",
      "owner": "human",
      "requires_verification": true,
      "pre_existing": false,
      "suggested_fix": "Add current_user.owns?(account) guard before lookup"
    }
  ],
  "residual_risks": [...],
  "testing_gaps": [...]
}
```

Detail-tier fields (`why_it_matters`, `evidence`) are in the artifact file only. `suggested_fix` is optional in both tiers -- included in compact returns when present so the orchestrator has fix context for auto-apply decisions. If the file write fails, the compact return still provides everything the merge needs.

**CE always-on agents** (inc-agent-native-reviewer, inc-learnings-researcher) are dispatched as standard Agent calls in parallel with the persona agents. Give them the same review context bundle the personas receive: entry mode, any PR metadata gathered in Stage 1, intent summary, review base branch name when known, `BASE:` marker, file list, diff, and `UNTRACKED:` scope notes. Do not invoke them with a generic "review this" prompt. Their output is unstructured and synthesized separately in Stage 6.

**CE conditional agents** (inc-schema-drift-detector, inc-deployment-verification-agent) are also dispatched as standard Agent calls when applicable. Pass the same review context bundle plus the applicability reason (for example, which migration files triggered the agent). For inc-schema-drift-detector specifically, pass the resolved review base branch explicitly so it never assumes `main`. Their output is unstructured and must be preserved for Stage 6 synthesis just like the CE always-on agents.

### Stage 5: Merge findings

Convert multiple reviewer compact JSON returns into one deduplicated, confidence-gated finding set. The compact returns contain merge-tier fields (title, severity, file, line, confidence, autofix_class, owner, requires_verification, pre_existing) plus the optional suggested_fix. Detail-tier fields (why_it_matters, evidence) are on disk in the per-agent artifact files and are not loaded at this stage.

1. **Validate.** Check each compact return for required top-level and per-finding fields, plus value constraints. Drop malformed returns or findings. Record the drop count.
   - **Top-level required:** reviewer (string), findings (array), residual_risks (array), testing_gaps (array). Drop the entire return if any are missing or wrong type.
   - **Per-finding required:** title, severity, file, line, confidence, autofix_class, owner, requires_verification, pre_existing
   - **Value constraints:**
     - severity: P0 | P1 | P2 | P3
     - autofix_class: auto_apply | ask_user | fyi
     - owner: review-fixer | human | release
     - confidence: integer anchor in {0, 25, 50, 75, 100}
     - line: positive integer
     - pre_existing, requires_verification: boolean
   - Do not validate against the full schema here -- the full schema (including why_it_matters and evidence) applies to the artifact files on disk, not the compact returns.
2. **Deduplicate.** Compute fingerprint: `normalize(file) + line_bucket(line, +/-3) + normalize(title)`. When fingerprints match, merge: keep highest severity, keep highest anchor, note which reviewers flagged it. Dedup runs over the full validated set (including anchor 50) so step 3 can promote corroborated findings before the gate in step 4 drops anything.
3. **Cross-reviewer agreement.** When 2+ independent reviewers flag the same issue (same fingerprint), promote the merged finding by one anchor step: `50 -> 75`, `75 -> 100`, `100 -> 100`. Independent reviewers converging on the same issue is stronger signal than any single reviewer's anchor. Note the agreement in the Reviewer column of the output (e.g., "security, correctness").
4. **Confidence gate.** After dedup and promotion have shaped the set, suppress findings below anchor 75. Exception: P0 findings at anchor 50+ survive the gate -- critical-but-uncertain issues must not be silently dropped. The gate runs late deliberately: an anchor-50 finding needs the chance to be promoted by step 3 (cross-reviewer corroboration) before any drop decision. Suppression is silent: a suppressed finding is one the reviewer wasn't confident is real, which is different from a real-but-no-action finding — do not surface suppressed findings, and do not report a suppressed count, anywhere in the user-facing report. The full set lives in the on-disk artifact for debugging.
5. **Separate pre-existing.** Pull out findings with `pre_existing: true` into a separate list.
6. **Resolve disagreements.** When reviewers flag the same code region but disagree on severity, autofix_class, or owner, annotate the Reviewer column with the disagreement (e.g., "security (P0), correctness (P1) -- kept P0"). This transparency helps the user understand why a finding was routed the way it was.
7. **Normalize routing.** For each merged finding, set the final `autofix_class`, `owner`, and `requires_verification`. If reviewers disagree, keep the most conservative route. Synthesis may narrow a finding from `auto_apply` to `ask_user`, but must not widen it without new evidence.
8. **Partition the work.** Build three sets:
   - fixer queue: `auto_apply -> review-fixer` (applied automatically in mutating modes)
   - your-call set: `ask_user` findings (owner `human`) — presented, never auto-applied
   - informational set: `fyi` findings plus anything owned by `human` or `release`
9. **Sort.** Order by severity (P0 first) -> anchor (descending) -> file path -> line number.
10. **Collect coverage data.** Union residual_risks and testing_gaps across reviewers.
11. **Preserve CE agent artifacts.** Keep the learnings, agent-native, schema-drift, and deployment-verification outputs alongside the merged finding set. Do not drop unstructured agent output just because it does not match the persona JSON schema.

### Stage 6: Synthesize and present

**Lead with the decision, not the metadata.** The first sentence must tell the reader the risk level, how many findings need their input, and what was handled for them. The provenance the merge produced — per-finding confidence scores, which personas flagged each issue, the raw `autofix_class -> owner` route string — is internal bookkeeping. It stays in the on-disk artifact (the Stage 4 per-agent JSON and the Stage 5 synthesized set), **off the terminal surface.** Surface the route as human framing ("needs your call", "auto-applied", "informational"), never as the raw token or a confidence number.

**Default to prose.** A finding is an argument the reader has to evaluate — it needs a sentence or two of explanation, not a cell in a narrow table that wraps into mush in a terminal. Render findings as explained prose. Use a compact table **only** for a low-severity long tail, and only past the volume threshold in step 4.

This format governs the interactive report. `mode:headless` uses its own structured envelope (see below) and is unaffected.

1. **Situation summary (the lead).** One or two sentences: the risk level, the count of findings needing the user's decision, and what was auto-applied or is purely informational. When something is the user's call, say so plainly and say you are stopping there rather than deciding it for them. Example: *"Review complete. Risk: low. Two findings are informational; one needs your call — it's a product decision that's yours to make, so I'm stopping there rather than deciding for you."*
2. **Context (compact).** A few lines, not a wall: scope (files/lines), the 2-3 line intent summary, and the reviewer team with per-conditional justifications. Orienting info only — keep it short.
3. **✅ Auto-applied.** Include only if a fix phase ran this invocation. A brief bullet list — one line per fix.
4. **ℹ️ Informational (demoted, shown for context).** The `fyi` findings and anything the user chose not to act on, rendered as a short bullet list with a one-line explanation each. **Long-tail table exception:** when the report carries more than ~8 findings total, render this informational tail (plus any P2/P3 the user is not being asked to decide) as a single compact `| # | File | Issue |` table so it stays scannable. The needs-your-call section in step 12 stays prose regardless of count.
5. **📋 Requirements Completeness.** Include only when a plan was found in Stage 2b. For each requirement (R1, R2, etc.) and implementation unit in the plan, report whether corresponding work appears in the diff. Use a simple checklist: met / not addressed / partially addressed. Routing depends on `plan_source`:
   - **`explicit`** (caller-provided or PR body): Flag unaddressed requirements as P1 findings with `autofix_class: ask_user`, `owner: human`. These appear in "Needs your call".
   - **`inferred`** (auto-discovered): Flag unaddressed requirements as P3 findings with `autofix_class: fyi`, `owner: human`. These stay in the report only — no todos, no autonomous follow-up. An inferred plan match is a hint, not a contract.
   Omit this section entirely when no plan was found — do not mention the absence of a plan.
6. **🗂️ Pre-existing.** Separate section, does not count toward verdict. A short bullet list — `file:line` and a one-line description each.
7. **📚 Learnings & Past Solutions.** Surface inc-learnings-researcher results: if past solutions are relevant, flag them as "Known Pattern" with links to docs/solutions/ files.
8. **🤖 Agent-Native Gaps.** Surface inc-agent-native-reviewer results. Omit section if no gaps found.
9. **🧬 Schema Drift Check.** If inc-schema-drift-detector ran, summarize whether drift was found. If drift exists, list the unrelated schema objects and the required cleanup command. If clean, say so briefly.
10. **🚀 Deployment Notes.** If inc-deployment-verification-agent ran, surface the key Go/No-Go items: blocking pre-deploy checks, the most important verification queries, rollback caveats, and monitoring focus areas. Keep the checklist actionable rather than dropping it into Coverage.
11. **🧪 Coverage.** Residual risks, testing gaps, failed/timed-out reviewers, and any intent uncertainty carried by non-interactive modes. Do not include a suppressed-findings count — suppression is silent.
12. **⚠️ Needs your call (just above the verdict).** The `ask_user` findings — the only items that require the user. In severity order, render each as prose: a short plain-English heading, the `file:line`, a paragraph on what's wrong and why it matters, and a one-line proposed direction. No confidence numbers, no reviewer names, no route tokens. Add a plain-language "In short:" restatement when the explanation runs long. If there are none, say so in one line. Do not ask the user what to do with these — present them and stop; acting on them is theirs.
13. **🏁 Verdict.** Ready to merge / Ready with fixes / Not ready, in a blockquote. Fix order if applicable. When an `explicit` plan has unaddressed requirements, the verdict must reflect it — a PR that's code-clean but missing planned requirements is "Not ready" unless the omission is intentional. When an `inferred` plan has unaddressed requirements, note it in the verdict reasoning but do not block on it alone.

Do not include time estimates.

**Format check:** Before delivering, verify the report leads with the situation summary and presents the needs-your-call findings — placed just above the verdict — as explained prose, not as a table. Confidence scores, reviewer names, and raw route tokens must not appear on the terminal surface; they live in the artifact. A compact table is allowed only for the informational long tail past the volume threshold.

### Headless output format

In `mode:headless`, replace the interactive report with a structured text envelope. The envelope follows the same structural pattern as document-review's headless output (completion header, metadata block, findings grouped by autofix_class, trailing sections) while using inc-review's own section headings and per-finding fields.

```
Code review complete (headless mode).

Scope: <scope-line>
Intent: <intent-summary>
Reviewers: <reviewer-list with conditional justifications>
Verdict: <Ready to merge | Ready with fixes | Not ready>
Artifact: .context/incubator/inc-review/<run-id>/

Applied N auto_apply fixes.

Needs-your-call findings (ask_user -- the user should review; never auto-applied):

[P1][ask_user -> human][needs-verification] File: <file:line> -- <title> (<reviewer>, confidence <N>)
  Why: <why_it_matters>
  Suggested fix: <suggested_fix or "none">
  Evidence: <evidence[0]>
  Evidence: <evidence[1]>

FYI findings (informational -- no action required):

[P2][fyi -> human] File: <file:line> -- <title> (<reviewer>, confidence <N>)
  Why: <why_it_matters>

Pre-existing issues:
[P2][ask_user -> human] File: <file:line> -- <title> (<reviewer>, confidence <N>)
  Why: <why_it_matters>

Residual risks:
- <risk>

Learnings & Past Solutions:
- <learning>

Agent-Native Gaps:
- <gap description>

Schema Drift Check:
- <drift status>

Deployment Notes:
- <deployment note>

Testing gaps:
- <gap>

Coverage:
- Suppressed: <N> findings below anchor 75 (P0 at anchor 50+ retained)
- Untracked files excluded: <file1>, <file2>
- Failed reviewers: <reviewer>

Review complete
```

**Detail enrichment (headless only):** The headless envelope includes `Why:`, `Evidence:`, and `Suggested fix:` lines. After merge (Stage 5), read the per-agent artifact files from `.context/incubator/inc-review/{run_id}/` for only the findings that survived dedup and confidence gating.
   - **Field tiers:** `Why:` and `Evidence:` are detail-tier -- load from per-agent artifact files. `Suggested fix:` is merge-tier -- use it directly from the compact return without artifact lookup.
   - **Artifact matching:** For each surviving finding, look up its detail-tier fields in the artifact files of the contributing reviewers. Match on `file + line_bucket(line, +/-3)` (the same tolerance used in Stage 5 dedup) within each contributing reviewer's artifact. When multiple artifact entries fall within the line bucket, apply `normalize(title)` to both the merged finding's title and each candidate entry's title as a tie-breaker.
   - **Reviewer order:** Try contributing reviewers in the order they appear in the merged finding's reviewer list; use the first match.
   - **No-match fallback:** If no artifact file contains a match (all writes failed, or the finding was synthesized during merge), omit the `Why:` and `Evidence:` lines for that finding and note the gap in Coverage. The `Suggested fix:` line can still be populated from the compact return since it is merge-tier.

**Formatting rules:**
- The `[needs-verification]` marker appears only on findings where `requires_verification: true`.
- The `Artifact:` line gives callers the path to the full run artifact for machine-readable access to the complete findings schema. The text envelope is the primary handoff; the artifact is for debugging and full-fidelity access.
- Findings with `owner: release` appear in the FYI section (they are operational/rollout items, not code fixes).
- Findings with `pre_existing: true` appear in the Pre-existing section regardless of autofix_class.
- The Verdict appears in the metadata header (deliberately reordered from the interactive format where it appears at the bottom) so programmatic callers get the verdict first.
- Omit any section with zero items.
- If all reviewers fail or time out, emit `Code review degraded (headless mode). Reason: 0 of N reviewers returned results.` followed by "Review complete".
- End with "Review complete" as the terminal signal so callers can detect completion.

## Quality Gates

Before delivering the review, verify:

1. **Every finding is actionable.** Re-read each finding. If it says "consider", "might want to", or "could be improved" without a concrete fix, rewrite it with a specific action. Vague findings waste engineering time.
2. **No false positives from skimming.** For each finding, verify the surrounding code was actually read. Check that the "bug" isn't handled elsewhere in the same function, that the "unused import" isn't used in a type annotation, that the "missing null check" isn't guarded by the caller.
3. **Severity is calibrated.** A style nit is never P0. A SQL injection is never P3. Re-check every severity assignment.
4. **Line numbers are accurate.** Verify each cited line number against the file content. A finding pointing to the wrong line is worse than no finding.
5. **Protected artifacts are respected.** Discard any findings that recommend deleting or gitignoring files in `docs/brainstorms/`, `docs/plans/`, or `docs/solutions/`.
6. **Findings don't duplicate linter output.** Don't flag things the project's linter/formatter would catch (missing semicolons, wrong indentation). Focus on semantic issues.

## Language-Aware Conditionals

This skill uses stack-specific reviewer agents when the diff clearly warrants them. Keep those agents opinionated. They are not generic language checkers; they add a distinct review lens on top of the always-on and cross-cutting personas.

Do not spawn them mechanically from file extensions alone. The trigger is meaningful changed behavior, architecture, or UI state in that stack.

## After Review

**There are no routing questions, walk-throughs, or ticket-filing prompts.** The report is the interaction: `auto_apply` fixes are applied and reported, `ask_user` findings are presented for you to act on, and everything else is informational. Modes differ only in how much they mutate and how they serialize output — none of them stops to ask.

### Step 1: Build the action sets

- **Clean review** = zero findings after suppression and pre-existing separation. Skip the fix step when clean.
- **Fixer queue:** `auto_apply -> review-fixer` findings.
- **Your-call set:** `ask_user` findings (owner `human`). Presented in the "Needs your call" section; never auto-applied, never auto-ticketed.
- **Informational set:** `fyi` findings plus anything owned by `human` or `release`.
- **Never convert informational outputs into fix work or todos.** Deployment notes, residual risks, and release-owned items stay in the report.

### Step 2: Apply auto_apply fixes

Runs in default (interactive), autofix, and headless modes. **Report-only mode skips this step** — no fixer queue, no mutation.

- Apply the `auto_apply -> review-fixer` queue automatically, no question — these are safe by definition.
- Spawn exactly one fixer subagent for the queue in the current checkout; it applies all changes and runs the relevant targeted tests in one pass against a consistent tree. Do not fan out multiple fixers against the same checkout (parallel fixers need isolated worktrees/branches and deliberate mergeback).
- **Verify, then keep.** Run the affected tests/lint. If a fix fails verification, revert that one fix and report it as an unresolved `ask_user` finding instead — never leave the tree red. `requires_verification: true` means the work isn't done until the targeted verification runs.
- **Re-review** the changed scope after fixes land, bounded by `max_rounds: 2`. If issues remain after the second round, stop and report them as unresolved. **Headless applies in a single pass — no re-review loop.**
- Do not start a mutating fix round concurrently with browser testing on the same checkout. An orchestrator that wants both runs `mode:report-only` during the parallel phase or isolates the mutating review in its own checkout/worktree.

### Step 3: Present and stop

- **Default (interactive):** present the Stage 6 report — situation summary, the "Needs your call" (`ask_user`) findings as prose, the auto-applied fixes, then informational. Then **stop.** Do not ask what to do next, do not walk through findings, do not file tickets. The `ask_user` findings are yours to act on; the applied fixes are in your working tree to review and commit; push and PRs are yours to run when ready.
- **Autofix:** apply `auto_apply` only; leave `ask_user` and informational unresolved; write todos for the `ask_user` set (Step 4).
- **Report-only:** stop after Stage 6 — nothing mutated, no todos, no artifacts.
- **Headless:** emit the structured envelope (Stage 6), write the run artifact, no todos, then stop after "Review complete". No commit/push/PR.

**Never push, open a PR, or commit on the user's behalf from this skill** — push is the outward step the user owns. Applied `auto_apply` fixes land in the working tree for the user to review and commit.

### Step 4: Emit artifacts and downstream handoff

- In interactive, autofix, and headless modes, write a per-run artifact under `.context/incubator/inc-review/<run-id>/` containing:
  - synthesized findings (merged output from Stage 5) — written as `findings.json`, a JSON array where each object carries at least `autofix_class`, `severity`, `file`, `line`, `title` (plus `why_it_matters` and optional `suggested_fix`). This is the gate signal downstream skills (e.g. `inc:review-and-pr`) read to count `ask_user` findings — the filename is load-bearing, not freeform.
  - applied fixes
  - the `ask_user` (your-call) set
  - informational outputs
  Per-agent full-detail JSON files (`{reviewer_name}.json`) are already present in this directory from Stage 4 dispatch.
- Also write `metadata.json` alongside the findings so downstream skills can verify the artifact matches the current branch and HEAD. Minimum fields:
  ```json
  {
    "run_id": "<run-id>",
    "branch": "<git branch --show-current at dispatch time>",
    "head_sha": "<git rev-parse HEAD at dispatch time>",
    "verdict": "<Ready to merge | Ready with fixes | Not ready>",
    "completed_at": "<ISO 8601 UTC timestamp>"
  }
  ```
  Capture `branch` and `head_sha` at dispatch time (before any autofixes land), and write the file after the verdict is finalized. This file is additive -- pre-existing artifacts that predate this field are still valid, and downstream skills fall back to file mtime when it is missing.
- In autofix mode, create durable todo files only for `ask_user` findings whose owner is `human`. Map the finding's severity to the todo priority (`P0`/`P1` -> `p1`, `P2` -> `p2`, `P3` -> `p3`) and set `status: ready` since synthesis has already triaged them.
- Do not create todos for `fyi` findings, `owner: release`, or protected-artifact cleanup suggestions.
- If only informational outputs remain, create no todos.

## Fallback

If the platform doesn't support parallel sub-agents, run reviewers sequentially. Everything else (stages, output format, merge pipeline) stays the same.

---

## Included References

### Persona Catalog

@./references/persona-catalog.md

### Subagent Template

@./references/subagent-template.md

### Diff Scope Rules

@./references/diff-scope.md

### Findings Schema

@./references/findings-schema.json

### Review Output Template

@./references/review-output-template.md
