// ============================================================================
// progression-voice.ts — the ATHLETE-FACING vocabulary of the per-session
// progression engine.
//
// Why this exists: every verdict branch in progression.ts used to set ONE hard
// literal. A stable input fires a stable branch, so two lifts sitting in the same
// state printed the identical sentence on the same screen ("Strength has been
// slipping — …" twice, one card above the other), and the same lift printed the
// same sentence every week. That reads as a template, not a coach.
//
// So each branch owns a SET of phrasings of the SAME meaning, rotated by
// pickDayVariant — the same mechanism the day read uses. The rotation key carries
// the exercise, so two lifts in the same state on the same day land on different
// phrasings, while ONE lift stays stable within a day (a card must not change its
// words when the screen re-renders).
//
// Contract for anything added here (VISION.md Amendment 2, the reading grammar in
// src/repo/day-read.ts): second person, plain words, no scores or grades, no gate
// language, no engineering vocabulary. `progressionVoicePhrases()` renders every
// set so a test can hold the whole vocabulary to that line — add a phrasing to a
// set, never a new literal at the call site.
// ============================================================================
import { normalizedExerciseKey } from "./exercise-canon.js";
import { pickDayVariant } from "./brain/day-read-rules.js";

// A set is non-empty by construction: a branch that can reach the athlete without
// words for them is a compile error. Index 0 is the canonical phrasing.
export type VoiceSet = readonly [string, ...string[]];
type Fn1 = (a: string | number) => string;
type Fn2 = (a: string | number, b: string | number) => string;
type Fn3 = (a: string | number, b: string | number, c: string | number) => string;
export type VoiceSet1 = readonly [Fn1, ...Fn1[]];
export type VoiceSet2 = readonly [Fn2, ...Fn2[]];
export type VoiceSet3 = readonly [Fn3, ...Fn3[]];

// Rotate a branch's phrasings for ONE lift on ONE day. `code` names the branch and
// the exercise offsets the index, so two lifts in the same state on the same screen
// read differently while either one stays stable all day.
export function liftVoice<T>(variants: readonly T[], date: string, code: string, exercise: string): T {
  return pickDayVariant(variants, date, `${code}:${normalizedExerciseKey(exercise)}`);
}

// ---- reps-mode verdicts -----------------------------------------------------

export const CONSTRAINED_HOLD: VoiceSet = [
  "This lift has a load-limiting note — hold the weight where you're working and earn clean reps and range first.",
  "There's a load-limiting note on this one — hold the load and win the reps and range before anything else.",
  "A load-limiting note sits on this lift — hold the weight you're using and let clean range come first.",
];

export const REGRESSING_DELOAD: VoiceSet = [
  "Strength has been slipping — back the load off about a tenth and let it rebuild on a clean run.",
  "This one's been sliding — ease the load down a notch and let it come back on a clean stretch.",
  "The numbers have been drifting down — take a small step back on the load and rebuild from there.",
];

export const PLATEAU_GRIND_DELOAD: VoiceSet = [
  "Stuck and grinding at RIR 0–1 with the load flat — a light step back, then a fresh run, usually breaks it.",
  "Flat load and every rep a grind — ease it a touch and come back at it; that's what usually unsticks this.",
  "It's been a grind at the same load — take a small step down and rebuild; stalls tend to break on the way back up.",
];

export const PLATEAU_VARY_TO: VoiceSet2 = [
  (weeks, to) =>
    `Flat about ${weeks} weeks — rotate to ${to} (same movement pattern) to unstick it; keep the rest of the day.`,
  (weeks, to) =>
    `About ${weeks} weeks at the same place — swapping to ${to} (same pattern) tends to get it moving again.`,
  (weeks, to) => `${weeks} weeks flat now — give ${to} a run instead; same pattern, fresh angle.`,
];

