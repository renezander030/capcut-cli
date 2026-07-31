export type ArgumentType = "string" | "number" | "boolean" | "path" | "time" | "id" | "json" | "enum";

export interface ArgumentSpec {
  name: string;
  type: ArgumentType;
  required: boolean;
  description?: string;
}

export interface OptionSpec extends ArgumentSpec {
  flags: string[];
  default?: string | number | boolean | null;
  values?: string[];
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  positionals: ArgumentSpec[];
  options: OptionSpec[];
  mutates: boolean;
  prerequisites: string[];
  output: { type: "object" | "array" | "jsonl" | "text" | "file"; description: string };
  exit_codes: Record<string, string>;
}

export const GLOBAL_OPTION_SPECS: OptionSpec[] = [
  {
    name: "human",
    flags: ["-H", "--human"],
    type: "boolean",
    required: false,
    default: false,
    description: "Human-readable output instead of JSON.",
  },
  {
    name: "quiet",
    flags: ["-q", "--quiet"],
    type: "boolean",
    required: false,
    default: false,
    description: "Suppress stdout on success.",
  },
  {
    name: "version",
    flags: ["-v", "--version"],
    type: "boolean",
    required: false,
    default: false,
    description: "Print the installed CLI version.",
  },
  {
    name: "dry_run",
    flags: ["--dry-run"],
    type: "boolean",
    required: false,
    default: false,
    description: "Preview a mutating command without writing.",
  },
  {
    name: "jianying",
    flags: ["--jianying"],
    type: "boolean",
    required: false,
    default: false,
    description: "Use the JianYing enum namespace.",
  },
  {
    name: "force_write",
    flags: ["--force-write"],
    type: "boolean",
    required: false,
    default: false,
    description: "Override editor-running, changed-on-disk, and version-boundary safety checks.",
  },
];

const option = (
  name: string,
  flags: string[],
  type: ArgumentType,
  description: string,
  extra: Partial<OptionSpec> = {},
): OptionSpec => ({ name, flags, type, required: false, description, ...extra });

const TRACK = option("track", ["--track", "--type"], "string", "Track or material type filter.");
const TRACK_NAME = option("track_name", ["--track-name"], "string", "Target track name.");
const OUT = option("out", ["--out"], "path", "Output path.");
const FFPROBE = option("ffprobe_cmd", ["--ffprobe-cmd"], "path", "ffprobe binary.");
const STYLE_REF = option("style_ref", ["--style-ref"], "id", "Copy styling from this text segment.");
const PRESET = option(
  "preset",
  ["--preset"],
  "path",
  "Apply a make-preset style preset; explicit flags override preset values.",
);
const TEXT_STYLE: OptionSpec[] = [
  option("font_size", ["--font-size"], "number", "Font size."),
  option("color", ["--color"], "string", "Text colour as #RRGGBB."),
  option("align", ["--align"], "enum", "Text alignment.", { values: ["0", "1", "2"] }),
  option("x", ["--x"], "number", "Horizontal position."),
  option("y", ["--y"], "number", "Vertical position."),
  option("alpha", ["--alpha"], "number", "Text alpha."),
  option("vertical", ["--vertical"], "boolean", "Use vertical text."),
  option("fixed_width", ["--fixed-width"], "number", "Fixed text-box width."),
  option("fixed_height", ["--fixed-height"], "number", "Fixed text-box height."),
  option("shadow", ["--shadow", "--no-shadow"], "boolean", "Enable or disable shadow."),
  option("shadow_alpha", ["--shadow-alpha"], "number", "Shadow alpha."),
  option("shadow_angle", ["--shadow-angle"], "number", "Shadow angle."),
  option("shadow_color", ["--shadow-color"], "string", "Shadow colour."),
  option("shadow_distance", ["--shadow-distance"], "number", "Shadow distance."),
  option("shadow_smoothing", ["--shadow-smoothing"], "number", "Shadow smoothing."),
  option("border_width", ["--border-width"], "number", "Border width."),
  option("border_color", ["--border-color"], "string", "Border colour."),
  option("border_alpha", ["--border-alpha"], "number", "Border alpha."),
  option("bg_color", ["--bg-color"], "string", "Background colour."),
  option("bg_alpha", ["--bg-alpha"], "number", "Background alpha."),
  option("bg_style", ["--bg-style"], "number", "Background style identifier."),
  option("bg_round_radius", ["--bg-round-radius"], "number", "Background corner radius."),
  option("bg_width", ["--bg-width"], "number", "Background width."),
  option("bg_height", ["--bg-height"], "number", "Background height."),
  option("bg_h_offset", ["--bg-h-offset"], "number", "Background horizontal offset."),
  option("bg_v_offset", ["--bg-v-offset"], "number", "Background vertical offset."),
];

