// A completed log outranks a felt rating. Both the autoregulation rollup
// (`low_performance_flag`) and the underfueling performance channel ask the same
// question: did this session actually land short, or did the athlete hit what
// was prescribed and then rate the session poorly?
//
// Dose comparability is a PER-LIFT question, not a per-session one, so the
// contradiction is read per lift too. A whole session is not disqualified by one
// lift that fell short: the log contradicts the rating when the lifts that were
// met or exceeded at least match the ones that fell short, at least one lift was
// genuinely EXCEEDED, and no lift regressed under its stored full-load reference.
// A clean log — every prescribed dose met, nothing skipped — still contradicts on
// its own; the "one exceeded" arm is the extra evidence an INCOMPLETE log has to
// carry before it can outrank what the athlete felt.
//
// Lifts carrying no prescription are ignored; skipped lifts count as shortfalls.
// Filtering to comparable doses first would hide the abandoned lifts —
// doseComparability persists comparable:false + reasons:["partial"] on own-dose
// shortfalls, and never writes `own_dose_shortfall` onto the row — so 2-of-5 done
// at target would look complete. Missing evidence is absence: the rating stands.
import { db } from "../db.js";
// The signed load comparison and the full-load reference pick have ONE home.
// outcome-comparability.ts imports nothing, so this costs no cycle — and a local
// copy is how the two readings drift apart.
import {
  doseAdoptedAfterLog,
  harderLoad,
  loadAtOrAbove,
  readStoredDose,
  storedDoseMetLoad,
} from "./outcome-comparability.js";

// The per-dose full-load reference reconciliation persists on schema-4 rows
// (`FullLoadReference` in outcome-comparability.ts). Read structurally off
// facts_json — rows written before schema 4 carry none and the arm stays quiet.
type FullLoadReferenceRow = {
  sets?: unknown;
  target_weight?: unknown;
  target_seconds?: unknown;
  rep_low?: unknown;
  recent_working_weight?: unknown;
  recent_working_seconds?: unknown;
};

type DoseRow = {
  comparable?: unknown;
  challenge_verdict?: unknown;
  non_comparable_reasons?: unknown;
  exercise?: unknown;
  movement_key?: unknown;
  mode?: unknown;
  full_load_reference?: FullLoadReferenceRow | null;
  relevant_symptom?: unknown;
  prescribed?: {
    sets?: unknown;
    rep_low?: unknown;
    rep_high?: unknown;
    target_weight?: unknown;
    target_seconds?: unknown;
  } | null;
  achieved?: {
    sets?: unknown;
    top_weight?: unknown;
    top_reps?: unknown;
    top_seconds?: unknown;
    sets_detail?: unknown;
  } | null;
};

// ONE reading of a stored dose (outcome-comparability.ts readStoredDose): the verdict
// under the current rule, and whether it is a capped-short dose — one set short with
// every working set past the range's top, a VOLUME fact, never a shortfall read here.
const doseVerdict = (dose: DoseRow): string => readStoredDose(dose).verdict;
const doseCappedShort = (dose: DoseRow): boolean => readStoredDose(dose).capped_short;

type OutcomeFacts = {
  schema_version?: unknown;
  dose_evidence?: DoseRow[];
  skipped?: unknown;
  dose_context?: { partial?: unknown } | null;
};

function factsSchemaVersion(facts: OutcomeFacts | null): number {
  const n = Number(facts?.schema_version);
  return Number.isFinite(n) ? n : 0;
}

