// WHY A VERDICT CAME BACK INCONCLUSIVE, IN THE MACHINE REGISTER.
//
// An `inconclusive` verdict is honest only when its reason is true, and a loop that
// returns nothing but `inconclusive` has to be able to say WHICH reason is silencing
// it — a live audit found every exercise expectation in 90 days inconclusive, and the
// cause (one blanket context rule) was invisible without reading confounder prose row
// by row. `brain_evaluations` stores the confounders as plain sentences, so the reason
// is CLASSIFIED from them here rather than stored in a new column: the classification
// is deterministic, it reads every historical row the same way it reads a new one, and
// it adds no schema.
//
// The sentences this module introduces are exported as constants and emitted from
// those constants (evaluators.ts, evaluation-service.ts), so a reason code can never
// drift from the text it classifies. The older sentences are matched by pattern.
// Operator diagnostics only — never an athlete-facing surface.

export const INCONCLUSIVE_REASON_CODES = [
  // A material context event (trip, injury, tag) overlapped a window-level metric.
  "context_event",
  // Every exposure in the window fell inside a context event, so none was clean.
  "context_excluded_all",
  // Another live change targeted the same outcome over the same span.
  "overlapping_decision",
  // Evidence existed but fell short of the expectation's own minimum.
  "thin_sample",
  // The subject (movement, session, run) never appeared in the window.
  "not_exposed",
  // The subject could not be resolved to anything the evaluator can read.
  "subject_unmatched",
  // There was no prescription / prescribed amount to measure the work against.
  "no_prescription",
  // The decision did not actually move the prescription this expectation is about.
  "no_change",
  // The stored target cannot be judged without guessing.
  "target_uncomparable",
  // A comparison was possible but no evidence row backed it.
  "no_evidence_rows",
  // The data the metric reads (intake, feedback, a lab draw, a re-tape) is absent.
  "data_missing",
  // Data was present but could not support a decisive reading (unmeasured runs,
  // ungraded work, a shock on the scale, incompatible units).
  "unverifiable",
  // Logged intake diverged from, or could not be read against, the meal plan.
  "meal_plan_confounded",
  // A same-day read whose day was not over, or a read kind that predicts nothing.
  "day_not_closed",
  // The stored evaluator does not match the registered one.
  "evaluator_mismatch",
  // The evaluator threw. Recorded so a failing evaluator is visible, not skipped.
  "evaluator_error",
  "other",
] as const;
export type InconclusiveReasonCode = (typeof INCONCLUSIVE_REASON_CODES)[number];

export const INCONCLUSIVE_REASON_TEXT = {
  context_excluded_all: "Every exposure in the window fell inside a context event, so none could be read cleanly",
  no_prescription: "No prescription (reps, load or time) was stored to measure the logged work against.",
  no_change: "The decision did not change this movement's prescription, so there is no change to judge.",
  unchecked_criteria: "The target also named criteria this evaluator cannot check, so only a miss could be read",
  evaluator_error: "The evaluator failed on this expectation",
  unplaced_pain: "Pain was reported in the window that could not be placed against this subject",
} as const;

// Ordered: the first matching rule wins, so the specific patterns come first.
const RULES: ReadonlyArray<[InconclusiveReasonCode, RegExp]> = [
  ["evaluator_error", /^The evaluator failed/i],
  ["context_excluded_all", /^Every exposure in the window fell inside a context event/i],
  ["context_event", /^Context event .* overlapped the evaluation window/i],
  ["overlapping_decision", /also targeted this outcome/i],
  ["thin_sample", /^Only \d+(\.\d+)? .* were available; .* were required/i],
  ["thin_sample", /at least two comparable loaded exercise exposures/i],
  ["thin_sample", /needs at least \d+ readings/i],
  ["thin_sample", /did not cover enough distinct days|did not contain enough comparable nights/i],
  ["subject_unmatched", /could not be matched to a known movement|subject is required|site is required/i],
  ["no_prescription", /^No prescription|No prescribed running distance/i],
  ["no_change", /did not change this movement's prescription/i],
  ["not_exposed", /not exposed during the evaluation window|requires exposure and none was observed/i],
  ["not_exposed", /No running was logged|No sessions were logged|No planned session exposure/i],
  ["target_uncomparable", /could not be compared deterministically|criteria this evaluator cannot check/i],
  ["no_evidence_rows", /No supporting evidence rows/i],
  ["meal_plan_confounded", /meal plan/i],
  ["data_missing", /no credible completed intake days|No session performance feedback was recorded/i],
  ["data_missing", /follow-up marker draw was not available|follow-up measurement was not available/i],
  ["unverifiable", /without distance|terminal scale change is unconfirmed|could not be graded|incompatible units/i],
  ["unverifiable", /could not be placed against this subject/i],
  ["day_not_closed", /had not closed yet|does not make a prediction/i],
  ["evaluator_mismatch", /evaluator does not match/i],
];

export function classifyInconclusiveReason(confounder: string): InconclusiveReasonCode {
  const text = String(confounder ?? "");
  for (const [code, pattern] of RULES) if (pattern.test(text)) return code;
  return "other";
}

/** The distinct reason codes behind one inconclusive verdict, in first-seen order. */
export function inconclusiveReasons(confounders: readonly string[] | null | undefined): InconclusiveReasonCode[] {
  const out: InconclusiveReasonCode[] = [];
  for (const item of confounders ?? []) {
    const code = classifyInconclusiveReason(item);
    if (!out.includes(code)) out.push(code);
  }
  return out.length ? out : ["other"];
}
