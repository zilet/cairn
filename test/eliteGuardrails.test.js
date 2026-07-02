// Elite-training WAVE C7 — the ELITE programming guardrails are DERIVED from the
// athlete's context, not hard-coded to one person. An empty profile yields the
// GENERIC block (correct for anyone); real context (a lower-limb injury + a running
// goal + a low-testosterone flag + a bench preference) surfaces those specifics.
// Pure over the ctx object — no DB, no agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEliteGuardrails, ELITE_STRENGTH_GUARDRAILS } from "../dist/prompt/shared.js";

// The owner-specific strings that used to be hard-coded into EVERY committed prompt.
const PII = [/cubital/i, /ankle-fracture/i, /half marathon/i, /free-?t sits low/i];

test("C7: an empty profile yields the GENERIC block — no one person's specifics", () => {
  const block = buildEliteGuardrails({});
  assert.equal(block, ELITE_STRENGTH_GUARDRAILS, "with no context, it is exactly the generic block");
  for (const re of PII) assert.doesNotMatch(block, re, `no hard-coded PII (${re})`);
  // The generic block still covers the universal floors.
  assert.match(block, /CORE is first-class/);
  assert.match(block, /GRIP \/ FOREARM/);
});

test("C7: a lower-limb injury + a running goal surface the ankle/calf emphasis", () => {
  const ctx = {
    context_events: [{ kind: "injury", title: "Right ankle sprain", detail: "healing, watch under load" }],
    endurance_goal: { is_race: true, event: "Half Marathon" },
    discipline: { primary: "hybrid", endurance_sport: "running" },
  };
  const block = buildEliteGuardrails(ctx);
  assert.notEqual(block, ELITE_STRENGTH_GUARDRAILS, "context adds specifics on top of the generic block");
  assert.match(block, /ANKLE \+ CALF/i, "the ankle/calf resilience emphasis is derived");
  assert.match(block, /Half Marathon/, "names the actual race, not a hard-coded one");
});

test("C7: an elbow flag + a low-T reading surface the elbow-budget + recovery emphasis", () => {
  const ctx = {
    context_events: [{ kind: "injury", title: "Cubital tunnel — left elbow", detail: "neutral grip only" }],
    directives: [{ domain: "watch", directive: "Testosterone reads low; protect recovery." }],
  };
  const block = buildEliteGuardrails(ctx);
  assert.match(block, /ELBOW SENSITIVITY/i, "an elbow flag derives the grip/elbow shared-budget rule");
  assert.match(block, /RECOVERY MATTERS MORE/i, "a low-T flag derives the recovery emphasis");
});

test("C7: the derived block never leaks a 0-100 score", () => {
  const block = buildEliteGuardrails({
    context_events: [{ kind: "injury", title: "ankle" }],
    endurance_goal: { is_race: true, event: "10k" },
  });
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(block), "no score anywhere (constitution)");
});
