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
import { canonicalGroup, classifyConstraint, classifyMuscleGroup, isMobility, type MuscleGroup, MUSCLE_LANDMARKS } from "./exercise-canon.js";
import { type Equipment, effectiveVolumeByGroup, examplesForGroup, parseEquipment, suggestAlternatives, type VolumeSet } from "./exercise-variations.js";
import { findExercise, recentWorkingWeight } from "./exercises.js";
import { getPlan } from "./plan.js";
// createProposal + the auto-progression dedup live in profile.js; imported here (as
// run-progression.ts does for buildRunPlanProposal) so REST + MCP share ONE proposal
// builder instead of duplicating the change-shaping logic (and drifting).
import { createProposal, getProfile, supersedeAutoProgressionDrafts } from "./profile.js";
import { type LiftState, getProgramState } from "./program-state.js";
import { addDaysISO, daysBetweenISO, localDateISO, round2_5 } from "./shared.js";
// Run-plan / DEXA / test-week digest producers. Imported for their types + a lazy
// compute when programAdjustments is called standalone (Today/Progress). The module
// cycle (progression → run-progression → coach → progression) is resolved at call
// time — these are only invoked inside programAdjustments, never at module init.
import { weeklyRunPlan, type WeeklyRunPlan } from "./run-progression.js";
import { dexaTargeting, type DexaTargeting } from "./dexa-targeting.js";
import { testWeekDue, type TestWeekDue } from "./muscle-trajectory.js";

// ---- progression-step caps (mirrors applyProposal's clamp intent, tighter) ---
// A per-session step is a SMALL earned nudge, never a jump. The cap is the
// SMALLER of a fraction of the current load OR a flat ceiling — compounds get a
// 5 lb ceiling, isolation work 2.5 lb (a sane minimum plate jump), and the
// fraction (10%) keeps very light loads from ever leaping. Clamping happens
// here so a prescription is always safe BEFORE it ever reaches propose→apply.
const STEP_FRAC = 0.1;            // ≤10% of the current load…
const STEP_CEIL_COMPOUND = 5;     // …or ≤5 lb on a compound, whichever is smaller
const STEP_CEIL_ISOLATION = 2.5;  // …or ≤2.5 lb on an isolation lift
// Timed holds progress by a RELATIVE step — a fraction of the current hold, clamped to
// a sane floor/ceiling — so a 20s plank and a 120s dead hang each progress proportionally
// (a flat +N is trivial on a long hold and a huge jump on a short one). Timed work moves
// in SECONDS, never load.
const SECONDS_STEP_FRAC = 0.1;    // ~10% of the current hold…
const SECONDS_STEP_MIN = 3;       // …never smaller than 3s (a real nudge on a short hold)
const SECONDS_STEP_MAX = 20;      // …never larger than 20s in one step (a long hold doesn't leap)
const DELOAD_FRAC = 0.1;          // a deload backs the load off ~10%
// A movement run this long (steady, not stalled) is ripe for PROACTIVE variety —
// introduce a fresh variation before staleness sets in, at a block boundary, rather
// than waiting for a measured plateau. Tenure = weeks since the lift was first logged.
const INTRODUCE_TENURE_WEEKS = 12;

// Isolation groups get the smaller (2.5 lb) plate jump; compounds get 5 lb.
const ISOLATION_GROUPS = new Set([
  "biceps",
  "triceps",
  "rear delts",
  "calves",
  "forearms",
]);

export type ProgressionAction = "overload" | "hold" | "deload" | "vary" | "introduce";

export interface PrescriptionTarget {
  sets: number;
  rep_low?: number;
  rep_high?: number;
  weight?: number | null;   // null = bodyweight; negative = assist
  seconds?: number;
}