export const PLATEAU_VARY_OPEN: VoiceSet1 = [
  (weeks) => `Flat about ${weeks} weeks — rotating to a close variation (same pattern) tends to unstick it.`,
  (weeks) => `About ${weeks} weeks at a standstill — a close variation on the same pattern usually gets it moving.`,
  (weeks) => `${weeks} weeks without movement — a near variation of the same pattern is the usual way through.`,
];

export const PLATEAU_HOLD: VoiceSet = [
  "Flat lately — hold the load and chase a clean extra rep before adding weight.",
  "It's been level for a bit — keep the load and earn one more clean rep first.",
  "Nothing's moved lately — hold here and win an extra clean rep before the weight goes up.",
];

export const NO_HISTORY_PLANNED_HOLD: VoiceSet = [
  "Nothing logged yet — start where the plan sits and log your actual sets.",
  "No sets on this one yet — begin at what's written and log what you really do.",
  "This one has no logged sets yet — start from the planned number and record the real thing.",
];

// Nothing logged for this movement and no number on the plan, but a related lift the
// athlete does train suggests a conservative place to start. Every phrasing has to
// carry that this is an IDEA and that logging replaces it — the number is a
// suggestion the plan has never agreed to, and it is deliberately not stored.
export const RELATED_START_IDEA: VoiceSet2 = [
  (source, load) =>
    `Nothing logged on this one yet — your ${source} suggests starting around ${load}. Log what you actually lift and the next step reads from that.`,
  (source, load) =>
    `No history here yet, so treat this as an idea rather than a number: ${source} puts a sensible start near ${load}. Log the real one.`,
  (source, load) =>
    `You haven't logged this movement yet — going off your ${source}, somewhere around ${load} is a fair place to start. What you log replaces it.`,
];

export const INTRODUCE_VARIATION: VoiceSet3 = [
  (name, weeks, to) =>
    `You've run ${name} steady for about ${weeks} weeks — introduce ${to} (same pattern, room to load heavier) to freshen the stimulus before it goes stale.`,
  (name, weeks, to) =>
    `${name} has been in the rotation about ${weeks} weeks running steady — bring in ${to} (same pattern, more room to load) while it's still working.`,
  (name, weeks, to) =>
    `About ${weeks} weeks of steady ${name} — a turn at ${to} (same pattern, a heavier ceiling) keeps the stimulus fresh.`,
];

export const REP_STAGE_OVERLOAD: VoiceSet1 = [
  (high) =>
    `Reps are climbing at RIR 2+ but not every set has hit ${high} yet — chase a rep toward the top of the range across all your sets before any load. Cap every set, then the weight goes up.`,
  (high) =>
    `The work's strong at RIR 2+, and not every set has reached ${high} yet — add a rep across the board first; the load follows once they all cap.`,
  (high) =>
    `Strong sets at RIR 2+, but not every set is at ${high} — earn that rep everywhere before the weight moves.`,
];

export const BODYWEIGHT_OVERLOAD: VoiceSet = [
  "You've capped the range on a bodyweight movement — add a rep or a set; there's no load to add.",
  "The range is capped and there's no weight to add here — take an extra rep or another set.",
  "You own the range on this bodyweight movement — the next step is a rep or a set, not load.",
];

export const ASSIST_TO_BODYWEIGHT: VoiceSet = [
  "You're nearly off the assist — try the next session at bodyweight.",
  "There's barely any assist left — the next one is worth trying at bodyweight.",
  "The assist has come down to almost nothing — go at bodyweight next time.",
];

export const ASSIST_PEEL: VoiceSet = [
  "You capped the range — peel a little assist off; you're getting stronger.",
  "Range capped — take a little assist away; that's real progress.",
  "You owned the range — a little less assist next time; it's moving.",
];

export const EARNED_RANGE_OVERLOAD: VoiceSet2 = [
  (high, low) =>
    `Every set hit ${high} at RIR 2+ — take the earned step up, then reset to ${low} reps and build the range back up.`,
  (high, low) =>
    `All your sets capped at ${high} with RIR 2+ — the step up is earned; reset to ${low} reps and climb again.`,
  (high, low) =>
    `${high} on every set at RIR 2+ — add the small step, reset to ${low} reps and work back up the range.`,
];

