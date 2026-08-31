// Capability-free extraction of capcut-cli's deterministic draft analysis.
//
// Deliberately no imports: JSON values are the only input, and the generated
// Component Model world is built with every ambient capability disabled.

const PORTABLE_CHECKS = [
  "missing-material",
  "dangling-companion-ref",
  "cue-too-long",
  "caption-too-fast",
  "caption-outside-safe-area",
  "caption-overlap",
];

const DEFAULT_LINT_OPTIONS = {
  maxCueDurationUs: 7_000_000,
  maxCharsPerSecond: 20,
  safeAreaFraction: 0.85,
};

function parseDraft(json, label) {
  let draft;
  try {
    draft = JSON.parse(json);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!draft || typeof draft !== "object") throw new Error(`${label} must be a JSON object`);
  if (!Array.isArray(draft.tracks)) throw new Error(`${label}.tracks must be an array`);
  if (!draft.materials || typeof draft.materials !== "object") {
    throw new Error(`${label}.materials must be an object`);
  }
  return draft;
}

function ok(value) {
  return JSON.stringify(value);
}

function fail(error) {
  // ComponentizeJS maps a thrown string to WIT result.err. Throwing an Error
  // object crosses the generated ABI less predictably across toolchain builds.
  throw (error instanceof Error ? error.message : String(error));
}

function getMaterialTypes(draft) {
  return Object.entries(draft.materials)
    .filter(([, value]) => Array.isArray(value))
    .map(([type, items]) => ({ type, count: items.length }))
    .sort((a, b) => b.count - a.count);
}

function inspect(draftJson) {
  try {
    const draft = parseDraft(draftJson, "draft-json");
    const totalSegments = draft.tracks.reduce(
      (count, track) => count + (Array.isArray(track.segments) ? track.segments.length : 0),
      0,
    );
    const materialTypes = getMaterialTypes(draft);
    const materialTypesWithItems = materialTypes.filter((material) => material.count > 0);
    const canvas = draft.canvas_config ?? {};
    return ok({
      id: draft.id,
      name: draft.name || draft.id,
      duration_us: draft.duration,
      fps: draft.fps,
      width: canvas.width,
      height: canvas.height,
      ratio: canvas.ratio,
      tracks: draft.tracks.length,
      segments: totalSegments,
      platform: draft.platform
        ? `${draft.platform.app_source === "cc" ? "CapCut" : "JianYing"} ${draft.platform.app_version}`
        : null,
      material_types: materialTypes.length,
      materials_with_items: materialTypesWithItems.length,
      material_summary: materialTypesWithItems.map((material) => ({
        type: material.type,
        count: material.count,
      })),
    });
  } catch (error) {
    return fail(error);
  }
}

function extractText(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed.text) return parsed.text;
  } catch {
    return String(content ?? "")
      .replace(/<[^>]*>/g, "")
      .replace(/\[|\]/g, "")
      .trim();
  }
  return content;
}

function findMaterial(items, id) {
  return (items ?? []).find((material) => material.id === id);
}

function materialIds(draft) {
  const ids = new Set();
  for (const items of Object.values(draft.materials)) {
    if (!Array.isArray(items)) continue;
    for (const material of items) {
      if (material && typeof material === "object" && typeof material.id === "string") ids.add(material.id);
    }
  }
  return ids;
}

function shortId(id) {
  return String(id).slice(0, 8);
}

