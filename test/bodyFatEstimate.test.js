// Body fat has ONE estimate (src/repo/body-fat-estimate.ts): every measurement weighed by its
// known error — a DEXA anchor that ages, a tape calibrated to it, a scale that only gives the
// direction, a wide height/weight fallback — combined into a central value with a range.
// Display reads the central value; anything protective reads the leaner end (`low`).
// Every fixture is synthetic: invented dates and values.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, isoDaysAgo, localDaysAgo, marker, repo, resetTables, seedHealthDoc } from "./_seed.js";
import { bodyFatEstimate, navyBodyFatPct } from "../dist/repo/body-fat-estimate.js";

beforeEach(() =>
  resetTables(
    "profile",
    "health_documents",
    "body_measurements",
    "bodyweight_log",
    "garmin_daily_metrics",
    "garmin_sources"
  )
);

function weigh(date, lb) {
  db.prepare("INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)").run(date, lb);
}

function tape(date, sites) {
  repo.addBodyMeasurement(date, sites, null, "test");
}

test("tape only: the Navy read is the level, with the tape's range and a hint that a scan would calibrate it", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 180 });
  weigh(localDaysAgo(1), 180);
  tape(localDaysAgo(1), { waist_in: 36, neck_in: 15.5 });
  const navy = navyBodyFatPct({ heightIn: 70, waistIn: 36, neckIn: 15.5, female: false });
  const est = bodyFatEstimate(repo.getProfile());
  assert.equal(est.primary, "tape");
  assert.ok(Math.abs(est.value - navy) < 0.5, `${est.value} vs Navy ${navy}`);
  assert.ok(est.high - est.low >= 7 - 0.01, "never narrower than the tape's own error");
  assert.match(est.basis_line, /tape/);
  assert.match(est.sharpen_hint, /DEXA/);
  assert.equal(est.tape_offset, null);
});

test("scale only: the scale never sets the level; the range is wide and says so", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 180 });
  weigh(localDaysAgo(1), 180);
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','bf')`).run();
  for (let d = 30; d >= 0; d -= 5) {
    db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, body_fat_pct) VALUES (?, ?, ?)`).run(
      src.lastInsertRowid,
      localDaysAgo(d),
      12 - d / 30
    );
  }
  const est = bodyFatEstimate(repo.getProfile());
  assert.equal(est.primary, "anthropometric");
  assert.ok(Math.abs(est.value - 12) > 5, "the scale's ~12% is not the level");
  assert.ok(est.high - est.low >= 11.9, "a wide range");
  assert.match(est.basis_line, /scale is good for direction, not the number/);
  assert.ok(est.sources.some((s) => s.kind === "scale" && s.used_as === "direction"));
  assert.ok(est.sharpen_hint);
  // A rough estimate is protective by default: the cap reads its leaner end.
  const adapter = repo.currentBodyFatEstimate(repo.getProfile());
  assert.equal(adapter.measured, false);
  assert.equal(repo.protectiveBodyFatPct(adapter), est.low);
  assert.equal(repo.computeGoalCheck().leanness_rate.planning_body_fat_pct, est.low);
});

test("DEXA + tape: the tape is calibrated to the person's own scan", () => {
  repo.setProfile({ sex: "male", age: 38, height_in: 70, weight_lb: 171.5 });
  seedHealthDoc("2026-05-04", [marker("Body Fat %", 32, { unit: "%" }), marker("Total Mass", 200, { unit: "lb" })], "dexa");
  weigh("2026-05-04", 200);
  weigh("2026-06-05", 196);
  weigh("2026-10-26", 172);
  weigh("2026-10-30", 171.5);
  tape("2026-06-05", { waist_in: 40, neck_in: 16 });
  tape("2026-10-26", { waist_in: 34, neck_in: 15, hip_in: 39 });
  const est = bodyFatEstimate(repo.getProfile(), "2026-10-30");
  assert.ok(est.value >= 20.8 && est.value <= 22.8, `central ${est.value}`);
  assert.ok(est.low >= 18.2, `low ${est.low}`);
  assert.ok(est.tape_offset >= 3.5 && est.tape_offset <= 5.5, `offset ${est.tape_offset}`);
  assert.match(est.basis_line, /Tape \(Oct 26\) calibrated to your May 4 DEXA/);
  assert.ok(est.sources.some((s) => s.kind === "dexa" && s.used_as === "calibration"), "the DEXA calibrates the tape, never counted twice");
  assert.ok(est.sources.some((s) => s.kind === "tape" && s.used_as === "calibrated_level"));
});

test("every consumer reads the same estimate; cut caps read the leaner end", () => {
  repo.setProfile({ sex: "male", age: 44, height_in: 69, weight_lb: 170, goal_weight_lb: 160, goal_mode: "lose" });
  weigh(isoDaysAgo(1), 170);
  tape(isoDaysAgo(1), { waist_in: 34, neck_in: 15.5 });
  const profile = repo.getProfile();
  const est = bodyFatEstimate(profile);
  const adapter = repo.currentBodyFatEstimate(profile);
  assert.equal(adapter.body_fat_pct, est.value);
  assert.equal(adapter.low, est.low);
  // The risk read, the standing read and the Body indicator agree on the central value.
  assert.equal(repo.cardiovascularRiskRead().inputs.body_fat_pct, est.value);
  const standingBf = repo.healthStanding().comparisons.find((c) => c.key === "body_fat_pct");
  assert.equal(standingBf.value, est.value);
  const indicator = repo.getBodyIndicators().find((i) => i.key === "bodyfat");
  assert.equal(indicator.value, est.value);
  assert.equal(indicator.low, est.low);
  assert.match(indicator.read, /~\d+% \(\d+–\d+\)/);
  // The loss-rate cap reads the leaner end.
  const goal = repo.computeGoalCheck();
  assert.equal(goal.leanness_rate.planning_body_fat_pct, est.low);
  assert.equal(goal.leanness_rate.reason, repo.leannessAwareLossRates(170, est.low).reason);
});

// ---- second review ------------------------------------------------------------

function garminWeights(daysBack, lb) {
  const src = db.prepare(`INSERT INTO garmin_sources (provider, label) VALUES ('garmin','w')`).run();
  for (let d = daysBack; d >= 0; d--) {
    db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, weight_kg) VALUES (?, ?, ?)`).run(
      src.lastInsertRowid,
      localDaysAgo(d),
      lb / 2.20462
    );
  }
}

