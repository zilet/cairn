// Mobility and flexibility as MEASURED things: a few short self-checks the athlete repeats
// (never a test battery, never a grade), plus how often mobility work is actually logged.
//
// The catalog below is the ONE table of checks. Each is an established field test a person
// can do alone in about two minutes with a wall and a tape, read as a single number where
// more (or less, stated per check) is more range. There are NO norms here: no bands, no
// "good/poor", no age comparison. A reading is compared only with the athlete's own earlier
// readings, and only across at least three weeks, so day-to-day noise never reads as a trend.
// A move smaller than the check's `smallest_change` reads as holding.
//
// Storage is canonical (cm for lengths, s for the squat hold); the athlete's display units
// (`athleteUnits()`) decide at the edge whether a length is said in cm or inches.
//
// Pull, never push: the `invite` is an offer that sits on Horizon. Nothing here notifies,
// nags, or gates anything.

import { db } from "../db.js";
import type {
  MobilityCheckCatalogEntry,
  MobilityCheckDeleteResult,
  MobilityCheckKey,
  MobilityCheckLogResult,
  MobilityCheckRead,
  MobilityCheckRow,
  MobilityChecksList,
  MobilityCheckSide,
  MobilityStanding,
} from "../contracts/mobility.js";
import { addDaysISO, daysBetweenISO, isoDate } from "../lib/dates.js";
import { dateWords, type AthleteUnits } from "./display-words.js";
import { withExerciseInputs } from "./exercise-input.js";
import { athleteUnits } from "./settings.js";
import { localDateISO } from "./shared.js";

export type { MobilityCheckRead, MobilityStanding } from "../contracts/mobility.js";

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

// Sources, per check:
// - ankle_knee_to_wall: the weight-bearing lunge test ("knee to wall"), Bennell et al. 1998
//   (Aust J Physiother 44:175). Distance big toe to wall with the knee touching the wall and
//   the heel down. Reliability reviews (Powden, Hoch & Hoch 2015, Man Ther) put its smallest
//   detectable change at roughly 1 to 2 cm, hence 1.5 cm.
// - toe_touch: the fingertip-to-floor test, Perret et al. 2001 (Arch Phys Med Rehabil
//   82:1566): reliable and responsive, with a measurement error of a few centimetres, hence
//   3 cm. Lower is more range; reaching past the floor (on a step) is negative.
// - shoulder_back_scratch: the back scratch test of the Senior Fitness Test (Rikli & Jones
//   1999, J Aging Phys Act 7:129), scored as theirs is: a gap between the middle fingertips
//   is minus, an overlap is plus, so a bigger number is more range. Side = the hand that
//   reaches over the shoulder. 2 cm is about its test-retest noise.
// - deep_squat_hold: the heels-down bottom position of the Functional Movement Screen deep
//   squat (Cook, Burton & Hoogenboom 2006, N Am J Sports Phys Ther), without the dowel, as a
//   timed hold. The timed form is a common coaching field check rather than a validated
//   test, so it is read coarsely (10 s) and capped at a minute in the how-to.
//
// Left out on purpose: hips (seated 90/90 has no single unambiguous number without a
// goniometer or an inclinometer app) and thoracic rotation (every numeric field version
// needs a stick and an angle measure). See the stream report.
export const MOBILITY_CHECKS: readonly MobilityCheckCatalogEntry[] = [
  {
    key: "ankle_knee_to_wall",
    label: "Ankle",
    unit: "cm",
    per_side: true,
    better: "more",
    how_to:
      "Kneel facing a wall, front foot flat, and slide that foot back until the knee only just touches the wall with the heel still down; measure big toe to wall (0 if the knee cannot touch with the toe at the wall).",
    smallest_change: 1.5,
  },
  {
    key: "toe_touch",
    label: "Hamstrings",
    unit: "cm",
    per_side: false,
    better: "less",
    how_to:
      "Stand with feet together and knees straight, reach down slowly and hold, then measure middle fingertip to floor (0 if you touch it; on a step, the reach past the edge counts as minus).",
    smallest_change: 3,
  },
  {
    key: "shoulder_back_scratch",
    label: "Shoulder",
    unit: "cm",
    per_side: true,
    better: "more",
    how_to:
      "Reach one hand over that shoulder and down your back and the other hand up from below; measure the gap between the middle fingertips as minus, or their overlap as plus. The side is the hand that goes over the top.",
    smallest_change: 2,
  },
  {
    key: "deep_squat_hold",
    label: "Deep squat",
    unit: "s",
    per_side: false,
    better: "more",
    how_to:
      "Feet about shoulder-width, sink into the deepest squat you can with heels flat, and count the seconds you can stay there comfortably, up to a minute (0 if the heels lift before the bottom).",
    smallest_change: 10,
  },
] as const;

