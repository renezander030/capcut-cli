import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { after, describe, it } from "node:test";
import { crc32, signAwsV4 } from "../dist/capcut-cloud-asr.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

describe("capcut-cloud-asr — unit algorithms", () => {
  it("calculates known CRC32 checksums correctly", () => {
    assert.equal(crc32(Buffer.from("123456789")), "cbf43926");
    assert.equal(crc32(Buffer.from("")), "00000000");
    assert.equal(crc32(Buffer.from("CapCut")), "809f2c0f");
  });

  it("builds exact AWS SigV4 canonical signatures with ASCII sorted headers and queries", () => {
    const fixedDate = new Date("2026-10-21T02:25:03.000Z");
    const creds = {
      access_key_id: "AKTPTEST123",
      secret_access_key: "SECRET123",
      session_token: "TOKEN123",
    };
    const signed = signAwsV4(
      {
        host: "vas-alisg16.byteoversea.com",
        path: "/top/v1?Action=ApplyUploadInner&SpaceName=test_space&UseQuic=false&Version=2020-11-19&device_platform=win",
        service: "vod",
        region: "sg",
        method: "GET",
        headers: { "x-amz-security-token": creds.session_token },
      },
      creds,
      fixedDate,
    );

    assert.ok(
      signed.headers.Authorization.startsWith("AWS4-HMAC-SHA256 Credential=AKTPTEST123/20261021/sg/vod/aws4_request"),
    );
    assert.ok(signed.headers.Authorization.includes("SignedHeaders=host;x-amz-date;x-amz-security-token"));
    assert.equal(signed.headers.Host, "vas-alisg16.byteoversea.com");
    assert.equal(signed.headers["X-Amz-Date"], "20261021T022503Z");
  });
});

describe("capcut caption --cloud — CLI validation", () => {
  const fix = tmpDraft();
  after(() => fix.cleanup());

  it("refuses when --cloud is combined with --words", () => {
    const r = spawnCli(["caption", fix.path, "--audio", "/fake/path.mp3", "--cloud", "--words", "words.json"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /mutually exclusive/);
  });

  it("refuses when --cloud is combined with --whisper-cmd", () => {
    const r = spawnCli(["caption", fix.path, "--audio", "/fake/path.mp3", "--cloud", "--whisper-cmd", "whisper"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /mutually exclusive/);
  });

  it("errors when --cloud audio file does not exist", () => {
    const r = spawnCli(["caption", fix.path, "--audio", "/nonexistent/audio.wav", "--cloud"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Audio file not found/);
  });
});

describe("capcut caption --cloud — live integration smoke test", () => {
  const sampleAudio = resolve(process.cwd(), "../final.mp3");

  it("transcribes audio directly into CapCut timeline via Cloud ASR", (t) => {
    if (!existsSync(sampleAudio)) {
      t.skip("No final.mp3 available for live cloud smoke test");
      return;
    }

    const fix = tmpDraft();
    after(() => fix.cleanup());

    const r = spawnCli(["caption", fix.path, "--audio", sampleAudio, "--cloud", "--karaoke"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.engine, "capcut-cloud");
    assert.ok(r.json.cues > 0, "Expected at least 1 cue to be created");
    assert.ok(r.json.words > 0, "Expected recognized words");

    // Verify track created in draft
    const tracksRes = spawnCli(["tracks", fix.path]);
    assert.equal(tracksRes.status, 0);
    const captionTrack = tracksRes.json.find((tr) => tr.type === "text" && tr.name === "captions");
    assert.ok(captionTrack, "Captions track should exist in project");

    // Verify segments exist with text content
    const textsRes = spawnCli(["texts", fix.path]);
    assert.equal(textsRes.status, 0);
    assert.ok(textsRes.json.length > 0, "Expected texts in the draft");
  });
});
