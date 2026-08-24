import {
  asRecord,
  cleanIdentifier,
  cleanText,
  enumValue,
  hasOwnProperties,
  normalizeJsonObject,
  normalizeStringList,
  type JsonObject,
} from "./contract-utils.js";
import { AUTONOMY_TIERS, BRAIN_DECISION_KINDS, BRAIN_DOMAINS, BRAIN_RISK_CLASSES } from "./decision-contract.js";
import { normalizeProposedExpectation, type ProposedExpectation } from "./expectation-contract.js";

export interface CaseConferenceDecision {
  kind: (typeof BRAIN_DECISION_KINDS)[number];
  domain: (typeof BRAIN_DOMAINS)[number];
  summary: string;
  rationale: string;
  risk_class: (typeof BRAIN_RISK_CLASSES)[number];
  reversible: boolean;
  autonomy_tier: (typeof AUTONOMY_TIERS)[number];
  parallel_actions: string[];
  // A resolution CITES: `evidence_key` names a key from the opinion of a
  // specialist party to the conflict, and the server checks it (see
  // citedConflictResolutions). Kept optional at the contract boundary so an
  // uncited claim degrades to "unresolved" rather than voiding the whole
  // decision; a legacy `string[]` payload normalizes away entirely, which is
  // the same safe direction.
  resolved_conflicts: Array<{ key: string; evidence_key: string | null; resolution: string }>;
  deferred: string[];
  expectations: ProposedExpectation[];
  review_window: string;
  user_explanation: string;
  revision: CaseConferenceRevision | null;
}

export type CaseConferenceRevision =
  | { type: "plan_update"; summary: string | null; changes: JsonObject[] }
  | { type: "plan_restructure"; summary: string | null; days: JsonObject[] }
  | {
      type: "nutrition_target";
      summary: string | null;
      nutrition: {
        target_kcal: number;
        protein_g: number;
        carbs_g: number | null;
        fat_g: number | null;
        delta_kcal: number | null;
      };
      notes: string | null;
    };

function normalizedRevision(value: unknown): CaseConferenceRevision | null {
  const input = asRecord(value);
  if (!input) return null;
  const summary = cleanText(input.summary, 300);
  if (input.type === "plan_update") {
    const changes = (Array.isArray(input.changes) ? input.changes : [])
      .slice(0, 24)
      .map(normalizeJsonObject)
      .filter((item): item is JsonObject => {
        if (!item) return false;
        const day = Number(item.day_number);
        const hasSubject =
          cleanText(item.exercise, 160) != null || item.kind === "cardio" || normalizeJsonObject(item.swap) != null;
        return Number.isInteger(day) && day > 0 && day <= 14 && hasSubject;
      });
    return changes.length ? { type: "plan_update", summary, changes } : null;
  }
  if (input.type === "plan_restructure") {
    const days = (Array.isArray(input.days) ? input.days : [])
      .slice(0, 14)
      .map(normalizeJsonObject)
      .filter((item): item is JsonObject => {
        if (!item) return false;
        const day = Number(item.day_number);
        return (
          Number.isInteger(day) &&
          day > 0 &&
          day <= 14 &&
          cleanText(item.name, 160) != null &&
          Array.isArray(item.items)
        );
      });
    return days.length ? { type: "plan_restructure", summary, days } : null;
  }
  if (input.type === "nutrition_target") {
    const nutrition = asRecord(input.nutrition);
    const targetKcal = Number(nutrition?.target_kcal);
    const protein = Number(nutrition?.protein_g);
    if (!Number.isFinite(targetKcal) || targetKcal < 1_200 || targetKcal > 10_000) return null;
    if (!Number.isFinite(protein) || protein < 0 || protein > 500) return null;
    const optional = (value: unknown, max: number): number | null => {
      if (value == null || value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.round(number))) : null;
    };
    const delta = Number(nutrition?.delta_kcal);
    return {
      type: "nutrition_target",
      summary,
      nutrition: {
        target_kcal: Math.round(targetKcal),
        protein_g: Math.round(protein),
        carbs_g: optional(nutrition?.carbs_g, 2_000),
        fat_g: optional(nutrition?.fat_g, 1_000),
        delta_kcal: Number.isFinite(delta) ? Math.max(-500, Math.min(500, Math.round(delta))) : null,
      },
      notes: cleanText(input.notes, 500),
    };
  }
  return null;
}

