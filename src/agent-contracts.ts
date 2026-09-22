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

import { AUTONOMY_TIERS, BRAIN_DOMAINS, BRAIN_RISK_CLASSES } from "./brain/decision-contract.js";
import {
  BRAIN_METRIC_KEYS,
  EXPECTATION_CONFIDENCE,
  EXPECTATION_CONFOUNDER_POLICIES,
  EXPECTATION_DIRECTIONS,
  EXPECTATION_EVALUATORS,
} from "./brain/expectation-contract.js";
import { SPECIALIST_DOMAINS } from "./brain/specialist-contract.js";
import { FOOD_ESTIMATE_PROPERTIES } from "./foodCapture.js";
import { type JsonSchema, matchesJsonSchema } from "./json-schema.js";
import { assessMealPlanAdequacy } from "./repo/nutrition-safety.js";
import { reasonHasHistoricalReference, validReasonProvenance } from "./repo/proposal-truth.js";
import {
  DAILY_SESSION_SUGGESTION_NORMALIZATION,
  normalizeSessionSuggestionResult,
} from "./repo/adaptive-session.js";
import { coerceFinite } from "./lib/numbers.js";

export { DAILY_SESSION_SUGGESTION_NORMALIZATION, normalizeSessionSuggestionResult };

type JsonObject = Record<string, any>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function text(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function positive(value: unknown): boolean {
  return coerceFinite(value) != null && Number(value) > 0;
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
// PERMISSIVE ON PURPOSE, because this fragment is shared with the PLAN schemas and
// those are read at a different strength. PLAN_PROPOSAL_SCHEMA is not only handed to
// a decoder — isPlanProposalResult runs it through matchesJsonSchema as a HARD
// ACCEPTANCE GATE, and matchesJsonSchema enforces minItems and exclusiveMinimum. The
// plan applier tolerates an empty interval array (savePlanDay ignores it), so a
// coach that fills every named slot on a steady run and emits `interval: []` must
// still be ACCEPTED — tightening here would burn the whole rotation on a proposal the
// applier would have handled fine. SESSION_ITEM_SCHEMA overrides these bounds for
// itself, where the consumer genuinely throws; see the note there.
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
  // `minimum: 0`, not `exclusiveMinimum` — see the note on RUN_INTERVAL_SCHEMA. These
  // bounds are read as an acceptance gate on the plan side, so a 0 here has to stay
  // admissible. SESSION_ITEM_SCHEMA tightens both after the spread.
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
          // These numeric bounds stay PERMISSIVE, for two reasons that compound.
          // First, the plan applier has no equivalent of the session normalizer's
          // cross-family guard: savePlanDay (src/repo/plan.ts) branches on
          // kind:"cardio", reads only that family's slots, and clamps rather than
          // throws (numOrNull / `it.sets ?? 3`), so a slot from the other family is
          // ignored here, never fatal. Second and decisively, THIS schema is also an
          // acceptance gate — isPlanProposalResult runs it through matchesJsonSchema —
          // so a bound tightened here does not merely steer a decoder, it REJECTS a
          // proposal the applier would have handled, and the rotation burns. The
          // exclusiveMinimum discipline belongs to SESSION_ITEM_SCHEMA alone, whose
          // consumer genuinely throws and whose schema is never read as a gate.
          // A first-class rest day (v99). "rest" days carry NO items — the emptiness
          // is the prescription — which is why `items` no longer requires one: a week
          // that names its rest day is a better week than one that leaves a hole where
          // the seam should be, and the server refuses a rest day that carries work.
          // NO ENUM, deliberately. A nullable enum is the construct an enforcing
          // backend is most likely to reject (see CONFIDENCE_SCHEMA), and this schema
          // is ALSO an acceptance gate — matchesJsonSchema has no anyOf, so the enum
          // would have to carry the null itself. The vocabulary is not lost: the
          // applier owns it. planDayTypeForRestructure (src/repo/plan.ts) THROWS on
          // anything but 'training' | 'rest', so an off-vocabulary string cannot
          // persist however permissive the schema is.
          //
          // The `description` is MODEL-VISIBLE and must say what `days` actually
          // means, which is not what a single-day write means. A `days` payload is a
          // RESTRUCTURE: it declares the whole week, so an omitted day_type is
          // 'training', never "leave it as it was" — a week that never names its rest
          // day has no rest day. Keep this wording in step with the prose twin in
          // src/prompt/coach.ts; the schema suite asserts they agree.
          day_type: {
            type: ["string", "null"],
            description: "training|rest; omitted or null means training — name 'rest' explicitly for the rest day",
          },
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

// ============================================================================
// The rest of the enforced contracts.
//
// Everything above predates the audit that found Cairn had built enforced
// structured output end to end and then attached it at nine call sites. The
// schemas below close that gap: every remaining op that produces a JSON payload a
// consumer READS now hands its shape to the CLI, so the contract is enforced
// rather than merely requested.
//
// The four rules the block above states apply here without exception:
//   1. TOP LEVEL IS ONE `type:"object"`. A top-level anyOf is rejected outright by
//      the claude CLI, so a union is expressed as one object whose members are all
//      optional, with the disjunction living in the acceptance predicate.
//   2. EVERY FIELD THE CONSUMER READS IS NAMED. Constrained decoding steers toward
//      the named slots and silently drops the rest; `additionalProperties: true`
//      permits a field, it does not make the model emit one. An unnamed-but-read
//      field is silent data loss, not a rejected payload.
//   3. A READ-LOOP OP SPREADS `COACH_READ_PROTOCOL_PROPERTIES` and names `kind`.
//      runChosenWithCoachReads forwards ONE schema for both the protocol turn and
//      the final payload (claude rejects a top-level anyOf), so a schema that omits
//      `requests` kills depth-on-demand silently. Such a schema also declares NO
//      `required` beyond what a coach_read turn itself carries — a protocol turn has
//      none of the final payload's fields.
//   4. NULLABLE MEANS `["type","null"]`, and an optional field is never `required`.
//
// A schema is inert while an op STREAMS (agents.ts declares no {schema_args} slot on
// the stream args, and grok's --json-schema would override its own streaming format),
// so a streaming op's schema binds on the non-streamed fallback path — which is the
// path that actually needs it, since that is where the rotation and JSON repair live.
// The prose OUTPUT CONTRACT therefore stays in every prompt: it is the floor for the
// offline `stub` agent, for antigravity (which declares no structured output), and
// for every streamed turn.

// ---------- the self-critique verify pass ----------

// The verify contract is generic over the draft it checks, and `fixed_draft` is where
// that matters: an OPEN object node there would name none of the draft's fields, and
// rule 2 says a constrained decoder would then return an empty husk in the slot whose
// whole job is to carry a corrected draft. So the schema is built PER DRAFT SHAPE from
// the same artifact the op's own run enforces — the meal-plan verify pass sees the meal
// plan schema, the session verify pass sees the session schema.
export function verifyResultSchema(draftSchema: JsonSchema): JsonSchema {
  return {
    type: "object",
    additionalProperties: true,
    required: ["ok", "violations"],
    properties: {
      ok: { type: "boolean" },
      violations: { type: "array", items: { type: "string" } },
      // ok:true carries null here, so the draft node must admit null.
      fixed_draft: { ...draftSchema, type: ["object", "null"] },
    },
  };
}

// ---------- the daily session (suggest + compose) ----------

// One session item. The prose twin is prompt/day.ts SESSION_SUGGEST_SCHEMA, but the
// authority on what is READ is normalizeItem/normalizePrescriptionItem
// (src/repo/adaptive-session.ts): it consumes the strength fields, the cardio field
// set, `superset_group`, `warmup_sets`, `target_reps`, and `interval` (or
// `interval_json`) — none of which survive constrained decoding unnamed.
//
// EVERY NUMERIC SLOT HERE IS `exclusiveMinimum: 0`, and that is a correctness rule,
// not tidiness. This ONE open node carries both families because an item is strength
// OR cardio and the top level must stay a single object — so a strength item is
// offered the cardio slots and vice versa. `normalizePrescriptionItem` runs with
// `strictShape` for an agent payload and THROWS when an item carries any *present*
// field from the other family, and `present()` is `!== undefined && !== null && !== ""`
// — so a 0 or an [] is present, not absent. One such value makes
// normalizeSessionPayload throw, normalizeSessionSuggestionResult return null,
// acceptParsed fail, and the whole rotation burn on a payload that reads fine.
// `null` (or omission) is how this node says "not this family"; 0 is not.
// positiveNumber() throws on <= 0 for its own family's slots for the same reason.
const SESSION_ITEM_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: ["string", "null"] },
    exercise: { type: "string" },
    sets: { type: ["integer", "null"], exclusiveMinimum: 0 },
    rep_low: { type: ["integer", "null"], exclusiveMinimum: 0 },
    rep_high: { type: ["integer", "null"], exclusiveMinimum: 0 },
    // Expanded into rep_low/rep_high by normalizePrescriptionItem when the model
    // prescribes a single rep target instead of a range.
    target_reps: { type: ["integer", "null"], exclusiveMinimum: 0 },
    // Negative = assisted, null = bodyweight OR an unanchored load (the athlete
    // picks it). Never a `minimum`. Server-derived `load_basis` disambiguates.
    target_weight: { type: ["number", "null"] },
    target_seconds: { type: ["number", "null"], exclusiveMinimum: 0 },
    mode: { type: ["string", "null"] },
    note: { type: ["string", "null"] },
    // A heavier top set / re-test on the SAME lift. One item per exercise —
    // never a second row. Sets/reps here are exclusiveMinimum 0 for the same
    // reason as the parent: a 0 would be present and fatal on a cardio sibling.
    top_set: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        sets: { type: ["integer", "null"], exclusiveMinimum: 0 },
        reps: { type: ["integer", "null"], exclusiveMinimum: 0 },
        target_weight: { type: ["number", "null"] },
        target_seconds: { type: ["number", "null"], exclusiveMinimum: 0 },
        rir: { type: ["number", "null"], minimum: 0, maximum: 5 },
        note: { type: ["string", "null"] },
      },
    },
    superset_group: { type: ["integer", "null"], minimum: 1 },
    // A 0 here is not a harmless "no warmup sets": boundedNumber would store it as 0
    // rather than null, and on a CARDIO item it is a present strength field, which is
    // fatal. Since the two stored values drive nothing differently, null is the only
    // spelling of "none" this node offers.
    warmup_sets: { type: ["integer", "null"], exclusiveMinimum: 0 },
    interval_json: { type: ["string", "null"] },
    // The shared cardio fragment stays permissive for the plan schemas, which read it
    // as an acceptance gate. Tighten it HERE, after the spread, where the consumer is
    // normalizePrescriptionItem and a 0 or an [] costs the whole payload.
    ...RUN_PRESCRIPTION_PROPERTIES,
    target_distance_km: { type: ["number", "null"], exclusiveMinimum: 0 },
    target_duration_min: { type: ["number", "null"], exclusiveMinimum: 0 },
    interval: { ...RUN_INTERVAL_SCHEMA, type: ["array", "null"], minItems: 1 },
  },
};

