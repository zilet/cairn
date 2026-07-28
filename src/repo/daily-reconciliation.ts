import { getActiveDailySessionForSession } from "./adaptive-session.js";
import { getCardioForDate, type CardioEffort } from "./activities.js";
import { db } from "../db.js";
import { canonicalEnduranceSport } from "./endurance-sports.js";
import { normalizedExerciseKey } from "./exercise-canon.js";
import { isLoadRelevantEnduranceImpact, recentEnduranceImpacts } from "./hybrid-load.js";
import { painAreaLoadsExercise } from "./pain-relevance.js";
import { registerDailyOutcomeReconcileHook } from "./reconciliation-hooks.js";
import { recoveryCycleAt } from "./recovery-cycles.js";
import { localDateISO } from "./shared.js";
import type { ChallengeVerdict } from "./training-response.js";
import { activeRelevantTrainingSymptoms } from "./training-symptoms.js";

export {
  recentMovementResponse,
  type RecentMovementResponse,
  type RecentMovementResponseVerdict,
} from "./training-response.js";

// Stage 4 — outcome reconciliation (docs/ADAPTIVE_DAILY_TRAINING_PLAN.md §6).
// After a session, deterministically compare what was SUGGESTED/accepted (the
// active daily-session composition) against what was actually TRAINED (logged
// sets + skips), and store a durable, idempotent outcome record with confidence
// and reason codes. It is ADHERENCE-NEUTRAL by contract: a reduced or skipped
// session that travel, time, recovery, pain, or another activity explains is
// recorded as such, never as "poor adherence" (constitution: no adherence
// score). It NEVER mutates the weekly plan — repeated evidence flows to the
// existing program-evolution/proposal path, not from one session here.
//
// This "rides" the existing brain machinery rather than emitting a fresh event:
// finishSession/setSessionFeedback already emit session_finished/session_feedback
// which route to brain review; the outcome record is the additive evidence those
// reviews (and the progression engine) can read. Best-effort at every call site.

export interface DailySessionOutcomeFacts {
  schema_version: 2;
  suggested_count: number;
  suggested_exercises: string[];
  logged_exercises: string[];
  completed: string[];
  substituted: string[];
  skipped: string[];
  reordered: boolean;
  achieved: Array<{
    exercise: string;
    sets: number;
    top_weight: number | null;
    top_reps: number | null;
    top_seconds: number | null;
  }>;
  progression_evidence: Array<{
    composition_item_key: string;
    movement_key: string;
    intent_key: string;
    exercise: string;
    target_sets: number | null;
    achieved_sets: number;
    target_weight: number | null;
    achieved_weight: number | null;
    target_rep_low: number | null;
    target_rep_high: number | null;
    achieved_reps: number | null;
    target_seconds: number | null;
    achieved_seconds: number | null;
    verdict: "met_or_exceeded" | "under_target" | "no_target";
    challenge_verdict: ChallengeVerdict;
  }>;
  dose_evidence: MovementDoseEvidence[];
  endurance_evidence: EnduranceEvidence[];
  dose_context: DoseContext;
  feedback: { soreness: number | null; performance: number | null; joint_pain: string | null };
  confounders: string[];
  reason_codes: string[];
  confidence: "low" | "moderate" | "high";
}

export interface EnduranceEvidence {
  composition_item_key: string;
  intent_key: string;
  prescribed: {
    sport: string | null;
    label: string;
    duration_min: number | null;
    distance_km: number | null;
    target_zone: string | null;
    interval_text: string | null;
  };
  achieved: {
    sport: string;
    type: string;
    name: string;
    duration_min: number | null;
    distance_km: number | null;
    pace: string | null;
    avg_hr: number | null;
    observed_zone_summary: Array<{ zone: string; seconds: number }> | null;
    source: string | null;
  } | null;
  match_confidence: "low" | "moderate" | "high";
  match_provenance: string[];
  zone_verdict: "observed" | "not_observed" | "unknown";
  completion_verdict:
    | "met_or_exceeded"
    | "quality_observed"
    | "quality_not_observed"
    | "quality_unverified"
    | "dose_shortfall"
    | "partial" // legacy schema-v2 value; new reconciliation emits dose_shortfall
    | "unmatched";
}

