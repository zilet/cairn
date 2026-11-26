// ============================================================================
// unit-plateau.ts — "this movement has stopped progressing: which lever next?"
//
// ONE deterministic answer per movement unit on the plan (the capability read's units,
// strength-capability.ts). The capability read says whether a unit is climbing, holding,
// slipping or not readable yet; this read says what to do about a hold. Read-only: it
// writes nothing. The bounded, reversible levers are acted on by
// domain/brain/unit-plateau-change.ts through the ordinary autonomy path; everything else
// is a read for the coach, the program redraw and the card.
//
// THE LADDER, in order. Each lever is tried once per plateau before the next:
//   1. `wait` — the hold is explained or too young. A `cut` qualifier (holding strength in
//      a deficit is the goal), `run_build` (the legs are carrying a ramping run load:
//      concurrent training interferes mainly with lower-body strength), `recovery` (a
//      lighter week is running); fewer than PLATEAU_MIN_WEEKS weeks and
//      PLATEAU_MIN_SESSIONS comparable sessions at one working load and rep count; a
//      prescription written inside the settle window; the progression engine already
//      moving the plan lift (a load step, a rep step, a set step, its own escalation);
//      pain or an injury on the lift. A `slipping` unit always waits: a slide is recovery,
//      fuel or interference, never a reason for more sets or a new exercise.
//   2. `rep_scheme` — move the rep range up at the held load (lift-response.ts
//      movedRepRangeFor), once per lift per plateau, remembered on the applied-proposal
//      ledger exactly as the isolation move always was (`progression_escalation:
//      "rep_range"`). Double progression and a change of rep range come before a swap.
//   3. `set_quality` — logged RIR shows most working sets ending well short of failure
//      (SET_QUALITY_RIR or more on more than SET_QUALITY_SHARE of them, at least
//      SET_QUALITY_MIN_SETS rated): the lever is effort, not volume. A note only, never a
//      load change. RIR is optional and its absence proves nothing, so unrated sets never
//      count toward it.
//   4. `volume` — the unit's primary muscle sits under its productive weekly band
//      (MUSCLE_LANDMARKS' low end, the capability read's own band). More sets help a
//      plateau only with adequate recovery and only up to a point, so a group already in
//      or above its band moves on. The earned-set path (volume-step.ts, which holds under
//      any cut) is what acts; this read only names the lever, and a volume step landed or
//      refused inside the plateau spends it.
//   5. `variation` — rotate the lift inside the same unit (exercise-variations.ts
//      candidates kept to the unit, the athlete's equipment first, then a variant with
//      history). Variation keeps a plateaued movement progressing, but frequent changes of
//      a main lift cost skill-specific strength: an accessory may rotate at a block
//      boundary, a compound anchor at most once per block and only at a block boundary
//      (the first week of a block, program-blocks.ts). Off the boundary the unit waits for
//      the next block.
//
// Fail closed: a read that throws makes the whole ladder `available:false` (the capability
// read failing) or the one unit `wait` with code `unavailable`. Never a score; the reasons
// are plain words.
// ============================================================================
import { db } from "../db.js";
import { plausibleRir } from "../lib/numbers.js";
import type {
  CapabilityNextLever,
  CapabilityUnit,
  CapabilityUnitNext,
  StrengthCapabilityRead,
} from "../contracts/strength-capability.js";
import { progressionLineageIds, resolveExerciseName } from "./exercise-canon.js";
import { availableEquipment } from "./equipment.js";
import { classifyPattern, type Equipment, inferEquipment, suggestAlternatives } from "./exercise-variations.js";
import { injuryAffectsExercise, listContextEvents } from "./health.js";
import { movedRepRangeFor, repRangeMoveSpent } from "./lift-response.js";
import { sessionCountsTowardLiftTrajectory } from "./lift-comparability.js";
import { primaryMuscleGroup } from "./muscle-credit.js";
import { copyDeep, registerMemoGuard, requestMemo } from "./request-memo.js";
import { currentTrainingDataVersion } from "./training-cache.js";
import { painBandForMovement } from "./pain-band.js";
import { activePlanAdaptations } from "./plan-adaptations.js";
import { getPlan } from "./plan.js";
import { slotAuthorship } from "./prescription-authorship.js";
import { getActiveBlock } from "./program-blocks.js";
import { nextPrescription } from "./progression.js";
import { addDaysISO, daysBetweenISO, localDateISO, localDayOfStamp } from "./shared.js";
import { capabilityRead, capabilityUnitOf } from "./strength-capability.js";
import { activeRelevantTrainingSymptoms } from "./training-symptoms.js";
import { exposureLighterOnPurpose } from "./whole-person-trajectory.js";
import { sessionWorkingLoad } from "./working-load.js";

// ---------- the knobs ----------

