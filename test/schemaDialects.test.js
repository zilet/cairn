// codex's --output-schema is OpenAI strict mode: every object closed, every property
// required. Cairn's contracts are neither, so codex 400'd every schema-bearing op in ~3 s
// (invalid_json_schema) and the classifier read the run as "rate_limited", holding the
// provider. The strict reading is derived per run and undone on the answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripStrictNulls, toOpenAiStrictSchema } from "../dist/schema-dialects.js";
import { matchesJsonSchema } from "../dist/json-schema.js";
import { classifyAgentFailure } from "../dist/agentAvailability.js";

const CONTRACT = {
  type: "object",
  required: ["found"],
  properties: {
    found: { type: "boolean" },
    text: { type: "string", minLength: 1 },
    tone: { type: "string", enum: ["calm", "warm"] },
    note: { type: ["string", "null"] },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, kcal: { type: "number", minimum: 0 } },
      },
    },
  },
};

test("every object closes and requires every property; optional ones turn nullable", () => {
  const strict = toOpenAiStrictSchema(CONTRACT);
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ["found", "text", "tone", "note", "items"]);
  assert.deepEqual(strict.properties.found, { type: "boolean" }, "a required field stays as it was");
  assert.deepEqual(
    strict.properties.text,
    { type: ["string", "null"] },
    "minLength is Cairn's to check, not strict mode's"
  );
  assert.deepEqual(strict.properties.tone.enum, ["calm", "warm", null]);
  assert.deepEqual(strict.properties.note, { type: ["string", "null"] }, "already nullable is left alone");
  const item = strict.properties.items.type.includes ? strict.properties.items : null;
  assert.ok(item);
  assert.deepEqual(strict.properties.items.items.required, ["name", "kcal"]);
  assert.equal(strict.properties.items.items.additionalProperties, false);
  assert.equal(strict.properties.items.items.properties.kcal.minimum, 0);
  assert.equal(CONTRACT.properties.text.minLength, 1, "the original contract is never mutated");
});

test("an open object (any fields) cannot be said in strict mode: no enforcement, never a broken schema", () => {
  const open = { type: "object", properties: { target: { type: "object", additionalProperties: true } } };
  assert.equal(toOpenAiStrictSchema(open), null);
  assert.equal(
    toOpenAiStrictSchema({ type: "string", enum: ["low", "high"] }),
    null,
    "only an object may sit at the top"
  );
});

test("the nulls strict mode forced come back out, so the answer reads as any provider's", () => {
  const answer = { found: true, text: null, tone: null, note: null, items: [{ name: "Oats", kcal: null }] };
  const back = stripStrictNulls(answer, CONTRACT);
  assert.deepEqual(back, { found: true, note: null, items: [{ name: "Oats" }] });
  assert.ok(matchesJsonSchema(back, CONTRACT, { coerce: true }));
});

test("a provider's 400 is a rejected request, never a rate limit that holds the provider", () => {
  const tail =
    'ERROR: { "type": "error", "error": { "type": "invalid_request_error", "code": "invalid_json_schema", "message": "Invalid schema" }, "status": 400 }';
  const failure = classifyAgentFailure("codex", { code: 1, raw: "… work capacity …", stderr: tail, signal: null });
  assert.equal(failure.state, "process_error");
  assert.match(failure.detail, /rejected the request/);
});
