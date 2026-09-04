import { spawnSync } from "node:child_process";
import { randomUUID as uuid } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AlignmentReport, alignScript, tokenizeScript } from "./align.js";
import {
  buildEmphasisRanges,
  DEFAULT_KEYWORD_SIZE,
  KARAOKE_HIGHLIGHT_COLOR,
  setTextRanges,
  type TextRangeInput,
} from "./decorators.js";
import type { Draft, Segment, Track } from "./draft.js";
import { findSegment } from "./draft.js";
import { captionStyleFromPreset, type TextStylePreset } from "./preset.js";
import { parseSrt } from "./srt.js";
import { storedTextLength } from "./text-offsets.js";

export interface CaptionOptions {
  audio?: string; // path to audio file; if absent, derived from --from-segment
  fromSegment?: string; // segment ID of an audio segment in the draft to caption
  whisperCmd?: string; // shell-out command; e.g. "whisper" or "whisper-cli" or "faster-whisper"
  whisperModel?: string; // model name; default "base"
  language?: string; // ISO code; default "auto"
  trackName?: string; // default "captions"
  styleRef?: string; // segment ID whose styling to copy
  preset?: TextStylePreset; // make-preset file whose base style to apply
  whisperEngine?: "auto" | "openai" | "whisper-cpp" | "faster-whisper";
  karaoke?: boolean;
  maxWords?: number;
  maxChars?: number;
  maxGapMs?: number;
  highlightWords?: string[]; // per-cue keyword emphasis (case-insensitive whole-word)
  keywordColor?: string; // emphasis colour; default KARAOKE_HIGHLIGHT_COLOR
  keywordSize?: number; // emphasis multiplier on the cue's base font size; default DEFAULT_KEYWORD_SIZE
  colorCycle?: string[]; // rotate the BASE text colour per cue in list order
  /**
   * --script: the known transcript. Whisper's word timing is kept, the
   * script's wording is used (see align.ts); each non-empty script line is a
   * cue boundary, long lines still split at --max-chars.
   */
  scriptText?: string;
}

export interface CaptionWord {
  word: string;
  startUs: number;
  endUs: number;
}

export interface CaptionCue {
  startUs: number;
  endUs: number;
  text: string;
  words?: CaptionWord[];
}

export interface CaptionResult {
  ok: boolean;
  cues: number;
  language?: string;
  track_name: string;
  first_cue?: { start_us: number; text: string };
  last_cue?: { start_us: number; text: string };
  source_audio: string;
  engine: "whisper-cli" | "shell" | "openai" | "stdin-srt";
  engine_name?: string;
  words?: number;
  karaoke?: boolean;
  keyword_matches?: number;
  color_cycle?: number;
  /** --script alignment quality (only when a script was given). */
  script?: AlignmentReport;
}

/**
 * Generate captions by running whisper on the project's audio and emitting
 * real CapCut caption-track segments (not text-segment mimics — fixes the
 * import-srt pain documented in pyJianYingDraft #148).
 *
 * Whisper integration is shell-out; user supplies the binary path. We support
 * the canonical whisper.cpp output naming convention (`<base>.srt`).
 *
 * Architecture:
 *   1. Resolve audio file (either --audio or extracted from --from-segment)
 *   2. Spawn whisper CLI; capture SRT output
 *   3. Parse SRT into caption cues
 *   4. Create captions track + real subtitle material per cue
 */
