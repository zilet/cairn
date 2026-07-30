// Sensor timestamp discipline (src/repo/sensor-freshness.ts and its consumers).
//
// The ruling this pins, in the athlete's own words: "All of the sensor data has to
// come with a timestamp and that has to influence decisions — as I might not be
// syncing data or wearing my watch for long."
//
// Operationalized as one sentence, asserted here at every decision site:
//
//   STALE SENSOR DATA BEHAVES AS ABSENT, NEVER AS CURRENT.
//
// "As absent" is exact and it cuts both ways. Absence is already neutral everywhere
// in this codebase — a watch left in a drawer never reads as caution, never forces a
// rest day. So the test for each gate is not "the stale datum is flagged", it is "the
// read is byte-identical to the read with no datum at all".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, localDaysAgo } from "./_seed.js";

beforeEach(() => {
  resetTables("garmin_daily_metrics", "garmin_sources", "daily_metrics", "health_documents", "profile", "checkins");
});

function garminSource() {
  db.prepare("INSERT OR IGNORE INTO garmin_sources (id, provider, mode) VALUES (1, 'garmin', 'unofficial')").run();
}

// Write one Garmin daily row. `cols` is a plain {column: value} map.
function garminDay(daysAgo, cols) {
  garminSource();
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, ${keys.join(", ")})
     VALUES (1, ?, ${keys.map(() => "?").join(", ")})`
  ).run(localDaysAgo(daysAgo), ...keys.map((k) => cols[k]));
}

const wearableMarker = (name) =>
  repo.prioritizeMarkers().markers.find((m) => m.source === "wearable" && m.name === name) ?? null;

// ---- the bounds themselves ---------------------------------------------------

test("sensorAgeDays counts whole days, and refuses a date it cannot vouch for", () => {
  assert.equal(repo.sensorAgeDays("2026-07-20", "2026-07-30"), 10);
  assert.equal(repo.sensorAgeDays("2026-07-30", "2026-07-30"), 0);
  assert.equal(repo.sensorAgeDays(null, "2026-07-30"), null);
  assert.equal(repo.sensorAgeDays("not-a-date", "2026-07-30"), null);
});

test("a future-dated reading is a clock problem, not fresh evidence", () => {
  // Negative age is NOT clamped to 0 — a reading dated after the day being read
  // cannot speak for it.
  assert.equal(repo.sensorAgeDays("2026-08-02", "2026-07-30"), -3);
  assert.equal(repo.sensorIsCurrent("sleep", "2026-08-02", "2026-07-30"), false);
});

test("a missing date resolves the same way stale does", () => {
  assert.equal(repo.sensorIsCurrent("hrv", null, "2026-07-30"), false);
  assert.equal(repo.sensorIsCurrent("hrv", undefined, "2026-07-30"), false);
});

test("each signal's bound is inclusive on its own last day", () => {
  const { SENSOR_MAX_AGE_DAYS: max } = repo;
  for (const signal of Object.keys(max)) {
    const at = repo.sensorIsCurrent(signal, localDaysAgo(max[signal]), localDaysAgo(0));
    const past = repo.sensorIsCurrent(signal, localDaysAgo(max[signal] + 1), localDaysAgo(0));
    assert.equal(at, true, `${signal} still counts on day ${max[signal]}`);
    assert.equal(past, false, `${signal} stops counting the day after ${max[signal]}`);
  }
});

// ---- forecast support: the honesty layer both marker paths share --------------

test("forecastSupport suppresses a projection two dots cannot sustain", () => {
  const thin = repo.forecastSupport({ name: "VO2max", n: 2, weeklySlope: 0.4, latestValue: 44 });
  assert.equal(thin.suppressProjection, true);
  assert.equal(thin.stale, false, "thin is not the same complaint as stale");
});

test("forecastSupport drops an implausibly steep slope", () => {
  const steep = repo.forecastSupport({ name: "VO2max", n: 8, weeklySlope: 30, latestValue: 44 });
  assert.equal(steep.suppressProjection, true, "30 mL/kg/min per week will not hold");
});

test("a lab series never ages out — a dated draw stays that dated draw", () => {
  // No staleAfterDays passed → the staleness bound does not apply at all. A
  // cholesterol panel from March is still that March panel.
  const old = repo.forecastSupport({
    name: "ApoB",
    n: 6,
    weeklySlope: -0.5,
    latestValue: 90,
    latestDate: localDaysAgo(300),
  });
  assert.equal(old.stale, false);
  assert.equal(old.suppressProjection, false);
});

test("a stale series loses its direction outright, not just its ETA", () => {
  const support = repo.forecastSupport({
    name: "VO2max",
    n: 10,
    weeklySlope: 0.2,
    latestValue: 44,
    latestDate: localDaysAgo(40),
    staleAfterDays: repo.SENSOR_MAX_AGE_DAYS.fitness_marker,
    asOf: localDaysAgo(0),
  });
  const forecast = repo.supportedForecast(
    { direction: "improving", eta_text: "roughly 6 weeks out", eta_weeks: 6, crossing: 44 },
    support
  );
  assert.deepEqual(forecast, { direction: null, eta_text: null, eta_weeks: null, crossing: null });
});

// ---- the wearable marker path ------------------------------------------------

test("two synced days do not earn a confident wearable forecast", () => {
  garminDay(1, { vo2max: 44.0 });
  garminDay(0, { vo2max: 46.0 });
  const vo2 = wearableMarker("VO2max");
  assert.ok(vo2, "the wearable VO2max marker exists");
  assert.equal(vo2.trend.n, 2);
  assert.equal(vo2.forecast.direction, null, "n=2 cannot claim a direction toward optimal");
  assert.equal(vo2.forecast.eta_text, null);
  assert.equal(vo2.trend.projection, null, "and no 'X weeks to optimal' ETA reaches prioritizeMarkers");
});

test("a wearable series with enough dots DOES still forecast", () => {
  // The guard must not have simply switched the whole path off.
  for (const [daysAgo, v] of [
    [24, 40.0],
    [18, 40.6],
    [12, 41.1],
    [6, 41.7],
    [0, 42.2],
  ])
    garminDay(daysAgo, { vo2max: v });
  const vo2 = wearableMarker("VO2max");
  assert.ok(vo2.trend.n >= 4);
  assert.equal(vo2.stale, false);
  assert.ok(vo2.trend.dir, "a fresh, well-populated series still reads a direction");
});

test("a wearable series whose newest dot is past the bound reads as stale, with no direction", () => {
  const bound = repo.SENSOR_MAX_AGE_DAYS.fitness_marker;
  for (const [daysAgo, v] of [
    [bound + 24, 40.0],
    [bound + 18, 40.6],
    [bound + 12, 41.1],
    [bound + 6, 41.7],
    [bound + 1, 42.2],
  ])
    garminDay(daysAgo, { vo2max: v });
  const vo2 = wearableMarker("VO2max");
  assert.ok(vo2, "the series is still CARRIED — staleness is not deletion");
  assert.equal(vo2.stale, true);
  assert.equal(vo2.age_days, bound + 1, "and it says how old it actually is");
  assert.equal(vo2.trend.dir, null, "no direction for today");
  assert.equal(vo2.trend.projection, null);
  assert.equal(vo2.forecast.direction, null, "no forecast to boost its priority with");
  assert.equal(vo2.forecast.eta_text, null);
  assert.equal(vo2.latest.value, 42.2, "the last real reading is still reported, dated honestly");
  assert.equal(vo2.latest.date, localDaysAgo(bound + 1));
});

// ---- decision site: the recovery baseline bands ------------------------------

// Ten nights ending well past the HRV bound — enough points to clear
// RECOVERY_BASELINE_MIN_POINTS, so what is being tested is the age gate and not
// thin data.
function seedStaleHrvSeries() {
  for (let d = 27; d >= 18; d--) garminDay(d, { hrv_ms: 48 + (d % 6) });
}

test("an 18-day-old HRV reading gives the SAME band read as no HRV at all", () => {
  seedStaleHrvSeries();
  const withStale = repo.getRecoveryBaselineRead();
  resetTables("garmin_daily_metrics", "garmin_sources", "daily_metrics");
  const withNothing = repo.getRecoveryBaselineRead();
  assert.deepEqual(withStale, withNothing, "stale behaves as absent, not as a caution");
  assert.equal(withStale.dimensions.length, 0, "no dot to speak in the present tense with");
});

test("the same series with a current dot DOES render a band", () => {
  seedStaleHrvSeries();
  garminDay(0, { hrv_ms: 52 });
  const hrv = repo.getRecoveryBaselineRead().dimensions.find((dim) => dim.key === "hrv");
  assert.ok(hrv, "a current reading brings the dimension back");
  assert.ok(hrv.n >= 10, "and the whole 28-day baseline behind it was intact all along");
});

// ---- decision site: the unified signal state ---------------------------------

const sleepState = (latestDate, sleepMin) =>
  repo.planningSignalState({
    date: localDaysAgo(0),
    recovery: {
      recovery: { sleep_min: sleepMin },
      quality: { sleep_min: { latest_date: latestDate, source: "garmin", sample_count: 1 } },
    },
  });

test("a night past the sleep bound stops bearing on the posture", () => {
  const bound = repo.SENSOR_MAX_AGE_DAYS.sleep;
  const fresh = sleepState(localDaysAgo(bound), 250);
  const stale = sleepState(localDaysAgo(bound + 1), 250);
  const dim = (state) => state.dimensions.recovery_capacity;

  assert.equal(dim(fresh).status, "constrained", "a night still inside the bound owns the day");
  assert.ok(dim(fresh).coverage.active_fields.includes("sleep"));

  assert.equal(dim(stale).status, "unknown", "a day past it, the same short night decides nothing");
  assert.equal(dim(stale).coverage.active_fields.includes("sleep"), false);
  assert.ok(dim(stale).coverage.stale_fields.includes("sleep"), "it is carried as stale, not deleted");
});

test("a stale short night never becomes a caution — absence stays neutral", () => {
  const stale = sleepState(localDaysAgo(repo.SENSOR_MAX_AGE_DAYS.sleep + 5), 250);
  const nothing = repo.planningSignalState({ date: localDaysAgo(0) });
  assert.equal(stale.action.readiness, nothing.action.readiness);
  assert.equal(stale.action.posture, nothing.action.posture);
  assert.equal(stale.action.directives.training, nothing.action.directives.training);
});

test("the signal state's sleep bound is the one day-read has always used", () => {
  // These two used to disagree: day-read dropped a 3-day-old night while the signal
  // state kept voicing it as "the most recent recorded night". One constant now.
  const boundary = sleepState(localDaysAgo(3), 250);
  assert.equal(
    boundary.dimensions.recovery_capacity.coverage.active_fields.includes("sleep"),
    false,
    "a three-day-old night no longer speaks anywhere"
  );
});

// ---- decision site: the day read ---------------------------------------------

test("a night past the bound leaves the Brief with no last_night to speak from", () => {
  garminDay(repo.SENSOR_MAX_AGE_DAYS.sleep + 1, { sleep_min: 250, hrv_ms: 40 });
  const read = repo.dayRead(localDaysAgo(0));
  assert.equal(read.signals.last_night, null, "the read never claims how they slept from data it lacks");
});

test("acute training load past its bound reaches the read as absent", () => {
  // getRecoverySummary resolves acute_load as the newest non-null row in fourteen
  // days, so without a gate a watch that stopped syncing handed the read a
  // fortnight-old load as today's.
  garminDay(repo.SENSOR_MAX_AGE_DAYS.training_load + 1, { acute_load: 620 });
  const stale = repo.dayRead(localDaysAgo(0));
  assert.equal(stale.signals.fatigue.acute_load, null);

  resetTables("garmin_daily_metrics", "garmin_sources", "daily_metrics");
  repo.invalidateDayRead();
  garminDay(0, { acute_load: 620 });
  const fresh = repo.dayRead(localDaysAgo(0));
  assert.equal(fresh.signals.fatigue.acute_load, 620, "a current load still counts");
});
