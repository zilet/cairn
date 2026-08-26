// A completed log outranks a felt rating. Both the autoregulation rollup
// (`low_performance_flag`) and the underfueling performance channel ask the same
// question: did this session actually land short, or did the athlete hit what
// was prescribed and then rate the session poorly?
//
// A low rating is contradicted only when the session has no skipped / partial
// doses (dose_context.partial, the skipped list, per-dose `non_comparable_reasons`
// carrying "partial") AND every attempted dose is `met`/`exceeded`. Filtering
// to comparable doses first would hide the abandoned lifts — doseComparability
// persists comparable:false + reasons:["partial"] on own-dose shortfalls, and
// never writes `own_dose_shortfall` onto the row — so 2-of-5 done at target
// would look complete. Missing evidence is absence: the rating stands.
import { db } from "../db.js";

type DoseRow = {
  comparable?: unknown;
  challenge_verdict?: unknown;
  non_comparable_reasons?: unknown;
  prescribed?: { sets?: unknown } | null;
  achieved?: { sets?: unknown } | null;
};

type OutcomeFacts = {
  dose_evidence?: DoseRow[];
  skipped?: unknown;
  dose_context?: { partial?: unknown } | null;
};

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

function hasSkippedOrPartialDose(facts: OutcomeFacts | null): boolean {
  if (!facts) return false;
  if (facts.dose_context?.partial === true) return true;
  if (skippedExercises(facts).length > 0) return true;
  return doseRows(facts).some(doseOwnShortfall);
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

/**
 * True when the log contradicts a low felt rating: no skipped/partial doses,
 * and every attempted dose is `met` or `exceeded`. Any skip, set-shortfall, or
 * `dose_context.partial` — or no dose evidence at all — and the rating stands.
 */
export function sessionLogContradictsLowRating(sessionId: number): boolean {
  const facts = outcomeFactsForSession(sessionId);
  if (!facts) return false;
  if (hasSkippedOrPartialDose(facts)) return false;
  const doses = doseRows(facts);
  if (!doses.length) return false;
  return doses.every(isMetOrExceeded);
}

export function sessionHasComparableDoseShortfall(sessionId: number): boolean {
  const facts = outcomeFactsForSession(sessionId);
  if (!facts) return false;
  if (hasOwnDoseShortfall(facts)) return true;
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
