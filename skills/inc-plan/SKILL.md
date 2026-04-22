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
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null)
DEFAULT=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null | sed 's|^origin/||')
DEFAULT=${DEFAULT:-main}
if [ -n "$CURRENT_BRANCH" ] && [ "$CURRENT_BRANCH" != "$DEFAULT" ]; then
  git fetch origin "$DEFAULT" --quiet 2>/dev/null
  git rev-list --left-right --count HEAD..."origin/$DEFAULT" 2>/dev/null
fi
```

If the second number (commits behind) is > 0, surface it to the user in one line before entering plan mode:

> Heads up: this branch is **N commits behind `<default>`**. Run `/inc:update-code` first if you want the plan to reflect the latest `<default>`.

Do not block, prompt, or update on the user's behalf — they may intentionally be planning against their current base. Skip this notice silently when the branch is up to date, on the default branch, or not in a git repo.

`EnterPlanMode` is a deferred tool in Claude Code — load it first:

```
ToolSearch(query: "select:EnterPlanMode")
```

Then call `EnterPlanMode` with your proposed plan as the `plan` argument. Do not edit files before approval.
