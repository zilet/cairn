// The enforced-schema surface of src/agent-contracts.ts.
//
// Cairn built enforced structured output end to end and then attached it at nine
// call sites; the rest of the agentic ops asked for their shape in prose only. These
// tests guard the invariants that make attaching a schema SAFE rather than merely
// present:
//
//   1. Every exported schema is ONE top-level object. A top-level anyOf is rejected
//      outright by the claude CLI, so a union has to live in the predicate.
//   2. A schema used by a bounded-read op names the coach_read protocol. One schema
//      is forwarded for BOTH the protocol turn and the final payload, so a schema
//      that omits `requests` makes a read request structurally impossible under
//      constrained decoding and kills depth-on-demand silently.
//   3. Every field a consumer actually READS is named. Constrained decoding drops
//      what a schema does not mention, and `additionalProperties: true` permits an
//      unnamed field without making the model emit one. Checking this needs a
//      SET-INCLUSION walk over `schema.properties` against a hand-listed set of
//      consumer-read paths — feeding a sample payload through matchesJsonSchema
//      proves nothing here, because an open node accepts every unnamed field.
//   4. The schema never offers the decoder a value its consumer treats as fatal.
//      Naming a field is only half the job: `sets: 0` and `interval: []` are legal
//      JSON that make the session normalizer throw away the whole payload, so the
//      bounds have to say so.
//
// Fully offline: the one round-trip probe drives runChosenWithCoachReads through its
// injected `run`/`execute` deps, so no CLI, login or network is involved.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as contracts from "../dist/agent-contracts.js";
import { matchesJsonSchema } from "../dist/json-schema.js";
import { runChosenWithCoachReads } from "../dist/runChosen.js";
import { SYMPTOM_CAPTURE_JSON_SCHEMA } from "../dist/symptomCapture.js";
import { normalizeStrictCaseConferenceDecision } from "../dist/brain/case-conference-contract.js";
import { isSpecialistOpinion } from "../dist/brain/specialist-contract.js";

const exportedSchemas = Object.entries(contracts).filter(
  ([name, value]) => name.endsWith("_SCHEMA") && value && typeof value === "object"
);

// The ops that run through runChosenWithCoachReads (directly, or via
// runChosenStreaming's boundedReads opt-in). Each forwards ONE schema for the whole
// loop.
const READ_LOOP_SCHEMA_NAMES = new Set([
  "DAY_READ_SCHEMA",
  "INSIGHT_SCHEMA",
  "SESSION_SUGGESTION_SCHEMA",
  "NUTRITION_CHECKIN_SCHEMA",
  "HEALTH_REVIEW_SCHEMA",
  "HEALTH_SYNTHESIS_SCHEMA",
  // Each specialist runs the conference read loop (mode "conference"); the
  // conductor does NOT, so CASE_CONFERENCE_DECISION_SCHEMA is deliberately absent.
  "SPECIALIST_OPINION_SCHEMA",
]);
const READ_LOOP_SCHEMAS = exportedSchemas.filter(([name]) => READ_LOOP_SCHEMA_NAMES.has(name));

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

test("every exported contract schema is one top-level object with no top-level union", () => {
  assert.ok(exportedSchemas.length >= 20, "expected the whole contract surface to be exported");
  for (const [name, schema] of exportedSchemas) {
    assert.equal(schema.type, "object", `${name} must declare a top-level type "object"`);
    for (const keyword of ["anyOf", "oneOf", "allOf", "not"]) {
      assert.equal(schema[keyword], undefined, `${name} must not carry a top-level ${keyword}`);
    }
    assert.equal(schema.additionalProperties, true, `${name} must keep its top-level node open`);
  }
});

test("no schema requires a field it does not name", () => {
  // A `required` entry with no matching property is a slot the decoder is told to
  // fill and given no shape for — the one way a schema can be internally inconsistent
  // without any validator here noticing.
  const walk = (name, schema, trail) => {
    if (!schema || typeof schema !== "object") return;
    for (const key of schema.required ?? []) {
      assert.ok(
        schema.properties && key in schema.properties,
        `${name}${trail} requires "${key}" without naming it`
      );
    }
    if (schema.items) walk(name, schema.items, `${trail}[]`);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) walk(name, sub, `${trail}.${key}`);
  };
  for (const [name, schema] of exportedSchemas) walk(name, schema, "");
  walk("SYMPTOM_CAPTURE_JSON_SCHEMA", SYMPTOM_CAPTURE_JSON_SCHEMA, "");
});

test("every read-loop schema names the coach_read protocol and admits a bare read turn", () => {
  const readTurn = {
    kind: "coach_read",
    requests: [{ tool: "read_training_window", args: { end_date: null, weeks: 6 } }],
  };
  assert.equal(
    READ_LOOP_SCHEMAS.length,
    READ_LOOP_SCHEMA_NAMES.size,
    "every read-loop schema must be exported under its expected name"
  );
  for (const [name, schema] of READ_LOOP_SCHEMAS) {
    const named = new Set(namedFields(schema));
    for (const field of ["kind", "requests", "requests[].tool", "requests[].args", "requests[].args.weeks"]) {
      assert.ok(named.has(field), `${name} must name the coach_read field ${field}`);
    }
    // A protocol turn carries NONE of the final payload's fields, so a read-loop
    // schema may only require what the turn itself has.
    for (const key of schema.required ?? []) {
      assert.ok(key in readTurn, `${name} requires "${key}", which a coach_read turn does not carry`);
    }
    assert.ok(
      matchesJsonSchema(schema, readTurn, { coerce: true }),
      `${name} must admit a bare coach_read turn`
    );
  }
});

test("a schema'd read-loop op still issues its reads and forwards the schema on every turn", async () => {
  // The regression this guards: pinning a FINAL-only schema on a bounded-read op
  // drops `requests` under constrained decoding, and depth-on-demand dies without an
  // error anywhere. Drive the real loop and assert the read happened.
  const seenSchemas = [];
  const executed = [];
  const turns = [
    {
      kind: "coach_read",
      requests: [{ tool: "read_training_window", args: { end_date: null, weeks: 6 } }],
    },
    { name: "Lower — quad focus", why: "Recovery held.", items: [{ exercise: "Back Squat", sets: 3 }] },
  ];
  const out = await runChosenWithCoachReads(
    "auto",
    "SNAPSHOT BASELINE",
    { op: "session_suggest", timeoutMs: 5_000, schema: contracts.SESSION_SUGGESTION_SCHEMA },
    {},
    {
      run: async (_agent, _prompt, opts) => {
        seenSchemas.push(opts.schema);
        const parsed = turns.shift();
        return { agent: "terra", result: { code: 0, raw: JSON.stringify(parsed), stderr: "", parsed, usage: {} }, tried: [] };
      },
      execute: async (request) => {
        executed.push(request);
        return { tool: "read_training_window", data: { events: [] }, rows_returned: 0, truncated: false };
      },
      createRunId: () => "run-schema",
    }
  );

  assert.equal(executed.length, 1, "the read request must reach the executor");
  assert.equal(executed[0].tool, "read_training_window");
  assert.equal(seenSchemas.length, 2, "both the protocol turn and the final turn run");
  for (const schema of seenSchemas) assert.equal(schema, contracts.SESSION_SUGGESTION_SCHEMA);
  assert.equal(out.result.parsed.name, "Lower — quad focus");
});

