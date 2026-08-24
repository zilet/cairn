import { db } from "../db.js";
import { emitBrainEvent } from "../brainEvents.js";
import { getGarminCoachSummary, hydrateJson, jsonOrNull, listActivities } from "./activities.js";
import {
  cleanClinicalFacts,
  getLatestHealthReview,
  hydrateHealthDoc,
  listContextEvents,
  newestHealthDocDate,
  planningContextEvents,
  recentContextTags,
} from "./health.js";
import { imagingForCoach } from "./imaging.js";
import {
  dayPlanningSignalState,
  dayRead,
  getCachedDayRead,
  invalidateDayRead,
  invalidateDayReadIfDecisionChanged,
} from "./intelligence.js";
import { blockForCoach, getActiveBlock } from "./program-blocks.js";
import { getProgramState, type ProgramState } from "./program-state.js";
import { getStrengthJourney } from "./strength-objectives.js";
import { performanceStanding } from "./performance.js";
import { weekLayoutRead } from "../domain/training/week-layout.js";
import { enduranceTestsDue, runVarietyRead, runZones, weeklyRunPlan } from "./run-progression.js";
import { hrModelForCoach } from "./hr-model.js";
import { calibrationForCoach } from "./calibration.js";
import { flexibleTrainingAgenda } from "./flexible-training-agenda.js";
import { dexaTargeting } from "./dexa-targeting.js";
import { muscleGroupTrajectory, planExerciseNames, testWeekDue } from "./muscle-trajectory.js";
import { coachingFocus } from "./coaching-focus.js";
import { type AcuteGateReading, acuteGates } from "./hybrid-load.js";
import { planDayProgression, programAdjustments, programBalance, recentMuscleLoad } from "./progression.js";
import { jaccard, memNorm, memoryForCoach, recentLearnings } from "./memory.js";
import { capStr, getDayIntake, mealPlanForCoach } from "./nutrition.js";
import { listFuelingFeedback } from "./fueling.js";
import { fuelDemandWeek } from "./fuel-demand.js";
import { bodyMetricsContextSlice } from "./body-metrics.js";
import { getPlan } from "./plan.js";
import {
  computeGoalCheck,
  activeRecoveryWeek,
  effectiveGoalMode,
  getEnduranceGoal,
  getProfile,
  listWeight,
  recoveryWeekStatus,
} from "./profile.js";
import { bodyCompositionRead } from "./standing.js";
import {
  directiveFeedbackForCoach,
  directivesForCoach,
  getHealthSynthesisView,
  healthFocus,
  markerSide,
  matchOptimalZone,
  optimalDistance,
  prioritizeMarkers,
  supplementsForCoach,
} from "./propagation.js";
import { symptomMarkerLinks } from "./symptom-links.js";
import { classifyDirectiveIntent } from "./propagation-data.js";
// The active-directive read lives in its own leaf so the eight modules that ask
// "what is the athlete acting on?" need not import coach.ts. Re-exported below for
// the callers that have always imported it from here.
import {
  dedupeActiveDirectives,
  directiveIdentityKey,
  directiveKey,
  hydrateDirective,
  listActiveDirectives,
} from "./directives-read.js";
export {
  directiveIdentityKey,
  directiveIntentOf,
  directiveKey,
  hydrateDirective,
  listActiveDirectives,
} from "./directives-read.js";
import { CADENCE_WINDOW_DAYS, classifyWearPattern, type WearPattern } from "./sensor-cadence.js";
import { sensorAgeDays } from "./sensor-freshness.js";
import { sampleSd, STRESS_WINDOW_DAYS, trainingConstraintsRead } from "./recovery-science.js";
import { getAppState, setAppState } from "./app-state.js";
import { readAdherenceModel } from "./brain/read-adherence.js";
import { getProgress, getRecentSessions, typicalTrainingHour, vouchedRunCompliance } from "./sessions.js";
import { symptomAreaKey } from "./symptom-area.js";
import { listTrainingSymptoms } from "./training-symptoms.js";
import { addDaysISO, localDateISO, nowContext } from "./shared.js";
import { bumpTrainingDataVersion, currentTrainingDataVersion, registerTrainingCacheClear } from "./training-cache.js";
import { currentMarkerDataVersion } from "./marker-cache.js";
import type { CoachContext, CoachDayIntake, CoachProgramState } from "./coach-context.js";
// The "knows-me" layer — additive context keys (function-level cycle, same shape as
// the existing coach↔intelligence import; resolved at call time, never at module init).
import { reactionModelForCoach, whatWorksForYou } from "./reaction-model.js";
import { feltSignalsForCoach } from "./felt-signals.js";
import { learnedModelsForCoach } from "./learned-models.js";
import { getTrajectory } from "./trajectory.js";
import { wholePersonTrajectory } from "./whole-person-trajectory.js";
import { journeyRead } from "./journey.js";
import { activeContextEffect } from "./context-effect.js";
import { getLocationContext } from "./location-context.js";
import { nextBestStep } from "./next-step.js";
// Read-only reads folded into the conductor as external FocusCandidate producers (K3).
import { cardiovascularRiskRead } from "./risk.js";
import { trainingBenchmarkRead } from "./training-milestones.js";
import { listDueAttention } from "./attention.js";
// Function-level cycle (doctor-loop imports listDirectives back from here);
// scheduleDirectiveRecheck is only called at runtime inside updateDirective, so
// the hoisted binding is always resolved by call time.
import { scheduleDirectiveRecheck } from "./doctor-loop.js";
import { brainSignal, runWithBrainSnapshot } from "../brain/snapshot.js";
import {
  listBrainDecisions,
  listBrainExpectations,
  recentAppliedRotations,
  upcomingBrainDecisions,
} from "./brain-decisions.js";
import { getSettings } from "./settings.js";
import { latestBrainEvaluation } from "./brain-evaluations.js";
import { estimateExpenditure } from "./expenditure.js";
import { tomorrowHolds, type UnifiedSignalState } from "./signal-state.js";
import { dayLoad } from "./training-read.js";
import { currentUnderfuelingRead } from "./underfueling-snapshot.js";
import { cutQualityRead } from "./cut-quality.js";
import { getTrainingIntent } from "./training-intent.js";
import { getEnduranceCapacity } from "./endurance-capacity.js";

// ---------- coach context (shared by prompts) ----------
// Compact view of a health doc for coaching: kind, date, summary, key markers
// (capped) — never the raw file or the full marker list.
function healthForCoach() {
  const docs = db.prepare(`SELECT * FROM health_documents ORDER BY id DESC LIMIT 5`).all() as any[];
  return docs.map((d) => {
    const h = hydrateHealthDoc(d);
    // A modern panel lists 100+ markers; a flat slice(0,30) in parse order can drop
    // the flagged/off-optimal long tail (the markers that actually matter) just
    // because the lab printed the normal CBC first. Rank flagged (low/high) and
    // out-of-optimal markers ahead of the in-range ones, THEN cap — so the coach
    // always sees the concerning ones. Stable for ties (preserves parse order).
    const markers = Array.isArray(h.parsed?.markers) ? rankDocMarkers(h.parsed.markers).slice(0, 30) : undefined;
    const clinical_facts = cleanClinicalFacts(h.parsed?.clinical_facts, 12).map((f: any) => ({
      kind: f.kind,
      date: f.date,
      name: f.name,
      status: f.status,
      detail: capStr(f.detail, 240),
      source: f.source,
    }));
    return {
      kind: h.kind,
      doc_date: h.doc_date,
      summary: h.summary,
      type: h.parsed?.type,
      markers,
      ...(clinical_facts.length ? { clinical_facts } : {}),
    };
  });
}

// Flagged-first / furthest-from-optimal-first ordering for a doc's raw markers, so
// the bounded coach view never drops a concerning marker in favor of a normal one.
// Cheap + null-safe: a lab flag (low/high) is the strongest signal, then distance
// from the optimal band (when we have one), then parse order as the stable tiebreak.
function rankDocMarkers(markers: any[]): any[] {
  const score = (m: any): number => {
    const flag = m?.flag;
    if (flag === "low" || flag === "high") return 1000; // lab-flagged outranks everything
    const z = matchOptimalZone(m?.name);
    if (!z) return 0;
    const v = typeof m?.value === "number" ? m.value : Number(m?.value);
    if (!Number.isFinite(v)) return 0;
    // 0..1 distance from optimal → 0..100, so off-optimal sorts above in-range.
    return optimalDistance(v, z) * 100;
  };
  return markers
    .map((m, i) => ({ m, i, s: score(m) }))
    .sort((a, b) => (b.s !== a.s ? b.s - a.s : a.i - b.i)) // stable on ties (parse order)
    .map((x) => x.m);
}

// The latest whole-picture health review, condensed for the coach: just the
// headline plus the actionable focus/watchlist/followup items — never the raw
// agent output.
function healthReviewForCoach() {
  const r = getLatestHealthReview();
  if (!r || !r.parsed) return null;
  const p = r.parsed;
  return {
    created_at: r.created_at,
    headline: p.headline,
    focus: (Array.isArray(p.focus) ? p.focus : []).map((f: any) => ({ title: f?.title, action: f?.action })),
    watchlist: (Array.isArray(p.watchlist) ? p.watchlist : []).map((w: any) => ({
      marker: w?.marker,
      status: w?.status,
      action: w?.action,
    })),
    followups: Array.isArray(p.followups) ? p.followups : [],
  };
}

