import { existsSync, lstatSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { stripBom } from "./bom.js";
import {
  addKeyframes,
  addTransition,
  resolveEasing,
  setTextRanges,
  setTextStyle,
  type TextRangeInput,
  type TextStyleOptions,
} from "./decorators.js";
import { type Draft, findSegment, loadDraft, saveDraft } from "./draft.js";
import {
  addAudio,
  addEffect,
  addFilter,
  addText,
  addVideo,
  applyTemplate,
  copyTextStyle,
  initDraft,
  registerDraftInIndex,
  resolveCanvas,
  setAudioFade,
} from "./factory.js";
import { type MediaProbe, probeMedia } from "./probe.js";
import { parseSrt } from "./srt.js";

/**
 * Declarative draft compiler: a spec file -> a guaranteed-valid CapCut draft.
 *
 * The inverse of `describe`. Instead of an agent chaining 30 mutating commands
 * (each a place to drift), it emits one declarative spec and `compile` builds
 * the draft atomically via the same proven factory functions the imperative
 * `add-*` commands use. The draft is the compile target.
 *
 * Times in the spec are in SECONDS (human/LLM friendly); they are converted to
 * CapCut's microsecond unit here. Media paths are resolved relative to the spec
 * file's directory unless absolute. The compiler validates the whole spec up
 * front, so a bad path or shape fails before any draft is written.
 *
 * Spec shape (JSON):
 * {
 *   "name": "My Short",
 *   "width": 1080, "height": 1920, "fps": 30, "ratio": "9:16",
 *   "tracks": [
 *     { "type": "video", "items": [
 *       { "path": "clip1.mp4", "start": 0, "duration": 3 },
 *       { "path": "photo.png", "start": 3, "duration": 2, "type": "photo" }
 *     ] },
 *     { "type": "audio", "items": [
 *       { "path": "music.mp3", "start": 0, "duration": 5, "volume": 0.4 }
 *     ] },
 *     { "type": "text", "items": [
 *       { "text": "Hook line", "start": 0, "duration": 2, "fontSize": 18, "color": "#FFD700", "y": -0.6 }
 *     ] }
 *   ]
 * }
 */

const US = 1_000_000;

export interface CompileItem {
  ref?: string;
  path?: string;
  text?: string;
  start: number; // seconds
  duration?: number; // seconds (video/text required; audio 0 = whole file)
  volume?: number;
  fontSize?: number;
  color?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  type?: "video" | "photo";
  sourceStart?: number;
  speed?: number;
  opacity?: number;
  rotation?: number;
  scale?: number;
}

export interface CompileTrack {
  type: "video" | "audio" | "text";
  name?: string;
  items: CompileItem[];
}

export interface CompileSpec {
  name?: string;
  width?: number;
  height?: number;
  fps?: number;
  ratio?: string;
  tracks: CompileTrack[];
  operations?: CompileOperation[];
}

export type CompileOperation =
  | { op: "transition"; target: string; slug: string; duration?: number; jianying?: boolean }
  | {
      op: "filter";
      slug: string;
      start: number;
      duration: number;
      intensity?: number;
      trackName?: string;
      jianying?: boolean;
    }
  | {
      op: "effect";
      slug: string;
      start: number;
      duration: number;
      params?: number[];
      trackName?: string;
      jianying?: boolean;
    }
  | { op: "keyframe"; target: string; property: string; time: number; value: number; easing?: string }
  | { op: "audio-fade"; target: string; fadeIn?: number; fadeOut?: number }
  | { op: "text-style"; target: string; style: TextStyleOptions }
  | { op: "text-ranges"; target: string; ranges: TextRangeInput[] }
  | { op: "template"; path: string; start: number; duration: number; text?: string; ref?: string }
  | { op: "captions"; path: string; trackName?: string; styleRef?: string; timeOffset?: number };

export interface CompileOptions {
  templateDir: string; // bundled _init template
  outDir: string; // target draft directory (must not already exist)
  specDir: string; // directory the spec lives in, for relative path resolution
  /** Store seeding mode handed to initDraft (see InitOptions.seed). */
  seed?: "auto" | "always" | "off";
}

export interface CompileResult {
  ok: boolean;
  name: string;
  draft_path: string;
  /** Where the draft's skeleton came from (the store's newest project, or a template directory). */
  template: import("./factory.js").TemplateReport;
  file_path: string;
  tracks: number;
  segments: number;
  duration_us: number;
  warnings: string[];
  refs: Record<string, string>;
}

export interface CompilePlan {
  ok: boolean;
  name: string;
  canvas: { width: number; height: number; fps: number; ratio: string };
  tracks: number;
  items: number;
  operations: number;
  refs: string[];
  media: string[];
}

const VALID_TRACK_TYPES = new Set(["video", "audio", "text"]);

/**
 * A spec's `name` is not just a label: it becomes a DIRECTORY inside the draft
 * store (`resolve(draftsDir, name)`), and with `--data` every row derives its
 * own from row data. The spec and the rows are untrusted input, so a name
 * shaped like a path — `../../elsewhere`, `/etc/x`, `C:\Windows` — would build
 * the draft outside the store. Refuse the same shapes `rename` refuses for a
 * folder name (factory.ts): a plain, non-empty component and nothing else.
 *
 * Containment follows from the shape, tolerant of either OS's separator the
 * way store.ts/factory.ts compare paths: with no `/` or `\` in it, and no
 * drive prefix, `resolve(dir, name)` can only ever be `dir`'s own child. The
 * drive test refuses the whole `X:` prefix, not just `X:\` — `C:name` carries
 * no separator yet resolve() still sends it to that drive's cwd on Windows.
 */
function validateDraftName(name: unknown): void {
  // Absent (or JSON null) means "use the caller's default name" — nothing to check.
  if (name === undefined || name === null) return;
  if (typeof name !== "string") {
    throw new Error(`compile: spec.name must be a string (got ${typeof name})`);
  }
  if (name.trim() === "" || name === "." || name === "..") {
    throw new Error(`compile: spec.name must be a non-empty folder name (got "${name}")`);
  }
  if (/[/\\]/.test(name) || /^[A-Za-z]:/.test(name)) {
    throw new Error(
      `compile: spec.name takes a plain folder name, not a path (got "${name}"). ` +
        "The draft is built inside the draft store, or wherever --out names.",
    );
  }
}

export function parseSpec(raw: string): CompileSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`compile: spec is not valid JSON: ${(e as Error).message}`);
  }
  validateSpec(parsed);
  return parsed as CompileSpec;
}

