// Zero-dep ASS / SSA subtitle parser. Returns cues with microsecond timings,
// shaped identically to SrtCue so the import pipeline can be shared.
// We parse only the [Events] section and only Dialogue: lines. The Format:
// header is read to find the Start / End / Text column indices (these vary
// between ASS files). ASS time format is H:MM:SS.cc (centiseconds).
// Inline override codes ({\\b1}, {\\an8}, …) and \\N line breaks are stripped
// so the imported text shows what the viewer sees, not the raw markup.

import { repairDoubledRanges } from "./text-offsets.js";

export interface AssCue {
  index: number;
  startUs: number;
  endUs: number;
  text: string;
  style?: string;
}

const TIME = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/;

function timeToUs(s: string): number {
  const m = TIME.exec(s.trim());
  if (!m) throw new Error(`Invalid ASS timestamp: ${s}`);
  const cs = m[4].padEnd(2, "0").slice(0, 2);
  const ms = parseInt(cs, 10) * 10;
  return (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1_000_000 + ms * 1000;
}

function stripOverrides(raw: string): string {
  // Drop ASS override blocks like {\\b1\\an8}; convert \\N and \\n to real newlines;
  // drop \\h (hard-space marker) → keep as space.
  return raw
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .trim();
}

export function parseAss(content: string): AssCue[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let inEvents = false;
  let format: string[] | null = null;
  const cues: AssCue[] = [];
  let idx = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      inEvents = /^\[events\]/i.test(line);
      continue;
    }
    if (!inEvents) continue;
    if (/^Format\s*:/i.test(line)) {
      format = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(line)) continue;
    if (!format) {
      // ASS spec says Format must precede Dialogue, but accept the common
      // default if missing: Layer, Start, End, Style, Name, MarginL, MarginR,
      // MarginV, Effect, Text.
      format = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    }
    const rest = line.slice(line.indexOf(":") + 1).trim();
    const startCol = format.indexOf("start");
    const endCol = format.indexOf("end");
    const textCol = format.indexOf("text");
    const styleCol = format.indexOf("style");
    if (startCol < 0 || endCol < 0 || textCol < 0) {
      throw new Error(`ASS Format line missing required columns (start/end/text): ${format.join(",")}`);
    }
    // Split into format.length-1 columns, the LAST column (text) absorbs the
    // remaining commas — Dialogue text fields routinely contain commas.
    const parts: string[] = [];
    let i = 0;
    let cur = "";
    let col = 0;
    while (i < rest.length) {
      const ch = rest[i];
      if (ch === "," && col < format.length - 1) {
        parts.push(cur);
        cur = "";
        col++;
      } else {
        cur += ch;
      }
      i++;
    }
    parts.push(cur);
    if (parts.length < format.length) {
      // Malformed line — skip rather than throwing.
      continue;
    }
    const startUs = timeToUs(parts[startCol]);
    const endUs = timeToUs(parts[endCol]);
    if (endUs <= startUs) continue; // CapCut/JianYing won't render zero/neg cues
    const text = stripOverrides(parts[textCol]);
    if (!text) continue;
    idx++;
    cues.push({
      index: idx,
      startUs,
      endUs,
      text,
      style: styleCol >= 0 ? parts[styleCol].trim() : undefined,
    });
  }
  return cues;
}

// --- Export (export-ass) ---
// renderAss is pure: it renders a prebuilt AssDocument, no draft required.
// ASS colours are byte-reversed — blue, green, red — with alpha 00 = OPAQUE:
// "#RRGGBB" becomes &HAABBGGRR in a Style line and &HBBGGRR& in an inline
// \c override. Span offsets are UTF-16 code units of the cue text, the same
// scheme the draft's styles[].range uses (text-offsets.ts, issue #85).

export interface AssSpanStyle {
  start: number; // UTF-16 code-unit index into the cue text, inclusive
  end: number; // exclusive
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string; // "#RRGGBB"
  size?: number;
}

export interface AssStyleDef {
  name: string;
  fontName: string;
  fontSize: number;
  color: string; // PrimaryColour as "#RRGGBB"
  alpha: number; // 0..1 opacity of the primary fill
  secondaryColor?: string; // pre-highlight karaoke colour; defaults to `color`
  bold: boolean;
  italic: boolean;
  underline: boolean;
  alignment: number; // ASS numpad alignment (1..9)
  borderStyle: 1 | 3; // 1 = outline + shadow, 3 = opaque box
  outlineWidth: number;
  outlineColor: string;
  outlineAlpha: number;
  shadowDistance: number;
  backColor: string; // shadow colour (borderStyle 1) or box colour (3)
  backAlpha: number;
}

