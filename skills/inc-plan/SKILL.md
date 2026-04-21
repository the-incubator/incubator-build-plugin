---
name: inc:plan-1
description: Enter Claude Code's plan mode so the user can review and approve an approach before any edits. Use when the user says "plan this", "plan the implementation", "how should we build X", or wants an alignment step before coding.
argument-hint: "[task description, or blank to plan the current conversation's task]"
disable-model-invocation: false
---

Enter plan mode so the user can approve an approach before you write code.

`EnterPlanMode` is a deferred tool in Claude Code — load it first:

```
ToolSearch(query: "select:EnterPlanMode")
```

Then call `EnterPlanMode` with your proposed plan as the `plan` argument. Do not edit files before approval.
