// Semantic acceptance contracts for agent-produced intelligence.
//
// Parsing JSON only proves syntax. These predicates define the smallest useful
// shape each operation must produce before the shared rotation may stop. They do
// not persist or apply anything. Session suggestions are the deliberate
// exception to boolean-only validation: they normalize at acceptance so the
// actionable preview is already identical to the later durable snapshot.
//
// STRUCTURE IS DECLARED ONCE. The `*_SCHEMA` constants below are ordinary JSON
// Schema, and they are used for two things at once: `runChosen(..., { schema })`
// hands one to a CLI that can ENFORCE it (agents.json `structured_output`), and the
// matching predicate below runs the SAME object through matchesJsonSchema as its
// structural conjunct. So the enforced schema and the accepted shape are the same
// artifact by construction — there is no second description to drift.
//
// Two rules keep that safe:
//   1. Every object node declares `additionalProperties: true`. Constrained decoding
//      SILENTLY DROPS any field a schema does not mention (verified live against
//      claude 2.1.220 and grok 0.2.112), and these payloads carry far more fields
//      than acceptance checks — `reason`, `notes`, `superset_group`, `interval`, the
//      whole cardio field set. A closed schema would quietly amputate them.
//   2. A schema constrains STRUCTURE only. Anything JSON Schema cannot state — "at
//      least one of changes/cardio/days", non-blank after trimming, cross-field
//      agreement — stays in the predicate as a residual check after the schema.

import { type JsonSchema, matchesJsonSchema } from "./json-schema.js";
import { assessMealPlanAdequacy } from "./repo/nutrition-safety.js";
import { reasonHasHistoricalReference, validReasonProvenance } from "./repo/proposal-truth.js";
import {
  DAILY_SESSION_SUGGESTION_NORMALIZATION,
  normalizeSessionSuggestionResult,
} from "./repo/adaptive-session.js";

export { DAILY_SESSION_SUGGESTION_NORMALIZATION, normalizeSessionSuggestionResult };

type JsonObject = Record<string, any>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function text(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): boolean {
  return Number.isFinite(Number(value));
}

function positive(value: unknown): boolean {
  return finite(value) && Number(value) > 0;
}

export function isSessionSuggestionResult(value: unknown): boolean {
  return normalizeSessionSuggestionResult(value) != null;
}

// The propose/apply payload (src/prompt/coach.ts PLAN_SCHEMA is its prose twin).
// Numeric slots stay open to null where null is MEANINGFUL — target_weight null is
// bodyweight and a negative target_weight is an assisted movement, so neither slot
// carries a `minimum`.
//
// EVERY FIELD THE PROSE TWIN SOLICITS IS NAMED HERE, and that is a hard requirement,
// not tidiness. `additionalProperties: true` only PERMITS an unnamed field; it does not
// make the model emit one. Measured live against claude 2.1.220 with an open node: on a
// cardio item the model kept target_distance_km and target_duration_min but DROPPED
// target_zone, and dropped muscle_group on a strength item — folding both into `note`
// as "target_zone: Z2, conversational pace". Constrained decoding steers toward the
// named slots, so an unnamed-but-consumed field is silent data loss in an APPLIED plan,
// not a rejected payload. When you add a field to the prose contract, add it here.
const RUN_INTERVAL_SCHEMA: JsonSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: true,
    properties: {
      reps: { type: ["integer", "null"], minimum: 0 },
      on: { type: ["string", "null"] },
      off: { type: ["string", "null"] },
      zone: { type: ["string", "null"] },
    },
  },
};

// The cardio prescription field set, shared by a `cardio[]` entry and a `changes[]`
// entry carrying kind:"cardio" (which profile.ts routes through the SAME
// toRunPrescription mapper, so it must offer the same slots).
const RUN_PRESCRIPTION_PROPERTIES: Record<string, JsonSchema> = {
  label: { type: "string" },
  exercise: { type: "string" },
  target_distance_km: { type: ["number", "null"], minimum: 0 },
  target_duration_min: { type: ["number", "null"], minimum: 0 },
  target_zone: { type: ["string", "null"] },
  day_name: { type: ["string", "null"] },
  focus: { type: ["string", "null"] },
  interval: RUN_INTERVAL_SCHEMA,
};

