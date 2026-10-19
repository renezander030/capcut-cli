import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpDir, tmpDraft } from "./helpers/tmp-draft.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL = join(__dirname, "..", "skills", "capcut-edit");
const SCRIPTS = join(SKILL, "scripts");
const KEN_BURNS = join(SCRIPTS, "ken-burns.sh");

const SEG = "aaaaaa01";

// ken-burns.sh <project> <segment> <start-scale> <end-scale> <tx-start>
//              <ty-start> <tx-end> <ty-end> [duration] [easing]
const KEN_BURNS_ARGS = (draftPath, script = KEN_BURNS) => [
  script,
  draftPath,
  SEG,
  "1.0",
  "1.2",
  "0",
  "-0.1",
  "0",
  "-0.05",
  "3s",
];

function runKenBurns(draftPath, env, script = KEN_BURNS) {
  return spawnSync("bash", KEN_BURNS_ARGS(draftPath, script), {
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

/**
 * A shell launcher, like the shim a global install puts on PATH. node cannot
 * execute it, so a script that runs `node <launcher>` fails on it.
 */
function stubLauncher(dir, name, stub) {
  const launcher = join(dir, name);
  writeFileSync(launcher, `#!/usr/bin/env bash\nexec node ${JSON.stringify(stub)} "$@"\n`, "utf-8");
  chmodSync(launcher, 0o755);
  return launcher;
}

/** Copies the skill out of the checkout, so the repo-relative build is absent. */
function copySkillOutside(dir) {
  const skill = join(dir, "skills", "capcut-edit");
  cpSync(SKILL, skill, { recursive: true });
  return join(skill, "scripts", "ken-burns.sh");
}

/** An env with no $CAPCUT_CLI whose PATH starts with `dirs`. */
function envWithPath(dirs, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CAPCUT_CLI;
  // A plain object loses process.env's case-insensitive lookup on Windows.
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = [...dirs, env[pathKey] ?? ""].join(delimiter);
  return env;
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
    assert.equal(r.status, 0, r.error?.message ?? `stderr: ${r.stderr}`);
    assert.ok(!/capcut CLI not found/.test(r.stderr), `unexpected resolution failure: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.equal(out.ok, true);
    assert.deepEqual(out.stub_argv.slice(0, 2), ["keyframe", fix.path]);
  });

  it("falls through to the repo build when $CAPCUT_CLI does not exist", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const r = runKenBurns(fix.path, { CAPCUT_CLI: join(fix.dir, "does-not-exist.js") });
    assert.equal(r.status, 0, r.error?.message ?? `stderr: ${r.stderr}`);
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
    assert.equal(r.status, 0, r.error?.message ?? `stderr: ${r.stderr}`);
    assert.ok(!/capcut CLI not found/.test(r.stderr));
  });

  it("runs a launcher found on PATH directly when the skill sits outside a checkout", () => {
    const fix = tmpDraft();
    const tmp = tmpDir();
    after(() => {
      fix.cleanup();
      tmp.cleanup();
    });
    const bin = join(tmp.dir, "bin");
    mkdirSync(bin);
    stubLauncher(bin, "capcut-cli", stubCli(tmp.dir));
    const script = copySkillOutside(tmp.dir);
    const r = spawnSync("bash", KEN_BURNS_ARGS(fix.path, script), { encoding: "utf-8", env: envWithPath([bin]) });
    assert.equal(r.status, 0, r.error?.message ?? `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.deepEqual(out.stub_argv.slice(0, 2), ["keyframe", fix.path]);
  });

  it("runs $CAPCUT_CLI directly when it points at a launcher", () => {
    const fix = tmpDraft();
    const tmp = tmpDir();
    after(() => {
      fix.cleanup();
      tmp.cleanup();
    });
    const launcher = stubLauncher(tmp.dir, "capcut", stubCli(tmp.dir));
    const r = runKenBurns(fix.path, { CAPCUT_CLI: launcher }, copySkillOutside(tmp.dir));
    assert.equal(r.status, 0, r.error?.message ?? `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.deepEqual(out.stub_argv.slice(0, 2), ["keyframe", fix.path]);
  });

  it("runs an installed node_modules/capcut-cli entry under node outside a checkout", () => {
    const fix = tmpDraft();
    const tmp = tmpDir();
    after(() => {
      fix.cleanup();
      tmp.cleanup();
    });
    const dist = join(tmp.dir, "node_modules", "capcut-cli", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.js"), readFileSync(stubCli(tmp.dir)));
    const r = runKenBurns(fix.path, envWithPath([]), copySkillOutside(tmp.dir));
    assert.equal(r.status, 0, r.error?.message ?? `stderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    assert.deepEqual(out.stub_argv.slice(0, 2), ["keyframe", fix.path]);
  });
});
