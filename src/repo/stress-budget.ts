import { runPlacement } from "../domain/training/week-layout.js";
import { addDaysISO, mondayOf } from "../lib/dates.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import type { DailyDecisionKind, DailyDecisionReason, DailyDecisionSnapshot } from "./daily-decision.js";
import { canonicalGroup, classifyMuscleGroup } from "./exercise-canon.js";
import { strengthPlanDayOn } from "./plan-selection.js";
import { dowToDayNumber, getEnduranceGoal, isoDow } from "./profile.js";
import { raceBuild } from "./race-build.js";
import { type WeeklyRunPlan, weeklyRunPlan } from "./run-progression.js";
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
//      long-run days. It applies only while the race build is active (a build, reset or
//      peak week outside the base phase). Every lower item on the card EXCEPT the
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
//      daily-decision already lightens every lower group for the same run.
//   4. No day-after-a-hard-run rule: the acute gate (hybrid-load.ts `acuteGate`) is the
//      one recovery question and already answers it.
//
// The week-kind read is raceBuild's, never a second race-phase read. An athlete whose
// endurance role is `none` gets nothing here, and so does anyone without a dated race.
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
// Must never: touch the anchor lift itself on a key-run eve, change a load or a set count
// directly (that is composition's, via the muscle lists), or touch upper-body groups.

export type StressBudgetReason = Extract<DailyDecisionReason, "key_run_eve" | "race_taper_legs" | "race_week_legs">;

// Every lower-body group the budget speaks for (daily-decision's LOWER_BODY_GROUPS).
const LOWER_GROUPS: ReadonlySet<string> = new Set(["quads", "hamstrings", "glutes", "calves"]);
// Race week: these sit out; the rest of the lower list and core go light.
const RACE_WEEK_EXCLUDED: ReadonlySet<string> = new Set(["quads", "hamstrings", "glutes"]);
const RACE_WEEK_REDUCED: ReadonlySet<string> = new Set(["calves", "core"]);
// The race-build week kinds / phases in which a key run is protected on its eve.
const EVE_WEEK_KINDS: ReadonlySet<string> = new Set(["build", "down", "peak"]);
const EVE_PHASES: ReadonlySet<string> = new Set(["build", "sharpen", "taper"]);

