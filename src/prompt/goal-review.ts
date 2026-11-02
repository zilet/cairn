// ---------- the finished-goal review ("Behind you") ----------
// One finished goal — a race run, a strength objective completed, a goal weight
// reached — looked back on ONCE, in the coach's own words: a headline, the story, what
// it taught about this athlete, and what carries forward. The deterministic FACTS
// (src/repo/goal-reviews.ts) are the main payload and the agent writes FROM them; the
// review is frozen once written, so it must be true to them. For a race the agent may
// also propose bounded changes to the next build ("levers", src/repo/build-levers.ts);
// the server validates every one against the facts and adopts only what holds.
import type { BuildLeverKey } from "../repo/build-levers.js";
import type { CoachContext } from "../repo/coach-context.js";
import type { GoalReviewRecord } from "../repo/goal-reviews.js";
import type { AthleteUnits } from "../repo/display-words.js";
import { getCoachContext } from "../repo/coach.js";
import { goalReviewFactLines } from "../repo/goal-reviews.js";
import { promptData } from "./context-projection.js";
import { CAIRN_PERSONA, renderJsonContract } from "./shared.js";

// Prose twin of agent-contracts.ts GOAL_REVIEW_SCHEMA. Keep the two in step.
function proseSchema(withLevers: boolean): string {
  return `{
  "headline": "<ONE sentence, second person: what this goal was, said back with one real number>",
  "story": "<2-4 sentences: how the run-up and the day went, specific, with the facts' own numbers>",
  "lessons": "<2-4 sentences: what this build TAUGHT about this athlete — their own pattern, not general advice>",
  "carry_forward": "<1-3 sentences: what carries into what comes next>"${
    withLevers
      ? `,
  "levers": [{"key": "<one of the lever keys below>", "value": <a positive number, e.g. 2 for taper_weeks or 16 for a km cap>, "because": "<ONE sentence, second person, the lesson behind it>"}]`
      : ""
  }
}`;
}

// What each lever key means, said for the agent (the server owns the bounds).
const LEVER_HELP: Readonly<Record<BuildLeverKey, string>> = {
  build_step: "the weekly volume build factor (default 1.12: a week grows to at most 1.12 times the one before)",
  long_step: "the long-run step factor (default 1.15)",
  long_run_ceiling_km:
    "the next build's long-run peak, in KILOMETRES even when the athlete reads miles (default: 0.85 × race distance, at most 20)",
  peak_week_cap_km: "the next build's peak weekly cap, in KILOMETRES even when the athlete reads miles",
  taper_weeks: "weeks of taper before race week (default 1)",
  down_week_every: "a lighter week every N weeks (default 4)",
};

function leverBlock(keys: readonly BuildLeverKey[]): string {
  return `LEVERS FOR THE NEXT BUILD (optional — race reviews only):
You may propose bounded changes to how the NEXT race build is shaped, ONLY when the facts above
clearly support them (a long run taken well that the build's ceiling held back; weeks set aside
for harm that say the ramp was too steep for this athlete; a recovery that took longer or shorter
than the window). An empty list is the calm, common answer. The server checks every lever against
these facts and its own safe bounds, drops what does not hold, and tells the athlete what it kept
with a one-tap undo — so propose only what you would defend from the numbers. One lever per key.
Every "value" is a positive number; the two km caps are always in KILOMETRES, never miles. A
number far outside a key's range is set aside, not rounded into it.
Keys:
${keys.map((k) => `- ${k}: ${LEVER_HELP[k]}`).join("\n")}
Each lever's "because" is ONE plain sentence to the athlete, from the lesson ("Your 18 km long run
went well and the build held you at 16, so the next one can climb a little further.").`;
}

function kindIntro(row: GoalReviewRecord): string {
  if (row.facts.kind === "race")
    return `A RACE they ran: ${row.title}. Look back on the whole build and the day itself.`;
  if (row.facts.kind === "strength_objective")
    return `A STRENGTH OBJECTIVE they completed: ${row.title}. Look back on the run-up to it.`;
  return `A GOAL WEIGHT they reached: ${row.title}. Look back on the road there.`;
}

export function buildGoalReviewPrompt(
  row: GoalReviewRecord,
  opts: { units: AthleteUnits; leverKeys?: readonly BuildLeverKey[] | null; ctx?: CoachContext; today?: string }
): string {
  const context = opts.ctx ?? getCoachContext();
  const levers = row.facts.kind === "race" && !!opts.leverKeys?.length;
  const lines = goalReviewFactLines(row, opts.units, opts.today);
  const target =
    row.facts.kind === "race" && row.facts.target_text
      ? `\nWhat they said they were aiming at (CONTEXT ONLY — never hold the result against it): "${row.facts.target_text.replace(/"/g, "'").slice(0, 80)}"`
      : "";
  return `${CAIRN_PERSONA}

You are writing ONE look-back on a goal this athlete has FINISHED. It waits in their app under
"Behind you" — it is never pushed — and it is written once and kept, so it must be true to the facts.

${kindIntro(row)}${target}

THE CONSTITUTION (binding):
- A MEASURE, NEVER A GRADE. Say what happened with its real numbers. Never hold the result against
  a target or a goal ("missed", "fell short of", "beat", "ahead of/behind your target"), never a
  verdict word (graded, disappointing, underperformed), no score, no percentages, no points.
- Calm, warm, plain everyday words, second person ("you"). No alarm, no hype, no "you must".
- Specific: name the numbers from the FACTS (distances, times, paces, weeks, loads, dates) in the
  athlete's units (${opts.units.distance} for distance, ${opts.units.weight} for weight). Never invent a number.
- "lessons" is what THIS run-up taught about THIS athlete — their own pattern read from the facts
  (how they absorbed a long run, how a week they paid for looked, how the taper sat) — never generic advice.
- Never name internal fields or engineering words (no underscores, no "baseline", "policy",
  "deterministic", "directive", "posture"). Health is informational, never medical advice.

THE FACTS (deterministic, computed by the server — your main source; numbers are km/lb internally):
${JSON.stringify(row.facts)}

THE SAME FACTS IN THEIR WORDS:
${lines.length ? lines.map((l) => `- ${l}`).join("\n") : "- (no further lines)"}

${levers ? `${leverBlock(opts.leverKeys ?? [])}\n\n` : ""}${renderJsonContract(proseSchema(levers))}

DATA (who they are, for tone and context — the FACTS above outrank it):
${promptData(context, "goal_review")}`;
}