export const EARNED_OPEN_OVERLOAD: VoiceSet = [
  "You hit the top of the range at RIR 2+ — the small earned step up is yours.",
  "Top of the range at RIR 2+ — that earns the small step up.",
  "You capped the range with RIR 2+ to spare — take the small step up.",
];

export const DOSE_UNFINISHED_HOLD: VoiceSet = [
  "This linked session is still unfinished — hold the current target until the full dose is complete.",
  "The linked session hasn't been finished yet — hold this target until the whole dose is in.",
  "That linked session is still open — keep the target here until the full dose lands.",
];

export const DOSE_PARTIAL_HOLD: VoiceSet = [
  "Only part of the linked dose was completed — hold the current target until the full prescription is owned.",
  "Part of the linked dose is missing — hold here until the whole of it is owned.",
  "The linked dose came in partial — keep the target until all of it is done.",
];

export const DOSE_UNDER_HOLD: VoiceSet = [
  "The full linked challenge was not yet completed — hold the current target until every prescribed set is owned.",
  "The linked work came in under what was asked — hold here until every set is owned.",
  "Not all of the linked challenge landed — keep the target until every set is yours.",
];

export const DOSE_NON_COMPARABLE_HOLD: VoiceSet = [
  "The latest linked dose is not comparable progression evidence — hold the current target and reassess after a clean exposure.",
  "The last linked dose doesn't compare cleanly — hold here and read it again after a clean session.",
  "The most recent linked dose isn't a clean comparison — hold the target and revisit it after a straightforward session.",
];

export const NO_HISTORY_HOLD: VoiceSet = [
  "Hold here for now — a couple of logged sessions and the next step reads clearly.",
  "Sit here for now — log a session or two and the next step gets obvious.",
  "Hold for now — once there are a couple of logged sessions the next step is clear.",
];

export const TOP_SET_ONLY_HOLD: VoiceSet1 = [
  (high) =>
    `Your top set hit ${high} but not every set did — hold the load and level all your sets at the top before adding.`,
  (high) => `${high} on the top set, but not every set got there — hold the load and bring them all level first.`,
  (high) => `The top set reached ${high} and not every set followed — keep the load until they all match.`,
];

export const NOT_EARNED_HOLD: VoiceSet = [
  "Not quite earned yet — hold and finish the rep range cleanly at RIR 2+ before adding.",
  "Not there yet — hold the load and close out the rep range cleanly at RIR 2+ first.",
  "Not earned this time — hold here and finish the range clean at RIR 2+ before adding load.",
];

// ---- catching the plan up to reality ----------------------------------------
// Two shapes, because "the plan said a lighter number" and "the plan said nothing
// at all" are different facts and the athlete can tell them apart.

export const PLAN_BEHIND_OVERLOAD: VoiceSet1 = [
  (load) => `Your plan was behind what you're actually lifting — stepping up from your real working weight (${load}).`,
  (load) =>
    `The plan had you lower than you're really lifting — the step comes off your true working weight (${load}).`,
  (load) => `You've moved past what the plan says — building from what you actually handle (${load}).`,
];

export const PLAN_BEHIND_HOLD: VoiceSet1 = [
  (load) =>
    `Your plan was behind what you're lifting — catching it up to your real working weight (${load}); earn a clean extra rep before adding.`,
  (load) =>
    `The plan sat under your real working weight — moving it to ${load}; win a clean extra rep before adding load.`,
  (load) =>
    `You're lifting more than the plan says — catching it up to ${load}; earn one more clean rep before the weight moves.`,
];

export const PLAN_UNSET_OVERLOAD: VoiceSet1 = [
  (load) => `Your plan had no working weight on this yet — stepping up from what you're actually lifting (${load}).`,
  (load) => `Nothing was written down for this one — the step comes from your real working weight (${load}).`,
  (load) => `This slot had no number on it — building from what you actually handle (${load}).`,
];

