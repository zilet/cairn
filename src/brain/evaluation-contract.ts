import {
  asRecord,
  cleanIdentifier,
  cleanText,
  enumValue,
  hasOwnProperties,
  isoDateTime,
  normalizeJsonObject,
  normalizeStringList,
  positiveInteger,
  type JsonObject,
} from "./contract-utils.js";

export const BRAIN_EVALUATION_VERDICTS = ["aligned", "not_aligned", "inconclusive", "canceled"] as const;
export type BrainEvaluationVerdict = (typeof BRAIN_EVALUATION_VERDICTS)[number];

export interface BrainEvaluation {
  id?: number;
  expectation_id: number;
  evaluated_at?: string;
  verdict: BrainEvaluationVerdict;
  actual: JsonObject | null;
  evidence_keys: string[];
  confounders: string[];
  explanation: string;
  evaluator_version: string;
}

export function normalizeBrainEvaluation(value: unknown): BrainEvaluation | null {
  const input = asRecord(value);
  if (!input) return null;
  const expectationId = positiveInteger(input.expectation_id);
  const verdict = enumValue(input.verdict, BRAIN_EVALUATION_VERDICTS);
  const explanation = cleanText(input.explanation, 1_000);
  const evaluatorVersion = cleanIdentifier(input.evaluator_version, 80);
  if (!expectationId || !verdict || !explanation || !evaluatorVersion) return null;

  const id = input.id == null ? undefined : positiveInteger(input.id);
  const evaluatedAt = input.evaluated_at == null ? undefined : isoDateTime(input.evaluated_at);
  if ((input.id != null && !id) || (input.evaluated_at != null && !evaluatedAt)) return null;

  const evidenceKeys = normalizeStringList(input.evidence_keys, { maxItems: 30, maxLength: 160 });
  if ((verdict === "aligned" || verdict === "not_aligned") && evidenceKeys.length === 0) return null;

  return {
    ...(id ? { id } : {}),
    expectation_id: expectationId,
    ...(evaluatedAt ? { evaluated_at: evaluatedAt } : {}),
    verdict,
    actual: input.actual == null ? null : normalizeJsonObject(input.actual),
    evidence_keys: evidenceKeys,
    confounders: normalizeStringList(input.confounders, { maxItems: 20, maxLength: 200 }),
    explanation,
    evaluator_version: evaluatorVersion,
  };
}

export function isBrainEvaluation(value: unknown): value is BrainEvaluation {
  const input = asRecord(value);
  return (
    !!input &&
    normalizeBrainEvaluation(value) !== null &&
    hasOwnProperties(input, [
      "expectation_id",
      "verdict",
      "actual",
      "evidence_keys",
      "confounders",
      "explanation",
      "evaluator_version",
    ])
  );
}
