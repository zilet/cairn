// MEASUREMENT REQUESTS — the system asks you for DATA, not for permission.
//
// Cairn's standing law is pull-never-push: insights and reads wait in-app and
// never chase the athlete. That law was written about OPINIONS — the weekly read,
// a cross-domain connection, a suggestion about today. It was never a good answer
// to a different question: a derivation the athlete is relying on has gone blind
// for want of one cheap measurement, and only they can supply it.
//
// So this is a bounded, owner-approved evolution of that law, and the bound is the
// whole point:
//
//   ALLOWED  — ONE calm in-app request, tied to a NAMED need, that says what is
//              wanted and WHY in a sentence, waits where the athlete already
//              looks, dedupes to one open request per need, and retires itself the
//              moment the data lands or the need lapses.
//   NOT      — a notification, a badge, a nag, a streak, a count of what was
//              missed, a gate on anything, or a second request while one is open.
//
// The cooldown, the escalation and the eventual silence are NOT a private timer:
// they are the shared attention tier machine (src/repo/attention.ts), the same one
// the lab rechecks, the goal check-in and the sensor recheck ride. Each surfacing
// is recorded as a CLEAN check — we asked and the world did not change — which is
// what the machine stretches on, so a need that is never met asks a handful of
// times, further apart each time, and then stops asking at all.
//
// Register, deliberately borrowed from sensor-recheck.ts: an OFFER with a reason
// attached. Never "you haven't weighed in since…", never a gap, never a count.
// Adherence-neutral (VISION): a thin record lowers confidence, it never blames.
//
// The decision core is PURE — callers hand over the dates and flags they already
// have, and nothing in it reads the database or the clock.

import { db } from "../db.js";
import {
  type CadencePolicy,
  applyAttentionObservation,
  deleteAttentionSchedule,
  getAttentionSchedule,
  listDueAttention,
} from "./attention.js";
import { cutReaffirmation } from "./cut-target.js";
import { canonicalBodyweightSeries } from "./bodyweight.js";
import { addDaysISO, localDateISO } from "./shared.js";
import type { TodayAgendaCandidate } from "./today-agenda.js";

// ---- thresholds --------------------------------------------------------------

// How old the newest weigh-in may be, DURING AN ACTIVE CUT, before the target
// derivation stops tracking the athlete's actual trend. Five days: the grounded
// derivation reads a weekly rate, so a reading older than most of a week means the
// most recent week of the trend is being inferred rather than measured. Outside a
// cut this need does not exist at all — nothing is steering by the trend.
export const WEIGH_IN_STALE_DAYS = 5;
// How old a body measurement may be while a body-composition expectation is open.
// Thirty days: the expectation that a cut should not put the waist up matures over
// eight weeks and needs two readings inside it, so at a month of silence the
// prediction is on course to close inconclusive for want of a tape measure.
export const BODY_MEASUREMENT_STALE_DAYS = 30;
// How far past its own recheck window a lab signal must sit before this asks. Two
// weeks of grace: the health surfaces already carry the schedule, and a request
// the day something falls due would duplicate them rather than add anything.
export const LAB_RECHECK_GRACE_DAYS = 14;

// ---- the pure decision core --------------------------------------------------

// The needs, in the order they are asked. Only ONE request is ever live, so this
// order IS the priority: the weigh-in blocks a derivation running right now, the
// tape blocks a prediction already written down, the lab recheck is the slowest
// clock of the three and can always wait for the other two.
export type MeasurementNeedKey = "weigh_in" | "body_measurement" | "lab_recheck";
const NEED_ORDER: readonly MeasurementNeedKey[] = ["weigh_in", "body_measurement", "lab_recheck"];

