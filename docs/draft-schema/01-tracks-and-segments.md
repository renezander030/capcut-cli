# 01 — Tracks and segments

A track is an ordered list of segments on a single timeline lane. CapCut stacks tracks vertically; the array order in JSON is the z-order (first track = bottom of stack, last = top).

```jsonc
{
  "id": "110e8d2a-...-track-uuid",
  "type": "video",
  "name": "video",            // user-visible track name
  "segments": [...],
  "attribute": 0,
  "flag": 0,
  "is_default_name": true
}
```

## Track types

| `type` | Used by | Notes |
|---|---|---|
| `video` | `add-video` for both video files AND images (image = static "video") | most segments live here |
| `audio` | `add-audio` (VO, music, SFX) | `seg.clip` must be `null` |
| `text` | `add-text`, `set-text`, `text-style`, `text-anim`, `text-ranges`, `import-srt` | each segment has exactly one text material |
| `image` | sometimes used by JianYing for static images on a separate track; CapCut puts images on video track | rare; `capcut-cli` defaults to video |
| `sticker` | `add-sticker` | references a `resource_id` from CapCut's sticker library |
| `effect` | `add-effect` | scene effects (vhs, shake, vignette, …) applied to the whole frame or to a target |
| `subtitle` | reserved for CapCut's auto-subtitle feature; `import-srt` uses `text` by default | |
| `filter` | filter chains | `capcut-cli` doesn't expose this directly yet |

Tracks created by `capcut-cli` get sensible defaults. You can rename via `--track-name <name>` on add-* commands.

## Segment shape

Every segment, regardless of track type, has roughly the same shape:

```jsonc
{
  "id": "a1b2c3d4-...-segment-uuid",
  "material_id": "b8552076-...-material-uuid",
  "target_timerange": {
    "start": 0,            // microseconds, position on the timeline
    "duration": 5000000    // microseconds, length on the timeline
  },
  "source_timerange": {
    "start": 0,            // microseconds, position inside the source material
    "duration": 5000000    // microseconds, length consumed from the source
  },
  "clip": {                // see below
    "rotation": 0,
    "alpha": 1.0,
    "scale": { "x": 1.0, "y": 1.0 },
    "transform": { "x": 0.0, "y": 0.0 },
    "flip": { "horizontal": false, "vertical": false }
  },
  "speed": 1.0,
  "volume": 1.0,
  "visible": true,
  "render_index": 0,
  "render_uniform_index": -1,
  "extra_material_refs": [ "uuid1", "uuid2", ... ],  // companion materials
  "common_keyframes": [ ... ],                       // motion / property keyframes
  "uniform_scale": { "on": true, "value": 1.0 },
  "group_id": "",
  "track_render_index": 0,
  "responsive_layout": { ... },
  "enable_adjust": true, "enable_color_curves": true, "enable_color_match_adjust": false,
  "enable_color_wheels": true, "enable_lut": true, "enable_smart_color_adjust": false,
  "is_loop": false,
  "cartoon": false,
  "intensifies_audio": false,
  "last_nonzero_volume": 1.0
}
```

### The 4 fields that matter most

- **`material_id`** — uuid pointing at exactly one entry in `materials.<category>`. To find what the segment "is" (video file? text content? sticker?), look up this id.
- **`target_timerange.start` / `.duration`** — where on the timeline this segment plays. Microseconds.
- **`source_timerange.start` / `.duration`** — what slice of the source material the segment uses. For video/audio this is the trim. For text it's typically `{ start: 0, duration: target_duration }`.
- **`extra_material_refs`** — array of uuids pointing at *companion* materials: speeds, placeholders, canvases, vocal_separations, masks, animations, transitions. See [`02-materials.md`](./02-materials.md) for the companion pattern.

### `clip` — the spatial transform

For video / image / text / sticker segments. **NOT for audio** (`clip: null` on audio is correct; setting `clip: {…}` on audio crashes CapCut).

- `transform.x` / `.y`: position offset from centre, normalized `-1 … 1`. `(0,0)` = centre. `(-1,-1)` = upper-left corner.
- `scale.x` / `.y`: scale factor. `1.0` = source size. `2.0` = 2× zoom.
- `rotation`: clockwise degrees.
- `alpha`: `0.0 … 1.0` opacity.
- `flip.horizontal` / `.vertical`: mirror booleans.

When you also have `uniform_scale.on = true`, CapCut uses `uniform_scale.value` for both axes and `scale.x` / `scale.y` are kept in sync.

