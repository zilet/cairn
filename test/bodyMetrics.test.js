import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("body_measurements", "bodyweight_log", "profile");
});

// ---- round-trip + clamping ----------------------------------------------------
test("addBodyMeasurement round-trips and clamps implausible sites to null", () => {
  const row = repo.addBodyMeasurement("2026-06-01", { waist_in: 34, chest_in: 42, upper_arm_in: 15, waist_typo: 9 }, "morning", "manual");
  assert.equal(row.waist_in, 34);
  assert.equal(row.chest_in, 42);
  assert.equal(row.upper_arm_in, 15);
  assert.equal(row.hip_in, null);
  assert.equal(row.note, "morning");
  assert.equal(row.source, "manual");

  // out-of-range circumference is rejected (stored null), not clipped to a bound
  const bad = repo.addBodyMeasurement("2026-06-02", { waist_in: 200, neck_in: 0.2 });
  assert.equal(bad.waist_in, null);
  assert.equal(bad.neck_in, null);

  assert.equal(repo.getBodyMeasurement(row.id).chest_in, 42);
  assert.equal(repo.latestBodyMeasurement().id, bad.id);
  const list = repo.listBodyMeasurements();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, row.id); // chronological
});

test("update and delete a measurement", () => {
  const row = repo.addBodyMeasurement("2026-06-01", { waist_in: 34 });
  const upd = repo.updateBodyMeasurement(row.id, { waist_in: 33.5, note: "fixed" });
  assert.equal(upd.waist_in, 33.5);
  assert.equal(upd.note, "fixed");
  const del = repo.deleteBodyMeasurement(row.id);
  assert.equal(del.ok, true);
  assert.equal(repo.getBodyMeasurement(row.id), null);
});

// ---- height on profile (v59) --------------------------------------------------
test("height_in is settable and back-fills height_cm for the existing TDEE path", () => {
  const p = repo.setProfile({ height_in: 70 });
  assert.equal(p.height_in, 70);
  assert.ok(Math.abs(p.height_cm - 177.8) < 0.1, `height_cm derived ~177.8, got ${p.height_cm}`);
  assert.equal(repo.effectiveHeightIn(), 70);

  // explicit cm still wins; inches derived from it when inches unset
  repo.setProfile({ height_in: null, height_cm: 180 });
  assert.equal(repo.getProfile().height_in, null);
  assert.equal(repo.effectiveHeightIn(), Math.round((180 / 2.54) * 10) / 10);
});

// ---- BMI: degradation + value + athlete caveat --------------------------------
test("BMI degrades to a height hint, then computes with the athlete caveat", () => {
  repo.setProfile({ weight_lb: 177, sex: "male" }); // no height yet
  const noHeight = repo.getBodyIndicators({ waist_in: 34 }).find((i) => i.key === "bmi");
  assert.equal(noHeight.value, null);
  assert.deepEqual(noHeight.needs, ["height"]);
  assert.match(noHeight.read, /height/i);

  repo.setProfile({ height_in: 70, weight_lb: 177 });
  const bmi = repo.getBodyIndicators({ waist_in: 34 }).find((i) => i.key === "bmi");
  assert.ok(Math.abs(bmi.value - 25.4) < 0.15, `BMI ~25.4, got ${bmi.value}`);
  assert.equal(bmi.zone, "above range");
  assert.match(bmi.read, /muscle from fat/i); // caveat present above 25
});

// ---- waist-to-height flag -----------------------------------------------------
test("waist-to-height flags above 0.5 and reads optimal below", () => {
  repo.setProfile({ height_in: 70 });
  const elevated = repo.getBodyIndicators({ waist_in: 40 }).find((i) => i.key === "whtr");
  assert.equal(elevated.value, 0.57);
  assert.equal(elevated.zone, "elevated");
  assert.equal(elevated.tone, "watch");
  assert.match(elevated.read, /under half your height/i);

  const optimal = repo.getBodyIndicators({ waist_in: 32 }).find((i) => i.key === "whtr");
  assert.equal(optimal.zone, "optimal");
  assert.equal(optimal.tone, "ok");
});

// ---- waist-to-hip: sex-aware cutoffs -----------------------------------------
test("waist-to-hip uses sex-aware cutoffs", () => {
  repo.setProfile({ sex: "male" });
  const male = repo.getBodyIndicators({ waist_in: 36, hip_in: 40 }).find((i) => i.key === "whr");
  assert.equal(male.value, 0.9);
  assert.equal(male.zone, "elevated"); // ≥0.90 for men

  repo.setProfile({ sex: "female" });
  const female = repo.getBodyIndicators({ waist_in: 30, hip_in: 40 }).find((i) => i.key === "whr");
  assert.equal(female.value, 0.75);
  assert.equal(female.zone, "optimal"); // <0.85 for women
});

