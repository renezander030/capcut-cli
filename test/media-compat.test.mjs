import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DEFAULT_LINT_OPTIONS, fixDraft, lintDraft } from "../dist/lint.js";
import { isVfr, parseMediaProbe, probeMedia } from "../dist/probe.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf-8" }).status === 0;
const hasFfprobe = spawnSync("ffprobe", ["-version"], { encoding: "utf-8" }).status === 0;

function probeJson(rFrameRate, avgFrameRate) {
  return JSON.stringify({
    streams: [
      { codec_type: "video", width: 1920, height: 1080, r_frame_rate: rFrameRate, avg_frame_rate: avgFrameRate },
    ],
    format: { duration: "1.0" },
  });
}

// A short clip whose frames keep their original spacing across a 30fps and a
// 10fps source half — r_frame_rate stays 30 while avg lands near 20 (VFR).
function makeVfrClip(path) {
  return (
    spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=0.5:rate=30",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=0.5:rate=10",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0[v]",
        "-map",
        "[v]",
        "-fps_mode",
        "vfr",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        path,
      ],
      { encoding: "utf-8", timeout: 60_000 },
    ).status === 0
  );
}

describe("media compatibility probe", () => {
  describe("parseMediaProbe frame rates + isVfr", () => {
    it("captures avg and base frame rates separately", () => {
      const probe = parseMediaProbe(probeJson("30/1", "20/1"));
      assert.equal(probe.baseFps, 30);
      assert.equal(probe.avgFps, 20);
      assert.equal(isVfr(probe), true);
    });

    it("constant frame rate is not flagged", () => {
      const probe = parseMediaProbe(probeJson("30000/1001", "30000/1001"));
      assert.equal(isVfr(probe), false);
    });

    it("missing rates never flag", () => {
      const probe = parseMediaProbe(probeJson("0/0", "0/0"));
      assert.equal(probe.avgFps, null);
      assert.equal(isVfr(probe), false);
    });
  });

  describe("lint vfr-media / media-unreadable (live ffprobe)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-media-compat-"));
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("flags a VFR clip with a normalize suggestion", { skip: !hasFfmpeg || !hasFfprobe }, () => {
      const clip = join(dir, "vfr.mp4");
      assert.ok(makeVfrClip(clip), "ffmpeg must produce the VFR clip");
      const probe = probeMedia(clip);
      assert.ok(
        probe && isVfr(probe),
        `generated clip must probe as VFR (avg ${probe?.avgFps} base ${probe?.baseFps})`,
      );

      const fix = tmpDraft();
      try {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.videos[0].path = clip;
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path]);
        const hit = (r.json.issues ?? []).find((i) => i.code === "vfr-media");
        assert.ok(hit, `expected vfr-media; got ${JSON.stringify(r.json.issues)}`);
        assert.equal(hit.severity, "info");
        assert.match(hit.suggested_command, /fps_mode cfr/);

        const quietRun = spawnCli(["lint", fix.path, "--no-probe"]);
        assert.ok(
          !(quietRun.json.issues ?? []).some((i) => i.code === "vfr-media"),
          "--no-probe must skip media probing",
        );
      } finally {
        fix.cleanup();
      }
    });

    it("flags an existing-but-unparseable media file", { skip: !hasFfprobe }, () => {
      const bogus = join(dir, "bogus.mp4");
      writeFileSync(bogus, "this is not a video file");
      const fix = tmpDraft();
      try {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.videos[0].path = bogus;
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path]);
        const hit = (r.json.issues ?? []).find((i) => i.code === "media-unreadable");
        assert.ok(hit, `expected media-unreadable; got ${JSON.stringify(r.json.issues)}`);
        assert.equal(hit.severity, "info");
        assert.ok(
          !(r.json.issues ?? []).some((i) => i.code === "missing-file" && i.location?.path === bogus),
          "the bogus file exists — it must not double-flag as missing-file",
        );
      } finally {
        fix.cleanup();
      }
    });
  });
});

