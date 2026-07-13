---
name: inc:riffrec-feedback
description: Riffrec product-feedback workflow, transcribed LOCALLY with whisper.cpp (no API key, no per-clip cost, audio never leaves the machine). ALWAYS load when the user posts a `riffrec-*.zip`, a bundle with `session.json` + `events.json` + `recording.webm` + `voice.webm`, a video/audio recording for product feedback, an incubator feedback share link (`.../f/<sessionId>`), asks to analyze the latest preview feedback for the current branch/project, or asks how to capture and share Riffrec sessions. Routes between setup, quick bug report, and extensive analysis.
argument-hint: "[a riffrec-*.zip / video / audio path, an incubator feedback link (.../f/<id>), or blank to pull the latest feedback for the current branch]"
---

# Riffrec Feedback Analysis

Turn raw product feedback into structured evidence for downstream agents. This skill is the consumption side of [Riffrec](https://github.com/kieranklaassen/riffrec), a capture tool that records synchronized screen + voice + event sessions and emits a `riffrec-*.zip` bundle.

Transcription runs **locally with whisper.cpp** by default — no `OPENAI_API_KEY`, no per-clip cost, and the audio never leaves the machine. (Adapted from the upstream `ce-riffrec-feedback-analysis` skill; the local backend and timestamped frame selection are the incubator additions. The OpenAI API path is still available via an env flag — see "Local transcription" below.)

**Plugin scripts:** Commands below use `<plugin root>`, the installed `incubator-build` plugin directory. In Claude Code, use `${CLAUDE_PLUGIN_ROOT}`. In Codex, resolve it from the loaded skill path: the plugin root is two directories above this `SKILL.md`.

## Resolve the input

The input can arrive three ways. Resolve it to a **local file path** first, then continue to "Choose the path". Do this before anything heavy.

**1. A local file** — a `.zip` / `.mp4` / `.mov` / `.webm` / `.m4a` / `.mp3` / `.wav` / `.md` path already on disk. Use it as-is.

**2. An incubator feedback link** — `https://<collector-host>/f/<sessionId>` (the shareable link the preview client returns on submit). The last path segment after `/f/` is the `sessionId`. Fetch the submitted session with the CLI, then analyze its recording:

```bash
SID=$(printf '%s' "$INPUT" | sed -E 's#.*/f/([^/?#]+).*#\1#')
DEST="$(mktemp -d)/feedback-$SID"
node "<plugin root>/scripts/inc-build.mjs" feedback fetch "$SID" --out "$DEST"
```

`fetch` writes `session.json`, `annotations.json`, and — when the session has a recording — `recording.zip` into `$DEST`.
- **Recording present** (`recording.zip` exists): analyze `"$DEST/recording.zip"` via the analyzer entrypoint below.
- **No recording** (`fetch` prints `(no recording on this session)`): there is no walkthrough to transcribe. The feedback is the click-comments in `"$DEST/annotations.json"` (each has `comment`, `element`, `pageUrl`, and element context). Summarize those directly into the quick-bug or extensive artifact — skip transcription.

**3. Current branch / "latest feedback" (no path given)** — the user wants the newest submitted feedback for what they're working on. Resolve the project, list submitted sessions, pick one, then fetch as in case 2:

```bash
# a) Resolve the project slug for this repo.
PROJECT=$(grep -hoE 'NEXT_PUBLIC_FEEDBACK_PROJECT=.*' .env* 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' )
# If empty, list the projects the credentials can see and choose:
#   node "<plugin root>/scripts/inc-build.mjs" feedback projects
# One project -> use it. Several -> ask the user which.

# b) List submitted sessions, newest first. `REC` in the first column = has a recording.
#    Narrow to this branch's preview host with --preview <host> when you can derive it
#    (e.g. from the PR's deploy-bot preview URL); otherwise list the whole project.
node "<plugin root>/scripts/inc-build.mjs" feedback list --project "$PROJECT" --status submitted
```

Pick the session:
- Exactly one `REC` session → use its `feedbackSessionId`.
- Several → show the reviewer / `pageUrl` / date rows and **ask the user which `sessionId`** (don't guess across distinct reviewers).
- None with `REC` → tell the user there's no recorded walkthrough yet; if there are non-`REC` sessions, offer to summarize their click-comments via `feedback fetch` + `annotations.json` instead.

Then `feedback fetch <sessionId> --out "$DEST"` and analyze `recording.zip` exactly as in case 2.

> Auth: the CLI uses the plugin's install credentials (`credentials.json`). If a call returns `missing-auth` / `401`, the credentials aren't set up — surface `node "<plugin root>/scripts/inc-build.mjs" feedback projects` as the check and stop; don't retry blindly.

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
