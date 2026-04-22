---
name: inc:plan-1
description: Enter Claude Code's plan mode so the user can review and approve an approach before any edits. Use when the user says "plan this", "plan the implementation", "how should we build X", or wants an alignment step before coding.
argument-hint: "[task description, or blank to plan the current conversation's task]"
disable-model-invocation: false
---

Enter plan mode so the user can approve an approach before you write code.

## Pre-flight: Report branch freshness (notify only)

Before entering plan mode, check how far the current branch is behind `main` so the plan is informed by current state. **Do not auto-update** — this is a notification only.

```bash
OUT=$(bash "${CLAUDE_PLUGIN_ROOT}/scripts/branch-freshness")
DEFAULT=$(printf '%s\n' "$OUT" | sed -n 's/^DEFAULT=//p')
REF=$(printf '%s\n' "$OUT" | sed -n 's/^REF=//p')
BEHIND=$(printf '%s\n' "$OUT" | sed -n 's/^BEHIND=//p')
```

If `$BEHIND` is > 0 **and** `$REF` is not the default branch, surface it to the user in one line before entering plan mode:

> Heads up: this branch is **$BEHIND commits behind `$DEFAULT`**. Run `/inc:update-code` first if you want the plan to reflect the latest `$DEFAULT`.

Do not block, prompt, or update on the user's behalf — they may intentionally be planning against their current base. Skip this notice silently when the branch is up to date, on the default branch, or not in a git repo.

`EnterPlanMode` is a deferred tool in Claude Code — load it first:

```
ToolSearch(query: "select:EnterPlanMode")
```

Then call `EnterPlanMode` with your proposed plan as the `plan` argument. Do not edit files before approval.