export const PLAN_UNSET_HOLD: VoiceSet1 = [
  (load) =>
    `Your plan had no working weight on this yet — setting it at what you're actually lifting (${load}); earn a clean extra rep before adding.`,
  (load) =>
    `There was no number on this one — grounding it at your real working weight (${load}); win a clean rep before adding load.`,
  (load) =>
    `This slot was blank — it now sits at ${load}, where you're actually lifting; earn a clean extra rep before adding.`,
];

export const MOVEMENT_RESPONSE_HOLD: VoiceSet = [
  "The last two comparable exposures came in under this dose — hold it here and let the movement catch up.",
  "Both of the last two comparable sessions landed under this dose — keep it here and let the movement catch up.",
  "The last two comparable runs at this came in short — hold the dose and let it catch up.",
];

export const MOVEMENT_RESPONSE_DELOAD: VoiceSet = [
  "The last two comparable exposures both came in under this held dose — ease one bounded step and rebuild.",
  "Both recent comparable exposures came in under this held dose — ease it one small step and rebuild.",
  "The last two comparable sessions landed under this dose while it was held — take one small step down and rebuild.",
];

// ---- timed-mode verdicts (seconds, never load) ------------------------------

export const TIMED_CONSTRAINED_HOLD: VoiceSet = [
  "This hold has a load-limiting note — keep it where it is, don't extend.",
  "There's a load-limiting note on this hold — leave the duration where it is for now.",
  "A load-limiting note sits on this one — hold the same time rather than stretching it.",
];

export const TIMED_REGRESSING_DELOAD: VoiceSet = [
  "Holds have been getting shorter — reset to a duration you own and rebuild.",
  "The times have been slipping — go back to a duration you own and build from there.",
  "These holds have been shrinking — reset to a time you can own and rebuild.",
];

export const TIMED_NO_HISTORY_PLANNED_HOLD: VoiceSet = [
  "Nothing logged yet — start at the planned hold and log your actual time.",
  "No times logged on this yet — start where the plan sits and record the real one.",
  "Nothing recorded here yet — begin at the planned hold and log what you actually get.",
];

export const TIMED_OVERLOAD: VoiceSet2 = [
  (step, base) =>
    `The hold's solid — add ${step}s (a proportional step for a ${base}s hold). Progress timed work in time, never load.`,
  (step, base) =>
    `That hold is owned — take ${step}s more; on a ${base}s hold that's the right size of step. Timed work grows in time, not load.`,
  (step, base) =>
    `Solid hold — stretch it by ${step}s, the proportional step from ${base}s. Time is how this one progresses.`,
];

export const TIMED_DOSE_UNFINISHED_HOLD: VoiceSet = [
  "This linked session is still unfinished — hold the duration until the full dose is complete.",
  "The linked session hasn't been finished yet — keep the duration until the whole dose is in.",
  "That linked session is still open — hold this time until the full dose lands.",
];

export const TIMED_DOSE_PARTIAL_HOLD: VoiceSet = [
  "Only part of the linked timed dose was completed — hold the duration until the full prescription is owned.",
  "Part of the linked timed dose is missing — hold the time until the whole of it is owned.",
  "The linked timed dose came in partial — keep the duration until all of it is done.",
];

export const TIMED_DOSE_UNDER_HOLD: VoiceSet = [
  "The full linked timed challenge was not yet completed — hold until every prescribed interval is owned.",
  "The linked timed work came in under what was asked — hold the duration until every interval is owned.",
  "Not all of the linked timed challenge landed — keep this time until every interval is yours.",
];

export const TIMED_DOSE_NON_COMPARABLE_HOLD: VoiceSet = [
  "The latest linked timed dose is not comparable progression evidence — hold and reassess after a clean exposure.",
  "The last linked timed dose doesn't compare cleanly — hold here and read it again after a clean session.",
  "The most recent linked hold isn't a clean comparison — keep the duration and revisit it after a straightforward session.",
];

