import { db } from "../db.js";
import { emitBrainEvent } from "../brainEvents.js";
import { estimateExpenditure, measuredRmrWeightAdjustment, type ExpenditureEstimate } from "./expenditure.js";
import { lsqSlopePerDay } from "./health.js";
import { invalidateDayRead } from "./intelligence.js";
import { getLatestNutritionTarget } from "./nutrition.js";
import { latestMeasuredRmr, measuredRmrAssessment } from "./metabolism.js";
import { LB_PER_KG, addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import { bumpTrainingDataVersion } from "./training-cache.js";
import { canonicalBodyweightSeries, resolvedCurrentBodyweight } from "./bodyweight.js";
import { classifyRecompositionStage } from "./recomposition-stage.js";
import { serializeTrainingIntent } from "./training-intent.js";
import { normalizeLocationText } from "./location-context.js";

// ---------- profile ----------
export function getProfile(): any {
  return db.prepare(`SELECT * FROM profile WHERE id = 1`).get() || null;
}

// The athlete's primary training discipline, normalized (default 'strength').
// Deterministic, null-safe — the keystone of the endurance-aware reads/stats.
export function getPrimaryDiscipline(): "strength" | "endurance" | "hybrid" {
  const p = getProfile();
  return normalizeDiscipline(p?.primary_discipline, p?.primary_discipline);
}

function clampProfileNumber(v: any, min: number, max: number): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)) * 10) / 10;
}

function cleanISODate(v: any): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Coerce a PREVENT capture flag (smoking / bp_treated / statin) at the trust
// boundary. Accepts a boolean or 0/1 (as number or string); null/'' clears it
// back to "not captured"; anything else is treated as unset. Callers apply the
// same undefined-leaves-intact contract as about_me before calling this.
function coerceFlag(v: any): number | null {
  if (v == null || v === "") return null;
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  return null;
}