const REASON_PROVENANCE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["reason_code", "evidence_date", "as_of_date"],
  properties: {
    reason_code: { type: "string", minLength: 1 },
    evidence_date: { type: "string", minLength: 10 },
    as_of_date: { type: "string", minLength: 10 },
    source_ref_type: { type: ["string", "null"] },
    source_ref_key: { type: ["string", "null"] },
  },
};

const PLAN_CHANGE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["day_number"],
  properties: {
    day_number: { type: "integer", minimum: 1 },
    exercise: { type: "string" },
    swap: {
      type: "object",
      additionalProperties: true,
      required: ["from", "to"],
      properties: { from: { type: "string" }, to: { type: "string" } },
    },
    remove: { type: "boolean" },
    sets: { type: ["integer", "null"], minimum: 0 },
    rep_low: { type: ["integer", "null"], minimum: 0 },
    rep_high: { type: ["integer", "null"], minimum: 0 },
    target_weight: { type: ["number", "null"] },
    target_seconds: { type: ["number", "null"], minimum: 0 },
    mode: { type: ["string", "null"] },
    reason: { type: "string" },
    reason_provenance: REASON_PROVENANCE_SCHEMA,
    note: { type: ["string", "null"] },
    // kind:"cardio" reroutes this entry to the run prescription mapper.
    kind: { type: "string" },
    ...RUN_PRESCRIPTION_PROPERTIES,
  },
};

const PLAN_CARDIO_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["day_number", "label"],
  properties: {
    day_number: { type: "integer", minimum: 1 },
    reason: { type: "string" },
    reason_provenance: REASON_PROVENANCE_SCHEMA,
    note: { type: ["string", "null"] },
    ...RUN_PRESCRIPTION_PROPERTIES,
    label: { type: "string", minLength: 1 },
  },
};

export const PLAN_PROPOSAL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["summary"],
  properties: {
    summary: { type: "string", minLength: 1 },
    notes: { type: ["string", "null"] },
    rationale: { type: ["string", "null"] },
    rationale_provenance: REASON_PROVENANCE_SCHEMA,
    as_of_date: { type: ["string", "null"] },
    changes: { type: "array", items: PLAN_CHANGE_SCHEMA },
    cardio: { type: "array", items: PLAN_CARDIO_SCHEMA },
    days: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["day_number", "name", "items"],
        properties: {
          day_number: { type: "integer", minimum: 1 },
          name: { type: "string", minLength: 1 },
          focus: { type: ["string", "null"] },
          // A first-class rest day (v99). "rest" days carry NO items — the emptiness
          // is the prescription — which is why `items` no longer requires one: a week
          // that names its rest day is a better week than one that leaves a hole where
          // the seam should be, and the server refuses a rest day that carries work.
          day_type: { type: ["string", "null"], enum: ["training", "rest", null] },
          items: {
            type: "array",
            minItems: 0,
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                kind: { type: "string" },
                exercise: { type: "string" },
                sets: { type: ["integer", "null"], minimum: 0 },
                rep_low: { type: ["integer", "null"], minimum: 0 },
                rep_high: { type: ["integer", "null"], minimum: 0 },
                target_weight: { type: ["number", "null"] },
                target_seconds: { type: ["number", "null"], minimum: 0 },
                superset_group: { type: ["integer", "null"] },
                note: { type: ["string", "null"] },
                reason: { type: ["string", "null"] },
                reason_provenance: REASON_PROVENANCE_SCHEMA,
                warmup_sets: { type: ["integer", "null"], minimum: 0 },
                mode: { type: ["string", "null"] },
                // Read only by plan-quality's canonicalGroup — measured DROPPED when unnamed.
                muscle_group: { type: ["string", "null"] },
                interval_json: { type: ["string", "null"] },
                // A days item may be strength OR kind:"cardio", which takes these.
                ...RUN_PRESCRIPTION_PROPERTIES,
              },
            },
          },
        },
      },
    },
  },
};