test("each new schema admits a well-formed payload (over-restriction guard)", () => {
  const ok = (schema, value) => matchesJsonSchema(schema, value, { coerce: true });
  assert.ok(
    ok(contracts.SESSION_SUGGESTION_SCHEMA, {
      name: "Lower",
      focus: "quads",
      why: "Fresh legs.",
      est_minutes: 45,
      items: [
        { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185, mode: "reps",
          top_set: { sets: 1, reps: 3, target_weight: 205, rir: 1, note: "one strong triple" } },
        { exercise: "Assisted Pull-up", sets: 3, target_weight: -30, superset_group: 1 },
        { exercise: "Plank", sets: 2, target_seconds: 45, mode: "timed" },
        { kind: "cardio", exercise: "Easy run", target_distance_km: 6, target_zone: "Z2" },
      ],
    })
  );
  // Assisted (negative) and bodyweight (null) loads must both survive the schema.
  assert.ok(ok(contracts.SESSION_SUGGESTION_SCHEMA, { items: [{ exercise: "Push-up", target_weight: null }] }));
  assert.ok(
    ok(contracts.NUTRITION_CHECKIN_SCHEMA, {
      change: true,
      summary: "Nudging intake up.",
      nutrition: { target_kcal: 2100, protein_g: 175, carbs_g: null, fat_g: 70, reason: "trend" },
    })
  );
  assert.ok(ok(contracts.NUTRITION_CHECKIN_SCHEMA, { change: false, summary: "Holding." }));
  assert.ok(
    ok(contracts.RECIPE_SCHEMA, {
      summary: "A quick bowl.",
      time_min: 20,
      servings: 2,
      ingredients: [{ item: "Chicken thigh", qty: "300 g" }],
      steps: ["Sear the chicken."],
      tips: ["Double the batch."],
    })
  );
  assert.ok(ok(contracts.EXERCISE_EXPLANATION_SCHEMA, { setup: "Brace.", move: "Sit back.", feel: "Quads.", avoid: "Rounding." }));
  assert.equal(ok(contracts.EXERCISE_EXPLANATION_SCHEMA, { setup: "Brace.", move: "Sit back." }), false);
  assert.ok(
    ok(contracts.HEALTH_REVIEW_SCHEMA, {
      headline: "Lipids lead.",
      wins: ["Ferritin recovered"],
      watchlist: [{ marker: "ApoB", status: "high", why: "Above optimal", action: "More soluble fiber", citation: null }],
      not_worried: { markers: ["CK"], note: "Training-driven." },
      focus: [{ title: "Lipids", why: "Highest leverage", action: "Swap red meat twice" }],
      followups: [{ what: "Retest ApoB", when: "in 12 weeks" }],
      directives: [{ domain: "nutrition", marker: "ApoB", directive: "Raise soluble fiber", rationale: "ApoB up", citation: null }],
    })
  );
  assert.ok(
    ok(contracts.HEALTH_SYNTHESIS_SCHEMA, {
      found: true,
      headline: "Lipids.",
      story: "They connect.",
      priorities: [{ label: "Lipids", why_it_matters: "ASCVD", the_move: "Fiber", recheck: null }],
      one_change: "More oats.",
    })
  );
  assert.ok(
    ok(contracts.MARKER_RECONCILE_SCHEMA, { groups: [{ canonical: "eGFR", unit: "mL/min", members: ["eGFR", "Est GFR"] }] })
  );
  assert.ok(
    ok(contracts.EXERCISE_RECONCILE_SCHEMA, {
      groups: [{ members: ["incline db press"], canonical: "Incline DB Press", group: "chest", mode: "reps" }],
      merges: [{ from: "Squat", into: "Back Squat", why: "same lift", confidence: "high" }],
    })
  );
  assert.ok(ok(contracts.REACTION_NARRATIVE_SCHEMA, { narrative: "You bounce back fast." }));
  assert.equal(ok(contracts.REACTION_NARRATIVE_SCHEMA, { narrative: "" }), false);
  assert.ok(ok(contracts.CHAT_DISTILL_SCHEMA, { memories: [{ content: "Trains fasted", kind: "preference" }], farewell: null }));
  assert.ok(
    ok(contracts.MEMORY_CONSOLIDATION_SCHEMA, {
      merges: [{ ids: [1, 2], content: "Trains mornings", kind: "preference" }],
      supersedes: [{ id: 3, reason: "switched to evenings", replacement: null }],
      promotions: [{ id: 4, kind: "preference", content: null }],
    })
  );
  assert.ok(ok(contracts.ABOUT_ME_GROWTH_SCHEMA, { about_me: "A hybrid athlete.", changed: true }));
  assert.ok(
    ok(contracts.ONBOARD_SCHEMA, {
      about_me: "Runner and lifter.",
      profile: { sex: "male", age: 41, height_cm: 180, weight_lb: 178, goal_weight_lb: 164, goal_date: "2026-10-20", days_per_week: 5 },
      goal: "lose",
      supplements: [{ name: "Creatine", dose: "5 g", frequency: "daily", category: "performance", related_markers: ["eGFR"] }],
      memories: [{ content: "Trains fasted", kind: "preference" }],
      context_events: [{ kind: "injury", title: "Wrist", detail: null, meta: { area: "wrist", severity: "mild" } }],
    })
  );
  assert.ok(
    ok(contracts.RESEARCH_SCHEMA, {
      summary: "Fiber lowers ApoB.",
      claims: [{ claim: "Soluble fiber lowers ApoB", body: "…", marker: "ApoB", confidence: "moderate", sources: [{ title: "AHA", url: "https://x" }] }],
      sources: [{ title: "AHA", url: "https://x" }],
    })
  );
  assert.ok(
    ok(contracts.FOOD_PHOTO_SCHEMA, {
      summary: "Eggs and toast",
      items: ["scrambled eggs"],
      ingredients: [{ item: "Egg", amount: "2 eggs", kcal: 140, protein_g: 12, fiber_g: 0, basis: "photo" }],
      kcal: 420,
      protein_g: 24,
      carbs_g: 38,
      fat_g: 18,
      fiber_g: 4,
      nutrition_pattern: { sodium: "moderate", saturated_fat_g: 5, omega_3_source: false, confidence: "low", basis: "photo" },
      notes: null,
      confidence: "low",
      basis: "photo",
    })
  );
  assert.ok(ok(contracts.FOOD_ENRICH_SCHEMA, { structured: { summary: "Oats", kcal: 350, ingredients: [] }, memory: [] }));
  assert.ok(
    ok(contracts.ACTIVITY_ENRICH_SCHEMA, {
      structured: { type: "run", duration_min: 42, distance_km: 7.5, pace: "5:35/km", rpe: 4, notes: null },
      memory: [],
    })
  );
  assert.ok(
    ok(contracts.GARMIN_STRENGTH_SCHEMA, {
      summary: "Steady effort.",
      intensity: "moderate",
      // null = bodyweight, negative = assisted: both must pass.
      sets: [
        { exercise: "Back Squat", weight: 185, reps: 5, mode: "reps" },
        { exercise: "Assisted Pull-up", weight: -30, reps: 8, mode: "reps" },
        { exercise: "Plank", weight: null, duration_sec: 45, mode: "timed" },
      ],
      extrapolated: true,
    })
  );
  assert.ok(
    ok(contracts.EXERCISE_ENRICH_SCHEMA, {
      canonical: "Incline DB Press",
      muscle_group: "chest",
      mode: "reps",
      equipment: "dumbbells",
      garmin_category: "BENCH_PRESS",
      garmin_exercise: null,
    })
  );
  assert.ok(
    ok(contracts.HEALTH_INGEST_SCHEMA, {
      panels: [
        {
          doc_date: "2026-08-24",
          kind: "labs",
          summary: "Lipids up.",
          marker_count: 2,
          markers: [
            { name: "LDL-C", value: 132, unit: "mg/dL", flag: "high", ref_low: null, ref_high: 100 },
            // A qualitative result is a real lab answer.
            { name: "Urine Culture", value: "Negative", unit: null, flag: null },
          ],
        },
      ],
      clinical_facts: [{ kind: "medication", date: null, name: "Atorvastatin", status: "active", detail: null, source: "Medications" }],
      imaging_studies_complete: true,
      imaging_studies: [],
      summary: "One panel.",
      memory: [],
    })
  );
  assert.ok(
    ok(contracts.IMAGING_STUDY_JSON_SCHEMA, {
      imaging_study: {
        schema_version: 1,
        report_status: "final",
        study: { modality: "MR", raw_modality: "MRI", procedure: "MRI Knee", study_date: "2026-05-02" },
        anatomy: { clinical_system: "musculoskeletal", body_region: "knee", laterality: "left", code: null },
        report: { impression: "Mild effusion." },
        findings: [
          {
            id: "f1",
            source: "report",
            clinical_system: "musculoskeletal",
            body_region: "knee",
            finding_text: "Mild joint effusion.",
            severity: "mild",
            certainty: "probable",
            measurements: [{ name: "effusion", value: 4.2, unit: "mm" }],
            source_spans: [{ file_id: 1, page: 2, text: "effusion" }],
          },
        ],
        recommendations: [{ id: "r1", source: "report", recommendation_text: "Clinical correlation.", status: "recommended", source_spans: [] }],
        provenance: { source_kind: "report", extraction: "agent", extractor: "claude", confidence: "medium" },
        verification: { needs_confirmation: true, user_confirmed: false },
        dicom: { study_instance_uid: null, series: [] },
      },
    })
  );
  assert.ok(
    ok(SYMPTOM_CAPTURE_JSON_SCHEMA, {
      found: true,
      reports: [
        {
          quote: "my right wrist aches on presses",
          area_label: "right wrist",
          scope: "area",
          change: "worse",
          movements: [{ name: "Incline DB Press", outcome: "pain_present" }],
        },
      ],
    })
  );
  assert.ok(ok(SYMPTOM_CAPTURE_JSON_SCHEMA, { found: false }));
  // The closed vocabularies coerceSymptomCapture rejects outright are real enums.
  assert.equal(ok(SYMPTOM_CAPTURE_JSON_SCHEMA, { found: true, reports: [{ quote: "x", scope: "whole", change: "worse" }] }), false);
});

