---
name: inc:merge-pr-5
description: Use when the user says "ship it", "ship this PR", "ship pr", "deploy check", "ready to deploy", "merge and deploy", or is about to merge a PR that triggers a production deploy. Runs a pre-flight branch-freshness check, then three blocking gates (new env vars; PR health — not draft, CI green, no unresolved review threads including AI reviewer comments; deploy-window timing — risk-based decision outside Mon–Thu 1 PM EST). If all gates pass, squash-merges the PR into main, deletes the branch (local + remote), and checks out main. If any gate fails, the merge is blocked. After merge, actively observes the deploy via the detected platform's CLI (Vercel, Netlify, Fly.io, Railway, Google Cloud, GitHub Actions) and scans the first 3 minutes of logs for errors before completing.
allowed-tools: Read, Bash(git *), Bash(gh *), Bash(date *), Bash(TZ=* date *), Bash(./scripts/*), Bash(vercel *), Bash(netlify *), Bash(fly *), Bash(flyctl *), Bash(railway *), Bash(gcloud *), Bash(jq *), Bash(grep *), Bash(sleep *), Bash(curl *), Bash(mktemp), Glob, Grep, Skill, Monitor, PushNotification
---

# Merge PR: Production Deploy Readiness Check

Three gates every PR must pass before it merges into a branch that deploys to production. Any failure **blocks the merge**. Merging a red gate is a ship-stopping violation, not a warning.

**Plugin scripts:** Commands that use `<plugin root>` need the installed `incubator-build` plugin directory. In Claude Code, use `${CLAUDE_PLUGIN_ROOT}`. In Codex, resolve it from the loaded skill path: the plugin root is two directories above this `SKILL.md`.

Report each gate in order. At the end, print a single line: `MERGE: GO` or `MERGE: BLOCK — <reasons>`. On `MERGE: GO`, squash-merge the PR into `main` with `--delete-branch` (which also checks out `main` and removes the local feature branch), then **actively observe the deploy** (wait for Ready state, scan first-3-min logs for errors) before declaring the skill complete.

---

## Pre-flight: Branch freshness (path overlap)

Commit count is a noisy proxy for staleness — 50 commits on files this branch doesn't touch is harmless, while 2 commits on a file this branch rewrote can invalidate the entire diff. Check **path overlap** between what this PR branch changed and what has landed on `main` since they diverged. Overlap means CI went green against a version of the code the merge will no longer produce.

Run the shared freshness helper with `--pr-branch` so it fetches the PR branch from origin first (comparing against a stale local tip could produce a false "no overlap" when a teammate has pushed a rebase or the author pushed from another machine):

```bash
PR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
# Guard: merge-pr operates on a PR's feature branch. If you're on the default branch
# there's no PR to merge — freshness would compare main against main and pass silently.
DEFAULT_BRANCH=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's#^origin/##')
if [ "$PR_BRANCH" = "${DEFAULT_BRANCH:-main}" ]; then
  echo "PREFLIGHT_BLOCK: on default branch ($PR_BRANCH) — check out the PR's feature branch and re-run."
fi
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<plugin root>}"
OUT=$(bash "$PLUGIN_ROOT/scripts/branch-freshness" --pr-branch "$PR_BRANCH")
BEHIND=$(printf '%s\n' "$OUT" | sed -n 's/^BEHIND=//p')
OVERLAP=$(printf '%s\n' "$OUT" | sed -n 's/^OVERLAP=//p')
```

If `PREFLIGHT_BLOCK` is printed, **stop** — do not run the gates; tell the user to switch to the PR branch and re-run.

Act on `$OVERLAP` and `$BEHIND`:

- **No overlap, BEHIND == 0** — pre-flight OK. Proceed to Gate 1.
- **No overlap, BEHIND > 0** — pre-flight OK. Note "`$BEHIND` commits behind `main`, no path overlap" in the report and proceed to Gate 1.
- **Overlap is non-empty** — **block the merge**, regardless of `BEHIND`. List the overlapping paths so the user can see exactly where the collision is. If the user is on the PR branch locally, invoke the `inc:update-code` skill via the `Skill` tool (conflicts route to `git-merge-expert` automatically). After it returns cleanly, remind the user they must `git push` and wait for CI to re-run green before re-invoking `/inc:merge-pr-5`. Do not push or bypass CI from this skill. If they're not on the PR branch, tell them to switch and re-run.

**Success criteria:** No files changed on both the branch and on `main` since divergence — or the user has updated the branch and CI is re-running before re-invocation.

---

## Pre-flight: Deploy observation readiness

Resolve the deploy configuration and probe the read-only auth command **now**, before any gate runs. The point is to surface "I won't be able to observe the deploy" as a decision the user makes upfront — not as a frustrating denial after the merge has already happened. The harness sandbox can classify a CLI read (e.g., `railway whoami`, `vercel whoami`) as a "Production Reads" action and auto-deny without prompting; this step catches that early.

**Step 0a — Resolve the deploy configuration.** This skill does **not** carry platform-detection tables or per-platform command knowledge — that lives in `/inc:setup-deploy`, which persists it to a `## Deploy Configuration` block in **`deploy.md`** (with a one-line pointer in `CLAUDE.md`). Read that block, preferring deploy.md and falling back to a legacy block in CLAUDE.md:

```bash
grep -A 80 "## Deploy Configuration" deploy.md 2>/dev/null \
  || grep -A 80 "## Deploy Configuration" DEPLOY.md 2>/dev/null \
  || grep -A 80 "## Deploy Configuration" CLAUDE.md 2>/dev/null \
  || echo "NO_DEPLOY_CONFIG"
```

(`DEPLOY.md` is the legacy filename — redundant on macOS's case-insensitive filesystem, needed on Linux. `/inc:setup-deploy` migrates it to `deploy.md` on its next run.)

- **Block present** (in either file) → parse `Platform`, the `CLI auth check` command, the deploy-status / wait-for-Ready / early-log-scan commands, and the health-check URL. Record `$PLATFORM` and treat these persisted commands as the source of truth for the rest of the skill. Continue to Step 0b.
- **Block absent (`NO_DEPLOY_CONFIG`)** → setup-deploy has not been run. Ask via AskUserQuestion (do not silently skip):

  > **No deploy configuration found.** `/inc:setup-deploy` hasn't been run for this repo, so I have no parse-safe commands to watch the deploy with. How do you want to proceed?
  > 1. **Run `/inc:setup-deploy` now** (recommended) — I'll invoke it to detect the platform and persist the status/log commands, then continue the gates. *(It writes a `## Deploy Configuration` block to `deploy.md` plus a one-line pointer in `CLAUDE.md`; commit those separately.)*
  > 2. **Skip deploy observation** — run the gates and merge, but I won't wait for Ready or scan logs. You watch the dashboard yourself.
  > 3. **Abort** — don't run the gates.

  Resolve:
  - **Run setup-deploy** → invoke the `/inc:setup-deploy` skill via the Skill tool, then re-read the block (the grep above) and continue to Step 0b with the persisted config.
  - **Skip** → set `OBSERVATION_READY=skip` with reason "no deploy configuration; user declined /inc:setup-deploy", proceed to Gate 1.
  - **Abort** → stop the skill entirely.

**Step 0b — Probe the auth check.** Run the read-only `CLI auth check` command from the Deploy Configuration block (e.g. `vercel whoami`, `railway whoami`, `netlify status`, `fly auth whoami`, `gcloud auth list ...`, `gh auth status`). Three outcomes:

- **Probe succeeds** → `OBSERVATION_READY=1`. Note "`<platform>` CLI authed as `<account>`" in the report. Proceed to Gate 1.
- **CLI missing or unauthed** (non-zero exit, "command not found", "not logged in", token expired) → don't silently skip; this is usually fixable in seconds and observation is the skill's whole back half. Print the actual error **plus the fix command**: the `Reauth` line from the Deploy Configuration block, falling back to the platform default (`vercel login`, `netlify login`, `fly auth login`, `railway login`, `gcloud auth login`, `gh auth login`; for a missing CLI, the install command, e.g. `npm i -g vercel`). **Never run install/login yourself** — logins are interactive and the account choice is the user's. Suggest they run it as `! <command>` (runs inside this session so the auth lands here). Then ask (AskUserQuestion):
  1. **Fixed — re-probe** → re-run the auth check; on success set `OBSERVATION_READY=1` and proceed to Gate 1. If the CLI was **missing** (not just unauthed) and the user installed it, also re-run `/inc:setup-deploy` (via the Skill tool) before proceeding — the persisted commands were verified against a CLI version that wasn't this one, and flags drift between majors.
  2. **Skip observation** → `OBSERVATION_READY=skip` with the actual error recorded. Note in the report and proceed to Gate 1.
- **Probe denied by sandbox** (denial message mentioning "Production Reads", "permission for this action has been denied", or similar harness-level refusal that is *not* a CLI-level error) → **STOP. Do not proceed to gates.** Surface the choice:

  > **Pre-flight (deploy observation readiness):** Detected platform: `<platform>`. The sandbox blocked `<probe command>` (a read-only auth check) before it could run. Without permission for this command, post-merge observation will be unavailable — I won't be able to wait for Ready or scan logs.
  >
  > How would you like to proceed?
  > 1. **Grant permission** — I'll invoke the `update-config` skill to add `Bash(<platform> *)` (or a tighter rule like `Bash(<platform> status)`, `Bash(<platform> logs:*)`, `Bash(<platform> whoami)`) to project `.claude/settings.json` (or user `~/.claude/settings.json` if you prefer global). Then I'll re-probe and continue.
  > 2. **Accept observation skipped** — proceed with the gates and skip Active Deploy Observation. You'll watch the platform dashboard yourself.
  > 3. **Abort** — don't run the gates at all.

  Resolve based on the user's answer:
  - **Grant** → invoke `update-config`, re-probe, set `OBSERVATION_READY=1` if the retry succeeds.
  - **Accept skipped** → set `OBSERVATION_READY=skip` with reason "user accepted observation skipped", proceed to Gate 1.
  - **Abort** → stop the skill entirely.

**Why this lives in pre-flight, not post-merge:** the sandbox denial is a one-line message that doesn't survive post-merge well — by the time observation runs, the merge commit is on `main` and a Railway/Vercel deploy may already be picking it up. Deciding the permission posture before any irreversible action is the same shape as Gate 1 (env vars must exist before code runs).

---

## Gate 1: New Environment Variables

New `process.env.*` or `import.meta.env.*` references in the diff must already be configured in the project's deploy pipeline before merge. Frontend build-time vars (e.g., `VITE_*`) are typically baked in at build time and need to be set in the build config; backend runtime vars are set in the runtime environment. The specific files and surfaces are project-dependent — consult the project's deploy docs or `CLAUDE.md` for the exact location.

Run:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<plugin root>}"
bash "$PLUGIN_ROOT/skills/inc-merge-pr/scripts/check-env-vars.sh"
```

Parse output:

- `STATUS: pass` → **Gate 1 OK.**
- `STATUS: warn` (new vars found) → **Gate 1 BLOCK.** List each new var from `NEW_VARS:`. For each, tell the user:
  > **New env var `<VAR_NAME>`** — not configured in the deploy pipeline.
  > - If it's a build-time var (e.g., `VITE_*`): add it to the build config so it's baked into the bundle.
  > - Otherwise: add it to the runtime environment for the target deploy environment.
  >
  > Merge is blocked until this var is configured in the deploy pipeline.

  Then render the `PASTE_BLOCK:` section from the script output as a fenced **dotenv** code block so the user can one-click copy into the platform's bulk-add UI:

  > **Paste-ready** (works in Railway → *Variables → Raw Editor*, Vercel → *Settings → Environment Variables → Import .env*, Netlify → *Site config → Environment variables → Import from .env*, Render env groups, Fly `flyctl secrets import < paste.env`, Heroku via `cat | xargs heroku config:set`):
  >
  > ```dotenv
  > <verbatim PASTE_BLOCK lines from the script>
  > ```
  >
  > Lines with a value were pulled from your local `.env` — review before pasting (local creds may not be what prod should use). Lines ending with `=` are placeholders you'll need to fill in.

Do not proceed past this gate until the user confirms each new var is configured in the pipeline. "I'll add it after merge" is not acceptable — the var must exist when the new code runs.

**Coverage caveat.** The script only catches `process.env.*` and `import.meta.env.*` literal references in the diff. Indirect reads — `ConfigService.get('FOO')`, NestJS `@ConfigService`, `env('FOO')` helpers, dynamic lookups like `process.env[name]` — won't show up. When the diff touches such a wrapper or adds a key to a typed config schema, manually note any new keys in the gate-1 report and add them to the paste block before handing it to the user.

---

## Gate 2: PR Health Check

Four deterministic sub-checks, each a single command. No judgment calls — each command returns an unambiguous answer and Gate 2 passes only if all four are clean.

**API budget note.** `gh pr view --json …` and `gh repo view --json …` route through GitHub's GraphQL API, which has its own 5000/hr point budget separate from REST. When the GraphQL budget is exhausted (`X-RateLimit-Remaining: 0` on the GraphQL endpoint), every `gh pr` / `gh repo` call fails mid-gate. To keep Gate 2 working under GraphQL pressure, this skill uses **REST as the primary source** for everything except review-thread resolution state (which GraphQL is the only source for) — one REST call fetches all the PR metadata 2a and 2d need, leaving GraphQL for 2c only.

Set the shared variables once:

```bash
# Owner/repo from the git remote — zero API calls.
ORIGIN=$(git config --get remote.origin.url)
ORIGIN="${ORIGIN%.git}"
ORIGIN="${ORIGIN#git@github.com:}"
ORIGIN="${ORIGIN#https://github.com/}"
OWNER="${ORIGIN%%/*}"
REPO="${ORIGIN#*/}"
REPO="${REPO%%/*}"

