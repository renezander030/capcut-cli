/**
 * The headers CapCut's desktop app sends to its editor API, as captured from
 * one install. Both experimental cloud clients replay them: `caption --cloud`
 * (capcut-cloud-asr.ts) and `translate --cloud` / `caption --translate`
 * (capcut-cloud-translate.ts). The install's identity is written once here, so
 * when ByteDance stops accepting it there is one place to change; each client
 * keeps the signature captured with its own requests.
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
