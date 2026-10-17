import { foodRowsFromWords, mealLabelLead, startsWithFoodQuantity } from "./foodCapture.js";

export const CHAT_ROUTING_POLICY_VERSION = "chat-routing-v1" as const;

export const CHAT_LANES = ["capture", "coach", "deep"] as const;
export type ChatLane = (typeof CHAT_LANES)[number];

export const CHAT_ROUTING_REASON_CODES = [
  "photo_food_default",
  "explicit_food_log",
  "explicit_activity_log",
  "explicit_weight_log",
  "explicit_supplement_log",
  "capture_correction",
  "capture_confirmation",
  "ordinary_chat",
  "routine_coaching",
  "ambiguous_intent",
  "non_food_image",
  "explicit_fast_request",
  "clinical_or_injury",
  "lab_or_imaging",
  "medication_interaction",
  "goal_identity",
  "plan_restructure",
  "current_research",
  "multi_constraint",
  "explicit_deep_request",
  "mixed_risk",
] as const;
export type ChatRoutingReasonCode = (typeof CHAT_ROUTING_REASON_CODES)[number];

export interface ChatRoutingDecision {
  policy_version: typeof CHAT_ROUTING_POLICY_VERSION;
  lane: ChatLane;
  reason_codes: ChatRoutingReasonCode[];
}

export interface ChatRoutingInput {
  message?: unknown;
  has_image?: boolean;
  capture_confirmation?: boolean;
  /** A food note was captured recently, so a bare "add/also X" is likely a meal amendment. */
  recent_food_capture?: boolean;
}

// Mirrors ReasoningLevel in agents.ts (kept a standalone literal so this policy
// module stays free of the CLI-adapter layer). A provider that tops out lower
// degrades in resolveAgentProfileForClass.
//
// "max" is verified against both pinned CLIs, but the two reject it differently.
// Claude's --effort validates at spawn. Codex's model_reasoning_effort does NOT:
// the config enum is broader than any single model accepts, an unsupported value
// parses fine, and the rejection ("Reasoning effort `X` is not supported for model
// `Y`") arrives at REQUEST time — which runAgentWithFallback reads as a dead agent
// rather than a bad flag. So on codex "max" is gated by whichever model that CLI
// resolves, not by this list. See the codex model_note in agents.json.
export const CHAT_REASONING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ChatReasoningLevel = (typeof CHAT_REASONING_LEVELS)[number];

export interface ChatProfileBinding {
  model?: string;
  reasoning?: ChatReasoningLevel;
}

export type ProviderProfileBindings<K extends string> = Partial<Record<K, ChatProfileBinding>>;
export type ProfileBindings<K extends string> = Record<string, ProviderProfileBindings<K>>;
export type ChatProviderProfileBindings = ProviderProfileBindings<ChatLane>;
export type ChatProfileBindings = ProfileBindings<ChatLane>;

export interface ResolvedChatProfile {
  model?: string;
  // Absent only on the legacy single-profile path when the person bound a model class
  // but no lane exists to pick an effort from: the CLI keeps its own effort.
  reasoning?: ChatReasoningLevel;
}

// Which provider-neutral model class each chat lane belongs to, so the person's ONE
// Settings -> Agents choice (settings.model_class_bindings: Everyday = fast, Deep work =
// deep) governs chat as well as the ops. Kept a string literal (mirrors ModelClass in
// agents.ts) so this policy module stays free of the CLI-adapter layer. The legacy
// single-profile path has no lane and reads the everyday class.
export type ChatModelClass = "fast" | "deep";
export const CHAT_LANE_MODEL_CLASS: Record<ChatLane, ChatModelClass> = {
  capture: "fast",
  coach: "fast",
  deep: "deep",
};
// The coach lane's MODEL may have its own binding (`model_class_bindings[provider].coach`,
// "Opus for coaching, Sonnet for capture"); unbound it reads `fast`, exactly as before. The
// lane's AGENT ORDER and everything else still follow CHAT_LANE_MODEL_CLASS (coach = fast).
export type ChatBindingClass = ChatModelClass | "coach";
export type ChatClassModelBindings = Record<string, Partial<Record<ChatBindingClass, string>>>;

/** The binding key a lane's model is read from: the coach lane its own `coach` key, every other lane its class. */
export function chatLaneBindingClass(lane: ChatLane): ChatBindingClass {
  return lane === "coach" ? "coach" : CHAT_LANE_MODEL_CLASS[lane];
}