# PR number via REST. Match open PRs by head ref WITHOUT the `head=$OWNER:` qualifier:
# that qualifier keys on the upstream owner and misses fork-based PRs (whose head owner
# is the fork user). Matching on .head.ref across all open PRs covers both same-repo and
# fork PRs. (REST keeps Gate 2 working when the GraphQL budget is exhausted — see note above.)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
PR_NUMBER=$(gh api "repos/$OWNER/$REPO/pulls?state=open&per_page=100" \
  -q "map(select(.head.ref==\"$BRANCH\")) | .[0].number")
if [ -z "$PR_NUMBER" ] || [ "$PR_NUMBER" = "null" ]; then
  echo "Gate 2 BLOCK: no open PR found for the current branch ($BRANCH). Check out the PR branch and re-run."
  exit 1
fi

# One REST call gives us isDraft, mergeable_state, head sha/ref — used by 2a and 2d.
PR_JSON=$(gh api "repos/$OWNER/$REPO/pulls/$PR_NUMBER")
IS_DRAFT=$(printf '%s' "$PR_JSON" | jq -r .draft)
MERGEABLE_STATE=$(printf '%s' "$PR_JSON" | jq -r .mergeable_state)
HEAD_SHA=$(printf '%s' "$PR_JSON" | jq -r .head.sha)
HEAD_REF=$(printf '%s' "$PR_JSON" | jq -r .head.ref)
```

### Step 2a — Draft status (0 extra calls)

Use the cached value — no second call needed:

```bash
echo "$IS_DRAFT"
```

- Output `false` → OK.
- Output `true` → **Gate 2 BLOCK: draft.** PR #`<N>` is still a draft. Mark it ready for review and re-run.

### Step 2b — CI status: pending or failure (1 REST call)

REST `check-runs` for the PR head SHA returns every check with a `status` (`queued` / `in_progress` / `completed`) and a `conclusion` (`success` / `failure` / `cancelled` / `timed_out` / `action_required` / `neutral` / `skipped` / null). Classify in jq so a missing conclusion-while-completed counts as failure too:

```bash
gh api "repos/$OWNER/$REPO/commits/$HEAD_SHA/check-runs?per_page=100" \
  | jq -r '
      (.check_runs // [])
      | (map(select(.status != "completed"))                                      | map(.name)) as $pending |
      (map(select(.status == "completed"
                  and (.conclusion == "failure"
                       or .conclusion == "timed_out"
                       or .conclusion == "action_required")))                     | map(.name)) as $fail |
      {failing: $fail, pending: $pending}'
```

`cancelled`, `neutral`, and `skipped` are ignored — same policy as before: a user-cancelled run is not a failure signal, and skipped checks (e.g., monorepo path filters) are no-ops. Required-status enforcement is still surfaced via `MERGEABLE_STATE=blocked` in 2d, so this gate doesn't have to second-guess branch protection.

- `failing` non-empty → **Gate 2 BLOCK: CI failing** — list names.
- `failing` empty, `pending` non-empty → **Gate 2 BLOCK: CI still running** — list names, tell the user to wait. Do not merge mid-CI.
- Both empty → OK.

### Step 2c — Unresolved review threads, including AI reviewers (cached thread state + REST bodies)

REST doesn't expose `isResolved` on review threads, so this sub-check needs the cached thread map from `scripts/gh-thread-cache`. That helper does at most one GraphQL call per (PR, head SHA) and caches the result on disk — repeated `/inc:merge-pr-5` runs on the same commit cost zero GraphQL points. When GraphQL is unavailable (quota exhausted, auth lapsed), the helper degrades gracefully and this sub-check falls back to a REST-only heuristic rather than blocking the user.

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<plugin root>}"
THREAD_CACHE="$PLUGIN_ROOT/scripts/gh-thread-cache"
THREAD_MAP_FILE=$(mktemp)
THREAD_MAP_RAW=$("$THREAD_CACHE" get "$OWNER" "$REPO" "$PR_NUMBER" 2>&1 1>"$THREAD_MAP_FILE") && THREAD_MAP_OK=1 || THREAD_MAP_OK=0
THREAD_MAP=$(cat "$THREAD_MAP_FILE" 2>/dev/null || echo "[]"); rm -f "$THREAD_MAP_FILE"
REVIEW_COMMENTS=$(gh api "repos/$OWNER/$REPO/pulls/$PR_NUMBER/comments" --paginate)
PR_AUTHOR=$(echo "$PR_JSON" | jq -r '.user.login')
```

**Primary path** — thread map available. Filter for unresolved + non-outdated, enrich snippet via REST:

```bash
jq -n \
  --argjson tm "$THREAD_MAP" \
  --argjson rc "$REVIEW_COMMENTS" '
  ($rc | map({key: .node_id, value: .}) | from_entries) as $by_node |
  (if ($tm | type) == "object" then $tm.threads else $tm end)
  | map(select(.isResolved == false and .isOutdated == false))
  | map({
      path,
      author: ((.comments[0].id // null) as $cid | $by_node[$cid].user.login // .comments[0].author // "unknown"),
      snippet: (((.comments[0].id // null) as $cid | $by_node[$cid].body // "")
                 | gsub("\\s+"; " ") | .[0:80]),
      is_ai: (((.comments[0].id // null) as $cid | $by_node[$cid].user.login // .comments[0].author // "")
                | test("^(greptile-apps|greptileai|coderabbitai|copilot-pull-request-reviewer|github-copilot|claude|anthropic|cursor|.+-ai|.+-review[^/]*)\\[bot\\]$"))
    })'
```

**Degraded path** — `THREAD_MAP_OK=0` means GraphQL is currently unavailable. Use a comment-author heuristic: an inline-comment chain is "likely unresolved" if the most recent comment in the chain is *not* from the PR author. This is best-effort; surface the limitation clearly:

```bash
jq -n \
  --argjson rc "$REVIEW_COMMENTS" \
  --arg author "$PR_AUTHOR" '
  # Group by root comment id (top-level comments where in_reply_to_id is null).
  ($rc | map(select(.in_reply_to_id == null))) as $roots |
  $roots | map(. as $root |
    ([$root] + ($rc | map(select(.in_reply_to_id == $root.id))))
    | sort_by(.created_at) | last as $latest |
    {root: $root, latest: $latest})
  | map(select(.latest.user.login != $author))
  | map({
      path: .root.path,
      author: .latest.user.login,
      snippet: (.latest.body | gsub("\\s+"; " ") | .[0:80]),
      is_ai: (.latest.user.login | test("^(greptile-apps|greptileai|coderabbitai|copilot-pull-request-reviewer|github-copilot|claude|anthropic|cursor|.+-ai|.+-review[^/]*)\\[bot\\]$"))
    })'
```

When the degraded path runs, surface this banner before the result:

> ⚠️ **Thread-resolution state unavailable** (GraphQL quota/auth). Falling back to "latest commenter isn't PR author" heuristic. To restore precise state, run:
> `gh-thread-cache get $OWNER $REPO $PR_NUMBER` after quota resets, then re-run `/inc:merge-pr-5`.

Rules on the resulting array (either path):

- Length `0` → OK. No outstanding threads (human or AI).
- Length `> 0` → **Gate 2 BLOCK.** Print up to 5 rows formatted as `<path> — <author>: <snippet>`, and **mark AI threads explicitly** (prefix with `🤖 AI:` or similar) so they're impossible to miss:

  > **Gate 2 BLOCK.** `<N>` unresolved review thread(s) (`<M>` from AI reviewers):
  > - 🤖 AI `<path>` — `greptile-apps[bot]`: `<snippet>`
  > - `<path>` — `<human-author>`: `<snippet>`
  > - …
  >
  > Address each (fix + reply, or explicitly resolve with a reason). AI threads count the same as human threads. Re-run after resolving.

The AI regex covers the common cases (Greptile, CodeRabbit, Copilot, Claude, Cursor) plus a fallback for any bot login ending in `-ai[bot]` or `-review*[bot]`. If the user has a custom AI reviewer bot, they can extend the pattern.

### Step 2d — Mergeable state (0 extra calls)

Use the cached value from `$PR_JSON`. REST's `mergeable_state` carries the same vocabulary as GraphQL's `mergeStateStatus`, just lowercased:

```bash
echo "$MERGEABLE_STATE"
```

- `clean` or `unstable` → OK. (`unstable` means a non-required check is red; the required ones are already covered by 2b.)
- `dirty` → **Gate 2 BLOCK: conflicts.** Invoke `inc:update-code` to rebase/merge `main` in, then push and re-run.
- `blocked` → **Gate 2 BLOCK: branch-protection rule unsatisfied.** The specific reason usually overlaps with 2a/2b/2c; if not, surface the raw status.
- `behind` → **Gate 2 BLOCK: branch behind target.** Update from `main` and re-run.
- `unknown` → re-fetch `$PR_JSON` once (GitHub computes mergeability lazily and may need a moment); if still `unknown`, surface the status and block.

### Pass condition

All four sub-checks return the OK path → **Gate 2 OK.** Each call is a single command, so the whole gate runs in well under 5 seconds on a normal PR.

---

## Gate 3: Deployment Window

The **full deploy window** is Mon–Thu after 1:00 PM Eastern — the team is around to respond if something breaks. Outside that window (Fri / Sat / Sun), Gate 3 is a **risk-based decision** rather than a hard block: critical hotfixes and clearly-minor low-risk changes may ship; major or risky releases wait for the next full window. Mon–Thu before 1 PM stays a hard block.

Check current EST time:

```bash
TZ='America/New_York' date +"%A %Y-%m-%d %H:%M %Z"
TZ='America/New_York' date +"%u %H"   # %u: 1=Mon..7=Sun, %H: 24-hour
```

Branch on the output (`DOW HOUR`):

| Window | Condition | Action |
|--------|-----------|--------|
| Full window | DOW 1–4 **and** HOUR >= 13 | **Gate 3 OK** — proceed. |
| Too early | DOW 1–4 **and** HOUR < 13 | **Gate 3 BLOCK** — too early. Explicit user override required to pass ("deploy anyway, this is a hotfix"); note the override in the ship report. |
| Off-hours | DOW 5, 6, or 7 | Run the off-hours decision branch below. |

### Off-hours decision branch (Fri / Sat / Sun)

Off-hours is a judgment call. The user makes the final decision; this skill's job is to surface the risk signals and give a **clear, direct recommendation** so the user isn't deciding blind.

**Step 3a — Collect risk signals from the diff.** Report which, if any, fired:

- **Env var signal** — Gate 1 reported new env vars.
- **Schema / migration signal** — the diff touches DB schema or migration files. Detect:

  ```bash
  git diff --name-only origin/main | grep -iE '(^|/)(schema|migrations?|drizzle|prisma)(/|\.|$)|\.sql$'
  ```

- **Data-backfill signal** — the diff references a backfill, seed, or one-time data job. Detect:

  ```bash
  git diff origin/main | grep -iE 'backfill|sync[_-]?job|seed|populate|one[-_ ]time|migration[_-]?script'
  ```

- **Large-diff signal** — run:

  ```bash
  git diff --stat origin/main | tail -1
  ```

  Flag if files changed ≥ 10 **or** insertions+deletions ≥ 300.

**Step 3b — Form a recommendation** based on signals:

- **No signals fired** → recommend **OK** if the change is a low-risk minor fix or a critical hotfix.
- **One or more signals fired** → recommend **BLOCK unless this is a critical hotfix** — the signals indicate the change carries real risk that the off-hours team would have to absorb.

**Step 3c — Present the decision to the user:**

> **Gate 3 (off-hours decision):** Current time: `<Sat 2026-04-25 11:14 EDT>`. We're outside the Mon–Thu 1 PM window.
>
> Signals observed: `<list signals, or "none">`.
>
> **Recommendation:** `<OK if change is minor/hotfix | BLOCK unless this is a critical hotfix — <which signals> indicate non-trivial risk>`.
>
> How should I classify this change?
> 1. **Critical hotfix** — production is broken / user-facing regression / security issue. State what is broken.
> 2. **Minor low-risk** — small scoped change that the team is comfortable shipping off-hours.
> 3. **Major or risky / unsure** — wait for the next full window.

Resolve based on the user's answer — **the user's call stands**, even if it overrides the recommendation:

- **"Critical hotfix"** with a stated reason → **Gate 3 OK (hotfix: `<reason>`).**
- **"Minor low-risk"** → **Gate 3 OK (minor).** If signals fired and the user picked this anyway, record "minor, user override despite `<signals>`" in the report.
- **"Major or risky / unsure"** → **Gate 3 BLOCK — off-hours, major/risky.** Compute the next Mon–Thu ≥ 1 PM slot from the current EST time and report it: "Wait until `<next valid window>`."

Record the chosen classification (and any override) verbatim in the final report so the call is auditable. Do not silently pass an off-hours deploy — always surface the recommendation and the user's classification.

---

## Final Report

After all three gates, print:

```
=== MERGE-PR REPORT ===
Pre-flight (freshness):  <OK | OK: N behind, no overlap | BLOCK: path overlap on <files>, update required>
Pre-flight (observation): <ready: <platform> as <account> | skip: <reason> | granted: rule added, re-probe ok>
Gate 1 (env vars):       <OK | BLOCK: ...>
Gate 2 (PR health):      <OK | BLOCK: draft | BLOCK: CI <failing|pending> — <checks> | BLOCK: <N> unresolved review thread(s) | BLOCK: merge state <status>>
Gate 3 (deploy window):  <OK | OK (hotfix: <reason>) | OK (minor [, user override despite <signals>]) | BLOCK — too early | BLOCK — off-hours, major/risky>

MERGE: <GO | BLOCK — gate(s) N, M>
```

If `MERGE: BLOCK`, stop. Do not merge. Do not suggest workarounds that skip a gate.

If `MERGE: GO`, squash-merge the PR into `main`. `$PR_NUMBER` was set in Gate 2's REST-based setup; reuse it rather than re-querying.

```bash
gh pr merge "$PR_NUMBER" --squash --delete-branch
```

`--delete-branch` removes the remote branch as part of the merge call and then, on the local side, checks out the repo's default branch, pulls, and deletes the local feature ref — so by the time this command returns successfully the working tree is on `main` (or whatever the repo's default branch is) with fresh upstream state. If the user has told you their repo convention is `--merge` or `--rebase`, use that strategy instead of `--squash`; `--delete-branch` rides along the same way.

