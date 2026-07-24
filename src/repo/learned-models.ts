// LEARNED CROSS-DOMAIN MODELS — where one domain's data quietly informs another.
//
// The census found two gaps the rule-based layers can't close on their own, both
// bounded, deterministic, null-safe patterns the day-read / coach context can
// speak to (the reaction-model + felt-signals pattern shape, matched exactly):
//
//   1) endurance_strength_interference — does THIS athlete's bigger RUNNING weeks
//      actually dent the quality of their next lower-body lifting? Rule-based
//      hybrid sequencing exists, but nothing LEARNS the personal interference. If
//      the athlete's own history says lower-body sessions come in flatter after
//      their heavier mileage weeks, the read can pre-acknowledge it and space the
//      hard leg day out. A pure coincidence read, never a gate.
//   2) sleep_fuel_correlation — after a short/poor-sleep night, hunger has often
//      run higher the next day for this person. A calm fueling context line
//      ("steadier fuel, an earlier protein anchor tend to help"). When the personal
//      correlation is derivable it speaks in the learned voice; otherwise the
//      day-line falls back to a deterministic short-night nudge, silent on a normal
//      night. Nothing to force, ever.
//
// CONSTITUTION (binding): calm, no numeric scores, pull-never-push, adherence-
// NEUTRAL (a thin history yields NOTHING, never a negative claim), a SUGGESTION
// never a gate. Learned claims use humble framing ("has tended to", "coincided
// with", never causal). Deterministic, agent-free, null-safe: every builder is
// wrapped so one bad query can never sink the model, and sparse data yields zero
// output.

import { db } from "../db.js";
import { getAppState, setAppState } from "./app-state.js";
import { localDateISO } from "./shared.js";
import { weeklyKm } from "./program-state.js";
import { RUN_SPORT_PATTERNS } from "./endurance-sports.js";
import { canonicalGroup } from "./exercise-canon.js";

export interface LearnedPattern {
  id: string;
  kind: "endurance_strength_interference" | "sleep_fuel_correlation";
  statement: string;
  confidence: "tentative" | "observed";
  evidence_n: number;
  domains: string[];
  // INTERNAL only — counts/deltas the builder reasoned with. NEVER surfaced as a
  // number/grade (the constitution bans scores); stripped by learnedModelsForCoach.
  params?: Record<string, number>;
}

const LEARNED_MODELS_VERSION = 1;

// ---- deterministic thresholds (named, so the gates are auditable) -----------

// 1) endurance ↔ strength interference
const INTERFERENCE_WEEKS_BACK = 16; // consecutive 7-day windows to scan
const INTERFERENCE_MIN_PAIRS = 4; // >=4 qualifying (run week -> next-week leg session) pairs
const INTERFERENCE_MIN_PER_BUCKET = 2; // >=2 pairs in EACH of the big / typical buckets
const INTERFERENCE_BIG_FACTOR = 1.15; // a "big" week is >=1.15x the athlete's own median run km
const INTERFERENCE_MIN_PERF_DELTA = 0.5; // typical-week perf must beat big-week perf by >=0.5 (of 1-5)
const LOWER_BODY_GROUPS = new Set(["quads", "hamstrings", "glutes", "calves"]);

// 2) short-sleep ↔ fueling
const SLEEP_FUEL_WINDOW_DAYS = 60;
const SHORT_SLEEP_MIN = 360; // < 6h wearable sleep reads as a short night
const POOR_SLEEP_FEEL = 2; // checkin sleep_feel <= 2 (of 1-5) reads as a rough night
const SLEEP_FUEL_MIN_PER_BUCKET = 4; // >=4 short-night AND >=4 normal-night days with a hunger read
const SLEEP_FUEL_MIN_HUNGER_DELTA = 0.4; // short-night hunger must exceed normal by >=0.4 (of 1-3)

// ---- small local helpers ----------------------------------------------------

