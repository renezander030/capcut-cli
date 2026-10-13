import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { detectScenes } from "../dist/scenes.js";
import { detectSilence } from "../dist/silence.js";

// detect-scenes and detect-silence run the same kind of ffmpeg analysis pass;
// each failure mode keeps its own command label and actionable hint.
const isWindows = process.platform === "win32";

const DETECTORS = [
  {
    run: detectScenes,
    label: "detect-scenes",
    what: "scene detection",
    timeoutHint: "Try a shorter or lower-resolution input.",
    bufferHint: "Raise --threshold to emit fewer cut candidates.",
  },
  {
    run: detectSilence,
    label: "detect-silence",
    what: "silence detection",
    timeoutHint: "Try a shorter input.",
    bufferHint: "Raise --min-silence to report fewer silence spans.",
  },
];

describe("detect-scenes / detect-silence: ffmpeg failure messages", { skip: isWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), "capcut-ffmpeg-pass-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const media = join(dir, "clip.mp4");
  writeFileSync(media, "");
  function fake(name, body) {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }
  const slow = fake("slow-ffmpeg", "sleep 3");
  const noisy = fake("noisy-ffmpeg", "head -c 200000 /dev/zero");
  const failing = fake("failing-ffmpeg", "echo boom >&2; exit 3");

  for (const d of DETECTORS) {
    it(`${d.label}: unavailable, timeout, buffer and exit failures`, () => {
      assert.throws(() => d.run(media, { ffmpegCmd: "/nonexistent/ffmpeg" }), {
        message: `${d.label}: ffmpeg is unavailable at '/nonexistent/ffmpeg'. Install ffmpeg or pass --ffmpeg-cmd <path>. (ENOENT)`,
      });
      assert.throws(() => d.run(media, { ffmpegCmd: slow, timeoutMs: 250 }), {
        message: `${d.label}: ${d.what} timed out after 0.25s on ${media}. ${d.timeoutHint}`,
      });
      assert.throws(() => d.run(media, { ffmpegCmd: noisy, maxBufferBytes: 1024 }), {
        message: `${d.label}: ffmpeg output exceeded the 1024-byte buffer on ${media}. ${d.bufferHint}`,
      });
      assert.throws(() => d.run(media, { ffmpegCmd: failing }), {
        message: `${d.label}: ffmpeg failed on ${media}.\nboom\n`,
      });
    });
  }
});
