import { db, todayISO } from "../db.js";
import { findExercise } from "./exercises.js";
import { lsqSlopePerDay } from "./health.js";
import { type ClampAdjustment, type RunPrescription, applyPlanChange, replacePlan, setWeeklyRuns } from "./plan.js";
import { getProgress } from "./sessions.js";
import { LB_PER_KG } from "./shared.js";

// ---------- exercise guide ----------
export function getExerciseDetail(name: string) {
  const ex = findExercise(name);
  if (!ex) return { found: false, name };
  const recent = db
    .prepare(
      `SELECT s.date AS date, ls.weight, ls.reps, ls.rir, ls.duration_sec FROM logged_sets ls
       JOIN sessions s ON s.id = ls.session_id
       WHERE ls.exercise_id = ? ORDER BY s.date DESC, ls.id DESC LIMIT 8`
    )
    .all(ex.id);
  const appears = db
    .prepare(
      `SELECT pd.day_number, pd.name AS day_name, pi.sets, pi.rep_low, pi.rep_high, pi.target_weight, pi.note, pi.warmup_sets, pi.target_seconds
       FROM plan_items pi JOIN plan_days pd ON pd.id = pi.plan_day_id
       WHERE pi.exercise_id = ? ORDER BY pd.day_number`
    )
    .all(ex.id);
  return { found: true, ...ex, progress: getProgress(ex.name), recent, appears };
}

// ---------- proposals ----------
export function createProposal(agent: string, instruction: string, raw: string, parsed: any) {
  const info = db
    .prepare(`INSERT INTO plan_proposals (agent, instruction, raw_output, parsed_json) VALUES (?, ?, ?, ?)`)
    .run(agent, instruction || "", raw || "", parsed ? JSON.stringify(parsed) : null);
  return getProposal(Number(info.lastInsertRowid));
}

export function listProposals(limit = 20) {
  const rows = db
    .prepare(`SELECT * FROM plan_proposals ORDER BY id DESC LIMIT ?`)
    .all(limit) as any[];
  return rows.map(hydrateProposal);
}

export function getProposal(id: number) {
  const row = db.prepare(`SELECT * FROM plan_proposals WHERE id = ?`).get(id) as any;
  return row ? hydrateProposal(row) : null;
}

function hydrateProposal(row: any) {
  let parsed: any = null;
  try {
    parsed = row.parsed_json ? JSON.parse(row.parsed_json) : null;
  } catch {
    parsed = null;
  }
  return { ...row, parsed };
}

export function setProposalStatus(id: number, status: string) {
  db.prepare(`UPDATE plan_proposals SET status = ? WHERE id = ?`).run(status, id);
  return getProposal(id);
}

// Applying a training proposal retires the OTHER open training drafts — they were
// alternative reads of the same week, so once one lands the rest are stale. Marked
// 'superseded' (the system retiring them), distinct from a user 'discarded'. Scoped
// to training drafts only: an advisory nutrition_target draft is a different category
// (surfaced via Energy Balance) and is left untouched.
function supersedeSiblingTrainingDrafts(appliedId: number) {
  const drafts = db
    .prepare(`SELECT id, parsed_json FROM plan_proposals WHERE status = 'draft' AND id != ?`)
    .all(appliedId) as any[];
  for (const d of drafts) {
    let kind: any = null;
    try { kind = d.parsed_json ? JSON.parse(d.parsed_json).kind : null; } catch { /* keep null */ }
    if (kind === "nutrition_target") continue; // different category — leave it
    db.prepare(`UPDATE plan_proposals SET status = 'superseded' WHERE id = ?`).run(d.id);
  }
}

// A fresh auto-progression draft for a day RETIRES any prior un-applied one for the
// SAME day, so tapping "apply to my plan" on Today repeatedly never piles up duplicate
// drafts in the Coach list (each new draft reflects the latest logged sets; the stale
// one is system-retired as 'superseded', not a user 'discarded'). Other days' drafts —
// and any other agent's drafts — are untouched. Returns how many were retired.
export function supersedeAutoProgressionDrafts(dayNumber: number) {
  const drafts = db
    .prepare(`SELECT id, parsed_json FROM plan_proposals WHERE status = 'draft' AND agent = 'auto-progression'`)
    .all() as any[];
  let retired = 0;
  for (const d of drafts) {
    let dn = Number.NaN;
    try {
      const parsed = d.parsed_json ? JSON.parse(d.parsed_json) : null;
      const first = parsed && Array.isArray(parsed.changes) ? parsed.changes[0] : null;
      dn = first ? Number(first.day_number) : Number.NaN;
    } catch { /* keep NaN — an unparseable draft is left alone */ }
    if (dn === Number(dayNumber)) {
      db.prepare(`UPDATE plan_proposals SET status = 'superseded' WHERE id = ?`).run(d.id);
      retired++;
    }
  }
  return retired;
}

