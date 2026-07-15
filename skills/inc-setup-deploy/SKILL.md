---
name: inc:setup-deploy
description: Use when the user wants to configure deployment so inc:merge-pr-5 / inc:ship-it can observe deploys automatically. Triggers on "setup deploy", "configure deployment", "set up deploy config", "how does merge-pr watch my deploy", "fix the deploy monitor", "set deploy window", "deployment window rules", or "/inc:setup-deploy". Detects the deploy platform (Vercel, Netlify, Fly.io, Railway, Render, Google Cloud Run, GitHub Actions, custom), resolves the production URL and a parse-safe deploy-status command, captures any deploy-window rules (when to allow merges/deploys; default is none = deploy anytime), and writes a Deploy Configuration block to deploy.md (with a one-line pointer in CLAUDE.md) that the merge/ship skills read.
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion, Bash(vercel *), Bash(netlify *), Bash(fly *), Bash(flyctl *), Bash(railway *), Bash(gcloud *), Bash(gh *), Bash(jq *), Bash(curl *), Bash(grep *), Bash(cat *), Bash(which *), Bash(test *)
argument-hint: "[optional: platform name to skip detection, e.g. 'vercel']"
---

# Setup Deploy — Persist Deploy Configuration for inc:merge-pr-5

Configure deployment once so `inc:merge-pr-5` (and `inc:ship-it`) can **observe the deploy
automatically** after a merge — wait for Ready, scan early logs — without re-detecting the
platform or guessing brittle status commands every time.

The output is a `## Deploy Configuration` block in **`deploy.md`** (repo root), plus a one-line
pointer in `CLAUDE.md` so any agent can find it. The full block lives in deploy.md — not CLAUDE.md —
so it isn't pre-loaded into every session; the deploy skills read it on demand. The merge/ship skills
look for deploy.md first and run the commands you persist here verbatim.

**Why this exists:** the post-merge deploy monitor breaks when it parses a CLI's *human* output
(column-aligned tables drop columns in a non-TTY pipe; ANSI color codes leak into values). The
fix is to persist **machine-readable** status commands (`--format json` / `--json` + `jq`) so
observation is deterministic. Getting the Vercel commands right is the headline case below.

## User-invocable

When the user types `/inc:setup-deploy`, run this skill. An optional argument names the platform
directly (e.g. `/inc:setup-deploy vercel`) — use it to skip detection.

## Step 1 — Check existing configuration

```bash
# Current home is deploy.md; also check legacy locations to migrate.
grep -A 30 "## Deploy Configuration" deploy.md 2>/dev/null || echo "NO_CONFIG_IN_DEPLOY_MD"
grep -A 30 "## Deploy Configuration" CLAUDE.md 2>/dev/null && echo "LEGACY_BLOCK_IN_CLAUDE_MD"
git ls-files | grep -qx "DEPLOY.md" && echo "LEGACY_DEPLOY_MD_FILENAME"
```

Migrate legacy locations:
- Block in `CLAUDE.md` → move it to `deploy.md`, replace it in CLAUDE.md with the one-line pointer
  (see Step 4), and tell the user you relocated it.
- File tracked as `DEPLOY.md` (old uppercase name; check `git ls-files`, not `[ -f ]` — macOS
  filesystems are case-insensitive and lie) → `git mv DEPLOY.md deploy.md` and update the CLAUDE.md
  pointer.

**If a block already exists, this run is usually about *this machine*, not the repo** — a teammate
onboarding onto a repo whose deploy.md is already committed. Before asking anything, verify the
local toolchain: run the block's `CLI auth check`. If the CLI is missing or unauthed, run the
install/login flow from the Step 3 preamble (print the commands, the user runs them, re-probe).
Then show the block and ask (AskUserQuestion):
- A) Config correct, machine verified — stop here *(the common onboarding outcome)*
- B) Reconfigure from scratch (overwrite) — *if the deploy setup itself changed*
- C) Edit one field (show current, change a single line)

If A, stop.

## Step 2 — Detect the platform

If the user passed a platform argument, skip to Step 3 for that platform.

Read deploy intent from docs first, then fall back to config-file heuristics. **Docs win** —
an explicit platform mention in `CLAUDE.md` / `README.md` / `DEPLOY*.md` overrides the files.

