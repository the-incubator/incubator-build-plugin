---
name: inc:review-and-pr
description: Review working-tree changes (tiered light/deep), then commit-push-PR — which watches CI + AI reviewers and auto-resolves feedback — stopping at a feedback-clean PR ready for a human to merge. Use when the user says "review and PR", "review then ship to PR", "/inc:review-and-pr", or wants working changes vetted and turned into a PR without merging.
allowed-tools: Skill, Bash(gh *), Bash(git *), Read
---

# Review and PR: review → commit/push/PR (watches + resolves feedback), stopping at PR-ready

Orchestrates existing skills so the user runs one command. This skill **does not reimplement** their logic — it hands off via the `Skill` tool and waits at the right points. It ends at a feedback-clean PR; it never merges (use `inc:ship-it` for merge + deploy).

The chain: **review gate → commit-push-PR → stop.** `inc:commit-push-pr-4` now owns the post-open work — it watches CI + AI reviewers and auto-resolves feedback in a loop before returning. If any stage blocks, surface the result and stop; the user resumes manually.

## Step 0 — Select the review tier

Compute the diff once against the resolved base (try PR metadata, then the remote default branch, then `main`/`master`):

```
git diff --stat <base>...HEAD ; git diff --name-only <base>...HEAD
```

Default to **Tier 1 — `inc:review-3a`** (fast single-agent pass). Escalate to **Tier 2 — `inc:review-deep-3b`** (persona fan-out + dedup) if ANY trigger holds:

1. **Sensitive surface** — the changed files touch authentication/authorization, payments/billing, data migrations or backfills, cryptography or secret handling, security-relevant config, public API or library contracts, or dependency manifests.
2. **Large + diffuse** — ≥400 changed lines AND (>3 directories OR >2 distinct subsystems). Either alone is a soft signal; together they escalate.
3. **Very large** — ≥1,000 changed lines, regardless of spread.
4. **Explicit request** — the plan, originating task, or an in-scope instruction asks for a full / deep / thorough review.

Announce the chosen tier and the trigger in one line before running (e.g. `Tier 2 (inc:review-deep-3b): diff touches auth middleware.`).

## Step 1 — Review gate

Stamp the time **before** running the review, so the gate can tell a fresh artifact from a stale one left by an earlier invocation:

```
REVIEW_STAMP=$(mktemp)
```

Run the selected tier on the working tree via the `Skill` tool — `inc:review-3a` or `inc:review-deep-3b`. It auto-applies safe fixes and writes its synthesized findings to `.context/incubator/inc-review/<run-id>/findings.json`.

Then read the gate signal — and **fail closed** if the review produced no fresh artifact (it may have exited early, e.g. `No changes to review`, or errored). Do not default a missing artifact to "0 → proceed":

```
RUN_DIR=$(ls -1dt .context/incubator/inc-review/*/ 2>/dev/null | head -1)
if [ -z "$RUN_DIR" ] || [ ! -f "$RUN_DIR/findings.json" ] || [ -z "$(find "$RUN_DIR/findings.json" -newer "$REVIEW_STAMP" 2>/dev/null)" ]; then
  ASK_USER=ERROR
else
  ASK_USER=$(python3 -c "import json; d=json.load(open('$RUN_DIR/findings.json')); print(sum(1 for f in d if f.get('autofix_class')=='ask_user'))" 2>/dev/null || echo ERROR)
fi
rm -f "$REVIEW_STAMP"
```

- **`ASK_USER` == `ERROR` → STOP.** The review didn't produce a fresh `findings.json` for this run — most likely there were no changes to review, or the review skill errored. Say so and stop; there's nothing vetted to commit. Do not proceed.
- **`ASK_USER` > 0 → STOP.** The findings are already presented on screen by the review skill. Say: *"Review found N items needing your call (above). Address them, then re-run `/inc:review-and-pr` to continue."* Do not commit. Do not offer to proceed anyway.
- **`ASK_USER` == 0 → proceed.** The auto-fixes are already in the working tree and get committed in Step 2.

## Step 2 — Commit + open/refresh PR, then watch + auto-resolve

`Skill: inc:commit-push-pr-4`. It runs its own intent interview, commits (the review's auto-fixes + the user's code), opens/refreshes the PR, and then — in its Step 14 loop — watches CI + AI reviewers and **auto-resolves feedback** in unattended mode (fix → push → resolve, only `needs-human` items pause it). This chain just waits for it to return.

It (and therefore this chain) stops short when:
- the intent interview aborted or there was nothing to push (no PR opened),
- `CI_FAIL` made the PR un-passable,
- the auto-resolve loop hit a `needs-human` item it couldn't action, or a `PREVIEW_FAIL`/`WATCH_TIMEOUT` fork.

Surface whatever it reported and stop. Only when it returns a **feedback-clean PR** does the chain continue to Step 3.

## Step 3 — Stop at PR-ready

Print the PR URL and `Ready for human merge.` Do **not** run `inc:merge-pr-5`.

## Interaction discipline

This skill itself has no blocking prompts — the watch + auto-resolve loop lives inside `inc:commit-push-pr-4`, which surfaces its own forks (CI failure, `needs-human`, preview failure) and stops. If anything blocks (review-gate stop in Step 1, or commit-push-pr returning short), surface the result and stop cleanly — the user resumes manually from that step.

## When to use this vs the pieces

- **`/inc:review-and-pr`** — vet working changes and turn them into a feedback-clean PR, stopping short of merge.
- **`/inc:ship-it`** — same but continues through merge + deploy.
- **The individual skills** — when you want to stop after one specific step.