/** A plateau is at least this many weeks at one working load and rep count (3 to 4 is the usual coaching window; the shorter end, because the first lever is gentle). */
export const PLATEAU_MIN_WEEKS = 3;
/** ...across at least this many comparable sessions (one a week is the floor of a real test). */
export const PLATEAU_MIN_SESSIONS = 3;
/** Top-set reps within this many of the latest session count as the same rep count. */
export const PLATEAU_REP_NOISE = 1;
/** How far back the plateau run is read. */
export const PLATEAU_LOOKBACK_DAYS = 112;
/** A working set at this many reps in reserve or more ended well short of failure. */
export const SET_QUALITY_RIR = 3;
/** ...and the effort lever needs more than this share of the RATED working sets there. */
export const SET_QUALITY_SHARE = 0.5;
/** ...out of at least this many rated working sets inside the plateau. */
export const SET_QUALITY_MIN_SETS = 4;
/** A variant with logged sets inside this many days counts as one the athlete has history on. */
export const VARIATION_HISTORY_DAYS = 365;
/** The source every ladder change is written under (plan_proposals.agent). */
export const UNIT_PLATEAU_AGENT = "unit-plateau";
// The volume step's source (domain/brain/volume-step.ts VOLUME_STEP_AGENT), restated: a
// repo read must not import the brain service that routes through autonomy.
const VOLUME_STEP_AGENT = "volume-step";

// ---------- the shape ----------

export type PlateauLever = CapabilityNextLever;

export type PlateauCode =
  | "climbing"
  | "not_enough"
  | "slipping"
  | "cut"
  | "run_build"
  | "recovery"
  | "too_young"
  | "fresh_prescription"
  | "engine_moving"
  | "pain"
  | "timed"
  | "unavailable"
  | "rep_scheme"
  | "set_quality"
  | "volume"
  | "variation"
  | "next_block"
  | "block_used"
  | "no_candidate";

export interface PlateauPlanLift {
  exercise: string;
  day_number: number;
  plan_item_id: number;
  muscle_group: string | null;
  sets: number | null;
  rep_low: number | null;
  rep_high: number | null;
  target_weight: number | null;
  mode: string | null;
  constraint_note: string | null;
}

export interface UnitPlateauRung {
  unit_key: string;
  label: string;
  compound: boolean;
  lever: PlateauLever;
  code: PlateauCode;
  /** Plain words, athlete-facing register; never a number that reads as a score. */
  reason: string;
  /** The first session of the current plateau (one load, one rep count); null when there is none. */
  since: string | null;
  plan_lift: PlateauPlanLift | null;
  /** The rep range a `rep_scheme` lever would write. */
  rep_range?: { rep_low: number; rep_high: number } | null;
  /** The variant a `variation` lever would rotate in. */
  candidate?: { exercise: string; why: string } | null;
}

export interface UnitPlateauLadder {
  available: boolean;
  date: string;
  /** The active block and whether today sits on its boundary (its first week). */
  block: { id: number; week_index: number; boundary: boolean } | null;
  units: UnitPlateauRung[];
}

// ---------- small reads ----------

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

const num = (v: unknown): number | null => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function strengthItems(day: any): any[] {
  return (Array.isArray(day?.items) ? day.items : []).filter(
    (item: any) =>
      item && String(item.kind ?? "strength").toLowerCase() !== "cardio" && String(item.exercise ?? "").trim()
  );
}

/** The plan lift each unit is judged on: the unit's first lift in plan order (day, then position). */
export function planLiftsByUnit(): Map<string, PlateauPlanLift> {
  const out = new Map<string, PlateauPlanLift>();
  const days = (getPlan() as any[])
    .filter((day) => String(day?.day_type ?? "training").toLowerCase() !== "rest")
    .sort((a, b) => Number(a.day_number) - Number(b.day_number));
  for (const day of days) {
    for (const item of strengthItems(day)) {
      const name = String(item.exercise);
      const group = item.muscle_group == null ? null : String(item.muscle_group);
      const resolved = resolveExerciseName(name);
      const unit = capabilityUnitOf(resolved.canonical || name, group);
      if (!unit || out.has(unit.key)) continue;
      out.set(unit.key, {
        exercise: name,
        day_number: Number(day.day_number),
        plan_item_id: Number(item.id),
        muscle_group: group,
        sets: num(item.sets),
        rep_low: num(item.rep_low),
        rep_high: num(item.rep_high),
        target_weight: num(item.target_weight),
        mode: item.mode == null ? null : String(item.mode),
        constraint_note: item.constraint_note == null ? null : String(item.constraint_note),
      });
    }
  }
  return out;
}