export function captionDraft(draft: Draft, opts: CaptionOptions): CaptionResult {
  if (opts.styleRef && opts.preset) {
    throw new Error("--style-ref and --preset are mutually exclusive. Pass one style source.");
  }
  const audio = resolveAudio(draft, opts);
  const transcription = runWhisper(audio, opts);
  const recognizedWords = transcription.words.length > 0 ? transcription.words : wordsFromCues(transcription.cues);
  let scriptReport: AlignmentReport | undefined;
  let cues: CaptionCue[];
  if (opts.scriptText !== undefined) {
    const lines = tokenizeScript(opts.scriptText);
    if (lines.length === 0) throw new Error("--script file contains no words.");
    if (recognizedWords.length === 0) {
      throw new Error("Whisper produced no words to align the script to. Check the audio is not silent.");
    }
    const aligned = alignScript(lines, recognizedWords);
    scriptReport = aligned.report;
    cues = opts.karaoke
      ? groupWords(aligned.words, opts.maxWords ?? 4, opts.maxChars ?? 28, (opts.maxGapMs ?? 500) * 1000)
      : // One cue per script line — the author's chunking — split only when a
        // line outgrows --max-chars (words and gaps never split a line).
        aligned.lines.flatMap((line) =>
          groupWords(line, Number.POSITIVE_INFINITY, opts.maxChars ?? 42, Number.POSITIVE_INFINITY),
        );
  } else {
    cues = opts.karaoke
      ? groupWords(recognizedWords, opts.maxWords ?? 4, opts.maxChars ?? 28, (opts.maxGapMs ?? 500) * 1000)
      : transcription.cues;
  }
  if (cues.length === 0) {
    throw new Error("Whisper produced no cues. Check the audio file is not silent and the model name is valid.");
  }

  const trackName = opts.trackName ?? "captions";
  const styleSource = opts.styleRef ? findSegment(draft, opts.styleRef) : null;
  const baseStyle = styleSource
    ? extractTextStyle(draft, styleSource.segment.material_id)
    : opts.preset
      ? captionStyleFromPreset(opts.preset)
      : defaultCaptionStyle();

  let track = draft.tracks.find((t) => t.type === "text" && t.name === trackName);
  if (!track) {
    track = {
      id: uuid(),
      type: "text",
      name: trackName,
      attribute: 0,
      segments: [],
    } as unknown as Track;
    draft.tracks.push(track);
  }

  if (!Array.isArray(draft.materials.texts)) draft.materials.texts = [];

  const highlightWords = opts.highlightWords ?? [];
  const keywordColor = opts.keywordColor ?? KARAOKE_HIGHLIGHT_COLOR;
  const keywordSize = opts.keywordSize ?? DEFAULT_KEYWORD_SIZE;
  const colorCycle = opts.colorCycle ?? [];

  let created = 0;
  let keywordMatches = 0;
  for (let cueIndex = 0; cueIndex < cues.length; cueIndex++) {
    const cue = cues[cueIndex];
    // --color-cycle rotates the BASE colour per cue; keyword emphasis sits on top.
    const cycleColor = colorCycle.length > 0 ? colorCycle[cueIndex % colorCycle.length] : undefined;
    const cueStyle = cycleColor === undefined ? baseStyle : { ...baseStyle, font_color: cycleColor };
    const emphasis = (text: string, presetRanges?: TextRangeInput[]) =>
      buildEmphasisRanges(text, {
        words: highlightWords,
        color: keywordColor,
        sizeMultiplier: keywordSize,
        baseSize: Number(cueStyle.font_size ?? 15),
        baseColor: String(cueStyle.font_color ?? "#FFFFFF"),
        baseBold: Boolean(cueStyle.bold ?? false),
        presetRanges,
      });
    if (opts.karaoke && cue.words && cue.words.length > 0) {
      const fullText = cue.words.map((word) => word.word).join(" ");
      let cursor = 0;
      let cueMatches = 0;
      for (const word of cue.words) {
        const start = cursor;
        const end = start + word.word.length;
        const segmentId = addCaptionSegment(draft, track, fullText, word.startUs, word.endUs, cueStyle);
        const karaokeRange: TextRangeInput = {
          start,
          end,
          font_color: KARAOKE_HIGHLIGHT_COLOR,
          font_size: Number(cueStyle.font_size ?? 15) * 1.08,
          bold: true,
        };
        if (highlightWords.length > 0 || cycleColor !== undefined) {
          // Karaoke ranges are built first; keyword matches override those words.
          const { ranges, matches } = emphasis(fullText, [karaokeRange]);
          setTextRanges(draft, segmentId, ranges);
          cueMatches = matches;
        } else {
          setTextRanges(draft, segmentId, [karaokeRange]);
        }
        cursor = end + 1;
        created++;
      }
      keywordMatches += cueMatches;
    } else {
      const segmentId = addCaptionSegment(draft, track, cue.text, cue.startUs, cue.endUs, cueStyle);
      if (highlightWords.length > 0) {
        const { ranges, matches } = emphasis(cue.text);
        if (ranges.length > 0) setTextRanges(draft, segmentId, ranges);
        keywordMatches += matches;
      }
      created++;
    }
  }

  return {
    ok: true,
    cues: created,
    track_name: trackName,
    first_cue: { start_us: cues[0].startUs, text: cues[0].text },
    last_cue: { start_us: cues[cues.length - 1].startUs, text: cues[cues.length - 1].text },
    source_audio: audio,
    engine: opts.whisperCmd ? "shell" : "whisper-cli",
    engine_name: transcription.engine,
    words: transcription.words.length,
    karaoke: opts.karaoke ?? false,
    // undefined when the flags are off, so JSON output stays byte-identical.
    keyword_matches: highlightWords.length > 0 ? keywordMatches : undefined,
    color_cycle: colorCycle.length > 0 ? colorCycle.length : undefined,
    script: scriptReport,
  };
}

