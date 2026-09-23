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
import { getEnduranceGoal, getEnduranceSchedule, isoDow } from "../profile.js";
import { withoutShadowActivities } from "../activity-shadow.js";
import { activeRecoveryWeek } from "../recovery-week.js";
import { peakLongKm } from "../run-ramp.js";
import { readinessBand, readsRestGradeReadiness, SUPPORTIVE_READINESS } from "../readiness-bands.js";
import { RECOVERY_BASELINE_MIN_POINTS } from "../baseline-bands.js";
import { sampleSd } from "../recovery-science.js";
import { recoveryTrendBars } from "../recovery-trend.js";
import { SENSOR_MAX_AGE_DAYS, isReadDayReadiness, sensorIsCurrent } from "../sensor-freshness.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "../shared.js";
import { currentTrainingDataVersion, registerTrainingCacheClear } from "../training-cache.js";
import { getTrainingIntent } from "../training-intent.js";
import {
  dayLoad,
  hardCardioDay,
  hardCardioDayIntense,
  longestRunNovelty,
  recentCardioLoadMedian,
  type TrainingLoad,
} from "../training-read.js";

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
  // A hand-logged shadow of a synced effort is one activity, not two, toward the
  // day's activity count (compared against a stored fingerprint downstream).
  const activityRows = withoutShadowActivities(
    db
      .prepare(`SELECT date, type, source, external_id, duration_min, distance_km FROM activities WHERE date = ? LIMIT 100`)
      .all(date) as Array<{
      date: string;
      type: string | null;
      source: string | null;
      external_id: string | null;
      duration_min: number | null;
      distance_km: number | null;
    }>
  );
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
  // Held in consts because the same two values are compared against the stored row
  // below, when a same-claim recompute reuses it (see "the ledger must say what the
  // athlete read").
  const ledgerSummary = String(read.headline || `${kind} day`).slice(0, 300);
  const ledgerRationale: string | null = typeof read.why === "string" ? read.why : null;
  const recorded = recordDecision(
    {
      effective_date: date,
      kind: "day_read",
      domain: "cross_domain",
      summary: ledgerSummary,
      rationale: ledgerRationale,
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

  // THE LEDGER MUST SAY WHAT THE ATHLETE READ.
  //
  // A same-claim recompute is an INSERT OR IGNORE above (deliberately — the day's
  // prediction must keep asking its question rather than being retired by a recompute
  // that reached the same conclusion). But the row then kept the FIRST wording of the
  // day while the day_reads cache kept the last, so provenance showed a sentence the
  // athlete never saw. The claim, the expectation and the morning `context` are all
  // untouched here: only the prose is brought up to what is on screen. No new row, no
  // supersede.
  if (recorded.decision.summary !== ledgerSummary || (recorded.decision.rationale ?? null) !== ledgerRationale) {
    try {
      db.prepare(`UPDATE brain_decisions SET summary = ?, rationale = ? WHERE id = ? AND status = 'observed'`).run(
        ledgerSummary,
        ledgerRationale,
        currentId
      );
    } catch {
      // Provenance polish is best-effort; the claim itself is already recorded.
    }
  }

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
  // Was this morning's read moved by the LONG loop (trainsAnywayWithoutHarm) — opened
  // to train, or eased from rest to easy? Keeps that loop's own mornings in its
  // evidence once it acts (see learnedQuietMorning). Optional: absent reads as false.
  learned_opened?: boolean;
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
  learnedOpened: boolean;
}

// ---------- WHICH READ THE ATHLETE ACTUALLY OPENED TO ----------
//
// THE LAST PREDICTIVE READ BEFORE THEY TRAINED — not the first read of the date.
//
// This used to take MIN(id): first write wins, on the reasoning that the earliest
// entry is the morning one. It is not. The scheduler recomputes the day at the
// midnight rollover, which lands at 04:00 UTC for an eastern athlete — hours before
// the morning's wearable sync, before last night's sleep is on the board, before any
// check-in. That first row is routinely superseded by the 08:xx recompute, and it is
// the LATTER the athlete opened the Brief to.
//
// Example case: decision 4102 written 04:01 UTC read `rest` and was
// superseded; decision 4104 written 08:16 UTC read `easy`; the session was created
// at 11:54 UTC. First-write-wins scored the day as a REST override, so it accrued to
// the rest ladder's evidence instead of the easy ladder's — and the easy ladder,
// the only thing allowed to open a stacked-days ceiling morning, stayed empty while
// the athlete overrode easy three mornings running.
//
// So the rule is: the last PREDICTIVE read written before the athlete's first
// training of that date, and if they never trained, the last predictive read of the
// date. The cutoff is training rather than a clock hour because that is the moment
// the read stopped being advice and became history — every recompute after it is
// commentary on work already done, and `done` (which most of them are) is not
// predictive anyway. Both timestamps are UTC 'YYYY-MM-DD HH:MM:SS' strings, so
// string order IS instant order.
//
// `context_json` still comes back off the CHOSEN row, and still for the reason it
// always did: that column is the state as of the write that created the row (an
// unchanged read is INSERT OR IGNORE — see recordDayReadDecision), so
// `signals.outcome_feedback.applied` on it is a faithful record of whether the read
// the athlete opened to had been softened. Reading the softening off the read
// itself, rather than recomputing it, is what keeps this free of a recursion back
// into restOverrideSoftening.

interface MorningDecisionRow {
  id: number;
  date: string;
  created_at: string;
  kind: PredictiveDayReadKind;
}

export interface MorningDecision extends MorningRead {
  id: number;
  // The read's own context blob, already parsed. `null` when the column was empty or
  // unparseable — never a partial object.
  context: Record<string, unknown> | null;
}

// The instant the athlete first TRAINED on each date in the range.
//
// A LOGGED SET is the primary source, and the session row is only a fallback —
// which is the opposite of how this read first shipped, and the reason it is
// worth the comment. `sessions.created_at` is when the ROW was created, and a
// session row exists long before any work does: accepting a composed session from
// the Brief creates one (repo/adaptive-session.ts), so does rating soreness or
// performance, so does skipping an exercise (repo/sessions.ts). The live shape
// this misreads is the ordinary one — open the Brief at 06:30, tap "ask for a
// session", lift at 11:54. Taking the row's stamp put the cutoff at 06:30, threw
// away the 08:16 recompute the athlete actually opened to, and handed the ladder
// back the superseded 04:01 rest read: exactly the bug the cutoff exists to fix.
//
// The fallback is narrow on purpose: a date whose session carries NO sets at all
// (they rated it, or skipped their way through it) has no set instant to use, and
// the row's own stamp is then the closest thing to a training instant that exists.
//
// A run-only day gets no cutoff, and deliberately keeps the pre-existing behavior
// (the last predictive read of the date wins). Neither cardio table carries an
// instant this comparison can trust: `activities.created_at` is when the sync
// IMPORTED the run — the scheduler backfills yesterday's runs at the rollover, so
// it is routinely hours or days off the effort — and `garmin_activities.start_time`
// is the watch's `startTimeLocal` when it has one and `startTimeGMT` when it does
// not (src/garmin.ts), so its zone is unknowable while every stamp compared here is
// UTC. An unknowable instant is worse than no cutoff: it would silently shift the
// boundary by the UTC offset and exclude real morning reads. Sets stay the signal.
function firstTrainingInstantByDate(from: string, to: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const rows = db
      .prepare(
        `SELECT s.date AS date, MIN(ls.created_at) AS first_at
           FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
          WHERE s.date >= ? AND s.date <= ? AND ls.created_at IS NOT NULL
          GROUP BY s.date`
      )
      .all(from, to) as Array<{ date: string; first_at: string | null }>;
    for (const row of rows) if (row.first_at) out.set(String(row.date), String(row.first_at));
  } catch {
    /* an unreadable logged_sets table means no cutoff, not a wrong one */
  }
  try {
    const rows = db
      .prepare(
        `SELECT s.date AS date, MIN(s.created_at) AS first_at
           FROM sessions s
          WHERE s.date >= ? AND s.date <= ? AND s.created_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.session_id = s.id)
          GROUP BY s.date`
      )
      .all(from, to) as Array<{ date: string; first_at: string | null }>;
    for (const row of rows) {
      if (!row.first_at) continue;
      const date = String(row.date);
      if (!out.has(date)) out.set(date, String(row.first_at));
    }
  } catch {
    /* same contract */
  }
  return out;
}

