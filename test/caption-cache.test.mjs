import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { captionDraft, transcriptCacheKey } from "../dist/caption.js";
import { extractText, loadDraft } from "../dist/draft.js";
import { TRANSCRIPT_CACHE_VERSION, transcriptCacheDir } from "../dist/transcript-cache.js";
import { spawnCli } from "./helpers/spawn-cli.mjs";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

// `caption` keeps the raw transcription, keyed by the transcribed audio bytes
// and the transcription settings, so a run that only restyles reads it back
// instead of transcribing again. The CLI path counts fake-whisper runs; the
// --cloud path counts requests to a stand-in fetch.

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_WHISPER = join(__dirname, "helpers", "fake-whisper.mjs");
const isWindows = process.platform === "win32"; // fake whisper is a shebang script

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "capcut-caption-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const audio = join(dir, "voice.wav");
  writeFileSync(audio, "voice bytes");
  const heard = join(dir, "heard.srt");
  writeFileSync(
    heard,
    "1\n00:00:00,000 --> 00:00:01,000\nhello there\n\n2\n00:00:01,500 --> 00:00:02,500\nsecond line\n",
  );
  const cache = join(dir, "cache");
  const calls = join(dir, "calls.log");
  const run = (extra = []) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const r = spawnCli(
      ["caption", fix.path, "--audio", audio, "--whisper-cmd", FAKE_WHISPER, "--no-coverage", ...extra],
      { env: { FAKE_WHISPER_SOURCE: heard, FAKE_WHISPER_CALLS: calls, CAPCUT_CLI_CACHE_DIR: cache } },
    );
    assert.equal(r.status, 0, r.stderr);
    return { ...r.json, draft: fix.path };
  };
  const engineRuns = () => (existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n").length : 0);
  const entries = () => (existsSync(cache) ? readdirSync(cache).filter((name) => name.endsWith(".json")) : []);
  return { dir, audio, cache, run, engineRuns, entries };
}

function captionTexts(path, trackName = "captions") {
  const draft = JSON.parse(readFileSync(path, "utf-8"));
  const track = draft.tracks.find((tr) => tr.type === "text" && tr.name === trackName);
  return track.segments.map((seg) => extractText(draft.materials.texts.find((m) => m.id === seg.material_id).content));
}

