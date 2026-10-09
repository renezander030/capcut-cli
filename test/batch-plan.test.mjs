import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

function firstText(path) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  return draft.tracks.find((item) => item.type === "text").segments[0].id;
}

function setup() {
  const fix = tmpDraft();
  after(fix.cleanup);
  const id = firstText(fix.path);
  const planPath = join(fix.dir, "plan.json");
  const input = [
    JSON.stringify({ cmd: "set-text", id, text: "planned" }),
    JSON.stringify({ cmd: "shift", id, offset: "+1s" }),
  ].join("\n");
  return { fix, id, planPath, input };
}

describe("batch --plan / --apply-plan", () => {
  it("--plan writes a plan and leaves the draft untouched", () => {
    const { fix, planPath, input } = setup();
    const before = readFileSync(fix.path, "utf-8");
    const result = spawnCli(["batch", fix.path, "--plan", planPath], { input });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.operations, 2);
    assert.equal(readFileSync(fix.path, "utf-8"), before);
    assert.equal(existsSync(`${fix.path}.bak`), false);
    assert.equal(existsSync(join(fix.dir, ".capcut-cli-history")), false);

    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    assert.equal(plan.format, "capcut-cli.batch-plan");
    assert.equal(plan.version, 1);
    assert.equal(plan.project, fix.path);
    assert.equal(plan.draft_sha256, createHash("sha256").update(before).digest("hex"));
    assert.equal(plan.operations.length, 2);
    assert.match(plan.operations_sha256, /^[0-9a-f]{64}$/);
    assert.equal(plan.preview.length, 2);
    assert.equal(plan.preview[0].cmd, "set-text");
    assert.equal(plan.preview[0].result.new, "planned");
    assert.equal(plan.preview[1].result.new_start_us - plan.preview[1].result.old_start_us, 1_000_000);
  });

  it("--plan refuses invalid operations and writes no plan", () => {
    const { fix, planPath } = setup();
    const input = JSON.stringify({ cmd: "shift", id: "missing-segment", offset: "+1s" });
    const result = spawnCli(["batch", fix.path, "--plan", planPath], { input });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no plan written/);
    assert.equal(existsSync(planPath), false);
  });

  it("--apply-plan applies the reviewed operations on an unchanged draft", () => {
    const { fix, planPath, input } = setup();
    assert.equal(spawnCli(["batch", fix.path, "--plan", planPath], { input }).status, 0);
    const result = spawnCli(["batch", fix.path, "--apply-plan", planPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.succeeded, 2);
    assert.match(readFileSync(fix.path, "utf-8"), /planned/);
    assert.equal(existsSync(`${fix.path}.bak`), true);
  });

  it("--apply-plan refuses after another command edited the draft", () => {
    const { fix, id, planPath, input } = setup();
    assert.equal(spawnCli(["batch", fix.path, "--plan", planPath], { input }).status, 0);
    assert.equal(spawnCli(["set-text", fix.path, id, "someone else", "-q"]).status, 0);
    const edited = readFileSync(fix.path, "utf-8");
    const result = spawnCli(["batch", fix.path, "--apply-plan", planPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refused \[plan-draft-changed\]/);
    assert.equal(readFileSync(fix.path, "utf-8"), edited);
  });

  it("--apply-plan refuses when the plan's operations were edited", () => {
    const { fix, planPath, input } = setup();
    assert.equal(spawnCli(["batch", fix.path, "--plan", planPath], { input }).status, 0);
    const before = readFileSync(fix.path, "utf-8");
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    plan.operations[0].text = "swapped after review";
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    const result = spawnCli(["batch", fix.path, "--apply-plan", planPath]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refused \[plan-tampered\]/);
    assert.equal(readFileSync(fix.path, "utf-8"), before);
  });

  it("re-indenting or reordering keys in the plan is not tampering", () => {
    const { fix, planPath, input } = setup();
    assert.equal(spawnCli(["batch", fix.path, "--plan", planPath], { input }).status, 0);
    const plan = JSON.parse(readFileSync(planPath, "utf-8"));
    plan.operations = plan.operations.map((op) => Object.fromEntries(Object.entries(op).reverse()));
    writeFileSync(planPath, JSON.stringify(plan));
    const result = spawnCli(["batch", fix.path, "--apply-plan", planPath]);
    assert.equal(result.status, 0, result.stderr);
  });

  it("--plan and --apply-plan are mutually exclusive", () => {
    const { fix, planPath, input } = setup();
    const result = spawnCli(["batch", fix.path, "--plan", planPath, "--apply-plan", planPath], { input });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /mutually exclusive/);
  });

  it("--apply-plan ignores stdin operations", () => {
    const { fix, planPath, input } = setup();
    assert.equal(spawnCli(["batch", fix.path, "--plan", planPath], { input }).status, 0);
    const stray = JSON.stringify({ cmd: "set-text", id: firstText(fix.path), text: "from stdin" });
    const result = spawnCli(["batch", fix.path, "--apply-plan", planPath], { input: stray });
    assert.equal(result.status, 0, result.stderr);
    const after = readFileSync(fix.path, "utf-8");
    assert.match(after, /planned/);
    assert.doesNotMatch(after, /from stdin/);
  });
});
