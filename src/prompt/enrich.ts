// Background-enrichment prompts: free-text activity/food enrichment, the
// health-document analyzer, the food-photo vision estimate, and the Garmin
// strength reconciliation narrative.
import {
  FOOD_INGREDIENT_SCHEMA,
  FOOD_NUTRITION_PATTERN_SCHEMA,
  FOOD_PROVENANCE_SCHEMA,
  foodCaptureGuardrailLines,
} from "../foodCapture.js";
import { HEALTH_DOCUMENT_KIND_SCHEMA } from "../healthDocumentKinds.js";
import * as repo from "../repo.js";

const ENRICH_ACTIVITY_SCHEMA = `{
  "structured": {
    "type": "ride|run|swim|hike|other",
    "duration_min": <number|null>,
    "distance_km": <number|null>,
    "pace": <string|null>,
    "rpe": <number|null>,
    "notes": <string|null>
  },
  "memory": [
    { "content": "<short durable fact>", "kind": "observation|preference|injury|milestone" }
  ]
}`;

const ENRICH_FOOD_SCHEMA = `{
  "structured": {
    "summary": "<clean meal name or short description>",
    "items": [<string>],
    "ingredients": [
      ${FOOD_INGREDIENT_SCHEMA}
    ],
    "kcal": <number|null>,
    "protein_g": <number|null>,
    "carbs_g": <number|null>,
    "fat_g": <number|null>,
    "fiber_g": <number|null>,
    "nutrition_pattern": ${FOOD_NUTRITION_PATTERN_SCHEMA},
    "notes": <string|null>,
    ${FOOD_PROVENANCE_SCHEMA}
  },
  "memory": [
    { "content": "<short durable fact>", "kind": "observation|preference|injury|milestone" }
  ]
}`;

const FOOD_PREPARATION_METHODS = [
  ["air-fry", /\bair[- ]?fr(?:y|ied|ies|ying|yer)\b/i],
  ["grill", /\bgrill(?:ed|ing|s)?\b/i],
  ["bake", /\bbak(?:e|ed|es|ing)\b/i],
  ["roast", /\broast(?:ed|ing|s)?\b/i],
  ["steam", /\bsteam(?:ed|ing|s)?\b/i],
  ["saute", /\bsaut(?:e|ed|es|ing|é|éed|és|éing)\b/i],
  ["boil", /\bboil(?:ed|ing|s)?\b/i],
  ["poach", /\bpoach(?:ed|ing|es)?\b/i],
  ["braise", /\bbrais(?:e|ed|es|ing)\b/i],
  ["slow-cook", /\bslow[- ]cook(?:ed|ing|s)?\b/i],
] as const;
const FOOD_PREPARATION_FATS = [
  ["olive oil", /\b(?:extra[- ]virgin\s+)?olive oil\b|\bevoo\b/i],
  ["avocado oil", /\bavocado oil\b/i],
  ["butter", /\bbutter\b/i],
  ["ghee", /\bghee\b/i],
  ["coconut oil", /\bcoconut oil\b/i],
  ["canola oil", /\b(?:canola|rapeseed) oil\b/i],
  ["vegetable oil", /\bvegetable oil\b/i],
  ["sesame oil", /\bsesame oil\b/i],
  ["peanut oil", /\bpeanut oil\b/i],
  ["sunflower oil", /\bsunflower oil\b/i],
] as const;

export interface FoodPreparationContext {
  cooking_methods: string[];
  cooking_fats: string[];
}

// Memory is scanned locally, but the prompt receives only canonical tokens from
// these positive culinary allowlists. Original memory text never crosses the
// prompt boundary, even when a note mixes preparation details with health,
// medication, family, location, schedule, or other private context.
export function foodEnrichmentPreparationContext(limit = 40): FoodPreparationContext {
  const contents = (repo.listMemory(limit) as any[]).map((memory) => String(memory?.content || ""));
  const cookingMethods = FOOD_PREPARATION_METHODS.filter(([, pattern]) =>
    contents.some((content) => pattern.test(content))
  ).map(([canonical]) => canonical);
  const cookingFats = FOOD_PREPARATION_FATS.filter(([, pattern]) =>
    contents.some((content) => pattern.test(content))
  ).map(([canonical]) => canonical);
  return { cooking_methods: cookingMethods, cooking_fats: cookingFats };
}

