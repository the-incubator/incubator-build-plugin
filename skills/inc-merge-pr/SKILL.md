---
name: inc:merge-pr-5
description: Use when the user says "ship it", "ship this PR", "ship pr", "deploy check", "ready to deploy", "merge and deploy", or is about to merge a PR that triggers a production deploy. Runs a pre-flight branch-freshness check, then blocking gates (new env vars; PR health - not draft, CI green, no unresolved review threads including AI reviewer comments) plus a deploy-window check that respects the team's deploy-window rules configured via /inc:setup-deploy (default when none are set, risk-adaptive - low-risk changes just ship, riskier ones prompt a quick confirm). If all gates pass, squash-merges the PR into main, deletes the branch (local + remote), and checks out main. If any gate fails, the merge is blocked. After merge, actively observes the deploy via the detected platform's CLI (Vercel, Netlify, Fly.io, Railway, Google Cloud, GitHub Actions) and scans the first 3 minutes of logs for errors before completing.
allowed-tools: Read, Bash(git *), Bash(gh *), Bash(date *), Bash(TZ=* date *), Bash(./scripts/*), Bash(vercel *), Bash(netlify *), Bash(fly *), Bash(flyctl *), Bash(railway *), Bash(gcloud *), Bash(jq *), Bash(grep *), Bash(sleep *), Bash(curl *), Bash(mktemp), Glob, Grep, Skill, Monitor, PushNotification
---

# Merge PR: Production Deploy Readiness Check

Gates every PR must pass before it merges into a branch that deploys to production. Any failure **blocks the merge**. Merging a red gate is a ship-stopping violation, not a warning. Two gates are always hard blocks (env vars, PR health); the third - the deploy window - respects the team's deploy-window rules configured via `/inc:setup-deploy`. **With no window rule configured, the default is risk-adaptive:** a low-risk change just ships, while a change carrying risk signals (schema/migration, backfill, large diff) gets a quick confirm first.

**Plugin scripts:** Commands that use `<plugin root>` need the installed `incubator-build` plugin directory. In Claude Code, use `${CLAUDE_PLUGIN_ROOT}`. In Codex, resolve it from the loaded skill path: the plugin root is two directories above this `SKILL.md`.

Report each gate in order. At the end, print a single line: `MERGE: GO` or `MERGE: BLOCK - <reasons>`. On `MERGE: GO`, squash-merge the PR into `main` with `--delete-branch` (which also checks out `main` and removes the local feature branch), then **actively observe the deploy** (wait for Ready state, scan first-3-min logs for errors) before declaring the skill complete.

---

## Pre-flight: Run all gates in one pass

Every deterministic check - branch freshness, Gate 1 (env vars), Gate 2 (PR health: draft, CI, unresolved threads incl. AI, mergeable state), and Gate 3 signal collection - runs in a **single script** that emits one `=== MERGE GATES ===` block. Run it once; the gate sections below tell you how to read each part. Do **not** re-run the individual `gh` / `git` / `jq` commands - the block already carries every signal, including the env-var paste block and the unresolved-thread snippets. This is the whole point: one Bash call and one compact result, not a dozen round-trips.

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<plugin root>}"
bash "$PLUGIN_ROOT/skills/inc-merge-pr/scripts/merge-gates.sh"
```

The block's final line is `VERDICT: <GO | BLOCK | NEEDS_DECISION> [reasons=...]`:

- **GO** - every hard gate passed and Gate 3 is clear: no window rule and a low-risk change (or a rule/risk case you already resolved to OK). Proceed to deploy-observation readiness, then merge.
- **BLOCK** - at least one hard gate failed: freshness overlap, new env vars, or PR health. A gate that **could not be verified** (helper crashed, `gh` errored, quota exhausted, unparseable remote) is fail-safe and also blocks here - the script never lets an unverifiable gate pass. Report the failing gate(s) per the sections below and **stop** - do not run deploy-observation readiness, do not merge.
- **NEEDS_DECISION** - no hard failure, but Gate 3 needs your call: either a configured deploy-window rule to evaluate against the current time (`gate3-window-decision`), or - with no window rule - an elevated-risk change to confirm before shipping (`gate3-risk-confirm`). Work the Gate 3 decision branch; merge only if it resolves to OK. (Neither is a hard block.)

The exit code mirrors the verdict (0 / 1 / 2) but the `VERDICT:` line is the source of truth - branch on it, not the exit code. Because every unverifiable gate fail-safes into a BLOCK reason, the `VERDICT:` line can never say GO while a gate sub-line says `error`; the two can't contradict. `reasons=` enumerates which gates contributed (`preflight`, `preflight-overlap`, `gate1-env`, `gate2-health`, `gate3-window-decision`, `gate3-risk-confirm`).

### Read freshness first (`PREFLIGHT_FRESHNESS:` line)

Commit count is a noisy proxy for staleness - 50 commits on files this branch doesn't touch is harmless, while 2 commits on a file this branch rewrote can invalidate the entire diff. The script checks **path overlap** between what this PR branch changed and what landed on `main` since divergence (fetching the PR branch from origin first, so a stale local tip can't produce a false "no overlap"). Overlap means CI went green against a version of the code the merge will no longer produce.

- `ok` - pre-flight OK. If `BEHIND > 0` with `OVERLAP_COUNT=0`, note "`<BEHIND>` commits behind `main`, no path overlap" in the report and continue.
- `block_default_branch` - **stop.** You're on the default branch, so there's no PR to merge. Tell the user to check out the PR's feature branch and re-run.
- `block_overlap` - **block the merge**, regardless of `BEHIND`. List the `OVERLAP=` paths so the collision is visible. If the user is on the PR branch locally, invoke the `inc:update-code` skill via the `Skill` tool (conflicts route to `git-merge-expert` automatically). After it returns cleanly, remind the user they must `git push` and wait for CI to re-run green before re-invoking `/inc:merge-pr-5`. Do not push or bypass CI from this skill. If they're not on the PR branch, tell them to switch and re-run.
- `error` - **freshness BLOCK (unverifiable).** Freshness couldn't be computed - not a git repo, detached HEAD, or the `branch-freshness` helper crashed / returned no usable output. The script fail-safes this to a block rather than emitting a false "ok" that could let a merge through without checking path overlap. Surface the reason and stop.

**Success criteria:** No files changed on both the branch and on `main` since divergence - or the user has updated the branch and CI is re-running before re-invocation.

---

## Pre-flight: Deploy observation readiness

Run this **only when the gates block did not hard-BLOCK** (verdict GO or NEEDS_DECISION) - there's no point probing deploy auth for a merge that can't happen. Resolve the deploy configuration and probe the read-only auth command **now**, before the merge. The point is to surface "I won't be able to observe the deploy" as a decision the user makes upfront - not as a frustrating denial after the merge has already happened. The harness sandbox can classify a CLI read (e.g., `railway whoami`, `vercel whoami`) as a "Production Reads" action and auto-deny without prompting; this step catches that early.

**Step 0a - Resolve the deploy configuration.** This skill does **not** carry platform-detection tables or per-platform command knowledge - that lives in `/inc:setup-deploy`, which persists it to a `## Deploy Configuration` block in **`deploy.md`** (with a one-line pointer in `CLAUDE.md`). Read that block, preferring deploy.md and falling back to a legacy block in CLAUDE.md:

```bash
grep -A 80 "## Deploy Configuration" deploy.md 2>/dev/null \
  || grep -A 80 "## Deploy Configuration" DEPLOY.md 2>/dev/null \
  || grep -A 80 "## Deploy Configuration" CLAUDE.md 2>/dev/null \
  || echo "NO_DEPLOY_CONFIG"
```

(`DEPLOY.md` is the legacy filename - redundant on macOS's case-insensitive filesystem, needed on Linux. `/inc:setup-deploy` migrates it to `deploy.md` on its next run.)

- **Block present** (in either file) → parse `Platform`, the `CLI auth check` command, the deploy-status / wait-for-Ready / early-log-scan commands, and the health-check URL. Record `$PLATFORM` and treat these persisted commands as the source of truth for the rest of the skill. Continue to Step 0b.
- **Block absent (`NO_DEPLOY_CONFIG`)** → setup-deploy has not been run. Ask via AskUserQuestion (do not silently skip):

  > **No deploy configuration found.** `/inc:setup-deploy` hasn't been run for this repo, so I have no parse-safe commands to watch the deploy with. How do you want to proceed?
  > 1. **Run `/inc:setup-deploy` now** (recommended) - I'll invoke it to detect the platform and persist the status/log commands, then continue the gates. *(It writes a `## Deploy Configuration` block to `deploy.md` plus a one-line pointer in `CLAUDE.md`; commit those separately.)*
  > 2. **Skip deploy observation** - run the gates and merge, but I won't wait for Ready or scan logs. You watch the dashboard yourself.
  > 3. **Abort** - don't run the gates.

  Resolve:
  - **Run setup-deploy** → invoke the `/inc:setup-deploy` skill via the Skill tool, then re-read the block (the grep above) and continue to Step 0b with the persisted config.
  - **Skip** → set `OBSERVATION_READY=skip` with reason "no deploy configuration; user declined /inc:setup-deploy", continue to the gate interpretation below.
  - **Abort** → stop the skill entirely.

**Step 0b - Probe the auth check.** Run the read-only `CLI auth check` command from the Deploy Configuration block (e.g. `vercel whoami`, `railway whoami`, `netlify status`, `fly auth whoami`, `gcloud auth list ...`, `gh auth status`). Three outcomes:

- **Probe succeeds** → `OBSERVATION_READY=1`. Note "`<platform>` CLI authed as `<account>`" in the report. Continue to the gate interpretation below.
- **CLI missing or unauthed** (non-zero exit, "command not found", "not logged in", token expired) → don't silently skip; this is usually fixable in seconds and observation is the skill's whole back half. Print the actual error **plus the fix command**: the `Reauth` line from the Deploy Configuration block, falling back to the platform default (`vercel login`, `netlify login`, `fly auth login`, `railway login`, `gcloud auth login`, `gh auth login`; for a missing CLI, the install command, e.g. `npm i -g vercel`). **Never run install/login yourself** - logins are interactive and the account choice is the user's. Suggest they run it as `! <command>` (runs inside this session so the auth lands here). Then ask (AskUserQuestion):
  1. **Fixed - re-probe** → re-run the auth check; on success set `OBSERVATION_READY=1` and continue to the gate interpretation below. If the CLI was **missing** (not just unauthed) and the user installed it, also re-run `/inc:setup-deploy` (via the Skill tool) before proceeding - the persisted commands were verified against a CLI version that wasn't this one, and flags drift between majors.
  2. **Skip observation** → `OBSERVATION_READY=skip` with the actual error recorded. Note in the report and continue to the gate interpretation below.
- **Probe denied by sandbox** (denial message mentioning "Production Reads", "permission for this action has been denied", or similar harness-level refusal that is *not* a CLI-level error) → **STOP. Do not proceed to gates.** Surface the choice:

  > **Pre-flight (deploy observation readiness):** Detected platform: `<platform>`. The sandbox blocked `<probe command>` (a read-only auth check) before it could run. Without permission for this command, post-merge observation will be unavailable - I won't be able to wait for Ready or scan logs.
  >
  > How would you like to proceed?
  > 1. **Grant permission** - I'll invoke the `update-config` skill to add `Bash(<platform> *)` (or a tighter rule like `Bash(<platform> status)`, `Bash(<platform> logs:*)`, `Bash(<platform> whoami)`) to project `.claude/settings.json` (or user `~/.claude/settings.json` if you prefer global). Then I'll re-probe and continue.
  > 2. **Accept observation skipped** - proceed with the gates and skip Active Deploy Observation. You'll watch the platform dashboard yourself.
  > 3. **Abort** - don't run the gates at all.

  Resolve based on the user's answer:
  - **Grant** → invoke `update-config`, re-probe, set `OBSERVATION_READY=1` if the retry succeeds.
  - **Accept skipped** → set `OBSERVATION_READY=skip` with reason "user accepted observation skipped", continue to the gate interpretation below.
  - **Abort** → stop the skill entirely.

**Why this runs before the merge, not post-merge:** the sandbox denial is a one-line message that doesn't survive post-merge well - by the time observation runs, the merge commit is on `main` and a Railway/Vercel deploy may already be picking it up. Deciding the permission posture before any irreversible action is the same shape as Gate 1 (env vars must exist before code runs). It runs *after* the read-only gates block because there's no reason to probe deploy auth for a merge the gates will block.

---

## Gate 1: New Environment Variables

New `process.env.*` or `import.meta.env.*` references in the diff must already be configured in the project's deploy pipeline before merge. Frontend build-time vars (e.g., `VITE_*`) are typically baked in at build time and need to be set in the build config; backend runtime vars are set in the runtime environment. The specific files and surfaces are project-dependent - consult the project's deploy docs or `CLAUDE.md` for the exact location.

Read the `GATE1_ENV:` line from the gates block:

- `pass` → **Gate 1 OK.**
- `block` → **Gate 1 BLOCK.** The block carries the underlying `check-env-vars.sh` output on `  ENV| `-prefixed lines - a `NEW_VARS:` list and a `PASTE_BLOCK:` section. List each new var. For each, tell the user:
  > **New env var `<VAR_NAME>`** - not configured in the deploy pipeline.
  > - If it's a build-time var (e.g., `VITE_*`): add it to the build config so it's baked into the bundle.
  > - Otherwise: add it to the runtime environment for the target deploy environment.
  >
  > Merge is blocked until this var is configured in the deploy pipeline.

  Then render the `PASTE_BLOCK:` lines (strip the `  ENV| ` prefix) as a fenced **dotenv** code block so the user can one-click copy into the platform's bulk-add UI:

  > **Paste-ready** (works in Railway → *Variables → Raw Editor*, Vercel → *Settings → Environment Variables → Import .env*, Netlify → *Site config → Environment variables → Import from .env*, Render env groups, Fly `flyctl secrets import < paste.env`, Heroku via `cat | xargs heroku config:set`):
  >
  > ```dotenv
  > <verbatim PASTE_BLOCK lines from the block, prefix stripped>
  > ```
  >
  > Lines with a value were pulled from your local `.env` - review before pasting (local creds may not be what prod should use). Lines ending with `=` are placeholders you'll need to fill in.
- `error` → **Gate 1 BLOCK (unverifiable).** The env check couldn't run (e.g. the diff against `origin/main` was unavailable). The script fail-safes this to a block rather than merging with env vars unchecked. Surface the reason; the user fixes the cause (usually a missing fetch) and re-runs.

Do not proceed past this gate until the user confirms each new var is configured in the pipeline. "I'll add it after merge" is not acceptable - the var must exist when the new code runs.

**Coverage caveat.** The script only catches `process.env.*` and `import.meta.env.*` literal references in the diff. Indirect reads - `ConfigService.get('FOO')`, NestJS `@ConfigService`, `env('FOO')` helpers, dynamic lookups like `process.env[name]` - won't show up. When the diff touches such a wrapper or adds a key to a typed config schema, manually note any new keys in the gate-1 report and add them to the paste block before handing it to the user.

---

## Gate 2: PR Health Check

Four deterministic sub-checks - draft status, CI status, unresolved review threads (including AI reviewers), and mergeable state. No judgment calls; Gate 2 passes only if all four are clean. The gates script already ran them in one pass, so read the `GATE2_HEALTH:` line and its sub-lines from the block rather than re-querying.

**API budget note.** The script uses **REST as the primary source** for everything except review-thread resolution state (the one thing only GraphQL exposes), which it gets through `scripts/gh-thread-cache` - at most one GraphQL call per (PR, head SHA), cached on disk, so repeated runs on the same commit cost zero GraphQL points. When the GraphQL budget is exhausted or auth has lapsed, the thread sub-check degrades to a REST-only heuristic rather than blocking you.

Read `GATE2_HEALTH:`:

- `ok` → **Gate 2 OK.** All four sub-checks clean.
- `block` → **Gate 2 BLOCK.** The sub-lines pinpoint which check(s) failed - surface each that's not clean:
  - `PR_NUMBER=` empty (with a `REASON=`) → no open PR for the branch. Tell the user to check out the PR branch and re-run.
  - `DRAFT=true` → PR is still a draft. Mark it ready for review and re-run.
  - `CI: failing:<names>` → **CI failing** - list the names.
  - `CI: pending:<names>` → **CI still running** - list the names, tell the user to wait. Do not merge mid-CI.
  - `CI: error (...)` → **CI status could not be verified** (the `check-runs` query failed, was rate-limited, or the PR head SHA was unavailable). The script fail-safes this to a block - it does **not** assume green. Tell the user CI couldn't be confirmed; they re-run the gates (or check the PR on GitHub) once the API is reachable. Never merge on an unverified CI status.
  - `THREADS: count=N ai=M mode=<precise|degraded>` with `N > 0` → **`N` unresolved review thread(s) (`M` from AI reviewers).** Each `THREAD:` line that follows is `<AI|human> | <path> | <author> | <snippet>`. Print up to 5, marking AI threads with `🤖` so they're impossible to miss:

    > **Gate 2 BLOCK.** `<N>` unresolved review thread(s) (`<M>` from AI reviewers):
    > - 🤖 AI `<path>` - `greptile-apps[bot]`: `<snippet>`
    > - `<path>` - `<human-author>`: `<snippet>`
    > - …
    >
    > Address each (fix + reply, or explicitly resolve with a reason). AI threads count the same as human threads. Re-run after resolving.

  - `THREADS: ... mode=error` → the thread query produced a non-numeric count (jq errored on a malformed payload). The script fail-safes to a block - it does **not** report zero threads. Tell the user thread state couldn't be verified and to re-run.
  - `MERGEABLE=dirty` → **conflicts.** Invoke `inc:update-code` to rebase/merge `main` in, then push and re-run. `blocked` → branch-protection rule unsatisfied (the specific reason usually overlaps with draft/CI/threads; if not, surface the raw status). `behind` → branch behind target; update from `main` and re-run. `unknown` → GitHub computes mergeability lazily; surface the status and block (re-running the gates a moment later usually resolves it).
- `skipped` → pre-flight blocked before a PR could be resolved (see the freshness line); this fail-safes to a block too. Resolve the freshness/branch problem first.
- `error` → **Gate 2 BLOCK (unverifiable).** Owner/repo couldn't be parsed from the git remote, so PR health couldn't be checked at all. The script blocks rather than merging unchecked. Surface and stop.

**Thread mode.** `mode=precise` means the cached GraphQL thread state was available (the authoritative `isResolved` / `isOutdated` signal). `mode=degraded` means GraphQL was unavailable and the script fell back to a "latest commenter isn't the PR author" heuristic - best-effort. `mode=error` means the thread query failed outright (treated as a block). When you see `mode=degraded`, surface this banner before the thread list:

> ⚠️ **Thread-resolution state unavailable** (GraphQL quota/auth). Falling back to "latest commenter isn't PR author" heuristic. The precise state restores itself on the next run once the GraphQL quota resets or auth is restored - re-run `/inc:merge-pr-5` then.

The AI detection covers the common cases (Greptile, CodeRabbit, Copilot, Claude, Cursor) plus a fallback for any bot login ending in `-ai[bot]` or `-review*[bot]`. If the user has a custom AI reviewer bot, they can extend the pattern in `merge-gates.sh`.

**Carry `PR_NUMBER` forward** from the `GATE2_HEALTH:` block - the final merge step reuses it rather than re-querying.

---

## Gate 3: Deployment Window

The deploy window is **team-configured policy, not a built-in rule**. `/inc:setup-deploy` asks whether the team restricts when deploys may go out and, if so, persists a one-line `Deploy window:` rule into the `## Deploy Configuration` block in `deploy.md`. This gate reads that rule and respects it. **When no rule is configured, there is no fixed window - the default is risk-adaptive:** a low-risk change just ships, while a change carrying risk signals (schema/migration, backfill, large diff) gets a quick confirm before it merges.

The gates script does **not** interpret a window rule (matching a natural-language policy like "Mon–Thu after 1pm ET; freeze during the Dec holiday" against the clock is your job). It detects whether a rule exists, emits the current Eastern time as ground truth, classifies the change's risk (`RISK=low|elevated`), and lists the risk signals. Read the `GATE3_WINDOW:` line, the `RISK=` sub-line, and the `SIGNALS=` / `DIFFSTAT=` sub-lines from the block:

| `GATE3_WINDOW:` | `RISK=` | Action |
|-----------------------|---------|--------|
| `none` | `low` | **Gate 3 OK** - no window rule, low-risk change; just ship. |
| `none` | `elevated` | Run the **default risk confirmation** (below) - a quick confirm before shipping. |
| `rules` | (any) | Evaluate the configured **window rule** against the current time (below). A rule takes precedence; it weighs the same risk signals when the window is closed. |

### Default risk confirmation (no window rule)

When no window rule is configured and the change carries risk signals, the script reports `VERDICT: NEEDS_DECISION` with reason `gate3-risk-confirm`. This is a **lightweight confirm**, not the full window ceremony - the merge isn't blocked, you're just giving the user a chance to hold a riskier change.

**Read the signals.** The `SIGNALS=` line lists which fired (space-separated):

- `env` - new env vars (note: this also hard-blocks Gate 1, so you'd normally see it there first).
- `schema` - the diff touches DB schema or migration files (`schema`/`migrations`/`drizzle`/`prisma` paths or `*.sql`).
- `backfill` - the diff references a backfill, seed, or one-time data job.
- `largediff` - files changed ≥ 10 **or** insertions+deletions ≥ 300 (the `DIFFSTAT=` line shows the raw stat).

**Present a short assessment and ask** (AskUserQuestion):

> **Gate 3 (risk check):** No deploy-window rule is configured, so this can ship anytime - but the change carries risk signals worth a look before it goes to production:
>
> - Signals: `<list signals>` (`<DIFFSTAT>`).
>
> Ship it now, or hold?
> 1. **Ship it** - merge and deploy now.
> 2. **Hold** - I'll stop here; you deploy later or split the risky part out.

Resolve:
- **"Ship it"** → **Gate 3 OK (elevated risk, user confirmed: `<signals>`).**
- **"Hold"** → **Gate 3 BLOCK - user held on elevated risk (`<signals>`).** Stop; do not merge.

Record the signals and the user's choice in the final report. A low-risk change (`RISK=low`, `VERDICT: GO`) never reaches this prompt - it just ships.

### Evaluating a configured window rule

The script reports `VERDICT: NEEDS_DECISION` whenever a rule is present (when no hard gate already blocked) - that just means **you** must judge now-vs-rule; it does *not* mean you must always ask the user.

**Step 3a - Read the rule and the current time.** From the block:
- `RULE=` - the team's window policy, verbatim (e.g. `Mon-Thu after 1pm ET; freeze Fri-Sun`).
- `TIME=` - the current Eastern time (e.g. `Saturday 2026-04-25 11:14 EDT`), plus `DOW=` (1=Mon…7=Sun) and `HOUR=` (0–23) for precise comparison.

**Step 3b - Decide whether the current time satisfies the rule:**

- **Window open** (the current time clearly satisfies the rule) → **Gate 3 OK** - proceed to merge without asking. Note "within deploy window (`<rule>`)" in the report.
- **Window closed** (the current time violates the rule, or a freeze applies) → this is the user's call. Surface the risk signals and a **clear, direct recommendation**, then ask (do not silently block or silently pass).
- **Ambiguous** (you genuinely can't tell whether the rule is satisfied - e.g. an underspecified or unusual policy) → treat as closed and ask, showing the rule so the user can decide.

**Step 3c - When the window is closed, read the risk signals.** The `SIGNALS=` line lists which fired (space-separated, or `none`):

- `env` - Gate 1 reported new env vars.
- `schema` - the diff touches DB schema or migration files (`schema`/`migrations`/`drizzle`/`prisma` paths or `*.sql`).
- `backfill` - the diff references a backfill, seed, or one-time data job.
- `largediff` - files changed ≥ 10 **or** insertions+deletions ≥ 300 (the `DIFFSTAT=` line shows the raw stat).

**Step 3d - Form a recommendation** based on signals:

- **No signals fired** → recommend **OK** if the change is a low-risk minor fix or a critical hotfix.
- **One or more signals fired** → recommend **hold unless this is a critical hotfix** - the signals indicate the change carries real risk that an off-window team would have to absorb.

**Step 3e - Present the closed-window decision to the user:**

> **Gate 3 (deploy window closed):** Current time: `<Sat 2026-04-25 11:14 EDT>`. The team's deploy-window rule is `<rule>`, which the current time does not satisfy.
>
> Signals observed: `<list signals, or "none">`.
>
> **Recommendation:** `<OK if change is minor/hotfix | hold unless this is a critical hotfix - <which signals> indicate non-trivial risk>`.
>
> How should I classify this change?
> 1. **Critical hotfix** - production is broken / user-facing regression / security issue. State what is broken.
> 2. **Minor low-risk** - small scoped change that the team is comfortable shipping outside the window.
> 3. **Wait for the window** - hold until the next in-window slot.

Resolve based on the user's answer - **the user's call stands**, even if it overrides the recommendation:

- **"Critical hotfix"** with a stated reason → **Gate 3 OK (hotfix: `<reason>`).**
- **"Minor low-risk"** → **Gate 3 OK (minor).** If signals fired and the user picked this anyway, record "minor, user override despite `<signals>`" in the report.
- **"Wait for the window"** → **Gate 3 BLOCK - outside deploy window.** Compute the next in-window slot from the current EST time and the rule, and report it: "Wait until `<next valid window>`."

Record the rule, the chosen classification, and any override verbatim in the final report so the call is auditable. Do not silently pass a closed-window deploy - always surface the recommendation and the user's classification.

---

## Final Report

After all three gates, print:

```
=== MERGE-PR REPORT ===
Pre-flight (freshness):  <OK | OK: N behind, no overlap | BLOCK: path overlap on <files>, update required>
Pre-flight (observation): <ready: <platform> as <account> | skip: <reason> | granted: rule added, re-probe ok>
Gate 1 (env vars):       <OK | BLOCK: ...>
Gate 2 (PR health):      <OK | BLOCK: draft | BLOCK: CI <failing|pending> - <checks> | BLOCK: <N> unresolved review thread(s) | BLOCK: merge state <status>>
Gate 3 (deploy window):  <OK - no window rule, low risk | OK - elevated risk (<signals>), user confirmed | OK - within window (<rule>) | OK (hotfix: <reason>) | OK (minor [, user override despite <signals>]) | BLOCK - user held on elevated risk (<signals>) | BLOCK - outside deploy window (<rule>), wait until <next slot>>

MERGE: <GO | BLOCK - gate(s) N, M>
```

If `MERGE: BLOCK`, stop. Do not merge. Do not suggest workarounds that skip a gate.

If `MERGE: GO`, squash-merge the PR into `main`. Use the `PR_NUMBER` from the gates block's `GATE2_HEALTH:` section rather than re-querying.

```bash
gh pr merge "$PR_NUMBER" --squash --delete-branch
```

`--delete-branch` removes the remote branch as part of the merge call and then, on the local side, checks out the repo's default branch, pulls, and deletes the local feature ref - so by the time this command returns successfully the working tree is on `main` (or whatever the repo's default branch is) with fresh upstream state. If the user has told you their repo convention is `--merge` or `--rebase`, use that strategy instead of `--squash`; `--delete-branch` rides along the same way.

After the merge returns success, confirm the working tree is on the default branch:

```bash
git branch --show-current
```

If this returns the default branch (the one resolved during pre-flight), continue to Active Deploy Observation. If it still returns the feature branch, `gh` couldn't finish the local cleanup - most commonly because the feature branch is checked out in another worktree. Tell the user explicitly ("merge succeeded, remote branch deleted, but local ref couldn't be removed - likely a worktree elsewhere") and do **not** try to force the checkout from this skill. Then continue to Active Deploy Observation from whatever branch you're on; the deploy poll doesn't depend on local branch state.

If `gh pr merge` fails, report the error verbatim, then branch on the cause:

- **Merge conflicts** - hand off to the `git-merge-expert` skill to resolve conflicts (update the branch from `main`, resolve, push), then re-run `/inc:merge-pr-5`. Do not resolve conflicts in this skill.
- **Required checks not green / branch protection / anything else** - stop. Do not retry, do not pass force flags.

After a successful merge, run **Active Deploy Observation** below - do not declare the skill complete until observation has produced a result.

---

## Active Deploy Observation (only on MERGE: GO)

After `gh pr merge` returns success, watch the deploy through to a live healthy state rather than handing the whole job to the user. The skill is not done until either (a) the deploy is Ready **and** an initial log scan shows no immediate errors, or (b) observation cannot be performed and the user has been told so explicitly.

### Step 4a - Use the resolved deploy configuration

Platform detection and the exact status/log commands were already resolved in **Pre-flight Step 0a** from the `## Deploy Configuration` block (`/inc:setup-deploy`). Do not re-detect here.

- If pre-flight set `OBSERVATION_READY=1` → you already have `$PLATFORM`, the production URL, and the persisted **deploy-status**, **wait-for-Ready**, and **early-log-scan** commands. Use them verbatim in Steps 4b–4c. CLI auth doesn't change between pre-flight and post-merge, so no re-probe.
- If pre-flight set `OBSERVATION_READY=skip` → **skip observation.** Print exactly `Observation: skipped - <reason>` (the reason recorded in pre-flight, e.g. "no deploy configuration; user declined /inc:setup-deploy", "vercel CLI not installed", "gcloud not authed"). Without a platform/health command there's nothing to auto-watch, so fall through to the "Still the user's" reminder in Step 4f and hand the dashboards to the user. Do not guess at commands.

If a needed detail (service name, region, site ID, deploy URL) isn't in the persisted block or obvious from config files, ask the user once before polling - or re-run `/inc:setup-deploy` to capture it.

### Step 4b - Wait for the deployment to finish

Watch the deploy triggered by this merge until it reaches a terminal state. Identify the right deployment by **newest deploy from this merge** - the persisted command already encodes how (e.g. newest `createdAt` + `target==production` for Vercel) - not a stale previous one.

**Use the `Monitor` tool, not a foreground or `run_in_background` Bash call.** A Bash tool call is capped at 10 minutes by the harness - too short for many deploys. The `Monitor` tool runs the poll script *outside* that cap (`timeout_ms` up to **3,600,000 = 60 min**, or `persistent: true` for no limit) and turns each stdout line into a heartbeat notification - so you get mid-run progress without spamming, and long builds run to completion. Run **one Monitor per deploy** (in the multi-deploy case: backend service + frontend apps from the same merge) so each lands independently and a slow one can't delay the others.

Use the **wait-for-Ready** command persisted in the Deploy Configuration block as the probe (parse-safe, version-correct, verified by `/inc:setup-deploy`). The loop is platform-agnostic - it emits a heartbeat on state change or every ~90s, and exits the moment it has a terminal result:

```bash
# Run via Monitor(timeout_ms=900000, persistent=false) - 15 min; raise toward
# 3600000 (60 min) for slow builds, or persistent:true + TaskStop on terminal.
# Each echoed line is one heartbeat notification; the loop exits on Ready/Failed.
LAST=""; LAST_BEAT=$(date +%s); UNKNOWN=0; EMPTY=0
while true; do
  STATE=$(<persisted deploy-status command for THIS deploy>)
  NOW=$(date +%s)
  case "$STATE" in
    READY|ready|SUCCESS|succeeded|True) echo "RESULT=ready state=$STATE";  exit 0 ;;
    ERROR|error|FAILED|CRASHED|failed)  echo "RESULT=failed state=$STATE"; exit 1 ;;
    "") EMPTY=$(( EMPTY + 1 ))    # empty stdout - transient hiccup, or the CLI erroring to stderr (e.g. auth lapsed)
        if [ "$EMPTY" -ge 8 ]; then echo "RESULT=probe-error (empty output for ~2m - run the probe in foreground to see the real error)"; exit 3; fi ;;
    QUEUED|BUILDING|DEPLOYING|INITIALIZING|PENDING|queued|building|deploying|pending) UNKNOWN=0; EMPTY=0 ;;
    *) UNKNOWN=$(( UNKNOWN + 1 )); EMPTY=0    # non-empty but unrecognized - probe may be broken (wrong CLI/format)
       if [ "$UNKNOWN" -ge 4 ]; then echo "RESULT=parse-error raw=$STATE"; exit 3; fi ;;
  esac
  # Heartbeat: on state change or every ~90s, nothing in between.
  if [ "$STATE" != "$LAST" ] || [ $(( NOW - LAST_BEAT )) -ge 90 ]; then
    echo "[$(date +%H:%M:%S)] state=$STATE"; LAST="$STATE"; LAST_BEAT=$NOW
  fi
  sleep 15
done
```

Set `Monitor`'s `timeout_ms` to the deploy window you expect (default 15 min; raise up to 60 min for known-slow builds). Exit codes: `0` ready, `1` failed, `3` parse-error/probe-error. The parse-guard matters: a probe returning output the loop doesn't recognize (wrong CLI version, changed format) must fail loudly after ~1 minute - `RESULT=parse-error` - not spin silently while the deploy quietly succeeds underneath it.

Branch on the result:

- `RESULT=ready` / `RESULT=failed` → the Outcomes below.
- **Monitor hits `timeout_ms`** with no terminal line → not done yet. Re-arm with a longer window or hand off to manual monitoring. Do not declare success.
- `RESULT=parse-error` / `RESULT=probe-error` → **stop watching that deploy** and run the probe once in the foreground to see the real output. **If it's an auth error** ("not logged in", "unauthorized", 401, token expired - auth can lapse mid-watch even though pre-flight passed), print the `Reauth` command from the Deploy Configuration block (or the platform default, e.g. `vercel login`) for the **user** to run themselves - never run `login` for them; suggest `! <command>` - and re-arm the watch once they confirm. Otherwise fix the Deploy Configuration command against the installed CLI (re-run `/inc:setup-deploy`), or fall back to the health-check URL (`curl -s -o /dev/null -w '%{http_code}'`) to at least confirm the app serves. Don't re-arm a probe you know is misparsing.

If the persisted block instead gives a **blocking** command (`vercel inspect <url> --wait`, `gh run watch <id> --exit-status`), it produces no intermediate output - no heartbeats - so it only suits a fast deploy you don't need progress on. Run it under Monitor and set its own timeout to the full window (e.g. `--wait --timeout 15m`), not a sub-10-min value. Prefer the poll loop above when you want heartbeats.

**Narration:** one acknowledgment when the watch arms (`Deploy building - watching <id> for Ready (≤15m).`), then let the Monitor heartbeats carry progress (state changes + ~90s ticks). Speak up yourself only when a deploy reaches a terminal state. For multiple deploys, one Monitor each; report each as its line lands.

**Outcomes:**

- **Ready** → first, print the deploy-live checkpoint **before** anything else (no preceding prose, no other tool calls between the poll exit and this line - it must be the first thing the user sees once Ready is detected):

  > ```
  > ✅ DEPLOY LIVE - <platform> <service> reached Ready in <Nm Ns>. Commit <short-sha> is now serving traffic.
  >    Entering post-deploy monitoring (3-min log scan, then 10-min manual watch handoff)…
  > ```

  Substitute the real platform name, service/app/site identifier, elapsed wall time from the poll, and the short SHA from `git rev-parse --short HEAD` (or the SHA `gh pr merge` printed). Then proceed to Step 4c.

  For the multi-deploy case (more than one deploy in flight from the same merge - e.g., a backend service + one or more frontend apps), emit a single **aggregate** checkpoint above the deploy table in Step 4d instead of one banner per deploy:

  > ```
  > ✅ ALL DEPLOYS LIVE (N/N Ready in <Nm Ns>) - entering post-deploy monitoring…
  > ```

  If some Ready and some Failed/Timed-out, use a partial banner: `⚠️ PARTIAL: <X>/<N> Ready, <Y> Failed, <Z> Timed out - entering monitoring for the Ready ones.`

- **Failed** - stop. Report the platform-reported failure verbatim. Do not proceed to log scanning - the new code isn't running. Print:

  > ```
  > ❌ DEPLOY FAILED - <platform> <service> reported <status> after <Nm Ns>. New code is NOT live.
  > ```

  Then: "Investigate via `<platform dashboard or CLI log command>`. The merged commit is on `main` - decide whether to roll forward with a fix or revert."
- **Timed out after 15 min** - do not declare success. Print `⏱ DEPLOY TIMED OUT - still <state> after 15m. Cannot confirm whether new code is live.` and `Observation: timed out - deploy still <state> after 15m`. Ask the user whether to keep polling or hand off to manual monitoring.

### Step 4c - Post-deploy monitoring (3-min log scan)

This phase starts *after* the ✅ DEPLOY LIVE checkpoint from Step 4b. The app is up; we are now watching for early-burn errors in its first 3 minutes of real traffic. This is a **first-pass smoke check**, not a substitute for real monitoring. Run the **early-log-scan** command persisted in the Deploy Configuration block (`/inc:setup-deploy` records the correct, version-correct log command per platform), then scan its output for error signals.

Pipe through `grep -E` for:

- HTTP 5xx: `\b5[0-9]{2}\b` next to `status`, `statusCode`, `"status":`, or similar
- Exceptions: `UnhandledPromiseRejection`, `Uncaught`, `FATAL`, `panic:`, `Traceback`, `Exception in thread`
- Platform crashes: Cloud Run `container failed to start`, Fly `OOM killed` / `exit code`, Vercel `Function invocation failed`

Outcomes:

- **No matches** → first print the monitoring-clean checkpoint, then the report line:

  > ```
  > ✅ POST-DEPLOY MONITORING CLEAN - no error signals in the first 3 minutes.
  > ```

  Then: `Observation: deploy Ready, no error signal in first 3m`.

- **Matches found** → first print the monitoring-hit checkpoint, then the detail block:

  > ```
  > ⚠️ POST-DEPLOY MONITORING DETECTED <N> SIGNAL(S) - review below. Decide whether to roll back.
  > ```
  >
  > **Post-deploy signal detected:** `<n>` matching lines in the first 3 min.
  > ```
  > <up to 3 representative lines, trimmed>
  > ```
  > Review immediately. If this looks live-critical, roll back - do not debug in production.

  The skill does not auto-rollback. Surface the signal and stop; the user decides.

### Step 4d - Record the observation in the merge-pr report

**Single deploy** - append to the `=== MERGE-PR REPORT ===` block:

```
Deploy observation:
  Platform:     <vercel | netlify | fly | railway | gcloud-run | github-actions | skipped>
  Status:       <Ready | Failed | Timed out | Skipped>
  Deploy time:  <Nm Ns>
  Error signal: <none | N matches - see above | n/a>
```

**Multiple deploys** (e.g., a backend service on Cloud Run plus one or more Vercel apps from the same merge) - render a markdown table with one row per deploy. Columns: **Deploy**, **Status**, **Note**. Status uses an emoji + word (`✅ Ready`, `❌ Failed`, `⏳ Pending`, `⏱ Timed out`, `⏭ Skipped`). The Note column is optional per row - use it for things like deploy time, smoke-check signal, log-scan result, or the platform-reported reason for a failure. Leave Note as `-` when there's nothing useful to add. Example:

```
| Deploy        | Status      | Note                                                           |
|---------------|-------------|----------------------------------------------------------------|
| tenfold-api   | ✅ Ready (2m) | /v1 returns 401 (app up), /editorial/hero-slides/preview registered. Log scan clean. |
| tenfold-web   | ⏳ Pending  | -                                                              |
| tenfold-admin | ⏳ Pending  | -                                                              |
```

### Step 4e - Interim status updates during the poll

Progress comes from the **Monitor heartbeats** (4b): the poll loop emits a line on each state change and every ~90s, and each line arrives as its own notification - so the user sees "still building" cadence without you narrating every 15s tick. Let those carry the mid-run story; you speak up only when a deploy reaches a terminal state (or a deploy fails / the Monitor times out). Never emit a wall of identical "still building" lines yourself, and in the multi-deploy case render the 4d table as each deploy's line lands rather than prose like "api is up, waiting on the two frontends."

When a job exits and **more than one deploy is in flight**, render the update with the table format from 4d - one row per deploy, showing landed results (`✅ Ready`, `❌ Failed`) alongside still-pending rows (`⏳ Pending`) - rather than prose like "tenfold-api is up, still waiting on the two Vercel deploys". The table keeps the "where is each thing" model consistent across first update, transitions, and the final report. For a **single** deploy, the start acknowledgment plus the Ready/Failed checkpoint is enough - no interim table.

---

## Step 4f - Automated post-deploy watch (first ~10 min, only on MERGE: GO)

The 3-min scan (4c) is a snapshot. **Don't hand the next ten minutes to the user - watch it automatically.** Launch a `Monitor` (`timeout_ms: 600000` = 10 min) that, every ~30s, hits the health URL and re-scans error logs, and emits a line **only when something looks wrong** (non-2xx/3xx health, or a new error/crash signal that wasn't already present at deploy time). Each emitted line is a notification; on a real signal, also send a `PushNotification` so it reaches the user's phone. Silence = healthy; a final all-clear line closes the watch.

Open with the handoff checkpoint so the boundary is clear:

> ```
> ✅ DEPLOY LIVE - now auto-watching health + error logs for ~10 min. I'll ping you only if something goes red.
> ```

Use the persisted **health-check URL** and **error-log** commands from the Deploy Configuration block. The watch baselines existing errors first, so it only alerts on signals that appear *after* the deploy:

```bash
# Run via Monitor(timeout_ms=600000, persistent=false). Quiet unless something's wrong.
HEALTH_URL="<persisted health-check URL>"
SEEN=$(mktemp); DEADLINE=$(( $(date +%s) + 600 )); BEAT=$(date +%s)
# Baseline: record errors already in the window so only NEW ones alert.
# (dedup on the raw line via grep -Fxq - collision-free and portable; no cksum/sha hashing)
<persisted error-log command> 2>/dev/null | while IFS= read -r ln; do
  printf '%s\n' "$ln" >> "$SEEN"; done
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null || echo 000)
  case "$CODE" in 2??|3??) ;; *) echo "🚨 HEALTH $CODE  $HEALTH_URL  $(date +%H:%M:%S)" ;; esac
  <persisted error-log command> 2>/dev/null | while IFS= read -r ln; do
    grep -Fxq -- "$ln" "$SEEN" 2>/dev/null || { printf '%s\n' "$ln" >> "$SEEN"; printf '🚨 LOG %s: %s\n' "$(date +%H:%M:%S)" "$ln"; }
  done
  NOW=$(date +%s); [ $(( NOW - BEAT )) -ge 300 ] && { echo "· watch alive $(date +%H:%M:%S) - health $CODE"; BEAT=$NOW; }
  sleep 30
done
echo "✅ POSTDEPLOY_CLEAN - 10 min elapsed, no health failures or new error logs"; rm -f "$SEEN"
```

The error-log command **must be bounded and non-streaming** (e.g. `vercel logs … --limit N`, never `--follow` / `tail -f`): the baseline scan runs synchronously before the first health poll, so a command that blocks waiting for more output would hang the entire 10-minute watch before it ever checks health. The commands `/inc:setup-deploy` persists are already bounded. If the platform has no clean machine-readable error-log command (e.g. Railway's text logs), drop the log block and run the health poll alone - health going non-200 is the highest-signal check regardless.

Outcomes:
- **A `🚨` line lands** → surface it immediately, send a `PushNotification` (`Post-deploy alert: <health code | error signal>`), and tell the user: "App went red in the post-deploy window - roll back rather than debug live." The skill does **not** auto-rollback.
- **`✅ POSTDEPLOY_CLEAN`** → record `Post-deploy watch: clean (10m - health + logs)` in the report and close out.
- **Monitor hits `timeout_ms` with no clean line** → the watch was cut short; note it and offer to re-arm.

**Still the user's (the CLI can't see it):** error dashboards behind auth (Sentry / Datadog / Rollbar) and business metrics. A glance there is still worth it - but health and runtime error logs are now covered automatically, not handed off.

---

## What This Skill Does NOT Do

- Does not run the deploy. Merging the PR triggers whatever pipeline is wired to the target branch.
- Does not detect the platform or carry per-platform commands. That knowledge lives in `/inc:setup-deploy`, which persists it to the `## Deploy Configuration` block in `deploy.md` (pointer in `CLAUDE.md`) that this skill reads. If that block is missing, pre-flight prompts to run `/inc:setup-deploy`.
- Does not resolve review threads on the user's behalf. Reviewer comments (human or AI) must be addressed before the skill will let the PR merge.
- Does not replace code review or CI. Assume those already passed.
- Does not force-merge. If branch protection, required checks, or conflicts block `gh pr merge`, the skill surfaces the error and stops.
- Does not auto-rollback. If the deploy fails or the log scan surfaces errors, the skill reports the signal and stops - rollback/roll-forward is the user's call.
- Does not replace real monitoring. The 3-minute log scan is a smoke check; errors dashboards and runtime metrics are still the user's to watch.