export interface MeasurementRequestState {
  today: string;
  // Is a cut the athlete has affirmed actually running? The weigh-in need exists
  // only inside one — outside it nothing is steering by the weekly trend.
  active_cut: boolean;
  last_weigh_in_date: string | null;
  // Is there an open body-composition expectation the tape would settle? Without
  // one, a month-old measurement is simply a measurement, not a blocked read.
  body_comp_expectation_open: boolean;
  last_body_measurement_date: string | null;
  // The oldest lab / health signal sitting past its own recheck date, if any.
  overdue_lab_due_date: string | null;
  overdue_lab_label: string | null;
}

export interface MeasurementRequest {
  need: MeasurementNeedKey;
  // The datum's age in days, or null when there has never been one.
  age_days: number | null;
  last_seen_date: string | null;
  subject: string | null;
  // MACHINE register — third-person evidence prose for the schedule row and the
  // provenance trail. `measurementRequestLine` owns what a person reads.
  reason: string;
}

const DAY_MS = 864e5;

function dayEpoch(iso: unknown): number | null {
  const text = String(iso ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const t = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(t) ? t : null;
}

// Days between a datum and today, or null when the date is unusable. A FUTURE
// date is a clock problem rather than staleness and reads as age 0, exactly as
// the sensor freshness reads treat one.
function ageDays(iso: unknown, today: number): number | null {
  const at = dayEpoch(iso);
  if (at == null) return null;
  return Math.max(0, Math.round((today - at) / DAY_MS));
}

/**
 * EVERY need that is live today, keyed by need.
 *
 * A need is live when BOTH halves hold: a live reason to want the datum (a running
 * cut, an open prediction, a lab past its own window) AND the datum being stale or
 * missing. Neither half alone is a need — an old weigh-in outside a cut blocks
 * nothing, and a running cut with a reading from yesterday needs nothing.
 *
 * Liveness is per-need and says nothing about priority. Only one need is ever
 * ASKED (`measurementRequestDecision` picks it), but the attention sweep must ask
 * this question of all three: a need that is live and merely outranked still owns
 * the ladder it has already climbed.
 *
 * PURE: no clock, no database, no writes.
 */
export function liveMeasurementNeeds(state: MeasurementRequestState): Map<MeasurementNeedKey, MeasurementRequest> {
  const candidates = new Map<MeasurementNeedKey, MeasurementRequest>();
  const today = dayEpoch(state?.today);
  if (today == null) return candidates;

  if (state.active_cut) {
    const age = ageDays(state.last_weigh_in_date, today);
    if (age == null || age > WEIGH_IN_STALE_DAYS) {
      candidates.set("weigh_in", {
        need: "weigh_in",
        age_days: age,
        last_seen_date: age == null ? null : String(state.last_weigh_in_date).slice(0, 10),
        subject: null,
        reason:
          age == null
            ? "An active cut is steering by the weekly weight trend and no weigh-in is on record, so the target cannot track the athlete's own trend yet."
            : `An active cut is steering by the weekly weight trend and the newest weigh-in is ${age} days old, so the most recent week of that trend is inferred rather than measured.`,
      });
    }
  }

  if (state.body_comp_expectation_open) {
    const age = ageDays(state.last_body_measurement_date, today);
    if (age == null || age > BODY_MEASUREMENT_STALE_DAYS) {
      candidates.set("body_measurement", {
        need: "body_measurement",
        age_days: age,
        last_seen_date: age == null ? null : String(state.last_body_measurement_date).slice(0, 10),
        subject: "waist",
        reason:
          age == null
            ? "A body-composition prediction is open with no tape reading on record, so it has nothing to be judged against."
            : `A body-composition prediction is open and the newest tape reading is ${age} days old, so the prediction is on course to close without evidence either way.`,
      });
    }
  }

  const labAge = ageDays(state.overdue_lab_due_date, today);
  if (labAge != null && labAge > LAB_RECHECK_GRACE_DAYS) {
    candidates.set("lab_recheck", {
      need: "lab_recheck",
      age_days: labAge,
      last_seen_date: String(state.overdue_lab_due_date).slice(0, 10),
      subject: state.overdue_lab_label ? String(state.overdue_lab_label).slice(0, 80) : null,
      reason: `A lab signal passed its own recheck window ${labAge} days ago, so what is known about it describes an older draw than the one currently being reasoned from.`,
    });
  }

  return candidates;
}

/**
 * Which ONE measurement, if any, is worth asking for today? The live needs above,
 * resolved through NEED_ORDER — which IS the priority.
 *
 * Null is the common, calm answer. PURE.
 */
export function measurementRequestDecision(state: MeasurementRequestState): MeasurementRequest | null {
  return firstByPriority(liveMeasurementNeeds(state));
}

function firstByPriority(live: Map<MeasurementNeedKey, MeasurementRequest>): MeasurementRequest | null {
  for (const need of NEED_ORDER) {
    const found = live.get(need);
    if (found) return found;
  }
  return null;
}

// ---- the words a person reads ------------------------------------------------
//
// FOUR phrasings per set, and the count is load-bearing rather than decorative:
// `pickRequestVariant` indexes on the absolute day number, so two showings
// separated by a whole multiple of the set size land on the SAME sentence. Every
// gap in the cooldown ladder below (9 / 17 / 31 days) is therefore coprime with
// four, so two consecutive asks can never read identically.
//
// Every title names the DATUM; every body names the WHY in one clause and then
// gets out of the way. No gap, no count, no streak, nothing withheld in the
// meantime. Vocabulary constraint: the reading grammar
// (`violatesReadingGrammar`, src/repo/day-read.ts) treats "baseline", "policy",
// "directive" and friends as engineering prose, and any bare percentage as a
// score, so none of these say a number that isn't a plain quantity.

const TITLES: Record<MeasurementNeedKey, readonly string[]> = {
  weigh_in: [
    "A weigh-in this week would let your target follow your actual trend.",
    "One step on the scale keeps your calorie target tracking what's really happening.",
    "A weigh-in whenever it suits would put your target back on your own trend.",
    "One reading on the scale is all your target needs to keep up with you.",
  ],
  body_measurement: [
    "A tape measure round the waist would show what the cut is taking off.",
    "One waist measurement would tell the scale's story apart from muscle and fat.",
    "A quick tape reading would let this cut be judged on composition, not just weight.",
    "One waist number would give the composition read something current to stand on.",
  ],
  lab_recheck: [
    "A repeat draw would bring this marker up to date.",
    "Fresh bloodwork would let this marker speak for now rather than then.",
    "A recheck on this one would replace an older draw with a current picture.",
    "New labs would put this marker back on current ground.",
  ],
};

const BODIES: Record<MeasurementNeedKey, readonly string[]> = {
  weigh_in: [
    "Whenever it suits — one reading is enough, and nothing here waits on it.",
    "No hurry at all. Everything keeps working; the target just tracks you more closely with it.",
    "Any morning that's convenient. One is plenty, and none is fine too.",
    "One step on the scale, whenever. Skipping it costs nothing.",
  ],
  body_measurement: [
    "One reading, whenever it's convenient. Nothing here waits on it.",
    "A minute with a tape measure, any time. Entirely optional.",
    "Whenever it suits — a single number, and the composition read has something to check against.",
    "One measurement, no particular day. Everything works the same either way.",
  ],
  lab_recheck: [
    "Whenever your next draw happens to fit. Nothing here is waiting on it.",
    "No urgency — this is about keeping the picture current, not about a result.",
    "Next time bloodwork is convenient. Everything keeps working until then.",
    "Whenever it suits your schedule. Entirely optional, and nothing changes without it.",
  ],
};

// Fixed card KICKERS, not rotating ones: the SENTENCES rotate, the label the eye
// uses to recognize the card does not.
const KICKERS: Record<MeasurementNeedKey, string> = {
  weigh_in: "ONE THING WOULD HELP",
  body_measurement: "ONE THING WOULD HELP",
  lab_recheck: "ONE THING WOULD HELP",
};

export interface MeasurementRequestLine {
  kicker: string;
  title: string;
  body: string;
}

// Local copy of the day-variant rotation rather than an import from
// brain/day-read-rules.js, so this module does not pull the day-read rule engine
// in behind it. Same indexing, so the same day always reads the same.
function pickRequestVariant<T>(variants: readonly T[], date: string, key = ""): T {
  if (variants.length <= 1) return variants[0];
  const ms = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  const dayIndex = Number.isFinite(ms) ? Math.floor(ms / DAY_MS) : 0;
  let offset = 0;
  for (let i = 0; i < key.length; i++) offset = (offset * 31 + key.charCodeAt(i)) % 9973;
  const span = variants.length;
  return variants[(((dayIndex + offset) % span) + span) % span];
}

export function measurementRequestLine(request: MeasurementRequest, date: string): MeasurementRequestLine {
  return {
    kicker: KICKERS[request.need],
    title: pickRequestVariant(TITLES[request.need], date, `measurement_title_${request.need}`),
    body: pickRequestVariant(BODIES[request.need], date, `measurement_body_${request.need}`),
  };
}

// One flat pool of every athlete-facing literal this module can produce, so the
// grammar test can enumerate the vocabulary wholesale rather than sampling it.
export function measurementRequestGrammarPool(): string[] {
  return [...new Set(Object.values(KICKERS)), ...NEED_ORDER.flatMap((need) => [...TITLES[need], ...BODIES[need]])];
}

// ---- the thin DB-facing read -------------------------------------------------

/**
 * Assemble the state the decision core needs. Four small bounded reads, each
 * independently fail-soft: a table missing on an older ladder position degrades
 * that ONE need to "no reason to ask", never the whole request.
 */
export function measurementRequestState(asOf: string = localDateISO()): MeasurementRequestState {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf)) ? String(asOf) : localDateISO();

  let activeCut = false;
  try {
    activeCut = cutReaffirmation(today).reaffirmed;
  } catch {
    activeCut = false;
  }

  // The canonical series, not the raw weight log: a Garmin scale reading is a
  // weigh-in, and asking for one the athlete already took would be the rudest
  // possible failure of this whole module.
  // Bounded to a year: the Today agenda calls this on every open, and an unbounded
  // canonical series walks the whole weigh-in history plus every Garmin day. A
  // reading older than a year is not the difference between "stale" and "fresh"
  // anyway — both answers ask for a weigh-in.
  let lastWeighIn: string | null = null;
  try {
    const since = addDaysISO(today, -365) ?? today;
    lastWeighIn = canonicalBodyweightSeries({ since, through: today }).at(-1)?.date ?? null;
  } catch {
    lastWeighIn = null;
  }

  let lastMeasurement: string | null = null;
  try {
    const row = db
      .prepare(
        `SELECT date FROM body_measurements
          WHERE date <= ? AND waist_in IS NOT NULL
          ORDER BY date DESC, id DESC LIMIT 1`
      )
      .get(today) as any;
    lastMeasurement = row?.date ? String(row.date).slice(0, 10) : null;
  } catch {
    lastMeasurement = null;
  }

  // An open body-composition prediction is exactly a pending `brain_expectations`
  // row on the waist evaluator whose window has not closed yet.
  let expectationOpen = false;
  try {
    const row = db
      .prepare(
        `SELECT 1 AS present FROM brain_expectations
          WHERE metric_key = 'body_measurement_direction'
            AND status = 'pending'
            AND window_end >= ?
          LIMIT 1`
      )
      .get(today) as any;
    expectationOpen = !!row?.present;
  } catch {
    expectationOpen = false;
  }

  // The oldest health signal past its own recheck date. The attention schedule
  // already owns those windows, so this reads them rather than inventing a second
  // opinion about when a marker is due.
  let overdueDue: string | null = null;
  let overdueLabel: string | null = null;
  try {
    const due = listDueAttention(today, { domain: "health", limit: 20 }).filter(
      (entry) => entry.source !== MEASUREMENT_REQUEST_SOURCE
    );
    const oldest = due.reduce<(typeof due)[number] | null>(
      (best, entry) => (best == null || String(entry.next_due) < String(best.next_due) ? entry : best),
      null
    );
    if (oldest?.next_due) {
      overdueDue = String(oldest.next_due).slice(0, 10);
      overdueLabel = markerLabelFromSignalKey(oldest.signal_key);
    }
  } catch {
    overdueDue = null;
    overdueLabel = null;
  }

  return {
    today,
    active_cut: activeCut,
    last_weigh_in_date: lastWeighIn,
    body_comp_expectation_open: expectationOpen,
    last_body_measurement_date: lastMeasurement,
    overdue_lab_due_date: overdueDue,
    overdue_lab_label: overdueLabel,
  };
}

