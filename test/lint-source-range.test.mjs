import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// source-range-exceeds-material: CapCut clamps a source in-point past the end
// of the material to zero, so the clip replays the start of its file whatever
// was written (JmsLdrn/capcut-mcp#1, a two-camera cut on 9.3.0). Info, not
// warning — the shipped fixture itself carries one such range.

function withDraft(mutate) {
  const fix = tmpDraft();
  const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
  mutate(draft);
  writeFileSync(fix.path, JSON.stringify(draft));
  return fix;
}

function firstVideo(draft) {
  const track = draft.tracks.find((t) => t.type === "video");
  const seg = track.segments[0];
  const mat = draft.materials.videos.find((m) => m.id === seg.material_id);
  return { seg, mat };
}

describe("lint source-range-exceeds-material", () => {
  it("flags a source range that reads past the material's duration, with a trim to fit", (t) => {
    const fix = withDraft((draft) => {
      const { seg, mat } = firstVideo(draft);
      // The span the segment's speed consumes (so speed stays consistent), starting 1s in — past a 5s file.
      seg.source_timerange = { start: 1_000_000, duration: seg.target_timerange.duration * (seg.speed ?? 1) };
      mat.duration = 5_000_000;
    });
    t.after(() => fix.cleanup());
    const r = spawnCli(["lint", fix.path, "--no-check-paths", "--no-probe"]);
    assert.equal(r.status, 0, `info never fails the exit code: ${r.stdout}`);
    const issue = r.json.issues.find((i) => i.code === "source-range-exceeds-material");
    assert.ok(issue, JSON.stringify(r.json.issues));
    assert.equal(issue.severity, "info");
    assert.equal(issue.fixable, false);
    assert.match(issue.suggested_command, /capcut trim <project> \S+ 1000ms 4000ms/);
    assert.match(issue.message, /clamps an out-of-range in-point/);
  });

  it("suggests an in-point of 0 when the start itself is past the end of the file", (t) => {
    const fix = withDraft((draft) => {
      const { seg, mat } = firstVideo(draft);
      seg.source_timerange = { start: 9_000_000, duration: seg.target_timerange.duration * (seg.speed ?? 1) };
      mat.duration = 5_000_000;
    });
    t.after(() => fix.cleanup());
    const r = spawnCli(["lint", fix.path, "--no-check-paths", "--no-probe"]);
    const issue = r.json.issues.find((i) => i.code === "source-range-exceeds-material");
    assert.ok(issue);
    assert.match(issue.suggested_command, /capcut trim <project> \S+ 0 /);
  });

  it("stays quiet within one frame of the end, on photos, and when the material has no duration", (t) => {
    const cases = [
      (draft) => {
        const { seg, mat } = firstVideo(draft);
        const span = seg.target_timerange.duration * (seg.speed ?? 1);
        seg.source_timerange = { start: 0, duration: span };
        mat.duration = span - 20_000; // 20ms over at 30fps: rounding, not a defect
      },
      (draft) => {
        const { seg, mat } = firstVideo(draft);
        seg.source_timerange = { start: 0, duration: seg.target_timerange.duration * (seg.speed ?? 1) };
        mat.duration = 5_000_000;
        mat.type = "photo";
      },
      (draft) => {
        const { seg, mat } = firstVideo(draft);
        seg.source_timerange = { start: 0, duration: seg.target_timerange.duration * (seg.speed ?? 1) };
        delete mat.duration;
      },
    ];
    for (const mutate of cases) {
      const fix = withDraft((draft) => {
        // Make every other video segment consistent so only the mutated one could fire.
        for (const track of draft.tracks) {
          if (track.type !== "video" && track.type !== "audio") continue;
          for (const seg of track.segments) {
            const mat = draft.materials[track.type === "video" ? "videos" : "audios"].find(
              (m) => m.id === seg.material_id,
            );
            if (mat && seg.source_timerange) mat.duration = seg.source_timerange.start + seg.source_timerange.duration;
          }
        }
        mutate(draft);
      });
      t.after(() => fix.cleanup());
      const r = spawnCli(["lint", fix.path, "--no-check-paths", "--no-probe"]);
      assert.ok(
        !r.json.issues.some((i) => i.code === "source-range-exceeds-material"),
        JSON.stringify(r.json.issues.filter((i) => i.code === "source-range-exceeds-material")),
      );
    }
  });
});
