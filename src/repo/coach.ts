import { db } from "../db.js";
import { canonicalMarker } from "./marker-canon.js";
import { getGarminCoachSummary, hydrateJson, jsonOrNull, listActivities } from "./activities.js";
import { getLatestHealthReview, hydrateHealthDoc, listContextEvents } from "./health.js";
import { dayRead, getCachedDayRead, invalidateDayRead } from "./intelligence.js";
import { blockForCoach, getActiveBlock } from "./program-blocks.js";
import { getProgramState, type ProgramState } from "./program-state.js";
import { performanceStanding } from "./performance.js";
import { enduranceTestsDue, runVarietyRead, runZones, weeklyRunPlan } from "./run-progression.js";
import { dexaTargeting } from "./dexa-targeting.js";
import { muscleGroupTrajectory, testWeekDue } from "./muscle-trajectory.js";
import { coachingFocus } from "./coaching-focus.js";
import { planDayProgression, programAdjustments, programBalance, recentMuscleLoad } from "./progression.js";
import { jaccard, memNorm, memoryForCoach, recentLearnings } from "./memory.js";
import { capStr, getDayIntake } from "./nutrition.js";
import { getPlan } from "./plan.js";
import { computeGoalCheck, effectiveGoalMode, getEnduranceGoal, getProfile } from "./profile.js";
import { directiveFeedbackForCoach, directivesForCoach, getHealthSynthesis, healthFocus, markerSide, matchOptimalZone, optimalDistance, prioritizeMarkers, supplementsForCoach } from "./propagation.js";
import { symptomMarkerLinks } from "./symptom-links.js";
import { getProgress, getRecentSessions, getRunCompliance } from "./sessions.js";
import { localDateISO, nowContext } from "./shared.js";
// The "knows-me" layer — additive context keys (function-level cycle, same shape as
// the existing coach↔intelligence import; resolved at call time, never at module init).
import { reactionModelForCoach } from "./reaction-model.js";
import { getTrajectory } from "./trajectory.js";
import { activeContextEffect } from "./context-effect.js";
import { nextBestStep } from "./next-step.js";

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
    const markers = Array.isArray(h.parsed?.markers)
      ? rankDocMarkers(h.parsed.markers).slice(0, 30)
      : undefined;
    return { kind: h.kind, doc_date: h.doc_date, summary: h.summary, type: h.parsed?.type, markers };
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
    watchlist: (Array.isArray(p.watchlist) ? p.watchlist : []).map((w: any) => ({ marker: w?.marker, status: w?.status, action: w?.action })),
    followups: Array.isArray(p.followups) ? p.followups : [],
  };
}

function dayIntakeForCoach(date = localDateISO()) {
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
  rep_target: string | null;   // "8–10" (reps mode) or null for timed
  sec_target: number | null;   // timed prescription, when applicable
  last_logged: string | null;  // ISO date of the most recent logged session for this lift
  days_since: number | null;
  progress_ready: boolean;     // recent working sets met the top target at RIR ≤ 3 (or met the timed hold)
  est_1rm_trend: "up" | "down" | "flat" | null;
  reason: string;              // plain-language ("hit 10/10 reps at RIR 2 last session")
}
export interface AutoregSignal {
  soreness_flag: boolean;
  low_performance_flag: boolean;
  joint_areas: string[];
  note: string;                // one rolled-up plain sentence
}
export function trainingSignals(recent?: any[]): { progression: ProgressionSignal[]; autoregulation: AutoregSignal | null } {
  const sessions = (recent ?? getRecentSessions(20)) as any[];
  const now = Date.now();
  const daysAgo = (d: string): number | null => {
    const t = Date.parse(String(d) + "T00:00:00Z");
    return Number.isFinite(t) ? Math.round((now - t) / 864e5) : null;
  };

  // De-dupe the current plan's exercises (a lift can appear on more than one day).
  const seen = new Set<string>();
  const items: any[] = [];
  for (const day of getPlan() as any[]) {
    for (const it of (day.items || [])) {
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
      if (!latestSets) { latestSets = mine; latestDate = s.date; }
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
        reason = target != null ? `held ${best}s vs ${target}s target${stale ? " (a while ago)" : ""}` : `held ${best}s`;
      } else {
        const repHigh = Number(it.rep_high) || null;
        const working = latestSets.filter((x: any) => x.reps != null);
        const reps = working.map((x: any) => Number(x.reps) || 0);
        const topReps = reps.length ? Math.max(...reps) : 0;
        const allHit = repHigh != null && reps.length > 0 && reps.every((r) => r >= repHigh);
        const rirs = working.map((x: any) => x.rir).filter((r: any) => r != null).map(Number);
        const lowRir = rirs.length === 0 || rirs.every((r) => r <= 3);
        ready = !stale && allHit && lowRir;
        const rirTxt = rirs.length ? ` at RIR ${Math.min(...rirs)}${rirs.length > 1 && Math.min(...rirs) !== Math.max(...rirs) ? `–${Math.max(...rirs)}` : ""}` : "";
        reason = repHigh != null
          ? `${ready ? "hit" : "last"} ${topReps}/${repHigh} reps${rirTxt}${stale ? " (a while ago)" : ""}`
          : `last ${topReps} reps${rirTxt}`;
        const pts = ((getProgress(name) as any).points || []) as any[];
        if (pts.length >= 2) {
          const a = pts[pts.length - 2].best1rm, b = pts[pts.length - 1].best1rm;
          trend = b > a * 1.005 ? "up" : b < a * 0.995 ? "down" : "flat";
        }
      }
    }
    return {
      exercise: name,
      rep_target: timed ? null : (it.rep_low != null && it.rep_high != null ? `${it.rep_low}–${it.rep_high}` : null),
      sec_target: timed ? (Number(it.target_seconds) || null) : null,
      last_logged: latestDate,
      days_since: days,
      progress_ready: ready,
      est_1rm_trend: trend,
      reason,
    };
  });

  // Autoregulation rollup over the last 4 sessions — a single plain-language signal
  // the prompt can act on without re-scanning the raw session array.
  const recent4 = sessions.slice(0, 4);
  const soreDays = recent4.filter((s) => s.soreness != null && Number(s.soreness) >= 4);
  const lowPerfDays = recent4.filter((s) => s.performance != null && Number(s.performance) <= 2);
  const joints = [...new Set(recent4.map((s) => String(s.joint_pain || "").trim()).filter(Boolean))];
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
      joint_areas: joints,
      note: `${parts.join("; ")} — ease volume/load there or de-load the movements that load it; a brake, never a penalty.`,
    };
  }
  return { progression, autoregulation };
}