export interface Prescription {
  exercise: string;
  mode: "reps" | "timed";
  action: ProgressionAction;
  suggested: PrescriptionTarget;
  current: PrescriptionTarget | null;  // from the plan item, when planned
  delta_text: string;                  // plain words: "+5 lb", "hold 50", "−10%", "+5s"
  why: string;
  reground?: boolean;                  // the plan target was behind logged reality — applying re-grounds it
  vary_to?: string;                    // a concrete same-pattern variation to rotate in (action "vary")
  vary_options?: { name: string; why: string }[]; // a MENU of same-pattern swaps (action "vary"); vary_to is the lead
  plan_item_id?: number;               // set by planDayProgression for the apply path
  day_number?: number;                 // set by planDayProgression — the day the lift sits on (for the swap apply path)
  autoregulated?: boolean;             // recovery signals braked this step (overload→hold / hold→deload) — informational
  rep_step?: boolean;                  // double-progression REP advance (load held, reps climb in-range) — no plan change
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
  soreness: number | null;    // most recent 1-5
  performance: number | null; // most recent 1-5
  joint_pain: string | null;  // most recent free-text ("left knee")
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
    const rows = db.prepare(
      `SELECT date, soreness, performance, joint_pain FROM sessions
        WHERE date >= ? AND date <= ? ORDER BY date DESC`
    ).all(since, today) as any[];
    for (const r of rows) {
      if (out.soreness == null && r.soreness != null) out.soreness = Number(r.soreness);
      if (out.performance == null && r.performance != null) out.performance = Number(r.performance);
      if (out.joint_pain == null && r.joint_pain != null && String(r.joint_pain).trim()) out.joint_pain = String(r.joint_pain).trim();
      if (out.date == null && (r.soreness != null || r.performance != null || (r.joint_pain && String(r.joint_pain).trim()))) out.date = String(r.date);
    }
  } catch { /* sessions columns absent → no signal */ }
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

function jointLoadsGroup(jointText: string, group: MuscleGroup | null): boolean {
  if (!group) return false;
  const s = String(jointText || "").toLowerCase();
  if (!s) return false;
  for (const m of JOINT_GROUP_MAP) if (m.re.test(s) && m.groups.includes(group)) return true;
  return false;
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
  recentLoad: Map<MuscleGroup, RecentLoad> | null,
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
      return { action: "hold", why: `Your last check-in flagged a sore joint this lift loads — holding the load today rather than adding; earn a clean, pain-free session first.` };
    }
    if (action === "hold" && hasHistory) {
      return { action: "deload", why: `A sore joint this lift loads is still flagged — easing the load a touch so it can settle before you build again.` };
    }
    return null;
  }
  // High soreness / low performance / a just-smoked group → don't add load today.
  if (highStrain && action === "overload") {
    const reason = heavyAcute
      ? "this muscle got a heavy dose recently"
      : soreHigh ? "recent soreness is running high" : "recent sessions felt flat";
    return { action: "hold", why: `Holding the load today — ${reason}, so this isn't the session to push. Recovery informs the plan; it's a brake, not a penalty.` };
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
  const first = (db.prepare(
    `SELECT MIN(s.date) AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id WHERE ls.exercise_id = ?`
  ).get(ex.id) as any)?.d;
  if (!first) return null;
  const days = daysBetweenISO(String(date || localDateISO()).slice(0, 10), String(first).slice(0, 10));
  if (days == null || days < 0) return 0;
  return Math.round(days / 7);
}

// The athlete's available equipment, parsed from the persisted profile.equipment
// free-text field. Empty → no constraint (rank neutrally).
export function availableEquipment(): Equipment[] {
  try { return parseEquipment((getProfile() as any)?.equipment ?? null); } catch { return []; }
}