/** The slot's stored stamp (plan_items.prescribed_at). */
export function planItemStamp(planItemId: number): string | null {
  const row = db.prepare(`SELECT prescribed_at FROM plan_items WHERE id = ?`).get(Number(planItemId)) as any;
  return row?.prescribed_at == null ? null : String(row.prescribed_at);
}

// ---------- the plateau run ----------

export interface PlateauSession {
  session_id: number;
  date: string;
  /** The session's working load (sessionWorkingLoad); 0 for bodyweight work. Never null in a run. */
  working: number;
  top_reps: number;
  /** The sets taken at the working load (the ones double progression reads). */
  sets: Array<{ weight: number | null; reps: number; rir: number | null }>;
}

export interface PlateauRun {
  since: string;
  sessions: PlateauSession[];
  /** Whole weeks from the run's first session to `date`. */
  weeks: number;
  working: number;
  top_reps: number;
}

/** The lift's comparable sessions inside the lookback, oldest first. */
export function plateauSessions(name: string, date: string, repLow: number | null = null): PlateauSession[] {
  const ids = progressionLineageIds(name);
  if (!ids.length) return [];
  const from = addDaysISO(date, -PLATEAU_LOOKBACK_DAYS) ?? date;
  const inIds = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ls.session_id AS session_id, s.date AS date, ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
         FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id IN (${inIds}) AND s.date BETWEEN ? AND ?
          AND ls.reps > 0 AND ls.duration_sec IS NULL
        ORDER BY s.date, ls.id`
    )
    .all(...ids, from, date) as any[];
  const bySession = new Map<
    number,
    { date: string; sets: Array<{ weight: number | null; reps: number; rir: number | null }> }
  >();
  for (const row of rows) {
    const id = Number(row.session_id);
    const entry = bySession.get(id) ?? { date: String(row.date).slice(0, 10), sets: [] };
    entry.sets.push({ weight: num(row.weight), reps: Number(row.reps), rir: plausibleRir(row.rir) });
    bySession.set(id, entry);
  }
  const out: PlateauSession[] = [];
  for (const [sessionId, entry] of bySession) {
    if (!sessionCountsTowardLiftTrajectory(sessionId)) continue;
    if (safe(() => exposureLighterOnPurpose(sessionId, name), false)) continue;
    const loaded = sessionWorkingLoad(entry.sets, repLow);
    let working: number;
    let atLoad: PlateauSession["sets"];
    if (loaded != null) {
      working = loaded;
      atLoad = entry.sets.filter((s) => s.weight != null && Math.abs(s.weight - loaded) < 0.05);
    } else if (entry.sets.every((s) => s.weight == null || s.weight === 0)) {
      // Bodyweight work: one load, the reps decide.
      working = 0;
      atLoad = entry.sets;
    } else {
      // Assisted (negative) work: the hardest signed load reached is the session's load.
      const signed = entry.sets.filter((s) => s.weight != null).map((s) => Number(s.weight));
      working = Math.max(...signed);
      atLoad = entry.sets.filter((s) => s.weight != null && Math.abs(Number(s.weight) - working) < 0.05);
    }
    if (!atLoad.length) continue;
    out.push({
      session_id: sessionId,
      date: entry.date,
      working,
      top_reps: Math.max(...atLoad.map((s) => s.reps)),
      sets: atLoad,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.session_id - b.session_id);
}

/**
 * The current plateau: the trailing run of comparable sessions at the latest session's
 * working load with a top-set rep count within PLATEAU_REP_NOISE of it. Null with no
 * session at all. Pure over the sessions.
 */
export function plateauRunOf(sessions: readonly PlateauSession[], date: string): PlateauRun | null {
  if (!sessions.length) return null;
  const latest = sessions[sessions.length - 1];
  const run: PlateauSession[] = [];
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (Math.abs(s.working - latest.working) >= 0.05) break;
    if (Math.abs(s.top_reps - latest.top_reps) > PLATEAU_REP_NOISE) break;
    run.unshift(s);
  }
  const since = run[0].date;
  const days = daysBetweenISO(date, since) ?? 0;
  return {
    since,
    sessions: run,
    weeks: Math.floor(Math.max(0, days) / 7),
    working: latest.working,
    top_reps: latest.top_reps,
  };
}

/** Is the plateau old and full enough to be one? */
export function plateauMatured(run: PlateauRun | null): boolean {
  return run != null && run.sessions.length >= PLATEAU_MIN_SESSIONS && run.weeks >= PLATEAU_MIN_WEEKS;
}

/**
 * The effort read over the plateau's working sets: true when enough of them carry an RIR
 * and most of those ended at SET_QUALITY_RIR or more. Unrated sets are absence, never
 * evidence either way.
 */
export function setsEndWellShortOfFailure(run: PlateauRun): boolean {
  const rated = run.sessions.flatMap((s) => s.sets).filter((s) => s.rir != null);
  if (rated.length < SET_QUALITY_MIN_SETS) return false;
  const easy = rated.filter((s) => Number(s.rir) >= SET_QUALITY_RIR).length;
  return easy / rated.length > SET_QUALITY_SHARE;
}

// ---------- the ladder's memory ----------

const LINKED_DECISION = `d.source_ref_type = 'plan_proposal' AND d.source_ref_key = CAST(p.id AS TEXT)`;
const HELD_BY_USER = `EXISTS (SELECT 1 FROM brain_decisions d WHERE ${LINKED_DECISION}
  AND d.status = 'canceled' AND json_extract(d.context_json, '$.held_by_user') = 1)`;
// brain-decisions.ts USER_VETO_SQL, restated on the joined alias (an Undo, a rejection, a Hold).
const VETOED = `EXISTS (SELECT 1 FROM brain_decisions d WHERE ${LINKED_DECISION}
  AND (d.status IN ('rejected', 'reverted')
       OR (d.status = 'canceled' AND json_extract(d.context_json, '$.held_by_user') = 1)))`;

export interface LadderChangeRow {
  id: number;
  status: string;
  /** open: a draft; yes: landed (or routed) and standing; no: the athlete said no. */
  answer: "open" | "yes" | "no";
  unit_key: string;
  lever: string;
  lift: string;
  since: string | null;
  block_id: number | null;
  created: string;
}

/** Every ladder change that is open or answered, newest first. Throws when the read fails. */
export function ladderChangeRows(): LadderChangeRow[] {
  const rows = db
    .prepare(
      `SELECT p.id AS id, p.status AS status, p.parsed_json AS parsed_json, p.created_at AS created_at,
              ${HELD_BY_USER} AS held_by_user, ${VETOED} AS vetoed
         FROM plan_proposals p
        WHERE p.agent = ?
          AND (p.status IN ('draft', 'applied', 'discarded', 'rejected') OR (p.status = 'superseded' AND ${HELD_BY_USER}))
        ORDER BY p.id DESC LIMIT 120`
    )
    .all(UNIT_PLATEAU_AGENT) as any[];
  return rows.map((row) => {
    let parsed: any = null;
    try {
      parsed = row.parsed_json ? JSON.parse(String(row.parsed_json)) : null;
    } catch {
      parsed = null;
    }
    const status = String(row.status ?? "");
    const step = parsed?.unit_plateau ?? {};
    const answer: LadderChangeRow["answer"] =
      status === "draft"
        ? "open"
        : status === "discarded" || status === "rejected" || Number(row.held_by_user) === 1 || Number(row.vetoed) === 1
          ? "no"
          : "yes";
    return {
      id: Number(row.id),
      status,
      answer,
      unit_key: String(step.unit_key ?? ""),
      lever: String(step.lever ?? ""),
      lift: String(step.lift ?? ""),
      since: step.since ? String(step.since).slice(0, 10) : null,
      block_id: Number.isFinite(Number(step.block_id)) && step.block_id != null ? Number(step.block_id) : null,
      // The LOCAL day the change was written (created_at is a UTC stamp): the calendar
      // week and the plateau's dates are local days.
      created: localDayOfStamp(row.created_at) ?? String(row.created_at ?? "").slice(0, 10),
    };
  });
}

/**
 * Has a ladder change on this lever been ANSWERED (landed, or refused: discarded, held,
 * undone) inside this plateau? An open draft is not an answer: the lever stays the lever
 * while it waits, so its own premise keeps reading true.
 */
function leverTriedInPlateau(rows: readonly LadderChangeRow[], unitKey: string, lever: string, since: string): boolean {
  return rows.some(
    (r) => r.unit_key === unitKey && r.lever === lever && r.answer !== "open" && (r.since ?? r.created) >= since
  );
}

/** Did any ladder change land on, or get refused for, this unit inside this block? */
export function unitChangedInBlock(rows: readonly LadderChangeRow[], unitKey: string, blockId: number | null): boolean {
  if (blockId == null) return false;
  return rows.some((r) => r.unit_key === unitKey && r.block_id === blockId && r.answer !== "open");
}

// A volume step on the unit's primary group inside the plateau (landed, refused or open):
// the volume lever was tried.
function volumeStepTriedSince(group: string | null, since: string): boolean {
  if (!group) return false;
  const rows = db
    .prepare(`SELECT parsed_json, created_at FROM plan_proposals WHERE agent = ? ORDER BY id DESC LIMIT 60`)
    .all(VOLUME_STEP_AGENT) as any[];
  return rows.some((row) => {
    if ((localDayOfStamp(row.created_at) ?? String(row.created_at ?? "").slice(0, 10)) < since) return false;
    try {
      return String(JSON.parse(String(row.parsed_json ?? "null"))?.volume_step?.group ?? "") === group;
    } catch {
      return false;
    }
  });
}

// ---------- the block boundary ----------

/** The active block, and whether today sits on its boundary (its first week). */
export function blockBoundary(): UnitPlateauLadder["block"] {
  const block = getActiveBlock();
  if (!block) return null;
  return { id: block.id, week_index: block.week_index, boundary: block.week_index === 1 };
}

// ---------- the variation candidate ----------

function hasRecentHistory(name: string, date: string): boolean {
  const ids = progressionLineageIds(name);
  if (!ids.length) return false;
  const from = addDaysISO(date, -VARIATION_HISTORY_DAYS) ?? date;
  const inIds = ids.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM logged_sets ls JOIN sessions s ON s.id = ls.session_id
        WHERE ls.exercise_id IN (${inIds}) AND s.date BETWEEN ? AND ? LIMIT 1`
    )
    .get(...ids, from, date) as any;
  return !!row;
}

