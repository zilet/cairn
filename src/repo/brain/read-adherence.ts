// READ ADHERENCE — the falsifiable half of the Brief.
//
// The morning read is the highest-frequency decision the brain makes, and until
// this module existed it predicted NOTHING: every `day_read` row in
// `brain_decisions` carried zero expectations, so it could never be wrong, so it
// could never teach anything. Two things live here.
//
// 1. The DECISION FINGERPRINT. The ledger used to compare the whole `signals`
//    blob to decide whether a read had changed, and `signals` moves all day (a
//    watch sync, a fuel bucket, a readiness field arriving). So one calendar day
//    produced ~19 immutable decision rows, 18 of them immediately superseded, and
//    `recent_decisions` in the coach context was nothing but day-read churn. The
//    fingerprint answers the narrower question the ledger actually asks — could
//    the RECOMMENDATION have changed? — off the read's own kind/focus/steer plus
//    the day-read input fingerprint (`dayReadInputFingerprint`, which is already
//    tuned to exactly that question).
//
// 2. The EXPECTATION. Same-day window, matures the next morning — unlike every
//    other expectation in the ledger, which waits one to four weeks, which is
//    precisely why this one is worth having: the loop finally produces conclusive
//    verdicts on a daily cadence instead of never.
//
// Nothing here changes a rest/easy/train threshold. Adherence is MEASURED and
// surfaced (operator diagnostics + coach context); the tuning decision it informs
// belongs to the athlete, not to this file. It is not a score and must never be
// rendered as one — VISION.md bans graded numbers about the person.
import { db } from "../../db.js";
import type { ProposedExpectation } from "../../brain/expectation-contract.js";
import {
  brainDecisionFingerprint,
  findBrainDecisionByFingerprint,
  recordDecision,
  setBrainExpectationStatus,
  transitionBrainDecision,
} from "../brain-decisions.js";
import { activeRecoveryWeek, getPrimaryDiscipline } from "../profile.js";
import { addDaysISO, localDateISO } from "../shared.js";
import { dayLoad, hardCardioDay, recentCardioLoadMedian, type TrainingLoad } from "../training-read.js";

export const DAY_READ_ADHERENCE_METRIC = "day_read_adherence";
export const DAY_READ_ADHERENCE_EVALUATOR_VERSION = "day-read-adherence-v1";

// The reads that make a claim about the day. `done` is an acknowledgement of work
// that ALREADY happened, so it predicts nothing and never earns an expectation.
export type PredictiveDayReadKind = "train" | "easy" | "rest";
export type DayReadKind = PredictiveDayReadKind | "done";

const PREDICTIVE_KINDS = new Set<string>(["train", "easy", "rest"]);

export function isPredictiveDayReadKind(value: unknown): value is PredictiveDayReadKind {
  return typeof value === "string" && PREDICTIVE_KINDS.has(value);
}

// What a calendar day's training log actually says, graded the SAME way dayRead()
// grades it (discipline-aware `dayLoad`, plus the hard-cardio bump that makes a
// lifter's genuinely hard run count). Deliberately a separate small read rather
// than a peek at the cached `day_reads.signals`: that row holds END-of-day state
// and is rewritten all day, so it can silently answer a different question.
export interface DayTrainingTruth {
  date: string;
  sets: number;
  // Every logged activity that day, and the subset clearing dayRead's own "real
  // activity" bar (≥20 min or any logged distance) — an incidental ten-minute walk
  // is not the athlete defying a rest read.
  activities: number;
  real_activities: number;
  load: TrainingLoad | "none";
  // Any training at all was logged (a lifting set or a real activity). Same fact
  // dayRead publishes as `signals.trained_today`, computed the same way.
  trained: boolean;
  // The day graded hard or moderate — a genuinely LOADING day.
  above_easy: boolean;
  // Work was logged but nothing in it could be graded, so "did it stay easy?"
  // has no honest answer. Never treated as adherence OR divergence.
  ungraded_work: boolean;
}

export interface DayTrainingTruthOptions {
  countsCardio?: boolean;
  cardioLoadMedian?: number | null;
}