function dayIntakeForCoach(date = localDateISO()): CoachDayIntake {
  const d: any = getDayIntake(date);
  const entries = (Array.isArray(d?.entries) ? d.entries : []).slice(0, 12).map((e: any) => ({
    id: e.id,
    meal: e.meal ?? null,
    summary: capStr(e.summary ?? "Food", 160),
    kcal: e.kcal ?? null,
    protein_g: e.protein_g ?? null,
    carbs_g: e.carbs_g ?? null,
    fat_g: e.fat_g ?? null,
    fiber_g: e.fiber_g ?? null,
    nutrition_pattern: e.nutrition_pattern && typeof e.nutrition_pattern === "object" ? e.nutrition_pattern : null,
    eaten_at: e.eaten_at ?? null,
    logged_at: e.logged_at ?? null,
    enrichment_status: e.enrichment_status ?? null,
  }));
  return {
    date: d?.date ?? date,
    count: Number(d?.count) || 0,
    totals: d?.totals ?? { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
    target: d?.target ?? null,
    remaining: d?.remaining ?? null,
    entries,
  };
}

// ---------- deterministic training signals (progression-readiness + autoregulation) ----------
// The coaching prompts ALREADY ask the agent to only progress when recent sessions hit
// the TOP of the rep range at low RIR, and to ease off on soreness/joint flags — but they
// hand it raw `recent_sessions` arrays and make it infer all of that. This does the
// inference DETERMINISTICALLY, so the read is the same whether or not an agent runs and is
// the same every time: per current-plan exercise, is recent performance progress-READY, and
// which way is the est-1RM trending; plus a rolled-up autoregulation flag (high soreness /
// low performance / a named joint) from the last few sessions. SIGNALS ONLY — informational,
// suggestion-not-a-gate: progressive overload and de-loads stay the coach's call, nothing here
// auto-applies. The point is that the athlete's own logged sets + 1-tap feedback VISIBLY shape
// the next recommendation instead of disappearing into a JSON blob the agent may skim past.
export interface ProgressionSignal {
  exercise: string;
  rep_target: string | null; // "8–10" (reps mode) or null for timed
  sec_target: number | null; // timed prescription, when applicable
  last_logged: string | null; // ISO date of the most recent logged session for this lift
  days_since: number | null;
  progress_ready: boolean; // recent working sets met the top target at RIR ≤ 3 (or met the timed hold)
  est_1rm_trend: "up" | "down" | "flat" | null;
  reason: string; // plain-language ("hit 10/10 reps at RIR 2 last session")
}
export interface AutoregSignal {
  soreness_flag: boolean;
  low_performance_flag: boolean;
  // The date of the session each flag is actually about. Downstream these become
  // the observation dates in the signal state, so `age_days` / `max_age_days`
  // describe the athlete's feedback rather than the moment the read was built.
  low_performance_date: string | null;
  soreness_date: string | null;
  joint_date: string | null;
  joint_areas: string[];
  note: string; // one rolled-up plain sentence
}
// The POSITIVE half of the same rollup. AutoregSignal above only ever exists when
// something is wrong, so the read had no way to tell "the athlete rated their last
// session strongly" apart from "the athlete has rated nothing at all" — which is how
// a maximally-supported day and an evidence-less one ended up looking identical to
// the arbitration layer. Emitted only when the FRESHEST rated session is strong and
// no soreness/joint report has landed since; anything less is simply absent.
export interface SessionQualitySignal {
  strong_flag: boolean;
  // The session the claim is about (same honesty rule as the dates above).
  strong_date: string | null;
  rated_sessions: number;
  note: string;
}
// How far back a felt signal counts. Autoregulation feedback is a report on a
// body that changes daily; a rating from a fortnight ago is history, not a signal.
const AUTOREG_WINDOW_DAYS = 7;
// `asOf` is the calendar date these signals are being read FOR. It changes two
// things, and only for a FIXED HISTORICAL date (today and the omitted default stay
// byte-for-byte as before): the sessions fetched are bounded to that day, and the
// "days since" staleness read measures from it. Unbounded, a read of last Tuesday
// was derived from the twenty newest sessions relative to NOW — work that had not
// happened yet — and called every lift stale by today's calendar.
export function trainingSignals(
  recent?: any[],
  asOf?: string
): {
  progression: ProgressionSignal[];
  autoregulation: AutoregSignal | null;
  session_quality: SessionQualitySignal | null;
} {
  const historical = !!asOf && asOf !== localDateISO();
  const sessions = (recent ?? getRecentSessions(20, historical ? { through: asOf } : {})) as any[];
  const now = historical ? Date.parse(`${asOf}T00:00:00Z`) : Date.now();
  const daysAgo = (d: string): number | null => {
    const t = Date.parse(String(d) + "T00:00:00Z");
    return Number.isFinite(t) ? Math.round((now - t) / 864e5) : null;
  };

  // De-dupe the current plan's exercises (a lift can appear on more than one day).
  const seen = new Set<string>();
  const items: any[] = [];
  for (const day of getPlan() as any[]) {
    for (const it of day.items || []) {
      const key = String(it.exercise || "").toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(it);
    }
  }

  const progression: ProgressionSignal[] = items.map((it) => {
    const name = String(it.exercise);
    const lc = name.toLowerCase();
    const timed = it.mode === "timed";
    // The most recent session that logged this exercise (sessions are date-DESC),
    // plus how many recent sessions touched it.
    let latestSets: any[] | null = null;
    let latestDate: string | null = null;
    for (const s of sessions) {
      const mine = (s.sets || []).filter((x: any) => String(x.exercise || "").toLowerCase() === lc);
      if (!mine.length) continue;
      if (!latestSets) {
        latestSets = mine;
        latestDate = s.date;
      }
    }
    const days = latestDate ? daysAgo(latestDate) : null;
    const stale = days != null && days > 14; // a month-old set isn't "ready now"
    let ready = false;
    let reason = "no recent logs — start where the plan sits and log actual.";
    let trend: ProgressionSignal["est_1rm_trend"] = null;

    if (latestSets) {
      if (timed) {
        const target = Number(it.target_seconds) || null;
        const best = latestSets.reduce((m: number, x: any) => Math.max(m, Number(x.duration_sec) || 0), 0);
        ready = !stale && target != null && best >= target;
        reason =
          target != null ? `held ${best}s vs ${target}s target${stale ? " (a while ago)" : ""}` : `held ${best}s`;
      } else {
        const repHigh = Number(it.rep_high) || null;
        const working = latestSets.filter((x: any) => x.reps != null);
        const reps = working.map((x: any) => Number(x.reps) || 0);
        const topReps = reps.length ? Math.max(...reps) : 0;
        const allHit = repHigh != null && reps.length > 0 && reps.every((r) => r >= repHigh);
        const rirs = working
          .map((x: any) => x.rir)
          .filter((r: any) => r != null)
          .map(Number);
        const lowRir = rirs.length === 0 || rirs.every((r) => r <= 3);
        ready = !stale && allHit && lowRir;
        const rirTxt = rirs.length
          ? ` at RIR ${Math.min(...rirs)}${rirs.length > 1 && Math.min(...rirs) !== Math.max(...rirs) ? `–${Math.max(...rirs)}` : ""}`
          : "";
        reason =
          repHigh != null
            ? `${ready ? "hit" : "last"} ${topReps}/${repHigh} reps${rirTxt}${stale ? " (a while ago)" : ""}`
            : `last ${topReps} reps${rirTxt}`;
        // Bounded to the day being read for the same reason the sessions above are:
        // the trend is the last two points, so an unbounded history hands a read of
        // last Tuesday a direction derived from sets logged after it.
        const pts = ((getProgress(name, historical ? { through: asOf } : {}) as any).points || []) as any[];
        if (pts.length >= 2) {
          const a = pts[pts.length - 2].best1rm,
            b = pts[pts.length - 1].best1rm;
          trend = b > a * 1.005 ? "up" : b < a * 0.995 ? "down" : "flat";
        }
      }
    }
    return {
      exercise: name,
      rep_target: timed ? null : it.rep_low != null && it.rep_high != null ? `${it.rep_low}–${it.rep_high}` : null,
      sec_target: timed ? Number(it.target_seconds) || null : null,
      last_logged: latestDate,
      days_since: days,
      progress_ready: ready,
      est_1rm_trend: trend,
      reason,
    };
  });

  // Autoregulation rollup — a single plain-language signal the prompt can act on
  // without re-scanning the raw session array.
  //
  // The window is by DATE, not by session index. Indexed at "the last 4 sessions",
  // a low-performance rating survived until four more sessions were logged — and
  // because the flag itself pushes the read toward rest, the very sessions that
  // would have retired it never happened. A rest read prolonged its own trigger.
  // Sessions carrying no logged work are skipped for the RATED signals too: an
  // opened-and-abandoned row is not a report on how training felt.
  const readDate = asOf ?? localDateISO();
  const windowStart = addDaysISO(readDate, -(AUTOREG_WINDOW_DAYS - 1)) ?? readDate;
  const inWindow = sessions.filter((s) => {
    const d = String(s.date ?? "");
    return d >= windowStart && d <= readDate;
  });
  // `sets` is present on every session from getRecentSessions (both production
  // callers). A caller that hands over a session-shaped object WITHOUT the key at
  // all is not asserting emptiness, so it still counts.
  const carriedWork = (s: any) => (Array.isArray(s.sets) ? s.sets.length > 0 : true);
  // Newest-first, matching getRecentSessions' ORDER BY date DESC, id DESC.
  const ratedPerf = inWindow.filter(carriedWork).filter((s) => s.performance != null);
  const ratedSore = inWindow.filter(carriedWork).filter((s) => s.soreness != null);
  // Recovery evidence CLEARS the flag: the read has to follow the athlete's most
  // recent information. A session that felt strong after a rough one is the
  // athlete telling us the rough one has passed, and it must not keep speaking.
  const clearedByLater = <T>(list: T[], hit: (s: T) => boolean, clears: (s: T) => boolean) => {
    const idx = list.findIndex(hit);
    if (idx < 0) return [] as T[];
    return list.slice(0, idx).some(clears) ? ([] as T[]) : list.filter(hit);
  };
  const soreDays = clearedByLater(
    ratedSore,
    (s) => Number(s.soreness) >= 4,
    (s) => Number(s.soreness) <= 2
  );
  const lowPerfDays = clearedByLater(
    ratedPerf,
    (s) => Number(s.performance) <= 2,
    (s) => Number(s.performance) >= 4
  );
  // An area the athlete has explicitly CLOSED must stop speaking. The raw session
  // notes log what was said, not what is still true, so a joint area whose symptom
  // record is resolved — with no open record left for the same place — drops out.
  // Otherwise "Mark resolved" leaves the Brief warning about it every morning.
  const symptomReadOn = asOf ?? localDateISO();
  let openAreas = new Set<string>();
  let closedAreas = new Set<string>();
  try {
    // seed_legacy:false — this runs inside the signal-state build on the per-set
    // logging hot path, where the guard documents a pure read; the legacy import
    // and its repair pass have plenty of slower-path triggers (panel, primer,
    // reconciliation, unparameterized REST reads).
    const lifecycle = listTrainingSymptoms({ on: symptomReadOn, include_resolved: true, seed_legacy: false });
    openAreas = new Set(
      lifecycle.filter((event) => event.status === "active").map((event) => symptomAreaKey(event.area_text))
    );
    closedAreas = new Set(
      lifecycle.filter((event) => event.status !== "active").map((event) => symptomAreaKey(event.area_text))
    );
  } catch {
    /* the rollup is a plain read — lifecycle trouble must never break it */
  }
  // Joint reports take the same date window but NOT the logged-work filter — a
  // free-text "left knee" is self-evidently content, whatever else the row holds.
  const jointSessions = inWindow.filter((s) => {
    const area = String(s.joint_pain || "").trim();
    if (!area) return false;
    const key = symptomAreaKey(area);
    return !key || openAreas.has(key) || !closedAreas.has(key);
  });
  const joints = [...new Set(jointSessions.map((s) => String(s.joint_pain).trim()))];
  let autoregulation: AutoregSignal | null = null;
  if (soreDays.length || lowPerfDays.length || joints.length) {
    const parts: string[] = [];
    if (soreDays.length) {
      const where = [...new Set(soreDays.map((s) => s.day_name).filter(Boolean))].join(", ");
      parts.push(`high soreness${where ? ` (${where})` : ` across ${soreDays.length} recent session(s)`}`);
    }
    if (lowPerfDays.length) parts.push("lower-than-usual performance recently");
    if (joints.length) parts.push(`flagged joint/area: ${joints.join("; ")}`);
    autoregulation = {
      soreness_flag: soreDays.length > 0,
      low_performance_flag: lowPerfDays.length > 0,
      // Newest offending session in each case — the honest date for the claim.
      low_performance_date: lowPerfDays[0]?.date ? String(lowPerfDays[0].date) : null,
      soreness_date: soreDays[0]?.date ? String(soreDays[0].date) : null,
      joint_date: jointSessions[0]?.date ? String(jointSessions[0].date) : null,
      joint_areas: joints,
      note: `${parts.join("; ")} — ease volume/load there or de-load the movements that load it; a brake, never a penalty.`,
    };
  }

  // The positive rollup, built out of the SAME window and the same
  // recovery-evidence-clears rule, run the other way round: the newest rated
  // session is strong and nothing rougher has been rated since. Because
  // `clearedByLater` looks for anything NEWER that clears the hit, and any rating
  // below 4 clears a "strong" hit, this can only ever be true when the FRESHEST
  // rating is the strong one — which is exactly the claim the note makes.
  //
  // Withheld while soreness or a joint report is live: a strong rating alongside a
  // sore knee is not evidence the day carries room, and the brake owns that case.
  const strongDays = clearedByLater(
    ratedPerf,
    (s) => Number(s.performance) >= 4,
    (s) => Number(s.performance) <= 3
  );
  const sessionQuality: SessionQualitySignal | null =
    strongDays.length && !soreDays.length && !joints.length
      ? {
          strong_flag: true,
          strong_date: strongDays[0]?.date ? String(strongDays[0].date) : null,
          rated_sessions: strongDays.length,
          note: `the ${strongDays.length === 1 ? "most recent rated session came" : "recent rated sessions came"} back strong — the current dose is landing.`,
        }
      : null;
  return { progression, autoregulation, session_quality: sessionQuality };
}

// A BOUNDED view of the deterministic program-state for the coach prompt — the
// load-bearing signal (per-lift status/trend/action + stall tells, the volume
// bands, the mesocycle position + endurance read + the adaptations list) without
// the verbose internals. Keeps the prompt from exploding on a big training log.
function programStateForCoach(st: ProgramState): CoachProgramState {
  return {
    headline: st.headline,
    discipline: st.discipline,
    lifts: (Array.isArray(st.lifts) ? st.lifts : []).slice(0, 14).map((l: any) => ({
      exercise: l.exercise,
      muscle_group: l.muscle_group,
      mode: l.mode,
      status: l.status,
      suggested_action: l.suggested_action,
      trend_per_wk: l.trend_per_wk,
      weeks_static: l.weeks_static,
      stall_signals: l.stall_signals,
      why: l.why,
    })),
    volume: (Array.isArray(st.volume) ? st.volume : []).slice(0, 14),
    mesocycle: st.mesocycle,
    recovery_week: st.recovery_week,
    endurance: st.endurance,
    hybrid: st.hybrid,
    adaptations_due: (Array.isArray(st.adaptations_due) ? st.adaptations_due : []).slice(0, 6),
  };
}

// Resolve the plan day number that today's read points at, so the progression
// digest reflects the NEXT/active session. Match the cached/computed day-read's
// focus to a plan day; fall back to the first plan day. Cardio-only plan days
// have no strength progression, so the consumer simply gets [].
function nextPlanDayNumber(read: any): number | null {
  const days = db.prepare(`SELECT day_number, name, focus FROM plan_days ORDER BY day_number`).all() as any[];
  if (!days.length) return null;
  const focus = read?.focus ? String(read.focus).toLowerCase().trim() : null;
  if (focus) {
    const hit = days.find((d) => {
      const f = String(d.focus || d.name || "")
        .toLowerCase()
        .trim();
      return f && (f === focus || f.includes(focus) || focus.includes(f));
    });
    if (hit) return hit.day_number;
  }
  return days[0].day_number;
}

// ---------- per-domain assemblers for getCoachContext ----------
// getCoachContext computes a handful of EXPENSIVE signals exactly once (the Garmin
// summary + unified recovery, the day-read, the deterministic program-state snapshot,
// the volume balance / acute load, and the CONDUCTOR's per-domain reads) and threads
// them into several context keys. To keep that compute-once discipline while splitting
// the ~50-key assembly into cohesive per-domain slices, the ORCHESTRATOR does all the
// shared computation and passes the results in here via `signals` — no slice re-derives
// a shared value (that would both regress performance and risk a different read). Each
// builder returns its slice of the context; the orchestrator spreads them together.
interface CoachContextSignals {
  today: string;
  profile: any;
  locationView: any;
  trainingIntentView: any;
  enduranceCapacityView: any;
  garmin: any;
  recovery: any;
  recentSessions: any[];
  dayReadView: any;
  programBal: any;
  recentLoad: any;
  acuteLoad: any;
  fullProgramState: ProgramState;
  strengthJourneyView: any;
  runZonesView: any;
  runPlanView: any;
  weekLayoutView: any;
  flexibleTrainingAgendaView: any;
  dexaTargetingView: any;
  testWeekView: any;
  healthFocusView: any;
  performanceView: any;
  programAdjustmentsView: any;
  groupsTrajectoryView: any;
  runVarietyView: any;
  enduranceTestsView: any;
  hrModelView: any;
  calibrationView: any;
  trajectoryView: any;
  wholePersonTrajectoryView: any;
  journeyView: any;
  expenditureView: any;
  underfuelingView: any;
  cutQualityView: any;
  coachingFocusView: any;
  signalStateView: UnifiedSignalState;
  bodyCompositionView: any;
  // Computed once + shared: the active life-context effect, the training-signals
  // rollup, and the active context events (so buildPersonSlice/buildTrainingSlice and
  // the conductor all read the same values without recomputing).
  contextTodayView: any;
  trainingSignalsView: any;
  contextEventsView: any[];
}

// Identity / person model: who the athlete is, what the coach remembers, the people
// and life-context it plans around. Cheap per-key reads; `profile` is threaded in.
function buildPersonSlice(
  signals: CoachContextSignals
): Pick<
  CoachContext,
  | "now"
  | "profile"
  | "location"
  | "discipline"
  | "training_intent"
  | "memory"
  | "learnings"
  | "context_events"
  | "family"
  | "checkins"
  | "reaction_model"
  | "felt_signals"
  | "learned_models"
  | "what_works_for_you"
  | "context_today"
  | "typical_training_hour"
  | "recent_context_tags"
> {
  const { profile, locationView, trainingIntentView, contextEventsView, contextTodayView } = signals;
  return {
    // The current LOCAL clock (date + weekday + time + part-of-day). Folded in so
    // EVERY plan-shaping prompt knows the time of day — without it the agent is
    // temporally blind (it would ask about "last night's dinner" at 5 PM). The
    // chat/day-read prompts also surface it as an explicit "RIGHT NOW" line.
    now: nowContext(),
    profile,
    // Compact, deterministic planning context only: home is the durable base;
    // an active dated trip may temporarily override effective. No weather is
    // fetched or inferred, and location never gates the athlete's choices.
    location: locationView,
    // Top-level discipline echo (v35) so every plan-shaping prompt can branch its
    // framing without digging into profile. Defaults to 'strength' (today's
    // behavior); endurance/hybrid make endurance progression a first-class driver.
    discipline: {
      primary: (profile?.primary_discipline as string) || "strength",
      endurance_sport: profile?.endurance_sport ?? null,
    },
    // Ordered durable goals supersede the old assumption that "hybrid" means every
    // modality is co-equal. Legacy profiles receive a derived compatible view.
    training_intent: trainingIntentView,
    // Ranked retrieval (Stream 2): always the load-bearing person-model
    // (constraints/injuries/preferences/decisions) + recent observations, with
    // superseded rows hidden. Replaces the raw recency dump and stamps
    // last_referenced_at so consolidation can tell live facts from stale ones.
    memory: memoryForCoach(40),
    // Durable learnings drawn from suggestion → actual reconciliation (e.g.
    // "tolerates higher frequency than the read assumed"). Suggestion-not-a-gate:
    // these inform tone/defaults, never enforce.
    learnings: recentLearnings(6),
    context_events: contextEventsView, // active life-context (computed once)
    family: listFamily(), // family roster the coach plans around
    checkins: listCheckins(7), // optional subjective morning check-ins
    // How THIS athlete actually reacts, learned from their own logged history (deficit→
    // weight rate, hs-CRP↔training-load, late-event→sleep, adherence, a data-gap signal so
    // the coach never fabricates recovery). The personalization spine every brain reads.
    reaction_model: reactionModelForCoach(),
    // Learned from the athlete's OWN subjective felt signals: recurring Brief
    // overrides (a weekday that keeps ending up rest), persistent morning check-in
    // reads (energy running low), and post-target fueling follow-through. Calm,
    // adherence-neutral, a suggestion never a gate — surfaces at most a couple of
    // humble lines, and nothing at all on sparse data.
    felt_signals: feltSignalsForCoach(),
    // Learned CROSS-DOMAIN coincidences the rule layers can't close: whether bigger
    // running weeks dent this athlete's lower-body lifting, and whether short nights
    // run their hunger up. Calm, humble, adherence-neutral; nothing on sparse data.
    learned_models: learnedModelsForCoach(),
    // Outcomes earned from the decision -> expectation -> evaluation ledger. Null
    // until repeated clean evidence exists, so an empty ledger preserves today's
    // coaching defaults exactly.
    what_works_for_you: whatWorksForYou(),
    // Active life-context effect (a late concert / travel / illness mentioned once) →
    // expect worse sleep / a transient inflammation bump (don't alarm) / plan around it.
    context_today: contextTodayView,
    // The most common hour recent sessions were logged, so chat can answer "when do
    // you usually train?" from data instead of asking. Null on thin history.
    typical_training_hour: typicalTrainingHour(),
    // Cheap volunteered context tags over the last 30 days (travel/drinks/rough sleep/
    // work crunch/feeling off) — evidence for the insight generator's search, never
    // advice. Null when nothing's been tagged, so a quiet history serializes as before.
    recent_context_tags: (() => {
      let tags: ReturnType<typeof recentContextTags> = [];
      try {
        tags = recentContextTags(30);
      } catch {
        tags = [];
      }
      return tags.length ? tags : null;
    })(),
  };
}

// Nutrition goal + today's fuel. Both goal reads reuse the already-fetched profile.
function buildNutritionSlice(
  signals: CoachContextSignals
): Pick<
  CoachContext,
  | "goal"
  | "goal_mode"
  | "journey"
  | "day_intake"
  | "meal_plan"
  | "fueling"
  | "underfueling"
  | "cut_quality"
  | "fuel_demand"
> {
  const { profile, journeyView, expenditureView, underfuelingView, cutQualityView, today, runPlanView, flexibleTrainingAgendaView } =
    signals;
  return {
    goal: computeGoalCheck(profile, { expenditure: expenditureView }), // reuse profile + expenditure already fetched above
    // The journey's SHAPE (v41) — lose | maintain | gain. Always present (even when
    // the profile is too thin for goal math), so every prompt and the PWA agree on
    // the framing: a deficit for 'lose', anchor-to-TDEE for 'maintain', a lean
    // surplus for 'gain'. Drives renderGoalMode and the fuel-card target.
    goal_mode: effectiveGoalMode(profile),
    // Body-composition journey read: active/proposed phase, transition suggestion,
    // leanness-aware rate, and calm milestones. Computed once and exposed to prompts
    // as context only; suggestions/phases never auto-apply.
    journey: journeyView,
    // Today's persisted food log. This is independent of the live chat thread, so
    // a breakfast logged before "Fresh start" still shapes the next nutrition turn.
    day_intake: dayIntakeForCoach(),
    // A bounded view of the current meal plan (today's + tomorrow's meals + the daily
    // targets + a freshness flag) so chat / the day-read / insights can reference the
    // ACTUAL planned food instead of being blind to it. Null when there's no live plan.
    meal_plan: (() => {
      try {
        return mealPlanForCoach();
      } catch {
        return null;
      }
    })(),
    // Recent one-tap fueling reads (bounded) — the subjective follow-through after a
    // nutrition-target change, so chat/coach can echo how fueling has felt since the
    // change and the adaptive check-in can weigh it. Empty array when nothing's logged.
    fueling: listFuelingFeedback(14).map((row: any) => ({
      date: row.date,
      energy: row.energy,
      hunger: row.hunger,
      note: row.note,
      decision_id: row.decision_id,
    })),
    // Shared deterministic control read: completed days only, multiple independent
    // channels, explicit uncertainty/deadband, and no single-day calorie reaction.
    underfueling: underfuelingView,
    // Goal-aware complement: during an active cut (losing), is strength holding while
    // the weight comes down? { active:false } off a cut. Adherence-neutral; no score.
    cut_quality: cutQualityView,
    // Which of the coming seven days carry the biggest work, so the week's food can
    // be periodized to the week's training instead of one flat number landing on a
    // long-run day and a rest day alike. Forward-looking only — it never grades a day
    // that has already happened — and it never moves an accepted calorie target.
    fuel_demand: brainSignal(`fuel_demand:${today}`, () => {
      try {
        return fuelDemandWeek(undefined, undefined, { runPlan: runPlanView, agenda: flexibleTrainingAgendaView });
      } catch {
        return null;
      }
    }),
  };
}

// The training brain: plan/sessions, the deterministic program-state read, capacity /
// balance / adjustments, and the DEXA-driven targeting. Reuses the precomputed
// program-state, recovery, balance, acute load, day-read and conductor domain reads.
function buildTrainingSlice(
  signals: CoachContextSignals
): Pick<
  CoachContext,
  | "plan"
  | "recent_sessions"
  | "recent_activities"
  | "training_signals"
  | "garmin"
  | "program_block"
  | "program_state"
  | "performance"
  | "program_balance"
  | "recent_load"
  | "acute_gates"
  | "progression"
  | "strength_journey"
  | "program_adjustments"
  | "groups_trajectory"
  | "test_week"
  | "dexa_targeting"
  | "trajectory"
> {
  const {
    today,
    garmin,
    recentSessions,
    dayReadView,
    programBal,
    recentLoad,
    acuteLoad,
    fullProgramState,
    strengthJourneyView,
    performanceView,
    programAdjustmentsView,
    groupsTrajectoryView,
    testWeekView,
    dexaTargetingView,
    trajectoryView,
    trainingSignalsView,
  } = signals;
  return {
    plan: getPlan(),
    recent_sessions: recentSessions,
    recent_activities: listActivities(15),
    // Deterministic progression-readiness + autoregulation rollup computed from the
    // athlete's own recent sets + 1-tap feedback — so logged performance VISIBLY
    // steers the next recommendation instead of being inferred from a raw array.
    // Computed once (shared with the conductor's life/soreness awareness).
    training_signals: trainingSignalsView,
    garmin,
    // Active periodization block (goal / phase / week N of M) so the coach
    // periodizes against the current mesocycle instead of progressing blindly.
    // Null when no block is running — then the deterministic mesocycle read in
    // program-state still gives deload timing. Additive, never a gate.
    program_block: blockForCoach(today),
    // The elite program brain (deterministic floor): per-lift status/trend +
    // stall detection, volume bands, mesocycle position, endurance trends, and
    // the "what to evolve next" list — so EVERY plan-shaping prompt sees the
    // program's actual trajectory, not just raw sessions. Bounded; no scores.
    program_state: programStateForCoach(fullProgramState),
    // The TRAINING-INTELLIGENCE read (capacity, not just trajectory): where each
    // benchmark lift sits as a sex/age percentile against proven strength standards,
    // VO2max-for-age, the strength IMBALANCES, the single biggest lever, lifts worth
    // re-TESTING, and a variety nudge. So the coach measures WHERE THE ATHLETE STANDS
    // and balances development — not just whether last week went up. Reuses the same
    // program-state + recovery + balance computed above. Percentile/level framing
    // (the recognized reference reads the athlete asked to keep), never a 0-100 score.
    performance: performanceView,
    // Volume balance per canonical muscle group over the last 2 weeks (bands +
    // which groups are DUE / running HIGH, in plain words). Mobility excluded.
    program_balance: programBal,
    // ACUTE recovery: which muscle groups got hammered in the last day or two —
    // folding ENDURANCE (a long ride/run never touches logged_sets) in with recent
    // strength. Lets the coach plan AROUND smoked muscles instead of recommending a
    // group the athlete just torched. Plain words, no score.
    recent_load: [...recentLoad.values()],
    // The gate, not the recency window: groups the coach must plan AROUND today,
    // including ones last loaded outside the two-day `recent_load` list. Residual
    // is stripped — INTERNAL, never rendered.
    acute_gates: [...(acuteLoad as Map<string, AcuteGateReading>).values()]
      .filter((g) => g.saturated)
      .map(({ residual: _residual, ...rest }) => rest),
    // The next session's auto-progression — the adapted target per strength lift
    // on the day this read points at ("+5 lb", "hold 50 — stalled", "−10%"), so
    // the plan visibly FOLLOWS what was logged. Bounded to the active day. [] when
    // there's no plan day / it's a cardio day.
    progression: (() => {
      const dn = nextPlanDayNumber(dayReadView);
      return dn == null ? [] : planDayProgression(dn).slice(0, 12);
    })(),
    // One athlete-selected anchor lift and the deterministic path back to it. The
    // read owns exact-exercise history, safety gates and projection eligibility;
    // recovery/signal-state still outrank it in every plan-shaping prompt.
    strength_journey: strengthJourneyView,
    // The calm "what changed & why" digest — the handful of concrete adaptations
    // due right now (lifts to push/hold/deload, groups due, missing-pattern gaps).
    program_adjustments: programAdjustmentsView,
    // ---- per-muscle-group advance/stall + cadenced strength test week ----
    // The athlete's own mental model: which canonical groups are advancing vs
    // stalling, with a vary-options menu for the stalled ones. Reuses program_state.
    groups_trajectory: groupsTrajectoryView,
    // Is a cadenced strength test week due (block realization phase / ~7-week
    // cadence)? Names the benchmark lifts to re-test. due:false for a new athlete.
    test_week: testWeekView,
    // ---- DEXA-driven targeting (the body scan → training + nutrition targets) ----
    // Maps the regional read (lean asymmetry, low ALMI/FFMI, low BMD, visceral fat)
    // to concrete muscle-group biases + moves + a "path to the next scan", and one
    // nutrition target (visceral/central fat → Z2 + lean-safe deficit). {available:false}
    // with no DEXA. healthStanding() is read lazily inside (computed once).
    dexa_targeting: dexaTargetingView,
    // One periodized arc to the goals, with today framed as the next step on it (null line
    // when there's no goal/block/race). So coaching is forward-looking, not just "today".
    trajectory: trajectoryView,
  };
}

// The running brain (the endurance counterpart to the program-state read): the goal,
// compliance, HR-zone bands and this week's periodized mix. Reuses the precomputed
// zones / plan / variety / test reads built once from the shared recovery+state+block.
function buildRunningSlice(
  signals: CoachContextSignals
): Pick<
  CoachContext,
  | "endurance_goal"
  | "endurance_capacity"
  | "run_compliance"
  | "run_zones"
  | "run_plan"
  | "week_layout"
  | "flexible_training_agenda"
  | "run_variety"
  | "endurance_tests"
  | "hr_model"
  | "calibration"
> {
  const {
    enduranceCapacityView,
    runZonesView,
    runPlanView,
    weekLayoutView,
    flexibleTrainingAgendaView,
    runVarietyView,
    enduranceTestsView,
    hrModelView,
    calibrationView,
  } = signals;
  return {
    // The endurance OBJECTIVE (v37) — race (dated, periodized + taper) or standing
    // (no date, maintain readiness), with race timing/phase pre-computed. Null when
    // unset. Orthogonal to discipline: a strength-first athlete can hold a standing
    // running goal ("running on the side"). The coach prescribes runs accordingly.
    endurance_goal: getEnduranceGoal(),
    // Standing duration capability read from matching logged outings. Observational
    // only: it never mutates the plan and is null when endurance has no role/target.
    endurance_capacity: enduranceCapacityView,
    // Runner loop (closing): prescribed plan cardio vs this week's logged efforts,
    // in plain words ("32 of 40 km this week") — so the coach can speak to run
    // adherence the way week_done/week_planned covers lifting. Never a 0-100 score.
    // Vouched: an applied plan that cannot speak for THIS week hands the prompt no
    // prescription at all rather than a fossil, so renderRunCompliance's shortfall
    // read stays "unknown" and the coach is never told the athlete came up short
    // against a target nobody set for this week. (The composed live-plan fallback,
    // runComplianceRead, is a domain-layer read — repo/coach.ts cannot import it
    // without a cycle: run-compliance-read → run-progression → coach.)
    run_compliance: vouchedRunCompliance(),
    // The athlete's real HR-zone bpm bands (max-HR + resting HR) so runs are
    // prescribed to an actual pulse, not a vague effort. {available:false} with no
    // age AND no Garmin HR.
    run_zones: runZonesView,
    // This week's periodized run mix (N easy Z2 + 1 long + 1 rotated quality), each
    // with a bpm-bearing zone + interval structure. Reuses the recovery/programState/
    // block/zones already computed so nothing recomputes. {available:false} for a
    // pure strength athlete with no running.
    run_plan: runPlanView,
    // Whether the two lanes' big days sit on top of each other: the heaviest lower
    // day against the long/quality run, plus any three-hard-days-in-a-row stretch,
    // with the smallest STRENGTH move that would clear it. The run engine already
    // places its runs around the planned statics; this is the other half of that
    // conversation, and the plan-shaping prompts get it as data rather than as a
    // rule they are asked to remember. `clean:true` for a week with nothing to stack.
    week_layout: weekLayoutView,
    // A rolling reconciliation of the provisional run slots against what was
    // actually logged. Calendar anchors remain compatible with the stored plan,
    // but completion and the next clean opening follow reality.
    flexible_training_agenda: flexibleTrainingAgendaView,
    // Mono-stimulus running flag (all-easy / one-distance-on-repeat) → the missing
    // stimulus. null when there's not enough running to read variety honestly.
    run_variety: runVarietyView,
    // Running re-tests (no hard effort in ~4 weeks → a time-trial; a stale VO2max
    // reading → a max-effort run). [] for a non-runner.
    endurance_tests: enduranceTestsView,
    // THE PERSONAL HR MODEL — derived zone bands, the threshold they hang off,
    // and how that threshold was arrived at (a detected field test, the best
    // sustained effort, or the observed-max floor). run_zones above is the
    // legacy max-HR/resting read; this is the one that knows what a pulse means
    // for THIS athlete. `available:false` until there is enough logged HR.
    hr_model: hrModelView,
    // Tests worth suggesting, and what was recently anchored. Already filtered
    // to "stale AND actually steering a decision" — a prompt reading it is
    // reading a coach's opening, not a to-do list, and it gates nothing.
    calibration: calibrationView,
  };
}

// The health / connected-brain slice: bounded lab summaries, cross-domain directives,
// the tiered focus, symptom links, the synthesis narrative, and the unified recovery
// view (threaded in — the same recovery the day-read/program-state already read).
function buildHealthSlice(
  signals: CoachContextSignals
): Pick<
  CoachContext,
  | "health"
  | "imaging"
  | "health_review"
  | "directives"
  | "health_focus"
  | "symptom_links"
  | "health_synthesis"
  | "directive_feedback"
  | "recovery"
  | "body_composition"
  | "supplements"
> {
  const { recovery, healthFocusView, bodyCompositionView } = signals;
  return {
    health: healthForCoach(),
    // A compact study index plus a bounded detailed recent slice. Imaging stays
    // separate from lab summaries so measurements never enter marker reasoning.
    imaging: imagingForCoach(),
    health_review: healthReviewForCoach(),
    directives: directivesForCoach(), // cross-domain consequences of flagged findings (condensed, bounded)
    health_focus: healthFocusView, // the TIERED, deduped priorities (act-now/track) — so coaching leads with what matters most, not a flat directive flood
    symptom_links: (() => {
      try {
        return symptomMarkerLinks();
      } catch {
        return [];
      }
    })(), // symptom the athlete noted ↔ an out-of-range marker — informational "mention to your doctor" connections
    // Prompts must never reason from a narrative whose source picture has moved.
    // The raw stale artifact remains available through the synthesis read route
    // for history/provenance, but current coaching receives null until refreshed.
    health_synthesis: (() => {
      const view = getHealthSynthesisView();
      return view.stale ? null : view.synthesis;
    })(),
    directive_feedback: directiveFeedbackForCoach(), // Done/Dismiss memory so the coach avoids stale repeats
    recovery, // unified Garmin + Apple/other recovery view
    body_composition: bodyCompositionView, // DEXA anchor + current-weight projection, with dates
    supplements: supplementsForCoach(), // understood supplement regimen (markers/protein it touches)
  };
}

// The brain slice: the CONDUCTOR's single sequenced focus, the day-read Brief, recent
// quiet insights, and the one highest-leverage next step. Conductor + day-read are
// threaded in (computed once); insights + next-step are cheap per-key reads.
function buildBrainSlice(
  signals: CoachContextSignals
): Pick<
  CoachContext,
  | "coaching_focus"
  | "signal_state"
  | "day_read"
  | "insights"
  | "next_step"
  | "read_adherence"
  | "recent_decisions"
  | "whole_person_trajectory"
  | "tomorrow_holds"
> {
  const { today, coachingFocusView, signalStateView, dayReadView, wholePersonTrajectoryView } = signals;
  return {
    // THE CONDUCTOR — the single sequenced WHOLE-ATHLETE focus (lead + parallel +
    // later + connections + one batched retest) arbitrated across training, running,
    // DEXA, health, nutrition and recovery. The brain leads with this; the rest is
    // evidence, not a checklist.
    coaching_focus: coachingFocusView,
    // One deterministic planning state shared by the Brief and every downstream
    // prompt. Independent dimensions retain evidence/conflicts; only the final
    // posture is unified.
    signal_state: signalStateView,
    // What TOMORROW already holds, resolved by the same predicate the deterministic
    // day-read rule uses AND over the same rows. The raw events have always been in
    // `context_events`, which is exactly why the agent could see an appointment the
    // Brief's own rules could not — so what ships here is the ANSWER, not a second copy
    // of the list: one question, one predicate, one shared result.
    //
    // `planningContextEvents` rather than the person slice's active list, because that
    // list is filtered against TODAY: an event that resolves or ends tomorrow survives
    // `resolved_at > today` and would be reported here as a hold, while the rule's own
    // tomorrow arm asks `resolved_at > tomorrow` and correctly reads the day as open.
    // Two filters is two answers, which is the drift the shared predicate exists to
    // prevent. Null on an ordinary day, so a morning with nothing on the calendar
    // tomorrow serializes exactly as before.
    tomorrow_holds: (() => {
      const tomorrow = addDaysISO(today, 1);
      let holds: ReturnType<typeof tomorrowHolds> = [];
      try {
        holds = tomorrowHolds(today, planningContextEvents(today));
      } catch {
        holds = [];
      }
      return tomorrow && holds.length ? { date: tomorrow, events: holds } : null;
    })(),
    // The standing cross-domain objective: what improved, what is deliberately
    // parked for this phase, and whether an unexplained regression requires a
    // revision. Weekly reads receive this directly instead of rediscovering it.
    whole_person_trajectory: wholePersonTrajectoryView,
    // The persisted read carries the agentic sentence AND the athlete's steer
    // ("rough night" / "easy day") so chat/coach/meals echo the Brief the user is
    // actually looking at; the deterministic floor backs it when nothing's cached.
    // Keyed by the server's LOCAL date to match the day_reads cache (saveDayRead).
    day_read: dayReadView,
    // Recent quiet cross-domain insights (bounded) so the chat/coach brain can
    // reference and build on connections it has already surfaced — closing the
    // "one brain" loop instead of re-deriving them each turn.
    insights: listVisibleInsights(5).map((i: any) => ({
      text: i.text,
      kind: i.kind,
      rationale: i.rationale,
      next_step: i.next_step,
    })),
    // The single highest-leverage next action across all domains (or null on a quiet day).
    next_step: nextBestStep(),
    // How often each read is actually followed (counts, never a rate or a grade —
    // see CoachContextEnvelope.read_adherence). Memoized per context build; it walks
    // a rolling window of closed days, so it must not be recomputed per consumer.
    read_adherence: brainSignal("read_adherence", () => {
      try {
        return readAdherenceModel() as unknown as Record<string, unknown>;
      } catch {
        return null;
      }
    }),
    recent_decisions: listBrainDecisions({ limit: 12 }).map((decision) => {
      const latestVerdict = listBrainExpectations({ decisionId: decision.id!, limit: 12 })
        .map((expectation) => latestBrainEvaluation(expectation.id!))
        .filter(Boolean)
        .sort((a: any, b: any) => String(b.evaluated_at ?? "").localeCompare(String(a.evaluated_at ?? "")))[0] as any;
      return {
        id: decision.id,
        created_at: decision.created_at,
        effective_date: decision.effective_date,
        kind: decision.kind,
        domain: decision.domain,
        summary: decision.summary,
        rationale: decision.rationale,
        status: decision.status,
        autonomy_tier: decision.autonomy_tier,
        reversible: decision.reversible,
        latest_outcome: latestVerdict
          ? {
              verdict: latestVerdict.verdict,
              explanation: latestVerdict.explanation,
              evaluated_at: latestVerdict.evaluated_at,
            }
          : null,
      };
    }),
  };
}

export function getCoachContext(): CoachContext {
  return runWithBrainSnapshot(() => getCoachContextFromSnapshot());
}

function getCoachContextFromSnapshot(): CoachContext {
  const today = brainSignal("today", () => localDateISO());
  // Compute the Garmin summary and the unified recovery view ONCE, then thread
  // them through the recovery + day_read keys so a single context build doesn't
  // fan out into getGarminCoachSummary three times.
  const garmin = brainSignal("garmin:coach:14", () => getGarminCoachSummary(14));
  const recovery = brainSignal("recovery:14", () => getRecoverySummary(14, garmin));
  const recentSessions = brainSignal("recent_sessions:20", () => getRecentSessions(20));
  const profile = brainSignal("profile", () => getProfile() as any);
  const locationView = brainSignal(`location:${today}`, () => getLocationContext({ on: today, profile }));
  const trainingIntentView = brainSignal("training_intent", () => getTrainingIntent(profile));
  const enduranceCapacityView = brainSignal(`endurance_capacity:${today}`, () =>
    getEnduranceCapacity(trainingIntentView, { asOf: today })
  );
  // Compute the volume balance + acute load ONCE and thread them into
  // programAdjustments — which would otherwise recompute both from scratch.
  const programBal = brainSignal(`program_balance:2:${today}`, () => programBalance(2, today));
  const recentLoad = brainSignal(`recent_load:2:${today}`, () => recentMuscleLoad(2, today));
  // The acute gate, read once. `recentLoad` above stays the DESCRIPTIVE recency
  // list the coach context renders ("what you trained lately"); this is the
  // DECISION input, and it looks back over the residual's own window rather than
  // a flat two days.
  const acuteLoad = brainSignal(`acute_gates:${today}`, () => acuteGates(today));
  // Compute the deterministic program-state ONCE and share it: the bounded coach
  // view AND the performance/capacity read both read from the same snapshot (and
  // the same recovery), so a single context build never computes program-state twice.
  const fullProgramState = brainSignal("program_state", () => getProgramState(undefined, recovery));
  const strengthJourneyView = brainSignal("strength_journey", () => {
    try {
      return getStrengthJourney({ programState: fullProgramState });
    } catch {
      return null;
    }
  });
  // The active periodization block, computed ONCE and threaded into the run plan +
  // the test-week cadence so neither re-reads it.
  const activeBlock = brainSignal("program_block:active", () => getActiveBlock());
  // Running brain (the endurance counterpart to program_state/performance): real
  // HR-zone bpm bands + this week's deterministic periodized run mix, both computed
  // ONCE from the recovery/programState/block already built above so nothing recomputes.
  const runZonesView = brainSignal("run_zones", () => {
    try {
      return runZones({ profile, recovery });
    } catch {
      return null;
    }
  });
  // Compute the run plan / DEXA targeting / test-week ONCE here, so both the context
  // keys below AND the programAdjustments digest reuse them (no double compute —
  // dexaTargeting reads healthStanding(), the heaviest of the three).
  const runPlanView = brainSignal(`run_plan:${today}`, () => {
    try {
      return weeklyRunPlan(today, {
        programState: fullProgramState,
        recovery,
        block: activeBlock,
        zones: runZonesView ?? undefined,
        trainingIntent: trainingIntentView,
      });
    } catch {
      return null;
    }
  });
  const flexibleTrainingAgendaView = brainSignal(`flexible_training_agenda:${today}`, () => {
    try {
      return flexibleTrainingAgenda(today, { runPlan: runPlanView });
    } catch {
      return null;
    }
  });
  // Reads the STORED plan first and only falls back to these two, so it costs nothing
  // extra — both were already computed above.
  const weekLayoutView = brainSignal(`week_layout:${today}`, () => {
    try {
      return weekLayoutRead(today, { runPlan: runPlanView, agenda: flexibleTrainingAgendaView });
    } catch {
      return null;
    }
  });
  const dexaTargetingView = brainSignal("dexa_targeting", () => {
    try {
      return dexaTargeting({ profile });
    } catch {
      return { available: false, targets: [], lead: null, next_dexa_focus: null };
    }
  });
  const testWeekView = brainSignal(`test_week:${today}`, () => {
    try {
      return testWeekDue(today, { programState: fullProgramState, block: activeBlock });
    } catch {
      return null;
    }
  });
  // Hoist the domain reads the CONDUCTOR arbitrates so they're computed ONCE here and
  // shared by both the context keys below and coachingFocus() (no double compute).
  const healthFocusView = brainSignal("health_focus", () => healthFocus());
  const bodyCompositionView = brainSignal(`body_composition:${today}`, () => {
    try {
      const priority = prioritizeMarkers();
      const weights = listWeight(1) as any[];
      const latestWeight = Array.isArray(weights) && weights.length ? weights[weights.length - 1] : null;
      const asOf = latestWeight?.date ? String(latestWeight.date).slice(0, 10) : today;
      return bodyCompositionRead(
        Array.isArray(priority?.markers) ? priority.markers : [],
        profile?.weight_lb ?? null,
        asOf
      );
    } catch {
      return null;
    }
  });
  const performanceView = brainSignal(`performance:${today}`, () =>
    performanceStanding(today, { programState: fullProgramState, recovery, balance: programBal })
  );
  const programAdjustmentsView = brainSignal(`program_adjustments:${today}`, () =>
    programAdjustments(programBal, acuteLoad, {
      runPlan: runPlanView,
      dexa: dexaTargetingView,
      testWeek: testWeekView,
    }).slice(0, 6)
  );
  // Exercise rotations the brain/athlete already applied (≤21 days). Shared by the
  // muscle-group trajectory (so a just-rotated-out lift is kept out of the vary menu)
  // AND the conductor (so a handled plateau reads as a new stimulus, not a fresh ask).
  const recentRotationsView = brainSignal("recent_rotations:21", () => {
    try {
      return recentAppliedRotations(21);
    } catch {
      return [];
    }
  });
  const groupsTrajectoryView = brainSignal(`groups_trajectory:${today}`, () => {
    try {
      return muscleGroupTrajectory(today, { programState: fullProgramState, recentRotations: recentRotationsView });
    } catch {
      return null;
    }
  });
  const runVarietyView = brainSignal(`run_variety:${today}`, () => {
    try {
      return runVarietyRead(today);
    } catch {
      return null;
    }
  });
  const enduranceTestsView = brainSignal(`endurance_tests:${today}`, () => {
    try {
      return enduranceTestsDue(today);
    } catch {
      return [];
    }
  });
  // The personal HR model + the calibration ladder that keeps it honest. Both are
  // deterministic reads over logged work and the calibration ledger; neither
  // derives or persists here (the nightly tick and the sync path own that), so a
  // context build never writes.
  const hrModelView = brainSignal(`hr_model:${today}`, () => {
    try {
      return hrModelForCoach(today);
    } catch {
      return null;
    }
  });
  const calibrationView = brainSignal(`calibration:${today}`, () => {
    try {
      return calibrationForCoach(today);
    } catch {
      return null;
    }
  });
  const trajectoryView = brainSignal("trajectory", () => getTrajectory(undefined, { programState: fullProgramState }));
  const wholePersonTrajectoryView = brainSignal("whole_person_trajectory", () => wholePersonTrajectory());
  const expenditureView = brainSignal("expenditure:21", () => {
    try {
      return estimateExpenditure(21);
    } catch {
      return null;
    }
  });
  const journeyView = brainSignal(`journey:${today}`, () =>
    journeyRead(today, {
      programState: fullProgramState,
      wholePerson: wholePersonTrajectoryView,
      expenditure: expenditureView,
    })
  );
  const underfuelingView = brainSignal(`underfueling:${today}`, () =>
    currentUnderfuelingRead(today, {
      expenditure: expenditureView,
      goal: computeGoalCheck(profile, { expenditure: expenditureView }),
      programState: fullProgramState,
      wholePerson: wholePersonTrajectoryView,
    })
  );
  // Goal-aware cut-quality read — reuses the shared expenditure / goal / program-state
  // so it never recomputes. Active only during a genuine weight-loss phase.
  const cutQualityView = brainSignal(`cut_quality:${today}`, () =>
    cutQualityRead(today, {
      expenditure: expenditureView,
      goal: computeGoalCheck(profile, { expenditure: expenditureView }),
      programState: fullProgramState,
    })
  );
  // The active life-context effect, the training-signals rollup and the active context
  // events, computed ONCE and shared by the person/training slices AND the conductor
  // (life/soreness awareness) so nothing recomputes them.
  const contextTodayView = brainSignal("context_today", () => {
    try {
      return activeContextEffect();
    } catch {
      return { active: [], any: false, reduce_load: false, resolve_candidates: [] };
    }
  });
  const trainingSignalsView = brainSignal("training_signals", () => trainingSignals(recentSessions));
  const contextEventsView = brainSignal("context_events:active", () => {
    try {
      return listContextEvents({ activeOnly: true }) as any[];
    } catch {
      return [];
    }
  });
  const todayLoadView = brainSignal(`today_load:${today}`, () =>
    dayLoad(today, {
      countsCardio: trainingIntentView.endurance_role !== "none",
      recoveryWeekActive: !!activeRecoveryWeek(today),
    })
  );
  // ONE unified signal state per (date, request) — the shared builder, not a
  // second local call. dayRead()'s own fallback goes through the same function
  // under the same brain-snapshot key, so the coach context and the athlete-facing
  // Brief can no longer be computed from differently-shaped inputs (they were: the
  // Brief's copy omitted trainingSignals + programState and so never saw joint
  // pain, the low-performance flag or a due deload). The views already computed
  // above are threaded in so nothing recomputes.
  const signalStateView = dayPlanningSignalState(today, {
    recovery,
    checkin: getCheckinByDate(today),
    trainingSignals: trainingSignalsView,
    programState: fullProgramState,
    expenditure: expenditureView,
    underfueling: underfuelingView,
    context: contextTodayView,
    contextEvents: contextEventsView,
    completedToday: todayLoadView === "hard" || todayLoadView === "moderate",
  });
  // The prose cache is an accelerator, not a second brain. Reattach today's
  // canonical state even when the sentence came from an earlier warm so every
  // prompt and deterministic planner sees one posture.
  const dayReadView = brainSignal(`day_read:${today}`, () => {
    const read = getCachedDayRead(today) ?? dayRead(today, recovery, signalStateView, underfuelingView);
    return { ...read, signals: { ...(read?.signals ?? {}), signal_state: signalStateView } };
  });
  // External producer reads the CONDUCTOR arbitrates (K3), computed once here and
  // threaded in so coachingFocus stays a pure function: the PREVENT cardiovascular
  // risk read, benchmark milestones, and the K5 due-attention re-checks (labs/DEXA/
  // lifts). journeyView.milestones is reused for the journey producer (no recompute).
  const cardioRiskView = brainSignal("cardio_risk", () => {
    try {
      return cardiovascularRiskRead();
    } catch {
      return null;
    }
  });
  const benchmarkMilestonesView = brainSignal(`benchmark_milestones:${today}`, () => {
    try {
      return trainingBenchmarkRead(today, { programState: fullProgramState }).milestones;
    } catch {
      return [];
    }
  });
  const dueAttentionView = brainSignal(`due_attention:${today}`, () => {
    try {
      return listDueAttention(today, { limit: 12 });
    } catch {
      return [];
    }
  });
  // THE CONDUCTOR (the whole-athlete analog of healthFocus): arbitrate every domain
  // read into ONE sequenced focus — a single lead lever, 1-2 parallel levers, an
  // explicit "later", the cross-domain connections, and one batched retest — so the
  // brain AND the interface lead with the same priority instead of a flood of co-equal
  // blocks. Pure, null-safe; degrades to {available:false} on a thin athlete.
  const coachingFocusView = brainSignal("coaching_focus", () => {
    try {
      return coachingFocus({
        discipline: {
          primary: (profile?.primary_discipline as string) || "strength",
          endurance_sport: profile?.endurance_sport ?? null,
        },
        enduranceGoal: getEnduranceGoal(),
        trainingIntent: trainingIntentView,
        enduranceCapacity: enduranceCapacityView,
        goalMode: effectiveGoalMode(profile),
        programState: fullProgramState,
        recovery,
        healthFocus: healthFocusView,
        performance: performanceView,
        programAdjustments: programAdjustmentsView,
        runPlan: runPlanView,
        runVariety: runVarietyView,
        dexa: dexaTargetingView,
        groupsTrajectory: groupsTrajectoryView,
        trajectory: trajectoryView,
        testWeek: testWeekView,
        enduranceTests: enduranceTestsView,
        // Life/soreness awareness: active injuries + the autoregulation rollup + the
        // reduce-load window, so the conductor never leads with a lever that loads an
        // injured/sore area (it demotes or caveats it instead).
        injuries: contextEventsView.filter((e: any) => e?.kind === "injury"),
        autoregulation: trainingSignalsView?.autoregulation ?? null,
        contextToday: contextTodayView,
        // The conductor consumes the SAME already-resolved planning state as the
        // Brief. It translates posture/directives into its existing candidates and
        // constraints, so Today and Progress cannot issue competing instructions.
        signalState: signalStateView,
        // External producers (K3): the whole picture — journey, benchmarks, the K5
        // due re-checks, and the PREVENT cardiovascular risk — arbitrated by the ONE
        // conductor alongside the domain levers, so there is a single "what's next" voice.
        journeyMilestones: Array.isArray((journeyView as any)?.milestones) ? (journeyView as any).milestones : [],
        benchmarkMilestones: benchmarkMilestonesView,
        dueAttention: dueAttentionView,
        cardioRisk: cardioRiskView,
        // Temporal placement: where the athlete is inside the active block, so
        // "This block" carries its calendar ("week 3 of 5 — building volume").
        programBlock: (() => {
          try {
            return blockForCoach(today);
          } catch {
            return null;
          }
        })(),
        // Autonomy-awareness (lead-by-default): under 'lead' the coach applies bounded
        // changes itself at natural boundaries, so the conductor drops its one-tap asks
        // and speaks state. recentRotations + plannedNames let it tell a HANDLED plateau
        // (lift already rotated out) from a live one; `upcoming` names the weekday an
        // auto-set recovery week arrives.
        leadMode: (() => {
          try {
            return getSettings().lead_mode;
          } catch {
            return "lead";
          }
        })(),
        // Background coaching off means the scheduler can never fulfill "your coach
        // sets this up automatically" — the conductor then keeps the athlete-driven
        // asks even under lead posture (coachLeads() requires both).
        proactiveEnabled: (() => {
          try {
            return getSettings().proactive_enabled !== false;
          } catch {
            return true;
          }
        })(),
        recentRotations: recentRotationsView,
        plannedNames: brainSignal("planned_names", () => {
          try {
            return planExerciseNames();
          } catch {
            return [];
          }
        }),
        upcoming: brainSignal("upcoming_decisions:10", () => {
          try {
            return upcomingBrainDecisions(10);
          } catch {
            return [];
          }
        }),
        // The recovery-week state machine (due → drafted → applied): a waiting draft
        // flips the Program button into a review link; an APPLIED week in flight
        // makes the lead a calm confirmation ("recovery week is on") with no action
        // at all — never the same ask twice.
        ...(() => {
          try {
            const rw = recoveryWeekStatus();
            return {
              recoveryDraftPending: rw?.state === "drafted",
              recoveryWeekActive: rw?.state === "applied",
            };
          } catch {
            return {};
          }
        })(),
      });
    } catch {
      return {
        available: false,
        headline: "",
        lead: null,
        parallel: [],
        later: [],
        connections: [],
        retest: null,
        horizon_weeks: null,
        caveat: null,
        block_line: null,
      };
    }
  });
  const signals: CoachContextSignals = {
    today,
    profile,
    locationView,
    trainingIntentView,
    enduranceCapacityView,
    garmin,
    recovery,
    recentSessions,
    dayReadView,
    programBal,
    recentLoad,
    acuteLoad,
    fullProgramState,
    strengthJourneyView,
    runZonesView,
    runPlanView,
    weekLayoutView,
    flexibleTrainingAgendaView,
    dexaTargetingView,
    testWeekView,
    healthFocusView,
    performanceView,
    programAdjustmentsView,
    groupsTrajectoryView,
    runVarietyView,
    enduranceTestsView,
    hrModelView,
    calibrationView,
    trajectoryView,
    wholePersonTrajectoryView,
    journeyView,
    expenditureView,
    underfuelingView,
    cutQualityView,
    coachingFocusView,
    signalStateView,
    bodyCompositionView,
    contextTodayView,
    trainingSignalsView,
    contextEventsView,
  };
  // Compose the context from cohesive per-domain slices. Every EXPENSIVE signal above
  // (garmin/recovery/day-read/program-state/volume balance/acute load + the conductor's
  // domain reads) is computed exactly once and threaded in via `signals`, so no slice
  // re-derives one — the assembled CoachContext is what the single inline object was.
  return {
    ...buildPersonSlice(signals),
    ...buildNutritionSlice(signals),
    ...buildTrainingSlice(signals),
    ...buildRunningSlice(signals),
    ...buildHealthSlice(signals),
    ...buildBrainSlice(signals),
    body_metrics: brainSignal("body_metrics", () => {
      try {
        return bodyMetricsContextSlice();
      } catch {
        return null;
      }
    }),
    // The two ADVISORY session constraints the recovery science owes the coach
    // prompts: short sleep downgrades injury-exposed elements without cancelling the
    // session, and a sustained stressful stretch trims sets while intensity holds.
    // Null on an ordinary day, so the payload is unchanged when nothing applies —
    // and null-safe by construction (a pure read over snapshots already built here).
    // The check-in window is the STRESS read's own 14 days, not the person slice's 7.
    training_constraints: brainSignal(`training_constraints:${today}`, () => {
      try {
        return trainingConstraintsRead({
          date: today,
          recovery,
          checkins: listCheckins(STRESS_WINDOW_DAYS),
          contextEvents: contextEventsView,
        });
      } catch {
        return null;
      }
    }),
  };
}

// The CONDUCTOR as a standalone pull read (for the PWA + MCP): one sequenced
// whole-athlete focus. Reuses the canonical getCoachContext assembly so it can never
// drift from what the prompts see. On-demand only; degrades to {available:false}.
//
// Cross-request MEMO (same pattern as getProgramState/getWeeklyStats): the standalone
// GET builds the ENTIRE coach context just to pluck one key — ~400ms on a Pi — and the
// PWA asks for it from three surfaces (Today thread, Stand, Program). Keyed on the
// training + marker write counters and the local date, with a short TTL backstop for
// the few signals outside both counters (e.g. a directive status flip). PROMPTS are
// untouched — getCoachContext itself is never memoized, so coaching always sees fresh.
let coachingFocusMemo: { key: string; at: number; value: unknown } | null = null;
const COACHING_FOCUS_MEMO_TTL_MS = 120_000;
registerTrainingCacheClear(() => {
  coachingFocusMemo = null;
});

export function getCoachingFocus() {
  // lead_mode + proactive_enabled are in the key so flipping either setting (both
  // change `acts` and the recovery/stall copy) busts the memo without waiting for
  // a training/marker write.
  let leadMode = "lead";
  let proactive = "on";
  try {
    const s = getSettings();
    leadMode = s.lead_mode;
    proactive = s.proactive_enabled !== false ? "on" : "off";
  } catch {}
  const key = `${currentTrainingDataVersion()}:${currentMarkerDataVersion()}:${localDateISO()}:${leadMode}:${proactive}`;
  if (
    coachingFocusMemo &&
    coachingFocusMemo.key === key &&
    Date.now() - coachingFocusMemo.at < COACHING_FOCUS_MEMO_TTL_MS
  ) {
    return coachingFocusMemo.value;
  }
  try {
    const value = getCoachContext().coaching_focus;
    coachingFocusMemo = { key, at: Date.now(), value };
    return value;
  } catch {
    return {
      available: false,
      headline: "",
      lead: null,
      parallel: [],
      later: [],
      connections: [],
      retest: null,
      horizon_weeks: null,
      caveat: null,
      block_line: null,
    };
  }
}

// ============================================================================
// VISION BUILD — shared foundation for the parallel feature teams (Stage 1).
// Everything below is additive and null-safe. Feature teams flesh out the
// stubs (dayRead / estimateExpenditure / frequentFoods / prioritizeMarkers)
// against the signatures here; the deterministic bodies keep the build and the
// app working today.
// ============================================================================

// ---------- check-ins (Phase 5C / day-read signal) ----------
export interface CheckinInput {
  mood?: number | null;
  energy?: number | null;
  sleep_feel?: number | null;
  soreness?: number | null;
  note?: string | null;
}

function clampScale15(v: any): number | null {
  if (v == null || (typeof v === "string" && v.trim() === "")) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, Math.round(n)));
}

