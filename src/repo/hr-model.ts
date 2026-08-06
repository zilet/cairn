// PERSONAL HR MODEL — the one source of truth for what a heart rate means for
// THIS athlete. Population formulas (220 − age, a fixed 128–140 "Z2") are never
// consulted anywhere else: every zone band, every zone label rendered to the
// athlete, and every "was that run easy or hard" classification derives from
// observed data through this module. An athlete whose conversational pace sits
// at 160 bpm is a baseline, not an anomaly.
//
// Calibration lives on a ladder: a detected field test (30-min steady effort)
// anchors the threshold estimate; absent that, the best sustained observed
// effort estimates it; absent enough data, the model says "insufficient" and
// consumers fall back to neutral language — it never invents a band from age.
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { sensorIsCurrent } from "./sensor-freshness.js";
import { localDateISO } from "./shared.js";

export type HrZoneKey = "z1" | "z2" | "z3" | "z4" | "z5";

export type HrModel = {
  /** Outlier-guarded top of the observed max-HR distribution, bpm. */
  observed_max: number | null;
  /** Estimated lactate-threshold HR, bpm. */
  lthr: number | null;
  lthr_basis: "field_test" | "sustained_effort" | "fallback" | null;
  /** Zone ceilings in bpm; z5 is open-ended above z4_top. */
  zones: { z1_top: number; z2_top: number; z3_top: number; z4_top: number } | null;
  resting: number | null;
  confidence: "anchored" | "estimated" | "insufficient";
  basis_runs: number;
  window_days: number;
  updated_at: string | null;
};

const WINDOW_DAYS = 183;

// A single freak reading — a chest strap dropout, a cadence lock, one spike in a
// hot crowded start — sits well clear of the rest of the distribution and would
// drag every zone band up with it for six months. So the top of the distribution
// is read against its own runner-up: when the highest max-HR ever seen beats the
// second-highest by more than this, the second is the honest ceiling.
const OUTLIER_GAP_BPM = 8;
// How long an effort must run before its AVERAGE heart rate says anything about
// threshold. Below this an average is dominated by the warm-up and by whatever
// the last surge did; at 35+ minutes a steady average is a real physiological
// statement.
const SUSTAINED_MIN_MINUTES = 35;
// The best sustained average sits a little UNDER threshold (nobody averages
// their threshold across a whole steady run), so the estimate scales it up — and
// is then capped below the observed max, because a threshold at 98% of max is
// not physiology, it is a data error.
const SUSTAINED_TO_LTHR = 1.02;
const LTHR_CEILING_OF_MAX = 0.97;
// The floor of the ladder: a plain fraction of the OBSERVED max (never of an
// age formula). Honest enough to prescribe against, weak enough that the model
// keeps asking for a better anchor.
const FALLBACK_LTHR_OF_MAX = 0.92;
// How long a field test may anchor the model before it stops speaking for today.
export const LTHR_FIELD_TEST_MAX_AGE_DAYS = 120;
// Fewer HR-bearing outings than this and there is no distribution to read — the
// model reports "insufficient" and every consumer falls back to neutral language.
const MIN_BASIS_RUNS = 3;

// Garmin normalizes running types to a handful of strings ("run", "trail_running",
// "treadmill_running"). Threshold and efficiency are running-specific reads — a
// ride's heart rate answers a different question — so both filter on this.
export const RUN_TYPE_SQL = "LOWER(COALESCE(type,'')) LIKE '%run%'";