// Signal keys are namespaced ("marker:apob", "directive-recheck:…"). The readable
// tail is what a person would recognize; anything unparseable yields null and the
// prose falls back to the generic phrasing rather than printing an internal key.
function markerLabelFromSignalKey(signalKey: string): string | null {
  const tail = String(signalKey ?? "")
    .split(":")
    .pop();
  if (!tail) return null;
  const label = tail.replace(/[_-]+/g, " ").trim();
  return label.length >= 2 && label.length <= 60 ? label : null;
}

// The whole read in one call: assemble, then decide. Read-only.
export function currentMeasurementRequest(asOf: string = localDateISO()): MeasurementRequest | null {
  return measurementRequestDecision(measurementRequestState(asOf));
}

// ---- the quiet attention slot ------------------------------------------------

export const MEASUREMENT_REQUEST_SOURCE = "measurement-request";

function signalKeyFor(need: MeasurementNeedKey): string {
  return `measurement-request:${need.replace(/_/g, "-")}`;
}

const DOMAIN_BY_NEED: Record<MeasurementNeedKey, CadencePolicy["domain"]> = {
  weigh_in: "body",
  body_measurement: "body",
  lab_recheck: "health",
};

// One ladder shape for all three needs. The gaps (9 / 17 / 31) are each coprime
// with the four phrasings above, and ONE surveillance check rather than the usual
// two: a request for data is a convenience, not a clinical signal, so it earns its
// silence faster than a marker does. Asked at most four times — roughly 9 days,
// then 17, then 31 apart — and then never again for this episode.
function policyFor(need: MeasurementNeedKey, reason: string): CadencePolicy {
  return {
    signal_class: signalKeyFor(need),
    domain: DOMAIN_BY_NEED[need],
    source: MEASUREMENT_REQUEST_SOURCE,
    active_days: 9,
    confirming_days: 17,
    surveillance_initial_days: 31,
    surveillance_multiplier: 1.75,
    surveillance_max_days: 120,
    surveillance_checks_before_release: 1,
    reason,
    release_condition:
      "The measurement arrives, or the need behind it lapses — either one clears this entirely; until then the request simply stops being repeated.",
  };
}