export const TIMED_DEFAULT_HOLD: VoiceSet = [
  "Hold this duration until it feels easy, then extend it.",
  "Stay at this duration until it feels easy, then stretch it.",
  "Keep this time until it's comfortable, then add to it.",
];

export const TIMED_RESPONSE_HOLD: VoiceSet = [
  "The last two comparable holds came in under this duration — keep it here until the full dose is owned.",
  "Both of the last two comparable holds landed under this duration — stay here until the whole dose is owned.",
  "The last two comparable holds came in short — keep this duration until it's fully owned.",
];

export const TIMED_RESPONSE_DELOAD: VoiceSet = [
  "The last two comparable holds both came in under this duration — ease one bounded step and rebuild.",
  "Both recent comparable holds came in under this duration — take it down one small step and rebuild.",
  "The last two comparable holds landed short of this duration — ease it a step and rebuild.",
];

// ---- the autoregulation brake (recovery informs, never punishes) ------------

export const JOINT_BRAKE_HOLD: VoiceSet = [
  "Your last check-in flagged a sore joint this lift loads — holding the load today rather than adding; earn a clean, pain-free session first.",
  "You flagged a sore joint this lift loads — keeping the load where it is today; a clean, pain-free session comes first.",
  "There's a sore joint on record that this lift loads — holding today instead of adding, until a session goes through clean.",
];

export const JOINT_BRAKE_DELOAD: VoiceSet = [
  "A sore joint this lift loads is still flagged — easing the load a touch so it can settle before you build again.",
  "That sore joint this lift loads is still on record — taking the load down a touch so it can settle first.",
  "The sore joint this movement loads hasn't cleared — easing the load so it can settle before building again.",
];

export const STRAIN_BRAKE_HOLD: VoiceSet1 = [
  (reason) =>
    `Holding the load today — ${reason}, so this isn't the session to push. Recovery informs the plan; it's a brake, not a penalty.`,
  (reason) =>
    `Keeping the load where it is — ${reason}, so today isn't the day to push. That's a brake, not a penalty.`,
  (reason) => `The load stays put today — ${reason}. Recovery shapes the plan, and none of this is a penalty.`,
];

// ---- fuel protection, in the TRAINING register ------------------------------
// The consequence is a training one, so the sentence on a lift card is a training
// sentence. The calorie mechanics behind it (the size of the move, the settling
// window, the channels that agreed) belong to the nutrition surfaces, which
// already carry them — a lift card that recites them is a register leak, and it
// is what put "no second calorie move is made" on a bench-press card.

export const FUEL_HOLD_STEP: VoiceSet = [
  "Holding this progression step while your fueling settles — the load stays where it is for now.",
  "The step waits while your fueling catches up; today's load stays put.",
  "Your fueling is still settling, so this one holds rather than steps up.",
];

export const FUEL_HOLD_CLAUSE: VoiceSet = [
  "Fueling is still settling, so this isn't the week to push it either.",
  "Your fueling is catching up too, so there's no rush to add here.",
  "Fueling hasn't settled yet either — no hurry to push this one.",
];

export const FUEL_DELOAD_CLAUSE: VoiceSet = [
  "Your fueling is still catching up, so the easier dose stands.",
  "Fueling hasn't caught up yet, so let this lighter dose stand.",
  "With fueling still catching up, the easier dose is the right call.",
];

export const FUEL_RECOVERY_DOSE: VoiceSet = [
  "Your fueling hasn't caught up with the training yet — this exposure is a lighter, easily reversed dose rather than another step.",
  "Training is running ahead of your fueling — take this one as a lighter dose you can step straight back out of.",
  "Fueling is behind the work right now, so this exposure goes lighter instead of taking another step.",
];

// ---- periodization: what the training phase asks of a main lift -------------

