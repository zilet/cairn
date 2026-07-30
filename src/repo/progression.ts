// ============================================================================
// progression.ts — the per-session auto-progression engine (MacroFactor-for-
// lifting). Deterministic, no agent, NO scores. It closes the loop: it reads
// what the athlete ACTUALLY logged (the latest top set + RIR) and the lift's
// program-state trajectory, and proposes the NEXT session's target — the small
// earned overload, the hold, the deload, the variation. Mirrors the
// program-state deterministic-floor pattern; the agentic plan-evolution loop
// (buildProgramEvolutionPrompt) sits on TOP of this, never replaces it.
//
// Constitution: everything here is a SUGGESTION the athlete drives. Nothing
// auto-applies — a prescription becomes a plan change only through the existing
// propose→apply path. Plain words only ("+5 lb", "hold 50", "−10%"), never a
// 0-100 score. Encoding honored: weight null = bodyweight, negative = assist
// (e.g. −30 = 30 lb assist); timed lifts progress in seconds, never load.
// ============================================================================
import { db } from "../db.js";
import { emitBrainEvent } from "../brainEvents.js";
import {
  canonicalGroup,
  classifyConstraint,
  classifyMuscleGroup,
  isMobility,
  movementKey,
  type MuscleGroup,
  MUSCLE_LANDMARKS,
  normalizeExerciseName,
  normalizedExerciseKey,
  plainGroupWords,
  resolveGroup,
} from "./exercise-canon.js";
import {
  type Equipment,
  effectiveVolumeByGroup,
  examplesForGroup,
  type ExerciseVariation,
  parseEquipment,
  suggestAlternatives,
  type VolumeSet,
} from "./exercise-variations.js";
import { findExercise, recentWorkingWeight } from "./exercises.js";
import { relatedLiftStart } from "./related-lift.js";
import {
  type AcuteGateReading,
  acuteGates,
  enduranceDose,
  loadPhrase,
  recentEnduranceImpacts,
  recentMuscleLoad,
  type RecentLoad,
} from "./hybrid-load.js";
// Every athlete-facing sentence this engine says lives in ONE vocabulary module as
// a SET of phrasings, rotated per day and per exercise — never a literal here. See
// the contract at the top of progression-voice.ts.
import * as voice from "./progression-voice.js";
import { painAreaLoadsGroup } from "./pain-relevance.js";
export { painAreaLoadsExercise } from "./pain-relevance.js";
import { addExerciseToPlanDay, getPlan, pressSlotKey } from "./plan.js";
import type { CoachPersonalModifier, CoachWhatWorksForYou } from "../brain/coach-context-contract.js";
import { applyPersonalResponseModifier, whatWorksForYou } from "./reaction-model.js";
// createProposal + the auto-progression dedup live in profile.js; imported here (as
// run-progression.ts does for buildRunPlanProposal) so REST + MCP share ONE proposal
// builder instead of duplicating the change-shaping logic (and drifting).
import {
  applyProposal,
  createProposal,
  getProfile,
  setProposalStatus,
  supersedeAutoProgressionDrafts,
} from "./profile.js";
import { type LiftState, getProgramState } from "./program-state.js";
import { addDaysISO, daysBetweenISO, localDateISO, round2_5 } from "./shared.js";
import { supportWorkRead } from "./support-work.js";
// Run-plan / DEXA / test-week digest producers. Imported for their types + a lazy
// compute when programAdjustments is called standalone (Today/Progress). The module
// cycle (progression → run-progression → coach → progression) is resolved at call
// time — these are only invoked inside programAdjustments, never at module init.
import { enduranceTestsDue, weeklyRunPlan, type WeeklyRunPlan } from "./run-progression.js";
import { dexaTargeting, type DexaTargeting } from "./dexa-targeting.js";
import { testWeekDue, type TestWeekDue } from "./muscle-trajectory.js";
import { trainingPlaybook, type TrainingPlaybookRead } from "./training-playbook.js";
import { currentUnderfuelingRead } from "./underfueling-snapshot.js";
import type { UnderfuelingRead } from "./underfueling.js";
import { recentMovementResponse, type RecentMovementResponseVerdict } from "./training-response.js";

export { loadPhrase, recentMuscleLoad, type RecentLoad } from "./hybrid-load.js";

// ---- progression-step caps (mirrors applyProposal's clamp intent, tighter) ---
// A per-session step is a SMALL earned nudge, never a jump. The cap is the
// SMALLER of a fraction of the current load OR a flat ceiling — compounds get a
// 5 lb ceiling, isolation work 2.5 lb (a sane minimum plate jump), and the
// fraction (10%) keeps very light loads from ever leaping. Clamping happens
// here so a prescription is always safe BEFORE it ever reaches propose→apply.
const STEP_FRAC = 0.1; // ≤10% of the current load…
const STEP_CEIL_COMPOUND = 5; // …or ≤5 lb on a compound, whichever is smaller
const STEP_CEIL_ISOLATION = 2.5; // …or ≤2.5 lb on an isolation lift
// Timed holds progress by a RELATIVE step — a fraction of the current hold, clamped to
// a sane floor/ceiling — so a 20s plank and a 120s dead hang each progress proportionally
// (a flat +N is trivial on a long hold and a huge jump on a short one). Timed work moves
// in SECONDS, never load.
const SECONDS_STEP_FRAC = 0.1; // ~10% of the current hold…
const SECONDS_STEP_MIN = 3; // …never smaller than 3s (a real nudge on a short hold)
const SECONDS_STEP_MAX = 20; // …never larger than 20s in one step (a long hold doesn't leap)
const DELOAD_FRAC = 0.1; // a deload backs the load off ~10%
// A movement run this long (steady, not stalled) is ripe for PROACTIVE variety —
// introduce a fresh variation before staleness sets in, at a block boundary, rather
// than waiting for a measured plateau. Tenure = weeks since the lift was first logged.
const INTRODUCE_TENURE_WEEKS = 12;

// Isolation groups get the smaller (2.5 lb) plate jump; compounds get 5 lb.
const ISOLATION_GROUPS = new Set(["biceps", "triceps", "rear delts", "calves", "forearms"]);

export type ProgressionAction = "overload" | "hold" | "deload" | "vary" | "introduce";

export interface PrescriptionTarget {
  sets: number;
  rep_low?: number;
  rep_high?: number;
  weight?: number | null; // null = bodyweight; negative = assist
  seconds?: number;
}

export interface Prescription {
  exercise: string;
  mode: "reps" | "timed";
  action: ProgressionAction;
  suggested: PrescriptionTarget;
  current: PrescriptionTarget | null; // from the plan item, when planned
  delta_text: string; // plain words: "+5 lb", "hold 50", "−10%", "+5s"
  why: string;
  reground?: boolean; // the plan target was behind logged reality — applying re-grounds it
  // The suggested load is a conservative idea taken from a RELATED lift, not this
  // movement's own history — true only while nothing has been logged for it. It is
  // deliberately never written to plan_items (see related-lift.ts): the first
  // logged set replaces it, and a stored guess would outlive the sessions that
  // contradict it.
  starting_idea?: boolean;
  vary_to?: string; // a concrete same-pattern variation to rotate in (action "vary")
  vary_options?: { name: string; why: string }[]; // a MENU of same-pattern swaps (action "vary"); vary_to is the lead
  plan_item_id?: number; // set by planDayProgression for the apply path
  day_number?: number; // set by planDayProgression — the day the lift sits on (for the swap apply path)
  autoregulated?: boolean; // recovery signals braked this step (overload→hold / hold→deload) — informational
  movement_response?: RecentMovementResponseVerdict; // repeated comparable dose evidence that supported or braked the step
  rep_step?: boolean; // double-progression REP advance (load held, reps climb in-range) — no plan change
  dose_eligibility?: {
    linked_outcome: boolean;
    eligible: boolean;
    reason:
      | "legacy_unlinked"
      | "unfinished"
      | "non_comparable"
      | "partial"
      | "under_prescribed"
      | "full_comparable";
  };
}

// ---- autoregulation + acute-recovery gate -----------------------------------
// The 1-tap session feedback (sessions.soreness/performance 1-5 + free-text
// joint_pain) plus recent ACUTE muscle load must GATE the deterministic
// prescription — otherwise the one-tap auto-progression could propose an OVERLOAD
// the morning after soreness 5 / a named sore joint. Recovery INFORMS, it never
// overrides progressive overload beyond ONE step toward safety: overload→hold on
// high soreness / low performance / a just-smoked group; hold→deload when a named
// joint loads that lift. Constitution: kind, plain words, no scores; a brake, not
// a penalty.
export interface AutoregSignals {
  soreness: number | null; // most recent 1-5
  performance: number | null; // most recent 1-5
  joint_pain: string | null; // most recent free-text ("left knee")
  date: string | null;
  // The canonical groups the session that REPORTED each signal actually trained.
  // Soreness and performance are read independently (the freshest non-null of
  // each), so they can come from different days and carry different scopes.
  // An EMPTY list means unresolved — and unresolved FAILS CLOSED to the old
  // whole-body brake, never to no brake at all.
  soreness_groups: MuscleGroup[];
  performance_groups: MuscleGroup[];
}

// Which canonical groups a session on this date loaded. Reuses the ONE effective
// -volume truth, so a bench day scopes to chest AND the triceps/shoulders it
// loaded indirectly rather than to a primary-group label alone. Null-safe: any
// read problem returns empty, which the brake reads as "unresolved".
function groupsTrainedOn(date: string | null): MuscleGroup[] {
  if (!date) return [];
  try {
    const rows = db
      .prepare(
        `SELECT e.muscle_group AS muscle_group, e.name AS exercise, s.date AS date,
                ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
           FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
           JOIN sessions s ON s.id = ls.session_id
          WHERE s.date = ?`
      )
      .all(String(date).slice(0, 10)) as any[];
    return [...effectiveVolumeByGroup(rows as VolumeSet[]).keys()].filter((g) => !isMobility(g));
  } catch {
    return [];
  }
}

const AUTOREG_WINDOW_DAYS = 3; // feedback older than this is stale — don't brake on it

// Read the most recent session feedback within the window (the freshest non-null
// value of each field). Null-safe: no feedback → all nulls (no brake).
export function recentAutoregulation(days = AUTOREG_WINDOW_DAYS, date = localDateISO()): AutoregSignals {
  const today = String(date || localDateISO()).slice(0, 10);
  const since = addDaysISO(today, -(Math.max(1, days) - 1)) ?? today;
  const out: AutoregSignals = {
    soreness: null,
    performance: null,
    joint_pain: null,
    date: null,
    soreness_groups: [],
    performance_groups: [],
  };
  let sorenessDate: string | null = null;
  let performanceDate: string | null = null;
  try {
    const rows = db
      .prepare(
        `SELECT date, soreness, performance, joint_pain FROM sessions
        WHERE date >= ? AND date <= ? ORDER BY date DESC`
      )
      .all(since, today) as any[];
    for (const r of rows) {
      if (out.soreness == null && r.soreness != null) {
        out.soreness = Number(r.soreness);
        sorenessDate = String(r.date);
      }
      if (out.performance == null && r.performance != null) {
        out.performance = Number(r.performance);
        performanceDate = String(r.date);
      }
      if (out.joint_pain == null && r.joint_pain != null && String(r.joint_pain).trim())
        out.joint_pain = String(r.joint_pain).trim();
      if (
        out.date == null &&
        (r.soreness != null || r.performance != null || (r.joint_pain && String(r.joint_pain).trim()))
      )
        out.date = String(r.date);
    }
  } catch {
    /* sessions columns absent → no signal */
  }
  if (out.soreness != null) out.soreness_groups = groupsTrainedOn(sorenessDate);
  if (out.performance != null) out.performance_groups = groupsTrainedOn(performanceDate);
  return out;
}

// Does this feedback reach this lift? Soreness and a flat performance report
// belong to the muscles that session actually trained — a sore leg day used to
// hold the bench press too, for three days, because the brake never asked which
// muscles the feedback was ABOUT. (jointHit and the acute gate were already
// group-scoped; these two were the outliers.)
//
// FAILS CLOSED, deliberately. When the scope cannot be resolved — no logged sets
// on the feedback day, an unclassifiable lift, a read problem — the old
// whole-body brake stands. A safety brake may lose precision; it may never
// quietly lose effect.
function feedbackReaches(groups: MuscleGroup[] | undefined, group: MuscleGroup | null): boolean {
  if (!groups || !groups.length) return true; // unresolved → brake everything, as before
  if (!group) return true; // an unclassifiable lift cannot be ruled out
  return groups.includes(group);
}

// Decide the ONE-step autoregulation brake for a lift, given its computed action,
// its canonical group, the recent feedback, and the acute-load map. Returns the new
// action + a plain reason, or null when nothing brakes. Never steps more than once
// toward safety (overload→hold, hold→deload).
type BrakeResult = { action: "hold" | "deload"; why: string } | null;
function autoregBrake(
  action: ProgressionAction,
  group: MuscleGroup | null,
  hasHistory: boolean,
  autoreg: AutoregSignals | null,
  acute: Map<MuscleGroup, AcuteGateReading> | null,
  name: string,
  date: string
): BrakeResult {
  if (!autoreg && !acute) return null;
  const heavyAcute = group && acute ? acute.get(group)?.saturated === true : false;
  const jointHit = group && autoreg?.joint_pain ? painAreaLoadsGroup(autoreg.joint_pain, group) : false;
  const soreHigh =
    autoreg?.soreness != null && autoreg.soreness >= 4 && feedbackReaches(autoreg.soreness_groups, group);
  const perfLow =
    autoreg?.performance != null && autoreg.performance <= 2 && feedbackReaches(autoreg.performance_groups, group);
  const highStrain = soreHigh || perfLow || heavyAcute;

  // A named sore joint is the strongest brake — one step toward safety.
  if (jointHit) {
    if (action === "overload") {
      return { action: "hold", why: voice.liftVoice(voice.JOINT_BRAKE_HOLD, date, "joint_brake_hold", name) };
    }
    if (action === "hold" && hasHistory) {
      return { action: "deload", why: voice.liftVoice(voice.JOINT_BRAKE_DELOAD, date, "joint_brake_deload", name) };
    }
    return null;
  }
  // High soreness / low performance / a just-smoked group → don't add load today.
  if (highStrain && action === "overload") {
    const reason = heavyAcute
      ? "this muscle got a heavy dose recently"
      : soreHigh
        ? "recent soreness is running high"
        : "recent sessions felt flat";
    return {
      action: "hold",
      why: voice.liftVoice(voice.STRAIN_BRAKE_HOLD, date, "strain_brake_hold", name)(reason),
    };
  }
  return null;
}

