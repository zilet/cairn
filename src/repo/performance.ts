// ============================================================================
// performance.ts — the TRAINING-INTELLIGENCE read. The athletic counterpart to
// the health Standing (src/repo/standing.ts): it answers "where are you, really?"
// the way a good coach does — by BENCHMARKING what you've actually logged against
// proven, sex- and age-adjusted strength standards (and VO2max norms), then
// surfacing the imbalances, the single biggest lever, the lifts worth re-TESTING,
// and a gentle nudge toward variety so training never becomes the same rotation
// every week.
//
// It sits ON TOP of the deterministic program-state floor (program-state.ts reads
// TRAJECTORY — progressing/stalling; progression.ts reads WHAT TO DO NEXT). This
// reads CAPACITY — your level relative to the population, for your age and sex —
// which neither of those did. The coach + day-read prompts fold it in so the brain
// reacts to where you genuinely stand, not just whether last week went up.
//
// Constitution: NO invented 0-100 score. A population PERCENTILE-for-age and a
// standard strength LEVEL (beginner→elite) are recognized, motivational reference
// reads (the same framing the health Standing uses, which the athlete asked to
// keep) — never a grade Cairn made up, never a gate. Pull, never push. Plain words.
// Everything here is derived LIVE each read, so it reacts to every logged set.
// ============================================================================
import { db } from "../db.js";
import { getRecoverySummary } from "./coach.js";
import { classifyPattern, type MovementPattern, suggestVariations } from "./exercise-variations.js";
import { findExercise } from "./exercises.js";
import { getProfile, listWeight } from "./profile.js";
import { type LiftState, getProgramState, type ProgramState } from "./program-state.js";
import { type ProgramBalance, programBalance } from "./progression.js";
import { localDateISO } from "./shared.js";
// Running re-tests + the cadenced strength test week + the DEXA lever. Imported for
// types + a lazy compute (called only inside performanceStanding/performanceLever,
// never at module init, so the run-progression → coach → performance cycle resolves
// at call time). All degrade null-safe / [].
import { enduranceTestsDue } from "./run-progression.js";
import { dexaTargeting, type DexaTargeting } from "./dexa-targeting.js";
import {
  bandForPercentile,
  compareCurve,
  type PercentilePoint,
  type ReferenceCurve,
  type Sex,
  sexOf,
  type Tone,
  VO2_CURVE,
} from "./standing.js";

// The age we compare against for the motivational "vs a 30-year-old" reference
// read (the reference_percentile in each comparison). 30 is a defensible peak.
const REFERENCE_AGE = 30;

// ---- strength reference standards -------------------------------------------
// Bodyweight-relative 1RM ratios (est-1RM ÷ bodyweight) by percentile, anchored to
// widely-published adult standards (StrengthLevel / ExRx / Lon Kilgore consensus),
// expressed at a ~30-year-old MALE baseline. We GENERATE the per-decade, per-sex
// bands from this base by (a) a female multiplier and (b) an age-decline schedule,
// then feed the athlete's actual ratio through the SAME compareCurve machinery the
// health Standing uses — so strength and VO2max both read as percentile-for-age.
const STRENGTH_PCTS = [10, 30, 50, 70, 90];

interface StrengthSpec {
  key: string;
  label: string;
  standard: string; // the canonical lift the percentile table assumes ("a barbell back squat")
  pattern: MovementPattern;
  base: number[]; // male, age-30 ratio at STRENGTH_PCTS
  femaleFactor: number; // multiply the base ratio for female athletes
  bodyweightRelative?: boolean; // pull-up: only benchmarkable when bodyweight-loaded
  // Variations within the pattern whose LOADING doesn't map to this standard's ratios
  // (a machine leg press loads ~1.8× a back squat; an RDL is a lighter hinge accessory
  // than a conventional deadlift). Benchmarking those against the standard would
  // mislead — so they're excluded, and the gap becomes a "log a true X to measure this"
  // prompt instead of a wrong percentile.
  excludeRe?: RegExp;
}

// Relative-to-age-30 strength factor per decade. Strength holds into the late 30s,
// then declines progressively. Used to shift the whole curve so a 44-year-old is
// graded fairly against their own age band, not a 25-year-old's.
const AGE_STRENGTH_FACTOR: Record<number, number> = {
  20: 1.0,
  30: 1.0,
  40: 0.95,
  50: 0.87,
  60: 0.78,
  70: 0.68,
};