// Accumulation: the range is capped but the phase wants one more clean rep on top
// before the load moves. The number is the rep the athlete is reaching for.
//
// That number sits ABOVE the rep window printed on the card, deliberately — the
// phase widens the ask and the plan item is never rewritten (a stored widened
// range would outlive the block). So every phrasing here NAMES the gap rather than
// leaving a card that says 6–8 arguing with a line that asks for 9.
export const ACCUMULATION_REP_STAGE: VoiceSet1 = [
  (top) =>
    `You're in the build stretch, so the ask goes one rep past the card's window — take this to ${top} clean reps on every set before the weight moves.`,
  (top) =>
    `This part of the run is about volume, and it asks for a rep beyond what the card shows: earn ${top} good reps across the sets, then the load steps.`,
  (top) =>
    `Build phase — stack the reps first, one past the range written on the card. ${top} clean on each set, then we add weight.`,
];

// The same widened ask, on the day the top set alone reached it. Separate from
// TOP_SET_ONLY_HOLD because outside a build stretch that number IS the card's own
// ceiling and there is no gap to explain.
export const ACCUMULATION_TOP_SET_ONLY_HOLD: VoiceSet1 = [
  (high) =>
    `Your top set reached ${high} — a rep past the card's window, which is this block's ask — but not every set did, so hold the load until they all get there.`,
  (high) =>
    `${high} on the top set, one beyond the range on the card. That's the build stretch's ask; hold the weight until every set matches it.`,
  (high) =>
    `The top set hit ${high}, which is deliberately a rep over the card's window in this part of the run — keep the load until the rest of the sets follow.`,
];

// Accumulation: a step WAS earned, but the phase takes it small.
export const ACCUMULATION_OVERLOAD: VoiceSet = [
  "Earned, and in a volume stretch the step stays small — take the little one and keep the reps piling up.",
  "That's earned. This part of the run banks work rather than chasing load, so it's a modest step.",
  "You earned the step; in a build stretch it goes up gently and the volume stays the point.",
];

// Intensification: a strong top set at the ceiling buys the step on its own.
export const INTENSIFICATION_OVERLOAD: VoiceSet = [
  "You're in the sharper stretch of the run — a strong set at the top of the range buys the weight, so take it.",
  "This part of the run is about intensity: that top set at the ceiling earns the load, so step it up.",
  "Sharpening now — a clean set at the top of the range is enough to move the weight up.",
];

// A recovery week inside the program: nothing new is added, and that is the point.
export const PHASE_DELOAD_HOLD: VoiceSet = [
  "This is the easy week of the run — the work was there, but hold the weight and let the week do its job.",
  "You earned a step and it can wait: this week is the light one, so keep the load where it is.",
  "Recovery week — the step is banked. Hold here and take it when the week turns over.",
];

// Peak week, on a lift with nothing to test: express, don't add.
export const PHASE_PEAK_HOLD: VoiceSet = [
  "Peak week — this one holds where it is while the main lifts get expressed.",
  "It's the week the run gets shown, so hold this one steady and save the effort for the big lifts.",
  "Nothing new goes on here this week; keep it where it is while the main work gets tested.",
];

// Peak week on a main lift: the top-set protocol. (weight label, reps word)
export const REALIZATION_TOP_SET: VoiceSet2 = [
  (weight, reps) =>
    `Peak week — work up to a heavy ${reps} at ${weight}, then drop back for the rest of the work and call it there.`,
  (weight, reps) =>
    `This is the week to show it: build to ${weight} for ${reps}, then back off for the remaining sets.`,
  (weight, reps) => `Time to express the run — one heavy ${reps} at ${weight}, then lighter back-off work.`,
];

// ---- the cut, as a lever ----------------------------------------------------

// A slip that coincides with live evidence of under-fueling. Cutting the load
// does not fix a fueling problem, so the load holds and the story is told.
export const CUT_REGRESSION_HOLD: VoiceSet = [
  "This one's dipped, and your fueling has been running behind the work — hold the weight rather than cutting it, and let food do the fixing.",
  "The dip lines up with a stretch of eating under the work, so keep the load here; taking weight off wouldn't address what's actually short.",
  "Strength has softened while fueling has been light — hold the load steady and give the food side the room to catch up.",
];

