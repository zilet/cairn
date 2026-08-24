// Enforced structured output: the declarative capability in agents.json, its
// expansion into argv, the envelope unwrap a provider's schema flag can force, and
// — most importantly — that an op carrying a schema still succeeds on a provider
// that cannot enforce one.
//
// Fully offline: every "agent" here is a local `node -e` script, so nothing depends
// on an installed CLI, a login, or the network.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// AGENTS_CONFIG is read into a module-level const at import time, so it must be set
// BEFORE the dynamic import below.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-agents-fixture-"));
const fixturePath = path.join(fixtureDir, "agents.json");

// Each fake CLI is a script FILE, not `node -e`: with -e, node keeps parsing later
// argv as its OWN options and dies on `--json-schema`. A script path terminates node's
// option parsing, which is exactly how the real CLIs receive the flag.
function script(name, body) {
  const file = path.join(fixtureDir, name);
  fs.writeFileSync(file, body, "utf8");
  return file;
}

// Prints its own argv (and, for the file mode, the schema it was handed on disk) as
// the JSON payload, so a test can assert exactly what reached the CLI.
const ECHO_ARGV = script("echo-argv.cjs", "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }))");
const ECHO_SCHEMA_FILE = script(
  "echo-schema-file.cjs",
  "const fs=require('fs');const i=process.argv.indexOf('--output-schema');" +
    "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), schema_file_contents: JSON.parse(fs.readFileSync(process.argv[i+1],'utf8')) }))"
);
const ECHO_ENVELOPE = script(
  "echo-envelope.cjs",
  "process.stdout.write(JSON.stringify({ text: '{\"ok\":true,\"from\":\"text\"}', thought: 'raw reasoning that must never reach the op', structuredOutput: { ok: true, from: 'structured' } }))"
);
const ECHO_ENVELOPE_TEXT_ONLY = script(
  "echo-envelope-text.cjs",
  "process.stdout.write(JSON.stringify({ text: '{\"ok\":true,\"from\":\"text\"}', thought: 'noise' }))"
);
const ECHO_PLAIN = script("echo-plain.cjs", "process.stdout.write(JSON.stringify({ ok: true, from: 'plain' }))");
const PLAN_PAYLOAD = script(
  "plan-payload.cjs",
  "process.stdout.write(JSON.stringify({ summary: 'Nudge the squat.', changes: [{ day_number: 1, exercise: 'Back Squat', target_weight: 195, reason: 'progression' }] }))"
);
const PROSE_ONLY = script("prose-only.cjs", "process.stdout.write('I am prose, not JSON.')");
const ECHO_BARE_PAYLOAD = script(
  "echo-bare-payload.cjs",
  "process.stdout.write(JSON.stringify({ ok: true, from: 'bare' }))"
);
const ECHO_INSIGHT_BARE = script(
  "echo-insight-bare.cjs",
  "process.stdout.write(JSON.stringify({ found: true, text: 'Your sleep tracks your easy runs.' }))"
);
const ECHO_ENVELOPE_STRING = script(
  "echo-envelope-string.cjs",
  "process.stdout.write(JSON.stringify({ structuredOutput: '{\"ok\":true,\"from\":\"string\"}', thought: 'noise', usage: {} }))"
);

const inlineFlag = { flag: ["--json-schema", "{schema}"], arg: "inline" };