// The snapshot slice (`DailyDecisionSnapshot.stress_budget`). Fingerprinted: keep it
// compact, JSON-only, and stable for a given day's inputs.
export interface StressBudgetSnapshot {
  // raceBuild(date): the current week's kind and phase, and the days left to the race.
  race_week_kind?: string;
  race_phase?: string;
  days_to_race?: number;
  // The next PLACED key run when today is the last lift day before it (≤ two days out).
  key_run?: { kind: "quality" | "long"; in_days: 1 | 2 };
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

/** Gather half. `undefined` = nothing to say (the key stays off the snapshot). */
export function stressBudgetSnapshot(date: string, ctx: StressBudgetGatherContext): StressBudgetSnapshot | undefined {
  if (ctx.enduranceRole === "none") return undefined;
  const groups = new Set(
    (Array.isArray(ctx.planItems) ? ctx.planItems : []).map(itemGroup).filter((g): g is string => g != null)
  );
  const lowerOnCard = [...groups].some((g) => LOWER_GROUPS.has(g));
  if (!lowerOnCard && !groups.has("core")) return undefined;
  // Cheap guard first: raceBuild and the run engine are only asked with a dated race.
  const goal = safeRead(() => getEnduranceGoal(date));
  if (!goal?.is_race || !goal.date) return undefined;

  const weekPlan = safeRead(() => weeklyRunPlan(date, { adjustToday: false }));
  const build = raceBuild(date, { runPlan: weekPlan, weekLayout: null });
  if (!build.available || !build.race) return undefined;
  const week = build.weeks.find((w) => w.current) ?? null;
  if (!week) return undefined;
  const base = { race_week_kind: week.kind, race_phase: week.phase, days_to_race: build.race.days_to_race };
  if (week.kind === "taper") return lowerOnCard ? base : undefined;
  if (week.kind === "race") return base;

  if (!lowerOnCard || !EVE_WEEK_KINDS.has(week.kind) || !EVE_PHASES.has(week.phase)) return undefined;
  const planFor = (iso: string): WeeklyRunPlan | null =>
    mondayOf(iso) === mondayOf(date) ? weekPlan : safeRead(() => weeklyRunPlan(iso, { adjustToday: false }));
  const tomorrow = addDaysISO(date, 1);
  if (!tomorrow) return undefined;
  const tomorrowRun = placedKeyRunOn(tomorrow, planFor(tomorrow));
  if (tomorrowRun) return { ...base, key_run: { kind: tomorrowRun, in_days: 1 } };
  // The day after tomorrow counts only when tomorrow holds no lifting: today is then
  // the last lift day before the run.
  if (safeRead(() => strengthPlanDayOn(tomorrow)) != null) return undefined;
  const dayAfter = addDaysISO(date, 2);
  if (!dayAfter) return undefined;
  const laterRun = placedKeyRunOn(dayAfter, planFor(dayAfter));
  return laterRun ? { ...base, key_run: { kind: laterRun, in_days: 2 } } : undefined;
}

/**
 * Taper and race week stand the weekly lower guarantee down: the race build's own
 * strength law for those weeks is light legs, then legs off. daily-decision asks this
 * before it resolves `lowerWeekHolds`.
 */
export function stressBudgetSuspendsWeeklyLower(snapshot: StressBudgetSnapshot | undefined | null): boolean {
  return snapshot?.race_week_kind === "taper" || snapshot?.race_week_kind === "race";
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
  if (!snapshot || ctx.kind === "rest" || ctx.enduranceRole === "none") return EMPTY;
  const injured = new Set(ctx.injuryExcluded.map((g) => String(g).toLowerCase()));
  const dayGroups = [
    ...new Set(
      (ctx.planItems ?? [])
        .filter((it) => String(it.kind ?? "").toLowerCase() !== "cardio" && !!it.muscle_group)
        .map((it) => String(it.muscle_group).toLowerCase())
    ),
  ].filter((g) => !injured.has(g));
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
  const anchorName = ctx.anchor?.exercise ? String(ctx.anchor.exercise).trim().toLowerCase() : null;
  const anchorGroup = ctx.anchor?.muscle_group ? String(ctx.anchor.muscle_group).toLowerCase() : null;
  const accessory = [
    ...new Set(
      (ctx.planItems ?? [])
        .filter(
          (it) =>
            String(it.kind ?? "").toLowerCase() !== "cardio" &&
            !!it.muscle_group &&
            String(it.exercise ?? "")
              .trim()
              .toLowerCase() !== anchorName
        )
        .map((it) => String(it.muscle_group).toLowerCase())
    ),
  ].filter((g) => lowerOnDay.includes(g) && !ctx.weekHeldGroups.has(g));
  if (!accessory.length) return EMPTY;
  const holdExercise =
    ctx.anchor?.exercise && anchorGroup && accessory.includes(anchorGroup) ? String(ctx.anchor.exercise) : null;
  const run = keyRun.kind === "long" ? "long run" : "quality run";
  const when = keyRun.in_days === 1 ? "tomorrow" : "in two days";
  return {
    code: "key_run_eve",
    load_held: true,
    ...(holdExercise ? { hold_exercise: holdExercise } : {}),
    reduced: accessory,
    excluded: [],
    rationale: pickDayVariant(KEY_RUN_EVE_RATIONALE, ctx.date, "stress_budget:key_run_eve")(run, when),
    soft: `Last lift day before the placed ${keyRun.kind} run — lower accessory sets trimmed, load held (${accessory.join(", ")})${
      ctx.anchor ? `; ${ctx.anchor.exercise} keeps its full session` : ""
    }`,
    excluded_note: null,
  };
}