export interface MovementDoseEvidence {
  composition_item_key: string;
  movement_key: string;
  intent_key: string;
  exercise: string;
  mode: "reps" | "timed";
  prescribed: {
    sets: number | null;
    rep_low: number | null;
    rep_high: number | null;
    target_weight: number | null;
    target_seconds: number | null;
  };
  achieved: {
    sets: number;
    top_weight: number | null;
    top_reps: number | null;
    top_seconds: number | null;
    total_reps: number;
    total_seconds: number;
    sets_detail: Array<{
      weight: number | null;
      reps: number | null;
      duration_sec: number | null;
    }>;
  };
  challenge_verdict: ChallengeVerdict;
  relevant_symptom: boolean;
  symptom_event_ids: number[];
}

export interface DoseContext {
  recovery: boolean;
  athlete_override: boolean;
  travel: boolean;
  illness: boolean;
  symptom: boolean;
  endurance: boolean;
  partial: boolean;
  comparable: boolean;
  non_comparable_reasons: string[];
}

export interface DailySessionOutcome {
  composition_id: number;
  session_id: number;
  date: string;
  status: "not_started" | "in_progress" | "completed";
  facts: DailySessionOutcomeFacts;
}

const lower = (s: unknown) =>
  String(s ?? "")
    .trim()
    .toLowerCase();
const finite = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function loggedSetsFor(sessionId: number): any[] {
  return db
    .prepare(
      `SELECT e.id AS exercise_id, e.name AS exercise, e.muscle_group, e.mode AS mode,
              ls.weight, ls.reps, ls.duration_sec, ls.id
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
        WHERE ls.session_id = ? ORDER BY ls.id`
    )
    .all(sessionId) as any[];
}

function skipsFor(sessionId: number): string[] {
  return (db.prepare(`SELECT exercise FROM session_skips WHERE session_id = ?`).all(sessionId) as any[]).map((r) =>
    String(r.exercise)
  );
}

function confounders(session: any, date: string, otherActivity: boolean): string[] {
  const out: string[] = [];
  // Travel window active on the date → a reduced/portable session is expected.
  const travel = db
    .prepare(
      `SELECT 1 FROM context_events
        WHERE kind = 'trip' AND (archived IS NULL OR archived = 0) AND resolved_at IS NULL
          AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) LIMIT 1`
    )
    .get(date, date);
  if (travel) out.push("travel_window");
  const illness = db
    .prepare(
      `SELECT 1 FROM context_events
        WHERE kind IN ('illness','sick') AND (archived IS NULL OR archived = 0) AND resolved_at IS NULL
          AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?) LIMIT 1`
    )
    .get(date, date);
  if (illness) out.push("illness_window");
  if (session?.joint_pain != null && String(session.joint_pain).trim()) out.push("joint_pain");
  if (finite(session?.soreness) != null && Number(session.soreness) >= 4) out.push("high_soreness");
  if (finite(session?.performance) != null && Number(session.performance) <= 2) out.push("low_performance");
  // Another endurance activity the same day is a legitimate reason strength work
  // was trimmed — never counted as skipping.
  if (otherActivity) out.push("other_activity");
  return out;
}

function movementIdentity(exercise: string): string {
  const stored = db.prepare(`SELECT id FROM exercises WHERE name = ? COLLATE NOCASE`).get(exercise) as any;
  return stored?.id != null ? `exercise:${Number(stored.id)}` : `movement:${normalizedExerciseKey(exercise)}`;
}

function intentIdentity(item: any): string {
  if (item?.kind === "cardio") return `endurance:${lower(item.target_zone || "general")}`;
  if (item?.mode === "timed" || finite(item?.target_seconds) != null) return "strength:timed";
  const low = finite(item?.rep_low);
  const high = finite(item?.rep_high);
  return `strength:reps:${low ?? "open"}-${high ?? low ?? "open"}`;
}

const ENDURANCE_SPORTS = new Set(["run", "ride", "swim", "row", "walk"]);

function enduranceSport(value: unknown): string | null {
  const key = canonicalEnduranceSport(value).key;
  return ENDURANCE_SPORTS.has(key) ? key : null;
}

function intervalText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text.slice(0, 2_000) : null;
  }
  try {
    const text = JSON.stringify(value);
    return text && text !== "null" ? text.slice(0, 2_000) : null;
  } catch {
    return null;
  }
}

function observedZoneSummary(zones: unknown): Array<{ zone: string; seconds: number }> | null {
  if (!Array.isArray(zones)) return null;
  const byZone = new Map<string, number>();
  for (const entry of zones) {
    const zoneNumber = Number(entry?.zone);
    const seconds = finite(entry?.secs ?? entry?.seconds);
    if (!Number.isInteger(zoneNumber) || zoneNumber < 1 || zoneNumber > 5 || seconds == null || seconds <= 0) {
      continue;
    }
    const zone = `Z${zoneNumber}`;
    byZone.set(zone, (byZone.get(zone) ?? 0) + seconds);
  }
  const summary = [...byZone.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([zone, seconds]) => ({ zone, seconds }));
  return summary.length ? summary : null;
}

