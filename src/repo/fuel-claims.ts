// "You're eating under your target" has ONE source: the server's fuel read.
//
// Measured live (2026-10-13): handed a 21-day intake average beside a target that took
// effect that morning, two of four CLIs told a well-fuelled athlete they were "eating well
// under target" and to "eat closer to your target" — while underfueling() itself read
// insufficient_signal (no day was ever compared against that target) and every channel
// it reads (weight trend in band, steady energy, lifts progressing) supported the
// intake. A model doing its own arithmetic on an average is exactly the inference the
// fuel read exists to make carefully: per credible day, against the target IN FORCE that
// day, inside a deadband, corroborated. So a claim that the athlete eats too little is
// spoken only when that read says so, and a prompt that carries the numbers carries
// this rule with them.
import type { UnderfuelingRead, UnderfuelingState } from "./underfueling.js";

// The states in which the read itself found intake short: meals landing under a
// workable target, a target too low for the work, or strain that has held.
const SHORT_STATES: ReadonlySet<UnderfuelingState> = new Set([
  "execution_gap",
  "prescription_strain",
  "persistent_strain",
]);

/** Whether the server's own fuel read backs saying the athlete eats too little. */
export function underEatingSupported(read: Pick<UnderfuelingRead, "state"> | null | undefined): boolean {
  return !!read && SHORT_STATES.has(read.state);
}

// Under-eating, under-fuelling, eating below/under/short of a target or goal, and the
// adherence push that follows from it. Narrow on purpose: "under your cut's floor" in a
// plan, or "a lighter dinner", is not a claim about what the athlete has been eating.
const UNDER_EATING_CLAIM = new RegExp(
  [
    String.raw`\bunder-?(?:eat|eating|ate|fuel|fuell?ing|fuell?ed)\b`,
    String.raw`\bnot eating enough\b`,
    String.raw`\b(?:eat|eating|ate|intake|calories|food|meals?)\b[^.!?]{0,40}\b(?:well |far |way |a lot |noticeably |consistently )?(?:under|below|short of|less than|lighter than)\b[^.!?]{0,25}\b(?:target|goal|intake you set)\b`,
    String.raw`\beat(?:ing)? (?:closer to|up to|more toward|nearer) (?:your|the) (?:target|goal)\b`,
  ].join("|"),
  "i"
);

/** Whether a piece of athlete-facing prose claims the athlete has been eating too little. */
export function claimsUnderEating(text: unknown): boolean {
  return typeof text === "string" && UNDER_EATING_CLAIM.test(text);
}

/** The rule, as said to a model whose DATA carries intake numbers. */
export const FUEL_CLAIM_RULE = `- EATING TOO LITTLE IS THE SERVER'S CALL, NOT YOURS. Say the athlete is eating under their target, under-fuelling, or should "eat closer to the target" ONLY when DATA.underfueling.state is execution_gap, prescription_strain or persistent_strain — and then in its words, adherence-neutral, never blame. Any other state (insufficient_signal, near_target, settling, uncertain) means no such claim. Never compare an intake average (expenditure.intake_avg_kcal, a nutrition target's basis, a week of meals) to the target yourself: a target set recently was never in force on the days behind that average, and the fuel read already weighed every credible day.`;