// One check-in per save (a date can have several; the latest wins for reads).
export function addCheckin(date: string, fields: CheckinInput = {}) {
  const d = date || localDateISO();
  const info = db
    .prepare(`INSERT INTO checkins (date, mood, energy, sleep_feel, soreness, note) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      d,
      clampScale15(fields.mood),
      clampScale15(fields.energy),
      clampScale15(fields.sleep_feel),
      clampScale15(fields.soreness),
      fields.note == null ? null : String(fields.note).trim().slice(0, 500) || null
    );
  invalidateDayRead(d); // a fresh subjective signal can change today's read
  bumpTrainingDataVersion(); // keep the shared training version comprehensive for consumers
  return db.prepare(`SELECT * FROM checkins WHERE id = ?`).get(info.lastInsertRowid);
}

// Most recent check-in for a date (or null) — the day-read reads "today".
export function getCheckinByDate(date: string) {
  return db.prepare(`SELECT * FROM checkins WHERE date = ? ORDER BY id DESC LIMIT 1`).get(date) ?? null;
}

export function listCheckins(limit = 14) {
  return db.prepare(`SELECT * FROM checkins ORDER BY date DESC, id DESC LIMIT ?`).all(limit);
}

// ---------- family members (Phase 2B) ----------
export interface FamilyInput {
  name?: string | null;
  color?: string | null;
  relationship?: string | null;
  birthdate?: string | null;
  notes?: string | null;
  allergies?: string | null;
  dietary_restrictions?: string | null;
}

export function listFamily() {
  return db.prepare(`SELECT * FROM family_members ORDER BY id`).all();
}

export function getFamilyMember(id: number) {
  return db.prepare(`SELECT * FROM family_members WHERE id = ?`).get(id) ?? null;
}

export function addFamily(fields: FamilyInput = {}) {
  const info = db
    .prepare(
      `INSERT INTO family_members (name, color, relationship, birthdate, notes, allergies, dietary_restrictions) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.name == null ? null : String(fields.name).trim().slice(0, 120) || null,
      fields.color == null ? null : String(fields.color).trim().slice(0, 40) || null,
      fields.relationship == null ? null : String(fields.relationship).trim().slice(0, 60) || null,
      fields.birthdate == null ? null : String(fields.birthdate).trim().slice(0, 10) || null,
      fields.notes == null ? null : String(fields.notes).trim().slice(0, 1000) || null,
      fields.allergies == null ? null : String(fields.allergies).trim().slice(0, 500) || null,
      fields.dietary_restrictions == null ? null : String(fields.dietary_restrictions).trim().slice(0, 500) || null
    );
  return getFamilyMember(Number(info.lastInsertRowid));
}

