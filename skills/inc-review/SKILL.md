---
name: inc:review-3a
description: Review the uncommitted/branch changes in the working tree — auto-apply safe fixes, surface findings that need your call, write a run artifact. Lightweight tier; escalate to inc:review-deep-3b for large or sensitive changes.
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git blame:*), Bash(git remote:*), Bash(mkdir:*), Edit, Write, Read, Grep, Glob, Agent, Bash
disable-model-invocation: false
---

Review the change set on the current branch: auto-apply safe fixes, surface findings that need the user's call, and write a run artifact. This is the lightweight review tier — a fast single-agent pass without the deep persona fan-out, merge, or dedup machinery. For large or sensitive changes, or to review a GitHub PR, use `inc:review-deep-3b` instead.

## Scope

Working-tree only. The review target is the change set on the current branch: `git diff HEAD` plus staged changes (`git diff --cached`), or — when reviewing a whole branch — `git diff <base>...HEAD`. There is no PR mode; reviewing a GitHub PR is `inc:review-deep-3b`'s job.

**No-changes guard:** if `git status --porcelain` is empty (and no branch diff was requested), stop with `No changes to review.` and do not proceed.

"The diff" below always means this local change set.

To do this, follow these steps precisely:

1. Launch a single Sonnet review agent. It reviews the change and returns a list of findings, following the review instructions below verbatim. It locates the relevant CLAUDE.md files on its own (root CLAUDE.md plus any in directories the change touches). Deeper architectural review (the persona fan-out) belongs to `inc:review-deep-3b`, not this tier.

   **Review instructions (give to the agent verbatim):**

   > Review the code changes and return structured findings.
   >
   > Task:
   > - Read the relevant history and diff yourself.
   > - Focus findings on risks introduced by changed code, but inspect surrounding code, call sites, shared helpers, tests, and invariants when needed to understand root cause.
   > - Do NOT run tests during review. The pipeline has a dedicated test step after review.
   > - Analyze for bugs, risks, and code simplification opportunities.
   > - "Simplification" means reducing code complexity through non-functional refactoring (e.g. deduplication, clearer control flow). It does NOT mean removing features, changing product behavior, or stripping intentional user-facing output.
   > - Treat security issues, performance regressions, breaking changes, and insufficient error handling as risks.
   > - Do a full review pass before returning. Do not stop after the first valid finding. Continue inspecting the rest of the changed code until you have enumerated all material issues you can substantiate.
   >
   > Rules:
   > - Anchor every finding to a specific file and one-indexed line number in the changed code when possible.
   > - Severity is P0-P3: P0 = critical breakage/exploit/data loss (must fix before merge), P1 = high-impact defect likely hit in normal use, P2 = moderate issue with meaningful downside, P3 = low-impact minor improvement.
   > - Be concise and actionable. No generic advice like "add more tests".
   > - Only comment on things that genuinely matter.
   > - Do NOT report styling, formatting, linting, compilation, or type-checking issues.
   > - If the change is clean, return an empty findings array.
   >
   > Only report findings you can substantiate with concrete, code-grounded evidence — skip anything speculative or unverified. The one exception is a critical (P0) issue you believe is real but cannot fully verify: report it anyway.
   >
   > Set `autofix_class` to exactly one of:
   >   - `auto_apply`: The fix is local, deterministic, and safe to apply automatically — correctness, error handling, security, performance, or mechanical code quality, with no question about the author's intent. Examples: add a missing nil check, fix an off-by-one, extract a duplicated helper, remove dead code, add a missing test.
   >   - `ask_user`: The user should review this before anything changes — because the fix touches behavior, contracts, permissions, product decisions, or the author's deliberate intent, OR because it is actionable work needing a design decision. Examples: add auth to an unprotected endpoint, change a public API response shape, a deletion that looks wrong, a hardcoded value that should be configurable. When in doubt between auto_apply and ask_user, choose ask_user.
   >   - `fyi`: Informational only — no action required. Examples: noting a pattern, acknowledging a tradeoff, a residual risk.

   Each finding is a `{file, line, severity, autofix_class, title, why_it_matters, suggested_fix?}` object — `severity` is P0-P3, `autofix_class` is auto_apply|ask_user|fyi, `suggested_fix` is optional. Drop the false-positive categories listed below; do not report them.

2. **Auto-apply safe fixes.** For every `auto_apply` finding, apply the fix to the working tree (Edit/Write). Then verify: run the affected tests/lint (targeted; broaden if fixes span files). If a fix fails verification, revert that one fix and re-route it as `ask_user`. Never leave the tree red. A finding whose fix needs validation is not done until that check runs.

3. **Write the run artifact.** Generate a run id (`date +%Y%m%d-%H%M%S`-rand) and `mkdir -p .context/incubator/inc-review/<run-id>/`. Write the finding set to `.context/incubator/inc-review/<run-id>/findings.json` as a JSON array (each object: `autofix_class`, `severity`, `file`, `line`, `title`, `why_it_matters`, optional `suggested_fix`). Write `metadata.json` with `{run_id, branch, head_sha, completed_at, ask_user_count}`. This `findings.json` is the gate signal downstream skills (e.g. `inc:review-and-pr`) read.

4. **Present, then stop.** Render the report per `references/review-output-template.md`: a one-line situation summary (risk + what was auto-applied + what needs the user), then the `ask_user` findings as "Needs your call" prose, then the auto-applied fixes, then `fyi` informational. Cite each finding by `file:line`. Then stop — do not ask what to do next; the `ask_user` findings are the user's to act on.

Examples of false positives (the agent excludes these — do not report them):

- Pre-existing issues
- Something that looks like a bug but is not actually a bug
- Pedantic nitpicks that a senior engineer wouldn't call out
- Styling, formatting, linting, compilation, or type-checking issues, and anything a linter, typechecker, or compiler would catch (eg. missing or incorrect imports, type errors, broken tests, formatting issues, pedantic style issues like newlines). No need to run these build steps yourself -- it is safe to assume that they will be run separately as part of CI.
- General code quality issues (eg. lack of test coverage, general security issues, poor documentation), unless explicitly required in CLAUDE.md
- Issues that are called out in CLAUDE.md, but explicitly silenced in the code (eg. due to a lint ignore comment)
- Changes in functionality that are likely intentional or are directly related to the broader change
- Real issues, but on lines outside the reviewed change set

Notes:

- Do not check build signal or attempt to build or typecheck the app for review purposes. (Verifying an applied `auto_apply` fix in step 2 is different — that targeted test/lint run is required.)
- Make a todo list first.
- The presentation in step 4 follows `references/review-output-template.md` exactly — lead with the situation summary, `ask_user` as prose, no internal bookkeeping on screen.

---

## Included References

### Findings Schema

@./references/findings-schema.json

### Review Output Template

@./references/review-output-template.md
