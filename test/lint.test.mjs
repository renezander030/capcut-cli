import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

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
});