const KEYWORD_EMPHASIS: OptionSpec[] = [
  option(
    "color_cycle",
    ["--color-cycle"],
    "string",
    "Rotate the base text colour per cue: comma-separated #RRGGBB list, in order. Wins over --color per cue; independent of keyword emphasis.",
  ),
  option(
    "highlight_words",
    ["--highlight-words"],
    "string",
    "Emphasize case-insensitive whole-word matches per cue: comma-separated words, or @file with one word/phrase per line.",
  ),
  option("keyword_color", ["--keyword-color"], "string", "Emphasis colour for --highlight-words matches.", {
    default: "#FFD700",
  }),
  option(
    "keyword_size",
    ["--keyword-size"],
    "number",
    "Emphasis size for --highlight-words matches, as a multiplier on the cue's base font size.",
    { default: 1.2 },
  ),
];

const usages = {
  info: "capcut info <project>",
  version: "capcut version <project>",
  lint: "capcut lint <project> [options]",
  tracks: "capcut tracks <project>",
  segments: "capcut segments <project> [--track <type>]",
  texts: "capcut texts <project>",
  "set-text": "capcut set-text <project> <id> <text>",
  shift: "capcut shift <project> <id> <offset>",
  "shift-all": "capcut shift-all <project> <offset> [--track <type>]",
  speed: "capcut speed <project> <id> <multiplier>",
  volume: "capcut volume <project> <id> <level>",
  trim: "capcut trim <project> <id> <start> <duration>",
  opacity: "capcut opacity <project> <id> <alpha>",
  "export-srt": "capcut export-srt <project> [options]",
  "export-timeline": "capcut export-timeline <project> [--out <file.otio>]",
  materials: "capcut materials <project> [--type <type>]",
  segment: "capcut segment <project> <id>",
  material: "capcut material <project> <id>",
  "add-audio": "capcut add-audio <project> <file-or-url> <start> [duration] [options]",
  "add-video": "capcut add-video <project> <file-or-url> <start> [duration] [options]",
  "add-text": "capcut add-text <project> <start> <duration> <text> [options]",
  crop: "capcut crop <project> <segment-id> [--ratio <r> | --rect <x,y,w,h> | --reset]",
  cut: "capcut cut <project> <start> <end> --out <path>",
  duplicate: "capcut duplicate <project> <segment-id> [--track <track-name>] [--new-track]",
  remove: "capcut remove <project> <segment-id> [--keep-track] [--keep-materials]",
  keyframe: "capcut keyframe <project> <id> <property> <time> <value> [--easing <name>] | --batch",
  transition: "capcut transition <project> <id> <slug> [--duration <time>]",
  mask: "capcut mask <project> <id> <slug> [options] | --off",
  "bg-blur": "capcut bg-blur <project> <id> <level> | --off",
  "text-style": "capcut text-style <project> <id> [options]",
  "text-anim": "capcut text-anim <project> <id> [options]",
  "image-anim": "capcut image-anim <project> <id> [options]",
  "add-sticker": "capcut add-sticker <project> <resource-id> <start> <duration> [options]",
  "mix-mode": "capcut mix-mode <project> <id> <mode>",
  "audio-fade": "capcut audio-fade <project> <id> [--in <seconds>] [--fade-out <seconds>]",
  "add-cover": "capcut add-cover <project> <image> [--time <milliseconds>]",
  "add-filter": "capcut add-filter <project> <slug-or-name> (<start> <duration> | --full) [options]",
  "bubble-text": "capcut bubble-text <project> <id> --bubble <slug>",
  "add-effect": "capcut add-effect <project> <slug-or-name> (<start> <duration> | --full) [options]",
  "save-template": "capcut save-template <project> <id> <name> --out <path>",
  "apply-template": "capcut apply-template <project> <template> <start> <duration> [text] [options]",
  "make-preset": "capcut make-preset <project> <text-segment-id> --out <preset.json>",
  batch: "capcut batch <project> [--continue-on-error] < operations.jsonl",
  "import-srt": "capcut import-srt <project> <srt-or-> [options]",
  "import-ass": "capcut import-ass <project> <ass-or-> [options]",
  "text-ranges": "capcut text-ranges <project> <id> --styles <json-or-@file>",
  caption: "capcut caption <project> (--audio <path> | --from-segment <id>) [options]",
  translate: "capcut translate <project> --to <language> --out <path> [options]",
  migrate: "capcut migrate <project> --from <version> --to <version>",
  "add-sfx": "capcut add-sfx <project> <slug> <start> <duration> [options]",
  chroma: "capcut chroma <project> <id> (--color <hex> | --off) [options]",
  prune: "capcut prune <project>",
  register: "capcut register <project-dir> [--apply] [--drafts <dir>]",
  relink: "capcut relink <project> (--dir <path> | --from <prefix> --to <prefix>)",
  timeline: "capcut timeline <project> [--cols <number>]",
  projects: "capcut projects [query] [--drafts <path>] [--names]",
  diff: "capcut diff <project-a> <project-b>",
  concat: "capcut concat <project-a> <project-b> [--out <path>]",
  config: "capcut config",
  describe: "capcut describe",
  completions: "capcut completions <bash|zsh|fish>",
  enums: "capcut enums <category-flag> [--jianying]",
  "harvest-enums": "capcut harvest-enums <project> [--apply] [--catalogue <path>]",
  doctor: "capcut doctor",
  diagnose: "capcut diagnose <project> [--bundle <report.json>]",
  fixture: "capcut fixture <project> --out <dir>",
  "sync-timelines": "capcut sync-timelines <project-dir> [--apply]",
  restore: "capcut restore <project> [--step <number> | --list]",
  serve: "capcut serve [--queue <path>] [options]",
  decrypt: "capcut decrypt <project-or-file>",
  export: "capcut export <drafts-dir> --batch [options]",
  "replace-media": "capcut replace-media <project> <segment-id> <new-file> [--retime]",
  init: "capcut init <name> [--template <dir>] [--drafts <dir>]",
  quickstart: "capcut quickstart <name> [--video <f>] [--audio <f>] [--srt <f>] [--drafts <dir>]",
  compile: "capcut compile <spec.json> [--out <draftdir>] [--check | --plan]",
  render: "capcut render <project> [--out <preview.mp4>] [options]",
  "detect-scenes": "capcut detect-scenes <video> [options]",
} as const satisfies Record<string, string>;