function ownKeysAllowed(input: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(input).every((key) => set.has(key));
}

function nullableString(value: unknown): boolean {
  return value == null || typeof value === "string";
}

function nullableBoundedFinite(value: unknown, min: number, max: number): boolean {
  return value == null || (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max);
}

function nullableInteger(value: unknown, min: number, max: number): boolean {
  return value == null || (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max);
}

const PLAN_CHANGE_KEYS = [
  "day_number",
  "exercise",
  "remove",
  "target_weight",
  "target_seconds",
  "sets",
  "rep_low",
  "rep_high",
  "reason",
  "note",
  "mode",
  "swap",
] as const;

function strictPlanChange(value: unknown): JsonObject | null {
  const input = asRecord(value);
  if (!input || !ownKeysAllowed(input, PLAN_CHANGE_KEYS)) return null;
  if (typeof input.day_number !== "number" || !Number.isInteger(input.day_number)) return null;
  if (input.day_number < 1 || input.day_number > 14) return null;
  if (input.exercise != null && (typeof input.exercise !== "string" || !input.exercise.trim())) return null;
  if (input.remove != null && typeof input.remove !== "boolean") return null;
  if (!nullableBoundedFinite(input.target_weight, 0, 5_000)) return null;
  if (!nullableInteger(input.target_seconds, 1, 3_600)) return null;
  if (!nullableInteger(input.sets, 0, 20)) return null;
  if (!nullableInteger(input.rep_low, 1, 100) || !nullableInteger(input.rep_high, 1, 100)) return null;
  if (typeof input.rep_low === "number" && typeof input.rep_high === "number" && input.rep_low > input.rep_high)
    return null;
  if (!nullableString(input.reason) || !nullableString(input.note)) return null;
  if (input.mode != null && input.mode !== "reps" && input.mode !== "timed") return null;
  const swap = input.swap == null ? null : asRecord(input.swap);
  if (input.swap != null) {
    if (!swap || !ownKeysAllowed(swap, ["from", "to"]) || !hasOwnProperties(swap, ["from", "to"])) return null;
    if (typeof swap.from !== "string" || !swap.from.trim() || typeof swap.to !== "string" || !swap.to.trim())
      return null;
  }
  if (!(typeof input.exercise === "string" && input.exercise.trim()) && !swap) return null;
  if (input.mode === "timed" && (input.target_weight != null || input.rep_low != null || input.rep_high != null))
    return null;
  if (input.mode === "reps" && input.target_seconds != null) return null;
  return normalizeJsonObject(input);
}

const PLAN_ITEM_KEYS = [
  "exercise",
  "sets",
  "rep_low",
  "rep_high",
  "target_weight",
  "note",
  "warmup_sets",
  "target_seconds",
  "superset_group",
  "mode",
  "kind",
  "target_distance_km",
  "target_duration_min",
  "target_zone",
  "interval",
  "interval_json",
] as const;