export function updateFamily(id: number, fields: FamilyInput) {
  const cur = getFamilyMember(id) as any;
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  const put = (col: string, v: any, max: number) => {
    sets.push(`${col} = ?`);
    vals.push(v == null ? null : String(v).trim().slice(0, max) || null);
  };
  if (fields.name !== undefined) put("name", fields.name, 120);
  if (fields.color !== undefined) put("color", fields.color, 40);
  if (fields.relationship !== undefined) put("relationship", fields.relationship, 60);
  if (fields.birthdate !== undefined) put("birthdate", fields.birthdate, 10);
  if (fields.notes !== undefined) put("notes", fields.notes, 1000);
  if (fields.allergies !== undefined) put("allergies", fields.allergies, 500);
  if (fields.dietary_restrictions !== undefined) put("dietary_restrictions", fields.dietary_restrictions, 500);
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE family_members SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getFamilyMember(id);
}

export function deleteFamily(id: number) {
  return { deleted: db.prepare(`DELETE FROM family_members WHERE id = ?`).run(id).changes };
}

// ---------- health directives (the connected brain — Phase 4C / T4) ----------
// A flagged/sub-optimal finding (a lab marker, a pattern) propagated into every
// domain it touches — nutrition, training, watch — grounded in reputable
// guideline citations where the lever is well-established, flagged uncertain
// (citation null) where the mapping is real but not settled. INFORMATIONAL, not
// medical advice. Two sources coexist: 'markers' (deterministic propagation
// engine) and 'health_review' (agent-emitted on a saved review).
export interface DirectiveInput {
  source?: string | null; // markers | health_review
  domain?: string | null; // nutrition | training | watch
  marker?: string | null; // the source marker key (e.g. 'LDL-C') when applicable
  directive_key?: string | null; // stable advice family key for repeat suppression
  intent_key?: string | null; // semantic intent: recheck | lever | notice (identity axis)
  directive?: string | null;
  rationale?: string | null;
  citation?: string | null;
  uncertain?: boolean; // 1 when the lever is real but not settled
  status?: string | null; // active | resolved | dismissed
  status_at?: string | null;
  trigger_value?: number | null;
  trigger_side?: string | null; // low | high | unknown
  trigger_date?: string | null;
  resurfaced_from_id?: number | null;
}

