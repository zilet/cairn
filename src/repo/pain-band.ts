// PAIN TRAFFIC LIGHT — what a pain report on ONE movement does to that movement.
//
// The tendon-rehab literature (Silbernagel's monitoring model) is unusually
// unanimous on one thing: pain during loading is not a stop sign by itself. What
// matters is HOW MUCH, and — the question that actually decides it — whether it
// SETTLED by the next day. Low pain that settles is trained through; pain that is
// still there, or worse, at the next exposure is what earns a load reduction.
//
// THE NUMBERS DO NOT EXIST HERE, AND THAT IS DELIBERATE.
// The published protocol is a 0-10 scale, and Cairn has never asked for one:
// `src/symptomCapture.ts` — the ONE capture contract — carries no numeric severity
// and this module does not add one, because adding a required 0-10 question to
// capture would turn the athlete's own sentence into a form (and put a numeric score
// on a surface a person reads, which the constitution forbids outright). So the
// three bands are mapped onto the vocabulary capture ALREADY produces:
//
//   green  — no stated pain on this movement, or pain that SETTLED by the next
//            exposure (a later `pain_free` exposure, or a 'better'/'resolved' word).
//   amber  — a stated `pain_present` exposure whose settling question is still
//            OPEN. That is the ≤5/10 middle: the movement holds its load and the
//            next exposure answers it.
//   red    — the athlete said 'worse', or the movement drew pain on two separate
//            days inside a week (unsettled, worsening week-over-week).
//
// ABSENT IS NOT GREEN AND NOT AMBER. With nothing stated on this movement the
// function returns null and the progression ladder is untouched — silence never
// brakes a lift, and it never clears one either.
//
// THE LAWS THIS INHERITS, NOT RE-DERIVES:
//   • `scope='systemic'` never drives a movement decision. A watch that names no
//     place cannot say anything about one lift (CLAUDE.md).
//   • Only STATED evidence speaks about acuity. An `inferred` exposure is the
//     athlete training quietly — real tolerance evidence, but never a statement,
//     so it can neither raise a band nor clear one.
//   • Per-lift, exactly like dose comparability: one hurting movement brakes ITSELF
//     and nothing else. There is no session-level rollup here on purpose.
//
// Read straight off the tables rather than through the lifecycle hydrate, for the
// reason movement-risk.ts states about itself: a consumer this low in the stack must
// not import upward, and the questions asked here are narrow.

import { db } from "../db.js";
import { canonicalGroup } from "./exercise-canon.js";
import { painAreaLoadsExercise } from "./pain-relevance.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";

export type PainBand = "green" | "amber" | "red";

/** The capture contract's own change vocabulary (src/symptomCapture.ts). */
export type PainChangeWord = "new" | "worse" | "same" | "better" | "resolved";

export interface PainExposure {
  on: string;
  outcome: "pain_free" | "pain_present";
  /** 'inferred' = trained quietly. Never a statement about how it felt. */
  evidence: "stated" | "inferred";
}

export interface PainChangeReport {
  on: string;
  change: PainChangeWord;
}

export interface DomsShape {
  /**
   * The day this movement was (re)introduced — trained after a long enough gap that
   * a day-after ache is the expected response to a novel dose rather than a symptom.
   * Null when the movement has been in the rotation all along.
   */
  novel_exposure_on: string | null;
  /**
   * Whether the report reads as muscle-belly / both-sides soreness rather than a
   * one-sided joint or tendon. Structural, not diagnostic: see `domsShapeFor`.
   */
  symmetric: boolean;
}

export interface PainBandInput {
  as_of: string;
  /** Exposures for THIS movement, already windowed and relevance-filtered. */
  exposures: PainExposure[];
  /** The athlete's own change words on watches that cover this movement. */
  changes: PainChangeReport[];
  doms: DomsShape | null;
}

