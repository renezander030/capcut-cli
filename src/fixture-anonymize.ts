// `fixture --anonymize` — a bundle that can be shared without disclosing the
// work it came from. Redaction (fixture.ts) removes who made a draft: home
// paths, emails, device ids. Anonymization removes what the draft is about:
// media file names and the folders they live in, the project name, and every
// caption or title. What stays is the evidence a compatibility report needs —
// the JSON structure, ids, timings, styles, the path shape of each reference
// and the length and script class of every text, so line wrapping and style
// range offsets behave as they did in the original.
//
// Files are rewritten string by string over their raw text: only the strings
// that are replaced change, so key order, whitespace and number formatting of
// everything else stay byte-identical (a parse + stringify round trip would
// normalise numbers and could lose precision on large integers).

type JsonPath = Array<string | number>;

export interface AnonymizationCounts {
  /** Distinct media files given a neutral name. */
  media_files: number;
  /** Media path and media name strings rewritten, in every mirror. */
  media_references: number;
  /** Distinct folder names replaced on media and project paths. */
  folders: number;
  /** Strings set to the neutral project name. */
  project_names: number;
  /** Text strings replaced with placeholders. */
  text_fields: number;
  /** Characters replaced inside those text strings. */
  characters: number;
}

export const NEUTRAL_PROJECT_NAME = "project";

// Folder names that say where a file sits on a standard machine or inside the
// app, never what the user is working on. They are kept so a path still shows
// whether media lives in the project, in the app's cache or on the desktop.
const GENERIC_FOLDERS = new Set(
  [
    "users",
    "user",
    "home",
    "appdata",
    "local",
    "locallow",
    "roaming",
    "library",
    "application support",
    "containers",
    "group containers",
    "data",
    "documents",
    "desktop",
    "downloads",
    "movies",
    "videos",
    "pictures",
    "music",
    "public",
    "shared",
    "volumes",
    "capcut",
    "capcut drafts",
    "jianyingpro",
    "jianyingpro drafts",
    "jianying",
    "user data",
    "projects",
    "com.lveditor.draft",
    "cache",
    "resources",
    "apps",
    "assets",
    "video",
    "audio",
    "image",
    "images",
    "photo",
    "materials",
    "media",
    "temp",
    "tmp",
    "timelines",
  ].map((name) => name.toLowerCase()),
);

// Keys on media materials that name a file on disk.
const MEDIA_PATH_KEY = /(?:^|_)path$/i;
const MEDIA_MATERIALS: Record<string, { paths: (key: string) => boolean; names: string[] }> = {
  videos: { paths: (key) => MEDIA_PATH_KEY.test(key), names: ["material_name"] },
  audios: { paths: (key) => MEDIA_PATH_KEY.test(key), names: ["name"] },
  canvases: { paths: (key) => key === "image" || key === "album_image", names: ["image_name"] },
};

// Text material fields. `content` (and `base_content`) carry CapCut's
// JSON-in-string document, whose `text` is replaced and whose `styles` ranges
// are left exactly as they are; the others hold plain words.
const TEXT_DOCUMENT_FIELDS = ["content", "base_content"];
const TEXT_PLAIN_FIELDS = ["text", "name", "recognize_text", "translate_original_text"];
const TEXT_WORD_LISTS = ["words", "current_words"];

const CJK = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}]/u;
const LETTER = /\p{L}/u;
const UPPER = /[\p{Lu}\p{Lt}]/u;
const DIGIT = /\p{Nd}/u;
// One placeholder per script, so a right-to-left or shaped script stays one.
const SCRIPT_PLACEHOLDERS: Array<{ test: RegExp; lower: string; upper: string }> = [
  { test: /\p{Script=Latin}/u, lower: "x", upper: "X" },
  { test: /\p{Script=Greek}/u, lower: "ω", upper: "Ω" },
  { test: /\p{Script=Cyrillic}/u, lower: "я", upper: "Я" },
  { test: /\p{Script=Arabic}/u, lower: "ب", upper: "ب" },
  { test: /\p{Script=Hebrew}/u, lower: "א", upper: "א" },
  { test: /\p{Script=Thai}/u, lower: "ก", upper: "ก" },
  { test: /\p{Script=Devanagari}/u, lower: "क", upper: "क" },
];

/**
 * Replace every letter and digit with a placeholder of the same UTF-16 length
 * and script class: CJK ideographs, kana and Hangul become 字, Latin letters
 * x/X by case (full-width ones ｘ/Ｘ), digits 0. Whitespace, punctuation,
 * symbols and combining marks are kept, so the string keeps its length in code
 * units (the unit CapCut's style ranges count) and its line-break opportunities.
 */
