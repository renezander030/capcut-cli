#!/usr/bin/env node

import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAss } from "./ass.js";
import { stripBom } from "./bom.js";
import { captionDraft } from "./caption.js";
import { removeChroma, setChroma } from "./chroma.js";
import {
  buildCommandSpecs,
  commandDeclaresFlag,
  completionWords,
  GLOBAL_OPTION_SPECS,
  RELEASE_SCOPED_FLAGS,
  renderCommandIndex,
} from "./command-specs.js";
import { type CompileSpec, compileDraft, parseSpec, planCompile } from "./compile.js";
import type {
  ImageAnimOptions,
  KeyframeInput,
  MaskOptions,
  TextAnimOptions,
  TextRangeInput,
  TextStyleOptions,
} from "./decorators.js";
import {
  addImageAnim,
  addKeyframes,
  addMask,
  addTextAnim,
  addTransition,
  bubbleCatalogue,
  bubbleSlugs,
  buildEmphasisRanges,
  DEFAULT_KEYWORD_SIZE,
  imageAnimSlugs,
  KARAOKE_HIGHLIGHT_COLOR,
  keyframeProperties,
  maskSlugs,
  parseKeyframeValue,
  setBgBlur,
  setBubble,
  setTextRanges,
  setTextStyle,
  textAnimSlugs,
} from "./decorators.js";
import { detectEncryption } from "./decrypt.js";
import { type DoctorCheck, draftDirs, runDoctor } from "./doctor.js";
import type { Draft, MaterialText, Segment, Track } from "./draft.js";
import {
  assertTargetsUnchangedOnDisk,
  commitDraftTargets,
  extractStyleRanges,
  extractText,
  findDraft,
  findMaterial,
  findMaterialGlobal,
  findSegment,
  getMaterialTypes,
  getTracksByType,
  isDryRun,
  listSnapshots,
  loadDraft,
  saveDraft,
  setDryRun,
  setForceWrite,
  updateTextContent,
} from "./draft.js";
import { type Category, listEnum, type Namespace } from "./enums.js";
import { exportBatch } from "./export-batch.js";
import type { AddAudioOptions, AddTextOptions, AddVideoOptions, CutOptions } from "./factory.js";
import {
  addAudio,
  addEffect,
  addFilter,
  addSticker,
  addText,
  addVideo,
  applyDraftRegistration,
  applyTemplate,
  type CropRect,
  copyTextStyle,
  cropRectForRatio,
  cutProject,
  duplicateSegment,
  effectSlugs,
  filterCatalogue,
  filterSlugs,
  getCrop,
  initDraft,
  mixModeSlugs,
  planDraftRegistration,
  resolveAssetPath,
  saveTemplate,
  setAudioFade,
  setCover,
  setCrop,
  setMixMode,
  uuid,
} from "./factory.js";
import { sanitizeDraftBundle } from "./fixture.js";
import { DEFAULT_LINT_OPTIONS, fixDraft, type LintOptions, lintDraft, lintExitCode, summarize } from "./lint.js";
import { migrateDraft } from "./migrate.js";
import { applyTextPreset, extractTextPreset, loadPresetFile, type TextStylePreset } from "./preset.js";
import { probeMedia } from "./probe.js";
import { runQuickstart } from "./quickstart.js";
import { buildRenderPlan, renderDraft } from "./render.js";
import { replaceMedia } from "./replace.js";
import { detectScenes, timecode } from "./scenes.js";
import { serveQueue } from "./serve.js";
import { addSfx } from "./sfx.js";
import { collapseKaraokeRuns, cueWords, parseSrt, renderSrt, renderVtt, type SegmentCue } from "./srt.js";
import { diagnoseDraftStore, discoverDraftStore, editorProcesses, planTimelineSync } from "./store.js";
import { formatDuration, formatTime, parseTimeInput } from "./time.js";
import { translateDraft } from "./translate.js";
import { detectVersion } from "./version.js";

export const COMMANDS = [
  "info",
  "version",
  "lint",
  "tracks",
  "segments",
  "texts",
  "set-text",
  "shift",
  "shift-all",
  "speed",
  "volume",
  "trim",
  "opacity",
  "export-srt",
  "materials",
  "segment",
  "material",
  "add-audio",
  "add-video",
  "add-text",
  "crop",
  "cut",
  "duplicate",
  "keyframe",
  "transition",
  "mask",
  "bg-blur",
  "text-style",
  "text-anim",
  "image-anim",
  "add-sticker",
  "mix-mode",
  "audio-fade",
  "add-cover",
  "add-filter",
  "bubble-text",
  "add-effect",
  "save-template",
  "apply-template",
  "make-preset",
  "templates",
  "batch",
  "import-srt",
  "import-ass",
  "text-ranges",
  "caption",
  "translate",
  "migrate",
  "add-sfx",
  "chroma",
  "prune",
  "register",
  "relink",
  "replace-media",
  "timeline",
  "projects",
  "diff",
  "concat",
  "config",
  "describe",
  "completions",
  "enums",
  "doctor",
  "diagnose",
  "fixture",
  "sync-timelines",
  "restore",
  "serve",
  "decrypt",
  "export",
  "init",
  "quickstart",
  "compile",
  "render",
  "detect-scenes",
] as const;

const HELP = `capcut-cli -- fast edits to CapCut projects

Usage: capcut <command> <project> [options]

  <project> = path to draft_content.json, draft_info.json, or their parent directory

Global flags:
  -H, --human     Human-readable table output (default: JSON)
  -v, --version   Print the installed CLI version
  -q, --quiet     No output on success, exit code only (write commands)
  --dry-run       Preview a mutating command: print the result (with
                  "dryRun":true) but leave the draft and its .bak untouched
  --force-write   Override editor-running and changed-on-disk safety checks
  --jianying      Use JianYing enum namespace (default: CapCut) for
                  transition, mask, text-anim, image-anim, add-effect, enums

Overview (start here):
  info       <project>                          Project overview + material summary
  tracks     <project>                          List all tracks
  materials  <project>                          List all material types + counts
  materials  <project> --type <type>            List items of one material type
  version    <project>                          Detect CapCut/JianYing version + schema flags + support status
  lint       <project>                          Schema-aware checks (overlaps, line length, missing files)
             Options:
               --max-chars <n>     Caption line cap (default 42)
               --max-cue-secs <n>  Caption duration cap (default 7)
               --min-gap-ms <n>    Min gap between captions (default 0)
               --no-check-paths    Skip local-file existence checks
               --fix               Auto-repair issues stamped fixable:true
                                   (cue-too-long, caption-overlap,
                                   caption-gap-too-small, line-too-long).
                                   Never shrinks a caption below 100ms and
                                   never splits words; instances it cannot
                                   repair are reported with fixable:false.
                                   Combine with --dry-run to preview.
             Exit codes: 0 clean · 1 warnings · 2 errors. Info-level issues
             (e.g. unknown-effect-slug, which store-downloaded effects from
             the CapCut app trigger legitimately) never affect the exit code.

Browse:
  segments   <project> [--track <type>]         List segments with timing
  texts      <project>                          List all text/subtitle content

Detail (drill into one item):
  segment    <project> <id>                     Full detail for one segment + its material
  material   <project> <id>                     Full detail for one material

Create:
  init       <name> [--template <dir>] [--drafts <dir>]
             Create a new empty draft from template. Defaults:
               --template   bundled minimal template (no external repo needed)
               --drafts     ~/Movies/CapCut/User Data/Projects/com.lveditor.draft
  quickstart <name> [--video <f>] [--audio <f>] [--srt <f>] [--drafts <dir>]
             One-command first draft: create + add one input + lint + print the
             exact "open in CapCut" step. The fastest path from a file to an
             editable project. Pass at least one of --video / --audio / --srt.
             Durations come from ffprobe when available (5s placeholder if not).
             Exit codes: 0 created & lint-clean · 2 created but lint errors
  compile    <spec.json> [--out <draftdir>] [--drafts <dir>]
             Build a whole draft from a declarative JSON spec (the inverse of
             describe). Times are in seconds. Media paths resolve relative to
             the spec file. Validates the full spec before writing anything.

Preview:
  render     <project> [--out <file.mp4>] [options]
             Render a low-res ffmpeg PROXY preview of the timeline so you can
             watch an edit without opening CapCut. Flattens the main video
             track (trim + per-segment speed) and mixes audio segments; it is
             NOT CapCut's final render (no multi-track compositing/effects).
             Options:
               --scale <f>        Proxy scale of canvas dims (default 0.5)
               --fps <n>          Output fps (default draft fps)
               --burn-captions    Draw text-track segments onto the video
               --ffmpeg-cmd <p>   ffmpeg binary (default ffmpeg)
               --dry-run          Print the ffmpeg plan; do not execute

Analyze:
  detect-scenes <video> [--threshold <n>] [--min-gap <s>] [--limit <n>]
             Detect scene-change cut points in a raw video file (ffmpeg scene
             filter — deterministic, no draft needed). Prints each cut as
             seconds + hh:mm:ss.mmm + score, plus the resulting segment list
             in seconds AND microseconds (the draft-native unit), ready to
             seed a long-form-to-shorts split: feed the segments into
             "capcut compile" (one clip per segment) or "capcut cut".
             The final segment ends at the VIDEO stream's real duration
             (read via ffprobe), so it never overruns the video when a
             longer audio track pads the container; without ffprobe it
             falls back to the container duration and duration_source
             says so. Detection only — it never touches a draft. Options:
               --threshold <n>    Scene score a cut must exceed, 0..1 (default 0.4)
               --min-gap <s>      Merge cuts closer than <s> seconds, keeping
                                  the strongest (default 2)
               --limit <n>        Keep only the <n> strongest cuts
               --ffmpeg-cmd <p>   ffmpeg binary (default ffmpeg)
               --ffprobe-cmd <p>  ffprobe binary for the video-stream
                                  duration (default ffprobe)
               --json             Force JSON output (the default; overrides -H)

Add:
  add-audio  <project> <file-or-wikimedia-url> <start> <duration> [options]
             Add an audio segment (VO, music, SFX). URLs to wikipedia.org /
             commons.wikimedia.org / upload.wikimedia.org are resolved via
             the Commons imageinfo API, license-checked, then downloaded to
             assets/audio/wikimedia/. Options:
               --volume <n>       Volume 0.0-1.0 (default: 1.0)
               --track-name <s>   Track name (default: "audio")
               --force-license    Bypass refusal on restrictive/unknown license

  add-video  <project> <file-or-wikimedia-url> <start> <duration> [options]
             Add a video or image segment. Accepts Wikimedia URLs (same as
             add-audio). Type auto-detected from extension.
             Options:
               --track-name <s>   Track name (default: "video")
               --width <n>        Source width in px (default: auto-probed via
                                  ffprobe, else 1920)
               --height <n>       Source height in px (default: auto-probed via
                                  ffprobe, else 1080)
               --force-license    Bypass refusal on restrictive/unknown license

  add-text   <project> <start> <duration> <text> [options]
             Add a text segment. Options:
               --font-size <n>    Font size (default: 15)
               --color <hex>      Text color (default: #FFFFFF)
               --align <0|1|2>    Left/center/right (default: 1)
               --x <n> --y <n>    Position (-1 to 1, default: 0,0)
               --track-name <s>   Track name (default: "text")
               --preset <file>    Apply a make-preset style preset; explicit
                                  flags override preset values

Edit:
  set-text   <project> <id> <text>              Change text content
  shift      <project> <id> <offset>            Shift segment timing (e.g. +0.5s, -1s)
  shift-all  <project> <offset> [--track <type>] Shift all segments on a track
  speed      <project> <id> <multiplier>        Set playback speed
  volume     <project> <id> <level>             Set volume (0.0-1.0)
  trim       <project> <id> <start> <duration>  Trim segment (times in seconds)
  opacity    <project> <id> <alpha>             Set opacity (0.0-1.0)
  crop       <project> <segment-id> [options]   Read or set the source-material crop
             No flags: read-only — print the material's crop struct as JSON
             (plus source width/height when stored) and write nothing.
             Options:
               --ratio <r>        free|1:1|16:9|9:16|4:3|3:4 — centered maximal
                                  crop of that aspect against the source
                                  width/height stored in the draft (errors if
                                  the dims are missing/zero: pass --rect)
               --rect <x,y,w,h>   Explicit normalized rect, 0..1 fractions of
                                  the source frame; overrides --ratio
               --reset            Restore the full frame
             When the material carries a crop_ratio field it is stamped
             "free" (CapCut's preset enum values are not published), so the
             app recomputes from the corner points.
  duplicate  <project> <segment-id> [--track <track-name> | --new-track]
             Duplicate a segment at the SAME timeline position/duration onto a
             track that renders ABOVE the source (the PIP local-retouch flow
             from issue #44: copy the clip above itself, then mask the copy).
             Default and --new-track: a fresh same-type track directly above
             the source. --track <track-name>: use that existing same-type
             track; exits 1 when the target range is occupied there. The media
             file on disk stays shared, but the material entry and every
             per-segment companion (speed, canvas, mask, ...) are cloned with
             fresh ids, so edits like crop/mix-mode on the copy never touch
             the source segment.
  export-srt <project> [options]                Export subtitles to SRT/WebVTT
  batch      <project>                          Run multiple edits from stdin (JSONL)
  restore    <project> [--step N | --list]      Undo writes (latest .bak, or N writes back; --list history)

Maintenance & inspection:
  prune      <project>                          Remove materials no segment references
  register   <project-dir> [--apply] [--drafts <dir>]  Repair an EXISTING draft's
             registration metadata so the CapCut app lists it again (init only
             registers drafts it creates): recreates a missing/corrupt
             draft_meta_info.json sidecar and inserts/updates the draft's entry
             in the store's root_meta_info.json. id/name/duration derive from
             draft_content.json, which is never written. Prints the per-target
             plan (needs_repair + detail) by default; --apply writes atomically
             with a .bak per file modified and no-ops (applied: []) when the
             draft is already registered. A draft that does not live inside a
             known store root (parent with root_meta_info.json, a managed
             com.lveditor.draft path, or --drafts <dir>) is reported explicitly
             and nothing is written. Refuses to write while the editor is
             running unless --force-write. Exits 2 on --apply when a target
             stays blocked (unknown store root, unreadable root_meta_info.json).
  relink     <project> --dir <d> | --from <p> --to <q>  Repair broken media paths
  replace-media <project> <segment-id> <new-file> [--retime]
             Swap a segment's source clip (placeholder > final render) while
             keeping its timeline position, timing, effects, and keyframes.
             Refreshes duration/dimensions via ffprobe. --retime fits the
             segment to the new clip; default preserves the original in/out.
  timeline   <project> [--cols N]               Show track/segment layout (JSON, or -H ASCII bars)
  projects   [query] [--drafts <dir>] [--names] List CapCut/JianYing draft folders on disk
  diff       <projectA> <projectB>             Compare two drafts (added/removed/changed)
  concat     <projectA> <draftB> [--out <p>]   Append draftB onto projectA's timeline (id-safe)
  config                                       Show resolved .capcutrc + effective defaults
  describe                                      Emit the full command surface as JSON (agent tool spec)
  diagnose   <project> [--bundle <report.json>] Inspect canonical draft files and divergence
  fixture    <project> --out <dir>              Build a shareable, redacted compatibility bundle
             (timeline JSON only, no media; home paths + emails redacted) to
             attach to a version-support issue like #35.
  sync-timelines <project-dir> [--apply]        Reconcile timeline mirrors (template-2.tmp,
             draft_info.json) that drifted from draft_content.json, so a CLI
             edit is honored by CapCut >= 8.7 (issue #35). Prints the plan
             (with each file's mtime) by default; --apply rewrites ONLY the
             drifted mirrors — draft_content.json and in-sync mirrors are
             never touched — with a .bak per file written. Refuses to write
             while the editor is running, or when draft_content.json is older
             than a drifted mirror (the app may have saved newer edits there),
             unless --force-write. Accepts the project directory or its
             draft_content.json path. Exits 2 when a mirror exists that the
             CLI cannot reconcile (binary/encrypted template-2.tmp).

Animate:
  keyframe   <project> <id> <property> <time> <value> [--easing <name>]
             Add a keyframe to a segment. Single-shot.
  keyframe   <project> <id> --batch [--easing <name>]
             Read JSONL from stdin; each line = {"property","time","value"}
             plus optional "easing" overriding --easing per line.
             Properties: position_x, position_y, rotation, scale_x, scale_y,
                         uniform_scale, alpha, saturation, contrast, brightness, volume
             Values: "1.5", "50%" (alpha/volume), "45deg" (rotation),
                     "+0.5"/"-0.3" (saturation/contrast/brightness)
             Easing: linear (default), ease-in, ease-out, ease-in-out — written
                     as CapCut bezier handles (ease-out = the UI's "Cubic Out").
                     Easing needs an adjacent keyframe on the same property: a
                     lone eased keyframe stays linear (warns) and picks up the
                     curve when its pair is added with an easing. A linear
                     insert between eased keyframes resets the neighbours'
                     facing handles, so both new sub-segments render linear.

  transition <project> <id> <slug> [--duration <s>]
             Attach a transition to a video/image segment. Slug examples:
               dissolve, rgb-glitch, radial-blur, horizontal-blur, twinkle-zoom,
               urban-glitch, shake-3, vertical-blur-ii
  mask       <project> <id> <slug> [options]  |  <project> <id> --off
             Attach/remove a mask. Slugs: linear, mirror, circle, rectangle,
             heart, star. Options: --center-x --center-y --size --rotation
             --feather --invert --rect-width --round-corner (rect only).
  bg-blur    <project> <id> <1|2|3|4>  |  <project> <id> --off
             Set background blur level (0.0625 / 0.375 / 0.75 / 1.0).
  text-style <project> <id> [options]
             Rich text styling on an existing text segment. Options:
               --alpha --vertical --fixed-width --fixed-height
               --shadow --shadow-alpha --shadow-angle --shadow-color
               --shadow-distance --shadow-smoothing
               --border-width --border-color --border-alpha
               --bg-color --bg-alpha --bg-style --bg-round-radius
               --bg-width --bg-height --bg-h-offset --bg-v-offset
               --preset <file>  Apply a make-preset style preset; explicit
                                flags override preset values
  text-ranges <project> <id> --styles @path.json  |  --styles '<inline-json>'
             Multi-colour text — write multiple styles to one text segment.
             JSON array of { "start": int, "end": int,
               "font_color":"#RRGGBB", "font_size":18, "font_alpha":1,
               "bold":true, "italic":true, "underline":true }.
             start/end are JS string code-unit indices (char-level for BMP).
             Gaps are auto-filled with the baseline style.
  text-anim  <project> <id> [--intro <slug>] [--outro <slug>]
                          [--intro-duration <s>] [--outro-duration <s>]
             Slugs: fade-in, fade-out, typewriter, pop-up, throw-out,
                    blur-text-in, zoom-in-text.
  image-anim <project> <id> [--intro <slug>] [--outro <slug>] [--combo <slug>]
                          [--intro-duration <s>] [--outro-duration <s>]
                          [--combo-duration <s>]
             Video/image intro/outro/combo animations. Slugs:
               fade-in, flash-in, pulsing-zooms, scroll-up, stripe-merge,
               zoom-out (intros); fade-out, blur-out, smoke (outros).

Tracks (Phase 2):
  bubble-text <project> <text-segment-id> --bubble <slug>
             Apply a speech-bubble shape to an existing text segment. Writes
             a materials.filters[] entry (type:text_shape) referenced from
             the segment, plus stamps bubble_effect_id / bubble_resource_id
             on the text material. Slugs: rectangle, rounded, cloud, oval,
             star, heart, burst (or pass --effect-id / --resource-id
             explicitly from your own CapCut draft).
             Discovery: capcut enums --bubbles
  add-filter <project> <slug> <start> <duration> [options]
             Colour filter on a dedicated filter track. Slugs (capcut):
               vintage, warm, cool, bw, sepia, vivid, contrast, faded,
               dramatic, soft (+ enums --filters --jianying for 468 more).
             Options:
               --track-name <s>      Filter track name (default: "filter")
               --jianying            Use the JianYing namespace
  add-cover  <project> <image-path> [--time <ms>]
             Set the draft's cover frame (thumbnail) to an image. Writes a
             cover object on the draft root with {path, type, time, time_ms,
             custom_cover_id}. CapCut/JianYing re-renders the thumbnail on
             next open. --time defaults to 0 (start of timeline).
  audio-fade <project> <segment-id> [--in <sec>] [--fade-out <sec>]
             Apply audio fade-in / fade-out on an audio segment. Writes
             a materials.audio_fades[] entry referenced from the segment.
             At least one of --in or --fade-out (>0) is required.
             Note: --out is the global output-path flag; use --fade-out here.
  mix-mode   <project> <segment-id> <mode>
             Set blend mode on a video segment. Modes: normal, multiply,
             screen, overlay, soft-light, hard-light, color-dodge, color-burn,
             darken, lighten, difference, exclusion.
  add-sticker <project> <resource-id> <start> <duration> [options]
             Creates a sticker segment on a sticker track. Options:
               --x <n> --y <n>       Position (-1 to 1)
               --scale <n>           Uniform scale (default 1)
               --rotation <deg>      Clockwise rotation
               --track-name <s>      Sticker track name (default: "sticker")
  add-effect <project> <slug> <start> <duration> [options]
             Scene/character effect on an effect track. Slugs:
               shake, vhs, cinematic, light-leak, film-grain, chromatic,
               vignette.
             Options:
               --params <json-array> Effect parameters (0-100 each)
               --track-name <s>      Effect track name (default: "effect")

Templates:
  save-template <project> <id> <name> --out <path>
             Extract any segment as a reusable template (text, sticker, video, audio)
  apply-template <project> <template.json> <start> <duration> [text override]
             Stamp a template into a project at the given time
             Options: --x <n> --y <n> (override position)
  make-preset <project> <text-segment-id> --out <preset.json>
             Extract the text styling of a segment as a reusable preset
             (font, colors, shadow/border/background box, alignment/position,
             bubble, text ranges). Apply with --preset on add-text,
             text-style, or caption; explicit CLI flags override preset
             values (including per-range colours/sizes for the span they
             cover). A preset applies in full: a preset WITHOUT text ranges
             resets the target to one uniform style, clearing any existing
             karaoke/highlight ranges. Honors --dry-run (no file written).
  templates
             Show available templates in the template library.
             Use -H for a table.

Project:
  cut        <project> <start> <end> --out <path>
             Extract a time range into a new project (long-form → short)

Discovery (Phase 3):
  enums      --transitions | --masks | --image-intros | --image-outros |
             --image-combos | --text-intros | --text-outros |
             --text-loop-anims | --scene-effects | --character-effects |
             --audio-effects | --fonts
             List valid enum slugs (CapCut namespace by default).
             Add --jianying to switch namespace. Use -H for a table.

Caption (v0.4 — real subtitle objects, fixes import-srt mimicry):
  caption    <project> --audio <path> [options]
  caption    <project> --from-segment <id> [options]
             Auto-caption via whisper; emits real CapCut subtitle-track objects.
             Options:
               --whisper-cmd <cmd>  Path to whisper binary (default: "whisper")
               --whisper-model <m>  Model name (default: "base")
               --language <code>    ISO code or "auto" (default)
               --track-name <s>     Caption track name (default: "captions")
               --style-ref <seg-id> Mirror styling from existing text segment
               --preset <file>      Base style from a make-preset file
                                    (same coverage as --style-ref)
               --highlight-words <w1,w2,...|@file>
                                    Emphasize these words in every cue
                                    (case-insensitive whole-word match;
                                    @file = one word/phrase per line)
               --keyword-color <#RRGGBB>
                                    Emphasis colour (default #FFD700, the
                                    same gold --karaoke uses)
               --keyword-size <n>   Emphasis size as a multiplier on the
                                    cue's base font size (default 1.2)
               --color-cycle <#hex1,#hex2,...>
                                    Rotate the BASE text colour per cue in
                                    list order (independent of emphasis)
             Precedence: --color-cycle wins over the style-ref/preset base
             colour per cue; keyword emphasis sits on top of base/karaoke
             styling and overrides the matched words' colour/size; with
             --karaoke, karaoke ranges are built first and keyword matches
             override those words.

Translate (v0.4 — multi-language draft clone):
  translate  <project> --to <lang> --out <path> [options]
             Translate every text segment via Anthropic API, write a new draft.
             Options:
               --from <lang>        Source language (default: "auto")
               --api-key <key>      Override ANTHROPIC_API_KEY env var
               --model <id>         Model (default: claude-haiku-4-5-20251001)
               --dry-run            List what would be translated, no API call

Migrate (v0.4 — survive JianYing/CapCut version jumps):
  migrate    <project> --from <ver> --to <ver>
             Apply known schema migrations. Implemented: mask <-> common_masks
             across the JianYing 5.9 / CapCut 9.6 boundary.

Sound effects + chroma (v0.5):
  add-sfx    <project> <slug> <start> <duration> [options]
             First-class SFX on a dedicated track. Slugs: capcut enums --audio-effects
             Options: --track-name --volume
  chroma     <project> <id> --color <#RRGGBB> [--intensity N]
  chroma     <project> <id> --off
             Apply chroma key (green-screen) to a video segment.
             --intensity: how aggressively to key out the color (0-1, default 0.5).

Render queue (v0.4 — experimental):
  export     <drafts-dir> --batch [options]
             EXPERIMENTAL UI-automated render queue. macOS only currently.
             Options: --dry-run, --app capcut|jianying

Encryption (v0.6 — detection scaffold):
  decrypt    <project>
             Detect JianYing 6.0+ encryption and report next steps.
             (Decryption algorithm not bundled; clear error UX + workaround docs.)
  doctor
             Check the environment, not a draft: Node version, whisper binary
             (for caption), ANTHROPIC_API_KEY (for translate), and the default
             CapCut/JianYing project directory. Exit 1 only on hard failures.

Stateless queue runner (v0.5):
  serve      [--queue <path>] [--fail-fast]
             Read {cmd, project, args} JSONL from stdin or --queue, dispatch
             each to the CLI, write JSONL results. No daemon, no port, no state.

Subtitles (Phase 3):
  import-ass <project> <ass-path-or--> [options]
             Parse an ASS / SSA file ([Events] section, Dialogue lines)
             and create one text segment per cue. Inline override codes
             ({\\b1\\an8}, \\N) are stripped from the displayed text.
             Same flags as import-srt below.
  import-srt <project> <srt-path-or--> [options]
             Parse an SRT file and create one text segment per cue.
             Options:
               --track-name <s>      Text track (default: "subtitle")
               --time-offset <s>     Shift all cue timings (e.g. +0.5s)
               --style-ref <seg-id>  Copy styling from an existing text segment
               --font-size --color --align --x --y
               --alpha --vertical --shadow --shadow-color --shadow-distance
               --border-width --border-color --border-alpha
               --bg-color --bg-alpha --bg-style --bg-round-radius --bg-h-offset
               --highlight-words <w1,w2,...|@file>
                                     Emphasize these words in every cue
                                     (case-insensitive whole-word match;
                                     @file = one word/phrase per line)
               --keyword-color <#RRGGBB>
                                     Emphasis colour (default #FFD700, the
                                     same gold caption --karaoke uses)
               --keyword-size <n>    Emphasis size as a multiplier on the
                                     cue's base font size (default 1.2)
               --color-cycle <#hex1,#hex2,...>
                                     Rotate the BASE text colour per cue in
                                     list order (independent of emphasis)
             Precedence: --color sets the base colour for all cues unless
             --color-cycle is given (then the cycle wins per cue); keyword
             emphasis sits on top of the base styling and overrides the
             matched words' colour/size.
  export-srt <project> [options]
             Export subtitles to stdout.
             Options:
               --granularity <line|word>  One cue per caption (default: line)
                                          or per word (karaoke).
               --format <srt|vtt>         SRT (default) or WebVTT. WebVTT word
                                          cues use inline <timestamps>; WebVTT
                                          cue text escapes & < > as entities.
             Word timings are real where the draft stores them (caption
             --karaoke word segments); elsewhere they are interpolated within
             each cue, weighted by word character length.

Navigation: info → tracks/materials → segments → segment <id>
            info → materials --type X → material <id>
Time formats: 1.5s, 500ms, 1:30, +0.5s, -200ms
IDs: first 6+ chars of segment/material ID (prefix match)

Full viral-shorts pipeline (Claude skill + hooks + templates):
  https://renezander.gumroad.com/l/viral-youtube-shorts-blueprint
Guides & docs:  https://renezander.com/guides/capcut-automation
Sponsor:        https://github.com/sponsors/renezander030
Hire me:        https://renezander.com/contact`;