/**
 * The Today-rail candidate — the ONE surface this ever reaches.
 *
 * Null is the common answer. Returns a card only when a need fires AND the
 * schedule says the request may be made today.
 *
 * PURE READ — never writes. The candidate's own priority (16) sits above the
 * quiet `lately` state card and below the goal check-in, so on a day with
 * anything real to show it lands behind the "more" disclosure and on a quiet day
 * it is inline — which is exactly when an ask for one small thing is welcome.
 * Whether it actually landed inline is not known until every candidate is ranked,
 * so this function cannot itself decide whether the request was genuinely seen;
 * call `reconcileMeasurementRequestAttention` once placement is known.
 */
export function measurementRequestCandidate(asOf: string = localDateISO()): TodayAgendaCandidate | null {
  const request = currentMeasurementRequest(asOf);
  if (!request) return null;

  const entry = getAttentionSchedule(signalKeyFor(request.need));
  // Released (it has said its piece) or still inside the cooldown → quiet.
  if (entry && (entry.tier === "released" || !entry.next_due || entry.next_due > asOf)) return null;

  const line = measurementRequestLine(request, asOf);
  return {
    id: `measurement-request-${request.need.replace(/_/g, "-")}`,
    kind: request.need === "lab_recheck" ? "health" : "fuel",
    tier: "primary",
    priority: 16,
    kicker: line.kicker,
    title: line.title,
    body: line.body,
    dismissible: true,
  };
}

