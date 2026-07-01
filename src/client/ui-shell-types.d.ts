// Erased declarations for 02-ui.js. Keep executable shell behavior in ui-shell.ts.

type UiRecord = Record<string, unknown>;
type UiSegment = readonly [string, string];
type ToastOptions = { action?: string; onAction?: () => void };
type BusyButton = HTMLButtonElement & { _busyRestore?: (() => void) | null };
type UiWiredElement = Element & { _wired?: boolean };
type ExerciseSetRow = UiRecord & {
  date?: string;
  duration_sec?: number | string | null;
  weight?: number | string | null;
  reps?: number | string | null;
  rir?: number | string | null;
  pr?: boolean;
};
type ExerciseProgressPoint = UiRecord & { best1rm?: number | string | null };
type ExercisePlanAppearance = UiRecord & { day_number?: number | string; day_name?: string };
type UiExerciseExplanationPayload = { setup?: unknown; move?: unknown; feel?: unknown; avoid?: unknown };
type ExerciseDetailRow = UiRecord & {
  found?: boolean;
  name?: string;
  muscle_group?: string;
  mode?: string;
  unit?: string;
  recent?: ExerciseSetRow[];
  progress?: { points?: ExerciseProgressPoint[] };
  appears?: ExercisePlanAppearance[];
  constraint_note?: string;
  cues?: string;
};
type UiFoodIngredientRow = UiRecord & {
  item?: string;
  amount?: string;
};
type UiFoodParsedNote = UiRecord & {
  summary?: string;
  kcal?: unknown;
  protein_g?: unknown;
  carbs_g?: unknown;
  fat_g?: unknown;
  fiber_g?: unknown;
  notes?: string;
};
type UiFoodNoteRow = UiRecord & {
  id?: string | number;
  raw?: string;
  raw_text?: string;
  raw_output?: string;
  created_at?: string;
};
type PollEnrichmentOptions<T extends UiRecord = UiRecord> = {
  tab?: ClientTabName | string;
  token?: number;
  onUpdate?: (row: T) => void;
  tries?: number;
  interval?: number;
};
