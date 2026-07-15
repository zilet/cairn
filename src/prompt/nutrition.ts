// Nutrition prompts: the weekly meal plan, the adaptive check-in retarget, the
// single-meal swap, and the per-meal recipe. Owns the household-diet renderer.
import { todayISO } from "../db.js";
import * as repo from "../repo.js";
import type { CoachContext } from "../repo/coach-context.js";
import {
  canonicalHardDietKeys,
  hardDietFreeRemainder,
  mealPlanHardDietKeys,
  type HardDietKey,
} from "../repo/dietary-constraints.js";
import {
  CONTEXT_GUARDRAILS,
  disciplineOf,
  renderBodyComp,
  renderConnectedBrain,
  renderDexaTargeting,
  renderDiscipline,
  renderEnduranceGoal,
  renderSignalState,
  renderTrajectory,
  renderTodayFuel,
  renderStreamingContract,
  CAIRN_PERSONA,
} from "./shared.js";

const MEAL_SCHEMA = `{
  "summary": "approach for the week, and the daily kcal / protein / fiber targets used",
  "daily_kcal": <number>,
  "daily_protein_g": <number>,
  "daily_fiber_g": <number — at least 30>,
  "days": [
    { "day": "Mon",
      "note": "<optional one-liner: carb timing / prep hint for this day, e.g. 'training day — carbs front-loaded'>",
      "meals": [ { "name": "<dish name, e.g. Chicken & rice bowl>", "items": "short ingredient list", "kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "fiber_g": <number> } ] }
  ],
  "shopping": ["item", "item"],
  "practicality": {
    "prep_pattern": "<how this fits the user's real week and available prep time>",
    "budget_availability": "<ordinary substitutions for cost or availability>",
    "household_fit": "<how shared meals respect the household constraints>",
    "repeatable_staples": ["<frequent food intentionally reused>"],
    "confidence": "low|medium|high"
  },
  "nutrition_pattern": {
    "fiber": "adequate|watch|unknown", "omega_3_sources": "adequate|watch|unknown",
    "iron_context": "adequate|watch|unknown", "calcium_potassium": "adequate|watch|unknown",
    "saturated_fat_added_sugar": "supportive|watch|unknown",
    "basis": "planned_food_pattern", "confidence": "low|medium|high"
  },
  "notes": "<flags, swaps, anything the user should know>"
}`;

// Plain-language age from a YYYY-MM-DD birthdate, computed against today.
// Mirrors the PWA's ageFromBirthdate (public/js/): babies in months, everyone else in
// years; null/garbage → "" (no age shown). Kept deterministic for the prompt.
function ageFromBirthdate(bd: any, ref?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(bd || ""));
  if (!m) return "";
  const b = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(b.getTime())) return "";
  const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(ref || todayISO());
  const now = t ? new Date(Number(t[1]), Number(t[2]) - 1, Number(t[3])) : new Date();
  let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (now.getDate() < b.getDate()) months--;
  if (months < 0) return "";
  if (months < 24) return `${months} mo`;
  return `${Math.floor(months / 12)} yr`;
}