const STRENGTH_SPECS: StrengthSpec[] = [
  {
    key: "bench",
    label: "Bench press",
    standard: "a barbell bench press",
    pattern: "horizontal-push",
    base: [0.55, 0.8, 1.05, 1.35, 1.75],
    femaleFactor: 0.62,
    excludeRe: /\bfly|flye|pec deck|push[\s-]?up|pushup|cable (cross|fly)/i,
  },
  {
    key: "squat",
    label: "Squat",
    standard: "a barbell back squat",
    pattern: "squat",
    base: [0.8, 1.15, 1.45, 1.8, 2.25],
    femaleFactor: 0.72,
    // a machine leg press / hack squat loads far heavier than a free back squat
    excludeRe: /leg press|hack squat|sissy|wall sit|leg extension/i,
  },
  {
    key: "deadlift",
    label: "Deadlift",
    standard: "a conventional / trap-bar deadlift",
    pattern: "hinge",
    base: [0.95, 1.35, 1.7, 2.1, 2.55],
    femaleFactor: 0.72,
    // RDL / good-morning / nordic / swings are lighter hinge ACCESSORIES, not the
    // conventional deadlift the standard measures
    excludeRe:
      /romanian|\brdl\b|stiff[\s-]?leg|good morning|nordic|glute[\s-]?ham|\bghr\b|back extension|hyperextension|kettlebell swing|kb swing|leg curl|hamstring curl/i,
  },
  {
    key: "press",
    label: "Overhead press",
    standard: "a standing barbell overhead press",
    pattern: "vertical-push",
    base: [0.4, 0.55, 0.7, 0.88, 1.1],
    femaleFactor: 0.6,
    excludeRe: /push[\s-]?up|pushup|pike/i,
  },
  {
    key: "row",
    label: "Row",
    standard: "a barbell / dumbbell row",
    pattern: "horizontal-pull",
    base: [0.5, 0.72, 0.95, 1.2, 1.55],
    femaleFactor: 0.65,
    excludeRe: /inverted|face pull|band/i,
  },
  {
    key: "pullup",
    label: "Pull-up",
    standard: "a bodyweight pull-up / chin-up",
    pattern: "vertical-pull",
    base: [0.95, 1.1, 1.3, 1.55, 1.9],
    femaleFactor: 0.72,
    bodyweightRelative: true,
  },
];

// Is a lift a genuine representative of this benchmark's STANDARD movement? Pull-ups
// must be real bodyweight pull/chin work (an ASSISTED pull-up is sub-bodyweight, so a
// percentile there would over-read); machine/accessory variations are excluded per
// the spec's excludeRe. Conservative: when unsure, don't benchmark.
function benchmarkEligible(spec: StrengthSpec, exerciseName: string): boolean {
  const n = String(exerciseName ?? "");
  if (spec.excludeRe?.test(n)) return false;
  if (spec.bodyweightRelative) {
    if (!/\b(pull[\s-]?up|chin[\s-]?up|pullup|chinup)\b/i.test(n)) return false;
    if (/assist/i.test(n)) return false; // assisted = below bodyweight; not the standard
  }
  return true;
}

function buildStrengthCurve(spec: StrengthSpec): ReferenceCurve {
  const bands: Record<Sex, Record<number, PercentilePoint[]>> = { male: {}, female: {} };
  for (const sex of ["male", "female"] as Sex[]) {
    const sf = sex === "female" ? spec.femaleFactor : 1;
    for (const decade of [20, 30, 40, 50, 60, 70]) {
      const af = AGE_STRENGTH_FACTOR[decade] ?? 1;
      bands[sex][decade] = STRENGTH_PCTS.map((p, i) => ({
        p,
        value: Math.round(spec.base[i] * sf * af * 1000) / 1000,
      }));
    }
  }
  return {
    key: spec.key,
    label: spec.label,
    unit: "× bodyweight",
    direction: "higher",
    source: "StrengthLevel / ExRx adult standards (sex- and age-adjusted)",
    bands,
  };
}

const STRENGTH_CURVES: Record<string, ReferenceCurve> = Object.fromEntries(
  STRENGTH_SPECS.map((s) => [s.key, buildStrengthCurve(s)])
);

// Standard strength-training level vocabulary from a population percentile. Plain
// words, the recognized coaching ladder — never a 0-100 score.
export type StrengthLevel = "beginner" | "novice" | "intermediate" | "advanced" | "elite";
function levelForPercentile(pct: number): StrengthLevel {
  return pct >= 80 ? "elite" : pct >= 60 ? "advanced" : pct >= 40 ? "intermediate" : pct >= 20 ? "novice" : "beginner";
}
function nextLevelThreshold(level: StrengthLevel): { next: StrengthLevel; pct: number } | null {
  switch (level) {
    case "beginner":
      return { next: "novice", pct: 20 };
    case "novice":
      return { next: "intermediate", pct: 40 };
    case "intermediate":
      return { next: "advanced", pct: 60 };
    case "advanced":
      return { next: "elite", pct: 80 };
    default:
      return null; // elite — no next rung
  }
}

