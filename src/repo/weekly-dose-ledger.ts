import { db } from "../db.js";
import { mondayOf } from "../lib/dates.js";
import { finite, round1 } from "../lib/numbers.js";
import { PLAN_ITEM_EFFECT_TIER, isPrepPlanItem, planItemEffectTier } from "../domain/training/plan-item-order.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { canonicalGroup, classifyMuscleGroup, normalizedExerciseKey } from "./exercise-canon.js";
import { effectiveVolumeByGroup, type VolumeSet } from "./exercise-variations.js";
import type { AcuteGateReading } from "./hybrid-load.js";
import type {
  DailyDecisionCandidate,
  DailyDecisionEnvelope,
  DailyDecisionKind,
  DailyDecisionSnapshot,
} from "./daily-decision.js";
import { getPlan } from "./plan.js";
import { type PlanQualityDay, plannedWeeklyGroupSets } from "./plan-quality.js";
import { calendarDayRead, strengthPlanDayOn, thisWeekPlanDayMap } from "./plan-selection.js";
import type { ProgramState } from "./program-state.js";
import type { Prescription } from "./progression.js";
import { addDaysISO } from "./shared.js";
import { supportWorkRead } from "./support-work.js";
import { readVolumeFloorContext } from "./volume-floor-context.js";
import { type VolumeFloorContext, weeklySetTargets } from "./volume-floor.js";

// The WEEKLY DOSE: how far each muscle group's week sits under its contextual floor
// (volume-floor.ts), counting what is already logged this Monday-first week plus what
// today and the rest of the week's lift days still plan — and, when a group would end
// the week short, which of TODAY's items may take one extra set toward it.
//
// Three reads, the same split as the rest of the daily decision:
//   - `weeklyDoseLedger` is the plain LEDGER. It reads the database and writes nothing,
//     so any surface (the coach context, a tool) can ask it the same question.
//   - `weeklyDoseSnapshot` is the GATHER half. It may read the database. Its result is
//     stamped onto the snapshot as `weekly_dose` ONLY when it has something to say, so
//     an ordinary morning fingerprints exactly as it did before this module existed.
//   - `weeklyDoseDecision` is the DECIDE half. It must stay a pure function of the
//     snapshot slice and its context (buildDailySessionDecision is pure), and its
//     result lands on the envelope as `dose` (spread only when present).
// The composition half, `applyWeeklyDose`, lives in composition-dose.ts.
//
// The log is the truth for what the week has done: `done` is effectiveVolumeByGroup over
// the sets logged Monday through yesterday — the ONE honest counter (warm-ups out,
// reps-in-reserve weighted, half credit for indirect work) — never a second tally, and
// never today's own sets, so the read stands still all day. What the week still PLANS
// is read the plan compiler's way (plannedWeeklyGroupSets), so the ledger and the plan
// quality warning can never disagree about the same week.
//
// Must never: change a load (target_weight/target_seconds), add to an untested slot
// (`Prescription.untested`), fill on a non-train day, a run day, a light or exempt week,
// or for a group the envelope excludes, reduces, holds saturated or reads deep.

export interface WeeklyDoseGap {
  group: string;
  // Working sets the week would still end under the group's floor. Never negative.
  short: number;
}

export interface WeeklyDoseEligibleItem {
  exercise: string;
  group: string;
  // The plan's own set count for the item. Composition fills only an item still
  // carrying exactly this many, so a card whose sets already moved (an agent's extra
  // set, a set step, a fill landed on an earlier pass) is never filled twice.
  sets: number;
}

// The snapshot slice (`DailyDecisionSnapshot.weekly_dose`). Fingerprinted: keep it
// compact, JSON-only, and stable for a given day's inputs. `eligible` is already in
// fill order (accessories before compounds, a weak link first, a moving lift first). The
// day's anchor and strength-range work (rep_low <= 5) are never eligible.
export interface WeeklyDoseSnapshot {
  gaps: WeeklyDoseGap[];
  eligible: WeeklyDoseEligibleItem[];
}

