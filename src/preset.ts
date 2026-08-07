import { readFileSync } from "node:fs";
import { stripBom } from "./bom.js";
import { hexToRgb01, requireTextMaterial, setBubble, setTextRanges, type TextRangeInput } from "./decorators.js";
import type { Draft, MaterialText } from "./draft.js";
import { STYLE_FIELDS } from "./factory.js";

// --- Text style presets (make-preset / --preset) ---
// A preset captures the styling of one text segment as a portable JSON file:
// the STYLE_FIELDS material fields (font identity, colors, shadow/border/
// background box, alignment, spacing), the content styles[0] flags, the clip
// transform, the bubble reference, and per-range styles (karaoke highlights).
// Only properties the CLI can re-apply are captured — animations are excluded
// because they attach via enum slugs and segment-relative timings that don't
// survive a portable preset. Fork prior art: Davidb-2107/capcut-cli-david
// v1.14.0 (make-preset --out / restyle --preset).

export const PRESET_VERSION = 1;

export interface TextStylePreset {
  capcutCliPreset: number;
  style: Record<string, unknown>;
  transform?: { x: number; y: number };
  bubble?: { effect_id: string; resource_id: string };
  text_ranges?: TextRangeInput[];
}

function rgb01ToHex(rgb: [number, number, number]): string {
  const channel = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`.toUpperCase();
}

interface ContentStyleBlock {
  range?: [number, number];
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fill?: {
    alpha?: number;
    content?: { render_type?: string; solid?: { color?: [number, number, number]; alpha?: number } };
  };
  font?: { id?: string; path?: string };
  [key: string]: unknown;
}

function parseContent(mat: MaterialText): { styles?: ContentStyleBlock[]; text?: string } | null {
  try {
    return JSON.parse(mat.content) as { styles?: ContentStyleBlock[]; text?: string };
  } catch {
    return null;
  }
}

export function extractTextPreset(
  draft: Draft,
  segmentId: string,
): { preset: TextStylePreset; segmentId: string; materialId: string; captured: string[] } {
  const { seg, text: mat } = requireTextMaterial(draft, segmentId, "make-preset");

  const m = mat as unknown as Record<string, unknown>;
  const style: Record<string, unknown> = {};
  for (const f of STYLE_FIELDS) {
    if (m[f] !== undefined) style[f] = m[f];
  }

  // Fill gaps from the content's base style block — CapCut renders from there,
  // and add-text only stamps some of these at the material level.
  const content = parseContent(mat);
  const base = content?.styles?.[0];
  if (base) {
    if (style.font_size === undefined && base.size !== undefined) style.font_size = base.size;
    if (style.bold === undefined && base.bold !== undefined) style.bold = base.bold;
    if (style.italic === undefined && base.italic !== undefined) style.italic = base.italic;
    if (style.underline === undefined && base.underline !== undefined) style.underline = base.underline;
    const solid = base.fill?.content?.solid;
    if (style.text_color === undefined && solid?.color) style.text_color = rgb01ToHex(solid.color);
    if (style.font_path === undefined && base.font?.path) style.font_path = base.font.path;
    if (style.font_id === undefined && base.font?.id) style.font_id = base.font.id;
  }

  const preset: TextStylePreset = { capcutCliPreset: PRESET_VERSION, style };
  const captured = ["style"];

  if (seg.clip?.transform) {
    preset.transform = { x: seg.clip.transform.x, y: seg.clip.transform.y };
    captured.push("transform");
  }

  if (typeof m.bubble_effect_id === "string" && m.bubble_effect_id && typeof m.bubble_resource_id === "string") {
    preset.bubble = { effect_id: m.bubble_effect_id, resource_id: m.bubble_resource_id };
    captured.push("bubble");
  }

  // Multi-range styling (text-ranges / karaoke). Ranges are stored in UTF-16LE
  // bytes; convert back to code units (BMP assumption, same as setTextRanges).
  const styles = content?.styles ?? [];
  if (styles.length > 1) {
    const ranges: TextRangeInput[] = [];
    for (const s of styles) {
      if (!Array.isArray(s.range) || s.range.length !== 2) continue;
      const solid = s.fill?.content?.solid;
      ranges.push({
        start: s.range[0] / 2,
        end: s.range[1] / 2,
        font_color: solid?.color ? rgb01ToHex(solid.color) : undefined,
        font_size: s.size,
        font_alpha: solid?.alpha,
        bold: s.bold,
        italic: s.italic,
        underline: s.underline,
      });
    }
    if (ranges.length > 0) {
      preset.text_ranges = ranges;
      captured.push("text_ranges");
    }
  }

  return { preset, segmentId: seg.id, materialId: mat.id, captured };
}

// Style fields whose stored type is fixed across CapCut versions. A preset is a
// portable, hand-editable JSON file: reject a wrong-typed value up front rather
// than stamp e.g. font_size:"huge" onto the material and corrupt the draft.
const NUMERIC_STYLE_FIELDS = [
  "font_size",
  "alignment",
  "typesetting",
  "letter_spacing",
  "line_spacing",
  "text_alpha",
  "shadow_alpha",
  "shadow_angle",
  "shadow_distance",
  "shadow_smoothing",
  "border_width",
  "border_alpha",
  "background_alpha",
  "background_style",
  "background_round_radius",
  "background_width",
  "background_height",
  "background_horizontal_offset",
  "background_vertical_offset",
];
const STRING_STYLE_FIELDS = [
  "text_color",
  "shadow_color",
  "border_color",
  "background_color",
  "font_id",
  "font_name",
  "font_path",
  "font_resource_id",
];
const BOOLEAN_STYLE_FIELDS = ["bold", "italic", "underline", "has_shadow", "has_border", "has_text_shadow_config"];

function validatePresetStyle(style: Record<string, unknown>, source: string): void {
  for (const f of NUMERIC_STYLE_FIELDS) {
    const v = style[f];
    if (v !== undefined && (typeof v !== "number" || !Number.isFinite(v))) {
      throw new Error(`Preset "style.${f}" must be a finite number, got ${JSON.stringify(v)}: ${source}`);
    }
  }
  for (const f of STRING_STYLE_FIELDS) {
    if (style[f] !== undefined && typeof style[f] !== "string") {
      throw new Error(`Preset "style.${f}" must be a string, got ${JSON.stringify(style[f])}: ${source}`);
    }
  }
  for (const f of BOOLEAN_STYLE_FIELDS) {
    if (style[f] !== undefined && typeof style[f] !== "boolean") {
      throw new Error(`Preset "style.${f}" must be a boolean, got ${JSON.stringify(style[f])}: ${source}`);
    }
  }
}

function validateTransform(t: unknown, source: string): void {
  if (t === null || typeof t !== "object" || Array.isArray(t)) {
    throw new Error(`Preset "transform" must be an object { x: number, y: number }: ${source}`);
  }
  const tr = t as Record<string, unknown>;
  if (typeof tr.x !== "number" || !Number.isFinite(tr.x) || typeof tr.y !== "number" || !Number.isFinite(tr.y)) {
    throw new Error(`Preset "transform" requires finite numeric "x" and "y": ${source}`);
  }
}

function validateBubble(b: unknown, source: string): void {
  if (b === null || typeof b !== "object" || Array.isArray(b)) {
    throw new Error(`Preset "bubble" must be an object { effect_id, resource_id }: ${source}`);
  }
  const bu = b as Record<string, unknown>;
  if (typeof bu.effect_id !== "string" || !bu.effect_id || typeof bu.resource_id !== "string" || !bu.resource_id) {
    throw new Error(`Preset "bubble" requires non-empty string "effect_id" and "resource_id": ${source}`);
  }
}

function validateTextRanges(ranges: unknown, source: string): void {
  if (!Array.isArray(ranges)) {
    throw new Error(`Preset "text_ranges" must be an array: ${source}`);
  }
  ranges.forEach((r, i) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      throw new Error(`Preset "text_ranges[${i}]" must be an object: ${source}`);
    }
    const range = r as Record<string, unknown>;
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
      throw new Error(`Preset "text_ranges[${i}]" requires integer "start" and "end": ${source}`);
    }
    const start = range.start as number;
    const end = range.end as number;
    if (start < 0) throw new Error(`Preset "text_ranges[${i}]" start must be >= 0: ${source}`);
    if (end <= start)
      throw new Error(`Preset "text_ranges[${i}]" end must be > start (got [${start},${end})): ${source}`);
    if (range.font_color !== undefined && typeof range.font_color !== "string") {
      throw new Error(`Preset "text_ranges[${i}].font_color" must be a string: ${source}`);
    }
    if (range.font_size !== undefined && (typeof range.font_size !== "number" || !Number.isFinite(range.font_size))) {
      throw new Error(`Preset "text_ranges[${i}].font_size" must be a number: ${source}`);
    }
    if (
      range.font_alpha !== undefined &&
      (typeof range.font_alpha !== "number" || !Number.isFinite(range.font_alpha))
    ) {
      throw new Error(`Preset "text_ranges[${i}].font_alpha" must be a number: ${source}`);
    }
    for (const f of ["bold", "italic", "underline"] as const) {
      if (range[f] !== undefined && typeof range[f] !== "boolean") {
        throw new Error(`Preset "text_ranges[${i}].${f}" must be a boolean: ${source}`);
      }
    }
  });
}

export function parsePreset(raw: string, source: string): TextStylePreset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Preset is not valid JSON: ${e instanceof Error ? e.message : String(e)} (${source})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Preset must be a JSON object: ${source}`);
  }
  const p = parsed as Record<string, unknown>;
  if (p.capcutCliPreset === undefined) {
    throw new Error(
      `Not a capcut-cli preset (missing "capcutCliPreset" marker): ${source}. Generate one with 'capcut make-preset'.`,
    );
  }
  if (p.capcutCliPreset !== PRESET_VERSION) {
    throw new Error(`Unsupported preset version: ${String(p.capcutCliPreset)} (this CLI supports ${PRESET_VERSION})`);
  }
  if (p.style === null || typeof p.style !== "object" || Array.isArray(p.style)) {
    throw new Error(`Preset "style" must be an object: ${source}`);
  }
  validatePresetStyle(p.style as Record<string, unknown>, source);
  if (p.transform !== undefined) validateTransform(p.transform, source);
  if (p.bubble !== undefined) validateBubble(p.bubble, source);
  if (p.text_ranges !== undefined) validateTextRanges(p.text_ranges, source);
  return p as unknown as TextStylePreset;
}