// session_suggest and session_compose share ONE payload shape (both normalize through
// normalizeSessionSuggestionResult) and BOTH opt into bounded reads, so this schema
// carries the coach_read protocol. `name` and `title` are both named because
// normalizeSessionPayload reads `session.title ?? session.name`.
export const SESSION_SUGGESTION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: ["string", "null"] },
    name: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    focus: { type: ["string", "null"] },
    why: { type: ["string", "null"] },
    est_minutes: { type: ["number", "null"] },
    notes: { type: ["string", "null"] },
    items: { type: "array", items: SESSION_ITEM_SCHEMA },
    ...COACH_READ_PROTOCOL_PROPERTIES,
  },
};

// ---------- adaptive nutrition check-in ----------

// Runs through bounded reads (runChosenStreaming boundedReads:true), so it names the
// protocol and requires nothing. isNutritionCheckinResult still demands change/summary
// of a FINAL payload.
export const NUTRITION_CHECKIN_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: ["string", "null"] },
    change: { type: "boolean" },
    summary: { type: ["string", "null"] },
    nutrition: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        target_kcal: { type: ["number", "null"] },
        protein_g: { type: ["number", "null"] },
        carbs_g: { type: ["number", "null"] },
        fat_g: { type: ["number", "null"] },
        prev_target_kcal: { type: ["number", "null"] },
        reason: { type: ["string", "null"] },
      },
    },
    notes: { type: ["string", "null"] },
    ...COACH_READ_PROTOCOL_PROPERTIES,
  },
};

