// A push stance's widened licenses, one constant each, so tests and docs can name them
// (what a stance IS, and when it covers a day: training-drive.ts).
//
// They live in a module that imports nothing because they are read at LOAD TIME:
// training-drive-read.ts spells PUSH_STANCE_CONSEC_CEILING into its top-level
// PUSH_STANCE_LICENSES words, and training-drive.ts sits inside the repo layer's big
// import cycle (it reaches training-drive-read back through program-blocks → … → coach),
// so a training-drive loaded first used to hand training-drive-read a constant that was
// not initialized yet. training-drive.ts re-exports every name here, so its importers are
// unchanged; anything that reads one at top level imports it from HERE.

/** Days a stance may run at most before the athlete re-states it. */
export const PUSH_STANCE_MAX_DAYS = 84;
/** The stance's length when the athlete names neither a date nor the block. */
export const PUSH_STANCE_DEFAULT_DAYS = 28;
/** The stacked loading-day count at which an uncorroborated stack reads easy (5 without a stance). */
export const PUSH_STANCE_CONSEC_CEILING = 7;
/** Challenge top sets a reach day may seat (1 without a stance), each on a different movement pattern. */
export const PUSH_STANCE_REACH_HOSTS = 2;
/** Reserve (reps in hand at the ceiling) that still counts a top set as strong (2 without a stance). */
export const PUSH_STANCE_RIR_RESERVE = 1;
/** Days after a stance's last day that its end is still SAID (the Brief's line, the prompts'
 * "their push ended"). Past it the fall-back drive simply stands, with nothing to announce. */
export const PUSH_STANCE_ENDED_SAY_DAYS = 7;
