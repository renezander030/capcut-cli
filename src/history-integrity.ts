import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type JournalEntry, listSnapshots, readJournal } from "./draft.js";

/**
 * Whether a recovery file still holds what the CLI recorded before the write
 * it undoes. `intact`: its sha256 equals the journal's `before_sha256`.
 * `changed`: it differs, so something rewrote it after the CLI wrote it (the
 * app rewrites `<draft>.bak` when it saves; snapshots from versions before
 * 0.30.0 are hard links to that `.bak`). `unverified`: no journal entry to
 * compare with (history from before the journal, or a torn journal line).
 */
export type RecoveryIntegrity = "intact" | "changed" | "unverified";

function integrityOf(path: string, entry: JournalEntry | undefined): RecoveryIntegrity {
  if (!entry || typeof entry.before_sha256 !== "string") return "unverified";
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return "changed";
  }
  return createHash("sha256").update(content, "utf-8").digest("hex") === entry.before_sha256 ? "intact" : "changed";
}

/** The history snapshots newest-first (step 1 = most recent write), each with its integrity. */
export function snapshotsWithIntegrity(
  filePath: string,
): Array<{ step: number; index: number; path: string; entry: JournalEntry | undefined; integrity: RecoveryIntegrity }> {
  const journal = readJournal(filePath);
  return listSnapshots(filePath).map((snapshot) => {
    const entry = journal.get(snapshot.index);
    return { ...snapshot, entry, integrity: integrityOf(snapshot.path, entry) };
  });
}

/** `.bak` holds the content before the most recent write, so it is checked against the newest journal entry. */
export function backupIntegrity(filePath: string): RecoveryIntegrity {
  const newest = listSnapshots(filePath)[0];
  return integrityOf(`${filePath}.bak`, newest ? readJournal(filePath).get(newest.index) : undefined);
}