After the merge returns success, confirm the working tree is on the default branch:

```bash
git branch --show-current
```

If this returns the default branch (the one resolved during pre-flight), continue to Active Deploy Observation. If it still returns the feature branch, `gh` couldn't finish the local cleanup — most commonly because the feature branch is checked out in another worktree. Tell the user explicitly ("merge succeeded, remote branch deleted, but local ref couldn't be removed — likely a worktree elsewhere") and do **not** try to force the checkout from this skill. Then continue to Active Deploy Observation from whatever branch you're on; the deploy poll doesn't depend on local branch state.

If `gh pr merge` fails, report the error verbatim, then branch on the cause:

- **Merge conflicts** — hand off to the `git-merge-expert` skill to resolve conflicts (update the branch from `main`, resolve, push), then re-run `/inc:merge-pr-5`. Do not resolve conflicts in this skill.
- **Required checks not green / branch protection / anything else** — stop. Do not retry, do not pass force flags.

After a successful merge, run **Active Deploy Observation** below — do not declare the skill complete until observation has produced a result.

---

## Active Deploy Observation (only on MERGE: GO)

After `gh pr merge` returns success, watch the deploy through to a live healthy state rather than handing the whole job to the user. The skill is not done until either (a) the deploy is Ready **and** an initial log scan shows no immediate errors, or (b) observation cannot be performed and the user has been told so explicitly.