test("a scan's own Total Mass and the watch's weigh-ins carry the anchor; every consumer agrees", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 200, goal_weight_lb: 170, goal_mode: "lose" });
  seedHealthDoc(localDaysAgo(120), [marker("Body Fat %", 25, { unit: "%" }), marker("Total Mass", 200, { unit: "lb" })], "dexa");
  garminWeights(10, 180);
  const est = bodyFatEstimate(repo.getProfile());
  assert.ok(est.value > 16 && est.value < 17.5, `projected onto 180 lb with lean mass held: ${est.value}`);
  assert.equal(est.primary, "dexa");
  assert.equal(est.weight_lb, 180);
  assert.equal(repo.cardiovascularRiskRead().inputs.body_fat_pct, est.value);
  assert.equal(repo.healthStanding().comparisons.find((c) => c.key === "body_fat_pct").value, est.value);
  assert.equal(repo.computeGoalCheck().leanness_rate.planning_body_fat_pct, est.low);
});

test("a scan with no weigh-in that day is projected from the first weigh-in after it, at a cost", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 180 });
  seedHealthDoc(localDaysAgo(90), [marker("Body Fat %", 25, { unit: "%" })], "dexa");
  weigh(localDaysAgo(60), 190);
  weigh(localDaysAgo(1), 180);
  const est = bodyFatEstimate(repo.getProfile());
  assert.ok(est.value < 25, `projected leaner with the weight off: ${est.value}`);
  // The same scan with its own weight is better constrained.
  resetTables("health_documents");
  seedHealthDoc(localDaysAgo(90), [marker("Body Fat %", 25, { unit: "%" }), marker("Total Mass", 190, { unit: "lb" })], "dexa");
  const known = bodyFatEstimate(repo.getProfile());
  assert.ok(est.high - est.low > known.high - known.low, "an unknown scan weight widens the range");
});

