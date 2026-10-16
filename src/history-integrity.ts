import { readFileSync } from "node:fs";
import { type JournalEntry, listSnapshots, readJournal } from "./draft.js";
import { journalDigest } from "./journal-digest.js";

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
  return journalDigest(content) === entry.before_sha256 ? "intact" : "changed";
}

/**
 * A draft's recovery files, each checked against the write journal (read
 * once): the history snapshots newest-first (step 1 = most recent write), and
 * the `.bak`, which holds the content before the most recent write and so is
 * checked against the newest snapshot's entry when `backup()` is called.
 */
export function readRecoveryHistory(filePath: string): {
  snapshots: Array<{
    step: number;
    index: number;
    path: string;
    entry: JournalEntry | undefined;
    integrity: RecoveryIntegrity;
  }>;
  backup: () => RecoveryIntegrity;
} {
  const journal = readJournal(filePath);
  const snapshots = listSnapshots(filePath).map((snapshot) => {
    const entry = journal.get(snapshot.index);
    return { ...snapshot, entry, integrity: integrityOf(snapshot.path, entry) };
  });
  return { snapshots, backup: () => integrityOf(`${filePath}.bak`, snapshots[0]?.entry) };
}
