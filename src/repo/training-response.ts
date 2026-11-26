import { db } from "../db.js";
import { exerciseIdentityKey } from "./exercise-canon.js";
import { ADOPTED_AFTER_LOG, readStoredDose } from "./outcome-comparability.js";
import { copyDeep, memoKey, requestMemo } from "./request-memo.js";

export type ChallengeVerdict = "not_attempted" | "under_prescribed" | "met" | "exceeded" | "no_target";

export type RecentMovementResponseVerdict = "insufficient" | "contradictory" | "earned_absorbed" | "earned_hold";

export interface RecentMovementResponse {
  verdict: RecentMovementResponseVerdict;
  movement_key: string;
  intent_key: string | null;
  comparable_outcomes: number;
  considered_outcomes: number;
  // Newest comparable challenge, when any. `insufficient` still needs two
  // verdicts to become earned_absorbed / earned_hold; a single met/exceeded
  // here is what lets a push-drive step stand on one full comparable dose.
  latest_verdict: ChallengeVerdict | null;
}

// Alias-aware, and the SHAPE is unchanged so stored movement_key rows still match:
// the same ladder daily-reconciliation writes doses with.
function movementIdentity(exercise: string): string {
  return exerciseIdentityKey(exercise);
}

/** daily-reconciliation.ts UNIT_SUBSTITUTE_KEY_PREFIX / UNIT_SUBSTITUTE, restated (that module imports far more than this read needs). */
export const SUBSTITUTE_DOSE_KEY_PREFIX = "unit_substitute:";
const SUBSTITUTE_DOSE_REASON = "unit_substitute";

/** A stored dose that is another lift's work or was logged before its card: never a movement response. */
export function doseIsNotThisLiftsResponse(dose: any): boolean {
  if (String(dose?.movement_key ?? "").startsWith(SUBSTITUTE_DOSE_KEY_PREFIX)) return true;
  if (dose?.substituted_by != null && String(dose.substituted_by).trim() !== "") return true;
  if (dose?.adopted_after_log === true) return true;
  const reasons: unknown[] = Array.isArray(dose?.non_comparable_reasons) ? dose.non_comparable_reasons : [];
  return reasons.some((reason) => reason === ADOPTED_AFTER_LOG || reason === SUBSTITUTE_DOSE_REASON);
}

// A deliberately small learning seam for progression. It only recognizes a
// repeated clean response to the same stable movement + intent. Recovery,
// override, partial, travel/illness, symptom-relevant, and endurance-loaded
// outcomes are retained in the ledger but excluded from the comparison.
export function recentMovementResponse(
  movement: string,
  opts: { intent_key?: string; limit?: number } = {}
): RecentMovementResponse {
  const key = memoKey([movement, opts]);
  if (key == null) return recentMovementResponseRead(movement, opts);
  return requestMemo(`recent_movement_response:${key}`, () => recentMovementResponseRead(movement, opts), copyDeep);
}

function recentMovementResponseRead(
  movement: string,
  opts: { intent_key?: string; limit?: number }
): RecentMovementResponse {
  const requested = String(movement ?? "").trim();
  const requestedKey =
    requested.startsWith("exercise:") || requested.startsWith("movement:") ? requested : movementIdentity(requested);
  const intent = opts.intent_key == null ? null : String(opts.intent_key);
  const limit = Math.min(24, Math.max(2, Math.floor(Number(opts.limit) || 8)));
  const rows = db
    .prepare(
      `SELECT facts_json FROM daily_session_outcomes
       WHERE status = 'completed'
         AND EXISTS (
           SELECT 1
           FROM json_each(daily_session_outcomes.facts_json, '$.dose_evidence') AS dose
           WHERE json_extract(dose.value, '$.movement_key') = ?
             AND (? IS NULL OR json_extract(dose.value, '$.intent_key') = ?)
         )
       ORDER BY date DESC, id DESC LIMIT ?`
    )
    .all(requestedKey, intent, intent, limit) as any[];
  const verdicts: ChallengeVerdict[] = [];
  let considered = 0;
  let matchedIntent: string | null = intent;
  for (const row of rows) {
    let facts: any;
    try {
      facts = JSON.parse(row.facts_json);
    } catch {
      continue;
    }
    if (Number(facts?.schema_version) < 2 || !Array.isArray(facts?.dose_evidence)) continue;
    const dose = facts.dose_evidence.find(
      (entry: any) => entry?.movement_key === requestedKey && (intent == null || entry?.intent_key === intent)
    );
    if (!dose) continue;
    // Another lift's work is never this lift's response: a gym substitution's dose (keyed
    // `unit_substitute:`, or carrying that reason) and a dose logged before its card was
    // adopted (`adopted_after_log`, never done against the card) are skipped outright —
    // not counted as considered, never a verdict — whatever the day's own comparability.
    if (doseIsNotThisLiftsResponse(dose)) continue;
    if (matchedIntent == null) matchedIntent = String(dose.intent_key);
    if (dose.intent_key !== matchedIntent) continue;
    considered++;
    // ONE reading of the dose (readStoredDose), the same progression's eligibility uses:
    // the verdict under the current rule, and a capped-short dose — one set short, every
    // working set past the range's top — reads as the load met; its only
    // non-comparable reason, its own missing set, is volume's.
    const reading = readStoredDose(dose);
    const reasons: string[] = Array.isArray(dose.non_comparable_reasons)
      ? dose.non_comparable_reasons.map(String)
      : Array.isArray(facts.dose_context?.non_comparable_reasons)
        ? facts.dose_context.non_comparable_reasons.map(String)
        : [];
    const comparable =
      facts.dose_context?.comparable === true ||
      (reading.capped_short && reasons.length > 0 && reasons.every((reason) => reason === "partial"));
    if ((facts.confidence !== "moderate" && facts.confidence !== "high") || !comparable) {
      continue;
    }
    if (verdicts.length < 2)
      verdicts.push((reading.capped_short ? "met" : reading.verdict || dose.challenge_verdict) as ChallengeVerdict);
  }
  if (verdicts.length < 2) {
    return {
      verdict: "insufficient",
      movement_key: requestedKey,
      intent_key: matchedIntent,
      comparable_outcomes: verdicts.length,
      considered_outcomes: considered,
      latest_verdict: verdicts[0] ?? null,
    };
  }
  const absorbed = verdicts.filter((verdict) => verdict === "met" || verdict === "exceeded").length;
  const held = verdicts.filter((verdict) => verdict === "under_prescribed").length;
  const verdict: RecentMovementResponseVerdict =
    absorbed === verdicts.length ? "earned_absorbed" : held === verdicts.length ? "earned_hold" : "contradictory";
  return {
    verdict,
    movement_key: requestedKey,
    intent_key: matchedIntent,
    comparable_outcomes: verdicts.length,
    considered_outcomes: considered,
    latest_verdict: verdicts[0] ?? null,
  };
}
