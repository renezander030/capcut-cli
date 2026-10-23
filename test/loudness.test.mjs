import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseEbur128 } from "../dist/loudness.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const isWindows = process.platform === "win32"; // the stand-in ffmpeg is a /bin/sh script
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;

// What ffmpeg's ebur128 filter prints at the end of a run (frame lines above it
// carry their own running "I:" values; the summary is the last one).
const summary = (lufs, peak) =>
  `[Parsed_ebur128_0 @ 0x1] t: 1.0  TARGET:-23 LUFS    M: -40.0 S: -40.0     I: -50.0 LUFS       LRA:   0.0 LU  FTPK: -9.0 dBFS  TPK: -9.0 dBFS\n` +
  `[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         ${lufs} LUFS\n    Threshold: -40.0 LUFS\n\n` +
  `  Loudness range:\n    LRA:         0.0 LU\n\n  True peak:\n    Peak:       ${peak} dBFS\n`;

/** The fixture's three audible clips, pointed at local files a stand-in ffmpeg reports fixed loudness for. */
function fixture(t) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
  const files = { "mat-video-01": "intro.mp4", "mat-video-02": "main.mp4", "mat-audio-01": "music.mp3" };
  for (const m of [...draft.materials.videos, ...draft.materials.audios]) {
    if (files[m.id]) {
      m.path = join(fix.dir, files[m.id]);
      writeFileSync(m.path, "media");
    }
  }
  writeFileSync(fix.path, JSON.stringify(draft));
  const ffmpeg = join(fix.dir, "fake-ffmpeg");
  writeFileSync(
    ffmpeg,
    `#!/bin/sh
while [ $# -gt 0 ]; do if [ "$1" = "-i" ]; then input="$2"; fi; echo "$1" >> "${join(fix.dir, "args.log")}"; shift; done
case "$input" in
  *intro.mp4) cat >&2 <<'EOF'
${summary("-30.0", "-12.0")}
EOF
;;
  *main.mp4) cat >&2 <<'EOF'
${summary("-20.0", "-3.0")}
EOF
;;
  *music.mp3) cat >&2 <<'EOF'
${summary("-26.0", "-8.0")}
EOF
;;
esac
exit 0
`,
  );
  chmodSync(ffmpeg, 0o755);
  return { ...fix, ffmpeg };
}

const db = (volume) => 20 * Math.log10(volume);
// intro -30 at volume 1; main -20 at 0.8; music -26 at 0.5; 5 s, 5 s and 10 s on the timeline.
const effective = [-30, -20 + db(0.8), -26 + db(0.5)];
const program =
  10 *
  Math.log10((5 * 10 ** (effective[0] / 10) + 5 * 10 ** (effective[1] / 10) + 10 * 10 ** (effective[2] / 10)) / 20);

