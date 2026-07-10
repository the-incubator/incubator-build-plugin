---
name: inc:setup-feedback
description: Use when the user wants to wire the incubator preview-feedback client into an app so external reviewers can annotate a deployed preview and the feedback lands in the incubator app. Triggers on "setup feedback", "set up the feedback tool", "install the preview feedback client", "wire up preview feedback", "add the review annotation tool", "mint a feedback token", or "/inc:setup-feedback". Mints a scoped feedback token, runs the installer into the target app, mounts <PreviewFeedbackMount /> at the app root, keeps the enable flag off locally, and confirms the app still builds.
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion, Bash(node *), Bash(curl *), Bash(jq *), Bash(cat *), Bash(ls *), Bash(test *), Bash(pnpm *), Bash(npm *), Bash(yarn *), Bash(mktemp *), Bash(grep *)
argument-hint: "[optional: project slug, e.g. 'my-app-preview']"
---

# Setup Feedback — Wire the Preview-Feedback Client into an App

Install the incubator preview-feedback client into a **target app** so external reviewers (a client, a designer, your team) can click-to-annotate a deployed preview and record a screen/voice walkthrough, with the structured feedback landing in the incubator app for Claude to act on.

This skill runs **from the target app's root** (the app being previewed), not from the plugin repo.
It mints a per-project token, runs the self-contained installer, mounts one component at the app root, and verifies the build.