// ---- Navy body-fat: sex-aware + labelled an estimate -------------------------
test("Navy body-fat is sex-aware and always flagged an estimate", () => {
  repo.setProfile({ height_in: 70, sex: "male" });
  const male = repo.getBodyIndicators({ neck_in: 15, waist_in: 34 }).find((i) => i.key === "bodyfat");
  assert.ok(male.value > 16 && male.value < 19, `male Navy BF ~17.5, got ${male.value}`);
  assert.equal(male.zone, "fit");
  assert.equal(male.estimate, true);
  assert.match(male.read, /estimate/i);

  // women need the hip circumference too
  repo.setProfile({ height_in: 65, sex: "female" });
  const missingHip = repo.getBodyIndicators({ neck_in: 13, waist_in: 30 }).find((i) => i.key === "bodyfat");
  assert.equal(missingHip.value, null);
  assert.ok(missingHip.needs.includes("hip_in"));

  const female = repo.getBodyIndicators({ neck_in: 13, waist_in: 30, hip_in: 40 }).find((i) => i.key === "bodyfat");
  assert.ok(female.value > 29 && female.value < 33, `female Navy BF ~31, got ${female.value}`);
  assert.equal(female.zone, "average");
  assert.equal(female.estimate, true);
});

// ---- trends: null-safe under 2 points, then a real slope ----------------------
test("per-site trend is null-safe with one point and directional with two", () => {
  repo.addBodyMeasurement("2026-05-01", { waist_in: 34 });
  let waist = repo.getBodyMetricTrends().sites.find((s) => s.key === "waist_in");
  assert.equal(waist.n, 1);
  assert.equal(waist.slope_per_week, null);
  assert.equal(waist.change, null);
  assert.equal(waist.direction, null);
  assert.match(waist.text, /log again|one reading/i);

  repo.addBodyMeasurement("2026-06-12", { waist_in: 33 }); // ~6 weeks later, down 1"
  waist = repo.getBodyMetricTrends().sites.find((s) => s.key === "waist_in");
  assert.equal(waist.n, 2);
  assert.equal(waist.change, -1);
  assert.equal(waist.direction, "down");
  assert.ok(waist.slope_per_week != null);
  assert.match(waist.text, /waist down 1 in/i);
});

test("weight trend rides alongside circumferences via the bodyweight log", () => {
  repo.logWeight(180, "2026-05-01");
  repo.logWeight(176, "2026-06-12");
  const weight = repo.getBodyMetricTrends().weight;
  assert.equal(weight.n, 2);
  assert.equal(weight.change, -4);
  assert.equal(weight.direction, "down");
  assert.equal(weight.unit, "lb");
});

// ---- agentic chat capture (SEAM parity) --------------------------------------
test("applyMeasurementAction logs free-field sites and can set height in one call", () => {
  const res = repo.applyMeasurementAction({ waist_in: 34, chest_in: 42, upper_arm_in: 15, height_in: 70, note: "am", source: "chat" });
  assert.equal(res.ok, true);
  assert.equal(res.measurement.waist_in, 34);
  assert.equal(res.measurement.source, "chat");
  assert.equal(res.height_in, 70);
  assert.equal(repo.getProfile().height_in, 70);
  // waist + the just-set height unlock waist-to-height in the same call
  assert.ok(res.indicators.find((i) => i.key === "whtr").value != null);

  // height-only capture is still a useful, ok no-op on the measurements table
  const heightOnly = repo.applyMeasurementAction({ height_in: 69 });
  assert.equal(heightOnly.ok, true);
  assert.equal(heightOnly.measurement, null);
  assert.equal(repo.getProfile().height_in, 69);

  // nothing measurable → not ok, nothing written
  const nothing = repo.applyMeasurementAction({ foo: 1 });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.measurement, null);
});

// ---- coach-context slice (SEAM) ----------------------------------------------
test("bodyMetricsContextSlice is null when empty and bounded once there is data", () => {
  assert.equal(repo.bodyMetricsContextSlice(), null);

  repo.setProfile({ height_in: 70, weight_lb: 177, sex: "male" });
  repo.addBodyMeasurement("2026-06-01", { waist_in: 40, neck_in: 15, hip_in: 42 });
  const slice = repo.bodyMetricsContextSlice();
  assert.ok(slice);
  assert.equal(slice.height_in, 70);
  assert.equal(slice.measurements.waist_in, 40);
  assert.ok(slice.indicators.find((i) => i.label === "Waist-to-height").value != null);
  // every surfaced indicator is a real value with a zone, never a raw score
  for (const ind of slice.indicators) assert.equal(typeof ind.value, "number");
});

// ---- composite summary --------------------------------------------------------
test("getBodyMetricsSummary composes measurements + indicators + trends + needs_height", () => {
  const empty = repo.getBodyMetricsSummary();
  assert.equal(empty.latest, null);
  assert.equal(empty.needs_height, true);
  assert.equal(empty.indicators.length, 4);
  assert.equal(empty.sites.length, 9);

  repo.setProfile({ height_in: 70, weight_lb: 177 });
  repo.addBodyMeasurement("2026-06-01", { waist_in: 34, neck_in: 15 });
  const full = repo.getBodyMetricsSummary();
  assert.equal(full.needs_height, false);
  assert.equal(full.latest.waist_in, 34);
  assert.equal(full.profile.height_in, 70);
  assert.ok(full.indicators.find((i) => i.key === "bmi").value != null);
});