// A slip read off an estimate nothing recent has confirmed.
export const UNVERIFIED_REGRESSION_HOLD: VoiceSet = [
  "This might be the number drifting rather than you — nothing heavy has confirmed it in a while, so hold the load and let a heavy set settle it.",
  "Before cutting anything, hold here: it's been a while since a genuinely heavy set confirmed where this lift sits.",
  "The dip could be the estimate rather than the lift — keep the weight and let one heavy set tell the truth.",
];

// Flat on a real cut: holding IS the win, and it is not a plateau.
export const CUT_HOLDING_WIN: VoiceSet = [
  "You're leaning out and this lift is holding its ground — that's a win, not a stall. Keep the load and take the reps as they come.",
  "Weight's coming down and the load isn't — holding here through a cut is exactly the result to want.",
  "Holding this weight while you're in a deficit counts as progress; stay here and keep the reps clean.",
];

// A long flat stretch that would ordinarily ask for a variation — but the athlete
// is cutting, so patience is the right call.
export const PLATEAU_CUT_HOLD: VoiceSet = [
  "It's been level for a while, though you're eating under maintenance — hold the movement and the load rather than reshuffling mid-cut.",
  "Flat for a stretch, but a cut is a poor time to judge a lift; keep it as it is a bit longer.",
  "Nothing's moved lately and that's fair while you're leaning out — stay with this one for now.",
];

// ---- what the learning ledger's own verdicts add ----------------------------

export const LEDGER_PATIENCE_HOLD: VoiceSet = [
  "This lift has been answering the way we expected lately, so it's earned a little patience — hold and give it another clean run.",
  "Recent calls on this one have landed, which buys time: keep the load and let it come.",
  "It's been level, but this lift has been honest with us lately — hold here rather than reshuffling.",
];

export const LEDGER_MISSED_DELOAD: VoiceSet = [
  "The last few calls on this lift haven't landed the way we expected — ease the load and rebuild from a clean run.",
  "Recent steps here haven't come good, so take the weight down a touch and build back up.",
  "This one keeps falling short of what we asked of it — a small step back is the honest move.",
];

// ---- a second cut is not the answer -----------------------------------------

// Escalation, rep-scheme wave: the window drops instead of the load being cut again.
export const ESCALATE_REP_WAVE: VoiceSet2 = [
  (low, high) =>
    `You've already backed this one off recently, so a second cut isn't the lever — drop into ${low}–${high} reps for a stretch and let heavier sets do the work.`,
  (low, high) =>
    `Cutting the weight again would just repeat what didn't work; run ${low}–${high} reps for a few weeks instead and rebuild the shape.`,
  (low, high) =>
    `Same lift, second step back — change the shape rather than the number: ${low}–${high} reps for a stretch, then re-test.`,
];

// The wave is ALREADY RUNNING. A second wave stacked on the first is the same
// failure one rung up — the shape changed, it just hasn't had time to work yet.
export const ESCALATE_WAVE_SETTLE: VoiceSet = [
  "You're already partway through the heavier rep stretch on this one — let it run its course before anything else changes; that's what it needs to show what it can do.",
  "The lower rep window on this lift is still bedding in. Hold here and let it finish rather than changing the shape again on top of it.",
  "This one is mid-way through its heavier stretch — keep it where it is and give the change already in flight time to land.",
];

// Escalation, forced variation: the movement itself gets rotated.
export const ESCALATE_VARIATION: VoiceSet1 = [
  (to) =>
    `This lift has already had a step back recently — rather than cutting it again, run ${to} for a stretch and come back to it fresh.`,
  (to) => `A second cut here would be more of the same. Give ${to} a run instead, then re-test this one.`,
  (to) => `Twice backed off now — the movement is the thing to change, so take ${to} for a few weeks.`,
];

