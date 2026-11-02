// What a finished-goal review may never say (src/repo/goal-reviews.ts, the goal_review op).
//
// A review is a MEASURE said back, never a verdict. The reading grammar
// (day-read-grammar.ts: no leaked internals, no score, no gate) holds every sentence,
// and on top of it a review may not GRADE the result against the target the goal
// carried: "you missed your sub-2 target by ten minutes", "fell short of the goal",
// "beat your target", "a disappointing day". The target is context the agent is shown so
// the story can say what the athlete was aiming at — never the yardstick the result is
// held to. A leaf: no db, no imports beyond the grammar, so agent-contracts.ts can use it.
import { violatesReadingGrammar } from "./day-read-grammar.js";

// Each pattern is a grading SHAPE, phrase-level, so "the target pace you trained at"
// (a fact) is not caught while "behind your target" (a verdict) is.
const GRADING_PATTERNS: readonly RegExp[] = [
  // "missed / fell short of / beat / exceeded / ahead of / behind / off ... target|goal"
  /\b(?:miss(?:ed|ing)?|fell\s+short|short\s+of|beat|beaten|beating|exceed(?:ed|ing)?|surpass(?:ed)?|ahead\s+of|behind|outside|off)\b[^.;:!?]{0,40}\b(?:target|goal(?:\s+time|\s+pace)?|aim)\b/i,
  // "the target ... was missed / beaten / not met / met / hit"
  /\b(?:target|goal(?:\s+time)?)\b[^.;:!?]{0,30}\b(?:missed|beaten|not\s+met|unmet|achieved|met|hit|smashed|blown)\b/i,
  // A verdict word on the result.
  // ("passed"/"failed" stay out on purpose: "you passed 10 km at 1:01" is a fact.)
  /\b(?:grade[ds]?|graded|disappoint(?:ing|ment|ed)?|underperform(?:ed|ance)?|letdown|let\s+down)\b/i,
];

/** True when `text` holds the result against the target or passes a verdict on it. */
export function gradesAgainstTarget(text: unknown): boolean {
  const sentence = String(text ?? "");
  if (!sentence.trim()) return false;
  return GRADING_PATTERNS.some((pattern) => pattern.test(sentence));
}

/**
 * The first rule an athlete-facing review sentence breaks — the reading grammar's
 * own rule name, or "grades_target" — or null when it holds the line.
 */
export function goalReviewTextViolation(text: unknown): string | null {
  return violatesReadingGrammar(text) ?? (gradesAgainstTarget(text) ? "grades_target" : null);
}
