import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, isoDaysAgo, marker, repo, resetTables, seedHealthDoc, seedTrainingDay } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "blood_pressure_readings",
    "health_documents",
    "health_directives",
    "garmin_daily_metrics",
    "garmin_sources",
    "daily_metrics",
    "activities",
    "food_notes",
    "bodyweight_log",
    "logged_sets",
    "sessions",
    "plan_items",
    "plan_days",
    "exercises",
    "profile"
  );
});

test("healthStanding compares actual age against a selectable reference decade", () => {
  repo.setProfile({ age: 44, sex: "male", height_cm: 180, weight_lb: 185, goal_mode: "maintain" });
  seedHealthDoc("2026-06-20", [
    marker("VO2max", 48, { unit: "mL/kg/min" }),
    marker("Body Fat %", 18, { unit: "%" }),
    marker("ApoB", 78, { unit: "mg/dL", flag: "normal" }),
  ]);
  repo.addBloodPressureReading({ measured_at: "2026-06-24T07:15", systolic: 116, diastolic: 72, pulse: 58 });
  seedTrainingDay(isoDaysAgo(0));
  seedTrainingDay(isoDaysAgo(2));

  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','standing-test')`).run();
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, vo2max, resting_hr, hrv_ms, steps, fitness_age, body_fat_pct)
     VALUES (?, ?, 48, 55, 58, 9200, 36, 18)`
  ).run(src.lastInsertRowid, isoDaysAgo(0));

  const standing = repo.healthStanding({ referenceAge: 20 });
  assert.equal(standing.subject.age, 44);
  assert.equal(standing.subject.reference_age_band, "20s");
  assert.equal(standing.confidence, "strong");
  assert.ok(Number.isFinite(standing.signal_age), "signal age is present");
  assert.ok(standing.signal_age <= 44, "strong signals read no older than calendar age in this fixture");

  const vo2 = standing.comparisons.find((c) => c.key === "vo2max");
  assert.ok(vo2, "VO2max comparison is present");
  assert.equal(vo2.actual_age_band, "40s");
  assert.equal(vo2.reference_age_band, "20s");
  assert.equal(typeof vo2.percentile, "number");
  assert.equal(typeof vo2.reference_percentile, "number");
  assert.ok(vo2.percentile > vo2.reference_percentile, "same VO2 ranks higher against age peers than 20s");

  const body = standing.comparisons.find((c) => c.key === "body_fat_pct");
  assert.ok(body, "body composition comparison is present");
  assert.equal(body.reference_age_band, "20s");

  const bp = standing.dimensions.find((d) => d.id === "bp");
  assert.ok(bp);
  assert.equal(bp.tone, "strong");
  assert.equal(standing.blood_pressure.latest.systolic, 116);

  assert.ok(!JSON.stringify(standing).includes("impact_score"), "internal marker ranking does not leak");
  assert.ok(!/"score"/i.test(JSON.stringify(standing)), "standing read exposes percentiles, not a score field");
});

test("healthStanding leads with momentum: live body-fat estimate, lab bio-age, the one lever", () => {
  repo.setProfile({ age: 44, sex: "male", height_cm: 170, weight_lb: 177.6, goal_weight_lb: 164, goal_mode: "lose" });
  // A 3-week-old DEXA: lean mass measured, body fat 35.6% at a heavier scan weight.
  seedHealthDoc(isoDaysAgo(21), [
    marker("Body Fat %", 35.6, { unit: "%", flag: "high" }),
    marker("Lean Mass (Total)", 112.6, { unit: "lbs" }),
    marker("Bone Mineral Content (BMC)", 6.1, { unit: "lbs" }),
    marker("Fat Mass (Total)", 65.6, { unit: "lbs" }),
    marker("Total Mass", 184.3, { unit: "lbs" }),
  ], "dexa");
  // Bloodwork: lipids flagged high (the real lever) + a lab biological age younger by 7.4.
  seedHealthDoc(isoDaysAgo(15), [
    marker("LDL-Cholesterol", 207, { unit: "mg/dL", flag: "high" }),
    marker("Apolipoprotein B (ApoB)", 148, { unit: "mg/dL", flag: "high" }),
    marker("Non-HDL Cholesterol", 234, { unit: "mg/dL", flag: "high" }),
    marker("Biological Age", -7.4),
  ]);
  // Weight coming down since the scan.
  repo.logWeight(184, isoDaysAgo(21));
  repo.logWeight(177.6, isoDaysAgo(0));
  // BP improving 144 -> 113 across home readings.
  repo.addBloodPressureReading({ measured_at: "2026-02-24T08:00", systolic: 125, diastolic: 78 });
  repo.addBloodPressureReading({ measured_at: "2026-03-10T08:00", systolic: 144, diastolic: 87 });
  repo.addBloodPressureReading({ measured_at: "2026-03-11T08:00", systolic: 113, diastolic: 75 });

  const s = repo.healthStanding({ referenceAge: 20 });

  // Live body composition: estimated current body fat is BELOW the stale DEXA, with fat lost.
  assert.ok(s.body_comp, "body_comp present");
  assert.equal(s.body_comp.measured.value, 35.6);
  assert.ok(s.body_comp.estimated, "a live estimate is projected");
  assert.ok(s.body_comp.estimated.value < 35.6, "estimate is lower than the stale DEXA");
  assert.ok(s.body_comp.estimated.value > 31 && s.body_comp.estimated.value < 34, `~33% est, got ${s.body_comp.estimated.value}`);
  assert.ok(s.body_comp.fat_mass.delta_lbs < -3, "fat mass is down vs the DEXA");

  // The lab biological age leads the hero, framed by direction — no contradicting number.
  assert.ok(s.biological_age, "lab biological age surfaced");
  assert.equal(s.biological_age.value, 37);
  assert.equal(s.hero.biological_age, 37);
  assert.equal(s.hero.biological_age_source, "lab");
  assert.equal(s.hero.direction, "younger");
  assert.equal(s.hero.headline, "You're trending younger.");

  // Momentum chips are the wins in motion.
  assert.equal(s.momentum.has_momentum, true);
  assert.ok(s.momentum.chips.some((c) => c.kind === "fat"), "fat-off chip");
  assert.ok(s.momentum.chips.some((c) => c.kind === "bp"), "bp-improving chip");

  // The one lever is lipids (reused from the connected brain), not body fat.
  assert.ok(s.lead_lever, "a lead lever is named");
  assert.match(s.lead_lever.group, /Lipid/i);

  // BP reads with interpretation + the improving trajectory.
  assert.equal(s.blood_pressure.category, "optimal");
  assert.equal(s.blood_pressure.trajectory.dir, "improving");
  assert.equal(s.blood_pressure.trajectory.from.systolic, 144);

  // A holistic permission line is present, and NO score ever leaks.
  assert.ok(typeof s.balance === "string" && s.balance.length > 0, "balance note present");
  assert.ok(!JSON.stringify(s).includes("impact_score"), "internal ranking does not leak");
  assert.ok(!/"score"/i.test(JSON.stringify(s)), "no score field anywhere");
});

test("healthStanding reads an absolute lab biological age (not as a huge delta) for a young athlete", () => {
  repo.setProfile({ age: 26, sex: "male" });
  seedHealthDoc(isoDaysAgo(5), [marker("Biological Age", 23)]); // absolute 23, younger than 26
  const s = repo.healthStanding({ referenceAge: 20 });
  assert.equal(s.biological_age.value, 23, "absolute bio-age 23 read as 23, not 26+23");
  assert.equal(s.biological_age.delta, -3);
  assert.equal(s.hero.direction, "younger");
});

test("healthStanding stays descriptive with thin data", () => {
  repo.setProfile({ age: 44, sex: "male" });
  const standing = repo.healthStanding({ referenceAge: 30 });
  assert.equal(standing.subject.reference_age_band, "30s");
  assert.equal(standing.signal_age, null);
  assert.equal(standing.confidence, "early");
  assert.deepEqual(standing.comparisons, []);
  assert.ok(standing.dimensions.some((d) => d.tone === "missing"));
});