describe("loudness — EBU R128 per clip and the gain to a delivery target", () => {
  it("reads the summary, not the running frame values", () => {
    assert.deepEqual(parseEbur128(summary("-17.3", "-1.5")), { lufs: -17.3, peak: -1.5 });
    assert.deepEqual(parseEbur128(summary("-inf", "-inf")), { lufs: null, peak: null });
    assert.deepEqual(parseEbur128("no meter output"), { lufs: null, peak: null });
  });

  it("measures every audible clip over the source range the timeline plays", { skip: isWindows }, (t) => {
    const f = fixture(t);
    const r = spawnCli(["loudness", f.path, "--ffmpeg-cmd", f.ffmpeg]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.mode, "uniform");
    assert.equal(r.json.target, undefined);
    assert.deepEqual(
      r.json.clips.map((c) => [c.segment_id.slice(0, 8), c.measured_lufs, c.true_peak_dbfs, c.effective_lufs]),
      [
        ["aaaaaa01", -30, -12, -30],
        ["aaaaaa02", -20, -3, Number(effective[1].toFixed(2))],
        ["bbbbbb01", -26, -8, Number(effective[2].toFixed(2))],
      ],
    );
    assert.equal(r.json.program_lufs, Number(program.toFixed(2)));
    // The 1.5x clip plays 7.5 s of its media.
    const args = readFileSync(join(f.dir, "args.log"), "utf-8").split("\n");
    assert.ok(args.includes("7.500000"), "the source duration of the sped-up clip is measured");
    assert.ok(args.includes("ebur128=peak=true"));
    assert.equal(r.json.applied, false);
  });

  it("one gain for the whole mix keeps the balance; --apply writes it as segment volume", { skip: isWindows }, (t) => {
    const f = fixture(t);
    const planned = spawnCli(["loudness", f.path, "--ffmpeg-cmd", f.ffmpeg, "--target", "-14"]);
    assert.equal(planned.status, 0, planned.stderr);
    const gain = -14 - Number(program.toFixed(2));
    for (const clip of planned.json.clips) assert.equal(clip.gain_db, Number(gain.toFixed(2)));
    assert.equal(JSON.parse(readFileSync(f.path, "utf-8")).tracks[0].segments[0].volume, 1, "a plan writes nothing");

    const applied = spawnCli(["loudness", f.path, "--ffmpeg-cmd", f.ffmpeg, "--target", "-14", "--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.json.applied, true);
    assert.equal(applied.json.changed, 3);
    const draft = JSON.parse(readFileSync(f.path, "utf-8"));
    const volumes = draft.tracks.filter((tr) => tr.type !== "text").flatMap((tr) => tr.segments.map((s) => s.volume));
    const factor = 10 ** (Number(gain.toFixed(2)) / 20);
    assert.deepEqual(
      volumes,
      [1, 0.8, 0.5].map((v) => Number((v * factor).toFixed(4))),
    );
    const list = spawnCli(["restore", f.path, "--list"]);
    assert.equal(list.json.snapshots[0].command, "loudness", "the write is journaled and undoable");
  });

  it("--per-clip brings each clip to the target, capped by --max-gain-db", { skip: isWindows }, (t) => {
    const f = fixture(t);
    const r = spawnCli([
      "loudness",
      f.path,
      "--ffmpeg-cmd",
      f.ffmpeg,
      "--target",
      "-14",
      "--per-clip",
      "--max-gain-db",
      "10",
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.mode, "per-clip");
    const [intro, main, music] = r.json.clips;
    assert.deepEqual([intro.gain_db, intro.clamped], [10, true]);
    assert.deepEqual(
      [main.gain_db, main.clamped],
      [Number((-14 - Number(effective[1].toFixed(2))).toFixed(2)), undefined],
    );
    assert.deepEqual([music.gain_db, music.clamped], [10, true]);
  });

  it("skips muted, missing and separated-sound clips and says why", { skip: isWindows }, (t) => {
    const f = fixture(t);
    const draft = JSON.parse(readFileSync(f.path, "utf-8"));
    draft.tracks[0].segments[1].volume = 0;
    draft.materials.audios[0].path = join(f.dir, "gone.mp3");
    draft.materials.videos[0].has_sound_separated = true;
    writeFileSync(f.path, JSON.stringify(draft));
    const r = spawnCli(["loudness", f.path, "--ffmpeg-cmd", f.ffmpeg]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      r.json.clips.map((c) => c.skipped),
      ["sound separated to an audio track", "muted", "media not found"],
    );
    assert.equal(r.json.program_lufs, null);
    const refused = spawnCli(["loudness", f.path, "--ffmpeg-cmd", f.ffmpeg, "--target", "-14"]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /No clip could be measured/);
  });

  it("refuses --apply without a target, a target outside -70..0, and a missing ffmpeg", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    assert.match(spawnCli(["loudness", fix.path, "--apply"]).stderr, /--apply needs --target/);
    assert.match(spawnCli(["loudness", fix.path, "--target", "3"]).stderr, /--target must be a loudness in LUFS/);
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    draft.materials.audios[0].path = fix.path; // any existing file, so ffmpeg is actually needed
    writeFileSync(fix.path, JSON.stringify(draft));
    const r = spawnCli(["loudness", fix.path, "--ffmpeg-cmd", "/nonexistent/ffmpeg"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /loudness needs ffmpeg/);
  });

  it("measures a real tone with the real meter", { skip: !hasFfmpeg }, (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const tone = join(fix.dir, "tone.wav");
    const made = spawnSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:duration=12",
        "-af",
        "volume=-20dB",
        tone,
      ],
      { encoding: "utf-8" },
    );
    assert.equal(made.status, 0, made.stderr);
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    draft.tracks = draft.tracks.filter((tr) => tr.type === "audio");
    draft.materials.audios[0].path = tone;
    writeFileSync(fix.path, JSON.stringify(draft));
    const r = spawnCli(["loudness", fix.path, "--target", "-14"]);
    assert.equal(r.status, 0, r.stderr);
    const [clip] = r.json.clips;
    // lavfi's sine is 1/8 of full scale (-18 dBFS); a full-scale 1 kHz sine
    // reads about -3 LUFS, so this one sits near -3 - 18 - 20 = -41.
    assert.ok(Math.abs(clip.measured_lufs - -41) < 1.5, `measured ${clip.measured_lufs}`);
    assert.ok(clip.gain_db > 0);
  });
});
