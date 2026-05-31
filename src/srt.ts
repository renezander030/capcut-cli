// Zero-dep SRT parser. Returns cues with microsecond timings.
// Format:
//   1
//   00:00:01,000 --> 00:00:04,500
//   line 1
//   line 2
//
//   2
//   ...
// Accepts '.' or ',' as the ms separator. Index lines are optional.

export interface SrtCue {
  index: number;
  startUs: number;
  endUs: number;
  text: string;
}

const TS = /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;

function tsToUs(h: string, m: string, s: string, ms: string): number {
  const msPadded = `${ms}000`.slice(0, 3);
  return ((parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000 + parseInt(msPadded, 10)) * 1000;
}

export function parseSrt(content: string): SrtCue[] {
  const cues: SrtCue[] = [];
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let autoIdx = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i >= lines.length) break;
    let idx = autoIdx + 1;
    if (/^\d+$/.test(lines[i].trim())) {
      idx = parseInt(lines[i].trim(), 10);
      i++;
    }
    if (i >= lines.length) break;
    const m = TS.exec(lines[i]);
    if (!m) throw new Error(`Invalid SRT timestamp near line ${i + 1}: ${lines[i]}`);
    const startUs = tsToUs(m[1], m[2], m[3], m[4]);
    const endUs = tsToUs(m[5], m[6], m[7], m[8]);
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    if (endUs <= startUs) throw new Error(`SRT cue ${idx} has end <= start`);
    cues.push({ index: idx, startUs, endUs, text: textLines.join("\n") });
    autoIdx = idx;
  }
  return cues;
}