### `render_index` and z-order

Within a track, segments don't overlap by default (CapCut clips them). Across tracks, the visible composite is determined by `render_index` (higher = front) and `render_uniform_index` (group-level z). `capcut-cli` sets sensible defaults; you rarely need to touch these.

### Speed and the `source_timerange` invariant

If `speed > 1.0` (faster), the source must supply more frames in less timeline time:

```
source_timerange.duration = target_timerange.duration × speed
```

`capcut-cli`'s `speed` command rebalances this for you. Hand-editing the JSON for speed is the most common way to corrupt a draft.

### Durations are quantised to the frame grid on first open

Timeranges are microseconds, but CapCut does not keep the exact microsecond values you write. The first time the app opens a draft it snaps every duration to the project's frame grid and rewrites the file. What you read back afterwards is not what you wrote.

Measured on CapCut 8.5.0 at 30 fps ([issue #69](https://github.com/renezander030/capcut-cli/issues/69)):

| written (µs) | after open (µs) | frames |
| --- | --- | --- |
| 2767000 | 2766666 | 83 |
| 3133000 | 3133334 | 94 |
| 334000 | 333333 | 10 |
| 866000 | 866667 | 26 |
| 867000 | 866667 | 26 |

Three things follow:

- **Drift is sub-frame, and the timeline stays contiguous.** In that sample the maximum change was 667 µs and no segment ended up off-grid, so a rounded draft is not a corrupted one.
- **Sub-frame distinctions are not preserved.** 866000 and 867000 both land on 26 frames. If your code depends on two segments differing by less than one frame, that difference disappears on first open.
- **Sub-frame *segments* do survive.** Three 33 ms segments each became exactly one frame (33333 / 33334 µs) and kept their positions — a segment shorter than a frame is not dropped.

This is app behaviour, not something `capcut-cli` can prevent. If you need what you write to equal what the app stores, pre-quantise to the frame grid yourself:

```
frame      = 1_000_000 / fps          // 33333.33… µs at 30 fps
quantised  = Math.round(us / frame) * frame
```

Round durations rather than truncating them — CapCut rounds to nearest, so truncating drifts a frame short over a long timeline.

## Special segments

### Audio segments

```jsonc
{
  "id": "...",
  "material_id": "...",   // → materials.audios[…]
  "target_timerange": { "start": 0, "duration": 30000000 },
  "source_timerange": { "start": 0, "duration": 30000000 },
  "clip": null,           // MUST be null
  "speed": 1.0,
  "volume": 0.9,
  "extra_material_refs": [ /* speed, vocal-separation, sound-channel-mapping ids */ ],
  "common_keyframes": [],
  "visible": true
}
```

The companion-material set for audio is different from video — see [`02-materials.md`](./02-materials.md).

### Text segments

Same shape as video segments, but `material_id` → `materials.texts[…]`. The actual text content is inside the material, not the segment. To change the text, you edit the material's `content` field (which is itself a JSON string — see [`02-materials.md`](./02-materials.md)).

The segment carries position (`clip.transform`), alpha, rotation, scale, and the standard companion refs. Text-specific styling (border, shadow, multi-style ranges) lives in the material.

### Sticker segments

`material_id` → `materials.stickers[…]`. The sticker material references a CapCut library resource by `resource_id` (a CapCut-internal sticker uuid you get from the sticker browser). Transforms work like video segments.

### Effect segments

For scene effects (`add-effect`). `material_id` → `materials.video_effects[…]`. Each effect segment can apply globally (`apply_target_type: 2`) or to specific track types (1) or specific segments (0). See [`04-effects-filters-stickers.md`](./04-effects-filters-stickers.md).

## How `capcut-cli` finds segments

Every read/write command accepts a 6+ character segment-id prefix:

```bash
capcut texts ./project
# → [ { "id": "a1b2c3d4-0000-0000-0000-000000000001", ... } ]

capcut set-text ./project a1b2c3 "New caption"
# matches the segment whose id starts with "a1b2c3"
```

Internally `capcut-cli` walks every track and every segment, returning the first match. Prefix conflicts (multiple segments matching) are rare in practice but if you hit one, use a longer prefix.

## Adding tracks lazily

`add-text`, `add-audio`, `add-video`, `add-sticker`, `add-effect` all create the underlying track on first use. The `--track-name` flag controls the name of the track they create. Subsequent `add-*` calls with the same name reuse the existing track.
