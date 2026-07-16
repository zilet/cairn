import { test } from "node:test";
import assert from "node:assert/strict";
import { specialistVoiceLine } from "../dist/brain/specialist-voice.js";

const opinion = (domain, recommendation) => ({
  domain,
  recommendation,
  rationale: "because the evidence points there",
  evidence_keys: ["k"],
  risks: [],
  contraindications: [],
  uncertainties: [],
  expected_outcomes: [],
  autonomy_ceiling: "ask",
});

test("prefers the opinion matching the decision's domain and maps it to a calm voice", () => {
  const specialist = {
    snapshot_id: "snap-1",
    opinions: [
      opinion("training", "Add a second pull day."),
      opinion("health", "ApoB is the one to move."),
    ],
  };
  const line = specialistVoiceLine(specialist, "health");
  assert.ok(line);
  assert.equal(line.domain, "health");
  assert.equal(line.voice, "Lab reader");
  assert.equal(line.line, "Lab reader: ApoB is the one to move.");
});

test("falls back to the first usable opinion when no domain preference matches", () => {
  const specialist = { opinions: [opinion("nutrition", "Raise the target to 2225 kcal.")] };
  const line = specialistVoiceLine(specialist, "recovery");
  assert.ok(line);
  assert.equal(line.voice, "Nutrition lead");
  assert.match(line.line, /^Nutrition lead: Raise the target/);
});

test("a preferred-domain opinion with an empty recommendation falls back to another usable domain", () => {
  const specialist = {
    opinions: [
      opinion("health", ""), // preferred domain, but nothing usable to say
      opinion("nutrition", "Anchor meals around fibre and oily fish."),
    ],
  };
  const line = specialistVoiceLine(specialist, "health");
  assert.ok(line, "does not short-circuit to null when the preferred voice is empty");
  assert.equal(line.domain, "nutrition");
  assert.equal(line.voice, "Nutrition lead");
  assert.match(line.line, /^Nutrition lead: Anchor meals/);
});

test("accepts a bare opinions array as well as the wrapped blob", () => {
  const line = specialistVoiceLine([opinion("training", "Deload the squat this week.")], "training");
  assert.ok(line);
  assert.equal(line.voice, "Strength coach");
});

test("returns null for missing, empty, or unusable specialist data", () => {
  assert.equal(specialistVoiceLine(null), null);
  assert.equal(specialistVoiceLine(undefined), null);
  assert.equal(specialistVoiceLine({}), null);
  assert.equal(specialistVoiceLine({ opinions: [] }), null);
  assert.equal(specialistVoiceLine({ opinions: [{ domain: "health", recommendation: "" }] }), null);
  assert.equal(specialistVoiceLine({ opinions: [{ domain: "not-a-domain", recommendation: "x" }] }), null);
});
