#!/usr/bin/env node
// A stand-in for the whisper CLI (openai dialect): ignores the audio, writes
// the transcript named by FAKE_WHISPER_SOURCE into --output_dir under the
// requested --output_format (json → transcript.json, srt → transcript.srt).
// Lets caption's pipeline run end-to-end in tests without a model or audio.
import { copyFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};
const outDir = value("--output_dir");
const format = value("--output_format") ?? "srt";
const source = process.env.FAKE_WHISPER_SOURCE;
// `node --test` runs every file under test/, this helper included: with no
// whisper-style arguments there is nothing to fake, so exit clean.
if (args.length === 0 && !source) process.exit(0);
if (!outDir || !source) {
  process.stderr.write("fake-whisper: need --output_dir and FAKE_WHISPER_SOURCE\n");
  process.exit(2);
}
copyFileSync(source, join(outDir, `transcript.${format}`));
