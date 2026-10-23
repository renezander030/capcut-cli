import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { pollBudgetMs, transcribeAudioCapcutCloud } from "../dist/capcut-cloud-asr.js";

// The whole upload-and-recognize exchange, offline: a stand-in fetch answers
// each CapCut endpoint the way the service does, so the flow, its error texts
// and the cue conversion are checked without a network.

const dir = mkdtempSync(join(tmpdir(), "cloud-asr-flow-"));
const audio = join(dir, "voice.mp3");
writeFileSync(audio, "fake audio bytes");
after(() => rmSync(dir, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body, init = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

// Retries and polls without the real pauses.
const FAST = { retryDelayMs: 0, pollIntervalMs: 0 };

function service(overrides = {}) {
  const calls = [];
  const answers = {
    upload_sign: () =>
      json({
        ret: "0",
        data: {
          access_key_id: "AK",
          secret_access_key: "SK",
          session_token: "ST",
          space_name: "sp",
          domain: "vod.test",
        },
      }),
    ApplyUploadInner: () =>
      json({
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
      }),
    transfer: () => json({}),
    finish: () => json({ data: { key: "key1" } }),
    CommitUploadInner: () => json({}, { headers: { "set-cookie": "odin_tt=abc123; Path=/; HttpOnly" } }),
    task_new: () => json({ ret: "0", data: { tasks: [{ id: "task1", token: "tok1" }] } }),
    task_query: () =>
      json({
        ret: "0",
        data: {
          tasks: [
            {
              id: "task1",
              status: "succeed",
              progress: 100,
              payload: JSON.stringify({
                model: "big-asr-test",
                utterances: [
                  {
                    text: " hello world ",
                    start_time: 100,
                    end_time: 900,
                    words: [
                      { text: "hello", start_time: 100, end_time: 400 },
                      { text: "  ", start_time: 400, end_time: 450 },
                      { text: "world", start_time: 450, end_time: 900 },
                    ],
                  },
                  { text: "no words", start_time: 1000, end_time: 1500 },
                ],
              }),
            },
          ],
        },
      }),
    ...overrides,
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const step = u.includes("upload_sign")
      ? "upload_sign"
      : u.includes("ApplyUploadInner")
        ? "ApplyUploadInner"
        : u.includes("phase=transfer")
          ? "transfer"
          : u.includes("phase=finish")
            ? "finish"
            : u.includes("CommitUploadInner")
              ? "CommitUploadInner"
              : u.includes("common_task/new")
                ? "task_new"
                : u.includes("common_task/query")
                  ? "task_query"
                  : "unknown";
    calls.push({ step, url: u, method: init.method, headers: init.headers ?? {}, body: init.body });
    return answers[step](init);
  };
  return calls;
}

describe("caption --cloud recognition exchange (offline)", () => {
  it("runs the six steps in order and turns utterances into µs cues and words", async () => {
    const calls = service();
    const res = await transcribeAudioCapcutCloud(audio, { durationMs: 1499.6 });
    assert.deepEqual(
      calls.map((c) => c.step),
      ["upload_sign", "ApplyUploadInner", "transfer", "finish", "CommitUploadInner", "task_new", "task_query"],
    );
    assert.equal(res.engine, "capcut-cloud");
    assert.equal(res.engine_name, "big-asr-test");
    assert.equal(res.duration_ms, 1500);
    assert.deepEqual(res.words, [
      { word: "hello", startUs: 100000, endUs: 400000 },
      { word: "world", startUs: 450000, endUs: 900000 },
    ]);
    assert.deepEqual(res.cues, [
      { startUs: 100000, endUs: 900000, text: "hello world", words: res.words },
      { startUs: 1000000, endUs: 1500000, text: "no words", words: undefined },
    ]);
    // The session cookie from the commit rides on the task calls, and the task
    // covers the real audio length.
    const taskNew = calls.find((c) => c.step === "task_new");
    assert.equal(taskNew.headers.Cookie, "odin_tt=abc123");
    assert.equal(calls.find((c) => c.step === "task_query").headers.Cookie, "odin_tt=abc123");
    const capJson = JSON.parse(JSON.parse(taskNew.body).tasks[0].payload).cap_json;
    assert.equal(capJson.duration, 1500);
    assert.deepEqual(capJson.songs_info, [{ end_time: 1500, id: "", start_time: 0 }]);
    assert.equal(capJson.audio, "vid1");
    assert.match(capJson.md5, /^[0-9a-f]{32}$/);
    const finish = calls.find((c) => c.step === "finish");
    assert.match(finish.body, /^0:[0-9a-f]{8}$/);
    assert.equal(calls.find((c) => c.step === "transfer").headers.Authorization, "auth1");
  });

  it("accepts a numeric ret 0 and an empty payload", async () => {
    service({
      upload_sign: () =>
        json({
          ret: 0,
          data: {
            access_key_id: "AK",
            secret_access_key: "SK",
            session_token: "ST",
            space_name: "sp",
            domain: "vod.test",
          },
        }),
      task_query: () => json({ ret: 0, data: { tasks: [{ id: "task1", status: "success" }] } }),
    });
    const res = await transcribeAudioCapcutCloud(audio, { durationMs: 1000 });
    assert.deepEqual(res.cues, []);
    assert.deepEqual(res.words, []);
    assert.equal(res.engine_name, "capcut-big_asr");
  });

  const failures = [
    [
      "upload_sign HTTP status",
      { upload_sign: () => json({}, { status: 503, statusText: "Busy" }) },
      "CapCut upload_sign HTTP error: 503 Busy",
    ],
    [
      "upload_sign ret",
      { upload_sign: () => json({ ret: "7", errmsg: "denied" }) },
      "CapCut upload_sign failed [ret=7]: denied",
    ],
    [
      "upload_sign ret without message",
      { upload_sign: () => json({ ret: "7" }) },
      "CapCut upload_sign failed [ret=7]: Unknown error",
    ],
    [
      "apply HTTP status",
      { ApplyUploadInner: () => json({}, { status: 403, statusText: "Forbidden" }) },
      "CapCut ApplyUploadInner HTTP error: 403 Forbidden",
    ],
    [
      "apply without nodes",
      { ApplyUploadInner: () => json({ Result: {} }) },
      "CapCut ApplyUploadInner returned no valid upload store nodes.",
    ],
    [
      "transfer HTTP status",
      { transfer: () => json({}, { status: 500, statusText: "Err" }) },
      "CapCut TOS transfer error: 500 Err",
    ],
    [
      "finish without key",
      { finish: () => json({ data: {} }) },
      "CapCut TOS upload finish did not return storage key.",
    ],
    [
      "commit HTTP status",
      { CommitUploadInner: () => json({}, { status: 502, statusText: "Bad" }) },
      "CapCut CommitUploadInner HTTP error: 502 Bad",
    ],
    [
      "task HTTP status",
      { task_new: () => json({}, { status: 429, statusText: "Slow" }) },
      "CapCut createSttTask HTTP error: 429 Slow",
    ],
    ["task ret", { task_new: () => json({ ret: "2", errmsg: "quota" }) }, "CapCut createSttTask failed [ret=2]: quota"],
    [
      "task without tasks",
      { task_new: () => json({ ret: "0", data: {} }) },
      "CapCut createSttTask returned no task details.",
    ],
    [
      "query HTTP status",
      { task_query: () => json({}, { status: 500, statusText: "Down" }) },
      "CapCut poll query HTTP error: 500 Down",
    ],
    [
      "query busy",
      { task_query: () => json({ ret: "1014", errmsg: "busy" }) },
      "CapCut Cloud ASR returned error 1014 (System Busy / Security Token). Try running without --cloud or use local whisper.",
    ],
    ["query ret", { task_query: () => json({ ret: "9", errmsg: "gone" }) }, "CapCut poll failed [ret=9]: gone"],
    [
      "query empty",
      { task_query: () => json({ ret: "0", data: { tasks: [] } }) },
      "CapCut poll query returned empty task list.",
    ],
    [
      "query failed",
      {
        task_query: () =>
          json({ ret: "0", data: { tasks: [{ id: "task1", status: "failed", err_msg: "no speech" }] } }),
      },
      "CapCut Cloud ASR processing failed: no speech",
    ],
    [
      "query bad payload",
      { task_query: () => json({ ret: "0", data: { tasks: [{ id: "task1", status: "succeed", payload: "{nope" }] } }) },
      /^Failed to parse CapCut ASR payload JSON: /,
    ],
  ];
  for (const [name, overrides, message] of failures) {
    it(`stops with the service's reason: ${name}`, async () => {
      service(overrides);
      await assert.rejects(transcribeAudioCapcutCloud(audio, { durationMs: 1000, ...FAST }), { message });
    });
  }

  it("refuses a missing file or a missing length before any request", async () => {
    const calls = service();
    await assert.rejects(transcribeAudioCapcutCloud(join(dir, "absent.mp3"), { durationMs: 1000 }), {
      message: `Audio file not found: ${join(dir, "absent.mp3")}`,
    });
    await assert.rejects(transcribeAudioCapcutCloud(audio, { durationMs: 0 }), {
      message: "CapCut Cloud ASR needs the audio length in ms (got 0).",
    });
    assert.equal(calls.length, 0);
  });
});

describe("caption --cloud recognition exchange — patience and retries", () => {
  const signResult = {
    ret: "0",
    data: { access_key_id: "AK", secret_access_key: "SK", session_token: "ST", space_name: "sp", domain: "vod.test" },
  };

  it("repeats a safe call after a 5xx or a dropped connection, then carries on", async () => {
    let signs = 0;
    let queries = 0;
    const calls = service({
      upload_sign: () => (++signs === 1 ? json({}, { status: 503, statusText: "Busy" }) : json(signResult)),
      task_query: () => {
        if (++queries === 1) throw new TypeError("fetch failed");
        return json({ ret: "0", data: { tasks: [{ id: "task1", status: "succeed", payload: "{}" }] } });
      },
    });
    const res = await transcribeAudioCapcutCloud(audio, { durationMs: 1000, ...FAST });
    assert.deepEqual(res.cues, []);
    assert.equal(calls.filter((c) => c.step === "upload_sign").length, 2);
  });

  it("never repeats the upload, its commit or the task creation", async () => {
    const calls = service({ task_new: () => json({}, { status: 502, statusText: "Bad Gateway" }) });
    await assert.rejects(transcribeAudioCapcutCloud(audio, { durationMs: 1000, ...FAST }), {
      message: "CapCut createSttTask HTTP error: 502 Bad Gateway",
    });
    for (const step of ["transfer", "finish", "CommitUploadInner", "task_new"]) {
      assert.equal(calls.filter((c) => c.step === step).length, 1, step);
    }
  });

  it("gives up on a safe call after three tries and names the step", async () => {
    const calls = service({ upload_sign: () => json({}, { status: 500, statusText: "Down" }) });
    await assert.rejects(transcribeAudioCapcutCloud(audio, { durationMs: 1000, ...FAST }), {
      message: "CapCut upload_sign HTTP error: 500 Down",
    });
    assert.equal(calls.filter((c) => c.step === "upload_sign").length, 3);
  });

  it("abandons a request that never answers", async () => {
    const hang = (init) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    service({ upload_sign: hang });
    // A real request holds a socket open; the stand-in holds nothing, and the
    // abort timer alone does not keep the process running.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      await assert.rejects(transcribeAudioCapcutCloud(audio, { durationMs: 1000, ...FAST, requestTimeoutMs: 20 }), {
        message: "CapCut upload_sign request timed out after 0.02 s (3 tries).",
      });
    } finally {
      clearInterval(keepAlive);
    }
  });

  it("waits for the recognition as long as the audio needs, then stops", async () => {
    assert.equal(pollBudgetMs(0), 120_000);
    assert.equal(pollBudgetMs(600_000), 420_000);
    assert.equal(pollBudgetMs(10 * 3_600_000), 30 * 60_000);
    let polls = 0;
    service({
      task_query: () => {
        polls++;
        return json({ ret: "0", data: { tasks: [{ id: "task1", status: "running", progress: 40 }] } });
      },
    });
    await assert.rejects(
      transcribeAudioCapcutCloud(audio, { durationMs: 1000, retryDelayMs: 0, pollIntervalMs: 5, pollBudgetMs: 40 }),
      { message: "CapCut Cloud ASR timed out after 0.04 seconds (the wait grows with the audio's length)." },
    );
    assert.ok(polls >= 2, `polled ${polls} times`);
  });
});
