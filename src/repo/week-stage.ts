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
import { countdownWords, dateWords, raceDistanceName } from "./display-words.js";
import { activeBlockContext } from "./program-blocks.js";
import { raceBuild, type RaceBuild } from "./race-build.js";
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
  /** The active block's week as the week runs it ("block week 6 of 6"). */
  block: { week: number; of: number; words: string } | null;
  /** Days from `date` to a dated race still ahead. */
  countdown: {
    days: number;
    event: string;
    race_date: string;
    race_date_words: string;
    /** "26 days to Cambridge Half". */
    words: string;
  } | null;
  /** A dated push stance covering the week ("push through Nov 15"). */
  push: { until: string; until_words: string; words: string } | null;
  /** The frame's headline: the countdown, else the stage's week word. */
  headline: string | null;
  /** "Sharpen · block week 6 of 6 · push through Nov 15" — the line under the headline. */
  line: string | null;
  /** Today's one link into Horizon: "26 days to Cambridge · Sharpen, wk 6 of 6". */
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
  const build = opts.build !== undefined ? opts.build : safe(() => raceBuild(asOf), null);
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

/**
 * The frame of the week holding `date`, read as of `asOf` (default `date`): countdown,
 * stage, block week, a push stance covering it — and the headline, line and glance
 * composed from them once.
 */
export function weekFrameLine(date?: string, opts: { build?: RaceBuild | null; asOf?: string } = {}): WeekFrame {
  const d = String(date || localDateISO()).slice(0, 10);
  const asOf = opts.asOf ?? d;
  const build = opts.build !== undefined ? opts.build : safe(() => raceBuild(asOf), null);
  const stage = safe(() => weekStage(d, { build, asOf }), null);

  // The block's week, the week as it runs (a later week is the block's next one).
  let block: WeekFrame["block"] = null;
  const ctx = safe(() => activeBlockContext(asOf), null);
  if (ctx) {
    const offset = weekOffset(d, asOf);
    const week = ctx.week_index + Math.max(0, offset);
    if (offset >= 0 && week <= ctx.total_weeks) {
      block = { week, of: ctx.total_weeks, words: `block week ${week} of ${ctx.total_weeks}` };
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

  const lineParts = [stage?.word ?? null, block?.words ?? null, push?.words ?? null].filter(Boolean) as string[];
  const line = lineParts.length ? lineParts.join(" · ") : null;
  const headline = countdown?.words ?? stage?.week_word ?? null;
  const glanceStage = stage ? `${stage.word}${block ? `, wk ${block.week} of ${block.of}` : ""}` : block ? `Block week ${block.week} of ${block.of}` : null;
  const glanceLead = countdown
    ? countdown.days === 0
      ? `${shortEvent(countdown.event)} is today`
      : `${countdown.days} ${countdown.days === 1 ? "day" : "days"} to ${shortEvent(countdown.event)}`
    : null;
  const glance = [glanceLead, glanceStage].filter(Boolean).join(" · ") || null;

  return { date: d, week_start: mondayOf(d), stage, block, countdown, push, headline, line, glance };
}
