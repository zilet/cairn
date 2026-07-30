// Personal-baseline bands (src/repo/baseline-bands.ts) — VISION Amendment 2's
// reading grammar for recovery + training load. These pin the deterministic math
// that the reading grammar rests on: R-7 quartiles, the min-history gate, the
// per-dimension phrase selection (including the resting-HR inversion — where
// "above your usual" is the watch side, unlike HRV/sleep), and the [0,1] band
// geometry stays clamped + ordered. Plus light DB-backed smoke tests for the two
// wrappers that assemble the series the routes attach to their payloads.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedTrainingDay, localDaysAgo } from "./_seed.js";

const { recoveryBaselineRead, trainingLoadBaselineRead, getRecoveryBaselineRead, trainingLoadBand } = repo;

// [1..n] — a clean, evenly-spaced series with known R-7 quartiles.
const seq = (n) => Array.from({ length: n }, (_, i) => i + 1);
// For seq(12): p25 = 3.75, p75 = 9.25 (verified against the R-7 definition).
const dim = (values, current) => ({ values, current });
const byKey = (read) => Object.fromEntries(read.dimensions.map((d) => [d.key, d]));

// Every emitted dimension's band geometry must be a clamped, ordered [0,1] triple.
function assertBandGeometry(d) {
  for (const k of ["position", "range_start", "range_end"]) {
    assert.ok(d[k] >= 0 && d[k] <= 1, `${d.key}.${k} in [0,1] (got ${d[k]})`);
  }
  assert.ok(d.range_start <= d.range_end, `${d.key} range_start <= range_end`);
}

test("recovery: min-history gate drops thin dimensions", () => {
  const read = recoveryBaselineRead({
    hrv: dim(seq(9), 9), // 9 points < 10 → dropped
    rhr: dim(seq(12), 6), // 12 points → kept
    sleep: dim([], null), // no data → dropped
  });
  const keys = read.dimensions.map((d) => d.key);
  assert.deepEqual(keys, ["rhr"]);
});

test("recovery: a null current keeps the BAND but never invents a dot", () => {
  const read = recoveryBaselineRead({
    hrv: dim(seq(12), null),
    rhr: dim(seq(12), 6),
    sleep: dim(seq(12), 6),
  });
  const hrv = byKey(read).hrv;
  assert.ok(hrv, "the personal range is durable — it outlives last night's reading");
  assert.equal(hrv.current, null, "and the missing dot is not filled in from history");
  assert.equal(hrv.position, null);
  assert.equal(hrv.hot, false, "no dot, no lever");
  assert.equal(hrv.phrase, "your usual range", "the phrase names the band, not a position in it");
  assert.equal(hrv.p25, 3.75, "the band math is untouched by the missing dot");
  assert.equal(hrv.p75, 9.25);
  assert.ok(hrv.range_start <= hrv.range_end);
  assert.ok(byKey(read).rhr.position != null);
  assert.ok(byKey(read).sleep.position != null);
});

test("recovery: the dotless phrase per dimension stays qualitative and calm", () => {
  const read = recoveryBaselineRead({ hrv: dim(seq(12), null), rhr: dim(seq(12), null), sleep: dim(seq(12), null) });
  const k = byKey(read);
  assert.equal(k.hrv.phrase, "your usual range");
  assert.equal(k.rhr.phrase, "your usual range");
  assert.equal(k.sleep.phrase, "your usual nights");
  for (const d of read.dimensions) {
    assert.equal(d.hot, false);
    assert.doesNotMatch(d.phrase, /\d/, "no number ever reaches the band row");
  }
});

test("recovery: provenance rides along — count, span and the last reading's date", () => {
  const read = recoveryBaselineRead({
    hrv: { values: seq(12), current: null, first_reading_date: "2026-03-01", last_reading_date: "2026-06-29" },
    rhr: dim(seq(12), 6), // no dates supplied → provenance degrades to null, never throws
    sleep: dim([], null),
  });
  const k = byKey(read);
  assert.equal(k.hrv.readings, 12);
  assert.equal(k.hrv.n, 12, "n stays the legacy alias of readings");
  assert.equal(k.hrv.span_days, 120, "2026-03-01 → 2026-06-29 is 120 days");
  assert.equal(k.hrv.last_reading_date, "2026-06-29");
  assert.equal(k.rhr.span_days, null);
  assert.equal(k.rhr.last_reading_date, null);
});

