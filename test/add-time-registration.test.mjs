import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// Add-time registration: media added by add-video / add-audio / quickstart /
// compile lands in draft_meta_info.json's draft_materials as it is added, and
// the timeline material carries the entry's id as local_material_id — the
// key JianYing 5.9+ / CapCut 9.3 resolve local media by
// (luoluoluo22/jianying-editor-skill#23, JmsLdrn/capcut-mcp#1). Before v0.23
// every pipeline had to remember `register --materials --apply` afterwards.

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "capcut-add-register-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function entries(sidecar) {
  return (sidecar.draft_materials ?? []).flatMap((group) => group.value ?? []);
}

describe("add-time media registration (draft_materials + local_material_id)", () => {
  it("add-video / add-audio register the file and link the material", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const drafts = join(dir, "drafts");
    const clip = join(dir, "clip.mp4");
    const voice = join(dir, "voice.wav");
    writeFileSync(clip, "stub");
    writeFileSync(voice, "stub");
    const init = spawnCli(["init", "reg", "--drafts", drafts, "--template", "bundled"]);
    assert.equal(init.status, 0, `stderr: ${init.stderr}`);
    const project = init.json.draft_path;

    const v = spawnCli(["add-video", project, clip, "0", "2s", "--no-probe"]);
    assert.equal(v.status, 0, `stderr: ${v.stderr}`);
    assert.equal(v.json.registration, "draft_materials");
    const a = spawnCli(["add-audio", project, voice, "0", "1s", "--no-probe"]);
    assert.equal(a.status, 0, `stderr: ${a.stderr}`);
    assert.equal(a.json.registration, "draft_materials");

    const sidecar = readJson(join(project, "draft_meta_info.json"));
    const registered = entries(sidecar);
    assert.equal(registered.length, 2);
    const videoEntry = registered.find((e) => e.metetype === "video");
    const audioEntry = registered.find((e) => e.metetype === "music");
    assert.ok(videoEntry && audioEntry, JSON.stringify(registered));
    assert.ok(videoEntry.file_Path.endsWith(join("assets", "video", "clip.mp4")), videoEntry.file_Path);
    assert.equal(videoEntry.duration, 2_000_000);
    assert.equal(audioEntry.width, 0);

    const draft = readJson(join(project, "draft_info.json"));
    const video = draft.materials.videos.find((m) => m.id === v.json.material_id);
    const audio = draft.materials.audios.find((m) => m.id === a.json.material_id);
    assert.equal(video.local_material_id, videoEntry.id, "video material links to its entry");
    assert.equal(audio.local_material_id, audioEntry.id, "audio material links to its entry");

    // The same file added again reuses its entry: one entry per distinct path.
    const again = spawnCli(["add-video", project, clip, "2s", "1s", "--no-probe"]);
    assert.equal(again.status, 0, `stderr: ${again.stderr}`);
    assert.equal(entries(readJson(join(project, "draft_meta_info.json"))).length, 2);
    const second = readJson(join(project, "draft_info.json")).materials.videos.find(
      (m) => m.id === again.json.material_id,
    );
    assert.equal(second.local_material_id, videoEntry.id);

    // Nothing left for lint or register to report on the registration axis.
    const lint = spawnCli(["lint", project, "--no-probe"]);
    const codes = lint.json.issues.map((i) => i.code);
    assert.ok(!codes.includes("media-unregistered"), codes.join(","));
    assert.ok(!codes.includes("media-unlinked"), codes.join(","));
    const plan = spawnCli(["register", project, "--materials"]);
    assert.equal(plan.status, 0, `stderr: ${plan.stderr}`);
    assert.equal(plan.json.materials.state, "ok");
    assert.equal(plan.json.materials.unlinked_materials, 0);
  });

  it("reports registration: none on a bare timeline file with no sidecar", (t) => {
    const fix = tmpDraft();
    t.after(() => fix.cleanup());
    const clip = join(fix.dir, "clip.mp4");
    writeFileSync(clip, "stub");
    const r = spawnCli(["add-video", fix.path, clip, "0", "1s", "--no-probe"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.registration, "none");
    const draft = readJson(fix.path);
    const video = draft.materials.videos.find((m) => m.id === r.json.material_id);
    assert.equal(video.local_material_id, "");
  });

  it("quickstart registers its inputs and reports where the skeleton came from", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const drafts = join(dir, "drafts");
    const clip = join(dir, "clip.mp4");
    writeFileSync(clip, "stub");
    const r = spawnCli(["quickstart", "qs", "--video", clip, "--drafts", drafts]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.template.source, "path", "an empty store seeds nothing");
    const step = r.json.steps.find((s) => s.step === "add-video");
    assert.match(step.detail, /Registered in draft_materials\./);
    const sidecar = readJson(join(r.json.draft_path, "draft_meta_info.json"));
    assert.equal(entries(sidecar).length, 1);
    assert.equal(r.json.lint.errors, 0);
  });
});