// The chosen decision per date, context parsed. Deliberately two queries: the first
// scans only the small `action_json`/`created_at` columns to pick a row per date, and
// only the winners' `context_json` (a large signals blob, and there can be a dozen
// rows per date on a churny day) is ever read or parsed.
function morningDecisionsByDate(from: string, to: string): Map<string, MorningDecision> {
  const rows = db
    .prepare(
      `SELECT id, source_ref_key AS date, created_at, action_json
         FROM brain_decisions
        WHERE kind = 'day_read' AND source_ref_type = 'day_read'
          AND source_ref_key >= ? AND source_ref_key <= ?
        ORDER BY source_ref_key, created_at, id`
    )
    .all(from, to) as Array<{
    id: number;
    date: string;
    created_at: string | null;
    action_json: string | null;
  }>;
  const byDate = new Map<string, MorningDecisionRow[]>();
  for (const row of rows) {
    let kind: unknown = null;
    try {
      kind = JSON.parse(String(row.action_json ?? "null"))?.kind;
    } catch {
      kind = null;
    }
    if (!isPredictiveDayReadKind(kind)) continue;
    const date = String(row.date);
    const list = byDate.get(date) ?? [];
    list.push({ id: Number(row.id), date, created_at: String(row.created_at ?? ""), kind });
    byDate.set(date, list);
  }

  const trained = firstTrainingInstantByDate(from, to);
  const chosen = new Map<string, MorningDecisionRow>();
  for (const [date, list] of byDate) {
    const cutoff = trained.get(date) ?? null;
    // `<=`, not `<`: these stamps are second-granular, so a read and a set written in
    // the same second cannot be ordered, and the morning read is overwhelmingly the
    // earlier writer of the two.
    const before = cutoff ? list.filter((row) => row.created_at <= cutoff) : list;
    // Nothing before the first set means every predictive read of the day is
    // commentary on finished work. The earliest of them is then the closest thing to
    // a morning read that exists, which is also what the old first-write rule picked.
    chosen.set(date, before.at(-1) ?? list[0]!);
  }

  const out = new Map<string, MorningDecision>();
  if (chosen.size === 0) return out;
  const ids = [...chosen.values()].map((row) => row.id);
  const contexts = new Map<number, Record<string, unknown> | null>();
  const contextRows = db
    .prepare(
      `SELECT id, context_json FROM brain_decisions WHERE id IN (${ids.map(() => "?").join(",")})`
    )
    .all(...ids) as Array<{ id: number; context_json: string | null }>;
  for (const row of contextRows) {
    let context: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(String(row.context_json ?? "null"));
      context = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      context = null;
    }
    contexts.set(Number(row.id), context);
  }
  for (const [date, row] of chosen) {
    const context = contexts.get(row.id) ?? null;
    const signals = (context as any)?.signals;
    out.set(date, {
      id: row.id,
      kind: row.kind,
      softened: signals?.outcome_feedback?.applied === true,
      easySoftened: signals?.easy_outcome_feedback?.applied === true,
      learnedOpened: signals?.learned_train_anyway?.applied === true,
      context,
    });
  }
  return out;
}

function morningReadsByDate(from: string, to: string): Map<string, MorningRead> {
  const out = new Map<string, MorningRead>();
  for (const [date, decision] of morningDecisionsByDate(from, to)) {
    out.set(date, {
      kind: decision.kind,
      softened: decision.softened,
      easySoftened: decision.easySoftened,
      learnedOpened: decision.learnedOpened,
    });
  }
  return out;
}