export function validateSpec(spec: unknown): asserts spec is CompileSpec {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("compile: spec must be a JSON object");
  const s = spec as Record<string, unknown>;
  validateDraftName(s.name);
  resolveCanvas(s as unknown as CompileSpec);
  if (s.fps !== undefined && (typeof s.fps !== "number" || !Number.isFinite(s.fps) || s.fps <= 0)) {
    throw new Error("compile: spec.fps must be a finite number > 0");
  }
  if (!Array.isArray(s.tracks) || s.tracks.length === 0) {
    throw new Error("compile: spec.tracks must be a non-empty array");
  }
  s.tracks.forEach((t, ti) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(`compile: tracks[${ti}] must be an object`);
    const track = t as Record<string, unknown>;
    if (typeof track.type !== "string" || !VALID_TRACK_TYPES.has(track.type)) {
      throw new Error(`compile: tracks[${ti}].type must be one of video|audio|text (got ${String(track.type)})`);
    }
    if (!Array.isArray(track.items) || track.items.length === 0) {
      throw new Error(`compile: tracks[${ti}].items must be a non-empty array`);
    }
    if (track.name !== undefined && typeof track.name !== "string") {
      throw new Error(`compile: tracks[${ti}].name must be a string`);
    }
    track.items.forEach((it, ii) => {
      const where = `tracks[${ti}].items[${ii}]`;
      if (!it || typeof it !== "object" || Array.isArray(it)) {
        throw new Error(`compile: ${where} must be an object`);
      }
      const item = it as Record<string, unknown>;
      if (typeof item.start !== "number" || !Number.isFinite(item.start) || item.start < 0) {
        throw new Error(`compile: ${where}.start must be a number >= 0 (seconds)`);
      }
      if (item.ref !== undefined && (typeof item.ref !== "string" || item.ref.length === 0)) {
        throw new Error(`compile: ${where}.ref must be a non-empty string`);
      }
      for (const field of [
        "speed",
        "opacity",
        "rotation",
        "scale",
        "sourceStart",
        "volume",
        "fontSize",
        "x",
        "y",
        "width",
        "height",
      ] as const) {
        if (item[field] !== undefined && (typeof item[field] !== "number" || !Number.isFinite(item[field]))) {
          throw new Error(`compile: ${where}.${field} must be a number`);
        }
      }
      if (typeof item.sourceStart === "number" && item.sourceStart < 0) {
        throw new Error(`compile: ${where}.sourceStart must be >= 0`);
      }
      if (typeof item.speed === "number" && item.speed <= 0) {
        throw new Error(`compile: ${where}.speed must be > 0`);
      }
      if (item.type !== undefined && item.type !== "video" && item.type !== "photo") {
        throw new Error(`compile: ${where}.type must be video or photo`);
      }
      if (item.color !== undefined) validateColor(item.color, `${where}.color`);
      for (const field of ["fontSize", "width", "height"] as const) {
        if (typeof item[field] === "number" && item[field] <= 0) {
          throw new Error(`compile: ${where}.${field} must be > 0`);
        }
      }
      for (const field of ["volume", "opacity"] as const) {
        if (typeof item[field] === "number" && (item[field] < 0 || (field === "opacity" && item[field] > 1))) {
          throw new Error(`compile: ${where}.${field} must be ${field === "opacity" ? "between 0 and 1" : ">= 0"}`);
        }
      }
      if (track.type === "text") {
        if (typeof item.text !== "string" || item.text.length === 0) {
          throw new Error(`compile: ${where}.text is required for text tracks`);
        }
        if (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration <= 0) {
          throw new Error(`compile: ${where}.duration (seconds) is required for text tracks`);
        }
      } else {
        if (typeof item.path !== "string" || item.path.length === 0) {
          throw new Error(`compile: ${where}.path is required for ${track.type} tracks`);
        }
        if (
          track.type === "video" &&
          item.type === "photo" &&
          (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration <= 0)
        ) {
          throw new Error(`compile: ${where}.duration (seconds) is required for photos`);
        }
        if (
          item.duration !== undefined &&
          (typeof item.duration !== "number" || !Number.isFinite(item.duration) || item.duration <= 0)
        ) {
          throw new Error(`compile: ${where}.duration must be > 0 when provided`);
        }
      }
    });
  });
  if (s.operations !== undefined && !Array.isArray(s.operations)) {
    throw new Error("compile: spec.operations must be an array");
  }
  const refs = new Set<string>();
  for (const track of s.tracks as CompileTrack[]) {
    for (const item of track.items) {
      if (!item.ref) continue;
      if (refs.has(item.ref)) throw new Error(`compile: duplicate ref '${item.ref}'`);
      refs.add(item.ref);
    }
  }
  for (const [index, operation] of ((s.operations ?? []) as unknown[]).entries()) {
    if (!operation || typeof operation !== "object" || typeof (operation as { op?: unknown }).op !== "string") {
      throw new Error(`compile: operations[${index}].op is required`);
    }
    const op = operation as Record<string, unknown>;
    const where = `operations[${index}]`;
    validateOperationPayload(op, where);
    if (
      ![
        "transition",
        "filter",
        "effect",
        "keyframe",
        "audio-fade",
        "text-style",
        "text-ranges",
        "template",
        "captions",
      ].includes(op.op as string)
    ) {
      throw new Error(`compile: operations[${index}].op is not supported: ${String(op.op)}`);
    }
    if (["transition", "keyframe", "audio-fade", "text-style", "text-ranges"].includes(op.op as string)) {
      if (typeof op.target !== "string" || !refs.has(op.target)) {
        throw new Error(`compile: operations[${index}].target must reference a declared item ref`);
      }
    }
    // Payload shape, pre-flighted here so --check catches it and the real
    // build never reaches setTextStyle with `undefined` (#110: styling keys
    // written flat on the operation crashed with "Cannot read properties of
    // undefined (reading 'alpha')" instead of naming the mistake).
    if (op.op === "text-style" && (!op.style || typeof op.style !== "object" || Array.isArray(op.style))) {
      const flat = Object.keys(op).filter((key) => !["op", "target", "style"].includes(key));
      throw new Error(
        `compile: operations[${index}].style must be an object of styling keys (alpha, shadow, borderWidth, …)` +
          (flat.length > 0 ? ` — found ${flat.join(", ")} at the operation level; nest them under "style"` : ""),
      );
    }
    if (op.op === "text-ranges" && !Array.isArray(op.ranges)) {
      throw new Error(`compile: operations[${index}].ranges must be an array of range objects`);
    }
    if (op.op === "template" && op.ref !== undefined) {
      if (typeof op.ref !== "string" || op.ref.length === 0)
        throw new Error(`compile: ${where}.ref must be a non-empty string`);
      if (refs.has(op.ref)) throw new Error(`compile: duplicate ref '${op.ref}'`);
      refs.add(op.ref);
    }
    // Pre-flight the keyframe easing with the exact validation the real write
    // performs, so --check rejects what compile would reject and a bad easing
    // never fails AFTER initDraft seeded the draft directory (orphan dir).
    if (op.op === "keyframe" && op.easing !== undefined) {
      if (typeof op.easing !== "string") {
        throw new Error(`compile: operations[${index}].easing must be a string`);
      }
      try {
        resolveEasing(op.easing);
      } catch (e) {
        throw new Error(`compile: operations[${index}]: ${(e as Error).message}`);
      }
    }
  }
}