function outcomeFactsForSession(sessionId: number): OutcomeFacts | null {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db
    .prepare(
      `SELECT facts_json FROM daily_session_outcomes
        WHERE session_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(id) as { facts_json?: string } | undefined;
  if (!row?.facts_json) return null;
  try {
    const facts = JSON.parse(String(row.facts_json));
    return facts && typeof facts === "object" ? (facts as OutcomeFacts) : null;
  } catch {
    return null;
  }
}

// A dose whose work was logged before its card existed (a card adopted later) says
// nothing about how the athlete met that card — neither a short lift nor an exceeded one.
function doseRows(facts: OutcomeFacts | null): DoseRow[] {
  return Array.isArray(facts?.dose_evidence) ? facts.dose_evidence.filter((dose) => !doseAdoptedAfterLog(dose)) : [];
}

function skippedExercises(facts: OutcomeFacts | null): string[] {
  return Array.isArray(facts?.skipped) ? facts.skipped.map(String).filter((name) => name.trim()) : [];
}

function ownSetShortfall(dose: DoseRow): boolean {
  const prescribedSets = Number(dose?.prescribed?.sets);
  const achievedSets = Number(dose?.achieved?.sets);
  return (
    Number.isFinite(prescribedSets) &&
    prescribedSets > 0 &&
    (!Number.isFinite(achievedSets) || achievedSets < prescribedSets)
  );
}

function doseOwnShortfall(dose: DoseRow): boolean {
  if (doseCappedShort(dose)) return false;
  const reasons = Array.isArray(dose?.non_comparable_reasons)
    ? dose.non_comparable_reasons.map(String)
    : [];
  // doseComparability emits "partial" for an own-dose shortfall; it is the
  // persisted marker. Set counts cover older rows that predate that field.
  return reasons.includes("partial") || ownSetShortfall(dose);
}

function hasOwnDoseShortfall(facts: OutcomeFacts | null): boolean {
  if (!facts) return false;
  if (skippedExercises(facts).length > 0) return true;
  return doseRows(facts).some(doseOwnShortfall);
}

function isMetOrExceeded(dose: DoseRow): boolean {
  return storedDoseMetLoad(readStoredDose(dose));
}

function isPartialOrUnderPrescribed(dose: DoseRow): boolean {
  if (doseCappedShort(dose)) return false;
  if (doseOwnShortfall(dose)) return true;
  const verdict = doseVerdict(dose);
  return verdict === "under_prescribed" || verdict === "partial";
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A lift the day actually asked for. One with nothing prescribed is ignored. */
function dosePrescribed(dose: DoseRow): boolean {
  const verdict = doseVerdict(dose);
  const sets = finiteOrNull(dose?.prescribed?.sets);
  if (sets != null && sets > 0) return true;
  if (finiteOrNull(dose?.prescribed?.target_weight) != null) return true;
  if (finiteOrNull(dose?.prescribed?.target_seconds) != null) return true;
  if (verdict === "no_target" || verdict === "") return false;
  return true;
}

/**
 * A dose the athlete pushed PAST what was asked — a verdict of `exceeded`, more
 * sets than prescribed, or a heavier top weight than the target. (Weight is
 * signed: on an assisted lift a larger number is less assist, so one comparison
 * reads both.)
 */
function doseExceeded(dose: DoseRow): boolean {
  if (doseVerdict(dose) === "exceeded") return true;
  const prescribedSets = finiteOrNull(dose?.prescribed?.sets);
  const achievedSets = finiteOrNull(dose?.achieved?.sets);
  if (prescribedSets != null && prescribedSets > 0 && achievedSets != null && achievedSets > prescribedSets) {
    return true;
  }
  const targetWeight = finiteOrNull(dose?.prescribed?.target_weight);
  const topWeight = finiteOrNull(dose?.achieved?.top_weight);
  return targetWeight != null && topWeight != null && topWeight > targetWeight;
}

function doseKeys(dose: DoseRow): string[] {
  return [dose?.exercise, dose?.movement_key]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function fullLoadReference(dose: DoseRow): FullLoadReferenceRow | null {
  const ref = dose?.full_load_reference;
  if (!ref || typeof ref !== "object" || Array.isArray(ref)) return null;
  return ref as FullLoadReferenceRow;
}

/**
 * A lift whose top set landed UNDER its own full working load — a real regression.
 *
 * This reads the reference's LOAD arms only, never its `sets`. Reconciliation's
 * own `performed_at_full_load` folds a set shortfall into the same boolean, and
 * borrowing that here would let one short lift veto the whole majority read —
 * exactly the per-session strictness the majority rule exists to remove. Volume
 * is already counted as a shortfall above; this arm answers load alone. An
 * unknown reference or an unlogged top set is absence, not a regression.
 */
function doseUnderFullLoad(dose: DoseRow): boolean {
  const reference = fullLoadReference(dose);
  if (!reference) return false;
  if (String(dose?.mode ?? "") === "timed") {
    const refSeconds = harderLoad(
      finiteOrNull(reference.target_seconds),
      finiteOrNull(reference.recent_working_seconds)
    );
    const topSeconds = finiteOrNull(dose?.achieved?.top_seconds);
    return refSeconds != null && topSeconds != null && topSeconds < refSeconds;
  }
  const refWeight = harderLoad(
    finiteOrNull(reference.target_weight),
    finiteOrNull(reference.recent_working_weight)
  );
  if (refWeight == null) {
    // Bodyweight: the rep floor of the un-reduced prescription is the reference.
    const repLow = finiteOrNull(reference.rep_low);
    const topReps = finiteOrNull(dose?.achieved?.top_reps);
    return repLow != null && topReps != null && topReps < repLow;
  }
  const topWeight = finiteOrNull(dose?.achieved?.top_weight);
  return topWeight != null && !loadAtOrAbove(topWeight, refWeight);
}

export type DoseContradictionTally = {
  met: number;
  exceeded: number;
  short: number;
  under_full_load: number;
  unprescribed: number;
};

/**
 * Per-lift counts behind the contradiction read. Exported so a caller can say
 * WHY a rating stood without re-deriving the classification.
 */
export function doseContradictionTally(sessionId: number): DoseContradictionTally | null {
  const facts = outcomeFactsForSession(sessionId);
  if (!facts) return null;
  const doses = doseRows(facts);
  const tally: DoseContradictionTally = { met: 0, exceeded: 0, short: 0, under_full_load: 0, unprescribed: 0 };
  const counted = new Set<string>();
  for (const dose of doses) {
    for (const key of doseKeys(dose)) counted.add(key);
    if (!dosePrescribed(dose)) {
      tally.unprescribed++;
      continue;
    }
    if (doseUnderFullLoad(dose)) tally.under_full_load++;
    const verdict = doseVerdict(dose);
    // An own-dose shortfall — fewer sets than asked, or a persisted "partial" —
    // is a shortfall whatever the verdict says. Otherwise volume the athlete
    // added past the prescription reads as exceeded even where the verdict is
    // `under_prescribed` on load: that quality question is the full-load arm's,
    // and it is answered per lift above.
    if (doseOwnShortfall(dose)) tally.short++;
    else if (doseExceeded(dose)) tally.exceeded++;
    else if (isMetOrExceeded(dose) || verdict === "no_target") tally.met++;
    else tally.short++;
  }
  // A lift on the skipped list with no dose row of its own is still a shortfall.
  for (const name of skippedExercises(facts)) {
    if (!counted.has(name.trim().toLowerCase())) tally.short++;
  }
  return tally;
}

/**
 * True when the log contradicts a low felt rating. Per lift: the doses met or
 * exceeded must at least match the ones that fell short (skips count short,
 * unprescribed lifts are ignored), and an incomplete log must additionally show
 * at least one dose EXCEEDED. A lift that regressed under its stored full working
 * load leaves the rating standing whatever the counts say, and no dose evidence
 * at all is absence, not contradiction.
 */
export function sessionLogContradictsLowRating(sessionId: number): boolean {
  const tally = doseContradictionTally(sessionId);
  if (!tally) return false;
  const done = tally.met + tally.exceeded;
  if (done === 0) return false;
  if (tally.under_full_load > 0) return false;
  if (tally.short === 0) return true;
  return done >= tally.short && tally.exceeded > 0;
}

export function latestSessionIdOnDate(date: string | null | undefined): number | null {
  const day = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const row = db
    .prepare(`SELECT id FROM sessions WHERE date = ? ORDER BY id DESC LIMIT 1`)
    .get(day) as { id?: number } | undefined;
  const id = Number(row?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function completedSessionOnDate(
  date: string | null | undefined
): { id: number; performance: number | null } | null {
  const day = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const row = db
    .prepare(`SELECT id, performance, finished_at FROM sessions WHERE date = ? ORDER BY id DESC LIMIT 1`)
    .get(day) as { id?: number; performance?: number | null; finished_at?: string | null } | undefined;
  const id = Number(row?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (row?.finished_at == null && !sessionHasLoggedWork(id)) return null;
  const performance = row?.performance == null ? null : Number(row.performance);
  return { id, performance: Number.isFinite(performance as number) ? (performance as number) : null };
}

function sessionHasLoggedWork(sessionId: number): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM logged_sets WHERE session_id = ?`).get(sessionId) as
    | { n?: number }
    | undefined;
  return Number(row?.n) > 0;
}