```bash
# Docs (read, don't just grep — a sentence like "deployed on Railway" is the answer)
for f in CLAUDE.md README.md deploy*.md DEPLOY*.md DEPLOYMENT*.md docs/deploy*; do
  [ -f "$f" ] && echo "DOC:$f"
done

# Config-file heuristics
{ [ -f vercel.json ] || [ -d .vercel ]; } && echo "PLATFORM:vercel"
{ [ -f netlify.toml ] || [ -d .netlify ]; } && echo "PLATFORM:netlify"
[ -f fly.toml ] && echo "PLATFORM:fly"
{ [ -f railway.toml ] || [ -f railway.json ] || [ -d .railway ]; } && echo "PLATFORM:railway"
[ -f render.yaml ] && echo "PLATFORM:render"
{ ls app.yaml cloudbuild.yaml cloudrun*.yaml service.yaml 2>/dev/null | grep -q . && [ -f Dockerfile ]; } && echo "PLATFORM:gcloud-run"
for f in $(find .github/workflows -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) 2>/dev/null); do
  grep -qiE "deploy|release|production|cd" "$f" && echo "DEPLOY_WORKFLOW:$f"
done
```

If multiple platforms match (e.g. a monorepo with a Vercel frontend + Railway backend), configure
each — the Deploy Configuration block supports more than one target.

If nothing matches, go to **Custom / Manual** in Step 3.

## Step 3 — Platform-specific setup

For every platform: confirm the CLI is installed and authed before relying on it. If either check
fails, don't silently fall back — print the exact fix commands and let the **user** run them.
**Never run an install or `login` yourself**: logins are interactive (browser/device-code flows)
and the account choice is the user's. Suggest they run the login as `! <command>` (the `!` prefix
runs it inside this session, so the auth lands here), then ask (AskUserQuestion):

- A) **I've run it — re-probe** → re-run the auth check and continue setup with the CLI.
- B) **Proceed without the CLI** → fall back to an HTTP health check on the production URL and
  note the CLI gap in the config so the merge skill prints `Observation: skipped — <reason>` cleanly.

| Platform | Install (macOS; otherwise see platform docs) | Authenticate |
|---|---|---|
| Vercel | `npm i -g vercel` | `vercel login` |
| Netlify | `npm i -g netlify-cli` | `netlify login` |
| Fly.io | `brew install flyctl` | `fly auth login` |
| Railway | `npm i -g @railway/cli` or `brew install railway` | `railway login` |
| Google Cloud | `brew install --cask google-cloud-sdk` | `gcloud init` (first-time: auth + default project); reauth later: `gcloud auth login` |
| GitHub Actions | `brew install gh` | `gh auth login` |

Persist the platform's login command as the `Reauth` line in the Deploy Configuration block
(Step 4) — that's what `inc:merge-pr-5` prints if auth has lapsed by ship time.

### Vercel (get this one right)

Vercel deploys automatically: preview on PR, production on merge to the production branch. The job
here is to persist a **stable production URL** and a **parse-safe status command**.

**CLI version matters.** These instructions target Vercel CLI v40+ (verify with `vercel --version`).
Flag names changed and older docs are wrong:

| Old (pre-v40, do NOT use) | Current |
|---|---|
| `vercel ls` | `vercel list` |
| `--prod` | `--environment production` |
| `--json` (on list/inspect) | `--format json` (alias `-F json`) |
| `vercel logs --since=3m` | `vercel logs <url> --json` (no `--since`; use `--limit` / `--level`) |

**Never parse the `vercel list` text table.** In a non-TTY pipe it drops the Status column and
leaks ANSI codes — this is the exact failure that makes the monitor report `state=unknown`. Always
use `--format json` and `jq`.

**Sharp edge — the state key differs by command:**
- `vercel list --format json` → each deployment has **`.state`** (`READY` / `BUILDING` / `ERROR` / `QUEUED` / `CANCELED`)
- `vercel inspect <url> --format json` → has **`.readyState`** (and `.state` is `null`)

Steps:

1. Confirm auth: `vercel whoami` (prints the account/scope, or errors if unauthed).
2. Identify the linked project: `cat .vercel/project.json` (`projectId`, `orgId`). If absent, the
   repo isn't linked — tell the user to run `vercel link` once, or proceed with health-check-only.
3. Resolve the newest production deployment and its **stable alias** (the clean domain, not the
   per-deploy `*-<hash>.vercel.app`):

   ```bash
   DEPLOY_URL=$(vercel list --environment production --format json \
     | jq -r 'if type=="array" then . else .deployments end | .[0].url')
   PROD_URL=$(vercel inspect "$DEPLOY_URL" --format json | jq -r '.aliases[0] // empty')
   echo "newest prod deploy: $DEPLOY_URL"
   echo "stable prod alias:  ${PROD_URL:-<none — likely a custom domain>}"
   ```

   `aliases[0]` is usually the cleanest domain (e.g. `tenfold-www.vercel.app`). If the project uses
   a custom domain, that may not appear here — **ask the user to confirm the production URL.**

