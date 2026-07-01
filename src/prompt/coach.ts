// Training-plan prompts: the coach's next-week target proposal and the deeper
// program-evolution proposal (both emit PLAN_SCHEMA as a draft for review).
import * as repo from "../repo.js";
import {
  activeInjuryAreas,
  COACHING_STANCE,
  CONTEXT_GUARDRAILS,
  disciplineOf,
  ELITE_STRENGTH_GUARDRAILS,
  renderCoachingFocus,
  renderConnectedBrain,
  renderDexaTargeting,
  renderDiscipline,
  renderEnduranceGoal,
  renderMuscleGroups,
  renderPerformance,
  renderProgramState,
  renderReactionModel,
  renderRunCompliance,
  renderRunPlan,
  renderRunZones,
  renderTrainingSignals,
  renderTrajectory,
} from "./shared.js";

const PLAN_SCHEMA = `{
  "summary": "one or two sentences on the overall adjustment",
  "changes": [
    { "day_number": <1-5>, "exercise": "<exact exercise name>", "target_weight": <number>, "reason": "<why>" },
    { "day_number": <1-5>, "exercise": "<exact exercise name>", "target_seconds": <number>, "reason": "<why — ONLY for mode:'timed' exercises>" }
  ],
  "cardio": [
    { "day_number": <1-7>, "label": "<e.g. Easy run / Long run / Tempo / Intervals>",
      "target_distance_km": <number|null>, "target_duration_min": <number|null>,
      "target_zone": "<Z2|easy|tempo|threshold|intervals|long|null>", "reason": "<why this run, this week>", "note": "<optional pacing/structure>" }
  ],
  "notes": "<optional coaching notes, may be empty>"
}
// "changes"  → tweak strength targets on existing plan days (applied in place).
// "cardio"   → prescribe THIS WEEK's runs (one entry per planned run). Applied
//              surgically: each attaches to its day_number, REPLACING that day's
//              cardio while leaving its strength work intact; a day_number with no
//              plan day yet is created as a dedicated run day. This is the headline
//              output for a runner/hybrid athlete with an endurance goal — use it
//              alongside (or instead of) "changes". DON'T wrap runs in "days".
// "days"     → ONLY for a real split/FREQUENCY rewrite (whole plan replaced). Each
//              item may be strength OR { "kind":"cardio", … } as below:
//   "days": [ { "day_number": <n>, "name": "<day name>", "focus": "<focus>", "items": [
//     { "exercise": "<name>", "sets": <n>, "rep_low": <n>, "rep_high": <n>, "target_weight": <n|null> },
//     { "kind": "cardio", "exercise": "<e.g. Long run>", "target_distance_km": <n|null>,
//       "target_duration_min": <n|null>, "target_zone": "<Z2|tempo|easy|null>", "note": "<optional>" }
//   ] } ]`;

// The active periodization block (goal / phase / week N of M), so the coach
// periodizes toward it. "" when no block is running (the program-state mesocycle
// read still gives deload timing). A nudge, never a gate.
function renderBlock(ctx: any): string {
  const b = ctx?.program_block;
  if (!b) return "";
  return `\nACTIVE TRAINING BLOCK: "${b.goal}" — ${b.focus}, ${b.phase} phase (${b.week_of}). Periodize toward this: in an accumulation phase build volume, in intensification push load, in a deload phase propose a LIGHTER week. Don't ramp volume and intensity at once.\n`;
}