// ---------- meal recipe ----------

export const RECIPE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    summary: { type: ["string", "null"] },
    time_min: { type: ["number", "null"], minimum: 0 },
    servings: { type: ["number", "null"], minimum: 0 },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: { item: { type: "string" }, qty: { type: ["string", "null"] } },
      },
    },
    steps: { type: "array", items: { type: "string" } },
    tips: { type: "array", items: { type: "string" } },
  },
};

// ---------- exercise how-to ----------

// isExerciseExplanationResult accepts the fields at the root OR under `explanation`;
// the prose twin asks for them at the root, so the root is what the schema names.
// A nested `explanation` object is still admitted by additionalProperties.
export const EXERCISE_EXPLANATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["setup", "move", "feel"],
  properties: {
    setup: { type: "string", minLength: 1 },
    move: { type: "string", minLength: 1 },
    feel: { type: "string", minLength: 1 },
    avoid: { type: ["string", "null"] },
  },
};

// ---------- health review / synthesis ----------

// runHealthReview goes through runChosenWithCoachReads, and the enrichment queue's
// background refresh runs the same prompt one-shot — one schema serves both.
export const HEALTH_REVIEW_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: ["string", "null"] },
    headline: { type: ["string", "null"] },
    wins: { type: "array", items: { type: "string" } },
    watchlist: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          marker: { type: "string" },
          status: { type: ["string", "null"] },
          why: { type: ["string", "null"] },
          action: { type: ["string", "null"] },
          citation: { type: ["string", "null"] },
        },
      },
    },
    not_worried: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        markers: { type: "array", items: { type: "string" } },
        note: { type: ["string", "null"] },
      },
    },
    focus: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          title: { type: "string" },
          why: { type: ["string", "null"] },
          action: { type: ["string", "null"] },
        },
      },
    },
    followups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: { what: { type: "string" }, when: { type: ["string", "null"] } },
      },
    },
    training_impact: { type: ["string", "null"] },
    nutrition_impact: { type: ["string", "null"] },
    directives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          domain: { type: "string" },
          marker: { type: ["string", "null"] },
          directive: { type: "string" },
          rationale: { type: ["string", "null"] },
          citation: { type: ["string", "null"] },
        },
      },
    },
    ...COACH_READ_PROTOCOL_PROPERTIES,
  },
};

// The whole-picture synthesis streams its prose, so this binds on the non-streamed
// fallback — which also runs the bounded read loop (boundedReads:true).
export const HEALTH_SYNTHESIS_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: ["string", "null"] },
    found: { type: "boolean" },
    headline: { type: ["string", "null"] },
    story: { type: ["string", "null"] },
    priorities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          label: { type: "string" },
          why_it_matters: { type: ["string", "null"] },
          the_move: { type: ["string", "null"] },
          recheck: { type: ["string", "null"] },
        },
      },
    },
    one_change: { type: ["string", "null"] },
    ...COACH_READ_PROTOCOL_PROPERTIES,
  },
};

// ---------- clinical-evidence research ----------

// validateSources (src/research.ts) reads six fields off each source, not two.
// Unnamed, `version` and `published_at` fall back to a year regex over the title and
// the `source_scope === "athlete"` branch becomes unreachable — the claim still
// lands, but its provenance is guessed rather than stated.
const RESEARCH_SOURCE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    title: { type: "string" },
    url: { type: "string" },
    version: { type: ["string", "null"] },
    published_at: { type: ["string", "null"] },
    // Read as `source_scope ?? scope`; only "athlete" is meaningful, and it is
    // honored only when the claim text also reads as athlete-specific.
    source_scope: { type: ["string", "null"] },
    scope: { type: ["string", "null"] },
  },
};