describe("caption transcript cache (CLI)", { skip: isWindows }, () => {
  it("a second identical run is a hit and does not run the engine; restyling stays a hit", (t) => {
    const s = setup(t);
    const first = s.run();
    assert.equal(first.transcript_cache, "miss");
    assert.equal(s.engineRuns(), 1);
    assert.equal(s.entries().length, 1);

    const second = s.run();
    assert.equal(second.transcript_cache, "hit");
    assert.equal(s.engineRuns(), 1, "the engine must not run on a hit");
    assert.deepEqual(captionTexts(second.draft), captionTexts(first.draft));

    const restyled = s.run(["--track-name", "styled", "--highlight-words", "hello", "--max-chars", "8"]);
    assert.equal(restyled.transcript_cache, "hit");
    assert.equal(s.engineRuns(), 1);
    assert.deepEqual(captionTexts(restyled.draft, "styled"), ["hello there", "second line"]);
  });

  it("a changed model, language or audio is a miss", (t) => {
    const s = setup(t);
    assert.equal(s.run().transcript_cache, "miss");
    assert.equal(s.run(["--whisper-model", "small"]).transcript_cache, "miss");
    assert.equal(s.engineRuns(), 2);
    assert.equal(s.run(["--language", "de"]).transcript_cache, "miss");
    assert.equal(s.engineRuns(), 3);
    assert.equal(s.run(["--language", "de"]).transcript_cache, "hit");
    assert.equal(s.engineRuns(), 3);
    writeFileSync(s.audio, "other voice bytes");
    assert.equal(s.run().transcript_cache, "miss");
    assert.equal(s.engineRuns(), 4);
  });

  it("--no-cache neither reads nor writes the cache", (t) => {
    const s = setup(t);
    assert.equal(s.run(["--no-cache"]).transcript_cache, "off");
    assert.equal(s.entries().length, 0, "--no-cache must not write an entry");
    assert.equal(s.run().transcript_cache, "miss");
    assert.equal(s.run(["--no-cache"]).transcript_cache, "off");
    assert.equal(s.engineRuns(), 3, "--no-cache must transcribe even when an entry exists");
  });

  it("a corrupt or mismatched entry is ignored and rewritten", (t) => {
    const s = setup(t);
    s.run();
    const [entry] = s.entries();
    const path = join(s.cache, entry);
    const good = readFileSync(path, "utf-8");

    writeFileSync(path, "{ not json");
    assert.equal(s.run().transcript_cache, "miss");
    assert.equal(s.engineRuns(), 2);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), JSON.parse(good), "the entry is rewritten");
    assert.equal(s.run().transcript_cache, "hit");

    const tampered = JSON.parse(good);
    tampered.transcription.cues = "not cues";
    writeFileSync(path, JSON.stringify(tampered));
    assert.equal(s.run().transcript_cache, "miss");
    assert.equal(s.engineRuns(), 3);
    assert.equal(s.run().transcript_cache, "hit");
  });

  it("--dry-run reads the cache but never writes it", (t) => {
    const s = setup(t);
    assert.equal(s.run(["--dry-run"]).transcript_cache, "miss");
    assert.equal(s.entries().length, 0, "a dry run must not write the cache");
    assert.equal(s.run().transcript_cache, "miss");
    assert.equal(s.run(["--dry-run"]).transcript_cache, "hit");
    assert.equal(s.engineRuns(), 2);
  });

  it("--words transcribes nothing and reports no cache state", (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const s = setup(t);
    const words = join(s.dir, "words.json");
    writeFileSync(words, JSON.stringify([{ word: "hi", start: 0, end: 0.5 }]));
    const r = spawnCli(["caption", fix.path, "--words", words], { env: { CAPCUT_CLI_CACHE_DIR: s.cache } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.transcript_cache, undefined);
    assert.equal(s.entries().length, 0);
  });
});

