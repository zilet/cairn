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
// Leaf module: imports only `db` and the runtime-free load thresholds, so it can be
// used by both sessions/activities and intelligence (which import each other) without
// a cycle.
import { db } from "../db.js";
import { canonicalEnduranceSport } from "./endurance-sports.js";
import { normalizeExerciseName, normalizedExerciseKey } from "./exercise-canon.js";
import { CARDIO_GRADE } from "./heavy-load.js";
import { activeRecoveryWeekLedger } from "./recovery-week-ledger.js";

export type MovementBucket = "push" | "pull" | "lower" | "core" | "mobility" | "other";
export type TrainingLoad = "hard" | "moderate" | "easy";

// muscle_group → coarse bucket (the explicit signal when an exercise has one).
const MG_BUCKET: Record<string, MovementBucket> = {
  chest: "push",
  shoulders: "push",
  triceps: "push",
  delts: "push",
  "front delts": "push",
  back: "pull",
  lats: "pull",
  biceps: "pull",
  "rear delts": "pull",
  traps: "pull",
  forearms: "pull",
  legs: "lower",
  quads: "lower",
  hamstrings: "lower",
  glutes: "lower",
  calves: "lower",
  posterior: "lower",
  hips: "lower",
  adductors: "lower",
  core: "core",
  abs: "core",
  obliques: "core",
};