export function isPlanProposalResult(value: unknown): boolean {
  if (!matchesJsonSchema(PLAN_PROPOSAL_SCHEMA, value, { coerce: true })) return false;
  const p = object(value);
  if (!p || !text(p.summary)) return false;
  // "At least one action array" and "a change names an exercise OR a swap" are
  // disjunctions JSON Schema cannot state without a top-level union — which the
  // enforcing CLIs reject (claude requires a top-level object `type`). They stay here.
  const hasChanges = Array.isArray(p.changes);
  const hasCardio = Array.isArray(p.cardio);
  const hasDays = Array.isArray(p.days);
  if (!hasChanges && !hasCardio && !hasDays) return false;

  const changesOk = !hasChanges || p.changes.every((raw: unknown) => {
    const change = object(raw);
    if (!change) return false;
    const swap = object(change.swap);
    const reasonOk =
      !reasonHasHistoricalReference(change.reason) || validReasonProvenance(change.reason_provenance);
    return reasonOk && (text(change.exercise) || !!(swap && text(swap.from) && text(swap.to)));
  });
  const cardioOk =
    !hasCardio ||
    p.cardio.every((raw: unknown) => {
      const cardio = object(raw);
      return (
        !!cardio &&
        text(cardio.label) &&
        (!reasonHasHistoricalReference(cardio.reason) || validReasonProvenance(cardio.reason_provenance))
      );
    });
  const daysOk =
    !hasDays ||
    p.days.every((raw: unknown) => {
      const day = object(raw);
      return (
        text(day?.name) &&
        (!Array.isArray(day?.items) ||
          day.items.every((item: unknown) => {
            const planItem = object(item);
            return (
              !!planItem &&
              (!reasonHasHistoricalReference(planItem.reason) ||
                validReasonProvenance(planItem.reason_provenance))
            );
          }))
      );
    });
  const rationaleOk =
    !reasonHasHistoricalReference(p.rationale) || validReasonProvenance(p.rationale_provenance);
  return changesOk && cardioOk && daysOk && rationaleOk;
}

export function hasPlanProposalActions(value: unknown): boolean {
  const p = object(value);
  return !!p && [p.changes, p.cardio, p.days].some((items) => Array.isArray(items) && items.length > 0);
}

export function isExerciseExplanationResult(value: unknown): boolean {
  const root = object(value);
  const p = object(root?.explanation) ?? root;
  return !!p && text(p.setup) && text(p.move) && text(p.feel);
}

export const WEEK_AHEAD_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["summary", "days"],
  properties: {
    summary: { type: "string", minLength: 1 },
    days: {
      type: "array",
      minItems: 3,
      maxItems: 7,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["kind", "label"],
        properties: {
          kind: { type: "string", enum: ["lift", "run", "mixed", "rest"] },
          label: { type: "string", minLength: 1 },
          // Solicited by the prose twin (prompt/health.ts WEEK_AHEAD_SCHEMA).
          day: { type: ["string", "null"] },
          note: { type: ["string", "null"] },
        },
      },
    },
  },
};

export function isWeekAheadResult(value: unknown): boolean {
  if (!matchesJsonSchema(WEEK_AHEAD_SCHEMA, value, { coerce: true })) return false;
  const p = object(value);
  if (!p || !text(p.summary)) return false;
  return p.days.every((raw: unknown) => text(object(raw)?.label));
}

// A coach_read protocol turn and the op's final payload share ONE schema: claude
// rejects a top-level anyOf, so runChosenWithCoachReads forwards this object as-is.
// Every arg the read-tool normalizer reads is NAMED — constrained decoding drops
// unnamed fields even with additionalProperties: true.
const COACH_READ_ARGS_PROPERTIES: Record<string, JsonSchema> = {
  exercise: { type: ["string", "null"] },
  start_date: { type: ["string", "null"] },
  end_date: { type: ["string", "null"] },
  limit: { type: ["integer", "null"] },
  weeks: { type: ["integer", "null"] },
  marker: { type: ["string", "null"] },
  days: { type: ["integer", "null"] },
  kind: { type: ["string", "null"] },
  subject_key: { type: ["string", "null"] },
  scope: { type: ["string", "null"] },
  day_number: { type: ["integer", "null"] },
  day: { type: ["string", "null"] },
};

