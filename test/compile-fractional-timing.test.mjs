import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { compileDraft } from "../dist/compile.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const US = 1_000_000;
const bar = (60 / 136) * 4;

describe("compile fractional-second target boundaries", () => {
  it("keeps adjacent music bars contiguous across all item and timed-operation kinds", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "capcut-compile-fractional-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of ["clip.mp4", "music.mp3", "photo.png"]) writeFileSync(join(dir, name), "unprobeable");
    const items = (extra) => Array.from({ length: 8 }, (_, i) => ({ start: i * bar, duration: bar, ...extra }));
    const operations = [
      ...items({ op: "filter", slug: "vintage", trackName: "filters" }),
      ...items({ op: "effect", slug: "shake", trackName: "effects" }),
      ...items({ op: "template", path: join(root, "templates", "subscribe-cta.json") }),
    ];
    const spec = {
      tracks: [
        { type: "text", name: "titles", items: items({ text: "BAR" }) },
        { type: "video", name: "clips", items: items({ path: "clip.mp4", sourceStart: 4, speed: 1.25 }) },
        { type: "video", name: "photos", items: items({ path: "photo.png", type: "photo" }) },
        { type: "audio", name: "music", items: items({ path: "music.mp3", sourceStart: 2, speed: 0.75 }) },
      ],
      operations,
    };
    const result = compileDraft(spec, {
      specDir: dir,
      outDir: join(dir, "Built"),
      templateDir: join(root, "templates", "_init"),
      seed: "off",
    });
    const draft = JSON.parse(readFileSync(result.file_path, "utf-8"));
    // Templates use the first text track, so compare their eight-segment group separately.
    for (const track of draft.tracks) {
      const groups = track.name === "titles" ? [track.segments.slice(0, 8), track.segments.slice(8)] : [track.segments];
      for (const group of groups) {
        assert.equal(group.length, 8, track.name);
        for (let i = 0; i < group.length; i++) {
          const range = group[i].target_timerange;
          assert.equal(range.start, Math.round(i * bar * US));
          assert.equal(range.start + range.duration, Math.round((i * bar + bar) * US));
          if (i > 0)
            assert.equal(
              group[i - 1].target_timerange.start + group[i - 1].target_timerange.duration,
              range.start,
              `${track.name} boundary ${i}`,
            );
        }
      }
    }
    assert.equal(result.duration_us, Math.round(8 * bar * US));
    for (const track of draft.tracks.filter((item) => item.name === "clips" || item.name === "music")) {
      const speed = track.name === "clips" ? 1.25 : 0.75;
      const sourceStart = track.name === "clips" ? 4 : 2;
      for (const segment of track.segments) {
        assert.equal(segment.source_timerange.start, sourceStart * US);
        assert.equal(segment.source_timerange.duration, Math.round(segment.target_timerange.duration * speed));
        assert.equal(segment.speed, speed);
      }
    }
  });
});
