import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "draft_content.json");

const segIds = (d) => d.tracks.flatMap((t) => t.segments.map((s) => s.id));
const matIds = (d) =>
  Object.values(d.materials)
    .filter(Array.isArray)
    .flat()
    .filter((m) => m && typeof m.id === "string")
    .map((m) => m.id);

describe("concat", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "capcut-concat-"));
    copyFileSync(FIXTURE, join(dir, "A.json"));
    copyFileSync(FIXTURE, join(dir, "B.json"));
    return {
      dir,
      a: join(dir, "A.json"),
      b: join(dir, "B.json"),
      out: join(dir, "AB.json"),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("--out merges both timelines with no id collisions and shifted B segments", () => {
    const s = setup();
    after(s.cleanup);
    const a = JSON.parse(readFileSync(s.a, "utf-8"));
    const b = JSON.parse(readFileSync(s.b, "utf-8"));
    const aDur = a.duration;

    const r = spawnCli(["concat", s.a, s.b, "--out", s.out]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    const ab = JSON.parse(readFileSync(s.out, "utf-8"));
    // every segment & material id is unique despite A and B sharing ids (worst case)
    const sids = segIds(ab);
    const mids = matIds(ab);
    assert.equal(sids.length, segIds(a).length + segIds(b).length, "all segments from both drafts present");
    assert.equal(new Set(sids).size, sids.length, "segment ids must be unique after concat");
    assert.equal(new Set(mids).size, mids.length, "material ids must be unique after concat");
    assert.ok(r.json.remapped_ids > 0, "colliding ids should have been remapped");

    // duration is the sum, and B's segments are shifted past A's end
    assert.equal(ab.duration, aDur + b.duration);
    const maxStart = Math.max(...ab.tracks.flatMap((t) => t.segments.map((seg) => seg.target_timerange.start)));
    assert.ok(maxStart >= aDur, "B segments must be time-shifted past A's duration");

    // --out leaves source A untouched (no merge written back, no extra segments)
    assert.equal(JSON.parse(readFileSync(s.a, "utf-8")).duration, aDur, "source A duration unchanged");
    assert.equal(
      segIds(JSON.parse(readFileSync(s.a, "utf-8"))).length,
      segIds(a).length,
      "source A segments unchanged",
    );
  });

  it("in-place concat writes A and keeps a .bak", () => {
    const s = setup();
    after(s.cleanup);
    const aDur = JSON.parse(readFileSync(s.a, "utf-8")).duration;
    const bDur = JSON.parse(readFileSync(s.b, "utf-8")).duration;
    const r = spawnCli(["concat", s.a, s.b]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(JSON.parse(readFileSync(s.a, "utf-8")).duration, aDur + bDur);
  });

  it("errors without two arguments", () => {
    const s = setup();
    after(s.cleanup);
    const r = spawnCli(["concat", s.a]);
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}${r.stderr}`, /Usage: capcut concat/);
  });
});
