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
import { canonicalGroup, isMobility, MUSCLE_LANDMARKS } from "./exercise-canon.js";
import { findExercise } from "./exercises.js";
import { getPlan } from "./plan.js";
import { type LiftState, getProgramState } from "./program-state.js";

// ---- progression-step caps (mirrors applyProposal's clamp intent, tighter) ---
// A per-session step is a SMALL earned nudge, never a jump. The cap is the
// SMALLER of a fraction of the current load OR a flat ceiling — compounds get a
// 5 lb ceiling, isolation work 2.5 lb (a sane minimum plate jump), and the
// fraction (10%) keeps very light loads from ever leaping. Clamping happens
// here so a prescription is always safe BEFORE it ever reaches propose→apply.
const STEP_FRAC = 0.1;            // ≤10% of the current load…
const STEP_CEIL_COMPOUND = 5;     // …or ≤5 lb on a compound, whichever is smaller
const STEP_CEIL_ISOLATION = 2.5;  // …or ≤2.5 lb on an isolation lift
const SECONDS_STEP = 5;           // timed holds progress +5s when solid
const DELOAD_FRAC = 0.1;          // a deload backs the load off ~10%

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
  plan_item_id?: number;               // set by planDayProgression for the apply path
}

// ---- small helpers ----
function round5(n: number): number {
  return Math.round(n / 5) * 5;
}
function round2_5(n: number): number {
  return Math.round(n / 2.5) * 2.5;
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

// ---- the per-lift prescription ----------------------------------------------
// nextPrescription reads the latest logged top set + RIR + the lift's
// program-state status/trend, and proposes the NEXT session's target. Returns
// null when there's no history AND no plan item to read (nothing to say). Pass a
// pre-built `states` map when iterating many lifts (avoids recomputing the whole
// program-state per lift).
export function nextPrescription(exerciseName: string, states?: Map<string, LiftState>): Prescription | null {
  const ex = findExercise(exerciseName);
  const mode: "reps" | "timed" = ex?.mode === "timed" ? "timed" : "reps";
  const group: string | null = ex?.muscle_group ?? null;
  const constrained = !!(ex?.constraint_note && String(ex.constraint_note).trim());
  const plan = planItemFor(exerciseName);
  // Cardio plan items aren't progressed here (the runner loop owns those).
  if (plan && plan.kind === "cardio") return null;
  const cur = currentTarget(plan, mode);
  const last = latestTopSet(exerciseName);
  const state = liftStateFor(exerciseName, states);

  // Nothing logged and nothing planned → genuinely nothing to read.
  if (!last && !plan) return null;

  if (mode === "timed") return timedPrescription(exerciseName, group, constrained, plan, cur, last, state);
  return repsPrescription(exerciseName, group, constrained, plan, cur, last, state);
}

function repsPrescription(
  name: string,
  group: string | null,
  constrained: boolean,
  plan: ReturnType<typeof planItemFor>,
  cur: PrescriptionTarget | null,
  last: ReturnType<typeof latestTopSet>,
  state: LiftState | null
): Prescription {
  // The load to progress FROM: the plan's prescribed target if set, else the
  // last logged top-set weight (so an off-plan lift still gets a sane read).
  const baseWeight: number | null =
    plan?.weight != null ? plan.weight
    : last?.weight != null ? Number(last.weight)
    : null;

  const repLow = plan?.rep_low ?? (cur?.rep_low ?? undefined);
  const repHigh = plan?.rep_high ?? (cur?.rep_high ?? undefined);
  const sets = plan?.sets || 3;

  // The decision. Order matters: an injury constraint HOLDS load before anything
  // else; then read the program-state status (progressing / plateaued / …).
  let action: ProgressionAction;
  let why: string;
  let nextWeight: number | null = baseWeight;

  const status = state?.status ?? (last ? "new" : "new");
  const lastRir = last?.rir ?? null;
  const hitTop = repHigh != null && last?.reps != null && Number(last.reps) >= repHigh;
  // "Earned" overload = recent top set comfortably in range at RIR ≥ 2, OR the
  // program-state trend reads progressing. RIR ≤ 1 means it was a grind — hold.
  const earned = (lastRir != null && lastRir >= 2 && (hitTop || repHigh == null)) || status === "progressing";

  if (constrained) {
    action = "hold";
    nextWeight = baseWeight;
    why = "This lift has an injury note — hold the load, don't add. Earn range and clean reps first.";
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
      why = `Flat about ${state?.weeks_static} weeks — rotating to a close variation (same pattern) tends to unstick it.`;
    } else {
      action = "hold";
      nextWeight = baseWeight;
      why = "Flat lately — hold the load and chase a clean extra rep before adding weight.";
    }
  } else if (!last && plan) {
    action = "hold";
    nextWeight = baseWeight;
    why = "Nothing logged yet — start where the plan sits and log your actual sets.";
  } else if (earned) {
    action = "overload";
    if (baseWeight == null) {
      // Bodyweight reps lift with room — progression is reps, not load.
      nextWeight = null;
      why = "Reps are there at low RIR — add a rep (or a set) before any load; it's a bodyweight movement.";
    } else if (baseWeight < 0) {
      // Assisted — reduce the assist toward bodyweight (a smaller absolute value).
      const ceil = stepCeiling(group);
      const step = Math.min(Math.abs(baseWeight) * STEP_FRAC, ceil);
      const reduced = round5(baseWeight + step); // toward 0
      nextWeight = reduced >= 0 ? null : reduced; // crossed to bodyweight → null
      why = nextWeight == null
        ? "You're nearly off the assist — try the next session at bodyweight."
        : "Reps are there at low RIR — peel a little assist off; you're getting stronger.";
    } else {
      nextWeight = clampedOverload(baseWeight, group);
      why = "You hit the top of the range at RIR 2+ — the small earned step up is yours.";
    }
  } else {
    action = "hold";
    nextWeight = baseWeight;
    why = last
      ? "Not quite earned yet — hold and finish the rep range cleanly at RIR 2+ before adding."
      : "Hold here for now — a couple of logged sessions and the next step reads clearly.";
  }

  const suggested: PrescriptionTarget = {
    sets,
    rep_low: repLow ?? undefined,
    rep_high: repHigh ?? undefined,
    weight: nextWeight,
  };
  const delta_text = loadedDeltaText(baseWeight, nextWeight);

  return {
    exercise: ex_name(name),
    mode: "reps",
    action,
    suggested,
    current: cur,
    delta_text,
    why,
  };
}

