import {
  FOOD_INGREDIENT_SCHEMA,
  FOOD_NUTRITION_PATTERN_SCHEMA,
  FOOD_PROVENANCE_SCHEMA,
  FOOD_CAPTURE_GUARDRAILS,
} from "./foodCapture.js";
import { HEALTH_DOCUMENT_KINDS, normalizeHealthDocumentKind, type HealthDocumentKind } from "./healthDocumentKinds.js";
import { CONTEXT_TAG_VOCAB, isContextTagKey } from "./contextTags.js";
import { localDateISO } from "./repo/shared.js";

type ChatActionRecord = Record<string, unknown>;

// The same input bound the MCP symptom tools declare. The repo normalizes an area
// to a 60-char label regardless; this is the "that is prose, not a place" line, and
// it has to match across surfaces or chat becomes the loose one.
const SYMPTOM_AREA_INPUT_MAX = 120;

// A structure request is one athlete sentence, not a transcript. The decision
// contract truncates a rationale at 1,500 characters anyway; bounding it here keeps
// the stored ask readable and the shape check honest about what it accepted.
export const TRAINING_STRUCTURE_REQUEST_MAX = 1_000;

export const CHAT_ACTION_TYPES = [
  "log_activity",
  "log_set",
  "set_profile",
  "set_training_intent",
  "set_endurance_goal",
  "set_strength_objective",
  "add_memory",
  "update_memory",
  "supersede_memory",
  "log_food",
  "update_food_note",
  "log_weight",
  "plan_update",
  "plan_restructure",
  "set_run",
  "log_health",
  "add_context_event",
  "resolve_context_event",
  "log_context_tag",
  "log_supplement",
  "log_measurement",
  "report_training_symptom",
  "resolve_training_symptom",
  "log_checkin",
  "flag_training_structure",
  "revert_decision",
] as const;

export type ChatActionType = (typeof CHAT_ACTION_TYPES)[number];

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

export interface SetTrainingIntentAction extends ChatActionBase {
  type: "set_training_intent";
  priorities: unknown[];
  endurance_role: "none" | "supporting" | "co_primary" | "primary";
  endurance_capacity?: unknown;
}

export interface SetEnduranceGoalAction extends ChatActionBase {
  type: "set_endurance_goal";
  [key: string]: unknown;
}

export interface SetStrengthObjectiveAction extends ChatActionBase {
  type: "set_strength_objective";
  exercise: string;
  target_kind: "return_to_personal_best" | "explicit_est_1rm";
  target_est_1rm?: unknown;
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
  // The coarse bands that let intake be correlated against a blood panel, and the
  // provenance that keeps a stated weight distinguishable from a guess. Both are
  // coerced by src/foodCapture.ts on the way to storage — the same coercion the two
  // enrichment paths already run — so an off-contract value never reaches the blob.
  nutrition_pattern?: unknown;
  confidence?: unknown;
  basis?: unknown;
  notes?: unknown;
  // WHEN it was eaten, resolved by the model out of the sentence ("I had a late
  // dinner last night") against the local clock it already receives via
  // nowContext(). Never asked for, and both routinely absent. Independently
  // optional; the repo validates them and, on this lane, degrades a bad guess to
  // today rather than losing the meal.
  date?: unknown;
  eaten_at?: unknown;
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
  // Move a logged entry to the day/time it actually happened. Omitting either
  // leaves it as stored, so a macro fix never restamps the clock; an explicit null
  // on eaten_at unstates a time that turned out to be wrong.
  date?: unknown;
  eaten_at?: unknown;
}

