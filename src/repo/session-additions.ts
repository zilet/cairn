import { truncateAtWord } from "../brain/contract-utils.js";
import { normalizePrescriptionItem } from "../contracts/session-prescription.js";
import { finite } from "../lib/numbers.js";
import { getActiveDailySession, safeAgentSeconds, safeAgentWeight, type SessionLoadBasis } from "./adaptive-session.js";
import { decideDailySession } from "./daily-decision.js";
import {
  canonicalGroup,
  classifyMuscleGroup,
  isKnownBodyweightMovement,
  normalizedExerciseKey,
  resolveExerciseName,
} from "./exercise-canon.js";
import { exerciseInputFor, type ExerciseInput } from "./exercise-input.js";
import { examplesForGroup } from "./exercise-variations.js";
import { liftAlternatives } from "./exercise-suggestions.js";
import {
  findExercise,
  getExercise,
  listExercises,
  recentWorkingSeconds,
  recentWorkingWeight,
} from "./exercises.js";
import { listContextEvents } from "./health.js";
import { withFlexibleRunLookahead } from "./hybrid-run-lookahead.js";
import { getLastSet, getSessionByDate } from "./sessions.js";
import { addDaysISO, localDateISO } from "./shared.js";
import { hybridDayContext } from "./training-read.js";
import { listTrainingSymptoms } from "./training-symptoms.js";

export interface MidSessionLoggedExercise {
  exercise: string;
  muscle_group: string | null;
  sets: number;
  top_weight: number | null;
  top_reps: number | null;
  top_seconds: number | null;
  last_rir: number | null;
}

export interface MidSessionRemainingExercise {
  exercise: string;
  muscle_group: string | null;
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  target_weight: number | null;
  target_seconds: number | null;
  mode: "reps" | "timed";
}

export interface MidSessionCandidate {
  exercise: string;
  muscle_group: string | null;
  mode: "reps" | "timed";
  recent_weight: number | null;
  recent_seconds: number | null;
  bodyweight: boolean;
}

export interface MidSessionSnapshot {
  date: string;
  session_title: string | null;
  session_focus: string | null;
  logged: MidSessionLoggedExercise[];
  remaining: MidSessionRemainingExercise[];
  skipped: string[];
  exclude_keys: string[];
  excluded_muscles: string[];
  reduced_muscles: string[];
  saturated_muscles: string[];
  injury_areas: string[];
  key_run_tomorrow: { date: string; kind: "quality" | "long"; km: number | null } | null;
  equipment: string | null;
  candidate_pool: MidSessionCandidate[];
}

export interface SessionAdditionItem {
  exercise: string;
  mode: "reps" | "timed";
  sets: number;
  rep_low: number | null;
  rep_high: number | null;
  target_weight: number | null;
  target_seconds: number | null;
  load_basis: SessionLoadBasis;
  input: ExerciseInput;
  muscle_group: string | null;
  fit: string;
  note: string | null;
  last_set: Record<string, unknown> | null;
}

export interface SessionAdditionsPayload {
  why: string;
  suggestions: SessionAdditionItem[];
}

const LOWER_GROUPS = new Set(["quads", "hamstrings", "glutes", "calves"]);
const DEFAULT_FALLBACK_GROUPS = ["back", "shoulders", "biceps", "triceps", "core", "rear delts", "glutes", "chest"] as const;

function cleanProse(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return truncateAtWord(text, max) || null;
}

function resolveMuscleGroupFor(name: string, storedGroup?: unknown): string | null {
  if (typeof storedGroup === "string" && storedGroup.trim()) {
    return canonicalGroup(storedGroup) ?? storedGroup.trim().toLowerCase();
  }
  const found = findExercise(name);
  if (found?.muscle_group) {
    return canonicalGroup(found.muscle_group) ?? String(found.muscle_group).trim().toLowerCase();
  }
  return classifyMuscleGroup(name) ?? null;
}

function resolveCanonicalExercise(rawName: unknown): { name: string; row: any | null } | null {
  const typed = String(rawName ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!typed) return null;
  const direct = findExercise(typed);
  if (direct) return { name: String(direct.name), row: direct };
  const resolved = resolveExerciseName(typed);
  if (resolved.exercise_id != null) {
    const row = getExercise(resolved.exercise_id);
    if (row) return { name: String(row.name), row };
  }
  return { name: typed, row: null };
}