function targetZoneKey(value: unknown): string | null {
  const match = String(value ?? "").match(/\bz(?:one\s*)?([1-5])\b/i);
  return match ? `Z${match[1]}` : null;
}

function relativeDifference(target: number | null, actual: number | null): number | null {
  if (target == null || target <= 0 || actual == null) return null;
  return Math.abs(actual - target) / target;
}

function matchScore(item: any, effort: CardioEffort): number {
  const comparisons = [
    relativeDifference(finite(item.target_duration_min), finite(effort.duration_min)),
    relativeDifference(finite(item.target_distance_km), finite(effort.distance_km)),
  ].filter((value): value is number => value != null);
  return comparisons.length ? comparisons.reduce((sum, value) => sum + value, 0) / comparisons.length : 10;
}

function completionVerdict(
  item: any,
  effort: CardioEffort,
  summary: Array<{ zone: string; seconds: number }> | null
): EnduranceEvidence["completion_verdict"] {
  const targets: Array<[number | null, number | null]> = [
    [finite(item.target_duration_min), finite(effort.duration_min)],
    [finite(item.target_distance_km), finite(effort.distance_km)],
  ];
  for (const [target, actual] of targets) {
    if (target != null && (actual == null || actual < target)) return "dose_shortfall";
  }
  const zoneKey = targetZoneKey(item.target_zone);
  const hasZonePrescription = item.target_zone != null && String(item.target_zone).trim() !== "";
  const hasIntervalPrescription = intervalText(item.interval) != null;
  if (zoneKey != null && summary != null) {
    if (!summary.some((entry) => entry.zone === zoneKey)) return "quality_not_observed";
    // Aggregate time-in-zone proves that a zone occurred, but it cannot prove
    // interval count, work/recovery ordering, or rep completion.
    if (hasIntervalPrescription) return "quality_unverified";
    const dominant = [...summary].sort(
      (left, right) => right.seconds - left.seconds || left.zone.localeCompare(right.zone)
    )[0];
    return dominant?.zone === zoneKey ? "quality_observed" : "quality_unverified";
  }
  if (hasZonePrescription || hasIntervalPrescription) return "quality_unverified";
  return "met_or_exceeded";
}