test("an anchor's range widens with the months passed and the weight moved", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 180 });
  const width = (daysAgo, scanLb) => {
    resetTables("health_documents", "bodyweight_log");
    seedHealthDoc(localDaysAgo(daysAgo), [marker("Body Fat %", 22, { unit: "%" }), marker("Total Mass", scanLb, { unit: "lb" })], "dexa");
    weigh(localDaysAgo(daysAgo), scanLb);
    weigh(localDaysAgo(1), 180);
    const e = bodyFatEstimate(repo.getProfile());
    return e.high - e.low;
  };
  const fresh = width(10, 180);
  const old = width(300, 180);
  const moved = width(10, 200);
  assert.ok(old > fresh, `time widens it (${old} > ${fresh})`);
  assert.ok(moved > fresh, `weight moved widens it (${moved} > ${fresh})`);
});

test("regional DEXA rows are never the total; a BIA printout is direction only", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 180 });
  weigh(localDaysAgo(1), 180);
  seedHealthDoc(
    localDaysAgo(10),
    [
      marker("Body Fat - Arms", 14, { unit: "%" }),
      marker("Body Fat - Legs", 20, { unit: "%" }),
      marker("Body Fat - Trunk", 33, { unit: "%" }),
      marker("Body Fat %", 28, { unit: "%" }),
    ],
    "dexa"
  );
  const dexa = bodyFatEstimate(repo.getProfile());
  assert.ok(Math.abs(dexa.value - 28) < 1, `the total row, not the arms: ${dexa.value}`);
  resetTables("health_documents");
  seedHealthDoc(localDaysAgo(5), [marker("Percent Body Fat", 18, { unit: "%" })], "bloodwork");
  // An InBody printout filed as "other": the ingest infers "dexa" from its body-fat row,
  // but its body-water and skeletal-muscle rows mark it as bioimpedance.
  seedHealthDoc(
    localDaysAgo(3),
    [marker("Body Fat %", 18, { unit: "%" }), marker("Skeletal Muscle Mass", 82, { unit: "lb" }), marker("Total Body Water", 120, { unit: "lb" })],
    "other"
  );
  const bia = bodyFatEstimate(repo.getProfile());
  assert.equal(bia.primary, "anthropometric", "a printout from a bioimpedance device never sets the level");
  assert.ok(bia.sources.some((s) => s.kind === "bioimpedance" && s.used_as === "direction"));
  // A Bod Pod named as one is an anchor whatever the document kind.
  db.prepare("INSERT INTO health_documents (kind, doc_date, original_name, parsed_json, enrichment_status) VALUES ('other', ?, 'Bod Pod report', ?, 'done')").run(
    localDaysAgo(2),
    JSON.stringify({ markers: [{ name: "Percent Body Fat", value: 21, unit: "%" }] })
  );
  assert.equal(bodyFatEstimate(repo.getProfile()).primary, "bod_pod");
});

test("the female Navy formula needs hips; with them it is the level", () => {
  repo.setProfile({ sex: "female", age: 35, height_in: 65, weight_lb: 140 });
  weigh(localDaysAgo(1), 140);
  tape(localDaysAgo(1), { waist_in: 29, neck_in: 13 });
  assert.equal(bodyFatEstimate(repo.getProfile()).primary, "anthropometric", "no hips, no tape level");
  tape(localDaysAgo(1), { hip_in: 38 });
  const est = bodyFatEstimate(repo.getProfile());
  const navy = navyBodyFatPct({ heightIn: 65, waistIn: 29, neckIn: 13, hipIn: 38, female: true });
  assert.equal(est.primary, "tape");
  assert.ok(Math.abs(est.value - navy) < 0.5, `${est.value} vs ${navy}`);
});

test("disagreeing sources widen the range to cover both; an aged anchor hands off to the fallback", () => {
  repo.setProfile({ sex: "male", age: 30, height_in: 70, weight_lb: 180 });
  seedHealthDoc(localDaysAgo(100), [marker("Body Fat %", 30, { unit: "%" })], "dexa");
  weigh(localDaysAgo(100), 180);
  weigh(localDaysAgo(1), 180);
  tape(localDaysAgo(1), { waist_in: 31, neck_in: 16 });
  const navy = navyBodyFatPct({ heightIn: 70, waistIn: 31, neckIn: 16, female: false });
  const est = bodyFatEstimate(repo.getProfile());
  assert.ok(est.low <= navy + 0.05 && est.high >= 29.9, `honestly wide: ${est.low}–${est.high} spans ${navy} and 30`);

  resetTables("health_documents", "body_measurements", "bodyweight_log");
  repo.setProfile({ sex: "male", age: 50, height_in: 70, weight_lb: 200 });
  seedHealthDoc("2022-01-01", [marker("Body Fat %", 22, { unit: "%" })], "dexa");
  const aged = bodyFatEstimate(repo.getProfile());
  assert.ok(aged.sources.some((s) => s.used_as === "fallback"), "height and weight weigh in once the scan is that old");
  assert.ok(aged.value > 22, `pulled toward the better-constrained source: ${aged.value}`);
  assert.ok(aged.low <= 22, "the range still spans the measured scan");
  // Once the fallback carries the level, the result is no longer a measured one.
  assert.equal(aged.measured, false);
  assert.ok(!repo.healthStanding().comparisons.some((c) => c.key === "body_fat_pct"));
  assert.ok(!repo.cardiovascularRiskRead().enhancers.some((e) => e.key === "body_fat"));
});

