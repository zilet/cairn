// Health-data truth conflicts (2026-11-16 audit). Every read of a marker's CURRENT value
// must agree with the newest evidence on file, and every athlete-facing word about it must
// agree with the number beside it:
//   - a newer reading of the same analyte by another METHOD supersedes an older one for
//     the current value (direct LDL vs calculated LDL-C), and a derivable marker
//     (non-HDL = total − HDL) reads the newest draw that measured its components;
//   - a trend direction is held to the latest draw when it reverses the long-run line;
//   - a reading under a meaningful low edge (diastolic 55 under 60–80) is not "in
//     optimal", and a blood-pressure-LOWERING lever never fires for a low reading;
//   - a journey body-fat milestone reads the phase start through the ONE estimate.
// Every fixture is synthetic: invented dates and values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, marker, repo, seedHealthDoc } from "./_seed.js";

const mg = (name, value, flag = null) => marker(name, value, { unit: "mg/dL", flag });

function seedLipidHistory() {
  // An older panel that printed calculated LDL and non-HDL…
  seedHealthDoc(localDaysAgo(170), [
    mg("Cholesterol, Total", 290, "high"),
    mg("HDL-Cholesterol", 48),
    mg("Non-HDL Cholesterol", 242, "high"),
    mg("LDL Chol Calc (NIH)", 207, "high"),
  ]);
  seedHealthDoc(localDaysAgo(150), [mg("LDL Chol Calc (NIH)", 173, "high")]);
  // …and a newer one that printed DIRECT LDL plus total and HDL, but no non-HDL line.
  seedHealthDoc(localDaysAgo(6), [
    mg("Cholesterol", 202),
    mg("High Density Lipoprotein", 52),
    mg("Low Density Lipoprotein Direct", 129),
  ]);
}

const byName = (markers, name) => markers.find((m) => m.name === name);

test("a newer direct LDL supersedes an older calculated LDL-C for the current value; its series stays whole", () => {
  seedLipidHistory();
  const { markers } = repo.getMarkerHistory();
  const calc = byName(markers, "LDL-C");
  const direct = byName(markers, "LDL-C (Direct)");
  assert.ok(calc && direct, "both method series are on file — methods are never merged");
  assert.equal(calc.points.length, 2, "the calculated series keeps its own history");
  assert.deepEqual(
    { name: calc.superseded_by?.name, value: calc.superseded_by?.value, date: calc.superseded_by?.date },
    { name: "LDL-C (Direct)", value: 129, date: localDaysAgo(6) }
  );
  assert.equal(direct.superseded_by, undefined, "the newest method is the current one");

  const pm = repo.prioritizeMarkers();
  assert.ok(!pm.markers.some((m) => m.name === "LDL-C"), "the superseded series leaves the ranked current list");
  assert.ok(pm.superseded.some((m) => m.name === "LDL-C" && m.superseded_by?.name === "LDL-C (Direct)"));
  assert.ok(pm.markers.some((m) => m.name === "LDL-C (Direct)" && m.latest.value === 129));
});

test("non-HDL reads the newest draw that measured total and HDL, never June's printed line", () => {
  seedLipidHistory();
  const nonHdl = byName(repo.getMarkerHistory().markers, "Non-HDL-C");
  assert.equal(nonHdl.latest.value, 150, "202 − 52 from the newer draw");
  assert.equal(nonHdl.latest.date, localDaysAgo(6));
  assert.equal(nonHdl.latest.kind, "derived");
  assert.equal(nonHdl.trend.dir, "falling", "the trend is re-read over the extended series");
});

