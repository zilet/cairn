// Adaptive nutrition — the MacroFactor-style energy-balance derivation (TDEE from
// intake vs. the recency-weighted weigh-in trend). Adherence-neutral: a thin logging
// week only lowers confidence, it NEVER blames the athlete and NEVER reads a gap as a
// number to act on. Null-safe throughout.
//
// Split out of the former intelligence.ts monolith (K4).
import { db } from "../db.js";
import { listContextEvents } from "./health.js";
import { KCAL_PER_LB, getProfile, projectGoalPace } from "./profile.js";
import { addDaysISO, localDateISO } from "./shared.js";
import {
  foodBackstopSignature,
  registerTrainingCacheClear,
  trainingBackstopSignature,
} from "./training-cache.js";

export interface ExpenditureEstimate {
  tdee: number | null;            // derived maintenance kcal, or null when too little data
  confidence: "none" | "low" | "medium" | "high";
  points: number;                // how many days of usable data backed it
  window_days: number;
  intake_avg_kcal: number | null;
  trend_lb_wk: number | null;    // weighted bodyweight trend over the window
  // Goal-pace projection off the ACTUAL weigh-in trend (plain language, no score).
  // null/absent when there's no goal or too little scale data.
  projected_goal_date?: string | null;
  projection_text?: string | null;
}

// Energy-balance derivation (MacroFactor-style, adherence-neutral). TDEE ≈ avg
// daily intake − (weighted weekly weight change in lb × 3500 / 7). Null-safe:
// too few weigh-ins or no intake → tdee null, confidence 'none'. Adherence-
// neutral: a thin logging week only lowers confidence — it NEVER blames the
// athlete and NEVER reads a gap as a number to act on. The deepening over the
// baseline: recent weigh-ins are weighted more heavily (the body's "now" matters
// most), higher confidence demands BOTH enough intake days AND enough weigh-ins
// spanning enough calendar days, and an active travel/illness window (from
// context_events) suppresses confidence — intake logging and the scale are both
// disrupted then, so we lean conservative rather than re-target on noise.
// MEMOIZED (repo/training-cache.ts): this JSON-parses every food note in the window
// on each call, and the Energy Balance view + coach context both reach it. It's a pure
// function of (windowDays, today, weigh-ins/profile/context [the training backstop] and
// food notes [the food backstop]), so memoize on exactly that and serve a structuredClone.
// Single-slot — the hot path is windowDays=21 for today.
let expenditureCache: { key: string; value: ExpenditureEstimate } | null = null;
registerTrainingCacheClear(() => { expenditureCache = null; });

export function estimateExpenditure(windowDays = 21): ExpenditureEstimate {
  const key = `${windowDays}|${localDateISO()}|${trainingBackstopSignature()}|${foodBackstopSignature()}`;
  if (expenditureCache && expenditureCache.key === key) return structuredClone(expenditureCache.value);
  const value = computeExpenditure(windowDays);
  expenditureCache = { key, value };
  return structuredClone(value);
}

