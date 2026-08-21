// Zero-dep ASS / SSA subtitle parser. Returns cues with microsecond timings,
// shaped identically to SrtCue so the import pipeline can be shared.
// We parse the [Events] Dialogue: lines plus the [V4+ Styles] section. The
// Format: header is read to find the column indices (these vary between ASS
// files). ASS time format is H:MM:SS.cc (centiseconds).
// The displayed text still shows what the viewer sees — tags never leak into
// it — but the inline overrides this module maps onto the draft's per-range
// styling (\b, \i, \u, \c/\1c, \fs, \r) come back as `spans`, with offsets in
// UTF-16 code units of the FINAL text (after tag removal, \N -> newline).
// Every other override ({\an8}, \pos, \k, ...) is stripped as before.

import { repairDoubledRanges } from "./text-offsets.js";

/** Segment-level defaults a Dialogue's Style line carries into the import. */
export interface AssStyleSeed {
  fontSize?: number;
  color?: string; // "#RRGGBB"
  alignment?: number; // draft scheme: 0 left, 1 center, 2 right
  bold?: boolean;
  italic?: boolean;
}

export interface AssCue {
  index: number;
  startUs: number;
  endUs: number;
  text: string;
  style?: string;
  spans?: AssSpanStyle[]; // inline override ranges that differ from the style
  styleSeed?: AssStyleSeed; // resolved from the referenced Style line
}

const TIME = /^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/;

function timeToUs(s: string): number {
  const m = TIME.exec(s.trim());
  if (!m) throw new Error(`Invalid ASS timestamp: ${s}`);
  const cs = m[4].padEnd(2, "0").slice(0, 2);
  const ms = parseInt(cs, 10) * 10;
  return (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1_000_000 + ms * 1000;
}

interface InlineState {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  size?: number;
}

const INLINE_KEYS = ["bold", "italic", "underline", "color", "size"] as const;

function sameState(a: InlineState, b: InlineState): boolean {
  return INLINE_KEYS.every((k) => a[k] === b[k]);
}

// One override block's tags applied onto the running state. \b takes 0/1 and
// the 400/700 weight form; \c and \1c set the primary colour; \r drops every
// override (back to the Style line, ignoring \r<OtherStyle> retargeting).
// Unrecognized tags leave the state alone — they are stripped, not styling.
function applyOverrides(block: string, state: InlineState): InlineState {
  let next = { ...state };
  for (const tag of block.split("\\")) {
    const bold = /^b(\d+)/.exec(tag);
    const italic = /^i([01])/.exec(tag);
    const underline = /^u([01])/.exec(tag);
    const size = /^fs(\d+(?:\.\d+)?)/.exec(tag);
    const color = /^1?c(&H[0-9a-fA-F]{1,8}&?)/.exec(tag);
    if (bold) {
      const n = parseInt(bold[1], 10);
      next.bold = n === 1 || n >= 700;
    } else if (italic) {
      next.italic = italic[1] === "1";
    } else if (underline) {
      next.underline = underline[1] === "1";
    } else if (size) {
      next.size = parseFloat(size[1]);
    } else if (color) {
      const parsed = parseAssColor(color[1]);
      if (parsed) next.color = parsed.color;
    } else if (/^r/.test(tag)) {
      next = {};
    }
  }
  return next;
}

// Dialogue text -> displayed text + inline override spans. Tag state persists
// until the next block changes it, so a span runs from the block that set it
// to the block that changes it (or the end of the line). The final text is
// trimmed exactly as the old flattening did; span offsets shift with the trim.
function parseDialogueText(raw: string): { text: string; spans: AssSpanStyle[] } {
  let text = "";
  const spans: AssSpanStyle[] = [];
  let state: InlineState = {};
  let spanStart = 0;
  const flush = (end: number) => {
    if (end <= spanStart || !INLINE_KEYS.some((k) => state[k] !== undefined)) return;
    const span: AssSpanStyle = { start: spanStart, end };
    if (state.bold !== undefined) span.bold = state.bold;
    if (state.italic !== undefined) span.italic = state.italic;
    if (state.underline !== undefined) span.underline = state.underline;
    if (state.color !== undefined) span.color = state.color;
    if (state.size !== undefined) span.size = state.size;
    spans.push(span);
  };
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const n = raw[i + 1];
      if (n === "N" || n === "n") {
        text += "\n";
      } else if (n === "h") {
        text += " ";
      } else if (n === "{" || n === "}") {
        text += n; // export-ass escapes literal braces this way
      } else {
        text += ch + n;
      }
      i += 2;
      continue;
    }
    if (ch === "{") {
      const close = raw.indexOf("}", i + 1);
      if (close < 0) {
        // Unmatched brace: literal, exactly as the old regex left it.
        text += ch;
        i++;
        continue;
      }
      const next = applyOverrides(raw.slice(i + 1, close), state);
      if (!sameState(next, state)) {
        flush(text.length);
        state = next;
        spanStart = text.length;
      }
      i = close + 1;
      continue;
    }
    text += ch;
    i++;
  }
  flush(text.length);
  const lead = text.length - text.trimStart().length;
  const trimmed = text.trim();
  const adjusted = spans.flatMap((s) => {
    const start = Math.max(0, s.start - lead);
    const end = Math.min(trimmed.length, s.end - lead);
    return end > start ? [{ ...s, start, end }] : [];
  });
  return { text: trimmed, spans: adjusted };
}

