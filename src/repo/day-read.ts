// Day intelligence — the Brief's deterministic core: dayRead() (the calm train/
// easy/rest/done read), the forward look + week-ahead floor, the persisted
// day-read cache, and the effortless-capture frequents list. The agentic sentence
// layer wraps this in src/dayread.ts; this is the floor + the structured truth.
//
// Split out of the former intelligence.ts monolith (K4). Plan-day selection lives
// in plan-selection.ts; adaptive nutrition in expenditure.ts.
import { db } from "../db.js";
import { scheduleDayReadRefresh } from "../dayread-refresh.js";
import { invalidateBrainSnapshot } from "../brain/snapshot.js";
import { resolveDayReadRule, type DayReadRule } from "./brain/day-read-rules.js";
import { recordDecision } from "./brain-decisions.js";
import { getCheckinByDate, getRecoverySummary, latestSleep } from "./coach.js";
import { activeContextEffect } from "./context-effect.js";
import {
  nextCandidateAfter,
  planDayCandidates,
  planDayFocus,
  resolveSessionPlanDay,
  selectAdaptivePlanDay,
} from "./plan-selection.js";
import { getPrimaryDiscipline } from "./profile.js";
import { getProgramState } from "./program-state.js";
import { programBalance } from "./progression.js";
import { localDateISO } from "./shared.js";
import { type TrainingLoad, dayLoad } from "./training-read.js";

// ---------- T1: day intelligence ----------
export interface DayRead {
  kind: "train" | "easy" | "rest" | "done"; // 'done' = a real, loading session is already logged today
  focus: string | null; // e.g. "Lower body" on a train day
  why: string; // one plain-language sentence
  est_minutes: number | null;
  signals: Record<string, any>; // the deterministic inputs behind the call
}