export const RESEARCH_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    summary: { type: ["string", "null"] },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          claim: { type: "string" },
          body: { type: ["string", "null"] },
          marker: { type: ["string", "null"] },
          confidence: { type: ["string", "null"] },
          sources: { type: "array", items: RESEARCH_SOURCE_SCHEMA },
        },
      },
    },
    sources: { type: "array", items: RESEARCH_SOURCE_SCHEMA },
  },
};

// ---------- name reconciliation (markers and exercises) ----------

// Both reconcilers answer with a `groups` array and isReconciliationResult is their
// shared gate, but the GROUP shapes differ: the marker librarian carries a unit, the
// exercise librarian carries a muscle group, a mode, and a second `merges` array that
// actually moves logged history. Two schemas, because naming the union would invite
// each op to emit the other's fields.
export const MARKER_RECONCILE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          canonical: { type: "string" },
          unit: { type: ["string", "null"] },
          members: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const EXERCISE_RECONCILE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          members: { type: "array", items: { type: "string" } },
          canonical: { type: "string" },
          // reconcileExercises reads `g.group ?? g.muscle_group`; both are named so
          // whichever the model reaches for survives.
          group: { type: ["string", "null"] },
          muscle_group: { type: ["string", "null"] },
          mode: { type: ["string", "null"] },
        },
      },
    },
    merges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          from: { type: "string" },
          into: { type: "string" },
          why: { type: ["string", "null"] },
          confidence: { type: ["string", "null"] },
        },
      },
    },
  },
};

// ---------- the reaction-model narrative ----------

export const REACTION_NARRATIVE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["narrative"],
  properties: { narrative: { type: "string", minLength: 1 } },
};

// ---------- memory: distill, consolidate, grow ----------

const MEMORY_ROW_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: { content: { type: "string" }, kind: { type: ["string", "null"] } },
};

export const CHAT_DISTILL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["memories"],
  properties: {
    memories: { type: "array", items: MEMORY_ROW_SCHEMA },
    farewell: { type: ["string", "null"] },
  },
};

// An empty conversation genuinely distills to nothing, so "any array" is the whole
// structural bar; the predicate exists because distillChat previously passed NO
// acceptParsed at all, which made any parseable object — including another op's
// payload, or a bare `{}` from a confused CLI — count as a successful run and stop
// the rotation.
export function isChatDistillResult(value: unknown): boolean {
  const p = object(value);
  return !!p && Array.isArray(p.memories);
}

// All three keys are `required` so an ENFORCING CLI always answers in the shape the
// prose shows — the blessed empty answer being three empty arrays, not `{}`. The
// predicate below is deliberately looser, because a provider that cannot enforce a
// schema legitimately answers `{}` for a tidy store and that is a clean no-op, not a
// failed run. Strict for enforcement, tolerant for acceptance.
export const MEMORY_CONSOLIDATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["merges", "supersedes", "promotions"],
  properties: {
    merges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          ids: { type: "array", items: { type: "integer" } },
          content: { type: "string" },
          kind: { type: ["string", "null"] },
        },
      },
    },
    supersedes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: "integer" },
          reason: { type: ["string", "null"] },
          replacement: { type: ["string", "null"] },
        },
      },
    },
    promotions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: "integer" },
          kind: { type: "string" },
          content: { type: ["string", "null"] },
        },
      },
    },
  },
};

// "Each is optional; empty arrays are a perfectly good answer" (prompt/chat.ts), and
// consolidateMemory treats an empty result as a clean no-op — so a nightly pass over
// an already-tidy store that answers `{}` must be ACCEPTED, not counted as a failed
// run that burns the whole rotation. What this rejects is a librarian slot that came
// back as something other than a list, which is the only shape applyMemoryConsolidation
// cannot walk.
export function isMemoryConsolidationResult(value: unknown): boolean {
  const p = object(value);
  if (!p) return false;
  return [p.merges, p.supersedes, p.promotions].every((list) => list == null || Array.isArray(list));
}

export const ABOUT_ME_GROWTH_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["about_me", "changed"],
  properties: {
    about_me: { type: "string" },
    changed: { type: "boolean" },
  },
};

// ---------- onboarding ----------

export const ONBOARD_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    about_me: { type: ["string", "null"] },
    profile: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        sex: { type: ["string", "null"] },
        age: { type: ["integer", "null"] },
        height_cm: { type: ["number", "null"] },
        weight_lb: { type: ["number", "null"] },
        goal_weight_lb: { type: ["number", "null"] },
        goal_date: { type: ["string", "null"] },
        days_per_week: { type: ["integer", "null"] },
      },
    },
    goal: { type: ["string", "null"] },
    supplements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          name: { type: "string" },
          dose: { type: ["string", "null"] },
          frequency: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          related_markers: { type: "array", items: { type: "string" } },
        },
      },
    },
    memories: { type: "array", items: MEMORY_ROW_SCHEMA },
    context_events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          kind: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          detail: { type: ["string", "null"] },
          start_date: { type: ["string", "null"] },
          end_date: { type: ["string", "null"] },
          meta: {
            type: ["object", "null"],
            additionalProperties: true,
            properties: {
              area: { type: ["string", "null"] },
              severity: { type: ["string", "null"] },
            },
          },
        },
      },
    },
    movement_considerations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          label: { type: ["string", "null"] },
          detail: { type: ["string", "null"] },
          wants_addressed: { type: ["boolean", "null"] },
        },
      },
    },
  },
};