export interface PainBandRead {
  band: PainBand;
  /**
   * Whether the 24-hour question has been ANSWERED. True = it settled, false = it
   * did not, null = still open (which is what amber means).
   */
  settled: boolean | null;
  /** True when the pattern reads as ordinary post-novel-exposure soreness. */
  doms: boolean;
  latest_pain_on: string | null;
  /** MACHINE register: third-person evidence prose. Callers own athlete voice. */
  reason: string;
}

// How far back a stated pain report on a movement still decides its band. Short on
// purpose: this is an ACUITY question, and the durable "has this movement gone badly
// before" memory is movement-risk.ts's job, over its own 90-day window.
export const PAIN_BAND_WINDOW_DAYS = 21;
// Two painful days inside this span is the "unsettled / worsening week-over-week"
// arm — the protocol's own weekly re-check, in days.
const UNSETTLED_SPAN_DAYS = 7;
// DOMS peaks 24-72h after a novel dose. Outside that window an ache is not the
// textbook shape and gets the safe reading (amber).
const DOMS_MIN_LAG_DAYS = 1;
const DOMS_MAX_LAG_DAYS = 3;
// How recently the movement must have been (re)introduced for a report to be
// attributable to novelty at all.
const DOMS_NOVELTY_WINDOW_DAYS = 10;
// A movement absent this long and then trained is a NOVEL dose again — the same
// "unaccustomed eccentric work" DOMS actually describes.
const DOMS_REINTRODUCTION_GAP_DAYS = 28;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(value: unknown): string {
  return String(value ?? "").slice(0, 10);
}

function movementSlug(name: string): string {
  return `movement:${String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

/**
 * The band this movement is in, from what the athlete has actually said about it.
 *
 * PURE: no clock, no database. Null means ABSENT — nothing stated, so nothing to
 * decide, and every caller must leave the prescription exactly as it found it.
 */
export function painBandDecision(input: PainBandInput): PainBandRead | null {
  const asOf = isoDay(input?.as_of);
  if (!DATE_RE.test(asOf)) return null;
  const exposures = (Array.isArray(input?.exposures) ? input.exposures : [])
    .map((row) => ({ on: isoDay(row?.on), outcome: row?.outcome, evidence: row?.evidence }))
    .filter((row) => DATE_RE.test(row.on) && row.on <= asOf);
  const changes = (Array.isArray(input?.changes) ? input.changes : [])
    .map((row) => ({ on: isoDay(row?.on), change: row?.change }))
    .filter((row) => DATE_RE.test(row.on) && row.on <= asOf);

  // Only a STATEMENT opens a band. Quiet training is evidence of tolerance, never a
  // report of pain, and it is never allowed to speak here in either direction.
  const painDays = [...new Set(exposures.filter((row) => row.outcome === "pain_present" && row.evidence === "stated").map((row) => row.on))].sort();
  if (!painDays.length) return null;
  const latest = painDays[painDays.length - 1];

  const worseOnOrAfter = changes.some((row) => row.change === "worse" && row.on >= latest);
  const settledAfter =
    exposures.some((row) => row.outcome === "pain_free" && row.evidence === "stated" && row.on > latest) ||
    changes.some((row) => (row.change === "better" || row.change === "resolved") && row.on > latest);
  const recentPainDays = painDays.filter((day) => {
    const gap = daysBetweenISO(latest, day);
    return gap != null && gap >= 0 && gap < UNSETTLED_SPAN_DAYS;
  });

  // DOMS runs FIRST, because the whole point of the distinction is that this shape is
  // not a symptom to brake on — but it can only ever excuse a single, settling report.
  // A second painful day, or the athlete saying it got worse, is no longer the
  // day-after ache of a new movement whatever its shape.
  const doms = input?.doms ?? null;
  const domsLag = doms?.novel_exposure_on ? daysBetweenISO(latest, isoDay(doms.novel_exposure_on)) : null;
  const domsShaped =
    !!doms?.symmetric &&
    domsLag != null &&
    domsLag >= DOMS_MIN_LAG_DAYS &&
    domsLag <= DOMS_MAX_LAG_DAYS &&
    !worseOnOrAfter &&
    recentPainDays.length === 1;
  if (domsShaped) {
    return {
      band: "green",
      settled: null,
      doms: true,
      latest_pain_on: latest,
      reason: `The ${latest} report on this movement is symmetric soreness ${domsLag} day(s) after it was introduced on ${isoDay(doms!.novel_exposure_on)}, which is the ordinary post-novel-exposure shape rather than a symptom.`,
    };
  }

  if (worseOnOrAfter) {
    return {
      band: "red",
      settled: false,
      doms: false,
      latest_pain_on: latest,
      reason: `The athlete's own words on or after ${latest} say this got worse, so the movement's load comes down rather than holding.`,
    };
  }
  if (recentPainDays.length >= 2) {
    return {
      band: "red",
      settled: false,
      doms: false,
      latest_pain_on: latest,
      reason: `This movement drew a stated pain report on ${recentPainDays.length} separate days between ${recentPainDays[0]} and ${latest}, so it has not settled between exposures.`,
    };
  }
  if (settledAfter) {
    return {
      band: "green",
      settled: true,
      doms: false,
      latest_pain_on: latest,
      reason: `The ${latest} report on this movement settled by the next exposure, so progression proceeds.`,
    };
  }
  return {
    band: "amber",
    settled: null,
    doms: false,
    latest_pain_on: latest,
    reason: `A stated pain report on ${latest} has not yet been answered by a later exposure, so this movement's load holds until it is.`,
  };
}

