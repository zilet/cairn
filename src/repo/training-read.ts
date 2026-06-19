// The deterministic "understand what was actually logged" layer — coach-level
// reading of a session WITHOUT an agent, used by the Brief (day-read) and by the
// Lately/history surfaces. Two questions it answers, both purely from the logged
// sets:
//   1. WHAT was it? — a content-true title (so an off-plan session whose plan-day
//      name is stale, e.g. "Full Body" for what was really mobility/core, reads
//      honestly), and
//   2. HOW HARD was it? — a training-load grade (hard / moderate / easy), so a
//      light recovery session isn't counted as a stacked hard day toward "you've
//      earned rest". A genuine recovery day should BREAK the hard-day streak.
// Leaf module: imports only `db`, so it can be used by both sessions/activities
// and intelligence (which import each other) without a cycle.
import { db } from "../db.js";

export type MovementBucket = "push" | "pull" | "lower" | "core" | "mobility" | "other";
export type TrainingLoad = "hard" | "moderate" | "easy";

// muscle_group → coarse bucket (the explicit signal when an exercise has one).
const MG_BUCKET: Record<string, MovementBucket> = {
  chest: "push", shoulders: "push", triceps: "push", delts: "push", "front delts": "push",
  back: "pull", lats: "pull", biceps: "pull", "rear delts": "pull", traps: "pull", forearms: "pull",
  legs: "lower", quads: "lower", hamstrings: "lower", glutes: "lower", calves: "lower",
  posterior: "lower", hips: "lower", adductors: "lower",
  core: "core", abs: "core", obliques: "core",
};

