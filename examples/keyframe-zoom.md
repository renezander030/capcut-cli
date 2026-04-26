# Ken Burns zoom — programmatic keyframes on one segment

CapCut's GUI lets you drag a zoom keyframe onto a clip, but doing it for 60+ shots in a 12-minute video is a wrist injury. This recipe writes the keyframes directly into `draft_info.json` for one segment at a time, and you call it from a loop or a script.

> Chinese translation pending — see `README.zh-CN.md` at the repo root.

## What it does

A complete zoom (the motion finishes by the cut), `ScaleX` interpolated linearly across the segment's full duration, position and rotation locked.

Two directions:

| Direction | Scale | Use it for |
|---|---|---|
| `in`  | 1.0 → 1.2 | dwell shots — emotional close-ups, ruins, single-image payoff beats |
| `out` | 1.5 → 1.0 | cinematic reveals — opens the frame at the start of an act |

The zoom-out has bigger amplitude on purpose. A reveal needs more space to travel than a push-in.

## Prerequisites

- A CapCut project that already has at least one video segment (image or footage).
- Python 3.9+. No external deps.

## Run it

```bash
# zoom in on a payoff still at 9:49
python3 scripts/apply-zoom.py \
  "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft/MyProject" \
  --at "9:49" --direction in

# zoom out on the act-opening wide
python3 scripts/apply-zoom.py \
  "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft/MyProject" \
  --material-name "act01-opening-wide.jpg" --direction out
```

Three ways to identify the target segment — any one is enough:

- `--segment <id>` — exact segment id from `capcut info` or `draft_info.json`
- `--at "M:SS"` — any timestamp inside the slot (the script picks the segment that contains it)
- `--material-name <substring>` — case-insensitive match on the material's filename

Then close + reopen CapCut to load the new keyframes.

## What the script writes

For a slot of duration `D` seconds, it sets:

```jsonc
"common_keyframes": [
  { "property_type": "KFTypeScaleX",
    "keyframe_list": [
      { "time_offset": 0,           "values": [1.0] },
      { "time_offset": D * 1_000_000, "values": [1.2] }
    ] },
  // KFTypePositionX / Y / Rotation locked at 0 over the same range
]
```

`time_offset` is in microseconds. The `1_000_000` is what bites if you write this by hand — milliseconds break silently because the keyframe just sits at frame 0.

## Don'ts

- Don't combine with the unfinished-pan recipe on the same segment. Pick one motion.
- Don't apply zoom-in to fast-cut hooks (under ~2s). The motion is invisible at that length.
- Don't use zoom-out as a default — it's a reveal. Most shots want zoom-in or no motion.

A `.before-zoom` backup of `draft_info.json` is written next to the original. Pass `--no-backup` to skip.