### Step 4a — Use the resolved deploy configuration

Platform detection and the exact status/log commands were already resolved in **Pre-flight Step 0a** from the `## Deploy Configuration` block (`/inc:setup-deploy`). Do not re-detect here.

- If pre-flight set `OBSERVATION_READY=1` → you already have `$PLATFORM`, the production URL, and the persisted **deploy-status**, **wait-for-Ready**, and **early-log-scan** commands. Use them verbatim in Steps 4b–4c. CLI auth doesn't change between pre-flight and post-merge, so no re-probe.
- If pre-flight set `OBSERVATION_READY=skip` → **skip observation.** Print exactly `Observation: skipped — <reason>` (the reason recorded in pre-flight, e.g. "no deploy configuration; user declined /inc:setup-deploy", "vercel CLI not installed", "gcloud not authed"). Without a platform/health command there's nothing to auto-watch, so fall through to the "Still the user's" reminder in Step 4f and hand the dashboards to the user. Do not guess at commands.

If a needed detail (service name, region, site ID, deploy URL) isn't in the persisted block or obvious from config files, ask the user once before polling — or re-run `/inc:setup-deploy` to capture it.

### Step 4b — Wait for the deployment to finish

Watch the deploy triggered by this merge until it reaches a terminal state. Identify the right deployment by **newest deploy from this merge** — the persisted command already encodes how (e.g. newest `createdAt` + `target==production` for Vercel) — not a stale previous one.

