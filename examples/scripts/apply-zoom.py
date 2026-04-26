#!/usr/bin/env python3
"""
Apply a complete Ken Burns zoom (in or out) to one segment in a CapCut draft.

Pattern:
  - ScaleX keyframes interpolated linearly across the FULL slot duration.
  - Position X/Y locked at 0; Rotation locked at 0.
  - Zoom completes exactly at the cut (no half-finished motion).

Direction amplitudes (validated on 10-min documentary edits):
  --direction in   1.0 → 1.2   "viewer breathes" / dwell push-in on payoff stills
  --direction out  1.5 → 1.0   cinematic reveal — bigger amplitude, opens space

Use on emotional close-ups, ruins, or single-image dwell beats.
Do not combine with pan keyframes on the same segment — pick one motion.

Usage:
  apply-zoom.py <draft-path> --segment <seg-id> [--direction in|out]
  apply-zoom.py <draft-path> --at "10:16"      [--direction in|out]
  apply-zoom.py <draft-path> --material-name <substring> [--direction in|out]

  <draft-path>: the draft directory or its draft_info.json
  --no-backup:  skip the .before-zoom backup (default: backs up)
"""

from __future__ import annotations
import argparse
import json
import shutil
import sys
from pathlib import Path


def make_zoom_segment_patch(slot_s: float, direction: str = "in") -> tuple[dict, list]:
    if direction not in ("in", "out"):
        raise ValueError("direction must be 'in' or 'out'")
    s_start = 1.0 if direction == "in" else 1.5
    s_end = 1.2 if direction == "in" else 1.0
    kf_end_us = int(slot_s * 1_000_000)

    clip_patch = {
        "alpha": 1.0,
        "flip": {"horizontal": False, "vertical": False},
        "rotation": 0.0,
        "scale": {"x": s_start, "y": s_start},
        "transform": {"x": 0.0, "y": 0.0},
    }
    keyframes = [
        {
            "property_type": "KFTypePositionX",
            "keyframe_list": [
                {"time_offset": 0, "values": [0.0]},
                {"time_offset": kf_end_us, "values": [0.0]},
            ],
        },
        {
            "property_type": "KFTypePositionY",
            "keyframe_list": [
                {"time_offset": 0, "values": [0.0]},
                {"time_offset": kf_end_us, "values": [0.0]},
            ],
        },
        {
            "property_type": "KFTypeScaleX",
            "keyframe_list": [
                {"time_offset": 0, "values": [s_start]},
                {"time_offset": kf_end_us, "values": [s_end]},
            ],
        },
        {
            "property_type": "KFTypeRotation",
            "keyframe_list": [
                {"time_offset": 0, "values": [0.0]},
                {"time_offset": kf_end_us, "values": [0.0]},
            ],
        },
    ]
    return clip_patch, keyframes


def parse_timestamp(s: str) -> float:
    s = s.strip()
    if ":" in s:
        m, sec = s.split(":", 1)
        return int(m) * 60 + float(sec)
    return float(s)


def resolve_draft_path(draft_arg: str) -> Path:
    p = Path(draft_arg)
    if p.is_dir():
        c = p / "draft_info.json"
        if c.exists():
            return c
    if p.is_file():
        return p
    sys.exit(f"draft not found: {draft_arg}")


def find_segment(draft: dict, *, seg_id: str | None, at_s: float | None, mat_name: str | None) -> dict:
    mat_by_id = {m["id"]: m for m in draft.get("materials", {}).get("videos", [])}
    candidates: list[dict] = []
    for track in draft.get("tracks", []):
        if track.get("type") != "video":
            continue
        for seg in track.get("segments", []):
            if seg_id and seg.get("id") == seg_id:
                return seg
            tr = seg.get("target_timerange", {}) or {}
            start = (tr.get("start") or 0) / 1_000_000
            dur = (tr.get("duration") or 0) / 1_000_000
            mat = mat_by_id.get(seg.get("material_id"), {}) or {}
            name = mat.get("material_name", "") or ""
            if mat_name and mat_name.lower() in name.lower():
                return seg
            if at_s is not None and start <= at_s <= start + dur:
                candidates.append(seg)
    if at_s is not None and candidates:
        return candidates[0]
    sys.exit("segment not found")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("draft_path")
    p.add_argument("--segment")
    p.add_argument("--at")
    p.add_argument("--material-name")
    p.add_argument("--direction", choices=["in", "out"], default="in")
    p.add_argument("--no-backup", action="store_true")
    args = p.parse_args()

    if not (args.segment or args.at or args.material_name):
        sys.exit("provide one of --segment, --at, --material-name")

    draft_path = resolve_draft_path(args.draft_path)
    if not args.no_backup:
        backup = draft_path.with_suffix(draft_path.suffix + ".before-zoom")
        shutil.copy2(draft_path, backup)
        print(f"backup → {backup.name}")

    draft = json.loads(draft_path.read_text())
    seg = find_segment(
        draft,
        seg_id=args.segment,
        at_s=parse_timestamp(args.at) if args.at else None,
        mat_name=args.material_name,
    )
    slot_s = seg["target_timerange"]["duration"] / 1_000_000
    seg_id = seg["id"]
    mat_id = seg.get("material_id")
    mat = next((m for m in draft.get("materials", {}).get("videos", []) if m["id"] == mat_id), {})
    name = mat.get("material_name", "")
    start_s = seg["target_timerange"]["start"] / 1_000_000

    print(f"target: seg={seg_id}")
    print(f"  start={start_s:.3f}s ({int(start_s//60)}:{start_s%60:06.3f})  duration={slot_s:.3f}s")
    print(f"  material={name}")

    clip_patch, keyframes = make_zoom_segment_patch(slot_s, direction=args.direction)
    seg.setdefault("clip", {}).update(clip_patch)
    seg["common_keyframes"] = keyframes

    s_start = clip_patch["scale"]["x"]
    s_end = 1.2 if args.direction == "in" else 1.0
    print(f"  zoom {args.direction}: scale {s_start:.3f} → {s_end:.3f} over {slot_s:.3f}s (linear)")

    draft_path.write_text(json.dumps(draft, indent=2, ensure_ascii=False))
    print(f"\nwrote {draft_path}")
    print("close + reopen CapCut to see the zoom.")


if __name__ == "__main__":
    main()