describe("transcript cache key and location", () => {
  it("keys on the audio and every transcription setting; --cloud ignores model and language", () => {
    const base = transcriptCacheKey({ whisperCmd: "whisper", whisperEngine: "openai" }, "abc");
    assert.deepEqual(base, {
      version: TRANSCRIPT_CACHE_VERSION,
      audio_sha256: "abc",
      engine: "openai",
      whisper_cmd: "whisper",
      model: "base",
      language: "auto",
      word_timing: "lines",
      cloud: false,
    });
    assert.equal(
      transcriptCacheKey({ whisperCmd: "whisper", whisperEngine: "openai", karaoke: true }, "abc").word_timing,
      "words",
    );
    assert.deepEqual(transcriptCacheKey({ cloud: true, language: "de" }, "abc"), {
      version: TRANSCRIPT_CACHE_VERSION,
      audio_sha256: "abc",
      engine: "capcut-cloud",
      whisper_cmd: null,
      model: null,
      language: null,
      word_timing: "words",
      cloud: true,
    });
  });

  it("CAPCUT_CLI_CACHE_DIR wins, then XDG_CACHE_HOME, then the platform cache dir", (t) => {
    const saved = { dir: process.env.CAPCUT_CLI_CACHE_DIR, xdg: process.env.XDG_CACHE_HOME };
    t.after(() => {
      for (const [name, value] of [
        ["CAPCUT_CLI_CACHE_DIR", saved.dir],
        ["XDG_CACHE_HOME", saved.xdg],
      ]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    const root = mkdtempSync(join(tmpdir(), "capcut-cache-dir-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    process.env.CAPCUT_CLI_CACHE_DIR = join(root, "mine");
    process.env.XDG_CACHE_HOME = join(root, "xdg");
    assert.equal(transcriptCacheDir(), join(root, "mine"));
    delete process.env.CAPCUT_CLI_CACHE_DIR;
    assert.equal(transcriptCacheDir(), join(root, "xdg", "capcut-cli", "transcripts"));
    delete process.env.XDG_CACHE_HOME;
    if (process.platform !== "win32") {
      assert.equal(transcriptCacheDir(), join(homedir(), ".cache", "capcut-cli", "transcripts"));
    } else {
      assert.match(transcriptCacheDir(), /capcut-cli[\\/]cache[\\/]transcripts$/);
    }
  });
});

describe("caption --cloud transcript cache (offline)", () => {
  const realFetch = globalThis.fetch;
  const savedDir = process.env.CAPCUT_CLI_CACHE_DIR;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedDir === undefined) delete process.env.CAPCUT_CLI_CACHE_DIR;
    else process.env.CAPCUT_CLI_CACHE_DIR = savedDir;
  });

  const json = (body, init = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

  /** A stand-in for CapCut's upload + recognition endpoints; returns the list of requests made. */
  function cloudService() {
    const calls = [];
    const answer = (url) => {
      if (url.includes("upload_sign")) {
        return json({
          ret: "0",
          data: {
            access_key_id: "AK",
            secret_access_key: "SK",
            session_token: "ST",
            space_name: "sp",
            domain: "vod.test",
          },
        });
      }
      if (url.includes("ApplyUploadInner")) {
        return json({
          Result: {
            Results: [
              {
                Vid: "vid1",
                UploadHost: "up.test",
                SessionKey: "sess",
                StoreInfos: [{ StoreUri: "oid1", Auth: "auth1", UploadID: "u1" }],
              },
            ],
          },
        });
      }
      if (url.includes("phase=transfer")) return json({});
      if (url.includes("phase=finish")) return json({ data: { key: "key1" } });
      if (url.includes("CommitUploadInner")) {
        return json({}, { headers: { "set-cookie": "odin_tt=abc123; Path=/; HttpOnly" } });
      }
      if (url.includes("common_task/new")) return json({ ret: "0", data: { tasks: [{ id: "task1", token: "tok1" }] } });
      return json({
        ret: "0",
        data: {
          tasks: [
            {
              id: "task1",
              status: "succeed",
              progress: 100,
              payload: JSON.stringify({
                utterances: [
                  {
                    text: "hello world",
                    start_time: 100,
                    end_time: 900,
                    words: [
                      { text: "hello", start_time: 100, end_time: 400 },
                      { text: "world", start_time: 450, end_time: 900 },
                    ],
                  },
                ],
              }),
            },
          ],
        },
      });
    };
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return answer(String(url));
    };
    return calls;
  }

  it("a hit uploads nothing", async (t) => {
    const fix = tmpDraft();
    t.after(fix.cleanup);
    const cacheDir = mkdtempSync(join(tmpdir(), "capcut-cloud-cache-"));
    t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
    process.env.CAPCUT_CLI_CACHE_DIR = cacheDir;
    // The fixture's audio segment points at a local, undecodable file: the
    // audio length comes from the draft's material, as in a --cloud dry run.
    const stored = JSON.parse(readFileSync(fix.path, "utf-8"));
    const audio = join(fix.dir, "voice.mp3");
    writeFileSync(audio, "x".repeat(4096));
    stored.materials.audios[0].path = audio;
    writeFileSync(fix.path, JSON.stringify(stored));
    const segment = stored.tracks.find((tr) => tr.type === "audio").segments[0].id;
    const opts = { fromSegment: segment, cloud: true, coverage: false };

    const first = cloudService();
    const missed = await captionDraft(loadDraft(fix.path).draft, opts);
    assert.equal(missed.transcript_cache, "miss");
    assert.ok(first.length > 0, "a miss uploads and recognizes");

    const second = cloudService();
    const hit = await captionDraft(loadDraft(fix.path).draft, opts);
    assert.equal(hit.transcript_cache, "hit");
    assert.deepEqual(second, [], "a hit must not upload anything");
    assert.equal(hit.cues, missed.cues);
    assert.deepEqual(hit.first_cue, missed.first_cue);
  });
});