export function loadPresetFile(path: string): TextStylePreset {
  let raw: string;
  try {
    raw = stripBom(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`Preset file not found: ${path}`);
  }
  return parsePreset(raw, path);
}

export function applyTextPreset(
  draft: Draft,
  segmentId: string,
  preset: TextStylePreset,
): { materialId: string; applied: string[] } {
  const { seg, text: mat } = requireTextMaterial(draft, segmentId, "--preset");

  const m = mat as unknown as Record<string, unknown>;
  const applied: string[] = [];
  for (const f of STYLE_FIELDS) {
    if (preset.style[f] !== undefined) m[f] = preset.style[f];
  }
  applied.push("style");

  // Mirror the base style into `content`'s styles[0] — CapCut renders from
  // there. Preserve the segment's own text and range.
  const content = parseContent(mat);
  const base = content?.styles?.[0];
  if (content && base) {
    if (typeof preset.style.font_size === "number") base.size = preset.style.font_size;
    if (typeof preset.style.bold === "boolean") base.bold = preset.style.bold;
    if (typeof preset.style.italic === "boolean") base.italic = preset.style.italic;
    if (typeof preset.style.underline === "boolean") base.underline = preset.style.underline;
    if (typeof preset.style.text_color === "string") {
      base.fill = {
        alpha: 1,
        content: { render_type: "solid", solid: { alpha: 1, color: hexToRgb01(preset.style.text_color) } },
      };
    }
    if (typeof preset.style.font_path === "string") {
      base.font = {
        id: typeof preset.style.font_id === "string" ? preset.style.font_id : "",
        path: preset.style.font_path,
      };
    }
    // A preset "applies in full". A rangeless preset describes ONE uniform look,
    // so applying it onto a segment that still carries multiple range blocks
    // (leftover karaoke/highlight styling) must collapse those blocks to the
    // single preset style — otherwise the trailing base-style chunk keeps its
    // old size/colour while the material/output claim the new style.
    const hasPresetRanges = Array.isArray(preset.text_ranges) && preset.text_ranges.length > 0;
    if (!hasPresetRanges && content.styles && content.styles.length > 1) {
      const byteLen = Buffer.from(content.text ?? "", "utf16le").length;
      base.range = [0, byteLen];
      content.styles = [base];
    }
    mat.content = JSON.stringify(content);
  }

  if (preset.transform && seg.clip) {
    seg.clip.transform = { x: preset.transform.x, y: preset.transform.y };
    applied.push("transform");
  }

  if (preset.bubble) {
    setBubble(draft, seg.id, { effectId: preset.bubble.effect_id, resourceId: preset.bubble.resource_id });
    applied.push("bubble");
  }

  if (preset.text_ranges && preset.text_ranges.length > 0) {
    // Ranges came from a different text; keep the ones that fit this one.
    const textLength = (parseContent(mat)?.text ?? "").length;
    const ranges = preset.text_ranges
      .map((r) => ({ ...r, end: Math.min(r.end, textLength) }))
      .filter((r) => r.start < r.end);
    if (ranges.length > 0) {
      setTextRanges(draft, seg.id, ranges);
      applied.push("text_ranges");
    }
  }

  return { materialId: mat.id, applied };
}

// Base style block for caption cues — same coverage as caption --style-ref
// (content styles[0] plus the font_size/font_color fields the caption
// material reads), so --preset slots into the existing baseStyle path.
export function captionStyleFromPreset(preset: TextStylePreset): Record<string, unknown> {
  const color = typeof preset.style.text_color === "string" ? preset.style.text_color : "#FFFFFF";
  const size = typeof preset.style.font_size === "number" ? preset.style.font_size : 15;
  const block: Record<string, unknown> = {
    font_color: color,
    font_size: size,
    size,
    bold: preset.style.bold ?? false,
    italic: preset.style.italic ?? false,
    underline: preset.style.underline ?? false,
    fill: { alpha: 1, content: { render_type: "solid", solid: { alpha: 1, color: hexToRgb01(color) } } },
  };
  if (typeof preset.style.font_path === "string") {
    block.font = {
      id: typeof preset.style.font_id === "string" ? preset.style.font_id : "",
      path: preset.style.font_path,
    };
  }
  return block;
}