**Use the `Monitor` tool, not a foreground or `run_in_background` Bash call.** A Bash tool call is capped at 10 minutes by the harness — too short for many deploys. The `Monitor` tool runs the poll script *outside* that cap (`timeout_ms` up to **3,600,000 = 60 min**, or `persistent: true` for no limit) and turns each stdout line into a heartbeat notification — so you get mid-run progress without spamming, and long builds run to completion. Run **one Monitor per deploy** (in the multi-deploy case: backend service + frontend apps from the same merge) so each lands independently and a slow one can't delay the others.

Use the **wait-for-Ready** command persisted in the Deploy Configuration block as the probe (parse-safe, version-correct, verified by `/inc:setup-deploy`). The loop is platform-agnostic — it emits a heartbeat on state change or every ~90s, and exits the moment it has a terminal result:

```bash
# Run via Monitor(timeout_ms=900000, persistent=false) — 15 min; raise toward
# 3600000 (60 min) for slow builds, or persistent:true + TaskStop on terminal.
# Each echoed line is one heartbeat notification; the loop exits on Ready/Failed.
LAST=""; LAST_BEAT=$(date +%s); UNKNOWN=0; EMPTY=0
while true; do
  STATE=$(<persisted deploy-status command for THIS deploy>)
  NOW=$(date +%s)
  case "$STATE" in
    READY|ready|SUCCESS|succeeded|True) echo "RESULT=ready state=$STATE";  exit 0 ;;
    ERROR|error|FAILED|CRASHED|failed)  echo "RESULT=failed state=$STATE"; exit 1 ;;
    "") EMPTY=$(( EMPTY + 1 ))    # empty stdout — transient hiccup, or the CLI erroring to stderr (e.g. auth lapsed)
        if [ "$EMPTY" -ge 8 ]; then echo "RESULT=probe-error (empty output for ~2m — run the probe in foreground to see the real error)"; exit 3; fi ;;
    QUEUED|BUILDING|DEPLOYING|INITIALIZING|PENDING|queued|building|deploying|pending) UNKNOWN=0; EMPTY=0 ;;
    *) UNKNOWN=$(( UNKNOWN + 1 )); EMPTY=0    # non-empty but unrecognized — probe may be broken (wrong CLI/format)
       if [ "$UNKNOWN" -ge 4 ]; then echo "RESULT=parse-error raw=$STATE"; exit 3; fi ;;
  esac
  # Heartbeat: on state change or every ~90s, nothing in between.
  if [ "$STATE" != "$LAST" ] || [ $(( NOW - LAST_BEAT )) -ge 90 ]; then
    echo "[$(date +%H:%M:%S)] state=$STATE"; LAST="$STATE"; LAST_BEAT=$NOW
  fi
  sleep 15
done
```

