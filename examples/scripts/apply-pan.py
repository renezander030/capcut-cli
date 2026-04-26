#!/usr/bin/env python3
"""
Apply the "unfinished pan" pattern to one segment in a CapCut draft.

Pattern:
  - Uniform scale 1.2 (creates pan headroom, no zoom motion).
  - 2 linear keyframes on PositionX: 0 → ±0.13020833... over (slot / 0.607)s.
  - PositionY / ScaleX / Rotation locked at start and end.
  - Cut lands at ~60.7% of motion → the shot feels alive, not resolved.

The 60.7% number is the trick — a pan that *would* finish, but the cut hits
before it does. The viewer's eye is still moving when the next shot arrives.

Use on closing / epilogue / payoff stills (final-act emotional beats).
Do not use as the default Ken Burns. Bad fits: hooks, fast-cut sequences (<2s),
shots whose own internal action is the focus.

Usage:
  apply-pan.py <draft-path> --segment <seg-id> [--direction left|right]
  apply-pan.py <draft-path> --at "10:18"      [--direction left|right]
  apply-pan.py <draft-path> --material-name <substring> [--direction left|right]

  <draft-path>: the draft directory or its draft_info.json
  --direction:  left (default) | right
  --no-backup:  skip the .before-pan backup (default: backs up)

Examples:
  apply-pan.py "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft/MyProject" \\
      --material-name "epilogue-wide.jpg"

  apply-pan.py "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft/MyProject" \\
      --at "12:34.500" --direction right
"""

from __future__ import annotations
import argparse
import json
import shutil
import sys
from pathlib import Path

PAN_PCT = 0.607
PAN_AMPLITUDE = 0.13020833333333334  # = 250 / 1920


def make_pan_segment_patch(slot_s: float, direction: str = "left") -> tuple[dict, list]:
    if direction not in ("left", "right"):
        raise ValueError(f"direction must be 'left' or 'right', got {direction!r}")
    sign = -1 if direction == "left" else 1
    pan_x_end = sign * PAN_AMPLITUDE
    kf_end_us = int((slot_s / PAN_PCT) * 1_000_000)

    clip_patch = {
        "alpha": 1.0,
        "flip": {"horizontal": False, "vertical": False},
        "rotation": 0.0,
        "scale": {"x": 1.2, "y": 1.2},
        "transform": {"x": pan_x_end, "y": 0.0},
    }
    keyframes = [
        {
            "property_type": "KFTypePositionX",
            "keyframe_list": [
                {"time_offset": 0, "values": [0.0]},
                {"time_offset": kf_end_us, "values": [pan_x_end]},
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
                {"time_offset": 0, "values": [1.2]},
                {"time_offset": kf_end_us, "values": [1.2]},
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
    """Accept '10:18', '10:18.900', '618.9', '618'."""
    s = s.strip()
    if ":" in s:
        m, sec = s.split(":", 1)
        return int(m) * 60 + float(sec)
    return float(s)


def resolve_draft_path(draft_arg: str) -> Path:
    p = Path(draft_arg)
    if p.is_dir():
        candidate = p / "draft_info.json"
        if candidate.exists():
            return candidate
    if p.is_file():
        return p
    sys.exit(f"draft not found: {draft_arg}")


def find_segment(draft: dict, *, seg_id: str | None, at_s: float | None, mat_name: str | None) -> dict:
    mat_by_id = {m["id"]: m for m in draft.get("materials", {}).get("videos", [])}
    candidates: list[tuple[float, dict, dict]] = []
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
                candidates.append((start, seg, mat))
    if at_s is not None and candidates:
        for start, seg, mat in candidates:
            return seg
    sys.exit("segment not found — check --segment / --at / --material-name")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("draft_path", help="path to draft directory or draft_info.json")
    p.add_argument("--segment", help="exact segment id")
    p.add_argument("--at", help="timestamp inside the slot (e.g. 10:18 or 618.9)")
    p.add_argument("--material-name", help="substring to match against material_name")
    p.add_argument("--direction", choices=["left", "right"], default="left")
    p.add_argument("--no-backup", action="store_true", help="skip backup")
    args = p.parse_args()

    if not (args.segment or args.at or args.material_name):
        sys.exit("provide one of --segment, --at, --material-name")

    draft_path = resolve_draft_path(args.draft_path)
    if not args.no_backup:
        backup = draft_path.with_suffix(draft_path.suffix + ".before-pan")
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

    clip_patch, keyframes = make_pan_segment_patch(slot_s, direction=args.direction)
    seg.setdefault("clip", {}).update(clip_patch)
    seg["common_keyframes"] = keyframes

    pan_x = clip_patch["transform"]["x"]
    kf_end_s = slot_s / PAN_PCT
    print(f"  scale → 1.2 uniform")
    print(f"  pan x: 0 → {pan_x:+.4f} over {kf_end_s:.3f}s ({args.direction})")
    print(f"  cut at {(slot_s / kf_end_s) * 100:.1f}% of motion")

    draft_path.write_text(json.dumps(draft, indent=2, ensure_ascii=False))
    print(f"\nwrote {draft_path}")
    print("close + reopen CapCut to see the pan.")


if __name__ == "__main__":
    main()
