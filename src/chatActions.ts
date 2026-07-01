import { HEALTH_DOCUMENT_KIND_SCHEMA } from "./healthDocumentKinds.js";

type ChatActionRecord = Record<string, unknown>;

export const CHAT_ACTION_TYPES = [
  "log_activity",
  "log_set",
  "set_profile",
  "set_endurance_goal",
  "add_memory",
  "update_memory",
  "supersede_memory",
  "log_food",
  "update_food_note",
  "plan_update",
  "plan_restructure",
  "log_health",
  "add_context_event",
  "resolve_context_event",
  "log_supplement",
  "log_measurement",
] as const;

export type ChatActionType = typeof CHAT_ACTION_TYPES[number];

export type ChatActionApplyMode = "immediate" | "draft";

export type ChatActionPromptSpec<T extends ChatActionType = ChatActionType> = {
  type: T;
  applyMode: ChatActionApplyMode;
  summary?: string;
  shape: string;
  guidance?: readonly string[];
};

interface ChatActionBase {
  type: ChatActionType;
}

export interface LogActivityAction extends ChatActionBase {
  type: "log_activity";
  text: string;
  date?: unknown;
  notes?: unknown;
}

export interface LogSetAction extends ChatActionBase {
  type: "log_set";
  exercise: string;
  [key: string]: unknown;
}

export interface SetProfileAction extends ChatActionBase {
  type: "set_profile";
  [key: string]: unknown;
}

export interface SetEnduranceGoalAction extends ChatActionBase {
  type: "set_endurance_goal";
  [key: string]: unknown;
}

export interface AddMemoryAction extends ChatActionBase {
  type: "add_memory";
  content: string;
  kind?: unknown;
}

export interface UpdateMemoryAction extends ChatActionBase {
  type: "update_memory";
  id: number | string;
  content: string;
  kind?: unknown;
}

export interface SupersedeMemoryAction extends ChatActionBase {
  type: "supersede_memory";
  id: number | string;
  reason?: unknown;
  replacement?: unknown;
}

export interface LogFoodAction extends ChatActionBase {
  type: "log_food";
  meal?: unknown;
  summary?: unknown;
  name?: unknown;
  items?: unknown;
  ingredients?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  fiber_g?: unknown;
  notes?: unknown;
}

export interface UpdateFoodNoteAction extends ChatActionBase {
  type: "update_food_note";
  id: number | string;
  meal?: unknown;
  summary?: unknown;
  items?: unknown;
  notes?: unknown;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  fiber_g?: unknown;
}

export interface PlanUpdateAction extends ChatActionBase {
  type: "plan_update";
  summary?: unknown;
  changes: unknown[];
}

export interface PlanRestructureAction extends ChatActionBase {
  type: "plan_restructure";
  summary?: unknown;
  days: unknown[];
}

export interface LogHealthAction extends ChatActionBase {
  type: "log_health";
  kind: string;
  doc_date?: unknown;
  summary?: unknown;
  markers?: unknown;
  parsed?: unknown;
}

export interface AddContextEventAction extends ChatActionBase {
  type: "add_context_event";
  kind: string;
  title?: unknown;
  detail?: unknown;
  start_date?: unknown;
  end_date?: unknown;
  meta?: unknown;
}

export interface ResolveContextEventAction extends ChatActionBase {
  type: "resolve_context_event";
  id: number | string;
  date?: unknown;
}

export interface LogSupplementAction extends ChatActionBase {
  type: "log_supplement";
  items?: ChatActionRecord[];
  text?: unknown;
  summary?: unknown;
}

export interface LogMeasurementAction extends ChatActionBase {
  type: "log_measurement";
  [key: string]: unknown;
}

export type ChatAction =
  | LogActivityAction
  | LogSetAction
  | SetProfileAction
  | SetEnduranceGoalAction
  | AddMemoryAction
  | UpdateMemoryAction
  | SupersedeMemoryAction
  | LogFoodAction
  | UpdateFoodNoteAction
  | PlanUpdateAction
  | PlanRestructureAction
  | LogHealthAction
  | AddContextEventAction
  | ResolveContextEventAction
  | LogSupplementAction
  | LogMeasurementAction;