export function setProfile(p: any) {
  const cur = getProfile() || {};
  // Height in inches (v59) — mirrors the app's lb/in convention. Same nullable
  // contract as the other optional fields: '' / null clears, undefined leaves
  // intact, a value is clamped to a plausible human range. NaN → null.
  const heightIn: number | null =
    p.height_in !== undefined
      ? p.height_in == null || p.height_in === ""
        ? null
        : Math.round(Math.min(108, Math.max(24, Number(p.height_in))) * 10) / 10 || null
      : (cur.height_in ?? null);
  const merged = {
    // The athlete's name (optional). Same contract as the free-text fields: an
    // explicit '' clears it, undefined leaves the existing value intact, capped.
    name:
      p.name !== undefined ? (p.name == null ? null : String(p.name).trim().slice(0, 120) || null) : (cur.name ?? null),
    // Durable home base (v81). Empty/null clears, undefined leaves intact.
    // Temporary travel is a dated context_event and never overwrites this field.
    home_location: p.home_location !== undefined ? normalizeLocationText(p.home_location) : (cur.home_location ?? null),
    // A genuinely blank profile must remain unknown until the athlete supplies
    // sex; silently defaulting to male can select the wrong health ranges.
    sex: p.sex !== undefined ? p.sex : (cur.sex ?? null),
    age: p.age ?? cur.age ?? null,
    // When only inches were ever provided, derive cm so the existing TDEE /
    // doctor-report paths (which read height_cm) light up too. An explicit cm
    // always wins.
    height_cm: p.height_cm ?? cur.height_cm ?? (heightIn != null ? Math.round(heightIn * 2.54 * 10) / 10 : null),
    height_in: heightIn,
    weight_lb: p.weight_lb ?? cur.weight_lb ?? null,
    start_weight_lb:
      p.start_weight_lb !== undefined ? clampProfileNumber(p.start_weight_lb, 50, 700) : (cur.start_weight_lb ?? null),
    start_date: p.start_date !== undefined ? cleanISODate(p.start_date) : (cur.start_date ?? null),
    goal_weight_lb: p.goal_weight_lb ?? cur.goal_weight_lb ?? null,
    goal_bodyfat_pct:
      p.goal_bodyfat_pct !== undefined ? clampProfileNumber(p.goal_bodyfat_pct, 3, 70) : (cur.goal_bodyfat_pct ?? null),
    goal_date: p.goal_date ?? cur.goal_date ?? null,
    // The journey's shape (v41). Same nullable contract as the free-text fields:
    // explicit null/'' clears it (→ derived), undefined leaves intact, a valid
    // value sets it, an unrecognized value keeps the current one.
    goal_mode: p.goal_mode !== undefined ? normalizeGoalMode(p.goal_mode, cur.goal_mode) : (cur.goal_mode ?? null),
    activity_factor: p.activity_factor ?? cur.activity_factor ?? 1.5,
    notes: p.notes ?? cur.notes ?? null,
    // Rich free-text understanding (Phase 2A). Trimmed/capped; explicit empty
    // string clears it, undefined leaves the existing value intact.
    about_me:
      p.about_me !== undefined
        ? p.about_me == null
          ? null
          : String(p.about_me).slice(0, 8000)
        : (cur.about_me ?? null),
    // Allergies (HARD safety exclusion for meals) + dietary restrictions. Same
    // contract as about_me: '' clears, undefined leaves intact, capped at 1000.
    allergies:
      p.allergies !== undefined
        ? p.allergies == null
          ? null
          : String(p.allergies).slice(0, 1000)
        : (cur.allergies ?? null),
    dietary_restrictions:
      p.dietary_restrictions !== undefined
        ? p.dietary_restrictions == null
          ? null
          : String(p.dietary_restrictions).slice(0, 1000)
        : (cur.dietary_restrictions ?? null),
    // Primary training discipline (v35) — drives coach framing, the day-read, and
    // weekly stats. Only 'strength' | 'endurance' | 'hybrid' are accepted; anything
    // else falls back to the existing value (default 'strength'). endurance_sport is
    // optional free text ('' clears, undefined leaves intact, capped at 60).
    primary_discipline: normalizeDiscipline(p.primary_discipline, cur.primary_discipline),
    endurance_sport:
      p.endurance_sport !== undefined
        ? p.endurance_sport == null
          ? null
          : String(p.endurance_sport).trim().slice(0, 60) || null
        : (cur.endurance_sport ?? null),
    // The endurance OBJECTIVE (v37). undefined leaves intact, null clears, else it's
    // normalized (race | standing) and re-serialized; an unusable non-null shape
    // preserves the current goal rather than erasing it.
    endurance_goal_json:
      p.endurance_goal !== undefined
        ? p.endurance_goal == null
          ? null
          : (serializeEnduranceGoal(p.endurance_goal) ?? cur.endurance_goal_json ?? null)
        : (cur.endurance_goal_json ?? null),
    // Stated run days (v101). undefined leaves intact, null clears, else it's
    // normalized (dow 0–6 + kind) and re-serialized; an unusable non-null shape
    // preserves the current schedule rather than erasing it.
    endurance_schedule_json:
      p.endurance_schedule !== undefined
        ? p.endurance_schedule == null
          ? null
          : (serializeEnduranceSchedule(p.endurance_schedule) ?? cur.endurance_schedule_json ?? null)
        : (cur.endurance_schedule_json ?? null),
    // Ordered durable athlete intent (v80). An explicit null clears back to the
    // backward-compatible derived view; malformed non-null input is
    // non-destructive so a bad client cannot erase an explicit hierarchy.
    training_intent_json:
      p.training_intent !== undefined
        ? p.training_intent == null
          ? null
          : (serializeTrainingIntent(p.training_intent) ?? cur.training_intent_json ?? null)
        : (cur.training_intent_json ?? null),
    // AHA PREVENT capture flags (v57). Same nullable contract as the other
    // optional fields: undefined leaves intact, null/'' clears back to "not
    // captured", a boolean/0/1 sets it. Removes risk.ts's provisional assumption
    // for whichever of the three is on file.
    smoking: p.smoking !== undefined ? coerceFlag(p.smoking) : (cur.smoking ?? null),
    bp_treated: p.bp_treated !== undefined ? coerceFlag(p.bp_treated) : (cur.bp_treated ?? null),
    statin: p.statin !== undefined ? coerceFlag(p.statin) : (cur.statin ?? null),
  };
  db.prepare(
    `INSERT INTO profile (id, name, home_location, sex, age, height_cm, height_in, weight_lb, start_weight_lb, start_date, goal_weight_lb, goal_bodyfat_pct, goal_date, goal_mode, activity_factor, notes, about_me, allergies, dietary_restrictions, primary_discipline, endurance_sport, endurance_goal_json, endurance_schedule_json, training_intent_json, smoking, bp_treated, statin, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       home_location=excluded.home_location,
       sex=excluded.sex, age=excluded.age, height_cm=excluded.height_cm, height_in=excluded.height_in, weight_lb=excluded.weight_lb,
       start_weight_lb=excluded.start_weight_lb, start_date=excluded.start_date,
       goal_weight_lb=excluded.goal_weight_lb, goal_bodyfat_pct=excluded.goal_bodyfat_pct, goal_date=excluded.goal_date, goal_mode=excluded.goal_mode,
       activity_factor=excluded.activity_factor, notes=excluded.notes, about_me=excluded.about_me,
       allergies=excluded.allergies, dietary_restrictions=excluded.dietary_restrictions,
       primary_discipline=excluded.primary_discipline, endurance_sport=excluded.endurance_sport,
       endurance_goal_json=excluded.endurance_goal_json, endurance_schedule_json=excluded.endurance_schedule_json, training_intent_json=excluded.training_intent_json,
       smoking=excluded.smoking, bp_treated=excluded.bp_treated, statin=excluded.statin, updated_at=datetime('now')`
  ).run(
    merged.name,
    merged.home_location,
    merged.sex,
    merged.age,
    merged.height_cm,
    merged.height_in,
    merged.weight_lb,
    merged.start_weight_lb,
    merged.start_date,
    merged.goal_weight_lb,
    merged.goal_bodyfat_pct,
    merged.goal_date,
    merged.goal_mode,
    merged.activity_factor,
    merged.notes,
    merged.about_me,
    merged.allergies,
    merged.dietary_restrictions,
    merged.primary_discipline,
    merged.endurance_sport,
    merged.endurance_goal_json,
    merged.endurance_schedule_json,
    merged.training_intent_json,
    merged.smoking,
    merged.bp_treated,
    merged.statin
  );
  // Profile is UPDATEd in place (single row), so the SQL backstop's count/max can't
  // see a sex/age/goal/weight change — bump so program/weekly/expenditure reads refresh.
  bumpTrainingDataVersion();
  // Change-detected brain signals. weight_lb is excluded (logWeight emits its own
  // weight_logged); name/notes/about_me are soft context, not a review trigger.
  const changed = (fields: string[]) =>
    fields.filter((field) => JSON.stringify((merged as any)[field] ?? null) !== JSON.stringify(cur[field] ?? null));
  const goalChanges = changed([
    "goal_weight_lb",
    "goal_bodyfat_pct",
    "goal_date",
    "goal_mode",
    "endurance_goal_json",
    "endurance_schedule_json",
    "training_intent_json",
    "start_weight_lb",
    "start_date",
  ]);
  const profileChanges = changed([
    "home_location",
    "sex",
    "age",
    "height_cm",
    "height_in",
    "activity_factor",
    "allergies",
    "dietary_restrictions",
    "primary_discipline",
    "endurance_sport",
    "smoking",
    "bp_treated",
    "statin",
  ]);
  if (profileChanges.includes("home_location") || goalChanges.includes("endurance_schedule_json")) invalidateDayRead();
  if (goalChanges.length)
    emitBrainEvent({
      kind: "goal_changed",
      domain: "person",
      date: localDateISO(),
      subject_key: "profile:goal",
      reason: `changed: ${goalChanges.join(", ")}`,
      material: true,
    });
  if (profileChanges.length)
    emitBrainEvent({
      kind: "profile_changed",
      domain: "person",
      date: localDateISO(),
      subject_key: "profile:identity",
      reason: `changed: ${profileChanges.join(", ")}`,
      // User-declared allergies and hard dietary identities change what a meal
      // plan may safely remain authoritative for. Home changes the default
      // planning context and therefore the decision identity as well.
      material:
        profileChanges.includes("allergies") ||
        profileChanges.includes("dietary_restrictions") ||
        profileChanges.includes("home_location"),
    });
  return getProfile();
}

// Coerce a primary_discipline value: 'strength' | 'endurance' | 'hybrid' only;
// anything else (including undefined) leaves the existing value intact, defaulting
// to 'strength' on a brand-new profile.
const DISCIPLINES = new Set(["strength", "endurance", "hybrid"]);
export function normalizeDiscipline(v: any, current?: any): "strength" | "endurance" | "hybrid" {
  if (v !== undefined && v !== null) {
    const s = String(v).trim().toLowerCase();
    if (DISCIPLINES.has(s)) return s as "strength" | "endurance" | "hybrid";
  }
  const cur = current != null ? String(current).trim().toLowerCase() : "";
  return (DISCIPLINES.has(cur) ? cur : "strength") as "strength" | "endurance" | "hybrid";
}

