import { db, todayISO } from "../db.js";
import { findExercise } from "./exercises.js";
import { lsqSlopePerDay } from "./health.js";
import { type ClampAdjustment, replacePlan, updateTarget } from "./plan.js";
import { getProgress } from "./sessions.js";

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
  // kcal floor: the lean-safe recommended intake, never below the absolute floor.
  const kcalFloor = Math.max(KCAL_ABSOLUTE_FLOOR, Number.isFinite(recIntake) ? recIntake : 0);
  const reqKcal = Number(out.target_kcal);
  if (Number.isFinite(reqKcal) && reqKcal < kcalFloor) {
    clamped.push({ exercise: "nutrition target", field: "target_kcal", requested: Math.round(reqKcal), applied: Math.round(kcalFloor),
      reason: `kcal raised to the lean-safe floor (≥${Math.round(kcalFloor)} kcal) — never a crash deficit` });
    out.target_kcal = Math.round(kcalFloor);
  }
  // protein floor: hold/raise, never below the recommended protein target.
  const reqProtein = Number(out.protein_g);
  if (Number.isFinite(recProtein) && recProtein > 0 && Number.isFinite(reqProtein) && reqProtein < recProtein) {
    clamped.push({ exercise: "nutrition target", field: "protein_g", requested: Math.round(reqProtein), applied: Math.round(recProtein),
      reason: `protein held at the recommended floor (≥${Math.round(recProtein)} g) — protein is protected under a deficit` });
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
      id, applied: [], nutrition,
      note: "advisory nutrition target — no plan changes to apply",
      ...(clamped.length ? { clamped } : {}),
    };
  }
  // Restructure proposal: full plan replacement (changed frequency / split).
  if (Array.isArray(p.parsed.days)) {
    replacePlan(p.parsed.days);
    setProposalStatus(id, "applied");
    return { id, restructured: true, days: p.parsed.days.length };
  }
  if (!Array.isArray(p.parsed.changes)) {
    throw new Error("Proposal has no valid changes or days");
  }
  const applied: any[] = [];
  const skipped: any[] = [];
  const clamped: ClampAdjustment[] = [];
  for (const c of p.parsed.changes) {
    try {
      // A cardio item belongs in a full restructure (parsed.days → replacePlan),
      // not a per-exercise target tweak — there's no loaded exercise to updateTarget.
      // Skip it transparently here so a mixed proposal never throws on the cardio row.
      if (String(c?.kind ?? "").toLowerCase() === "cardio") {
        skipped.push({ ...c, error: "cardio item — apply via a plan restructure (days), not a target change" });
        continue;
      }
      // A change carries target_weight (reps exercises) and/or target_seconds (timed).
      const tw = c.target_weight !== undefined && c.target_weight !== null ? Number(c.target_weight) : undefined;
      const ts = c.target_seconds !== undefined && c.target_seconds !== null ? Number(c.target_seconds) : undefined;
      // clamp:true — this is the auto/reviewed APPLY path, so the deterministic
      // safety clamp applies (a manual edit stays unclamped). Adjustments bubble up.
      const r = updateTarget(Number(c.day_number), String(c.exercise), tw, ts, { clamp: true });
      if (Array.isArray((r as any).clamped)) clamped.push(...(r as any).clamped);
      applied.push({ ...c, updated: r.updated });
    } catch (e: any) {
      skipped.push({ ...c, error: e.message });
    }
  }
  setProposalStatus(id, "applied");
  return { id, applied, skipped, ...(clamped.length ? { clamped } : {}) };
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
    sex: p.sex ?? cur.sex ?? "male",
    age: p.age ?? cur.age ?? null,
    height_cm: p.height_cm ?? cur.height_cm ?? null,
    weight_lb: p.weight_lb ?? cur.weight_lb ?? null,
    goal_weight_lb: p.goal_weight_lb ?? cur.goal_weight_lb ?? null,
    goal_date: p.goal_date ?? cur.goal_date ?? null,
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
  };
  db.prepare(
    `INSERT INTO profile (id, sex, age, height_cm, weight_lb, goal_weight_lb, goal_date, activity_factor, notes, about_me, allergies, dietary_restrictions, primary_discipline, endurance_sport, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       sex=excluded.sex, age=excluded.age, height_cm=excluded.height_cm, weight_lb=excluded.weight_lb,
       goal_weight_lb=excluded.goal_weight_lb, goal_date=excluded.goal_date,
       activity_factor=excluded.activity_factor, notes=excluded.notes, about_me=excluded.about_me,
       allergies=excluded.allergies, dietary_restrictions=excluded.dietary_restrictions,
       primary_discipline=excluded.primary_discipline, endurance_sport=excluded.endurance_sport, updated_at=datetime('now')`
  ).run(merged.sex, merged.age, merged.height_cm, merged.weight_lb, merged.goal_weight_lb, merged.goal_date, merged.activity_factor, merged.notes, merged.about_me, merged.allergies, merged.dietary_restrictions, merged.primary_discipline, merged.endurance_sport);
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
const LB_PER_KG = 2.2046226218;
export const KCAL_PER_LB = 3500;