export function dayTrainingTruth(date: string, opts: DayTrainingTruthOptions = {}): DayTrainingTruth {
  const countsCardio = opts.countsCardio ?? ((d) => d === "endurance" || d === "hybrid")(getPrimaryDiscipline());
  const recoveryWeekActive = !!activeRecoveryWeek(date);
  const setRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date = ?`
    )
    .get(date) as { n?: number } | undefined;
  const activityRows = db
    .prepare(`SELECT duration_min, distance_km FROM activities WHERE date = ? LIMIT 100`)
    .all(date) as Array<{ duration_min: number | null; distance_km: number | null }>;
  const sets = Number(setRow?.n ?? 0);
  const realActivities = activityRows.filter(
    (row) => (row.duration_min != null && Number(row.duration_min) >= 20) || row.distance_km != null
  ).length;
  let load = dayLoad(date, { countsCardio, recoveryWeekActive });
  if (load !== "hard" && !countsCardio) {
    const median = opts.cardioLoadMedian !== undefined ? opts.cardioLoadMedian : recentCardioLoadMedian(date);
    if (hardCardioDay(date, median)) load = "moderate";
  }
  const trained = sets > 0 || realActivities > 0;
  const aboveEasy = load === "hard" || load === "moderate";
  return {
    date,
    sets,
    activities: activityRows.length,
    real_activities: realActivities,
    load,
    trained,
    above_easy: aboveEasy,
    ungraded_work: trained && load === "none",
  };
}

export type ReadAdherenceOutcome = "followed" | "diverged" | "unclear";

// The exact test each read is held to, in plain words. Published alongside every
// count this module emits so the number can never travel without the sentence that
// says what it means.
export const READ_ADHERENCE_MEASURES: Readonly<Record<PredictiveDayReadKind, string>> = Object.freeze({
  train: "any training was logged",
  easy: "nothing above an easy day was logged",
  rest: "no training was logged",
});

// The prediction each read makes, in one place, so the evaluator and the rolling
// model can never disagree about what "followed" means:
//   rest  → no training session is logged that day
//   train → one is
//   easy  → training stays at or below easy
//
// WHAT THIS DOES NOT MEASURE. "Followed a train read" means training was LOGGED —
// not that it was hard, or long, or the session that was suggested. A twenty-minute
// mobility flush satisfies it. That asymmetry is deliberate and must stay: any bar
// separating "real training" from "not really training" would be an invented number
// and a graded judgment about the person, which VISION.md forbids. The signal this
// metric exists to make measurable is the REST read — mornings the Brief reads rest
// and the athlete trains anyway — and there "no training was logged" is exactly the
// right test. Read the train counts as engagement with the read, never as a verdict
// on effort.
export function readAdherenceOutcome(kind: string, truth: DayTrainingTruth): ReadAdherenceOutcome {
  switch (kind) {
    case "rest":
      return truth.trained ? "diverged" : "followed";
    case "train":
      return truth.trained ? "followed" : "diverged";
    case "easy":
      if (truth.above_easy) return "diverged";
      if (truth.ungraded_work) return "unclear";
      return "followed";
    default:
      return "unclear";
  }
}

// ---------- the expectation ----------

export interface DayReadForLedger {
  kind?: unknown;
  focus?: unknown;
  est_minutes?: unknown;
  why?: unknown;
  headline?: unknown;
  source?: unknown;
  signals?: Record<string, unknown> | null;
}

// A same-day window that matures the NEXT morning: window_start is the read's own
// date, window_end one day later, so `evaluateExpectation` refuses to conclude
// while the day is still open and the nightly pass picks it up the moment it
// closes. `subject_key` is the read date — unique per day, which also keeps
// `overlappingDecisionConfounders` from matching consecutive days against each
// other, and it is what the evaluator observes (never the two-day window span).
export function dayReadAdherenceExpectation(date: string, read: DayReadForLedger): ProposedExpectation | null {
  const kind = read.kind;
  if (!isPredictiveDayReadKind(kind)) return null;
  const windowEnd = addDaysISO(date, 1) ?? date;
  const baseline = {
    read_kind: kind,
    focus: typeof read.focus === "string" && read.focus.trim() ? read.focus.trim() : null,
    est_minutes: Number.isFinite(Number(read.est_minutes)) ? Number(read.est_minutes) : null,
    prediction:
      kind === "train"
        ? "a training session is logged on this day"
        : kind === "rest"
          ? "no training session is logged on this day"
          : "training on this day stays at or below easy",
  };
  const shared = {
    metric_key: DAY_READ_ADHERENCE_METRIC,
    subject_key: date,
    baseline,
    window_start: date,
    window_end: windowEnd,
    // One CLOSED day is the whole evidence requirement; without it the verdict is
    // honestly inconclusive rather than a guess off a day still in progress.
    minimum_data: { closed_days: 1 },
    // THE ONE METRIC THAT MUST OPT OUT OF CONTEXT CONFOUNDERS.
    //
    // Every other expectation here asks a CAUSAL question over weeks — did the
    // deficit move the weight, did the protocol move the marker — and for those a
    // trip or an illness genuinely muddies the answer, which is why the default is
    // `standard` and must stay that way. This one asks a FACTUAL question about a
    // single finished day: was training logged? Nothing about a life event makes
    // that fact less true, and the injury is arguably the very thing worth
    // measuring, not a reason to discard the measurement.
    //
    // `standard` here was not merely imprecise, it was FATAL. contextEventConfounders
    // treats an open-ended row (end_date NULL) as overlapping every window forever,
    // and any confounder forces `inconclusive` — which, because this metric is
    // terminal once evaluated, is never revisited. The live deployment carries one
    // open-ended `injury` row, so every adherence verdict would have come back
    // inconclusive for good, and expectation_health.never_conclusive would have read
    // true: the instrument built to detect a dead loop reporting a cause an operator
    // would misread as a stopped scheduler. Note the regex also matches `supplement`
    // and `medicat`, so an ongoing supplement regimen would have done the same.
    confounder_policy: "none",
    confidence: "tentative",
    evaluator: DAY_READ_ADHERENCE_METRIC,
    evaluator_version: DAY_READ_ADHERENCE_EVALUATOR_VERSION,
  } as const;
  return kind === "train"
    ? { ...shared, direction: "at_least", target: { value: 1 } }
    : { ...shared, direction: "avoid", target: { max: 0 } };
}

// ---------- the ledger write ----------

export interface DayReadLedgerEntry {
  decision_id: number;
  expectation_ids: number[];
  superseded: number[];
}

const MAX_FINGERPRINT_HOPS = 20;

// Persist the read as a bounded, outcome-addressable decision, idempotent for an
// unchanged read. Returns null when the write could not be made addressable — the
// caller treats that as "skip the ledger", never as a failure of the Brief.
export function recordDayReadDecision(
  date: string,
  read: DayReadForLedger,
  opts: { inputFingerprint?: string | null; override?: string | null } = {}
): DayReadLedgerEntry | null {
  const kind = String(read.kind ?? "").trim();
  if (!date || !kind) return null;
  const override = opts.override ?? null;
  const focus = typeof read.focus === "string" && read.focus.trim() ? read.focus.trim() : null;
  const root = brainDecisionFingerprint({
    scope: "day_read",
    date,
    read_kind: kind,
    focus,
    override,
    // The day-read input fingerprint already excludes narration and continuous
    // measurements that cannot move the decision; reusing it is what makes an
    // unchanged morning idempotent here.
    input_fingerprint: opts.inputFingerprint ?? null,
  });
  // A read that flips away and back within one day (train → rest → train) finds
  // its own earlier row already SUPERSEDED. That row is immutable history, not
  // ownership of the new observation, so walk to a free fingerprint exactly the
  // way recordDecision walks a lifecycle chain.
  let fingerprint = root;
  let existing = findBrainDecisionByFingerprint(fingerprint);
  let hops = 0;
  while (existing && existing.status !== "observed" && hops < MAX_FINGERPRINT_HOPS) {
    fingerprint = brainDecisionFingerprint({ root_fingerprint: root, lifecycle_after: Number(existing.id) });
    existing = findBrainDecisionByFingerprint(fingerprint);
    hops++;
  }
  if (existing && existing.status !== "observed") return null;

  const expectation = dayReadAdherenceExpectation(date, read);
  const recorded = recordDecision(
    {
      effective_date: date,
      kind: "day_read",
      domain: "cross_domain",
      summary: String(read.headline || `${kind} day`).slice(0, 300),
      rationale: read.why ?? null,
      source: read.source ?? "deterministic",
      source_ref_type: "day_read",
      source_ref_key: date,
      status: "observed",
      autonomy_tier: "observe",
      risk_class: "low",
      reversible: false,
      input_fingerprint: fingerprint,
      // MORNING STATE, NOT END-OF-DAY STATE. Because the fingerprint above no
      // longer depends on `signals`, a repeat write for an unchanged read is an
      // INSERT OR IGNORE — so this column keeps the signals from the FIRST write
      // of the day and later recomputes never overwrite it. That is deliberate and
      // is the whole difference from the `day_reads` cache, which holds one mutable
      // row per date and therefore reads back as end-of-day state (a rest morning
      // that ended in a session reads back as `done` there). Anything asking "what
      // did the brain see when it made this call?" wants this column; anything
      // asking "how did the day end?" must not use it.
      context: { signals: read.signals ?? {}, override },
      action: {
        kind,
        focus,
        est_minutes: read.est_minutes ?? null,
        why: read.why ?? null,
      },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: expectation ? DAY_READ_ADHERENCE_EVALUATOR_VERSION : null,
    },
    expectation ? [expectation] : []
  );

  // The cache has one mutable row per date; the accountability ledger does not.
  // Every materially different observation stays as its own immutable entry, and
  // the older ones for the same date are closed against the current read.
  const currentId = Number(recorded.decision.id);
  const priors = db
    .prepare(
      `SELECT id FROM brain_decisions
        WHERE kind = 'day_read' AND source_ref_type = 'day_read' AND source_ref_key = ?
          AND status = 'observed' AND id <> ?
        ORDER BY id`
    )
    .all(date, currentId) as Array<{ id: number }>;
  for (const prior of priors) transitionBrainDecision(Number(prior.id), "superseded", { supersededBy: currentId });

  return {
    decision_id: currentId,
    expectation_ids: recorded.expectations.map((item) => Number(item.id)).filter((id) => Number.isInteger(id)),
    superseded: priors.map((row) => Number(row.id)),
  };
}

// ---------- re-opening a closed day ----------

// The facts a stored verdict was reached from. If any of them has moved, the
// verdict was reached against a log that no longer exists and must be re-asked.
// A stored `actual` from before a field existed compares as changed, which costs
// exactly one extra evaluation and then settles.
function adherenceFactsChanged(actual: unknown, truth: DayTrainingTruth): boolean {
  if (!actual || typeof actual !== "object") return true;
  const stored = actual as Record<string, unknown>;
  const count = (value: unknown): number | null => (Number.isFinite(Number(value)) ? Number(value) : null);
  return (
    count(stored.logged_sets) !== truth.sets ||
    count(stored.logged_activities) !== truth.activities ||
    count(stored.real_activities) !== truth.real_activities ||
    String(stored.load ?? "") !== truth.load
  );
}

// Work logged for a day that has ALREADY been judged re-opens that judgement.
//
// Same-day expectations are terminal once evaluated, which is what stops the
// nightly sweep re-asking closed questions forever. But training genuinely arrives
// after the fact here — a Garmin activity syncs late, strength reconciliation
// attaches work to a day well after it closed — and the error that creates is not
// symmetric: a missed re-judgement always turns a `diverged` into a stale
// `aligned`, never the reverse. Left alone, the loop would quietly overstate how
// often its own reads are followed, on the one metric built to measure that
// honestly. A learning loop whose failure mode flatters itself is worse than none.
//
// Deliberately narrow, so it cannot undo the terminality it sits beside:
//   • only the same-day adherence metric, never a long-window expectation;
//   • only the affected date;
//   • only while the decision it belongs to is still the read that STOOD (a
//     superseded read's verdict is `canceled` and re-judging it is meaningless);
//   • and only when the day's logged facts actually moved, so an unrelated write
//     for a past date (a backfilled meal, a weigh-in) re-opens nothing.
// evaluateMatureExpectations closes any re-opened row again the moment it produces
// an unchanged answer, so a re-open can never become a standing re-probe.
export function reopenDayReadAdherence(date: string): number[] {
  if (!date) return [];
  const rows = db
    .prepare(
      `SELECT expectation.id AS id, latest.actual_json AS actual_json
         FROM brain_expectations expectation
         JOIN brain_decisions decision ON decision.id = expectation.decision_id
         LEFT JOIN brain_evaluations latest
           ON latest.id = (
             SELECT evaluation.id FROM brain_evaluations evaluation
              WHERE evaluation.expectation_id = expectation.id
              ORDER BY evaluation.evaluated_at DESC, evaluation.id DESC LIMIT 1
           )
        WHERE expectation.metric_key = ?
          AND expectation.subject_key = ?
          AND expectation.status IN ('evaluated', 'canceled')
          AND decision.status = 'observed'
          AND decision.superseded_by IS NULL
        ORDER BY expectation.id LIMIT 20`
    )
    .all(DAY_READ_ADHERENCE_METRIC, date) as Array<{ id: number; actual_json: string | null }>;
  if (!rows.length) return [];

  const truth = dayTrainingTruth(date);
  const reopened: number[] = [];
  for (const row of rows) {
    let actual: unknown = null;
    try {
      actual = row.actual_json ? JSON.parse(row.actual_json) : null;
    } catch {
      actual = null;
    }
    if (!adherenceFactsChanged(actual, truth)) continue;
    setBrainExpectationStatus(Number(row.id), "pending");
    reopened.push(Number(row.id));
  }
  return reopened;
}

// ---------- the rolling model ----------

export interface ReadAdherenceKindStat {
  read: PredictiveDayReadKind;
  // The plain-words test behind these counts (READ_ADHERENCE_MEASURES). Carried on
  // every row so an operator reading the JSON cannot mistake a followed `train`
  // day for a hard one.
  measures: string;
  days: number;
  followed: number;
  diverged: number;
  unclear: number;
}

export interface ReadAdherenceDay {
  date: string;
  read: PredictiveDayReadKind;
  outcome: ReadAdherenceOutcome;
  load: TrainingLoad | "none";
  trained: boolean;
}

export interface ReadAdherenceModel {
  as_of: string;
  window_days: number;
  days_observed: number;
  by_read: ReadAdherenceKindStat[];
  recent: ReadAdherenceDay[];
}

const READ_ORDER: PredictiveDayReadKind[] = ["train", "easy", "rest"];

// Which read the athlete was actually GIVEN that morning, taken from the earliest
// ledger entry for the date. Deliberately not `day_reads` (one mutable row that
// holds end-of-day state — a rest morning that ended in a session reads back as
// `done`) and not `suggestions` (pre-dedupe duplicate rows).
function morningReadsByDate(from: string, to: string): Map<string, PredictiveDayReadKind> {
  const rows = db
    .prepare(
      `SELECT current.source_ref_key AS date, current.action_json AS action_json
         FROM brain_decisions current
         JOIN (
           SELECT MIN(id) AS id FROM brain_decisions
            WHERE kind = 'day_read' AND source_ref_type = 'day_read'
              AND source_ref_key >= ? AND source_ref_key <= ?
            GROUP BY source_ref_key
         ) first ON first.id = current.id
        ORDER BY current.source_ref_key LIMIT 400`
    )
    .all(from, to) as Array<{ date: string; action_json: string | null }>;
  const out = new Map<string, PredictiveDayReadKind>();
  for (const row of rows) {
    let kind: unknown = null;
    try {
      kind = JSON.parse(String(row.action_json ?? "null"))?.kind;
    } catch {
      kind = null;
    }
    if (isPredictiveDayReadKind(kind)) out.set(String(row.date), kind);
  }
  return out;
}

// How often each kind of read is followed, over a rolling window of CLOSED days.
// Counts only — no rate, no grade, no score. It exists so the disagreement between
// what the Brief suggests and what the athlete does becomes measurable; it changes
// no rule and no threshold on its own.
export function readAdherenceModel(asOf: string = localDateISO(), windowDays = 42): ReadAdherenceModel {
  const days = Math.max(1, Math.min(180, Math.trunc(Number(windowDays) || 42)));
  const lastClosed = addDaysISO(asOf, -1) ?? asOf;
  const from = addDaysISO(lastClosed, -(days - 1)) ?? lastClosed;
  const stats = new Map<PredictiveDayReadKind, ReadAdherenceKindStat>(
    READ_ORDER.map((read) => [
      read,
      { read, measures: READ_ADHERENCE_MEASURES[read], days: 0, followed: 0, diverged: 0, unclear: 0 },
    ])
  );
  const recent: ReadAdherenceDay[] = [];
  let reads = new Map<string, PredictiveDayReadKind>();
  try {
    reads = morningReadsByDate(from, lastClosed);
  } catch {
    reads = new Map();
  }
  // Discipline and the cardio-load median are properties of the athlete NOW, not
  // of each day, so they are resolved once instead of per day (42 days × a 42-day
  // median query is what made a naive version too heavy for the coach context).
  const discipline = (() => {
    try {
      return getPrimaryDiscipline();
    } catch {
      return "strength" as const;
    }
  })();
  const countsCardio = discipline === "endurance" || discipline === "hybrid";
  const cardioLoadMedian = countsCardio
    ? null
    : (() => {
        try {
          return recentCardioLoadMedian(lastClosed);
        } catch {
          return null;
        }
      })();

  for (const date of [...reads.keys()].sort()) {
    const read = reads.get(date)!;
    let truth: DayTrainingTruth | null = null;
    try {
      truth = dayTrainingTruth(date, { countsCardio, cardioLoadMedian });
    } catch {
      truth = null;
    }
    if (!truth) continue;
    const outcome = readAdherenceOutcome(read, truth);
    const stat = stats.get(read)!;
    stat.days++;
    if (outcome === "followed") stat.followed++;
    else if (outcome === "diverged") stat.diverged++;
    else stat.unclear++;
    recent.push({ date, read, outcome, load: truth.load, trained: truth.trained });
  }

  return {
    as_of: asOf,
    window_days: days,
    days_observed: recent.length,
    by_read: READ_ORDER.map((read) => stats.get(read)!).filter((stat) => stat.days > 0),
    recent: recent.slice(-14),
  };
}
