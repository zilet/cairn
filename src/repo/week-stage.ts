// THE WEEK'S STAGE AND FRAME — one name for a week, one line that frames it.
//
// `weekStage(date)` names the week holding `date` through the ONE stage vocabulary
// (stage-words.ts): the race build's rung for that week when a race is dated (a build
// rung by its phase, every other rung by its kind), else the block's phase as the week
// actually runs it (block-phase.ts). The day page's week tag, the plan look-ahead's
// rung marker, Today's path, the race build's rows and the conductor's block line all
// read it, so one Tuesday can no longer be "Sharpen" on one surface and "Build week" on
// the next.
//
// `weekFrameLine(date)` is the frame every week surface leads with — the countdown
// headline ("26 days to Cambridge Half") and the one line under it ("Sharpen · block
// week 6 of 6 · push through Nov 15"), plus the glance Today links to Horizon with.
// Renderers frame these strings; they never rebuild them.
//
// Reads only; every part behind its own guard, so a thin read thins the frame.
import { addDaysISO, daysBetweenISO, mondayOf } from "../lib/dates.js";
import { resolvedBlockPhase } from "./block-phase.js";
import { pickDayVariant } from "./brain/day-read-rules.js";
import { awayWords, countdownWords, dateWords, raceDistanceName } from "./display-words.js";
import { activeBlockContext } from "./program-blocks.js";
import { raceBuild, type RaceBuild } from "./race-build.js";
import { raceRecoveryLine, raceRecoveryWindow } from "./race-recovery.js";
import { localDateISO } from "./shared.js";
import {
  STAGE_PHRASE,
  STAGE_WEEK_WORD,
  STAGE_WORD,
  stageKeyOf,
  stageKeyOfBlockPhase,
  stageKeyOfRacePhase,
  type WeekStageKey,
} from "./stage-words.js";
import { trainingDriveState } from "./training-drive.js";

export interface WeekStage {
  key: WeekStageKey;
  /** "Sharpen" — the short label. */
  word: string;
  /** "Sharpen week" — the week tag. */
  week_word: string;
  /** "a sharpen week" — inside a sentence. */
  phrase: string;
  /** Which read named it: the race build's rung, or the block's phase. */
  source: "race" | "block";
}

export interface WeekFrame {
  /** The read's as-of day; the frame describes the week holding `date`. */
  date: string;
  week_start: string;
  stage: WeekStage | null;
  /**
   * The active block's week as the week runs it ("block week 6 of 6"). `ends_at_race`:
   * race day falls inside the block's LAST week — only then may a ribbon end at the race.
   */
  block: { week: number; of: number; words: string; ends_at_race: boolean } | null;
  /** Days from `date` to a dated race still ahead. */
  countdown: {
    days: number;
    event: string;
    race_date: string;
    race_date_words: string;
    /** "26 days to Cambridge Half". */
    words: string;
    /** The far form, for a quiet line: "5K time trial in 25 weeks" (the ONE weeks count, display-words.ts). */
    far_words: string;
  } | null;
  /** A dated push stance covering the week ("push through Nov 15"). */
  push: { until: string; until_words: string; words: string } | null;
  /**
   * The frame's headline: the countdown, else — the days after a race — the recovery
   * window said once ("Recovering from Cambridge Half · back to full on Thu",
   * race-recovery.ts), else the stage's week word.
   */
  headline: string | null;
  /**
   * The week's purpose in the coach's voice ("Build the engine. Keep the bench moving."),
   * a day-stable variant keyed on the stage and what the week holds (weekPurpose); null
   * when no stage names the week.
   */
  purpose: string | null;
  /**
   * What leads: the countdown inside FRAME_COUNTDOWN_LEAD_DAYS of the race, or the
   * post-race recovery line; else the purpose; null when neither exists.
   */
  lead: "countdown" | "purpose" | null;
  /**
   * The other one, said once: the purpose when the countdown leads; the far countdown
   * ("5K time trial in 25 weeks.") when the purpose leads. The week read prefixes its
   * own count sentence to the latter.
   */
  sub: string | null;
  /** "Sharpen · block week 6 of 6 · push through Nov 15" — the line under the headline. */
  line: string | null;
  /**
   * Today's one link into Horizon: "26 days to Cambridge · Sharpen week" — a race-named
   * week by its race word alone; a block-named one "Build, wk 3 of 5".
   */
  glance: string | null;
}

