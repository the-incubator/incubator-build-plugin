# Document quality

This guidance is adapted from [BuilderIO/skills visual-plan document guidance](https://github.com/BuilderIO/skills/tree/main/skills/visual-plan), which is MIT licensed.

## Framing

Start with the outcome.
State the goal, audience, constraints, non-goals, and approval decision in the framing section.
These are the distilled conclusions from the pre-interview in chat.

Use an explicit outline.
State constraints before the implementation tasks.
Make the plan readable by a teammate who did not see the chat.

## Grounding

Point to real files, symbols, routes, schemas, and tests.
Build a curated file list from existing codebase patterns.
Link external references when they affect implementation or acceptance.
Avoid broad file dumps and guessed paths.

## Tasks

Give every task a clear title.
Write ordered implementation steps that explain what changes and what existing pattern is reused.
Add measurable success criteria.
Name the focused test, typecheck, build, or browser check that proves each criterion.
List risks and non-goals instead of hiding them in vague language.

## Living plan

Treat the hosted plan as a living document.
Refine the source as new evidence or reviewer comments arrive.
Keep stable ids so feedback remains addressable.
Use one plan per coherent feature and split unrelated work into separate plans.

Put unresolved judgment calls in one bottom `QuestionForm` when that block exists in the live catalog.
Include a recommended default and the impact of each choice.
Do not silently resolve a product decision in implementation prose.

## Final review

Read the persisted plan after the last write.
Check that the outline is complete, the file list is curated, tasks are granular, and success criteria are measurable.
Check that any canvas or wireframe follows its reference guidance.
