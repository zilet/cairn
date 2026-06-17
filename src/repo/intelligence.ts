import { db, todayISO } from "../db.js";
import { getCheckinByDate, getRecoverySummary, latestSleep } from "./coach.js";
import { listContextEvents } from "./health.js";
import { KCAL_PER_LB, getPrimaryDiscipline, getProfile, projectGoalPace } from "./profile.js";

// ============================================================================
// STUBS for the Stage-2 feature teams. Each has the FINAL signature + return
// shape the teams must honor, with a sane, deterministic, null-safe body so
// the build is green and the app works TODAY. Teams replace the bodies (and
// add the agent calls / api+mcp mirrors), NOT the signatures.
// ============================================================================

// ---------- T1: day intelligence ----------
export interface DayRead {
  kind: "train" | "easy" | "rest";
  focus: string | null;          // e.g. "Lower body" on a train day
  why: string;                   // one plain-language sentence
  est_minutes: number | null;
  signals: Record<string, any>;  // the deterministic inputs behind the call
}

// Deterministic baseline (T1 layers the agentic sentence + buildDayReadPrompt on
// top). Rules: rest if >=3 consecutive training days OR recovery clearly low;
// else train the suggested plan day; else easy. Never throws on missing data.
export function dayRead(date?: string, recovery?: any): DayRead {
  const d = date || todayISO();

  // Discipline shapes what "a training day" means for the consecutive-days +
  // earned-rest rules. For a strength athlete a logged lifting session counts;
  // for an endurance/hybrid athlete a real cardio effort (a run/ride) is also a
  // training day — otherwise a runner's whole week is invisible and the Brief
  // keeps suggesting fresh sessions on top of hard mileage. Default 'strength'
  // keeps the existing behavior byte-for-byte.
  const discipline = getPrimaryDiscipline();
  const countsCardio = discipline === "endurance" || discipline === "hybrid";

  // Lifting-session days (a logged set).
  const sessionDates = new Set(
    (db.prepare(`SELECT DISTINCT s.date AS dt FROM sessions s JOIN logged_sets l ON l.session_id = s.id`).all() as any[]).map((r) => r.dt)
  );
  // Cardio/activity days that count as training for an endurance/hybrid athlete:
  // a real effort (≥20 min or any logged distance), so an incidental short walk
  // doesn't read as a hard day. Empty for a strength athlete.
  const cardioDates = countsCardio
    ? new Set(
        (db.prepare(
          `SELECT DISTINCT date AS dt FROM activities WHERE (duration_min >= 20 OR distance_km IS NOT NULL)`
        ).all() as any[]).map((r) => r.dt)
      )
    : new Set<string>();
  const trainingDay = (iso: string) => sessionDates.has(iso) || cardioDates.has(iso);

  // Consecutive training days ending the day before `d`.
  let consec = 0;
  let t = new Date(d + "T00:00:00Z").getTime() - 864e5; // start from yesterday
  while (trainingDay(new Date(t).toISOString().slice(0, 10))) { consec++; t -= 864e5; }

  // Endurance volume spike: a weekly-mileage jump well above the prior weeks'
  // average is its own earned-rest signal (consecutive-day counting can miss a
  // single very-long effort). Deterministic + null-safe; only for endurance/hybrid.
  let volumeSpike = false;
  let lastWeekKm: number | null = null;
  if (countsCardio) {
    const weekKm = (endIso: string): number => {
      const end = new Date(endIso + "T00:00:00Z").getTime();
      const start = new Date(end - 6 * 864e5).toISOString().slice(0, 10);
      const row = db.prepare(
        `SELECT COALESCE(SUM(distance_km), 0) AS km FROM activities WHERE date >= ? AND date <= ?`
      ).get(start, endIso) as any;
      return Math.round(Number(row?.km ?? 0) * 10) / 10;
    };
    const yesterdayIso = new Date(new Date(d + "T00:00:00Z").getTime() - 864e5).toISOString().slice(0, 10);
    lastWeekKm = weekKm(yesterdayIso);
    // The three prior weeks' average (the chronic base), ending a week back.
    const priorEnds = [7, 14, 21].map((n) => new Date(new Date(d + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10));
    const priorKm = priorEnds.map(weekKm);
    const chronic = priorKm.reduce((a, b) => a + b, 0) / priorKm.length;
    // A meaningful spike: this week clearly above the chronic base (and a real
    // amount of running, so a near-zero base doesn't trip on a single short run).
    volumeSpike = lastWeekKm >= 25 && chronic > 0 && lastWeekKm > chronic * 1.5;
  }

  // Recovery signal (unified). "clearly low" = short sleep or a low subjective
  // check-in for the day. All optional — absent signals never force rest. The
  // window is always "last 14 days from now" (date-independent), so a caller that
  // already has it (getCoachContext) can pass it in to avoid a redundant fetch.
  const rec = recovery ?? getRecoverySummary(14);
  const checkin = getCheckinByDate(d) as any;
  const avgSleepMin = rec?.recovery?.avg_sleep_min ?? null;
  const lowSleep = avgSleepMin != null && avgSleepMin > 0 && avgSleepMin < 360; // <6h average
  const lowSubjective = checkin && ((checkin.energy != null && checkin.energy <= 2) || (checkin.sleep_feel != null && checkin.sleep_feel <= 2));

  // ---- predictive deload anticipation ----
  // Don't wait for 3 hard days to already be logged: read the acute-vs-chronic
  // recovery DRIFT (HRV below their norm, resting HR above it) plus rising acute
  // training load, and ANTICIPATE the reset a day or two early. This NEVER forces
  // rest — it's a soft heads-up the agent can voice ("two more hard days and
  // you'll likely want a reset"). Null-safe: no baseline → no anticipation.
  const dl = rec?.delta ?? null;
  let recoveryDrift = 0; // count of signals pointing the wrong way vs the athlete's own norm
  // HRV running meaningfully below baseline (>~5% of baseline) is a fatigue tell.
  if (dl?.hrv != null && rec?.baseline?.hrv != null && rec.baseline.hrv > 0 && dl.hrv < -Math.max(2, rec.baseline.hrv * 0.05)) recoveryDrift++;
  // Resting HR running above baseline (>~2 bpm) the same way.
  if (dl?.rhr != null && dl.rhr > 2) recoveryDrift++;
  // Sleep running short vs their norm.
  if (dl?.sleep != null && dl.sleep < -25) recoveryDrift++;
  const acuteLoad = rec?.recovery?.acute_load ?? null;
  // Garmin's own readiness running low is corroborating, not required.
  const lowReadiness = rec?.recovery?.avg_training_readiness != null && rec.recovery.avg_training_readiness < 35;
  // Mounting fatigue: at least 2 straight training days AND recovery drifting the
  // wrong way (or readiness low) — i.e. heading toward a reset but not there yet.
  const buildingFatigue = consec >= 2 && (recoveryDrift >= 1 || lowReadiness);
  // A soft, plain-language anticipation note (never a verdict). Only when we're
  // building toward the rest trigger but the floor hasn't tripped it yet.
  const daysToLikelyReset = consec >= 3 ? 0 : Math.max(0, 3 - consec);
  const anticipateDeload = buildingFatigue && consec < 3;

  // What's already been logged for `d` — a lifting session (sets) or a real
  // activity (a run/ride/class). The Brief must reflect this: once you've moved
  // today it should acknowledge it, not keep suggesting a fresh session as if the
  // day were blank. A "real" activity clears a light bar (≥20 min or any logged
  // distance) so an incidental short walk doesn't suppress a genuinely-due day.
  const todaysActivities = db.prepare(
    `SELECT type, duration_min, distance_km FROM activities WHERE date = ? ORDER BY id DESC`
  ).all(d) as any[];
  const todaysSetCount = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date = ?`).get(d) as any)?.n ?? 0
  );
  const bigActivity =
    todaysActivities.find((a) => (a.duration_min != null && Number(a.duration_min) >= 20) || a.distance_km != null) || null;

  const signals = {
    consecutive_training_days: consec,
    // Discipline-aware context (v35): what "training day" counts as, and the
    // endurance volume read when it applies. Strength athletes see discipline
    // 'strength' + a null volume block (today's behavior).
    discipline,
    endurance_volume: countsCardio ? { last_week_km: lastWeekKm, volume_spike: volumeSpike } : null,
    avg_sleep_min: avgSleepMin,
    low_sleep: lowSleep,
    checkin: checkin ? { energy: checkin.energy, sleep_feel: checkin.sleep_feel, soreness: checkin.soreness, mood: checkin.mood } : null,
    has_recovery_data: !!rec?.has_data,
    // Last night's single-night sleep architecture + HRV (plain numbers + a calm
    // one-line `text`), so the Brief can speak to LAST NIGHT, not just the window.
    last_night: latestSleep(),
    logged_today: {
      sets: todaysSetCount,
      activities: todaysActivities.map((a) => ({ type: a.type, duration_min: a.duration_min, distance_km: a.distance_km })),
    },
    // Predictive deload anticipation — a soft, forward-looking fatigue read.
    // anticipate_deload true ⇒ heading toward a reset (recovery drifting below the
    // athlete's own norm while training days stack up), but the rest floor hasn't
    // tripped yet. days_to_likely_reset is a gentle countdown, never a deadline.
    fatigue: {
      anticipate_deload: anticipateDeload,
      days_to_likely_reset: anticipateDeload ? daysToLikelyReset : null,
      recovery_drift_signals: recoveryDrift,
      acute_load: acuteLoad,
      low_readiness: lowReadiness,
      hrv_vs_norm: dl?.hrv ?? null,
      rhr_vs_norm: dl?.rhr ?? null,
      sleep_vs_norm: dl?.sleep ?? null,
    },
  };

  // Already trained today (a logged lifting session)? Then today reads as covered.
  const trainedToday = sessionDates.has(d);

  // Pick a suggested plan day for the "train" case. ADVANCE the rotation off the
  // last day actually trained — mirror the PWA's plan-tab logic (it picks the day
  // after your most recent logged session) so the Brief and the exercise plan can
  // never disagree, and so the read "follows yesterday" instead of repeating it.
  // The last session's plan day is resolved by its plan_day_id, falling back to
  // the best exercise-name overlap (ad-hoc sessions logged without a plan link),
  // walking back through recent sessions until one resolves. With no resolvable
  // history at all, fall back to the weekday rotation, then the first plan day.
  function suggestedPlanDay(): { day_number: number; focus: string | null } | null {
    const days = db.prepare(`SELECT id, day_number, name, focus FROM plan_days ORDER BY day_number`).all() as any[];
    if (!days.length) return null;
    const shape = (day: any) => (day ? { day_number: day.day_number, focus: day.focus || day.name || null } : null);
    const nextAfter = (dayNumber: number) => {
      const idx = days.findIndex((x) => x.day_number === dayNumber);
      return days[idx >= 0 ? (idx + 1) % days.length : 0];
    };

    // Lazily-built name-set per plan day, only when we need an overlap match.
    let dayNameSets: { day_number: number; names: Set<string> }[] | null = null;
    const resolveByOverlap = (sessionId: number): number | null => {
      if (!dayNameSets) {
        dayNameSets = days.map((day) => ({
          day_number: day.day_number,
          names: new Set(
            (db.prepare(`SELECT e.name AS name FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id WHERE pi.plan_day_id = ?`).all(day.id) as any[]).map((r) => r.name)
          ),
        }));
      }
      const logged = new Set(
        (db.prepare(`SELECT DISTINCT e.name AS name FROM logged_sets l JOIN exercises e ON e.id = l.exercise_id WHERE l.session_id = ?`).all(sessionId) as any[]).map((r) => r.name)
      );
      let best: { day_number: number; hits: number } | null = null;
      for (const ds of dayNameSets) {
        let hits = 0;
        logged.forEach((n) => { if (ds.names.has(n)) hits++; });
        if (hits && (!best || hits > best.hits)) best = { day_number: ds.day_number, hits };
      }
      return best?.day_number ?? null;
    };

    // Most recent prior sessions that actually logged work — first one that maps
    // to a plan day sets the rotation (an ad-hoc cardio session is skipped, not a
    // reset). Excludes `d` and the future via the date filter.
    const recent = db.prepare(
      `SELECT s.id, s.plan_day_id FROM sessions s
       WHERE s.date < ? AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
       ORDER BY s.date DESC, s.id DESC LIMIT 20`
    ).all(d) as any[];
    for (const sess of recent) {
      const linked = sess.plan_day_id ? days.find((x) => x.id === sess.plan_day_id) : null;
      const lastDayNum = linked ? linked.day_number : resolveByOverlap(sess.id);
      if (lastDayNum != null) return shape(nextAfter(lastDayNum));
    }

    // No resolvable training history → weekday rotation as a gentle default.
    const idx = (new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7; // Mon=0
    return shape(days[idx % days.length]);
  }

  if (consec >= 3 || volumeSpike || lowSleep || lowSubjective) {
    return {
      kind: "rest",
      focus: null,
      why: consec >= 3
        ? "You've trained several days running — let it consolidate."
        : volumeSpike
          ? "Your mileage has jumped this week — an easier day lets it absorb."
          : lowSleep
            ? "Sleep's run short lately — an easier day will serve you better."
            : "You're feeling run-down today — rest is the smart call.",
      est_minutes: null,
      signals,
    };
  }
  if (trainedToday) {
    return { kind: "easy", focus: null, why: "You've already trained today — keep the rest of it easy.", est_minutes: 20, signals };
  }
  if (bigActivity) {
    const label = bigActivity.type && bigActivity.type !== "other" ? String(bigActivity.type) : "workout";
    return { kind: "easy", focus: null, why: `You've already got a ${label} in today — nice. Keep the rest of the day easy.`, est_minutes: 20, signals };
  }
  const sd = suggestedPlanDay();
  if (sd) {
    // Still a green-light to train (a suggestion, never a gate), but when fatigue
    // is quietly building toward a reset, voice it now — a heads-up, not a brake.
    const why = anticipateDeload
      ? `You're good to train — though recovery's drifting below your norm, so a couple more hard days and you'll likely want a reset.`
      : "You're recovered and due — good to go.";
    return { kind: "train", focus: sd.focus, why, est_minutes: 60, signals };
  }
  return { kind: "easy", focus: null, why: "Nothing programmed — some easy movement is plenty today.", est_minutes: 20, signals };
}