// Interpolate the bodyweight-ratio at a given percentile for a curve/sex/decade —
// used to turn "you're 8 lb from advanced" into a concrete, motivating target.
function ratioAtPercentile(curve: ReferenceCurve, sex: Sex, age: number, pct: number): number | null {
  const decade = Math.max(20, Math.min(70, Math.floor((Number(age) || 40) / 10) * 10));
  const pts = curve.bands[sex][decade] ?? curve.bands[sex][40];
  if (!pts || !pts.length) return null;
  const sorted = [...pts].sort((a, b) => a.p - b.p);
  if (pct <= sorted[0].p) return sorted[0].value;
  for (let i = 1; i < sorted.length; i++) {
    if (pct <= sorted[i].p) {
      const a = sorted[i - 1],
        b = sorted[i];
      const t = (pct - a.p) / Math.max(1, b.p - a.p);
      return a.value + (b.value - a.value) * t;
    }
  }
  return sorted[sorted.length - 1].value;
}

// ---- types ------------------------------------------------------------------
export interface LiftCapacity {
  key: string;
  label: string; // standard movement label ("Bench press")
  exercise: string; // the athlete's actual lift that represents it
  est_1rm: number;
  ratio: number; // est-1RM ÷ bodyweight
  percentile: number; // for THEIR age + sex
  reference_percentile: number; // vs a 30-year-old (the "vs a 30-yo" read)
  level: StrengthLevel;
  tone: Tone; // strong / steady / watch
  equivalent_age: number;
  age_band: string; // "40s"
  to_next: { level: StrengthLevel; lb: number } | null; // concrete next-rung target
}

export interface Imbalance {
  title: string;
  why: string;
  severity: "note" | "watch";
}

export interface PerfTestDue {
  exercise: string;
  kind: "strength" | "core" | "grip" | "benchmark" | "endurance" | "test";
  why: string;
}

export interface PerfLever {
  headline: string;
  why: string;
  target?: string;
}

export interface PerfMomentumChip {
  kind: string;
  text: string;
  dir: "good" | "neutral";
}

export interface EnduranceCapacity {
  vo2max: number | null;
  percentile: number | null;
  reference_percentile: number | null;
  equivalent_age: number | null;
  age_band: string | null;
  tone: Tone;
  trend: string | null; // pace/mileage trajectory, plain words
  headline: string;
}

export interface PerformanceStanding {
  generated_for: string;
  discipline: string;
  sex: Sex;
  age: number | null;
  bodyweight_lb: number | null;
  hero: { headline: string; sub: string };
  capacities: LiftCapacity[];
  endurance: EnduranceCapacity | null;
  imbalances: Imbalance[];
  lever: PerfLever | null;
  tests_due: PerfTestDue[];
  variety: { note: string; suggestions: string[] } | null;
  momentum: { chips: PerfMomentumChip[] };
  balance_note: string;
}