// Background enrichment of a free-text log into cleaner structured data, plus
// distilling genuinely notable durable facts into memory. Light context only.
export function buildEnrichPrompt(kind: "activity" | "food", raw: string): string {
  const profile = repo.getProfile();
  const goal = repo.computeGoalCheck();
  const recentMemory =
    kind === "food" ? foodEnrichmentPreparationContext() : (repo.listMemory(40) as any[]).map((m) => m.content);

  const guardrails = `GUARDRAILS:
- Never invent numbers. Use null for anything not stated or not reasonably inferable.
- "memory" is [] UNLESS there is a genuinely notable, durable fact (an injury/niggle, a clear
  preference, a milestone/PR, or a meaningful recurring pattern). Do NOT log routine entries.
- A one-off meal, restaurant, takeout, cafe stop, or treat is an EVENT, not a preference or recurring
  pattern. Keep it in the structured food log only unless the user explicitly states a stable habit,
  like/dislike, constraint, or schedule.
- Do NOT repeat anything already present in EXISTING MEMORY below — only add genuinely new facts.
- Keep memory items short and factual. Respect any constraints/preferences already on record.`;

  if (kind === "activity") {
    const recentActivities = repo.listActivities(10);
    return `You enrich a single free-text cardio/activity log into clean structured data for a
training tracker. A fast offline regex already produced a rough parse; your job is to improve it
and extract any durable fact worth remembering.

${guardrails}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${ENRICH_ACTIVITY_SCHEMA}

CONTEXT:
profile: ${JSON.stringify(profile)}
goal: ${JSON.stringify(goal)}
recent_activities: ${JSON.stringify(recentActivities)}
EXISTING MEMORY (do not repeat): ${JSON.stringify(recentMemory)}

RAW ACTIVITY LOG TO ENRICH:
${raw}`;
  }

  return `You enrich a single free-text food/meal note into a clean structured estimate for a
nutrition tracker, and extract any durable fact worth remembering.

${guardrails}
- Correct obvious typos in ingredient names, but preserve the user's meaning.
${foodCaptureGuardrailLines()}
- A note that states an exact quantity ("205 g chicken", "two scoops") is a user_report you may treat as
  high confidence. Anything you filled in from ordinary serving sizes is estimated_from_foods, and rough.
- Estimate saturated_fat_g and unsaturated_fat_g only when ingredients and preparation make a practical
  split possible; otherwise use null. Keep the split consistent with total fat and avoid false precision.
  Explicit cooking method/oil in the note or durable memory overrides generic assumptions (for example,
  grilled with a drizzle of olive oil should not be treated like butter-fried food).

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${ENRICH_FOOD_SCHEMA}

CONTEXT:
profile: ${JSON.stringify(profile)}
goal: ${JSON.stringify(goal)}
EXISTING MEMORY (do not repeat): ${JSON.stringify(recentMemory)}

RAW FOOD NOTE TO ENRICH:
${raw}`;
}

const ENRICH_HEALTH_SCHEMA = `{
  "kind": "${HEALTH_DOCUMENT_KIND_SCHEMA}",
  "doc_date": "YYYY-MM-DD|null",
  "structured": {
    "markers": [
      { "name": "<marker name, e.g. 'Ferritin'>", "value": <number|string>, "unit": "<unit, e.g. 'ng/mL'>", "flag": "low|normal|high|null" }
    ],
    "type": "${HEALTH_DOCUMENT_KIND_SCHEMA}"
  },
  "summary": "<plain-language summary, 1-3 sentences>",
  "memory": [
    { "content": "<durable notable fact, e.g. 'ferritin low-normal — recheck in 3mo'>", "kind": "observation|injury|milestone" }
  ]
}`;

