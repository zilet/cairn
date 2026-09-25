// Cairn's own strength shells, taken back OUT of Garmin's day energy.
//
// Cairn writes each finished strength session to Garmin as a manual "shell" activity
// and sets its calories to our own estimate (repo/strength-energy.ts). Garmin then
// counts that activity in the day: its daily summary reports
//
//   activeKilocalories = wellnessActiveKilocalories (watch-measured)
//                      + burnedKilocalories         (non-watch: manual entries, imports)
//   totalKilocalories  = bmrKilocalories + activeKilocalories
//
// and each manual activity adds max(0, activity kcal − fullDayBmr/1440 × minutes) to
// `burned` (verified live on the athlete's account). Watch recordings live inside
// wellnessActive and never in burned.
//
// So reading the day's totals verbatim would feed Cairn's OWN estimate back into its
// expenditure prior — the calorie target would rise because we told Garmin a number.
// THE LAW: Cairn's energy math must not move because of what Cairn sent. What the
// shells contributed (`owned`) is subtracted before the totals are stored, always
// recomputed from the raw summary so a re-sync never subtracts twice.

import { db } from "../db.js";
import { round1 } from "../lib/numbers.js";
import { isCairnAuthoredName } from "./garmin-authorship.js";
import { getSessionGarminExport } from "./garmin-strength-export.js";
import { addDaysISO, localDateISO } from "./shared.js";

export const MINUTES_PER_DAY = 1440;

export interface CairnShellEnergyShell {
  /** The shell's own activity calories as Garmin holds them (placeholder or our estimate). */
  kcal: number | null;
  duration_min: number | null;
}

