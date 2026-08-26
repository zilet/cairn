// Sensor COVERAGE discipline (src/repo/sensor-cadence.ts).
//
// Its sibling law asks how OLD a datum may be; this one asks how MUCH of a series
// there is. The ruling, in one sentence:
//
//   A THIN SAMPLE MAY DESCRIBE ITSELF, NEVER A TREND.
//
// The athlete wears the watch episodically — every run, the odd baseline night —
// and the failure this exists to prevent is a confident "your HRV is below your
// norm" derived from two readings against four. Thin data resolves the way absence
// already does: neutral. Never a caution, never a nudge toward rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyWearPattern,
  hasDecisionGradeCoverage,
  recoverySignalIsDecisionGrade,
} from "../dist/repo/sensor-cadence.js";

const TODAY = "2026-07-30";
// n days before TODAY, as a YYYY-MM-DD key.
const back = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
// A run of consecutive days ending `endDaysAgo` before TODAY.
const run = (count, endDaysAgo = 0) => Array.from({ length: count }, (_, i) => back(endDaysAgo + i));

// ---- wear pattern -----------------------------------------------------------

test("no readings at all is 'none', and says so without inventing a rhythm", () => {
  const cadence = classifyWearPattern([], TODAY);
  assert.deepEqual(cadence, {
    pattern: "none",
    readings: 0,
    window_days: 90,
    coverage_ratio: 0,
    last_reading_date: null,
    median_gap_days: null,
  });
});

test("a single reading is a spot check with no gap — one dot has no rhythm", () => {
  const cadence = classifyWearPattern([back(3)], TODAY);
  assert.equal(cadence.pattern, "spot_check");
  assert.equal(cadence.readings, 1);
  assert.equal(cadence.last_reading_date, back(3));
  assert.equal(cadence.median_gap_days, null);
});

test("a handful of scattered readings reads as spot_check", () => {
  const cadence = classifyWearPattern([back(2), back(20), back(41), back(70)], TODAY);
  assert.equal(cadence.pattern, "spot_check");
  assert.equal(cadence.readings, 4);
  assert.ok(cadence.coverage_ratio < 0.15, `4/90 is under the intermittent bar, got ${cadence.coverage_ratio}`);
});

test("a weekly-ish wearer reads as intermittent", () => {
  // One reading every 5 days across the window: 18 of 90 days = 0.2.
  const dates = Array.from({ length: 18 }, (_, i) => back(i * 5));
  const cadence = classifyWearPattern(dates, TODAY);
  assert.equal(cadence.pattern, "intermittent");
  assert.equal(cadence.readings, 18);
  assert.equal(cadence.coverage_ratio, 0.2);
  assert.equal(cadence.median_gap_days, 5, "the typical distance between readings is named in plain days");
});

test("a daily wearer reads as continuous even with days lost to charging", () => {
  // 70 of the last 90 days worn.
  const cadence = classifyWearPattern(run(70), TODAY);
  assert.equal(cadence.pattern, "continuous");
  assert.equal(cadence.median_gap_days, 1);
  assert.ok(cadence.coverage_ratio >= 0.6);
});

// The two thresholds are product rulings, so they are pinned exactly — a drift of
// one reading must not silently reclassify an athlete's whole wearable story.
test("the coverage boundaries are inclusive at exactly 0.6 and exactly 0.15", () => {
  const continuous = classifyWearPattern(run(54), TODAY); // 54/90 = 0.6 exactly
  assert.equal(continuous.coverage_ratio, 0.6);
  assert.equal(continuous.pattern, "continuous");

  const justUnder = classifyWearPattern(run(53), TODAY);
  assert.equal(justUnder.pattern, "intermittent", "one reading short of the bar is not continuous");

  const intermittent = classifyWearPattern(
    Array.from({ length: 14 }, (_, i) => back(i * 6)),
    TODAY
  ); // 14/90 ≈ 0.156
  assert.equal(intermittent.pattern, "intermittent");

  const spot = classifyWearPattern(
    Array.from({ length: 13 }, (_, i) => back(i * 6)),
    TODAY
  ); // 13/90 ≈ 0.144
  assert.equal(spot.pattern, "spot_check");

  // And the boundary itself, stated in the cleanest possible terms.
  const exactly15 = classifyWearPattern(
    run(15),
    // a 100-day window makes 15 readings exactly 0.15
    TODAY,
    100
  );
  assert.equal(exactly15.coverage_ratio, 0.15);
  assert.equal(exactly15.pattern, "intermittent");
});

test("duplicate dates collapse — two sources reporting one night is one night of coverage", () => {
  const cadence = classifyWearPattern([back(1), back(1), back(1), back(2), back(2)], TODAY);
  assert.equal(cadence.readings, 2);
  assert.equal(cadence.median_gap_days, 1);
});

test("dates outside the window, junk and future dates are ignored", () => {
  const cadence = classifyWearPattern([back(1), back(200), "not-a-date", "", null, undefined, "2026-08-15"], TODAY);
  assert.equal(cadence.readings, 1, "only the in-window reading counts");
  assert.equal(cadence.last_reading_date, back(1));

  // A window that contains nothing but out-of-range dates is absence, not a spot check.
  assert.equal(classifyWearPattern([back(120), back(400)], TODAY).pattern, "none");
});