// Training-target proposal prompt (existing coach).
export function buildCoachPrompt(userInstruction?: string): string {
  const ctx = repo.getCoachContext();
  const disc = disciplineOf(ctx);
  const coachRole = disc === "endurance"
    ? "an endurance coach (with strength as supporting work)"
    : disc === "hybrid"
      ? "a hybrid coach balancing endurance and strength"
      : "a strength coach";
  return `You are ${coachRole} updating a training plan. The athlete's profile, goal check,
current plan, recent training sessions, recent cardio/activities, and accumulated memory are in
the DATA section below.

NON-NEGOTIABLE GUARDRAILS:
- Progress is capped by tissue and nerve recovery, NOT by how easy a weight feels. Be conservative.
- Upper-body increases: at most +5 lb/step. Lower-body: at most +5-10 lb/step.
- Only raise a target if recent sessions hit the TOP of the rep range on ALL sets at RIR 2-3.
- Respect every exercise's constraint_note (e.g. injury limits). Never contradict them.
- Account for cardio load: if recent runs/rides are heavy, lean toward holding rather than adding.
- Treat Garmin as a context source, not the plan authority. Manual Cairn lifting logs are the
  source of truth for strength progression. Use Garmin's endurance/recovery signals through the
  athlete's stated focus: strength-first athletes use runs/rides mainly as recovery/cardio-load
  context; runner/cyclist-first athletes make endurance progression central and keep lifting
  supportive.
- Assisted movements use NEGATIVE target_weight. Small steps. Thin/absent data -> do not change.
- TIMED exercises (mode:'timed', e.g. plank, dead hang) are prescribed in SECONDS (target_seconds)
  and logged as duration_sec, not load. Progress them in seconds (+5-15s/step) and ONLY when recent
  durations comfortably meet the current target; never propose target_weight for a timed exercise.

KEEP TRAINING FRESH (anti-staleness — a plan that never changes gets abandoned):
- Main lifts that are progressing stay put. But when an ACCESSORY has been unchanged for ~3-4 weeks,
  has stalled, or the program is starting to read repetitive, swap in ONE OR TWO new exercises that
  hit the same muscle (e.g. leg press ↔ hack squat, cable row variations, incline ↔ machine press).
- Every new exercise MUST respect the constraint_notes (e.g. injury limits — honor whatever each
  note specifies), fit the equipment implied by the current plan, and start at a
  conservative load with a short intro note ("NEW — start light, log actual").
- Small novelty often (1-2 swaps in a normal week) beats wholesale rewrites; restructure the split
  only when frequency or recovery clearly calls for it.
- You may also rotate rep ranges on accessories (e.g. 3x12 -> 4x10) as a lighter form of novelty.

AUTOREGULATION — let the plan bend to how the body actually responded (read each session's
"soreness" 1-5, "performance" 1-5, and free-text "joint_pain" in recent_sessions; many sessions will
have none — that's fine, just use what's there):
- HIGH SORENESS (4-5) or LOW PERFORMANCE (1-2) across recent sessions for a muscle/pattern → pull
  VOLUME or LOAD back there: hold the target (don't add), trim a set, or program a lighter deload week
  rather than progressing. Recovery debt is real; do not push through it.
- A "joint_pain" area named in a recent session (e.g. "left knee", "right shoulder") → DE-LOAD or SWAP
  the movements that load that area for a pain-free alternative, exactly as you would for an injury
  constraint_note. Note the swap kindly; never program loaded movement into a painful joint.
- Recovery signals INFORM selection; they NEVER override progressive overload. When soreness and
  performance are good (low soreness, performance 3-5) and the rep targets were met, the normal
  conservative progression rules above still apply — autoregulation is a brake, not the driver.
- This is kind, not anxious: a rough session is information, not failure. Easing off is the plan
  working as designed, never a penalty.

${ELITE_STRENGTH_GUARDRAILS}

${CONTEXT_GUARDRAILS}
${renderCoachingFocus(ctx)}${COACHING_STANCE}

${renderDiscipline(ctx, "training")}${renderEnduranceGoal(ctx, "training")}${renderRunCompliance(ctx, "training")}${renderRunZones(ctx)}${renderRunPlan(ctx)}${renderConnectedBrain(ctx, { domains: ["training", "watch"] })}${renderTrainingSignals(ctx)}${renderProgramState(ctx)}${renderMuscleGroups(ctx)}${renderPerformance(ctx)}${renderDexaTargeting(ctx, "training")}${renderBlock(ctx)}${renderReactionModel(ctx)}${renderTrajectory(ctx)}
TASK: ${userInstruction?.trim() || "Review recent training and propose conservative target adjustments for next week."}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${PLAN_SCHEMA}

DATA:
${JSON.stringify(ctx)}`;
}