// ---------- health documents ----------

// One transcribed result row. `value` admits a string because a qualitative result
// ("Negative", "<5") is a real lab answer, and ref_low/ref_high are what let a panel
// be read against the range the document actually printed.
const HEALTH_MARKER_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    name: { type: "string" },
    value: { type: ["number", "string", "null"] },
    unit: { type: ["string", "null"] },
    flag: { type: ["string", "null"] },
    ref_low: { type: ["number", "null"] },
    ref_high: { type: ["number", "null"] },
  },
};

// One condition/medication/allergy/procedure row. Named once and used at BOTH the
// top level and inside a panel, because the consumer reads it in both places.
const CLINICAL_FACT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    name: { type: "string" },
    status: { type: ["string", "null"] },
    detail: { type: ["string", "null"] },
    source: { type: ["string", "null"] },
  },
};

const IMAGING_SOURCE_SPANS_SCHEMA: JsonSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: true,
    properties: {
      file_id: { type: ["integer", "null"] },
      page: { type: ["integer", "null"] },
      start: { type: ["integer", "null"] },
      end: { type: ["integer", "null"] },
      text: { type: ["string", "null"] },
    },
  },
};

// The imaging study body, shared by the standalone imaging read and the
// `imaging_studies[]` entries a MyChart bundle yields. Field-for-field what
// coerceImagingStudy / cleanFindings / cleanRecommendations actually read, INCLUDING
// every alternate spelling those coercers accept — `text` and `finding` beside
// `finding_text`, `site` beside `verbatim_site`, `system` and `anatomy` beside
// `clinical_system`/`body_region`, `label` beside a measurement's `name`. An
// unnamed alias is not a tolerated variant here: cleanFindings drops a finding whose
// text landed in an unnamed key, and it drops it from a clinical record with no log
// line. Every leaf is nullable: the coercers default a missing value
// and an invented one is worse than an absent one on a clinical record.
const IMAGING_STUDY_BODY_SCHEMA: JsonSchema = {
  type: ["object", "null"],
  additionalProperties: true,
  properties: {
    schema_version: { type: ["integer", "null"] },
    report_status: { type: ["string", "null"] },
    study: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        modality: { type: ["string", "null"] },
        raw_modality: { type: ["string", "null"] },
        procedure: { type: ["string", "null"] },
        accession: { type: ["string", "null"] },
        study_instance_uid: { type: ["string", "null"] },
        study_date: { type: ["string", "null"] },
        issued_at: { type: ["string", "null"] },
        facility: { type: ["string", "null"] },
        ordering_clinician: { type: ["string", "null"] },
        interpreting_clinician: { type: ["string", "null"] },
      },
    },
    anatomy: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        clinical_system: { type: ["string", "null"] },
        body_region: { type: ["string", "null"] },
        verbatim_site: { type: ["string", "null"] },
        laterality: { type: ["string", "null"] },
        code: { type: ["string", "null"] },
      },
    },
    report: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        history: { type: ["string", "null"] },
        technique: { type: ["string", "null"] },
        comparison: { type: ["string", "null"] },
        findings: { type: ["string", "null"] },
        impression: { type: ["string", "null"] },
        addendum: { type: ["string", "null"] },
      },
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: ["string", "null"] },
          source: { type: ["string", "null"] },
          clinical_system: { type: ["string", "null"] },
          body_region: { type: ["string", "null"] },
          verbatim_site: { type: ["string", "null"] },
          site: { type: ["string", "null"] },
          // `anatomy` is read as a fallback for BOTH clinical_system and body_region.
          system: { type: ["string", "null"] },
          anatomy: { type: ["string", "null"] },
          laterality: { type: ["string", "null"] },
          finding_text: { type: ["string", "null"] },
          text: { type: ["string", "null"] },
          finding: { type: ["string", "null"] },
          severity: { type: ["string", "null"] },
          certainty: { type: ["string", "null"] },
          measurements: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                name: { type: ["string", "null"] },
                label: { type: ["string", "null"] },
                value: { type: ["number", "null"] },
                value_text: { type: ["string", "null"] },
                unit: { type: ["string", "null"] },
                qualifier: { type: ["string", "null"] },
                method: { type: ["string", "null"] },
              },
            },
          },
          source_spans: IMAGING_SOURCE_SPANS_SCHEMA,
        },
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: ["string", "null"] },
          source: { type: ["string", "null"] },
          recommendation_text: { type: ["string", "null"] },
          text: { type: ["string", "null"] },
          timeframe: { type: ["string", "null"] },
          action: { type: ["string", "null"] },
          status: { type: ["string", "null"] },
          source_spans: IMAGING_SOURCE_SPANS_SCHEMA,
        },
      },
    },
    provenance: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        source_kind: { type: ["string", "null"] },
        extraction: { type: ["string", "null"] },
        extractor: { type: ["string", "null"] },
        source_doc_id: { type: ["integer", "null"] },
        source_hash: { type: ["string", "null"] },
        confidence: { type: ["string", "null"] },
        record_status: { type: ["string", "null"] },
        source_amended_at: { type: ["string", "null"] },
        source_amendment: { type: ["string", "null"] },
      },
    },
    verification: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        needs_confirmation: { type: ["boolean", "null"] },
        user_confirmed: { type: ["boolean", "null"] },
        clinician_confirmed: { type: ["boolean", "null"] },
        user_confirmed_at: { type: ["string", "null"] },
        clinician_confirmed_at: { type: ["string", "null"] },
        corrected_at: { type: ["string", "null"] },
        notes: { type: ["string", "null"] },
      },
    },
    dicom: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        study_instance_uid: { type: ["string", "null"] },
        series: { type: "array", items: { type: "object", additionalProperties: true } },
      },
    },
  },
};