// Health-document analysis. The agent (Claude Code / Codex CLI) can open local
// files, so we hand it the ABSOLUTE path and instruct it to read the file there.
export function buildHealthEnrichPrompt(absPath: string, kind: string): string {
  const profile = repo.getProfile();
  const recentMemory = (repo.listMemory(40) as any[]).map((m) => m.content);

  return `You analyze a single uploaded health document (a lab report, DEXA/body-composition
scan, ECG, vitals record, RMR/metabolic test, progress/visit note, after-visit summary, imaging
report, vision prescription, medication list, immunization record, or similar) for a training & nutrition tracker. The document is a local
file — an image or a PDF — saved on this machine.

READ THE FILE AT THIS ABSOLUTE PATH:
${absPath}

Open and read that file directly (it is a local ${kind} document). Extract the test markers /
measurements and the date the results apply to, then output a clean structured result plus a
short plain-language summary and any durable facts worth remembering.

GUARDRAILS:
- This is informational structuring, NOT medical diagnosis or advice. Do not diagnose, prescribe,
  or recommend treatment. Just transcribe and summarize what the document shows.
- Never invent values. Only include markers you can actually read from the file. Use null for any
  flag you cannot determine (e.g. when no reference range is shown).
- Preserve the source units exactly as printed (US or SI/EU units are both fine). Do NOT convert
  units yourself; Cairn normalizes recognized marker units deterministically after import.
- Do not skip MyChart vitals/basic measurements: blood pressure, pulse/heart rate, weight, BMI,
  height, SpO2, temperature. If BP is printed as 124/78, emit two markers: Systolic BP 124 mmHg
  and Diastolic BP 78 mmHg.
- Infer top-level "kind" from the document itself (${HEALTH_DOCUMENT_KIND_SCHEMA}). Do not rely on
  the upload label.
- Infer top-level "doc_date" from the collection date, test date, exam date, scan date, or report
  date printed in the document. Prefer the specimen/scan date over a final-report date. If no
  date is visible, return null.
- Prefer the reference ranges printed on the document to set "flag" (low/normal/high). If none is
  shown, set flag to null rather than guessing.
- "memory" is [] UNLESS there is a genuinely notable, durable fact (a clearly out-of-range marker
  worth tracking, a meaningful body-composition change, an injury-relevant finding). Keep items
  short and factual. Do NOT repeat anything already in EXISTING MEMORY below.

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${ENRICH_HEALTH_SCHEMA}

CONTEXT:
profile: ${JSON.stringify(profile)}
${
  kind === "food"
    ? `PREPARATION CONTEXT (canonical allowlisted tokens only; the user's meal note is authoritative): ${JSON.stringify(recentMemory)}`
    : `EXISTING MEMORY (do not repeat): ${JSON.stringify(recentMemory)}`
}`;
}

// ---- food photo → macros (vision) ----------------------------------------------
// A plate photo the user attached in Chat. The agent CLIs (Claude Code / Codex)
// can open local files, so we hand the agent the ABSOLUTE image path (same trick as
// the health-doc ingest) and ask it to LOOK at the plate and estimate its foods +
// macros. Output is FLAT top-level macros (NOT the {structured} wrapper the text
// enricher uses) — enrich.ts applyFoodPhoto reads it directly. The ingredient rows,
// pattern bands and provenance come from the one shared contract in
// src/foodCapture.ts: this is the path where the portion is INFERRED, so structure
// matters most here and honest provenance is what keeps it from reading as measured.
// Rough is fine; honest > precise. Constitution: never moralize the food, never a score.
export function buildFoodPhotoPrompt(absPath: string, hint?: string): string {
  const profile = repo.getProfile();
  const goal = repo.computeGoalCheck();
  const preparationContext = foodEnrichmentPreparationContext();
  return `You estimate the nutrition of a meal from a PHOTO of the plate, for a user's food log.
The photo is a local image file saved on this machine.

LOOK AT THE IMAGE FILE AT THIS ABSOLUTE PATH:
${absPath}
Open and view that image directly before answering. If the runtime attached the same image bytes inline,
use that inline image as the source of truth and do not claim you cannot access the local file.${
    hint
      ? `
The user's note for this meal: "${hint}" — use it to disambiguate, but trust what you SEE.`
      : ""
  }

YOUR JOB:
- Identify the dish(es) on the plate and the visible foods/components.
- Estimate portion sizes from ordinary servings and what the plate/utensils imply about scale.
- Break the plate into ingredient ROWS with their own amounts and macros.
- Estimate TOTAL macros for the whole plate: calories, protein, carbs, fat, fiber.

GUARDRAILS:
- Rough is fine — never invent precision. A photo can't show oil, butter, or hidden sugar, so
  estimate sensibly and lean to an honest middle, not a flattering low.
- NEVER moralize the food. No "treat", "cheat", "indulgent", "guilty", "bad/good" — just describe and
  estimate. This is a calm log, not a judgement.
- If you genuinely cannot tell what something is, say so in "summary" and give your best rough total;
  use null for any single macro you truly can't estimate rather than guessing wildly.
- "confidence" is a COARSE band, not a number: "high" (clear, familiar plate), "medium" (reasonable
  guess), "low" (hard to read — portions unclear, packaging only, dim photo).
${foodCaptureGuardrailLines()}
- A portion you read off a PICTURE is basis:"photo", never "user_report" — the athlete stating a
  quantity in their note, or a readable package label, is what earns those. Splitting the plate into
  rows makes the estimate more USEFUL, not more certain: keep confidence honest for what a photo can
  actually support.
- A restaurant photo cannot justify precise micronutrient numbers. Use only coarse nutrition_pattern
  bands, and keep confidence low/medium unless a readable label or explicit user statement supports it.
  Alcohol and caffeine stay null unless visible or stated.
- Estimate saturated_fat_g and unsaturated_fat_g only when visible ingredients plus the user's note or
  durable preparation memory support a practical split; otherwise use null. The two should remain
  consistent with total fat. User-reported cooking method/oil overrides generic visual assumptions.

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
{
  "summary": "<clean dish name / short description of the plate>",
  "items": ["<visible item + estimated quantity, e.g. 'scrambled eggs (~2 eggs)' >"],
  "ingredients": [
    ${FOOD_INGREDIENT_SCHEMA}
  ],
  "kcal": <number|null>,
  "protein_g": <number|null>,
  "carbs_g": <number|null>,
  "fat_g": <number|null>,
  "fiber_g": <number|null>,
  "nutrition_pattern": ${FOOD_NUTRITION_PATTERN_SCHEMA},
  "notes": <string|null>,
  ${FOOD_PROVENANCE_SCHEMA}
}

CONTEXT (for portion realism only — do NOT let the goal bias the estimate up or down):
profile: ${JSON.stringify(profile)}
goal: ${JSON.stringify(goal)}
PREPARATION CONTEXT (canonical allowlisted tokens only; the user's meal note is authoritative): ${JSON.stringify(preparationContext)}`;
}

// ---------- Garmin strength reconciliation (match → enrich → extrapolate) ----------
const GARMIN_STRENGTH_SCHEMA = `{
  "summary": "<one calm plain sentence on how the body responded — HR / time-in-zone / effort. No scores, no numbers-as-vanity.>",
  "intensity": "easy" | "moderate" | "hard" | null,
  "sets": [
    // ONE entry per detected set you are confident about, in order. EMPTY when there's
    // nothing reliable to log (then extrapolated=false).
    { "exercise": "<exact ALREADY-KNOWN or PLAN exercise name when it clearly matches, else a clean human name from the Garmin category>",
      "weight": <number|null>,        // lb; null = bodyweight; negative = assisted
      "reps": <number|null>,
      "duration_sec": <number|null>,  // timed holds only (plank, dead hang)
      "mode": "reps" | "timed" }
  ],
  "extrapolated": true | false        // true iff you emitted any sets
}`;

// Reconstruct what a Garmin-recorded strength workout was, and how the body
// reacted, so it lands as ONE enriched Cairn session. This is INFORMATIONAL
// reconstruction of a workout that already happened — not coaching, not a plan
// change, no scores. The deterministic layer (repo.reconcileGarminStrength) has
// already attached the physiology; this fills the narrative + the exercises Garmin
// detected that the user did NOT already log by hand.
export function buildGarminStrengthPrompt(garminActivity: any): string {
  const ga = garminActivity ?? {};
  const date = ga.date || "";
  const session = date ? repo.getSessionByDate(date) : null;
  const logged = Array.isArray((session as any)?.sets) ? (session as any).sets : [];
  // What the user already logged by hand for this day — NEVER duplicate these.
  const loggedExercises = [...new Set(logged.map((s: any) => s.exercise).filter(Boolean))];
  const exercises = (repo.listExercises() as any[]).map((e) => ({
    name: e.name,
    mode: e.mode || "reps",
    muscle_group: e.muscle_group || null,
  }));
  const plan = (repo.getPlan() as any[]).map((d) => ({
    day: d.name,
    focus: d.focus || null,
    exercises: (d.items || []).map((it: any) => it.exercise),
  }));
  const profile = repo.getProfile();

  // The physiology + detected sets Garmin gave us for THIS activity.
  const activity = {
    type: ga.type ?? null,
    date,
    duration_min: ga.duration_min ?? null,
    avg_hr: ga.avg_hr ?? null,
    max_hr: ga.max_hr ?? null,
    calories: ga.calories ?? null,
    training_effect: ga.training_effect ?? null,
    aerobic_te: ga.aerobic_te ?? null,
    anaerobic_te: ga.anaerobic_te ?? null,
    hr_zones: ga.hr_zones ?? null,
    exercise_sets: ga.exercise_sets ?? null,
  };

  return `You reconcile a Garmin-recorded STRENGTH workout into the user's training log. The
workout already happened; your job is (a) a one-line read of how the body responded, and (b) the
exercises Garmin detected, cleaned up (naming + mode only) — but ONLY the ones the user did not
already log by hand.

THE CONSTITUTION (binding):
- This is informational RECONSTRUCTION of a past session, not coaching and not a plan change.
- No 0-100 scores, no metric dump. The summary is one calm, plain sentence in a friend's voice.

GUARDRAILS:
- Use ONLY Garmin's detected "exercise_sets". NEVER invent exercises, reps, or weights. If
  exercise_sets is empty/missing, return "sets": [] and "extrapolated": false and just summarize the
  physiology.
- DO NOT emit a set for any exercise already in ALREADY LOGGED — the user logged those by hand and
  they are the source of truth. Fill in only the OTHER detected exercises.
- Map each Garmin category (e.g. "BENCH_PRESS", "BARBELL_DEADLIFT") to an exact KNOWN EXERCISE or
  PLAN exercise name when it clearly matches; otherwise use a clean, human exercise name derived from
  the category (Title Case, e.g. "Barbell Bench Press"). Prefer reusing existing names.
- The set weights are ALREADY in the user's own units (pounds) — do NOT convert, re-scale, or
  invent weights. Copy the detected weight through as-is. weight = null means bodyweight (push-ups,
  pull-ups, dips); a NEGATIVE weight means an assisted movement (leave that sign intact).
- Timed holds (plank, dead hang, wall sit) → set "duration_sec" + "mode":"timed" with weight null;
  everything else → "mode":"reps" with reps (and weight when loaded).
- Group consecutive identical detected sets faithfully — one entry per working set, in order.
- "extrapolated" is true iff you emitted at least one set.

THIS GARMIN STRENGTH ACTIVITY:
${JSON.stringify(activity)}

ALREADY LOGGED (by hand, this day — do NOT duplicate): ${JSON.stringify(loggedExercises)}
KNOWN EXERCISES (reuse these names + their mode): ${JSON.stringify(exercises)}
TRAINING PLAN (map categories to these where they fit): ${JSON.stringify(plan)}
PROFILE (units are POUNDS): ${JSON.stringify(profile)}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${GARMIN_STRENGTH_SCHEMA}`;
}
