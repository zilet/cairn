// ============================================================================
// recovery-week-earned.ts — the facts an EARNED recovery week stands on.
//
// The daily pass that settles a recovery week by itself (domain/brain/recovery-week-change.ts)
// and the autonomy layer's premise check (autonomy-service.ts serverPremise) read the same
// three things, so they live here, in the repo layer, where neither imports the other:
//
//   1. Is a lighter week EARNED for the week that starts on the landing Monday?
//      - `streak` / `fatigue`: the mesocycle reads `deload-due` (program-state.ts — the
//        loaded-weeks evidence, never re-derived here). The fatigue arm's log witness is
//        MOVEMENT UNITS, never lifts (two compound units on the plan slipping with nothing
//        of their own to explain it, capability-consumers.ts fatigueWitnessUnits), and the
//        premise below reads the very same mesocycle, so routing and landing apply one rule;
//      - `scheduled`: the block's own deload week falls on the landing week and will
//        really run (block-phase.ts, the ONE resolution: a push athlete with no loaded-weeks
//        evidence runs it as intensification, so nothing lightens).
//   2. Does anything HOLD it? A race taper, race week or the days after a race touching the
//      landing week; a bounded trip over three or more of its days; a recovery week already
//      drafted, coming or running (the fuel package's included); the cooldown after the last
//      one; the athlete's own "no" in this block (recovery-refusal.ts). Pain, the cut and an
//      untested slot are deliberately NOT holds — a lighter week is the protective answer.
//   3. Does a draft's premise still stand (`recoveryWeekStillEarned`)? `fits` while the
//      evidence holds, so sessions logged before Monday never park it as a question; `gone`
//      when the evidence went (a light week broke the streak) or a cycle opened; `held` when
//      a hold arrived; `unknown` when a read failed (the boundary waits a day, nothing lands).
//      A draft whose Monday has passed is `gone`: a recovery week never lands mid-week.
//
// Every read fails CLOSED: a throw is `unknown`, never "clear".
// ============================================================================
import { db } from "../db.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { getAppState } from "./app-state.js";
import { nextWeekScheduledDeloadRuns, resolvedBlockPhase } from "./block-phase.js";
import { activeBlockContext, getActiveBlock } from "./program-blocks.js";
import { getProgramState } from "./program-state.js";
import { getEnduranceGoal, isoDow, WEEKDAY_NAMES } from "./profile.js";
import { UNDERFUEL_BRAIN_AGENT } from "./protective-fuel-draft.js";
import { raceBuild } from "./race-build.js";
import { raceRecoveryWindow } from "./race-recovery.js";
import { recoveryCycleCooldown } from "./recovery-cycles.js";
import { recoveryWeekMayBeAnnounced } from "./recovery-refusal.js";
import { RECOVERY_WEEK_INSTRUCTION_PREFIX } from "./recovery-week-ledger.js";
import { RECOVERY_WEEK_AGENT, recoveryWeekPlanDays } from "./recovery-week.js";
import { getSettings } from "./settings.js";
import { addDaysISO, daysBetweenISO, localDateISO } from "./shared.js";
import { tripCovers } from "./trip-version.js";
import { currentUnderfuelingRead } from "./underfueling-snapshot.js";
import { nextNaturalBoundary } from "../brain/autonomy.js";

/** Why a week is lighter: earned by the loaded weeks, the block's own deload, or asked for. */
export type RecoveryWeekArm = "streak" | "fatigue" | "scheduled" | "asked";
/** The arms the daily pass settles by itself (`asked` is the person's own tap). */
export const EARNED_RECOVERY_ARMS: ReadonlySet<string> = new Set(["streak", "fatigue", "scheduled"]);

export type RecoveryWeekHoldReason = "race" | "trip" | "fuel" | "open" | "cooldown" | "refused";

export type RecoveryWeekPremise = "fits" | "gone" | "held" | "unknown";

// A bounded trip over this many days of the landing week already makes it a light week.
export const RECOVERY_WEEK_TRIP_HOLD_DAYS = 3;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function days(from: string, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const day = addDaysISO(from, i);
    if (day) out.push(day);
  }
  return out;
}