fs.writeFileSync(
  fixturePath,
  JSON.stringify({
    // Declares inline structured output AND the {schema_args} slot — the claude/grok shape.
    inline: {
      command: "node",
      args: [ECHO_ARGV, "{schema_args}", "{prompt}"],
      input: "arg",
      structured_output: inlineFlag,
    },
    // Declares a schema FILE — the codex shape.
    filed: {
      command: "node",
      args: [ECHO_SCHEMA_FILE, "{schema_args}", "{prompt}"],
      input: "arg",
      structured_output: { flag: ["--output-schema", "{schema_file}"], arg: "file" },
    },
    // Enabling the flag rewrites stdout into an envelope around the payload.
    enveloped: {
      command: "node",
      args: [ECHO_ENVELOPE, "{schema_args}", "{prompt}"],
      input: "arg",
      structured_output: { ...inlineFlag, envelope: { structured_key: "structuredOutput", text_key: "text" } },
    },
    envelopedTextOnly: {
      command: "node",
      args: [ECHO_ENVELOPE_TEXT_ONLY, "{schema_args}", "{prompt}"],
      input: "arg",
      structured_output: { ...inlineFlag, envelope: { structured_key: "structuredOutput", text_key: "text" } },
    },
    // Declares an envelope but has NO {schema_args} slot: the flag can never reach the
    // CLI, so the run must NOT be treated as enveloped.
    envelopeNoSlot: {
      command: "node",
      args: [ECHO_PLAIN, "{prompt}"],
      input: "arg",
      structured_output: { ...inlineFlag, envelope: { structured_key: "structuredOutput", text_key: "text" } },
    },
    // No structured_output at all — the antigravity/stub shape.
    plain: {
      command: "node",
      args: [ECHO_ARGV, "{prompt}"],
      input: "arg",
    },
    // A well-formed proposal, from an agent that cannot enforce a schema.
    plainProposal: {
      command: "node",
      args: [PLAN_PAYLOAD, "{prompt}"],
      input: "arg",
    },
    broken: {
      command: "node",
      args: [PROSE_ONLY, "{prompt}"],
      input: "arg",
    },
    // Flag placed (envelope declared) but the CLI still emits the contract directly.
    envelopedBare: {
      command: "node",
      args: [ECHO_BARE_PAYLOAD, "{schema_args}", "{prompt}"],
      input: "arg",
      structured_output: { ...inlineFlag, envelope: { structured_key: "structuredOutput", text_key: "text" } },
    },
    // Insight-shaped payload: its own `text` field collides with grok's text_key.
    envelopedInsightBare: {
      command: "node",
      args: [ECHO_INSIGHT_BARE, "{schema_args}", "{prompt}"],
      input: "arg",
      structured_output: { ...inlineFlag, envelope: { structured_key: "structuredOutput", text_key: "text" } },
    },
    envelopedString: {
      command: "node",
      args: [ECHO_ENVELOPE_STRING, "{schema_args}", "{prompt}"],
      input: "arg",
      structured_output: { ...inlineFlag, envelope: { structured_key: "structuredOutput", text_key: "text" } },
    },
  }),
  "utf8"
);
process.env.AGENTS_CONFIG = fixturePath;

const { agentSupportsStructuredOutput, runAgent, runAgentWithFallback } = await import("../dist/agents.js");
const { matchesJsonSchema } = await import("../dist/json-schema.js");
const {
  MEAL_PLAN_STRUCTURE_SCHEMA,
  MEAL_SWAP_SCHEMA,
  DAY_READ_SCHEMA,
  INSIGHT_SCHEMA,
  PLAN_PROPOSAL_SCHEMA,
  WEEK_AHEAD_SCHEMA,
  isInsightResult,
  isMealPlanStructureResult,
  isMealSwapResult,
  isPlanProposalResult,
  isWeekAheadResult,
} = await import("../dist/agent-contracts.js");

const SCHEMA = { type: "object", additionalProperties: true, properties: { ok: { type: "boolean" } } };

test("structured-output support is declared, not inferred", () => {
  assert.equal(agentSupportsStructuredOutput("inline"), true);
  assert.equal(agentSupportsStructuredOutput("filed"), true);
  assert.equal(agentSupportsStructuredOutput("plain"), false);
  assert.equal(agentSupportsStructuredOutput("nonexistent"), false);
});

test("an inline schema reaches the CLI as its declared flag", async () => {
  const res = await runAgent("inline", "hello", { schema: SCHEMA });
  const argv = res.parsed.argv;
  assert.equal(argv[0], "--json-schema");
  assert.deepEqual(JSON.parse(argv[1]), SCHEMA);
  assert.equal(argv[2], "hello");
});

test("no schema requested leaves argv byte-for-byte unchanged", async () => {
  const res = await runAgent("inline", "hello");
  assert.deepEqual(res.parsed.argv, ["hello"]);
});

test("an agent with no declaration silently ignores a schema", async () => {
  const res = await runAgent("plain", "hello", { schema: SCHEMA });
  assert.deepEqual(res.parsed.argv, ["hello"]);
});