// ---- bodyweight -------------------------------------------------------------
function currentBodyweight(profile: any): number | null {
  const fromProfile = Number(profile?.weight_lb);
  if (Number.isFinite(fromProfile) && fromProfile > 0) return fromProfile;
  try {
    const w = listWeight() as any[];
    const latest = (w || []).slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    const n = Number(latest?.weight_lb);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

// ---- per-pattern capacity benchmark -----------------------------------------
// For each benchmark movement, pick the athlete's heaviest representative lift in
// that pattern (max est-1RM naturally selects the main compound — a fly never
// out-1RMs a bench), compute its bodyweight ratio, and read it as a percentile for
// their age + sex. Pull-ups are only benchmarked when genuinely bodyweight-loaded
// (a machine pulldown's load isn't comparable to a bodyweight pull standard).
export function liftCapacities(
  lifts: LiftState[],
  bodyweight: number | null,
  sex: Sex,
  age: number | null
): LiftCapacity[] {
  if (!bodyweight || bodyweight <= 0) return [];
  const ageN = Number(age) || 40;
  // For each benchmark, pick the athlete's heaviest ELIGIBLE representative lift (max
  // est-1RM naturally selects the main compound — a fly never out-1RMs a bench). Only
  // a lift that genuinely maps to the standard's loading is considered (a leg press is
  // not a back squat; an RDL is not a deadlift; an assisted pull-up isn't a bodyweight
  // pull) — so the percentile is honest. The unbenchmarkable-but-trained patterns
  // become a "log a true X" prompt (see unbenchmarkedStandards), never a wrong number.
  const out: LiftCapacity[] = [];
  for (const spec of STRENGTH_SPECS) {
    let pick: { exercise: string; est_1rm: number } | null = null;
    for (const l of lifts) {
      if (l.mode === "timed" || l.est_1rm == null || l.est_1rm <= 0) continue;
      if (classifyPattern(l.exercise, l.muscle_group ?? undefined) !== spec.pattern) continue;
      if (!benchmarkEligible(spec, l.exercise)) continue;
      if (!pick || l.est_1rm > pick.est_1rm) pick = { exercise: l.exercise, est_1rm: l.est_1rm };
    }
    if (!pick) continue;
    const curve = STRENGTH_CURVES[spec.key];
    const ratio = pick.est_1rm / bodyweight;
    const c = compareCurve(curve, ratio, sex, ageN, REFERENCE_AGE);
    const level = levelForPercentile(c.percentile);
    // Concrete next-rung target: the est-1RM that would reach the next level's
    // percentile threshold for this age/sex. Plain "+X lb" — motivating, never a gate.
    let to_next: LiftCapacity["to_next"] = null;
    const nxt = nextLevelThreshold(level);
    if (nxt) {
      const targetRatio = ratioAtPercentile(curve, sex, ageN, nxt.pct);
      if (targetRatio != null) {
        const targetLb = targetRatio * bodyweight;
        const lb = Math.max(0, Math.round((targetLb - pick.est_1rm) / 5) * 5);
        if (lb > 0) to_next = { level: nxt.next, lb };
      }
    }
    out.push({
      key: spec.key,
      label: spec.label,
      exercise: pick.exercise,
      est_1rm: Math.round(pick.est_1rm),
      ratio: Math.round(ratio * 100) / 100,
      percentile: c.percentile,
      reference_percentile: c.reference_percentile,
      level,
      tone: bandForPercentile(c.percentile),
      equivalent_age: c.equivalent_age,
      age_band: c.actual_age_band,
      to_next,
    });
  }
  // Strongest first — the read leads with what's working, the laggards inform the lever.
  return out.sort((a, b) => b.percentile - a.percentile);
}

// Benchmark patterns the athlete TRAINS but only through a non-standard variation
// (leg press but no back squat, RDLs but no conventional deadlift, assisted pull-ups
// but no bodyweight pull) — so capacity can't be read honestly. Each becomes a gentle
// "log a true X to measure this" prompt (which doubles as the athlete's "test of
// strength" — re-measuring true capacity). Only patterns with NO eligible lift but at
// least one trained variation are returned.
export function unbenchmarkedStandards(
  lifts: LiftState[]
): Array<{ key: string; label: string; standard: string; via: string }> {
  const out: Array<{ key: string; label: string; standard: string; via: string }> = [];
  for (const spec of STRENGTH_SPECS) {
    let eligible = false;
    let proxy: string | null = null;
    for (const l of lifts) {
      if (l.mode === "timed" || l.est_1rm == null || l.est_1rm <= 0) continue;
      if (classifyPattern(l.exercise, l.muscle_group ?? undefined) !== spec.pattern) continue;
      if (benchmarkEligible(spec, l.exercise)) {
        eligible = true;
        break;
      }
      if (!proxy) proxy = l.exercise; // a trained-but-non-standard variation
    }
    if (!eligible && proxy) out.push({ key: spec.key, label: spec.label, standard: spec.standard, via: proxy });
  }
  return out;
}

// ---- imbalance detection ----------------------------------------------------
// Two reads: (1) the SPREAD across benchmarked patterns (one movement far ahead of
// another), and (2) named antagonist checks (press vs pull, lower vs upper) with the
// injury-relevant framing a coach would give. Conservative — only meaningful gaps.
export function strengthImbalances(caps: LiftCapacity[]): Imbalance[] {
  const out: Imbalance[] = [];
  if (caps.length < 2) return out;
  const byKey = new Map(caps.map((c) => [c.key, c]));
  const pct = (k: string) => byKey.get(k)?.percentile ?? null;

  // (1) Push vs pull (horizontal) — the classic shoulder-health imbalance.
  const push = pct("bench"),
    pull = pct("row");
  if (push != null && pull != null) {
    if (push - pull >= 25)
      out.push({
        title: "Pressing is ahead of pulling",
        why: `Your bench sits well above your row strength — bringing rows up balances the shoulder and protects the joint over the long run.`,
        severity: "watch",
      });
    else if (pull - push >= 25)
      out.push({
        title: "Pulling is ahead of pressing",
        why: `Your back is strong relative to your press — a touch more horizontal pressing volume will even it out.`,
        severity: "note",
      });
  }
  // (2) Lower vs upper body.
  const lowerVals = ["squat", "deadlift"].map(pct).filter((x): x is number => x != null);
  const upperVals = ["bench", "press", "row"].map(pct).filter((x): x is number => x != null);
  if (lowerVals.length && upperVals.length) {
    const lower = lowerVals.reduce((a, b) => a + b, 0) / lowerVals.length;
    const upper = upperVals.reduce((a, b) => a + b, 0) / upperVals.length;
    if (upper - lower >= 25)
      out.push({
        title: "Upper body is ahead of lower",
        why: `Your pressing and pulling outrank your squat and hinge — adding focused leg work is the fastest way to round out your base.`,
        severity: "note",
      });
    else if (lower - upper >= 25)
      out.push({
        title: "Lower body is ahead of upper",
        why: `Strong legs, lighter upper body — more pressing and pulling volume will balance you out.`,
        severity: "note",
      });
  }
  // (3) The single widest spread, when it isn't already named above.
  const strongest = caps[0],
    weakest = caps[caps.length - 1];
  if (strongest && weakest && strongest.percentile - weakest.percentile >= 35 && out.length < 2) {
    out.push({
      title: `${strongest.label} far ahead of ${weakest.label.toLowerCase()}`,
      why: `${strongest.label} reads ${strongest.level} while ${weakest.label.toLowerCase()} is ${weakest.level} — focused work on the laggard is where the easy progress is.`,
      severity: "note",
    });
  }
  return out.slice(0, 3);
}

// ---- re-test prompts --------------------------------------------------------
// A benchmark lift's percentile is only as fresh as the last time it was genuinely
// TESTED (a heavy, low-rep top set). If a lift hasn't seen ≤5-rep work in ~6 weeks,
// a coach re-tests it to re-anchor where you are. Also a periodic CORE hold test and
// a GRIP (dead-hang) test when those are programmed but stale. Conservative + pull.
const TEST_STALE_DAYS = 42;

function daysBetween(fromISO: string, refISO: string): number | null {
  const a = Date.parse(String(fromISO) + "T00:00:00Z");
  const b = Date.parse(String(refISO) + "T00:00:00Z");
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 864e5) : null;
}

function lastHeavyTestDays(exerciseName: string, refISO: string): number | null {
  const ex = findExercise(exerciseName);
  if (!ex) return null;
  const row = db
    .prepare(
      `SELECT MAX(s.date) AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND s.date <= ? AND ls.reps IS NOT NULL AND ls.reps <= 5 AND ls.weight IS NOT NULL AND ls.weight > 0`
    )
    .get(ex.id, refISO) as any;
  if (!row?.d) return null;
  return daysBetween(String(row.d), refISO);
}

function lastTimedTestDays(exerciseName: string, refISO: string): number | null {
  const ex = findExercise(exerciseName);
  if (!ex) return null;
  const row = db
    .prepare(
      `SELECT MAX(s.date) AS d FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
      WHERE ls.exercise_id = ? AND s.date <= ? AND ls.duration_sec IS NOT NULL`
    )
    .get(ex.id, refISO) as any;
  if (!row?.d) return null;
  return daysBetween(String(row.d), refISO);
}

export function testsDue(caps: LiftCapacity[], lifts: LiftState[], refISO: string): PerfTestDue[] {
  const out: PerfTestDue[] = [];
  // Strength: the 1-2 benchmark lifts whose heavy max is stalest (and have real
  // history) — never a wall of "go test everything".
  const candidates = caps
    .map((c) => ({ c, days: lastHeavyTestDays(c.exercise, refISO) }))
    .filter((x) => x.days == null || x.days > TEST_STALE_DAYS)
    // a lift with SOME history but no recent heavy work is the strongest re-test case
    .sort((a, b) => (b.days ?? 9999) - (a.days ?? 9999))
    .slice(0, 2);
  for (const { c, days } of candidates) {
    const lift = lifts.find((l) => l.exercise.toLowerCase() === c.exercise.toLowerCase());
    if (!lift || lift.sessions < 3) continue; // don't re-test a barely-logged lift
    out.push({
      exercise: c.exercise,
      kind: "strength",
      why:
        days == null
          ? `You've been working ${c.exercise} in higher reps — a heavy triple or single would re-anchor where your strength actually sits.`
          : `It's been ~${Math.round(days / 7)} weeks since you tested ${c.exercise} near a true max — a heavy triple re-reads your real ceiling.`,
    });
  }
  // Core + grip holds: a programmed timed lift that hasn't been pushed to a max in a
  // while. One of each at most.
  const timed = lifts.filter((l) => l.mode === "timed");
  for (const tag of [
    { kind: "core" as const, re: /plank|hollow|l[\s-]?sit|dead\s?bug|ab\s?wheel/i },
    { kind: "grip" as const, re: /dead[\s-]?hang|\bhang\b|farmer|carry|grip/i },
  ]) {
    const lift = timed.find((l) => tag.re.test(l.exercise));
    if (!lift) continue;
    const days = lastTimedTestDays(lift.exercise, refISO);
    if (days != null && days <= TEST_STALE_DAYS) continue;
    out.push({
      exercise: lift.exercise,
      kind: tag.kind,
      why:
        tag.kind === "core"
          ? `A max ${lift.exercise} hold is a quick, honest test of trunk endurance — worth re-checking every month or so.`
          : `A max ${lift.exercise} is a clean grip-strength test (and grip tracks with everything from pulls to longevity) — re-check it now and then.`,
    });
  }
  return out.slice(0, 3);
}

// ---- variety / anti-repetition ----------------------------------------------
// "Not just the same exercises every week." Flag the benchmark pattern trained with
// the SAME single movement across many sessions over a long span — a gentle nudge to
// rotate a variation for balanced development and a fresh stimulus. ONE, conservative.
const VARIETY_WINDOW_DAYS = 56;
const VARIETY_MIN_SESSIONS = 6;

export function varietyRead(date: string): { note: string; suggestions: string[] } | null {
  const since = new Date(new Date(date + "T00:00:00Z").getTime() - VARIETY_WINDOW_DAYS * 864e5)
    .toISOString()
    .slice(0, 10);
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT e.name AS name, e.muscle_group AS mg, COUNT(DISTINCT s.date) AS sessions
         FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
         JOIN sessions s ON s.id = ls.session_id
        WHERE s.date >= ? AND s.date <= ? AND COALESCE(e.mode,'reps') != 'timed'
        GROUP BY e.id`
      )
      .all(since, date) as any[];
  } catch {
    return null;
  }
  // Tally sessions + distinct exercises per movement pattern.
  const byPat = new Map<
    MovementPattern,
    { sessions: number; names: Set<string>; topName: string; topSessions: number }
  >();
  for (const r of rows) {
    const pat = classifyPattern(r.name, r.mg ?? undefined);
    if (!pat) continue;
    const sess = Number(r.sessions) || 0;
    const cur = byPat.get(pat) ?? { sessions: 0, names: new Set<string>(), topName: r.name, topSessions: 0 };
    cur.sessions += sess;
    cur.names.add(r.name);
    if (sess > cur.topSessions) {
      cur.topSessions = sess;
      cur.topName = r.name;
    }
    byPat.set(pat, cur);
  }
  // The most-trained pattern that's been a SINGLE movement the whole window.
  let worst: { pat: MovementPattern; name: string; sessions: number } | null = null;
  for (const [pat, v] of byPat) {
    if (v.names.size === 1 && v.sessions >= VARIETY_MIN_SESSIONS) {
      if (!worst || v.sessions > worst.sessions) worst = { pat, name: v.topName, sessions: v.sessions };
    }
  }
  if (!worst) return null;
  const alts = suggestVariations(worst.name, { limit: 3 }).map((v) => v.name);
  return {
    note: `You've run ${worst.name} as your only ${worst.pat.replace(/-/g, " ")} for ${Math.round(worst.sessions)} sessions — rotating a close variation now and then builds the pattern more completely and gives a fresh stimulus.`,
    suggestions: alts,
  };
}

