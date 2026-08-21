import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";

// Read-only unregistered-media note: newer builds (reported on CapCut
// International 9.1.0, macOS) are reported to show timeline media as "file
// inaccessible" and prompt per-clip relinking when draft_meta_info.json's
// draft_materials does not register the media. The CLI never writes
// draft_materials (no real entry shape has been captured), so diagnose only
// observes and asks for the fixture bundle that evidence can come from.
function mediaDraft({ media = true } = {}) {
  const videos = media
    ? [
        {
          id: "vid-1",
          path: "/home/user/clips/a.mp4",
          material_name: "a.mp4",
          type: "video",
          duration: 5_000_000,
          width: 1920,
          height: 1080,
        },
        // Same file referenced twice — one file to relink, counted once.
        {
          id: "vid-2",
          path: "/home/user/clips/a.mp4",
          material_name: "a.mp4",
          type: "video",
          duration: 5_000_000,
          width: 1920,
          height: 1080,
        },
        {
          id: "vid-3",
          path: "/home/user/clips/b.mp4",
          material_name: "b.mp4",
          type: "video",
          duration: 5_000_000,
          width: 1920,
          height: 1080,
        },
        // A URL never needs registration.
        {
          id: "vid-4",
          path: "https://example.com/remote.mp4",
          material_name: "remote.mp4",
          type: "video",
          duration: 5_000_000,
          width: 1920,
          height: 1080,
        },
      ]
    : [];
  return {
    id: "draft-id",
    name: "media-project",
    duration: 5_000_000,
    fps: 30,
    canvas_config: { width: 1920, height: 1080, ratio: "16:9" },
    tracks: [
      {
        id: "track-1",
        type: "video",
        name: "video",
        attribute: 0,
        segments: videos.slice(0, 1).map((mat) => ({
          id: "seg-1",
          material_id: mat.id,
          target_timerange: { start: 0, duration: 5_000_000 },
          source_timerange: { start: 0, duration: 5_000_000 },
          speed: 1,
          volume: 1,
          visible: true,
          clip: null,
          extra_material_refs: [],
          render_index: 0,
        })),
      },
    ],
    materials: {
      videos,
      audios: [],
      texts: [],
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
}

function project({ media = true, meta } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-media-reg-"));
  writeFileSync(join(dir, "draft_content.json"), JSON.stringify(mediaDraft({ media }), null, 2));
  if (meta !== undefined) writeFileSync(join(dir, "draft_meta_info.json"), JSON.stringify(meta, null, 2));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const META_BASE = { draft_id: "draft-id", draft_name: "media-project" };

describe("diagnose flags unregistered timeline media in draft_meta_info.json (read-only)", () => {
  it("notes a CLI-born draft with no draft_meta_info.json at all", () => {
    const f = project();
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const note = r.json.media_registration;
    assert.ok(note, "the note must fire when no sidecar exists");
    assert.equal(note.draft_materials, "missing-file");
    assert.equal(note.referenced_media, 2, "distinct local files only — duplicates and URLs never count");
    assert.match(note.note, /no draft_meta_info\.json/);
    assert.match(note.note, /file inaccessible/);
    assert.match(note.note, /CapCut International 9\.1\.0, macOS/);
    assert.match(note.note, /capcut fixture <project> --out <dir>/);
  });

  it("notes a sidecar that carries no draft_materials key", () => {
    const f = project({ meta: META_BASE });
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const note = r.json.media_registration;
    assert.ok(note, "the note must fire when the key is absent");
    assert.equal(note.draft_materials, "missing-key");
    assert.match(note.note, /no `draft_materials` key/);
    assert.match(note.note, /reported/, "wording must stay factual about what is a report, not a certainty");
  });

  it("notes draft_materials present with every group empty", () => {
    const groups = project({
      meta: {
        ...META_BASE,
        draft_materials: [
          { type: 0, value: [] },
          { type: 1, value: [] },
        ],
      },
    });
    const bare = project({ meta: { ...META_BASE, draft_materials: [] } });
    after(groups.cleanup);
    after(bare.cleanup);

    for (const f of [groups, bare]) {
      const r = spawnCli(["diagnose", f.dir]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.media_registration?.draft_materials, "all-groups-empty");
      assert.match(r.json.media_registration.note, /every group in it is empty/);
    }
  });

  it("stays silent when draft_materials registers anything (synthetic populated shape)", () => {
    const f = project({ meta: { ...META_BASE, draft_materials: [{ type: 0, value: [{ id: "entry-1" }] }] } });
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!("media_registration" in r.json), "a populated sidecar must suppress the note");
  });

  it("stays silent when the timeline references no local media", () => {
    const f = project({ media: false });
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!("media_registration" in r.json), "no local media means nothing to register");
  });

  it("does not change ok, exit code, or the existing next_actions semantics", () => {
    // Sidecar present (missing key): no other action fires, so the all-clear
    // default must survive the note.
    const f = project({ meta: META_BASE });
    after(f.cleanup);

    const r = spawnCli(["diagnose", f.dir]);
    assert.equal(r.status, 0);
    assert.equal(r.json.ok, true);
    assert.ok(
      r.json.next_actions.some((a) => /Storage targets are readable and agree/.test(a)),
      "the note is informational — it must not displace the all-clear action",
    );
  });

  it("fixture bundles draft_meta_info.json, so the note's one-command ask is true", (t) => {
    const f = project({ meta: { ...META_BASE, draft_materials: [{ type: 0, value: [] }] } });
    after(f.cleanup);
    const outDir = mkdtempSync(join(tmpdir(), "capcut-media-reg-bundle-"));
    t.after(() => rmSync(outDir, { recursive: true, force: true }));

    const r = spawnCli(["fixture", f.dir, "--out", outDir]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(r.json.files.some((file) => file.file === "draft_meta_info.json"));
    assert.ok(existsSync(join(outDir, "draft_meta_info.json")));
    assert.ok(readFileSync(join(outDir, "draft_meta_info.json"), "utf-8").includes("draft_materials"));
  });
});