function validateColor(value: unknown, where: string): void {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`compile: ${where} must be a #RRGGBB color`);
  }
}

function finiteField(op: Record<string, unknown>, key: string, where: string, required = false, min?: number): void {
  const value = op[key];
  if (value === undefined && !required) return;
  if (typeof value !== "number" || !Number.isFinite(value) || (min !== undefined && value < min)) {
    throw new Error(`compile: ${where}.${key} must be a finite number${min === undefined ? "" : ` >= ${min}`}`);
  }
}

function validateOperationPayload(op: Record<string, unknown>, where: string): void {
  for (const key of ["trackName", "styleRef", "text"] as const) {
    if (op[key] !== undefined && typeof op[key] !== "string")
      throw new Error(`compile: ${where}.${key} must be a string`);
  }
  if (op.jianying !== undefined && typeof op.jianying !== "boolean")
    throw new Error(`compile: ${where}.jianying must be a boolean`);
  if (["transition", "filter", "effect"].includes(String(op.op))) {
    if (typeof op.slug !== "string" || op.slug.length === 0)
      throw new Error(`compile: ${where}.slug must be a non-empty string`);
  }
  if (["filter", "effect", "template"].includes(String(op.op))) {
    finiteField(op, "start", where, true, 0);
    finiteField(op, "duration", where, true, 0);
    targetTiming(op.start as number, op.duration as number);
  }
  if (op.op === "transition" && op.duration !== undefined) {
    finiteField(op, "duration", where, true, 0);
    targetTiming(0, op.duration as number);
  }
  if (op.op === "filter") {
    finiteField(op, "intensity", where, false, 0);
    if ((op.intensity as number) > 1) throw new Error(`compile: ${where}.intensity must be between 0 and 1`);
  }
  if (op.op === "effect" && op.params !== undefined) {
    if (!Array.isArray(op.params) || op.params.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`compile: ${where}.params must be an array of finite numbers`);
    }
  }
  if (op.op === "keyframe") {
    if (typeof op.property !== "string" || op.property.length === 0)
      throw new Error(`compile: ${where}.property must be a non-empty string`);
    finiteField(op, "time", where, true, 0);
    finiteField(op, "value", where, true);
  }
  if (op.op === "audio-fade") {
    finiteField(op, "fadeIn", where, false, 0);
    finiteField(op, "fadeOut", where, false, 0);
  }
  if (op.op === "captions") finiteField(op, "timeOffset", where);
  if (op.op === "template" || op.op === "captions") {
    if (typeof op.path !== "string" || op.path.length === 0)
      throw new Error(`compile: ${where}.path must be a non-empty string`);
  }
  if (op.op === "text-style" && op.style && typeof op.style === "object" && !Array.isArray(op.style)) {
    const style = op.style as Record<string, unknown>;
    for (const key of [
      "alpha",
      "fixedWidth",
      "fixedHeight",
      "shadowAlpha",
      "shadowAngle",
      "shadowDistance",
      "shadowSmoothing",
      "borderWidth",
      "borderAlpha",
      "bgAlpha",
      "bgStyle",
      "bgRoundRadius",
      "bgWidth",
      "bgHeight",
      "bgHOffset",
      "bgVOffset",
    ]) {
      finiteField(style, key, `${where}.style`);
    }
    for (const key of ["alpha", "shadowAlpha", "borderAlpha", "bgAlpha"]) {
      if (style[key] !== undefined && ((style[key] as number) < 0 || (style[key] as number) > 1)) {
        throw new Error(`compile: ${where}.style.${key} must be between 0 and 1`);
      }
    }
    for (const key of ["vertical", "shadow"]) {
      if (style[key] !== undefined && typeof style[key] !== "boolean")
        throw new Error(`compile: ${where}.style.${key} must be a boolean`);
    }
    for (const key of ["shadowColor", "borderColor", "bgColor"]) {
      if (style[key] !== undefined) validateColor(style[key], `${where}.style.${key}`);
    }
  }
  if (op.op === "text-ranges" && Array.isArray(op.ranges)) {
    for (const [index, range] of op.ranges.entries()) {
      const label = `${where}.ranges[${index}]`;
      if (!range || typeof range !== "object" || Array.isArray(range))
        throw new Error(`compile: ${label} must be an object`);
      const r = range as Record<string, unknown>;
      finiteField(r, "start", label, true, 0);
      finiteField(r, "end", label, true, 0);
      finiteField(r, "font_size", label, false, 0);
      finiteField(r, "font_alpha", label, false, 0);
      if (r.font_size === 0) throw new Error(`compile: ${label}.font_size must be > 0`);
      if ((r.font_alpha as number) > 1) throw new Error(`compile: ${label}.font_alpha must be between 0 and 1`);
      if (r.font_color !== undefined) validateColor(r.font_color, `${label}.font_color`);
      for (const key of ["bold", "italic", "underline"]) {
        if (r[key] !== undefined && typeof r[key] !== "boolean")
          throw new Error(`compile: ${label}.${key} must be a boolean`);
      }
    }
  }
}

