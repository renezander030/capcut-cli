import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { extractText, loadDraft } from "../dist/draft.js";
import { translateDraft } from "../dist/translate.js";
import { tmpDraft } from "./helpers/tmp-draft.mjs";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function response(value) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(value) }] }), { status: 200 });
}

function setup(t) {
  const fix = tmpDraft();
  t.after(fix.cleanup);
  const { draft } = loadDraft(fix.path);
  const count = draft.materials.texts.filter((mat) => extractText(mat.content).trim()).length;
  assert.ok(count > 0);
  return { fix, draft, count, out: join(fix.dir, "translated.json") };
}

describe("translation response integrity", () => {
  for (const kind of ["too few", "too many", "non-string", "object"]) {
    it(`rejects ${kind} entries before changing either source or destination`, async (t) => {
      const { fix, draft, count, out } = setup(t);
      const before = readFileSync(fix.path);
      const values = Array(count).fill("translated");
      if (kind === "too few") values.pop();
      if (kind === "too many") values.push("extra");
      if (kind === "non-string") values[0] = null;
      response(kind === "object" ? { translations: values } : values);
      writeFileSync(out, "existing output");
      await assert.rejects(
        translateDraft(draft, { to: "French", apiKey: "test-key", outPath: out }),
        /exactly \d+ strings/,
      );
      assert.deepEqual(readFileSync(fix.path), before);
      assert.equal(readFileSync(out, "utf-8"), "existing output");
      assert.deepEqual(draft, loadDraft(fix.path).draft);
    });
  }

  it("does not create a destination on invalid output", async (t) => {
    const { draft, out } = setup(t);
    response([]);
    await assert.rejects(
      translateDraft(draft, { to: "French", apiKey: "test-key", outPath: out }),
      /No translated draft was written/,
    );
    assert.equal(existsSync(out), false);
  });

  it("keeps valid translations in order and preserves literal replacement characters", async (t) => {
    const { draft, count, out } = setup(t);
    const expected = Array.from({ length: count }, (_, i) => `Texte ${i} \uFFFD`);
    response(expected);
    const result = await translateDraft(draft, { to: "French", apiKey: "test-key", outPath: out });
    assert.deepEqual(
      result.pairs.map((pair) => pair.translated),
      expected,
    );
    assert.equal(result.count, count);
    const { draft: translated } = loadDraft(out);
    assert.deepEqual(
      translated.materials.texts
        .filter((mat) => extractText(mat.content).trim())
        .map((mat) => extractText(mat.content)),
      expected,
    );
  });
});