// --- Flag parsing ---

interface Flags {
  human: boolean;
  quiet: boolean;
  batch: boolean;
  track?: string;
  out?: string;
  fontSize?: number;
  color?: string;
  align?: number;
  x?: number;
  y?: number;
  trackName?: string;
  width?: number;
  height?: number;
  volume?: number;
  template?: string;
  drafts?: string;
  // keyframe
  easing?: string;
  // Phase 1 decorators
  duration?: string;
  off?: boolean;
  centerX?: number;
  centerY?: number;
  size?: number;
  rotation?: number;
  feather?: number;
  invert?: boolean;
  rectWidth?: number;
  roundCorner?: number;
  // text-style
  alpha?: number;
  vertical?: boolean;
  fixedWidth?: number;
  fixedHeight?: number;
  shadow?: boolean;
  shadowNo?: boolean;
  shadowAlpha?: number;
  shadowAngle?: number;
  shadowColor?: string;
  shadowDistance?: number;
  shadowSmoothing?: number;
  borderWidth?: number;
  borderColor?: string;
  borderAlpha?: number;
  bgColor?: string;
  bgAlpha?: number;
  bgStyle?: number;
  bgRoundRadius?: number;
  bgWidth?: number;
  bgHeight?: number;
  bgHOffset?: number;
  bgVOffset?: number;
  // audio-fade
  fadeIn?: string;
  fadeOut?: string;
  // add-cover
  time?: string;
  // bubble-text
  bubble?: string;
  effectId?: string;
  bubbles?: boolean;
  // text-anim / image-anim
  intro?: string;
  outro?: string;
  combo?: string;
  introDuration?: string;
  outroDuration?: string;
  comboDuration?: string;
  // sticker
  scale?: number;
  resourceId?: string;
  // effect
  params?: string;
  // enums
  enumCategory?: Category;
  jianying?: boolean;
  // import-srt
  styleRef?: string;
  timeOffset?: string;
  font?: string;
  // text-ranges
  styles?: string;
  // make-preset / --preset
  preset?: string;
  // wikimedia
  forceLicense?: boolean;
  // lint
  maxChars?: number;
  maxCueSecs?: number;
  minGapMs?: number;
  noCheckPaths?: boolean;
  fix?: boolean;
  // caption
  audio?: string;
  fromSegment?: string;
  whisperCmd?: string;
  whisperEngine?: "auto" | "openai" | "whisper-cpp" | "faster-whisper";
  whisperModel?: string;
  language?: string;
  karaoke?: boolean;
  maxWords?: number;
  maxGapMs?: number;
  // caption / import-srt keyword emphasis + colour cycling
  highlightWords?: string;
  keywordColor?: string;
  keywordSize?: number;
  colorCycle?: string;
  noProbe?: boolean;
  ffprobeCmd?: string;
  // export-srt
  granularity?: "line" | "word";
  format?: "srt" | "vtt";
  // quickstart
  video?: string;
  srt?: string;
  // replace-media
  retime?: boolean;
  // translate
  to?: string;
  from?: string;
  apiKey?: string;
  model?: string;
  dryRun?: boolean;
  // migrate
  // (uses --from / --to from translate)
  // chroma
  intensity?: number;
  // export
  app?: string;
  // serve
  queue?: string;
  failFast?: boolean;
  workers?: number;
  retries?: number;
  timeoutMs?: number;
  backoffMs?: number;
  maxBufferMb?: number;
  version?: boolean;
  // relink / projects / timeline / restore
  dir?: string;
  step?: number;
  list?: boolean;
  cols?: number;
  names?: boolean;
  fps?: number;
  ffmpegCmd?: string;
  burnCaptions?: boolean;
  allVideoTracks?: boolean;
  forceWrite?: boolean;
  bundle?: string;
  continueOnError?: boolean;
  check?: boolean;
  plan?: boolean;
  apply?: boolean;
  // detect-scenes
  threshold?: number;
  minGap?: number;
  limit?: number;
  json?: boolean;
  // crop
  ratio?: string;
  rect?: string;
  reset?: boolean;
  // duplicate
  newTrack?: boolean;
}

// Map CLI enum flags -> enums.json category key. Order matters for HELP text.
const ENUM_FLAG_MAP: Array<{ flag: string; category: Category }> = [
  { flag: "--transitions", category: "transitions" },
  { flag: "--masks", category: "masks" },
  { flag: "--image-intros", category: "image_intros" },
  { flag: "--image-outros", category: "image_outros" },
  { flag: "--image-combos", category: "image_combos" },
  { flag: "--text-intros", category: "text_intros" },
  { flag: "--text-outros", category: "text_outros" },
  { flag: "--text-loop-anims", category: "text_loop_anims" },
  { flag: "--scene-effects", category: "scene_effects" },
  { flag: "--character-effects", category: "character_effects" },
  { flag: "--audio-effects", category: "audio_effects" },
  { flag: "--fonts", category: "fonts" },
  { flag: "--filters", category: "filters" },
];

function bashCompletion(): string {
  const words = completionWords(commandSpecs()).join(" ");

  return `# bash completion for capcut

_capcut()
{
    local cur
    cur="\${COMP_WORDS[COMP_CWORD]}"

    COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
}

complete -F _capcut capcut
`;
}

function zshCompletion(): string {
  const words = completionWords(commandSpecs())
    .map((w) => `"${w}"`)
    .join("\n    ");

  return `#compdef capcut

_capcut() {
  local -a commands

  commands=(
    ${words}
  )

  _describe 'command' commands
}

compdef _capcut capcut
`;
}

function fishCompletion(): string {
  return completionWords(commandSpecs())
    .map((word) => `complete -c capcut -f -a "${word}"`)
    .join("\n");
}

function parseFlags(args: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = { human: false, quiet: false, batch: false };
  // The subcommand is the first non-flag token (matches how dispatch reads
  // positional[0]). Used to scope flags added in this release to the commands
  // that declare them.
  const command = args.find((a) => a.length > 0 && !a.startsWith("-"));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // A flag added in this release that the current command does not declare is
    // left in the positional stream verbatim, so a value-consuming flag can
    // never strip tokens from another command's free-text arguments.
    if (RELEASE_SCOPED_FLAGS.has(a) && !commandDeclaresFlag(command, a)) {
      positional.push(a);
      continue;
    }
    if (a === "-H" || a === "--human") flags.human = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else if (a === "-q" || a === "--quiet") flags.quiet = true;
    else if (a === "--batch") flags.batch = true;
    else if (a === "--easing" && i + 1 < args.length) {
      flags.easing = args[++i];
    } else if ((a === "--track" || a === "--type") && i + 1 < args.length) {
      flags.track = args[++i];
    } else if (a === "--out" && i + 1 < args.length) {
      flags.out = args[++i];
    } else if (a === "--font-size" && i + 1 < args.length) {
      flags.fontSize = parseFloat(args[++i]);
    } else if (a === "--color" && i + 1 < args.length) {
      flags.color = args[++i];
    } else if (a === "--align" && i + 1 < args.length) {
      flags.align = parseInt(args[++i], 10);
    } else if (a === "--x" && i + 1 < args.length) {
      flags.x = parseFloat(args[++i]);
    } else if (a === "--y" && i + 1 < args.length) {
      flags.y = parseFloat(args[++i]);
    } else if (a === "--track-name" && i + 1 < args.length) {
      flags.trackName = args[++i];
    } else if (a === "--width" && i + 1 < args.length) {
      flags.width = parseFloat(args[++i]);
    } else if (a === "--height" && i + 1 < args.length) {
      flags.height = parseFloat(args[++i]);
    } else if (a === "--volume" && i + 1 < args.length) {
      flags.volume = parseFloat(args[++i]);
    } else if (a === "--template" && i + 1 < args.length) {
      flags.template = args[++i];
    } else if (a === "--drafts" && i + 1 < args.length) {
      flags.drafts = args[++i];
    } else if (a === "--duration" && i + 1 < args.length) {
      flags.duration = args[++i];
    } else if (a === "--off") {
      flags.off = true;
    } else if (a === "--center-x" && i + 1 < args.length) {
      flags.centerX = parseFloat(args[++i]);
    } else if (a === "--center-y" && i + 1 < args.length) {
      flags.centerY = parseFloat(args[++i]);
    } else if (a === "--size" && i + 1 < args.length) {
      flags.size = parseFloat(args[++i]);
    } else if (a === "--rotation" && i + 1 < args.length) {
      flags.rotation = parseFloat(args[++i]);
    } else if (a === "--feather" && i + 1 < args.length) {
      flags.feather = parseFloat(args[++i]);
    } else if (a === "--invert") {
      flags.invert = true;
    } else if (a === "--rect-width" && i + 1 < args.length) {
      flags.rectWidth = parseFloat(args[++i]);
    } else if (a === "--round-corner" && i + 1 < args.length) {
      flags.roundCorner = parseFloat(args[++i]);
    } else if (a === "--alpha" && i + 1 < args.length) {
      flags.alpha = parseFloat(args[++i]);
    } else if (a === "--vertical") {
      flags.vertical = true;
    } else if (a === "--fixed-width" && i + 1 < args.length) {
      flags.fixedWidth = parseFloat(args[++i]);
    } else if (a === "--fixed-height" && i + 1 < args.length) {
      flags.fixedHeight = parseFloat(args[++i]);
    } else if (a === "--shadow") {
      flags.shadow = true;
    } else if (a === "--no-shadow") {
      flags.shadow = false;
    } else if (a === "--shadow-alpha" && i + 1 < args.length) {
      flags.shadowAlpha = parseFloat(args[++i]);
    } else if (a === "--shadow-angle" && i + 1 < args.length) {
      flags.shadowAngle = parseFloat(args[++i]);
    } else if (a === "--shadow-color" && i + 1 < args.length) {
      flags.shadowColor = args[++i];
    } else if (a === "--shadow-distance" && i + 1 < args.length) {
      flags.shadowDistance = parseFloat(args[++i]);
    } else if (a === "--shadow-smoothing" && i + 1 < args.length) {
      flags.shadowSmoothing = parseFloat(args[++i]);
    } else if (a === "--border-width" && i + 1 < args.length) {
      flags.borderWidth = parseFloat(args[++i]);
    } else if (a === "--border-color" && i + 1 < args.length) {
      flags.borderColor = args[++i];
    } else if (a === "--border-alpha" && i + 1 < args.length) {
      flags.borderAlpha = parseFloat(args[++i]);
    } else if (a === "--bg-color" && i + 1 < args.length) {
      flags.bgColor = args[++i];
    } else if (a === "--bg-alpha" && i + 1 < args.length) {
      flags.bgAlpha = parseFloat(args[++i]);
    } else if (a === "--bg-style" && i + 1 < args.length) {
      flags.bgStyle = parseInt(args[++i], 10);
    } else if (a === "--bg-round-radius" && i + 1 < args.length) {
      flags.bgRoundRadius = parseFloat(args[++i]);
    } else if (a === "--bg-width" && i + 1 < args.length) {
      flags.bgWidth = parseFloat(args[++i]);
    } else if (a === "--bg-height" && i + 1 < args.length) {
      flags.bgHeight = parseFloat(args[++i]);
    } else if (a === "--bg-h-offset" && i + 1 < args.length) {
      flags.bgHOffset = parseFloat(args[++i]);
    } else if (a === "--bg-v-offset" && i + 1 < args.length) {
      flags.bgVOffset = parseFloat(args[++i]);
    } else if (a === "--intro" && i + 1 < args.length) {
      flags.intro = args[++i];
    } else if (a === "--outro" && i + 1 < args.length) {
      flags.outro = args[++i];
    } else if (a === "--intro-duration" && i + 1 < args.length) {
      flags.introDuration = args[++i];
    } else if (a === "--outro-duration" && i + 1 < args.length) {
      flags.outroDuration = args[++i];
    } else if (a === "--combo" && i + 1 < args.length) {
      flags.combo = args[++i];
    } else if (a === "--combo-duration" && i + 1 < args.length) {
      flags.comboDuration = args[++i];
    } else if (a === "--scale" && i + 1 < args.length) {
      flags.scale = parseFloat(args[++i]);
    } else if (a === "--resource-id" && i + 1 < args.length) {
      flags.resourceId = args[++i];
    } else if (a === "--params" && i + 1 < args.length) {
      flags.params = args[++i];
    } else if (a === "--style-ref" && i + 1 < args.length) {
      flags.styleRef = args[++i];
    } else if (a === "--time-offset" && i + 1 < args.length) {
      flags.timeOffset = args[++i];
    } else if (a === "--font" && i + 1 < args.length) {
      flags.font = args[++i];
    } else if ((a === "--in" || a === "--fade-in") && i + 1 < args.length) {
      flags.fadeIn = args[++i];
    } else if (a === "--fade-out" && i + 1 < args.length) {
      flags.fadeOut = args[++i];
    } else if (a === "--time" && i + 1 < args.length) {
      flags.time = args[++i];
    } else if (a === "--bubble" && i + 1 < args.length) {
      flags.bubble = args[++i];
    } else if (a === "--effect-id" && i + 1 < args.length) {
      flags.effectId = args[++i];
    } else if (a === "--bubbles") {
      flags.bubbles = true;
    } else if (a === "--jianying") {
      flags.jianying = true;
    } else if (a === "--styles" && i + 1 < args.length) {
      flags.styles = args[++i];
    } else if (a === "--preset" && i + 1 < args.length) {
      flags.preset = args[++i];
    } else if (a === "--force-license") {
      flags.forceLicense = true;
    } else if (a === "--max-chars" && i + 1 < args.length) {
      flags.maxChars = parseInt(args[++i], 10);
    } else if (a === "--max-cue-secs" && i + 1 < args.length) {
      flags.maxCueSecs = parseFloat(args[++i]);
    } else if (a === "--min-gap-ms" && i + 1 < args.length) {
      flags.minGapMs = parseFloat(args[++i]);
    } else if (a === "--no-check-paths") {
      flags.noCheckPaths = true;
    } else if (a === "--fix") {
      flags.fix = true;
    } else if (a === "--audio" && i + 1 < args.length) {
      flags.audio = args[++i];
    } else if (a === "--from-segment" && i + 1 < args.length) {
      flags.fromSegment = args[++i];
    } else if (a === "--whisper-cmd" && i + 1 < args.length) {
      flags.whisperCmd = args[++i];
    } else if (a === "--whisper-engine" && i + 1 < args.length) {
      const engine = args[++i];
      if (!["auto", "openai", "whisper-cpp", "faster-whisper"].includes(engine)) {
        throw new Error("--whisper-engine must be auto|openai|whisper-cpp|faster-whisper");
      }
      flags.whisperEngine = engine as Flags["whisperEngine"];
    } else if (a === "--whisper-model" && i + 1 < args.length) {
      flags.whisperModel = args[++i];
    } else if (a === "--language" && i + 1 < args.length) {
      flags.language = args[++i];
    } else if (a === "--karaoke") {
      flags.karaoke = true;
    } else if (a === "--max-words" && i + 1 < args.length) {
      flags.maxWords = parseInt(args[++i], 10);
    } else if (a === "--max-gap-ms" && i + 1 < args.length) {
      flags.maxGapMs = parseFloat(args[++i]);
    } else if (a === "--highlight-words" && i + 1 < args.length) {
      flags.highlightWords = args[++i];
    } else if (a === "--keyword-color" && i + 1 < args.length) {
      flags.keywordColor = args[++i];
    } else if (a === "--keyword-size" && i + 1 < args.length) {
      flags.keywordSize = parseFloat(args[++i]);
    } else if (a === "--color-cycle" && i + 1 < args.length) {
      flags.colorCycle = args[++i];
    } else if (a === "--no-probe") {
      flags.noProbe = true;
    } else if (a === "--granularity" && i + 1 < args.length) {
      const granularity = args[++i];
      if (!["line", "word"].includes(granularity)) {
        throw new Error("--granularity must be line|word");
      }
      flags.granularity = granularity as Flags["granularity"];
    } else if (a === "--format" && i + 1 < args.length) {
      const format = args[++i];
      if (!["srt", "vtt"].includes(format)) {
        throw new Error("--format must be srt|vtt");
      }
      flags.format = format as Flags["format"];
    } else if (a === "--ffprobe-cmd" && i + 1 < args.length) {
      flags.ffprobeCmd = args[++i];
    } else if (a === "--video" && i + 1 < args.length) {
      flags.video = args[++i];
    } else if (a === "--srt" && i + 1 < args.length) {
      flags.srt = args[++i];
    } else if (a === "--retime") {
      flags.retime = true;
    } else if (a === "--to" && i + 1 < args.length) {
      flags.to = args[++i];
    } else if (a === "--from" && i + 1 < args.length) {
      flags.from = args[++i];
    } else if (a === "--api-key" && i + 1 < args.length) {
      flags.apiKey = args[++i];
    } else if (a === "--model" && i + 1 < args.length) {
      flags.model = args[++i];
    } else if (a === "--dry-run") {
      flags.dryRun = true;
    } else if (a === "--intensity" && i + 1 < args.length) {
      flags.intensity = parseFloat(args[++i]);
    } else if (a === "--app" && i + 1 < args.length) {
      flags.app = args[++i];
    } else if (a === "--queue" && i + 1 < args.length) {
      flags.queue = args[++i];
    } else if (a === "--fail-fast") {
      flags.failFast = true;
    } else if (a === "--workers" && i + 1 < args.length) {
      flags.workers = parseInt(args[++i], 10);
    } else if (a === "--retries" && i + 1 < args.length) {
      flags.retries = parseInt(args[++i], 10);
    } else if (a === "--timeout" && i + 1 < args.length) {
      flags.timeoutMs = parseInt(args[++i], 10);
    } else if (a === "--backoff-ms" && i + 1 < args.length) {
      flags.backoffMs = parseInt(args[++i], 10);
    } else if (a === "--max-buffer-mb" && i + 1 < args.length) {
      flags.maxBufferMb = parseFloat(args[++i]);
    } else if (a === "--dir" && i + 1 < args.length) {
      flags.dir = args[++i];
    } else if (a === "--step" && i + 1 < args.length) {
      flags.step = parseInt(args[++i], 10);
    } else if (a === "--list") {
      flags.list = true;
    } else if (a === "--cols" && i + 1 < args.length) {
      flags.cols = parseInt(args[++i], 10);
    } else if (a === "--names") {
      flags.names = true;
    } else if (a === "--fps" && i + 1 < args.length) {
      flags.fps = parseFloat(args[++i]);
    } else if (a === "--ffmpeg-cmd" && i + 1 < args.length) {
      flags.ffmpegCmd = args[++i];
    } else if (a === "--burn-captions") {
      flags.burnCaptions = true;
    } else if (a === "--all-video-tracks") {
      flags.allVideoTracks = true;
    } else if (a === "--force-write") {
      flags.forceWrite = true;
    } else if (a === "--bundle" && i + 1 < args.length) {
      flags.bundle = args[++i];
    } else if (a === "--continue-on-error") {
      flags.continueOnError = true;
    } else if (a === "--check") {
      flags.check = true;
    } else if (a === "--plan") {
      flags.plan = true;
    } else if (a === "--apply") {
      flags.apply = true;
    } else if (a === "--threshold" && i + 1 < args.length) {
      flags.threshold = parseFloat(args[++i]);
    } else if (a === "--min-gap" && i + 1 < args.length) {
      flags.minGap = parseFloat(args[++i]);
    } else if (a === "--limit" && i + 1 < args.length) {
      flags.limit = parseInt(args[++i], 10);
    } else if (a === "--json") {
      flags.json = true;
    } else if (a === "--ratio" && i + 1 < args.length) {
      flags.ratio = args[++i];
    } else if (a === "--rect" && i + 1 < args.length) {
      flags.rect = args[++i];
    } else if (a === "--reset") {
      flags.reset = true;
    } else if (a === "--new-track") {
      flags.newTrack = true;
    } else {
      const hit = ENUM_FLAG_MAP.find((f) => f.flag === a);
      if (hit) {
        flags.enumCategory = hit.category;
      } else positional.push(a);
    }
  }
  return { positional, flags };
}

