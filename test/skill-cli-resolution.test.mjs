import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpDraft } from "./helpers/tmp-draft.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, "..", "skills", "capcut-edit", "scripts");
const KEN_BURNS = join(SCRIPTS, "ken-burns.sh");

const SEG = "aaaaaa01";

// ken-burns.sh <project> <segment> <start-scale> <end-scale> <tx-start>
//              <ty-start> <tx-end> <ty-end> [duration] [easing]
const KEN_BURNS_ARGS = (draftPath) => [KEN_BURNS, draftPath, SEG, "1.0", "1.2", "0", "-0.1", "0", "-0.05", "3s"];

function runKenBurns(draftPath, env) {
  return spawnSync("bash", KEN_BURNS_ARGS(draftPath), {
    encoding: "utf-8",
    // Isolate the app-version tripwire state, as test/keyframe-easing.test.mjs does.
    env: { ...process.env, ...env },
  });
}

/** A stand-in for the CLI that reports the argv it was invoked with. */
function stubCli(dir) {
  const stub = join(dir, "stub-cli.mjs");
  writeFileSync(stub, "console.log(JSON.stringify({ ok: true, stub_argv: process.argv.slice(2) }));\n", "utf-8");
  return stub;
}

describe("skill scripts: CLI resolution", () => {
  it("uses $CAPCUT_CLI when it points at an existing entry", () => {
    const fix = tmpDraft();
    const tmp = tmpDir();
    after(() => {
      fix.cleanup();
      tmp.cleanup();
    });
    const r = runKenBurns(fix.path, { CAPCUT_CLI: stubCli(tmp.dir), CAPCUT_CLI_APP_VERSIONS: join(tmp.dir, "v.json") });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!/capcut CLI not found/.test(r.stderr), `unexpected resolution failure: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(out.ok, true);
    assert.deepEqual(out.stub_argv.slice(0, 2), ["keyframe", fix.path]);
  });

  it("falls through to the repo build when $CAPCUT_CLI does not exist", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const r = runKenBurns(fix.path, { CAPCUT_CLI: join(fix.dir, "does-not-exist.js") });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!/capcut CLI not found/.test(r.stderr));
    // The real CLI wrote the keyframes.
    const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
    const seg = draft.tracks.flatMap((t) => t.segments).find((s) => s.id.startsWith(SEG));
    assert.ok((seg.common_keyframes ?? []).length > 0, "expected keyframes on the segment");
  });

  it("keeps the repo-relative build working with no override at all", () => {
    const fix = tmpDraft();
    const tmp = tmpDir();
    after(() => {
      fix.cleanup();
      tmp.cleanup();
    });
    const env = { ...process.env, CAPCUT_CLI_APP_VERSIONS: join(tmp.dir, "v.json") };
    delete env.CAPCUT_CLI;
    const r = runKenBurns(fix.path, env);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!/capcut CLI not found/.test(r.stderr));
  });
});