// ---------- the week ahead (deterministic floor) ----------
// The forward-look's safety net (coachOps.weekAheadRead layers the agentic day-by-
// day shape on top). Honest + simple: the lifting split as the week's sessions, in
// plan order, plus a base-building note — NO fabricated calendar (the agent owns the
// real day-by-day). Always available, never throws.
export interface WeekAheadDay {
  day: string | null;            // weekday label when the agent placed it; null for the floor's plan list
  kind: "lift" | "run" | "mixed" | "rest";
  label: string;                 // e.g. "Lower body" / "Easy 5k" / "Rest"
  note?: string | null;
}
export function weekAheadPlan(): { days: WeekAheadDay[]; summary: string } {
  const planDays = db.prepare(`SELECT day_number, name, focus FROM plan_days ORDER BY day_number`).all() as any[];
  if (!planDays.length) return { days: [], summary: "" };
  const days: WeekAheadDay[] = planDays.map((d) => ({
    day: null,
    kind: "lift",
    label: String(d.focus || d.name || `Day ${d.day_number}`).replace(/\s+/g, " ").trim().slice(0, 60),
  }));
  return {
    days,
    summary:
      "Your lifting week in order — weave easy, conversational runs between sessions for your aerobic base, and take a rest day when you need one.",
  };
}

