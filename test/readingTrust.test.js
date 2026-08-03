// IS THIS READING VERIFIED, OR IS IT THE WATCH GUESSING?
//
// A daily resting-HR row is not automatically a measured overnight resting heart rate.
// Garmin writes a PROVISIONAL estimate during the day and revises it once it has seen
// a night — and on a wrist the watch is worn episodically, that revision may never
// come. Live on 2026-08-03 the row said resting HR 68, the highest ever recorded,
// written at 16:55 with no sleep on the date and a `min_hr` of 50 on the very same
// row. A resting heart rate eighteen beats above the day's own floor is not a resting
// heart rate; every sleep-backed row that month read 50-54 and steady.
//
// The athlete's rule, now the code's: a result that CHANGES something has to be recent
// AND verified AND continuous. Stale or provisional means do not assume; no complaint
// means things are good. These cases pin the classification seam (READING_TRUST in
// src/repo/coach.ts) and the continuity bar above it.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("daily_metrics", "garmin_daily_metrics", "garmin_sources", "sessions", "logged_sets", "activities");
  db.prepare("INSERT INTO garmin_sources (id, provider, mode) VALUES (1, 'garmin', 'unofficial')").run();
});

// A row that saw the night: sleep present, and a resting HR sitting just above the
// day's own floor, which is the shape of every sleep-backed row on record.
const verifiedNight = (back, restingHr, { hrv = 45, sleep = 450 } = {}) =>
  db
    .prepare(
      `INSERT INTO garmin_daily_metrics (source_id, date, resting_hr, hrv_ms, sleep_min, min_hr, max_hr)
       VALUES (1, ?, ?, ?, ?, ?, 120)`
    )
    .run(localDaysAgo(back), restingHr, hrv, sleep, restingHr - 2);

// Garmin's mid-day guess: no sleep for the date, and a resting HR that argues with the
// same row's own minimum.
const provisionalDay = (back, restingHr, minHr) =>
  db
    .prepare(
      `INSERT INTO garmin_daily_metrics (source_id, date, resting_hr, sleep_min, min_hr, max_hr)
       VALUES (1, ?, ?, NULL, ?, 150)`
    )
    .run(localDaysAgo(back), restingHr, minHr);

const restingOf = (state) => state.dimensions.recovery_capacity.evidence.find((item) => item.field === "resting_hr");

// A steady sleep-backed history, deep enough to clear the delta's coverage floors
// (>=3 readings recent, >=5 baseline).
const steadyHistory = () => {
  for (const back of [3, 4, 5, 8, 11, 14, 17, 20, 24, 28]) verifiedNight(back, back % 2 ? 52 : 54);
};

test("a provisional mid-day estimate is excluded from the trend and cannot date the claim", () => {
  steadyHistory();
  provisionalDay(0, 68, 50); // the live 2026-08-03 row, to the beat

  const summary = repo.getRecoverySummary(30);
  const trust = summary.verified.resting_hr;
  assert.equal(trust.latest_value, 68, "the reading is still reported — it is not deleted, only disbelieved");
  assert.equal(trust.latest_trust, "contradicted");
  assert.equal(trust.latest_trustworthy_date, localDaysAgo(3), "the newest reading a claim may be dated to");
  assert.ok(summary.recent.rhr <= 54, `the 68 must not pull the recent median up, got ${summary.recent.rhr}`);
  assert.ok(
    !trust.readings.some((reading) => reading.value === 68),
    "a contradicted reading never enters the verified series"
  );

  const state = repo.dayPlanningSignalState(localDaysAgo(0));
  const resting = restingOf(state);
  assert.equal(resting.direction, "support", "a provisional spike is not a caution");
  assert.equal(resting.voice.key, "resting_hr_steady");
  assert.equal(resting.date, localDaysAgo(3), "the claim is dated to the reading it was actually derived from");
  // The agent should still be told the newest number it can see is not being read.
  assert.match(resting.summary, /provisional and is not being read as a change/);
});

test("a reading with nothing to check against still counts — absence of corroboration is not contradiction", () => {
  // A generic Apple/Oura row carries no min_hr at all. It is uncorroborated, not
  // contradicted, and dropping it would silently delete the trend for every
  // non-Garmin wearable.
  for (const back of [0, 1, 2, 5, 8, 11, 14]) {
    db.prepare(`INSERT INTO daily_metrics (source, date, resting_hr) VALUES ('apple', ?, 55)`).run(localDaysAgo(back));
  }
  const summary = repo.getRecoverySummary(30);
  assert.equal(summary.verified.resting_hr.latest_trust, "uncorroborated");
  assert.equal(summary.recent.rhr, 55, "an uncorroborated series still produces a median");
  assert.notEqual(summary.delta.rhr, null, "and still produces a comparison");
});

test("a sleep-backed steady series reads as supportive", () => {
  steadyHistory();
  verifiedNight(0, 53);

  const state = repo.dayPlanningSignalState(localDaysAgo(0));
  const resting = restingOf(state);
  assert.equal(resting.direction, "support");
  assert.equal(resting.voice.key, "resting_hr_steady");
  assert.equal(resting.date, localDaysAgo(0));
  assert.doesNotMatch(resting.summary, /provisional/, "nothing provisional here to disclaim");
  assert.equal(state.dimensions.recovery_capacity.status, "supportive");
});

