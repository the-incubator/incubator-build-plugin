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


def prepare_source(source_path: Path, raw_dir: Path) -> dict[str, Any]:
    raw_dir.mkdir(parents=True, exist_ok=True)
    source_kind = classify_source(source_path)

    if source_kind == "riffrec_zip":
        safe_extract(source_path, raw_dir)
        session = read_json(raw_dir / "session.json", {})
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
        "  - **Covered by:** R1, R2, R3",
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
        "> The agent fills these from the transcript and frames. The items below are"
        " machine-detected _signals to verify_, not requirements — a heuristic-signal"
        " may be a non-issue, and real requirements (including ones with no keyword or"
        " DOM signal at all) must be added by reading the transcript directly.",
        "",
    ]

    for index, finding in enumerate(findings, start=3):
        kind = finding.get("kind", "signal")
        lines.append(
            f"- R{index}. _(verify — {kind}, {finding.get('confidence', 'unrated')})_"
            f" {finding['id']}: {finding['title']}."
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
            "-> Resume `/inc:plan` to confirm candidate findings and replace generic R-items with product-specific requirements.",
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

    lines.extend(
        [
            "",
            "## 3. Requirements",
            "",
            "1. Convert confirmed problems into requirements after evidence review. State what capability or behavior is needed and why, without prescribing implementation.",
            "",
            "## 4. Usability/UX Problems",
            "",
        ]
    )

    for index, moment in enumerate(moments, start=1):
        screenshot = markdown_link(moment.get("screenshot"), output_path.parent, repo_root)
        lines.append(
            f"{index}. Moment {moment['id']} at {format_time(moment['t'])}: Review `{screenshot}` for UX friction related to `{moment['reason']}`."
        )
    if not moments:
        lines.append("1. Review the transcript or notes for workflow friction, confusion, and unmet expectations.")

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
        "",
        "Format each problem as a clear, numbered item within its category.",
        "",
        "Your final output should contain only the analysis section with clearly categorized, numbered problem statements. Do not include scratchpad notes.",
    ]
    output_path.write_text("\n".join(lines) + "\n")


def load_sidecar(source_path: Path, annotations_arg: Path | None) -> dict[str, Any]:
    """Fold in the collector's reviewer context that lives *next to* the zip, not
    inside it: the reviewer's written click-comments (annotations.json) and their
    name (the collector session.json). These carry direct reviewer intent that the
    recording alone does not."""
    parent = source_path.parent
    annotations: list[dict[str, Any]] = []
    ann_path = annotations_arg or (parent / "annotations.json")
    if ann_path and ann_path.exists():
        payload = read_json(ann_path, [])
        if isinstance(payload, dict):
            payload = payload.get("annotations", [])
        if isinstance(payload, list):
            annotations = [a for a in payload if isinstance(a, dict) and not a.get("deleted")]

    reviewer = None
    project = None
    collector_session = read_json(parent / "session.json", {})
    if isinstance(collector_session, dict):
        reviewer = collector_session.get("reviewerName")
        project = collector_session.get("project")

    return {"annotations": annotations, "reviewer": reviewer, "project": project}


def _frame_src(path: str | None, report_dir: Path) -> str | None:
    """Relative link to the frame PNG (not inlined). Keeps report.html small and
    cheap for a downstream agent to Read/Edit — inlining base64 would balloon the
    file to megabytes and make the ``#synthesis`` edit step read the whole blob into
    context. Frames render when the report is opened from its own folder, same as
    the recording."""
    if not path:
        return None
    p = Path(path)
    if not p.exists():
        return None
    try:
        return os.path.relpath(p, report_dir)
    except ValueError:
        return str(p)


def _esc(value: Any) -> str:
    return html_lib.escape(str(value if value is not None else ""))


