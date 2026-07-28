import { db } from "../db.js";
import {
  getDailySessionOutcome,
  getDailySessionOutcomeForSession,
  type DailySessionOutcome,
} from "./daily-reconciliation.js";
import { planDayProgression } from "./progression.js";

// A deliberately small athlete-facing seam over the durable reconciliation
// ledger. It never writes or reinterprets the stored facts: those remain the
// machine-readable evidence for progression and review.
export interface DailyOutcomeAthleteRead {
  learning: string;
  next_exposure: string | null;
}

export interface DailyOutcomeRead extends DailySessionOutcome {
  athlete_read: DailyOutcomeAthleteRead | null;
}

export interface DailyOutcomeReadInput {
  session_id?: number | null;
  date?: string | null;
}

function hasUsableExposure(outcome: DailySessionOutcome): boolean {
  const doses = Array.isArray(outcome.facts?.dose_evidence) ? outcome.facts.dose_evidence : [];
  const endurance = Array.isArray(outcome.facts?.endurance_evidence) ? outcome.facts.endurance_evidence : [];
  return (
    doses.some((dose) => Number(dose?.achieved?.sets) > 0) ||
    endurance.some((entry) => entry?.completion_verdict !== "unmatched" && entry?.achieved != null)
  );
}

function hasStrengthExposure(outcome: DailySessionOutcome): boolean {
  const doses = Array.isArray(outcome.facts?.dose_evidence) ? outcome.facts.dose_evidence : [];
  return doses.some((dose) => Number(dose?.achieved?.sets) > 0);
}

function enduranceLearning(outcome: DailySessionOutcome): string | null {
  const endurance = Array.isArray(outcome.facts?.endurance_evidence) ? outcome.facts.endurance_evidence : [];
  const matched = endurance.filter((entry) => entry?.completion_verdict !== "unmatched" && entry?.achieved != null);
  if (!matched.length || hasStrengthExposure(outcome)) return null;
  if (isContextConfounded(outcome)) {
    return "Recovery or context shaped today’s endurance work, so we’ll treat it as context rather than push progression from it.";
  }
  if (matched.some((entry) => ["dose_shortfall", "partial"].includes(entry.completion_verdict))) {
    return "You got useful endurance work in, though it was shorter than planned. We’ll treat it as a partial exposure and keep learning.";
  }
  if (matched.some((entry) => entry.completion_verdict === "quality_not_observed")) {
    return "You completed the endurance dose, but the observed intensity did not match the planned quality. We’ll keep it as context rather than push progression from it.";
  }
  if (matched.some((entry) => entry.completion_verdict === "quality_unverified")) {
    return "You completed the endurance dose, but the planned quality could not be verified from the available activity data. We’ll keep learning without pushing progression from it.";
  }
  if (matched.some((entry) => entry.completion_verdict === "quality_observed")) {
    return "You completed the planned endurance dose, and the available intensity data supports the prescribed quality.";
  }
  return "You completed the planned endurance work. That gives us a useful, factual exposure to learn from.";
}

function isContextConfounded(outcome: DailySessionOutcome): boolean {
  const context = outcome.facts?.dose_context;
  if (context?.comparable === true) return false;
  return Boolean(
    context?.recovery ||
      context?.athlete_override ||
      context?.travel ||
      context?.illness ||
      context?.symptom ||
      context?.endurance
  );
}

function learningFor(outcome: DailySessionOutcome): string {
  if (!hasUsableExposure(outcome)) {
    return "There was no usable exposure to learn from today. We’ll meet the next session fresh.";
  }
  const endurance = enduranceLearning(outcome);
  if (endurance) return endurance;
  if (isContextConfounded(outcome)) {
    return "Recovery or context shaped today’s work, so we won’t push progression from it.";
  }
  if (outcome.facts?.dose_context?.comparable === true) {
    const evidence = Array.isArray(outcome.facts?.progression_evidence) ? outcome.facts.progression_evidence : [];
    const met = evidence.length > 0 && evidence.every((entry) => entry?.verdict === "met_or_exceeded");
    if (met) return "You met the planned work cleanly. That gives the next exposure useful evidence.";
    return "This was a clean exposure under the planned dose. Keep the next exposure steady before progressing.";
  }
  return "This was not a full comparable exposure, so the next clean session will guide progression.";
}

function isNewestCompletedComparable(outcome: DailySessionOutcome): boolean {
  const row = db
    .prepare(
      `SELECT session_id
         FROM daily_session_outcomes
        WHERE status = 'completed'
        ORDER BY date DESC, id DESC
        LIMIT 1`
    )
    .get() as any;
  return Number(row?.session_id) === outcome.session_id;
}

function nextExposureFor(outcome: DailySessionOutcome): DailyOutcomeAthleteRead["next_exposure"] {
  if (
    !hasStrengthExposure(outcome) ||
    outcome.facts?.dose_context?.comparable !== true ||
    !isNewestCompletedComparable(outcome)
  ) {
    return null;
  }
  const planDay = db
    .prepare(
      `SELECT pd.day_number
         FROM daily_session_compositions dsc
         JOIN plan_days pd ON pd.id = dsc.plan_day_id
        WHERE dsc.id = ?`
    )
    .get(outcome.composition_id) as any;
  if (!Number.isInteger(Number(planDay?.day_number))) return null;
  const prescriptions = planDayProgression(Number(planDay.day_number), { forNextSession: true });
  for (const prescription of prescriptions) {
    if (
      prescription.movement_response === "earned_absorbed" &&
      prescription.action === "overload" &&
      prescription.dose_eligibility?.eligible === true
    ) {
      return `Next exposure: ${prescription.exercise} ${prescription.delta_text}.`;
    }
  }
  return null;
}

// Preserve the existing reconciliation surface for in-progress sessions, but keep
// the athlete read null until completion so no mid-workout verdict is manufactured.
export function dailyOutcomeRead(input: DailyOutcomeReadInput = {}): DailyOutcomeRead | null {
  const sessionId = Number(input.session_id);
  const outcome = Number.isInteger(sessionId) && sessionId > 0
    ? getDailySessionOutcomeForSession(sessionId)
    : getDailySessionOutcome(input.date ?? undefined);
  if (!outcome) return null;
  if (outcome.status !== "completed") return { ...outcome, athlete_read: null };
  return {
    ...outcome,
    athlete_read: {
      learning: learningFor(outcome),
      next_exposure: nextExposureFor(outcome),
    },
  };
}