// Clamp an advisory nutrition target to the lean-safe kcal/protein floors before
// it's acknowledged. The nutrition check-in already proposes only conservative
// ±100-250 kcal nudges, but this is the code-enforced backstop: a deficit target
// can never land below the lean-safe recommended intake (or ~1500 kcal absolute,
// whichever is higher), and protein is never dropped below the recommended floor.
// Returns the (possibly-adjusted) nutrition object plus transparent clamp records.
const KCAL_ABSOLUTE_FLOOR = 1500;   // never advise a target below this for this user (mirrors buildMealPlanPrompt)
function clampNutritionTarget(nutrition: any): { nutrition: any; clamped: ClampAdjustment[] } {
  const clamped: ClampAdjustment[] = [];
  if (!nutrition || typeof nutrition !== "object") return { nutrition, clamped };
  const out = { ...nutrition };
  let goal: any = null;
  try { goal = computeGoalCheck(); } catch { /* profile incomplete → only the absolute floors apply */ }
  const recIntake = goal?.ok ? Number(goal.recommended?.target_intake_kcal) : NaN;
  const recProtein = goal?.ok ? Number(goal.recommended?.protein_g) : NaN;
  // Mode-aware wording: the same floor protects against a crash deficit (lose),
  // an accidental shortfall below maintenance, or eating below the lean-gain anchor.
  const goalMode: string | null = goal?.ok ? goal.goal_mode : null;
  const floorLabel = goalMode === "gain" ? "lean-gain anchor" : goalMode === "maintain" ? "maintenance anchor" : "lean-safe floor";
  // kcal floor: the mode's recommended intake, never below the absolute floor.
  const kcalFloor = Math.max(KCAL_ABSOLUTE_FLOOR, Number.isFinite(recIntake) ? recIntake : 0);
  const reqKcal = Number(out.target_kcal);
  if (Number.isFinite(reqKcal) && reqKcal < kcalFloor) {
    clamped.push({ exercise: "nutrition target", field: "target_kcal", requested: Math.round(reqKcal), applied: Math.round(kcalFloor),
      reason: `kcal raised to your ${floorLabel} (≥${Math.round(kcalFloor)} kcal)${goalMode === "lose" || goalMode == null ? " — never a crash deficit" : ""}` });
    out.target_kcal = Math.round(kcalFloor);
  }
  // protein floor: hold/raise, never below the recommended protein target.
  const reqProtein = Number(out.protein_g);
  if (Number.isFinite(recProtein) && recProtein > 0 && Number.isFinite(reqProtein) && reqProtein < recProtein) {
    clamped.push({ exercise: "nutrition target", field: "protein_g", requested: Math.round(reqProtein), applied: Math.round(recProtein),
      reason: `protein held at the recommended floor (≥${Math.round(recProtein)} g) — protein stays protected` });
    out.protein_g = Math.round(recProtein);
  }
  return { nutrition: out, clamped };
}