test("recovery: above / below / in-range phrasing per dimension + the RHR inversion", () => {
  // current 12 is above p75 (9.25) for all three; current 1 is below p25 (3.75).
  const above = recoveryBaselineRead({ hrv: dim(seq(12), 12), rhr: dim(seq(12), 12), sleep: dim(seq(12), 12) });
  const a = byKey(above);
  assert.equal(a.hrv.phrase, "above your usual");
  assert.equal(a.hrv.hot, false, "high HRV is the good side — never hot");
  assert.equal(a.rhr.phrase, "above your usual");
  assert.equal(a.rhr.hot, true, "elevated resting HR is the actionable watch side — hot");
  assert.equal(a.sleep.phrase, "longer than usual");
  assert.equal(a.sleep.hot, false);

  const below = recoveryBaselineRead({ hrv: dim(seq(12), 1), rhr: dim(seq(12), 1), sleep: dim(seq(12), 1) });
  const b = byKey(below);
  assert.equal(b.hrv.phrase, "below your usual");
  assert.equal(b.hrv.hot, false, "low HRV means rest gently — never punished");
  assert.equal(b.rhr.phrase, "below your usual");
  assert.equal(b.rhr.hot, false, "a low resting HR is a win, not a lever");
  assert.equal(b.sleep.phrase, "shorter than usual");
  assert.equal(b.sleep.hot, false);

  const mid = recoveryBaselineRead({ hrv: dim(seq(12), 6), rhr: dim(seq(12), 6), sleep: dim(seq(12), 6) });
  const m = byKey(mid);
  assert.equal(m.hrv.phrase, "in your usual range");
  assert.equal(m.rhr.phrase, "in your usual range");
  assert.equal(m.sleep.phrase, "about your usual");
  assert.equal(m.rhr.hot, false, "resting HR inside the range is not hot");
});

test("recovery: band geometry stays clamped and ordered, raw numbers carried for depth", () => {
  const read = recoveryBaselineRead({ hrv: dim(seq(12), 12), rhr: dim(seq(12), 3), sleep: dim(seq(12), 6) });
  assert.equal(read.dimensions.length, 3);
  for (const d of read.dimensions) {
    assertBandGeometry(d);
    assert.equal(d.p25, 3.75);
    assert.equal(d.p75, 9.25);
    assert.equal(d.n, 12);
    assert.ok(typeof d.label === "string" && d.label.length > 0);
  }
});

test("training load: fewer than the minimum prior weeks → null", () => {
  assert.equal(trainingLoadBaselineRead({ current: 20, history: [10, 10, 10] }), null);
  assert.ok(trainingLoadBaselineRead({ current: 20, history: [10, 10, 10, 10] }));
});

test("training load: running hot only when genuinely above the trailing typical", () => {
  const hot = trainingLoadBaselineRead({ current: 16, history: [8, 8, 8, 8, 8] });
  assert.equal(hot.phrase, "running hot");
  assert.equal(hot.hot, true);
  assert.equal(hot.n, 5);

  const light = trainingLoadBaselineRead({ current: 2, history: [8, 8, 8, 8, 8] });
  assert.equal(light.phrase, "a lighter week than usual");
  assert.equal(light.hot, false, "a lighter week is calm information, never a scold");

  const usual = trainingLoadBaselineRead({ current: 8, history: [8, 8, 8, 8, 8] });
  assert.equal(usual.phrase, "about your usual volume");
  assert.equal(usual.hot, false);
});

test("training load: band geometry stays clamped and ordered", () => {
  const band = trainingLoadBaselineRead({ current: 25, history: [5, 10, 15, 20] });
  assert.ok(band);
  assertBandGeometry(band);
  assert.equal(band.label, "Training load");
  assert.ok(band.current === 25 && band.p25 <= band.p75);
});

// ---- DB-backed smoke tests for the payload wrappers -------------------------

beforeEach(() => {
  resetTables(
    "daily_metrics",
    "garmin_daily_metrics",
    "sessions",
    "logged_sets",
    "plan_days",
    "plan_items",
    "activities"
  );
});

