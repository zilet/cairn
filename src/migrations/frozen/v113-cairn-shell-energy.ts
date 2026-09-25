// Frozen snapshot of src/repo/garmin-shell-energy.ts's rule as of 2026-09-25; migrations
// must not track live code.
//
// WHY A COPY AND NOT AN IMPORT. A migration is a statement about what the ladder did on
// the day it shipped. Importing the live module means a fresh install replays that
// migration against TODAY's semantics. Do not "fix" a bug here: fix it in the live
// module and, if old rows need it, append a NEW migration.
//
// DO NOT REFORMAT. `cairnShellOwnedKcal` below is a verbatim copy of the live function.
//
// WHAT v113 REPAIRS. Every Cairn strength session written back to Garmin became a
// manual "shell" activity, and Garmin adds each manual activity's calories (above the
// BMR it would have burned anyway) to the day's `burnedKilocalories`, and so to
// `activeKilocalories` and `totalKilocalories`. The sync stored those totals verbatim
// into garmin_daily_metrics, where the expenditure prior reads them: Cairn's own shells
// were leaking into Cairn's TDEE (5–35 kcal/day at Garmin's 65.534 placeholder, and
// ~150 once the shell carries a real estimate). The sync now stores the totals NET of
// what the shells contributed; this pulls the rows already on disk onto the same law.

import type { DatabaseSync } from "node:sqlite";

const CAIRN_ACTIVITY_MARKER = " · Cairn";
const MINUTES_PER_DAY = 1440;

function isCairnAuthoredName(name: unknown): boolean {
  return String(name ?? "").trimEnd().endsWith(CAIRN_ACTIVITY_MARKER);
}

export interface CairnShellEnergyShell {
  kcal: number | null;
  duration_min: number | null;
}