export type AssStyleBase = Omit<AssStyleDef, "name">;

export interface AssWord {
  word: string;
  startUs: number;
  endUs: number;
}

export interface AssEvent {
  startUs: number;
  endUs: number;
  text: string; // real newlines; escaped to \N on render
  style: string; // AssStyleDef.name; unknown names fall back to the first style
  spans?: AssSpanStyle[]; // non-overlapping override ranges (ignored with words)
  words?: AssWord[]; // karaoke word timing, rendered as {\k<centiseconds>}
}

export interface AssDocument {
  title?: string;
  playResX: number;
  playResY: number;
  styles: AssStyleDef[];
  events: AssEvent[];
}

const HEX_RRGGBB = /^#?([0-9a-fA-F]{6})$/;

function hexChannels(hex: string): [number, number, number] {
  const m = HEX_RRGGBB.exec(hex);
  const h = m ? m[1] : "FFFFFF";
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** "#RRGGBB" + opacity -> Style-line "&HAABBGGRR" (alpha byte 00 = opaque). */
export function formatAssColor(hex: string, alpha = 1): string {
  const [r, g, b] = hexChannels(hex);
  const a = 255 - Math.max(0, Math.min(255, Math.round(alpha * 255)));
  const byte = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `&H${byte(a)}${byte(b)}${byte(g)}${byte(r)}`;
}

/** "#RRGGBB" -> inline override "&HBBGGRR&" (the \c / \1c form). */
export function formatAssInlineColor(hex: string): string {
  const [r, g, b] = hexChannels(hex);
  const byte = (n: number) => n.toString(16).padStart(2, "0").toUpperCase();
  return `&H${byte(b)}${byte(g)}${byte(r)}&`;
}

/**
 * Any ASS colour form back to "#RRGGBB": &HBBGGRR&, &HAABBGGRR, or bare hex
 * digits, case-insensitive. 8 digits carry alpha (returned as 0..1 opacity).
 * Returns null when the value is not hex.
 */
export function parseAssColor(raw: string): { color: string; alpha?: number } | null {
  const digits = raw.trim().replace(/^&H/i, "").replace(/&$/, "");
  if (!/^[0-9a-fA-F]{1,8}$/.test(digits)) return null;
  const hasAlpha = digits.length > 6;
  const padded = digits.padStart(hasAlpha ? 8 : 6, "0");
  const at = hasAlpha ? 2 : 0;
  const b = padded.slice(at, at + 2);
  const g = padded.slice(at + 2, at + 4);
  const r = padded.slice(at + 4, at + 6);
  const color = `#${r}${g}${b}`.toUpperCase();
  if (!hasAlpha) return { color };
  return { color, alpha: (255 - parseInt(padded.slice(0, 2), 16)) / 255 };
}

/** H:MM:SS.cc — centisecond rounding carried so 1.9999s emits 0:00:02.00. */
export function assTime(us: number): string {
  const cs = Math.round(us / 10_000);
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6_000);
  const s = Math.floor((cs % 6_000) / 100);
  const c = cs % 100;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(c)}`;
}

// `{` opens an override block and `\` starts an escape in ASS renderers, so
// literal braces must leave as \{ \}; real newlines become \N.
function escapeAssText(text: string): string {
  return text.replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\r?\n/g, "\\N");
}

const formatNum = (n: number): string => String(Math.round(n * 100) / 100);

export function defaultAssStyle(name: string): AssStyleDef {
  return {
    name,
    fontName: "Arial",
    fontSize: 15,
    color: "#FFFFFF",
    alpha: 1,
    bold: false,
    italic: false,
    underline: false,
    alignment: 2,
    borderStyle: 1,
    outlineWidth: 0,
    outlineColor: "#000000",
    outlineAlpha: 1,
    shadowDistance: 0,
    backColor: "#000000",
    backAlpha: 1,
  };
}

interface ActiveAttrs {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  size: number;
}

// {\k<centiseconds>} holds each word until its onset. Word i carries the
// distance to word i+1's onset (the last word its own duration), computed on
// absolute rounded centiseconds so rounding never accumulates drift: highlight
// onsets land exactly on the stored word starts, gaps included.
function karaokeText(words: AssWord[], startUs: number): string {
  const onsetCs = (us: number) => Math.round((us - startUs) / 10_000);
  return words
    .map((w, i) => {
      const next = i + 1 < words.length ? onsetCs(words[i + 1].startUs) : onsetCs(w.endUs);
      const k = Math.max(0, next - onsetCs(w.startUs));
      return `{\\k${k}}${escapeAssText(w.word)}`;
    })
    .join(" ");
}

// Inline overrides persist to the end of the line, so every span boundary
// emits only the tags that change the active state — including the reset back
// to the style's own values after a styled range.
function eventText(ev: AssEvent, style: AssStyleDef): string {
  if (ev.words && ev.words.length > 0) return karaokeText(ev.words, ev.startUs);
  const spans = [...(ev.spans ?? [])].sort((a, b) => a.start - b.start);
  if (spans.length === 0) return escapeAssText(ev.text);
  const defaults: ActiveAttrs = {
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    color: style.color,
    size: style.fontSize,
  };
  let active = { ...defaults };
  const emit = (target: ActiveAttrs): string => {
    let tags = "";
    if (target.bold !== active.bold) tags += `\\b${target.bold ? 1 : 0}`;
    if (target.italic !== active.italic) tags += `\\i${target.italic ? 1 : 0}`;
    if (target.underline !== active.underline) tags += `\\u${target.underline ? 1 : 0}`;
    if (target.size !== active.size) tags += `\\fs${formatNum(target.size)}`;
    if (target.color !== active.color) tags += `\\c${formatAssInlineColor(target.color)}`;
    active = target;
    return tags ? `{${tags}}` : "";
  };
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(span.start, cursor);
    const end = Math.min(span.end, ev.text.length);
    if (end <= start) continue;
    if (start > cursor) out += emit(defaults) + escapeAssText(ev.text.slice(cursor, start));
    out +=
      emit({
        bold: span.bold ?? defaults.bold,
        italic: span.italic ?? defaults.italic,
        underline: span.underline ?? defaults.underline,
        color: span.color ?? defaults.color,
        size: span.size ?? defaults.size,
      }) + escapeAssText(ev.text.slice(start, end));
    cursor = end;
  }
  if (cursor < ev.text.length) out += emit(defaults) + escapeAssText(ev.text.slice(cursor));
  return out;
}

function styleLine(s: AssStyleDef): string {
  const b = (v: boolean) => (v ? "-1" : "0");
  return [
    `Style: ${s.name}`,
    s.fontName,
    formatNum(s.fontSize),
    formatAssColor(s.color, s.alpha),
    formatAssColor(s.secondaryColor ?? s.color, s.alpha),
    formatAssColor(s.outlineColor, s.outlineAlpha),
    formatAssColor(s.backColor, s.backAlpha),
    b(s.bold),
    b(s.italic),
    b(s.underline),
    "0",
    "100",
    "100",
    "0",
    "0",
    String(s.borderStyle),
    formatNum(s.outlineWidth),
    formatNum(s.shadowDistance),
    String(s.alignment),
    "10",
    "10",
    "10",
    "1",
  ].join(",");
}

export function renderAss(doc: AssDocument): string {
  const styles = doc.styles.length > 0 ? doc.styles : [defaultAssStyle("Default")];
  const byName = new Map(styles.map((s) => [s.name, s]));
  const lines = [
    "[Script Info]",
    ...(doc.title ? [`Title: ${doc.title.replace(/\s+/g, " ").trim()}`] : []),
    "ScriptType: v4.00+",
    `PlayResX: ${doc.playResX}`,
    `PlayResY: ${doc.playResY}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles.map(styleLine),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...doc.events.map((ev) => {
      const style = byName.get(ev.style) ?? styles[0];
      return `Dialogue: 0,${assTime(ev.startUs)},${assTime(ev.endUs)},${style.name},,0,0,0,,${eventText(ev, style)}`;
    }),
  ];
  return `${lines.join("\n")}\n`;
}

