import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { draftToOtio, otioToImportPlan, resolveOtioMediaPath } from "../dist/interchange.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("OTIO local media references", () => {
  for (const kind of ["relative", "file-uri"]) {
    it(`imports an accessible ${kind} reference when cwd differs from the OTIO folder`, () => {
      const fix = tmpDraft();
      try {
        const folder = join(fix.dir, "handoff");
        mkdirSync(folder);
        const media = join(folder, "clip with space.mp4");
        writeFileSync(media, "source bytes");
        const draft = JSON.parse(readFileSync(fix.path, "utf8"));
        const track = draft.tracks.find((track) => track.type === "video");
        const segment = track.segments[0];
        track.segments = [segment];
        draft.tracks = [track];
        const material = draft.materials.videos.find((material) => material.id === segment.material_id);
        material.path = kind === "relative" ? "clip with space.mp4" : pathToFileURL(media).href;
        const { doc } = draftToOtio(draft);
        const input = join(folder, "edit.otio");
        writeFileSync(input, JSON.stringify(doc));
        const output = join(fix.dir, "imported");
        const result = spawnCli(["import-timeline", input, "--out", output, "--template", "bundled"], {
          cwd: resolve("templates"),
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.json.placeholders.length, 0);
        const imported = JSON.parse(readFileSync(result.json.file_path, "utf8"));
        const importedMedia = imported.materials.videos.find((material) => material.path);
        assert.equal(readFileSync(importedMedia.path, "utf8"), "source bytes");
      } finally {
        fix.cleanup();
      }
    });
  }

  it("keeps remote URLs and foreign Windows paths available as placeholder references", () => {
    assert.equal(resolveOtioMediaPath("https://example.com/clip.mp4", "/handoff"), "https://example.com/clip.mp4");
    assert.equal(resolveOtioMediaPath("C:\\media\\clip.mp4", "/handoff"), "C:\\media\\clip.mp4");
    assert.equal(
      resolveOtioMediaPath("file://foreign-host/clip.mp4"),
      process.platform === "win32" ? "\\\\foreign-host\\clip.mp4" : "file://foreign-host/clip.mp4",
    );
    const fix = tmpDraft();
    try {
      const draft = JSON.parse(readFileSync(fix.path, "utf8"));
      const { doc } = draftToOtio(draft);
      assert.deepEqual(otioToImportPlan(doc), otioToImportPlan(doc, {}), "library default remains independent of cwd");
    } finally {
      fix.cleanup();
    }
  });
});
