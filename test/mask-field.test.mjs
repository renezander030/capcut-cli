import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { addMask, maskTargetField } from "../dist/decorators.js";
import { lintDraft } from "../dist/lint.js";
import { migrateDraft } from "../dist/migrate.js";
import { detectVersion } from "../dist/version.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function segment(id, materialId) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start: 0, duration: 1_000_000 },
    source_timerange: { start: 0, duration: 1_000_000 },
    speed: 1,
    volume: 1,
    visible: true,
    clip: null,
    extra_material_refs: [],
    render_index: 0,
  };
}

function baseDraft(platform) {
  return {
    id: "d1",
    name: "mask-test",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    ...(platform ? { platform } : {}),
    tracks: [{ id: "T1", type: "video", name: "video", attribute: 0, segments: [segment("seg-1", "vid-1")] }],
    materials: {
      videos: [
        {
          id: "vid-1",
          path: "/tmp/x.mp4",
          material_name: "x",
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

describe("mask array variant selection", () => {
  describe("maskTargetField", () => {
    it("markerless drafts keep the CapCut-verified default (byte-identical to before)", () => {
      assert.equal(maskTargetField(baseDraft()), "common_mask");
    });

    it("CapCut drafts keep common_mask", () => {
      assert.equal(
        maskTargetField(baseDraft({ app_source: "cc", app_version: "8.7.0", os: "windows" })),
        "common_mask",
      );
    });

    it("JianYing >= 9.6 targets common_masks (pyJianYingDraft#160)", () => {
      assert.equal(
        maskTargetField(baseDraft({ app_source: "lv", app_version: "9.6.0", os: "windows" })),
        "common_masks",
      );
    });

    it("JianYing < 9.6 targets the legacy masks array", () => {
      assert.equal(maskTargetField(baseDraft({ app_source: "lv", app_version: "5.9.0", os: "windows" })), "masks");
    });

    it("versioned JianYing evidence beats a populated-but-wrong variant", () => {
      const draft = baseDraft({ app_source: "lv", app_version: "9.6.0", os: "windows" });
      draft.materials.masks = [{ id: "legacy-1", type: "mask" }];
      assert.equal(maskTargetField(draft), "common_masks");
    });

    it("without version evidence a populated variant wins, newest era first", () => {
      const draft = baseDraft();
      draft.materials.common_masks = [{ id: "cm-1", type: "mask" }];
      assert.equal(maskTargetField(draft), "common_masks");
    });

    it("an explicit override wins over everything", () => {
      const draft = baseDraft({ app_source: "lv", app_version: "9.6.0", os: "windows" });
      assert.equal(maskTargetField(draft, "masks"), "masks");
    });
  });

  describe("addMask", () => {
    it("writes into common_masks on a JianYing 9.6 draft and reports the field", () => {
      const draft = baseDraft({ app_source: "lv", app_version: "9.6.0", os: "windows" });
      const result = addMask(draft, "seg-1", "circle", {});
      assert.equal(result.field, "common_masks");
      assert.equal(draft.materials.common_masks.length, 1);
      assert.equal(draft.materials.common_mask, undefined, "the CapCut variant must stay untouched");
    });

    it("refuses to stack even when the existing mask lives in another variant", () => {
      const draft = baseDraft({ app_source: "lv", app_version: "9.6.0", os: "windows" });
      draft.materials.masks = [{ id: "legacy-1", type: "mask" }];
      draft.tracks[0].segments[0].extra_material_refs = ["legacy-1"];
      assert.throws(() => addMask(draft, "seg-1", "circle", {}), /already has a mask/);
    });
  });

  describe("mask command (e2e)", () => {
    it("--mask-field overrides the target array and --off removes across variants", () => {
      const fix = tmpDraft();
      try {
        const segs = spawnCli(["segments", fix.path, "--track", "video"]);
        assert.equal(segs.status, 0, `stderr: ${segs.stderr}`);
        const segId = segs.json[0].id.slice(0, 8);

        const r = spawnCli(["mask", fix.path, segId, "circle", "--mask-field", "common_masks"]);
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.equal(r.json.field, "common_masks");
        const written = JSON.parse(readFileSync(fix.path, "utf-8"));
        assert.ok(written.materials.common_masks.some((m) => m.id === r.json.mask_id));

        const off = spawnCli(["mask", fix.path, segId, "--off"]);
        assert.equal(off.status, 0, `stderr: ${off.stderr}`);
        assert.equal(off.json.removed, 1, "the ref must be removed even though the mask is not in common_mask");
      } finally {
        fix.cleanup();
      }
    });
  });

  describe("migrate consolidates common_mask", () => {
    it("legacy-to-new moves masks[] and common_mask[] into common_masks[]", () => {
      const draft = baseDraft();
      draft.materials.masks = [{ id: "a", type: "mask" }];
      draft.materials.common_mask = [{ id: "b", type: "mask" }];
      const result = migrateDraft(draft, "5.9", "9.6");
      assert.ok(result.applied.some((entry) => /^mask->common_masks/.test(entry)));
      assert.ok(result.applied.some((entry) => /^common_mask->common_masks/.test(entry)));
      assert.deepEqual(draft.materials.masks, []);
      assert.deepEqual(draft.materials.common_mask, []);
      assert.deepEqual(
        draft.materials.common_masks.map((m) => m.id),
        ["a", "b"],
      );
    });

    it("new-to-legacy moves common_masks[] and common_mask[] into masks[]", () => {
      const draft = baseDraft();
      draft.materials.common_masks = [{ id: "a", type: "mask" }];
      draft.materials.common_mask = [{ id: "b", type: "mask" }];
      const result = migrateDraft(draft, "9.6", "5.9");
      assert.ok(result.applied.some((entry) => /^common_masks->mask/.test(entry)));
      assert.ok(result.applied.some((entry) => /^common_mask->mask/.test(entry)));
      assert.deepEqual(
        draft.materials.masks.map((m) => m.id),
        ["a", "b"],
      );
    });
  });

  describe("lint mask-field-mismatch", () => {
    it("flags a JianYing 9.6 draft whose masks live in the legacy array", () => {
      const draft = baseDraft({ app_source: "lv", app_version: "9.6.0", os: "windows" });
      draft.materials.masks = [{ id: "legacy-1", type: "mask", name: "circle" }];
      const issues = lintDraft(draft, {
        maxCharsPerLine: 42,
        maxCueDurationUs: 7_000_000,
        minGapBetweenCaptionsUs: 0,
        checkLocalPaths: false,
      });
      const hit = issues.find((i) => i.code === "mask-field-mismatch");
      assert.ok(hit, JSON.stringify(issues));
      assert.equal(hit.severity, "info");
      assert.match(hit.message, /common_masks/);
      assert.match(hit.message, /migrate --from 5\.9 --to 9\.6/);
    });

    it("flags masks split across variant arrays on any app", () => {
      const draft = baseDraft({ app_source: "cc", app_version: "8.7.0", os: "windows" });
      draft.materials.common_mask = [{ id: "a", type: "mask" }];
      draft.materials.common_masks = [{ id: "b", type: "mask" }];
      const issues = lintDraft(draft, {
        maxCharsPerLine: 42,
        maxCueDurationUs: 7_000_000,
        minGapBetweenCaptionsUs: 0,
        checkLocalPaths: false,
      });
      const hit = issues.find((i) => i.code === "mask-field-mismatch");
      assert.ok(hit);
      assert.match(hit.message, /split across/);
    });

    it("stays silent on a consistent draft", () => {
      const draft = baseDraft({ app_source: "lv", app_version: "9.6.0", os: "windows" });
      draft.materials.common_masks = [{ id: "a", type: "mask" }];
      const issues = lintDraft(draft, {
        maxCharsPerLine: 42,
        maxCueDurationUs: 7_000_000,
        minGapBetweenCaptionsUs: 0,
        checkLocalPaths: false,
      });
      assert.equal(issues.filter((i) => i.code === "mask-field-mismatch").length, 0, JSON.stringify(issues));
    });
  });

  describe("version reports the CapCut variant", () => {
    it("detects common_mask and both", () => {
      const one = baseDraft();
      one.materials.common_mask = [{ id: "a", type: "mask" }];
      assert.equal(detectVersion(one).schema.mask_field, "common_mask");

      const two = baseDraft();
      two.materials.common_mask = [{ id: "a", type: "mask" }];
      two.materials.masks = [{ id: "b", type: "mask" }];
      assert.equal(detectVersion(two).schema.mask_field, "both");
    });
  });
});
