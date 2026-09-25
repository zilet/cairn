// THE READ'S CALL — the vocabulary of a day-read verdict, in one place.
//
// Pure: no DB, no clock. read-adherence.ts judges a day (behaviour + the harm test)
// and hands the result to `dayReadCall`; the evaluator, the Team week, the Learned
// timeline, the reaction model and operator diagnostics all read the SAME call back
// and speak it through the tables below, so no surface keeps a parallel switch over
// what "too_cautious" means or how it is said.
//
// ---------- THE VERDICT JUDGES THE READ, NOT THE ATHLETE (owner ruling, 2026-09-25) ----------
//
// "I follow the path and alternate exercises, weights and volume to what I can do and
// feel good about — treat that as a signal back to the brain." The adherence outcome
// (read-adherence.ts) is a fact about BEHAVIOUR (followed / diverged) and stays exactly
// as it is: the softening ladders and the look-back read it. But the ledger's verdict
// on a `day_read_adherence` expectation used to be that same behavioural fact, so a day
// the athlete trained through a quiet read and came through fine was stored
// `not_aligned` and rendered to them as "didn't land the way we expected" — the athlete
// scored as the miss, when the evidence is actually about the READ.
//
// So the verdict now asks whether the READ's call held, and names which way it was off:
//
//   held          the athlete did what the read suggested (for a train read: logged
//                 ANY training — a session shaped live, other exercises, other loads,
//                 more or fewer sets, a skipped slot, all of it counts). → aligned
//   vindicated    a quiet (rest/easy) read trained through, and harmEvidenceOnDay found
//                 a cost — the read's caution fit the day.                → aligned
//   too_cautious  a quiet read trained through with NOTHING saying it cost them — the
//                 read was more cautious than the day needed. This is calibration
//                 evidence about the read, the exact evidence the three softening
//                 ladders already act on (restOverrideSoftening,
//                 easyOverrideSoftening, trainsAnywayWithoutHarm), read through the
//                 SAME harm test, so the ledger and the ladders cannot disagree about
//                 which mornings were harmless.                            → not_aligned
//   not_taken     a train read with nothing logged — the other direction: the day the
//                 athlete chose was quieter than the read.                 → not_aligned
//   unclear       ungraded work on an easy read.                          → inconclusive
//
// `not_aligned` therefore always means "the read was off", never "the athlete missed".
// Harm needs the NEXT morning (rating, physiology, readiness), so a quiet read that was
// trained through is not judged until that morning has closed too
// (dayReadExpectationAwaitingMorning, read-adherence.ts).
import type { HarmEvidence, PredictiveDayReadKind, ReadAdherenceOutcome } from "./read-adherence.js";

export type DayReadCall = "held" | "vindicated" | "too_cautious" | "not_taken" | "unclear";
// The calls a conclusive (aligned / not_aligned) verdict can carry.
export type ConclusiveDayReadCall = Exclude<DayReadCall, "unclear">;

const CONCLUSIVE_CALLS = new Set<string>(["held", "vindicated", "too_cautious", "not_taken"]);

export function isConclusiveDayReadCall(value: unknown): value is ConclusiveDayReadCall {
  return typeof value === "string" && CONCLUSIVE_CALLS.has(value);
}

// The one mapping from behaviour + harm to the read's call. `harm` is consulted only
// for a quiet read that was trained through; pass null anywhere else.
export function dayReadCall(kind: string, outcome: ReadAdherenceOutcome, harm: HarmEvidence | null): DayReadCall {
  if (outcome === "unclear") return "unclear";
  if (outcome === "followed") return "held";
  if (kind === "train") return "not_taken";
  return harm ? "vindicated" : "too_cautious";
}

// Does judging this read's call need the harm test? Only a quiet read the day went
// past — every other shape is settled by the log alone.
export function dayReadCallNeedsHarm(kind: string, outcome: ReadAdherenceOutcome): boolean {
  return (kind === "rest" || kind === "easy") && outcome === "diverged";
}

// The calls that rested on the harm test — a late rating or a next-morning reading can
// still move them after the verdict was written.
export function dayReadCallRestsOnHarm(call: unknown): boolean {
  return call === "too_cautious" || call === "vindicated";
}