function timedPrescription(
  name: string,
  _group: string | null,
  constrained: boolean,
  plan: ReturnType<typeof planItemFor>,
  cur: PrescriptionTarget | null,
  last: ReturnType<typeof latestTopSet>,
  state: LiftState | null
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

  if (constrained) {
    action = "hold";
    nextSeconds = baseSeconds;
    why = "This hold has an injury note — keep it where it is, don't extend.";
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
    nextSeconds = (baseSeconds ?? held ?? 0) + SECONDS_STEP;
    why = "The hold's solid — add a few seconds. Progress timed work in time, never load.";
  } else {
    action = "hold";
    nextSeconds = baseSeconds ?? held;
    why = "Hold this duration until it feels easy, then extend it.";
  }

  const suggested: PrescriptionTarget = { sets, seconds: nextSeconds ?? undefined };
  const delta_text = secondsDeltaText(baseSeconds, nextSeconds);

  return {
    exercise: ex_name(name),
    mode: "timed",
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
  const out: Prescription[] = [];
  for (const it of items) {
    if (it.kind === "cardio" || !it.name) continue; // skip cardio + label-only rows
    const p = nextPrescription(it.name, states);
    if (p) out.push({ ...p, plan_item_id: it.plan_item_id });
  }
  return out;
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
}

// Working-set volume per CANONICAL group over the window (default 2 wk), banded
// against MUSCLE_LANDMARKS. Mobility is EXCLUDED from set-count math (it never
// inflates the working-set picture). `due` = a group under its low landmark OR
// not trained in 7 days; `over` = above its high landmark. Plain words only.
export function programBalance(weeks = 2): ProgramBalance {
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(new Date(today + "T00:00:00Z").getTime() - (weeks * 7 - 1) * 864e5).toISOString().slice(0, 10);

  const rows = db.prepare(
    `SELECT e.muscle_group AS mg, e.name AS name, s.date AS date
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
       JOIN sessions s ON s.id = ls.session_id
      WHERE s.date >= ? AND s.date <= ?`
  ).all(since, today) as any[];

  // Tally per canonical group, dropping mobility from the count.
  const tally = new Map<string, { sets: number; last: string | null }>();
  for (const r of rows) {
    const g = canonicalGroup(r.mg) ?? canonicalGroup(r.name); // group, else best-effort off name
    if (!g || isMobility(g)) continue;
    const cur = tally.get(g) ?? { sets: 0, last: null };
    cur.sets += 1;
    if (!cur.last || String(r.date) > cur.last) cur.last = String(r.date);
    tally.set(g, cur);
  }

  const daysAgo = (iso: string | null): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso + "T00:00:00Z");
    return Number.isFinite(t) ? Math.round((Date.parse(today + "T00:00:00Z") - t) / 864e5) : null;
  };

  const groups: GroupBalance[] = [];
  for (const [group, v] of tally) {
    const weeklySets = Math.round((v.sets / weeks) * 10) / 10;
    const lm = MUSCLE_LANDMARKS[group];
    let band: GroupBalance["band"] = "productive";
    if (lm) band = weeklySets < lm.low ? "low" : weeklySets > lm.high ? "high" : "productive";
    const since7 = daysAgo(v.last);
    const stale = since7 != null && since7 > 7;
    const status: GroupBalance["status"] = band === "low" || stale ? "due" : band === "high" ? "high" : "ok";
    groups.push({ group, sets: weeklySets, band, last_trained: v.last, status });
  }
  // Surface groups that were NOT trained at all in the window but have a landmark
  // — they're "due" too (the missing-pattern signal lives in programAdjustments).
  groups.sort((a, b) => b.sets - a.sets);

  const due = groups.filter((g) => g.status === "due").map((g) => g.group);
  const over = groups.filter((g) => g.status === "high").map((g) => g.group);

  // Plain-words adherence-skew summary (no numbers as a grade).
  const summary = buildBalanceSummary(groups, due, over);
  return { groups, due, over, summary };
}

