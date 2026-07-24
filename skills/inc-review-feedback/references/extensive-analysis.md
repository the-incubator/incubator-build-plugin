# Extensive analysis path

Use this path when the input is a longer recording (over ~60 seconds), contains multiple issues, requirements, or workflow walkthroughs, or the user explicitly wants requirements material. The goal is a full structured artifact set that feeds the `inc:plan` skill.

## Workflow

1. Run the analyzer:

   ```bash
   python scripts/analyze_riffrec_zip.py /path/to/input
   ```

   Use `--output-dir <dir>` when the artifact should live somewhere specific. In a repo with `docs/brainstorms/`, the default output goes under `docs/brainstorms/review-feedback/`.

2. Read the generated `analysis.md`, `problem-analysis.md`, `review-prompt.md`, and `requirements-kickoff.md`. The analyzer also writes `report.html` (the human-consumable surface) — you fill and open it in step 8b; do not read it back into context.

3. Read `source-materials.md` before brainstorm. It is the source-of-truth manifest for the original raw feedback location, transcript, local-only frames, chunks, analysis artifacts, and screenshot paths. Use it to keep brainstorm and planning traceable to the original feedback evidence.

4. Inspect the extracted screenshots for high-signal moments using the platform's image-view tool. Prioritize screenshots selected because of click events near verbal complaints, failed network requests, console errors, or repeated interaction.

5. Fill or refine `problem-analysis.md` using the frame review structure from `review-prompt.md`. The final problem analysis must have exactly these top-level categories:

   - **Visual/UI Problems**
   - **Functional Problems**
   - **Requirements**
   - **Usability/UX Problems**
   - **Caveats & Open Questions** — things the reviewer could not evaluate, was unsure about, or
     explicitly flagged as a question. A reviewer saying "I couldn't see X because there's nothing
     live on the backend" belongs here, not in Functional Problems. Do not drop these — they are
     often the highest-signal items, and one may resolve into a real requirement (see step 6b).

   Each numbered item should describe the problem, location, UI element, frame reference, and relevant transcript context when available. Focus on WHAT is wrong, not HOW to fix it.

