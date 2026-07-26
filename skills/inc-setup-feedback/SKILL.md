---
name: inc:setup-feedback
description: Use when the user wants to wire or refresh the incubator preview-feedback client in an app so external reviewers can annotate a deployed preview and the feedback lands in the incubator app. Triggers on "setup feedback", "set up the feedback tool", "install the preview feedback client", "update the preview feedback client", "wire up preview feedback", "add the review annotation tool", "mint a feedback token", or "/inc:setup-feedback". Safely refreshes clean existing installs, mints a scoped feedback token for new installs, mounts <PreviewFeedbackMount /> at the app root, keeps the enable flag off locally, verifies the 8-minute recording safety contract, and confirms the app still builds.
allowed-tools: Read, Write, Edit, Grep, Glob, AskUserQuestion, Bash(node *), Bash(curl *), Bash(jq *), Bash(cat *), Bash(ls *), Bash(test *), Bash(pnpm *), Bash(npm *), Bash(yarn *), Bash(mktemp *), Bash(grep *), Bash(head *), Bash(tail *), Bash(echo *), Bash(set *), Bash(cp *), Bash(cmp *), Bash(rm *), Bash(find *), Bash(dirname *), Bash(git status *), Bash(git check-ignore *), Bash(git ls-files *), Bash(git grep *)
argument-hint: "[optional: project slug, e.g. 'my-app-preview']"
---

# Setup Feedback — Wire the Preview-Feedback Client into an App

Install the incubator preview-feedback client into a **target app** so external reviewers (a client, a designer, your team) can click-to-annotate a deployed preview and record a screen/voice walkthrough, with the structured feedback landing in the incubator app for Claude to act on.
On phones — where no browser can screen-record — the client records the walkthrough as a DOM event stream (rrweb) plus voice instead, and the analyzer renders it to video at analysis time; reviewers get the same record button either way.

This skill runs **from the target app's root** (the app being previewed), not from the plugin repo.
For a new install, it mints a per-project token, runs the self-contained installer, mounts one component at the app root, and verifies the build.
For an existing install, it safely refreshes the canonical client files without minting a replacement token or overwriting dirty customizations.

**Plugin scripts:** Commands that use `<plugin root>` need the installed `incubator-build` plugin directory.
In Claude Code, use `${CLAUDE_PLUGIN_ROOT}` (set automatically).
In Codex, resolve it from the loaded skill path: the plugin root is two directories above this `SKILL.md`.

