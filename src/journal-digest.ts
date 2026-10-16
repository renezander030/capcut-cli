import { createHash } from "node:crypto";

/** The digest the write journal records for a file's content (before_sha256 /
 * after_sha256) and restore checks recovery files against: sha256 of the text
 * as UTF-8, hex. Both sides must use this one rule. */
export function journalDigest(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}