// ---------- the background enrichment queue ----------
//
// These ops never stream and never take a read loop: enrich.ts calls
// runAgentWithFallback directly, one turn, and applies the result through a
// conservative fill-only merge.

// A durable fact an enricher may distill into memory. The same two fields every
// memory writer in the repo reads.
const ENRICH_MEMORY_SCHEMA: JsonSchema = { type: "array", items: MEMORY_ROW_SCHEMA };

export const ACTIVITY_ENRICH_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    structured: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: {
        type: { type: ["string", "null"] },
        duration_min: { type: ["number", "null"] },
        distance_km: { type: ["number", "null"] },
        pace: { type: ["string", "null"] },
        rpe: { type: ["number", "null"] },
        notes: { type: ["string", "null"] },
      },
    },
    memory: ENRICH_MEMORY_SCHEMA,
  },
};

// The text enricher wraps the shared meal estimate in `structured`; the photo read
// answers with the SAME fields flat at the top level (enrich.ts applyFoodPhoto reads
// them directly). One source, two envelopes — see src/foodCapture.ts.
export const FOOD_ENRICH_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    structured: {
      type: ["object", "null"],
      additionalProperties: true,
      properties: { ...FOOD_ESTIMATE_PROPERTIES },
    },
    memory: ENRICH_MEMORY_SCHEMA,
  },
};

export const FOOD_PHOTO_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: { ...FOOD_ESTIMATE_PROPERTIES },
};

// The multi-record import: one panel per distinct draw date, plus the clinical facts
// and imaging studies a MyChart bundle carries. `marker_count` is the model's own
// count of what THIS date's source lists; the prose asks for it as a self-check on
// the transcription. (The completeness retry does not read it — countIngestMarkers
// sums markers.length and `expected` comes from estimateMarkerCandidates over the
// source text — but the prose solicits the field, so the schema must name it.)
export const HEALTH_INGEST_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    panels: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          doc_date: { type: ["string", "null"] },
          kind: { type: ["string", "null"] },
          // Read per PANEL, not only at the top level: enrich.ts flattens
          // panels[].clinical_facts, infers the document kind from it, and
          // insertHealthPanels persists it — and a panel with neither markers nor
          // facts is discarded as noise. A model that attaches medications or
          // problems to the date-panel they belong to must not lose them.
          clinical_facts: { type: "array", items: CLINICAL_FACT_SCHEMA },
          // The panel's own kind discriminator, read beside `kind` by
          // inferHealthDocumentKind and stored by insertHealthPanels.
          type: { type: ["string", "null"] },
          summary: { type: ["string", "null"] },
          marker_count: { type: ["integer", "null"], minimum: 0 },
          markers: { type: "array", items: HEALTH_MARKER_SCHEMA },
        },
      },
    },
    clinical_facts: { type: "array", items: CLINICAL_FACT_SCHEMA },
    imaging_studies_complete: { type: ["boolean", "null"] },
    imaging_studies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: { imaging_study: IMAGING_STUDY_BODY_SCHEMA },
      },
    },
    summary: { type: ["string", "null"] },
    memory: ENRICH_MEMORY_SCHEMA,
  },
};

// The standalone imaging read (src/prompt/imaging.ts is its prose twin).
export const IMAGING_STUDY_JSON_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["imaging_study"],
  properties: { imaging_study: IMAGING_STUDY_BODY_SCHEMA },
};

// ---------- Garmin strength reconstruction ----------

export const GARMIN_STRENGTH_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    summary: { type: ["string", "null"] },
    intensity: { type: ["string", "null"] },
    sets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          exercise: { type: "string" },
          // null = bodyweight, negative = assisted. Never a `minimum`.
          weight: { type: ["number", "null"] },
          reps: { type: ["integer", "null"], minimum: 0 },
          duration_sec: { type: ["number", "null"], minimum: 0 },
          mode: { type: ["string", "null"] },
        },
      },
    },
    extrapolated: { type: ["boolean", "null"] },
  },
};

// ---------- single-exercise classification ----------

// garmin_category / garmin_exercise must be copied VERBATIM from the shortlist the
// prompt supplies, so they stay open strings — the candidate set is per-call and an
// enum here would have to be built per prompt.
export const EXERCISE_ENRICH_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    canonical: { type: ["string", "null"] },
    // The applier reads `muscle_group ?? group`; both spellings are named so
    // whichever the model reaches for lands in a slot the decoder keeps.
    muscle_group: { type: ["string", "null"] },
    group: { type: ["string", "null"] },
    mode: { type: ["string", "null"] },
    equipment: { type: ["string", "null"] },
    garmin_category: { type: ["string", "null"] },
    garmin_exercise: { type: ["string", "null"] },
  },
};