/** A later completed session that met its prescribed doses closes an earlier low rating. */
export function laterCompletedSessionMetDoses(afterDate: string, throughDate: string): boolean {
  const after = String(afterDate ?? "").slice(0, 10);
  const through = String(throughDate ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(after) || !/^\d{4}-\d{2}-\d{2}$/.test(through)) return false;
  const rows = db
    .prepare(
      `SELECT id FROM sessions
        WHERE date > ? AND date <= ?
          AND (finished_at IS NOT NULL OR id IN (SELECT session_id FROM logged_sets))
        ORDER BY date ASC, id ASC`
    )
    .all(after, through) as { id: number }[];
  return rows.some((row) => sessionLogContradictsLowRating(Number(row.id)));
}

export function sessionHasComparableDoseShortfall(sessionId: number): boolean {
  const facts = outcomeFactsForSession(sessionId);
  if (!facts) return false;
  if (hasOwnDoseShortfall(facts)) return true;
  // Per-dose comparable is a schema-3+ field. Schema-2 rows never carried it;
  // a repair that materialized comparable:true onto those doses must not feed
  // this arm of deload-due.
  if (factsSchemaVersion(facts) < 3) return false;
  return doseRows(facts)
    .filter((dose) => dose?.comparable === true)
    .some(isPartialOrUnderPrescribed);
}