// ---- the thin DB-facing reads -------------------------------------------------

/** An exposure plus the watch it was recorded against, which owns its words. */
interface ExposureRow extends PainExposure {
  event_id: number | null;
}

/**
 * Every tolerance exposure recorded for this movement inside the window.
 *
 * Three filters, and all three are load-bearing. `relevant = 1` drops an observation
 * the relevance map already ruled out. The join onto the watch drops `scope='systemic'`
 * — `recordMovementTolerance` writes a `relevant` flag from the AREA LABEL alone and
 * asks nothing about scope, so "everything aches, mostly shoulders" lands as a
 * relevant, systemic-scoped exposure and would otherwise drive a movement band
 * through the one door the law closes everywhere else. And the window bounds it.
 *
 * Both spellings of the movement key are read, exactly as movement-risk.ts does — a
 * row written before the exercise was resolved carries the name slug rather than the
 * id. Absence (an imported or partial DB with no table) reads as no evidence, which
 * leaves the ladder untouched.
 */
function exposuresFor(exerciseId: number | null, name: string, from: string, to: string): ExposureRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT o.observed_on AS observed_on, o.outcome AS outcome, o.evidence AS evidence,
                o.symptom_event_id AS symptom_event_id
           FROM movement_tolerance_observations o
           JOIN training_symptom_events e ON e.id = o.symptom_event_id
          WHERE o.movement_key IN (?, ?)
            AND o.relevant = 1
            AND o.observed_on BETWEEN ? AND ?
            AND COALESCE(e.scope, 'area') <> 'systemic'
          ORDER BY o.observed_on LIMIT 200`
      )
      .all(exerciseId == null ? "exercise:-1" : `exercise:${exerciseId}`, movementSlug(name), from, to) as any[];
    return rows.map((row) => ({
      on: isoDay(row.observed_on),
      outcome: String(row.outcome) === "pain_present" ? "pain_present" : "pain_free",
      evidence: String(row.evidence) === "inferred" ? "inferred" : "stated",
      event_id: Number.isFinite(Number(row.symptom_event_id)) ? Number(row.symptom_event_id) : null,
    }));
  } catch {
    return [];
  }
}

/**
 * The change words the athlete's own reports carried, for AREA watches that cover
 * this movement.
 *
 * The word lives in `symptom_reports.extraction_json` — the capture payload — because
 * the lifecycle stores what a change DID (a recurrence, a resolution) rather than the
 * word itself. `scope='systemic'` watches are excluded at the join: a report that
 * names no place may not speak about one lift.
 */
function changesFor(
  exercise: { name: string; muscle_group: string | null },
  from: string,
  to: string
): PainChangeReport[] {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT r.reported_on AS reported_on, r.extraction_json AS extraction_json, e.area_text AS area_text
           FROM symptom_reports r
           JOIN training_symptom_events e
             ON e.id = r.symptom_event_id
            OR e.id IN (SELECT symptom_event_id FROM symptom_report_events WHERE symptom_report_id = r.id)
          WHERE r.reported_on BETWEEN ? AND ?
            AND r.extraction_status = 'done'
            AND COALESCE(e.scope, 'area') <> 'systemic'
          ORDER BY r.reported_on LIMIT 200`
      )
      .all(from, to) as any[];
  } catch {
    return [];
  }
  const out: PainChangeReport[] = [];
  for (const row of rows) {
    if (!painAreaLoadsExercise(String(row.area_text ?? ""), exercise)) continue;
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(row.extraction_json ?? ""));
    } catch {
      parsed = null;
    }
    for (const report of Array.isArray(parsed?.reports) ? parsed.reports : []) {
      const change = String(report?.change ?? "");
      if (change === "new" || change === "worse" || change === "same" || change === "better" || change === "resolved")
        out.push({ on: isoDay(row.reported_on), change });
    }
  }
  return out;
}