// ---------- the multidisciplinary case conference ----------
//
// Two ops, one conference: each specialist writes a SpecialistOpinion, and the
// conductor reconciles them into ONE CaseConferenceDecision. Their prose twins are
// SPECIALIST_PROMPT_SCHEMA / CONFERENCE_PROMPT_SCHEMA in
// src/domain/brain/case-conference.ts and STAY there — the prose still carries the
// union (`revision` is a three-way oneOf) and the required lists these schemas
// cannot state, and it is the whole contract for the offline stub and for any
// provider that enforces nothing.
//
// NEITHER schema is an acceptance gate. The specialist is accepted by
// isSpecialistOpinion and the conductor by normalizeStrictCaseConferenceDecision,
// and neither runs matchesJsonSchema — so tightening a bound here steers the
// decoder without being able to reject a payload the normalizer would have taken.
// The bounds below are therefore mirrored FROM those normalizers on purpose: a
// slot the decoder fills outside them is a payload the conductor loses anyway.

// The expectation leaf both ops carry (normalizeProposedExpectation,
// src/brain/expectation-contract.ts). `required` names only the eight the
// normalizer genuinely demands — subject_key, baseline, minimum_data and
// confounder_policy all have defaults there, and requiring an optional field is
// how a schema starts rejecting answers the consumer would have accepted.
// `baseline`/`target`/`minimum_data` stay OPEN object nodes with nothing named
// because their content is free-form by contract; the prose twin carries the
// shape guidance a decoder needs for them.
const CONFERENCE_EXPECTATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: [
    "metric_key",
    "direction",
    "target",
    "window_start",
    "window_end",
    "confidence",
    "evaluator",
    "evaluator_version",
  ],
  properties: {
    metric_key: { type: "string", enum: [...BRAIN_METRIC_KEYS] },
    subject_key: { type: ["string", "null"] },
    direction: { type: "string", enum: [...EXPECTATION_DIRECTIONS] },
    baseline: { type: ["object", "null"], additionalProperties: true },
    target: { type: "object", additionalProperties: true },
    window_start: { type: "string", minLength: 10 },
    window_end: { type: "string", minLength: 10 },
    minimum_data: { type: ["object", "null"], additionalProperties: true },
    confounder_policy: { type: "string", enum: [...EXPECTATION_CONFOUNDER_POLICIES] },
    confidence: { type: "string", enum: [...EXPECTATION_CONFIDENCE] },
    evaluator: { type: "string", enum: [...EXPECTATION_EVALUATORS] },
    evaluator_version: { type: "string", minLength: 1 },
  },
};

// A specialist runs the BOUNDED READ LOOP (runChosenWithCoachReads, mode
// "conference"), so this schema is forwarded for the protocol turn as well as the
// final opinion: it spreads the coach_read protocol, names `kind`, and declares NO
// `required` at all — a coach_read turn carries none of the opinion's fields.
// isSpecialistOpinion still demands all nine keys of a FINAL payload, and the prose
// twin is what asks for them.
export const SPECIALIST_OPINION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    kind: { type: ["string", "null"] },
    domain: { type: "string", enum: [...SPECIALIST_DOMAINS] },
    recommendation: { type: "string", minLength: 1 },
    rationale: { type: "string", minLength: 1 },
    // normalizeSpecialistOpinion returns null on an EMPTY evidence_keys — an opinion
    // that cites nothing is not an opinion this conference can use.
    evidence_keys: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    risks: { type: "array", items: { type: "string" } },
    contraindications: { type: "array", items: { type: "string" } },
    uncertainties: { type: "array", items: { type: "string" } },
    // ONE malformed outcome voids the whole opinion (the normalizer returns null
    // rather than dropping the row), which is why this leaf is fully named.
    expected_outcomes: { type: "array", items: CONFERENCE_EXPECTATION_SCHEMA },
    autonomy_ceiling: { type: "string", enum: [...AUTONOMY_TIERS] },
    ...COACH_READ_PROTOCOL_PROPERTIES,
  },
};

// The executable half of a decision. Every key here is one strictPlanChange /
// strictPlanItem / strictPlanDay ALLOWS: those run `ownKeysAllowed`, so an extra
// named slot is not a harmless extra — a change that carries it is rejected whole.
// That is why `day_type` is absent from the restructure day (strictPlanDay allows
// day_number/name/focus/items only) and why the cardio family here is smaller than
// the plan proposal's.
const CONFERENCE_PLAN_CHANGE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["day_number"],
  properties: {
    day_number: { type: "integer", minimum: 1, maximum: 14 },
    exercise: { type: ["string", "null"] },
    remove: { type: ["boolean", "null"] },
    // Bounded 0..5000 by strictPlanChange — the conference lane does NOT carry the
    // assisted-negative convention the plan proposal does.
    target_weight: { type: ["number", "null"], minimum: 0, maximum: 5_000 },
    target_seconds: { type: ["integer", "null"], minimum: 1, maximum: 3_600 },
    sets: { type: ["integer", "null"], minimum: 0, maximum: 20 },
    rep_low: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    rep_high: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    reason: { type: ["string", "null"] },
    note: { type: ["string", "null"] },
    // No enum: the vocabulary is reps|timed, and a nullable enum is the construct an
    // enforcing backend is most likely to reject (see CONFIDENCE_SCHEMA).
    mode: { type: ["string", "null"], description: "reps|timed" },
    swap: {
      type: ["object", "null"],
      additionalProperties: true,
      required: ["from", "to"],
      properties: { from: { type: "string", minLength: 1 }, to: { type: "string", minLength: 1 } },
    },
  },
};