export interface LogWeightAction extends ChatActionBase {
  type: "log_weight";
  weight_lb: number;
  date?: unknown;
  note?: unknown;
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

// ONE run on ONE plan day. The endurance counterpart to a single-movement
// plan_update: `changes[]` can only reach LOADED movements, so before this action
// existed a run request had nowhere to land (see applyChatRunPrescription).
export type RunPrescriptionKind = "easy" | "quality" | "long";
export type RunZoneKey = "z1" | "z2" | "z3" | "z4" | "z5";

export interface SetRunAction extends ChatActionBase {
  type: "set_run";
  day_number: number;
  kind?: RunPrescriptionKind | null;
  // Distance and duration are two ways to say the same ask, so naming one CLEARS
  // the other (a "make it 8k" over a stored 45-minute run must not persist as
  // "8 km for 45 minutes"). Naming both keeps both.
  distance_km?: unknown;
  duration_min?: unknown;
  // A zone KEY only. The bpm band is rendered server-side from the athlete's own
  // HR model — a model-written band would be a population formula in disguise.
  zone?: RunZoneKey | null;
  label?: unknown;
  // Which run, on a day that already carries more than one. Absent and ambiguous
  // is an honest refusal, never a guess.
  match_label?: unknown;
  note?: unknown;
  reason?: unknown;
}

const RUN_PRESCRIPTION_KINDS = new Set<string>(["easy", "quality", "long"]);

export function normalizeRunPrescriptionKind(value: unknown): RunPrescriptionKind | null {
  if (!nonBlank(value)) return null;
  const key = value.trim().toLowerCase();
  return RUN_PRESCRIPTION_KINDS.has(key) ? (key as RunPrescriptionKind) : null;
}

// "z2" / "Z2" / "zone 2" / "2" all mean the same band, and an already-rendered tag
// ("Z2 (142–148 bpm)") yields its KEY — the bpm are re-derived from the athlete's own
// model, never trusted from text. Anything else is not a zone.
export function normalizeRunZoneKey(value: unknown): RunZoneKey | null {
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  const match = /^(?:zone\s*)?z\s*([1-5])\b/.exec(raw) ?? /^([1-5])$/.exec(raw);
  return match ? (`z${match[1]}` as RunZoneKey) : null;
}

export function positiveNumberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
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

export interface LogContextTagAction extends ChatActionBase {
  type: "log_context_tag";
  tags: string[]; // keys from CONTEXT_TAG_VOCAB — never free text
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

export interface ReportTrainingSymptomAction extends ChatActionBase {
  type: "report_training_symptom";
  area_text: string;
  onset_on?: unknown;
}

export interface ResolveTrainingSymptomAction extends ChatActionBase {
  type: "resolve_training_symptom";
  area_text: string;
  on?: unknown;
}

export interface LogCheckinAction extends ChatActionBase {
  type: "log_checkin";
  energy?: number | null;
  sleep_feel?: number | null;
  soreness?: number | null;
  mood?: number | null;
  note?: unknown;
  date?: unknown;
}

// The athlete asking for a change to the SHAPE of their training — which lifts the
// program is built around, how the week is split, what the block is for. Chat cannot
// restructure a plan, and a promise to "flag it to your coach lane" that wrote nothing
// was the whole bug this exists to close: the action records an ask-tier
// `training_structure` brain decision carrying the athlete's own sentence, and the
// athlete confirms it on the existing decision surfaces. It never applies anything.
export interface FlagTrainingStructureAction extends ChatActionBase {
  type: "flag_training_structure";
  request: string;
  summary?: unknown;
}

export interface RevertDecisionAction extends ChatActionBase {
  type: "revert_decision";
  id: number | string;
  reason?: unknown;
}

export type ChatAction =
  | LogActivityAction
  | LogSetAction
  | SetProfileAction
  | SetTrainingIntentAction
  | SetEnduranceGoalAction
  | SetStrengthObjectiveAction
  | AddMemoryAction
  | UpdateMemoryAction
  | SupersedeMemoryAction
  | LogFoodAction
  | UpdateFoodNoteAction
  | LogWeightAction
  | PlanUpdateAction
  | PlanRestructureAction
  | SetRunAction
  | LogHealthAction
  | AddContextEventAction
  | ResolveContextEventAction
  | LogContextTagAction
  | LogSupplementAction
  | LogMeasurementAction
  | ReportTrainingSymptomAction
  | ResolveTrainingSymptomAction
  | LogCheckinAction
  | FlagTrainingStructureAction
  | RevertDecisionAction;

const CHAT_ACTION_TYPE_SET = new Set<string>(CHAT_ACTION_TYPES);

// Chat's log_health action is the marker-oriented capture path. Imaging has its
// own Records upload/draft/confirmation workflow and must never be squeezed into
// a marker document by a forged or off-contract chat action.
export const CHAT_LOG_HEALTH_KINDS = HEALTH_DOCUMENT_KINDS.filter((kind) => kind !== "imaging");
export type ChatLogHealthKind = Exclude<HealthDocumentKind, "imaging">;
const CHAT_LOG_HEALTH_KIND_SET = new Set<string>(CHAT_LOG_HEALTH_KINDS);
export const CHAT_LOG_HEALTH_KIND_SCHEMA = CHAT_LOG_HEALTH_KINDS.join("|");

export function normalizeChatLogHealthKind(value: unknown): ChatLogHealthKind | null {
  if (!nonBlank(value)) return null;
  const normalizedInput = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const kind = normalizeHealthDocumentKind(value);
  if (kind === "other" && normalizedInput !== "other") return null;
  return CHAT_LOG_HEALTH_KIND_SET.has(kind) ? (kind as ChatLogHealthKind) : null;
}

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
  set_training_intent: {
    type: "set_training_intent",
    applyMode: "immediate",
    shape: `// The athlete's DURABLE, ordered training identity. Use this only when the
    // athlete explicitly states what should win when goals compete. A dated race stays
    // separate in set_endurance_goal — it is a temporary overlay, not a replacement
    // for this identity.
    { "type": "set_training_intent",
      "priorities": ["longevity"|"muscle"|"leanness"|"strength"|"endurance", "..."],
      "endurance_role": "none"|"supporting"|"co_primary"|"primary",
      "endurance_capacity": {
        "sport": "<e.g. mountain biking>",
        "target_duration_min": <number>,
        "context": "<e.g. rolling technical trails|null>"
      } }`,
    guidance: [
      `Preserve the athlete's stated order exactly and dedupe repeated priorities. endurance_role says whether endurance is absent, supports higher goals, shares the lead, or leads. Omit endurance_capacity unless the athlete names a durable sport-specific capability.`,
      `Age, recovery, soreness, joint/tendon feedback and injury history constrain dose and scheduling; they never silently rewrite the athlete's goal order.`,
    ],
  },
  set_endurance_goal: {
    type: "set_endurance_goal",
    applyMode: "immediate",
    shape: `// The endurance OBJECTIVE (running goal), orthogonal to the lifting plan. Use mode
    // "race" for a dated event (the coach periodizes a ramp + taper), or "standing" for
    // an ongoing readiness target with NO date (e.g. "stay 10k-ready"). Set this when the
    // user states a running goal ("I want to run the Spring Half on Nov 1", "keep me
    // able to run a 10k anytime"). Distinct from primary_discipline (set via set_profile).
    { "type": "set_endurance_goal", "mode": "race",
      "event": "<race name — race mode>", "date": "YYYY-MM-DD — race mode",
      "label": "<readiness label, e.g. '10k-ready' — standing mode>",
      "distance_km": <number|null>, "target": "<e.g. 'sub-1:45'|null>", "weekly_km": <number|null>, "weekly_sessions": <number|null> }`,
  },
  set_strength_objective: {
    type: "set_strength_objective",
    applyMode: "immediate",
    shape: `{ "type": "set_strength_objective", "exercise": "Barbell Bench Press",
      "target_kind": "return_to_personal_best|explicit_est_1rm", "target_est_1rm": <number — required only for explicit_est_1rm> }`,
    guidance: [
      `Set a strength objective ONLY when the athlete explicitly chooses ONE named anchor lift and states that they want to return to its personal best or reach a specific estimated-1RM. A question like "what should my bench goal be?", comparing exercises, or general comeback talk is exploratory and MUST NOT write an objective — ask one brief clarifying question instead.`,
      `return_to_personal_best snapshots that exact exercise's logged all-time est-1RM now. explicit_est_1rm snapshots the athlete's stated number. Barbell and dumbbell variants are different objectives; never silently merge or substitute them.`,
    ],
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
        ${FOOD_INGREDIENT_SCHEMA} ],
      "kcal": <number>, "protein_g": <number>, "carbs_g": <number>, "fat_g": <number>, "fiber_g": <number|null>, "notes": <string|null>,
      "nutrition_pattern": ${FOOD_NUTRITION_PATTERN_SCHEMA},
      ${FOOD_PROVENANCE_SCHEMA},
      "date": "YYYY-MM-DD|omit", "eaten_at": "HH:MM (24h, local)|omit" }`,
    guidance: [
      `log_food records a meal estimate (food note) — use it when the user reports something they ate or attaches a plate photo. Estimate macros from ordinary serving sizes; null when too unsure.`,
      `A QUESTION about food is not a log. "Should I eat this?", "how much protein is in that?", "is X a good dinner?", "what would that do to my day?" are asking for an answer, not for a row — answer them and emit nothing. Only a report of something actually EATEN gets a log_food. If it is genuinely ambiguous ("having the salmon"), answer the question and leave the log alone; an unlogged meal is recoverable, an invented one silently becomes intake evidence.`,
      ...FOOD_CAPTURE_GUARDRAILS,
      `nutrition_pattern is what lets intake be read against their bloodwork later (sodium, potassium, calcium, iron, saturated fat, added sugar, omega-3, alcohol, caffeine). Fill it for every meal you log, in coarse bands — "unknown" is a fine, honest answer for a band you cannot call.`,
      `BEFORE emitting log_food, check DATA.day_intake.entries. If the same meal is already logged today, reference it instead of logging a duplicate. If the user is correcting that row, emit update_food_note with the existing id.`,
      `WHEN they ate it: people log out of order — "last night", "yesterday at 8", "this morning", "a couple hours ago", "lunch yesterday". Resolve those against DATA.now (which carries today's local date, weekday, time and hour) and emit "date" and "eaten_at" yourself. "last night" = yesterday's date at a late-evening hour; "this morning" = today, early; a bare clock time means today unless the sentence points at another day. Omit "date" for a meal eaten today.`,
      `NEVER ask what time it was. If they didn't say, omit "eaten_at" entirely — an entry with no time is completely normal and completely fine. Approximating from what they DID say ("a late dinner" → about 21:00) is right; interrogating them for a number is not. Never invent a date you have no basis for.`,
    ],
  },
  update_food_note: {
    type: "update_food_note",
    applyMode: "immediate",
    shape: `{ "type": "update_food_note", "id": <existing id from DATA.day_intake.entries>,
      "meal": "breakfast|lunch|dinner|snack|meal", "summary": "<corrected dish name>",
      "kcal": <number|null>, "protein_g": <number|null>, "carbs_g": <number|null>, "fat_g": <number|null>, "fiber_g": <number|null>, "notes": <string|null>,
      "date": "YYYY-MM-DD|omit", "eaten_at": "HH:MM (24h, local)|null|omit" }`,
    guidance: [
      `update_food_note also corrects WHEN something was eaten: "that was actually yesterday" moves the entry to that day, and "that was more like 9" fixes the time. Send "eaten_at": null to clear a time that turned out to be wrong. Omit both fields when only the food itself is being corrected.`,
    ],
  },
  log_weight: {
    type: "log_weight",
    applyMode: "immediate",
    shape: `{ "type": "log_weight", "weight_lb": <number in pounds>, "date": "YYYY-MM-DD|null", "note": "<optional brief note|null>" }`,
    guidance: [
      `log_weight records one stated weigh-in. Convert kg to pounds before emitting it. Do not emit it for a historical correction: chat currently has no safe weight-edit action.`,
    ],
  },
  plan_update: {
    type: "plan_update",
    applyMode: "immediate",
    shape: `{ "type": "plan_update", "summary": "...", "changes": [
      { "day_number": 1, "exercise": "Back Squat", "target_weight": 195, "reason": "..." },
      { "day_number": 1, "exercise": "Plank", "target_seconds": 60, "reason": "timed exercises progress in seconds" },
      // UPDATE the full bounded prescription (not just load):
      { "day_number": 1, "exercise": "Incline DB Press", "sets": 1, "rep_low": 8, "rep_high": 10, "target_weight": 40, "reason": "easy reset volume" },
      // REMOVE one redundant movement. NEVER encode removal as sets:0.
      { "day_number": 1, "exercise": "Incline Barbell Bench Press", "remove": true, "reason": "duplicate incline pattern" },
      // SWAP in place; supplied prescription fields configure the incoming movement.
      { "day_number": 1, "swap": { "from": "Incline Barbell Bench Press", "to": "Flat Barbell Bench Press" }, "sets": 2, "rep_low": 8, "rep_high": 10, "target_weight": 105, "reason": "keep one flat and one incline pattern" },
      // ADD a movement: a change whose exercise isn't on that day yet is ADDED to it.
      // Include sets + rep_low/rep_high (and the starting target_weight) so it lands complete.
      { "day_number": 1, "exercise": "Single-Arm DB Row", "sets": 3, "rep_low": 10, "rep_high": 12, "target_weight": 55, "reason": "adds back volume" } ] }`,
    guidance: [
      `plan_update is a SMALL, safety-checked adjustment to the existing plan. Use it when the user explicitly asks to fix today's/next session, or when this turn supplies a material training, recovery, pain, or life-context signal that changes the next session. A change can update load AND sets/rep_low/rep_high, add an absent movement, remove one with remove:true, or atomically swap {from,to} in place. NEVER use sets:0 to mean remove. Include every requested change in ONE plan_update so the server can apply the bounded edit as a unit. NEVER emit it for a food-only log, meal photo, or a general nutrition question.`,
      `The server applies actions after your prose. Describe the intended edit, but NEVER say it was saved, updated, pushed, applied, or is live. Cairn will add a verified receipt only after reading the stored plan back.`,
    ],
  },
  plan_restructure: {
    type: "plan_restructure",
    applyMode: "immediate",
    shape: `{ "type": "plan_restructure", "summary": "move to 5 days", "days": [
      { "day_number": 1, "name": "Lower A", "focus": "Quad", "items": [
        { "exercise": "Back Squat", "sets": 3, "rep_low": 8, "rep_high": 10, "target_weight": 190, "note": "" },
        { "exercise": "Plank", "sets": 3, "target_seconds": 45, "mode": "timed", "note": "" } ] } ] }`,
    guidance: [
      `plan_restructure changes the split or days-per-week. Use it only when the athlete explicitly asks for a structural change (for example, "move me to 5 days"), proposing a complete plan that honors constraints and carries forward supported loads. The server routes it through autonomy immediately: coach-led postures announce it for the next natural boundary with Discuss/Undo; review-everything still holds it for review. Never describe it as a bare draft and never claim it is live before the server receipt.`,
    ],
  },
  set_run: {
    type: "set_run",
    applyMode: "immediate",
    shape: `// ONE run in the CURRENT week. This is the ONLY action that can write a run
    // prescription — plan_update reaches loaded movements only, so a run sent through it
    // silently becomes a lifting movement. Zone is a KEY; Cairn renders the athlete's own
    // bpm band from their personal HR model.
    { "type": "set_run", "day_number": <plan day from DATA.plan>, "kind": "easy|quality|long",
      "distance_km": <number|null>, "duration_min": <number|null>, "zone": "z1|z2|z3|z4|z5|null",
      "label": "<e.g. 'Easy run' — omit to keep the run's current label>",
      "match_label": "<which run, ONLY when that day already carries more than one>",
      "reason": "<one line: why>" }`,
    guidance: [
      `set_run sets or adjusts exactly ONE run on ONE plan day of the current week ("make tomorrow's run 8k easy", "drop Thursday's tempo to 6k", "make the long run 75 minutes"). Use the day_number from DATA.plan — never invent one. It preserves that day's lifting and every other run on it. NEVER use plan_update or plan_restructure for a run: their changes[] can only reach loaded movements, so a run sent that way lands as a fake lifting exercise.`,
      `Distance and duration are two ways to say the same ask, so naming ONE clears the other. Send both only when the athlete asked for both. Zone is a zone KEY ("z2") — never write bpm numbers yourself; Cairn fills in the athlete's own band.`,
      `Changing the WHOLE week's run mix is not this action — there is no chat action for it. Say what you would change and point at the run plan, which proposes a full week for the athlete to accept.`,
      `The server applies actions after your prose. Describe the intended run, but NEVER say it was saved, updated, or is live. Cairn adds a verified receipt only after reading the stored run back.`,
    ],
  },
  log_health: {
    type: "log_health",
    applyMode: "immediate",
    shape: `{ "type": "log_health", "kind": "${CHAT_LOG_HEALTH_KIND_SCHEMA}", "doc_date": "YYYY-MM-DD|null",
      "summary": "<plain-language 1-2 sentence read on the results>",
      "markers": [ { "name": "Ferritin", "value": 45, "unit": "ng/mL", "flag": "low|high|normal|null" } ] }`,
    guidance: [
      `log_health records lab/bloodwork/DEXA/ECG results the user reports in chat — transcribe EVERY marker verbatim with its value, unit and a low/high/normal flag vs the usual range, plus a short plain-language summary.`,
      `Do NOT curate to "the interesting ones": an in-range/normal/boring marker (the full CBC differential, electrolytes, the whole urinalysis, omega sub-fractions, every hormone) is just as required as a flagged one — if it has a name and a value, include it. Lands straight in their health Records (Stand → Records) and feeds the marker trends. Never invent a value.`,
      `Preserve source units exactly as reported; do not convert US/SI/EU units yourself. Informational, not medical advice.`,
      `Do NOT use log_health for MRI, CT, X-ray, ultrasound, radiology, or any other imaging study. Direct the athlete to Stand → Records to upload the report or scan through the first-class imaging draft and confirmation flow.`,
      `NOTE: for a big pasted panel (dozens of markers), the paste box on Stand → Records is the more reliable, complete path — you may mention it in passing.`,
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
      `Set start/end dates ONLY when the user actually gave them. NEVER guess or approximate a date (don't turn "in November" into a specific day) — leave start_date/end_date null when you don't know. If the exact date matters (e.g. a race they're training for), record the event with null dates and ask them once, in one brief line, for the real date rather than inventing a placeholder.`,
    ],
  },
  resolve_context_event: {
    type: "resolve_context_event",
    applyMode: "immediate",
    shape: `{ "type": "resolve_context_event", "id": <existing context_event id from DATA.context_events>, "date": "YYYY-MM-DD|null" }`,
    guidance: [
      `resolve_context_event closes a healed injury / finished trip / passed life event on their timeline WITHOUT deleting it — it stays on record but stops making the plan work around it. Use it when the user confirms an injury/niggle is no longer bothering them (e.g. you gently asked about a past-window injury and they said it's fine). Only emit it for an id that is actually in DATA.context_events, and only when they've confirmed — never guess it's healed.`,
    ],
  },
  log_context_tag: {
    type: "log_context_tag",
    applyMode: "immediate",
    shape: `{ "type": "log_context_tag", "tags": ["${CONTEXT_TAG_VOCAB.map((t) => t.key).join('", "')}"], "date": "YYYY-MM-DD|omit" }`,
    guidance: [
      `log_context_tag tags TODAY (or a named day) with cheap, controlled-vocabulary life context — ${CONTEXT_TAG_VOCAB.map((t) => `${t.key} (${t.label})`).join(", ")}. It exists ONLY so the insight generator can later test outcomes against this context ("the mornings after travel ran a flatter HRV") and so a rough recovery reading with an overlapping tag reads as explained rather than concerning — it is NOT advice and NEVER produces a comment, warning, or lecture in your reply.`,
      `Use it when the athlete mentions something in this vocabulary in passing ("flying to Denver today", "drinks tonight", "brutal week at work", "slept on a friend's couch", "feeling a bit off") — tag it quietly and move on; do not ask follow-up questions just to fill a tag. tags MUST be keys from the vocabulary above verbatim — never invent a new key, and never use this for an injury, a trip needing dates, or anything add_context_event already covers (those stay on the timeline; a tag is same-day and disposable).`,
      `Omit "date" for today. Never say the tag was "logged" or "noted" in a way that reads as tracking/surveillance — a brief acknowledgment in the flow of the reply, if any, is enough.`,
    ],
  },
  log_supplement: {
    type: "log_supplement",
    applyMode: "immediate",
    shape: `// Supplement UNDERSTANDING (not a daily log). When the user mentions what they take
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
    shape: `{ "type": "log_measurement", "date": "YYYY-MM-DD|null", "unit": "in|cm", "waist_in": 34, "chest_in": 42, "upper_arm_in": 15,
      "hip_in": 40, "neck_in": 15.5, "shoulder_in": 50, "thigh_in": 24, "calf_in": 16, "forearm_in": 12,
      "height_in": 70, "note": "<optional>", "source": "chat" }`,
    guidance: [
      `log_measurement records at-home body measurements (tape/circumference) so the body picture — waist trend, BMI, waist-to-height, Navy body-fat estimate — stays current. Include only the sites they actually gave; the user can just say "waist 34, chest 42, arms 15" and it logs. Values default to inches; if the user speaks centimeters, pass their numbers as given with "unit": "cm" — the server converts, storage stays inches. "upper_arm_in" is the arm/bicep; only send "height_in" if they tell you their height (it updates the profile so BMI/body-fat light up; it follows "unit" too). Leave date null unless they name one.`,
    ],
  },
  report_training_symptom: {
    type: "report_training_symptom",
    applyMode: "immediate",
    shape: `{ "type": "report_training_symptom", "area_text": "left knee", "onset_on": "YYYY-MM-DD|omit" }`,
    guidance: [
      `Use report_training_symptom ONLY when the athlete explicitly asks Cairn to log, record, note, or track a training pain/ache area. A question, general discussion, or coach inference MUST NOT create a symptom record. This records what they said; never diagnose it or mark it resolved.`,
    ],
  },
  resolve_training_symptom: {
    type: "resolve_training_symptom",
    applyMode: "immediate",
    shape: `{ "type": "resolve_training_symptom", "area_text": "left knee", "on": "YYYY-MM-DD|omit" }`,
    guidance: [
      `Use resolve_training_symptom ONLY when the athlete tells you an open pain note is done — "my knee's fine now, close that", "the shoulder's healed". Name the AREA they named; the server closes the open record for that place and does nothing when none matches. Closing is their call: never infer it from a good session, a missing complaint, or your own read, and never diagnose. If they say it came back instead, that is not this action.`,
    ],
  },
  log_checkin: {
    type: "log_checkin",
    applyMode: "immediate",
    shape: `{ "type": "log_checkin", "energy": 1-5, "sleep_feel": 1-5, "soreness": 1-5, "mood": 1-5, "note": "<optional>", "date": "YYYY-MM-DD|omit" }`,
    guidance: [
      `Use log_checkin when the athlete tells you how they feel today or how a session felt — "I feel great", "I feel rough", "that session was hard". energy, sleep_feel, soreness, and mood are all 1 (low) to 5 (great) — the same scale the app writes. Omit any field they did not speak to; never guess a missing rating. A note is optional free text and is stored verbatim. date must be a real YYYY-MM-DD on or before today; omit it rather than inventing "yesterday" or a future day. This writes the same check-in the app does — absence of a check-in is silence.`,
    ],
  },
  flag_training_structure: {
    type: "flag_training_structure",
    applyMode: "immediate",
    shape: `{ "type": "flag_training_structure", "request": "<the athlete's own words, verbatim>", "summary": "<one short line naming the change they asked for>" }`,
    guidance: [
      `Use flag_training_structure when the athlete asks for a change to the SHAPE of their training that you cannot make from chat — which lifts the program is built around ("track all six of my anchors in parallel"), how the week is split, what the current block is for, adding or dropping a training day. You have no action that restructures a plan, so saying you will "flag it" or "pass it to your coach lane" without emitting this action leaves nothing behind at all — never promise the hand-off without it.`,
      `"request" MUST be the athlete's own sentence, copied verbatim — it is stored as the rationale the coach lane reads, so do not paraphrase, summarize or clean it up. "summary" is your own short third-person line naming the change ("Rebuild six anchor lifts in parallel"). Emit it only for an explicit ask from the athlete; a question about what they should do, or your own idea, is not one.`,
      `This records a proposal for the athlete to CONFIRM — it changes no plan by itself and is never applied automatically. Say so honestly: it is flagged and will come back as something to confirm, not "done" or "updated". When the same ask is already standing, re-flagging is harmless: the server points back at that one standing flag instead of stacking a second thing to confirm. A materially different ask is flagged on its own.`,
    ],
  },
  revert_decision: {
    type: "revert_decision",
    applyMode: "immediate",
    shape: `{ "type": "revert_decision", "id": <reversible id from DATA.recent_decisions>, "reason": "<what did not work>" }`,
    guidance: [
      `Only when the user directly says “put it back”, “undo/revert that”, “cancel/stop that scheduled change”, or explicitly asks to keep the current plan/split instead of its announced replacement, emit revert_decision with that exact reversible id from DATA.recent_decisions. A question, request for explanation, hypothetical about Undo, or “that didn't work for me” without a direct revert command is not authority to mutate. Never invent an id and never use this for a clinical observation.`,
    ],
  },
} as const satisfies { [K in ChatActionType]: ChatActionPromptSpec<K> };