function shiftISO(dateISO: string, days: number): string {
  const ms = Date.parse(`${String(dateISO).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ms)) return String(dateISO).slice(0, 10);
  return new Date(ms + days * 864e5).toISOString().slice(0, 10);
}

// Null-safe numeric coercion. The explicit null/empty guard is load-bearing:
// Number(null) is 0, not NaN, so an EMPTY aggregate (`MAX(avg_hr)` over no rows)
// would otherwise read as a real observation of zero — which is how a threshold
// of 0 bpm and a zone table of all zeroes gets built out of no data at all.
function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------- the raw observations ----------

// The outlier-guarded top of the max-HR distribution, plus how many HR-bearing
// outings the window holds at all (the model's own sample size).
function observedFromActivities(asOf: string): { max: number | null; runs: number } {
  const from = shiftISO(asOf, -WINDOW_DAYS);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM garmin_activities
       WHERE max_hr IS NOT NULL AND max_hr > 0 AND date >= ? AND date <= ?`
    )
    .get(from, asOf) as { n: number } | undefined;
  const runs = Number(row?.n ?? 0);
  if (!runs) return { max: null, runs: 0 };
  const top = (
    db
      .prepare(
        `SELECT max_hr AS hr FROM garmin_activities
         WHERE max_hr IS NOT NULL AND max_hr > 0 AND date >= ? AND date <= ?
         ORDER BY max_hr DESC LIMIT 3`
      )
      .all(from, asOf) as Array<{ hr: number }>
  )
    .map((r) => num(r.hr))
    .filter((hr): hr is number => hr != null);
  if (!top.length) return { max: null, runs };
  const [first, second] = top;
  const guarded = second != null && first - second > OUTLIER_GAP_BPM ? second : first;
  return { max: Math.round(guarded), runs };
}

// The most recent resting HR from whichever wearable store wrote last — and only
// if it may still speak for `asOf`. A stale RHR behaves as ABSENT (the law in
// sensor-freshness.ts), and absence here is neutral: the model simply has no
// resting number, which changes nothing about the zones.
function restingHeartRate(asOf: string): number | null {
  const row = db
    .prepare(
      `SELECT date, resting_hr FROM (
         SELECT date, resting_hr FROM garmin_daily_metrics WHERE resting_hr IS NOT NULL AND resting_hr > 0 AND date <= ?
         UNION ALL
         SELECT date, resting_hr FROM daily_metrics WHERE resting_hr IS NOT NULL AND resting_hr > 0 AND date <= ?
       ) ORDER BY date DESC LIMIT 1`
    )
    .get(asOf, asOf) as { date: string; resting_hr: number } | undefined;
  if (!row) return null;
  if (!sensorIsCurrent("resting_hr", row.date, asOf)) return null;
  const hr = num(row.resting_hr);
  return hr == null ? null : Math.round(hr);
}

