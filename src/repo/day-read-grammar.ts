// The reading grammar — VISION.md Amendment 2 as a predicate, in ONE place.
//
// Split out of day-read.ts (W2-H2): the grammar is the constitution's enforcement
// point and depends on nothing else in the day-read stack, so it lives alone and is
// imported by both registers that must obey it (the deterministic vocabulary and,
// via isValidDayReadAgentResult, the agent's own sentence).

// ---------- the reading grammar, in ONE place ----------
// VISION.md Amendment 2, as a predicate rather than a habit: plain language, no
// device/clinical jargon, no score, and a suggestion rather than a gate.
//
// This used to exist in three unconnected forms — the prompt's prose instructions
// (src/prompt/day.ts), the guards in test/dayRead.test.js over the deterministic
// vocabulary, and NOTHING AT ALL over the agent's sentence. So the constitution was
// enforced on the layer that cannot violate it and withheld from the layer that can,
// and the agent's headline + `why` — what the athlete reads on most mornings — went
// to the Brief unchecked. `{headline:"Readiness 38/100 — rest.", why:"…you must not
// train today."}` validated and rendered verbatim.
//
// One definition now, held by BOTH registers: the vocabulary tests run the whole
// deterministic set through it, and isValidDayReadAgentResult runs the agent's
// headline and `why` through it. Deliberately the SAME four rules the deterministic
// vocabulary already passes and no more — a stricter grammar here would start
// rejecting good prose, and every registered phrasing is the proof set (the
// zero-false-positive case in test/dayRead.test.js is what pins that).
export const DAY_READ_GRAMMAR_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  // Internals leaking as coaching.
  {
    rule: "engineering_prose",
    pattern: /_|deterministic|posture|baseline|policy|fingerprint|directive|override|boundary/i,
  },
  // Clinical/device vocabulary that actually leaked once. Phrase-level, so a
  // colloquial "nothing acute" in a legitimate phrasing is not caught.
  { rule: "device_jargon", pattern: /\bacute warning\b|\breadiness signal\b/i },
  // No scores, no grades, no metric wall. The word boundary sits INSIDE each branch:
  // a single trailing `\b` after the group never fired for the "%" branch (a percent
  // sign followed by a space is two non-word characters, so there is no boundary
  // between them), which let "you scored 42% on recovery" through the one rule whose
  // whole job is to catch it.
  //
  // The "%" branch alone used to fire on ANY digit+percent, so a genuinely factual
  // percentage of a real, named quantity — "you're at 80% of your protein target" —
  // read as a violation right alongside an actual grade — "Readiness 38%.",
  // "you scored 42% on recovery". The two are told apart by what follows the
  // number: "N% of <thing>" names the real quantity it is a fraction of (a
  // measured intake/adherence/dose against a target), so a negative lookahead
  // excuses ONLY that shape. A bare or dangling percentage — nothing after it, or
  // anything other than "of" — still reads as a grade and stays caught, same as
  // "/100", "N points" and "N score(s)" always have.
  { rule: "score", pattern: /\b\d{1,3}\s*(?:\/\s*100\b|%(?!\s+of\b)|points?\b|scores?\b)/i },
  // A suggestion, never a gate.
  { rule: "gate", pattern: /\byou must\b|\bdo not train\b|\bforbidden\b/i },
];

// The name of the first rule `text` breaks, or null when it holds the line. Empty
// text is vacuously fine — absence is the caller's contract to enforce, not this one's.
export function violatesReadingGrammar(text: unknown): string | null {
  const sentence = String(text ?? "");
  if (!sentence.trim()) return null;
  for (const { rule, pattern } of DAY_READ_GRAMMAR_RULES) if (pattern.test(sentence)) return rule;
  return null;
}
