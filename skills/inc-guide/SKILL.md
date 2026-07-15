---
name: inc:guide
description: Explains the incubator-build engineering workflow and which inc:* skill to run when. This is the REQUIRED first stop for ANY question about how an incubator-build skill works - invoke it BEFORE reading any skill's source. Use when the user asks about the plugin ("how do I use incubator-build", "what's the workflow", "which inc skill do I run", "how do these skills fit together", "walk me through the pipeline", "/inc:guide") or about any individual skill by name ("how does ship-it work", "what does inc:review do", "when should I run merge-pr", "explain commit-push-pr", "what's the difference between review and review-deep") - any "how does X work" / "when do I use X" / "what does X do" question where X is an inc:* skill or incubator-build feature. A read-only orientation skill - it explains and recommends; it does not run the pipeline.
allowed-tools: Read
---

# incubator-build workflow guide

This skill orients someone on the incubator-build engineering loop: which skill to run, in what order, and when to use the combined shortcuts instead of the individual steps.
It **explains and recommends only** - it does not run any step.
When the user is ready, they invoke the skill themselves (or ask you to).

## First: identify the question type

Every question routes to one of three shapes.
Pick the shape, answer from this guide, and stop.

1. **Workflow orientation** ("how do I use incubator-build", "walk me through the pipeline") - give the core pipeline, the review-tier choice, and the two shortcuts.
2. **Specific-skill question** ("how does ship-it work?", "what does merge-pr do?") - answer from the skill map below: what the skill does and where it sits in the pipeline.
   Only if the user wants implementation-level detail the map doesn't cover, read that skill's own `SKILL.md` (path in the map) and summarize - the guide is the entry point, the sources are the follow-up.
3. **Situation** ("I just finished a small fix", "this touches auth", "my PR got review comments") - recommend the one skill that fits and stop.

## The core pipeline

The numbers in skill names are pipeline stages.
Stage 2 is implementation itself - you and the user write the code; there is no skill for it.

```
/inc:plan-1  →  implement  →  /inc:review-deep-3b  →  /inc:commit-push-pr-4  →  /inc:merge-pr-5
 plan first      (stage 2)      review the diff        commit, push, open PR     gate, merge, watch deploy
```

- **`/inc:plan-1`** (stage 1) - Create a reviewable implementation plan before any edits.
  Optional for small changes; start here for anything with real design surface.
  Pair with `/inc:plan-review` to have the plan itself reviewed before implementation begins.

- **`/inc:review-deep-3b`** (stage 3) - Deep code review of the branch/working-tree diff.
  Runs persona reviewers (correctness, security, maintainability, etc.), dedupes and confidence-gates the findings, auto-applies safe fixes, and surfaces what needs your call.
  Run this **before** committing.

- **`/inc:commit-push-pr-4`** (stage 4) - Commits, pushes, and opens a PR with a value-first description.
  Then watches CI and the AI reviewers and auto-resolves feedback in a loop, pausing only for items that need a human decision.
  Stops at a feedback-clean PR.

- **`/inc:merge-pr-5`** (stage 5) - Pre-flight branch-freshness check, then blocking gates (new env vars; PR health - not draft, CI green, no unresolved threads) plus a deploy-window check that respects the team's window rules from `/inc:setup-deploy` (default: none = deploy anytime).
  If all pass, squash-merges, deletes the branch, and actively observes the deploy.

## Picking the review tier

- **`/inc:review-3a`** - Lighter, faster review.
  Use for **smaller, low-risk changes**: a focused diff, no sensitive surfaces.
- **`/inc:review-deep-3b`** - The full persona fan-out.
  Use for **larger or sensitive changes**: auth, payments, data migrations, public API/contract changes, dependency bumps, or anything large and diffuse.

When unsure, start with `inc:review-3a`; it tells you to escalate if the diff warrants it.

## Combined shortcuts - run more of the pipeline at once

Instead of running each step by hand, two skills chain them:

- **`/inc:review-and-pr`** - Review **+** commit-push-PR in one command.
  Auto-selects the review tier (light vs deep) from the diff, runs the review gate, then hands off to `inc:commit-push-pr-4` (which watches CI + AI reviewers and resolves feedback).
  **Stops at a feedback-clean PR - it never merges.**
  Use when you want a reviewed, open PR ready for a human to merge.

- **`/inc:ship-it`** - The **entire** pipeline end to end.
  Runs `inc:review-and-pr`, then `inc:merge-pr-5`.
  Goes from working changes all the way to merged + deployed in one command.
  Use when you want the whole loop and are comfortable with the merge gates handling the final call.