function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function stageOf(key: WeekStageKey | null, source: WeekStage["source"]): WeekStage | null {
  return key
    ? { key, word: STAGE_WORD[key], week_word: STAGE_WEEK_WORD[key], phrase: STAGE_PHRASE[key], source }
    : null;
}

/** The stage of a race-ladder rung, in the one vocabulary. Null for an unknown rung. */
export function rungStage(rung: { kind?: unknown; phase?: unknown } | null | undefined): WeekStage | null {
  return rung ? stageOf(stageKeyOf(rung.kind, rung.phase), "race") : null;
}

/** Weeks from the as-of week to the week holding `date` (0 = the same week). */
function weekOffset(date: string, asOf: string): number {
  const a = Date.parse(`${mondayOf(asOf)}T00:00:00Z`);
  const b = Date.parse(`${mondayOf(date)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / (7 * 864e5)) : 0;
}

/**
 * The stage of the week holding `date`. `build` is the race build the caller already
 * holds (read as of `asOf`, default `date`); `asOf` is the day the read is made from
 * (a later week is the block's week `offset` ahead).
 */
export function weekStage(date: string, opts: { build?: RaceBuild | null; asOf?: string } = {}): WeekStage | null {
  const asOf = opts.asOf ?? date;
  const build = opts.build !== undefined ? opts.build : safe(() => raceBuild(asOf, { templateRing: true }), null);
  if (build?.available) {
    const rung = (build.weeks ?? []).find((w) => w.week_start === mondayOf(date));
    const fromRung = rungStage(rung);
    if (fromRung) return fromRung;
    // A dated race with no rung for this week (past race week, a week before the
    // ladder's first rung): the race's own phase.
    const fromPhase = stageOf(stageKeyOfRacePhase(build.race?.phase), "race");
    if (fromPhase && weekOffset(date, asOf) === 0) return fromPhase;
  }
  const ctx = safe(() => activeBlockContext(asOf), null);
  if (!ctx) return null;
  const offset = weekOffset(date, asOf);
  if (offset < 0 || ctx.week_index + offset > ctx.total_weeks) return null;
  const phase = safe(() => resolvedBlockPhase(date), null) ?? (offset === 0 ? ctx.phase : null);
  return stageOf(stageKeyOfBlockPhase(phase), "block");
}

/** The stage's short word for the week holding `date` ("Sharpen"), or null. */
export function weekStageWord(date: string, opts: { build?: RaceBuild | null; asOf?: string } = {}): string | null {
  return weekStage(date, opts)?.word ?? null;
}

function eventName(build: RaceBuild): string {
  const event = String(build.race?.event ?? "").trim();
  if (event) return event;
  const km = Number(build.race?.distance_km);
  return km > 0 ? `your ${raceDistanceName(km).toLowerCase()}` : "the race";
}

/** "Cambridge Half" → "Cambridge" for the glance (the first word of a multi-word event). */
function shortEvent(event: string): string {
  if (/^your\b|^the\b/i.test(event)) return event;
  const words = event.split(/\s+/);
  return words.length > 1 && /^(half|marathon|10k|5k|run|race)$/i.test(words.at(-1) ?? "") ? words.slice(0, -1).join(" ") : event;
}

/** Inside this many days of a race the countdown leads the frame; further out, the week's purpose does. */
export const FRAME_COUNTDOWN_LEAD_DAYS = 56;

type PurposeVariant = string | ((lift: string) => string);

/**
 * The week's purpose, a variant set per stage AND the read that named it (a race rung
 * vs the block's phase: a block's lighter week is a deload, a race's is a reset; a
 * block's peak is its test week, a race's the biggest week of the build). Every variant
 * is true whenever its key fires; none carries a unit, a number, a score or gate words.
 */
const PURPOSE: Record<`${WeekStageKey}:${WeekStage["source"]}`, readonly PurposeVariant[]> = {
  "base:race": [
    "Build the engine.",
    "Lay the base, one easy run at a time.",
    "Easy running, often. That is the engine.",
  ],
  "base:block": ["Lay the base.", "Steady work that the next weeks build on."],
  "build:race": [
    "Build the engine, a little more each week.",
    "Add a little, absorb it, add again.",
    "More running than last week, still mostly easy.",
  ],
  "build:block": ["Volume builds. Stack the sets.", "Bank the work: more sets, steady loads."],
  "sharpen:race": ["Sharpen what the base built.", "Race-specific work now. Quality over volume."],
  "sharpen:block": ["Heavier, fewer reps. Sharpen the lifts.", "Intensity climbs while the sets come down."],
  "down:race": ["A lighter week. Let the work settle in.", "Ease off so the next weeks land."],
  "down:block": ["A lighter week. Let the work settle in.", "Lighter loads this week, so the next block lands."],
  "peak:race": [
    "The biggest week of the build. Take it one day at a time.",
    "Peak week: the most work of the build, taken steadily.",
  ],
  "peak:block": ["A heavier week to see where the lifts stand.", "Show what the block built."],
  "taper:race": ["Less volume, fresh legs for race day.", "Let the legs come back. Keep a little sharpness."],
  "taper:block": ["Less volume, fresh legs.", "Let the legs come back."],
  "race:race": ["Race week. Arrive fresh and let the work show.", "Race week. Keep it light and trust the build."],
  "race:block": ["Race week. Arrive fresh and let the work show.", "Race week. Keep it light and trust the build."],
};

/** The second sentence for a lead lift that is climbing (the journey's own "rising"). */
const PURPOSE_LIFT: readonly ((lift: string) => string)[] = [
  (lift) => `Keep ${lift} moving.`,
  (lift) => `${lift.charAt(0).toUpperCase()}${lift.slice(1)} keeps climbing; keep it there.`,
];

/** The days after a race: rest leads, the next build waits. */
const PURPOSE_RECOVERY: readonly string[] = [
  "Let the race settle. Easy days first.",
  "Recover first. The next build can wait a few days.",
];

/** Stages a climbing lift is spoken beside: never a lighter, taper or race week, where it would read as a push. */
const LIFT_STAGES = new Set<WeekStageKey>(["base", "build", "sharpen", "peak"]);

/**
 * The week's purpose: the stage's variant set (rotated by day, keyed on the stage), plus
 * a lead lift said beside it when one is climbing; the post-race window says recovery.
 * Null when no stage names the week.
 */
export function weekPurpose(
  stage: WeekStage | null,
  opts: { date: string; recovering?: boolean; lift?: string | null }
): string | null {
  if (!stage) return null;
  if (opts.recovering) return pickDayVariant(PURPOSE_RECOVERY, opts.date, "week:purpose:recovery");
  const set = PURPOSE[`${stage.key}:${stage.source}`];
  if (!set?.length) return null;
  const head = pickDayVariant(set, opts.date, `week:purpose:${stage.key}:${stage.source}`);
  const first = typeof head === "function" ? head(opts.lift ?? "") : head;
  const lift = String(opts.lift ?? "").trim();
  if (!lift || !LIFT_STAGES.has(stage.key)) return first;
  return `${first} ${pickDayVariant(PURPOSE_LIFT, opts.date, "week:purpose:lift")(lift)}`;
}

/** The block's last week holds race day: only then may a ribbon end at the race. */
function blockEndsAtRace(weekStart: string, block: { week: number; of: number }, raceDate: string | null): boolean {
  if (!raceDate) return false;
  const lastWeek = addDaysISO(weekStart, (block.of - block.week) * 7);
  return !!lastWeek && mondayOf(raceDate) === lastWeek;
}

/**
 * The frame of the week holding `date`, read as of `asOf` (default `date`): countdown,
 * stage, block week, a push stance covering it — and the headline, line and glance
 * composed from them once. `lift` is the lead lift's short name ("the bench") when it is
 * climbing — the week read hands it in from the strength journeys; the frame never reads them.
 */
export function weekFrameLine(
  date?: string,
  opts: { build?: RaceBuild | null; asOf?: string; lift?: string | null } = {}
): WeekFrame {
  const d = String(date || localDateISO()).slice(0, 10);
  const asOf = opts.asOf ?? d;
  const build = opts.build !== undefined ? opts.build : safe(() => raceBuild(asOf, { templateRing: true }), null);
  const stage = safe(() => weekStage(d, { build, asOf }), null);

  // The block's week, the week as it runs (a later week is the block's next one).
  let block: WeekFrame["block"] = null;
  const ctx = safe(() => activeBlockContext(asOf), null);
  if (ctx) {
    const offset = weekOffset(d, asOf);
    const week = ctx.week_index + Math.max(0, offset);
    if (offset >= 0 && week <= ctx.total_weeks) {
      block = { week, of: ctx.total_weeks, words: `block week ${week} of ${ctx.total_weeks}`, ends_at_race: false };
    }
  }

  let countdown: WeekFrame["countdown"] = null;
  if (build?.available && build.race?.date) {
    const days = daysBetweenISO(build.race.date, asOf);
    if (days != null && days >= 0) {
      const event = eventName(build);
      countdown = {
        days,
        event,
        race_date: build.race.date,
        race_date_words: dateWords(build.race.date, asOf),
        words: countdownWords(days, event),
        far_words: days <= 0 ? `${event} is today` : `${event} ${awayWords(days)}`,
      };
    }
  }

  let push: WeekFrame["push"] = null;
  const weekEnd = addDaysISO(mondayOf(d), 6) ?? d;
  const drive = safe(() => trainingDriveState(asOf), null);
  const stance = drive?.drive === "push" ? drive.stance : null;
  if (stance?.until && stance.until >= mondayOf(d) && String(stance.since ?? "") <= weekEnd) {
    const untilWords = dateWords(stance.until, asOf);
    push = { until: stance.until, until_words: untilWords, words: `push through ${untilWords}` };
  }

  // The days after a race (race-recovery.ts): said once, for the week still holding them.
  const recovery = countdown ? null : safe(() => raceRecoveryWindow(asOf), null);
  const recoveryHere = recovery != null && mondayOf(d) <= recovery.ends_on && weekEnd >= asOf;
  const recoveryLine = recoveryHere ? safe(() => raceRecoveryLine(asOf, recovery), null) : null;

  if (block)
    block.ends_at_race = blockEndsAtRace(mondayOf(d), block, build?.available ? (build.race?.date ?? null) : null);

  const lineParts = [stage?.word ?? null, block?.words ?? null, push?.words ?? null].filter(Boolean) as string[];
  const line = lineParts.length ? lineParts.join(" · ") : null;
  const purpose = safe(() => weekPurpose(stage, { date: asOf, recovering: !!recoveryLine, lift: opts.lift }), null);
  // Inside eight weeks of the race (or in the days after one) the countdown leads, exactly
  // as before; further out the week's purpose leads and the race is said once, quietly.
  const countdownLeads = (countdown != null && countdown.days <= FRAME_COUNTDOWN_LEAD_DAYS) || recoveryLine != null;
  const lead: WeekFrame["lead"] = countdownLeads ? "countdown" : purpose ? "purpose" : countdown ? "countdown" : null;
  const headline =
    lead === "countdown"
      ? (countdown?.words ?? recoveryLine)
      : lead === "purpose"
        ? purpose
        : (stage?.week_word ?? null);
  const farLine = countdown ? `${countdown.far_words.charAt(0).toUpperCase()}${countdown.far_words.slice(1)}.` : null;
  const sub = lead === "countdown" ? (purpose ?? null) : lead === "purpose" ? farLine : null;
  // A race-named week glances by its race word alone ("12 days to Cambridge · Taper
  // week"): the lifting block's "wk 1 of 6" beside a race phase read as the race's own
  // count (2026-10-20, "Taper, wk 1 of 6" twelve days out). The block's week stays in
  // `line`, where it is named as the block's.
  const glanceStage =
    stage?.source === "race"
      ? stage.week_word
      : stage
        ? `${stage.word}${block ? `, wk ${block.week} of ${block.of}` : ""}`
        : block
          ? `Block week ${block.week} of ${block.of}`
          : null;
  const glanceLead = countdown
    ? countdown.days === 0
      ? `${shortEvent(countdown.event)} is today`
      : `${countdown.days} ${countdown.days === 1 ? "day" : "days"} to ${shortEvent(countdown.event)}`
    : null;
  const glance = (recoveryLine ?? [glanceLead, glanceStage].filter(Boolean).join(" · ")) || null;

  return {
    date: d,
    week_start: mondayOf(d),
    stage,
    block,
    countdown,
    push,
    headline,
    purpose,
    lead,
    sub,
    line,
    glance,
  };
}