// ---------- goal mode (v41) ----------
// The journey's SHAPE, orthogonal to the goal weight number:
//   lose     → today's lean-safe deficit toward a lower weight
//   maintain → anchor to real expenditure; hold steady, no deficit pressure
//   gain     → a conservative lean-gain surplus (never a dirty bulk)
// The stored column is nullable: NULL means "derive it" for back-compat.
export type GoalMode = "lose" | "maintain" | "gain";
const GOAL_MODES = new Set<GoalMode>(["lose", "maintain", "gain"]);

// Coerce an incoming goal_mode at the trust boundary. An explicit null/'' CLEARS
// it (→ derived); a recognized value sets it; an unrecognized non-empty value
// leaves the current value intact (mirrors normalizeDiscipline, but nullable).
export function normalizeGoalMode(v: any, current?: any): GoalMode | null {
  if (v === null || v === "") return null; // explicit clear → derive from goal weight
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  if (GOAL_MODES.has(s as GoalMode)) return s as GoalMode;
  const cur = current != null ? String(current).trim().toLowerCase() : "";
  return GOAL_MODES.has(cur as GoalMode) ? (cur as GoalMode) : null;
}

// The EFFECTIVE goal mode used by the math/prompts/UI. An explicit profile
// goal_mode wins; otherwise derive for back-compat — 'lose' when a goal weight
// meaningfully below current is set, else 'maintain'. Never returns null.
export function effectiveGoalMode(p?: any): GoalMode {
  const prof = p ?? getProfile();
  const explicit =
    prof?.goal_mode && GOAL_MODES.has(String(prof.goal_mode).toLowerCase() as GoalMode)
      ? (String(prof.goal_mode).toLowerCase() as GoalMode)
      : null;
  if (explicit) return explicit;
  const w = Number(prof?.weight_lb);
  const gw = Number(prof?.goal_weight_lb);
  if (Number.isFinite(w) && Number.isFinite(gw) && gw > 0 && gw < w - 0.5) return "lose";
  return "maintain";
}

// Conservative lean-gain pace: ~0.25% bodyweight/week, capped at 0.5 lb/wk — slow
// enough to bias muscle over fat (never a dirty bulk). Single source of truth for
// both the goal math (computeGoalCheck) and the weekly pace verdict (getWeeklyStats).
export function leanGainRate(weightLb: number): number {
  return Math.min(0.5, +(0.0025 * (weightLb || 0)).toFixed(2));
}