function addCaptionSegment(
  draft: Draft,
  track: Track,
  text: string,
  startUs: number,
  endUs: number,
  baseStyle: Record<string, unknown>,
): string {
  const matId = uuid();
  const content = JSON.stringify({
    text,
    styles: [{ ...baseStyle, range: [0, storedTextLength(text)] }],
  });
  draft.materials.texts.push({
    id: matId,
    type: "text",
    content,
    font_size: baseStyle.font_size ?? 15,
    text_color: baseStyle.font_color ?? "#FFFFFF",
    alignment: 1,
    sub_type: 1,
    caption_template_info: { category_id: "", category_name: "", effect_id: "", is_new: false, resource_id: "" },
  } as unknown as Draft["materials"]["texts"][number]);
  const segmentId = uuid();
  track.segments.push({
    id: segmentId,
    material_id: matId,
    target_timerange: { start: startUs, duration: Math.max(1, endUs - startUs) },
    source_timerange: { start: 0, duration: Math.max(1, endUs - startUs) },
    speed: 1,
    volume: 1,
    visible: true,
    clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: -0.6 } },
    extra_material_refs: [],
    render_index: 0,
  } as unknown as Segment);
  return segmentId;
}

function resolveAudio(draft: Draft, opts: CaptionOptions): string {
  if (opts.audio) {
    if (!existsSync(opts.audio)) throw new Error(`Audio file not found: ${opts.audio}`);
    return opts.audio;
  }
  if (opts.fromSegment) {
    const found = findSegment(draft, opts.fromSegment);
    if (!found) throw new Error(`Segment not found: ${opts.fromSegment}`);
    if (found.track.type !== "audio")
      throw new Error(`--from-segment must be on an audio track (got ${found.track.type})`);
    const mat = draft.materials.audios.find((m) => m.id === found.segment.material_id);
    if (!mat?.path) throw new Error(`Audio segment ${opts.fromSegment} has no resolvable material path`);
    if (!existsSync(mat.path)) throw new Error(`Audio material path doesn't exist on disk: ${mat.path}`);
    return mat.path;
  }
  throw new Error("Missing --audio <path> or --from-segment <id>. Provide one.");
}

interface TranscriptionResult {
  cues: CaptionCue[];
  words: CaptionWord[];
  engine: "openai" | "whisper-cpp" | "faster-whisper";
}

function detectEngine(opts: CaptionOptions): TranscriptionResult["engine"] {
  if (opts.whisperEngine && opts.whisperEngine !== "auto") return opts.whisperEngine;
  const command = (opts.whisperCmd ?? "whisper").toLowerCase();
  if (command.includes("faster-whisper")) return "faster-whisper";
  if (command.includes("whisper-cli") || /(^|[/\\])main(?:\.exe)?$/.test(command)) return "whisper-cpp";
  return "openai";
}

export function buildWhisperInvocation(
  engine: TranscriptionResult["engine"],
  audio: string,
  model: string,
  language: string,
  outputDir: string,
  json: boolean,
): { args: string[]; prefix: string; extension: ".json" | ".srt" } {
  const prefix = join(outputDir, "transcript");
  if (engine === "whisper-cpp") {
    return {
      args: ["-m", model, "-f", audio, "-l", language, json ? "-oj" : "-osrt", "-of", prefix],
      prefix,
      extension: json ? ".json" : ".srt",
    };
  }
  return {
    args: [
      audio,
      "--model",
      model,
      "--language",
      language,
      "--output_format",
      json ? "json" : "srt",
      "--output_dir",
      outputDir,
      ...(json ? ["--word_timestamps", "True"] : []),
    ],
    prefix,
    extension: json ? ".json" : ".srt",
  };
}