**What it composes** (you don't need to know the internals, but for grounding):
[Agentation](https://github.com/benjitaylor/agentation) for click-to-annotate + [Riffrec](https://github.com/kieranklaassen/riffrec) for screen/voice recording, both mounted under one `<PreviewFeedbackMount />` wrapper that auto-picks **local** mode in dev (no token, no collector — just you + Claude) and **remote** mode when the preview enable flag is set (branded submit panel → collector).

**The token is a write-only, revocable, per-project credential** that ships inside the public preview bundle — deliberately *not* the plugin's telemetry key.
It is low-privilege, but still treat it like a secret in the session: mint and install in **one** shell step so the raw `fbk_…` never lands in the transcript (Step 3).

## User-invocable

When the user types `/inc:setup-feedback`, run this skill.
An optional argument is the project slug (e.g. `/inc:setup-feedback my-app-preview`) — use it to skip the slug prompt.

## Step 1 — Preflight the target app

Confirm you're in the app you want to instrument, and learn its shape.

```bash
# Must be run from the target app root.
test -f package.json && echo "APP_ROOT_OK" || echo "NO_PACKAGE_JSON — cd to the target app root or the wrong dir"
# Bundler hint (the installer auto-detects too; this is just for the mount step).
{ test -f vite.config.ts || test -f vite.config.js || grep -q '"vite"' package.json 2>/dev/null; } && echo "BUNDLER:vite"
{ test -f next.config.js || test -f next.config.ts || test -f next.config.mjs || grep -q '"next"' package.json 2>/dev/null; } && echo "BUNDLER:next"
node --version
```

- No `package.json` → tell the user to run this from the target app's root (or `cd` there) and stop.
- Neither Vite nor Next detected → the installer still runs (it assumes/forces a bundler via `--bundler`), but the mount step in Step 5 differs by bundler, so ask the user which framework the app uses before proceeding.

Check whether it's already installed (idempotent — don't double-mount):

```bash
ls src/preview-feedback/PreviewFeedbackMount.tsx app/preview-feedback/PreviewFeedbackMount.tsx 2>/dev/null && echo "ALREADY_INSTALLED"
grep -rl "PreviewFeedbackMount" src app 2>/dev/null | grep -v preview-feedback/ | head && echo "ALREADY_MOUNTED"
```

If already installed **and** mounted, skip to Step 6 (env + build check) — the run is likely re-verification or a re-mint, not a fresh install.

## Step 2 — Decide token parameters

You need three things for the mint:

- **project slug** — the argument if given; else default to `<app-dir-name>-preview` and confirm, or ask.
  Mint a **separate token per reviewer flow** (client vs designer) so they can be told apart and revoked independently.
- **label** — a human tag for who/what this token is for (e.g. `"BDGE client"`, `"design review"`). Default `"review"`.
- **days** — token lifetime. Default `90`.

If any are unclear and the argument didn't pin the slug, ask once with AskUserQuestion (slug, label, days) rather than guessing on all three.

Also settle the **collector URL** — the incubator app that receives the feedback.
Default: `https://incubator-build-app-web.vercel.app`.
Only change it if the user is pointing at a different incubator deployment.

## Step 3 — Mint token + run the installer (one shell step)

Do the mint and the install in a **single** Bash invocation so the raw token is captured into a shell variable and never printed to the transcript.
The installer writes it into `.env.local` itself — that's the only place it needs to live.

`inc-build` prints the bare `fbk_…` to **stdout** (metadata like project/expiry goes to stderr), so `TOKEN=$(…)` captures exactly the token.

```bash
set -euo pipefail
PROJECT="my-app-preview"          # from Step 2
LABEL="review"                    # from Step 2
DAYS="90"                         # from Step 2
COLLECTOR_URL="https://incubator-build-app-web.vercel.app"
RESULT="$(mktemp -t inc-feedback-result.XXXXXX.json)"

# 1) Mint — token to stdout, metadata to stderr. Never echo $TOKEN.
TOKEN="$(node "${CLAUDE_PLUGIN_ROOT}/scripts/inc-build.mjs" feedback mint-token \
  --project "$PROJECT" --label "$LABEL" --days "$DAYS")"

# 2) Fetch the self-contained installer (component sources embedded — no repo checkout needed).
INSTALLER="$(mktemp -t inc-feedback.XXXXXX.mjs)"
curl -fsSL "$COLLECTOR_URL/feedback-client.mjs" -o "$INSTALLER"

# 3) Install into the current app. --json puts the machine-readable result on stdout, human logs on stderr.
node "$INSTALLER" --dir . --json \
  --collector-url "$COLLECTOR_URL" \
  --token "$TOKEN" \
  --project "$PROJECT" \
  > "$RESULT"

echo "RESULT_FILE=$RESULT"
```

If the mint fails on auth (the plugin's org credentials at `~/.claude/incubator/credentials.json` are missing or expired), don't loop — print the exact manual command for the user to run and where creds come from, then stop:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/inc-build.mjs" feedback projects` (a read that also surfaces the auth error), and note the token can also be minted backend-side by someone with DB access.

## Step 4 — Read the installer result

The `--json` result is a single JSON object. Read the temp file and pull the fields you need for the mount:

```bash
jq '{ok, outDir, wrapperFile, mountExport, bundler, envFile, envPrefix, componentFiles}' "$RESULT"
```

Key fields:
- `outDir` — where the component set landed (default `src/preview-feedback/`).
- `wrapperFile` — the generated `…/PreviewFeedbackMount.tsx` you mount.
- `mountExport` — the export name (`PreviewFeedbackMount`).
- `bundler` — `vite` or `next` (drives the mount location in Step 5).
- `envPrefix` — `VITE_FEEDBACK_` or `NEXT_PUBLIC_FEEDBACK_` (the `…ENABLED` flag lives here).

If `ok` is not `true` or the file is empty, the install failed — surface the stderr from Step 3 and stop.

## Step 5 — Mount `<PreviewFeedbackMount />` once at the app root

Mount it exactly once, as a **sibling of the root app component**, importing from the `outDir` the installer reported.
The import path from a root file is `./preview-feedback/PreviewFeedbackMount`.

**Vite** — in `src/main.tsx` (or wherever the root `<App />` renders), render it next to `<App />`:

```tsx
import { PreviewFeedbackMount } from "./preview-feedback/PreviewFeedbackMount";
// ...
<>
  <App />
  <PreviewFeedbackMount />
</>
```

**Next (App Router)** — in `app/layout.tsx`, render it inside `<body>` as a sibling of `{children}`:

```tsx
import { PreviewFeedbackMount } from "./preview-feedback/PreviewFeedbackMount";
// ...
<body>
  {children}
  <PreviewFeedbackMount />
</body>
```

Read the actual root file first, then make a minimal Edit: add the import and drop the element in as a sibling.
If the root render is wrapped (providers, a single root element with no fragment), add the mount as a sibling **inside the outermost element** — don't introduce a new wrapper that changes layout.
If the correct root file is genuinely ambiguous, show the user the two-line snippet and ask where their root component mounts rather than guessing wrong.

## Step 6 — Env flag: off locally, on only in preview (never prod)

The installer appends the `*_FEEDBACK_*` vars to `.env.local` with `ENABLED=0`.
Leave it at `0` locally — in dev builds the **local** mode auto-appears regardless of the flag, so you still get click-to-annotate + Riffrec for your own inner loop without any token or collector.

Confirm the local flag is `0`:

```bash
grep -E "_FEEDBACK_ENABLED" .env.local
```

Then tell the user, explicitly:
- Set `<envPrefix>ENABLED=1` **only in the preview deployment's environment** (e.g. the preview Cloud Run / Vercel preview service) to turn on the remote submit panel for external reviewers.
- **Never** set it in production. In a prod build both the dev flag and ENABLED are statically `false`, so with Vite the panel and its deps are dropped from the bundle entirely; with Next the lazy chunk may be emitted but is never fetched.

## Step 7 — Confirm the app still builds

A mount that doesn't compile is worse than none. Build with the app's package manager (from the result's `packageManager`, or detect):

```bash
# pick the one that matches the project
pnpm build 2>&1 | tail -20   # or: npm run build / yarn build
```

If the build breaks:
- **Import-shape error on Agentation** — some versions export `Agentation` as default, not named; switch the import in `src/preview-feedback/PreviewFeedback.tsx` (this is a known caveat).
- **Type errors from `riffrec`/`agentation`** — the component casts via `vendor-types.ts`; if a version drifted, adjust the interface there.
- Fix forward and re-build; don't leave the app red.

## Step 8 — Summary

```
PREVIEW FEEDBACK — INSTALLED
────────────────────────────
Project slug:  <project>            (token label: <label>, expires in <days>d)
Collector:     <collector-url>
Component →    <outDir>/ (<n> files + PreviewFeedbackMount wrapper)
Mounted in:    <root file>  (<vite|next>)
Env flag:      <envPrefix>ENABLED=0 locally  → set =1 ONLY in the preview env, never prod
Build:         <passed | fixed <what>>

Reviewers annotate the deployed preview; read the feedback with:
  node <plugin>/scripts/inc-build.mjs feedback list --project <project>
  node <plugin>/scripts/inc-build.mjs feedback fetch <sessionId> --out ./feedback
```

## Rules

- **Never print the raw `fbk_…` token.** Mint and install in one shell step (Step 3) so it stays out of the transcript; its only home is `.env.local`.
- **One mount, at the root, as a sibling** of the root app component — never introduce a layout-changing wrapper, never mount it twice.
- **`ENABLED=0` locally, `=1` only in the preview env, never in production.** This is the safety-critical line.
- **Idempotent.** If it's already installed and mounted, don't re-copy or double-mount — re-verify env + build instead.
- **Run from the target app root**, not the plugin repo — the installer writes into the current directory.
- **Don't block on auth.** If the mint fails, print the manual mint path (self-serve CLI or backend) and stop cleanly rather than looping.