// Read/write the persisted equipment/preference profile (profile.equipment free
// text). Kept here (a direct column write) rather than in setProfile so the big
// profile upsert stays untouched — setProfile never lists equipment, so it never
// clobbers it. Returns the stored text + the parsed Equipment types.
export function getEquipmentProfile(): { equipment: string | null; parsed: Equipment[] } {
  const eq = (() => { try { return (getProfile() as any)?.equipment ?? null; } catch { return null; } })();
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
function timedStep(seconds: number): number {
  const raw = Math.round(Math.abs(seconds) * SECONDS_STEP_FRAC);
  return Math.min(SECONDS_STEP_MAX, Math.max(SECONDS_STEP_MIN, raw));
}

// The step ceiling for a lift, by group (compound vs isolation).
function stepCeiling(group: string | null): number {
  const g = canonicalGroup(group);
  return g && ISOLATION_GROUPS.has(g) ? STEP_CEIL_ISOLATION : STEP_CEIL_COMPOUND;
}

// Clamp a desired LOADED step to the safe cap, rounded to a sane plate. Only
// for positive loaded weight; assist/bodyweight handled separately.
function clampedOverload(current: number, group: string | null): number {
  const ceil = stepCeiling(group);
  const step = Math.min(Math.abs(current) * STEP_FRAC, ceil);
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
function latestTopSet(name: string): { weight: number | null; reps: number | null; rir: number | null; duration_sec: number | null; date: string } | null {
  const ex = findExercise(name);
  if (!ex) return null;
  // Most recent session that logged this lift; within it, the top set by est-1RM
  // (reps) or by duration (timed). RIR comes off that top set when present.
  const latestDate = (db.prepare(
    `SELECT MAX(s.date) AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND (ls.reps IS NOT NULL OR ls.duration_sec IS NOT NULL)`
  ).get(ex.id) as any)?.d;
  if (!latestDate) return null;
  const sets = db.prepare(
    `SELECT ls.weight AS weight, ls.reps AS reps, ls.rir AS rir, ls.duration_sec AS duration_sec
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND s.date = ?`
  ).all(ex.id, latestDate) as any[];
  if (!sets.length) return null;
  // Top set: max (weight×(1+reps/30)) for reps; max duration for timed.
  let top = sets[0];
  let bestScore = -Infinity;
  for (const s of sets) {
    const score = s.duration_sec != null
      ? Number(s.duration_sec)
      : (Number(s.weight) || 0) * (1 + (Number(s.reps) || 0) / 30);
    if (score > bestScore) { bestScore = score; top = s; }
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
  const latestDate = (db.prepare(
    `SELECT MAX(s.date) AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND ls.reps IS NOT NULL`
  ).get(ex.id) as any)?.d;
  if (!latestDate) return [];
  const rows = db.prepare(
    `SELECT ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND s.date = ? AND ls.reps IS NOT NULL`
  ).all(ex.id, latestDate) as any[];
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
// re-suggesting a movement already on the day. Pure over suggestAlternatives.
function rankedVaryOptions(name: string, ctx?: PrescCtx): { name: string; why: string }[] {
  const equip = ctx?.availableEquipment ?? [];
  const exclude = ctx?.excludeNames ?? [];
  return (suggestAlternatives(name, {
    limit: 3,
    preferCompound: true,
    availableEquipment: equip.length ? equip : undefined,
    excludeNames: exclude.length ? exclude : undefined,
  }) as { name: string; why: string }[]).map((v) => ({ name: v.name, why: v.why }));
}

// ---- the per-lift prescription ----------------------------------------------
// nextPrescription reads the latest logged top set + RIR + the lift's
// program-state status/trend, and proposes the NEXT session's target. Returns
// null when there's no history AND no plan item to read (nothing to say). Pass a
// pre-built `states` map when iterating many lifts (avoids recomputing the whole
// program-state per lift).
export interface PrescriptionOpts {
  autoreg?: AutoregSignals | null;               // latest 1-tap session feedback (soreness/perf/joint)
  recentLoad?: Map<MuscleGroup, RecentLoad> | null; // acute per-group load (a just-smoked group)
  availableEquipment?: Equipment[] | null;       // rank variation candidates by what the athlete can load
  excludeNames?: string[] | null;                // movements already on the day — don't re-suggest them
}

export function nextPrescription(exerciseName: string, states?: Map<string, LiftState>, opts?: PrescriptionOpts): Prescription | null {
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

  const brakeCtx: PrescCtx = { canonGroup, autoreg, recentLoad, tenureWeeks, availableEquipment: equip, excludeNames };
  if (mode === "timed") return timedPrescription(exerciseName, group, loadConstrained, plan, cur, last, state, brakeCtx);
  return repsPrescription(exerciseName, group, loadConstrained, plan, cur, last, state, brakeCtx);
}

interface PrescCtx {
  canonGroup: MuscleGroup | null;
  autoreg: AutoregSignals | null;
  recentLoad: Map<MuscleGroup, RecentLoad> | null;
  tenureWeeks: number | null;
  availableEquipment: Equipment[];
  excludeNames: string[];
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
  else baseWeight = planWeight != null ? planWeight : (recentWorking != null ? recentWorking : (last?.weight != null ? Number(last.weight) : null));
  // The plan target is BEHIND what they're actually lifting → the prescription also
  // RE-GROUNDS the plan: the displayed "current" reflects reality, and applying lands
  // the plan target on what they truly handle ("gradually adjust the plan from logs").
  const planBehind = planWeight != null && recentWorking != null && recentWorking > planWeight + 0.1;

  const repLow = plan?.rep_low ?? (cur?.rep_low ?? undefined);
  const repHigh = plan?.rep_high ?? (cur?.rep_high ?? undefined);
  const sets = plan?.sets || 3;

  // The decision. Order matters: an injury constraint HOLDS load before anything
  // else; then read the program-state status (progressing / plateaued / …).
  let action: ProgressionAction;
  let why: string;
  let nextWeight: number | null = baseWeight;
  let varyTo: string | undefined;
  let varyOptions: { name: string; why: string }[] | undefined;
  let repStep = false;  // a DOUBLE-PROGRESSION rep advance (load held, reps climb in-range)
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
  const setsAtTop = hasRange ? workingSets.filter((s) => s.reps != null && (s.reps as number) >= (repHigh as number)).length : 0;
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
    why = "This lift has a load-limiting note — hold the weight where you're working and earn clean reps and range first.";
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
    (state?.status === "maintaining") &&
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
      const step = Math.min(Math.abs(baseWeight) * STEP_FRAC, ceil);
      const reduced = round5(baseWeight + step); // toward 0
      nextWeight = reduced >= 0 ? null : reduced; // crossed to bodyweight → null
      why = nextWeight == null
        ? "You're nearly off the assist — try the next session at bodyweight."
        : "You capped the range — peel a little assist off; you're getting stronger.";
    } else {
      nextWeight = clampedOverload(baseWeight, group);
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
    if (action === "overload" && !repStep) why = `Your plan was behind what you're actually lifting — stepping up from your real working weight (${lbl}).`;
    else if (action === "hold" && !loadConstrained) why = `Your plan was behind what you're lifting — re-grounding it to your real working weight (${lbl}); earn a clean extra rep before adding.`;
  }

  // AUTOREGULATION GATE — one step toward safety on high soreness / low performance /
  // a just-smoked group / a named sore joint. Recovery INFORMS, never overrides
  // progressive overload by more than a step. Applied last so it wins over the earned
  // step (an earned overload the morning after a sore knee becomes a hold/deload).
  let autoregulated = false;
  const brake = brakeCtx ? autoregBrake(action, brakeCtx.canonGroup, !!last, brakeCtx.autoreg, brakeCtx.recentLoad) : null;
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
    ? (planBehind ? { ...cur, weight: baseWeight } : cur)
    : (baseWeight != null ? { sets, rep_low: repLow ?? undefined, rep_high: repHigh ?? undefined, weight: baseWeight } : null);

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
    plan?.seconds != null ? plan.seconds
    : last?.duration_sec != null ? Math.round(Number(last.duration_sec))
    : null;
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
    const step = timedStep(base);
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
  const brake = brakeCtx ? autoregBrake(action, brakeCtx.canonGroup, !!last, brakeCtx.autoreg, brakeCtx.recentLoad) : null;
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
export function planDayProgression(dayNumber: number): Prescription[] {
  const day = db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(dayNumber) as any;
  if (!day) return [];
  const items = db.prepare(
    `SELECT pi.id AS plan_item_id, pi.kind AS kind, e.name AS name
       FROM plan_items pi LEFT JOIN exercises e ON e.id = pi.exercise_id
      WHERE pi.plan_day_id = ? ORDER BY pi.position`
  ).all(day.id) as any[];
  const states = buildLiftStateMap(); // compute the program-state ONCE for the day
  // Autoregulation + acute-load read computed ONCE for the whole day and threaded in,
  // so the one-tap apply proposal built from these is gated too (no overload the
  // morning after soreness / a named sore joint). Equipment + the day's own movements
  // are threaded in too so a variety suggestion ranks by what the athlete can load and
  // never re-suggests something already on the day.
  const autoreg = recentAutoregulation();
  const recentLoad = recentMuscleLoad(2);
  const equip = availableEquipment();
  const dayMovements = items.filter((it) => it.kind !== "cardio" && it.name).map((it) => String(it.name));
  const out: Prescription[] = [];
  for (const it of items) {
    if (it.kind === "cardio" || !it.name) continue; // skip cardio + label-only rows
    const excludeNames = dayMovements.filter((n) => n.toLowerCase() !== String(it.name).toLowerCase());
    const p = nextPrescription(it.name, states, { autoreg, recentLoad, availableEquipment: equip, excludeNames });
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
export function buildProgressionProposal(day: number): { ok: false; error: string } | { ok: true; proposal: any } {
  if (!Number.isFinite(day)) return { ok: false, error: "day required" };
  const prescriptions = planDayProgression(day);
  const changes: Record<string, any>[] = [];
  for (const p of prescriptions) {
    if (p.action === "hold") continue; // a hold is no change
    if (p.rep_step) continue; // a double-progression rep advance is no plan change — the range already covers it
    // A vary/introduce → a first-class swap (rotate the lift out for the lead option).
    if (p.action === "vary" || p.action === "introduce") {
      const to = p.vary_to ?? p.vary_options?.[0]?.name ?? null;
      if (!to) continue; // no candidate → nothing to swap to (skip, never a no-op)
      changes.push({ day_number: day, swap: { from: p.exercise, to }, reason: p.why || `Rotate a variation in for ${p.exercise}.` });
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
export function buildSwapProposal(day: number, from: string, to: string): { ok: false; error: string } | { ok: true; proposal: any } {
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

// ---- program balance (volume per canonical group) ---------------------------
export interface GroupBalance {
  group: string;
  sets: number;                       // working sets over the window (per week, rounded)
  band: "low" | "productive" | "high";
  last_trained: string | null;       // ISO date of the most recent set in that group
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

  const rows = db.prepare(
    `SELECT e.muscle_group AS muscle_group, e.name AS exercise, s.date AS date,
            ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
       JOIN sessions s ON s.id = ls.session_id
      WHERE s.date >= ? AND s.date <= ?`
  ).all(since, today) as any[];

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
  // Surface groups that were NOT trained at all in the window but have a landmark
  // — they're "due" too (the missing-pattern signal lives in programAdjustments).
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
  if (!groups.length) return "Not enough logged yet to read your volume balance — keep training and it'll come into focus.";
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

// ---- acute recovery: what got hammered in the last day or two ---------------
// programBalance above is a WEEKLY read — a group can be "due" on the week yet
// torched TODAY. The "what changed" digest is read as "what should I do next", so
// it must never put a just-smoked muscle up as the next move. Strength load is in
// logged_sets; ENDURANCE load is NOT (a 3-hour ride is an `activities` row, not a
// logged set), so map the activity TYPE → the prime-mover regions it fatigues.
// This is the connected-brain read that makes the next-day suggestion actually
// elite — legs are toast after a long ride, so it surfaces fresh work instead.
// Conservative on purpose: only PRIME movers per modality, plain words, no score.
// Per-modality thresholds: "ride" is the value normalizeGarminType folds cycling
// onto, so it MUST be in the matcher (the raw "mountain_biking" etc. are matched
// too, for free-text logs). A casual walk folds onto "hike", so hike's heavy bar is
// deliberately high — a stroll never gates leg training; a real long hike does.
const ENDURANCE_REGIONS: Array<{ re: RegExp; label: string; regions: MuscleGroup[]; heavyMin: number; heavyKm: number }> = [
  { re: /\b(ride|cycl|bik|mtb|gravel|spin|peloton)/, label: "ride", regions: ["quads", "hamstrings", "glutes", "calves", "core"], heavyMin: 50, heavyKm: 20 },
  { re: /\b(run|jog|sprint|tempo|interval)/, label: "run", regions: ["quads", "hamstrings", "glutes", "calves", "core"], heavyMin: 35, heavyKm: 6 },
  { re: /\b(hik|walk|ruck|trek|stair|stepper|elliptical)/, label: "hike", regions: ["quads", "glutes", "calves", "hamstrings"], heavyMin: 90, heavyKm: 12 },
  { re: /\b(row|erg|kayak|paddle)/, label: "row", regions: ["back", "hamstrings", "glutes", "core"], heavyMin: 40, heavyKm: 8 },
  { re: /\b(swim)/, label: "swim", regions: ["back", "shoulders", "chest", "core"], heavyMin: 40, heavyKm: 2 },
  { re: /\b(ski|skat|snowboard)/, label: "session", regions: ["quads", "glutes", "calves", "hamstrings"], heavyMin: 60, heavyKm: 10 },
];

const HEAVY_SETS = 4;   // ≥ 4 working sets on a group in a day or two is a real dose

type EnduranceRegion = (typeof ENDURANCE_REGIONS)[number];
function matchEnduranceRegion(text: string): EnduranceRegion | null {
  const norm = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!norm) return null;
  for (const m of ENDURANCE_REGIONS) if (m.re.test(norm)) return m;
  return null;
}

function durPhrase(min: number | null, km: number | null): string {
  if (min != null && min > 0) return min >= 90 ? `~${Math.round(min / 60)} h` : `~${Math.round(min / 5) * 5} min`;
  if (km != null && km > 0) return `~${Math.round(km)} km`;
  return "";
}
function whenWord(daysAgo: number): string {
  return daysAgo <= 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
}

export interface RecentLoad {
  group: MuscleGroup;
  last_date: string;
  days_ago: number;
  heavy: boolean;
  source: "strength" | "endurance" | "both";
  activity: string | null;  // endurance label ("ride" / "run" / …); null when strength-only
  detail: string;           // magnitude phrase ("~3 h", "~12 km", "")
}

// Per-canonical-group ACUTE load over the last `days` (default 2). Folds recent
// STRENGTH sets (per group) AND recent ENDURANCE sessions (mapped to the regions
// they fatigue) into one freshness read. `heavy` = a real dose — enough that the
// muscle wants a day before it's the smart next pick. Best-effort + null-safe.
export function recentMuscleLoad(days = 2, date = localDateISO()): Map<MuscleGroup, RecentLoad> {
  const out = new Map<MuscleGroup, RecentLoad>();
  const today = String(date || localDateISO()).slice(0, 10);
  const since = addDaysISO(today, -(Math.max(1, days) - 1)) ?? today;
  const dAgo = (iso: string): number => {
    return Math.max(0, daysBetweenISO(today, String(iso).slice(0, 10)) ?? 0);
  };
  const bump = (g: MuscleGroup, date: string, heavy: boolean, src: "strength" | "endurance", activity: string | null, detail: string) => {
    const prev = out.get(g);
    if (!prev) {
      out.set(g, { group: g, last_date: date, days_ago: dAgo(date), heavy, source: src, activity, detail });
      return;
    }
    const newer = date > prev.last_date;
    out.set(g, {
      group: g,
      last_date: newer ? date : prev.last_date,
      days_ago: Math.min(prev.days_ago, dAgo(date)),
      heavy: prev.heavy || heavy,
      source: prev.source === src ? src : "both",
      // an endurance session is the more explanatory note ("your 3 h ride") — let it win
      activity: src === "endurance" ? activity : prev.activity,
      detail: src === "endurance" && detail ? detail : prev.detail,
    });
  };

  // Strength: working sets per canonical group in the window.
  try {
    const sets = db.prepare(
      `SELECT e.muscle_group AS mg, e.name AS name, s.date AS date
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
         JOIN sessions s ON s.id = ls.session_id
        WHERE s.date >= ? AND s.date <= ?`
    ).all(since, today) as any[];
    const tally = new Map<MuscleGroup, { sets: number; last: string }>();
    for (const r of sets) {
      const g = canonicalGroup(r.mg) ?? canonicalGroup(r.name);
      if (!g || isMobility(g)) continue;
      const cur = tally.get(g) ?? { sets: 0, last: String(r.date) };
      cur.sets += 1;
      if (String(r.date) > cur.last) cur.last = String(r.date);
      tally.set(g, cur);
    }
    for (const [g, v] of tally) bump(g, v.last, v.sets >= HEAVY_SETS, "strength", null, "");
  } catch { /* logged_sets/exercises absent → skip */ }

  // Endurance: activities mapped to the regions they fatigue. LEFT JOIN the rich
  // Garmin row so a SHORT but hard session (high training effect) still counts as a
  // real dose — using every signal, not just the clock.
  try {
    const acts = db.prepare(
      `SELECT a.date AS date, a.type AS type, a.raw_text AS raw_text, a.notes AS notes,
              a.duration_min AS duration_min, a.distance_km AS distance_km,
              ga.aerobic_te AS ate, ga.anaerobic_te AS anate
         FROM activities a
         LEFT JOIN garmin_activities ga ON ga.activity_id = a.id
        WHERE a.date >= ? AND a.date <= ?`
    ).all(since, today) as any[];
    for (const a of acts) {
      const m = matchEnduranceRegion(`${a.type || ""} ${a.raw_text || ""} ${a.notes || ""}`);
      if (!m) continue;
      const dur = a.duration_min != null ? Number(a.duration_min) : null;
      const km = a.distance_km != null ? Number(a.distance_km) : null;
      const ate = a.ate != null ? Number(a.ate) : null;
      const anate = a.anate != null ? Number(a.anate) : null;
      const heavy =
        (dur != null && dur >= m.heavyMin) ||
        (km != null && km >= m.heavyKm) ||
        (ate != null && ate >= 3) ||
        (anate != null && anate >= 2);
      const detail = durPhrase(dur, km);
      for (const g of m.regions) bump(g, String(a.date), heavy, "endurance", m.label, detail);
    }
  } catch { /* activities absent → skip */ }

  return out;
}

// Plain-words "what loaded it" phrase for a recovering group's reframe.
function loadPhrase(rl: RecentLoad): string {
  const when = whenWord(rl.days_ago);
  if (rl.activity) return `your ${rl.detail ? `${rl.detail} ` : ""}${rl.activity} ${when}`;
  return `the hard ${rl.group} work you did ${when}`;
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
  opts?: { runPlan?: WeeklyRunPlan | null; dexa?: DexaTargeting | null; testWeek?: TestWeekDue | null },
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
      if (p.action === "deload") deloads.push({ kind: "deload", title: `Deload ${p.exercise}`, why: p.why, exercise: p.exercise });
      else if (p.action === "vary") varies.push({ kind: "progression", title: `Rotate a variation for ${p.exercise}`, why: p.why, exercise: p.exercise });
      else if (p.action === "overload") overloads.push({ kind: "progression", title: `${p.exercise} — ${p.delta_text}`, why: p.why, exercise: p.exercise });
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
  } catch { /* program-state unavailable → skip */ }

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
    if (rl?.heavy) { recovering.push({ group: g, rl }); continue; }
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
      push({ kind: "balance", title: `${cap(g)} is due`, why: `${cap(g)} is ${reason} — work it in this week.`, group: g, suggestions: examplesForGroup(g, 3) });
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
    push({ kind: "balance", title: `${cap(g)} is running high`, why: `${cap(g)} volume is above its productive range — there's room to redirect some of it to a due group.`, group: g });
  }

  // 4) Missing-pattern GAPS — the elite-coach floors this athlete is missing.
  //    Read what groups appear ANYWHERE in the plan; flag core / forearms (grip)
  //    / mobility when they're absent (they were invisible until the taxonomy
  //    added them as first-class groups). Reuses `planned` from the balance step.
  // Gap titles are ADDITIVE and calm ("Add a little core"), never a "No X programmed"
  // nag-wall — these are gentle floors worth rounding the program out with, not failures
  // (constitution: calm, never shaming). They sit BELOW the earned wins + due focus above.
  for (const [group, title, why, suggestions] of [
    ["core", "Add a little core", "No anti-extension / anti-rotation core work is programmed — a loaded carry or a plank/pallof variation underpins everything else.", ["Pallof Press", "Farmer's Walk", "Hanging Leg Raise"]],
    ["forearms", "Work in some grip", "No grip work is programmed — dead hangs or loaded carries build grip, protect the elbow, and carry over to every pull.", ["Farmer's Walk", "Suitcase Carry", "Dead Hang"]],
    ["mobility", "A little mobility prep", "No mobility / activation work is programmed — a few minutes of ankle + hip prep protects the joints, especially for a returning runner.", ["Ankle Rocker", "90/90 Hip Switch", "World's Greatest Stretch"]],
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
  } catch { /* run plan unavailable → skip */ }

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
  } catch { /* dexa unavailable → skip */ }

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
  } catch { /* test-week unavailable → skip */ }

  return out.slice(0, 8);
}

// The strength movements programmed in the plan, grouped by canonical muscle group
// (with the day each sits on) — so a due-but-programmed group can say "you have these,
// on these days" instead of suggesting movements you already train. ONE query feeds
// both the per-group moves and the plan's programmed-group set (its keys).
type PlannedMove = { exercise: string; day: number; day_name: string | null };
function plannedMovesByGroup(): Map<string, PlannedMove[]> {
  const rows = db.prepare(
    `SELECT DISTINCT e.name AS name, e.muscle_group AS mg, pd.day_number AS day, pd.name AS day_name
       FROM plan_items pi
       JOIN exercises e ON e.id = pi.exercise_id
       JOIN plan_days pd ON pd.id = pi.plan_day_id
      WHERE (pi.kind IS NULL OR pi.kind != 'cardio')
      ORDER BY pd.day_number, pi.position`
  ).all() as any[];
  const map = new Map<string, PlannedMove[]>();
  for (const r of rows) {
    const g = canonicalGroup(r.mg) ?? canonicalGroup(r.name);
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
  opts: { programState?: any; balance?: ProgramBalance; testWeek?: TestWeekDue } = {},
): ProgramEvolutionTrigger {
  const reasons: string[] = [];
  const sigParts: string[] = [];

  let ps = opts.programState;
  if (ps === undefined) {
    try { ps = getProgramState(date); } catch { ps = { lifts: [] }; }
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
        : `${wantsVary.slice(0, 3).join(", ")} have stalled — time to rotate variations in.`,
    );
    sigParts.push(`vary:${wantsVary.join(",")}`);
  }

  // (3) A cadenced re-test come due — re-measure true capacity before the next
  //     block (an honest checkpoint, never a forced max). Computed before the
  //     weak-point clause so it can also satisfy the "actively training" gate.
  let tw = opts.testWeek;
  if (tw === undefined) {
    try { tw = testWeekDue(date, { programState: ps }); } catch { tw = undefined; }
  }
  const twDue = !!tw?.due;

  // (2) A muscle group running UNDER its productive volume range (or untrained
  //     lately) — a weak point worth building toward. Only fires for an athlete
  //     with real training history (else a blank new plan reads everything "due").
  let bal = opts.balance;
  if (bal === undefined) {
    try { bal = programBalance(2, date); } catch { bal = undefined; }
  }
  const dueGroups = [...(Array.isArray(bal?.due) ? bal!.due : [])].sort();
  if (dueGroups.length && (hasHistory || wantsVary.length || twDue)) {
    reasons.push(
      `${dueGroups.slice(0, 3).join(", ")} ${dueGroups.length === 1 ? "is" : "are"} under-trained — worth building up.`,
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
