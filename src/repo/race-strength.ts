// WHAT A RACE BUILD ASKS OF THE LIFTING — the ONE source for the phase's strength
// principle, read by the race build (each rung's `strength_hint`, the build's
// `strength.principle` and the with-lifting line), and through them by the prompts
// and the Run/Race surfaces. Never a second copy of these sentences anywhere else.
//
// The answer depends on who the athlete IS, not only on how far away the race is. A
// strength-led athlete (`isStrengthLedIntent`: endurance role none/supporting, or
// endurance ranked below both muscle and strength) keeps PROGRESSING through the whole
// build — full sets, ordinary load steps — and only the legs are trimmed, by the stress
// budget (stress-budget.ts) alone: taper week the leg lifts go lighter with fewer sets,
// race week the heavy leg lifts sit out, and on the eve of a placed key run the
// non-anchor leg work loses sets at its load. Outside a race build the run calendar's
// ONLY lifting change is the standing eve (leg accessories, sets only, tomorrow's
// quality or long run), and every week keeps one heavy lower anchor session whole
// (`WEEKLY_HEAVY_LOWER_ANCHOR_MIN`). The upper body keeps progressing throughout.
// An endurance-led athlete (primary / co_primary, or a
// derived intent) keeps the classic race-build lifting arc: maintenance loads while
// sharpening, light and fast in the taper, legs off in race week.
//
// Pure: fixtures in, words out. The caller reads the intent once and passes the lead.
import { isStrengthLedIntent, type ResolvedTrainingIntent, type TrainingIntent } from "./training-intent.js";

type Phase = "base" | "build" | "sharpen" | "taper" | "past";
type WeekKind = "build" | "down" | "peak" | "taper" | "race";

/** Whose goals the lifting serves while a race is on the calendar. */
export type RaceStrengthLead = "strength_led" | "endurance_led";

/**
 * What the week asks of the lifting:
 * - `progression` — ordinary progressive overload, full sets, on every lift;
 * - `maintenance` — hold what is there (the endurance-led arc outside race week);
 * - `taper_legs`  — the legs go lighter, the upper body keeps progressing;
 * - `race_week`   — heavy leg work sits out.
 */
export type RaceStrengthMode = "progression" | "maintenance" | "taper_legs" | "race_week";

export interface RaceStrengthPrinciple {
  lead: RaceStrengthLead;
  mode: RaceStrengthMode;
  /** The machine-register sentence the prompts and the build card read. */
  principle: string;
  /** Upper-body lifting keeps taking its earned steps this week. */
  upper_progresses: boolean;
}

// The endurance-led arc, keyed by the race PHASE (race week by kind). Kept verbatim:
// an endurance-primary athlete's build reads exactly as it always has.
const ENDURANCE_LED: Record<Exclude<Phase, "past"> | "race_week", string> = {
  base: "Two lower sessions a week, building loads — the base is where legs get strong.",
  build: "Heavy lower once a week, a lighter second; squats land after the quality run or the day after the long run.",
  sharpen: "Maintenance loads (2–3 sets of 3–5, nothing new) — power without soreness.",
  taper: "Light and fast: one short session, ~80% of working loads, last heavy lower ~10 days out.",
  race_week: "Legs off. A mobility session at most.",
};

// The strength-led arc, keyed by the week KIND: the build keeps progressing, and only
// the taper and race week — the two weeks the stress budget trims the legs — differ.
const STRENGTH_LED: Record<"progression" | "taper_legs" | "race_week", string> = {
  progression:
    "Keep progressing: full sets and normal load steps on every lift; heavy legs sit away from the eve of the quality and long runs.",
  taper_legs:
    "Taper week: upper body keeps progressing; legs stay on the card lighter (fewer sets, ~80–90% of working loads), with the last heavy lower ~7–10 days out.",
  race_week: "Race week: heavy leg lifts sit out, calves and core stay light, and the upper body keeps progressing.",
};

/** The lead for an athlete's stated intent. A derived (never-set) intent is endurance-led, as the block chooser reads it. */
export function raceStrengthLead(intent: TrainingIntent | ResolvedTrainingIntent | null | undefined): RaceStrengthLead {
  return isStrengthLedIntent(intent) ? "strength_led" : "endurance_led";
}

/**
 * The race week's strength principle. `phase` is the race phase, `kind` the rung's
 * week kind (race week is kind `race`). A past phase has nothing to say ("").
 */
export function raceStrengthPrinciple(input: {
  phase: Phase;
  kind: WeekKind;
  lead: RaceStrengthLead;
}): RaceStrengthPrinciple {
  const { phase, kind, lead } = input;
  if (lead === "strength_led") {
    if (kind === "race") return { lead, mode: "race_week", principle: STRENGTH_LED.race_week, upper_progresses: true };
    if (kind === "taper")
      return { lead, mode: "taper_legs", principle: STRENGTH_LED.taper_legs, upper_progresses: true };
    if (phase === "past") return { lead, mode: "progression", principle: "", upper_progresses: true };
    return { lead, mode: "progression", principle: STRENGTH_LED.progression, upper_progresses: true };
  }
  if (kind === "race") return { lead, mode: "race_week", principle: ENDURANCE_LED.race_week, upper_progresses: false };
  if (phase === "past") return { lead, mode: "maintenance", principle: "", upper_progresses: false };
  const mode: RaceStrengthMode = phase === "sharpen" ? "maintenance" : phase === "taper" ? "taper_legs" : "progression";
  return { lead, mode, principle: ENDURANCE_LED[phase], upper_progresses: mode === "progression" };
}