export function applyProposal(id: number) {
  const p = getProposal(id);
  if (!p) throw new Error(`No proposal ${id}`);
  if (!p.parsed) throw new Error("Proposal has no parsed payload");
  // Adaptive nutrition-target drafts (from the nutrition check-in) are advisory —
  // there is no plan to mutate. Recognize the shape so "applying" one is a clean
  // acknowledgement on every surface (REST + MCP) instead of throwing
  // "no valid changes or days". The PWA surfaces these via the Energy Balance
  // check-in card, not the plan-proposals apply button. Even advisory, the target
  // is clamped to lean-safe kcal/protein floors and any adjustment is reported.
  if (p.parsed.kind === "nutrition_target") {
    const { nutrition, clamped } = clampNutritionTarget(p.parsed.nutrition);
    setProposalStatus(id, "applied");
    return {
      ok: true,
      id, applied: [], nutrition,
      note: "advisory nutrition target — no plan changes to apply",
      ...(clamped.length ? { clamped } : {}),
    };
  }
  // Restructure proposal: full plan replacement (changed frequency / split).
  if (Array.isArray(p.parsed.days)) {
    replacePlan(p.parsed.days);
    setProposalStatus(id, "applied");
    supersedeSiblingTrainingDrafts(id);
    return { ok: true, id, restructured: true, days: p.parsed.days.length };
  }
  // A proposal may carry strength `changes`, a week of run prescriptions (`cardio`),
  // or both. (A full split/frequency rewrite uses `days` → replacePlan above.)
  const hasChanges = Array.isArray(p.parsed.changes);
  const hasCardio = Array.isArray(p.parsed.cardio) && p.parsed.cardio.length;
  if (!hasChanges && !hasCardio) {
    throw new Error("Proposal has no valid changes, cardio, or days");
  }
  const applied: any[] = [];   // target tweaks to existing prescriptions
  const added: any[] = [];     // movements ADDED to a day (the "add a back movement" intent)
  const skipped: any[] = [];
  const clamped: ClampAdjustment[] = [];
  const cardioRuns: any[] = [];
  for (const c of hasChanges ? p.parsed.changes : []) {
    try {
      // A cardio entry inside `changes` has no loaded exercise to tweak — route it to
      // the weekly-runs applier instead of skipping it (so mixed proposals apply runs).
      if (String(c?.kind ?? "").toLowerCase() === "cardio") {
        cardioRuns.push(c);
        continue;
      }
      // clamp:true — this is the auto/reviewed APPLY path, so the deterministic
      // safety clamp applies to a target tweak (a manual edit stays unclamped).
      // applyPlanChange UPSERTS: it updates the matching prescription, or ADDS the
      // movement when it isn't on that day yet (an UPDATE that matched zero rows used
      // to be silently reported as "applied" — that lie is fixed here + below).
      const r = applyPlanChange(c, { clamp: true });
      if (Array.isArray(r.clamped)) clamped.push(...r.clamped);
      if (r.action === "added") added.push({ ...c, exercise: r.exercise });
      else applied.push({ ...c, exercise: r.exercise, updated: r.updated });
    } catch (e: any) {
      skipped.push({ ...c, error: e.message });
    }
  }
  if (hasCardio) cardioRuns.push(...p.parsed.cardio);
  let runs: { applied: any[] } | undefined;
  if (cardioRuns.length) {
    try {
      runs = setWeeklyRuns(cardioRuns.map(toRunPrescription).filter((r): r is RunPrescription => r != null));
    } catch (e: any) {
      skipped.push({ kind: "cardio", error: e.message });
    }
  }
  // Truthful apply: did anything CONCRETELY change? A target tweak that matched zero
  // rows (updated:0) is not a change — it used to flip the proposal to "applied" and
  // the UI claimed "✓ Applied" over a no-op. Only commit when something really
  // changed; otherwise leave the proposal a live draft and report ok:false so the
  // surface says so honestly instead of lying.
  const changedAny = applied.some((a) => Number(a.updated) > 0) || added.length > 0 || (runs?.applied.length ?? 0) > 0;
  if (!changedAny) {
    return {
      ok: false,
      id, applied, added, skipped,
      error: skipped.length
        ? "Couldn't apply these changes — the movement may need to be added through a plan restructure."
        : "Nothing to change — your plan already matches this.",
      ...(clamped.length ? { clamped } : {}),
    };
  }
  setProposalStatus(id, "applied");
  supersedeSiblingTrainingDrafts(id);
  return { ok: true, id, applied, added, skipped, ...(runs ? { runs: runs.applied } : {}), ...(clamped.length ? { clamped } : {}) };
}

// Map a coach-emitted cardio entry (from parsed.cardio, or a kind:'cardio' change)
// onto a RunPrescription. Returns null when there's no usable day to attach it to.
function toRunPrescription(c: any): RunPrescription | null {
  const day_number = Math.trunc(Number(c?.day_number));
  if (!Number.isFinite(day_number) || day_number < 1) return null;
  return {
    day_number,
    label: c?.label ?? c?.exercise ?? null,
    target_distance_km: c?.target_distance_km ?? null,
    target_duration_min: c?.target_duration_min ?? null,
    target_zone: c?.target_zone ?? null,
    note: c?.note ?? null,
    day_name: c?.day_name ?? null,
    focus: c?.focus ?? null,
  };
}

// ---------- profile ----------
export function getProfile(): any {
  return db.prepare(`SELECT * FROM profile WHERE id = 1`).get() || null;
}

// The athlete's primary training discipline, normalized (default 'strength').
// Deterministic, null-safe — the keystone of the endurance-aware reads/stats.
export function getPrimaryDiscipline(): "strength" | "endurance" | "hybrid" {
  const p = getProfile();
  return normalizeDiscipline(p?.primary_discipline, p?.primary_discipline);
}

