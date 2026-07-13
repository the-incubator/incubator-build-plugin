# Setup: Add Riffrec to a project

Use this path when the user has no recording yet and wants to start capturing product feedback with [Riffrec](https://github.com/kieranklaassen/riffrec).

Riffrec is a browser-based capture tool that records the screen, microphone audio, console output, network requests, and DOM events into a single `riffrec-*.zip` bundle. The bundle is what this skill consumes downstream.

## What to tell the user

1. Riffrec lives at <https://github.com/kieranklaassen/riffrec>. Refer them to the README for the current install command — it is the source of truth and may change.
2. The general shape of integration:
   - Add the Riffrec capture script or package to the project's web app.
   - Wire a "Record feedback" affordance somewhere accessible during real use (a bug report button, a dev-only floating recorder, or a keyboard shortcut).
   - Confirm a sample session ends with a downloadable `riffrec-*.zip`.
3. Once a zip exists, the user runs this skill again with the zip path. The skill will pick the **quick bug report** or **extensive analysis** path automatically based on length and content.

## Recommended capture habits

Surface these to the user during setup so the recordings they share later are easy to analyze:

- Speak the issue out loud while reproducing it. The transcript is the single highest-signal artifact.
- Click the affected UI even when it does nothing — failed clicks are the strongest signal in event extraction.
- Keep recordings focused. Many short clips beat one long one when issues are unrelated.
- Note when a step is intentional vs. accidental ("oops, that wasn't what I meant"). The analyzer cannot infer intent.

## Set up local transcription (one-time)

Capturing a zip is only half of it — analyzing one needs a transcriber. This skill transcribes **locally with whisper.cpp** by default (no API key, no per-clip cost, audio never leaves the machine), so the user should install it before their first analysis.

On macOS:

```bash
brew install whisper-cpp          # also installs nothing huge; the model below is the big download
mkdir -p ~/.cache/whisper
# Default model — base.en, ~142 MB download (one time):
curl -L -o ~/.cache/whisper/ggml-base.en.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
```

Tell the user the download size so they aren't surprised:

- `ggml-base.en.bin` — **~142 MB** (default; plenty for clear narration)
- `ggml-small.en.bin` — **~466 MB** (more accurate; set `WHISPER_CPP_MODEL` to point at it)
- `ggml-tiny.en.bin` — **~75 MB** (fastest, lowest accuracy)

`ffmpeg` is also required (it transcodes the recording before transcription) — `brew install ffmpeg` if missing.

No API key is needed. To use the OpenAI API instead of local whisper, set `RIFFREC_TRANSCRIBE_BACKEND=openai` (then `OPENAI_API_KEY` applies). See the "Local transcription" section in `SKILL.md` for the full backend-selection rules.

## After install

When the user returns with their first zip, route to `references/quick-bug-report.md` or `references/extensive-analysis.md` per the SKILL.md routing rules. Do not run the analyzer in the setup path — there is nothing to analyze yet.
