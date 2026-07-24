#!/usr/bin/env python3
"""
Analyze a product feedback source.

Supported sources: Riffrec zip, standalone video, standalone audio, and
meeting notes text/markdown. The script extracts transcript, high-signal
video frames when available, and CE-friendly markdown artifacts.
"""

from __future__ import annotations

import argparse
import html as html_lib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


COMPLAINT_CUES = (
    "weird",
    "doesn't work",
    "does not work",
    "dont work",
    "don't work",
    "can't",
    "cannot",
    "broken",
    "bug",
    "problem",
    "confusing",
    "should",
    "wrong",
    "stuck",
    "failed",
)

NOISY_NETWORK_PATTERNS = (
    "/mini-profiler-resources/",
    "__vite_ping",
    "/rails/action_cable",
)

VIDEO_EXTENSIONS = {".webm", ".mp4", ".mov", ".m4v", ".mkv", ".avi"}
AUDIO_EXTENSIONS = {".webm", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".wav", ".ogg", ".flac"}
NOTES_EXTENSIONS = {".txt", ".md", ".markdown", ".text"}

# Minimum spacing between narration-derived moments, so a timestamped transcript
# yields a handful of well-placed frames instead of one per sentence.
NARRATION_MIN_GAP_SECONDS = 8.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze a product feedback source")
    parser.add_argument("source_path", type=Path, help="Path to a Riffrec zip, video, audio, or meeting notes file")
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="Directory for extracted artifacts. Defaults to docs/brainstorms/review-feedback/<source-stem> when available.",
    )
    parser.add_argument("--topic", help="Kebab-case topic for requirements-kickoff frontmatter")
    parser.add_argument(
        "--model",
        default=os.environ.get("RIFFREC_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe"),
        help="OpenAI transcription model — only used when RIFFREC_TRANSCRIBE_BACKEND=openai (local whisper.cpp is the default)",
    )
    parser.add_argument("--no-transcribe", action="store_true", help="Skip media transcription")
    parser.add_argument("--max-moments", type=int, default=12, help="Maximum screenshots to extract")
    parser.add_argument(
        "--annotations",
        type=Path,
        help="Path to the collector annotations.json (reviewer click-comments). "
        "Auto-detected from a sibling annotations.json next to the source when omitted.",
    )
    return parser.parse_args()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return re.sub(r"-{2,}", "-", slug) or "review-feedback"


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError):
        return default


