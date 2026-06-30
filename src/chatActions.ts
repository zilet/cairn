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
  "log_supplement",
] as const;

export type ChatActionType = typeof CHAT_ACTION_TYPES[number];

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

export interface LogSupplementAction extends ChatActionBase {
  type: "log_supplement";
  items?: ChatActionRecord[];
  text?: unknown;
  summary?: unknown;
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
  | LogSupplementAction;

const CHAT_ACTION_TYPE_SET = new Set<string>(CHAT_ACTION_TYPES);

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
    case "log_supplement": {
      const items = Array.isArray(value.items) ? value.items.filter(isRecord) : undefined;
      return items?.length
        ? { ...value, type: "log_supplement", items }
        : { ...value, type: "log_supplement" };
    }
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