// --- Output ---

function out(data: unknown, flags: Flags): void {
  if (flags.quiet) return;
  // In --dry-run, stamp an object result with dryRun:true so callers can tell a
  // preview from a committed write. Arrays (read commands) are left untouched.
  let payload = data;
  if (isDryRun() && data !== null && typeof data === "object" && !Array.isArray(data)) {
    payload = { ...(data as Record<string, unknown>), dryRun: true };
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

class CliError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CliError";
  }
}

function die(msg: string): never {
  throw new CliError(msg);
}

function requireArgs(args: string[], min: number, usage: string): void {
  if (args.length < min) die(`Missing arguments. Usage: ${usage}`);
}

// --- Commands ---

function cmdInfo(draft: Draft, flags: Flags): void {
  const totalSegments = draft.tracks.reduce((n, t) => n + t.segments.length, 0);
  const matTypes = getMaterialTypes(draft);
  const matWithItems = matTypes.filter((m) => m.count > 0);
  const data = {
    id: draft.id,
    name: draft.name || draft.id,
    duration_us: draft.duration,
    fps: draft.fps,
    width: draft.canvas_config.width,
    height: draft.canvas_config.height,
    ratio: draft.canvas_config.ratio,
    tracks: draft.tracks.length,
    segments: totalSegments,
    platform: draft.platform
      ? `${draft.platform.app_source === "cc" ? "CapCut" : "JianYing"} ${draft.platform.app_version}`
      : null,
    material_types: matTypes.length,
    materials_with_items: matWithItems.length,
    material_summary: matWithItems.map((m) => ({ type: m.type, count: m.count })),
  };
  if (flags.human) {
    const d = data;
    console.log(`Project:    ${d.name}`);
    console.log(`Duration:   ${formatDuration(d.duration_us)}`);
    console.log(`Resolution: ${d.width}x${d.height} (${d.ratio})`);
    console.log(`FPS:        ${d.fps}`);
    console.log(`Tracks:     ${d.tracks}`);
    console.log(`Segments:   ${d.segments}`);
    if (d.platform) console.log(`Platform:   ${d.platform}`);
    console.log(`Materials:  ${d.materials_with_items} types with data (${d.material_types} total)`);
    for (const m of d.material_summary) {
      console.log(`  ${m.type.padEnd(28)} ${m.count}`);
    }
  } else {
    out(data, flags);
  }
}

function cmdTracks(draft: Draft, flags: Flags): void {
  const data = draft.tracks.map((t, i) => {
    const end = t.segments.reduce((max, s) => {
      const e = s.target_timerange.start + s.target_timerange.duration;
      return e > max ? e : max;
    }, 0);
    return {
      index: i,
      id: t.id,
      type: t.type,
      name: t.name,
      segments: t.segments.length,
      duration_us: end,
      muted: !!(t.attribute & 1),
      hidden: !!(t.attribute & 2),
      locked: !!(t.attribute & 4),
    };
  });
  if (flags.human) {
    console.log(`#   Type     Name           Segs    Duration`);
    for (const t of data) {
      const fl: string[] = [];
      if (t.muted) fl.push("muted");
      if (t.hidden) fl.push("hidden");
      if (t.locked) fl.push("locked");
      console.log(
        `${String(t.index).padStart(2)}  ${t.type.padEnd(8)} ${t.name.padEnd(14)} ${String(t.segments).padStart(4)} segs  ${formatDuration(t.duration_us).padStart(10)}${fl.length ? `  [${fl.join(",")}]` : ""}`,
      );
    }
  } else {
    out(data, flags);
  }
}

function segmentData(draft: Draft, track: Track, seg: Segment) {
  const t = seg.target_timerange;
  let label = "";
  if (track.type === "text") {
    const mat = findMaterial(draft.materials.texts, seg.material_id);
    if (mat) label = extractText(mat.content);
  } else if (track.type === "video") {
    const mat = findMaterial(draft.materials.videos, seg.material_id);
    if (mat) label = mat.material_name;
  } else if (track.type === "audio") {
    const mat = findMaterial(draft.materials.audios, seg.material_id);
    if (mat) label = mat.name || "";
  }
  return {
    id: seg.id,
    type: track.type,
    start_us: t.start,
    duration_us: t.duration,
    speed: seg.speed,
    volume: seg.volume,
    opacity: seg.clip?.alpha ?? 1,
    label,
  };
}

function cmdSegments(draft: Draft, flags: Flags): void {
  const tracks = flags.track ? getTracksByType(draft, flags.track) : draft.tracks;
  if (tracks.length === 0) die(`No tracks of type "${flags.track}"`);
  const data = tracks.flatMap((track) => track.segments.map((seg) => segmentData(draft, track, seg)));
  if (flags.human) {
    console.log(`ID        Type   Start   -End         Dur   Spd  Label`);
    for (const s of data) {
      const end = s.start_us + s.duration_us;
      console.log(
        `${s.id.slice(0, 8)}  ${s.type.padEnd(6)} ${formatTime(s.start_us).padStart(8)}-${formatTime(end).padStart(8)}  ${formatDuration(s.duration_us).padStart(8)}  ${s.speed !== 1 ? `${s.speed}x` : "   "}  ${s.label.slice(0, 40)}`,
      );
    }
  } else {
    out(data, flags);
  }
}

function cmdTexts(draft: Draft, flags: Flags): void {
  const textTracks = getTracksByType(draft, "text");
  const data = textTracks.flatMap((track) =>
    track.segments.map((seg) => {
      const resolved = resolveSegmentTextMaterial(draft, seg);
      const mat = resolved?.material ?? null;
      const t = seg.target_timerange;
      return {
        id: seg.id,
        start_us: t.start,
        duration_us: t.duration,
        text: mat ? extractText(mat.content) : "",
        ...(resolved?.viaTemplate ? { text_material_id: mat?.id ?? null, template_material_id: seg.material_id } : {}),
      };
    }),
  );
  if (flags.human) {
    if (data.length === 0) {
      console.log("No text segments found.");
      return;
    }
    console.log(`ID        Start   -End       Text`);
    for (const s of data) {
      console.log(
        `${s.id.slice(0, 8)}  ${formatTime(s.start_us).padStart(8)}-${formatTime(s.start_us + s.duration_us).padStart(8)}  ${s.text}`,
      );
    }
  } else {
    out(data, flags);
  }
}

function resolveSegmentTextMaterial(
  draft: Draft,
  seg: Segment,
): { material: MaterialText; viaTemplate: boolean } | null {
  const direct = findMaterial(draft.materials.texts, seg.material_id);
  if (direct) return { material: direct, viaTemplate: false };

  // CapCut 8.9+ caption templates put the segment on a text track but point its
  // material_id at materials.text_templates[]. The actual editable text lives
  // behind text_info_resources[].text_material_id in materials.texts[].
  const templates = draft.materials.text_templates;
  if (!Array.isArray(templates)) return null;
  const template = findMaterial(templates as Array<{ id: string }>, seg.material_id) as Record<string, unknown> | null;
  if (!template) return null;
  const resources = template.text_info_resources;
  if (!Array.isArray(resources)) return null;
  for (const resource of resources) {
    if (!resource || typeof resource !== "object") continue;
    const textMaterialId = (resource as Record<string, unknown>).text_material_id;
    if (typeof textMaterialId !== "string") continue;
    const nested = findMaterial(draft.materials.texts, textMaterialId);
    if (nested) return { material: nested, viaTemplate: true };
  }
  return null;
}

function cmdSetText(draft: Draft, filePath: string, segId: string, newText: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const resolved = resolveSegmentTextMaterial(draft, result.segment);
  const mat = resolved?.material;
  if (!mat) die(`Text material not found for segment ${segId} (including nested caption-template text)`);
  const oldText = extractText(mat.content);
  mat.content = updateTextContent(mat.content, newText);
  if (typeof mat.base_content === "string") mat.base_content = updateTextContent(mat.base_content, newText);
  if (typeof mat.recognize_text === "string") mat.recognize_text = newText;
  if (save) saveDraft(filePath, draft);
  out(
    {
      ok: true,
      id: result.segment.id,
      old: oldText,
      new: newText,
      ...(resolved?.viaTemplate ? { text_material_id: mat.id, template_material_id: result.segment.material_id } : {}),
    },
    flags,
  );
}

function cmdShift(draft: Draft, filePath: string, segId: string, offsetStr: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const offset = parseTimeInput(offsetStr);
  const seg = result.segment;
  const oldStart = seg.target_timerange.start;
  seg.target_timerange.start = Math.max(0, oldStart + offset);
  if (save) saveDraft(filePath, draft);
  out({ ok: true, id: seg.id, old_start_us: oldStart, new_start_us: seg.target_timerange.start }, flags);
}

function cmdShiftAll(draft: Draft, filePath: string, offsetStr: string, flags: Flags, save = true): void {
  const offset = parseTimeInput(offsetStr);
  const tracks = flags.track ? getTracksByType(draft, flags.track) : draft.tracks;
  let count = 0;
  for (const track of tracks) {
    for (const seg of track.segments) {
      seg.target_timerange.start = Math.max(0, seg.target_timerange.start + offset);
      count++;
    }
  }
  if (save) saveDraft(filePath, draft);
  out({ ok: true, shifted: count, offset_us: offset }, flags);
}

function cmdSpeed(draft: Draft, filePath: string, segId: string, multiplier: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const speed = parseFloat(multiplier);
  if (Number.isNaN(speed) || speed <= 0) die("Speed must be a positive number");
  const seg = result.segment;
  const oldSpeed = seg.speed;
  seg.speed = speed;
  seg.source_timerange.duration = Math.round(seg.target_timerange.duration * speed);
  for (const refId of seg.extra_material_refs) {
    const speedMat = findMaterial(draft.materials.speeds, refId);
    if (speedMat) speedMat.speed = speed;
  }
  if (save) saveDraft(filePath, draft);
  out({ ok: true, id: seg.id, old_speed: oldSpeed, new_speed: speed }, flags);
}

function cmdVolume(draft: Draft, filePath: string, segId: string, levelStr: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const level = parseFloat(levelStr);
  if (Number.isNaN(level) || level < 0) die("Volume must be >= 0");
  const old = result.segment.volume;
  result.segment.volume = level;
  if (save) saveDraft(filePath, draft);
  out({ ok: true, id: result.segment.id, old_volume: old, new_volume: level }, flags);
}

function cmdTrim(
  draft: Draft,
  filePath: string,
  segId: string,
  startStr: string,
  durationStr: string,
  flags: Flags,
  save = true,
): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const start = parseTimeInput(startStr);
  const duration = parseTimeInput(durationStr);
  const seg = result.segment;
  seg.source_timerange.start = start;
  seg.source_timerange.duration = duration;
  seg.target_timerange.duration = Math.round(duration / seg.speed);
  if (save) saveDraft(filePath, draft);
  out(
    {
      ok: true,
      id: seg.id,
      source_start_us: start,
      source_duration_us: duration,
      target_duration_us: seg.target_timerange.duration,
    },
    flags,
  );
}

function cmdOpacity(draft: Draft, filePath: string, segId: string, alphaStr: string, flags: Flags, save = true): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const alpha = parseFloat(alphaStr);
  if (Number.isNaN(alpha) || alpha < 0 || alpha > 1) die("Opacity must be 0.0-1.0");
  if (!result.segment.clip) die(`Segment ${segId} has no clip (audio segment?)`);
  const old = result.segment.clip.alpha;
  result.segment.clip.alpha = alpha;
  if (save) saveDraft(filePath, draft);
  out({ ok: true, id: result.segment.id, old_opacity: old, new_opacity: alpha }, flags);
}

function cmdExportSrt(draft: Draft, flags: Flags): void {
  const granularity = flags.granularity ?? "line";
  const format = flags.format ?? "srt";
  const textTracks = getTracksByType(draft, "text");
  const cues: SegmentCue[] = [];
  for (const track of textTracks) {
    const entries: SegmentCue[] = [];
    for (const seg of track.segments) {
      const mat = findMaterial(draft.materials.texts, seg.material_id);
      if (!mat) continue;
      const t = seg.target_timerange;
      entries.push({
        startUs: t.start,
        endUs: t.start + t.duration,
        text: extractText(mat.content),
        styleRanges: extractStyleRanges(mat.content),
      });
    }
    // Word granularity: karaoke runs (one word-timed segment per word) carry
    // real word timings; other cues fall back to length-weighted interpolation.
    if (granularity === "word") cues.push(...collapseKaraokeRuns(entries));
    else cues.push(...entries);
  }
  cues.sort((a, b) => a.startUs - b.startUs);
  if (format === "vtt") {
    process.stdout.write(renderVtt(cues, granularity === "word"));
  } else if (granularity === "word") {
    const words = cues.flatMap((c) => cueWords(c).map((w) => ({ startUs: w.startUs, endUs: w.endUs, text: w.word })));
    process.stdout.write(renderSrt(words));
  } else {
    process.stdout.write(renderSrt(cues));
  }
}

// --- Discovery & drill-down ---

function cmdMaterials(draft: Draft, flags: Flags): void {
  const matTypes = getMaterialTypes(draft);
  if (flags.track) {
    // --type filter: list items of that material type
    const key = flags.track; // reuse --track flag as --type
    const arr = draft.materials[key];
    if (!arr || !Array.isArray(arr)) die(`Unknown material type: ${key}`);
    const items = arr.map((m: Record<string, unknown>) => {
      const summary: Record<string, unknown> = { id: m.id };
      if (m.name !== undefined) summary.name = m.name;
      if (m.material_name !== undefined) summary.name = m.material_name;
      if (m.path !== undefined) summary.path = m.path;
      if (m.duration !== undefined) summary.duration_us = m.duration;
      if (m.type !== undefined) summary.type = m.type;
      summary.fields = Object.keys(m).length;
      return summary;
    });
    if (flags.human) {
      if (items.length === 0) {
        console.log(`No ${key} materials.`);
        return;
      }
      console.log(`ID        Name/Path                                    Fields`);
      for (const item of items) {
        const label = (item.name || item.path || "") as string;
        console.log(
          `${(item.id as string).slice(0, 8)}  ${label.slice(0, 44).padEnd(44)} ${String(item.fields).padStart(3)}`,
        );
      }
    } else {
      out(items, flags);
    }
    return;
  }
  if (flags.human) {
    console.log(`Type                          Count`);
    for (const m of matTypes) {
      console.log(`${m.type.padEnd(28)} ${String(m.count).padStart(5)}`);
    }
  } else {
    out(matTypes, flags);
  }
}

