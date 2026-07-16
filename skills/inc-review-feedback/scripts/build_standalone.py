#!/usr/bin/env python3
"""
Build the shareable single-file feedback report.

Takes an analysis directory (or a report.html path) produced by
analyze_riffrec_zip.py and writes report-standalone.html next to it, with all
local media and images embedded so the file plays anywhere: mail, Slack, a
different machine, no sibling files needed.

Run this AFTER the synthesis block in report.html has been filled; the
standalone is a snapshot and goes stale whenever report.html changes, so
re-run it after any edit.

Media is embedded as base64 decoded into Blob URLs at load time rather than
data: URIs, because browsers seek unreliably inside multi-megabyte data: URIs.
"""

from __future__ import annotations

import argparse
import base64
import re
import sys
from pathlib import Path

MEDIA_MIME = {
    ".webm": "webm",
    ".mp4": "mp4",
    ".m4a": "mp4",
    ".mov": "quicktime",
    ".mp3": "mpeg",
    ".wav": "wav",
    ".ogg": "ogg",
}

IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("report", type=Path, help="Analysis output dir, or the report.html inside it")
    parser.add_argument("--out", type=Path, help="Output path (default: report-standalone.html next to the report)")
    return parser.parse_args()


def inline_images(html: str, base_dir: Path) -> str:
    """Inline local <img> sources as data: URIs (small stills seek fine this way)."""

    def repl(match: re.Match[str]) -> str:
        rel = match.group(1)
        path = base_dir / rel
        mime = IMAGE_MIME.get(path.suffix.lower())
        if not mime or not path.exists():
            return match.group(0)
        encoded = base64.b64encode(path.read_bytes()).decode()
        return f'src="data:{mime};base64,{encoded}"'

    return re.sub(r'src="((?!https?:|data:|/)[^"]+\.(?:png|jpe?g|gif|webp))"', repl, html)


def embed_media(html: str, base_dir: Path) -> tuple[str, list[tuple[str, str, str]], list[str]]:
    """Swap local <video>/<audio> srcs for data-embedded markers and collect payloads.

    Returns the rewritten html, a list of (marker, mime, base64) payloads, and the
    relative paths that were embedded.
    """
    payloads: list[tuple[str, str, str]] = []
    embedded: list[str] = []

    def repl(match: re.Match[str]) -> str:
        tag, attrs, rel = match.group(1), match.group(2), match.group(3)
        path = base_dir / rel
        subtype = MEDIA_MIME.get(path.suffix.lower())
        if not subtype or not path.exists():
            return match.group(0)
        marker = f"m{len(payloads)}"
        mime = f"{tag}/{subtype}"
        payloads.append((marker, mime, base64.b64encode(path.read_bytes()).decode()))
        embedded.append(rel)
        return f'<{tag}{attrs} data-embedded="{marker}"'

    html = re.sub(r'<(video|audio)\b([^>]*?)\ssrc="((?!https?:|data:|/)[^"]+)"', repl, html)
    return html, payloads, embedded


def build_loader(payloads: list[tuple[str, str, str]]) -> str:
    entries = ",\n".join(
        f'    {{ marker: "{marker}", mime: "{mime}", b64: "{b64}" }}' for marker, mime, b64 in payloads
    )
    return f"""
<script>
(function () {{
  var MEDIA = [
{entries}
  ];
  MEDIA.forEach(function (m) {{
    var el = document.querySelector('[data-embedded="' + m.marker + '"]');
    if (!el) return;
    var bin = atob(m.b64), buf = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    el.src = URL.createObjectURL(new Blob([buf], {{ type: m.mime }}));
  }});
}})();
</script>
"""


def main() -> int:
    args = parse_args()
    report = args.report.expanduser().resolve()
    if report.is_dir():
        report = report / "report.html"
    if not report.exists():
        print(f"Report not found: {report}", file=sys.stderr)
        return 1

    base_dir = report.parent
    html = report.read_text()
    html = inline_images(html, base_dir)
    html, payloads, embedded = embed_media(html, base_dir)
    if payloads:
        html = html.replace("</body>", build_loader(payloads) + "</body>")

    out = (args.out or base_dir / "report-standalone.html").expanduser().resolve()
    out.write_text(html)
    size_mb = out.stat().st_size / 1024 / 1024
    print(f"Embedded media: {', '.join(embedded) or '(none found)'}")
    print(f"STANDALONE_HTML={out}")
    print(f"Size: {size_mb:.1f} MB. Share this single file; it plays anywhere.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