export const DIRECTIVE_DOMAINS = new Set(["nutrition", "training", "watch"]);
const DIRECTIVE_STATUSES = new Set(["active", "resolved", "dismissed"]);

export function normalizeDirectiveKey(v: any): string | null {
  const s = String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 160);
  return s || null;
}

export function defaultDirectiveKey(marker: string | null, domain: string, directive: string | null): string | null {
  const directivePart = directive ? normalizeDirectiveKey(directive) : null;
  const parts = [
    marker ? normalizeDirectiveKey(marker) : null,
    normalizeDirectiveKey(domain),
    directivePart ? directivePart.slice(0, 90) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(":") : null;
}

function directiveTriggerFromMarker(marker: string | null) {
  if (!marker) return null;
  const target = String(marker).toLowerCase();
  const { markers } = prioritizeMarkers();
  const m =
    markers.find((x: any) => String(x?.name || x?.key || "").toLowerCase() === target) ||
    markers.find((x: any) =>
      String(x?.name || x?.key || "")
        .toLowerCase()
        .includes(target)
    );
  if (!m) return null;
  const z = matchOptimalZone(m?.name);
  if (!z) return null;
  const value = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
  if (!Number.isFinite(value)) return null;
  const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
  return { value, side: markerSide(value, z, flag), date: m?.latest?.date ?? null };
}

export function addDirective(fields: DirectiveInput = {}) {
  const domain = DIRECTIVE_DOMAINS.has(String(fields.domain)) ? String(fields.domain) : "watch";
  const status = DIRECTIVE_STATUSES.has(String(fields.status)) ? String(fields.status) : "active";
  const marker = fields.marker == null ? null : String(fields.marker).trim().slice(0, 60) || null;
  const directive = fields.directive == null ? null : String(fields.directive).trim().slice(0, 600) || null;
  const directive_key =
    fields.directive_key == null
      ? defaultDirectiveKey(marker, domain, directive)
      : normalizeDirectiveKey(fields.directive_key);
  // The semantic intent (recheck | lever | notice) is part of directive identity. Prefer
  // an explicit value from the caller (the mapped path passes it); else classify the text.
  const intent_key =
    fields.intent_key === "recheck" || fields.intent_key === "lever" || fields.intent_key === "notice"
      ? fields.intent_key
      : classifyDirectiveIntent(directive, null);
  const triggerSide = ["low", "high", "unknown"].includes(String(fields.trigger_side))
    ? String(fields.trigger_side)
    : null;
  const triggerValue =
    fields.trigger_value == null || !Number.isFinite(Number(fields.trigger_value))
      ? null
      : Number(fields.trigger_value);
  const info = db
    .prepare(`INSERT INTO health_directives (source, domain, marker, directive_key, intent_key, directive, rationale, citation, uncertain, status, status_at, trigger_value, trigger_side, trigger_date, resurfaced_from_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      fields.source == null ? null : String(fields.source).trim().slice(0, 120) || null,
      domain,
      marker,
      directive_key,
      intent_key,
      directive,
      fields.rationale == null ? null : String(fields.rationale).trim().slice(0, 600) || null,
      fields.citation == null || String(fields.citation).trim() === ""
        ? null
        : String(fields.citation).trim().slice(0, 600),
      fields.uncertain ? 1 : 0,
      status,
      fields.status_at == null ? null : String(fields.status_at).trim().slice(0, 40) || null,
      triggerValue,
      triggerSide,
      fields.trigger_date == null ? null : String(fields.trigger_date).trim().slice(0, 20) || null,
      fields.resurfaced_from_id == null || !Number.isFinite(Number(fields.resurfaced_from_id))
        ? null
        : Number(fields.resurfaced_from_id)
    );
  return getDirective(Number(info.lastInsertRowid));
}

export function getDirective(id: number) {
  return hydrateDirective(db.prepare(`SELECT * FROM health_directives WHERE id = ?`).get(id) ?? null);
}

// Defaults to the active set (what the user/coach should act on); pass
// { all: true } for the full history incl. resolved/dismissed.
export function listDirectives(opts: { all?: boolean } = {}) {
  const rows = opts.all
    ? (db.prepare(`SELECT * FROM health_directives ORDER BY id DESC`).all() as any[])
    : (db.prepare(`SELECT * FROM health_directives WHERE status = 'active' ORDER BY id DESC`).all() as any[]);
  const hydrated = rows.map(hydrateDirective);
  return opts.all ? hydrated : dedupeActiveDirectives(hydrated);
}

// Monotonic counter bumped on every USER directive status flip. It feeds the derive
// signature so a Done/Dismiss (which changes what's suppressed) always forces the next
// propagation pass instead of short-circuiting on an unchanged marker snapshot.
const DIRECTIVE_FEEDBACK_COUNTER_KEY = "directive_feedback_counter";
export function directiveFeedbackCounter(): string {
  return getAppState(DIRECTIVE_FEEDBACK_COUNTER_KEY) || "0";
}
function bumpDirectiveFeedbackCounter(): void {
  const n = Number(getAppState(DIRECTIVE_FEEDBACK_COUNTER_KEY) || "0");
  setAppState(DIRECTIVE_FEEDBACK_COUNTER_KEY, String((Number.isFinite(n) ? n : 0) + 1));
}

// Cascade a USER status flip to every ACTIVE twin sharing the row's identity tuple
// (any source), so one Done/Dismiss clears the deterministic 'markers' directive AND
// its agent-emitted 'health_review' echo at once. Uses the SAME status_at as the
// primary flip so the feedback timeline stays coherent. Returns the number of twins
// updated. Machine soft-resolves never call this (they go through direct SQL).
function cascadeDirectiveStatus(primary: any, status: string): number {
  if (!primary || (status !== "resolved" && status !== "dismissed")) return 0;
  const identity = directiveIdentityKey(primary);
  const statusAt = primary.status_at ?? null;
  const rows = db
    .prepare(`SELECT * FROM health_directives WHERE status = 'active' AND id != ?`)
    .all(Number(primary.id)) as any[];
  let changed = 0;
  for (const r of rows) {
    if (directiveIdentityKey(r) !== identity) continue;
    db.prepare(`UPDATE health_directives SET status = ?, status_at = ? WHERE id = ?`).run(status, statusAt, r.id);
    changed++;
  }
  return changed;
}

export function updateDirective(id: number, fields: DirectiveInput) {
  const cur = getDirective(id) as any;
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  let statusChanged = false;
  let nextStatus = cur.status;
  if (fields.source !== undefined) {
    sets.push("source = ?");
    vals.push(fields.source == null ? null : String(fields.source).trim().slice(0, 120) || null);
  }
  if (fields.domain !== undefined) {
    sets.push("domain = ?");
    vals.push(DIRECTIVE_DOMAINS.has(String(fields.domain)) ? String(fields.domain) : cur.domain);
  }
  if (fields.marker !== undefined) {
    sets.push("marker = ?");
    vals.push(fields.marker == null ? null : String(fields.marker).trim().slice(0, 60) || null);
  }
  if (fields.directive_key !== undefined) {
    sets.push("directive_key = ?");
    vals.push(fields.directive_key == null ? null : normalizeDirectiveKey(fields.directive_key));
  }
  if (fields.intent_key !== undefined) {
    sets.push("intent_key = ?");
    vals.push(
      fields.intent_key === "recheck" || fields.intent_key === "lever" || fields.intent_key === "notice"
        ? fields.intent_key
        : classifyDirectiveIntent(fields.directive ?? cur.directive, null)
    );
  }
  if (fields.directive !== undefined) {
    sets.push("directive = ?");
    vals.push(fields.directive == null ? null : String(fields.directive).trim().slice(0, 600) || null);
  }
  if (fields.rationale !== undefined) {
    sets.push("rationale = ?");
    vals.push(fields.rationale == null ? null : String(fields.rationale).trim().slice(0, 600) || null);
  }
  if (fields.citation !== undefined) {
    sets.push("citation = ?");
    vals.push(
      fields.citation == null || String(fields.citation).trim() === ""
        ? null
        : String(fields.citation).trim().slice(0, 600)
    );
  }
  if (fields.uncertain !== undefined) {
    sets.push("uncertain = ?");
    vals.push(fields.uncertain ? 1 : 0);
  }
  if (fields.status !== undefined) {
    nextStatus = DIRECTIVE_STATUSES.has(String(fields.status)) ? String(fields.status) : cur.status;
    sets.push("status = ?");
    vals.push(nextStatus);
    statusChanged = nextStatus !== cur.status;
    if (nextStatus !== cur.status && fields.status_at === undefined) {
      sets.push("status_at = datetime('now')");
    }
  }
  if (statusChanged && !cur.directive_key && fields.directive_key === undefined) {
    sets.push("directive_key = ?");
    vals.push(defaultDirectiveKey(cur.marker ?? null, cur.domain || "watch", cur.directive ?? null));
  }
  if (statusChanged && (cur.trigger_value == null || !cur.trigger_side || !cur.trigger_date)) {
    const trigger = directiveTriggerFromMarker(cur.marker ?? null);
    if (trigger) {
      if (cur.trigger_value == null && fields.trigger_value === undefined) {
        sets.push("trigger_value = ?");
        vals.push(trigger.value);
      }
      if (!cur.trigger_side && fields.trigger_side === undefined) {
        sets.push("trigger_side = ?");
        vals.push(trigger.side);
      }
      if (!cur.trigger_date && fields.trigger_date === undefined) {
        sets.push("trigger_date = ?");
        vals.push(trigger.date);
      }
    }
  }
  if (fields.status_at !== undefined) {
    sets.push("status_at = ?");
    vals.push(fields.status_at == null ? null : String(fields.status_at).trim().slice(0, 40) || null);
  }
  if (fields.trigger_value !== undefined) {
    sets.push("trigger_value = ?");
    vals.push(
      fields.trigger_value == null || !Number.isFinite(Number(fields.trigger_value))
        ? null
        : Number(fields.trigger_value)
    );
  }
  if (fields.trigger_side !== undefined) {
    sets.push("trigger_side = ?");
    vals.push(["low", "high", "unknown"].includes(String(fields.trigger_side)) ? String(fields.trigger_side) : null);
  }
  if (fields.trigger_date !== undefined) {
    sets.push("trigger_date = ?");
    vals.push(fields.trigger_date == null ? null : String(fields.trigger_date).trim().slice(0, 20) || null);
  }
  if (fields.resurfaced_from_id !== undefined) {
    sets.push("resurfaced_from_id = ?");
    vals.push(
      fields.resurfaced_from_id == null || !Number.isFinite(Number(fields.resurfaced_from_id))
        ? null
        : Number(fields.resurfaced_from_id)
    );
  }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE health_directives SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  const updated = getDirective(id);
  // A USER status flip to resolved/dismissed is feedback: bump the derive-signature
  // counter (so the next propagation pass never short-circuits past it) and cascade the
  // same verdict onto every ACTIVE twin sharing this directive's identity, so one Done
  // clears the 'markers' directive AND its 'health_review' echo at once.
  if (statusChanged && (nextStatus === "resolved" || nextStatus === "dismissed")) {
    bumpDirectiveFeedbackCounter();
    const twins = cascadeDirectiveStatus(updated, nextStatus);
    if (twins > 0) {
      try {
        // Deliberately the UNCONDITIONAL invalidation, not the fingerprint-aware one:
        // directives are not part of the deterministic decision (the fingerprint could
        // never move), yet the Brief's PROSE is written against the active training and
        // watch directives. A directive the athlete just cleared must stop being voiced,
        // and this is a rare, explicit athlete action — not telemetry churn.
        invalidateDayRead();
      } catch {
        /* cache bust is best-effort */
      }
    }
    // Marking a RECHECK directive Done ("Retest lipids in ~12 weeks", "Confirm
    // testosterone with a morning repeat") schedules the follow-up on the attention
    // engine so it actually comes back around, instead of the card just vanishing.
    // Only on Done (resolved) — a dismiss means "not relevant", never a new retest.
    // No-op for non-recheck directives. Best-effort; a hiccup never blocks the flip.
    if (nextStatus === "resolved") {
      try {
        scheduleDirectiveRecheck(updated);
      } catch {
        /* scheduling is additive; never block the status flip */
      }
    }
  }
  return updated;
}

// Whether an existing active row already carries the desired content, so a re-derive can
// leave it untouched (id + created_at preserved). Compares the fields the diff contract
// tracks — directive text, the trigger snapshot, AND the rationale/uncertain/citation
// content — after applying the same normalization addDirective would on insert, so a
// "kept" row truly equals a fresh write. The rationale/uncertain comparison matters
// because applyStaleness (propagation.ts) rewrites ONLY the rationale + uncertain of an
// aging directive (its text + trigger snapshot stay identical); without them here that
// staleness clause would be silently dropped as an "unchanged" row.
function directiveContentUnchanged(cur: any, d: DirectiveInput): boolean {
  const normText = (v: any) => (v == null ? null : String(v).trim().slice(0, 600) || null);
  const normDate = (v: any) => (v == null ? null : String(v).trim().slice(0, 20) || null);
  const numEq = (a: any, b: any) => {
    const an = a == null || !Number.isFinite(Number(a)) ? null : Number(a);
    const bn = b == null || !Number.isFinite(Number(b)) ? null : Number(b);
    if (an == null && bn == null) return true;
    if (an == null || bn == null) return false;
    return Math.abs(an - bn) < 1e-9;
  };
  const side = (v: any) => (["low", "high", "unknown"].includes(String(v)) ? String(v) : null);
  return (
    normText(cur.directive) === normText(d.directive) &&
    numEq(cur.trigger_value, d.trigger_value) &&
    side(cur.trigger_side) === side(d.trigger_side) &&
    normDate(cur.trigger_date) === normDate(d.trigger_date) &&
    normText(cur.rationale) === normText(d.rationale) &&
    normText(cur.citation) === normText(d.citation) &&
    !!cur.uncertain === !!d.uncertain
  );
}

// Diff-based reconcile of one source's ACTIVE directives toward a desired set — the
// zero-churn replacement for clear-all + reinsert. An existing active row with the same
// directive_key and unchanged content is KEPT untouched (id + created_at preserved); a
// changed one is UPDATED in place (status stays active, so no status_at stamp / cascade);
// a row no longer desired is SOFT-RESOLVED (status_at stays NULL — a machine resolve,
// never user feedback); a genuinely new directive is INSERTED. Idempotent: an unchanged
// desired set produces zero inserts/updates/resolves. Returns the change tally.
export function reconcileDirectives(source: string, desired: DirectiveInput[]) {
  const existing = db
    .prepare(`SELECT * FROM health_directives WHERE source = ? AND status = 'active'`)
    .all(source) as any[];
  const existingByKey = new Map<string, any>();
  for (const r of existing) if (r.directive_key) existingByKey.set(String(r.directive_key), r);
  const desiredKeys = new Set<string>();
  const processed = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let resolved = 0;
  for (const d of desired) {
    const key = d.directive_key
      ? normalizeDirectiveKey(d.directive_key)
      : defaultDirectiveKey(d.marker ?? null, String(d.domain || "watch"), d.directive ?? null);
    if (key) {
      desiredKeys.add(key);
      if (processed.has(key)) continue; // guard against a duplicate desired key within the run
      processed.add(key);
    }
    const cur = key ? existingByKey.get(key) : null;
    if (!cur) {
      addDirective(d);
      inserted++;
      continue;
    }
    if (directiveContentUnchanged(cur, d)) continue; // keep untouched
    updateDirective(cur.id, { ...d, status: undefined, status_at: undefined }); // in place, stays active
    updated++;
  }
  for (const r of existing) {
    if (!r.directive_key || !desiredKeys.has(String(r.directive_key))) {
      db.prepare(`UPDATE health_directives SET status = 'resolved' WHERE id = ? AND status = 'active'`).run(r.id);
      resolved++;
    }
  }
  return { changed: inserted + updated + resolved, inserted, updated, resolved, saved: inserted + updated };
}

// ---------- insights (quiet cross-domain intelligence — Phase 6) ----------
export interface InsightInput {
  kind?: string | null;
  text?: string | null;
  rationale?: string | null;
  next_step?: string | null; // optional concrete, low-friction suggestion
  status?: string | null; // new | seen | dismissed
  feedback?: string | null; // up | down
  // The territorial identity of the connection — see src/repo/insight-intent.ts.
  // Callers pass a key they already resolved; NULL is the honest value when
  // derivation was ambiguous, and legacy rows keep deriving theirs at read time.
  intent_key?: string | null;
}

const INSIGHT_STATUSES = new Set(["new", "seen", "dismissed"]);
const INSIGHT_FEEDBACK = new Set(["up", "down"]);

// The card surfaces the headline plainly and tucks the reasoning behind a quiet
// "why" disclosure, so we keep each field short — the rationale is one or two
// sentences, not an evidence dump — and clamp on a WORD boundary (capStr) so a
// long value never gets sliced mid-word the way a raw .slice() would.
export function addInsight(fields: InsightInput = {}) {
  const status = INSIGHT_STATUSES.has(String(fields.status)) ? String(fields.status) : "new";
  const info = db
    .prepare(
      `INSERT INTO insights (kind, text, rationale, next_step, status, feedback, intent_key) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.kind == null ? null : String(fields.kind).trim().slice(0, 60) || null,
      fields.text == null ? null : capStr(fields.text, 320) || null,
      fields.rationale == null ? null : capStr(fields.rationale, 360) || null,
      fields.next_step == null ? null : capStr(fields.next_step, 200) || null,
      status,
      INSIGHT_FEEDBACK.has(String(fields.feedback)) ? String(fields.feedback) : null,
      fields.intent_key == null ? null : String(fields.intent_key).trim().slice(0, 120) || null
    );
  return getInsight(Number(info.lastInsertRowid));
}

export function getInsight(id: number) {
  return db.prepare(`SELECT * FROM insights WHERE id = ?`).get(id) ?? null;
}

export function updateInsight(id: number, fields: InsightInput) {
  const cur = getInsight(id) as any;
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  if (fields.kind !== undefined) {
    sets.push("kind = ?");
    vals.push(fields.kind == null ? null : String(fields.kind).trim().slice(0, 60) || null);
  }
  if (fields.text !== undefined) {
    sets.push("text = ?");
    vals.push(fields.text == null ? null : capStr(fields.text, 320) || null);
  }
  if (fields.rationale !== undefined) {
    sets.push("rationale = ?");
    vals.push(fields.rationale == null ? null : capStr(fields.rationale, 360) || null);
  }
  if (fields.next_step !== undefined) {
    sets.push("next_step = ?");
    vals.push(fields.next_step == null ? null : capStr(fields.next_step, 200) || null);
  }
  if (fields.status !== undefined) {
    sets.push("status = ?");
    vals.push(INSIGHT_STATUSES.has(String(fields.status)) ? String(fields.status) : cur.status);
  }
  if (fields.feedback !== undefined) {
    sets.push("feedback = ?");
    vals.push(INSIGHT_FEEDBACK.has(String(fields.feedback)) ? String(fields.feedback) : null);
  }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE insights SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getInsight(id);
}

// How long a CONNECTION insight stays in the live visible set. The Today card
// shows the latest non-weekly insight, and the producer is gated ~once/20h and
// often returns nothing new — so without a window a long-resolved connection
// ("sleep dropped when mileage ramped") keeps reading as today's connection for
// weeks. A conservative recency window ages a stale connection OUT of the visible
// set; it's a VISIBILITY filter only (the row is never deleted — it stays in the
// DB and exports, just hidden from the live card). The keystone weekly_read is
// EXEMPT: a weekly read legitimately persists for the week (the scheduler refreshes
// it on its own cadence), and the Today weekly card relies on it being visible.
export const INSIGHT_VISIBLE_WINDOW_DAYS = 14;

// The Brief surfaces ONE insight at a time, in-app, when opened — so the public
// read is the live set only: new + seen, most recent first (dismissed stays in
// the DB and exports but is hidden). Quiet by default. Connection insights older
// than INSIGHT_VISIBLE_WINDOW_DAYS age out so a stale read never lingers as
// "today's"; weekly_read is exempt (it persists for the week on its own cadence).
export function listVisibleInsights(limit = 20) {
  const cutoff = new Date(Date.now() - INSIGHT_VISIBLE_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT * FROM insights
        WHERE status IN ('new', 'seen')
          AND (kind = 'weekly_read' OR substr(created_at, 1, 10) >= ?)
        ORDER BY id DESC LIMIT ?`
    )
    .all(cutoff, limit) as any[];
  return annotateWeeklyReadFreshness(rows);
}

// ---------------------------------------------------------------------------
// Weekly-read staleness (pull, never push) — mirrors the health-synthesis
// drift_sig pattern (repo/health-focus.ts). The weekly read ("how the week
// went + the one change") legitimately persists for its slot, so mid-week it
// keeps asserting last slot's advice. We stamp a coarse freshness signature at
// generation, compare it live at serve, and — when the picture has moved —
// mark the read `stale` and DEFANG its "one change" so no surface asserts a
// stale action. The re-read affordance is a quiet tap (client), never a nag.
//
// Signature shape (each a meaningfully-sized change on its own, not daily churn):
//  - week_sessions: distinct training days this local week (a workout completed
//    since the read is material to a "how the week went" story).
//  - latest_doc_date: newest health-doc effective date (new labs landed).
//  - directive_keys: the active cross-domain directive identity set (a flagged
//    finding opened/closed/changed).
//  - weight_bucket: latest weigh-in rounded to a 2 lb bucket (a real move, not a
//    0.2 lb wiggle).
//  - latest_context_event_id: max non-archived context-event id (a NEW trip /
//    injury / life event since the read).
// A cached read with NO stored signature (legacy) or an id mismatch compares as
// "can't tell" → never stale. Never throws.
// ---------------------------------------------------------------------------
const WEEKLY_READ_FRESHNESS_KEY = "weekly_read_freshness";

export interface WeeklyReadSignature {
  week_sessions: number;
  latest_doc_date: string | null;
  directive_keys: string[];
  weight_bucket: number | null;
  latest_context_event_id: number | null;
}

function weeklyReadWeekStartISO(today = localDateISO()): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // back to Monday
  return d.toISOString().slice(0, 10);
}

export function computeWeeklyReadSignature(): WeeklyReadSignature {
  const today = localDateISO();
  let week_sessions = 0;
  try {
    const row = db
      .prepare(`SELECT COUNT(DISTINCT date) AS c FROM sessions WHERE date >= ?`)
      .get(weeklyReadWeekStartISO(today)) as any;
    week_sessions = Number(row?.c ?? 0);
  } catch {
    week_sessions = 0;
  }
  let latest_doc_date: string | null = null;
  try {
    latest_doc_date = newestHealthDocDate();
  } catch {
    latest_doc_date = null;
  }
  let directive_keys: string[] = [];
  try {
    directive_keys = (listActiveDirectives() as any[])
      .map((d) => directiveKey(d))
      .filter(Boolean)
      .sort();
  } catch {
    directive_keys = [];
  }
  let weight_bucket: number | null = null;
  try {
    const w = db.prepare(`SELECT weight_lb FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT 1`).get() as any;
    const lb = Number(w?.weight_lb);
    weight_bucket = Number.isFinite(lb) ? Math.round(lb / 2) * 2 : null; // 2 lb dead-band
  } catch {
    weight_bucket = null;
  }
  let latest_context_event_id: number | null = null;
  try {
    const c = db.prepare(`SELECT MAX(id) AS id FROM context_events WHERE archived = 0`).get() as any;
    latest_context_event_id = c?.id != null ? Number(c.id) : null;
  } catch {
    latest_context_event_id = null;
  }
  return { week_sessions, latest_doc_date, directive_keys, weight_bucket, latest_context_event_id };
}

// Stamp the freshness signature for the just-written weekly read. Keyed by the
// insight id so a serve-time comparison only trusts the signature that belongs
// to the read on screen. Called from generateInsight after the row is stored.
export function stampWeeklyReadFreshness(insightId: number): void {
  try {
    setAppState(
      WEEKLY_READ_FRESHNESS_KEY,
      JSON.stringify({ insight_id: Number(insightId), sig: computeWeeklyReadSignature() })
    );
  } catch {
    /* freshness stamping never blocks generation */
  }
}

function readWeeklyReadFreshness(): { insight_id: number; sig: any } | null {
  const raw = getAppState(WEEKLY_READ_FRESHNESS_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    const id = Number(v?.insight_id);
    if (!Number.isFinite(id)) return null;
    return { insight_id: id, sig: v?.sig ?? null };
  } catch {
    return null;
  }
}

function weeklyKeysDiffer(a: unknown, b: unknown): boolean {
  const sa = Array.isArray(a) ? [...a].map(String).sort() : [];
  const sb = Array.isArray(b) ? [...b].map(String).sort() : [];
  return JSON.stringify(sa) !== JSON.stringify(sb);
}

// Conservative, threshold-biased comparison. Any single true trigger flags stale
// (each shape is already a meaningfully-sized change — see the doc comment above).
function weeklyReadSignatureDiffers(saved: any): boolean {
  if (!saved || typeof saved !== "object") return false; // legacy, no signature → can't tell
  const cur = computeWeeklyReadSignature();
  if (Number(saved.week_sessions) !== cur.week_sessions) return true;
  if (String(saved.latest_doc_date ?? "") !== String(cur.latest_doc_date ?? "")) return true;
  if (weeklyKeysDiffer(saved.directive_keys, cur.directive_keys)) return true;
  const sw = saved.weight_bucket;
  const cw = cur.weight_bucket;
  if ((sw == null) !== (cw == null)) return true;
  if (sw != null && cw != null && Number(sw) !== Number(cw)) return true;
  if (Number(saved.latest_context_event_id ?? 0) !== Number(cur.latest_context_event_id ?? 0)) return true;
  return false;
}

export interface WeeklyReadFreshness {
  stale: boolean;
  as_of: string | null;
}

// The freshness verdict for a weekly_read insight row. Legacy / mismatched rows
// read as fresh (can't tell → never stale), matching the synthesis contract.
export function weeklyReadFreshness(weekly: any): WeeklyReadFreshness {
  const as_of = weekly?.created_at ? String(weekly.created_at).slice(0, 10) : null;
  if (!weekly || weekly.kind !== "weekly_read") return { stale: false, as_of };
  const stored = readWeeklyReadFreshness();
  if (!stored || stored.insight_id !== Number(weekly.id)) return { stale: false, as_of };
  return { stale: weeklyReadSignatureDiffers(stored.sig), as_of };
}

// Annotate the most-recent weekly_read row (the one the Today card shows) with a
// freshness verdict, and — when stale — DEFANG it: null the "one change"
// (next_step) and attach a calm stale_note so no surface asserts a moved-on
// action. Additive + copy-on-write (the DB row is never mutated); rows without a
// weekly read, or a fresh one, pass through untouched.
function annotateWeeklyReadFreshness(rows: any[]): any[] {
  const idx = Array.isArray(rows) ? rows.findIndex((r) => r && r.kind === "weekly_read") : -1;
  if (idx < 0) return rows;
  const { stale } = weeklyReadFreshness(rows[idx]);
  if (!stale) return rows;
  const copy = [...rows];
  copy[idx] = {
    ...rows[idx],
    stale: true,
    stale_note:
      "This was the week's read when it was written — your training, labs, or weight have moved since. Re-read it when you like.",
    next_step: null,
  };
  return copy;
}

// How many downvoted insight texts stay in the dedup corpus, beyond the recency
// window. A thumbs-down means "don't say this again" — so the theme has to keep
// suppressing new near-repeats even after it ages past `limit`. Bounded so the
// corpus can never grow without limit.
export const DOWNVOTED_DEDUP_LIMIT = 30;

// A compact, bounded list of recent insight TEXTS (any status) so the generator
// can tell the agent what it already said and avoid repeating a connection.
// Dedup is a soft prompt hint here; isDuplicateInsight() is the real guard.
// Downvoted insight texts are UNIONED in (beyond the recency window) so a
// connection the athlete waved off doesn't resurface once it scrolls past `limit`
// — a downvoted THEME stays suppressed, keeping the existing soft+real dedup shape.
export function recentInsightTexts(limit = 12): string[] {
  const recent = db
    .prepare(`SELECT text FROM insights ORDER BY id DESC LIMIT ?`)
    .all(limit)
    .map((r: any) => String(r?.text ?? "").trim())
    .filter(Boolean);
  const downvoted = db
    .prepare(`SELECT text FROM insights WHERE feedback = 'down' ORDER BY id DESC LIMIT ?`)
    .all(DOWNVOTED_DEDUP_LIMIT)
    .map((r: any) => String(r?.text ?? "").trim())
    .filter(Boolean);
  // Recent first (newest-first order preserved), then any downvoted not already present.
  const seen = new Set(recent);
  const out = [...recent];
  for (const t of downvoted) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// The other half of the same one-tap. A thumbs-DOWN already steers the generator —
// it suppresses the theme through the dedup corpus above — while a thumbs-UP did
// nothing at all, so the only feedback the athlete could give that changed anything
// was negative. These are the connections they said were worth having: a small,
// bounded "more like this" the generator can aim at. Never a template to copy (the
// dedup guard still refuses a near-repeat of any of them) — a direction only.
export const UPVOTED_STEER_LIMIT = 6;

export function upvotedInsightTexts(limit = UPVOTED_STEER_LIMIT): string[] {
  return db
    .prepare(`SELECT text FROM insights WHERE feedback = 'up' ORDER BY id DESC LIMIT ?`)
    .all(Math.max(1, Math.min(UPVOTED_STEER_LIMIT, limit)))
    .map((r: any) => String(r?.text ?? "").trim())
    .filter(Boolean);
}

// True when a candidate insight essentially repeats one of the recent ones:
// exact-after-normalize, or a high word-overlap (Jaccard) match. Keeps the
// quiet stream from echoing the same connection twice. Normalizes with the same
// forgiving rule as memory dedup (memNorm) so "the same connection reworded"
// collapses; unlike memory it keeps stopwords (short insight texts need them).
export function isDuplicateInsight(candidate: string, recent: string[] = recentInsightTexts()): boolean {
  const cand = memNorm(candidate);
  if (!cand) return true; // nothing to say is a no-op, never a fresh insight
  const candSet = new Set(cand.split(" "));
  for (const r of recent) {
    const rn = memNorm(r);
    if (!rn) continue;
    if (rn === cand) return true;
    if (jaccard(candSet, new Set(rn.split(" "))) >= 0.7) return true;
  }
  return false;
}

// ---------- source-agnostic daily metrics (Phase 5D — Apple Health etc.) ----------
export interface DailyMetricsInput {
  steps?: number | null;
  sleep_min?: number | null;
  sleep_score?: number | null;
  resting_hr?: number | null;
  hrv_ms?: number | null;
  active_calories?: number | null;
  total_calories?: number | null;
  distance_km?: number | null;
  exercise_min?: number | null;
  stand_hours?: number | null;
  spo2_avg?: number | null;
  vo2max?: number | null;
  raw?: any;
}

function realDailyMetricDate(value: unknown): string {
  const date = String(value ?? "");
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error("date must be a real YYYY-MM-DD");
  }
  if (date > localDateISO()) throw new Error("future dates are not accepted");
  return date;
}

function dailyMetricSource(value: unknown): string {
  const source = String(value || "apple").trim() || "apple";
  if (source.length > 64) throw new Error("source must be 64 characters or fewer");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate control-character rejection at the trust boundary
  if (/[\u0000-\u001f\u007f]/.test(source)) throw new Error("source contains control characters");
  return source;
}

function recoveryWindowDays(value: unknown, fallback = 14): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(1, Math.min(366, n)) : fallback;
}

// Upsert one source's metrics for a date (mirrors upsertGarminDailyMetric, but
// source-agnostic). `source` defaults to 'apple' — the documented Shortcuts path.
export function recordDailyMetrics(source: string, date: string, metrics: DailyMetricsInput = {}) {
  const src = dailyMetricSource(source);
  const metricDate = realDailyMetricDate(date);
  // Coerce/clamp at the trust boundary so non-numeric junk (e.g. steps:"abc" from
  // a hand-rolled Shortcut, which sqlite would otherwise store verbatim as TEXT in
  // an INTEGER column) never pollutes the metrics. Protects REST and MCP alike.
  const num = (v: any, lo: number, hi: number): number | null => {
    if (v == null || (typeof v === "string" && v.trim() === "")) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
  };
  // HealthKit reports oxygen saturation as a 0.0-1.0 FRACTION, not a percent — a
  // Shortcut posting 0.98 must not get clamped up into `num`'s 50-100 range and
  // stored as a scary-but-plausible 50%. Normalize a (0,1] fraction to percent
  // first, then REJECT (never clamp) anything still outside a plausible human
  // SpO2 reading, so a bad value surfaces as missing rather than a wrong number.
  const spo2Pct = (v: any): number | null => {
    if (v == null || (typeof v === "string" && v.trim() === "")) return null;
    let n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n > 0 && n <= 1) n *= 100;
    return n >= 50 && n <= 100 ? n : null;
  };
  const values = {
    steps: num(metrics.steps, 0, 200000),
    sleep_min: num(metrics.sleep_min, 0, 1440),
    sleep_score: num(metrics.sleep_score, 0, 100),
    resting_hr: num(metrics.resting_hr, 0, 250),
    hrv_ms: num(metrics.hrv_ms, 0, 500),
    active_calories: num(metrics.active_calories, 0, 20000),
    total_calories: num(metrics.total_calories, 0, 30000),
    distance_km: num(metrics.distance_km, 0, 1000),
    exercise_min: num(metrics.exercise_min, 0, 1440),
    stand_hours: num(metrics.stand_hours, 0, 24),
    spo2_avg: spo2Pct(metrics.spo2_avg),
    vo2max: num(metrics.vo2max, 5, 100),
  };
  db.prepare(
    `INSERT INTO daily_metrics
       (source, date, steps, sleep_min, sleep_score, resting_hr, hrv_ms, active_calories,
        total_calories, distance_km, exercise_min, stand_hours, spo2_avg, vo2max, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, date) DO UPDATE SET
       steps = COALESCE(excluded.steps, daily_metrics.steps),
       sleep_min = COALESCE(excluded.sleep_min, daily_metrics.sleep_min),
       sleep_score = COALESCE(excluded.sleep_score, daily_metrics.sleep_score),
       resting_hr = COALESCE(excluded.resting_hr, daily_metrics.resting_hr),
       hrv_ms = COALESCE(excluded.hrv_ms, daily_metrics.hrv_ms),
       active_calories = COALESCE(excluded.active_calories, daily_metrics.active_calories),
       total_calories = COALESCE(excluded.total_calories, daily_metrics.total_calories),
       distance_km = COALESCE(excluded.distance_km, daily_metrics.distance_km),
       exercise_min = COALESCE(excluded.exercise_min, daily_metrics.exercise_min),
       stand_hours = COALESCE(excluded.stand_hours, daily_metrics.stand_hours),
       spo2_avg = COALESCE(excluded.spo2_avg, daily_metrics.spo2_avg),
       vo2max = COALESCE(excluded.vo2max, daily_metrics.vo2max),
       raw_json = COALESCE(excluded.raw_json, daily_metrics.raw_json), updated_at = datetime('now')`
  ).run(
    src,
    metricDate,
    values.steps,
    values.sleep_min,
    values.sleep_score,
    values.resting_hr,
    values.hrv_ms,
    values.active_calories,
    values.total_calories,
    values.distance_km,
    values.exercise_min,
    values.stand_hours,
    values.spo2_avg,
    values.vo2max,
    jsonOrNull(metrics.raw)
  );
  bumpTrainingDataVersion(); // fresh recovery (in-place upsert) shifts program-state's deload read
  // Fresh recovery data CAN change today's Brief — but a six-hourly sync where sleep,
  // HRV and resting HR each drift a few points crosses none of the thresholds the read
  // branches on. Retire the cached read only when the decision actually moved, so
  // ordinary telemetry stops costing the athlete their coach's sentence.
  invalidateDayReadIfDecisionChanged();
  const row = hydrateJson(db.prepare(`SELECT * FROM daily_metrics WHERE source = ? AND date = ?`).get(src, metricDate));
  emitBrainEvent({
    kind: "recovery_metrics_changed",
    domain: "recovery",
    date: metricDate,
    entity_id: row?.id ?? `${src}:${metricDate}`,
    subject_key: src,
  });
  return row;
}

// Recent rows for a source (or all sources) over the last `days`.
export function getDailyMetrics(source?: string | null, days = 30) {
  const windowDays = recoveryWindowDays(days, 30);
  const today = localDateISO();
  const since = localDateISO(new Date(Date.now() - Math.max(0, windowDays - 1) * 864e5));
  const src = source == null ? null : dailyMetricSource(source);
  const rows = src
    ? (db
        .prepare(`SELECT * FROM daily_metrics WHERE source = ? AND date >= ? AND date <= ? ORDER BY date DESC, id DESC`)
        .all(src, since, today) as any[])
    : (db
        .prepare(`SELECT * FROM daily_metrics WHERE date >= ? AND date <= ? ORDER BY date DESC, id DESC`)
        .all(since, today) as any[]);
  return rows.map((r) => hydrateJson(r));
}

// ---------- unified recovery summary (Phase 5D) ----------
// Quality-aware SOURCE-AGNOSTIC recovery: resolve each date and each field
// independently, preferring Garmin only where it has an overlapping value. This
// lets complementary Apple/Oura data survive without double-counting a date.
// Garmin training_readiness is 0-100; the constitution forbids surfacing the number.
// Band it into plain words for prompts + gating: low (<35), primed (>=70), else steady.
// null when there's no reading, so every consumer degrades quietly.
export function readinessBand(value: unknown): "low" | "steady" | "primed" | null {
  if (value == null || value === "") return null; // guard Number(null)===0 → never a false "low"
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 35) return "low";
  if (n >= 70) return "primed";
  return "steady";
}

export function getRecoverySummary(days = 14, garminSummary?: any, asOfDate = localDateISO()) {
  const windowDays = recoveryWindowDays(days, 14);
  const requestedAsOf = String(asOfDate || localDateISO());
  const parsedAsOf = /^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf) ? new Date(`${requestedAsOf}T00:00:00Z`) : null;
  if (!parsedAsOf || Number.isNaN(parsedAsOf.getTime()) || parsedAsOf.toISOString().slice(0, 10) !== requestedAsOf) {
    throw new Error("as-of date must be a real YYYY-MM-DD");
  }
  const today = requestedAsOf;
  // A caller-supplied aggregate cannot be safely rewound. Preserve the existing
  // current-date injection path, but rebuild Garmin's summary for historical reads.
  const garmin =
    today === localDateISO() && garminSummary != null ? garminSummary : getGarminCoachSummary(windowDays, today);
  const fields = [
    "steps",
    "sleep_min",
    "sleep_score",
    "resting_hr",
    "hrv_ms",
    // Never surfaced on its own — it rides here so a resting-HR reading can be checked
    // against its own row's floor. See READING_TRUST below.
    "min_hr",
    "active_calories",
    "total_calories",
    "distance_km",
    "exercise_min",
    "stand_hours",
    "spo2_avg",
    "vo2max",
    "deep_sleep_min",
    "rem_sleep_min",
    "stress_avg",
    "body_battery_avg",
    "body_battery_max",
    "respiration_avg",
    "skin_temp_dev_c",
    "intensity_min_vigorous",
    "training_readiness",
    "acute_load",
    "fitness_age",
    "training_status",
    "hrv_status",
    "weight_kg",
    "body_fat_pct",
    "muscle_mass_kg",
    "endurance_score",
    "hill_score",
    "race_predict_5k_sec",
    "race_predict_10k_sec",
    "race_predict_half_sec",
    "race_predict_marathon_sec",
    "training_load_balance",
  ] as const;
  type Signal = (typeof fields)[number];
  type ResolvedRow = { date: string; values: Partial<Record<Signal, any>>; sources: Partial<Record<Signal, string>> };
  const resolveRows = (winDays: number): ResolvedRow[] => {
    const since = addDaysISO(today, -Math.max(0, winDays - 1)) ?? today;
    const generic = db
      .prepare(`SELECT * FROM daily_metrics WHERE date >= ? AND date <= ? ORDER BY date DESC, updated_at DESC, id DESC`)
      .all(since, today) as Record<string, any>[];
    const garminRows = db
      .prepare(
        `SELECT * FROM garmin_daily_metrics WHERE date >= ? AND date <= ? ORDER BY date DESC, updated_at DESC, id DESC`
      )
      .all(since, today) as Record<string, any>[];
    const dates = new Map<string, ResolvedRow>();
    const at = (date: string) => {
      if (!dates.has(date)) dates.set(date, { date, values: {}, sources: {} });
      return dates.get(date)!;
    };
    // Generic sources resolve PER FIELD, not per whole row. Thus an Apple steps
    // value and an Oura sleep value on the same date both survive.
    for (const row of generic) {
      const out = at(String(row.date));
      for (const field of fields) {
        if (row[field] != null && out.values[field] == null) {
          out.values[field] = row[field];
          out.sources[field] = String(row.source || "other");
        }
      }
    }
    // Garmin is preferred only where it actually has the overlapping field;
    // complementary generic values remain intact.
    for (const row of [...garminRows].reverse()) {
      const out = at(String(row.date));
      const mapped: Record<string, any> = { ...row };
      mapped.distance_km = row.distance_m == null ? null : Number(row.distance_m) / 1000;
      mapped.exercise_min =
        [row.intensity_min_moderate, row.intensity_min_vigorous]
          .filter((v) => v != null)
          .reduce((sum, v) => sum + Number(v), 0) || null;
      for (const field of fields) {
        if (mapped[field] != null) {
          out.values[field] = mapped[field];
          out.sources[field] = "garmin";
        }
      }
    }
    return [...dates.values()].sort((a, b) => b.date.localeCompare(a.date));
  };
  const rows = resolveRows(windowDays);
  // Garmin can estimate VO2max on an activity even when its daily maxmet feed is
  // absent. Preserve that fallback from getGarminCoachSummary in the unified
  // resolver so value, provenance, coverage, and freshness stay aligned.
  if (!rows.some((row) => row.values.vo2max != null)) {
    const activityVo2 = garmin?.quality?.vo2max;
    if (
      activityVo2?.source === "garmin_activity" &&
      activityVo2.latest_value != null &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(activityVo2.latest_date ?? "")) &&
      String(activityVo2.latest_date) <= today &&
      String(activityVo2.latest_date) >= (addDaysISO(today, -Math.max(0, windowDays - 1)) ?? today)
    ) {
      rows.push({
        date: String(activityVo2.latest_date),
        values: { vo2max: activityVo2.latest_value },
        sources: { vo2max: "garmin_activity" },
      });
      rows.sort((a, b) => b.date.localeCompare(a.date));
    }
  }
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const average = (field: Signal, list = rows): number | null => {
    const values = list
      .filter((row) => row.values[field] != null)
      .map((row) => Number(row.values[field]))
      .filter(Number.isFinite);
    return values.length ? round1(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  };
  // Robust centre for the recent-vs-baseline windows below. A single junk wearable
  // day — a daytime-only-wear resting HR of 118 against a 55 norm — shifts a
  // 7-value MEAN by roughly 9 bpm, which is enough on its own to manufacture a
  // "resting heart rate above the athlete's norm" caution every morning. The
  // median ignores it. Only `recent`/`baseline`/`delta` use this; the surfaced
  // `avg_*` figures keep the arithmetic mean, so nothing displayed changes.
  const median = (field: Signal, list = rows): number | null => {
    const values = list
      .filter((row) => row.values[field] != null)
      .map((row) => Number(row.values[field]))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (!values.length) return null;
    const mid = values.length >> 1;
    return round1(values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2);
  };
  const freshness = (date: string | null): "fresh" | "recent" | "stale" | "missing" => {
    if (!date) return "missing";
    const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 864e5);
    return age <= 1 ? "fresh" : age <= 3 ? "recent" : "stale";
  };
  // ---- coverage: how much of each series there actually IS -------------------
  // The recent-vs-baseline `delta` at the bottom of this function is the single
  // choke point every "below your norm" read in the codebase flows through — the
  // signal state's hrv_below/resting_hr_up, day-read's recoveryDrift, the run
  // plan's hrvDown/rhrUp/sleepDown, the coach prompt's vs-norm block. Until now
  // it was a median of "whatever happens to be in the window" with NO minimum n,
  // so an athlete who wears the watch episodically — every run, the odd baseline
  // night — could have a two-night "week" compared against a four-night "month"
  // and get a confident trend out of it.
  //
  // The floors below are per FIELD, not per row: a week with three HRV nights and
  // one resting-HR night must be able to speak about HRV and stay quiet about
  // resting HR. Below the floor the delta is null, which every consumer already
  // treats as absence — and absence is neutral (VISION.md), so a thin series can
  // never push toward rest. `recent`/`baseline` keep reporting their medians:
  // the readings themselves are real, it is only the COMPARISON that is withheld.
  const DELTA_RECENT_DAYS = 7;
  const DELTA_BASELINE_DAYS = 30;
  // Three readings is the smallest set a median can resist one bad night in; five
  // is the matching floor for the longer window it is measured against.
  const DELTA_MIN_RECENT_N = 3;
  const DELTA_MIN_BASELINE_N = 5;
  // The metric each delta key compares. (Nothing else in the summary is deltaed.)
  const DELTA_FIELDS: Record<"sleep" | "hrv" | "rhr", Signal> = {
    sleep: "sleep_min",
    hrv: "hrv_ms",
    rhr: "resting_hr",
  };
  // ONE bounded 90-day pass feeds both the wear-pattern classification and the
  // 7/30-day delta windows. resolveRows is a pure date-window filter over the same
  // two tables, so slicing its 90-day result by date is identical to re-querying
  // the shorter windows — and two queries cheaper than the pair this replaces.
  const cadenceRows = resolveRows(CADENCE_WINDOW_DAYS);
  const withinDays = (list: ResolvedRow[], winDays: number): ResolvedRow[] => {
    const since = addDaysISO(today, -Math.max(0, winDays - 1)) ?? today;
    return list.filter((row) => row.date >= since);
  };
  const datesOf = (field: Signal, list: ResolvedRow[]): string[] =>
    list.filter((row) => row.values[field] != null).map((row) => row.date);
  const countOf = (field: Signal, list: ResolvedRow[]): number =>
    list.filter((row) => row.values[field] != null && Number.isFinite(Number(row.values[field]))).length;

  // ---------- IS THIS READING VERIFIED, OR IS IT THE WATCH GUESSING? ----------
  //
  // A daily resting-HR row is not automatically a measured overnight resting heart
  // rate. Garmin writes a PROVISIONAL estimate during the day and revises it once it
  // has actually seen a night, and on a wrist the watch is worn episodically that
  // revision may never come. Live on 2026-08-03 the row said resting HR 68 — the
  // highest ever recorded — and it was written 16:55, mid-afternoon, with no
  // `sleep_min` for the date at all and a `min_hr` of 50 on the very same row. A
  // resting heart rate eighteen beats above the day's own floor is not a resting
  // heart rate. Meanwhile every sleep-backed row that month read 50-54 and steady.
  //
  // So each reading is classified ONCE, here, where the rows are resolved — never at
  // each consumer, which is how three call sites come to hold three opinions about
  // the same number:
  //
  //   verified       the value's OWN source shows the overnight it claims to describe:
  //                  a same-source night, or a same-source `min_hr` consistent with it
  //                  (a true resting HR sits just above the day's floor — 1-3 bpm apart
  //                  in every sleep-backed row on record) — and the value is possible.
  //   contradicted   the same source's `min_hr` argues with the value: below the day's
  //                  own minimum (impossible), or implausibly far above it. This is the
  //                  provisional mid-day estimate, and it is the ONLY class that gets
  //                  actively withheld.
  //   uncorroborated no test can run — no same-source night, no same-source `min_hr`
  //                  (a generic Apple or Oura row carries no `min_hr` at all) — or the
  //                  number is outside human resting range. Not evidence of a problem;
  //                  just nothing to check against.
  //
  // Only `verified` may open the excursion path in the signal state (a caution has to
  // clear a higher bar than a number does), and only `contradicted` is dropped from
  // the trend windows. `uncorroborated` keeps counting exactly as it always has —
  // absence of corroboration is not contradiction, and treating it as such would
  // silently delete the trend for every non-Garmin wearable.
  // THE RULE, in one sentence: a reading is verified when its OWN source also
  // provided evidence that its own sampling covered a rest window — either a
  // coherent same-source `min_hr`, or a same-source night of at least two hours —
  // and the value itself is physiologically possible. Absent that evidence it is
  // uncorroborated. Only a same-source `min_hr` can contradict.
  //
  // "Same source" is the load-bearing word, and it is keyed off `row.sources[field]`
  // — field provenance — never off a vendor name. `resolveRows` merges PER FIELD
  // across feeds, so a date can legitimately hold an Apple resting HR beside a
  // Garmin min HR from a watch that was on the charger all night. Two devices
  // disagreeing about a day's floor is not a device contradicting itself: a
  // cross-source `sleep_min` corroborates nothing, and a cross-source `min_hr`
  // contradicts nothing.
  //
  // A resting HR just above the day's floor is the coherence signature (1-3 bpm
  // apart in every sleep-backed row on record). The tolerance is relative rather
  // than a flat 5 bpm, so an athlete whose floor sits at 70 is not told their own
  // 77 argues with it; at a floor of 50 it is exactly 5, so the calibration this
  // was tuned on is unchanged.
  const RESTING_HR_FLOOR_MARGIN = 5;
  const RESTING_HR_FLOOR_MARGIN_RATIO = 0.1;
  // Two hours is the shortest thing worth calling a night. A phone that recorded a
  // 20-minute Sleep-Focus window saw a nap at most, and must not certify a resting
  // heart rate on the strength of it. Below the floor the row falls through to the
  // next test rather than to `contradicted` — a short night is thin evidence, not
  // counter-evidence.
  const SLEEP_WITNESS_MIN_MINUTES = 120;
  // Physiological band, inherited from the Garmin ingest gate (`credibleSummaryRestingHr`).
  // Generic ingest deliberately keeps storing whatever the phone said — the value stays
  // visible and stays in the trend — but a figure this far outside human resting range is
  // a wear artifact, and no witness may promote it to `verified`. An athlete with a true
  // resting HR of 92 loses only the excursion path, by design.
  const RESTING_HR_PLAUSIBLE_MIN = 30;
  const RESTING_HR_PLAUSIBLE_MAX = 90;
  type ReadingTrust = "verified" | "contradicted" | "uncorroborated";
  const READING_TRUST = (row: ResolvedRow, field: "resting_hr" | "hrv_ms"): ReadingTrust => {
    if (row.values[field] == null) return "uncorroborated";
    const source = row.sources[field] ?? null;
    // A witness only speaks for values from its own feed.
    const witness = (key: Signal): number | null => {
      if (source == null || row.values[key] == null || row.sources[key] !== source) return null;
      const value = Number(row.values[key]);
      return Number.isFinite(value) ? value : null;
    };
    const resting = row.values.resting_hr == null ? null : Number(row.values.resting_hr);
    const restingPlausible =
      resting == null ||
      (Number.isFinite(resting) && resting >= RESTING_HR_PLAUSIBLE_MIN && resting <= RESTING_HR_PLAUSIBLE_MAX);
    // ORDER MATTERS. The coherence test runs BEFORE the plausibility band, because an
    // implausible figure beside a same-source floor is the exact shape of the mid-day
    // provisional estimate this whole classifier exists to withhold: 105 beside a
    // min_hr of 50 is contradicted evidence, not missing evidence, and only
    // `contradicted` is dropped from the trend windows. Short-circuiting on the band
    // first would return `uncorroborated` and let that number into the median.
    //
    // The HR coherence check speaks for the whole ROW, not just for resting HR: it
    // answers "did this row's sampling include the sleep window", which is the same
    // question that decides whether its HRV figure means anything either.
    const floor = witness("min_hr");
    const coherent =
      floor == null || resting == null || !Number.isFinite(resting)
        ? null // no same-source floor to test against
        : resting >= floor && resting - floor <= Math.max(RESTING_HR_FLOOR_MARGIN, RESTING_HR_FLOOR_MARGIN_RATIO * floor);
    if (coherent === false) return "contradicted";
    // A row that recorded a real night saw the overnight context both resting HR and
    // HRV are derived from, so it verifies either of them.
    const night = witness("sleep_min");
    const verified = coherent === true || (night != null && night >= SLEEP_WITNESS_MIN_MINUTES);
    if (!verified) return "uncorroborated";
    // The band DEMOTES a would-be verified reading; it never promotes or contradicts.
    // An implausible resting HR may not be certified, and (because the coherence check
    // leans on that same figure) it cannot vouch for the row's HRV either.
    if (!restingPlausible && (field === "resting_hr" || coherent === true)) return "uncorroborated";
    return "verified";
  };
  const trustworthy = (list: ResolvedRow[], field: "resting_hr" | "hrv_ms"): ResolvedRow[] =>
    list.filter((row) => READING_TRUST(row, field) !== "contradicted");
  const recentRows = withinDays(cadenceRows, DELTA_RECENT_DAYS);
  const baselineRows = withinDays(cadenceRows, DELTA_BASELINE_DAYS);

  // Days in the recent window that carry real training — a session with at least
  // one logged set, or a logged activity. An EMPTY session row (the app opening a
  // day) is deliberately not training: it would make every day a training day.
  const recentSince = addDaysISO(today, -Math.max(0, DELTA_RECENT_DAYS - 1)) ?? today;
  const trainingDays = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT s.date AS date FROM sessions s
            WHERE s.date >= ? AND s.date <= ?
              AND EXISTS (SELECT 1 FROM logged_sets ls WHERE ls.session_id = s.id)
           UNION
           SELECT DISTINCT a.date AS date FROM activities a WHERE a.date >= ? AND a.date <= ?`
        )
        .all(recentSince, today, recentSince, today) as { date: string }[]
    ).map((row) => String(row.date))
  );
  // A cluster needs at least two dots — one reading on one training day is a
  // coincidence, not a sampling bias.
  const TRAINING_BIAS_MIN_READINGS = 2;
  const TRAINING_BIAS_RATIO = 0.7;
  // Does this field's recent series sit mostly on days the athlete trained? For an
  // episodic wearer that is the normal shape (the watch goes on for the run), and
  // it means the "norm" is built from post-exertion mornings. ANNOTATION ONLY —
  // nothing downstream may branch on it; it exists so the prompt can say so.
  const trainingDayBiased = (field: Signal, pattern: WearPattern): boolean => {
    if (pattern === "continuous" || pattern === "none") return false;
    const dates = datesOf(field, recentRows);
    if (dates.length < TRAINING_BIAS_MIN_READINGS) return false;
    const onTraining = dates.filter((date) => trainingDays.has(date)).length;
    return onTraining / dates.length >= TRAINING_BIAS_RATIO;
  };

  const quality: Record<string, any> = {};
  for (const field of fields) {
    const latest = rows.find((row) => row.values[field] != null);
    const contributing = rows.filter((row) => row.values[field] != null);
    quality[field] = {
      latest_value: latest?.values[field] ?? null,
      latest_date: latest?.date ?? null,
      source: latest ? (latest.sources[field] ?? null) : null,
      sources: [...new Set(contributing.map((row) => row.sources[field]).filter(Boolean))],
      sample_count: contributing.length,
      expected_days: windowDays,
      window_days: windowDays,
      freshness: freshness(latest?.date ?? null),
    };
  }
  // The three delta fields carry their coverage story on the same `quality` entry
  // consumers already read (it is the one map that survives the prompt-boundary
  // projection, so the agent sees exactly what the deterministic layer saw).
  const deltaReady: Record<"sleep" | "hrv" | "rhr", boolean> = { sleep: false, hrv: false, rhr: false };
  for (const [key, field] of Object.entries(DELTA_FIELDS) as ["sleep" | "hrv" | "rhr", Signal][]) {
    // Counted over the same rows the medians are taken from, so a window whose
    // coverage is made up of contradicted mid-day estimates cannot report itself
    // ready for a comparison it has no readings to make.
    const countable = (list: ResolvedRow[]) =>
      field === "resting_hr" || field === "hrv_ms" ? trustworthy(list, field) : list;
    const recentN = countOf(field, countable(recentRows));
    const baselineN = countOf(field, countable(baselineRows));
    const ready = recentN >= DELTA_MIN_RECENT_N && baselineN >= DELTA_MIN_BASELINE_N;
    deltaReady[key] = ready;
    const cadence = classifyWearPattern(datesOf(field, cadenceRows), today, CADENCE_WINDOW_DAYS);
    Object.assign(quality[field], {
      recent_n: recentN,
      baseline_n: baselineN,
      recent_days: DELTA_RECENT_DAYS,
      baseline_days: DELTA_BASELINE_DAYS,
      delta_ready: ready,
      cadence,
      // Sleep is not annotated: a night is measured while asleep, not while
      // training, so "the reading landed on a training day" says nothing about it.
      ...(field === "sleep_min" ? {} : { training_day_biased: trainingDayBiased(field, cadence.pattern) }),
    });
  }
  const current = (field: Signal) => quality[field].latest_value;
  const recovery: Record<string, any> = {
    avg_sleep_min: average("sleep_min"),
    avg_sleep_score: average("sleep_score"),
    avg_resting_hr: average("resting_hr"),
    avg_hrv_ms: average("hrv_ms"),
    avg_stress: average("stress_avg"),
    avg_body_battery: average("body_battery_avg"),
    avg_active_calories: average("active_calories"),
    avg_total_calories: average("total_calories"),
    avg_steps: average("steps"),
    avg_distance_km: average("distance_km"),
    avg_exercise_min: average("exercise_min"),
    avg_stand_hours: average("stand_hours"),
    avg_deep_sleep_min: average("deep_sleep_min"),
    avg_rem_sleep_min: average("rem_sleep_min"),
    avg_body_battery_max: average("body_battery_max"),
    avg_respiration: average("respiration_avg"),
    avg_spo2: average("spo2_avg"),
    avg_skin_temp_dev_c: average("skin_temp_dev_c"),
    avg_vigorous_min: average("intensity_min_vigorous"),
    avg_training_readiness: average("training_readiness"),
    // Current is always the latest dated non-null reading; averages remain separate.
    sleep_min: current("sleep_min"),
    resting_hr: current("resting_hr"),
    hrv_ms: current("hrv_ms"),
    steps: current("steps"),
    active_calories: current("active_calories"),
    total_calories: current("total_calories"),
    distance_km: current("distance_km"),
    exercise_min: current("exercise_min"),
    stand_hours: current("stand_hours"),
    hrv_status: current("hrv_status"),
    spo2_avg: current("spo2_avg"),
    skin_temp_dev_c: current("skin_temp_dev_c"),
    training_readiness: current("training_readiness"),
    // Banded plain-words read of the CURRENT 0-100 readiness (the constitution bans
    // surfacing the number). Additive + null-safe: null when there's no reading. low
    // (<35) is the conservative "clearly low" gate the run plan / day read weigh.
    readiness_band: readinessBand(current("training_readiness")),
    training_status: current("training_status"),
    acute_load: current("acute_load"),
    fitness_age: current("fitness_age"),
    vo2max: current("vo2max"),
    weight_kg: current("weight_kg"),
    body_fat_pct: current("body_fat_pct"),
    muscle_mass_kg: current("muscle_mass_kg"),
    endurance_score: current("endurance_score"),
    hill_score: current("hill_score"),
    race_predict_5k_sec: current("race_predict_5k_sec"),
    race_predict_10k_sec: current("race_predict_10k_sec"),
    race_predict_half_sec: current("race_predict_half_sec"),
    race_predict_marathon_sec: current("race_predict_marathon_sec"),
    training_load_balance: current("training_load_balance"),
    last_date: rows.find((row) => Object.keys(row.values).length)?.date ?? null,
    quality,
  };
  const medians = (list: ResolvedRow[]) => ({
    // Sleep is self-verifying — a sleep figure IS the overnight — so it is untouched.
    sleep: median("sleep_min", list),
    hrv: median("hrv_ms", trustworthy(list, "hrv_ms")),
    rhr: median("resting_hr", trustworthy(list, "resting_hr")),
  });
  const recent = medians(recentRows);
  const baseline = medians(baselineRows);
  // The athlete's OWN night-to-night spread over the same baseline window the
  // medians above are taken from — the input to the smallest-worthwhile-change band
  // (recoveryTrendBars). Taken over exactly the rows the median is taken over, so a
  // contradicted mid-day estimate cannot inflate the spread it is already excluded
  // from, and null below its own sample floor. Null is the whole of its authority:
  // absent it, every band is byte-identical to what it was before.
  const valuesOf = (field: Signal, list: ResolvedRow[]): number[] =>
    list.map((row) => Number(row.values[field])).filter((value) => Number.isFinite(value));
  const dispersion = {
    sleep: sampleSd(valuesOf("sleep_min", baselineRows)),
    hrv: sampleSd(valuesOf("hrv_ms", trustworthy(baselineRows, "hrv_ms"))),
    rhr: sampleSd(valuesOf("resting_hr", trustworthy(baselineRows, "resting_hr"))),
  };
  const diff = (a: number | null, b: number | null) => (a != null && b != null ? round1(a - b) : null);
  // The floor lands HERE and nowhere else: a delta that has not earned its
  // coverage is null, and every consumer downstream already reads null as "no
  // such signal". The medians above stay reported — they are honest numbers, and
  // withholding them would hide the readings rather than the trend claim.
  const delta = {
    sleep: deltaReady.sleep ? diff(recent.sleep, baseline.sleep) : null,
    hrv: deltaReady.hrv ? diff(recent.hrv, baseline.hrv) : null,
    rhr: deltaReady.rhr ? diff(recent.rhr, baseline.rhr) : null,
  };
  // The VERIFIED series each excursion test is allowed to reason from, newest first,
  // plus what the newest reading of any kind actually was — so a consumer can say
  // "the latest figure is provisional" without having to re-derive that itself. The
  // 90-day `cadenceRows` is the source rather than the display window, because
  // continuity ("is this the second one in a row?") is a question about consecutive
  // READINGS on an episodically-worn watch, not about consecutive calendar days.
  const verifiedSeries = (field: "resting_hr" | "hrv_ms") => {
    const readings = cadenceRows
      .filter((row) => READING_TRUST(row, field) === "verified")
      .map((row) => ({ date: row.date, value: Number(row.values[field]) }))
      .filter((entry) => Number.isFinite(entry.value));
    const newest = cadenceRows.find((row) => row.values[field] != null) ?? null;
    // The newest reading any CLAIM about this field may be dated to: the medians
    // above are taken over exactly the non-contradicted rows, so stamping a trend
    // with the date of a reading that was excluded from it would recreate the
    // original bug — a sentence pointing at a number it never looked at.
    const newestTrustworthy =
      cadenceRows.find((row) => row.values[field] != null && READING_TRUST(row, field) !== "contradicted") ?? null;
    return {
      readings,
      latest_date: newest?.date ?? null,
      latest_value: newest == null ? null : Number(newest.values[field]),
      latest_trust: newest ? READING_TRUST(newest, field) : ("uncorroborated" as ReadingTrust),
      latest_trustworthy_date: newestTrustworthy?.date ?? null,
    };
  };
  const verified = { resting_hr: verifiedSeries("resting_hr"), hrv_ms: verifiedSeries("hrv_ms") };
  const sources = [...new Set(Object.values(quality).flatMap((entry: any) => entry.sources ?? []))] as string[];
  const surfaced = Object.entries(recovery).filter(([key]) => key !== "last_date" && key !== "quality");
  const has_data = surfaced.some(([, value]) => value != null);
  const coverage = Object.fromEntries(
    Object.entries(quality).map(([key, value]: [string, any]) => [
      key,
      {
        sample_count: value.sample_count,
        expected_days: value.expected_days,
        window_days: value.window_days,
      },
    ])
  );
  const provenance = Object.fromEntries(
    Object.entries(quality).map(([key, value]: [string, any]) => [
      key,
      {
        source: value.source,
        sources: value.sources,
        latest_date: value.latest_date,
        freshness: value.freshness,
      },
    ])
  );
  return {
    days: windowDays,
    since: addDaysISO(today, -Math.max(0, windowDays - 1)) ?? today,
    sources,
    has_data,
    recovery,
    quality,
    coverage,
    provenance,
    recent,
    baseline,
    delta,
    dispersion,
    verified,
    activities: (garmin?.activities ?? []).filter((activity: any) => {
      const date = String(activity?.date ?? activity?.last_date ?? "");
      return !date || date <= today;
    }),
    hard_sessions: (garmin?.hard_sessions ?? []).filter((session: any) => String(session?.date ?? "") <= today),
  };
}