// A BOUNDED view of the deterministic program-state for the coach prompt — the
// load-bearing signal (per-lift status/trend/action + stall tells, the volume
// bands, the mesocycle position + endurance read + the adaptations list) without
// the verbose internals. Keeps the prompt from exploding on a big training log.
function programStateForCoach(st: ProgramState) {
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
    endurance: st.endurance,
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
      const f = String(d.focus || d.name || "").toLowerCase().trim();
      return f && (f === focus || f.includes(focus) || focus.includes(f));
    });
    if (hit) return hit.day_number;
  }
  return days[0].day_number;
}

export function getCoachContext() {
  // Compute the Garmin summary and the unified recovery view ONCE, then thread
  // them through the recovery + day_read keys so a single context build doesn't
  // fan out into getGarminCoachSummary three times.
  const garmin = getGarminCoachSummary(14);
  const recovery = getRecoverySummary(14, garmin);
  const recentSessions = getRecentSessions(20);
  const profile = getProfile() as any;
  // Compute the day-read ONCE so both day_read and the progression digest below
  // reference the same read (the progression is for the day this read points at).
  const dayReadView = getCachedDayRead(localDateISO()) ?? dayRead(undefined, recovery);
  // Compute the volume balance + acute load ONCE and thread them into
  // programAdjustments — which would otherwise recompute both from scratch.
  const programBal = programBalance();
  const recentLoad = recentMuscleLoad(2);
  // Compute the deterministic program-state ONCE and share it: the bounded coach
  // view AND the performance/capacity read both read from the same snapshot (and
  // the same recovery), so a single context build never computes program-state twice.
  const fullProgramState = getProgramState(undefined, recovery);
  // The active periodization block, computed ONCE and threaded into the run plan +
  // the test-week cadence so neither re-reads it.
  const activeBlock = getActiveBlock();
  // Running brain (the endurance counterpart to program_state/performance): real
  // HR-zone bpm bands + this week's deterministic periodized run mix, both computed
  // ONCE from the recovery/programState/block already built above so nothing recomputes.
  const runZonesView = (() => { try { return runZones({ profile, recovery }); } catch { return null; } })();
  // Compute the run plan / DEXA targeting / test-week ONCE here, so both the context
  // keys below AND the programAdjustments digest reuse them (no double compute —
  // dexaTargeting reads healthStanding(), the heaviest of the three).
  const runPlanView = (() => { try { return weeklyRunPlan(localDateISO(), { programState: fullProgramState, recovery, block: activeBlock, zones: runZonesView ?? undefined }); } catch { return null; } })();
  const dexaTargetingView = (() => { try { return dexaTargeting({ profile }); } catch { return { available: false, targets: [], lead: null, next_dexa_focus: null }; } })();
  const testWeekView = (() => { try { return testWeekDue(localDateISO(), { programState: fullProgramState, block: activeBlock }); } catch { return null; } })();
  // Hoist the domain reads the CONDUCTOR arbitrates so they're computed ONCE here and
  // shared by both the context keys below and coachingFocus() (no double compute).
  const healthFocusView = healthFocus();
  const performanceView = performanceStanding(localDateISO(), { programState: fullProgramState, recovery, balance: programBal });
  const programAdjustmentsView = programAdjustments(programBal, recentLoad, { runPlan: runPlanView, dexa: dexaTargetingView, testWeek: testWeekView }).slice(0, 6);
  const groupsTrajectoryView = (() => { try { return muscleGroupTrajectory(localDateISO(), { programState: fullProgramState }); } catch { return null; } })();
  const runVarietyView = (() => { try { return runVarietyRead(localDateISO()); } catch { return null; } })();
  const enduranceTestsView = (() => { try { return enduranceTestsDue(localDateISO()); } catch { return []; } })();
  const trajectoryView = getTrajectory();
  // THE CONDUCTOR (the whole-athlete analog of healthFocus): arbitrate every domain
  // read into ONE sequenced focus — a single lead lever, 1-2 parallel levers, an
  // explicit "later", the cross-domain connections, and one batched retest — so the
  // brain AND the interface lead with the same priority instead of a flood of co-equal
  // blocks. Pure, null-safe; degrades to {available:false} on a thin athlete.
  const coachingFocusView = (() => {
    try {
      return coachingFocus({
        discipline: { primary: (profile?.primary_discipline as string) || "strength", endurance_sport: profile?.endurance_sport ?? null },
        enduranceGoal: getEnduranceGoal(),
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
      });
    } catch {
      return { available: false, headline: "", lead: null, parallel: [], later: [], connections: [], retest: null, horizon_weeks: null };
    }
  })();
  return {
    // The current LOCAL clock (date + weekday + time + part-of-day). Folded in so
    // EVERY plan-shaping prompt knows the time of day — without it the agent is
    // temporally blind (it would ask about "last night's dinner" at 5 PM). The
    // chat/day-read prompts also surface it as an explicit "RIGHT NOW" line.
    now: nowContext(),
    profile,
    // Top-level discipline echo (v35) so every plan-shaping prompt can branch its
    // framing without digging into profile. Defaults to 'strength' (today's
    // behavior); endurance/hybrid make endurance progression a first-class driver.
    discipline: {
      primary: (profile?.primary_discipline as string) || "strength",
      endurance_sport: profile?.endurance_sport ?? null,
    },
    // The endurance OBJECTIVE (v37) — race (dated, periodized + taper) or standing
    // (no date, maintain readiness), with race timing/phase pre-computed. Null when
    // unset. Orthogonal to discipline: a strength-first athlete can hold a standing
    // running goal ("running on the side"). The coach prescribes runs accordingly.
    endurance_goal: getEnduranceGoal(),
    goal: computeGoalCheck(profile), // reuse the profile already fetched above
    // The journey's SHAPE (v41) — lose | maintain | gain. Always present (even when
    // the profile is too thin for goal math), so every prompt and the PWA agree on
    // the framing: a deficit for 'lose', anchor-to-TDEE for 'maintain', a lean
    // surplus for 'gain'. Drives renderGoalMode and the fuel-card target.
    goal_mode: effectiveGoalMode(profile),
    // Today's persisted food log. This is independent of the live chat thread, so
    // a breakfast logged before "Fresh start" still shapes the next nutrition turn.
    day_intake: dayIntakeForCoach(),
    plan: getPlan(),
    recent_sessions: recentSessions,
    recent_activities: listActivities(15),
    // Deterministic progression-readiness + autoregulation rollup computed from the
    // athlete's own recent sets + 1-tap feedback — so logged performance VISIBLY
    // steers the next recommendation instead of being inferred from a raw array.
    training_signals: trainingSignals(recentSessions),
    garmin,
    // Ranked retrieval (Stream 2): always the load-bearing person-model
    // (constraints/injuries/preferences/decisions) + recent observations, with
    // superseded rows hidden. Replaces the raw recency dump and stamps
    // last_referenced_at so consolidation can tell live facts from stale ones.
    memory: memoryForCoach(40),
    // Durable learnings drawn from suggestion → actual reconciliation (e.g.
    // "tolerates higher frequency than the read assumed"). Suggestion-not-a-gate:
    // these inform tone/defaults, never enforce.
    learnings: recentLearnings(6),
    health: healthForCoach(),
    health_review: healthReviewForCoach(),
    context_events: listContextEvents({ activeOnly: true }),
    // Vision build (the connected brain + understanding): new keys are ADDITIVE
    // — every existing consumer keeps working untouched.
    directives: directivesForCoach(),         // cross-domain consequences of flagged findings (condensed, bounded)
    health_focus: healthFocusView,            // the TIERED, deduped priorities (act-now/track) — so coaching leads with what matters most, not a flat directive flood
    // THE CONDUCTOR — the single sequenced WHOLE-ATHLETE focus (lead + parallel +
    // later + connections + one batched retest) arbitrated across training, running,
    // DEXA, health, nutrition and recovery. The brain leads with this; the rest is
    // evidence, not a checklist.
    coaching_focus: coachingFocusView,
    symptom_links: (() => { try { return symptomMarkerLinks(); } catch { return []; } })(), // symptom the athlete noted ↔ an out-of-range marker — informational "mention to your doctor" connections

    health_synthesis: getHealthSynthesis(),   // the latest elite-coach whole-picture narrative (pull artifact), so chat/coach can reference it
    directive_feedback: directiveFeedbackForCoach(), // Done/Dismiss memory so the coach avoids stale repeats
    recovery,                                 // unified Garmin + Apple/other recovery view
    checkins: listCheckins(7),                // optional subjective morning check-ins
    family: listFamily(),                     // family roster the coach plans around
    supplements: supplementsForCoach(),       // understood supplement regimen (markers/protein it touches)
    // Runner loop (closing): prescribed plan cardio vs this week's logged efforts,
    // in plain words ("32 of 40 km this week") — so the coach can speak to run
    // adherence the way week_done/week_planned covers lifting. Never a 0-100 score.
    run_compliance: getRunCompliance(),
    // Active periodization block (goal / phase / week N of M) so the coach
    // periodizes against the current mesocycle instead of progressing blindly.
    // Null when no block is running — then the deterministic mesocycle read in
    // program-state still gives deload timing. Additive, never a gate.
    program_block: blockForCoach(),
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
    // The next session's auto-progression — the adapted target per strength lift
    // on the day this read points at ("+5 lb", "hold 50 — stalled", "−10%"), so
    // the plan visibly FOLLOWS what was logged. Bounded to the active day. [] when
    // there's no plan day / it's a cardio day.
    progression: (() => {
      const dn = nextPlanDayNumber(dayReadView);
      return dn == null ? [] : planDayProgression(dn).slice(0, 12);
    })(),
    // The calm "what changed & why" digest — the handful of concrete adaptations
    // due right now (lifts to push/hold/deload, groups due, missing-pattern gaps).
    program_adjustments: programAdjustmentsView,
    // ---- the RUNNING brain (deterministic floor the agent refines) ----
    // The athlete's real HR-zone bpm bands (max-HR + resting HR) so runs are
    // prescribed to an actual pulse, not a vague effort. {available:false} with no
    // age AND no Garmin HR.
    run_zones: runZonesView,
    // This week's periodized run mix (N easy Z2 + 1 long + 1 rotated quality), each
    // with a bpm-bearing zone + interval structure. Reuses the recovery/programState/
    // block/zones already computed so nothing recomputes. {available:false} for a
    // pure strength athlete with no running.
    run_plan: runPlanView,
    // Mono-stimulus running flag (all-easy / one-distance-on-repeat) → the missing
    // stimulus. null when there's not enough running to read variety honestly.
    run_variety: runVarietyView,
    // Running re-tests (no hard effort in ~4 weeks → a time-trial; a stale VO2max
    // reading → a max-effort run). [] for a non-runner.
    endurance_tests: enduranceTestsView,
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
    // The persisted read carries the agentic sentence AND the athlete's steer
    // ("rough night" / "easy day") so chat/coach/meals echo the Brief the user is
    // actually looking at; the deterministic floor backs it when nothing's cached.
    // Keyed by the server's LOCAL date to match the day_reads cache (saveDayRead).
    day_read: dayReadView,
    // Recent quiet cross-domain insights (bounded) so the chat/coach brain can
    // reference and build on connections it has already surfaced — closing the
    // "one brain" loop instead of re-deriving them each turn.
    insights: listVisibleInsights(5).map((i: any) => ({ text: i.text, kind: i.kind, rationale: i.rationale, next_step: i.next_step })),
    // ---- the "knows-me" layer (the personal coaching team) — all additive, null-safe ----
    // How THIS athlete actually reacts, learned from their own logged history (deficit→
    // weight rate, hs-CRP↔training-load, late-event→sleep, adherence, a data-gap signal so
    // the coach never fabricates recovery). The personalization spine every brain reads.
    reaction_model: reactionModelForCoach(),
    // One periodized arc to the goals, with today framed as the next step on it (null line
    // when there's no goal/block/race). So coaching is forward-looking, not just "today".
    trajectory: trajectoryView,
    // Active life-context effect (a late concert / travel / illness mentioned once) →
    // expect worse sleep / a transient inflammation bump (don't alarm) / plan around it.
    context_today: activeContextEffect(),
    // The single highest-leverage next action across all domains (or null on a quiet day).
    next_step: nextBestStep(),
  };
}