function lintPortableIssues(draft) {
  const issues = [];
  const knownMaterialIds = materialIds(draft);

  for (const track of draft.tracks) {
    for (const segment of track.segments ?? []) {
      if (!segment.material_id || knownMaterialIds.has(segment.material_id)) continue;
      issues.push({
        severity: "error",
        code: "missing-material",
        message: `Segment ${shortId(segment.id)} references material ${shortId(segment.material_id)} that does not exist in any materials.*`,
        fixable: false,
        suggested_command: `capcut remove <project> ${shortId(segment.id)}`,
        location: {
          track: track.name,
          segment_id: segment.id,
          material_id: segment.material_id,
        },
      });
    }
  }

  for (const track of draft.tracks) {
    for (const segment of track.segments ?? []) {
      for (const reference of segment.extra_material_refs ?? []) {
        if (typeof reference !== "string" || reference === "" || knownMaterialIds.has(reference)) continue;
        issues.push({
          severity: "warning",
          code: "dangling-companion-ref",
          message: `Segment ${shortId(segment.id)} carries companion ref ${shortId(reference)} in extra_material_refs that resolves to no material — the app's behaviour on it is undefined`,
          fixable: true,
          location: {
            track: track.name,
            segment_id: segment.id,
            material_id: reference,
          },
        });
      }
    }
  }

  for (const track of draft.tracks.filter((candidate) => candidate.type === "text")) {
    const segments = [...(track.segments ?? [])].sort(
      (a, b) => a.target_timerange.start - b.target_timerange.start,
    );
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const material = findMaterial(draft.materials.texts, segment.material_id);
      const text = material ? extractText(material.content) : "";

      if (segment.target_timerange.duration > DEFAULT_LINT_OPTIONS.maxCueDurationUs) {
        issues.push({
          severity: "warning",
          code: "cue-too-long",
          message: `Caption ${shortId(segment.id)} runs ${Math.round(segment.target_timerange.duration / 1000)}ms (>${DEFAULT_LINT_OPTIONS.maxCueDurationUs / 1_000_000}s)`,
          fixable: true,
          location: { track: track.name, segment_id: segment.id },
        });
      }

      if (String(text).length > 0 && segment.target_timerange.duration > 0) {
        const visibleCharacters = String(text).replace(/\s+/g, "").length;
        const seconds = segment.target_timerange.duration / 1_000_000;
        const charactersPerSecond = visibleCharacters / seconds;
        if (visibleCharacters > 0 && charactersPerSecond > DEFAULT_LINT_OPTIONS.maxCharsPerSecond) {
          const neededMilliseconds = Math.ceil(
            (visibleCharacters / DEFAULT_LINT_OPTIONS.maxCharsPerSecond) * 1000,
          );
          issues.push({
            severity: "warning",
            code: "caption-too-fast",
            message: `Caption ${shortId(segment.id)} runs at ${charactersPerSecond.toFixed(1)} chars/s (>${DEFAULT_LINT_OPTIONS.maxCharsPerSecond}) — ${visibleCharacters} characters in ${Math.round(seconds * 1000)}ms`,
            fixable: false,
            suggested_command: `capcut trim <project> ${segment.id} <start> ${neededMilliseconds}ms  # or shorten the text`,
            location: { track: track.name, segment_id: segment.id },
          });
        }
      }

      const canvas = draft.canvas_config;
      const y = segment.clip?.transform?.y;
      if (
        canvas &&
        typeof canvas.width === "number" &&
        typeof canvas.height === "number" &&
        canvas.height > canvas.width &&
        typeof y === "number" &&
        Math.abs(y) > DEFAULT_LINT_OPTIONS.safeAreaFraction
      ) {
        issues.push({
          severity: "warning",
          code: "caption-outside-safe-area",
          message: `Caption ${shortId(segment.id)} sits at y=${y.toFixed(2)} on a ${canvas.width}x${canvas.height} vertical canvas (|y|>${DEFAULT_LINT_OPTIONS.safeAreaFraction}) — inside the band TikTok/Reels/Shorts overlay with their own UI`,
          fixable: false,
          suggested_command: `capcut text-style <project> ${segment.id} --y ${(
            Math.sign(y) * DEFAULT_LINT_OPTIONS.safeAreaFraction
          ).toFixed(2)}`,
          location: { track: track.name, segment_id: segment.id },
        });
      }

      const next = segments[index + 1];
      if (next) {
        const end = segment.target_timerange.start + segment.target_timerange.duration;
        const gap = next.target_timerange.start - end;
        if (gap < 0) {
          issues.push({
            severity: "error",
            code: "caption-overlap",
            message: `Captions ${shortId(segment.id)} and ${shortId(next.id)} overlap by ${Math.round(-gap / 1000)}ms on track "${track.name}"`,
            fixable: true,
            location: { track: track.name, segment_id: segment.id },
          });
        }
      }
    }
  }

  return issues;
}