const CONFERENCE_PLAN_ITEM_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    exercise: { type: ["string", "null"] },
    sets: { type: ["integer", "null"], minimum: 1, maximum: 20 },
    rep_low: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    rep_high: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    target_weight: { type: ["number", "null"], minimum: 0, maximum: 5_000 },
    note: { type: ["string", "null"] },
    warmup_sets: { type: ["integer", "null"], minimum: 0, maximum: 20 },
    target_seconds: { type: ["integer", "null"], minimum: 1, maximum: 3_600 },
    superset_group: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    mode: { type: ["string", "null"], description: "reps|timed" },
    kind: { type: ["string", "null"], description: "strength|cardio" },
    target_distance_km: { type: ["number", "null"], minimum: 0, maximum: 1_000 },
    target_duration_min: { type: ["number", "null"], minimum: 0, maximum: 1_440 },
    target_zone: { type: ["string", "null"] },
    // An OBJECT here, not an array: strictPlanItem reads `interval` through asRecord,
    // unlike RUN_INTERVAL_SCHEMA on the plan-proposal side. An array would be rejected.
    interval: { type: ["object", "null"], additionalProperties: true },
    interval_json: { type: ["string", "null"] },
  },
};

// One node for a three-way union, because the top level must stay a single object
// and the prose twin already carries the oneOf. The exclusivity is REAL — strictRevision
// runs ownKeysAllowed per `type`, so a plan_update that also carries `days` is
// rejected whole — but it is not statable here without a union, so the prompt says it
// and the conductor's own contract line spells out the three exact shapes.
const CONFERENCE_REVISION_SCHEMA: JsonSchema = {
  type: ["object", "null"],
  additionalProperties: true,
  required: ["type", "summary"],
  properties: {
    type: { type: "string", enum: ["plan_update", "plan_restructure", "nutrition_target"] },
    summary: { type: ["string", "null"] },
    changes: { type: "array", minItems: 1, maxItems: 24, items: CONFERENCE_PLAN_CHANGE_SCHEMA },
    days: {
      type: "array",
      minItems: 1,
      maxItems: 14,
      items: {
        type: "object",
        additionalProperties: true,
        required: ["day_number", "name", "items"],
        properties: {
          day_number: { type: "integer", minimum: 1, maximum: 14 },
          name: { type: "string", minLength: 1 },
          focus: { type: ["string", "null"] },
          items: { type: "array", items: CONFERENCE_PLAN_ITEM_SCHEMA },
        },
      },
    },
    nutrition: {
      type: ["object", "null"],
      additionalProperties: true,
      // strictRevision demands all five keys are PRESENT, so all five are required
      // even though three of them are nullable.
      required: ["target_kcal", "protein_g", "carbs_g", "fat_g", "delta_kcal"],
      properties: {
        target_kcal: { type: "number", minimum: 1_200, maximum: 10_000 },
        protein_g: { type: "number", minimum: 0, maximum: 500 },
        carbs_g: { type: ["number", "null"], minimum: 0 },
        fat_g: { type: ["number", "null"], minimum: 0 },
        delta_kcal: { type: ["number", "null"], minimum: -500, maximum: 500 },
      },
    },
    notes: { type: ["string", "null"] },
  },
};

// The conductor does NOT run the read loop (runChosen, not runChosenWithCoachReads),
// so this schema carries no coach_read protocol and CAN require its payload's fields:
// normalizeStrictCaseConferenceDecision runs hasOwnProperties over all fourteen, and a
// decision missing one is not degraded, it is discarded for the deterministic fallback.
export const CASE_CONFERENCE_DECISION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: [
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
  ],
  properties: {
    kind: { type: "string", enum: ["case_conference"] },
    domain: { type: "string", enum: [...BRAIN_DOMAINS] },
    summary: { type: "string", minLength: 1 },
    rationale: { type: "string", minLength: 1 },
    risk_class: { type: "string", enum: [...BRAIN_RISK_CLASSES] },
    reversible: { type: "boolean" },
    // The server clamps this (decideAutonomyTier owns the answer); the conductor's
    // value is a REQUEST, and the schema keeps it inside the vocabulary.
    autonomy_tier: { type: "string", enum: [...AUTONOMY_TIERS] },
    parallel_actions: { type: "array", items: { type: "string" } },
    resolved_conflicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        // `evidence_key` is nullable at the contract boundary — an uncited claim
        // degrades to "unresolved" rather than voiding the decision — so it is named
        // but not required. `key` and `resolution` are what the normalizer drops a
        // row for, and a dropped row voids the whole strict decision.
        required: ["key", "resolution"],
        properties: {
          key: { type: "string", minLength: 1 },
          evidence_key: { type: ["string", "null"] },
          resolution: { type: "string", minLength: 1 },
        },
      },
    },
    deferred: { type: "array", items: { type: "string" } },
    expectations: { type: "array", items: CONFERENCE_EXPECTATION_SCHEMA },
    review_window: { type: "string", minLength: 1 },
    user_explanation: { type: "string", minLength: 1 },
    revision: CONFERENCE_REVISION_SCHEMA,
  },
};