test("the verify contract carries the DRAFT's own schema in fixed_draft", () => {
  // An open object node there would be gutted by constrained decoding — which is the
  // one slot whose entire job is to carry a whole corrected draft.
  const schema = contracts.verifyResultSchema(contracts.MEAL_PLAN_STRUCTURE_SCHEMA);
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["ok", "violations"]);
  assert.deepEqual(schema.properties.fixed_draft.type, ["object", "null"]);
  const named = new Set(namedFields(schema));
  for (const field of ["fixed_draft.days", "fixed_draft.days[].meals", "fixed_draft.days[].meals[].protein_g"]) {
    assert.ok(named.has(field), `the verify schema must name ${field}`);
  }
  assert.ok(matchesJsonSchema(schema, { ok: true, violations: [], fixed_draft: null }, { coerce: true }));
});

test("the two ops that ran without a contract now have one", () => {
  // distillChat and consolidateMemory passed no acceptParsed, so ANY parseable object
  // stopped the rotation — including another op's payload from a confused CLI.
  assert.equal(contracts.isChatDistillResult({ memories: [] }), true);
  assert.equal(contracts.isChatDistillResult({ farewell: "bye" }), false);
  assert.equal(contracts.isChatDistillResult({ summary: "a plan proposal" }), false);
  assert.equal(contracts.isChatDistillResult(null), false);

  // The librarian is the deliberate exception to the strictness above: its prose says
  // each list is optional and empty arrays are a perfectly good answer, and
  // consolidateMemory treats an empty result as a clean no-op. So a nightly pass over
  // an already-tidy store must be ACCEPTED however thinly it answers — the predicate
  // only rejects a librarian slot that came back as something other than a list.
  // Emitting all three keys is enforced on the CLI side by the schema's `required`.
  assert.equal(contracts.isMemoryConsolidationResult({ merges: [], supersedes: [], promotions: [] }), true);
  assert.equal(contracts.isMemoryConsolidationResult({ promotions: [{ id: 1, kind: "preference" }] }), true);
  assert.equal(contracts.isMemoryConsolidationResult({}), true);
  assert.equal(contracts.isMemoryConsolidationResult({ merges: "none" }), false);
  assert.equal(contracts.isMemoryConsolidationResult(null), false);
  assert.deepEqual(contracts.MEMORY_CONSOLIDATION_SCHEMA.required, ["merges", "supersedes", "promotions"]);
});

