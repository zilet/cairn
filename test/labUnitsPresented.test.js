// The reaction model and symptom links present lab values in the athlete's lab-unit system.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, seedHealthDoc, marker } from "./_seed.js";
import { buildReactionModel, saveReactionModel } from "../dist/repo/reaction-model.js";

test("the reaction model stores a marker's change in canonical units and speaks it in the athlete's system", () => {
  seedHealthDoc("2026-03-01", [marker("LDL Cholesterol", 160, { unit: "mg/dL" })]);
  seedHealthDoc("2026-06-01", [marker("LDL Cholesterol", 130, { unit: "mg/dL" })]);
  seedHealthDoc("2026-08-01", [marker("LDL Cholesterol", 120, { unit: "mg/dL" })]);
  db.prepare(
    `INSERT INTO health_directives (source, domain, marker, directive, status, status_at) VALUES ('markers','nutrition','LDL-C','x','resolved','2026-04-01')`
  ).run();
  const built = () => buildReactionModel().patterns.find((p) => p.id === "intervention_marker")?.statement;
  const shown = () => repo.reactionModelForCoach().patterns.find((p) => p.id === "intervention_marker")?.statement;
  const cached = () =>
    JSON.parse(db.prepare(`SELECT value FROM app_state WHERE key = 'reaction_model'`).get().value).patterns.find(
      (p) => p.id === "intervention_marker"
    ).statement;
  const memory = (opts) => repo.listMemory(50, opts).find((m) => m.source === "reaction-model" && /LDL/.test(m.content))?.content;

  repo.setSettings({ lab_units: "si" });
  assert.match(built(), /from 160 mg\/dL to 120 mg\/dL/, "built canonical, whatever the athlete reads");
  saveReactionModel();
  assert.match(cached(), /from 160 mg\/dL to 120 mg\/dL/, "the cache stores canonical prose");
  assert.match(memory({ raw: true }), /from 160 mg\/dL to 120 mg\/dL/, "coach memory stores canonical prose");
  assert.match(shown(), /from 4\.14 mmol\/L to 3\.1 mmol\/L/);
  assert.match(memory(), /from 4\.14 mmol\/L to 3\.1 mmol\/L/);

  repo.setSettings({ lab_units: "us" });
  assert.match(shown(), /from 160 mg\/dL to 120 mg\/dL/);
  assert.match(memory(), /from 160 mg\/dL to 120 mg\/dL/);
  saveReactionModel();
  assert.equal(
    repo.listMemory(50, { raw: true }).filter((m) => m.source === "reaction-model" && /LDL/.test(m.content)).length,
    1,
    "a unit switch never mints a second memory of the same pattern"
  );
});

test("agent prose written in SI reads in US conventional for a US reader, and the stored text stays", () => {
  repo.setSettings({ lab_units: "us" });
  const text = "Your LDL at 4.1 mmol/L sits above 2.6 mmol/L; Lp(a) 120 nmol/L is genetic.";
  const d = repo.addDirective({ source: "health_review", domain: "watch", marker: "LDL-C", directive: text, rationale: "ApoB of 1.2 g/L agrees." });
  const shown = repo.listActiveDirectives().find((x) => x.id === d.id);
  assert.equal(shown.directive, "Your LDL at 159 mg/dL sits above 101 mg/dL; Lp(a) 120 nmol/L is genetic.");
  assert.equal(shown.rationale, "ApoB of 120 mg/dL agrees.");
  assert.equal(db.prepare(`SELECT directive FROM health_directives WHERE id = ?`).get(d.id).directive, text);
  repo.setSettings({ lab_units: "si" });
  assert.equal(repo.listActiveDirectives().find((x) => x.id === d.id).directive, text, "already in the SI reader's units");

  // The health synthesis: every string in it, the stored row untouched.
  repo.saveHealthSynthesis({ headline: "LDL at 4.1 mmol/L leads.", priorities: [{ the_move: "Fiber for glucose 5.6 mmol/L." }] });
  repo.setSettings({ lab_units: "us" });
  const view = repo.getHealthSynthesisView().synthesis;
  assert.equal(view.headline, "LDL at 159 mg/dL leads.");
  assert.equal(view.priorities[0].the_move, "Fiber for glucose 101 mg/dL.");
  assert.equal(repo.getHealthSynthesis().headline, "LDL at 4.1 mmol/L leads.");
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