export type CommandName = keyof typeof usages;

export function commandNames(): CommandName[] {
  return Object.keys(usages) as CommandName[];
}

const optionsByCommand: Record<string, OptionSpec[]> = {
  lint: [
    option("max_chars", ["--max-chars"], "number", "Maximum caption characters per line.", { default: 42 }),
    option("max_cue_secs", ["--max-cue-secs"], "number", "Maximum caption duration in seconds.", { default: 7 }),
    option("min_gap_ms", ["--min-gap-ms"], "number", "Minimum caption gap in milliseconds.", { default: 0 }),
    option("no_check_paths", ["--no-check-paths"], "boolean", "Skip local media path checks."),
    option("fix", ["--fix"], "boolean", "Mechanically repair fixable issues and write the draft."),
    option("no_probe", ["--no-probe"], "boolean", "Skip ffprobe media checks (VFR / unreadable media)."),
    FFPROBE,
  ],
  segments: [TRACK],
  "shift-all": [TRACK],
  materials: [TRACK],
  "add-audio": [
    option("volume", ["--volume"], "number", "Audio volume.", { default: 1 }),
    TRACK_NAME,
    option("force_license", ["--force-license"], "boolean", "Allow restrictive or unknown Wikimedia licenses."),
    option("no_probe", ["--no-probe"], "boolean", "Disable automatic media probing."),
    FFPROBE,
  ],
  "add-video": [
    TRACK_NAME,
    option("width", ["--width"], "number", "Source width."),
    option("height", ["--height"], "number", "Source height."),
    option("force_license", ["--force-license"], "boolean", "Allow restrictive or unknown Wikimedia licenses."),
    option("no_probe", ["--no-probe"], "boolean", "Disable automatic media probing."),
    FFPROBE,
  ],
  "add-text": [TRACK_NAME, ...TEXT_STYLE.slice(0, 5), PRESET],
  crop: [
    option(
      "ratio",
      ["--ratio"],
      "enum",
      "Centered maximal crop of this aspect against the source material's stored width/height.",
      { values: ["free", "1:1", "16:9", "9:16", "4:3", "3:4"] },
    ),
    option("rect", ["--rect"], "string", "Explicit normalized crop rect x,y,w,h (0..1); overrides --ratio."),
    option("reset", ["--reset"], "boolean", "Restore the full frame."),
  ],
  cut: [OUT],
  duplicate: [
    option(
      "track",
      ["--track"],
      "string",
      "Place the copy onto this existing same-type track; errors when the target range is occupied there.",
    ),
    option(
      "new_track",
      ["--new-track"],
      "boolean",
      "Create a fresh same-type track directly above the source (the default).",
    ),
  ],
  remove: [
    option("keep_track", ["--keep-track"], "boolean", "Keep the segment's track even when it becomes empty."),
    option("keep_materials", ["--keep-materials"], "boolean", "Skip the orphan-material sweep (run prune later)."),
  ],
  keyframe: [
    option("batch", ["--batch"], "boolean", "Read JSONL keyframes from stdin."),
    option(
      "easing",
      ["--easing"],
      "enum",
      "Interpolation easing to adjacent keyframes. Needs an adjacent keyframe on the same property; a lone eased keyframe stays linear (warns).",
      {
        values: ["linear", "ease-in", "ease-out", "ease-in-out"],
        default: "linear",
      },
    ),
  ],
  transition: [option("duration", ["--duration"], "time", "Transition duration.")],
  mask: [
    option("off", ["--off"], "boolean", "Remove masks."),
    option("center_x", ["--center-x"], "number", "Mask centre X."),
    option("center_y", ["--center-y"], "number", "Mask centre Y."),
    option("size", ["--size"], "number", "Mask size."),
    option("rotation", ["--rotation"], "number", "Mask rotation."),
    option("feather", ["--feather"], "number", "Mask feather."),
    option("invert", ["--invert"], "boolean", "Invert mask."),
    option("rect_width", ["--rect-width"], "number", "Rectangle width."),
    option("round_corner", ["--round-corner"], "number", "Rectangle corner radius."),
    option(
      "mask_field",
      ["--mask-field"],
      "enum",
      "Materials array to write the mask into (default: auto — an already-populated variant, else version evidence).",
      { values: ["masks", "common_mask", "common_masks"] },
    ),
  ],
  "bg-blur": [option("off", ["--off"], "boolean", "Remove background blur.")],
  "text-style": [...TEXT_STYLE, PRESET],
  "text-anim": [
    option("intro", ["--intro"], "enum", "Intro animation."),
    option("outro", ["--outro"], "enum", "Outro animation."),
    option("combo", ["--combo"], "enum", "Loop/combo animation."),
    option("intro_duration", ["--intro-duration"], "time", "Intro duration."),
    option("outro_duration", ["--outro-duration"], "time", "Outro duration."),
    option("combo_duration", ["--combo-duration"], "time", "Combo duration."),
  ],
  "image-anim": [],
  "add-sticker": [
    option("x", ["--x"], "number", "Horizontal position."),
    option("y", ["--y"], "number", "Vertical position."),
    option("scale", ["--scale"], "number", "Uniform scale."),
    option("rotation", ["--rotation"], "number", "Rotation."),
    TRACK_NAME,
  ],
  "audio-fade": [
    option("fade_in", ["--in", "--fade-in"], "number", "Fade-in seconds."),
    option("fade_out", ["--fade-out"], "number", "Fade-out seconds."),
  ],
  "add-cover": [option("time", ["--time"], "number", "Cover timestamp in milliseconds.")],
  "add-filter": [
    TRACK_NAME,
    option("resource_id", ["--resource-id"], "string", "Raw catalogue resource ID (skips slug lookup)."),
    option("effect_id", ["--effect-id"], "string", "Raw effect ID (defaults to --resource-id)."),
    option("intensity", ["--intensity"], "number", "Filter strength 0-1 (default 1)."),
    option("full", ["--full"], "boolean", "Apply to the whole timeline (start 0, duration = draft duration).", {
      default: false,
    }),
  ],
  "bubble-text": [
    option("bubble", ["--bubble"], "enum", "Bubble slug."),
    option("effect_id", ["--effect-id"], "string", "Custom effect ID."),
    option("resource_id", ["--resource-id"], "string", "Custom resource ID."),
  ],
  "add-effect": [
    TRACK_NAME,
    option("params", ["--params"], "json", "Effect parameter array."),
    option("resource_id", ["--resource-id"], "string", "Raw catalogue resource ID (skips slug lookup)."),
    option("effect_id", ["--effect-id"], "string", "Raw effect ID (defaults to --resource-id)."),
    option("intensity", ["--intensity"], "number", "Effect strength 0-1 (default 1)."),
    option("full", ["--full"], "boolean", "Apply to the whole timeline (start 0, duration = draft duration).", {
      default: false,
    }),
    option(
      "bind",
      ["--bind"],
      "string",
      "Experimental: attach to one segment instead of the whole frame (segment ID).",
    ),
  ],
  "save-template": [OUT],
  "make-preset": [OUT],
  "apply-template": [
    option("x", ["--x"], "number", "Horizontal position override."),
    option("y", ["--y"], "number", "Vertical position override."),
  ],
  batch: [
    option(
      "continue_on_error",
      ["--continue-on-error"],
      "boolean",
      "Commit only successful operations and exit 1 if any fail.",
    ),
  ],
  "export-srt": [
    option("granularity", ["--granularity"], "enum", "Cue granularity: one cue per caption or per word.", {
      values: ["line", "word"],
      default: "line",
    }),
    option("format", ["--format"], "enum", "Subtitle output format.", { values: ["srt", "vtt"], default: "srt" }),
  ],
  "export-timeline": [OUT],
  "import-srt": [
    TRACK_NAME,
    STYLE_REF,
    option("time_offset", ["--time-offset"], "time", "Shift imported cues."),
    ...TEXT_STYLE,
    ...KEYWORD_EMPHASIS,
  ],
  "import-ass": [
    TRACK_NAME,
    STYLE_REF,
    option("time_offset", ["--time-offset"], "time", "Shift imported cues."),
    ...TEXT_STYLE,
  ],
  "text-ranges": [option("styles", ["--styles"], "json", "Inline JSON or @file style ranges.")],
  caption: [
    option("audio", ["--audio"], "path", "Audio input."),
    option("from_segment", ["--from-segment"], "id", "Audio segment input."),
    option("whisper_cmd", ["--whisper-cmd"], "path", "Whisper binary."),
    option("whisper_engine", ["--whisper-engine"], "enum", "Whisper CLI dialect.", {
      values: ["openai", "whisper-cpp", "faster-whisper"],
    }),
    option("whisper_model", ["--whisper-model"], "string", "Whisper model."),
    option("language", ["--language"], "string", "Language code."),
    option("karaoke", ["--karaoke"], "boolean", "Create word-highlight caption ranges."),
    option("max_words", ["--max-words"], "number", "Maximum words per cue."),
    option("max_gap_ms", ["--max-gap-ms"], "number", "Maximum gap inside a karaoke cue."),
    TRACK_NAME,
    STYLE_REF,
    PRESET,
    ...KEYWORD_EMPHASIS,
  ],
  translate: [
    option("to", ["--to"], "string", "Target language."),
    option("from", ["--from"], "string", "Source language."),
    OUT,
    option("api_key", ["--api-key"], "string", "Anthropic API key."),
    option("model", ["--model"], "string", "Anthropic model."),
  ],
  migrate: [
    option("from", ["--from"], "string", "Source version."),
    option("to", ["--to"], "string", "Target version."),
  ],
  "add-sfx": [option("volume", ["--volume"], "number", "SFX volume."), TRACK_NAME],
  chroma: [
    option("color", ["--color"], "string", "Chroma colour."),
    option("intensity", ["--intensity"], "number", "Key intensity."),
    option("off", ["--off"], "boolean", "Remove chroma key."),
  ],
  register: [
    option(
      "apply",
      ["--apply"],
      "boolean",
      "Write the repaired draft_meta_info.json / root_meta_info.json entry (default: print the plan only).",
    ),
    option("drafts", ["--drafts"], "path", "Draft store root when the draft does not live inside a known one."),
  ],
  "harvest-enums": [
    option("apply", ["--apply"], "boolean", "Write the new entries into the user catalogue (default: plan only)."),
    option(
      "catalogue",
      ["--catalogue"],
      "path",
      "User catalogue file (default: ~/.config/capcut-cli/user-enums.json, or $CAPCUT_CLI_USER_ENUMS).",
    ),
  ],
  relink: [
    option("dir", ["--dir"], "path", "Directory containing replacement files."),
    option("from", ["--from"], "path", "Old path prefix."),
    option("to", ["--to"], "path", "New path prefix."),
  ],
  timeline: [option("cols", ["--cols"], "number", "Timeline columns.", { default: 60 })],
  projects: [
    option("drafts", ["--drafts"], "path", "Draft root directory."),
    option("names", ["--names"], "boolean", "Read project display names."),
  ],
  concat: [OUT],
  diagnose: [option("bundle", ["--bundle"], "path", "Write a redacted JSON diagnostic bundle.")],
  fixture: [option("out", ["--out"], "path", "Output directory for the sanitized bundle.")],
  "sync-timelines": [
    option(
      "apply",
      ["--apply"],
      "boolean",
      "Rewrite only the drifted mirror files from draft_content.json (default: print the plan only).",
    ),
  ],
  "replace-media": [
    option("retime", ["--retime"], "boolean", "Fit the segment to the new clip instead of preserving in/out."),
    option("ffprobe_cmd", ["--ffprobe-cmd"], "path", "ffprobe binary for duration/dimension detection."),
  ],
  restore: [
    option("step", ["--step"], "number", "Snapshot number."),
    option("list", ["--list"], "boolean", "List snapshots."),
  ],
  serve: [
    option("queue", ["--queue"], "path", "JSONL queue file."),
    option("fail_fast", ["--fail-fast"], "boolean", "Stop after first failure."),
    option("workers", ["--workers"], "number", "Maximum parallel workers."),
    option("retries", ["--retries"], "number", "Retries per job."),
    option("timeout", ["--timeout"], "number", "Job timeout in milliseconds."),
    option("backoff_ms", ["--backoff-ms"], "number", "Initial retry backoff in milliseconds."),
    option("max_buffer_mb", ["--max-buffer-mb"], "number", "Maximum captured output per job in MiB."),
  ],
  export: [
    option("batch", ["--batch"], "boolean", "Export every draft."),
    option("app", ["--app"], "enum", "Target editor.", { values: ["capcut", "jianying"] }),
  ],
  init: [
    option("template", ["--template"], "path", "Template directory."),
    option("drafts", ["--drafts"], "path", "Draft root directory."),
  ],
  quickstart: [
    option("video", ["--video"], "path", "Video or image to add."),
    option("audio", ["--audio"], "path", "Audio file to add."),
    option("srt", ["--srt"], "path", "SRT subtitles to add as caption segments."),
    option("drafts", ["--drafts"], "path", "Draft root directory."),
    option("template", ["--template"], "path", "Template directory."),
    option("ffprobe_cmd", ["--ffprobe-cmd"], "path", "ffprobe binary for duration detection."),
  ],
  compile: [
    OUT,
    option("drafts", ["--drafts"], "path", "Draft root directory."),
    option("template", ["--template"], "path", "Template directory."),
    option("check", ["--check"], "boolean", "Validate without writing."),
    option("plan", ["--plan"], "boolean", "Print the normalized build plan without writing."),
  ],
  render: [
    OUT,
    option("scale", ["--scale"], "number", "Proxy scale.", { default: 0.5 }),
    option("fps", ["--fps"], "number", "Output FPS."),
    option("ffmpeg_cmd", ["--ffmpeg-cmd"], "path", "FFmpeg binary."),
    option("burn_captions", ["--burn-captions"], "boolean", "Burn captions."),
    option("all_video_tracks", ["--all-video-tracks"], "boolean", "Composite every video track."),
  ],
  "detect-scenes": [
    option("threshold", ["--threshold"], "number", "Scene-change score a cut must exceed (0..1).", { default: 0.4 }),
    option("min_gap", ["--min-gap"], "number", "Merge cuts closer than this many seconds, keeping the strongest.", {
      default: 2,
    }),
    option("limit", ["--limit"], "number", "Keep only the N strongest cuts."),
    option("ffmpeg_cmd", ["--ffmpeg-cmd"], "path", "FFmpeg binary."),
    option(
      "ffprobe_cmd",
      ["--ffprobe-cmd"],
      "path",
      "ffprobe binary for the video-stream duration (falls back to the container duration without it).",
    ),
    option("json", ["--json"], "boolean", "Force JSON output (the default; overrides -H)."),
  ],
};
optionsByCommand["image-anim"] = optionsByCommand["text-anim"];