export function maskText(text: string): { text: string; replaced: number } {
  let out = "";
  let replaced = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const astral = cp > 0xffff;
    let next = ch;
    if (LETTER.test(ch)) {
      const upper = UPPER.test(ch);
      const script = SCRIPT_PLACEHOLDERS.find((s) => s.test.test(ch));
      // Astral letters get astral placeholders, so the UTF-16 length holds.
      if (CJK.test(ch)) next = astral ? "\u{20000}" : "字";
      else if (astral) next = upper ? "\u{1D417}" : "\u{1D431}";
      else if (cp >= 0xff21 && cp <= 0xff5a) next = upper ? "Ｘ" : "ｘ";
      else if (script) next = upper ? script.upper : script.lower;
      else next = upper ? "X" : "x";
    } else if (DIGIT.test(ch)) {
      next = astral ? "\u{1D7CE}" : cp >= 0xff10 && cp <= 0xff19 ? "０" : "0";
    }
    if (next !== ch) replaced++;
    out += next;
  }
  return { text: out, replaced };
}

// Markup content (the legacy `<font …>[text]</font>` form, SSML) keeps its
// tags and has the text between them masked; anything else is plain text.
function maskMarkup(value: string): { text: string; replaced: number } {
  if (!value.trimStart().startsWith("<")) return maskText(value);
  let replaced = 0;
  const text = value.replace(/(<[^>]*>)|[^<]+/g, (whole, tag: string | undefined) => {
    if (tag) return tag;
    const r = maskText(whole);
    replaced += r.replaced;
    return r.text;
  });
  return { text, replaced };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimeline(value: Record<string, unknown>): boolean {
  return Array.isArray(value.tracks) && isPlainObject(value.materials);
}

function isProjectMeta(value: Record<string, unknown>): boolean {
  return Array.isArray(value.draft_materials) || "draft_fold_path" in value || "draft_name" in value;
}

function parseEmbedded(value: string): unknown {
  const t = value.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-emit `raw` (valid JSON) with the string values at the given paths
 * replaced, every other byte unchanged. Keys of `edits` are JSON-encoded paths.
 */
export function replaceJsonStrings(raw: string, edits: ReadonlyMap<string, string>): string {
  if (edits.size === 0) return raw;
  const parts: string[] = [];
  let last = 0;
  let i = 0;
  const path: JsonPath = [];
  const skipSpace = (): void => {
    while (i < raw.length && (raw[i] === " " || raw[i] === "\n" || raw[i] === "\r" || raw[i] === "\t")) i++;
  };
  const stringEnd = (): number => {
    let j = i + 1;
    while (j < raw.length) {
      const c = raw.charCodeAt(j);
      if (c === 0x5c) j += 2;
      else if (c === 0x22) return j + 1;
      else j++;
    }
    throw new Error("Unterminated JSON string");
  };
  const value = (): void => {
    skipSpace();
    const c = raw[i];
    if (c === "{") {
      i++;
      skipSpace();
      if (raw[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        skipSpace();
        const end = stringEnd();
        const key = JSON.parse(raw.slice(i, end)) as string;
        i = end;
        skipSpace();
        i++; // ':'
        path.push(key);
        value();
        path.pop();
        skipSpace();
        if (raw[i++] === "}") return;
      }
    }
    if (c === "[") {
      i++;
      skipSpace();
      if (raw[i] === "]") {
        i++;
        return;
      }
      for (let index = 0; ; index++) {
        path.push(index);
        value();
        path.pop();
        skipSpace();
        if (raw[i++] === "]") return;
      }
    }
    if (c === '"') {
      const end = stringEnd();
      const edit = edits.get(JSON.stringify(path));
      if (edit !== undefined) {
        parts.push(raw.slice(last, i), JSON.stringify(edit));
        last = end;
      }
      i = end;
      return;
    }
    while (i < raw.length && !",]} \n\r\t".includes(raw[i])) i++;
  };
  value();
  parts.push(raw.slice(last));
  return parts.join("");
}

/**
 * One anonymizer per bundle: the same media file, folder and project name map
 * to the same neutral name in every file it rewrites.
 */
export class BundleAnonymizer {
  private readonly projectNames: Set<string>;
  private readonly media = new Map<string, string>();
  private readonly mediaNames = new Map<string, string>();
  private readonly folders = new Map<string, string>();
  private readonly counts: AnonymizationCounts = {
    media_files: 0,
    media_references: 0,
    folders: 0,
    project_names: 0,
    text_fields: 0,
    characters: 0,
  };

  /** `projectNames`: the project folder's name and the draft's display names. */
  constructor(projectNames: Iterable<string>) {
    this.projectNames = new Set([...projectNames].filter((name) => name.length > 0));
  }

  summary(): AnonymizationCounts {
    return { ...this.counts, media_files: this.media.size + this.mediaNames.size, folders: this.folders.size };
  }

  /** Anonymize one bundled file's text; text that is not JSON is returned unchanged. */
  anonymizeDocument(raw: string): string {
    let root: unknown;
    try {
      root = JSON.parse(raw);
    } catch {
      return raw;
    }
    const edits = new Map<string, string>();
    this.walk(root, [], edits, false);
    return replaceJsonStrings(raw, edits);
  }

  /** A folder path shown in the report (source or output directory). */
  anonymizeFolderPath(value: string): string {
    return this.folderPath(value);
  }

  private walk(node: unknown, path: JsonPath, edits: Map<string, string>, insideMaterials: boolean): void {
    if (Array.isArray(node)) {
      node.forEach((child, index) => {
        this.walk(child, [...path, index], edits, insideMaterials);
      });
      return;
    }
    if (typeof node === "string") {
      const key = JSON.stringify(path);
      if (edits.has(key) || !/^\s*[{[]/.test(node)) return;
      // Whole timeline documents nested as string-JSON (template-2.tmp).
      const next = this.anonymizeDocument(node);
      if (next !== node) edits.set(key, next);
      return;
    }
    if (!isPlainObject(node)) return;
    if (isTimeline(node)) this.timeline(node, path, edits, insideMaterials);
    if (isProjectMeta(node)) this.projectMeta(node, path, edits);
    for (const [key, child] of Object.entries(node)) {
      this.walk(child, [...path, key], edits, insideMaterials || key === "materials");
    }
  }

  private set(edits: Map<string, string>, path: JsonPath, value: string): void {
    edits.set(JSON.stringify(path), value);
  }

  private timeline(draft: Record<string, unknown>, path: JsonPath, edits: Map<string, string>, nested: boolean) {
    if (typeof draft.name === "string" && draft.name !== "") {
      if (nested) this.maskPlain(draft.name, [...path, "name"], edits);
      else {
        this.set(edits, [...path, "name"], NEUTRAL_PROJECT_NAME);
        this.counts.project_names++;
      }
    }
    if (typeof draft.path === "string" && draft.path !== "") {
      this.set(edits, [...path, "path"], this.folderPath(draft.path));
    }
    const materials = draft.materials as Record<string, unknown>;
    for (const [kind, rule] of Object.entries(MEDIA_MATERIALS)) {
      const list = materials[kind];
      if (!Array.isArray(list)) continue;
      list.forEach((material, index) => {
        if (!isPlainObject(material)) return;
        const at = [...path, "materials", kind, index];
        let neutral: string | null = null;
        for (const [key, value] of Object.entries(material)) {
          if (typeof value !== "string" || value === "" || !rule.paths(key)) continue;
          const next = this.mediaPath(value);
          if (key === "path" || key === "image") neutral = baseName(next);
          this.set(edits, [...at, key], next);
          this.counts.media_references++;
        }
        for (const key of rule.names) {
          const value = material[key];
          if (typeof value !== "string" || value === "") continue;
          this.set(edits, [...at, key], neutral ?? this.mediaName(value));
          this.counts.media_references++;
        }
      });
    }
    const texts = materials.texts;
    if (!Array.isArray(texts)) return;
    texts.forEach((material, index) => {
      if (!isPlainObject(material)) return;
      const at = [...path, "materials", "texts", index];
      for (const key of TEXT_DOCUMENT_FIELDS) {
        const value = material[key];
        if (typeof value === "string" && value !== "") this.maskDocument(value, [...at, key], edits);
      }
      for (const key of TEXT_PLAIN_FIELDS) {
        const value = material[key];
        if (typeof value === "string" && value !== "") this.maskPlain(value, [...at, key], edits);
      }
      if (typeof material.ssml_content === "string" && material.ssml_content !== "") {
        const r = maskMarkup(material.ssml_content);
        this.record(edits, [...at, "ssml_content"], material.ssml_content, r);
      }
      for (const list of TEXT_WORD_LISTS) {
        const words = isPlainObject(material[list]) ? (material[list] as Record<string, unknown>).text : undefined;
        if (!Array.isArray(words)) continue;
        words.forEach((word, wordIndex) => {
          if (typeof word === "string" && word !== "") this.maskPlain(word, [...at, list, "text", wordIndex], edits);
        });
      }
    });
  }

  private projectMeta(meta: Record<string, unknown>, path: JsonPath, edits: Map<string, string>): void {
    if (typeof meta.draft_name === "string" && meta.draft_name !== "") {
      this.set(edits, [...path, "draft_name"], NEUTRAL_PROJECT_NAME);
      this.counts.project_names++;
    }
    for (const key of ["draft_fold_path", "draft_root_path"]) {
      const value = meta[key];
      if (typeof value === "string" && value !== "") this.set(edits, [...path, key], this.folderPath(value));
    }
    if (!Array.isArray(meta.draft_materials)) return;
    meta.draft_materials.forEach((group, groupIndex) => {
      const entries = isPlainObject(group) ? group.value : undefined;
      if (!Array.isArray(entries)) return;
      entries.forEach((entry, index) => {
        if (!isPlainObject(entry)) return;
        const at = [...path, "draft_materials", groupIndex, "value", index];
        let neutral: string | null = null;
        if (typeof entry.file_Path === "string" && entry.file_Path !== "") {
          const next = this.mediaPath(entry.file_Path);
          neutral = baseName(next);
          this.set(edits, [...at, "file_Path"], next);
          this.counts.media_references++;
        }
        if (typeof entry.extra_info === "string" && entry.extra_info !== "") {
          this.set(edits, [...at, "extra_info"], neutral ?? this.mediaName(entry.extra_info));
          this.counts.media_references++;
        }
      });
    });
  }

  private maskPlain(value: string, path: JsonPath, edits: Map<string, string>): void {
    this.record(edits, path, value, maskText(value));
  }

  // CapCut's text document: `{"text": …, "styles": [{"range": [a, b], …}]}`
  // as a string. Only `text` changes; the styles keep their bytes.
  private maskDocument(value: string, path: JsonPath, edits: Map<string, string>): void {
    const doc = parseEmbedded(value);
    if (isPlainObject(doc)) {
      if (typeof doc.text !== "string" || doc.text === "") return;
      const r = maskText(doc.text);
      const inner = replaceJsonStrings(value, new Map([[JSON.stringify(["text"]), r.text]]));
      this.record(edits, path, value, { text: inner, replaced: r.replaced });
      return;
    }
    this.record(edits, path, value, maskMarkup(value));
  }

  private record(
    edits: Map<string, string>,
    path: JsonPath,
    before: string,
    after: { text: string; replaced: number },
  ): void {
    if (after.text === before) return;
    this.set(edits, path, after.text);
    this.counts.text_fields++;
    this.counts.characters += after.replaced;
  }

  private nextMediaName(original: string): string {
    const n = this.media.size + this.mediaNames.size + 1;
    return `media-${String(n).padStart(3, "0")}${extensionOf(original)}`;
  }

  // The same file maps to one neutral name whatever separators a mirror uses.
  private mediaName(nameOrPath: string): string {
    const key = normalisePath(nameOrPath);
    const known = this.media.get(key) ?? this.mediaNames.get(key);
    if (known) return known;
    const name = this.nextMediaName(baseName(nameOrPath));
    this.mediaNames.set(key, name);
    return name;
  }

  private mediaPath(value: string): string {
    const key = normalisePath(value);
    let name = this.media.get(key);
    if (!name) {
      name = this.nextMediaName(baseName(value));
      this.media.set(key, name);
    }
    const parts = value.split(/([\\/]+)/);
    parts[parts.length - 1] = name;
    for (let i = 0; i < parts.length - 1; i += 2) parts[i] = this.folder(parts[i]);
    return parts.join("");
  }

  private folderPath(value: string): string {
    const parts = value.split(/([\\/]+)/);
    for (let i = 0; i < parts.length; i += 2) parts[i] = this.folder(parts[i]);
    return parts.join("");
  }

  private folder(segment: string): string {
    if (segment === "" || segment === "." || segment === ".." || segment === "USER") return segment;
    if (/^[A-Za-z]:$/.test(segment) || /^##_.*_##$/.test(segment)) return segment;
    if (this.projectNames.has(segment)) return NEUTRAL_PROJECT_NAME;
    if (GENERIC_FOLDERS.has(segment.toLowerCase())) return segment;
    let name = this.folders.get(segment);
    if (!name) {
      name = `folder-${String(this.folders.size + 1).padStart(3, "0")}`;
      this.folders.set(segment, name);
    }
    return name;
  }
}

function normalisePath(value: string): string {
  return value.replace(/[\\/]+/g, "/");
}

function baseName(value: string): string {
  const parts = value.split(/[\\/]+/);
  return parts[parts.length - 1] ?? value;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}
