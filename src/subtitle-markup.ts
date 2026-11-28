import type { TextRangeInput } from "./decorators.js";

type Style = Omit<TextRangeInput, "start" | "end">;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  lrm: "\u200e",
  rlm: "\u200f",
};
const COLORS: Record<string, string> = {
  black: "#000000",
  white: "#FFFFFF",
  red: "#FF0000",
  green: "#008000",
  blue: "#0000FF",
  yellow: "#FFFF00",
  cyan: "#00FFFF",
  aqua: "#00FFFF",
  magenta: "#FF00FF",
  fuchsia: "#FF00FF",
  lime: "#00FF00",
  silver: "#C0C0C0",
  gray: "#808080",
  maroon: "#800000",
  navy: "#000080",
  olive: "#808000",
  purple: "#800080",
  teal: "#008080",
};

function entity(token: string): string {
  const name = token.slice(1, -1).toLowerCase();
  if (!name.startsWith("#")) return ENTITIES[name] ?? token;
  const point = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : token;
}

function color(value: string): string | undefined {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map((ch) => ch + ch).join("")}`.toUpperCase();
  return COLORS[value.toLowerCase()];
}

/** Recognized subtitle markup becomes non-overlapping ranges in the final UTF-16 text. */
export function parseSubtitleMarkup(raw: string): { text: string; spans: TextRangeInput[]; unsupportedStyles: number } {
  let text = "";
  let state: Style = {};
  let start = 0;
  let cursor = 0;
  let unsupportedStyles = 0;
  const spans: TextRangeInput[] = [];
  const stack: Array<{ tag: string; previous: Style }> = [];
  const flush = () => {
    if (text.length > start && Object.keys(state).length > 0) spans.push({ start, end: text.length, ...state });
    start = text.length;
  };
  // Decode entities while walking the original input, so &lt;i&gt; stays literal rather than becoming a tag.
  const tokens = /&(?:#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);|<\/?(?:b|i|u|s|font)(?:\s+[^>]*?)?\s*>/gi;
  for (const match of raw.matchAll(tokens)) {
    text += raw.slice(cursor, match.index);
    const token = match[0];
    cursor = match.index + token.length;
    if (token.startsWith("&")) {
      text += entity(token);
      continue;
    }
    const tag = /^<(\/?)(b|i|u|s|font)(?:\s+([^>]*?))?\s*>$/i.exec(token);
    if (!tag) {
      text += token;
      continue;
    }
    flush();
    const name = tag[2].toLowerCase();
    if (tag[1]) {
      let index = stack.length - 1;
      while (index >= 0 && stack[index].tag !== name) index--;
      if (index >= 0) {
        state = stack[index].previous;
        stack.splice(index);
      }
      continue;
    }
    stack.push({ tag: name, previous: state });
    state = { ...state };
    if (name === "b") state.bold = true;
    else if (name === "i") state.italic = true;
    else if (name === "u") state.underline = true;
    else if (name === "font") {
      const attrs = tag[3] ?? "";
      const selected = /\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const parsed = selected ? color(selected[1] ?? selected[2] ?? selected[3]) : undefined;
      if (parsed) state.font_color = parsed;
      if ((selected && !parsed) || /\b(?:face|size)\s*=/i.test(attrs)) unsupportedStyles++;
    } else if (name === "s") unsupportedStyles++;
  }
  text += raw.slice(cursor);
  flush();
  return { text, spans, unsupportedStyles };
}

/** Overlay explicit keyword ranges without losing the subtitle's other inline properties. */
export function overlaySubtitleStyles(base: TextRangeInput[], overlay: TextRangeInput[]): TextRangeInput[] {
  const boundaries = [...new Set([...base, ...overlay].flatMap((range) => [range.start, range.end]))].sort(
    (a, b) => a - b,
  );
  const result: TextRangeInput[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1];
    const end = boundaries[i];
    const lower = base.find((range) => range.start <= start && range.end >= end);
    const upper = overlay.find((range) => range.start <= start && range.end >= end);
    if (!lower && !upper) continue;
    result.push({ ...lower, ...upper, start, end });
  }
  return result;
}
