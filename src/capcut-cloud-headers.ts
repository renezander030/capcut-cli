/**
 * CapCut's editor API as both experimental cloud clients call it: `caption --cloud`
 * (capcut-cloud-asr.ts) and `translate --cloud` / `caption --translate`
 * (capcut-cloud-translate.ts). It holds the headers CapCut's desktop app sends,
 * as captured from one install, and the request discipline both clients share:
 * the time limit, the retries and how a failed call is named. The install's
 * identity is written once here, so when ByteDance stops accepting it there is
 * one place to change; each client keeps the signature captured with its own
 * requests.
 */

/** The editor API host both clients call. */
export const CAPCUT_EDITOR_HOST = "editor-api-sg.capcutapi.com";

/** The per-capture part of the headers: app version, capture time and its signature. */
export interface CapcutCapturedSignature {
  appVersion: string;
  time: string; // device-time and x-khronos, Unix seconds
  sign: string;
  stub: string; // x-ss-stub
  traceId: string; // x-tt-trace-id
}

/** The full header set for one captured signature, in the order the app sends them. */
export function capcutEditorHeaders(s: CapcutCapturedSignature): Record<string, string> {
  return {
    Host: CAPCUT_EDITOR_HOST,
    "App-Sdk-Version": s.appVersion,
    "Content-Type": "application/json",
    appID: "359289",
    appvr: s.appVersion,
    ch: "capcutpc_web_product",
    "device-time": s.time,
    lan: "en",
    loc: "VN",
    pf: "4",
    sign: s.sign,
    "sign-ver": "1",
    tdid: "7522322460692940289",
    "x-ss-stub": s.stub,
    "X-SS-DP": "359289",
    "x-tt-trace-id": s.traceId,
    "User-Agent": "Cronet/TTNetVersion:488a55ee 2025-07-10 QuicVersion:55af8b7a 2024-11-18",
    "x-khronos": s.time,
  };
}

/** How long one request may take, and the pause before its first retry. */
export interface CapcutRequestTiming {
  requestTimeoutMs: number;
  /** Pause before the n-th retry is n times this. */
  retryDelayMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A duration for a message: whole seconds from one second up, fractions below. */
export const seconds = (ms: number) => (ms >= 1000 ? Math.round(ms / 1000) : ms / 1000);

/** Attempts for the calls that are safe to repeat. */
const RETRY_ATTEMPTS = 3;

/**
 * One request with a time limit. `retry` repeats a call that is safe to repeat
 * when the network fails, it times out, or the service answers 429 or 5xx,
 * pausing n x retryDelayMs before the n-th retry; a call that is not safe to
 * repeat is sent once. Any other answer is returned as is. `step` names the
 * call in the error.
 */
export async function sendCapcutRequest(
  url: string,
  init: RequestInit,
  step: string,
  t: CapcutRequestTiming,
  retry: boolean,
  timeoutMs = t.requestTimeoutMs,
): Promise<Response> {
  const attempts = retry ? RETRY_ATTEMPTS : 1;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (attempt < attempts) {
        await sleep(t.retryDelayMs * attempt);
        continue;
      }
      const error = e as Error;
      throw new Error(
        error.name === "TimeoutError"
          ? `CapCut ${step} request timed out after ${seconds(timeoutMs)} s${attempts > 1 ? ` (${attempts} tries)` : ""}.`
          : `CapCut ${step} request failed: ${error.message}`,
      );
    }
    if (!res.ok && (res.status === 429 || res.status >= 500) && attempt < attempts) {
      await sleep(t.retryDelayMs * attempt);
      continue;
    }
    return res;
  }
}

/** The editor API's answer: ret "0" (or 0) on success, data with the result. */
export interface EditorApiReply<T> {
  ret: string | number;
  errmsg: string;
  data?: T;
}

/** POST to CapCut's editor API; an HTTP failure names the step. */
export async function postEditorApi<T>(
  url: string,
  headers: Record<string, string>,
  body: string,
  step: string,
  t: CapcutRequestTiming,
  retry: boolean,
): Promise<EditorApiReply<T>> {
  const res = await sendCapcutRequest(url, { method: "POST", headers, body }, step, t, retry);
  if (!res.ok) {
    throw new Error(`CapCut ${step} HTTP error: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as EditorApiReply<T>;
}

/** The editor API answers ret "0" (or 0) on success; any other ret is its refusal. */
export function requireRetOk(reply: EditorApiReply<unknown>, step: string): void {
  if (reply.ret !== "0" && reply.ret !== 0) {
    throw new Error(`CapCut ${step} failed [ret=${reply.ret}]: ${reply.errmsg || "Unknown error"}`);
  }
}
