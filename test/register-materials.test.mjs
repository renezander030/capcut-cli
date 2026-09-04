import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// `register --materials` (pyCapCut#13): CapCut 9.1 decides what is imported
// from draft_meta_info.json's draft_materials, so a tool-built sidecar with
// empty groups shows every clip as "file inaccessible". Entry shape per
// pyCapCut PR #14 — matched by file_Path, merged into the type-0 group.

function contentDraft(dir, { photo = false, audio = false } = {}) {
  const videos = [
    {
      id: "V1",
      type: "video",
      path: join(dir, "assets", "video", "clip.mp4"),
      material_name: "clip.mp4",
      duration: 3_000_000,
      width: 1920,
      height: 1080,
    },
  ];
  if (photo) {
    videos.push({
      id: "P1",
      type: "photo",
      path: join(dir, "assets", "video", "still.png"),
      material_name: "still.png",
      duration: 10_800_000_000,
      width: 800,
      height: 600,
    });
  }
  const audios = audio
    ? [
        {
          id: "A1",
          type: "extract_music",
          path: join(dir, "assets", "audio", "voice.wav"),
          name: "voice.wav",
          duration: 2_500_000,
        },
      ]
    : [];
  const segments = videos.map((v, i) => ({
    id: `SEG-${i}`,
    material_id: v.id,
    target_timerange: { start: i * 3_000_000, duration: 3_000_000 },
    source_timerange: { start: 0, duration: 3_000_000 },
  }));
  return {
    id: "guid-materials-draft",
    name: "materials-draft",
    duration: 3_000_000 * videos.length,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "9.1.0", os: "mac" },
    tracks: [
      { id: "T1", type: "video", name: "video", attribute: 0, segments },
      ...(audio
        ? [
            {
              id: "T2",
              type: "audio",
              name: "audio",
              attribute: 0,
              segments: [
                {
                  id: "SEG-A",
                  material_id: "A1",
                  target_timerange: { start: 0, duration: 2_500_000 },
                  source_timerange: { start: 0, duration: 2_500_000 },
                },
              ],
            },
          ]
        : []),
    ],
    materials: { videos, audios, texts: [], speeds: [], material_animations: [], audio_fades: [], transitions: [] },
  };
}

function sidecar(root, dir, draftMaterials) {
  return {
    draft_cover: "draft_cover.jpg",
    draft_fold_path: dir,
    draft_id: "guid-materials-draft",
    draft_json_file: join(dir, "draft_content.json"),
    draft_name: "materials-draft",
    draft_root_path: root,
    tm_draft_create: 1_700_000_000_000_000,
    tm_draft_modified: 1_700_000_000_000_000,
    tm_draft_removed: 0,
    tm_duration: 3_000_000,
    ...(draftMaterials === undefined ? {} : { draft_materials: draftMaterials }),
  };
}

