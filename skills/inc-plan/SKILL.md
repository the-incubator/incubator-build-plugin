---
name: inc:plan-1
description: Create a reviewable implementation plan before any edits. In Claude Code, enters plan mode; in Codex or other agents, presents the plan and waits for approval. Use when the user says "plan this", "plan the implementation", "how should we build X", or wants an alignment step before coding.
argument-hint: "[task description, or blank to plan the current conversation's task]"
disable-model-invocation: false
---

Create a plan so the user can approve an approach before you write code.

**Plugin scripts:** Commands that use `<plugin root>` need the installed `incubator-build` plugin directory. In Claude Code, use `${CLAUDE_PLUGIN_ROOT}`. In Codex, resolve it from the loaded skill path: the plugin root is two directories above this `SKILL.md`.

## Pre-flight: Report branch freshness (notify only)

Before entering plan mode, check how far the current branch is behind `main` so the plan is informed by current state. **Do not auto-update** — this is a notification only.

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<plugin root>}"
OUT=$(bash "$PLUGIN_ROOT/scripts/branch-freshness")
DEFAULT=$(printf '%s\n' "$OUT" | sed -n 's/^DEFAULT=//p')
REF=$(printf '%s\n' "$OUT" | sed -n 's/^REF=//p')
BEHIND=$(printf '%s\n' "$OUT" | sed -n 's/^BEHIND=//p')
```

If `$BEHIND` is > 0 **and** `$REF` is not the default branch, surface it to the user in one line before entering plan mode:

> Heads up: this branch is **$BEHIND commits behind `$DEFAULT`**. Run `/inc:update-code` first if you want the plan to reflect the latest `$DEFAULT`.

Do not block, prompt, or update on the user's behalf — they may intentionally be planning against their current base. Skip this notice silently when the branch is up to date, on the default branch, or not in a git repo.

In Claude Code, `EnterPlanMode` is a deferred tool — load it first:

```
ToolSearch(query: "select:EnterPlanMode")
```

Then call `EnterPlanMode` with your proposed plan as the `plan` argument. Do not edit files before approval.

In Codex or any platform without `EnterPlanMode`, write the proposed plan in the conversation and wait for explicit user approval before editing.
