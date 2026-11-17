// What a blood-pressure reading MEANS, read with everything else known about the person.
//
// One reading is a snapshot. Clinical practice classifies blood pressure on the average
// of repeated readings taken on separate occasions (ACC/AHA 2017; ESC 2024), and settles
// a level out of the office: seated, after five minutes of rest, two readings a minute
// apart, morning and evening, for three to seven days. So a reading here is never spoken
// as a standing condition:
//
//   basis "one_reading"  one occasion on this side in the window: a snapshot
//   basis "repeated"     the same side on two or more separate days: a level is
//                        suggested, not settled
//   settled              readings on SETTLED_MIN_DAYS separate days inside
//                        SETTLED_WINDOW_DAYS: a home series, and the level is its average
//
// A LOW reading is only worth a conversation with a symptom beside it (dizziness,
// lightheadedness, fainting), with a blood finding that can travel with it, or on a
// blood-pressure medication. Weight loss (about 1 mmHg a kilogram, Neter 2003) and
// regular aerobic training both lower resting pressure, so a lower reading during a cut
// or a training block is said as the expected direction, never as a problem.
//
// Informational, never medical advice. Pure over its inputs apart from
// `bloodPressureContext`, which reads the log.
import { db } from "../db.js";
import { canonicalBodyweightSeries } from "./bodyweight.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";

export interface BloodPressurePoint {
  date: string;
  value: number;
}

export type BloodPressureSide = "low" | "high" | "in_band";
export type BloodPressureBasis = "one_reading" | "repeated";

export interface BloodPressureContext {
  /** Bodyweight change (lb, negative = lost) since the anchor date; null when unknown. */
  weight_change_lb: number | null;
  /** Aerobic sessions of 20 minutes or more in the last 28 days. */
  aerobic_sessions_28d: number;
  /** An active cut phase. */
  in_cut: boolean;
  /** The person's own words naming dizziness, lightheadedness or fainting, newest first. */
  symptoms: Array<{ date: string; text: string }>;
  /** Blood findings that can travel with low pressure ("Hemoglobin", "Sodium", ...). */
  blood: string[];
  /** A blood-pressure medication on the active list, by class label; null when none. */
  medication: string | null;
}

export interface BloodPressureRead {
  component: "systolic" | "diastolic";
  side: BloodPressureSide;
  basis: BloodPressureBasis;
  /** Separate days on this side inside the window. */
  occasions: number;
  /** A home series exists (readings on enough separate days close together). */
  settled: boolean;
  /** The latest reading as "101/55" when its pair is known, else the one component. */
  reading_text: string;
  latest_date: string;
  /** A short clause for a marker row: "one reading so far". */
  note: string;
  /** The full athlete-facing line (a directive's text). */
  line: string;
  rationale: string;
  /** True when the picture (symptom, blood finding, medication) makes it worth raising. */
  raise_with_doctor: boolean;
  context: BloodPressureContext;
}

/** Separate-day readings looked at for "is this a pattern". */
export const BP_WINDOW_DAYS = 90;
/** Readings on this many separate days ... */
export const SETTLED_MIN_DAYS = 3;
/** ... inside this many days read as a home series. */
export const SETTLED_WINDOW_DAYS = 14;
/** Weight change that is worth naming as a cause. */
const WEIGHT_CHANGE_NAMED_LB = 5;
/** Aerobic sessions in four weeks that read as "regular". */
const AEROBIC_REGULAR_SESSIONS = 8;
const SYMPTOM_LOOKBACK_DAYS = 60;