function enduranceEvidenceFor(
  compositionId: number,
  cardioItems: Array<{ item: any; index: number }>,
  efforts: CardioEffort[]
): { evidence: EnduranceEvidence[]; matched_effort_indexes: Set<number> } {
  const used = new Set<number>();
  const matches = new Map<number, number>();
  const ordered = [...cardioItems].sort((left, right) => {
    const leftSpecific = enduranceSport(`${left.item.exercise ?? ""} ${left.item.note ?? ""}`) != null;
    const rightSpecific = enduranceSport(`${right.item.exercise ?? ""} ${right.item.note ?? ""}`) != null;
    return Number(rightSpecific) - Number(leftSpecific) || left.index - right.index;
  });

  for (const planned of ordered) {
    const plannedSport = enduranceSport(`${planned.item.exercise ?? ""} ${planned.item.note ?? ""}`);
    const candidates = efforts
      .map((effort, index) => ({ effort, index, sport: enduranceSport(`${effort.type} ${effort.name}`) }))
      .filter((candidate) => {
        if (used.has(candidate.index) || candidate.sport == null) return false;
        if (plannedSport != null) return candidate.sport === plannedSport;
        // Generic "cardio" can pair only to an actual recognized endurance
        // effort with at least one concrete dose fact, and remains low confidence.
        return finite(candidate.effort.duration_min) != null || finite(candidate.effort.distance_km) != null;
      })
      .sort((left, right) => matchScore(planned.item, left.effort) - matchScore(planned.item, right.effort) || left.index - right.index);
    const best = candidates[0];
    if (!best) continue;
    used.add(best.index);
    matches.set(planned.index, best.index);
  }

  const evidence = cardioItems.map(({ item, index }): EnduranceEvidence => {
    const label = String(item.exercise ?? item.note ?? "Cardio");
    const plannedSport = enduranceSport(`${item.exercise ?? ""} ${item.note ?? ""}`);
    const compositionItemKey = `composition:${compositionId}:item:${Number(item.position ?? index)}`;
    const intentKey = `endurance:${plannedSport ?? "generic"}:${normalizedExerciseKey(label) || "cardio"}`;
    const effortIndex = matches.get(index);
    const effort = effortIndex == null ? null : efforts[effortIndex];
    if (!effort) {
      return {
        composition_item_key: compositionItemKey,
        intent_key: intentKey,
        prescribed: {
          sport: plannedSport,
          label,
          duration_min: finite(item.target_duration_min),
          distance_km: finite(item.target_distance_km),
          target_zone: item.target_zone == null ? null : String(item.target_zone),
          interval_text: intervalText(item.interval),
        },
        achieved: null,
        match_confidence: "low",
        match_provenance: [],
        zone_verdict: "unknown",
        completion_verdict: "unmatched",
      };
    }

    const actualSport = enduranceSport(`${effort.type} ${effort.name}`)!;
    const summary = observedZoneSummary(effort.zones);
    const zoneKey = targetZoneKey(item.target_zone);
    const metricDifference = matchScore(item, effort);
    const confidence: EnduranceEvidence["match_confidence"] =
      plannedSport == null ? "low" : metricDifference <= 0.35 ? "high" : "moderate";
    return {
      composition_item_key: compositionItemKey,
      intent_key: intentKey,
      prescribed: {
        sport: plannedSport,
        label,
        duration_min: finite(item.target_duration_min),
        distance_km: finite(item.target_distance_km),
        target_zone: item.target_zone == null ? null : String(item.target_zone),
        interval_text: intervalText(item.interval),
      },
      achieved: {
        sport: actualSport,
        type: effort.type,
        name: effort.name,
        duration_min: finite(effort.duration_min),
        distance_km: finite(effort.distance_km),
        pace: effort.pace == null ? null : String(effort.pace),
        avg_hr: finite(effort.avg_hr),
        observed_zone_summary: summary,
        source: effort.source == null ? null : String(effort.source),
      },
      match_confidence: confidence,
      match_provenance: [
        "same_date",
        plannedSport == null ? "generic_cardio" : `canonical_sport:${plannedSport}`,
        `activity_source:${effort.source ?? "manual"}`,
      ],
      zone_verdict:
        zoneKey == null || summary == null
          ? "unknown"
          : summary.some((entry) => entry.zone === zoneKey)
            ? "observed"
            : "not_observed",
      completion_verdict: completionVerdict(item, effort, summary),
    };
  });
  return { evidence, matched_effort_indexes: used };
}

function effortSignature(value: { type: unknown; label?: unknown; duration_min: unknown; distance_km: unknown }): string {
  return [
    enduranceSport(`${value.type ?? ""} ${value.label ?? ""}`) ?? "other",
    finite(value.duration_min) ?? "unknown",
    finite(value.distance_km) ?? "unknown",
  ].join("|");
}

function hasUnmatchedLoadRelevantEndurance(
  efforts: CardioEffort[],
  matchedEffortIndexes: Set<number>,
  impacts: ReturnType<typeof recentEnduranceImpacts>
): boolean {
  const matched = new Map<string, number>();
  for (const index of matchedEffortIndexes) {
    const effort = efforts[index];
    const signature = effortSignature({
      type: effort.type,
      label: effort.name,
      duration_min: effort.duration_min,
      distance_km: effort.distance_km,
    });
    matched.set(signature, (matched.get(signature) ?? 0) + 1);
  }
  for (const impact of impacts.filter(isLoadRelevantEnduranceImpact)) {
    const signature = effortSignature(impact);
    const count = matched.get(signature) ?? 0;
    if (count > 0) {
      matched.set(signature, count - 1);
      continue;
    }
    return true;
  }
  return false;
}

function contextMentions(value: unknown, pattern: RegExp): boolean {
  try {
    return pattern.test(JSON.stringify(value ?? {}).toLowerCase());
  } catch {
    return false;
  }
}

function serverTrainAnyway(composition: any): boolean {
  for (const value of [composition?.constraints, composition?.provenance]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, any>;
    if (record.train_anyway === true || record.daily_decision?.train_anyway === true) return true;
  }
  return false;
}

