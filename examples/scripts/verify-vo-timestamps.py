#!/usr/bin/env python3
"""
Hard gate that fails loudly if voiceover audio + ElevenLabs alignment files are
missing, malformed, or out of sync.

Why this exists:
    When you drive cut points from word-level timestamps, every shot boundary
    depends on the alignment data being trustworthy. One missing per-act file or
    one non-monotonic stitch point silently corrupts the entire edit, and you
    only notice when a clip lands on the wrong word three minutes in.

    Run this BEFORE building the CapCut draft. If it fails, fix the VO step
    rather than guessing offsets in the draft.

Layout enforced:
    <vo-dir>/
        <slug>-act{N}.mp3                MP3 per act, non-zero size
        <slug>-act{N}-words.json         ElevenLabs raw alignment per act
                                          (response from /v1/text-to-speech/{voice_id}/with-timestamps)
        <slug>-vo.mp3                    Stitched master VO
        words.json                       Master word-level array with cumulative offsets
                                          (per-act starts shifted forward by all prior act durations)

    Each entry in words.json: {"word": "...", "startMs": int, "endMs": int}.

Usage:
    verify-vo-timestamps.py <slug> --vo-dir <path> [--acts N]

Defaults: --acts 5

Exits 0 only if every required file exists, parses, and is non-empty.
On any failure prints a precise diagnostic to stderr and exits 1.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def check_mp3(path: Path) -> None:
    if not path.exists():
        fail(f"missing audio file: {path}")
    if path.stat().st_size < 1024:
        fail(f"audio file too small (<1 KB), likely truncated: {path}")


def check_act_alignment(path: Path) -> None:
    if not path.exists():
        fail(
            f"missing per-act alignment JSON: {path}\n"
            f"       hint: did you call /v1/text-to-speech/{{voice_id}}/with-timestamps "
            f"instead of the plain /v1/text-to-speech endpoint?"
        )
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        fail(f"alignment JSON does not parse: {path} ({e})")

    chars = data.get("characters")
    starts = data.get("character_start_times_seconds")
    ends = data.get("character_end_times_seconds")
    if not chars or not starts or not ends:
        fail(
            f"alignment JSON missing required keys "
            f"(characters / character_start_times_seconds / character_end_times_seconds): "
            f"{path}"
        )
    if not (len(chars) == len(starts) == len(ends)):
        fail(
            f"alignment array lengths disagree: {path} "
            f"(chars={len(chars)}, starts={len(starts)}, ends={len(ends)})"
        )
    if len(chars) < 50:
        fail(f"alignment suspiciously short ({len(chars)} chars): {path}")


def check_master_words(path: Path) -> None:
    if not path.exists():
        fail(
            f"missing master words.json: {path}\n"
            f"       this is the stitched word-level array with cumulative offsets "
            f"across all acts. drives every shot boundary."
        )
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        fail(f"master words.json does not parse: {path} ({e})")

    if not isinstance(data, list):
        fail(f"master words.json must be a JSON array, got {type(data).__name__}: {path}")
    if len(data) < 100:
        fail(f"master words.json suspiciously short ({len(data)} words): {path}")

    required = {"word", "startMs", "endMs"}
    last_start = -1
    for i, w in enumerate(data):
        missing = required - set(w.keys())
        if missing:
            fail(f"master words.json entry {i} missing keys {missing}: {path}")
        if w["startMs"] < last_start:
            fail(
                f"master words.json not monotonic at index {i}: "
                f"{w['word']!r} startMs={w['startMs']} < previous {last_start}\n"
                f"       hint: per-act offsets were not added when stitching"
            )
        last_start = w["startMs"]

    total_ms = data[-1]["endMs"]
    if total_ms < 60_000:
        fail(
            f"master words.json total duration {total_ms} ms is < 60s. "
            f"cumulative offsets likely missing."
        )


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("slug", help="project slug used as filename prefix, e.g. my-video")
    p.add_argument("--vo-dir", type=Path, required=True, help="directory containing the VO files")
    p.add_argument("--acts", type=int, default=5, help="expected number of acts (default 5)")
    args = p.parse_args()

    vo_dir = args.vo_dir
    if not vo_dir.is_dir():
        fail(f"voiceover dir not found: {vo_dir}")

    print(f"Verifying VO timestamps for '{args.slug}' ({args.acts} acts) in {vo_dir}")

    for n in range(1, args.acts + 1):
        mp3 = vo_dir / f"{args.slug}-act{n}.mp3"
        words = vo_dir / f"{args.slug}-act{n}-words.json"
        check_mp3(mp3)
        check_act_alignment(words)
        print(f"  act{n}: OK ({mp3.name}, {words.name})")

    check_mp3(vo_dir / f"{args.slug}-vo.mp3")
    print(f"  master mp3: OK ({args.slug}-vo.mp3)")

    check_master_words(vo_dir / "words.json")
    print(f"  master words.json: OK")

    print(f"PASS: all {args.acts} acts have audio + alignment, master VO + words.json present and well-formed.")


if __name__ == "__main__":
    main()