// The consumer-read path sets below are hand-derived by READING each consumer, not
// by sampling a payload. Each entry is "every key this consumer dereferences off the
// agent payload", including the alternate spellings it accepts via `??`. A schema may
// name more than its consumer reads (the prose solicits fields nothing consumes yet);
// it may never name less, because constrained decoding drops what is unnamed and an
// open node does not save it.
//
// This is the guard the earlier suite lacked: `matchesJsonSchema(schema, payload)`
// passes for ANY unnamed field, so none of the five coverage defects this table was
// written for would have failed it.
const CONSUMER_READS = [
  {
    schema: "SESSION_SUGGESTION_SCHEMA",
    // normalizeSessionPayload + normalizeItem (src/repo/adaptive-session.ts) and
    // normalizePrescriptionItem (src/contracts/session-prescription.ts).
    consumer: "normalizeSessionSuggestionResult",
    fields: [
      "name",
      "title",
      "focus",
      "why",
      "est_minutes",
      "items",
      "items[].kind",
      "items[].exercise",
      "items[].sets",
      "items[].rep_low",
      "items[].rep_high",
      "items[].target_reps",
      "items[].target_weight",
      "items[].target_seconds",
      "items[].mode",
      "items[].note",
      "items[].superset_group",
      "items[].warmup_sets",
      "items[].target_distance_km",
      "items[].target_duration_min",
      "items[].target_zone",
      "items[].interval",
      "items[].interval_json",
      "items[].top_set",
      "items[].top_set.sets",
      "items[].top_set.reps",
      "items[].top_set.target_weight",
      "items[].top_set.target_seconds",
      "items[].top_set.rir",
      "items[].top_set.note",
    ],
  },
  {
    schema: "HEALTH_INGEST_SCHEMA",
    // ingestPanels / cleanMarkers / the clinical-fact flatMap (src/enrich.ts) and
    // insertHealthPanels (src/repo/health.ts).
    consumer: "applyHealthIngest",
    fields: [
      "panels",
      "panels[].doc_date",
      "panels[].kind",
      "panels[].type",
      "panels[].summary",
      "panels[].marker_count",
      "panels[].markers",
      "panels[].markers[].name",
      "panels[].markers[].value",
      "panels[].markers[].unit",
      "panels[].markers[].flag",
      "panels[].markers[].ref_low",
      "panels[].markers[].ref_high",
      "panels[].clinical_facts",
      "panels[].clinical_facts[].kind",
      "panels[].clinical_facts[].date",
      "panels[].clinical_facts[].name",
      "panels[].clinical_facts[].status",
      "panels[].clinical_facts[].detail",
      "panels[].clinical_facts[].source",
      "clinical_facts",
      "clinical_facts[].kind",
      "clinical_facts[].name",
      "imaging_studies",
      "imaging_studies[].imaging_study",
      "imaging_studies_complete",
      "summary",
      "memory",
      "memory[].content",
      "memory[].kind",
    ],
  },
  {
    schema: "IMAGING_STUDY_JSON_SCHEMA",
    // coerceImagingStudy / cleanFindings / cleanRecommendations / cleanMeasurements
    // (src/repo/imaging.ts), alternate spellings included.
    consumer: "coerceImagingStudy",
    fields: [
      "imaging_study.report_status",
      "imaging_study.study.modality",
      "imaging_study.study.raw_modality",
      "imaging_study.study.procedure",
      "imaging_study.study.accession",
      "imaging_study.study.study_instance_uid",
      "imaging_study.study.study_date",
      "imaging_study.study.issued_at",
      "imaging_study.study.facility",
      "imaging_study.study.ordering_clinician",
      "imaging_study.study.interpreting_clinician",
      "imaging_study.anatomy.clinical_system",
      "imaging_study.anatomy.body_region",
      "imaging_study.anatomy.verbatim_site",
      "imaging_study.anatomy.laterality",
      "imaging_study.anatomy.code",
      "imaging_study.report.history",
      "imaging_study.report.technique",
      "imaging_study.report.comparison",
      "imaging_study.report.findings",
      "imaging_study.report.impression",
      "imaging_study.report.addendum",
      "imaging_study.findings[].id",
      "imaging_study.findings[].source",
      "imaging_study.findings[].clinical_system",
      "imaging_study.findings[].system",
      "imaging_study.findings[].anatomy",
      "imaging_study.findings[].body_region",
      "imaging_study.findings[].verbatim_site",
      "imaging_study.findings[].site",
      "imaging_study.findings[].laterality",
      "imaging_study.findings[].finding_text",
      "imaging_study.findings[].text",
      "imaging_study.findings[].finding",
      "imaging_study.findings[].severity",
      "imaging_study.findings[].certainty",
      "imaging_study.findings[].measurements[].name",
      "imaging_study.findings[].measurements[].label",
      "imaging_study.findings[].measurements[].value",
      "imaging_study.findings[].measurements[].value_text",
      "imaging_study.findings[].measurements[].unit",
      "imaging_study.findings[].measurements[].qualifier",
      "imaging_study.findings[].measurements[].method",
      "imaging_study.findings[].source_spans[].file_id",
      "imaging_study.findings[].source_spans[].page",
      "imaging_study.findings[].source_spans[].start",
      "imaging_study.findings[].source_spans[].end",
      "imaging_study.findings[].source_spans[].text",
      "imaging_study.recommendations[].id",
      "imaging_study.recommendations[].source",
      "imaging_study.recommendations[].recommendation_text",
      "imaging_study.recommendations[].text",
      "imaging_study.recommendations[].timeframe",
      "imaging_study.recommendations[].action",
      "imaging_study.recommendations[].status",
      "imaging_study.provenance.source_kind",
      "imaging_study.provenance.extraction",
      "imaging_study.provenance.extractor",
      "imaging_study.provenance.source_doc_id",
      "imaging_study.provenance.source_hash",
      "imaging_study.provenance.confidence",
      "imaging_study.provenance.record_status",
      "imaging_study.provenance.source_amended_at",
      "imaging_study.provenance.source_amendment",
      "imaging_study.verification.needs_confirmation",
      "imaging_study.verification.user_confirmed",
      "imaging_study.verification.user_confirmed_at",
      "imaging_study.verification.clinician_confirmed_at",
      "imaging_study.verification.corrected_at",
      "imaging_study.verification.notes",
      "imaging_study.dicom.study_instance_uid",
      "imaging_study.dicom.series",
    ],
  },
  {
    schema: "RESEARCH_SCHEMA",
    // validateSources + the claims walk (src/research.ts).
    consumer: "validateSources",
    fields: [
      "summary",
      "claims",
      "claims[].claim",
      "claims[].body",
      "claims[].marker",
      "claims[].confidence",
      "claims[].sources",
      "claims[].sources[].title",
      "claims[].sources[].url",
      "claims[].sources[].version",
      "claims[].sources[].published_at",
      "claims[].sources[].source_scope",
      "claims[].sources[].scope",
      "sources[].title",
      "sources[].url",
      "sources[].version",
      "sources[].published_at",
      "sources[].source_scope",
      "sources[].scope",
    ],
  },
  {
    schema: "FOOD_PHOTO_SCHEMA",
    // applyFoodPhoto (src/enrich.ts) through coerceFoodItems / coerceFoodIngredients /
    // coerceNutritionPattern / coerceFoodProvenance (src/foodCapture.ts).
    consumer: "applyFoodPhoto",
    fields: [
      "summary",
      "items",
      "ingredients",
      "ingredients[].item",
      "ingredients[].name",
      "ingredients[].food",
      "ingredients[].amount",
      "ingredients[].qty",
      "ingredients[].quantity",
      "ingredients[].portion",
      "ingredients[].kcal",
      "ingredients[].protein_g",
      "ingredients[].carbs_g",
      "ingredients[].fat_g",
      "ingredients[].fiber_g",
      "ingredients[].basis",
      "kcal",
      "protein_g",
      "carbs_g",
      "fat_g",
      "fiber_g",
      "nutrition_pattern",
      "nutrition_pattern.sodium",
      "nutrition_pattern.potassium",
      "nutrition_pattern.calcium",
      "nutrition_pattern.iron",
      "nutrition_pattern.saturated_fat",
      "nutrition_pattern.added_sugar",
      "nutrition_pattern.saturated_fat_g",
      "nutrition_pattern.unsaturated_fat_g",
      "nutrition_pattern.omega_3_source",
      "nutrition_pattern.alcohol_servings",
      "nutrition_pattern.caffeine_mg",
      "nutrition_pattern.caffeine_time",
      "nutrition_pattern.food_quality",
      "nutrition_pattern.confidence",
      "nutrition_pattern.basis",
      "notes",
      "confidence",
      "basis",
    ],
  },
  {
    schema: "ACTIVITY_ENRICH_SCHEMA",
    consumer: "the activity enrichment applier",
    fields: [
      "structured.type",
      "structured.duration_min",
      "structured.distance_km",
      "structured.pace",
      "structured.rpe",
      "structured.notes",
      "memory",
      "memory[].content",
      "memory[].kind",
    ],
  },
  {
    schema: "GARMIN_STRENGTH_SCHEMA",
    // agentGarminSetInputs + updateSessionGarminNarrative (src/enrich.ts).
    consumer: "processGarminStrengthJob",
    fields: [
      "summary",
      "intensity",
      "sets",
      "sets[].exercise",
      "sets[].weight",
      "sets[].reps",
      "sets[].duration_sec",
      "sets[].mode",
    ],
  },
  {
    schema: "EXERCISE_ENRICH_SCHEMA",
    consumer: "applyExerciseEnrichment",
    fields: ["canonical", "muscle_group", "group", "mode", "equipment", "garmin_category", "garmin_exercise"],
  },
  {
    schema: "EXERCISE_RECONCILE_SCHEMA",
    // planExerciseAliases (src/repo/exercise-canon.ts) + the merges walk in coachOps.
    consumer: "reconcileExercises",
    fields: [
      "groups",
      "groups[].members",
      "groups[].canonical",
      "groups[].group",
      "groups[].muscle_group",
      "groups[].mode",
      "merges",
      "merges[].from",
      "merges[].into",
      "merges[].confidence",
    ],
  },
  {
    schema: "MARKER_RECONCILE_SCHEMA",
    consumer: "planMarkerMerges",
    fields: ["groups", "groups[].members", "groups[].canonical", "groups[].unit"],
  },
  {
    schema: "MEMORY_CONSOLIDATION_SCHEMA",
    consumer: "applyMemoryConsolidation",
    fields: [
      "merges",
      "merges[].ids",
      "merges[].content",
      "merges[].kind",
      "supersedes",
      "supersedes[].id",
      "supersedes[].reason",
      "supersedes[].replacement",
      "promotions",
      "promotions[].id",
      "promotions[].kind",
      "promotions[].content",
    ],
  },
  {
    schema: "CHAT_DISTILL_SCHEMA",
    consumer: "saveDistilledMemories",
    fields: ["memories", "memories[].content", "memories[].kind", "farewell"],
  },
  {
    schema: "ONBOARD_SCHEMA",
    consumer: "onboardFromText",
    fields: [
      "about_me",
      "profile.sex",
      "profile.age",
      "profile.height_cm",
      "profile.weight_lb",
      "profile.goal_weight_lb",
      "profile.goal_date",
      "profile.days_per_week",
      "supplements",
      "supplements[].name",
      "memories",
      "memories[].content",
      "memories[].kind",
      "context_events",
      "context_events[].kind",
      "context_events[].title",
      "context_events[].detail",
      "context_events[].start_date",
      "context_events[].end_date",
      "context_events[].meta",
      "movement_considerations",
      "movement_considerations[].label",
      "movement_considerations[].detail",
      "movement_considerations[].wants_addressed",
    ],
  },
  {
    schema: "NUTRITION_CHECKIN_SCHEMA",
    consumer: "isNutritionCheckinResult + runNutritionCheckin",
    fields: ["change", "summary", "nutrition.target_kcal", "nutrition.protein_g", "nutrition.reason"],
  },
  {
    schema: "REACTION_NARRATIVE_SCHEMA",
    consumer: "refreshReactionNarrative",
    fields: ["narrative"],
  },
  {
    schema: "ABOUT_ME_GROWTH_SCHEMA",
    consumer: "growAboutMe",
    fields: ["about_me", "changed"],
  },
  {
    schema: "EXERCISE_EXPLANATION_SCHEMA",
    consumer: "isExerciseExplanationResult",
    fields: ["setup", "move", "feel"],
  },
  {
    schema: "RECIPE_SCHEMA",
    consumer: "isRecipeResult",
    fields: ["ingredients", "ingredients[].item", "steps"],
  },
  {
    schema: "SPECIALIST_OPINION_SCHEMA",
    // normalizeSpecialistOpinion + isSpecialistOpinion (src/brain/specialist-contract.ts),
    // whose expected_outcomes each go through normalizeProposedExpectation.
    consumer: "isSpecialistOpinion",
    fields: [
      "domain",
      "recommendation",
      "rationale",
      "evidence_keys",
      "risks",
      "contraindications",
      "uncertainties",
      "expected_outcomes",
      "expected_outcomes[].metric_key",
      "expected_outcomes[].subject_key",
      "expected_outcomes[].direction",
      "expected_outcomes[].baseline",
      "expected_outcomes[].target",
      "expected_outcomes[].window_start",
      "expected_outcomes[].window_end",
      "expected_outcomes[].minimum_data",
      "expected_outcomes[].confounder_policy",
      "expected_outcomes[].confidence",
      "expected_outcomes[].evaluator",
      "expected_outcomes[].evaluator_version",
      "autonomy_ceiling",
    ],
  },
  {
    schema: "CASE_CONFERENCE_DECISION_SCHEMA",
    // normalizeStrictCaseConferenceDecision + normalizeCaseConferenceDecision
    // (src/brain/case-conference-contract.ts), including every key strictRevision
    // ALLOWS through ownKeysAllowed — a revision may name no others.
    consumer: "normalizeStrictCaseConferenceDecision",
    fields: [
      "kind",
      "domain",
      "summary",
      "rationale",
      "risk_class",
      "reversible",
      "autonomy_tier",
      "parallel_actions",
      "resolved_conflicts",
      "resolved_conflicts[].key",
      "resolved_conflicts[].evidence_key",
      "resolved_conflicts[].resolution",
      "deferred",
      "expectations",
      "expectations[].metric_key",
      "expectations[].evaluator_version",
      "review_window",
      "user_explanation",
      "revision",
      "revision.type",
      "revision.summary",
      "revision.changes",
      "revision.changes[].day_number",
      "revision.changes[].exercise",
      "revision.changes[].remove",
      "revision.changes[].target_weight",
      "revision.changes[].target_seconds",
      "revision.changes[].sets",
      "revision.changes[].rep_low",
      "revision.changes[].rep_high",
      "revision.changes[].reason",
      "revision.changes[].note",
      "revision.changes[].mode",
      "revision.changes[].swap",
      "revision.changes[].swap.from",
      "revision.changes[].swap.to",
      "revision.days",
      "revision.days[].day_number",
      "revision.days[].name",
      "revision.days[].focus",
      "revision.days[].items",
      "revision.days[].items[].exercise",
      "revision.days[].items[].sets",
      "revision.days[].items[].rep_low",
      "revision.days[].items[].rep_high",
      "revision.days[].items[].target_weight",
      "revision.days[].items[].note",
      "revision.days[].items[].warmup_sets",
      "revision.days[].items[].target_seconds",
      "revision.days[].items[].superset_group",
      "revision.days[].items[].mode",
      // strictPlanItem still READS kind (to refuse anything but strength); the run
      // field family is no longer admitted by PLAN_ITEM_KEYS (migration 110).
      "revision.days[].items[].kind",
      "revision.nutrition",
      "revision.nutrition.target_kcal",
      "revision.nutrition.protein_g",
      "revision.nutrition.carbs_g",
      "revision.nutrition.fat_g",
      "revision.nutrition.delta_kcal",
      "revision.notes",
    ],
  },
];