test("getRecoveryBaselineRead assembles the recent-readings sample and reads today against it", () => {
  // 13 steady prior days, then a distinctly high-HRV / high-RHR / short-sleep today.
  for (let i = 13; i >= 1; i--) {
    repo.recordDailyMetrics("apple", localDaysAgo(i), { hrv_ms: 50, resting_hr: 55, sleep_min: 440 });
  }
  repo.recordDailyMetrics("apple", localDaysAgo(0), { hrv_ms: 80, resting_hr: 70, sleep_min: 300 });

  const read = getRecoveryBaselineRead();
  const k = byKey(read);
  assert.ok(k.hrv && k.rhr && k.sleep, "all three dimensions have enough history");

  assert.equal(k.hrv.current, 80);
  assert.equal(k.hrv.phrase, "above your usual");
  assert.equal(k.hrv.hot, false);

  assert.equal(k.rhr.current, 70);
  assert.equal(k.rhr.phrase, "above your usual");
  assert.equal(k.rhr.hot, true, "elevated resting HR surfaces as the lever");

  assert.equal(k.sleep.current, 300);
  assert.equal(k.sleep.phrase, "shorter than usual");
  for (const d of read.dimensions) assertBandGeometry(d);
});

test("getRecoveryBaselineRead is empty when there isn't enough history", () => {
  for (let i = 3; i >= 0; i--) repo.recordDailyMetrics("apple", localDaysAgo(i), { hrv_ms: 55 });
  assert.deepEqual(getRecoveryBaselineRead().dimensions, []);
});

// ---- the episodic wearer ----------------------------------------------------
//
// The band is SAMPLE-anchored: the newest RECOVERY_BASELINE_MAX_POINTS readings
// within RECOVERY_BASELINE_LOOKBACK_DAYS, not "whatever landed in the last 28
// calendar days". A wearer who straps the watch on for runs and the occasional
// baseline night has a real personal range; the old calendar window threw it away.

// R-7 quantile, implemented independently of the module under test, so the band
// math is checked against the definition rather than against itself.
const q = (values, p) => {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  return s[lo] + (h - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]);
};

// 12 HRV readings scattered across ~4 months, the newest of them 4 days old —
// past the 3-day HRV bound, so nothing here may speak for today.
const EPISODIC_HRV_OFFSETS = [4, 15, 26, 37, 48, 59, 70, 81, 92, 103, 114, 124];
function seedEpisodicHrv() {
  EPISODIC_HRV_OFFSETS.forEach((offset, i) => {
    repo.recordDailyMetrics("apple", localDaysAgo(offset), { hrv_ms: 44 + i * 2 });
  });
}

test("episodic: 12 readings over 4 months build a band even with no reading in days", () => {
  seedEpisodicHrv();
  const hrv = byKey(getRecoveryBaselineRead()).hrv;
  assert.ok(hrv, "thin-but-real history is a personal range, not nothing");
  assert.equal(hrv.current, null, "the newest reading is 4 days old — it cannot speak for today");
  assert.equal(hrv.position, null, "so the band draws without a dot");
  assert.equal(hrv.hot, false);
  assert.equal(hrv.phrase, "your usual range");

  const values = EPISODIC_HRV_OFFSETS.map((_, i) => 44 + i * 2);
  assert.equal(hrv.p25, q(values, 0.25), "the band is the quartiles of the readings actually used");
  assert.equal(hrv.p75, q(values, 0.75));
  assert.ok(hrv.range_start >= 0 && hrv.range_end <= 1 && hrv.range_start <= hrv.range_end);

  assert.equal(hrv.readings, 12);
  assert.equal(hrv.n, 12);
  assert.equal(hrv.span_days, 120, "oldest→newest of the readings used");
  assert.equal(hrv.last_reading_date, localDaysAgo(4));
  // The other two dimensions were never worn — they stay absent, not empty rows.
  assert.deepEqual(
    getRecoveryBaselineRead().dimensions.map((d) => d.key),
    ["hrv"]
  );
});

test("episodic: one fresh reading turns the same band's dot back on", () => {
  seedEpisodicHrv();
  repo.recordDailyMetrics("apple", localDaysAgo(0), { hrv_ms: 80 });
  const hrv = byKey(getRecoveryBaselineRead()).hrv;
  assert.equal(hrv.current, 80);
  assert.equal(typeof hrv.position, "number");
  assert.equal(hrv.phrase, "above your usual", "and only now is a position spoken");
  assert.equal(hrv.hot, false);
  assert.equal(hrv.readings, 13);
  assert.equal(hrv.last_reading_date, localDaysAgo(0));
  assert.equal(hrv.span_days, 124);
});

