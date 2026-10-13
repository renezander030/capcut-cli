import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

function writeAndSync(path: string, content: string): void {
  // "wx" is O_CREAT|O_EXCL: it creates the file or fails, and never follows an
  // existing symlink. See writeTemp for why that matters.
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, content, undefined, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Create the scratch file a temp+fsync+rename write stages into, next to its
 * target, and return its path.
 *
 * The name carries crypto randomness and the open is exclusive. A predictable
 * name (pid + clock alone) is a write-through primitive: anyone able to create
 * files in the draft folder can pre-place a symlink at the path we are about
 * to open and redirect every draft save to a file of their choosing. O_EXCL is
 * the guarantee — it refuses a path that already exists, symlink included —
 * and the randomness keeps a legitimate concurrent writer from colliding with
 * us in the first place. A collision just draws another name; the bytes
 * written are unchanged.
 */
export function writeTemp(target: string, content: string): string {
  for (let attempt = 0; attempt < 8; attempt++) {
    const temp = `${target}.capcut-cli-${process.pid}-${Date.now()}-${randomBytes(8).toString("hex")}.tmp`;
    try {
      writeAndSync(temp, content);
      return temp;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Could not create a temp file next to ${target} after 8 attempts.`);
}

/**
 * Atomically replace (or create) a small state file outside a draft: the user
 * enums catalogue and the app-version tracker. Same temp+fsync+rename as a
 * draft save, plus the parent directory created on demand.
 */
export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  renameSync(writeTemp(path, content), path);
}