const CHAT_ACTION_TYPE_SET = new Set<string>(CHAT_ACTION_TYPES);

export const CHAT_ACTION_PROMPT_SPECS = {
  log_activity: {
    type: "log_activity",
    applyMode: "immediate",
    shape: `{ "type": "log_activity", "text": "ran 50 min @ 5:30/km" }`,
  },
  log_set: {
    type: "log_set",
    applyMode: "immediate",
    shape: `{ "type": "log_set", "exercise": "Back Squat", "weight": 195, "reps": 8, "rir": 2, "day_number": 1 },
    { "type": "log_set", "exercise": "Dead Hang", "duration_sec": 45, "exercise_mode": "timed" }`,
    guidance: [
      `When you log_set or otherwise name an exercise, use a CLEAN canonical name (e.g. "Incline DB Press", "Romanian Deadlift") — not a descriptive/throwaway phrase ("incline db press 3x10 lol") — and reuse an existing KNOWN-EXERCISE name when it matches, so the same movement stays one entry.`,
    ],
  },
  set_profile: {
    type: "set_profile",
    applyMode: "immediate",
    shape: `{ "type": "set_profile", "weight_lb": 176 }`,
  },
  set_endurance_goal: {
    type: "set_endurance_goal",
    applyMode: "immediate",
    shape: `// The endurance OBJECTIVE (running goal), orthogonal to the lifting plan. Use mode
    // "race" for a dated event (the coach periodizes a ramp + taper), or "standing" for
    // an ongoing readiness target with NO date (e.g. "stay 10k-ready"). Set this when the
    // athlete states a running goal ("I want to run the Cambridge Half on Nov 1", "keep me
    // able to run a 10k anytime"). Distinct from primary_discipline (set via set_profile).
    { "type": "set_endurance_goal", "mode": "race",
      "event": "<race name — race mode>", "date": "YYYY-MM-DD — race mode",
      "label": "<readiness label, e.g. '10k-ready' — standing mode>",
      "distance_km": <number|null>, "target": "<e.g. 'sub-1:45'|null>", "weekly_km": <number|null>, "weekly_sessions": <number|null> }`,
  },
  add_memory: {
    type: "add_memory",
    applyMode: "immediate",
    shape: `{ "type": "add_memory", "content": "Prefers morning training", "kind": "preference" }`,
  },
  update_memory: {
    type: "update_memory",
    applyMode: "immediate",
    shape: `{ "type": "update_memory", "id": <existing memory id from DATA.memory>, "content": "<corrected fact>", "kind": "preference|constraint|decision|injury|milestone|goal|observation" }`,
  },
  supersede_memory: {
    type: "supersede_memory",
    applyMode: "immediate",
    shape: `{ "type": "supersede_memory", "id": <id of the now-WRONG memory from DATA.memory>, "reason": "<what changed>", "replacement": "<optional new fact to remember instead>" }`,
  },
  log_food: {
    type: "log_food",
    applyMode: "immediate",
    shape: `{ "type": "log_food", "meal": "breakfast|lunch|dinner|snack", "summary": "<clean dish name>",
      "items": ["<component>"], "ingredients": [
        { "item": "<ingredient>", "amount": "<qty>", "kcal": <number|null>, "protein_g": <number|null>, "carbs_g": <number|null>, "fat_g": <number|null> } ],
      "kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "fiber_g": <number|null>, "notes": <string|null> }`,
    guidance: [
      `log_food records a meal estimate (food note) — use it when the athlete reports something they ate or attaches a plate photo. Estimate macros from ordinary serving sizes; null when too unsure.`,
      `BEFORE emitting log_food, check DATA.day_intake.entries. If the same meal is already logged today, reference it instead of logging a duplicate. If the athlete is correcting that row, emit update_food_note with the existing id.`,
    ],
  },
  update_food_note: {
    type: "update_food_note",
    applyMode: "immediate",
    shape: `{ "type": "update_food_note", "id": <existing id from DATA.day_intake.entries>,
      "meal": "breakfast|lunch|dinner|snack|meal", "summary": "<corrected dish name>",
      "kcal": <number|null>, "protein_g": <number|null>, "carbs_g": <number|null>, "fat_g": <number|null>, "fiber_g": <number|null>, "notes": <string|null> }`,
  },
  plan_update: {
    type: "plan_update",
    applyMode: "draft",
    shape: `{ "type": "plan_update", "summary": "...", "changes": [
      { "day_number": 1, "exercise": "Back Squat", "target_weight": 195, "reason": "..." },
      { "day_number": 1, "exercise": "Plank", "target_seconds": 60, "reason": "timed exercises progress in seconds" },
      // ADD a movement: a change whose exercise isn't on that day yet is ADDED to it.
      // Include sets + rep_low/rep_high (and the starting target_weight) so it lands complete.
      { "day_number": 1, "exercise": "Single-Arm DB Row", "sets": 3, "rep_low": 10, "rep_high": 12, "target_weight": 55, "reason": "adds back volume" } ] }`,
    guidance: [
      `plan_update (target tweaks AND adding/swapping a movement on an existing day) is saved as a DRAFT for the athlete to review and apply — never assume it's live. A plan_update change whose exercise is already on that day TWEAKS it; a change whose exercise is NOT on that day yet ADDS it (include sets + rep_low/rep_high so it lands complete). Use plan_update to add ONE or a few movements to days that exist.`,
    ],
  },
  plan_restructure: {
    type: "plan_restructure",
    applyMode: "draft",
    shape: `{ "type": "plan_restructure", "summary": "move to 5 days", "days": [
      { "day_number": 1, "name": "Lower A", "focus": "Quad", "items": [
        { "exercise": "Back Squat", "sets": 3, "rep_low": 8, "rep_high": 10, "target_weight": 190, "note": "" },
        { "exercise": "Plank", "sets": 3, "target_seconds": 45, "mode": "timed", "note": "" } ] } ] }`,
    guidance: [
      `plan_restructure (changing the split or days-per-week) is saved as a DRAFT for the athlete to review and apply — never assume it's live. Use plan_restructure only when the split/frequency itself changes ("5 days a week"), proposing a full plan with sensible exercises that honor their constraints and carrying over weights where it makes sense.`,
    ],
  },
  log_health: {
    type: "log_health",
    applyMode: "immediate",
    shape: `{ "type": "log_health", "kind": "${HEALTH_DOCUMENT_KIND_SCHEMA}", "doc_date": "YYYY-MM-DD|null",
      "summary": "<plain-language 1-2 sentence read on the results>",
      "markers": [ { "name": "Ferritin", "value": 45, "unit": "ng/mL", "flag": "low|high|normal|null" } ] }`,
    guidance: [
      `log_health records lab/bloodwork/DEXA/ECG results the athlete reports in chat — transcribe EVERY marker verbatim with its value, unit and a low/high/normal flag vs the usual range, plus a short plain-language summary.`,
      `Do NOT curate to "the interesting ones": an in-range/normal/boring marker (the full CBC differential, electrolytes, the whole urinalysis, omega sub-fractions, every hormone) is just as required as a flagged one — if it has a name and a value, include it. Lands straight in their Health records (Me → Health) and feeds the marker trends. Never invent a value.`,
      `Preserve source units exactly as reported; do not convert US/SI/EU units yourself. Informational, not medical advice.`,
      `NOTE: for a big pasted panel (dozens of markers), the Health tab's "paste results" box is the more reliable, complete path — you may mention it in passing.`,
    ],
  },
  add_context_event: {
    type: "add_context_event",
    applyMode: "immediate",
    shape: `{ "type": "add_context_event", "kind": "trip|injury|life_event|family_event", "title": "<short>",
      "detail": "<optional>", "start_date": "YYYY-MM-DD|null", "end_date": "YYYY-MM-DD|null",
      "meta": { "area": "<injuries: knee / lower back>", "severity": "mild|moderate|severe", "location": "<trips>", "member": "<family_event: who>", "recurrence": "<family_event: e.g. Tue 17:00>" } }`,
    guidance: [
      `add_context_event records a trip, injury/niggle, major life event, or family commitment onto their timeline (Me → Life) so the plan adapts around it — ease off an injured area, plan travel-friendly weeks, dial volume back during a stressful stretch, keep family days shorter/more flexible.`,
      `Use "injury" for any pain/niggle they mention, "trip" for travel, "family_event" for a recurring family/kids commitment (meta {member, recurrence}, e.g. "Tue 17:00 soccer"), "life_event" otherwise.`,
      `Set start/end dates ONLY when the athlete actually gave them. NEVER guess or approximate a date (don't turn "in November" into a specific day) — leave start_date/end_date null when you don't know. If the exact date matters (e.g. a race they're training for), record the event with null dates and ask them once, in one brief line, for the real date rather than inventing a placeholder.`,
    ],
  },
  resolve_context_event: {
    type: "resolve_context_event",
    applyMode: "immediate",
    shape: `{ "type": "resolve_context_event", "id": <existing context_event id from DATA.context_events>, "date": "YYYY-MM-DD|null" }`,
    guidance: [
      `resolve_context_event closes a healed injury / finished trip / passed life event on their timeline WITHOUT deleting it — it stays on record but stops making the plan work around it. Use it when the athlete confirms an injury/niggle is no longer bothering them (e.g. you gently asked about a past-window injury and they said it's fine). Only emit it for an id that is actually in DATA.context_events, and only when they've confirmed — never guess it's healed.`,
    ],
  },
  log_supplement: {
    type: "log_supplement",
    applyMode: "immediate",
    shape: `// Supplement UNDERSTANDING (not a daily log). When the athlete mentions what they take
    // ("I take creatine daily, omega-3, some D, whey occasionally"), capture it ONCE and
    // approximate sensibly. Prefer structured "items" (you fill canonical name + typical
    // dose + cadence + the markers it touches); or pass "text" for the server to approximate.
    { "type": "log_supplement", "items": [
      { "name": "Creatine monohydrate", "dose": "5 g", "frequency": "daily", "category": "performance", "related_markers": ["eGFR"] },
      { "name": "Vitamin D3", "dose": "2000 IU", "frequency": "daily", "category": "vitamin", "related_markers": ["Vitamin D"] } ] }`,
  },
  log_measurement: {
    type: "log_measurement",
    applyMode: "immediate",
    shape: `{ "type": "log_measurement", "date": "YYYY-MM-DD|null", "waist_in": 34, "chest_in": 42, "upper_arm_in": 15,
      "hip_in": 40, "neck_in": 15.5, "shoulder_in": 50, "thigh_in": 24, "calf_in": 16, "forearm_in": 12,
      "height_in": 70, "note": "<optional>", "source": "chat" }`,
    guidance: [
      `log_measurement records at-home body measurements (tape/circumference, in inches) so the body picture — waist trend, BMI, waist-to-height, Navy body-fat estimate — stays current. Include only the sites they actually gave; the user can just say "waist 34, chest 42, arms 15" and it logs. "upper_arm_in" is the arm/bicep; only send "height_in" if they tell you their height (it updates the profile so BMI/body-fat light up). Leave date null unless they name one.`,
    ],
  },
} as const satisfies { [K in ChatActionType]: ChatActionPromptSpec<K> };