function targetTiming(startSeconds: number, durationSeconds: number): { start: number; duration: number } {
  const start = Math.round(startSeconds * US);
  const end = Math.round((startSeconds + durationSeconds) * US);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    throw new Error(
      "compile: target timing must span at least one microsecond and fit within safe integer microseconds",
    );
  }
  return { start, duration: end - start };
}

function validateTemplateFile(path: string): void {
  const value: unknown = JSON.parse(stripBom(readFileSync(path, "utf-8")));
  const record = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item);
  if (
    !record(value) ||
    typeof value.type !== "string" ||
    !["text", "video", "audio", "sticker", "effect", "filter"].includes(value.type) ||
    !record(value.segment) ||
    !record(value.material) ||
    typeof value.material.type !== "string" ||
    !record(value.material.data) ||
    !Array.isArray(value.extra_materials)
  ) {
    throw new Error(
      `compile: invalid template payload: ${path}; expected type, segment, material {type, data}, and extra_materials`,
    );
  }
  for (const extra of value.extra_materials) {
    if (!record(extra) || typeof extra.type !== "string" || !record(extra.data))
      throw new Error(`compile: invalid template extra material: ${path}`);
  }
}

function resolvePath(p: string, specDir: string): string {
  return isAbsolute(p) ? p : resolve(specDir, p);
}