// Everything the gather half may want from gatherDailyDecisionSnapshot's own reads, so
// it never repeats an expensive one. Read-only.
export interface WeeklyDoseGatherContext {
  // 'training' when today composes a strength day; 'rest'/'run' when the calendar
  // puts no lifting here (the snapshot's plan.day_type).
  dayType: "training" | "rest" | "run";
  dayNumber: number | null;
  // Today's plan-day items exactly as the envelope will see them (recovery-cycle
  // overlay applied). Raw plan rows: exercise, muscle_group, sets, mode, kind, note…
  planItems: readonly any[];
  // planDayProgression(dayNumber): the raw prescriptions, carrying `untested`,
  // `action`, `fuel_protected`, `pain_protected`, `top_set`, `movement_response`.
  progression: readonly Prescription[];
  programState: ProgramState | null;
  // The acute gate per group (hybrid-load.acuteGates) — the one recovery question.
  muscleLoad: ReadonlyMap<string, AcuteGateReading>;
  // dayRead's kind for the date, and whether a recovery week is in force.
  readKind: string | null;
  recoveryWeek: boolean;
}

// ---------- the ledger ----------

export interface WeeklyDoseLedgerGroup {
  group: string;
  // The group's floor window (MUSCLE_LANDMARKS via weeklySetTargets).
  low: number;
  high: number;
  // Effective working sets logged Monday through yesterday.
  done: number;
  // Effective sets today's plan day carries, and what the week's later lift days plan.
  today_planned: number;
  later_planned: number;
  // What the week would still end under `low` if every planned set lands. Never negative.
  short: number;
}

export interface WeeklyDoseLedger {
  date: string;
  week_start: string;
  // False when no floor applies this week (intent, a light window) — `groups` is then empty.
  applies: boolean;
  exempt: VolumeFloorContext["exempt"];
  groups: WeeklyDoseLedgerGroup[];
}

function planItemsByDayNumber(): Map<number, readonly any[]> {
  const out = new Map<number, readonly any[]>();
  for (const day of getPlan() as any[]) {
    const n = Number(day?.day_number);
    if (Number.isFinite(n)) out.set(n, Array.isArray(day?.items) ? day.items : []);
  }
  return out;
}

/**
 * The week's per-group dose read for `date`: floor, logged, planned today and later, and
 * what would still fall short. A pure read (no writes). Null when the athlete has no
 * lifting week to measure against (no stated or observed lift weekdays) — a ledger is
 * about a week they described or lived — or when the floor context cannot be read.
 * `todayItems` lets the daily snapshot hand in today's items as the envelope sees them.
 */