// ---------- continuity: one reading is watched, two are concluded from ----------
// The excursion path reads the verified series only, and needs TWO consecutive
// verified readings beyond the band before it will brake the day. These drive it
// directly so the band arithmetic is exact.
const withSeries = (readings, { baseline = 54, latestTrust = "verified", trustworthyDate } = {}) => {
  const date = localDaysAgo(0);
  return repo.planningSignalState({
    date,
    recovery: {
      recovery: {},
      delta: { rhr: 0 },
      baseline: { rhr: baseline },
      verified: {
        resting_hr: {
          readings,
          latest_date: readings[0]?.date ?? null,
          latest_value: readings[0]?.value ?? null,
          latest_trust: latestTrust,
          latest_trustworthy_date: trustworthyDate ?? readings[0]?.date ?? null,
        },
        hrv_ms: { readings: [], latest_date: null, latest_value: null, latest_trust: "uncorroborated" },
      },
      quality: { resting_hr: { latest_date: date, source: "garmin", freshness: "fresh", sample_count: 14 } },
    },
  });
};

test("a single verified outlier is watched, not concluded from", () => {
  // 54 norm, so the band is 54 + max(5, 4.32) = 59. One reading past it, then normal.
  const state = withSeries([
    { date: localDaysAgo(0), value: 66 },
    { date: localDaysAgo(1), value: 53 },
    { date: localDaysAgo(2), value: 54 },
  ]);
  const resting = restingOf(state);
  assert.equal(resting.direction, "neutral", "one reading may neither brake the day nor endorse it");
  assert.equal(resting.voice.key, "resting_hr_unsettled");
  assert.match(resting.summary, /watched, not concluded from/);
  assert.equal(state.action.posture, "train", "a note decides nothing");
  assert.notEqual(state.dimensions.recovery_capacity.status, "watch");
});

test("two consecutive verified outliers are a caution", () => {
  const state = withSeries([
    { date: localDaysAgo(0), value: 66 },
    { date: localDaysAgo(1), value: 64 },
    { date: localDaysAgo(2), value: 54 },
  ]);
  const resting = restingOf(state);
  assert.equal(resting.direction, "caution");
  assert.equal(resting.voice.key, "resting_hr_excursion");
  assert.match(resting.summary, /most recent verified resting heart rate readings/);
  assert.equal(state.dimensions.recovery_capacity.status, "watch");
});

test("the run has to be the NEWEST readings, not any two in the window", () => {
  const state = withSeries([
    { date: localDaysAgo(0), value: 53 },
    { date: localDaysAgo(1), value: 66 },
    { date: localDaysAgo(2), value: 64 },
  ]);
  const resting = restingOf(state);
  assert.equal(resting.direction, "support", "the excursion is over — the newest verified reading is normal");
  assert.equal(resting.voice.key, "resting_hr_steady");
});

test("an empty verified series cannot produce an excursion of any kind", () => {
  const state = withSeries([], { latestTrust: "contradicted" });
  const resting = restingOf(state);
  assert.equal(resting.direction, "support", "no verified reading is absence, and absence is neutral");
  assert.match(resting.summary, /provisional and is not being read as a change/);
});

// ---------- the excursion obeys the freshness law, and dates itself honestly ----------
// The run walks the whole 90-day verified series, so nothing about it is recent by
// construction. The claim's DATE used to come from `latest_trustworthy_date` — the
// newest non-contradicted row of any kind, `uncorroborated` included — which is a row
// the excursion may never have consulted. Two months of silence plus one fresh
// uncorroborated reading therefore produced a caution about "your latest reading",
// stamped today, built entirely out of readings from June.
test("a verified series that has aged out cannot open an excursion", () => {
  const state = withSeries(
    [
      { date: localDaysAgo(60), value: 66 },
      { date: localDaysAgo(61), value: 64 },
      { date: localDaysAgo(62), value: 54 },
    ],
    { latestTrust: "uncorroborated", trustworthyDate: localDaysAgo(0) }
  );
  const resting = restingOf(state);
  assert.equal(resting.direction, "support", "stale behaves as absent, and absence is neutral");
  assert.equal(resting.voice.key, "resting_hr_steady");
  assert.notEqual(state.dimensions.recovery_capacity.status, "watch");
  // The trend keeps the newest trustworthy date, which is correct for IT — the
  // medians are taken over exactly those rows. What may no longer happen is an
  // EXCURSION borrowing that date for a run it built out of readings from June.
  assert.notEqual(resting.voice.key, "resting_hr_excursion");
});

test("a stale single outlier is not even an unsettled note", () => {
  const state = withSeries(
    [
      { date: localDaysAgo(30), value: 66 },
      { date: localDaysAgo(31), value: 53 },
    ],
    { trustworthyDate: localDaysAgo(0) }
  );
  const resting = restingOf(state);
  assert.equal(resting.direction, "support");
  assert.equal(resting.voice.key, "resting_hr_steady", "the trend/steady logic handles an aged-out series");
});

test("an excursion is dated to the newest reading it was actually built from", () => {
  const state = withSeries(
    [
      { date: localDaysAgo(2), value: 66 },
      { date: localDaysAgo(3), value: 64 },
      { date: localDaysAgo(4), value: 54 },
    ],
    { trustworthyDate: localDaysAgo(0) }
  );
  const resting = restingOf(state);
  assert.equal(resting.direction, "caution");
  assert.equal(resting.voice.key, "resting_hr_excursion");
  assert.equal(resting.date, localDaysAgo(2), "the claim points at the reading the run starts from");
});

test("the unsettled voices are non-directive, and a real vocabulary", () => {
  for (const key of ["hrv_unsettled", "resting_hr_unsettled"]) {
    const variants = repo.signalVoice({ key });
    assert.ok(variants.length >= 4, `${key} needs enough phrasings to rotate`);
    assert.equal(new Set(variants).size, variants.length, `${key} repeats a phrasing`);
    for (const line of variants) {
      assert.doesNotMatch(line, /\bthe athlete\b/i);
      // A neutral observation may not speak like a brake.
      assert.doesNotMatch(line, /\bease\b|\beasing\b|\bgentl/i, `${key} brakes a day the arbitration left alone`);
    }
  }
});
