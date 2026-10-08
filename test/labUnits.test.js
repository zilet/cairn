// Lab units: ONE canonical unit per analyte for every comparison (src/repo/lab-units.ts),
// and the athlete's lab-unit system for everything a person or a prompt reads
// (src/repo/lab-display.ts). A European lab's mmol/L and a US lab's mg/dL are the same
// measurement; Lp(a) mass and molar results are not, and are never converted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, seedHealthDoc, marker } from "./_seed.js";
import { publicPriorityMarkers } from "../dist/domain/health/index.js";
import { buildHealthReviewPrompt } from "../dist/prompt.js";
import { labRangeRead } from "../dist/repo/lab-range.js";

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ""} expected ≈${expected}, got ${actual}`);

const ldlOf = () => repo.prioritizeMarkers().markers.find((m) => m.key.includes("ldl"));

test("conversion factors follow the molar masses (SI → canonical and back)", () => {
  near(repo.toCanonical("Fasting glucose", 5.0, "mmol/L"), 90.08, 0.01, "glucose ×18.016");
  near(repo.fromCanonical("Fasting glucose", 90.08, "si"), 5.0, 0.001);
  near(repo.fromCanonical("LDL-C", 100, "si"), 2.586, 1e-9, "LDL ×0.02586");
  near(repo.fromCanonical("HDL-C", 50, "si"), 1.293, 1e-9);
  near(repo.fromCanonical("Total cholesterol", 200, "si"), 5.172, 1e-9);
  near(repo.fromCanonical("Triglycerides", 150, "si"), 1.6935, 1e-9, "TG ×0.01129");
  near(repo.fromCanonical("Creatinine", 1.0, "si"), 88.42, 1e-9, "creatinine ×88.42");
  near(repo.toCanonical("Creatinine", 88.42, "µmol/L"), 1.0, 1e-9);
  near(repo.fromCanonical("Vitamin D", 40, "si"), 99.84, 1e-9, "vitamin D ×2.496");
  near(repo.toCanonical("Vitamin D", 50, "nmol/L"), 20.03, 0.01);
  near(repo.fromCanonical("Testosterone", 500, "si"), 17.335, 1e-9, "testosterone ×0.03467");
  near(repo.toCanonical("Testosterone", 5, "ng/mL"), 500, 1e-9, "ng/mL is ×100 ng/dL");
  near(repo.fromCanonical("ApoB", 80, "si"), 0.8, 1e-12, "ApoB mg/dL ÷100 = g/L");
  near(repo.toCanonical("ApoB", 0.9, "g/L"), 90, 1e-9);
  near(repo.fromCanonical("Hemoglobin", 14.5, "si"), 145, 1e-9, "hemoglobin g/dL ×10 = g/L");
  // HbA1c is affine (IFCC): mmol/mol = (% − 2.15) × 10.929; a DELTA scales without the offset.
  near(repo.fromCanonical("HbA1c", 5.7, "si"), 38.8, 0.01);
  near(repo.toCanonical("HbA1c", 48, "mmol/mol"), 6.54, 0.01);
  near(repo.fromCanonical("HbA1c", 0.3, "si", { delta: true }), 3.279, 0.001);
  // US system and an analyte with no SI twin are identity.
  assert.equal(repo.fromCanonical("LDL-C", 123, "us"), 123);
  assert.equal(repo.fromCanonical("Sodium", 140, "si"), 140);
  assert.equal(repo.displayUnitFor("LDL-C", "si"), "mmol/L");
  assert.equal(repo.displayUnitFor("LDL-C", "us"), "mg/dL");
});

test("unit spellings: UCUM counts match, and micro- vs milli-units never compare equal", () => {
  assert.equal(repo.labUnitsCompatible("10*9/L", "K/uL"), true);
  assert.equal(repo.labUnitsCompatible("×10⁹/L", "10^3/µL"), true);
  assert.equal(repo.labUnitsCompatible("10*12/L", "M/uL"), true);
  assert.equal(repo.labUnitsCompatible("µmol/L", "umol/l"), true);
  assert.equal(repo.labUnitsCompatible("uIU/mL", "mIU/L"), true);
  assert.equal(repo.labUnitsCompatible("mIU/mL", "IU/L"), true);
  // 1 mIU/mL = 1000 µIU/mL: a TSH in one is never the other.
  assert.equal(repo.labUnitsCompatible("uIU/mL", "mIU/mL"), false);
  assert.equal(repo.labUnitsCompatible("uIU/mL", "IU/L"), false);
});

test("Lp(a) mass and molar results are never converted — only labelled", () => {
  assert.equal(repo.toCanonical("Lp(a)", 40, "mg/dL"), null);
  assert.equal(repo.toCanonical("Lp(a)", 40, "mg/L"), null);
  assert.equal(repo.toCanonical("Lp(a)", 120, "nmol/L"), 120);
  seedHealthDoc("2025-12-01", [marker("Lp(a)", 40, { unit: "mg/dL" })]);
  repo.setSettings({ lab_units: "si" });
  const lpa = publicPriorityMarkers().markers.find((m) => m.key === "lpa");
  assert.equal(lpa.unit, "mg/dL", "kept in the unit its lab printed");
  assert.equal(lpa.latest.value, 40);
  assert.equal(lpa.latest.unit_mismatch, true);
  assert.equal(lpa.optimal, null, "never judged against the nmol/L band");
});

test("a mmol/L LDL is judged against the optimal band in canonical units", () => {
  // 2.0 mmol/L ≈ 77 mg/dL: inside the 40–100 mg/dL optimal band (a raw 2.0 would read 'below').
  seedHealthDoc("2025-12-01", [marker("LDL Cholesterol", 2.0, { unit: "mmol/L" })]);
  let ldl = ldlOf();
  near(ldl.latest.value, 77.34, 0.01);
  assert.equal(ldl.unit, "mg/dL");
  assert.equal(ldl.in_optimal, true);

  // 3.2 mmol/L ≈ 124 mg/dL: above it.
  db.prepare("DELETE FROM health_documents").run();
  seedHealthDoc("2025-12-02", [marker("LDL Cholesterol", 3.2, { unit: "mmol/L" })]);
  repo.resetMarkerHistoryCache();
  ldl = ldlOf();
  assert.equal(ldl.in_optimal, false);

  // Total cholesterol and HDL in mmol/L convert too (total was never converted before).
  seedHealthDoc("2025-12-03", [
    marker("Total Cholesterol", 5.2, { unit: "mmol/L" }),
    marker("HDL Cholesterol", 1.0, { unit: "mmol/L" }),
  ]);
  repo.resetMarkerHistoryCache();
  const all = repo.prioritizeMarkers().markers;
  const tc = all.find((m) => m.name === "Total cholesterol" || /total chol/i.test(m.name));
  near(tc.latest.value, 201.1, 0.1);
  assert.equal(tc.latest.unit_mismatch, undefined);
  const hdl = all.find((m) => /hdl/i.test(m.name) && !/non/i.test(m.name));
  near(hdl.latest.value, 38.67, 0.01);
  assert.equal(hdl.in_optimal, false, "38.7 mg/dL sits under the 50 mg/dL floor");
});

test("a random glucose in mmol/L joins its mg/dL series (no band, same analyte)", () => {
  seedHealthDoc("2025-01-01", [marker("Glucose (random)", 110, { unit: "mg/dL" })]);
  seedHealthDoc("2025-06-01", [marker("Glucose (random)", 6.5, { unit: "mmol/L" })]);
  const g = repo.getMarkerHistory().markers.find((m) => /glucose/i.test(m.name));
  assert.equal(g.unit, "mg/dL");
  assert.equal(g.points.length, 2, "both readings in one trend");
  assert.equal(g.dropped_other_units, 0);
  near(g.points[1].value, 117.1, 0.1);
});

test("the same draw in mg/dL and mmol/L is ONE draw for dedupe; a different draw stays apart", () => {
  const add = (date, markers) =>
    repo.addHealthDocument({ kind: "bloodwork", enrichment_status: "done", doc_date: date, parsed_json: { markers } });
  // A US export and a European lab's printout of the same lipid panel (rounded to its precision).
  add("2025-03-10", [
    { name: "LDL Cholesterol", value: 124, unit: "mg/dL" },
    { name: "HDL Cholesterol", value: 50, unit: "mg/dL" },
    { name: "Triglycerides", value: 97, unit: "mg/dL" },
  ]);
  add("2025-03-10", [
    { name: "LDL Cholesterol", value: "3,2", unit: "mmol/L" },
    { name: "HDL Cholesterol", value: 1.3, unit: "mmol/L" },
    { name: "Triglycerides", value: 1.1, unit: "mmol/L" },
  ]);
  // A genuinely different draw on another day, in mmol/L.
  add("2025-09-10", [
    { name: "LDL Cholesterol", value: 2.4, unit: "mmol/L" },
    { name: "HDL Cholesterol", value: 1.5, unit: "mmol/L" },
  ]);
  const result = repo.dedupeHealthDocuments();
  assert.equal(result.merged, 1, "the two printouts of one draw fold");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM health_documents").get().n, 2);

  // Same date, readings that truly disagree once converted, stay apart.
  add("2025-11-01", [
    { name: "LDL Cholesterol", value: 160, unit: "mg/dL" },
    { name: "HDL Cholesterol", value: 40, unit: "mg/dL" },
  ]);
  add("2025-11-01", [
    { name: "LDL Cholesterol", value: 2.0, unit: "mmol/L" },
    { name: "HDL Cholesterol", value: 1.6, unit: "mmol/L" },
  ]);
  assert.equal(repo.dedupeHealthDocuments().merged, 0);

  // Lp(a) 40 mg/dL and 40 nmol/L are different measures: the raw numbers never agree.
  add("2025-12-01", [
    { name: "Lp(a)", value: 40, unit: "mg/dL" },
    { name: "ApoB", value: 90, unit: "mg/dL" },
  ]);
  add("2025-12-01", [
    { name: "Lp(a)", value: 40, unit: "nmol/L" },
    { name: "ApoB", value: 0.9, unit: "g/L" },
  ]);
  assert.equal(repo.dedupeHealthDocuments().merged, 0, "one agreeing ApoB against a conflicting Lp(a) is not a match");
});

test("lab-unit preference: explicit choice wins, else derived from the weight units", () => {
  assert.equal(repo.labUnitSystem(), "us", "a fresh install (lb) reads US conventional");
  assert.equal(repo.getSettings().lab_units, null);
  repo.setSettings({ weight_units: "kg" });
  assert.equal(repo.labUnitSystem(), "si", "kg follows to SI");
  assert.equal(repo.getSettings().lab_units_effective, "si");
  repo.setSettings({ lab_units: "us" });
  assert.equal(repo.labUnitSystem(), "us", "an explicit choice beats the derivation");
  assert.equal(repo.getSettings().lab_units, "us");
  repo.setSettings({ lab_units: "nonsense" });
  assert.equal(repo.getSettings().lab_units, "us", "junk keeps what is stored");
  repo.setSettings({ lab_units: "auto" });
  assert.equal(repo.getSettings().lab_units, null);
  assert.equal(repo.labUnitSystem(), "si", "auto hands it back to the weight units");
});

test("SI display: values, band and unit convert together; the printed value is kept", () => {
  seedHealthDoc("2025-01-01", [marker("LDL Cholesterol", 100, { unit: "mg/dL" })]);
  seedHealthDoc("2025-12-01", [marker("LDL Cholesterol", 3.2, { unit: "mmol/L" })]);
  repo.setSettings({ lab_units: "si" });
  const ldl = publicPriorityMarkers().markers.find((m) => m.key.includes("ldl"));
  assert.equal(ldl.unit, "mmol/L");
  assert.equal(ldl.canonical_unit, "mg/dL");
  assert.equal(ldl.latest.value, 3.2, "an SI-printed reading shows exactly its printed number");
  assert.equal(ldl.latest.reported, undefined);
  assert.equal(ldl.prev.value, 2.59, "a mg/dL reading is converted for display");
  assert.equal(ldl.prev.reported, "100 mg/dL");
  assert.equal(ldl.optimal.high, 2.59);
  assert.equal(ldl.in_optimal, false, "the judgement made in canonical units stands");

  // US display of the same rows: canonical values, the SI printout kept as reported.
  repo.setSettings({ lab_units: "us" });
  const us = publicPriorityMarkers().markers.find((m) => m.key.includes("ldl"));
  assert.equal(us.unit, "mg/dL");
  assert.equal(us.latest.value, 123.7);
  assert.equal(us.latest.reported, "3.2 mmol/L");
  assert.equal(repo.labValueText("LDL-C", 123.7, "mg/dL", "si"), "3.2 mmol/L");
  assert.equal(repo.labValueText("Lp(a)", 40, "mg/dL", "si"), "40 mg/dL");
});

test("the health review prompt states the lab-unit system and every value carries its unit", () => {
  seedHealthDoc("2025-12-01", [marker("LDL Cholesterol", 160, { unit: "mg/dL", flag: "high" })]);
  repo.setSettings({ lab_units: "si" });
  const prompt = buildHealthReviewPrompt();
  assert.match(prompt, /LAB UNITS: every lab value in this prompt is in SI units/);
  const block = prompt.slice(prompt.indexOf("PRIORITY MARKERS (impact-ranked")).split("\n")[1];
  const top = JSON.parse(block);
  const ldl = top.find((m) => /ldl/i.test(m.name));
  assert.equal(ldl.unit, "mmol/L");
  assert.equal(ldl.latest, 4.14);
  assert.equal(ldl.reported, "160 mg/dL");
});

// ---- review follow-ups -------------------------------------------------------------

const historyOf = (re) => repo.getMarkerHistory().markers.find((m) => re.test(m.name));

test("a converted reading's reference range follows the table's own map (HbA1c is affine)", () => {
  // IFCC mmol/mol → %: (x + 23.497) / 10.929. A single proportional factor would turn
  // 20–42 mmol/mol into 2.96–6.22 % and misplace a 38 inside it.
  seedHealthDoc("2025-12-01", [{ name: "HbA1c", value: 38, unit: "mmol/mol", ref_low: 20, ref_high: 42 }]);
  const a1c = historyOf(/a1c/i);
  assert.equal(a1c.unit, "%");
  near(a1c.latest.value, 5.627, 0.01);
  near(a1c.latest.ref_low, 3.98, 0.01, "20 mmol/mol");
  near(a1c.latest.ref_high, 5.99, 0.01, "42 mmol/mol");
  assert.equal(labRangeRead(a1c).state, "within", "38 mmol/mol sits inside its own lab's 20–42");
});

test("a string-valued reading converts its reference range too", () => {
  // Hemoglobin "8.9" mmol/L (×1.611 → 14.3 g/dL). Its range 8.5–11 must come along into
  // g/dL, or the converted value reads far above a range left in mmol/L.
  seedHealthDoc("2025-12-01", [{ name: "Hemoglobin", value: "8.9", unit: "mmol/L", ref_low: 8.5, ref_high: 11 }]);
  const hgb = historyOf(/hemoglobin/i);
  assert.equal(hgb.unit, "g/dL");
  near(hgb.latest.value, 14.34, 0.01);
  near(hgb.latest.ref_low, 13.69, 0.01);
  near(hgb.latest.ref_high, 17.72, 0.01);
  assert.equal(labRangeRead(hgb).state, "within");
});

const addDoc = (date, markers) =>
  repo.addHealthDocument({ kind: "bloodwork", enrichment_status: "done", doc_date: date, parsed_json: { markers } });

test("dedupe: a reading with no unit, or an unknown spelling, still agrees with its converted twin", () => {
  addDoc("2025-03-10", [
    { name: "LDL Cholesterol", value: 3.2, unit: "mmol/L" },
    { name: "HDL Cholesterol", value: 1.3, unit: "mmol/L" },
  ]);
  addDoc("2025-03-10", [
    { name: "LDL Cholesterol", value: 3.2, unit: null },
    { name: "HDL Cholesterol", value: "1.3", unit: "mmoL/Ltr" }, // a spelling the table does not know
  ]);
  assert.equal(
    repo.dedupeHealthDocuments().merged,
    1,
    "the printed numbers agree; one copy dropped/misspelled the unit"
  );
});

test("dedupe: 3.2 mmol/L and 123.7 mg/dL are one LDL reading", () => {
  addDoc("2025-03-10", [
    { name: "LDL Cholesterol", value: 3.2, unit: "mmol/L" },
    { name: "HDL Cholesterol", value: 1.3, unit: "mmol/L" },
  ]);
  addDoc("2025-03-10", [
    { name: "LDL Cholesterol", value: 123.7, unit: "mg/dL" },
    { name: "HDL Cholesterol", value: 50.3, unit: "mg/dL" },
  ]);
  assert.equal(repo.dedupeHealthDocuments().merged, 1);
});

test("dedupe: Lp(a) 40 mg/dL and 40 nmol/L never agree", () => {
  addDoc("2025-03-10", [
    { name: "Lp(a)", value: 40, unit: "mg/dL" },
    { name: "ApoB", value: 90, unit: "mg/dL" },
  ]);
  addDoc("2025-03-10", [
    { name: "Lp(a)", value: 40, unit: "nmol/L" },
    { name: "ApoB", value: 90, unit: "mg/dL" },
  ]);
  assert.equal(repo.dedupeHealthDocuments().merged, 0);
});

test("dedupe: a qualified '<0.5' is a bound, never the number 0.5", () => {
  addDoc("2025-03-10", [
    { name: "hs-CRP", value: "<0.5", unit: "mg/L" },
    { name: "ApoB", value: 90, unit: "mg/dL" },
  ]);
  addDoc("2025-03-10", [
    { name: "hs-CRP", value: 0.5, unit: "mg/L" },
    { name: "ApoB", value: 90, unit: "mg/dL" },
  ]);
  assert.equal(repo.dedupeHealthDocuments().merged, 0);
  // …while two transcriptions of the same bound still agree.
  addDoc("2025-04-10", [
    { name: "hs-CRP", value: "< 0.5", unit: "mg/L" },
    { name: "ApoB", value: 90, unit: "mg/dL" },
  ]);
  addDoc("2025-04-10", [
    { name: "hs-CRP", value: "<0.5", unit: "mg/L" },
    { name: "ApoB", value: 90, unit: "mg/dL" },
  ]);
  assert.equal(repo.dedupeHealthDocuments().merged, 1);
});

test("switching lab units never re-surfaces a health item the athlete already saw", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 190, { unit: "mg/dL", flag: "high" }),
    marker("Calcium", 8.0, { unit: "mg/dL", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const healthItem = () => {
    const agenda = repo.todayAgenda();
    return [...agenda.primary, ...agenda.more].find((item) => item.id === "health-focus");
  };
  const us = healthItem();
  assert.ok(us?.revision);
  repo.setSettings({ lab_units: "si" });
  assert.equal(repo.healthFocus().lead.readings[0].unit, "mmol/L", "the readings are shown in SI now");
  assert.equal(healthItem()?.revision, us.revision, "same material evidence, same revision");

  // Seen in US, then switched: still seen.
  repo.setSettings({ lab_units: "us" });
  assert.equal(repo.acknowledgeTodayAgendaCandidate("health-focus", us.revision).ok, true);
  repo.setSettings({ lab_units: "si" });
  assert.equal(healthItem(), undefined);
});

const decisionCount = () =>
  db.prepare("SELECT COUNT(*) AS n FROM brain_decisions WHERE kind = 'health_directive'").get().n;

test("directive text is stored unit-neutral and shown in the athlete's system", () => {
  seedHealthDoc("2025-12-01", [
    marker("Total bilirubin", 1.6, { unit: "mg/dL", flag: "high" }), // the generic (unmapped) path
    marker("Calcium", 8.0, { unit: "mg/dL", flag: "low" }), // the albumin-correction directive
  ]);
  repo.deriveDirectives();
  const stored = () => db.prepare("SELECT id, marker, directive FROM health_directives WHERE status = 'active'").all();
  const storedBili = stored().find((d) => /bilirubin/i.test(d.marker));
  const storedCa = stored().find((d) => /calcium/i.test(d.marker));
  assert.match(storedBili.directive, /\(1\.6 mg\/dL\)/);
  assert.match(storedCa.directive, /0\.8 mg\/dL .* 1 g\/dL .* 4\.0 g\/dL/);
  const before = decisionCount();
  assert.ok(before > 0);

  repo.setSettings({ lab_units: "si" });
  // A later, unrelated draw forces a full re-derive under the SI setting.
  seedHealthDoc("2026-01-15", [marker("Sodium", 140, { unit: "mmol/L" })]);
  repo.deriveDirectives();
  assert.deepEqual(
    stored()
      .map((d) => d.directive)
      .sort(),
    [storedBili.directive, storedCa.directive].sort(),
    "a unit switch never rewrites a stored directive"
  );
  assert.equal(decisionCount(), before, "and never mints a decision event");

  // Shown in SI wherever a directive is read.
  const bili = repo.listActiveDirectives().find((d) => /bilirubin/i.test(d.marker));
  const ca = repo.listActiveDirectives().find((d) => /calcium/i.test(d.marker));
  assert.match(bili.directive, /\(27\.4 µmol\/L\)/);
  assert.match(ca.directive, /0\.2 mmol\/L to the calcium for every 10 g\/L your albumin sits below 40 g\/L/);
  assert.doesNotMatch(ca.directive, /mg\/dL|g\/dL/);
  assert.match(repo.getDirective(storedCa.id).directive, /mmol\/L/);
  assert.match(repo.listDirectives({ all: true }).find((d) => d.id === storedCa.id).directive, /mmol\/L/);

  // …and back in US conventional, exactly as stored.
  repo.setSettings({ lab_units: "us" });
  assert.equal(repo.listActiveDirectives().find((d) => d.id === storedCa.id).directive, storedCa.directive);
});

test("renderLabQuantities: own marker first, one named analyte, ambiguity left as written", () => {
  assert.equal(repo.renderLabQuantities("LDL (130 mg/dL)", "LDL-C", "si"), "LDL (3.36 mmol/L)");
  assert.equal(repo.renderLabQuantities("LDL (130 mg/dL)", "LDL-C", "us"), "LDL (130 mg/dL)");
  // No marker and two named mg/dL analytes: which one the number belongs to is unknown.
  assert.equal(
    repo.renderLabQuantities("calcium and creatinine near 9 mg/dL", null, "si"),
    "calcium and creatinine near 9 mg/dL"
  );
  assert.equal(repo.renderLabQuantities("about 10% lower", "HbA1c", "si"), "about 10% lower");
  assert.equal(repo.labQuantityNeutral("from 4.14 mmol/L to 160 mg/dL"), "from # to #");
});

test("the non-HDL lever prints through the shared lab-display helpers", () => {
  repo.setProfile({ sex: "male", age: 55, height_in: 69, weight_lb: 210, smoking: 1, bp_treated: 0, statin: 0 });
  seedHealthDoc("2026-06-01", [
    marker("Total Cholesterol", 240, { unit: "mg/dL", flag: "high" }),
    marker("HDL Cholesterol", 40, { unit: "mg/dL" }),
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("eGFR", 85, { unit: "mL/min" }),
    marker("Systolic BP", 135, { unit: "mmHg", flag: "high" }),
  ]);
  for (const [system, unit] of [
    ["us", "mg/dL"],
    ["si", "mmol/L"],
  ]) {
    repo.setSettings({ lab_units: system });
    const lever = repo.cardiovascularRiskRead().prevent.projection.levers_applied.find((l) => l.key === "lipids");
    assert.ok(lever, system);
    assert.equal(lever.unit, `${unit} non-HDL`);
    assert.equal(lever.from, repo.roundLabDisplay(lever.from));
    assert.ok(lever.detail.includes(`from ${lever.from} ${unit} to ${lever.to} ${unit}.`), lever.detail);
  }
});