export function setProfile(p: any) {
  const cur = getProfile() || {};
  const merged = {
    // The athlete's name (optional). Same contract as the free-text fields: an
    // explicit '' clears it, undefined leaves the existing value intact, capped.
    name: p.name !== undefined ? (p.name == null ? null : String(p.name).trim().slice(0, 120) || null) : (cur.name ?? null),
    sex: p.sex ?? cur.sex ?? "male",
    age: p.age ?? cur.age ?? null,
    height_cm: p.height_cm ?? cur.height_cm ?? null,
    weight_lb: p.weight_lb ?? cur.weight_lb ?? null,
    goal_weight_lb: p.goal_weight_lb ?? cur.goal_weight_lb ?? null,
    goal_date: p.goal_date ?? cur.goal_date ?? null,
    // The journey's shape (v41). Same nullable contract as the free-text fields:
    // explicit null/'' clears it (→ derived), undefined leaves intact, a valid
    // value sets it, an unrecognized value keeps the current one.
    goal_mode: p.goal_mode !== undefined ? normalizeGoalMode(p.goal_mode, cur.goal_mode) : (cur.goal_mode ?? null),
    activity_factor: p.activity_factor ?? cur.activity_factor ?? 1.5,
    notes: p.notes ?? cur.notes ?? null,
    // Rich free-text understanding (Phase 2A). Trimmed/capped; explicit empty
    // string clears it, undefined leaves the existing value intact.
    about_me: p.about_me !== undefined ? (p.about_me == null ? null : String(p.about_me).slice(0, 8000)) : (cur.about_me ?? null),
    // Allergies (HARD safety exclusion for meals) + dietary restrictions. Same
    // contract as about_me: '' clears, undefined leaves intact, capped at 1000.
    allergies: p.allergies !== undefined ? (p.allergies == null ? null : String(p.allergies).slice(0, 1000)) : (cur.allergies ?? null),
    dietary_restrictions: p.dietary_restrictions !== undefined ? (p.dietary_restrictions == null ? null : String(p.dietary_restrictions).slice(0, 1000)) : (cur.dietary_restrictions ?? null),
    // Primary training discipline (v35) — drives coach framing, the day-read, and
    // weekly stats. Only 'strength' | 'endurance' | 'hybrid' are accepted; anything
    // else falls back to the existing value (default 'strength'). endurance_sport is
    // optional free text ('' clears, undefined leaves intact, capped at 60).
    primary_discipline: normalizeDiscipline(p.primary_discipline, cur.primary_discipline),
    endurance_sport: p.endurance_sport !== undefined ? (p.endurance_sport == null ? null : String(p.endurance_sport).trim().slice(0, 60) || null) : (cur.endurance_sport ?? null),
    // The endurance OBJECTIVE (v37). undefined leaves intact, null clears, else it's
    // normalized (race | standing) and re-serialized; an unusable shape clears it.
    endurance_goal_json: p.endurance_goal !== undefined
      ? serializeEnduranceGoal(p.endurance_goal)
      : (cur.endurance_goal_json ?? null),
  };
  db.prepare(
    `INSERT INTO profile (id, name, sex, age, height_cm, weight_lb, goal_weight_lb, goal_date, goal_mode, activity_factor, notes, about_me, allergies, dietary_restrictions, primary_discipline, endurance_sport, endurance_goal_json, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       sex=excluded.sex, age=excluded.age, height_cm=excluded.height_cm, weight_lb=excluded.weight_lb,
       goal_weight_lb=excluded.goal_weight_lb, goal_date=excluded.goal_date, goal_mode=excluded.goal_mode,
       activity_factor=excluded.activity_factor, notes=excluded.notes, about_me=excluded.about_me,
       allergies=excluded.allergies, dietary_restrictions=excluded.dietary_restrictions,
       primary_discipline=excluded.primary_discipline, endurance_sport=excluded.endurance_sport,
       endurance_goal_json=excluded.endurance_goal_json, updated_at=datetime('now')`
  ).run(merged.name, merged.sex, merged.age, merged.height_cm, merged.weight_lb, merged.goal_weight_lb, merged.goal_date, merged.goal_mode, merged.activity_factor, merged.notes, merged.about_me, merged.allergies, merged.dietary_restrictions, merged.primary_discipline, merged.endurance_sport, merged.endurance_goal_json);
  return getProfile();
}