/**
 * The variant to rotate in for `lift`, inside the same unit: from the curated alternatives
 * (exercise-variations.ts), never the lift itself or anything already on the plan, the
 * athlete's equipment first, then one he has history on, then the curated order. A
 * candidate whose stored lift carries pain or an injury is skipped. Null when none fits.
 */
export function variationCandidate(
  lift: PlateauPlanLift,
  unitKey: string,
  date: string,
  touches: (name: string, group: string | null) => boolean
): { exercise: string; why: string } | null {
  const planIds = new Set<number>();
  const planNames: string[] = [];
  for (const day of getPlan() as any[]) {
    for (const item of strengthItems(day)) {
      planNames.push(String(item.exercise));
      const id = resolveExerciseName(String(item.exercise)).exercise_id;
      if (id != null) planIds.add(Number(id));
    }
  }
  const ownId = resolveExerciseName(lift.exercise).exercise_id;
  const equipment = safe(() => availableEquipment(), []);
  const pattern = classifyPattern(lift.exercise, lift.muscle_group ?? undefined);
  if (!pattern) return null;
  const options: Array<{ name: string; why: string; equipment: Equipment }> = suggestAlternatives(lift.exercise, {
    limit: 40,
    ...(equipment.length ? { availableEquipment: equipment } : {}),
    excludeNames: planNames,
  }).map((v) => ({ name: v.name, why: v.why, equipment: v.equipment }));
  // ...and the lifts of this unit he has trained lately, which the curated table may not name.
  const from = addDaysISO(date, -VARIATION_HISTORY_DAYS) ?? date;
  const trained = db
    .prepare(
      `SELECT DISTINCT e.name AS name FROM logged_sets ls
         JOIN sessions s ON s.id = ls.session_id JOIN exercises e ON e.id = ls.exercise_id
        WHERE s.date BETWEEN ? AND ? AND COALESCE(e.mode, 'reps') <> 'timed'`
    )
    .all(from, date) as any[];
  for (const row of trained) {
    const name = String(row.name ?? "");
    if (name) options.push({ name, why: "A variation you have trained before.", equipment: inferEquipment(name) });
  }
  const ranked: Array<{ exercise: string; why: string; available: number; history: number; order: number }> = [];
  const seen = new Set<string>();
  options.forEach((option, order) => {
    const resolved = resolveExerciseName(option.name);
    const stored = resolved.exercise_id != null ? resolved.canonical : option.name;
    const id = resolved.exercise_id;
    if (id != null && (id === ownId || planIds.has(Number(id)))) return;
    const key = resolved.key || stored.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const unit = capabilityUnitOf(stored, lift.muscle_group);
    if (!unit || unit.key !== unitKey) return;
    if (touches(stored, lift.muscle_group)) return;
    ranked.push({
      exercise: stored,
      why: option.why,
      available: equipment.length && !equipment.includes(option.equipment) ? 1 : 0,
      history: hasRecentHistory(stored, date) ? 0 : 1,
      order,
    });
  });
  ranked.sort((a, b) => a.available - b.available || a.history - b.history || a.order - b.order);
  const pick = ranked[0];
  return pick ? { exercise: pick.exercise, why: pick.why } : null;
}