function strictPlanItem(value: unknown): boolean {
  const input = asRecord(value);
  if (!input || !ownKeysAllowed(input, PLAN_ITEM_KEYS)) return false;
  const kind = input.kind == null ? "strength" : input.kind;
  if (kind !== "strength" && kind !== "cardio") return false;
  if (!nullableString(input.exercise) || !nullableString(input.note) || !nullableString(input.target_zone))
    return false;
  if (!nullableInteger(input.sets, 1, 20)) return false;
  if (!nullableInteger(input.rep_low, 1, 100) || !nullableInteger(input.rep_high, 1, 100)) return false;
  if (typeof input.rep_low === "number" && typeof input.rep_high === "number" && input.rep_low > input.rep_high)
    return false;
  if (!nullableBoundedFinite(input.target_weight, 0, 5_000)) return false;
  if (!nullableInteger(input.warmup_sets, 0, 20)) return false;
  if (!nullableInteger(input.target_seconds, 1, 3_600)) return false;
  if (!nullableInteger(input.superset_group, 1, 100)) return false;
  if (input.mode != null && input.mode !== "reps" && input.mode !== "timed") return false;
  if (!nullableBoundedFinite(input.target_distance_km, 0, 1_000)) return false;
  if (!nullableBoundedFinite(input.target_duration_min, 0, 1_440)) return false;
  if (input.interval != null && !asRecord(input.interval)) return false;
  if (input.interval_json != null) {
    if (typeof input.interval_json !== "string") return false;
    try {
      JSON.parse(input.interval_json);
    } catch {
      return false;
    }
  }
  if (kind === "cardio") {
    if (input.mode != null || input.target_weight != null || input.target_seconds != null) return false;
    if (input.rep_low != null || input.rep_high != null || input.warmup_sets != null) return false;
    return true;
  }
  if (typeof input.exercise !== "string" || !input.exercise.trim()) return false;
  if (input.mode === "timed" && (input.target_weight != null || input.rep_low != null || input.rep_high != null))
    return false;
  if (input.mode === "reps" && input.target_seconds != null) return false;
  return true;
}

function strictPlanDay(value: unknown): JsonObject | null {
  const input = asRecord(value);
  if (!input || !ownKeysAllowed(input, ["day_number", "name", "focus", "items"])) return null;
  if (!hasOwnProperties(input, ["day_number", "name", "items"])) return null;
  if (typeof input.day_number !== "number" || !Number.isInteger(input.day_number)) return null;
  if (input.day_number < 1 || input.day_number > 14) return null;
  if (typeof input.name !== "string" || !input.name.trim()) return null;
  if (!nullableString(input.focus) || !Array.isArray(input.items) || !input.items.every(strictPlanItem)) return null;
  return normalizeJsonObject(input);
}

function strictRevision(value: unknown): CaseConferenceRevision | null {
  const input = asRecord(value);
  const normalized = normalizedRevision(value);
  if (!input || !normalized) return null;
  if (!hasOwnProperties(input, ["type", "summary"])) return null;
  if (input.summary != null && typeof input.summary !== "string") return null;
  if (input.type === "plan_update") {
    if (!ownKeysAllowed(input, ["type", "summary", "changes"])) return null;
    if (!hasOwnProperties(input, ["changes"])) return null;
    if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 24) return null;
    const changes = input.changes.map(strictPlanChange);
    if (changes.some((change) => change === null) || normalized.type !== "plan_update") return null;
    return { ...normalized, changes: changes as JsonObject[] };
  }
  if (input.type === "plan_restructure") {
    if (!ownKeysAllowed(input, ["type", "summary", "days"])) return null;
    if (!hasOwnProperties(input, ["days"])) return null;
    if (!Array.isArray(input.days) || !input.days.length || input.days.length > 14) return null;
    const days = input.days.map(strictPlanDay);
    if (days.some((day) => day === null) || normalized.type !== "plan_restructure") return null;
    return { ...normalized, days: days as JsonObject[] };
  }
  if (input.type === "nutrition_target") {
    const nutrition = asRecord(input.nutrition);
    if (!ownKeysAllowed(input, ["type", "summary", "nutrition", "notes"])) return null;
    if (!hasOwnProperties(input, ["nutrition", "notes"])) return null;
    if (!nutrition || normalized.type !== "nutrition_target") return null;
    if (!ownKeysAllowed(nutrition, ["target_kcal", "protein_g", "carbs_g", "fat_g", "delta_kcal"])) return null;
    if (!hasOwnProperties(nutrition, ["target_kcal", "protein_g", "carbs_g", "fat_g", "delta_kcal"])) return null;
    if (typeof nutrition.target_kcal !== "number" || !Number.isFinite(nutrition.target_kcal)) return null;
    if (typeof nutrition.protein_g !== "number" || !Number.isFinite(nutrition.protein_g)) return null;
    for (const key of ["carbs_g", "fat_g", "delta_kcal"] as const) {
      if (nutrition[key] != null && (typeof nutrition[key] !== "number" || !Number.isFinite(nutrition[key])))
        return null;
    }
    if (input.notes != null && typeof input.notes !== "string") return null;
    return normalized;
  }
  return null;
}