Set `Monitor`'s `timeout_ms` to the deploy window you expect (default 15 min; raise up to 60 min for known-slow builds). Exit codes: `0` ready, `1` failed, `3` parse-error/probe-error. The parse-guard matters: a probe returning output the loop doesn't recognize (wrong CLI version, changed format) must fail loudly after ~1 minute — `RESULT=parse-error` — not spin silently while the deploy quietly succeeds underneath it.

Branch on the result:

- `RESULT=ready` / `RESULT=failed` → the Outcomes below.
- **Monitor hits `timeout_ms`** with no terminal line → not done yet. Re-arm with a longer window or hand off to manual monitoring. Do not declare success.
- `RESULT=parse-error` / `RESULT=probe-error` → **stop watching that deploy** and run the probe once in the foreground to see the real output. **If it's an auth error** ("not logged in", "unauthorized", 401, token expired — auth can lapse mid-watch even though pre-flight passed), print the `Reauth` command from the Deploy Configuration block (or the platform default, e.g. `vercel login`) for the **user** to run themselves — never run `login` for them; suggest `! <command>` — and re-arm the watch once they confirm. Otherwise fix the Deploy Configuration command against the installed CLI (re-run `/inc:setup-deploy`), or fall back to the health-check URL (`curl -s -o /dev/null -w '%{http_code}'`) to at least confirm the app serves. Don't re-arm a probe you know is misparsing.

