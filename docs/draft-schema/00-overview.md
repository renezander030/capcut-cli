# 00 — Draft overview

A CapCut / JianYing project on disk is a directory containing a single canonical JSON file and a few sidecars:

```
<draft-id>/
├── draft_content.json   (Windows CapCut)  ──┐
├── draft_info.json      (macOS CapCut + JianYing)  ──┤ the project — pick whichever
├── draft_meta_info.json     metadata (name, cover, created/modified)
├── draft_agency_config.json animation library cache
├── draft_biz_config.json    feature flags
├── draft_settings           per-project user settings
├── performance_opt_info.json playback hints
├── common_attachment/       reusable assets shared across drafts
├── attachment_editing.json  per-draft editing state
├── attachment_pc_common.json shared editing state
└── assets/                  local copies of every imported clip
    ├── video/
    ├── audio/
    └── image/
```

`capcut-cli` operates on the single canonical JSON file. The directory siblings are persisted but not touched.

## Path differences across platforms

- **Windows CapCut**: `%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft\<id>\draft_content.json`
- **macOS CapCut**: `~/Movies/CapCut/User Data/Projects/com.lveditor.draft/<id>/draft_info.json`
- **macOS JianYing (剪映)**: `~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/<id>/draft_info.json`

`capcut-cli` auto-detects whichever filename is present when you pass either the directory or the file path.

## The 30-second mental model

```jsonc
{
  "id": "test-project-001",          // draft uuid
  "name": "Test Project",             // shown in CapCut project list
  "duration": 10000000,               // microseconds — total timeline length
  "fps": 30,
  "create_time": 0,                   // unix-ish timestamp
  "update_time": 0,
  "canvas_config": {
    "width": 1080, "height": 1920,    // pixel canvas
    "ratio": "9:16"                   // human label
  },
  "platform": {
    "app_source": "cc",               // "cc" = CapCut; "lv" = JianYing
    "app_version": "5.0.0",
    "os": "mac"
  },
  "tracks": [                         // ordered list — top of array = top of stack
    { "id": "...", "type": "video", "segments": [...] },
    { "id": "...", "type": "text",  "segments": [...] },
    { "id": "...", "type": "audio", "segments": [...] }
  ],
  "materials": {                      // every asset/element used anywhere
    "videos":             [...],      // video + image source materials
    "audios":             [...],
    "texts":              [...],      // each text segment has one text material
    "stickers":           [...],
    "video_effects":      [...],      // scene effects, filters
    "material_animations":[...],      // image intro/outro animation entries
    "transitions":        [...],
    "masks":              [...],
    "canvases":           [...],      // bg-blur / bg-color
    "speeds":             [...],      // playback speed envelopes
    "placeholder_infos":  [...],      // missing-asset placeholders
    "vocal_separations":  [...],      // VO/music split metadata
    "sound_channel_mappings": [...]   // stereo/mono routing
  },
  "extra_info": { ... },              // app-specific scratchpad
  "free_render_index_mode_on": false
}
```

Two things to internalize:

1. **`tracks` and `materials` are flat and decoupled.** A segment in a track does not contain its material inline — it references a material by `material_id`. The material lives in one of `materials.<type>` lists. To "find what a segment is", you go `segment.material_id` → `materials.<type>` → find by `id`.
2. **The format is overspecified.** Many fields exist that CapCut sets to defaults and most consumers ignore (`free_render_index_mode_on`, lots of zero-valued numerics in segment objects, etc.). Don't delete them when editing — preserve the structure or CapCut may misbehave.

## Top-level fields you'll touch

| Field | Type | Notes |
|---|---|---|
| `id` | string (uuid) | draft-level identifier |
| `name` | string | user-visible project name |
| `duration` | number (µs) | timeline length. `capcut-cli` recomputes this when commands extend the project. |
| `fps` | number | 24, 25, 30, 50, 60 are common |
| `canvas_config.width` / `.height` | number | px |
| `canvas_config.ratio` | string | "9:16" / "16:9" / "1:1" / "4:5" |
| `platform.app_source` | string | `"cc"` (CapCut) or `"lv"` (JianYing) — affects enum namespace |
| `tracks` | array | order = z-order (last drawn on top) |
| `materials.<category>` | array | lookup pool for segments |

