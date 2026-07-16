import { db } from "../db.js";

let savepointSequence = 0;
const afterCommitFrames: Array<Array<() => void>> = [];

function runAfterCommit(callbacks: Array<() => void>): void {
  for (const callback of callbacks) {
    try {
      callback();
    } catch {
      // The SQL commit already succeeded. Cache invalidation and event delivery are
      // best-effort consequences and cannot retroactively turn it into a failure.
    }
  }
}

export function afterSqliteCommit(callback: () => void): void {
  const frame = afterCommitFrames.at(-1);
  if (frame) frame.push(callback);
  else runAfterCommit([callback]);
}

// Node's synchronous sqlite connection is shared by every repository module.
// SAVEPOINT (unlike BEGIN) is safe both at the top level and inside another
// repository unit, so domain services can compose several writes into one commit.
export function withSqliteSavepoint<T>(label: string, run: () => T): T {
  const stem =
    String(label || "unit")
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .slice(0, 48) || "unit";
  savepointSequence = (savepointSequence + 1) % Number.MAX_SAFE_INTEGER;
  const name = `cairn_${stem}_${savepointSequence}`;
  db.exec(`SAVEPOINT ${name}`);
  const callbacks: Array<() => void> = [];
  afterCommitFrames.push(callbacks);
  try {
    const result = run();
    db.exec(`RELEASE ${name}`);
    afterCommitFrames.pop();
    const parent = afterCommitFrames.at(-1);
    if (parent) parent.push(...callbacks);
    else runAfterCommit(callbacks);
    return result;
  } catch (error) {
    if (afterCommitFrames.at(-1) === callbacks) afterCommitFrames.pop();
    try {
      db.exec(`ROLLBACK TO ${name}`);
    } finally {
      try {
        db.exec(`RELEASE ${name}`);
      } catch {
        // Preserve the original failure. A missing savepoint here only means the
        // connection already unwound it while handling that failure.
      }
    }
    throw error;
  }
}