// ---- endurance capacity -----------------------------------------------------
function enduranceCapacity(
  programState: ProgramState,
  recovery: any,
  sex: Sex,
  age: number | null
): EnduranceCapacity | null {
  const disc = programState.discipline;
  if (disc !== "endurance" && disc !== "hybrid") return null;
  const vo2raw = Number(recovery?.vo2max);
  const vo2 = Number.isFinite(vo2raw) && vo2raw >= 10 && vo2raw <= 100 ? vo2raw : null;
  const end = programState.endurance;
  const trend = end?.why ?? null;
  if (vo2 == null) {
    return {
      vo2max: null,
      percentile: null,
      reference_percentile: null,
      equivalent_age: null,
      age_band: null,
      tone: "missing",
      trend,
      headline: "No VO2max reading yet — a Garmin run estimates it.",
    };
  }
  const c = compareCurve(VO2_CURVE, vo2, sex, Number(age) || 40, REFERENCE_AGE);
  const tone = bandForPercentile(c.percentile);
  const headline =
    tone === "strong"
      ? `VO2max ${Math.round(vo2)} — strong for your ${c.actual_age_band} (around a ${c.equivalent_age}-year-old's aerobic engine).`
      : tone === "steady"
        ? `VO2max ${Math.round(vo2)} — solid for your ${c.actual_age_band}, with clear room to lift it.`
        : `VO2max ${Math.round(vo2)} — the biggest single longevity lever you have; one quality session a week moves it.`;
  return {
    vo2max: Math.round(vo2),
    percentile: c.percentile,
    reference_percentile: c.reference_percentile,
    equivalent_age: c.equivalent_age,
    age_band: c.actual_age_band,
    tone,
    trend,
    headline,
  };
}