// Flags introduced in this release. parseFlags is a single flat global pass, so
// a value-consuming flag added here would otherwise be stripped from ANY
// command's free-text positionals (e.g. an add-text body containing the
// substring "--limit 5"). These are scoped to the commands that declare them:
//   --easing            -> keyframe
//   --granularity, --format -> export-srt
//   --preset            -> add-text, text-style, caption
//   --apply             -> register, sync-timelines
//   --ratio, --rect, --reset -> crop
//   --threshold, --min-gap, --limit, --json -> detect-scenes
//   --highlight-words, --keyword-color, --keyword-size, --color-cycle
//                       -> caption, import-srt (v0.14 keyword emphasis)
//   --new-track          -> duplicate
//   --keep-track, --keep-materials -> remove
//   --full               -> add-filter, add-effect (v0.15 whole-timeline range)
//   --bind               -> add-effect (v0.15 per-segment attachment)
//   --mask-field         -> mask (v0.16 explicit mask array variant)
//   --catalogue          -> harvest-enums (v0.16 user catalogue path)
// Everywhere else they fall through to the positional stream verbatim, matching
// pre-release behaviour where these tokens were unknown and preserved.
export const RELEASE_SCOPED_FLAGS: ReadonlySet<string> = new Set([
  "--apply",
  "--bind",
  "--catalogue",
  "--color-cycle",
  "--easing",
  "--format",
  "--full",
  "--granularity",
  "--highlight-words",
  "--json",
  "--keep-materials",
  "--keep-track",
  "--keyword-color",
  "--keyword-size",
  "--limit",
  "--mask-field",
  "--min-gap",
  "--new-track",
  "--preset",
  "--ratio",
  "--rect",
  "--reset",
  "--threshold",
]);

