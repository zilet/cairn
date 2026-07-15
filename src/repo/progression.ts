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
  movementKey,
  type MuscleGroup,
  MUSCLE_LANDMARKS,
  normalizeExerciseName,
  normalizedExerciseKey,
  resolveGroup,
} from "./exercise-canon.js";
import {
  type Equipment,
  effectiveVolumeByGroup,
  examplesForGroup,
  parseEquipment,
  suggestAlternatives,
  type VolumeSet,
} from "./exercise-variations.js";
import { findExercise, recentWorkingWeight } from "./exercises.js";
import { loadPhrase, recentMuscleLoad, type RecentLoad } from "./hybrid-load.js";
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
// Run-plan / DEXA / test-week digest producers. Imported for their types + a lazy
// compute when programAdjustments is called standalone (Today/Progress). The module
// cycle (progression → run-progression → coach → progression) is resolved at call
// time — these are only invoked inside programAdjustments, never at module init.
import { enduranceTestsDue, weeklyRunPlan, type WeeklyRunPlan } from "./run-progression.js";
import { dexaTargeting, type DexaTargeting } from "./dexa-targeting.js";
import { testWeekDue, type TestWeekDue } from "./muscle-trajectory.js";
import { trainingPlaybook, type TrainingPlaybookRead } from "./training-playbook.js";

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
  vary_to?: string; // a concrete same-pattern variation to rotate in (action "vary")
  vary_options?: { name: string; why: string }[]; // a MENU of same-pattern swaps (action "vary"); vary_to is the lead
  plan_item_id?: number; // set by planDayProgression for the apply path
  day_number?: number; // set by planDayProgression — the day the lift sits on (for the swap apply path)
  autoregulated?: boolean; // recovery signals braked this step (overload→hold / hold→deload) — informational
  rep_step?: boolean; // double-progression REP advance (load held, reps climb in-range) — no plan change
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
}

const AUTOREG_WINDOW_DAYS = 3; // feedback older than this is stale — don't brake on it

