import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// `render --soft-captions`: the text-track cues become an SRT beside the
// output and a mov_text subtitle stream in the mp4. Asserted on the pure plan
// (--dry-run) — no ffmpeg needed.

function withVideoOnDisk(fix) {
  // The fixture's video material must exist for the plan to have a main-track input.
  const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
  for (const mat of draft.materials.videos) {
    const p = join(fix.dir, `${mat.id}.mp4`);
    writeFileSync(p, "stub");
    mat.path = p;
  }
  writeFileSync(fix.path, JSON.stringify(draft));
  return draft;
}

describe("render --soft-captions (dry-run plan)", () => {
  it("adds the SRT input, maps it as a mov_text stream and drops -shortest", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    withVideoOnDisk(fix);
    const out = join(fix.dir, "preview.mp4");
    const r = spawnCli(["render", fix.path, "--dry-run", "--soft-captions", "--out", out]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const plan = r.json;
    assert.ok(plan.softCaptions, "plan carries the soft captions block");
    assert.equal(plan.softCaptions.path, join(fix.dir, "preview.srt"));
    assert.ok(plan.softCaptions.cues > 0);
    assert.match(plan.softCaptions.srt, /^1\r?\n\d\d:\d\d:\d\d,\d{3} --> /);
    const subInput = plan.inputs.find((i) => i.kind === "subtitle");
    assert.ok(subInput);
    assert.equal(subInput.index, plan.softCaptions.inputIndex);
    const { args } = plan;
    assert.ok(args.includes(plan.softCaptions.path), "the SRT is an ffmpeg input");
    assert.equal(args[args.indexOf(plan.softCaptions.path) - 1], "-i");
    const mapIdx = args.indexOf(`${plan.softCaptions.inputIndex}:0`);
    assert.ok(mapIdx > 0 && args[mapIdx - 1] === "-map", "the SRT stream is mapped");
    assert.equal(args[args.indexOf("-c:s") + 1], "mov_text");
    assert.equal(args[args.indexOf("-metadata:s:s:0") + 1], "language=und");
    assert.ok(!args.includes("-shortest"), "-shortest would end the file at the last cue");
    assert.equal(args[args.length - 1], out);
    assert.ok(!existsSync(plan.softCaptions.path), "dry-run writes nothing");
  });

  it("without the flag the plan is unchanged: -shortest, no subtitle input, no softCaptions key", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    withVideoOnDisk(fix);
    const r = spawnCli(["render", fix.path, "--dry-run", "--out", join(fix.dir, "preview.mp4")]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.softCaptions, undefined);
    assert.ok(r.json.args.includes("-shortest"));
    assert.ok(!r.json.args.includes("mov_text"));
    assert.ok(!r.json.inputs.some((i) => i.kind === "subtitle"));
  });

  it("combines with --burn-captions and notes a draft without text", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const draft = withVideoOnDisk(fix);
    const both = spawnCli([
      "render",
      fix.path,
      "--dry-run",
      "--soft-captions",
      "--burn-captions",
      "--out",
      join(fix.dir, "p.mp4"),
    ]);
    assert.equal(both.status, 0, `stderr: ${both.stderr}`);
    assert.ok(both.json.textOverlays > 0);
    assert.ok(both.json.softCaptions.cues > 0);

    draft.tracks = draft.tracks.filter((t) => t.type !== "text");
    writeFileSync(fix.path, JSON.stringify(draft));
    const none = spawnCli(["render", fix.path, "--dry-run", "--soft-captions", "--out", join(fix.dir, "p.mp4")]);
    assert.equal(none.status, 0, `stderr: ${none.stderr}`);
    assert.equal(none.json.softCaptions, undefined);
    assert.ok(none.json.skipped.some((s) => s.segmentId === "captions" && /no text segments/.test(s.reason)));
    assert.ok(none.json.args.includes("-shortest"), "no subtitle stream → -shortest stays");
  });

  it("describe lists --soft-captions on render", () => {
    const r = spawnCli(["describe"]);
    const spec = r.json.commands.find((c) => c.name === "render");
    assert.ok(spec.options.some((o) => o.flags.includes("--soft-captions")));
  });
});