// ---- 1. earned? ---------------------------------------------------------------

export type EarnedRecoveryRead =
  | {
      status: "earned";
      arm: Exclude<RecoveryWeekArm, "asked">;
      loaded_weeks: number | null;
      /** The loaded-weeks evidence behind it, when that is what earned it (said in the sentence). */
      basis?: "streak" | "fatigue";
    }
  | { status: "none" }
  | { status: "unknown" };

/**
 * How many times the block advances a week between `asOf` and the landing Monday,
 * inclusive: the block moves on the coach slot's weekday (scheduler.ts blockAdvanceDue,
 * Sunday by default), and today's move counts only if it has not run yet.
 */
function blockAdvancesThrough(asOf: string, landsOn: string): number {
  const coachDay = Math.max(0, Math.min(6, Math.trunc(Number(getSettings().coach_day) || 0)));
  const ranToday = getAppState("block_advance_last_slot") === asOf;
  let count = 0;
  for (const day of days(asOf, 9)) {
    if (day > landsOn) break;
    if (isoDow(day) !== coachDay) continue;
    if (day === asOf && ranToday) continue;
    count++;
  }
  return count;
}

/**
 * Whether the block week the landing Monday falls in is the block's scheduled deload, and
 * that deload will actually run (block-phase.ts). Null when a read failed.
 */
export function scheduledDeloadLandsOn(asOf: string, landsOn: string): boolean | null {
  try {
    if (!getActiveBlock()) return false;
    const advances = blockAdvancesThrough(asOf, landsOn);
    if (advances === 0)
      return activeBlockContext(asOf)?.scheduled_deload === true && resolvedBlockPhase(asOf) === "deload";
    // The landing week is next block week: the resolution's own "next week" answer.
    if (advances === 1) return nextWeekScheduledDeloadRuns(asOf);
    // Two moves before Monday (the slot's weekday is today, not yet run, and Monday): wait.
    return false;
  } catch {
    return null;
  }
}

/** Is a lighter week earned for the week starting `landsOn`, and by what? */
export function earnedRecoveryWeek(asOf: string, landsOn: string): EarnedRecoveryRead {
  let meso: any;
  try {
    meso = getProgramState(asOf)?.mesocycle ?? null;
  } catch {
    return { status: "unknown" };
  }
  if (meso?.phase === "deload-due") {
    const basis = meso.deload_basis;
    const loaded = Number(basis?.loaded_weeks);
    const evidence: "streak" | "fatigue" = basis?.arm === "fatigue" ? "fatigue" : "streak";
    const loadedWeeks = Number.isFinite(loaded) && loaded > 0 ? Math.trunc(loaded) : null;
    // Earned AND landing on the block's own deload week: the lighter week IS that week of
    // the block (arm `scheduled`, so the block advances through it, program-blocks.ts),
    // never a week inserted before it — or the block's deload would run twice.
    const scheduled = scheduledDeloadLandsOn(asOf, landsOn);
    if (scheduled == null) return { status: "unknown" };
    if (scheduled) return { status: "earned", arm: "scheduled", loaded_weeks: loadedWeeks, basis: evidence };
    return { status: "earned", arm: evidence, loaded_weeks: loadedWeeks };
  }
  // A recovery week already running is not a reason for another.
  if (meso?.phase === "deload") return { status: "none" };
  const scheduled = scheduledDeloadLandsOn(asOf, landsOn);
  if (scheduled == null) return { status: "unknown" };
  return scheduled ? { status: "earned", arm: "scheduled", loaded_weeks: null } : { status: "none" };
}

// ---- 2. held? -----------------------------------------------------------------

export type RecoveryWeekHoldRead =
  | { status: "clear" }
  | { status: "hold"; reason: RecoveryWeekHoldReason; until?: string | null; refused_on?: string | null }
  | { status: "unknown" };