test("every field a consumer reads is named in the schema handed to the decoder", () => {
  const byName = new Map(exportedSchemas);
  const symptomPair = {
    schema: "SYMPTOM_CAPTURE_JSON_SCHEMA",
    consumer: "coerceSymptomCapture",
    fields: [
      "found",
      "reports",
      "reports[].quote",
      "reports[].area_label",
      "reports[].scope",
      "reports[].change",
      "reports[].movements",
      "reports[].movements[].name",
      "reports[].movements[].outcome",
    ],
  };
  byName.set(symptomPair.schema, SYMPTOM_CAPTURE_JSON_SCHEMA);

  for (const { schema, consumer, fields } of [...CONSUMER_READS, symptomPair]) {
    const target = byName.get(schema);
    assert.ok(target, `${schema} must be exported`);
    const named = new Set(namedFields(target));
    const missing = fields.filter((field) => !named.has(field));
    assert.deepEqual(missing, [], `${schema} does not name what ${consumer} reads: ${missing.join(", ")}`);
  }
});

test("the session schema never offers a value the session normalizer treats as fatal", () => {
  // normalizePrescriptionItem throws on a PRESENT field from the other family, and
  // `present()` counts 0 and []. These are the exact payloads the review reproduced.
  const item = contracts.SESSION_SUGGESTION_SCHEMA.properties.items.items;
  const ok = (value) => matchesJsonSchema(contracts.SESSION_SUGGESTION_SCHEMA, { items: [value] }, { coerce: true });

  // Nothing that lands in a cross-family guard may be expressible as a zero.
  for (const field of [
    "sets",
    "rep_low",
    "rep_high",
    "target_reps",
    "target_seconds",
    "warmup_sets",
    "target_distance_km",
    "target_duration_min",
  ]) {
    assert.equal(item.properties[field].exclusiveMinimum, 0, `items[].${field} must be exclusiveMinimum 0`);
    assert.equal(ok({ exercise: "Back Squat", [field]: 0 }), false, `a 0 ${field} must not validate`);
    // null stays the way to say "not this family".
    assert.equal(ok({ exercise: "Back Squat", [field]: null }), true, `a null ${field} must stay legal`);
  }

  // An empty interval array is the array-shaped version of the same defect.
  assert.deepEqual(item.properties.interval.type, ["array", "null"]);
  assert.equal(item.properties.interval.minItems, 1);
  assert.equal(ok({ exercise: "Back Squat", interval: [] }), false, "an empty interval must not validate");
  assert.equal(ok({ exercise: "Back Squat", interval: null }), true);
  assert.equal(ok({ kind: "cardio", exercise: "Intervals", interval: [{ reps: 6, on: "400m" }] }), true);

  const topSet = item.properties.top_set;
  assert.deepEqual(topSet.type, ["object", "null"]);
  assert.equal(topSet.properties.sets.exclusiveMinimum, 0);
  assert.equal(topSet.properties.reps.exclusiveMinimum, 0);
  assert.equal(ok({ exercise: "Back Squat", top_set: { sets: 0, reps: 3 } }), false);
  assert.equal(ok({ exercise: "Back Squat", top_set: { sets: 1, reps: 3, target_weight: null, rir: 0 } }), true);

  // And the ordinary session still passes.
  assert.equal(ok({ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 }), true);
  assert.equal(ok({ kind: "cardio", exercise: "Easy run", target_duration_min: 40 }), true);
});