// ---- movement tenure (proactive-variety ledger) -----------------------------
// Weeks since a movement was FIRST logged — how long the athlete has been running
// it. Used to suggest rotating a fresh variation in PROACTIVELY (before a measured
// plateau), at a block boundary. Null when the lift has never been logged.
export function movementTenureWeeks(name: string, date = localDateISO()): number | null {
  const ex = findExercise(name);
  if (!ex) return null;
  const first = (
    db
      .prepare(
        `SELECT MIN(s.date) AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id WHERE ls.exercise_id = ?`
      )
      .get(ex.id) as any
  )?.d;
  if (!first) return null;
  const days = daysBetweenISO(String(date || localDateISO()).slice(0, 10), String(first).slice(0, 10));
  if (days == null || days < 0) return 0;
  return Math.round(days / 7);
}

// The athlete's available equipment, parsed from the persisted profile.equipment
// free-text field. Empty → no constraint (rank neutrally).
export function availableEquipment(): Equipment[] {
  try {
    return parseEquipment((getProfile() as any)?.equipment ?? null);
  } catch {
    return [];
  }
}

// Read/write the persisted equipment/preference profile (profile.equipment free
// text). Kept here (a direct column write) rather than in setProfile so the big
// profile upsert stays untouched — setProfile never lists equipment, so it never
// clobbers it. Returns the stored text + the parsed Equipment types.
export function getEquipmentProfile(): { equipment: string | null; parsed: Equipment[] } {
  const eq = (() => {
    try {
      return (getProfile() as any)?.equipment ?? null;
    } catch {
      return null;
    }
  })();
  return { equipment: eq, parsed: parseEquipment(eq) };
}

export function setEquipmentProfile(equipment: string | null): { equipment: string | null; parsed: Equipment[] } {
  const val = equipment == null ? null : String(equipment).trim().slice(0, 1000) || null;
  const existing = db.prepare(`SELECT id FROM profile WHERE id = 1`).get();
  if (existing) db.prepare(`UPDATE profile SET equipment = ? WHERE id = 1`).run(val);
  else db.prepare(`INSERT INTO profile (id, equipment) VALUES (1, ?)`).run(val);
  return { equipment: val, parsed: parseEquipment(val) };
}

// ---- small helpers ----
function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

// The relative timed step for a hold of `seconds`: ~10% of the hold, clamped to
// [MIN, MAX] so short and long holds both progress proportionally.
function timedStep(seconds: number, modifier?: CoachPersonalModifier | null): number {
  const raw = Math.round(Math.abs(seconds) * SECONDS_STEP_FRAC);
  const standard = Math.min(SECONDS_STEP_MAX, Math.max(SECONDS_STEP_MIN, raw));
  if (!modifier) return standard;
  return Math.round(
    applyPersonalResponseModifier({
      base: standard,
      modifier,
      min: SECONDS_STEP_MIN,
      max: SECONDS_STEP_MAX,
      safety_ceiling: SECONDS_STEP_MAX,
    })
  );
}

// The step ceiling for a lift, by group (compound vs isolation).
function stepCeiling(group: string | null): number {
  const g = canonicalGroup(group);
  return g && ISOLATION_GROUPS.has(g) ? STEP_CEIL_ISOLATION : STEP_CEIL_COMPOUND;
}

// The learned load step for one lift, read straight off `modifiers` — the map the
// personal-response model builds FOR consumers — and never off `learnings`.
//
// `learnings` is the athlete-facing PROSE list, capped at the four most recent for
// calm. Resolving through it meant a modifier that was safely present in `modifiers`
// became unreachable the moment its own sentence fell off that cap: the model had
// learned this lift's response, stored it, and the ladder read nothing. Worse, the
// fallback took the first null-subject learning of ANY metric — so a fresh nutrition
// learning claimed the "global" slot and its key matched no training modifier, which
// silently shadowed a live training one.
//
// Preference order, and it matters which way round: THIS lift's own learning first,
// then a whole-athlete one (session feedback and joint pain are recorded with no
// subject and genuinely speak for every lift). Another exercise's learning is never
// borrowed — the squat's earned response is not the bench press's.
export function trainingModifierFor(
  exerciseName: string,
  response: CoachWhatWorksForYou | null = whatWorksForYou()
): CoachPersonalModifier | null {
  if (!response) return null;
  const name = exerciseName.trim().toLowerCase();
  const candidates = response.modifiers.filter((modifier) => modifier.target === "training_progression_step");
  return (
    candidates.find((modifier) => modifier.subject_key?.trim().toLowerCase() === name) ??
    candidates.find((modifier) => modifier.subject_key == null) ??
    null
  );
}

// Clamp a desired LOADED step to the safe cap, rounded to a sane plate. Only
// for positive loaded weight; assist/bodyweight handled separately.
function clampedOverload(current: number, group: string | null, modifier?: CoachPersonalModifier | null): number {
  const ceil = stepCeiling(group);
  const step = Math.min(Math.abs(current) * STEP_FRAC, ceil);
  let earned = step;
  if (modifier) {
    const adjusted = applyPersonalResponseModifier({
      base: step,
      modifier,
      min: Math.min(2.5, ceil),
      max: ceil,
      safety_ceiling: ceil,
    });
    // A learned conservative response must be operational, not cosmetic. Use the
    // smallest common plate increment while the universal per-session ceiling stays
    // authoritative. A standard response retains the historical rounding below.
    if (adjusted < step) {
      const conservativeStep = Math.max(2.5, Math.floor(adjusted / 2.5) * 2.5);
      return Math.min(current + ceil, current + conservativeStep);
    }
    // …and the same has to hold the other way now that a modifier can exceed 1 (the
    // aligned-verdict acceleration in reaction-model.ts). Left on `step`, an earned
    // larger step was discarded here and the branch was decorative. The per-session
    // `ceil` still caps it — applyPersonalResponseModifier already clamped to it, and
    // the rounding guard below re-clamps — so this can raise the step within the safe
    // envelope and nowhere past it.
    if (adjusted > step) earned = Math.min(ceil, adjusted);
  }
  // Round to 5 lb for compounds, 2.5 for isolation, but never below the smaller
  // plate (so a light isolation lift still moves).
  const next = current + earned;
  const rounded = ceil === STEP_CEIL_ISOLATION ? round2_5(next) : round5(next);
  // Guarantee the rounding never produces a step BIGGER than the cap, and never
  // a no-op (a too-small fraction shouldn't strand the lift).
  if (rounded > current + ceil) return current + ceil;
  if (rounded <= current) return current + (ceil === STEP_CEIL_ISOLATION ? 2.5 : 5);
  return rounded;
}

// Find the plan item (and its prescribed targets) for an exercise, if any.
function planItemFor(name: string): {
  plan_item_id: number;
  day_number: number;
  sets: number;
  rep_low: number | null;
  rep_high: number | null;
  weight: number | null;
  seconds: number | null;
  kind: string;
} | null {
  const lc = String(name).toLowerCase();
  for (const day of getPlan() as any[]) {
    for (const it of day.items || []) {
      if (String(it.exercise || "").toLowerCase() === lc) {
        return {
          plan_item_id: it.id,
          day_number: day.day_number,
          sets: Number(it.sets) || 0,
          rep_low: it.rep_low ?? null,
          rep_high: it.rep_high ?? null,
          weight: it.target_weight ?? null,
          seconds: it.target_seconds ?? null,
          kind: it.kind === "cardio" ? "cardio" : "strength",
        };
      }
    }
  }
  return null;
}

// The PLAN SLOT a lift resolves to, matched with the same tiered ladder applyPlanSwap
// uses (exact normalized name → conservative key → movementKey) — so a surface with
// only a lift name (e.g. the conductor's swap payload, which names the LOGGED lift)
// finds the slot even when the plan spells the movement with a different implement
// ("Barbell Bench Press" logged, "DB Bench Press" planned). Lowest day_number within
// the winning tier; tiers never mix (an exact match elsewhere always beats a
// movement-family match). Null when nothing on the plan trains that movement.
export function resolvePlanSwapSlot(name: string): { day: number; plan_name: string } | null {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  try {
    const rows = db
      .prepare(
        `SELECT pd.day_number AS d, e.name AS ex_name
         FROM plan_items pi
         JOIN plan_days pd ON pd.id = pi.plan_day_id
         JOIN exercises e ON e.id = pi.exercise_id
        ORDER BY pd.day_number, pi.position`
      )
      .all() as any[];
    const norm = normalizeExerciseName(raw);
    const key = normalizedExerciseKey(raw);
    const move = movementKey(raw);
    const hit =
      rows.find((r) => normalizeExerciseName(r.ex_name) === norm) ??
      rows.find((r) => normalizedExerciseKey(r.ex_name) === key) ??
      rows.find((r) => movementKey(r.ex_name) === move);
    if (!hit || !Number.isFinite(Number(hit.d))) return null;
    return { day: Number(hit.d), plan_name: String(hit.ex_name) };
  } catch {
    return null;
  }
}

// Back-compat day-only view of resolvePlanSwapSlot (existing callers + MCP).
export function findPlanDayForExercise(name: string): number | null {
  return resolvePlanSwapSlot(name)?.day ?? null;
}