function loadBasisFor(exercise: string, weight: number | null, equipment?: string | null): SessionLoadBasis {
  if (weight != null && weight < 0) return "assisted";
  if (weight != null && weight > 0) return "loaded";
  if (isKnownBodyweightMovement(exercise, equipment)) return "bodyweight";
  return "open";
}

function summarizeLoggedSets(sets: unknown[]): MidSessionLoggedExercise[] {
  const byKey = new Map<string, MidSessionLoggedExercise>();
  for (const raw of sets) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Record<string, unknown>;
    const exercise = String(s.exercise ?? "").trim();
    const key = normalizedExerciseKey(exercise);
    if (!key) continue;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        exercise,
        muscle_group: resolveMuscleGroupFor(exercise, s.muscle_group),
        sets: 0,
        top_weight: null,
        top_reps: null,
        top_seconds: null,
        last_rir: null,
      };
      byKey.set(key, entry);
    }
    entry.sets += 1;
    const w = finite(s.weight);
    if (w != null && (entry.top_weight == null || w > entry.top_weight)) entry.top_weight = w;
    const r = finite(s.reps);
    if (r != null && (entry.top_reps == null || r > entry.top_reps)) entry.top_reps = r;
    const sec = finite(s.duration_sec);
    if (sec != null && (entry.top_seconds == null || sec > entry.top_seconds)) entry.top_seconds = sec;
    const rir = finite(s.rir);
    if (rir != null) entry.last_rir = rir;
  }
  return [...byKey.values()];
}

function readInjuryAreas(date: string): string[] {
  const areas = new Set<string>();
  try {
    const symptoms = listTrainingSymptoms({ on: date, include_resolved: false, seed_legacy: false });
    for (const sym of symptoms) {
      if (sym?.area_text && sym.scope !== "systemic") areas.add(String(sym.area_text).trim());
    }
  } catch {
    /* symptom storage optional on fresh install */
  }
  try {
    const events = listContextEvents({ activeOnly: true, on: date }) as Array<Record<string, unknown>>;
    for (const ev of events) {
      if (ev?.kind === "injury" && ev.title) areas.add(String(ev.title).trim());
    }
  } catch {
    /* context events optional */
  }
  return [...areas].filter(Boolean);
}

/**
 * Deterministic live snapshot of the athlete's active session, logged work, remaining
 * card items, skips, active exclusions/injuries, and grounded candidate exercises.
 */
