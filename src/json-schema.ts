// A deliberately small JSON Schema evaluator.
//
// Cairn declares each strict agent contract ONCE, as a JSON Schema, and uses that
// single artifact in two places: it is handed to the CLI as an enforced structured-
// output schema (agents.json `structured_output`), and it is the structural conjunct
// of the operation's acceptance predicate (agent-contracts.ts). A schema that could
// disagree with the validator would be worse than no schema, so the validator LITERALLY
// RUNS the schema — the two cannot drift apart.
//
// Only the keyword subset those contracts actually use is implemented. An unknown
// keyword is ignored rather than treated as a failure: this evaluator's job is to be
// a faithful, total reading of the schemas in this repo, not a spec-complete
// validator. It never throws.
//
// ONE artifact, TWO readings. The CLI reads a schema STRICTLY — it constrains decoding,
// so a `{type:"integer"}` slot emits a real integer. Cairn's acceptance predicates read
// the same schema with `coerce`, because they also judge answers from providers that
// CANNOT enforce it (antigravity declares no structured output, the offline stub has
// none, and any run where flag placement failed is free-form too). Those answers are
// ordinary LLM JSON, where `"day_number": "1"` and `"kcal": "520"` are common — and
// Cairn's applier has always coerced them via Number(). A strict-only reading would
// reject payloads the prose contract has accepted since day one, burn the repair retry,
// and can end a rotation at {ok:false}. So the schema stays strict for enforcement and
// tolerant for acceptance; it is still one shape, read at two strengths.

export type JsonSchema = Record<string, any>;

export interface JsonSchemaReadOptions {
  /**
   * Let a STRING that parses to a finite number satisfy a numeric slot, mirroring the
   * `Number(v)` coercion the predicates used before the schema existed. Deliberately
   * narrower than bare `Number()` in one respect: null, booleans, arrays and blank
   * strings do NOT coerce. `Number(null) === 0` made `day_number: null` pass the old
   * predicate, which is a coincidence of coercion rather than anything the prose
   * contract ever solicited, and it would reach the applier as day 0.
   */
  coerce?: boolean;
}

/**
 * JSON Schema's type vocabulary for a runtime value. "integer" is reported for whole
 * numbers so an `{type:"integer"}` slot can be checked without a separate keyword;
 * `matchesType` still lets any integer satisfy `{type:"number"}`.
 */
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isFinite(value as number) ? (Number.isInteger(value as number) ? "integer" : "number") : "invalid";
  return t;
}

function matchesType(expected: string, actual: string): boolean {
  return expected === actual || (expected === "number" && actual === "integer");
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The numeric value a coercing read should judge, or null when this value must be
 * taken as-is. Only strings coerce, only into a slot that actually wants a number,
 * and only when the slot does not already accept a string outright.
 */
function coercedNumber(value: unknown, types: string[] | null): number | null {
  if (typeof value !== "string" || !types) return null;
  if (types.includes("string")) return null;
  if (!types.includes("number") && !types.includes("integer")) return null;
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function matchesJsonSchema(
  schema: JsonSchema | undefined,
  value: unknown,
  options: JsonSchemaReadOptions = {}
): boolean {
  if (!schema || typeof schema !== "object") return true;
  const declaredTypes = schema.type == null ? null : (Array.isArray(schema.type) ? schema.type : [schema.type]).map(String);

  // Coerce BEFORE every type and range check, so a coerced "195" is judged as 195
  // against `minimum`/`exclusiveMinimum` exactly as a native number would be.
  const coerced = options.coerce ? coercedNumber(value, declaredTypes) : null;
  const effective = coerced === null ? value : coerced;
  const actual = typeOf(effective);
  // NaN/Infinity survive neither JSON nor any numeric slot, and `undefined` is absence.
  if (actual === "invalid" || actual === "undefined" || actual === "function") return false;

  if (declaredTypes && !declaredTypes.some((t) => matchesType(t, actual))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(effective as never)) return false;
  if ("const" in schema && schema.const !== effective) return false;

  if (actual === "string") {
    const minLength = num(schema.minLength);
    if (minLength !== null && (value as string).length < minLength) return false;
    const maxLength = num(schema.maxLength);
    if (maxLength !== null && (value as string).length > maxLength) return false;
  }

  if (actual === "number" || actual === "integer") {
    const n = effective as number;
    const minimum = num(schema.minimum);
    if (minimum !== null && n < minimum) return false;
    const maximum = num(schema.maximum);
    if (maximum !== null && n > maximum) return false;
    const exclusiveMinimum = num(schema.exclusiveMinimum);
    if (exclusiveMinimum !== null && n <= exclusiveMinimum) return false;
  }

  if (actual === "array") {
    const items = value as unknown[];
    const minItems = num(schema.minItems);
    if (minItems !== null && items.length < minItems) return false;
    const maxItems = num(schema.maxItems);
    if (maxItems !== null && items.length > maxItems) return false;
    if (schema.items && !items.every((item) => matchesJsonSchema(schema.items, item, options))) return false;
  }

  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    const properties: Record<string, JsonSchema> =
      schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key !== "string" || obj[key] === undefined) return false;
      }
    }
    for (const [key, sub] of Object.entries(properties)) {
      // An absent optional property is not a violation; only a PRESENT one is checked.
      if (obj[key] === undefined) continue;
      if (!matchesJsonSchema(sub, obj[key], options)) return false;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (obj[key] !== undefined && !(key in properties)) return false;
      }
    }
  }

  return true;
}
