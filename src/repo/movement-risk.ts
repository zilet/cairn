// MOVEMENT RISK — the durable per-exercise tolerance memory.
//
// FROZEN CONTRACT (hybrid-elite round): the learning-loop track implements this
// from movement_tolerance_observations + symptom history; the strength-core
// track consumes it in vary-ranking so a repeatedly-flagged movement is
// deprioritized as a future swap-in rather than merely braked for one session.
//
// Everything is read straight off the tables rather than through
// listTrainingSymptoms, for the reason reaction-model.ts states about itself: a
// consumer this low in the stack must not import upward, and the questions asked
// here are narrow enough that the lifecycle hydrate would be pure overhead.
import { db } from "../db.js";
import { painAreaLoadsExercise } from "./pain-relevance.js";
import { addDaysISO, localDateISO } from "./shared.js";

export type MovementRiskSignal = {
  risk: "clear" | "watch" | "flagged";
  /** Machine register (third-person evidence prose); callers own athlete voice. */
  reason: string | null;
};

// How far back a pain report on a movement still speaks about it. A training
// block runs about four weeks, so three blocks is long enough that a movement
// that hurt twice in a season is not laundered clean by one quiet month, and
// short enough that last winter's tweak stops steering this winter's programming.
const RISK_WINDOW_DAYS = 90;
// …and how recently a SINGLE report has to have landed to still be a live watch.
// One complaint nothing has repeated in two months is history, not a signal.
const RISK_RECENT_DAYS = 28;
// Two SEPARATE DAYS is the bar for "repeated". Two rows on one day is one
// complaint written twice — by the athlete and by the extraction, say — and
// counting rows instead of days would flag a movement off a single sentence.
const FLAGGED_MIN_PAIN_DAYS = 2;

const CLEAR: MovementRiskSignal = { risk: "clear", reason: null };

function isoDay(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

function movementSlug(name: string): string {
  return `movement:${name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

/**
 * The days this movement was reported PAINFUL, newest first.
 *
 * Distinct days, and across every evidence epoch: a recurrence opens a new epoch
 * and writes its own row, so counting rows would double-count one flare. Both
 * spellings of the movement key are read — a row written before the exercise was
 * resolved carries the name slug rather than the id.
 */
function painDays(exerciseId: number, name: string, from: string, to: string): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT observed_on FROM movement_tolerance_observations
          WHERE movement_key IN (?, ?)
            AND outcome = 'pain_present'
            AND observed_on BETWEEN ? AND ?
          ORDER BY observed_on DESC LIMIT 50`
      )
      .all(`exercise:${exerciseId}`, movementSlug(name), from, to) as Array<{ observed_on: string }>;
    return rows.map((row) => isoDay(row.observed_on));
  } catch {
    // An imported or partial DB without the tolerance table is ABSENCE, and
    // absence is neutral (VISION). Note the asymmetry with
    // reaction-model's trainingSymptomOnRecord, which fails closed on the same
    // tables: that read withholds a bigger step, so silence there costs the
    // athlete nothing. This one takes a movement AWAY from the swap pool, so
    // silence must never be read as a reason to.
    return [];
  }
}

/**
 * An unresolved symptom that covers this movement, if one is still speaking.
 *
 * `scope='systemic'` is excluded on purpose — a watch that names no place can
 * never establish per-movement relevance (that law is in CLAUDE.md, and it is
 * what stopped one open "everything feels off" from loading every lift). And an
 * open row nobody has said anything about for a whole window is not a live
 * watch: a symptom is never auto-resolved because closing one is the athlete's
 * call, so without this bound a single forgotten row would hold a movement on
 * watch permanently.
 */
function openRelevantSymptom(
  exercise: { name: string; muscle_group: string | null },
  from: string,
  asOf: string
): { area_text: string; last_reported_on: string } | null {
  let rows: Array<{ area_text: string; last_reported_on: string }> = [];
  try {
    rows = db
      .prepare(
        `SELECT area_text, last_reported_on FROM training_symptom_events
          WHERE status = 'active'
            AND COALESCE(scope, 'area') <> 'systemic'
            AND onset_on <= ?
            AND (resolved_on IS NULL OR resolved_on > ?)
            AND last_reported_on >= ?
          ORDER BY last_reported_on DESC, id DESC LIMIT 50`
      )
      .all(asOf, asOf, from) as Array<{ area_text: string; last_reported_on: string }>;
  } catch {
    return null; // same absence-is-neutral reading as above
  }
  for (const row of rows) {
    if (painAreaLoadsExercise(String(row.area_text), { name: exercise.name, muscle_group: exercise.muscle_group })) {
      return { area_text: String(row.area_text), last_reported_on: isoDay(row.last_reported_on) };
    }
  }
  return null;
}

/**
 * How much this movement has hurt lately.
 *
 * Conservative by construction: sparse data, an unknown exercise and an
 * unreadable table all read "clear", because the consumer uses `flagged` to
 * deprioritize a movement and nothing may be taken away from the athlete on the
 * strength of silence.
 */
export function movementRiskFor(exerciseId: number, dateISO?: string): MovementRiskSignal {
  const id = Math.trunc(Number(exerciseId));
  if (!Number.isFinite(id) || id <= 0) return CLEAR;
  const asOf = isoDay(dateISO || localDateISO());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return CLEAR;
  const windowStart = addDaysISO(asOf, -RISK_WINDOW_DAYS) ?? asOf;
  const recentStart = addDaysISO(asOf, -RISK_RECENT_DAYS) ?? asOf;

  let exercise: { name: string; muscle_group: string | null } | null = null;
  try {
    const row = db.prepare(`SELECT name, muscle_group FROM exercises WHERE id = ?`).get(id) as
      | { name: string; muscle_group: string | null }
      | undefined;
    exercise = row ? { name: String(row.name), muscle_group: row.muscle_group == null ? null : String(row.muscle_group) } : null;
  } catch {
    return CLEAR;
  }
  if (!exercise) return CLEAR;

  const days = painDays(id, exercise.name, windowStart, asOf);
  if (days.length >= FLAGGED_MIN_PAIN_DAYS) {
    return {
      risk: "flagged",
      reason: `${exercise.name} has drawn a pain report on ${days.length} separate days since ${windowStart}, most recently on ${days[0]}.`,
    };
  }
  if (days.length && days[0] >= recentStart) {
    return {
      risk: "watch",
      reason: `${exercise.name} drew a pain report on ${days[0]}, and nothing has repeated on it since.`,
    };
  }

  const open = openRelevantSymptom(exercise, windowStart, asOf);
  if (open) {
    return {
      risk: "watch",
      reason: `An unresolved ${open.area_text} symptom, last spoken about on ${open.last_reported_on}, covers what ${exercise.name} loads.`,
    };
  }
  return CLEAR;
}