def safe_extract(zip_path: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            member_path = dest / member.filename
            resolved = member_path.resolve()
            if not str(resolved).startswith(str(dest.resolve())):
                raise RuntimeError(f"Unsafe zip member path: {member.filename}")
            if member.is_dir():
                resolved.mkdir(parents=True, exist_ok=True)
            else:
                resolved.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, resolved.open("wb") as target:
                    shutil.copyfileobj(source, target)


def default_output_dir(zip_path: Path) -> Path:
    cwd = Path.cwd()
    stem = slugify(zip_path.stem)
    if (cwd / "docs" / "brainstorms").is_dir():
        return cwd / "docs" / "brainstorms" / "review-feedback" / stem
    return cwd / "review-feedback" / stem


def classify_source(source_path: Path) -> str:
    if zipfile.is_zipfile(source_path):
        return "riffrec_zip"
    suffix = source_path.suffix.lower()
    if suffix in NOTES_EXTENSIONS:
        return "meeting_notes"
    if suffix in VIDEO_EXTENSIONS and suffix in AUDIO_EXTENSIONS:
        return "video" if has_video_stream(source_path) else "audio"
    if suffix in VIDEO_EXTENSIONS:
        return "video"
    if suffix in AUDIO_EXTENSIONS:
        return "audio"
    return "unknown"


def ffprobe_duration(path: Path) -> float:
    if not path.exists() or not shutil.which("ffprobe"):
        return 0.0
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return 0.0
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0


def has_video_stream(path: Path) -> bool:
    if not path.exists() or not shutil.which("ffprobe"):
        return path.suffix.lower() in VIDEO_EXTENSIONS
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "csv=p=0",
        str(path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=30)
    return result.returncode == 0 and "video" in result.stdout


def read_notes(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text()
    except UnicodeDecodeError:
        text = path.read_text(encoding="utf-8", errors="replace")
    return {"status": "ok", "text": text.strip(), "source": "meeting_notes"}


# rrweb MouseInteraction subtypes that mark a deliberate reviewer action:
# Click (2), DblClick (4), TouchStart (7).
RRWEB_CLICK_TYPES = {2, 4, 7}

# Voice filenames the mobile client can produce (container depends on the
# engine: webm/opus on Chromium/Firefox, AAC in mp4 on iOS Safari).
MOBILE_VOICE_FILES = ("voice.webm", "voice.m4a", "voice.ogg", "voice.mp4")


def rrweb_interaction_events(raw_events: Any) -> list[dict[str, Any]]:
    """Map rrweb incremental mouse/touch interactions onto the analyzer's event
    shape ({"t": seconds, "type": "click"}), so mobile bundles get the same
    click-anchored candidate moments as riffrec's own events.json."""
    if not isinstance(raw_events, list) or not raw_events:
        return []
    first = raw_events[0] if isinstance(raw_events[0], dict) else {}
    start_ts = first.get("timestamp") or 0
    events: list[dict[str, Any]] = []
    for event in raw_events:
        if not isinstance(event, dict) or event.get("type") != 3:
            continue
        data = event.get("data") or {}
        if data.get("source") == 2 and data.get("type") in RRWEB_CLICK_TYPES:
            ts = event.get("timestamp") or start_ts
            # Carry the rrweb mirror-node id as the element identity so
            # distinct tap targets bucket separately in select_moments -
            # without it every tap keys to one "unknown" bucket and any two
            # taps read as "repeated clicks on the same target".
            element = {"id": data["id"]} if data.get("id") is not None else {}
            events.append({"t": max(0.0, (ts - start_ts) / 1000.0), "type": "click", "element": element})
    return events


def prepare_mobile_rrweb_source(raw_dir: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    """A mobile bundle: the walkthrough is a DOM event stream (rrweb) + voice,
    not screen pixels - mobile browsers have no getDisplayMedia. Render
    recording.webm locally from the events (headless replay + voice mux) so the
    rest of the pipeline runs unchanged; if rendering isn't possible on this
    machine, transcription and events still proceed without frames."""
    raw_events = read_json(raw_dir / "rrweb-events.json", [])
    try:
        duration = float(manifest.get("durationMs") or 0) / 1000.0
    except (TypeError, ValueError):
        duration = 0.0
    session = dict(manifest)
    session.setdefault("url", "unknown")
    session["started_at"] = manifest.get("startedAt", "unknown")
    session["duration_seconds"] = round(duration, 3)

    recording_path = raw_dir / "recording.webm"
    if not recording_path.exists():
        render_script = Path(__file__).resolve().parent / "render_rrweb_bundle.mjs"
        render_command = ["node", str(render_script), str(raw_dir), "--out", str(recording_path)]
        print("Mobile rrweb bundle: rendering recording.webm from the DOM event stream (takes about the session's length)...")
        try:
            render = subprocess.run(
                render_command,
                capture_output=True,
                text=True,
                timeout=max(300, int(duration * 3) + 120),
            )
            if render.returncode != 0:
                print(f"RENDER_SKIPPED reason={compact_text(render.stderr or render.stdout, 300)}")
                print("  Fix the dependency it names, then re-run: " + " ".join(render_command))
        except (subprocess.TimeoutExpired, OSError) as err:
            print(f"RENDER_SKIPPED reason={compact_text(str(err), 300)}")
            print("  Re-run manually: " + " ".join(render_command))

    # Basename only - voiceFile is bundle-controlled, and a traversal value
    # like "../../private.wav" must never point transcription (which may
    # upload the file to a remote backend) outside the extracted bundle. When
    # the manifest omits or misnames it, probe the client's known voice names
    # so a real track still gets transcribed.
    declared_voice = Path(str(manifest.get("voiceFile") or "")).name
    voice_candidates = [declared_voice] if declared_voice else []
    voice_candidates += [c for c in MOBILE_VOICE_FILES if c != declared_voice]
    voice_file = next((c for c in voice_candidates if (raw_dir / c).exists()), "voice.webm")
    return {
        "source_kind": "riffrec_zip",
        "session": session,
        "events": rrweb_interaction_events(raw_events),
        "duration": duration,
        # None when the render was skipped/failed - a truthy path to a missing
        # file would suppress the report's voice-audio fallback player and
        # trigger spurious remux warnings downstream.
        "recording_path": recording_path if recording_path.exists() else None,
        "transcription_path": raw_dir / voice_file,
        "notes_transcript": None,
    }


def prepare_source(source_path: Path, raw_dir: Path) -> dict[str, Any]:
    raw_dir.mkdir(parents=True, exist_ok=True)
    source_kind = classify_source(source_path)

    if source_kind == "riffrec_zip":
        safe_extract(source_path, raw_dir)
        session = read_json(raw_dir / "session.json", {})
        if session.get("format") == "ibf-mobile-rrweb":
            return prepare_mobile_rrweb_source(raw_dir, session)
        events_payload = read_json(raw_dir / "events.json", {})
        events = events_payload.get("events", events_payload if isinstance(events_payload, list) else [])
        if not isinstance(events, list):
            events = []
        try:
            duration = float(session.get("duration_seconds") or events_payload.get("duration_seconds") or 0)
        except (TypeError, ValueError):
            duration = 0.0
        return {
            "source_kind": source_kind,
            "session": session,
            "events": events,
            "duration": duration,
            "recording_path": raw_dir / "recording.webm",
            "transcription_path": raw_dir / "voice.webm",
            "notes_transcript": None,
        }

    copied_path = raw_dir / source_path.name
    if source_path.resolve() != copied_path.resolve():
        shutil.copy2(source_path, copied_path)

    session = {
        "url": "unknown",
        "started_at": "unknown",
        "duration_seconds": 0,
        "source_file": str(source_path),
        "source_kind": source_kind,
    }

    if source_kind == "meeting_notes":
        notes_transcript = read_notes(copied_path)
        return {
            "source_kind": source_kind,
            "session": session,
            "events": [],
            "duration": 0.0,
            "recording_path": None,
            "transcription_path": None,
            "notes_transcript": notes_transcript,
        }

    duration = ffprobe_duration(copied_path)
    session["duration_seconds"] = round(duration, 3) if duration else 0
    recording_path = copied_path if has_video_stream(copied_path) else None
    transcription_path = copied_path if source_kind in {"video", "audio", "unknown"} else None
    return {
        "source_kind": source_kind,
        "session": session,
        "events": [],
        "duration": duration,
        "recording_path": recording_path,
        "transcription_path": transcription_path,
        "notes_transcript": None,
    }


def _ffmpeg(args: list[str], timeout: int = 300) -> bool:
    result = subprocess.run(["ffmpeg", "-y", "-v", "error", *args], capture_output=True, text=True, timeout=timeout)
    return result.returncode == 0


def repair_media(recording_path: Path | None, voice_path: Path | None, raw_dir: Path) -> tuple[Path | None, Path | None]:
    """Repair riffrec's MediaRecorder-produced webm tracks for reliable playback.

    Browser MediaRecorder streams webm without a duration header or seek cues, so
    players show an unknown duration and seeking is unreliable; the voice track can
    also carry corrupt Opus packets that abort playback partway. The screen track
    only needs a container remux (no transcode); the voice track is rebuilt through
    a WAV intermediate, which drops corrupt packets instead of copying them through.
    Falls back to the original files when ffmpeg is unavailable or a step fails."""
    if not shutil.which("ffmpeg"):
        return recording_path, voice_path

    fixed_recording = recording_path
    if recording_path and recording_path.exists():
        candidate = raw_dir / "recording-fixed.webm"
        try:
            if _ffmpeg(["-i", str(recording_path), "-c", "copy", str(candidate)]) and candidate.stat().st_size > 0:
                fixed_recording = candidate
        except (subprocess.TimeoutExpired, OSError):
            pass
        if fixed_recording is recording_path:
            print(f"warning: could not remux {recording_path.name}; the report uses the original (seeking may be unreliable)", file=sys.stderr)

    fixed_voice = voice_path
    if voice_path and voice_path.exists():
        wav = raw_dir / "voice-clean.wav"
        candidate = raw_dir / "voice-fixed.webm"
        try:
            if (
                _ffmpeg(["-i", str(voice_path), str(wav)])
                and _ffmpeg(["-i", str(wav), "-c:a", "libopus", "-b:a", "96k", str(candidate)])
                and candidate.stat().st_size > 0
            ):
                fixed_voice = candidate
        except (subprocess.TimeoutExpired, OSError):
            pass
        finally:
            wav.unlink(missing_ok=True)
        if fixed_voice is voice_path:
            print(f"warning: could not rebuild {voice_path.name}; the report uses the original (audio may cut out)", file=sys.stderr)

    return fixed_recording, fixed_voice


def repo_relative(path: Path, base: Path) -> str:
    try:
        return str(path.resolve().relative_to(base.resolve()))
    except ValueError:
        return str(path)


def display_path(path: Path, repo_root: Path) -> str:
    relative = repo_relative(path, repo_root)
    return relative if not relative.startswith("/") else str(path)


def format_time(seconds: float | int | None) -> str:
    if seconds is None:
        return "n/a"
    seconds_float = float(seconds)
    minutes = int(seconds_float // 60)
    rest = seconds_float - minutes * 60
    return f"{minutes:02d}:{rest:05.2f}"


def event_time(event: dict[str, Any]) -> float:
    try:
        return float(event.get("t", 0))
    except (TypeError, ValueError):
        return 0.0


def event_label(event: dict[str, Any]) -> str:
    event_type = event.get("type", "event")
    if event_type == "click":
        element = event.get("element") or {}
        text = compact_text(element.get("text") or "")
        element_id = element.get("id")
        tag = element.get("tag") or "element"
        if element_id:
            return f"click {tag}#{element_id} {text}".strip()
        return f"click {tag} {text}".strip()
    if event_type == "network_request":
        return f"{event.get('method', 'GET')} {event.get('url', '')} -> {event.get('status')}"
    return compact_text(json.dumps(event, sort_keys=True))


def compact_text(text: str, limit: int = 120) -> str:
    compacted = re.sub(r"\s+", " ", str(text)).strip()
    if len(compacted) <= limit:
        return compacted
    return compacted[: limit - 1].rstrip() + "..."


def network_is_noise(event: dict[str, Any]) -> bool:
    url = str(event.get("url") or "")
    return any(pattern in url for pattern in NOISY_NETWORK_PATTERNS)


def transcript_has_complaint(transcript: str) -> bool:
    lowered = transcript.lower()
    return any(cue in lowered for cue in COMPLAINT_CUES)


def matched_complaint_cues(transcript: str) -> list[str]:
    """Cue words the keyword scan matched. This is a weak lexical signal, not a
    judgement — the words may appear in desired behavior, prior art, or asides."""
    lowered = transcript.lower()
    seen: list[str] = []
    for cue in COMPLAINT_CUES:
        if cue in lowered and cue not in seen:
            seen.append(cue)
    return seen


def _resolve_whisper_bin() -> str | None:
    """Locate a whisper.cpp CLI binary, honoring WHISPER_CPP_BIN if set."""
    override = os.environ.get("WHISPER_CPP_BIN")
    if override and shutil.which(override):
        return override
    for candidate in ("whisper-cli", "whisper-cpp", "main"):
        if shutil.which(candidate):
            return candidate
    return None


def _resolve_whisper_model() -> Path:
    """Resolve the ggml model path. Honors WHISPER_CPP_MODEL; defaults to ~/.cache/whisper/ggml-base.en.bin."""
    override = os.environ.get("WHISPER_CPP_MODEL")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".cache" / "whisper" / "ggml-base.en.bin"


def transcribe_local_whisper(media_path: Path) -> dict[str, Any]:
    """Transcribe locally with whisper.cpp — no network, no API key, no per-clip cost."""
    whisper_bin = _resolve_whisper_bin()
    if not whisper_bin:
        return {
            "status": "skipped",
            "text": "",
            "reason": "whisper.cpp CLI not found. Install with `brew install whisper-cpp`, or set WHISPER_CPP_BIN.",
        }
    model_path = _resolve_whisper_model()
    if not model_path.exists():
        return {
            "status": "skipped",
            "text": "",
            "reason": f"whisper model not found at {model_path}. Download a ggml model (e.g. ggml-base.en.bin) or set WHISPER_CPP_MODEL.",
        }
    if not shutil.which("ffmpeg"):
        return {"status": "skipped", "text": "", "reason": "ffmpeg is not installed; cannot decode media for whisper.cpp"}

    # whisper.cpp wants 16 kHz mono PCM; transcode whatever Riffrec captured.
    wav_path = media_path.with_suffix(".whisper16k.wav")
    convert = subprocess.run(
        ["ffmpeg", "-y", "-i", str(media_path), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav_path)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if convert.returncode != 0 or not wav_path.exists():
        return {"status": "failed", "text": "", "reason": compact_text(convert.stderr or convert.stdout, 500)}

    out_base = media_path.with_suffix(".whisper")
    command = [
        whisper_bin,
        "-m", str(model_path),
        "-f", str(wav_path),
        "-otxt",
        "-oj",
        "-of", str(out_base),
        "-nt",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=1800)
    except subprocess.TimeoutExpired:
        return {"status": "failed", "text": "", "reason": "whisper.cpp transcription timed out"}
    finally:
        if wav_path.exists():
            wav_path.unlink()

    if result.returncode != 0:
        return {"status": "failed", "text": "", "reason": compact_text(result.stderr or result.stdout, 500)}

    txt_path = Path(f"{out_base}.txt")
    text = txt_path.read_text().strip() if txt_path.exists() else ""
    if not text:
        text = result.stdout.strip()

    # whisper.cpp emits per-segment timestamps in its JSON output. Thread them
    # through so moment selection can anchor a frame at each narration point —
    # the single-blob OpenAI path can't do this.
    segments: list[dict[str, Any]] = []
    json_path = Path(f"{out_base}.json")
    if json_path.exists():
        try:
            payload = json.loads(json_path.read_text())
            for seg in payload.get("transcription", []):
                offset_ms = (seg.get("offsets") or {}).get("from")
                seg_text = (seg.get("text") or "").strip()
                # Skip whisper non-speech markers like "[BLANK_AUDIO]" or "(music)".
                if offset_ms is not None and seg_text and not re.fullmatch(r"[\[(].*[\])]", seg_text):
                    segments.append({"t": offset_ms / 1000.0, "text": seg_text})
        except (json.JSONDecodeError, OSError):
            segments = []

    return {
        "status": "ok",
        "text": text,
        "segments": segments,
        "raw": {"backend": "whisper.cpp", "model": str(model_path)},
    }


def _transcribe_openai(media_path: Path, model: str) -> dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return {
            "status": "skipped",
            "text": "",
            "reason": "OPENAI_API_KEY is not set. Re-run with the key available to transcribe the media file.",
        }
    if not shutil.which("curl"):
        return {"status": "skipped", "text": "", "reason": "curl is not installed"}

    command = [
        "curl",
        "-sS",
        "https://api.openai.com/v1/audio/transcriptions",
        "-H",
        f"Authorization: Bearer {api_key}",
        "-F",
        f"file=@{media_path}",
        "-F",
        f"model={model}",
        "-F",
        "response_format=json",
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return {"status": "failed", "text": "", "reason": "transcription request timed out"}

    if result.returncode != 0:
        return {
            "status": "failed",
            "text": "",
            "reason": compact_text(result.stderr or result.stdout, 500),
        }

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"status": "failed", "text": "", "reason": compact_text(result.stdout, 500)}

    if "error" in payload:
        return {"status": "failed", "text": "", "reason": compact_text(json.dumps(payload["error"]), 500)}

    text = payload.get("text", "")
    return {"status": "ok", "text": text, "raw": payload}


def transcribe_media(media_path: Path | None, model: str) -> dict[str, Any]:
    """Transcribe media. Defaults to local whisper.cpp; set RIFFREC_TRANSCRIBE_BACKEND=openai for the API path."""
    if not media_path or not media_path.exists():
        return {"status": "missing", "text": ""}
    backend = os.environ.get("RIFFREC_TRANSCRIBE_BACKEND", "local").strip().lower()
    if backend == "openai":
        return _transcribe_openai(media_path, model)
    return transcribe_local_whisper(media_path)


def should_retry_transcription_in_chunks(transcript: dict[str, Any]) -> bool:
    reason = str(transcript.get("reason") or "")
    return transcript.get("status") == "failed" and (
        "input_too_large" in reason or "too large" in reason.lower() or "maximum context" in reason.lower()
    )


def transcribe_media_chunks(
    media_path: Path | None,
    model: str,
    chunks_dir: Path,
    duration: float,
    chunk_seconds: int = 420,
) -> dict[str, Any]:
    if not media_path or not media_path.exists():
        return {"status": "missing", "text": ""}
    if not shutil.which("ffmpeg"):
        return {"status": "failed", "text": "", "reason": "ffmpeg is not installed; cannot chunk media"}

    chunks_dir.mkdir(parents=True, exist_ok=True)
    chunk_count = max(1, int((duration or chunk_seconds) // chunk_seconds) + (1 if duration % chunk_seconds else 0))
    transcripts: list[str] = []
    chunk_results: list[dict[str, Any]] = []

    for index in range(chunk_count):
        start = index * chunk_seconds
        if duration and start >= duration:
            break
        chunk_path = chunks_dir / f"audio-chunk-{index + 1:03d}-{start}s.mp3"
        extract_command = [
            "ffmpeg",
            "-y",
            "-ss",
            str(start),
            "-t",
            str(chunk_seconds),
            "-i",
            str(media_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "64k",
            str(chunk_path),
        ]
        extract = subprocess.run(extract_command, capture_output=True, text=True, timeout=180)
        if extract.returncode != 0 or not chunk_path.exists():
            chunk_results.append(
                {
                    "chunk": index + 1,
                    "start_seconds": start,
                    "status": "failed",
                    "reason": compact_text(extract.stderr or extract.stdout, 500),
                }
            )
            continue

        chunk_transcript = transcribe_media(chunk_path, model)
        chunk_results.append(
            {
                "chunk": index + 1,
                "start_seconds": start,
                "path": str(chunk_path),
                "status": chunk_transcript.get("status"),
                "reason": chunk_transcript.get("reason"),
            }
        )
        if chunk_transcript.get("text"):
            transcripts.append(f"[{format_time(start)}]\n{chunk_transcript['text'].strip()}")

    if transcripts:
        return {
            "status": "ok",
            "text": "\n\n".join(transcripts),
            "source": "chunked_media",
            "chunk_seconds": chunk_seconds,
            "chunks": chunk_results,
        }

    return {
        "status": "failed",
        "text": "",
        "reason": "No chunks transcribed successfully",
        "chunks": chunk_results,
    }


def select_moments(
    events: list[dict[str, Any]],
    transcript: str,
    duration: float,
    max_moments: int,
    segments: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    clicks_by_target: defaultdict[str, list[dict[str, Any]]] = defaultdict(list)
    has_complaint = transcript_has_complaint(transcript)
    segments = segments or []

    for event in events:
        event_type = event.get("type")
        t = event_time(event)
        if event_type == "click":
            element = event.get("element") or {}
            key = element.get("id") or element.get("selector") or element.get("text") or "unknown"
            clicks_by_target[str(key)].append(event)
            reason = "click event"
            if has_complaint and duration and t >= duration * 0.55:
                reason = "late-session click near complaint transcript"
            candidates.append({"t": t, "reason": reason, "events": [event]})
        elif event_type == "network_request":
            status = event.get("status")
            try:
                failed = int(status) >= 400
            except (TypeError, ValueError):
                failed = False
            if failed and not network_is_noise(event):
                candidates.append({"t": t, "reason": f"failed network request ({status})", "events": [event]})
        elif event_type in {"console_error", "error", "exception"}:
            candidates.append({"t": t, "reason": f"{event_type} event", "events": [event]})

    for grouped in clicks_by_target.values():
        if len(grouped) >= 2:
            first = grouped[0]
            last = grouped[-1]
            if event_time(last) - event_time(first) <= 8:
                candidates.append(
                    {
                        "t": event_time(last),
                        "reason": "repeated clicks on the same target",
                        "events": grouped[:4],
                    }
                )

    # Timestamped transcript: anchor a spaced set of frames to narration points.
    # This is what lets a feature-feedback walkthrough (no error/complaint cues,
    # few DOM events) still produce one screenshot per thing the user talks about.
    if segments:
        target = min(max_moments, 8)
        min_gap = max(NARRATION_MIN_GAP_SECONDS, duration / target) if duration and target else NARRATION_MIN_GAP_SECONDS
        last_narration_t = -1e9
        for segment in sorted(segments, key=lambda item: float(item.get("t", 0.0))):
            t = float(segment.get("t", 0.0))
            text = (segment.get("text") or "").strip()
            if not text or t - last_narration_t < min_gap:
                continue
            candidates.append({"t": t, "reason": f"narration: {compact_text(text, 80)}", "events": []})
            last_narration_t = t

    if has_complaint and duration and not candidates:
        for fraction in (0.35, 0.55, 0.75, 0.9):
            candidates.append({"t": max(0.0, duration * fraction), "reason": "representative frame for complaint transcript", "events": []})

    if duration and not candidates:
        fractions = (0.1, 0.3, 0.5, 0.7, 0.9)
        for fraction in fractions[:max(1, min(max_moments, len(fractions)))]:
            candidates.append({"t": max(0.0, duration * fraction), "reason": "representative video frame", "events": []})

    candidates.sort(key=lambda item: (item["t"], item["reason"]))
    deduped: list[dict[str, Any]] = []
    for candidate in candidates:
        if candidate["t"] < 0:
            continue
        if any(abs(candidate["t"] - existing["t"]) < 0.45 and candidate["reason"] == existing["reason"] for existing in deduped):
            continue
        deduped.append(candidate)
        if len(deduped) >= max_moments:
            break

    for index, moment in enumerate(deduped, start=1):
        moment["id"] = f"M{index}"
    return deduped


def extract_frames(recording_path: Path | None, frames_dir: Path, moments: list[dict[str, Any]]) -> None:
    frames_dir.mkdir(parents=True, exist_ok=True)
    if not recording_path or not recording_path.exists():
        for moment in moments:
            moment["screenshot"] = None
            moment["screenshot_status"] = "no video source"
        return
    if not shutil.which("ffmpeg"):
        for moment in moments:
            moment["screenshot"] = None
            moment["screenshot_status"] = "ffmpeg not installed"
        return

    for moment in moments:
        safe_reason = slugify(moment["reason"])[:48]
        frame_path = frames_dir / f"{moment['id'].lower()}-{moment['t']:.2f}s-{safe_reason}.png"
        command = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{max(0.0, float(moment['t'])):.3f}",
            "-i",
            str(recording_path),
            "-frames:v",
            "1",
            "-q:v",
            "2",
            str(frame_path),
        ]
        result = subprocess.run(command, capture_output=True, text=True, timeout=60)
        if result.returncode == 0 and frame_path.exists():
            moment["screenshot"] = str(frame_path)
            moment["screenshot_status"] = "ok"
        else:
            moment["screenshot"] = None
            moment["screenshot_status"] = compact_text(result.stderr or result.stdout, 300)


def event_counts(events: list[dict[str, Any]]) -> dict[str, int]:
    return dict(Counter(str(event.get("type", "unknown")) for event in events))


def summarize_candidate_findings(moments: list[dict[str, Any]], transcript: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    complaint_moments = [moment for moment in moments if "complaint" in moment.get("reason", "")]
    repeated_clicks = [moment for moment in moments if "repeated clicks" in moment.get("reason", "")]
    failed_requests = [moment for moment in moments if "failed network" in moment.get("reason", "")]

    cues = matched_complaint_cues(transcript)
    if cues:
        evidence_ids = [moment["id"] for moment in complaint_moments] or [moment["id"] for moment in moments[-3:]]
        cue_list = ", ".join(f'"{cue}"' for cue in cues)
        findings.append(
            {
                "id": "F1",
                "kind": "heuristic-signal",
                "title": "Possible issue — keyword scan matched complaint-like words (verify)",
                "severity": "unrated",
                "observed": (
                    f"A simplistic keyword scan matched {cue_list} in the transcript. This is a "
                    "weak lexical signal, not a confirmed problem: the words often appear in "
                    "desired behavior, prior-art comparisons, or asides. Read the surrounding "
                    "transcript and linked frames before treating any of this as a bug."
                ),
                "expected": "Confirm from the transcript whether an actual defect exists before promoting this to a requirement.",
                "evidence": evidence_ids,
                "confidence": "Low — heuristic keyword match, unverified",
            }
        )

    if repeated_clicks:
        findings.append(
            {
                "id": f"F{len(findings) + 1}",
                "kind": "observed-signal",
                "title": "Repeated interaction may indicate missing feedback or a dead control",
                "severity": "P2",
                "observed": "The same target was clicked more than once within a short interval (a behavioral signal, not a transcript guess).",
                "expected": "Repeated clicks should not be needed; the UI should respond once or show a clear disabled/error state.",
                "evidence": [moment["id"] for moment in repeated_clicks],
                "confidence": "Medium — grounded in recorded click events",
            }
        )

    if failed_requests:
        findings.append(
            {
                "id": f"F{len(findings) + 1}",
                "kind": "observed-signal",
                "title": "User-visible flow coincided with failed network requests",
                "severity": "P2",
                "observed": "One or more non-noisy network requests returned a failure status.",
                "expected": "Failures should be handled with durable user feedback and recoverable behavior.",
                "evidence": [moment["id"] for moment in failed_requests],
                "confidence": "High for request failure, medium for user impact until screenshots are reviewed",
            }
        )

    if not findings:
        findings.append(
            {
                "id": "F1",
                "kind": "none",
                "title": "No automatic signal detected — read the transcript directly",
                "severity": "unrated",
                "observed": "The analyzer did not match complaint keywords, repeated clicks, console errors, or non-noisy failed requests. This is expected for design-direction or feature-request feedback and does not mean there is nothing to capture.",
                "expected": "Synthesize requirements straight from the transcript and frames; do not rely on this heuristic layer to find them.",
                "evidence": [moment["id"] for moment in moments[:3]],
                "confidence": "n/a",
            }
        )
    return findings


def markdown_link(path: str | None, output_dir: Path, repo_root: Path) -> str:
    if not path:
        return "n/a"
    path_obj = Path(path)
    if path_obj.exists():
        return repo_relative(path_obj, repo_root)
    return path


def write_analysis_md(
    output_path: Path,
    source_path: Path,
    source_kind: str,
    session: dict[str, Any],
    events: list[dict[str, Any]],
    transcript: dict[str, Any],
    moments: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    annotations: list[dict[str, Any]],
    repo_root: Path,
) -> None:
    lines: list[str] = []
    lines.append("# Product Feedback Analysis")
    lines.append("")
    lines.append("## Source")
    lines.append("")
    lines.append(f"- Source: `{source_path}`")
    lines.append(f"- Source kind: `{source_kind}`")
    lines.append(f"- URL: `{session.get('url', 'unknown')}`")
    lines.append(f"- Started: `{session.get('started_at', 'unknown')}`")
    lines.append(f"- Duration: `{session.get('duration_seconds', 'unknown')}` seconds")
    lines.append(f"- Browser: `{session.get('browser', 'unknown')}`")
    lines.append(f"- Event counts: `{event_counts(events)}`")
    lines.append("")
    lines.append("## Transcript")
    lines.append("")
    if transcript.get("text"):
        lines.append(transcript["text"].strip())
    else:
        lines.append(f"_Transcript unavailable: {transcript.get('reason') or transcript.get('status', 'unknown')}._")
    lines.append("")
    if annotations:
        lines.append("## Reviewer Notes")
        lines.append("")
        lines.append("Written click-comments the reviewer left on the preview. Treat these as first-class requirements alongside the spoken transcript.")
        lines.append("")
        for note in annotations:
            comment = (note.get("comment") or "").strip() or "(no comment)"
            element = note.get("element") or ""
            page = note.get("pageUrl") or ""
            suffix = " - ".join(part for part in [f"on `{element}`" if element else "", page] if part)
            lines.append(f"- {comment}" + (f" ({suffix})" if suffix else ""))
        lines.append("")
    lines.append("## Selected Moments")
    lines.append("")
    if moments:
        lines.append("| ID | Time | Why selected | Screenshot | Event evidence |")
        lines.append("|---|---:|---|---|---|")
        for moment in moments:
            screenshot = markdown_link(moment.get("screenshot"), output_path.parent, repo_root)
            evidence = "<br>".join(compact_text(event_label(event), 140) for event in moment.get("events", [])) or "n/a"
            lines.append(
                f"| {moment['id']} | {format_time(moment['t'])} | {moment['reason']} | `{screenshot}` | {evidence} |"
            )
    else:
        lines.append("_No video moments available for this source._")
    lines.append("")
    lines.append("## Candidate Findings")
    lines.append("")
    for finding in findings:
        lines.append(f"### {finding['id']}. {finding['title']}")
        lines.append("")
        lines.append(f"- **Severity:** {finding['severity']}")
        lines.append(f"- **Observed:** {finding['observed']}")
        lines.append(f"- **Expected:** {finding['expected']}")
        lines.append(f"- **Evidence:** {', '.join(finding['evidence'])}")
        lines.append(f"- **Confidence:** {finding['confidence']}")
        lines.append("")
    lines.append("## Human Review Checklist")
    lines.append("")
    lines.append("- Open each selected screenshot and name the exact visible control or state.")
    lines.append("- Tie transcript language to the closest click or visible UI state.")
    lines.append("- Promote only confirmed product problems into requirements.")
    lines.append("- Use repo-relative screenshot paths when moving evidence into a CE requirements document.")
    output_path.write_text("\n".join(lines) + "\n")


def write_requirements_kickoff(
    output_path: Path,
    topic: str,
    session: dict[str, Any],
    findings: list[dict[str, Any]],
    moments: list[dict[str, Any]],
    repo_root: Path,
) -> None:
    title = topic.replace("-", " ").title()
    date = datetime.now(timezone.utc).date().isoformat()
    primary_evidence = ", ".join(finding["id"] for finding in findings)
    screenshot_refs = []
    for moment in moments:
        if moment.get("screenshot"):
            screenshot_refs.append(f"{moment['id']}: `{markdown_link(moment['screenshot'], output_path.parent, repo_root)}`")
    evidence_text = "; ".join(screenshot_refs[:6]) or "See analysis.md selected moments."
    source_materials = markdown_link(str(output_path.parent / "source-materials.md"), output_path.parent, repo_root)
    analysis_path = markdown_link(str(output_path.parent / "analysis.md"), output_path.parent, repo_root)
    problem_analysis_path = markdown_link(str(output_path.parent / "problem-analysis.md"), output_path.parent, repo_root)
    review_prompt_path = markdown_link(str(output_path.parent / "review-prompt.md"), output_path.parent, repo_root)

    lines = [
        "---",
        f"date: {date}",
        f"topic: {topic}",
        "---",
        "",
        f"# {title}",
        "",
        "## Problem Frame",
        "",
        f"A product feedback source for `{session.get('url', 'the product surface')}` produced evidence of product friction. The raw source has been converted into transcript, selected moments when video is available, screenshots when frames can be extracted, and candidate findings so the team can decide what product behavior should change before planning implementation.",
        "",
        "Source materials for brainstorm:",
        f"- Source materials manifest: `{source_materials}`",
        f"- Analysis: `{analysis_path}`",
        f"- Problem analysis: `{problem_analysis_path}`",
        f"- Review prompt with transcript and frames: `{review_prompt_path}`",
        "",
        "---",
        "",
        "## Actors",
        "",
        "- A1. User: Operates the product in the recorded session and verbalizes friction.",
        "- A2. Product surface: The UI and backend behavior visible in the recording.",
        "- A3. Brainstorm agent: Uses the evidence bundle to confirm, correct, and group requirements before planning.",
        "",
        "---",
        "",
        "## Key Flows",
        "",
        "- F1. Evidence-backed feedback triage",
        "  - **Trigger:** A feedback zip, video, audio file, or meeting notes file is available.",
        "  - **Actors:** A1, A2, A3",
        "  - **Steps:** Extract or copy the source, transcribe media or read notes, select high-signal moments when video exists, inspect screenshots when available, confirm problems, and write requirements with supporting evidence.",
        "  - **Outcome:** Confirmed product problems are represented as requirements with transcript support and screenshot support when visual evidence exists.",
        "  - **Covered by:** R1, R2",
        "",
        "---",
        "",
        "## Requirements",
        "",
        "**Evidence handling**",
        "- R1. Each confirmed product problem must cite supporting transcript, notes, or moment evidence from the source, including timestamp and screenshot when video is available.",
        "- R2. Transcript claims must be tied to the closest visible interaction or explicitly marked as untimed verbal context.",
        "",
        "**Product requirements from this session**",
        "",
        "> The agent fills these by reading the transcript and the reviewer notes. Real"
        " requirements (including ones with no keyword or DOM signal at all) go here as"
        " `R#` items during synthesis. The machine signals below are deliberately NOT"
        " numbered as requirements.",
        "",
        "_None extracted yet — synthesize from the transcript, reviewer notes, and frames._",
        "",
        "**Machine signals — verify, do not treat as requirements**",
        "",
        "> Heuristic keyword hits and observed events. A heuristic-signal is frequently a"
        " non-issue (design-direction feedback trips the keyword scan). These are a"
        " starting glance only; never carry them into `inc:plan` as R-items.",
        "",
    ]

    for finding in findings:
        kind = finding.get("kind", "signal")
        lines.append(
            f"- [{kind}] {finding['id']}: {finding['title']} "
            f"(confidence: {finding.get('confidence', 'unrated')})"
        )

    lines.extend(
        [
            "",
            "---",
            "",
            "## Acceptance Examples",
            "",
            "- AE1. **Covers R1, R2.** Given a feedback source with voice, video, or notes, when the analysis is complete, each promoted issue includes source evidence (verbatim quote + timestamp, screenshot when available) rather than prose-only claims.",
            "",
            "---",
            "",
            "## Success Criteria",
            "",
            "- A human reviewer can understand what went wrong without rewatching the entire recording.",
            "- `inc:plan` can confirm requirements from linked source evidence before any planning begins.",
            "",
            "---",
            "",
            "## Scope Boundaries",
            "",
            "- The analyzer output is evidence and requirements kickoff material, not final implementation design.",
            "- Automatically detected findings remain candidates until screenshots are inspected.",
            "- Development-only noise, such as profiler requests, should not become product requirements unless it affects the user experience.",
            "",
            "---",
            "",
            "## Key Decisions",
            "",
            "- Evidence first: Requirements should cite moments and screenshots before moving to planning.",
            "- Plan from evidence: Use `inc:plan` to refine product behavior when the recording reveals ambiguity.",
            "",
            "---",
            "",
            "## Dependencies / Assumptions",
            "",
            f"- Source session URL: `{session.get('url', 'unknown')}`.",
            f"- Source materials manifest: `{source_materials}`.",
            f"- Candidate findings: {primary_evidence}.",
            f"- Screenshot evidence: {evidence_text}.",
            "",
            "---",
            "",
            "## Outstanding Questions",
            "",
            "### Resolve Before Planning",
            "",
            "- Which candidate findings are real product problems after screenshot review?",
            "- For each promoted finding, what should the user experience be instead?",
            "",
            "### Deferred to Planning",
            "",
            "- [Technical] Which code paths own the confirmed product behavior?",
            "- [Technical] What regression tests should lock the behavior once fixed?",
            "",
            "---",
            "",
            "## Next Steps",
            "",
            "-> Triage every requirement into a bucket (change / try / discuss / respond / blocked / defer per `references/feedback-triage.md`) and get the table approved as `triage.md`.",
            "-> Then resume `/inc:plan` to confirm candidate findings and replace generic R-items with product-specific requirements.",
        ]
    )
    output_path.write_text("\n".join(lines) + "\n")


def write_source_materials(
    output_path: Path,
    source_path: Path,
    source_kind: str,
    session: dict[str, Any],
    transcript: dict[str, Any],
    moments: list[dict[str, Any]],
    raw_dir: Path,
    frames_dir: Path,
    repo_root: Path,
) -> None:
    def link(path: Path) -> str:
        return markdown_link(str(path), output_path.parent, repo_root)

    raw_files = sorted(path for path in raw_dir.rglob("*") if path.is_file())
    frame_files = sorted(path for path in frames_dir.rglob("*.png") if path.is_file())
    chunk_files = sorted((raw_dir / "transcription_chunks").glob("*")) if (raw_dir / "transcription_chunks").is_dir() else []

    copied_source = next((path for path in raw_files if path.name == source_path.name), None)
    if not copied_source:
        copied_source = raw_dir / "recording.webm" if (raw_dir / "recording.webm").exists() else None

    lines = [
        "# Source Materials",
        "",
        "Use this manifest during brainstorm so requirements can be traced back to the raw feedback evidence.",
        "",
        "## Original Source",
        "",
        f"- Source kind: `{source_kind}`",
        f"- Original path: `{source_path}`",
        f"- Local raw copy: `{link(copied_source) if copied_source else 'n/a'}`",
        "- Commit policy: raw media, audio chunks, zip contents, session dumps, and extracted screenshots are local-only by default; commit generated Markdown/JSON/manifests when useful for brainstorm/planning traceability.",
        f"- Session URL: `{session.get('url', 'unknown')}`",
        f"- Duration: `{session.get('duration_seconds', 'unknown')}` seconds",
        "",
        "## Analysis Artifacts",
        "",
        f"- Analysis summary: `{link(output_path.parent / 'analysis.md')}`",
        f"- Problem statements: `{link(output_path.parent / 'problem-analysis.md')}`",
        f"- Review prompt: `{link(output_path.parent / 'review-prompt.md')}`",
        f"- Requirements kickoff: `{link(output_path.parent / 'requirements-kickoff.md')}`",
        f"- Structured JSON: `{link(output_path.parent / 'analysis.json')}`",
        "",
        "## Transcript",
        "",
        f"- Transcript status: `{transcript.get('status', 'unknown')}`",
        f"- Transcript source: `{transcript.get('source', source_kind)}`",
        f"- Transcript text lives in: `{link(output_path.parent / 'analysis.md')}` and `{link(output_path.parent / 'review-prompt.md')}`",
    ]

    if chunk_files:
        lines.append("- Transcription chunks:")
        lines.append(f"  - retained locally in `{link(raw_dir / 'transcription_chunks')}`; not commit-safe by default.")

    lines.extend(["", "## Local-Only Frames", ""])
    lines.append("Extracted screenshots are retained locally for agent inspection and should not be committed by default.")
    lines.append("")
    if moments:
        lines.append("| Moment | Time | Screenshot | Why selected |")
        lines.append("|---|---:|---|---|")
        for moment in moments:
            screenshot = moment.get("screenshot")
            lines.append(
                f"| {moment['id']} | {format_time(moment['t'])} | `{markdown_link(screenshot, output_path.parent, repo_root)}` | {moment['reason']} |"
            )
    else:
        lines.append("_No video frames were available for this source._")

    if frame_files:
        lines.extend(["", "All frame files:"])
        for frame in frame_files:
            lines.append(f"- `{link(frame)}`")

    lines.extend(["", "## Local Raw Files", ""])
    lines.append("Raw files are intentionally local-only by default. Do not commit these unless the user explicitly asks and privacy/security is acceptable.")
    lines.append("")
    for raw_file in raw_files[:50]:
        lines.append(f"- `{link(raw_file)}`")
    if len(raw_files) > 50:
        lines.append(f"- ... {len(raw_files) - 50} more files")

    output_path.write_text("\n".join(lines) + "\n")


def write_problem_analysis(
    output_path: Path,
    transcript: dict[str, Any],
    moments: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    annotations: list[dict[str, Any]],
    repo_root: Path,
) -> None:
    complaint_text = transcript.get("text") or ""
    lines = [
        "<analysis>",
        "## 1. Visual/UI Problems",
        "",
    ]
    if moments:
        lines.extend(
            [
                "1. Review required: inspect the extracted frames and replace this scaffold with precise visual observations. Include location, UI element type, issue description, and frame reference.",
                "",
            ]
        )
    else:
        lines.extend(["1. No video frames were available for this source.", ""])

    lines.extend(["## 2. Functional Problems", ""])

    for index, finding in enumerate(findings, start=1):
        evidence = ", ".join(finding.get("evidence", [])) or "n/a"
        lines.append(
            f"{index}. {finding['title']}: {finding['observed']} Evidence: {evidence}. Context from discussion: {compact_text(complaint_text, 220) or 'n/a'}"
        )
    if not findings:
        lines.append("1. No functional problems were detected automatically; inspect transcript and frames manually.")

    lines.extend(["", "## 3. Requirements", ""])
    req_index = 1
    for note in annotations:
        comment = (note.get("comment") or "").strip()
        if not comment:
            continue
        element = note.get("element") or ""
        lines.append(
            f"{req_index}. Reviewer written request: {comment}"
            + (f" (on `{element}`)" if element else "")
            + " — treat as a first-class requirement; capture rationale and specifics during synthesis."
        )
        req_index += 1
    lines.append(
        f"{req_index}. Convert confirmed problems into requirements after evidence review. State what capability or behavior is needed and why, without prescribing implementation."
    )

    lines.extend(["", "## 4. Usability/UX Problems", ""])

    for index, moment in enumerate(moments, start=1):
        screenshot = markdown_link(moment.get("screenshot"), output_path.parent, repo_root)
        lines.append(
            f"{index}. Moment {moment['id']} at {format_time(moment['t'])}: Review `{screenshot}` for UX friction related to `{moment['reason']}`."
        )
    if not moments:
        lines.append("1. Review the transcript or notes for workflow friction, confusion, and unmet expectations.")

    lines.extend(
        [
            "",
            "## 5. Caveats & Open Questions",
            "",
            "1. Anything the reviewer could not evaluate (a state that was not reachable, e.g. \"nothing live on the backend to see the played state\"), was unsure about, or explicitly raised as a question. Do not fold these into Functional Problems. Resolve each per the reachability step in `extensive-analysis.md`: check whether the state is reachable in the product repo and record the instructions, or mark it a grounded requirement if it genuinely does not exist yet. If nothing applies, state \"None identified.\"",
        ]
    )

    lines.append("</analysis>")
    output_path.write_text("\n".join(lines) + "\n")


def write_review_prompt(
    output_path: Path,
    transcript: dict[str, Any],
    moments: list[dict[str, Any]],
    repo_root: Path,
) -> None:
    frame_lines: list[str] = []
    for moment in moments:
        screenshot = markdown_link(moment.get("screenshot"), output_path.parent, repo_root)
        event_summary = "; ".join(event_label(event) for event in moment.get("events", [])) or "no event metadata"
        frame_lines.append(
            f"- {moment['id']} ({format_time(moment['t'])}, {moment['reason']}): `{screenshot}`. Events: {event_summary}"
        )
    if not frame_lines:
        frame_lines.append("- No video frames are available for this source. Analyze transcript or meeting notes only.")

    lines = [
        "You will be analyzing a product feedback session by examining video frames and a discussion transcript. Your goal is to identify problems, requirements, and feedback points that need to be addressed - focusing on clear problem statements rather than solutions.",
        "",
        "Here are the frames extracted from the video:",
        "",
        "<video_frames>",
        *frame_lines,
        "</video_frames>",
        "",
        "Here is the transcript of the discussion that occurred during the feedback session:",
        "",
        "<discussion_transcript>",
        transcript.get("text") or f"[Transcript unavailable: {transcript.get('reason') or transcript.get('status', 'unknown')}]",
        "</discussion_transcript>",
        "",
        "Your task is to carefully analyze both the visual content and the discussion to extract actionable problem statements. Follow these guidelines:",
        "",
        "**Visual Analysis Requirements:**",
        "- Examine each frame carefully for UI/UX issues, bugs, design inconsistencies, or usability problems",
        "- Be extremely precise about what you observe: specify exact locations (e.g., \"top-right corner,\" \"navigation bar,\" \"third item in the list\")",
        "- Identify specific UI elements by type (button, input field, dropdown, modal, etc.)",
        "- Note visual problems like misalignment, poor contrast, truncated text, overlapping elements, broken layouts, etc.",
        "",
        "**Discussion Analysis Requirements:**",
        "- Extract feedback points, feature requests, and problems mentioned in the conversation",
        "- Identify requirements that are stated or implied",
        "- Note any pain points or frustrations expressed by participants",
        "- Connect visual observations with relevant discussion points when applicable",
        "",
        "**Problem Statement Guidelines:**",
        "- Focus on describing WHAT the problem is, not HOW to fix it",
        "- Be specific and actionable - avoid vague statements",
        "- Each problem should be clear enough that a developer or designer can understand what needs to be addressed",
        "- Include context about where the problem occurs and why it matters",
        "",
        "Structure your final output as follows:",
        "",
        "1. **Visual/UI Problems**: Issues observed directly in the interface",
        "2. **Functional Problems**: Issues related to behavior, workflow, or functionality mentioned in discussion",
        "3. **Requirements**: New features or capabilities requested",
        "4. **Usability/UX Problems**: Issues related to user experience, confusion, or workflow friction",
        "5. **Caveats & Open Questions**: Anything the reviewer could not evaluate (a state that was not reachable), was unsure about, or raised as a question. Keep these separate from Functional Problems; state \"None identified\" if there are none.",
        "",
        "Format each problem as a clear, numbered item within its category.",
        "",
        "Your final output should contain only the analysis section with clearly categorized, numbered problem statements. Do not include scratchpad notes.",
    ]
    output_path.write_text("\n".join(lines) + "\n")


def load_sidecar(source_path: Path, annotations_arg: Path | None, source_kind: str) -> dict[str, Any]:
    """Fold in the collector's reviewer context that lives *next to* the zip, not
    inside it: the reviewer's written click-comments (annotations.json) and their
    name (the collector session.json). These carry direct reviewer intent that the
    recording alone does not.

    Sibling auto-detection is limited to collector bundles (``riffrec_zip``). A
    standalone video/audio/notes file can sit in an arbitrary directory (e.g.
    ``~/Downloads``) that happens to hold an unrelated collector ``session.json`` —
    auto-loading it there would mislabel this feedback with another submission's
    reviewer and project. An explicit ``--annotations`` path is always honored."""
    parent = source_path.parent
    is_collector_bundle = source_kind == "riffrec_zip"

    annotations: list[dict[str, Any]] = []
    ann_path = annotations_arg or ((parent / "annotations.json") if is_collector_bundle else None)
    if ann_path and ann_path.exists():
        payload = read_json(ann_path, [])
        if isinstance(payload, dict):
            payload = payload.get("annotations", [])
        if isinstance(payload, list):
            annotations = [a for a in payload if isinstance(a, dict) and not a.get("deleted")]

    reviewer = None
    project = None
    if is_collector_bundle:
        collector_session = read_json(parent / "session.json", {})
        if isinstance(collector_session, dict):
            reviewer = collector_session.get("reviewerName")
            project = collector_session.get("project")

    return {"annotations": annotations, "reviewer": reviewer, "project": project}


def _esc(value: Any) -> str:
    return html_lib.escape(str(value if value is not None else ""))


def _safe_href(value: Any) -> str | None:
    """Return an escaped href only for http(s) or root-relative URLs. The session
    URL comes from the (untrusted) feedback artifact, so a crafted `javascript:` or
    `data:` value must never become a live link the documented workflow tells the
    user to click. Anything else returns None so the caller renders it as plain text."""
    if value is None:
        return None
    raw = str(value).strip()
    lowered = raw.lower()
    if lowered.startswith(("http://", "https://")) or raw.startswith("/"):
        return _esc(raw)
    return None


def write_html_report(
    output_path: Path,
    source_path: Path,
    source_kind: str,
    session: dict[str, Any],
    transcript: dict[str, Any],
    sidecar: dict[str, Any],
    media_path: Path | None,
    media_is_video: bool,
    voice_path: Path | None = None,
) -> None:
    """The consumable HTML surface for a feedback session: synthesized requirement
    cards (filled by the reviewing agent), the recording with a requirement-tracking
    bar, and the timestamped transcript. Media is referenced by relative path (not
    inlined), so the file stays small and agent-editable; it renders when opened from
    its own output dir. ``build_standalone.py`` embeds the media for sharing.

    ``voice_path`` is the separate microphone track riffrec records alongside the
    screen capture; when present the player emits a hidden <audio> element kept in
    sync with the video by script, since the two tracks are never muxed."""
    reviewer = sidecar.get("reviewer") or "Unknown reviewer"
    project = sidecar.get("project") or session.get("url") or "unknown"
    annotations = sidecar.get("annotations") or []
    url = session.get("url", "unknown")
    url_href = _safe_href(url)
    page_html = f'<a href="{url_href}">{_esc(url)}</a>' if url_href else f'<code>{_esc(url)}</code>'
    try:
        duration = float(session.get("duration_seconds") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    started = session.get("started_at", "unknown")

    # Relative link to the recording so the player works when the report is opened
    # from its output dir. Media stays local-only per the skill's privacy rule. For
    # audio-only sources this is the voice track, played via <audio> so the transcript
    # seek buttons still have media to drive.
    media_rel = None
    if media_path and media_path.exists():
        try:
            media_rel = os.path.relpath(media_path, output_path.parent)
        except ValueError:
            media_rel = None

    seg_rows = []
    for seg in transcript.get("segments") or []:
        t = float(seg.get("t", 0.0))
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        seg_rows.append(
            f'<button class="seg" data-t="{t:.2f}"><span class="ts">{_esc(format_time(t))}</span>'
            f'<span class="seg-text">{_esc(text)}</span></button>'
        )
    segments_html = "\n".join(seg_rows) or '<p class="muted">No timestamped segments.</p>'

    # Written click-comments render as raw material INSIDE the synthesis block: the
    # agent merges them into requirement cards (badged as written) and the whole
    # block, pins included, is replaced by the synthesis. No standalone section.
    ann_cards = []
    for a in annotations:
        comment = a.get("comment") or "(no comment)"
        element = a.get("element") or ""
        page = a.get("pageUrl") or ""
        classes = a.get("cssClasses") or ""
        ann_cards.append(
            f'<div class="card ann"><p class="ann-comment">{_esc(comment)}</p>'
            f'<p class="meta">on <code>{_esc(element)}</code>'
            + (f' · <code>{_esc(classes)}</code>' if classes else "")
            + (f'<br><span class="muted">{_esc(page)}</span>' if page else "")
            + "</p></div>"
        )
    pins_block = ""
    if ann_cards:
        pins_block = (
            '\n    <p class="muted" style="margin:14px 0 8px"><strong>Written pins (raw material):</strong> '
            "merge each into a requirement card above, badged "
            '<span class="src src-written">✎ written</span> '
            '(or <span class="src src-both">✎+🎙 written + spoken</span> when the reviewer also said it).</p>\n    '
            + "\n".join(ann_cards)
        )

    full_transcript = _esc((transcript.get("text") or "").strip()) or '<span class="muted">Transcript unavailable.</span>'

    voice_rel = None
    if media_is_video and voice_path and voice_path.exists():
        try:
            voice_rel = os.path.relpath(voice_path, output_path.parent)
        except ValueError:
            voice_rel = None

    if media_rel:
        player_tag = "video" if media_is_video else "audio"
        video_block = f'<{player_tag} id="rec" controls preload="auto" src="{_esc(media_rel)}"></{player_tag}>'
        if voice_rel:
            video_block += f'\n    <audio id="voice" preload="auto" src="{_esc(voice_rel)}" style="display:none"></audio>'
        video_block += """
    <div class="nowmoment idle" id="nowmoment">
      <button class="navm" id="prevM" title="Previous requirement">‹</button>
      <div class="nm-body">
        <div class="nm-top"><span class="ct" id="nmTime"></span><span class="nm-title" id="nmTitle"></span><span class="nm-hint" id="nmHint">click to view requirement ↓</span></div>
        <span class="nm-detail" id="nmDetail"></span>
      </div>
      <button class="navm" id="nextM" title="Next requirement">›</button>
    </div>"""
        if voice_rel:
            # Screen and microphone are separate tracks (riffrec never muxes them);
            # keep the hidden audio aligned with the video element.
            video_block += """
    <script>
    (function(){
      var v=document.getElementById('rec'), a=document.getElementById('voice');
      if(!v||!a) return;
      a.volume=1; a.muted=false;
      var align=function(){ try{ a.currentTime=v.currentTime; }catch(e){} };
      v.addEventListener('play',   function(){ align(); a.play().catch(function(){}); });
      v.addEventListener('pause',  function(){ a.pause(); });
      v.addEventListener('seeked', align);
      v.addEventListener('ratechange',function(){ a.playbackRate=v.playbackRate; });
      // gentle drift correction: only while playing, only if badly out, never mid-seek
      v.addEventListener('timeupdate', function(){
        if(v.paused||v.seeking||a.seeking) return;
        if(Math.abs(a.currentTime-v.currentTime)>1.0) align();
      });
      v.addEventListener('ended',  function(){ a.pause(); });
    })();
    </script>"""
    else:
        video_block = '<p class="muted">No recording available for this source.</p>'

    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feedback · {_esc(reviewer)}</title>
<style>
  :root {{ color-scheme: dark; }}
  * {{ box-sizing: border-box; min-width: 0; }}
  body {{ margin: 0; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #e8edf2; background: #0c1116; }}
  a {{ color: #6fb3ff; }}
  code {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em;
    background: #1a2029; padding: .1em .35em; border-radius: 4px; word-break: break-word; }}
  .muted {{ color: #8a97a6; }}
  .wrap {{ max-width: 1040px; margin: 0 auto; padding: 28px 20px 80px; }}
  header.top {{ border-bottom: 1px solid #1e2732; padding-bottom: 18px; margin-bottom: 26px; }}
  header.top h1 {{ margin: 0 0 6px; font-size: 22px; }}
  .kv {{ display: flex; flex-wrap: wrap; gap: 6px 18px; color: #9fb0c0; font-size: 13px; }}
  section {{ margin: 34px 0; }}
  section > h2 {{ font-size: 15px; text-transform: uppercase; letter-spacing: .06em;
    color: #7f8ea0; margin: 0 0 14px; }}
  .card {{ background: #131a22; border: 1px solid #1e2732; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }}
  .ann-comment {{ margin: 0 0 6px; font-size: 16px; font-weight: 600; }}
  .meta {{ font-size: 12.5px; color: #8a97a6; margin: 4px 0 0; }}
  button.seg {{ font: inherit; cursor: pointer; border: 1px solid #2a3644; background: #1a2431; color: #cfe0f0; border-radius: 6px; }}
  button.seg:hover {{ border-color: #6fb3ff; }}
  .transcript-segs {{ display: flex; flex-direction: column; gap: 4px; }}
  button.seg {{ display: flex; gap: 12px; text-align: left; padding: 8px 10px; align-items: baseline; }}
  button.seg .ts {{ color: #6fb3ff; font-variant-numeric: tabular-nums; flex: 0 0 auto; font-size: 12.5px; }}
  .seg-text {{ flex: 1 1 auto; }}
  details.full {{ margin-top: 12px; }}
  details.full pre {{ white-space: pre-wrap; background: #131a22; border: 1px solid #1e2732; border-radius: 10px; padding: 14px 16px; }}
  video, audio {{ width: 100%; border-radius: 10px; border: 1px solid #1e2732; background: #000; }}
  audio {{ background: #131a22; }}
  .badge {{ font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; font-weight: 700; }}
  .badge.warn {{ background: #3a2d12; color: #ffca6b; }}
  .badge.ok {{ background: #12321f; color: #7ee0a3; }}
  .badge.muted-badge {{ background: #222b35; color: #8a97a6; }}
  .synthesis-placeholder {{ border: 1px dashed #33465a; border-radius: 10px; padding: 18px; color: #9fb0c0; background: #101822; }}
  .req {{ background: #131a22; border: 1px solid #1e2732; border-left: 3px solid #6fb3ff; border-radius: 10px; margin-bottom: 10px; overflow: hidden; }}
  .req > summary {{ list-style: none; cursor: pointer; padding: 13px 48px 13px 16px; position: relative; }}
  .req > summary::-webkit-details-marker {{ display: none; }}
  .req > summary:hover {{ background: #161f29; }}
  .req-head {{ display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }}
  .req-head h3 {{ margin: 0; font-size: 15px; }}
  .chev {{ position: absolute; right: 18px; top: 50%; transform: translateY(-50%); color: #8a97a6; font-size: 28px; line-height: 1; transition: transform .15s ease; }}
  .req > summary:hover .chev {{ color: #cfe0f0; }}
  .req[open] .chev {{ transform: translateY(-50%) rotate(90deg); }}
  .req-badges {{ display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }}
  .req-statement {{ margin: 8px 0 0; font-size: 13px; color: #c3d0dc; }}
  .req-body {{ padding: 2px 16px 15px; border-top: 1px solid #1a222c; margin-top: 11px; }}
  .req-body dl {{ display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 11px 0 0; font-size: 12.5px; }}
  .req-body dt {{ color: #7f8ea0; text-transform: uppercase; letter-spacing: .04em; font-size: 10px; font-weight: 700; padding-top: 2px; }}
  .req-body dd {{ margin: 0; }}
  .req-body .quote {{ margin: 12px 0 0; padding: 8px 12px; border-left: 2px solid #2a3644; color: #b7c4d2; font-style: italic; font-size: 12.5px; }}
  .src {{ font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; white-space: nowrap; letter-spacing: .02em; }}
  .bucket {{ font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 999px; white-space: nowrap; letter-spacing: .05em; text-transform: uppercase; }}
  .bucket-change  {{ background: #12321f; color: #7ee0a3; }}
  .bucket-try     {{ background: #14263a; color: #6fb3ff; }}
  .bucket-discuss {{ background: #2e2440; color: #c39bff; }}
  .bucket-respond {{ background: #3a2d12; color: #ffca6b; }}
  .bucket-blocked {{ background: #3a1a1a; color: #ff9a8a; }}
  .bucket-defer   {{ background: #222b35; color: #8a97a6; }}
  .src-written {{ background: #12283a; color: #7db6ff; }}
  .src-spoken  {{ background: #2e2440; color: #c39bff; }}
  .src-both    {{ background: #12321f; color: #7ee0a3; }}
  .tstamp {{ font: inherit; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; cursor: pointer; border: 1px solid #2a3644; background: #14263a; color: #6fb3ff; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }}
  .tstamp:hover {{ border-color: #6fb3ff; color: #cfe0f0; }}
  .nowmoment {{ display: flex; align-items: center; gap: 10px; margin-top: 10px; background: #131a22; border: 1px solid #1e2732; border-radius: 10px; padding: 18px 14px; min-height: 88px; }}
  .nowmoment.idle .nm-body {{ cursor: default; }}
  .nowmoment.idle .nm-body:hover {{ background: transparent; }}
  .nowmoment.idle .nm-title {{ color: #55636f; font-weight: 400; font-size: 13.5px; }}
  .nowmoment.idle .nm-top {{ justify-content: center; }}
  .nowmoment.idle .ct, .nowmoment.idle .nm-detail {{ display: none; }}
  .nowmoment .navm {{ flex: 0 0 auto; align-self: stretch; font: inherit; font-size: 17px; line-height: 1; cursor: pointer; border: none; background: transparent; color: #6f7f90; padding: 0 18px; margin: -18px 0; }}
  .nowmoment .navm:first-child {{ margin-left: -14px; border-radius: 9px 0 0 9px; }}
  .nowmoment .navm:last-child {{ margin-right: -14px; border-radius: 0 9px 9px 0; }}
  .nowmoment .navm:hover:not(:disabled) {{ color: #e8edf2; background: #1a2431; }}
  .nowmoment .navm:disabled {{ opacity: .25; cursor: default; }}
  .nm-body {{ flex: 1 1 auto; min-width: 0; cursor: pointer; border-radius: 8px; padding: 2px 6px; margin: -2px -6px; }}
  .nm-body:hover {{ background: #1a2431; }}
  .nm-hint {{ flex: 0 0 auto; color: #55636f; font-size: 11px; }}
  .nm-top {{ display: flex; align-items: baseline; gap: 10px; }}
  .nm-top .ct {{ color: #6fb3ff; font-size: 12px; font-variant-numeric: tabular-nums; font-weight: 700; flex: 0 0 auto; }}
  .nm-title {{ font-weight: 700; font-size: 15px; }}
  .nm-detail {{ display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; font-size: 13px; line-height: 1.5; color: #8a97a6; margin-top: 4px; overflow: hidden; }}
  .backto {{ position: fixed; right: 22px; bottom: 22px; z-index: 40; display: none; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; border: 1px solid #2a3644; background: #1a2431; color: #cfe0f0; border-radius: 999px; padding: 9px 16px; box-shadow: 0 4px 18px rgba(0,0,0,.5); }}
  .backto.on {{ display: block; }}
  .backto:hover {{ border-color: #6fb3ff; }}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Product feedback · {_esc(reviewer)}</h1>
    <div class="kv">
      <span>Project: <code>{_esc(project)}</code></span>
      <span>Page: {page_html}</span>
      <span>Duration: {_esc(format_time(duration))}</span>
      <span>Recorded: {_esc(started)}</span>
      <span>Source: {_esc(source_kind)}</span>
    </div>
  </header>

  <section id="synthesis">
    <h2>Synthesized requirements</h2>
    <!-- AGENT-SYNTHESIS-START: the reviewing agent replaces everything between these
         markers (placeholder, example card, and any written pins below) with one
         <details class="req"> card per requirement, following the example card and
         extensive-analysis.md. Also fill the SEGMENTS array in the footer script so
         the bar under the player tracks the requirements during playback. -->
    <div class="synthesis-placeholder">
      <strong>Pending agent synthesis.</strong> The reviewing agent replaces this block
      with one collapsible card per requirement, synthesized from the transcript, the
      written pins, and the extracted frames using the nuance-preserving rubric.
    </div>
    <!-- Example requirement card (copy per requirement; delete this comment):
    <details class="req" id="req-r1" style="border-left-color:#7ee0a3">
      <summary>
        <div class="req-head"><h3>R1 · Short requirement title</h3><span class="chev">▸</span></div>
        <div class="req-badges"><span class="src src-spoken">🎙 spoken</span><button class="tstamp" data-t="30">▶ 00:30</button><span class="badge ok">concrete</span></div>
        <p class="req-statement">One-line statement of the product behavior needed, with the key parameters inline.</p>
      </summary>
      <div class="req-body">
        <dl>
          <dt>Rationale</dt><dd>Why, in the reviewer's own framing.</dd>
          <dt>Parameters</dt><dd>Concrete specifics the reviewer named: colors, states, thresholds, copy.</dd>
          <dt>Parity</dt><dd>Prior art the reviewer cited; net-new vs port/verify, with a reachability check when the source is in the workspace.</dd>
          <dt>Confidence</dt><dd>The reviewer's own certainty, hedges included.</dd>
          <dt>Surfaces</dt><dd>Screens/pages/states it touches.</dd>
        </dl>
        <p class="quote">"Verbatim quote." · <button class="tstamp" data-t="30">▶ 0:30</button></p>
      </div>
    </details>
    Conventions: source badges are span.src src-written (✎ written), src-spoken (🎙 spoken),
    src-both (✎+🎙 written + spoken). Weight badges are span.badge ok (concrete) or
    muted-badge (exploratory). button.tstamp with data-t seconds seeks the recording.
    Border-left color: #7ee0a3 concrete, default blue exploratory, #8a97a6 caveats.
    Caveats the reviewer flagged get their own card (id req-caveat, resolved or
    unresolved per the reachability check).
    Bucket badges (added only after the triage table is approved - see
    references/feedback-triage.md): append one span.bucket bucket-<name> to each card's
    req-badges row, where <name> is change|try|discuss|respond|blocked|defer, e.g.
    <span class="bucket bucket-change">change</span>. Non-code outcomes are delivered on
    the card body: respond adds <dt>Answer</dt><dd>...</dd>, blocked adds
    <dt>Waiting on</dt><dd>input + named owner</dd>, defer adds
    <dt>Queued</dt><dd>backlog pointer</dd>. -->{pins_block}
    <!-- AGENT-SYNTHESIS-END -->
  </section>

  <section>
    <h2>Recording</h2>
    {video_block}
  </section>

  <section>
    <h2>Transcript</h2>
    <div class="transcript-segs">
      {segments_html}
    </div>
    <details class="full"><summary>Full transcript (plain)</summary><pre>{full_transcript}</pre></details>
  </section>
</div>

<button class="backto" id="backto">↩ Back</button>
<script>
  var rec = document.getElementById('rec');
  var backBtn = document.getElementById('backto');
  var returnY = null;

  function seek(t, remember) {{
    if (!rec) return;
    if (remember) {{ returnY = window.scrollY; backBtn.classList.add('on'); }}
    rec.currentTime = t; rec.play().catch(function(){{}});
    rec.scrollIntoView({{behavior: 'smooth', block: 'center'}});
  }}

  // transcript segs + in-card ▶ buttons all seek; jumps remember where you were
  document.querySelectorAll('[data-t]').forEach(function(el) {{
    el.addEventListener('click', function(e) {{
      e.stopPropagation(); e.preventDefault();
      seek(parseFloat(el.getAttribute('data-t')), true);
    }});
  }});

  backBtn.addEventListener('click', function() {{
    if (returnY !== null) window.scrollTo({{top: returnY, behavior: 'smooth'}});
    backBtn.classList.remove('on'); returnY = null;
  }});

  // "Current requirement" bar under the player: shows which synthesized requirement
  // the reviewer is talking about at the current timestamp; click it to jump to the
  // card. AGENT-SEGMENTS: during synthesis, fill this array with one entry per
  // timeline segment, in playback order. t is where the segment starts (seconds);
  // target is the id of the requirement card it links to. Example entry:
  //   {{ id:'R1', t:30.00, time:'00:30', title:'Short requirement title',
  //     detail:'One-line detail or verbatim quote.', target:'req-r1' }}
  var SEGMENTS = [];
  var nmBar = document.getElementById('nowmoment');
  if (nmBar && (!rec || SEGMENTS.length === 0)) {{ nmBar.style.display = 'none'; }}
  if (nmBar && rec && SEGMENTS.length > 0) {{
    var nmTime = document.getElementById('nmTime'), nmTitle = document.getElementById('nmTitle'),
        nmDetail = document.getElementById('nmDetail'), nmHint = document.getElementById('nmHint'),
        prevBtn = document.getElementById('prevM'), nextBtn = document.getElementById('nextM'),
        nmBody = nmBar.querySelector('.nm-body');
    var curIdx = -1;
    var renderMoment = function(i) {{
      curIdx = i;
      if (i < 0) {{
        nmBar.classList.add('idle');
        nmTitle.textContent = 'No captured feedback in this segment';
        nmHint.style.display = 'none';
        prevBtn.disabled = true;
        nextBtn.disabled = false;
        return;
      }}
      nmBar.classList.remove('idle');
      nmHint.style.display = '';
      var m = SEGMENTS[i];
      nmTime.textContent = m.time + ' · ' + m.id;
      nmTitle.textContent = m.title;
      nmDetail.textContent = m.detail;
      prevBtn.disabled = (i === 0);
      nextBtn.disabled = (i === SEGMENTS.length - 1);
    }};
    var momentIndexAt = function(t) {{
      var idx = -1;
      for (var i = 0; i < SEGMENTS.length; i++) if (SEGMENTS[i].t <= t + 0.05) idx = i;
      return idx;
    }};
    rec.addEventListener('timeupdate', function() {{
      var i = momentIndexAt(rec.currentTime);
      if (i !== curIdx) renderMoment(i);
    }});
    prevBtn.addEventListener('click', function() {{ if (curIdx > 0) {{ seek(SEGMENTS[curIdx - 1].t, false); renderMoment(curIdx - 1); }} }});
    nextBtn.addEventListener('click', function() {{ if (curIdx < SEGMENTS.length - 1) {{ seek(SEGMENTS[curIdx + 1].t, false); renderMoment(curIdx + 1); }} }});
    nmBody.addEventListener('click', function() {{
      if (curIdx < 0) return;
      var card = document.getElementById(SEGMENTS[curIdx].target);
      if (card) {{ card.open = true; card.scrollIntoView({{behavior: 'smooth', block: 'center'}}); }}
    }});
    renderMoment(momentIndexAt(rec.currentTime));
  }}
</script>
</body>
</html>
"""
    output_path.write_text(html)


def main() -> int:
    args = parse_args()
    source_path = args.source_path.expanduser().resolve()
    if not source_path.exists():
        print(f"Source file not found: {source_path}", file=sys.stderr)
        return 1

    output_dir = (args.output_dir or default_output_dir(source_path)).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_dir = output_dir / "raw"
    frames_dir = output_dir / "frames"
    source = prepare_source(source_path, raw_dir)
    source_kind = source["source_kind"]
    session = source["session"]
    events = source["events"]
    duration = source["duration"]

    if source["notes_transcript"]:
        transcript = source["notes_transcript"]
    elif args.no_transcribe:
        transcript = {"status": "skipped", "text": "", "reason": "--no-transcribe was passed"}
    else:
        transcript = transcribe_media(source["transcription_path"], args.model)
        if should_retry_transcription_in_chunks(transcript):
            transcript = transcribe_media_chunks(
                source["transcription_path"],
                args.model,
                raw_dir / "transcription_chunks",
                duration,
            )

    moments = select_moments(events, transcript.get("text", ""), duration, args.max_moments, transcript.get("segments"))
    if not moments and source["recording_path"]:
        fallback_times = [0.5, 2.0, 5.0, 10.0, 15.0]
        moments = [
            {"id": f"M{index}", "t": timestamp, "reason": "representative video frame", "events": []}
            for index, timestamp in enumerate(fallback_times[: args.max_moments], start=1)
        ]
    extract_frames(source["recording_path"], frames_dir, moments)
    findings = summarize_candidate_findings(moments, transcript.get("text", ""))

    # Load the reviewer sidecar (written click-comments + reviewer name) BEFORE the
    # markdown artifacts, so those synthesis inputs — which the extensive workflow
    # tells agents to read — actually contain the first-class written feedback.
    sidecar = load_sidecar(source_path, args.annotations, source_kind)
    annotations = sidecar.get("annotations") or []

    topic = slugify(args.topic or source_path.stem)
    repo_root = Path.cwd()
    analysis_md = output_dir / "analysis.md"
    problem_analysis_md = output_dir / "problem-analysis.md"
    review_prompt_md = output_dir / "review-prompt.md"
    source_materials_md = output_dir / "source-materials.md"
    kickoff_md = output_dir / "requirements-kickoff.md"
    write_analysis_md(analysis_md, source_path, source_kind, session, events, transcript, moments, findings, annotations, repo_root)
    write_problem_analysis(problem_analysis_md, transcript, moments, findings, annotations, repo_root)
    write_review_prompt(review_prompt_md, transcript, moments, repo_root)
    write_source_materials(source_materials_md, source_path, source_kind, session, transcript, moments, raw_dir, frames_dir, repo_root)
    write_requirements_kickoff(kickoff_md, topic, session, findings, moments, repo_root)

    # Riffrec records screen and microphone as two separate cue-less webm streams;
    # repair both so the report's player gets reliable duration/seeking and audio.
    recording_path = source["recording_path"]
    voice_path = source["transcription_path"]
    if source_kind == "riffrec_zip":
        recording_path, voice_path = repair_media(recording_path, voice_path, raw_dir)

    # Audio-only sources have no recording_path; fall back to the voice track so the
    # report still gets a player (rendered as <audio>) and the transcript seek works.
    media_path = recording_path or voice_path
    media_is_video = recording_path is not None
    report_html = output_dir / "report.html"
    write_html_report(
        report_html, source_path, source_kind, session, transcript,
        sidecar, media_path, media_is_video,
        voice_path=voice_path if (media_is_video and source_kind == "riffrec_zip") else None,
    )

    structured = {
        "source": str(source_path),
        "source_kind": source_kind,
        "output_dir": str(output_dir),
        "session": session,
        "event_counts": event_counts(events),
        "transcript": transcript,
        "moments": moments,
        "candidate_findings": findings,
        "reviewer": sidecar.get("reviewer"),
        "annotations": sidecar.get("annotations"),
        "artifacts": {
            "report_html": str(report_html),
            "analysis_md": str(analysis_md),
            "problem_analysis_md": str(problem_analysis_md),
            "review_prompt_md": str(review_prompt_md),
            "source_materials_md": str(source_materials_md),
            "requirements_kickoff_md": str(kickoff_md),
            "frames_dir": str(frames_dir),
            "raw_dir": str(raw_dir),
        },
    }
    (output_dir / "analysis.json").write_text(json.dumps(structured, indent=2, sort_keys=True) + "\n")

    print(f"Report written to: {report_html}")
    print(f"Analysis written to: {analysis_md}")
    print(f"Problem analysis scaffold written to: {problem_analysis_md}")
    print(f"Review prompt written to: {review_prompt_md}")
    print(f"Source materials manifest written to: {source_materials_md}")
    print(f"Requirements kickoff written to: {kickoff_md}")
    print(f"Frames written to: {frames_dir}")
    print("")
    print("Analysis complete. Ready to plan the findings.")
    # Machine-readable line: the skill opens this in the harness browser (OS default as fallback).
    print(f"REPORT_HTML={report_html}")
    # After the synthesis block is filled, build the shareable single file (media embedded):
    print(f"STANDALONE_BUILD=python3 {Path(__file__).resolve().parent / 'build_standalone.py'} {output_dir}")
    print(f"Source materials: {display_path(source_materials_md, repo_root)}")
    print(f"Problem statements: {display_path(problem_analysis_md, repo_root)}")
    print("Triage gate: bucket every requirement (change/try/discuss/respond/blocked/defer per references/feedback-triage.md) and get the table approved as triage.md before planning.")
    print(f"Planning handoff: after triage approval, load inc:plan with {display_path(kickoff_md, repo_root)} and triage.md")
    print("Planning should first confirm whether the captured requirements are complete and correctly grouped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