## Top-level fields you can usually ignore

- `extra_info` — app scratchpad. CapCut owns it.
- `create_time` / `update_time` — CapCut overwrites on save.
- `mutable_config`, `static_cover_image`, `keyframe_graph_list`, `relationships`, `combination` — leave them as you found them.
- `version` — schema version; if missing, CapCut assumes latest.

## Where `capcut-cli` writes

Every write command in `capcut-cli`:

1. Creates a `.bak` file alongside the original (`draft_content.json.bak`).
2. Loads the JSON, applies the edit, recomputes `duration` if needed.
3. Writes back atomically, preserving the original file's indentation style.

The `.bak` is your safety net — if CapCut crashes on open, restore from `.bak`. Close CapCut on the project before editing, reopen after.

## `draft_meta_info.json` — the sidecar the app trusts for "what is imported"

The per-draft sidecar carries the registration fields (`draft_id`,
`draft_fold_path`, `draft_json_file`, `draft_name`, `draft_root_path`,
`tm_*`) that `capcut register` repairs, plus `draft_materials`: an array of
groups `{ "type": N, "value": [ … ] }`. Group `type: 0` lists the media the
user IMPORTED. Newer builds (reported on CapCut International 9.1.0, macOS —
[pyCapCut#13](https://github.com/GuanYixuan/pyCapCut/issues/13)) decide from
this list, not from the timeline's material paths, which clips are available:
a tool-built sidecar whose groups are all empty opens with every clip shown as
"file inaccessible" and a relink prompt, even though the paths in
`draft_content.json` are valid. `capcut lint` reports the empty state as
`media-unregistered`; `capcut register <project> --materials --apply` writes the
registration (v0.22, `src/materials-register.ts`).

One entry per distinct local file, matched by `file_Path`:

```jsonc
{
  "ai_group_type": "", "create_time": -1,
  "duration": 3000000,            // µs; photos: 5000000 nominal
  "enter_from": 0, "extra_info": "clip.mp4",   // display name
  "file_Path": "/abs/or/relative/path/clip.mp4",
  "height": 1080, "id": "<uuid>",
  "import_time": -1, "import_time_ms": -1, "item_source": 1,
  "material_color_tag": "", "md5": "",
  "metetype": "video",            // "video" | "photo" | "music"
  "roughcut_time_range": { "duration": -1, "start": -1 },
  "sub_time_range": { "duration": -1, "start": -1 },
  "type": 0, "width": 1920
}
```

**Provenance, and what is still inferred:** the shape is pyCapCut PR
[#14](https://github.com/GuanYixuan/pyCapCut/pull/14) (gingatimo, 2026-08-18),
verified by its author against the 9.1.0 relink prompt; `-1` timestamps and an
empty `md5` are what the app accepts for a manual import. No app-authored 9.1
sidecar is committed here yet — `capcut fixture` on a draft the app itself
imported media into would confirm the shape byte-for-byte (the bundle includes
`draft_meta_info.json`). The CLI merges, never replaces: existing entries stay,
missing files are appended to the type-0 group, re-runs are no-ops.

## Common gotchas

- **CapCut MUST be closed on the draft before edit.** CapCut periodically rewrites the file from in-memory state; editing while open = your changes overwritten on next save. `capcut-cli` does not enforce this, but you'll lose data if you skip it.
- **Audio segments need `clip: null`.** Setting `clip: {…}` on an audio segment crashes CapCut. Video / image / text segments need a `clip` object.
- **Speed changes affect source_timerange math.** If you set `seg.speed = 2.0`, the `source_timerange.duration` must be `2 × target_timerange.duration` for the math to balance. `capcut-cli`'s `speed` command does this for you.
- **Time units are microseconds everywhere.** `start_us`, `duration_us`, `time_offset`, `seg.target_timerange.start` are all µs. 1 second = 1_000_000 µs.