export interface CairnShellEnergyInput {
  burned: number | null;
  active: number | null;
  bmr_per_min: number | null;
  shells: CairnShellEnergyShell[];
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function cairnShellOwnedKcal(input: CairnShellEnergyInput): number | null {
  if (!input.shells.length) return 0;
  const rate = num(input.bmr_per_min);
  if (rate == null || rate <= 0) return null;
  let owned = 0;
  for (const shell of input.shells) {
    const kcal = num(shell.kcal);
    const minutes = num(shell.duration_min);
    if (kcal == null || minutes == null) return null;
    owned += Math.max(0, kcal - rate * Math.max(0, minutes));
  }
  const burned = num(input.burned);
  if (burned != null) owned = Math.min(owned, burned);
  const active = num(input.active);
  if (active != null) owned = Math.min(owned, active);
  return round1(Math.max(0, owned));
}

function parseObject(raw: unknown): Record<string, any> | null {
  if (raw == null || raw === "") return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Ids the export ledger (sessions.garmin_json.export) says Cairn authored, by date. */
function ledgerShellIds(db: DatabaseSync): Map<string, Map<string, number | null>> {
  const out = new Map<string, Map<string, number | null>>();
  if (!hasTable(db, "sessions") || !hasColumn(db, "sessions", "garmin_json")) return out;
  const rows = db.prepare(`SELECT date, garmin_json FROM sessions WHERE garmin_json IS NOT NULL`).all() as any[];
  for (const row of rows) {
    const record = parseObject(row.garmin_json)?.export;
    if (!record || typeof record !== "object") continue;
    const date = String(row.date ?? "").slice(0, 10);
    const ids = out.get(date) ?? new Map<string, number | null>();
    const activityId = String(record.activity_id ?? "").trim();
    if (activityId && record.source !== "watch") ids.set(activityId, num(record.calories_sent));
    for (const list of [record.created_ids, record.pending_deletes]) {
      if (!Array.isArray(list)) continue;
      for (const id of list) {
        const key = String(id ?? "").trim();
        if (key && !ids.has(key)) ids.set(key, null);
      }
    }
    if (ids.size) out.set(date, ids);
  }
  return out;
}

/**
 * Subtract, ONCE, what Cairn's shells contributed to each stored day. Only rows whose
 * `cairn_shell_kcal` is still NULL are touched, and each is stamped with the amount (0
 * on a day with no shell), so a second pass finds nothing to do. Our share is
 * Σ max(0, shell kcal − full-day bmr/min × minutes), capped at the summary's
 * `burnedKilocalories` — never all of burned, which also carries the athlete's own
 * non-watch energy. A day whose share cannot be told (the day not yet over, or a shell
 * with no calories or duration on record) is left exactly as stored.
 */
export function repairCairnShellEnergy(db: DatabaseSync): { adjusted: number; stamped: number } {
  if (!hasTable(db, "garmin_daily_metrics")) return { adjusted: 0, stamped: 0 };
  for (const col of ["cairn_shell_kcal", "active_calories", "total_calories", "bmr_calories", "raw_json"]) {
    if (!hasColumn(db, "garmin_daily_metrics", col)) return { adjusted: 0, stamped: 0 };
  }
  const withRawCols = hasColumn(db, "garmin_daily_metrics", "burned_calories")
    && hasColumn(db, "garmin_daily_metrics", "wellness_active_calories");
  const today = localToday();
  const ledger = ledgerShellIds(db);
  const activitiesByDate = new Map<string, any[]>();
  if (hasTable(db, "garmin_activities")) {
    const rows = db
      .prepare(`SELECT date, external_id, name, duration_min, raw_json FROM garmin_activities`)
      .all() as any[];
    for (const row of rows) {
      const date = String(row.date ?? "").slice(0, 10);
      const list = activitiesByDate.get(date) ?? [];
      list.push(row);
      activitiesByDate.set(date, list);
    }
  }

  const days = db
    .prepare(
      `SELECT id, date, active_calories, total_calories, bmr_calories, raw_json
         FROM garmin_daily_metrics WHERE cairn_shell_kcal IS NULL`
    )
    .all() as any[];
  const update = db.prepare(
    `UPDATE garmin_daily_metrics SET active_calories = ?, total_calories = ?, cairn_shell_kcal = ? WHERE id = ?`
  );
  const updateRaw = withRawCols
    ? db.prepare(
        `UPDATE garmin_daily_metrics
            SET burned_calories = COALESCE(burned_calories, ?),
                wellness_active_calories = COALESCE(wellness_active_calories, ?)
          WHERE id = ?`
      )
    : null;
  let adjusted = 0;
  let stamped = 0;
  for (const day of days) {
    try {
      const date = String(day.date ?? "").slice(0, 10);
      const summary = parseObject(day.raw_json)?.summary ?? null;
      const burnedRaw = num(summary?.burnedKilocalories);
      const burned = burnedRaw != null && burnedRaw >= 0 ? burnedRaw : null;
      const wellnessRaw = num(summary?.wellnessActiveKilocalories);
      const wellness = wellnessRaw != null && wellnessRaw >= 0 ? wellnessRaw : null;
      const ids = ledger.get(date) ?? new Map<string, number | null>();
      const shells: CairnShellEnergyShell[] = [];
      for (const row of activitiesByDate.get(date) ?? []) {
        const id = String(row.external_id ?? "");
        if (!isCairnAuthoredName(row.name) && !ids.has(id)) continue;
        const raw = parseObject(row.raw_json);
        const rawSec = num(raw?.duration);
        shells.push({
          kcal: ids.get(id) ?? num(raw?.calories),
          duration_min: rawSec != null ? rawSec / 60 : num(row.duration_min),
        });
      }
      const bmr = num(day.bmr_calories) ?? num(summary?.bmrKilocalories);
      const owned = cairnShellOwnedKcal({
        burned,
        active: num(day.active_calories),
        // A stored day's BMR is a full-day rate only once the day is over.
        bmr_per_min: date < today && bmr != null && bmr > 0 ? bmr / MINUTES_PER_DAY : null,
        shells,
      });
      if (updateRaw) updateRaw.run(burned, wellness, Number(day.id));
      if (owned == null) continue;
      const minus = (value: unknown) => {
        const n = num(value);
        return n == null ? null : round1(Math.max(0, n - owned));
      };
      update.run(minus(day.active_calories), minus(day.total_calories), owned, Number(day.id));
      stamped++;
      if (owned > 0) adjusted++;
    } catch {
      /* one unreadable row is left exactly as stored */
    }
  }
  return { adjusted, stamped };
}
