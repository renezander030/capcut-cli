import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

/** The fixture's audio segment pointed at a local file that is not decodable
 * audio, so the length comes from the draft's material, not ffprobe. */
function fixture(t) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
  const audio = join(fix.dir, "voice.mp3");
  writeFileSync(audio, "x".repeat(4096));
  draft.materials.audios[0].path = audio;
  writeFileSync(fix.path, JSON.stringify(draft));
  const durationMs = draft.materials.audios[0].duration / 1000;
  return { ...fix, audio, durationMs, segment: draft.tracks.find((tr) => tr.type === "audio").segments[0].id };
}

describe("caption --cloud --dry-run sends nothing", () => {
  it("reports the upload it would make and writes nothing", (t) => {
    const f = fixture(t);
    const before = readFileSync(f.path, "utf-8");
    const r = spawnCli(["caption", f.path, "--from-segment", f.segment, "--cloud", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.uploaded, false);
    assert.equal(r.json.engine, "capcut-cloud");
    assert.deepEqual(r.json.would_upload, {
      path: f.audio,
      bytes: 4096,
      duration_ms: f.durationMs,
      to: "CapCut Cloud ASR (ByteDance servers)",
    });
    assert.doesNotMatch(r.stderr, /uploading/);
    assert.equal(readFileSync(f.path, "utf-8"), before, "a dry run never writes the draft");
  });

  it("refuses what a real run would refuse", (t) => {
    const f = fixture(t);
    const r = spawnCli([
      "caption",
      f.path,
      "--from-segment",
      f.segment,
      "--cloud",
      "--whisper-model",
      "base",
      "--dry-run",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--cloud uses CapCut Cloud ASR and is mutually exclusive with --whisper-model/);
    assert.doesNotMatch(r.stdout, /would_upload/);
  });

  it("says --language does nothing with --cloud", (t) => {
    const f = fixture(t);
    const r = spawnCli(["caption", f.path, "--from-segment", f.segment, "--cloud", "--language", "zh", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /--language zh has no effect with --cloud/);
  });

  it("still refuses a missing file before planning anything", (t) => {
    const f = fixture(t);
    const r = spawnCli(["caption", f.path, "--audio", join(f.dir, "absent.mp3"), "--cloud", "--dry-run"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Audio file not found/);
  });
});
