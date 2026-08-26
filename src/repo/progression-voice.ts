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

// The same rep stage, spoken WITHOUT a felt rating — the wording used whenever no
// RIR was logged on the last exposure. Telling someone who never rates a set to
// come back "at RIR 2+" is an instruction they cannot follow; the reps are the ask.
export const REP_STAGE_OVERLOAD_REPS: VoiceSet1 = [
  (high) =>
    `Not every set has reached ${high} yet — chase a rep toward the top of the range across all your sets. Cap every set and the weight goes up.`,
  (high) => `The reps are climbing. Get every set to ${high} first; the load follows once they all cap.`,
  (high) => `Still a rep to win — bring every set up to ${high}, and then the weight moves.`,
  (high) => `Add a rep across the board before any load: ${high} on every set is what buys the step.`,
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

// The earned LOAD step, spoken in reps. Capping the range on every set IS the
// signal when nothing was rated — so the sentence credits the work that happened
// rather than a rating that was never given.
export const EARNED_RANGE_OVERLOAD_REPS: VoiceSet2 = [
  (high, low) =>
    `Every set hit ${high} — you capped the range, so take the earned step up and reset to ${low} reps.`,
  (high, low) => `All your sets reached ${high}. The range is yours; step the weight up and build back from ${low}.`,
  (high, low) => `${high} on every set — that's the range capped. Add the small step and climb again from ${low}.`,
  (high, low) => `You owned ${high} across the board — the step up is earned; back to ${low} reps at the new weight.`,
];

export const EARNED_OPEN_OVERLOAD_REPS: VoiceSet = [
  "You capped the range — the small earned step up is yours.",
  "Top of the range on the work that counted — that earns the small step up.",
  "The range is capped, so the weight moves: take the small step.",
  "You finished the range clean — add the small step next time out.",
];

export const DOSE_UNFINISHED_HOLD: VoiceSet = [
  "This session isn't finished yet — complete the remaining sets and the weight can move.",
  "The session is still open — finish it out and then the load is free to step.",
  "Not done logging this one — once the rest of the sets are in, the weight can move.",
  "Finish the rest of today's sets on this lift; that's when the load is free to move.",
];

export const DOSE_PARTIAL_HOLD: VoiceSet = [
  "Log the rest of this movement's sets and the weight can move.",
  "The other sets on this one still need logging — once they're in, the weight can move.",
  "Finish writing down the remaining sets on this movement; that's when the load is free to step.",
  "Until the rest of this movement's sets are logged, the weight stays put — then it can move.",
];

export const DOSE_UNDER_HOLD: VoiceSet = [
  "Not every set landed as written — finish the range clean and it moves.",
  "The work came in under what was asked — hold here until every set is yours.",
  "Not all of the work landed — keep the weight until you own every set.",
  "Hold this load and complete every set as written; that's when it steps.",
];

export const DOSE_NON_COMPARABLE_HOLD: VoiceSet = [
  "That day didn't count the same — one clean run at this weight and it moves.",
  "The last session isn't a clean read — hold here and take one straightforward run at this weight.",
  "Last time wasn't a fair look at this load — keep it and earn one clean session.",
  "Hold the weight; last session wasn't like-for-like, so one clean run here is what moves it.",
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

// The not-earned hold, spoken in reps. The ask has to be something the athlete can
// actually go and do: cap the range on every set.
export const NOT_EARNED_HOLD_REPS: VoiceSet = [
  "Not quite there — hold the load and take every set to the top of the range; that's what moves it.",
  "Hold here for now. Cap the rep range on every set and the weight goes up.",
  "Not earned this time — keep the weight and finish the range out on all your sets first.",
  "Stay at this load and own the top of the range across the board; the step comes right after.",
];

// The work capped the range but the last set was rated a grind. The RIR IS what the
// athlete told us here, so naming it is honest — and it is the one thing that turns
// a completed range into a hold.
export const GRIND_HOLD: VoiceSet = [
  "You finished the range, but that last set was a grind at RIR 0–1 — hold the weight and take one cleaner run at it.",
  "The reps were there and the effort was maxed out at RIR 0–1. Keep this load until it comes back with a rep or two in reserve.",
  "That went up as a grind — hold here, and the weight moves once the same work leaves you RIR 2+.",
  "Range done, but nothing left in the tank at the end — stay at this load for one more clean session before stepping.",
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
  "The last two runs at this weight came in short — hold it here and let the movement catch up.",
  "Both of the last two sessions landed under this load — keep it here and let the movement catch up.",
  "The last two times at this weight came in short — hold here and let it catch up.",
];

export const MOVEMENT_RESPONSE_DELOAD: VoiceSet = [
  "The last two runs at this held weight both came in short — ease one small step and rebuild.",
  "Both recent sessions landed under this held load — take it down one small step and rebuild.",
  "The last two sessions landed short while this was held — take one small step down and rebuild.",
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
  "This session isn't finished yet — complete the remaining holds and the time can move.",
  "The session is still open — finish it out and then the duration is free to stretch.",
  "Not done logging this one — once the rest of the holds are in, the time can move.",
  "Finish the rest of today's holds; that's when the duration is free to extend.",
];

export const TIMED_DOSE_PARTIAL_HOLD: VoiceSet = [
  "Log the rest of this movement's holds and the time can move.",
  "The other holds on this one still need logging — once they're in, the duration can stretch.",
  "Finish writing down the remaining holds; that's when the time is free to extend.",
  "Until the rest of this movement's holds are logged, the duration stays put — then it can move.",
];

export const TIMED_DOSE_UNDER_HOLD: VoiceSet = [
  "Not every hold landed as written — finish the full time clean and it moves.",
  "The work came in under what was asked — hold this duration until every interval is yours.",
  "Not all of the timed work landed — keep this time until you own every hold.",
  "Stay at this duration and complete every hold as written; that's when it extends.",
];

export const TIMED_DOSE_NON_COMPARABLE_HOLD: VoiceSet = [
  "That day didn't count the same — one clean run at this time and it moves.",
  "The last session isn't a clean read — hold this duration and take one straightforward run.",
  "Last time wasn't a fair look at this hold — keep it and earn one clean session.",
  "Hold the time; last session wasn't like-for-like, so one clean run here is what moves it.",
];

export const TIMED_DEFAULT_HOLD: VoiceSet = [
  "Hold this duration until it feels easy, then extend it.",
  "Stay at this duration until it feels easy, then stretch it.",
  "Keep this time until it's comfortable, then add to it.",
];

export const TIMED_RESPONSE_HOLD: VoiceSet = [
  "The last two holds came in under this duration — keep it here until the full time is yours.",
  "Both of the last two holds landed under this duration — stay here until you own the whole time.",
  "The last two holds came in short — keep this duration until it's fully yours.",
];

export const TIMED_RESPONSE_DELOAD: VoiceSet = [
  "The last two holds both came in under this duration — ease one small step and rebuild.",
  "Both recent holds landed under this duration — take it down one small step and rebuild.",
  "The last two holds landed short of this duration — ease it a step and rebuild.",
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

// ---- the pain traffic light, per movement -----------------------------------
// Amber is a WAIT, not a verdict: the load holds and the next exposure answers the
// question. Red is a step down on THIS movement only — everything else in the
// session keeps training, which is the law and also what the sentence must convey.
// No numbers, no diagnosis, and never an instruction to rest.

export const PAIN_AMBER_HOLD: VoiceSet = [
  "You mentioned this one bothering you and nothing since has said how it settled — holding the load here until the next go tells us.",
  "Keeping this load where it is: the last note said it bothered you, and the next session is what answers whether it settled.",
  "Holding here rather than adding — you flagged this movement recently, and how it feels next time is the thing worth knowing.",
];

// Red, on a lift with no external load to take off (bodyweight, assisted, or a hold
// with no duration on record). The load cannot come down, so the sentence must not
// say it did — but this is NOT the amber sentence either: amber is waiting to hear
// how it settled, and here the athlete has already told us it did not.
export const PAIN_RED_HOLD: VoiceSet = [
  "That one hasn't settled between sessions, so it stays exactly where it is today rather than going up — nothing else in the session changes.",
  "This movement is still speaking up between sessions, so it holds here for now. Everything else runs as planned.",
  "Still unsettled on this one, so it stays put today — no added work on it, and the rest of the day is untouched.",
];

export const PAIN_RED_REDUCE: VoiceSet = [
  "This one hasn't settled between sessions, so it comes down a step — just this movement; the rest of the session runs as planned.",
  "Easing the load on this movement since it's still speaking up between sessions. Nothing else in the day changes.",
  "Taking a step off this lift while it's still unsettled — everything else you're doing stays exactly where it is.",
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

// The athlete asked to be pushed, so a soft fueling read no longer takes an earned
// step away — it takes the near-maximal top set instead, which is the part of the
// day that actually costs something to run underfed. A LOAD step that survives that
// way speaks through LOG_EARNED_FUEL_PARK_SINGLE (the sentence names the step the
// log earned, not the push setting); this set is for a rotation or a fresh movement
// rather than a load step. The fueling read still takes the costly near-maximal
// single off; it does not cancel the change of movement the athlete asked to keep.
export const PUSH_FUEL_VARIETY_KEEP: VoiceSet = [
  "You've asked to keep pushing, so this rotation still happens — skip the near-maximal single while your fueling catches up.",
  "The fresh movement still goes in, since pushing is what you asked for; leave the heavy single for a day your fueling is further along.",
  "Keeping the variation because you asked to push — the near-maximal top set can wait until your fueling is further along.",
];

// NOTE: there is deliberately no "…and fueling too" CLAUSE here any more. A clause
// is something appended to an item's OWN sentence, and the only branch that ever
// did that was a lift already holding for its own unrelated reason — which is
// exactly the register leak that put somebody else's explanation on a lift card.
// Every item the fuel read actually changes now carries a whole fuel sentence of
// its own: FUEL_HOLD_STEP when the step is held, LOG_EARNED_FUEL_PARK when the
// log earned a step that stands (no single mentioned), LOG_EARNED_FUEL_PARK_SINGLE
// when a top set actually came off, PUSH_FUEL_VARIETY_KEEP when a rotation/introduce
// stands and only the single waits, FUEL_DELOAD_CLAUSE on work already going
// down, FUEL_RECOVERY_DOSE when the read cuts the session itself.

export const FUEL_DELOAD_CLAUSE: VoiceSet = [
  "Your fueling is still catching up, so the easier session stands.",
  "Fueling hasn't caught up yet, so let this lighter work stand.",
  "With fueling still catching up, the easier session is the right call.",
];

export const FUEL_RECOVERY_DOSE: VoiceSet = [
  "Your fueling hasn't caught up with the training yet — this session is lighter, and easily reversed, rather than another step.",
  "Training is running ahead of your fueling — take this one lighter, something you can step straight back out of.",
  "Fueling is behind the work right now, so this session goes lighter instead of taking another step.",
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

// The athlete has asked to be pushed, so a strong top set at the ceiling buys the
// step outside a sharpening stretch too. The sentence NAMES that — it must never
// claim every set capped, because under this rule they did not have to.
export const PUSH_TOP_SET_OVERLOAD: VoiceSet1 = [
  (high) =>
    `Your top set owned ${high} at RIR 2+, and you've asked to be pushed — so that buys the step up rather than waiting for the others to match.`,
  (high) =>
    `${high} on the top set with RIR 2+ to spare. You asked for the harder read, so the weight moves now instead of waiting on the rest of the sets.`,
  (high) =>
    `You asked to push, and the top set hit ${high} at RIR 2+ — take the small step up; the other sets can catch up at the new weight.`,
];

// The same push rule with no felt rating logged: the top set capping the ceiling is
// the whole evidence, and the sentence says only that.
export const PUSH_TOP_SET_OVERLOAD_REPS: VoiceSet1 = [
  (high) =>
    `Your top set owned ${high} and you've asked to be pushed — so that buys the step up rather than waiting for the others to match.`,
  (high) =>
    `${high} on the top set. You asked for the harder read, so the weight moves now instead of waiting on the rest of the sets.`,
  (high) => `You asked to push, and the top set hit ${high} — take the small step up; the other sets catch up at the new weight.`,
  (high) => `Top set at ${high}, and you want to be pushed: the load steps now, and the rest of the sets follow it up.`,
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

// A promotion that went through under a soft fuel hold: the log earned the
// step, fueling is still settling. No single is mentioned — this set is for
// lifts that never had a top set to park. Never "holding in a deficit counts
// as progress" on a lift that just got heavier.
export const LOG_EARNED_FUEL_PARK: VoiceSet = [
  "The work you logged earned this step, so the load moves while your fueling catches up.",
  "You already lifted this; the weight goes up because of that, and fueling can catch up around it.",
  "The log is what moved this load. Keep the step you earned while fueling settles.",
  "This one goes up because of what you actually lifted. Fueling is still catching up.",
];

// Same promotion, but a challenge top set actually came off — only the
// applyFuelProtection push path that strips `top_set`.
export const LOG_EARNED_FUEL_PARK_SINGLE: VoiceSet = [
  "The work you logged earned this step, so the load moves — skip the heavy single today while your fueling catches up.",
  "You already lifted this; the weight goes up because of that. Leave the near-maximal single for a day your fueling is further along.",
  "The log is what moved this load. Keep the step you earned, and let the heavy top set wait while fueling settles.",
  "This one goes up because of what you actually lifted. The heavy single can wait until your fueling is further along.",
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
    PAIN_AMBER_HOLD,
    PAIN_RED_HOLD,
    PAIN_RED_REDUCE,
    FUEL_HOLD_STEP,
    PUSH_FUEL_VARIETY_KEEP,
    FUEL_DELOAD_CLAUSE,
    FUEL_RECOVERY_DOSE,
    ACCUMULATION_OVERLOAD,
    INTENSIFICATION_OVERLOAD,
    PHASE_DELOAD_HOLD,
    PHASE_PEAK_HOLD,
    CUT_REGRESSION_HOLD,
    UNVERIFIED_REGRESSION_HOLD,
    CUT_HOLDING_WIN,
    LOG_EARNED_FUEL_PARK,
    LOG_EARNED_FUEL_PARK_SINGLE,
    PLATEAU_CUT_HOLD,
    LEDGER_PATIENCE_HOLD,
    LEDGER_MISSED_DELOAD,
    ESCALATE_WAVE_SETTLE,
    EARNED_OPEN_OVERLOAD_REPS,
    NOT_EARNED_HOLD_REPS,
    GRIND_HOLD,
  ];
  const one: Array<[VoiceSet1, string | number]> = [
    [PLATEAU_VARY_OPEN, 4],
    [REP_STAGE_OVERLOAD, 12],
    [TOP_SET_ONLY_HOLD, 12],
    [PUSH_TOP_SET_OVERLOAD, 12],
    [REP_STAGE_OVERLOAD_REPS, 12],
    [PUSH_TOP_SET_OVERLOAD_REPS, 12],
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
    [EARNED_RANGE_OVERLOAD_REPS, 12, 8],
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