export function buildMidSessionSnapshot(
  dateInput?: string,
  opts: { focus?: string; constraints?: string; exclude?: string[] } = {}
): MidSessionSnapshot {
  const date = String(dateInput || localDateISO()).slice(0, 10);
  const active = getActiveDailySession(date) as Record<string, unknown> | null;
  const session = getSessionByDate(date) as Record<string, unknown> | null;

  const logged = summarizeLoggedSets(Array.isArray(session?.sets) ? session.sets : []);
  const loggedKeys = new Set(logged.map((entry) => normalizedExerciseKey(entry.exercise)));

  const rawItems = Array.isArray(active?.items) ? active.items : [];
  const remaining: MidSessionRemainingExercise[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.kind === "cardio") continue;
    const exercise = String(item.exercise ?? "").trim();
    const key = normalizedExerciseKey(exercise);
    if (!key || loggedKeys.has(key)) continue;
    remaining.push({
      exercise,
      muscle_group: resolveMuscleGroupFor(exercise, item.muscle_group),
      sets: finite(item.sets),
      rep_low: finite(item.rep_low),
      rep_high: finite(item.rep_high),
      target_weight: finite(item.target_weight),
      target_seconds: finite(item.target_seconds),
      mode: item.mode === "timed" || finite(item.target_seconds) != null ? "timed" : "reps",
    });
  }

  const skipped = Array.isArray(session?.skips)
    ? session.skips.map((name) => String(name ?? "").trim()).filter(Boolean)
    : [];
  const extraExclude = Array.isArray(opts.exclude) ? opts.exclude : [];
  const excludeNames = [
    ...logged.map((l) => l.exercise),
    ...remaining.map((r) => r.exercise),
    ...skipped,
    ...extraExclude.map((name) => String(name ?? "").trim()),
  ].filter(Boolean);
  const excludeKeySet = new Set<string>(
    excludeNames.map((name) => normalizedExerciseKey(name)).filter(Boolean)
  );

  const injuryAreas = readInjuryAreas(date);
  let excludedMuscles: string[] = [];
  let reducedMuscles: string[] = [];
  let saturatedMuscles: string[] = [];
  let equipment: string | null = null;
  try {
    const { envelope } = decideDailySession(date, { train_anyway: true });
    excludedMuscles = (envelope.muscles.excluded ?? []).map((g) => g.toLowerCase());
    reducedMuscles = (envelope.muscles.reduced ?? []).map((g) => g.toLowerCase());
    saturatedMuscles = (envelope.muscles.saturated ?? []).map((g) => g.toLowerCase());
    equipment = envelope.request?.equipment ?? null;
  } catch {
    /* fresh DB without profile/plan still allows ideation */
  }

  let keyRunTomorrow: MidSessionSnapshot["key_run_tomorrow"] = null;
  try {
    const hybrid = withFlexibleRunLookahead(hybridDayContext(date), date);
    const tomorrow = addDaysISO(date, 1);
    if (
      hybrid.planned_run_next &&
      hybrid.planned_run_next.date === tomorrow &&
      (hybrid.planned_run_next.kind === "quality" || hybrid.planned_run_next.kind === "long")
    ) {
      keyRunTomorrow = {
        date: hybrid.planned_run_next.date,
        kind: hybrid.planned_run_next.kind,
        km: hybrid.planned_run_next.km,
      };
    }
  } catch {
    keyRunTomorrow = null;
  }

  const excludedSet = new Set(excludedMuscles);
  const saturatedSet = new Set([...reducedMuscles, ...saturatedMuscles]);
  const candidatePool: MidSessionCandidate[] = [];
  const candidateKeys = new Set<string>();

  const pushCandidate = (
    name: string,
    groupHint?: string | null,
    modeHint?: string | null,
    eqHint?: string | null,
    knownRow?: any | null
  ) => {
    const row = knownRow ?? findExercise(name);
    const canonical = row?.name ? String(row.name) : name;
    const key = normalizedExerciseKey(canonical);
    if (!key || excludeKeySet.has(key) || candidateKeys.has(key)) return;
    const rawGroup = row?.muscle_group ?? groupHint;
    const group = rawGroup
      ? (canonicalGroup(String(rawGroup)) ?? String(rawGroup).trim().toLowerCase())
      : (classifyMuscleGroup(canonical) ?? null);
    if (group && excludedSet.has(group)) return;
    const mode: "reps" | "timed" =
      row?.mode === "timed" || modeHint === "timed" ? "timed" : "reps";
    const recentWeight = recentWorkingWeight(canonical);
    const recentSeconds = mode === "timed" ? recentWorkingSeconds(canonical) : null;
    candidateKeys.add(key);
    candidatePool.push({
      exercise: canonical,
      muscle_group: group,
      mode,
      recent_weight: recentWeight,
      recent_seconds: recentSeconds,
      bodyweight: isKnownBodyweightMovement(canonical, row?.equipment ?? eqHint),
    });
  };

  // 1. Same-pattern / complementary variations for movements already in the session.
  for (const seed of [...logged.map((l) => l.exercise), ...remaining.map((r) => r.exercise)]) {
    if (candidatePool.length >= 10) break;
    try {
      const alts = liftAlternatives(seed, { limit: 3, injuryAreas, excludeNames });
      for (const alt of alts) {
        pushCandidate(alt.name, null, null, alt.equipment ?? null);
        if (candidatePool.length >= 10) break;
      }
    } catch {
      /* ignore unknown movement */
    }
  }

  // 2. Athlete's own catalog movements (preferring fresh, non-saturated muscle groups).
  try {
    const catalog = listExercises()
      .slice()
      .sort((a, b) => {
        const gA = resolveMuscleGroupFor(a.name, a.muscle_group);
        const gB = resolveMuscleGroupFor(b.name, b.muscle_group);
        const satA = gA && saturatedSet.has(gA) ? 1 : 0;
        const satB = gB && saturatedSet.has(gB) ? 1 : 0;
        if (satA !== satB) return satA - satB;
        const logA = a.last_logged ? 0 : 1;
        const logB = b.last_logged ? 0 : 1;
        if (logA !== logB) return logA - logB;
        return String(a.name).localeCompare(String(b.name));
      });
    for (const row of catalog) {
      if (candidatePool.length >= 18) break;
      pushCandidate(row.name, row.muscle_group, row.mode, row.equipment, row);
    }
  } catch {
    /* ignore */
  }

  // 3. Curated group examples so an empty/brand-new catalog still offers concrete movements.
  for (const group of DEFAULT_FALLBACK_GROUPS) {
    if (candidatePool.length >= 18) break;
    if (excludedSet.has(group)) continue;
    for (const ex of examplesForGroup(group, 2)) {
      pushCandidate(ex, group);
      if (candidatePool.length >= 18) break;
    }
  }

  const sessionTitle =
    cleanProse(active?.title, 120) ??
    cleanProse(session?.title ?? session?.day_name, 120) ??
    null;
  const sessionFocus = cleanProse(active?.focus, 120) ?? null;

  return {
    date,
    session_title: sessionTitle,
    session_focus: sessionFocus,
    logged,
    remaining,
    skipped,
    exclude_keys: [...excludeKeySet],
    excluded_muscles: excludedMuscles,
    reduced_muscles: reducedMuscles,
    saturated_muscles: saturatedMuscles,
    injury_areas: injuryAreas,
    key_run_tomorrow: keyRunTomorrow,
    equipment,
    candidate_pool: candidatePool,
  };
}