6. Convert evidence into requirements. Keep these categories distinct:

   - **Observed facts:** transcript quotes, click targets, request statuses, screenshot contents.
   - **Inferences:** likely user intent, likely broken control, suspected missing state.
   - **Requirements:** product behavior needed to resolve the problem.

   **Nuance-preserving rubric — this is the core of the skill.** The analyzer's machine
   signals are deliberately shallow; the real interpretation is yours. A requirement is not
   captured well until it carries the reviewer's *reasoning*, not just the headline. For every
   requirement, fill all seven fields — a blank field means you dropped signal, so go back to
   the transcript:

   - **Statement** — the product behavior needed, in one line.
   - **Rationale** — *why*, in the reviewer's own framing (e.g. "it's almost like a checklist" —
     the mental model, the benefit, the comparison they reached for). This is the field most
     often lost; never drop it.
   - **Parameters** — concrete specifics the reviewer named: colors, states, thresholds, copy,
     ordering, the state machine (e.g. not-played → in-progress → done).
   - **Parity / prior art** — did they say it already exists somewhere ("on the current site we
     have this")? That reframes the work from net-new to port/verify — capture it.
   - **Confidence** — the reviewer's own certainty. "I don't know if it's implemented" is a
     question, not a hard spec; record it as such so planning verifies before building.
   - **Surfaces** — which screens/pages/states it touches. Split distinct surfaces the reviewer
     mentioned separately (e.g. dashboard background vs. signed-out hero) rather than merging
     them into one item.
   - **Verbatim evidence** — the exact quote(s) with timestamp, plus screenshot ref when video
     exists. Quote the reviewer literally; do not paraphrase away their words.

   Fold the reviewer's **written click-comments** (the `annotations` - rendered as
   "Written pins (raw material)" inside the report's synthesis block) in as first-class
   requirements alongside the spoken transcript. They are direct, deliberate reviewer
   intent and must not be treated as secondary to the audio. In the report, badge every
   requirement by source: written, spoken, or both (see step 8b).

6b. **Resolve "couldn't evaluate" caveats — don't just record them.** When the reviewer reports
   they could not assess something because a state wasn't reachable ("nothing live on the backend
   to see the played state", "the empty version is all I can see"), this is a blocker on the
   review itself, and it has two very different causes that look identical in a transcript:

   - **Genuinely not built** → a real product requirement (the state/UI doesn't exist yet).
   - **Built but the reviewer didn't know how to reach it** → *not* a requirement; the fix is
     instructions (play the game, seed a row, hit a `?state=` param, flip an admin toggle).

   When the product source is in the workspace, run a quick **reachability check** against the
   repo: does a path to that state exist, and how is it reached? Resolve the caveat into one of:
   (a) here's how to reach it (surface the instructions), (b) it genuinely doesn't exist yet
   (grounded requirement), or (c) reachable but undocumented (both — give the instructions *and*
   note that previews should expose state entry). If the product source is **not** in the
   workspace, leave the caveat marked **unresolved** with the reachability question stated — do
   not invent a requirement (e.g. "build seed data") that may duplicate something that already
   exists. A caveat should leave this skill as either an answer or a grounded requirement, never
   an ambiguous note.

   > Note: making feature previews arrive review-ready (a declared "state matrix" with a
   > one-click/documented way to reach each state) is a developer + commit-push-pr responsibility,
   > out of scope here. This step only resolves the caveat after the fact.

7. When the current workspace contains the product source code, run a source-mapping pass before or during brainstorm. Use the transcript language, visible UI labels, screenshot paths, route names, and generated requirements to search the codebase for likely components, controllers, services, models, tests, and state stores. For larger sessions, split this mapping by product area and use sub-agents when available so independent areas can be inspected in parallel.

8. Add source mapping to the brainstorm material as suspected implementation surfaces, not as proven root cause unless the code clearly proves it. Include confidence levels and short evidence notes explaining why each file or component is relevant.

8b. **Fill the report and open it.** The analyzer writes `report.html` - the human-consumable
   surface for this session (synthesized requirement cards, the recording with a
   requirement-tracking bar, timestamped transcript). Filling it has two parts, and the file
   carries the exact markup contract inline so you never need to invent structure:

   - **Requirement cards.** Replace everything between the `AGENT-SYNTHESIS-START` /
     `AGENT-SYNTHESIS-END` comments (the placeholder, the example-card comment, and the
     "Written pins (raw material)" cards) with one `<details class="req">` card per
     requirement from step 6, following the example card in the comment. Conventions:
     - The `<summary>` holds the title row, a badge row, and a one-line statement so the
       collapsed card is already informative; the seven-field rubric detail goes in the
       `req-body` `<dl>` with the verbatim quote last.
     - Badge every card by **source**: `src-written` (✎ written), `src-spoken` (🎙 spoken), or
       `src-both` (✎+🎙 written + spoken) when a written pin and the audio cover the same ask.
     - Badge **weight**: `badge ok` for concrete asks, `badge muted-badge` for exploratory ones.
       Match the card's `border-left-color` (green for concrete, default blue for exploratory,
       gray for caveats).
     - Give every timestamp a `button.tstamp` with `data-t` in seconds - these seek the player.
     - Caveats from step 6b get their own card, labeled resolved or unresolved.
   - **Player timeline.** Fill the `SEGMENTS` array in the footer script (marked
     `AGENT-SEGMENTS`) with one entry per stretch of the recording, in playback order, each
     pointing at a requirement card id. This drives the bar under the player that shows which
     requirement the reviewer is talking about as the video plays.

   The file references media by relative path and stays small, so it is cheap to Edit - do not
   inline images or media into `report.html` itself.

   Then **open the report** for the user. Prefer the harness's own in-app/preview browser when it
   has one; otherwise fall back to the OS default browser (`open <path>` on macOS,
   `xdg-open <path>` on Linux, `start <path>` on Windows). The analyzer prints the path as a
   `REPORT_HTML=<abs path>` line for exactly this. Do not read `report.html` back into context to
   verify it - open it in a browser instead.

8c. **Build the shareable standalone when sharing.** `report.html` only plays from its own
   folder. When the user wants to send the report anywhere, run the `STANDALONE_BUILD=` command
   the analyzer printed (`build_standalone.py <output-dir>`) - it writes `report-standalone.html`
   with the media embedded, a single file that plays anywhere. It is a snapshot: rebuild it after
   any edit to `report.html`.

   **Offer deeper dives from the findings.** The report makes evidence explorable: requirement
   cards carry ▶ timestamp chips and each transcript segment is clickable to jump the recording
   to that point. When presenting findings, offer to walk the user to the exact moment - e.g.
   "want me to open the recording at 0:42 where he describes the color states?" - and to expand
   the full transcript. Keep raw recordings and frames local-only per the skill's common rules.

8d. **Triage every requirement into a bucket.** Read `references/feedback-triage.md` and follow
   its procedure: assign each synthesized item exactly one bucket - `change` / `try` / `discuss` /
   `respond` / `blocked` / `defer` - answering "what is the next action, and whose is it?".
   Present the grouped table to the user, flag the judgment calls, apply their adjustments, and
   persist the approved tags as `triage.md` in the analyzer output dir. Verification (step 6b and
   any tentative recollections) must be finished *before* tagging - never tag an unverified claim
   as `change`. Nothing executes until the user approves the table.

   After approval, badge each requirement card in `report.html` with its bucket per the
   conventions comment inside the report's synthesis block (`respond` cards carry the written
   answer inline, `blocked` cards name the owner, `defer` cards carry the backlog pointer), and
   rebuild the standalone (step 8c) if it was already shared. The re-badged report is the closing
   surface that delivers non-code outcomes back to the reviewer.

