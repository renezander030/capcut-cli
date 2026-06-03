import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// Multi-step undo: every write snapshots the pre-write state into a rolling
// history. `restore --step N` rolls back N writes (step 1 == the .bak).
describe("restore --step / --list (snapshot history)", () => {
  const textOf = (path, id) => {
    const r = spawnCli(["texts", path]);
    const seg = r.json.find((t) => t.id.startsWith(id));
    return seg ? seg.text : null;
  };

  it("rolls back to the exact state N writes ago", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());

    const first = spawnCli(["texts", fix.path]).json[0];
    const id = first.id;
    const original = first.text;

    spawnCli(["set-text", fix.path, id, "T1", "-q"]);
    spawnCli(["set-text", fix.path, id, "T2", "-q"]);
    spawnCli(["set-text", fix.path, id, "T3", "-q"]);
    assert.equal(textOf(fix.path, id), "T3", "sanity: latest write is T3");

    // 3 writes => 3 snapshots, newest first: step1=pre-T3(T2), step2=pre-T2(T1), step3=pre-T1(original)
    const list = spawnCli(["restore", fix.path, "--list"]);
    assert.equal(list.json.count, 3);

    spawnCli(["restore", fix.path, "--step", "2"]);
    assert.equal(textOf(fix.path, id), "T1", "--step 2 should restore the T1 state");

    // snapshots are not consumed by a restore, so step 1 still yields T2
    spawnCli(["restore", fix.path, "--step", "1"]);
    assert.equal(textOf(fix.path, id), "T2", "--step 1 should restore the T2 state (== .bak)");

    spawnCli(["restore", fix.path, "--step", "3"]);
    assert.equal(textOf(fix.path, id), original, "--step 3 should restore the original");
  });

  it("plain restore equals --step 1", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const id = spawnCli(["texts", fix.path]).json[0].id;
    spawnCli(["set-text", fix.path, id, "A", "-q"]);
    spawnCli(["set-text", fix.path, id, "B", "-q"]);
    spawnCli(["restore", fix.path]); // plain -> .bak -> pre-B == "A"
    assert.equal(textOf(fix.path, id), "A");
  });

  it("--step beyond history exits non-zero with a clear message", () => {
    const fix = tmpDraft();
    after(() => fix.cleanup());
    const id = spawnCli(["texts", fix.path]).json[0].id;
    spawnCli(["set-text", fix.path, id, "only", "-q"]);
    const r = spawnCli(["restore", fix.path, "--step", "9"]);
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /No snapshot at --step 9/);
  });
});
