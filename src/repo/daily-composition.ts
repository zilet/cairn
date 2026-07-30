import { normalizeSessionSuggestionResult } from "./adaptive-session.js";
import { cardioPlanIdentity } from "./cardio-plan-identity.js";
import { canonicalGroup } from "./exercise-canon.js";
import { cardioPainRelevance, type DailyDecisionEnvelope } from "./daily-decision.js";
import {
  equipmentCompatibility,
  inferExerciseEquipment,
  parseEquipmentCapability,
} from "./equipment-capability.js";
import { findExercise, recentWorkingSeconds, recentWorkingWeight } from "./exercises.js";
import { getPlanDay } from "./plan.js";
import { adaptBasePlanDayForRecovery } from "./recovery-cycles.js";

// Stage 3 of the adaptive daily training plan — bounded agent composition.
// The agent composes INSIDE the deterministic Stage 2 envelope; it never
// redefines safety. This module is the server-side normalizer + deterministic
// fallback that make that boundary real: every agent item is re-verified,
// clamped, and checked against the envelope's exclusions/caps and the
// safe-exercise-introduction rules, and any invalid/empty/over-excluded output
// falls back to a usable deterministic session built from the same envelope.

export interface ComposedSession {
  name: string | null;
  focus: string | null;
  why: string | null;
  est_minutes: number | null;
  items: any[];
}

export interface CompositionValidation {
  ok: boolean;
  reason: string | null;
  rejected: Array<{ exercise: string; reason: string }>;
  novel_introduced: number;
  capped: boolean;
}

function volumeCap(envelope: DailyDecisionEnvelope): number {
  switch (envelope.caps.volume) {
    case "minimal":
      return 4;
    case "reduced":
      return 7;
    default:
      return 12;
  }
}

function workingSetCap(envelope: DailyDecisionEnvelope): number {
  switch (envelope.caps.volume) {
    case "minimal":
      return 6;
    case "reduced":
      return 12;
    default:
      return 24;
  }
}

// The REDUCED areas are a safety decision the server already made — a group that
// is still carrying recent work, or one running above its productive volume.
// Until now `reduced` reached the session as a LINE IN THE PROMPT ("keep light,
// do NOT overload") and NOTHING else, so an agent that ignored it was never
// corrected. That breaks the law the rest of this module exists to enforce:
// safety logic is deterministic, agents only phrase it.
//
// It CLAMPS rather than rejects, because "reduced" means less, not none. The
// envelope deliberately still ALLOWS these areas; dropping their items would
// silently delete work the plan calls for and hand the athlete a thinner session
// than anyone decided on. So sets come down and the target is eased, and both
// compose with (never override) any deeper day-level easing already in force.
const REDUCED_ITEM_SET_CAP = 2;
const REDUCED_INTENSITY_FACTOR = 0.9;

function perItemSetCap(envelope: DailyDecisionEnvelope): number {
  switch (envelope.caps.volume) {
    case "minimal":
      return 2;
    case "reduced":
      return 3;
    default:
      return 6;
  }
}

function scaledTarget(value: unknown, factor: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return value == null ? null : Number(value);
  // Negative weight means assistance. Multiplying it toward zero would make
  // the movement harder, so retain the known safe anchor instead.
  if (n < 0) return n;
  return Math.round(n * factor * 100) / 100;
}

function adaptationNote(note: unknown, text: string): string {
  const existing = String(note ?? "").trim();
  if (!existing) return text;
  if (existing.toLowerCase().includes(text.toLowerCase())) return existing.slice(0, 500);
  return `${text}. ${existing}`.slice(0, 500);
}

function trustedCandidateMetadata(candidate: DailyDecisionEnvelope["candidates"][number] | undefined) {
  if (!candidate) return {};
  return {
    brain_decision_id: candidate.brain_decision_id ?? null,
    brain_change_summary: candidate.brain_change_summary ?? null,
    brain_change_reason: candidate.brain_change_reason ?? null,
    brain_change_reason_provenance: candidate.brain_change_reason_provenance ?? null,
    brain_change_reversible: candidate.brain_change_reversible ?? null,
  };
}