// Fallback classification from the exercise NAME, for the (common) case where
// muscle_group is null. Order matters — mobility/core are checked before the
// strength patterns so "Side Plank" reads as core, not a stray match.
function nameBucket(name: string): MovementBucket {
  const n = name.toLowerCase();
  if (
    /(90\s*\/\s*90|hip switch|hip opener|mobility|stretch|cat[\s-]?cow|cossack|world'?s greatest|t[\s-]?spine|thoracic|\bhalo\b|\bcars\b|opener|ankle rock|adductor rock|hip flow|wrist prep)/.test(
      n
    )
  )
    return "mobility";
  if (
    /(plank|dead\s*bug|hollow|bird\s*dog|pallof|crunch|sit[\s-]?up|leg raise|rollout|ab wheel|l[\s-]?sit|oblique|woodchop|carry|farmer)/.test(
      n
    )
  )
    return "core";
  if (
    /(squat|deadlift|lunge|hinge|\brdl\b|leg press|leg curl|leg extension|hip thrust|glute|step[\s-]?up|calf|split squat|bulgarian|nordic|good\s*morning)/.test(
      n
    )
  )
    return "lower";
  if (
    /(bench|overhead press|\bohp\b|push[\s-]?up|\bdip\b|\bfly\b|lateral raise|press|tricep|pushdown|skullcrusher|jm press)/.test(
      n
    )
  )
    return "push";
  if (/(\brow\b|pull[\s-]?up|pulldown|chin[\s-]?up|curl|face pull|\blat\b|shrug|pull[\s-]?over|rear delt)/.test(n))
    return "pull";
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
  const core = buckets.core || 0,
    mobility = buckets.mobility || 0;
  const push = buckets.push || 0,
    pull = buckets.pull || 0,
    lower = buckets.lower || 0;
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
  const rows = db
    .prepare(
      `SELECT e.name AS name, e.muscle_group AS mg FROM plan_items pi
       JOIN exercises e ON e.id = pi.exercise_id WHERE pi.plan_day_id = ?`
    )
    .all(planDayId) as any[];
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
export function deriveSessionTitle(sessionId: number, planDayId?: number | null, planDayName?: string | null): string {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.name AS name, e.muscle_group AS mg
       FROM logged_sets l JOIN exercises e ON e.id = l.exercise_id
      WHERE l.session_id = ?`
    )
    .all(sessionId) as any[];
  if (!rows.length) return planDayName || "Session";

  const loggedTitle = contentTitle(bucketCounts(rows));

  if (planDayId && planDayName) {
    const planned = new Set(
      (
        db
          .prepare(
            `SELECT e.name AS name FROM plan_items pi JOIN exercises e ON e.id = pi.exercise_id WHERE pi.plan_day_id = ?`
          )
          .all(planDayId) as any[]
      ).map((r) => String(r.name).toLowerCase())
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

export type RecoveryDoseClassification = "compliant" | "above-plan" | "overdose" | "unknown";

export interface RecoverySessionDose {
  session_id: number;
  plan_day_id: number | null;
  planned_working_sets: number | null;
  raw_logged_sets: number;
  canonical_working_sets: number;
  duplicate_alias_sets: number;
  volume_ratio: number | null;
  median_rir: number | null;
  near_failure_sets: number;
  max_target_load_ratio: number | null;
  classification: RecoveryDoseClassification;
  reason: string;
}

interface DoseSet {
  id: number;
  exercise_id: number;
  exercise: string;
  raw_key: string;
  canonical_key: string;
  alias_canonical_key: string | null;
  set_number: number;
  weight: number | null;
  reps: number | null;
  rir: number | null;
  duration_sec: number | null;
  note: string | null;
}

function doseExerciseIdentity(name: string): {
  rawKey: string;
  canonicalKey: string;
  aliasCanonicalKey: string | null;
} {
  const norm = normalizeExerciseName(name);
  const alias = norm ? (db.prepare(`SELECT canonical FROM exercise_aliases WHERE alias = ?`).get(norm) as any) : null;
  const aliasCanonicalKey = alias?.canonical ? normalizedExerciseKey(String(alias.canonical)) : null;
  return {
    rawKey: normalizedExerciseKey(name) || norm,
    canonicalKey: aliasCanonicalKey || normalizedExerciseKey(name) || norm,
    aliasCanonicalKey,
  };
}

function doseExerciseKey(name: string): string {
  return doseExerciseIdentity(name).canonicalKey;
}

function doseSignature(set: DoseSet): string {
  // The signature is only a candidate. canonicalDoseSets also requires explicit
  // Garmin import provenance plus a direct persisted alias→canonical pair before
  // collapsing cross-name rows. Identical sets on the SAME stored exercise stay.
  return [set.canonical_key, set.set_number, set.weight ?? "", set.reps ?? "", set.duration_sec ?? ""].join("|");
}

function hasProviderImportProvenance(garminJson: unknown): boolean {
  try {
    const parsed = typeof garminJson === "string" ? JSON.parse(garminJson) : garminJson;
    return !!(
      parsed &&
      typeof parsed === "object" &&
      (parsed.cairn_sets_authoritative === false ||
        (Array.isArray(parsed.imported_set_activity_ids) && parsed.imported_set_activity_ids.length > 0))
    );
  } catch {
    return false;
  }
}

function canonicalProviderPair(a: DoseSet, b: DoseSet): boolean {
  return (
    (a.alias_canonical_key != null && a.alias_canonical_key === b.raw_key) ||
    (b.alias_canonical_key != null && b.alias_canonical_key === a.raw_key)
  );
}

function canonicalDoseSets(rows: DoseSet[], providerImport: boolean): { sets: DoseSet[]; duplicates: number } {
  const kept: DoseSet[] = [];
  const seen = new Map<string, DoseSet>();
  let duplicates = 0;
  for (const row of rows) {
    const signature = doseSignature(row);
    const prior = seen.get(signature);
    if (prior != null && prior.exercise_id !== row.exercise_id && providerImport && canonicalProviderPair(prior, row)) {
      duplicates++;
      continue;
    }
    if (prior == null) seen.set(signature, row);
    kept.push(row);
  }
  return { sets: kept, duplicates };
}

function workingDoseSets(rows: DoseSet[]): DoseSet[] {
  const topByExercise = new Map<string, number>();
  for (const row of rows) {
    const weight = Number(row.weight) || 0;
    if (weight > (topByExercise.get(row.canonical_key) ?? 0)) topByExercise.set(row.canonical_key, weight);
  }
  return rows.filter((row) => {
    if (/\bwarm[ -]?up\b/i.test(String(row.note ?? ""))) return false;
    const weight = Number(row.weight) || 0;
    const top = topByExercise.get(row.canonical_key) ?? 0;
    return !(top > 0 && weight > 0 && weight < top * 0.55);
  });
}

// Read a strength session against the deliberately reduced plan it was linked to.
// This does not mutate or delete noisy source rows. It creates a conservative,
// canonical decision view for recovery-week coaching only; global historical
// tonnage/volume metrics retain their existing semantics.
export function recoverySessionDose(sessionId: number): RecoverySessionDose {
  const session = db
    .prepare(
      `SELECT s.id, s.date, s.created_at, s.plan_day_id, s.soreness, s.performance,
              s.joint_pain, s.garmin_json, pd.day_number
         FROM sessions s LEFT JOIN plan_days pd ON pd.id = s.plan_day_id
        WHERE s.id = ?`
    )
    .get(sessionId) as any;
  const planDayId = session?.plan_day_id == null ? null : Number(session.plan_day_id);
  const raw = (
    db
      .prepare(
        `SELECT ls.id, ls.exercise_id, e.name AS exercise, ls.set_number, ls.weight,
            ls.reps, ls.rir, ls.duration_sec, ls.note
       FROM logged_sets ls JOIN exercises e ON e.id = ls.exercise_id
      WHERE ls.session_id = ? ORDER BY ls.id`
      )
      .all(sessionId) as any[]
  ).map((row): DoseSet => {
    const identity = doseExerciseIdentity(String(row.exercise));
    return {
      id: Number(row.id),
      exercise_id: Number(row.exercise_id),
      exercise: String(row.exercise),
      raw_key: identity.rawKey,
      canonical_key: identity.canonicalKey,
      alias_canonical_key: identity.aliasCanonicalKey,
      set_number: Number(row.set_number),
      weight: row.weight == null ? null : Number(row.weight),
      reps: row.reps == null ? null : Number(row.reps),
      rir: row.rir == null ? null : Number(row.rir),
      duration_sec: row.duration_sec == null ? null : Number(row.duration_sec),
      note: row.note == null ? null : String(row.note),
    };
  });
  const canonical = canonicalDoseSets(raw, hasProviderImportProvenance(session?.garmin_json));
  const working = workingDoseSets(canonical.sets);
  const ledger = session?.date ? activeRecoveryWeekLedger(String(session.date)) : null;
  const createdAt = String(session?.created_at ?? "")
    .replace("T", " ")
    .slice(0, 19);
  const stampedAt = String(ledger?.stamped_at ?? "")
    .replace("T", " ")
    .slice(0, 19);
  const predatesSnapshot = !!(ledger && createdAt && stampedAt && createdAt < stampedAt);
  const snapshotDays = !predatesSnapshot && Array.isArray(ledger?.parsed?.days) ? ledger.parsed.days : [];
  const snapshotDay = snapshotDays.find((day: any) => Number(day?.day_number) === Number(session?.day_number));
  const planned = Array.isArray(snapshotDay?.items)
    ? snapshotDay.items.filter((item: any) => String(item?.kind ?? "strength").toLowerCase() !== "cardio")
    : [];
  const plannedSets = snapshotDay
    ? planned.reduce((sum: number, row: any) => sum + Math.max(0, Number(row?.sets) || 0), 0)
    : null;
  const targetByKey = new Map<string, number>();
  for (const row of planned) {
    const target = Number(row.target_weight);
    if (row.exercise && target > 0) targetByKey.set(doseExerciseKey(String(row.exercise)), target);
  }
  const rirs = working
    .map((row) => row.rir)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const medRir = median(rirs);
  const nearFailure = rirs.filter((rir) => rir <= 2).length;
  const targetRatios = working
    .map((row) => {
      const target = targetByKey.get(row.canonical_key);
      const weight = Number(row.weight);
      return target && weight > 0 ? weight / target : null;
    })
    .filter((value): value is number => value != null && Number.isFinite(value));
  const maxTargetRatio = targetRatios.length ? Math.max(...targetRatios) : null;
  const canonicalSets = working.length;
  const volumeRatio = plannedSets && plannedSets > 0 ? Math.round((canonicalSets / plannedSets) * 100) / 100 : null;

  let classification: RecoveryDoseClassification = "unknown";
  let reason = "No linked strength-plan dose is available, so the session keeps its ordinary load grade.";
  if (plannedSets != null && plannedSets > 0) {
    const compliantLimit = Math.min(plannedSets + 2, Math.ceil(plannedSets * 1.25));
    const overdoseLimit = Math.max(plannedSets + 2, Math.ceil(plannedSets * 1.5));
    const hardEffort = nearFailure >= Math.max(2, Math.ceil(Math.max(1, canonicalSets) * 0.25));
    const loadOverrun =
      (maxTargetRatio != null && maxTargetRatio > 1.3) || targetRatios.filter((ratio) => ratio > 1.15).length >= 2;
    const poorFeedback =
      (session?.performance != null && Number(session.performance) <= 2) ||
      (session?.soreness != null && Number(session.soreness) >= 4) ||
      !!String(session?.joint_pain ?? "").trim();
    if (canonicalSets >= overdoseLimit || hardEffort || loadOverrun) {
      classification = "overdose";
      reason =
        canonicalSets >= overdoseLimit
          ? `${canonicalSets} canonical working sets materially exceeded the ${plannedSets}-set recovery dose.`
          : hardEffort
            ? "Too much of the recovery session was taken near failure."
            : "Logged load materially exceeded the reduced session targets.";
    } else if (canonicalSets <= compliantLimit && !poorFeedback) {
      classification = "compliant";
      reason = `${canonicalSets} canonical working sets stayed within the ${plannedSets}-set recovery prescription.`;
    } else {
      classification = "above-plan";
      reason = poorFeedback
        ? "The reduced volume landed with a poor recovery/performance signal, so it still counts as loading."
        : `${canonicalSets} canonical working sets ran above the ${plannedSets}-set recovery prescription.`;
    }
  }

  return {
    session_id: Number(sessionId),
    plan_day_id: planDayId,
    planned_working_sets: plannedSets,
    raw_logged_sets: raw.length,
    canonical_working_sets: canonicalSets,
    duplicate_alias_sets: canonical.duplicates,
    volume_ratio: volumeRatio,
    median_rir: medRir,
    near_failure_sets: nearFailure,
    max_target_load_ratio: maxTargetRatio == null ? null : Math.round(maxTargetRatio * 100) / 100,
    classification,
    reason,
  };
}

// How hard was this STRENGTH session? Read tonnage + how close to failure the
// working sets were taken (RIR). A mobility/recovery session — no real external
// load and easy effort — grades 'easy' and therefore does NOT extend an
// earned-rest streak. A genuinely hard bodyweight/calisthenics session (several
// near-failure sets) still grades up despite zero tonnage. Null-safe → 'easy'
// when there's nothing logged.
export function sessionLoad(sessionId: number, opts: { recoveryWeekActive?: boolean } = {}): TrainingLoad {
  const sets = db
    .prepare(`SELECT weight, reps, duration_sec, rir FROM logged_sets WHERE session_id = ?`)
    .all(sessionId) as any[];
  if (!sets.length) return "easy";
  const tonnage = sets.reduce(
    (t, s) => t + (Number(s.weight) > 0 && Number(s.reps) > 0 ? Number(s.weight) * Number(s.reps) : 0),
    0
  );
  const rirs = sets
    .map((s) => s.rir)
    .filter((r) => r != null)
    .map(Number);
  const medRir = median(rirs);
  const nearFailure = sets.filter((s) => s.rir != null && Number(s.rir) <= 3).length;
  const hardLoadedSets = sets.filter(
    (s) => s.rir != null && Number(s.rir) <= 3 && Number(s.weight) > 0 && Number(s.reps) > 0
  ).length;

  if (opts.recoveryWeekActive) {
    const dose = recoverySessionDose(sessionId);
    if (dose.classification === "compliant") return "easy";
    if (dose.classification === "overdose" || dose.classification === "above-plan") {
      if (tonnage < 3000 && nearFailure < 3) return "moderate";
    }
  }

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
export function cardioEffort(a: {
  type?: string | null;
  duration_min?: number | null;
  distance_km?: number | null;
  training_effect?: number | null;
  aerobic_te?: number | null;
  anaerobic_te?: number | null;
  te_label?: string | null;
}): TrainingLoad | null {
  const type = String(a.type || "").toLowerCase();
  const dur = a.duration_min != null ? Number(a.duration_min) : null;
  const dist = a.distance_km != null ? Number(a.distance_km) : null;
  if (dur == null && dist == null) return null;
  if (/walk|hike/.test(type)) {
    return (dur != null && dur >= CARDIO_GRADE.walkHikeModerateMin) ||
      (dist != null && dist >= CARDIO_GRADE.walkHikeModerateKm)
      ? "moderate"
      : "easy";
  }
  const trainingEffect = Math.max(
    Number(a.training_effect) || 0,
    Number(a.aerobic_te) || 0,
    Number(a.anaerobic_te) || 0
  );
  const label = String(a.te_label || "").toLowerCase();
  if (trainingEffect >= 4 || /\b(?:vo2(?:[\s_-]*max)?|maximal|anaerobic|sprint|interval|threshold)\b/.test(label))
    return "hard";
  if (trainingEffect >= 3 || /\btempo\b/.test(label)) return "moderate";
  if ((dur != null && dur >= CARDIO_GRADE.hardMin) || (dist != null && dist >= CARDIO_GRADE.hardKm)) return "hard";
  if ((dur != null && dur >= CARDIO_GRADE.moderateMin) || (dist != null && dist >= CARDIO_GRADE.moderateKm))
    return "moderate";
  return "easy";
}

// The day's overall training load — the harder of its strength session(s) and
// (for an endurance/hybrid athlete) its cardio. 'none' when nothing was logged.
// This is what makes the earned-rest count intensity-aware: only 'hard'/'moderate'
// days are "loading" days that stack toward a rest read.
export function dayLoad(
  date: string,
  opts: { countsCardio: boolean; recoveryWeekActive?: boolean }
): TrainingLoad | "none" {
  let best: TrainingLoad | null = null;
  const bump = (l: TrainingLoad | null) => {
    if (l && (!best || LOAD_RANK[l] > LOAD_RANK[best])) best = l;
  };
  for (const r of db
    .prepare(`SELECT DISTINCT s.id AS id FROM sessions s JOIN logged_sets l ON l.session_id = s.id WHERE s.date = ?`)
    .all(date) as any[]) {
    bump(sessionLoad(r.id, { recoveryWeekActive: opts.recoveryWeekActive }));
  }
  if (opts.countsCardio) {
    for (const a of db
      .prepare(
        `SELECT a.type, a.duration_min, a.distance_km,
              MAX(ga.training_effect) AS training_effect,
              MAX(ga.aerobic_te) AS aerobic_te,
              MAX(ga.anaerobic_te) AS anaerobic_te,
              MAX(ga.te_label) AS te_label
         FROM activities a LEFT JOIN garmin_activities ga ON ga.activity_id = a.id
        WHERE a.date = ?
        GROUP BY a.id`
      )
      .all(date) as any[]) {
      bump(cardioEffort(a));
    }
  }
  return best ?? "none";
}

export function isLoadingDay(date: string, opts: { countsCardio: boolean }): boolean {
  const l = dayLoad(date, opts);
  return l === "hard" || l === "moderate";
}

// ---------- genuinely HARD cardio (discipline-independent earned-rest) ----------
// The earned-rest / consecutive-training-days read only counts an athlete's cardio
// when their discipline is endurance/hybrid (dayLoad's `countsCardio`). But a
// strength-primary lifter's genuinely HARD run or hike still loads recovery — so it
// must count toward those reads REGARDLESS of discipline, or a hard morning run is
// invisible and the Brief keeps stacking sessions on top of real fatigue.
//
// "Hard" is deterministic + simple: a cardio day qualifies when ANY effort that day is
//   (a) carries a hard training-effect (aerobic/anaerobic TE ≥ 4) or a hard te_label
//       (tempo / threshold / VO2 / interval / anaerobic), OR
//   (b) has meaningful time at Z4+ (threshold and above) ≥ HARD_CARDIO_Z4_SEC seconds, OR
//   (c) has a Garmin training_load clearly above the athlete's recent cardio median, OR
//   (d) is a SUSTAINED effort — but the duration bar is SPORT-AWARE: a genuine endurance
//       session (run/ride/swim/row) loads at ≥ HARD_CARDIO_MIN (40 min), while a walk/hike
//       (or an unknown "other" type) needs a much longer effort (CARDIO_GRADE.walkHikeModerateMin,
//       ~90 min) — so this athlete's ~43-min EASY hikes never grade as loading days, but a
//       long ruck with no wearable data still does. Intensity (a-c) qualifies any type.
// An easy stroll (short + low-intensity) clears none of these, so it never counts.
// Null-safe → false when there is no cardio that day. Reads activities ⨝ garmin_activities
// (strength is modeled as a session, never an activities row — same source dayLoad reads).
const HARD_CARDIO_MIN = 40; // minutes: the duration bar for a genuine endurance session (run/ride/swim/row); walk/hike use CARDIO_GRADE.walkHikeModerateMin
const HARD_CARDIO_Z4_SEC = 240; // ≥ 4 min at threshold+ (Z4/Z5) is real intensity
const HARD_CARDIO_LOAD_MULT = 1.5; // training_load ≥ 1.5× the recent cardio median reads hard
const HARD_CARDIO_LABEL = /\b(?:vo2(?:[\s_-]*max)?|maximal|anaerobic|sprint|interval|threshold|tempo|lactate)\b/;

// The median Garmin training_load across the athlete's recent CARDIO efforts (the
// activities ⨝ garmin join excludes strength, which has no activities row). null when
// there aren't enough loads to form a stable baseline.
export function recentCardioLoadMedian(asOf: string, days = 42): number | null {
  const since = new Date(new Date(asOf + "T00:00:00Z").getTime() - Math.max(1, days) * 864e5)
    .toISOString()
    .slice(0, 10);
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT g.training_load AS load FROM garmin_activities g JOIN activities a ON a.id = g.activity_id
          WHERE a.date >= ? AND a.date <= ? AND g.training_load IS NOT NULL AND g.training_load > 0`
      )
      .all(since, asOf) as any[];
  } catch {
    return null;
  }
  const loads = rows.map((r) => Number(r.load)).filter((v) => Number.isFinite(v) && v > 0);
  return loads.length >= 3 ? median(loads) : null;
}

