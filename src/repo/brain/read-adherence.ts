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
import { activeRecoveryWeek } from "../profile.js";
import { addDaysISO, localDateISO } from "../shared.js";
import { getTrainingIntent } from "../training-intent.js";
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

// ---------- THE SUPERSESSION INVARIANT ----------
//
// ONLY A NEW PREDICTION MAY CLOSE AN OLD ONE.
//
// A day's ledger holds every materially different read of that day, and the older
// ones are closed against the current one — which is right when the current one is
// itself a claim about the day: a morning that read rest and re-read train because
// the signals moved genuinely retires the rest call, and the expectation riding on it
// is honestly canceled rather than judged against a day it stopped describing.
//
// `done` is not that. It is an acknowledgement written AFTER the work, it predicts
// nothing (dayReadAdherenceExpectation returns null for it), and every training day
// ends in one. Letting it supersede meant the morning's train/easy read was retired
// by the very evidence that would have confirmed it: a live audit found 13 of 13
// train/easy reads over ten days closed this way, their expectations stamped
// `canceled` without the day ever being looked at. The loop could record divergence —
// a rest read stands, because a rest day writes no `done` — and essentially never
// compliance, which is the one asymmetry a learning loop must not have.
//
// The rule is enforced at the WRITE (recordDayReadDecision does not supersede for a
// non-predictive read) and read back at EVALUATION (dayReadExpectationSurvivesSupersession,
// which is what lets rows written before this heal). Both spellings are here so they
// cannot drift.
export function dayReadSupersedesPriorReads(kind: unknown): boolean {
  return isPredictiveDayReadKind(kind);
}

interface SupersessionCandidate {
  kind?: unknown;
  source_ref_type?: unknown;
  superseded_by?: unknown;
}

function isDayReadDecision(row: SupersessionCandidate): boolean {
  return String(row.kind ?? "") === "day_read" && String(row.source_ref_type ?? "") === "day_read";
}

function decisionActionKind(row: { action?: unknown; action_json?: unknown }): unknown {
  const action = row.action;
  if (action && typeof action === "object") return (action as Record<string, unknown>).kind;
  try {
    return JSON.parse(String(row.action_json ?? "null"))?.kind;
  } catch {
    return null;
  }
}

/**
 * Does this day-read decision's expectation SURVIVE the chain that closed it out?
 *
 * Two successors leave the claim standing, and both for the same reason — neither
 * takes the claim away from it:
 *
 *   • a NON-PREDICTIVE successor (`done`), which acknowledges work that already
 *     happened and predicts nothing; and
 *   • a successor making the SAME claim, which is the same read restated. A mid-day
 *     recompute that lands on the same kind is not a change of call, and retiring the
 *     morning's expectation for it was cancelling a prediction nothing had replaced.
 *
 * Anything else — a newer read of a DIFFERENT kind — is a genuine change of call and
 * still cancels, because the day it predicted stopped being the day it describes.
 *
 * Walks the whole chain, because a train → done → rest sequence IS a genuine
 * replacement. Returns false for anything that is not a day-read decision, and for any
 * decision terminal for its own reasons (reverted, rejected, canceled).
 */