test("a daily weigh-in wobble never moves the leaner end by a band", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 181 });
  for (let d = 30; d >= 0; d--) weigh(localDaysAgo(d), d % 2 ? 180 : 183);
  tape(localDaysAgo(30), { waist_in: 37, neck_in: 15.5 });
  const lows = [];
  for (let d = 6; d >= 0; d--) lows.push(bodyFatEstimate(repo.getProfile(), localDaysAgo(d)).low);
  for (let i = 1; i < lows.length; i++) {
    // Unsmoothed, the 3 lb wobble would swing the leaner end by more than a point a day.
    assert.ok(Math.abs(lows[i] - lows[i - 1]) < 0.5, `day-to-day ${lows[i - 1]} → ${lows[i]}`);
  }
});

test("a formula-only estimate never claims a result: no percentile, milestone or adiposity lever", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 230, goal_bodyfat_pct: 40, goal_mode: "lose", goal_weight_lb: 200 });
  weigh(localDaysAgo(1), 230);
  const est = repo.currentBodyFatEstimate(repo.getProfile());
  assert.equal(est.measured, false);
  assert.ok(!repo.healthStanding().comparisons.some((c) => c.key === "body_fat_pct"));
  assert.ok(!repo.cardiovascularRiskRead().enhancers.some((e) => e.key === "body_fat"));
  assert.ok(!repo.journeyMilestones().some((m) => /bodyfat/.test(m.kind)), "no body-fat milestone off a formula");
});

test("caps for measured users are never faster than before — except a raw tape that read leaner than its own calibration", () => {
  // Tape only: the old cap read the raw Navy number; the new one reads the leaner end.
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 180, goal_weight_lb: 170, goal_mode: "lose" });
  weigh(localDaysAgo(1), 180);
  tape(localDaysAgo(1), { waist_in: 36, neck_in: 15.5 });
  const navy = navyBodyFatPct({ heightIn: 70, waistIn: 36, neckIn: 15.5, female: false });
  const oldCap = repo.leannessAwareLossRates(180, navy).safe_max_rate_lb;
  const tapeGoal = repo.computeGoalCheck().leanness_rate;
  assert.ok(tapeGoal.safe_max_rate_lb <= oldCap, `${tapeGoal.safe_max_rate_lb} <= raw-tape cap ${oldCap}`);
  assert.equal(tapeGoal.safe_max_rate_lb, repo.leannessAwareLossRates(180, tapeGoal.planning_body_fat_pct).safe_max_rate_lb);
  // The documented exception: a tape whose raw Navy read sits well under the person's own
  // DEXA. Calibrated, the tape reads higher, so the cap loosens toward the truth.
  resetTables("health_documents", "body_measurements", "bodyweight_log");
  repo.setProfile({ sex: "male", age: 38, height_in: 70, weight_lb: 171.5, goal_weight_lb: 165, goal_mode: "lose" });
  seedHealthDoc("2026-05-04", [marker("Body Fat %", 32, { unit: "%" }), marker("Total Mass", 200, { unit: "lb" })], "dexa");
  weigh("2026-05-04", 200);
  weigh("2026-06-05", 196);
  weigh("2026-10-26", 172);
  tape("2026-06-05", { waist_in: 40, neck_in: 16 });
  tape("2026-10-26", { waist_in: 34, neck_in: 15, hip_in: 39 });
  const est = bodyFatEstimate(repo.getProfile(), "2026-10-30");
  const raw = navyBodyFatPct({ heightIn: 70, waistIn: 34, neckIn: 15, female: false });
  assert.ok(est.tape_offset > 0 && raw < est.low, "the raw tape read leaner than its own calibration");
  // So here — and only here — the cap is faster than the old raw-tape one, on purpose.
  const goal = repo.computeGoalCheck().leanness_rate;
  const rawCap = repo.leannessAwareLossRates(171.5, raw).safe_max_rate_lb;
  assert.ok(goal.safe_max_rate_lb >= rawCap, `${goal.safe_max_rate_lb} >= raw-tape cap ${rawCap}`);
  assert.equal(goal.safe_max_rate_lb, repo.leannessAwareLossRates(171.5, goal.planning_body_fat_pct).safe_max_rate_lb);
});


