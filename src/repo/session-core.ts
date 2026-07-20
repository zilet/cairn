import { db } from "../db.js";

// Read-only authoritative resolver used by date-scoped session operations. A
// durable composition owns its exact row; legacy dates fall back deterministically
// to the oldest row, matching historical get-or-create behavior.
export function getAuthoritativeSessionRow(date: string): any | null {
  const owned = db
    .prepare(
      `SELECT s.* FROM sessions s
        JOIN daily_session_compositions dsc ON dsc.session_id = s.id
       WHERE s.date = ? AND dsc.date = ? AND dsc.status = 'active'
       ORDER BY dsc.version DESC, s.id LIMIT 1`
    )
    .get(date, date) as any;
  if (owned) return owned;
  return (db.prepare(`SELECT * FROM sessions WHERE date = ? ORDER BY id LIMIT 1`).get(date) as any) ?? null;
}

// Lowest-level session row creation/linking. This module intentionally knows only
// SQLite state so adaptive-session can depend on it without forming a cycle with
// the richer session read surface.
export function getOrCreateSessionRow(date: string, planDayId?: number | null): any {
  // A prepared custom composition is authoritative for this day's provenance.
  // Stale rendered cards can still carry an explicit weekly day; they cannot
  // relink the custom workout. Switching back to a plan must prepare/replace it.
  const dailySession = db
    .prepare(
      `SELECT session_id, source FROM daily_session_compositions
        WHERE date = ? AND status = 'active'
        LIMIT 1`
    )
    .get(date) as any;
  if (dailySession?.session_id) {
    const owned = db
      .prepare(`SELECT * FROM sessions WHERE id = ? AND date = ?`)
      .get(dailySession.session_id, date) as any;
    if (owned) return owned;
  }
  const effectivePlanDayId = ["agent_suggest", "athlete_override"].includes(String(dailySession?.source ?? ""))
    ? null
    : planDayId;
  const session = getAuthoritativeSessionRow(date);
  if (session) {
    if (effectivePlanDayId && !session.plan_day_id) {
      db.prepare(`UPDATE sessions SET plan_day_id = ? WHERE id = ?`).run(effectivePlanDayId, session.id);
      session.plan_day_id = effectivePlanDayId;
    }
    return session;
  }
  const info = db
    .prepare(`INSERT INTO sessions (date, plan_day_id) VALUES (?, ?)`)
    .run(date, effectivePlanDayId ?? null);
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(info.lastInsertRowid);
}