test("a file-mode schema is written to disk, read by the CLI, and cleaned up", async () => {
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("cairn-schema-"));
  const res = await runAgent("filed", "hello", { schema: SCHEMA });
  assert.equal(res.parsed.argv[0], "--output-schema");
  // The path must have existed and held the schema at spawn time.
  assert.deepEqual(res.parsed.schema_file_contents, SCHEMA);
  const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("cairn-schema-"));
  assert.deepEqual(after, before, "the per-run schema directory must not outlive the run");
});

test("an enveloping provider yields the payload, never the envelope", async () => {
  const res = await runAgent("enveloped", "hello", { schema: SCHEMA });
  assert.deepEqual(res.parsed, { ok: true, from: "structured" });
  assert.equal(res.parsed.thought, undefined, "raw reasoning must never reach the operation");
});

test("an envelope missing its structured field falls back to the text field", async () => {
  const res = await runAgent("envelopedTextOnly", "hello", { schema: SCHEMA });
  assert.deepEqual(res.parsed, { ok: true, from: "text" });
});

test("the envelope unwrap is inert when the flag could not reach the CLI", async () => {
  // No {schema_args} slot ⇒ the provider never enveloped anything. Unwrapping anyway
  // would blank a perfectly good plain response.
  const res = await runAgent("envelopeNoSlot", "hello", { schema: SCHEMA });
  assert.deepEqual(res.parsed, { ok: true, from: "plain" });
});

test("an enveloping provider that still emits the bare payload yields the payload", async () => {
  const res = await runAgent("envelopedBare", "hello", { schema: SCHEMA });
  assert.deepEqual(res.parsed, { ok: true, from: "bare" });
});

test("a bare insight payload is not discarded because its text field collides with grok's text_key", async () => {
  const res = await runAgent("envelopedInsightBare", "hello", { schema: SCHEMA });
  assert.deepEqual(res.parsed, { found: true, text: "Your sleep tracks your easy runs." });
});

test("a string-valued structured field is re-parsed into the payload", async () => {
  const res = await runAgent("envelopedString", "hello", { schema: SCHEMA });
  assert.deepEqual(res.parsed, { ok: true, from: "string" });
});

test("an op carrying a schema still succeeds on a provider that cannot enforce one", async () => {
  const { agent, result } = await runAgentWithFallback(["broken", "plainProposal"], "propose", {
    schema: PLAN_PROPOSAL_SCHEMA,
    acceptParsed: isPlanProposalResult,
  });
  assert.equal(agent, "plainProposal");
  assert.equal(isPlanProposalResult(result.parsed), true);
});

test("every shipped schema is a single top-level object", () => {
  // Empirically required: `claude --json-schema` with a top-level anyOf is rejected
  // (API 400, "input_schema.type: Field required"). A union contract must stay in the
  // acceptance predicate instead.
  for (const [name, schema] of Object.entries({
    PLAN_PROPOSAL_SCHEMA,
    WEEK_AHEAD_SCHEMA,
    MEAL_PLAN_STRUCTURE_SCHEMA,
    MEAL_SWAP_SCHEMA,
    DAY_READ_SCHEMA,
    INSIGHT_SCHEMA,
  })) {
    assert.equal(schema.type, "object", `${name} must declare a top-level object type`);
    assert.equal(schema.anyOf, undefined, `${name} must not use a top-level anyOf`);
    assert.equal(schema.oneOf, undefined, `${name} must not use a top-level oneOf`);
  }
});