// Deterministic baseline (T1 layers the agentic sentence + buildDayReadPrompt on
// top). Rules: rest if >=3 consecutive training days OR recovery clearly low;
// else train the suggested plan day; else easy. Never throws on missing data.
export function dayRead(date?: string, recovery?: any): DayRead {
  const d = date || localDateISO();

  // Discipline shapes what "a training day" means for the consecutive-days +
  // earned-rest rules. For a strength athlete a logged lifting session counts;
  // for an endurance/hybrid athlete a real cardio effort (a run/ride) is also a
  // training day — otherwise a runner's whole week is invisible and the Brief
  // keeps suggesting fresh sessions on top of hard mileage. Default 'strength'
  // keeps the existing behavior byte-for-byte.
  const discipline = getPrimaryDiscipline();
  const countsCardio = discipline === "endurance" || discipline === "hybrid";

  // Lifting-session days (a logged set) — still used for "did they train today".
  const sessionDates = new Set(
    (
      db
        .prepare(`SELECT DISTINCT s.date AS dt FROM sessions s JOIN logged_sets l ON l.session_id = s.id`)
        .all() as any[]
    ).map((r) => r.dt)
  );

  // Intensity-aware earned-rest count. The old rule treated ANY logged day as a
  // hard "training day", so a 20-min mobility session (RIR 8-10, no load) or a
  // short easy run stacked toward a forced rest exactly like a heavy lift. Now we
  // grade each day's actual LOAD (hard/moderate/easy — see training-read.dayLoad)
  // and count only genuinely LOADING days: a real recovery day BREAKS the streak,
  // which is how a coach reads it. The per-day grades ride along in `signals` so
  // the agentic layer understands the rhythm too, not just the bare count.
  const loadAt = (iso: string): TrainingLoad | "none" => dayLoad(iso, { countsCardio });
  const recentLoads: { date: string; load: TrainingLoad | "none" }[] = [];
  let consec = 0; // consecutive LOADING (hard/moderate) days ending yesterday
  let streakOpen = true;
  for (let back = 1; back <= 10; back++) {
    const iso = new Date(new Date(d + "T00:00:00Z").getTime() - back * 864e5).toISOString().slice(0, 10);
    const load = loadAt(iso);
    if (back <= 5) recentLoads.push({ date: iso, load });
    const loading = load === "hard" || load === "moderate";
    if (streakOpen && loading) consec++;
    else streakOpen = false;
    if (!streakOpen && back > 5) break;
  }

  // Endurance volume spike: a weekly-mileage jump well above the prior weeks'
  // average is its own earned-rest signal (consecutive-day counting can miss a
  // single very-long effort). Deterministic + null-safe; only for endurance/hybrid.
  let volumeSpike = false;
  let lastWeekKm: number | null = null;
  if (countsCardio) {
    const weekKm = (endIso: string): number => {
      const end = new Date(endIso + "T00:00:00Z").getTime();
      const start = new Date(end - 6 * 864e5).toISOString().slice(0, 10);
      const row = db
        .prepare(`SELECT COALESCE(SUM(distance_km), 0) AS km FROM activities WHERE date >= ? AND date <= ?`)
        .get(start, endIso) as any;
      return Math.round(Number(row?.km ?? 0) * 10) / 10;
    };
    const yesterdayIso = new Date(new Date(d + "T00:00:00Z").getTime() - 864e5).toISOString().slice(0, 10);
    lastWeekKm = weekKm(yesterdayIso);
    // The three prior weeks' average (the chronic base), ending a week back.
    const priorEnds = [7, 14, 21].map((n) =>
      new Date(new Date(d + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10)
    );
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
  // "Last night" must actually be RECENT. A wearable can stop syncing sleep for weeks
  // (a 25-day-old night is not last night), and feeding a stale night to the Brief is
  // what made it assert "you slept fine" off month-old data. Treat an old night as
  // ABSENT so the read never claims how they slept from data it doesn't have.
  const SLEEP_FRESH_DAYS = 2;
  const lsRaw = latestSleep();
  let lastNight = lsRaw;
  if (lsRaw?.date) {
    const ageDays = Math.round((Date.parse(d + "T00:00:00Z") - Date.parse(lsRaw.date + "T00:00:00Z")) / 864e5);
    if (!(ageDays >= 0 && ageDays <= SLEEP_FRESH_DAYS)) lastNight = null;
  }
  const avgSleepMin = rec?.recovery?.avg_sleep_min ?? null;
  const lowSleep = avgSleepMin != null && avgSleepMin > 0 && avgSleepMin < 360; // <6h average
  const lowSubjective =
    checkin &&
    ((checkin.energy != null && checkin.energy <= 2) || (checkin.sleep_feel != null && checkin.sleep_feel <= 2));

  // ---- predictive deload anticipation ----
  // Don't wait for 3 hard days to already be logged: read the acute-vs-chronic
  // recovery DRIFT (HRV below their norm, resting HR above it) plus rising acute
  // training load, and ANTICIPATE the reset a day or two early. This NEVER forces
  // rest — it's a soft heads-up the agent can voice ("two more hard days and
  // you'll likely want a reset"). Null-safe: no baseline → no anticipation.
  const dl = rec?.delta ?? null;
  let recoveryDrift = 0; // count of signals pointing the wrong way vs the athlete's own norm
  // HRV running meaningfully below baseline (>~5% of baseline) is a fatigue tell.
  if (
    dl?.hrv != null &&
    rec?.baseline?.hrv != null &&
    rec.baseline.hrv > 0 &&
    dl.hrv < -Math.max(2, rec.baseline.hrv * 0.05)
  )
    recoveryDrift++;
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
  const todaysActivities = db
    .prepare(`SELECT type, duration_min, distance_km FROM activities WHERE date = ? ORDER BY id DESC`)
    .all(d) as any[];
  const todaysSetCount = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date = ?`)
        .get(d) as any
    )?.n ?? 0
  );
  const bigActivity =
    todaysActivities.find((a) => (a.duration_min != null && Number(a.duration_min) >= 20) || a.distance_km != null) ||
    null;

  // Active lifestyle/context (injury, illness, travel, a late night) as of `d`. The
  // deterministic floor now READS it — an active injury isn't just prompt prose, it
  // biases the read (a caveat on the train branch, never a forced rest — you can
  // usually train around it). Null-safe; absent context changes nothing.
  const ctx = (() => {
    try {
      return activeContextEffect(d);
    } catch {
      return null;
    }
  })();
  const reduceItem = ctx?.active?.find((a) => a.reduce_load) ?? null;

  const signals = {
    // Active context the brain is accounting for (injury/illness/travel), or null.
    context: ctx?.any
      ? {
          reduce_load: !!ctx.reduce_load,
          expect_worse_sleep: !!ctx.expect_worse_sleep,
          transient_inflammation: !!ctx.transient_inflammation,
          active: ctx.active.map((a) => ({ title: a.title, kind: a.kind, reason: a.reason })).slice(0, 3),
        }
      : null,
    // Consecutive genuinely-LOADING (hard/moderate) days ending yesterday — a
    // recovery/easy day breaks the streak (it's earned rest, not stacked fatigue).
    consecutive_training_days: consec,
    // The last few days' actual load grade (hard/moderate/easy/none), so the read
    // reflects intensity, not just "did something get logged".
    recent_load: recentLoads,
    // Discipline-aware context (v35): what "training day" counts as, and the
    // endurance volume read when it applies. Strength athletes see discipline
    // 'strength' + a null volume block (today's behavior).
    discipline,
    endurance_volume: countsCardio ? { last_week_km: lastWeekKm, volume_spike: volumeSpike } : null,
    avg_sleep_min: avgSleepMin,
    low_sleep: lowSleep,
    checkin: checkin
      ? { energy: checkin.energy, sleep_feel: checkin.sleep_feel, soreness: checkin.soreness, mood: checkin.mood }
      : null,
    has_recovery_data: !!rec?.has_data,
    // Last night's single-night sleep architecture + HRV (plain numbers + a calm
    // one-line `text`), so the Brief can speak to LAST NIGHT, not just the window.
    // null when the most recent night is too old to be "last night" (see above).
    last_night: lastNight,
    logged_today: {
      sets: todaysSetCount,
      activities: todaysActivities.map((a) => ({
        type: a.type,
        duration_min: a.duration_min,
        distance_km: a.distance_km,
      })),
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

  // Pick a suggested plan day for the "train" case. This now starts with the
  // historical rotation but lets logged content, volume balance, and acute load
  // adapt the pick when another programmed day is clearly smarter.
  function suggestedPlanDay(): { day_number: number; focus: string | null; selection?: Record<string, any> } | null {
    const selected = selectAdaptivePlanDay(d);
    if (selected?.selection) (signals as any).plan_selection = selected.selection;
    return selected;
  }

  // Already trained today is a FACT, not a suggestion — and it takes PRECEDENCE over
  // the earned-rest rule. If today's logged work genuinely LOADED something (a hard/
  // moderate session OR a real run/ride — see dayLoad), the day is DONE: acknowledge the
  // work and frame the rest as recovery. Checking this FIRST is what stops two bugs:
  // (1) a hard push session mislabeled "EASY DAY", and (2) this morning's run being
  // shadowed by a "3 hard days → REST" call while a full session still sits below (the
  // "Rest today" vs planned-Pull contradiction). A light/none-load log (a short mobility
  // flush, or an easy spin a lifter doesn't count) stays soft and is handled lower down.
  // The grade + fact ride in `signals` for the agent regardless of which branch wins.
  const todayLoad = dayLoad(d, { countsCardio });
  (signals as any).trained_today = trainedToday || !!bigActivity;
  (signals as any).today_load = todayLoad;
  const rules: DayReadRule[] = [
    {
      name: "logged-loading-work-today",
      resolve: () => {
        if (!((trainedToday || bigActivity) && (todayLoad === "hard" || todayLoad === "moderate"))) return null;
        // Name the work for the deterministic `why` (the floor when the agent's offline).
        // A logged lifting session reads as "session"; otherwise name the activity (run/
        // ride). When BOTH happened, "session" wins so the lift isn't erased by the run.
        const label = trainedToday
          ? "session"
          : bigActivity && bigActivity.type && bigActivity.type !== "other"
            ? String(bigActivity.type)
            : "session";
        return {
          kind: "done",
          focus: null,
          why: `You already got a solid ${label} in today — the rest of the day is for recovery.`,
          est_minutes: null,
          signals,
        };
      },
    },
    {
      name: "earned-rest",
      resolve: () => {
        // Earned rest comes from genuinely-loading days stacking up (intensity-aware
        // now), or an acute recovery signal (short sleep / a run-down check-in). A
        // weekly-mileage spike is NO LONGER a forced rest — for a hybrid athlete with a
        // noisy chronic base it fired far too readily (and "rest" contradicted its own
        // "an easier day" wording). It now rides as a caveat on the train read below,
        // so the agent still sees `volume_spike` and the athlete still gets their day.
        if (!(consec >= 3 || lowSleep || lowSubjective)) return null;
        return {
          kind: "rest",
          focus: null,
          why:
            consec >= 3
              ? "You've trained hard several days running — let it consolidate."
              : lowSleep
                ? "Sleep's run short lately — an easier day will serve you better."
                : "You're feeling run-down today — rest is the smart call.",
          est_minutes: null,
          signals,
        };
      },
    },
    {
      name: "logged-light-work-today",
      resolve: () => {
        // An easy/light effort already done today (a short walk, a recovery spin a lifter
        // doesn't count as their real work) — acknowledge it without telling them to rest.
        if (!(trainedToday || bigActivity)) return null;
        return {
          kind: "easy",
          focus: null,
          why: "You've already moved today — keep the rest of it easy.",
          est_minutes: 20,
          signals,
        };
      },
    },
    {
      name: "endurance-volume-spike",
      resolve: () => {
        // A genuine mileage spike WHILE actively stacking loading days earns an easier
        // day (not a forced rest) so the running absorbs. Gated on consec>=1: if
        // yesterday was already a recovery/easy day, the spike has been answered — don't
        // stack easy on easy, let them train (the spike still rides as a caveat below).
        if (!(volumeSpike && consec >= 1)) return null;
        return {
          kind: "easy",
          focus: null,
          why: "Your running's ramped this week — an easy day lets it absorb.",
          est_minutes: 25,
          signals,
        };
      },
    },
    {
      name: "suggested-plan-day",
      resolve: () => {
        const sd = suggestedPlanDay();
        if (!sd) return null;
        // Still a green-light to train (a suggestion, never a gate), but voice the soft
        // caveats so it's coach-level, not a blunt "go": fatigue quietly building toward
        // a reset, and/or running ramped this week (keep today's miles easy).
        const caveats: string[] = [];
        if (reduceItem)
          caveats.push(
            reduceItem.kind === "injury"
              ? `you've got ${String(reduceItem.title || "an injury").toLowerCase()} to work around — train around it and skip anything that aggravates it`
              : "there's something to ease around right now, so keep the load conservative"
          );
        if (sd.selection?.adapted && sd.selection?.reason) caveats.push(String(sd.selection.reason));
        if (anticipateDeload)
          caveats.push(
            "recovery's drifting below your norm, so a couple more hard days and you'll likely want a reset"
          );
        if (volumeSpike)
          caveats.push("your running's ramped this week, so keep today's miles easy and don't pile on hard intensity");
        const why = caveats.length
          ? `You're good to train — ${caveats.join("; and ")}.`
          : "You're recovered and due — good to go.";
        return { kind: "train", focus: sd.focus, why, est_minutes: 60, signals };
      },
    },
  ];

  return (
    resolveDayReadRule(rules) ?? {
      kind: "easy",
      focus: null,
      why: "Nothing programmed — some easy movement is plenty today.",
      est_minutes: 20,
      signals,
    }
  );
}