// Another recovery-week draft still open (a review hold, or a change on its way to its
// Monday), other than `exceptId`. The fuel package's draft says so.
function otherOpenRecoveryDraft(exceptIds: readonly number[]): "fuel" | "open" | null {
  const rows = db
    .prepare(
      `SELECT id, agent FROM plan_proposals
        WHERE status = 'draft' AND parsed_json IS NOT NULL AND instruction LIKE ?
        ORDER BY id DESC LIMIT 20`
    )
    .all(`${RECOVERY_WEEK_INSTRUCTION_PREFIX}%`) as Array<{ id: number; agent: string | null }>;
  const other = rows.filter((row) => !exceptIds.includes(Number(row.id)));
  if (!other.length) return null;
  return other.some((row) => String(row.agent ?? "") === UNDERFUEL_BRAIN_AGENT) ? "fuel" : "open";
}

// A race taper or race week on the landing week, the race itself in it or in the week
// before it (its recovery days then reach into it), or the days after a race already run.
// Null when a read failed.
function raceTouches(asOf: string, landsOn: string): boolean | null {
  try {
    const week = days(landsOn, 7);
    const end = week[week.length - 1] ?? landsOn;
    if (week.some((day) => raceRecoveryWindow(day) != null)) return true;
    const goal = getEnduranceGoal(asOf);
    const raceOn = goal?.is_race && goal.date ? String(goal.date).slice(0, 10) : null;
    if (!raceOn || !ISO_DAY.test(raceOn)) return false;
    const weekBefore = addDaysISO(landsOn, -7) ?? landsOn;
    if (raceOn >= weekBefore && raceOn <= end) return true;
    if (raceOn < landsOn) return false;
    // Only a race close enough for its taper to reach the landing week needs the build read.
    const horizon = addDaysISO(landsOn, 42) ?? landsOn;
    if (raceOn > horizon) return false;
    const build = raceBuild(asOf, { weekLayout: null, templateRing: true });
    if (!build.available) return false;
    const rung = build.weeks.find((w) => w.week_start === landsOn);
    return rung != null && (rung.kind === "taper" || rung.kind === "race");
  } catch {
    return null;
  }
}

// Days of the landing week a bounded trip covers. Null when a read failed.
function tripDays(landsOn: string): number | null {
  let covered = 0;
  for (const day of days(landsOn, 7)) {
    const covers = tripCovers(day);
    if (covers == null) return null;
    if (covers) covered++;
  }
  return covered;
}

/**
 * What holds a recovery week landing on `landsOn`, read on `asOf`. `exceptProposalId` is
 * the draft being judged (its own open draft is not "another"). The athlete's tap
 * (`arm: 'asked'`) is held by none of the athlete-facing holds — they asked.
 */
export function recoveryWeekHold(
  asOf: string,
  landsOn: string,
  opts: { exceptProposalId?: number | null; exceptProposalIds?: readonly number[] } = {}
): RecoveryWeekHoldRead {
  try {
    const except = [...(opts.exceptProposalIds ?? []), ...(opts.exceptProposalId != null ? [opts.exceptProposalId] : [])].map(
      Number
    );
    const other = otherOpenRecoveryDraft(except);
    if (other) return { status: "hold", reason: other };
    const cooldown = recoveryCycleCooldown(landsOn);
    if (!cooldown.allowed)
      return { status: "hold", reason: cooldown.reason === "cooldown" ? "cooldown" : "open", until: cooldown.until };
    const refusal = recoveryWeekMayBeAnnounced(asOf);
    if (!refusal.allowed) return { status: "hold", reason: "refused", refused_on: refusal.refused_on };
  } catch {
    return { status: "unknown" };
  }
  const race = raceTouches(asOf, landsOn);
  if (race == null) return { status: "unknown" };
  if (race) return { status: "hold", reason: "race" };
  const trip = tripDays(landsOn);
  if (trip == null) return { status: "unknown" };
  if (trip >= RECOVERY_WEEK_TRIP_HOLD_DAYS) return { status: "hold", reason: "trip" };
  return { status: "clear" };
}

// ---- 3. the draft's premise -----------------------------------------------------

export interface RecoveryWeekMark {
  arm: RecoveryWeekArm;
  loaded_weeks: number | null;
  lands_on: string;
  signature: string;
  /** A `scheduled` week the loaded weeks also earned: which evidence (for the sentence). */
  basis?: "streak" | "fatigue";
}

