---
name: inc:visual-plan
description: Create and iterate hosted visual plans for coherent feature work, using the live block catalog and the Incubator Build REST API.
allowed-tools: Read, Bash
---

# Hosted visual plans

Use this skill when a feature needs a reviewable plan with structured prose, decisions, diagrams, wireframes, or a human approval loop.
Skip it for a trivial, one-line, fully specified change.
Never pad a plan with filler or create a one-step plan.

This skill is adapted from [BuilderIO/skills visual-plan](https://github.com/BuilderIO/skills/tree/main/skills/visual-plan), which is MIT licensed.
The hosted REST workflow, M1 command names, and Incubator Build rules below are local adaptations of that workflow.
The retained copyright and license text is in [NOTICE.md](NOTICE.md).

## The plan voice

A hosted plan is read by a reviewer deciding whether to approve the work, not by an engineer executing it.
This is the same voice as a good PR body: intent first, evidence on demand.

**Core principle.**
The reviewer sees outcomes first: why the work matters, what they get when it ships, where it stands, and what still needs their call.
Anything a reader could reconstruct by opening the repo — the file list, the code narration, the command sequence — is not the plan.
It is supporting detail that lives behind a `Collapse` the reviewer opens on demand.
Every hard rule below is a consequence of this principle; if a rule and the principle ever disagree, the principle wins.

**Hard rules for the plan writer. Do not rationalize around these:**

- **Lead with the outcome, never a file list.**
  The main body opens on why and what-you-get, the way a PR body opens on `### Why?`.
  A `FileTree`, `ImplementationMap`, `Diff`, or raw command list never sits in the spine of the plan.
- **Frame every decision as an outcome, not an engineering artifact.**
  Use the `Decision` block.
  Write `question` as the choice in the reviewer's terms.
  Write each option's `detail` as what happens if you pick it — the consequence the reviewer is actually weighing — not the code it implies.
  Set `recommended` to your default and say why in that option's detail.
- **Put implementation detail behind a `Collapse`.**
  Files touched, exact snippets, command sequences, payloads, and the ordered build steps go inside a `Collapse` whose `title` names what is inside ("Files and build order", "Full migration SQL").
  Give the reviewer the ability to dive deeper if they choose; never force it into the main read.
- **Never narrate code changes in the body.**
  No "updates the foo handler to bar".
  State the outcome the change produces for the reviewer; the mechanism belongs in the `Collapse`.
- **Wireframe only when a visual state is the decision.**
  A `Wireframe` or `Screen` earns its place only when the reviewer must compare what they would see on screen.
  When the call is about behavior, data, or sequencing rather than pixels, a `Table`, `Callout`, or `Decision` comparison carries it better than a mockup.
  An anemic wireframe — device chrome around three labels — is worse than one clear sentence.
  When you do wireframe, make it content-rich per [references/wireframe.md](references/wireframe.md).
- **Make "done" checkable, not a vibe.**
  Express success criteria as outcomes the reviewer can verify, in a `Checklist`, each paired with the focused command or check that proves it.
- **One coherent feature per plan.**
  Split independent features into separate plans, even when they share a repository.
- **Never pad.**
  No one-step plans, no filler prose, no restating the catalog.

| Don't | Why |
|---|---|
| Open with a `FileTree` or step list | The reviewer wants the outcome first; files are detail for a `Collapse` |
| Narrate code changes in the body | The reviewer reads a plan to decide, not to execute |
| Phrase a decision as "use library X vs Y" | Frame it as the outcome each choice produces, so a non-author can weigh it |
| Drop a wireframe when the call is not visual | An empty mockup adds chrome, not information; use a `Table` or `Decision` |
| Bury the decision that needs a human at the bottom of a spec | Surface what needs their call where they will see it |

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

Distill the conversation into the plan's framing: the goal and expected outcome, the audience and reviewer, the constraints and non-goals, and the decision or approval the plan is meant to support.

Conversation is for discovery.
The plan is the durable record of the conclusions.

## 2. Research before authoring

Read the real files before drafting.
Know the existing symbols, routes, components, tests, and codebase patterns the work touches, so the outcomes you promise are grounded and the detail you collapse is accurate.
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

Order the body the way a reviewer reads, not the way the code is built:

1. **Framing — outcome first.**
   Open with why the work matters and what the reviewer gets when it ships.
   State audience, constraints, non-goals, and the decision the plan supports.
   A teammate who never saw the chat should get the point from the first block.
2. **The calls that need a human.**
   Put all open choices in one unified `Decision` list or container when that serves the review, or use individual `Decision` blocks when it does not.
   Phrase each choice as an outcome with a recommended default.
   Gather several smaller answers in one `QuestionForm` when the catalog exposes it.
3. **Where it stands and what proves it done.**
   Give measurable success criteria as a `Checklist`, each paired with a focused verification command.
4. **Supporting detail, behind `Collapse` blocks.**
   The curated file list, ordered build steps, exact snippets, payloads, and API contracts are opt-in.
   `FileTree`, `ImplementationMap`, `Code`, `Diff`, `DataModel`, and `ApiEndpoint` live inside a `Collapse`, not in the spine.

Choose each document block for the meaning it carries, and keep the prose outcome-first and self-contained.
Read [references/document-quality.md](references/document-quality.md) before authoring the document.

Reach for a canvas only when the reviewer must compare visible states to make the call.
Author the canvas first in that case, one artboard per meaningful state, with short annotations for product intent and the implementation detail kept in `plan.mdx`.
Read [references/canvas.md](references/canvas.md) before authoring or changing a canvas.
For a document-only plan, omit `canvas.mdx`.

For any `Wireframe` or `Screen`, read [references/wireframe.md](references/wireframe.md) first.
Use semantic HTML only.
Do not put colors, font sizes, dimensions, or other visual pixels in inline HTML styles.
For wireframes, inline flex or grid layout with `gap` is allowed when required by [references/wireframe.md](references/wireframe.md).
The renderer owns those pixels.
Use only the renderer's catalog tokens, helper classes, surfaces, and icon markers.

## 4. Create and surface the deliverable

Create and capture the plan once with the live source files.
The command below is the only create invocation.
It prints the hosted `/p/` URL to stdout and, when available, a second `reviewUrl:` line.
Surface both URLs verbatim in chat.
The URL is the deliverable for a CLI host.
Do not replace it with a summary, a shortened link, or a path copied from memory.

```bash
CANVAS_ARGS=()
if [ -f /tmp/<dir>/canvas.mdx ]; then
  CANVAS_ARGS=(--canvas /tmp/<dir>/canvas.mdx)
fi
CREATE_OUTPUT="$("${INC_BUILD[@]}" plan create \
  --project <project-slug> \
  --title "<plan title>" \
  --plan /tmp/<dir>/plan.mdx \
  "${CANVAS_ARGS[@]}")"
printf '%s\n' "$CREATE_OUTPUT"
REVIEW_URL="$(printf '%s\n' "$CREATE_OUTPUT" | awk '
  /^reviewUrl: / { sub(/^reviewUrl: /, ""); review = $0 }
  END { print review }
')"
PLAN_URL="$(printf '%s\n' "$CREATE_OUTPUT" | awk '/^https?:\/\// { plan = $0 } END { print plan }')"
OPEN_URL="${REVIEW_URL:-$PLAN_URL}"
if [ -n "$OPEN_URL" ]; then
  "${INC_BUILD[@]}" plan open "$OPEN_URL"
fi
```

The `printf` keeps both hosted links visible in chat.
The `plan open` command first checks for a live, enabled cmux browser using the same socket gate as `cmux-browser`.
It never calls cmux outside that gate.
There is no stable Claude Desktop or ChatGPT Desktop browser signal or navigation command to detect here, so do not guess either host.
When no reliable in-app browser is available, `plan open` runs `open -a "Google Chrome" <url>` on macOS and `xdg-open <url>` elsewhere.
If the browser launch fails, keep the printed URL and report the launcher error.

To mint or rotate a writable reviewer link on demand, read a fresh `updatedAt` (Step 5) and call:

```bash
"${INC_BUILD[@]}" plan share <planId> [--rotate] --expect <fresh-updated-at>
```

The command prints the plan `url` and the `reviewUrl:` line.
Use `--rotate` to invalidate the previous review link and issue a new one.

When `plan share` is used during authoring, apply the same launch rule to its output: choose `reviewUrl` first, then `url`, print the selected link verbatim, and run `"${INC_BUILD[@]}" plan open "$OPEN_URL"`.

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

Obtain a fresh `updatedAt` from `plan get` immediately before the single replacement write below.
Keep `REVIEW_URL` from the create or share response in the authoring session when one exists.
Use it only when the replacement response has no URL.
The command below is the only replacement invocation.
After a successful replacement, print the response and open its `reviewUrl`, then its `url`, then the retained `REVIEW_URL`:

```bash
CANVAS_ARGS=()
if [ -f /tmp/<dir>/canvas.mdx ]; then
  CANVAS_ARGS=(--canvas /tmp/<dir>/canvas.mdx)
fi
REPLACE_OUTPUT="$("${INC_BUILD[@]}" plan replace <planId> \
  --plan /tmp/<dir>/plan.mdx \
  "${CANVAS_ARGS[@]}" \
  --expect <fresh-updated-at>)"
printf '%s\n' "$REPLACE_OUTPUT"
REPLACEMENT_URL="$(printf '%s' "$REPLACE_OUTPUT" | node --input-type=module -e '
  let input = "";
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    const result = JSON.parse(input);
    process.stdout.write(result.reviewUrl ?? result.url ?? "");
  });
')"
OPEN_URL="${REPLACEMENT_URL:-$REVIEW_URL}"
if [ -n "$OPEN_URL" ]; then
  printf '%s\n' "$OPEN_URL"
  "${INC_BUILD[@]}" plan open "$OPEN_URL"
fi
```

The explicit `printf` keeps the selected URL visible even when the replacement response is JSON.

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

Confirm that the plan:

- Opens on the outcome — why the work matters and what the reviewer gets — before any detail.
- Covers one coherent feature scope.
- States constraints and non-goals plainly.
- Puts every call that needs a human in a `Decision` (or `QuestionForm`), phrased as outcomes with a recommended default.
- Keeps the file list, build steps, snippets, and payloads behind `Collapse` blocks, not in the spine.
- Uses a wireframe only where a visual state is the decision, and makes it content-rich when it does.
- Gives measurable, checkable success criteria with focused verification commands.
- Keeps stable, unique ids across all source files.
- Has been re-read from a fresh `plan get` after the last write.

Return the hosted `/p/` URL verbatim in the final chat response.