// ---------- Day-read cache (the Brief) ----------
// One canonical (no-override) read per calendar day, persisted so the morning
// open is instant. The nightly scheduler pass (and any cache miss) fills it; the
// few events that materially change the read invalidate the affected day, and
// the next open recomputes once and re-caches. See src/dayread.ts for the
// agentic compute + write path that wraps the deterministic dayRead() above.
export function getCachedDayRead(date: string): any | null {
  const row = db.prepare(`SELECT * FROM day_reads WHERE date = ?`).get(date) as any;
  if (!row) return null;
  let signals: any = {};
  try { signals = row.signals ? JSON.parse(row.signals) : {}; } catch { signals = {}; }
  return {
    kind: row.kind,
    headline: row.headline,
    why: row.why,
    focus: row.focus ?? null,
    est_minutes: row.est_minutes ?? null,
    signals,
    source: row.source || "deterministic",
    agent: row.agent || undefined,
    override: row.override ?? null,
    computed_at: row.computed_at,
  };
}

export function saveDayRead(date: string, read: any): void {
  if (!date || !read || !read.kind) return;
  const override = read.override != null && String(read.override).trim() ? String(read.override).trim() : null;
  // No-clobber guard: a canonical (no-steer) recompute — nightly precompute, boot
  // warm, a cache-miss compute — must never overwrite an athlete's persisted steer
  // for the day. Only a real material change (a logged set / check-in) clears it,
  // via invalidateDayRead() deleting the row first.
  if (!override) {
    const existing = db.prepare(`SELECT override FROM day_reads WHERE date = ?`).get(date) as any;
    if (existing && existing.override) return;
  }
  db.prepare(
    `INSERT INTO day_reads (date, kind, headline, why, focus, est_minutes, signals, source, agent, override, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET
       kind=excluded.kind, headline=excluded.headline, why=excluded.why, focus=excluded.focus,
       est_minutes=excluded.est_minutes, signals=excluded.signals, source=excluded.source,
       agent=excluded.agent, override=excluded.override, computed_at=excluded.computed_at`
  ).run(
    date,
    read.kind,
    read.headline ?? null,
    read.why ?? null,
    read.focus ?? null,
    read.est_minutes != null && Number.isFinite(Number(read.est_minutes)) ? Math.round(Number(read.est_minutes)) : null,
    JSON.stringify(read.signals ?? {}),
    read.source ?? "deterministic",
    read.agent ?? null,
    override
  );
  // Keep the table to a rolling few weeks — old reads are never served.
  try { db.prepare(`DELETE FROM day_reads WHERE date < date('now','-21 days')`).run(); } catch {}
}

