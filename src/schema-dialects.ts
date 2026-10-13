// A provider-specific reading of one Cairn contract schema.
//
// codex's `--output-schema` is OpenAI structured outputs in STRICT mode, which refuses a
// schema (HTTP 400 `invalid_json_schema`, before any model call) unless every object
// sets `additionalProperties: false` and lists EVERY property in `required`. Cairn's
// contracts leave fields optional and say nothing of additionalProperties, so every
// codex run with a schema failed in ~3 s — measured live 2026-10-13 on codex-cli 0.160,
// and on the Pi as a run of "rate_limited" case-conference attempts.
//
// The strict reading is derived, never hand-kept: an optional property becomes REQUIRED
// but NULLABLE, so the model may still decline it — and `stripStrictNulls` removes those
// nulls on the way back, so the operation reads the same payload any other provider
// returns. The schema Cairn validates against (json-schema.ts) is the original, untouched.
//
// What strict mode cannot say at all — an open object ("any fields", no properties) —
// makes the whole schema inexpressible: `toOpenAiStrictSchema` returns null and the run
// keeps the prose contract, exactly as a provider with no structured output does.
import type { JsonSchema } from "./json-schema.js";

// Validation keywords strict mode rejects. Cairn's own validator still holds them.
const STRICT_UNSUPPORTED = new Set(["minLength", "maxLength"]);

class Inexpressible extends Error {}

function isObjectSchema(s: JsonSchema): boolean {
  const t = s.type;
  return t === "object" || (Array.isArray(t) && t.includes("object")) || (!!s.properties && t === undefined);
}

function allowsNull(s: JsonSchema): boolean {
  if (!s || typeof s !== "object") return true;
  const t = s.type;
  if (t === "null" || (Array.isArray(t) && t.includes("null"))) return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  if (Array.isArray(s.anyOf) && s.anyOf.some((b: JsonSchema) => allowsNull(b))) return true;
  return t === undefined && !s.enum && !s.anyOf && !s.oneOf && !s.properties;
}

function nullable(s: JsonSchema): JsonSchema {
  if (allowsNull(s)) return s;
  if (typeof s.type === "string") {
    const out: JsonSchema = { ...s, type: [s.type, "null"] };
    if (Array.isArray(s.enum)) out.enum = [...s.enum, null];
    return out;
  }
  if (Array.isArray(s.type)) {
    const out: JsonSchema = { ...s, type: [...s.type, "null"] };
    if (Array.isArray(s.enum)) out.enum = [...s.enum, null];
    return out;
  }
  return { anyOf: [s, { type: "null" }] };
}

function strict(s: JsonSchema): JsonSchema {
  if (!s || typeof s !== "object" || Array.isArray(s)) return s;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(s)) {
    if (STRICT_UNSUPPORTED.has(key)) continue;
    if (key === "properties" || key === "required" || key === "additionalProperties") continue;
    if (key === "items") out.items = strict(value as JsonSchema);
    else if (key === "anyOf" || key === "oneOf") out.anyOf = (value as JsonSchema[]).map(strict);
    else out[key] = value;
  }
  if (isObjectSchema(s)) {
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    const keys = Object.keys(props);
    if (!keys.length) throw new Inexpressible();
    const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
    out.properties = Object.fromEntries(
      keys.map((key) => [key, required.has(key) ? strict(props[key]) : nullable(strict(props[key]))])
    );
    out.required = keys;
    out.additionalProperties = false;
  }
  return out;
}

/** The OpenAI strict-mode reading of a contract schema, or null when strict mode cannot express it. */
export function toOpenAiStrictSchema(schema: JsonSchema): JsonSchema | null {
  // Strict mode takes only an object at the top (a bare fragment answers 400 at once).
  if (!schema || typeof schema !== "object" || schema.type !== "object") return null;
  try {
    return strict(schema);
  } catch (err) {
    if (err instanceof Inexpressible) return null;
    throw err;
  }
}

/**
 * Undo what the strict reading forced: a property the ORIGINAL schema left optional, and
 * that never allowed null there, came back null only because strict mode made it required.
 * Drop it, so the payload reads exactly as an unconstrained provider's would.
 */
export function stripStrictNulls(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema || typeof schema !== "object" || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return schema.items ? value.map((item) => stripStrictNulls(item, schema.items)) : value;
  }
  const branches = [
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
  ];
  const objectBranch = branches.find((b: JsonSchema) => b && isObjectSchema(b));
  const s = isObjectSchema(schema) ? schema : objectBranch;
  if (!s?.properties) return value;
  const required = new Set<string>(Array.isArray(s.required) ? s.required : []);
  const rec = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(rec)) {
    const prop = (s.properties as Record<string, JsonSchema>)[key];
    if (v === null && prop && !required.has(key) && !allowsNull(prop)) continue;
    out[key] = prop ? stripStrictNulls(v, prop) : v;
  }
  return out;
}