test("every field the prose contract solicits is NAMED in the schema", () => {
  // An open node PERMITS an unnamed field; it does not make the model emit one.
  // Measured live (claude 2.1.220, open days[].items[]): target_distance_km and
  // target_duration_min survived, but target_zone and muscle_group were DROPPED and
  // folded into `note` as "target_zone: Z2, conversational pace". So openness is not
  // the mitigation — naming is. These lists mirror the prose twins in
  // src/prompt/coach.ts, src/prompt/health.ts and src/prompt/nutrition.ts.
  const props = (schema) => Object.keys(schema.properties ?? {});
  const daysItems = PLAN_PROPOSAL_SCHEMA.properties.days.items.properties.items.items;
  for (const field of ["target_distance_km", "target_duration_min", "target_zone", "muscle_group", "superset_group"]) {
    assert.ok(props(daysItems).includes(field), `days[].items[] must name ${field}`);
  }
  const change = PLAN_PROPOSAL_SCHEMA.properties.changes.items;
  for (const field of ["target_distance_km", "target_duration_min", "target_zone", "kind", "label"]) {
    assert.ok(props(change).includes(field), `changes[] must name ${field} (a kind:"cardio" change takes them)`);
  }
  const cardio = PLAN_PROPOSAL_SCHEMA.properties.cardio.items;
  for (const field of ["exercise", "day_name", "focus", "interval"]) {
    assert.ok(props(cardio).includes(field), `cardio[] must name ${field}`);
  }
  const meal = MEAL_PLAN_STRUCTURE_SCHEMA.properties.days.items.properties.meals.items;
  for (const field of ["items", "carbs_g", "fat_g"]) {
    assert.ok(props(meal).includes(field), `a meal must name ${field}`);
  }
  for (const field of ["summary", "shopping", "practicality", "nutrition_pattern", "notes"]) {
    assert.ok(props(MEAL_PLAN_STRUCTURE_SCHEMA).includes(field), `the meal plan must name ${field}`);
  }
  for (const field of ["day", "note"]) {
    assert.ok(props(WEEK_AHEAD_SCHEMA.properties.days.items).includes(field), `a week-ahead day must name ${field}`);
  }
  for (const field of ["kind", "headline", "why", "focus", "est_minutes", "requests"]) {
    assert.ok(props(DAY_READ_SCHEMA).includes(field), `day-read must name ${field}`);
  }
  for (const field of ["found", "text", "connection", "rationale", "next_step", "requests"]) {
    assert.ok(props(INSIGHT_SCHEMA).includes(field), `insight must name ${field}`);
  }
  const insightSide = INSIGHT_SCHEMA.properties.connection.properties.a;
  for (const field of ["facet", "direction"]) {
    assert.ok(props(insightSide).includes(field), `insight connection.a must name ${field}`);
  }
});