// Coerce a primary_discipline value: 'strength' | 'endurance' | 'hybrid' only;
// anything else (including undefined) leaves the existing value intact, defaulting
// to 'strength' on a brand-new profile.
const DISCIPLINES = new Set(["strength", "endurance", "hybrid"]);
export function normalizeDiscipline(v: any, current?: any): "strength" | "endurance" | "hybrid" {
  if (v !== undefined && v !== null) {
    const s = String(v).trim().toLowerCase();
    if (DISCIPLINES.has(s)) return s as "strength" | "endurance" | "hybrid";
  }
  const cur = current != null ? String(current).trim().toLowerCase() : "";
  return (DISCIPLINES.has(cur) ? cur : "strength") as "strength" | "endurance" | "hybrid";
}

// ---------- goal mode (v41) ----------
// The journey's SHAPE, orthogonal to the goal weight number:
//   lose     → today's lean-safe deficit toward a lower weight
//   maintain → anchor to real expenditure; hold steady, no deficit pressure
//   gain     → a conservative lean-gain surplus (never a dirty bulk)
// The stored column is nullable: NULL means "derive it" for back-compat.
export type GoalMode = "lose" | "maintain" | "gain";
const GOAL_MODES = new Set<GoalMode>(["lose", "maintain", "gain"]);

// Coerce an incoming goal_mode at the trust boundary. An explicit null/'' CLEARS
// it (→ derived); a recognized value sets it; an unrecognized non-empty value
// leaves the current value intact (mirrors normalizeDiscipline, but nullable).
export function normalizeGoalMode(v: any, current?: any): GoalMode | null {
  if (v === null || v === "") return null; // explicit clear → derive from goal weight
  const s = String(v ?? "").trim().toLowerCase();
  if (GOAL_MODES.has(s as GoalMode)) return s as GoalMode;
  const cur = current != null ? String(current).trim().toLowerCase() : "";
  return GOAL_MODES.has(cur as GoalMode) ? (cur as GoalMode) : null;
}

// The EFFECTIVE goal mode used by the math/prompts/UI. An explicit profile
// goal_mode wins; otherwise derive for back-compat — 'lose' when a goal weight
// meaningfully below current is set, else 'maintain'. Never returns null.
export function effectiveGoalMode(p?: any): GoalMode {
  const prof = p ?? getProfile();
  const explicit = prof?.goal_mode && GOAL_MODES.has(String(prof.goal_mode).toLowerCase() as GoalMode)
    ? (String(prof.goal_mode).toLowerCase() as GoalMode)
    : null;
  if (explicit) return explicit;
  const w = Number(prof?.weight_lb);
  const gw = Number(prof?.goal_weight_lb);
  if (Number.isFinite(w) && Number.isFinite(gw) && gw > 0 && gw < w - 0.5) return "lose";
  return "maintain";
}

// Conservative lean-gain pace: ~0.25% bodyweight/week, capped at 0.5 lb/wk — slow
// enough to bias muscle over fat (never a dirty bulk). Single source of truth for
// both the goal math (computeGoalCheck) and the weekly pace verdict (getWeeklyStats).
export function leanGainRate(weightLb: number): number {
  return Math.min(0.5, +(0.0025 * (weightLb || 0)).toFixed(2));
}

// ---------- endurance goal (v37) ----------
// The endurance OBJECTIVE, orthogonal to primary_discipline. Two modes:
//   race     → a dated event the coach periodizes a ramp + taper toward
//   standing → an ongoing readiness target (no date): maintain + gently build
// Normalized/clamped at the trust boundary; an unusable shape returns null (= clear).
export type EnduranceGoal = {
  mode: "race" | "standing";
  event?: string | null;          // race name (race mode)
  date?: string | null;           // race date YYYY-MM-DD (race mode)
  label?: string | null;          // readiness label, e.g. "10k-ready" (standing mode)
  distance_km?: number | null;    // target/readiness distance
  target?: string | null;         // qualitative target, e.g. "sub-1:45"
  weekly_km?: number | null;      // optional volume anchor
  weekly_sessions?: number | null;
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function clampPos(v: any, max: number): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : null;
}
function capStr(v: any, max: number): string | null {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}
export function normalizeEnduranceGoal(input: any): EnduranceGoal | null {
  let g: any = input;
  if (typeof g === "string") { try { g = JSON.parse(g); } catch { return null; } }
  if (!g || typeof g !== "object") return null;
  const mode = String(g.mode || "").trim().toLowerCase();
  const distance_km = clampPos(g.distance_km, 500);
  const weekly_km = clampPos(g.weekly_km, 400);
  const weekly_sessions = clampPos(g.weekly_sessions, 14);
  if (mode === "race") {
    const date = ISO_DATE.test(String(g.date || "")) ? String(g.date) : null;
    if (!date) return null; // a race without a date can't be periodized — reject
    return { mode: "race", event: capStr(g.event, 120), date, distance_km, target: capStr(g.target, 60), weekly_km, weekly_sessions };
  }
  if (mode === "standing") {
    return { mode: "standing", label: capStr(g.label, 80), distance_km, target: capStr(g.target, 60), weekly_km, weekly_sessions };
  }
  return null;
}
function serializeEnduranceGoal(input: any): string | null {
  if (input == null) return null;
  const g = normalizeEnduranceGoal(input);
  return g ? JSON.stringify(g) : null;
}