/** True when `command` declares `flag` among its command-specific options. */
export function commandDeclaresFlag(command: string | undefined, flag: string): boolean {
  if (command === undefined) return false;
  const opts = optionsByCommand[command];
  return opts?.some((o) => o.flags.includes(flag)) ?? false;
}

const mutating = new Set([
  "set-text",
  "shift",
  "shift-all",
  "speed",
  "volume",
  "trim",
  "opacity",
  "add-audio",
  "add-video",
  "add-text",
  "crop",
  "cut",
  "duplicate",
  "remove",
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
  "apply-template",
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
  "sync-timelines",
  "concat",
  "restore",
  "export",
  "init",
  "quickstart",
  "compile",
]);

const arrayOutputs = new Set(["tracks", "segments", "texts", "materials", "enums", "templates"]);
const textOutputs = new Set(["export-srt", "export-timeline", "completions"]);
const fileOutputs = new Set(["render", "translate", "compile", "cut", "save-template", "make-preset"]);

function inferType(name: string): ArgumentType {
  if (/project|file|path|dir|template|audio|video|image|srt|ass|spec|draft/i.test(name)) return "path";
  if (/^(id|segment-id|resource-id)$/.test(name)) return "id";
  if (/start|end|duration|offset|time/.test(name)) return "time";
  if (/level|multiplier|alpha|value/.test(name)) return "number";
  return "string";
}

