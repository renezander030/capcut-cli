# Unfinished pan — the cut-mid-motion epilogue trick

A pan that *would* finish, but the cut hits before it does. The viewer's eye is still moving when the next shot arrives — the frame feels alive instead of resolved. This recipe writes the keyframes directly into `draft_info.json` for one segment.

> Chinese translation pending — see `README.zh-CN.md` at the repo root.

## What it does

Uniform 1.2 scale (creates pan headroom — no zoom), `PositionX` interpolated linearly from `0` to `±0.13020833` over `slot / 0.607` seconds. Because the keyframe range is longer than the segment, the pan is **only ~60% complete** when the cut lands. That's the whole trick.

| Direction | PositionX end |
|---|---|
| `left`  | -0.13020833 |
| `right` | +0.13020833 |

The amplitude is `250 / 1920` — a 1080p-aware fraction. Position units in CapCut's draft schema are normalized, so this matches a 250-pixel pan on a 1920-wide frame.

## When to use

Closing / epilogue / payoff stills in the final act. A "we're still moving" feeling on a single image, right before the end card.

**Bad fits:**
- Hooks (the audience hasn't earned a slow beat yet).
- Fast-cut sequences (anything under ~2s — the motion never reads).
- Shots where the image's own action is the focus (faces, gestures, motion within the frame).

## Prerequisites

- A CapCut project with at least one video segment.
- Python 3.9+. No external deps.

## Run it

```bash
# pan left on an epilogue still at 12:34
python3 scripts/apply-pan.py \
  "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft/MyProject" \
  --at "12:34" --direction left

# pan right on the final wide
python3 scripts/apply-pan.py \
  "$HOME/Movies/CapCut/User Data/Projects/com.lveditor.draft/MyProject" \
  --material-name "epilogue-wide.jpg" --direction right
```

Three ways to identify the target segment — any one is enough:

- `--segment <id>`
- `--at "M:SS"`
- `--material-name <substring>`

Then close + reopen CapCut to load the new keyframes.

## What the script writes

For a slot of duration `D` seconds, with `PAN_PCT = 0.607`:

```jsonc
"common_keyframes": [
  { "property_type": "KFTypePositionX",
    "keyframe_list": [
      { "time_offset": 0,                              "values": [ 0.0] },
      { "time_offset": (D / 0.607) * 1_000_000,        "values": [-0.1302] }   // direction=left
    ] },
  // PositionY locked at 0, ScaleX locked at 1.2, Rotation locked at 0
]
```

The keyframe range exceeds the segment duration on purpose — that's what creates the "still moving when we cut" feel.

## Don'ts

- Don't combine with the zoom recipe on the same segment. Pick one motion.
- Don't use as the default Ken Burns. Use zoom for body shots; reserve this for the last 1–2 stills of the video.

A `.before-pan` backup of `draft_info.json` is written next to the original. Pass `--no-backup` to skip.