// ---------- endurance goal (v37) ----------
// The endurance OBJECTIVE, orthogonal to primary_discipline. Two modes:
//   race     → a dated event the coach periodizes a ramp + taper toward
//   standing → an ongoing readiness target (no date): maintain + gently build
// Normalized/clamped at the trust boundary; an unusable shape returns null (= clear).
export type EnduranceGoal = {
  mode: "race" | "standing";
  event?: string | null; // race name (race mode)
  date?: string | null; // race date YYYY-MM-DD (race mode)
  label?: string | null; // readiness label, e.g. "10k-ready" (standing mode)
  distance_km?: number | null; // target/readiness distance
  target?: string | null; // qualitative target, e.g. "sub-1:45"
  weekly_km?: number | null; // optional volume anchor
  weekly_sessions?: number | null;
};
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function clampPos(v: any, max: number): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : null;
}
function capStr(v: any, max: number): string | null {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}
function realISODate(value: unknown): string | null {
  const raw = String(value ?? "");
  if (!ISO_DATE.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? raw : null;
}
export function normalizeEnduranceGoal(input: any): EnduranceGoal | null {
  let g: any = input;
  if (typeof g === "string") {
    try {
      g = JSON.parse(g);
    } catch {
      return null;
    }
  }
  if (!g || typeof g !== "object") return null;
  const mode = String(g.mode || "")
    .trim()
    .toLowerCase();
  const distance_km = clampPos(g.distance_km, 500);
  const weekly_km = clampPos(g.weekly_km, 400);
  const weekly_sessions = clampPos(g.weekly_sessions, 14);
  if (mode === "race") {
    const date = realISODate(g.date);
    if (!date) return null; // a race without a date can't be periodized — reject
    return {
      mode: "race",
      event: capStr(g.event, 120),
      date,
      distance_km,
      target: capStr(g.target, 60),
      weekly_km,
      weekly_sessions,
    };
  }
  if (mode === "standing") {
    return {
      mode: "standing",
      label: capStr(g.label, 80),
      distance_km,
      target: capStr(g.target, 60),
      weekly_km,
      weekly_sessions,
    };
  }
  return null;
}
function serializeEnduranceGoal(input: any): string | null {
  if (input == null) return null;
  const g = normalizeEnduranceGoal(input);
  return g ? JSON.stringify(g) : null;
}

// Deterministic read of the active endurance goal, with race timing derived for the
// coach (weeks/days out + a coarse periodization PHASE hint). Standing goals have no
// date, so no phase — the coach maintains rather than ramps. Returns null when unset.
export function getEnduranceGoal(today?: string):
  | (EnduranceGoal & {
      is_race: boolean;
      days_to_race?: number | null;
      weeks_to_race?: number | null;
      phase?: "base" | "build" | "sharpen" | "taper" | "past" | null;
    })
  | null {
  const p = getProfile();
  const g = normalizeEnduranceGoal(p?.endurance_goal_json);
  if (!g) return null;
  if (g.mode !== "race" || !g.date) return { ...g, is_race: false };
  // Days from today TO the race. NaN (not null) on an unusable date, because the
  // next line is a Number.isFinite gate that already answers "no race timing".
  const days = daysBetweenISO(g.date, today || localDateISO()) ?? Number.NaN;
  if (!Number.isFinite(days)) return { ...g, is_race: true, days_to_race: null, weeks_to_race: null, phase: null };
  const weeks = Math.ceil(days / 7);
  // Coarse phase hint from time-to-race (the coach refines against actual base).
  //
  // DISTANCE-AWARE, because time-to-race alone reads a half-marathon like a 5k. The
  // longer the race, the longer the build has to be to mean anything: 13 weeks out
  // from a half is the heart of the build, and calling it "base" left the whole
  // build phase to fall entirely inside the last 10 weeks — a window too short to
  // arrive anywhere. A long race (15 km and up) therefore gets a wider build and a
  // slightly longer sharpen; shorter races keep the original windows, where a 10-week
  // build genuinely is the whole story.
  //   long  (≥15 km): past → done; ≤2wk taper; ≤5wk sharpen; ≤14wk build; else base.
  //   short (<15 km): past → done; ≤2wk taper; ≤4wk sharpen; ≤10wk build; else base.
  const longRace = Number.isFinite(Number(g.distance_km)) && Number(g.distance_km) >= 15;
  const sharpenTo = longRace ? 5 : 4;
  const buildTo = longRace ? 14 : 10;
  const phase =
    days < 0 ? "past" : weeks <= 2 ? "taper" : weeks <= sharpenTo ? "sharpen" : weeks <= buildTo ? "build" : "base";
  return { ...g, is_race: true, days_to_race: days, weeks_to_race: Math.max(0, weeks), phase };
}

// ---------- endurance schedule (v101) ----------
// The athlete's STATED run days — orthogonal to the endurance objective and to
// primary_discipline. When set, weeklyRunPlan anchors day_numbers to these dows
// and the rolling agenda never suggests a run on an unscheduled weekday.
//
// null means REJECT — the input itself was not a schedule at all (not an object,
// no `days` array present), or a non-empty `days` array named nothing this parser
// could understand — and callers leave the stored schedule untouched. A `days`
// array with at least one entry is never rejected as a whole for one bad sibling:
// an entry with an unrecognized dow/kind is DROPPED rather than voiding every
// other entry alongside it (one typo used to erase a schedule the athlete got
// right). An explicitly empty `days: []`, told apart from the "everything got
// dropped" case above, is the athlete's own clear intent and comes back as a real
// (non-null) schedule with `days: []`, which reads downstream identically to
// "unset" (every consumer already gates on `schedule?.days.length`) — that
// distinction is what lets "clear my run days" actually clear one, instead of the
// clear request itself reading as invalid input and leaving the old schedule in
// place.
export const ENDURANCE_SCHEDULE_KINDS = ["easy", "quality", "long", "any"] as const;
export type EnduranceScheduleKind = (typeof ENDURANCE_SCHEDULE_KINDS)[number];
export type EnduranceScheduleSource = "athlete" | "chat";
export type EnduranceScheduleDay = {
  dow: 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday
  kind: EnduranceScheduleKind;
};
export type EnduranceSchedule = {
  days: EnduranceScheduleDay[];
  note?: string;
  source: EnduranceScheduleSource;
  updated_at: string;
};
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const SCHEDULE_KIND_SET = new Set<string>(ENDURANCE_SCHEDULE_KINDS);
const SCHEDULE_SOURCE_SET = new Set<string>(["athlete", "chat"]);

export function isoDow(dateISO: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return new Date(`${dateISO}T00:00:00Z`).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}
export function dowToDayNumber(dow: number): number {
  return dow === 0 ? 7 : dow;
}

export function normalizeEnduranceSchedule(
  input: any,
  opts?: { source?: EnduranceScheduleSource }
): EnduranceSchedule | null {
  let raw: any = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.days)) return null;
  // An explicit `days: []` is the athlete's own clear intent, told apart from a
  // non-empty array that happens to drop down to nothing below (every entry was
  // unrecognized) — the former must produce a real, empty schedule; the latter is
  // still a rejection, since nothing named was actually understood.
  const explicitlyCleared = raw.days.length === 0;
  const days: EnduranceScheduleDay[] = [];
  const seen = new Set<number>();
  for (const entry of raw.days) {
    // Drop the one bad entry, not the whole schedule — a typo'd day must never
    // erase every day the athlete named correctly alongside it.
    if (!entry || typeof entry !== "object") continue;
    const dow = Number(entry.dow);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) continue;
    const kind = String(entry.kind ?? "")
      .trim()
      .toLowerCase();
    if (!SCHEDULE_KIND_SET.has(kind)) continue;
    if (seen.has(dow)) continue;
    seen.add(dow);
    days.push({ dow: dow as EnduranceScheduleDay["dow"], kind: kind as EnduranceScheduleKind });
  }
  if (!explicitlyCleared && !days.length) return null; // nothing named was understood -> reject, not a clear
  days.sort((a, b) => a.dow - b.dow);
  const sourceRaw = String(raw.source ?? opts?.source ?? "athlete")
    .trim()
    .toLowerCase();
  const source: EnduranceScheduleSource = SCHEDULE_SOURCE_SET.has(sourceRaw)
    ? (sourceRaw as EnduranceScheduleSource)
    : (opts?.source ?? "athlete");
  const note = capStr(raw.note, 240);
  const updatedRaw = typeof raw.updated_at === "string" ? raw.updated_at.trim().slice(0, 40) : "";
  const updated_at = updatedRaw || new Date().toISOString();
  return { days, ...(note ? { note } : {}), source, updated_at };
}

function serializeEnduranceSchedule(input: any, sourceDefault: EnduranceScheduleSource = "athlete"): string | null {
  if (input == null) return null;
  const g = normalizeEnduranceSchedule(input, { source: sourceDefault });
  return g ? JSON.stringify({ ...g, updated_at: new Date().toISOString() }) : null;
}

export function getEnduranceSchedule(): EnduranceSchedule | null {
  const p = getProfile();
  return normalizeEnduranceSchedule(p?.endurance_schedule_json);
}

/** null when no schedule is set; otherwise whether `dateISO`'s weekday is one of the stated run days. */
export function isStatedRunDay(dateISO: string): boolean | null {
  const schedule = getEnduranceSchedule();
  if (!schedule?.days.length) return null;
  const dow = isoDow(dateISO);
  return schedule.days.some((d) => d.dow === dow);
}

export function formatEnduranceScheduleDays(schedule: EnduranceSchedule): string {
  return schedule.days.map((d) => `${WEEKDAY_NAMES[d.dow]}${d.kind !== "any" ? ` (${d.kind})` : ""}`).join(", ");
}

export function nextScheduledRunWeekday(asOf: string, kind?: EnduranceScheduleKind): string | null {
  const schedule = getEnduranceSchedule();
  if (!schedule?.days.length) return null;
  const wanted = kind ? schedule.days.filter((d) => d.kind === kind || d.kind === "any") : schedule.days;
  const pool = wanted.length ? wanted : schedule.days;
  for (let ahead = 1; ahead <= 7; ahead++) {
    const date = addDaysISO(asOf, ahead);
    if (!date) continue;
    const dow = isoDow(date);
    if (pool.some((d) => d.dow === dow)) return WEEKDAY_NAMES[dow];
  }
  return WEEKDAY_NAMES[pool[0].dow];
}

// ---------- bodyweight log ----------
const MIN_LOGGED_WEIGHT_LB = 50;
const MAX_LOGGED_WEIGHT_LB = 700;

function canonicalWeightLogDate(value: unknown): string {
  if (value === undefined) return localDateISO();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError("weight date must be YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError("weight date must be a real calendar date");
  }
  if (value > localDateISO()) throw new RangeError("weight date cannot be in the future");
  return value;
}