export function chatActionPromptSpecs(): ChatActionPromptSpec[] {
  return CHAT_ACTION_TYPES.map((type) => CHAT_ACTION_PROMPT_SPECS[type]);
}

export function immediateChatActionTypes(): ChatActionType[] {
  return chatActionPromptSpecs()
    .filter((spec) => spec.applyMode === "immediate")
    .map((spec) => spec.type);
}

export function draftChatActionTypes(): ChatActionType[] {
  return chatActionPromptSpecs()
    .filter((spec) => spec.applyMode === "draft")
    .map((spec) => spec.type);
}

function renderActionGuidance(types: readonly ChatActionType[]): string {
  return types
    .flatMap((type) => (CHAT_ACTION_PROMPT_SPECS[type] as ChatActionPromptSpec).guidance ?? [])
    .map((line) => `- ${line}`)
    .join("\n");
}

export function renderChatActionSchema(types: readonly ChatActionType[] = CHAT_ACTION_TYPES): string {
  return `[
    // zero or more — ONLY when the user clearly asked to log or change something.
    ${types
      .map((type) => CHAT_ACTION_PROMPT_SPECS[type] as ChatActionPromptSpec)
      .map((spec) => spec.shape)
      .join(",\n    ")}
]`;
}

export function renderChatActionPromptProse(types: readonly ChatActionType[] = CHAT_ACTION_TYPES): string {
  const immediateTypes = types.filter(
    (type) => (CHAT_ACTION_PROMPT_SPECS[type] as ChatActionPromptSpec).applyMode === "immediate"
  );
  const draftTypes = types.filter(
    (type) => (CHAT_ACTION_PROMPT_SPECS[type] as ChatActionPromptSpec).applyMode === "draft"
  );
  const draftSection = draftTypes.length
    ? `\n- ${draftTypes.join(" and ")} are saved as DRAFTS for the user to review and apply — never assume they're live.\n${renderActionGuidance(draftTypes)}`
    : "";
  return `ACTIONS — only when the user clearly asks to log or change something:
- ${immediateTypes.join(", ")} are ROUTED immediately. Safe captures apply now; coached plan changes follow the server's apply/schedule/review autonomy result.
${renderActionGuidance(immediateTypes)}
${draftSection}
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

function clampChatScale(value: unknown, min: number, max: number): number | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// A check-in date is a real calendar YYYY-MM-DD on or before local today.
// "yesterday", "2026-13-99", and a future day are dropped so addCheckin
// falls through to today — otherwise they land in checkins.date forever
// invisible to getCheckinByDate.
export function chatCheckinDate(value: unknown, today: string = localDateISO()): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const [year, month, day] = raw.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return undefined;
  }
  if (raw > today) return undefined;
  return raw;
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
    case "set_training_intent":
      return Array.isArray(value.priorities) &&
        ["none", "supporting", "co_primary", "primary"].includes(String(value.endurance_role))
        ? {
            ...value,
            type: "set_training_intent",
            priorities: value.priorities,
            endurance_role: value.endurance_role as SetTrainingIntentAction["endurance_role"],
          }
        : null;
    case "set_endurance_goal":
      return { ...value, type: "set_endurance_goal" };
    case "set_strength_objective":
      return nonBlank(value.exercise) &&
        (value.target_kind === "return_to_personal_best" || value.target_kind === "explicit_est_1rm") &&
        (value.target_kind !== "explicit_est_1rm" ||
          (Number.isFinite(Number(value.target_est_1rm)) && Number(value.target_est_1rm) > 0))
        ? { ...value, type: "set_strength_objective", exercise: value.exercise, target_kind: value.target_kind }
        : null;
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
    case "log_weight": {
      const weightLb = Number(value.weight_lb);
      return Number.isFinite(weightLb) && weightLb >= 50 && weightLb <= 700
        ? { ...value, type: "log_weight", weight_lb: weightLb }
        : null;
    }
    case "plan_update": {
      const changes = arrayOrEmpty(value.changes);
      return changes.length ? { ...value, type: "plan_update", changes } : null;
    }
    case "plan_restructure": {
      const days = arrayOrEmpty(value.days);
      return days.length ? { ...value, type: "plan_restructure", days } : null;
    }
    case "set_run": {
      const dayNumber = Math.trunc(Number(value.day_number));
      if (!Number.isFinite(dayNumber) || dayNumber < 1) return null;
      const distance = positiveNumberOrNull(value.distance_km);
      const duration = positiveNumberOrNull(value.duration_min);
      const zone = normalizeRunZoneKey(value.zone);
      const kind = normalizeRunPrescriptionKind(value.kind);
      // A run edit that names nothing about the run is a no-op the apply path would
      // only record as a failure — drop it here instead of writing an empty ask.
      if (distance == null && duration == null && !zone && !nonBlank(value.label) && !kind) return null;
      return {
        ...value,
        type: "set_run",
        day_number: dayNumber,
        kind,
        distance_km: distance,
        duration_min: duration,
        zone,
      };
    }
    case "log_health": {
      const kind = normalizeChatLogHealthKind(value.kind);
      return kind ? { ...value, type: "log_health", kind } : null;
    }
    case "add_context_event":
      return nonBlank(value.kind) ? { ...value, type: "add_context_event", kind: value.kind } : null;
    case "resolve_context_event":
      return finiteId(value.id) ? { ...value, type: "resolve_context_event", id: value.id } : null;
    case "log_context_tag": {
      const tags = arrayOrEmpty(value.tags).filter(isContextTagKey);
      return tags.length ? { ...value, type: "log_context_tag", tags } : null;
    }
    case "log_supplement": {
      const items = Array.isArray(value.items) ? value.items.filter(isRecord) : undefined;
      return items?.length ? { ...value, type: "log_supplement", items } : { ...value, type: "log_supplement" };
    }
    case "log_measurement":
      // Keep it only when at least one measurable field (a *_in site or height) is present —
      // an empty measurement is a no-op the apply path would just record as ok:false.
      return MEASUREMENT_ACTION_FIELDS.some((k) => value[k] != null && value[k] !== "")
        ? { ...value, type: "log_measurement" }
        : null;
    case "report_training_symptom":
      return nonBlank(value.area_text) && value.area_text.trim().length <= SYMPTOM_AREA_INPUT_MAX
        ? { ...value, type: "report_training_symptom", area_text: value.area_text.trim() }
        : null;
    case "resolve_training_symptom":
      return nonBlank(value.area_text) && value.area_text.trim().length <= SYMPTOM_AREA_INPUT_MAX
        ? { ...value, type: "resolve_training_symptom", area_text: value.area_text.trim() }
        : null;
    case "log_checkin": {
      const energy = clampChatScale(value.energy, 1, 5);
      const sleepFeel = clampChatScale(value.sleep_feel, 1, 5);
      const soreness = clampChatScale(value.soreness, 1, 5);
      const mood = clampChatScale(value.mood, 1, 5);
      const note = nonBlank(value.note) ? value.note.trim() : null;
      if (energy == null && sleepFeel == null && soreness == null && mood == null && !note) return null;
      return {
        ...value,
        type: "log_checkin",
        energy,
        sleep_feel: sleepFeel,
        soreness,
        mood,
        note,
        date: chatCheckinDate(value.date),
      };
    }
    case "flag_training_structure": {
      // The athlete's words are the payload: an empty or whitespace request has
      // nothing to route, and a whole transcript pasted into it is not a request.
      const request = nonBlank(value.request) ? value.request.trim().slice(0, TRAINING_STRUCTURE_REQUEST_MAX) : null;
      if (!request) return null;
      const summary = nonBlank(value.summary) ? value.summary.trim().slice(0, 200) : null;
      return { ...value, type: "flag_training_structure", request, summary };
    }
    case "revert_decision":
      return finiteId(value.id) ? { ...value, type: "revert_decision", id: value.id } : null;
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
