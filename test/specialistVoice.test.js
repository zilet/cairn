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

test("prefers the opinion matching the decision's domain and speaks it as that seat's role", () => {
  const specialist = {
    snapshot_id: "snap-1",
    opinions: [opinion("training", "Add a second pull day."), opinion("health", "ApoB is the one to move.")],
  };
  const line = specialistVoiceLine(specialist, "health");
  assert.ok(line);
  assert.equal(line.domain, "health");
  assert.equal(line.seat, "heart");
  assert.equal(line.voice, "Heart");
  assert.equal(line.line, "Heart: ApoB is the one to move.");
});

test("falls back to the first usable opinion when no domain preference matches", () => {
  const specialist = { opinions: [opinion("nutrition", "Raise the target to 2225 kcal.")] };
  const line = specialistVoiceLine(specialist, "recovery");
  assert.ok(line);
  assert.equal(line.voice, "Fuel");
  assert.match(line.line, /^Fuel: Raise the target/);
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
  assert.equal(line.voice, "Fuel");
  assert.match(line.line, /^Fuel: Anchor meals/);
});

test("accepts a bare opinions array as well as the wrapped blob", () => {
  const line = specialistVoiceLine([opinion("training", "Deload the squat this week.")], "training");
  assert.ok(line);
  assert.equal(line.voice, "Strength");
});

test("returns null for missing, empty, or unusable specialist data", () => {
  assert.equal(specialistVoiceLine(null), null);
  assert.equal(specialistVoiceLine(undefined), null);
  assert.equal(specialistVoiceLine({}), null);
  assert.equal(specialistVoiceLine({ opinions: [] }), null);
  assert.equal(specialistVoiceLine({ opinions: [{ domain: "health", recommendation: "" }] }), null);
  assert.equal(specialistVoiceLine({ opinions: [{ domain: "not-a-domain", recommendation: "x" }] }), null);
});

test("the endurance specialist sits in the Run seat; lifestyle sits with Recovery", () => {
  assert.equal(specialistVoiceLine([opinion("endurance", "Hold the long run at 14 km.")]).voice, "Run");
  assert.equal(specialistVoiceLine([opinion("lifestyle", "Keep the wind-down before bed.")]).voice, "Recovery");
});

test("a recommendation in the machine register is not a line for a person", () => {
  const specialist = {
    opinions: [
      opinion("recovery", "Unexplained regression requires a revision: recovery_wellbeing."),
      opinion("training", "Hold the squat where it is this week."),
    ],
  };
  const line = specialistVoiceLine(specialist, "recovery");
  assert.ok(line);
  assert.equal(line.voice, "Strength", "the unreadable preferred opinion falls through to a readable one");
  assert.equal(specialistVoiceLine([opinion("recovery", "Lower the posture_floor.")]), null);
});