// Shared trust boundary for REST, MCP, chat, and direct callers. A rejected
// reading does not write a row or promote an invalid date into profile.weight_lb.
export function logWeight(weight_lb: number, date?: string, note?: string) {
  const weight = Number(weight_lb);
  if (!Number.isFinite(weight) || weight < MIN_LOGGED_WEIGHT_LB || weight > MAX_LOGGED_WEIGHT_LB) {
    throw new RangeError(`weight_lb must be between ${MIN_LOGGED_WEIGHT_LB} and ${MAX_LOGGED_WEIGHT_LB}`);
  }
  const d = canonicalWeightLogDate(date);
  const info = db
    .prepare(`INSERT INTO bodyweight_log (date, weight_lb, note) VALUES (?, ?, ?)`)
    .run(d, weight, note ?? null);
  bumpTrainingDataVersion(); // a weigh-in moves the weekly trend + expenditure reads
  // Keep the profile's current weight in sync with the most recent entry.
  const latest = db.prepare(`SELECT weight_lb FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT 1`).get() as any;
  if (latest) setProfile({ weight_lb: latest.weight_lb });
  // A fresh weigh-in is a brain signal (it moves the weight trend the day-read +
  // energy-balance read speak to) — refresh the Brief like its sibling signals do.
  invalidateDayRead(d);
  emitBrainEvent({
    kind: "weight_logged",
    domain: "body",
    date: d,
    entity_id: Number(info.lastInsertRowid),
    subject_key: "bodyweight",
    ...(() => {
      try {
        const goal: any = computeGoalCheck();
        const trend = Number(goal?.trend_lb_wk);
        const ideal = Number(goal?.leanness_rate?.lean_ideal_rate_lb);
        const material =
          goal?.goal_mode === "lose" && Number.isFinite(trend) && Number.isFinite(ideal) && trend < -(ideal * 1.1);
        return material ? { material: true, reason: "weight trend is faster than the lean-mass-preserving pace" } : {};
      } catch {
        return {};
      }
    })(),
  });
  return db.prepare(`SELECT * FROM bodyweight_log WHERE id = ?`).get(info.lastInsertRowid);
}

export function listWeight(limit = 60) {
  // chronological for charting
  const rows = db.prepare(`SELECT * FROM bodyweight_log ORDER BY date DESC, id DESC LIMIT ?`).all(limit) as any[];
  return rows.reverse();
}

// ---------- goal feasibility check ----------
export const KCAL_PER_LB = 3500;
// The universal kcal safety floor. Shared with the proposal-apply clamp
// (clampNutritionTarget, ./proposals.ts), which sits above this module.
export const KCAL_ABSOLUTE_FLOOR = 1500; // never advise a target below this for this user (mirrors buildMealPlanPrompt)

export interface BodyFatEstimate {
  body_fat_pct: number;
  source: "tape" | "garmin" | "profile";
  date: string | null;
  estimated: boolean;
}

function heightInFor(p: any): number | null {
  const hin = Number(p?.height_in);
  if (Number.isFinite(hin) && hin >= 24 && hin <= 108) return hin;
  const hcm = Number(p?.height_cm);
  if (Number.isFinite(hcm) && hcm >= 60 && hcm <= 275) return hcm / 2.54;
  return null;
}

function navyTapeBodyFat(p: any): BodyFatEstimate | null {
  const heightIn = heightInFor(p);
  if (heightIn == null) return null;
  const row = db
    .prepare(`SELECT date, waist_in, hip_in, neck_in FROM body_measurements ORDER BY date DESC, id DESC LIMIT 1`)
    .get() as any;
  if (!row) return null;
  const waist = Number(row.waist_in);
  const neck = Number(row.neck_in);
  const hip = Number(row.hip_in);
  const female = String(p?.sex || "male").toLowerCase() === "female";
  let value: number | null = null;
  if (!female && Number.isFinite(waist) && Number.isFinite(neck) && waist > neck && heightIn > 0) {
    value = 86.01 * Math.log10(waist - neck) - 70.041 * Math.log10(heightIn) + 36.76;
  } else if (
    female &&
    Number.isFinite(waist) &&
    Number.isFinite(hip) &&
    Number.isFinite(neck) &&
    waist + hip > neck &&
    heightIn > 0
  ) {
    value = 163.205 * Math.log10(waist + hip - neck) - 97.684 * Math.log10(heightIn) - 78.387;
  }
  if (value == null || !Number.isFinite(value)) return null;
  value = Math.max(3, Math.min(70, Math.round(value * 10) / 10));
  return { body_fat_pct: value, source: "tape", date: row.date ?? null, estimated: true };
}

function latestGarminBodyFat(): BodyFatEstimate | null {
  const row = db
    .prepare(
      `SELECT date, body_fat_pct FROM garmin_daily_metrics WHERE body_fat_pct IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1`
    )
    .get() as any;
  const value = Number(row?.body_fat_pct);
  if (!Number.isFinite(value) || value < 3 || value > 70) return null;
  return { body_fat_pct: Math.round(value * 10) / 10, source: "garmin", date: row.date ?? null, estimated: false };
}

export function currentBodyFatEstimate(prof?: any): BodyFatEstimate | null {
  const p = prof ?? getProfile();
  if (!p) return null;
  return navyTapeBodyFat(p) ?? latestGarminBodyFat();
}

// Decision-time phase snapshot. The classifier itself is pure/cycle-free; this
// adapter only gathers current canonical profile/bodyweight/phase inputs so an
// intervention can retain the phase it actually belonged to.
export function recompositionStageAt(today = localDateISO()) {
  const profile = getProfile() as any;
  const resolved = resolvedCurrentBodyweight(profile, today);
  const current = Number(resolved?.weight_lb ?? profile?.weight_lb);
  const start = Number(profile?.start_weight_lb);
  const goal = Number(profile?.goal_weight_lb);
  const validCurrent = Number.isFinite(current) && current > 0 ? current : null;
  const validStart = Number.isFinite(start) && start > 0 ? start : null;
  const validGoal = Number.isFinite(goal) && goal > 0 ? goal : null;
  const lost = validStart != null && validCurrent != null ? Math.max(0, validStart - validCurrent) : null;
  const total = validStart != null && validGoal != null && validStart > validGoal ? validStart - validGoal : null;
  const progress = total != null && lost != null ? Math.max(0, Math.min(1, lost / total)) : null;
  const remaining = validCurrent != null && validGoal != null ? Math.max(0, validCurrent - validGoal) : null;
  const phase = db
    .prepare(
      `SELECT kind FROM journey_phases WHERE status = 'active'
       ORDER BY COALESCE(start_date, created_at) DESC, id DESC LIMIT 1`
    )
    .get() as any;
  const bodyFat = currentBodyFatEstimate(profile);
  return classifyRecompositionStage({
    mode: effectiveGoalMode(profile),
    phaseKind: phase?.kind ?? null,
    progress,
    remaining,
    current: validCurrent,
    bodyFatPct: bodyFat?.body_fat_pct ?? null,
    bodyFatDate: bodyFat?.date ?? null,
    goalBodyFat: Number.isFinite(Number(profile?.goal_bodyfat_pct)) ? Number(profile.goal_bodyfat_pct) : null,
    today,
  });
}

