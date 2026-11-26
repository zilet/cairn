import { PLAN_ITEM_EFFECT_TIER, planItemEffectTier } from "../domain/training/plan-item-order.js";
import { runPlacement } from "../domain/training/week-layout.js";
import { addDaysISO, mondayOf } from "../lib/dates.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import type { DailyDecisionKind, DailyDecisionReason, DailyDecisionSnapshot } from "./daily-decision.js";
import { canonicalGroup, classifyMuscleGroup } from "./exercise-canon.js";
import {
  fullLoadLowerSessionThisWeek,
  isHeavyLowerPlanDay,
  isLowerMainLift,
  strengthPlanDayOn,
  weeklyLowerExposure,
} from "./plan-selection.js";
import { dowToDayNumber, getEnduranceGoal, isoDow } from "./profile.js";
import { raceBuild } from "./race-build.js";
import { raceRecoveryWindow, weekdayShort } from "./race-recovery.js";
import { runDaySteerKey } from "./run-day-steer.js";
import { type WeeklyRunPlan, weeklyRunPlan } from "./run-progression.js";
import { localDateISO } from "./shared.js";
import { weekLayoutClosed } from "./week-layout-closed.js";
import { coachContextBackstopSignature, registerTrainingCacheClear } from "./training-cache.js";
import type { EnduranceRole } from "./training-intent.js";

// The WEEK'S STRESS BUDGET for the legs: one budget across running and lifting for a
// hybrid athlete building to a dated race. What the race build's taper and race week,
// and the eve of a placed key run, ask of today's lower-body lifting. It speaks through
// the envelope's existing muscle lists — a group it names is REDUCED or EXCLUDED — so
// composition needs nothing new. REDUCED is composition's existing reduced-area clamp,
// reused exactly as it is (daily-composition.ts `REDUCED_ITEM_SET_CAP` = 2 working sets
// per item, `REDUCED_INTENSITY_FACTOR` = 0.9 on the target load or seconds) — except
// that the key-run eve holds LOAD (`load_held`): its groups lose sets only, keep the
// prescribed weight and still never host the reach. A slot trimmed before every long run
// has to be trained at its prescription some time, or it is never tested. Either way it
// is a clamp on TODAY'S card inside the day's safety bounds, never a write to the stored
// prescription, so the "composition never moves the prescription" law holds.
//
// The rules, in precedence order (the first that applies is the only one that speaks):
//   1. TAPER week (raceBuild's current week kind `taper`): every lower-body group on
//      today's card is reduced — the legs keep their lifts at a lighter dose; upper-body
//      work is untouched. Code `race_taper_legs`.
//   2. RACE week (kind `race`): the heavy leg groups (quads, hamstrings, glutes) are
//      excluded; calves and core are reduced; upper-body work is untouched. Code
//      `race_week_legs`.
//   3. The EVE OF A KEY RUN (code `key_run_eve`): today is the last lift day before a
//      placed quality or long run that lands at most two days out (≤48h), with no lift
//      day in between — tomorrow's run, or the day after tomorrow's when tomorrow holds
//      no lifting. "Placed" is the run engine's week (weeklyRunPlan read through
//      week-layout's `runPlacement`), never the raw stated schedule, which may name two
//      long-run days — and a placed run already RUN this week has no eve left. It
//      applies only while the race build is active (a build, reset or peak week
//      outside the base phase). Every lower item on the card EXCEPT the
//      day's anchor lift itself is trimmed — item-scoped, not group-scoped: on Lower A
//      the squat stays as written while the RDL, leg extension, leg curl and calf raise
//      take the trim, the leg extension included although it shares the squat's group.
//      The groups those items train are reduced, and the anchor is named on the
//      envelope (`hold_exercise`) so the reduced-area clamp and the progression hold
//      pass over it. Only in SETS: the load holds (`load_held`, unless another rule also
//      reduced the group, which then takes the full clamp — anchor included). It
//      never fires on a day the weekly lower guarantee holds (`lowerWeekHolds`, owner
//      ruling 2026-09-23: the week's one full leg session keeps its sets and load), never
//      touches a group that guarantee holds, stands down when `lowerSafetyFloor` already
//      governs the legs, and stands down when the endurance-led key-run protect in
//      daily-decision already lightens every lower group for the same run. It also
//      stands down when the athlete asked for today's session as it is
//      (`request.same_day_request`).
//   3b. THE STANDING EVE (no race build running — no dated race, no build available, or
//      the build's base phase): the same eve, tighter. Tomorrow's placed quality or long
//      run only (STANDING_EVE_MAX_DAYS = 1), and only lower ACCESSORY items (isolation /
//      core tier: leg extension, leg curl, calf raise). ITEM-scoped: the decision names
//      the items it trims (`trim_exercises`), so a leg curl loses its set while the RDL
//      in the same group stays whole. ONE set off each (daily-composition.ts
//      `standingEveSetCap`: max(floor, sets − 1)), load held, the anchor named. Every
//      stand-down above applies. For a strength-led athlete this, rule 3 and the
//      taper/race/post-race rules are the ONLY lifting changes the run calendar makes.
//   The WEEKLY HEAVY LOWER ANCHOR guard (WEEKLY_HEAVY_LOWER_ANCHOR_MIN = 1, guard code
//      `weekly_heavy_anchor_kept`) sits inside both eves: when today is the week's last
//      chance at a heavy lower exposure (`heavy_lower_last`: no genuinely loaded lower
//      session landed earlier this week, no later heavy-lower day laid), every group
//      holding a squat/hinge main lift the trim would reach keeps its sets. The weekly
//      lower guarantee in daily-decision (`lowerWeekHolds`) already stands the whole eve
//      down on such a day when the lifting week is known; the guard keeps the budget's
//      own decision safe where that read is absent.
//   4. No day-after-a-hard-run rule: the acute gate (hybrid-load.ts `acuteGate`) is the
//      one recovery question and already answers it.
//
// The week-kind read is raceBuild's, never a second race-phase read. An athlete whose
// endurance role is `none` gets nothing here; anyone without a dated race gets only the
// standing eve (rule 3b).
// These leg trims are the ONLY strength change a race build makes for a strength-led
// athlete — the phase's strength principle itself (progression vs maintenance) has one
// source, race-strength.ts, and for a strength-led athlete the upper body keeps
// progressing through the taper and race week. The trims apply to both leads.
//
// Two halves, the same split as the rest of the daily decision:
//   - `stressBudgetSnapshot` is the GATHER half. It may read the database (raceBuild,
//     the run placement). Its result is stamped onto the snapshot as `stress_budget`
//     ONLY when it has something to say, so an ordinary morning fingerprints exactly as
//     before.
//   - `stressBudgetDecision` is the DECIDE half, called inside buildDailySessionDecision
//     once the weekly-lower guarantee is resolved. It stays pure.
//
// Taper and race week also SUSPEND the weekly lower guarantee
// (`stressBudgetSuspendsWeeklyLower`): "heavy lower once a week" is the build's law, and
// the race build's own law for those two weeks is light legs, then legs off.
//
// 0. THE DAYS AFTER THE RACE (code `post_race_recovery`, ahead of every rule above):
//    inside the post-race recovery window (race-recovery.ts `raceRecoveryWindow`, the
//    one read — 2 / 4 / 7 days by distance) EVERY group on today's card is reduced, the
//    upper body included: the athlete keeps training, at lower volume and not so heavy
//    (fewer sets, the eased load, a hold rather than a step, never a reach host). Legs
//    stay ON the card — nothing is excluded. It also stands the weekly lower guarantee
//    down, as taper and race week do. It applies whatever the endurance role: the race
//    was run either way.
//
// Must never: touch the anchor lift itself on a key-run eve, change a load or a set count
// directly (that is composition's, via the muscle lists), or touch upper-body groups
// outside the post-race window.

