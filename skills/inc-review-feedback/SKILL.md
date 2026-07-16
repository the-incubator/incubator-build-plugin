---
name: inc:review-feedback
description: Review product feedback — pull a submission from the incubator collector (feedback left via the preview annotation tool) or analyze a local recording, transcribed LOCALLY with whisper.cpp (no API key, no per-clip cost, audio never leaves the machine). ALWAYS load when the user asks to review/pull/find feedback a reviewer submitted, passes an incubator feedback link (`.../f/<sessionId>`), names a reviewer ("get nick's feedback"), asks for the latest preview feedback on the current branch/project, posts a `riffrec-*.zip` or a bundle with `session.json` + `events.json` + `recording.webm` + `voice.webm`, posts a video/audio recording for product feedback, or asks how to capture and share sessions. Routes between setup, quick bug report, and extensive analysis.
argument-hint: "[a feedback link (.../f/<id>) / reviewer name / \"branch\", or a path to a riffrec-*.zip, video, audio, or notes file]"
---

# Review Feedback

Turn raw product feedback into structured evidence for downstream agents. Feedback reaches you two ways:

- **Submitted to the collector** — a reviewer used the preview annotation tool (click-to-annotate + optional screen/voice recording) on a deployed preview, and it landed in the incubator app. You **fetch** it here.
- **A local recording** — you already have a [Riffrec](https://github.com/kieranklaassen/riffrec) `riffrec-*.zip` (or a video/audio/notes file) on disk.

Either way, transcription runs **locally with whisper.cpp** by default — no `OPENAI_API_KEY`, no per-clip cost, and the audio never leaves the machine. (Adapted from the upstream `ce-riffrec-feedback-analysis` skill; the local backend, collector fetch, and timestamped frame selection are the incubator additions. The OpenAI API path is still available via an env flag — see "Local transcription" below.)

**Plugin scripts:** Commands below use `<plugin root>`, the installed `incubator-build` plugin directory. In Claude Code, use `${CLAUDE_PLUGIN_ROOT}`. In Codex, resolve it from the loaded skill path: the plugin root is two directories above this `SKILL.md`.

## Resolve the input

The input can arrive several ways. Resolve it to a **local file path** first, then continue to "Choose the path". Do this before anything heavy.

**A local file** — a `.zip` / `.mp4` / `.mov` / `.webm` / `.m4a` / `.mp3` / `.wav` / `.md` path already on disk. Use it as-is; skip straight to "Choose the path".

**Anything else — feedback submitted through the preview annotation tool** (it lives in the incubator collector, not on disk). Resolve and download it with the resolver, which handles every non-file form in one place:

```bash
node "<plugin root>/skills/inc-review-feedback/scripts/fetch_feedback.mjs" <query>
```

`<query>` is whatever the user gave you:

- a **feedback link** — `https://…/f/<id>` (pass the URL verbatim; the id is the last path segment)
- a **reviewer name** — `nick` ("get nick's feedback")
- the **current branch** — `--branch`, or no query at all (maps the branch → PR / project → preview host)
- a bare **session id**
- `--list` — print recent submissions and stop (browse mode)

Read the resolver's stdout, then continue:

- `RESOLVED_ZIP=<path>` → feed that zip to the analyzer entrypoint below, exactly like a local file.
- `RESOLVED_ANNOTATIONS=<path>` → the submission has **no recording**; there's nothing to transcribe. Summarize the click-comments in that JSON directly (each has `comment`, `element`, `pageUrl`, and element context) into the quick-bug or extensive artifact — skip transcription.
- exit **2** (ambiguous) → the resolver printed candidate sessions and deliberately did **not** guess across distinct reviewers; show them and ask the user which `sessionId`, then re-run with it.
- exit **1** (no match) / exit **3** (auth or transport) → surface the message. For auth, the check is `node "<plugin root>/scripts/inc-build.mjs" feedback projects` (the CLI uses the plugin's install `credentials.json`); don't retry blindly.

The full query table, output contract, and exit codes live in `references/fetch-from-collector.md`.

## Choose the path

Route to the matching reference based on the input. Read only that reference; do not load the others.

- **Setup** — user has no recording yet and asks how to install Riffrec, capture a session, or share feedback. Read `references/install-riffrec.md`.
- **Quick bug report** — input is a short recording (under ~60 seconds), the user describes a single specific issue, or asks for "quick", "small", or "just transcribe". Read `references/quick-bug-report.md`. Emit one concise bug report; skip the full artifact set and the planning handoff.
- **Extensive analysis** — input is a longer recording, contains multiple issues / requirements / workflow walkthroughs, or the user wants requirements or planning material. Read `references/extensive-analysis.md`. Always continue into the `inc:plan` skill.

When the input is ambiguous (e.g., a zip arrived without context), inspect the recording length and event count before choosing. If still unclear, ask the user which path applies before running anything heavy.

## Common rules

- Keep raw recordings, audio chunks, zip contents, session dumps, and extracted screenshots local-only by default. Do not commit `raw/` or `frames/` directories unless the user explicitly asks and privacy is acceptable.
- Text/metadata artifacts (requirements docs, analysis summaries, problem analyses, source manifests) may be committed when they are needed for traceability and contain no sensitive data.
- Use repo-relative screenshot paths in any committed doc so later agents can open the evidence without absolute local paths.

## Analyzer entrypoint

All non-setup paths share the same analyzer:

```bash
python3 "<plugin root>/skills/inc-review-feedback/scripts/analyze_riffrec_zip.py" /path/to/input
```

Accepted inputs: a Riffrec `.zip`, an `.mp4` / `.mov` / `.webm` video, an `.m4a` / `.mp3` / `.wav` audio file, or a meeting-notes `.md`. Use `--output-dir <dir>` to control where artifacts land. In repos with `docs/brainstorms/`, the default is `docs/brainstorms/review-feedback/`. The quick path overrides the output dir to a temp location so nothing pollutes the repo.

Every non-setup run writes **`report.html`** - the human-consumable surface for the session: synthesized requirement cards (filled by the reviewing agent between the `AGENT-SYNTHESIS` markers), the repaired recording with a requirement-tracking bar under the player, and the timestamped transcript. The analyzer prints its path as a `REPORT_HTML=<abs path>` line. After the path's synthesis is filled (see the reference), **open the report** in the harness's own in-app/preview browser when it has one, falling back to the OS default browser (`open` on macOS, `xdg-open` on Linux, `start` on Windows). Do not read `report.html` back into context - it links media by relative path and is meant to be viewed, not parsed.

**Sharing:** `report.html` only plays from its own folder. When the user wants to share the report (send it to a teammate, attach it somewhere, open it from Downloads), run the `STANDALONE_BUILD=` command the analyzer printed - it writes **`report-standalone.html`** with the media embedded, a single file that plays anywhere. The standalone is a snapshot: rebuild it after any edit to `report.html`.

When the analyzer runs on a collector submission, it auto-detects the sibling `annotations.json` (the reviewer's written click-comments) and `session.json` (reviewer name) next to the input and folds them into the report; pass `--annotations <path>` to point at them explicitly.

**Machine signals are shallow on purpose.** The analyzer labels each candidate signal by kind — a *heuristic-signal* (keyword match) is a weak guess that is often a non-issue, a *observed-signal* is grounded in a recorded click/request. They are a starting glance, never the requirements. Design-direction feedback (like "test other background patterns" or "buttons should show play status") produces no signals at all yet is full of requirements — the synthesis pass in the reference is the source of truth. When a reviewer says they **couldn't evaluate** something because a state wasn't reachable, resolve it (reachability check against the product repo) rather than filing it blindly as a requirement — see `references/extensive-analysis.md`.

The feedback artifact format used by the extensive path is documented in `references/compound-engineering-feedback-format.md`.

## Local transcription (whisper.cpp)

Transcription runs locally by default — no API key, no network, no per-clip cost.

**One-time setup (macOS):**

```bash
brew install whisper-cpp
mkdir -p ~/.cache/whisper
# Default model — base.en, ~142 MB download (one time):
curl -L -o ~/.cache/whisper/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Model sizes — tell the user before they download so the size isn't a surprise:

- `ggml-base.en.bin` — **~142 MB** (default; plenty for clear narration)
- `ggml-small.en.bin` — **~466 MB** (more accurate; point `WHISPER_CPP_MODEL` at it)
- `ggml-tiny.en.bin` — **~75 MB** (fastest, lowest accuracy)

`ffmpeg` is also required (it transcodes the recording to 16 kHz mono PCM before transcription) — `brew install ffmpeg` if missing.

**How the backend is chosen** (`transcribe_media` in `scripts/analyze_riffrec_zip.py`):

- Default: local whisper.cpp.
- The CLI binary is auto-detected (`whisper-cli`, then `whisper-cpp`, then `main`), or set `WHISPER_CPP_BIN`.
- The model defaults to `~/.cache/whisper/ggml-base.en.bin`, or set `WHISPER_CPP_MODEL` (e.g. `ggml-small.en.bin` for higher accuracy).
- To fall back to the OpenAI API instead, set `RIFFREC_TRANSCRIBE_BACKEND=openai` (then `OPENAI_API_KEY` and `--model` apply).

If the binary or model is missing, transcription returns a `skipped` status with a one-line fix; the rest of the pipeline (events, frames, artifacts) still runs.

**Timestamped frames.** Because whisper.cpp emits per-segment timestamps, the analyzer anchors one screenshot to each narration point — so even feature-feedback walkthroughs with no error/complaint cues produce useful frames (the single-blob OpenAI path cannot).