9. Always continue into planning. Once `analysis.md`, `problem-analysis.md`, `source-materials.md`, `requirements-kickoff.md`, and the approved `triage.md` exist, say "Analysis complete. Ready to plan the findings." Then immediately load the `inc:plan` skill with the generated `requirements-kickoff.md` and `triage.md`, unless the user explicitly asked only to extract or analyze artifacts. The buckets scope the plan: `change` and `try` items are the implementation work (each `try` carrying its stated approach and open question); `discuss` items produce mocks, options, or a short brief instead of code; `respond` items get their written answer into the closing report; `blocked` items are tracked dependencies with a named owner; `defer` items get a backlog pointer. No bucket is silently dropped - every item resurfaces on the re-badged `report.html` (step 8d) as done, tried, asked, answered, waiting, or queued.

10. When `inc:plan` starts, first confirm the captured requirements with the user: "Did this capture the requirements correctly, and what is missing, wrong, or grouped badly?" (The triage table approval in step 8d usually doubles as this confirmation - do not re-ask what the user already adjusted.) Do not move into implementation planning until the requirements have been confirmed or corrected.

## Automatic handoff

Do not end the workflow after extraction in normal use. The intended sequence is:

1. Run the analyzer.
2. Read `source-materials.md` so the planner has direct links to raw feedback, transcript, frames, and analysis artifacts.
3. Inspect or refine `problem-analysis.md` when the evidence needs human-visible interpretation.
4. Triage every item into a bucket and get the user's approval of the table (step 8d, `references/feedback-triage.md`).
5. Load the `inc:plan` skill with `requirements-kickoff.md` and `triage.md`.
6. Ask the user to confirm, correct, or regroup the captured requirements (skip when the step-4 triage approval already covered it - do not re-ask what the user adjusted).
7. Let `inc:plan` produce the durable plan/requirements doc, scoped by the buckets.

Only stop after step 1 or 2 when the user asks specifically for raw artifacts, transcript, screenshots, or analysis without planning.

## Capture scale

Prefer over-capture to under-capture. The purpose of this path is to preserve product feedback as structured data for later AI work, not to decide what is worth implementing during extraction.

When analyzing a feedback source:

- Capture every distinct problem, bug, request, expectation, confusion point, and "note to self" that appears in the transcript or frames.
- Include concrete examples from the source material for each issue when possible: timestamp, transcript phrase, screenshot path, clicked UI element, email/thread ID, or observed state.
- Include concrete source-code mapping when possible: likely component/service/controller/model/test files, route or API endpoint names, relevant state variables, and confidence level. This mapping should make it obvious where a later implementation agent should start looking.
- If only video is available, infer likely screens and components from visible UI labels, layout, URLs, route names, copied text, screenshots, and transcript references. Mark uncertain mappings explicitly instead of omitting them.
- If only audio or notes are available, map from product terminology and workflow descriptions to likely code areas when the repo is present, and label the mapping as transcript-derived.
- Do not drop lower-priority items during analysis. Mark them as lower priority or secondary if needed, but keep them represented.
- Separate capture from prioritization. Brainstorm may regroup, split, defer, or reject items later, but the first requirements pass should preserve the full signal.
- If a feedback session contains many issues, create a comprehensive capture document and state that planning should split it into smaller plans.
- Treat source mapping as supporting material, not a filter. If a problem cannot yet be mapped to code, keep the problem and mark the source mapping as unknown.

