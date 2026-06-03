import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAFT = join(__dirname, "..", "dist", "draft.js");

// Regression for #21: tracks are pushed in command-call order, so the tracks
// array (which drives CapCut's timeline layout) can come out scrambled.
// sortTracks() must normalize to the canonical bottom->top layer order.
describe("sortTracks (track-order normalization)", () => {
  const track = (type, name = type) => ({ id: name, type, name, attribute: 0, segments: [] });

  it("sorts scrambled tracks into canonical layer order", async () => {
    const { sortTracks } = await import(DRAFT);
    const draft = {
      tracks: [track("text"), track("audio"), track("sticker"), track("video"), track("effect"), track("filter")],
    };
    sortTracks(draft);
    assert.deepEqual(
      draft.tracks.map((t) => t.type),
      ["video", "audio", "sticker", "effect", "filter", "text"],
    );
  });

  it("matches the [video, audio, text] order of a real CapCut draft", async () => {
    const { sortTracks } = await import(DRAFT);
    const draft = { tracks: [track("text"), track("video"), track("audio")] };
    sortTracks(draft);
    assert.deepEqual(
      draft.tracks.map((t) => t.type),
      ["video", "audio", "text"],
    );
  });

  it("is stable for same-type tracks (keeps authored order)", async () => {
    const { sortTracks } = await import(DRAFT);
    const draft = { tracks: [track("video", "main"), track("text"), track("video", "overlay")] };
    sortTracks(draft);
    assert.deepEqual(
      draft.tracks.map((t) => t.name),
      ["main", "overlay", "text"],
    );
  });

  it("keeps unknown track types after known ones, in order", async () => {
    const { sortTracks } = await import(DRAFT);
    const draft = { tracks: [track("mystery"), track("text"), track("video")] };
    sortTracks(draft);
    assert.deepEqual(
      draft.tracks.map((t) => t.type),
      ["video", "text", "mystery"],
    );
  });
});
