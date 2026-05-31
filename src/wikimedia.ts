// Wikimedia / Wikipedia / Commons download with license check.
// Zero-dep: uses Node 18+ global `fetch`.
//
// Accepted input URLs:
//   1. https://commons.wikimedia.org/wiki/File:Foo.jpg
//   2. https://en.wikipedia.org/wiki/File:Foo.jpg       (any *.wikipedia.org)
//   3. https://upload.wikimedia.org/wikipedia/commons/...Foo.jpg   (direct CDN)
//   4. https://{lang}.wikipedia.org/w/api.php?...&prop=pageimages&piprop=original   (page thumbnail)
//   5. https://commons.wikimedia.org/w/api.php?...&prop=imageinfo...                (raw API)
//
// For (1), (2), (3) we resolve to a canonical "File:Foo.jpg" title and call the
// Commons imageinfo API to get: direct `url`, `mime`, `size`, and extmetadata
// (license, artist, credit). The direct CDN URL from (3) works without API but
// we still call imageinfo so we can license-check.
// For (4), we follow the imageinfo chain from the pageimages response.
//
// User-Agent is required — Wikimedia 403s anonymous requests. Use a stable id
// so ops teams can correlate if traffic spikes.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { URL } from "node:url";

const UA = "capcut-cli/0.3 (+https://github.com/renezander030/capcut-cli/issues)";

export type LicenseClass = "permissive" | "fair-use" | "restrictive" | "unknown";

export interface WikimediaAsset {
  fileTitle: string; // e.g. "File:Barcelona_collage.jpg"
  directUrl: string; // upload.wikimedia.org CDN URL
  descriptionUrl: string; // commons page URL
  mime: string; // e.g. "image/jpeg"
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  license: {
    raw: string | null; // LicenseShortName.value or null
    class: LicenseClass;
    artist: string | null; // from extmetadata.Artist.value (may contain HTML)
    credit: string | null; // from extmetadata.Credit.value
  };
}

/** Is this a supported Wikimedia-family URL? Use as a gate before fetching. */
export function isWikimediaUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return (
      h === "commons.wikimedia.org" ||
      h === "upload.wikimedia.org" ||
      h === "meta.wikimedia.org" ||
      /(^|\.)wikipedia\.org$/.test(h)
    );
  } catch {
    return false;
  }
}

/** Classify a LicenseShortName string from extmetadata.LicenseShortName.value. */
export function classifyLicense(raw: string | null | undefined): LicenseClass {
  if (!raw) return "unknown";
  const s = raw.trim().toLowerCase();
  // Permissive: Creative Commons (CC0, CC BY, CC BY-SA, CC-PD), Public domain, no restrictions.
  // Match ahead of fair-use because "CC BY-NC" contains "nc" — that's NOT permissive.
  if (
    /^cc0\b|^cc-?0\b|^cc\s*by(\s*-?\s*sa)?(\s+\d|\s*$)|\bpublic\s*domain\b|\bpd[- ]|^pd\b|^pd$|no\s*restrictions/i.test(
      raw,
    )
  )
    return "permissive";
  if (/\bnc\b|non[- ]?commercial|\bnd\b|no[- ]?deriv/i.test(raw)) return "restrictive";
  if (/fair[- ]?use|fair[- ]?dealing|\bfu\b/i.test(raw)) return "fair-use";
  if (/©|copyright/.test(s)) return "restrictive";
  return "unknown";
}

