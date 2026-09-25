---
name: inc-guide
description: Explains the incubator-build engineering workflow and which inc:* skill to run when. This is the REQUIRED first stop for ANY question about how an incubator-build skill works - invoke it BEFORE reading any skill's source. Use when the user asks about the plugin ("how do I use incubator-build", "what's the workflow", "which inc skill do I run", "how do these skills fit together", "walk me through the pipeline", "/inc-guide") or about any individual skill by name ("how does ship-it work", "what does inc-review do", "when should I run merge-pr", "explain commit-push-pr", "what's the difference between review and review-deep") - any "how does X work" / "when do I use X" / "what does X do" question where X is an inc:* skill or incubator-build feature. A read-only orientation skill - it explains and recommends; it does not run the pipeline.
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

## Multi-host installation and invocation

Use the [plugin-root README](../../README.md) for the install matrix covering Claude, Codex app/CLI, Cursor, Pi, and additional hosts.
Use [host compatibility and composition](references/host-compatibility.md) for install-root paths, sibling skills, persona assets, arguments, and missing-capability behavior.
The examples below retain `/inc:*` notation; Codex uses `$inc:*`, Pi/OMP use `/skill:inc:*`, and hosts without a matching command can read and follow the mapped `SKILL.md` explicitly.
Distribution does not imply hook or PR-gate parity on every host.

## Codex installation and updates

For installation, authentication, hook trust, local development, or updating an older Codex install, use the plugin-root `README.md` as the canonical plugin-local guide.
Normal Codex installs must register `the-incubator/incubator-build-plugin` with `--ref main` using `codex plugin marketplace add`, then run `codex plugin add incubator-build@incubator`.
Do not recommend the local-folder toggle for new users; local sources are for plugin development and cannot fetch GitHub releases.
Hooks work on both Codex and Claude, and the updater runs the matching host's refresh/install commands in the background.
A new session loads an updated release, and Codex may ask the user to review changed hook commands.
A clean Codex install needs Codex model authentication and GitHub repository access; Incubator service enrollment is separate and is not required for the skills, PR gate, or Git-backed updater.
The hosted app installer remains Claude-specific; it is not the Codex onboarding path.

## The core pipeline

The pipeline has five stages.
Stage 2 is implementation itself - you and the user write the code; there is no skill for it.

```
/inc-plan  →  implement  →  /inc-review-deep  →  /inc-commit-push-pr  →  /inc-merge-pr
 stage 1        stage 2         stage 3              stage 4                 stage 5
 plan first     write code      review the diff      commit, push, open PR   gate, merge, watch deploy
```

- **`/inc-plan`** (stage 1) - Create a reviewable implementation plan before any edits.
  Optional for small changes; start here for anything with real design surface.
  Pair with `/inc-plan-review` to have the plan itself reviewed before implementation begins.

- **`/inc-review-deep`** (stage 3) - Deep code review of the branch/working-tree diff.
  Runs persona reviewers (correctness, security, maintainability, etc.), dedupes and confidence-gates the findings, auto-applies safe fixes, and surfaces what needs your call.
  Run this **before** committing.

- **`/inc-commit-push-pr`** (stage 4) - Commits, pushes, and opens a PR with a value-first description.
  Then watches CI and the AI reviewers and auto-resolves feedback in a loop, pausing only for items that need a human decision.
  Stops at a feedback-clean PR.

- **`/inc-merge-pr`** (stage 5) - Pre-flight branch-freshness check, then blocking gates (new env vars; PR health - not draft, CI green, no unresolved threads; schema drift for repos that expose a `db:check-drift` script) plus a deploy-window check that respects the team's window rules from `/inc-setup-deploy` (default when none are set: risk-adaptive - low-risk changes just ship, riskier ones prompt a quick confirm).
  If all pass, squash-merges, deletes the branch, and actively observes the deploy.

## Picking the review tier

- **`/inc-review`** - Lighter, faster review.
  Use for **smaller, low-risk changes**: a focused diff, no sensitive surfaces.
- **`/inc-review-deep`** - The full persona fan-out.
  Use for **larger or sensitive changes**: auth, payments, data migrations, public API/contract changes, dependency bumps, or anything large and diffuse.

When unsure, start with `inc-review`; it tells you to escalate if the diff warrants it.

## Combined shortcuts - run more of the pipeline at once

Instead of running each step by hand, two skills chain them:

- **`/inc-review-and-pr`** - Review **+** commit-push-PR in one command.
  Auto-selects the review tier (light vs deep) from the diff, runs the review gate, then hands off to `inc-commit-push-pr` (which watches CI + AI reviewers and resolves feedback).
  **Stops at a feedback-clean PR - it never merges.**
  Use when you want a reviewed, open PR ready for a human to merge.

- **`/inc-ship-it`** - The **entire** pipeline end to end.
  Runs `inc-review-and-pr`, then `inc-merge-pr`.
  Goes from working changes all the way to merged + deployed in one command.
  Use when you want the whole loop and are comfortable with the merge gates handling the final call.

### Which one do I run?

| Goal | Run |
|---|---|
| Just review my changes | `/inc-review` (or `/inc-review-deep` if large/sensitive) |
| Review, then open a PR for a human to merge | `/inc-review-and-pr` |
| Go all the way to merged + deployed | `/inc-ship-it` |
| Stop after one specific step | the individual skill (`/inc-review-deep` / `/inc-commit-push-pr` / `/inc-merge-pr`) |