test("the health focus, coaching inputs and the risk read lead with the current lipid values", () => {
  seedLipidHistory();
  repo.deriveDirectives();
  const lipids = repo.healthFocus().priorities.find((p) => /Lipids/i.test(p.group));
  assert.ok(lipids, "lipids is still a priority (direct LDL 129 and non-HDL 150 sit above optimal)");
  assert.ok(!lipids.readings.some((r) => r.value === 173 || r.value === 207), "no superseded LDL-C value leads");
  assert.ok(!lipids.readings.some((r) => r.value === 242), "no stale non-HDL value leads");
  const nonHdl = lipids.readings.find((r) => r.name === "Non-HDL-C");
  assert.equal(nonHdl?.value, 150);

  const risk = repo.cardiovascularRiskRead();
  assert.equal(risk.inputs.markers.ldl_c.value, 129, "the risk inputs read the direct LDL");
  assert.equal(risk.inputs.markers.non_hdl_c.value, 150, "and the derived non-HDL");

  // The LDL directive's trigger follows the current reading, not June's.
  const ldlDirective = repo
    .listActiveDirectives()
    .find((d) => /^LDL/i.test(String(d.marker || "")) && d.trigger_value != null);
  if (ldlDirective) assert.equal(ldlDirective.trigger_value, 129);
});

test("the same draw printing both methods supersedes neither", () => {
  seedHealthDoc(localDaysAgo(10), [mg("LDL Chol Calc (NIH)", 120), mg("Low Density Lipoprotein Direct", 124)]);
  const { markers } = repo.getMarkerHistory();
  assert.equal(byName(markers, "LDL-C").superseded_by, undefined);
  assert.equal(byName(markers, "LDL-C (Direct)").superseded_by, undefined);
});

test("a sharp drop on the latest draw is the direction; the long-run climb rides as context and the projection is withheld", () => {
  const series = [
    [1800, 135],
    [1400, 155],
    [1000, 175],
    [600, 175],
    [90, 186],
    [6, 129],
  ];
  for (const [ago, v] of series) seedHealthDoc(localDaysAgo(ago), [mg("Low Density Lipoprotein Direct", v)]);
  const ldl = byName(repo.getMarkerHistory().markers, "LDL-C (Direct)");
  assert.equal(ldl.trend.dir, "falling", "never 'rising' the week it dropped 57 points");
  assert.equal(ldl.trend.basis, "recent");
  assert.equal(ldl.trend.recent.change, -57);
  assert.equal(ldl.trend.long_run.dir, "rising", "the long-run line is kept, as context");
  assert.equal(ldl.trend.projection, null);
  assert.equal(ldl.forecast.eta_text, null, "no projection off a line the newest draw contradicted");
  assert.equal(ldl.forecast.direction, "improving", "falling under a high-is-worse band");
  assert.doesNotMatch(JSON.stringify(ldl), /drifting away from optimal/);
});

test("a latest draw that continues the line, or wobbles inside the series' own noise, keeps the long-run read", () => {
  for (const [ago, v] of [
    [400, 150],
    [300, 160],
    [200, 170],
    [6, 182],
  ])
    seedHealthDoc(localDaysAgo(ago), [mg("Low Density Lipoprotein Direct", v)]);
  for (const [ago, v] of [
    [400, 200],
    [300, 230],
    [200, 205],
    [100, 235],
    [6, 228],
  ])
    seedHealthDoc(localDaysAgo(ago), [mg("Cholesterol", v)]);
  const { markers } = repo.getMarkerHistory();
  const ldl = byName(markers, "LDL-C (Direct)");
  assert.equal(ldl.trend.dir, "rising");
  assert.equal(ldl.trend.basis, undefined);
  const tc = byName(markers, "Total Cholesterol");
  assert.equal(tc.trend.basis, undefined, "a 7-point dip inside 25-30 point swings is noise, not a turn");
});

