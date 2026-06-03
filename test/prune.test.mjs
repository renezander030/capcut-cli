import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// `prune` removes only materials no segment references — and must NOT delete
// materials referenced indirectly via extra_material_refs.
describe("prune (#17)", () => {
  it("removes orphans, keeps directly- and indirectly-referenced materials", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const d = JSON.parse(readFileSync(fix.path, "utf-8"));
    d.materials.texts.push({ id: "ORPHAN_TEXT" }); // referenced by nobody
    d.materials.stickers = [{ id: "REFD_VIA_EXTRA" }]; // referenced only via extra_material_refs
    d.tracks[0].segments[0].extra_material_refs.push("REFD_VIA_EXTRA");
    const directId = d.tracks[0].segments[0].material_id; // referenced via material_id
    writeFileSync(fix.path, JSON.stringify(d, null, 2));

    const r = spawnCli(["prune", fix.path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(r.json.removed, 1, "exactly the one orphan should be removed");

    const after_ = JSON.parse(readFileSync(fix.path, "utf-8"));
    assert.ok(!after_.materials.texts.some((m) => m.id === "ORPHAN_TEXT"), "orphan must be gone");
    assert.ok(
      after_.materials.stickers.some((m) => m.id === "REFD_VIA_EXTRA"),
      "extra_material_refs target must survive",
    );
    assert.ok(
      Object.values(after_.materials)
        .flat()
        .some((m) => m && m.id === directId),
      "material_id-referenced material must survive",
    );
    // segments untouched
    assert.deepEqual(after_.tracks[0].segments.length, d.tracks[0].segments.length);
  });

  it("honors --dry-run (reports removals, writes nothing)", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const d = JSON.parse(readFileSync(fix.path, "utf-8"));
    d.materials.texts.push({ id: "ORPHAN_X" });
    writeFileSync(fix.path, JSON.stringify(d, null, 2));
    const before = readFileSync(fix.path, "utf-8");

    const r = spawnCli(["prune", fix.path, "--dry-run"]);
    assert.equal(r.status, 0);
    assert.equal(r.json.removed, 1);
    assert.equal(r.json.dryRun, true);
    assert.equal(readFileSync(fix.path, "utf-8"), before, "dry-run must not change the file");
  });
});