// A detected (or stated) 30-minute-style time trial, if one is recent enough to
// still describe today's threshold.
function fieldTestLthr(asOf: string): number | null {
  const row = db
    .prepare(
      `SELECT result_json FROM calibration_events
       WHERE kind = 'lthr_tt' AND date <= ? AND date >= ?
       ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get(asOf, shiftISO(asOf, -LTHR_FIELD_TEST_MAX_AGE_DAYS)) as { result_json: string } | undefined;
  if (!row) return null;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(row.result_json || "{}");
  } catch {
    return null;
  }
  const lthr = num(parsed?.lthr);
  // A field test that reports an implausible pulse is not evidence.
  if (lthr == null || lthr < 100 || lthr > 220) return null;
  return Math.round(lthr);
}

// The best AVERAGE heart rate the athlete has held across a genuinely sustained
// run in the window. Moving time is preferred over elapsed — a run with a long
// coffee stop is not a 60-minute effort.
function bestSustainedAvgHr(asOf: string): number | null {
  const row = db
    .prepare(
      `SELECT MAX(avg_hr) AS best FROM garmin_activities
       WHERE avg_hr IS NOT NULL AND avg_hr > 0
         AND COALESCE(moving_min, duration_min) >= ?
         AND date >= ? AND date <= ?
         AND ${RUN_TYPE_SQL}`
    )
    .get(SUSTAINED_MIN_MINUTES, shiftISO(asOf, -WINDOW_DAYS), asOf) as { best: number | null } | undefined;
  return num(row?.best);
}

// ---------- the model ----------

function computeHrModel(asOf: string): HrModel {
  const observed = observedFromActivities(asOf);
  const resting = restingHeartRate(asOf);
  if (!observed.max || observed.runs < MIN_BASIS_RUNS) {
    // Not enough observed data to say anything. Deliberately NOT a caution: an
    // insufficient model manufactures no verdict, it simply stays quiet.
    return {
      observed_max: observed.max,
      lthr: null,
      lthr_basis: null,
      zones: null,
      resting,
      confidence: "insufficient",
      basis_runs: observed.runs,
      window_days: WINDOW_DAYS,
      updated_at: null,
    };
  }

  const ceiling = Math.floor(observed.max * LTHR_CEILING_OF_MAX);
  const anchored = fieldTestLthr(asOf);
  let lthr: number;
  let basis: NonNullable<HrModel["lthr_basis"]>;
  let confidence: HrModel["confidence"];
  if (anchored != null) {
    // (a) A test the athlete actually ran. It outranks every estimate, and it is
    // NOT capped against the observed max — the test measured the thing directly,
    // and an athlete who has never gone truly maximal can honestly hold a
    // threshold above 97% of the hardest pulse their watch has yet recorded.
    lthr = anchored;
    basis = "field_test";
    confidence = "anchored";
  } else {
    const sustained = bestSustainedAvgHr(asOf);
    // A sustained average below a plausible working pulse is a broken row, not a
    // threshold — it falls through to the floor rather than defining the zones.
    if (sustained != null && sustained >= 100) {
      // (b) The best sustained effort in the window, scaled and capped.
      lthr = Math.min(Math.round(sustained * SUSTAINED_TO_LTHR), ceiling);
      basis = "sustained_effort";
    } else {
      // (c) The floor: a fraction of the observed max.
      lthr = Math.round(observed.max * FALLBACK_LTHR_OF_MAX);
      basis = "fallback";
    }
    confidence = "estimated";
  }

  return {
    observed_max: observed.max,
    lthr,
    lthr_basis: basis,
    zones: zonesFromLthr(lthr),
    resting,
    confidence,
    basis_runs: observed.runs,
    window_days: WINDOW_DAYS,
    updated_at: null,
  };
}

function readPersisted(asOf: string): HrModel | null {
  let row: { as_of: string | null; model_json: string; updated_at: string | null } | undefined;
  try {
    row = db.prepare(`SELECT as_of, model_json, updated_at FROM hr_model_state WHERE id = 1`).get() as any;
  } catch {
    return null;
  }
  if (!row || String(row.as_of ?? "").slice(0, 10) !== asOf) return null;
  try {
    const parsed = JSON.parse(row.model_json) as HrModel;
    if (!parsed || typeof parsed !== "object") return null;
    return { ...parsed, updated_at: row.updated_at ?? null };
  } catch {
    return null;
  }
}

/**
 * The current model as of a date. Serves the persisted nightly derive when it was
 * computed for this very day; otherwise derives fresh WITHOUT persisting, so a
 * read on a day the scheduler has not reached yet is still honest (a zone table
 * from another day is not today's zone table).
 */
export function getHrModel(dateISO?: string): HrModel {
  const asOf = String(dateISO || localDateISO()).slice(0, 10);
  return readPersisted(asOf) ?? computeHrModel(asOf);
}

/** Recompute from raw data + calibration events and persist as the current model. */
export function deriveHrModel(dateISO: string): HrModel {
  const asOf = String(dateISO || localDateISO()).slice(0, 10);
  const model = computeHrModel(asOf);
  db.prepare(
    `INSERT INTO hr_model_state (id, as_of, model_json, updated_at)
     VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET as_of = excluded.as_of, model_json = excluded.model_json, updated_at = datetime('now')`
  ).run(asOf, JSON.stringify({ ...model, updated_at: null }));
  return readPersisted(asOf) ?? model;
}

export function zonesFromLthr(lthr: number): NonNullable<HrModel["zones"]> {
  return {
    z1_top: Math.round(lthr * 0.85),
    z2_top: Math.round(lthr * 0.89),
    z3_top: Math.round(lthr * 0.94),
    z4_top: Math.round(lthr * 0.99),
  };
}

export function hrZoneBand(key: HrZoneKey, model?: HrModel): { low: number | null; high: number | null } {
  const m = model || getHrModel();
  if (!m.zones) return { low: null, high: null };
  const z = m.zones;
  switch (key) {
    case "z1":
      return { low: null, high: z.z1_top };
    case "z2":
      return { low: z.z1_top + 1, high: z.z2_top };
    case "z3":
      return { low: z.z2_top + 1, high: z.z3_top };
    case "z4":
      return { low: z.z3_top + 1, high: z.z4_top };
    case "z5":
      return { low: z.z4_top + 1, high: null };
  }
}

/** Athlete-facing zone label, e.g. "Z2 (145–152 bpm)". Never an age-formula band. */
export function hrZoneLabel(key: HrZoneKey, model?: HrModel): string {
  const band = hrZoneBand(key, model);
  const name = key.toUpperCase();
  if (band.low != null && band.high != null) return `${name} (${band.low}–${band.high} bpm)`;
  if (band.high != null) return `${name} (under ${band.high} bpm)`;
  if (band.low != null) return `${name} (${band.low}+ bpm)`;
  return name;
}

/**
 * Classify a completed effort against the personal model. "unknown" when the
 * model or the inputs are insufficient — absence stays neutral, never a verdict.
 *
 * Duration is weighted, not decorative: a three-minute burst up a hill averages
 * a threshold pulse without being quality work, and an hour and a quarter held
 * in the upper aerobic band IS quality work even though its average never left
 * the steady band. Both readings are about how long the pulse stayed there.
 */
export function classifyRunEffort(
  avgHr: number | null | undefined,
  durationMin: number | null | undefined,
  model?: HrModel
): "easy" | "steady" | "quality" | "unknown" {
  const m = model || getHrModel();
  const hr = num(avgHr);
  if (hr == null || !m.zones || m.confidence === "insufficient") return "unknown";
  const minutes = num(durationMin);
  if (hr <= m.zones.z2_top) {
    // A short blast that still averaged easy is a warm-up, not a session — but it
    // is not "quality" either, and the neutral floor for it is exactly "easy".
    return "easy";
  }
  if (hr <= m.zones.z3_top) {
    // The steady band earns "quality" only by DURATION: a long tempo is real
    // quality work; a ten-minute jog that drifted up is not.
    return minutes != null && minutes >= 75 ? "quality" : "steady";
  }
  // Above the steady band. A sustained effort here is quality; a brief spike —
  // one hill, one traffic-light sprint — is not, and reads as steady instead.
  if (minutes != null && minutes < 12) return "steady";
  return "quality";
}

// ---------- aerobic efficiency ----------
// Speed carried per heartbeat: metres per minute, per bpm. It is an INTERNAL
// signal — the number is never rendered to the athlete (VISION.md bans scores),
// only the direction it has moved, in comparative words.

export interface EfficiencyPoint {
  /** YYYY-MM */
  month: string;
  mean: number;
  runs: number;
}

export interface EfficiencyTrend {
  window_days: number;
  runs: number;
  points: EfficiencyPoint[];
  latest: { date: string; value: number } | null;
  /** Comparative direction only — never a grade. Null when the sample can't say. */
  direction: "improving" | "holding" | "easing" | null;
}

const EFFICIENCY_MIN_KM = 3;
const EFFICIENCY_MIN_RUNS = 4;
// Month-to-month noise in an efficiency index is a couple of percent; anything
// inside that band is "holding", not a trend.
const EFFICIENCY_BAND = 0.02;

export function efficiencyTrend(windowDays = 120, dateISO?: string): EfficiencyTrend {
  const asOf = String(dateISO || localDateISO()).slice(0, 10);
  const days = Math.max(14, Math.min(730, Math.trunc(windowDays) || 120));
  const rows = db
    .prepare(
      `SELECT date, distance_km, COALESCE(moving_min, duration_min) AS minutes, avg_hr
       FROM garmin_activities
       WHERE avg_hr IS NOT NULL AND avg_hr > 0
         AND distance_km IS NOT NULL AND distance_km >= ?
         AND COALESCE(moving_min, duration_min) > 0
         AND date >= ? AND date <= ?
         AND ${RUN_TYPE_SQL}
       ORDER BY date ASC`
    )
    .all(EFFICIENCY_MIN_KM, shiftISO(asOf, -days), asOf) as Array<{
    date: string;
    distance_km: number;
    minutes: number;
    avg_hr: number;
  }>;

  const buckets = new Map<string, { sum: number; runs: number }>();
  let latest: EfficiencyTrend["latest"] = null;
  for (const row of rows) {
    const distance = num(row.distance_km);
    const minutes = num(row.minutes);
    const hr = num(row.avg_hr);
    if (distance == null || minutes == null || hr == null || minutes <= 0 || hr <= 0) continue;
    const value = Math.round(((distance * 1000) / minutes / hr) * 1000) / 1000;
    const month = String(row.date).slice(0, 7);
    const bucket = buckets.get(month) ?? { sum: 0, runs: 0 };
    bucket.sum += value;
    bucket.runs += 1;
    buckets.set(month, bucket);
    latest = { date: String(row.date).slice(0, 10), value };
  }

  const points: EfficiencyPoint[] = [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([month, bucket]) => ({ month, mean: Math.round((bucket.sum / bucket.runs) * 1000) / 1000, runs: bucket.runs }));
  const runs = rows.length;

  let direction: EfficiencyTrend["direction"] = null;
  if (points.length >= 2 && runs >= EFFICIENCY_MIN_RUNS) {
    const first = points[0].mean;
    const last = points[points.length - 1].mean;
    if (first > 0) {
      const ratio = last / first;
      direction = ratio > 1 + EFFICIENCY_BAND ? "improving" : ratio < 1 - EFFICIENCY_BAND ? "easing" : "holding";
    }
  }
  return { window_days: days, runs, points, latest, direction };
}

// Comparative words for the efficiency read. Never the index, never a number —
// the athlete hears what changed, not what they scored. Variant sets rotate by
// day so a stable trend does not print the same sentence for a month.
const EFFICIENCY_WORDS: Record<"improving" | "holding" | "easing", readonly [string, ...string[]]> = {
  improving: [
    "You're covering more ground at the same pulse than you were.",
    "The same effort is buying you more distance lately.",
    "Your easy running has been going further for the same heart rate.",
  ],
  holding: [
    "Your running is costing about what it did a month ago.",
    "Same ground, same pulse — that part is steady right now.",
    "Effort and distance have been tracking each other lately.",
  ],
  easing: [
    "The same pace has been costing a few more beats lately.",
    "Your running is asking a little more of your heart than it was.",
    "Distance is coming at a slightly higher pulse than it did.",
  ],
};

/** One comparative sentence about aerobic efficiency, or null when it can't say. */
export function efficiencyPhrase(trend: EfficiencyTrend, dateISO?: string): string | null {
  if (!trend.direction) return null;
  const date = String(dateISO || localDateISO()).slice(0, 10);
  return pickDayVariant(EFFICIENCY_WORDS[trend.direction], date, `efficiency:${trend.direction}`);
}

// ---------- the compact coach-context view ----------

export interface HrModelSummary {
  available: boolean;
  observed_max: number | null;
  resting: number | null;
  lthr: number | null;
  lthr_basis: HrModel["lthr_basis"];
  confidence: HrModel["confidence"];
  basis_runs: number;
  /** Athlete-facing bpm bands, derived — never an age formula. Null when unavailable. */
  zones: Record<HrZoneKey, string> | null;
  efficiency: "improving" | "holding" | "easing" | null;
}

/**
 * The model as a prompt sees it: the bands in words, the basis it rests on, and
 * how much it can be trusted. Small on purpose — this ships in every day-read.
 */
export function hrModelForCoach(dateISO?: string): HrModelSummary {
  const asOf = String(dateISO || localDateISO()).slice(0, 10);
  const model = getHrModel(asOf);
  const available = !!model.zones && model.confidence !== "insufficient";
  return {
    available,
    observed_max: model.observed_max,
    resting: model.resting,
    lthr: model.lthr,
    lthr_basis: model.lthr_basis,
    confidence: model.confidence,
    basis_runs: model.basis_runs,
    zones: available
      ? {
          z1: hrZoneLabel("z1", model),
          z2: hrZoneLabel("z2", model),
          z3: hrZoneLabel("z3", model),
          z4: hrZoneLabel("z4", model),
          z5: hrZoneLabel("z5", model),
        }
      : null,
    efficiency: available ? efficiencyTrend(120, asOf).direction : null,
  };
}