// The household-diet renderer for the meal prompts (Phase: family-nutrition).
// Compiles, in calm plain language, the USER's own allergies (HARD safety
// exclusions — meals MUST exclude these) + dietary restrictions (respected
// strongly), then each family member's name/age + their allergies/restrictions
// surfaced as OPTIONAL kid-friendly / household mods. An allergy is a SAFETY
// hard-exclusion, the one place the constitution allows a hard rule. Returns ""
// when nothing is declared — quiet by default, like renderConnectedBrain.
function renderHouseholdDiet(ctx: any): string {
  const profile: any = ctx?.profile ?? {};
  const family: any[] = Array.isArray(ctx?.family) ? ctx.family : [];
  const clean = (v: any) => String(v ?? "").trim();
  const lines: string[] = [];

  const myAllergies = clean(profile.allergies);
  const myDiet = clean(profile.dietary_restrictions);
  // A recognized whole-diet in this field is rendered as a HARD constraint by
  // renderHardDiet (not here), so strip those keywords out before the softer
  // "respect strongly" line — otherwise vegan/vegetarian would read as a mere
  // preference AND double-render. Any non-diet remainder ("no cilantro") stays soft.
  const softDiet = hardDietFreeRemainder(myDiet);
  const self: string[] = [];
  if (myAllergies)
    self.push(
      `  - ALLERGIES (HARD EXCLUSION — for safety, NEVER include these ingredients in ANY meal, item, recipe, or substitution): ${myAllergies}`
    );
  if (softDiet) self.push(`  - DIETARY RESTRICTIONS (respect strongly): ${softDiet}`);
  if (self.length) {
    lines.push("USER'S DIETARY NEEDS:");
    lines.push(...self);
  }

  // Family members with anything declared → optional household mods.
  const memberLines: string[] = [];
  for (const f of family) {
    const fa = clean(f?.allergies);
    const fd = clean(f?.dietary_restrictions);
    if (!fa && !fd) continue;
    const name = clean(f?.name) || "a family member";
    const age = ageFromBirthdate(f?.birthdate);
    const rel = clean(f?.relationship);
    const who = [name, age, rel].filter(Boolean).join(", ");
    const parts: string[] = [];
    if (fa) parts.push(`allergies: ${fa} (HARD EXCLUSION if this person shares the meal)`);
    if (fd) parts.push(`diet: ${fd}`);
    memberLines.push(`  - ${who} — ${parts.join("; ")}`);
  }
  if (memberLines.length) {
    lines.push(
      "HOUSEHOLD (optional kid-friendly / shared-meal mods — plan PRIMARILY for the user's own goal & protein target, but where it's EASY, note in that day's \"note\" field a simple mod so ONE base meal can also serve these people; never compromise the user's allergens or protein for this):"
    );
    lines.push(...memberLines);
  }

  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

// Food/diet tokens — used to pick the memory rows that shape what to cook (a
// like/dislike, an allergy, a diet). Kept broad but food-specific so a non-food
// preference ("trains in the morning") never leaks into the meal prompts.
const FOOD_MEMORY_RE =
  /\b(salmon|fish|seafood|shellfish|shrimp|prawn|tuna|sardine|mackerel|cod|chicken|beef|pork|lamb|turkey|steak|egg|eggs|dairy|milk|cheese|yogurt|gluten|wheat|nuts?|peanut|almond|cashew|walnut|soy|tofu|tempeh|rice|pasta|potato|bread|oats?|beans?|lentil|chickpea|quinoa|broccoli|kale|spinach|avocado|banana|berry|berries|fruit|veg|vegetable|veggies?|mushroom|onion|garlic|cilantro|coriander|spicy|spice|coffee|alcohol|meat|takeout|restaurant|caf[eé]|treat|home[- ]cook(?:ed|ing)?|vegan|vegetarian|pescatarian|keto|paleo|carnivore|halal|kosher|lactose|intoleran|allerg)\b/i;

const MEAL_PLANNING_MEMORY_KINDS = new Set(["preference", "constraint", "decision", "goal"]);
const ONE_OFF_FOOD_MEMORY_RE =
  /\b(?:ate|had|ordered|tried|visited|went to|picked up|takeout from|last (?:night|week|month)|yesterday|today)\b/i;
const STABLE_FOOD_MEMORY_RE =
  /\b(?:prefer|usually|typically|regularly|routine|staple|always|never|avoid|allerg|intoleran|diet|home[- ]cook(?:ed|ing)?|cook(?:s|ed|ing)? at home)\b/i;
const OPTIONAL_FOOD_MEMORY_RE =
  /\b(?:occasionally|occasional|sometimes|infrequent|not (?:fully )?off-limits|workable (?:local )?option|when ordering|can (?:still )?(?:have|order|enjoy)|backup option)\b/i;

// Meal planning gets a purpose-scoped memory view, not the raw recent-memory
// stream. Observations are evidence that something happened; only durable
// preference/constraint/decision/goal rows may shape a future week. Enrichment
// must see a pattern at least twice before its inferred preference is trusted.
// This prevents a single meal log from silently becoming a standing commitment.
function memoryForMealPlanning(memory: any[]): any[] {
  return (Array.isArray(memory) ? memory : []).filter((m) => {
    if (!m || !MEAL_PLANNING_MEMORY_KINDS.has(String(m.kind ?? ""))) return false;
    const content = String(m.content ?? "").trim();
    if (!content) return false;
    if (ONE_OFF_FOOD_MEMORY_RE.test(content) && !STABLE_FOOD_MEMORY_RE.test(content)) return false;
    // Permission is not intent. "Can occasionally have baklava" and "workable
    // takeout option" are useful answers when asked, but not defaults a weekly
    // planner should proactively schedule.
    if (OPTIONAL_FOOD_MEMORY_RE.test(content) && !STABLE_FOOD_MEMORY_RE.test(content)) return false;
    if (String(m.source ?? "") === "enrich" && Number(m.confidence ?? 1) < 1.5) return false;
    return true;
  });
}

// Render food preferences/constraints from memory (a "hates salmon", a "dairy allergy",
// "vegetarian") so the SWAP and RECIPE prompts honor them — otherwise a swap can happily
// reintroduce a food the user told the coach they avoid. Bounded, plain words. "" when
// nothing food-relevant is remembered.
function renderFoodMemory(memory: any[]): string {
  const rows = (Array.isArray(memory) ? memory : [])
    .filter((m) => m && typeof m.content === "string" && FOOD_MEMORY_RE.test(m.content))
    .slice(0, 12);
  if (!rows.length) return "";
  return `\nFOOD PREFERENCES & CONSTRAINTS (from memory — HONOR these; never propose a food they've said they dislike or must avoid, and lean on the ones they like):\n${rows.map((m) => `  - ${String(m.content).trim()}${m.kind ? ` [${m.kind}]` : ""}`).join("\n")}\n`;
}

// A one-line acute-load/fatigue note for the nutrition check-in — the meal-plan prompt
// already folds this in, but the retarget was blind to it, so a mileage/volume RAMP
// never reached the check-in. Reads the deterministic training signals + recovery +
// run compliance already on the context. "" when there's nothing load-bearing to say.
function renderAcuteLoadNote(ctx: any): string {
  const bits: string[] = [];
  const auto = ctx?.training_signals?.autoregulation?.note;
  if (auto) bits.push(String(auto).trim());
  const rc = ctx?.recovery?.recovery;
  if (rc?.acute_load != null) bits.push(`acute training load ~${Math.round(rc.acute_load)}`);
  // Only surface running when there's ACTUAL running load (a ramp) — the benign
  // "no runs prescribed this week" default is not load-bearing.
  const comp = ctx?.run_compliance;
  const ranSomething = Number(comp?.actual_sessions) > 0 || Number(comp?.actual_km) > 0;
  if (comp?.in_words && ranSomething) bits.push(`running this week: ${String(comp.in_words).trim()}`);
  const hard = Array.isArray(ctx?.recovery?.hard_sessions) ? ctx.recovery.hard_sessions.length : 0;
  if (hard) bits.push(`${hard} hard session${hard === 1 ? "" : "s"} in the recent window`);
  if (!bits.length) return "";
  return `\nACUTE TRAINING LOAD & FATIGUE (fold this into the read): ${bits.join("; ")}. If training volume/mileage is RAMPING or fatigue is high, the calm move is usually to FUEL the work — hold or RAISE intake (protein and carbs protected), NOT cut. A sustained deficit into a mileage ramp is the thing to flag (suggest eating more, not less).\n`;
}

// The athlete's own one-tap fueling reads since the last target change (energy on a calm
// running-low/steady/plenty scale, optional appetite + note) as plain, adherence-neutral
// lines. This is the SUBJECTIVE follow-through the check-in weighs alongside the weight
// trend — repeated "running low" after a cut is a reason to hold or gently raise, never to
// cut further. Reads context.fueling when present, else the repo. "" when nothing's logged.
const FUEL_ENERGY_WORD: Record<number, string> = { 1: "running low", 2: "steady", 3: "plenty" };
const FUEL_HUNGER_WORD: Record<number, string> = { 1: "not hungry", 2: "satisfied", 3: "hungry" };
function renderFuelingFeedback(context: any): string {
  const rows = Array.isArray(context?.fueling) ? context.fueling : repo.listFuelingFeedback(14);
  const lines = (Array.isArray(rows) ? rows : [])
    .slice(0, 14)
    .map((r: any) => {
      const bits: string[] = [];
      const energyWord = FUEL_ENERGY_WORD[Number(r?.energy)];
      if (energyWord) bits.push(`energy ${energyWord}`);
      const hungerWord = FUEL_HUNGER_WORD[Number(r?.hunger)];
      if (hungerWord) bits.push(hungerWord);
      const note = String(r?.note ?? "").trim();
      if (note) bits.push(`"${note.slice(0, 120)}"`);
      return bits.length ? `  - ${r?.date ?? "recent"}: ${bits.join(", ")}` : "";
    })
    .filter(Boolean);
  if (!lines.length) return "";
  return `\nFUELING FOLLOW-THROUGH (the athlete's own one-tap reads since the last target change — subjective and adherence-neutral; weigh alongside the weight trend. Repeated "running low" energy after a cut is a reason to HOLD or gently RAISE, never to cut further):\n${lines.join("\n")}\n`;
}

// Longevity + lean guardrails shared by the weekly meal-plan and meal-swap prompts.
// The journey's SHAPE (v41) → a plain-language fueling instruction that CONDITIONS
// the deficit / "getting-lean" framing on the actual goal mode, so a maintaining or
// lean-building user is never pushed into a cut. Reads ctx.goal_mode (always set
// by getCoachContext) and falls back to ctx.goal.goal_mode. Calm, no scores.
function renderGoalMode(ctx: any): string {
  const mode = String(ctx?.goal_mode || ctx?.goal?.goal_mode || "maintain");
  const goal = ctx?.goal && ctx.goal.ok ? ctx.goal : null;
  // Prefer the ACCEPTED target (the persisted output of the adaptive loop) over the
  // re-derived formula, so meals anchor to the number the user actually accepted.
  const eff = goal?.effective_target;
  const accepted = eff?.source === "accepted";
  const tgt = eff?.target_kcal ?? goal?.recommended?.target_intake_kcal;
  const protein = eff?.protein_g ?? goal?.recommended?.protein_g;
  const anchor = tgt
    ? ` Anchor daily calories near ~${tgt} kcal with ~${protein} g protein (${accepted ? "the user's ACCEPTED adaptive-nutrition target — honor it over the formula" : eff?.review_due ? "the prior adaptive target is review-due and visible in expired_target; use this current formula until it is reviewed" : "goal.recommended"}).`
    : "";
  if (mode === "maintain") {
    return `\nGOAL MODE: MAINTAIN — the user is holding steady, NOT losing weight. Do NOT prescribe a deficit or frame food as "getting lean"; fuel to maintenance — enough to support training and recovery, protein-forward, whole-food quality. Only flag intake if the measured weight trend genuinely drifts.${anchor}\n`;
  }
  if (mode === "gain") {
    return `\nGOAL MODE: LEAN GAIN — the user is building, so eat in a CONSERVATIVE surplus (slow, muscle-biased — never a dirty bulk). Keep protein high and food quality high; the connected brain's lab directives still gate WHAT the surplus is made of (e.g. cap saturated fat if ApoB is up).${anchor}\n`;
  }
  return `\nGOAL MODE: LOSE — a lean-safe deficit toward the goal weight, protein protected, never a crash cut.${anchor}\n`;
}

// One compact strategy block shared by target check-ins and weekly meal plans.
// It keeps whole-person signals in their proper role: completed intake/scale/RMR
// and wearable history estimate baseline maintenance; training, recovery,
// performance and life context shape aggressiveness/timing and may protect fuel,
// but never masquerade as extra baseline calories or get added twice.
function renderHolisticNutritionStrategy(ctx: any, expenditure: any): string {
  const compactActivities = (Array.isArray(ctx?.recent_activities) ? ctx.recent_activities : [])
    .slice(0, 10)
    .map((activity: any) => ({
      date: activity?.date ?? null,
      type: activity?.type ?? activity?.activity_type ?? activity?.summary ?? null,
      duration_min: activity?.duration_min ?? null,
      distance_km: activity?.distance_km ?? null,
    }));
  const compactEvents = (Array.isArray(ctx?.context_events) ? ctx.context_events : [])
    .slice(0, 8)
    .map((event: any) => ({
      kind: event?.kind ?? null,
      title: event?.title ?? null,
      start_date: event?.start_date ?? null,
      end_date: event?.end_date ?? null,
    }));
  const strategy = {
    maintenance: {
      ordinary_day_kcal: expenditure?.typical_tdee ?? expenditure?.tdee ?? null,
      long_run_average_kcal: expenditure?.tdee ?? null,
      range: expenditure?.maintenance_range ?? null,
      confidence: expenditure?.confidence ?? "none",
      basis: expenditure?.basis ?? null,
      exceptional_activity: expenditure?.exceptional_activity ?? null,
      rule: "Exceptional activity is already frequency-amortized. Never add wearable/activity calories again.",
    },
    coordinated_target: ctx?.goal?.effective_target ?? null,
    goal_mode: ctx?.goal_mode ?? ctx?.goal?.goal_mode ?? null,
    recovery: ctx?.recovery
      ? {
          has_data: ctx.recovery.has_data ?? null,
          days: ctx.recovery.days ?? null,
          recent: ctx.recovery.recent ?? null,
          baseline: ctx.recovery.baseline ?? null,
          delta: ctx.recovery.delta ?? null,
        }
      : null,
    performance: ctx?.performance
      ? {
          headline: ctx.performance.headline ?? null,
          status: ctx.performance.status ?? null,
          trend: ctx.performance.trend ?? null,
        }
      : null,
    hybrid_fuel: ctx?.program_state?.hybrid?.fuel ?? null,
    recent_training: compactActivities,
    fueling_feedback: Array.isArray(ctx?.fueling) ? ctx.fueling.slice(0, 8) : [],
    life_context: compactEvents,
  };
  return `\nWHOLE-PERSON NUTRITION STRATEGY:\n${JSON.stringify(strategy)}\n- Baseline maintenance comes ONLY from the completed-day expenditure evidence above. Training/recovery/performance/life signals tune deficit aggressiveness, carb timing, and protective fueling; they do not increase baseline TDEE.\n- Low recovery, performance fade, rising hybrid load, illness, or explicit under-fueling may HOLD or RAISE fuel. They can never justify lowering calories.\n`;
}

// Recognized whole-diet identities that are HARD constraints — as firm as an
// allergy. Naming one of these (in the profile's dietary_restrictions, in
// settings.meal_prefs, or as a typed instruction/hint) means EVERY meal, item,
// recipe, and substitution MUST comply. Matched case-insensitively on WORD
// BOUNDARIES (with an optional trailing "s") so "novegan" or a bare substring
// never misfires. Array order is the render order. A `plantForward` diet also
// re-anchors the protein/omega-3 guardrails onto plant sources (no animal
// protein instruction). An un-recognized free-text diet stays the softer
// "respect strongly" nudge in renderHouseholdDiet — this is ONLY the hard set.
const HARD_DIETS: { key: HardDietKey; label: string; rule: string; plantForward?: boolean }[] = [
  {
    key: "vegan",
    label: "VEGAN",
    plantForward: true,
    rule: "NO meat, poultry, fish, seafood, dairy, eggs, honey, gelatin, or any animal-derived ingredient.",
  },
  {
    key: "vegetarian",
    label: "VEGETARIAN",
    plantForward: true,
    rule: "NO meat, poultry, fish, or seafood (dairy & eggs are allowed unless also excluded).",
  },
  {
    key: "pescatarian",
    label: "PESCATARIAN",
    rule: "NO meat or poultry (fish & seafood are allowed).",
  },
  {
    key: "dairy_free",
    label: "DAIRY-FREE",
    rule: "NO milk, cream, butter, cheese, yogurt, whey, casein, ghee, or other dairy-derived ingredient.",
  },
  {
    key: "gluten_free",
    label: "GLUTEN-FREE",
    rule: "NO wheat, barley, rye, seitan, gluten, or non-certified grain products that contain gluten.",
  },
  {
    key: "halal",
    label: "HALAL",
    rule: "Every ingredient must be HALAL — no pork or pork-derived ingredients, no alcohol, and only halal-permissible meat.",
  },
  {
    key: "kosher",
    label: "KOSHER",
    rule: "Every ingredient must be KOSHER — no pork or shellfish, and never mix meat and dairy in the same meal.",
  },
  {
    key: "keto",
    label: "KETO",
    rule: "Ketogenic — NO high-carb staples (bread, pasta, rice, potatoes, sugar, most fruit); keep net carbs very low.",
  },
  {
    key: "carnivore",
    label: "CARNIVORE",
    rule: "Carnivore — animal foods only; NO plant foods (grains, legumes, vegetables, fruit).",
  },
  {
    key: "paleo",
    label: "PALEO",
    rule: "Paleo — NO grains, legumes, dairy, or refined sugar; whole, unprocessed foods only.",
  },
];

// Detect every recognized whole-diet across all the places the user could have
// declared it (profile.dietary_restrictions, settings.meal_prefs, a typed
// instruction/hint), de-duped to the registry order. Kept pure for tests.
function detectHardDiets(sources: Array<string | null | undefined>): typeof HARD_DIETS {
  const keys = new Set(sources.flatMap((source) => canonicalHardDietKeys(source, "authoritative")));
  return HARD_DIETS.filter((diet) => keys.has(diet.key));
}

// A direct task/hint is current-turn authority, but a negated identity such as
// "I'm not vegan" is authority that the identity does NOT apply. Strip only the
// negated diet phrase before hard-diet detection; an affirmative identity in the
// same instruction remains enforceable. Profile dietary_restrictions is never
// passed through this helper because that field is the durable source of truth.
function explicitHardDietInstruction(value: unknown): string {
  return canonicalHardDietKeys(value, "instruction").map(hardDietDeclaration).join("\n");
}

// meal_prefs is durable free text, but it also carries ordinary scheduling and
// menu preferences. Only explicit identity/global-must clauses may promote a
// diet from a preference to a whole-plan hard constraint. Profile
// dietary_restrictions remains authoritative, and a direct task/hint is handled
// separately as the user's current instruction.
function explicitHardDietMealPrefs(value: unknown): string {
  return canonicalHardDietKeys(value, "meal_prefs").map(hardDietDeclaration).join("\n");
}

function hardDietDeclaration(key: HardDietKey): string {
  return key === "dairy_free" ? "dairy-free" : key === "gluten_free" ? "gluten-free" : key;
}

function storedHardDietDeclarations(parsed: any): string {
  return mealPlanHardDietKeys(parsed).map(hardDietDeclaration).join("\n");
}

// True when a matched diet forbids animal protein / fish (vegan, vegetarian) —
// drives the plant-forward protein & omega-3 guardrail text.
function isPlantForward(sources: Array<string | null | undefined>): boolean {
  return detectHardDiets(sources).some((d) => d.plantForward);
}

// The HARD dietary-identity block — the same firmness/format as the allergy line
// (a whole-diet identity is a hard rule, not a preference). "" when no recognized
// diet is declared in any source. De-duped across sources by construction.
function renderHardDiet(sources: Array<string | null | undefined>): string {
  const hits = detectHardDiets(sources);
  if (!hits.length) return "";
  const lines = hits.map(
    (d) =>
      `  - ${d.label} (HARD RULE — as firm as an allergy; EVERY meal, item, recipe, and substitution MUST comply): ${d.rule}`
  );
  return `\nDIETARY IDENTITY (HARD CONSTRAINT — the user follows this diet; treat it with the SAME firmness as an allergy: NEVER include an excluded ingredient in ANY meal, item, recipe, or substitution):\n${lines.join("\n")}\n`;
}

// Framing: super-healthy, goal-aware, longevity coach — not just a macro calculator.
// Protein and omega-3 anchors bend to a plant-forward diet (vegan/vegetarian): no
// animal-protein instruction, no fish — otherwise the guardrails would contradict
// the HARD dietary-identity block above.
function longevityGuardrails(plantForward = false): string {
  const proteinLine = plantForward
    ? "- Anchor EVERY meal on PLANT protein (legumes, lentils, beans, chickpeas, tofu, tempeh, seitan, edamame, soy, seeds); use goal.effective_target.protein_g when present, otherwise goal.recommended.protein_g. Do NOT use meat, poultry, or fish to hit protein."
    : "- Anchor EVERY meal on protein; use goal.effective_target.protein_g when present, otherwise goal.recommended.protein_g.";
  const omega3Line = plantForward
    ? "- Omega-3s from plant sources 2-3x/week (ground flaxseed, chia, walnuts, hemp, algae oil) — no fish."
    : "- Oily fish 2-3x/week (salmon, sardines, mackerel) or another omega-3 source.";
  return `LONGEVITY GUARDRAILS:
${proteinLine}
- 30g+ fiber per day: vegetables, legumes, fruit, whole grains.
- Build meals from mostly whole, single-ingredient foods; minimize ultra-processed food, added
  sugar, and alcohol.
${omega3Line}
- Calorie target follows goal.effective_target when present, otherwise goal.recommended for the active
  GOAL MODE (a lean-safe deficit, maintenance, or a conservative surplus) — never a crash deficit and
  never an aggressive bulk.
- Keep the last meal of the day moderate, not enormous or very late.`;
}

// Meal slots are flexible — the plan must bend around the user's real training schedule,
// not assume a textbook pre/post-workout sandwich.
const MEAL_TIMING_RULES = `MEAL TIMING — slots are FLEXIBLE, schedule around the user's stated training times:
- Meal labels (breakfast/lunch/...) are suggestions, not a fixed template. Adapt count and timing
  to the USER SCHEDULE & MEAL PREFERENCES section (when present) and the training plan.
- If the user trains FASTED in the morning, do NOT emit a pre-workout meal — give them a
  substantial post-training breakfast instead.
- Use each day's "note" field to explain the timing choices for that day.`;

function foodPatternIsCurrent(lastAt: unknown, maxAgeDays = 42): boolean {
  const raw = String(lastAt ?? "").trim();
  if (!raw) return false;
  const stamped = /Z$|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`;
  const time = Date.parse(stamped);
  return Number.isFinite(time) && Date.now() - time <= maxAgeDays * 86_400_000;
}

// Goal-aware weekly meal-plan prompt.
export function buildMealPlanPrompt(userInstruction?: string): string {
  const ctx = repo.getCoachContext();
  const planningMemory = memoryForMealPlanning((ctx as any)?.memory);
  const planningCtx = { ...ctx, memory: planningMemory };
  const prefs = (repo.getSettings().meal_prefs || "").trim();
  const split = (ctx.plan as any[])
    .map((d: any) => `Day ${d.day_number}: ${d.name}${d.focus ? ` (${d.focus})` : ""}`)
    .join("; ");
  // Make the plan adapt to the user's REAL inputs, not just a static goal number:
  // (1) the foods they actually log, (2) their measured expenditure, (3) current fatigue.
  const exp = repo.estimateExpenditure(21);
  const freqMap = new Map<string, any>();
  for (const h of [8, 13, 19])
    for (const f of repo.frequentFoods(h).slice(0, 4)) {
      // Capture chips may surface a one-off for convenient re-logging. A weekly
      // planner needs stronger evidence: at least two distinct logged days, with
      // a recent occurrence so an old phase does not become a permanent habit.
      if (Number(f.distinct_days ?? 0) < 2 || !foodPatternIsCurrent(f.last_at)) continue;
      const k = String(f.summary).toLowerCase();
      if (!freqMap.has(k)) freqMap.set(k, f);
    }
  const freqList = [...freqMap.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  const freqBlock = freqList.length
    ? `\nREPEATED FOOD PATTERNS (observed on 2+ DISTINCT days — optional dish/staple ideas, not preferences or future commitments; reuse only where they fit):\n${freqList.map((f) => `  - ${f.summary} (logged ${f.count}× across ${f.distinct_days} days${f.protein_g != null ? `, ~${Math.round(f.protein_g)}g protein` : ""})`).join("\n")}\n- Never infer a scheduled restaurant visit, takeout, cafe stop, or treat from these historical logs. Only an explicit current instruction or a durable preference/decision can schedule one.\n`
    : "";
  const strategyBlock = renderHolisticNutritionStrategy(ctx, exp);
  const defaultTask =
    disciplineOf(ctx) === "endurance"
      ? "Build next week's meal plan around goal.effective_target when present, otherwise goal.recommended, to FUEL the training week — carbs periodized around long/quality sessions, protein adequate for recovery; no forced deficit unless fat loss is the stated goal."
      : "Build next week's meal plan around goal.effective_target when present, otherwise goal.recommended for the active GOAL MODE, including its protein target.";
  // A whole-diet identity can be declared in the profile, in meal prefs, OR typed
  // into the request — scan all three and treat it as hard as an allergy.
  const dietSources = [
    (ctx.profile as any)?.dietary_restrictions,
    explicitHardDietMealPrefs(prefs),
    explicitHardDietInstruction(userInstruction),
  ];
  const hardDiet = renderHardDiet(dietSources);
  const plantForward = isPlantForward(dietSources);
  return `${CAIRN_PERSONA}

Right now you're the nutritionist — goal-aware and longevity-focused — building a 7-day
meal plan that fuels the user's CURRENT goal (see GOAL MODE below) while eating for healthspan. The
user's profile, goal check (with computed TDEE and a mode-correct recommended intake), training
plan, recent activities, and purpose-scoped durable planning memory are in the DATA section.
${renderGoalMode(ctx)}${hardDiet}
HARD RULES:
- Anchor daily_kcal to goal.effective_target when present (the coordinated reviewed target), otherwise
  goal.recommended (the mode-correct formula target). Never silently replace an accepted target with a
  newer volatile formula, and never use an aggressive crash deficit or dirty bulk, even if
  the user's requested timeline implies more. If their goal is aggressive, build the sustainable
  plan and say so in notes.
- Hit goal.effective_target.protein_g when present, otherwise goal.recommended.protein_g. During a cut, continued strength and muscle
  DEVELOPMENT remain the objective; preservation is the universal safety floor, not the aspiration.
  Use adequate total energy and training-day carbs to fuel earned progression, and never frame the
  plan summary/rationale as if merely preserving lean mass were the goal.
- Never propose intake below ~1500 kcal for this user regardless of math.
- Favor whole foods; respect any preferences/constraints in memory.
- Default to practical home-cooked whole-food meals. A food log says what happened once; it does NOT
  establish a preference, routine, scheduled takeout, restaurant visit, cafe stop, or treat. The
  current meal_plan is prior assistant output, not evidence of what the user wants repeated. Only
  the current TASK, USER SCHEDULE & MEAL PREFERENCES, profile/about_me, active life context, or a
  durable preference/constraint/decision in memory can establish a future commitment.
- Treat "occasionally allowed," "workable option," "not off-limits," and "when ordering" memories
  as contingency guidance only — permission is not intent, so never schedule them proactively.
- Time more carbs around training days; keep it practical and repeatable, not 7 unique gourmet days.
- Evaluate PRACTICALITY as part of adequacy: preparation time, household fit, ordinary cost/availability,
  and reuse of the user's frequent foods. A theoretically perfect plan they will not cook is not adequate.
- Nutrition-pattern judgments are coarse and food-pattern based. Never invent precise sodium, potassium,
  calcium, or iron amounts without a label/source; use unknown when the menu cannot support the claim.
- Set daily_fiber_g to at least 30 and estimate fiber_g for EVERY meal from its listed ingredients and
  portions. The server verifies that the week averages at least this target with no day below 80% of it;
  do not label fiber "adequate" unless the meal totals establish that.

${longevityGuardrails(plantForward)}

${MEAL_TIMING_RULES}

TRAINING SPLIT (plan the week's meals around these training days): ${split || "(no plan days)"}
${
  prefs
    ? `
USER SCHEDULE & MEAL PREFERENCES (follow these — they override generic templates):
${prefs}
`
    : ""
}
${CONTEXT_GUARDRAILS}
- TRIPS specifically: for weeks overlapping a trip, lean on portable, travel-friendly meals and
  flag that the user will be eating out.
- HEALTH MARKERS specifically: make the ACT-NOW nutrition priorities in the PRIORITIZED HEALTH FOCUS
  the backbone of the plan (e.g. a lipid-lowering pattern, iron-rich foods for low ferritin) — let them
  shape the default meals, not just a footnote; flag the marker-driven emphasis in notes. Not medical advice.
${renderSignalState(ctx)}${renderDiscipline(ctx, "nutrition")}${renderEnduranceGoal(ctx, "nutrition")}${freqBlock}${strategyBlock}${renderConnectedBrain(ctx, { domains: ["nutrition"] })}${renderTrajectory(ctx)}${renderFoodMemory(planningMemory)}${renderDexaTargeting(ctx, "nutrition")}${renderBodyComp(ctx)}${renderHouseholdDiet(ctx)}
TASK: ${userInstruction?.trim() || defaultTask}

OUTPUT CONTRACT: respond with ONE JSON object, no prose, no fences:
${MEAL_SCHEMA}

DATA:
${JSON.stringify(planningCtx)}`;
}

// ---------- T3: adaptive nutrition check-in (MacroFactor-style retarget) ----------
// A nutrition target CHANGE, drafted into the ledger and routed through the
// server autonomy policy. "no_change" is a first-class, common answer: most
// weeks nothing has really moved and the calm thing is to stay quiet.
const NUTRITION_CHECKIN_SCHEMA = `{
  "change": true | false,
  "summary": "<one or two plain sentences: what the data shows and what you'd suggest — or, if change is false, why staying put is right>",
  "nutrition": {
    "target_kcal": <number — the suggested new daily calorie target>,
    "protein_g": <number — daily protein target, hold or raise; never drop protein under a deficit>,
    "carbs_g": <number|null>,
    "fat_g": <number|null>,
    "prev_target_kcal": <number|null — context only; the server replaces this with its active target>,
    "reason": "<short, kind, trend-grounded reason; never about 'being good' or adherence>"
  },
  "notes": "<optional — anything to flag, may be empty>"
}`;

// Adaptive-nutrition check-in (Phase 3A). Given the real derived expenditure and
// the current target, ask the agent to either propose a single calm calorie/
// macro target change OR explicitly decline (change:false) when nothing has
// meaningfully moved. The caller only ever drafts a proposal when change:true —
// this prompt is the judgement layer, and the loop is adherence-NEUTRAL: a thin
// logging week is a reason for LESS confidence, never a target cut and never a
// scold. Macro floors: protect protein first, then fat, then carbs flex.
export function buildNutritionCheckinPrompt(ctx?: CoachContext, opts: { windowDays?: number } = {}): string {
  const context = ctx ?? repo.getCoachContext();
  const exp = repo.estimateExpenditure(opts.windowDays ?? 21);
  const goal: any = (context as any)?.goal ?? repo.computeGoalCheck();
  const profile: any = (context as any)?.profile ?? repo.getProfile();
  // The current target the user is eating to: the ACCEPTED adaptive-nutrition
  // target if one has been persisted (this loop's own prior output), else the
  // current mode-aware formula target.
  const eff = goal?.ok ? (goal as any).effective_target : null;
  const currentTarget = goal?.ok ? (eff?.target_kcal ?? goal.recommended?.target_intake_kcal ?? null) : null;
  const proteinTarget = goal?.ok ? (eff?.protein_g ?? goal.recommended?.protein_g ?? null) : null;
  const targetIsAccepted = eff?.source === "accepted";
  // A retarget must respect a HARD whole-diet identity too (it steers macros and
  // is echoed back to the coach) — scan the profile diet + meal prefs.
  const mealPrefs = (repo.getSettings().meal_prefs || "").trim();
  const dietSources = [profile?.dietary_restrictions, explicitHardDietMealPrefs(mealPrefs)];
  const hardDiet = renderHardDiet(dietSources);
  const plantProteinNote = isPlantForward(dietSources)
    ? "\nPLANT-PROTEIN ANCHOR: the user's protein floor must be met with PLANT proteins (legumes, lentils, tofu, tempeh, seitan, edamame, soy, seeds) — never suggest animal protein to protect the protein floor.\n"
    : "";
  return `${CAIRN_PERSONA}

Right now you're the nutritionist — calm, goal-aware, longevity-focused — running a
quiet adaptive-nutrition check-in (MacroFactor-style). Their REAL energy expenditure has been derived
from logged intake and the bodyweight trend, adherence-neutral — it does NOT care whether they "were
good." Decide whether their calorie/macro target should change, and if so propose ONE calm adjustment.
The server records the decision and applies its configured autonomy policy: review posture holds it;
Lead mode may schedule a bounded reversible change at the next food-day boundary with Undo.

THE CONSTITUTION (binding):
- Adherence-NEUTRAL and kind. NEVER mention logging gaps, willpower, "being good/bad", or guilt. A
  thin data week is a reason for LOWER confidence, never a target cut.
- Plain language, no 0-100 scores. Frame food as "remaining", never "consumed"; there are no good or
  bad foods. Calm, never alarmist.
- A SUGGESTION, never a verdict. Only propose a change when the trend has GENUINELY moved away from
  the goal — otherwise set change:false and stay quiet (the common, correct answer most weeks).

BEST-EFFORT EXPENDITURE (chosen TDEE plus explicit outcome/prior anchors; never add wearable activity twice):
${JSON.stringify(exp)}

CURRENT TARGET: ${currentTarget != null ? `~${currentTarget} kcal/day` : "(none set)"}, protein ~${proteinTarget != null ? `${proteinTarget} g/day` : "(unset)"}${targetIsAccepted ? " (the user's ACCEPTED target from a prior check-in — set prev_target_kcal to this, and only change it if the trend has genuinely moved since)" : ""}.
GOAL CHECK (mode-correct recommendation): ${JSON.stringify(goal)}
${renderGoalMode(context)}${hardDiet}${plantProteinNote}
WHEN TO PROPOSE A CHANGE (else change:false):
- Outcome confidence must be at least "medium" AND the trend must have drifted meaningfully off the goal
  pace FOR THIS GOAL MODE — see below. Otherwise set change:false and stay quiet (the common, correct
  answer). The only low-confidence exception is a protective calorie RAISE when fresh deterministic
  hybrid fuel-risk, repeated low-performance feedback, or explicit under-fueling/performance-fade notes
  are present. Low confidence can NEVER justify a cut.
- LOSE: weight flat or rising while the goal is to lose, or losing far faster than the lean-safe ceiling
  (then a small calorie RAISE keeps it sustainable).
- LOSE + PERFORMANCE: repeated strength-endurance fade, a high hybrid fuel-risk read, or a mileage ramp
  while loss is already faster than the lean-ideal pace is ALSO meaningful drift. Propose a small calorie
  RAISE—primarily carbohydrate—even when the trend has not crossed the absolute safety ceiling yet.
- MAINTAIN: only when the weight trend has consistently drifted up OR down off steady — nudge back toward
  maintenance (~the derived TDEE). Never propose a deficit by default; holding steady is success.
- LEAN GAIN: flag if the trend shows NO gain over time (suggest a small RAISE) or gaining too fast /
  fat-biased (suggest easing the surplus). Never cut below maintenance.
- Keep any change SMALL: nudge calories by roughly ±100-250 kcal toward the right pace, never a crash cut.
  Respect the coordinated effective target and the absolute ~1500 kcal floor. A formula refresh is
  not permission to silently rewrite a previously reviewed target.
- MACRO FLOORS: protect PROTEIN first (hold or raise — protein_g >= the current protein target), then fat
  to a healthy minimum, and let CARBS take the adjustment.
- If an active trip/illness window is in the data, prefer change:false — the data is disrupted; wait.${
    disciplineOf(context) !== "strength"
      ? `
- ENDURANCE/HYBRID user: do NOT propose a deficit unless fat loss is an EXPLICIT goal — the default is
  to FUEL the training (anchor to maintenance). Protect CARBOHYDRATE; if anything, a sustained calorie
  deficit while mileage is high is the thing to flag (suggest eating MORE, not less). Carbs are not the
  adjustment lever to cut here.`
      : ""
  }

${CONTEXT_GUARDRAILS}
${renderHolisticNutritionStrategy(context, exp)}
${renderSignalState(context)}${renderDiscipline(context, "nutrition")}${renderEnduranceGoal(context, "nutrition")}${renderConnectedBrain(context, { domains: ["nutrition"] })}${renderTrajectory(context)}${renderDexaTargeting(context, "nutrition")}${renderBodyComp(context)}${renderAcuteLoadNote(context)}${renderTodayFuel(context)}${renderFuelingFeedback(context)}
USER: profile: ${JSON.stringify(profile)}

${renderStreamingContract(
  "write the ONE or two plain sentences you'd say to them — what the data shows and what you'd suggest, or (if nothing has meaningfully moved) why staying put is right (the same thing that goes in the JSON's \"summary\")",
  NUTRITION_CHECKIN_SCHEMA
)}`;
}

const SWAP_SCHEMA = `{ "name": "<dish>", "items": "<short ingredient list>", "kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "fiber_g": <number> }`;

// Agentic single-meal swap: replace ONE meal in an existing drafted plan,
// honoring an optional free-text hint ("let's go with fish").
export function buildMealSwapPrompt(args: { plan: any; day: string; mealIndex: number; hint?: string }): string {
  const { plan, day, mealIndex, hint } = args;
  const parsed = plan?.parsed ?? {};
  const dayObj = (Array.isArray(parsed.days) ? parsed.days : []).find(
    (d: any) =>
      String(d?.day ?? "")
        .trim()
        .toLowerCase() ===
      String(day ?? "")
        .trim()
        .toLowerCase()
  );
  const meals = Array.isArray(dayObj?.meals) ? dayObj.meals : [];
  const current = meals[mealIndex];
  const profile = repo.getProfile();
  const goal = repo.computeGoalCheck();
  const prefs = (repo.getSettings().meal_prefs || "").trim();
  // The connected brain must reach the swap too — otherwise a flagged marker's
  // nutrition directive (e.g. "tilt toward fish/poultry, lower saturated fat")
  // is silently ignored and the replacement can reintroduce a steered-away food.
  // renderConnectedBrain returns "" when there are no active directives.
  const ctx = repo.getCoachContext();
  // The swap must honor a HARD whole-diet identity too — declared in the profile,
  // in meal prefs, OR in the free-text hint ("I'm vegan now").
  const dietSources = [
    (profile as any)?.dietary_restrictions,
    explicitHardDietMealPrefs(prefs),
    explicitHardDietInstruction(hint),
    storedHardDietDeclarations(parsed),
  ];
  const hardDiet = renderHardDiet(dietSources);
  const plantForward = isPlantForward(dietSources);
  const dayMeals = meals
    .map(
      (m: any, i: number) =>
        `${i === mealIndex ? ">>> SWAP THIS ONE >>> " : ""}[${i}] ${m?.name ?? "?"} — ${m?.items ?? ""} (${m?.kcal ?? "?"} kcal, ${m?.protein_g ?? "?"}g protein, ${m?.carbs_g ?? "?"}g carbs, ${m?.fat_g ?? "?"}g fat, ${m?.fiber_g ?? "?"}g fiber)`
    )
    .join("\n");
  return `${CAIRN_PERSONA}

Right now you're the nutritionist — goal-aware and longevity-focused. The user wants
to SWAP one meal in their drafted meal plan for a different dish. Propose exactly ONE replacement.

THE DAY (${dayObj?.day ?? day}) — its meals, with the one to replace marked:
${dayMeals || "(no meals found)"}

PLAN DAILY TARGET: ${parsed.daily_kcal ?? "?"} kcal / ${parsed.daily_protein_g ?? "?"}g protein per day.

REPLACEMENT RULES:
- Keep the new meal within ±10% of the replaced meal's kcal (${current?.kcal ?? "?"}) and protein
  (${current?.protein_g ?? "?"}g) — UNLESS the user's hint clearly asks otherwise.
- Return a realistic fiber_g estimate and preserve the day's fiber floor; the server re-validates the
  whole week after the swap, so a low-fiber replacement will not be saved.
- It must fit the rest of the day (don't duplicate another meal's main protein/dish).

${longevityGuardrails(plantForward)}
${renderGoalMode(ctx)}${hardDiet}${renderSignalState(ctx)}${renderConnectedBrain(ctx, { domains: ["nutrition"] })}${renderTrajectory(ctx)}${renderFoodMemory((ctx as any)?.memory)}${renderHouseholdDiet(ctx)}
${
  prefs
    ? `
USER SCHEDULE & MEAL PREFERENCES (follow these):
${prefs}
`
    : ""
}${
  hint?.trim()
    ? `
USER'S HINT (honor this): ${hint.trim()}
`
    : ""
}
USER: profile: ${JSON.stringify(profile)}
goal: ${JSON.stringify(goal)}

OUTPUT CONTRACT: respond with ONE bare JSON object only — no prose, no markdown fences:
${SWAP_SCHEMA}`;
}

const RECIPE_SCHEMA = `{ "summary": "<1-2 sentences: how this meal serves the user's goal & longevity>",
  "time_min": <total prep+cook minutes, number>,
  "servings": <number>,
  "ingredients": [{"item": "<ingredient>", "qty": "<amount>"}],
  "steps": ["<ordered, practical step>"],
  "tips": ["<2-4 prep-ahead / swap / seasoning hints>"] }`;

// Agentic recipe for ONE planned meal — the result is cached on the meal
// inside the plan's parsed_json (see repo.setMealRecipe).
export function buildRecipePrompt(args: { plan: any; day: string; mealIndex: number }): string {
  const { plan, day, mealIndex } = args;
  const parsed = plan?.parsed ?? {};
  const dayObj = (Array.isArray(parsed.days) ? parsed.days : []).find(
    (d: any) =>
      String(d?.day ?? "")
        .trim()
        .toLowerCase() ===
      String(day ?? "")
        .trim()
        .toLowerCase()
  );
  const meals = Array.isArray(dayObj?.meals) ? dayObj.meals : [];
  const current = meals[mealIndex];
  const profile = repo.getProfile();
  const goal = repo.computeGoalCheck();
  const prefs = (repo.getSettings().meal_prefs || "").trim();
  const ctx = repo.getCoachContext();
  // The recipe must comply with a HARD whole-diet identity (profile diet or meal prefs).
  const dietSources = [
    (profile as any)?.dietary_restrictions,
    explicitHardDietMealPrefs(prefs),
    storedHardDietDeclarations(parsed),
  ];
  const hardDiet = renderHardDiet(dietSources);
  const plantForward = isPlantForward(dietSources);
  return `${CAIRN_PERSONA}

Right now you're the nutritionist — goal-aware and longevity-focused. Write a practical,
home-cook recipe for ONE meal from the user's drafted meal plan.

THE MEAL (${dayObj?.day ?? day}, meal [${mealIndex}]):
${current ? `${current?.name ?? "?"} — ${current?.items ?? ""} (${current?.kcal ?? "?"} kcal, ${current?.protein_g ?? "?"}g protein, ${current?.carbs_g ?? "?"}g carbs, ${current?.fat_g ?? "?"}g fat)` : "(meal not found)"}

PLAN DAILY TARGET: ${parsed.daily_kcal ?? "?"} kcal / ${parsed.daily_protein_g ?? "?"}g protein per day.

RECIPE RULES:
- Use EXACTLY the meal's listed items as the base of the recipe (plus pantry staples: oil,
  salt, pepper, herbs, spices, vinegar, stock).
- Keep the finished dish consistent with the meal's kcal and macros above.
- Steps must be ordered and practical for a weeknight home cook.

${longevityGuardrails(plantForward)}${hardDiet}
${renderTrajectory(ctx)}${renderFoodMemory((ctx as any)?.memory)}${renderHouseholdDiet(ctx)}${
  prefs
    ? `
USER SCHEDULE & MEAL PREFERENCES (respect these):
${prefs}
`
    : ""
}
USER: profile: ${JSON.stringify(profile)}
goal: ${JSON.stringify(goal)}

OUTPUT CONTRACT: respond with ONE bare JSON object only — no prose, no markdown fences:
${RECIPE_SCHEMA}`;
}