test("the plan schema still ADMITS the values the session schema rejects", () => {
  // The two schemas want OPPOSITE bounds on the same numeric slots, so both directions
  // need a test or the next tightening silently becomes a rejection.
  //
  // The asymmetry is not taste. The session schema is only ever handed to a decoder,
  // and its consumer throws the whole payload away on a 0. The plan schema is ALSO an
  // acceptance gate — isPlanProposalResult runs matchesJsonSchema over it — and its
  // applier clamps those same values harmlessly (`it.sets ?? 3`). So a bound tightened
  // there does not steer the coach, it rejects a usable proposal and burns the
  // rotation. Runs left the plan schema (migration 110), so the law now rides the
  // strength slots that remain.
  const zeroItem = (field) => ({ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, [field]: 0 });
  const proposals = {};
  for (const field of ["sets", "rep_low", "rep_high", "warmup_sets", "target_seconds"]) {
    proposals[`a days item with a zero ${field}`] = {
      summary: "First week.",
      days: [{ day_number: 1, name: "Lower", items: [zeroItem(field)] }],
    };
  }
  for (const field of ["sets", "rep_low", "rep_high", "target_seconds"]) {
    proposals[`a change with a zero ${field}`] = {
      summary: "Adjust.",
      changes: [{ day_number: 1, exercise: "Back Squat", [field]: 0 }],
    };
  }
  // A legacy restructure that still carries a run item is admitted — the applier
  // strips it (strengthDaysOnly), it is never the gate's reason to burn the rotation.
  proposals["a legacy days item carrying a run with an empty interval"] = {
    summary: "First week.",
    days: [
      {
        day_number: 1,
        name: "Lower",
        items: [
          { exercise: "Back Squat", sets: 3 },
          { kind: "cardio", exercise: "Easy run", target_duration_min: 40, interval: [] },
        ],
      },
    ],
  };
  for (const [what, proposal] of Object.entries(proposals)) {
    assert.ok(
      matchesJsonSchema(contracts.PLAN_PROPOSAL_SCHEMA, proposal, { coerce: true }),
      `PLAN_PROPOSAL_SCHEMA must still admit ${what}`
    );
    // The gate the rotation actually runs, not just the schema in isolation.
    assert.equal(contracts.isPlanProposalResult(proposal), true, `isPlanProposalResult must accept ${what}`);
  }

  // The plan side's bounds are permissive minimums, never exclusive ones.
  const planItem = contracts.PLAN_PROPOSAL_SCHEMA.properties.days.items.properties.items.items;
  for (const field of ["sets", "rep_low", "rep_high", "warmup_sets", "target_seconds"]) {
    assert.equal(planItem.properties[field].exclusiveMinimum, undefined, `days items[].${field}`);
    assert.equal(planItem.properties[field].minimum, 0, `days items[].${field}`);
  }

  // And the session node keeps its own strict bounds — including the run family, which
  // a SESSION suggestion may still carry.
  const item = contracts.SESSION_SUGGESTION_SCHEMA.properties.items.items;
  const sessionOk = (value) => matchesJsonSchema(contracts.SESSION_SUGGESTION_SCHEMA, { items: [value] }, { coerce: true });
  for (const field of ["sets", "rep_low", "rep_high", "warmup_sets", "target_seconds"]) {
    assert.equal(item.properties[field].exclusiveMinimum, 0);
    assert.equal(sessionOk(zeroItem(field)), false, `the session schema rejects a zero ${field}`);
  }
  assert.equal(item.properties.target_distance_km.exclusiveMinimum, 0);
  assert.equal(item.properties.target_duration_min.exclusiveMinimum, 0);
  assert.equal(item.properties.interval.minItems, 1);
});