// Was the READ off? The calls a `not_aligned` verdict stands for.
export function dayReadCallWasOff(call: DayReadCall): boolean {
  return call === "too_cautious" || call === "not_taken";
}

// What the VERDICT measures, in plain words — stored on every verdict beside the
// behavioural `measures` so a reader can never mistake one for the other.
export const DAY_READ_CALL_MEASURES: Readonly<Record<PredictiveDayReadKind, string>> = Object.freeze({
  train: "any training was logged, however the session was shaped",
  easy: "the day stayed at or below easy, or going past it showed a cost afterwards",
  rest: "no training was logged, or training through it showed a cost afterwards",
});

// ---------- the words each call is spoken in ----------

// The evaluator's verdict explanation, stored on the evaluation in place of the generic
// "landed / did not land within the expectation" line.
export const DAY_READ_CALL_EXPLANATION: Readonly<Record<ConclusiveDayReadCall, string>> = Object.freeze({
  held: "The day went the way the morning read suggested, so its call held.",
  vindicated: "Training went past a quiet read and a cost showed afterwards, so the read's caution fit the day.",
  too_cautious:
    "Training went past a quiet read with nothing afterwards saying it cost anything, so the read was more cautious than the day needed — the quiet reads learn from it.",
  not_taken: "A training read met a quieter day than it expected — information about that day, never a miss.",
});

// The Learned timeline's title for a judged morning read — never "a result Cairn is
// adjusting from" over a day the athlete simply trained through and came through fine.
export const DAY_READ_CALL_TITLES: Readonly<Record<ConclusiveDayReadCall, string>> = Object.freeze({
  held: "A morning read you took",
  too_cautious: "A morning read more cautious than the day needed",
  vindicated: "A quiet morning read the day after backed up",
  not_taken: "A training morning you kept quiet",
});

// The Team week's landed line. The generic "Day read adherence didn't land the way we
// expected" read to the athlete as being marked down for training through an easy
// morning they came through fine, so each call speaks in its own words: a harmless day
// past a quiet read is the team LEARNING, a vindicated one keeps the caution without a
// told-you-so, and a training read however the session was shaped is simply taken.
// Variant sets (pickDayVariant keyed on the read's own date), never one literal.
export type DayReadLandedKey =
  | "too_cautious_easy"
  | "too_cautious_rest"
  | "vindicated"
  | "held_train"
  | "held_quiet"
  | "not_taken";

export const DAY_READ_LANDED_VARIANTS: Readonly<Record<DayReadLandedKey, readonly [string, ...string[]]>> = {
  too_cautious_easy: [
    "You trained through an easy read and came through fine — the read will lean less cautious.",
    "You went past an easy read with nothing afterwards saying it cost you, so the easy calls are learning from it.",
    "An easy morning you turned into real training went fine — the team reads that as what you can carry.",
  ],
  too_cautious_rest: [
    "You trained through a rest read and came through fine — the read will lean less cautious.",
    "You went ahead on a rest morning with nothing afterwards saying it cost you, so the rest calls are learning from it.",
    "A rest morning you trained through went fine — the team reads that as what you can carry.",
  ],
  vindicated: [
    "You trained through a quiet read and it showed a cost afterwards, so the team keeps that caution where it was.",
    "A quiet morning you trained through asked for some room afterwards — the team holds that caution for now.",
  ],
  held_train: [
    "You trained on a training read — shaping the session as you went counts as taking it.",
    "A training morning you shaped to how you felt landed the way the read expected.",
  ],
  held_quiet: [
    "A quiet read you took landed the way the team expected.",
    "You took a quiet morning as read, and it landed as expected.",
  ],
  not_taken: [
    "You kept a training morning quiet — the team takes that as information about the day, nothing to make up.",
    "A training read you sat out tells the team something about that day; nothing to make up.",
  ],
};

export function dayReadLandedKey(call: ConclusiveDayReadCall, kind: string): DayReadLandedKey {
  if (call === "too_cautious") return kind === "rest" ? "too_cautious_rest" : "too_cautious_easy";
  if (call === "held") return kind === "train" ? "held_train" : "held_quiet";
  return call;
}