export function leannessAwareLossRates(weightLb: number, bodyFatPct?: number | null) {
  const w = Number(weightLb);
  const baseMax = Number.isFinite(w) ? 0.01 * w : 0;
  const baseIdeal = Number.isFinite(w) ? 0.0075 * w : 0;
  const bf = bodyFatPct == null ? Number.NaN : Number(bodyFatPct);
  let maxPct = 0.01;
  let idealPct = 0.0075;
  let reason = "standard lean-safe cut";
  if (Number.isFinite(bf)) {
    if (bf < 15) {
      maxPct = 0.0035;
      idealPct = 0.0025;
      reason = "very lean — taper the deficit hard to protect lean mass";
    } else if (bf < 20) {
      maxPct = 0.006;
      idealPct = 0.0045;
      reason = "leaner phase — slower loss protects training and lean mass";
    } else if (bf < 25) {
      maxPct = 0.008;
      idealPct = 0.006;
      reason = "mid-cut — slightly slower than the early phase";
    }
  }
  return {
    safe_max_rate_lb: +Math.min(baseMax, Math.max(0, w * maxPct)).toFixed(2),
    lean_ideal_rate_lb: +Math.min(baseIdeal, Math.max(0, w * idealPct)).toFixed(2),
    reason,
    body_fat_pct: Number.isFinite(bf) ? Math.round(bf * 10) / 10 : null,
  };
}

