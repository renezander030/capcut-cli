import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { loadDraft, saveDraft, setForceWrite } from "../dist/draft.js";
import { addAudio } from "../dist/factory.js";
import { diagnoseDraftStore, discoverDraftStore, planTimelineSync } from "../dist/store.js";
import { projectShell, readJson, snapshot } from "./helpers/project-shell.mjs";
import { spawnCli } from "./helpers/spawn-cli.mjs";

describe("explicit active timeline selection (#50)", () => {
  it("keeps default Mac selection and follows the pointer only on opt-in", (t) => {
    const s = projectShell(t);
    assert.equal(discoverDraftStore(s.dir).canonical.path, s.root);
    assert.equal(discoverDraftStore(s.dir, { activeTimeline: true }).canonical.path, s.active);
    const report = diagnoseDraftStore(s.dir, { activeTimeline: true });
    assert.equal(report.active_timeline.explicit, true);
    assert.match(report.next_actions.join(" "), /acceptance.*unverified/);
    assert.equal(planTimelineSync(s.active, { activeTimeline: true }).canonicalCandidate.path, s.active);
    const cli = spawnCli(["diagnose", s.dir, "--active-timeline"]);
    assert.equal(cli.json.active_timeline.explicit, true, cli.stderr);
  });

  it("edits and restores the selected timeline, preserving root IDs, pointer and archived edits", (t) => {
    const s = projectShell(t);
    const beforePointer = readFileSync(s.pointer, "utf-8");
    const beforeArchive = readFileSync(s.archive, "utf-8");
    const mirror = join(dirname(s.active), "template-2.tmp");
    writeFileSync(mirror, JSON.stringify({ opaque: 1, timeline: JSON.stringify(readJson(s.active)) }));
    const result = spawnCli(["add-text", s.dir, "0", "1s", "Selected edit", "--active-timeline"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readJson(s.active).tracks[0].segments.length, 1);
    assert.equal(readJson(s.active).id, "active-id");
    assert.equal(readJson(s.root).id, "project-id");
    assert.equal(readJson(mirror).opaque, 1);
    assert.equal(readFileSync(s.pointer, "utf-8"), beforePointer);
    assert.equal(readFileSync(s.archive, "utf-8"), beforeArchive);
    const restored = spawnCli(["restore", s.dir, "--active-timeline"]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(readJson(s.active).tracks.length, 0);
    assert.equal(readJson(s.root).id, "project-id");
    assert.equal(JSON.parse(readJson(mirror).timeline).tracks.length, 0);
  });

  for (const [name, pointer] of [
    ["unsafe id", { main_timeline_id: "../outside" }],
    ["missing timeline", { main_timeline_id: "absent" }],
    ["deleted timeline", { main_timeline_id: "active-id", timelines: [{ id: "active-id", is_marked_delete: true }] }],
    ["malformed pointer", "bad JSON"],
  ]) {
    it(`refuses ${name} without falling back to a root write, including force-write`, (t) => {
      const s = projectShell(t);
      writeFileSync(s.pointer, typeof pointer === "string" ? pointer : JSON.stringify(pointer));
      const before = snapshot(s.dir);
      const result = spawnCli(["add-text", s.dir, "0", "1s", "Keep safe", "--active-timeline", "--force-write"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /active-timeline-invalid/);
      assert.deepEqual(snapshot(s.dir), before);
    });
  }

  it("refuses conflicting documents and explicitly addressed archived timelines", (t) => {
    const s = projectShell(t);
    const mirror = join(dirname(s.active), "draft_content.json");
    writeFileSync(mirror, JSON.stringify({ ...readJson(s.active), duration: 1_000_000 }));
    assert.throws(() => discoverDraftStore(s.dir, { activeTimeline: true }), /documents disagree/);
    rmSync(mirror);
    assert.throws(() => discoverDraftStore(s.archive, { activeTimeline: true }), /inactive timeline/);
  });

  it("refuses pointer traversal through a symlink", (t) => {
    const s = projectShell(t);
    const outside = join(s.base, "outside.json");
    writeFileSync(outside, readFileSync(s.pointer));
    rmSync(s.pointer);
    symlinkSync(outside, s.pointer);
    assert.throws(() => discoverDraftStore(s.dir, { activeTimeline: true }), /symlink/);
  });

  it("keeps version and pointer-change guards even with the new option", (t) => {
    const s = projectShell(t, { version: "99.0.0" });
    const result = spawnCli(["add-text", s.dir, "0", "1s", "Refuse", "--active-timeline"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /version-boundary/);
    const loaded = loadDraft(s.dir, { activeTimeline: true });
    writeFileSync(s.pointer, '{"main_timeline_id":"archive-id"}');
    setForceWrite(true);
    try {
      assert.throws(() => saveDraft(loaded.filePath, loaded.draft), /active-timeline-changed/);
    } finally {
      setForceWrite(false);
    }
  });

  it("uses the loaded project root for library media additions without a process-wide option", (t) => {
    const s = projectShell(t);
    const media = join(s.base, "music.wav");
    writeFileSync(media, "audio bytes");
    const { draft, filePath } = loadDraft(s.dir, { activeTimeline: true });
    const result = addAudio(draft, filePath, { path: media, start: 0, duration: 1_000_000 });
    assert.equal(result.registered, true);
    assert.ok(draft.materials.audios[0].path.startsWith(join(s.dir, "assets", "audio")));
    assert.equal(existsSync(join(dirname(s.active), "assets")), false);
  });

  it("does not consume the option on unrelated free-text commands", () => {
    const result = spawnCli(["compile", "--active-timeline", "--check"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires --into/);
    const described = spawnCli(["describe", "--command", "compile"]);
    assert.ok(described.json.commands[0].options.some((option) => option.flags.includes("--active-timeline")));
    const enums = spawnCli(["catalogue", "--active-timeline"]);
    assert.equal(enums.status, 0, enums.stderr);
  });
});
