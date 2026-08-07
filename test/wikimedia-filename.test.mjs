import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { extractFileTitle, fetchWikimediaAsset } from "../dist/wikimedia.js";

// The download filename is derived from the URL-supplied "File:" title, and
// percent-encoded separators survive decodeURIComponent — so a crafted
// Commons URL used to name a path, not a file, and `join(destDir, name)`
// landed the download outside the assets directory.
const TRAVERSING_URL = "https://commons.wikimedia.org/wiki/File:..%2F..%2Fpwned.jpg";

const IMAGEINFO = {
  query: {
    pages: {
      42: {
        title: "File:Pwned.jpg",
        imageinfo: [
          {
            url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Pwned.jpg",
            descriptionurl: "https://commons.wikimedia.org/wiki/File:Pwned.jpg",
            mime: "image/jpeg",
            size: 4,
            extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" } },
          },
        ],
      },
    },
  },
};

// Zero-dep module on global fetch: stub it so the test never touches the network.
function stubFetch() {
  globalThis.fetch = async (url) =>
    String(url).startsWith("https://upload.wikimedia.org/")
      ? { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("jpeg").buffer }
      : { ok: true, status: 200, json: async () => IMAGEINFO };
}

describe("wikimedia: the downloaded filename cannot escape the assets directory", () => {
  const realFetch = globalThis.fetch;
  const dirs = [];
  after(() => {
    globalThis.fetch = realFetch;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function destDir() {
    const dir = mkdtempSync(join(tmpdir(), "capcut-wikimedia-"));
    dirs.push(dir);
    return join(dir, "assets", "video");
  }

  it("still decodes the traversing title (the input really is hostile)", () => {
    assert.equal(extractFileTitle(TRAVERSING_URL), "File:../../pwned.jpg");
  });

  it("saves under destDir using the last component only", async () => {
    stubFetch();
    const dest = destDir();
    const { localPath } = await fetchWikimediaAsset(TRAVERSING_URL, { destDir: dest });
    assert.equal(localPath, join(dest, "pwned.jpg"));
    assert.deepEqual(readdirSync(dest), ["pwned.jpg"]);
    assert.equal(existsSync(join(dest, "..", "..", "pwned.jpg")), false, "the download escaped destDir");
  });

  it("refuses a destFilename that resolves outside destDir", async () => {
    stubFetch();
    const dest = destDir();
    await assert.rejects(
      fetchWikimediaAsset(TRAVERSING_URL, { destDir: dest, destFilename: "../../escaped.jpg" }),
      /Refusing to write outside/,
    );
  });

  it("an ordinary title is saved exactly as before", async () => {
    stubFetch();
    const dest = destDir();
    const { localPath, asset } = await fetchWikimediaAsset(
      "https://commons.wikimedia.org/wiki/File:Barcelona collage.jpg",
      { destDir: dest },
    );
    assert.equal(localPath, join(dest, "Barcelona_collage.jpg"));
    assert.equal(asset.license.class, "permissive");
  });
});