// Inclusive whole-day difference toISO − fromISO (UTC midnight, day granularity).
function daysBetweenISO(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86400000);
}

// Deterministic read of the active endurance goal, with race timing derived for the
// coach (weeks/days out + a coarse periodization PHASE hint). Standing goals have no
// date, so no phase — the coach maintains rather than ramps. Returns null when unset.
export function getEnduranceGoal(today?: string): (EnduranceGoal & {
  is_race: boolean;
  days_to_race?: number | null;
  weeks_to_race?: number | null;
  phase?: "base" | "build" | "sharpen" | "taper" | "past" | null;
}) | null {
  const p = getProfile();
  const g = normalizeEnduranceGoal(p?.endurance_goal_json);
  if (!g) return null;
  if (g.mode !== "race" || !g.date) return { ...g, is_race: false };
  const days = daysBetweenISO(today || todayISO(), g.date);
  if (!Number.isFinite(days)) return { ...g, is_race: true, days_to_race: null, weeks_to_race: null, phase: null };
  const weeks = Math.ceil(days / 7);
  // Coarse phase hint from time-to-race (the coach refines against actual base):
  // past → done; ≤2wk taper; ≤4wk sharpen; ≤10wk build; else base.
  const phase = days < 0 ? "past" : weeks <= 2 ? "taper" : weeks <= 4 ? "sharpen" : weeks <= 10 ? "build" : "base";
  return { ...g, is_race: true, days_to_race: days, weeks_to_race: Math.max(0, weeks), phase };
}

// ---------- bodyweight log ----------
export function logWeight(weight_lb: number, date?: string, note?: string) {
  const d = date || todayISO();
  const info = db
    .prepare(`INSERT INTO bodyweight_log (date, weight_lb, note) VALUES (?, ?, ?)`)
    .run(d, weight_lb, note ?? null);
  // Keep the profile's current weight in sync with the most recent entry.
  const latest = db.prepare(`SELECT weight_lb FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT 1`).get() as any;
  if (latest) setProfile({ weight_lb: latest.weight_lb });
  return db.prepare(`SELECT * FROM bodyweight_log WHERE id = ?`).get(info.lastInsertRowid);
}

export function listWeight(limit = 60) {
  // chronological for charting
  const rows = db.prepare(`SELECT * FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT ?`).all(limit) as any[];
  return rows.reverse();
}

// ---------- goal feasibility check ----------
export const KCAL_PER_LB = 3500;

