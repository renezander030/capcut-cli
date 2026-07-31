import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { knownEffectIds } from "../dist/lint.js";
import {
  allUserEnumIds,
  clearUserEnumsCache,
  harvestDraft,
  mergeUserEnums,
  slugify,
  userEntriesForCategory,
} from "../dist/user-enums.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function draftWithUnknowns() {
  return {
    id: "d1",
    name: "harvest-me",
    duration: 1_000_000,
    fps: 30,
    canvas_config: { width: 1080, height: 1920, ratio: "9:16" },
    tracks: [],
    materials: {
      videos: [],
      audios: [],
      texts: [
        { id: "t1", type: "text", content: "{}", font_size: 15, text_color: "#fff", alignment: 1, font_id: "FONT-9" },
      ],
      speeds: [],
      material_animations: [
        { id: "ma1", animations: [{ id: "ANIM-1", name: "Fancy In", type: "in", resource_id: "ANIM-R1" }] },
      ],
      audio_fades: [],
      transitions: [],
      video_effects: [
        { id: "fx1", name: "Snowfly", type: "video_effect", effect_id: "EFF-777", resource_id: "RES-777" },
      ],
      filters: [
        { id: "fl1", name: "Cool Tone", type: "filter", effect_id: "EFF-888", resource_id: "RES-888" },
        { id: "bb1", name: "Bubble X", type: "text_shape", effect_id: "EFF-999", resource_id: "RES-999" },
      ],
    },
  };
}

describe("harvest-enums", () => {
  describe("harvestDraft", () => {
    it("collects unknown ids with kind mapping, counts known ids, slugifies names", () => {
      const known = new Set(["EFF-888", "RES-888"]);
      const { found, known: knownCount, candidates } = harvestDraft(draftWithUnknowns(), known);
      assert.equal(found, 5, "effect + filter + bubble + animation + font id");
      assert.equal(knownCount, 1, "the filter's ids are known");
      const byKind = Object.fromEntries(candidates.map((c) => [c.kind, c]));
      assert.equal(byKind.video_effects.slug, "snowfly");
      assert.equal(byKind.video_effects.effect_id, "EFF-777");
      assert.equal(byKind.bubbles.slug, "", "bubbles never become writable filter slugs");
      assert.equal(byKind.animations.slug, "", "ambiguous animation kinds stay id-only");
      assert.equal(byKind.fonts.resource_id, "FONT-9");
      assert.equal(byKind.video_effects.harvested_from, "harvest-me");
    });

    it("slugify is ascii-kebab and empty for non-ascii names", () => {
      assert.equal(slugify("Snow Fly!"), "snow-fly");
      assert.equal(slugify("胶片颗粒"), "");
    });
  });

  describe("mergeUserEnums + lookups", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-harvest-"));
    const catalogue = join(dir, "user-enums.json");
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("writes the catalogue, dedupes on re-merge, and feeds the lookups", () => {
      const { candidates } = harvestDraft(draftWithUnknowns(), new Set());
      const first = mergeUserEnums(catalogue, candidates);
      assert.equal(first.added, candidates.length);
      assert.ok(existsSync(catalogue));

      const again = mergeUserEnums(catalogue, candidates);
      assert.equal(again.added, 0);
      assert.equal(again.duplicates, candidates.length);

      clearUserEnumsCache();
      const sceneEntries = userEntriesForCategory("scene_effects", catalogue);
      assert.ok(sceneEntries.some((e) => e.slug === "snowfly" && e.effect_id === "EFF-777"));
      const filterEntries = userEntriesForCategory("filters", catalogue);
      assert.ok(filterEntries.some((e) => e.slug === "cool-tone"));
      assert.ok(!filterEntries.some((e) => e.name === "Bubble X"), "bubbles must not leak into filters");

      const ids = allUserEnumIds(catalogue);
      for (const id of ["EFF-777", "RES-777", "ANIM-R1", "FONT-9", "EFF-999"]) {
        assert.ok(ids.has(id), `id ${id} must be known after harvest`);
      }
    });
  });

  describe("command (e2e)", () => {
    it("plan -> apply -> lint noise gone -> harvested slug is writable", () => {
      const fix = tmpDraft();
      const dir = mkdtempSync(join(tmpdir(), "capcut-harvest-e2e-"));
      const catalogue = join(dir, "user-enums.json");
      const env = { CAPCUT_CLI_USER_ENUMS: catalogue };
      try {
        const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
        draft.materials.video_effects = [
          { id: "fx1", name: "Snowfly", type: "video_effect", effect_id: "EFF-777", resource_id: "RES-777" },
        ];
        writeFileSync(fix.path, JSON.stringify(draft));

        const before = spawnCli(["lint", fix.path], { env });
        assert.ok(
          (before.json.issues ?? []).some((i) => i.code === "unknown-effect-slug" && /Snowfly/.test(i.message)),
          `expected the unknown effect to flag before harvest; got ${JSON.stringify(before.json.issues)}`,
        );

        const plan = spawnCli(["harvest-enums", fix.path], { env });
        assert.equal(plan.status, 0, `stderr: ${plan.stderr}`);
        assert.equal(plan.json.applied, false);
        assert.ok(plan.json.new.some((e) => e.slug === "snowfly"));
        assert.ok(!existsSync(catalogue), "plan must not write");

        const apply = spawnCli(["harvest-enums", fix.path, "--apply"], { env });
        assert.equal(apply.status, 0, `stderr: ${apply.stderr}`);
        assert.ok(apply.json.added >= 1);
        assert.ok(existsSync(catalogue));

        const afterLint = spawnCli(["lint", fix.path], { env });
        assert.ok(
          !(afterLint.json.issues ?? []).some((i) => i.code === "unknown-effect-slug" && /Snowfly/.test(i.message)),
          `harvested id must not flag; got ${JSON.stringify(afterLint.json.issues)}`,
        );

        const rerun = spawnCli(["harvest-enums", fix.path, "--apply"], { env });
        assert.equal(rerun.status, 0);
        assert.equal(rerun.json.added, 0, "re-run must be idempotent");

        const applied = spawnCli(["add-effect", fix.path, "snowfly", "0", "1s"], { env });
        assert.equal(applied.status, 0, `harvested slug must resolve in add-effect; stderr: ${applied.stderr}`);
      } finally {
        fix.cleanup();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("refuses --apply over a catalogue that does not parse", () => {
      const fix = tmpDraft();
      const dir = mkdtempSync(join(tmpdir(), "capcut-harvest-broken-"));
      const catalogue = join(dir, "user-enums.json");
      try {
        writeFileSync(catalogue, "{ not json");
        const r = spawnCli(["harvest-enums", fix.path, "--apply"], { env: { CAPCUT_CLI_USER_ENUMS: catalogue } });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /did not parse/);
        assert.equal(readFileSync(catalogue, "utf-8"), "{ not json", "the broken file must stay untouched");
      } finally {
        fix.cleanup();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