The combined skills are glue - they call the same underlying skills and preserve every confirmation gate.
Use the individual steps when you want to stop and inspect between phases; use the combined ones when you trust the chain.

## Skill map

The complete catalog.
Each skill's full definition lives at `skills/<dir>/SKILL.md` under the plugin root - read it only after orienting from this map, and only when the user wants detail the map doesn't cover.

### Pipeline stages

| Skill | Source dir | What it does |
|---|---|---|
| `/inc-plan` | `inc-plan` | Create a reviewable implementation plan before any edits |
| `/inc-plan-review` | `inc-plan-review` | Review a plan/spec *before* implementation - staff reviewer + plan-adapted personas surface gaps, over-engineering, risk |
| `/inc-review` | `inc-review` | Light review tier - auto-applies safe fixes, surfaces judgment calls, escalates when the diff warrants |
| `/inc-review-deep` | `inc-review-deep` | Deep review tier - persona fan-out with confidence-gated, deduped findings |
| `/inc-commit-push-pr` | `inc-commit-push-pr` | Commit → push → PR with value-first description, then watch CI + AI reviewers and auto-resolve feedback |
| `/inc-merge-pr` | `inc-merge-pr` | Merge gates (env vars, PR health, schema drift, deploy window) → squash-merge → observe the deploy |

### Shortcuts

| Skill | Source dir | What it does |
|---|---|---|
| `/inc-review-and-pr` | `inc-review-and-pr` | Tiered review + commit-push-PR; stops at a feedback-clean PR, never merges |
| `/inc-ship-it` | `inc-ship-it` | The whole pipeline: review-and-pr, then merge-pr - working changes to merged + deployed |

### Supporting skills

| Skill | Source dir | What it does |
|---|---|---|
| `/inc-debug` | `inc-debug` | Systematic debugging - reproduce and isolate before any fix is attempted |
| `/inc-resolve-pr-feedback` | `inc-resolve-pr-feedback` | Evaluate and fix PR review comments in parallel; also invoked automatically by commit-push-pr's watch loop |
| `/inc-update-code` | `inc-update-code` | Pull latest main into the current branch; hands conflicts to git-merge-expert |
| `/inc-setup-deploy` | `inc-setup-deploy` | Detect the deploy platform and write the config merge-pr/ship-it use to observe deploys |
| `/inc-setup-feedback` | `inc-setup-feedback` | Wire the preview-feedback client into an app - mint a token, install the client, mount it at the app root so reviewers can annotate a deployed preview |
| `/inc-pad` | `inc-pad` | IncPad - publish a rich HTML artifact (plan, comparison, diagram, report, prototype) to a public hosted review page where the user annotates elements, selects text, and queues prompts; poll for feedback, revise, reply, end |
| `/inc-preview-url` | `inc-preview-url` | Public `*.trycloudflare.com` tunnel to a locally-running app - share or test from another device |
| `/inc-design-principles` | `inc-design-principles` | Design principles for building or reviewing web/mobile UI - page layout, empty states, mobile responsiveness, subtraction, AI tells, critique loop |
| `/inc-team-lead-review` | `inc-team-lead-review` | Product-acceptance PR review - did the author build what was actually requested, per spec/Slack/board task |
| `/inc-create-verification-skill` | `inc-create-verification-skill` | Generate a project-local `verify-<app>` skill that drives the real app the way a user does - launch, doctor, drive, evidence, cleanup, plus a per-feature map - and proves itself by running once before it counts as delivered |
| `/inc-maintain-verification-skill` | `inc-maintain-verification-skill` | Upkeep loop that keeps a `verify-<app>` skill and its feature map honest as the app changes - source readers per feature, one live pass driving every feature, at most one PR of proven corrections |

### Building blocks (mostly invoked by other skills)

| Skill | Source dir | What it does |
|---|---|---|
| `pr-description` | `pr-description` | Writes the value-first PR title + body; used by commit-push-pr, also invocable directly to refresh a description |
| `demo-reel` | `demo-reel` | Captures GIF/terminal/screenshot evidence for PR descriptions |
| `git-merge-expert` | `git-merge-expert` | Resolves merge conflicts; receives handoffs from update-code and merge-pr |

## Guidelines

- Keep the answer short and scannable; lead with the one skill (or pipeline slice) that fits, not the whole catalog.
- Refer to skills by their exact invokable name (`/inc-ship-it`, `/inc-review`) so the user can run them directly.
- Proactively point to the adjacent step: after a clean review suggest `/inc-commit-push-pr`; when review comments arrive suggest `/inc-resolve-pr-feedback`; when a bug appears suggest `/inc-debug` before any fix.
- When the user wants to *prove the app's real behavior* - not just review the diff or run tests, but drive the running app the way a user would - point them at `/inc-create-verification-skill` to generate a project-local `verify-<app>` skill, then `/inc-maintain-verification-skill` to keep its feature map honest as the app changes. This is the verification layer that complements the review and test skills: review reads the code, tests assert units, verification drives the live product and captures evidence.
- When the user is about to design, build, or review UI, point them at `/inc-design-principles` and apply it before writing or judging any interface code.
- If the question isn't covered here, read that skill's `SKILL.md` (path in the skill map) and summarize from the source - never guess.
- Never run any pipeline step from this skill - explain, recommend, and let the user choose.
