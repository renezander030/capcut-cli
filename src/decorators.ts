import { randomUUID } from "node:crypto";
import type { Draft, MaterialText, Segment } from "./draft.js";
import { findMaterial, findSegment } from "./draft.js";
import { findEnum, type Namespace, slugsFor } from "./enums.js";

const PROPERTY_MAP: Record<string, string> = {
  position_x: "KFTypePositionX",
  position_y: "KFTypePositionY",
  rotation: "KFTypeRotation",
  scale_x: "KFTypeScaleX",
  scale_y: "KFTypeScaleY",
  uniform_scale: "UNIFORM_SCALE",
  alpha: "KFTypeAlpha",
  saturation: "KFTypeSaturation",
  contrast: "KFTypeContrast",
  brightness: "KFTypeBrightness",
  volume: "KFTypeVolume",
};

export function keyframeProperties(): string[] {
  return Object.keys(PROPERTY_MAP);
}

export function parseKeyframeValue(property: string, value: string): number {
  if (!(property in PROPERTY_MAP)) {
    throw new Error(`Unsupported keyframe property: ${property}. Supported: ${Object.keys(PROPERTY_MAP).join(", ")}`);
  }
  const v = value.trim();
  if (property === "position_x" || property === "position_y") {
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n < -10 || n > 10)
      throw new Error(`${property} must be a finite number in [-10, 10], got: ${value}`);
    return n;
  }
  if (property === "rotation") {
    const raw = v.endsWith("deg") ? v.slice(0, -3) : v;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) throw new Error(`Invalid rotation value: ${value}`);
    return n;
  }
  if (property === "alpha" || property === "volume") {
    if (v.endsWith("%")) {
      const n = parseFloat(v.slice(0, -1));
      if (!Number.isFinite(n)) throw new Error(`Invalid ${property} percentage: ${value}`);
      return n / 100;
    }
    const n = parseFloat(v);
    if (!Number.isFinite(n)) throw new Error(`Invalid ${property} value: ${value}`);
    return n;
  }
  if (property === "saturation" || property === "contrast" || property === "brightness") {
    if (v.startsWith("+")) {
      const n = parseFloat(v.slice(1));
      if (!Number.isFinite(n)) throw new Error(`Invalid ${property} value: ${value}`);
      return n;
    }
    if (v.startsWith("-")) {
      const n = parseFloat(v.slice(1));
      if (!Number.isFinite(n)) throw new Error(`Invalid ${property} value: ${value}`);
      return -n;
    }
    const n = parseFloat(v);
    if (!Number.isFinite(n)) throw new Error(`Invalid ${property} value: ${value}`);
    return n;
  }
  const n = parseFloat(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${property} value: ${value}`);
  return n;
}

export interface KeyframeInput {
  property: string;
  timeUs: number; // segment-relative time in microseconds
  value: number; // already parsed/normalised
}

function uuidHex(): string {
  return randomUUID().replace(/-/g, "");
}

interface KeyframeListObject {
  id: string;
  keyframe_list: Array<Record<string, unknown>>;
  material_id: string;
  property_type: string;
}

export function addKeyframes(
  draft: Draft,
  segmentId: string,
  keyframes: KeyframeInput[],
): { segmentId: string; added: number; lists: Array<{ property: string; count: number }> } {
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment as Segment & { common_keyframes?: unknown };

  if (!Array.isArray(seg.common_keyframes)) {
    (seg as Record<string, unknown>).common_keyframes = [];
  }
  const commonKeyframes = seg.common_keyframes as KeyframeListObject[];

  for (const kf of keyframes) {
    const propEnum = PROPERTY_MAP[kf.property];
    if (!propEnum) {
      throw new Error(
        `Unsupported keyframe property: ${kf.property}. Supported: ${Object.keys(PROPERTY_MAP).join(", ")}`,
      );
    }
    let list = commonKeyframes.find((l) => l.property_type === propEnum);
    if (!list) {
      list = {
        id: uuidHex(),
        keyframe_list: [],
        material_id: "",
        property_type: propEnum,
      };
      commonKeyframes.push(list);
    }
    list.keyframe_list.push({
      curveType: "Line",
      graphID: "",
      left_control: { x: 0.0, y: 0.0 },
      right_control: { x: 0.0, y: 0.0 },
      id: uuidHex(),
      time_offset: kf.timeUs,
      values: [kf.value],
    });
    list.keyframe_list.sort((a, b) => (a.time_offset as number) - (b.time_offset as number));
  }

  const summary = commonKeyframes.map((l) => {
    const prop = Object.entries(PROPERTY_MAP).find(([, v]) => v === l.property_type)?.[0] ?? l.property_type;
    return { property: prop, count: l.keyframe_list.length };
  });

  return { segmentId: seg.id, added: keyframes.length, lists: summary };
}

// --- Phase 1: transition / mask / bg-blur / text-style / text-anim ---
// Phase 3: TRANSITIONS / MASKS / TEXT_ANIMS now source metadata from enums.json
// (enums.ts). IMAGE_ANIMS and VIDEO_EFFECTS keep inline maps because those
// catalogues carry empirically-verified effect_ids from live CapCut projects
// (knossos-recon) that do NOT match upstream pyJianYingDraft metadata.

export function transitionSlugs(namespace: Namespace = "capcut"): string[] {
  return slugsFor("transitions", namespace);
}

export function addTransition(
  draft: Draft,
  segmentId: string,
  slug: string,
  durationUs?: number,
  namespace: Namespace = "capcut",
): { segmentId: string; transition_id: string; name: string; duration_us: number } {
  const meta = findEnum("transitions", slug, namespace);
  if (!meta?.name || !meta.effect_id || !meta.resource_id) {
    const hint = namespace === "jianying" ? " --jianying" : "";
    throw new Error(`Unknown transition: ${slug}. Run 'capcut enums --transitions${hint}' for the full list.`);
  }
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment;
  const transitions = (draft.materials.transitions ??= []);

  // Refuse to stack transitions on one segment.
  const existing = (seg.extra_material_refs || []).find((r) =>
    transitions.some((t) => (t as { id?: string }).id === r),
  );
  if (existing) throw new Error(`Segment already has a transition (material ${existing}). Remove it first.`);

  const id = randomUUID();
  const dur = durationUs ?? meta.default_duration ?? 500000;
  transitions.push({
    category_id: "",
    category_name: "",
    duration: dur,
    effect_id: meta.effect_id,
    id,
    is_overlap: meta.is_overlap ?? false,
    name: meta.name,
    platform: "all",
    resource_id: meta.resource_id,
    type: "transition",
  });
  (seg.extra_material_refs ||= []).push(id);
  return { segmentId: seg.id, transition_id: id, name: meta.name, duration_us: dur };
}

// Legacy slug aliases: pre-Phase-3 the CLI exposed linear/mirror/star while
// CapCut's own names are split/filmstrip/stars. Keep aliasing so scripts don't break.
const MASK_ALIASES: Record<string, string> = {
  linear: "split",
  mirror: "filmstrip",
  star: "stars",
};

export function maskSlugs(namespace: Namespace = "capcut"): string[] {
  return [...Object.keys(MASK_ALIASES), ...slugsFor("masks", namespace)];
}

export interface MaskOptions {
  centerX?: number; // in half-canvas units (-1 .. 1)
  centerY?: number;
  size?: number; // fraction of canvas height
  rotation?: number; // degrees clockwise
  feather?: number; // 0 .. 100
  invert?: boolean;
  rectWidth?: number; // rectangle only — fraction of canvas width
  roundCorner?: number; // rectangle only — 0 .. 100
}

export function addMask(
  draft: Draft,
  segmentId: string,
  slug: string,
  opts: MaskOptions,
  namespace: Namespace = "capcut",
): { segmentId: string; mask_id: string; name: string } {
  const meta = findEnum("masks", slug, namespace, MASK_ALIASES);
  if (!meta?.name || !meta.effect_id || !meta.resource_id || !meta.resource_type) {
    const hint = namespace === "jianying" ? " --jianying" : "";
    throw new Error(`Unknown mask: ${slug}. Run 'capcut enums --masks${hint}' for the full list.`);
  }
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment;

  const masks = (draft.materials.common_mask ??= [] as Array<Record<string, unknown>>);

  // Refuse to stack masks on one segment.
  const existing = (seg.extra_material_refs || []).find((r) => masks.some((m) => (m as { id?: string }).id === r));
  if (existing) throw new Error(`Segment already has a mask (material ${existing}). Remove it first.`);

  const resolvedSlug = (MASK_ALIASES[slug] ?? slug).toLowerCase();
  const isRect = resolvedSlug === "rectangle";
  if ((opts.rectWidth !== undefined || opts.roundCorner !== undefined) && !isRect) {
    throw new Error(`--rect-width / --round-corner only valid for rectangle mask`);
  }

  const aspectRatio = meta.default_aspect_ratio ?? 1.0;
  const size = opts.size ?? 0.5;
  const canvasW = draft.canvas_config?.width ?? 1920;
  const canvasH = draft.canvas_config?.height ?? 1080;
  const width = isRect ? (opts.rectWidth ?? size) : (size * canvasH * aspectRatio) / canvasW;
  const height = size;

  const id = randomUUID();
  masks.push({
    config: {
      aspectRatio,
      centerX: opts.centerX ?? 0,
      centerY: opts.centerY ?? 0,
      feather: (opts.feather ?? 0) / 100,
      height,
      invert: opts.invert ?? false,
      rotation: opts.rotation ?? 0,
      roundCorner: (opts.roundCorner ?? 0) / 100,
      width,
    },
    category: "video",
    category_id: "",
    category_name: "",
    id,
    name: meta.name,
    platform: "all",
    position_info: "",
    resource_type: meta.resource_type,
    resource_id: meta.resource_id,
    type: "mask",
  });
  (seg.extra_material_refs ||= []).push(id);
  return { segmentId: seg.id, mask_id: id, name: meta.name };
}

// CapCut's four-step UI blur maps to these four values (upstream comment).
const BLUR_LEVELS = [0.0625, 0.375, 0.75, 1.0];

export function setBgBlur(
  draft: Draft,
  segmentId: string,
  level: 1 | 2 | 3 | 4 | "off",
): { segmentId: string; canvas_id: string | null; blur: number | null } {
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment;

  const canvases = (draft.materials.canvases ??= [] as Array<Record<string, unknown>>);

  // Remove any existing canvas reference on this segment.
  const before = (seg.extra_material_refs || []).length;
  seg.extra_material_refs = (seg.extra_material_refs || []).filter((r) => {
    const c = canvases.find((cc) => (cc as { id?: string }).id === r);
    return !c;
  });

  if (level === "off") {
    return { segmentId: seg.id, canvas_id: null, blur: null };
  }

  const idx = level - 1;
  const blur = BLUR_LEVELS[idx];
  const id = randomUUID();
  canvases.push({
    album_image: "",
    blur,
    color: "",
    id,
    image: "",
    image_id: "",
    image_name: "",
    source_platform: 0,
    team_id: "",
    type: "canvas_blur",
  });
  seg.extra_material_refs.push(id);
  void before; // kept to silence unused if tooling lint turns back on
  return { segmentId: seg.id, canvas_id: id, blur };
}

export interface TextStyleOptions {
  alpha?: number;
  vertical?: boolean;
  fixedWidth?: number;
  fixedHeight?: number;
  shadow?: boolean;
  shadowAlpha?: number;
  shadowAngle?: number;
  shadowColor?: string;
  shadowDistance?: number;
  shadowSmoothing?: number;
  borderWidth?: number;
  borderColor?: string;
  borderAlpha?: number;
  bgColor?: string;
  bgAlpha?: number;
  bgStyle?: number;
  bgRoundRadius?: number;
  bgWidth?: number;
  bgHeight?: number;
  bgHOffset?: number;
  bgVOffset?: number;
}

export function setTextStyle(
  draft: Draft,
  segmentId: string,
  opts: TextStyleOptions,
): { materialId: string; applied: string[] } {
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment;
  const text = findMaterial(draft.materials.texts as MaterialText[], seg.material_id);
  if (!text) throw new Error(`Text material not found for segment ${segmentId}`);

  const applied: string[] = [];
  const t = text as unknown as Record<string, unknown>;

  if (opts.alpha !== undefined) {
    t.text_alpha = opts.alpha;
    applied.push("alpha");
  }
  if (opts.vertical !== undefined) {
    t.typesetting = opts.vertical ? 1 : 0;
    applied.push("vertical");
  }
  if (opts.fixedWidth !== undefined) {
    t.fixed_width = opts.fixedWidth;
    applied.push("fixed_width");
  }
  if (opts.fixedHeight !== undefined) {
    t.fixed_height = opts.fixedHeight;
    applied.push("fixed_height");
  }

  if (opts.shadow) {
    t.has_shadow = true;
    if (opts.shadowAlpha !== undefined) t.shadow_alpha = opts.shadowAlpha;
    if (opts.shadowAngle !== undefined) t.shadow_angle = opts.shadowAngle;
    if (opts.shadowColor !== undefined) t.shadow_color = opts.shadowColor;
    if (opts.shadowDistance !== undefined) t.shadow_distance = opts.shadowDistance;
    if (opts.shadowSmoothing !== undefined) t.shadow_smoothing = opts.shadowSmoothing;
    applied.push("shadow");
  } else if (opts.shadow === false) {
    t.has_shadow = false;
    applied.push("shadow-off");
  }

  if (opts.borderWidth !== undefined || opts.borderColor !== undefined || opts.borderAlpha !== undefined) {
    t.border_width = opts.borderWidth ?? t.border_width ?? 0;
    t.border_color = opts.borderColor ?? t.border_color ?? "#000000";
    t.border_alpha = opts.borderAlpha ?? t.border_alpha ?? 1;
    t.has_border = true;
    applied.push("border");
  }

  if (
    opts.bgColor !== undefined ||
    opts.bgAlpha !== undefined ||
    opts.bgStyle !== undefined ||
    opts.bgRoundRadius !== undefined ||
    opts.bgWidth !== undefined ||
    opts.bgHeight !== undefined ||
    opts.bgHOffset !== undefined ||
    opts.bgVOffset !== undefined
  ) {
    t.has_text_shadow_config = true;
    if (opts.bgColor !== undefined) t.background_color = opts.bgColor;
    if (opts.bgAlpha !== undefined) t.background_alpha = opts.bgAlpha;
    if (opts.bgStyle !== undefined) t.background_style = opts.bgStyle;
    if (opts.bgRoundRadius !== undefined) t.background_round_radius = opts.bgRoundRadius;
    if (opts.bgWidth !== undefined) t.background_width = opts.bgWidth;
    if (opts.bgHeight !== undefined) t.background_height = opts.bgHeight;
    if (opts.bgHOffset !== undefined) t.background_horizontal_offset = opts.bgHOffset;
    if (opts.bgVOffset !== undefined) t.background_vertical_offset = opts.bgVOffset;
    applied.push("bg");
  }

  return { materialId: text.id, applied };
}

// Legacy aliases for text-anim slugs that don't match upstream enum member names.
const TEXT_ANIM_ALIASES: Record<string, string> = {
  "blur-text-in": "blur",
  "zoom-in-text": "zoom-in",
};

// Kept-small set of known slugs documented in SKILL.md — the full catalogue
// (70+ intros, 60+ outros) is discoverable via `capcut enums --text-intros/--text-outros`.
const TEXT_ANIM_FEATURED = ["fade-in", "fade-out", "typewriter", "pop-up", "throw-out", "blur-text-in", "zoom-in-text"];

export function textAnimSlugs(): string[] {
  return TEXT_ANIM_FEATURED;
}

export interface TextAnimOptions {
  intro?: string;
  outro?: string;
  introDurationUs?: number;
  outroDurationUs?: number;
}

// --- Image / video intro/outro/combo animations ---
// Same shape as text animations but material_type = "video" and enum namespace
// is the CapCut video intro/outro/group catalogue. Starter set matches the
// slugs in the skill's animations.json so behaviour is consistent.

interface ImageAnimMeta {
  name: string;
  effect_id: string;
  resource_id: string;
  md5: string;
  default_duration_us: number;
  category_id: string;
  third_resource_id: string;
  type: "in" | "out" | "group";
}

const IMAGE_ANIMS: Record<string, ImageAnimMeta> = {
  "fade-in": {
    name: "Fade In",
    effect_id: "6798320778182922760",
    resource_id: "6798320778182922760",
    md5: "883ad04bd79b502aaa55b5d9b87175ea",
    default_duration_us: 500000,
    category_id: "2037708296",
    third_resource_id: "6798320778182922760",
    type: "in",
  },
  "flash-in": {
    name: "Flash In",
    effect_id: "7211044701367964162",
    resource_id: "7211044701367964162",
    md5: "6a680c49cd11a05f3eb0e5a3fed165f7",
    default_duration_us: 433333,
    category_id: "2037708312",
    third_resource_id: "7211044701367964162",
    type: "in",
  },
  "pulsing-zooms": {
    name: "Pulsing Zooms",
    effect_id: "7530463994486820097",
    resource_id: "7530463994486820097",
    md5: "c2223de4486ee5b2a5900d707e9a362b",
    default_duration_us: 3000000,
    category_id: "2037708296",
    third_resource_id: "0",
    type: "in",
  },
  "scroll-up": {
    name: "Scroll up",
    effect_id: "7315336764636271105",
    resource_id: "7315336764636271105",
    md5: "cb8899ed512a2d40bd27d9e03d039ec0",
    default_duration_us: 1200000,
    category_id: "in_fav",
    third_resource_id: "7315336764636271105",
    type: "in",
  },
  "stripe-merge": {
    name: "Stripe Merge",
    effect_id: "7570497406203251973",
    resource_id: "7570497406203251973",
    md5: "fc08875f779dae706387fb160dbaa898",
    default_duration_us: 633333,
    category_id: "2037708296",
    third_resource_id: "0",
    type: "in",
  },
  "zoom-out": {
    name: "Zoom Out",
    effect_id: "6798332584276267527",
    resource_id: "6798332584276267527",
    md5: "0c736f993d36a7b1ef00cc73d2ba656f",
    default_duration_us: 2000000,
    category_id: "",
    third_resource_id: "",
    type: "in",
  },
  "fade-out": {
    name: "Fade Out",
    effect_id: "6798320902548230669",
    resource_id: "6798320902548230669",
    md5: "c6f05ce62355b537be762550040bfc08",
    default_duration_us: 500000,
    category_id: "2037708296",
    third_resource_id: "0",
    type: "out",
  },
  "blur-out": {
    name: "Blur Out",
    effect_id: "7507514531212479761",
    resource_id: "7507514531212479761",
    md5: "78d0826a4aba60259f37acb30149b258",
    default_duration_us: 1000000,
    category_id: "out_fav",
    third_resource_id: "0",
    type: "out",
  },
  smoke: {
    name: "Smoke",
    effect_id: "7229983825080619522",
    resource_id: "7229983825080619522",
    md5: "e70e26e7aa770d0deedca54e3eac0323",
    default_duration_us: 900000,
    category_id: "out_fav",
    third_resource_id: "7229983825080619522",
    type: "out",
  },
};

export function imageAnimSlugs(): string[] {
  return Object.keys(IMAGE_ANIMS);
}

export interface ImageAnimOptions {
  intro?: string;
  outro?: string;
  combo?: string;
  introDurationUs?: number;
  outroDurationUs?: number;
  comboDurationUs?: number;
}

export function addImageAnim(
  draft: Draft,
  segmentId: string,
  opts: ImageAnimOptions,
  namespace: Namespace = "capcut",
): {
  segmentId: string;
  added: Array<{ type: string; name: string; duration_us: number; start_us: number }>;
  material_id: string;
} {
  if (!opts.intro && !opts.outro && !opts.combo) {
    throw new Error("at least one of --intro, --outro, --combo is required");
  }

  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment;

  const animsArr = (draft.materials.material_animations ??= [] as Array<Record<string, unknown>>);
  const animsById = Object.fromEntries(animsArr.map((a) => [(a as { id: string }).id, a]));

  let container: { animations: Array<Record<string, unknown>>; id: string } | null = null;
  for (const ref of seg.extra_material_refs || []) {
    const m = animsById[ref];
    if (m) {
      container = m as unknown as { animations: Array<Record<string, unknown>>; id: string };
      break;
    }
  }
  if (!container) {
    const id = randomUUID();
    const fresh = {
      animations: [] as Array<Record<string, unknown>>,
      id,
      multi_language_current: "none",
      type: "sticker_animation",
    };
    animsArr.push(fresh);
    (seg.extra_material_refs ||= []).push(id);
    container = fresh;
  }

  const added: Array<{ type: string; name: string; duration_us: number; start_us: number }> = [];
  const targetDur = seg.target_timerange.duration;
  const CACHE_BASE = `${process.env.HOME ?? ""}/Library/Containers/com.lemon.lvoverseas/Data/Movies/CapCut/User Data/Cache/effect`;

  const addOne = (slug: string, overrideDur: number | undefined, animType: "in" | "out" | "group") => {
    const inline = IMAGE_ANIMS[slug];
    // Inline (knossos-verified) entry wins; fall back to enums.json for any
    // other slug so the full CapCut catalogue is reachable.
    let name: string;
    let effectId: string;
    let resourceId: string;
    let md5: string;
    let defaultDur: number;
    let categoryId: string;
    let thirdResourceId: string;
    if (inline) {
      name = inline.name;
      effectId = inline.effect_id;
      resourceId = inline.resource_id;
      md5 = inline.md5;
      defaultDur = inline.default_duration_us;
      categoryId = inline.category_id;
      thirdResourceId = inline.third_resource_id;
    } else {
      const category = animType === "in" ? "image_intros" : animType === "out" ? "image_outros" : "image_combos";
      const meta = findEnum(category, slug, namespace);
      if (!meta?.effect_id || !meta.resource_id) {
        const hint = namespace === "jianying" ? " --jianying" : "";
        throw new Error(
          `Unknown image ${animType} animation: ${slug}. Run 'capcut enums --image-${animType === "in" ? "intros" : animType === "out" ? "outros" : "combos"}${hint}' for the full list.`,
        );
      }
      name = meta.title ?? meta.name ?? slug;
      effectId = meta.effect_id;
      resourceId = meta.resource_id;
      md5 = meta.md5 ?? "";
      defaultDur = meta.duration ?? meta.default_duration ?? 500000;
      categoryId = animType === "in" ? "in_fav" : animType === "out" ? "out_fav" : "";
      thirdResourceId = "0";
    }

    if (container!.animations.some((a) => (a as { type: string }).type === animType)) {
      throw new Error(`segment already has a ${animType} video animation`);
    }
    const dur = overrideDur ?? defaultDur;
    if (dur > targetDur) throw new Error(`duration (${dur}us) exceeds segment duration (${targetDur}us)`);
    const start = animType === "out" ? targetDur - dur : 0;
    container!.animations.push({
      anim_adjust_params: null,
      category_id: categoryId,
      category_name: categoryId,
      duration: dur,
      id: effectId,
      material_type: "video",
      name,
      panel: "video",
      path: md5 ? `${CACHE_BASE}/${effectId}/${md5}` : "",
      platform: "all",
      request_id: "",
      resource_id: resourceId,
      source_platform: 1,
      start,
      third_resource_id: thirdResourceId,
      type: animType,
    });
    added.push({ type: animType, name, duration_us: dur, start_us: start });
  };

  if (opts.intro) addOne(opts.intro, opts.introDurationUs, "in");
  if (opts.outro) addOne(opts.outro, opts.outroDurationUs, "out");
  if (opts.combo) addOne(opts.combo, opts.comboDurationUs, "group");

  return { segmentId: seg.id, added, material_id: container.id };
}

export function addTextAnim(
  draft: Draft,
  segmentId: string,
  opts: TextAnimOptions,
  namespace: Namespace = "capcut",
): {
  segmentId: string;
  added: Array<{ type: string; name: string; duration_us: number; start_us: number }>;
  material_id: string;
} {
  if (!opts.intro && !opts.outro) throw new Error("at least one of --intro or --outro is required");

  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment;

  const animsArr = (draft.materials.material_animations ??= [] as Array<Record<string, unknown>>);
  const animsById = Object.fromEntries(
    animsArr.map((a) => [(a as { id: string }).id, a as { animations?: Array<Record<string, unknown>>; id: string }]),
  );

  // Find or create the per-segment sticker_animation container.
  let container: { animations: Array<Record<string, unknown>>; id: string } | null = null;
  for (const ref of seg.extra_material_refs || []) {
    const m = animsById[ref];
    if (m) {
      container = m as { animations: Array<Record<string, unknown>>; id: string };
      break;
    }
  }
  if (!container) {
    const id = randomUUID();
    const fresh = {
      animations: [] as Array<Record<string, unknown>>,
      id,
      multi_language_current: "none",
      type: "sticker_animation",
    };
    animsArr.push(fresh);
    (seg.extra_material_refs ||= []).push(id);
    container = fresh;
  }

  const added: Array<{ type: string; name: string; duration_us: number; start_us: number }> = [];
  const targetDur = seg.target_timerange.duration;

  const addOne = (slug: string, overrideDur: number | undefined, animType: "in" | "out") => {
    const category = animType === "in" ? "text_intros" : "text_outros";
    const meta = findEnum(category, slug, namespace, TEXT_ANIM_ALIASES);
    if (!meta?.effect_id || !meta.resource_id) {
      const hint = namespace === "jianying" ? " --jianying" : "";
      throw new Error(
        `Unknown text ${animType === "in" ? "intro" : "outro"}: ${slug}. Run 'capcut enums --text-${animType === "in" ? "intros" : "outros"}${hint}' for the full list.`,
      );
    }
    const name = meta.title ?? meta.name ?? slug;
    if (container!.animations.some((a) => (a as { type: string }).type === animType)) {
      throw new Error(`segment already has a ${animType} text animation`);
    }
    const dur = overrideDur ?? meta.duration ?? meta.default_duration ?? 500000;
    if (dur > targetDur) throw new Error(`duration (${dur}us) exceeds segment duration (${targetDur}us)`);
    const start = animType === "out" ? targetDur - dur : 0;
    const categoryId = animType === "in" ? "in_fav" : "out_fav";
    container!.animations.push({
      anim_adjust_params: null,
      category_id: categoryId,
      category_name: categoryId,
      duration: dur,
      id: meta.effect_id,
      material_type: "text",
      name,
      panel: "",
      path: "",
      platform: "all",
      request_id: "",
      resource_id: meta.resource_id,
      source_platform: 1,
      start,
      third_resource_id: "",
      type: animType,
    });
    added.push({ type: animType, name, duration_us: dur, start_us: start });
  };

  if (opts.intro) addOne(opts.intro, opts.introDurationUs, "in");
  if (opts.outro) addOne(opts.outro, opts.outroDurationUs, "out");

  return { segmentId: seg.id, added, material_id: container.id };
}

// --- Phase 4: multi-style text ranges ---
// CapCut text materials store a `content` JSON string with:
//   { styles: [{range:[startByte,endByte], size, bold, italic, underline, fill:{...}}, ...], text }
// `range` is in UTF-16LE bytes (== JS string code-unit index * 2 for BMP chars).
// This writer replaces the entire `styles` array, so every range the caller
// wants highlighted must be passed in one call. Gaps between ranges are filled
// with an inherited default block so CapCut doesn't render blank text.

export interface TextRangeInput {
  start: number; // JS string code-unit index, inclusive
  end: number; // JS string code-unit index, exclusive
  font_color?: string; // "#RRGGBB"
  font_size?: number;
  font_alpha?: number; // 0..1
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

export function setTextRanges(
  draft: Draft,
  segmentId: string,
  ranges: TextRangeInput[],
): { segmentId: string; material_id: string; styles: number; text_length: number } {
  if (ranges.length === 0) throw new Error("at least one range required");
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  const seg = found.segment;
  const text = findMaterial(draft.materials.texts as MaterialText[], seg.material_id);
  if (!text) throw new Error(`Text material not found for segment ${segmentId}`);

  const content = JSON.parse(text.content) as {
    styles: Array<Record<string, unknown>>;
    text: string;
  };
  const full = content.text ?? "";
  const byteLen = Buffer.from(full, "utf16le").length;

  // Baseline style inherited for fields the user didn't override.
  const base = content.styles?.[0] ?? {};
  const baseFill = (
    base.fill as { content?: { solid?: { color?: [number, number, number]; alpha?: number } } } | undefined
  )?.content?.solid;
  const defaultColor: [number, number, number] = baseFill?.color ?? [1, 1, 1];
  const defaultAlpha = baseFill?.alpha ?? 1;
  const defaultSize = (base.size as number | undefined) ?? 15;
  const defaultBold = (base.bold as boolean | undefined) ?? false;
  const defaultItalic = (base.italic as boolean | undefined) ?? false;
  const defaultUnderline = (base.underline as boolean | undefined) ?? false;

  // Validate + normalise ranges (char indices -> byte offsets). BMP assumption:
  // one code-unit = 2 bytes, matching Buffer.from(s.slice(0,n), 'utf16le').length.
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const maxCodeUnits = full.length;
  for (const r of sorted) {
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end)) throw new Error(`range {start,end} must be integers`);
    if (r.start < 0 || r.end > maxCodeUnits)
      throw new Error(`range [${r.start},${r.end}) out of bounds (text length=${maxCodeUnits})`);
    if (r.end <= r.start) throw new Error(`range [${r.start},${r.end}) must have end > start`);
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw new Error(
        `overlapping ranges: [${sorted[i - 1].start},${sorted[i - 1].end}) and [${sorted[i].start},${sorted[i].end})`,
      );
    }
  }

  const toBytes = (codeUnitIdx: number) => Buffer.from(full.slice(0, codeUnitIdx), "utf16le").length;

  const makeStyle = (byteStart: number, byteEnd: number, r?: TextRangeInput): Record<string, unknown> => {
    const color = r?.font_color ? hexToRgb01(r.font_color) : defaultColor;
    const alpha = r?.font_alpha ?? defaultAlpha;
    return {
      range: [byteStart, byteEnd],
      size: r?.font_size ?? defaultSize,
      bold: r?.bold ?? defaultBold,
      italic: r?.italic ?? defaultItalic,
      underline: r?.underline ?? defaultUnderline,
      fill: {
        alpha: 1,
        content: {
          render_type: "solid",
          solid: { alpha, color },
        },
      },
    };
  };

  // Fill gaps with a plain block (default style) so CapCut renders the whole text.
  const styles: Array<Record<string, unknown>> = [];
  let cursor = 0;
  for (const r of sorted) {
    if (r.start > cursor) {
      styles.push(makeStyle(toBytes(cursor), toBytes(r.start)));
    }
    styles.push(makeStyle(toBytes(r.start), toBytes(r.end), r));
    cursor = r.end;
  }
  if (cursor < maxCodeUnits) {
    styles.push(makeStyle(toBytes(cursor), byteLen));
  }

  content.styles = styles;
  text.content = JSON.stringify(content);

  return { segmentId: seg.id, material_id: text.id, styles: styles.length, text_length: maxCodeUnits };
}

// --- Bubble (speech-bubble) effect on a text segment ---
// Bubble materials live in materials.filters[] alongside colour filters
// (pyJianYingDraft groups them under the same array — see script_file.py:368).
// Shape: { id, type:"text_shape", effect_id, resource_id, apply_target_type:0, value:1.0 }
// Segment references the bubble via extra_material_refs.

interface BubbleMeta {
  name: string;
  effect_id: string;
  resource_id: string;
}

const BUBBLES: Record<string, BubbleMeta> = {
  // Starter catalogue. The exact effect_id / resource_id pairs are CapCut-version-
  // specific; the slugs below are common bubble shapes. Override via
  // --effect-id / --resource-id when you have ids from your own draft.
  rectangle: { name: "Rectangle", effect_id: "7137268628230638087", resource_id: "7137268628230638087" },
  rounded: { name: "Rounded Rectangle", effect_id: "7137268898998568967", resource_id: "7137268898998568967" },
  cloud: { name: "Cloud", effect_id: "7137269184932778510", resource_id: "7137269184932778510" },
  oval: { name: "Oval", effect_id: "7137269466232116231", resource_id: "7137269466232116231" },
  star: { name: "Star", effect_id: "7137269743886750214", resource_id: "7137269743886750214" },
  heart: { name: "Heart", effect_id: "7137270031716044302", resource_id: "7137270031716044302" },
  burst: { name: "Burst", effect_id: "7137270320304885262", resource_id: "7137270320304885262" },
};

export function bubbleSlugs(): string[] {
  return Object.keys(BUBBLES);
}

export function bubbleCatalogue(): Array<{
  slug: string;
  member: string;
  name: string;
  effect_id: string;
  resource_id: string;
}> {
  return Object.entries(BUBBLES).map(([slug, meta]) => ({
    slug,
    member: meta.name,
    name: meta.name,
    effect_id: meta.effect_id,
    resource_id: meta.resource_id,
  }));
}

export interface BubbleOptions {
  slug?: string;
  effectId?: string;
  resourceId?: string;
}

export function setBubble(
  draft: Draft,
  segmentId: string,
  opts: BubbleOptions,
): { segmentId: string; bubble_id: string; effect_id: string; resource_id: string } {
  const found = findSegment(draft, segmentId);
  if (!found) throw new Error(`Segment not found: ${segmentId}`);
  if (found.track.type !== "text") {
    throw new Error(`bubble-text only applies to text segments (track type: ${found.track.type})`);
  }
  const seg = found.segment;
  const text = findMaterial(draft.materials.texts as MaterialText[], seg.material_id);
  if (!text) throw new Error(`Text material not found for segment ${segmentId}`);

  let effectId = opts.effectId;
  let resourceId = opts.resourceId;
  if ((!effectId || !resourceId) && opts.slug) {
    const meta = BUBBLES[opts.slug.toLowerCase()];
    if (!meta) {
      throw new Error(
        `Unknown bubble slug: ${opts.slug}. Run 'capcut enums --bubbles' or pass --effect-id / --resource-id directly.`,
      );
    }
    effectId = effectId ?? meta.effect_id;
    resourceId = resourceId ?? meta.resource_id;
  }
  if (!effectId || !resourceId) {
    throw new Error(`bubble-text requires either --bubble <slug> or both --effect-id and --resource-id`);
  }

  // Drop existing bubble refs on this segment (we replace, don't stack).
  if (!Array.isArray((draft.materials as Record<string, unknown>).filters)) {
    (draft.materials as Record<string, unknown>).filters = [];
  }
  const filters = (
    draft.materials as unknown as { filters: Array<Record<string, unknown> & { id: string; type?: string }> }
  ).filters;
  seg.extra_material_refs = (seg.extra_material_refs || []).filter(
    (r) => !filters.some((f) => f.id === r && f.type === "text_shape"),
  );

  const bubbleId = randomUUID().replace(/-/g, "");
  filters.push({
    id: bubbleId,
    apply_target_type: 0,
    effect_id: effectId,
    resource_id: resourceId,
    type: "text_shape",
    value: 1.0,
  });
  (seg.extra_material_refs ||= []).push(bubbleId);

  // Also stamp the bubble_* fields on the text material itself (some CapCut
  // versions read from there in addition to the filters[] entry).
  const t = text as unknown as Record<string, unknown>;
  t.bubble_effect_id = effectId;
  t.bubble_resource_id = resourceId;

  return { segmentId: seg.id, bubble_id: bubbleId, effect_id: effectId, resource_id: resourceId };
}
