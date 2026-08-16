# 02 — Materials

Materials are the pool of assets and elements that segments reference. The `draft.materials` object is a flat dictionary of categorized arrays:

```jsonc
"materials": {
  "videos":             [...],   // both video files and images
  "audios":             [...],
  "texts":              [...],   // one per text segment
  "stickers":           [...],
  "video_effects":      [...],   // scene effects, filters
  "material_animations":[...],   // video/image intro/outro/combo animations
  "transitions":        [...],
  "masks":              [...],
  "canvases":           [...],   // background blur / colour
  "speeds":             [...],   // playback speed envelopes
  "placeholder_infos":  [...],   // missing-asset placeholders
  "vocal_separations":  [...],   // VO / music split metadata
  "sound_channel_mappings": [...],
  "smart_crops":        [...],
  "manual_deformations":[...]
}
```

Each entry has at minimum an `id` (uuid) and a `type` discriminator. Segments link via `material_id` (primary) and `extra_material_refs` (companions). To find what a segment "is", look up `segment.material_id` in the appropriate category.

## `materials.videos[…]` — video files AND images

CapCut stores still images in the same array as video clips. The discriminator is the `type` field on the material:

```jsonc
{
  "id": "video-mat-uuid",
  "type": "video",                    // or "photo" for stills
  "material_name": "clip.mp4",
  "path": "/abs/path/to/clip.mp4",    // or "assets/video/clip.mp4" relative to draft
  "duration": 60000000,               // microseconds — source duration; 10800000000 (3h) for stills
  "width": 1080, "height": 1920,
  "video_algorithm": { /* default */ },
  "crop": { "lower_left_x": 0, "lower_left_y": 1, "upper_left_x": 0, "upper_left_y": 0,
            "lower_right_x": 1, "lower_right_y": 1, "upper_right_x": 1, "upper_right_y": 0 },
  "stable": { "matrix_path": "", "stable_level": 0 },
  "audio_fade": null,
  "matting": { "flag": 0, "has_use_quick_brush": false, "interactiveTime": [],
               "path": "", "strokes": [] }
}
```

For images: `type: "photo"`, `duration: 10800000000` (3 hours, conventionally), and `width/height` reflect the image dimensions.

Files added via `add-video` / `add-audio` are copied into `<draft>/assets/<kind>/` and the material's `path` is set to a relative or absolute path that CapCut can resolve.

## `materials.audios[…]`

```jsonc
{
  "id": "audio-mat-uuid",
  "type": "extract_music",      // or "music" / "record" / "sound_effect"
  "name": "voiceover.wav",
  "music_id": "",                // CapCut library id; "" for user-imported
  "path": "/abs/path/to/voiceover.wav",
  "duration": 30000000,
  "wave_points": [],             // CapCut populates the waveform on first preview
  "category_id": "", "category_name": "local",
  "source_platform": 0,
  "tone_category_id": "", "tone_category_name": "",
  "tone_effect_id": "", "tone_effect_name": ""
}
```

## `materials.texts[…]` — the JSON-in-JSON content field

This is the trickiest material. The actual text and styling are inside a JSON-encoded string called `content`:

```jsonc
{
  "id": "text-mat-uuid",
  "type": "text",
  "content": "{\"text\":\"Hello\",\"styles\":[{\"fill\":{\"content\":{\"solid\":{\"color\":[1,0.84,0]}}},\"font\":{...},\"range\":[0,10]}],\"layer_weight\":1,\"effect\":[]}",
  "font_name": "",
  "font_size": 8.0,
  "text_color": "#FFFFFFFF",
  "text_alpha": 1.0,
  "border_color": "#000000FF",
  "border_width": 0.0,
  "border_alpha": 1.0,
  "background_color": "#00000000",
  "background_alpha": 0.0,
  "background_style": 0,
  "background_round_radius": 0.0,
  "background_width": 0.14,
  "background_height": 0.14,
  "background_horizontal_offset": 0.0,
  "background_vertical_offset": 0.0,
  "has_shadow": false,
  "shadow_alpha": 0.8,
  "shadow_angle": -45.0,
  "shadow_color": "#000000FF",
  "shadow_distance": 8.0,
  "shadow_smoothing": 1.0,
  "text_alignment": 1,    // 0=left, 1=centre, 2=right
  "vertical": false,
  "fixed_width": -1.0, "fixed_height": -1.0,
  "letter_spacing": 0.0, "line_feed": 1, "line_spacing": 0.02,
  "is_rich_text": false,
  "use_effect_default_color": false
}
```

The top-level fields (`text_color`, `border_width`, `has_shadow`, …) are the "baseline" style and used as defaults. The **per-range styling** lives inside the `content` JSON.

### Decoding the `content` field

```jsonc
// content (parsed)
{
  "text": "Hello world",            // the actual rendered characters
  "styles": [
    {
      "range": [0, 11],             // UTF-16 code-unit offsets (JS string indices)
      "fill": { "content": { "solid": { "color": [1.0, 0.84, 0.0] } } },  // [r,g,b] 0..1
      "font": { "id": "...", "path": "..." },
      "size": 18,
      "bold": true,
      "italic": false,
      "underline": false
    }
  ],
  "layer_weight": 1,
  "effect": []
}
```

**The `range` array is in UTF-16 code units** — the same indices `"abc".slice(start, end)` takes in JavaScript, or `text[start:end]` in Python 3. One BMP character (Latin, Chinese, Thai) is one unit; one emoji or other astral character is two, because UTF-16 encodes it as a surrogate pair.

