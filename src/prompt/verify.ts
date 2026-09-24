// Self-critique verify prompts: the bounded second-pass safety checkers for a
// drafted meal plan and a suggested session.
import { getCoachContext } from "../repo/coach.js";
import { athleteDietaryDeclarations } from "../repo/nutrition.js";
import type { FloorViolation } from "../repo/verify-floors.js";
import { renderFloorViolations } from "../repo/verify-floors.js";
import { promptData } from "./context-projection.js";
import { CAIRN_PERSONA, dateScopedPromptContext, MECHANICS_ENCODING } from "./shared.js";

// ---------- self-critique verify pass (Trust build V1) ----------
// A bounded SECOND agent turn over a just-drafted high-stakes generative output.
// It is a SAFETY backstop, not a redesign: it repairs genuine violations and
// leaves a clean draft untouched. It fails OPEN — if it can't run or returns
// garbage, the original draft ships exactly as today (never load-bearing).
// Honors the constitution: still a SUGGESTION, no scores, informational-not-medical.
//
// THE ARITHMETIC IS NOT THE MODEL'S JOB. Every numeric floor — the lean-safe kcal
// floor, the protein target, the fiber floor, the session time budget — is
// computed by the server (`src/repo/verify-floors.ts`) BEFORE this prompt is
// built, and the findings are handed over below. Asking the model to re-derive a
// number Cairn already holds is an LLM call whose inputs fully determine its
// output, and it can disagree with the server. So the prompt states the floors'
// verdict and asks for a repair. What remains genuinely the model's: reading a
// free-text injury/dietary constraint against a concrete plan, and not corrupting
// the mechanics encoding while it repairs.
const VERIFY_RESULT_NOTE = `Return ONE bare JSON object only — no prose, no markdown fences:
{
  "ok": true | false,                 // true = nothing to repair (no listed breach, no violation you found)
  "violations": [ "<plain one-line description of each violation being repaired>" ],
  "fixed_draft": <the FULL corrected draft in the SAME schema as the input, OR null when ok:true>
}
Rules: repair every breach listed above, plus any judgement violation you genuinely find. Do NOT
recompute the listed numbers — they are the server's own arithmetic and they are correct. Change as
LITTLE as possible; keep the draft otherwise intact. Never invent new constraints; never turn a
suggestion into a mandate. When ok:true, violations is [] and fixed_draft is null.`;

function breachSection(violations: FloorViolation[]): string {
  if (!violations.length) {
    return `SERVER FLOOR CHECK: PASSED. Cairn already checked every numeric floor (calories, protein,
fiber, time budget) against its own figures and found NO breach. Do not re-check the arithmetic and do
not flag a number as too low or too high — that question is already answered.`;
  }
  return `SERVER FLOOR CHECK: ${violations.length} BREACH${violations.length === 1 ? "" : "ES"}. Cairn computed these
against its own figures; they are correct and they are the ones to repair:
${renderFloorViolations(violations)}

Repair each one with the smallest change that clears it, and leave every other number alone.`;
}

// The declarations the drafted week has to survive, rendered from the SAME reader
// the skip gate counts (`athleteDietaryDeclarations`) so the prompt shows exactly
// what made this turn worth running. Allergies ride in the DATA block's `profile`
// alongside the household's, which is where the meal-drafting prompt reads them
// from too. Quiet when nothing is declared — never a heading over an empty list.
function declaredConstraintsSection(draft: any, dietaryInstruction?: unknown): string {
  const lines: string[] = [];
  const clean = (value: unknown) => String(value ?? "").trim();
  try {
    const declared = athleteDietaryDeclarations(dietaryInstruction, draft);
    if (clean(declared.restrictions)) lines.push(`- DIETARY RESTRICTIONS (profile): ${clean(declared.restrictions)}`);
    if (Array.isArray(declared.hardDietKeys) && declared.hardDietKeys.length)
      lines.push(`- HARD DIET (every meal, item and substitution): ${declared.hardDietKeys.join(", ")}`);
    if (clean(declared.mealPrefs)) lines.push(`- USER SCHEDULE & MEAL PREFERENCES: ${clean(declared.mealPrefs)}`);
    if (clean(declared.instruction)) lines.push(`- THIS REQUEST ASKED FOR: ${clean(declared.instruction)}`);
  } catch {
    // A declaration read that fails leaves the DATA block as the only source. The
    // check still runs; it is never quietly downgraded to "nothing declared".
  }
  return lines.length ? `\nDECLARED CONSTRAINTS (the athlete's own words):\n${lines.join("\n")}\n` : "";
}