export function hardCardioDay(date: string, loadMedian?: number | null): boolean {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT a.type AS type, a.duration_min AS dur, a.distance_km AS dist,
                g.aerobic_te AS aerobic_te, g.anaerobic_te AS anaerobic_te,
                g.te_label AS te_label, g.training_load AS load, g.hr_zones_json AS zones
           FROM activities a LEFT JOIN garmin_activities g ON g.activity_id = a.id
          WHERE a.date = ?`
      )
      .all(date) as any[];
  } catch {
    return false;
  }
  if (!rows.length) return false;
  const median = loadMedian === undefined ? recentCardioLoadMedian(date) : loadMedian;
  for (const r of rows) {
    // (a-c) intensity qualifies ANY activity type (a hard hike is still hard).
    const te = Math.max(Number(r.aerobic_te) || 0, Number(r.anaerobic_te) || 0);
    const label = String(r.te_label || "").toLowerCase();
    if (te >= 4 || HARD_CARDIO_LABEL.test(label)) return true;
    let z4 = 0;
    try {
      const z = r.zones ? JSON.parse(r.zones) : null;
      if (Array.isArray(z))
        for (const it of z) if (Number(it?.zone) >= 4) z4 += Number(it?.secs ?? it?.seconds ?? 0) || 0;
    } catch {
      /* malformed zone blob → ignore */
    }
    if (z4 >= HARD_CARDIO_Z4_SEC) return true;
    const load = r.load != null ? Number(r.load) : null;
    if (load != null && median != null && median > 0 && load >= median * HARD_CARDIO_LOAD_MULT) return true;
    // (d) SPORT-AWARE duration bar: a run/ride/swim/row loads at ≥ 40 min; a walk/hike
    // or unknown "other" type needs a much longer effort (~90 min) so an easy hike of
    // ~40 min never grades as a loading day. Distance is deliberately not a trigger.
    const dur = r.dur != null ? Number(r.dur) : null;
    if (dur == null) continue;
    const sport = canonicalEnduranceSport(r.type).key;
    const isEnduranceSession = sport === "run" || sport === "ride" || sport === "swim" || sport === "row";
    if (dur >= (isEnduranceSession ? HARD_CARDIO_MIN : CARDIO_GRADE.walkHikeModerateMin)) return true;
  }
  return false;
}