function isoDaysAgo(dateISO: string, n: number): string {
  const base = Date.parse(dateISO + "T00:00:00Z");
  return new Date(base - n * 864e5).toISOString().slice(0, 10);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(v: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

// Wearable sleep minutes for a date (the night ending that morning — Garmin's
// wake-day convention), preferring Garmin. Null when neither table has it.
function wearableSleepMin(date: string): number | null {
  try {
    const g = db
      .prepare(
        `SELECT sleep_min FROM garmin_daily_metrics WHERE date = ? AND sleep_min IS NOT NULL AND sleep_min > 0 ORDER BY id DESC LIMIT 1`
      )
      .get(date) as any;
    if (g && g.sleep_min != null) return Number(g.sleep_min);
    const o = db
      .prepare(
        `SELECT sleep_min FROM daily_metrics WHERE date = ? AND sleep_min IS NOT NULL AND sleep_min > 0 ORDER BY updated_at DESC, id DESC LIMIT 1`
      )
      .get(date) as any;
    if (o && o.sleep_min != null) return Number(o.sleep_min);
  } catch {
    /* fall through */
  }
  return null;
}

// The subjective morning read for a date (1-5), when there's a check-in. Null otherwise.
function checkinSleepFeel(date: string): number | null {
  try {
    const r = db
      .prepare(`SELECT sleep_feel FROM checkins WHERE date = ? AND sleep_feel IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .get(date) as any;
    if (r && r.sleep_feel != null) {
      const v = Number(r.sleep_feel);
      return Number.isFinite(v) ? v : null;
    }
  } catch {
    /* fall through */
  }
  return null;
}

// Was the night ending on `date` genuinely short? true / false / null (no signal
// either way — a short-night nudge stays silent unless we can positively confirm).
// A wearable read is authoritative; the subjective sleep_feel is the fallback.
function shortNight(date: string): boolean | null {
  const sleepMin = wearableSleepMin(date);
  if (sleepMin != null) {
    if (sleepMin < SHORT_SLEEP_MIN) return true;
    // A comfortable wearable read still yields to a clearly-rough subjective one.
    const feel = checkinSleepFeel(date);
    return feel != null && feel <= POOR_SLEEP_FEEL;
  }
  const feel = checkinSleepFeel(date);
  if (feel != null) return feel <= POOR_SLEEP_FEEL;
  return null;
}

// ---------------------------------------------------------------------------
// 1) endurance_strength_interference — do bigger RUNNING weeks precede flatter
//    lower-body lifting for THIS athlete? Buckets consecutive weeks against the
//    athlete's OWN median run volume, pairs each run week with the average
//    performance-feedback of the lower-body strength sessions in the FOLLOWING 7
//    days, and only speaks when the big-week pairs come in meaningfully flatter.
//    Gate: >=4 qualifying pairs, >=2 in each bucket, and a real perf gap. A pure
//    coincidence read; running never gates the plan.
// ---------------------------------------------------------------------------

// Average `performance` (1-5) of the LOWER-BODY-dominant strength sessions in a
// window. A session is lower-body-dominant when its top canonical muscle group
// (by logged-set count) is quads/hamstrings/glutes/calves. Null when none qualify.
function lowerBodyPerf(startISO: string, endISO: string): number | null {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT s.id AS sid, s.performance AS perf, e.muscle_group AS mg, COUNT(*) AS sets
           FROM sessions s
           JOIN logged_sets ls ON ls.session_id = s.id
           JOIN exercises e ON e.id = ls.exercise_id
          WHERE s.date >= ? AND s.date <= ? AND s.performance IS NOT NULL
          GROUP BY s.id, e.id`
      )
      .all(startISO, endISO) as any[];
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const bySession = new Map<number, { perf: number; groups: Map<string, number> }>();
  for (const r of rows) {
    const sid = Number(r.sid);
    const perf = Number(r.perf);
    if (!Number.isFinite(perf) || perf < 1 || perf > 5) continue;
    const cur = bySession.get(sid) ?? { perf, groups: new Map<string, number>() };
    const g = canonicalGroup(r.mg);
    if (g) cur.groups.set(g, (cur.groups.get(g) ?? 0) + Number(r.sets || 0));
    bySession.set(sid, cur);
  }
  const perfs: number[] = [];
  for (const { perf, groups } of bySession.values()) {
    const top = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && LOWER_BODY_GROUPS.has(top[0])) perfs.push(perf);
  }
  return perfs.length ? mean(perfs) : null;
}

function enduranceStrengthInterference(refDate: string): LearnedPattern | null {
  // Pair each run week with its FOLLOWING week's lower-body lifting quality. Week
  // w covers [refDate-w*7-6, refDate-w*7]; the next 7 days are week w-1's window.
  const pairs: Array<{ km: number; perf: number }> = [];
  let lastObserved = "";
  for (let w = 1; w <= INTERFERENCE_WEEKS_BACK; w++) {
    const km = weeklyKm(refDate, w, RUN_SPORT_PATTERNS);
    if (km <= 0) continue; // only real run weeks anchor a pair
    const nextStart = isoDaysAgo(refDate, (w - 1) * 7 + 6);
    const nextEnd = isoDaysAgo(refDate, (w - 1) * 7);
    const perf = lowerBodyPerf(nextStart, nextEnd);
    if (perf == null) continue; // no lower-body session with feedback in the next week
    pairs.push({ km, perf });
    if (nextEnd > lastObserved) lastObserved = nextEnd;
  }
  if (pairs.length < INTERFERENCE_MIN_PAIRS) return null;

  // The athlete's OWN typical run week: the median km across the qualifying pairs.
  const med = median(pairs.map((p) => p.km));
  if (med <= 0) return null;
  const big = pairs.filter((p) => p.km >= med * INTERFERENCE_BIG_FACTOR);
  const typical = pairs.filter((p) => p.km < med * INTERFERENCE_BIG_FACTOR);
  if (big.length < INTERFERENCE_MIN_PER_BUCKET || typical.length < INTERFERENCE_MIN_PER_BUCKET) return null;

  const bigPerf = mean(big.map((p) => p.perf));
  const typicalPerf = mean(typical.map((p) => p.perf));
  const delta = typicalPerf - bigPerf; // positive = flatter lifting after big run weeks
  if (delta < INTERFERENCE_MIN_PERF_DELTA) return null; // no meaningful interference → stay quiet

  const evidenceN = pairs.length;
  return {
    id: "endurance_strength_interference",
    kind: "endurance_strength_interference",
    statement:
      "After your bigger running weeks, your lower-body sessions have tended to come in a little flat — spacing the hard leg day out from the heavy mileage has worked better. Worth a look, never a rule.",
    confidence: evidenceN >= 6 ? "observed" : "tentative",
    evidence_n: evidenceN,
    domains: ["endurance", "training"],
    params: { pairs: evidenceN, big_n: big.length, typical_n: typical.length, perf_delta: round(delta, 2) },
  };
}

// ---------------------------------------------------------------------------
// 2) sleep_fuel_correlation — after a short/poor-sleep night, does hunger run
//    higher the next day for THIS athlete? Joins each recent hunger read
//    (fueling_feedback, 1-3) to that day's night (short when wearable sleep is
//    below the floor, or the morning check-in reads rough) and compares. Gate:
//    >=4 short-night AND >=4 normal-night hunger reads, and a real hunger gap.
//    Adherence-neutral: sparse or non-differentiated data yields NOTHING.
// ---------------------------------------------------------------------------
function sleepFuelCorrelation(refDate: string): LearnedPattern | null {
  const since = isoDaysAgo(refDate, SLEEP_FUEL_WINDOW_DAYS);
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT date, hunger FROM fueling_feedback
          WHERE hunger IS NOT NULL AND date >= ? AND date <= ?
          ORDER BY date DESC, id DESC`
      )
      .all(since, refDate) as any[];
  } catch {
    return null;
  }
  if (!rows.length) return null;

  // One hunger read per day (the most recent), then bucket by that night's length.
  const byDate = new Map<string, number>();
  for (const r of rows) {
    const date = String(r.date ?? "").slice(0, 10);
    const hunger = Number(r.hunger);
    if (!date || !Number.isFinite(hunger) || hunger < 1 || hunger > 3) continue;
    if (!byDate.has(date)) byDate.set(date, hunger);
  }
  const shortHunger: number[] = [];
  const normalHunger: number[] = [];
  let lastObserved = "";
  for (const [date, hunger] of byDate) {
    const isShort = shortNight(date);
    if (isShort == null) continue; // no sleep signal that day → can't classify
    (isShort ? shortHunger : normalHunger).push(hunger);
    if (date > lastObserved) lastObserved = date;
  }
  if (shortHunger.length < SLEEP_FUEL_MIN_PER_BUCKET || normalHunger.length < SLEEP_FUEL_MIN_PER_BUCKET) return null;

  const delta = mean(shortHunger) - mean(normalHunger); // positive = hungrier after short nights
  if (delta < SLEEP_FUEL_MIN_HUNGER_DELTA) return null; // no meaningful coincidence → stay quiet

  const evidenceN = shortHunger.length + normalHunger.length;
  return {
    id: "sleep_fuel_correlation",
    kind: "sleep_fuel_correlation",
    statement:
      "On your shorter-sleep nights, hunger has tended to run higher the next day — a steadier fuel plan and an earlier protein anchor have helped. Nothing to force; just worth planning for on a rough night.",
    confidence: evidenceN >= 12 ? "observed" : "tentative",
    evidence_n: evidenceN,
    domains: ["recovery", "nutrition"],
    params: { short_n: shortHunger.length, normal_n: normalHunger.length, hunger_delta: round(delta, 2) },
  };
}

// ---- assembly ---------------------------------------------------------------

export function buildLearnedModels(refDate: string = localDateISO()): {
  version: number;
  patterns: LearnedPattern[];
} {
  const safe = (fn: () => LearnedPattern | null): LearnedPattern | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  const patterns = [
    safe(() => enduranceStrengthInterference(refDate)),
    safe(() => sleepFuelCorrelation(refDate)),
  ].filter((p): p is LearnedPattern => p != null);
  return { version: LEARNED_MODELS_VERSION, patterns };
}

// Strip the INTERNAL params blob — a defensive guard so the surfaced read can
// NEVER leak a count/delta even if a caller serializes it raw (GOLDEN discipline).
function publicPattern(p: LearnedPattern): LearnedPattern {
  const { params, ...rest } = p;
  return rest;
}

// Nightly insertion point (called alongside saveReactionModel / saveFeltSignals).
// Caches the freshly built patterns into app_state so getCoachContext reads them
// cheaply; a fresh DB with no nightly run yet falls back to a live build below.
export function saveLearnedModels(): void {
  const model = buildLearnedModels();
  setAppState("learned_models", JSON.stringify(model));
  setAppState("learned_models_built_at", new Date().toISOString());
}

// The public read for getCoachContext: cached patterns (params stripped), fresh
// fallback on a cold cache. Calm + bounded — a couple of humble patterns at most.
export function learnedModelsForCoach(): { patterns: LearnedPattern[]; built_at: string | null } {
  let patterns: LearnedPattern[] = [];
  let builtAt: string | null = null;
  // Distinguish "cache present but unparseable/misshapen" from "cache validly empty":
  // only a validly-parsed cache (even an empty patterns array) is authoritative.
  let cacheValid = false;
  const cached = getAppState("learned_models");
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && Array.isArray(parsed.patterns)) {
        patterns = parsed.patterns as LearnedPattern[];
        builtAt = getAppState("learned_models_built_at");
        cacheValid = true;
      }
    } catch {
      /* corrupt cache → rebuild live */
    }
  }
  // Rebuild live when there is no cache OR the cache is corrupt/misshapen; a validly
  // empty cache is honored (no rebuild).
  if (!patterns.length && !cacheValid) patterns = buildLearnedModels().patterns;
  return { patterns: patterns.map(publicPattern), built_at: builtAt };
}

// The day-read consumption: the calm lines relevant to `date`. The interference
// pattern is a standing tendency (surfaced whenever present). The sleep→fuel line
// is timely: it only fires when TONIGHT'S read for `date` was genuinely short —
// speaking in the learned voice when the personal correlation exists, otherwise a
// deterministic short-night nudge (silent on a normal night). Bounded to <=2 lines.
// Accepts pre-built (params-stripped) patterns from getCoachContext to avoid a
// second build.
export function learnedModelDayLines(date: string, patterns?: LearnedPattern[]): string[] {
  const pats = patterns ?? learnedModelsForCoach().patterns;
  const lines: string[] = [];

  const interference = Array.isArray(pats)
    ? pats.find((p) => p && p.kind === "endurance_strength_interference")
    : null;
  if (interference?.statement) lines.push(String(interference.statement).trim());

  // Short-night fueling nudge — only when this date's night positively reads short.
  let short: boolean | null = null;
  try {
    short = shortNight(date);
  } catch {
    short = null;
  }
  if (short === true) {
    const learned = Array.isArray(pats) ? pats.find((p) => p && p.kind === "sleep_fuel_correlation") : null;
    lines.push(
      learned?.statement
        ? String(learned.statement).trim()
        : "Short night — steadier fuel and an earlier protein anchor tend to help today. Nothing to force."
    );
  }
  return lines.slice(0, 2);
}