// The single morning read for one date, off the same source the rolling model reads.
// Exported for callers that only need one day (morningReview,
// src/repo/brain/morning-review.ts) so they consume this module's own read of "what
// was the athlete actually told" rather than re-deriving it against `day_reads` or
// `suggestions` (see the comment above for why both of those answer a different
// question).
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
// `recentDays` bounds the per-day list the model hands back (the Brief and the prompt
// read the last fortnight); the long loop asks for its whole window.
export function readAdherenceModel(
  asOf: string = localDateISO(),
  windowDays = 42,
  recentDays = 14
): ReadAdherenceModel {
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
      learned_opened: morning.learnedOpened,
    });
  }

  return {
    as_of: asOf,
    window_days: days,
    days_observed: recent.length,
    by_read: READ_ORDER.map((read) => stats.get(read)!).filter((stat) => stat.days > 0),
    recent: recent.slice(-Math.max(1, Math.trunc(recentDays) || 14)),
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
  // The mornings inside the window the athlete trained through with nothing saying it
  // cost them — not their session rating, not the day's own cardio grade, not the next
  // morning's physiology (see harmEvidenceOnDay). Newest last. Both kinds count — see
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

// ---------- HARM INCLUDES THE BODY'S RESPONSE (owner ruling, 2026-08-28) ----------
//
// This question used to have exactly one answer: `sessions.performance`, the
// athlete's own 1-5 read of how a lifted session went. That made a whole shape of
// day invisible. A RUN has no session row, so a run-only divergence arrived
// unrated — and unrated reads as fine, on purpose, because silence about a lifted
// session is not evidence of harm. The live consequence: the athlete's longest run
// ever, 51 of 59 minutes at threshold, followed by a readiness reading of 1/100,
// counted as three-for-three "overrode it and was fine" and softened the next
// morning's read into another run.
//
// So harm now has four faces, and the physiological ones do not need a rating:
//   • RATED POORLY   — the old test, unchanged. The WORST session of the day decides,
//                      so one good lift cannot paper over a second that went badly.
//   • HARD CARDIO    — the day's cardio graded hard ON INTENSITY EVIDENCE
//                      (`hardCardioDayIntense`: a hard training-effect/label, real
//                      time at Z4+, or a training load well above their own median),
//                      UNLESS the next morning positively vouches that the body
//                      absorbed it (see nextMorningAbsorbedIt). A threshold effort is
//                      a cost whether or not anything asked them to rate it, but not
//                      when the morning after says otherwise out loud. The plain
//                      `hardCardioDay` duration bar is deliberately NOT harm here —
//                      an ordinary 45-minute easy run is a loading day, not an injury.
//   • A FIRST        — the longest run in months (`longestRunNovelty`). Novel stimulus.
//   • THE NEXT MORNING — a FRESH rest-grade readiness reading, or that night's HRV or
//                      resting HR past the athlete's OWN band, charged once per
//                      episode (see PERSONAL_BAND_DAYS below). This is the body
//                      answering; it outranks the absence of a rating.
//
// What has NOT changed is the direction of absence. No rating, no wearable, no run
// — no harm. Every arm here needs POSITIVE evidence, freshness included, and every
// failure path returns "no harm found" rather than manufacturing one.

// ---------- THE BODY'S ANSWER IS READ AGAINST THIS ATHLETE, ONCE PER EPISODE ----------
// (2026-09-23.) The overnight arms used to read two stand-ins: Garmin's `hrv_status`
// word, and resting HR five beats over the row's own `hr_7d_avg`. The status word is a
// SEVEN-DAY verdict, so one dip read LOW three mornings running
// and was charged as three separate harms to three different training days; and the
// 7-day HR column is not even always a resting figure (it can read near 70 bpm against
// a resting HR in the low fifties).
//
// So each overnight reading is now judged against the athlete's OWN nights: the
// readings in the PERSONAL_BAND_DAYS before that morning, needing
// RECOVERY_BASELINE_MIN_POINTS of them (the same floor their visible "usual range"
// uses). One night is judged by one of THEIR standard deviations — never narrower than
// recoveryTrendBars, the one answer to "is this drift meaningful for this person" —
// because a single night is noisier than the medians those bars were written for. Only
// the night dated the morning itself may speak for it — the one-night law isLastNight
// states for sleep: the training day's own morning is not its answer.
//
// And a brake is charged only at its ONSET. When the reading before it (the training
// day's own morning, or the newest one within the signal's age bound) already sat past
// the same band, the dip was there before the work and the work did not cause it — the
// episode is charged once, to the day it began after.
//
// With too few nights for a band, the watch's own personal-baseline verdicts stand in,
// under the same onset rule: its status word, and resting HR over its 7-day figure.
const PERSONAL_BAND_DAYS = 28;
// Fallback only (no personal band yet). Five beats is the conventional "something is
// going on" step and is well clear of night-to-night noise.
const RESTING_HR_BRAKE_DELTA_BPM = 5;
// Fallback only: the HRV verdicts the watch itself calls bad, read as a WORD.
const HRV_BRAKE_STATUSES: ReadonlySet<string> = new Set(["low", "poor"]);

export type HarmEvidenceKind =
  | "rated_poorly"
  | "hard_cardio"
  | "longest_run"
  | "readiness_rest_grade"
  | "physiology_brake";

export interface HarmEvidence {
  // The day the work happened on.
  date: string;
  kind: HarmEvidenceKind;
  // Machine register — provenance for the ledger and the coach context, never
  // rendered to the athlete as-is.
  detail: string;
}

// ---------- WHAT "READINESS ON A MORNING" MEANS ----------
//
// `garmin_daily_metrics.training_readiness` is the LAST value synced for that date,
// not a morning one. The watch recomputes readiness through the day, so on any date
// the athlete trains, the stored number is a POST-WORKOUT reading: it says what the
// session cost, not what the morning offered.
//
// Example case: a row holds training_readiness 11, synced after that day's
// 10.4 km run — and read as "the morning after" the previous day it marked a Full
// Body session the athlete rated 5/5 as harmful.
//
// So the morning value is taken from the LEDGER first: the day's own morning read
// (chosen exactly as morningDecisionsByDate chooses it) recorded the readiness the
// brain actually saw when it made the call, in `signals.fatigue.readiness`. That
// snapshot is used only when it is about the right date and the read itself called
// it fresh. Failing that, the Garmin row is honest ONLY on a date carrying no
// training at all; on a training date the morning value is simply unknowable, and
// unknowable is absent, never a brake and never reassurance.
// `Number(null)` is 0, not NaN — the trap that has already read an unrated session as
// the worst possible one elsewhere in this file. A readiness column is null far more
// often than it is zero, and 0 is inside the rest-grade band, so absence must be
// tested before the coercion, never after it.
function readingNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ledgerMorningReadiness(morning: string): number | null {
  let decision: MorningDecision | undefined;
  try {
    decision = morningDecisionsByDate(morning, morning).get(morning);
  } catch {
    return null;
  }
  const readiness = (decision?.context as any)?.signals?.fatigue?.readiness;
  if (!readiness || typeof readiness !== "object") return null;
  if (String(readiness.current_date ?? "") !== morning) return null;
  if (String(readiness.freshness ?? "") !== "fresh") return null;
  return readingNumber(readiness.current);
}

// ---------- A RECOMPUTE AFTER TRAINING READS THE MORNING'S READINESS ----------
//
// The watch keeps recomputing readiness through the day and the row keeps the LAST
// sync, so once the athlete has trained, today's row is the post-workout number: the
// ~16:00 recompute read "readiness is low" off the session it was describing. The
// morning is the ledger's own snapshot of it (ledgerMorningReadiness — the last
// predictive read before the first logged set). So when `date` has training on it and
// the summary's readiness is dated `date`, that snapshot replaces it; with no snapshot
// the reading is ABSENT, never the afternoon value. Anything else passes through
// untouched — a d-1 row is already refused by isReadDayReadiness downstream.
// "Trained" is WORK logged — a set or an activity — never a bare session row, which
// accepting the Brief's session creates before a single rep (see
// firstTrainingInstantByDate) and which would hide a genuine 07:00 reading.
export function withMorningReadiness<T>(rec: T, date: string): T {
  const summary = rec as any;
  const quality = summary?.quality?.training_readiness ?? summary?.recovery?.quality?.training_readiness;
  if (!summary?.recovery || String(quality?.latest_date ?? "") !== date || !workLoggedOn(date)) return rec;
  const morning = ledgerMorningReadiness(date);
  const patchedQuality = {
    ...quality,
    latest_value: morning,
    latest_date: morning == null ? null : date,
    freshness: morning == null ? "missing" : quality.freshness,
  };
  const qualityMap = (map: any) => (map ? { ...map, training_readiness: patchedQuality } : map);
  return {
    ...summary,
    quality: qualityMap(summary.quality),
    recovery: {
      ...summary.recovery,
      training_readiness: morning,
      readiness_band: readinessBand(morning),
      quality: qualityMap(summary.recovery.quality),
    },
  } as T;
}

function workLoggedOn(date: string): boolean {
  const exists = (sql: string): boolean => {
    try {
      return !!db.prepare(sql).get(date);
    } catch {
      return false;
    }
  };
  return (
    exists(`SELECT 1 FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id WHERE s.date = ? LIMIT 1`) ||
    exists(`SELECT 1 FROM activities WHERE date = ? LIMIT 1`) ||
    exists(`SELECT 1 FROM garmin_activities WHERE date = ? LIMIT 1`)
  );
}

// Did the athlete train on this date at all — lifted, or logged any activity? The
// question is only ever "may the stored Garmin readiness be read as a morning value",
// so any training of any shape disqualifies it.
function trainedOnDate(date: string): boolean {
  const exists = (sql: string): boolean => {
    try {
      return !!db.prepare(sql).get(date);
    } catch {
      // An unreadable table cannot vouch that the day was quiet.
      return true;
    }
  };
  return (
    exists(`SELECT 1 FROM sessions WHERE date = ? LIMIT 1`) ||
    exists(`SELECT 1 FROM activities WHERE date = ? LIMIT 1`) ||
    exists(`SELECT 1 FROM garmin_activities WHERE date = ? LIMIT 1`)
  );
}

// ---------- ONE ANSWER PER MORNING, NOT TEN ----------
//
// `trainedWithoutHarm` is asked per day across a ten-day window by BOTH softening
// ladders and again by morning-review's streak walk, and each ask used to rebuild the
// same three lookups from scratch: `nextMorningAbsorbedIt` read the morning's
// readiness, then called `nextMorningPhysiologyBrake`, which read it again, and
// `harmEvidenceOnDay` then called that brake a third time — with every readiness read
// running the ledger decision query, the three trained-on-date probes and the wearable
// row underneath it. Same date, same database, same answer, ~10x the statements.
//
// So the three pure per-date reads memoize. They are keyed on the training-data
// version every production write bumps (the sibling memos in lift-comparability and
// program-state fold in the same counter), and the registered clear is the backstop
// for the test isolate, which wipes tables out of band and resets the counter to zero
// so a version match alone cannot be trusted there.
//
// A morning that is not yet CLOSED is never cached. The one input this counter does
// not see is a fresh `brain_decisions` row, and the only morning whose ledger read
// realistically moves inside one process is today's — the scheduler recomputing the
// current day. Bounding the memo to past mornings makes that unreachable, and past
// mornings are the entire hot path (both ladders and the streak walk look backwards).
let readinessMemo = new Map<string, number | null>();
let metricsRowMemo = new Map<string, any>();
let brakeMemo = new Map<string, HarmEvidence | null>();
let physiologyMemo = new Map<string, OvernightPhysiology>();
let memoVersion = currentTrainingDataVersion();
registerTrainingCacheClear(() => {
  readinessMemo = new Map();
  metricsRowMemo = new Map();
  brakeMemo = new Map();
  physiologyMemo = new Map();
  memoVersion = currentTrainingDataVersion();
});

function memoFor<T>(store: Map<string, T>, morning: string, compute: () => T): T {
  const version = currentTrainingDataVersion();
  if (version !== memoVersion) {
    readinessMemo = new Map();
    metricsRowMemo = new Map();
    brakeMemo = new Map();
    physiologyMemo = new Map();
    memoVersion = version;
  }
  // Only closed mornings are cacheable — see above.
  if (morning >= localDateISO()) return compute();
  if (store.has(morning)) return store.get(morning) as T;
  const value = compute();
  store.set(morning, value);
  return value;
}

// The newest wearable row that may speak for `morning`. Per-field freshness is still
// asked individually by each caller.
function morningMetricsRow(morning: string): any {
  return memoFor(metricsRowMemo, morning, () => morningMetricsRowUncached(morning));
}

function morningMetricsRowUncached(morning: string): any {
  // Reach back only as far as the loosest bound any field here uses.
  const floor = addDaysISO(morning, -Math.max(SENSOR_MAX_AGE_DAYS.hrv, SENSOR_MAX_AGE_DAYS.resting_hr));
  if (!floor) return null;
  try {
    return (
      db
        .prepare(
          `SELECT date, training_readiness, hrv_status, resting_hr, hr_7d_avg
           FROM garmin_daily_metrics
          WHERE date >= ? AND date <= ?
            AND (training_readiness IS NOT NULL OR hrv_status IS NOT NULL OR resting_hr IS NOT NULL)
          ORDER BY date DESC, id DESC LIMIT 1`
        )
        .get(floor, morning) ?? null
    );
  } catch {
    return null;
  }
}

// The readiness `morning` actually opened with, or null when that is unknowable.
// The ONE lookup both the physiology brake and the hard-cardio absorption test use,
// so the two cannot disagree about what the body said.
function morningReadiness(morning: string): number | null {
  return memoFor(readinessMemo, morning, () => morningReadinessUncached(morning));
}

function morningReadinessUncached(morning: string): number | null {
  const fromLedger = ledgerMorningReadiness(morning);
  if (fromLedger != null) return fromLedger;
  if (trainedOnDate(morning)) return null;
  const row = morningMetricsRow(morning);
  if (!row) return null;
  const readingDate = row.date == null ? null : String(row.date);
  // Only the morning's OWN row: an earlier one is that day's post-workout last sync.
  if (!isReadDayReadiness(readingDate, morning)) return null;
  return readingNumber(row.training_readiness);
}

// The morning after `date`, read for the body's answer. Returns the first brake it
// finds, or null. Freshness is asked through sensor-freshness (a reading that is too
// old to speak for that morning behaves as absent, never as reassurance and never as
// a brake), and a morning that has not happened yet simply has no row. The HRV and
// resting-HR arms read the wearable row directly and always have: both are OVERNIGHT
// measurements, so unlike readiness they do not drift with the next day's training.
function nextMorningPhysiologyBrake(date: string): HarmEvidence | null {
  const morning = addDaysISO(date, 1);
  if (!morning) return null;
  // Keyed by the MORNING, which is what the answer is about — `date` only names the
  // day the brake is being attributed to, and the returned evidence carries it.
  const found = memoFor(brakeMemo, morning, () => nextMorningPhysiologyBrakeUncached(date, morning));
  return found ? { ...found, date } : null;
}

function nextMorningPhysiologyBrakeUncached(date: string, morning: string): HarmEvidence | null {
  const readiness = morningReadiness(morning);
  if (readiness != null && readsRestGradeReadiness(readiness)) {
    return {
      date,
      kind: "readiness_rest_grade",
      detail: `readiness ${readiness} on ${morning}`,
    };
  }
  // The overnight arms charge only an ONSET (see PERSONAL_BAND_DAYS above).
  const overnight = overnightPhysiology(morning);
  const onset = overnight.hrv?.onset ? overnight.hrv : overnight.rhr?.onset ? overnight.rhr : null;
  return onset ? { date, kind: "physiology_brake", detail: onset.detail } : null;
}

// ---------- the overnight arms, per morning ----------
interface OvernightArm {
  // Machine register provenance ("hrv 38 below own band 41 on …").
  detail: string;
  // False when the reading before it already sat past the same line: the episode
  // started earlier, so this morning is its continuation, not news about yesterday.
  onset: boolean;
}

interface OvernightPhysiology {
  hrv: OvernightArm | null;
  rhr: OvernightArm | null;
}

interface OvernightNight {
  hrv_ms: number | null;
  resting_hr: number | null;
  hrv_status: string | null;
  hr_7d_avg: number | null;
}

function overnightPhysiology(morning: string): OvernightPhysiology {
  return memoFor(physiologyMemo, morning, () => overnightPhysiologyUncached(morning));
}

// The athlete's nights up to `morning`, Garmin preferred per field per date (the same
// precedence getRecoveryBaselineRead uses), in ONE statement — this runs inside the
// harm test every softening ladder asks per day, so it is kept to a single read.
function overnightNights(from: string, to: string): Map<string, OvernightNight> {
  const byDate = new Map<string, OvernightNight>();
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT 0 AS pref, date, hrv_ms, resting_hr, hrv_status, hr_7d_avg FROM garmin_daily_metrics
          WHERE date >= ? AND date <= ?
         UNION ALL
         SELECT 1 AS pref, date, hrv_ms, resting_hr, NULL AS hrv_status, NULL AS hr_7d_avg FROM daily_metrics
          WHERE date >= ? AND date <= ?
         ORDER BY pref`
      )
      .all(from, to, from, to) as any[];
  } catch {
    return byDate;
  }
  const positive = (value: unknown): number | null => {
    const n = readingNumber(value);
    return n != null && n > 0 ? n : null;
  };
  for (const row of rows) {
    const date = String(row.date ?? "").slice(0, 10);
    if (!date) continue;
    const night = byDate.get(date) ?? { hrv_ms: null, resting_hr: null, hrv_status: null, hr_7d_avg: null };
    night.hrv_ms ??= positive(row.hrv_ms);
    night.resting_hr ??= positive(row.resting_hr);
    night.hrv_status ??= row.hrv_status == null || row.hrv_status === "" ? null : String(row.hrv_status).toLowerCase();
    night.hr_7d_avg ??= positive(row.hr_7d_avg);
    byDate.set(date, night);
  }
  return byDate;
}

// The line one night has to cross to count, off the athlete's own nights before
// `morning`: their mean, less (HRV) or plus (resting HR) one of their own standard
// deviations, never narrower than recoveryTrendBars. Null below the band's floor.
function personalLine(
  nights: Map<string, OvernightNight>,
  field: "hrv_ms" | "resting_hr",
  morning: string
): number | null {
  const values: number[] = [];
  for (const [date, night] of nights) {
    const value = night[field];
    if (date < morning && value != null) values.push(value);
  }
  return personalBand(values, field)?.line ?? null;
}

/**
 * The athlete's OWN band for one overnight field, from their own earlier readings: the
 * mean, and the line one night has to cross to count (mean less — HRV — or plus —
 * resting HR — one of their own standard deviations, never narrower than
 * recoveryTrendBars). Null below RECOVERY_BASELINE_MIN_POINTS. The one formula the harm
 * arms and the run morning read (run-day-intensity.ts) both charge a night against.
 */
export function personalBand(
  values: readonly number[],
  field: "hrv_ms" | "resting_hr"
): { mean: number; line: number } | null {
  if (values.length < RECOVERY_BASELINE_MIN_POINTS) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = sampleSd([...values]) ?? 0;
  const bars = recoveryTrendBars({ hrv: mean, rhr: mean });
  return { mean, line: field === "hrv_ms" ? mean - Math.max(bars.hrv, sd) : mean + Math.max(bars.rhr, sd) };
}

function overnightPhysiologyUncached(morning: string): OvernightPhysiology {
  const none: OvernightPhysiology = { hrv: null, rhr: null };
  const lookback = Math.max(SENSOR_MAX_AGE_DAYS.hrv, SENSOR_MAX_AGE_DAYS.resting_hr);
  const from = addDaysISO(morning, -(PERSONAL_BAND_DAYS + lookback));
  if (!from) return none;
  const nights = overnightNights(from, morning);
  // Only the night dated the morning itself answers for the day before it.
  const tonight = nights.get(morning);
  if (!tonight) return none;
  // The newest earlier reading of a field that may still speak for `morning` — the
  // other end of the episode test.
  const before = (field: keyof OvernightNight, signal: "hrv" | "resting_hr"): OvernightNight | null => {
    let found: { date: string; night: OvernightNight } | null = null;
    for (const [date, night] of nights) {
      if (date >= morning || night[field] == null || !sensorIsCurrent(signal, date, morning)) continue;
      if (!found || date > found.date) found = { date, night };
    }
    return found?.night ?? null;
  };

  let hrv: OvernightArm | null = null;
  const hrvLine = personalLine(nights, "hrv_ms", morning);
  if (hrvLine != null) {
    if (tonight.hrv_ms != null && tonight.hrv_ms < hrvLine) {
      const prior = before("hrv_ms", "hrv")?.hrv_ms ?? null;
      hrv = {
        detail: `hrv ${Math.round(tonight.hrv_ms)} below own band ${hrvLine.toFixed(1)} on ${morning}`,
        onset: !(prior != null && prior < hrvLine),
      };
    }
  } else if (tonight.hrv_status && HRV_BRAKE_STATUSES.has(tonight.hrv_status)) {
    const prior = before("hrv_status", "hrv")?.hrv_status ?? null;
    hrv = {
      detail: `hrv status ${tonight.hrv_status} on ${morning}`,
      onset: !(prior != null && HRV_BRAKE_STATUSES.has(prior)),
    };
  }

  let rhr: OvernightArm | null = null;
  const rhrLine = personalLine(nights, "resting_hr", morning);
  if (rhrLine != null) {
    if (tonight.resting_hr != null && tonight.resting_hr > rhrLine) {
      const prior = before("resting_hr", "resting_hr")?.resting_hr ?? null;
      rhr = {
        detail: `resting hr ${Math.round(tonight.resting_hr)} above own band ${rhrLine.toFixed(1)} on ${morning}`,
        onset: !(prior != null && prior > rhrLine),
      };
    }
  } else if (
    tonight.resting_hr != null &&
    tonight.hr_7d_avg != null &&
    tonight.resting_hr >= tonight.hr_7d_avg + RESTING_HR_BRAKE_DELTA_BPM
  ) {
    const earlier = before("resting_hr", "resting_hr");
    const continuing =
      earlier?.resting_hr != null &&
      earlier.hr_7d_avg != null &&
      earlier.resting_hr >= earlier.hr_7d_avg + RESTING_HR_BRAKE_DELTA_BPM;
    rhr = {
      detail: `resting hr ${Math.round(tonight.resting_hr)} vs 7-day ${Math.round(tonight.hr_7d_avg)} on ${morning}`,
      onset: !continuing,
    };
  }
  return { hrv, rhr };
}

// ---------- A HARD EFFORT THE BODY ABSORBED IS NOT A COST ----------
//
// The hard-cardio arm reads INTENSITY BARS ONLY — a hard training-effect label, real
// time at Z4+, a load above the athlete's own median. Those describe the stimulus,
// and a stimulus is not by itself an injury: the whole point of a fit athlete is that
// some hard days cost them nothing.
//
// Example case: a Push session (13 sets, soreness 2) plus a 4.5 km run carrying
// 13.6 minutes in Z4. The next morning readiness read 75-78, HRV sat 49 ms above the
// athlete's own norm and resting HR came in at 53 against a seven-day 55 — every
// available signal saying the body took it. Counted as harm anyway, it was one of
// the three days keeping the easy ladder shut.
//
// So the day is retired ONLY on POSITIVE next-morning evidence, both halves required:
// a morning readiness that is knowable, fresh and at or above SUPPORTIVE_READINESS,
// AND no physiology brake firing for that morning at all. Absent or stale data is not
// a vouch — silence never speaks for the body, in either direction, so an unknowable
// morning leaves the day as harm exactly as before. That is what keeps the two
// counter-cases counting: one day's 9.85 km at 164 bpm avg into a readiness of 26 the
// next morning, and another day's 10.4 km into a 38.
//
// The other arms are untouched and keep their precedence. A poorly rated session and
// a novel longest run are both facts about the day itself, and no next morning can
// argue either of them away.
function nextMorningAbsorbedIt(date: string): boolean {
  const morning = addDaysISO(date, 1);
  if (!morning) return false;
  const readiness = morningReadiness(morning);
  if (readiness == null || readiness < SUPPORTIVE_READINESS) return false;
  // "No brake at all" means the RAW overnight read, not the onset-only charge: a dip
  // that began before the work is not news about the day, but it is not a vouch either.
  const overnight = overnightPhysiology(morning);
  return nextMorningPhysiologyBrake(date) == null && !overnight.hrv && !overnight.rhr;
}

// ---------- THE BUILD'S OWN PRESCRIPTION IS NOT HARM ----------
//
// Of 19 days trained against the read (08-20..09-20), 8 were flagged by the race build's
// own prescription: the Saturday/Sunday longest run a half-marathon build exists to
// grow, and the stated quality day's hard effort. Counting those as cost kept the easy
// ladder shut on the plan working as written. What the athlete stated
// (`endurance_schedule`) says which weekday carries which dose; the race build's
// long-run ceiling (`peakLongKm` — the longest run the build climbs to) bounds a planned
// long run. Outside a dated race build there is no build ceiling, so the arm stands.
function plannedDoseOn(date: string): { long: boolean; quality: boolean; long_ceiling_km: number | null } {
  const none = { long: false, quality: false, long_ceiling_km: null };
  try {
    const days = getEnduranceSchedule()?.days ?? [];
    if (!days.length) return none;
    const dow = isoDow(date);
    const kinds = new Set(days.filter((day) => day.dow === dow).map((day) => day.kind));
    const goal = getEnduranceGoal(date);
    const distance = Number(goal?.distance_km);
    const building = goal?.is_race === true && goal.phase !== "past" && distance > 0;
    return {
      long: kinds.has("long"),
      quality: kinds.has("quality"),
      long_ceiling_km: building ? peakLongKm(distance) : null,
    };
  } catch {
    return none;
  }
}

// Did the work logged on `date` show any sign of having cost them, and if so which
// evidence says so? Null means "nothing says it cost them" — which includes an
// unrated lifting day, deliberately. Exported so the reads that consult it can carry
// the provenance instead of a bare boolean.
export function harmEvidenceOnDay(date: string): HarmEvidence | null {
  try {
    const row = db
      .prepare(`SELECT MIN(performance) AS worst FROM sessions WHERE date = ? AND performance IS NOT NULL`)
      .get(date) as { worst?: number | null } | undefined;
    // An aggregate ALWAYS returns a row, so an unrated day arrives as `worst: null`
    // — and `Number(null)` is 0, not NaN, which read every unrated session as the
    // worst possible one and made the common case (they log the work, they don't
    // rate it) permanently unreachable. Test the absence before coercing.
    if (row?.worst != null) {
      const worst = Number(row.worst);
      if (Number.isFinite(worst) && worst < NO_HARM_PERFORMANCE) {
        return { date, kind: "rated_poorly", detail: `performance ${worst}` };
      }
    }
  } catch {
    /* an unreadable sessions table is not evidence of harm */
  }
  try {
    const planned = plannedDoseOn(date);
    const novelty = longestRunNovelty(date);
    // A longest run the race build is climbing toward, on the athlete's own long-run
    // day, is the build's DOSE, not news about the body: only the next morning below
    // can say it cost them. A run past the build's ceiling, or on another day, stays.
    const plannedLong =
      planned.long && planned.long_ceiling_km != null && (novelty == null || novelty.distance_km <= planned.long_ceiling_km);
    if (novelty && !plannedLong) {
      return {
        date,
        kind: "longest_run",
        detail: `${novelty.distance_km} km vs ${novelty.previous_longest_km} km best`,
      };
    }
    // Intensity-evidenced hard ONLY (bars a-c). `hardCardioDay`'s duration bar (d)
    // grades any run ≥ 40 min as hard, so a routine 45-minute easy Z2 jog would count
    // as harm and this ladder would never activate for someone who simply runs. A
    // duration-only hard grade is not harm by itself; if the body disagreed, the
    // next-morning physiology arm below says so.
    //
    // And a hard effort the body ABSORBED is not a cost either (see below): a
    // vouching next morning retires this arm, and only this arm.
    // Hard on the stated QUALITY day is what that day is for, and a planned long run
    // grades hard on load by being long — same rule, judged by the next morning only.
    if (!planned.quality && !plannedLong && hardCardioDayIntense(date) && !nextMorningAbsorbedIt(date))
      return { date, kind: "hard_cardio", detail: "cardio graded hard on intensity" };
  } catch {
    /* same contract: a failed read finds no harm, it does not invent one */
  }
  try {
    return nextMorningPhysiologyBrake(date);
  } catch {
    return null;
  }
}

// The boolean form, kept as the name every existing caller uses (restOverrideSoftening,
// easyOverrideSoftening, and morningReview — which asks the same question about a
// single divergence rather than a rolling window of them).
export function trainedWithoutHarm(date: string): boolean {
  return harmEvidenceOnDay(date) == null;
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
// (An easy morning the LONG loop eased from rest — `learned_opened` on an easy read —
// is the same fact as a softened one and is counted the same way, here and below.)
function softeningRelevant(day: ReadAdherenceDay): boolean {
  return day.read === "rest" || (day.read === "easy" && (day.softened || day.learned_opened === true));
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
  // The easy mornings inside the window the athlete took ABOVE easy with nothing saying
  // it cost them — the same four-faced test the rest ladder uses
  // (harmEvidenceOnDay). Newest last.
  overridden_and_fine: string[];
  // The most recent morning they actually kept at or under easy when a quiet-ish read
  // asked them to. Everything on or before it is discarded — agreeing with the read
  // starts the count over.
  last_honored_easy: string | null;
}

export interface EasyOutcomeFeedbackSignal extends EasyOverrideSoftening {
  applied: boolean;
  // The athlete said something about THIS morning — a run-down or sore check-in, a
  // symptom they reported today — and that newer word held the softening shut. Written
  // only when the pattern would otherwise have opened the day, so it reads as "what
  // stopped this", never as a standing note about the check-in.
  held_by_statement?: FreshStatementField;
}

// Which same-day statement held a softening. Their own words, by kind — the four
// shapes the athlete can put on record about the morning being read.
export type FreshStatementField = "felt_energy" | "felt_soreness" | "sleep_feel" | "symptom_report";

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
  return (
    (day.read === "easy" && !day.softened && day.learned_opened !== true) ||
    (day.read === "train" && day.easy_softened)
  );
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

// ---------- the LONG learning: "you train anyway, and it costs you nothing" ----------
//
// The two ladders above each move a read ONE rung on ten days of evidence. They are the
// short loop. This is the long one (owner ruling, 2026-09-22): over six weeks the
// athlete trained through 17 of 22 rest reads and 31 of 38 easy reads, and the learning
// that said so was prose only — "never what it's allowed to say". Which reads are
// non-floor is the caller's question (day-read.ts keeps every health, safety,
// rest-grade, injury and acute-gate floor out of it); this only answers how much the
// evidence weighs.
//
// ---- a WEIGHT, not a cliff (2026-09-23) ----
// It shipped as one conjunction — two thirds trained through AND three in four clean
// AND the newest clean — and could miss by a single day (14 × 4 = 56 < 57): nineteen
// overrides, fourteen of them at no cost, counted exactly as much as none. So the evidence is now a continuous weight:
//
//     weight = (trained through ÷ (quiet mornings + PRIOR)) × (clean ÷ (trained through + PRIOR))
//
// every morning weighted by recency (half-life LEARNED_TRAIN_HALF_LIFE_DAYS, so last
// week's cost counts about twice what a month-old one does — which is what the old
// "newest clean" clause was reaching for, without the cliff). PRIOR is a pair of
// imagined mornings the athlete honored, so a thin record is pulled toward zero rather
// than read at face value. More harm-free overrides → a heavier weight → a quieter read
// moves further (learnedQuietStep). Below the small-sample floor — fewer than
// LEARNED_TRAIN_MIN_MORNINGS quiet mornings, or fewer than LEARNED_TRAIN_MIN_CLEAN
// clean overrides — the weight is zero: two overrides can never move anything.
export const LEARNED_TRAIN_WINDOW_DAYS = 42;
export const LEARNED_TRAIN_MIN_MORNINGS = 10;
// The short ladders' own "three is a pattern" bar, so neither loop can be moved by less.
export const LEARNED_TRAIN_MIN_CLEAN = OUTCOME_SOFTENING_MIN_DIVERGENCES;
export const LEARNED_TRAIN_HALF_LIFE_DAYS = 21;
const LEARNED_TRAIN_PRIOR = 2;
// How far a quiet read moves at a given weight. An easy read needs less evidence to
// open than a rest read, and a rest read eases one rung (to easy) before it opens.
// The rest → train bar sits inside the band the old conjunction's own floor spanned
// once the prior is applied (⅔ trained through × ¾ clean reads 0.39–0.5 here,
// depending on how many mornings carried it), so a record that used to open a rest
// still does, and a record just short of it now moves one rung instead of none.
export const LEARNED_EASE_REST_WEIGHT = 0.25;
export const LEARNED_OPEN_EASY_WEIGHT = 0.35;
export const LEARNED_OPEN_REST_WEIGHT = 0.45;

export interface TrainAnywayLearning {
  // The weight can open at least an easy read to train (weight ≥ LEARNED_OPEN_EASY_WEIGHT).
  mature: boolean;
  // 0..1, two decimals. MACHINE register: a measure of the evidence about the READS,
  // never a grade of the athlete, and never rendered as a number to them.
  weight: number;
  window_days: number;
  quiet_mornings: number;
  trained_through: number;
  trained_without_harm: string[];
}

const NO_TRAIN_ANYWAY: TrainAnywayLearning = Object.freeze({
  mature: false,
  weight: 0,
  window_days: LEARNED_TRAIN_WINDOW_DAYS,
  quiet_mornings: 0,
  trained_through: 0,
  trained_without_harm: [],
});

// Which read the learning moves a quiet read to at `weight`, or null for "stays". One
// function so the caller and the tests cannot disagree about the rungs.
export function learnedQuietStep(kind: unknown, weight: number): "train" | "easy" | null {
  if (!Number.isFinite(weight)) return null;
  if (kind === "easy") return weight >= LEARNED_OPEN_EASY_WEIGHT ? "train" : null;
  if (kind === "rest")
    return weight >= LEARNED_OPEN_REST_WEIGHT ? "train" : weight >= LEARNED_EASE_REST_WEIGHT ? "easy" : null;
  return null;
}

// A quiet morning for this learning: a rest or easy read — or a train read THIS loop
// opened. Counting only the first two was self-extinguishing: once the learning opens
// days, they stop reading quiet, the window empties and the read relapses on a cycle —
// the defect the short ladders' `softened` flags were written to fix.
function learnedQuietMorning(day: ReadAdherenceDay): boolean {
  return day.read === "rest" || day.read === "easy" || (day.read === "train" && day.learned_opened === true);
}

// Diverged from the quiet read by the SAME test each ladder holds its own read to: a
// rest read is diverged by any training, an easy read (or one this loop opened) only
// by going above easy.
function divergedFromQuietRead(day: ReadAdherenceDay): boolean {
  return day.read === "rest" ? day.trained : wentAboveEasy(day);
}

export function trainsAnywayWithoutHarm(model: ReadAdherenceModel | null, asOf: string): TrainAnywayLearning {
  if (!model || !Array.isArray(model.recent)) return NO_TRAIN_ANYWAY;
  const lastClosed = addDaysISO(asOf, -1);
  const from = addDaysISO(asOf, -LEARNED_TRAIN_WINDOW_DAYS);
  if (!lastClosed || !from) return NO_TRAIN_ANYWAY;
  const quiet = model.recent
    .filter((day) => day.date >= from && day.date <= lastClosed && learnedQuietMorning(day))
    .sort((a, b) => a.date.localeCompare(b.date));
  const diverged = quiet.filter(divergedFromQuietRead).map((day) => day.date);
  const clean = diverged.filter(trainedWithoutHarm);
  const recency = (date: string): number => {
    const age = daysBetweenISO(asOf, date);
    return age == null ? 0 : 0.5 ** (Math.max(0, age) / LEARNED_TRAIN_HALF_LIFE_DAYS);
  };
  const mass = (dates: string[]): number => dates.reduce((sum, date) => sum + recency(date), 0);
  const floorMet = quiet.length >= LEARNED_TRAIN_MIN_MORNINGS && clean.length >= LEARNED_TRAIN_MIN_CLEAN;
  const quietMass = mass(quiet.map((day) => day.date));
  const divergedMass = mass(diverged);
  const raw = floorMet
    ? (divergedMass / (quietMass + LEARNED_TRAIN_PRIOR)) * (mass(clean) / (divergedMass + LEARNED_TRAIN_PRIOR))
    : 0;
  const weight = Math.round(Math.max(0, Math.min(1, raw)) * 100) / 100;
  return {
    mature: weight >= LEARNED_OPEN_EASY_WEIGHT,
    weight,
    window_days: LEARNED_TRAIN_WINDOW_DAYS,
    quiet_mornings: quiet.length,
    trained_through: diverged.length,
    trained_without_harm: clean,
  };
}