// ---- third review ---------------------------------------------------------------

test("a formula-only estimate claims no band and drives no body-fat lever", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 230 });
  weigh(localDaysAgo(1), 230);
  const ind = repo.getBodyIndicators().find((i) => i.key === "bodyfat");
  assert.equal(ind.measured, false);
  assert.equal(ind.zone, null);
  assert.notEqual(ind.tone, "watch");
  assert.notEqual(repo.getBodyCompFocus().focus?.key, "bodyfat");
  assert.doesNotMatch(String(repo.bodyMetricsContextSlice()?.focus_line ?? ""), /body fat/i);
  const body = repo.healthStanding().dimensions.find((d) => d.id === "body");
  assert.equal(body.tone, "steady", "a shown number from height and weight is neutral, not missing");
});

test("a fat-mass row is never the body-fat percentage", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 180 });
  weigh(localDaysAgo(1), 180);
  seedHealthDoc(
    localDaysAgo(10),
    [marker("Total Body Fat Mass", 45, { unit: "lb" }), marker("Body Fat %", 25, { unit: "%" }), marker("Total Mass", 180, { unit: "lb" })],
    "dexa"
  );
  assert.ok(Math.abs(bodyFatEstimate(repo.getProfile()).value - 25) < 0.6);
  resetTables("health_documents");
  seedHealthDoc(localDaysAgo(10), [marker("Body fat (%)", 24), marker("Total Mass", 180, { unit: "lb" })], "dexa");
  assert.ok(Math.abs(bodyFatEstimate(repo.getProfile()).value - 24) < 0.6, "the 'Body fat (%)' spelling counts");
});

test("a kilogram scan mass is converted; a scan mass far off the weigh-ins is not trusted", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 185 });
  for (const unit of ["kg", "kgs", "Kilograms"]) {
    resetTables("health_documents", "bodyweight_log");
    seedHealthDoc(localDaysAgo(10), [marker("Body Fat %", 25, { unit: "%" }), marker("Total Mass", 84, { unit })], "dexa");
    weigh(localDaysAgo(10), 185);
    weigh(localDaysAgo(1), 185);
    const est = bodyFatEstimate(repo.getProfile());
    assert.ok(Math.abs(est.anchor.scan_lb - 185.2) < 1, `${unit}: ${est.anchor.scan_lb}`);
    assert.ok(Math.abs(est.value - 25) < 0.6, `${unit}: ${est.value}`);
  }
  resetTables("health_documents");
  seedHealthDoc(localDaysAgo(10), [marker("Body Fat %", 25, { unit: "%" }), marker("Total Mass", 84, { unit: "lb" })], "dexa");
  assert.equal(bodyFatEstimate(repo.getProfile()).anchor.scan_lb, null, "84 lb against a 185 lb weigh-in is a misread");
});

test("unset sex is the midpoint with a wider range, never the female arm", () => {
  repo.setProfile({ age: 40, height_in: 70, weight_lb: 180 });
  weigh(localDaysAgo(1), 180);
  const unset = bodyFatEstimate(repo.getProfile());
  repo.setProfile({ sex: "male" });
  const male = bodyFatEstimate(repo.getProfile());
  repo.setProfile({ sex: "female" });
  const female = bodyFatEstimate(repo.getProfile());
  assert.ok(unset.value > male.value && unset.value < female.value, `${male.value} < ${unset.value} < ${female.value}`);
  assert.ok(unset.high - unset.low > male.high - male.low, "the guess costs range");
});