const COACH_READ_PROTOCOL_PROPERTIES: Record<string, JsonSchema> = {
  requests: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: true,
      properties: {
        tool: { type: "string" },
        args: {
          type: "object",
          additionalProperties: true,
          properties: COACH_READ_ARGS_PROPERTIES,
        },
      },
    },
  },
};

// The Brief day-read (src/prompt/day.ts DAY_READ_SCHEMA is its prose twin).
// `kind` includes "coach_read" because this schema is forwarded through the
// bounded read loop — an enum of only train|easy|rest|done would make a read
// request structurally impossible under constrained decoding.
export const DAY_READ_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["train", "easy", "rest", "done", "coach_read"] },
    headline: { type: ["string", "null"] },
    why: { type: ["string", "null"] },
    focus: { type: ["string", "null"] },
    est_minutes: { type: ["number", "null"] },
    ...COACH_READ_PROTOCOL_PROPERTIES,
  },
};

// Quiet cross-domain insight AND the weekly read (prompt/day.ts INSIGHT_SCHEMA /
// WEEKLY_READ_SCHEMA). `connection` MUST be named: constrained decoding dropped
// it when it wasn't, and every insight then fell back to text-only derivation.
// `found` is NOT required — a coach_read turn has none, and {found:false} is
// the designed silence. Residual checks in isInsightResult still require it
// for a final payload.
export const INSIGHT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: "string" },
    found: { type: "boolean" },
    text: { type: ["string", "null"] },
    rationale: { type: ["string", "null"] },
    next_step: { type: ["string", "null"] },
    connection: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        a: {
          type: "object",
          additionalProperties: true,
          properties: {
            facet: { type: "string" },
            direction: { type: "string" },
          },
        },
        b: {
          type: "object",
          additionalProperties: true,
          properties: {
            facet: { type: "string" },
            direction: { type: "string" },
          },
        },
      },
    },
    ...COACH_READ_PROTOCOL_PROPERTIES,
  },
};

// A meal is the payload's leaf shape, shared by the weekly plan and the one-off swap.
// `items`/`carbs_g`/`fat_g` are named because the prose twins solicit them
// (prompt/nutrition.ts MEAL_SCHEMA and SWAP_SCHEMA) — see the note above
// PLAN_CHANGE_SCHEMA for why an open node is not enough to keep them.
const MEAL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["name", "kcal", "protein_g", "fiber_g"],
  properties: {
    name: { type: "string", minLength: 1 },
    items: { type: ["string", "null"] },
    kcal: { type: "number", exclusiveMinimum: 0 },
    protein_g: { type: "number", minimum: 0 },
    carbs_g: { type: ["number", "null"], minimum: 0 },
    fat_g: { type: ["number", "null"], minimum: 0 },
    fiber_g: { type: "number", minimum: 0 },
  },
};

// No enum: nothing in Cairn validates the confidence word, the prose twin already
// states the vocabulary, and a nullable enum is the kind of construct an enforcing
// backend is most likely to reject.
const CONFIDENCE_SCHEMA: JsonSchema = { type: ["string", "null"] };

export const MEAL_PLAN_STRUCTURE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["daily_kcal", "daily_protein_g", "daily_fiber_g", "days"],
  properties: {
    summary: { type: ["string", "null"] },
    daily_kcal: { type: "number", exclusiveMinimum: 0 },
    daily_protein_g: { type: "number", exclusiveMinimum: 0 },
    daily_fiber_g: { type: "number", exclusiveMinimum: 0 },
    days: {
      type: "array",
      minItems: 5,
      maxItems: 7,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["day", "meals"],
        properties: {
          day: { type: "string", minLength: 1 },
          note: { type: ["string", "null"] },
          meals: { type: "array", minItems: 1, items: MEAL_SCHEMA },
        },
      },
    },
    shopping: { type: "array", items: { type: "string" } },
    practicality: {
      type: "object",
      additionalProperties: true,
      properties: {
        prep_pattern: { type: ["string", "null"] },
        budget_availability: { type: ["string", "null"] },
        household_fit: { type: ["string", "null"] },
        repeatable_staples: { type: "array", items: { type: "string" } },
        confidence: CONFIDENCE_SCHEMA,
      },
    },
    nutrition_pattern: {
      type: "object",
      additionalProperties: true,
      properties: {
        fiber: { type: ["string", "null"] },
        omega_3_sources: { type: ["string", "null"] },
        iron_context: { type: ["string", "null"] },
        calcium_potassium: { type: ["string", "null"] },
        saturated_fat_added_sugar: { type: ["string", "null"] },
        basis: { type: ["string", "null"] },
        confidence: CONFIDENCE_SCHEMA,
      },
    },
    notes: { type: ["string", "null"] },
  },
};