// ---- the lever: the single highest-leverage focus ---------------------------
function performanceLever(
  caps: LiftCapacity[],
  imbalances: Imbalance[],
  balance: ProgramBalance,
  endurance: EnduranceCapacity | null,
  dexa?: DexaTargeting | null
): PerfLever | null {
  // If endurance is clearly the weakest link AND it's a discipline that matters,
  // VO2max work is usually the biggest longevity+performance lever.
  const weakest = caps[caps.length - 1];
  // A strong DEXA signal — an informational low-BMD region, or low-ALMI lean —
  // outranks an ordinary strength laggard: it's the more consequential focus and a
  // recognized reference read (never a score). Bone/visceral stay clinician-framed.
  const dexaLead = dexa?.available ? dexa.lead : null;
  if (dexaLead && dexaLead.domain === "training" && (dexaLead.informational || dexaLead.area === "lean mass")) {
    return {
      headline: `From your DEXA — ${dexaLead.bias}`,
      why: dexaLead.signal,
      target: dexaLead.path,
    };
  }
  // A named, injury-relevant imbalance is the most coach-like lever when present.
  const watch = imbalances.find((i) => i.severity === "watch");
  if (watch) {
    return { headline: watch.title, why: watch.why };
  }
  // Else the lowest-capacity benchmark lift — concrete and motivating.
  if (weakest && weakest.percentile < 50) {
    const target = weakest.to_next
      ? `about +${weakest.to_next.lb} lb on ${weakest.exercise} reaches ${weakest.to_next.level}`
      : undefined;
    return {
      headline: `Bring up your ${weakest.label.toLowerCase()}`,
      why: `It's your furthest-behind lift (${weakest.level} for your age) — focused volume here is where the easiest, most motivating progress is.`,
      target,
    };
  }
  if (endurance && endurance.tone === "watch") {
    return {
      headline: "Lift your aerobic base",
      why: "VO2max is the lift with the most carryover to both performance and longevity — one weekly tempo or interval session moves it.",
    };
  }
  // Everything benchmarked is at least steady — point at the most-due group as a
  // rounding-out move, or simply affirm.
  const due = balance.due?.[0];
  if (due)
    return {
      headline: `Round out ${due}`,
      why: `Your benchmarks are all at least solid for your age — ${due} is the group that's lightest right now, so it's the cleanest place to add.`,
    };
  return null;
}