function applyAuthorizedTarget(item: any, candidate: DailyDecisionEnvelope["candidates"][number] | undefined): boolean {
  const target = candidate?.authorized_target;
  if (!target) return false;
  let changed = false;
  const assign = (key: string, value: number | null) => {
    if (item[key] !== value) {
      item[key] = value;
      changed = true;
    }
  };
  // The progression target owns challenge (rep range, load, or duration), while
  // the accepted daily composition owns volume. Keeping those responsibilities
  // separate lets recovery-cycle fractions and legitimate one-day set changes
  // survive without giving the agent freedom to invent a heavier target.
  assign("rep_low", target.mode === "timed" ? null : target.rep_low);
  assign("rep_high", target.mode === "timed" ? null : target.rep_high);
  assign("target_weight", target.mode === "timed" ? null : target.target_weight);
  assign("target_seconds", target.mode === "timed" ? target.target_seconds : null);
  if (item.mode !== target.mode) {
    item.mode = target.mode;
    changed = true;
  }
  return changed;
}

function applyRecoveryCycleTarget(item: any, envelope: DailyDecisionEnvelope): boolean {
  const cycle = envelope.recovery_cycle;
  if (!cycle || (cycle.effective_status !== "active" && cycle.effective_status !== "recheck")) return false;
  const adapted = adaptBasePlanDayForRecovery(
    { items: [item] },
    { working_set_fraction: cycle.working_set_fraction }
  ).items[0];
  if (!adapted) return false;
  Object.assign(item, adapted);
  return true;
}