test("every object node stays open, as a floor under the naming above", () => {
  const openEverywhere = (schema, trail) => {
    if (!schema || typeof schema !== "object") return;
    if (schema.type === "object" || schema.properties) {
      assert.equal(schema.additionalProperties, true, `${trail} must set additionalProperties: true`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) openEverywhere(sub, `${trail}.${key}`);
    if (schema.items) openEverywhere(schema.items, `${trail}[]`);
  };
  openEverywhere(PLAN_PROPOSAL_SCHEMA, "PLAN_PROPOSAL_SCHEMA");
  openEverywhere(WEEK_AHEAD_SCHEMA, "WEEK_AHEAD_SCHEMA");
  openEverywhere(MEAL_PLAN_STRUCTURE_SCHEMA, "MEAL_PLAN_STRUCTURE_SCHEMA");
  openEverywhere(MEAL_SWAP_SCHEMA, "MEAL_SWAP_SCHEMA");
  openEverywhere(DAY_READ_SCHEMA, "DAY_READ_SCHEMA");
  openEverywhere(INSIGHT_SCHEMA, "INSIGHT_SCHEMA");
});

test("the schema evaluator reads the keyword subset the contracts use", () => {
  assert.equal(matchesJsonSchema({ type: "object" }, { a: 1 }), true);
  assert.equal(matchesJsonSchema({ type: "object" }, [1]), false);
  assert.equal(matchesJsonSchema({ type: "object" }, null), false);
  // integer satisfies number, but not the reverse
  assert.equal(matchesJsonSchema({ type: "number" }, 2), true);
  assert.equal(matchesJsonSchema({ type: "integer" }, 2.5), false);
  assert.equal(matchesJsonSchema({ type: ["number", "null"] }, null), true);
  assert.equal(matchesJsonSchema({ type: "number" }, Number.NaN), false);
  assert.equal(matchesJsonSchema({ type: "string", minLength: 1 }, ""), false);
  assert.equal(matchesJsonSchema({ enum: ["lift", "rest"] }, "run"), false);
  assert.equal(matchesJsonSchema({ type: "number", exclusiveMinimum: 0 }, 0), false);
  assert.equal(matchesJsonSchema({ type: "number", minimum: 0 }, 0), true);
  assert.equal(matchesJsonSchema({ type: "array", minItems: 2 }, [1]), false);
  assert.equal(matchesJsonSchema({ type: "array", items: { type: "string" } }, ["a", 1]), false);
  // required means present-and-defined; an absent optional property is fine
  assert.equal(matchesJsonSchema({ type: "object", required: ["a"] }, {}), false);
  assert.equal(matchesJsonSchema({ type: "object", properties: { a: { type: "string" } } }, {}), true);
  assert.equal(matchesJsonSchema({ type: "object", properties: { a: { type: "string" } } }, { a: 1 }), false);
  // an open node keeps unknown fields; a closed one rejects them
  assert.equal(matchesJsonSchema({ type: "object", additionalProperties: true }, { extra: 1 }), true);
  assert.equal(matchesJsonSchema({ type: "object", additionalProperties: false }, { extra: 1 }), false);
  assert.equal(matchesJsonSchema(undefined, { anything: true }), true);
});

test("a schema-shaped payload that misses the operation's semantics is still rejected", () => {
  // The schema is a conjunct, not the whole contract: structure can pass while the
  // residual semantics (a change must name an exercise or a swap) fail.
  assert.equal(matchesJsonSchema(PLAN_PROPOSAL_SCHEMA, { summary: "x", changes: [{ day_number: 1 }] }), true);
  assert.equal(isPlanProposalResult({ summary: "x", changes: [{ day_number: 1 }] }), false);
  // ...and structure alone can fail while the old shape-only reading would have passed.
  assert.equal(isPlanProposalResult({ summary: "x", changes: [{ day_number: 1, exercise: "Squat" }] }), true);
  assert.equal(isPlanProposalResult({ summary: "   ", changes: [{ day_number: 1, exercise: "Squat" }] }), false);
});

test("the strict reading is what the CLI gets: a numeric slot means a number", () => {
  // Enforcement side. Nothing relaxes here — constrained decoding emits a real number,
  // and the invariant tests above hand the CLI exactly these schemas.
  assert.equal(matchesJsonSchema({ type: "integer" }, "1"), false);
  assert.equal(matchesJsonSchema({ type: "number", exclusiveMinimum: 0 }, "520"), false);
  assert.equal(matchesJsonSchema(PLAN_PROPOSAL_SCHEMA, { summary: "x", changes: [{ day_number: "1" }] }), false);
});

test("the coercing reading accepts the numeric strings a non-enforcing provider emits", () => {
  // Acceptance side. antigravity declares no structured output and the stub has none,
  // so their answers are free-form JSON where "1" for an integer is ordinary — and the
  // applier has always coerced via Number(). Rejecting these burned the repair retry
  // and could end a rotation at {ok:false}.
  const coerce = { coerce: true };
  assert.equal(matchesJsonSchema({ type: "integer" }, "1", coerce), true);
  assert.equal(matchesJsonSchema({ type: "integer" }, "1.5", coerce), false, "still not a whole number");
  assert.equal(matchesJsonSchema({ type: "number", exclusiveMinimum: 0 }, "520", coerce), true);
  // the coerced value is judged against the range, not waved past it
  assert.equal(matchesJsonSchema({ type: "number", exclusiveMinimum: 0 }, "0", coerce), false);
  assert.equal(matchesJsonSchema({ type: "integer", minimum: 1 }, "0", coerce), false);
  assert.equal(matchesJsonSchema({ type: "number" }, "not a number", coerce), false);
  // a slot that already takes a string is never reinterpreted as a number
  assert.equal(matchesJsonSchema({ type: ["string", "number"] }, "12", coerce), true);
  assert.equal(matchesJsonSchema({ type: "string", minLength: 2 }, "12", coerce), true);
  // narrower than bare Number(): these are coercion coincidences, not contract values
  for (const junk of [null, true, [], ""]) {
    assert.equal(matchesJsonSchema({ type: "integer" }, junk, coerce), false, `${JSON.stringify(junk)} is not a number`);
  }
  // ...but a slot that MEANS null still takes null
  assert.equal(matchesJsonSchema({ type: ["number", "null"] }, null, coerce), true);
});

test("the acceptance predicates accept numeric strings end to end", () => {
  // The regression this restores, at the predicate level rather than the evaluator's.
  assert.equal(isPlanProposalResult({ summary: "x", changes: [{ day_number: "1", exercise: "Back Squat" }] }), true);
  assert.equal(isMealSwapResult({ name: "Bowl", kcal: "520", protein_g: "40", fiber_g: "9" }), true);
  const day = (n) => ({ day: `Day ${n}`, meals: [{ name: "Meal", kcal: "800", protein_g: "60", fiber_g: "10" }] });
  assert.equal(
    isMealPlanStructureResult({
      daily_kcal: "2400",
      daily_protein_g: "180",
      daily_fiber_g: "30",
      days: [day(1), day(2), day(3), day(4), day(5)],
    }),
    true
  );
  // Coercion widens the numeric slots only — every other guard still bites.
  assert.equal(isMealSwapResult({ name: "Bowl", kcal: "0", protein_g: "40", fiber_g: "9" }), false);
  assert.equal(isMealSwapResult({ name: "   ", kcal: "520", protein_g: "40", fiber_g: "9" }), false);
  assert.equal(isPlanProposalResult({ summary: "x", changes: [{ day_number: "nope", exercise: "Squat" }] }), false);
});

function namedFields(schema, trail = "") {
  const out = [];
  if (!schema || typeof schema !== "object") return out;
  if (schema.items) out.push(...namedFields(schema.items, trail ? `${trail}[]` : "[]"));
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    const path = trail ? `${trail}.${key}` : key;
    out.push(path);
    out.push(...namedFields(sub, path));
  }
  return out;
}