export interface CairnShellEnergyInput {
  /** summary.burnedKilocalories — what non-watch activities added. Null when absent. */
  burned: number | null;
  /** summary.activeKilocalories — never subtract more than this. */
  active: number | null;
  /** The FULL-DAY BMR rate Garmin charges a manual activity, kcal/min. */
  bmr_per_min: number | null;
  /** Every Cairn-authored shell on the date. */
  shells: CairnShellEnergyShell[];
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * How many of the day's kcal Cairn's own shells put there, or null when it cannot be
 * told. Pure.
 *
 * Our share is Σ max(0, shell kcal − full-day bmr/min × minutes) — exactly what Garmin
 * adds per manual activity (verified live: 194 kcal / 32 min at bmr 1925 → 151;
 * 65.534 / 31 min → 24) — capped at `burned`. It is NEVER simply all of `burned`:
 * burned also carries whatever else reached the day outside the watch (the athlete's
 * own hand-entered activity, an Edge / phone / Zwift import), and that energy is real.
 *
 *  - No shell on the date → 0.
 *  - No full-day BMR rate, or a shell whose calories or duration are unknown (a create
 *    that has not synced back yet) → null: the caller keeps its last net value rather
 *    than guessing.
 *
 * Never more than `burned` or `active`, never negative.
 */
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

/** Every activity id the export ledger says Cairn authored on this date. */
function ledgerShellIds(date: string): Map<string, number | null> {
  const ids = new Map<string, number | null>();
  const sessions = db.prepare(`SELECT id FROM sessions WHERE date = ? AND garmin_json IS NOT NULL`).all(date) as any[];
  for (const row of sessions) {
    const record = getSessionGarminExport(Number(row.id));
    if (!record) continue;
    const sent = record.source === "manual" ? (record.calories_sent ?? null) : null;
    if (record.source === "manual") ids.set(record.activity_id, sent);
    for (const id of [...(record.created_ids ?? []), ...(record.pending_deletes ?? [])]) {
      if (!ids.has(id)) ids.set(id, null);
    }
  }
  return ids;
}

/**
 * Cairn's own shells on one date. Provenance is the name marker Cairn writes OR the
 * export ledger — the same two answers the exporter trusts. A shell's calories are the
 * ledger's `calories_sent` first (the calorie PUT can land after this sync's activity
 * pass stored the old placeholder), else the stored provider payload
 * (`garmin_activities.calories` is deliberately null for a shell).
 */
export function cairnShellsOn(date: string): CairnShellEnergyShell[] {
  const ledger = ledgerShellIds(date);
  const rows = db
    .prepare(`SELECT external_id, name, duration_min, raw_json FROM garmin_activities WHERE date = ?`)
    .all(date) as any[];
  const shells: CairnShellEnergyShell[] = [];
  for (const row of rows) {
    const id = String(row.external_id ?? "");
    if (!isCairnAuthoredName(row.name) && !ledger.has(id)) continue;
    const raw = parseObject(row.raw_json);
    const rawSec = num(raw?.duration);
    shells.push({
      kcal: ledger.get(id) ?? num(raw?.calories),
      duration_min: rawSec != null ? rawSec / 60 : num(row.duration_min),
    });
  }
  return shells;
}

/**
 * Garmin charges a manual activity at the FULL-DAY BMR rate even on a partial summary
 * (today's bmrKilocalories covers only the hours elapsed). A finished day's own BMR is
 * that rate; today borrows the latest finished day's stored BMR from the last two
 * weeks. Null when neither exists.
 */
export function fullDayBmrPerMin(date: string, summaryBmr: number | null): number | null {
  const today = localDateISO();
  const bmr = num(summaryBmr);
  if (date < today && bmr != null && bmr > 0) return bmr / MINUTES_PER_DAY;
  const row = db
    .prepare(
      `SELECT bmr_calories FROM garmin_daily_metrics
        WHERE date < ? AND date >= ? AND date < ? AND bmr_calories > 0
        ORDER BY date DESC LIMIT 1`
    )
    .get(today, addDaysISO(date, -14), date) as any;
  const stored = num(row?.bmr_calories);
  return stored != null && stored > 0 ? stored / MINUTES_PER_DAY : null;
}

/**
 * `undefined` on active/total/cairn_shell_kcal means "leave what is stored": the day has
 * Cairn shells but their share cannot be told, and the COALESCE upsert then keeps the
 * last NET values instead of overwriting them with Garmin's gross ones.
 */
export interface CairnShellEnergyFold {
  active_calories: number | null | undefined;
  total_calories: number | null | undefined;
  cairn_shell_kcal: number | null | undefined;
  burned_calories: number | null;
  wellness_active_calories: number | null;
}

function nonNeg(obj: any, keys: string[]): number | null {
  for (const key of keys) {
    const n = num(obj?.[key]);
    if (n != null && n >= 0) return n;
  }
  return null;
}

/**
 * The day's energy with Cairn's own shells taken out, from the RAW summary. Always
 * recomputed from the provider's numbers, never from a stored (already adjusted)
 * value, so every re-sync lands on the same answer. When `owned` cannot be told the
 * three are `undefined`, so the stored net values stand — never Garmin's gross ones.
 */
export function neutralizeCairnShellEnergy(summary: any, date: string): CairnShellEnergyFold {
  const active = nonNeg(summary, ["activeKilocalories", "activeCalories"]);
  const total = nonNeg(summary, ["totalKilocalories", "totalCalories"]);
  const burned = nonNeg(summary, ["burnedKilocalories"]);
  const wellness = nonNeg(summary, ["wellnessActiveKilocalories"]);
  const shells = cairnShellsOn(date);
  const owned = cairnShellOwnedKcal({
    burned,
    active,
    bmr_per_min: shells.length ? fullDayBmrPerMin(date, nonNeg(summary, ["bmrKilocalories", "bmrCalories"])) : null,
    shells,
  });
  if (owned == null) {
    return {
      active_calories: undefined,
      total_calories: undefined,
      cairn_shell_kcal: undefined,
      burned_calories: burned,
      wellness_active_calories: wellness,
    };
  }
  const minus = (value: number | null) => (value == null ? value : round1(Math.max(0, value - owned)));
  return {
    active_calories: minus(active),
    total_calories: minus(total),
    cairn_shell_kcal: owned,
    burned_calories: burned,
    wellness_active_calories: wellness,
  };
}