function challengeVerdict(
  prescribed: MovementDoseEvidence["prescribed"],
  achieved: MovementDoseEvidence["achieved"]
): ChallengeVerdict {
  if (achieved.sets <= 0) return "not_attempted";
  const hasTarget =
    prescribed.sets != null ||
    prescribed.target_weight != null ||
    prescribed.rep_low != null ||
    prescribed.rep_high != null ||
    prescribed.target_seconds != null;
  if (!hasTarget) return "no_target";
  if (prescribed.sets != null && achieved.sets < prescribed.sets) return "under_prescribed";
  const qualifyingSets = achieved.sets_detail.filter(
    (set) =>
      (prescribed.target_weight == null || (set.weight != null && set.weight >= prescribed.target_weight)) &&
      (prescribed.target_seconds == null ||
        (set.duration_sec != null && set.duration_sec >= prescribed.target_seconds)) &&
      (prescribed.rep_low == null || (set.reps != null && set.reps >= prescribed.rep_low))
  ).length;
  if (prescribed.sets != null && qualifyingSets < prescribed.sets) return "under_prescribed";
  const exceeded =
    (prescribed.sets != null && qualifyingSets > prescribed.sets) ||
    (prescribed.target_weight != null &&
      achieved.top_weight != null &&
      achieved.top_weight > prescribed.target_weight) ||
    (prescribed.target_seconds != null &&
      achieved.top_seconds != null &&
      achieved.top_seconds > prescribed.target_seconds) ||
    (prescribed.rep_high != null && achieved.top_reps != null && achieved.top_reps > prescribed.rep_high);
  return exceeded ? "exceeded" : "met";
}