describe("dangling companion refs + remediation hints", () => {
  function draftWithDanglingRef() {
    return {
      id: "d1",
      name: "dangling",
      duration: 1_000_000,
      fps: 30,
      canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
      tracks: [
        {
          id: "T1",
          type: "video",
          name: "video",
          attribute: 0,
          segments: [
            {
              id: "seg-1",
              material_id: "vid-1",
              target_timerange: { start: 0, duration: 1_000_000 },
              source_timerange: { start: 0, duration: 1_000_000 },
              speed: 1,
              volume: 1,
              visible: true,
              clip: null,
              extra_material_refs: ["ghost-ref"],
              render_index: 0,
            },
          ],
        },
      ],
      materials: {
        videos: [
          {
            id: "vid-1",
            path: "/nonexistent/gone.mp4",
            material_name: "gone",
            type: "video",
            duration: 1_000_000,
            width: 1080,
            height: 1920,
          },
        ],
        audios: [],
        texts: [],
        speeds: [],
        material_animations: [],
        audio_fades: [],
        transitions: [],
      },
    };
  }

  it("lint flags the dangling ref as fixable and fixDraft drops only the ref", () => {
    const draft = draftWithDanglingRef();
    const issues = lintDraft(draft, { ...DEFAULT_LINT_OPTIONS, checkLocalPaths: false });
    const hit = issues.find((i) => i.code === "dangling-companion-ref");
    assert.ok(hit, JSON.stringify(issues));
    assert.equal(hit.severity, "warning");
    assert.equal(hit.fixable, true);
    assert.equal(hit.location.material_id, "ghost-ref");

    const { fixed, remaining } = fixDraft(draft, { ...DEFAULT_LINT_OPTIONS, checkLocalPaths: false });
    assert.ok(fixed.some((i) => i.code === "dangling-companion-ref"));
    assert.ok(!remaining.some((i) => i.code === "dangling-companion-ref"));
    assert.deepEqual(draft.tracks[0].segments[0].extra_material_refs, []);
    assert.equal(draft.tracks[0].segments.length, 1, "the segment itself must survive");
  });

  it("missing-file and missing-material carry remediation hints, and stay report-only", () => {
    const draft = draftWithDanglingRef();
    draft.tracks[0].segments[0].material_id = "nope";
    const issues = lintDraft(draft, { ...DEFAULT_LINT_OPTIONS, probeMedia: false });
    const missingMaterial = issues.find((i) => i.code === "missing-material");
    assert.ok(missingMaterial);
    assert.equal(missingMaterial.fixable, false);
    assert.match(missingMaterial.suggested_command, /capcut remove/);
    const missingFile = issues.find((i) => i.code === "missing-file");
    assert.ok(missingFile);
    assert.equal(missingFile.fixable, false);
    assert.match(missingFile.suggested_command, /capcut relink/);
  });

  it("lint --fix repairs a dangling ref end-to-end and leaves a .bak", () => {
    const fix = tmpDraft();
    try {
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      draft.tracks[0].segments[0].extra_material_refs = [
        ...(draft.tracks[0].segments[0].extra_material_refs ?? []),
        "ghost-ref",
      ];
      writeFileSync(fix.path, JSON.stringify(draft));

      const before = spawnCli(["lint", fix.path, "--no-check-paths", "--no-probe"]);
      assert.ok((before.json.issues ?? []).some((i) => i.code === "dangling-companion-ref"));
      assert.equal(before.status, 1, "a warning must set exit code 1");

      const fixRun = spawnCli(["lint", fix.path, "--fix", "--no-check-paths", "--no-probe"]);
      assert.ok(
        fixRun.json.fixed.some((i) => i.code === "dangling-companion-ref"),
        JSON.stringify(fixRun.json),
      );
      const written = JSON.parse(readFileSync(fix.path, "utf-8"));
      assert.ok(!written.tracks[0].segments[0].extra_material_refs.includes("ghost-ref"));
      assert.ok(existsSync(`${fix.path}.bak`));

      const clean = spawnCli(["lint", fix.path, "--no-check-paths", "--no-probe"]);
      assert.ok(!(clean.json.issues ?? []).some((i) => i.code === "dangling-companion-ref"));
    } finally {
      fix.cleanup();
    }
  });
});