const SYMPTOM_WORDS = /\b(dizz\w*|light[\s-]?headed\w*|faint\w*|black(?:ed|ing)?\s?out|woozy|vertigo|head\s?rush|passed out)\b/i;
const NEGATED = /\b(no|not|never|without|none|isn't|wasn't|didn't|free of)\b[^.;,]{0,24}$/i;

/** True when the words claim the symptom (a "no dizziness" note is not a symptom). */
export function namesLowPressureSymptom(text: unknown): boolean {
  const s = String(text ?? "");
  const m = SYMPTOM_WORDS.exec(s);
  if (!m) return false;
  return !NEGATED.test(s.slice(0, m.index));
}

const HOME_PROTOCOL =
  "To settle it, take seated readings after five minutes of rest, two a minute apart, morning and evening, for three to seven days.";

function sideOf(value: number, band: [number, number]): BloodPressureSide {
  if (value < band[0]) return "low";
  if (value > band[1]) return "high";
  return "in_band";
}

function clip(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function spanWords(days: number): string {
  if (days < 10) return "days apart";
  if (days < 21) return "about two weeks apart";
  if (days < 45) return "about a month apart";
  if (days < 75) return "about two months apart";
  return "a few months apart";
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The log-side context for a reading on `side`: weight since `anchor` (the last reading
 * that was not on this side, else the window's start), aerobic work, a cut, and the
 * person's own symptom words. `blood` and `medication` come from the caller, which
 * already holds the marker picture and the medication list.
 */
export function bloodPressureContext(
  today: string,
  anchor: string,
  extra: { blood?: string[]; medication?: string | null } = {}
): BloodPressureContext {
  let weight_change_lb: number | null = null;
  try {
    const series = canonicalBodyweightSeries({ since: addDaysISO(anchor, -14) ?? anchor, through: today });
    const before = series.filter((p) => p.date <= (addDaysISO(anchor, 14) ?? anchor));
    const then = before.length ? before[before.length - 1] : series[0];
    const now = series[series.length - 1];
    if (then && now && then.date !== now.date) {
      weight_change_lb = Math.round((Number(now.weight_lb) - Number(then.weight_lb)) * 10) / 10;
    }
  } catch {
    weight_change_lb = null;
  }

  let aerobic = 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM activities
          WHERE date >= ? AND date <= ? AND COALESCE(duration_min, 0) >= 20
            AND LOWER(COALESCE(type, '')) NOT LIKE '%strength%'
            AND LOWER(COALESCE(type, '')) NOT LIKE '%yoga%'
            AND LOWER(COALESCE(type, '')) NOT LIKE '%walk%'`
      )
      .get(addDaysISO(today, -27) ?? today, today) as any;
    aerobic = Number(row?.n) || 0;
  } catch {
    aerobic = 0;
  }

  let in_cut = false;
  try {
    const row = db.prepare(`SELECT kind FROM journey_phases WHERE status = 'active' ORDER BY id DESC LIMIT 1`).get() as any;
    in_cut = String(row?.kind ?? "").toLowerCase() === "cut";
  } catch {
    in_cut = false;
  }

  const symptoms: Array<{ date: string; text: string }> = [];
  const since = addDaysISO(today, -SYMPTOM_LOOKBACK_DAYS) ?? today;
  try {
    const reports = db
      .prepare(`SELECT reported_on AS date, text FROM symptom_reports WHERE reported_on >= ? ORDER BY reported_on DESC, id DESC LIMIT 200`)
      .all(since) as any[];
    const notes = db
      .prepare(`SELECT date, note AS text FROM checkins WHERE date >= ? AND note IS NOT NULL AND note != '' ORDER BY date DESC, id DESC LIMIT 200`)
      .all(since) as any[];
    for (const r of [...reports, ...notes]) {
      if (namesLowPressureSymptom(r?.text)) symptoms.push({ date: String(r.date).slice(0, 10), text: clip(String(r.text)) });
    }
    symptoms.sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    // the words are optional context
  }

  return {
    weight_change_lb,
    aerobic_sessions_28d: aerobic,
    in_cut,
    symptoms: symptoms.slice(0, 3),
    blood: (extra.blood ?? []).slice(0, 3),
    medication: extra.medication ?? null,
  };
}

/**
 * Read one component's series (oldest first, one point a day) against its optimal band.
 * Null when there is no reading or the latest sits inside the band.
 */
export function bloodPressureRead(input: {
  component: "systolic" | "diastolic";
  points: BloodPressurePoint[];
  band: [number, number];
  /** The other component's series, to print the pair. */
  pair?: BloodPressurePoint[];
  today?: string;
  context?: (anchor: string) => BloodPressureContext;
}): BloodPressureRead | null {
  const today = input.today ?? localDateISO();
  const points = (input.points || [])
    .filter((p) => p && Number.isFinite(Number(p.value)) && /^\d{4}-\d{2}-\d{2}/.test(String(p.date)))
    .map((p) => ({ date: String(p.date).slice(0, 10), value: Number(p.value) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = points[points.length - 1];
  if (!latest) return null;
  const side = sideOf(latest.value, input.band);
  if (side === "in_band") return null;

  const windowStart = addDaysISO(latest.date, -BP_WINDOW_DAYS) ?? latest.date;
  const recent = points.filter((p) => p.date >= windowStart);
  const sameSide = recent.filter((p) => sideOf(p.value, input.band) === side);
  const occasions = sameSide.length;
  const basis: BloodPressureBasis = occasions >= 2 ? "repeated" : "one_reading";
  const seriesStart = addDaysISO(latest.date, -(SETTLED_WINDOW_DAYS - 1)) ?? latest.date;
  const settled = points.filter((p) => p.date >= seriesStart).length >= SETTLED_MIN_DAYS;

  const pairOn = (date: string): number | null => {
    const hit = (input.pair || []).find((p) => String(p.date).slice(0, 10) === date);
    return hit && Number.isFinite(Number(hit.value)) ? Number(hit.value) : null;
  };
  const text = (p: BloodPressurePoint): string => {
    const other = pairOn(p.date);
    if (other == null) return `${Math.round(p.value)} ${input.component}`;
    return input.component === "systolic" ? `${Math.round(p.value)}/${Math.round(other)}` : `${Math.round(other)}/${Math.round(p.value)}`;
  };

  const lastOther = [...points].reverse().find((p) => sideOf(p.value, input.band) !== side);
  const anchor = lastOther && (daysBetweenISO(lastOther.date, latest.date) ?? 999) <= 365 ? lastOther.date : windowStart;
  const context =
    input.context?.(anchor) ??
    ({ weight_change_lb: null, aerobic_sessions_28d: 0, in_cut: false, symptoms: [], blood: [], medication: null } satisfies BloodPressureContext);

  const sideWords = side === "low" ? "on the low side" : "on the high side";
  let note: string;
  let what: string;
  if (settled) {
    note = "from several readings";
    what = `Your recent readings sit ${sideWords} (latest ${text(latest)}).`;
  } else if (basis === "repeated") {
    const first = sameSide[0];
    const apart = spanWords(daysBetweenISO(first.date, latest.date) ?? 0);
    note = occasions === 2 ? "two single readings so far" : `${occasions} single readings so far`;
    const shown = sameSide.slice(-2).map(text);
    what = `Your last ${occasions === 2 ? "two" : occasions} readings (${joinWords(shown)}${occasions > 2 ? ", most recently" : ""}) sat ${sideWords}, ${apart}. Single readings suggest a level; they do not settle it.`;
  } else {
    note = "one reading so far";
    what = `Your latest reading (${text(latest)}) sat ${sideWords}. One reading is a snapshot, not your level.`;
  }

  if (side === "high") {
    const line = settled
      ? `${what} Discuss a sustained high level with your doctor.`
      : `${what} ${HOME_PROTOCOL} Discuss a level that stays high with your doctor.`;
    return {
      component: input.component,
      side,
      basis,
      occasions,
      settled,
      reading_text: text(latest),
      latest_date: latest.date,
      note,
      line,
      rationale:
        "Blood pressure is classified on repeated readings from separate occasions, and a single clinic value often reads high; a home series is the standard way to confirm it.",
      raise_with_doctor: settled,
      context,
    };
  }

  // ---- low side ----
  const causes: string[] = [];
  const lost = context.weight_change_lb != null && context.weight_change_lb <= -WEIGHT_CHANGE_NAMED_LB;
  if (lost || context.in_cut) causes.push("losing weight");
  if (context.aerobic_sessions_28d >= AEROBIC_REGULAR_SESSIONS) causes.push("regular aerobic training");
  const fits = causes.length
    ? ` ${causes.length === 2 ? "Losing weight and regular aerobic training both lower" : causes[0] === "losing weight" ? "Losing weight lowers" : "Regular aerobic training lowers"} resting blood pressure, so a lower reading than before fits what you have been doing.`
    : "";

  const reasons: string[] = [];
  if (context.symptoms.length) reasons.push(`you noted "${context.symptoms[0].text}"`);
  if (context.blood.length) reasons.push(`your ${joinWords(context.blood)} ${context.blood.length === 1 ? "also reads" : "also read"} off`);
  if (context.medication) reasons.push(`you are on ${context.medication}`);
  const raise = reasons.length > 0;
  const care = raise
    ? ` Because ${joinWords(reasons)}, this is worth raising with your doctor rather than waiting.`
    : " Without dizziness, lightheadedness or fainting, a low reading is usually nothing to treat, and it is no reason to cut salt or add cardio.";
  const next = settled ? "" : ` ${HOME_PROTOCOL}`;

  return {
    component: input.component,
    side,
    basis,
    occasions,
    settled,
    reading_text: text(latest),
    latest_date: latest.date,
    note,
    line: `${what}${fits}${care}${next}`.replace(/\s+/g, " ").trim(),
    rationale:
      "Blood pressure is classified on repeated readings from separate occasions, never one. Low readings are common in aerobically fit people and during weight loss and are usually benign; a symptom, a related blood finding or a blood-pressure medication is what makes one worth a conversation.",
    raise_with_doctor: raise,
    context,
  };
}