// ---- momentum: the motivational hook ----------------------------------------
function performanceMomentum(
  programState: ProgramState,
  caps: LiftCapacity[],
  endurance: EnduranceCapacity | null
): PerfMomentumChip[] {
  const chips: PerfMomentumChip[] = [];
  const climbing = (programState.lifts || []).filter((l) => l.status === "progressing");
  if (climbing.length)
    chips.push({
      kind: "climbing",
      text: `${climbing.length} lift${climbing.length === 1 ? "" : "s"} climbing`,
      dir: "good",
    });
  const strong = caps.filter((c) => c.tone === "strong");
  if (strong.length)
    chips.push({
      kind: "strength",
      text: `${strong[0].label} ${strong[0].level} for your ${strong[0].age_band}`,
      dir: "good",
    });
  if (endurance && endurance.tone === "strong")
    chips.push({ kind: "vo2", text: `aerobic engine strong for your ${endurance.age_band}`, dir: "good" });
  if (endurance?.trend && /improv/i.test(endurance.trend))
    chips.push({ kind: "pace", text: "easy pace getting quicker", dir: "good" });
  return chips.slice(0, 4);
}

// ---- holistic balance note --------------------------------------------------
// One calm, human line: are load and recovery in balance, and a reminder that the
// life around training is part of the picture (never a nag).
function balanceNote(recovery: any, programState: ProgramState): string {
  const drift = recovery?.delta ?? null;
  const recoveringDown = (drift?.hrv != null && drift.hrv < 0) || (drift?.rhr != null && drift.rhr > 2);
  if (recoveringDown || programState.mesocycle?.phase === "deload-due") {
    return "Your body's asking for a lighter touch right now — an easy week or a real rest day is the strong, performance-building choice, not a step back. Train hard, recover honestly, and keep room for the rest of your life.";
  }
  return "Load and recovery look well balanced — keep training with intent, and don't begrudge the easy days, the family time, or the occasional night off. Consistency over a long life beats any single hard week.";
}