## Source mapping grounding

When mapping feedback to source code, classify each mapping as one of:

- **Likely buggy surface:** the code path exists and directly handles the observed behavior.
- **Missing or incomplete surface:** the feedback names a behavior, but the repo has no clear UI, route, controller action, or component implementing it yet.
- **Indirect surface:** the code is adjacent to the behavior, but the exact interaction may happen through rendered email content, third-party UI, generated HTML, or another layer.
- **Unknown:** no grounded source mapping found yet.

Every source mapping should include:

- Requirement/example ids, such as `R14`, `AE4`, or `EX17`.
- File paths with line numbers when practical.
- A short evidence note from code, not just a file guess.
- Confidence: `High`, `Medium`, `Low`, or `Unknown`.

Prefer saying "I did not find a current inbox implementation for this surface" over forcing a speculative mapping. Missing surfaces are useful product findings and should stay in the brainstorm.

## Output shape

The analyzer writes:

- `report.html`: the human-consumable report - synthesized requirement cards (the `AGENT-SYNTHESIS` block you fill in step 8b, with source badges and seek chips), the repaired recording with a requirement-tracking bar (the `AGENT-SEGMENTS` array you fill), and the timestamped transcript. Media is relative-linked; it plays from its own folder.
- `report-standalone.html`: the shareable single file with media embedded, written by `build_standalone.py` (step 8c). Not created by the analyzer itself.
- `triage.md`: the user-approved bucket table (step 8d, `references/feedback-triage.md`) - one bucket per item plus the one line each non-`change` bucket needs downstream. Written by you, not the analyzer.
- `analysis.md`: session summary, transcript, selected moments, screenshot links, candidate findings, and review checklist.
- `problem-analysis.md`: a categorized problem statement scaffold for visual, functional, requirement, and UX findings.
- `review-prompt.md`: a filled prompt containing screenshot paths and transcript for a deeper visual analysis pass.
- `source-materials.md`: a manifest linking the original source location, local-only raw files, transcript locations, chunks, local-only frames, and generated artifacts.
- `requirements-kickoff.md`: a CE-friendly requirements starter with Problem Frame, Actors, Key Flows, R-IDs, Acceptance Examples, Success Criteria, Scope Boundaries, Questions, and Next Steps.
- `analysis.json`: structured session, event, transcript, moment, and artifact metadata.
- `frames/`: extracted PNG screenshots for selected moments. Local-only by default.
- `raw/`: extracted zip contents and copied source media. Local-only by default.

Long media is transcribed in chunks when a single transcription request is too large. Chunk transcripts include timestamp prefixes so the review pass can still connect discussion points to approximate video regions.

For audio-only or notes-only sources, the visual sections intentionally say that no frames are available. In those cases, extract functional problems, requirements, and UX friction from transcript or notes only.

## Review heuristics

Select moments when they contain:

- Verbal complaint cues: "weird", "doesn't work", "can't", "broken", "bug", "problem", "confusing", "should".
- Clicks on controls shortly before or after a complaint.
- Repeated clicks on the same control.
- Failed requests outside known development noise.
- Console errors, uncaught exceptions, or failed form submissions.
- Visible toasts, validation errors, disabled controls, empty states, or surprising navigation.

The script's signals are deliberately shallow and are labeled by kind: a **heuristic-signal**
(e.g. a transcript keyword match) is a weak lexical guess that is frequently a non-issue — the
reviewer may be describing desired behavior or prior art, exactly as in feature/design feedback;
an **observed-signal** (repeated clicks, failed request) is grounded in a recorded event. Never
promote a heuristic-signal to a requirement on the strength of the keyword alone — read the
transcript and frames and judge. And never assume the absence of signals means there is nothing to
capture: design-direction feedback produces no signals at all, yet is full of requirements. The
synthesis in step 6 is the source of truth; the machine signals are only a starting glance.