export type StressBudgetReason = Extract<
  DailyDecisionReason,
  "key_run_eve" | "race_taper_legs" | "race_week_legs" | "post_race_recovery"
>;

// Every lower-body group the budget speaks for (daily-decision's LOWER_BODY_GROUPS).
const LOWER_GROUPS: ReadonlySet<string> = new Set(["quads", "hamstrings", "glutes", "calves"]);
// Race week: these sit out; the rest of the lower list and core go light.
const RACE_WEEK_EXCLUDED: ReadonlySet<string> = new Set(["quads", "hamstrings", "glutes"]);
const RACE_WEEK_REDUCED: ReadonlySet<string> = new Set(["calves", "core"]);
// The race-build week kinds / phases in which a key run is protected on its eve.
const EVE_WEEK_KINDS: ReadonlySet<string> = new Set(["build", "down", "peak"]);
const EVE_PHASES: ReadonlySet<string> = new Set(["build", "sharpen", "taper"]);
// How far ahead a key run may land for today to be its eve: inside a race build, up to
// two days when tomorrow holds no lifting; outside one (the standing eve), the next day
// only — the 24 h before a quality or long run, the window the concurrent-training
// evidence speaks to (interference is driven by proximity and volume).
export const KEY_RUN_EVE_MAX_DAYS = 2;
export const STANDING_EVE_MAX_DAYS = 1;
// The weekly heavy lower anchor: at least this many squat/hinge sessions a week keep
// their full prescribed load and set count whatever the eve asks (one heavy exposure a
// week maintains maximal strength when intensity is kept). The eve's guard code.
export const WEEKLY_HEAVY_LOWER_ANCHOR_MIN = 1;
export const WEEKLY_HEAVY_ANCHOR_KEPT = "weekly_heavy_anchor_kept";

// The snapshot slice (`DailyDecisionSnapshot.stress_budget`). Fingerprinted: keep it
// compact, JSON-only, and stable for a given day's inputs.
export interface StressBudgetSnapshot {
  // raceBuild(date): the current week's kind and phase, and the days left to the race.
  race_week_kind?: string;
  race_phase?: string;
  days_to_race?: number;
  // The next PLACED key run when today is the last lift day before it (≤ two days out
  // inside a race build; tomorrow only outside one — no `race_week_kind` on the slice).
  key_run?: { kind: "quality" | "long"; in_days: 1 | 2 };
  // Beside `key_run` only: today is the week's last chance at a heavy lower anchor
  // exposure (none landed earlier this week, no later heavy-lower day laid) — the eve
  // passes over every squat/hinge main lift and its group (WEEKLY_HEAVY_LOWER_ANCHOR_MIN).
  heavy_lower_last?: true;
  // Inside the post-race recovery window (race-recovery.ts): the day of it, its length
  // and the first ordinary day again. When present, nothing else is on the slice.
  race_recovery?: { day_index: number; days: number; back_on: string; event: string | null };
}

export interface StressBudgetGatherContext {
  dayType: "training" | "rest" | "run";
  // Today's plan-day items as the envelope will see them (recovery overlay applied).
  planItems: readonly any[];
  enduranceRole: EnduranceRole;
}

function itemGroup(it: any): string | null {
  if (String(it?.kind ?? "").toLowerCase() === "cardio") return null;
  const group = canonicalGroup(it?.muscle_group ?? null) ?? classifyMuscleGroup(String(it?.exercise ?? ""));
  return group ? String(group).toLowerCase() : null;
}

