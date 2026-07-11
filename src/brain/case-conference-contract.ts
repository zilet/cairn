import {
  asRecord,
  cleanText,
  enumValue,
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
  resolved_conflicts: Array<{ key: string; resolution: string }>;
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
  const conflicts: Array<{ key: string; resolution: string }> = [];
  for (const item of Array.isArray(input.resolved_conflicts) ? input.resolved_conflicts.slice(0, 12) : []) {
    const row = asRecord(item);
    const key = cleanText(row?.key, 100);
    const resolution = cleanText(row?.resolution, 500);
    if (key && resolution) conflicts.push({ key, resolution });
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
