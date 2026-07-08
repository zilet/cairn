import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, seedHealthDoc, marker } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "health_documents",
    "health_directives",
    "insights",
    "memory",
    "profile",
  );
});

test("healthOutcomeAnnotations labels a follow-up marker as improving without claiming causation", () => {
  seedHealthDoc("2026-01-01", [
    marker("25-OH Vitamin D", 28, { unit: "ng/mL", flag: "low" }),
  ]);
  const directive = repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "Vitamin D",
    directive: "Use the agreed vitamin D plan and recheck after a response window.",
    trigger_value: 28,
    trigger_side: "low",
    trigger_date: "2026-01-01",
    status: "active",
  });
  seedHealthDoc("2026-04-01", [
    marker("Vitamin D", 44, { unit: "ng/mL", flag: "normal" }),
  ]);

  const read = repo.healthOutcomeAnnotations();
  const annotation = read.annotations.find((x) => x.directive_id === directive.id);

  assert.ok(annotation);
  assert.equal(annotation.outcome, "improving");
  assert.equal(annotation.trigger.value, 28);
  assert.equal(annotation.follow_up.value, 44);
  assert.equal(annotation.in_optimal_now, true);
  assert.match(annotation.summary, /moved in the intended direction/i);
  assert.match(annotation.caveat, /not proof/i);
  assert.match(read.frame, /Informational/i);
});

test("healthOutcomeAnnotations separates unchanged from worsening follow-up readings", () => {
  seedHealthDoc("2026-01-01", [
    marker("ApoB", 125, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 160, { unit: "mg/dL", flag: "high" }),
  ]);
  const apob = repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "ApoB",
    directive: "Tighten the lipid lever and recheck after a response window.",
    trigger_value: 125,
    trigger_side: "high",
    trigger_date: "2026-01-01",
  });
  const ldl = repo.addDirective({
    source: "markers",
    domain: "watch",
    marker: "LDL-C",
    directive: "Discuss LDL-C response with a clinician at follow-up.",
    trigger_value: 160,
    trigger_side: "high",
    trigger_date: "2026-01-01",
  });
  seedHealthDoc("2026-04-01", [
    marker("ApoB", 123, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 190, { unit: "mg/dL", flag: "high" }),
  ]);

  const byId = new Map(repo.healthOutcomeAnnotations().annotations.map((x) => [x.directive_id, x]));

  assert.equal(byId.get(apob.id)?.outcome, "unchanged");
  assert.match(byId.get(apob.id)?.next_step ?? "", /Review timing/i);
  assert.equal(byId.get(ldl.id)?.outcome, "worsening");
  assert.match(byId.get(ldl.id)?.next_step ?? "", /clinician/i);
});

test("recordHealthOutcomeAnnotations persists explicit outcome reads as insight and learning memory", () => {
  seedHealthDoc("2026-01-01", [
    marker("Ferritin", 20, { unit: "ng/mL", flag: "low" }),
  ]);
  repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "Ferritin",
    directive: "Use the agreed iron plan and recheck after the response window.",
    trigger_value: 20,
    trigger_side: "low",
    trigger_date: "2026-01-01",
  });
  seedHealthDoc("2026-04-01", [
    marker("Ferritin", 55, { unit: "ng/mL", flag: "normal" }),
  ]);

  const recorded = repo.recordHealthOutcomeAnnotations();
  const insights = db.prepare(`SELECT * FROM insights WHERE kind = 'health_outcome'`).all();
  const memories = db.prepare(`SELECT * FROM memory WHERE kind = 'learning' AND source = 'health-outcome'`).all();
  const recordedAgain = repo.recordHealthOutcomeAnnotations();

  assert.equal(recorded.annotations.length, 1);
  assert.equal(recorded.persisted.insights, 1);
  assert.equal(recorded.persisted.memories, 1);
  assert.equal(insights.length, 1);
  assert.match(insights[0].text, /Ferritin changed/i);
  assert.equal(memories.length, 1);
  assert.match(memories[0].content, /Ferritin outcome/i);
  assert.equal(recordedAgain.persisted.insights, 0, "duplicate insight is suppressed");
});