If the persisted block instead gives a **blocking** command (`vercel inspect <url> --wait`, `gh run watch <id> --exit-status`), it produces no intermediate output — no heartbeats — so it only suits a fast deploy you don't need progress on. Run it under Monitor and set its own timeout to the full window (e.g. `--wait --timeout 15m`), not a sub-10-min value. Prefer the poll loop above when you want heartbeats.

**Narration:** one acknowledgment when the watch arms (`Deploy building — watching <id> for Ready (≤15m).`), then let the Monitor heartbeats carry progress (state changes + ~90s ticks). Speak up yourself only when a deploy reaches a terminal state. For multiple deploys, one Monitor each; report each as its line lands.

**Outcomes:**

- **Ready** → first, print the deploy-live checkpoint **before** anything else (no preceding prose, no other tool calls between the poll exit and this line — it must be the first thing the user sees once Ready is detected):

  > ```
  > ✅ DEPLOY LIVE — <platform> <service> reached Ready in <Nm Ns>. Commit <short-sha> is now serving traffic.
  >    Entering post-deploy monitoring (3-min log scan, then 10-min manual watch handoff)…
  > ```

  Substitute the real platform name, service/app/site identifier, elapsed wall time from the poll, and the short SHA from `git rev-parse --short HEAD` (or the SHA `gh pr merge` printed). Then proceed to Step 4c.

  For the multi-deploy case (more than one deploy in flight from the same merge — e.g., a backend service + one or more frontend apps), emit a single **aggregate** checkpoint above the deploy table in Step 4d instead of one banner per deploy:

  > ```
  > ✅ ALL DEPLOYS LIVE (N/N Ready in <Nm Ns>) — entering post-deploy monitoring…
  > ```

  If some Ready and some Failed/Timed-out, use a partial banner: `⚠️ PARTIAL: <X>/<N> Ready, <Y> Failed, <Z> Timed out — entering monitoring for the Ready ones.`

- **Failed** — stop. Report the platform-reported failure verbatim. Do not proceed to log scanning — the new code isn't running. Print:

  > ```
  > ❌ DEPLOY FAILED — <platform> <service> reported <status> after <Nm Ns>. New code is NOT live.
  > ```

  Then: "Investigate via `<platform dashboard or CLI log command>`. The merged commit is on `main` — decide whether to roll forward with a fix or revert."
- **Timed out after 15 min** — do not declare success. Print `⏱ DEPLOY TIMED OUT — still <state> after 15m. Cannot confirm whether new code is live.` and `Observation: timed out — deploy still <state> after 15m`. Ask the user whether to keep polling or hand off to manual monitoring.

### Step 4c — Post-deploy monitoring (3-min log scan)

This phase starts *after* the ✅ DEPLOY LIVE checkpoint from Step 4b. The app is up; we are now watching for early-burn errors in its first 3 minutes of real traffic. This is a **first-pass smoke check**, not a substitute for real monitoring. Run the **early-log-scan** command persisted in the Deploy Configuration block (`/inc:setup-deploy` records the correct, version-correct log command per platform), then scan its output for error signals.

Pipe through `grep -E` for:

- HTTP 5xx: `\b5[0-9]{2}\b` next to `status`, `statusCode`, `"status":`, or similar
- Exceptions: `UnhandledPromiseRejection`, `Uncaught`, `FATAL`, `panic:`, `Traceback`, `Exception in thread`
- Platform crashes: Cloud Run `container failed to start`, Fly `OOM killed` / `exit code`, Vercel `Function invocation failed`

Outcomes:

- **No matches** → first print the monitoring-clean checkpoint, then the report line:

  > ```
  > ✅ POST-DEPLOY MONITORING CLEAN — no error signals in the first 3 minutes.
  > ```

  Then: `Observation: deploy Ready, no error signal in first 3m`.

- **Matches found** → first print the monitoring-hit checkpoint, then the detail block:

  > ```
  > ⚠️ POST-DEPLOY MONITORING DETECTED <N> SIGNAL(S) — review below. Decide whether to roll back.
  > ```
  >
  > **Post-deploy signal detected:** `<n>` matching lines in the first 3 min.
  > ```
  > <up to 3 representative lines, trimmed>
  > ```
  > Review immediately. If this looks live-critical, roll back — do not debug in production.

  The skill does not auto-rollback. Surface the signal and stop; the user decides.

### Step 4d — Record the observation in the ship report

**Single deploy** — append to the `=== MERGE-PR REPORT ===` block:

```
Deploy observation:
  Platform:     <vercel | netlify | fly | railway | gcloud-run | github-actions | skipped>
  Status:       <Ready | Failed | Timed out | Skipped>
  Deploy time:  <Nm Ns>
  Error signal: <none | N matches — see above | n/a>
```

**Multiple deploys** (e.g., a backend service on Cloud Run plus one or more Vercel apps from the same merge) — render a markdown table with one row per deploy. Columns: **Deploy**, **Status**, **Note**. Status uses an emoji + word (`✅ Ready`, `❌ Failed`, `⏳ Pending`, `⏱ Timed out`, `⏭ Skipped`). The Note column is optional per row — use it for things like deploy time, smoke-check signal, log-scan result, or the platform-reported reason for a failure. Leave Note as `—` when there's nothing useful to add. Example:

