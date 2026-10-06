// THE STAGE VOCABULARY — the one set of words for "what kind of week is this".
//
// A week used to be named three ways at once: the race ladder's rung kind ("Build
// week"), the race phase ("Sharpen"), and the block phase ("a sharpening week"), so one
// Tuesday read SHARPEN on Today's path, "Build week" on the day page and "Three weeks
// of build…" on Train. Every surface now names the week through `stageKeyOf()` and these
// two tables (week-stage.ts reads them against the race build and the block for a date).
//
// The rule: a race rung that is its own kind of week (a lighter reset, the peak, the
// taper, race week) speaks as that kind; a BUILD rung speaks as its race phase (base /
// build / sharpen; a build rung inside the taper's span is the taper). With no dated
// race, the block's phase names the week. Pure; no imports.

export type WeekStageKey = "base" | "build" | "sharpen" | "down" | "peak" | "taper" | "race";

/** The stage as a short label: "Sharpen" — the frame line, a chip, a glance. */
export const STAGE_WORD: Readonly<Record<WeekStageKey, string>> = {
  base: "Base",
  build: "Build",
  sharpen: "Sharpen",
  down: "Lighter week",
  peak: "Peak week",
  taper: "Taper",
  race: "Race week",
};

/** The stage as a week: "Sharpen week" — a row tag, a sentence's subject. */
export const STAGE_WEEK_WORD: Readonly<Record<WeekStageKey, string>> = {
  base: "Base week",
  build: "Build week",
  sharpen: "Sharpen week",
  down: "Lighter week",
  peak: "Peak week",
  taper: "Taper week",
  race: "Race week",
};

/** The stage inside a sentence: "a sharpen week" — lower case, with its article. */
export const STAGE_PHRASE: Readonly<Record<WeekStageKey, string>> = {
  base: "a base week",
  build: "a build week",
  sharpen: "a sharpen week",
  down: "a lighter week",
  peak: "the peak week",
  taper: "a taper week",
  race: "race week",
};

const PHASES = new Set(["base", "build", "sharpen", "taper"]);

/**
 * The stage of a race-ladder rung (`kind` from RaceWeekKind, `phase` from RacePhase).
 * A build rung speaks as its phase; every other kind is its own stage.
 */
export function stageKeyOf(kind: unknown, phase: unknown): WeekStageKey | null {
  const k = String(kind ?? "");
  const p = String(phase ?? "");
  if (k === "build") return PHASES.has(p) ? (p as WeekStageKey) : "build";
  if (k === "") return PHASES.has(p) ? (p as WeekStageKey) : null;
  if (k === "down" || k === "peak" || k === "taper" || k === "race") return k;
  return null;
}

/** The stage of a race phase alone (no rung): base / build / sharpen / taper. */
export function stageKeyOfRacePhase(phase: unknown): WeekStageKey | null {
  const p = String(phase ?? "");
  return PHASES.has(p) ? (p as WeekStageKey) : null;
}

/**
 * The stage of a strength block's phase, for a week with no dated race: volume builds
 * (accumulation), intensity sharpens (intensification), the deload is the lighter week,
 * the realization (test) week is the block's peak.
 */
export function stageKeyOfBlockPhase(phase: unknown): WeekStageKey | null {
  switch (String(phase ?? "")) {
    case "accumulation":
      return "build";
    case "intensification":
      return "sharpen";
    case "deload":
      return "down";
    case "realization":
      return "peak";
    default:
      return null;
  }
}
