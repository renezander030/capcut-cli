import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDir, tmpDraft } from "./helpers/tmp-draft.mjs";

// Seed a dedicated text track (own materials, own segments) into a fixture
// draft, so timing rules can't interact with the fixture's Subtitles track.
function seedTextTrack(draftPath, trackId, materials, segments) {
  const draft = JSON.parse(readFileSync(draftPath, "utf-8"));
  draft.materials.texts = [...(draft.materials.texts ?? []), ...materials];
  draft.tracks.push({ id: trackId, type: "text", name: trackId, attribute: 0, segments });
  writeFileSync(draftPath, JSON.stringify(draft));
}

function textMat(id, text) {
  return {
    id,
    type: "text",
    content: JSON.stringify({ text, styles: [] }),
    font_size: 15,
    text_color: "#FFFFFF",
    alignment: 1,
  };
}

function textSeg(id, materialId, startUs, durationUs) {
  return {
    id,
    material_id: materialId,
    target_timerange: { start: startUs, duration: durationUs },
    source_timerange: { start: 0, duration: durationUs },
    speed: 1,
    volume: 1,
    visible: true,
    clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
    extra_material_refs: [],
    render_index: 0,
  };
}

describe("capcut lint", () => {
  describe("on a clean fixture", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    // The fixture has local-file paths that don't exist on this host. Skip path checks
    // so we measure schema/caption rules without unrelated noise.
    it("returns JSON with summary + issues", () => {
      const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
      assert.ok(r.json, "stdout should be valid JSON");
      assert.equal(typeof r.json.ok, "boolean");
      assert.ok(r.json.summary);
      assert.equal(typeof r.json.summary.errors, "number");
      assert.equal(typeof r.json.summary.warnings, "number");
      assert.ok(Array.isArray(r.json.issues));
    });

    it("exit code 0 when no errors and no warnings", () => {
      const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
      if (r.json.summary.errors === 0 && r.json.summary.warnings === 0) {
        assert.equal(r.status, 0);
      }
    });

    it("renders human output with -H", () => {
      const r = spawnCli(["lint", fix.path, "-H", "--no-check-paths"]);
      assert.ok(/OK — no issues/.test(r.stdout) || /errors/.test(r.stdout), `unexpected -H output: ${r.stdout}`);
    });
  });

  describe("path check detects missing material files", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("emits missing-file errors when local paths don't resolve", () => {
      // Default fixture has Windows-style C:\ paths that won't exist on linux — this is the
      // exact pain `capcut lint` catches: pipelines that produce broken-path drafts.
      const r = spawnCli(["lint", fix.path]);
      // Either zero issues (paths happen to exist) or errors with code missing-file.
      if (r.json.summary.errors > 0) {
        assert.equal(r.status, 2);
        const missing = r.json.issues.filter((i) => i.code === "missing-file");
        assert.ok(missing.length > 0, "expected at least one missing-file issue");
      }
    });
  });

  describe("caption overlap detection", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("flags overlapping captions as errors", () => {
      // Inject an overlapping caption pair into the fixture and confirm we detect it.
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      // Ensure a text track exists with at least 2 segments — append synthetic ones if needed.
      let textTrack = draft.tracks.find((t) => t.type === "text");
      if (!textTrack) {
        textTrack = { id: "synthetic-text-track", type: "text", name: "captions", attribute: 0, segments: [] };
        draft.tracks.push(textTrack);
      }
      // Use existing text material if available, else add one.
      let mat = draft.materials.texts?.[0];
      if (!mat) {
        mat = {
          id: "synthetic-text-mat",
          type: "text",
          content: '{"text":"Hello world","styles":[]}',
          font_size: 15,
          text_color: "#FFFFFF",
          alignment: 1,
        };
        draft.materials.texts = [...(draft.materials.texts ?? []), mat];
      }
      const baseSeg = {
        material_id: mat.id,
        source_timerange: { start: 0, duration: 1_000_000 },
        speed: 1,
        volume: 1,
        visible: true,
        clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
        extra_material_refs: [],
        render_index: 0,
      };
      textTrack.segments.push({
        ...baseSeg,
        id: "synth-seg-1-aaaa-bbbb-cccc-dddddddddddd",
        target_timerange: { start: 0, duration: 2_000_000 },
      });
      textTrack.segments.push({
        ...baseSeg,
        id: "synth-seg-2-aaaa-bbbb-cccc-dddddddddddd",
        target_timerange: { start: 1_000_000, duration: 2_000_000 }, // overlaps with seg-1
      });
      writeFileSync(fix.path, JSON.stringify(draft));

      const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
      const overlaps = r.json.issues.filter((i) => i.code === "caption-overlap");
      assert.ok(overlaps.length > 0, `expected caption-overlap error; got: ${JSON.stringify(r.json.issues)}`);
      assert.equal(r.status, 2);
    });
  });

  describe("--fix auto-repair", () => {
    function seedOverlappingCaptions(draftPath) {
      const draft = JSON.parse(readFileSync(draftPath, "utf-8"));
      let mat = draft.materials.texts?.[0];
      if (!mat) {
        mat = {
          id: "fix-mat-1",
          type: "text",
          content: '{"text":"Hello","styles":[]}',
          font_size: 15,
          text_color: "#FFFFFF",
          alignment: 1,
        };
        draft.materials.texts = [...(draft.materials.texts ?? []), mat];
      }
      let textTrack = draft.tracks.find((t) => t.type === "text");
      if (!textTrack) {
        textTrack = { id: "fix-text-track", type: "text", name: "captions", attribute: 0, segments: [] };
        draft.tracks.push(textTrack);
      }
      const base = {
        material_id: mat.id,
        source_timerange: { start: 0, duration: 1_000_000 },
        speed: 1,
        volume: 1,
        visible: true,
        clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
        extra_material_refs: [],
        render_index: 0,
      };
      // Overlap: seg A ends at 2s, seg B starts at 1s (500ms overlap).
      textTrack.segments.push({
        ...base,
        id: "fix-seg-1-aaaa-bbbb-cccc-dddddddddddd",
        target_timerange: { start: 100_000_000, duration: 2_000_000 },
      });
      textTrack.segments.push({
        ...base,
        id: "fix-seg-2-aaaa-bbbb-cccc-dddddddddddd",
        target_timerange: { start: 101_000_000, duration: 2_000_000 },
      });
      // A missing-material reference on a separate segment — not fixable.
      textTrack.segments.push({
        ...base,
        id: "fix-seg-3-aaaa-bbbb-cccc-dddddddddddd",
        material_id: "does-not-exist-in-any-materials",
        target_timerange: { start: 200_000_000, duration: 1_000_000 },
      });
      writeFileSync(draftPath, JSON.stringify(draft));
    }

    describe("repairs fixable defects and writes atomically", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("trims overlapping captions, leaves non-fixable issues reported, and writes a .bak", () => {
        seedOverlappingCaptions(fix.path);

        const r = spawnCli(["lint", fix.path, "--fix", "--no-check-paths"]);
        assert.ok(r.json, `stdout should be JSON; got: ${r.stdout}`);
        assert.ok(Array.isArray(r.json.fixed), "expected fixed[] in output");
        const overlapFixed = r.json.fixed.filter((i) => i.code === "caption-overlap");
        assert.ok(overlapFixed.length > 0, `expected caption-overlap in fixed; got: ${JSON.stringify(r.json.fixed)}`);

        // The non-fixable missing-material remains and drives exit code 2.
        const missing = r.json.issues.filter((i) => i.code === "missing-material");
        assert.ok(missing.length > 0, "missing-material should remain reported");
        assert.equal(missing[0].fixable, false);
        assert.equal(r.status, 2);

        // .bak snapshot created by saveDraft.
        assert.ok(existsSync(`${fix.path}.bak`), "expected .bak to be written next to the draft");

        // The on-disk draft no longer overlaps.
        const repaired = JSON.parse(readFileSync(fix.path, "utf-8"));
        const track = repaired.tracks.find((t) => t.segments.some((s) => s.id.startsWith("fix-seg-1")));
        const segs = [...track.segments].sort((a, b) => a.target_timerange.start - b.target_timerange.start);
        for (let i = 0; i < segs.length - 1; i++) {
          const end = segs[i].target_timerange.start + segs[i].target_timerange.duration;
          assert.ok(end <= segs[i + 1].target_timerange.start, `segments still overlap: ${JSON.stringify(segs)}`);
        }
      });
    });

    describe("--fix --dry-run", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("previews the plan without writing the draft or a .bak", () => {
        seedOverlappingCaptions(fix.path);
        const before = readFileSync(fix.path, "utf-8");

        const r = spawnCli(["lint", fix.path, "--fix", "--dry-run", "--no-check-paths"]);
        assert.ok(r.json, `stdout should be JSON; got: ${r.stdout}`);
        // dryRun stamp comes from the shared out() helper.
        assert.equal(r.json.dryRun, true);
        const overlapFixed = r.json.fixed.filter((i) => i.code === "caption-overlap");
        assert.ok(overlapFixed.length > 0, "expected caption-overlap to appear in fixed[] under --dry-run");

        const after = readFileSync(fix.path, "utf-8");
        assert.equal(after, before, "--dry-run must not modify the draft");
        assert.ok(!existsSync(`${fix.path}.bak`), "--dry-run must not write a .bak");
      });
    });
  });

  describe("line-length warnings", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("flags overlong caption lines as warnings", () => {
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      const longText = "x".repeat(60); // > default 42
      const mat = {
        id: "long-text-mat",
        type: "text",
        content: JSON.stringify({ text: longText, styles: [] }),
        font_size: 15,
        text_color: "#FFFFFF",
        alignment: 1,
      };
      draft.materials.texts = [...(draft.materials.texts ?? []), mat];
      let textTrack = draft.tracks.find((t) => t.type === "text");
      if (!textTrack) {
        textTrack = { id: "synthetic-text-track-2", type: "text", name: "captions", attribute: 0, segments: [] };
        draft.tracks.push(textTrack);
      }
      textTrack.segments.push({
        id: "long-seg-aaaa-bbbb-cccc-dddddddddddd",
        material_id: mat.id,
        target_timerange: { start: 10_000_000, duration: 2_000_000 },
        source_timerange: { start: 0, duration: 2_000_000 },
        speed: 1,
        volume: 1,
        visible: true,
        clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
        extra_material_refs: [],
        render_index: 0,
      });
      writeFileSync(fix.path, JSON.stringify(draft));

      const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
      const tooLong = r.json.issues.filter((i) => i.code === "line-too-long");
      assert.ok(tooLong.length > 0, `expected line-too-long warning; got: ${JSON.stringify(r.json.issues)}`);
    });
  });

  describe("--fix re-wraps over-long caption lines", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("wraps at word boundaries, keeps text length, and re-lints clean", () => {
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      const longText = "the quick brown fox jumps over the lazy dog and keeps running far beyond the fence"; // 83 chars > 42
      const mat = {
        id: "wrap-text-mat",
        type: "text",
        content: JSON.stringify({ text: longText, styles: [] }),
        font_size: 15,
        text_color: "#FFFFFF",
        alignment: 1,
      };
      draft.materials.texts = [...(draft.materials.texts ?? []), mat];
      let textTrack = draft.tracks.find((t) => t.type === "text");
      if (!textTrack) {
        textTrack = { id: "wrap-text-track", type: "text", name: "captions", attribute: 0, segments: [] };
        draft.tracks.push(textTrack);
      }
      textTrack.segments.push({
        id: "wrap-seg-1-aaaa-bbbb-cccc-dddddddddddd",
        material_id: mat.id,
        target_timerange: { start: 300_000_000, duration: 2_000_000 },
        source_timerange: { start: 0, duration: 2_000_000 },
        speed: 1,
        volume: 1,
        visible: true,
        clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
        extra_material_refs: [],
        render_index: 0,
      });
      writeFileSync(fix.path, JSON.stringify(draft));

      const detect = spawnCli(["lint", fix.path, "--no-check-paths"]);
      const found = detect.json.issues.filter((i) => i.code === "line-too-long");
      assert.ok(found.length > 0, `expected line-too-long; got: ${JSON.stringify(detect.json.issues)}`);
      assert.equal(found[0].fixable, true);

      const r = spawnCli(["lint", fix.path, "--fix", "--no-check-paths"]);
      const wrapped = r.json.fixed.filter((i) => i.code === "line-too-long");
      assert.ok(wrapped.length > 0, `expected line-too-long in fixed; got: ${JSON.stringify(r.json.fixed)}`);

      const relint = spawnCli(["lint", fix.path, "--no-check-paths"]);
      assert.ok(
        !relint.json.issues.some((i) => i.code === "line-too-long"),
        `re-lint should be clean; got: ${JSON.stringify(relint.json.issues)}`,
      );

      // Word-boundary wrap must be length-neutral (spaces become newlines 1:1)
      // so the styles[] UTF-16LE byte ranges stay valid.
      const repaired = JSON.parse(readFileSync(fix.path, "utf-8"));
      const content = JSON.parse(repaired.materials.texts.find((m) => m.id === "wrap-text-mat").content);
      assert.equal(content.text.length, longText.length, "wrap must not change text length");
      assert.equal(content.text.replace(/\n/g, " "), longText, "only spaces may become newlines");
      for (const line of content.text.split("\n")) {
        assert.ok(line.length <= 42, `wrapped line still too long: "${line}"`);
      }
    });
  });

  describe("--fix restores minimum caption gaps", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("shrinks the earlier caption's end under --min-gap-ms and re-lints clean", () => {
      const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
      let mat = draft.materials.texts?.[0];
      if (!mat) {
        mat = {
          id: "gap-mat-1",
          type: "text",
          content: '{"text":"Hello","styles":[]}',
          font_size: 15,
          text_color: "#FFFFFF",
          alignment: 1,
        };
        draft.materials.texts = [...(draft.materials.texts ?? []), mat];
      }
      let textTrack = draft.tracks.find((t) => t.type === "text");
      if (!textTrack) {
        textTrack = { id: "gap-text-track", type: "text", name: "captions", attribute: 0, segments: [] };
        draft.tracks.push(textTrack);
      }
      const base = {
        material_id: mat.id,
        source_timerange: { start: 0, duration: 2_000_000 },
        speed: 1,
        volume: 1,
        visible: true,
        clip: { alpha: 1, rotation: 0, scale: { x: 1, y: 1 }, transform: { x: 0, y: 0 } },
        extra_material_refs: [],
        render_index: 0,
      };
      // Gap: seg A ends at 402.0s, seg B starts at 402.1s — 100ms < 200ms minimum.
      textTrack.segments.push({
        ...base,
        id: "gap-seg-1-aaaa-bbbb-cccc-dddddddddddd",
        target_timerange: { start: 400_000_000, duration: 2_000_000 },
      });
      textTrack.segments.push({
        ...base,
        id: "gap-seg-2-aaaa-bbbb-cccc-dddddddddddd",
        target_timerange: { start: 402_100_000, duration: 2_000_000 },
      });
      writeFileSync(fix.path, JSON.stringify(draft));

      const detect = spawnCli(["lint", fix.path, "--min-gap-ms", "200", "--no-check-paths"]);
      const found = detect.json.issues.filter((i) => i.code === "caption-gap-too-small");
      assert.ok(found.length > 0, `expected caption-gap-too-small; got: ${JSON.stringify(detect.json.issues)}`);
      assert.equal(found[0].fixable, true);

      const r = spawnCli(["lint", fix.path, "--fix", "--min-gap-ms", "200", "--no-check-paths"]);
      const gapFixed = r.json.fixed.filter((i) => i.code === "caption-gap-too-small");
      assert.ok(gapFixed.length > 0, `expected caption-gap-too-small in fixed; got: ${JSON.stringify(r.json.fixed)}`);

      const relint = spawnCli(["lint", fix.path, "--min-gap-ms", "200", "--no-check-paths"]);
      assert.ok(
        !relint.json.issues.some((i) => i.code === "caption-gap-too-small"),
        `re-lint should be clean; got: ${JSON.stringify(relint.json.issues)}`,
      );

      // The earlier caption's end moved back; the later caption never moves.
      const repaired = JSON.parse(readFileSync(fix.path, "utf-8"));
      const track = repaired.tracks.find((t) => t.segments.some((s) => s.id.startsWith("gap-seg-1")));
      const segA = track.segments.find((s) => s.id.startsWith("gap-seg-1"));
      const segB = track.segments.find((s) => s.id.startsWith("gap-seg-2"));
      assert.equal(segA.target_timerange.duration, 1_900_000);
      assert.equal(segB.target_timerange.start, 402_100_000);
    });
  });

  describe("unknown-effect-slug detection", () => {
    function baseEffectMaterial(id, name, effectId, resourceId) {
      return {
        id,
        name,
        type: "video_effect",
        effect_id: effectId,
        resource_id: resourceId,
        adjust_params: [],
        apply_target_type: 2,
        category_id: "",
        category_name: "",
        platform: "all",
        value: 1.0,
      };
    }

    describe("flags ids missing from the enum table", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("reports bogus effect and animation ids as info, without failing the exit code", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.video_effects = [
          baseEffectMaterial("bogus-effect-mat", "Stale Effect", "1111111111111111111", "1111111111111111111"),
        ];
        draft.materials.material_animations = [
          {
            id: "bogus-anim-container",
            type: "sticker_animation",
            multi_language_current: "none",
            animations: [
              {
                id: "2222222222222222222",
                resource_id: "2222222222222222222",
                name: "Stale Anim",
                type: "in",
                duration: 500_000,
                start: 0,
                material_type: "text",
              },
            ],
          },
        ];
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        const unknown = r.json.issues.filter((i) => i.code === "unknown-effect-slug");
        assert.equal(unknown.length, 2, `expected 2 unknown-effect-slug issues; got: ${JSON.stringify(r.json.issues)}`);
        const materialIds = unknown.map((i) => i.location.material_id).sort();
        assert.deepEqual(materialIds, ["bogus-anim-container", "bogus-effect-mat"]);
        for (const i of unknown) {
          assert.equal(i.severity, "info");
          assert.equal(i.fixable, false);
        }
        // Info only — the bundled table can't know store-downloaded effects,
        // so a UI-authored draft must keep exiting 0 (regression: v0.13 review
        // found this check flipping CI gates to exit 1 on valid drafts).
        assert.equal(r.json.summary.errors, 0);
        assert.equal(r.json.summary.warnings, 0);
        assert.equal(r.json.summary.info, 2);
        assert.equal(r.status, 0);

        // Report-only: --fix must not claim it repaired anything here.
        const fixRun = spawnCli(["lint", fix.path, "--fix", "--no-check-paths"]);
        assert.ok(
          !fixRun.json.fixed.some((i) => i.code === "unknown-effect-slug"),
          `unknown-effect-slug must never appear in fixed[]; got: ${JSON.stringify(fixRun.json.fixed)}`,
        );
        assert.ok(fixRun.json.issues.some((i) => i.code === "unknown-effect-slug"));
      });
    });

    describe("passes on known ids", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("accepts enum-table ids and the inline starter catalogue", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.video_effects = [
          // From enums.json (capcut scene_effects: blur).
          baseEffectMaterial("enum-effect-mat", "Blur", "15206412", "6739752823140913675"),
          // From the inline knossos-verified starter catalogue (add-effect shake).
          baseEffectMaterial("inline-effect-mat", "Shake", "7061205058364788270", "7061205058364788270"),
        ];
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        assert.ok(
          !r.json.issues.some((i) => i.code === "unknown-effect-slug"),
          `expected no unknown-effect-slug; got: ${JSON.stringify(r.json.issues)}`,
        );
      });
    });

    describe("flags unknown ids in transitions, masks, audio effects and bubbles", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("reports all four arrays as info, without failing the exit code", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.transitions = [
          {
            id: "bogus-transition-mat",
            name: "Stale Transition",
            type: "transition",
            effect_id: "1111111111111111112",
            resource_id: "1111111111111111112",
            duration: 500_000,
            is_overlap: true,
          },
        ];
        // Deliberately no effect_id: mask materials carry resource_id only,
        // pinning the effect_id || resource_id fallback.
        draft.materials.common_mask = [
          {
            id: "bogus-mask-mat",
            name: "Stale Mask",
            type: "mask",
            resource_id: "2222222222222222223",
            resource_type: "line",
          },
        ];
        // The two mask VARIANT arrays `migrate` relocates into: `common_masks`
        // (legacy-to-new, JianYing 9.6+) and `masks` (new-to-legacy). Both are
        // effect-shaped arrays the CLI writes, so both get swept.
        draft.materials.common_masks = [
          {
            id: "bogus-common-masks-mat",
            name: "Stale Migrated Mask",
            type: "mask",
            resource_id: "5555555555555555556",
            resource_type: "line",
          },
        ];
        draft.materials.masks = [
          {
            id: "bogus-legacy-masks-mat",
            name: "Stale Legacy Mask",
            type: "mask",
            resource_id: "6666666666666666667",
            resource_type: "line",
          },
        ];
        draft.materials.audio_effects = [
          {
            id: "bogus-sfx-mat",
            name: "Stale SFX",
            type: "audio_effect",
            effect_id: "3333333333333333334",
            resource_id: "3333333333333333334",
          },
        ];
        draft.materials.filters = [
          {
            id: "bogus-bubble-mat",
            name: "Stale Bubble",
            type: "text_shape",
            effect_id: "4444444444444444445",
            resource_id: "4444444444444444445",
            apply_target_type: 0,
            value: 1.0,
          },
        ];
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        const unknown = r.json.issues.filter((i) => i.code === "unknown-effect-slug");
        assert.equal(unknown.length, 6, `expected 6 unknown-effect-slug issues; got: ${JSON.stringify(r.json.issues)}`);
        const materialIds = unknown.map((i) => i.location.material_id).sort();
        assert.deepEqual(materialIds, [
          "bogus-bubble-mat",
          "bogus-common-masks-mat",
          "bogus-legacy-masks-mat",
          "bogus-mask-mat",
          "bogus-sfx-mat",
          "bogus-transition-mat",
        ]);
        for (const i of unknown) {
          assert.equal(i.severity, "info");
          assert.equal(i.fixable, false);
        }
        assert.equal(r.json.summary.errors, 0);
        assert.equal(r.json.summary.warnings, 0);
        assert.equal(r.status, 0);
      });
    });

    describe("passes on known transition/mask/sfx/bubble ids", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("accepts enum-table ids and the inline bubble catalogue", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        // From enums.json capcut: transitions "Montage Snippets", masks "Split"
        // (resource_id only, like real mask materials), audio_effects "Big House".
        draft.materials.transitions = [
          {
            id: "enum-transition-mat",
            name: "Montage Snippets",
            type: "transition",
            effect_id: "460B9343-B792-4c38-B6F5-6886C031B8D2",
            resource_id: "7481553072678784311",
          },
        ];
        draft.materials.common_mask = [
          {
            id: "enum-mask-mat",
            name: "Split",
            type: "mask",
            resource_id: "7374020197990011409",
            resource_type: "line",
          },
        ];
        // Known mask ids in the migrate-relocated variant arrays must pass
        // too — the enum table covers all three mask homes.
        draft.materials.common_masks = [
          {
            id: "enum-common-masks-mat",
            name: "Split",
            type: "mask",
            resource_id: "7374020197990011409",
            resource_type: "line",
          },
        ];
        draft.materials.masks = [
          {
            id: "enum-legacy-masks-mat",
            name: "Split",
            type: "mask",
            resource_id: "7374020197990011409",
            resource_type: "line",
          },
        ];
        draft.materials.audio_effects = [
          {
            id: "enum-sfx-mat",
            name: "Big House",
            type: "audio_effect",
            effect_id: "8954C5C2-A0BB-4915-8CB2-B422445DCB71",
            resource_id: "7350559836590838274",
          },
        ];
        // From the inline bubble catalogue (rectangle) — pins the
        // bubbleCatalogue() registration in knownEffectIds().
        draft.materials.filters = [
          {
            id: "catalogue-bubble-mat",
            name: "Rectangle",
            type: "text_shape",
            effect_id: "7137268628230638087",
            resource_id: "7137268628230638087",
          },
        ];
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        assert.ok(
          !r.json.issues.some((i) => i.code === "unknown-effect-slug"),
          `expected no unknown-effect-slug; got: ${JSON.stringify(r.json.issues)}`,
        );
      });
    });

    describe("CLI-written decorations never self-flag", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("transition + mask + sfx + bubble applied via CLI lint clean", () => {
        const videoSegs = spawnCli(["segments", fix.path, "--track", "video"]).json ?? [];
        assert.ok(videoSegs.length >= 2, "fixture should have two video segments");
        const t = spawnCli(["transition", fix.path, videoSegs[0].id.slice(0, 8), "montage-snippets"]);
        assert.equal(t.status, 0, `transition failed: ${t.stderr}`);
        const m = spawnCli(["mask", fix.path, videoSegs[0].id.slice(0, 8), "circle"]);
        assert.equal(m.status, 0, `mask failed: ${m.stderr}`);
        const s = spawnCli(["add-sfx", fix.path, "big-house", "1s", "2s"]);
        assert.equal(s.status, 0, `add-sfx failed: ${s.stderr}`);
        const texts = spawnCli(["texts", fix.path]).json ?? [];
        assert.ok(texts.length > 0, "fixture should have text segments");
        const b = spawnCli(["bubble-text", fix.path, texts[0].id.slice(0, 8), "--bubble", "rectangle"]);
        assert.equal(b.status, 0, `bubble-text failed: ${b.stderr}`);

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        assert.ok(
          !r.json.issues.some((i) => i.code === "unknown-effect-slug" || i.code === "unknown-font-id"),
          `CLI-written materials must not self-flag; got: ${JSON.stringify(r.json.issues)}`,
        );
      });
    });
  });

  describe("unknown-font-id detection", () => {
    // Orphan text materials (no segment references them): the font check scans
    // materials.texts directly, and an unreferenced material triggers no
    // missing-material or caption rules.
    function fontMat(id, extra) {
      return { id, type: "text", font_size: 15, text_color: "#FFFFFF", alignment: 1, ...extra };
    }

    describe("flags a font id missing from the bundled table", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("reports one info issue and keeps exit code 0", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.texts.push(
          fontMat("bogus-font-mat", {
            content: JSON.stringify({
              text: "hi",
              styles: [{ font: { id: "9999999999999999998", path: "/nonexistent/font.ttf" } }],
            }),
          }),
        );
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        const fonts = r.json.issues.filter((i) => i.code === "unknown-font-id");
        assert.equal(fonts.length, 1, `expected 1 unknown-font-id issue; got: ${JSON.stringify(r.json.issues)}`);
        assert.equal(fonts[0].severity, "info");
        assert.equal(fonts[0].fixable, false);
        assert.equal(fonts[0].location.material_id, "bogus-font-mat");
        assert.equal(r.json.summary.errors, 0);
        assert.equal(r.json.summary.warnings, 0);
        assert.equal(r.status, 0);
      });
    });

    describe("passes on known jianying font ids", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("accepts both resource_id (span style) and effect_id (flat field) forms", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.texts.push(
          // jianying fonts CC-Captial resource_id, span-style form.
          fontMat("known-font-span-mat", {
            content: JSON.stringify({ text: "hi", styles: [{ font: { id: "7418508570066424330" } }] }),
          }),
          // jianying fonts CC-Captial effect_id, flat-field form.
          fontMat("known-font-flat-mat", {
            content: JSON.stringify({ text: "hi", styles: [] }),
            font_id: "84086581",
          }),
        );
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        assert.ok(
          !r.json.issues.some((i) => i.code === "unknown-font-id"),
          `expected no unknown-font-id; got: ${JSON.stringify(r.json.issues)}`,
        );
      });
    });

    describe("resolvable font path silences the unknown id", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("skips when the path exists, reports again under --no-check-paths", () => {
        const fontFile = join(fix.dir, "local-font.ttf");
        writeFileSync(fontFile, "not really a font");
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.texts.push(
          fontMat("local-font-mat", {
            content: JSON.stringify({
              text: "hi",
              styles: [{ font: { id: "9999999999999999997", path: fontFile } }],
            }),
          }),
        );
        writeFileSync(fix.path, JSON.stringify(draft));

        const withPaths = spawnCli(["lint", fix.path]);
        assert.ok(
          !withPaths.json.issues.some((i) => i.code === "unknown-font-id"),
          `on-disk font path should silence the check; got: ${JSON.stringify(withPaths.json.issues)}`,
        );

        // --no-check-paths keeps lint fs-free: only the id-table verdict remains.
        const noPaths = spawnCli(["lint", fix.path, "--no-check-paths"]);
        assert.equal(noPaths.json.issues.filter((i) => i.code === "unknown-font-id").length, 1);
      });
    });

    describe("per-material granularity", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("emits one issue per material even when every span repeats the font", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.texts.push(
          fontMat("karaoke-font-mat", {
            content: JSON.stringify({
              text: "one two three",
              styles: [
                { font: { id: "9999999999999999996" } },
                { font: { id: "9999999999999999996" } },
                { font: { id: "9999999999999999996" } },
              ],
            }),
          }),
        );
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        assert.equal(r.json.issues.filter((i) => i.code === "unknown-font-id").length, 1);
      });
    });

    describe("no font set", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("stays silent on materials without any font id", () => {
        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        assert.ok(
          !r.json.issues.some((i) => i.code === "unknown-font-id"),
          `fixture has no font ids; got: ${JSON.stringify(r.json.issues)}`,
        );
      });
    });

    describe("malformed content", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("still flags via the flat font_id field and does not crash", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.texts.push(
          fontMat("broken-content-mat", { content: "not-json", font_id: "9999999999999999995" }),
        );
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        assert.equal(r.status, 0);
        const fonts = r.json.issues.filter((i) => i.code === "unknown-font-id");
        assert.equal(fonts.length, 1);
        assert.equal(fonts[0].location.material_id, "broken-content-mat");
      });
    });

    describe("--fix neutrality for new codes", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("never claims to fix unknown-effect-slug or unknown-font-id", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.transitions = [
          {
            id: "fixrun-transition-mat",
            name: "Stale",
            type: "transition",
            effect_id: "1111111111111111119",
            resource_id: "1111111111111111119",
          },
        ];
        draft.materials.texts.push(
          fontMat("fixrun-font-mat", {
            content: JSON.stringify({ text: "hi", styles: [{ font: { id: "9999999999999999994" } }] }),
          }),
        );
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--fix", "--no-check-paths"]);
        for (const code of ["unknown-effect-slug", "unknown-font-id"]) {
          assert.ok(
            !r.json.fixed.some((i) => i.code === code),
            `${code} must never appear in fixed[]; got: ${JSON.stringify(r.json.fixed)}`,
          );
          assert.ok(
            r.json.issues.some((i) => i.code === code),
            `${code} must remain reported after --fix; got: ${JSON.stringify(r.json.issues)}`,
          );
        }
      });
    });
  });

  describe("--fix gap repair never crushes a caption below the render floor", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("skips the shrink and stamps the issue fixable:false when it would leave a sub-frame sliver", () => {
      // Mirror of the v0.13 review reproduction: caption A runs 50,003us and B
      // starts 49,998us after A ends. Closing the gap to 100ms would leave A
      // at 1us — far below one 30fps frame (33,333us), i.e. deleted from
      // playback — yet the old fixer did exactly that and reported FIXED.
      seedTextTrack(
        fix.path,
        "gap-floor-track",
        [textMat("gap-floor-mat", "Hi")],
        [
          textSeg("gapfloor-1-aaaa-bbbb-cccc-dddddddddddd", "gap-floor-mat", 500_000_000, 50_003),
          textSeg("gapfloor-2-aaaa-bbbb-cccc-dddddddddddd", "gap-floor-mat", 500_100_001, 1_000_000),
        ],
      );

      const detect = spawnCli(["lint", fix.path, "--min-gap-ms", "100", "--no-check-paths"]);
      const found = detect.json.issues.filter((i) => i.code === "caption-gap-too-small");
      assert.equal(found.length, 1, `expected one caption-gap-too-small; got: ${JSON.stringify(detect.json.issues)}`);
      assert.equal(found[0].fixable, false, "a gap --fix cannot clear must not be stamped fixable:true");

      const before = readFileSync(fix.path, "utf-8");
      const r = spawnCli(["lint", fix.path, "--fix", "--min-gap-ms", "100", "--no-check-paths"]);
      assert.ok(
        !r.json.fixed.some((i) => i.code === "caption-gap-too-small"),
        `must not claim FIXED; got: ${JSON.stringify(r.json.fixed)}`,
      );
      assert.ok(r.json.issues.some((i) => i.code === "caption-gap-too-small" && i.fixable === false));
      assert.equal(r.status, 1, "the surviving warning keeps exit code 1");

      // Nothing was repairable, so the draft must not be rewritten at all.
      assert.equal(readFileSync(fix.path, "utf-8"), before, "--fix must not save a draft it didn't repair");
      const repaired = JSON.parse(before);
      const segA = repaired.tracks
        .find((t) => t.id === "gap-floor-track")
        .segments.find((s) => s.id.startsWith("gapfloor-1"));
      assert.equal(segA.target_timerange.duration, 50_003, "caption A must keep its full duration");
    });
  });

  describe("--fix gap repair still applies when the result stays at or above the floor", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("shrinks a caption down to exactly the 100ms floor and re-lints clean", () => {
      // gap = 49,998us (<100ms); the needed 50,002us shrink lands A exactly on
      // the 100,000us floor — the tightest still-allowed repair.
      seedTextTrack(
        fix.path,
        "gap-edge-track",
        [textMat("gap-edge-mat", "Hi")],
        [
          textSeg("gapedge-1-aaaa-bbbb-cccc-dddddddddddd", "gap-edge-mat", 600_000_000, 150_002),
          textSeg("gapedge-2-aaaa-bbbb-cccc-dddddddddddd", "gap-edge-mat", 600_200_000, 1_000_000),
        ],
      );

      const detect = spawnCli(["lint", fix.path, "--min-gap-ms", "100", "--no-check-paths"]);
      const found = detect.json.issues.filter((i) => i.code === "caption-gap-too-small");
      assert.equal(found.length, 1);
      assert.equal(found[0].fixable, true);

      const r = spawnCli(["lint", fix.path, "--fix", "--min-gap-ms", "100", "--no-check-paths"]);
      assert.ok(
        r.json.fixed.some((i) => i.code === "caption-gap-too-small"),
        `expected the gap in fixed[]; got: ${JSON.stringify(r.json.fixed)}`,
      );
      assert.equal(r.status, 0);

      const repaired = JSON.parse(readFileSync(fix.path, "utf-8"));
      const segA = repaired.tracks
        .find((t) => t.id === "gap-edge-track")
        .segments.find((s) => s.id.startsWith("gapedge-1"));
      assert.equal(segA.target_timerange.duration, 100_000, "caption A shrinks exactly to the floor");
    });
  });

  describe("--fix wraps lines whose break lands in a multi-space run", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("never leaves an output line over --max-chars and stays length-neutral", () => {
      // Mirror of the v0.13 review reproduction: with the break placed at the
      // END of the space run, 'abcdefgh      xy' "wrapped" to a 13-char first
      // line that still violated the 10-char cap forever.
      const text = "abcdefgh      xy"; // 8 chars + 6 spaces + 2 chars
      seedTextTrack(
        fix.path,
        "wrap-run-track",
        [textMat("wrap-run-mat", text)],
        [textSeg("wraprun-1-aaaa-bbbb-cccc-dddddddddddd", "wrap-run-mat", 700_000_000, 1_000_000)],
      );

      const detect = spawnCli(["lint", fix.path, "--max-chars", "10", "--no-check-paths"]);
      const mine = detect.json.issues.filter(
        (i) => i.code === "line-too-long" && i.location?.segment_id?.startsWith("wraprun-1"),
      );
      assert.equal(mine.length, 1, `expected line-too-long; got: ${JSON.stringify(detect.json.issues)}`);
      assert.equal(mine[0].fixable, true);

      const r = spawnCli(["lint", fix.path, "--fix", "--max-chars", "10", "--no-check-paths"]);
      assert.ok(
        r.json.fixed.some((i) => i.code === "line-too-long" && i.location?.segment_id?.startsWith("wraprun-1")),
        `expected the wrap in fixed[]; got: ${JSON.stringify(r.json.fixed)}`,
      );
      assert.ok(
        !r.json.issues.some((i) => i.code === "line-too-long" && i.location?.segment_id?.startsWith("wraprun-1")),
        `line-too-long must not survive --fix here; got: ${JSON.stringify(r.json.issues)}`,
      );

      const repaired = JSON.parse(readFileSync(fix.path, "utf-8"));
      const content = JSON.parse(repaired.materials.texts.find((m) => m.id === "wrap-run-mat").content);
      assert.equal(content.text.length, text.length, "wrap must stay length-neutral");
      assert.equal(content.text.replace(/\n/g, " "), text, "only spaces may become newlines");
      for (const line of content.text.split("\n")) {
        assert.ok(line.length <= 10, `broken line still exceeds the cap: ${JSON.stringify(line)}`);
      }
    });
  });

  describe("--fix converges on lines ending in a space run", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("wraps once and a second --fix is a byte-identical no-op (no stacked blank lines)", () => {
      // Mirror of the v0.13 review reproduction: 'aaaaaaaaaa   ' degraded one
      // trailing space per --fix run into stacked blank caption lines.
      const text = "aaaaaaaaaa   "; // 10 chars + 3 trailing spaces
      seedTextTrack(
        fix.path,
        "wrap-tail-track",
        [textMat("wrap-tail-mat", text)],
        [textSeg("wraptail-1-aaaa-bbbb-cccc-dddddddddddd", "wrap-tail-mat", 750_000_000, 1_000_000)],
      );

      const r1 = spawnCli(["lint", fix.path, "--fix", "--max-chars", "10", "--no-check-paths"]);
      assert.ok(
        !r1.json.issues.some((i) => i.code === "line-too-long" && i.location?.segment_id?.startsWith("wraptail-1")),
        `the trailing-run line must be clean after one --fix; got: ${JSON.stringify(r1.json.issues)}`,
      );
      const afterFirst = readFileSync(fix.path, "utf-8");
      const content = JSON.parse(JSON.parse(afterFirst).materials.texts.find((m) => m.id === "wrap-tail-mat").content);
      assert.equal(content.text, "aaaaaaaaaa\n  ", "the surplus spaces move past the break, not onto the full line");

      const r2 = spawnCli(["lint", fix.path, "--fix", "--max-chars", "10", "--no-check-paths"]);
      assert.equal(r2.json.fixed.length, 0, `second --fix must fix nothing; got: ${JSON.stringify(r2.json.fixed)}`);
      assert.equal(readFileSync(fix.path, "utf-8"), afterFirst, "--fix must converge, not keep mutating the draft");
    });
  });

  describe("line-too-long fixable stamping matches what --fix can actually do", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    it("stamps fixable:false on raw-JSON fallback and over-cap single words, true on CJK", () => {
      // Two shapes the re-wrapper provably cannot clear (v0.13 review):
      // 1) content JSON without a text field — the checker measures the raw
      //    content fallback, which the fixer never touches;
      // 2) a single word longer than the cap — words are never split.
      // Space-less CJK used to be a third: there is no space to swap for a
      // newline. It is now repaired by inserting one between two characters
      // and shifting the styles[] byte ranges across the insertion, so it is
      // stamped fixable and cleared below.
      const noTextContent = JSON.stringify({ styles: [{ range: [0, 10] }], noText: "x".repeat(160) });
      seedTextTrack(
        fix.path,
        "stamp-track",
        [
          {
            id: "stamp-notext-mat",
            type: "text",
            content: noTextContent,
            font_size: 15,
            text_color: "#FFFFFF",
            alignment: 1,
          },
          // A real styles[] range spanning the whole text, so the repair's
          // offset shift is actually exercised rather than skipped over an
          // empty styles array.
          {
            id: "stamp-cjk-mat",
            type: "text",
            content: JSON.stringify({
              text: "字".repeat(60),
              styles: [{ range: [0, "字".repeat(60).length] }],
            }),
            font_size: 15,
            text_color: "#FFFFFF",
            alignment: 1,
          },
          textMat("stamp-word-mat", "x".repeat(60)),
        ],
        [
          textSeg("stamp-1-aaaa-bbbb-cccc-dddddddddddd", "stamp-notext-mat", 800_000_000, 1_000_000),
          textSeg("stamp-2-aaaa-bbbb-cccc-dddddddddddd", "stamp-cjk-mat", 802_000_000, 1_000_000),
          textSeg("stamp-3-aaaa-bbbb-cccc-dddddddddddd", "stamp-word-mat", 804_000_000, 1_000_000),
        ],
      );

      const detect = spawnCli(["lint", fix.path, "--no-check-paths"]);
      const mine = detect.json.issues.filter(
        (i) => i.code === "line-too-long" && i.location?.segment_id?.startsWith("stamp-"),
      );
      assert.equal(mine.length, 3, `expected three line-too-long issues; got: ${JSON.stringify(detect.json.issues)}`);
      const byId = (suffix) => mine.find((i) => i.location.segment_id.startsWith(suffix));
      assert.equal(byId("stamp-1").fixable, false, "raw-JSON fallback is not repairable");
      assert.equal(byId("stamp-3").fixable, false, "an over-cap single word is never split");
      assert.equal(byId("stamp-2").fixable, true, "space-less CJK is repairable by character break");

      const r = spawnCli(["lint", fix.path, "--fix", "--no-check-paths"]);
      const fixedCjk = r.json.fixed.filter(
        (i) => i.code === "line-too-long" && i.location?.segment_id?.startsWith("stamp-2"),
      );
      assert.equal(fixedCjk.length, 1, `the CJK caption must be repaired; got: ${JSON.stringify(r.json.fixed)}`);
      const remaining = r.json.issues.filter(
        (i) => i.code === "line-too-long" && i.location?.segment_id?.startsWith("stamp-"),
      );
      assert.equal(remaining.length, 2, "the two unrepairable shapes stay reported");

      // The repair must leave every line within the cap and keep styles[]
      // pointing at the same characters: ranges are code-unit offsets, so each
      // inserted newline shifts a later boundary by exactly 1.
      const after = JSON.parse(readFileSync(fix.path, "utf-8"));
      const cjkMat = after.materials.texts.find((m) => m.id === "stamp-cjk-mat");
      const content = JSON.parse(cjkMat.content);
      assert.ok(content.text.includes("\n"), "a break was inserted");
      assert.equal(content.text.replace(/\n/g, ""), "字".repeat(60), "no character was lost or added");
      for (const line of content.text.split("\n")) {
        assert.ok(line.length <= 42, `line still over cap: ${line.length}`);
      }
      const breaks = content.text.split("\n").length - 1;
      assert.equal(
        content.styles[0].range[1],
        content.text.length,
        `the style range must span the rewrapped text (${breaks} insertion(s) => +${breaks} code units)`,
      );
    });
  });

  describe("main-track-gap detection", () => {
    // The main track = the FIRST video track (bottom layer). CapCut's magnetic
    // main track closes gaps between its segments on open, silently shifting
    // every later segment left — sun-guannan/VectCutAPI#54. The fixture's main
    // track is 0-5s | 5-10s with an audio bed ending at 10s and subtitles
    // ending at 9.7s; moving the second video segment right opens a gap at 5s.

    describe("contiguous main track and gappy overlays stay silent", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("flags nothing on back-to-back main segments, even with a gap on an overlay video track", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        const main = draft.tracks.find((t) => t.type === "video");
        // The fixture's segment 0 is a 1.5x clip (7.5s of source over 5s of
        // timeline) sharing a 1.5 speed material. Keep that ratio when cloning:
        // 1s of timeline consumes 1.5s of source. Overriding both ranges to 1s
        // would leave a segment whose declared speed contradicts its own
        // timeranges and trip speed-timerange-mismatch, which has nothing to do
        // with the magnetic-main-track behaviour under test here.
        const overlaySeg = (id, startUs) => ({
          ...structuredClone(main.segments[0]),
          id,
          target_timerange: { start: startUs, duration: 1_000_000 },
          source_timerange: { start: 0, duration: 1_500_000 },
        });
        // Overlay (PiP) tracks are not magnetic — a gap here is normal layout,
        // so only the first video track may ever produce this code.
        draft.tracks.push({
          id: "overlay-video-track",
          type: "video",
          name: "overlay",
          attribute: 0,
          segments: [
            overlaySeg("overlay-1-aaaa-bbbb-cccc-dddddddddddd", 1_000_000),
            overlaySeg("overlay-2-aaaa-bbbb-cccc-dddddddddddd", 8_000_000),
          ],
        });
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        assert.ok(
          !r.json.issues.some((i) => i.code === "main-track-gap"),
          `contiguous main track must not flag; got: ${JSON.stringify(r.json.issues)}`,
        );
        assert.equal(r.status, 0);
      });
    });

    describe("report-only when other tracks are aligned past the gap", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("warns with fixable:false + suggested_command, and --fix leaves the file byte-identical", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        const main = draft.tracks.find((t) => t.type === "video");
        const earlierId = main.segments[0].id;
        // 0-5s | 600ms gap | 5.6-10.6s. Audio bed and subtitles reach past the
        // gap's start, so the close-up would desync them: report-only.
        main.segments[1].target_timerange.start = 5_600_000;
        writeFileSync(fix.path, JSON.stringify(draft));

        const r = spawnCli(["lint", fix.path, "--no-check-paths"]);
        const gaps = r.json.issues.filter((i) => i.code === "main-track-gap");
        assert.equal(gaps.length, 1, `expected one main-track-gap; got: ${JSON.stringify(r.json.issues)}`);
        assert.equal(gaps[0].severity, "warning");
        assert.equal(gaps[0].fixable, false, "a close-up that would desync other tracks must not be stamped fixable");
        assert.ok(gaps[0].suggested_command, "report-only instance must carry a suggested_command");
        assert.equal(gaps[0].location.track, "Track 1");
        assert.equal(gaps[0].location.segment_id, earlierId, "the issue anchors on the segment before the gap");
        // The warning flips the exit code 0 -> 1 — the changelog calls this
        // out: such a draft was always going to re-time itself on open.
        assert.equal(r.json.summary.warnings, 1);
        assert.equal(r.status, 1);

        const before = readFileSync(fix.path, "utf-8");
        const fixRun = spawnCli(["lint", fix.path, "--fix", "--no-check-paths"]);
        assert.ok(
          !fixRun.json.fixed.some((i) => i.code === "main-track-gap"),
          `must not claim FIXED; got: ${JSON.stringify(fixRun.json.fixed)}`,
        );
        assert.ok(fixRun.json.issues.some((i) => i.code === "main-track-gap" && i.fixable === false));
        assert.equal(fixRun.status, 1);
        assert.equal(readFileSync(fix.path, "utf-8"), before, "--fix must not rewrite a draft it didn't repair");
        assert.ok(!existsSync(`${fix.path}.bak`), "no repair, no write, no .bak");
      });
    });

    describe("--fix closes up when no other track reaches past the gap", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("shifts later main-track segments left cumulatively across gaps and re-lints clean", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        const main = draft.tracks.find((t) => t.type === "video");
        // 0-5s | 600ms gap at 5s | 5.6-10.6s | 400ms gap at 10.6s | 11-12s.
        // The audio bed is trimmed to end EXACTLY at the first gap's start —
        // touching content never moves, pinning the strict-inequality
        // boundary — and the subtitle track is dropped: both gaps are safe.
        main.segments[1].target_timerange.start = 5_600_000;
        main.segments.push({
          ...structuredClone(main.segments[1]),
          id: "maingap-3-aaaa-bbbb-cccc-dddddddddddd",
          target_timerange: { start: 11_000_000, duration: 1_000_000 },
          source_timerange: { start: 0, duration: 1_000_000 },
        });
        const audio = draft.tracks.find((t) => t.type === "audio");
        audio.segments[0].target_timerange.duration = 5_000_000;
        audio.segments[0].source_timerange.duration = 5_000_000;
        draft.tracks = draft.tracks.filter((t) => t.type !== "text");
        writeFileSync(fix.path, JSON.stringify(draft));

        const detect = spawnCli(["lint", fix.path, "--no-check-paths"]);
        const found = detect.json.issues.filter((i) => i.code === "main-track-gap");
        assert.equal(
          found.length,
          2,
          `expected two main-track-gap warnings; got: ${JSON.stringify(detect.json.issues)}`,
        );
        for (const g of found) {
          assert.equal(g.fixable, true, `safe close-up must be stamped fixable; got: ${JSON.stringify(g)}`);
          assert.equal(g.suggested_command, undefined, "fixable instances carry no suggested_command");
        }

        const r = spawnCli(["lint", fix.path, "--fix", "--no-check-paths"]);
        assert.equal(
          r.json.fixed.filter((i) => i.code === "main-track-gap").length,
          2,
          `expected both gaps in fixed[]; got: ${JSON.stringify(r.json.fixed)}`,
        );
        assert.equal(r.status, 0);
        assert.ok(existsSync(`${fix.path}.bak`), "the repair writes atomically with a .bak");

        const repaired = JSON.parse(readFileSync(fix.path, "utf-8"));
        const rMain = repaired.tracks.find((t) => t.type === "video");
        const starts = rMain.segments.map((s) => s.target_timerange.start).sort((a, b) => a - b);
        assert.deepEqual(starts, [0, 5_000_000, 10_000_000], "later segments close up left, shifts accumulating");
        for (const s of rMain.segments) {
          // The close-up moves starts only — durations and source trims are content.
          assert.ok(
            s.target_timerange.duration === 5_000_000 || s.target_timerange.duration === 1_000_000,
            `duration must be untouched: ${JSON.stringify(s.target_timerange)}`,
          );
        }

        const relint = spawnCli(["lint", fix.path, "--no-check-paths"]);
        assert.ok(
          !relint.json.issues.some((i) => i.code === "main-track-gap"),
          `re-lint should be clean; got: ${JSON.stringify(relint.json.issues)}`,
        );
        assert.equal(relint.status, 0);
      });
    });

    describe("per-instance stamping when only the later gap is safe", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("closes only the safe suffix and never moves segments other tracks are aligned to", () => {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        const main = draft.tracks.find((t) => t.type === "video");
        const earlierId = main.segments[0].id;
        // 0-5s | 600ms gap at 5s | 5.6-10.6s | 400ms gap at 10.6s | 11-12s,
        // with the fixture's audio (ends 10s) and subtitles (end 9.7s) kept:
        // both reach past gap 1's start but not past gap 2's, so gap 1 is
        // report-only and gap 2 closes up.
        main.segments[1].target_timerange.start = 5_600_000;
        const secondId = main.segments[1].id;
        main.segments.push({
          ...structuredClone(main.segments[1]),
          id: "mixedgap-3-aaaa-bbbb-cccc-dddddddddddd",
          target_timerange: { start: 11_000_000, duration: 1_000_000 },
          source_timerange: { start: 0, duration: 1_000_000 },
        });
        writeFileSync(fix.path, JSON.stringify(draft));

        const detect = spawnCli(["lint", fix.path, "--no-check-paths"]);
        const found = detect.json.issues.filter((i) => i.code === "main-track-gap");
        assert.equal(
          found.length,
          2,
          `expected two main-track-gap warnings; got: ${JSON.stringify(detect.json.issues)}`,
        );
        const gap1 = found.find((i) => i.location.segment_id === earlierId);
        const gap2 = found.find((i) => i.location.segment_id === secondId);
        assert.equal(gap1.fixable, false, "other tracks reach past gap 1 — report-only");
        assert.ok(gap1.suggested_command);
        assert.equal(gap2.fixable, true, "nothing reaches past gap 2 — mechanically safe");

        const r = spawnCli(["lint", fix.path, "--fix", "--no-check-paths"]);
        assert.ok(
          r.json.fixed.some((i) => i.code === "main-track-gap" && i.location.segment_id === secondId),
          `gap 2 must be fixed; got: ${JSON.stringify(r.json.fixed)}`,
        );
        assert.ok(
          r.json.issues.some(
            (i) => i.code === "main-track-gap" && i.location.segment_id === earlierId && i.fixable === false,
          ),
          "gap 1 must stay reported",
        );
        assert.equal(r.status, 1, "the surviving unsafe gap keeps exit code 1");

        const repaired = JSON.parse(readFileSync(fix.path, "utf-8"));
        const rMain = repaired.tracks.find((t) => t.type === "video");
        assert.equal(
          rMain.segments.find((s) => s.id === secondId).target_timerange.start,
          5_600_000,
          "a segment other tracks are aligned to must never move, even when the write happens for gap 2",
        );
        assert.equal(
          rMain.segments.find((s) => s.id.startsWith("mixedgap-3")).target_timerange.start,
          10_600_000,
          "the safe later gap closes by exactly its own width",
        );
      });
    });

    describe("untouched path: no gap means no mutation riding along on other writes", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("a caption-only --fix write leaves every non-text track deep-equal to the input", () => {
        // The only fixable issue lives on a text track; the written draft's
        // video and audio tracks must be exactly the input's — the new pass
        // contributes zero mutation when the rule is not in play, so drafts
        // on this path serialize byte-identically to v0.16.1's output.
        seedTextTrack(
          fix.path,
          "invariant-track",
          [textMat("invariant-mat", "Hi")],
          [
            textSeg("invar-1-aaaa-bbbb-cccc-dddddddddddd", "invariant-mat", 900_000_000, 2_000_000),
            textSeg("invar-2-aaaa-bbbb-cccc-dddddddddddd", "invariant-mat", 901_000_000, 2_000_000),
          ],
        );
        const beforeTracks = JSON.parse(readFileSync(fix.path, "utf-8")).tracks.filter((t) => t.type !== "text");

        const r = spawnCli(["lint", fix.path, "--fix", "--no-check-paths"]);
        assert.ok(
          r.json.fixed.some((i) => i.code === "caption-overlap"),
          `the caption repair must actually write; got: ${JSON.stringify(r.json.fixed)}`,
        );

        const afterTracks = JSON.parse(readFileSync(fix.path, "utf-8")).tracks.filter((t) => t.type !== "text");
        assert.deepEqual(afterTracks, beforeTracks, "non-text tracks must be untouched by a caption-only --fix");
      });
    });
  });

  describe("media-outside-draft detection + --fix stage-in", () => {
    // Media referenced outside the draft folder breaks on any move — machine
    // switch, media reorganization, or a sandboxed macOS build that cannot
    // read outside the draft: the black-screen class (sun-guannan/
    // VectCutAPI#48, #65; luoluoluo22/jianying-editor-skill#16). The rule
    // needs path checks ON, so these tests never pass --no-check-paths;
    // --no-probe keeps ffprobe noise off the dummy media files.

    // Point the fixture's three media materials (videos[0], videos[1],
    // audios[0]) at controlled locations; returns videos[0]'s material id.
    function setMediaPaths(draftPath, [video0, video1, audio0]) {
      const draft = JSON.parse(readFileSync(draftPath, "utf-8"));
      draft.materials.videos[0].path = video0;
      draft.materials.videos[1].path = video1;
      draft.materials.audios[0].path = audio0;
      writeFileSync(draftPath, JSON.stringify(draft));
      return draft.materials.videos[0].id;
    }

    // Two existing files the shared setup keeps inside the draft folder —
    // at its ROOT, deliberately: "inside" means anywhere under the folder,
    // not only assets/, so a clean run must never create assets/ either.
    function seedInsideMedia(dir) {
      const video = join(dir, "inside-b.mp4");
      const audio = join(dir, "inside-bed.mp3");
      writeFileSync(video, "inside video bytes");
      writeFileSync(audio, "inside audio bytes");
      return [video, audio];
    }

    describe("detection", () => {
      const fix = tmpDraft();
      const ext = tmpDir();
      after(() => {
        fix.cleanup();
        ext.cleanup();
      });

      it("flags external media as info (exit stays 0), fixable when the source exists, and copies nothing", () => {
        const externalPath = join(ext.dir, "clip-a.mp4");
        writeFileSync(externalPath, "external clip bytes");
        const [insideVideo, insideAudio] = seedInsideMedia(fix.dir);
        const video0Id = setMediaPaths(fix.path, [externalPath, insideVideo, insideAudio]);
        const before = readFileSync(fix.path, "utf-8");

        const r = spawnCli(["lint", fix.path, "--no-probe"]);
        const found = r.json.issues.filter((i) => i.code === "media-outside-draft");
        assert.equal(found.length, 1, `expected one media-outside-draft; got: ${JSON.stringify(r.json.issues)}`);
        assert.equal(found[0].severity, "info", "external media is a deliberate choice on a huge installed base");
        assert.equal(found[0].fixable, true, "the source exists, so --fix can stage it");
        assert.equal(found[0].suggested_command, undefined, "fixable instances carry no suggested_command");
        assert.equal(found[0].location.material_id, video0Id);
        assert.equal(found[0].location.path, externalPath);
        assert.equal(r.json.summary.info, 1);
        assert.equal(r.status, 0, "info-severity findings never flip the exit code");

        assert.equal(readFileSync(fix.path, "utf-8"), before, "detection must not write the draft");
        assert.ok(!existsSync(join(fix.dir, "assets")), "detection without --fix must not stage anything");
      });
    });

    describe("--fix stages the file in", () => {
      const fix = tmpDraft();
      const ext = tmpDir();
      after(() => {
        fix.cleanup();
        ext.cleanup();
      });

      it("copies the file into assets/video/, rewrites the material path, and re-lints clean", () => {
        const externalPath = join(ext.dir, "clip-a.mp4");
        writeFileSync(externalPath, "external clip bytes");
        const [insideVideo, insideAudio] = seedInsideMedia(fix.dir);
        setMediaPaths(fix.path, [externalPath, insideVideo, insideAudio]);

        const r = spawnCli(["lint", fix.path, "--fix", "--no-probe"]);
        assert.ok(
          r.json.fixed.some((i) => i.code === "media-outside-draft"),
          `the stage-in must be reported FIXED; got: ${JSON.stringify(r.json.fixed)}`,
        );
        assert.equal(r.status, 0);

        const staged = join(fix.dir, "assets", "video", "clip-a.mp4");
        assert.ok(existsSync(staged), "the file must actually be copied into assets/video/");
        assert.equal(readFileSync(staged, "utf-8"), "external clip bytes");
        assert.ok(existsSync(externalPath), "stage-in copies — the external original stays where it was");
        assert.ok(existsSync(`${fix.path}.bak`), "the repair writes atomically with a .bak");

        const repaired = JSON.parse(readFileSync(fix.path, "utf-8"));
        assert.equal(repaired.materials.videos[0].path, staged, "the material path points at the staged copy");

        const relint = spawnCli(["lint", fix.path, "--no-probe"]);
        assert.ok(
          !relint.json.issues.some((i) => i.code === "media-outside-draft"),
          `re-lint should be clean; got: ${JSON.stringify(relint.json.issues)}`,
        );
        assert.equal(relint.status, 0);
      });
    });

    describe("--fix de-collides a basename collision by content hash", () => {
      const fix = tmpDraft();
      const ext = tmpDir();
      after(() => {
        fix.cleanup();
        ext.cleanup();
      });

      it("stages under <stem>.<sha1-8><ext> and leaves the existing asset untouched", () => {
        const externalPath = join(ext.dir, "clip.mp4");
        writeFileSync(externalPath, "external content A");
        // A different file already sits at assets/video/clip.mp4 — silently
        // skipping the copy would leave the draft on the wrong content.
        mkdirSync(join(fix.dir, "assets", "video"), { recursive: true });
        writeFileSync(join(fix.dir, "assets", "video", "clip.mp4"), "different content B");
        const [insideVideo, insideAudio] = seedInsideMedia(fix.dir);
        setMediaPaths(fix.path, [externalPath, insideVideo, insideAudio]);

        const r = spawnCli(["lint", fix.path, "--fix", "--no-probe"]);
        assert.ok(
          r.json.fixed.some((i) => i.code === "media-outside-draft"),
          `the stage-in must be reported FIXED; got: ${JSON.stringify(r.json.fixed)}`,
        );

        const hash8 = createHash("sha1").update("external content A").digest("hex").slice(0, 8);
        const staged = join(fix.dir, "assets", "video", `clip.${hash8}.mp4`);
        assert.ok(existsSync(staged), `expected the de-collided copy at ${staged}`);
        assert.equal(readFileSync(staged, "utf-8"), "external content A");
        assert.equal(
          readFileSync(join(fix.dir, "assets", "video", "clip.mp4"), "utf-8"),
          "different content B",
          "the colliding asset keeps its own content",
        );
        const repaired = JSON.parse(readFileSync(fix.path, "utf-8"));
        assert.equal(repaired.materials.videos[0].path, staged, "the draft references the de-collided copy");
      });
    });

    describe("missing source stays report-only", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("stamps fixable:false + relink suggested_command, and --fix leaves the file byte-identical", () => {
        const [insideVideo] = seedInsideMedia(fix.dir);
        // One gone POSIX path, one gone Windows path — wrong-OS absolute
        // paths are judged (and flagged) like native ones.
        setMediaPaths(fix.path, ["/nonexistent-external/clip-gone.mp4", insideVideo, "C:\\Users\\gone\\bed.mp3"]);

        const detect = spawnCli(["lint", fix.path, "--no-probe"]);
        const found = detect.json.issues.filter((i) => i.code === "media-outside-draft");
        assert.equal(found.length, 2, `expected two media-outside-draft; got: ${JSON.stringify(detect.json.issues)}`);
        for (const i of found) {
          assert.equal(i.fixable, false, "nothing on disk to stage — must not be stamped fixable");
          assert.match(i.suggested_command, /relink/, "report-only instances name the deliberate repair");
        }
        assert.equal(
          detect.json.issues.filter((i) => i.code === "missing-file").length,
          2,
          "the missing-file error still fires independently",
        );
        assert.equal(detect.status, 2);

        const before = readFileSync(fix.path, "utf-8");
        const r = spawnCli(["lint", fix.path, "--fix", "--no-probe"]);
        assert.ok(
          !r.json.fixed.some((i) => i.code === "media-outside-draft"),
          `must not claim FIXED; got: ${JSON.stringify(r.json.fixed)}`,
        );
        assert.equal(readFileSync(fix.path, "utf-8"), before, "--fix must not rewrite a draft it didn't repair");
        assert.ok(!existsSync(`${fix.path}.bak`), "no repair, no write, no .bak");
        assert.ok(!existsSync(join(fix.dir, "assets")), "nothing may be staged for a missing source");
      });
    });

    describe("wrong-OS separators count as inside", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("a rename-style mixed-separator path under the draft folder is never flagged as outside", () => {
        const [insideVideo] = seedInsideMedia(fix.dir);
        // The shape rename's tail-preserving prefix rewrite produces for a
        // Windows-authored draft moved here: native folder + backslash tail.
        // The containment verdict is what this test guards, and it must hold on
        // every OS: the media IS inside the draft folder, whatever the
        // separators. Readability is not — a backslash is a real separator on
        // Windows (the path resolves to the seeded file) and one odd filename
        // on POSIX (nothing there), so missing-file is platform-dependent.
        const mixed = `${fix.dir}\\inside-bed.mp3`;
        setMediaPaths(fix.path, [insideVideo, insideVideo, mixed]);

        const r = spawnCli(["lint", fix.path, "--no-probe"]);
        assert.ok(
          !r.json.issues.some((i) => i.code === "media-outside-draft"),
          `inside media must not flag, whatever the separators; got: ${JSON.stringify(r.json.issues)}`,
        );
        const missing = r.json.issues.some((i) => i.code === "missing-file" && i.location?.path === mixed);
        if (process.platform === "win32") {
          assert.ok(!missing, "a mixed-separator path resolves on Windows, so no missing-file");
        } else {
          assert.ok(missing, "the unreadable mixed-separator path stays a missing-file error");
          assert.equal(r.status, 2);
        }
      });
    });

    describe("--fix --dry-run previews without side effects", () => {
      const fix = tmpDraft();
      const ext = tmpDir();
      after(() => {
        fix.cleanup();
        ext.cleanup();
      });

      it("copies nothing, writes nothing, and keeps the issue reported as fixable", () => {
        const externalPath = join(ext.dir, "clip-a.mp4");
        writeFileSync(externalPath, "external clip bytes");
        const [insideVideo, insideAudio] = seedInsideMedia(fix.dir);
        setMediaPaths(fix.path, [externalPath, insideVideo, insideAudio]);
        const before = readFileSync(fix.path, "utf-8");

        const r = spawnCli(["lint", fix.path, "--fix", "--dry-run", "--no-probe"]);
        assert.ok(
          !r.json.fixed.some((i) => i.code === "media-outside-draft"),
          "a file copy cannot be rolled back, so dry-run must not perform or claim it",
        );
        assert.ok(
          r.json.issues.some((i) => i.code === "media-outside-draft" && i.fixable === true),
          `the issue stays reported, still stamped fixable; got: ${JSON.stringify(r.json.issues)}`,
        );
        assert.equal(readFileSync(fix.path, "utf-8"), before, "dry-run writes nothing");
        assert.ok(!existsSync(join(fix.dir, "assets")), "dry-run must not stage anything");
      });
    });

    describe("untouched path: media already inside the draft stays byte-identical", () => {
      const fix = tmpDraft();
      after(() => fix.cleanup());

      it("lint --fix on an all-inside draft writes nothing", () => {
        const [insideVideo, insideAudio] = seedInsideMedia(fix.dir);
        setMediaPaths(fix.path, [insideVideo, insideVideo, insideAudio]);
        const before = readFileSync(fix.path, "utf-8");

        const r = spawnCli(["lint", fix.path, "--fix", "--no-probe"]);
        assert.equal(r.json.fixed.length, 0, `nothing to fix; got: ${JSON.stringify(r.json.fixed)}`);
        assert.ok(!r.json.issues.some((i) => i.code === "media-outside-draft"));
        assert.equal(r.status, 0);
        assert.equal(
          readFileSync(fix.path, "utf-8"),
          before,
          "with the rule not in play the written draft must stay byte-identical",
        );
        assert.ok(!existsSync(`${fix.path}.bak`), "no repair, no write, no .bak");
      });
    });
  });
});