function normalizeCandidateItem(
  raw: unknown,
  index: number,
  snapshot: MidSessionSnapshot,
  seenKeys: Set<string>
): SessionAdditionItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (item.kind === "cardio") return null;

  const resolved = resolveCanonicalExercise(item.exercise);
  if (!resolved) return null;
  const key = normalizedExerciseKey(resolved.name);
  if (!key || seenKeys.has(key)) return null;

  const muscleGroup = resolveMuscleGroupFor(resolved.name, resolved.row?.muscle_group ?? item.muscle_group);
  if (muscleGroup && snapshot.excluded_muscles.includes(muscleGroup)) return null;

  let core: ReturnType<typeof normalizePrescriptionItem>;
  try {
    core = normalizePrescriptionItem(
      { ...item, kind: "strength", exercise: resolved.name },
      index,
      { storedMode: resolved.row?.mode ?? null, clampBounds: true, strictShape: true }
    );
  } catch {
    return null;
  }

  const mode = (core.mode ?? "reps") as "reps" | "timed";
  const input = exerciseInputFor(resolved.name, mode);
  const mobility = input.profile === "mobility";
  const targetWeight = mobility ? null : safeAgentWeight(resolved.name, item.target_weight);
  const targetSeconds =
    mode === "timed" && core.target_seconds != null
      ? safeAgentSeconds(resolved.name, core.target_seconds)
      : null;

  const fit = cleanProse(item.fit, 140) ?? "Fits nicely alongside today's work.";
  const note = cleanProse(item.note, 220);
  const lastSet = getLastSet(resolved.name) as Record<string, unknown> | null;

  seenKeys.add(key);
  return {
    exercise: resolved.name,
    mode,
    sets: core.sets ?? 3,
    rep_low: mode === "timed" ? null : core.rep_low,
    rep_high: mode === "timed" ? null : core.rep_high,
    target_weight: targetWeight,
    target_seconds: targetSeconds,
    load_basis: loadBasisFor(resolved.name, targetWeight, resolved.row?.equipment),
    input,
    muscle_group: muscleGroup,
    fit,
    note,
    last_set: lastSet && typeof lastSet === "object" ? lastSet : null,
  };
}

/**
 * Validate and ground an agent's session-additions response against the live
 * mid-session snapshot (canonical names, authoritative DB modes, clamped weights,
 * injury exclusions, no duplicates/skips/cardio). Returns null when nothing usable survives.
 */
export function normalizeSessionAdditionsResult(
  raw: unknown,
  snapshot: MidSessionSnapshot
): SessionAdditionsPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const why = cleanProse(obj.why, 280);
  if (!why || !Array.isArray(obj.suggestions) || !obj.suggestions.length) return null;

  const seenKeys = new Set(snapshot.exclude_keys);
  const suggestions: SessionAdditionItem[] = [];
  for (let i = 0; i < obj.suggestions.length && suggestions.length < 4; i++) {
    const normalized = normalizeCandidateItem(obj.suggestions[i], i, snapshot, seenKeys);
    if (normalized) suggestions.push(normalized);
  }
  if (!suggestions.length) return null;
  return { why, suggestions };
}