export function computeGoalCheck(prof?: any) {
  const p = prof ?? getProfile();
  if (!p || !p.weight_lb || !p.height_cm || !p.age) {
    return { ok: false, message: "Profile incomplete (need age, height, weight)." };
  }
  const kg = p.weight_lb / LB_PER_KG;
  const sexAdj = (p.sex || "male") === "female" ? -161 : 5;
  const bmr = 10 * kg + 6.25 * p.height_cm - 5 * p.age + sexAdj;
  const tdee = Math.round(bmr * (p.activity_factor || 1.5));

  const mode = effectiveGoalMode(p);
  const lbsToLose = p.goal_weight_lb != null ? Math.max(0, p.weight_lb - p.goal_weight_lb) : 0;

  // lean-safe loss: ~0.5-1% bodyweight/week; >1%/wk risks lean mass.
  const safeMaxRate = +(0.01 * p.weight_lb).toFixed(2);   // upper bound (lb/wk)
  const leanIdealRate = +(0.0075 * p.weight_lb).toFixed(2); // recommended (lb/wk)

  let requested: any = null;
  let recommended: {
    weekly_rate_lb: number; daily_deficit_kcal: number; target_intake_kcal: number;
    weeks_to_goal: number; protein_g: number;
  };
  let message: string;

  if (mode === "maintain") {
    // Anchor to real expenditure. No deficit, no surplus — hold steady. We only
    // ever nudge later if the measured weight trend genuinely drifts.
    recommended = {
      weekly_rate_lb: 0,
      daily_deficit_kcal: 0,
      target_intake_kcal: tdee,
      weeks_to_goal: 0,
      protein_g: Math.round((p.weight_lb || 0) * 0.9),
    };
    message = `Maintaining — anchor to ~${tdee} kcal with ~${recommended.protein_g} g protein. Hold steady; we only nudge if your weight genuinely drifts.`;
  } else if (mode === "gain") {
    // Conservative lean gain: ~0.25% bodyweight/week (capped at 0.5 lb/wk) — slow
    // enough to bias muscle over fat. NEVER a dirty bulk; lab quality (e.g. ApoB)
    // still gates WHAT the surplus is made of via the connected brain.
    const gainRate = leanGainRate(p.weight_lb);
    const dailySurplus = Math.round((gainRate * KCAL_PER_LB) / 7);
    recommended = {
      weekly_rate_lb: gainRate,
      daily_deficit_kcal: -dailySurplus,   // negative = a surplus (field name kept for back-compat)
      target_intake_kcal: tdee + dailySurplus,
      weeks_to_goal: 0,
      protein_g: Math.round((p.weight_lb || 0) * 1.0),
    };
    message = `Lean gain — eat ~${recommended.target_intake_kcal} kcal (about +${dailySurplus}/day over maintenance) with ~${recommended.protein_g} g protein. Slow and steady builds muscle, not fat.`;
  } else {
    // lose (explicit, or derived from a goal weight below current).
    if (p.goal_date && lbsToLose > 0) {
      const weeks = Math.max(0.1, (new Date(p.goal_date).getTime() - Date.now()) / (7 * 864e5));
      const rate = +(lbsToLose / weeks).toFixed(2);
      const dailyDeficit = Math.round((rate * KCAL_PER_LB) / 7);
      requested = {
        weeks: +weeks.toFixed(1),
        weekly_rate_lb: rate,
        daily_deficit_kcal: dailyDeficit,
        target_intake_kcal: Math.max(0, tdee - dailyDeficit),
        aggressive: rate > safeMaxRate,
      };
    }
    const recDailyDeficit = Math.round((leanIdealRate * KCAL_PER_LB) / 7);
    recommended = {
      weekly_rate_lb: leanIdealRate,
      daily_deficit_kcal: recDailyDeficit,
      target_intake_kcal: tdee - recDailyDeficit,
      weeks_to_goal: lbsToLose > 0 ? Math.ceil(lbsToLose / leanIdealRate) : 0,
      protein_g: Math.round((p.weight_lb || 0) * 1.0),
    };
    if (lbsToLose <= 0) {
      message = "At or below goal weight — maintain and keep training for lean mass.";
    } else if (requested?.aggressive) {
      message = `Goal of ${lbsToLose} lb by ${p.goal_date} needs ~${requested.weekly_rate_lb} lb/wk (~${requested.daily_deficit_kcal} kcal/day deficit). That's above the lean-safe ceiling of ~${safeMaxRate} lb/wk and will likely cost muscle. Recommended: ~${recommended.weekly_rate_lb} lb/wk → about ${recommended.weeks_to_goal} weeks, eating ~${recommended.target_intake_kcal} kcal with ~${recommended.protein_g} g protein.`;
    } else if (requested) {
      message = `On track: ~${requested.weekly_rate_lb} lb/wk is within the lean-safe range. Eat ~${requested.target_intake_kcal} kcal, ~${recommended.protein_g} g protein.`;
    } else {
      message = `No target date set. Lean-safe pace ~${recommended.weekly_rate_lb} lb/wk → ${recommended.weeks_to_goal} weeks to lose ${lbsToLose} lb, eating ~${recommended.target_intake_kcal} kcal, ~${recommended.protein_g} g protein.`;
    }
  }

  // ---- goal-pace projection (from the ACTUAL weigh-in trend, not the plan) ----
  // The static math above asks "what rate would HIT the date"; this projects
  // where the CURRENT measured trend actually lands. Plain language + a date —
  // never a score. Null/silent when there isn't enough scale data or no goal.
  const goalPace = projectGoalPace(p, lbsToLose);

  return {
    ok: true, bmr: Math.round(bmr), tdee, lbs_to_lose: lbsToLose,
    // The effective journey shape (v41) — drives the day-intake target framing,
    // the pace verdict, and every nutrition prompt. Additive; older consumers ignore.
    goal_mode: mode,
    safe_max_rate_lb: safeMaxRate, requested, recommended, message,
    // Additive (older consumers ignore): the measured-trend forecast.
    trend_lb_wk: goalPace.trend_lb_wk,
    projected_goal_date: goalPace.projected_goal_date,
    projection_text: goalPace.projection_text,
  };
}