function positionalsFromUsage(usage: string): ArgumentSpec[] {
  const args: ArgumentSpec[] = [];
  const seen = new Set<string>();
  for (const match of usage.matchAll(/<([^>]+)>/g)) {
    const name = match[1];
    const previousToken = usage.slice(0, match.index).trim().split(/\s+/).at(-1) ?? "";
    if (name.includes("|") || name.startsWith("--") || previousToken.startsWith("--") || seen.has(name)) continue;
    seen.add(name);
    const before = usage.slice(0, match.index);
    const bracketStart = before.lastIndexOf("[");
    const bracketEnd = before.lastIndexOf("]");
    args.push({ name, type: inferType(name), required: bracketStart <= bracketEnd });
  }
  for (const match of usage.matchAll(/\[([a-z][a-z0-9_-]*)\]/gi)) {
    const name = match[1];
    if (name === "options" || seen.has(name)) continue;
    seen.add(name);
    args.push({ name, type: inferType(name), required: false });
  }
  return args;
}

export function buildCommandSpecs(commands: readonly string[], summaries: Record<string, string>): CommandSpec[] {
  return commands.map((name) => {
    const usage = usages[name as CommandName] ?? `capcut ${name} <project>`;
    const prerequisites: string[] = [];
    if (name === "render" || name === "detect-scenes") prerequisites.push("ffmpeg");
    if (["add-video", "add-audio", "compile", "detect-scenes"].includes(name)) prerequisites.push("ffprobe (optional)");
    if (name === "caption") prerequisites.push("whisper CLI");
    if (name === "translate") prerequisites.push("ANTHROPIC_API_KEY or --api-key");
    if (["add-video", "add-audio"].includes(name)) prerequisites.push("network for Wikimedia URLs only");
    const exitCodes: Record<string, string> = { "0": "success", "1": "invalid input, warning, or operation failure" };
    if (name === "lint") exitCodes["2"] = "lint errors";
    if (name === "decrypt") exitCodes["2"] = "encrypted draft detected";
    return {
      name,
      summary: summaries[name] ?? "",
      usage,
      positionals: positionalsFromUsage(usage),
      options: optionsByCommand[name] ?? [],
      mutates: mutating.has(name),
      prerequisites,
      output: {
        type: arrayOutputs.has(name)
          ? "array"
          : textOutputs.has(name)
            ? "text"
            : fileOutputs.has(name)
              ? "file"
              : name === "serve"
                ? "jsonl"
                : "object",
        description: textOutputs.has(name)
          ? "Plain text on stdout."
          : "JSON by default; use -H where supported for human output.",
      },
      exit_codes: exitCodes,
    };
  });
}

export function completionWords(specs: CommandSpec[]): string[] {
  return [
    ...specs.map((spec) => spec.name),
    ...GLOBAL_OPTION_SPECS.flatMap((spec) => spec.flags),
    ...specs.flatMap((spec) => spec.options.flatMap((item) => item.flags)),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

export function renderCommandIndex(specs: CommandSpec[]): string {
  return specs.map((spec) => `  ${spec.usage.padEnd(76)} ${spec.summary}`).join("\n");
}
