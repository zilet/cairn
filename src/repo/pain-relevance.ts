import { canonicalGroup, resolveGroup, type MuscleGroup } from "./exercise-canon.js";
import { isRecognizedSymptomArea, SYMPTOM_AREA_MAX } from "./symptom-area.js";

// Free-text pain area → canonical groups and movement names that plausibly load
// it. This is a conservative relevance check, not a diagnosis: unmapped text
// returns false rather than making every lift look symptomatic.
const JOINT_GROUP_MAP: Array<{ re: RegExp; groups: MuscleGroup[] }> = [
  { re: /knee/, groups: ["quads", "hamstrings", "calves"] },
  { re: /shoulder|delt|rotator|\bac\b/, groups: ["chest", "shoulders", "rear delts"] },
  { re: /elbow|cubital|forearm|\bwrist/, groups: ["biceps", "triceps", "forearms", "back"] },
  { re: /lower ?back|lumbar|\bback\b|spine|\bsi\b|sacro/, groups: ["back", "hamstrings", "quads"] },
  { re: /\bhip\b|groin|glute/, groups: ["glutes", "hamstrings", "quads"] },
  { re: /ankle|achilles|\bcalf\b|\bfoot\b|shin|tib/, groups: ["calves", "quads"] },
];

const JOINT_MOVEMENT_MAP: Array<{ re: RegExp; movements: RegExp }> = [
  { re: /knee/, movements: /\b(squat|lunge|leg press|leg extension|step[ -]?up|calf)\b/ },
  {
    re: /shoulder|delt|rotator|\bac\b/,
    movements: /\b(press|bench|push[ -]?up|dip|fly|lateral raise|row|pull[ -]?(?:up|down))\b/,
  },
  {
    re: /elbow|cubital|forearm|\bwrist/,
    movements: /\b(press|bench|pushdown|extension|curl|row|pull[ -]?(?:up|down)|chin[ -]?up|dip)\b/,
  },
  { re: /chest|pec|sternum|\brib\b/, movements: /\b(press|bench|push[ -]?up|dip|fly)\b/ },
  {
    re: /lower ?back|lumbar|\bback\b|spine|\bsi\b|sacro/,
    movements: /\b(deadlift|hinge|squat|row|good morning|back extension)\b/,
  },
  { re: /\bhip\b|groin|glute/, movements: /\b(squat|lunge|deadlift|hinge|hip thrust|step[ -]?up)\b/ },
  { re: /ankle|achilles|\bcalf\b|\bfoot\b|shin|tib/, movements: /\b(calf|squat|lunge|step[ -]?up|run|jump)\b/ },
];

// The gate that makes this file's promise true. These maps run SUBSTRING regexes,
// so anything longer than a label matches half of them at once: a coach paragraph
// containing "back", "press" and "row" would load nearly every lift and mark every
// outcome non-comparable forever. Relevance therefore requires a real area label —
// short, and naming a place Cairn recognizes. Anything else matches nothing.
function areaCanDriveRelevance(text: string): boolean {
  if (!text || text.length > SYMPTOM_AREA_MAX) return false;
  return isRecognizedSymptomArea(text) || canonicalGroup(text) != null;
}

export function painAreaLoadsGroup(painText: string, group: MuscleGroup | null): boolean {
  if (!group) return false;
  const text = String(painText || "").trim().toLowerCase();
  if (!areaCanDriveRelevance(text)) return false;
  return JOINT_GROUP_MAP.some((entry) => entry.re.test(text) && entry.groups.includes(group));
}

// Canonical muscle groups loaded by a named joint/body area. Structured injury
// labels and free-text session feedback must cross the same conservative map.
export function muscleGroupsForPainArea(value: string | null | undefined): MuscleGroup[] {
  const text = String(value ?? "").trim().toLowerCase();
  if (!areaCanDriveRelevance(text)) return [];
  const direct = canonicalGroup(text);
  const groups = direct ? [direct] : [];
  for (const entry of JOINT_GROUP_MAP) {
    if (entry.re.test(text)) groups.push(...entry.groups);
  }
  return [...new Set(groups)];
}

export function painAreaLoadsExercise(
  painText: string | null | undefined,
  exercise: { name?: string | null; muscle_group?: string | null }
): boolean {
  const text = String(painText ?? "").trim().toLowerCase();
  if (!areaCanDriveRelevance(text)) return false;
  const group = resolveGroup(exercise.muscle_group ?? "", exercise.name ?? "");
  if (painAreaLoadsGroup(text, group)) return true;
  const name = String(exercise.name ?? "").toLowerCase();
  return JOINT_MOVEMENT_MAP.some((entry) => entry.re.test(text) && entry.movements.test(name));
}