function summarize(issues) {
  const summary = { errors: 0, warnings: 0, info: 0, total: issues.length };
  for (const issue of issues) {
    if (issue.severity === "error") summary.errors += 1;
    else if (issue.severity === "warning") summary.warnings += 1;
    else summary.info += 1;
  }
  return summary;
}

function lintPortable(draftJson) {
  try {
    const draft = parseDraft(draftJson, "draft-json");
    const issues = lintPortableIssues(draft);
    const summary = summarize(issues);
    return ok({
      ok: summary.errors === 0,
      scope: "portable-subset",
      checks: PORTABLE_CHECKS,
      summary,
      issues,
    });
  } catch (error) {
    return fail(error);
  }
}

function indexSegments(draft) {
  const index = new Map();
  for (const track of draft.tracks) {
    for (const segment of track.segments ?? []) index.set(segment.id, segment);
  }
  return index;
}

function indexMaterialContent(draft) {
  const index = new Map();
  for (const items of Object.values(draft.materials)) {
    if (!Array.isArray(items)) continue;
    for (const material of items) {
      if (typeof material?.id === "string") index.set(material.id, JSON.stringify(material));
    }
  }
  return index;
}

function diff(beforeJson, afterJson) {
  try {
    const before = parseDraft(beforeJson, "before-json");
    const after = parseDraft(afterJson, "after-json");
    const beforeSegments = indexSegments(before);
    const afterSegments = indexSegments(after);
    const segmentAdded = [];
    const segmentRemoved = [];
    const segmentChanged = [];

    for (const [id, segment] of afterSegments) {
      if (!beforeSegments.has(id)) {
        segmentAdded.push(id);
        continue;
      }
      const previous = beforeSegments.get(id);
      const fields = [];
      if (previous.target_timerange.start !== segment.target_timerange.start) fields.push("start");
      if (previous.target_timerange.duration !== segment.target_timerange.duration) fields.push("duration");
      if (previous.material_id !== segment.material_id) fields.push("material_id");
      if (JSON.stringify(previous.content ?? null) !== JSON.stringify(segment.content ?? null)) fields.push("content");
      if (previous.speed !== segment.speed) fields.push("speed");
      if (previous.volume !== segment.volume) fields.push("volume");
      if (fields.length > 0) segmentChanged.push({ id, fields });
    }
    for (const id of beforeSegments.keys()) {
      if (!afterSegments.has(id)) segmentRemoved.push(id);
    }

    const beforeMaterials = indexMaterialContent(before);
    const afterMaterials = indexMaterialContent(after);
    const materialAdded = [...afterMaterials.keys()].filter((id) => !beforeMaterials.has(id));
    const materialRemoved = [...beforeMaterials.keys()].filter((id) => !afterMaterials.has(id));
    const materialChanged = [...afterMaterials.keys()].filter(
      (id) => beforeMaterials.has(id) && beforeMaterials.get(id) !== afterMaterials.get(id),
    );
    const changed =
      segmentAdded.length +
        segmentRemoved.length +
        segmentChanged.length +
        materialAdded.length +
        materialRemoved.length +
        materialChanged.length >
      0;

    return ok({
      ok: true,
      changed,
      tracks: { a: before.tracks.length, b: after.tracks.length },
      segments: { added: segmentAdded, removed: segmentRemoved, changed: segmentChanged },
      materials: { added: materialAdded, removed: materialRemoved, changed: materialChanged },
    });
  } catch (error) {
    return fail(error);
  }
}

export const capcutCore = { inspect, lintPortable, diff };

// ComponentizeJS ignores exports that are absent from the WIT world. Keeping
// direct access here makes deterministic contract tests fast and readable.
export const __test = { inspect, lintPortable, diff, lintPortableIssues, summarize };
