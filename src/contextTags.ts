// The context-tags contract (WHOOP-journal pattern, Cairn-shaped): a small
// controlled vocabulary of cheap, athlete-volunteered life context — travel,
// alcohol, a rough sleep environment, a work crunch, feeling off — that the
// insight generator and the confounder machinery quietly test against outcomes.
// ONE contract shared by chat (log_context_tag), the one-tap Today chips, and
// the repo layer that persists them as context_events (kind:'tag', title:<key>).
// Never re-declare this list anywhere else.
export interface ContextTagDef {
  key: string;
  label: string; // athlete-facing chip / chat label — never engineering vocabulary
}

export const CONTEXT_TAG_VOCAB: ContextTagDef[] = [
  { key: "travel", label: "travel" },
  { key: "alcohol", label: "drinks" },
  { key: "poor_sleep_env", label: "rough sleep setup" },
  { key: "work_crunch", label: "work crunch" },
  { key: "illness_feel", label: "feeling off" },
];

export type ContextTagKey = (typeof CONTEXT_TAG_VOCAB)[number]["key"];

const CONTEXT_TAG_KEY_SET = new Set<string>(CONTEXT_TAG_VOCAB.map((t) => t.key));
const CONTEXT_TAG_LABEL: Record<string, string> = Object.fromEntries(
  CONTEXT_TAG_VOCAB.map((t) => [t.key, t.label])
);

export function isContextTagKey(key: unknown): key is string {
  return typeof key === "string" && CONTEXT_TAG_KEY_SET.has(key);
}

export function contextTagLabel(key: string): string {
  return CONTEXT_TAG_LABEL[key] ?? key;
}
