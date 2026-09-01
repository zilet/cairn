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
  reasoning: ChatReasoningLevel;
}

const LANE_RANK: Record<ChatLane, number> = { capture: 0, coach: 1, deep: 2 };
const LANE_SET = new Set<string>(CHAT_LANES);
const REASON_SET = new Set<string>(CHAT_ROUTING_REASON_CODES);
const REASONING_SET = new Set<string>(CHAT_REASONING_LEVELS);
const DEFAULT_REASONING: Record<ChatLane, ChatReasoningLevel> = {
  capture: "low",
  coach: "medium",
  deep: "high",
};

const CLINICAL_OR_INJURY =
  /\b(?:clinical|clinician|doctor|physician|diagnos(?:e|is|ed)|symptom|injur(?:y|ed)|pain|rehab|surgery|infection|disease|condition|sore|swollen|swelling|chest pain|severe (?:abdominal )?pain|(?:can(?:not|'t)|unable to) bear weight|(?:can(?:not|'t)|unable to) walk|popped|pop(?:ped)?|stress fracture|unsafe|as fast as possible)\b/i;
const LAB_OR_IMAGING =
  /\b(?:bloodwork|blood work|lab(?:s|work| result)?|biomarker|mri|ct scan|x-?ray|ultrasound|imaging|scan result|dexa|\b(?:ldl|hdl|a1c|hba1c|triglycerides?|ferritin|apob)\s*(?:is|was|of|:|=)?\s*\d+(?:\.\d+)?)\b/i;
const MEDICATION =
  /\b(?:medication|medicine|prescription|dosage|dose|drug|side effect|interaction|insulin|warfarin|antibiotics?|metformin|statin|ssri|blood pressure medicine)\b/i;
const GOAL_IDENTITY =
  /\b(?:(?:change|switch|replace|rethink|set|reset|choose)\s+(?:a |my )?(?:new\s+)?goal|goal\s+(?:is|should be|mode)|(?:lose|gain)\s+(?:weight|fat|muscle)|bulk(?:ing)?|cut(?:ting)?|maintenance\s+goal|new goal)\b/i;
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
const AMENDMENT_VERB = /\b(?:add|include|also|plus)\b/i;
const NEW_LOG_VERB = /\b(?:log|track|record|save|enter)\b/i;
const CORRECTION_VERB = /\b(?:correct(?:ion)?|fix|edit|update|change|actually|remove|forgot|don'?t log)\b/i;

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
  if (hasCaptureVerb && ACTIVITY_NOUN.test(message)) addReason(reasons, "explicit_activity_log");
  if (hasCaptureVerb && WEIGHT_NOUN.test(message)) addReason(reasons, "explicit_weight_log");
  if (hasCaptureVerb && SUPPLEMENT_NOUN.test(message)) addReason(reasons, "explicit_supplement_log");

  // Natural-language capture stays intentionally narrow: a concrete completed
  // event is eligible, while a general question about food/training is not.
  if (/\b(?:i\s+)?(?:ate|drank|had)\b/i.test(message) || /\b(?:breakfast|lunch|dinner)\s*(?:was|:)/i.test(message)) addReason(reasons, "explicit_food_log");
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

  // An amendment-verbed follow-up shortly after a food capture is a correction
  // to that meal even when the item is in no noun list ("Add half of Brussel
  // sprouts from their appetizer list"). It must carry capture_correction: that
  // is what keeps it OFF the no-agent instant path (which can only create a NEW
  // note — a duplicate meal here) and on the agent path where update_food_note
  // can reach the existing row. Plain log verbs ("log/track/record…") are
  // excluded so a genuinely new entry keeps its instant receipt, and the other
  // logging domains keep priority: an activity/weight/supplement-shaped message
  // never rides this branch.
  if (
    recentFoodCapture &&
    (AMENDMENT_VERB.test(message) || hasCorrectionVerb) &&
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
  if (captures.length > 0 && chatMessageRequestsCoaching(message)) {
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
/** Resolve requested model/reasoning independently of any provider CLI syntax. */
export function resolveChatProfile(
  lane: ChatLane,
  selectedProvider: string | null | undefined,
  bindings: unknown
): ResolvedChatProfile {
  const normalized = normalizeChatProfileBindings(bindings);
  const provider = String(selectedProvider ?? "").trim();
  const bound = provider ? normalized[provider]?.[lane] : undefined;
  return {
    ...(bound?.model ? { model: bound.model } : {}),
    reasoning: bound?.reasoning ?? DEFAULT_REASONING[lane],
  };
}
