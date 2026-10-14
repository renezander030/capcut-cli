import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const SEG = "aaaaaa01";

/**
 * The app can write a segment whose `target_timerange` omits `start` (its 0
 * default) and that carries no `speed`. Both were typed as required, so the
 * tables printed `NaN:00NaN` / `undefinedx` for a segment the app opens fine.
 * Measured on a JianYing 9.0.0 (Windows) project: `capcut segments <p> -H`
 * rendered `62a041c7  text   NaN:00NaN-NaN:00NaN  3.00s  undefinedx`.
 */
function draftWithoutTimingFields() {
  const fix = tmpDraft();
  const draft = JSON.parse(readFileSync(fix.path, "utf-8"));
  const seg = draft.tracks.flatMap((t) => t.segments).find((s) => s.id.startsWith(SEG));
  assert.ok(seg, "fixture segment missing");
  delete seg.target_timerange.start;
  delete seg.speed;
  writeFileSync(fix.path, JSON.stringify(draft), "utf-8");
  return fix;
}

describe("segments table: missing target_timerange.start / speed", () => {
  it("renders a partial segment without NaN or undefined", () => {
    const fix = draftWithoutTimingFields();
    after(() => fix.cleanup());

    const r = spawnCli(["segments", fix.path, "-H"]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(!/NaN/.test(r.stdout), `human table printed NaN:\n${r.stdout}`);
    assert.ok(!/undefined/.test(r.stdout), `human table printed undefined:\n${r.stdout}`);
    assert.match(r.stdout, /aaaaaa01/, "the segment should still be listed");
  });

  it("reports the missing timing fields as their defaults in JSON", () => {
    const fix = draftWithoutTimingFields();
    after(() => fix.cleanup());

    const r = spawnCli(["segments", fix.path]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const rows = Array.isArray(r.json) ? r.json : (r.json.segments ?? []);
    const seg = rows.find((s) => s.id.startsWith(SEG));
    assert.equal(seg.start_us, 0);
    assert.equal(seg.speed, 1);
    assert.ok(Number.isFinite(seg.duration_us), `duration should stay numeric, got ${seg.duration_us}`);
  });
});