export function chatActionPromptSpecs(): ChatActionPromptSpec[] {
  return CHAT_ACTION_TYPES.map((type) => CHAT_ACTION_PROMPT_SPECS[type]);
}

export function immediateChatActionTypes(): ChatActionType[] {
  return chatActionPromptSpecs().filter((spec) => spec.applyMode === "immediate").map((spec) => spec.type);
}

export function draftChatActionTypes(): ChatActionType[] {
  return chatActionPromptSpecs().filter((spec) => spec.applyMode === "draft").map((spec) => spec.type);
}

function renderActionGuidance(types: readonly ChatActionType[]): string {
  return types
    .flatMap((type) => (CHAT_ACTION_PROMPT_SPECS[type] as ChatActionPromptSpec).guidance ?? [])
    .map((line) => `- ${line}`)
    .join("\n");
}

export function renderChatActionSchema(): string {
  return `[
    // zero or more — ONLY when the athlete clearly asked to log or change something.
    ${chatActionPromptSpecs().map((spec) => spec.shape).join(",\n    ")}
]`;
}

export function renderChatActionPromptProse(): string {
  return `ACTIONS — only when the athlete clearly asks to log or change something:
- ${immediateChatActionTypes().join(", ")} are APPLIED immediately.
${renderActionGuidance(immediateChatActionTypes())}
- ${draftChatActionTypes().join(" and ")} are saved as DRAFTS for the athlete to review and apply — never assume they're live.
${renderActionGuidance(draftChatActionTypes())}
- If they're just asking a question, write ONLY the prose reply — no actions block at all.`;
}