function runWhisper(audio: string, opts: CaptionOptions): TranscriptionResult {
  const cmd = opts.whisperCmd ?? "whisper";
  const model = opts.whisperModel ?? "base";
  const language = opts.language ?? "auto";
  const engine = detectEngine(opts);
  const tmpdirPath = mkdtempSync(join(tmpdir(), "capcut-caption-"));
  try {
    const json = opts.karaoke === true;
    const invocation = buildWhisperInvocation(engine, audio, model, language, tmpdirPath, json);
    const { args, prefix, extension } = invocation;
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
      const stderr = r.stderr || r.error?.message || `whisper exited ${r.status}`;
      throw new Error(
        `${engine} CLI failed: ${stderr}\nTried: ${cmd} ${args.join(" ")}\n` +
          "Select the matching dialect with --whisper-engine openai|whisper-cpp|faster-whisper and pass its model via --whisper-model.",
      );
    }

    const outputPath =
      readdirSync(tmpdirPath)
        .filter((name) => name.endsWith(extension))
        .map((name) => join(tmpdirPath, name))[0] ?? `${prefix}${extension}`;
    if (!existsSync(outputPath)) {
      throw new Error(`${engine} finished but no ${extension} output was found. stdout: ${r.stdout?.slice(0, 200)}`);
    }
    if (json) {
      const parsed = parseWhisperJson(readFileSync(outputPath, "utf-8"));
      return { ...parsed, engine };
    }
    const cues = parseSrt(readFileSync(outputPath, "utf-8")).map((cue) => ({
      startUs: cue.startUs,
      endUs: cue.endUs,
      text: cue.text,
    }));
    return { cues, words: [], engine };
  } finally {
    try {
      rmSync(tmpdirPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export function parseWhisperJson(raw: string): { cues: CaptionCue[]; words: CaptionWord[] } {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const cues: CaptionCue[] = [];
  const words: CaptionWord[] = [];
  const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
  for (const value of segments) {
    const segment = value as Record<string, unknown>;
    const startUs = Math.round(Number(segment.start ?? 0) * 1_000_000);
    const endUs = Math.round(Number(segment.end ?? segment.start ?? 0) * 1_000_000);
    const text = String(segment.text ?? "").trim();
    const segmentWords: CaptionWord[] = [];
    if (Array.isArray(segment.words)) {
      for (const item of segment.words) {
        const word = item as Record<string, unknown>;
        const textValue = String(word.word ?? word.text ?? "").trim();
        if (!textValue) continue;
        const parsedWord = {
          word: textValue,
          startUs: Math.round(Number(word.start ?? segment.start ?? 0) * 1_000_000),
          endUs: Math.round(Number(word.end ?? segment.end ?? 0) * 1_000_000),
        };
        segmentWords.push(parsedWord);
        words.push(parsedWord);
      }
    }
    if (text) cues.push({ startUs, endUs, text, words: segmentWords.length ? segmentWords : undefined });
  }

  const transcription = Array.isArray(parsed.transcription) ? parsed.transcription : [];
  for (const value of transcription) {
    const item = value as Record<string, unknown>;
    const offsets = (item.offsets ?? {}) as Record<string, unknown>;
    const startUs = Math.round(Number(offsets.from ?? 0) * 1000);
    const endUs = Math.round(Number(offsets.to ?? offsets.from ?? 0) * 1000);
    const text = String(item.text ?? "").trim();
    if (text) cues.push({ startUs, endUs, text });
  }

  if (cues.length === 0 && typeof parsed.text === "string") {
    cues.push({ startUs: 0, endUs: 1_000_000, text: parsed.text.trim() });
  }
  return { cues, words: words.length > 0 ? words : wordsFromCues(cues) };
}

export function wordsFromCues(cues: CaptionCue[]): CaptionWord[] {
  const words: CaptionWord[] = [];
  for (const cue of cues) {
    const parts = cue.text.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const duration = Math.max(parts.length, cue.endUs - cue.startUs);
    for (let index = 0; index < parts.length; index++) {
      words.push({
        word: parts[index],
        startUs: cue.startUs + Math.round((duration * index) / parts.length),
        endUs: cue.startUs + Math.round((duration * (index + 1)) / parts.length),
      });
    }
  }
  return words;
}

export function groupWords(words: CaptionWord[], maxWords = 4, maxChars = 28, maxGapUs = 500_000): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let group: CaptionWord[] = [];
  const flush = () => {
    if (group.length === 0) return;
    cues.push({
      startUs: group[0].startUs,
      endUs: group[group.length - 1].endUs,
      text: group.map((word) => word.word).join(" "),
      words: group,
    });
    group = [];
  };
  for (const word of words) {
    const candidate = [...group, word];
    const gap = group.length === 0 ? 0 : word.startUs - group[group.length - 1].endUs;
    if (
      group.length > 0 &&
      (candidate.length > maxWords || candidate.map((item) => item.word).join(" ").length > maxChars || gap > maxGapUs)
    ) {
      flush();
    }
    group.push(word);
  }
  flush();
  return cues;
}

function extractTextStyle(draft: Draft, materialId: string): Record<string, unknown> {
  const mat = draft.materials.texts.find((m) => m.id === materialId);
  if (!mat) return defaultCaptionStyle();
  try {
    const parsed = JSON.parse(mat.content) as { styles?: Array<Record<string, unknown>> };
    if (Array.isArray(parsed.styles) && parsed.styles.length > 0) {
      const s = parsed.styles[0];
      return { ...s, range: undefined };
    }
  } catch {
    /* ignore */
  }
  return defaultCaptionStyle();
}

function defaultCaptionStyle(): Record<string, unknown> {
  return {
    font_color: "#FFFFFF",
    font_size: 15,
    bold: false,
    italic: false,
    underline: false,
  };
}