// ---- the aggregate ----------------------------------------------------------
export function performanceStanding(
  date?: string,
  opts?: { programState?: ProgramState; recovery?: any; balance?: ProgramBalance }
): PerformanceStanding {
  const d = date || localDateISO();
  const profile = getProfile();
  const sex = sexOf(profile);
  const age = profile?.age != null ? Number(profile.age) : null;
  const bodyweight = currentBodyweight(profile);
  const recovery =
    opts?.recovery ??
    (() => {
      try {
        return getRecoverySummary(14);
      } catch {
        return null;
      }
    })();
  const programState = opts?.programState ?? getProgramState(d, recovery);
  const balance = opts?.balance ?? programBalance();

  const lifts = programState.lifts || [];
  const capacities = liftCapacities(lifts, bodyweight, sex, age);
  const endurance = enduranceCapacity(programState, recovery, sex, age);
  const imbalances = strengthImbalances(capacities);
  // A strong DEXA signal (low BMD, low-ALMI lean) can be the highest-leverage focus
  // — let the lever consider it. Null-safe; falls back to the strength laggard.
  const dexa = (() => { try { return dexaTargeting({ profile }); } catch { return null; } })();
  const lever = performanceLever(capacities, imbalances, balance, endurance, dexa);
  const tests_due = testsDue(capacities, lifts, d);
  // Add "log a true X" benchmark prompts for patterns trained only through a
  // non-standard variation (so capacity can't be read honestly) — capped so they
  // never crowd out the re-test prompts. Doubles as a "test of strength" suggestion.
  for (const u of unbenchmarkedStandards(lifts).slice(0, 2)) {
    if (tests_due.length >= 5) break;
    tests_due.push({
      exercise: u.standard,
      kind: "benchmark",
      why: `You train ${u.label.toLowerCase()} as ${u.via}, but that can't be benchmarked against the strength standards — logging ${u.standard} now and then would let Cairn read where your ${u.label.toLowerCase()} truly stands.`,
    });
  }
  // Running re-tests (no hard effort in ~4 weeks → a time-trial; a stale VO2max
  // reading → a max-effort run) — shaped to drop straight in (open kind enum).
  try {
    for (const t of enduranceTestsDue(d)) {
      if (tests_due.length >= 6) break;
      tests_due.push(t);
    }
  } catch { /* endurance tests unavailable → skip */ }
  const variety = varietyRead(d);
  const momentum = { chips: performanceMomentum(programState, capacities, endurance) };
  const balance_note = balanceNote(recovery, programState);

  // Hero — the one-line "where you are", strongest-lift-led, honest about the lever.
  const hero = buildHero(capacities, endurance, lever);

  return {
    generated_for: d,
    discipline: programState.discipline,
    sex,
    age,
    bodyweight_lb: bodyweight,
    hero,
    capacities,
    endurance,
    imbalances,
    lever,
    tests_due,
    variety,
    momentum,
    balance_note,
  };
}

function buildHero(
  caps: LiftCapacity[],
  endurance: EnduranceCapacity | null,
  lever: PerfLever | null
): { headline: string; sub: string } {
  if (!caps.length && !endurance) {
    return {
      headline: "Your performance read is warming up",
      sub: "Log a few sessions with real working sets and Cairn will benchmark where you stand for your age.",
    };
  }
  // The modal level across benchmarked lifts → a plain "you're at X overall".
  const order: StrengthLevel[] = ["beginner", "novice", "intermediate", "advanced", "elite"];
  let headline = "";
  if (caps.length) {
    const counts = new Map<StrengthLevel, number>();
    for (const c of caps) counts.set(c.level, (counts.get(c.level) ?? 0) + 1);
    const modal = [...counts.entries()].sort((a, b) => b[1] - a[1] || order.indexOf(b[0]) - order.indexOf(a[0]))[0][0];
    const strongest = caps[0];
    headline = `You're ${article(modal)} ${modal} lifter overall — ${strongest.label.toLowerCase()} leads (${strongest.level} for your ${strongest.age_band})`;
  } else if (endurance) {
    headline = endurance.headline;
  }
  const sub = lever
    ? `The lever right now: ${lever.headline.toLowerCase()}.`
    : "Everything's tracking well for your age — keep the consistency.";
  return { headline, sub };
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}