function computeExpenditure(windowDays = 21): ExpenditureEstimate {
  const today = localDateISO();
  const since = addDaysISO(today, -Math.max(1, windowDays - 1)) ?? today;
  const nowDay = Date.parse(`${today}T00:00:00Z`) / 864e5;

  // Goal-pace projection off the measured weigh-in trend — surfaced on the Energy
  // Balance view alongside the expenditure read (plain language, never a score).
  // Shared with computeGoalCheck so /api/goal and /api/nutrition/expenditure agree.
  const prof = getProfile() as any;
  const lbsToLose = prof?.goal_weight_lb != null && prof?.weight_lb != null ? Math.max(0, prof.weight_lb - prof.goal_weight_lb) : 0;
  const goalPace = projectGoalPace(prof, lbsToLose);

  // Bodyweight trend over the window — a RECENCY-WEIGHTED least-squares slope
  // (lb/week). Each weigh-in gets weight exp(-ageDays / halfLife*1.4427) so the
  // newest days dominate; MacroFactor's adaptive expenditure leans the same way
  // (the body's current trajectory matters more than three weeks ago).
  const wpts = db.prepare(`SELECT date, weight_lb FROM bodyweight_log WHERE date >= ? ORDER BY date, id`).all(since) as any[];
  let trend: number | null = null;
  let weighDays = 0;        // distinct weigh-in days, for confidence
  let weighSpanDays = 0;    // first→last calendar span, for confidence
  if (wpts.length >= 2) {
    const xs = wpts.map((p) => Date.parse(p.date + "T00:00:00Z") / 864e5);
    const ys = wpts.map((p) => Number(p.weight_lb));
    weighDays = new Set(wpts.map((p) => String(p.date))).size;
    weighSpanDays = xs[xs.length - 1] - xs[0];
    if (weighSpanDays >= 3) {
      // Half-life ~10 days: a weigh-in 10 days old counts ~half a fresh one.
      const halfLife = Math.max(7, windowDays / 2);
      const ws = xs.map((x) => Math.exp(-((nowDay - x) * Math.LN2) / halfLife));
      const sw = ws.reduce((a, b) => a + b, 0);
      const mx = xs.reduce((a, x, i) => a + ws[i] * x, 0) / sw;
      const my = ys.reduce((a, y, i) => a + ws[i] * y, 0) / sw;
      let num = 0, den = 0;
      for (let i = 0; i < xs.length; i++) { num += ws[i] * (xs[i] - mx) * (ys[i] - my); den += ws[i] * (xs[i] - mx) ** 2; }
      if (den > 0) trend = (num / den) * 7; // lb/day → lb/wk
    }
  }

  // Average daily intake from food_notes over the window (sum kcal per day,
  // then average across days that have any logged food). Days with no food
  // logged are simply absent — never counted as zero (that would slander an
  // off-logging day as a crash diet); they only thin the data.
  const notes = db.prepare(
    `SELECT COALESCE(date, substr(created_at, 1, 10)) AS day, parsed_json
       FROM food_notes
      WHERE COALESCE(date, substr(created_at, 1, 10)) >= ?`
  ).all(since) as any[];
  const kcalByDay = new Map<string, number>();
  for (const n of notes) {
    let parsed: any = null;
    try { parsed = n.parsed_json ? JSON.parse(n.parsed_json) : null; } catch { parsed = null; }
    const kcal = Number(parsed?.kcal);
    if (!Number.isFinite(kcal) || kcal <= 0) continue;
    const day = String(n.day ?? "").slice(0, 10);
    if (!day) continue;
    kcalByDay.set(day, (kcalByDay.get(day) ?? 0) + kcal);
  }
  const dayTotals = [...kcalByDay.values()];
  const intakeAvg = dayTotals.length ? Math.round(dayTotals.reduce((a, b) => a + b, 0) / dayTotals.length) : null;

  const points = dayTotals.length;
  if (intakeAvg == null || trend == null) {
    return { tdee: null, confidence: "none", points, window_days: windowDays, intake_avg_kcal: intakeAvg, trend_lb_wk: trend == null ? null : Math.round(trend * 100) / 100, projected_goal_date: goalPace.projected_goal_date, projection_text: goalPace.projection_text };
  }
  // TDEE = intake − (weekly Δweight as a daily kcal balance).
  const dailyBalance = (trend * KCAL_PER_LB) / 7; // +ve trend (gaining) ⇒ surplus
  const tdee = Math.round(intakeAvg - dailyBalance);

  // Confidence demands BOTH enough intake days AND enough weigh-ins over enough
  // calendar span — a slope off two clustered days isn't trustworthy.
  let confidence: ExpenditureEstimate["confidence"];
  if (points >= 14 && weighDays >= 8 && weighSpanDays >= 14) confidence = "high";
  else if (points >= 7 && weighDays >= 4 && weighSpanDays >= 7) confidence = "medium";
  else confidence = "low";

  // Suppress during an active travel/illness window: the scale and the food log
  // are both unreliable mid-trip / mid-illness, so we lower confidence by a step
  // rather than re-target on disrupted data. NOT a judgement — just caution.
  if (confidence !== "low" && expenditureDisruptedNow()) {
    confidence = confidence === "high" ? "medium" : "low";
  }

  return { tdee, confidence, points, window_days: windowDays, intake_avg_kcal: intakeAvg, trend_lb_wk: Math.round(trend * 100) / 100, projected_goal_date: goalPace.projected_goal_date, projection_text: goalPace.projection_text };
}

// True when an active/upcoming context_event makes intake + weight unreliable
// right now: any trip overlapping today, or a life_event whose text reads as
// illness/sick. Used to lower expenditure confidence (never to scold).
function expenditureDisruptedNow(): boolean {
  const today = localDateISO();
  const events = listContextEvents({ activeOnly: true }) as any[];
  const ILLNESS = /\b(ill|illness|sick|sickness|flu|fever|cold|covid|infection|food ?poison|stomach|gastro|bug|virus|unwell)\b/i;
  for (const e of events) {
    const start = e?.start_date ? String(e.start_date) : null;
    const end = e?.end_date ? String(e.end_date) : null;
    // Active today = started on/before today AND not yet ended (open-ended counts).
    const startedByNow = !start || start <= today;
    const notEnded = !end || end >= today;
    if (!startedByNow || !notEnded) continue;
    if (e?.kind === "trip") return true;
    if (e?.kind === "life_event") {
      const txt = `${e?.title ?? ""} ${e?.detail ?? ""} ${e?.meta?.impact ?? ""}`;
      if (ILLNESS.test(txt)) return true;
    }
  }
  return false;
}