function isRecord(value: unknown): value is ChatActionRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isKnownType(type: unknown): type is ChatActionType {
  return typeof type === "string" && CHAT_ACTION_TYPE_SET.has(type);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteId(value: unknown): value is number | string {
  if (typeof value === "number") return Number.isFinite(value) && value > 0;
  if (typeof value !== "string" || value.trim() === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// The measurable inputs of a log_measurement action (the tape sites + height). Kept
// literal here so chatActions stays free of a repo import; the repo's pickSites is the
// authority on which of these actually persist.
const MEASUREMENT_ACTION_FIELDS = [
  "neck_in",
  "shoulder_in",
  "chest_in",
  "waist_in",
  "hip_in",
  "thigh_in",
  "calf_in",
  "upper_arm_in",
  "forearm_in",
  "height_in",
] as const;

export function normalizeChatAction(value: unknown): ChatAction | null {
  if (!isRecord(value) || !isKnownType(value.type)) return null;
  switch (value.type) {
    case "log_activity":
      return nonBlank(value.text) ? { ...value, type: "log_activity", text: value.text } : null;
    case "log_set":
      return nonBlank(value.exercise) ? { ...value, type: "log_set", exercise: value.exercise } : null;
    case "set_profile":
      return { ...value, type: "set_profile" };
    case "set_endurance_goal":
      return { ...value, type: "set_endurance_goal" };
    case "add_memory":
      return nonBlank(value.content) ? { ...value, type: "add_memory", content: value.content } : null;
    case "update_memory":
      return finiteId(value.id) && nonBlank(value.content)
        ? { ...value, type: "update_memory", id: value.id, content: value.content }
        : null;
    case "supersede_memory":
      return finiteId(value.id) ? { ...value, type: "supersede_memory", id: value.id } : null;
    case "log_food":
      return { ...value, type: "log_food" };
    case "update_food_note":
      return finiteId(value.id) ? { ...value, type: "update_food_note", id: value.id } : null;
    case "plan_update": {
      const changes = arrayOrEmpty(value.changes);
      return changes.length ? { ...value, type: "plan_update", changes } : null;
    }
    case "plan_restructure": {
      const days = arrayOrEmpty(value.days);
      return days.length ? { ...value, type: "plan_restructure", days } : null;
    }
    case "log_health":
      return nonBlank(value.kind) ? { ...value, type: "log_health", kind: value.kind } : null;
    case "add_context_event":
      return nonBlank(value.kind) ? { ...value, type: "add_context_event", kind: value.kind } : null;
    case "resolve_context_event":
      return finiteId(value.id) ? { ...value, type: "resolve_context_event", id: value.id } : null;
    case "log_supplement": {
      const items = Array.isArray(value.items) ? value.items.filter(isRecord) : undefined;
      return items?.length
        ? { ...value, type: "log_supplement", items }
        : { ...value, type: "log_supplement" };
    }
    case "log_measurement":
      // Keep it only when at least one measurable field (a *_in site or height) is present —
      // an empty measurement is a no-op the apply path would just record as ok:false.
      return MEASUREMENT_ACTION_FIELDS.some((k) => value[k] != null && value[k] !== "")
        ? { ...value, type: "log_measurement" }
        : null;
  }
  const _exhaustive: never = value.type;
  return _exhaustive;
}

export function normalizeChatActions(actions: unknown): ChatAction[] {
  return Array.isArray(actions)
    ? actions.map(normalizeChatAction).filter((action): action is ChatAction => !!action)
    : [];
}

export function chatActionTypeList(): ChatActionType[] {
  return [...CHAT_ACTION_TYPES];
}