// The most recent SINGLE night's sleep + HRV, in plain numbers plus a calm
// one-line summary — so the Brief can name LAST NIGHT (the recovery aggregates
// above are 7/30-day windows and can't). Garmin is preferred (it has the
// architecture: deep / REM / light); the source-agnostic daily_metrics
// (Apple Health / Oura / Whoop) is the fallback (total + HRV). HRV is compared to
// the athlete's own 30-day norm for a "steady / below your norm" read — never a
// score. Null-safe: no sleep data anywhere → null.
//
// `maxAgeDays` is REQUIRED, and deliberately so. This query is the dangerous
// shape sensor-freshness.ts names by hand — "give me the most recent row" with no
// lower bound — and its output is present-tense prose ("7h12m sleep, HRV steady")
// that reads as LAST NIGHT at any age. For a long time exactly one caller gated
// it, from the outside; a second caller would have inherited a month-old night
// silently. The age law now lives INSIDE the function: past the bound this
// returns null, which is the same neutral absence a watch left in a drawer
// already produces. Pass SENSOR_MAX_AGE_DAYS.sleep unless you have a considered
// reason not to.
//
// `asOf` is the day being read (default today). Nights AFTER it are not visible:
// a historical read must not be handed a future night, and a future-dated row is
// a clock problem rather than evidence.
export function latestSleep(
  maxAgeDays: number,
  asOf: string = localDateISO()
): {
  date: string;
  source: string;
  total_min: number | null;
  deep_min: number | null;
  rem_min: number | null;
  light_min: number | null;
  awake_min: number | null;
  hrv_ms: number | null;
  hrv_status: string | null;
  resting_hr: number | null;
  sleep_score: number | null;
  hrv_vs_baseline: number | null;
  text: string;
} | null {
  const readAsOf = /^\d{4}-\d{2}-\d{2}$/.test(String(asOf ?? "")) ? String(asOf) : localDateISO();
  const g = db
    .prepare(
      `SELECT date, sleep_min, sleep_score, resting_hr, hrv_ms, hrv_status,
            deep_sleep_min, light_sleep_min, rem_sleep_min, awake_min
       FROM garmin_daily_metrics
      WHERE sleep_min IS NOT NULL AND sleep_min > 0 AND date <= ?
      ORDER BY date DESC LIMIT 1`
    )
    .get(readAsOf) as any;
  const o = db
    .prepare(
      `SELECT date, source, sleep_min, sleep_score, resting_hr, hrv_ms
       FROM daily_metrics
      WHERE sleep_min IS NOT NULL AND sleep_min > 0 AND date <= ?
      ORDER BY date DESC LIMIT 1`
    )
    .get(readAsOf) as any;

  // Most recent night wins; Garmin breaks a tie (richer architecture).
  let row: any = null,
    source = "";
  if (g && o) {
    if (o.date > g.date) {
      row = o;
      source = o.source || "apple";
    } else {
      row = g;
      source = "garmin";
    }
  } else if (g) {
    row = g;
    source = "garmin";
  } else if (o) {
    row = o;
    source = o.source || "apple";
  }
  if (!row) return null;
  // The age law, inside. A night older than the bound is not last night, so it
  // does not get to speak at all (stale behaves as absent, never as current).
  const age = sensorAgeDays(row.date, readAsOf);
  if (age == null || age < 0 || !(age <= Number(maxAgeDays))) return null;

  // 30-day HRV baseline (same source family) up to — not including — last night.
  // For the non-Garmin family, resolve HRV per date/per field (newest source row
  // carrying HRV wins) so complementary metrics do not erase it or double-weight.
  const since30 = localDateISO(new Date(Date.now() - 29 * 864e5));
  const hb: any =
    source === "garmin"
      ? db
          .prepare(
            `SELECT ROUND(AVG(hrv_ms),1) AS h, COUNT(hrv_ms) AS n FROM garmin_daily_metrics
      WHERE date >= ? AND date < ? AND hrv_ms IS NOT NULL`
          )
          .get(since30, row.date)
      : db
          .prepare(
            `SELECT ROUND(AVG(dm.hrv_ms),1) AS h, COUNT(dm.hrv_ms) AS n FROM daily_metrics dm
         WHERE dm.date >= ? AND dm.date < ? AND dm.hrv_ms IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM daily_metrics newer
              WHERE newer.date = dm.date AND newer.hrv_ms IS NOT NULL
                AND (newer.updated_at > dm.updated_at OR (newer.updated_at = dm.updated_at AND newer.id > dm.id))
           )`
          )
          .get(since30, row.date);
  // "Your norm" is a COVERAGE claim as much as a value one. This average used to
  // be taken over whatever happened to exist — for an episodic wearer that can be
  // ONE prior night, and a single night is not a norm. Below the floor there is no
  // baseline, so `hrv_vs_baseline` is null and the text below simply prints the
  // reading with no "below/above your norm" (and no "steady" either — claiming
  // steadiness against one night is the same overclaim wearing a calmer word).
  const HRV_NORM_MIN_NIGHTS = 5;
  const baselineHrv = Number(hb?.n ?? 0) >= HRV_NORM_MIN_NIGHTS ? (hb?.h ?? null) : null;
  const hrvDelta = row.hrv_ms != null && baselineHrv != null ? Math.round((row.hrv_ms - baselineHrv) * 10) / 10 : null;

  const hm = (m: number) => {
    const h = Math.floor(m / 60),
      mm = Math.round(m % 60);
    return h > 0 ? `${h}h${mm > 0 ? String(mm).padStart(2, "0") + "m" : ""}` : `${mm}m`;
  };
  const parts: string[] = [];
  if (row.sleep_min != null) parts.push(`${hm(Math.round(row.sleep_min))} sleep`);
  const arch: string[] = [];
  if (row.deep_sleep_min != null) arch.push(`${hm(Math.round(row.deep_sleep_min))} deep`);
  if (row.rem_sleep_min != null) arch.push(`${hm(Math.round(row.rem_sleep_min))} REM`);
  if (arch.length) parts.push(arch.join(", "));
  if (row.hrv_ms != null) {
    let h = `HRV ${Math.round(row.hrv_ms)}ms`;
    if (hrvDelta != null) {
      const big = baselineHrv && Math.abs(hrvDelta) >= Math.max(3, baselineHrv * 0.08);
      h += big ? (hrvDelta < 0 ? " (below your norm)" : " (above your norm)") : " (steady)";
    }
    parts.push(h);
  }
  if (row.resting_hr != null) parts.push(`resting HR ${Math.round(row.resting_hr)}`);

  const r = (v: any) => (v != null ? Math.round(v) : null);
  return {
    date: row.date,
    source,
    total_min: r(row.sleep_min),
    deep_min: r(row.deep_sleep_min),
    rem_min: r(row.rem_sleep_min),
    light_min: r(row.light_sleep_min),
    awake_min: r(row.awake_min),
    hrv_ms: r(row.hrv_ms),
    hrv_status: row.hrv_status ?? null,
    resting_hr: r(row.resting_hr),
    sleep_score: row.sleep_score ?? null,
    hrv_vs_baseline: hrvDelta,
    text: parts.join(" · "),
  };
}
