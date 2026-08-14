# 03 — Keyframes and animations

Two distinct systems power motion in a CapCut draft. They look similar but live in different fields and respond to different `capcut-cli` commands.

| System | What it does | Lives at | CLI command |
|---|---|---|---|
| **`common_keyframes`** | per-property motion: position, scale, rotation, alpha, colour adjustments | `segment.common_keyframes[]` | `keyframe`, `ken-burns.sh` |
| **`sticker_animation`** | pre-built intro / outro / combo effects from CapCut's animation library | one entry in `materials.material_animations[]`, referenced via `extra_material_refs` | `text-anim`, `image-anim` |

## `common_keyframes` — direct property keyframing

For per-frame interpolation of a single property (position, scale, alpha, etc.):

```jsonc
"segment": {
  "id": "...",
  "common_keyframes": [
    {
      "id": "...",
      "property_type": "KFTypePositionX",
      "keyframe_list": [
        { "id": "...", "time_offset": 0,        "values": [0.0],  "curveType": "Line" },
        { "id": "...", "time_offset": 1000000,  "values": [0.5],  "curveType": "Line" },
        { "id": "...", "time_offset": 2000000,  "values": [-0.3], "curveType": "Line" }
      ]
    },
    { "property_type": "UNIFORM_SCALE", "keyframe_list": [ ... ] }
  ]
}
```

One entry per property. Within an entry, `keyframe_list` is sorted by `time_offset` (microseconds from segment start, NOT from timeline start).

### Properties `capcut-cli keyframe` supports

| CLI property | `property_type` | Value range | Notes |
|---|---|---|---|
| `position_x` | `KFTypePositionX` | -1 .. 1 normalized | 0 = horizontal centre |
| `position_y` | `KFTypePositionY` | -1 .. 1 normalized | 0 = vertical centre |
| `rotation` | `KFTypeRotation` | degrees clockwise | accepts `"45deg"` syntax |
| `scale_x` | `KFTypeScaleX` | 0 .. ∞ | 1 = source size |
| `scale_y` | `KFTypeScaleY` | 0 .. ∞ | |
| `uniform_scale` | `UNIFORM_SCALE` | 0 .. ∞ | locks scale_x = scale_y; the one property with no `KFType` prefix — see below |
| `alpha` | `KFTypeAlpha` | 0 .. 1 | accepts `"50%"` syntax |
| `saturation` | `KFTypeSaturation` | -1 .. 1 | accepts `"+0.5"` syntax |
| `contrast` | `KFTypeContrast` | -1 .. 1 | |
| `brightness` | `KFTypeBrightness` | -1 .. 1 | |
| `volume` | `KFTypeVolume` | 0 .. 1 | audio segments only |