// The CONDUCTOR as a standalone pull read (for the PWA + MCP): one sequenced
// whole-athlete focus. Reuses the canonical getCoachContext assembly so it can never
// drift from what the prompts see. On-demand only; degrades to {available:false}.
export function getCoachingFocus() {
  try {
    return getCoachContext().coaching_focus;
  } catch {
    return { available: false, headline: "", lead: null, parallel: [], later: [], connections: [], retest: null, horizon_weeks: null };
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
    .prepare(`INSERT INTO family_members (name, color, relationship, birthdate, notes, allergies, dietary_restrictions) VALUES (?, ?, ?, ?, ?, ?, ?)`)
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
  source?: string | null;       // markers | health_review
  domain?: string | null;       // nutrition | training | watch
  marker?: string | null;       // the source marker key (e.g. 'LDL-C') when applicable
  directive_key?: string | null; // stable advice family key for repeat suppression
  directive?: string | null;
  rationale?: string | null;
  citation?: string | null;
  uncertain?: boolean;          // 1 when the lever is real but not settled
  status?: string | null;       // active | resolved | dismissed
  status_at?: string | null;
  trigger_value?: number | null;
  trigger_side?: string | null;  // low | high | unknown
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
  const m = markers.find((x: any) => String(x?.name || x?.key || "").toLowerCase() === target)
    || markers.find((x: any) => String(x?.name || x?.key || "").toLowerCase().includes(target));
  if (!m) return null;
  const z = matchOptimalZone(m?.name);
  if (!z) return null;
  const value = typeof m?.latest?.value === "number" ? m.latest.value : Number(m?.latest?.value);
  if (!Number.isFinite(value)) return null;
  const flag: string | null = m?.latest?.flag === "low" || m?.latest?.flag === "high" ? m.latest.flag : null;
  return { value, side: markerSide(value, z, flag), date: m?.latest?.date ?? null };
}

// hydrate a stored row: surface `uncertain` as a boolean for consumers.
export function hydrateDirective(row: any) {
  if (!row) return row;
  return { ...row, uncertain: !!row.uncertain };
}

export function addDirective(fields: DirectiveInput = {}) {
  const domain = DIRECTIVE_DOMAINS.has(String(fields.domain)) ? String(fields.domain) : "watch";
  const status = DIRECTIVE_STATUSES.has(String(fields.status)) ? String(fields.status) : "active";
  const marker = fields.marker == null ? null : String(fields.marker).trim().slice(0, 60) || null;
  const directive = fields.directive == null ? null : String(fields.directive).trim().slice(0, 600) || null;
  const directive_key = fields.directive_key == null
    ? defaultDirectiveKey(marker, domain, directive)
    : normalizeDirectiveKey(fields.directive_key);
  const triggerSide = ["low", "high", "unknown"].includes(String(fields.trigger_side)) ? String(fields.trigger_side) : null;
  const triggerValue = fields.trigger_value == null || !Number.isFinite(Number(fields.trigger_value)) ? null : Number(fields.trigger_value);
  const info = db
    .prepare(`INSERT INTO health_directives (source, domain, marker, directive_key, directive, rationale, citation, uncertain, status, status_at, trigger_value, trigger_side, trigger_date, resurfaced_from_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      fields.source == null ? null : String(fields.source).trim().slice(0, 120) || null,
      domain,
      marker,
      directive_key,
      directive,
      fields.rationale == null ? null : String(fields.rationale).trim().slice(0, 600) || null,
      fields.citation == null || String(fields.citation).trim() === "" ? null : String(fields.citation).trim().slice(0, 600),
      fields.uncertain ? 1 : 0,
      status,
      fields.status_at == null ? null : String(fields.status_at).trim().slice(0, 40) || null,
      triggerValue,
      triggerSide,
      fields.trigger_date == null ? null : String(fields.trigger_date).trim().slice(0, 20) || null,
      fields.resurfaced_from_id == null || !Number.isFinite(Number(fields.resurfaced_from_id)) ? null : Number(fields.resurfaced_from_id)
    );
  return getDirective(Number(info.lastInsertRowid));
}

export function getDirective(id: number) {
  return hydrateDirective(db.prepare(`SELECT * FROM health_directives WHERE id = ?`).get(id) ?? null);
}

export function listActiveDirectives() {
  return dedupeActiveDirectives(
    (db.prepare(`SELECT * FROM health_directives WHERE status = 'active' ORDER BY id DESC`).all() as any[]).map(hydrateDirective)
  ).reverse();
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

export function directiveKey(d: any): string {
  return [
    String(d?.domain || "watch").toLowerCase(),
    String(d?.marker || "").toLowerCase().replace(/\s+/g, " ").trim(),
    String(d?.directive_key || "").toLowerCase().replace(/\s+/g, " ").trim(),
  ].join("|");
}

function directiveTextKey(d: any): string {
  return String(d?.directive || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// A stable (canonical marker, domain) key — same analyte under different lab names
// ("Glucose Random"/"Glucose (random)") folds to one, so a 'markers' directive and a
// 'health_review' one for the same marker+domain are recognized as the same concern.
// Empty marker → "" (no cross-marker collapse for marker-less directives).
function directiveMarkerDomainKey(d: any): string {
  const raw = String(d?.marker || "").trim();
  const canon = raw ? canonicalMarker(raw).key : "";
  return `${canon}|${String(d?.domain || "watch").toLowerCase()}`;
}

// Prefer the deterministic 'markers' source over the agent 'health_review' one, and
// within a source prefer the non-uncertain (settled-lever) directive.
function directivePreferred(a: any, b: any): any {
  const srcRank = (d: any) => (String(d?.source || "") === "markers" ? 0 : 1);
  if (srcRank(a) !== srcRank(b)) return srcRank(a) < srcRank(b) ? a : b;
  const unc = (d: any) => (d?.uncertain ? 1 : 0);
  if (unc(a) !== unc(b)) return unc(a) < unc(b) ? a : b;
  return a; // same source + certainty → keep the first-seen (the input order is id-DESC)
}

function dedupeActiveDirectives(rows: any[]) {
  const seenMarkerDomain = new Set<string>();
  const seenText = new Set<string>();
  const out: any[] = [];
  for (const row of rows) {
    const mdKey = directiveKey(row);
    const txtKey = directiveTextKey(row);
    if ((mdKey !== "|" && seenMarkerDomain.has(mdKey)) || (txtKey && seenText.has(txtKey))) continue;
    seenMarkerDomain.add(mdKey);
    if (txtKey) seenText.add(txtKey);
    out.push(row);
  }
  // Cross-source collapse on (canonical marker, domain): when 'markers' and
  // 'health_review' both kept a directive for the SAME marker+domain (different
  // directive_key, so they survived the dedup above), they can read as contradictory.
  // Keep ONE — the deterministic source, else the non-uncertain one. Conservative:
  // only collapses when both marker AND domain match; marker-less rows are untouched.
  const byMd = new Map<string, any>();
  const collapsed: any[] = [];
  for (const row of out) {
    const raw = String(row?.marker || "").trim();
    if (!raw) { collapsed.push(row); continue; } // no marker → never cross-collapse
    const key = directiveMarkerDomainKey(row);
    const prior = byMd.get(key);
    if (!prior) { byMd.set(key, row); collapsed.push(row); continue; }
    // Replace the kept row in-place with the preferred of the two.
    const winner = directivePreferred(prior, row);
    if (winner !== prior) {
      const idx = collapsed.indexOf(prior);
      if (idx >= 0) collapsed[idx] = winner;
      byMd.set(key, winner);
    }
  }
  return collapsed;
}

export function updateDirective(id: number, fields: DirectiveInput) {
  const cur = getDirective(id) as any;
  if (!cur) return null;
  const sets: string[] = [];
  const vals: any[] = [];
  let statusChanged = false;
  if (fields.source !== undefined) { sets.push("source = ?"); vals.push(fields.source == null ? null : String(fields.source).trim().slice(0, 120) || null); }
  if (fields.domain !== undefined) { sets.push("domain = ?"); vals.push(DIRECTIVE_DOMAINS.has(String(fields.domain)) ? String(fields.domain) : cur.domain); }
  if (fields.marker !== undefined) { sets.push("marker = ?"); vals.push(fields.marker == null ? null : String(fields.marker).trim().slice(0, 60) || null); }
  if (fields.directive_key !== undefined) { sets.push("directive_key = ?"); vals.push(fields.directive_key == null ? null : normalizeDirectiveKey(fields.directive_key)); }
  if (fields.directive !== undefined) { sets.push("directive = ?"); vals.push(fields.directive == null ? null : String(fields.directive).trim().slice(0, 600) || null); }
  if (fields.rationale !== undefined) { sets.push("rationale = ?"); vals.push(fields.rationale == null ? null : String(fields.rationale).trim().slice(0, 600) || null); }
  if (fields.citation !== undefined) { sets.push("citation = ?"); vals.push(fields.citation == null || String(fields.citation).trim() === "" ? null : String(fields.citation).trim().slice(0, 600)); }
  if (fields.uncertain !== undefined) { sets.push("uncertain = ?"); vals.push(fields.uncertain ? 1 : 0); }
  if (fields.status !== undefined) {
    const nextStatus = DIRECTIVE_STATUSES.has(String(fields.status)) ? String(fields.status) : cur.status;
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
      if (cur.trigger_value == null && fields.trigger_value === undefined) { sets.push("trigger_value = ?"); vals.push(trigger.value); }
      if (!cur.trigger_side && fields.trigger_side === undefined) { sets.push("trigger_side = ?"); vals.push(trigger.side); }
      if (!cur.trigger_date && fields.trigger_date === undefined) { sets.push("trigger_date = ?"); vals.push(trigger.date); }
    }
  }
  if (fields.status_at !== undefined) { sets.push("status_at = ?"); vals.push(fields.status_at == null ? null : String(fields.status_at).trim().slice(0, 40) || null); }
  if (fields.trigger_value !== undefined) { sets.push("trigger_value = ?"); vals.push(fields.trigger_value == null || !Number.isFinite(Number(fields.trigger_value)) ? null : Number(fields.trigger_value)); }
  if (fields.trigger_side !== undefined) { sets.push("trigger_side = ?"); vals.push(["low", "high", "unknown"].includes(String(fields.trigger_side)) ? String(fields.trigger_side) : null); }
  if (fields.trigger_date !== undefined) { sets.push("trigger_date = ?"); vals.push(fields.trigger_date == null ? null : String(fields.trigger_date).trim().slice(0, 20) || null); }
  if (fields.resurfaced_from_id !== undefined) { sets.push("resurfaced_from_id = ?"); vals.push(fields.resurfaced_from_id == null || !Number.isFinite(Number(fields.resurfaced_from_id)) ? null : Number(fields.resurfaced_from_id)); }
  if (sets.length) {
    vals.push(id);
    db.prepare(`UPDATE health_directives SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  }
  return getDirective(id);
}

// Clear a whole source's directives before re-deriving them, so a fresh
// deriveDirectives() pass never accumulates stale rows. Soft-resolves rather
// than deletes, keeping a history. Sources coexist: clearing 'markers' leaves
// 'health_review' directives untouched and vice-versa.
export function clearDirectivesForSource(source: string) {
  return {
    cleared: db
      .prepare(`UPDATE health_directives SET status = 'resolved' WHERE source = ? AND status = 'active'`)
      .run(source).changes,
  };
}

// ---------- insights (quiet cross-domain intelligence — Phase 6) ----------
export interface InsightInput {
  kind?: string | null;
  text?: string | null;
  rationale?: string | null;
  next_step?: string | null;  // optional concrete, low-friction suggestion
  status?: string | null;     // new | seen | dismissed
  feedback?: string | null;   // up | down
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
    .prepare(`INSERT INTO insights (kind, text, rationale, next_step, status, feedback) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(
      fields.kind == null ? null : String(fields.kind).trim().slice(0, 60) || null,
      fields.text == null ? null : capStr(fields.text, 320) || null,
      fields.rationale == null ? null : capStr(fields.rationale, 360) || null,
      fields.next_step == null ? null : capStr(fields.next_step, 200) || null,
      status,
      INSIGHT_FEEDBACK.has(String(fields.feedback)) ? String(fields.feedback) : null
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
  if (fields.kind !== undefined) { sets.push("kind = ?"); vals.push(fields.kind == null ? null : String(fields.kind).trim().slice(0, 60) || null); }
  if (fields.text !== undefined) { sets.push("text = ?"); vals.push(fields.text == null ? null : capStr(fields.text, 320) || null); }
  if (fields.rationale !== undefined) { sets.push("rationale = ?"); vals.push(fields.rationale == null ? null : capStr(fields.rationale, 360) || null); }
  if (fields.next_step !== undefined) { sets.push("next_step = ?"); vals.push(fields.next_step == null ? null : capStr(fields.next_step, 200) || null); }
  if (fields.status !== undefined) { sets.push("status = ?"); vals.push(INSIGHT_STATUSES.has(String(fields.status)) ? String(fields.status) : cur.status); }
  if (fields.feedback !== undefined) { sets.push("feedback = ?"); vals.push(INSIGHT_FEEDBACK.has(String(fields.feedback)) ? String(fields.feedback) : null); }
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
  return db
    .prepare(
      `SELECT * FROM insights
        WHERE status IN ('new', 'seen')
          AND (kind = 'weekly_read' OR substr(created_at, 1, 10) >= ?)
        ORDER BY id DESC LIMIT ?`
    )
    .all(cutoff, limit);
}

// A compact, bounded list of recent insight TEXTS (any status) so the generator
// can tell the agent what it already said and avoid repeating a connection.
// Dedup is a soft prompt hint here; isDuplicateInsight() is the real guard.
export function recentInsightTexts(limit = 12): string[] {
  return db
    .prepare(`SELECT text FROM insights ORDER BY id DESC LIMIT ?`)
    .all(limit)
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
  raw?: any;
}

// Upsert one source's metrics for a date (mirrors upsertGarminDailyMetric, but
// source-agnostic). `source` defaults to 'apple' — the documented Shortcuts path.
export function recordDailyMetrics(source: string, date: string, metrics: DailyMetricsInput = {}) {
  const src = (source || "apple").toString().trim() || "apple";
  if (!date) throw new Error("date required");
  // Coerce/clamp at the trust boundary so non-numeric junk (e.g. steps:"abc" from
  // a hand-rolled Shortcut, which sqlite would otherwise store verbatim as TEXT in
  // an INTEGER column) never pollutes the metrics. Protects REST and MCP alike.
  const num = (v: any, lo: number, hi: number): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
  };
  db.prepare(
    `INSERT INTO daily_metrics (source, date, steps, sleep_min, sleep_score, resting_hr, hrv_ms, active_calories, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, date) DO UPDATE SET
       steps = excluded.steps, sleep_min = excluded.sleep_min, sleep_score = excluded.sleep_score,
       resting_hr = excluded.resting_hr, hrv_ms = excluded.hrv_ms, active_calories = excluded.active_calories,
       raw_json = excluded.raw_json, updated_at = datetime('now')`
  ).run(
    src, date,
    num(metrics.steps, 0, 200000), num(metrics.sleep_min, 0, 1440), num(metrics.sleep_score, 0, 100),
    num(metrics.resting_hr, 0, 250), num(metrics.hrv_ms, 0, 500), num(metrics.active_calories, 0, 20000),
    jsonOrNull(metrics.raw)
  );
  invalidateDayRead(); // fresh recovery data feeds today's Brief — recompute on next open
  return hydrateJson(db.prepare(`SELECT * FROM daily_metrics WHERE source = ? AND date = ?`).get(src, date));
}

// Recent rows for a source (or all sources) over the last `days`.
export function getDailyMetrics(source?: string | null, days = 30) {
  const since = new Date(Date.now() - Math.max(1, days - 1) * 864e5).toISOString().slice(0, 10);
  const rows = source
    ? (db.prepare(`SELECT * FROM daily_metrics WHERE source = ? AND date >= ? ORDER BY date DESC, id DESC`).all(source, since) as any[])
    : (db.prepare(`SELECT * FROM daily_metrics WHERE date >= ? ORDER BY date DESC, id DESC`).all(since) as any[]);
  return rows.map((r) => hydrateJson(r));
}

// daily_metrics has UNIQUE(source, date), so an athlete who pipes BOTH Apple
// Health AND Oura (or Whoop) into /api/health-metrics gets one ROW PER SOURCE per
// night — and a naive AVG(...) over the window would then count each night ONCE
// PER SOURCE, over-doubling the 7d-vs-30d acute/chronic averages on possibly
// conflicting rows. This SELECTs ONE row per date (the most-recently-updated
// source, id-tiebroken) so a night is counted once. A correlated NOT EXISTS keeps
// it portable (no window functions); the single-source case is a no-op (one row
// per date either way), so its aggregates stay byte-identical.
const DAILY_METRICS_ONE_PER_DATE = `
  SELECT dm.* FROM daily_metrics dm
  WHERE NOT EXISTS (
    SELECT 1 FROM daily_metrics dm2
    WHERE dm2.date = dm.date
      AND (dm2.updated_at > dm.updated_at
        OR (dm2.updated_at = dm.updated_at AND dm2.id > dm.id))
  )`;

// ---------- unified recovery summary (Phase 5D) ----------
// Generalize getGarminCoachSummary into a SOURCE-AGNOSTIC recovery view by
// merging garmin_daily_metrics with daily_metrics. Garmin is preferred for
// sleep/HRV/RHR/body-battery (richer recovery signals); steps + active calories
// fold in from ANY source. Keeps getGarminCoachSummary working untouched — this
// wraps it and layers the non-Garmin sources on top. Everything null-safe: no
// data at all → zeroed/empty fields, never a throw.
export function getRecoverySummary(days = 14, garminSummary?: any) {
  // Accept a pre-fetched Garmin summary so getCoachContext can compute it once
  // and thread it through (it otherwise fans out into getGarminCoachSummary three
  // times per context build via the garmin/recovery/day_read paths).
  const garmin = garminSummary ?? getGarminCoachSummary(days);
  const since = new Date(Date.now() - Math.max(1, days - 1) * 864e5).toISOString().slice(0, 10);

  // Garmin recovery aggregates (may be all-null when there's no Garmin source).
  const g = (garmin?.recovery ?? {}) as any;

  // Non-Garmin daily_metrics aggregates over the same window — averaged over ONE
  // row per date (most-recent source), so a multi-source night isn't double-counted.
  const other = db.prepare(
    `SELECT
       ROUND(AVG(sleep_min), 1) AS avg_sleep_min,
       ROUND(AVG(sleep_score), 1) AS avg_sleep_score,
       ROUND(AVG(resting_hr), 1) AS avg_resting_hr,
       ROUND(AVG(hrv_ms), 1) AS avg_hrv_ms,
       ROUND(AVG(active_calories), 1) AS avg_active_calories,
       ROUND(AVG(steps), 0) AS avg_steps,
       MAX(date) AS last_date
     FROM (${DAILY_METRICS_ONE_PER_DATE})
     WHERE date >= ?`
  ).get(since) as any;

  // Steps live only on garmin_daily_metrics / daily_metrics raw rows — pull a
  // garmin steps average directly (getGarminCoachSummary doesn't surface it).
  const garminSteps = db.prepare(
    `SELECT ROUND(AVG(steps), 0) AS avg_steps FROM garmin_daily_metrics WHERE date >= ?`
  ).get(since) as any;

  // Prefer Garmin for recovery signals; fall back to other sources; fold steps
  // & active calories from whichever source has them (prefer Garmin).
  const pick = (a: any, b: any) => (a != null ? a : b != null ? b : null);
  const recovery = {
    avg_sleep_min: pick(g.avg_sleep_min, other?.avg_sleep_min),
    avg_sleep_score: pick(g.avg_sleep_score, other?.avg_sleep_score),
    avg_resting_hr: pick(g.avg_resting_hr, other?.avg_resting_hr),
    avg_hrv_ms: pick(g.avg_hrv_ms, other?.avg_hrv_ms),
    avg_stress: g.avg_stress ?? null,                          // Garmin-only signal
    avg_body_battery: g.avg_body_battery ?? null,              // Garmin-only signal
    avg_active_calories: pick(g.avg_active_calories, other?.avg_active_calories),
    avg_steps: pick(garminSteps?.avg_steps, other?.avg_steps),
    // Richer Garmin-only recovery signals (null when no Garmin source / device).
    avg_deep_sleep_min: g.avg_deep_sleep_min ?? null,
    avg_rem_sleep_min: g.avg_rem_sleep_min ?? null,
    hrv_status: g.hrv_status ?? null,
    avg_body_battery_max: g.avg_body_battery_max ?? null,
    avg_respiration: g.avg_respiration ?? null,
    avg_spo2: g.avg_spo2 ?? null,
    skin_temp_dev_c: g.skin_temp_dev_c ?? null,
    avg_vigorous_min: g.avg_vigorous_min ?? null,
    avg_training_readiness: g.avg_training_readiness ?? null,
    // Load/fitness point-in-time signals — captured by the sync, now surfaced so
    // the agent can ANTICIPATE fatigue (rising acute load) rather than only react.
    acute_load: g.acute_load ?? null,
    fitness_age: g.fitness_age ?? null,
    vo2max: g.vo2max ?? null,
    training_status: g.training_status ?? null,
    weight_kg: g.weight_kg ?? null,
    body_fat_pct: g.body_fat_pct ?? null,
    muscle_mass_kg: g.muscle_mass_kg ?? null,
    // Runner performance signals (null when no Garmin source / device doesn't report).
    endurance_score: g.endurance_score ?? null,
    hill_score: g.hill_score ?? null,
    race_predict_5k_sec: g.race_predict_5k_sec ?? null,
    race_predict_10k_sec: g.race_predict_10k_sec ?? null,
    race_predict_half_sec: g.race_predict_half_sec ?? null,
    race_predict_marathon_sec: g.race_predict_marathon_sec ?? null,
    training_load_balance: g.training_load_balance ?? null,
    last_date: g.last_date || other?.last_date || null,
  };

  // ---- acute-vs-chronic baselines (vs the user's OWN norm, not a population) ----
  // The prompt asks the agent to read recovery "vs their norm" but historically
  // got a single window average to compare against itself. Give it a real
  // baseline: recent = last 7d, baseline = last 30d, delta = recent − baseline,
  // for the three load-bearing recovery signals (sleep / HRV / resting HR),
  // preferring Garmin and falling back to other sources. Null-safe throughout.
  const avgWindow = (winDays: number): { sleep: number | null; hrv: number | null; rhr: number | null } => {
    const s = new Date(Date.now() - Math.max(1, winDays - 1) * 864e5).toISOString().slice(0, 10);
    const gw = db.prepare(
      `SELECT ROUND(AVG(sleep_min),1) AS sleep, ROUND(AVG(hrv_ms),1) AS hrv, ROUND(AVG(resting_hr),1) AS rhr
       FROM garmin_daily_metrics WHERE date >= ?`
    ).get(s) as any;
    const ow = db.prepare(
      `SELECT ROUND(AVG(sleep_min),1) AS sleep, ROUND(AVG(hrv_ms),1) AS hrv, ROUND(AVG(resting_hr),1) AS rhr
       FROM (${DAILY_METRICS_ONE_PER_DATE}) WHERE date >= ?`
    ).get(s) as any;
    return {
      sleep: pick(gw?.sleep, ow?.sleep),
      hrv: pick(gw?.hrv, ow?.hrv),
      rhr: pick(gw?.rhr, ow?.rhr),
    };
  };
  const recent = avgWindow(7);
  const baseline = avgWindow(30);
  const round1 = (v: number) => Math.round(v * 10) / 10;
  const diff = (a: number | null, b: number | null): number | null =>
    a != null && b != null ? round1(a - b) : null;
  const delta = {
    sleep: diff(recent.sleep, baseline.sleep),
    hrv: diff(recent.hrv, baseline.hrv),
    rhr: diff(recent.rhr, baseline.rhr),
  };

  // Which sources contributed, for transparency / graceful-degradation copy.
  const sources: string[] = [];
  if (garmin?.source) sources.push("garmin");
  const otherSrc = db.prepare(`SELECT DISTINCT source FROM daily_metrics WHERE date >= ?`).all(since) as any[];
  for (const r of otherSrc) if (r?.source && !sources.includes(r.source)) sources.push(r.source);

  const has_data =
    recovery.avg_sleep_min != null || recovery.avg_resting_hr != null ||
    recovery.avg_hrv_ms != null || recovery.avg_steps != null || recovery.avg_active_calories != null;

  return {
    days,
    since,
    sources,
    has_data,
    recovery,
    // Acute-vs-chronic: the athlete's recent week against their 30-day norm, so
    // the agent compares against THEIR baseline (additive — older consumers ignore).
    recent,
    baseline,
    delta,
    // Carry the Garmin activity/hard-session detail through unchanged so any
    // consumer that wants the sports layer still has it.
    activities: garmin?.activities ?? [],
    hard_sessions: garmin?.hard_sessions ?? [],
  };
}

// The most recent SINGLE night's sleep + HRV, in plain numbers plus a calm
// one-line summary — so the Brief can name LAST NIGHT (the recovery aggregates
// above are 7/30-day windows and can't). Garmin is preferred (it has the
// architecture: deep / REM / light); the source-agnostic daily_metrics
// (Apple Health / Oura / Whoop) is the fallback (total + HRV). HRV is compared to
// the athlete's own 30-day norm for a "steady / below your norm" read — never a
// score. Null-safe: no sleep data anywhere → null.
export function latestSleep(): {
  date: string; source: string; total_min: number | null;
  deep_min: number | null; rem_min: number | null; light_min: number | null; awake_min: number | null;
  hrv_ms: number | null; hrv_status: string | null; resting_hr: number | null; sleep_score: number | null;
  hrv_vs_baseline: number | null; text: string;
} | null {
  const g = db.prepare(
    `SELECT date, sleep_min, sleep_score, resting_hr, hrv_ms, hrv_status,
            deep_sleep_min, light_sleep_min, rem_sleep_min, awake_min
       FROM garmin_daily_metrics
      WHERE sleep_min IS NOT NULL AND sleep_min > 0
      ORDER BY date DESC LIMIT 1`
  ).get() as any;
  const o = db.prepare(
    `SELECT date, source, sleep_min, sleep_score, resting_hr, hrv_ms
       FROM daily_metrics
      WHERE sleep_min IS NOT NULL AND sleep_min > 0
      ORDER BY date DESC LIMIT 1`
  ).get() as any;

  // Most recent night wins; Garmin breaks a tie (richer architecture).
  let row: any = null, source = "";
  if (g && o) { if (o.date > g.date) { row = o; source = o.source || "apple"; } else { row = g; source = "garmin"; } }
  else if (g) { row = g; source = "garmin"; }
  else if (o) { row = o; source = o.source || "apple"; }
  if (!row) return null;

  // 30-day HRV baseline (same source family) up to — not including — last night.
  // For the non-Garmin family, dedup to ONE row per date (same guard getRecoverySummary
  // uses) so two wearables feeding the same nights don't double-weight the average.
  const since30 = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const baseTable = source === "garmin" ? "garmin_daily_metrics" : `(${DAILY_METRICS_ONE_PER_DATE})`;
  const hb = db.prepare(
    `SELECT ROUND(AVG(hrv_ms),1) AS h FROM ${baseTable}
      WHERE date >= ? AND date < ? AND hrv_ms IS NOT NULL`
  ).get(since30, row.date) as any;
  const baselineHrv = hb?.h ?? null;
  const hrvDelta = row.hrv_ms != null && baselineHrv != null ? Math.round((row.hrv_ms - baselineHrv) * 10) / 10 : null;

  const hm = (m: number) => {
    const h = Math.floor(m / 60), mm = Math.round(m % 60);
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
    date: row.date, source,
    total_min: r(row.sleep_min),
    deep_min: r(row.deep_sleep_min), rem_min: r(row.rem_sleep_min),
    light_min: r(row.light_sleep_min), awake_min: r(row.awake_min),
    hrv_ms: r(row.hrv_ms), hrv_status: row.hrv_status ?? null, resting_hr: r(row.resting_hr),
    sleep_score: row.sleep_score ?? null, hrv_vs_baseline: hrvDelta,
    text: parts.join(" · "),
  };
}
