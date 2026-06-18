---
name: inc:guide
description: Explains the incubator-build engineering workflow and which inc:* skill to run when. Use when the user asks "how do I use incubator-build", "what's the workflow", "which inc skill do I run", "how do these skills fit together", "walk me through the pipeline", or "/inc:guide". A read-only orientation skill — it explains and recommends; it does not run the pipeline.
allowed-tools: Read
---

# incubator-build workflow guide

This skill orients someone on the incubator-build engineering loop: which skill to run, in what order, and when to use the combined shortcuts instead of the individual steps. It **explains and recommends only** — it does not run any step. When the user is ready, they invoke the skill themselves (or ask you to).

## The core pipeline

The everyday loop takes working-tree changes all the way to merged and deployed in three steps:

```
/inc:review-deep-3b  →  /inc:commit-push-pr-4  →  /inc:merge-pr-5
   review the diff       commit, push, open PR      gate, merge, watch deploy
```

1. **`/inc:review-deep-3b`** — Deep code review of the branch/working-tree diff. Runs persona reviewers (correctness, security, maintainability, etc.), dedupes and confidence-gates the findings, auto-applies safe fixes, and surfaces what needs your call. Run this **before** committing.

2. **`/inc:commit-push-pr-4`** — Commits, pushes, and opens a PR with a value-first description. Then watches CI and the AI reviewers and auto-resolves feedback in a loop, pausing only for items that need a human decision. Stops at a feedback-clean PR.

3. **`/inc:merge-pr-5`** — Pre-flight branch-freshness check, then three blocking gates (new env vars; PR health — not draft, CI green, no unresolved threads; deploy-window timing). If all pass, squash-merges, deletes the branch, and actively observes the deploy.

## Picking the review tier

- **`/inc:review-3a`** — Lighter, faster review. Use for **smaller, low-risk changes**: a focused diff, no sensitive surfaces.
- **`/inc:review-deep-3b`** — The full persona fan-out. Use for **larger or sensitive changes**: auth, payments, data migrations, public API/contract changes, dependency bumps, or anything large and diffuse.

When unsure, start with `inc:review-3a`; it tells you to escalate if the diff warrants it.

## Combined shortcuts — run more of the pipeline at once

Instead of running each step by hand, two skills chain them:

- **`/inc:review-and-pr`** — Review **+** commit-push-PR in one command. Auto-selects the review tier (light vs deep) from the diff, runs the review gate, then hands off to `inc:commit-push-pr-4` (which watches CI + AI reviewers and resolves feedback). **Stops at a feedback-clean PR — it never merges.** Use when you want a reviewed, open PR ready for a human to merge.

- **`/inc:ship-it`** — The **entire** pipeline end to end. Runs `inc:review-and-pr`, then `inc:merge-pr-5`. Goes from working changes all the way to merged + deployed in one command. Use when you want the whole loop and are comfortable with the merge gates handling the final call.

### Which one do I run?

| Goal | Run |
|---|---|
| Just review my changes | `/inc:review-3a` (or `/inc:review-deep-3b` if large/sensitive) |
| Review, then open a PR for a human to merge | `/inc:review-and-pr` |
| Go all the way to merged + deployed | `/inc:ship-it` |
| Stop after one specific step | the individual skill (`-3b` / `-4` / `-5`) |

The combined skills are glue — they call the same underlying skills and preserve every confirmation gate. Use the individual steps when you want to stop and inspect between phases; use the combined ones when you trust the chain.

## Two more skills worth knowing

- **`/inc:debug`** — Systematic debugging. Use the moment you hit a bug, test failure, or unexpected behavior — **before** guessing at a fix. It reproduces and isolates the problem first, so the fix lands on a confirmed cause rather than a hunch.

- **`/inc:preview-url`** — Get a public URL for your locally-running app (a `*.trycloudflare.com` tunnel to a local port). Use to reach the app from your phone, share a work-in-progress with someone, or test on another device. No account or domain needed.

## How to respond when this skill runs

Give the user a short, direct orientation: the three-step core pipeline, when to drop to `inc:review-3a` for small changes, and the two shortcuts (`inc:review-and-pr`, `inc:ship-it`). Mention `inc:debug` and `inc:preview-url` as supporting tools. If they described a specific situation ("I just finished a small fix", "this touches auth"), recommend the one skill that fits and stop. Don't run anything — let them choose.