// Where the week puts its key runs (Mon = 1 … Sun = 7), as planned — never this
// morning's re-decision of today's run.
function placedKeyRunOn(dateISO: string, plan: WeeklyRunPlan | null): "quality" | "long" | null {
  if (!plan) return null;
  const placement = runPlacement({ runPlan: plan });
  const day = dowToDayNumber(isoDow(dateISO));
  if (placement.long === day) return "long";
  if (placement.quality === day) return "quality";
  return null;
}

function safeRead<T>(fn: () => T): T | null {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

// The race read below (the race build, the week's run plan, tomorrow's lifting) is the
// expensive half of the gather — a whole weeklyRunPlan plus raceBuild on every lower-day
// gather while a race is on file — and it is a pure function of the date, whether the
// card carries legs, and the stored state. So it is memoized on the same key shape the
// day read uses: the date, the real today and the run-day steer (the run plan reads
// both), and the coach-context backstop signature (training-cache.ts), which sees every
// insert, delete and in-place update to the tables these reads touch, plus profile and
// settings by value. A few slots, not one: the look-ahead asks tomorrow between two of
// today's reads. Cleared with every other training memo (the test isolate included).
const STRESS_READ_MEMO_SLOTS = 8;
const stressReadCache = new Map<string, StressBudgetSnapshot | undefined>();
registerTrainingCacheClear(() => {
  stressReadCache.clear();
});

/** Gather half. `undefined` = nothing to say (the key stays off the snapshot). */
export function stressBudgetSnapshot(date: string, ctx: StressBudgetGatherContext): StressBudgetSnapshot | undefined {
  const groups = new Set(
    (Array.isArray(ctx.planItems) ? ctx.planItems : []).map(itemGroup).filter((g): g is string => g != null)
  );
  // The days after the race come first, for every role and every group on the card.
  if (groups.size) {
    const recovery = safeRead(() => raceRecoveryWindow(date));
    if (recovery) {
      return {
        race_recovery: {
          day_index: recovery.day_index,
          days: recovery.days,
          back_on: recovery.back_on,
          event: recovery.race.event,
        },
      };
    }
  }
  if (ctx.enduranceRole === "none") return undefined;
  const lowerOnCard = [...groups].some((g) => LOWER_GROUPS.has(g));
  if (!lowerOnCard && !groups.has("core")) return undefined;
  // A squat/hinge main lift on the card: only then can the weekly anchor guard matter.
  const lowerMainOnCard = (Array.isArray(ctx.planItems) ? ctx.planItems : []).some((it) => {
    const group = itemGroup(it);
    return group != null && isLowerMainLift(String(it?.exercise ?? ""), group);
  });
  const key = [
    date,
    lowerOnCard ? "legs" : "core",
    lowerMainOnCard ? "main" : "-",
    localDateISO(),
    runDaySteerKey(),
    coachContextBackstopSignature(),
  ].join("|");
  if (stressReadCache.has(key)) {
    const hit = stressReadCache.get(key);
    return hit ? structuredClone(hit) : undefined;
  }
  const value = stressRaceRead(date, lowerOnCard, lowerMainOnCard);
  if (stressReadCache.size >= STRESS_READ_MEMO_SLOTS) {
    const oldest = stressReadCache.keys().next().value;
    if (oldest !== undefined) stressReadCache.delete(oldest);
  }
  stressReadCache.set(key, value ? structuredClone(value) : undefined);
  return value;
}

function stressRaceRead(date: string, lowerOnCard: boolean, lowerMainOnCard: boolean): StressBudgetSnapshot | undefined {
  // The race read is only asked with a dated race; without one (or before the build
  // proper, in its base phase) the STANDING eve below is the only rule that can speak.
  const goal = safeRead(() => getEnduranceGoal(date));
  if (!lowerOnCard && !(goal?.is_race && goal.date)) return undefined;
  const weekPlan = safeRead(() => weeklyRunPlan(date, { adjustToday: false }));
  if (goal?.is_race && goal.date) {
    const build = safeRead(() => raceBuild(date, { runPlan: weekPlan, weekLayout: null, templateRing: true }));
    const week = build?.available && build.race ? (build.weeks.find((w) => w.current) ?? null) : null;
    if (build?.race && week) {
      const base = { race_week_kind: week.kind, race_phase: week.phase, days_to_race: build.race.days_to_race };
      if (week.kind === "taper") return lowerOnCard ? base : undefined;
      if (week.kind === "race") return base;
      if (EVE_WEEK_KINDS.has(week.kind) && EVE_PHASES.has(week.phase)) {
        if (!lowerOnCard) return undefined;
        const eve = keyRunEveRead(date, weekPlan, KEY_RUN_EVE_MAX_DAYS);
        return eve ? { ...base, key_run: eve, ...heavyLowerGuard(date, lowerMainOnCard) } : undefined;
      }
    }
  }
  // ---- the STANDING eve: no race build running ----
  // Next day only (STANDING_EVE_MAX_DAYS), and lower accessories only — the decide half
  // reads the absence of `race_week_kind` as "outside a build".
  if (!lowerOnCard) return undefined;
  const eve = keyRunEveRead(date, weekPlan, STANDING_EVE_MAX_DAYS);
  return eve ? { key_run: eve, ...heavyLowerGuard(date, lowerMainOnCard) } : undefined;
}

// The week's last chance at a heavy lower anchor exposure (WEEKLY_HEAVY_LOWER_ANCHOR_MIN):
// no genuinely loaded lower session has landed earlier this week, and the lifting week
// lays no later heavy-lower day before Sunday. Read off the same week reads the weekly
// lower guarantee uses (plan-selection.ts `weeklyLowerExposure`); with no lifting week
// known, off the log and the forward projection of the strength ring. Fail-soft to
// "not last" — a read we cannot make never guards (and never trims more either: the
// guard only ever passes work over).
function heavyLowerGuard(date: string, lowerMainOnCard: boolean): { heavy_lower_last?: true } {
  if (!lowerMainOnCard) return {};
  const last = safeRead(() => {
    const week = weeklyLowerExposure(date);
    // Today is needed when what landed plus what is still laid ahead falls short.
    if (week) return (week.fulfilled_on ? 1 : 0) + week.later_lower_dates.length < WEEKLY_HEAVY_LOWER_ANCHOR_MIN;
    let count = fullLoadLowerSessionThisWeek(date) != null ? 1 : 0;
    const monday = mondayOf(date);
    for (let ahead = 1; ahead <= 6; ahead++) {
      const iso = addDaysISO(date, ahead);
      if (!iso || mondayOf(iso) !== monday) break;
      const day = strengthPlanDayOn(iso);
      if (day && isHeavyLowerPlanDay(day)) count++;
    }
    return count < WEEKLY_HEAVY_LOWER_ANCHOR_MIN;
  });
  return last === true ? { heavy_lower_last: true } : {};
}

// The next PLACED key run when `date` is the last lift day before it, at most `maxDays`
// out, not already run this week. Shared by the in-build and the standing eve.
function keyRunEveRead(
  date: string,
  weekPlan: WeeklyRunPlan | null,
  maxDays: 1 | 2
): { kind: "quality" | "long"; in_days: 1 | 2 } | undefined {
  const planFor = (iso: string): WeeklyRunPlan | null =>
    mondayOf(iso) === mondayOf(date) ? weekPlan : safeRead(() => weeklyRunPlan(iso, { adjustToday: false }));
  // A placed key run already RUN this week (a Thursday quality session done on Tuesday)
  // has no eve left to protect — the same "what is behind the athlete" read the week
  // layout uses (week-layout-closed.ts). A run in next week is never done yet.
  let closed: ReturnType<typeof weekLayoutClosed> | null | undefined;
  const alreadyRun = (iso: string, kind: "quality" | "long"): boolean => {
    if (mondayOf(iso) !== mondayOf(date)) return false;
    if (closed === undefined) closed = safeRead(() => weekLayoutClosed(date, { runPlan: weekPlan }));
    return closed?.runs_done[kind] === true;
  };
  const tomorrow = addDaysISO(date, 1);
  if (!tomorrow) return undefined;
  const tomorrowRun = placedKeyRunOn(tomorrow, planFor(tomorrow));
  if (tomorrowRun && !alreadyRun(tomorrow, tomorrowRun)) return { kind: tomorrowRun, in_days: 1 };
  if (maxDays < 2) return undefined;
  // A key run already done off tomorrow's slot leaves tomorrow empty of one — it does
  // not end the look-ahead: the long run the day after still has today as its eve.
  // The day after tomorrow counts only when tomorrow holds no lifting: today is then
  // the last lift day before the run.
  if (safeRead(() => strengthPlanDayOn(tomorrow)) != null) return undefined;
  const dayAfter = addDaysISO(date, 2);
  if (!dayAfter) return undefined;
  const laterRun = placedKeyRunOn(dayAfter, planFor(dayAfter));
  return laterRun && !alreadyRun(dayAfter, laterRun) ? { kind: laterRun, in_days: 2 } : undefined;
}

/**
 * The CALENDAR half of the budget for a day ahead: what taper or race week (or the days
 * after the race) does to a plan day on `date`, decided by the same gather + decide halves daily-decision runs —
 * never a second gate. Only rules 0, 1 and 2 (the post-race window, taper, race week):
 * they depend on nothing but the date and the card, so a read surface showing next Friday
 * can print them today. The key-run eve depends on that morning's weekly-lower guarantee
 * and safety floor, so it stays the morning's to say. Null when none applies.
 */
export function stressBudgetCalendarTrim(
  date: string,
  planItems: readonly any[],
  enduranceRole: EnduranceRole
): (StressBudgetDecision & { code: StressBudgetCalendarCode }) | null {
  const items = (Array.isArray(planItems) ? planItems : []).filter((it) => it && String(it.kind ?? "") !== "cardio");
  const snapshot = stressBudgetSnapshot(date, { dayType: "training", planItems: items, enduranceRole });
  if (!stressBudgetSuspendsWeeklyLower(snapshot)) return null;
  const decision = stressBudgetDecision(snapshot, {
    date,
    kind: "train",
    baseKind: "train",
    trainAnyway: false,
    lowerWeekHolds: false,
    weekHeldGroups: new Set(),
    lowerSafetyFloor: false,
    anchor: null,
    planItems: items.map((it) => ({ ...it, muscle_group: itemGroup(it) })) as DailyDecisionSnapshot["plan_items"],
    injuryExcluded: [],
    enduranceRole,
    snapshot: {} as DailyDecisionSnapshot,
  });
  return decision.code === "race_taper_legs" ||
    decision.code === "race_week_legs" ||
    decision.code === "post_race_recovery"
    ? (decision as StressBudgetDecision & { code: StressBudgetCalendarCode })
    : null;
}

/** The calendar rules — the ones a day ahead can already be read for. */
export type StressBudgetCalendarCode = "race_taper_legs" | "race_week_legs" | "post_race_recovery";

/**
 * Taper and race week stand the weekly lower guarantee down: the race build's own
 * strength law for those weeks is light legs, then legs off. daily-decision asks this
 * before it resolves `lowerWeekHolds`.
 */
export function stressBudgetSuspendsWeeklyLower(snapshot: StressBudgetSnapshot | undefined | null): boolean {
  return snapshot?.race_week_kind === "taper" || snapshot?.race_week_kind === "race" || snapshot?.race_recovery != null;
}

// The envelope's `stress` field: which rule spoke and the groups it named.
export interface DailyDecisionStress {
  code: StressBudgetReason;
  groups: string[];
  // The groups the stress budget reduced that NO other rule reduced. They are a
  // calendar trim, not recovering tissue: saturated substitution never moves them, and
  // under `load_held` composition keeps their load. Omit-when-idle.
  sole_reduced?: string[];
  // The rule trims sets only (the key-run eve): `sole_reduced` groups take the
  // reduced-area set cap at the prescribed weight — no eased load, still no reach. A
  // group another rule also reduced is not in `sole_reduced` and takes the full clamp.
  // Omit-when-idle.
  load_held?: true;
  // The day's anchor lift on a key-run eve, when its group is one the eve reduced for
  // the OTHER items in it (a squat beside a leg extension): it stays exactly as written
  // — no set trim, no progression hold. Only while its group is in `sole_reduced`; a
  // group another rule reduced clamps the anchor too. Omit-when-idle.
  hold_exercise?: string;
  // The STANDING eve (no race build): the trim is ITEM-scoped. Inside a `sole_reduced`
  // group only the items named in `trim_exercises` (lower accessories) lose a set — one
  // set each, at their load (`max(floor, sets − 1)`, daily-composition.ts); every other
  // item in that group (an RDL beside the leg curl) is passed over exactly like
  // `hold_exercise`. Omit-when-idle; the in-build eve carries neither and keeps its
  // group-level trim.
  scope?: "standing";
  trim_exercises?: string[];
  // The weekly heavy lower anchor guard spoke (WEEKLY_HEAVY_ANCHOR_KEPT): these groups'
  // squat/hinge work kept every set. Informational: they are in no reduced list.
  guard?: typeof WEEKLY_HEAVY_ANCHOR_KEPT;
  guard_groups?: string[];
}

export interface StressBudgetDecisionContext {
  date: string;
  kind: DailyDecisionKind;
  baseKind: DailyDecisionKind;
  trainAnyway: boolean;
  // The weekly lower guarantee is in force today (owner ruling 2026-09-23): nothing
  // here may take today's legs from it.
  lowerWeekHolds: boolean;
  // Groups held at logged load on the week's last lower day.
  weekHeldGroups: ReadonlySet<string>;
  // A deciding brake, low readiness, soreness, illness, a lower injury, a recovery
  // cycle/week or a deload phase already governs the legs — the key-run eve stands down.
  lowerSafetyFloor: boolean;
  // The day's first primary compound (effect-order tier 'primary'), or null.
  anchor: { exercise: string; muscle_group: string | null } | null;
  // Today's plan items as the snapshot carries them.
  planItems: DailyDecisionSnapshot["plan_items"];
  // Groups an injury or joint pain already excludes.
  injuryExcluded: readonly string[];
  enduranceRole: EnduranceRole;
  // The whole snapshot, for anything else the rule needs. Never mutate it.
  snapshot: DailyDecisionSnapshot;
}

export interface StressBudgetDecision {
  code: StressBudgetReason | null;
  // Merged into the envelope's reduced / excluded muscle lists.
  reduced: string[];
  excluded: string[];
  // Athlete-facing line for the rationale (pickDayVariant, violatesReadingGrammar-clean).
  rationale: string | null;
  // Machine-register detail for soft_preferences under `code`.
  soft: string | null;
  // The note an item carries when ONLY this rule excluded its group (the candidate's
  // `note`; its reason_code is `code`). null keeps the generic exclusion note.
  excluded_note: string | null;
  // The rule trims SETS only and keeps the load (the key-run eve): a slot trimmed every
  // week before the long run must still be trained at its prescribed weight, or it
  // never gets tested. Taper and race week leave this off and ease the load too.
  load_held?: true;
  // The anchor lift the trim passes over (the key-run eve), present only when one of
  // the reduced groups is the anchor's own. See DailyDecisionStress.hold_exercise.
  hold_exercise?: string;
  // The eve outside a race build: lower accessories only, tomorrow's run only — and
  // item-scoped: only `trim_exercises` lose a set; a compound in the same group stays whole.
  scope?: "standing";
  trim_exercises?: string[];
  // The weekly heavy lower anchor guard spoke (WEEKLY_HEAVY_ANCHOR_KEPT): today is the
  // week's last heavy lower exposure, so these groups' squat/hinge work keeps every set.
  guard?: typeof WEEKLY_HEAVY_ANCHOR_KEPT;
  guard_groups?: string[];
}

// ---- athlete-facing lines (every one through pickDayVariant; grammar-clean) ----

export const RACE_TAPER_LEGS_RATIONALE: readonly [string, ...string[]] = [
  "The race is close, so the leg lifts stay on the card at a lighter dose — fresh legs matter more than new ground this week.",
  "Taper week: the legs keep their movements with fewer sets and a little less weight, so they reach the start line fresh.",
  "The legs keep moving this week, just lighter. The build is done, and freshness is what the race asks for now.",
  "This is the taper, so leg work stays short and a touch lighter, while the upper body carries on as usual.",
];

export const RACE_WEEK_LEGS_RATIONALE: readonly [string, ...string[]] = [
  "Race week: the heavy leg lifts sit out, calves and core stay light, and the upper body carries on as usual.",
  "The work for the race is done, so the big leg lifts rest this week — keep calves and core easy and let the legs freshen.",
  "With the race only days away, squats and hinges step aside; a little light calf and core work is plenty.",
  "The legs are saving themselves for the race this week. Heavy lower work waits, and upper-body lifting goes on as normal.",
];

export const RACE_WEEK_EXCLUDED_NOTES: readonly [string, ...string[]] = [
  "Sits out for race week, so the legs arrive at the start line rested.",
  "Resting this one until the race is run.",
  "Race week: this lift waits until after the race.",
  "Off the card this week so the legs stay fresh for the race.",
];

type EveLine = (run: string, when: string) => string;
export const KEY_RUN_EVE_RATIONALE: readonly [EveLine, ...EveLine[]] = [
  (run, when) =>
    `With the ${run} ${when}, the smaller leg lifts take fewer sets today at the same weights; the main lift stays as written.`,
  (run, when) =>
    `The ${run} ${when} is a key session in the build, so the extra leg work is shorter today — same weights, fewer sets — and the main lift keeps its full session.`,
  (run, when) =>
    `Fewer sets on the leg accessories today, at your usual weights, so the ${run} ${when} starts on fresh legs; the main lift is untouched.`,
  (run, when) =>
    `A key ${run} lands ${when}, so the extra leg work stops early today while keeping its weights, and the main lift goes as planned.`,
];

// The STANDING eve (no race build): only the small leg lifts lose a set; every squat,
// hinge and lunge stays as written.
export const KEY_RUN_EVE_STANDING_RATIONALE: readonly [EveLine, ...EveLine[]] = [
  (run, when) =>
    `With the ${run} ${when}, the small leg lifts take fewer sets today at the same weights; squats, hinges and lunges stay as written.`,
  (run, when) =>
    `The ${run} ${when} gets fresher legs if the leg extras stop a little early today — same weights, and the big leg lifts keep every set.`,
  (run, when) =>
    `Fewer sets on the leg isolation work today, weights unchanged, so the ${run} ${when} starts on fresher legs; the main leg lifts are untouched.`,
  (run, when) =>
    `A ${run} lands ${when}, so the smaller leg lifts end a set early today while the heavy leg work goes as planned.`,
];

// The weekly heavy lower anchor guard spoke: today is the week's one remaining heavy leg
// session, so its squats and hinges keep every set even on the eve of a key run.
export const KEY_RUN_EVE_ANCHOR_KEPT_RATIONALE: readonly [EveLine, ...EveLine[]] = [
  (run, when) =>
    `With the ${run} ${when}, the small leg lifts take fewer sets today — but this is the week's one heavy leg session, so the squats and hinges keep every set.`,
  (run, when) =>
    `Today is the only heavy leg day left this week, so the main leg lifts stay whole; only the extras shorten ahead of the ${run} ${when}.`,
  (run, when) =>
    `The ${run} ${when} asks for fresh legs, and the week still needs its one heavy leg session: the big lifts keep their sets, the smaller ones stop early.`,
  (run, when) =>
    `Heavy legs once a week keeps the strength, and today is that day — the squats and hinges go as written, the leg extras ease off for the ${run} ${when}.`,
];

// The note a composed card item carries when ONLY this budget reduced its group
// (`stress.sole_reduced`). The generic reduced-area note says the area is still carrying
// recent work — false here: these legs are fresh, and it is the race build easing them.
// A group another rule also reduced keeps that rule's wording. Rotated per item through
// `pickDayVariant` by daily-composition.ts.
export const RACE_TAPER_ITEM_NOTES: readonly [string, ...string[]] = [
  "Taper week — lighter and fewer sets so your legs arrive fresh for the race.",
  "Lighter this week, and shorter, so the legs reach the start line fresh.",
  "A taper dose: fewer sets at an easier weight, with freshness for the race in mind.",
  "The build is done, so this one stays short and a touch lighter through the taper.",
];

export const RACE_WEEK_ITEM_NOTES: readonly [string, ...string[]] = [
  "Race week — kept short and light so the legs stay fresh for the race.",
  "Just a little light work here this week; the race is what the legs are saving for.",
  "Easy and brief in race week, enough to keep it moving without spending the legs.",
  "Race week: a lighter touch and fewer sets, so the start line finds you fresh.",
];

// The STANDING eve's item note: exactly one set off, the weight unchanged.
export const KEY_RUN_EVE_STANDING_ITEM_NOTES: readonly [string, ...string[]] = [
  "One set fewer today at the same weight, so tomorrow's run starts on fresher legs.",
  "Same weight, one set less — tomorrow's key run gets the legs a little fresher.",
  "Stopping a set early on this one, weight unchanged, with tomorrow's run in mind.",
  "A set shorter today at your usual weight, so the legs keep something for tomorrow's run.",
];

export const KEY_RUN_EVE_ITEM_NOTES: readonly [string, ...string[]] = [
  "Fewer sets today at the same weight, so the key run ahead starts on fresh legs.",
  "Same weight, fewer sets — the key run coming up gets the legs fresh.",
  "Stopping a little early on this one, weight unchanged, with the key run in mind.",
  "Shorter today at your usual weight, so the legs keep something for the key run.",
];

// The days after the race: the whole card lighter, the athlete still training.
type RecoveryLine = (race: string, back: string) => string;
export const POST_RACE_RECOVERY_RATIONALE: readonly [RecoveryLine, ...RecoveryLine[]] = [
  (race, back) =>
    `Recovering from ${race}: the lifting stays on the card at a lighter dose — fewer sets, easier weights — and back to full on ${back}.`,
  (race, back) =>
    `${race} is behind you, so today's session keeps its movements with fewer sets and a little less weight. Back to full on ${back}.`,
  (race, back) =>
    `A lighter session while the body recovers from ${race}: same lifts, shorter and easier, with full sessions back on ${back}.`,
  (race, back) =>
    `Still training, just lighter — ${race} asked a lot, so sets and weights come down a touch until ${back}.`,
];

export const POST_RACE_RECOVERY_ITEM_NOTES: readonly [string, ...string[]] = [
  "Lighter and shorter while you recover from the race.",
  "Fewer sets at an easier weight — recovering from the race.",
  "A recovery dose after the race: keep it smooth and leave plenty in the tank.",
  "Kept light this week so the race can settle; full sessions come back soon.",
];

/** The per-item note set for a stress-budget-only reduction, by the rule that spoke. */
export function stressBudgetItemNotes(code: unknown, scope?: unknown): readonly [string, ...string[]] | null {
  if (code === "post_race_recovery") return POST_RACE_RECOVERY_ITEM_NOTES;
  if (code === "race_taper_legs") return RACE_TAPER_ITEM_NOTES;
  if (code === "race_week_legs") return RACE_WEEK_ITEM_NOTES;
  if (code === "key_run_eve") return scope === "standing" ? KEY_RUN_EVE_STANDING_ITEM_NOTES : KEY_RUN_EVE_ITEM_NOTES;
  return null;
}

const EMPTY: StressBudgetDecision = {
  code: null,
  reduced: [],
  excluded: [],
  rationale: null,
  soft: null,
  excluded_note: null,
};

/** Decide half. Pure. Nothing to say → no code, empty lists. */
export function stressBudgetDecision(
  snapshot: StressBudgetSnapshot | undefined,
  ctx: StressBudgetDecisionContext
): StressBudgetDecision {
  if (!snapshot || ctx.kind === "rest") return EMPTY;
  const injured = new Set(ctx.injuryExcluded.map((g) => String(g).toLowerCase()));
  const dayGroups = [
    ...new Set(
      (ctx.planItems ?? [])
        .filter((it) => String(it.kind ?? "").toLowerCase() !== "cardio" && !!it.muscle_group)
        .map((it) => String(it.muscle_group).toLowerCase())
    ),
  ].filter((g) => !injured.has(g));

  // ---- 0. the days after the race: the whole card lighter, nothing excluded ----
  const recovery = snapshot.race_recovery;
  if (recovery) {
    if (!dayGroups.length) return EMPTY;
    const race = recovery.event ? String(recovery.event) : "the race";
    const back = weekdayShort(recovery.back_on) || "the weekend";
    const line = pickDayVariant(POST_RACE_RECOVERY_RATIONALE, ctx.date, "stress_budget:post_race")(race, back);
    return {
      code: "post_race_recovery",
      reduced: dayGroups,
      excluded: [],
      rationale: line.charAt(0).toUpperCase() + line.slice(1),
      soft:
        `Day ${recovery.day_index} of ${recovery.days} after the race — every lift lighter, fewer sets, no load step` +
        ` (${dayGroups.join(", ")}); back to full on ${recovery.back_on}`,
      excluded_note: null,
    };
  }
  if (ctx.enduranceRole === "none") return EMPTY;
  const lowerOnDay = dayGroups.filter((g) => LOWER_GROUPS.has(g));

  if (snapshot.race_week_kind === "taper") {
    if (!lowerOnDay.length) return EMPTY;
    return {
      code: "race_taper_legs",
      reduced: lowerOnDay,
      excluded: [],
      rationale: pickDayVariant(RACE_TAPER_LEGS_RATIONALE, ctx.date, "stress_budget:taper"),
      soft: `Taper week of the race build — lower-body work stays on the card, lighter (${lowerOnDay.join(", ")})`,
      excluded_note: null,
    };
  }

  if (snapshot.race_week_kind === "race") {
    const excluded = dayGroups.filter((g) => RACE_WEEK_EXCLUDED.has(g));
    const reduced = dayGroups.filter((g) => RACE_WEEK_REDUCED.has(g));
    if (!excluded.length && !reduced.length) return EMPTY;
    return {
      code: "race_week_legs",
      reduced,
      excluded,
      rationale: pickDayVariant(RACE_WEEK_LEGS_RATIONALE, ctx.date, "stress_budget:race_week"),
      soft: `Race week — heavy leg work sits out${excluded.length ? ` (${excluded.join(", ")})` : ""}${
        reduced.length ? `; ${reduced.join(", ")} stay light` : ""
      }`,
      excluded_note: excluded.length
        ? pickDayVariant(RACE_WEEK_EXCLUDED_NOTES, ctx.date, "stress_budget:race_week:excluded")
        : null,
    };
  }

  // ---- the eve of a placed key run ----
  const keyRun = snapshot.key_run;
  if (!keyRun || (keyRun.kind !== "quality" && keyRun.kind !== "long")) return EMPTY;
  if (ctx.lowerWeekHolds || ctx.lowerSafetyFloor) return EMPTY;
  // The athlete asked for today's session as it is (daily-decision.ts
  // `request.same_day_request`): a lift asked for today is never trimmed on any card.
  if (ctx.snapshot?.request?.same_day_request) return EMPTY;
  // Outside a race build (no week kind on the slice) the eve is the STANDING one:
  // tomorrow only, lower ACCESSORIES only (never a compound), sets only.
  const standing = snapshot.race_week_kind == null;
  if (standing && keyRun.in_days > STANDING_EVE_MAX_DAYS) return EMPTY;
  // The endurance-led key-run protect (daily-decision) already lightens every lower
  // group for an open key run today or tomorrow — one rule speaks for that run.
  const leads = ctx.enduranceRole === "primary" || ctx.enduranceRole === "co_primary";
  const open = ctx.snapshot?.open_key_run;
  const tomorrow = addDaysISO(ctx.date, 1);
  if (
    leads &&
    open &&
    (open.kind === "quality" || open.kind === "long") &&
    (open.suggested_date === ctx.date || open.suggested_date === tomorrow)
  ) {
    return EMPTY;
  }
  // Item-scoped: the groups of every lower item on the card except the anchor itself.
  // The trim speaks through GROUPS (composition clamps a reduced group's items), so a
  // group is trimmed only when every item it would clamp may be trimmed — the anchor is
  // passed over by name (`hold_exercise`), anything else in the group must qualify.
  const anchorName = ctx.anchor?.exercise ? String(ctx.anchor.exercise).trim().toLowerCase() : null;
  const anchorGroup = ctx.anchor?.muscle_group ? String(ctx.anchor.muscle_group).toLowerCase() : null;
  const guard = snapshot.heavy_lower_last === true;
  const strengthItems = (ctx.planItems ?? []).filter(
    (it) => String(it.kind ?? "").toLowerCase() !== "cardio" && !!it.muscle_group
  );
  const accessory: string[] = [];
  const keptByGuard: string[] = [];
  // The standing eve's item-scoped list: the accessories that lose a set.
  const trimExercises: string[] = [];
  for (const group of lowerOnDay) {
    if (ctx.weekHeldGroups.has(group)) continue;
    const others = strengthItems.filter(
      (it) =>
        String(it.muscle_group).toLowerCase() === group &&
        String(it.exercise ?? "")
          .trim()
          .toLowerCase() !== anchorName
    );
    if (!others.length) continue;
    // Standing: lower ACCESSORIES only, ITEM-scoped. The group reads reduced for the
    // accessories in it, and every compound beside them (an RDL beside the leg curl) is
    // passed over by name (`trim_exercises`). A compound is never trimmed here, so the
    // heavy lower anchor guard has nothing to keep on the standing eve.
    if (standing) {
      const trims = others.filter((it) => isLowerAccessoryItem(it, group));
      if (!trims.length) continue;
      for (const it of trims) trimExercises.push(String(it.exercise ?? "").trim());
      accessory.push(group);
      continue;
    }
    // The week's last heavy lower exposure: a squat/hinge main lift the trim would reach
    // (any but the anchor it already passes over) keeps its group whole.
    if (guard && others.some((it) => isLowerMainLift(String(it.exercise ?? ""), group))) {
      keptByGuard.push(group);
      continue;
    }
    accessory.push(group);
  }
  if (!accessory.length) return EMPTY;
  const holdExercise =
    ctx.anchor?.exercise && anchorGroup && accessory.includes(anchorGroup) ? String(ctx.anchor.exercise) : null;
  const run = keyRun.kind === "long" ? "long run" : "quality run";
  const when = keyRun.in_days === 1 ? "tomorrow" : "in two days";
  const lines = keptByGuard.length
    ? KEY_RUN_EVE_ANCHOR_KEPT_RATIONALE
    : standing
      ? KEY_RUN_EVE_STANDING_RATIONALE
      : KEY_RUN_EVE_RATIONALE;
  const variantKey = keptByGuard.length
    ? "stress_budget:key_run_eve:anchor_kept"
    : standing
      ? "stress_budget:key_run_eve:standing"
      : "stress_budget:key_run_eve";
  return {
    code: "key_run_eve",
    load_held: true,
    ...(holdExercise ? { hold_exercise: holdExercise } : {}),
    ...(standing ? { scope: "standing" as const, trim_exercises: [...new Set(trimExercises)] } : {}),
    ...(keptByGuard.length ? { guard: WEEKLY_HEAVY_ANCHOR_KEPT, guard_groups: keptByGuard } : {}),
    reduced: accessory,
    excluded: [],
    rationale: pickDayVariant(lines, ctx.date, variantKey)(run, when),
    soft: [
      `Last lift day before the placed ${keyRun.kind} run${standing ? " (no race build)" : ""}`,
      standing
        ? ` — one set off each lower accessory, load held (${[...new Set(trimExercises)].join(", ")})`
        : ` — lower non-anchor sets trimmed, load held (${accessory.join(", ")})`,
      ctx.anchor ? `; ${ctx.anchor.exercise} keeps its full session` : "",
      keptByGuard.length
        ? `; ${WEEKLY_HEAVY_ANCHOR_KEPT}: the week's last heavy lower exposure keeps every set (${keptByGuard.join(", ")})`
        : "",
    ].join(""),
    excluded_note: null,
  };
}

// A lower item the STANDING eve may trim: isolation/core tier work (a leg extension, a
// leg curl, a calf raise) — never a squat, hinge, lunge, hip thrust or carry, and never
// a squat/hinge main lift whatever its tier reads.
type BudgetItem = { exercise?: string | null; muscle_group?: string | null; kind?: string | null; note?: string | null };
function isLowerAccessoryItem(it: BudgetItem, group: string): boolean {
  if (isLowerMainLift(String(it.exercise ?? ""), group)) return false;
  const tier = planItemEffectTier(it);
  return tier === PLAN_ITEM_EFFECT_TIER.isolation || tier === PLAN_ITEM_EFFECT_TIER.core;
}