test("a diastolic under its band is not in optimal, gets no 'holding within optimal' and no lowering levers", () => {
  const rows = [
    [60, 122, 78],
    [45, 118, 74],
    [30, 112, 70],
    [15, 108, 64],
    [7, 101, 55],
  ];
  for (const [ago, sys, dia] of rows)
    repo.addBloodPressureReading({ measured_at: localDaysAgo(ago), systolic: sys, diastolic: dia });
  const dia = repo.prioritizeMarkers().markers.find((m) => m.name === "Diastolic BP");
  assert.equal(dia.latest.value, 55);
  assert.equal(dia.in_optimal, false, "55 is not in optimal against 60–80");
  assert.equal(dia.below_optimal_floor, true);
  assert.equal(dia.distance, 0, "but it is not a drift the worse way — nothing ranks it up the list");
  assert.notEqual(dia.forecast.eta_text, "holding within optimal");
  assert.notEqual(dia.forecast.direction, "improving", "a falling diastolic under the band is not 'moving your way'");

  repo.deriveDirectives();
  const bp = repo.listActiveDirectives().filter((d) => /Diastolic|Systolic/.test(String(d.marker || "")));
  assert.ok(
    !bp.some((d) => /DASH|lowers resting blood pressure|sustained high reading/i.test(d.directive)),
    "no lowering lever for a low reading"
  );
  const low = bp.find((d) => d.domain === "watch");
  assert.ok(low, "the low reading gets its recheck note");
  assert.match(low.directive, /no reason to cut salt or add cardio/);
  assert.equal(low.trigger_side, "low");

  const focus = repo.healthFocus();
  assert.ok(
    !focus.priorities.some((p) => p.markers.some((n) => /Diastolic/.test(n))),
    "a reading on the low side is not a health priority"
  );
});

test("a high diastolic still gets the blood-pressure levers", () => {
  for (const [ago, sys, dia] of [
    [20, 138, 88],
    [10, 140, 90],
    [3, 142, 92],
  ])
    repo.addBloodPressureReading({ measured_at: localDaysAgo(ago), systolic: sys, diastolic: dia });
  repo.deriveDirectives();
  const dia = repo.listActiveDirectives().filter((d) => /Diastolic/.test(String(d.marker || "")));
  assert.ok(dia.some((d) => d.domain === "nutrition" && /DASH/.test(d.directive)));
  assert.ok(dia.every((d) => d.trigger_side !== "low"));
});

test("a body-fat milestone reads the phase start through the one estimate, never the number stored on the phase", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 176 });
  const weigh = (date, lb) => db.prepare("INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)").run(date, lb);
  weigh(localDaysAgo(80), 190);
  weigh(localDaysAgo(1), 176);
  repo.addBodyMeasurement(localDaysAgo(1), { waist_in: 33, neck_in: 15.5 }, null, "test");
  // The stored start is a snapshot from elsewhere (40%); nothing MEASURED the start.
  repo.createJourneyPhase({ kind: "cut", start_date: localDaysAgo(60), start_bodyfat_pct: 40, status: "active" });
  const est = repo.currentBodyFatEstimate(repo.getProfile());
  assert.ok(est.measured && est.body_fat_pct < 35, `a measured current level (${est.body_fat_pct})`);
  assert.ok(
    !repo.journeyMilestones().some((m) => m.kind === "bodyfat_band"),
    "no 'Under 35%' claimed off an unmeasured, stored start"
  );
});

test("with a measured start, the band milestone compares the estimate with itself", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 176 });
  const weigh = (date, lb) => db.prepare("INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)").run(date, lb);
  weigh(localDaysAgo(62), 195);
  weigh(localDaysAgo(1), 176);
  repo.addBodyMeasurement(localDaysAgo(62), { waist_in: 40, neck_in: 16 }, null, "test");
  repo.addBodyMeasurement(localDaysAgo(1), { waist_in: 33, neck_in: 15.5 }, null, "test");
  // A stored start that disagrees with the estimate (15.8 against an estimate near 26).
  repo.createJourneyPhase({ kind: "cut", start_date: localDaysAgo(60), start_bodyfat_pct: 15.8, status: "active" });
  const band = repo.journeyMilestones().find((m) => m.kind === "bodyfat_band");
  assert.ok(band, "the measured drop from the start earns its band");
  // The estimate at the start (~26%) sets the band; the stored 15.8 would have claimed "Under 15%".
  assert.ok(band.value >= 20 && band.value < 30, `band ${band.value}`);
});
