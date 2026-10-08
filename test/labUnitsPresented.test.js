// The reaction model and symptom links present lab values in the athlete's lab-unit system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, seedHealthDoc, marker } from "./_seed.js";
import { buildReactionModel } from "../dist/repo/reaction-model.js";

test("the reaction model speaks a marker's change with its unit, in the athlete's lab system", () => {
  seedHealthDoc("2026-03-01", [marker("LDL Cholesterol", 160, { unit: "mg/dL" })]);
  seedHealthDoc("2026-08-01", [marker("LDL Cholesterol", 120, { unit: "mg/dL" })]);
  db.prepare(
    `INSERT INTO health_directives (source, domain, marker, directive, status, status_at) VALUES ('markers','nutrition','LDL-C','x','resolved','2026-04-01')`
  ).run();
  const statement = () => buildReactionModel().patterns.find((p) => p.id === "intervention_marker")?.statement;
  repo.setSettings({ lab_units: "us" });
  assert.match(statement(), /from 160 mg\/dL to 120 mg\/dL/);
  repo.setSettings({ lab_units: "si" });
  assert.match(statement(), /from 4\.14 mmol\/L to 3\.1 mmol\/L/);
  assert.doesNotMatch(statement(), /from 160 to 120/);
});

test("symptom links carry the reading in the athlete's lab system, side judged canonically", () => {
  const mk = (value) => ({ name: "LDL Cholesterol", unit: "mg/dL", in_optimal: false, latest: { value, flag: "high" } });
  const events = [{ kind: "life_event", title: "Wiped out lately", detail: "no energy, always tired", start_date: null, end_date: null, meta: null, archived: 0 }];
  const ldl = (system) => {
    repo.setSettings({ lab_units: system });
    return repo.symptomMarkerLinks({ events, markers: [mk(160), { name: "Ferritin", unit: "ng/mL", in_optimal: false, latest: { value: 18, flag: "low" } }], includeCheckins: false })[0].markers;
  };
  const us = ldl("us");
  const si = ldl("si");
  const fer = (list) => list.find((m) => /ferritin/i.test(m.name));
  assert.equal(fer(us).value, 18);
  assert.equal(fer(us).unit, "ng/mL");
  assert.equal(fer(si).unit, "µg/L");
  assert.equal(fer(si).side, "low");
});