```
| Deploy        | Status      | Note                                                           |
|---------------|-------------|----------------------------------------------------------------|
| tenfold-api   | ✅ Ready (2m) | /v1 returns 401 (app up), /editorial/hero-slides/preview registered. Log scan clean. |
| tenfold-web   | ⏳ Pending  | —                                                              |
| tenfold-admin | ⏳ Pending  | —                                                              |
```

### Step 4e — Interim status updates during the poll

Progress comes from the **Monitor heartbeats** (4b): the poll loop emits a line on each state change and every ~90s, and each line arrives as its own notification — so the user sees "still building" cadence without you narrating every 15s tick. Let those carry the mid-run story; you speak up only when a deploy reaches a terminal state (or a deploy fails / the Monitor times out). Never emit a wall of identical "still building" lines yourself, and in the multi-deploy case render the 4d table as each deploy's line lands rather than prose like "api is up, waiting on the two frontends."

When a job exits and **more than one deploy is in flight**, render the update with the table format from 4d — one row per deploy, showing landed results (`✅ Ready`, `❌ Failed`) alongside still-pending rows (`⏳ Pending`) — rather than prose like "tenfold-api is up, still waiting on the two Vercel deploys". The table keeps the "where is each thing" model consistent across first update, transitions, and the final report. For a **single** deploy, the start acknowledgment plus the Ready/Failed checkpoint is enough — no interim table.

---

## Step 4f — Automated post-deploy watch (first ~10 min, only on MERGE: GO)

The 3-min scan (4c) is a snapshot. **Don't hand the next ten minutes to the user — watch it automatically.** Launch a `Monitor` (`timeout_ms: 600000` = 10 min) that, every ~30s, hits the health URL and re-scans error logs, and emits a line **only when something looks wrong** (non-2xx/3xx health, or a new error/crash signal that wasn't already present at deploy time). Each emitted line is a notification; on a real signal, also send a `PushNotification` so it reaches the user's phone. Silence = healthy; a final all-clear line closes the watch.

Open with the handoff checkpoint so the boundary is clear:

> ```
> ✅ DEPLOY LIVE — now auto-watching health + error logs for ~10 min. I'll ping you only if something goes red.
> ```

Use the persisted **health-check URL** and **error-log** commands from the Deploy Configuration block. The watch baselines existing errors first, so it only alerts on signals that appear *after* the deploy:

```bash
# Run via Monitor(timeout_ms=600000, persistent=false). Quiet unless something's wrong.
HEALTH_URL="<persisted health-check URL>"
SEEN=$(mktemp); DEADLINE=$(( $(date +%s) + 600 )); BEAT=$(date +%s)
# Baseline: record errors already in the window so only NEW ones alert.
# (dedup on the raw line via grep -Fxq — collision-free and portable; no cksum/sha hashing)
<persisted error-log command> 2>/dev/null | while IFS= read -r ln; do
  printf '%s\n' "$ln" >> "$SEEN"; done
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" 2>/dev/null || echo 000)
  case "$CODE" in 2??|3??) ;; *) echo "🚨 HEALTH $CODE  $HEALTH_URL  $(date +%H:%M:%S)" ;; esac
  <persisted error-log command> 2>/dev/null | while IFS= read -r ln; do
    grep -Fxq -- "$ln" "$SEEN" 2>/dev/null || { printf '%s\n' "$ln" >> "$SEEN"; printf '🚨 LOG %s: %s\n' "$(date +%H:%M:%S)" "$ln"; }
  done
  NOW=$(date +%s); [ $(( NOW - BEAT )) -ge 300 ] && { echo "· watch alive $(date +%H:%M:%S) — health $CODE"; BEAT=$NOW; }
  sleep 30
done
echo "✅ POSTDEPLOY_CLEAN — 10 min elapsed, no health failures or new error logs"; rm -f "$SEEN"
```

The error-log command **must be bounded and non-streaming** (e.g. `vercel logs … --limit N`, never `--follow` / `tail -f`): the baseline scan runs synchronously before the first health poll, so a command that blocks waiting for more output would hang the entire 10-minute watch before it ever checks health. The commands `/inc:setup-deploy` persists are already bounded. If the platform has no clean machine-readable error-log command (e.g. Railway's text logs), drop the log block and run the health poll alone — health going non-200 is the highest-signal check regardless.

Outcomes:
- **A `🚨` line lands** → surface it immediately, send a `PushNotification` (`Post-deploy alert: <health code | error signal>`), and tell the user: "App went red in the post-deploy window — roll back rather than debug live." The skill does **not** auto-rollback.
- **`✅ POSTDEPLOY_CLEAN`** → record `Post-deploy watch: clean (10m — health + logs)` in the report and close out.
- **Monitor hits `timeout_ms` with no clean line** → the watch was cut short; note it and offer to re-arm.

**Still the user's (the CLI can't see it):** error dashboards behind auth (Sentry / Datadog / Rollbar) and business metrics. A glance there is still worth it — but health and runtime error logs are now covered automatically, not handed off.

---

## What This Skill Does NOT Do

- Does not run the deploy. Merging the PR triggers whatever pipeline is wired to the target branch.
- Does not detect the platform or carry per-platform commands. That knowledge lives in `/inc:setup-deploy`, which persists it to the `## Deploy Configuration` block in `deploy.md` (pointer in `CLAUDE.md`) that this skill reads. If that block is missing, pre-flight prompts to run `/inc:setup-deploy`.
- Does not resolve review threads on the user's behalf. Reviewer comments (human or AI) must be addressed before the skill will let the PR merge.
- Does not replace code review or CI. Assume those already passed.
- Does not force-merge. If branch protection, required checks, or conflicts block `gh pr merge`, the skill surfaces the error and stops.
- Does not auto-rollback. If the deploy fails or the log scan surfaces errors, the skill reports the signal and stops — rollback/roll-forward is the user's call.
- Does not replace real monitoring. The 3-minute log scan is a smoke check; errors dashboards and runtime metrics are still the user's to watch.