// Fallback classification from the exercise NAME, for the (common) case where
// muscle_group is null. Order matters — mobility/core are checked before the
// strength patterns so "Side Plank" reads as core, not a stray match.
function nameBucket(name: string): MovementBucket {
  const n = name.toLowerCase();
  if (/(90\s*\/\s*90|hip switch|hip opener|mobility|stretch|cat[\s-]?cow|cossack|world'?s greatest|t[\s-]?spine|thoracic|\bhalo\b|\bcars\b|opener|ankle rock|adductor rock|hip flow|wrist prep)/.test(n)) return "mobility";
  if (/(plank|dead\s*bug|hollow|bird\s*dog|pallof|crunch|sit[\s-]?up|leg raise|rollout|ab wheel|l[\s-]?sit|oblique|woodchop|carry|farmer)/.test(n)) return "core";
  if (/(squat|deadlift|lunge|hinge|\brdl\b|leg press|leg curl|leg extension|hip thrust|glute|step[\s-]?up|calf|split squat|bulgarian|nordic|good\s*morning)/.test(n)) return "lower";
  if (/(bench|overhead press|\bohp\b|push[\s-]?up|\bdip\b|\bfly\b|lateral raise|press|tricep|pushdown|skullcrusher|jm press)/.test(n)) return "push";
  if (/(\brow\b|pull[\s-]?up|pulldown|chin[\s-]?up|curl|face pull|\blat\b|shrug|pull[\s-]?over|rear delt)/.test(n)) return "pull";
  return "other";
}

export function movementBucket(name: string, muscleGroup?: string | null): MovementBucket {
  const mg = (muscleGroup || "").toLowerCase().trim();
  if (mg && MG_BUCKET[mg]) return MG_BUCKET[mg];
  return nameBucket(name);
}

// A session's character from its bucket counts → a calm, plain title. Recovery
// character (core/mobility) wins when it's at least half the work, so a light
// quality session reads as "Mobility & Core", never as the strength split it was
// nominally filed under. null when there's nothing classifiable.
export function contentTitle(buckets: Partial<Record<MovementBucket, number>>): string | null {
  const core = buckets.core || 0, mobility = buckets.mobility || 0;
  const push = buckets.push || 0, pull = buckets.pull || 0, lower = buckets.lower || 0;
  const soft = core + mobility;
  const hard = push + pull + lower;
  if (soft === 0 && hard === 0) return null;
  if (soft > 0 && soft >= hard) {
    if (mobility > 0 && core > 0) return "Mobility & Core";
    if (core > 0) return "Core";
    return "Mobility";
  }
  const upper = push > 0 || pull > 0;
  if (upper && lower) return "Full Body";
  if (push > 0 && pull > 0) return "Upper body";
  if (push > 0) return "Push";
  if (pull > 0) return "Pull";
  if (lower > 0) return "Lower body";
  return null;
}

function bucketCounts(rows: { name: string; mg?: string | null }[]): Partial<Record<MovementBucket, number>> {
  const buckets: Partial<Record<MovementBucket, number>> = {};
  for (const r of rows) {
    const b = movementBucket(r.name, r.mg);
    buckets[b] = (buckets[b] || 0) + 1;
  }
  return buckets;
}

// The content character a plan day prescribes (from its planned movements), so a
// logged session can be compared to it WITHOUT exact name matching. null when the
// day has no classifiable strength items (e.g. a pure cardio day).
function planDayContentTitle(planDayId: number): string | null {
  const rows = db.prepare(
    `SELECT e.name AS name, e.muscle_group AS mg FROM plan_items pi
       JOIN exercises e ON e.id = pi.exercise_id WHERE pi.plan_day_id = ?`
  ).all(planDayId) as any[];
  if (!rows.length) return null;
  return contentTitle(bucketCounts(rows));
}

// The display title for a logged session. Keeps the linked plan-day name while
// the logged work still IS that day — either at least half its prescribed
// movements are present (a substitution or two is fine), OR the logged work is
// the same CHARACTER as the day prescribes (so logging "RDL" where the plan says
// "Romanian Deadlift" doesn't falsely rename a Lower day). Once the content has
// genuinely diverged (you swapped the whole thing out, as an off-plan
// session-suggest does), it names the session from what was actually trained.
// Falls back to the plan name, then "Session". Deterministic + null-safe.
export function deriveSessionTitle(
  sessionId: number,
  planDayId?: number | null,
  planDayName?: string | null
): string {
  const rows = db.prepare(
    `SELECT DISTINCT e.name AS name, e.muscle_group AS mg
       FROM logged_sets l JOIN exercises e ON e.id = l.exercise_id
      WHERE l.session_id = ?`
  ).all(sessionId) as any[];
  if (!rows.length) return planDayName || "Session";

  const loggedTitle = contentTitle(bucketCounts(rows));

  if (planDayId && planDayName) {
    const planned = new Set(
      (db.prepare(
        `SELECT e.name AS name FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id WHERE pi.plan_day_id = ?`
      ).all(planDayId) as any[]).map((r) => String(r.name).toLowerCase())
    );
    if (planned.size) {
      const hits = rows.filter((r) => planned.has(String(r.name).toLowerCase())).length;
      if (hits / rows.length >= 0.5) return planDayName; // still that day (by name)
    }
    // Same character as the day prescribes → still that day (robust to renames).
    if (loggedTitle && loggedTitle === planDayContentTitle(planDayId)) return planDayName;
  }

  return loggedTitle || planDayName || "Session";
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// How hard was this STRENGTH session? Read tonnage + how close to failure the
// working sets were taken (RIR). A mobility/recovery session — no real external
// load and easy effort — grades 'easy' and therefore does NOT extend an
// earned-rest streak. A genuinely hard bodyweight/calisthenics session (several
// near-failure sets) still grades up despite zero tonnage. Null-safe → 'easy'
// when there's nothing logged.
export function sessionLoad(sessionId: number): TrainingLoad {
  const sets = db.prepare(
    `SELECT weight, reps, duration_sec, rir FROM logged_sets WHERE session_id = ?`
  ).all(sessionId) as any[];
  if (!sets.length) return "easy";
  const tonnage = sets.reduce(
    (t, s) => t + (Number(s.weight) > 0 && Number(s.reps) > 0 ? Number(s.weight) * Number(s.reps) : 0),
    0
  );
  const rirs = sets.map((s) => s.rir).filter((r) => r != null).map(Number);
  const medRir = median(rirs);
  const nearFailure = sets.filter((s) => s.rir != null && Number(s.rir) <= 3).length;
  const hardLoadedSets = sets.filter(
    (s) => s.rir != null && Number(s.rir) <= 3 && Number(s.weight) > 0 && Number(s.reps) > 0
  ).length;

  // Recovery/mobility: no meaningful load and nothing taken near failure.
  if (tonnage < 1000 && nearFailure === 0 && (medRir == null || medRir >= 6)) return "easy";
  // Hard: real volume taken near failure, OR a hard calisthenics session.
  if (tonnage >= 6000 && hardLoadedSets >= 3) return "hard";
  if (nearFailure >= 4 && sets.length >= 6) return "hard";
  if (tonnage >= 3000 || nearFailure >= 3) return "moderate";
  return "easy";
}

const LOAD_RANK: Record<TrainingLoad, number> = { easy: 1, moderate: 2, hard: 3 };

// One cardio effort's load, by duration/distance. Walks/hikes are easy unless
// genuinely long; runs/rides/swims grade by how much was covered. null when
// there's no duration AND no distance to judge.
export function cardioEffort(a: { type?: string | null; duration_min?: number | null; distance_km?: number | null }): TrainingLoad | null {
  const type = String(a.type || "").toLowerCase();
  const dur = a.duration_min != null ? Number(a.duration_min) : null;
  const dist = a.distance_km != null ? Number(a.distance_km) : null;
  if (dur == null && dist == null) return null;
  if (/walk|hike/.test(type)) {
    return (dur != null && dur >= 90) || (dist != null && dist >= 8) ? "moderate" : "easy";
  }
  if ((dur != null && dur >= 50) || (dist != null && dist >= 9)) return "hard";
  if ((dur != null && dur >= 25) || (dist != null && dist >= 4)) return "moderate";
  return "easy";
}

// The day's overall training load — the harder of its strength session(s) and
// (for an endurance/hybrid athlete) its cardio. 'none' when nothing was logged.
// This is what makes the earned-rest count intensity-aware: only 'hard'/'moderate'
// days are "loading" days that stack toward a rest read.
export function dayLoad(date: string, opts: { countsCardio: boolean }): TrainingLoad | "none" {
  let best: TrainingLoad | null = null;
  const bump = (l: TrainingLoad | null) => {
    if (l && (!best || LOAD_RANK[l] > LOAD_RANK[best])) best = l;
  };
  for (const r of db.prepare(
    `SELECT DISTINCT s.id AS id FROM sessions s JOIN logged_sets l ON l.session_id = s.id WHERE s.date = ?`
  ).all(date) as any[]) {
    bump(sessionLoad(r.id));
  }
  if (opts.countsCardio) {
    for (const a of db.prepare(
      `SELECT type, duration_min, distance_km FROM activities WHERE date = ?`
    ).all(date) as any[]) {
      bump(cardioEffort(a));
    }
  }
  return best ?? "none";
}

export function isLoadingDay(date: string, opts: { countsCardio: boolean }): boolean {
  const l = dayLoad(date, opts);
  return l === "hard" || l === "moderate";
}