// `compile --data` templating. The rule is deliberately minimal: a {{key}}
// placeholder inside a STRING value (nested objects and arrays included, so
// the draft `name` too) is replaced with the row's value for that key —
// nothing cleverer. No expressions, no defaults, no nested lookups: the key
// text between the braces (surrounding whitespace trimmed) is looked up as a
// literal row property. Non-string spec values are never templated, so a
// placeholder cannot turn into a number — keep numeric fields numeric in the
// spec and template only text-shaped values (paths, texts, names, slugs).
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Substitute {{key}} placeholders from a JSONL row into every string value of
 * a parsed spec (or any JSON-shaped value). Returns a new tree; the input is
 * never mutated. Row values must be strings, numbers, or booleans; a
 * placeholder with no matching row key is an error, because silently building
 * a draft whose title reads "{{title}}" is the mass-production failure mode.
 */
export function substitutePlaceholders<T>(value: T, row: Record<string, unknown>): T {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_match, key: string) => {
      if (!Object.hasOwn(row, key)) {
        throw new Error(`compile: no value for placeholder {{${key}}} in row`);
      }
      const v = row[key];
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") {
        throw new Error(`compile: row value for {{${key}}} must be a string, number, or boolean`);
      }
      return String(v);
    }) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substitutePlaceholders(item, row)) as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) result[k] = substitutePlaceholders(v, row);
    return result as T;
  }
  return value;
}

function itemTiming(item: CompileItem, media: MediaProbe | null): { duration: number; sourceDuration: number } {
  const photo = item.type === "photo" || /\.(?:jpg|jpeg|png|webp|bmp|tiff)$/i.test(item.path ?? "");
  const sourceStart = Math.round((item.sourceStart ?? 0) * US);
  if (!Number.isSafeInteger(sourceStart))
    throw new Error("compile: sourceStart must fit within safe integer microseconds");
  const speed = item.speed ?? 1;
  const durationSeconds = item.duration ?? ((media?.durationUs ?? 0) - sourceStart) / speed / US;
  if (durationSeconds <= 0) {
    throw new Error(
      `compile: duration omitted for ${item.path}, but ffprobe could not determine it. Pass duration explicitly or install ffprobe.`,
    );
  }
  const duration = targetTiming(item.start, durationSeconds).duration;
  const sourceEnd = sourceStart + Math.round(duration * speed);
  if (!Number.isSafeInteger(sourceEnd))
    throw new Error("compile: source range must fit within safe integer microseconds");
  if (!photo && media?.durationUs && sourceEnd > media.durationUs + 10_000) {
    throw new Error(
      `compile: source range for ${item.path} exceeds source duration (${sourceEnd} > ${media.durationUs}us)`,
    );
  }
  // Without probe evidence, keep the entire requested source range addressable.
  // This is a lower bound, not a claim about the actual file's duration.
  return { duration, sourceDuration: photo ? duration : (media?.durationUs ?? sourceEnd) };
}

