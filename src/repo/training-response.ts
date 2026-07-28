import { db } from "../db.js";
import { normalizedExerciseKey } from "./exercise-canon.js";

export type ChallengeVerdict = "not_attempted" | "under_prescribed" | "met" | "exceeded" | "no_target";

export type RecentMovementResponseVerdict = "insufficient" | "contradictory" | "earned_absorbed" | "earned_hold";

export interface RecentMovementResponse {
  verdict: RecentMovementResponseVerdict;
  movement_key: string;
  intent_key: string | null;
  comparable_outcomes: number;
  considered_outcomes: number;
}

function movementIdentity(exercise: string): string {
  const stored = db.prepare(`SELECT id FROM exercises WHERE name = ? COLLATE NOCASE`).get(exercise) as any;
  return stored?.id != null ? `exercise:${Number(stored.id)}` : `movement:${normalizedExerciseKey(exercise)}`;
}

// A deliberately small learning seam for progression. It only recognizes a
// repeated clean response to the same stable movement + intent. Recovery,
// override, partial, travel/illness, symptom-relevant, and endurance-loaded
// outcomes are retained in the ledger but excluded from the comparison.
export function recentMovementResponse(
  movement: string,
  opts: { intent_key?: string; limit?: number } = {}
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
    if (matchedIntent == null) matchedIntent = String(dose.intent_key);
    if (dose.intent_key !== matchedIntent) continue;
    considered++;
    if ((facts.confidence !== "moderate" && facts.confidence !== "high") || facts.dose_context?.comparable !== true) {
      continue;
    }
    if (verdicts.length < 2) verdicts.push(dose.challenge_verdict as ChallengeVerdict);
  }
  if (verdicts.length < 2) {
    return {
      verdict: "insufficient",
      movement_key: requestedKey,
      intent_key: matchedIntent,
      comparable_outcomes: verdicts.length,
      considered_outcomes: considered,
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
  };
}
