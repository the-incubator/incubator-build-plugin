---
name: inc:riffrec-feedback
description: Riffrec product-feedback workflow, transcribed LOCALLY with whisper.cpp (no API key, no per-clip cost, audio never leaves the machine). ALWAYS load when the user posts a `riffrec-*.zip`, a bundle with `session.json` + `events.json` + `recording.webm` + `voice.webm`, a video/audio recording for product feedback, or asks how to capture and share Riffrec sessions. Routes between setup, quick bug report, and extensive analysis.
argument-hint: "[path to a riffrec-*.zip, video, audio, or meeting-notes file]"
---

# Riffrec Feedback Analysis

Turn raw product feedback into structured evidence for downstream agents. This skill is the consumption side of [Riffrec](https://github.com/kieranklaassen/riffrec), a capture tool that records synchronized screen + voice + event sessions and emits a `riffrec-*.zip` bundle.

Transcription runs **locally with whisper.cpp** by default — no `OPENAI_API_KEY`, no per-clip cost, and the audio never leaves the machine. (Adapted from the upstream `ce-riffrec-feedback-analysis` skill; the local backend and timestamped frame selection are the incubator additions. The OpenAI API path is still available via an env flag — see "Local transcription" below.)

**Plugin scripts:** Commands below use `<plugin root>`, the installed `incubator-build` plugin directory. In Claude Code, use `${CLAUDE_PLUGIN_ROOT}`. In Codex, resolve it from the loaded skill path: the plugin root is two directories above this `SKILL.md`.

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
python3 "<plugin root>/skills/inc-riffrec-feedback/scripts/analyze_riffrec_zip.py" /path/to/input
```

Accepted inputs: a Riffrec `.zip`, an `.mp4` / `.mov` / `.webm` video, an `.m4a` / `.mp3` / `.wav` audio file, or a meeting-notes `.md`. Use `--output-dir <dir>` to control where artifacts land. In repos with `docs/brainstorms/`, the default is `docs/brainstorms/riffrec-feedback/`. The quick path overrides the output dir to a temp location so nothing pollutes the repo.

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