// The plan day best suited to host a movement of `group` — the day already doing the
// most work for that muscle group (ties → the earliest day). Null when no plan day
// trains it at all.
function bestPlanDayForGroup(group: MuscleGroup): number | null {
  try {
    const rows = db
      .prepare(
        `SELECT pd.day_number AS d, e.name AS ex_name, e.muscle_group AS mg
         FROM plan_items pi
         JOIN plan_days pd ON pd.id = pi.plan_day_id
         JOIN exercises e ON e.id = pi.exercise_id`
      )
      .all() as any[];
    const counts = new Map<number, number>();
    for (const r of rows) {
      if (resolveGroup(String(r.ex_name ?? ""), r.mg) !== group) continue;
      const d = Number(r.d);
      if (!Number.isFinite(d)) continue;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    let best: number | null = null;
    for (const [d, n] of counts) {
      if (best == null || n > (counts.get(best) ?? 0) || (n === (counts.get(best) ?? 0) && d < best)) best = d;
    }
    return best;
  } catch {
    return null;
  }
}

// The full "rotate one in" intent behind one tap: resolve WHERE the outgoing lift
// lives (tiered — the plan's implement spelling never blocks the athlete's), swap
// that slot, and when the movement isn't represented anywhere, ADD the incoming
// variation to the day already training that muscle group instead of dead-ending.
// The message says what actually happened, in the plan's own names. REST + MCP both
// call this so the surfaces never drift.
export function applySwapSmart(
  from: string,
  to: string,
  day?: number | null,
): { ok: false; error: string } | { ok: true; mode: "swapped" | "added"; day: number; from?: string; exercise: string; message: string; swapped?: any } {
  const f = String(from ?? "").trim();
  const t = String(to ?? "").trim();
  if (!f) return { ok: false, error: "from exercise required" };
  if (!t) return { ok: false, error: "to exercise required" };

  // day == null must stay NaN so the slot resolution runs — Number(null) is 0,
  // which reads as a (nonexistent) explicit day 0 and breaks the whole ladder.
  let d = day == null ? Number.NaN : Number(day);
  let planName = f;
  if (!Number.isFinite(d)) {
    const slot = resolvePlanSwapSlot(f);
    if (slot) {
      d = slot.day;
      planName = slot.plan_name;
    } else {
      // Nothing on the plan trains this movement — land the variation on the day
      // that already works the muscle group (the athlete asked for it; an error
      // toast would just make them do this by hand from the Plan tab).
      const group = groupForName(f) ?? groupForName(t);
      const hostDay = group ? bestPlanDayForGroup(group) : null;
      if (hostDay == null) return { ok: false, error: `couldn't find ${f} — or a day that trains it — on your plan` };
      let added: ReturnType<typeof addExerciseToPlanDay>;
      try {
        // The LEAD clause only — addExerciseToPlanDay grounds the movement and adds
        // the starting cue that grounding earned. A lift with real logged history
        // must not be told to start light just because it arrived by this path
        // rather than by a swap.
        added = addExerciseToPlanDay(hostDay, t, `Added as a fresh variation for ${f}`);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (!added) return { ok: false, error: `couldn't add ${t} to your plan` };
      emitBrainEvent({
        kind: "exercise_swapped",
        domain: "training",
        date: localDateISO(),
        subject_key: `${f} -> ${t} (added)`.slice(0, 160),
      });
      return {
        ok: true,
        mode: "added",
        day: added.day,
        exercise: added.exercise,
        message: `${f} isn't on your plan — added ${added.exercise} to day ${added.day} instead (nothing removed)`,
      };
    }
  }
  // Pass the RESOLVED plan spelling as `from` so the apply hits its exact-match tier.
  const applied = buildAndApplySwap(d, planName, t);
  if (!applied.ok) return applied;
  const renamed = planName.toLowerCase() !== f.toLowerCase();
  return {
    ok: true,
    mode: "swapped",
    day: d,
    from: planName,
    exercise: t,
    message: renamed
      ? `Rotated ${t} in for ${planName} (your plan's slot for ${f}) on day ${d}`
      : `Rotated ${t} in for ${planName} on day ${d}`,
    swapped: applied.swapped,
  };
}

// The canonical muscle group for a lift name — stored group when the exercise
// exists, else classified from the name.
function groupForName(name: string): MuscleGroup | null {
  try {
    const row = db.prepare(`SELECT muscle_group FROM exercises WHERE LOWER(name) = LOWER(?)`).get(name) as any;
    return resolveGroup(name, row?.muscle_group ?? null);
  } catch {
    return classifyMuscleGroup(name);
  }
}

function currentTarget(plan: ReturnType<typeof planItemFor>, mode: "reps" | "timed"): PrescriptionTarget | null {
  if (!plan) return null;
  if (mode === "timed") {
    return { sets: plan.sets || 1, seconds: plan.seconds ?? undefined };
  }
  return {
    sets: plan.sets || 0,
    rep_low: plan.rep_low ?? undefined,
    rep_high: plan.rep_high ?? undefined,
    weight: plan.weight,
  };
}

// The latest logged TOP set for a lift (heaviest est-1RM day's top set + its
// RIR) — the deterministic read of "what they actually did last time".
function latestTopSet(
  name: string
): {
  weight: number | null;
  reps: number | null;
  rir: number | null;
  duration_sec: number | null;
  date: string;
  session_id: number;
} | null {
  const ex = findExercise(name);
  if (!ex) return null;
  // Most recent session that logged this lift; within it, the top set by est-1RM
  // (reps) or by duration (timed). RIR comes off that top set when present.
  const latestSession = (
    db
      .prepare(
        `SELECT s.id, s.date FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
         WHERE ls.exercise_id = ? AND (ls.reps IS NOT NULL OR ls.duration_sec IS NOT NULL)
         ORDER BY s.date DESC, s.id DESC LIMIT 1`
      )
      .get(ex.id) as any
  );
  if (!latestSession?.date || latestSession?.id == null) return null;
  const sets = db
    .prepare(
      `SELECT ls.weight AS weight, ls.reps AS reps, ls.rir AS rir, ls.duration_sec AS duration_sec
       FROM logged_sets ls
      WHERE ls.exercise_id = ? AND ls.session_id = ?`
    )
    .all(ex.id, latestSession.id) as any[];
  if (!sets.length) return null;
  // Top set: max (weight×(1+reps/30)) for reps; max duration for timed.
  let top = sets[0];
  let bestScore = -Infinity;
  for (const s of sets) {
    const score =
      s.duration_sec != null ? Number(s.duration_sec) : (Number(s.weight) || 0) * (1 + (Number(s.reps) || 0) / 30);
    if (score > bestScore) {
      bestScore = score;
      top = s;
    }
  }
  return {
    weight: top.weight ?? null,
    reps: top.reps ?? null,
    rir: top.rir != null ? Number(top.rir) : null,
    duration_sec: top.duration_sec ?? null,
    date: String(latestSession.date),
    session_id: Number(latestSession.id),
  };
}

// The latest session's WORKING sets for a reps lift — the sets at that session's
// hardest (top) weight, so warmups/backoffs don't dilute the double-progression read.
// Bodyweight (null weight) sets are all "working". Empty when nothing's logged. This is
// how the engine tells "every set capped the range" from "only the top set did".
function latestWorkingSets(name: string): { weight: number | null; reps: number | null; rir: number | null }[] {
  const ex = findExercise(name);
  if (!ex) return [];
  const latestSession = (
    db
      .prepare(
        `SELECT s.id, s.date FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
         WHERE ls.exercise_id = ? AND ls.reps IS NOT NULL
         ORDER BY s.date DESC, s.id DESC LIMIT 1`
      )
      .get(ex.id) as any
  );
  if (!latestSession?.date || latestSession?.id == null) return [];
  const rows = db
    .prepare(
      `SELECT ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls
      WHERE ls.exercise_id = ? AND ls.session_id = ? AND ls.reps IS NOT NULL`
    )
    .all(ex.id, latestSession.id) as any[];
  if (!rows.length) return [];
  // The working weight is the hardest (largest signed) loaded weight in the session;
  // sets at it are the working sets. If nothing carries a weight, it's a bodyweight
  // movement and every logged set counts.
  let topW: number | null = null;
  for (const r of rows) {
    if (r.weight != null && (topW == null || Number(r.weight) > topW)) topW = Number(r.weight);
  }
  const working = topW == null ? rows.filter((r) => r.weight == null) : rows.filter((r) => Number(r.weight) === topW);
  return working.map((r) => ({
    weight: r.weight ?? null,
    reps: r.reps != null ? Number(r.reps) : null,
    rir: r.rir != null ? Number(r.rir) : null,
  }));
}

function linkedDoseEligibility(
  sessionId: number | null | undefined,
  movement: string
): NonNullable<Prescription["dose_eligibility"]> {
  if (sessionId == null) return { linked_outcome: false, eligible: true, reason: "legacy_unlinked" };
  const row = db
    .prepare(
      `SELECT o.status, o.facts_json, s.finished_at
         FROM daily_session_outcomes o
         JOIN sessions s ON s.id = o.session_id
        WHERE o.session_id = ? ORDER BY o.id DESC LIMIT 1`
    )
    .get(Number(sessionId)) as any;
  if (!row) return { linked_outcome: false, eligible: true, reason: "legacy_unlinked" };
  if (row.status !== "completed" || !row.finished_at) {
    return { linked_outcome: true, eligible: false, reason: "unfinished" };
  }
  let facts: any = null;
  try {
    facts = JSON.parse(row.facts_json);
  } catch {
    return { linked_outcome: true, eligible: false, reason: "non_comparable" };
  }
  if (facts?.dose_context?.partial === true) {
    return { linked_outcome: true, eligible: false, reason: "partial" };
  }
  if (facts?.dose_context?.comparable !== true) {
    return {
      linked_outcome: true,
      eligible: false,
      reason: "non_comparable",
    };
  }
  const stored = findExercise(movement);
  const identity =
    stored?.id != null ? `exercise:${Number(stored.id)}` : `movement:${normalizedExerciseKey(movement)}`;
  const dose = Array.isArray(facts?.dose_evidence)
    ? facts.dose_evidence.find(
        (entry: any) =>
          entry?.movement_key === identity ||
          String(entry?.exercise ?? "").toLowerCase() === String(movement).toLowerCase()
      )
    : null;
  const prescribedSets = Number(dose?.prescribed?.sets);
  const achievedSets = Number(dose?.achieved?.sets);
  if (
    !dose ||
    (Number.isFinite(prescribedSets) && prescribedSets > 0 && (!Number.isFinite(achievedSets) || achievedSets < prescribedSets))
  ) {
    return { linked_outcome: true, eligible: false, reason: "partial" };
  }
  if (dose.challenge_verdict !== "met" && dose.challenge_verdict !== "exceeded") {
    return { linked_outcome: true, eligible: false, reason: "under_prescribed" };
  }
  return { linked_outcome: true, eligible: true, reason: "full_comparable" };
}

// Pull the per-lift program-state read (status/trend/stall) for ONE exercise —
// reuse the aggregate so the engine and the program-state surface always agree.
// A caller iterating many lifts (planDayProgression / programAdjustments) builds
// the map ONCE and threads it in; a standalone nextPrescription(name) call
// computes it on demand. No module-level cache (it would go stale between tests
// that reset the DB within the same calendar day).
function buildLiftStateMap(): Map<string, LiftState> {
  const st = getProgramState();
  return new Map((st.lifts || []).map((l) => [l.exercise.toLowerCase(), l]));
}
function liftStateFor(name: string, states?: Map<string, LiftState>): LiftState | null {
  const map = states ?? buildLiftStateMap();
  return map.get(String(name).toLowerCase()) ?? null;
}

// Build the plain-words delta for a loaded step (handles assist + bodyweight).
function loadedDeltaText(current: number | null, next: number | null): string {
  if (current == null && next == null) return "hold bodyweight";
  if (next == null) return "bodyweight";
  if (current == null) return next < 0 ? `assist ${Math.abs(next)} lb` : `${next} lb`;
  // assist (negative): reducing assist = a smaller absolute value = harder.
  if (current < 0 || next < 0) {
    const d = next - current; // toward 0 = +ve = less assist = harder
    if (d === 0) return `hold ${Math.abs(current)} lb assist`;
    return d > 0 ? `−${Math.abs(d)} lb assist` : `+${Math.abs(d)} lb assist`;
  }
  const d = next - current;
  if (d === 0) return `hold ${current} lb`;
  return d > 0 ? `+${d} lb` : `−${Math.abs(d)} lb`;
}

// ---- preference-aware novelty (bounded, deterministic) ----------------------
// A parsed 'preference' memory: a polarity (a like vs a "dislikes X"/"hates X"
// phrasing) plus the load-bearing keyword tokens it names. Used ONLY to gently
// re-rank same-pattern variation candidates the athlete already qualifies for —
// it NEVER pulls in a candidate injury/pattern filters excluded, and never
// overrides pattern-correctness (it reorders the passing list, never adds to it).
export interface ParsedPreference {
  polarity: 1 | -1; // like (+1) vs dislike (-1)
  tokens: Set<string>; // distinctive keyword tokens named in the memory
}

// A negative-preference phrasing ("dislikes X" / "hates X" / "avoid X" / "not a
// fan of X" / "don't like X"). Anything else on a 'preference' memory reads as a
// positive like. Deliberately conservative — exact/substring only, no NLP. Only a
// leading word boundary is anchored so common suffixes still match (dislike →
// dislikes, hate → hates, avoid → avoiding).
const PREF_DISLIKE_RE =
  /\b(dislike|hate|avoid|can'?t stand|cannot stand|not a fan|no thanks|rather not|don'?t (?:like|enjoy|want)|doesn'?t (?:like|enjoy|want))/i;

// Generic words that never discriminate one same-pattern candidate from another
// (so "loves squats" doesn't uniformly light up every squat variation) — dropped
// from both the memory tokens and the candidate's distinctive tokens.
const PREF_STOPWORDS = new Set(
  "the a an and or to of in on for is are do does did have has i im my me you your with at as be it that this so but not more most really always usually prefer prefers like likes love loves enjoy enjoys favou favour favourite favorite exercise exercises workout workouts lift lifts move moves movement movements work works working train trains training day days".split(
    " "
  )
);

function prefTokens(s: string): string[] {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !PREF_STOPWORDS.has(w));
}

// Equipment → the plain words a memory might use to name it (so "prefers dumbbell
// work" boosts every DB candidate). Matched once per candidate. Deliberately only
// unambiguous, ≥3-char words: no "bb"/"db"/"kb" (2-char tokens are dropped anyway)
// and no "hack"/"smith" (those are specific movement names, not generic equipment,
// so they'd wrongly demote Leg Press off a "hates hack squats" memory).
const PREF_EQUIP_ALIASES: Record<Equipment, string[]> = {
  barbell: ["barbell"],
  dumbbell: ["dumbbell", "dumbell", "dumbbells"],
  machine: ["machine", "machines"],
  cable: ["cable", "cables", "pulley"],
  kettlebell: ["kettlebell", "kettlebells"],
  bodyweight: ["bodyweight", "calisthenic", "calisthenics"],
};

// Parse 'preference' memory contents into polarity + tokens. Empty/tokenless rows
// are dropped. Pure + deterministic — exported for direct unit testing.
export function parsePreferenceMemories(contents: Array<string | null | undefined>): ParsedPreference[] {
  const out: ParsedPreference[] = [];
  for (const raw of contents) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    const tokens = new Set(prefTokens(text));
    if (!tokens.size) continue;
    out.push({ polarity: PREF_DISLIKE_RE.test(text) ? -1 : 1, tokens });
  }
  return out;
}

// The learned-preference score for ONE candidate against the original lift. The
// candidate's DISTINCTIVE tokens (its name tokens MINUS the original's, so the
// shared pattern noun like "squat" never counts) plus its equipment aliases are
// matched against each preference; a match contributes polarity×strength. 0 when
// nothing matches (the calm, common answer). Pure — exported for unit testing.
export function preferenceSignal(
  candidate: { name: string; equipment: Equipment },
  originalName: string,
  prefs: ParsedPreference[]
): number {
  if (!prefs.length) return 0;
  const originalTokens = new Set(prefTokens(originalName));
  const distinctive = prefTokens(candidate.name).filter((t) => !originalTokens.has(t));
  const equipAliases = PREF_EQUIP_ALIASES[candidate.equipment] ?? [];
  let score = 0;
  for (const p of prefs) {
    let strength = 0;
    for (const t of distinctive) if (p.tokens.has(t)) strength++;
    if (equipAliases.some((a) => p.tokens.has(a))) strength++; // equipment mention counts once
    if (strength > 0) score += p.polarity * strength;
  }
  return score;
}

// Stable-sort variation candidates by their learned-preference score (liked first,
// disliked last), preserving the input order for ties — so the equipment/compound
// ranking suggestAlternatives already applied is the tiebreak. NEVER filters: a
// disliked candidate is demoted, never removed, and nothing new is ever added, so
// injury/pattern constraints upstream always win. Pure — exported for unit testing.
export function preferenceRerank(
  candidates: ExerciseVariation[],
  originalName: string,
  prefs: ParsedPreference[]
): ExerciseVariation[] {
  if (!prefs.length || candidates.length < 2) return candidates;
  return candidates
    .map((c, i) => ({ c, i, s: preferenceSignal(c, originalName, prefs) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

// The athlete's live 'preference' memories, parsed. Read once per day's pass and
// threaded into every lift's context. Null-safe — no memory / no preferences → [].
export function learnedPreferences(): ParsedPreference[] {
  try {
    const rows = db
      .prepare(`SELECT content FROM memory WHERE kind = 'preference' AND superseded_by IS NULL ORDER BY id DESC LIMIT 40`)
      .all() as any[];
    return parsePreferenceMemories(rows.map((r) => String(r?.content ?? "")));
  } catch {
    return [];
  }
}

// Same-pattern variation MENU for a lift, ranked toward the athlete's available
// equipment + heavier COMPOUND loading (the owner's explicit goal), gently biased
// by learned 'preference' memories, never re-suggesting a movement/slot already in
// the week. Pure over suggestAlternatives.
function rankedVaryOptions(name: string, ctx?: PrescCtx): { name: string; why: string }[] {
  const equip = ctx?.availableEquipment ?? [];
  const exclude = ctx?.excludeNames ?? [];
  const prefs = ctx?.preferences ?? [];
  const filtered = (
    suggestAlternatives(name, {
      limit: 20,
      preferCompound: true,
      availableEquipment: equip.length ? equip : undefined,
      excludeNames: exclude.length ? exclude : undefined,
    }) as ExerciseVariation[]
  ).filter((candidate) => {
    const candidateKey = normalizedExerciseKey(candidate.name);
    const candidateMove = movementKey(candidate.name);
    const candidatePress = pressSlotKey(candidate.name);
    return !exclude.some(
      (planned) =>
        normalizedExerciseKey(planned) === candidateKey ||
        movementKey(planned) === candidateMove ||
        (candidatePress != null && pressSlotKey(planned) === candidatePress)
    );
  });
  return preferenceRerank(filtered, name, prefs)
    .slice(0, 3)
    .map((v) => ({ name: v.name, why: v.why }));
}

// ---- the per-lift prescription ----------------------------------------------
// nextPrescription reads the latest logged top set + RIR + the lift's
// program-state status/trend, and proposes the NEXT session's target. Returns
// null when there's no history AND no plan item to read (nothing to say). Pass a
// pre-built `states` map when iterating many lifts (avoids recomputing the whole
// program-state per lift).
export interface PrescriptionOpts {
  autoreg?: AutoregSignals | null; // latest 1-tap session feedback (soreness/perf/joint)
  acute?: Map<MuscleGroup, AcuteGateReading> | null; // the shared acute-recovery gate per group
  availableEquipment?: Equipment[] | null; // rank variation candidates by what the athlete can load
  excludeNames?: string[] | null; // movements already in the week — don't re-suggest their exercise/slot
  personalModifier?: CoachPersonalModifier | null; // learned step size; never overrides constraints/recovery
  preferences?: ParsedPreference[] | null; // learned like/dislike memories; gently re-ranks variety, never constraints
  date?: string | null; // the day whose phrasing rotation applies (defaults to today)
}

export function nextPrescription(
  exerciseName: string,
  states?: Map<string, LiftState>,
  opts?: PrescriptionOpts
): Prescription | null {
  const ex = findExercise(exerciseName);
  const mode: "reps" | "timed" = ex?.mode === "timed" ? "timed" : "reps";
  const group: string | null = ex?.muscle_group ?? null;
  // Autoregulation + acute-recovery gate. Compute lazily for a standalone call so
  // Today's per-lift read is braked too; planDayProgression threads a shared read in.
  const canonGroup: MuscleGroup | null = canonicalGroup(group) ?? classifyMuscleGroup(exerciseName);
  const autoreg = opts && "autoreg" in opts ? (opts.autoreg ?? null) : recentAutoregulation();
  const acute = opts && "acute" in opts ? (opts.acute ?? null) : acuteGates();
  const equip = opts && "availableEquipment" in opts ? (opts.availableEquipment ?? []) : availableEquipment();
  const excludeNames = (opts?.excludeNames ?? []).filter(Boolean);
  const personalModifier =
    opts && "personalModifier" in opts ? (opts.personalModifier ?? null) : trainingModifierFor(exerciseName);
  const preferences = opts && "preferences" in opts ? (opts.preferences ?? []) : learnedPreferences();
  const tenureWeeks = movementTenureWeeks(exerciseName);
  // Only a LOAD-limiting constraint (pain/strain under load) freezes load. A form/
  // grip/ROM cue ("neutral grip only, no supinated curls") does NOT — the athlete
  // manages it technically and still earns load. classifyConstraint draws the line so
  // a grip note no longer strands a lift at a stale weight (the cubital-tunnel bug).
  const loadConstrained = classifyConstraint(ex?.constraint_note) === "load";
  const plan = planItemFor(exerciseName);
  // Cardio plan items aren't progressed here (the runner loop owns those).
  if (plan && plan.kind === "cardio") return null;
  const cur = currentTarget(plan, mode);
  const last = latestTopSet(exerciseName);
  const state = liftStateFor(exerciseName, states);

  // Nothing logged and nothing planned → genuinely nothing to read.
  if (!last && !plan) return null;

  const brakeCtx: PrescCtx = {
    canonGroup,
    autoreg,
    acute,
    tenureWeeks,
    availableEquipment: equip,
    excludeNames,
    personalModifier,
    preferences,
    date: String(opts?.date || localDateISO()).slice(0, 10),
  };
  if (mode === "timed")
    return timedPrescription(exerciseName, group, loadConstrained, plan, cur, last, state, brakeCtx);
  return repsPrescription(exerciseName, group, loadConstrained, plan, cur, last, state, brakeCtx);
}

interface PrescCtx {
  canonGroup: MuscleGroup | null;
  autoreg: AutoregSignals | null;
  acute: Map<MuscleGroup, AcuteGateReading> | null;
  tenureWeeks: number | null;
  availableEquipment: Equipment[];
  excludeNames: string[];
  personalModifier: CoachPersonalModifier | null;
  preferences: ParsedPreference[];
  date: string; // keys the per-day phrasing rotation (with the exercise as the offset)
}

function repsPrescription(
  name: string,
  group: string | null,
  loadConstrained: boolean,
  plan: ReturnType<typeof planItemFor>,
  cur: PrescriptionTarget | null,
  last: ReturnType<typeof latestTopSet>,
  state: LiftState | null,
  brakeCtx?: PrescCtx
): Prescription {
  // Every verdict below picks its sentence from a SET of phrasings keyed on the day
  // and this lift, so two lifts in the same state never print the same line.
  const date = brakeCtx?.date ?? localDateISO();
  const say = <T>(set: readonly T[], code: string): T => voice.liftVoice(set, date, code, name);
  // Ground in REALITY. The load to progress FROM is the HARDER of the plan target and
  // the athlete's actual recent working weight — so a stale plan target (e.g. 27 lb)
  // can't strand a lift the athlete is genuinely driving (45–50 lb every week). Falls
  // back cleanly when one side is absent (off-plan → logged; nothing logged → plan).
  // Encoding preserved: assist is negative and the larger signed value is the harder/
  // realer load, so Math.max picks the right "from" in both regimes.
  const planWeight = plan?.weight ?? null;
  const recentWorking = recentWorkingWeight(name);
  let baseWeight: number | null;
  if (planWeight != null && recentWorking != null) baseWeight = Math.max(planWeight, recentWorking);
  else
    baseWeight =
      planWeight != null
        ? planWeight
        : recentWorking != null
          ? recentWorking
          : last?.weight != null
            ? Number(last.weight)
            : null;
  // The plan target is BEHIND what they're actually lifting → the prescription also
  // RE-GROUNDS the plan: the displayed "current" reflects reality, and applying lands
  // the plan target on what they truly handle ("gradually adjust the plan from logs").
  //
  // A NULL plan target with real logged history counts as behind. It used to be
  // excluded (`planWeight != null`), which meant the whole re-grounding path was
  // unreachable for exactly the lifts that need it most — a movement rotated in with
  // no target, then loaded for real, stayed at NULL forever with the catch-up prose
  // dead code. The bodyweight encoding is safe here: recentWorkingWeight ignores
  // null/zero loads, so a genuinely bodyweight lift never reads as behind.
  const planUnset = plan != null && planWeight == null && recentWorking != null;
  const planBehind =
    planUnset || (planWeight != null && recentWorking != null && recentWorking > planWeight + 0.1);

  const repLow = plan?.rep_low ?? cur?.rep_low ?? undefined;
  const repHigh = plan?.rep_high ?? cur?.rep_high ?? undefined;
  const sets = plan?.sets || 3;

  // The decision. Order matters: an injury constraint HOLDS load before anything
  // else; then read the program-state status (progressing / plateaued / …).
  let action: ProgressionAction;
  let why: string;
  let nextWeight: number | null = baseWeight;
  let varyTo: string | undefined;
  let varyOptions: { name: string; why: string }[] | undefined;
  let repStep = false; // a DOUBLE-PROGRESSION rep advance (load held, reps climb in-range)
  let startingIdea = false; // the suggestion is a related-lift idea, not this lift's own history
  // Equipment-ranked, compound-biased, plan-deduped same-pattern candidates —
  // computed ONCE and reused by the vary + introduce branches (and the introduce guard).
  const varyCandidates = rankedVaryOptions(name, brakeCtx);
  // A movement with nothing logged of its own and no number on the plan is exactly
  // the case a rotate-in creates. Rather than showing an empty target and "start
  // light", offer a conservative starting idea from a related lift the athlete does
  // train — HERE, in the live prescription, and never in plan_items (a stored guess
  // would become the floor every future step is measured from; see related-lift.ts).
  // A load-limiting note is the authority and skips this entirely, and one logged
  // set retires it for good.
  const relatedStart = !last && baseWeight == null && !loadConstrained ? relatedLiftStart(name) : null;

  const status = state?.status ?? "new";
  const lastRir = last?.rir ?? null;
  // DOUBLE PROGRESSION, grounded in what was ACTUALLY logged: advance REPS within the
  // prescribed range first, and only add LOAD once EVERY working set has hit the TOP of
  // the range — then reset reps to the bottom at the new load. `allSetsAtTop` reads the
  // latest session's working sets (a lone logged top set is trusted); `roomInRange` means
  // the top set is still below the ceiling (a rep to earn). No range (repHigh null) → the
  // old single-top-set read.
  const hasRange = repLow != null && repHigh != null;
  const workingSets = latestWorkingSets(name);
  const doseEligibility = linkedDoseEligibility(last?.session_id, name);
  const topReps = last?.reps != null ? Number(last.reps) : null;
  const setsAtTop = hasRange
    ? workingSets.filter((s) => s.reps != null && (s.reps as number) >= (repHigh as number)).length
    : 0;
  const allSetsAtTop = hasRange && workingSets.length > 0 && setsAtTop === workingSets.length;
  const roomInRange = hasRange && topReps != null && topReps < (repHigh as number);
  // "Strong" = the work earned progression: last top set at RIR ≥ 2, OR the program-state
  // trend reads progressing. RIR ≤ 1 means it was a grind — hold.
  const strong = ((lastRir != null && lastRir >= 2) || status === "progressing") && doseEligibility.eligible;
  // The LOAD step is earned only when EVERY working set capped the range (double
  // progression). With no rep range, fall back to a strong top set (RIR 2+ / progressing).
  const earned = hasRange ? allSetsAtTop && strong : strong;

  if (loadConstrained) {
    action = "hold";
    nextWeight = baseWeight;
    why = say(voice.CONSTRAINED_HOLD, "constrained_hold");
  } else if (status === "regressing") {
    action = "deload";
    nextWeight = baseWeight != null && baseWeight > 0 ? round5(baseWeight * (1 - DELOAD_FRAC)) : baseWeight;
    why = say(voice.REGRESSING_DELOAD, "regressing_deload");
  } else if (status === "plateaued") {
    // Grinding (RIR ≤ 1) → deload; flat ≥ ~3 wk → vary; else hold/technique.
    const grinding = lastRir != null && lastRir <= 1;
    const flatLong = (state?.weeks_static ?? 0) >= 3;
    if (grinding) {
      action = "deload";
      nextWeight = baseWeight != null && baseWeight > 0 ? round5(baseWeight * (1 - DELOAD_FRAC)) : baseWeight;
      why = say(voice.PLATEAU_GRIND_DELOAD, "plateau_grind_deload");
    } else if (flatLong) {
      action = "vary";
      nextWeight = baseWeight;
      // Carry a concrete same-pattern candidate so "switch it up" is actionable (Today
      // shows the real alternative; the evolution/apply path can rotate it in).
      // A MENU of same-pattern candidates (not just one forced swap) so the athlete
      // chooses; vary_to stays the lead candidate for back-compat. Ranked by the
      // athlete's available equipment + biased toward heavier compound loading, and
      // never re-suggesting a movement already on the day.
      varyOptions = varyCandidates;
      varyTo = varyOptions[0]?.name;
      why = varyTo
        ? say(voice.PLATEAU_VARY_TO, "plateau_vary_to")(state?.weeks_static ?? 0, varyTo)
        : say(voice.PLATEAU_VARY_OPEN, "plateau_vary_open")(state?.weeks_static ?? 0);
    } else {
      action = "hold";
      nextWeight = baseWeight;
      why = say(voice.PLATEAU_HOLD, "plateau_hold");
    }
  } else if (!last && plan) {
    action = "hold";
    if (relatedStart) {
      nextWeight = relatedStart.weight;
      startingIdea = true;
      why = say(voice.RELATED_START_IDEA, "related_start_idea")(
        relatedStart.source_exercise,
        `${relatedStart.weight} lb`
      );
    } else {
      nextWeight = baseWeight;
      why = say(voice.NO_HISTORY_PLANNED_HOLD, "no_history_planned_hold");
    }
  } else if (
    !loadConstrained &&
    state?.status === "maintaining" &&
    (brakeCtx?.tenureWeeks ?? 0) >= INTRODUCE_TENURE_WEEKS &&
    varyCandidates.length > 0
  ) {
    // PROACTIVE variety: the lift is holding steady but you've run it a long time —
    // introduce a fresh same-pattern variation (ranked toward heavier compound
    // loading) before staleness sets in, rather than waiting for a measured plateau.
    // Load is held; the novelty IS the stimulus. This makes the "introduce" action
    // reachable deterministically.
    action = "introduce";
    nextWeight = baseWeight;
    varyOptions = varyCandidates;
    varyTo = varyOptions[0]?.name;
    why = say(voice.INTRODUCE_VARIATION, "introduce_variation")(
      ex_name(name),
      brakeCtx?.tenureWeeks ?? 0,
      varyTo ?? "a close variation"
    );
  } else if (hasRange && strong && roomInRange && !allSetsAtTop) {
    // DOUBLE PROGRESSION — the REP stage. The work was strong but not every set has
    // capped the range yet: advance reps within the range, hold the load. This is NO
    // plan change (the plan already prescribes the range) — the athlete just earns reps.
    action = "overload";
    repStep = true;
    nextWeight = baseWeight;
    why = say(voice.REP_STAGE_OVERLOAD, "rep_stage_overload")(repHigh as number);
  } else if (earned) {
    // DOUBLE PROGRESSION — the LOAD stage. Every working set capped the range at RIR 2+
    // (or no range + a strong top set) → the small earned step up, then reset to the bottom.
    action = "overload";
    if (baseWeight == null) {
      // Bodyweight reps lift — no load to add; progression is reps/sets.
      nextWeight = null;
      why = say(voice.BODYWEIGHT_OVERLOAD, "bodyweight_overload");
    } else if (baseWeight < 0) {
      // Assisted — reduce the assist toward bodyweight (a smaller absolute value).
      const ceil = stepCeiling(group);
      const standardStep = Math.min(Math.abs(baseWeight) * STEP_FRAC, ceil);
      const step = brakeCtx?.personalModifier
        ? applyPersonalResponseModifier({
            base: standardStep,
            modifier: brakeCtx.personalModifier,
            min: 0,
            max: ceil,
            safety_ceiling: ceil,
          })
        : standardStep;
      const reduced = round5(baseWeight + step); // toward 0
      nextWeight = reduced >= 0 ? null : reduced; // crossed to bodyweight → null
      why =
        nextWeight == null
          ? say(voice.ASSIST_TO_BODYWEIGHT, "assist_to_bodyweight")
          : say(voice.ASSIST_PEEL, "assist_peel");
    } else {
      nextWeight = clampedOverload(baseWeight, group, brakeCtx?.personalModifier);
      why = hasRange
        ? say(voice.EARNED_RANGE_OVERLOAD, "earned_range_overload")(repHigh as number, repLow as number)
        : say(voice.EARNED_OPEN_OVERLOAD, "earned_open_overload");
    }
  } else {
    action = "hold";
    nextWeight = baseWeight;
    if (last && !doseEligibility.eligible)
      why =
        doseEligibility.reason === "unfinished"
          ? say(voice.DOSE_UNFINISHED_HOLD, "dose_unfinished_hold")
          : doseEligibility.reason === "partial"
            ? say(voice.DOSE_PARTIAL_HOLD, "dose_partial_hold")
            : doseEligibility.reason === "under_prescribed"
              ? say(voice.DOSE_UNDER_HOLD, "dose_under_hold")
              : say(voice.DOSE_NON_COMPARABLE_HOLD, "dose_non_comparable_hold");
    else if (!last) why = say(voice.NO_HISTORY_HOLD, "no_history_hold");
    else if (hasRange && topReps != null && topReps >= (repHigh as number) && !allSetsAtTop)
      why = say(voice.TOP_SET_ONLY_HOLD, "top_set_only_hold")(repHigh as number);
    else why = say(voice.NOT_EARNED_HOLD, "not_earned_hold");
  }

  // Catch-up framing: when the plan target was BEHIND the real working weight, say so
  // plainly — the step is "from where you actually are", and even a hold re-grounds the
  // plan onto reality (the suggested weight = baseWeight, so applying lands it there).
  if (planBehind && baseWeight != null) {
    const lbl = baseWeight < 0 ? `${Math.abs(baseWeight)} lb assist` : `${baseWeight} lb`;
    // "The plan said a lighter number" and "the plan said nothing at all" are
    // different facts, and the athlete can tell them apart on the card.
    if (action === "overload" && !repStep)
      why = planUnset
        ? say(voice.PLAN_UNSET_OVERLOAD, "plan_unset_overload")(lbl)
        : say(voice.PLAN_BEHIND_OVERLOAD, "plan_behind_overload")(lbl);
    else if (action === "hold" && !loadConstrained)
      why = planUnset
        ? say(voice.PLAN_UNSET_HOLD, "plan_unset_hold")(lbl)
        : say(voice.PLAN_BEHIND_HOLD, "plan_behind_hold")(lbl);
  }

  // Repeated comparable movement-dose outcomes are the first recovery brake.
  // They can support an already-earned step, but never manufacture an extra one.
  // Repeated under-prescription moves at most one rung toward safety before the
  // existing acute autoregulation gate runs. A latest linked ineligible dose has
  // already taken that rung, so the history response must not compound it.
  const response = recentMovementResponse(name, {
    intent_key: `strength:reps:${repLow ?? "open"}-${repHigh ?? repLow ?? "open"}`,
  });
  if (response.verdict === "earned_hold") {
    if (action === "overload") {
      action = "hold";
      nextWeight = baseWeight;
      repStep = false;
      why = say(voice.MOVEMENT_RESPONSE_HOLD, "movement_response_hold");
    } else if (action === "hold" && last && doseEligibility.eligible) {
      action = "deload";
      nextWeight = baseWeight != null && baseWeight > 0 ? round5(baseWeight * (1 - DELOAD_FRAC)) : baseWeight;
      why = say(voice.MOVEMENT_RESPONSE_DELOAD, "movement_response_deload");
    }
    varyTo = undefined;
    varyOptions = undefined;
  }

  // AUTOREGULATION GATE — one step toward safety on high soreness / low performance /
  // a just-smoked group / a named sore joint. Recovery INFORMS, never overrides
  // progressive overload by more than a step. Applied last so it wins over the earned
  // step (an earned overload the morning after a sore knee becomes a hold/deload).
  let autoregulated = false;
  const brake = brakeCtx
    ? autoregBrake(action, brakeCtx.canonGroup, !!last, brakeCtx.autoreg, brakeCtx.acute, name, date)
    : null;
  if (brake) {
    autoregulated = true;
    action = brake.action;
    why = brake.why;
    repStep = false; // a braked step is a hold/deload, not a rep advance
    if (brake.action === "hold") nextWeight = baseWeight;
    else nextWeight = baseWeight != null && baseWeight > 0 ? round5(baseWeight * (1 - DELOAD_FRAC)) : baseWeight;
    varyTo = undefined;
    varyOptions = undefined;
  }

  const suggested: PrescriptionTarget = {
    sets,
    rep_low: repLow ?? undefined,
    rep_high: repHigh ?? undefined,
    weight: nextWeight,
  };
  // A rep advance holds the load and climbs the range — the honest delta is "+1 rep",
  // not "hold X lb" (loadedDeltaText would read it as a no-op load move).
  const delta_text = repStep ? "+1 rep" : loadedDeltaText(baseWeight, nextWeight);
  // The displayed "current" reflects REALITY when the plan was behind, so the card
  // reads "50 → 52.5", never "27 → …" off a number the athlete left behind weeks ago.
  const displayCurrent: PrescriptionTarget | null = cur
    ? planBehind
      ? { ...cur, weight: baseWeight }
      : cur
    : baseWeight != null
      ? { sets, rep_low: repLow ?? undefined, rep_high: repHigh ?? undefined, weight: baseWeight }
      : null;

  return {
    exercise: ex_name(name),
    mode: "reps",
    action,
    suggested,
    current: displayCurrent,
    delta_text,
    why,
    reground: planBehind || undefined,
    // Only claim the starting idea while the suggestion IS still that number — a
    // brake that resets the load back to the plan has taken the idea away with it.
    starting_idea: (startingIdea && nextWeight != null) || undefined,
    vary_to: varyTo,
    vary_options: varyOptions,
    autoregulated: autoregulated || undefined,
    movement_response: response.verdict,
    rep_step: repStep || undefined,
    dose_eligibility: doseEligibility,
  };
}

function timedPrescription(
  name: string,
  _group: string | null,
  loadConstrained: boolean,
  plan: ReturnType<typeof planItemFor>,
  cur: PrescriptionTarget | null,
  last: ReturnType<typeof latestTopSet>,
  state: LiftState | null,
  brakeCtx?: PrescCtx
): Prescription {
  const date = brakeCtx?.date ?? localDateISO();
  const say = <T>(set: readonly T[], code: string): T => voice.liftVoice(set, date, code, name);
  const baseSeconds: number | null =
    plan?.seconds != null ? plan.seconds : last?.duration_sec != null ? Math.round(Number(last.duration_sec)) : null;
  const sets = plan?.sets || 1;

  let action: ProgressionAction;
  let why: string;
  let nextSeconds: number | null = baseSeconds;

  const status = state?.status ?? "new";
  // Solid = the latest hold comfortably met (or beat) the current target.
  const target = baseSeconds ?? 0;
  const held = last?.duration_sec != null ? Math.round(Number(last.duration_sec)) : null;
  const solid = held != null && target > 0 && held >= target;
  const doseEligibility = linkedDoseEligibility(last?.session_id, name);

  if (loadConstrained) {
    action = "hold";
    nextSeconds = baseSeconds;
    why = say(voice.TIMED_CONSTRAINED_HOLD, "timed_constrained_hold");
  } else if (status === "regressing") {
    action = "deload";
    nextSeconds = baseSeconds != null ? Math.max(10, Math.round(baseSeconds * (1 - DELOAD_FRAC))) : baseSeconds;
    why = say(voice.TIMED_REGRESSING_DELOAD, "timed_regressing_deload");
  } else if (!last && plan) {
    action = "hold";
    nextSeconds = baseSeconds;
    why = say(voice.TIMED_NO_HISTORY_PLANNED_HOLD, "timed_no_history_planned_hold");
  } else if ((solid || status === "progressing") && doseEligibility.eligible) {
    action = "overload";
    const base = baseSeconds ?? held ?? 0;
    const step = timedStep(base, brakeCtx?.personalModifier);
    nextSeconds = base + step;
    why = say(voice.TIMED_OVERLOAD, "timed_overload")(step, base);
  } else {
    action = "hold";
    nextSeconds = baseSeconds ?? held;
    why =
      last && !doseEligibility.eligible
        ? doseEligibility.reason === "unfinished"
          ? say(voice.TIMED_DOSE_UNFINISHED_HOLD, "timed_dose_unfinished_hold")
          : doseEligibility.reason === "partial"
            ? say(voice.TIMED_DOSE_PARTIAL_HOLD, "timed_dose_partial_hold")
            : doseEligibility.reason === "under_prescribed"
              ? say(voice.TIMED_DOSE_UNDER_HOLD, "timed_dose_under_hold")
              : say(voice.TIMED_DOSE_NON_COMPARABLE_HOLD, "timed_dose_non_comparable_hold")
        : say(voice.TIMED_DEFAULT_HOLD, "timed_default_hold");
  }

  const response = recentMovementResponse(name, { intent_key: "strength:timed" });
  if (response.verdict === "earned_hold") {
    if (action === "overload") {
      action = "hold";
      nextSeconds = baseSeconds;
      why = say(voice.TIMED_RESPONSE_HOLD, "timed_response_hold");
    } else if (action === "hold" && last && doseEligibility.eligible) {
      action = "deload";
      nextSeconds = baseSeconds != null ? Math.max(10, Math.round(baseSeconds * (1 - DELOAD_FRAC))) : baseSeconds;
      why = say(voice.TIMED_RESPONSE_DELOAD, "timed_response_deload");
    }
  }

  // AUTOREGULATION GATE (timed): a sore joint this hold loads, high soreness, or a
  // just-smoked group holds/eases the duration rather than extending. Timed work
  // eases in SECONDS, never load. Applied last so it wins over the earned extension.
  let autoregulated = false;
  const brake = brakeCtx
    ? autoregBrake(action, brakeCtx.canonGroup, !!last, brakeCtx.autoreg, brakeCtx.acute, name, date)
    : null;
  if (brake) {
    autoregulated = true;
    action = brake.action;
    why = brake.why;
    if (brake.action === "hold") nextSeconds = baseSeconds;
    else nextSeconds = baseSeconds != null ? Math.max(10, Math.round(baseSeconds * (1 - DELOAD_FRAC))) : baseSeconds;
  }

  const suggested: PrescriptionTarget = { sets, seconds: nextSeconds ?? undefined };
  const delta_text = secondsDeltaText(baseSeconds, nextSeconds);

  return {
    exercise: ex_name(name),
    mode: "timed",
    autoregulated: autoregulated || undefined,
    movement_response: response.verdict,
    action,
    suggested,
    current: cur,
    delta_text,
    why,
    dose_eligibility: doseEligibility,
  };
}

function secondsDeltaText(current: number | null, next: number | null): string {
  if (next == null) return "hold";
  if (current == null) return `${next}s`;
  const d = next - current;
  if (d === 0) return `hold ${current}s`;
  return d > 0 ? `+${d}s` : `−${Math.abs(d)}s`;
}

// Preserve the exercise's stored display name (case) when we have it.
function ex_name(name: string): string {
  const ex = findExercise(name);
  return ex?.name ?? name;
}

// ---- a whole plan day's progression -----------------------------------------
// nextPrescription for every STRENGTH item on a plan day (cardio skipped — the
// runner loop owns those). Powers Today's session card + the apply path. Each
// row carries its plan_item_id so a "apply these" build can route through
// propose→apply by day_number.
export function planDayProgression(dayNumber: number, opts: { forNextSession?: boolean } = {}): Prescription[] {
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!day) return [];
  const items = db
    .prepare(
      `SELECT pi.id AS plan_item_id, pi.kind AS kind, e.name AS name
       FROM plan_items pi LEFT JOIN exercises e ON e.id = pi.exercise_id
      WHERE pi.plan_day_id = ? ORDER BY pi.position`
    )
    .all(day.id) as any[];
  const states = buildLiftStateMap(); // compute the program-state ONCE for the day
  // Autoregulation + acute-load read computed ONCE for the whole day and threaded in,
  // so the one-tap apply proposal built from these is gated too (no overload the
  // morning after soreness / a named sore joint). Equipment + the day's own movements
  // are threaded in too so a variety suggestion ranks by what the athlete can load and
  // never re-suggests an exercise/slot already anywhere in the week.
  // At the finish boundary this proposal is for the NEXT exposure, not another
  // set today. Do not let the just-completed session masquerade as poor readiness;
  // constraints still apply here, and readiness is re-checked when that day starts.
  const autoreg = opts.forNextSession ? null : recentAutoregulation();
  const acute = opts.forNextSession ? null : acuteGates();
  const equip = availableEquipment();
  const plannedMovements = getPlan().flatMap((planDay: any) =>
    (Array.isArray(planDay?.items) ? planDay.items : [])
      .filter((item: any) => item.kind !== "cardio" && item.exercise)
      .map((item: any) => String(item.exercise))
  );
  const personalResponse = whatWorksForYou();
  const preferences = learnedPreferences();
  const today = localDateISO();
  const fuelProtection = currentUnderfuelingRead(today);
  const out: Prescription[] = [];
  for (const it of items) {
    if (it.kind === "cardio" || !it.name) continue; // skip cardio + label-only rows
    const excludeNames = plannedMovements.filter((n) => n.toLowerCase() !== String(it.name).toLowerCase());
    const personalModifier = trainingModifierFor(String(it.name), personalResponse);
    const p = nextPrescription(it.name, states, {
      autoreg,
      acute,
      availableEquipment: equip,
      excludeNames,
      personalModifier,
      preferences,
      date: today,
    });
    if (p) {
      const protectedPrescription = applyFuelProtection(p, fuelProtection, today);
      out.push({ ...protectedPrescription, plan_item_id: it.plan_item_id, day_number: dayNumber });
    }
  }
  return out;
}

// The fuel read's TRAINING consequence, said in the TRAINING register.
//
// This used to concatenate `read.action.line` — a nutrition-domain sentence built
// for the nutrition surfaces — straight into a lift card's `why`, which is how "A
// recent fuel correction is still inside its seven-day settling window, so no
// second calorie move is made." ended up printed under a bench press. The
// consequence (hold this step / take a lighter dose) belongs on the lift; the
// calorie mechanics behind it belong to the surfaces that already carry them.
function applyFuelProtection(prescription: Prescription, read: UnderfuelingRead, date: string): Prescription {
  const say = <T>(set: readonly T[], code: string): T => voice.liftVoice(set, date, code, prescription.exercise);
  if (read.action.training === "proceed") return prescription;
  if (read.action.training === "hold_aggression") {
    if (!["overload", "vary", "introduce"].includes(prescription.action)) {
      return prescription.action === "hold"
        ? {
            ...prescription,
            autoregulated: true,
            why: `${prescription.why} ${say(voice.FUEL_HOLD_CLAUSE, "fuel_hold_clause")}`,
          }
        : prescription;
    }
    const current = prescription.current ?? prescription.suggested;
    return {
      ...prescription,
      action: "hold",
      suggested: { ...current },
      delta_text: prescription.mode === "timed"
        ? current.seconds == null ? "hold" : `hold ${current.seconds}s`
        : current.weight == null ? "hold" : `hold ${current.weight}`,
      vary_to: undefined,
      vary_options: undefined,
      rep_step: undefined,
      // The suggestion is the plan's own number again, so it is no longer the
      // related-lift idea this prescription came in carrying.
      starting_idea: undefined,
      autoregulated: true,
      why: say(voice.FUEL_HOLD_STEP, "fuel_hold_step"),
    };
  }
  if (prescription.action === "deload")
    return {
      ...prescription,
      autoregulated: true,
      why: `${prescription.why} ${say(voice.FUEL_DELOAD_CLAUSE, "fuel_deload_clause")}`,
    };
  const base = prescription.current ?? prescription.suggested;
  const reduced: PrescriptionTarget = {
    ...base,
    sets: Math.max(1, Math.ceil(Number(base.sets || prescription.suggested.sets || 1) / 2)),
  };
  if (prescription.mode === "timed" && Number.isFinite(Number(base.seconds)))
    reduced.seconds = Math.max(10, Math.round(Number(base.seconds) * 0.8));
  if (prescription.mode === "reps" && Number.isFinite(Number(base.weight)) && Number(base.weight) > 0)
    reduced.weight = Math.round(Number(base.weight) * 0.9 * 2) / 2;
  return {
    ...prescription,
    action: "deload",
    suggested: reduced,
    delta_text: "recovery dose",
    vary_to: undefined,
    vary_options: undefined,
    rep_step: undefined,
    starting_idea: undefined,
    autoregulated: true,
    why: say(voice.FUEL_RECOVERY_DOSE, "fuel_recovery_dose"),
  };
}

// The stored strength targets on a day, keyed by lowercased exercise name. A
// present key with a null value is a slot with NO target — which is different from
// a slot that isn't on the day at all, and the re-grounding check needs to tell
// those apart.
function planTargetsForDay(day: number): Map<string, number | null> {
  const out = new Map<string, number | null>();
  try {
    const rows = db
      .prepare(
        `SELECT e.name AS name, pi.target_weight AS target_weight
           FROM plan_items pi
           JOIN plan_days pd ON pd.id = pi.plan_day_id
           JOIN exercises e ON e.id = pi.exercise_id
          WHERE pd.day_number = ? AND (pi.kind IS NULL OR pi.kind != 'cardio')`
      )
      .all(Number(day)) as any[];
    for (const row of rows) out.set(String(row?.name ?? "").toLowerCase(), row?.target_weight ?? null);
  } catch {
    /* no plan day → nothing to compare against */
  }
  return out;
}

// Turn a day's per-lift prescriptions into a DRAFT plan proposal (the one-tap
// auto-progression apply), via the existing propose→apply path — never auto-applied.
// THE ONE shared builder for REST + MCP so they never drift. A `vary` prescription
// becomes a real {swap:{from,to}} change (rotating the stalled lift out for the lead
// same-pattern option) — it used to map to a target change on the SAME exercise at
// the held weight, i.e. a silent no-op. Everything else maps to a target step, and a
// "hold" (including an autoregulation-braked hold) is by definition no change → dropped.
// Returns the designed { ok:false, error } (status 200 at the surface) when there's
// nothing to propose.
export function buildProgressionProposal(
  day: number,
  opts: { forNextSession?: boolean } = {}
): { ok: false; error: string } | { ok: true; proposal: any } {
  if (!Number.isFinite(day)) return { ok: false, error: "day required" };
  const prescriptions = planDayProgression(day, opts);
  const planTargets = planTargetsForDay(day);
  const changes: Record<string, any>[] = [];
  for (const p of prescriptions) {
    // A hold is by definition no change — EXCEPT when it re-grounds a plan target
    // that sits below (or has nothing on it at all) what the athlete demonstrably
    // lifts. Without this the plan never caught up: the prescription said "50 lb"
    // on the card while plan_items kept its stale 27 (or its NULL) forever, so the
    // catch-up existed only in prose. It rides the SAME propose→apply path as every
    // other target nudge — bounded, reversible, ledgered, landing at a natural
    // boundary through applyProposalWithAutonomy — never a silent direct write.
    const planned = planTargets.get(p.exercise.toLowerCase());
    const regroundOnly =
      p.action === "hold" &&
      p.reground === true &&
      p.mode === "reps" &&
      p.suggested?.weight != null &&
      (planned == null || Math.abs(Number(p.suggested.weight) - Number(planned)) > 0.1);
    if (p.action === "hold" && !regroundOnly) continue;
    if (p.rep_step) continue; // a double-progression rep advance is no plan change — the range already covers it
    // A vary/introduce → a first-class swap (rotate the lift out for the lead option).
    if (p.action === "vary" || p.action === "introduce") {
      const to = p.vary_to ?? p.vary_options?.[0]?.name ?? null;
      if (!to) continue; // no candidate → nothing to swap to (skip, never a no-op)
      changes.push({
        day_number: day,
        swap: { from: p.exercise, to },
        reason: p.why || `Rotate a variation in for ${p.exercise}.`,
      });
      continue;
    }
    const c: Record<string, any> = {
      day_number: day,
      exercise: p.exercise,
      sets: p.suggested?.sets ?? null,
      rep_low: p.suggested?.rep_low ?? null,
      rep_high: p.suggested?.rep_high ?? null,
      reason: p.why || p.delta_text || null,
    };
    if (p.mode === "timed") {
      if (p.suggested.seconds != null) c.target_seconds = p.suggested.seconds;
    } else if (p.suggested.weight !== undefined) {
      c.target_weight = p.suggested.weight;
    }
    // Only a change that moves a target (or is a swap) is a real change.
    if (c.target_weight !== undefined || c.target_seconds !== undefined) changes.push(c);
  }
  if (!changes.length) return { ok: false, error: "nothing to propose for this day" };
  const parsed = {
    summary: `Auto-progression for day ${day} — ${changes.length} lift${changes.length === 1 ? "" : "s"}`,
    changes,
  };
  // Retire any prior un-applied auto-progression draft for THIS day so repeated taps
  // never stack duplicates (the fresh draft reflects the latest logs).
  supersedeAutoProgressionDrafts(day);
  const proposal = createProposal("auto-progression", `day ${day} progression`, "", parsed);
  return { ok: true, proposal };
}

// Build a DRAFT proposal to ROTATE one exercise out for another on a day — the
// propose→apply path behind Today's "rotate one in" chips (and MCP swap_exercise).
// Never auto-applies; the swap only lands when the athlete taps Apply. Returns the
// designed { ok:false, error } (status 200 at the surface) on bad input.
export function buildSwapProposal(
  day: number,
  from: string,
  to: string
): { ok: false; error: string } | { ok: true; proposal: any } {
  const d = Number(day);
  if (!Number.isFinite(d)) return { ok: false, error: "day required" };
  const f = String(from ?? "").trim();
  const t = String(to ?? "").trim();
  if (!f) return { ok: false, error: "from exercise required" };
  if (!t) return { ok: false, error: "to exercise required" };
  const parsed = {
    summary: `Rotate ${f} → ${t} on day ${d}`,
    changes: [{ day_number: d, swap: { from: f, to: t }, reason: `Rotate a same-pattern variation in for ${f}.` }],
  };
  const proposal = createProposal("exercise-swap", `swap ${f} → ${t}`, "", parsed);
  return { ok: true, proposal };
}

// Swap one exercise for another on a day AND APPLY it immediately — the in-session
// "rotate one in" intent: the athlete taps a variation and it lands in the plan now,
// so the very next render shows the new movement ready to log against. This is the
// "adapts as I go" path (no Coach review gate); the plan quietly follows the athlete.
// Builds through the same tested buildSwapProposal → applyProposal path so REST + MCP
// never drift, and discards the draft if the apply can't land (e.g. `from` not on the
// day) so nothing is left dangling. Returns the applied result or the designed
// { ok:false, error } at 200.
export function buildAndApplySwap(
  day: number,
  from: string,
  to: string
): { ok: false; error: string } | { ok: true; swapped: any } {
  const draft = buildSwapProposal(day, from, to);
  if (!draft.ok) return draft;
  try {
    const applied = applyProposal(draft.proposal.id) as { ok?: boolean; error?: string; skipped?: Array<{ error?: string }> };
    if (!applied || applied.ok === false) {
      setProposalStatus(draft.proposal.id, "discarded");
      // Prefer the per-change error (e.g. '"X" is not on day N to swap out') over
      // the apply layer's generic line — the surface toasts this verbatim.
      const detail = Array.isArray(applied?.skipped) ? applied.skipped.find((s) => s?.error)?.error : undefined;
      return { ok: false, error: detail || applied?.error || "couldn't apply that swap" };
    }
    // savePlanDay already emitted plan_changed; the explicit swap kind carries
    // WHICH movement rotated out/in so the review can speak to the rotation.
    emitBrainEvent({
      kind: "exercise_swapped",
      domain: "training",
      date: localDateISO(),
      subject_key: `${from} -> ${to}`.slice(0, 160),
    });
    return { ok: true, swapped: applied };
  } catch (e: any) {
    setProposalStatus(draft.proposal.id, "discarded");
    return { ok: false, error: e?.message || "couldn't apply that swap" };
  }
}

// ---- program balance (volume per canonical group) ---------------------------
export interface GroupBalance {
  group: string;
  sets: number; // working sets over the window (per week, rounded)
  band: "low" | "productive" | "high";
  last_trained: string | null; // ISO date of the most recent set in that group
  status: "due" | "ok" | "high";
  // Endurance sessions per week that loaded this region, in heavy-session
  // equivalents. Held SEPARATE from `sets` on purpose (see enduranceByRegion):
  // MUSCLE_LANDMARKS are resistance-calibrated, so folding a run into a set count
  // would make a runner's quads read "productive" on lifting volume they never
  // did. It only ever answers a different question — is this region already
  // carrying real work?
  endurance_sessions: number;
  // True when that endurance load is substantial enough that calling this group
  // "due" would be dishonest. The group is still LOW on resistance volume; it is
  // simply not idle.
  endurance_supported: boolean;
}
export interface ProgramBalance {
  groups: GroupBalance[];
  due: string[];
  over: string[];
  summary: string;
  // True when MOST groups read "due" at once — the honest signal then isn't a
  // 10-item to-do list, it's "overall strength volume is low right now" (expected
  // during an endurance-led block). Surfaces collapse to one calm line instead of a
  // wall of due chips. See buildBalanceSummary.
  broad_low: boolean;
}

// How much ENDURANCE work each region carried over the window, in heavy-session
// equivalents per week. Deliberately a SEPARATE number from the working-set
// tally rather than added into it: MUSCLE_LANDMARKS are calibrated against
// resistance volume, so crediting a long run as "sets" would tell a runner their
// quads are at productive lifting volume they never did. This answers the other
// question — is the region actually idle, or is it just not being LIFTED?
//
// THE RULE (see programBalance): a region carrying at least
// ENDURANCE_SUPPORTED_PER_WEEK heavy-session equivalents is never called "due".
// Its band stays honest (resistance volume really is low), but a 40-mile week
// leaves legs loaded, not neglected, and telling that athlete to go add squat
// volume because their quads look untrained is the connected read failing.
const ENDURANCE_SUPPORTED_PER_WEEK = 1.5;

function enduranceByRegion(weeks: number, date: string): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const days = Math.max(1, Math.round(weeks * 7));
    for (const impact of recentEnduranceImpacts(days, date)) {
      const dose = enduranceDose(impact);
      if (!(dose > 0)) continue;
      for (const region of impact.regions) {
        if (isMobility(region)) continue;
        out.set(region, (out.get(region) ?? 0) + dose / weeks);
      }
    }
  } catch {
    /* no activities → the balance read is simply strength-only, as it always was */
  }
  return out;
}

// Working-set volume per CANONICAL group over the window (default 2 wk), banded
// against MUSCLE_LANDMARKS. Mobility is EXCLUDED from set-count math (it never
// inflates the working-set picture). `due` = a group under its low landmark OR
// not trained in 7 days — UNLESS endurance is already loading that region (see
// enduranceByRegion); `over` = above its high landmark. Plain words only.
export function programBalance(weeks = 2, date = localDateISO()): ProgramBalance {
  const today = String(date || localDateISO()).slice(0, 10);
  const since = addDaysISO(today, -(weeks * 7 - 1)) ?? today;
  const endurance = enduranceByRegion(weeks, today);
  const enduranceWeekly = (group: string): number => Math.round((endurance.get(group) ?? 0) * 10) / 10;

  const rows = db
    .prepare(
      `SELECT e.muscle_group AS muscle_group, e.name AS exercise, s.date AS date,
            ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
       JOIN sessions s ON s.id = ls.session_id
      WHERE s.date >= ? AND s.date <= ?`
    )
    .all(since, today) as any[];

  // ONE honest-volume truth: warmups excluded, RIR-weighted, indirect credit, canon
  // taxonomy (mobility never counts). Shared with muscleVolume + getVolumeByMuscle.
  const tally = effectiveVolumeByGroup(rows as VolumeSet[]);

  const daysAgo = (iso: string | null): number | null => {
    if (!iso) return null;
    return daysBetweenISO(today, iso);
  };

  const groups: GroupBalance[] = [];
  for (const [group, v] of tally) {
    const weeklySets = Math.round((v.sets / weeks) * 10) / 10;
    const lm = MUSCLE_LANDMARKS[group];
    let band: GroupBalance["band"] = "productive";
    if (lm) band = weeklySets < lm.low ? "low" : weeklySets > lm.high ? "high" : "productive";
    const since7 = daysAgo(v.last_date);
    const stale = since7 != null && since7 > 7;
    const enduranceSessions = enduranceWeekly(group);
    const supported = enduranceSessions >= ENDURANCE_SUPPORTED_PER_WEEK;
    const wouldBeDue = band === "low" || stale;
    const status: GroupBalance["status"] =
      wouldBeDue && !supported ? "due" : band === "high" ? "high" : "ok";
    groups.push({
      group,
      sets: weeklySets,
      band,
      last_trained: v.last_date,
      status,
      endurance_sessions: enduranceSessions,
      endurance_supported: supported && wouldBeDue,
    });
  }
  // Surface groups that are PROGRAMMED but not trained at all in the window too.
  // Otherwise the brain can show "Pull" because the template says so while the
  // balance layer quietly omits push/core groups that have zero recent rows. Keep
  // this plan-scoped: totally unplanned groups still surface through the explicit
  // missing-pattern gaps below, not as a fake 12-item due wall.
  const presentGroups = new Set(groups.map((g) => g.group));
  const plannedGroups = new Set([...plannedMovesByGroup().keys()].filter((g) => MUSCLE_LANDMARKS[g]));
  if (plannedGroups.size) {
    const lastByGroup = new Map<string, string>();
    const lastRows = db
      .prepare(
        `SELECT e.muscle_group AS muscle_group, e.name AS exercise, MAX(s.date) AS last_date
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
         JOIN sessions s ON s.id = ls.session_id
        WHERE s.date <= ?
        GROUP BY e.id`
      )
      .all(today) as any[];
    for (const r of lastRows) {
      const g = canonicalGroup(r.muscle_group) ?? classifyMuscleGroup(r.exercise);
      if (!g || g === "mobility" || !MUSCLE_LANDMARKS[g]) continue;
      const last = String(r.last_date || "");
      if (last && (!lastByGroup.has(g) || last > (lastByGroup.get(g) ?? ""))) lastByGroup.set(g, last);
    }
    for (const group of plannedGroups) {
      if (presentGroups.has(group)) continue;
      // The same rule applies to a group with ZERO logged sets: a runner's calves
      // are programmed, untrained, and anything but idle.
      const enduranceSessions = enduranceWeekly(group);
      const supported = enduranceSessions >= ENDURANCE_SUPPORTED_PER_WEEK;
      groups.push({
        group,
        sets: 0,
        band: "low",
        last_trained: lastByGroup.get(group) ?? null,
        status: supported ? "ok" : "due",
        endurance_sessions: enduranceSessions,
        endurance_supported: supported,
      });
      presentGroups.add(group);
    }
  }

  groups.sort((a, b) => b.sets - a.sets);

  const due = groups.filter((g) => g.status === "due").map((g) => g.group);
  const over = groups.filter((g) => g.status === "high").map((g) => g.group);

  // Broad-low: when MOST groups are due at once, the signal is "overall strength
  // volume is low", not a per-group to-do list — common when running is the focus.
  const broad_low = groups.length >= 5 && due.length >= Math.ceil(groups.length * 0.6);

  // Plain-words adherence-skew summary (no numbers as a grade).
  const summary = buildBalanceSummary(groups, due, over, broad_low);
  return { groups, due, over, summary, broad_low };
}

function buildBalanceSummary(groups: GroupBalance[], due: string[], over: string[], broadLow: boolean): string {
  if (!groups.length)
    return "Not enough logged yet to read your volume balance — keep training and it'll come into focus.";
  // Broad-low → one calm line instead of listing every group. Name the 1-2 groups
  // that have gone LONGEST without work (the genuinely-neglected standouts) so it
  // stays actionable, never a wall of "everything's behind".
  if (broadLow) {
    const overPart = over.length ? ` ${over.join(", ")} running a touch high.` : "";
    const stale = due
      .map((g) => groups.find((x) => x.group === g))
      .filter((g): g is GroupBalance => !!g)
      .sort((a, b) => (a.last_trained ?? "").localeCompare(b.last_trained ?? ""))
      .slice(0, 2)
      .map((g) => g.group);
    const lead = stale.length
      ? ` No need to chase every group — ${stale.join(" and ")} ${stale.length > 1 ? "have" : "has"} gone longest without work, so start there.`
      : "";
    return `Strength volume is light across most groups right now — expected if running is the priority, not a problem.${overPart}${lead}`;
  }
  // Regions the endurance work is already carrying. Named so they do not simply
  // VANISH from the picture — "light on lifting, but not idle" is the honest read,
  // and it is the difference between a calm note and an unexplained silence.
  const carried = groups.filter((g) => g.endurance_supported).map((g) => g.group);
  const carriedPart = carried.length
    ? ` ${plainGroupWords(carried, 2)} ${carried.length > 1 ? "are" : "is"} light on lifting but already carrying your endurance work.`
    : "";
  const parts: string[] = [];
  if (over.length) parts.push(`${over.join(", ")} running high`);
  if (due.length) parts.push(`${due.join(", ")} due`);
  if (!parts.length)
    return `Volume looks well balanced across the groups you're training.${carriedPart}`;
  return `${parts.join("; ")}.${carriedPart}`;
}

// ---- the "what changed & why" digest ----------------------------------------
export interface ProgramAdjustment {
  kind: "progression" | "balance" | "deload" | "gap" | "cardio" | "dexa" | "test";
  title: string;
  why: string;
  exercise?: string;
  // The canonical group this is about (balance/gap items), so the UI can route a
  // "plan it" action; and a few concrete movements to actually do about it.
  group?: string;
  suggestions?: string[];
  // A due group that's recovering from recent acute load (a long ride/run, or a
  // heavy session) — informational, NOT a "do it now" pick. The UI sinks + reframes
  // it; "plan it" becomes "plan around it" rather than "add it".
  recovering?: boolean;
  // A due group that is ALREADY programmed in the plan — the gap is logged volume,
  // not a missing movement. The UI reframes "add a movement" → "train what's there"
  // so it never tells you to add work you already have scheduled.
  programmed?: boolean;
}

// The handful of concrete adaptations DUE right now — lifts to push/hold/deload
// (from the plan-day prescriptions across the whole plan), groups that are due,
// and missing-pattern GAPS (no core / grip / mobility programmed). Plain words,
// most-actionable first, deduped. This is the calm "what the system noticed"
// surface — pull, never push.
export function programAdjustments(
  balArg?: ProgramBalance,
  acuteArg?: Map<MuscleGroup, AcuteGateReading>,
  opts?: { runPlan?: WeeklyRunPlan | null; dexa?: DexaTargeting | null; testWeek?: TestWeekDue | null }
): ProgramAdjustment[] {
  const out: ProgramAdjustment[] = [];
  const seen = new Set<string>();
  const push = (a: ProgramAdjustment) => {
    const k = `${a.kind}|${a.title}`.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a);
  };

  // 1) Per-lift adaptations across every plan day — deloads + varies first
  //    (most actionable), then earned overloads.
  const days = db.prepare(`SELECT day_number FROM plan_days ORDER BY day_number`).all() as any[];
  const deloads: ProgramAdjustment[] = [];
  const varies: ProgramAdjustment[] = [];
  const overloads: ProgramAdjustment[] = [];
  for (const d of days) {
    for (const p of planDayProgression(d.day_number)) {
      if (p.action === "deload")
        deloads.push({ kind: "deload", title: `Deload ${p.exercise}`, why: p.why, exercise: p.exercise });
      else if (p.action === "vary")
        varies.push({
          kind: "progression",
          title: `Rotate a variation for ${p.exercise}`,
          why: p.why,
          exercise: p.exercise,
        });
      else if (p.action === "overload")
        overloads.push({
          kind: "progression",
          title: `${p.exercise} — ${p.delta_text}`,
          why: p.why,
          exercise: p.exercise,
        });
    }
  }
  // Lead with the WINS — an earned step-up is the most motivating, actionable thing a
  // coach can surface ("your work paid off, here's the load"). They used to be pushed
  // dead-last and cut by the 8-item cap, buried under "No X programmed" gap-nags.
  overloads.slice(0, 3).forEach(push);
  deloads.forEach(push);
  varies.forEach(push);

  // 2) Mesocycle: a deload about due (program-state read).
  try {
    const st = getProgramState();
    if (st.mesocycle?.phase === "deload-due") {
      push({ kind: "deload", title: "A deload week is about due", why: st.mesocycle.note });
    }
  } catch {
    /* program-state unavailable → skip */
  }

  // 3) Balance: groups that are due (under-volume or not trained recently) —
  //    reconciled against ACUTE recovery so a just-smoked muscle is never put up as
  //    the next move. A group hammered in the last day or two (lifting OR a long
  //    ride/run) is held back (sunk below fresh work + the gaps, reframed honestly);
  //    fresh due groups lead. This is the connected read that makes the next-day
  //    pick elite — your legs are toast after a 3 h ride, so it stops recommending
  //    them and surfaces what's actually fresh.
  // Reuse the balance + acute-load reads getCoachContext already computed (the hot
  // path), falling back to a fresh compute when called standalone.
  const bal = balArg ?? programBalance();
  const acute = acuteArg ?? acuteGates();
  // Plan-aware reframe: a due group that's ALREADY programmed doesn't need a NEW
  // movement — the gap is logged volume (you scheduled it; train it). So we never
  // tell you to "add a back movement" when your plan already has rows, lat pulldowns
  // and pull-ups. ONE plan query feeds both the per-group moves and the GAPS below.
  const plannedMoves = plannedMovesByGroup();
  const planned = new Set(plannedMoves.keys());
  const recovering: Array<{ group: string; gate: AcuteGateReading }> = [];
  for (const g of bal.due.slice(0, 4)) {
    const gb = bal.groups.find((x) => x.group === g);
    const reason = gb && gb.band === "low" ? "under its productive volume range lately" : "not trained in over a week";
    // The shared acute gate: a group still carrying a session's worth of
    // undissipated work is never put up as the next move, however "due" it looks.
    const gate = acute.get(g as MuscleGroup);
    if (gate?.saturated) {
      recovering.push({ group: g, gate });
      continue;
    }
    if (planned.has(g)) {
      // Already in the plan — honest read: get those sessions in, don't add more.
      const moves = plannedMoves.get(g) ?? [];
      const where = plannedDaysPhrase(moves);
      push({
        kind: "balance",
        title: `${cap(g)} is due`,
        why: `${cap(g)} is ${reason}, but it's already in your plan${where ? ` (${where})` : ""} — the gap is logged volume, so get those sessions in this week rather than adding more.`,
        group: g,
        suggestions: moves.slice(0, 3).map((m) => m.exercise),
        programmed: true,
      });
    } else {
      push({
        kind: "balance",
        title: `${cap(g)} is due`,
        why: `${cap(g)} is ${reason} — work it in this week.`,
        group: g,
        suggestions: examplesForGroup(g, 3),
      });
    }
  }
  // ONE consolidated recovering note, right after the fresh due groups — so the
  // athlete SEES why a smoked muscle isn't being recommended (the connected read)
  // without three near-identical rows crowding the card, and it always survives the
  // 8-item cap. Fresh, actionable work still leads above it.
  if (recovering.length) {
    const groups = recovering.map((r) => r.group);
    const lead = (recovering.find((r) => r.gate.activity) ?? recovering[0]).gate;
    const many = groups.length > 1;
    const subj = many ? "They're" : `${cap(groups[0])} is`;
    const it = many ? "them" : "it";
    push({
      kind: "balance",
      title: `${cap(groups.join(", "))} — recovering`,
      why: `${subj} due, but ${loadPhrase(lead)} loaded ${it} hard — give ${it} a day before training ${it} again. The fresher work above is the smarter pick for your next session.`,
      group: groups[0],
      recovering: true,
    });
  }
  for (const g of bal.over.slice(0, 2)) {
    push({
      kind: "balance",
      title: `${cap(g)} is running high`,
      why: `${cap(g)} volume is above its productive range — there's room to redirect some of it to a due group.`,
      group: g,
    });
  }

  // 4) Missing-pattern GAPS — the elite-coach floors this athlete is missing.
  //    Read what groups appear ANYWHERE in the plan; flag core / forearms (grip)
  //    / mobility when they're absent (they were invisible until the taxonomy
  //    added them as first-class groups). Reuses `planned` from the balance step.
  // Gap titles are ADDITIVE and calm ("Add a little core"), never a "No X programmed"
  // nag-wall — these are gentle floors worth rounding the program out with, not failures
  // (constitution: calm, never shaming). They sit BELOW the earned wins + due focus above.
  for (const [group, title, why, suggestions] of [
    [
      "core",
      "Add a little core",
      "No anti-extension / anti-rotation core work is programmed — a loaded carry or a plank/pallof variation underpins everything else.",
      ["Pallof Press", "Farmer's Walk", "Hanging Leg Raise"],
    ],
    [
      "forearms",
      "Work in some grip",
      "No grip work is programmed — dead hangs or loaded carries build grip, protect the elbow, and carry over to every pull.",
      ["Farmer's Walk", "Suitcase Carry", "Dead Hang"],
    ],
    [
      "mobility",
      "A little mobility prep",
      "No mobility / activation work is programmed — a few minutes of ankle + hip prep protects the joints, especially for a returning runner.",
      ["Ankle Rocker", "90/90 Hip Switch", "World's Greatest Stretch"],
    ],
  ] as const) {
    if (!planned.has(group)) {
      push({ kind: "gap", title, why, group, suggestions: [...suggestions] });
    }
  }

  // 5) RUNNING — this week's periodized run mix as a single calm digest item, so
  //    the "what changed & why" surface spans running, not just lifting. Reuse the
  //    pre-computed plan from getCoachContext when threaded; else compute it lazily.
  try {
    const rp = opts && "runPlan" in opts ? opts.runPlan : weeklyRunPlan();
    if (rp?.available && rp.mix_summary) {
      push({
        kind: "cardio",
        title: `This week's runs: ${rp.mix_summary}`,
        why: rp.why || (Array.isArray(rp.rationale) ? rp.rationale.join(" ") : ""),
      });
    }
  } catch {
    /* run plan unavailable → skip */
  }

  // 6) DEXA — the body scan's training targets as gentle "From your DEXA" items
  //    (bias + concrete moves). Nutrition targets stay in the nutrition prompts.
  try {
    const dx = opts && "dexa" in opts ? opts.dexa : dexaTargeting();
    if (dx?.available && Array.isArray(dx.targets)) {
      for (const t of dx.targets.filter((x) => x.domain === "training").slice(0, 2)) {
        push({
          kind: "dexa",
          title: `From your DEXA: ${t.bias}`,
          why: `${t.signal}${Array.isArray(t.moves) && t.moves.length ? ` Moves: ${t.moves.join(", ")}.` : ""}`,
          group: Array.isArray(t.groups) && t.groups.length ? t.groups[0] : undefined,
          suggestions: Array.isArray(t.moves) ? t.moves.slice(0, 3) : undefined,
        });
      }
    }
  } catch {
    /* dexa unavailable → skip */
  }

  // 7) TEST WEEK — a cadenced re-test invitation (block realization / ~7-week
  //    cadence), naming the benchmark lifts to re-anchor true capacity.
  try {
    const tw = opts && "testWeek" in opts ? opts.testWeek : testWeekDue();
    if (tw?.due && Array.isArray(tw.key_lifts) && tw.key_lifts.length) {
      push({
        kind: "test",
        title: "A test week is about due",
        why: `${tw.why} Worth re-testing: ${tw.key_lifts.join(", ")}.`,
      });
    }
  } catch {
    /* test-week unavailable → skip */
  }

  return out.slice(0, 8);
}

// The strength movements programmed in the plan, grouped by canonical muscle group
// (with the day each sits on) — so a due-but-programmed group can say "you have these,
// on these days" instead of suggesting movements you already train. ONE query feeds
// both the per-group moves and the plan's programmed-group set (its keys).
type PlannedMove = { exercise: string; day: number; day_name: string | null };
function plannedMovesByGroup(): Map<string, PlannedMove[]> {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.name AS name, e.muscle_group AS mg, pd.day_number AS day, pd.name AS day_name
       FROM plan_items pi
       JOIN exercises e ON e.id = pi.exercise_id
       JOIN plan_days pd ON pd.id = pi.plan_day_id
      WHERE (pi.kind IS NULL OR pi.kind != 'cardio')
      ORDER BY pd.day_number, pi.position`
    )
    .all() as any[];
  const map = new Map<string, PlannedMove[]>();
  for (const r of rows) {
    const g = canonicalGroup(r.mg) ?? classifyMuscleGroup(r.name);
    if (!g) continue;
    (map.get(g) ?? map.set(g, []).get(g)!).push({ exercise: r.name, day: r.day, day_name: r.day_name ?? null });
  }
  return map;
}

// Plain-words "Day 3 (Pull), Day 5" phrase over a group's programmed movements.
function plannedDaysPhrase(moves: Array<{ day: number; day_name: string | null }>): string {
  const seen = new Set<number>();
  const parts: string[] = [];
  for (const m of moves) {
    if (seen.has(m.day)) continue;
    seen.add(m.day);
    parts.push(`Day ${m.day}${m.day_name ? ` (${m.day_name})` : ""}`);
    if (parts.length >= 3) break;
  }
  return parts.join(", ");
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ---------------------------------------------------------------------------
// programEvolutionTrigger — the DATA-TRIGGERED half of the continuous-coach
// cadence. The scheduler's WEEKLY auto-evolution fires on the calendar; this
// answers "has the athlete's own logged data shifted enough that the plan should
// adapt SOONER than next Sunday?" — a lift truly plateaued and wanting a
// variation (more load isn't the answer), a muscle group running UNDER its
// productive volume range (a weak point to build — core / grip / a lagging
// pattern), or a cadenced re-test come due. Deterministic, no agent, no scores.
//
// The scheduler reads `due` + the stable `signature` (so a STANDING condition
// drafts ONCE, not every day) and, on a genuine shift, drafts the same one-tap
// evolution proposal early — still pull-never-push, still deduped so it never
// piles up. Materiality guard: a weak-point group only triggers for an athlete
// who is ACTUALLY training (≥4 logged sessions on some lift), so a brand-new
// plan — which reads every group as "under-trained" — is a calm no-op, not a
// flood. Injectable opts mirror testWeekDue/programAdjustments for pure testing.
// ---------------------------------------------------------------------------
export interface ProgramEvolutionTrigger {
  due: boolean;
  reasons: string[]; // plain-language, surfaced as the draft's "why now"
  signature: string; // stable key of the conditions, for once-per-shift dedup
}

export function programEvolutionTrigger(
  date?: string,
  opts: {
    programState?: any;
    balance?: ProgramBalance;
    testWeek?: TestWeekDue;
    enduranceTests?: { exercise?: string; kind?: string; why?: string }[];
    trainingPlaybook?: TrainingPlaybookRead | null;
  } = {}
): ProgramEvolutionTrigger {
  const reasons: string[] = [];
  const sigParts: string[] = [];

  let ps = opts.programState;
  if (ps === undefined) {
    try {
      ps = getProgramState(date);
    } catch {
      ps = { lifts: [] };
    }
  }
  const lifts = Array.isArray(ps?.lifts) ? ps.lifts : [];
  // Enough logged history to read a real trajectory (plateau/vary already imply
  // ≥3 sessions; this gate is for the weak-point signal, which would otherwise
  // light up on a never-trained group of a fresh plan).
  const hasHistory = lifts.some((l: any) => (l?.sessions ?? 0) >= 4);

  // (1) A lift that has truly plateaued and wants a variation, or is regressing —
  //     the strongest "the plan should change" signal (load isn't the lever).
  const wantsVary = lifts
    .filter((l: any) => l?.suggested_action === "vary" || l?.status === "regressing")
    .map((l: any) => l?.exercise)
    .filter(Boolean)
    .map((s: any) => String(s))
    .sort();
  if (wantsVary.length) {
    reasons.push(
      wantsVary.length === 1
        ? `${wantsVary[0]} has stalled — time to rotate a variation in.`
        : `${wantsVary.slice(0, 3).join(", ")} have stalled — time to rotate variations in.`
    );
    sigParts.push(`vary:${wantsVary.join(",")}`);
  }

  // (1b) Support-work: a lagging COMPOUND whose CONTRIBUTING muscles are under-
  //      trained wants targeted supporting work, not just a movement rotation — the
  //      elite-coach read ("bench is stuck and the triceps are the weak link; build
  //      them before rotating the lift"). Deterministic, driven off the same
  //      program-state read. Each entry folds its plain-language suggestion into the
  //      reasons and a stable {lift + weak-link groups} digest into the signature, so
  //      a standing weak-link condition drafts once and re-arms only when the picture
  //      changes. Reuses the already-resolved `ps` (no recompute; injectable in tests).
  const supportEntries = supportWorkRead(date, { programState: ps });
  for (const entry of supportEntries) {
    reasons.push(entry.suggestion);
    sigParts.push(entry.signature);
  }

  // (3) A cadenced re-test come due — re-measure true capacity before the next
  //     block (an honest checkpoint, never a forced max). Computed before the
  //     weak-point clause so it can also satisfy the "actively training" gate.
  let tw = opts.testWeek;
  if (tw === undefined) {
    try {
      tw = testWeekDue(date, { programState: ps });
    } catch {
      tw = undefined;
    }
  }
  const twDue = !!tw?.due;

  // (2) Endurance/hybrid shifts that should wake the same plan-evolution loop:
  //     a material mileage ramp, a mono-stimulus/run-plateau read, a due endurance
  //     benchmark, or a ramp colliding with the next strength day. This is still
  //     a draft trigger only — it does not mutate the plan.
  const endurance = ps?.endurance;
  const hybrid = ps?.hybrid;
  const enduranceAcwr = Number(endurance?.acute_chronic_ratio);
  const mileageRamp = Number.isFinite(enduranceAcwr) && enduranceAcwr >= 1.25;
  if (mileageRamp) {
    const pct = Math.round((enduranceAcwr - 1) * 100);
    reasons.push(`Endurance volume is up ~${pct}% over your base — adapt the week before stacking more load.`);
    sigParts.push(`endurance-ramp:${Math.round(enduranceAcwr * 100)}`);
  }
  if (endurance?.suggested_action === "add-quality") {
    reasons.push(
      "Running has turned into one steady stimulus — add a quality or long-run variation instead of just repeating the same run."
    );
    sigParts.push("run-plateau:add-quality");
  } else if (endurance?.pace_trend === "declining") {
    reasons.push(
      "Run pace is drifting the wrong way — treat this as a recovery/programming problem before adding more mileage."
    );
    sigParts.push("run-plateau:pace-decline");
  }
  if (
    mileageRamp &&
    (hybrid?.next_strength?.advice === "swap-or-upper" || hybrid?.next_strength?.advice === "hold-load")
  ) {
    reasons.push(
      `Mileage is ramping into ${hybrid.next_strength.day_name || "the next strength day"} — sequence lower-body work or deload it instead of forcing both.`
    );
    sigParts.push(`hybrid-interference:${hybrid.next_strength.advice}:${hybrid.next_strength.day_number ?? "next"}`);
  }

  let et = opts.enduranceTests;
  if (et === undefined) {
    try {
      et = enduranceTestsDue(date);
    } catch {
      et = undefined;
    }
  }
  const enduranceTestKeys = (Array.isArray(et) ? et : [])
    .map((t) => String(t?.exercise || "").trim())
    .filter(Boolean)
    .sort();
  if (enduranceTestKeys.length) {
    reasons.push(`An endurance benchmark is due (${enduranceTestKeys.slice(0, 2).join(", ")}).`);
    sigParts.push(`endurance-test:${enduranceTestKeys.join(",")}`);
  }

  let playbook = opts.trainingPlaybook;
  if (playbook === undefined) {
    try {
      playbook = trainingPlaybook(date, { programState: ps });
    } catch {
      playbook = null;
    }
  }
  const plays = Array.isArray(playbook?.plateau_plays) ? playbook!.plateau_plays : [];
  for (const play of plays) {
    if (!play?.kind) continue;
    if (play.kind === "strength_plateau" && wantsVary.includes(String(play.exercise || ""))) {
      continue; // the older vary trigger already names this exact lift
    }
    reasons.push(`${play.title}: ${play.adaptations?.[0] || play.why}`);
    sigParts.push(`playbook:${play.kind}:${play.exercise || play.title}`);
  }
  if (playbook?.adherence && playbook.adherence.status !== "clear") {
    reasons.push(
      `${playbook.adherence.pattern} Suggest a smaller or shorter template instead of letting the plan silently fail.`
    );
    sigParts.push(
      `adherence:${playbook.adherence.status}:${playbook.adherence.missed_planned_sessions}:${playbook.adherence.skipped_exercises}`
    );
  }

  // (3) A muscle group running UNDER its productive volume range (or untrained
  //     lately) — a weak point worth building toward. Only fires for an athlete
  //     with real training history (else a blank new plan reads everything "due").
  let bal = opts.balance;
  if (bal === undefined) {
    try {
      bal = programBalance(2, date);
    } catch {
      bal = undefined;
    }
  }
  const dueGroups = [...(Array.isArray(bal?.due) ? bal!.due : [])].sort();
  if (dueGroups.length && (hasHistory || wantsVary.length || twDue)) {
    reasons.push(
      `${dueGroups.slice(0, 3).join(", ")} ${dueGroups.length === 1 ? "is" : "are"} under-trained — worth building up.`
    );
    sigParts.push(`due:${dueGroups.join(",")}`);
  }

  if (twDue) {
    const keys = Array.isArray(tw?.key_lifts) ? tw!.key_lifts.slice(0, 2) : [];
    reasons.push(`A re-test is due${keys.length ? ` (${keys.join(", ")})` : ""}.`);
    sigParts.push("test:1");
  }

  return { due: reasons.length > 0, reasons, signature: sigParts.join("|") };
}