export function planCompile(spec: CompileSpec, specDir: string): CompilePlan {
  validateSpec(spec);
  const canvas = resolveCanvas(spec);
  const media: string[] = [];
  const refs: string[] = [];
  for (const track of spec.tracks) {
    for (const item of track.items) {
      if (item.ref) refs.push(item.ref);
      if (track.type === "text") {
        targetTiming(item.start, item.duration as number);
        continue;
      }
      const abs = resolvePath(item.path as string, specDir);
      if (!existsSync(abs)) throw new Error(`compile: media file not found: ${item.path} (resolved: ${abs})`);
      if (!statSync(abs).isFile()) throw new Error(`compile: media path must be a regular file: ${item.path}`);
      itemTiming(item, probeMedia(abs));
      media.push(abs);
    }
  }
  for (const operation of spec.operations ?? []) {
    if (operation.op !== "template" && operation.op !== "captions") continue;
    const abs = resolvePath(operation.path, specDir);
    if (!existsSync(abs))
      throw new Error(`compile: ${operation.op} file not found: ${operation.path} (resolved: ${abs})`);
    if (!statSync(abs).isFile())
      throw new Error(`compile: ${operation.op} path must be a regular file: ${operation.path}`);
    if (operation.op === "template") validateTemplateFile(abs);
    media.push(abs);
  }
  const preview = {
    id: "compile-preview",
    name: spec.name ?? "compiled-draft",
    duration: 0,
    fps: spec.fps ?? 30,
    canvas_config: canvas ?? { width: 1920, height: 1080, ratio: "original" },
    tracks: [],
    materials: { videos: [], audios: [], texts: [] },
  } as unknown as Draft;
  populateDraft(spec, specDir, preview, resolve(specDir, "__compile_preview__", "draft_content.json"), [], true);
  return {
    ok: true,
    name: spec.name ?? "compiled-draft",
    canvas: {
      width: canvas?.width ?? 1920,
      height: canvas?.height ?? 1080,
      fps: spec.fps ?? 30,
      ratio: canvas?.ratio ?? "original",
    },
    tracks: spec.tracks.length,
    items: spec.tracks.reduce((sum, track) => sum + track.items.length, 0),
    operations: spec.operations?.length ?? 0,
    refs,
    media,
  };
}