// Project where the athlete's CURRENT measured weight trend lands their goal —
// a real forecast off the scale, not the plan's required pace. Returns the
// measured weekly trend, a projected goal date (or null), and a plain-language
// line ("at this trend, ~Aug 20 — about 3 weeks past your date"). Words + a
// date, never a number-as-score. Null-safe: too little scale data / no goal →
// quiet (trend or date null, no false precision).
export function projectGoalPace(p: any, lbsToLose: number): {
  trend_lb_wk: number | null;
  projected_goal_date: string | null;
  projection_text: string | null;
} {
  // Measured weekly trend over the last 28 days of weigh-ins (a bit longer than
  // the 21-day weekly-stats window so a goal forecast is steadier).
  const since = new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
  const wpts = db.prepare(`SELECT date, weight_lb FROM bodyweight_log WHERE date >= ? ORDER BY date, id`).all(since) as any[];
  let trend: number | null = null; // lb/week (negative = losing)
  if (wpts.length >= 2) {
    const pts = wpts.map((w) => ({ date: String(w.date), value: Number(w.weight_lb) })).filter((x) => Number.isFinite(x.value));
    const xs = pts.map((x) => Date.parse(x.date + "T00:00:00Z") / 864e5);
    if (pts.length >= 2 && xs[xs.length - 1] - xs[0] >= 4) {
      const slope = lsqSlopePerDay(pts);
      if (slope != null) trend = Math.round(slope * 7 * 100) / 100;
    }
  }
  const curW = wpts.length ? Number(wpts[wpts.length - 1].weight_lb) : (p?.weight_lb ?? null);
  if (lbsToLose <= 0 || curW == null) return { trend_lb_wk: trend, projected_goal_date: null, projection_text: null };
  if (trend == null) return { trend_lb_wk: null, projected_goal_date: null, projection_text: "Not enough recent weigh-ins to project a date yet — a few more and the forecast sharpens." };

  const goalW = p?.goal_weight_lb;
  if (goalW == null) return { trend_lb_wk: trend, projected_goal_date: null, projection_text: null };

  // Not actually losing (trend flat or gaining) while there's still weight to
  // lose → no honest date; say so plainly rather than inventing one.
  if (trend >= -0.05) {
    return {
      trend_lb_wk: trend,
      projected_goal_date: null,
      projection_text: trend > 0.05
        ? "At your current trend you're drifting up, not down — no date to project until the trend turns."
        : "Your weight's holding steady right now — a small deficit would start moving it toward your goal.",
    };
  }

  const weeksToGoal = (curW - goalW) / Math.abs(trend);
  if (!Number.isFinite(weeksToGoal) || weeksToGoal <= 0 || weeksToGoal > 520) {
    return { trend_lb_wk: trend, projected_goal_date: null, projection_text: "At this trend the goal is a long way out — worth revisiting the pace." };
  }
  const projDate = new Date(Date.now() + weeksToGoal * 7 * 864e5);
  const projected_goal_date = projDate.toISOString().slice(0, 10);
  const niceDate = projDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  let projection_text: string;
  if (p?.goal_date) {
    const goalDateMs = Date.parse(p.goal_date);
    if (Number.isFinite(goalDateMs)) {
      const diffWeeks = Math.round((projDate.getTime() - goalDateMs) / (7 * 864e5));
      if (diffWeeks <= -1) projection_text = `At your current trend, ~${niceDate} — about ${Math.abs(diffWeeks)} week${Math.abs(diffWeeks) === 1 ? "" : "s"} ahead of your date.`;
      else if (diffWeeks >= 1) projection_text = `At your current trend, ~${niceDate} — about ${diffWeeks} week${diffWeeks === 1 ? "" : "s"} past your date.`;
      else projection_text = `At your current trend, ~${niceDate} — right around your target date.`;
    } else {
      projection_text = `At your current trend, you'd reach your goal around ${niceDate}.`;
    }
  } else {
    projection_text = `At your current trend, you'd reach your goal around ${niceDate} — no target date set, so this is just where the scale's heading.`;
  }
  return { trend_lb_wk: trend, projected_goal_date, projection_text };
}

