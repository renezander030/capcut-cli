// Dub a subtitle track: one synthesized clip per cue, placed at the cue's start on one audio track.
// The pure parts live here (cue reading, spoken text, placement); cmdDub in index.ts runs the TTS tool and writes.

import { parseSrt, type SrtCue } from "./srt.js";

/** WebVTT's character references, decoded once here so cue text reaches the speech step as written. */
function decodeVttText(line: string): string {
  return line
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&lrm;/g, "\u200e")
    .replace(/&rlm;/g, "\u200f")
    .replace(/&amp;/g, "&");
}

/**
 * Cues from SRT or WebVTT text. WebVTT is read by removing what SRT lacks: the WEBVTT header block, NOTE, STYLE and
 * REGION blocks, cue settings after the end time, and the optional hours in mm:ss.ttt timestamps.
 */
export function parseCueFile(content: string): SrtCue[] {
  const text = content.replace(/\r\n?/g, "\n");
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)) return parseSrt(text);
  const blocks = text.split(/\n{2,}/).slice(1);
  const kept: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((line, i) => !(i === 0 && line.trim() === ""));
    if (lines.length === 0 || /^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(lines[0])) continue;
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const timing = lines[at]
      .replace(/^\s*((?:\d+:)?\d{2}:\d{2}\.\d{1,3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}\.\d{1,3}).*$/, "$1 --> $2")
      .replace(/(^|--> )(\d{2}:\d{2}\.\d)/g, "$100:$2");
    kept.push([timing, ...lines.slice(at + 1).map(decodeVttText)].join("\n"));
  }
  return parseSrt(kept.join("\n\n"));
}

// Subtitle markup a cue can carry: SRT's <i> <b> <u> <s> <font>, WebVTT's <v> <c> <lang> <ruby> <rt>. Only these are
// removed, so a bare "<" or ">" in the words ("2 < 3") stays spoken.
const KNOWN_TAG = /<\/?(?:i|b|u|s|font|v|c|lang|ruby|rt)(?:[.\s][^>]*)?>/gi;

/**
 * What the TTS tool hears for a cue: known markup removed (tags, WebVTT ruby annotations and inline timestamps, ASS
 * {\an8} overrides), lines joined with a space. Character references are not decoded here: the WebVTT reader already
 * decoded them, and SRT text is spoken as written.
 */
export function cueSpeechText(text: string): string {
  return text
    .replace(/<rt>[\s\S]*?<\/rt>/gi, "")
    .replace(/<\d+:\d{2}[\d:.]*>/g, "")
    .replace(KNOWN_TAG, "")
    .replace(/\{\\[^}]*\}/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

export interface DubClip {
  cue: number;
  startUs: number;
  speechUs: number;
  durationUs: number;
  trimmed: boolean;
}

export interface Occupied {
  startUs: number;
  endUs: number;
}

/**
 * Place each clip at its cue's start for its full speech length. A clip that would run into the next clip or into a
 * segment already on the track is refused, or cut at that point with `trimOverlap`. Returns the clips or the refusals.
 */
export function planDubClips(
  clips: Array<{ cue: number; startUs: number; speechUs: number }>,
  occupied: Occupied[],
  trimOverlap: boolean,
): { clips: DubClip[]; refusals: string[] } {
  const ordered = [...clips].sort((a, b) => a.startUs - b.startUs);
  const out: DubClip[] = [];
  const refusals: string[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const clip = ordered[i];
    const blocks = [
      ...(i + 1 < ordered.length ? [{ at: ordered[i + 1].startUs, what: `cue ${ordered[i + 1].cue}` }] : []),
      ...occupied
        .filter((o) => o.endUs > clip.startUs)
        .map((o) => ({ at: o.startUs, what: "a segment already on the track" })),
    ].filter((b) => b.at < clip.startUs + clip.speechUs);
    const first = blocks.sort((a, b) => a.at - b.at)[0];
    if (!first) {
      out.push({ ...clip, durationUs: clip.speechUs, trimmed: false });
      continue;
    }
    const room = first.at - clip.startUs;
    if (!trimOverlap || room <= 0) {
      refusals.push(
        `cue ${clip.cue}: its speech runs ${((clip.speechUs - Math.max(room, 0)) / 1e6).toFixed(3)} s into ${first.what}` +
          (room <= 0 ? " (it starts inside it)" : ""),
      );
      continue;
    }
    out.push({ ...clip, durationUs: room, trimmed: true });
  }
  return { clips: out, refusals };
}
