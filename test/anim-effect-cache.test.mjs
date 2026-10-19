import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpDraft } from "./helpers/tmp-draft.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL = join(__dirname, "..", "skills", "capcut-edit");
const ANIM = join(SKILL, "scripts", "anim.sh");
const CATALOGUE = join(SKILL, "assets", "animations.json");

const SEG = "aaaaaa01";

function runAnim(draftPath, cacheDir) {
  return spawnSync("bash", [ANIM, draftPath, SEG, "fade-in"], {
    encoding: "utf-8",
    env: { ...process.env, CAPCUT_EFFECT_CACHE: cacheDir },
  });
}

/** The effect `path` anim.sh wrote into the animation material. */
function writtenEffectPath(draftPath) {
  const draft = JSON.parse(readFileSync(draftPath, "utf-8"));
  const anims = draft.materials.material_animations ?? [];
  assert.equal(anims.length, 1, "one animation material should have been added");
  return anims[0].animations[0].path;
}

describe("anim.sh effect cache base", () => {
  it("honours CAPCUT_EFFECT_CACHE and writes a resolvable effect path", () => {
    const fix = tmpDraft();
    const cache = tmpDir();
    after(() => {
      fix.cleanup();
      cache.cleanup();
    });

    const r = runAnim(fix.path, cache.dir);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const spec = JSON.parse(readFileSync(CATALOGUE, "utf-8"))["fade-in"];
    assert.equal(writtenEffectPath(fix.path), join(cache.dir, spec.effect_id, spec.md5));
  });

  it("does not hardcode the macOS container path on Windows", () => {
    if (process.platform !== "win32") return;
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const r = spawnSync("bash", [ANIM, fix.path, SEG, "fade-in"], { encoding: "utf-8" });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const written = writtenEffectPath(fix.path);
    assert.ok(!written.includes("Library/Containers"), `effect path still points at the macOS container: ${written}`);
    assert.match(written, /Cache[\\/]effect/, `expected a Windows cache base, got ${written}`);
  });
});