// ---------- the forward look (day-ahead heads-up) ----------
// The Program-tab intelligence, woven onto the Brief so the athlete never has to
// visit a separate tab to know their focus: what the NEXT session leans toward (the
// plan day AFTER the one anchoring today) + which muscle groups are DUE this week
// (under their productive range). Deterministic + null-safe — the agent voices it
// warmly when available, this is the floor (and the structured truth the PWA renders).
export interface ForwardLook {
  next_focus: string | null; // the next session's character ("Lower body")
  due: string[]; // groups under their productive range this week
  text: string | null; // a single plain-words line, or null when there's nothing to say
}
export function forwardLook(date?: string): ForwardLook {
  const d = date || localDateISO();
  let next_focus: string | null = null;
  try {
    const days = planDayCandidates();
    if (days.length) {
      // If today already has work, "Next" means the day after that work. Otherwise
      // it means the same adaptive next-session pick the Brief points at.
      const todaySess = db
        .prepare(
          `SELECT s.id AS id, s.plan_day_id AS plan_day_id
           FROM sessions s
          WHERE s.date = ? AND EXISTS (SELECT 1 FROM logged_sets l WHERE l.session_id = s.id)
          ORDER BY s.id DESC LIMIT 1`
        )
        .get(d) as any;
      const todayResolved = todaySess
        ? resolveSessionPlanDay(
            Number(todaySess.id),
            todaySess.plan_day_id == null ? null : Number(todaySess.plan_day_id),
            days
          )
        : null;
      const selected = todayResolved ? null : selectAdaptivePlanDay(d);
      const nd = todayResolved
        ? nextCandidateAfter(days, todayResolved.day_number)
        : days.find((day) => day.day_number === selected?.day_number);
      next_focus = nd ? planDayFocus(nd) : null;
    }
  } catch {
    /* no plan → no next focus */
  }
  let due: string[] = [];
  try {
    const bal: any = programBalance(2, d);
    due = Array.isArray(bal?.due) ? bal.due.slice(0, 2) : [];
  } catch {
    /* no balance → no due groups */
  }
  const parts: string[] = [];
  if (next_focus) parts.push(`Next: ${next_focus}`);
  if (due.length) parts.push(`${due.join(" & ")} due this week`);
  return { next_focus, due, text: parts.length ? parts.join(" · ") : null };
}