// Reconcile one session's daily-session composition against what was logged.
// Idempotent: re-running for the same composition upserts the same row. Returns
// the stored outcome, or null when the session has no daily-session composition
// (a plain plan/legacy session — nothing bespoke to reconcile).
export function reconcileDailySession(sessionId: number): DailySessionOutcome | null {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as any;
  if (!session) return null;
  const composition = getActiveDailySessionForSession(id) as any;
  if (!composition) return null;

  const date = String(session.date ?? localDateISO()).slice(0, 10);
  const allItems = Array.isArray(composition.items) ? composition.items : [];
  const items = allItems.filter(
    (it: any) => it && it.kind !== "cardio" && it.exercise
  );
  const cardioItems = allItems
    .map((item: any, index: number) => ({ item, index }))
    .filter(({ item }: { item: any }) => item && item.kind === "cardio");
  const cardioEfforts = getCardioForDate(date);
  const enduranceMatch = enduranceEvidenceFor(Number(composition.id), cardioItems, cardioEfforts);
  const endurance_evidence = enduranceMatch.evidence;
  const matchedEndurance = endurance_evidence.filter((entry) => entry.completion_verdict !== "unmatched");
  const suggestedExercises: string[] = items.map((it: any) => String(it.exercise));
  const suggestedSet = new Set(suggestedExercises.map(lower));

  const sets = loggedSetsFor(id);
  const skips = skipsFor(id);

  // Aggregate achieved work per exercise (top weight / reps / seconds).
  const achievedMap = new Map<
    string,
    {
      exercise: string;
      sets: number;
      top_weight: number | null;
      top_reps: number | null;
      top_seconds: number | null;
      total_reps: number;
      total_seconds: number;
      sets_detail: Array<{ weight: number | null; reps: number | null; duration_sec: number | null }>;
      muscle_group: string | null;
      firstId: number;
    }
  >();
  const loggedOrder: string[] = [];
  for (const s of sets) {
    const key = lower(s.exercise);
    if (!achievedMap.has(key)) {
      achievedMap.set(key, {
        exercise: String(s.exercise),
        sets: 0,
        top_weight: null,
        top_reps: null,
        top_seconds: null,
        total_reps: 0,
        total_seconds: 0,
        sets_detail: [],
        muscle_group: s.muscle_group == null ? null : String(s.muscle_group),
        firstId: Number(s.id),
      });
      loggedOrder.push(key);
    }
    const agg = achievedMap.get(key)!;
    agg.sets += 1;
    const w = finite(s.weight);
    if (w != null && (agg.top_weight == null || w > agg.top_weight)) agg.top_weight = w;
    const r = finite(s.reps);
    if (r != null && (agg.top_reps == null || r > agg.top_reps)) agg.top_reps = r;
    if (r != null) agg.total_reps += r;
    const sec = finite(s.duration_sec);
    if (sec != null && (agg.top_seconds == null || sec > agg.top_seconds)) agg.top_seconds = sec;
    if (sec != null) agg.total_seconds += sec;
    agg.sets_detail.push({
      weight: finite(s.weight),
      reps: r,
      duration_sec: sec,
    });
  }

  const loggedExercises = [...achievedMap.values()].map((a) => a.exercise);
  const completed = suggestedExercises.filter((ex) => achievedMap.has(lower(ex)));
  const substituted = loggedExercises.filter((ex) => !suggestedSet.has(lower(ex)));
  const skippedSuggested = suggestedExercises.filter((ex) => !achievedMap.has(lower(ex)));
  const skipped = Array.from(new Set([...skippedSuggested, ...skips.filter((s) => suggestedSet.has(lower(s)))]));

  // Reordered: the order suggested-and-logged exercises were actually trained in
  // differs from the composition's prescribed order.
  const suggestedLoggedOrder = loggedOrder.filter((k) => suggestedSet.has(k));
  const prescribedOrder = suggestedExercises.map(lower).filter((k) => achievedMap.has(k));
  const reordered = suggestedLoggedOrder.join("|") !== prescribedOrder.join("|");

  // Full prescribed/achieved dose. Stable identity is independent of mutable
  // display order across compositions: movement + intent survive later rewrites,
  // while composition_item_key anchors the exact historical item.
  const dose_evidence: MovementDoseEvidence[] = items.map((it: any, index: number) => {
    const agg = achievedMap.get(lower(it.exercise));
    const exercise = {
      name: String(it.exercise),
      muscle_group: agg?.muscle_group ?? null,
    };
    const symptomEvents = activeRelevantTrainingSymptoms(date, exercise);
    const prescribed: MovementDoseEvidence["prescribed"] = {
      sets: finite(it.sets),
      rep_low: finite(it.rep_low),
      rep_high: finite(it.rep_high),
      target_weight: finite(it.target_weight),
      target_seconds: finite(it.target_seconds),
    };
    const achievedDose: MovementDoseEvidence["achieved"] = {
      sets: agg?.sets ?? 0,
      top_weight: agg?.top_weight ?? null,
      top_reps: agg?.top_reps ?? null,
      top_seconds: agg?.top_seconds ?? null,
      total_reps: agg?.total_reps ?? 0,
      total_seconds: agg?.total_seconds ?? 0,
      sets_detail: agg?.sets_detail ?? [],
    };
    const movement_key = movementIdentity(String(it.exercise));
    const intent_key = intentIdentity(it);
    return {
      composition_item_key: `composition:${Number(composition.id)}:item:${Number(it.position ?? index)}`,
      movement_key,
      intent_key,
      exercise: String(it.exercise),
      mode: it.mode === "timed" || finite(it.target_seconds) != null ? "timed" : "reps",
      prescribed,
      achieved: achievedDose,
      challenge_verdict: challengeVerdict(prescribed, achievedDose),
      relevant_symptom:
        (!!session.joint_pain && painAreaLoadsExercise(String(session.joint_pain), exercise)) ||
        symptomEvents.length > 0,
      symptom_event_ids: symptomEvents.map((event) => event.id),
    };
  });

  // Legacy progression_evidence remains readable for existing consumers, with
  // additive stable identity and the stricter whole-dose verdict.
  const progression_evidence = dose_evidence.map((dose) => {
    const targetWeight = dose.prescribed.target_weight;
    const targetSeconds = dose.prescribed.target_seconds;
    const achievedWeight = dose.achieved.top_weight;
    const achievedSeconds = dose.achieved.top_seconds;
    const whole = dose.challenge_verdict;
    const verdict: "met_or_exceeded" | "under_target" | "no_target" =
      whole === "met" || whole === "exceeded"
        ? "met_or_exceeded"
        : whole === "no_target"
          ? "no_target"
          : "under_target";
    return {
      composition_item_key: dose.composition_item_key,
      movement_key: dose.movement_key,
      intent_key: dose.intent_key,
      exercise: dose.exercise,
      target_sets: dose.prescribed.sets,
      achieved_sets: dose.achieved.sets,
      target_weight: targetWeight,
      achieved_weight: achievedWeight,
      target_rep_low: dose.prescribed.rep_low,
      target_rep_high: dose.prescribed.rep_high,
      achieved_reps: dose.achieved.top_reps,
      target_seconds: targetSeconds,
      achieved_seconds: achievedSeconds,
      verdict,
      challenge_verdict: whole,
    };
  });

  const started = sets.length > 0 || matchedEndurance.length > 0;
  const finished = !!session.finished_at;
  const cardioOnlyCompleted = items.length === 0 && cardioItems.length > 0 && matchedEndurance.length > 0;
  const status: DailySessionOutcome["status"] =
    finished || cardioOnlyCompleted ? "completed" : started ? "in_progress" : "not_started";

  const enduranceImpacts = recentEnduranceImpacts(1, date);
  const otherActivity = hasUnmatchedLoadRelevantEndurance(
    cardioEfforts,
    enduranceMatch.matched_effort_indexes,
    enduranceImpacts
  );
  const conf = confounders(session, date, otherActivity);
  const enduranceDoseShortfall =
    matchedEndurance.length > 0 &&
    endurance_evidence.some((entry) => entry.completion_verdict === "dose_shortfall");
  const enduranceQualityNotObserved = endurance_evidence.some(
    (entry) => entry.completion_verdict === "quality_not_observed"
  );
  const enduranceQualityUnverified = endurance_evidence.some(
    (entry) => entry.completion_verdict === "quality_unverified"
  );
  const enduranceIncomplete =
    cardioItems.length > 0 &&
    started &&
    endurance_evidence.some((entry) => entry.completion_verdict === "unmatched");
  const reason_codes: string[] = [];
  if (!started) {
    reason_codes.push("not_started");
  } else if (substituted.length && !completed.length) {
    reason_codes.push("substituted_movements");
  } else {
    if (completed.length >= suggestedExercises.length && suggestedExercises.length > 0 && !substituted.length) {
      reason_codes.push("completed_as_suggested");
    } else if (skipped.length) {
      reason_codes.push("partial_session");
    }
    if (substituted.length) reason_codes.push("substituted_movements");
    if (!skipped.length && substituted.length && completed.length >= suggestedExercises.length) {
      reason_codes.push("extended_session");
    }
  }
  if (matchedEndurance.length > 0) reason_codes.push("endurance_matched");
  if (enduranceDoseShortfall) reason_codes.push("endurance_dose_shortfall");
  if (enduranceQualityNotObserved) reason_codes.push("endurance_quality_not_observed");
  if (enduranceQualityUnverified) reason_codes.push("endurance_quality_unverified");
  if (endurance_evidence.some((entry) => entry.completion_verdict === "quality_observed")) {
    reason_codes.push("endurance_quality_observed");
  }
  const enduranceCompletedAsSuggested =
    cardioItems.length > 0 &&
    matchedEndurance.length === cardioItems.length &&
    endurance_evidence.every((entry) =>
      ["met_or_exceeded", "quality_observed"].includes(entry.completion_verdict)
    );
  if (
    enduranceDoseShortfall ||
    enduranceIncomplete ||
    enduranceQualityNotObserved ||
    enduranceQualityUnverified
  ) {
    const completedIndex = reason_codes.indexOf("completed_as_suggested");
    if (completedIndex >= 0) reason_codes.splice(completedIndex, 1);
    if ((enduranceDoseShortfall || enduranceIncomplete) && !reason_codes.includes("partial_session")) {
      reason_codes.push("partial_session");
    }
  } else if (
    enduranceCompletedAsSuggested &&
    items.length === 0 &&
    !reason_codes.includes("completed_as_suggested")
  ) {
    reason_codes.push("completed_as_suggested");
  }
  // A reduction with a legitimate confounder is explicitly NOT poor adherence.
  if ((skipped.length || substituted.length) && conf.length) reason_codes.push("explained_by_context");

  const confidence: DailySessionOutcomeFacts["confidence"] = !started
    ? "low"
    : items.length === 0 && cardioItems.length > 0
      ? endurance_evidence.every(
          (entry) =>
            ["met_or_exceeded", "quality_observed"].includes(entry.completion_verdict) &&
            entry.match_confidence === "high"
        )
        ? "high"
        : endurance_evidence.some((entry) => entry.match_confidence === "moderate")
          ? "moderate"
          : "low"
      : finished && completed.length >= Math.max(1, Math.ceil(suggestedExercises.length * 0.6))
        ? "high"
        : "moderate";

  const recovery =
    ["active", "recheck"].includes(recoveryCycleAt(date)?.effective_status ?? "") ||
    contextMentions(composition.constraints, /\brecovery\b|\bdeload\b/) ||
    contextMentions(composition.provenance, /\brecovery\b|\bdeload\b/);
  const athleteOverride =
    composition.source === "athlete_override" ||
    serverTrainAnyway(composition);
  const travel = conf.includes("travel_window");
  const illness = conf.includes("illness_window");
  const symptom = dose_evidence.some((dose) => dose.relevant_symptom);
  const endurance =
    conf.includes("other_activity") ||
    (items.length > 0 && matchedEndurance.length > 0) ||
    (items.length > 0 && session.kind === "cardio");
  const partial =
    reason_codes.includes("partial_session") ||
    enduranceDoseShortfall ||
    enduranceIncomplete ||
    dose_evidence.some((dose) => dose.prescribed.sets != null && dose.achieved.sets < dose.prescribed.sets);
  const nonComparable = [
    recovery ? "recovery_dose" : null,
    athleteOverride ? "athlete_override" : null,
    travel ? "travel" : null,
    illness ? "illness" : null,
    symptom ? "relevant_symptom" : null,
    endurance ? "loaded_endurance" : null,
    enduranceQualityNotObserved ? "endurance_quality_not_observed" : null,
    enduranceQualityUnverified ? "endurance_quality_unverified" : null,
    partial ? "partial" : null,
  ].filter((reason): reason is string => reason != null);
  const dose_context: DoseContext = {
    recovery,
    athlete_override: athleteOverride,
    travel,
    illness,
    symptom,
    endurance,
    partial,
    comparable: nonComparable.length === 0,
    non_comparable_reasons: nonComparable,
  };

  const facts: DailySessionOutcomeFacts = {
    schema_version: 2,
    suggested_count: suggestedExercises.length,
    suggested_exercises: suggestedExercises,
    logged_exercises: loggedExercises,
    completed,
    substituted,
    skipped,
    reordered,
    achieved: [...achievedMap.values()].map((value) => ({
      exercise: value.exercise,
      sets: value.sets,
      top_weight: value.top_weight,
      top_reps: value.top_reps,
      top_seconds: value.top_seconds,
    })),
    progression_evidence,
    dose_evidence,
    endurance_evidence,
    dose_context,
    feedback: {
      soreness: finite(session.soreness),
      performance: finite(session.performance),
      joint_pain: session.joint_pain != null && String(session.joint_pain).trim() ? String(session.joint_pain) : null,
    },
    confounders: conf,
    reason_codes,
    confidence,
  };

  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(composition_id) DO UPDATE SET
       status = excluded.status, facts_json = excluded.facts_json, updated_at = datetime('now')`
  ).run(Number(composition.id), id, date, status, JSON.stringify(facts));

  return { composition_id: Number(composition.id), session_id: id, date, status, facts };
}

// Best-effort variant for write hooks (finishSession / setSessionFeedback): a
// reconciliation failure must never break the underlying session write.
export function reconcileDailySessionSafe(sessionId: number): void {
  try {
    reconcileDailySession(sessionId);
  } catch {
    /* additive learning is never load-bearing on the write path */
  }
}

export function reconcileDailySessionsForDateSafe(date: string): void {
  const readDate = String(date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(readDate)) return;
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT s.id
         FROM sessions s
         JOIN daily_session_compositions dsc
           ON dsc.session_id = s.id AND dsc.status = 'active'
         WHERE s.date = ?`
      )
      .all(readDate) as any[];
    for (const row of rows) reconcileDailySessionSafe(Number(row.id));
  } catch {
    /* same additive best-effort boundary as single-session reconciliation */
  }
}