// Read the most recent session feedback within the window (the freshest non-null
// value of each field). Null-safe: no feedback → all nulls (no brake).
export function recentAutoregulation(days = AUTOREG_WINDOW_DAYS, date = localDateISO()): AutoregSignals {
  const today = String(date || localDateISO()).slice(0, 10);
  const since = addDaysISO(today, -(Math.max(1, days) - 1)) ?? today;
  const out: AutoregSignals = { soreness: null, performance: null, joint_pain: null, date: null };
  try {
    const rows = db
      .prepare(
        `SELECT date, soreness, performance, joint_pain FROM sessions
        WHERE date >= ? AND date <= ? ORDER BY date DESC`
      )
      .all(since, today) as any[];
    for (const r of rows) {
      if (out.soreness == null && r.soreness != null) out.soreness = Number(r.soreness);
      if (out.performance == null && r.performance != null) out.performance = Number(r.performance);
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
  return out;
}

// A named joint (free-text like "left knee") → the canonical groups whose loaded
// work stresses that joint, so we can tell whether THIS lift loads the sore joint.
const JOINT_GROUP_MAP: Array<{ re: RegExp; groups: MuscleGroup[] }> = [
  { re: /knee/, groups: ["quads", "hamstrings", "calves"] },
  { re: /shoulder|delt|rotator|\bac\b/, groups: ["chest", "shoulders", "rear delts"] },
  { re: /elbow|cubital|forearm|\bwrist/, groups: ["biceps", "triceps", "forearms", "back"] },
  { re: /lower ?back|lumbar|\bback\b|spine|\bsi\b|sacro/, groups: ["back", "hamstrings", "quads"] },
  { re: /\bhip\b|groin|glute/, groups: ["glutes", "hamstrings", "quads"] },
  { re: /ankle|achilles|\bcalf\b|\bfoot\b|shin|tib/, groups: ["calves", "quads"] },
];

// Some pain areas load a movement through a joint even when that joint is not the
// exercise's primary muscle group (an elbow can matter to a chest press, for
// example). Keep that movement-level knowledge beside the progression engine's
// muscle map so every consumer uses the same conservative relevance test.
const JOINT_MOVEMENT_MAP: Array<{ re: RegExp; movements: RegExp }> = [
  { re: /knee/, movements: /\b(squat|lunge|leg press|leg extension|step[ -]?up|calf)\b/ },
  { re: /shoulder|delt|rotator|\bac\b/, movements: /\b(press|bench|push[ -]?up|dip|fly|lateral raise|row|pull[ -]?(?:up|down))\b/ },
  { re: /elbow|cubital|forearm|\bwrist/, movements: /\b(press|bench|pushdown|extension|curl|row|pull[ -]?(?:up|down)|chin[ -]?up|dip)\b/ },
  { re: /chest|pec|sternum|\brib\b/, movements: /\b(press|bench|push[ -]?up|dip|fly)\b/ },
  { re: /lower ?back|lumbar|\bback\b|spine|\bsi\b|sacro/, movements: /\b(deadlift|hinge|squat|row|good morning|back extension)\b/ },
  { re: /\bhip\b|groin|glute/, movements: /\b(squat|lunge|deadlift|hinge|hip thrust|step[ -]?up)\b/ },
  { re: /ankle|achilles|\bcalf\b|\bfoot\b|shin|tib/, movements: /\b(calf|squat|lunge|step[ -]?up|run|jump)\b/ },
];

function jointLoadsGroup(jointText: string, group: MuscleGroup | null): boolean {
  if (!group) return false;
  const s = String(jointText || "").toLowerCase();
  if (!s) return false;
  for (const m of JOINT_GROUP_MAP) if (m.re.test(s) && m.groups.includes(group)) return true;
  return false;
}

/**
 * Whether free-text pain feedback is relevant to one exercise. This is a
 * loading-relevance check, not a diagnosis: unmapped text returns false rather
 * than making every lift look injured.
 */
export function painAreaLoadsExercise(
  jointText: string | null | undefined,
  exercise: { name?: string | null; muscle_group?: string | null },
): boolean {
  const text = String(jointText ?? "").trim().toLowerCase();
  if (!text) return false;
  const group = resolveGroup(exercise.muscle_group ?? "", exercise.name ?? "");
  if (jointLoadsGroup(text, group)) return true;
  const name = String(exercise.name ?? "").toLowerCase();
  return JOINT_MOVEMENT_MAP.some((entry) => entry.re.test(text) && entry.movements.test(name));
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
  recentLoad: Map<MuscleGroup, RecentLoad> | null
): BrakeResult {
  if (!autoreg && !recentLoad) return null;
  const heavyAcute = group && recentLoad ? recentLoad.get(group)?.heavy === true : false;
  const jointHit = group && autoreg?.joint_pain ? jointLoadsGroup(autoreg.joint_pain, group) : false;
  const soreHigh = autoreg?.soreness != null && autoreg.soreness >= 4;
  const perfLow = autoreg?.performance != null && autoreg.performance <= 2;
  const highStrain = soreHigh || perfLow || heavyAcute;

  // A named sore joint is the strongest brake — one step toward safety.
  if (jointHit) {
    if (action === "overload") {
      return {
        action: "hold",
        why: `Your last check-in flagged a sore joint this lift loads — holding the load today rather than adding; earn a clean, pain-free session first.`,
      };
    }
    if (action === "hold" && hasHistory) {
      return {
        action: "deload",
        why: `A sore joint this lift loads is still flagged — easing the load a touch so it can settle before you build again.`,
      };
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
      why: `Holding the load today — ${reason}, so this isn't the session to push. Recovery informs the plan; it's a brake, not a penalty.`,
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

function trainingModifierFor(
  exerciseName: string,
  response: CoachWhatWorksForYou | null = whatWorksForYou()
): CoachPersonalModifier | null {
  if (!response) return null;
  const matchingLearning = response.learnings.find(
    (learning) => learning.subject_key?.toLowerCase() === exerciseName.toLowerCase()
  );
  const globalLearning = response.learnings.find((learning) => learning.subject_key == null);
  const key = matchingLearning?.key ?? globalLearning?.key ?? null;
  if (!key) return null;
  return (
    response.modifiers.find((modifier) => modifier.target === "training_progression_step" && modifier.key === key) ??
    null
  );
}

// Clamp a desired LOADED step to the safe cap, rounded to a sane plate. Only
// for positive loaded weight; assist/bodyweight handled separately.
function clampedOverload(current: number, group: string | null, modifier?: CoachPersonalModifier | null): number {
  const ceil = stepCeiling(group);
  const step = Math.min(Math.abs(current) * STEP_FRAC, ceil);
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
  }
  // Round to 5 lb for compounds, 2.5 for isolation, but never below the smaller
  // plate (so a light isolation lift still moves).
  const next = current + step;
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
        added = addExerciseToPlanDay(
          hostDay,
          t,
          `Added as a fresh variation for ${f} — start light, log your actual working weight.`,
        );
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
} | null {
  const ex = findExercise(name);
  if (!ex) return null;
  // Most recent session that logged this lift; within it, the top set by est-1RM
  // (reps) or by duration (timed). RIR comes off that top set when present.
  const latestDate = (
    db
      .prepare(
        `SELECT MAX(s.date) AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND (ls.reps IS NOT NULL OR ls.duration_sec IS NOT NULL)`
      )
      .get(ex.id) as any
  )?.d;
  if (!latestDate) return null;
  const sets = db
    .prepare(
      `SELECT ls.weight AS weight, ls.reps AS reps, ls.rir AS rir, ls.duration_sec AS duration_sec
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND s.date = ?`
    )
    .all(ex.id, latestDate) as any[];
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
    date: latestDate,
  };
}

// The latest session's WORKING sets for a reps lift — the sets at that session's
// hardest (top) weight, so warmups/backoffs don't dilute the double-progression read.
// Bodyweight (null weight) sets are all "working". Empty when nothing's logged. This is
// how the engine tells "every set capped the range" from "only the top set did".
function latestWorkingSets(name: string): { weight: number | null; reps: number | null; rir: number | null }[] {
  const ex = findExercise(name);
  if (!ex) return [];
  const latestDate = (
    db
      .prepare(
        `SELECT MAX(s.date) AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND ls.reps IS NOT NULL`
      )
      .get(ex.id) as any
  )?.d;
  if (!latestDate) return [];
  const rows = db
    .prepare(
      `SELECT ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND s.date = ? AND ls.reps IS NOT NULL`
    )
    .all(ex.id, latestDate) as any[];
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

// Same-pattern variation MENU for a lift, ranked toward the athlete's available
// equipment + heavier COMPOUND loading (the owner's explicit goal), never
// re-suggesting a movement/slot already in the week. Pure over suggestAlternatives.
function rankedVaryOptions(name: string, ctx?: PrescCtx): { name: string; why: string }[] {
  const equip = ctx?.availableEquipment ?? [];
  const exclude = ctx?.excludeNames ?? [];
  return (
    suggestAlternatives(name, {
      limit: 20,
      preferCompound: true,
      availableEquipment: equip.length ? equip : undefined,
      excludeNames: exclude.length ? exclude : undefined,
    }) as { name: string; why: string }[]
  )
    .filter((candidate) => {
      const candidateKey = normalizedExerciseKey(candidate.name);
      const candidateMove = movementKey(candidate.name);
      const candidatePress = pressSlotKey(candidate.name);
      return !exclude.some((planned) =>
        normalizedExerciseKey(planned) === candidateKey ||
        movementKey(planned) === candidateMove ||
        (candidatePress != null && pressSlotKey(planned) === candidatePress)
      );
    })
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
  recentLoad?: Map<MuscleGroup, RecentLoad> | null; // acute per-group load (a just-smoked group)
  availableEquipment?: Equipment[] | null; // rank variation candidates by what the athlete can load
  excludeNames?: string[] | null; // movements already in the week — don't re-suggest their exercise/slot
  personalModifier?: CoachPersonalModifier | null; // learned step size; never overrides constraints/recovery
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
  const recentLoad = opts && "recentLoad" in opts ? (opts.recentLoad ?? null) : recentMuscleLoad(2);
  const equip = opts && "availableEquipment" in opts ? (opts.availableEquipment ?? []) : availableEquipment();
  const excludeNames = (opts?.excludeNames ?? []).filter(Boolean);
  const personalModifier =
    opts && "personalModifier" in opts ? (opts.personalModifier ?? null) : trainingModifierFor(exerciseName);
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
    recentLoad,
    tenureWeeks,
    availableEquipment: equip,
    excludeNames,
    personalModifier,
  };
  if (mode === "timed")
    return timedPrescription(exerciseName, group, loadConstrained, plan, cur, last, state, brakeCtx);
  return repsPrescription(exerciseName, group, loadConstrained, plan, cur, last, state, brakeCtx);
}

interface PrescCtx {
  canonGroup: MuscleGroup | null;
  autoreg: AutoregSignals | null;
  recentLoad: Map<MuscleGroup, RecentLoad> | null;
  tenureWeeks: number | null;
  availableEquipment: Equipment[];
  excludeNames: string[];
  personalModifier: CoachPersonalModifier | null;
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
  const planBehind = planWeight != null && recentWorking != null && recentWorking > planWeight + 0.1;

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
  // Equipment-ranked, compound-biased, plan-deduped same-pattern candidates —
  // computed ONCE and reused by the vary + introduce branches (and the introduce guard).
  const varyCandidates = rankedVaryOptions(name, brakeCtx);

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
  const topReps = last?.reps != null ? Number(last.reps) : null;
  const setsAtTop = hasRange
    ? workingSets.filter((s) => s.reps != null && (s.reps as number) >= (repHigh as number)).length
    : 0;
  const allSetsAtTop = hasRange && workingSets.length > 0 && setsAtTop === workingSets.length;
  const roomInRange = hasRange && topReps != null && topReps < (repHigh as number);
  // "Strong" = the work earned progression: last top set at RIR ≥ 2, OR the program-state
  // trend reads progressing. RIR ≤ 1 means it was a grind — hold.
  const strong = (lastRir != null && lastRir >= 2) || status === "progressing";
  // The LOAD step is earned only when EVERY working set capped the range (double
  // progression). With no rep range, fall back to a strong top set (RIR 2+ / progressing).
  const earned = hasRange ? allSetsAtTop && strong : strong;

  if (loadConstrained) {
    action = "hold";
    nextWeight = baseWeight;
    why =
      "This lift has a load-limiting note — hold the weight where you're working and earn clean reps and range first.";
  } else if (status === "regressing") {
    action = "deload";
    nextWeight = baseWeight != null && baseWeight > 0 ? round5(baseWeight * (1 - DELOAD_FRAC)) : baseWeight;
    why = "Strength has been slipping — back the load off about 10% and let it rebuild on a clean run.";
  } else if (status === "plateaued") {
    // Grinding (RIR ≤ 1) → deload; flat ≥ ~3 wk → vary; else hold/technique.
    const grinding = lastRir != null && lastRir <= 1;
    const flatLong = (state?.weeks_static ?? 0) >= 3;
    if (grinding) {
      action = "deload";
      nextWeight = baseWeight != null && baseWeight > 0 ? round5(baseWeight * (1 - DELOAD_FRAC)) : baseWeight;
      why = "Stuck and grinding (RIR 0–1 with the load flat) — a light deload, then a fresh run, usually breaks it.";
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
        ? `Flat about ${state?.weeks_static} weeks — rotate to ${varyTo} (same movement pattern) to unstick it; keep the rest of the day.`
        : `Flat about ${state?.weeks_static} weeks — rotating to a close variation (same pattern) tends to unstick it.`;
    } else {
      action = "hold";
      nextWeight = baseWeight;
      why = "Flat lately — hold the load and chase a clean extra rep before adding weight.";
    }
  } else if (!last && plan) {
    action = "hold";
    nextWeight = baseWeight;
    why = "Nothing logged yet — start where the plan sits and log your actual sets.";
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
    why = `You've run ${name} steady for ~${brakeCtx?.tenureWeeks} weeks — introduce ${varyTo} (same pattern, room to load heavier) to freshen the stimulus before it goes stale.`;
  } else if (hasRange && strong && roomInRange && !allSetsAtTop) {
    // DOUBLE PROGRESSION — the REP stage. The work was strong but not every set has
    // capped the range yet: advance reps within the range, hold the load. This is NO
    // plan change (the plan already prescribes the range) — the athlete just earns reps.
    action = "overload";
    repStep = true;
    nextWeight = baseWeight;
    why = `Reps are climbing at RIR 2+ but not every set has hit ${repHigh} yet — chase a rep toward the top of the range across all your sets before any load. Cap every set, then the weight goes up.`;
  } else if (earned) {
    // DOUBLE PROGRESSION — the LOAD stage. Every working set capped the range at RIR 2+
    // (or no range + a strong top set) → the small earned step up, then reset to the bottom.
    action = "overload";
    if (baseWeight == null) {
      // Bodyweight reps lift — no load to add; progression is reps/sets.
      nextWeight = null;
      why = "You've capped the range on a bodyweight movement — add a rep or a set; there's no load to add.";
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
          ? "You're nearly off the assist — try the next session at bodyweight."
          : "You capped the range — peel a little assist off; you're getting stronger.";
    } else {
      nextWeight = clampedOverload(baseWeight, group, brakeCtx?.personalModifier);
      why = hasRange
        ? `Every set hit ${repHigh} at RIR 2+ — take the earned step up, then reset to ${repLow} reps and build the range back up.`
        : "You hit the top of the range at RIR 2+ — the small earned step up is yours.";
    }
  } else {
    action = "hold";
    nextWeight = baseWeight;
    if (!last) why = "Hold here for now — a couple of logged sessions and the next step reads clearly.";
    else if (hasRange && topReps != null && topReps >= (repHigh as number) && !allSetsAtTop)
      why = `Your top set hit ${repHigh} but not every set did — hold the load and level all your sets at the top before adding.`;
    else why = "Not quite earned yet — hold and finish the rep range cleanly at RIR 2+ before adding.";
  }

  // Catch-up framing: when the plan target was BEHIND the real working weight, say so
  // plainly — the step is "from where you actually are", and even a hold re-grounds the
  // plan onto reality (the suggested weight = baseWeight, so applying lands it there).
  if (planBehind && baseWeight != null) {
    const lbl = baseWeight < 0 ? `${Math.abs(baseWeight)} lb assist` : `${baseWeight} lb`;
    if (action === "overload" && !repStep)
      why = `Your plan was behind what you're actually lifting — stepping up from your real working weight (${lbl}).`;
    else if (action === "hold" && !loadConstrained)
      why = `Your plan was behind what you're lifting — re-grounding it to your real working weight (${lbl}); earn a clean extra rep before adding.`;
  }

  // AUTOREGULATION GATE — one step toward safety on high soreness / low performance /
  // a just-smoked group / a named sore joint. Recovery INFORMS, never overrides
  // progressive overload by more than a step. Applied last so it wins over the earned
  // step (an earned overload the morning after a sore knee becomes a hold/deload).
  let autoregulated = false;
  const brake = brakeCtx
    ? autoregBrake(action, brakeCtx.canonGroup, !!last, brakeCtx.autoreg, brakeCtx.recentLoad)
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
    vary_to: varyTo,
    vary_options: varyOptions,
    autoregulated: autoregulated || undefined,
    rep_step: repStep || undefined,
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

  if (loadConstrained) {
    action = "hold";
    nextSeconds = baseSeconds;
    why = "This hold has a load-limiting note — keep it where it is, don't extend.";
  } else if (status === "regressing") {
    action = "deload";
    nextSeconds = baseSeconds != null ? Math.max(10, Math.round(baseSeconds * (1 - DELOAD_FRAC))) : baseSeconds;
    why = "Holds have been getting shorter — reset to a duration you own and rebuild.";
  } else if (!last && plan) {
    action = "hold";
    nextSeconds = baseSeconds;
    why = "Nothing logged yet — start at the planned hold and log your actual time.";
  } else if (solid || status === "progressing") {
    action = "overload";
    const base = baseSeconds ?? held ?? 0;
    const step = timedStep(base, brakeCtx?.personalModifier);
    nextSeconds = base + step;
    why = `The hold's solid — add ${step}s (a proportional step for a ${base}s hold). Progress timed work in time, never load.`;
  } else {
    action = "hold";
    nextSeconds = baseSeconds ?? held;
    why = "Hold this duration until it feels easy, then extend it.";
  }

  // AUTOREGULATION GATE (timed): a sore joint this hold loads, high soreness, or a
  // just-smoked group holds/eases the duration rather than extending. Timed work
  // eases in SECONDS, never load. Applied last so it wins over the earned extension.
  let autoregulated = false;
  const brake = brakeCtx
    ? autoregBrake(action, brakeCtx.canonGroup, !!last, brakeCtx.autoreg, brakeCtx.recentLoad)
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
    action,
    suggested,
    current: cur,
    delta_text,
    why,
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
  const recentLoad = opts.forNextSession ? null : recentMuscleLoad(2);
  const equip = availableEquipment();
  const plannedMovements = getPlan().flatMap((planDay: any) =>
    (Array.isArray(planDay?.items) ? planDay.items : [])
      .filter((item: any) => item.kind !== "cardio" && item.exercise)
      .map((item: any) => String(item.exercise))
  );
  const personalResponse = whatWorksForYou();
  const out: Prescription[] = [];
  for (const it of items) {
    if (it.kind === "cardio" || !it.name) continue; // skip cardio + label-only rows
    const excludeNames = plannedMovements.filter((n) => n.toLowerCase() !== String(it.name).toLowerCase());
    const personalModifier = trainingModifierFor(String(it.name), personalResponse);
    const p = nextPrescription(it.name, states, {
      autoreg,
      recentLoad,
      availableEquipment: equip,
      excludeNames,
      personalModifier,
    });
    if (p) out.push({ ...p, plan_item_id: it.plan_item_id, day_number: dayNumber });
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
  const changes: Record<string, any>[] = [];
  for (const p of prescriptions) {
    if (p.action === "hold") continue; // a hold is no change
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

// Working-set volume per CANONICAL group over the window (default 2 wk), banded
// against MUSCLE_LANDMARKS. Mobility is EXCLUDED from set-count math (it never
// inflates the working-set picture). `due` = a group under its low landmark OR
// not trained in 7 days; `over` = above its high landmark. Plain words only.
export function programBalance(weeks = 2, date = localDateISO()): ProgramBalance {
  const today = String(date || localDateISO()).slice(0, 10);
  const since = addDaysISO(today, -(weeks * 7 - 1)) ?? today;

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
    const status: GroupBalance["status"] = band === "low" || stale ? "due" : band === "high" ? "high" : "ok";
    groups.push({ group, sets: weeklySets, band, last_trained: v.last_date, status });
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
      groups.push({
        group,
        sets: 0,
        band: "low",
        last_trained: lastByGroup.get(group) ?? null,
        status: "due",
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
  const parts: string[] = [];
  if (over.length) parts.push(`${over.join(", ")} running high`);
  if (due.length) parts.push(`${due.join(", ")} due`);
  if (!parts.length) return "Volume looks well balanced across the groups you're training.";
  return `${parts.join("; ")}.`;
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
  recentArg?: Map<MuscleGroup, RecentLoad>,
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
  const recent = recentArg ?? recentMuscleLoad(2);
  // Plan-aware reframe: a due group that's ALREADY programmed doesn't need a NEW
  // movement — the gap is logged volume (you scheduled it; train it). So we never
  // tell you to "add a back movement" when your plan already has rows, lat pulldowns
  // and pull-ups. ONE plan query feeds both the per-group moves and the GAPS below.
  const plannedMoves = plannedMovesByGroup();
  const planned = new Set(plannedMoves.keys());
  const recovering: Array<{ group: string; rl: RecentLoad }> = [];
  for (const g of bal.due.slice(0, 4)) {
    const gb = bal.groups.find((x) => x.group === g);
    const reason = gb && gb.band === "low" ? "under its productive volume range lately" : "not trained in over a week";
    const rl = recent.get(g as MuscleGroup);
    if (rl?.heavy) {
      recovering.push({ group: g, rl });
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
    const lead = (recovering.find((r) => r.rl.activity) ?? recovering[0]).rl;
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