const CATALOG_BY_KEY = new Map<string, MobilityCheckCatalogEntry>(MOBILITY_CHECKS.map((c) => [c.key, c]));

// Plausible bounds per check, in the canonical unit. A number outside is a misread, never
// stored clamped.
const BOUNDS: Record<MobilityCheckKey, { min: number; max: number }> = {
  ankle_knee_to_wall: { min: 0, max: 30 },
  toe_touch: { min: -40, max: 80 },
  shoulder_back_scratch: { min: -60, max: 40 },
  deep_squat_hold: { min: 0, max: 600 },
};

// The words a stated name may use for a check (chat, MCP, REST alike).
const KEY_ALIASES: Record<string, MobilityCheckKey> = {
  ankle_knee_to_wall: "ankle_knee_to_wall",
  knee_to_wall: "ankle_knee_to_wall",
  ankle: "ankle_knee_to_wall",
  ankles: "ankle_knee_to_wall",
  ankle_dorsiflexion: "ankle_knee_to_wall",
  dorsiflexion: "ankle_knee_to_wall",
  lunge_test: "ankle_knee_to_wall",
  weight_bearing_lunge: "ankle_knee_to_wall",
  toe_touch: "toe_touch",
  toe_touch_test: "toe_touch",
  fingertip_to_floor: "toe_touch",
  finger_to_floor: "toe_touch",
  hamstring: "toe_touch",
  hamstrings: "toe_touch",
  forward_fold: "toe_touch",
  shoulder_back_scratch: "shoulder_back_scratch",
  back_scratch: "shoulder_back_scratch",
  apley: "shoulder_back_scratch",
  apley_scratch: "shoulder_back_scratch",
  shoulder: "shoulder_back_scratch",
  shoulders: "shoulder_back_scratch",
  deep_squat_hold: "deep_squat_hold",
  deep_squat: "deep_squat_hold",
  squat_hold: "deep_squat_hold",
  deep_squat_test: "deep_squat_hold",
};

/** A stated check name ("knee to wall", "back scratch") to its catalog key, or null. */
export function resolveMobilityCheckKey(raw: unknown): MobilityCheckKey | null {
  const norm = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return norm ? (KEY_ALIASES[norm] ?? null) : null;
}

export function mobilityCheckEntry(key: MobilityCheckKey): MobilityCheckCatalogEntry {
  return CATALOG_BY_KEY.get(key) as MobilityCheckCatalogEntry;
}

/** "left" | "right" from a stated side ("L", "Right"), or null. */
export function normalizeMobilitySide(raw: unknown): MobilityCheckSide | null {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (s === "left" || s === "l") return "left";
  if (s === "right" || s === "r") return "right";
  return null;
}

/**
 * The catalog as compact prompt lines (the chat action's guidance): key, unit, sides, which
 * way is more range, and the one-sentence how-to. Cheap on purpose: no DATA block.
 */