export function invalidateDayRead(date?: string): void {
  const d = date || todayISO();
  try { db.prepare(`DELETE FROM day_reads WHERE date = ?`).run(d); } catch {}
}

// ---------- T3: adaptive nutrition (expenditure / TDEE) ----------
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
export function estimateExpenditure(windowDays = 21): ExpenditureEstimate {
  const since = new Date(Date.now() - Math.max(1, windowDays - 1) * 864e5).toISOString().slice(0, 10);
  const nowDay = Date.now() / 864e5;

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
  const notes = db.prepare(`SELECT created_at, parsed_json FROM food_notes WHERE substr(created_at,1,10) >= ?`).all(since) as any[];
  const kcalByDay = new Map<string, number>();
  for (const n of notes) {
    let parsed: any = null;
    try { parsed = n.parsed_json ? JSON.parse(n.parsed_json) : null; } catch { parsed = null; }
    const kcal = Number(parsed?.kcal);
    if (!Number.isFinite(kcal) || kcal <= 0) continue;
    const day = String(n.created_at ?? "").slice(0, 10);
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
  const today = todayISO();
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

// ---------- T5: frequent foods by time of day ----------
// summary/count/last_at are the load-bearing fields; the macro carry-through
// (kcal/protein_g/carbs_g/fat_g, all optional) is additive — populated from the
// most recent occurrence's parsed_json when present, so a one-tap re-log can
// prefill macros without another agent call. Absent when never enriched.
export interface FrequentFood {
  summary: string;
  count: number;
  last_at: string;
  kcal?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
}

// Collapse a food summary into a grouping key: lowercase, fold whitespace, drop
// trailing punctuation and a leading "a/an/the". Slightly broader than a bare
// toLowerCase() so "Chicken & rice", "chicken and rice " and "the chicken &
// rice." all group together — but conservative on purpose (no stemming, no
// synonym table) so genuinely different meals stay distinct.
function frequentFoodKey(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[.,;:!?]+$/g, "")          // trailing punctuation
    .replace(/\s*&\s*/g, " and ")        // "&" ⇒ "and" so both spellings merge
    .replace(/^\s*(a|an|the)\s+/, "")    // leading article
    .replace(/\s+/g, " ")                // fold internal whitespace
    .trim();
}

// Recent distinct foods logged near a given hour-of-day (±2h), most-frequent
// first — powers one-tap "frequents" in fast logging. Deterministic, null-safe.
export function frequentFoods(hour?: number): FrequentFood[] {
  const targetHour = Number.isInteger(hour) && hour! >= 0 && hour! <= 23 ? hour! : new Date().getHours();
  // Push the ±2h hour band into SQL (created_at is UTC "YYYY-MM-DD HH:MM:SS", so
  // substr pos 12-13 is the hour) so the LIMIT is a horizon over MATCHING rows,
  // not a blanket recency truncation — otherwise a heavy logger's rarely-used
  // off-peak slot could fall entirely outside the 400 newest rows and return [].
  // The hour set wraps midnight naturally.
  const bandHours: number[] = [];
  for (let dh = -2; dh <= 2; dh++) bandHours.push(((targetHour + dh) % 24 + 24) % 24);
  const rows = db.prepare(
    `SELECT created_at, meal, parsed_json FROM food_notes
     WHERE CAST(substr(created_at, 12, 2) AS INTEGER) IN (${bandHours.map(() => "?").join(",")})
     ORDER BY id DESC LIMIT 400`
  ).all(...bandHours) as any[];
  const agg = new Map<string, { count: number; last_at: string }>();
  for (const r of rows) {
    // created_at is stored UTC ("YYYY-MM-DD HH:MM:SS"); read the hour and accept
    // a ±2h window (wrapping midnight) around the target.
    const hh = Number(String(r.created_at ?? "").slice(11, 13));
    if (!Number.isFinite(hh)) continue;
    const diff = Math.min(Math.abs(hh - targetHour), 24 - Math.abs(hh - targetHour));
    if (diff > 2) continue;
    let parsed: any = null;
    try { parsed = r.parsed_json ? JSON.parse(r.parsed_json) : null; } catch { parsed = null; }
    const summary = String(parsed?.summary ?? r.meal ?? "").trim();
    if (!summary) continue;
    const key = frequentFoodKey(summary);
    if (!key) continue;
    const cur = agg.get(key);
    if (cur) { cur.count++; if (String(r.created_at) > cur.last_at) cur.last_at = String(r.created_at); }
    else agg.set(key, { count: 1, last_at: String(r.created_at) });
  }
  // Recover display casing from the NEWEST occurrence of each key (rows are
  // id-DESC, so the first one we see per key wins), and macros from the newest
  // occurrence that actually CARRIES them — the most recent log of a food is
  // often a quick text entry not yet enriched, so we want the freshest enriched
  // estimate to prefill, not null.
  const display = new Map<string, string>();
  const macros = new Map<string, { kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null }>();
  const num = (v: any): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  for (const r of rows) {
    let parsed: any = null;
    try { parsed = r.parsed_json ? JSON.parse(r.parsed_json) : null; } catch { parsed = null; }
    const summary = String(parsed?.summary ?? r.meal ?? "").trim();
    if (!summary) continue;
    const key = frequentFoodKey(summary);
    if (!key) continue;
    if (!display.has(key)) display.set(key, summary);
    if (!macros.has(key)) {
      const m = {
        kcal: num(parsed?.kcal),
        protein_g: num(parsed?.protein_g),
        carbs_g: num(parsed?.carbs_g),
        fat_g: num(parsed?.fat_g),
      };
      // Only lock in macros once we find an occurrence that has at least one —
      // skip bare text logs so a later (older) enriched row can supply them.
      if (m.kcal != null || m.protein_g != null || m.carbs_g != null || m.fat_g != null) macros.set(key, m);
    }
  }
  return [...agg.entries()]
    .map(([key, v]) => {
      const m = macros.get(key);
      return {
        summary: display.get(key) ?? key,
        count: v.count,
        last_at: v.last_at,
        kcal: m?.kcal ?? null,
        protein_g: m?.protein_g ?? null,
        carbs_g: m?.carbs_g ?? null,
        fat_g: m?.fat_g ?? null,
      };
    })
    .sort((a, b) => b.count - a.count || (b.last_at > a.last_at ? 1 : -1))
    .slice(0, 8);
}

// prioritizeMarkers + the OPTIMAL_ZONES infrastructure live up with the
// propagation engine (deriveDirectives consumes them); see that section above.