// ---------- protective reads ----------

/** Pain reported in words, the pain band, an open injury, or a dated plan adaptation on the lift. Throws on a failed read. */
export function liftProtectedOn(date: string): (name: string, group: string | null) => boolean {
  const injuries = (listContextEvents({ activeOnly: true, on: date }) as any[]).filter((e) => e?.kind === "injury");
  const adapted = activePlanAdaptations(date).map((a) => resolveExerciseName(String(a.exercise ?? "")).exercise_id);
  return (name, group) => {
    if (activeRelevantTrainingSymptoms(date, { name, muscle_group: group }, { seed_legacy: false }).length > 0)
      return true;
    const id = resolveExerciseName(name).exercise_id;
    if (painBandForMovement({ id: id ?? null, name, muscle_group: group }, date) != null) return true;
    if (injuries.some((injury) => injuryAffectsExercise(injury, { name, muscle_group: group }))) return true;
    return id != null && adapted.some((a) => a != null && Number(a) === Number(id));
  };
}

// ---------- the words ----------

const phrase = (unit: CapabilityUnit) => unit.label.toLowerCase();

const REASONS: Readonly<Record<PlateauCode, (p: string, extra?: string) => string>> = {
  climbing: (p) => `Your ${p} work is still moving up, so nothing needs changing.`,
  not_enough: (p) => `There are not enough comparable ${p} sessions yet to call a plateau.`,
  slipping: (p, why) =>
    `Your ${p} strength has eased lately; ${why ?? "that usually traces to recovery, fuel or other training load"}, so the lifting stays as it is for now.`,
  cut: (p) => `Holding your ${p} strength through the cut is the goal right now, so nothing changes.`,
  run_build: (p) => `Your legs are carrying the run build, so a steady ${p} is right on track.`,
  recovery: (p) => `A lighter week is running, so your ${p} work is left as it is.`,
  too_young: (p) => `Your ${p} work has only held for a short while; it gets a few more weeks before anything changes.`,
  fresh_prescription: (p) => `Your ${p} work was set up recently, so it gets time to settle first.`,
  engine_moving: (p) => `Your ${p} work already has its next step lined up.`,
  pain: (p) => `Your ${p} work is being kept gentle around what you reported, so the plateau can wait.`,
  timed: (p) => `Your ${p} work is a timed hold, which progresses by time, not by this ladder.`,
  unavailable: (p) => `Your ${p} work could not be read clearly today, so nothing changes.`,
  rep_scheme: (p) =>
    `Your ${p} work has held one weight and one rep count for weeks; the next lever is a higher rep range at the same weight.`,
  set_quality: (p) =>
    `Your ${p} sets have been ending with plenty left in the tank; taking them a little closer to failure is the next lever, not more sets.`,
  volume: (p, group) =>
    `Your ${p} work has stalled while your ${group ?? "muscle"} sits under its usual weekly work, so one more set is the next lever.`,
  variation: (p, to) =>
    `Your ${p} work has stalled through the other levers; rotating in ${to ?? "a close variation"} is the next lever.`,
  next_block: (p) => `Your ${p} work has stalled; a change of variation waits for the start of the next block.`,
  block_used: (p) => `Your ${p} work already had its one change for this block.`,
  no_candidate: (p) => `Your ${p} work has stalled, and no close variation fits your setup right now.`,
};

