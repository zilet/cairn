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
import { harderLoad, loadAtOrAbove } from "./outcome-comparability.js";

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
  prescribed?: { sets?: unknown; target_weight?: unknown; target_seconds?: unknown } | null;
  achieved?: { sets?: unknown; top_weight?: unknown; top_reps?: unknown; top_seconds?: unknown } | null;
};

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

function doseRows(facts: OutcomeFacts | null): DoseRow[] {
  return Array.isArray(facts?.dose_evidence) ? facts.dose_evidence : [];
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
  const verdict = String(dose?.challenge_verdict ?? "");
  return verdict === "met" || verdict === "exceeded";
}

function isPartialOrUnderPrescribed(dose: DoseRow): boolean {
  if (doseOwnShortfall(dose)) return true;
  const verdict = String(dose?.challenge_verdict ?? "");
  return verdict === "under_prescribed" || verdict === "partial";
}

function finiteOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A lift the day actually asked for. One with nothing prescribed is ignored. */
function dosePrescribed(dose: DoseRow): boolean {
  const verdict = String(dose?.challenge_verdict ?? "");
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
  if (String(dose?.challenge_verdict ?? "") === "exceeded") return true;
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
    const verdict = String(dose?.challenge_verdict ?? "");
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
    .prepare(
      `SELECT id, performance, finished_at FROM sessions WHERE date = ? ORDER BY id DESC LIMIT 1`
    )
    .get(day) as { id?: number; performance?: number | null; finished_at?: string | null } | undefined;
  const id = Number(row?.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  if (row?.finished_at == null && !sessionHasLoggedWork(id)) return null;
  const performance = row?.performance == null ? null : Number(row.performance);
  return { id, performance: Number.isFinite(performance as number) ? (performance as number) : null };
}

function sessionHasLoggedWork(sessionId: number): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM logged_sets WHERE session_id = ?`)
    .get(sessionId) as { n?: number } | undefined;
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
  const start = new Date(new Date(end + "T00:00:00Z").getTime() - (span - 1) * 864e5)
    .toISOString()
    .slice(0, 10);
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