def write_html_report(
    output_path: Path,
    source_path: Path,
    source_kind: str,
    session: dict[str, Any],
    transcript: dict[str, Any],
    moments: list[dict[str, Any]],
    findings: list[dict[str, Any]],
    sidecar: dict[str, Any],
    recording_path: Path | None,
) -> None:
    """A single self-contained HTML report — the consumable surface for a feedback
    session. Frames and the recording are referenced by relative path (not inlined),
    so the file stays small and agent-editable and moments can seek the video in
    place; it renders when opened from its own output dir. The ``#synthesis`` section
    is a placeholder the reviewing agent fills from the rubric."""
    reviewer = sidecar.get("reviewer") or "Unknown reviewer"
    project = sidecar.get("project") or session.get("url") or "unknown"
    annotations = sidecar.get("annotations") or []
    url = session.get("url", "unknown")
    try:
        duration = float(session.get("duration_seconds") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    started = session.get("started_at", "unknown")

    # Relative link to the recording so <video> plays when the report is opened
    # from its output dir. Recordings stay local-only per the skill's privacy rule.
    video_rel = None
    if recording_path and recording_path.exists():
        try:
            video_rel = os.path.relpath(recording_path, output_path.parent)
        except ValueError:
            video_rel = None

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
    annotations_html = "\n".join(ann_cards) or '<p class="muted">No written click-comments were left.</p>'

    moment_cards = []
    for m in moments:
        src = _frame_src(m.get("screenshot"), output_path.parent)
        t = float(m.get("t", 0.0))
        reason = m.get("reason", "")
        evidence = " · ".join(compact_text(event_label(ev), 80) for ev in m.get("events", []))
        img = (
            f'<img src="{_esc(src)}" alt="frame at {_esc(format_time(t))}" loading="lazy">'
            if src
            else f'<div class="noframe">no frame<br><span class="muted">{_esc(m.get("screenshot_status", ""))}</span></div>'
        )
        seek = (
            f'<button class="seek" data-t="{t:.2f}">▶ {_esc(format_time(t))}</button>'
            if video_rel
            else f'<span class="ts">{_esc(format_time(t))}</span>'
        )
        moment_cards.append(
            f'<figure class="moment">{img}'
            f'<figcaption><div class="moment-head">{seek}<span class="mid">{_esc(m.get("id"))}</span></div>'
            f'<div class="reason">{_esc(reason)}</div>'
            + (f'<div class="ev muted">{_esc(evidence)}</div>' if evidence else "")
            + "</figcaption></figure>"
        )
    moments_html = "\n".join(moment_cards) or '<p class="muted">No frames were extracted (audio-only or notes source).</p>'

    finding_cards = []
    for f in findings:
        kind = f.get("kind", "signal")
        badge = {
            "heuristic-signal": ("heuristic", "warn"),
            "observed-signal": ("observed", "ok"),
            "none": ("no signal", "muted-badge"),
        }.get(kind, (kind, "muted-badge"))
        finding_cards.append(
            f'<div class="card finding"><div class="finding-head">'
            f'<span class="badge {badge[1]}">{_esc(badge[0])}</span>'
            f'<strong>{_esc(f.get("id"))}. {_esc(f.get("title"))}</strong></div>'
            f'<p>{_esc(f.get("observed"))}</p>'
            f'<p class="meta">Confidence: {_esc(f.get("confidence"))} · Evidence: {_esc(", ".join(f.get("evidence", [])))}</p>'
            "</div>"
        )
    findings_html = "\n".join(finding_cards)

    full_transcript = _esc((transcript.get("text") or "").strip()) or '<span class="muted">Transcript unavailable.</span>'

    video_block = (
        f'<video id="rec" controls preload="metadata" src="{_esc(video_rel)}"></video>'
        f'<p class="muted">Recording is local-only ({_esc(source_path.name)}); it is not embedded, '
        "so this player works when the report is opened from its own folder.</p>"
        if video_rel
        else '<p class="muted">No video recording available for this source.</p>'
    )

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
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(min(280px,100%),1fr)); gap: 14px; }}
  figure.moment {{ margin: 0; background: #131a22; border: 1px solid #1e2732; border-radius: 10px; overflow: hidden; }}
  figure.moment img {{ display: block; width: 100%; height: auto; background: #000; cursor: zoom-in; }}
  .noframe {{ aspect-ratio: 16/9; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #8a97a6; text-align: center; }}
  figcaption {{ padding: 10px 12px; }}
  .moment-head {{ display: flex; align-items: center; gap: 10px; }}
  .mid {{ font-weight: 700; color: #9fb0c0; font-size: 12px; }}
  .reason {{ font-size: 13px; margin-top: 4px; }}
  .ev {{ font-size: 12px; margin-top: 4px; }}
  button.seek, button.seg {{ font: inherit; cursor: pointer; border: 1px solid #2a3644; background: #1a2431; color: #cfe0f0; border-radius: 6px; }}
  button.seek {{ padding: 3px 9px; font-size: 12.5px; font-weight: 600; }}
  button.seek:hover, button.seg:hover {{ border-color: #6fb3ff; }}
  .transcript-segs {{ display: flex; flex-direction: column; gap: 4px; }}
  button.seg {{ display: flex; gap: 12px; text-align: left; padding: 8px 10px; align-items: baseline; }}
  button.seg .ts {{ color: #6fb3ff; font-variant-numeric: tabular-nums; flex: 0 0 auto; font-size: 12.5px; }}
  .seg-text {{ flex: 1 1 auto; }}
  details.full {{ margin-top: 12px; }}
  details.full pre {{ white-space: pre-wrap; background: #131a22; border: 1px solid #1e2732; border-radius: 10px; padding: 14px 16px; }}
  video {{ width: 100%; border-radius: 10px; border: 1px solid #1e2732; background: #000; }}
  .badge {{ font-size: 11px; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 999px; font-weight: 700; }}
  .badge.warn {{ background: #3a2d12; color: #ffca6b; }}
  .badge.ok {{ background: #12321f; color: #7ee0a3; }}
  .badge.muted-badge {{ background: #222b35; color: #8a97a6; }}
  .finding-head {{ display: flex; align-items: center; gap: 10px; margin-bottom: 6px; flex-wrap: wrap; }}
  .synthesis-placeholder {{ border: 1px dashed #33465a; border-radius: 10px; padding: 18px; color: #9fb0c0; background: #101822; }}
  .lightbox {{ position: fixed; inset: 0; background: rgba(0,0,0,.9); display: none; align-items: center; justify-content: center; padding: 24px; z-index: 50; cursor: zoom-out; }}
  .lightbox img {{ max-width: 100%; max-height: 100%; border-radius: 6px; }}
  .lightbox.on {{ display: flex; }}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>Product feedback · {_esc(reviewer)}</h1>
    <div class="kv">
      <span>Project: <code>{_esc(project)}</code></span>
      <span>Page: <a href="{_esc(url)}">{_esc(url)}</a></span>
      <span>Duration: {_esc(format_time(duration))}</span>
      <span>Recorded: {_esc(started)}</span>
      <span>Source: {_esc(source_kind)}</span>
    </div>
  </header>

  <section id="synthesis">
    <h2>Synthesized requirements</h2>
    <!-- AGENT-SYNTHESIS-START: the reviewing agent replaces this block with the
         per-requirement synthesis (statement / rationale / parameters / parity /
         confidence / surfaces / verbatim quote + timestamp) per extensive-analysis.md. -->
    <div class="synthesis-placeholder">
      <strong>Pending agent synthesis.</strong> The analyzer produced the evidence below.
      The reviewing agent fills this section from the transcript and frames using the
      nuance-preserving rubric — do not treat the machine signals as the requirements.
    </div>
    <!-- AGENT-SYNTHESIS-END -->
  </section>

  <section>
    <h2>Reviewer notes ({len(annotations)})</h2>
    {annotations_html}
  </section>

  <section>
    <h2>Recording</h2>
    {video_block}
  </section>

  <section>
    <h2>Moments ({len(moments)})</h2>
    <div class="grid">
      {moments_html}
    </div>
  </section>

  <section>
    <h2>Transcript</h2>
    <div class="transcript-segs">
      {segments_html}
    </div>
    <details class="full"><summary>Full transcript (plain)</summary><pre>{full_transcript}</pre></details>
  </section>

  <section>
    <h2>Machine signals (verify — not requirements)</h2>
    {findings_html}
  </section>
</div>

<div class="lightbox" id="lb"><img alt=""></div>
<script>
  var rec = document.getElementById('rec');
  function seek(t) {{ if (!rec) return; rec.currentTime = t; rec.play().catch(function(){{}});
    rec.scrollIntoView({{behavior: 'smooth', block: 'center'}}); }}
  document.querySelectorAll('[data-t]').forEach(function(el) {{
    el.addEventListener('click', function() {{ seek(parseFloat(el.getAttribute('data-t'))); }});
  }});
  var lb = document.getElementById('lb'), lbImg = lb.querySelector('img');
  document.querySelectorAll('figure.moment img').forEach(function(img) {{
    img.addEventListener('click', function(e) {{ e.stopPropagation(); lbImg.src = img.src; lb.classList.add('on'); }});
  }});
  lb.addEventListener('click', function() {{ lb.classList.remove('on'); lbImg.src=''; }});
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

    topic = slugify(args.topic or source_path.stem)
    repo_root = Path.cwd()
    analysis_md = output_dir / "analysis.md"
    problem_analysis_md = output_dir / "problem-analysis.md"
    review_prompt_md = output_dir / "review-prompt.md"
    source_materials_md = output_dir / "source-materials.md"
    kickoff_md = output_dir / "requirements-kickoff.md"
    write_analysis_md(analysis_md, source_path, source_kind, session, events, transcript, moments, findings, repo_root)
    write_problem_analysis(problem_analysis_md, transcript, moments, findings, repo_root)
    write_review_prompt(review_prompt_md, transcript, moments, repo_root)
    write_source_materials(source_materials_md, source_path, source_kind, session, transcript, moments, raw_dir, frames_dir, repo_root)
    write_requirements_kickoff(kickoff_md, topic, session, findings, moments, repo_root)

    sidecar = load_sidecar(source_path, args.annotations)
    report_html = output_dir / "report.html"
    write_html_report(
        report_html, source_path, source_kind, session, transcript,
        moments, findings, sidecar, source["recording_path"],
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
    print(f"Source materials: {display_path(source_materials_md, repo_root)}")
    print(f"Problem statements: {display_path(problem_analysis_md, repo_root)}")
    print(f"Planning handoff: load inc:plan with {display_path(kickoff_md, repo_root)}")
    print("Planning should first confirm whether the captured requirements are complete and correctly grouped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
