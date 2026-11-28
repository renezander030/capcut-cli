import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function fixture(t, mode = "normal") {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const source = join(fix.dir, "cues.srt");
  writeFileSync(source, "1\n00:00:01,000 --> 00:00:02,000\nQuiet\n\n2\n00:00:03,000 --> 00:00:04,000\nLoud\n");
  const tts = join(fix.dir, "tts");
  const probe = join(fix.dir, "probe");
  const meter = join(fix.dir, "meter");
  const log = join(fix.dir, "tts.log");
  const meterLog = join(fix.dir, "meter.log");
  writeFileSync(
    tts,
    `#!/usr/bin/env node\nconst fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(log)}, "called\\n"); fs.writeFileSync(process.argv[2], Buffer.alloc(8044));\n`,
  );
  writeFileSync(
    probe,
    '#!/usr/bin/env node\nconsole.log(JSON.stringify({streams:[{codec_type:"audio", codec_name:"pcm_s16le",channels:1}],format:{duration:"0.5"}}));\n',
  );
  writeFileSync(
    meter,
    `#!/usr/bin/env node
const fs = require("node:fs"); const args=process.argv.slice(2); fs.appendFileSync(${JSON.stringify(meterLog)}, JSON.stringify(args)+"\\n");
const second = args.some(a=>a.includes("dub-002"));
if (${JSON.stringify(mode)} === "failure" && second) process.exit(7);
const peak = ${JSON.stringify(mode)} === "silent" && second ? "-inf" : second ? "-10.0" : "-20.0";
console.error("True peak:\\n  Peak: " + peak + " dBFS");
`,
  );
  for (const file of [tts, probe, meter]) chmodSync(file, 0o755);
  const args = ["dub", fix.path, source, "--tts-cmd", `${tts} {out}`, "--ffprobe-cmd", probe, "--ffmpeg-cmd", meter];
  return { ...fix, args, log, meterLog, original: readFileSync(fix.path), audio: join(fix.dir, "assets", "audio") };
}
const segments = (fix) =>
  JSON.parse(readFileSync(fix.path)).tracks.flatMap((t) => (t.type === "audio" && t.name === "dub" ? t.segments : []));
const assets = (fix) => (existsSync(fix.audio) ? readdirSync(fix.audio).filter((n) => n.endsWith(".wav")) : []);

describe("dub peak normalization", { skip: process.platform === "win32" }, () => {
  it("sets different clip gains to the same measured target before saving", (t) => {
    const fix = fixture(t);
    const result = spawnCli([...fix.args, "--normalize-peak", "-3"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.clips.length, 2);
    const clips = segments(fix);
    assert.ok(Math.abs(clips[0].volume - 10 ** (17 / 20)) < 1e-9);
    assert.ok(Math.abs(clips[1].volume - 10 ** (7 / 20)) < 1e-9);
    assert.deepEqual(
      result.json.clips.map((c) => c.normalization.estimated_peak_dbfs),
      [-3, -3],
    );
    const meters = readFileSync(fix.meterLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(meters.length, 2);
    for (const args of meters) assert.equal(args[args.indexOf("-t") + 1], "0.500000");
  });
  it("meters only the prefix retained by overlap trimming", (t) => {
    const fix = fixture(t);
    writeFileSync(fix.args[2], "1\n00:00:01,000 --> 00:00:01,250\nQuiet\n\n2\n00:00:01,250 --> 00:00:02,000\nLoud\n");
    const result = spawnCli([...fix.args, "--normalize-peak", "-3", "--trim-overlap"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.clips[0].duration_us, 250000);
    const calls = readFileSync(fix.meterLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls[0][calls[0].indexOf("-t") + 1], "0.250000");
    assert.equal(calls[1][calls[1].indexOf("-t") + 1], "0.500000");
  });
  it("retains default volume and never meters without the option", (t) => {
    const fix = fixture(t);
    const result = spawnCli(fix.args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      segments(fix).map((s) => s.volume),
      [1, 1],
    );
    assert.equal(existsSync(fix.meterLog), false);
    assert.ok(result.json.clips.every((c) => c.normalization === undefined));
  });
  it("reports the actual capped gain when the boost limit prevents the target", (t) => {
    const fix = fixture(t);
    const result = spawnCli([...fix.args, "--normalize-peak", "-3", "--max-gain-db", "5"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      result.json.clips.map((c) => [
        c.normalization.gain_db,
        c.normalization.estimated_peak_dbfs,
        c.normalization.clamped,
      ]),
      [
        [5, -15, true],
        [5, -5, true],
      ],
    );
  });
  for (const mode of ["failure", "silent"]) {
    it(`cleans every synthesized file and leaves the draft intact on a ${mode} meter`, (t) => {
      const fix = fixture(t, mode);
      const result = spawnCli([...fix.args, "--normalize-peak", "-3"]);
      assert.notEqual(result.status, 0);
      assert.deepEqual(readFileSync(fix.path), fix.original);
      assert.deepEqual(assets(fix), []);
      assert.match(result.stderr, mode === "failure" ? /Peak measurement failed/ : /No finite true-peak/);
    });
  }
  for (const flags of [
    ["--normalize-peak", "1"],
    ["--normalize-peak", "-61"],
    ["--normalize-peak", "-3", "--max-gain-db", "-1"],
    ["--normalize-peak", "-3", "--volume", "2"],
  ]) {
    it(`refuses invalid settings before TTS: ${flags.join(" ")}`, (t) => {
      const fix = fixture(t);
      const result = spawnCli([...fix.args, ...flags]);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(fix.log), false);
      assert.deepEqual(readFileSync(fix.path), fix.original);
      assert.deepEqual(assets(fix), []);
    });
  }
  it("dry-run describes the cues without TTS, meters, assets or draft writes", (t) => {
    const fix = fixture(t);
    const result = spawnCli([...fix.args, "--normalize-peak", "-3", "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.executed, false);
    assert.equal(result.json.normalization.measured, false);
    assert.equal(result.json.planned_cues.length, 2);
    assert.equal(existsSync(fix.log), false);
    assert.equal(existsSync(fix.meterLog), false);
    assert.deepEqual(assets(fix), []);
    assert.deepEqual(readFileSync(fix.path), fix.original);
  });
});
