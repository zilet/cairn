import { db } from "../db.js";

// ---------- app_state: tiny KV scratchpad for scheduler bookkeeping ----------
// Used by the proactive scheduler to persist last-run stamps so a missed slot
// still fires once after a restart. Best-effort; failure-safe.
export function getAppState(key: string): string | null {
  try {
    const row = db.prepare(`SELECT value FROM app_state WHERE key = ?`).get(key) as any;
    return row?.value ?? null;
  } catch { return null; }
}

export function setAppState(key: string, value: string) {
  try {
    db.prepare(
      `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    ).run(key, String(value ?? ""));
  } catch { /* best-effort */ }
}