export function weeklyDoseLedger(
  date: string,
  opts: { todayItems?: readonly any[]; floor?: VolumeFloorContext | null } = {}
): WeeklyDoseLedger | null {
  const d = String(date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const week = thisWeekPlanDayMap(d);
  if (!week.lift_dows.length) return null;
  const floor = opts.floor !== undefined ? opts.floor : readVolumeFloorContext(d);
  if (!floor) return null;
  const weekStart = mondayOf(d);
  const targets = weeklySetTargets(floor);
  if (!targets.length) return { date: d, week_start: weekStart, applies: false, exempt: floor.exempt, groups: [] };

  const rows = db
    .prepare(
      `SELECT s.date AS date, e.name AS exercise, e.muscle_group AS muscle_group,
              ls.weight AS weight, ls.reps AS reps, ls.rir AS rir
         FROM logged_sets ls
         JOIN sessions s ON s.id = ls.session_id
         JOIN exercises e ON e.id = ls.exercise_id
        WHERE s.date >= ? AND s.date < ?`
    )
    .all(weekStart, d) as any[];
  const done = effectiveVolumeByGroup(rows as VolumeSet[]);

  const byDay = planItemsByDayNumber();
  const todayItems =
    opts.todayItems ??
    (() => {
      const today = strengthPlanDayOn(d, { weekMap: week });
      return today ? (byDay.get(today.day_number) ?? []) : [];
    })();
  const laterDays: PlanQualityDay[] = [];
  for (let ahead = 1; ahead <= 6; ahead++) {
    const iso = addDaysISO(d, ahead);
    if (!iso || mondayOf(iso) !== weekStart) break;
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    if (!week.lift_dows.includes(dow)) continue;
    const planDay = week.map.get(dow);
    if (planDay) laterDays.push({ items: [...(byDay.get(planDay.day_number) ?? [])] });
  }
  const todayPlanned = plannedWeeklyGroupSets([{ items: [...todayItems] }]);
  const laterPlanned = plannedWeeklyGroupSets(laterDays);

  const groups = targets.map((t): WeeklyDoseLedgerGroup => {
    const g = t.group as any;
    const doneSets = done.get(g)?.sets ?? 0;
    const today = todayPlanned.get(g) ?? 0;
    const later = laterPlanned.get(g) ?? 0;
    return {
      group: t.group,
      low: t.low,
      high: t.high,
      done: round1(doneSets),
      today_planned: round1(today),
      later_planned: round1(later),
      short: round1(Math.max(0, t.low - doneSets - today - later)),
    };
  });
  return { date: d, week_start: weekStart, applies: true, exempt: floor.exempt, groups };
}

// ---------- the gather half ----------

// A gap worth a set. Half a set short is a real shortfall once rounding and half-credit
// indirect work are in the count; anything under it is noise in the arithmetic.
export const WEEKLY_DOSE_MIN_GAP = 0.5;

const LOWER_GROUPS = new Set(["quads", "hamstrings", "glutes", "calves"]);
// A moving lift takes the set first; a lift still building its baseline ("new") last.
const STATUS_RANK: Record<string, number> = { progressing: 0, maintaining: 1, plateaued: 2, new: 3 };

// A COMPOUND is primary-tier work (planItemEffectTier, which reads the movement region
// first, so a leg extension or a leg curl is an accessory here, never a squat or a
// hinge). A moderate-rep compound may still take a set, after every accessory.
function isCompoundItem(item: any): boolean {
  return planItemEffectTier(item) === PLAN_ITEM_EFFECT_TIER.primary;
}

// Strength-range work (a bottom of five reps or fewer) never takes an added set: for a
// hybrid athlete the extra dose belongs on accessories and moderate-rep work, never on
// the heavy sets that already cost the most. Same line the pairing module draws.
export const WEEKLY_DOSE_STRENGTH_REP_LOW = 5;

function isStrengthRange(item: any): boolean {
  const repLow = finite(item?.rep_low);
  return repLow != null && repLow <= WEEKLY_DOSE_STRENGTH_REP_LOW;
}

// The day's ANCHOR: its first primary-tier (compound) item, the same read the stress
// budget and the pairing pass use. It keeps its prescription as written.
function dayAnchorIndex(items: readonly any[]): number {
  return items.findIndex(
    (item) =>
      !!item &&
      String(item.kind ?? "strength").toLowerCase() !== "cardio" &&
      !isPrepPlanItem(item) &&
      isCompoundItem(item)
  );
}

function itemGroup(item: any): string | null {
  return canonicalGroup(item?.muscle_group ?? null) ?? classifyMuscleGroup(String(item?.exercise ?? ""));
}

// Is this raw prescription one a set may be added to? Tested, reps work, taking no
// other change today (one change at a time: no load step, no set step, no re-ground),
// and not protected, rotated, deloaded or peaking.
function prescriptionAllowsFill(p: Prescription | undefined, planSets: number): boolean {
  if (!p || p.mode !== "reps" || p.untested) return false;
  if (p.action === "deload" || p.action === "vary" || p.action === "introduce") return false;
  if (p.fuel_protected || p.pain_protected || p.autoregulated) return false;
  if (p.top_set || p.starting_idea || p.reground || p.set_step || p.escalated) return false;
  const planWeight = p.current?.weight ?? null;
  if ((p.suggested?.weight ?? null) !== planWeight) return false;
  if (finite(p.suggested?.sets) !== planSets) return false;
  return true;
}

/** Gather half. `undefined` = nothing to say (the key stays off the snapshot). */
export function weeklyDoseSnapshot(date: string, ctx: WeeklyDoseGatherContext): WeeklyDoseSnapshot | undefined {
  const d = String(date || "").slice(0, 10);
  if (ctx.dayType !== "training" || ctx.recoveryWeek) return undefined;
  if (ctx.readKind != null && ctx.readKind !== "train") return undefined;
  const items = Array.isArray(ctx.planItems) ? ctx.planItems : [];
  if (!items.length) return undefined;

  const progression = new Map<string, Prescription>();
  for (const p of Array.isArray(ctx.progression) ? ctx.progression : []) {
    progression.set(normalizedExerciseKey(String(p?.exercise ?? "")), p);
  }
  const liftStatus = new Map<string, string>();
  for (const lift of Array.isArray(ctx.programState?.lifts) ? ctx.programState.lifts : []) {
    liftStatus.set(normalizedExerciseKey(String(lift?.exercise ?? "")), String(lift?.status ?? ""));
  }

  // A key run on today's own calendar keeps the legs' extra work off the card.
  let keyRunToday = false;
  try {
    const cal = calendarDayRead(d);
    keyRunToday = cal?.run_kind === "quality" || cal?.run_kind === "long";
  } catch {
    keyRunToday = false;
  }

  // Cheap per-item eligibility first, so an ordinary card never pays for the ledger.
  type Pre = WeeklyDoseEligibleItem & { index: number; compound: boolean; status: number };
  const pre: Pre[] = [];
  const anchorIndex = dayAnchorIndex(items);
  items.forEach((item, index) => {
    if (!item || String(item.kind ?? "strength").toLowerCase() === "cardio") return;
    if (String(item.mode ?? "reps").toLowerCase() === "timed" || item.target_seconds != null) return;
    if (isPrepPlanItem(item)) return;
    // Never the day's anchor, never strength-range work: accessories and moderate reps only.
    if (index === anchorIndex || isStrengthRange(item)) return;
    const exercise = String(item.exercise ?? "").trim();
    const group = itemGroup(item);
    const sets = finite(item.sets);
    if (!exercise || !group || sets == null || sets < 1) return;
    if (keyRunToday && LOWER_GROUPS.has(group)) return;
    if (ctx.muscleLoad.get(group)?.saturated) return;
    const key = normalizedExerciseKey(exercise);
    if (!prescriptionAllowsFill(progression.get(key), sets)) return;
    const status = liftStatus.get(key) ?? "";
    if (status === "regressing") return;
    pre.push({
      exercise,
      group,
      sets,
      index,
      compound: isCompoundItem(item),
      status: STATUS_RANK[status] ?? 4,
    });
  });
  if (!pre.length) return undefined;

  const ledger = weeklyDoseLedger(d, { todayItems: items });
  if (!ledger?.applies) return undefined;
  const gaps = ledger.groups
    .filter((g) => g.short >= WEEKLY_DOSE_MIN_GAP)
    .map((g): WeeklyDoseGap => ({ group: g.group, short: g.short }));
  const gapGroups = new Set(gaps.map((g) => g.group));
  const candidates = pre.filter((p) => gapGroups.has(p.group));
  if (!candidates.length) return undefined;

  // A group the lagging-lift read names as a weak link goes first among peers.
  const weakLinks = new Set<string>();
  try {
    for (const entry of supportWorkRead(d, { programState: ctx.programState ?? undefined })) {
      for (const link of entry.weak_links ?? []) weakLinks.add(String(link.muscle_group));
    }
  } catch {
    /* no weak-link read → plain order */
  }
  candidates.sort(
    (a, b) =>
      Number(a.compound) - Number(b.compound) ||
      Number(weakLinks.has(b.group)) - Number(weakLinks.has(a.group)) ||
      a.status - b.status ||
      a.index - b.index
  );
  return {
    gaps,
    eligible: candidates.map(({ exercise, group, sets }) => ({ exercise, group, sets })),
  };
}

// ---------- the decide half ----------

// The envelope's `dose` field: the gaps the day was read against, and the fills it
// authorizes — at most one extra working set per item.
export interface DailyDecisionDose {
  gaps: WeeklyDoseGap[];
  // `sets` is the plan's own count the fill sits on (see WeeklyDoseEligibleItem).
  fills: Array<{ exercise: string; group: string; add_sets: 1; sets: number }>;
}

// The decide half's inputs: the day's own verdict, as buildDailySessionDecision has
// already resolved it by the time the dose is asked. Read-only.
export interface WeeklyDoseDecisionContext {
  date: string;
  kind: DailyDecisionKind;
  // The snapshot's plan.day_type; 'run' / 'rest' days carry no lifting card.
  dayType: "training" | "rest" | "run";
  // A stated run day without train-anyway (the card carries no lifting).
  runDay: boolean;
  trainAnyway: boolean;
  caps: DailyDecisionEnvelope["caps"];
  // The envelope's muscle view: excluded, reduced, saturated, deep, week_held.
  muscles: DailyDecisionEnvelope["muscles"];
  // Final candidates (actions after every hold/deload/exclude/equipment pass). A
  // candidate with `top_set` is already carrying the day's heavy single.
  candidates: readonly DailyDecisionCandidate[];
  recoveryWeek: boolean;
  mesocyclePhase: string | null;
  // The whole snapshot, for anything else the rule needs. Never mutate it.
  snapshot: DailyDecisionSnapshot;
}

export interface WeeklyDoseDecision {
  dose: DailyDecisionDose | null;
  // Machine-register detail for soft_preferences under `weekly_dose_fill`.
  soft: string | null;
  // Athlete-facing line for the rationale (pickDayVariant, violatesReadingGrammar-clean).
  rationale: string | null;
}

// At most one extra set per item (the fill shape) and two per day.
export const WEEKLY_DOSE_MAX_FILLS_PER_DAY = 2;

// The rationale line when the day carries a fill. Calm, no numbers, no gate; a
// variant set because a steady week can fill on the same weekday for weeks running.
export const WEEKLY_DOSE_RATIONALE: readonly [string, ...string[]] = [
  "The week has come up a little short, so today adds a set where it fits.",
  "Today carries an added set where the week needs it — no heavier, just a little more work.",
  "A little extra work lands today so the week's training stays where it needs to be.",
  "The week is running light in a spot or two, so today's card picks up the slack with an added set.",
];

const EMPTY: WeeklyDoseDecision = { dose: null, soft: null, rationale: null };

// Does today's verdict on this lift leave it free to take a set? Its own progression
// hold, a carry, or a rep step (load unchanged) — never a protective hold, a deload, a
// rotation, an exclusion, a peak single, a stand-in, or a set count already moving.
function candidateAllowsFill(candidate: DailyDecisionCandidate | undefined, planSets: number): boolean {
  if (!candidate || candidate.substitution_for || candidate.top_set) return false;
  const authorized = candidate.authorized_target ?? null;
  if (authorized?.sets != null && authorized.sets !== planSets) return false;
  if (candidate.action === "carry") return candidate.reason_code == null;
  if (candidate.action === "hold") return candidate.reason_code === "progression_hold";
  if (candidate.action === "overload") {
    if (candidate.reason_code !== "progression_overload") return false;
    const current = candidate.current_target ?? null;
    return !!authorized && !!current && (authorized.target_weight ?? null) === (current.target_weight ?? null);
  }
  return false;
}

/**
 * The machine-register soft line for a set of fills (`soft_preferences` under
 * `weekly_dose_fill`). One writer, so composition can re-say it for only the fills that
 * landed on the card (daily-composition.ts `reconcileEnvelopeDose`).
 */
export function weeklyDoseSoftLine(fills: ReadonlyArray<{ exercise: string; group: string }>): string {
  const filledGroups = new Set(fills.map((f) => f.group));
  return `The week would end short on ${[...filledGroups].join(" and ")}; one extra working set on ${fills
    .map((f) => f.exercise)
    .join(" and ")}, load unchanged.`;
}

/** Decide half. Pure. Nothing to fill → `{ dose: null, soft: null, rationale: null }`. */
export function weeklyDoseDecision(
  snapshot: WeeklyDoseSnapshot | undefined,
  ctx: WeeklyDoseDecisionContext
): WeeklyDoseDecision {
  if (!snapshot || !Array.isArray(snapshot.gaps) || !Array.isArray(snapshot.eligible)) return EMPTY;
  if (ctx.kind !== "train" || ctx.dayType !== "training" || ctx.runDay || ctx.trainAnyway) return EMPTY;
  if (ctx.caps.volume !== "normal" || ctx.caps.intensity !== "normal") return EMPTY;
  if (ctx.recoveryWeek || ctx.snapshot?.day_read?.recovery_week) return EMPTY;
  if (ctx.mesocyclePhase === "deload" || ctx.mesocyclePhase === "deload-due") return EMPTY;
  if (ctx.snapshot?.recovery_cycle) return EMPTY;

  const norm = (g: unknown) => canonicalGroup(String(g ?? "")) ?? String(g ?? "").toLowerCase();
  const blocked = new Set<string>(
    [
      ...(ctx.muscles.excluded ?? []),
      ...(ctx.muscles.reduced ?? []),
      ...(ctx.muscles.saturated ?? []),
      ...(ctx.muscles.deep ?? []),
      ...(ctx.muscles.week_held ?? []),
      ...(ctx.snapshot?.muscle_load ?? []).filter((m) => m.saturated).map((m) => m.group),
    ].map(norm)
  );
  const room = new Map<string, number>();
  for (const gap of snapshot.gaps) {
    const short = finite(gap.short) ?? 0;
    if (short >= WEEKLY_DOSE_MIN_GAP) room.set(norm(gap.group), Math.ceil(short - 1e-9));
  }
  const candidates = new Map(ctx.candidates.map((c) => [String(c.exercise).toLowerCase(), c]));

  const fills: DailyDecisionDose["fills"] = [];
  const seen = new Set<string>();
  for (const item of snapshot.eligible) {
    if (fills.length >= WEEKLY_DOSE_MAX_FILLS_PER_DAY) break;
    const group = norm(item.group);
    const key = String(item.exercise).toLowerCase();
    if (seen.has(key) || blocked.has(group)) continue;
    const left = room.get(group) ?? 0;
    if (left <= 0) continue;
    const sets = finite(item.sets);
    if (sets == null || sets < 1) continue;
    if (!candidateAllowsFill(candidates.get(key), sets)) continue;
    fills.push({ exercise: item.exercise, group, add_sets: 1, sets });
    room.set(group, left - 1);
    seen.add(key);
  }
  if (!fills.length) return EMPTY;
  const soft = weeklyDoseSoftLine(fills);
  return {
    dose: {
      gaps: snapshot.gaps.map((g) => ({ group: norm(g.group), short: finite(g.short) ?? 0 })),
      fills,
    },
    soft,
    rationale: pickDayVariant(WEEKLY_DOSE_RATIONALE, ctx.date, "weekly-dose:rationale"),
  };
}