test("the window is inclusive of today and of its first day", () => {
  const seven = classifyWearPattern([TODAY, back(6)], TODAY, 7);
  assert.equal(seven.readings, 2, "today and day 6 back both sit inside a 7-day window");
  const eight = classifyWearPattern([back(7)], TODAY, 7);
  assert.equal(eight.readings, 0, "day 7 back does not");
});

test("median gap is the middle of the gaps, not the average span", () => {
  // Gaps of 1, 1, 1 and 40 days: the mean would be ~11, the median is 1.
  const cadence = classifyWearPattern([back(60), back(20), back(19), back(18), back(17)], TODAY);
  assert.equal(cadence.median_gap_days, 1, "one long absence must not restate a daily habit as monthly");
  // An even count averages the two middles.
  const even = classifyWearPattern([back(10), back(8), back(4)], TODAY);
  assert.equal(even.median_gap_days, 3, "gaps of 2 and 4 -> 3");
});

// ---- decision-grade coverage ------------------------------------------------

// The gate the coaching-focus conductor has always applied, extracted verbatim.
// This is the parity oracle: the exact arithmetic that used to live inline at
// src/repo/coaching-focus.ts, kept here so a refactor cannot quietly move a bar.
function legacyGate(samples, expected) {
  if (samples == null || samples < 0) return false;
  const requiredSamples = expected != null && expected > 0 ? Math.max(3, Math.ceil(Math.min(expected, 14) / 2)) : 5;
  return samples >= requiredSamples;
}

test("hasDecisionGradeCoverage matches the conductor's original arithmetic exactly", () => {
  const expectations = [null, undefined, 0, 1, 2, 3, 4, 6, 7, 8, 13, 14, 15, 30, 90, 366];
  for (const expected of expectations) {
    for (let samples = 0; samples <= 20; samples++) {
      assert.equal(
        hasDecisionGradeCoverage(samples, expected),
        legacyGate(samples, expected ?? null),
        `samples=${samples} expected=${String(expected)}`
      );
    }
  }
});

test("the shape of the gate, stated in cases", () => {
  assert.equal(hasDecisionGradeCoverage(4, 7), true, "half of a week, rounded up");
  assert.equal(hasDecisionGradeCoverage(3, 7), false);
  assert.equal(hasDecisionGradeCoverage(3, 6), true, "half of six days IS three");
  assert.equal(hasDecisionGradeCoverage(2, 6), false);
  assert.equal(hasDecisionGradeCoverage(7, 14), true, "half of a fortnight");
  assert.equal(hasDecisionGradeCoverage(6, 14), false);
  assert.equal(hasDecisionGradeCoverage(7, 90), true, "a longer window does not keep raising the bar");
  assert.equal(hasDecisionGradeCoverage(6, 90), false);
  assert.equal(hasDecisionGradeCoverage(3, 2), true, "a tiny window still needs the three-sample floor");
  assert.equal(hasDecisionGradeCoverage(2, 2), false);
  assert.equal(hasDecisionGradeCoverage(5, null), true, "an unknown window is held to a flat five");
  assert.equal(hasDecisionGradeCoverage(4, null), false);
});

test("a missing or nonsensical sample count is never decision-grade", () => {
  assert.equal(hasDecisionGradeCoverage(null, 14), false);
  assert.equal(hasDecisionGradeCoverage(undefined, 14), false);
  assert.equal(hasDecisionGradeCoverage(Number.NaN, 14), false);
  assert.equal(hasDecisionGradeCoverage(-1, 14), false);
  assert.equal(hasDecisionGradeCoverage(0, 14), false);
});

test("a caller may raise the floor, and the unknown-window fallback never drops below five", () => {
  assert.equal(hasDecisionGradeCoverage(5, 7, 6), false, "a raised floor binds even on a short window");
  assert.equal(hasDecisionGradeCoverage(6, 7, 6), true);
  assert.equal(hasDecisionGradeCoverage(6, null, 8), false);
  assert.equal(hasDecisionGradeCoverage(8, null, 8), true);
});

test("recoverySignalIsDecisionGrade is the one freshness+coverage gate", () => {
  const fresh = {
    quality: {
      hrv_ms: { latest_date: TODAY, freshness: "fresh", sample_count: 8, expected_days: 14 },
    },
  };
  assert.equal(recoverySignalIsDecisionGrade(fresh, "hrv_ms"), true);
  assert.equal(
    recoverySignalIsDecisionGrade(
      { quality: { hrv_ms: { latest_date: TODAY, freshness: "stale", sample_count: 8, expected_days: 14 } } },
      "hrv_ms"
    ),
    false,
    "stale is not decision-grade even with coverage"
  );
  assert.equal(
    recoverySignalIsDecisionGrade(
      { quality: { hrv_ms: { latest_date: TODAY, freshness: "fresh", sample_count: 2, expected_days: 14 } } },
      "hrv_ms"
    ),
    false,
    "thin coverage is not decision-grade even when fresh"
  );
});