function slipWhy(unit: CapabilityUnit): string | undefined {
  if (unit.qualifiers.includes("recovery")) return "a lighter week is running";
  if (unit.qualifiers.includes("run_build")) return "your legs are carrying the run build";
  if (unit.qualifiers.includes("cut")) return "the cut is taking its share";
  return undefined;
}

// ---------- one unit ----------

export interface LadderContext {
  date: string;
  capability: StrengthCapabilityRead;
  block: UnitPlateauLadder["block"];
  rows: LadderChangeRow[];
  touches: (name: string, group: string | null) => boolean;
}

function rung(
  unit: CapabilityUnit,
  lift: PlateauPlanLift | null,
  lever: PlateauLever,
  code: PlateauCode,
  since: string | null,
  extra: { why?: string; rep_range?: UnitPlateauRung["rep_range"]; candidate?: UnitPlateauRung["candidate"] } = {}
): UnitPlateauRung {
  return {
    unit_key: unit.key,
    label: unit.label,
    compound: unit.compound,
    lever,
    code,
    reason: REASONS[code](phrase(unit), extra.why),
    since,
    plan_lift: lift,
    ...(extra.rep_range !== undefined ? { rep_range: extra.rep_range } : {}),
    ...(extra.candidate !== undefined ? { candidate: extra.candidate } : {}),
  };
}

// The progression engine is already moving this lift: a load step, a deload, a set step, or
// one of its own load-side escalations (a rep wave, its own rep-range move). Two answers do
// not count. A REP STEP ("hold the load, win a rep") changes nothing on the plan, and a
// matured plateau is the proof that the reps have not come for weeks — counting it would
// park every stalled lift below its range ceiling forever. And `vary` / `introduce` / a
// rotation escalation are suggestions that land only through a proposal: the ladder's own
// variation rung is the server's answer to the same plateau, at a block boundary.
function engineMoving(name: string, date: string): boolean {
  // Read as of the ladder's own date (a dated read never asks the engine about today).
  const p = nextPrescription(name, undefined, { date });
  if (!p) return false;
  if (p.rep_step === true) return false;
  return (
    p.action === "overload" ||
    p.action === "deload" ||
    p.set_step != null ||
    p.escalated === "rep_wave" ||
    p.escalated === "rep_range"
  );
}