// Spans carry only what actually differs from the Dialogue's Style line, so a
// tag that restates the default (the \b0 half of a bold range, a \c back to
// the primary colour) produces no range at all.
function pruneAgainstStyle(spans: AssSpanStyle[], seed: AssStyleSeed | undefined): AssSpanStyle[] {
  const bold = seed?.bold ?? false;
  const italic = seed?.italic ?? false;
  return spans.flatMap((s) => {
    const out: AssSpanStyle = { start: s.start, end: s.end };
    if (s.bold !== undefined && s.bold !== bold) out.bold = s.bold;
    if (s.italic !== undefined && s.italic !== italic) out.italic = s.italic;
    if (s.underline !== undefined && s.underline !== false) out.underline = s.underline;
    if (s.color !== undefined && s.color !== seed?.color) out.color = s.color;
    if (s.size !== undefined && s.size !== seed?.fontSize) out.size = s.size;
    return Object.keys(out).length > 2 ? [out] : [];
  });
}

// A [V4+ Styles] Style line reduced to what the import can seed. ASS numpad
// alignment columns (1/4/7 left, 2/5/8 center, 3/6/9 right) fold onto the
// draft's 0/1/2; Bold/Italic are the -1/0 convention (1 accepted too).
function parseStyleLine(line: string, format: string[]): { name: string; seed: AssStyleSeed } | null {
  const values = line
    .slice(line.indexOf(":") + 1)
    .split(",")
    .map((s) => s.trim());
  const col = (name: string): string | undefined => {
    const at = format.indexOf(name);
    return at >= 0 && at < values.length ? values[at] : undefined;
  };
  const name = col("name");
  if (!name) return null;
  const seed: AssStyleSeed = {};
  const fontSize = Number(col("fontsize"));
  if (Number.isFinite(fontSize) && fontSize > 0) seed.fontSize = fontSize;
  const primary = col("primarycolour");
  const color = primary ? parseAssColor(primary) : null;
  if (color) seed.color = color.color;
  const alignment = Number(col("alignment"));
  if (Number.isInteger(alignment) && alignment >= 1 && alignment <= 9) seed.alignment = (alignment - 1) % 3;
  const bold = col("bold");
  if (bold !== undefined) seed.bold = bold === "-1" || bold === "1";
  const italic = col("italic");
  if (italic !== undefined) seed.italic = italic === "-1" || italic === "1";
  return { name, seed };
}

export function parseAss(content: string): AssCue[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let section: "events" | "styles" | "other" = "other";
  let format: string[] | null = null;
  let styleFormat: string[] | null = null;
  const styleSeeds = new Map<string, AssStyleSeed>();
  const cues: AssCue[] = [];
  let idx = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("[")) {
      section = /^\[events\]/i.test(line) ? "events" : /^\[v4\+? styles\]/i.test(line) ? "styles" : "other";
      continue;
    }
    if (section === "styles") {
      if (/^Format\s*:/i.test(line)) {
        styleFormat = line
          .slice(line.indexOf(":") + 1)
          .split(",")
          .map((s) => s.trim().toLowerCase());
      } else if (/^Style\s*:/i.test(line) && styleFormat) {
        const parsed = parseStyleLine(line, styleFormat);
        if (parsed) styleSeeds.set(parsed.name, parsed.seed);
      }
      continue;
    }
    if (section !== "events") continue;
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
    const { text, spans } = parseDialogueText(parts[textCol]);
    if (!text) continue;
    // "*Default" is SSA's marker for a synthesized style — same style name.
    const styleName = styleCol >= 0 ? parts[styleCol].trim().replace(/^\*/, "") : undefined;
    const seed = styleName !== undefined ? styleSeeds.get(styleName) : undefined;
    const kept = pruneAgainstStyle(spans, seed);
    idx++;
    cues.push({
      index: idx,
      startUs,
      endUs,
      text,
      style: styleName,
      spans: kept.length > 0 ? kept : undefined,
      styleSeed: seed,
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