export function computeGoalCheck() {
  const p = getProfile();
  if (!p || !p.weight_lb || !p.height_cm || !p.age) {
    return { ok: false, message: "Profile incomplete (need age, height, weight)." };
  }
  const kg = p.weight_lb / LB_PER_KG;
  const sexAdj = (p.sex || "male") === "female" ? -161 : 5;
  const bmr = 10 * kg + 6.25 * p.height_cm - 5 * p.age + sexAdj;
  const tdee = Math.round(bmr * (p.activity_factor || 1.5));

  const lbsToLose = p.goal_weight_lb != null ? Math.max(0, p.weight_lb - p.goal_weight_lb) : 0;

  // lean-safe loss: ~0.5-1% bodyweight/week; >1%/wk risks lean mass.
  const safeMaxRate = +(0.01 * p.weight_lb).toFixed(2);   // upper bound (lb/wk)
  const leanIdealRate = +(0.0075 * p.weight_lb).toFixed(2); // recommended (lb/wk)

  let requested: any = null;
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
  const recommended = {
    weekly_rate_lb: leanIdealRate,
    daily_deficit_kcal: recDailyDeficit,
    target_intake_kcal: tdee - recDailyDeficit,
    weeks_to_goal: lbsToLose > 0 ? Math.ceil(lbsToLose / leanIdealRate) : 0,
    protein_g: Math.round((p.weight_lb || 0) * 1.0),
  };

  let message: string;
  if (lbsToLose <= 0) {
    message = "At or below goal weight — maintain and keep training for lean mass.";
  } else if (requested?.aggressive) {
    message = `Goal of ${lbsToLose} lb by ${p.goal_date} needs ~${requested.weekly_rate_lb} lb/wk (~${requested.daily_deficit_kcal} kcal/day deficit). That's above the lean-safe ceiling of ~${safeMaxRate} lb/wk and will likely cost muscle. Recommended: ~${recommended.weekly_rate_lb} lb/wk → about ${recommended.weeks_to_goal} weeks, eating ~${recommended.target_intake_kcal} kcal with ~${recommended.protein_g} g protein.`;
  } else if (requested) {
    message = `On track: ~${requested.weekly_rate_lb} lb/wk is within the lean-safe range. Eat ~${requested.target_intake_kcal} kcal, ~${recommended.protein_g} g protein.`;
  } else {
    message = `No target date set. Lean-safe pace ~${recommended.weekly_rate_lb} lb/wk → ${recommended.weeks_to_goal} weeks to lose ${lbsToLose} lb, eating ~${recommended.target_intake_kcal} kcal, ~${recommended.protein_g} g protein.`;
  }

  // ---- goal-pace projection (from the ACTUAL weigh-in trend, not the plan) ----
  // The static math above asks "what rate would HIT the date"; this projects
  // where the CURRENT measured trend actually lands. Plain language + a date —
  // never a score. Null/silent when there isn't enough scale data or no goal.
  const goalPace = projectGoalPace(p, lbsToLose);

  return {
    ok: true, bmr: Math.round(bmr), tdee, lbs_to_lose: lbsToLose,
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