/** One unit's rung, given its capability verdict, its plan lift and the shared reads. Reads that fail throw. */
export function unitLadderRung(unit: CapabilityUnit, lift: PlateauPlanLift, ctx: LadderContext): UnitPlateauRung {
  if (unit.verdict === "climbing") return rung(unit, lift, "none", "climbing", null);
  if (unit.verdict === "not_enough") return rung(unit, lift, "wait", "not_enough", null);
  if (unit.verdict === "slipping") return rung(unit, lift, "wait", "slipping", null, { why: slipWhy(unit) });
  // Holding. An explained hold waits.
  if (unit.qualifiers.includes("recovery")) return rung(unit, lift, "wait", "recovery", null);
  if (unit.qualifiers.includes("run_build")) return rung(unit, lift, "wait", "run_build", null);
  if (unit.qualifiers.includes("cut")) return rung(unit, lift, "wait", "cut", null);
  if (lift.mode === "timed") return rung(unit, lift, "wait", "timed", null);
  if (ctx.touches(lift.exercise, lift.muscle_group)) return rung(unit, lift, "wait", "pain", null);

  const run = plateauRunOf(plateauSessions(lift.exercise, ctx.date, lift.rep_low), ctx.date);
  if (!run || !plateauMatured(run)) return rung(unit, lift, "wait", "too_young", run?.since ?? null);
  const since = run.since;
  const authorship = slotAuthorship(
    planItemStamp(lift.plan_item_id),
    run.sessions[run.sessions.length - 1].date,
    ctx.date
  );
  if (authorship.fresh || authorship.untested) return rung(unit, lift, "wait", "fresh_prescription", since);
  if (engineMoving(lift.exercise, ctx.date)) return rung(unit, lift, "wait", "engine_moving", since);

  // 2. The rep range, at the held load (never on assisted work: its ladder is the assist).
  if (
    lift.rep_low != null &&
    lift.rep_high != null &&
    run.working >= 0 &&
    !leverTriedInPlateau(ctx.rows, unit.key, "rep_scheme", since) &&
    !repRangeMoveSpent(lift.exercise, lift.rep_low, since, ctx.date)
  ) {
    const moved = movedRepRangeFor(lift.rep_low, lift.rep_high, { compound: unit.compound });
    // The reps already reach within one of the new floor, as the engine's own move asks.
    if (moved && run.top_reps >= moved.rep_low - 1)
      return rung(unit, lift, "rep_scheme", "rep_scheme", since, { rep_range: moved });
  }
  // 3. Effort.
  if (setsEndWellShortOfFailure(run)) return rung(unit, lift, "set_quality", "set_quality", since);
  // 4. Volume, when the group sits under its productive band and no step was tried here.
  const group = primaryMuscleGroup(lift.exercise, lift.muscle_group);
  const muscle = group ? ctx.capability.muscles.find((m) => m.group === group) : null;
  if (
    muscle?.band === "low" &&
    !leverTriedInPlateau(ctx.rows, unit.key, "volume", since) &&
    !volumeStepTriedSince(group, since)
  )
    return rung(unit, lift, "volume", "volume", since, { why: group ?? undefined });
  // 5. Variation, at a block boundary, once per block.
  if (!ctx.block?.boundary) return rung(unit, lift, "wait", "next_block", since);
  if (
    unitChangedInBlock(ctx.rows, unit.key, ctx.block.id) ||
    leverTriedInPlateau(ctx.rows, unit.key, "variation", since)
  )
    return rung(unit, lift, "wait", "block_used", since);
  const candidate = variationCandidate(lift, unit.key, ctx.date, ctx.touches);
  if (!candidate) return rung(unit, lift, "wait", "no_candidate", since);
  return rung(unit, lift, "variation", "variation", since, { why: candidate.exercise, candidate });
}

// ---------- the read ----------

// THE LADDER'S RE-ENTRANCY GUARD. The ladder asks the progression engine whether it is
// already moving a plan lift (`engineMoving` -> nextPrescription), and the engine asks the
// ladder whether a `vary` / `introduce` suggestion on a plateaued lift is its to make
// (progression.ts `ladderDefersVariation`). Inside a ladder read the engine keeps its own
// suggestion (`engineMoving` ignores vary / introduce anyway), so the recursion stops at
// one level. Registered with the request memo: a value computed while the ladder was in
// flight is served back only while one is.
let ladderDepth = 0;
let ladderGuardReads = 0;
registerMemoGuard(() => ({ active: ladderDepth > 0, reads: ladderGuardReads }));

