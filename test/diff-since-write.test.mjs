import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const HISTORY = ".capcut-cli-history";

// A CLI write, then the draft as the app would leave it after an edit.
function written(t) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const textId = spawnCli(["texts", fix.path]).json[0].id;
  assert.equal(spawnCli(["set-text", fix.path, textId, "Written by the CLI", "-q"]).status, 0);
  return { ...fix, textId, content: readFileSync(fix.path, "utf-8") };
}

function appEdit(path, edit) {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  edit(draft);
  writeFileSync(path, JSON.stringify(draft));
}

const nothing = { added: [], removed: [], changed: [] };

describe("diff --since-write", () => {
  it("reports no change when the draft is exactly what the CLI wrote", (t) => {
    const fix = written(t);
    const r = spawnCli(["diff", fix.path, "--since-write"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.changed, false);
    assert.deepEqual(r.json.segments, nothing);
    assert.deepEqual(r.json.materials, nothing);
    assert.equal(r.json.since_write.changed, false);
    assert.equal(r.json.since_write.written_sha256, sha(fix.content));
    assert.equal(r.json.since_write.current_sha256, sha(fix.content));
    assert.equal(r.json.since_write.written_by, "set-text");
    assert.ok(!Number.isNaN(Date.parse(r.json.since_write.written_at)));
    assert.deepEqual(r.json.since_write.top_level_changed, []);
    assert.equal(r.json.since_write.track_order_changed, false);
    assert.match(r.stderr, /No changes/);
  });

  it("shows a reordering of the tracks and nothing else", (t) => {
    const fix = written(t);
    appEdit(fix.path, (draft) => draft.tracks.reverse());
    const r = spawnCli(["diff", fix.path, "--since-write"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.changed, false, "no segment or material changed");
    assert.deepEqual(r.json.segments, nothing);
    assert.deepEqual(r.json.materials, nothing);
    assert.equal(r.json.since_write.changed, true);
    assert.equal(r.json.since_write.track_order_changed, true);
    assert.deepEqual(r.json.since_write.top_level_changed, ["tracks"]);
    assert.equal(r.json.since_write.current_sha256, sha(readFileSync(fix.path, "utf-8")));
  });

  it("shows a changed value on one segment", (t) => {
    const fix = written(t);
    let segmentId;
    appEdit(fix.path, (draft) => {
      const segment = draft.tracks.find((track) => track.type === "video").segments[0];
      segmentId = segment.id;
      segment.volume = 0.25;
    });
    const r = spawnCli(["diff", fix.path, "--since-write"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.changed, true);
    assert.deepEqual(r.json.segments, { added: [], removed: [], changed: [{ id: segmentId, fields: ["volume"] }] });
    assert.deepEqual(r.json.materials, nothing);
    assert.deepEqual(r.json.since_write.top_level_changed, ["tracks"]);
    assert.equal(r.json.since_write.track_order_changed, false);
  });

  it("shows a material the app added", (t) => {
    const fix = written(t);
    appEdit(fix.path, (draft) => {
      draft.materials.texts.push({ id: "APP-ADDED", type: "text", content: "{}" });
    });
    const r = spawnCli(["diff", fix.path, "--since-write"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.segments, nothing);
    assert.deepEqual(r.json.materials, { added: ["APP-ADDED"], removed: [], changed: [] });
    assert.deepEqual(r.json.since_write.top_level_changed, ["materials"]);
    assert.equal(r.json.since_write.changed, true);
  });

  it("exits 1 when the CLI has no record of writing the draft", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const r = spawnCli(["diff", fix.path, "--since-write"]);
    assert.equal(r.status, 1);
    assert.match(JSON.parse(r.stderr.trim()).error, /No record of a capcut-cli write/);
  });

  it("keeps one record per draft file, replaced on each write", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    // A project with a mirror: every file a write touches gets its own record.
    copyFileSync(fix.path, join(fix.dir, "draft_info.json"));
    const textId = spawnCli(["texts", fix.dir]).json[0].id;
    for (const text of ["one", "two"]) {
      assert.equal(spawnCli(["set-text", fix.dir, textId, text, "-q"]).status, 0);
    }
    const records = readdirSync(join(fix.dir, HISTORY))
      .filter((name) => name.endsWith(".last-write"))
      .sort();
    assert.deepEqual(records, ["draft_content.json.last-write", "draft_info.json.last-write"]);
    for (const file of ["draft_content.json", "draft_info.json"]) {
      const record = JSON.parse(readFileSync(join(fix.dir, HISTORY, `${file}.last-write`), "utf-8"));
      assert.equal(record.content, readFileSync(join(fix.dir, file), "utf-8"));
      assert.equal(record.sha256, sha(record.content));
    }
  });

  it("leaves restore and its history listing as they were", (t) => {
    const fix = written(t);
    const segment = spawnCli(["segments", fix.path]).json[0];
    assert.equal(spawnCli(["shift", fix.path, segment.id, "+1s", "-q"]).status, 0);

    const list = spawnCli(["restore", fix.path, "--list"]);
    assert.equal(list.status, 0, list.stderr);
    assert.equal(list.json.count, 2);
    assert.deepEqual(
      list.json.snapshots.map((s) => [s.step, s.command, s.integrity]),
      [
        [1, "shift", "intact"],
        [2, "set-text", "intact"],
      ],
    );
    assert.ok(list.json.snapshots.every((s) => s.path.endsWith(".snap")));

    const restored = spawnCli(["restore", fix.path]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(restored.json.integrity, "intact");
    assert.equal(readFileSync(fix.path, "utf-8"), fix.content, "restore brings back the state before the shift");
    assert.equal(spawnCli(["restore", fix.path, "--list"]).json.count, 2);

    // The restore is the CLI's own write, so the draft matches the record again.
    const since = spawnCli(["diff", fix.path, "--since-write"]);
    assert.equal(since.status, 0, since.stderr);
    assert.equal(since.json.since_write.changed, false);
    assert.equal(since.json.since_write.written_sha256, sha(fix.content));
  });

  it("refuses a second project together with --since-write", (t) => {
    const fix = written(t);
    const r = spawnCli(["diff", fix.path, fix.path, "--since-write"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--since-write/);
  });
});