/**
 * Is this movement NEW to the athlete right now, and does THE WATCH THAT REPORTED
 * THE PAIN read as muscle-belly soreness rather than a joint?
 *
 * Both halves are structural rather than diagnostic, and three things about the
 * symmetry half are deliberate, because each of them is a way this excuse could be
 * handed out to a report that never earned it:
 *
 *   • ONE WATCH, THE ONE THAT SPOKE. The shape is read from the event the painful
 *     exposure was recorded against — not OR'd across every open watch that happens
 *     to cover this lift. Otherwise an unrelated "both quads" would mark a "left
 *     knee" report symmetric and train straight through it.
 *   • ITS OWN WORDS. `training_symptom_events` stores a short LABEL; the athlete's
 *     sentence lives in `symptom_reports.text` (this used to select a `report_text`
 *     column off the events table, which does not exist — the query threw on every
 *     call, the catch read `symmetric = false`, and the whole DOMS carve-out was
 *     dead code that froze every newly-introduced movement at amber for three weeks).
 *   • A JOINT IS NEVER DOMS. "Both knees" is bilateral JOINT pain, which is a reason
 *     to be MORE careful, not less — and `canonicalGroup` happily maps "shoulder" or
 *     "wrist" onto a muscle group, so the joint vocabulary is excluded first and
 *     outright rather than left to that map.
 *
 * "Novel" is the movement's first logged day, or its return after a month away.
 * Where the data cannot say, the caller errs AMBER — the safe direction — because
 * this read can only ever REMOVE a brake.
 *
 * HOW NARROW THIS IS, so nobody reads it as broken later. A band only opens for an
 * area the relevance map can attach to a lift at all, and that map is built from
 * JOINT vocabulary plus a few muscle names ("calf", "glutes", "chest", "forearm").
 * The commonest DOMS report of all — "quads are wrecked" — matches nothing there, so
 * no exposure is ever marked relevant, no band opens, and progression proceeds
 * untouched. That is the same outcome this carve-out produces, reached by absence
 * rather than by excuse, which is why widening the relevance map to catch it would be
 * a change with real risk and no benefit here.
 */
// Joint / tendon vocabulary. A label carrying any of it can never read as the
// symmetric muscle soreness a novel dose produces, whatever else the words say.
const JOINT_FLAVOR_RE =
  /\b(knee|knees|elbow|elbows|wrist|wrists|ankle|ankles|shoulder|shoulders|hip|hips|joint|joints|tendon|tendons|achilles|plantar|rotator|cuff|\bac\b|\bsi\b|sacro|spine|lumbar|back|neck|groin|impinge\w*)\b/i;

