// The PERSONAL-RESPONSE model — how THIS athlete actually reacts.
//
// This is the keystone the higher coaching layers read from: a deterministic,
// pure, null-safe digest of the patterns the data REVEALS about one person
// (how a deficit moves their weight, whether their hs-CRP tracks training load,
// what late events cost their sleep, which plan days actually land, whether a
// muscle's volume coincides with soreness, whether recovery signal is even
// available, and whether a past intervention preceded a marker change).
//
// CONSTITUTION (binding): no 0-100 scores or numeric grades EVER cross the
// public boundary. Coefficients/correlations stay INTERNAL (the optional
// `params` blob, like impact_score) — only plain words + a confidence WORD
// ('tentative'|'observed'|'strong') are ever surfaced. Suggestion, never a
// gate. Pull, never push. Calm, bounded output: at most a handful of patterns,
// each emitted only when its sparsity guard passes.
//
// CYCLE NOTE: coach.ts imports THIS module, so this module must NOT import
// coach.ts. Recovery deltas are queried straight off garmin_daily_metrics +
// daily_metrics here (the same column shapes getRecoverySummary/latestSleep
// read) rather than calling them.

import { db } from "../db.js";
import { getMarkerHistory } from "./health.js";
import { activitySportWhere, RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { normalizedExerciseKey, canonicalGroup, isMobility } from "./exercise-canon.js";
import { getAppState, setAppState } from "./app-state.js";
import { addMemory } from "./memory.js";
import { addDaysISO, localDateISO, metricLabel } from "./shared.js";
// Single sources of truth (function-level cycle, resolved at call time — the same
// pattern coach↔intelligence↔propagation already rely on): the acute-marker classifier
// (with its chronic-cluster guard) and the prior-week training-load helpers.
import { isAcuteMarker } from "./propagation.js";
// Pure, DB-free, clock-free — the shared wear-cadence classifier and the one
// vocabulary for what a sensor's silence means. Both sit below this module.
import { CADENCE_WINDOW_DAYS, classifyWearPattern, type SensorCadence } from "./sensor-cadence.js";
import { sensorAgeDays } from "./sensor-freshness.js";
import { wearAbsenceView } from "./wear-pattern-voice.js";
import { weeklyTonnage, weeklyKm } from "./program-state.js";
// The metric key only — read-adherence sits below this module in the graph (db,
// brain-decisions, profile, shared, training-intent, training-read), so nothing
// imports upward and the name stays a single source of truth.
import { DAY_READ_ADHERENCE_METRIC } from "./brain/read-adherence.js";
import { currentTrainingDataVersion, registerTrainingCacheClear } from "./training-cache.js";
import type {
  CoachOutcomeLearning,
  CoachPersonalModifier,
  CoachPersonalModifierTarget,
  CoachPersonalResponseConfidence,
  CoachPersonalSafetyGuardrail,
  CoachWhatWorksForYou,
} from "../brain/coach-context-contract.js";

export interface ReactionPattern {
  id: string;
  kind: string;
  statement: string;
  confidence: "tentative" | "observed" | "strong";
  evidence_n: number;
  domains: string[];
  last_observed: string | null;
  // INTERNAL only — coefficients/correlations the engine reasons with. NEVER
  // surfaced as a number/grade (the constitution bans 0-100 scores). Higher
  // layers may read these for ordering, but must not render them.
  params?: Record<string, number>;
}

const REACTION_MODEL_VERSION = 1;

// ---- small local helpers (kept in-lane; no cross-layer imports) -------------

function isoDaysAgo(date: string, n: number): string {
  const base = Date.parse(date + "T00:00:00Z");
  return new Date(base - n * 864e5).toISOString().slice(0, 10);
}

// Ordinary least-squares correlation coefficient (Pearson r) over paired points.
// Returns null when degenerate (n<3, or no variance on either axis). INTERNAL —
// the coefficient never crosses the public boundary; only its sign/strength
// shapes the plain-language statement + confidence WORD.
function pearson(pairs: Array<{ x: number; y: number }>): number | null {
  if (!pairs || pairs.length < 3) return null;
  const n = pairs.length;
  const mx = pairs.reduce((a, p) => a + p.x, 0) / n;
  const my = pairs.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (const p of pairs) {
    const dx = p.x - mx,
      dy = p.y - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

// Latest date present in either recovery table for a recovery column, plus a
// "stale by" gap in days vs today. Null when there's no data at all.
function latestRecoveryDate(): { date: string | null; age_days: number | null } {
  try {
    const g = db
      .prepare(
        `SELECT MAX(date) AS d FROM garmin_daily_metrics WHERE (sleep_min IS NOT NULL AND sleep_min > 0) OR hrv_ms IS NOT NULL`
      )
      .get() as any;
    const o = db
      .prepare(
        `SELECT MAX(date) AS d FROM daily_metrics WHERE (sleep_min IS NOT NULL AND sleep_min > 0) OR hrv_ms IS NOT NULL`
      )
      .get() as any;
    const cands = [g?.d, o?.d].filter((x) => x && String(x).trim()) as string[];
    if (!cands.length) return { date: null, age_days: null };
    const latest = cands.sort().slice(-1)[0];
    // DAY-KEYED, via the one age helper. This used to be `Date.now()` against the
    // reading's UTC midnight, which is an instant measured against a day key: past
    // midday in a western zone it rounded a 20-day-old night up to 21, so the gap
    // this pattern reports drifted a day away from every other age in the brain
    // (and away from the cadence clause now sitting in the same sentence).
    const age = sensorAgeDays(latest, localDateISO());
    return { date: latest, age_days: age == null ? null : Math.max(0, age) };
  } catch {
    return { date: null, age_days: null };
  }
}

// How the athlete actually wears the sensor, from the same two tables the gap
// above is measured against. Deliberately re-queried here rather than taken from
// getRecoverySummary: this module sits BELOW coach.ts in the graph (see the cycle
// note at the top) and classifyWearPattern is pure, so the dates are the only
// thing that has to travel.
function recoveryWearCadence(today: string): SensorCadence {
  try {
    const since = addDaysISO(today, -(CADENCE_WINDOW_DAYS - 1)) ?? today;
    const rows = db
      .prepare(
        `SELECT date FROM garmin_daily_metrics
          WHERE date >= ? AND date <= ? AND ((sleep_min IS NOT NULL AND sleep_min > 0) OR hrv_ms IS NOT NULL)
         UNION
         SELECT date FROM daily_metrics
          WHERE date >= ? AND date <= ? AND ((sleep_min IS NOT NULL AND sleep_min > 0) OR hrv_ms IS NOT NULL)`
      )
      .all(since, today, since, today) as { date: string }[];
    return classifyWearPattern(
      rows.map((row) => String(row.date)),
      today,
      CADENCE_WINDOW_DAYS
    );
  } catch {
    return classifyWearPattern([], today, CADENCE_WINDOW_DAYS);
  }
}

// Per-night sleep/HRV for a date, preferring Garmin (richer), falling back to
// daily_metrics. Null fields when absent. Used by the event-recovery pattern.
function nightRecovery(date: string): { sleep_min: number | null; hrv_ms: number | null } {
  try {
    const g = db
      .prepare(
        `SELECT sleep_min, hrv_ms FROM garmin_daily_metrics WHERE date = ? AND (sleep_min IS NOT NULL OR hrv_ms IS NOT NULL) ORDER BY id DESC LIMIT 1`
      )
      .get(date) as any;
    if (g && (g.sleep_min != null || g.hrv_ms != null)) {
      return {
        sleep_min: g.sleep_min != null ? Number(g.sleep_min) : null,
        hrv_ms: g.hrv_ms != null ? Number(g.hrv_ms) : null,
      };
    }
    const o = db
      .prepare(
        `SELECT sleep_min, hrv_ms FROM daily_metrics WHERE date = ? AND (sleep_min IS NOT NULL OR hrv_ms IS NOT NULL) ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(date) as any;
    if (o && (o.sleep_min != null || o.hrv_ms != null)) {
      return {
        sleep_min: o.sleep_min != null ? Number(o.sleep_min) : null,
        hrv_ms: o.hrv_ms != null ? Number(o.hrv_ms) : null,
      };
    }
  } catch {
    /* fall through */
  }
  return { sleep_min: null, hrv_ms: null };
}

// Athlete's ~30-day sleep baseline (avg minutes), preferring Garmin. Null when
// there isn't enough data to anchor an event comparison against.
function sleepBaseline(): { avg_min: number | null; n: number } {
  try {
    const since = isoDaysAgo(localDateISO(), 30);
    const g = db
      .prepare(
        `SELECT ROUND(AVG(sleep_min),1) AS a, COUNT(*) AS n FROM garmin_daily_metrics WHERE date >= ? AND sleep_min IS NOT NULL AND sleep_min > 0`
      )
      .get(since) as any;
    if (g && g.n >= 5 && g.a != null) return { avg_min: Number(g.a), n: Number(g.n) };
    const o = db
      .prepare(
        `SELECT ROUND(AVG(sleep_min),1) AS a, COUNT(*) AS n FROM daily_metrics WHERE date >= ? AND sleep_min IS NOT NULL AND sleep_min > 0`
      )
      .get(since) as any;
    if (o && o.n >= 5 && o.a != null) return { avg_min: Number(o.a), n: Number(o.n) };
    return { avg_min: null, n: 0 };
  } catch {
    return { avg_min: null, n: 0 };
  }
}

const ENDURANCE_PATTERNS = ["run", "ride", "cycl", "bike", "swim", "row", "walk", "hike"];

// weeklyTonnage / weeklyKm (prior-week training load) are imported from program-state
// (their canonical home — weeklyKm there uses the shared sport matcher, not a raw LIKE).

// ---------------------------------------------------------------------------
// 2) load_crp — does hs-CRP / ESR move ALONGSIDE prior-week training load?
//    Observational ONLY (likely training-induced, never causal/red-flag).
// ---------------------------------------------------------------------------
function loadCrp(): ReactionPattern | null {
  let hist: any;
  try {
    hist = getMarkerHistory();
  } catch {
    return null;
  }
  const markers: any[] = Array.isArray(hist?.markers) ? hist.markers : [];
  // Acute inflammation markers with dated numeric readings.
  const acute = markers.filter((m) => m && isAcuteMarker(m.name) && Array.isArray(m.points) && m.points.length);
  if (!acute.length) return null;
  // Use the marker with the most readings (typically hs-CRP).
  acute.sort((a, b) => (b.points?.length ?? 0) - (a.points?.length ?? 0));
  const m = acute[0];
  const points: Array<{ date: string; value: number }> = (m.points as any[])
    .map((p) => ({ date: String(p.date), value: Number(p.value) }))
    .filter((p) => p.date && Number.isFinite(p.value));
  if (points.length < 3) return null; // gate: >=3 readings
  // For each reading, the prior-7d training load (tonnage + endurance km).
  const pairs = points.map((p) => {
    const load = weeklyTonnage(p.date, 0) + weeklyKm(p.date, 0, ENDURANCE_PATTERNS) * 100; // scale km onto the tonnage axis (internal only)
    return { x: load, y: p.value };
  });
  const r = pearson(pairs);
  if (r == null) return null;
  // Only speak when the marker actually moves WITH load (positive correlation).
  if (r < 0.4) return null;
  const confidence: ReactionPattern["confidence"] =
    r >= 0.75 && points.length >= 4 ? "strong" : r >= 0.6 ? "observed" : "tentative";
  const display = String(m.name || "hs-CRP");
  const statement = `Your ${display} tends to move alongside your training load — likely training-induced inflammation, not a red flag. Recheck it on a lighter week before reading anything into a single high value.`;
  return {
    id: "load_crp",
    kind: "marker_response",
    statement,
    confidence,
    evidence_n: points.length,
    domains: ["watch", "training"],
    last_observed: points[points.length - 1].date,
    params: { r: round(r, 3), readings: points.length },
  };
}

// ---------------------------------------------------------------------------
// 3) event_recovery — late / loud life events vs the athlete's sleep baseline.
//    Compares the event night + next 1-2 nights against the ~30d sleep norm.
//    Gate: >=2 events WITH recovery data (often 0 right now → omit).
// ---------------------------------------------------------------------------
function eventRecovery(): ReactionPattern | null {
  const base = sleepBaseline();
  if (base.avg_min == null) return null;
  let events: any[];
  try {
    events = db
      .prepare(
        `SELECT title, detail, start_date FROM context_events
        WHERE start_date IS NOT NULL AND start_date != '' AND COALESCE(archived,0) = 0
          AND kind = 'life_event'
        ORDER BY start_date DESC LIMIT 24`
      )
      .all() as any[];
  } catch {
    return null;
  }
  if (!events.length) return null;
  const deficits: number[] = [];
  let lastObserved: string | null = null;
  for (const ev of events) {
    const start = String(ev.start_date).slice(0, 10);
    // The event night + the next two nights.
    const nights = [start, isoDaysAgo(start, -1), isoDaysAgo(start, -2)];
    const sleeps = nights
      .map((d) => nightRecovery(d).sleep_min)
      .filter((s): s is number => s != null && Number.isFinite(s));
    if (!sleeps.length) continue;
    const minSleep = Math.min(...sleeps); // the worst night around the event
    const def = base.avg_min - minSleep; // minutes BELOW baseline (positive = lost sleep)
    if (def > 15) {
      deficits.push(def);
      if (!lastObserved || start > lastObserved) lastObserved = start;
    }
  }
  if (deficits.length < 2) return null; // gate: >=2 events WITH usable recovery data
  const avgDefMin = deficits.reduce((a, b) => a + b, 0) / deficits.length;
  const avgDefHrs = round(avgDefMin / 60, 1);
  const confidence: ReactionPattern["confidence"] = deficits.length >= 4 ? "observed" : "tentative";
  const statement = `Late events tend to cost you about ${avgDefHrs}h of sleep — worth planning a lighter morning after one.`;
  return {
    id: "event_recovery",
    kind: "recovery_response",
    statement,
    confidence,
    evidence_n: deficits.length,
    domains: ["recovery", "training"],
    last_observed: lastObserved,
    params: { avg_deficit_min: round(avgDefMin, 0), events: deficits.length },
  };
}

// ---------------------------------------------------------------------------
// 3b) food_recovery — explicitly logged late caffeine / alcohol vs next sleep.
//     This stays observational and only speaks after repeated exposed AND clean
//     comparison nights. Photo inference is not enough: the enrichment contract
//     leaves these fields null unless visible or stated.
// ---------------------------------------------------------------------------
function foodRecovery(): ReactionPattern | null {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT COALESCE(date, substr(created_at,1,10)) AS date, parsed_json
           FROM food_notes
          WHERE parsed_json IS NOT NULL
          ORDER BY COALESCE(date, substr(created_at,1,10)) DESC, id DESC
          LIMIT 500`
      )
      .all() as any[];
  } catch {
    return null;
  }
  const byDate = new Map<string, { alcohol: boolean; lateCaffeine: boolean }>();
  const timeHour = (value: unknown): number | null => {
    const text = String(value ?? "")
      .trim()
      .toLowerCase();
    if (!text) return null;
    const match = text.match(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)?\b/);
    if (!match) return null;
    let hour = Number(match[1]);
    if (!Number.isFinite(hour) || hour > 23) return null;
    if (match[2] === "pm" && hour < 12) hour += 12;
    if (match[2] === "am" && hour === 12) hour = 0;
    return hour;
  };
  for (const row of rows) {
    let parsed: any;
    try {
      parsed = JSON.parse(row.parsed_json);
    } catch {
      continue;
    }
    const pattern = parsed?.nutrition_pattern;
    if (!pattern || typeof pattern !== "object") continue;
    const date = String(row.date ?? "").slice(0, 10);
    if (!date) continue;
    // An uncertain guess is not evidence either way — a low-confidence entry is
    // skipped entirely rather than folded into the day's flags, so it can neither
    // manufacture an "exposed" night nor a falsely "clean" comparison night. A date
    // whose only entries are low-confidence never enters `byDate` at all, which
    // excludes it from both the exposed and clean classification below.
    const confidence = String(pattern.confidence ?? "").toLowerCase();
    if (confidence === "low") continue;
    const current = byDate.get(date) ?? { alcohol: false, lateCaffeine: false };
    current.alcohol ||= Number(pattern.alcohol_servings) > 0;
    const caffeine = Number(pattern.caffeine_mg);
    const hour = timeHour(pattern.caffeine_time);
    current.lateCaffeine ||= Number.isFinite(caffeine) && caffeine > 0 && hour != null && hour >= 14;
    byDate.set(date, current);
  }
  if (byDate.size < 6) return null;

  const candidates = [
    { key: "alcohol" as const, label: "alcohol" },
    { key: "lateCaffeine" as const, label: "caffeine after early afternoon" },
  ];
  let best: {
    key: "alcohol" | "lateCaffeine";
    label: string;
    exposed: number[];
    clean: number[];
    delta: number;
    last: string;
  } | null = null;
  for (const candidate of candidates) {
    const exposed: number[] = [];
    const clean: number[] = [];
    let last = "";
    for (const [date, flags] of byDate) {
      const sleep = nightRecovery(isoDaysAgo(date, -1)).sleep_min;
      if (sleep == null || !Number.isFinite(sleep)) continue;
      if (flags[candidate.key]) {
        exposed.push(sleep);
        if (date > last) last = date;
      } else if (!flags.alcohol && !flags.lateCaffeine) {
        clean.push(sleep);
      }
    }
    if (exposed.length < 3 || clean.length < 3) continue;
    const exposedAvg = mean(exposed);
    const cleanAvg = mean(clean);
    const delta = exposedAvg - cleanAvg;
    if (Math.abs(delta) < 20) continue;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { ...candidate, exposed, clean, delta, last };
    }
  }
  if (!best) return null;
  const minutes = Math.round(Math.abs(best.delta) / 5) * 5;
  const direction = best.delta < 0 ? "less" : "more";
  return {
    id: `food_recovery_${best.key}`,
    kind: "lifestyle_response",
    statement: `On repeatedly logged nights with ${best.label}, the next sleep has averaged about ${minutes} minutes ${direction} than your clean comparison nights. Treat that as a personal pattern to plan around, not proof of cause.`,
    confidence: best.exposed.length >= 5 && best.clean.length >= 5 ? "observed" : "tentative",
    evidence_n: best.exposed.length + best.clean.length,
    domains: ["lifestyle", "recovery", "nutrition"],
    last_observed: best.last || null,
    params: {
      exposed_n: best.exposed.length,
      clean_n: best.clean.length,
      sleep_delta_min: round(best.delta, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// 4) adherence — which plan days land, and which exercises get skipped.
//    Gate: >=4 weeks of training history.
// ---------------------------------------------------------------------------
function adherence(): ReactionPattern | null {
  let span: any;
  try {
    span = db
      .prepare(`SELECT MIN(date) AS first, MAX(date) AS last, COUNT(DISTINCT date) AS days FROM sessions`)
      .get() as any;
  } catch {
    return null;
  }
  if (!span?.first || !span?.last) return null;
  const weeks = (Date.parse(span.last + "T00:00:00Z") - Date.parse(span.first + "T00:00:00Z")) / (7 * 864e5);
  if (weeks < 4) return null; // gate: >=4 weeks history
  const weeksRound = Math.max(1, Math.round(weeks));

  // Per plan day: how many distinct sessions landed on it.
  let landed: any[] = [];
  try {
    landed = db
      .prepare(
        `SELECT pd.day_number AS dn, pd.name AS name, COUNT(DISTINCT s.id) AS n
         FROM plan_days pd LEFT JOIN sessions s ON s.plan_day_id = pd.id
        GROUP BY pd.id ORDER BY pd.day_number ASC`
      )
      .all() as any[];
  } catch {
    landed = [];
  }

  // Skips by exercise (deduped via the canonical movement key), most-skipped first.
  let skips: any[] = [];
  try {
    skips = db.prepare(`SELECT exercise FROM session_skips`).all() as any[];
  } catch {
    skips = [];
  }
  const skipCount = new Map<string, { display: string; n: number }>();
  for (const row of skips) {
    const name = String(row.exercise ?? "").trim();
    if (!name) continue;
    const key = normalizedExerciseKey(name) || name.toLowerCase();
    const cur = skipCount.get(key);
    if (cur) cur.n++;
    else skipCount.set(key, { display: name, n: 1 });
  }

  // Nothing to say if there's neither a landing pattern nor a skip pattern.
  const reliable = landed.filter((d) => Number(d.n) >= Math.max(2, weeksRound * 0.6));
  const topSkip = [...skipCount.values()].sort((a, b) => b.n - a.n)[0];
  if (!reliable.length && !(topSkip && topSkip.n >= 2)) return null;

  const parts: string[] = [];
  if (reliable.length) {
    const names = reliable.slice(0, 2).map((d) => String(d.name || `Day ${d.dn}`));
    parts.push(`your ${names.join(" and ")} day${names.length > 1 ? "s" : ""} land most weeks`);
  }
  if (topSkip && topSkip.n >= 2) {
    parts.push(`${topSkip.display} gets skipped the most`);
  }
  if (!parts.length) return null;
  const joined = parts.join("; ");
  const statement = joined.charAt(0).toUpperCase() + joined.slice(1) + ".";
  return {
    id: "adherence",
    kind: "adherence",
    statement,
    confidence: weeksRound >= 8 ? "strong" : "observed",
    evidence_n: weeksRound,
    domains: ["training"],
    last_observed: span.last,
    params: { weeks: weeksRound, reliable_days: reliable.length, top_skip_n: topSkip?.n ?? 0 },
  };
}

// ---------------------------------------------------------------------------
// 5) volume_soreness — weeks where a muscle's high set-volume coincides with a
//    self-reported soreness / joint-pain flag (>=4 on the 1-5 scale, or a
//    free-text joint flag). Gate: a real coincidence.
// ---------------------------------------------------------------------------
function volumeSoreness(): ReactionPattern | null {
  let flagged: any[] = [];
  try {
    flagged = db
      .prepare(
        `SELECT id, date, soreness, joint_pain FROM sessions
        WHERE (soreness IS NOT NULL AND soreness >= 4) OR (joint_pain IS NOT NULL AND TRIM(joint_pain) != '')
        ORDER BY date DESC LIMIT 40`
      )
      .all() as any[];
  } catch {
    return null;
  }
  if (!flagged.length) return null;

  // For each flagged session, find the muscle group that carried the most sets
  // that week (the prior 7 days through the session date). A coincidence is a
  // group that shows up as the top-volume group on >=2 flagged weeks.
  const groupHits = new Map<string, number>();
  let lastObserved: string | null = null;
  for (const s of flagged) {
    const date = String(s.date).slice(0, 10);
    const start = isoDaysAgo(date, 6);
    let rows: any[] = [];
    try {
      rows = db
        .prepare(
          `SELECT e.muscle_group AS mg, COUNT(*) AS sets
           FROM logged_sets ls JOIN sessions ss ON ss.id = ls.session_id JOIN exercises e ON e.id = ls.exercise_id
          WHERE ss.date >= ? AND ss.date <= ?
          GROUP BY e.id`
        )
        .all(start, date) as any[];
    } catch {
      rows = [];
    }
    const byGroup = new Map<string, number>();
    for (const r of rows) {
      const g = canonicalGroup(r.mg) ?? null;
      if (!g || isMobility(g)) continue;
      byGroup.set(g, (byGroup.get(g) ?? 0) + Number(r.sets || 0));
    }
    const top = [...byGroup.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 8) {
      groupHits.set(top[0], (groupHits.get(top[0]) ?? 0) + 1);
      if (!lastObserved || date > lastObserved) lastObserved = date;
    }
  }
  const coincident = [...groupHits.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0];
  if (!coincident) return null; // gate: a real coincidence
  const [group, n] = coincident;
  const statement = `Heavy ${group} weeks tend to line up with the days you flag soreness — easing volume there a touch may help.`;
  return {
    id: "volume_soreness",
    kind: "training_response",
    statement,
    confidence: n >= 3 ? "observed" : "tentative",
    evidence_n: n,
    domains: ["training", "recovery"],
    last_observed: lastObserved,
    params: { coincident_weeks: n },
  };
}

// ---------------------------------------------------------------------------
// 6) data_gap — FIRST-CLASS: when synced sleep/HRV is stale or absent, say so,
//    so the coach never fabricates a recovery read it can't actually see.
//
//    WHY it is dark matters as much as that it is. This pattern used to report
//    one cause — the signal "has gone quiet" — for two unrelated situations: a
//    daily wearer whose series stopped, and an athlete who wears the watch for
//    runs and the odd baseline night, for whom a five-day gap is not a gap at
//    all. The agent read the same sentence in both cases and reasoned about a
//    sync problem that did not exist. The cadence now travels with the gap, so
//    an occasional series is attributed to SAMPLING rather than to a fault.
// ---------------------------------------------------------------------------
function dataGap(): ReactionPattern | null {
  const { date, age_days } = latestRecoveryDate();
  if (date == null || age_days == null) {
    return {
      id: "data_gap",
      kind: "data_gap",
      statement:
        "No synced sleep or HRV right now — recovery signal is dark, so reads lean on how you say you feel rather than a number.",
      confidence: "observed",
      evidence_n: 0,
      domains: ["recovery"],
      last_observed: null,
      params: { age_days: -1 },
    };
  }
  if (age_days > 2) {
    const today = localDateISO();
    const cadence = recoveryWearCadence(today);
    const view = wearAbsenceView(cadence, today);
    // `episodic` is the spot-check / intermittent wearer. Same fact, different
    // cause — and the cause is what the agent was getting wrong.
    const statement =
      view.shape === "episodic"
        ? `Sleep/HRV readings are occasional by pattern rather than nightly (${view.readings} in the last ${view.window_days} days${
            view.median_gap_days != null && view.median_gap_days > 0
              ? `, roughly ${view.median_gap_days} days apart`
              : ""
          }); the last one is about ${age_days} days old, so today's read can't lean on a current one. This is the sampling cadence, not a broken sync.`
        : `Your last synced sleep/HRV is about ${age_days} days old — recovery signal has gone quiet, so today's read can't lean on it.`;
    return {
      id: "data_gap",
      kind: "data_gap",
      statement,
      confidence: "observed",
      evidence_n: 0,
      domains: ["recovery"],
      last_observed: date,
      // INTERNAL only, like every `params` blob here: the coverage numbers the
      // statement above already says in words, so an ordering consumer does not
      // have to parse prose.
      params: {
        age_days,
        readings: view.readings,
        window_days: view.window_days,
        ...(view.median_gap_days != null ? { median_gap_days: view.median_gap_days } : {}),
      },
    };
  }
  return null; // fresh data → nothing to flag
}

// ---------------------------------------------------------------------------
// 7) intervention_marker (best-effort) — an applied plan/meal proposal or a
//    resolved health_directive that PREDATES a new reading of its target
//    marker → before→after delta + plain forecast direction.
//    Gate: a reading strictly AFTER the intervention + >=1 prior reading.
// ---------------------------------------------------------------------------
function interventionMarker(): ReactionPattern | null {
  let hist: any;
  try {
    hist = getMarkerHistory();
  } catch {
    return null;
  }
  const markers: any[] = Array.isArray(hist?.markers) ? hist.markers : [];
  if (!markers.length) return null;

  // Candidate interventions, each with an effective date + the marker it targets.
  interface Interv {
    date: string;
    marker: string | null;
    label: string;
  }
  const intervs: Interv[] = [];
  try {
    const dirs = db
      .prepare(
        `SELECT marker, status_at, directive FROM health_directives
        WHERE status = 'resolved' AND status_at IS NOT NULL AND marker IS NOT NULL`
      )
      .all() as any[];
    for (const d of dirs) {
      const dt = String(d.status_at).slice(0, 10);
      if (dt) intervs.push({ date: dt, marker: String(d.marker), label: "a resolved finding" });
    }
  } catch {
    /* table may be absent */
  }
  try {
    const props = db
      .prepare(`SELECT created_at FROM plan_proposals WHERE status = 'applied' ORDER BY created_at DESC LIMIT 6`)
      .all() as any[];
    const meals = db
      .prepare(`SELECT created_at FROM meal_plans WHERE status = 'applied' ORDER BY created_at DESC LIMIT 6`)
      .all() as any[];
    // Plan/meal applies aren't tied to a specific marker — recorded but
    // marker-less, so they can't anchor a marker series on their own here.
    for (const p of [...props, ...meals]) {
      const dt = String(p.created_at ?? "").slice(0, 10);
      if (dt) intervs.push({ date: dt, marker: null, label: "a plan change" });
    }
  } catch {
    /* ignore */
  }
  if (!intervs.length) return null;

  // Match a marker-targeted intervention to its marker series, requiring a
  // reading STRICTLY AFTER the intervention and >=1 prior reading.
  for (const iv of intervs) {
    if (!iv.marker) continue;
    const m = markers.find((mm) => {
      const key = String(mm.key || mm.name || "").toLowerCase();
      const nm = String(mm.name || "").toLowerCase();
      const t = String(iv.marker).toLowerCase();
      return key === t || nm === t || key.includes(t) || nm.includes(t) || t.includes(key);
    });
    if (!m || !Array.isArray(m.points) || m.points.length < 2) continue;
    const pts: Array<{ date: string; value: number }> = (m.points as any[])
      .map((p) => ({ date: String(p.date), value: Number(p.value) }))
      .filter((p) => p.date && Number.isFinite(p.value));
    const prior = pts.filter((p) => p.date <= iv.date);
    const after = pts.filter((p) => p.date > iv.date);
    if (prior.length < 1 || after.length < 1) continue; // gate
    const before = prior[prior.length - 1];
    const latest = after[after.length - 1];
    const delta = round(latest.value - before.value, 2);
    if (Math.abs(delta) < 1e-6) continue;
    const dirWord = delta < 0 ? "down" : "up";
    const fdir = m.forecast?.direction; // 'improving' | 'worsening' | 'stable' | null — plain word, no number
    const fclause =
      fdir === "improving"
        ? ", and it's still trending toward optimal"
        : fdir === "worsening"
          ? ", though it's since drifting the wrong way"
          : "";
    const statement = `Since ${iv.label}, your ${m.name} has moved ${dirWord} (from ${before.value} to ${latest.value})${fclause}.`;
    return {
      id: "intervention_marker",
      kind: "intervention_response",
      statement,
      confidence: after.length >= 2 ? "observed" : "tentative",
      evidence_n: prior.length + after.length,
      domains: ["watch", "nutrition"],
      last_observed: latest.date,
      params: { before: before.value, after: latest.value, delta },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 8) mileage_recovery — do bigger RUNNING weeks show up in the NEXT week's
//    resting heart rate? Weekly km (this week) vs the change in weekly-average
//    resting HR into the following week, pearson-style like load_crp. Resting HR
//    is the workhorse recovery signal (far better coverage than HRV), so this
//    reads off it. Gate: >=6 weeks having BOTH a run week AND both weeks' resting-
//    HR averages, so a thin RHR history can never manufacture the pattern.
// ---------------------------------------------------------------------------
function weekAvgRestingHr(endISO: string): number | null {
  const start = isoDaysAgo(endISO, 6);
  try {
    const g = db
      .prepare(
        `SELECT AVG(resting_hr) AS a, COUNT(*) AS n FROM garmin_daily_metrics
        WHERE date >= ? AND date <= ? AND resting_hr IS NOT NULL AND resting_hr > 0`
      )
      .get(start, endISO) as any;
    if (g && Number(g.n) >= 2 && g.a != null) return Number(g.a); // >=2 nights for a stable weekly avg
    const o = db
      .prepare(
        `SELECT AVG(resting_hr) AS a, COUNT(*) AS n FROM daily_metrics
        WHERE date >= ? AND date <= ? AND resting_hr IS NOT NULL AND resting_hr > 0`
      )
      .get(start, endISO) as any;
    if (o && Number(o.n) >= 2 && o.a != null) return Number(o.a);
  } catch {
    /* fall through */
  }
  return null;
}

function mileageRecovery(): ReactionPattern | null {
  const today = localDateISO();
  const weeks: Array<{ km: number; rhrDelta: number }> = [];
  let lastObserved: string | null = null;
  // Consecutive 7-day windows, most recent first. Week w ends at today−w·7; its
  // "next week" is week w−1 (more recent). Look back ~18 weeks.
  for (let w = 1; w <= 18; w++) {
    const km = weeklyKm(today, w, RUN_SPORT_PATTERNS);
    if (km <= 0) continue;
    const rhrThis = weekAvgRestingHr(isoDaysAgo(today, w * 7));
    const rhrNext = weekAvgRestingHr(isoDaysAgo(today, (w - 1) * 7));
    if (rhrThis == null || rhrNext == null) continue;
    weeks.push({ km, rhrDelta: rhrNext - rhrThis });
    const nextEnd = isoDaysAgo(today, (w - 1) * 7);
    if (!lastObserved || nextEnd > lastObserved) lastObserved = nextEnd;
  }
  if (weeks.length < 6) return null; // gate: >=6 paired weeks
  const r = pearson(weeks.map((wk) => ({ x: wk.km, y: wk.rhrDelta })));
  if (r == null || Math.abs(r) < 0.4) return null; // only speak on a real coincidence
  const risesWithLoad = r > 0;
  const confidence: ReactionPattern["confidence"] =
    Math.abs(r) >= 0.75 && weeks.length >= 8 ? "strong" : Math.abs(r) >= 0.6 ? "observed" : "tentative";
  const statement = risesWithLoad
    ? "Your bigger running weeks tend to be followed by a higher resting heart rate the next week — a sign your body is still absorbing the load. Worth easing off in the days after a volume jump."
    : "After your bigger running weeks, your resting heart rate has tended to settle a little lower the following week — a sign the aerobic work is landing well.";
  return {
    id: "mileage_recovery",
    kind: "endurance_response",
    statement,
    confidence,
    evidence_n: weeks.length,
    domains: ["endurance", "recovery"],
    last_observed: lastObserved,
    params: { r: round(r, 3), weeks: weeks.length },
  };
}

// ---------------------------------------------------------------------------
// 9) easy_pace_efficiency — at the SAME easy heart rate, is easy-run pace
//    improving? Over easy runs only (aerobic training effect < 3.5 — or an easy
//    Garmin te_label — AND avg HR inside the athlete's own observed easy band),
//    compare pace in matched ±5 bpm HR buckets, older half vs newer half, over the
//    last ~120 days. Controlling for HR is what makes a pace change meaningful
//    (faster at the same effort = a fitter aerobic engine). Gate: >=4 qualifying
//    easy runs per half AND enough matched-HR overlap between the halves.
// ---------------------------------------------------------------------------
const EASY_TE_LABELS = new Set(["RECOVERY", "BASE", "EASY", "AEROBIC_BASE", "LOW_AEROBIC"]);

function easyPaceEfficiency(): ReactionPattern | null {
  const today = localDateISO();
  const since = isoDaysAgo(today, 120);
  const sport = activitySportWhere("a", RUN_SPORT_PATTERNS);
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT a.date AS date, a.distance_km AS km, a.duration_min AS min,
              g.avg_hr AS hr, g.aerobic_te AS aerobic_te, g.te_label AS te_label
         FROM activities a JOIN garmin_activities g ON g.activity_id = a.id
        WHERE a.date >= ? AND a.date <= ? AND (${sport.sql})
          AND g.avg_hr IS NOT NULL AND g.avg_hr > 0 AND a.distance_km > 0 AND a.duration_min > 0
        ORDER BY a.date`
      )
      .all(since, today, ...sport.params) as any[];
  } catch {
    return null;
  }
  if (rows.length < 8) return null; // need a real pool before splitting halves

  // The athlete's OWN easy band: the ~60th percentile of their run heart rates.
  const hrs = rows
    .map((r) => Number(r.hr))
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b);
  if (!hrs.length) return null;
  const easyCeiling = hrs[Math.floor(hrs.length * 0.6)];

  const easy = rows
    .map((r) => ({
      date: String(r.date),
      hr: Number(r.hr),
      pace: Number(r.min) / Number(r.km), // min per km
      te: r.aerobic_te == null ? null : Number(r.aerobic_te),
      label: String(r.te_label ?? "").toUpperCase(),
    }))
    .filter(
      (r) =>
        Number.isFinite(r.pace) &&
        r.pace > 2 &&
        r.pace < 12 && // sane min/km bounds
        r.hr <= easyCeiling &&
        (r.te != null ? r.te < 3.5 : EASY_TE_LABELS.has(r.label))
    );
  if (easy.length < 8) return null;

  // Older half vs newer half by date (a middle run is dropped on an odd count).
  const half = Math.floor(easy.length / 2);
  const older = easy.slice(0, half);
  const newer = easy.slice(easy.length - half);
  if (older.length < 4 || newer.length < 4) return null; // gate: >=4 per half

  // Match ±5 bpm HR buckets present in BOTH halves; weighted pace delta (newer − older).
  const bucket = (hr: number): number => Math.round(hr / 5) * 5;
  const olderByBucket = new Map<number, number[]>();
  const newerByBucket = new Map<number, number[]>();
  for (const r of older) olderByBucket.set(bucket(r.hr), [...(olderByBucket.get(bucket(r.hr)) ?? []), r.pace]);
  for (const r of newer) newerByBucket.set(bucket(r.hr), [...(newerByBucket.get(bucket(r.hr)) ?? []), r.pace]);
  let weight = 0;
  let deltaSum = 0;
  for (const [b, olderPaces] of olderByBucket) {
    const newerPaces = newerByBucket.get(b);
    if (!newerPaces || !newerPaces.length) continue;
    const w = Math.min(olderPaces.length, newerPaces.length);
    deltaSum += (mean(newerPaces) - mean(olderPaces)) * w;
    weight += w;
  }
  if (weight < 3) return null; // need enough matched-HR overlap to trust the comparison
  const paceDelta = deltaSum / weight; // min/km; negative = faster now
  if (Math.abs(paceDelta) < 0.1) return null; // < ~6 s/km is noise

  const secPerKm = Math.round(Math.abs(paceDelta) * 60);
  const faster = paceDelta < 0;
  const confidence: ReactionPattern["confidence"] = older.length >= 6 && newer.length >= 6 ? "observed" : "tentative";
  const statement = faster
    ? `At the same easy heart rate, you're running about ${secPerKm} sec/km faster than a few months ago — your aerobic base is getting stronger.`
    : `At the same easy heart rate, your easy pace has drifted about ${secPerKm} sec/km slower than a few months ago — worth a look at recovery, consistency, or whether easy days have crept too hard.`;
  return {
    id: "easy_pace_efficiency",
    kind: "endurance_response",
    statement,
    confidence,
    evidence_n: older.length + newer.length,
    domains: ["endurance"],
    last_observed: newer[newer.length - 1]?.date ?? null,
    params: { pace_delta_min_km: round(paceDelta, 3), matched_weight: weight },
  };
}

// ---- assembly ---------------------------------------------------------------

export function buildReactionModel(): { version: number; patterns: ReactionPattern[]; built_at_note?: string } {
  const candidates: Array<ReactionPattern | null> = [];
  // Each builder is independently fail-safe — wrap so one bad query never sinks
  // the whole model (deterministic + never throws on missing data).
  const safe = (fn: () => ReactionPattern | null): ReactionPattern | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  candidates.push(safe(loadCrp));
  candidates.push(safe(eventRecovery));
  candidates.push(safe(foodRecovery));
  candidates.push(safe(adherence));
  candidates.push(safe(volumeSoreness));
  candidates.push(safe(dataGap));
  candidates.push(safe(interventionMarker));
  candidates.push(safe(mileageRecovery));
  candidates.push(safe(easyPaceEfficiency));

  const patterns = candidates.filter((p): p is ReactionPattern => p != null);
  return { version: REACTION_MODEL_VERSION, patterns };
}

// ---- v2: evaluated decisions -> earned personal defaults -------------------

const PERSONAL_RESPONSE_VERSION = 2 as const;
const PERSONAL_RESPONSE_GUARDRAILS: CoachPersonalSafetyGuardrail[] = ["injury", "allergy", "clinical", "lean_safe"];

// Every declared modifier target, as a Record over the union rather than a plain array:
// adding a target to CoachPersonalModifierTarget without listing it here is a TYPE
// ERROR, not a silently under-sized cap. That is the whole point — the bug this exists
// to prevent was a cap that quietly fell below the number of targets in the contract.
const PERSONAL_MODIFIER_TARGETS: Record<CoachPersonalModifierTarget, true> = {
  nutrition_step: true,
  training_progression_step: true,
  run_volume_step: true,
  recovery_adjustment: true,
  plan_complexity: true,
};

// One slot per declared target is the FLOOR this cap may never fall below. The spare
// slots are headroom for the two kinds of variant a single target can legitimately
// carry, so backfilling either can never cost another target its slot — and each kind
// gets its OWN headroom, because a shared pool is just the starvation bug again one
// level down: a busy lifter's per-exercise readings would quietly eat the room the
// staged nutrition variants need.
const MAX_STAGE_VARIANTS = 3;
const MAX_SUBJECT_VARIANTS = 4;
const MAX_PERSONAL_MODIFIERS =
  Object.keys(PERSONAL_MODIFIER_TARGETS).length + MAX_STAGE_VARIANTS + MAX_SUBJECT_VARIANTS;

interface EvaluatedDecisionRow {
  decision_id: number;
  decision_kind: string;
  domain: string;
  decision_status: string;
  superseded_by: number | null;
  metric_key: string;
  subject_key: string | null;
  direction: string;
  expectation_confidence: CoachPersonalResponseConfidence;
  target: Record<string, unknown> | null;
  baseline: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
  verdict: "aligned" | "not_aligned";
  actual: Record<string, unknown> | null;
  evidence_keys: string[];
  confounders: string[];
  explanation: string;
  evaluated_at: string;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseList(value: unknown): string[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed
          .map((item) => String(item ?? "").trim())
          .filter(Boolean)
          .slice(0, 30)
      : [];
  } catch {
    return [];
  }
}

function evaluatedDecisionRows(): EvaluatedDecisionRow[] {
  try {
    const rows = db
      .prepare(
        `SELECT d.id AS decision_id, d.kind AS decision_kind, d.domain,
              d.status AS decision_status, d.superseded_by,
              x.metric_key, x.subject_key, x.direction,
              x.confidence AS expectation_confidence, x.target_json, x.baseline_json,
              d.context_json,
              e.verdict, e.actual_json, e.evidence_json, e.confounders_json,
              e.explanation, e.evaluated_at
         FROM brain_evaluations e
         JOIN brain_expectations x ON x.id = e.expectation_id
         JOIN brain_decisions d ON d.id = x.decision_id
        WHERE e.id = (
          SELECT e2.id FROM brain_evaluations e2
           WHERE e2.expectation_id = e.expectation_id
           ORDER BY e2.id DESC LIMIT 1
        )
          AND e.verdict IN ('aligned','not_aligned')
        ORDER BY e.evaluated_at DESC, e.id DESC
        LIMIT 500`
      )
      .all() as any[];
    // NEWEST 500, then reversed back into ascending order.
    //
    // The LIMIT has to bite at the OLD end. Ordered ascending, the same 500-row cap
    // froze the model on the oldest 500 conclusive evaluations the moment the ledger
    // grew past that: every outcome recorded afterwards fell off the end, and the
    // "personal defaults" the athlete was being coached with were an unchanging prefix
    // of their ancient history — a model that stops learning without ever saying so.
    // Descending picks the rows that still speak for today; the reverse restores the
    // ascending order every reader below is written against (run detection, the
    // preceding-verdict lookback, the day-read window).
    return rows
      .reverse()
      .map(
        (row): EvaluatedDecisionRow => ({
          decision_id: Number(row.decision_id),
          decision_kind: String(row.decision_kind ?? ""),
          domain: String(row.domain ?? ""),
          decision_status: String(row.decision_status ?? ""),
          superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
          metric_key: String(row.metric_key ?? ""),
          subject_key: row.subject_key == null ? null : String(row.subject_key),
          direction: String(row.direction ?? ""),
          expectation_confidence:
            row.expectation_confidence === "strong"
              ? "strong"
              : row.expectation_confidence === "observed"
                ? "observed"
                : "tentative",
          target: parseObject(row.target_json),
          baseline: parseObject(row.baseline_json),
          context: parseObject(row.context_json),
          verdict: row.verdict === "not_aligned" ? "not_aligned" : "aligned",
          actual: parseObject(row.actual_json),
          evidence_keys: parseList(row.evidence_json),
          confounders: parseList(row.confounders_json),
          explanation: String(row.explanation ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 300),
          evaluated_at: String(row.evaluated_at ?? "").replace(" ", "T"),
        })
      )
      .filter((row) => row.decision_id > 0 && row.metric_key && row.evaluated_at);
  } catch {
    // New installations create the ledger tables at boot, but this stays null-safe
    // for imported/partial databases and never blocks the existing seven builders.
    return [];
  }
}

const RECOMPOSITION_STAGES = new Set([
  "early_cut",
  "mid_cut",
  "leaning_out",
  "stabilizing",
  "maintenance",
  "lean_gain",
  "uncertain",
]);

function outcomeStage(row: EvaluatedDecisionRow): string {
  const stage = String(row.baseline?.recomposition_stage ?? row.context?.recomposition_stage ?? "unknown");
  return RECOMPOSITION_STAGES.has(stage) ? stage : "unknown";
}

// Metrics whose learning is bucketed per recomposition PHASE (so a mid-cut outcome
// never contaminates a lean-gain default). body_measurement_direction joins the two
// primary nutrition levers: a waist/measurement verdict is composition evidence for
// the same phase's intake step, so it stages the same way and only reaches the
// nutrition-step consumer when its decision recorded the phase it belongs to.
const STAGED_NUTRITION_METRICS = ["weight_trend_lb_wk", "intake_to_weight_response", "body_measurement_direction"];

function comparableKey(row: EvaluatedDecisionRow): string {
  const phase = STAGED_NUTRITION_METRICS.includes(row.metric_key) ? `stage=${outcomeStage(row)}` : "all-phases";
  return [row.decision_kind, row.metric_key, row.subject_key ?? "all", row.direction, phase].join(":");
}

function dayGap(later: string, earlier: string): number {
  const a = Date.parse(later.includes("T") ? later : `${later}T00:00:00Z`);
  const b = Date.parse(earlier.includes("T") ? earlier : `${earlier}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((a - b) / 864e5));
}

function measurementCount(row: EvaluatedDecisionRow): number {
  const keys = [
    "data_points",
    "weigh_ins",
    "intake_days",
    "exposures",
    "sessions",
    "nights",
    "readings",
    "measurements",
  ];
  const values = keys.map((key) => Number(row.actual?.[key])).filter(Number.isFinite);
  for (const evidence of row.evidence_keys) {
    const match = evidence.match(/(?:^|:)n=(\d+)/);
    if (match) values.push(Number(match[1]));
  }
  return values.length ? Math.max(...values) : 0;
}

function expectedText(row: EvaluatedDecisionRow): string {
  return `${metricLabel(row.metric_key)} to ${row.direction.replace(/_/g, " ")}`;
}

function boundedScale(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nutritionMissScale(row: EvaluatedDecisionRow): number {
  const actual = Number(row.actual?.value ?? row.actual?.delta ?? row.actual?.trend_lb_wk);
  const min = Number(row.target?.min ?? row.target?.minimum ?? row.target?.min_value);
  const max = Number(row.target?.max ?? row.target?.maximum ?? row.target?.max_value);
  if (Number.isFinite(actual) && Number.isFinite(min) && Number.isFinite(max)) {
    const desiredMinMagnitude = Math.min(Math.abs(min), Math.abs(max));
    const desiredMaxMagnitude = Math.max(Math.abs(min), Math.abs(max));
    if (Math.abs(actual) > desiredMaxMagnitude) return 0.85;
    if (Math.abs(actual) < desiredMinMagnitude) return 1.15;
  }
  // A miss without enough directional detail stays at the universal default.
  return 1;
}

// The one metric family that may ACCELERATE, and the conditions it has to clear.
//
// Every branch below used to be ease-or-hold: `scale = not_aligned ? 0.9 : 1`, so the
// declared `max: 1.1` on training_progression_step was unreachable and the model could
// only ever make the next step smaller or leave it alone. A response model that can
// only brake is not learning the athlete, it is only learning their bad weeks.
//
// The bar is deliberately high and entirely deterministic: a RUN of aligned verdicts
// (never a single one), zero missed verdicts anywhere in the comparable window (not
// merely none in the current run), and no training symptom on record — because the one
// thing a larger step must never do is stack onto something that already hurts.
const ACCELERATION_MIN_RUN = 2;

// …and WHICH members of the training family may earn it. The other two —
// session_performance_feedback and joint_pain_or_soreness — are safety FLOORS, not
// headroom. Their aligned bar is deliberately easy on purpose: "sessions did not rate
// materially worse than they already did" and "joint pain did not become more frequent
// than it already was". Clearing a floor twice says nothing broke; it is not evidence
// that there is room for more, and "the joints didn't get worse, twice" must never buy
// a bigger step. Only the two metrics that measure actual HEADROOM — targets being
// completed, and the lift's own estimate holding or climbing — can push. Both feedback
// guards keep their full ease-on-a-miss power, which is the asymmetry that matters.
const ACCELERATING_TRAINING_METRICS: ReadonlySet<string> = new Set([
  "exercise_target_completion",
  "exercise_est_1rm_trend",
]);

// Weekly RUNNING volume may accelerate too — and it is the most cautious lever in the
// system, deliberately held to a higher bar than the in-session load step above.
//
// Connective tissue adapts on a slower clock than cardio fitness: the aerobic engine
// says "that was easy" weeks before bone and tendon have finished remodelling around
// the mileage that produced it. So a run of aligned adherence verdicts is real evidence
// the athlete is ABSORBING the prescribed volume, but it is weaker evidence about the
// tissue than the same run would be about a lift, where the next session rechecks the
// step directly. Three consecutive aligned verdicts instead of two, and a ceiling of
// 1.05 rather than the load step's 1.1, is what that difference buys.
const RUN_VOLUME_ACCELERATION_MIN_RUN = 3;

// …unless the athlete has not merely MET the prescribed mileage but comfortably
// cleared it. Three aligned windows is the bar for "they are absorbing what we
// asked"; when the completion rate is well over 1 the evidence is stronger than a
// bare pass — the prescription was under the athlete's demonstrated capacity, and
// two such windows say more about headroom than three marginal ones do. The
// eased-into rule still adds its week on top, the ceiling is still 1.05, and the
// symptom and missed-window guards are untouched: this shortens the wait, it never
// removes a guard.
const RUN_VOLUME_OVERSHOOT_MIN_RUN = 2;
const RUN_VOLUME_OVERSHOOT_RATE = 1.15;

// DECLARED == REACHABLE. Both ends of this band are values the branch below can
// actually produce (0.9 on a miss, 1.05 on an earned acceleration) — an unreachable
// ceiling is a promise the model never has to keep, and the whole point of wiring
// acceleration at all was to stop declaring headroom that could not be reached.
const RUN_VOLUME_BOUNDS = { min: 0.9, max: 1.05 } as const;

// How far back a raw session-level joint-pain note still speaks for today.
const RECENT_JOINT_PAIN_DAYS = 14;

// Any symptom still standing, read on BOTH the places a symptom is recorded.
//
// Read straight off the tables rather than through listTrainingSymptoms for the reason
// stated at the top of this module (it must not import upward), and deliberately on the
// RAW stored status: an event whose lifecycle only resolves as of some later date still
// counts as live here, which errs toward holding the standard step rather than granting
// a larger one.
//
// The lifecycle table alone was not enough. `sessions.joint_pain` is where the athlete
// actually writes "left knee felt off" when finishing a session, and only some of those
// notes ever become a `training_symptom_events` row — so a fresh, hand-written joint
// complaint could sit in the log while the model handed out a bigger step on top of it.
// Both reads fail CLOSED: an unreadable table is not evidence of health.
function trainingSymptomOnRecord(asOf = localDateISO()): boolean {
  try {
    if (db.prepare(`SELECT 1 FROM training_symptom_events WHERE status = 'active' LIMIT 1`).get()) return true;
  } catch {
    // No lifecycle table (an imported or partial DB) is not evidence of health, so
    // the conservative reading is "something might be live" — no acceleration.
    return true;
  }
  try {
    const since = addDaysISO(asOf, -RECENT_JOINT_PAIN_DAYS) ?? asOf;
    return !!db
      .prepare(
        `SELECT 1 FROM sessions
          WHERE date BETWEEN ? AND ? AND joint_pain IS NOT NULL AND trim(joint_pain) <> '' LIMIT 1`
      )
      .get(since, asOf);
  } catch {
    return true;
  }
}

function modifierFor(
  row: EvaluatedDecisionRow,
  verdict: EvaluatedDecisionRow["verdict"],
  confidence: CoachPersonalResponseConfidence,
  evidenceN: number,
  window: {
    missed_n: number;
    preceding_verdict: EvaluatedDecisionRow["verdict"] | null;
    // How many of the most recent windows in the current run were cleared by a
    // clear margin rather than just met. Read by the run-volume branch only.
    overshoot_n?: number;
  }
): CoachPersonalModifier | null {
  let target: CoachPersonalModifierTarget | null = null;
  let scale = 1;
  let bounds = { min: 0.85, max: 1.15 };
  if (["weight_trend_lb_wk", "intake_to_weight_response"].includes(row.metric_key)) {
    target = "nutrition_step";
    scale = verdict === "not_aligned" ? nutritionMissScale(row) : 1;
  } else if (row.metric_key === "body_measurement_direction") {
    // A measured composition verdict is EVIDENCE for the same phase's intake step,
    // never a lever of its own. It can only HOLD (an aligned trend supports the
    // current step) or EASE toward conservative (a missed trend — the body isn't
    // tracking as expected, so the humble move is to hold back, not push). Capped at
    // max 1 so measurement evidence can never inflate a deficit; the primary weight
    // lever still owns any "go bigger" case, and lean-safe floors clamp downstream.
    target = "nutrition_step";
    bounds = { min: 0.9, max: 1 };
    scale = verdict === "not_aligned" ? 0.9 : 1;
  } else if (
    [
      "exercise_target_completion",
      "exercise_est_1rm_trend",
      "session_performance_feedback",
      "joint_pain_or_soreness",
    ].includes(row.metric_key)
  ) {
    target = "training_progression_step";
    // DECLARED == REACHABLE, the same rule RUN_VOLUME_BOUNDS states above. The branch
    // below can produce exactly three scales — 0.9 on a miss, 1 by default, 1.1 on an
    // earned acceleration — so a declared floor of 0.85 was a depth of caution the
    // model had no way to reach.
    bounds = { min: 0.9, max: 1.1 };
    // Ease on a miss; hold by default; and — the branch this family alone gets —
    // ACCELERATE to the declared ceiling when a run of aligned verdicts has stood up
    // with nothing missed against it, no symptom on record, and the metric is one that
    // can measure headroom at all (see ACCELERATING_TRAINING_METRICS). Capped by
    // `bounds` through boundedScale below, so the ceiling is the declared 1.1 and not a
    // number this branch invents.
    scale =
      verdict === "not_aligned"
        ? 0.9
        : verdict === "aligned" &&
            ACCELERATING_TRAINING_METRICS.has(row.metric_key) &&
            evidenceN >= ACCELERATION_MIN_RUN &&
            window.missed_n === 0 &&
            !trainingSymptomOnRecord()
          ? bounds.max
          : 1;
  } else if (row.metric_key === "run_volume_adherence") {
    // A missed run-volume expectation (the athlete isn't absorbing the prescribed km)
    // eases the weekly build step; a met one holds the standard build; and a sustained
    // run of met ones may now earn a slightly larger one — the slowest, most heavily
    // guarded acceleration in the model (see RUN_VOLUME_ACCELERATION_MIN_RUN).
    //
    // FOUR conditions, each of which alone withholds the acceleration:
    //   1. a run of >=3 consecutive aligned verdicts — one more than the load step asks,
    //      because a week of mileage is not recheckable next session the way a lift is;
    //   2. nothing missed ANYWHERE in the comparable window, not merely none inside the
    //      current run — one week the athlete could not absorb outranks three they could;
    //   3. no training symptom on record (the lifecycle table AND raw session joint-pain
    //      notes, both failing CLOSED) — mileage must never stack onto something already
    //      sore;
    //   4. no ease immediately before this run. A miss eases the step, and the FIRST
    //      aligned verdict after it only earns back the standard build; acceleration has
    //      to wait for a full clean cycle at 1.0 on top of that. Otherwise one good week
    //      after a bad one whipsaws the athlete from a reduced build straight to a
    //      raised one, which is exactly the pattern that breaks tendons.
    //
    // vo2max_trend is still deliberately NOT wired here: aerobic fitness trending up is
    // an OUTCOME, not headroom-per-decision, and a flat 4-week VO2max is normal and no
    // reason to ease volume either. It stays a pure ledger-accountability read.
    target = "run_volume_step";
    bounds = { ...RUN_VOLUME_BOUNDS };
    const easedIntoThisRun = window.preceding_verdict === "not_aligned";
    // Condition 1 relaxes — and ONLY condition 1 — when the recent windows were
    // cleared by a clear margin. An athlete running well past what was prescribed is
    // telling the model the prescription was under them; making them wait a third
    // window to say so is how a plan stays quietly too small for a season.
    const clearlyExceeded = (window.overshoot_n ?? 0) >= RUN_VOLUME_OVERSHOOT_MIN_RUN;
    const requiredRun =
      (clearlyExceeded ? RUN_VOLUME_OVERSHOOT_MIN_RUN : RUN_VOLUME_ACCELERATION_MIN_RUN) + (easedIntoThisRun ? 1 : 0);
    scale =
      verdict === "not_aligned"
        ? 0.9
        : verdict === "aligned" && evidenceN >= requiredRun && window.missed_n === 0 && !trainingSymptomOnRecord()
          ? bounds.max
          : 1;
  } else if (["recovery_hrv_delta", "recovery_rhr_delta", "sleep_duration_delta"].includes(row.metric_key)) {
    target = "recovery_adjustment";
    bounds = { min: 0.9, max: 1.15 };
    scale = verdict === "not_aligned" ? 1.1 : 1;
  } else if (row.metric_key === "plan_day_adherence") {
    target = "plan_complexity";
    bounds = { min: 0.85, max: 1 };
    scale = verdict === "not_aligned" ? 0.9 : 1;
  }
  if (!target) return null; // clinical/marker learnings stay informational
  scale = boundedScale(scale, bounds.min, bounds.max);
  return {
    key: comparableKey(row),
    target,
    stage: STAGED_NUTRITION_METRICS.includes(row.metric_key) ? outcomeStage(row) : null,
    subject_key: row.subject_key,
    scale,
    bounds,
    confidence,
    evidence_n: evidenceN,
    rationale: modifierRationale(scale, target),
    never_overrides: [...PERSONAL_RESPONSE_GUARDRAILS],
  };
}

function modifierRationale(scale: number, target: CoachPersonalModifierTarget, aged = false): string {
  const direction = scale > 1 ? "a slightly larger" : scale < 1 ? "a slightly more conservative" : "the standard";
  const earned = `${direction} ${target.replace(/_/g, " ")} is the earned default`;
  return aged
    ? `${earned}, softened because the outcome behind it is months old; re-evaluate after the next clean outcome.`
    : `${earned}; re-evaluate after the next clean outcome.`;
}

// ---- a learned default has a shelf life -----------------------------------
// The 365-day horizon inside learningForGroup is relative to the GROUP's own newest
// row, which answers "were these outcomes comparable to each other?" — a real
// question, and not the one that matters here. Two outcomes three years ago are
// perfectly comparable to each other and say nothing about the athlete this morning,
// yet the modifier they earned was applied at full scale and full confidence forever.
//
// So the lever ages against TODAY, deterministically:
//   • up to 180 days   — full strength, this is a current learning;
//   • 180 to 365 days  — the scale fades LINEARLY toward 1.0 (the universal default)
//                        and the confidence drops one band, so a stale learning
//                        loosens its grip gradually rather than falling off a cliff;
//   • past 365 days    — no modifier at all. The learning keeps its sentence in the
//                        prose (which is stamped with its date, so the athlete can see
//                        how old it is); what it loses is the right to move a number.
// The whatWorksForYou memo keys on today's date, so the fade recomputes each morning.
const MODIFIER_FULL_STRENGTH_DAYS = 180;
const MODIFIER_EXPIRY_DAYS = 365;

const CONFIDENCE_ONE_BAND_DOWN: Record<CoachPersonalResponseConfidence, CoachPersonalResponseConfidence> = {
  strong: "observed",
  observed: "tentative",
  tentative: "tentative",
};

function agedModifier(
  modifier: CoachPersonalModifier | null,
  lastObserved: string,
  today: string
): CoachPersonalModifier | null {
  if (!modifier) return null;
  const age = dayGap(today, lastObserved);
  if (age > MODIFIER_EXPIRY_DAYS) return null;
  if (age <= MODIFIER_FULL_STRENGTH_DAYS) return modifier;
  const remaining = (MODIFIER_EXPIRY_DAYS - age) / (MODIFIER_EXPIRY_DAYS - MODIFIER_FULL_STRENGTH_DAYS);
  const faded = Math.round((1 + (modifier.scale - 1) * remaining) * 1000) / 1000;
  return {
    ...modifier,
    scale: boundedScale(faded, modifier.bounds.min, modifier.bounds.max),
    confidence: CONFIDENCE_ONE_BAND_DOWN[modifier.confidence],
    rationale: modifierRationale(faded, modifier.target, true),
  };
}

function learningForGroup(
  allRows: EvaluatedDecisionRow[],
  today: string
): { learning: CoachOutcomeLearning; modifier: CoachPersonalModifier | null } | null {
  // Evidence counts decisions, not expectations. A single decision may carry two
  // windows for the same metric; treating those as two independent trials would
  // let one intervention manufacture confidence.
  const byDecision = new Map<number, EvaluatedDecisionRow>();
  for (const row of allRows) {
    // `applied` only. A day read is never applied — it is a suggestion the athlete
    // may take or leave — so those rows are excluded here and read separately by
    // dayReadAdherenceLearnings() below, which is also where the reason they must
    // NOT produce a modifier is written down.
    if (row.decision_status !== "applied" || row.superseded_by != null || row.confounders.length > 0) continue;
    const prior = byDecision.get(row.decision_id);
    if (!prior || row.evaluated_at >= prior.evaluated_at) byDecision.set(row.decision_id, row);
  }
  const eligible = [...byDecision.values()].sort((a, b) => a.evaluated_at.localeCompare(b.evaluated_at));
  if (!eligible.length) return null;
  const latestDate = eligible[eligible.length - 1].evaluated_at;
  const rows = eligible.filter((row) => dayGap(latestDate, row.evaluated_at) <= 365);
  if (!rows.length) return null;

  const latest = rows[rows.length - 1];
  let runStart = rows.length - 1;
  while (runStart > 0 && rows[runStart - 1].verdict === latest.verdict) runStart--;
  const latestRun = rows.slice(runStart);
  const hasContradiction = rows.some((row) => row.verdict !== latest.verdict);
  const strongSingle = rows.length === 1 && latest.expectation_confidence === "strong" && measurementCount(latest) >= 6;
  if (rows.length < 2 && !strongSingle) return null;

  const alignedN = rows.filter((row) => row.verdict === "aligned").length;
  const missedN = rows.length - alignedN;
  const contradictions = rows
    .slice(1)
    .reduce((count, row, index) => count + (row.verdict !== rows[index].verdict ? 1 : 0), 0);
  const unresolvedContradiction = hasContradiction && latestRun.length < 2;
  const activeVerdict = unresolvedContradiction ? null : latest.verdict;
  const confidence: CoachPersonalResponseConfidence = unresolvedContradiction
    ? "tentative"
    : (latestRun.length >= 4 && contradictions === 0) || (strongSingle && measurementCount(latest) >= 12)
      ? "strong"
      : "observed";
  const supersededEvidenceN = activeVerdict ? rows.filter((row) => row.verdict !== activeVerdict).length : 0;
  const label = metricLabel(latest.metric_key);
  const statement = unresolvedContradiction
    ? `Recent ${label} outcomes conflict, so the standard default stays in place until the response repeats.`
    : activeVerdict === "aligned"
      ? `${label.charAt(0).toUpperCase() + label.slice(1)} has matched the expectation across ${latestRun.length} comparable decision${latestRun.length === 1 ? "" : "s"}.`
      : `${label.charAt(0).toUpperCase() + label.slice(1)} has missed the expectation across ${latestRun.length} comparable decisions, so the next step should change modestly and be rechecked.`;
  // What the ledger said IMMEDIATELY BEFORE the current run began — read off the full
  // comparable history rather than the 365-day slice, because that is the whole point:
  // a miss that has aged out of `rows` no longer shows up in `missed_n`, and without
  // this the model would forget the ease it just applied and jump straight to a bigger
  // step. Null when this run is the athlete's entire history on the metric.
  const runStartRow = rows[runStart];
  const runStartIndex = eligible.indexOf(runStartRow);
  const precedingVerdict = runStartIndex > 0 ? eligible[runStartIndex - 1].verdict : null;
  // The trailing streak of windows the athlete cleared by a clear margin, not merely
  // met. Counted from the newest backwards and stopping at the first window that was
  // only met, so it describes the CURRENT picture rather than a good patch somewhere
  // in the middle of the run.
  let overshootN = 0;
  for (let i = latestRun.length - 1; i >= 0; i--) {
    const rate = Number(latestRun[i].actual?.completion_rate ?? latestRun[i].actual?.value);
    if (Number.isFinite(rate) && rate >= RUN_VOLUME_OVERSHOOT_RATE) overshootN++;
    else break;
  }
  const earnedModifier = activeVerdict
    ? modifierFor(latest, activeVerdict, confidence, latestRun.length, {
        missed_n: missedN,
        preceding_verdict: precedingVerdict,
        overshoot_n: overshootN,
      })
    : null;
  const modifier = agedModifier(earnedModifier, latest.evaluated_at, today);
  const change = modifier
    ? modifier.rationale
    : earnedModifier
      ? // It earned a default once and has simply gone quiet since. Said plainly, because
        // this sentence is rendered to the athlete in the Learned timeline next to the
        // date it was last seen.
        "It has been long enough since this last showed up that the standard default stands again until it repeats."
      : unresolvedContradiction
        ? "Keep the universal default while collecting another comparable outcome."
        : "Keep this learning informational; it cannot set a clinical or safety policy.";
  return {
    learning: {
      key: comparableKey(latest),
      domain: latest.domain,
      metric_key: latest.metric_key,
      subject_key: latest.subject_key,
      stage: STAGED_NUTRITION_METRICS.includes(latest.metric_key) ? outcomeStage(latest) : null,
      statement,
      expected: expectedText(latest),
      observed:
        latest.explanation || (activeVerdict === "aligned" ? "The result matched." : "The result did not match."),
      change,
      confidence,
      evidence_n: rows.length,
      aligned_n: alignedN,
      missed_n: missedN,
      contradictions,
      superseded_evidence_n: supersededEvidenceN,
      last_observed: latest.evaluated_at,
    },
    modifier,
  };
}

// ---- the day read, read back ---------------------------------------------
// The ledger's highest-VOLUME metric and, until now, the one it learned nothing
// from. Two things kept it out of learningForGroup above:
//   • its decisions are recorded `observed`, never `applied` — a read is a
//     suggestion, so there is nothing to apply — and that filter dropped every row;
//   • even past it, `comparableKey` carries `subject_key`, which for this metric is
//     the READ DATE. Every day would have been its own singleton group and no group
//     would ever have reached the two-outcome minimum.
// So it gets its own read: grouped by the READ KIND the verdicts are about, which is
// the question worth asking of them ("what happens on the mornings this reads rest?").
//
// PROSE ONLY, and that is a hard rule, not a simplification. `restOverrideSoftening`
// (src/repo/brain/read-adherence.ts, consumed by dayRead) ALREADY acts on these exact
// rows — it is what turns a repeatedly-overruled rest read into an easy day. A
// modifier derived here would read the same evidence a second time and move a
// second lever with it, which is double-counting one pattern as two. These learnings
// therefore never reach `modifiers`, and `modifierFor` is never called for them.
const READ_ADHERENCE_MIN_OUTCOMES = 4;
const READ_KIND_LABEL: Readonly<Record<string, string>> = {
  rest: "reads rest",
  easy: "reads easy",
  train: "reads train",
};

function dayReadAdherenceLearnings(rows: EvaluatedDecisionRow[]): CoachOutcomeLearning[] {
  const byKind = new Map<string, EvaluatedDecisionRow[]>();
  for (const row of rows) {
    // Filtered on the VERDICT, never on `superseded_by`. A read whose outcome the day
    // had already decided keeps its expectation through a later recompute (see
    // dayReadOutcomeLocked in brain/read-adherence.ts), so its decision carries a
    // `superseded_by` while its verdict is a genuine, conclusive one — and this filter
    // was the last place that evidence could still be silently dropped on its way to
    // the Learned timeline. A claim the replacement really did retire reads
    // `canceled`, which is what this excludes instead.
    if (row.metric_key !== DAY_READ_ADHERENCE_METRIC || String(row.verdict) === "canceled") continue;
    const kind = String(row.baseline?.read_kind ?? row.actual?.read_kind ?? "");
    if (!READ_KIND_LABEL[kind]) continue;
    byKind.set(kind, [...(byKind.get(kind) ?? []), row]);
  }
  const out: CoachOutcomeLearning[] = [];
  for (const [kind, all] of byKind) {
    const ordered = [...all].sort((a, b) => a.evaluated_at.localeCompare(b.evaluated_at));
    const latestDate = ordered[ordered.length - 1].evaluated_at;
    // Same 365-day horizon the applied learnings use, so one stale year cannot speak
    // for the current athlete.
    const window = ordered.filter((row) => dayGap(latestDate, row.evaluated_at) <= 365);
    if (window.length < READ_ADHERENCE_MIN_OUTCOMES) continue;
    const followed = window.filter((row) => row.verdict === "aligned").length;
    const diverged = window.length - followed;
    // A pattern, not a tally: it has to be lopsided before it is worth a sentence.
    const majority = Math.max(followed, diverged);
    if (majority * 3 < window.length * 2) continue;
    const followsIt = followed >= diverged;
    const label = READ_KIND_LABEL[kind];
    // Second person, because these two sentences are the ONE place in this module whose
    // output is rendered verbatim to the athlete (learned-timeline's Learned entries).
    // Everything else here is the machine register the model and the provenance trail
    // read; "they usually take it" printed on a screen the athlete is reading is the
    // same voice bug the signal state's `summary` already had.
    const statement = followsIt
      ? `When the morning ${label}, you usually take it — ${followed} of the last ${window.length}.`
      : `When the morning ${label}, you usually train anyway — ${diverged} of the last ${window.length}.`;
    out.push({
      key: `day_read:${DAY_READ_ADHERENCE_METRIC}:${kind}`,
      domain: "cross_domain",
      metric_key: DAY_READ_ADHERENCE_METRIC,
      subject_key: kind,
      stage: null,
      statement,
      expected: `the ${kind} read to be followed`,
      observed: `${followed} followed, ${diverged} diverged`,
      // What this learning is FOR, said plainly and TO the athlete — it lands right
      // after the statement above in the Learned timeline. It shapes how a read is
      // worded and how much weight sits behind it, and it moves no number by itself.
      change: "It shapes how confidently the morning read is offered — never what it's allowed to say.",
      confidence: window.length >= 10 ? "observed" : "tentative",
      evidence_n: window.length,
      aligned_n: followed,
      missed_n: diverged,
      contradictions: window
        .slice(1)
        .reduce((count, row, index) => count + (row.verdict !== window[index].verdict ? 1 : 0), 0),
      superseded_evidence_n: 0,
      last_observed: latestDate,
    });
  }
  // Newest first, and capped: this is a footnote on the model, not the model.
  return out.sort((a, b) => b.last_observed.localeCompare(a.last_observed)).slice(0, 2);
}

// MEMOIZED (repo/training-cache.ts), same shape as getProgramState's memo. This is
// a pure function of the decision ledger, and it is now read several times per day
// read (the progression ladder, the run ladder and the coach context each ask), each
// call paying for a correlated latest-evaluation subquery over brain_evaluations
// joined across expectations and decisions, plus the grouping pass over 500 rows.
//
// The key is the shared training version PLUS a backstop over this module's OWN
// inputs, because the training counter alone cannot see them: nothing in
// brain-decisions.ts bumps it, and an evaluator writing overnight would otherwise
// serve yesterday's model. The backstop carries
//   • COUNT + MAX(id) over the three ledger tables the query reads (inserts, deletes);
//   • two status aggregates over brain_decisions — `applied` and superseded — because
//     those fields are edited IN PLACE by transitionBrainDecision/patchBrainDecision
//     and are exactly the fields the grouping filters on;
//   • the safety read itself. trainingSymptomOnRecord() withholds every acceleration,
//     and it answers off an in-place `status` edit AND a rolling window over
//     `sessions.joint_pain` — a note that simply AGES OUT changes the answer with no
//     write at all, so the flag (and today's date with it) belongs in the key rather
//     than any count. Two indexed LIMIT-1 reads, next to the 500-row join they guard.
// The training version stays in the key as the cheap over-invalidation belt: a
// session-feedback edit or a plan write costs one recompute, never staleness.
let whatWorksCache: { key: string; value: CoachWhatWorksForYou | null } | null = null;
registerTrainingCacheClear(() => {
  whatWorksCache = null;
});

function personalResponseBackstop(): string {
  try {
    const r = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM brain_evaluations) AS ec, (SELECT COALESCE(MAX(id),0) FROM brain_evaluations) AS em,
           (SELECT COUNT(*) FROM brain_expectations) AS xc, (SELECT COALESCE(MAX(id),0) FROM brain_expectations) AS xm,
           (SELECT COUNT(*) FROM brain_decisions) AS dc, (SELECT COALESCE(MAX(id),0) FROM brain_decisions) AS dm,
           (SELECT COUNT(*) FROM brain_decisions WHERE status = 'applied') AS dap,
           (SELECT COUNT(*) FROM brain_decisions WHERE superseded_by IS NOT NULL) AS dsup`
      )
      .get() as any;
    return [r?.ec, r?.em, r?.xc, r?.xm, r?.dc, r?.dm, r?.dap, r?.dsup].join("|");
  } catch {
    // A partial/imported DB without the ledger tables: never cache rather than risk
    // serving a stale model.
    return `noledger:${Math.random()}`;
  }
}

export function whatWorksForYou(): CoachWhatWorksForYou | null {
  const today = localDateISO();
  const key = `${currentTrainingDataVersion()}|${today}|${trainingSymptomOnRecord(today) ? 1 : 0}|${personalResponseBackstop()}`;
  if (whatWorksCache && whatWorksCache.key === key) {
    // Cloned on the way out: callers read `modifiers`/`learnings` and the arrays must
    // not become shared mutable state across reads.
    return whatWorksCache.value ? structuredClone(whatWorksCache.value) : null;
  }
  const value = computeWhatWorksForYou(today);
  whatWorksCache = { key, value };
  return value ? structuredClone(value) : null;
}

function computeWhatWorksForYou(today = localDateISO()): CoachWhatWorksForYou | null {
  const allRows = evaluatedDecisionRows();
  const groups = new Map<string, EvaluatedDecisionRow[]>();
  for (const row of allRows) {
    const key = comparableKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  // EVERY learning that qualified, newest first. The prose list below is capped for
  // calm; the modifier map is NOT selected from that cap — see the slot logic further
  // down for why deriving it from the top four silently switched targets off.
  const ranked = [...groups.values()]
    // Wrapped rather than passed by reference: Array.map hands the callback the INDEX
    // as its second argument, which is not the date this one wants.
    .map((rows) => learningForGroup(rows, today))
    .filter((item): item is NonNullable<typeof item> => item != null)
    .sort((a, b) => b.learning.last_observed.localeCompare(a.learning.last_observed));
  const learned = ranked.slice(0, 4);
  // Selected and capped SEPARATELY, then appended. A day read is evaluated every
  // morning, so these are always the most recent rows in the ledger — folded into the
  // sort above they would win the four slots outright and starve the very learnings
  // that carry modifiers, quietly switching off the personal response the progression
  // and nutrition layers read.
  const readPatterns = dayReadAdherenceLearnings(allRows);
  if (!learned.length && !readPatterns.length) return null;
  // Order modifiers so the PRIMARY nutrition levers (weight trend / intake response)
  // precede body-measurement evidence for the same target+stage: personalResponse-
  // ModifierFor takes the first match, so measurement evidence only sets the
  // nutrition step when the weight signal hasn't itself earned one. Stable sort keeps
  // the last_observed ordering within each rank; only body-measurement is demoted.
  const measurementRank = (metricKey: string): number => (metricKey === "body_measurement_direction" ? 1 : 0);
  const carriers = [...ranked]
    .filter((item) => item.modifier)
    .sort((a, b) => measurementRank(a.learning.metric_key) - measurementRank(b.learning.metric_key));

  // ONE SLOT PER TARGET, and the target claims it before any second reading of the same
  // target does.
  //
  // This used to be `learned.filter(…).slice(0, 4)`: four slots handed out by recency
  // across what are now FIVE declared targets, off a list that had already been cut to
  // the four most recent learnings for the prose. Whichever lever the athlete happened
  // to learn about least recently lost its modifier — silently, with no evidence that
  // anything had been dropped, and the consumer reading that target simply saw no
  // personal default. A busy ledger could switch off a whole lever.
  //
  // So the pass below is three-phase. Phase one gives each distinct target its most
  // recent modifier, which is the guarantee: no target can be displaced by another
  // target's fresher learning. Phases two and three backfill the variants a single
  // target may legitimately carry, because `personalResponseModifierFor` and
  // `trainingModifierFor` match on more than the bare target:
  //
  //   • STAGE — a mid-cut and a lean-gain nutrition step are different answers, not
  //     duplicates of one;
  //   • SUBJECT — a per-exercise training learning is about THAT lift. Collapsing every
  //     exercise into one training slot meant the newest lift's learned response was
  //     the only one that survived, and the progression ladder then either handed it to
  //     every other lift or found nothing at all for them.
  //
  // Ordering within each phase is unchanged, so the first match for a bare target
  // lookup is the same modifier it has always been.
  const claimedTargets = new Set<CoachPersonalModifierTarget>();
  const claimedSlots = new Set<string>();
  const perTarget: CoachPersonalModifier[] = [];
  const stageVariants: CoachPersonalModifier[] = [];
  const subjectVariants: CoachPersonalModifier[] = [];
  for (const item of carriers) {
    const modifier = item.modifier as CoachPersonalModifier;
    const slot = `${modifier.target}|${modifier.stage ?? ""}|${modifier.subject_key?.toLowerCase() ?? ""}`;
    if (claimedSlots.has(slot)) continue; // an older reading of the same target+stage+subject
    claimedSlots.add(slot);
    if (!claimedTargets.has(modifier.target)) {
      claimedTargets.add(modifier.target);
      perTarget.push(modifier);
    } else if (modifier.stage) stageVariants.push(modifier);
    else subjectVariants.push(modifier);
  }
  // Whole-athlete readings first among the subject backfill. A lift-level learning is
  // the newest thing in a busy lifter's ledger, so recency alone would drop the ONE
  // reading that answers for every other lift — the fallback every exercise without a
  // learning of its own depends on. Stable within each rank, so recency still decides
  // between two readings of the same kind.
  const globalFirst = [...subjectVariants].sort((a, b) => (a.subject_key ? 1 : 0) - (b.subject_key ? 1 : 0));
  const modifiers = [
    ...perTarget,
    ...stageVariants.slice(0, MAX_STAGE_VARIANTS),
    ...globalFirst.slice(0, MAX_SUBJECT_VARIANTS),
  ].slice(0, MAX_PERSONAL_MODIFIERS);
  return {
    version: PERSONAL_RESPONSE_VERSION,
    learnings: [...learned.map((item) => item.learning), ...readPatterns],
    modifiers,
  };
}

export function personalResponseModifierFor(
  target: CoachPersonalModifierTarget,
  opts: { stage?: string | null; response?: CoachWhatWorksForYou | null } = {}
): CoachPersonalModifier | null {
  const response = opts.response === undefined ? whatWorksForYou() : opts.response;
  if (!response) return null;
  return (
    response.modifiers.find(
      (modifier) => modifier.target === target && (opts.stage == null || modifier.stage === opts.stage)
    ) ?? null
  );
}

export function applyPersonalResponseModifier(input: {
  base: number;
  modifier: CoachPersonalModifier | null | undefined;
  min?: number;
  max?: number;
  safety_floor?: number;
  safety_ceiling?: number;
  hard_constraint?: CoachPersonalSafetyGuardrail | null;
}): number {
  const base = Number(input.base);
  if (!Number.isFinite(base)) throw new Error("personal modifier base must be finite");
  const lower = Math.max(input.min ?? -Infinity, input.safety_floor ?? -Infinity);
  const upper = Math.min(input.max ?? Infinity, input.safety_ceiling ?? Infinity);
  if (lower > upper) throw new Error("personal modifier bounds conflict with safety bounds");
  const modifier = input.modifier;
  const modifierMin = Number(modifier?.bounds?.min);
  const modifierMax = Number(modifier?.bounds?.max);
  const scale =
    !modifier || input.hard_constraint
      ? 1
      : boundedScale(
          Number(modifier.scale) || 1,
          Number.isFinite(modifierMin) ? modifierMin : 0.85,
          Number.isFinite(modifierMax) ? modifierMax : 1.15
        );
  const adjusted = base * scale;
  return Math.round(Math.max(lower, Math.min(upper, adjusted)) * 1000) / 1000;
}

const CONF_RANK: Record<ReactionPattern["confidence"], number> = { strong: 3, observed: 2, tentative: 1 };

// Strip the INTERNAL params blob — a defensive guard so the surfaced read can
// NEVER leak a coefficient/score even if a future caller serializes it raw.
function publicPattern(p: ReactionPattern): ReactionPattern {
  const { params, ...rest } = p;
  return rest;
}

export function reactionModelForCoach(): {
  patterns: ReactionPattern[];
  narrative: string | null;
  built_at: string | null;
  source: "cache" | "deterministic";
} {
  let patterns: ReactionPattern[] = [];
  let narrative: string | null = null;
  let builtAt: string | null = null;
  let source: "cache" | "deterministic" = "deterministic";

  const cached = getAppState("reaction_model");
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.patterns)) {
        patterns = parsed.patterns as ReactionPattern[];
        source = "cache";
        // "" (the cleared sentinel setReactionNarrative writes) reads back as no
        // narrative — the public contract is a real string or null, never empty.
        narrative = getAppState("reaction_model_narrative") || null;
        builtAt = getAppState("reaction_model_built_at");
      }
    } catch {
      /* corrupt cache → rebuild */
    }
  }
  if (source !== "cache") {
    patterns = buildReactionModel().patterns;
  }

  // Older caches may contain the retired circular intake/TDEE identity. Never
  // surface that row (or a narrative generated from it) after this upgrade.
  const retiredCircularClaim = patterns.some((pattern) => pattern.id === "deficit_response");
  patterns = patterns.filter((pattern) => pattern.id !== "deficit_response");
  if (retiredCircularClaim) narrative = null;

  // Strongest first (by confidence WORD, then evidence_n), capped at 6 — calm,
  // bounded output. Public shape strips the internal params number blob.
  const ranked = [...patterns]
    .sort(
      (a, b) =>
        (CONF_RANK[b.confidence] ?? 0) - (CONF_RANK[a.confidence] ?? 0) || (b.evidence_n ?? 0) - (a.evidence_n ?? 0)
    )
    .slice(0, 6)
    .map(publicPattern);

  return { patterns: ranked, narrative, built_at: builtAt, source };
}

// Persist (or clear) the plain-language "how your body responds" NARRATIVE — the
// warm agentic layer over the deterministic patterns, surfaced through
// reactionModelForCoach() (and GET /api/reaction-model + the coach context). This
// repo function only STORES the text: it's deterministic + agent-free, so the model
// layer never reaches an agent (coachOps.refreshReactionNarrative writes the text
// upstream). Trimmed + capped; null/empty CLEARS the slot (a "" sentinel that
// reactionModelForCoach reads back as null).
export function setReactionNarrative(text: string | null): void {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  setAppState("reaction_model_narrative", s ? s.slice(0, 600) : "");
}

export function saveReactionModel(): void {
  const model = buildReactionModel();
  const builtAt = new Date().toISOString();
  setAppState("reaction_model", JSON.stringify(model));
  setAppState("reaction_model_built_at", builtAt);
  // Every deterministic rebuild invalidates the prior prose, even when the new
  // model is non-empty: its evidence set or ordering may have changed. The later
  // agentic narrative pass may write fresh prose; until then the structured model
  // stands alone rather than leaking a stale interpretation.
  setReactionNarrative(null);
  // Promote the load-bearing patterns into coach memory so the agent has them in
  // its working context even outside the structured read. Only strong/observed —
  // a tentative pattern isn't durable enough to memorialize. addMemory dedupes.
  for (const p of model.patterns) {
    if (p.confidence === "strong" || p.confidence === "observed") {
      try {
        addMemory(p.statement, "reaction", "reaction-model");
      } catch {
        /* best-effort */
      }
    }
  }
}
