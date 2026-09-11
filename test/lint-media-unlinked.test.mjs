import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// media-unlinked: a timeline material whose local_material_id does not name
// its draft_materials entry. JianYing 5.9+ and CapCut 9.3 resolve local clips
// through that key (luoluoluo22/jianying-editor-skill#23, JmsLdrn/capcut-mcp#1)
// and show them as missing / inaccessible without it — with no manual repair
// in the app's own Link-media dialog. Every pre-0.23 CLI draft is blank here,
// so the issue is info (no exit-code flip) and `lint --fix` writes the link.

// The project lives one level below a scratch root so a root_meta_info.json
// written for the register test stays inside the scratch root — never in the
// shared temp directory, where it would make every other test's draft look
// like it lives in a store.
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "capcut-unlinked-"));
  const dir = join(root, "project");
  mkdirSync(dir, { recursive: true });
  return { dir, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function project(dir, { sidecar, localMaterialId = "" }) {
  const clip = join(dir, "assets", "video", "clip.mp4");
  mkdirSync(join(dir, "assets", "video"), { recursive: true });
  writeFileSync(clip, "stub");
  writeFileSync(
    join(dir, "draft_content.json"),
    JSON.stringify({
      id: "guid-unlinked",
      name: "unlinked",
      duration: 1_000_000,
      fps: 30,
      canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
      platform: { app_source: "cc", app_version: "9.3.0", os: "mac" },
      tracks: [
        {
          id: "T1",
          type: "video",
          name: "video",
          attribute: 0,
          segments: [
            {
              id: "SEG-1",
              material_id: "V1",
              target_timerange: { start: 0, duration: 1_000_000 },
              source_timerange: { start: 0, duration: 1_000_000 },
            },
          ],
        },
      ],
      materials: {
        videos: [{ id: "V1", type: "video", path: clip, duration: 1_000_000, local_material_id: localMaterialId }],
        texts: [],
        speeds: [],
      },
    }),
  );
  if (sidecar !== null) {
    writeFileSync(
      join(dir, "draft_meta_info.json"),
      JSON.stringify({
        draft_id: "guid-unlinked",
        draft_name: "unlinked",
        draft_fold_path: dir,
        draft_materials: sidecar,
      }),
    );
  }
  return clip;
}

const ENTRY = (path) => ({
  ai_group_type: "",
  create_time: -1,
  duration: 1_000_000,
  enter_from: 0,
  extra_info: "clip.mp4",
  file_Path: path,
  height: 1080,
  id: "ENTRY-1",
  import_time: -1,
  import_time_ms: -1,
  item_source: 1,
  material_color_tag: "",
  md5: "",
  metetype: "video",
  roughcut_time_range: { duration: -1, start: -1 },
  sub_time_range: { duration: -1, start: -1 },
  type: 0,
  width: 1920,
});

describe("lint media-unlinked", () => {
  it("reports a blank local_material_id as fixable when the sidecar registers the file, and --fix links it", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    const clip = project(dir, { sidecar: [{ type: 0, value: [ENTRY((clip) => clip)] }] });
    // The entry was built before the path was known — rewrite it with the real path.
    const sidecar = JSON.parse(readFileSync(join(dir, "draft_meta_info.json"), "utf-8"));
    sidecar.draft_materials = [{ type: 0, value: [ENTRY(clip)] }];
    writeFileSync(join(dir, "draft_meta_info.json"), JSON.stringify(sidecar));

    const r = spawnCli(["lint", dir, "--no-probe"]);
    assert.equal(r.status, 0, `info only — exit stays 0: ${r.stderr}`);
    const issue = r.json.issues.find((i) => i.code === "media-unlinked");
    assert.ok(issue, JSON.stringify(r.json.issues));
    assert.equal(issue.severity, "info");
    assert.equal(issue.fixable, true);
    assert.equal(issue.location.material_id, "V1");
    assert.match(issue.message, /ENTRY-1/);

    const fix = spawnCli(["lint", dir, "--fix", "--no-probe"]);
    assert.equal(fix.status, 0, `stderr: ${fix.stderr}`);
    assert.ok(
      fix.json.fixed.some((i) => i.code === "media-unlinked"),
      JSON.stringify(fix.json),
    );
    const draft = JSON.parse(readFileSync(join(dir, "draft_content.json"), "utf-8"));
    assert.equal(draft.materials.videos[0].local_material_id, "ENTRY-1");

    const again = spawnCli(["lint", dir, "--no-probe"]);
    assert.ok(!again.json.issues.some((i) => i.code === "media-unlinked"));
  });

  it("points at register --materials when the file has no entry at all", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    project(dir, { sidecar: [{ type: 0, value: [] }] });
    const r = spawnCli(["lint", dir, "--no-probe"]);
    const issue = r.json.issues.find((i) => i.code === "media-unlinked");
    assert.ok(issue, JSON.stringify(r.json.issues));
    assert.equal(issue.fixable, false);
    assert.match(issue.suggested_command, /register <project> --materials --apply/);
    // The pre-existing empty-sidecar observation still stands next to it.
    assert.ok(r.json.issues.some((i) => i.code === "media-unregistered"));
    // --fix has nothing to link to and must not claim otherwise.
    const fix = spawnCli(["lint", dir, "--fix", "--no-probe"]);
    assert.ok(!fix.json.fixed.some((i) => i.code === "media-unlinked"));
  });

  it("is silent on a bare timeline file with no sidecar", (t) => {
    const { dir, cleanup } = scratch();
    t.after(cleanup);
    project(dir, { sidecar: null });
    const r = spawnCli(["lint", dir, "--no-probe"]);
    assert.ok(!r.json.issues.some((i) => i.code === "media-unlinked"), JSON.stringify(r.json.issues));
  });

  it("register --materials counts the materials still to link and names lint --fix", (t) => {
    const { dir, root, cleanup } = scratch();
    t.after(cleanup);
    project(dir, { sidecar: [{ type: 0, value: [] }] });
    writeFileSync(join(root, "root_meta_info.json"), JSON.stringify({ all_draft_store: [] }));
    const r = spawnCli(["register", dir, "--materials"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.materials.state, "unregistered");
    assert.equal(r.json.materials.unlinked_materials, 1);
    assert.match(r.json.materials.detail, /lint <project> --fix/);
  });
});
