import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic fixtures exercise write safety, not CapCut desktop acceptance.
export function shellDraft(id = "project-id", version = "7.7.0") {
  return {
    id,
    name: "App-created shell",
    duration: 0,
    fps: 24,
    canvas_config: { width: 720, height: 1280, ratio: "9:16", app_setting: true },
    platform: { app_source: "cc", app_version: version, os: "mac" },
    opaque_setting: { keep: "app-owned" },
    tracks: [],
    materials: {
      videos: [],
      audios: [],
      texts: [],
      speeds: [],
      material_animations: [],
      audio_fades: [],
      transitions: [],
    },
  };
}

export function projectShell(t, { nested = true, version = "7.7.0" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "capcut-shell-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "App project 工具");
  mkdirSync(dir);
  const root = join(dir, "draft_info.json");
  writeFileSync(root, JSON.stringify(shellDraft("project-id", version), null, 2));
  const meta = join(dir, "draft_meta_info.json");
  writeFileSync(
    meta,
    JSON.stringify({
      draft_id: "project-id",
      draft_name: "App-created shell",
      opaque: { keep: 1 },
      draft_materials: [{ type: 1, value: [{ id: "preserve-entry", file_Path: "/old/import.wav", custom: true }] }],
    }),
  );
  const index = join(base, "root_meta_info.json");
  writeFileSync(index, '{"all_draft_store":[{"draft_id":"project-id","app_owned":true}],"opaque":"preserve"}');
  let active = root;
  let pointer;
  let archive;
  if (nested) {
    mkdirSync(join(dir, "Timelines", "active-id"), { recursive: true });
    pointer = join(dir, "Timelines", "project.json");
    writeFileSync(
      pointer,
      JSON.stringify({ main_timeline_id: "active-id", timelines: [{ id: "active-id" }], opaque: true }),
    );
    active = join(dir, "Timelines", "active-id", "draft_info.json");
    writeFileSync(active, JSON.stringify(shellDraft("active-id", version), null, 2));
    mkdirSync(join(dir, "Timelines", "archive-id"));
    archive = join(dir, "Timelines", "archive-id", "draft_info.json");
    writeFileSync(archive, JSON.stringify({ ...shellDraft("archive-id", version), duration: 9_000_000 }));
  }
  return { base, dir, root, active, meta, index, pointer, archive };
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf-8"));

export function snapshot(dir) {
  const files = {};
  const visit = (path, prefix = "") => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        files[`${key}/`] = null;
        visit(join(path, entry.name), `${key}/`);
      } else if (entry.isFile()) files[key] = readFileSync(join(path, entry.name)).toString("base64");
    }
  };
  visit(dir);
  return files;
}
