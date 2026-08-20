# Document quality

This guidance is adapted from [BuilderIO/skills visual-plan document guidance](https://github.com/BuilderIO/skills/tree/main/skills/visual-plan), which is MIT licensed.

The plan voice is intent-driven: the reviewer sees outcomes first and opts into detail.
See "The plan voice" in SKILL.md for the core principle and hard rules; this file expands them section by section.

## Framing — outcome first

Open on the outcome, the way a PR body opens on `### Why?`.
Do not re-title the plan inside the framing block.
The hosted page already renders the plan title as its h1, so a leading `#` heading duplicates it.
Use `##` for top-level sections.
The renderer demotes `###` to h4 and flattens the hierarchy.
State why the work matters and what the reviewer gets when it ships before anything else.
Then state the audience, the constraints, the non-goals, and the approval decision the plan supports.

These are the distilled conclusions from the discovery chat.
Make the framing readable by a teammate who never saw the conversation.
Do not open with a file list, a step list, or a code narration — those are detail, and detail comes later and on demand.

## Decisions as outcomes

Put every call that needs a human in one unified decisions list when that single container serves the reviewer's scan, not in prose the reviewer has to mine for.
Do not scatter separate `Decision` blocks through the document when a unified list serves.
Phrase the `question` as the choice in the reviewer's terms, not the engineering framing.
Phrase each option's `detail` as the consequence of choosing it — what the reviewer, the user, or the system gets or loses — not the code that option implies.
Set `recommended` to your default and use its detail to say why.
Use one `QuestionForm` to gather several smaller answers when the block exists in the live catalog; reserve `Decision` for a call that changes the plan.
Never silently resolve a product decision inside implementation detail.

## Grounding — accurate, not exhaustive

The outcomes you promise must be grounded in the real code: real files, symbols, routes, schemas, and tests.
That grounding shows up as accurate claims in the body and an accurate curated file list in a `Collapse`, not as a file dump in the spine.
Link external references when they affect the implementation or the acceptance decision.
Avoid broad file dumps and guessed paths.

## Detail behind collapses

Everything a reader could reconstruct by opening the repo is supporting detail, and supporting detail lives behind a `Collapse` the reviewer opens on demand.
The curated file list, the ordered build steps, exact snippets, payloads, and API contracts go inside a `Collapse` whose `title` names what is inside.
`FileTree`, `ImplementationMap`, `Code`, `Diff`, `DataModel`, and `ApiEndpoint` belong here, not in the main read.
Give the reviewer the ability to dive deeper if they choose; never force the mechanism into the outcome-level read.

## ImplementationMap steps

Use short, verb-led headlines for `ImplementationMap` step titles.
Keep each title to 3-6 words, such as `Build the broker`.
Put the implementation detail in the step's `note` field as subtext.
Never pack multiple details into a comma-separated title.

Good versus bad:

| Good | Bad |
| --- | --- |
| `title="Build the broker"`<br>`note="Route jobs through the shared queue and expose retry state."` | `title="Broker, queue, retries, metrics, and tests"` |

## Success as checkable outcomes

Express success criteria as outcomes the reviewer can verify, in a `Checklist`.
Pair each with the focused test, typecheck, build, or browser check that proves it.
State risks and non-goals plainly instead of hiding them in vague language.

## Living plan

Treat the hosted plan as a living document.
Refine the source as new evidence or reviewer comments arrive.
Keep stable ids so feedback and decisions remain addressable.
Use one plan per coherent feature and split unrelated work into separate plans.

## Final review

Read the persisted plan after the last write.
Check that it opens on the outcome, that human calls use one unified decisions list when it serves the review, that files and steps sit behind `Collapse` blocks, and that success criteria are measurable.
Check that any canvas or wireframe follows its reference guidance and earns its place.