/** The `parsed.recovery_week` mark a server-written recovery week carries, or null. */
export function recoveryWeekMark(parsed: any): RecoveryWeekMark | null {
  const mark = parsed?.recovery_week;
  const arm = String(mark?.arm ?? "");
  const landsOn = String(mark?.lands_on ?? "").slice(0, 10);
  if (!(EARNED_RECOVERY_ARMS.has(arm) || arm === "asked") || !ISO_DAY.test(landsOn)) return null;
  const loaded = Number(mark?.loaded_weeks);
  return {
    arm: arm as RecoveryWeekArm,
    loaded_weeks: Number.isFinite(loaded) && loaded > 0 ? Math.trunc(loaded) : null,
    lands_on: landsOn,
    signature: String(mark?.signature ?? ""),
    ...(mark?.basis === "streak" || mark?.basis === "fatigue" ? { basis: mark.basis } : {}),
  };
}

/** A recovery week this layer wrote (the earned week or the person's tap). */
export function isServerRecoveryWeek(proposal: any): boolean {
  return String(proposal?.agent ?? "") === RECOVERY_WEEK_AGENT && recoveryWeekMark(proposal?.parsed) != null;
}

/**
 * Does a server-written recovery week still stand on `asOf`? Read in place of the generic
 * evidence fingerprint at routing and at the Monday it lands (autonomy-service.ts
 * serverPremise). Never throws.
 */
export function recoveryWeekStillEarned(parsed: any, asOf: string = localDateISO(), proposalId?: number | null): RecoveryWeekPremise {
  const mark = recoveryWeekMark(parsed);
  if (!mark) return "gone";
  // Its Monday has passed: a recovery week never lands mid-week. The daily pass reads
  // the next Monday afresh.
  if (asOf > mark.lands_on) return "gone";
  // The person's own tap stands on their word; only its Monday can pass it by.
  if (mark.arm === "asked") return "fits";
  const hold = recoveryWeekHold(asOf, mark.lands_on, { exceptProposalId: proposalId ?? null });
  if (hold.status === "unknown") return "unknown";
  if (hold.status === "hold") return hold.reason === "open" || hold.reason === "cooldown" ? "gone" : "held";
  if (mark.arm === "scheduled") {
    const scheduled = scheduledDeloadLandsOn(asOf, mark.lands_on);
    if (scheduled == null) return "unknown";
    return scheduled ? "fits" : "gone";
  }
  // The loaded-weeks evidence underneath, read past the block's own suppression of the
  // word: the block moving into its deload week, or a fresh block, does not unmake it.
  // A light week since breaks the streak, and the evidence with it.
  try {
    return getProgramState(asOf)?.mesocycle?.deload_evidence === true ? "fits" : "gone";
  } catch {
    return "unknown";
  }
}

// ---- the fuel package's recovery week ---------------------------------------------
//
// The under-fuelling control loop's coordinated recovery week (underfueling-service.ts
// recoveryProposal) is its OWN proposal, separate from the package's calorie step, so a
// premise on it can never touch the calorie step. Its premise is the read that minted it:
// the loop's own read still saying `training: "reduce"`. The loop remembers what each pass
// read (UNDERFUEL_TRAINING_READ_KEY, written by runUnderfuelingControlLoop), so the premise
// is the loop's answer, never a second derivation; only when the loop has not read for a
// while does the premise ask `currentUnderfuelingRead` — the same read the loop asks. On a
// cut it is the likeliest source of a lighter week, and a set logged before Monday must not
// park it as a stale ask.

/** Where the under-fuelling loop remembers what its latest pass asked of training. */
export const UNDERFUEL_TRAINING_READ_KEY = "underfuel_training_read";
// How old the loop's remembered read may be before the premise reads the fuel read itself.
const UNDERFUEL_READ_FRESH_DAYS = 3;

function rememberedLoopTraining(asOf: string): string | null {
  try {
    const stamp = JSON.parse(String(getAppState(UNDERFUEL_TRAINING_READ_KEY) ?? ""));
    const date = String(stamp?.date ?? "").slice(0, 10);
    const age = ISO_DAY.test(date) ? daysBetweenISO(asOf, date) : null;
    if (age == null || age < 0 || age > UNDERFUEL_READ_FRESH_DAYS) return null;
    return typeof stamp?.training === "string" && stamp.training ? stamp.training : null;
  } catch {
    return null;
  }
}