This is worth stating plainly because this repo got it wrong. Until v0.19.1 `capcut-cli` wrote these offsets as UTF-16LE **bytes** — every value doubled ([#85](https://github.com/renezander030/capcut-cli/issues/85)). A single full-span range survived the mistake, since `[0, 2n]` clamps back to the end of the text when CapCut opens the draft, which is exactly why it went unnoticed; a multi-range highlight did not. A scan of 38 app-authored drafts from CapCut International 7.9.0 and 8.9.1 settled it: 211 text materials in code units, none in bytes. `capcut lint --fix` repairs drafts written by the older versions (`text-range-doubled`).

`capcut-cli` exposes:

- `set-text <id> <new-text>` — replaces `content.text` AND updates `content.styles[0].range` to cover the new length.
- `text-style <id> [flags]` — modifies the top-level baseline style fields.
- `text-ranges <id> --styles @ranges.json` — emits multiple per-range styles plus baseline fillers for gaps.

## `materials.video_effects[…]` — scene effects + filters

```jsonc
{
  "id": "effect-mat-uuid",
  "type": "video_effect",
  "name": "VHS",
  "effect_id": "10001",          // CapCut-internal effect id from enums.json
  "category_id": "", "category_name": "",
  "resource_id": "",
  "source_platform": 1,
  "value": 1.0,                  // master intensity, 0..1
  "adjust_params": [             // per-knob parameters, 0..1
    { "name": "intensity", "default_value": 0.7, "value": 0.7 }
  ],
  "apply_target_type": 2,        // 0=segment, 1=track-type, 2=global
  "apply_target_track_type": 0
}
```

See [`04-effects-filters-stickers.md`](./04-effects-filters-stickers.md) for `apply_target_type` semantics.

## `materials.material_animations[…]` — video/image animation containers

A single material_animations entry can hold up to 3 animations (intro / outro / combo) for ONE video/image segment:

```jsonc
{
  "id": "anim-mat-uuid",
  "type": "sticker_animation",    // misleading name — also used for video/image animations
  "animations": [
    {
      "name": "Fade in", "id": "...",
      "category_id": "", "category_name": "ruchang",   // ruchang=intro, chuchang=outro, zuhe=combo
      "type": "in",                                    // "in" / "out" / "group"
      "resource_id": "...", "material_type": "video",
      "duration": 500000, "start": 0,
      "platform": "cc"
    }
  ]
}
```

The segment references this via its `extra_material_refs`. See [`03-keyframes-and-animations.md`](./03-keyframes-and-animations.md).

## `materials.transitions[…]`

```jsonc
{
  "id": "trans-mat-uuid",
  "type": "transition",
  "name": "Dissolve",
  "effect_id": "10000",
  "resource_id": "...",
  "duration": 600000,        // microseconds
  "is_overlap": false,       // true = transitions overlap the previous segment
  "category_id": "", "category_name": "",
  "platform": "cc"
}
```

A transition material is referenced by the *first* of the two segments it joins (`segment.extra_material_refs` contains the transition uuid).

## `materials.masks[…]`

```jsonc
{
  "id": "mask-mat-uuid",
  "type": "mask",
  "resource_type": "linear",   // or circle/rectangle/heart/star/mirror
  "config": {
    "rotation": 0,
    "centerX": 0, "centerY": 0,
    "feather": 0,
    "height": 0.5,
    "width": 0.5,              // ignored except for rectangle
    "invert": false,
    "roundCorner": 0           // rectangle only
  },
  "name": "Linear",
  "platform": "cc"
}
```

A segment can have at most one mask. `capcut-cli mask <id> --off` removes any existing mask refs.

Mask geometry here is **static**. The desktop app can keyframe it, but the on-disk encoding has never been captured publicly — see [03 — keyframes](./03-keyframes-and-animations.md#mask-geometry-keyframes--encoding-unknown-44) for the two candidate shapes and the `capcut fixture` harvest path (#44).

## `materials.canvases[…]` — background fill

```jsonc
{
  "id": "canvas-mat-uuid",
  "type": "canvas_blur",       // or "canvas_color" / "canvas_image"
  "blur": 0.375,               // 0.0625 (level 1) / 0.375 (2) / 0.75 (3) / 1.0 (4)
  "color": "", "image": "", "image_id": ""
}
```

`bg-blur` writes canvas_blur entries; `bg-blur --off` removes the canvas ref from the segment.

## Companion materials — the `extra_material_refs` pattern

Most segments reference 4–7 "companion" materials in addition to their primary `material_id`. These provide auxiliary state that CapCut expects to find in dedicated material entries rather than inline on the segment:

| Companion type | Lives in | Used by |
|---|---|---|
| `speed` | `materials.speeds` | video, audio, image segments |
| `placeholder_info` | `materials.placeholder_infos` | all segments — for "asset missing" fallback |
| `sound_channel_mapping` | `materials.sound_channel_mappings` | audio segments |
| `vocal_separation` | `materials.vocal_separations` | audio segments |
| `canvas` | `materials.canvases` | video, image segments |
| `material_color` | `materials.material_colors` | video, image segments |

`capcut-cli`'s `factory.ts` has a `createCompanionMaterials(type)` helper that returns the right companion set per segment type. You only need to think about this if you're hand-writing materials.

## Materials you can usually ignore

`smart_crops`, `manual_deformations`, `placeholder_infos` (unless asset missing), `sound_channel_mappings`. CapCut creates these on its own.