// ---------- the week ahead (deterministic floor) ----------
// The forward-look's safety net (coachOps.weekAheadRead layers the agentic day-by-
// day shape on top). Honest + simple: the lifting split as the week's sessions, in
// plan order, plus a base-building note — NO fabricated calendar (the agent owns the
// real day-by-day). Always available, never throws.
export interface WeekAheadDay {
  day: string | null; // weekday label when the agent placed it; null for the floor's plan list
  kind: "lift" | "run" | "mixed" | "rest";
  label: string; // e.g. "Lower body" / "Easy 5k" / "Rest"
  note?: string | null;
}
export function weekAheadPlan(): { days: WeekAheadDay[]; summary: string } {
  const planDays = db.prepare(`SELECT id, day_number, name, focus FROM plan_days ORDER BY day_number`).all() as any[];
  if (!planDays.length) return { days: [], summary: "" };
  // Per-day modality from plan_items so the floor REFLECTS a runner's prescribed
  // cardio instead of hardcoding every day to a lift — without this a runner sees
  // zero runs in the Today week-ahead floor. cardio-only → run; cardio+strength →
  // mixed; otherwise lift. (The agentic weekAheadRead still layers the real shape.)
  const counts = new Map<number, { cardio: number; strength: number }>();
  for (const r of db
    .prepare(
      `SELECT plan_day_id AS id,
            SUM(CASE WHEN kind='cardio' THEN 1 ELSE 0 END) AS cardio,
            SUM(CASE WHEN kind='cardio' THEN 0 ELSE 1 END) AS strength
       FROM plan_items GROUP BY plan_day_id`
    )
    .all() as any[]) {
    counts.set(Number(r.id), { cardio: Number(r.cardio) || 0, strength: Number(r.strength) || 0 });
  }
  const days: WeekAheadDay[] = planDays.map((d) => {
    const c = counts.get(Number(d.id)) || { cardio: 0, strength: 0 };
    const kind: WeekAheadDay["kind"] = c.cardio > 0 ? (c.strength > 0 ? "mixed" : "run") : "lift";
    return {
      day: null,
      kind,
      label: String(d.focus || d.name || `Day ${d.day_number}`)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60),
    };
  });
  // Reflect PROGRAM STATE in the floor's summary (plain words, never a fabricated
  // calendar): if a deload is about due, or muscle groups are DUE, or a lift needs
  // a deload, say so as a forward-looking note so the look-ahead is honest about
  // what the week could use. Defensive: program-state is a heavier read — a failure
  // here must never break the deterministic week-ahead floor.
  const notes: string[] = [];
  try {
    const st = getProgramState();
    if (st?.mesocycle?.phase === "deload-due") notes.push("a deload week is about due — pencil in one lighter day");
    const bal = programBalance();
    if (Array.isArray(bal?.due) && bal.due.length)
      notes.push(
        `${bal.due.slice(0, 3).join(", ")} ${bal.due.length === 1 ? "is" : "are"} due — work ${bal.due.length === 1 ? "it" : "them"} in`
      );
    const deload = (Array.isArray(st?.lifts) ? st.lifts : [])
      .filter((l: any) => l.suggested_action === "deload")
      .map((l: any) => l.exercise);
    if (deload.length) notes.push(`${deload.slice(0, 2).join(", ")} could use a light deload`);
  } catch {
    /* program-state unavailable — fall back to the plain summary */
  }

  const base =
    "Your training week in order — weave easy, conversational runs between sessions for your aerobic base, and take a rest day when you need one.";
  return {
    days,
    summary: notes.length ? `${base} This week: ${notes.join("; ")}.` : base,
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
  try {
    signals = row.signals ? JSON.parse(row.signals) : {};
  } catch {
    signals = {};
  }
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
  try {
    db.prepare(`DELETE FROM day_reads WHERE date < date('now','-21 days')`).run();
  } catch {}
  // Persist the recommendation as a bounded, outcome-addressable decision. This
  // runs after the canonical cache write and is intentionally fail-soft: an audit
  // outage must never make the Brief unavailable.
  try {
    recordDecision({
      effective_date: date,
      kind: "day_read",
      domain: "cross_domain",
      summary: String(read.headline || `${String(read.kind)} day`).slice(0, 300),
      rationale: read.why ?? null,
      source: read.source ?? "deterministic",
      source_ref_type: "day_read",
      source_ref_key: date,
      status: "observed",
      autonomy_tier: "observe",
      risk_class: "low",
      reversible: false,
      input_fingerprint: null,
      context: { signals: read.signals ?? {}, override },
      action: {
        kind: read.kind,
        focus: read.focus ?? null,
        est_minutes: read.est_minutes ?? null,
        why: read.why ?? null,
      },
      specialist: null,
      applied_at: null,
      reverted_at: null,
      superseded_by: null,
      evaluator_version: null,
    });
  } catch {
    // The day-read cache is authoritative; learning/audit recording is best effort.
  }
}