/** The fuel package's recovery-week draft (agent `underfuel-brain`, the recovery instruction, a `days` week). */
export function isFuelRecoveryWeek(proposal: any): boolean {
  return (
    String(proposal?.agent ?? "") === UNDERFUEL_BRAIN_AGENT &&
    String(proposal?.instruction ?? "").startsWith(RECOVERY_WEEK_INSTRUCTION_PREFIX) &&
    Array.isArray(proposal?.parsed?.days)
  );
}

/**
 * `fits` while the under-fuelling read still asks for a lighter week; `gone` when it no
 * longer does, when its Monday passed (a due decision on any other weekday — never a
 * mid-week landing), or when another recovery cycle opened over that Monday; `held` only
 * for the athlete's refusal; `unknown` when a read failed. Never throws. `readTraining`
 * is the loop's read (injectable for tests).
 */
export function fuelRecoveryWeekStillStands(
  proposal: any,
  asOf: string = localDateISO(),
  readTraining: (date: string) => string | null = (date) =>
    String(currentUnderfuelingRead(date)?.action?.training ?? "") || null
): RecoveryWeekPremise {
  try {
    const autonomy = proposal?.autonomy ?? null;
    const dueOn = String(autonomy?.effective_date ?? "").slice(0, 10);
    const due =
      ["announced", "pending"].includes(String(autonomy?.status ?? "")) && ISO_DAY.test(dueOn) && dueOn <= asOf;
    if (due && isoDow(asOf) !== 1) return "gone";
    const landsOn = isoDow(asOf) === 1 ? asOf : nextNaturalBoundary("training_structure", asOf);
    if (!recoveryCycleCooldown(landsOn).allowed) return "gone";
    if (!recoveryWeekMayBeAnnounced(asOf).allowed) return "held";
    const training = rememberedLoopTraining(asOf) ?? readTraining(asOf);
    if (training == null) return "unknown";
    return training === "reduce" ? "fits" : "gone";
  } catch {
    return "unknown";
  }
}

// ---- the athlete-facing words ------------------------------------------------------

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

function spelled(n: number): string {
  const i = Math.trunc(n);
  return i >= 0 && i < NUMBER_WORDS.length ? NUMBER_WORDS[i] : "many";
}

