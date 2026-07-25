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

export type JsonSchema = Record<string, any>;

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

export function matchesJsonSchema(schema: JsonSchema | undefined, value: unknown): boolean {
  if (!schema || typeof schema !== "object") return true;
  const actual = typeOf(value);
  // NaN/Infinity survive neither JSON nor any numeric slot, and `undefined` is absence.
  if (actual === "invalid" || actual === "undefined" || actual === "function") return false;

  if (schema.type != null) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t: unknown) => matchesType(String(t), actual))) return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) return false;
  if ("const" in schema && schema.const !== value) return false;

  if (actual === "string") {
    const minLength = num(schema.minLength);
    if (minLength !== null && (value as string).length < minLength) return false;
    const maxLength = num(schema.maxLength);
    if (maxLength !== null && (value as string).length > maxLength) return false;
  }

  if (actual === "number" || actual === "integer") {
    const n = value as number;
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
    if (schema.items && !items.every((item) => matchesJsonSchema(schema.items, item))) return false;
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
      if (!matchesJsonSchema(sub, obj[key])) return false;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (obj[key] !== undefined && !(key in properties)) return false;
      }
    }
  }

  return true;
}
