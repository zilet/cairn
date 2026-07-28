// Self-critique verify prompts: the bounded second-pass safety checkers for a
// drafted meal plan and a suggested session.
import * as repo from "../repo.js";
import { promptData } from "./context-projection.js";
import { CAIRN_PERSONA, dateScopedPromptContext } from "./shared.js";

// ---------- self-critique verify pass (Trust build V1) ----------
// A bounded SECOND agent turn that checks a just-drafted high-stakes generative
// output against the HARD floors/constraints — the model reviewing its own work
// before it reaches the user. It is a SAFETY backstop, not a redesign: it only
// fixes genuine floor/constraint violations, leaving a clean draft untouched. It
// fails OPEN — if it can't run or returns garbage, the original draft ships exactly
// as today (the verify pass is never load-bearing). Honors the constitution: still
// a SUGGESTION, no scores, informational-not-medical.
const VERIFY_RESULT_NOTE = `Return ONE bare JSON object only — no prose, no markdown fences:
{
  "ok": true | false,                 // true = the draft already honors every hard rule (no fix needed)
  "violations": [ "<plain one-line description of each hard-rule violation you found>" ],
  "fixed_draft": <the FULL corrected draft in the SAME schema as the input, OR null when ok:true>
}
Rules: ONLY flag genuine HARD-rule violations (not taste/style). When ok:true, violations is [] and
fixed_draft is null. When you DO fix, change as LITTLE as possible to bring it into compliance and keep
the draft otherwise intact. Never invent new constraints; never turn a suggestion into a mandate.`;

// Verify a drafted 7-day meal plan against the lean-safe / longevity HARD floors.
export function buildPlanVerifyPrompt(draft: any): string {
  const goal = repo.computeGoalCheck();
  const recIntake = (goal as any)?.ok ? (goal as any).recommended?.target_intake_kcal ?? null : null;
  const recProtein = (goal as any)?.ok ? (goal as any).recommended?.protein_g ?? null : null;
  return `${CAIRN_PERSONA}

Right now you are acting as Cairn's nutrition SAFETY CHECKER. A meal plan was just drafted for the user. Before
they see it, verify it against the HARD floors below and FIX only genuine violations. This is a
backstop, not a rewrite — a compliant plan passes through untouched.

HARD FLOORS (the only things you enforce):
- Daily calories never below the lean-safe floor: ${recIntake != null ? `~${recIntake} kcal` : "the lean-safe recommended intake"}, and NEVER below ~1500 kcal regardless of math.
- Daily protein at or above the recommended target${recProtein != null ? ` (~${recProtein} g/day)` : ""} — protein is protected under a deficit; never dropped to chase calories.
- Aim for 30g+ fiber/day from whole foods.
- A lean-safe deficit only — never a crash deficit.
- Respect any injury/allergy/preference constraints carried in the DATA's memory/health/context.
- Keep meal-slot timing consistent with the user's stated schedule (e.g. no pre-workout meal if they train fasted).

If everything already holds, ok:true (do NOT nitpick taste or variety). If a floor is violated, return
a fixed_draft in the EXACT meal-plan schema with the SMALLEST change that fixes it (e.g. add protein/fiber
to a thin meal, raise calories to the floor) — preserve the days/meals structure and every other field.

GOAL CHECK (lean-safe reference): ${JSON.stringify(goal)}

THE DRAFTED PLAN TO CHECK:
${JSON.stringify(draft)}

${VERIFY_RESULT_NOTE}`;
}

// Verify a just-suggested single session against the user's HARD constraints.
export function buildSessionVerifyPrompt(draft: any, opts: { minutes?: number; equipment?: string; focus?: string; constraints?: string; date?: string } = {}): string {
  const ctx = dateScopedPromptContext(repo.getCoachContext(), opts.date);
  const limits: string[] = [];
  if (opts.minutes) limits.push(`- TIME BUDGET: the whole session must fit in about ${Math.round(opts.minutes)} minutes (est_minutes must be ≤ this; drop accessories before compounds).`);
  if (opts.equipment) limits.push(`- EQUIPMENT: only movements possible with: ${opts.equipment.trim()}.`);
  if (opts.constraints) limits.push(`- CONSTRAINTS: ${opts.constraints.trim()}.`);
  return `${CAIRN_PERSONA}

Right now you are acting as Cairn's training SAFETY CHECKER. A single session was just suggested for the user.
Before they see it, verify it against the HARD constraints below and FIX only genuine violations. This
is a backstop, not a rewrite — a compliant session passes through untouched. It remains a SUGGESTION.

HARD CONSTRAINTS (the only things you enforce):
- Conservative loading only. Respect every exercise constraint_note and any active injury in the DATA's
  context_events / health directives — NEVER program loaded movement through an injured area.
- Encoding integrity: assisted movements use NEGATIVE target_weight, bodyweight uses null, TIMED work
  (plank/dead hang) uses target_seconds + mode:"timed" (never load). Don't corrupt these.
${limits.length ? limits.join("\n") : "- (no extra time/equipment limits were requested)"}

If everything already holds, ok:true (do NOT nitpick exercise choice or order). If a constraint is
violated, return a fixed_draft in the EXACT session schema with the SMALLEST change that fixes it (swap a
contraindicated movement, trim to the time budget, correct an encoding) — preserve the rest.

THE SUGGESTED SESSION TO CHECK:
${JSON.stringify(draft)}

DATA (for the injury/constraint/equipment context):
${promptData(ctx, "session_verify")}

${VERIFY_RESULT_NOTE}`;
}