**What it composes** (you don't need to know the internals, but for grounding):
[Agentation](https://github.com/benjitaylor/agentation) for click-to-annotate + [Riffrec](https://github.com/kieranklaassen/riffrec) for screen/voice recording on desktop + [rrweb](https://github.com/rrweb-io/rrweb) (with fflate) for the mobile DOM-recording path, all mounted under one `<PreviewFeedbackMount />` wrapper that auto-picks **local** mode in dev (no token, no collector — just you + Claude) and **remote** mode when the preview enable flag is set (branded submit panel → collector).

**Recording safety contract:** the installed client must make the 8-minute maximum explicit before recording, show elapsed and remaining time, warn for the final minute, call RiffRec's normal stop/save flow once at 8:00, and reject any riffrec result whose `filesPresent` omits `recording.webm` (mobile rrweb bundles carry no screen video by design — for those the required file is `rrweb-events.json`).
The reviewer’s annotations and any earlier valid staged walkthrough must survive a failed or rejected recording.

**Current RiffRec integration boundary:** npm's published RiffRec `2.1.1` downloads the ZIP itself and does not return its `Blob`, so the client currently captures that ZIP at the `URL.createObjectURL` boundary.
Upstream `main` has a newer direct-archive callback (`{ archive, filename, sessionId }`) and `download={false}` support, which can eventually remove that interception after it is published.
Do not wait for that release and do not treat it as the recording-size fix: upstream still excludes `recording.webm` above 50 MiB, so the duration cap and `filesPresent` rejection remain required.

**The token is a write-only, revocable, per-project credential** that ships inside the public preview bundle — deliberately *not* the plugin's telemetry key.
It is low-privilege, but still treat it like a secret in the session: mint and install in **one** shell step so the raw `fbk_…` never lands in the transcript (Step 3B).

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

Check whether it's already installed (idempotent — don't double-mount).
Search the **whole repo**, not a fixed list of roots — monorepo frontends live in paths like `apps/web/src/` or `packages/web/src/` too, and missing one would mint a second token and write a second `preview-feedback` tree the app never imports:

```bash
MOUNT_FILE=$(git ls-files -co --exclude-standard 2>/dev/null \
  | grep -E '(^|/)preview-feedback/PreviewFeedbackMount\.tsx$' | head -1)
[ -n "$MOUNT_FILE" ] && echo "ALREADY_INSTALLED at $MOUNT_FILE"
git grep -l "PreviewFeedbackMount" -- '*.tsx' '*.ts' '*.jsx' '*.js' 2>/dev/null | grep -v 'preview-feedback/' | grep -q . && echo "ALREADY_MOUNTED"
```

(In a non-git app, fall back to `find . -path ./node_modules -prune -o -name PreviewFeedbackMount.tsx -print` and `grep -rl` excluding `node_modules`.)

Resolve the frontend source root before installing:
- **existing install** → `OUT_DIR=$(dirname "$MOUNT_FILE")` — always operate on the tree the app actually imports, never a second copy elsewhere;
- new install, standard Vite/Next app with `src/` → `OUT_DIR=src/preview-feedback`;
- new install, monorepo/full-stack app whose browser client lives in `client/src/`, `apps/<app>/src/`, or `packages/<app>/src/` → that app's `…/src/preview-feedback`;
- new install, root-level Next app without `src/` → `OUT_DIR=preview-feedback`.

Inspect the actual app entry/layout before choosing.
Never accept the installer default if it would create a second feedback-client directory outside the real frontend source tree.

If already installed — **mounted or not** — treat it as an **existing install**: never let a fresh Step 3B run overwrite the existing client directory, and do not mint a new token just to update the client source.
(An interrupted earlier setup can leave the files installed but unmounted; that case must not fall through to a blind reinstall.)
First establish that the installed client is clean:

```bash
OUT_DIR="$(dirname "$MOUNT_FILE")"
git status --short -- "$OUT_DIR"
```

The routing decision is this check's result:

- Output empty **and** mounted → **route to Step 3A** (Step 5 is skipped later; the mount already exists).
- Output empty, **not** mounted → refresh via **Step 3A**, then continue through Step 5 to mount. Exception: if `.env.local` has no `…_FEEDBACK_COLLECTOR_URL` block at all (setup was interrupted before the mint), run **Step 2 + Step 3B** instead but with `--out-dir "$OUT_DIR"` pointed at the existing directory — the clean tree makes the overwrite safe, and 3B mints and writes the env block in the same pass.
- Output non-empty → stop before downloading into the target directory. Tell the user which feedback-client files are dirty and ask whether they want a careful merge. Never overwrite custom annotation layers, styling, wrappers, or other local changes.
- Not a git repo / cleanliness cannot be established → ask before overwriting an existing install.

## Step 2 — Decide token parameters (new installs only)

Skip this step for a clean existing-install refresh; its current env/token remains in place.

You need three things for the mint:

- **project slug** — the argument if given; else default to `<app-dir-name>-preview` and confirm, or ask.
  Mint a **separate token per reviewer flow** (client vs designer) so they can be told apart and revoked independently.
- **label** — a human tag for who/what this token is for (e.g. `"BDGE client"`, `"design review"`). Default `"review"`.
- **days** — token lifetime. Default `90`.

If any are unclear and the argument didn't pin the slug, ask once with AskUserQuestion (slug, label, days) rather than guessing on all three.

Also settle the **collector URL** — the incubator app that receives the feedback.
Default: `https://incubator-build-app-web.vercel.app`.
Only change it if the user is pointing at a different incubator deployment.

## Step 3A — Refresh a clean existing install without rotating its token

Use this path only when Step 1 found an existing install (mounted, or unmounted with the feedback env block present) and `git status --short -- "$OUT_DIR"` was empty.
The installer appends its env block only when the file has no `…_FEEDBACK_COLLECTOR_URL` line and never rewrites an existing one, so placeholders can be passed for required flags without reading, printing, or replacing the existing token.
Do not rely on that invariant alone for something as unrecoverable as the token (it's write-only — a clobber forces a rotation): back up `.env.local` first and assert after the run that it is byte-identical, restoring the backup if not.

Download the currently served installer into a temp file and verify that it actually contains the duration-cap contract **before** letting it write into the app:

```bash
set -euo pipefail
COLLECTOR_URL="https://incubator-build-app-web.vercel.app"
OUT_DIR="src/preview-feedback" # resolved in Step 1; may be client/src/preview-feedback
INSTALLER="$(mktemp -t inc-feedback.XXXXXX.mjs)"
RESULT="$(mktemp -t inc-feedback-result.XXXXXX.json)"

curl -fsSL "$COLLECTOR_URL/feedback-client.mjs" -o "$INSTALLER"
grep -q 'RECORDING_MAX_MS' "$INSTALLER"
grep -q 'filesPresent' "$INSTALLER"
grep -q 'recording.webm' "$INSTALLER"
grep -q 'Screen + voice · 8 min max' "$INSTALLER"

# Guard the existing token: snapshot the env file, compare after, restore on
# drift. The backup holds the raw token - it is deleted on every path below.
ENV_FILE=".env.local"
ENV_BACKUP=""
if [ -f "$ENV_FILE" ]; then
  ENV_BACKUP="$(mktemp -t inc-feedback-env.XXXXXX)"
  cp "$ENV_FILE" "$ENV_BACKUP"
fi

# Capture the exit status instead of letting `set -e` kill the shell here -
# the env guard below must run even (especially) when the installer fails.
INSTALL_STATUS=0
node "$INSTALLER" --dir . --json --yes --skip-install \
  --out-dir "$OUT_DIR" \
  --collector-url "$COLLECTOR_URL" \
  --token "existing-token-preserved" \
  --project "existing-project-preserved" \
  > "$RESULT" || INSTALL_STATUS=$?

if [ -n "$ENV_BACKUP" ]; then
  if ! cmp -s "$ENV_BACKUP" "$ENV_FILE"; then
    cp "$ENV_BACKUP" "$ENV_FILE"
    rm -f "$ENV_BACKUP"
    echo "ENV_CLOBBER_REVERTED: installer modified $ENV_FILE on a refresh; original restored"
    exit 1
  fi
  rm -f "$ENV_BACKUP"
elif [ -f "$ENV_FILE" ]; then
  # No env file existed before this refresh: the app's real feedback vars live
  # elsewhere (another env file, or only in the deployment platform). The
  # installer just created .env.local with the placeholder values - delete it
  # so a local preview build can never submit with the placeholder token.
  rm -f "$ENV_FILE"
  echo "PLACEHOLDER_ENV_REMOVED: no pre-existing $ENV_FILE; installer-created copy deleted"
fi

if [ "$INSTALL_STATUS" -ne 0 ]; then
  echo "INSTALLER_FAILED status=$INSTALL_STATUS"
  exit "$INSTALL_STATUS"
fi

echo "RESULT_FILE=$RESULT"
```

The four greps are a **staleness gate**, not a behavioral proof — they detect a collector still serving a pre-cap installer bundle; whether the cap actually enforces is owned by the canonical client's fake-timer test suite, and Step 7 re-verifies the installed constants' values.
If any of them fails, stop: the collector deployment is serving an older installer.
Do not replace a capped local client with it; report that the incubator app must be deployed first.
Interpreting the guard markers:
- `ENV_CLOBBER_REVERTED` → the served installer no longer honors the leave-env-untouched invariant; the original `.env.local` was restored (and the backup deleted). Stop and report it as an installer regression.
- `PLACEHOLDER_ENV_REMOVED` → expected when the app keeps its feedback vars outside `.env.local`; the placeholder file the installer created was deleted. Continue, but skip Step 6's `.env.local` checks — the deployment platform's env is the source of truth here.
- `INSTALLER_FAILED status=N` → the refresh did not complete; the env guard already ran (restore or placeholder cleanup). Investigate the installer output in `RESULT_FILE` before retrying.

After a successful refresh: if Step 1 found the component already mounted, skip Step 5; if this was the clean-but-unmounted case, continue **through Step 5** to mount it — that's the half the interrupted setup never finished.
Continue through Step 4 to inspect the result, then Steps 6 and 7 to verify env/build/UI.

## Step 3B — Mint token + run the installer for a new install (one shell step)

Before minting, verify `.env.local` can't leak into git — the installer writes the token there:

```bash
# From the app root. If it's tracked or not ignored, fix .gitignore before minting.
git ls-files --error-unmatch .env.local 2>/dev/null && echo "ENV_TRACKED_IN_GIT"
git check-ignore -q .env.local && echo "ENV_IGNORED_OK" || echo "ENV_NOT_IGNORED"
```

- `ENV_TRACKED_IN_GIT` → stop: have the user run `git rm --cached .env.local` and add `.env.local` to `.gitignore`, then re-run.
- `ENV_NOT_IGNORED` in a git repo → add `.env.local` to `.gitignore` before continuing.
  (It also prints when the app isn't a git repo at all — then there's nothing to leak; continue.)

Do the mint and the install in a **single** Bash invocation so the raw token is captured into a shell variable and never printed to the transcript.
The installer writes it into `.env.local` itself — that's the only place it needs to live.

`inc-build` prints the bare `fbk_…` to **stdout** (metadata like project/expiry goes to stderr), so `TOKEN=$(…)` captures exactly the token.

```bash
set -euo pipefail
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<plugin root>}"   # see "Plugin scripts" note above
PROJECT="my-app-preview"          # from Step 2
LABEL="review"                    # from Step 2
DAYS="90"                         # from Step 2
BUNDLER=""                        # set to vite|next ONLY if Step 1 detected neither and you asked the user
OUT_DIR="src/preview-feedback"    # resolved in Step 1; may be client/src/preview-feedback
COLLECTOR_URL="https://incubator-build-app-web.vercel.app"
RESULT="$(mktemp -t inc-feedback-result.XXXXXX.json)"

# 1) Fetch the self-contained installer (component sources embedded — no repo checkout needed)
# and fail before minting if the collector is still serving the pre-cap client.
INSTALLER="$(mktemp -t inc-feedback.XXXXXX.mjs)"
curl -fsSL "$COLLECTOR_URL/feedback-client.mjs" -o "$INSTALLER"
grep -q 'RECORDING_MAX_MS' "$INSTALLER"
grep -q 'filesPresent' "$INSTALLER"
grep -q 'recording.webm' "$INSTALLER"
grep -q 'Screen + voice · 8 min max' "$INSTALLER"

# 2) Mint — token to stdout, metadata to stderr. Never echo $TOKEN.
TOKEN="$(node "$PLUGIN_ROOT/scripts/inc-build.mjs" feedback mint-token \
  --project "$PROJECT" --label "$LABEL" --days "$DAYS")"

# 3) Install into the current app. --json puts the machine-readable result on stdout, human logs on stderr.
node "$INSTALLER" --dir . --json \
  --out-dir "$OUT_DIR" \
  --collector-url "$COLLECTOR_URL" \
  --token "$TOKEN" \
  --project "$PROJECT" \
  ${BUNDLER:+--bundler "$BUNDLER"} \
  > "$RESULT"

echo "RESULT_FILE=$RESULT"
```

If an installer contract grep fails, stop before minting: the collector deployment is stale and must be updated first.

If the mint fails on auth (the plugin's org credentials at `~/.claude/incubator/credentials.json` are missing or expired), don't loop — print the exact manual command for the user to run and where creds come from, then stop:
`node "$PLUGIN_ROOT/scripts/inc-build.mjs" feedback projects` (a read that also surfaces the auth error), and note the token can also be minted backend-side by someone with DB access.

## Step 4 — Read the installer result

The `--json` result is a single JSON object.
Shell variables don't survive between Bash invocations, so substitute the `RESULT_FILE=<path>` that Step 3A or 3B printed, then pull the fields you need for the mount:

```bash
RESULT=<paste the RESULT_FILE path printed by Step 3A or 3B>
jq '{ok, outDir, wrapperFile, mountExport, bundler, envFile, envPrefix, componentFiles}' "$RESULT"
```

Key fields:
- `outDir` — where the component set landed (default `src/preview-feedback/`).
- `wrapperFile` — the generated `…/PreviewFeedbackMount.tsx` you mount.
- `mountExport` — the export name (`PreviewFeedbackMount`).
- `bundler` — `vite` or `next` (drives the mount location in Step 5).
- `envPrefix` — `VITE_FEEDBACK_` or `NEXT_PUBLIC_FEEDBACK_` (the `…ENABLED` flag lives here).

If `ok` is not `true` or the file is empty, the install failed — surface the stderr from Step 3A or 3B and stop.

## Step 5 — Mount `<PreviewFeedbackMount />` once at the app root

Mount it exactly once, as a **sibling of the root app component**.
**Compute the import path as the relative path from the file you're editing to the `outDir` the installer reported** — don't copy a path blindly (the installer's own printed hint hardcodes `./preview-feedback/...`, which is wrong for Next layouts; trust `outDir`).

**Vite** — in `src/main.tsx` (or wherever the root `<App />` renders), render it next to `<App />`.
`main.tsx` sits in `src/` next to `outDir` (`src/preview-feedback/`), so the import is `./`:

```tsx
import { PreviewFeedbackMount } from "./preview-feedback/PreviewFeedbackMount";
// ...
<>
  <App />
  <PreviewFeedbackMount />
</>
```

**Next (App Router)** — in `app/layout.tsx` (or `src/app/layout.tsx`), render it inside `<body>` as a sibling of `{children}`.
The layout sits one level **below** `outDir` (`src/app/` vs `src/preview-feedback/`, or `app/` vs root `preview-feedback/`), so the import is `../`:

```tsx
import { PreviewFeedbackMount } from "../preview-feedback/PreviewFeedbackMount";
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
- `.env.local` never ships — the deployed preview build can't see it.
  In the preview deployment's environment, set **all** the `<envPrefix>*` vars, copying names and values from `.env.local`: `…COLLECTOR_URL`, `…TOKEN`, `…PROJECT`, and `…ENABLED=1`.
  Mark the token variable as a secret/sensitive value in the platform's env settings.
- Setting `<envPrefix>ENABLED=1` **only in the preview deployment's environment** turns on the remote submit panel for external reviewers.
- **Never** set it in production. In a prod build both the dev flag and ENABLED are statically `false`, so with Vite the panel and its deps are dropped from the bundle entirely; with Next the lazy chunk may be emitted but is never fetched.

## Step 7 — Confirm the app still builds

A mount that doesn't compile is worse than none. Build with the app's package manager (from the result's `packageManager`, or detect):

First verify the installed source has the complete recording safety contract:

```bash
OUT_DIR="src/preview-feedback" # actual outDir from Step 4; may be client/src/preview-feedback
test -f "$OUT_DIR/recording-limit.ts"
grep -q 'RECORDING_MAX_MS' "$OUT_DIR/recording-limit.ts"
grep -q 'RECORDING_WARNING_MS' "$OUT_DIR/recording-limit.ts"
grep -q 'hasScreenRecording' "$OUT_DIR/PreviewFeedback.tsx"
grep -q 'Screen + voice · 8 min max' "$OUT_DIR/PreviewFeedback.tsx"
# Mobile recording path (rrweb). Soft check: an older collector build serves a
# client without it - note "mobile recording not included; update the collector
# app and re-run" in the summary instead of failing the install.
test -f "$OUT_DIR/mobile-recorder.ts" || echo "NOTE: no mobile-recorder.ts (collector serving an older client)"
# Assert the contract VALUES (8 min cap, 60 s warning), not one arithmetic
# spelling of them - the canonical source is free to reformat the constants.
node --input-type=module -e "
  const src = (await import('node:fs')).readFileSync('$OUT_DIR/recording-limit.ts', 'utf8');
  const val = (name) => {
    const m = src.match(new RegExp(name + String.raw\`\s*=\s*([0-9*+_\s()]+);\`));
    if (!m) throw new Error(name + ' not found');
    return Function('return ' + m[1])();
  };
  if (val('RECORDING_MAX_MS') !== 8 * 60 * 1000) throw new Error('RECORDING_MAX_MS != 8 min');
  if (val('RECORDING_WARNING_MS') !== 60 * 1000) throw new Error('RECORDING_WARNING_MS != 60 s');
"
```

Any failure means the install is incomplete or stale; do not call setup complete.

```bash
# pick the one that matches the project
pnpm build 2>&1 | tail -20   # or: npm run build / yarn build
```

If the build breaks:
- **Import-shape error on Agentation** — some versions export `Agentation` as default, not named; switch the import in `src/preview-feedback/PreviewFeedback.tsx` (this is a known caveat).
- **Type errors from `riffrec`/`agentation`** — the component casts via `vendor-types.ts`; if a version drifted, adjust the interface there.
- Fix forward and re-build; don't leave the app red.

When a browser/dev preview is available, inspect the actual widget rather than stopping at source checks:
- before recording, it says `Screen + voice · 8 min max`;
- while recording, elapsed and remaining time are both visible;
- the final-minute state is visually distinct and says `Wrap up`;
- manual stop saves once and leaves a staged walkthrough.

Do not wait eight real minutes merely to prove the timeout during setup; the canonical client owns focused fake-timer coverage for the 7:00 warning, 8:00 stop, boundary race, and missing-video rejection.

## Step 8 — Summary

```
PREVIEW FEEDBACK — INSTALLED
────────────────────────────
Project slug:  <project>            (token label: <label>, expires in <days>d)
Collector:     <collector-url>
Component →    <outDir>/ (<n> files + PreviewFeedbackMount wrapper)
Mounted in:    <root file>  (<vite|next>)
Env flag:      <envPrefix>ENABLED=0 locally  → set =1 ONLY in the preview env, never prod
Recording cap: 8:00 hard stop · warning at 7:00 · missing video rejected
Build:         <passed | fixed <what>>

Reviewers annotate the deployed preview; read the feedback with:
  node <plugin>/scripts/inc-build.mjs feedback list --project <project>
  node <plugin>/scripts/inc-build.mjs feedback fetch <sessionId> --out ./feedback
```

## Rules

- **Never print the raw `fbk_…` token.** Mint and install in one shell step (Step 3B) so it stays out of the transcript; its only home is `.env.local`.
- **One mount, at the root, as a sibling** of the root app component — never introduce a layout-changing wrapper, never mount it twice.
- **`ENABLED=0` locally, `=1` only in the preview env, never in production.** This is the safety-critical line.
- **Refresh clean installs; protect dirty ones.** An existing mounted client must be checked for canonical updates. Refresh it only when its output directory is clean; stop before overwriting local customizations and never double-mount it.
- **Verify the served installer before minting or writing.** It must contain `RECORDING_MAX_MS`, the `recording.webm` guard, and the visible 8-minute copy. A stale collector deployment is a blocker.
- **Do not wait for RiffRec's direct-archive release.** It will simplify ZIP handoff but does not remove the 50 MiB screen-video exclusion.
- **Run from the target app root**, not the plugin repo — the installer writes into the current directory.
- **Don't block on auth.** If the mint fails, print the manual mint path (self-serve CLI or backend) and stop cleanly rather than looping.