### Which one do I run?

| Goal | Run |
|---|---|
| Just review my changes | `/inc:review-3a` (or `/inc:review-deep-3b` if large/sensitive) |
| Review, then open a PR for a human to merge | `/inc:review-and-pr` |
| Go all the way to merged + deployed | `/inc:ship-it` |
| Stop after one specific step | the individual skill (`-3b` / `-4` / `-5`) |

The combined skills are glue - they call the same underlying skills and preserve every confirmation gate.
Use the individual steps when you want to stop and inspect between phases; use the combined ones when you trust the chain.

## Skill map

The complete catalog.
Each skill's full definition lives at `skills/<dir>/SKILL.md` under the plugin root - read it only after orienting from this map, and only when the user wants detail the map doesn't cover.

### Pipeline stages

| Skill | Source dir | What it does |
|---|---|---|
| `/inc:plan-1` | `inc-plan` | Create a reviewable implementation plan before any edits |
| `/inc:plan-review` | `inc-plan-review` | Review a plan/spec *before* implementation - staff reviewer + plan-adapted personas surface gaps, over-engineering, risk |
| `/inc:review-3a` | `inc-review` | Light review tier - auto-applies safe fixes, surfaces judgment calls, escalates when the diff warrants |
| `/inc:review-deep-3b` | `inc-review-deep` | Deep review tier - persona fan-out with confidence-gated, deduped findings |
| `/inc:commit-push-pr-4` | `inc-commit-push-pr` | Commit → push → PR with value-first description, then watch CI + AI reviewers and auto-resolve feedback |
| `/inc:merge-pr-5` | `inc-merge-pr` | Merge gates (env vars, PR health, deploy window) → squash-merge → observe the deploy |

### Shortcuts

| Skill | Source dir | What it does |
|---|---|---|
| `/inc:review-and-pr` | `inc-review-and-pr` | Tiered review + commit-push-PR; stops at a feedback-clean PR, never merges |
| `/inc:ship-it` | `inc-ship-it` | The whole pipeline: review-and-pr, then merge-pr - working changes to merged + deployed |

### Supporting skills

| Skill | Source dir | What it does |
|---|---|---|
| `/inc:debug` | `inc-debug` | Systematic debugging - reproduce and isolate before any fix is attempted |
| `/inc:resolve-pr-feedback` | `inc-resolve-pr-feedback` | Evaluate and fix PR review comments in parallel; also invoked automatically by commit-push-pr's watch loop |
| `/inc:update-code` | `inc-update-code` | Pull latest main into the current branch; hands conflicts to git-merge-expert |
| `/inc:setup-deploy` | `inc-setup-deploy` | Detect the deploy platform and write the config merge-pr/ship-it use to observe deploys |
| `/inc:setup-feedback` | `inc-setup-feedback` | Wire the preview-feedback client into an app - mint a token, install the client, mount it at the app root so reviewers can annotate a deployed preview |
| `/inc:preview-url` | `inc-preview-url` | Public `*.trycloudflare.com` tunnel to a locally-running app - share or test from another device |
| `/inc:team-lead-review` | `team-lead-review` | Product-acceptance PR review - did the author build what was actually requested, per spec/Slack/board task |

### Building blocks (mostly invoked by other skills)

| Skill | Source dir | What it does |
|---|---|---|
| `pr-description` | `pr-description` | Writes the value-first PR title + body; used by commit-push-pr, also invocable directly to refresh a description |
| `demo-reel` | `demo-reel` | Captures GIF/terminal/screenshot evidence for PR descriptions |
| `git-merge-expert` | `git-merge-expert` | Resolves merge conflicts; receives handoffs from update-code and merge-pr |

## Guidelines

- Keep the answer short and scannable; lead with the one skill (or pipeline slice) that fits, not the whole catalog.
- Refer to skills by their exact invokable name (`/inc:ship-it`, `/inc:review-3a`) so the user can run them directly.
- Proactively point to the adjacent step: after a clean review suggest `/inc:commit-push-pr-4`; when review comments arrive suggest `/inc:resolve-pr-feedback`; when a bug appears suggest `/inc:debug` before any fix.
- If the question isn't covered here, read that skill's `SKILL.md` (path in the skill map) and summarize from the source - never guess.
- Never run any pipeline step from this skill - explain, recommend, and let the user choose.