/**
 * Distinct sessions in the window whose log shows an own-dose shortfall
 * (skipped / short sets) or a quality-only `under_prescribed`/`partial` on a
 * comparable dose. Used as one arm of log-confirmed fatigue — never a felt
 * rating. Skips count even though doseComparability marks those rows
 * incomparable.
 */
export function countComparableDoseShortfallSessions(date: string, days = 14): number {
  const end = String(date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return 0;
  const span = Math.max(1, days);
  const start = new Date(new Date(end + "T00:00:00Z").getTime() - (span - 1) * 864e5).toISOString().slice(0, 10);
  let rows: { session_id: number }[] = [];
  try {
    rows = db
      .prepare(
        `SELECT DISTINCT o.session_id AS session_id
           FROM daily_session_outcomes o
          WHERE o.date >= ? AND o.date <= ?`
      )
      .all(start, end) as { session_id: number }[];
  } catch {
    return 0;
  }
  let n = 0;
  for (const row of rows) {
    if (sessionHasComparableDoseShortfall(Number(row.session_id))) n++;
  }
  return n;
}

/**
 * Did this session carry its PLANNED VOLUME with the load holding? The per-lift evidence
 * the contradiction read above already classifies, asked a stricter question: every
 * prescribed dose landed at least its planned sets (a capped-short dose is a set short —
 * volume's fact, so it vouches for nothing here), met its prescription under the current
 * rule (load and reps: `met`/`exceeded`), and did not land under its own stored full-load
 * reference (load held or rising). A skipped lift, a movement-relevant symptom, or any
 * dose short on one of those answers no. A dose another confounder made incomparable
 * (illness, a recovery dose) neither vouches nor vetoes unless it fell short. Null when
 * the session carries no such evidence at all: absence, never a verdict.
 *
 * Performance, not feelings: a sustained performance decrease is the marker resistance
 * training can rely on; how the next morning felt is not (docs/ARCHITECTURE.md
 * "Volume: the plan's sets are the default").
 */
export function sessionCarriedPlannedVolume(sessionId: number): boolean | null {
  const facts = outcomeFactsForSession(sessionId);
  if (!facts) return null;
  if (skippedExercises(facts).length > 0) return false;
  // A card the day's budget DEFERRED plan-day lifts off never vouches (second review,
  // item 9): the dose evidence covers only the card's own items, so the remaining lifts
  // done at their authored sets would otherwise read as the whole plan carried. The
  // deferral is recorded on the composition's provenance (`plan_day_deferred`).
  if (compositionDeferredPlanLifts(sessionId)) return false;
  // "Planned" is the plan's AUTHORED set count, never the composed card's: a card the day
  // trimmed (a volume cap below normal, or a train-anyway day) prescribes fewer sets, and
  // finishing those is not carrying the plan — counting it would let the trim vouch for
  // its own cancellation. The authored count is the plan item's own sets as reconciliation
  // read them (`full_load_reference.sets`, daily-reconciliation.ts).
  const trimmedCard = compositionTrimmedVolume(sessionId);
  let carried = 0;
  for (const dose of doseRows(facts)) {
    if (!dosePrescribed(dose)) continue;
    if (dose?.relevant_symptom === true) return false;
    if (doseOwnShortfall(dose) || ownSetShortfall(dose)) return false;
    if (authoredSetShortfall(dose, trimmedCard)) return false;
    if (doseUnderFullLoad(dose)) return false;
    if (dose?.comparable === false) continue;
    if (!isMetOrExceeded(dose)) return false;
    carried++;
  }
  return carried > 0 ? true : null;
}

// The athlete logged fewer working sets than the plan item AUTHORED. On a trimmed card a
// lift whose authored count is unknown (no plan row: a substitute, an agent's lift) can
// never show it carried the plan, so it answers no as well.
function authoredSetShortfall(dose: DoseRow, trimmedCard: boolean): boolean {
  const authored = finiteOrNull(dose?.full_load_reference?.sets);
  const achieved = finiteOrNull(dose?.achieved?.sets) ?? 0;
  if (authored == null || authored <= 0) return trimmedCard;
  return achieved < authored;
}

// Did this session's card leave any plan-day lift behind — the day's set budget deferring
// it (daily-composition.ts fitPlanDaySetBudget, persisted as `plan_day_deferred` on the
// composition's provenance by adaptive-session.ts)? Unknown reads no.
function compositionDeferredPlanLifts(sessionId: number): boolean {
  try {
    const row = db
      .prepare(
        `SELECT c.constraints_json AS constraints_json, c.provenance_json AS provenance_json
           FROM daily_session_outcomes o JOIN daily_session_compositions c ON c.id = o.composition_id
          WHERE o.session_id = ? ORDER BY o.id DESC LIMIT 1`
      )
      .get(Number(sessionId)) as { constraints_json?: string | null; provenance_json?: string | null } | undefined;
    for (const blob of [row?.provenance_json, row?.constraints_json]) {
      if (!blob) continue;
      const deferred = JSON.parse(String(blob))?.plan_day_deferred;
      if (Array.isArray(deferred) && deferred.length > 0) return true;
    }
  } catch {
    return false;
  }
  return false;
}

// Was this session's card composed under a volume trim — a volume cap below normal, or a
// train-anyway day (whose caps are the conservative ones)? Read off the composition's own
// stored decision context (adaptive-session.ts `dailyDecisionContext`). Unknown reads no.
function compositionTrimmedVolume(sessionId: number): boolean {
  try {
    const row = db
      .prepare(
        `SELECT c.constraints_json AS constraints_json, c.provenance_json AS provenance_json
           FROM daily_session_outcomes o JOIN daily_session_compositions c ON c.id = o.composition_id
          WHERE o.session_id = ? ORDER BY o.id DESC LIMIT 1`
      )
      .get(Number(sessionId)) as { constraints_json?: string | null; provenance_json?: string | null } | undefined;
    for (const blob of [row?.constraints_json, row?.provenance_json]) {
      if (!blob) continue;
      const decision = JSON.parse(String(blob))?.daily_decision;
      if (!decision || typeof decision !== "object") continue;
      const volume = decision?.caps?.volume;
      return decision.train_anyway === true || (typeof volume === "string" && volume !== "normal");
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * The most recent sessions BEFORE `date` (never the day's own) that carry reconciled dose
 * evidence, newest first, each with `sessionCarriedPlannedVolume`'s answer. At most
 * `limit` sessions inside `windowDays`; a session with no verdict (null) is left out.
 */
export function recentPlannedVolumeVerdicts(
  date: string,
  opts: { windowDays: number; limit: number }
): Array<{ session_id: number; date: string; carried: boolean }> {
  const end = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return [];
  const start = new Date(new Date(`${end}T00:00:00Z`).getTime() - Math.max(1, opts.windowDays) * 864e5)
    .toISOString()
    .slice(0, 10);
  let rows: Array<{ session_id: number; date: string }> = [];
  try {
    rows = db
      .prepare(
        `SELECT o.session_id AS session_id, MAX(o.date) AS date
           FROM daily_session_outcomes o
          WHERE o.date >= ? AND o.date < ?
          GROUP BY o.session_id
          ORDER BY date DESC, o.session_id DESC`
      )
      .all(start, end) as Array<{ session_id: number; date: string }>;
  } catch {
    return [];
  }
  const out: Array<{ session_id: number; date: string; carried: boolean }> = [];
  for (const row of rows) {
    if (out.length >= opts.limit) break;
    const carried = sessionCarriedPlannedVolume(Number(row.session_id));
    if (carried == null) continue;
    out.push({ session_id: Number(row.session_id), date: String(row.date), carried });
  }
  return out;
}