export function dayReadExpectationSurvivesSupersession(decision: {
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  source_ref_type?: unknown;
  superseded_by?: unknown;
  action?: unknown;
  action_json?: unknown;
}): boolean {
  if (!isDayReadDecision(decision)) return false;
  const status = String(decision.status ?? "");
  if (status !== "observed" && status !== "superseded") return false;
  // The claim this decision's own expectation rides on. Unknown (an old row with no
  // action) degrades to the narrower original rule: only acknowledgements survive.
  const ownKind = decisionActionKind(decision);
  let next = Number(decision.superseded_by);
  if (!Number.isInteger(next) || next <= 0) return false;
  const seen = new Set<number>();
  for (let hops = 0; hops < MAX_FINGERPRINT_HOPS; hops++) {
    if (seen.has(next)) return false;
    seen.add(next);
    let row: (SupersessionCandidate & { action_json?: unknown }) | undefined;
    try {
      row = db
        .prepare(`SELECT kind, source_ref_type, action_json, superseded_by FROM brain_decisions WHERE id = ?`)
        .get(next) as (SupersessionCandidate & { action_json?: unknown }) | undefined;
    } catch {
      return false;
    }
    if (!row || !isDayReadDecision(row)) return false;
    const kind = decisionActionKind(row);
    // A newer, DIFFERENT prediction about the day took ownership: the genuine cancel path.
    if (isPredictiveDayReadKind(kind) && kind !== ownKind) return false;
    const following = Number(row.superseded_by);
    if (!Number.isInteger(following) || following <= 0) return true;
    next = following;
  }
  return false;
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

function configuredEnduranceCountsAsTraining(): boolean {
  try {
    return getTrainingIntent().endurance_role !== "none";
  } catch {
    return false;
  }
}

export function dayTrainingTruth(date: string, opts: DayTrainingTruthOptions = {}): DayTrainingTruth {
  const countsCardio = opts.countsCardio ?? configuredEnduranceCountsAsTraining();
  const recoveryWeekActive = !!activeRecoveryWeek(date);
  const setRow = db
    .prepare(`SELECT COUNT(*) AS n FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date = ?`)
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

// The training truth, or null if it could not be read. A ledger write must never fail
// because a truth query did — the caller degrades to "nothing is locked", which is the
// pre-existing behavior.
function safeDayTrainingTruth(date: string): DayTrainingTruth | null {
  try {
    return dayTrainingTruth(date);
  } catch {
    return null;
  }
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

// ---------- an outcome the day has already decided ----------
//
// Within one calendar day the two facts these outcomes turn on only ever go TRUE:
// `trained` once a set or a real activity is logged, `above_easy` once the day grades
// moderate or hard. Nothing later in the day can take either back. So some outcomes
// LOCK the moment they happen and are no longer open questions:
//
//   rest  + trained    → diverged, and stays diverged
//   train + trained    → followed, and stays followed
//   easy  + above_easy → diverged, and stays diverged
//
// Everything else is still open (a train read with nothing logged yet may still be
// followed at 21:00), and an open claim is one a newer read may honestly take over.
//
// A SUPERSESSION MAY NOT ERASE A CLAIM THE DAY HAS ALREADY DECIDED. A morning that
// read rest and was re-read as train after the athlete had already trained is not a
// read whose day stopped describing it — it is a read the day answered. Cancelling it
// is how 13 of 22 predictions were being thrown away: the loop kept the evidence only
// on the days nothing happened.
export function dayReadOutcomeLocked(kind: unknown, truth: DayTrainingTruth): boolean {
  if (!isPredictiveDayReadKind(kind)) return false;
  return kind === "easy" ? truth.above_easy : truth.trained;
}

// The same question asked of a stored expectation, for the ONE evaluator branch that
// needs it. Kept here so the domain knowledge (which read predicts what, and when the
// day has settled it) stays in this module rather than leaking into the evaluator.
// Answers false for any other metric, so the caller needs no metric test of its own.
export function dayReadExpectationOutcomeLocked(expectation: {
  metric_key?: unknown;
  subject_key?: unknown;
  baseline?: unknown;
}): boolean {
  if (String(expectation.metric_key ?? "") !== DAY_READ_ADHERENCE_METRIC) return false;
  const date = String(expectation.subject_key ?? "");
  if (!date) return false;
  const baseline = expectation.baseline;
  const kind = baseline && typeof baseline === "object" ? (baseline as Record<string, unknown>).read_kind : null;
  if (!isPredictiveDayReadKind(kind)) return false;
  try {
    return dayReadOutcomeLocked(kind, dayTrainingTruth(date));
  } catch {
    return false;
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
  opts: { override?: string | null } = {}
): DayReadLedgerEntry | null {
  const kind = String(read.kind ?? "").trim();
  if (!date || !kind) return null;
  const override = opts.override ?? null;
  const focus = typeof read.focus === "string" && read.focus.trim() ? read.focus.trim() : null;
  // THE FINGERPRINT HASHES THE CLAIM, NOT THE INPUTS.
  //
  // What the ledger asks of a day-read row is "what did the brain claim about this
  // day, and was it right?" — and the claim is the KIND (plus whether the athlete
  // overrode it). Everything else the read carries is presentation or provenance.
  //
  // Hashing `dayReadInputFingerprint` here instead meant every input that could move
  // a recommendation opened a new decision row even when the recommendation did not
  // move: a watch sync, a fuel bucket, an evening's first set. A live audit found 13
  // of 22 predictions cancelled that way — the day's own expectation retired by a
  // recompute that reached the SAME conclusion. `focus` goes for the same reason: a
  // train read that re-picks Upper over Lower is the same claim about the day, and
  // adherence measures whether training was logged, never which muscles.
  //
  // So a mid-day recompute landing on the same kind is a pure INSERT OR IGNORE: no
  // new row, no supersession, no cancel, and the morning's expectation goes on asking.
  const root = brainDecisionFingerprint({
    scope: "day_read",
    date,
    read_kind: kind,
    override,
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
  // Every materially different observation stays as its own immutable entry, and the
  // older ones for the same date are closed against the current read — but only when
  // the current read is itself a claim about the day. See dayReadSupersedesPriorReads:
  // a `done` acknowledgement leaves the morning's prediction standing, so the day it
  // predicted can still be judged against it.
  const currentId = Number(recorded.decision.id);
  const priors = dayReadSupersedesPriorReads(kind)
    ? (db
        .prepare(
          `SELECT id, action_json FROM brain_decisions
        WHERE kind = 'day_read' AND source_ref_type = 'day_read' AND source_ref_key = ?
          AND status = 'observed' AND id <> ?
        ORDER BY id`
        )
        .all(date, currentId) as Array<{ id: number; action_json: string | null }>)
    : [];
  // A prior read whose outcome the day has ALREADY DECIDED keeps its expectation.
  // Being replaced retires the read; it does not un-happen the training that answered
  // it (see dayReadOutcomeLocked). The decision itself is still marked superseded, so
  // the lineage and `recent_decisions` read exactly as before — only the pending
  // question survives.
  //
  // INVARIANT, and the one place it is visible: a date may now hold two LIVE
  // expectations — a locked prior plus the new claim. Both are real, separately
  // falsifiable predictions and both must be judged, so `expectation_health` counts
  // two while `readAdherenceModel` (which reads the MORNING read only) counts one.
  // That divergence is expected, not drift.
  const truth = priors.length ? safeDayTrainingTruth(date) : null;
  for (const prior of priors) {
    const locked = !!truth && dayReadOutcomeLocked(decisionActionKind(prior), truth);
    transitionBrainDecision(Number(prior.id), "superseded", {
      supersededBy: currentId,
      keepExpectations: locked,
    });
  }

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
  // Was this morning's read itself the product of the softening below — an easy day
  // that would otherwise have been a rest? Only ever true on an `easy` read. It is
  // what lets the softening tell its OWN easy mornings apart from ordinary ones, and
  // therefore what lets the evidence keep accumulating after it activates (see
  // restOverrideSoftening).
  softened: boolean;
  // The same fact for the rung above: was this morning's read the product of
  // easyOverrideSoftening — a train day that would otherwise have been easy? Only ever
  // true on a `train` read, and it does exactly the same job there (see
  // easyOverrideSoftening). Two separate flags rather than one, because the two ladders
  // must never read each other's evidence: a rest this loop eased to easy is the REST
  // ladder's day, and counting it as an ordinary easy morning would chain the two into
  // a single rest → train step.
  easy_softened: boolean;
}

export interface ReadAdherenceModel {
  as_of: string;
  window_days: number;
  days_observed: number;
  by_read: ReadAdherenceKindStat[];
  recent: ReadAdherenceDay[];
}

const READ_ORDER: PredictiveDayReadKind[] = ["train", "easy", "rest"];

export interface MorningRead {
  kind: PredictiveDayReadKind;
  softened: boolean;
  easySoftened: boolean;
}

// Which read the athlete was actually GIVEN that morning, taken from the earliest
// ledger entry for the date. Deliberately not `day_reads` (one mutable row that
// holds end-of-day state — a rest morning that ended in a session reads back as
// `done`) and not `suggestions` (pre-dedupe duplicate rows).
//
// `context_json` comes back for the same reason: that column is MORNING state (the
// first write of the day wins and later recomputes never overwrite it — see
// recordDayReadDecision), so `signals.outcome_feedback.applied` on it is a faithful
// record of whether the read the athlete opened to had been softened. Reading the
// softening off the read itself, rather than recomputing it, is what keeps this
// free of a recursion back into restOverrideSoftening.
function morningReadsByDate(from: string, to: string): Map<string, MorningRead> {
  const rows = db
    .prepare(
      `SELECT current.source_ref_key AS date, current.action_json AS action_json,
              current.context_json AS context_json
         FROM brain_decisions current
         JOIN (
           SELECT MIN(id) AS id FROM brain_decisions
            WHERE kind = 'day_read' AND source_ref_type = 'day_read'
              AND source_ref_key >= ? AND source_ref_key <= ?
            GROUP BY source_ref_key
         ) first ON first.id = current.id
        ORDER BY current.source_ref_key LIMIT 400`
    )
    .all(from, to) as Array<{ date: string; action_json: string | null; context_json: string | null }>;
  const out = new Map<string, MorningRead>();
  for (const row of rows) {
    let kind: unknown = null;
    try {
      kind = JSON.parse(String(row.action_json ?? "null"))?.kind;
    } catch {
      kind = null;
    }
    if (!isPredictiveDayReadKind(kind)) continue;
    let softened = false;
    let easySoftened = false;
    try {
      const context = JSON.parse(String(row.context_json ?? "null"));
      softened = context?.signals?.outcome_feedback?.applied === true;
      easySoftened = context?.signals?.easy_outcome_feedback?.applied === true;
    } catch {
      softened = false;
      easySoftened = false;
    }
    out.set(String(row.date), { kind, softened, easySoftened });
  }
  return out;
}

// The single morning read for one date, off the same first-ledger-entry source
// morningReadsByDate reads for the rolling model. Exported for callers that only
// need one day (morningReview, src/repo/brain/morning-review.ts) so they consume
// this module's own read of "what was the athlete actually told" rather than
// re-deriving it against `day_reads` or `suggestions` (see morningReadsByDate's
// own comment for why both of those answer a different question).
export function morningReadForDate(date: string): MorningRead | null {
  if (!date) return null;
  try {
    return morningReadsByDate(date, date).get(date) ?? null;
  } catch {
    return null;
  }
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
  let reads = new Map<string, MorningRead>();
  try {
    reads = morningReadsByDate(from, lastClosed);
  } catch {
    reads = new Map();
  }
  // Discipline and the cardio-load median are properties of the athlete NOW, not
  // of each day, so they are resolved once instead of per day (42 days × a 42-day
  // median query is what made a naive version too heavy for the coach context).
  const countsCardio = configuredEnduranceCountsAsTraining();
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
    const morning = reads.get(date)!;
    const read = morning.kind;
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
    recent.push({
      date,
      read,
      outcome,
      load: truth.load,
      trained: truth.trained,
      softened: morning.softened,
      easy_softened: morning.easySoftened,
    });
  }

  return {
    as_of: asOf,
    window_days: days,
    days_observed: recent.length,
    by_read: READ_ORDER.map((read) => stats.get(read)!).filter((stat) => stat.days > 0),
    recent: recent.slice(-14),
  };
}

// ---------- reading the outcomes back ----------
//
// Everything above MEASURES. This is the one derivation that a decision path is
// allowed to consult, and it is deliberately narrow: it answers a single question
// about a single read kind — has the athlete been training through REST mornings,
// and did those days go fine? Nothing else here may grow a consumer without the
// same care, because the module's whole premise is that adherence is evidence, not
// a verdict on the person.
//
// It can only ever make a read SOFTER (dayRead turns a rest into an easy day, never
// into a train day), and every clinical path is excluded by the caller before this
// is consulted at all.

// How far back a divergence still says something about today. Ten closed days is
// about a training block's worth of mornings: long enough that three of them is a
// pattern rather than a bad week, short enough that a stretch the athlete has since
// moved on from falls out on its own.
export const OUTCOME_SOFTENING_WINDOW_DAYS = 10;
// Three, not two: two is a coincidence in a ten-day window, and the cost of being
// wrong here is asymmetric — softening a genuinely-earned rest is worse than being
// slow to soften one the athlete has already overruled six times.
export const OUTCOME_SOFTENING_MIN_DIVERGENCES = 3;
// Session feedback at or above this reads as "that went fine". An UNRATED session
// counts the same way: the athlete not answering is not evidence of harm, and
// treating silence as a bad day would quietly make the common case unreachable.
const NO_HARM_PERFORMANCE = 3;

export interface RestOverrideSoftening {
  active: boolean;
  window_days: number;
  // The mornings inside the window the athlete trained through with nothing in the
  // session feedback suggesting it cost them, newest last. Both kinds count — see
  // restOverrideSoftening.
  overridden_and_fine: string[];
  // The most recent morning they actually TOOK the quiet day it offered: a rest read
  // they rested on, or a softened easy read they did not train through. Everything on
  // or before it is discarded — honoring the read is the athlete agreeing with it,
  // which starts the count over rather than leaving old disagreements standing.
  last_honored_rest: string | null;
}

// What dayRead publishes on `signals.outcome_feedback`: the evidence above PLUS
// whether the read actually MOVED because of it. The two are genuinely different
// facts — the pattern can be established on a morning that reads train, or one where
// a clinical constraint or a fresh short night holds the rest in place — and every
// consumer that says "today has already been eased" must key on `applied`. It is
// also what tomorrow's window reads back off the ledger to tell a softened easy
// morning from an ordinary one.
export interface OutcomeFeedbackSignal extends RestOverrideSoftening {
  applied: boolean;
}

const NO_SOFTENING: RestOverrideSoftening = Object.freeze({
  active: false,
  window_days: OUTCOME_SOFTENING_WINDOW_DAYS,
  overridden_and_fine: [],
  last_honored_rest: null,
});

// Did the work logged on `date` show any sign of having cost them? Only the
// athlete's own session feedback answers this — `performance` is their 1-5 read of
// how the session went against expectation. The WORST session of the day decides,
// so one good lift cannot paper over a second effort that went badly. Exported for
// morningReview (src/repo/brain/morning-review.ts), which asks the same question
// about a single divergence rather than a rolling window of them.
export function trainedWithoutHarm(date: string): boolean {
  try {
    const row = db
      .prepare(`SELECT MIN(performance) AS worst FROM sessions WHERE date = ? AND performance IS NOT NULL`)
      .get(date) as { worst?: number | null } | undefined;
    // An aggregate ALWAYS returns a row, so an unrated day arrives as `worst: null`
    // — and `Number(null)` is 0, not NaN, which read every unrated session as the
    // worst possible one and made the common case (they log the work, they don't
    // rate it) permanently unreachable. Test the absence before coercing.
    if (row?.worst == null) return true;
    const worst = Number(row.worst);
    return Number.isFinite(worst) ? worst >= NO_HARM_PERFORMANCE : true;
  } catch {
    return true;
  }
}

// Which mornings this signal is allowed to reason about at all. Two kinds, and the
// second is what makes the softening a standing adaptation rather than a ten-day
// oscillation:
//
//   • a REST morning — the read the athlete has been overruling; and
//   • a SOFTENED EASY morning — a rest this very signal already eased.
//
// Counting only the first was self-extinguishing. Once active, no new rest mornings
// could accrue (the read had stopped saying rest), the qualifying days aged out of
// the ten-day window, and the read relapsed to rest — a periodic cycle straight back
// to the defect the softening exists to fix. A softened easy morning the athlete
// trains through without harm is the SAME evidence, restated under the new read: the
// quiet day is still not what their body is asking for.
//
// A plain, unsoftened easy morning is neither evidence nor a reset. It was never a
// rest the read had to argue for, so training through it says nothing about whether
// the athlete disagrees with the quiet reads, and taking it easy says nothing either.
function softeningRelevant(day: ReadAdherenceDay): boolean {
  return day.read === "rest" || (day.read === "easy" && day.softened);
}

// The bounded softening signal for `asOf`, read off a model the caller already
// holds. Pure with respect to the model plus the sessions table; safe to call with
// null (a caller whose model read failed gets "no softening", never an exception).
export function restOverrideSoftening(model: ReadAdherenceModel | null, asOf: string): RestOverrideSoftening {
  if (!model || !Array.isArray(model.recent)) return NO_SOFTENING;
  const lastClosed = addDaysISO(asOf, -1);
  const from = addDaysISO(asOf, -OUTCOME_SOFTENING_WINDOW_DAYS);
  if (!lastClosed || !from) return NO_SOFTENING;
  const quietMornings = model.recent
    .filter((day) => day.date >= from && day.date <= lastClosed && softeningRelevant(day))
    .sort((a, b) => a.date.localeCompare(b.date));
  // Honoring EITHER kind resets. A softened easy day they simply took is the athlete
  // agreeing that a quiet day was right, which is the same answer as resting on a
  // rest read and starts the count over the same way.
  const lastHonoredRest = quietMornings.filter((day) => !day.trained).at(-1)?.date ?? null;
  const overriddenAndFine = quietMornings
    .filter((day) => day.trained && (lastHonoredRest == null || day.date > lastHonoredRest))
    .map((day) => day.date)
    .filter(trainedWithoutHarm);
  return {
    active: overriddenAndFine.length >= OUTCOME_SOFTENING_MIN_DIVERGENCES,
    window_days: OUTCOME_SOFTENING_WINDOW_DAYS,
    overridden_and_fine: overriddenAndFine,
    last_honored_rest: lastHonoredRest,
  };
}

// ---------- the same question, one rung up ----------
//
// The rule above closes the loop on the REST read. This one closes it on the EASY
// read, and it exists because closing only half of it left a new floor in place of the
// old one: an athlete whose easy mornings kept turning into real sessions, week after
// week, was still handed an easy morning, and the disagreement was
// recorded and never read back — the exact defect the rest rule was written to fix,
// displaced by one rung (owner ruling, 2026-08-17).
//
// The evidence bar is deliberately IDENTICAL, constant for constant: the same ten-day
// window, the same three divergences, the same "nothing in the session feedback says it
// cost them" test, the same reset on the first morning they agree with the read. Two
// rules that answer the same question about neighbouring reads must not be able to
// disagree about what counts as evidence.
//
// It can only ever make a read one step LOUDER — easy → train, never past it — and
// every clinical path, and the reduced week, are excluded by the caller before this is
// consulted at all, exactly as they are for the rest ladder.

export interface EasyOverrideSoftening {
  active: boolean;
  window_days: number;
  // The easy mornings inside the window the athlete took ABOVE easy with nothing in the
  // session feedback suggesting it cost them, newest last.
  overridden_and_fine: string[];
  // The most recent morning they actually kept at or under easy when a quiet-ish read
  // asked them to. Everything on or before it is discarded — agreeing with the read
  // starts the count over.
  last_honored_easy: string | null;
}

export interface EasyOutcomeFeedbackSignal extends EasyOverrideSoftening {
  applied: boolean;
}

const NO_EASY_SOFTENING: EasyOverrideSoftening = Object.freeze({
  active: false,
  window_days: OUTCOME_SOFTENING_WINDOW_DAYS,
  overridden_and_fine: [],
  last_honored_easy: null,
});

// Which mornings THIS signal may reason about. The mirror of softeningRelevant, and
// the same two kinds for the same reason:
//
//   • an ORDINARY easy morning — the read the athlete has been outrunning; and
//   • a morning this rule itself opened to train, which is the same evidence restated
//     under the new read and is what keeps it from self-extinguishing (once active, no
//     new easy mornings can accrue, so without this the window empties in ten days and
//     the read relapses on a cycle).
//
// A SOFTENED easy morning — a rest the rest-ladder already eased — is deliberately
// neither. It belongs to that ladder's evidence, and counting it here would compose the
// two into a single rest → train step that neither rule is allowed to take.
function easySofteningRelevant(day: ReadAdherenceDay): boolean {
  return (day.read === "easy" && !day.softened) || (day.read === "train" && day.easy_softened);
}

// Did the day go ABOVE easy? The same test readAdherenceOutcome holds an easy read to
// (`above_easy`), re-derived from the load the model already carries rather than
// re-queried — so "diverged from the easy read" and "counts as evidence here" cannot
// come apart. `trained` alone is deliberately not enough: a twenty-minute mobility
// flush satisfies "trained" and is exactly what an easy read asks for.
function wentAboveEasy(day: ReadAdherenceDay): boolean {
  return day.load === "hard" || day.load === "moderate";
}

// The bounded signal for `asOf`, read off a model the caller already holds. Pure with
// respect to the model plus the sessions table; safe to call with null.
export function easyOverrideSoftening(model: ReadAdherenceModel | null, asOf: string): EasyOverrideSoftening {
  if (!model || !Array.isArray(model.recent)) return NO_EASY_SOFTENING;
  const lastClosed = addDaysISO(asOf, -1);
  const from = addDaysISO(asOf, -OUTCOME_SOFTENING_WINDOW_DAYS);
  if (!lastClosed || !from) return NO_EASY_SOFTENING;
  const easyMornings = model.recent
    .filter((day) => day.date >= from && day.date <= lastClosed && easySofteningRelevant(day))
    .sort((a, b) => a.date.localeCompare(b.date));
  const lastHonoredEasy = easyMornings.filter((day) => !wentAboveEasy(day)).at(-1)?.date ?? null;
  const overriddenAndFine = easyMornings
    .filter((day) => wentAboveEasy(day) && (lastHonoredEasy == null || day.date > lastHonoredEasy))
    .map((day) => day.date)
    .filter(trainedWithoutHarm);
  return {
    active: overriddenAndFine.length >= OUTCOME_SOFTENING_MIN_DIVERGENCES,
    window_days: OUTCOME_SOFTENING_WINDOW_DAYS,
    overridden_and_fine: overriddenAndFine,
    last_honored_easy: lastHonoredEasy,
  };
}