export function invalidateDayRead(date?: string): void {
  const d = date || localDateISO();
  invalidateBrainSnapshot("day_read");
  try {
    db.prepare(`DELETE FROM day_reads WHERE date = ?`).run(d);
  } catch {}
  // Fresh-wake: schedule a debounced, coalesced, fire-and-forget background
  // recompute so the athlete's next open serves a warm agentic read instead of
  // paying the ~90s agent run inline. Best-effort + off the write path — it only
  // acts when `d` covers today AND an agent is usable (see src/dayread-refresh.ts).
  try {
    scheduleDayReadRefresh(d);
  } catch {}
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
    .replace(/[.,;:!?]+$/g, "") // trailing punctuation
    .replace(/\s*&\s*/g, " and ") // "&" ⇒ "and" so both spellings merge
    .replace(/^\s*(a|an|the)\s+/, "") // leading article
    .replace(/\s+/g, " ") // fold internal whitespace
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
  for (let dh = -2; dh <= 2; dh++) bandHours.push((((targetHour + dh) % 24) + 24) % 24);
  const rows = db
    .prepare(
      `SELECT created_at, meal, parsed_json FROM food_notes
     WHERE CAST(substr(created_at, 12, 2) AS INTEGER) IN (${bandHours.map(() => "?").join(",")})
     ORDER BY id DESC LIMIT 400`
    )
    .all(...bandHours) as any[];
  const agg = new Map<string, { count: number; last_at: string }>();
  for (const r of rows) {
    // created_at is stored UTC ("YYYY-MM-DD HH:MM:SS"); read the hour and accept
    // a ±2h window (wrapping midnight) around the target.
    const hh = Number(String(r.created_at ?? "").slice(11, 13));
    if (!Number.isFinite(hh)) continue;
    const diff = Math.min(Math.abs(hh - targetHour), 24 - Math.abs(hh - targetHour));
    if (diff > 2) continue;
    let parsed: any = null;
    try {
      parsed = r.parsed_json ? JSON.parse(r.parsed_json) : null;
    } catch {
      parsed = null;
    }
    const summary = String(parsed?.summary ?? r.meal ?? "").trim();
    if (!summary) continue;
    const key = frequentFoodKey(summary);
    if (!key) continue;
    const cur = agg.get(key);
    if (cur) {
      cur.count++;
      if (String(r.created_at) > cur.last_at) cur.last_at = String(r.created_at);
    } else agg.set(key, { count: 1, last_at: String(r.created_at) });
  }
  // Recover display casing from the NEWEST occurrence of each key (rows are
  // id-DESC, so the first one we see per key wins), and macros from the newest
  // occurrence that actually CARRIES them — the most recent log of a food is
  // often a quick text entry not yet enriched, so we want the freshest enriched
  // estimate to prefill, not null.
  const display = new Map<string, string>();
  const macros = new Map<
    string,
    { kcal: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null }
  >();
  const num = (v: any): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  for (const r of rows) {
    let parsed: any = null;
    try {
      parsed = r.parsed_json ? JSON.parse(r.parsed_json) : null;
    } catch {
      parsed = null;
    }
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