function storeFixture({ meta, photo = false, audio = false, withMedia = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "capcut-register-materials-"));
  const dir = join(root, "Media Draft");
  mkdirSync(join(dir, "assets", "video"), { recursive: true });
  mkdirSync(join(dir, "assets", "audio"), { recursive: true });
  if (withMedia) {
    writeFileSync(join(dir, "assets", "video", "clip.mp4"), "stub");
    if (photo) writeFileSync(join(dir, "assets", "video", "still.png"), "stub");
    if (audio) writeFileSync(join(dir, "assets", "audio", "voice.wav"), "stub");
  }
  const content = contentDraft(dir, { photo, audio });
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(content, null, 2));
  if (meta !== null) {
    writeFileSync(join(dir, "draft_meta_info.json"), JSON.stringify(meta ?? sidecar(root, dir, EMPTY_GROUPS)));
  }
  writeFileSync(
    join(root, "root_meta_info.json"),
    JSON.stringify({
      all_draft_store: [
        {
          draft_cover: "draft_cover.jpg",
          draft_fold_path: dir,
          draft_id: "guid-materials-draft",
          draft_json_file: join(dir, "draft_content.json"),
          draft_name: "materials-draft",
          draft_root_path: root,
          tm_draft_create: 1_700_000_000_000_000,
          tm_draft_modified: 1_700_000_000_000_000,
          tm_draft_removed: 0,
          tm_duration: 3_000_000 * (photo ? 2 : 1),
        },
      ],
    }),
  );
  return { root, dir, content, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// CapCut's own tool-built sidecar carries every group with an empty value list.
const EMPTY_GROUPS = [
  { type: 0, value: [] },
  { type: 1, value: [] },
  { type: 2, value: [] },
];

function metaOnDisk(dir) {
  return JSON.parse(readFileSync(join(dir, "draft_meta_info.json"), "utf-8"));
}

describe("register --materials (pyCapCut#13 draft_materials registration)", () => {
  it("plans the registration without writing anything", () => {
    const f = storeFixture();
    after(f.cleanup);
    const before = readFileSync(join(f.dir, "draft_meta_info.json"), "utf-8");
    const r = spawnCli(["register", f.dir, "--materials", "--drafts", f.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.applied, false);
    assert.equal(r.json.needs_repair, true);
    assert.deepEqual(r.json.repairs, ["draft_meta_info.json"]);
    assert.equal(r.json.materials.action, "update");
    assert.equal(r.json.materials.state, "unregistered");
    assert.equal(r.json.materials.referenced, 1);
    assert.equal(r.json.materials.registered, 0);
    assert.deepEqual(r.json.materials.to_register, [join(f.dir, "assets", "video", "clip.mp4")]);
    assert.match(r.stderr, /plan: update draft_meta_info.json draft_materials/);
    assert.equal(readFileSync(join(f.dir, "draft_meta_info.json"), "utf-8"), before, "plan mode never writes");
  });

  it("--apply appends a PR-#14-shaped entry to the type-0 group, keeps the other groups, backs up the sidecar", () => {
    const f = storeFixture();
    after(f.cleanup);
    const r = spawnCli(["register", f.dir, "--materials", "--apply", "--drafts", f.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.applied, ["draft_meta_info.json"]);
    assert.deepEqual(r.json.backups, ["draft_meta_info.json.bak"]);
    assert.ok(existsSync(join(f.dir, "draft_meta_info.json.bak")));
    assert.match(r.stderr, /Registered 1 media file\(s\) in draft_materials/);

    const meta = metaOnDisk(f.dir);
    assert.equal(meta.draft_materials.length, 3, "non-zero groups are preserved");
    const group0 = meta.draft_materials.find((g) => g.type === 0);
    assert.equal(group0.value.length, 1);
    const entry = group0.value[0];
    assert.equal(entry.file_Path, join(f.dir, "assets", "video", "clip.mp4"));
    assert.equal(entry.metetype, "video");
    assert.equal(entry.extra_info, "clip.mp4");
    assert.equal(entry.duration, 3_000_000);
    assert.equal(entry.width, 1920);
    assert.equal(entry.height, 1080);
    assert.equal(entry.type, 0);
    assert.equal(entry.item_source, 1);
    assert.equal(entry.import_time, -1);
    assert.equal(entry.md5, "");
    assert.deepEqual(entry.roughcut_time_range, { duration: -1, start: -1 });
    assert.match(entry.id, /^[0-9a-f-]{36}$/);
    // The registration fields register already maintains are untouched.
    assert.equal(meta.draft_id, "guid-materials-draft");
    assert.equal(meta.draft_name, "materials-draft");
    // The verify pass after the write reports the registration complete.
    assert.equal(r.json.materials.state, "ok");
    assert.equal(r.json.materials.registered, 1);
  });

  it("re-running is a no-op", () => {
    const f = storeFixture();
    after(f.cleanup);
    assert.equal(spawnCli(["register", f.dir, "--materials", "--apply", "--drafts", f.root]).status, 0);
    const written = readFileSync(join(f.dir, "draft_meta_info.json"), "utf-8");
    const again = spawnCli(["register", f.dir, "--materials", "--apply", "--drafts", f.root]);
    assert.equal(again.status, 0, `stderr: ${again.stderr}`);
    assert.deepEqual(again.json.applied, []);
    assert.equal(again.json.materials.action, "none");
    assert.match(again.json.message, /already registered/);
    assert.equal(readFileSync(join(f.dir, "draft_meta_info.json"), "utf-8"), written);
  });

  it("photos get the nominal 5 s duration and audio registers as music with zero dimensions", () => {
    const f = storeFixture({ photo: true, audio: true });
    after(f.cleanup);
    const r = spawnCli(["register", f.dir, "--materials", "--apply", "--drafts", f.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const group0 = metaOnDisk(f.dir).draft_materials.find((g) => g.type === 0);
    assert.equal(group0.value.length, 3);
    const still = group0.value.find((e) => e.file_Path.endsWith("still.png"));
    assert.equal(still.metetype, "photo");
    assert.equal(still.duration, 5_000_000);
    assert.equal(still.width, 800);
    const voice = group0.value.find((e) => e.file_Path.endsWith("voice.wav"));
    assert.equal(voice.metetype, "music");
    assert.equal(voice.duration, 2_500_000);
    assert.equal(voice.width, 0);
    assert.equal(voice.height, 0);
    assert.equal(voice.extra_info, "voice.wav");
  });

  it("preserves existing entries and only appends what is missing", () => {
    const f = storeFixture({ photo: true });
    after(f.cleanup);
    const existing = {
      ai_group_type: "",
      create_time: 1_700_000_000,
      duration: 3_000_000,
      enter_from: 0,
      extra_info: "clip.mp4",
      file_Path: join(f.dir, "assets", "video", "clip.mp4"),
      height: 1080,
      id: "APP-WRITTEN-ENTRY",
      import_time: 1_700_000_000,
      import_time_ms: 1_700_000_000_000,
      item_source: 1,
      material_color_tag: "",
      md5: "abc",
      metetype: "video",
      roughcut_time_range: { duration: -1, start: -1 },
      sub_time_range: { duration: -1, start: -1 },
      type: 0,
      width: 1920,
    };
    const stray = { ...existing, id: "STRAY", file_Path: "/somewhere/else.mp4", extra_info: "else.mp4" };
    writeFileSync(
      join(f.dir, "draft_meta_info.json"),
      JSON.stringify(sidecar(f.root, f.dir, [{ type: 0, value: [existing, stray] }])),
    );
    const plan = spawnCli(["register", f.dir, "--materials", "--drafts", f.root]);
    assert.equal(plan.status, 0, `stderr: ${plan.stderr}`);
    assert.equal(plan.json.materials.registered, 1);
    assert.deepEqual(plan.json.materials.to_register, [join(f.dir, "assets", "video", "still.png")]);
    assert.equal(plan.json.materials.unreferenced_entries, 1, "the stray entry is counted, never removed");

    const r = spawnCli(["register", f.dir, "--materials", "--apply", "--drafts", f.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const group0 = metaOnDisk(f.dir).draft_materials.find((g) => g.type === 0);
    assert.equal(group0.value.length, 3);
    assert.deepEqual(group0.value[0], existing, "the app-written entry is byte-for-byte preserved");
    assert.deepEqual(group0.value[1], stray);
    assert.equal(group0.value[2].metetype, "photo");
  });

  it("a missing sidecar is recreated and registered in ONE write", () => {
    const f = storeFixture({ meta: null });
    after(f.cleanup);
    const r = spawnCli(["register", f.dir, "--materials", "--apply", "--drafts", f.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.deepEqual(r.json.applied, ["draft_meta_info.json"]);
    assert.deepEqual(r.json.backups, [], "no .bak for a file that did not exist");
    const meta = metaOnDisk(f.dir);
    assert.equal(meta.draft_id, "guid-materials-draft", "the registration fields are written");
    assert.equal(meta.draft_materials.find((g) => g.type === 0).value.length, 1, "and the media is registered");
  });

  it("creates the draft_materials array when the sidecar has no such key", () => {
    const f = storeFixture({ meta: undefined });
    after(f.cleanup);
    const bare = metaOnDisk(f.dir);
    delete bare.draft_materials;
    writeFileSync(join(f.dir, "draft_meta_info.json"), JSON.stringify(bare));
    const r = spawnCli(["register", f.dir, "--materials", "--apply", "--drafts", f.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const meta = metaOnDisk(f.dir);
    assert.deepEqual(
      meta.draft_materials.map((g) => g.type),
      [0],
    );
    assert.equal(meta.draft_materials[0].value.length, 1);
  });

  it("without --materials the sidecar's draft_materials is untouched and the plan has no materials key", () => {
    const f = storeFixture();
    after(f.cleanup);
    const r = spawnCli(["register", f.dir, "--apply", "--drafts", f.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.materials, undefined);
    assert.deepEqual(r.json.applied, []);
    assert.deepEqual(metaOnDisk(f.dir).draft_materials, EMPTY_GROUPS);
  });

  it("reports no-media when the timeline references nothing local", () => {
    const f = storeFixture({ withMedia: true });
    after(f.cleanup);
    const content = JSON.parse(readFileSync(join(f.dir, "draft_content.json"), "utf-8"));
    content.materials.videos[0].path = "https://upload.wikimedia.org/x.webm";
    writeFileSync(join(f.dir, "draft_content.json"), JSON.stringify(content));
    const r = spawnCli(["register", f.dir, "--materials", "--drafts", f.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.materials.state, "no-media");
    assert.equal(r.json.needs_repair, false);
  });

  it("clears lint's media-unregistered note", () => {
    const f = storeFixture();
    after(f.cleanup);
    const before = spawnCli(["lint", join(f.dir, "draft_content.json"), "--no-probe"]);
    assert.ok(
      before.json.issues.some((i) => i.code === "media-unregistered"),
      "precondition: the note fires",
    );
    assert.equal(spawnCli(["register", f.dir, "--materials", "--apply", "--drafts", f.root]).status, 0);
    const afterFix = spawnCli(["lint", join(f.dir, "draft_content.json"), "--no-probe"]);
    assert.equal(afterFix.status, 0, `stderr: ${afterFix.stderr}`);
    assert.ok(!afterFix.json.issues.some((i) => i.code === "media-unregistered"));
  });

  it("describe lists --materials on register", () => {
    const r = spawnCli(["describe"]);
    const spec = r.json.commands.find((c) => c.name === "register");
    assert.ok(spec.options.some((o) => o.flags.includes("--materials")));
  });
});