// ---- adaptive program evolution (propose how the PLAN itself should evolve) ----
// Where buildCoachPrompt nudges next-week TARGETS, this drives a deeper question:
// given how each lift is actually TRENDING (the deterministic program-state read —
// progressing / plateaued / regressing, with a suggested action), how should the
// PROGRAM evolve? Progress what's working, deload/rotate what's stuck, break
// plateaus with a close variation, introduce novelty before staleness sets in,
// add quality to a one-pace endurance base, and periodize toward the goal. Output
// is the SAME PLAN_SCHEMA (changes/cardio/days) → a DRAFT proposal for review;
// nothing auto-applies. Constitution: a suggestion, never a gate; no scores.
export function buildProgramEvolutionPrompt(userInstruction?: string, state?: any): string {
  const ctx = repo.getCoachContext();
  state = state ?? repo.getProgramState();
  // Concrete variation candidates for any stalled lift, so "rotate a variation"
  // is actionable — the agent gets real same-pattern options to choose from
  // (it still respects constraint_notes/injuries and starts light).
  const stalled = (Array.isArray(state.lifts) ? state.lifts : []).filter(
    (l: any) => l.status === "plateaued" || l.suggested_action === "vary"
  );
  const injuryAreas = activeInjuryAreas(ctx);
  const variationLines = stalled
    .map((l: any) => {
      // Injury-aware: the candidate list must not include movements that load an
      // injured area (else it contradicts the "never load an injured area" rule).
      const names = (repo.suggestAlternatives(l.exercise, { limit: 4, injuryAreas }) as any[]).map((v) => v.name);
      return names.length ? `- ${l.exercise} → ${names.join(", ")}` : null;
    })
    .filter(Boolean);
  const variationBlock = variationLines.length
    ? `\nVARIATION CANDIDATES for the stalled lifts (same movement pattern — rotate ONE in to break the plateau, starting light):\n${variationLines.join("\n")}\n`
    : "";
  // Weak-point read: which canonical groups are chronically UNDER their productive
  // volume range (or untrained lately) vs running high — so the evolution rebalances
  // toward the lagging groups instead of piling more onto what's already well-trained.
  let weakBlock = "";
  try {
    // Reuse the balance getCoachContext already computed (program_balance); only
    // recompute as a fallback if it's absent.
    const bal: any = ctx?.program_balance ?? repo.programBalance();
    const due: string[] = Array.isArray(bal?.due) ? bal.due : [];
    const over: string[] = Array.isArray(bal?.over) ? bal.over : [];
    if (due.length || over.length) {
      const ex = (g: string) => (repo.examplesForGroup(g, 2) as string[]).join(", ");
      weakBlock = `\nVOLUME BALANCE — REBALANCE toward weak points (this is how a real coach builds a body, not by repeating the same lifts):\n${
        due.length ? `- LAGGING (under their productive set range or untrained lately): ${due.slice(0, 6).join(", ")}. Bias any added/rotated movement to a lagging group — e.g. ${due.slice(0, 2).map((g) => `${g} (${ex(g)})`).join("; ")}.\n` : ""
      }${over.length ? `- WELL-SERVED (running high): ${over.join(", ")} — you may redirect a set or two from here to a lagging group rather than adding net volume.\n` : ""}`;
    }
  } catch { /* balance unavailable → no weak-point block */ }
  const disc = disciplineOf(ctx);
  const coachRole = disc === "endurance"
    ? "an endurance coach (with strength as supporting work)"
    : disc === "hybrid"
      ? "a hybrid coach balancing endurance and strength"
      : "a strength coach";
  return `You are ${coachRole} EVOLVING a training program — not just tweaking next week, but
reading how each lift has actually been trending and deciding how the plan should adapt so the
athlete keeps progressing and doesn't stall or get bored. This is a SUGGESTION for them to review;
nothing is applied automatically (they drive).

A deterministic PROGRAM-STATE read has already analyzed the logged history — per-lift trend +
plateau/stall detection (with a suggested action), volume landmarks, mesocycle position, and
endurance trends. TRUST it as your starting point, then make the nuanced call:
${JSON.stringify(state)}

HOW TO EVOLVE (this is the whole point — be a real coach, not a preset):
- PROGRESS what's working: a lift reading "progressing" gets the next conservative load step (see
  the step caps below). Don't fix what isn't broken.
- BREAK plateaus: a lift reading "plateaued" should NOT just get more load (that's what stalled).
  Pick the intervention its suggested_action points to — a light DELOAD then a fresh run, ROTATE to a
  close variation (same movement pattern, different bar path / implement — e.g. back squat → front
  squat, flat → incline press, barbell row → chest-supported row), or a technique/rep-scheme change.
  Use a "days" restructure (or swap the exercise within its day) to rotate a variation; keep the rest
  of the day intact.
- RECOVER what's slipping: a "regressing" lift gets backed off, not pushed.
- GROUND IN REALITY: prescribe from what the athlete ACTUALLY logs, never a stale plan number. If a
  lift's recent working weight has outpaced its plan target (e.g. the plan says 27 lb but they log 45-50
  every week), set the target to their real working load, then progress conservatively from THERE —
  never crawl up from an old number they left behind weeks ago.
- REBALANCE toward weak points: read the VOLUME BALANCE block — bias added/rotated work to the LAGGING
  groups (don't keep feeding the groups that are already well-trained). Building a balanced body, and
  bringing up weak points, is the job — not repeating the same favorite lifts.
- KEEP IT FRESH: when an accessory has been static and the program reads repetitive, introduce ONE or
  TWO new exercises hitting the same muscle (probe an alternative they haven't tried) — small novelty
  often beats wholesale rewrites. Every new/rotated exercise starts at a conservative load with a
  "NEW — start light, log actual" note and MUST respect constraint_notes / injuries.
- PERIODIZE: respect the mesocycle position — if a deload is about due (phase "deload-due"), propose a
  lighter week rather than piling on. Don't ramp intensity and volume at once.
- ENDURANCE: if the endurance read says "add-quality", introduce ONE structured quality session
  (tempo or intervals) into an otherwise easy base via "cardio"/"days"; if "ease"/"spiking", hold
  mileage; if "build", a conservative (~10%) step. Periodize toward any race goal.

NON-NEGOTIABLE GUARDRAILS (same as the coach):
- Conservative loading: upper-body +5 lb/step max, lower-body +5-10 lb/step max. Only raise when
  recent sessions hit the TOP of the rep range on ALL sets at RIR 2-3. Thin/absent data → don't change.
- Respect every constraint_note and active injury — never load an injured area; swap to a pain-free
  alternative instead. Assisted movements use NEGATIVE target_weight; bodyweight null; TIMED work uses
  target_seconds (+5-15s/step), never load.
- Read each recent session's soreness/performance/joint_pain: high soreness / low performance / a named
  joint → pull volume or load back there, don't progress through it. Autoregulation is a brake, not the driver.
- Prefer 1-3 focused, well-justified changes over a sweeping rewrite. Restructure the split (a "days"
  rewrite) only when frequency/recovery/plateaus clearly call for it.

${ELITE_STRENGTH_GUARDRAILS}

${variationBlock}${weakBlock}${CONTEXT_GUARDRAILS}
${renderCoachingFocus(ctx)}${COACHING_STANCE}

${renderDiscipline(ctx, "training")}${renderEnduranceGoal(ctx, "training")}${renderRunCompliance(ctx, "training")}${renderRunZones(ctx)}${renderRunPlan(ctx)}${renderConnectedBrain(ctx, { domains: ["training", "watch"] })}${renderTrainingSignals(ctx)}${renderProgramState(ctx)}${renderMuscleGroups(ctx)}${renderPerformance(ctx)}${renderDexaTargeting(ctx, "training")}${renderBlock(ctx)}${renderReactionModel(ctx)}${renderTrajectory(ctx)}
TASK: ${userInstruction?.trim() || "Evolve the program: progress what's working, break what's stalled, keep it fresh, and periodize sensibly. Explain each change in plain words."}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${PLAN_SCHEMA}

DATA:
${JSON.stringify(ctx)}`;
}
