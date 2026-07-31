import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// A minimal draft in the draft_info-primary layout (newer Mac builds): the
// project folder has NO draft_content.json; draft_info.json holds the timeline.
function infoDraft() {
  return {
    id: "guid-info-primary",
    name: "mac-layout",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    platform: { app_source: "cc", app_version: "8.7.0", os: "mac" },
    tracks: [
      {
        id: "T1",
        type: "text",
        name: "text",
        attribute: 0,
        segments: [
          {
            id: "seg-1",
            material_id: "txt-1",
            target_timerange: { start: 0, duration: 1_000_000 },
            source_timerange: { start: 0, duration: 1_000_000 },
            speed: 1,
            volume: 1,
            visible: true,
            clip: null,
            extra_material_refs: [],
            render_index: 0,
          },
        ],
      },
    ],
    materials: {
      videos: [],
      audios: [],
      texts: [
        {
          id: "txt-1",
          type: "text",
          content: JSON.stringify({ text: "hello", styles: [] }),
          font_size: 15,
          text_color: "#ffffff",
          alignment: 1,
        },
      ],
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
}

function infoPrimaryProject() {
  const root = mkdtempSync(join(tmpdir(), "capcut-info-primary-"));
  const project = join(root, "proj");
  mkdirSync(project);
  writeFileSync(join(project, "draft_info.json"), JSON.stringify(infoDraft(), null, 2));
  return { root, project, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("draft_info-primary layout (no draft_content.json)", () => {
  it("edit commands load and write draft_info.json as canonical", () => {
    const f = infoPrimaryProject();
    after(f.cleanup);

    const r = spawnCli(["set-text", f.project, "seg-1", "changed"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const written = JSON.parse(readFileSync(join(f.project, "draft_info.json"), "utf-8"));
    assert.match(written.materials.texts[0].content, /changed/);
    assert.ok(!existsSync(join(f.project, "draft_content.json")), "no draft_content.json must be invented");
    assert.ok(existsSync(join(f.project, "draft_info.json.bak")), "the write must keep the usual .bak");
  });

  it("diagnose reports the layout with the fixture CTA", () => {
    const f = infoPrimaryProject();
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.project]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.layout, "info-primary");
    assert.equal(r.json.canonical, "draft_info.json");
    assert.ok(
      r.json.next_actions.some((a) => /draft_info-primary/.test(a) && /capcut fixture/.test(a)),
      `next_actions must name the layout and the fixture CTA; got: ${JSON.stringify(r.json.next_actions)}`,
    );
  });

  it("diagnose reports content-primary on a normal draft", () => {
    const f = tmpDraft();
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.layout, "content-primary");
  });

  it("register derives the identity from draft_info.json and repairs idempotently", () => {
    const f = infoPrimaryProject();
    after(f.cleanup);

    const plan = spawnCli(["register", f.project, "--drafts", f.root]);
    assert.equal(plan.status, 0, `stderr: ${plan.stderr}`);
    assert.equal(plan.json.identity_source, "draft_info.json");
    assert.equal(plan.json.draft_id, "guid-info-primary");
    assert.equal(plan.json.needs_repair, true);
    assert.ok(!existsSync(join(f.project, "draft_meta_info.json")), "plan must not write");

    const applied = spawnCli(["register", f.project, "--apply", "--drafts", f.root]);
    assert.equal(applied.status, 0, `stderr: ${applied.stderr}`);
    assert.ok(applied.json.applied.includes("draft_meta_info.json"));
    const meta = JSON.parse(readFileSync(join(f.project, "draft_meta_info.json"), "utf-8"));
    assert.equal(meta.draft_id, "guid-info-primary");
    assert.ok(meta.draft_json_file.endsWith("draft_info.json"), "the sidecar must point at the real timeline file");
    const index = JSON.parse(readFileSync(join(f.root, "root_meta_info.json"), "utf-8"));
    assert.ok(index.all_draft_store.some((e) => e.draft_id === "guid-info-primary"));

    const again = spawnCli(["register", f.project, "--apply", "--drafts", f.root]);
    assert.equal(again.status, 0, `stderr: ${again.stderr}`);
    assert.deepEqual(again.json.applied, [], "re-run must be idempotent");
  });

  it("register still errors when neither timeline file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "capcut-info-primary-"));
    after(() => rmSync(root, { recursive: true, force: true }));
    const project = join(root, "proj");
    mkdirSync(project);

    const r = spawnCli(["register", project, "--drafts", root]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /draft_content\.json or draft_info\.json/);
  });
});