/** True while a ladder read is in flight (the engine's deferral asks this first). */
export function unitLadderInFlight(): boolean {
  ladderGuardReads++;
  return ladderDepth > 0;
}

export interface UnitPlateauLadderOpts {
  /**
   * An already-built capability read for this date. Program state's capability pass hands
   * its own in (a bare read would ask program state for the very state it is building),
   * and a surface composing the read with the ladder does too, so the read is taken once.
   */
  capability?: StrengthCapabilityRead;
}

function computeLadder(d: string, injected: StrengthCapabilityRead | undefined): UnitPlateauLadder {
  const none: UnitPlateauLadder = { available: false, date: d, block: null, units: [] };
  let ctx: LadderContext;
  let lifts: Map<string, PlateauPlanLift>;
  try {
    const capability = injected ?? capabilityRead(d);
    if (!capability.available) return none;
    lifts = planLiftsByUnit();
    ctx = { date: d, capability, block: blockBoundary(), rows: ladderChangeRows(), touches: liftProtectedOn(d) };
  } catch {
    return none;
  }
  const units: UnitPlateauRung[] = [];
  for (const unit of ctx.capability.units) {
    const lift = lifts.get(unit.key) ?? null;
    if (!unit.in_plan || !lift) continue;
    try {
      units.push(unitLadderRung(unit, lift, ctx));
    } catch {
      units.push(rung(unit, lift, "wait", "unavailable", null));
    }
  }
  return { available: true, date: d, block: ctx.block, units };
}

/**
 * For every movement unit on the plan, the next lever for its plateau (or why it waits).
 * Read-only and deterministic. `available:false` when the capability read or the plan
 * read failed; a unit whose own reads fail waits (`unavailable`). The bare form is
 * request-memoized, keyed the way the capability read is; an injected capability read is
 * an object the key cannot name, so it computes directly.
 */
export function unitPlateauLadder(date: string = localDateISO(), opts: UnitPlateauLadderOpts = {}): UnitPlateauLadder {
  const d = typeof date === "string" && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : localDateISO();
  ladderDepth++;
  try {
    if (opts.capability) return computeLadder(d, opts.capability);
    return requestMemo(
      `unit_plateau_ladder:${d}:${localDateISO()}:${currentTrainingDataVersion()}`,
      () => computeLadder(d, undefined),
      copyDeep
    );
  } catch {
    return { available: false, date: d, block: null, units: [] };
  } finally {
    ladderDepth--;
  }
}

/** The rung a lift sits under: its unit's, when the ladder covers that unit. Null otherwise. */
export function ladderRungForLift(
  ladder: UnitPlateauLadder | null | undefined,
  exercise: string,
  muscleGroup: string | null = null
): UnitPlateauRung | null {
  if (!ladder?.available || !Array.isArray(ladder.units) || !ladder.units.length) return null;
  const name = String(exercise ?? "");
  const resolved = resolveExerciseName(name);
  const unit = capabilityUnitOf(resolved.canonical || name, muscleGroup);
  if (!unit) return null;
  return ladder.units.find((u) => u.unit_key === unit.key) ?? null;
}

/** A rung as a capability unit's `next` (the contract the REST route and the MCP tool carry). */
export function rungAsNext(r: UnitPlateauRung): CapabilityUnitNext {
  return {
    lever: r.lever,
    reason: r.reason,
    plan_lift: r.plan_lift?.exercise ?? null,
    candidate: r.candidate?.exercise ?? null,
    ...(r.rep_range ? { rep_range: { ...r.rep_range } } : {}),
  };
}

/** One unit with a lever to pull, as the coach context carries it. Names and words only. */
export interface UnitPlateauCoachEntry {
  unit: string;
  /** A compound anchor (a movement pattern) rather than an isolation region. */
  compound: boolean;
  lever: PlateauLever;
  lift: string | null;
  since: string | null;
  reason: string;
  candidate?: string;
  rep_range?: { rep_low: number; rep_high: number };
}

/** The ladder for the coach: only the units with a lever to pull (never the climbing or the merely waiting). */
export function unitPlateauForCoach(
  date: string = localDateISO(),
  opts: UnitPlateauLadderOpts = {}
): UnitPlateauCoachEntry[] {
  const ladder = unitPlateauLadder(date, opts);
  if (!ladder.available) return [];
  return ladder.units
    .filter((u) => u.lever !== "none" && u.lever !== "wait")
    .map((u) => ({
      unit: u.label,
      compound: u.compound,
      lever: u.lever,
      lift: u.plan_lift?.exercise ?? null,
      since: u.since,
      reason: u.reason,
      ...(u.candidate ? { candidate: u.candidate.exercise } : {}),
      ...(u.rep_range ? { rep_range: { ...u.rep_range } } : {}),
    }));
}