4. Persist these exact commands (they are what `inc:merge-pr-5` will run):
   - **Newest prod deploy state** (for "is a new deploy in flight / done"):
     `vercel list --environment production --format json | jq -r 'if type=="array" then . else .deployments end | .[0].state'`
   - **Wait for a specific deploy to finish.** Preferred for the consumer is the **poll** form, because it emits per-tick state the merge skill turns into heartbeats:
     `vercel inspect <deploy-url> --format json | jq -r '.readyState'` (Ready signal: `READY`; failure: `ERROR`)
     The blocking form `vercel inspect <deploy-url> --wait --timeout 15m` also works but gives no progress until it returns. Set the timeout to the full deploy window (15m+), not a sub-10-min value — the consumer runs this under the `Monitor` tool, which is not bound by the foreground Bash 10-minute cap.
   - **Early-log scan** (first minutes after Ready):
     `vercel logs <deploy-url> --json --limit 200 | jq -r 'select(.level=="error" or .level=="fatal")'`
   - **Health check:** `curl -sf -o /dev/null -w "%{http_code}" https://<PROD_URL>` → expect `200`

   Identify the right deployment by **newest `createdAt`**, and double-check `.target=="production"`,
   so observation never latches onto a stale or preview deploy.

### Netlify

1. Auth: `netlify status`. Link: `.netlify/state.json` holds the site ID.
2. Newest deploy state: `netlify api listSiteDeploys --data '{"site_id":"<id>"}' | jq -r '.[0].state'` (Ready: `ready`; fail: `error`).
3. Health check: the production URL (`netlify api getSite --data '{"site_id":"<id>"}' | jq -r '.ssl_url'`).
4. Logs: `netlify logs:function` (functions) or the deploy log URL.

### Fly.io

1. Auth: `fly auth whoami`. App name: `grep -m1 '^app' fly.toml`.
2. Release state: `fly releases --json | jq -r '.[0].status'` (Ready: `succeeded`); health: `fly status --json | jq -r '.Status'` (`Deployed`).
3. URL: `https://<app>.fly.dev` (confirm — custom domains common). Health check that URL or its `/health`.
4. Logs: `fly logs --no-tail` then filter to the last few minutes by timestamp.

### Railway

1. Auth: `railway whoami`. 2. State: `railway status` is text — read the most recent deployment block (Ready: `SUCCESS`; fail: `FAILED`/`CRASHED`). If a JSON form is available in the installed CLI, prefer it. 3. URL: from `railway domain` or the dashboard — confirm with the user. 4. Logs: `railway logs --tail 500`.

### Render

1. Auto-deploys from the connected branch on push; usually no CLI needed. 2. URL: `https://<service>.onrender.com` (confirm). 3. Observation = poll the production URL until it serves the new version; persist the health-check URL. 4. Logs: the service's Logs tab in the dashboard (no first-class CLI tail).

### Google Cloud Run

1. Auth: `gcloud auth list --filter=status:ACTIVE --format='value(account)'`. 2. Ready: `gcloud run services describe <svc> --region=<r> --format='value(status.latestCreatedRevisionName,status.latestReadyRevisionName)'` — poll until both match, then check the `Ready` condition is `True`. 3. URL: `gcloud run services describe <svc> --region=<r> --format='value(status.url)'`. 4. Logs: `gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=<svc> AND severity>=ERROR' --limit=100 --freshness=3m --format=json`.

### GitHub Actions

1. Auth: `gh auth status`. 2. Read the deploy workflow to learn the target. 3. Observe: `gh run list --branch <prod-branch> --limit 1 --json databaseId,status,conclusion` then `gh run watch <id> --exit-status`. 4. Ask the user for the production URL for the health check. 5. Logs: `gh run view <id> --log` (covers the deploy-step logs only — not app runtime).

### Custom / Manual

Nothing detected. Use AskUserQuestion to gather: how deploys trigger (auto-on-push / GH Actions /
deploy script / manual / does-not-deploy), the production URL, and how to check success (HTTP health
check / CLI command / GH Actions status / just-load-the-URL). Persist whatever the user gives.

## Step 3.5 — Deploy window rules (when may deploys go out?)

Some teams restrict *when* a merge that triggers a production deploy is allowed — e.g. only during
staffed hours so someone can respond if it breaks, or a freeze over a holiday. `inc:merge-pr-5`
reads the rule you persist here and evaluates it against the current time before merging.

Ask the user (AskUserQuestion) — **the default is no restriction (deploy anytime)**:

- A) **No deploy-window rules — deploy anytime** *(default, recommended)* → persist `Deploy window: none`.
- B) **Yes, there's a window** → capture the rule in the user's own words as a single concise line,
  e.g. `Mon–Thu after 1pm ET, freeze Fri–Sun` or `business hours 9am–6pm PT weekdays; no deploys during the Dec 20–Jan 2 freeze`.

Keep whatever the user gives you to **one line** (the merge skill and the gates script read a single
`Deploy window:` field). If the user describes something multi-part, summarize it into one line that
still captures the days/hours/freezes — the merge skill interprets this text against the clock, so it
must be legible, not a code. If the user isn't sure, default to `none`.

