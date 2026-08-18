---
name: inc:visual-plan
description: Create and iterate hosted visual plans for coherent feature work, using the live block catalog and the Incubator Build REST API.
allowed-tools: Read, Bash
---

# Hosted visual plans

Use this skill when a feature needs a reviewable plan with structured prose, diagrams, wireframes, or a human approval loop.
Skip it for a trivial, one-line, fully specified change.
Never pad a plan with filler or create a one-step plan.

This skill is adapted from [BuilderIO/skills visual-plan](https://github.com/BuilderIO/skills/tree/main/skills/visual-plan), which is MIT licensed.
The hosted REST workflow, M1 command names, and Incubator Build rules below are local adaptations of that workflow.
The retained copyright and license text is in [NOTICE.md](NOTICE.md).

## Command setup

Set `PLUGIN_ROOT` to the installed plugin root.
In Claude Code, use `${CLAUDE_PLUGIN_ROOT}`.
In Codex, use the plugin root resolved from this skill directory.

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<plugin-root>}"
INC_BUILD=(node "$PLUGIN_ROOT/scripts/inc-build.mjs")
```

The examples below use `"${INC_BUILD[@]}"` so they work when the plugin is installed without a global `inc-build` alias.

## 1. Discover in chat

Ask short, adaptive discovery questions in chat before authoring when the codebase does not already answer them.
Skip questions that the repository, task, or existing product decisions already answer.
Do not turn the chat into a questionnaire.

Put the distilled conclusions in the plan's framing section:

- Goal and expected outcome.
- Audience and reviewer.
- Constraints, non-goals, and known dependencies.
- The decision or approval the plan is meant to support.

Conversation is for discovery.
The plan is the durable record of the conclusions.

## 2. Research before authoring

Read the real files before drafting.
Name existing symbols, routes, components, tests, and codebase patterns.
Planning is read-only.
Do not edit product source while building the plan.

Use one hosted plan for one coherent feature.
Create separate plans for independent features, even when they share a repository.

Before every authoring pass, including an iteration pass, call:

```bash
"${INC_BUILD[@]}" plan blocks
```

Treat that response as the only authority for tags, required props, child rules, tokens, helper classes, and icons.
Never author from memorized tags or from an old catalog response.

## 3. Compose the source

Create `plan.mdx` and, for UI work, an optional `canvas.mdx` in a temporary directory.
Use only blocks returned by the current `plan blocks` catalog.
Keep block ids stable, agent-assigned, and unique across both files.

Start `plan.mdx` with a clear framing section.
Then use an explicit outline with constraints stated before implementation detail.

Include:

- A curated file list that points to existing implementation patterns.
- Links to relevant external documentation.
- Granular task titles.
- Ordered implementation steps for each task.
- Measurable success criteria and focused verification commands.
- Risks, non-goals, and unresolved decisions.

Use document blocks for the information they represent.
Use diagrams for relationships, API blocks for endpoint contracts, file trees for scoped files, and code blocks for exact snippets.
Keep the prose outcome-first and self-contained.

For a UI or product plan, author the canvas first when the reviewer must compare visible states.
Use one artboard per meaningful state.
Use short annotations for product notes and keep implementation detail in `plan.mdx`.
Read [references/canvas.md](references/canvas.md) before authoring or changing a canvas.

For a document-only plan, omit `canvas.mdx`.
Read [references/document-quality.md](references/document-quality.md) before authoring the document.

For any `Wireframe` or `Screen`, read [references/wireframe.md](references/wireframe.md) first.
Use semantic HTML only.
Do not put colors, font sizes, spacing, dimensions, or other visual pixels in inline HTML styles.
The renderer owns those pixels.
Use only the renderer's catalog tokens, helper classes, surfaces, and icon markers.

## 4. Create and surface the deliverable

Create the plan with the live source files:

```bash
"${INC_BUILD[@]}" plan create \
  --project <project-slug> \
  --title "<plan title>" \
  --plan /tmp/<dir>/plan.mdx \
  [--canvas /tmp/<dir>/canvas.mdx]
```

The command prints the hosted `/p/` URL to stdout.
Surface that URL verbatim in chat.
The URL is the deliverable for a CLI host.
Do not replace it with a summary, a shortened link, or a path copied from memory.

## 5. Read and iterate safely

Read the current plan before an iteration:

```bash
"${INC_BUILD[@]}" plan get <planId> --out /tmp/<dir>
```

The command writes the current `plan.mdx` and, when present, `canvas.mdx`.
It prints the plan metadata, including `updatedAt`, to stderr.
Review the persisted files before editing them.

The live M1 API stores source files as a complete replacement.
Both `plan patch` and `plan replace` therefore send the full current file set to `PUT .../source`.
Never send a partial file set.

Obtain a fresh `updatedAt` from `plan get` immediately before a write:

```bash
"${INC_BUILD[@]}" plan replace <planId> \
  --plan /tmp/<dir>/plan.mdx \
  [--canvas /tmp/<dir>/canvas.mdx] \
  --expect <fresh-updated-at>
```

After every successful write, call `plan get` again.
Compare the persisted source, block ids, block count, and canvas states with the intended result.
Do not treat a successful mutation response as proof that unrelated content survived.

The targeted MDX operation form is a Phase 3 API feature.
Do not pass `--ops` to the current M1 client.
The CLI keeps the feedback and consume verbs as explicit Phase 3 stubs until that API is live.

Comments are part of the living-document workflow.
When reviewer feedback is available through the Phase 3 API, ingest it, refine the source, verify the persisted result, and resolve only feedback that the change actually addresses.
Until then, use a fresh read and a fenced full replacement for iteration.

## 6. Final check

Confirm that the plan has:

- A framing section with the chat conclusions.
- One coherent feature scope.
- An explicit outline and constraints.
- A curated, source-backed file list.
- External documentation links where useful.
- Granular tasks with steps and measurable success criteria.
- Stable unique ids across all source files.
- Semantic wireframe HTML with renderer-owned pixels.
- A fresh read after the last write.

Return the hosted `/p/` URL verbatim in the final chat response.