/**
 * Reconcile the shared attention ladder against today's ACTUAL outcome. Call this
 * once, after the Today salience arbiter has produced and placed every candidate.
 *
 *   - the need has resolved (the measurement landed, or the reason for wanting it
 *     lapsed) → clear the schedule row outright, so a LATER lapse opens a fresh
 *     ladder instead of inheriting an exhausted one. Bookkeeping, not spending, so
 *     it runs regardless of `surfacedId`. Every need is judged, not just the one
 *     firing today: a weigh-in that lands while the tape request is showing must
 *     still retire the weigh-in row. What is judged is each need's OWN liveness,
 *     never whether it happens to be the one asked — a live need that is merely
 *     outranked keeps its ladder untouched. (Clearing it would restart it at
 *     `active` on the next day it wins, and since the weigh-in need re-fires every
 *     few days through a cut, a lower-priority ask reset on that cadence could
 *     never climb far enough to go quiet — breaking this module's own bound of a
 *     handful of asks and then silence.)
 *   - the need still stands AND its card actually reached the visible set →
 *     advance the ladder exactly once, exactly like a genuine ask.
 *
 * A produced-but-buried card is a no-op: nobody saw it, so the same request is
 * still available next time.
 *
 * Only ever called for a live day a human is actually looking at — never for a
 * routed historical date or an agent's read-only pass; the caller owns that gate.
 */
