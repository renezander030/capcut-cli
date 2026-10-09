import { writeFileSync } from "node:fs";
import type { Draft } from "./draft.js";
import { extractText, updateTextContent } from "./draft.js";

export interface TranslateOptions {
  to: string; // target language (free-form, e.g. "Spanish", "de", "Mandarin Chinese")
  from?: string; // source language; default "auto"
  apiKey?: string; // overrides ANTHROPIC_API_KEY env var
  model?: string; // default "claude-haiku-5-5"
  dryRun?: boolean;
  outPath: string; // required: where to write the translated draft
}

export interface TranslateResult {
  ok: boolean;
  count: number;
  to: string;
  from: string;
  out: string;
  pairs: Array<{ id: string; original: string; translated: string }>;
  dry_run: boolean;
}

/**
 * Translate every text segment in a draft via the Anthropic API. Writes the
 * translated draft to `outPath` so the original stays untouched (multi-language
 * shorts factory — same source, N localized renders).
 *
 * Uses built-in `fetch` (Node ≥ 18), zero runtime deps.
 */
export async function translateDraft(draft: Draft, opts: TranslateOptions): Promise<TranslateResult> {
  const cloned = JSON.parse(JSON.stringify(draft)) as Draft;
  const texts = cloned.materials.texts ?? [];
  const collected = texts
    .map((mat) => ({ id: mat.id, original: extractText(mat.content) }))
    .filter((t) => t.original && t.original.trim().length > 0);

  if (opts.dryRun || collected.length === 0) {
    writeFileSync(opts.outPath, JSON.stringify(cloned, null, 2), "utf-8");
    return {
      ok: true,
      count: collected.length,
      to: opts.to,
      from: opts.from ?? "auto",
      out: opts.outPath,
      pairs: collected.map((c) => ({ ...c, translated: c.original })),
      dry_run: true,
    };
  }

  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing API key. Set ANTHROPIC_API_KEY or pass --api-key. " +
        "Get one at https://console.anthropic.com/. (Use --dry-run to see what would be translated without calling the API.)",
    );
  }
  const model = opts.model ?? "claude-haiku-5-5";

  const translations = await callAnthropicBatch(
    apiKey,
    model,
    collected.map((c) => c.original),
    opts.to,
    opts.from ?? "auto",
  );

  const pairs: TranslateResult["pairs"] = [];
  for (let i = 0; i < collected.length; i++) {
    const original = collected[i].original;
    const translated = translations[i] ?? original;
    const mat = texts.find((m) => m.id === collected[i].id);
    if (mat) mat.content = updateTextContent(mat.content, translated);
    pairs.push({ id: collected[i].id, original, translated });
  }

  writeFileSync(opts.outPath, JSON.stringify(cloned, null, 2), "utf-8");

  return {
    ok: true,
    count: pairs.length,
    to: opts.to,
    from: opts.from ?? "auto",
    out: opts.outPath,
    pairs,
    dry_run: false,
  };
}

async function callAnthropicBatch(
  apiKey: string,
  model: string,
  texts: string[],
  to: string,
  from: string,
): Promise<string[]> {
  const prompt = [
    `Translate the following ${texts.length} text strings from ${from} to ${to}.`,
    `Preserve line breaks and punctuation. Do not add commentary, only translations.`,
    `Output a JSON array of ${texts.length} strings, same order as input. No markdown fences, just JSON.`,
    ``,
    `Input strings (JSON array):`,
    JSON.stringify(texts),
  ].join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((c) => c.type === "text")?.text ?? "";
  // The model sometimes wraps JSON in code fences despite instruction; strip them.
  const clean = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    const parsed = JSON.parse(clean) as unknown;
    if (!Array.isArray(parsed)) throw new Error(`Expected JSON array, got: ${typeof parsed}`);
    return parsed.map((x) => (typeof x === "string" ? x : String(x)));
  } catch {
    throw new Error(`Failed to parse model output as JSON array. Raw: ${clean.slice(0, 300)}`);
  }
}
