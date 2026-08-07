import { existsSync, readFileSync } from "node:fs";
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
  setAudioFade,
} from "./factory.js";
import { probeMedia } from "./probe.js";
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
}

export interface CompileResult {
  ok: boolean;
  name: string;
  draft_path: string;
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
  if (!spec || typeof spec !== "object") throw new Error("compile: spec must be a JSON object");
  const s = spec as Record<string, unknown>;
  if (!Array.isArray(s.tracks) || s.tracks.length === 0) {
    throw new Error("compile: spec.tracks must be a non-empty array");
  }
  s.tracks.forEach((t, ti) => {
    if (!t || typeof t !== "object") throw new Error(`compile: tracks[${ti}] must be an object`);
    const track = t as Record<string, unknown>;
    if (typeof track.type !== "string" || !VALID_TRACK_TYPES.has(track.type)) {
      throw new Error(`compile: tracks[${ti}].type must be one of video|audio|text (got ${String(track.type)})`);
    }
    if (!Array.isArray(track.items) || track.items.length === 0) {
      throw new Error(`compile: tracks[${ti}].items must be a non-empty array`);
    }
    track.items.forEach((it, ii) => {
      const item = it as Record<string, unknown>;
      const where = `tracks[${ti}].items[${ii}]`;
      if (typeof item.start !== "number" || item.start < 0) {
        throw new Error(`compile: ${where}.start must be a number >= 0 (seconds)`);
      }
      if (item.ref !== undefined && (typeof item.ref !== "string" || item.ref.length === 0)) {
        throw new Error(`compile: ${where}.ref must be a non-empty string`);
      }
      for (const field of ["speed", "opacity", "rotation", "scale", "sourceStart"] as const) {
        if (item[field] !== undefined && typeof item[field] !== "number") {
          throw new Error(`compile: ${where}.${field} must be a number`);
        }
      }
      if (track.type === "text") {
        if (typeof item.text !== "string" || item.text.length === 0) {
          throw new Error(`compile: ${where}.text is required for text tracks`);
        }
        if (typeof item.duration !== "number" || item.duration <= 0) {
          throw new Error(`compile: ${where}.duration (seconds) is required for text tracks`);
        }
      } else {
        if (typeof item.path !== "string" || item.path.length === 0) {
          throw new Error(`compile: ${where}.path is required for ${track.type} tracks`);
        }
        if (
          track.type === "video" &&
          item.type === "photo" &&
          (typeof item.duration !== "number" || item.duration <= 0)
        ) {
          throw new Error(`compile: ${where}.duration (seconds) is required for photos`);
        }
        if (item.duration !== undefined && (typeof item.duration !== "number" || item.duration <= 0)) {
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

export function planCompile(spec: CompileSpec, specDir: string): CompilePlan {
  const media: string[] = [];
  const refs: string[] = [];
  for (const track of spec.tracks) {
    for (const item of track.items) {
      if (item.ref) refs.push(item.ref);
      if (track.type === "text") continue;
      const abs = resolvePath(item.path as string, specDir);
      if (!existsSync(abs)) throw new Error(`compile: media file not found: ${item.path} (resolved: ${abs})`);
      if (item.duration === undefined && !probeMedia(abs)?.durationUs) {
        throw new Error(`compile: duration omitted for ${item.path}, but ffprobe could not determine it`);
      }
      media.push(abs);
    }
  }
  for (const operation of spec.operations ?? []) {
    if (operation.op !== "template" && operation.op !== "captions") continue;
    const abs = resolvePath(operation.path, specDir);
    if (!existsSync(abs))
      throw new Error(`compile: ${operation.op} file not found: ${operation.path} (resolved: ${abs})`);
    media.push(abs);
  }
  return {
    ok: true,
    name: spec.name ?? "compiled-draft",
    canvas: {
      width: spec.width ?? 1920,
      height: spec.height ?? 1080,
      fps: spec.fps ?? 30,
      ratio: spec.ratio ?? "original",
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

  // Seed a fresh draft from the bundled template, then populate it.
  const { filePath } = initDraft({ name: dirName, templateDir: opts.templateDir, draftsDir: dirname(opts.outDir) });
  const { draft } = loadDraft(filePath);

  // Canvas + fps from the spec.
  if (spec.width && spec.height) {
    draft.canvas_config = {
      width: spec.width,
      height: spec.height,
      ratio: spec.ratio ?? draft.canvas_config?.ratio ?? "original",
    };
  }
  if (spec.fps) draft.fps = spec.fps;
  draft.name = displayName;

  let segments = 0;
  let maxEnd = 0;
  const refs = new Map<string, string>();

  for (const track of spec.tracks) {
    for (const item of track.items) {
      const start = Math.round(item.start * US);
      const sourcePath = track.type === "text" ? null : resolvePath(item.path as string, opts.specDir);
      const media = sourcePath ? probeMedia(sourcePath) : null;
      const duration = item.duration !== undefined ? Math.round(item.duration * US) : (media?.durationUs ?? 0);
      if (track.type !== "text" && duration <= 0) {
        throw new Error(
          `compile: duration omitted for ${item.path}, but ffprobe could not determine it. ` +
            "Pass duration explicitly or install ffprobe.",
        );
      }
      if (
        item.duration !== undefined &&
        media?.durationUs &&
        item.type !== "photo" &&
        duration > media.durationUs + 10_000
      ) {
        throw new Error(
          `compile: duration for ${item.path} exceeds source duration (${duration} > ${media.durationUs}us)`,
        );
      }
      if (track.type === "video") {
        const result = addVideo(draft, filePath, {
          path: sourcePath as string,
          start,
          duration,
          type: item.type,
          width: item.width ?? media?.width ?? undefined,
          height: item.height ?? media?.height ?? undefined,
          trackName: track.name,
        });
        applyItemProperties(draft, result.segmentId, item);
        if (item.ref) refs.set(item.ref, result.segmentId);
        maxEnd = Math.max(maxEnd, start + duration);
      } else if (track.type === "audio") {
        const result = addAudio(draft, filePath, {
          path: sourcePath as string,
          start,
          duration,
          volume: item.volume,
          trackName: track.name,
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

  for (const operation of spec.operations ?? []) {
    const resolveRef = (ref: string): string => {
      const id = refs.get(ref);
      if (!id) throw new Error(`compile: unresolved ref '${ref}'`);
      return id;
    };
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
          duration: Math.round(operation.duration * US),
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
          duration: Math.round(operation.duration * US),
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
          resolvePath(operation.path, opts.specDir),
          Math.round(operation.start * US),
          Math.round(operation.duration * US),
          { text: operation.text },
        );
        if (operation.ref) refs.set(operation.ref, result.segmentId);
        maxEnd = Math.max(maxEnd, Math.round((operation.start + operation.duration) * US));
        segments++;
        break;
      }
      case "captions": {
        const cues = parseSrt(stripBom(readFileSync(resolvePath(operation.path, opts.specDir), "utf-8")));
        const offset = Math.round((operation.timeOffset ?? 0) * US);
        for (const cue of cues) {
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
  }

  draft.duration = maxEnd;
  saveDraft(filePath, draft);

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
  };
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
