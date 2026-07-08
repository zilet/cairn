import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, marker, repo, resetTables, seedHealthDoc } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "profile",
    "health_documents",
    "health_directives",
    "health_reviews",
    "attention_schedule",
    "body_measurements",
    "insights",
    "memory",
  );
});

test("doctorPacketRead composes focus, directives, doctor-loop plan, PREVENT risk, and outcomes", () => {
  repo.setProfile({
    sex: "male",
    age: 44,
    height_in: 66,
    weight_lb: 190,
    smoking: 0,
    bp_treated: 0,
    statin: 0,
  });
  db.prepare(
    `INSERT INTO body_measurements (date, waist_in, neck_in, hip_in, source)
     VALUES ('2026-01-15', 42, 16, 40, 'manual')`
  ).run();
  seedHealthDoc("2026-01-01", [
    marker("Total Cholesterol", 238, { unit: "mg/dL" }),
    marker("HDL Cholesterol", 54, { unit: "mg/dL" }),
    marker("LDL-C", 173, { unit: "mg/dL", flag: "high" }),
    marker("ApoB", 125, { unit: "mg/dL", flag: "high" }),
    marker("Lp(a)", 120, { unit: "nmol/L", flag: "high" }),
    marker("hs-CRP", 1.8, { unit: "mg/L", flag: "high" }),
    marker("HbA1c", 5.3, { unit: "%" }),
    marker("eGFR", 98, { unit: "mL/min" }),
    marker("Systolic BP", 120, { unit: "mmHg" }),
  ]);
  const directive = repo.addDirective({
    source: "markers",
    domain: "nutrition",
    marker: "ApoB",
    directive: "Use the agreed lipid-lowering pattern and recheck after the response window.",
    rationale: "ApoB is the modifiable atherogenic particle target.",
    citation: "AHA/ACC 2018 Cholesterol Guideline",
    trigger_value: 125,
    trigger_side: "high",
    trigger_date: "2026-01-01",
  });
  seedHealthDoc("2026-04-01", [
    marker("ApoB", 92, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 130, { unit: "mg/dL", flag: "high" }),
  ]);

  const packet = repo.doctorPacketRead({ asOf: "2026-07-02" });

  assert.equal(packet.meta.resourceType, "CairnDoctorPacket");
  assert.match(packet.meta.note, /Informational, not medical advice/i);
  assert.match(packet.health_focus.headline, /priority|track|clean/i);
  assert.ok(packet.priority_markers.some((m) => /apob|apolipoprotein b/i.test(m.name) && m.value === 92));
  assert.ok(packet.active_directives.some((d) => d.id === directive.id && d.marker === "ApoB"));
  assert.ok(packet.doctor_loop.due.some((d) => d.signal_key === "marker:apob"));
  assert.ok(packet.doctor_loop.missing_workup.some((w) => w.label === "Fasting insulin"));
  assert.equal(packet.cardiovascular_risk.model_status.prevent, "computed");
  assert.ok(typeof packet.cardiovascular_risk.prevent.estimates.total_cvd.ten_year === "number");
  assert.equal(packet.outcomes.annotations[0].outcome, "improving");
  assert.ok(packet.discussion_points.length > 0);
  assert.doesNotMatch(JSON.stringify(packet), /impact_score|diagnosis|0-100/i);
});

test("doctorPacketRead stays useful and calm with sparse data", () => {
  const packet = repo.doctorPacketRead({ asOf: "2026-04-02" });

  assert.equal(packet.health_focus.lead, null);
  assert.deepEqual(packet.active_directives, []);
  assert.equal(packet.cardiovascular_risk.model_status.prevent, "insufficient_inputs");
  assert.ok(packet.doctor_loop.missing_workup.length >= 5);
  assert.match(packet.discussion_points.join(" "), /Next-draw additions|Cardiovascular risk read needs/i);
  assert.match(packet.frame, /never auto-applies/i);
});