/** The model the person bound to `modelClass` for `provider`, or undefined (CLI default). An unbound `coach` reads `fast`. */
export function classBoundChatModel(
  provider: string | null | undefined,
  modelClass: ChatBindingClass,
  classBindings: ChatClassModelBindings | null | undefined
): string | undefined {
  const name = String(provider ?? "").trim();
  const read = (cls: ChatBindingClass): string | undefined => {
    const value = name ? classBindings?.[name]?.[cls] : undefined;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return read(modelClass) ?? (modelClass === "coach" ? read("fast") : undefined);
}

const LANE_RANK: Record<ChatLane, number> = { capture: 0, coach: 1, deep: 2 };
const LANE_SET = new Set<string>(CHAT_LANES);
const REASON_SET = new Set<string>(CHAT_ROUTING_REASON_CODES);
const REASONING_SET = new Set<string>(CHAT_REASONING_LEVELS);
// Effort follows what a wrong answer costs, not what is cheapest. Capture is a receipt
// and stays low. A coach turn reads the athlete's numbers (intake, pace, load) and
// answers in words about them, and on 2026-10-16 the same low lane mis-added the day's
// calories twice and treated a social run's pace as lost fitness; so coach is medium
// unless the athlete asked for quick (`explicit_fast_request`). The deep lane keeps high.
const DEFAULT_REASONING: Record<ChatLane, ChatReasoningLevel> = {
  capture: "low",
  coach: "medium",
  deep: "high",
};

// The deep lane exists for risk AND for structure. High effort is for the first kind only:
// a clinical, injury, lab or medication turn is where a plausible-but-wrong answer costs
// most. A plan restructure, a goal change, a research or multi-constraint ask is a harder
// question, not a riskier one, and medium holds it (measured 2026-10-16: no op that passed
// at medium needed high). With no reasons given, the lane keeps its high default.
const HIGH_EFFORT_DEEP_REASONS: readonly string[] = ["clinical_or_injury", "lab_or_imaging", "medication_interaction"];

function laneReasoning(lane: ChatLane, reasonCodes?: readonly string[]): ChatReasoningLevel {
  if (lane === "coach" && reasonCodes?.includes("explicit_fast_request")) return "low";
  if (lane === "deep" && reasonCodes?.length && !reasonCodes.some((r) => HIGH_EFFORT_DEEP_REASONS.includes(r))) return "medium";
  return DEFAULT_REASONING[lane];
}

const CLINICAL_OR_INJURY =
  /\b(?:clinical|clinician|doctor|physician|diagnos(?:e|is|ed)|symptom|injur(?:y|ed)|pain|rehab|surgery|infection|disease|condition|sore|swollen|swelling|chest pain|severe (?:abdominal )?pain|(?:can(?:not|'t)|unable to) bear weight|(?:can(?:not|'t)|unable to) walk|popped|pop(?:ped)?|stress fracture|unsafe|as fast as possible)\b/i;
const LAB_OR_IMAGING =
  /\b(?:bloodwork|blood work|lab(?:s|work| result)?|biomarker|mri|ct scan|x-?ray|ultrasound|imaging|scan result|dexa|\b(?:ldl|hdl|a1c|hba1c|triglycerides?|ferritin|apob)\s*(?:is|was|of|:|=)?\s*\d+(?:\.\d+)?)\b/i;
const MEDICATION =
  /\b(?:medication|medicine|prescription|dosage|dose|drug|side effect|interaction|insulin|warfarin|antibiotics?|metformin|statin|ssri|blood pressure medicine)\b/i;
const GOAL_IDENTITY =
  /\b(?:(?:change|switch|replace|rethink|set|reset|choose)\s+(?:a |my )?(?:new\s+)?goal|goal\s+(?:is|should be|mode)|(?:lose|gain)\s+(?:weight|fat|muscle)|bulk(?:ing)?|(?<!steel[- ])cut(?:ting)?(?![- ]?out\s+(?:blocks?|squares?|pieces?|strips?|bites?)\b)|maintenance\s+goal|new goal)\b/i;
const PLAN_RESTRUCTURE =
  /\b(?:restructure|overhaul|redesign|rebuild|rewrite|replace)\s+(?:my\s+)?(?:whole\s+)?(?:training\s+)?(?:plan|program|split|week|meals?)|\b(?:change|switch)\s+(?:my\s+)?(?:training\s+)?(?:split|plan|program)\b|\bswitch me from\b|\bmove\s+(?:all|my)\s+.*\bday(?:s)?\b/i;
const CURRENT_RESEARCH =
  /\b(?:research|look up|browse|current (?:evidence|nutrition|race weather|weather|guidance|guidelines|menu)|latest (?:evidence|research|guidance|guidelines|studies)|systematic review|meta-analysis|find\s+(?:the\s+)?current|nearby (?:cafe|restaurant)|(?:restaurant|airport)\s+(?:menu|tonight)|menu at|where\s+(?:should|can)\s+(?:we|i)\s+(?:go|eat)\b|find\s+(?:a\s+)?(?:good\s+)?restaurant\s+(?:near|nearby)|where\s+(?:should|can)\s+i\s+eat\s+nearby)\b/i;
const EXPLICIT_DEEP =
  /\b(?:think deeply|deep dive|go deep|use (?:the )?deep(?: mode)?|deep (?:analysis|review|mode)|analy[sz]e (?:this )?(?:thoroughly|deeply)|comprehensive analysis|reason (?:this )?through)\b/i;
const AMBIGUOUS =
  /\b(?:not sure|unsure|unclear|maybe|might be|could be|I don't know|can(?:not|'t) tell|either .+ or)\b/i;