test("the plan schema offers no run slots, and a run-only payload is not a plan proposal", () => {
  // Plan days hold strength only (migration 110): the week's runs come from the stated
  // run days and the run engine, never from a proposal.
  assert.equal(contracts.PLAN_PROPOSAL_SCHEMA.properties.cardio, undefined, "no cardio[] week");
  const planItem = contracts.PLAN_PROPOSAL_SCHEMA.properties.days.items.properties.items.items;
  for (const field of ["target_distance_km", "target_duration_min", "target_zone", "interval", "interval_json"]) {
    assert.equal(planItem.properties[field], undefined, `days items[] names no ${field}`);
  }
  const change = contracts.PLAN_PROPOSAL_SCHEMA.properties.changes.items;
  for (const field of ["kind", "target_distance_km", "target_duration_min", "target_zone", "interval"]) {
    assert.equal(change.properties[field], undefined, `changes[] names no ${field}`);
  }

  const runOnly = {
    summary: "Steady week.",
    cardio: [{ day_number: 3, label: "Easy run", target_duration_min: 40 }],
  };
  assert.equal(contracts.isPlanProposalResult(runOnly), false, "a cardio-only payload has no action here");
  assert.equal(contracts.hasPlanProposalActions(runOnly), false, "and carries no plan action");
  // Beside a real change the stray cardio[] is ignored, never the reason to reject.
  const mixed = { ...runOnly, changes: [{ day_number: 1, exercise: "Back Squat", target_weight: 185 }] };
  assert.equal(contracts.isPlanProposalResult(mixed), true);
  assert.equal(contracts.hasPlanProposalActions(mixed), true);
});

test("a restructure day carries no day_type — rest is the calendar's, not a plan row", () => {
  // day_type left the schema with the rest-day row (migration 110): a rest day is a
  // weekday the athlete neither lifts nor runs. The model-visible schema must not
  // offer the slot, and the prose twin must not ask for it.
  const day = contracts.PLAN_PROPOSAL_SCHEMA.properties.days.items;
  assert.equal(day.properties.day_type, undefined, "no day_type slot on a restructure day");
  const coachPrompt = readFileSync(new URL("../src/prompt/coach.ts", import.meta.url), "utf8");
  assert.doesNotMatch(coachPrompt, /"day_type" →/, "the prose twin no longer asks for a day_type");
  assert.match(coachPrompt, /RUNS ARE NOT PLAN ITEMS/, "and says why runs and rest never appear in days");

  // A legacy payload that still names one is not refused by the gate — the applier
  // drops a day left with nothing to lift — so the rotation never burns on it.
  const legacy = {
    summary: "Name the rest day.",
    days: [
      { day_number: 1, name: "Lower", focus: "lower", day_type: "training", items: [{ exercise: "Back Squat", sets: 3 }] },
      { day_number: 2, name: "Rest", focus: null, day_type: "rest", items: [] },
    ],
  };
  assert.ok(matchesJsonSchema(contracts.PLAN_PROPOSAL_SCHEMA, legacy, { coerce: true }));
  assert.equal(contracts.isPlanProposalResult(legacy), true);
});