export function isMealPlanStructureResult(value: unknown): boolean {
  if (!matchesJsonSchema(MEAL_PLAN_STRUCTURE_SCHEMA, value, { coerce: true })) return false;
  const p = object(value);
  if (!p) return false;
  return p.days.every((rawDay: unknown) => {
    const day = object(rawDay);
    return !!day && text(day.day) && day.meals.every((rawMeal: unknown) => text(object(rawMeal)?.name));
  });
}

export function isMealPlanResult(value: unknown): boolean {
  return isMealPlanStructureResult(value) && assessMealPlanAdequacy(value).ok;
}

export function isNutritionCheckinResult(value: unknown): boolean {
  const p = object(value);
  if (!p || typeof p.change !== "boolean" || !text(p.summary)) return false;
  if (!p.change) return true;
  const nutrition = object(p.nutrition);
  return !!nutrition && positive(nutrition.target_kcal) && positive(nutrition.protein_g);
}

// A swap replaces ONE meal, so it is exactly the leaf shape above.
export const MEAL_SWAP_SCHEMA: JsonSchema = MEAL_SCHEMA;

export function isMealSwapResult(value: unknown): boolean {
  return matchesJsonSchema(MEAL_SWAP_SCHEMA, value, { coerce: true }) && text(object(value)?.name);
}

export function isRecipeResult(value: unknown): boolean {
  const p = object(value);
  if (!p) return false;
  const ingredients = Array.isArray(p.ingredients) ? p.ingredients : [];
  const steps = Array.isArray(p.steps) ? p.steps : [];
  return ingredients.some((x: unknown) => text(object(x)?.item)) || steps.some(text);
}

export function isHealthReviewResult(value: unknown): boolean {
  const p = object(value);
  if (!p) return false;
  const focus = Array.isArray(p.focus) && p.focus.some((x: unknown) => text(object(x)?.title));
  const watchlist = Array.isArray(p.watchlist) && p.watchlist.some((x: unknown) => text(object(x)?.marker));
  return text(p.headline) || focus || watchlist;
}

export function isHealthSynthesisResult(value: unknown): boolean {
  const root = object(value);
  const p = object(root?.synthesis) ?? root;
  return !!p && p.found !== false && (text(p.headline) || text(p.story));
}

// `connection` (the facet-pair identity, src/repo/insight-intent.ts) is deliberately
// NOT required here: a CLI that predates it still returns a usable insight, and the
// acceptance ladder in generateInsight falls back to deriving the key from the text.
// Whether a supplied connection is VALID is judged there, not at this parse gate.
export function isInsightResult(value: unknown): boolean {
  if (!matchesJsonSchema(INSIGHT_SCHEMA, value, { coerce: true })) return false;
  const p = object(value);
  if (!p || typeof p.found !== "boolean") return false;
  return p.found === false || text(p.text);
}

export function isReconciliationResult(value: unknown): boolean {
  const p = object(value);
  return !!p && Array.isArray(p.groups);
}

export function isReactionNarrativeResult(value: unknown): boolean {
  return text(object(value)?.narrative);
}

export function isVerifyResult(value: unknown, validateDraft: (draft: unknown) => boolean): boolean {
  const p = object(value);
  if (!p || typeof p.ok !== "boolean" || !Array.isArray(p.violations)) return false;
  if (p.ok) return p.violations.length === 0 && (p.fixed_draft == null);
  return p.violations.some(text) && !!object(p.fixed_draft) && validateDraft(p.fixed_draft);
}
