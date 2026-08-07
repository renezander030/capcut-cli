import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// These guards fire only on drafts CapCut itself can produce (a video segment
// pointing at a non-video material, a caption-template text segment whose
// material lives outside materials.texts). Neither is reachable by driving the
// CLI, so the drafts are staged on disk. The wording is user-facing and is
// shared by more than one command, so it is pinned here verbatim.

function readDraft(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeDraft(path, draft) {
  writeFileSync(path, JSON.stringify(draft, null, 2));
}

function firstVideoSegment(draft) {
  for (const track of draft.tracks) {
    if (track.type !== "video") continue;
    for (const seg of track.segments) {
      if (draft.materials.videos.some((v) => v.id === seg.material_id)) return seg;
    }
  }
  return null;
}

describe("video/photo material guard wording", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  // Retype the material the segment points at, so the lookup succeeds but the
  // type check rejects it — the second of the two guard branches.
  function stageWrongMaterialType() {
    const draft = readDraft(fix.path);
    const seg = firstVideoSegment(draft);
    assert.ok(seg, "fixture has a video segment backed by a video material");
    const mat = draft.materials.videos.find((v) => v.id === seg.material_id);
    mat.type = "gif";
    writeDraft(fix.path, draft);
    return seg.id;
  }

  it("mix-mode names itself when the material is not video/photo", () => {
    const segId = stageWrongMaterialType();
    const r = spawnCli(["mix-mode", fix.path, segId, "multiply"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /mix-mode only applies to video\/photo materials \(got type=gif\)/);
  });

  it("crop names itself when the material is not video/photo", () => {
    const segId = stageWrongMaterialType();
    const r = spawnCli(["crop", fix.path, segId, "--ratio", "1:1"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /crop only applies to video\/photo materials \(got type=gif\)/);
  });

  it("mix-mode names itself when the segment has no video material at all", () => {
    const draft = readDraft(fix.path);
    const seg = firstVideoSegment(draft) ?? readDraft(fix.path).tracks.flatMap((t) => t.segments)[0];
    draft.materials.videos = draft.materials.videos.filter((v) => v.id !== seg.material_id);
    writeDraft(fix.path, draft);
    const r = spawnCli(["mix-mode", fix.path, seg.id, "multiply"]);
    assert.notEqual(r.status, 0);
    assert.match(
      r.stderr,
      new RegExp(`mix-mode only applies to video/photo segments \\(no video material for ${seg.id}\\)`),
    );
  });
});

describe("text material guard wording", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  // A text-track segment whose material_id resolves nowhere in materials.texts
  // (CapCut 8.9 caption templates park it in materials.text_templates).
  function stageMissingTextMaterial() {
    const draft = readDraft(fix.path);
    const track = draft.tracks.find((t) => t.type === "text" && t.segments.length > 0);
    assert.ok(track, "fixture has a text track with a segment");
    const seg = track.segments[0];
    draft.materials.texts = draft.materials.texts.filter((m) => m.id !== seg.material_id);
    writeDraft(fix.path, draft);
    return seg.id;
  }

  it("text-style reports the missing text material", () => {
    const segId = stageMissingTextMaterial();
    const r = spawnCli(["text-style", fix.path, segId, "--alpha", "0.5"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`Text material not found for segment ${segId}`));
  });

  it("text-ranges reports the missing text material", () => {
    const segId = stageMissingTextMaterial();
    const r = spawnCli(["text-ranges", fix.path, segId, "--styles", '[{"range":[0,1],"size":10}]']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`Text material not found for segment ${segId}`));
  });

  it("bubble-text reports the missing text material", () => {
    const segId = stageMissingTextMaterial();
    const r = spawnCli(["bubble-text", fix.path, segId, "--bubble", "rectangle"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`Text material not found for segment ${segId}`));
  });

  it("make-preset reports the missing text material", () => {
    const segId = stageMissingTextMaterial();
    const r = spawnCli(["make-preset", fix.path, segId, "--out", `${fix.dir}/preset.json`]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`Text material not found for segment ${segId}`));
  });
});