export function computeGoalCheck(
  prof?: any,
  opts: { expenditure?: ExpenditureEstimate | null; syncMeasuredRmr?: boolean } = {}
) {
  const storedProfile = prof ?? getProfile();
  const currentWeight = resolvedCurrentBodyweight(storedProfile);
  const p = currentWeight ? { ...storedProfile, weight_lb: currentWeight.weight_lb } : storedProfile;
  if (!p || !p.weight_lb || !p.height_cm || !p.age) {
    return { ok: false, message: "Profile incomplete (need age, height, weight)." };
  }
  const kg = p.weight_lb / LB_PER_KG;
  const sexAdj = (p.sex || "male") === "female" ? -161 : 5;
  const formulaBmr = 10 * kg + 6.25 * p.height_cm - 5 * p.age + sexAdj;
  const measuredRmrOpts = { syncHealthDocs: opts.syncMeasuredRmr !== false };
  const measuredRmr = latestMeasuredRmr(measuredRmrOpts);
  const rmrAdjustment = measuredRmr
    ? measuredRmrWeightAdjustment({ kcal: measuredRmr.kcal, date: measuredRmr.date }, localDateISO())
    : null;
  const measuredRmrQualityRaw = measuredRmr ? measuredRmrAssessment(localDateISO(), measuredRmrOpts) : null;
  const measuredRmrQuality = measuredRmrQualityRaw
    ? { ...measuredRmrQualityRaw, adjusted_kcal: rmrAdjustment?.adjusted_kcal ?? null }
    : null;
  const measuredWeight = measuredRmrQuality?.freshness_weight ?? 0;
  const measuredKcal = measuredRmrQuality?.adjusted_kcal ?? measuredRmrQuality?.kcal;
  const bmr =
    measuredRmrQuality && measuredKcal != null ? formulaBmr + (measuredKcal - formulaBmr) * measuredWeight : formulaBmr;
  // The manual activity factor is the cold-start seed. estimateExpenditure owns
  // the complete prior hierarchy + outcome fusion so the Goal and Energy
  // surfaces cannot disagree about which maintenance estimate is active.
  const factorTdee = Math.round(formulaBmr * (p.activity_factor || 1.5));
  let tdee = factorTdee;
  let tdee_source: "activity_factor" | "measured_rmr_plus_activity" | "garmin_total_calories" | "adaptive" | "blended" =
    "activity_factor";
  let tdee_basis = "profile_seed";
  let tdee_confidence: "none" | "low" | "medium" | "high" = "none";
  let expenditure: ExpenditureEstimate | null = null;
  if (opts.expenditure !== undefined) {
    expenditure = opts.expenditure;
  } else {
    try {
      expenditure = estimateExpenditure(21, { syncMeasuredRmr: opts.syncMeasuredRmr });
    } catch {
      expenditure = null;
    }
  }
  try {
    if (expenditure && expenditure.tdee != null && expenditure.tdee > 0) {
      tdee = expenditure.tdee;
      tdee_basis = expenditure.tdee_basis;
      tdee_confidence = expenditure.confidence;
      if (expenditure.tdee_basis === "measured_rmr_active") tdee_source = "measured_rmr_plus_activity";
      else if (expenditure.tdee_basis === "garmin_total_calories") tdee_source = "garmin_total_calories";
      else if (expenditure.tdee_basis === "profile_seed") tdee_source = "activity_factor";
      else if (expenditure.tdee_basis === "blended_outcome_prior") tdee_source = "blended";
      else tdee_source = "adaptive";
    }
  } catch {
    /* malformed optional estimate → retain the deterministic profile seed */
  }

  const mode = effectiveGoalMode(p);
  const lbsToLose = p.goal_weight_lb != null ? Math.max(0, p.weight_lb - p.goal_weight_lb) : 0;

  // lean-safe loss: early cuts can run near ~0.5-1% BW/week, but the ceiling
  // tapers as body fat falls. A tape/Garmin body-fat estimate is an estimate, so
  // it only narrows the ceiling; absent BF keeps the old conservative default.
  const bodyFat = currentBodyFatEstimate(p);
  const lossRates = leannessAwareLossRates(p.weight_lb, bodyFat?.body_fat_pct ?? null);
  const safeMaxRate = lossRates.safe_max_rate_lb; // upper bound (lb/wk)
  const leanIdealRate = lossRates.lean_ideal_rate_lb; // recommended (lb/wk)

  let requested: any = null;
  let recommended: {
    weekly_rate_lb: number;
    daily_deficit_kcal: number;
    target_intake_kcal: number;
    weeks_to_goal: number;
    protein_g: number;
  };
  let message: string;

  if (mode === "maintain") {
    // Anchor to real expenditure. No deficit, no surplus — hold steady. We only
    // ever nudge later if the measured weight trend genuinely drifts.
    recommended = {
      weekly_rate_lb: 0,
      daily_deficit_kcal: 0,
      target_intake_kcal: Math.max(KCAL_ABSOLUTE_FLOOR, tdee),
      weeks_to_goal: 0,
      protein_g: Math.round((p.weight_lb || 0) * 0.9),
    };
    message = `Maintaining — anchor to ~${tdee} kcal with ~${recommended.protein_g} g protein. Hold steady; we only nudge if your weight genuinely drifts.`;
  } else if (mode === "gain") {
    // Conservative lean gain: ~0.25% bodyweight/week (capped at 0.5 lb/wk) — slow
    // enough to bias muscle over fat. NEVER a dirty bulk; lab quality (e.g. ApoB)
    // still gates WHAT the surplus is made of via the connected brain.
    const gainRate = leanGainRate(p.weight_lb);
    const dailySurplus = Math.round((gainRate * KCAL_PER_LB) / 7);
    recommended = {
      weekly_rate_lb: gainRate,
      daily_deficit_kcal: -dailySurplus, // negative = a surplus (field name kept for back-compat)
      target_intake_kcal: Math.max(KCAL_ABSOLUTE_FLOOR, tdee + dailySurplus),
      weeks_to_goal: 0,
      protein_g: Math.round((p.weight_lb || 0) * 1.0),
    };
    message = `Lean gain — eat ~${recommended.target_intake_kcal} kcal (about +${dailySurplus}/day over maintenance) with ~${recommended.protein_g} g protein. Slow and steady builds muscle, not fat.`;
  } else {
    // lose (explicit, or derived from a goal weight below current).
    if (p.goal_date && lbsToLose > 0) {
      const weeks = Math.max(0.1, (new Date(p.goal_date).getTime() - Date.now()) / (7 * 864e5));
      const rate = +(lbsToLose / weeks).toFixed(2);
      const dailyDeficit = Math.round((rate * KCAL_PER_LB) / 7);
      requested = {
        weeks: +weeks.toFixed(1),
        weekly_rate_lb: rate,
        daily_deficit_kcal: dailyDeficit,
        target_intake_kcal: Math.max(KCAL_ABSOLUTE_FLOOR, tdee - dailyDeficit),
        aggressive: rate > safeMaxRate,
      };
    }
    const recDailyDeficit = Math.round((leanIdealRate * KCAL_PER_LB) / 7);
    recommended = {
      weekly_rate_lb: leanIdealRate,
      daily_deficit_kcal: recDailyDeficit,
      target_intake_kcal: Math.max(KCAL_ABSOLUTE_FLOOR, tdee - recDailyDeficit),
      weeks_to_goal: lbsToLose > 0 ? Math.ceil(lbsToLose / leanIdealRate) : 0,
      protein_g: Math.round((p.weight_lb || 0) * 1.0),
    };
    if (lbsToLose <= 0) {
      message = "At or below goal weight — maintain and keep training for lean mass.";
    } else if (requested?.aggressive) {
      message = `Goal of ${lbsToLose} lb by ${p.goal_date} needs ~${requested.weekly_rate_lb} lb/wk (~${requested.daily_deficit_kcal} kcal/day deficit). That's above the lean-safe ceiling of ~${safeMaxRate} lb/wk and will likely cost muscle. Recommended: ~${recommended.weekly_rate_lb} lb/wk → about ${recommended.weeks_to_goal} weeks, eating ~${recommended.target_intake_kcal} kcal with ~${recommended.protein_g} g protein.`;
    } else if (requested) {
      message = `On track: ~${requested.weekly_rate_lb} lb/wk is within the lean-safe range. Eat ~${requested.target_intake_kcal} kcal, ~${recommended.protein_g} g protein.`;
    } else {
      message = `No target date set. Lean-safe pace ~${recommended.weekly_rate_lb} lb/wk → ${recommended.weeks_to_goal} weeks to lose ${lbsToLose} lb, eating ~${recommended.target_intake_kcal} kcal, ~${recommended.protein_g} g protein.`;
    }
  }

  // ---- goal-pace projection (from the ACTUAL weigh-in trend, not the plan) ----
  // The static math above asks "what rate would HIT the date"; this projects
  // where the CURRENT measured trend actually lands. Plain language + a date —
  // never a score. Null/silent when there isn't enough scale data or no goal.
  const goalPace = projectGoalPace(p, lbsToLose);

  // ---- the EFFECTIVE target the surfaces read (accepted > formula) ----------
  // If the athlete has ACCEPTED an adaptive-nutrition target, that number wins over
  // the re-derived formula (closing the loop — the accepted target is persisted, not
  // recomputed each time). The formula stays the fallback AND the lean-safe floor:
  // protein never drops below the recommended protein floor. `accepted` is null-safe.
  let accepted: any = null;
  try {
    accepted = getLatestNutritionTarget();
  } catch {
    accepted = null;
  }
  const effective_target =
    accepted && accepted.target_kcal != null && !accepted.review_due
      ? {
          target_kcal: Math.max(KCAL_ABSOLUTE_FLOOR, Math.round(accepted.target_kcal)),
          protein_g: Math.max(Math.round(accepted.protein_g ?? 0), Math.round(recommended.protein_g || 0)),
          carbs_g: accepted.carbs_g != null ? Math.round(accepted.carbs_g) : null,
          fat_g: accepted.fat_g != null ? Math.round(accepted.fat_g) : null,
          source: "accepted" as const,
          effective_date: accepted.effective_date,
          age_days: accepted.age_days ?? 0,
          freshness: accepted.freshness ?? "fresh",
          review_due: !!accepted.review_due,
          divergence_from_formula_kcal: Math.round(
            Math.max(KCAL_ABSOLUTE_FLOOR, Number(accepted.target_kcal)) - Number(recommended.target_intake_kcal)
          ),
        }
      : {
          target_kcal: Math.round(recommended.target_intake_kcal),
          protein_g: Math.round(recommended.protein_g || 0),
          carbs_g: null,
          fat_g: null,
          source: "formula" as const,
          effective_date: null,
          age_days: null,
          freshness: null,
          review_due: !!accepted?.review_due,
          divergence_from_formula_kcal: 0,
          expired_target:
            accepted?.review_due && accepted.target_kcal != null
              ? {
                  target_kcal: accepted.target_kcal,
                  protein_g: accepted.protein_g,
                  effective_date: accepted.effective_date,
                  age_days: accepted.age_days,
                  freshness: accepted.freshness,
                  source: accepted.source,
                }
              : null,
        };
  const effectiveMessage =
    accepted && accepted.target_kcal != null && !accepted.review_due
      ? `Active target: ~${effective_target.target_kcal} kcal with ~${effective_target.protein_g} g protein${effective_target.carbs_g != null ? `, ${effective_target.carbs_g} g carbs` : ""}${effective_target.fat_g != null ? `, and ${effective_target.fat_g} g fat` : ""}. Cairn will recheck it against your weight trend and training performance.`
      : accepted?.review_due
        ? `${message} The prior adaptive target is review-due, so it remains visible in history but no longer overrides this current read.`
        : message;

  return {
    ok: true,
    bmr: Math.round(bmr),
    bmr_source: measuredRmrQuality?.freshness === "fresh" ? "measured" : measuredWeight > 0 ? "blended" : "formula",
    bmr_formula: Math.round(formulaBmr),
    measured_rmr: measuredRmrQuality,
    measured_rmr_adjusted_for_lb: rmrAdjustment
      ? {
          original_kcal: measuredRmr?.kcal ?? rmrAdjustment.adjusted_kcal - rmrAdjustment.adjustment_kcal,
          adjusted_kcal: rmrAdjustment.adjusted_kcal,
          test_weight_lb: rmrAdjustment.test_weight_lb,
          current_weight_lb: rmrAdjustment.current_weight_lb,
          delta_lb: rmrAdjustment.delta_lb,
          test_weight_date: rmrAdjustment.test_weight_date,
        }
      : null,
    tdee,
    tdee_source,
    tdee_basis,
    tdee_confidence,
    expenditure,
    lbs_to_lose: lbsToLose,
    // The effective journey shape (v41) — drives the day-intake target framing,
    // the pace verdict, and every nutrition prompt. Additive; older consumers ignore.
    goal_mode: mode,
    safe_max_rate_lb: safeMaxRate,
    leanness_rate: {
      body_fat_pct: lossRates.body_fat_pct,
      body_fat_source: bodyFat?.source ?? null,
      reason: lossRates.reason,
      safe_max_rate_lb: safeMaxRate,
      lean_ideal_rate_lb: leanIdealRate,
    },
    requested,
    recommended,
    message: effectiveMessage,
    formula_message: message,
    // The persisted accepted target (or null) + the EFFECTIVE target every surface
    // should read (accepted wins, formula is the fallback/floor). Additive.
    accepted_target: accepted,
    effective_target,
    // Additive (older consumers ignore): the measured-trend forecast.
    trend_lb_wk: goalPace.trend_lb_wk,
    projected_goal_date: goalPace.projected_goal_date,
    projection_text: goalPace.projection_text,
  };
}

