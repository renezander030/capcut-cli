import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface Timerange {
  start: number;
  duration: number;
}

export interface Segment {
  id: string;
  material_id: string;
  target_timerange: Timerange;
  source_timerange: Timerange;
  speed: number;
  volume: number;
  visible: boolean;
  clip: {
    alpha: number;
    rotation: number;
    scale: { x: number; y: number };
    transform: { x: number; y: number };
  };
  extra_material_refs: string[];
  render_index: number;
  [key: string]: unknown;
}

export interface Track {
  id: string;
  type: string;
  name: string;
  attribute: number;
  segments: Segment[];
}

export interface MaterialText {
  id: string;
  type: string;
  content: string;
  font_size: number;
  text_color: string;
  alignment: number;
  [key: string]: unknown;
}

export interface MaterialVideo {
  id: string;
  path: string;
  material_name: string;
  type: string;
  duration: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface MaterialAudio {
  id: string;
  path: string;
  name: string;
  duration: number;
  type: string;
  [key: string]: unknown;
}

export interface Draft {
  id: string;
  name: string;
  duration: number;
  fps: number;
  canvas_config: {
    width: number;
    height: number;
    ratio: string;
  };
  tracks: Track[];
  materials: {
    videos: MaterialVideo[];
    audios: MaterialAudio[];
    texts: MaterialText[];
    speeds: Array<{ id: string; speed: number; [key: string]: unknown }>;
    material_animations: unknown[];
    audio_fades: unknown[];
    transitions: unknown[];
    [key: string]: unknown[];
  };
  platform?: {
    app_source: string;
    app_version: string;
    os: string;
  };
  [key: string]: unknown;
}

export function findDraft(input: string): string {
  const resolved = resolve(input);
  if (existsSync(resolved) && statSync(resolved).isFile()) return resolved;
  const candidates = [
    resolve(resolved, "draft_content.json"),
    resolve(resolved, "draft_info.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  throw new Error(`No draft found at: ${input}\nExpected draft_content.json or draft_info.json`);
}

let rawOriginal: string | null = null;

export function loadDraft(path: string): { draft: Draft; filePath: string } {
  const filePath = findDraft(path);
  rawOriginal = readFileSync(filePath, "utf-8");
  const draft = JSON.parse(rawOriginal) as Draft;
  return { draft, filePath };
}

export function saveDraft(filePath: string, draft: Draft): void {
  const bakPath = filePath + ".bak";
  if (existsSync(filePath)) {
    const original = rawOriginal ?? readFileSync(filePath, "utf-8");
    writeFileSync(bakPath, original, "utf-8");
  }
  // Detect original indent: if first line after { starts with tab use tab, else count spaces
  const indent = detectIndent(rawOriginal);
  writeFileSync(filePath, JSON.stringify(draft, null, indent), "utf-8");
}

function detectIndent(raw: string | null): string | number {
  if (!raw) return 0;
  const match = raw.match(/\n(\s+)/);
  if (!match) return 0;
  const ws = match[1];
  if (ws.includes("\t")) return "\t";
  return ws.length;
}

export function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed.text) return parsed.text;
  } catch {
    return content.replace(/<[^>]*>/g, "").replace(/\[|\]/g, "").trim();
  }
  return content;
}

export function updateTextContent(content: string, newText: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed.text !== undefined) {
      parsed.text = newText;
      if (parsed.styles && parsed.styles.length > 0) {
        const encoded = Buffer.from(newText, "utf16le");
        parsed.styles[0].range = [0, encoded.length];
      }
      return JSON.stringify(parsed);
    }
  } catch {
    const match = content.match(/^(.*\])?(.*?)(\[.*)?$/s);
    if (match) {
      return content.replace(/\[[^\]]*\]/, `[${newText}]`);
    }
  }
  return newText;
}

export function findSegment(draft: Draft, id: string): { track: Track; segment: Segment; index: number } | null {
  const shortId = id.toLowerCase();
  for (const track of draft.tracks) {
    for (let i = 0; i < track.segments.length; i++) {
      const seg = track.segments[i];
      if (seg.id === id || seg.id.toLowerCase().startsWith(shortId)) {
        return { track, segment: seg, index: i };
      }
    }
  }
  return null;
}

export function findMaterial<T extends { id: string }>(arr: T[], id: string): T | undefined {
  return arr.find(m => m.id === id);
}

export function getTracksByType(draft: Draft, type: string): Track[] {
  return draft.tracks.filter(t => t.type === type);
}