export function normalizeCaseConferenceDecision(value: unknown): CaseConferenceDecision | null {
  const input = asRecord(value);
  if (!input) return null;
  const kind = enumValue(input.kind, BRAIN_DECISION_KINDS);
  const domain = enumValue(input.domain, BRAIN_DOMAINS);
  const riskClass = enumValue(input.risk_class, BRAIN_RISK_CLASSES);
  const autonomyTier = enumValue(input.autonomy_tier, AUTONOMY_TIERS);
  const summary = cleanText(input.summary, 300);
  const rationale = cleanText(input.rationale, 1_500);
  const reviewWindow = cleanText(input.review_window, 200);
  const userExplanation = cleanText(input.user_explanation, 700);
  if (
    !kind ||
    !domain ||
    !riskClass ||
    !autonomyTier ||
    !summary ||
    !rationale ||
    !reviewWindow ||
    !userExplanation ||
    typeof input.reversible !== "boolean"
  )
    return null;
  const conflicts: Array<{ key: string; evidence_key: string | null; resolution: string }> = [];
  for (const item of Array.isArray(input.resolved_conflicts) ? input.resolved_conflicts.slice(0, 12) : []) {
    const row = asRecord(item);
    const key = cleanIdentifier(row?.key, 100);
    const resolution = cleanText(row?.resolution, 500);
    // Normalized through the SAME function as the keys it will be compared
    // against: normalizeSpecialistOpinion runs evidence_keys through
    // cleanText(item, 160), which truncates at a word boundary and appends an
    // ellipsis, while cleanIdentifier hard-slices. A key longer than 160 chars
    // would then never compare equal to its own citation, leaving the conflict
    // unclosable through no fault of the conductor.
    const evidenceKey = cleanText(row?.evidence_key, 160);
    if (key && resolution) conflicts.push({ key, evidence_key: evidenceKey, resolution });
  }
  const expectations: ProposedExpectation[] = [];
  for (const item of Array.isArray(input.expectations) ? input.expectations.slice(0, 10) : []) {
    const normalized = normalizeProposedExpectation(item);
    if (normalized) expectations.push(normalized);
  }
  return {
    kind,
    domain,
    summary,
    rationale,
    risk_class: riskClass,
    reversible: input.reversible,
    autonomy_tier: autonomyTier,
    parallel_actions: normalizeStringList(input.parallel_actions, { maxItems: 10, maxLength: 400 }),
    resolved_conflicts: conflicts,
    deferred: normalizeStringList(input.deferred, { maxItems: 10, maxLength: 400 }),
    expectations,
    review_window: reviewWindow,
    user_explanation: userExplanation,
    revision: input.revision == null ? null : normalizedRevision(input.revision),
  };
}

/** Conductor boundary: case-conference kind and every non-null nested revision
 * must satisfy its typed shape. The general normalizer remains intentionally
 * tolerant for historical stored rows, but an agent may not turn malformed
 * executable intent into an apparently valid advice-only decision. */
export function normalizeStrictCaseConferenceDecision(value: unknown): CaseConferenceDecision | null {
  const input = asRecord(value);
  if (!input || input.kind !== "case_conference") return null;
  if (
    !hasOwnProperties(input, [
      "kind",
      "domain",
      "summary",
      "rationale",
      "risk_class",
      "reversible",
      "autonomy_tier",
      "parallel_actions",
      "resolved_conflicts",
      "deferred",
      "expectations",
      "review_window",
      "user_explanation",
      "revision",
    ]) ||
    !Array.isArray(input.parallel_actions) ||
    !Array.isArray(input.resolved_conflicts) ||
    !Array.isArray(input.deferred) ||
    !Array.isArray(input.expectations)
  )
    return null;
  if (input.revision !== null && strictRevision(input.revision) === null) return null;
  const normalized = normalizeCaseConferenceDecision(value);
  if (!normalized || normalized.kind !== "case_conference") return null;
  if (normalized.resolved_conflicts.length !== input.resolved_conflicts.length) return null;
  if (normalized.expectations.length !== input.expectations.length) return null;
  return input.revision === null ? normalized : { ...normalized, revision: strictRevision(input.revision) };
}
