"""Free video editing helpers: silence removal (Auto-Editor) and burned-in captions (faster-whisper + ffmpeg).

Usage:
  python scripts/video/edit_tools.py trim     IN.mp4 OUT.mp4 [--margin 0.15]
  python scripts/video/edit_tools.py captions IN.mp4 OUT.mp4 [--lang en|hi|auto] [--model small] [--words 3]
  python scripts/video/edit_tools.py both     IN.mp4 OUT.mp4 [options of both]

`captions` also writes OUT.srt next to the output. Devanagari is drawn with the Nirmala UI font.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def ffmpeg_bin() -> str:
    local = ROOT / "node_modules" / "ffmpeg-static" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if local.exists():
        return str(local)
    found = shutil.which("ffmpeg")
    if not found:
        sys.exit("ffmpeg not found (expected node_modules/ffmpeg-static).")
    return found


def trim_silence(src: Path, dst: Path, margin: float) -> None:
    """Cut silent parts, keeping `margin` seconds of padding around speech."""
    cmd = [sys.executable, "-m", "auto_editor", str(src), "--margin", f"{margin}sec",
           "--output", str(dst), "--no-open"]
    subprocess.run(cmd, check=True)


def _ts(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def make_srt(src: Path, srt: Path, lang: str, model: str, words_per_line: int) -> None:
    from faster_whisper import WhisperModel

    import numpy as np

    # Decode with ffmpeg ourselves: faster-whisper's own decoder breaks on newer PyAV releases.
    pcm = subprocess.run([ffmpeg_bin(), "-v", "error", "-i", str(src), "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
                         check=True, capture_output=True).stdout
    audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0

    wm = WhisperModel(model, device="cpu", compute_type="int8")
    segments, info = wm.transcribe(audio, language=None if lang == "auto" else lang,
                                   word_timestamps=True, vad_filter=True)
    words = [w for seg in segments for w in (seg.words or [])]
    print(f"Detected language: {info.language} ({info.language_probability:.0%}), {len(words)} words")
    lines, i = [], 0
    while i < len(words):
        chunk = words[i:i + words_per_line]
        text = "".join(w.word for w in chunk).strip()
        lines.append((chunk[0].start, chunk[-1].end, text))
        i += words_per_line
    with srt.open("w", encoding="utf-8") as f:
        for n, (a, b, text) in enumerate(lines, 1):
            f.write(f"{n}\n{_ts(a)} --> {_ts(b)}\n{text}\n\n")


def burn_captions(src: Path, srt: Path, dst: Path) -> None:
    """Burn the SRT into the video: bold, centred low-third, outlined (reel style)."""
    style = ("FontName=Nirmala UI,FontSize=16,Bold=1,PrimaryColour=&H00FFFFFF,"
             "OutlineColour=&H00000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=60")
    # The subtitles filter dislikes Windows drive letters, so run from the SRT's folder with a bare name.
    vf = f"subtitles={srt.name}:force_style='{style}'"
    cmd = [ffmpeg_bin(), "-y", "-i", str(src.resolve()), "-vf", vf, "-c:v", "libx264", "-preset", "medium",
           "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", str(dst.resolve())]
    subprocess.run(cmd, check=True, cwd=srt.parent)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("mode", choices=["trim", "captions", "both"])
    p.add_argument("src", type=Path)
    p.add_argument("dst", type=Path)
    p.add_argument("--margin", type=float, default=0.15, help="seconds kept around speech when trimming")
    p.add_argument("--lang", default="auto", help="en, hi, or auto")
    p.add_argument("--model", default="small", help="whisper model: tiny, base, small, medium")
    p.add_argument("--words", type=int, default=3, help="words per caption line")
    a = p.parse_args()

    a.dst.parent.mkdir(parents=True, exist_ok=True)
    src = a.src
    with tempfile.TemporaryDirectory() as tmp:
        if a.mode in ("trim", "both"):
            trimmed = a.dst if a.mode == "trim" else Path(tmp) / "trimmed.mp4"
            trim_silence(src, trimmed, a.margin)
            src = trimmed
        if a.mode in ("captions", "both"):
            srt = a.dst.with_suffix(".srt")
            make_srt(src, srt, a.lang, a.model, a.words)
            burn_captions(src, srt, a.dst)
    print(f"Done: {a.dst}")


if __name__ == "__main__":
    main()
