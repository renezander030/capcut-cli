import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { CaptionCue, CaptionWord } from "./caption.js";

/** CRC32 lookup table for upload verification. */
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[i] = c;
}

/** Pure CRC32 hex string calculation (zero external dependencies). */
export function crc32(buf: Uint8Array): string {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return ((crc ^ -1) >>> 0).toString(16).padStart(8, "0");
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Uint8Array, data: string, encoding?: "hex"): Buffer | string {
  const h = createHmac("sha256", key).update(data, "utf8");
  return encoding === "hex" ? h.digest("hex") : h.digest();
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface AwsSignV4Options {
  host: string;
  path: string;
  service?: string;
  region?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface AwsCredentials {
  access_key_id: string;
  secret_access_key: string;
  session_token?: string;
}

/**
 * Pure TypeScript AWS Signature v4 signer (zero-dependency replacement for `aws4`).
 * Conforms exactly to AWS SigV4 specification with ASCII-ordered canonical headers and queries.
 */
export function signAwsV4(
  opts: AwsSignV4Options,
  creds: AwsCredentials,
  now: Date = new Date(),
): { headers: Record<string, string>; url: string } {
  const method = (opts.method || "GET").toUpperCase();
  const service = opts.service || "vod";
  const region = opts.region || "sg";
  const body = opts.body || "";

  const amzDate =
    opts.headers?.["X-Amz-Date"] || opts.headers?.["x-amz-date"] || now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.substring(0, 8);

  const headers: Record<string, string> = { ...(opts.headers || {}) };
  headers["Host"] = opts.host;
  headers["X-Amz-Date"] = amzDate;
  if (creds.session_token) {
    headers["x-amz-security-token"] = creds.session_token;
  }

  // Canonical headers sorted by ASCII code point
  const filtered = Object.keys(headers)
    .map((k) => [k.toLowerCase(), headers[k]] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalHeaders = filtered.map(([k, v]) => `${k}:${v.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = filtered.map(([k]) => k).join(";");

  // Path & Canonical query (ASCII sorted)
  const urlObj = new URL(`https://${opts.host}${opts.path}`);
  const pathname = urlObj.pathname;

  const queryParams: Array<[string, string]> = [];
  urlObj.searchParams.forEach((v, k) => {
    queryParams.push([encodeRfc3986(k), encodeRfc3986(v)]);
  });
  queryParams.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = queryParams.map(([k, v]) => `${k}=${v}`).join("&");

  const payloadHash = sha256(body);
  const canonicalRequest = `${method}\n${pathname}\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256(canonicalRequest)}`;

  const kDate = hmac(`AWS4${creds.secret_access_key}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign, "hex");

  headers["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${creds.access_key_id}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers, url: urlObj.toString() };
}

export const DEFAULT_CAPCUT_HEADERS: Record<string, string> = {
  Host: "editor-api-sg.capcutapi.com",
  "App-Sdk-Version": "8.4.0",
  "Content-Type": "application/json",
  appID: "359289",
  appvr: "8.4.0",
  ch: "capcutpc_web_product",
  "device-time": "1776674107",
  lan: "en",
  loc: "VN",
  pf: "4",
  sign: "4a60da398f60fefd56083e55ac9eda17",
  "sign-ver": "1",
  tdid: "7522322460692940289",
  "x-ss-stub": "e8eff844fa0457999a30b4d5f6572dff",
  "X-SS-DP": "359289",
  "x-tt-trace-id": "00-aa077272106864a86c4b8b8601bcffff-aa077272106864a801",
  "User-Agent": "Cronet/TTNetVersion:488a55ee 2025-07-10 QuicVersion:55af8b7a 2024-11-18",
  "x-khronos": "1776674107",
};

export interface CloudAsrWord {
  text: string;
  start_time: number; // ms
  end_time: number; // ms
  attribute?: Record<string, unknown>;
}

export interface CloudAsrUtterance {
  text: string;
  start_time: number; // ms
  end_time: number; // ms
  words?: CloudAsrWord[];
  attribute?: Record<string, unknown>;
}

export interface CloudAsrPayload {
  utterances?: CloudAsrUtterance[];
  url?: string;
  model?: string;
  duration?: number;
}

export interface CloudAsrOptions {
  durationMs?: number;
  verbose?: boolean;
  onProgress?: (progress: number, status: string) => void;
}

export interface CloudAsrResult {
  cues: CaptionCue[];
  words: CaptionWord[];
  engine: "capcut-cloud";
  engine_name: string;
  duration_ms?: number;
}

interface UploadSignatureData {
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  space_name: string;
  domain: string;
}

interface ApplyUploadResult {
  oid: string;
  host: string;
  auth: string;
  sessionKey: string;
  vid: string;
  uploadId: string;
}

/** Step 1: Request upload signature from CapCut Web API. */
async function getUploadSignature(): Promise<UploadSignatureData> {
  const url = "https://editor-api-sg.capcutapi.com/lv/v1/upload_sign?aid=359289&device_platform=windows";
  const body = JSON.stringify({ biz: "cc_pc_text_recognize", key_version: "v5" });
  const res = await fetch(url, {
    method: "POST",
    headers: DEFAULT_CAPCUT_HEADERS,
    body,
  });
  if (!res.ok) {
    throw new Error(`CapCut upload_sign HTTP error: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { ret: string; errmsg: string; data: UploadSignatureData };
  if (json.ret !== "0" && json.ret !== (0 as unknown as string)) {
    throw new Error(`CapCut upload_sign failed [ret=${json.ret}]: ${json.errmsg || "Unknown error"}`);
  }
  return json.data;
}

/** Step 2: Apply for upload node and storage location via ByteDance VOD. */
async function applyUpload(creds: UploadSignatureData): Promise<ApplyUploadResult> {
  const path = `/top/v1?Action=ApplyUploadInner&SpaceName=${creds.space_name}&UseQuic=false&Version=2020-11-19&device_platform=win`;
  const signed = signAwsV4(
    {
      host: creds.domain,
      path,
      service: "vod",
      region: "sg",
      method: "GET",
      headers: { "x-amz-security-token": creds.session_token },
    },
    creds,
  );

  const res = await fetch(signed.url, {
    method: "GET",
    headers: signed.headers,
  });
  if (!res.ok) {
    throw new Error(`CapCut ApplyUploadInner HTTP error: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    Result?: {
      Results?: Array<{
        Vid: string;
        UploadHost: string;
        SessionKey: string;
        StoreInfos: Array<{ StoreUri: string; Auth: string; UploadID: string }>;
      }>;
      InnerUploadAddress?: {
        UploadNodes?: Array<{
          Vid: string;
          UploadHost: string;
          SessionKey: string;
          StoreInfos: Array<{ StoreUri: string; Auth: string; UploadID: string }>;
        }>;
      };
    };
  };

  const node = json.Result?.Results?.[0] || json.Result?.InnerUploadAddress?.UploadNodes?.[0];
  if (!node?.StoreInfos?.[0]) {
    throw new Error("CapCut ApplyUploadInner returned no valid upload store nodes.");
  }

  return {
    oid: node.StoreInfos[0].StoreUri,
    host: node.UploadHost,
    auth: node.StoreInfos[0].Auth,
    sessionKey: node.SessionKey,
    vid: node.Vid,
    uploadId: node.StoreInfos[0].UploadID,
  };
}

/** Step 3: Upload binary audio content to TOS storage bucket. */
async function uploadBinary(applyData: ApplyUploadResult, fileBuffer: Buffer): Promise<string> {
  const hash = crc32(fileBuffer);
  const authHeaders = { Authorization: applyData.auth };

  // 3.1 Transfer
  const transferUrl = `https://${applyData.host}/upload/v1/${applyData.oid}?uploadid=${applyData.uploadId}&part_number=0&phase=transfer`;
  const transferRes = await fetch(transferUrl, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/octet-stream",
      "X-Upload-Content-CRC32": hash,
    },
    body: new Uint8Array(fileBuffer),
  });
  if (!transferRes.ok) {
    throw new Error(`CapCut TOS transfer error: ${transferRes.status} ${transferRes.statusText}`);
  }

  // 3.2 Finish
  const finishUrl = `https://${applyData.host}/upload/v1/${applyData.oid}?uploadmode=part&phase=finish&uploadid=${applyData.uploadId}`;
  const finishBody = `0:${hash}`;
  const finishRes = await fetch(finishUrl, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "text/plain",
    },
    body: finishBody,
  });
  if (!finishRes.ok) {
    throw new Error(`CapCut TOS finish error: ${finishRes.status} ${finishRes.statusText}`);
  }

  const finishData = (await finishRes.json()) as { data?: { key?: string } };
  const key = finishData.data?.key;
  if (!key) {
    throw new Error("CapCut TOS upload finish did not return storage key.");
  }
  return key;
}

/** Step 4: Commit uploaded object to ByteDance VOD. */
async function commitUpload(
  applyData: ApplyUploadResult,
  storeKey: string,
  creds: UploadSignatureData,
): Promise<{ cookie?: string }> {
  const body = JSON.stringify({
    Functions: [
      {
        Input: { SnapshotTime: 0.0 },
        Name: "Snapshot",
      },
    ],
    SessionKey: applyData.sessionKey,
    SuccessOids: [storeKey],
  });

  const path =
    "/top/v1?Action=CommitUploadInner&SpaceName=cc_pc_text_recognize_sg&Version=2020-11-19&device_platform=win";
  const signed = signAwsV4(
    {
      host: creds.domain,
      path,
      service: "vod",
      region: "sdwdmwlll",
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "x-amz-security-token": creds.session_token,
      },
    },
    creds,
  );

  const res = await fetch(signed.url, {
    method: "POST",
    headers: signed.headers,
    body,
  });
  if (!res.ok) {
    throw new Error(`CapCut CommitUploadInner HTTP error: ${res.status} ${res.statusText}`);
  }

  const setCookie = res.headers.get("set-cookie");
  let cookie: string | undefined;
  if (setCookie?.includes("odin_tt=")) {
    cookie = setCookie
      .split(";")
      .find((c) => c.trim().startsWith("odin_tt="))
      ?.trim();
  }
  return { cookie };
}

/** Step 5: Dispatch ASR task to CapCut speech recognition engine. */
async function createSttTask(
  vid: string,
  md5: string,
  duration: number,
  cookie?: string,
): Promise<{ id: string; token: string }> {
  const url =
    "https://editor-api-sg.capcutapi.com/lv/v1/common_task/new?device_brand=Apple%20Inc.&device_id=7522322460692940299&iid=7630752366099744533&aid=359289&region=VN&device_platform=windows&babi_param=%7B%22feature_entrance%22%3A%22editor%22%2C%22feature_entrance_detail%22%3A%22editor-elements-captions-subtitle_recognition%22%2C%22feature_key%22%3A%22subtitle_recognition%22%2C%22scenario%22%3A%22video_editor%22%7D&app_name=CapCut&device_type=&channel=capcutpc_web_product&os_version=10.0.19045&version_code=8.4.0&version_name=8.4.0";

  const payloadObj = {
    cap_json: {
      adjust_endtime: 200,
      audio: vid,
      audio_type: "vid",
      caption_type: 0,
      client_request_id: randomUUID(),
      duration,
      enable_cache: true,
      enter_from: "asr",
      max_lines: 1,
      md5,
      pack_options: { need_attribute: true },
      songs_info: [{ end_time: duration, id: "", start_time: 0 }],
      words_per_line: 16,
    },
  };

  const body = JSON.stringify({
    bind_id: randomUUID(),
    can_queue: true,
    enter_from: "asr",
    tasks: [
      {
        context: randomUUID(),
        payload: JSON.stringify(payloadObj),
        req_key: "cc_audio_subtitle_asr",
        task_version: "v3",
      },
    ],
  });

  const headers: Record<string, string> = {
    ...DEFAULT_CAPCUT_HEADERS,
    "device-time": "1776678395",
    sign: "3df5bc111ef176f926d0b6c66f9f7eb4",
    "x-khronos": "1776678395",
    "x-ss-stub": "4b0dc88314b75c0076c15eb3cc096ed1",
  };
  if (cookie) headers["Cookie"] = cookie;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body,
  });
  if (!res.ok) {
    throw new Error(`CapCut createSttTask HTTP error: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as {
    ret: string;
    errmsg: string;
    data?: { tasks?: Array<{ id: string; token: string }> };
  };
  if (json.ret !== "0" && json.ret !== (0 as unknown as string)) {
    throw new Error(`CapCut createSttTask failed [ret=${json.ret}]: ${json.errmsg || "Unknown error"}`);
  }

  const task = json.data?.tasks?.[0];
  if (!task) throw new Error("CapCut createSttTask returned no task details.");
  return { id: task.id, token: task.token };
}

/** Step 6: Poll ASR task until completion and parse recognized utterances & words. */
async function pollSttStatus(
  taskId: string,
  token: string,
  cookie?: string,
  opts?: CloudAsrOptions,
): Promise<CloudAsrPayload> {
  const url = "https://editor-api-sg.capcutapi.com/lv/v1/common_task/query?aid=359289&device_platform=windows";
  const body = JSON.stringify({
    tasks: [{ id: taskId, req_key: "cc_audio_subtitle_asr", task_version: "v3", token }],
  });

  const queryHeaders: Record<string, string> = {
    ...DEFAULT_CAPCUT_HEADERS,
    "device-time": "1776678404",
    sign: "5f384ae9f9123089816212dcaffa067b",
    "x-ss-stub": "71303c871aabb30c9e7b634d2e6d8b5a",
    "x-khronos": "1776678404",
  };
  if (cookie) queryHeaders["Cookie"] = cookie;

  const maxAttempts = 60; // 60 x 2s = 120s timeout
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: queryHeaders,
      body,
    });
    if (!res.ok) {
      throw new Error(`CapCut poll query HTTP error: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      ret: string;
      errmsg: string;
      data?: {
        tasks?: Array<{
          id: string;
          status: string;
          progress?: number;
          payload?: string;
          detail_info?: string;
          err_msg?: string;
        }>;
      };
    };

    if (json.ret === "1014") {
      throw new Error(
        "CapCut Cloud ASR returned error 1014 (System Busy / Security Token). Try running without --cloud or use local whisper.",
      );
    }
    if (json.ret !== "0" && json.ret !== (0 as unknown as string)) {
      throw new Error(`CapCut poll failed [ret=${json.ret}]: ${json.errmsg || "Unknown error"}`);
    }

    const task = json.data?.tasks?.[0];
    if (!task) throw new Error("CapCut poll query returned empty task list.");

    const progress = task.progress || 0;
    const status = task.status;
    opts?.onProgress?.(progress, status);

    if (status === "succeed" || status === "success" || progress === 100) {
      const rawPayload = task.payload || task.detail_info;
      if (!rawPayload) return { utterances: [] };
      try {
        return JSON.parse(rawPayload) as CloudAsrPayload;
      } catch (e) {
        throw new Error(`Failed to parse CapCut ASR payload JSON: ${(e as Error).message}`);
      }
    }

    if (status === "failed") {
      throw new Error(`CapCut Cloud ASR processing failed: ${task.err_msg || "Unknown error"}`);
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  throw new Error("CapCut Cloud ASR timed out after 120 seconds.");
}

/**
 * Perform end-to-end Speech-to-Text transcription via CapCut's official cloud ASR service.
 * Returns word timings with microsecond precision and sentence-level cues.
 */
export async function transcribeAudioCapcutCloud(audioPath: string, opts?: CloudAsrOptions): Promise<CloudAsrResult> {
  if (!existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const fileBuffer = readFileSync(audioPath);
  const md5 = createHash("md5").update(fileBuffer).digest("hex");
  const durationMs = opts?.durationMs ?? 200000;

  // 1. Sign
  const creds = await getUploadSignature();

  // 2. Apply upload
  const applyData = await applyUpload(creds);

  // 3. Upload binary
  const storeKey = await uploadBinary(applyData, fileBuffer);

  // 4. Commit upload
  const { cookie } = await commitUpload(applyData, storeKey, creds);

  // 5. Create STT task
  const taskInfo = await createSttTask(applyData.vid, md5, durationMs, cookie);

  // 6. Poll status
  const payload = await pollSttStatus(taskInfo.id, taskInfo.token, cookie, opts);

  const utterances = payload.utterances || [];
  const cues: CaptionCue[] = [];
  const words: CaptionWord[] = [];

  for (const u of utterances) {
    const cueWords: CaptionWord[] = [];
    if (Array.isArray(u.words)) {
      for (const w of u.words) {
        const text = (w.text || "").trim();
        if (!text) continue;
        const startUs = Math.round((w.start_time || 0) * 1000);
        const endUs = Math.round((w.end_time || 0) * 1000);
        const wordObj: CaptionWord = { word: text, startUs, endUs };
        cueWords.push(wordObj);
        words.push(wordObj);
      }
    }

    const cueStartUs = Math.round((u.start_time || 0) * 1000);
    const cueEndUs = Math.round((u.end_time || 0) * 1000);
    cues.push({
      startUs: cueStartUs,
      endUs: cueEndUs,
      text: (u.text || "").trim(),
      words: cueWords.length > 0 ? cueWords : undefined,
    });
  }

  return {
    cues,
    words,
    engine: "capcut-cloud",
    engine_name: payload.model || "capcut-big_asr",
    duration_ms: durationMs,
  };
}
