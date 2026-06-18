---
name: inc:ship-it
description: End-to-end ship pipeline. Runs inc:review-and-pr (tiered review gate → commit-push-PR → watch CI + AI reviewers → resolve feedback, stopping at a feedback-clean PR), then inc:merge-pr-5 to run the merge gates, squash-merge, and observe the deploy. Use when the user says "ship it end to end", "full ship", "commit through merge", "/inc:ship-it", or wants the whole working-changes-to-merged-and-deployed flow as one command.
allowed-tools: Skill, Bash(gh *), Bash(git *), Read
---

# Ship It: review → PR → resolve feedback → merge, end to end

Orchestrates two existing skills in sequence so the user runs one command instead of several:

1. `inc:review-and-pr` — review the working tree (tiered light/deep), commit-push-PR, watch CI + AI reviewers, resolve feedback in a loop, and stop at a feedback-clean PR.
2. `inc:merge-pr-5` — run the merge gates, squash-merge, and observe the deploy.

This skill **does not reimplement** any underlying logic — it hands off via the `Skill` tool and waits. The confirmation gates the underlying skills enforce (review gate, commit-push-pr's intent interview, merge-pr's three gates) are preserved. Feedback resolution runs **unattended** inside commit-push-pr's watch loop — only `needs-human` items pause it. So the chain still stops at its real decision points (review findings, a `needs-human` thread, merge gates); it is not fully hands-off, but feedback fixes no longer prompt per-thread.

`inc:review-and-pr` already contains the commit → watch → resolve loop, so this skill is thin: run it, and if it reached PR-ready, merge.

## When to use this vs the pieces

- **`/inc:ship-it`** — go all the way to merged + deployed.
- **`/inc:review-and-pr`** — stop at a feedback-clean PR for a human to merge.
- **The individual skills** — stop after one specific step.

## Asking the user — make "waiting on you" unambiguous

This chain interleaves long passive waits (watcher polling, resolve-pr-feedback running) with explicit decision points. Whenever this skill needs the user to choose between concrete options, use the platform's blocking question tool — `AskUserQuestion` in Claude Code, `request_user_input` in Codex, `ask_user` in Gemini. **Never** present the choice as numbered prose — the user can't tell whether you're waiting or watching. Status updates and one-sentence confirmations are not decisions; keep those as prose.

Most forks live inside the underlying skills. This skill's own fork is the Step 3 `MERGE: BLOCK` case below.

## Step 1 — Pre-flight (one sentence)

Set expectations, then proceed (no question — the user invoked the chain knowing what it does):

> Ready to ship via `/inc:ship-it`. This will: review your working changes (auto-applying safe fixes), open/refresh the PR, wait for CI + AI reviewers, auto-resolve feedback (pausing only for items that need your call), then run the merge gates and observe the deploy. Natural pause points are between phases — say "stop" anytime and the chain ends cleanly. Continuing now.

## Step 2 — Run inc:review-and-pr

```
Skill: inc:review-and-pr
```

This runs the whole front of the pipeline: tier-selected review gate → commit-push-PR → watch CI + AI reviewers → resolve-feedback loop → stop at PR-ready. It owns all the watching and feedback resolution; this skill just waits for it to return.

**It stops short** (and so does this chain — surface its message and stop) when:
- the review gate found `ask_user` findings (the user must address them and re-run),
- `inc:commit-push-pr-4` opened no PR (intent interview aborted, or nothing to push),
- CI failed in a way the chain can't pass, or
- resolve-pr-feedback hit a thread needing human attention it couldn't progress past.

**Only when it reaches PR-ready** — CI green, AI-reviewer threads addressed, PR printed with "Ready for human merge" — proceed to Step 3.

## Step 3 — Run inc:merge-pr-5

```
Skill: inc:merge-pr-5
```

merge-pr runs its own pre-flight (branch freshness), the three merge gates (new env vars; PR health; deploy-window timing), the squash-merge, and active deploy observation. Wait for it to return.

- **`MERGE: GO`** and a successful deploy observation → the chain is complete.
- **`MERGE: BLOCK`** → surface the blocking gate(s) verbatim. If a gate is a user-judgment call (not a hard fail), ask (blocking question) whether to retry-after-fix or stop. The user resolves the gate and either re-runs `/inc:merge-pr-5` directly or `/inc:ship-it` from the top.

## Step 4 — Final report

```
=== SHIP-IT REPORT ===
1. review-and-pr:  <PR #N ready | stopped: review gate (N ask_user) | stopped: reason>
2. merge-pr:       <MERGE: GO, deploy observed Ready | MERGE: BLOCK gate(s) X, Y | not reached>

OUTCOME: <SHIPPED | STOPPED at step N — reason>
```

---

## Anti-patterns

| Don't | Why |
|---|---|
| Reimplement review-and-pr's or merge-pr's logic here | They each have their own discipline and version cadence. This skill is glue, not a rewrite. |
| Run merge-pr before review-and-pr returns PR-ready | review-and-pr orders review → commit → CI-green → feedback-resolved precisely so merge happens on a clean, reviewed PR. Merging early bypasses that. |
| Skip the underlying skills' confirmation gates by passing flags through | The whole point is that the chain respects each skill's safety checks. |
| Auto-debug CI failures | Out of scope. review-and-pr surfaces them and stops; so does this chain. |