function capitalized(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// What the week IS, said once on the announcement card and the Plan banner.
const SUMMARY_VARIANTS: Record<RecoveryWeekArm, ReadonlyArray<(day: string) => string>> = {
  streak: [
    (day) => `A lighter week from ${day}: about half the working sets, the loads eased a touch, every lift kept.`,
    (day) => `From ${day} the week runs lighter — the same lifts at about half the sets, the weight a little under usual.`,
    (day) => `An earned lighter week starts ${day}: half the working sets, slightly lighter loads, nothing taken off the plan.`,
  ],
  fatigue: [
    (day) => `A lighter week from ${day}: about half the working sets, the loads eased a touch, every lift kept.`,
    (day) => `From ${day} the week runs lighter — the same lifts at about half the sets, the weight a little under usual.`,
    (day) => `An earned lighter week starts ${day}: half the working sets, slightly lighter loads, nothing taken off the plan.`,
  ],
  scheduled: [
    (day) => `Your block's deload week runs lighter from ${day}: about half the working sets, the loads eased a touch.`,
    (day) => `The block's deload week starts ${day} and is a real one — half the sets, the weight a little under usual.`,
    (day) => `From ${day} the block's deload week does its job: the same lifts at about half the sets, slightly lighter.`,
  ],
  asked: [
    (day) => `The lighter week you asked for starts ${day}: about half the working sets, the loads eased a touch.`,
    (day) => `Your lighter week begins ${day} — the same lifts at about half the sets, the weight a little under usual.`,
  ],
};

// Why it is earned, in the athlete's register. No relative-time words ("today", "this
// week", "recent", "last"): the stored draft's prose is re-dated by proposal-truth.ts, and
// a sentence about the coming week must not be rewritten into a date.
function whyEarned(arm: RecoveryWeekArm, loaded: number | null, date: string): string {
  const weeks = loaded != null && loaded > 1 ? `${spelled(loaded)} loaded weeks` : "your loaded weeks";
  const sets: Record<RecoveryWeekArm, readonly string[]> = {
    streak: [
      `${capitalized(weeks)} in a row with no lighter one between them have earned it.`,
      `You have stacked ${weeks} back to back; a lighter week now is where that work turns into strength.`,
      `After ${weeks} without a break in the loading, this is the week that lets them land.`,
    ],
    fatigue: [
      `${capitalized(weeks)}, and your log shows sessions coming in short of what was written, with recovery trailing.`,
      `After ${weeks}, the log has sessions falling short of the plan and recovery lagging — the loading has caught up with you.`,
      `${capitalized(weeks)} plus sessions coming in under what was written say the work needs a week to land.`,
    ],
    scheduled: [
      "Your block planned the coming week as its deload, and a deload only does its job when it is actually lighter.",
      "It is the block's own deload week; running it lighter is what lets the block's work land.",
    ],
    asked: ["You asked for a lighter week."],
  };
  return pickDayVariant(sets[arm], date, `recovery-week:why:${arm}`);
}

const KEPT_LINES = [
  "Undo keeps the week as written.",
  "If you would rather train it as written, Undo puts it back.",
  "Undo, and the week stays exactly as it was planned.",
] as const;

const INTENSITY_LINES = [
  "The lifts stay heavy enough to hold what you built; only the volume comes down.",
  "Intensity stays close to usual, which is what holds strength and muscle through a lighter week.",
  "Keeping the weight near usual while the sets come down is what keeps the strength you built.",
] as const;

export interface RecoveryWeekPayloadInput {
  arm: RecoveryWeekArm;
  loaded_weeks: number | null;
  /** The loaded-weeks evidence behind a `scheduled` week, when it was also earned. */
  basis?: "streak" | "fatigue";
  date: string;
  lands_on: string;
  plan: readonly any[];
  signature?: string;
}

/**
 * The deterministic recovery-week draft: the shared plan snapshot (recoveryWeekPlanDays),
 * its words, and the `recovery_week` mark the premise reads. Null when the plan has no
 * lifting day to lighten.
 */
export function recoveryWeekProposalPayload(input: RecoveryWeekPayloadInput): any | null {
  const weekDays = recoveryWeekPlanDays(input.plan);
  if (!weekDays.length) return null;
  const landsOn = String(input.lands_on).slice(0, 10);
  const day = WEEKDAY_NAMES[isoDow(landsOn)] ?? "Monday";
  const summary = pickDayVariant(SUMMARY_VARIANTS[input.arm], input.date, `recovery-week:summary:${input.arm}`)(day);
  const rationale = [
    // A block deload the loaded weeks also earned says why in the loaded weeks' words.
    whyEarned(input.basis ?? input.arm, input.loaded_weeks, input.date),
    pickDayVariant(INTENSITY_LINES, input.date, "recovery-week:intensity"),
    pickDayVariant(KEPT_LINES, input.date, "recovery-week:kept"),
  ].join(" ");
  return {
    summary,
    rationale,
    days: weekDays,
    recovery_week: {
      arm: input.arm,
      loaded_weeks: input.loaded_weeks,
      lands_on: landsOn,
      signature: input.signature ?? `${input.arm}:${landsOn}`,
      ...(input.basis ? { basis: input.basis } : {}),
    },
  };
}

/** Every phrasing this module can write, for the grammar tests. */
export function recoveryWeekPhrasings(): string[] {
  const out: string[] = [];
  for (const arm of Object.keys(SUMMARY_VARIANTS) as RecoveryWeekArm[]) {
    for (const make of SUMMARY_VARIANTS[arm]) out.push(make("Monday"));
    for (const loaded of [null, 1, 4, 6, 9, 14]) {
      for (let offset = 0; offset < 6; offset++) {
        const date = addDaysISO("2026-01-05", offset) ?? "2026-01-05";
        out.push(whyEarned(arm, loaded, date));
      }
    }
  }
  out.push(...INTENSITY_LINES, ...KEPT_LINES);
  return [...new Set(out)];
}