export function mobilityCatalogPromptLines(): string[] {
  return MOBILITY_CHECKS.map(
    (c) =>
      `${c.key} (${c.label.toLowerCase()}; ${c.unit}${c.per_side ? ", per side" : ""}; ${c.better === "more" ? "higher" : "lower"} = more range): ${c.how_to}`
  );
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const CM_PER_IN = 2.54;

type LengthUnit = "cm" | "in";

// The settings registry has no length kind; a length follows the athlete's distance choice
// (miles → inches), the same imperial/metric split the rest of the app speaks in.
function lengthUnitOf(units: AthleteUnits): LengthUnit {
  return units.distance === "mi" ? "in" : "cm";
}

function plain(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function lengthText(cm: number, unit: LengthUnit): string {
  return `${plain(unit === "in" ? cm / CM_PER_IN : cm)} ${unit}`;
}

/** A reading in words, in the athlete's units. */
export function mobilityValueWords(
  key: MobilityCheckKey,
  value: number | null,
  units: AthleteUnits = athleteUnits()
): string {
  const lu = lengthUnitOf(units);
  if (key === "deep_squat_hold") {
    if (value == null) return "Heels down, untimed";
    if (value <= 0) return "Heels lift";
    return `${Math.round(value)} s, heels down`;
  }
  const v = value ?? 0;
  const zero = Math.abs(v) < 0.05;
  if (key === "toe_touch") {
    if (zero) return "Touches the floor";
    return v > 0 ? `${lengthText(v, lu)} from the floor` : `${lengthText(-v, lu)} past the floor`;
  }
  if (key === "shoulder_back_scratch") {
    if (zero) return "Fingertips touch";
    return v < 0 ? `${lengthText(-v, lu)} gap` : `${lengthText(v, lu)} overlap`;
  }
  return lengthText(v, lu);
}

function checkLabel(key: MobilityCheckKey, side: MobilityCheckSide | null): string {
  const label = mobilityCheckEntry(key).label;
  return side ? `${label}, ${side}` : label;
}

// The phrase for a move of `gain` (positive = more range) on this check.
function movePhrase(key: MobilityCheckKey, gain: boolean): string {
  if (key === "deep_squat_hold") return gain ? "longer" : "shorter";
  if (key === "ankle_knee_to_wall") return gain ? "more" : "less";
  return gain ? "more reach" : "less reach";
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface StoredRow {
  id: number;
  date: string;
  check_key: string;
  side: string | null;
  value: number | null;
  unit: string;
  note: string | null;
  source: string | null;
  created_at: string | null;
}

function toRow(raw: StoredRow, units: AthleteUnits): MobilityCheckRow | null {
  const key = resolveMobilityCheckKey(raw.check_key);
  if (!key) return null;
  const side = normalizeMobilitySide(raw.side);
  const value = raw.value == null ? null : Number(raw.value);
  return {
    id: Number(raw.id),
    date: String(raw.date),
    check_key: key,
    side,
    value,
    unit: mobilityCheckEntry(key).unit,
    note: raw.note ?? null,
    source: raw.source === "chat" ? "chat" : "user",
    created_at: raw.created_at ?? null,
    label: checkLabel(key, side),
    value_text: mobilityValueWords(key, value, units),
  };
}

export interface MobilityCheckInput {
  /** The catalog key or a plain name ("knee to wall"). `check` is accepted as a synonym. */
  check_key?: unknown;
  check?: unknown;
  side?: unknown;
  value?: unknown;
  /** "cm" (default for lengths), "in", "mm"; "s" (default for the squat hold), "min". */
  unit?: unknown;
  /** Deep squat only: heels down at the bottom (true) or not (false), when no seconds were given. */
  reached?: unknown;
  date?: unknown;
  note?: unknown;
  source?: unknown;
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function canonicalValue(key: MobilityCheckKey, raw: number, unit: unknown): number | null {
  const u = String(unit ?? "")
    .trim()
    .toLowerCase();
  if (key === "deep_squat_hold") {
    if (!u || u === "s" || u === "sec" || u === "secs" || u === "second" || u === "seconds") return raw;
    if (u === "min" || u === "mins" || u === "minute" || u === "minutes") return raw * 60;
    return null;
  }
  if (!u || u === "cm" || u === "centimeters" || u === "centimetres") return raw;
  if (u === "in" || u === "inch" || u === "inches" || u === '"') return raw * CM_PER_IN;
  if (u === "mm" || u === "millimeters" || u === "millimetres") return raw / 10;
  return null;
}

/** Log one reading (one side). Every surface (REST, MCP, chat) writes through here. */
export function logMobilityCheck(input: MobilityCheckInput, today: string = localDateISO()): MobilityCheckLogResult {
  const key = resolveMobilityCheckKey(input?.check_key ?? input?.check);
  if (!key) {
    return {
      ok: false,
      error: `Unknown check. Use one of: ${MOBILITY_CHECKS.map((c) => c.key).join(", ")}.`,
    };
  }
  const entry = mobilityCheckEntry(key);
  let side: MobilityCheckSide | null = null;
  if (entry.per_side) {
    side = normalizeMobilitySide(input.side);
    if (!side) return { ok: false, error: `Say which side for the ${entry.label.toLowerCase()} check: left or right.` };
  }

  let value: number | null;
  const stated = finiteOrNull(input.value);
  if (stated != null) {
    const canonical = canonicalValue(key, stated, input.unit);
    if (canonical == null) {
      return { ok: false, error: `That unit does not fit this check; use ${key === "deep_squat_hold" ? "s" : "cm or in"}.` };
    }
    value = key === "deep_squat_hold" ? Math.round(canonical) : Math.round(canonical * 10) / 10;
  } else if (key === "deep_squat_hold" && (input.reached === true || input.reached === false)) {
    value = input.reached ? null : 0;
  } else {
    return { ok: false, error: "A reading needs a number." };
  }
  if (key === "deep_squat_hold" && input.reached === false) value = 0;
  if (value != null) {
    const { min, max } = BOUNDS[key];
    if (value < min || value > max) {
      return { ok: false, error: "That number looks off for this check. Measure again?" };
    }
  }

  let date = today;
  if (input.date != null && String(input.date).trim() !== "") {
    const d = isoDate(input.date);
    if (!d || d > today) return { ok: false, error: "date must be a real YYYY-MM-DD on or before today" };
    date = d;
  }
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 280) : null;
  const source = input.source === "chat" ? "chat" : "user";

  const res = db
    .prepare(
      `INSERT INTO mobility_checks (date, check_key, side, value, unit, note, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(date, key, side, value, entry.unit, note, source);
  const raw = db.prepare(`SELECT * FROM mobility_checks WHERE id = ?`).get(Number(res.lastInsertRowid)) as unknown as
    | StoredRow
    | undefined;
  const row = raw ? toRow(raw, athleteUnits()) : null;
  return row ? { ok: true, check: row } : { ok: false, error: "The reading could not be read back." };
}

export interface ListMobilityChecksOptions {
  check_key?: unknown;
  /** Only readings within this many days of `today`. */
  days?: number | null;
  limit?: number | null;
  today?: string;
}

/** Readings newest first, plus the catalog (so a reader can say how to do each check). */
export function listMobilityChecks(opts: ListMobilityChecksOptions = {}): MobilityChecksList {
  const key = opts.check_key == null || opts.check_key === "" ? null : resolveMobilityCheckKey(opts.check_key);
  if (opts.check_key != null && opts.check_key !== "" && !key) return { checks: [], catalog: [...MOBILITY_CHECKS] };
  const today = opts.today ?? localDateISO();
  const days = Number(opts.days);
  const since = Number.isFinite(days) && days > 0 ? addDaysISO(today, -Math.floor(days)) : null;
  const limitRaw = Number(opts.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, Math.floor(limitRaw)) : 200;
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (key) {
    where.push("check_key = ?");
    args.push(key);
  }
  if (since) {
    where.push("date >= ?");
    args.push(since);
  }
  const rows = db
    .prepare(
      `SELECT * FROM mobility_checks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY date DESC, id DESC LIMIT ?`
    )
    .all(...args, limit) as unknown as StoredRow[];
  const units = athleteUnits();
  return {
    checks: rows.map((r) => toRow(r, units)).filter((r): r is MobilityCheckRow => r != null),
    catalog: [...MOBILITY_CHECKS],
  };
}

/** Remove one reading (a mis-entry). */
export function deleteMobilityCheck(id: number): MobilityCheckDeleteResult {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, code: "invalid_id", error: "id must be a positive integer" };
  const res = db.prepare(`DELETE FROM mobility_checks WHERE id = ?`).run(n);
  return Number(res.changes) > 0 ? { ok: true, id: n } : { ok: false, code: "not_found", error: "not found" };
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/** A direction is read only against a reading at least this many days older. */
export const MOBILITY_TREND_MIN_DAYS = 21;
/** Latest check older than this: the invite offers a repeat. */
export const MOBILITY_REPEAT_AFTER_DAYS = 56;
/** The practice window: the last four weeks, today included. */
export const MOBILITY_PRACTICE_WINDOW_DAYS = 28;

export const MOBILITY_FIRST_INVITE =
  "Four short checks would let this speak: ankles, hamstrings, shoulders, a deep squat. Tell the coach when you have ten minutes.";

function repeatInvite(lastDate: string, today: string): string {
  return `Your last mobility checks were on ${dateWords(lastDate, today)}. Repeating them would show which way things have moved. Tell the coach when you have ten minutes.`;
}

interface Movement {
  direction: MobilityCheckRead["direction"];
  move_words: string | null;
}

function movementOf(
  key: MobilityCheckKey,
  latest: MobilityCheckRow,
  base: MobilityCheckRow | null,
  today: string,
  units: AthleteUnits
): Movement {
  if (!base) return { direction: null, move_words: null };
  const since = dateWords(base.date, today);
  // The untimed heels-down squat: only "reached now vs could not then" (or the reverse) can be told.
  if (latest.value == null || base.value == null) {
    if (key !== "deep_squat_hold") return { direction: null, move_words: null };
    if (latest.value == null && base.value === 0) return { direction: "better", move_words: `heels down now, not on ${since}` };
    if (base.value == null && latest.value === 0) return { direction: "worse", move_words: `heels lift now, down on ${since}` };
    return { direction: null, move_words: null };
  }
  const entry = mobilityCheckEntry(key);
  const delta = latest.value - base.value;
  if (Math.abs(delta) < entry.smallest_change) return { direction: "holding", move_words: `about the same as ${since}` };
  const gain = entry.better === "more" ? delta > 0 : delta < 0;
  const amount =
    entry.unit === "s" ? `${Math.round(Math.abs(delta))} s` : lengthText(Math.abs(delta), lengthUnitOf(units));
  return { direction: gain ? "better" : "worse", move_words: `${amount} ${movePhrase(key, gain)} than ${since}` };
}

/** Distinct days in the last four weeks with a logged mobility set (a drill, a stretch, a timed hold). */
export function mobilityPracticeDays(today: string = localDateISO()): number {
  const start = addDaysISO(today, -(MOBILITY_PRACTICE_WINDOW_DAYS - 1));
  if (!start) return 0;
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT s.date AS date, e.id AS id, e.name AS name, e.muscle_group AS muscle_group, e.mode AS mode,
                e.equipment AS equipment, e.input_profile AS input_profile, e.per_side AS per_side
           FROM logged_sets ls
           JOIN sessions s ON s.id = ls.session_id
           JOIN exercises e ON e.id = ls.exercise_id
          WHERE s.date >= ? AND s.date <= ?`
      )
      .all(start, today) as Array<Record<string, any>>;
    if (!rows.length) return 0;
    const days = new Set<string>();
    for (const row of withExerciseInputs(rows)) {
      if (row.input.profile === "mobility") days.add(String(row.date));
    }
    return days.size;
  } catch {
    return 0;
  }
}

/** Where mobility stands as of `today`. */
export function mobilityStanding(today: string = localDateISO()): MobilityStanding {
  const units = athleteUnits();
  const raw = db
    .prepare(`SELECT * FROM mobility_checks WHERE date <= ? ORDER BY date ASC, id ASC`)
    .all(today) as unknown as StoredRow[];
  const rows = raw.map((r) => toRow(r, units)).filter((r): r is MobilityCheckRow => r != null);
  const practice = mobilityPracticeDays(today);
  if (!rows.length) {
    return { available: false, checks: [], practice_days_4wk: practice, invite: MOBILITY_FIRST_INVITE };
  }

  // Per (check, side): the first reading and the latest, oldest-first input.
  const groups = new Map<string, { first: MobilityCheckRow; latest: MobilityCheckRow }>();
  for (const row of rows) {
    const id = `${row.check_key}${row.side ? `:${row.side}` : ""}`;
    const g = groups.get(id);
    if (!g) groups.set(id, { first: row, latest: row });
    else g.latest = row;
  }

  const order = new Map(MOBILITY_CHECKS.map((c, i) => [c.key, i]));
  const sideRank = (s: MobilityCheckSide | null) => (s === "left" ? 0 : s === "right" ? 1 : 0);
  const checks: MobilityCheckRead[] = [...groups.entries()]
    .sort(
      ([, a], [, b]) =>
        (order.get(a.latest.check_key) ?? 99) - (order.get(b.latest.check_key) ?? 99) ||
        sideRank(a.latest.side) - sideRank(b.latest.side)
    )
    .map(([id, { first, latest }]) => {
      const gap = daysBetweenISO(latest.date, first.date);
      const base = gap != null && gap >= MOBILITY_TREND_MIN_DAYS ? first : null;
      const move = movementOf(latest.check_key, latest, base, today, units);
      return {
        id,
        label: latest.label,
        now_text: latest.value_text,
        date: latest.date,
        direction: move.direction,
        move_words: move.move_words,
      };
    });

  const lastDate = rows[rows.length - 1].date;
  const age = daysBetweenISO(today, lastDate);
  const invite = age != null && age > MOBILITY_REPEAT_AFTER_DAYS ? repeatInvite(lastDate, today) : null;
  return { available: true, checks, practice_days_4wk: practice, invite };
}
