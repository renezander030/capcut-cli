// Dub a subtitle track: one synthesized clip per cue, placed at the cue's start on one audio track.
// The pure parts live here (spoken text, placement; cues come from srt.ts parseSubtitles); cmdDub in index.ts runs the TTS tool and writes.

// Subtitle markup a cue can carry: SRT's <i> <b> <u> <s> <font>, WebVTT's <v> <c> <lang> <ruby> <rt>. Only these are
// removed, so a bare "<" or ">" in the words ("2 < 3") stays spoken.
const KNOWN_TAG = /<\/?(?:i|b|u|s|font|v|c|lang|ruby|rt)(?:[.\s][^>]*)?>/gi;

/**
 * What the TTS tool hears for a cue: known markup removed (tags, WebVTT ruby annotations and inline timestamps, ASS
 * {\an8} overrides), lines joined with a space. Character references are not decoded here: the WebVTT reader already
 * decoded them, and SRT text is spoken as written.
 */
export function cueSpeechText(text: string, markup = true): string {
  const plain = markup
    ? text
        .replace(/<rt>[\s\S]*?<\/rt>/gi, "")
        .replace(/<\d+:\d{2}[\d:.]*>/g, "")
        .replace(KNOWN_TAG, "")
    : text;
  return plain
    .replace(/\{\\[^}]*\}/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

/** A clip to place: its cue, where it starts and how long its speech runs. Callers may carry more fields along. */
export interface DubSpeech {
  cue: number;
  startUs: number;
  speechUs: number;
}

/** A placed clip: the caller's clip with every field it carried, plus its length on the track. */
export type DubClip<T extends DubSpeech = DubSpeech> = T & { durationUs: number; trimmed: boolean };

export interface Occupied {
  startUs: number;
  endUs: number;
}

/**
 * Place each clip at its cue's start for its full speech length. A clip that would run into the next clip or into a
 * segment already on the track is refused, or cut at that point with `trimOverlap`. Returns the clips (in start
 * order, each still carrying the caller's own fields) or the refusals.
 */
export function planDubClips<T extends DubSpeech>(
  clips: T[],
  occupied: Occupied[],
  trimOverlap: boolean,
): { clips: DubClip<T>[]; refusals: string[] } {
  const ordered = [...clips].sort((a, b) => a.startUs - b.startUs);
  const out: DubClip<T>[] = [];
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