// --- Draft text material -> ASS style + spans ---
// The material's `content` JSON ({ text, styles: [{range, size, bold, ...}] })
// carries one style block per range. The block signature covering the most
// code units becomes the ASS Style (a karaoke word-segment's highlight block
// may be listed first, so styles[0] is NOT reliably the default); every other
// block becomes an inline span carrying only the attributes that differ.
// Border/shadow/background material fields map onto BorderStyle/Outline/
// Shadow/BackColour with the draft's raw numbers — CapCut stores them relative
// to the text size, ASS wants PlayRes pixels, and no scale is invented here.

export interface TextMaterialLike {
  content: string;
  alignment?: number; // draft: 0 left, 1 center, 2 right
  font_name?: string;
  has_border?: boolean;
  border_color?: string;
  border_width?: number;
  border_alpha?: number;
  has_shadow?: boolean;
  shadow_color?: string;
  shadow_distance?: number;
  shadow_alpha?: number;
  background_color?: string;
  background_alpha?: number;
  [key: string]: unknown;
}

interface NormalizedBlock {
  start: number;
  end: number;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  alpha: number;
}

function rgb01ToHex(rgb: [number, number, number]): string {
  const byte = (c: number) =>
    Math.max(0, Math.min(255, Math.round(c * 255)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`;
}

function normalizeBlocks(content: string): { text: string; blocks: NormalizedBlock[] } {
  let parsed: { text?: string; styles?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return { text: "", blocks: [] };
  }
  const text = typeof parsed.text === "string" ? parsed.text : "";
  const styles = Array.isArray(parsed.styles) ? parsed.styles : [];
  const ranges: Array<[number, number]> = styles.map((s) => {
    const r = s.range;
    return Array.isArray(r) && typeof r[0] === "number" && typeof r[1] === "number" ? [r[0], r[1]] : [0, text.length];
  });
  const repaired = repairDoubledRanges(text, ranges) ?? ranges;
  const blocks: NormalizedBlock[] = [];
  for (let i = 0; i < styles.length; i++) {
    const s = styles[i];
    const solid = (s.fill as { content?: { solid?: { color?: [number, number, number]; alpha?: number } } } | undefined)
      ?.content?.solid;
    const start = Math.max(0, Math.min(repaired[i][0], text.length));
    const end = Math.max(0, Math.min(repaired[i][1], text.length));
    if (end <= start) continue;
    blocks.push({
      start,
      end,
      size: typeof s.size === "number" && Number.isFinite(s.size) ? s.size : 15,
      bold: s.bold === true,
      italic: s.italic === true,
      underline: s.underline === true,
      color: Array.isArray(solid?.color) ? rgb01ToHex(solid.color) : "#FFFFFF",
      alpha: typeof solid?.alpha === "number" ? solid.alpha : 1,
    });
  }
  return { text, blocks };
}

export function assStyleFromMaterial(mat: TextMaterialLike): { style: AssStyleBase; spans: AssSpanStyle[] } {
  const { blocks } = normalizeBlocks(mat.content);
  const signature = (b: NormalizedBlock) => `${b.size}|${b.bold}|${b.italic}|${b.underline}|${b.color}|${b.alpha}`;
  const covered = new Map<string, number>();
  for (const b of blocks) covered.set(signature(b), (covered.get(signature(b)) ?? 0) + (b.end - b.start));
  let baseKey: string | null = null;
  for (const b of blocks) {
    const key = signature(b);
    if (baseKey === null || (covered.get(key) as number) > (covered.get(baseKey) as number)) baseKey = key;
  }
  const base = blocks.find((b) => signature(b) === baseKey);

  const style: AssStyleBase = {
    ...defaultAssStyle(""),
    fontName: typeof mat.font_name === "string" && mat.font_name !== "" ? mat.font_name : "Arial",
    alignment: [1, 2, 3][mat.alignment ?? 1] ?? 2,
  };
  if (base) {
    style.fontSize = base.size;
    style.color = base.color;
    style.alpha = base.alpha;
    style.bold = base.bold;
    style.italic = base.italic;
    style.underline = base.underline;
  }
  if (mat.has_border && typeof mat.border_color === "string") {
    style.outlineWidth = mat.border_width ?? 1;
    style.outlineColor = mat.border_color;
    style.outlineAlpha = mat.border_alpha ?? 1;
  }
  if (mat.has_shadow) {
    style.shadowDistance = mat.shadow_distance ?? 1;
    style.backColor = typeof mat.shadow_color === "string" ? mat.shadow_color : "#000000";
    style.backAlpha = mat.shadow_alpha ?? 1;
  }
  // An opaque box wins the shared BackColour slot over the shadow colour.
  if (typeof mat.background_color === "string" && (mat.background_alpha ?? 0) > 0) {
    style.borderStyle = 3;
    style.backColor = mat.background_color;
    style.backAlpha = mat.background_alpha ?? 1;
  }

  const spans: AssSpanStyle[] = [];
  if (base) {
    for (const b of blocks) {
      if (signature(b) === baseKey) continue;
      const span: AssSpanStyle = { start: b.start, end: b.end };
      if (b.bold !== base.bold) span.bold = b.bold;
      if (b.italic !== base.italic) span.italic = b.italic;
      if (b.underline !== base.underline) span.underline = b.underline;
      if (b.color !== base.color) span.color = b.color;
      if (b.size !== base.size) span.size = b.size;
      // A block differing only in alpha has no inline mapping — leave it base.
      if (Object.keys(span).length > 2) spans.push(span);
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return { style, spans };
}