function buildBalanceSummary(groups: GroupBalance[], due: string[], over: string[]): string {
  if (!groups.length) return "Not enough logged yet to read your volume balance — keep training and it'll come into focus.";
  const parts: string[] = [];
  if (over.length) parts.push(`${over.join(", ")} running high`);
  if (due.length) parts.push(`${due.join(", ")} due`);
  if (!parts.length) return "Volume looks well balanced across the groups you're training.";
  return `${parts.join("; ")}.`;
}

// ---- the "what changed & why" digest ----------------------------------------
export interface ProgramAdjustment {
  kind: "progression" | "balance" | "deload" | "gap";
  title: string;
  why: string;
  exercise?: string;
}

// The handful of concrete adaptations DUE right now — lifts to push/hold/deload
// (from the plan-day prescriptions across the whole plan), groups that are due,
// and missing-pattern GAPS (no core / grip / mobility programmed). Plain words,
// most-actionable first, deduped. This is the calm "what the system noticed"
// surface — pull, never push.
export function programAdjustments(): ProgramAdjustment[] {
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
  deloads.forEach(push);
  varies.forEach(push);

  // 2) Mesocycle: a deload about due (program-state read).
  try {
    const st = getProgramState();
    if (st.mesocycle?.phase === "deload-due") {
      push({ kind: "deload", title: "A deload week is about due", why: st.mesocycle.note });
    }
  } catch { /* program-state unavailable → skip */ }

  // 3) Balance: groups that are due (under-volume or not trained recently).
  const bal = programBalance();
  for (const g of bal.due.slice(0, 4)) {
    const gb = bal.groups.find((x) => x.group === g);
    const reason = gb && gb.band === "low" ? "under its productive volume range lately" : "not trained in over a week";
    push({ kind: "balance", title: `${cap(g)} is due`, why: `${cap(g)} is ${reason} — work it in this week.` });
  }
  for (const g of bal.over.slice(0, 2)) {
    push({ kind: "balance", title: `${cap(g)} is running high`, why: `${cap(g)} volume is above its productive range — there's room to redirect some of it to a due group.` });
  }

  // 4) Missing-pattern GAPS — the elite-coach floors this athlete is missing.
  //    Read what groups appear ANYWHERE in the plan; flag core / forearms (grip)
  //    / mobility when they're absent (they were invisible until the taxonomy
  //    added them as first-class groups).
  const planned = plannedGroups();
  for (const [group, label, why] of [
    ["core", "core", "No anti-extension / anti-rotation core work is programmed — add a loaded carry or a plank/pallof variation; it underpins everything else."],
    ["forearms", "grip / forearm", "No grip work is programmed — dead hangs or loaded carries build grip, protect the elbow, and carry over to every pull."],
    ["mobility", "mobility", "No mobility / activation work is programmed — a few minutes of ankle + hip prep protects the joints, especially for a returning runner."],
  ] as const) {
    if (!planned.has(group)) {
      push({ kind: "gap", title: `No ${label} work programmed`, why });
    }
  }

  overloads.slice(0, 3).forEach(push);
  return out.slice(0, 8);
}

// The set of canonical groups that appear anywhere in the current plan.
function plannedGroups(): Set<string> {
  const rows = db.prepare(
    `SELECT DISTINCT e.muscle_group AS mg, e.name AS name
       FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id`
  ).all() as any[];
  const out = new Set<string>();
  for (const r of rows) {
    const g = canonicalGroup(r.mg) ?? canonicalGroup(r.name);
    if (g) out.add(g);
  }
  return out;
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