// Project where the athlete's CURRENT measured weight trend lands their goal —
// a real forecast off the scale, not the plan's required pace. Returns the
// measured weekly trend, a projected goal date (or null), and a plain-language
// line ("at this trend, ~Aug 20 — about 3 weeks past your date"). Words + a
// date, never a number-as-score. Null-safe: too little scale data / no goal →
// quiet (trend or date null, no false precision).
export function projectGoalPace(
  p: any,
  lbsToLose: number
): {
  trend_lb_wk: number | null;
  projected_goal_date: string | null;
  projection_text: string | null;
} {
  // Measured weekly trend over the last 28 days of weigh-ins (a bit longer than
  // the 21-day weekly-stats window so a goal forecast is steadier).
  const today = localDateISO();
  const since = addDaysISO(today, -28) ?? today;
  const wpts = canonicalBodyweightSeries({ since, through: today });
  let trend: number | null = null; // lb/week (negative = losing)
  if (wpts.length >= 2) {
    const pts = wpts
      .map((w) => ({ date: String(w.date), value: Number(w.weight_lb) }))
      .filter((x) => Number.isFinite(x.value));
    const xs = pts.map((x) => Date.parse(x.date + "T00:00:00Z") / 864e5);
    if (pts.length >= 2 && xs[xs.length - 1] - xs[0] >= 4) {
      const slope = lsqSlopePerDay(pts);
      if (slope != null) trend = Math.round(slope * 7 * 100) / 100;
    }
  }
  const curW = resolvedCurrentBodyweight(p, today)?.weight_lb ?? null;
  const goalW = p?.goal_weight_lb;
  const remainingLb = goalW != null && curW != null ? Math.max(0, curW - Number(goalW)) : lbsToLose;
  if (remainingLb <= 0 || curW == null) return { trend_lb_wk: trend, projected_goal_date: null, projection_text: null };
  if (trend == null)
    return {
      trend_lb_wk: null,
      projected_goal_date: null,
      projection_text: "Not enough recent weigh-ins to project a date yet — a few more and the forecast sharpens.",
    };

  if (goalW == null) return { trend_lb_wk: trend, projected_goal_date: null, projection_text: null };

  // Not actually losing (trend flat or gaining) while there's still weight to
  // lose → no honest date; say so plainly rather than inventing one.
  if (trend >= -0.05) {
    return {
      trend_lb_wk: trend,
      projected_goal_date: null,
      projection_text:
        trend > 0.05
          ? "At your current trend you're drifting up, not down — no date to project until the trend turns."
          : "Your weight's holding steady right now — a small deficit would start moving it toward your goal.",
    };
  }

  const weeksToGoal = (curW - goalW) / Math.abs(trend);
  if (!Number.isFinite(weeksToGoal) || weeksToGoal <= 0 || weeksToGoal > 520) {
    return {
      trend_lb_wk: trend,
      projected_goal_date: null,
      projection_text: "At this trend the goal is a long way out — worth revisiting the pace.",
    };
  }
  const projDate = new Date(Date.now() + weeksToGoal * 7 * 864e5);
  const projected_goal_date = projDate.toISOString().slice(0, 10);
  const niceDate = projDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  let projection_text: string;
  if (p?.goal_date) {
    const goalDateMs = Date.parse(p.goal_date);
    if (Number.isFinite(goalDateMs)) {
      const diffWeeks = Math.round((projDate.getTime() - goalDateMs) / (7 * 864e5));
      if (diffWeeks <= -1)
        projection_text = `At your current trend, ~${niceDate} — about ${Math.abs(diffWeeks)} week${Math.abs(diffWeeks) === 1 ? "" : "s"} ahead of your date.`;
      else if (diffWeeks >= 1)
        projection_text = `At your current trend, ~${niceDate} — about ${diffWeeks} week${diffWeeks === 1 ? "" : "s"} past your date.`;
      else projection_text = `At your current trend, ~${niceDate} — right around your target date.`;
    } else {
      projection_text = `At your current trend, you'd reach your goal around ${niceDate}.`;
    }
  } else {
    projection_text = `At your current trend, you'd reach your goal around ${niceDate} — no target date set, so this is just where the scale's heading.`;
  }
  return { trend_lb_wk: trend, projected_goal_date, projection_text };
}