export function reconcileMeasurementRequestAttention(asOf: string, surfacedId: string | null): void {
  // One state read serves both halves: which needs are still live at all, and which
  // one of them is the ask.
  const live = liveMeasurementNeeds(measurementRequestState(asOf));
  const request = firstByPriority(live);

  // Sweep only the needs that are no longer live — the measurement landed, or the
  // reason for wanting it is over. Being outranked is not being resolved.
  for (const need of NEED_ORDER) {
    if (live.has(need)) continue;
    const key = signalKeyFor(need);
    if (getAttentionSchedule(key)) deleteAttentionSchedule(key);
  }
  if (!request) return;

  const key = signalKeyFor(request.need);
  const entry = getAttentionSchedule(key);
  const surfaced = surfacedId === `measurement-request-${request.need.replace(/_/g, "-")}`;
  if (!surfaced) return;
  // Released or still inside the cooldown → nothing to advance (mirrors the
  // candidate's own quiet-window check).
  if (entry && (entry.tier === "released" || !entry.next_due || entry.next_due > asOf)) return;

  applyAttentionObservation({
    signal_key: key,
    policy: policyFor(request.need, request.reason),
    observation: {
      checked_at: asOf,
      // The FIRST ask opens the ladder at `active`; every repeat is a clean check
      // that stretches it toward silence.
      status: entry ? "clean" : "active",
      source: MEASUREMENT_REQUEST_SOURCE,
      reason: request.reason,
    },
  });
}

// Exported for the tests and for any surface that wants to know what is currently
// being asked for without producing a card. Read-only.
export function openMeasurementRequestKeys(): string[] {
  return NEED_ORDER.map((need) => signalKeyFor(need)).filter((key) => {
    const entry = getAttentionSchedule(key);
    return !!entry && entry.tier !== "released";
  });
}

// Kept beside the ladder so a caller reasoning about a need can name its row
// without re-deriving the key format.
export function measurementRequestSignalKey(need: MeasurementNeedKey): string {
  return signalKeyFor(need);
}
