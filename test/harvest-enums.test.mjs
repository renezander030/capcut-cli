import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
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

  describe("--sync (library sweep)", () => {
    const fix = tmpDraft();
    const lib = mkdtempSync(join(tmpdir(), "capcut-harvest-lib-"));
    const dir = mkdtempSync(join(tmpdir(), "capcut-harvest-sync-"));
    const catalogue = join(dir, "user-enums.json");
    const env = { CAPCUT_CLI_USER_ENUMS: catalogue };
    after(() => {
      fix.cleanup();
      rmSync(lib, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    });

    const base = JSON.parse(readFileSync(fix.path, "utf-8"));
    const project = (name, mutate) => {
      const draft = structuredClone(base);
      mutate(draft);
      mkdirSync(join(lib, name), { recursive: true });
      writeFileSync(join(lib, name, "draft_content.json"), JSON.stringify(draft));
    };
    project("alpha", (d) => {
      d.materials.video_effects = [
        { id: "fx1", name: "Snow A", type: "video_effect", effect_id: "SYNC-EFF-A", resource_id: "SYNC-RES-A" },
      ];
    });
    project("beta", (d) => {
      // SYNC-EFF-A repeats here: the sweep must merge it to ONE entry.
      d.materials.video_effects = [
        { id: "fx2", name: "Snow A", type: "video_effect", effect_id: "SYNC-EFF-A", resource_id: "SYNC-RES-A" },
      ];
      d.materials.filters = [
        { id: "fl1", name: "Cool B", type: "filter", effect_id: "SYNC-EFF-B", resource_id: "SYNC-RES-B" },
      ];
    });
    mkdirSync(join(lib, "broken"));
    writeFileSync(join(lib, "broken", "draft_content.json"), "{ not json");
    mkdirSync(join(lib, "not-a-draft")); // no draft file: ignored, not counted as skipped

    it("plan sweeps every draft, skips the broken one with a note, writes nothing", () => {
      const r = spawnCli(["harvest-enums", "--sync", "--drafts", lib], { env });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.applied, false);
      assert.equal(r.json.drafts_scanned, 2);
      assert.equal(r.json.drafts_skipped.length, 1);
      assert.equal(r.json.drafts_skipped[0].draft, "broken");
      assert.match(r.stderr, /skipped broken: /);
      assert.ok(r.json.new.some((e) => e.slug === "snow-a" && e.effect_id === "SYNC-EFF-A"));
      assert.ok(r.json.new.some((e) => e.slug === "cool-b"));
      assert.equal(
        r.json.new.filter((e) => e.effect_id === "SYNC-EFF-A").length,
        1,
        "an id used by two drafts must merge to one entry",
      );
      assert.ok(!existsSync(catalogue), "plan must not write");
    });

    it("--apply --dry-run previews the merged write without writing", () => {
      const r = spawnCli(["harvest-enums", "--sync", "--apply", "--dry-run", "--drafts", lib], { env });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.json.applied, false);
      assert.ok(r.json.would_add >= 2);
      assert.ok(!existsSync(catalogue), "dry run must not write");
    });

    it("--apply merges the sweep in one write, and a re-sync adds nothing", () => {
      const apply = spawnCli(["harvest-enums", "--sync", "--apply", "--drafts", lib], { env });
      assert.equal(apply.status, 0, `stderr: ${apply.stderr}`);
      assert.equal(apply.json.applied, true);
      assert.ok(apply.json.added >= 2);
      assert.ok(apply.json.new_by_kind.video_effects >= 1);
      assert.ok(apply.json.new_by_kind.filters >= 1);
      assert.ok(existsSync(catalogue));

      const again = spawnCli(["harvest-enums", "--sync", "--apply", "--drafts", lib], { env });
      assert.equal(again.status, 0, `stderr: ${again.stderr}`);
      assert.equal(again.json.added, 0, "re-sync must be idempotent");
      assert.equal(again.json.new.length, 0);
      assert.equal(again.json.drafts_scanned, 2);
    });
  });

  describe("--add (manual entry, witness draft gone)", () => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-harvest-add-"));
    const catalogue = join(dir, "user-enums.json");
    const env = { CAPCUT_CLI_USER_ENUMS: catalogue };
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("plans, applies with the harvested entry shape, and makes the slug writable", () => {
      const args = ["harvest-enums", "--add", "video_effects", "snowfly", "MAN-RES-1", "--effect-id", "MAN-EFF-1"];
      const plan = spawnCli(args, { env });
      assert.equal(plan.status, 0, `stderr: ${plan.stderr}`);
      assert.equal(plan.json.applied, false);
      assert.equal(plan.json.entry.slug, "snowfly");
      assert.ok(!existsSync(catalogue), "plan must not write");

      const apply = spawnCli([...args, "--apply"], { env });
      assert.equal(apply.status, 0, `stderr: ${apply.stderr}`);
      assert.equal(apply.json.added, 1);
      const stored = JSON.parse(readFileSync(catalogue, "utf-8")).entries.at(-1);
      assert.equal(stored.kind, "video_effects");
      assert.equal(stored.slug, "snowfly");
      assert.equal(stored.effect_id, "MAN-EFF-1");
      assert.equal(stored.resource_id, "MAN-RES-1");
      assert.ok(stored.harvested_at, "manual entries carry the same stamp as harvested ones");

      const fix = tmpDraft();
      try {
        const applied = spawnCli(["add-effect", fix.path, "snowfly", "0", "1s"], { env });
        assert.equal(applied.status, 0, `manual slug must resolve in add-effect; stderr: ${applied.stderr}`);
      } finally {
        fix.cleanup();
      }
    });

    it("refuses a duplicate id, naming the entry that already owns it", () => {
      const r = spawnCli(["harvest-enums", "--add", "filters", "other-slug", "MAN-RES-1", "--apply"], { env });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /already registered to video_effects\/snowfly/);
      const entries = JSON.parse(readFileSync(catalogue, "utf-8")).entries;
      assert.equal(entries.filter((e) => e.resource_id === "MAN-RES-1").length, 1, "never merged over");
    });

    it("refuses an unknown kind, listing the writable ones", () => {
      const r = spawnCli(["harvest-enums", "--add", "sparkles", "foo", "MAN-RES-2"], { env });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Unknown kind \\"sparkles\\"/);
      assert.match(r.stderr, /video_effects, filters, transitions, masks, audio_effects/);
    });

    it("refuses ambiguous kinds with the exclusion rationale", () => {
      const r = spawnCli(["harvest-enums", "--add", "animations", "fancy-in", "MAN-RES-3"], { env });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /id-only/);
      assert.match(r.stderr, /cannot be told apart/);
    });

    it("refuses a slug that does not slugify clean, suggesting the clean form", () => {
      const r = spawnCli(["harvest-enums", "--add", "filters", "Cool Tone", "MAN-RES-4"], { env });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Use \\"cool-tone\\"/);
    });
  });
});