/** Extract "File:Foo.jpg" from any accepted Wikimedia URL. null if URL is an API call that needs different handling. */
export function extractFileTitle(u: string): string | null {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase();

    // 1. upload.wikimedia.org direct CDN: /wikipedia/commons/(thumb/)?a/ab/Foo.jpg
    if (host === "upload.wikimedia.org") {
      const m = url.pathname.match(/\/wikipedia\/[^/]+\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+?)(?:\/\d+px-.+)?$/i);
      if (m) return `File:${decodeURIComponent(m[1])}`;
      return null;
    }

    // 2. commons or wikipedia /wiki/File:... page
    const wikiMatch = url.pathname.match(/\/wiki\/((?:File|Image|Media):.+)$/i);
    if (wikiMatch) return decodeURIComponent(wikiMatch[1]).replace(/^(Image|Media):/i, "File:");

    // 3. api.php with titles=File:...
    if (url.pathname.endsWith("/w/api.php") || url.pathname === "/api.php") {
      const titles = url.searchParams.get("titles");
      if (titles && /^(file|image|media):/i.test(titles)) {
        return titles.replace(/^(Image|Media):/i, "File:");
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Result wrapper for API JSON — minimal typing; we only touch a few fields.
interface ApiResponse {
  query?: {
    pages?: Record<
      string,
      {
        title?: string;
        pageid?: number;
        missing?: string;
        pageimage?: string;
        pageprops?: { page_image_free?: string };
        original?: { source?: string };
        imageinfo?: Array<{
          url?: string;
          descriptionurl?: string;
          descriptionshorturl?: string;
          mime?: string;
          size?: number;
          width?: number;
          height?: number;
          extmetadata?: Record<string, { value?: string; source?: string }>;
        }>;
      }
    >;
  };
}

async function apiGet(api: string, params: Record<string, string>): Promise<ApiResponse> {
  const url = new URL(api);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Wikimedia API HTTP ${res.status} on ${url.toString()}`);
  return (await res.json()) as ApiResponse;
}

/** Resolve a pageimages-style API URL (titles=Barcelona&prop=pageimages&piprop=original) to a File: title. */
async function resolvePageimagesApi(apiUrl: string): Promise<string> {
  const url = new URL(apiUrl);
  const api = url.origin + url.pathname;
  // Respect the caller's titles param but force piprop=original and json format.
  const titles = url.searchParams.get("titles");
  if (!titles) throw new Error("api.php URL missing titles");
  const resp = await apiGet(api, {
    action: "query",
    format: "json",
    prop: "pageimages|pageprops",
    piprop: "original",
    titles,
  });
  const pages = resp.query?.pages ?? {};
  for (const p of Object.values(pages)) {
    // pageimages returns a pageimage filename (sans File:)
    const file = p.pageimage ?? p.pageprops?.page_image_free;
    if (file) return `File:${file}`;
  }
  throw new Error(`No pageimage found for titles=${titles}`);
}

/** Call Commons imageinfo for a File: title and build a license-aware asset record. */
export async function resolveWikimediaAsset(inputUrl: string): Promise<WikimediaAsset> {
  if (!isWikimediaUrl(inputUrl)) throw new Error(`Not a Wikimedia URL: ${inputUrl}`);
  let fileTitle = extractFileTitle(inputUrl);

  // pageimages-style API call (e.g. the user's Barcelona example).
  if (!fileTitle) {
    const url = new URL(inputUrl);
    if (/\/(w\/)?api\.php$/.test(url.pathname)) {
      fileTitle = await resolvePageimagesApi(inputUrl);
    }
  }
  if (!fileTitle) throw new Error(`Could not extract a File: title from: ${inputUrl}`);

  const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
  const resp = await apiGet(COMMONS_API, {
    action: "query",
    format: "json",
    titles: fileTitle,
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
  });

  const pages = resp.query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) {
    throw new Error(`Wikimedia file not found: ${fileTitle}`);
  }
  const info = page.imageinfo?.[0];
  if (!info?.url) throw new Error(`No imageinfo returned for ${fileTitle}`);

  const ext = info.extmetadata ?? {};
  const rawLicense = ext.LicenseShortName?.value ?? ext.License?.value ?? null;
  const artistHtml = ext.Artist?.value ?? null;
  const credit = ext.Credit?.value ?? null;

  return {
    fileTitle,
    directUrl: info.url,
    descriptionUrl: info.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(fileTitle)}`,
    mime: info.mime ?? "",
    sizeBytes: info.size ?? null,
    width: info.width ?? null,
    height: info.height ?? null,
    license: {
      raw: rawLicense,
      class: classifyLicense(rawLicense),
      artist: artistHtml ? artistHtml.replace(/<[^>]+>/g, "").trim() || null : null,
      credit: credit ? credit.replace(/<[^>]+>/g, "").trim() || null : null,
    },
  };
}

/** Stream-download the asset's directUrl to destPath. Creates parent dir. */
export async function downloadAsset(asset: WikimediaAsset, destPath: string): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const res = await fetch(asset.directUrl, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Wikimedia download HTTP ${res.status} on ${asset.directUrl}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
}

export interface FetchOptions {
  forceLicense?: boolean; // override non-permissive license gate
  destDir: string; // directory to save into
  destFilename?: string; // override filename (else derived from fileTitle)
}

export interface FetchResult {
  localPath: string;
  asset: WikimediaAsset;
  warning?: string;
}

/** High-level entry: URL in, local file + metadata out, license-gated. */
export async function fetchWikimediaAsset(inputUrl: string, opts: FetchOptions): Promise<FetchResult> {
  const asset = await resolveWikimediaAsset(inputUrl);

  const cls = asset.license.class;
  if (cls === "restrictive" || cls === "unknown") {
    if (!opts.forceLicense) {
      const msg =
        cls === "restrictive"
          ? `License is restrictive ("${asset.license.raw}") — refusing. Re-run with --force-license to override (e.g. if you have separate rights or claim fair use).`
          : `License is unknown (extmetadata missing LicenseShortName) — refusing. Re-run with --force-license to proceed anyway.`;
      throw new Error(msg);
    }
  }
  const warning =
    cls === "fair-use"
      ? `License "${asset.license.raw}" indicates fair-use — usually legal for short educational content but not guaranteed. Review Commons page: ${asset.descriptionUrl}`
      : (cls === "restrictive" || cls === "unknown") && opts.forceLicense
        ? `--force-license: proceeding despite ${cls} license ("${asset.license.raw ?? "unset"}"). You take responsibility. Source: ${asset.descriptionUrl}`
        : undefined;

  // Derive filename from File:Foo.jpg if not overridden. Preserve extension.
  const filenameFromTitle = asset.fileTitle.replace(/^File:/i, "").replace(/\s+/g, "_");
  const filename = opts.destFilename ?? filenameFromTitle;
  const ext = extname(filename) || extname(new URL(asset.directUrl).pathname) || "";
  const finalName = filename.endsWith(ext) ? filename : filename + ext;
  const localPath = join(opts.destDir, finalName);

  await downloadAsset(asset, localPath);
  return { localPath, asset, warning };
}