// Verify a drafted 7-day meal plan. Numeric floors arrive already computed, so the
// prompt's whole remaining job is the declaration/timing judgement — which is
// unmakeable without the declarations, hence the DATA block.
export function buildPlanVerifyPrompt(
  draft: any,
  violations: FloorViolation[] = [],
  opts: { dietary_instruction?: unknown } = {}
): string {
  return `${CAIRN_PERSONA}

Right now you are acting as Cairn's nutrition SAFETY CHECKER. A meal plan was just drafted for the user.
Before they see it, repair the breaches Cairn found and check the one thing Cairn cannot check for
itself. This is a backstop, not a rewrite — a compliant plan passes through untouched.

${breachSection(violations)}

YOUR OWN CHECK (judgement, not arithmetic — this is why you are here):
- Does any meal, item or substitution violate an ALLERGY (DATA's profile.allergies and each family
  member's — a hard safety exclusion, the one place a hard rule is allowed), a dietary restriction, a
  hard diet, or a food the athlete has said they avoid (DATA's memory/learnings)?
- Does the meal-slot timing contradict the schedule they stated (e.g. a pre-workout meal when they
  train fasted)?
- Does anything in DATA's context_events / directives make a meal a bad idea today?
Do NOT nitpick taste, variety or ingredient choice — those are not violations.
${declaredConstraintsSection(draft, opts.dietary_instruction)}
THE DRAFTED PLAN TO CHECK:
${JSON.stringify(draft)}

DATA (allergies, restrictions, household, food memory, life and health context):
${promptData(getCoachContext(), "meal_plan_verify")}

${VERIFY_RESULT_NOTE}`;
}

// Verify a just-suggested single session. The time budget arrives already checked.
export function buildSessionVerifyPrompt(
  draft: any,
  opts: { minutes?: number; equipment?: string; focus?: string; constraints?: string; date?: string } = {},
  violations: FloorViolation[] = []
): string {
  const ctx = dateScopedPromptContext(getCoachContext(), opts.date);
  const limits: string[] = [];
  if (opts.equipment) limits.push(`- EQUIPMENT: only movements possible with: ${opts.equipment.trim()}.`);
  if (opts.constraints) limits.push(`- CONSTRAINTS: ${opts.constraints.trim()}.`);
  return `${CAIRN_PERSONA}

Right now you are acting as Cairn's training SAFETY CHECKER. A single session was just suggested for the
user. Before they see it, repair the breaches Cairn found and check the ones Cairn cannot check for
itself. This is a backstop, not a rewrite — a compliant session passes through untouched. It remains a
SUGGESTION.

${breachSection(violations)}

YOUR OWN CHECKS (judgement, not arithmetic — this is why you are here):
- Contraindication: never program loaded movement through an injured area. Read every exercise
  constraint_note and any active injury in the DATA's context_events / health directives against the
  movements actually prescribed. Conservative loading only.
${limits.length ? `${limits.join("\n")}\n` : ""}- Encoding integrity — if you return a fixed_draft, do not corrupt these:
${MECHANICS_ENCODING}
Do NOT nitpick exercise choice or ordering — those are not violations.

THE SUGGESTED SESSION TO CHECK:
${JSON.stringify(draft)}

DATA (for the injury/constraint/equipment context):
${promptData(ctx, "session_verify")}

${VERIFY_RESULT_NOTE}`;
}

// Repair a drafted plan change (a redraw or an evolution) that the server found
// starving a priority group. Called only when the pre-check found a breach — a plan
// draft carries no judgement-only check here — so this is a REPAIR turn, not a
// review: add the missing weekly volume with the smallest change and leave the rest
// of the athlete's week exactly as drafted.
export function buildPlanDraftVerifyPrompt(
  draft: any,
  violations: FloorViolation[] = [],
  opts: { athlete_request?: unknown } = {}
): string {
  const ctx = getCoachContext();
  const asked = String(opts.athlete_request ?? "").trim();
  const askedSection = asked
    ? `\nTHE ATHLETE ASKED FOR (their own words — the repair must still honor this):\n${asked.slice(0, 600)}\nIf these words explicitly ask for a lighter or smaller week (fewer sets or days, a deload, less volume, short on time, away this week), honor them: leave a group under its floor rather than add back what they asked to drop, and say so in "violations".\n`
    : "";
  return `${CAIRN_PERSONA}

Right now you are acting as Cairn's training VOLUME CHECKER. A change to the athlete's lifting week was
just drafted. Before it lands, repair the weekly volume breaches Cairn found. This is a backstop, not a
rewrite — it remains a SUGGESTION the athlete can change.

${breachSection(violations)}
${askedSection}
HOW TO REPAIR (smallest change that clears every listed breach):
- DATA.weekly_set_targets names each priority group's weekly window. Count effective sets the way
  Cairn does: a working set of a movement whose main group is the named one counts 1; a compound's
  secondary group (a press for triceps and front delts, a row or pull-up for biceps, a squat or hinge
  for glutes) counts a half.
- First raise "sets" on movements for that group already in the draft (2-4 working sets each); only
  add a movement when that cannot reach the floor, and then place it on an existing lifting day. Never
  add a lifting day, never move a day, never touch a movement unrelated to the named groups.
- Prescribe any added movement from what the athlete actually logs (DATA.recent_sessions) or start it
  light with a "NEW — start light, log actual" note. Respect every constraint_note and active injury —
  never load an injured area to reach a number.
- Keep the draft's own shape: a "days" draft stays a "days" draft, a "changes" draft stays a "changes"
  draft (add or edit entries in its "changes" list).
- Encoding integrity — do not corrupt these in a repair:
${MECHANICS_ENCODING}

THE DRAFTED CHANGE TO REPAIR:
${JSON.stringify(draft)}

DATA (the athlete's intent, the per-group targets, the current plan and what they log):
${promptData(ctx, "plan_verify")}

${VERIFY_RESULT_NOTE}`;
}