function cmdSegmentDetail(draft: Draft, segId: string, flags: Flags): void {
  const result = findSegment(draft, segId);
  if (!result) die(`Segment not found: ${segId}`);
  const seg = result.segment;
  // Resolve the primary material
  const mat = findMaterialGlobal(draft, seg.material_id);
  const detail = {
    ...seg,
    _track_type: result.track.type,
    _track_name: result.track.name,
    _track_id: result.track.id,
    _material: mat ? { _type: mat.type, ...mat.material } : null,
  };
  if (flags.human) {
    console.log(JSON.stringify(detail, null, 2));
  } else {
    out(detail, flags);
  }
}

function cmdMaterialDetail(draft: Draft, matId: string, flags: Flags): void {
  const result = findMaterialGlobal(draft, matId);
  if (!result) die(`Material not found: ${matId}`);
  const detail = { _type: result.type, ...result.material };
  if (flags.human) {
    console.log(JSON.stringify(detail, null, 2));
  } else {
    out(detail, flags);
  }
}

// --- Add commands ---

async function cmdAddAudio(draft: Draft, filePath: string, positional: string[], flags: Flags): Promise<void> {
  const audioPath = positional[2];
  const startStr = positional[3];
  const durationStr = positional[4];
  if (!audioPath || !startStr) die("Usage: capcut add-audio <project> <file-or-wikimedia-url> <start> [duration]");
  // Wikimedia URLs go through the license-gated fetcher; locals pass through.
  const { localPath, asset, warning } = await resolveAssetPath(audioPath, filePath, "audio", flags.forceLicense);
  const absPath = path.resolve(localPath);
  const start = parseTimeInput(startStr);
  const media = flags.noProbe ? null : probeMedia(absPath, flags.ffprobeCmd);
  const duration = durationStr ? parseTimeInput(durationStr) : media?.durationUs;
  if (!duration || duration <= 0) {
    die("Audio duration was omitted and ffprobe could not determine it. Pass duration explicitly or install ffprobe.");
  }
  if (durationStr && media?.durationUs && duration > media.durationUs + 10_000) {
    die(`Requested duration ${duration}us exceeds source duration ${media.durationUs}us.`);
  }
  const opts: AddAudioOptions = {
    path: absPath,
    start,
    duration,
    volume: flags.volume,
    trackName: flags.trackName,
  };
  const result = addAudio(draft, filePath, opts);
  saveDraft(filePath, draft);
  const payload: Record<string, unknown> = {
    ok: true,
    segment_id: result.segmentId,
    material_id: result.materialId,
    track_id: result.trackId,
    path: absPath,
    start_us: start,
    duration_us: duration,
    duration_source: durationStr ? "argument" : "ffprobe",
    media_probe: media,
  };
  if (asset) {
    payload.wikimedia = {
      file_title: asset.fileTitle,
      license: asset.license.raw,
      license_class: asset.license.class,
      artist: asset.license.artist,
      credit: asset.license.credit,
      description_url: asset.descriptionUrl,
    };
  }
  if (warning) payload.warning = warning;
  out(payload, flags);
}

async function cmdAddVideo(draft: Draft, filePath: string, positional: string[], flags: Flags): Promise<void> {
  const videoPath = positional[2];
  const startStr = positional[3];
  const durationStr = positional[4];
  if (!videoPath || !startStr) die("Usage: capcut add-video <project> <file-or-wikimedia-url> <start> [duration]");
  const { localPath, asset, warning } = await resolveAssetPath(videoPath, filePath, "video", flags.forceLicense);
  const absPath = path.resolve(localPath);
  const start = parseTimeInput(startStr);
  const extension = path.extname(absPath).slice(1).toLowerCase();
  const isPhoto = ["jpg", "jpeg", "png", "webp", "bmp", "tiff"].includes(extension);
  const media = flags.noProbe ? null : probeMedia(absPath, flags.ffprobeCmd);
  // ffprobe often reports a single image as a very short video stream. A
  // photo's timeline duration is user-authored, so never infer or cap it from
  // that synthetic stream duration.
  const duration = durationStr ? parseTimeInput(durationStr) : isPhoto ? undefined : media?.durationUs;
  if (!duration || duration <= 0) {
    die("Video duration was omitted and ffprobe could not determine it. Photos still require an explicit duration.");
  }
  if (!isPhoto && durationStr && media?.durationUs && duration > media.durationUs + 10_000) {
    die(`Requested duration ${duration}us exceeds source duration ${media.durationUs}us.`);
  }

  // Resolve the source dimensions. Explicit --width/--height always win; otherwise
  // probe the file with ffprobe (best-effort) so portrait sources are not forced
  // into the 1920x1080 landscape default. If neither is available, addVideo falls
  // back to 1920x1080 and we surface a warning so the user can override.
  let width = flags.width;
  let height = flags.height;
  let dimensionSource = width && height ? "flags" : "default";
  let dimensionWarning: string | undefined;
  if (!(width && height)) {
    if (media?.width && media.height) {
      width = media.width;
      height = media.height;
      dimensionSource = "ffprobe";
    } else {
      dimensionWarning =
        "Could not detect dimensions (ffprobe unavailable or failed); defaulted to 1920x1080. Pass --width/--height to override.";
    }
  }

  const opts: AddVideoOptions = {
    path: absPath,
    start,
    duration,
    trackName: flags.trackName,
    width,
    height,
  };
  const result = addVideo(draft, filePath, opts);
  saveDraft(filePath, draft);
  const payload: Record<string, unknown> = {
    ok: true,
    segment_id: result.segmentId,
    material_id: result.materialId,
    track_id: result.trackId,
    path: absPath,
    start_us: start,
    duration_us: duration,
    duration_source: durationStr ? "argument" : "ffprobe",
    width: width ?? 1920,
    height: height ?? 1080,
    dimension_source: dimensionSource,
    media_probe: media,
  };
  if (asset) {
    payload.wikimedia = {
      file_title: asset.fileTitle,
      license: asset.license.raw,
      license_class: asset.license.class,
      artist: asset.license.artist,
      credit: asset.license.credit,
      description_url: asset.descriptionUrl,
      width: asset.width,
      height: asset.height,
      mime: asset.mime,
    };
  }
  const warnings = [warning, dimensionWarning].filter(Boolean);
  if (warnings.length) payload.warning = warnings.join(" ");
  out(payload, flags);
}

// Explicit CLI flags beat preset values: stamp the flag values over a clone of
// the preset before applying, so the apply step is the single writer.
function presetWithFlagOverrides(preset: TextStylePreset, flags: Flags): TextStylePreset {
  const p = structuredClone(preset);
  if (flags.fontSize !== undefined) p.style.font_size = flags.fontSize;
  if (flags.color !== undefined) p.style.text_color = flags.color;
  if (flags.align !== undefined) p.style.alignment = flags.align;
  if (p.transform) {
    if (flags.x !== undefined) p.transform.x = flags.x;
    if (flags.y !== undefined) p.transform.y = flags.y;
  }
  // --color / --font-size cover the whole cue, so they must also win over any
  // preset text_ranges (karaoke/highlight blocks). Otherwise applyTextPreset's
  // setTextRanges pass runs LAST and re-stamps the preset's per-range colours
  // and sizes over the flag values just mirrored into styles[0] — silently
  // defeating the documented "explicit flags override preset values" contract.
  if (p.text_ranges && p.text_ranges.length > 0) {
    for (const r of p.text_ranges) {
      if (flags.color !== undefined) r.font_color = flags.color;
      if (flags.fontSize !== undefined) r.font_size = flags.fontSize;
    }
  }
  return p;
}

function cmdAddText(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const startStr = positional[2];
  const durationStr = positional[3];
  const text = positional.slice(4).join(" ");
  if (!text) die("Missing text. Usage: capcut add-text <project> <start> <duration> <text>");
  const preset = flags.preset ? loadPresetFile(flags.preset) : null;
  const start = parseTimeInput(startStr);
  const duration = parseTimeInput(durationStr);
  const opts: AddTextOptions = {
    text,
    start,
    duration,
    fontSize: flags.fontSize,
    color: flags.color,
    alignment: flags.align,
    x: flags.x,
    y: flags.y,
    trackName: flags.trackName,
  };
  const result = addText(draft, filePath, opts);
  if (preset) applyTextPreset(draft, result.segmentId, presetWithFlagOverrides(preset, flags));
  saveDraft(filePath, draft);
  out(
    {
      ok: true,
      segment_id: result.segmentId,
      material_id: result.materialId,
      track_id: result.trackId,
      text,
      start_us: start,
      duration_us: duration,
      ...(flags.preset ? { preset: flags.preset } : {}),
    },
    flags,
  );
}

function cmdKeyframe(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  if (!segId) die("Usage: capcut keyframe <project> <id> <property> <time> <value>  (or --batch with JSONL on stdin)");

  const inputs: KeyframeInput[] = [];

  if (flags.batch) {
    const raw = stripBom(readFileSync(0, "utf-8")).trim();
    if (!raw) die("No input on stdin for --batch");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const op = JSON.parse(trimmed) as {
        property?: string;
        time?: string | number;
        value?: string | number;
        easing?: string;
      };
      if (!op.property || op.time === undefined || op.value === undefined) {
        die(`batch keyframe requires {property, time, value} per line; got: ${trimmed}`);
      }
      const timeUs = typeof op.time === "number" ? op.time : parseTimeInput(op.time);
      const value = parseKeyframeValue(op.property, String(op.value));
      inputs.push({ property: op.property, timeUs, value, easing: op.easing });
    }
  } else {
    const property = positional[3];
    const timeStr = positional[4];
    const valueStr = positional[5];
    if (!property || !timeStr || valueStr === undefined) {
      die(
        `Usage: capcut keyframe <project> <id> <property> <time> <value>\nProperties: ${keyframeProperties().join(", ")}`,
      );
    }
    const timeUs = parseTimeInput(timeStr);
    const value = parseKeyframeValue(property, valueStr);
    inputs.push({ property, timeUs, value });
  }

  const result = addKeyframes(draft, segId, inputs, flags.easing);
  saveDraft(filePath, draft);
  for (const warning of result.warnings) process.stderr.write(`Warning: ${warning}\n`);
  out(
    {
      ok: true,
      id: result.segmentId,
      added: result.added,
      lists: result.lists,
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
    },
    flags,
  );
}