Persist the answer as the `Deploy window:` line in the Deploy Configuration block (Step 4a).

## Step 4 — Write deploy.md and the CLAUDE.md pointer

Two writes:

**4a — `deploy.md` (repo root):** Read it (create if missing). Replace an existing `## Deploy
Configuration` section or append this at the end. Keep commands **copy-paste runnable** — the
merge/ship skills execute them verbatim. Use a fenced block per command so nothing gets reflowed.

```markdown
## Deploy Configuration (managed by /inc:setup-deploy)

- Platform: <vercel | netlify | fly | railway | render | gcloud-run | github-actions | custom>
- Production branch: <main>
- Production URL: <https://...>
- Deploy trigger: <auto on push to production branch | GH Actions <workflow> | <command>>
- CLI auth check: `<vercel whoami | netlify status | fly auth whoami | ...>`
- Reauth: `<login command the user runs themselves if auth lapses, e.g. vercel login | railway login | gcloud auth login>`
- Deploy window: <none | one-line rule, e.g. Mon–Thu after 1pm ET, freeze Fri–Sun>

> The `Deploy window:` line is policy, not a command. `none` (or an absent line) means no restriction —
> the merge skill just deploys. Any other text is the team's rule, which the merge skill evaluates
> against the current time before merging. Keep it to one legible line.

**Deploy status (newest production deploy):**
\`<status command — machine-readable, e.g. vercel list --environment production --format json | jq -r '...[0].state'>\`

**Wait for a specific deploy to reach Ready:**
\`<poll command preferred, e.g. vercel inspect <url> --format json | jq -r '.readyState'; or blocking vercel inspect <url> --wait --timeout 15m — Ready: READY, fail: ERROR>\`

**Early-log scan (errors in the first minutes):**
\`<logs command, e.g. vercel logs <url> --json --limit 200 | jq -r 'select(.level=="error")'>\`

**Health check:**
\`curl -sf -o /dev/null -w "%{http_code}" <PROD_URL>\`  → expect 200

> Status commands are machine-readable on purpose (JSON + jq). Do not switch to human/table
> output — it drops columns in non-TTY pipes and leaks ANSI codes, which is what makes the
> monitor report `state=unknown`.
```

If the project has more than one deploy target (monorepo), repeat the four command lines under a
`### <service name>` subheading for each.

**4b — `CLAUDE.md` pointer:** Read CLAUDE.md (create if missing). Ensure exactly one pointer line
exists so any agent can find the config without deploy.md being pre-loaded. If a pointer or a legacy
`## Deploy Configuration` block is already there, replace it with this single line; otherwise append:

```markdown
Deploy config: see deploy.md (managed by /inc:setup-deploy).
```

Keep the pointer to one line — the whole point is that CLAUDE.md stays lean and the heavy command
block lives in deploy.md.

## Step 5 — Verify what you persisted

Run the commands you just wrote and show real output — a config that looks right but doesn't run is
worse than none:

```bash
# status command
<status command> 2>&1 | head -3 || echo "STATUS_CMD_FAILED"
# health check
curl -sf -o /dev/null -w "%{http_code}\n" "<PROD_URL>" 2>/dev/null || echo "UNREACHABLE"
```

If the status command fails, fix it now (most often a stale flag — re-check the Vercel table above)
rather than persisting something broken. If the health check is merely unreachable (nothing deployed
yet), note it but keep the config — it's still correct for the next deploy.

## Step 6 — Summary

```
DEPLOY CONFIGURATION — SAVED to deploy.md (pointer in CLAUDE.md)
───────────────────────────────────────────────────────────────
Platform:      <platform>
Prod URL:      <url>
Status cmd:    <one-line status command>   [verified: ran, returned <state>]
Health check:  <url>  [<200 | unreachable>]
Deploy window: <none (deploy anytime) | the one-line rule>

inc:merge-pr-5 and inc:ship-it will now observe deploys with these commands
and respect the deploy window above.
Re-run /inc:setup-deploy to reconfigure.
```

## Rules

- **Never persist a human/table status command.** JSON + jq only. This is the whole point.
- **Never print full tokens or secrets.** Probe auth with the read-only `whoami`/`status` checks only.
- **deploy.md holds the config; CLAUDE.md holds only a one-line pointer.** Keeps CLAUDE.md lean so
  the command block isn't pre-loaded into every session.
- **Idempotent.** Re-running cleanly overwrites the prior block.
- **CLIs are optional.** If the platform CLI is missing/unauthed, persist a health-check-only config
  and say so — don't block.
- **Verify the exact flags against the installed CLI version.** Flags drift between major versions
  (the Vercel `--prod`/`--json` → `--environment`/`--format json` rename is the cautionary tale).