function candidateMatchesSteer(candidate: MidSessionCandidate, focusOrConstraints: string): boolean {
  const q = focusOrConstraints.toLowerCase();
  if (!q) return true;
  const group = (candidate.muscle_group ?? "").toLowerCase();
  const name = candidate.exercise.toLowerCase();
  if (/\b(arm|bicep|tricep|curl|extension)\b/.test(q)) return group === "biceps" || group === "triceps" || group === "forearms";
  if (/\b(core|ab|plank|carry|finisher)\b/.test(q)) return group === "core" || group === "forearms" || candidate.mode === "timed";
  if (/\b(upper|push|chest|shoulder|delt)\b/.test(q)) return ["chest", "shoulders", "rear delts", "triceps", "back", "biceps"].includes(group);
  if (/\b(back|pull|row|lat)\b/.test(q)) return group === "back" || group === "rear delts" || group === "biceps";
  if (/\b(leg|lower|squat|hinge|glute|quad|hamstring|calf)\b/.test(q)) return LOWER_GROUPS.has(group);
  if (/\b(dumbbell|db)\b/.test(q)) return /\b(db|dumbbell|goblet)\b/.test(name) || candidate.bodyweight;
  return true;
}

/**
 * Guaranteed deterministic fallback when no coaching agent is reachable or the
 * agent returns unusable output. Picks 3–4 complementary, safe exercises from the
 * grounded candidate pool with realistic conservative prescriptions.
 */
export function deterministicSessionAdditions(
  snapshot: MidSessionSnapshot,
  opts: { focus?: string; constraints?: string } = {}
): SessionAdditionsPayload {
  const steer = [opts.focus, opts.constraints].filter(Boolean).join(" ").trim();
  const asksLower = /\b(leg|lower|squat|hinge|glute|quad|hamstring|calf)\b/i.test(steer);
  const saturated = new Set([...snapshot.reduced_muscles, ...snapshot.saturated_muscles]);

  const ranked = snapshot.candidate_pool
    .slice()
    .sort((a, b) => {
      const steerA = steer && candidateMatchesSteer(a, steer) ? 0 : 1;
      const steerB = steer && candidateMatchesSteer(b, steer) ? 0 : 1;
      if (steerA !== steerB) return steerA - steerB;
      const legPenaltyA = snapshot.key_run_tomorrow && !asksLower && a.muscle_group && LOWER_GROUPS.has(a.muscle_group) ? 1 : 0;
      const legPenaltyB = snapshot.key_run_tomorrow && !asksLower && b.muscle_group && LOWER_GROUPS.has(b.muscle_group) ? 1 : 0;
      if (legPenaltyA !== legPenaltyB) return legPenaltyA - legPenaltyB;
      const satA = a.muscle_group && saturated.has(a.muscle_group) ? 1 : 0;
      const satB = b.muscle_group && saturated.has(b.muscle_group) ? 1 : 0;
      if (satA !== satB) return satA - satB;
      const histA = a.recent_weight != null || a.recent_seconds != null ? 0 : 1;
      const histB = b.recent_weight != null || b.recent_seconds != null ? 0 : 1;
      return histA - histB;
    });

  const picked: MidSessionCandidate[] = [];
  const usedGroups = new Set<string>();
  for (const candidate of ranked) {
    if (picked.length >= 4) break;
    const g = candidate.muscle_group;
    if (g && usedGroups.has(g) && ranked.some((other) => other.muscle_group && !usedGroups.has(other.muscle_group) && !picked.includes(other))) {
      continue;
    }
    picked.push(candidate);
    if (g) usedGroups.add(g);
  }

  const seenKeys = new Set(snapshot.exclude_keys);
  const suggestions: SessionAdditionItem[] = [];
  for (let i = 0; i < picked.length; i++) {
    const cand = picked[i];
    const isTimed = cand.mode === "timed";
    const weight = isTimed
      ? cand.recent_weight
      : cand.bodyweight
        ? null
        : cand.recent_weight;
    const seconds = isTimed ? Math.max(20, Math.min(90, Math.round(cand.recent_seconds ?? 35))) : null;
    const fit = cand.muscle_group
      ? `Adds focused ${cand.muscle_group} work without overloading today's recovery.`
      : "Clean complementary work that rounds out the session.";
    const item = normalizeCandidateItem(
      {
        exercise: cand.exercise,
        mode: cand.mode,
        sets: isTimed ? 2 : 3,
        ...(isTimed ? { target_seconds: seconds } : { rep_low: 10, rep_high: 12 }),
        target_weight: weight,
        fit,
        note: weight == null && !cand.bodyweight ? "Pick a comfortable working weight and leave 2 reps in reserve." : null,
      },
      i,
      snapshot,
      seenKeys
    );
    if (item) suggestions.push(item);
  }

  const why = snapshot.logged.length
    ? `Here are a few options that build on what you've already logged${snapshot.key_run_tomorrow ? " while keeping legs fresh for tomorrow's run" : ""}.`
    : "Here are a few straightforward additions that fit today's picture.";

  return { why, suggestions };
}