export function compileDraft(spec: CompileSpec, opts: CompileOptions): CompileResult {
  const warnings: string[] = [];
  // The output DIRECTORY name comes from --out (so the draft lands exactly where
  // the caller asked); the draft's internal display name comes from spec.name.
  // These are independent — conflating them writes to the wrong folder.
  const dirName = basename(opts.outDir);
  const displayName = spec.name ?? dirName;

  // Pre-flight every media/operation path before initDraft writes anything.
  planCompile(spec, opts.specDir);

  // Seed a fresh draft (the template, or the store's newest project — see
  // initDraft's seeding), then populate it.
  const init = initDraft({
    name: dirName,
    templateDir: opts.templateDir,
    draftsDir: dirname(opts.outDir),
    seed: opts.seed,
    deferRegistration: true,
    cleanupOnError: true,
    canvas: resolveCanvas(spec) ?? undefined,
  });
  const { filePath } = init;
  if (init.template.warning) warnings.push(init.template.warning);
  const owned = lstatSync(init.draftPath);
  try {
    const { draft } = loadDraft(filePath);
    const canvas = resolveCanvas(spec);
    if (canvas) draft.canvas_config = canvas;
    if (spec.fps) draft.fps = spec.fps;
    draft.name = displayName;
    const { segments, maxEnd, refs } = populateDraft(spec, opts.specDir, draft, filePath, warnings);
    draft.duration = maxEnd;
    saveDraft(filePath, draft);
    // Read and merge the current store only after the draft has been built.
    // A failed build never inserts an entry or restores an old index snapshot.
    try {
      if (
        !registerDraftInIndex({
          draftsDir: dirname(opts.outDir),
          draftPath: init.draftPath,
          filePath,
          draftId: draft.id,
          name: displayName,
          nowMs: Date.now(),
          durationUs: maxEnd,
        })
      )
        warnings.push(
          "compile: draft built, but the store index could not be read; run register --apply to register it",
        );
    } catch (error) {
      warnings.push(`compile: draft built, but registration failed: ${(error as Error).message}`);
    }
    return {
      ok: true,
      name: displayName,
      draft_path: opts.outDir,
      file_path: filePath,
      tracks: spec.tracks.length,
      segments,
      duration_us: maxEnd,
      warnings,
      refs: Object.fromEntries(refs),
      template: init.template,
    };
  } catch (error) {
    // Only remove the directory this call created. A replacement at the same
    // path belongs to another writer and must survive our failure.
    if (existsSync(init.draftPath)) {
      const current = lstatSync(init.draftPath);
      if (current.isDirectory() && current.dev === owned.dev && current.ino === owned.ino) {
        rmSync(init.draftPath, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

function populateDraft(
  spec: CompileSpec,
  specDir: string,
  draft: Draft,
  filePath: string,
  warnings: string[],
  preview = false,
): { segments: number; maxEnd: number; refs: Map<string, string> } {
  let segments = 0;
  let maxEnd = 0;
  const refs = new Map<string, string>();

  for (const track of spec.tracks) {
    for (const item of track.items) {
      const start = Math.round(item.start * US);
      const sourcePath = track.type === "text" ? null : resolvePath(item.path as string, specDir);
      const media = sourcePath ? probeMedia(sourcePath) : null;
      const { duration, sourceDuration } =
        track.type === "text"
          ? { duration: targetTiming(item.start, item.duration as number).duration, sourceDuration: 0 }
          : itemTiming(item, media);
      if (track.type === "video") {
        const result = addVideo(draft, filePath, {
          path: sourcePath as string,
          start,
          duration,
          sourceDuration,
          type: item.type,
          width: item.width ?? media?.width ?? undefined,
          height: item.height ?? media?.height ?? undefined,
          trackName: track.name,
          ...(preview ? { placeholder: { path: sourcePath as string, name: basename(sourcePath as string) } } : {}),
        });
        applyItemProperties(draft, result.segmentId, item);
        if (item.ref) refs.set(item.ref, result.segmentId);
        maxEnd = Math.max(maxEnd, start + duration);
      } else if (track.type === "audio") {
        const result = addAudio(draft, filePath, {
          path: sourcePath as string,
          start,
          duration,
          sourceDuration,
          volume: item.volume,
          trackName: track.name,
          ...(preview ? { placeholder: { path: sourcePath as string, name: basename(sourcePath as string) } } : {}),
        });
        applyItemProperties(draft, result.segmentId, item);
        if (item.ref) refs.set(item.ref, result.segmentId);
        // duration 0 => whole-file; we can't know length without probing, so the
        // draft duration is driven by the explicit-duration segments.
        if (duration > 0) maxEnd = Math.max(maxEnd, start + duration);
      } else {
        const result = addText(draft, filePath, {
          text: item.text as string,
          start,
          duration,
          fontSize: item.fontSize,
          color: item.color,
          x: item.x,
          y: item.y,
          trackName: track.name,
        });
        applyItemProperties(draft, result.segmentId, item);
        if (item.ref) refs.set(item.ref, result.segmentId);
        maxEnd = Math.max(maxEnd, start + duration);
      }
      segments++;
    }
  }

  for (const [index, operation] of (spec.operations ?? []).entries()) {
    const resolveRef = (ref: string): string => {
      const id = refs.get(ref);
      if (!id) throw new Error(`compile: unresolved ref '${ref}'`);
      return id;
    };
    try {
      switch (operation.op) {
        case "transition":
          addTransition(
            draft,
            resolveRef(operation.target),
            operation.slug,
            operation.duration === undefined ? undefined : Math.round(operation.duration * US),
            operation.jianying ? "jianying" : "capcut",
          );
          break;
        case "filter": {
          const result = addFilter(draft, {
            slug: operation.slug,
            start: Math.round(operation.start * US),
            duration: targetTiming(operation.start, operation.duration).duration,
            intensity: operation.intensity,
            trackName: operation.trackName,
            namespace: operation.jianying ? "jianying" : "capcut",
          });
          maxEnd = Math.max(maxEnd, Math.round((operation.start + operation.duration) * US));
          segments++;
          void result;
          break;
        }
        case "effect":
          addEffect(draft, {
            slug: operation.slug,
            start: Math.round(operation.start * US),
            duration: targetTiming(operation.start, operation.duration).duration,
            params: operation.params,
            trackName: operation.trackName,
            namespace: operation.jianying ? "jianying" : "capcut",
          });
          maxEnd = Math.max(maxEnd, Math.round((operation.start + operation.duration) * US));
          segments++;
          break;
        case "keyframe":
          warnings.push(
            ...addKeyframes(draft, resolveRef(operation.target), [
              {
                property: operation.property,
                timeUs: Math.round(operation.time * US),
                value: operation.value,
                easing: operation.easing,
              },
            ]).warnings,
          );
          break;
        case "audio-fade":
          setAudioFade(draft, resolveRef(operation.target), {
            fadeInUs: operation.fadeIn === undefined ? undefined : Math.round(operation.fadeIn * US),
            fadeOutUs: operation.fadeOut === undefined ? undefined : Math.round(operation.fadeOut * US),
          });
          break;
        case "text-style":
          setTextStyle(draft, resolveRef(operation.target), operation.style);
          break;
        case "text-ranges":
          setTextRanges(draft, resolveRef(operation.target), operation.ranges);
          break;
        case "template": {
          const result = applyTemplate(
            draft,
            resolvePath(operation.path, specDir),
            Math.round(operation.start * US),
            targetTiming(operation.start, operation.duration).duration,
            { text: operation.text },
          );
          if (operation.ref) refs.set(operation.ref, result.segmentId);
          maxEnd = Math.max(maxEnd, Math.round((operation.start + operation.duration) * US));
          segments++;
          break;
        }
        case "captions": {
          const cues = parseSrt(stripBom(readFileSync(resolvePath(operation.path, specDir), "utf-8")));
          if (cues.length === 0) throw new Error("captions file contains no cues");
          const offset = Math.round((operation.timeOffset ?? 0) * US);
          for (const cue of cues) {
            if (!cue.text || cue.startUs + offset < 0 || !Number.isSafeInteger(cue.endUs + offset)) {
              throw new Error(
                `captions cue ${cue.index} must contain text and have non-negative, safe integer timing after timeOffset`,
              );
            }
            const result = addText(draft, filePath, {
              text: cue.text,
              start: cue.startUs + offset,
              duration: cue.endUs - cue.startUs,
              trackName: operation.trackName ?? "captions",
            });
            const material = draft.materials.texts.find((item) => item.id === result.materialId) as unknown as Record<
              string,
              unknown
            >;
            material.sub_type = 1;
            material.caption_template_info = {
              category_id: "",
              category_name: "",
              effect_id: "",
              is_new: false,
              resource_id: "",
            };
            if (operation.styleRef) {
              const styleId = refs.get(operation.styleRef);
              if (styleId) copyTextStyle(draft, styleId, result.materialId);
              else
                warnings.push(`compile captions styleRef '${operation.styleRef}' did not resolve; base style retained`);
            }
            maxEnd = Math.max(maxEnd, cue.endUs + offset);
            segments++;
          }
          break;
        }
      }
    } catch (error) {
      throw new Error(`compile: operations[${index}]: ${(error as Error).message}`);
    }
  }
  return { segments, maxEnd, refs };
}

function applyItemProperties(draft: Draft, segmentId: string, item: CompileItem): void {
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`compile: created segment disappeared: ${segmentId}`);
  const segment = found.segment;
  if (item.sourceStart !== undefined) segment.source_timerange.start = Math.round(item.sourceStart * US);
  if (item.speed !== undefined) {
    if (!(item.speed > 0)) throw new Error(`compile: speed must be > 0 for ref ${item.ref ?? segmentId}`);
    segment.speed = item.speed;
    segment.source_timerange.duration = Math.round(segment.target_timerange.duration * item.speed);
  }
  if (item.volume !== undefined) segment.volume = item.volume;
  if (segment.clip) {
    if (item.opacity !== undefined) segment.clip.alpha = item.opacity;
    if (item.rotation !== undefined) segment.clip.rotation = item.rotation;
    if (item.scale !== undefined) segment.clip.scale = { x: item.scale, y: item.scale };
    if (item.x !== undefined || item.y !== undefined) {
      segment.clip.transform = { x: item.x ?? segment.clip.transform.x, y: item.y ?? segment.clip.transform.y };
    }
  }
}