function finite(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function holdAnchor(exercise: string, envelope: DailyDecisionEnvelope) {
  const planDay = envelope.template.day_number == null ? null : (getPlanDay(envelope.template.day_number) as any);
  const planned = (Array.isArray(planDay?.items) ? planDay.items : []).find(
    (item: any) => String(item?.exercise ?? "").toLowerCase() === exercise.toLowerCase()
  );
  const mode = findExercise(exercise)?.mode === "timed" || planned?.mode === "timed" ? "timed" : "reps";
  if (mode === "timed") {
    return {
      mode,
      target_seconds: recentWorkingSeconds(exercise) ?? finite(planned?.target_seconds),
      target_weight: null,
    };
  }
  return {
    mode,
    target_seconds: null,
    target_weight: recentWorkingWeight(exercise) ?? finite(planned?.target_weight),
  };
}

function clampHeldTarget(item: any, envelope: DailyDecisionEnvelope): boolean {
  const anchor = holdAnchor(String(item.exercise ?? ""), envelope);
  let changed = false;
  if (anchor.mode === "timed") {
    if (item.target_weight != null) {
      item.target_weight = null;
      changed = true;
    }
    const requested = finite(item.target_seconds);
    if (anchor.target_seconds != null && requested != null && requested > anchor.target_seconds) {
      item.target_seconds = anchor.target_seconds;
      changed = true;
    }
    return changed;
  }

  const requested = finite(item.target_weight);
  const baseline = anchor.target_weight;
  if (baseline == null) {
    if (item.target_weight != null) {
      item.target_weight = null;
      changed = true;
    }
    return changed;
  }
  // Positive weight is external load, so larger is harder. Negative weight is
  // assistance, so closer to zero is harder. A hold may move easier in either
  // regime, but it may never cross the authoritative working/planned anchor.
  if (requested == null || requested > baseline) {
    item.target_weight = baseline;
    changed = true;
  }
  return changed;
}

const HARD_CARDIO_LANGUAGE =
  /\b(?:all[- ]?out|anaerobic|fast|hard|hill repeats?|intervals?|race pace|sprints?|tempo|threshold|vo2(?:\s*max)?|z(?:one\s*)?[3-5])\b/i;

function easyCardioName(exercise: unknown): string {
  const text = String(exercise ?? "").toLowerCase();
  if (/\b(?:run|running|jog|jogging)\b/.test(text)) return "Easy run";
  if (/\b(?:ride|riding|bike|biking|cycle|cycling)\b/.test(text)) return "Easy ride";
  if (/\b(?:row|rowing|erg)\b/.test(text)) return "Easy row";
  if (/\b(?:swim|swimming)\b/.test(text)) return "Easy swim";
  if (/\b(?:hike|hiking)\b/.test(text)) return "Easy hike";
  if (/\b(?:walk|walking)\b/.test(text)) return "Easy walk";
  return "Easy cardio";
}

function safeEasySessionText(value: string | null, fallback: string): string {
  return value && !HARD_CARDIO_LANGUAGE.test(value) ? value : fallback;
}

function clampCardioItem(item: any, envelope: DailyDecisionEnvelope, forceEasy: boolean): boolean {
  let changed = false;
  const durationCap = envelope.caps.duration_min;
  const requestedDuration = finite(item.target_duration_min);
  const requestedDistance = finite(item.target_distance_km);

  if (durationCap != null) {
    if (requestedDuration == null || requestedDuration > durationCap) {
      item.target_duration_min = durationCap;
      changed = true;
    }
    if (requestedDistance != null && requestedDuration != null && requestedDuration > durationCap) {
      const scaledDistance = Math.round(requestedDistance * (durationCap / requestedDuration) * 100) / 100;
      if (scaledDistance !== requestedDistance) {
        item.target_distance_km = scaledDistance;
        changed = true;
      }
    }
  }

  if (forceEasy) {
    const easyName = easyCardioName(item.exercise);
    if (item.exercise !== easyName) {
      item.exercise = easyName;
      changed = true;
    }
    if (item.target_zone !== "easy") {
      item.target_zone = "easy";
      changed = true;
    }
    if (item.interval != null) {
      item.interval = null;
      changed = true;
    }
    // A distance target can silently preserve the hard pace after duration is
    // shortened. The envelope has no pace anchor, so a restrictive day remains
    // time-based and conversational instead of inventing a "safe" distance.
    if (item.target_distance_km != null) {
      item.target_distance_km = null;
      changed = true;
    }
    const note = "Easy conversational effort; no intervals today";
    if (item.note !== note) {
      item.note = note;
      changed = true;
    }
  }
  return changed;
}

function baselineNote(note: string | null): string {
  const base = "NEW — establishing a baseline; keep it light and log the actual load";
  const trimmed = (note ?? "").trim();
  if (!trimmed) return base;
  if (/baseline/i.test(trimmed)) return trimmed.slice(0, 500);
  return `${base}. ${trimmed}`.slice(0, 500);
}

// Verify + clamp an agent composition against the envelope. Returns a normalized
// session (identical in shape to a session suggestion) or null when nothing
// usable survives. Enforced here, never trusted from the agent:
//   - every item re-runs the agent-source normalization (load clamps, shape);
//   - items loading an EXCLUDED muscle group are dropped;
//   - at most ONE novel (not-yet-known) movement family is admitted, with no
//     falsely precise load and a baseline label;
//   - item count and duration are clamped to the envelope caps.
export function normalizeComposedSession(
  raw: unknown,
  envelope: DailyDecisionEnvelope
): { session: ComposedSession | null; validation: CompositionValidation } {
  const base = normalizeSessionSuggestionResult(raw);
  const rejected: Array<{ exercise: string; reason: string }> = [];
  if (!base) {
    return {
      session: null,
      validation: { ok: false, reason: "unparseable", rejected, novel_introduced: 0, capped: false },
    };
  }
  if (envelope.kind === "rest" && envelope.request.train_anyway !== true) {
    for (const item of base.items) {
      rejected.push({ exercise: String(item.exercise), reason: "rest_requires_train_anyway" });
    }
    return {
      session: null,
      validation: {
        ok: false,
        reason: "rest_requires_train_anyway",
        rejected,
        novel_introduced: 0,
        capped: false,
      },
    };
  }
  const excluded = new Set(envelope.muscles.excluded.map((g) => g.toLowerCase()));
  const reducedGroups = new Set(
    (Array.isArray(envelope.muscles.reduced) ? envelope.muscles.reduced : []).map(
      (g) => canonicalGroup(g) ?? String(g).toLowerCase()
    )
  );
  // Resolved on the way past, while the stored exercise (and so its group) is in
  // hand — the clamping pass below works on item names alone.
  const reducedExercises = new Set<string>();
  const hasProtectiveExclusion = envelope.hard_constraints.some((entry) => entry.code === "injury_exclusion");
  const protectiveExclusions = Array.isArray(envelope.protective_exclusions)
    ? envelope.protective_exclusions
    : null;
  const candidates = new Map(envelope.candidates.map((candidate) => [candidate.exercise.toLowerCase(), candidate]));
  const equipmentCapability = parseEquipmentCapability(envelope.request.equipment);
  let novelCount = 0;
  const kept: any[] = [];
  for (const item of base.items) {
    const isCardio = item.kind === "cardio";
    const exercise = isCardio
      ? cardioPlanIdentity(item).movement_label
      : String(item.exercise ?? "");
    if (isCardio) item.exercise = exercise;
    const candidate = candidates.get(exercise.toLowerCase());
    if (envelope.kind === "rest" && item.kind !== "cardio" && envelope.request.train_anyway !== true) {
      rejected.push({ exercise, reason: "rest_requires_train_anyway" });
      continue;
    }
    if (candidate?.action === "exclude") {
      rejected.push({ exercise, reason: "excluded_candidate" });
      continue;
    }
    if (
      isCardio &&
      envelope.reported_joint_pain &&
      cardioPainRelevance(exercise, [envelope.reported_joint_pain]) === true
    ) {
      rejected.push({ exercise, reason: "cardio_pain_relevant" });
      continue;
    }
    if (isCardio && hasProtectiveExclusion) {
      // Historical envelopes did not retain structured areas. Under a live hard
      // exclusion, absence of that evidence is uncertifiable rather than safe.
      if (protectiveExclusions == null) {
        rejected.push({ exercise, reason: "cardio_uncertified_under_exclusions" });
        continue;
      }
      const exactExcluded = protectiveExclusions.some((exclusion) =>
        exclusion.exercises.some(
          (excludedExercise) => excludedExercise.trim().toLowerCase() === exercise.trim().toLowerCase()
        )
      );
      const painRelevance = cardioPainRelevance(
        exercise,
        protectiveExclusions.flatMap((exclusion) => exclusion.areas)
      );
      if (exactExcluded || painRelevance !== false) {
        rejected.push({
          exercise,
          reason: exactExcluded ? "excluded_candidate" : "cardio_uncertified_under_exclusions",
        });
        continue;
      }
    }
    const stored = isCardio ? null : findExercise(exercise);
    if (!isCardio && equipmentCapability.recognized && equipmentCapability.restricted) {
      const compatibility = equipmentCompatibility(
        equipmentCapability,
        inferExerciseEquipment(item.exercise, stored?.equipment)
      );
      if (compatibility !== "compatible") {
        rejected.push({
          exercise,
          reason: compatibility === "incompatible" ? "equipment_incompatible" : "equipment_unverified",
        });
        continue;
      }
    }
    const group = stored?.muscle_group ? String(stored.muscle_group).toLowerCase() : null;
    if (group && excluded.has(group)) {
      rejected.push({ exercise, reason: "excluded_group" });
      continue;
    }
    if (group && reducedGroups.has(canonicalGroup(group) ?? group)) reducedExercises.add(exercise.toLowerCase());
    const novel = !isCardio && !stored;
    if (novel) {
      // A novel movement is not in the canon, so it carries no muscle_group and the
      // excluded-group filter above cannot verify what area it loads. When the envelope
      // excludes ANY muscle group, refuse novel introductions entirely — the server
      // cannot certify an unknown movement avoids the excluded area — and keep the rest
      // of the composition (the agent is told to compose from the canon in this case).
      if (excluded.size) {
        rejected.push({ exercise, reason: "novel_blocked_by_exclusions" });
        continue;
      }
      if (novelCount >= 1) {
        rejected.push({ exercise, reason: "extra_novel_movement" });
        continue;
      }
      novelCount++;
      // No performance baseline exists — never prescribe a falsely precise load.
      item.target_weight = null;
      item.note = baselineNote(item.note == null ? null : String(item.note));
    }
    kept.push(item);
  }
  if (!kept.length) {
    return {
      session: null,
      validation: { ok: false, reason: "all_items_excluded", rejected, novel_introduced: novelCount, capped: false },
    };
  }
  const cap = volumeCap(envelope);
  const itemSetCap = perItemSetCap(envelope);
  let remainingSets = workingSetCap(envelope);
  let changed = kept.length > cap;
  const forceEasyCardio =
    envelope.request.train_anyway === true ||
    envelope.caps.intensity === "easy" ||
    envelope.caps.intensity === "deload";
  let hasEasyCardio = false;
  const capped: any[] = [];
  for (const item of kept.slice(0, cap)) {
    const next = { ...item };
    const candidate = candidates.get(String(next.exercise ?? "").toLowerCase());
    if (next.kind === "cardio") {
      if (applyRecoveryCycleTarget(next, envelope)) changed = true;
      if (clampCardioItem(next, envelope, forceEasyCardio)) changed = true;
      Object.assign(next, trustedCandidateMetadata(candidate));
      if (forceEasyCardio) hasEasyCardio = true;
      capped.push(next);
      continue;
    }
    const requestedSets = Math.max(1, Number(next.sets) || 1);
    if (applyAuthorizedTarget(next, candidate)) changed = true;
    if (applyRecoveryCycleTarget(next, envelope)) changed = true;
    Object.assign(next, trustedCandidateMetadata(candidate));
    const isReduced = reducedExercises.has(String(next.exercise ?? "").toLowerCase());
    const authorizedSets = Math.max(1, Number(next.sets) || requestedSets);
    const setCapForItem = isReduced ? Math.min(itemSetCap, REDUCED_ITEM_SET_CAP) : itemSetCap;
    const boundedSets = Math.min(authorizedSets, setCapForItem, remainingSets);
    if (boundedSets < 1) {
      changed = true;
      continue;
    }
    if (boundedSets !== requestedSets || boundedSets !== authorizedSets) changed = true;
    next.sets = boundedSets;
    remainingSets -= boundedSets;

    let intensityFactor = 1;
    if (envelope.caps.intensity === "easy") intensityFactor = 0.8;
    else if (envelope.caps.intensity === "deload") intensityFactor = 0.9;
    // An authoritative progression deload target is already reduced by the
    // progression engine. Apply the legacy 10% fallback only when no exact
    // target crossed the decision boundary; independent day-level safety caps
    // (easy/recovery) may still reduce the exact target further.
    if (candidate?.action === "deload" && !candidate.authorized_target) {
      intensityFactor = Math.min(intensityFactor, 0.9);
    }
    // A reduced area never gets a heavier target than the day already allows.
    if (isReduced) intensityFactor = Math.min(intensityFactor, REDUCED_INTENSITY_FACTOR);
    const hold = candidate?.action === "hold" || envelope.caps.intensity === "hold";
    if (hold && clampHeldTarget(next, envelope)) changed = true;
    if (intensityFactor < 1) {
      if (next.mode === "timed" && next.target_seconds != null) {
        const seconds = Math.max(1, Math.round(Number(next.target_seconds) * intensityFactor));
        if (seconds !== next.target_seconds) changed = true;
        next.target_seconds = seconds;
      } else if (next.target_weight != null) {
        const weight = scaledTarget(next.target_weight, intensityFactor);
        if (weight !== next.target_weight) changed = true;
        next.target_weight = weight;
      }
      next.note = adaptationNote(
        next.note,
        isReduced ? "Kept light — this area is still carrying recent work" : "Eased for today"
      );
    } else if (hold) {
      next.note = adaptationNote(next.note, "Holding the current target today");
    }
    capped.push(next);
  }
  let est = base.est_minutes;
  if (envelope.caps.duration_min != null && (est == null || est > envelope.caps.duration_min)) {
    est = envelope.caps.duration_min;
    changed = true;
  }
  const fallbackWhy = envelope.rationale[0]?.text ?? "Keep today's work light and conversational.";
  return {
    session: {
      name: hasEasyCardio ? safeEasySessionText(base.name, "Easy session") : base.name,
      focus: hasEasyCardio ? safeEasySessionText(base.focus, "Easy movement") : base.focus,
      why: hasEasyCardio ? safeEasySessionText(base.why, fallbackWhy) : base.why,
      est_minutes: est,
      items: capped,
    },
    validation: {
      ok: true,
      reason: null,
      rejected,
      novel_introduced: novelCount,
      capped: changed,
    },
  };
}

function planItemToRaw(it: any): Record<string, unknown> {
  if (it?.kind === "cardio") {
    const identity = cardioPlanIdentity(it);
    return {
      kind: "cardio",
      exercise: identity.movement_label,
      target_distance_km: it.target_distance_km ?? null,
      target_duration_min: it.target_duration_min ?? null,
      target_zone: it.target_zone ?? null,
      interval: it.interval ?? it.interval_json ?? null,
      note: it.note ?? null,
      brain_decision_id: it.brain_decision_id ?? null,
      brain_change_summary: it.brain_change_summary ?? null,
      brain_change_reason: it.brain_change_reason ?? null,
      brain_change_reason_provenance: it.brain_change_reason_provenance ?? null,
      brain_change_reversible: it.brain_change_reversible ?? null,
    };
  }
  return {
    exercise: it.exercise,
    sets: it.sets ?? 3,
    rep_low: it.rep_low ?? null,
    rep_high: it.rep_high ?? null,
    target_weight: it.mode === "timed" ? null : (it.target_weight ?? null),
    target_seconds: it.mode === "timed" ? (it.target_seconds ?? null) : null,
    mode: it.mode ?? "reps",
    warmup_sets: it.warmup_sets ?? null,
    note: it.note ?? null,
    brain_decision_id: it.brain_decision_id ?? null,
    brain_change_summary: it.brain_change_summary ?? null,
    brain_change_reason: it.brain_change_reason ?? null,
    brain_change_reason_provenance: it.brain_change_reason_provenance ?? null,
    brain_change_reversible: it.brain_change_reversible ?? null,
  };
}

// The deterministic session used when the agent is absent, times out, or returns
// nothing usable (docs §5: agent absence never blocks a usable session). Built
// from the envelope's own template day (exclusions applied) so it always honors
// the same safety bounds. Falls back to a short easy-movement session when there
// is no plan day (custom/rest intent). Returned as a RAW payload so it flows back
// through `normalizeComposedSession` and shares the agent path's exact shape.
export function deterministicSessionRawFromEnvelope(envelope: DailyDecisionEnvelope): Record<string, unknown> {
  const excluded = new Set(envelope.muscles.excluded.map((g) => g.toLowerCase()));
  const equipmentCapability = parseEquipmentCapability(envelope.request.equipment);
  const items: Array<Record<string, unknown>> = [];
  if (envelope.template.day_number != null && envelope.kind !== "rest") {
    const baseDay = getPlanDay(envelope.template.day_number) as any;
    // Recovery adaptation is centralized in normalizeComposedSession after the
    // progression target is applied, so it has the final safety precedence for
    // both deterministic and agent-authored compositions.
    const day = baseDay;
    const candidates = new Map(envelope.candidates.map((candidate) => [candidate.exercise.toLowerCase(), candidate]));
    const substitutions = new Map(
      envelope.candidates
        .filter((candidate) => candidate.substitution_for)
        .map((candidate) => [String(candidate.substitution_for).toLowerCase(), candidate])
    );
    for (const it of Array.isArray(day?.items) ? day.items : []) {
      const group = String(it?.muscle_group ?? "").toLowerCase();
      if (group && excluded.has(group)) continue;
      const itemExercise =
        it?.kind === "cardio" ? cardioPlanIdentity(it).movement_label : String(it?.exercise ?? "");
      const direct = candidates.get(itemExercise.toLowerCase());
      if (direct?.action === "exclude") continue;
      if (equipmentCapability.recognized && equipmentCapability.restricted) {
        const stored = findExercise(String(it?.exercise ?? ""));
        if (
          equipmentCompatibility(
            equipmentCapability,
            inferExerciseEquipment(it?.exercise, stored?.equipment)
          ) !== "compatible"
        )
          continue;
      }
      const substitution = substitutions.get(String(it?.exercise ?? "").toLowerCase());
      if (substitution) {
        const stored = findExercise(substitution.exercise);
        if (
          equipmentCapability.recognized &&
          equipmentCapability.restricted &&
          equipmentCompatibility(
            equipmentCapability,
            inferExerciseEquipment(substitution.exercise, stored?.equipment)
          ) !== "compatible"
        )
          continue;
        const raw = planItemToRaw({
          ...it,
          exercise: substitution.exercise,
          mode: stored?.mode ?? it?.mode,
        });
        // A substitution never inherits the replaced movement's target. Reuse a
        // real working anchor only when this exact exercise has one; otherwise
        // establish the baseline without fabricated load/seconds.
        if (stored?.mode === "timed") {
          raw.target_weight = null;
          raw.target_seconds = recentWorkingSeconds(substitution.exercise);
        } else {
          raw.target_weight = recentWorkingWeight(substitution.exercise);
          raw.target_seconds = null;
        }
        if (raw.target_weight == null && raw.target_seconds == null) {
          raw.note = baselineNote(substitution.note);
        }
        items.push(raw);
      } else {
        const raw = planItemToRaw(it);
        applyAuthorizedTarget(raw, direct);
        Object.assign(raw, trustedCandidateMetadata(direct));
        items.push(raw);
      }
    }
  }
  if (!items.length && !(envelope.kind === "rest" && envelope.request.train_anyway !== true)) {
    // Custom intent, or every template item was excluded: a calm, safe, low-load
    // default that always survives normalization. A true rest decision stays
    // itemless; only the explicit train-anyway decision may produce a workout.
    items.push({
      kind: "cardio",
      exercise: "Easy movement",
      target_duration_min: Math.min(envelope.caps.duration_min ?? 25, 25),
      target_zone: "easy",
      note: "Deterministic fallback — keep it light",
    });
  }
  const why = envelope.rationale[0]?.text ?? "Today's deterministic session.";
  const name =
    envelope.kind === "rest"
      ? "Easy recovery"
      : envelope.template.focus
        ? String(envelope.template.focus)
        : "Today's session";
  return {
    name,
    focus: envelope.kind === "rest" ? "Recovery" : envelope.template.focus,
    why,
    est_minutes: envelope.caps.duration_min,
    items,
  };
}

export function deterministicComposedSession(envelope: DailyDecisionEnvelope): ComposedSession {
  if (envelope.kind === "rest" && envelope.request.train_anyway !== true) {
    return {
      name: "Rest day",
      focus: "Recovery",
      why: envelope.rationale[0]?.text ?? "Today is for recovery.",
      est_minutes: null,
      items: [],
    };
  }
  const raw = deterministicSessionRawFromEnvelope(envelope);
  const { session } = normalizeComposedSession(raw, envelope);
  // The raw payload is built from safe template/plan items, so it always
  // normalizes; this null-guard is defensive only.
  return (
    session ?? {
      name: "Easy movement",
      focus: envelope.template.focus,
      why: "Deterministic fallback session.",
      est_minutes: envelope.caps.duration_min ?? 25,
      items: [],
    }
  );
}

// Keep the wire marker a literal here: adaptive-session imports this module to
// build envelope-backed plan snapshots, so eagerly reading its exported constant
// would create an ESM initialization cycle. The normalizer function is only
// invoked after both modules finish evaluating.
export const DAILY_COMPOSITION_NORMALIZATION = "daily_session_v1";