test("parser-read fields are a subset of the schema's named fields", () => {
  // Constrained decoding DROPS unnamed fields. The lists below are the fields each
  // op's parser actually reads (acceptance predicate + post-accept sanitizer /
  // persist). Every one must appear in the schema the CLI is handed.
  const coachReadArgs = [
    "requests[].args.exercise",
    "requests[].args.start_date",
    "requests[].args.end_date",
    "requests[].args.limit",
    "requests[].args.weeks",
    "requests[].args.marker",
    "requests[].args.days",
    "requests[].args.kind",
    "requests[].args.subject_key",
    "requests[].args.scope",
    "requests[].args.day_number",
    "requests[].args.day",
  ];
  const cases = [
    {
      name: "DAY_READ_SCHEMA",
      schema: DAY_READ_SCHEMA,
      parserFields: [
        "kind",
        "headline",
        "why",
        "focus",
        "est_minutes",
        "requests",
        "requests[].tool",
        "requests[].args",
        ...coachReadArgs,
      ],
    },
    {
      name: "INSIGHT_SCHEMA",
      schema: INSIGHT_SCHEMA,
      parserFields: [
        "kind",
        "found",
        "text",
        "rationale",
        "next_step",
        "connection",
        "connection.a",
        "connection.a.facet",
        "connection.a.direction",
        "connection.b",
        "connection.b.facet",
        "connection.b.direction",
        "requests",
        "requests[].tool",
        "requests[].args",
        ...coachReadArgs,
      ],
    },
    {
      name: "WEEK_AHEAD_SCHEMA",
      schema: WEEK_AHEAD_SCHEMA,
      parserFields: ["summary", "days", "days[].kind", "days[].label", "days[].day", "days[].note"],
    },
  ];
  for (const { name, schema, parserFields } of cases) {
    const named = new Set(namedFields(schema));
    for (const field of parserFields) {
      assert.ok(named.has(field), `${name} must name parser field ${field}`);
    }
  }
  assert.equal(isWeekAheadResult({ summary: "Lift then rest.", days: [{ kind: "lift", label: "Lower" }] }), false);
  assert.equal(isInsightResult({ found: true, text: "Your easy runs are protecting the lifts." }), true);
  assert.equal(isInsightResult({ found: false }), true);
});