const EXPLICIT_FAST = /\b(?:quick(?:ly)?|fast(?: mode| answer)?|brief answer|keep it short|no deep dive|don't overthink)\b/i;
const ROUTINE_COACHING =
  /\b(?:workout|training|session|exercise|run|ride|recovery|sleep|meal|food|nutrition|protein|calorie|weight|progress|today|this week|legs|calves|fiber|snack|dinner)\b/i;
const COACHING_REQUEST =
  /\b(?:suggest|recommend|explain|review|analy[sz]e|plan|evaluate|compare|tell|help|what\s+should)\b/i;

const FOOD_NOUN =
  /\b(?:food|meal|breakfast|lunch|dinner|snack|drink|coffee|shake|smoothie|calorie(?:s)?|kcal|macro(?:s)?|protein|carb(?:s)?|fat|serving|plate|appetizer|starter|entr[eé]e|dessert|side\s+(?:dish|of))\b/i;
const ACTIVITY_NOUN =
  /\b(?:activity|workout|training|session|exercise|run|ride|walk|hike|swim|row|cycle|cycling|bike|lifting|cardio|yoga|sport)\b/i;
const WEIGHT_NOUN = /\b(?:weight|weigh-?in|bodyweight|body weight|lb|lbs|pounds?|kg|kilograms?)\b/i;
const SUPPLEMENT_NOUN =
  /\b(?:supplement|vitamin|creatine|protein powder|electrolyte|magnesium|omega-?3|fish oil|collagen|melatonin|probiotic)\b/i;
const FOOD_ITEM =
  /\b(?:pizza|slice(?:s)?|sandwich|tacos?|banana|oatmeal|yogurt|berries|chicken|rice|broccoli|salmon|potatoes|asparagus|latte|cookie|eggs?|pasta|smoothie)\b/i;
const CAPTURE_VERB = /\b(?:log|track|record|add|save|enter)\b/i;
const AMENDMENT_VERB = /\b(?:add(?:ed|ing)?|include[ds]?|also|plus)\b|\b\d+(?:[.,]\d+)?\s*(?:g|gr|grams?|ml|oz|slices?|pieces?)?\s+more\b/i;
// The other way people add to the meal they just logged: no verb at all, just "oh
// and …", "… on the plate", "… with it", "… too". Only read as an amendment right
// after a food capture (the branch below), never on its own.
const ADDITION_PHRASE =
  /^\s*(?:(?:oh|oops|ah|wait)[\s,!.]+)?and\b|\b(?:on|in|with)\s+(?:the|my|that|this|it)\s+(?:plate|bowl|side|top)\b|\bon top\b|\bwith it\b|\bas well\b|\btoo\s*[.!]*\s*$/i;
const NEW_LOG_VERB = /\b(?:log|track|record|save|enter)\b/i;
const CORRECTION_VERB = /\b(?:correct(?:ion)?|fix|edit|update|change|actually|remove|forgot|don'?t log)\b/i;

// A message that REPORTS or ASKS rather than logs. "just did it 2 hours after the big
// steak that I had and I felt it" carries a food word and an activity verb, so the
// capture regexes fire on it, but nothing in it is a request to write a row: it is a
// training narrative, and answering it with "Logged your snack" is the one reply that
// is wrong. A narrative keeps its capture reasons (the coach lane can still log a
// meal it names) but never takes the receipt-only lane, which has no agent to read it.
const NARRATIVE_QUESTION_LEAD = /^(?:what|why|how|when|where|who|which|should|could|would|can|is|are|was|were|does)\b/i;
const NARRATIVE_CUES =
  /\b(?:felt|feel(?!-)|feels|feeling|energy(?!\s+(?:gel|drink|bar|chews?|shot))|tired|sluggish|drained|bonk(?:ed)?|heavy legs?|dizzy|conversational|compared?|versus|explain|evaluate|but overall)\b/i;
const NARRATIVE_MAX_WORDS = 40;

export function chatMessageIsNarrative(message: unknown): boolean {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (text.includes("?") || NARRATIVE_QUESTION_LEAD.test(text)) return true;
  // An explicit "Log food: …" paste (the Fuel composer's frame) is long because the meal is.
  // So is a meal written as a list (readsAsMealList): a ten-item breakfast is not a story.
  if (!/^log\b/i.test(text) && text.split(/\s+/).length > NARRATIVE_MAX_WORDS && !readsAsMealList(text)) return true;
  return NARRATIVE_CUES.test(text);
}

// ---- What a "had/ate" sentence is actually about -------------------------------------
// A bare "had"/"ate" is not a food log: "I had a great run", "had a rough night, only
// slept 5 hours" and "I had no lunch, was in meetings" all carry the verb. The natural-
// language capture and the receipt-only lane (no agent reads the sentence) both want a
// food-shaped OBJECT, and a sentence that needs the previous turn to be understood ("I had
// 75g of it", "no, not the snack, this is lunch") belongs to the agent, which can see it.
const MEAL_LABEL = /\b(?:breakfast|brunch|lunch|dinner|supper|snack|meal)\b/i;
const CONCRETE_FOOD =
  /\b(?:eggs?|toast|bread|bagels?|oats?|oatmeal|porridge|cereal|granola|milk|cheese|butter|avocado|apples?|pears?|peach(?:es)?|oranges?|grapes?|strawberr(?:y|ies)|blueberr(?:y|ies)|raspberr(?:y|ies)|fruits?|watermelon|melon|mango|pineapple|kiwi|salad|soup|steaks?|beef|pork|bacon|sausages?|ham|turkey|tuna|shrimp|prawns?|fish|wings?|burgers?|fries|chips|noodles?|quinoa|beans?|lentils?|tofu|hummus|nuts?|almonds?|peanuts?|jam|honey|sugar|chocolate|lindt|candy|ice\s*cream|cake|bars?|gel|whey|juice|tea|water|beer|wine|soda|cola|kefir|skyr|cottage|wraps?|burritos?|sushi|curry|stew|sauce|dressing|pancakes?|waffles?|muffins?|croissants?|donuts?|doughnuts?|pie|ribs|lamb|sprouts|spinach|carrots?|tomato(?:es)?|cucumbers?|peppers?|onions?|mushrooms?|corn|vegetables?|veggies|treat|sweets?|crackers?|popcorn|pretzels?|cookies?|brownies?|espresso|latte|cappuccino|flat\s+white|americano|matcha|creatine|whey)\b/i;
// Food-sized units only: kg/lb/l read as body weight or distance, never as a meal.
const QUANTITY_UNIT =
  /\b\d+(?:[.,/]\d+)?\s*(?:g|gr|grams?|ml|oz|kcal|cals?|calories|tbsp|tsp|cups?|slices?|pieces?|scoops?|servings?|bowls?)\b/i;
// "I had a great run", "had a rough night", "had a call": the object is not food.
const NON_FOOD_OBJECT =
  /\b(?:had|have)\s+(?:(?:a|an|the|my|some|one|two|three|four|five|six|several|a\s+few|a\s+couple\s+of|\d+)\s+)?(?:(?:great|good|bad|rough|long|hard|tough|nice|fun|easy|terrible|awful|short|busy|solid|decent|weird|quick|slow|back[- ]to[- ]back)\s+)*(?:run|ride|walk|hike|swim|workout|session|night|day|week|weekend|time|sleep|nap|meeting|call|chat|talk|class|review|interview|appointment|headache|cold|fever|cramp|pain|idea|question|problem|feeling|thought|look|go|trouble|stomach|issue|injury|surgery|massage|shower|bath|physio|lift|race|game|match|moment|chance|laugh)(?:s|es)?\b|\bhad\s+a\s+bit\s+of\s+a\b|\bonly\s+slept\b|\bslept\b/i;
// Eating NOTHING is not eating: "had no lunch", "had nothing for breakfast", "didn't eat",
// "skipped lunch", "no breakfast". The negation is read before anything else.
const INTAKE_NEGATED =
  /\b(?:had|ate|eaten|have|eat|eating|having)\s+(?:absolutely\s+|really\s+)?(?:no|nothing|none|zero)\b|\b(?:didn'?t|did\s+not|haven'?t|have\s+not|hasn'?t|never|won'?t|not)\s+(?:yet\s+)?(?:have|had|eat|ate|eaten)\b|\bskipp?(?:ed|ing)\b|\bfasted\b|\bno\s+(?:breakfast|brunch|lunch|dinner|supper|snack|food|meal)\b|\bwithout\s+(?:breakfast|lunch|dinner|eating)\b/i;
// Words that point at something said before ("it", "that", "the snack", "my usual").
const PRIOR_REFERENT =
  /\b(?:it|that|this|these|those|them|same\s+as|(?:my|the)\s+usual|usual|the\s+(?:snack|meal|breakfast|lunch|dinner|rest|other|first|last|previous))\b/i;
const PRIOR_LEAD =
  /^\s*(?:(?:oh|ok|okay|no|nope|wait|actually)[\s,.!]+)*(?:not\s+the\b|this\s+(?:is|was)\b|that\s+(?:is|was)\b|that'?s\b|it\s+(?:is|was)\b|it'?s\b|the\s+(?:snack|meal|breakfast|lunch|dinner)\s+(?:is|was)\b)/i;
const MEAL_HEADING = /\b(breakfast|brunch|lunch|dinner|supper|snack)\s*[:\-–—]/gi;

// Negation belongs to its CLAUSE: "skipped breakfast but had eggs and toast" skipped one
// meal and ate another. Clauses split on but/and/then/so, commas, semicolons, full stops
// and dashes.
const CLAUSE_SPLIT = /\b(?:but|and|then|so|though|however)\b|[,;.!—–]|\s-\s/i;
function clauses(message: string): string[] {
  return message.split(CLAUSE_SPLIT).map((c) => c.trim()).filter(Boolean);
}

/** Some clause says it did NOT eat ("had no lunch", "skipped breakfast", "didn't eat"). */
export function foodIntakeNegated(message: unknown): boolean {
  return INTAKE_NEGATED.test(String(message ?? ""));
}

/** A food noun, a quantity with a unit, or a meal label: something food-shaped to log. */
export function hasFoodEvidence(message: unknown): boolean {
  const text = String(message ?? "");
  return CONCRETE_FOOD.test(text) || FOOD_ITEM.test(text) || FOOD_NOUN.test(text) || QUANTITY_UNIT.test(text) || MEAL_LABEL.test(text);
}

/** The message names a food of its own (not just a meal label, a quantity or a pronoun). */
function namesConcreteFood(text: string): boolean {
  return CONCRETE_FOOD.test(text) || FOOD_ITEM.test(text);
}

/**
 * The sentence cannot be understood without the turn before it: it opens on a referent
 * ("This is lunch", "No, not the snack"), or it points at something ("75g of it", "my
 * usual", "same as yesterday") while naming no food of its own.
 */
export function messageNeedsPriorTurn(message: unknown): boolean {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (PRIOR_LEAD.test(text)) return true;
  return PRIOR_REFERENT.test(text) && !namesConcreteFood(text);
}

// ---- Doubt about a food log ----------------------------------------------------------
// The receipt lane writes a row that NO agent reads, and that row feeds intake, TDEE and
// the adaptive targets. So a food message carrying any sign that it is not simply "this
// is what I ate" goes to the agent, which can read it: a correction ("not 200g", "make it
// 200g", "sorry, I meant…"), a question or a comparison without its "?" ("is that enough
// protein", "200g rice or 300g potatoes", "if I eat…"), a nutrition lookup ("calories in
// 200g rice"), or food that was someone else's or shared ("for my wife", "I had about a
// third"). A wrong negative costs one agent turn; a wrong positive corrupts the log.
const FOOD_LOG_DOUBT_CUES = [
  // a correction or an amendment of an earlier entry
  String.raw`\b(?:not|no|nope|make\s+it|sorry|instead|rather|chang(?:e|ed|ing)|swap\w*|replac\w*|oops|wrong|meant|mistake|actually|only)\b`,
  // a question, a comparison or a hypothetical, with or without its "?"
  String.raw`\b(?:or|vs\.?|versus|if|enough|too\s+(?:much|many)|am\s+i|should\s+i|can\s+i|could\s+i|is\s+(?:that|it|this)|compar\w*|better|worse)\b`,
  // a nutrition lookup rather than a meal
  String.raw`\b(?:calories|cals?|kcal|macros?|protein|carbs?|fats?|fib(?:er|re)|sugars?)\s+(?:in|for|of)\b`,
  // someone else's food, or a shared dish
  String.raw`\b(?:wife|husband|partner|girlfriend|boyfriend|kids?|children|son|daughter|family|friends?|guests?|team|mom|mum|dad|parents?|baby|everyone|we|they|us)\b`,
  String.raw`\b(?:a\s+third|a\s+quarter|half\s+of|some\s+of|shared?|split\s+(?:it|with|between))\b`,
];
const FOOD_LOG_DOUBT_RE = new RegExp(FOOD_LOG_DOUBT_CUES.join("|"), "i");

/** The message carries a correction, a question, a lookup or someone else's food: never a receipt-only log. */
export function foodLogDoubtCue(message: unknown): boolean {
  return FOOD_LOG_DOUBT_RE.test(String(message ?? "").replace(/[‘’]/g, "'"));
}

// ---- A meal written as a list ---------------------------------------------------------
// The commonest food message carries no verb at all: "breakfast 30g rolled oats 15g chia
// 3g psyllium 180g non fat skyr 20 grapes", "Snack: 20g almonds", "2 eggs, 2 slices toast".
// It is a meal label leading food words, words that open on a written quantity, or a
// comma/line list ("oats 60g, milk 250ml, banana") — and nothing else: no doubt cue above,
// no request, plan or future word, nothing that amends an earlier entry, no other logging
// domain, one meal. The router does not guess the rows: it runs foodCapture.ts's own
// splitter and takes the meal only when EVERY row it yields is food-shaped (two or more,
// or one under a meal label), so what the router accepts is exactly what gets stored.
// Short of all of that, the message keeps the routing it had before (an agent reads it).
const MEAL_LIST_NOT_A_LOG =
  /\b(?:ideas?|options?|suggest\w*|recommend\w*|recipes?|alternatives?|substitut\w*|instead|plan(?:s|ned|ning)?|prep(?:ping)?|tomorrow|next|should|could|would|want(?:ed)?|wanna|going\s+to|gonna|i'?ll|will|crav\w*|think(?:ing)?|target|goal|budget|left|remaining|burn(?:ed|t)?|every|daily|usually|always|often|how|what|why|just|made|i)\b/i;
const MEAL_LIST_ACTIVITY_VERB = /\b(?:ran|walked|hiked|swam|rowed|cycled|biked|rode|lifted|worked\s+out|trained)\b/i;
const MEAL_LIST_AMENDS = /\b(?:add(?:ed|ing)?|also|more|same|usual|again|rest\s+of|other\s+half)\b/i;
const MEAL_LABEL_WORD = /\b(breakfast|brunch|lunch|dinner|supper|snack)s?\b/gi;
// Words that make a row a sentence rather than a food: "rice is that", "chicken for".
const ROW_FUNCTION_WORD =
  /\b(?:is|are|was|were|be|been|that|this|it|or|vs|versus|for|am|i|if|enough|we|they|he|she|you|my|her|his|their|our|not|no|should|could|would|can|will|did|do|does|had|have|has|ate|eat|eaten|than|then|but|so|because|what|how|why|when|think|maybe)\b/i;
const ROW_MAX_WORDS = 8;

function foodShapedRow(row: { item?: unknown; amount?: unknown }): boolean {
  const item = String(row?.item ?? "").trim();
  if (!/[a-z]{2,}/i.test(item) || ROW_FUNCTION_WORD.test(item)) return false;
  if (item.split(/\s+/).length > ROW_MAX_WORDS) return false;
  // A row with no written amount must at least name a food.
  return Boolean(String(row?.amount ?? "").trim()) || namesConcreteFood(item);
}

/** A single meal written as a list of foods, whose every split row is food-shaped. */
export function readsAsMealList(message: unknown): boolean {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (foodLogDoubtCue(text)) return false;
  if (MEAL_LIST_NOT_A_LOG.test(text) || MEAL_LIST_AMENDS.test(text) || CORRECTION_VERB.test(text)) return false;
  if (ACTIVITY_NOUN.test(text) || MEAL_LIST_ACTIVITY_VERB.test(text)) return false;
  if (WEIGHT_NOUN.test(text) || SUPPLEMENT_NOUN.test(text)) return false;
  if (foodIntakeNegated(text) || messageNeedsPriorTurn(text)) return false;
  const labels = new Set([...text.matchAll(MEAL_LABEL_WORD)].map((m) => m[1].toLowerCase()));
  if (labels.size > 1) return false;
  const lead = mealLabelLead(text);
  if (!lead && !startsWithFoodQuantity(text) && !/[,;\n]/.test(text)) return false;
  const rows = foodRowsFromWords(text);
  if (!rows.length || !rows.every(foodShapedRow)) return false;
  // An amount still glued inside a food's name ("rice 150g chicken", "7 grain toast") is a
  // row the receipt would show wrong: the agent reads it instead.
  if (rows.some((row) => /\d/.test(String(row.item)))) return false;
  // Two or more rows, or a single food under its meal label ("lunch 150g rice"). A bare
  // amount ("150g", "150g rice") alone is more often an answer than a meal.
  if (rows.length < 2 && !lead) return false;
  // Something in it is food by name, or every row carries the athlete's own amount.
  return rows.some((row) => namesConcreteFood(String(row.item))) || rows.every((row) => !!row.amount);
}

/** How many DIFFERENT meals are headed in one message ("morning snack: … breakfast: …"). */
export function mealHeadingCount(message: unknown): number {
  const labels = new Set<string>();
  for (const m of String(message ?? "").matchAll(MEAL_HEADING)) labels.add(m[1].toLowerCase());
  return labels.size;
}

// A "had/ate" sentence that reads as eating: some NON-negated clause has the verb and is
// either food-shaped or a short "had a/the/my <something>" whose object is not obviously a
// run, a night or a call. A bare number ("had two") is never enough without a food noun or a
// food-sized quantity, so "I had two meetings" is not a meal.
function readsAsIntake(message: string): boolean {
  return clauses(message).some((clause) => {
    if (!/\b(?:ate|drank|had)\b/i.test(clause) || INTAKE_NEGATED.test(clause)) return false;
    if (hasFoodEvidence(clause)) return true;
    if (NON_FOOD_OBJECT.test(clause)) return false;
    return /\b(?:ate|drank|had)\s+(?:a|an|some|the|my|one)\b/i.test(clause);
  });
}

function addReason(reasons: Set<ChatRoutingReasonCode>, reason: ChatRoutingReasonCode): void {
  reasons.add(reason);
}

function constrainedInMultipleWays(message: string): boolean {
  const signals = [
    /\b(?:only|exactly|at most|no more than|under)\s+\d+/i,
    /\b(?:without|avoid|exclude|no)\s+[a-z]/i,
    /\b(?:must|need to|has to|can't|cannot)\b/i,
    /\b(?:while|but also|as well as|and also)\b/i,
    /\b(?:available equipment|equipment I have|at home|at a hotel|travel(?:ing)?)\b/i,
    /\b(?:vegetarian|vegan|nut-?free|high[- ]protein|fasting|shift work|taper)\b/i,
    /\b(?:\d+\s*(?:minutes?|days?|dinners?|runs?))\b/i,
    /\bshift work\b/i,
    /\bfasting\b/i,
    /\b(?:\d+|one|two|three|four)\s+(?:long\s+)?runs?\b/i,
  ];
  return signals.reduce((count, pattern) => count + (pattern.test(message) ? 1 : 0), 0) >= 2;
}

function captureReasons(
  message: string,
  hasImage: boolean,
  confirmation: boolean,
  recentFoodCapture: boolean
): ChatRoutingReasonCode[] {
  const reasons = new Set<ChatRoutingReasonCode>();
  const hasCaptureVerb =
    CAPTURE_VERB.test(message) &&
    !/\b(?:do\s+not|don'?t|did\s+not|didn'?t|never)\s+(?:log|track|record|add|save|enter)\b/i.test(message);
  const hasCorrectionVerb = CORRECTION_VERB.test(message);

  if ((hasCaptureVerb || hasCorrectionVerb) && (FOOD_NOUN.test(message) || FOOD_ITEM.test(message))) addReason(reasons, "explicit_food_log");
  // "Log 100g watermelon": an explicit log verb with a food-sized quantity or a food noun
  // outside the short lists above is still a food log (never when another domain owns the verb).
  if (
    hasCaptureVerb &&
    (CONCRETE_FOOD.test(message) || QUANTITY_UNIT.test(message)) &&
    !ACTIVITY_NOUN.test(message) &&
    !WEIGHT_NOUN.test(message) &&
    !SUPPLEMENT_NOUN.test(message)
  ) {
    addReason(reasons, "explicit_food_log");
  }
  // Two headed meals in one message ("Breakfast - …  Snack - …") are a food log the agent
  // can split into two entries.
  if (mealHeadingCount(message) > 1 && hasFoodEvidence(message)) addReason(reasons, "explicit_food_log");
  if (hasCaptureVerb && ACTIVITY_NOUN.test(message)) addReason(reasons, "explicit_activity_log");
  if (hasCaptureVerb && WEIGHT_NOUN.test(message)) addReason(reasons, "explicit_weight_log");
  if (hasCaptureVerb && SUPPLEMENT_NOUN.test(message)) addReason(reasons, "explicit_supplement_log");

  // Natural-language capture stays intentionally narrow: a concrete completed
  // event is eligible, while a general question about food/training is not.
  if (readsAsIntake(message) || /\b(?:breakfast|lunch|dinner)\s*(?:was|:)/i.test(message)) addReason(reasons, "explicit_food_log");
  // A meal written as a list with no verb ("breakfast 30g oats 15g chia 180g skyr") is a log.
  if (readsAsMealList(message)) addReason(reasons, "explicit_food_log");
  if (/\b(?:i\s+)?(?:ran|walked|hiked|swam|rowed|cycled|biked|rode|lifted|worked out|did|finished)\b(?:\s+(?:my\s+)?(?:strength\s+)?(?:workout|training|session))?(?:\s+(?:for\s+)?\d)?/i.test(message) && (ACTIVITY_NOUN.test(message) || /\b(?:swam|ran|walked|hiked|rowed|cycled|biked|rode)\b/i.test(message))) {
    addReason(reasons, "explicit_activity_log");
  }
  if (/\b(?:(?:i\s+)?weigh(?:ed)?\s+(?:in\s+at\s+)?\d+(?:\.\d+)?|weight(?:\s+this morning)?\s*:\s*\d+(?:\.\d+)?|scale says\s+\d+(?:\.\d+)?)\b/i.test(message)) addReason(reasons, "explicit_weight_log");
  if (
    /\b(?:i\s+)?took\s+(?:\d+(?:\.\d+)?\s*(?:mg|g|mcg|iu|capsules?|tablets?)\s+)?(?:creatine|magnesium|vitamin|omega-?3|fish oil|collagen|melatonin|probiotic|electrolytes?)\b/i.test(
      message
    )
  ) {
    addReason(reasons, "explicit_supplement_log");
  }

  // An amendment-verbed (or amendment-phrased: "oh and I had 40 g of avocado on
  // the plate") follow-up shortly after a food capture is a correction to that
  // meal even when the item is in no noun list ("Add half of Brussel sprouts from
  // their appetizer list"). It must carry capture_correction: that
  // is what keeps it OFF the no-agent instant path (which can only create a NEW
  // note — a duplicate meal here) and on the agent path where update_food_note
  // can reach the existing row. Plain log verbs ("log/track/record…") are
  // excluded so a genuinely new entry keeps its instant receipt, and the other
  // logging domains keep priority: an activity/weight/supplement-shaped message
  // never rides this branch. A bare list with no meal label of its own ("150g rice")
  // is the same question: right after a capture it may be more of that meal, so the
  // agent reads it; "lunch 150g rice" names its meal and stays a new entry.
  if (
    recentFoodCapture &&
    (AMENDMENT_VERB.test(message) ||
      ADDITION_PHRASE.test(message) ||
      hasCorrectionVerb ||
      messageNeedsPriorTurn(message) ||
      (readsAsMealList(message) && !mealLabelLead(message))) &&
    !NEW_LOG_VERB.test(message) &&
    !ACTIVITY_NOUN.test(message) &&
    !WEIGHT_NOUN.test(message) &&
    !SUPPLEMENT_NOUN.test(message)
  ) {
    addReason(reasons, "explicit_food_log");
    addReason(reasons, "capture_correction");
  }

  // Only food has a first-class correction target (`update_food_note` with an
  // existing id). Historical activity, weight, and supplement corrections do not
  // yet have bounded update actions, so they must stay conversational rather than
  // being misrouted as a capture the server cannot faithfully apply.
  if (hasCorrectionVerb && reasons.has("explicit_food_log")) addReason(reasons, "capture_correction");
  if (confirmation) addReason(reasons, "capture_confirmation");
  if (
    hasImage &&
    (message === "" ||
      (FOOD_NOUN.test(message) &&
        (hasCaptureVerb || /\b(?:this|my)\s+(?:food|meal|plate|breakfast|lunch|dinner|snack)\b/i.test(message))))
  ) {
    addReason(reasons, "photo_food_default");
  }
  return CHAT_ROUTING_REASON_CODES.filter((reason) => reasons.has(reason));
}

/**
 * Deterministic, privacy-safe lane selection. The returned object contains only
 * enums from the versioned taxonomy: never the source message or an image path.
 */
export function decideChatRouting(input: ChatRoutingInput): ChatRoutingDecision {
  const message = String(input?.message ?? "").trim();
  const hasImage = input?.has_image === true;
  const captures = captureReasons(message, hasImage, input?.capture_confirmation === true, input?.recent_food_capture === true);
  const reasons = new Set<ChatRoutingReasonCode>(captures);
  let lane: ChatLane = captures.length > 0 ? "capture" : "coach";
  const ambiguous = AMBIGUOUS.test(message);
  const explicitFast = EXPLICIT_FAST.test(message);
  if (ambiguous) addReason(reasons, "ambiguous_intent");
  if (explicitFast) addReason(reasons, "explicit_fast_request");

  // A single message may both capture a fact and ask for useful coaching. Keep
  // the capture reason (so the normal action path can log it), but do not take
  // the receipt-only instant lane and discard the requested answer.
  if (captures.length > 0 && (chatMessageRequestsCoaching(message) || chatMessageIsNarrative(message))) {
    lane = "coach";
    addReason(reasons, "routine_coaching");
  }

  const raiseDeep = (reason: ChatRoutingReasonCode) => {
    lane = "deep";
    addReason(reasons, reason);
  };
  const deepReasons: ChatRoutingReasonCode[] = [];
  const deep = (reason: ChatRoutingReasonCode) => {
    deepReasons.push(reason);
    raiseDeep(reason);
  };
  if (CLINICAL_OR_INJURY.test(message)) deep("clinical_or_injury");
  if (LAB_OR_IMAGING.test(message)) {
    deep("lab_or_imaging");
    // A lab or imaging interpretation is clinical health context even when the
    // user does not name a symptom; retain both explanations for safe escalation.
    deep("clinical_or_injury");
  }
  if (MEDICATION.test(message)) deep("medication_interaction");
  if (GOAL_IDENTITY.test(message)) deep("goal_identity");
  if (PLAN_RESTRUCTURE.test(message)) deep("plan_restructure");
  // A pasted http(s) URL on a coaching turn is a request to look at that page.
  // Capture-only logs stay capture even if a menu URL rode along.
  if (CURRENT_RESEARCH.test(message) || (captures.length === 0 && /https?:\/\/[^\s]+/i.test(message))) {
    deep("current_research");
  }
  if (constrainedInMultipleWays(message)) deep("multi_constraint");
  if (EXPLICIT_DEEP.test(message)) deep("explicit_deep_request");

  if (ambiguous && captures.length > 0) deep("mixed_risk");
  if (
    deepReasons.filter((reason) => reason !== "mixed_risk").length > 1 ||
    (deepReasons.some((reason) => reason !== "mixed_risk") && (captures.length > 0 || explicitFast))
  ) {
    addReason(reasons, "mixed_risk");
  }
  if ((lane as ChatLane) === "coach") {
    if (hasImage && captures.length === 0) addReason(reasons, "non_food_image");
    if (ROUTINE_COACHING.test(message)) addReason(reasons, "routine_coaching");
    else if (!reasons.has("ambiguous_intent") && !reasons.has("non_food_image")) addReason(reasons, "ordinary_chat");
  }

  return {
    policy_version: CHAT_ROUTING_POLICY_VERSION,
    lane,
    reason_codes: CHAT_ROUTING_REASON_CODES.filter((reason) => reasons.has(reason)),
  };
}

/** Independent guard shared by classification and the receipt-only bypass. */
export function chatMessageRequestsCoaching(message: unknown): boolean {
  return COACHING_REQUEST.test(String(message ?? ""));
}

// Settled public entrypoint used by the runtime and policy benchmark. Keep the
// narrower input contract stable even if internal classifiers gain context.
export function classifyChatRoute(input: {
  message?: string | null;
  has_image?: boolean;
  recent_food_capture?: boolean;
}): ChatRoutingDecision {
  return decideChatRouting(input);
}

/** Raise a prior decision to a higher lane without ever permitting a downgrade. */
export function escalateChatRouting(
  decision: ChatRoutingDecision,
  lane: ChatLane,
  reasonCodes: ChatRoutingReasonCode[] = []
): ChatRoutingDecision {
  const valid = normalizeChatRoutingDecision(decision);
  if (!valid) throw new Error("invalid chat routing decision");
  const nextLane = LANE_RANK[lane] > LANE_RANK[valid.lane] ? lane : valid.lane;
  const reasons = new Set<ChatRoutingReasonCode>(valid.reason_codes);
  for (const reason of reasonCodes) if (REASON_SET.has(reason)) reasons.add(reason);
  return {
    policy_version: CHAT_ROUTING_POLICY_VERSION,
    lane: nextLane,
    reason_codes: CHAT_ROUTING_REASON_CODES.filter((reason) => reasons.has(reason)),
  };
}

export function normalizeChatRoutingDecision(value: unknown): ChatRoutingDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.policy_version !== CHAT_ROUTING_POLICY_VERSION || !LANE_SET.has(String(raw.lane))) return null;
  if (!Array.isArray(raw.reason_codes) || raw.reason_codes.length === 0) return null;
  const reasons = raw.reason_codes.map(String);
  if (reasons.some((reason) => !REASON_SET.has(reason))) return null;
  return {
    policy_version: CHAT_ROUTING_POLICY_VERSION,
    lane: raw.lane as ChatLane,
    reason_codes: CHAT_ROUTING_REASON_CODES.filter((reason) => reasons.includes(reason)),
  };
}

/**
 * Normalize a provider -> KEY -> {model, reasoning} override map. Only the shape is
 * validated here; provider capabilities stay adapter-owned (agents.ts clamps what a
 * given CLI can actually take). `keys` is the closed set of second-level names, so
 * the same normalizer serves the chat lanes and the op/task profile overrides.
 */
export function normalizeProfileBindings<K extends string>(value: unknown, keys: readonly K[]): ProfileBindings<K> {
  let raw: unknown = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ProfileBindings<K> = {};
  for (const [providerRaw, keysRaw] of Object.entries(raw as Record<string, unknown>)) {
    const provider = providerRaw.trim().slice(0, 80);
    if (!provider || !keysRaw || typeof keysRaw !== "object" || Array.isArray(keysRaw)) continue;
    const bound: ProviderProfileBindings<K> = {};
    for (const key of keys) {
      const profileRaw = (keysRaw as Record<string, unknown>)[key];
      if (!profileRaw || typeof profileRaw !== "object" || Array.isArray(profileRaw)) continue;
      const profile: ChatProfileBinding = {};
      if (typeof (profileRaw as Record<string, unknown>).model === "string") {
        const model = ((profileRaw as Record<string, unknown>).model as string).trim().slice(0, 160);
        if (model) profile.model = model;
      }
      const reasoning = String((profileRaw as Record<string, unknown>).reasoning ?? "").trim();
      if (REASONING_SET.has(reasoning)) profile.reasoning = reasoning as ChatReasoningLevel;
      if (profile.model || profile.reasoning) bound[key] = profile;
    }
    if (Object.keys(bound).length > 0) out[provider] = bound;
  }
  return out;
}

export function normalizeChatProfileBindings(value: unknown): ChatProfileBindings {
  return normalizeProfileBindings(value, CHAT_LANES);
}
/**
 * Resolve requested model/reasoning independently of any provider CLI syntax. The
 * model is, in order: the advanced per-lane override (chat_profile_bindings), else the
 * person's class choice for the lane's class (model_class_bindings; the coach lane reads
 * its own `coach` key first, then `fast`), else nothing — the CLI's own default model.
 */
export function resolveChatProfile(
  lane: ChatLane,
  selectedProvider: string | null | undefined,
  bindings: unknown,
  classBindings?: ChatClassModelBindings | null,
  reasonCodes?: readonly string[]
): ResolvedChatProfile {
  const normalized = normalizeChatProfileBindings(bindings);
  const provider = String(selectedProvider ?? "").trim();
  const bound = provider ? normalized[provider]?.[lane] : undefined;
  const model = bound?.model ?? classBoundChatModel(provider, chatLaneBindingClass(lane), classBindings);
  return {
    ...(model ? { model } : {}),
    reasoning: bound?.reasoning ?? laneReasoning(lane, reasonCodes),
  };
}