test("the case conference speaks an enforceable schema at both of its call sites", () => {
  const ok = (schema, value) => matchesJsonSchema(schema, value, { coerce: true });
  const expectation = {
    metric_key: "exercise_est_1rm_trend",
    subject_key: "Back Squat",
    direction: "increase",
    baseline: { est_1rm: 250 },
    target: { min_delta_lb: 5 },
    window_start: "2026-09-02",
    window_end: "2026-09-30",
    minimum_data: null,
    confounder_policy: "standard",
    confidence: "tentative",
    evaluator: "exercise_est_1rm",
    evaluator_version: "v1",
  };
  const opinion = {
    domain: "training",
    recommendation: "Hold the squat load one more week.",
    rationale: "Two sessions fell short of the prescribed cap.",
    evidence_keys: ["sessions.2026-08-30"],
    risks: ["Stalling"],
    contraindications: [],
    uncertainties: ["Sleep is unlogged"],
    expected_outcomes: [expectation],
    autonomy_ceiling: "announce",
  };
  assert.ok(ok(contracts.SPECIALIST_OPINION_SCHEMA, opinion));
  assert.equal(isSpecialistOpinion(opinion), true, "the sample must be one the acceptance predicate takes");
  // A specialist runs the bounded read loop, so its schema must admit a bare
  // protocol turn too — the read-loop suite above asserts the rest of that contract.
  assert.ok(
    ok(contracts.SPECIALIST_OPINION_SCHEMA, {
      kind: "coach_read",
      requests: [{ tool: "read_training_window", args: { weeks: 6 } }],
    })
  );
  // An opinion that cites nothing is not an opinion the conference can use, and the
  // normalizer says so — the schema must not offer the decoder that shape.
  assert.equal(ok(contracts.SPECIALIST_OPINION_SCHEMA, { ...opinion, evidence_keys: [] }), false);
  assert.equal(isSpecialistOpinion({ ...opinion, evidence_keys: [] }), false);

  const decision = {
    kind: "case_conference",
    domain: "training",
    summary: "Hold load, keep the week's shape.",
    rationale: "Recovery is thin and the log confirms the shortfall.",
    risk_class: "low",
    reversible: true,
    autonomy_tier: "announce",
    parallel_actions: ["Keep protein at target"],
    resolved_conflicts: [
      { key: "deficit_recovery", evidence_key: "sessions.2026-08-30", resolution: "The log shows the shortfall." },
    ],
    deferred: [],
    expectations: [expectation],
    review_window: "Review in two weeks.",
    user_explanation: "Same weights this week.",
    revision: {
      type: "plan_update",
      summary: "Hold the squat.",
      changes: [{ day_number: 1, exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 225 }],
    },
  };
  assert.ok(ok(contracts.CASE_CONFERENCE_DECISION_SCHEMA, decision));
  assert.ok(normalizeStrictCaseConferenceDecision(decision), "the sample must survive the conductor's own gate");
  // Advice-only is the common answer, and `revision: null` must stay expressible.
  assert.ok(ok(contracts.CASE_CONFERENCE_DECISION_SCHEMA, { ...decision, revision: null }));
  assert.ok(normalizeStrictCaseConferenceDecision({ ...decision, revision: null }));
  // The other two revision shapes travel through the SAME node.
  const restructure = {
    ...decision,
    revision: {
      type: "plan_restructure",
      summary: "Three days.",
      days: [
        { day_number: 1, name: "Lower", focus: "lower", items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }] },
      ],
    },
  };
  assert.ok(ok(contracts.CASE_CONFERENCE_DECISION_SCHEMA, restructure));
  assert.ok(normalizeStrictCaseConferenceDecision(restructure));
  const fueling = {
    ...decision,
    domain: "nutrition",
    revision: {
      type: "nutrition_target",
      summary: "Raise to maintenance.",
      nutrition: { target_kcal: 2100, protein_g: 175, carbs_g: null, fat_g: null, delta_kcal: 150 },
      notes: "Protection buys maintenance.",
    },
  };
  assert.ok(ok(contracts.CASE_CONFERENCE_DECISION_SCHEMA, fueling));
  assert.ok(normalizeStrictCaseConferenceDecision(fueling));

  // The conductor is NOT a read-loop op, so it may require its whole payload — and
  // the strict normalizer discards a decision missing any one of those keys.
  assert.equal(contracts.CASE_CONFERENCE_DECISION_SCHEMA.required.length, 14);
  for (const key of contracts.CASE_CONFERENCE_DECISION_SCHEMA.required) {
    const { [key]: _dropped, ...without } = decision;
    assert.equal(ok(contracts.CASE_CONFERENCE_DECISION_SCHEMA, without), false, `${key} must be required`);
    assert.equal(normalizeStrictCaseConferenceDecision(without), null, `${key} must be required by the consumer too`);
  }

  // The revision node names ONLY what strictRevision's ownKeysAllowed permits: an
  // extra named slot is not harmless here, it is a rejected revision.
  const allowed = {
    plan_update: ["type", "summary", "changes"],
    plan_restructure: ["type", "summary", "days"],
    nutrition_target: ["type", "summary", "nutrition", "notes"],
  };
  const union = new Set(Object.values(allowed).flat());
  assert.deepEqual(
    Object.keys(contracts.CASE_CONFERENCE_DECISION_SCHEMA.properties.revision.properties).sort(),
    [...union].sort()
  );
  const dayNode = contracts.CASE_CONFERENCE_DECISION_SCHEMA.properties.revision.properties.days.items;
  assert.deepEqual(Object.keys(dayNode.properties).sort(), ["day_number", "focus", "items", "name"]);
  assert.equal(dayNode.properties.day_type, undefined, "strictPlanDay allows no day_type on this lane");
  // Strength only (migration 110): the item node names no run family, and the strict
  // normalizer refuses a kind:'cardio' item or a run field outright.
  const itemNode = dayNode.properties.items.items;
  for (const field of ["target_distance_km", "target_duration_min", "target_zone", "interval", "interval_json"]) {
    assert.equal(itemNode.properties[field], undefined, `the conference item names no ${field}`);
  }
  const withItem = (item) => ({
    ...restructure,
    revision: { ...restructure.revision, days: [{ ...restructure.revision.days[0], items: [item] }] },
  });
  assert.equal(
    normalizeStrictCaseConferenceDecision(withItem({ kind: "cardio", exercise: "Easy run" })),
    null,
    "a run item is refused"
  );
  assert.equal(
    normalizeStrictCaseConferenceDecision(withItem({ exercise: "Back Squat", sets: 3, target_distance_km: 5 })),
    null,
    "a run field on a strength item is refused"
  );
  assert.ok(normalizeStrictCaseConferenceDecision(withItem({ kind: "strength", exercise: "Back Squat", sets: 3 })));
});