// ---- the whole vocabulary, rendered ----------------------------------------
// Every phrasing this engine can say, with representative arguments filled in, so
// a test can hold ALL of it to the reading grammar at once. A set added above and
// not listed here is invisible to that test — keep them together.
export function progressionVoicePhrases(): string[] {
  const plain: VoiceSet[] = [
    CONSTRAINED_HOLD,
    REGRESSING_DELOAD,
    PLATEAU_GRIND_DELOAD,
    PLATEAU_HOLD,
    NO_HISTORY_PLANNED_HOLD,
    BODYWEIGHT_OVERLOAD,
    ASSIST_TO_BODYWEIGHT,
    ASSIST_PEEL,
    EARNED_OPEN_OVERLOAD,
    DOSE_UNFINISHED_HOLD,
    DOSE_PARTIAL_HOLD,
    DOSE_UNDER_HOLD,
    DOSE_NON_COMPARABLE_HOLD,
    NO_HISTORY_HOLD,
    NOT_EARNED_HOLD,
    MOVEMENT_RESPONSE_HOLD,
    MOVEMENT_RESPONSE_DELOAD,
    TIMED_CONSTRAINED_HOLD,
    TIMED_REGRESSING_DELOAD,
    TIMED_NO_HISTORY_PLANNED_HOLD,
    TIMED_DOSE_UNFINISHED_HOLD,
    TIMED_DOSE_PARTIAL_HOLD,
    TIMED_DOSE_UNDER_HOLD,
    TIMED_DOSE_NON_COMPARABLE_HOLD,
    TIMED_DEFAULT_HOLD,
    TIMED_RESPONSE_HOLD,
    TIMED_RESPONSE_DELOAD,
    JOINT_BRAKE_HOLD,
    JOINT_BRAKE_DELOAD,
    FUEL_HOLD_STEP,
    FUEL_HOLD_CLAUSE,
    FUEL_DELOAD_CLAUSE,
    FUEL_RECOVERY_DOSE,
    ACCUMULATION_OVERLOAD,
    INTENSIFICATION_OVERLOAD,
    PHASE_DELOAD_HOLD,
    PHASE_PEAK_HOLD,
    CUT_REGRESSION_HOLD,
    UNVERIFIED_REGRESSION_HOLD,
    CUT_HOLDING_WIN,
    PLATEAU_CUT_HOLD,
    LEDGER_PATIENCE_HOLD,
    LEDGER_MISSED_DELOAD,
    ESCALATE_WAVE_SETTLE,
  ];
  const one: Array<[VoiceSet1, string | number]> = [
    [PLATEAU_VARY_OPEN, 4],
    [REP_STAGE_OVERLOAD, 12],
    [TOP_SET_ONLY_HOLD, 12],
    [PLAN_BEHIND_OVERLOAD, "50 lb"],
    [PLAN_BEHIND_HOLD, "50 lb"],
    [PLAN_UNSET_OVERLOAD, "95 lb"],
    [PLAN_UNSET_HOLD, "95 lb"],
    [STRAIN_BRAKE_HOLD, "recent soreness is running high"],
    [ACCUMULATION_REP_STAGE, 13],
    [ACCUMULATION_TOP_SET_ONLY_HOLD, 13],
    [ESCALATE_VARIATION, "Front Squat"],
  ];
  const two: Array<[VoiceSet2, string | number, string | number]> = [
    [PLATEAU_VARY_TO, 4, "Front Squat"],
    [RELATED_START_IDEA, "Bench Press", "75 lb"],
    [EARNED_RANGE_OVERLOAD, 12, 8],
    [TIMED_OVERLOAD, 5, 45],
    [REALIZATION_TOP_SET, "205 lb", "single"],
    [ESCALATE_REP_WAVE, 3, 5],
  ];
  const three: Array<[VoiceSet3, string | number, string | number, string | number]> = [
    [INTRODUCE_VARIATION, "Back Squat", 13, "Front Squat"],
  ];
  return [
    ...plain.flatMap((set) => [...set]),
    ...one.flatMap(([set, a]) => set.map((fn) => fn(a))),
    ...two.flatMap(([set, a, b]) => set.map((fn) => fn(a, b))),
    ...three.flatMap(([set, a, b, c]) => set.map((fn) => fn(a, b, c))),
  ];
}
