import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

function journalLines(fix) {
  const path = join(fix.dir, ".capcut-cli-history", "draft_content.json.journal.jsonl");
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe("write journal", () => {
  it("records each write and restore --list names the commands newest-first", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const id = spawnCli(["texts", fix.path]).json[0].id;
    const original = readFileSync(fix.path, "utf-8");
    assert.equal(spawnCli(["set-text", fix.path, id, "J1", "-q"]).status, 0);
    const afterFirst = readFileSync(fix.path, "utf-8");
    assert.equal(spawnCli(["shift", fix.path, id, "+1s", "-q"]).status, 0);

    const lines = journalLines(fix);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].index, 1);
    assert.equal(lines[0].command, "set-text");
    assert.deepEqual(lines[0].argv, [fix.path, id, "J1", "-q"]);
    assert.equal(lines[0].before_sha256, sha(original));
    assert.equal(lines[0].after_sha256, sha(afterFirst));
    assert.equal(lines[1].before_sha256, sha(afterFirst));
    assert.ok(!Number.isNaN(Date.parse(lines[0].time)));

    const list = spawnCli(["restore", fix.path, "--list"]);
    assert.equal(list.status, 0, list.stderr);
    assert.equal(list.json.count, 2);
    assert.deepEqual(
      list.json.snapshots.map((s) => s.command),
      ["shift", "set-text"],
    );
    assert.deepEqual(list.json.snapshots[0].argv, [fix.path, id, "+1s", "-q"]);
    assert.equal(typeof list.json.snapshots[0].time, "string");
  });

  it("trims journal lines with the snapshots beyond the history cap", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const id = spawnCli(["texts", fix.path]).json[0].id;
    for (let i = 1; i <= 22; i++) assert.equal(spawnCli(["set-text", fix.path, id, `T${i}`, "-q"]).status, 0);

    const snaps = readdirSync(join(fix.dir, ".capcut-cli-history"))
      .filter((f) => f.endsWith(".snap"))
      .map((f) => Number.parseInt(f.match(/\.(\d+)\.snap$/)[1], 10))
      .sort((a, b) => a - b);
    const lines = journalLines(fix);
    assert.equal(snaps.length, 20);
    assert.deepEqual(
      lines.map((l) => l.index),
      snaps,
    );
    assert.equal(lines[0].index, 3);
    assert.deepEqual(lines.at(-1).argv, [fix.path, id, "T22", "-q"]);

    const list = spawnCli(["restore", fix.path, "--list"]);
    assert.equal(list.json.count, 20);
    assert.ok(list.json.snapshots.every((s) => s.command === "set-text"));
  });

  it("skips a corrupted journal line without breaking writes or restore", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const id = spawnCli(["texts", fix.path]).json[0].id;
    assert.equal(spawnCli(["set-text", fix.path, id, "A", "-q"]).status, 0);
    const journal = join(fix.dir, ".capcut-cli-history", "draft_content.json.journal.jsonl");
    appendFileSync(journal, '{"index": 2, "command": torn\n');
    assert.equal(spawnCli(["set-text", fix.path, id, "B", "-q"]).status, 0);

    const list = spawnCli(["restore", fix.path, "--list"]);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(
      list.json.snapshots.map((s) => s.command),
      ["set-text", "set-text"],
    );

    const restored = spawnCli(["restore", fix.path, "--step", "1"]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(spawnCli(["texts", fix.path]).json[0].text, "A");
  });

  it("lists snapshots without a journal line with null fields", () => {
    const fix = tmpDraft();
    after(fix.cleanup);
    const id = spawnCli(["texts", fix.path]).json[0].id;
    assert.equal(spawnCli(["set-text", fix.path, id, "A", "-q"]).status, 0);
    const journal = join(fix.dir, ".capcut-cli-history", "draft_content.json.journal.jsonl");
    // Simulate a snapshot written before the journal existed.
    rmSync(journal);
    const list = spawnCli(["restore", fix.path, "--list"]);
    assert.equal(list.json.count, 1);
    assert.equal(list.json.snapshots[0].command, null);
    assert.equal(list.json.snapshots[0].argv, null);
    assert.equal(list.json.snapshots[0].time, null);
  });
});
