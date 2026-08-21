import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";
import { buildTtsArgv, collisionSafeOutPath, splitCommandTemplate } from "../dist/tts.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const isWindows = process.platform === "win32"; // fake-TTS tests use /bin/sh scripts

/** Minimal valid PCM WAV (8 kHz mono 16-bit) the fake TTS scripts copy to {out}. */
function writeTinyWav(path, seconds = 1) {
  const sampleRate = 8000;
  const dataSize = sampleRate * seconds * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + dataSize, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(dataSize, 40);
  writeFileSync(path, b);
}

/** Fake-tool sandbox: a scratch dir with a source wav, a fake ffprobe, and script helpers. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-tts-test-"));
  const srcWav = join(dir, "src.wav");
  writeTinyWav(srcWav);
  // Duration comes from ffprobe in the real flow; the fake reports 1.5s.
  const fakeFfprobe = join(dir, "fake-ffprobe");
  const probeJson = JSON.stringify({
    streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 1 }],
    format: { duration: "1.5" },
  });
  writeFileSync(fakeFfprobe, `#!/bin/sh\necho '${probeJson}'\n`);
  chmodSync(fakeFfprobe, 0o755);
  const script = (name, body) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}`);
    chmodSync(path, 0o755);
    return path;
  };
  return {
    dir,
    srcWav,
    fakeFfprobe,
    script,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("tts — template tokenizing and argv building (pure)", () => {
  it("splits on whitespace and groups quoted spans into one token", () => {
    assert.deepEqual(splitCommandTemplate("piper --model en_US-amy --output_file {out}"), [
      "piper",
      "--model",
      "en_US-amy",
      "--output_file",
      "{out}",
    ]);
    assert.deepEqual(splitCommandTemplate(`my-tts --voice "warm narrator" '{out}'`), [
      "my-tts",
      "--voice",
      "warm narrator",
      "{out}",
    ]);
  });

  it("rejects an unbalanced quote", () => {
    assert.throws(() => splitCommandTemplate('say -o "{out}'), /Unbalanced/);
  });

  it("keeps a substituted {text} with spaces and quotes as a single argv token", () => {
    const text = `He said "don't panic" — twice`;
    const { argv, delivery } = buildTtsArgv("espeak-ng -w {out} {text}", text, "/tmp/vo.wav");
    assert.equal(delivery, "argv");
    assert.deepEqual(argv, ["espeak-ng", "-w", "/tmp/vo.wav", text]);
  });

  it("selects stdin delivery when the template has no {text}", () => {
    const { argv, delivery } = buildTtsArgv("piper --output_file {out}", "hello", "/tmp/vo.wav");
    assert.equal(delivery, "stdin");
    assert.deepEqual(argv, ["piper", "--output_file", "/tmp/vo.wav"]);
  });

  it("refuses a template without {out}", () => {
    assert.throws(() => buildTtsArgv("espeak-ng {text}", "hello", "/tmp/vo.wav"), /\{out\} placeholder/);
  });

  it("numbers collision-safe output names instead of overwriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-tts-name-"));
    try {
      const first = collisionSafeOutPath(dir);
      assert.equal(basename(first), "voiceover.wav");
      writeFileSync(first, "x");
      const second = collisionSafeOutPath(dir);
      assert.equal(basename(second), "voiceover-2.wav");
      writeFileSync(second, "x");
      assert.equal(basename(collisionSafeOutPath(dir)), "voiceover-3.wav");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("capcut tts — input validation", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("errors when neither --text nor --text-file is provided", () => {
    const r = spawnCli(["tts", fix.path, "--tts-cmd", "piper {out}"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Missing --text/);
  });

  it("refuses --text together with --text-file", () => {
    const r = spawnCli(["tts", fix.path, "--text", "hi", "--text-file", "x.txt", "--tts-cmd", "piper {out}"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /mutually exclusive/);
  });

  it("errors when the --text-file does not exist", () => {
    const r = spawnCli(["tts", fix.path, "--text-file", "/nonexistent/script.txt", "--tts-cmd", "piper {out}"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Text file not found/);
  });

  it("refuses whitespace-only text", () => {
    const r = spawnCli(["tts", fix.path, "--text", "   ", "--tts-cmd", "piper {out}"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /text is empty/);
  });

  it("errors without --tts-cmd, naming known-working engines and the {out} contract", () => {
    const r = spawnCli(["tts", fix.path, "--text", "hello"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Missing --tts-cmd/);
    assert.match(r.stderr, /piper/);
    assert.match(r.stderr, /espeak-ng/);
    assert.match(r.stderr, /\{out\}/);
  });

  it("errors when the TTS binary does not exist", () => {
    const r = spawnCli(["tts", fix.path, "--text", "hello", "--tts-cmd", "no-such-tts-binary-xyz {out}"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /TTS command not found/);
  });
});

describe("capcut tts — fake-TTS shell-out (no real TTS in CI)", () => {
  it("delivers stdin text, probes duration, and lands the audio segment", { skip: isWindows }, () => {
    const s = setup();
    const fix = tmpDraft();
    after(() => {
      s.cleanup();
      fix.cleanup();
    });
    const capture = join(s.dir, "stdin-capture");
    const fakeTts = s.script("fake-tts", `cat > "${capture}"\ncp "${s.srcWav}" "$1"\n`);
    const r = spawnCli([
      "tts",
      fix.path,
      "1s",
      "--text",
      "hello from the loop",
      "--tts-cmd",
      `${fakeTts} {out}`,
      "--track-name",
      "vo",
      "--volume",
      "0.8",
      "--ffprobe-cmd",
      s.fakeFfprobe,
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.ok, true);
    assert.equal(readFileSync(capture, "utf-8"), "hello from the loop");
    assert.equal(r.json.text_delivery, "stdin");
    assert.equal(r.json.start_us, 1_000_000);
    assert.equal(r.json.duration_us, 1_500_000);
    assert.equal(r.json.duration_source, "ffprobe");
    assert.equal(basename(r.json.path), "voiceover.wav");
    assert.ok(existsSync(r.json.path), "synthesized wav must land in the draft's assets/audio dir");

    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    const track = draft.tracks.find((t) => t.type === "audio" && t.name === "vo");
    assert.ok(track, "should create the requested audio track");
    const seg = track.segments.find((sg) => sg.id === r.json.segment_id);
    assert.deepEqual(seg.target_timerange, { start: 1_000_000, duration: 1_500_000 });
    assert.equal(seg.volume, 0.8);
    const mat = draft.materials.audios.find((m) => m.id === r.json.material_id);
    assert.equal(mat.path, r.json.path);
    assert.equal(mat.duration, 1_500_000);
  });

  it("passes {text} with spaces and quotes as one argument", { skip: isWindows }, () => {
    const s = setup();
    const fix = tmpDraft();
    after(() => {
      s.cleanup();
      fix.cleanup();
    });
    const capture = join(s.dir, "argv-capture");
    const fakeTts = s.script("fake-tts", `printf '%s' "$1" > "${capture}"\ncp "${s.srcWav}" "$2"\n`);
    const text = `He said "don't panic" -- twice`;
    const r = spawnCli([
      "tts",
      fix.path,
      "--text",
      text,
      "--tts-cmd",
      `${fakeTts} {text} {out}`,
      "--ffprobe-cmd",
      s.fakeFfprobe,
    ]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.text_delivery, "argv");
    assert.equal(readFileSync(capture, "utf-8"), text);
  });

  it("numbers the second voiceover instead of overwriting the first", { skip: isWindows }, () => {
    const s = setup();
    const fix = tmpDraft();
    after(() => {
      s.cleanup();
      fix.cleanup();
    });
    const fakeTts = s.script("fake-tts", `cat > /dev/null\ncp "${s.srcWav}" "$1"\n`);
    const args = (text) => [
      "tts",
      fix.path,
      "--text",
      text,
      "--tts-cmd",
      `${fakeTts} {out}`,
      "--ffprobe-cmd",
      s.fakeFfprobe,
    ];
    const first = spawnCli(args("take one"));
    assert.equal(first.status, 0, `stderr: ${first.stderr}`);
    const second = spawnCli(args("take two"));
    assert.equal(second.status, 0, `stderr: ${second.stderr}`);
    assert.equal(basename(first.json.path), "voiceover.wav");
    assert.equal(basename(second.json.path), "voiceover-2.wav");
    assert.ok(existsSync(first.json.path) && existsSync(second.json.path));
  });

  it("takes an explicit duration with --no-probe", { skip: isWindows }, () => {
    const s = setup();
    const fix = tmpDraft();
    after(() => {
      s.cleanup();
      fix.cleanup();
    });
    const fakeTts = s.script("fake-tts", `cat > /dev/null\ncp "${s.srcWav}" "$1"\n`);
    const r = spawnCli(["tts", fix.path, "0s", "2s", "--text", "hi", "--tts-cmd", `${fakeTts} {out}`, "--no-probe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.duration_us, 2_000_000);
    assert.equal(r.json.duration_source, "argument");
    assert.equal(r.json.media_probe, null);
  });

  it("surfaces the tool's stderr tail on a non-zero exit and leaves no dead file", { skip: isWindows }, () => {
    const s = setup();
    const fix = tmpDraft();
    after(() => {
      s.cleanup();
      fix.cleanup();
    });
    const fakeTts = s.script("fake-tts", `echo "model file not found: en_US-amy" >&2\nexit 3\n`);
    const r = spawnCli(["tts", fix.path, "--text", "hi", "--tts-cmd", `${fakeTts} {out}`]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /TTS command failed/);
    assert.match(r.stderr, /model file not found: en_US-amy/);
    assert.ok(!existsSync(join(fix.dir, "assets", "audio", "voiceover.wav")), "failed run must not leave output");
  });

  it("errors when the command exits 0 but writes no or empty output", { skip: isWindows }, () => {
    const s = setup();
    const fix = tmpDraft();
    after(() => {
      s.cleanup();
      fix.cleanup();
    });
    const silent = s.script("fake-tts-none", "cat > /dev/null\nexit 0\n");
    const none = spawnCli(["tts", fix.path, "--text", "hi", "--tts-cmd", `${silent} {out}`]);
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /wrote no audio/);

    const truncating = s.script("fake-tts-empty", `cat > /dev/null\n: > "$1"\nexit 0\n`);
    const empty = spawnCli(["tts", fix.path, "--text", "hi", "--tts-cmd", `${truncating} {out}`]);
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /wrote no audio/);
    assert.ok(!existsSync(join(fix.dir, "assets", "audio", "voiceover.wav")), "empty output must be cleaned up");
  });
});
