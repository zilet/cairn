import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { localDaysAgo, marker, repo, resetTables, seedHealthDoc } from "./_seed.js";
import { buildCoachPrompt, buildMealPlanPrompt, renderBodyComp } from "../dist/prompt.js";

beforeEach(() => {
  resetTables("body_measurements", "bodyweight_log", "profile", "health_documents");
});

const NO_SCORE = (obj, label) => {
  const json = JSON.stringify(obj);
  assert.ok(!/impact_score/.test(json), `${label}: no impact_score leak`);
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(json), `${label}: no x/100 grade`);
};

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

test("site-specific validation rejects impossible values and flags unusual proportions without excluding them", () => {
  repo.setProfile({ height_in: 70, sex: "male" });

  const normal = repo.validateBodyMeasurementInput({
    neck_in: 15.5, shoulder_in: 46.2, chest_in: 42.2, waist_in: 35.8,
    hip_in: 40.5, thigh_in: 24, calf_in: 15.8, upper_arm_in: 13.8, forearm_in: 11.8,
  });
  assert.equal(normal.errors.length, 0);
  assert.equal(normal.warnings.length, 0);

  const impossible = repo.validateBodyMeasurementInput({ neck_in: 3, waist_in: 120 });
  assert.deepEqual(impossible.errors.map((i) => i.site).sort(), ["neck_in", "waist_in"]);

  const unusual = repo.validateBodyMeasurementInput({ hip_in: 41, thigh_in: 15, calf_in: 11 });
  assert.equal(unusual.errors.length, 0, "an unusual body remains loggable");
  assert.ok(unusual.warnings.some((i) => i.site === "thigh_in"), "the likely thigh mistype asks for a recheck");

  const range = repo.getBodyMetricsSummary().sites.find((s) => s.key === "thigh_in").range;
  assert.deepEqual({ min: range.min, max: range.max }, { min: 12, max: 45 });
  assert.ok(range.typical_min > 16 && range.typical_min < 17, `height-aware typical floor, got ${range.typical_min}`);
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

// ---- latest KNOWN value per site across sessions ------------------------------
test("a partial re-tape merges with earlier sessions instead of blanking indicators", () => {
  repo.setProfile({ sex: "male", height_in: 70 });
  repo.addBodyMeasurement(localDaysAgo(30), { waist_in: 38, hip_in: 40, neck_in: 15 }, null, "manual");
  repo.addBodyMeasurement(localDaysAgo(0), { waist_in: 37 }, null, "manual");

  const merged = repo.latestKnownMeasurement();
  assert.equal(merged.waist_in, 37, "newest waist wins");
  assert.equal(merged.hip_in, 40, "hip falls back to the session that taped it");
  assert.equal(merged.date, localDaysAgo(0), "identity stays the newest session");

  // Waist-to-hip and Navy body-fat survive the waist-only re-tape...
  const summary = repo.getBodyMetricsSummary();
  const whr = summary.indicators.find((i) => i.key === "whr");
  assert.equal(whr.value, Math.round((37 / 40) * 100) / 100);
  const bf = summary.indicators.find((i) => i.key === "bodyfat");
  assert.ok(bf.value != null, "Navy estimate pairs today's waist with the known neck");
  // ...and the payload's `latest` row stays the honest raw session.
  assert.equal(summary.latest.hip_in, null);
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

  const rejected = repo.applyMeasurementAction({ waist_in: 200 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.measurement, null);
  assert.ok(rejected.issues.some((i) => i.site === "waist_in" && i.severity === "error"));

  const unusual = repo.applyMeasurementAction({ hip_in: 41, thigh_in: 15 });
  assert.equal(unusual.ok, true, "soft plausibility warnings preserve an override path");
  assert.ok(unusual.issues.some((i) => i.site === "thigh_in" && i.severity === "warning"));
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

// ---- units: cm speaks at every boundary, storage stays inches ------------------
test("addBodyMeasurement converts cm to canonical inches and clamps in inches", () => {
  const row = repo.addBodyMeasurement("2026-06-01", { waist_in: 86.4, chest_in: 106.7 }, null, "manual", "cm");
  assert.equal(row.waist_in, 34); // 86.4 cm / 2.54
  assert.equal(row.chest_in, 42);
  // implausible even after conversion (300 cm ≈ 118 in > 100) → rejected, not clipped
  const bad = repo.addBodyMeasurement("2026-06-02", { waist_in: 300 }, null, null, "cm");
  assert.equal(bad.waist_in, null);
});

test("summary + trends re-express in cm on request (values, unit label, prose)", () => {
  repo.setProfile({ height_in: 70, weight_lb: 177, sex: "male" });
  repo.addBodyMeasurement(localDaysAgo(42), { waist_in: 35 });
  repo.addBodyMeasurement(localDaysAgo(0), { waist_in: 34 });

  const summary = repo.getBodyMetricsSummary(365, "cm");
  assert.equal(summary.unit, "cm");
  assert.ok(Math.abs(summary.latest.waist_in - 86.4) < 0.1, `latest in cm, got ${summary.latest.waist_in}`);
  const waist = summary.trends.sites.find((s) => s.key === "waist_in");
  assert.equal(waist.unit, "cm");
  assert.match(waist.text, /cm/);
  assert.ok(Math.abs(waist.change - -2.5) < 0.2, `change ~ -2.5 cm, got ${waist.change}`);
  // ratios/BMI/body-fat are unit-free and identical either way
  const inSummary = repo.getBodyMetricsSummary(365, "in");
  assert.deepEqual(
    summary.indicators.map((i) => i.value),
    inSummary.indicators.map((i) => i.value)
  );
});

test("applyMeasurementAction understands unit:'cm' and height_cm", () => {
  const res = repo.applyMeasurementAction({ unit: "cm", waist_in: 86.4, height_cm: 178, source: "chat" });
  assert.equal(res.ok, true);
  assert.equal(res.measurement.waist_in, 34);
  assert.ok(Math.abs(repo.getProfile().height_in - 70.1) < 0.1, `height ~70.1 in, got ${repo.getProfile().height_in}`);
  // height_in follows the action's unit too
  repo.applyMeasurementAction({ unit: "cm", height_in: 178 });
  assert.ok(Math.abs(repo.getProfile().height_in - 70.1) < 0.1);
});

// ---- per-site measuring hints ride on the summary ------------------------------
test("summary sites carry a measuring hint for every site", () => {
  const { sites } = repo.getBodyMetricsSummary();
  assert.equal(sites.length, 9);
  for (const s of sites) {
    assert.equal(typeof s.hint, "string");
    assert.ok(s.hint.length > 10, `${s.key} has a real hint`);
  }
  assert.match(sites.find((s) => s.key === "waist_in").hint, /navel/i);
  assert.match(sites.find((s) => s.key === "upper_arm_in").hint, /not flexed/i);
});

// ---- where-you-stand scales + focus + heading ----------------------------------
test("getBodyCompFocus is quiet-safe when empty and never emits a score", () => {
  const comp = repo.getBodyCompFocus();
  assert.equal(comp.scales.length, 4);
  for (const s of comp.scales) assert.equal(s.value, null);
  assert.equal(comp.focus, null);
  assert.equal(comp.heading, null);
  NO_SCORE(comp, "empty comp");
});

test("an out-of-optimal waist-to-height picks the ONE focus lever with a unit-aware delta", () => {
  repo.setProfile({ height_in: 70, weight_lb: 200, sex: "male" });
  repo.addBodyMeasurement(localDaysAgo(0), { waist_in: 40, neck_in: 15, hip_in: 42 });
  const comp = repo.getBodyCompFocus();
  const whtr = comp.scales.find((s) => s.key === "whtr");
  assert.equal(whtr.value, 0.57);
  assert.deepEqual(whtr.optimal, { from: 0.4, to: 0.5 });
  assert.ok(comp.focus);
  assert.equal(comp.focus.key, "whtr");
  assert.match(comp.focus.line, /~5 in/); // 40 − 0.5·70
  // one reading → no projection yet, and the heading invites the second session
  assert.equal(whtr.projected, null);
  assert.match(comp.heading, /log another/i);
  NO_SCORE(comp, "focused comp");

  // the same lever speaks cm when asked
  const cm = repo.getBodyCompFocus("cm");
  assert.match(cm.focus.line, /~12.7 cm/);
});

test("a falling waist trend projects the heading marker toward optimal", () => {
  repo.setProfile({ height_in: 70, weight_lb: 190, sex: "male" });
  repo.addBodyMeasurement(localDaysAgo(42), { waist_in: 38, neck_in: 15 });
  repo.addBodyMeasurement(localDaysAgo(0), { waist_in: 37, neck_in: 15 });
  const comp = repo.getBodyCompFocus();
  const whtr = comp.scales.find((s) => s.key === "whtr");
  assert.ok(whtr.value > 0.5, "starts above optimal");
  assert.ok(whtr.projected != null && whtr.projected < whtr.value, "projected toward optimal");
  assert.match(comp.heading, /~\d+ weeks?/);
  assert.match(comp.heading, /optimal band/);
  // body-fat projects too (waist drives the Navy estimate; neck held)
  const bf = comp.scales.find((s) => s.key === "bodyfat");
  assert.ok(bf.value != null && bf.projected != null && bf.projected < bf.value);
});

test("comp rides on the summary and the slice carries the same lever for the brain", () => {
  repo.setProfile({ height_in: 70, weight_lb: 200, sex: "male" });
  repo.addBodyMeasurement(localDaysAgo(0), { waist_in: 40 });
  const summary = repo.getBodyMetricsSummary();
  assert.ok(summary.comp);
  assert.equal(summary.comp.focus.key, "whtr");
  const slice = repo.bodyMetricsContextSlice();
  assert.equal(slice.focus_line, summary.comp.focus.line);
  assert.equal(slice.heading, summary.comp.heading);
});

// ---- the brain reads the tape: renderBodyComp + prompt inclusion ----------------
test("renderBodyComp is quiet without data and speaks the whole picture with it", () => {
  assert.equal(renderBodyComp({}), "");
  assert.equal(renderBodyComp({ body_metrics: null }), "");

  repo.setProfile({ height_in: 70, weight_lb: 200, sex: "male" });
  repo.addBodyMeasurement(localDaysAgo(0), { waist_in: 40, neck_in: 15, hip_in: 42 });
  const block = renderBodyComp({ body_metrics: repo.bodyMetricsContextSlice() });
  assert.match(block, /BODY COMPOSITION \/ MEASUREMENTS/);
  assert.match(block, /waist 40 in/);
  assert.match(block, /never a score/i);
  assert.match(block, /The one lever/);
  assert.match(block, /Where it's heading/);
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(block), "no raw dates in prose");
});

test("the coach and meal-plan prompts fold the tape picture in", () => {
  repo.setProfile({ height_in: 70, weight_lb: 200, sex: "male" });
  repo.addBodyMeasurement(localDaysAgo(0), { waist_in: 40, neck_in: 15 });
  assert.match(buildCoachPrompt(), /BODY COMPOSITION \/ MEASUREMENTS/);
  assert.match(buildMealPlanPrompt(), /BODY COMPOSITION \/ MEASUREMENTS/);
});

test("renderBodyComp feeds DEXA projection dates to the brain even without tape", () => {
  repo.setProfile({ height_in: 70, weight_lb: 175.5, sex: "male" });
  const scanDate = localDaysAgo(30);
  const today = localDaysAgo(0);
  seedHealthDoc(scanDate, [
    marker("Body Fat %", 35.6, { unit: "%", flag: "high" }),
    marker("Lean Mass (Total)", 112.6, { unit: "lbs" }),
    marker("Bone Mineral Content (BMC)", 6.1, { unit: "lbs" }),
    marker("Fat Mass (Total)", 65.6, { unit: "lbs", flag: "high" }),
    marker("Total Mass", 184.3, { unit: "lbs" }),
  ], "dexa");
  repo.logWeight(184.3, scanDate);
  repo.logWeight(175.5, today);
  const ctx = repo.getCoachContext();
  assert.ok(ctx.body_composition?.estimated, "coach context carries the current body-comp estimate");
  const block = renderBodyComp(ctx);
  assert.match(block, /DEXA-derived current estimate/);
  assert.match(block, new RegExp(today));
  assert.match(block, new RegExp(scanDate));
  assert.match(block, /175\.5 lb current/);
});

test("renderBodyComp prefers tape estimate over DEXA projection when both exist", () => {
  repo.setProfile({ height_in: 70, weight_lb: 175.5, sex: "male" });
  const scanDate = localDaysAgo(30);
  const tapeDate = localDaysAgo(4);
  seedHealthDoc(scanDate, [
    marker("Body Fat %", 35.6, { unit: "%", flag: "high" }),
    marker("Lean Mass (Total)", 112.6, { unit: "lbs" }),
    marker("Bone Mineral Content (BMC)", 6.1, { unit: "lbs" }),
    marker("Fat Mass (Total)", 65.6, { unit: "lbs", flag: "high" }),
    marker("Total Mass", 184.3, { unit: "lbs" }),
  ], "dexa");
  repo.addBodyMeasurement(tapeDate, { waist_in: 38, neck_in: 15, hip_in: 42 });

  const block = renderBodyComp(repo.getCoachContext());
  assert.doesNotMatch(block, /DEXA-derived current estimate/, "DEXA projection is suppressed when tape estimate exists");
  assert.match(block, /DEXA body fat anchor/);
  assert.match(block, /Body fat: /);
  assert.match(block, /tape ESTIMATE/);
});