function cmdTransition(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  const slug = positional[3];
  const ns: Namespace = flags.jianying ? "jianying" : "capcut";
  if (!segId || !slug)
    die(
      `Usage: capcut transition <project> <id> <slug> [--duration <s>] [--jianying]\nSlugs: capcut enums --transitions${ns === "jianying" ? " --jianying" : ""}`,
    );
  const durUs = flags.duration ? parseTimeInput(flags.duration) : undefined;
  const result = addTransition(draft, segId, slug, durUs, ns);
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

function cmdMask(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  const slug = positional[3];
  const ns: Namespace = flags.jianying ? "jianying" : "capcut";
  if (!segId) die(`Usage: capcut mask <project> <id> <slug> [flags]  |  --off\nSlugs: ${maskSlugs(ns).join(", ")}`);
  if (flags.off) {
    const found = findSegment(draft, segId);
    if (!found) die(`Segment not found: ${segId}`);
    const seg = found.segment;
    const masksArr = (draft.materials.common_mask || []) as Array<Record<string, unknown>>;
    const before = (seg.extra_material_refs || []).length;
    seg.extra_material_refs = (seg.extra_material_refs || []).filter(
      (r) => !masksArr.some((m) => (m as { id?: string }).id === r),
    );
    saveDraft(filePath, draft);
    out({ ok: true, id: seg.id, removed: before - (seg.extra_material_refs || []).length }, flags);
    return;
  }
  if (!slug) die(`Usage: capcut mask <project> <id> <slug> [flags]\nSlugs: ${maskSlugs(ns).join(", ")}`);
  const opts: MaskOptions = {
    centerX: flags.centerX,
    centerY: flags.centerY,
    size: flags.size,
    rotation: flags.rotation,
    feather: flags.feather,
    invert: flags.invert,
    rectWidth: flags.rectWidth,
    roundCorner: flags.roundCorner,
  };
  const result = addMask(draft, segId, slug, opts, ns);
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

function cmdBgBlur(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  const arg = positional[3];
  if (!segId) die(`Usage: capcut bg-blur <project> <id> <1|2|3|4>  |  --off`);
  let level: 1 | 2 | 3 | 4 | "off";
  if (flags.off) level = "off";
  else {
    const n = parseInt(arg ?? "", 10);
    if (![1, 2, 3, 4].includes(n)) die(`bg-blur level must be 1, 2, 3, or 4 (or --off)`);
    level = n as 1 | 2 | 3 | 4;
  }
  const result = setBgBlur(draft, segId, level);
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

function cmdTextStyle(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  if (!segId) die(`Usage: capcut text-style <project> <id> [flags]`);
  const opts: TextStyleOptions = {
    alpha: flags.alpha,
    vertical: flags.vertical,
    fixedWidth: flags.fixedWidth,
    fixedHeight: flags.fixedHeight,
    shadow: flags.shadow,
    shadowAlpha: flags.shadowAlpha,
    shadowAngle: flags.shadowAngle,
    shadowColor: flags.shadowColor,
    shadowDistance: flags.shadowDistance,
    shadowSmoothing: flags.shadowSmoothing,
    borderWidth: flags.borderWidth,
    borderColor: flags.borderColor,
    borderAlpha: flags.borderAlpha,
    bgColor: flags.bgColor,
    bgAlpha: flags.bgAlpha,
    bgStyle: flags.bgStyle,
    bgRoundRadius: flags.bgRoundRadius,
    bgWidth: flags.bgWidth,
    bgHeight: flags.bgHeight,
    bgHOffset: flags.bgHOffset,
    bgVOffset: flags.bgVOffset,
  };
  const applied: string[] = [];
  let materialId = "";
  if (flags.preset) {
    const presetResult = applyTextPreset(draft, segId, loadPresetFile(flags.preset));
    materialId = presetResult.materialId;
    applied.push(...presetResult.applied);
  }
  // Explicit flags run after the preset so they override its values.
  const result = setTextStyle(draft, segId, opts);
  materialId = result.materialId;
  applied.push(...result.applied);
  if (applied.length === 0) die(`No styling flags provided. See 'capcut --help'.`);
  saveDraft(filePath, draft);
  out({ ok: true, id: segId, material_id: materialId, applied }, flags);
}

function cmdTextAnim(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  const ns: Namespace = flags.jianying ? "jianying" : "capcut";
  if (!segId)
    die(
      `Usage: capcut text-anim <project> <id> [--intro <slug>] [--outro <slug>] [--jianying]\nFeatured slugs: ${textAnimSlugs().join(", ")}`,
    );
  const opts: TextAnimOptions = {
    intro: flags.intro,
    outro: flags.outro,
    introDurationUs: flags.introDuration ? parseTimeInput(flags.introDuration) : undefined,
    outroDurationUs: flags.outroDuration ? parseTimeInput(flags.outroDuration) : undefined,
  };
  const result = addTextAnim(draft, segId, opts, ns);
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

function cmdAddSticker(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const resId = positional[2];
  const startStr = positional[3];
  const durStr = positional[4];
  if (!resId || !startStr || !durStr)
    die(`Usage: capcut add-sticker <project> <resource-id> <start> <duration> [flags]`);
  const start = parseTimeInput(startStr);
  const duration = parseTimeInput(durStr);
  const result = addSticker(draft, {
    resourceId: resId,
    start,
    duration,
    x: flags.x,
    y: flags.y,
    scale: flags.scale,
    rotation: flags.rotation,
    trackName: flags.trackName,
  });
  saveDraft(filePath, draft);
  out({ ok: true, ...result, start_us: start, duration_us: duration }, flags);
}

function cmdAddEffect(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const slug = positional[2];
  const startStr = positional[3];
  const durStr = positional[4];
  const ns: Namespace = flags.jianying ? "jianying" : "capcut";
  if (!slug || !startStr || !durStr)
    die(
      `Usage: capcut add-effect <project> <slug> <start> <duration> [--params <json-array>] [--jianying]\nFeatured slugs: ${effectSlugs().join(", ")}`,
    );
  const start = parseTimeInput(startStr);
  const duration = parseTimeInput(durStr);
  let params: number[] | undefined;
  if (flags.params) {
    const parsed = JSON.parse(flags.params);
    if (!Array.isArray(parsed)) die(`--params must be a JSON array of numbers`);
    params = parsed.map((v) => Number(v));
  }
  const result = addEffect(draft, { slug, start, duration, params, trackName: flags.trackName, namespace: ns });
  saveDraft(filePath, draft);
  out({ ok: true, ...result, start_us: start, duration_us: duration }, flags);
}

function cmdImageAnim(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  const ns: Namespace = flags.jianying ? "jianying" : "capcut";
  if (!segId)
    die(
      `Usage: capcut image-anim <project> <id> [--intro <slug>] [--outro <slug>] [--combo <slug>] [--jianying]\nFeatured slugs: ${imageAnimSlugs().join(", ")}`,
    );
  const opts: ImageAnimOptions = {
    intro: flags.intro,
    outro: flags.outro,
    combo: flags.combo,
    introDurationUs: flags.introDuration ? parseTimeInput(flags.introDuration) : undefined,
    outroDurationUs: flags.outroDuration ? parseTimeInput(flags.outroDuration) : undefined,
    comboDurationUs: flags.comboDuration ? parseTimeInput(flags.comboDuration) : undefined,
  };
  const result = addImageAnim(draft, segId, opts, ns);
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

function cmdBubbleText(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  if (!segId)
    die(
      `Usage: capcut bubble-text <project> <text-segment-id> --bubble <slug>  [or  --effect-id <id> --resource-id <id>]\nSlugs: ${bubbleSlugs().join(", ")}`,
    );
  if (!flags.bubble && (!flags.effectId || !flags.resourceId)) {
    die(`bubble-text requires either --bubble <slug> or both --effect-id and --resource-id`);
  }
  const result = setBubble(draft, segId, {
    slug: flags.bubble,
    effectId: flags.effectId,
    resourceId: flags.resourceId,
  });
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

function cmdAddFilter(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const slug = positional[2];
  const startStr = positional[3];
  const durStr = positional[4];
  const ns: Namespace = flags.jianying ? "jianying" : "capcut";
  if (!slug || !startStr || !durStr)
    die(
      `Usage: capcut add-filter <project> <slug> <start> <duration> [--track-name <name>] [--jianying]\nFeatured slugs: ${filterSlugs(ns).join(", ")}`,
    );
  const start = parseTimeInput(startStr);
  const duration = parseTimeInput(durStr);
  const result = addFilter(draft, {
    slug,
    start,
    duration,
    trackName: flags.trackName,
    namespace: ns,
  });
  saveDraft(filePath, draft);
  out({ ok: true, ...result, start_us: start, duration_us: duration }, flags);
}

function cmdAddCover(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const imagePath = positional[2];
  if (!imagePath) die(`Usage: capcut add-cover <project> <image-path> [--time <ms>]`);
  const timeMs = flags.time ? parseInt(flags.time, 10) : 0;
  if (!Number.isFinite(timeMs) || timeMs < 0) die(`--time must be a non-negative integer (milliseconds)`);
  const result = setCover(draft, imagePath, timeMs);
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

function cmdAudioFade(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  if (!segId) die(`Usage: capcut audio-fade <project> <segment-id> [--in <sec>] [--fade-out <sec>]`);
  // --out collides with the global output-path flag; users should pass --fade-out
  // for fade-out duration. --in is unambiguous.
  const fadeInUs = flags.fadeIn ? Math.round(parseFloat(flags.fadeIn) * 1_000_000) : 0;
  const fadeOutUs = flags.fadeOut ? Math.round(parseFloat(flags.fadeOut) * 1_000_000) : 0;
  if (fadeInUs <= 0 && fadeOutUs <= 0) {
    die(`audio-fade requires at least one of --in <sec> or --fade-out <sec>`);
  }
  const result = setAudioFade(draft, segId, { fadeInUs, fadeOutUs });
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

function cmdMixMode(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  const mode = positional[3];
  if (!segId || !mode) die(`Usage: capcut mix-mode <project> <segment-id> <mode>\nModes: ${mixModeSlugs().join(", ")}`);
  const result = setMixMode(draft, segId, mode);
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

function cmdCrop(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  if (!segId) die(`Usage: capcut crop <project> <segment-id> [--ratio <r> | --rect <x,y,w,h> | --reset]`);
  // No write flag: read-only — print the material's crop, write nothing.
  if (flags.rect === undefined && flags.ratio === undefined && !flags.reset) {
    out(getCrop(draft, segId), flags);
    return;
  }
  let rect: CropRect;
  if (flags.rect !== undefined) {
    // --rect beats --ratio when both are given.
    const parts = flags.rect.split(",").map((p) => parseFloat(p.trim()));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
      die(`--rect expects four comma-separated numbers: x,y,w,h (got "${flags.rect}")`);
    }
    rect = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  } else if (flags.ratio !== undefined) {
    const info = getCrop(draft, segId);
    rect = cropRectForRatio(info.width ?? 0, info.height ?? 0, flags.ratio);
  } else {
    // --reset: full frame.
    rect = { x: 0, y: 0, w: 1, h: 1 };
  }
  const result = setCrop(draft, segId, rect);
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

function cmdCut(draft: Draft, _filePath: string, positional: string[], flags: Flags): void {
  if (!flags.out) die("Missing --out <path>. Usage: capcut cut <project> <start> <end> --out <path>");
  const start = parseTimeInput(positional[2]);
  const end = parseTimeInput(positional[3]);
  if (end <= start) die("End time must be after start time");
  const opts: CutOptions = { start, end };
  const result = cutProject(draft, opts);
  // Write to new file (not in-place)
  const indent = 0;
  writeFileSync(flags.out, JSON.stringify(draft, null, indent), "utf-8");
  out({ ok: true, kept: result.kept, removed: result.removed, duration_us: end - start, out: flags.out }, flags);
}

function cmdDuplicate(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  if (!segId) die("Usage: capcut duplicate <project> <segment-id> [--track <track-name>] [--new-track]");
  if (flags.track !== undefined && flags.newTrack) {
    die(
      "--track and --new-track are mutually exclusive: --track reuses an existing track, --new-track creates one (the default).",
    );
  }
  const result = duplicateSegment(draft, segId, { trackName: flags.track });
  saveDraft(filePath, draft);
  out(
    {
      ok: true,
      new_segment_id: result.segmentId,
      source_segment_id: result.sourceSegmentId,
      material_id: result.materialId,
      track_id: result.trackId,
      track_name: result.trackName,
      new_track: result.createdTrack,
      cloned_materials: result.clonedMaterials,
    },
    flags,
  );
}

// --- Templates ---

function cmdSaveTemplate(draft: Draft, positional: string[], flags: Flags): void {
  const segId = positional[2];
  const name = positional[3];
  if (!flags.out) die("Missing --out <path>. Usage: capcut save-template <project> <id> <name> --out <path>");
  const template = saveTemplate(draft, segId, name, flags.out);
  out(
    {
      ok: true,
      name: template.name,
      type: template.type,
      material_type: template.material.type,
      extra_materials: template.extra_materials.length,
      out: flags.out,
    },
    flags,
  );
}

function cmdApplyTemplate(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const templatePath = positional[2];
  const startStr = positional[3];
  const durationStr = positional[4];
  const start = parseTimeInput(startStr);
  const duration = parseTimeInput(durationStr);
  const textOverride = positional.length > 5 ? positional.slice(5).join(" ") : undefined;
  const result = applyTemplate(draft, templatePath, start, duration, {
    x: flags.x,
    y: flags.y,
    text: textOverride,
  });
  saveDraft(filePath, draft);
  out(
    {
      ok: true,
      segment_id: result.segmentId,
      material_id: result.materialId,
      track_id: result.trackId,
      start_us: start,
      duration_us: duration,
    },
    flags,
  );
}

// Read-only sibling of save-template: extracts a text segment's styling as a
// portable preset JSON for --preset on add-text / text-style / caption.
function cmdMakePreset(draft: Draft, positional: string[], flags: Flags): void {
  const segId = positional[2];
  if (!flags.out)
    die("Missing --out <path>. Usage: capcut make-preset <project> <text-segment-id> --out <preset.json>");
  const { preset, segmentId, materialId, captured } = extractTextPreset(draft, segId);
  // Honor --dry-run: preview the extraction without touching the preset file
  // (which may be an existing preset the user only meant to inspect).
  const written = !isDryRun();
  if (written) writeFileSync(flags.out, JSON.stringify(preset, null, 2), "utf-8");
  out({ ok: true, segment_id: segmentId, material_id: materialId, captured, out: flags.out, written }, flags);
}

// --- Phase 4: multi-style text ranges ---

function cmdTextRanges(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  if (!segId) die(`Usage: capcut text-ranges <project> <id> --styles @path.json  (or --styles '<inline-json>')`);
  if (!flags.styles) die(`Missing --styles. Accepts @path.json or inline JSON array.`);
  let raw = flags.styles;
  if (raw.startsWith("@")) {
    raw = stripBom(readFileSync(raw.slice(1), "utf-8"));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    die(`--styles is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) die(`--styles must be a JSON array of {start,end,...} ranges`);
  const ranges = parsed as TextRangeInput[];
  const result = setTextRanges(draft, segId, ranges);
  saveDraft(filePath, draft);
  out({ ok: true, ...result }, flags);
}

// --- Phase 3: enums + import-srt ---

function cmdEnums(flags: Flags): void {
  // bubbles ships as a starter catalogue in src/decorators.ts (no enums.json entry).
  if (flags.bubbles) {
    const entries = bubbleCatalogue();
    if (flags.human) {
      console.log(`Slug                              Name                             Member`);
      for (const e of entries) {
        console.log(`${(e.slug || "(non-ascii)").padEnd(33)} ${e.name.slice(0, 32).padEnd(32)} ${e.member}`);
      }
      process.stderr.write(`\n${entries.length} bubbles (capcut)\n`);
    } else {
      out(entries, flags);
    }
    return;
  }
  if (!flags.enumCategory) {
    const flagList = `${ENUM_FLAG_MAP.map((f) => f.flag).join(" | ")} | --bubbles`;
    die(`Usage: capcut enums <flag> [--jianying] [-H]\nFlags: ${flagList}`);
  }
  const ns: Namespace = flags.jianying ? "jianying" : "capcut";
  let entries = listEnum(flags.enumCategory, ns);
  // Capcut namespace lacks filters in the generated enums.json; merge the
  // starter catalogue from src/factory.ts so `enums --filters` is useful.
  if (flags.enumCategory === "filters" && ns === "capcut") {
    entries = [...filterCatalogue(), ...entries];
  }
  if (flags.human) {
    if (entries.length === 0) {
      console.log(`No ${flags.enumCategory} in ${ns} namespace.`);
      return;
    }
    console.log(`Slug                              Name                             Member`);
    for (const e of entries) {
      const display = (e.name ?? e.title ?? "") as string;
      console.log(`${(e.slug || "(non-ascii)").padEnd(33)} ${display.slice(0, 32).padEnd(32)} ${e.member}`);
    }
    process.stderr.write(`\n${entries.length} ${flags.enumCategory} (${ns})\n`);
  } else {
    out(entries, flags);
  }
}

// --- v0.14: keyword emphasis + colour cycling (caption, import-srt) ---

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** --highlight-words value: comma-separated words, or @file with one word/phrase per line. */
function parseHighlightWords(raw: string): string[] {
  const fromFile = raw.startsWith("@");
  const text = fromFile ? stripBom(readFileSync(raw.slice(1), "utf-8")) : raw;
  return (fromFile ? text.split(/\r?\n/) : text.split(","))
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

interface KeywordEmphasisFlags {
  words?: string[];
  color: string;
  size: number;
  cycle?: string[];
}

/** Validate the four emphasis flags once, before any cue is written. */
function keywordEmphasisFromFlags(flags: Flags): KeywordEmphasisFlags {
  if (!flags.highlightWords) {
    if (flags.keywordColor !== undefined) die("--keyword-color requires --highlight-words.");
    if (flags.keywordSize !== undefined) die("--keyword-size requires --highlight-words.");
  }
  const words = flags.highlightWords ? parseHighlightWords(flags.highlightWords) : undefined;
  if (words && words.length === 0) die("--highlight-words is empty. Pass w1,w2,... or @file with one word per line.");
  const color = flags.keywordColor ?? KARAOKE_HIGHLIGHT_COLOR;
  if (!HEX_COLOR_RE.test(color)) die(`--keyword-color must be #RRGGBB (got '${color}').`);
  const size = flags.keywordSize ?? DEFAULT_KEYWORD_SIZE;
  if (!Number.isFinite(size) || size <= 0 || size > 10) {
    die(`--keyword-size must be a multiplier > 0 and <= 10 (got '${flags.keywordSize}').`);
  }
  let cycle: string[] | undefined;
  if (flags.colorCycle !== undefined) {
    cycle = flags.colorCycle
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cycle.length === 0) die("--color-cycle is empty. Pass a comma-separated #RRGGBB list.");
    for (const c of cycle) {
      if (!HEX_COLOR_RE.test(c)) die(`--color-cycle entries must be #RRGGBB (got '${c}').`);
    }
  }
  return { words, color, size, cycle };
}

/** The cue's effective base font size: content styles[0].size after style-ref/flags applied. */
function textBaseFontSize(draft: Draft, materialId: string): number {
  const mat = (draft.materials.texts as unknown as Array<Record<string, unknown>>).find((t) => t.id === materialId);
  try {
    const content = JSON.parse(String(mat?.content)) as { styles?: Array<{ size?: number }> };
    const size = content.styles?.[0]?.size;
    if (typeof size === "number" && Number.isFinite(size)) return size;
  } catch {
    /* fall through */
  }
  const fallback = mat?.font_size;
  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 15;
}

function importCuesToDraft(
  draft: Draft,
  filePath: string,
  cues: Array<{ index: number; startUs: number; endUs: number; text: string }>,
  flags: Flags,
  label: string,
): void {
  const offsetUs = flags.timeOffset ? parseTimeInput(flags.timeOffset) : 0;

  // Resolve the style-ref segment once, before writing anything, so a bad ref
  // fails fast instead of halfway through a 200-cue import.
  if (flags.styleRef) {
    const ref = findSegment(draft, flags.styleRef);
    if (!ref) die(`Style-ref segment not found: ${flags.styleRef}`);
  }

  const styleOpts: TextStyleOptions = {
    alpha: flags.alpha,
    vertical: flags.vertical,
    fixedWidth: flags.fixedWidth,
    fixedHeight: flags.fixedHeight,
    shadow: flags.shadow,
    shadowAlpha: flags.shadowAlpha,
    shadowAngle: flags.shadowAngle,
    shadowColor: flags.shadowColor,
    shadowDistance: flags.shadowDistance,
    shadowSmoothing: flags.shadowSmoothing,
    borderWidth: flags.borderWidth,
    borderColor: flags.borderColor,
    borderAlpha: flags.borderAlpha,
    bgColor: flags.bgColor,
    bgAlpha: flags.bgAlpha,
    bgStyle: flags.bgStyle,
    bgRoundRadius: flags.bgRoundRadius,
    bgWidth: flags.bgWidth,
    bgHeight: flags.bgHeight,
    bgHOffset: flags.bgHOffset,
    bgVOffset: flags.bgVOffset,
  };
  const hasStyleFlags = Object.values(styleOpts).some((v) => v !== undefined);
  const emphasis = keywordEmphasisFromFlags(flags);

  const created: Array<{ id: string; start_us: number; duration_us: number; text: string }> = [];
  let keywordMatches = 0;
  for (let cueIndex = 0; cueIndex < cues.length; cueIndex++) {
    const cue = cues[cueIndex];
    const start = cue.startUs + offsetUs;
    const duration = cue.endUs - cue.startUs;
    if (start < 0) die(`Cue ${cue.index} has negative start after --time-offset (${start}us)`);
    const opts: AddTextOptions = {
      text: cue.text,
      start,
      duration,
      fontSize: flags.fontSize,
      // --color-cycle rotates the base colour per cue and wins over --color.
      color: emphasis.cycle ? emphasis.cycle[cueIndex % emphasis.cycle.length] : flags.color,
      alignment: flags.align,
      x: flags.x,
      y: flags.y,
      trackName: flags.trackName ?? "subtitle",
    };
    const res = addText(draft, filePath, opts);
    // --color-cycle wins over the style-ref base colour per cue: keep the
    // fill colour addText just wrote instead of the ref's.
    if (flags.styleRef)
      copyTextStyle(draft, flags.styleRef, res.materialId, { keepFillColor: Boolean(emphasis.cycle) });
    if (hasStyleFlags) setTextStyle(draft, res.segmentId, styleOpts);
    if (emphasis.words) {
      // Emphasis ranges sit on top of the base styling written above; unmatched
      // text inherits the cue's styles[0] via setTextRanges' gap fill.
      const { ranges, matches } = buildEmphasisRanges(cue.text, {
        words: emphasis.words,
        color: emphasis.color,
        sizeMultiplier: emphasis.size,
        baseSize: textBaseFontSize(draft, res.materialId),
      });
      if (ranges.length > 0) setTextRanges(draft, res.segmentId, ranges);
      keywordMatches += matches;
    }
    created.push({ id: res.segmentId, start_us: start, duration_us: duration, text: cue.text });
  }

  saveDraft(filePath, draft);
  out(
    {
      ok: true,
      format: label,
      cues: created.length,
      track_name: flags.trackName ?? "subtitle",
      style_ref: flags.styleRef ?? null,
      time_offset_us: offsetUs,
      first: created[0],
      last: created[created.length - 1],
      // undefined when the flags are off, so the JSON stays byte-identical.
      keyword_matches: emphasis.words ? keywordMatches : undefined,
      color_cycle: emphasis.cycle ? emphasis.cycle.length : undefined,
    },
    flags,
  );
}

function cmdImportSrt(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const srtArg = positional[2];
  if (!srtArg) die(`Usage: capcut import-srt <project> <srt-path-or-->`);
  const srtContent = stripBom(srtArg === "-" ? readFileSync(0, "utf-8") : readFileSync(srtArg, "utf-8"));
  const cues = parseSrt(srtContent);
  if (cues.length === 0) die(`SRT produced 0 cues`);
  importCuesToDraft(draft, filePath, cues, flags, "srt");
}

function cmdImportAss(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const assArg = positional[2];
  if (!assArg) die(`Usage: capcut import-ass <project> <ass-path-or-->`);
  const assContent = stripBom(assArg === "-" ? readFileSync(0, "utf-8") : readFileSync(assArg, "utf-8"));
  const cues = parseAss(assContent);
  if (cues.length === 0) die(`ASS produced 0 cues`);
  importCuesToDraft(draft, filePath, cues, flags, "ass");
}

// --- Version & lint ---

function cmdVersion(draft: Draft, flags: Flags): void {
  const v = detectVersion(draft);
  if (flags.human) {
    console.log(`App:          ${v.app}${v.app_source !== "unknown" ? ` (${v.app_source})` : ""}`);
    console.log(`Version:      ${v.app_version ?? "(unknown)"}`);
    console.log(`OS:           ${v.os ?? "(unknown)"}`);
    console.log(`Support:      ${v.support.status}`);
    console.log(`Mask field:   ${v.schema.mask_field}`);
    console.log(`Text-ranges:  ${v.schema.has_text_ranges ? "yes" : "no"}`);
    console.log(`Audio fades:  ${v.schema.has_audio_fades ? "yes" : "no"}`);
    if (v.support.notes.length > 0) {
      console.log("");
      for (const n of v.support.notes) console.log(`  - ${n}`);
    }
  } else {
    out(v, flags);
  }
}

function cmdLint(draft: Draft, filePath: string, flags: Flags): { exitCode: number } {
  const opts: LintOptions = {
    maxCharsPerLine: flags.maxChars ?? DEFAULT_LINT_OPTIONS.maxCharsPerLine,
    maxCueDurationUs:
      flags.maxCueSecs !== undefined ? flags.maxCueSecs * 1_000_000 : DEFAULT_LINT_OPTIONS.maxCueDurationUs,
    minGapBetweenCaptionsUs:
      flags.minGapMs !== undefined ? flags.minGapMs * 1000 : DEFAULT_LINT_OPTIONS.minGapBetweenCaptionsUs,
    checkLocalPaths: flags.noCheckPaths ? false : DEFAULT_LINT_OPTIONS.checkLocalPaths,
  };

  if (flags.fix) {
    const { fixed, remaining } = fixDraft(draft, opts);
    // Only write if we actually repaired something. --dry-run (global) is
    // honored by saveDraft, which leaves the file and its .bak untouched.
    if (fixed.length > 0) saveDraft(filePath, draft);
    const summary = summarize(remaining);
    const exitCode = lintExitCode(summary);
    if (flags.human) {
      if (fixed.length === 0 && remaining.length === 0) {
        console.log("OK — no issues found");
      } else {
        for (const i of fixed) {
          const loc = i.location?.segment_id ? ` [${i.location.segment_id.slice(0, 8)}]` : "";
          console.log(`FIXED   ${i.code.padEnd(22)}${loc}  ${i.message}`);
        }
        for (const i of remaining) {
          const loc = i.location?.segment_id ? ` [${i.location.segment_id.slice(0, 8)}]` : "";
          console.log(`${i.severity.toUpperCase().padEnd(7)} ${i.code.padEnd(22)}${loc}  ${i.message}`);
        }
        console.log("");
        console.log(
          `${fixed.length} fixed · ${summary.errors} errors · ${summary.warnings} warnings · ${summary.info} info`,
        );
      }
    } else {
      out({ ok: summary.errors === 0, fixed, summary, issues: remaining }, flags);
    }
    return { exitCode };
  }

  const issues = lintDraft(draft, opts);
  const summary = summarize(issues);
  const exitCode = lintExitCode(summary);
  if (flags.human) {
    if (issues.length === 0) {
      console.log("OK — no issues found");
    } else {
      for (const i of issues) {
        const loc = i.location?.segment_id ? ` [${i.location.segment_id.slice(0, 8)}]` : "";
        console.log(`${i.severity.toUpperCase().padEnd(7)} ${i.code.padEnd(22)}${loc}  ${i.message}`);
      }
      console.log("");
      console.log(`${summary.errors} errors · ${summary.warnings} warnings · ${summary.info} info`);
    }
  } else {
    out({ ok: summary.errors === 0, summary, issues }, flags);
  }
  return { exitCode };
}

// --- Caption / translate / migrate / sfx / chroma / export / decrypt / serve ---

function cmdCaption(draft: Draft, filePath: string, flags: Flags): void {
  if (!flags.audio && !flags.fromSegment) {
    die("Missing --audio <path> or --from-segment <id>. One is required.");
  }
  const emphasis = keywordEmphasisFromFlags(flags);
  const result = captionDraft(draft, {
    audio: flags.audio,
    fromSegment: flags.fromSegment,
    whisperCmd: flags.whisperCmd,
    whisperEngine: flags.whisperEngine,
    whisperModel: flags.whisperModel,
    language: flags.language,
    trackName: flags.trackName,
    styleRef: flags.styleRef,
    preset: flags.preset ? loadPresetFile(flags.preset) : undefined,
    karaoke: flags.karaoke,
    maxWords: flags.maxWords,
    maxChars: flags.maxChars,
    maxGapMs: flags.maxGapMs,
    highlightWords: emphasis.words,
    keywordColor: emphasis.color,
    keywordSize: emphasis.size,
    colorCycle: emphasis.cycle,
  });
  saveDraft(filePath, draft);
  out(result, flags);
}

async function cmdTranslate(draft: Draft, _filePath: string, flags: Flags): Promise<void> {
  if (!flags.to) die("Missing --to <lang>. Usage: capcut translate <project> --to <lang> --out <path>");
  if (!flags.out)
    die("Missing --out <path>. The translated draft is written to a NEW file; the original is left untouched.");
  const result = await translateDraft(draft, {
    to: flags.to,
    from: flags.from,
    apiKey: flags.apiKey,
    model: flags.model,
    dryRun: flags.dryRun,
    outPath: flags.out,
  });
  out(result, flags);
}

function cmdMigrate(draft: Draft, filePath: string, flags: Flags): void {
  if (!flags.from || !flags.to) die("Usage: capcut migrate <project> --from <ver> --to <ver>");
  const result = migrateDraft(draft, flags.from, flags.to);
  saveDraft(filePath, draft);
  out(result, flags);
}

function cmdAddSfx(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const slug = positional[2];
  const startStr = positional[3];
  const durStr = positional[4];
  const start = parseTimeInput(startStr);
  const duration = parseTimeInput(durStr);
  const ns = flags.jianying ? "jianying" : "capcut";
  const result = addSfx(draft, {
    slug,
    start,
    duration,
    trackName: flags.trackName,
    namespace: ns,
    volume: flags.volume,
  });
  saveDraft(filePath, draft);
  out({ ok: true, ...result, start_us: start, duration_us: duration }, flags);
}

function cmdChroma(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const segId = positional[2];
  if (!segId) die("Usage: capcut chroma <project> <id> --color <#RRGGBB> [--intensity N] [--shadow N]  |  --off");
  if (flags.off) {
    const result = removeChroma(draft, segId);
    saveDraft(filePath, draft);
    out(result, flags);
    return;
  }
  if (!flags.color) die("Missing --color <#RRGGBB>. Pick the green-screen color to key out.");
  const result = setChroma(draft, segId, {
    color: flags.color,
    intensity: flags.intensity,
  });
  saveDraft(filePath, draft);
  out(result, flags);
}

function cmdExport(positional: string[], flags: Flags): void {
  const draftsDir = positional[1];
  if (!draftsDir) die("Usage: capcut export <drafts-dir> --batch [--dry-run] [--app capcut|jianying]");
  if (!flags.batch) die("`capcut export` currently only supports --batch mode. Pass --batch to confirm.");
  const result = exportBatch({
    draftsDir,
    dryRun: flags.dryRun,
    app: flags.app === "jianying" ? "jianying" : "capcut",
  });
  out(result, flags);
}

function cmdDecrypt(positional: string[], flags: Flags): void {
  const projectArg = positional[1];
  if (!projectArg) die("Usage: capcut decrypt <draft_content.json path>");
  // We can't use loadDraft here — the file may be unparseable. Detect raw.
  const report = detectEncryption(projectArg);
  if (flags.human) {
    console.log(`File:      ${report.filePath}`);
    console.log(`Size:      ${report.size} bytes`);
    console.log(`Encrypted: ${report.encrypted ? "YES" : "no"}`);
    console.log(`Reason:    ${report.reason}`);
    if (report.fix) {
      console.log("");
      console.log("Next steps:");
      for (const line of report.fix.split("\n")) console.log(`  ${line}`);
    }
  } else {
    out(report, flags);
  }
  if (report.encrypted) process.exit(2);
}

async function cmdServe(flags: Flags): Promise<void> {
  // Resolve our own dist path so the spawned child uses the same install.
  const selfPath = fileURLToPath(import.meta.url);
  const result = await serveQueue({
    queuePath: flags.queue,
    cliPath: selfPath,
    failFast: flags.failFast,
    workers: flags.workers,
    retries: flags.retries,
    timeoutMs: flags.timeoutMs,
    backoffMs: flags.backoffMs,
    maxBufferBytes: flags.maxBufferMb ? Math.round(flags.maxBufferMb * 1024 * 1024) : undefined,
  });
  // Write a final summary line at end (JSON only, stderr to avoid mixing with per-job results)
  process.stderr.write(`${JSON.stringify({ summary: result })}\n`);
}

// --- Batch ---

interface BatchOp {
  cmd: string;
  id?: string;
  text?: string;
  offset?: string;
  speed?: number;
  volume?: number;
  opacity?: number;
  start?: string;
  duration?: string;
  track?: string;
}

function execBatchOp(draft: Draft, filePath: string, op: BatchOp, flags: Flags): void {
  const silent = { ...flags, quiet: true };
  switch (op.cmd) {
    case "set-text":
      if (!op.id || op.text === undefined) die(`batch set-text requires id and text`);
      cmdSetText(draft, filePath, op.id, op.text, silent, false);
      break;
    case "shift":
      if (!op.id || !op.offset) die(`batch shift requires id and offset`);
      cmdShift(draft, filePath, op.id, op.offset, silent, false);
      break;
    case "shift-all":
      if (!op.offset) die(`batch shift-all requires offset`);
      cmdShiftAll(draft, filePath, op.offset, { ...silent, track: op.track }, false);
      break;
    case "speed":
      if (!op.id || op.speed === undefined) die(`batch speed requires id and speed`);
      cmdSpeed(draft, filePath, op.id, String(op.speed), silent, false);
      break;
    case "volume":
      if (!op.id || op.volume === undefined) die(`batch volume requires id and volume`);
      cmdVolume(draft, filePath, op.id, String(op.volume), silent, false);
      break;
    case "opacity":
      if (!op.id || op.opacity === undefined) die(`batch opacity requires id and opacity`);
      cmdOpacity(draft, filePath, op.id, String(op.opacity), silent, false);
      break;
    case "trim":
      if (!op.id || !op.start || !op.duration) die(`batch trim requires id, start, duration`);
      cmdTrim(draft, filePath, op.id, op.start, op.duration, silent, false);
      break;
    default:
      die(`Unknown batch command: ${op.cmd}`);
  }
}

function cmdBatch(draft: Draft, filePath: string, flags: Flags): void {
  const input = stripBom(readFileSync(0, "utf-8")).trim();
  if (!input) die("No input on stdin");
  const lines = input.split("\n");
  let working = structuredClone(draft);
  const errors: Array<{ line: number; input: string; error: string }> = [];
  let succeeded = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const op = JSON.parse(trimmed) as BatchOp;
      if (!op || typeof op !== "object" || typeof op.cmd !== "string") {
        throw new Error("batch line must be an object with a string cmd field");
      }
      // Each operation runs against its own clone. A failing operation can
      // never leave a partial mutation behind, even in --continue-on-error.
      const candidate = structuredClone(working);
      execBatchOp(candidate, filePath, op, flags);
      working = candidate;
      succeeded++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ line: index + 1, input: trimmed, error: msg });
      if (!flags.continueOnError) break;
    }
  }

  if (errors.length > 0 && !flags.continueOnError) {
    throw new Error(
      `batch aborted at line ${errors[0].line}; no changes written: ${errors[0].error}. ` +
        "Pass --continue-on-error to commit only successful operations.",
    );
  }

  if (succeeded > 0) {
    Object.assign(draft, working);
    saveDraft(filePath, draft);
  }
  if (errors.length > 0) process.exitCode = 1;
  out(
    { ok: errors.length === 0, transactional: !flags.continueOnError, succeeded, failed: errors.length, errors },
    flags,
  );
}

function cmdDoctor(flags: Flags): boolean {
  const report = runDoctor();
  if (flags.human) {
    const glyph: Record<DoctorCheck["status"], string> = { ok: "✓", warn: "!", missing: "✗" };
    console.log(`Platform:  ${report.platform}`);
    console.log(`Node:      ${report.node}`);
    console.log("");
    for (const c of report.checks) {
      console.log(`[${glyph[c.status]}] ${c.name.padEnd(18)} ${c.detail}`);
      if (c.status !== "ok" && c.fix) console.log(`      → ${c.fix}`);
    }
    console.log("");
    console.log(report.ok ? "Ready." : "Missing a hard requirement — see ✗ above.");
  } else {
    out(report, flags);
  }
  return report.ok;
}

function cmdDiagnose(projectPath: string | undefined, flags: Flags): void {
  if (!projectPath) die("Usage: capcut diagnose <project> [--bundle <report.json>]");
  const report = diagnoseDraftStore(projectPath);
  if (flags.bundle) {
    writeFileSync(flags.bundle, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  }
  if (flags.human) {
    console.log(`Canonical: ${report.canonical}`);
    console.log(`Version:   ${report.version ?? "unknown"}`);
    console.log(`Diverged:  ${report.diverged ? "YES" : "no"}`);
    console.log(`Editor:    ${report.editor_running.join(", ") || "not detected"}`);
    console.log("");
    for (const candidate of report.candidates) {
      const state = !candidate.exists ? "missing" : candidate.parseable_timeline ? "timeline" : "unreadable";
      console.log(`${candidate.file.padEnd(24)} ${state.padEnd(10)} ${String(candidate.size).padStart(9)} bytes`);
    }
    if (flags.bundle) console.log(`\nBundle: ${flags.bundle}`);
  } else {
    out({ ...report, bundle: flags.bundle ?? null }, flags);
  }
}

// `register` is the meta-repair sidecar for EXISTING drafts: `init` registers
// a draft only at creation time (factory.ts registerDraftInIndex), so an
// existing folder missing draft_meta_info.json or its entry in the store's
// root_meta_info.json is invisible to the CapCut app with no repair path.
// draft_content.json is the read-only id/name/duration source and is NEVER
// written. Plan-only by default; --apply writes atomically with a .bak per
// file modified and is idempotent (re-run -> applied: [], exit 0). Returns the
// exit code: 0 ok (the plan form always exits 0), 1 via die(), 2 when --apply
// leaves a target blocked (draft outside any known store root, unreadable
// root_meta_info.json).
function cmdRegister(projectPath: string | undefined, flags: Flags): number {
  if (!projectPath) die("Usage: capcut register <project-dir> [--apply] [--drafts <dir>]");
  const result = planDraftRegistration(projectPath, { draftsDir: flags.drafts });
  const { plan } = result;

  const warnBlocked = (): void => {
    if (flags.quiet) return;
    for (const target of plan.targets) {
      if (target.action === "blocked") process.stderr.write(`WARNING ${target.file}: ${target.detail}\n`);
    }
  };

  if (!flags.apply) {
    const message = plan.needs_repair
      ? `Would write ${plan.repairs.join(", ")}. Re-run with --apply to write.`
      : plan.blocked.length > 0
        ? `Registration cannot be verified or repaired: ${plan.blocked.join(", ")} — see targets.`
        : "Draft is registered: draft_meta_info.json and the store's root_meta_info.json entry agree with draft_content.json.";
    out({ ok: plan.blocked.length === 0, applied: false, message, ...plan }, flags);
    if (!flags.quiet) {
      for (const target of plan.targets) {
        if (target.action === "create" || target.action === "update") {
          process.stderr.write(`plan: ${target.action} ${target.file} (${target.detail})\n`);
        }
      }
      warnBlocked();
      process.stderr.write(plan.needs_repair ? "Plan only — re-run with --apply to write.\n" : `${message}\n`);
    }
    return 0;
  }

  if (plan.repairs.length === 0) {
    const ok = plan.blocked.length === 0;
    const message = ok
      ? "Draft is already registered — nothing to write."
      : `Nothing writable: ${plan.blocked.join(", ")} cannot be repaired by the CLI — see targets.`;
    out({ ok, applied: [], backups: [], message, ...plan }, flags);
    if (!flags.quiet) process.stderr.write(`${message}\n`);
    warnBlocked();
    return ok ? 0 : 2;
  }

  if (!flags.forceWrite) {
    const running = editorProcesses();
    if (running.length > 0) {
      die(
        `${running.join(" / ")} is running. Close the editor before repairing this draft's registration, ` +
          "or pass --force-write if you accept that the app may overwrite the change.",
      );
    }
  }

  if (isDryRun()) {
    const message = `Dry run — plan only. Would write ${plan.repairs.join(", ")}; nothing was written.`;
    out({ ok: true, applied: [], backups: [], would_apply: plan.repairs, message, ...plan }, flags);
    if (!flags.quiet) process.stderr.write(`${message}\n`);
    warnBlocked();
    return 0;
  }

  const { applied, backups } = applyDraftRegistration(result, { forceWrite: flags.forceWrite === true });

  const verify = planDraftRegistration(projectPath, { draftsDir: flags.drafts });
  if (verify.plan.needs_repair) {
    die(
      `register wrote ${applied.join(", ")} but the draft still needs repair (${verify.plan.repairs.join(", ")}). ` +
        "Restore from the .bak files and report this.",
    );
  }
  const ok = plan.blocked.length === 0;
  out({ ok, applied, backups, ...verify.plan }, flags);
  if (!flags.quiet) process.stderr.write(`Registered from draft_content.json: wrote ${applied.join(", ")}\n`);
  warnBlocked();
  return ok ? 0 : 2;
}

// `sync-timelines` repairs a draft whose mirror files (template-2.tmp /
// draft_info.json — including the pre-open mirror's stale GUID) drifted from
// draft_content.json, the CapCut >= 8.7 "CLI edit silently ignored" failure
// (issue #35 / #39). draft_content.json is canonical and treated as a
// read-only source: --apply rewrites EXACTLY the drifted mirrors inside their
// own envelopes (atomic temp+rename, one .bak per file written) and never
// touches draft_content.json or in-sync mirrors. Because CapCut >= 8.7 writes
// the mirrors on save, a canonical file OLDER than a drifted mirror may mean
// the mirror holds newer app edits — --apply refuses that direction unless
// --force-write. Plan-only by default; --apply writes. Returns the exit code:
// 0 ok, 1 via die(), 2 when a mirror exists that the CLI cannot reconcile.
function cmdSyncTimelines(projectPath: string | undefined, flags: Flags): number {
  if (!projectPath) die("Usage: capcut sync-timelines <project-dir> [--apply] [--force-write]");
  const { plan, canonicalDraft, canonicalCandidate, driftedCandidates } = planTimelineSync(projectPath);

  const warnUnreconcilable = (): void => {
    if (flags.quiet) return;
    for (const u of plan.unreconcilable) {
      process.stderr.write(`WARNING ${u.file}: ${u.reason}. ${u.workaround}\n`);
    }
  };
  const staleCanonicalWarning = (): string => {
    const canonicalTarget = plan.targets.find((target) => target.state === "canonical");
    const newer = plan.targets
      .filter((target) => plan.newer_mirrors.includes(target.file))
      .map((target) => `${target.file} (${target.mtime})`)
      .join(", ");
    return (
      `draft_content.json (${canonicalTarget?.mtime}) is OLDER than the drifted mirror(s) ${newer}. ` +
      "CapCut >= 8.7 writes these mirrors on save, so they may hold newer app edits that this repair would roll back."
    );
  };

  if (plan.in_sync) {
    const ok = plan.unreconcilable.length === 0;
    const message = ok
      ? "All readable timeline targets already agree — nothing to write."
      : `Readable timeline targets agree, but ${plan.unreconcilable.map((u) => u.file).join(", ")} cannot be reconciled by the CLI — see unreconcilable.`;
    out({ ok, applied: false, message, ...plan, in_sync: ok }, flags);
    if (!flags.quiet) process.stderr.write(`${message}\n`);
    warnUnreconcilable();
    return ok ? 0 : 2;
  }

  if (!flags.apply) {
    const message = `Would rewrite ${plan.drifted.join(", ")} from draft_content.json. Re-run with --apply to write.`;
    out({ ok: true, applied: false, message, ...plan }, flags);
    if (!flags.quiet) {
      const canonicalTarget = plan.targets.find((target) => target.state === "canonical");
      process.stderr.write(`plan: canonical draft_content.json (mtime ${canonicalTarget?.mtime})\n`);
      for (const target of plan.targets) {
        if (target.state !== "drifted") continue;
        const guidNote = target.guid_drifted ? ` [stale GUID ${target.guid} -> canonical]` : "";
        process.stderr.write(
          `plan: rewrite ${target.file} (envelope: ${target.envelope}, mtime ${target.mtime})${guidNote}\n`,
        );
      }
      if (plan.canonical_stale) {
        process.stderr.write(`WARNING: ${staleCanonicalWarning()} --apply will refuse without --force-write.\n`);
      }
      warnUnreconcilable();
      process.stderr.write("Plan only — re-run with --apply to write.\n");
    }
    return 0;
  }

  if (!flags.forceWrite) {
    const running = editorProcesses();
    if (running.length > 0) {
      die(
        `${running.join(" / ")} is running. Close the editor before repairing this draft, ` +
          "or pass --force-write if you accept that the app may overwrite the change.",
      );
    }
    if (plan.canonical_stale) {
      die(
        `${staleCanonicalWarning()} Back up the project, review the plan (capcut sync-timelines ${projectPath}), ` +
          "and pass --force-write only if draft_content.json is really the timeline you want to keep.",
      );
    }
  }

  if (isDryRun()) {
    const message = `Dry run — plan only. Would rewrite ${plan.drifted.join(", ")} from draft_content.json; nothing was written.`;
    out(
      {
        ok: true,
        applied: false,
        message,
        project_dir: plan.project_dir,
        canonical: plan.canonical,
        would_reconcile: plan.drifted,
        reconciled: [],
        backups: [],
        unreconcilable: plan.unreconcilable,
        in_sync: false,
      },
      flags,
    );
    if (!flags.quiet) process.stderr.write(`${message}\n`);
    warnUnreconcilable();
    return 0;
  }

  // Optimistic concurrency: neither the canonical source nor a mirror we are
  // about to rewrite may have changed on disk between the plan read and now.
  if (!flags.forceWrite) assertTargetsUnchangedOnDisk([canonicalCandidate, ...driftedCandidates]);
  commitDraftTargets(driftedCandidates, canonicalDraft);

  const verify = planTimelineSync(projectPath);
  if (!verify.plan.in_sync) {
    die(
      `sync-timelines wrote the targets but they still diverge (${verify.plan.drifted.join(", ")}). ` +
        "Restore from the .bak files and report this.",
    );
  }
  const ok = plan.unreconcilable.length === 0;
  out(
    {
      ok,
      applied: true,
      project_dir: plan.project_dir,
      canonical: plan.canonical,
      reconciled: plan.drifted,
      backups: plan.drifted.map((file) => `${file}.bak`),
      unreconcilable: plan.unreconcilable,
      in_sync: ok,
    },
    flags,
  );
  if (!flags.quiet) process.stderr.write(`Reconciled from draft_content.json: ${plan.drifted.join(", ")}\n`);
  warnUnreconcilable();
  return ok ? 0 : 2;
}

function cmdTemplates(flags: Flags): void {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const templatesPath = path.join(cliDir, "..", "templates");

  if (!existsSync(templatesPath)) {
    die(`Templates directory not found: ${templatesPath}`);
  }

  const descriptions: Record<string, string> = {
    "caption-pop": "word-highlight pop captions",
    "lower-third": "name/title lower third",
    "hook-question": "opening hook question card",
    "gold-title": "gold title card",
    "end-card": "end / outro card",
    "subscribe-cta": "subscribe call-to-action",
  };

  const entries = readdirSync(templatesPath)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const slug = path.basename(f, ".json");
      return {
        slug,
        description: descriptions[slug] ?? slug.replace(/-/g, " "),
      };
    });

  if (flags.human) {
    if (entries.length === 0) {
      console.log("No bundled templates found.");
      return;
    }
    console.log(`${"Slug".padEnd(33)} Description`);
    for (const e of entries) {
      console.log(`${e.slug.padEnd(33)} ${e.description}`);
    }
    process.stderr.write(`\n${entries.length} templates\n`);
  } else {
    out(entries, flags);
  }
}

function getCliVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  return pkg.version;
}

// `restore` undoes writes. Plain form restores the most recent `.bak`. With
// --list it shows the rolling snapshot history; with --step N it rolls back N
// writes (step 1 == the .bak). Honors --dry-run (reports without copying).
function cmdRestore(projectPath: string | undefined, flags: Flags): void {
  if (!projectPath) die("Missing project path. Usage: capcut restore <project> [--step N | --list]");
  const filePath = findDraft(projectPath);
  const hasSynchronizedSiblings = discoverDraftStore(filePath).targets.length > 1;
  const snaps = listSnapshots(filePath);

  if (flags.list) {
    out({ ok: true, count: snaps.length, snapshots: snaps.map((s) => ({ step: s.step, path: s.path })) }, flags);
    return;
  }

  if (flags.step !== undefined) {
    if (!Number.isInteger(flags.step) || flags.step < 1) die("--step must be a positive integer (1 = most recent).");
    const target = snaps.find((s) => s.step === flags.step);
    if (!target) {
      const avail = snaps.length ? `1..${snaps.length}` : "none yet";
      die(`No snapshot at --step ${flags.step}. Available: ${avail}. Try: capcut restore ${projectPath} --list`);
    }
    if (!isDryRun()) {
      copyFileSync(target.path, filePath);
      if (hasSynchronizedSiblings) {
        const restored = loadDraft(filePath);
        saveDraft(restored.filePath, restored.draft, { backup: false });
      }
    }
    out({ ok: true, restored: filePath, from: target.path, step: flags.step }, flags);
    return;
  }

  const bakPath = `${filePath}.bak`;
  if (!existsSync(bakPath)) {
    die(`No backup found at ${bakPath}. Nothing to restore (a .bak is written on the first edit).`);
  }
  if (!isDryRun()) {
    copyFileSync(bakPath, filePath);
    if (hasSynchronizedSiblings) {
      const restored = loadDraft(filePath);
      saveDraft(restored.filePath, restored.draft, { backup: false });
    }
  }
  out({ ok: true, restored: filePath, from: bakPath }, flags);
}

// `prune` removes materials no segment references. The referenced set is the
// union of every segment's material_id AND its extra_material_refs[] (the latter
// is what keeps masks/effects/animations/fades from being wrongly deleted).
function cmdPrune(draft: Draft, filePath: string, flags: Flags): void {
  const referenced = new Set<string>();
  for (const track of draft.tracks) {
    for (const seg of track.segments) {
      if (seg.material_id) referenced.add(seg.material_id);
      for (const ref of seg.extra_material_refs ?? []) referenced.add(ref);
    }
  }
  const byType: Record<string, { removed: number; kept: number }> = {};
  let removedTotal = 0;
  for (const [type, arr] of Object.entries(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    const before = arr.length;
    const kept = arr.filter((m) => {
      const id = (m as { id?: unknown }).id;
      // Keep anything without a string id (can't prove it's orphaned) or that is referenced.
      return typeof id !== "string" || referenced.has(id);
    });
    const removed = before - kept.length;
    if (removed > 0) (draft.materials as Record<string, unknown[]>)[type] = kept;
    byType[type] = { removed, kept: kept.length };
    removedTotal += removed;
  }
  if (removedTotal > 0) saveDraft(filePath, draft);
  out({ ok: true, removed: removedTotal, by_type: byType }, flags);
}

// `relink` repairs broken media paths. Two modes (combinable):
//   --dir <d>          for each material whose path is missing, look for a file
//                      with the same basename in <d> and repoint to it.
//   --from <p> --to <q> prefix-replace on every material path.
function cmdRelink(draft: Draft, filePath: string, flags: Flags): void {
  if (!flags.dir && !(flags.from && flags.to)) {
    die("Usage: capcut relink <project> --dir <folder>  |  --from <oldPrefix> --to <newPrefix>");
  }
  const dirIndex = new Map<string, string>();
  if (flags.dir) {
    if (!existsSync(flags.dir)) die(`--dir not found: ${flags.dir}`);
    for (const f of readdirSync(flags.dir)) dirIndex.set(path.basename(f), path.join(flags.dir as string, f));
  }
  const relinked: Array<{ id: string; from: string; to: string }> = [];
  let missing = 0;
  let ok = 0;
  for (const arr of Object.values(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      const mat = m as { id?: string; path?: unknown };
      if (typeof mat.path !== "string" || mat.path === "") continue;
      let p = mat.path;
      let changed = false;
      if (flags.from && flags.to && p.startsWith(flags.from)) {
        p = flags.to + p.slice(flags.from.length);
        changed = true;
      }
      if (!existsSync(p) && flags.dir) {
        const hit = dirIndex.get(path.basename(p));
        if (hit) {
          p = hit;
          changed = true;
        }
      }
      if (changed && p !== mat.path) {
        relinked.push({ id: mat.id ?? "", from: mat.path, to: p });
        mat.path = p;
      }
      if (existsSync(p)) ok++;
      else missing++;
    }
  }
  if (relinked.length > 0) saveDraft(filePath, draft);
  out({ ok: true, relinked: relinked.length, still_missing: missing, present: ok, changes: relinked }, flags);
}

// `replace-media` swaps a segment's source file in place (placeholder > final),
// preserving its timeline position, timing, effects, and keyframes.
function cmdReplaceMedia(draft: Draft, filePath: string, positional: string[], flags: Flags): void {
  const result = replaceMedia(draft, filePath, {
    segmentId: positional[2],
    newPath: positional[3],
    ffprobeCmd: flags.ffprobeCmd,
    retime: flags.retime,
    dryRun: isDryRun(),
  });
  saveDraft(filePath, draft); // no-ops under --dry-run
  out(result, flags);
  if (!flags.quiet && result.warning) process.stderr.write(`Warning: ${result.warning}\n`);
}

// `timeline` shows the track/segment layout. JSON default returns structured
// lanes (with computed columns); -H renders ASCII bars scaled to --cols (def 60).
function cmdTimeline(draft: Draft, flags: Flags): void {
  const cols = flags.cols && flags.cols > 0 ? flags.cols : 60;
  let span = 0;
  for (const t of draft.tracks)
    for (const s of t.segments) span = Math.max(span, s.target_timerange.start + s.target_timerange.duration);
  span = Math.max(span, draft.duration, 1);
  const scale = (us: number) => Math.round((us / span) * cols);
  const tracks = draft.tracks.map((t) => ({
    type: t.type,
    name: t.name,
    segments: t.segments.map((s) => {
      const startCol = scale(s.target_timerange.start);
      const endCol = Math.max(startCol + 1, scale(s.target_timerange.start + s.target_timerange.duration));
      return {
        id: s.id,
        start_us: s.target_timerange.start,
        duration_us: s.target_timerange.duration,
        col_start: startCol,
        col_end: endCol,
      };
    }),
  }));

  if (!flags.human) {
    out({ ok: true, span_us: span, cols, tracks }, flags);
    return;
  }
  const lines: string[] = [];
  const label = (t: { type: string; name: string }) => `${t.type}${t.name ? `/${t.name}` : ""}`.padEnd(14).slice(0, 14);
  for (const t of tracks) {
    const row = Array.from({ length: cols }, () => " ");
    for (const s of t.segments) {
      for (let c = s.col_start; c < s.col_end && c < cols; c++) row[c] = "█";
    }
    lines.push(`${label(t)} |${row.join("")}|`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

// `projects` lists draft folders on disk. Scans --drafts <dir> (or the per-OS
// CapCut/JianYing default dirs) for sub-folders containing a draft file. An
// optional query substring filters by folder name. --names also reads each
// draft's `name` field (one parse per project).
function cmdProjects(positional: string[], flags: Flags): void {
  const query = positional[1]?.toLowerCase();
  const roots = flags.drafts ? [{ label: "custom", path: flags.drafts }] : draftDirs();
  const projects: Array<{ name?: string; folder: string; path: string; mtime: string; root: string }> = [];
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for (const entry of readdirSync(root.path)) {
      const folder = path.join(root.path, entry);
      let isDir = false;
      try {
        isDir = statSync(folder).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) continue;
      const draftFile = ["draft_content.json", "draft_info.json"]
        .map((f) => path.join(folder, f))
        .find((p) => existsSync(p));
      if (!draftFile) continue;
      if (query && !entry.toLowerCase().includes(query)) continue;
      const rec: { name?: string; folder: string; path: string; mtime: string; root: string } = {
        folder: entry,
        path: draftFile,
        mtime: statSync(draftFile).mtime.toISOString(),
        root: root.label,
      };
      if (flags.names) {
        try {
          const d = JSON.parse(stripBom(readFileSync(draftFile, "utf-8"))) as { name?: string };
          rec.name = d.name || undefined;
        } catch {
          /* unreadable draft — leave name undefined */
        }
      }
      projects.push(rec);
    }
  }
  projects.sort((a, b) => b.mtime.localeCompare(a.mtime));
  if (flags.human) {
    if (!projects.length) {
      process.stdout.write("No projects found.\n");
      return;
    }
    const lines = projects.map((p) => `${p.mtime.slice(0, 10)}  ${p.folder}${p.name ? `  (${p.name})` : ""}`);
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  out({ ok: true, count: projects.length, projects }, flags);
}

// One-line summary per command, keyed by the COMMANDS entries. `describe`
// serializes these into a machine-readable tool spec. The test asserts every
// COMMANDS name has an entry here, so a new command can't ship undescribed.
const SUMMARIES: Record<string, string> = {
  quickstart: "One-command first draft: create + add one input + lint + print the open-in-CapCut step.",
  fixture: "Build a shareable, redacted compatibility bundle (timeline JSON only) for a version-support issue.",
  "replace-media": "Swap a segment's source file (placeholder > final) keeping its timing, effects, and keyframes.",
  info: "Project overview + material summary.",
  version: "Detect CapCut/JianYing version, schema flags, and support status.",
  lint: "Schema-aware checks (overlaps, line length, missing files); exit 0/1/2 for CI.",
  tracks: "List all tracks.",
  segments: "List segments with timing; filter by --track <type>.",
  texts: "List all text/subtitle content.",
  "set-text": "Change a text segment's content.",
  shift: "Shift one segment's timing by an offset (e.g. +0.5s).",
  "shift-all": "Shift all segments (optionally on one --track) by an offset.",
  speed: "Set a segment's playback speed.",
  volume: "Set a segment's volume (0.0-1.0).",
  trim: "Trim a segment to a start/duration window.",
  opacity: "Set a segment's opacity (0.0-1.0).",
  "export-srt": "Export subtitles to SRT or WebVTT on stdout, per line or per word.",
  materials: "List material types and counts; filter with --type.",
  segment: "Full detail for one segment and its material.",
  material: "Full detail for one material.",
  "add-audio": "Add a local or Wikimedia audio file on an audio track.",
  "add-video": "Add a local or Wikimedia video/image on a video track.",
  "add-text": "Add a text segment with font/color/position options.",
  crop: "Read or set a video/photo segment's source-material crop (--ratio preset, --rect x,y,w,h, or --reset).",
  cut: "Extract a time range into a new standalone draft.",
  duplicate: "Duplicate a segment at its same timeline position onto a track above the source.",
  keyframe: "Add a keyframe (position/scale/rotation/alpha/volume); single or --batch.",
  transition: "Add a transition between segments.",
  mask: "Apply a mask (linear/circle/heart/...) with geometry flags, or --off.",
  "bg-blur": "Set background blur level 1-4, or --off.",
  "text-style": "Style text (alpha/shadow/border/background box).",
  "text-anim": "Add intro/outro/combo text animation.",
  "image-anim": "Add intro/outro/combo animation to an image/video segment.",
  "add-sticker": "Add a sticker on its own track with transform.",
  "mix-mode": "Set a video segment's blend mode.",
  "audio-fade": "Add fade-in/fade-out to an audio segment (--in / --fade-out).",
  "add-cover": "Set the project cover/thumbnail from a local image.",
  "add-filter": "Add a colour filter on its own track.",
  "bubble-text": "Apply a speech-bubble shape to a text segment.",
  "add-effect": "Add a scene effect on its own track.",
  "save-template": "Extract a segment as a reusable template JSON.",
  "apply-template": "Stamp a template into a project with new timing/text.",
  "make-preset": "Extract a text segment's styling as a reusable preset JSON (apply via --preset).",
  templates: "List bundled reusable templates.",
  batch: "Run multiple edits from stdin (JSONL), one file write.",
  "import-srt": "Import an SRT file/stdin as one text segment per cue.",
  "import-ass": "Import an ASS/SSA subtitle file as text segments.",
  "text-ranges": "Apply byte-accurate multi-style ranges to a text segment.",
  caption: "Transcribe audio via whisper into real caption-track segments.",
  translate: "Clone a draft into another language via the Anthropic API.",
  migrate: "Apply known schema migrations across version boundaries.",
  "add-sfx": "Add a sound effect on a dedicated track.",
  chroma: "Green-screen / chroma key a video segment, or --off.",
  enums: "List enum slugs (transitions, masks, effects, ...) by category.",
  doctor: "Environment preflight (Node, whisper, API key, project dir).",
  diagnose: "Inspect canonical draft files, divergence, and editor-write safety.",
  "sync-timelines":
    "Reconcile drifted timeline mirrors (template-2.tmp, draft_info.json) from a read-only draft_content.json (plan with mtimes by default; --apply rewrites only the drifted mirrors).",
  prune: "Remove materials no segment references.",
  register:
    "Repair an existing draft's registration metadata (draft_meta_info.json + root_meta_info.json entry) from a read-only draft_content.json so the CapCut app lists it (plan by default; --apply writes with .bak).",
  relink: "Repair broken media paths (--dir or --from/--to).",
  timeline: "Show the track/segment layout (JSON, or -H ASCII bars).",
  projects: "List CapCut/JianYing draft folders on disk.",
  diff: "Compare two drafts (segments/materials/tracks added/removed/changed).",
  concat: "Append one draft onto another's timeline (id-safe), write to --out or in place.",
  config: "Show the resolved config (.capcutrc + effective defaults).",
  describe: "Emit the full command surface as JSON (agent tool spec).",
  completions: "Generate shell completions (bash|zsh|fish).",
  restore: "Undo writes from .bak / snapshot history (--step N, --list).",
  serve: "Run a stateless JSONL job queue from stdin/--queue.",
  decrypt: "Detect JianYing 6.0+ encryption and explain the workaround.",
  export: "EXPERIMENTAL UI-automated render queue (macOS).",
  init: "Create a new empty draft from a template.",
  compile: "Build a draft from a declarative JSON spec (the inverse of describe).",
  render: "Render a low-res ffmpeg proxy preview (trim+speed+audio, --burn-captions); not CapCut's final render.",
  "detect-scenes":
    "Detect scene-change cut points in a video (ffmpeg scene filter); prints cuts + segments to seed compile/cut.",
};

// `describe` emits a machine-readable tool spec for LLM/agent callers, so they
// don't have to scrape --help. Names come from COMMANDS (source of truth);
// summaries from SUMMARIES (test-enforced complete).
function cmdDescribe(flags: Flags): void {
  out(
    {
      name: "capcut-cli",
      version: getCliVersion(),
      schema_version: 2,
      description: "Edit CapCut/JianYing draft_content.json directly. JSON in, JSON out.",
      global_flags: GLOBAL_OPTION_SPECS,
      commands: commandSpecs(),
    },
    flags,
  );
}

function commandSpecs() {
  return buildCommandSpecs(COMMANDS, SUMMARIES);
}

// --- Config (.capcutrc) ---

interface CapcutConfig {
  drafts?: string;
  jianying?: boolean;
  cols?: number;
}

// Load .capcutrc from cwd, then home. cwd wins. Returns {} if none/invalid.
function loadConfig(): { path: string | null; config: CapcutConfig } {
  for (const p of [path.join(process.cwd(), ".capcutrc"), path.join(homedir(), ".capcutrc")]) {
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(stripBom(readFileSync(p, "utf-8"))) as CapcutConfig;
      return { path: p, config: cfg };
    } catch {
      // Malformed config is ignored rather than crashing every command.
      return { path: p, config: {} };
    }
  }
  return { path: null, config: {} };
}

// Apply config as defaults: a CLI flag always wins over the file.
function applyConfig(flags: Flags, config: CapcutConfig): void {
  if (flags.drafts === undefined && typeof config.drafts === "string") flags.drafts = config.drafts;
  if (flags.jianying === undefined && config.jianying === true) flags.jianying = true;
  if (flags.cols === undefined && typeof config.cols === "number") flags.cols = config.cols;
}

function cmdConfig(flags: Flags): void {
  const { path: cfgPath, config } = loadConfig();
  out(
    {
      ok: true,
      path: cfgPath,
      config,
      effective: { drafts: flags.drafts, jianying: !!flags.jianying, cols: flags.cols },
    },
    flags,
  );
}

// --- diff / concat ---

// Read a draft from disk without touching loadDraft's module state (so two can
// be loaded at once for diff/concat).
function readDraft(input: string): { draft: Draft; filePath: string } {
  const filePath = findDraft(input);
  return { draft: JSON.parse(stripBom(readFileSync(filePath, "utf-8"))) as Draft, filePath };
}

function indexSegments(draft: Draft): Map<string, { seg: Segment; track: string }> {
  const m = new Map<string, { seg: Segment; track: string }>();
  for (const t of draft.tracks) for (const s of t.segments) m.set(s.id, { seg: s, track: t.type });
  return m;
}

function indexMaterials(draft: Draft): Map<string, string> {
  const m = new Map<string, string>();
  for (const [type, arr] of Object.entries(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    for (const mat of arr) {
      const id = (mat as { id?: unknown }).id;
      if (typeof id === "string") m.set(id, type);
    }
  }
  return m;
}

// id -> serialized material, so diff can detect in-place content changes
// (a text edit mutates the material under the same id).
function indexMaterialContent(draft: Draft): Map<string, string> {
  const m = new Map<string, string>();
  for (const arr of Object.values(draft.materials)) {
    if (!Array.isArray(arr)) continue;
    for (const mat of arr) {
      const id = (mat as { id?: unknown }).id;
      if (typeof id === "string") m.set(id, JSON.stringify(mat));
    }
  }
  return m;
}

// `diff` reports what changed between two drafts: segments added/removed/changed
// and materials added/removed. Read-only.
function cmdDiff(positional: string[], flags: Flags): void {
  const aPath = positional[1];
  const bPath = positional[2];
  if (!aPath || !bPath) die("Usage: capcut diff <projectA> <projectB>");
  const a = readDraft(aPath).draft;
  const b = readDraft(bPath).draft;

  const aSeg = indexSegments(a);
  const bSeg = indexSegments(b);
  const segAdded: string[] = [];
  const segRemoved: string[] = [];
  const segChanged: Array<{ id: string; fields: string[] }> = [];
  for (const [id, { seg }] of bSeg) {
    if (!aSeg.has(id)) {
      segAdded.push(id);
      continue;
    }
    const prev = aSeg.get(id)?.seg as Segment;
    const fields: string[] = [];
    if (prev.target_timerange.start !== seg.target_timerange.start) fields.push("start");
    if (prev.target_timerange.duration !== seg.target_timerange.duration) fields.push("duration");
    if (prev.material_id !== seg.material_id) fields.push("material_id");
    if (JSON.stringify(prev.content ?? null) !== JSON.stringify(seg.content ?? null)) fields.push("content");
    if (prev.speed !== seg.speed) fields.push("speed");
    if (prev.volume !== seg.volume) fields.push("volume");
    if (fields.length) segChanged.push({ id, fields });
  }
  for (const id of aSeg.keys()) if (!bSeg.has(id)) segRemoved.push(id);

  const aMat = indexMaterialContent(a);
  const bMat = indexMaterialContent(b);
  const matAdded = [...bMat.keys()].filter((id) => !aMat.has(id));
  const matRemoved = [...aMat.keys()].filter((id) => !bMat.has(id));
  // Same id in both but different serialized content — e.g. a text edit mutates
  // the text material (not the segment), so this is where set-text shows up.
  const matChanged = [...bMat.keys()].filter((id) => aMat.has(id) && aMat.get(id) !== bMat.get(id));

  const changed =
    segAdded.length + segRemoved.length + segChanged.length + matAdded.length + matRemoved.length + matChanged.length >
    0;
  out(
    {
      ok: true,
      changed,
      tracks: { a: a.tracks.length, b: b.tracks.length },
      segments: { added: segAdded, removed: segRemoved, changed: segChanged },
      materials: { added: matAdded, removed: matRemoved, changed: matChanged },
    },
    flags,
  );
}

// `concat` appends draftB onto draftA's timeline. B's segments are time-shifted
// by A's duration; any B material/segment id that collides with A is reassigned
// a fresh uuid (and references rewritten) so the merged draft stays valid.
function cmdConcat(positional: string[], flags: Flags): void {
  const aInput = positional[1];
  const bInput = positional[2];
  if (!aInput || !bInput) die("Usage: capcut concat <projectA> <draftB> [--out <path>]");
  const { draft: a, filePath: aFile } = loadDraft(aInput);
  const b = JSON.parse(stripBom(readFileSync(findDraft(bInput), "utf-8"))) as Draft;

  const offset = a.duration || 0;
  const aSegIds = new Set<string>();
  for (const t of a.tracks) for (const s of t.segments) aSegIds.add(s.id);
  const aMatIds = new Set(indexMaterials(a).keys());

  // 1. Reassign colliding material ids in B, build old->new map.
  const matRemap = new Map<string, string>();
  for (const [, arr] of Object.entries(b.materials)) {
    if (!Array.isArray(arr)) continue;
    for (const mat of arr) {
      const m = mat as { id?: string };
      if (typeof m.id === "string" && aMatIds.has(m.id)) {
        const fresh = uuid();
        matRemap.set(m.id, fresh);
        m.id = fresh;
      }
    }
  }
  // 2. Fix B segments: remap material refs, reassign colliding segment ids, time-shift.
  for (const t of b.tracks) {
    for (const s of t.segments) {
      if (matRemap.has(s.material_id)) s.material_id = matRemap.get(s.material_id) as string;
      s.extra_material_refs = (s.extra_material_refs ?? []).map((r) => matRemap.get(r) ?? r);
      if (aSegIds.has(s.id)) s.id = uuid();
      s.target_timerange = { ...s.target_timerange, start: s.target_timerange.start + offset };
    }
  }
  // 3. Merge B materials into A.
  for (const [type, arr] of Object.entries(b.materials)) {
    if (!Array.isArray(arr)) continue;
    const dest = (a.materials as Record<string, unknown[]>)[type];
    if (Array.isArray(dest)) dest.push(...arr);
    else (a.materials as Record<string, unknown[]>)[type] = [...arr];
  }
  // 4. Merge B tracks into A: same type+name extends; otherwise appended.
  for (const bt of b.tracks) {
    const match = a.tracks.find((at) => at.type === bt.type && at.name === bt.name);
    if (match) match.segments.push(...bt.segments);
    else a.tracks.push(bt);
  }
  a.duration = offset + (b.duration || 0);

  if (flags.out) {
    writeFileSync(flags.out, JSON.stringify(a, null, 2), "utf-8");
    out({ ok: true, out: flags.out, duration_us: a.duration, remapped_ids: matRemap.size }, flags);
  } else {
    saveDraft(aFile, a);
    out({ ok: true, project: aFile, duration_us: a.duration, remapped_ids: matRemap.size }, flags);
  }
}

// `compile` reads a declarative JSON spec and builds a whole draft via the same
// factory functions the imperative add-* commands use. Resolves the bundled
// _init template the same way `init` does.
function cmdCompile(positional: string[], flags: Flags): void {
  const specPath = positional[1];
  if (!specPath) die("Usage: capcut compile <spec.json> [--out <draftdir>] [--drafts <dir>]");
  if (!existsSync(specPath)) die(`Spec file not found: ${specPath}`);

  let spec: CompileSpec;
  try {
    spec = parseSpec(stripBom(readFileSync(specPath, "utf-8")));
  } catch (e) {
    die((e as Error).message);
  }

  if (flags.check || flags.plan) {
    const plan = planCompile(spec, path.dirname(path.resolve(specPath)));
    out({ ...plan, checked: true, write: false }, flags);
    return;
  }

  const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const externalTemplate = path.resolve(cliDir, "..", "CapCutAPI", "template");
  const bundledTemplate = path.join(cliDir, "templates", "_init");
  let templateDir = flags.template ?? externalTemplate;
  if (!flags.template && !existsSync(templateDir) && existsSync(bundledTemplate)) {
    templateDir = bundledTemplate;
  }

  // Target draft directory: --out wins; else <drafts>/<spec.name>; else cwd/<spec.name>.
  const name = spec.name ?? "compiled-draft";
  const draftsDir = flags.drafts ?? `${process.env.HOME || "~"}/Movies/CapCut/User Data/Projects/com.lveditor.draft`;
  const outDir = flags.out ? path.resolve(flags.out) : path.resolve(draftsDir, name);

  const result = compileDraft(spec, {
    templateDir,
    outDir,
    specDir: path.dirname(path.resolve(specPath)),
  });
  out(result, flags);
  if (!flags.quiet) process.stderr.write(`Compiled: ${result.draft_path}\n`);
}

// `render` produces a low-res ffmpeg proxy preview of the timeline. Read-only:
// it never mutates the draft. With --dry-run it returns the ffmpeg plan without
// executing, so the filter graph is inspectable (and the path is ffmpeg-free).
function cmdRender(draft: Draft, filePath: string, flags: Flags): void {
  const opts = {
    out: flags.out,
    scale: flags.scale,
    fps: flags.fps,
    ffmpegCmd: flags.ffmpegCmd,
    burnCaptions: flags.burnCaptions,
    allVideoTracks: flags.allVideoTracks,
    dryRun: isDryRun(),
  };
  if (opts.dryRun) {
    // Build-only: surface the plan; no ffmpeg needed.
    const plan = buildRenderPlan(draft, { ...opts, out: opts.out ?? path.join(path.dirname(filePath), "preview.mp4") });
    out({ ok: true, executed: false, ...plan }, flags);
    return;
  }
  const result = renderDraft(draft, filePath, opts);
  out(result, flags);
  if (!flags.quiet) process.stderr.write(`Rendered: ${result.output}\n`);
}

function cmdDetectScenes(positional: string[], flags: Flags): void {
  const videoPath = positional[1];
  if (!videoPath) {
    die("Missing video. Usage: capcut detect-scenes <video> [--threshold <0..1>] [--min-gap <seconds>] [--limit <n>]");
  }
  const threshold = flags.threshold ?? 0.4;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) die("--threshold must be in (0, 1]");
  const minGap = flags.minGap ?? 2;
  if (!Number.isFinite(minGap) || minGap < 0) die("--min-gap must be >= 0 seconds");
  if (flags.limit !== undefined && (!Number.isFinite(flags.limit) || flags.limit < 1)) {
    die("--limit must be a positive integer");
  }
  const report = detectScenes(videoPath, {
    threshold,
    minGap,
    limit: flags.limit,
    ffmpegCmd: flags.ffmpegCmd,
    ffprobeCmd: flags.ffprobeCmd,
  });
  // --json forces machine output even when a config/alias turned on --human.
  if (flags.human && !flags.json) {
    console.log(`Video:     ${report.video}`);
    const durationNote =
      report.duration_source === "video-stream"
        ? " (video stream)"
        : report.duration_source === "container"
          ? " (container header — ffprobe unavailable; may include audio past the video track)"
          : "";
    console.log(
      `Duration:  ${report.duration === null ? "unknown" : formatDuration(report.duration_us ?? 0)}${durationNote}`,
    );
    console.log(
      `Threshold: ${report.threshold}  (min gap ${report.min_gap}s${report.limit ? `, limit ${report.limit}` : ""})`,
    );
    console.log(`Cuts:      ${report.cuts.length}`);
    for (const [i, c] of report.cuts.entries()) {
      console.log(`  ${String(i + 1).padStart(3)}  ${c.timecode}  score ${c.score.toFixed(3)}`);
    }
    console.log(`Segments:  ${report.segments.length}`);
    for (const [i, s] of report.segments.entries()) {
      const end = s.end === null ? "end" : timecode(s.end);
      const dur = s.duration_us === null ? "?" : formatDuration(s.duration_us);
      console.log(`  ${String(i + 1).padStart(3)}  ${timecode(s.start)} - ${end}  ${dur}`);
    }
    console.log(
      "Next: pipe the segments into `capcut compile` (one clip per segment) or `capcut cut` to split the video.",
    );
    return;
  }
  out(report, flags);
}

// --- Main ---

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw[0] === "--help" || raw[0] === "-h") {
    console.log(`${HELP}\n\nGenerated command index:\n${renderCommandIndex(commandSpecs())}`);
    process.exit(0);
  }

  const { positional, flags } = parseFlags(raw);

  // .capcutrc defaults fill in unset flags (CLI flags always win).
  applyConfig(flags, loadConfig().config);

  // Global --dry-run: gate every saveDraft write (see src/draft.ts).
  setDryRun(flags.dryRun === true);
  setForceWrite(flags.forceWrite === true);

  if (flags.version) {
    console.log(getCliVersion());
    process.exit(0);
  }
  const cmd = positional[0];

  if (cmd === "completions") {
    const shell = positional[1];

    switch (shell) {
      case "bash":
        process.stdout.write(bashCompletion());
        break;
      case "zsh":
        process.stdout.write(zshCompletion());
        break;
      case "fish":
        process.stdout.write(fishCompletion());
        break;
      default:
        die("Usage: capcut completions <bash|zsh|fish>");
    }

    process.exit(0);
  }

  const projectPath = positional[1];

  // `enums` is a pure lookup — no project needed.
  if (cmd === "enums") {
    cmdEnums(flags);
    process.exit(0);
  }

  // `doctor` inspects the environment, not a draft — no project needed.
  if (cmd === "doctor") {
    process.exit(cmdDoctor(flags) ? 0 : 1);
  }

  // `diagnose` must inspect unreadable/divergent sibling files before loadDraft.
  if (cmd === "diagnose") {
    cmdDiagnose(projectPath, flags);
    process.exit(0);
  }

  // `fixture` reads raw (possibly modern-storage) files and writes a redacted bundle — no loadDraft.
  if (cmd === "fixture") {
    if (!projectPath) die("Usage: capcut fixture <project> --out <dir>");
    if (!flags.out) die("Missing --out <dir>. Usage: capcut fixture <project> --out <dir>");
    const report = sanitizeDraftBundle(projectPath, flags.out);
    out(report, flags);
    if (!flags.quiet) {
      const total = Object.values(report.redaction_kinds).reduce((a, b) => a + b, 0);
      process.stderr.write(`Sanitized bundle: ${report.out_dir} (${report.files.length} files, ${total} redactions)\n`);
      process.stderr.write(`Review the files, then attach the folder to issue #35.\n`);
    }
    process.exit(0);
  }

  // `register` reads draft_content.json directly — no loadDraft: the draft may
  // be missing exactly the sidecar files sibling discovery would look at.
  if (cmd === "register") {
    process.exit(cmdRegister(projectPath, flags));
  }

  // `sync-timelines` must see drifted/unreadable siblings itself — loadDraft would
  // pick template-2.tmp as canonical on modern storage, the opposite of the repair.
  if (cmd === "sync-timelines") {
    process.exit(cmdSyncTimelines(projectPath, flags));
  }

  // `restore` copies a backup/snapshot back over the draft — no loadDraft/parse needed.
  if (cmd === "restore") {
    cmdRestore(projectPath, flags);
    process.exit(0);
  }

  // `describe` emits the tool spec — no project needed.
  if (cmd === "describe") {
    cmdDescribe(flags);
    process.exit(0);
  }

  // `projects` scans the disk for draft folders — no single project needed.
  if (cmd === "projects") {
    cmdProjects(positional, flags);
    process.exit(0);
  }

  // `diff` reads two drafts; `concat` reads two and writes one — handled directly.
  if (cmd === "diff") {
    cmdDiff(positional, flags);
    process.exit(0);
  }
  if (cmd === "concat") {
    cmdConcat(positional, flags);
    process.exit(0);
  }

  // `config` just reports the resolved .capcutrc — no project needed.
  if (cmd === "config") {
    cmdConfig(flags);
    process.exit(0);
  }

  // `serve` reads jobs from stdin/queue file — no project needed.
  if (cmd === "serve") {
    await cmdServe(flags);
    process.exit(0);
  }

  // `decrypt` operates on a raw file (which may be unparseable) — skip loadDraft.
  if (cmd === "decrypt") {
    cmdDecrypt(positional, flags);
    process.exit(0);
  }

  // `export` iterates a directory of drafts — projectPath is the directory itself, not a single draft.
  if (cmd === "export") {
    cmdExport(positional, flags);
    process.exit(0);
  }

  // `templates` list all available templates
  if (cmd === "templates") {
    cmdTemplates(flags);
    process.exit(0);
  }

  // init doesn't need an existing project
  if (cmd === "init") {
    const name = projectPath; // positional[1] is the name for init
    if (!name) die("Missing name. Usage: capcut init <name> [--template <dir>] [--drafts <dir>]");
    const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    // Default template resolution: user --template > ../CapCutAPI/template > bundled _init template
    const externalTemplate = path.resolve(cliDir, "..", "CapCutAPI", "template");
    const bundledTemplate = path.join(cliDir, "templates", "_init");
    let templateDir = flags.template ?? externalTemplate;
    if (!flags.template && !existsSync(templateDir) && existsSync(bundledTemplate)) {
      templateDir = bundledTemplate;
    }
    const draftsDir = flags.drafts ?? `${process.env.HOME || "~"}/Movies/CapCut/User Data/Projects/com.lveditor.draft`;
    const result = initDraft({ name, templateDir, draftsDir });
    out(
      { ok: true, name, draft_path: result.draftPath, file_path: result.filePath, registered: result.registered },
      flags,
    );
    if (!flags.quiet) {
      process.stderr.write(`Created: ${result.draftPath}\n`);
      if (result.registered) {
        process.stderr.write(`Registered in CapCut's project list — restart CapCut to see it.\n`);
      } else {
        process.stderr.write(`Note: could not update root_meta_info.json, so CapCut may not list this draft.\n`);
      }
    }
    process.exit(0);
  }

  // `quickstart` creates a draft (like init) and adds one input — projectPath is the name.
  if (cmd === "quickstart") {
    const name = projectPath; // positional[1] is the name
    if (!name) {
      die("Missing name. Usage: capcut quickstart <name> [--video <f>] [--audio <f>] [--srt <f>] [--drafts <dir>]");
    }
    const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const externalTemplate = path.resolve(cliDir, "..", "CapCutAPI", "template");
    const bundledTemplate = path.join(cliDir, "templates", "_init");
    let templateDir = flags.template ?? externalTemplate;
    if (!flags.template && !existsSync(templateDir) && existsSync(bundledTemplate)) {
      templateDir = bundledTemplate;
    }
    const draftsDir = flags.drafts ?? `${process.env.HOME || "~"}/Movies/CapCut/User Data/Projects/com.lveditor.draft`;
    const result = runQuickstart({
      name,
      templateDir,
      draftsDir,
      video: flags.video,
      audio: flags.audio,
      srt: flags.srt,
      ffprobeCmd: flags.ffprobeCmd,
    });
    out(result, flags);
    if (!flags.quiet) {
      for (const step of result.steps) {
        process.stderr.write(`${step.ok ? "✓" : "✗"} ${step.step}: ${step.detail}\n`);
      }
      process.stderr.write("\nNext:\n");
      for (const line of result.open_hint) process.stderr.write(`  ${line}\n`);
    }
    process.exit(result.ok ? 0 : 2);
  }

  // `compile` builds a brand-new draft from a declarative spec — no existing project.
  if (cmd === "compile") {
    cmdCompile(positional, flags);
    process.exit(0);
  }

  // `detect-scenes` analyzes a raw video file for cut points — no draft needed.
  if (cmd === "detect-scenes") {
    cmdDetectScenes(positional, flags);
    process.exit(0);
  }

  if (!projectPath) die("Missing project path. Run 'capcut --help' for usage.");

  const { draft, filePath } = loadDraft(projectPath);

  switch (cmd) {
    case "info":
      cmdInfo(draft, flags);
      break;
    case "prune":
      cmdPrune(draft, filePath, flags);
      break;
    case "relink":
      cmdRelink(draft, filePath, flags);
      break;
    case "replace-media":
      requireArgs(positional, 4, "capcut replace-media <project> <segment-id> <new-file> [--retime]");
      cmdReplaceMedia(draft, filePath, positional, flags);
      break;
    case "timeline":
      cmdTimeline(draft, flags);
      break;
    case "render":
      cmdRender(draft, filePath, flags);
      break;
    case "version":
      cmdVersion(draft, flags);
      break;
    case "lint": {
      const { exitCode } = cmdLint(draft, filePath, flags);
      process.exit(exitCode);
      break;
    }
    case "tracks":
      cmdTracks(draft, flags);
      break;
    case "segments":
      cmdSegments(draft, flags);
      break;
    case "texts":
      cmdTexts(draft, flags);
      break;
    case "set-text":
      requireArgs(positional, 4, "capcut set-text <project> <id> <text>");
      cmdSetText(draft, filePath, positional[2], positional.slice(3).join(" "), flags);
      break;
    case "shift":
      requireArgs(positional, 4, "capcut shift <project> <id> <offset>");
      cmdShift(draft, filePath, positional[2], positional[3], flags);
      break;
    case "shift-all":
      requireArgs(positional, 3, "capcut shift-all <project> <offset> [--track <type>]");
      cmdShiftAll(draft, filePath, positional[2], flags);
      break;
    case "speed":
      requireArgs(positional, 4, "capcut speed <project> <id> <multiplier>");
      cmdSpeed(draft, filePath, positional[2], positional[3], flags);
      break;
    case "volume":
      requireArgs(positional, 4, "capcut volume <project> <id> <level>");
      cmdVolume(draft, filePath, positional[2], positional[3], flags);
      break;
    case "trim":
      requireArgs(positional, 5, "capcut trim <project> <id> <start> <duration>");
      cmdTrim(draft, filePath, positional[2], positional[3], positional[4], flags);
      break;
    case "opacity":
      requireArgs(positional, 4, "capcut opacity <project> <id> <alpha>");
      cmdOpacity(draft, filePath, positional[2], positional[3], flags);
      break;
    case "export-srt":
      cmdExportSrt(draft, flags);
      break;
    case "materials":
      cmdMaterials(draft, flags);
      break;
    case "segment":
      requireArgs(positional, 3, "capcut segment <project> <id>");
      cmdSegmentDetail(draft, positional[2], flags);
      break;
    case "material":
      requireArgs(positional, 3, "capcut material <project> <id>");
      cmdMaterialDetail(draft, positional[2], flags);
      break;
    case "add-audio":
      requireArgs(positional, 4, "capcut add-audio <project> <file-or-wikimedia-url> <start> [duration]");
      await cmdAddAudio(draft, filePath, positional, flags);
      break;
    case "add-video":
      requireArgs(positional, 4, "capcut add-video <project> <file-or-wikimedia-url> <start> [duration]");
      await cmdAddVideo(draft, filePath, positional, flags);
      break;
    case "add-text":
      requireArgs(positional, 5, "capcut add-text <project> <start> <duration> <text>");
      cmdAddText(draft, filePath, positional, flags);
      break;
    case "crop":
      requireArgs(positional, 3, "capcut crop <project> <segment-id> [--ratio <r> | --rect <x,y,w,h> | --reset]");
      cmdCrop(draft, filePath, positional, flags);
      break;
    case "cut":
      requireArgs(positional, 4, "capcut cut <project> <start> <end> --out <path>");
      cmdCut(draft, filePath, positional, flags);
      break;
    case "duplicate":
      requireArgs(positional, 3, "capcut duplicate <project> <segment-id> [--track <track-name>] [--new-track]");
      cmdDuplicate(draft, filePath, positional, flags);
      break;
    case "keyframe":
      requireArgs(positional, 3, "capcut keyframe <project> <id> <property> <time> <value>");
      cmdKeyframe(draft, filePath, positional, flags);
      break;
    case "transition":
      requireArgs(positional, 4, "capcut transition <project> <id> <slug> [--duration <s>]");
      cmdTransition(draft, filePath, positional, flags);
      break;
    case "mask":
      requireArgs(positional, 3, "capcut mask <project> <id> <slug> [flags]  |  --off");
      cmdMask(draft, filePath, positional, flags);
      break;
    case "bg-blur":
      requireArgs(positional, 3, "capcut bg-blur <project> <id> <1|2|3|4>  |  --off");
      cmdBgBlur(draft, filePath, positional, flags);
      break;
    case "text-style":
      requireArgs(positional, 3, "capcut text-style <project> <id> [flags]");
      cmdTextStyle(draft, filePath, positional, flags);
      break;
    case "text-anim":
      requireArgs(positional, 3, "capcut text-anim <project> <id> [--intro <slug>] [--outro <slug>]");
      cmdTextAnim(draft, filePath, positional, flags);
      break;
    case "image-anim":
      requireArgs(positional, 3, "capcut image-anim <project> <id> [--intro <slug>] [--outro <slug>] [--combo <slug>]");
      cmdImageAnim(draft, filePath, positional, flags);
      break;
    case "add-sticker":
      requireArgs(positional, 5, "capcut add-sticker <project> <resource-id> <start> <duration>");
      cmdAddSticker(draft, filePath, positional, flags);
      break;
    case "mix-mode":
      requireArgs(positional, 4, "capcut mix-mode <project> <segment-id> <mode>");
      cmdMixMode(draft, filePath, positional, flags);
      break;
    case "audio-fade":
      requireArgs(positional, 3, "capcut audio-fade <project> <segment-id> [--in <sec>] [--fade-out <sec>]");
      cmdAudioFade(draft, filePath, positional, flags);
      break;
    case "add-cover":
      requireArgs(positional, 3, "capcut add-cover <project> <image-path> [--time <ms>]");
      cmdAddCover(draft, filePath, positional, flags);
      break;
    case "add-filter":
      requireArgs(positional, 5, "capcut add-filter <project> <slug> <start> <duration>");
      cmdAddFilter(draft, filePath, positional, flags);
      break;
    case "bubble-text":
      requireArgs(positional, 3, "capcut bubble-text <project> <text-segment-id> --bubble <slug>");
      cmdBubbleText(draft, filePath, positional, flags);
      break;
    case "add-effect":
      requireArgs(positional, 5, "capcut add-effect <project> <slug> <start> <duration>");
      cmdAddEffect(draft, filePath, positional, flags);
      break;
    case "save-template":
      requireArgs(positional, 4, "capcut save-template <project> <id> <name> --out <path>");
      cmdSaveTemplate(draft, positional, flags);
      break;
    case "apply-template":
      requireArgs(positional, 5, "capcut apply-template <project> <template.json> <start> <duration>");
      cmdApplyTemplate(draft, filePath, positional, flags);
      break;
    case "make-preset":
      requireArgs(positional, 3, "capcut make-preset <project> <text-segment-id> --out <preset.json>");
      cmdMakePreset(draft, positional, flags);
      break;
    case "batch":
      cmdBatch(draft, filePath, flags);
      break;
    case "import-srt":
      requireArgs(positional, 3, "capcut import-srt <project> <srt-path-or-->");
      cmdImportSrt(draft, filePath, positional, flags);
      break;
    case "import-ass":
      requireArgs(positional, 3, "capcut import-ass <project> <ass-path-or-->");
      cmdImportAss(draft, filePath, positional, flags);
      break;
    case "text-ranges":
      requireArgs(positional, 3, "capcut text-ranges <project> <id> --styles @path.json");
      cmdTextRanges(draft, filePath, positional, flags);
      break;
    case "caption":
      cmdCaption(draft, filePath, flags);
      break;
    case "translate":
      await cmdTranslate(draft, filePath, flags);
      break;
    case "migrate":
      cmdMigrate(draft, filePath, flags);
      break;
    case "add-sfx":
      requireArgs(positional, 5, "capcut add-sfx <project> <slug> <start> <duration>");
      cmdAddSfx(draft, filePath, positional, flags);
      break;
    case "chroma":
      requireArgs(positional, 3, "capcut chroma <project> <id> --color <#RRGGBB>  |  --off");
      cmdChroma(draft, filePath, positional, flags);
      break;
    default:
      die(`Unknown command: ${cmd}. Run 'capcut --help' for usage.`);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`${JSON.stringify({ error: msg })}\n`);
  process.exit(1);
});