test("episodic: the minimum still holds — 9 readings inside the lookback is nothing", () => {
  for (let i = 0; i < 9; i++) repo.recordDailyMetrics("apple", localDaysAgo(10 + i * 15), { hrv_ms: 46 + i });
  assert.deepEqual(getRecoveryBaselineRead().dimensions, [], "9 readings is still thin data");
  // The tenth reading is the whole difference.
  repo.recordDailyMetrics("apple", localDaysAgo(145), { hrv_ms: 55 });
  assert.equal(byKey(getRecoveryBaselineRead()).hrv?.readings, 10);
});

test("episodic: readings older than the lookback are out of reach", () => {
  // 10 readings inside the window, 20 much older ones with a wildly different range.
  for (let i = 0; i < 10; i++) repo.recordDailyMetrics("apple", localDaysAgo(91 + i), { hrv_ms: 60 + i });
  for (let i = 0; i < 20; i++) repo.recordDailyMetrics("apple", localDaysAgo(200 + i), { hrv_ms: 10 });
  const hrv = byKey(getRecoveryBaselineRead()).hrv;
  assert.ok(hrv);
  assert.equal(hrv.readings, 10, "last year's body is not this year's baseline");
  assert.equal(hrv.p25, q([60, 61, 62, 63, 64, 65, 66, 67, 68, 69], 0.25));
  assert.equal(hrv.last_reading_date, localDaysAgo(91));
  assert.equal(hrv.span_days, 9);
});

test("daily wearer: the sample-anchored band equals the old 28-day calendar band", () => {
  // 40 consecutive daily readings. The newest 28 ARE the last 28 calendar days, so
  // an unbroken wearer's band must be exactly what the calendar window produced —
  // and days 28..39 (a deliberately absurd 10 ms) must not leak into it.
  for (let i = 0; i <= 27; i++) repo.recordDailyMetrics("apple", localDaysAgo(i), { hrv_ms: 200 - i });
  for (let i = 28; i <= 39; i++) repo.recordDailyMetrics("apple", localDaysAgo(i), { hrv_ms: 10 });

  const last28 = Array.from({ length: 28 }, (_, i) => 200 - i); // today−27 … today
  const hrv = byKey(getRecoveryBaselineRead()).hrv;
  assert.ok(hrv);
  assert.equal(hrv.readings, 28, "capped at the newest 28 readings");
  assert.equal(hrv.p25, q(last28, 0.25));
  assert.equal(hrv.p75, q(last28, 0.75));
  assert.equal(hrv.current, 200, "today's reading is the dot");
  assert.equal(hrv.span_days, 27);
  assert.ok(hrv.p25 > 100, "the pre-window readings never entered the quartiles");
});

test("trainingLoadBand reads this week against the prior weekly buckets", () => {
  // This week: 4 training days (16 sets). Prior weeks 1..5: 2 days each (8 sets),
  // seeded mid-bucket so a timezone offset can't push a day out of its week.
  for (const d of [1, 2, 3, 4]) seedTrainingDay(localDaysAgo(d));
  const midWeek = [
    [9, 10],
    [16, 17],
    [23, 24],
    [30, 31],
    [37, 38],
  ];
  for (const [a, b] of midWeek) {
    seedTrainingDay(localDaysAgo(a));
    seedTrainingDay(localDaysAgo(b));
  }

  const band = trainingLoadBand();
  assert.ok(band, "band present with enough prior weeks");
  assert.equal(band.current, 16, "this week's set count is the trailing-7-day total");
  assert.equal(band.n, 5, "weeks 6-8 (empty pre-training) trimmed; 5 buckets remain");
  assert.equal(band.phrase, "running hot");
  assert.equal(band.hot, true);
  assertBandGeometry(band);
});

test("trainingLoadBand is null until there are enough prior weeks", () => {
  // Only the current week + one prior week of activity → far under the gate.
  for (const d of [1, 2]) seedTrainingDay(localDaysAgo(d));
  seedTrainingDay(localDaysAgo(9));
  assert.equal(trainingLoadBand(), null);
});