registerDailyOutcomeReconcileHook(reconcileDailySessionsForDateSafe);

export function getDailySessionOutcome(date?: string): DailySessionOutcome | null {
  const d = String(date || localDateISO()).slice(0, 10);
  const row = db.prepare(`SELECT * FROM daily_session_outcomes WHERE date = ? ORDER BY id DESC LIMIT 1`).get(d) as any;
  if (!row) return null;
  let facts: DailySessionOutcomeFacts;
  try {
    facts = JSON.parse(row.facts_json);
  } catch {
    return null;
  }
  return {
    composition_id: Number(row.composition_id),
    session_id: Number(row.session_id),
    date: String(row.date),
    status: row.status,
    facts,
  };
}

export function getDailySessionOutcomeForSession(sessionId: number): DailySessionOutcome | null {
  const row = db
    .prepare(`SELECT * FROM daily_session_outcomes WHERE session_id = ? ORDER BY id DESC LIMIT 1`)
    .get(Number(sessionId)) as any;
  if (!row) return null;
  let facts: DailySessionOutcomeFacts;
  try {
    facts = JSON.parse(row.facts_json);
  } catch {
    return null;
  }
  return {
    composition_id: Number(row.composition_id),
    session_id: Number(row.session_id),
    date: String(row.date),
    status: row.status,
    facts,
  };
}