function domsShapeFor(
  eventId: number | null,
  exerciseId: number | null,
  from: string,
  asOf: string
): DomsShape {
  let symmetric = false;
  if (eventId != null) {
    try {
      const event = db.prepare(`SELECT area_text, scope FROM training_symptom_events WHERE id = ?`).get(eventId) as any;
      const label = String(event?.area_text ?? "");
      if (event && String(event.scope ?? "area") !== "systemic" && !JOINT_FLAVOR_RE.test(label)) {
        // The athlete's own sentence for THIS watch, newest first. Both attributions
        // are read — the primary column and the many-to-many — exactly as the rest of
        // the symptom layer does, because a sentence naming two places lands in one
        // column and two link rows.
        const said = db
          .prepare(
            `SELECT r.text AS text FROM symptom_reports r
              WHERE (r.symptom_event_id = ?
                     OR r.id IN (SELECT symptom_report_id FROM symptom_report_events WHERE symptom_event_id = ?))
                AND r.reported_on BETWEEN ? AND ?
              ORDER BY r.reported_on DESC, r.id DESC LIMIT 5`
          )
          .all(eventId, eventId, from, asOf) as any[];
        const words = `${label} ${said.map((row) => String(row.text ?? "")).join(" ")}`.toLowerCase();
        symmetric = !JOINT_FLAVOR_RE.test(words) && (/\bboth\b/.test(words) || canonicalGroup(label) != null);
      }
    } catch {
      symmetric = false;
    }
  }

  let novelOn: string | null = null;
  if (exerciseId != null) {
    try {
      const days = (
        db
          .prepare(
            `SELECT DISTINCT s.date AS date FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
              WHERE ls.exercise_id = ? AND s.date <= ? ORDER BY s.date`
          )
          .all(exerciseId, asOf) as any[]
      ).map((row) => isoDay(row.date));
      const windowStart = addDaysISO(asOf, -DOMS_NOVELTY_WINDOW_DAYS) ?? asOf;
      for (let i = days.length - 1; i >= 0; i--) {
        if (days[i] < windowStart) break;
        const gap = i === 0 ? null : daysBetweenISO(days[i], days[i - 1]);
        if (i === 0 || (gap != null && gap >= DOMS_REINTRODUCTION_GAP_DAYS)) {
          novelOn = days[i];
          break;
        }
      }
    } catch {
      novelOn = null;
    }
  }
  return { novel_exposure_on: novelOn, symmetric };
}

/**
 * The traffic-light band for ONE movement on ONE day, or null when the athlete has
 * said nothing about it inside the window.
 *
 * Read-only, and cheap enough to run per lift: two indexed table reads plus the
 * novelty query, all bounded.
 */
export function painBandForMovement(
  exercise: { id?: number | null; name: string; muscle_group?: string | null },
  dateISO?: string
): PainBandRead | null {
  const name = String(exercise?.name ?? "").trim();
  if (!name) return null;
  const asOf = isoDay(dateISO || localDateISO());
  if (!DATE_RE.test(asOf)) return null;
  const id = Number.isFinite(Number(exercise?.id)) && Number(exercise?.id) > 0 ? Math.trunc(Number(exercise!.id)) : null;
  const from = addDaysISO(asOf, -PAIN_BAND_WINDOW_DAYS) ?? asOf;
  const identity = { name, muscle_group: exercise?.muscle_group ?? null };
  const exposures = exposuresFor(id, name, from, asOf);
  // Nothing stated about this movement at all: return before paying for the two
  // heavier reads. Absence is the common answer and must be the cheap one.
  const stated = exposures.filter((row) => row.outcome === "pain_present" && row.evidence === "stated");
  if (!stated.length) return null;
  // The DOMS shape belongs to the watch that reported the LATEST pain, since that is
  // the report the band is about.
  const latest = stated.reduce((best, row) => (row.on >= best.on ? row : best), stated[0]);
  return painBandDecision({
    as_of: asOf,
    exposures,
    changes: changesFor(identity, from, asOf),
    doms: domsShapeFor(latest.event_id, id, from, asOf),
  });
}