> **`uniform_scale` breaks the naming pattern.** Every other property writes a
> `KFType…` identifier; this one writes the bare `UNIFORM_SCALE`. That asymmetry
> is CapCut's, not ours — `src/decorators.ts`'s `PROPERTY_MAP` is the authority,
> and a keyframe written as `KFTypeUniformScale` is silently ignored by the app.
> These docs previously showed the `KFType` form, so a hand-built keyframe
> copied from them did nothing ([#80](https://github.com/renezander030/capcut-cli/issues/80)).
> A test now fails if this table and `PROPERTY_MAP` disagree again, so the two
> cannot drift apart silently a second time.

The `keyframe` CLI command appends to existing per-property lists on re-invocation and sorts by `time_offset`, so you can build up complex motion incrementally.

### `curveType`

Per-keyframe interpolation curve to the NEXT keyframe in the list:

- `"Line"` — linear (default)
- `"Hold"` — step (no interpolation)
- `"Smooth"` — ease in/out
- `"Beizer"` — custom bezier (additional `value_bezier_control_points` field)
- `"FreeCurveInOut"` — bezier via `left_control` / `right_control` handles; this is what the CapCut UI writes when an easing preset (Cubic In / Cubic Out / …) is applied

`capcut-cli keyframe` writes `"Line"` by default. With `--easing ease-in|ease-out|ease-in-out` it writes the `"FreeCurveInOut"` encoding: handle `x` is a fixed ratio of the interval to the adjacent keyframe (ease-in `+0.42`, ease-out `+0.32`/`-0.4`, ease-in-out `±0.42`, in microseconds), handle `y` is `0` except ease-out's outgoing handle, which is `round(0.94 × Δvalue, 6)`. Validated against a CapCut UI oracle capture (Davidb-2107/capcut-cli-david).

### ⚠️ The alpha-keyframes-don't-render trap

You **cannot fade video/image segments via alpha keyframes**. CapCut silently ignores `KFTypeAlpha` keyframes on video and text segments at render time, even though they're shown in the editor preview.

The correct way to fade in/out is the **animation system** (`text-anim` / `image-anim` with `--intro fade-in` / `--outro fade-out` slugs), which writes a `sticker_animation` entry instead. See below.

Motion keyframes (`position`, `scale`, `rotation`) DO render — Ken Burns zooms and slides work as expected via `common_keyframes`. The trap is alpha-only.

## `sticker_animation` — preset intro / outro / combo animations

For drop-in animations from CapCut's library (fade-in, typewriter, pop-up, zoom-out, etc.), use the animation system. These live in `materials.material_animations[]` with `type: "sticker_animation"`, despite the name applying to text and video segments too:

```jsonc
"materials": {
  "material_animations": [
    {
      "id": "anim-uuid",
      "type": "sticker_animation",
      "animations": [
        {
          "id": "...",
          "name": "Fade in",
          "category_id": "", "category_name": "ruchang",   // intro
          "type": "in",
          "resource_id": "...",
          "effect_id": "...",
          "material_type": "video",                        // or "text" / "sticker"
          "platform": "cc",
          "duration": 500000,                              // microseconds
          "start": 0,                                      // 0 for intros; auto-anchored for outros
          "request_id": ""
        }
        // up to 3 entries per material: one intro, one outro, one combo
      ]
    }
  ]
}
```

The segment references this material via `extra_material_refs`:

```jsonc
"segment": {
  "id": "...",
  "extra_material_refs": [ "...speed...", "...placeholder...", "anim-uuid", ... ]
}
```

### Three animation slots per segment

CapCut allows ONE animation of each type (`in`, `out`, `group`) per segment, all packed into a single `material_animations` entry:

- **Intro** (`type: "in"`, `category_name: "ruchang"`): plays from segment start. `start: 0`.
- **Outro** (`type: "out"`, `category_name: "chuchang"`): plays at segment end. `capcut-cli` auto-anchors `start = target_duration - duration`.
- **Combo** (`type: "group"`, `category_name: "zuhe"`): plays through the entire segment (loop animations like pulse).

`capcut-cli text-anim` / `image-anim` guard against double-applying the same type — re-running with the same `--intro` slug overwrites; specifying neither leaves existing animations untouched.

### Material-type field

The same animation system serves three segment types:

- `material_type: "video"` for video / image segments (driven by `image-anim`)
- `material_type: "text"` for text segments (driven by `text-anim`)
- `material_type: "sticker"` for sticker segments (driven by `image-anim` since the shape is identical)

### Slugs ↔ resource ids

Slugs are `capcut-cli`'s human-readable handles for CapCut's library resources. The slug → resource_id / effect_id mapping lives in `src/enums.json` (extracted at build time from `pyJianYingDraft`). See [`04-effects-filters-stickers.md`](./04-effects-filters-stickers.md) for the namespace pattern (CapCut vs JianYing slugs differ).

Starter catalogue shipping in v0.3.0:

- **Intros**: `fade-in`, `flash-in`, `pulsing-zooms`, `scroll-up`, `stripe-merge`, `zoom-out`
- **Outros**: `fade-out`, `blur-out`, `smoke`
- **Text intros**: `fade-in`, `typewriter`, `pop-up`, `blur-text-in`, `zoom-in-text`
- **Text outros**: `fade-out`, `throw-out`

Run `capcut enums --image-intros -H` (or `--text-outros`, etc.) for the full live catalogue including JianYing-namespace entries.

## When to use which

- **Ken Burns** (slow zoom + drift on a still): keyframes on `uniform_scale` + `position_x` + `position_y`. Use `scripts/ken-burns.sh` from the skill.
- **Fade in at clip start**: animation system, `image-anim --intro fade-in` (NOT alpha keyframe).
- **Fade out at clip end**: animation system, `image-anim --outro fade-out`.
- **Text reveals letter by letter**: animation system, `text-anim --intro typewriter`.
- **Subtle volume duck under a VO**: keyframes on `volume`.
- **Word-level caption highlight**: NOT keyframes — use [`text-ranges`](./02-materials.md#decoding-the-content-field) which writes multi-style entries inside the text material's `content` field.

## Programmatic combo: keyframe + animation on the same segment

Both systems coexist. A video segment can have `common_keyframes` driving a Ken Burns motion AND a `sticker_animation` driving a fade-in intro. CapCut composites both at render time.

## Mask geometry keyframes — encoding unknown (#44)

Masks (see [02 — materials](./02-materials.md)) are static on disk as far as any public evidence goes: the mask material's `config` object holds one set of geometry values (`centerX`, `centerY`, `width`, `height`, `rotation`, `feather`, ...), and none of the `property_type` identifiers above target mask geometry.

The desktop app CAN keyframe mask position/size/rotation/feather in the UI, so an on-disk encoding exists — but no app-authored draft using it has ever been captured in this repo or in the neighbouring ecosystem tools. Two candidate shapes, **both unverified**:

- **segment-level**: additional `property_type` identifiers (a `KFTypeMask*` family?) in `segment.common_keyframes`
- **material-level**: a keyframe container inside the mask material entry itself (in `masks` / `common_mask` / `common_masks`)

`capcut-cli` deliberately does not write mask keyframes: an invented encoding would save without error and silently no-op in the app — the pyJianYingDraft#160 failure class, where structures the app ignores produce no diagnostic at all.

**Already ruled out**, so the next person to pick this up does not repeat the search: `pyJianYingDraft`'s `KeyframeProperty` enum — the upstream `src/enums.json` is extracted from — defines eleven properties (position x/y, rotation, scale x/y, uniform scale, alpha, saturation, contrast, brightness, volume) and none that targets mask geometry. That is the same set the table above exposes, so there is no ecosystem encoding to borrow: the ground truth has to come from an app-authored capture.

**How to supply the ground truth:** animate a mask in the desktop app (two position keyframes are enough), save the draft, and run `capcut fixture <project> --out <dir>`. The bundle's `mask-keyframe-report.json` maps every mask material and keyframe structure it finds — unknown `property_type` values, keys on mask entries beyond what the CLI writes, and keyframe-shaped nodes inside mask materials. Attach the bundle to [issue #44](https://github.com/renezander030/capcut-cli/issues/44); it is blocked on exactly this artifact.