test("an InBody printout filed as dexa is never 'At DEXA', never fat-off, never a directive", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 200 });
  seedHealthDoc(
    localDaysAgo(100),
    [
      marker("Body Fat %", 32, { unit: "%", flag: "high" }),
      marker("Skeletal Muscle Mass", 82, { unit: "lb" }),
      marker("Total Body Water", 120, { unit: "lb" }),
      marker("Weight", 210, { unit: "lb" }),
    ],
    "dexa"
  );
  weigh(localDaysAgo(100), 210);
  weigh(localDaysAgo(1), 200);
  const est = bodyFatEstimate(repo.getProfile());
  assert.equal(est.anchor, null);
  const standing = repo.healthStanding();
  assert.equal(standing.body_comp?.measured ?? null, null);
  const body = standing.dimensions.find((d) => d.id === "body");
  assert.ok(!body.measures.some((m) => /^At /.test(m.label)), "no 'At DEXA' from a bioimpedance printout");
  assert.ok(!repo.standingMomentum().chips.some((c) => c.kind === "fat"), "no fat-off chip");
  repo.deriveDirectives();
  const directives = db.prepare("SELECT marker FROM health_directives WHERE status = 'active'").all();
  assert.ok(!directives.some((d) => /body fat/i.test(String(d.marker))), "no body-fat directive off a BIA printout");
});

test("the anchor scan reads regional rows from its own document and fires its own directive", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 200 });
  seedHealthDoc(
    localDaysAgo(30),
    [
      marker("Body Fat - Arms", 14, { unit: "%" }),
      marker("Body Fat - Trunk", 33, { unit: "%" }),
      marker("Body Fat %", 32, { unit: "%", flag: "high" }),
      marker("Fat Mass (Total)", 65.6, { unit: "lb" }),
      marker("Total Mass", 205, { unit: "lb" }),
    ],
    "dexa"
  );
  weigh(localDaysAgo(30), 205);
  weigh(localDaysAgo(1), 200);
  const comp = repo.healthStanding().body_comp;
  assert.equal(comp.measured.value, 32, "the total row, not the arms");
  assert.equal(comp.anchor_label, "DEXA");
  assert.equal(comp.effective, bodyFatEstimate(repo.getProfile()).value);
  const est = bodyFatEstimate(repo.getProfile());
  assert.equal(comp.fat_mass.delta_lbs, Math.round((200 * (est.value / 100) - 65.6) * 10) / 10, "fat-off is scan fat mass vs the estimate on today's weight");
  repo.deriveDirectives();
  const directives = db.prepare("SELECT marker FROM health_directives WHERE status = 'active'").all();
  assert.ok(directives.some((d) => /body fat/i.test(String(d.marker))), "the current anchor scan may fire it");
});

test("a falling waist never projects body fat upward", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 180 });
  seedHealthDoc(localDaysAgo(10), [marker("Body Fat %", 18, { unit: "%" }), marker("Total Mass", 180, { unit: "lb" })], "dexa");
  weigh(localDaysAgo(10), 180);
  weigh(localDaysAgo(1), 180);
  tape(localDaysAgo(150), { waist_in: 37, neck_in: 15 });
  tape(localDaysAgo(100), { waist_in: 36.5, neck_in: 15 });
  tape(localDaysAgo(80), { waist_in: 36, neck_in: 15 });
  const scale = repo.getBodyCompFocus().scales.find((s) => s.key === "bodyfat");
  assert.ok(scale.projected == null || scale.projected <= scale.value, `${scale.projected} <= ${scale.value}`);
});

test("a no-measurement 5'10\" 168 lb man: the lean-safe floor lifts a too-low target", () => {
  repo.setProfile({ sex: "male", age: 40, height_in: 70, weight_lb: 168, goal_weight_lb: 160, goal_mode: "lose", activity_factor: 1.55 });
  weigh(localDaysAgo(1), 168);
  const est = repo.currentBodyFatEstimate(repo.getProfile());
  assert.equal(est.measured, false);
  repo.setNutritionTarget({ target_kcal: 1500, protein_g: 150, source: "checkin" });
  const stored = Number(db.prepare("SELECT target_kcal FROM nutrition_targets ORDER BY id DESC LIMIT 1").get().target_kcal);
  // Pinned: the formula-only estimate's leaner end (~13%) reads "very lean", so the
  // lean-safe floor lifts 1,500 to 2,221. A tape or scan that narrows the range loosens it.
  assert.equal(stored, 2221, "the formula-only estimate's leaner end paces the floor");
});
