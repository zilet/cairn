// Wearable COVERAGE (src/repo/sensor-cadence.ts + getRecoverySummary + latestSleep).
//
// The athlete wears the watch episodically: every run, the occasional baseline
// sleep night, nothing in between. The brain already had an age law (stale behaves
// as absent) and a value-credibility law (a daytime "resting" HR is not resting).
// It had almost no COVERAGE law — so two nights compared against four produced a
// confident "your HRV is below your norm" every morning.
//
// The ruling asserted here:
//
//   A THIN SAMPLE MAY DESCRIBE ITSELF, NEVER A TREND.
//
// And its product half, which matters more: thin data lands where absence already
// lands — NEUTRAL. It never becomes a caution, it never trims a run week, and it
// never moves a morning toward rest.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, localDaysAgo, seedTrainingDay } from "./_seed.js";
import { renderConnectedBrain } from "../dist/prompt/shared.js";
import { SENSOR_MAX_AGE_DAYS } from "../dist/repo/sensor-freshness.js";

const TODAY = () => localDaysAgo(0);

beforeEach(() => {
  resetTables("garmin_daily_metrics", "garmin_sources", "daily_metrics", "sessions", "logged_sets", "activities");
});

// One source-agnostic daily row (Apple/Oura/Whoop path), n days back.
function day(daysAgo, metrics) {
  return repo.recordDailyMetrics("apple", localDaysAgo(daysAgo), metrics);
}

function garminSource() {
  db.prepare("INSERT OR IGNORE INTO garmin_sources (id, provider, mode) VALUES (1, 'garmin', 'unofficial')").run();
  return 1;
}
function garminDay(daysAgo, cols) {
  garminSource();
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, ${keys.join(", ")})
     VALUES (1, ?, ${keys.map(() => "?").join(", ")})`
  ).run(localDaysAgo(daysAgo), ...keys.map((k) => cols[k]));
}

// ---- the choke point: recent-vs-baseline deltas ------------------------------

test("a two-night recent window cannot produce a delta; the third night unlocks it", () => {
  // A full baseline (12 nights across the month) and a genuinely thin recent week.
  for (let i = 8; i <= 19; i++) day(i, { hrv_ms: 60 });
  day(0, { hrv_ms: 44 });
  day(1, { hrv_ms: 45 });

  const thin = repo.getRecoverySummary(14);
  assert.equal(thin.quality.hrv_ms.recent_n, 2);
  assert.ok(thin.quality.hrv_ms.baseline_n >= 5, "the baseline half is well covered");
  assert.equal(thin.quality.hrv_ms.delta_ready, false);
  assert.equal(thin.delta.hrv, null, "two readings are not a week");
  // The readings themselves are real and keep reporting — only the COMPARISON is withheld.
  assert.equal(thin.recent.hrv, 44.5);
  assert.ok(thin.baseline.hrv != null);

  day(2, { hrv_ms: 46 });
  const ready = repo.getRecoverySummary(14);
  assert.equal(ready.quality.hrv_ms.recent_n, 3);
  assert.equal(ready.quality.hrv_ms.delta_ready, true);
  assert.ok(ready.delta.hrv != null && ready.delta.hrv < 0, "three nights is enough to name a dip");
});

test("a four-night month cannot be a baseline; the fifth unlocks it", () => {
  day(0, { resting_hr: 60 });
  day(1, { resting_hr: 61 });
  day(2, { resting_hr: 60 });
  day(9, { resting_hr: 50 });

  const thin = repo.getRecoverySummary(14);
  assert.equal(thin.quality.resting_hr.recent_n, 3, "the recent half clears its floor");
  assert.equal(thin.quality.resting_hr.baseline_n, 4);
  assert.equal(thin.delta.rhr, null, "but four readings are not a month");

  day(12, { resting_hr: 50 });
  const ready = repo.getRecoverySummary(14);
  assert.equal(ready.quality.resting_hr.baseline_n, 5);
  assert.ok(ready.delta.rhr != null, "the fifth reading makes the norm real");
});

test("the floors are PER FIELD — a covered metric still speaks while a thin one stays quiet", () => {
  // Sleep every night for a month; HRV only twice, both this week.
  for (let i = 0; i <= 29; i++) day(i, { sleep_min: i < 7 ? 330 : 430 });
  day(0, { hrv_ms: 40 });
  day(1, { hrv_ms: 41 });

  const summary = repo.getRecoverySummary(14);
  assert.ok(summary.delta.sleep != null, "sleep has the coverage to be compared");
  assert.equal(summary.delta.hrv, null, "HRV does not");
  assert.equal(summary.delta.rhr, null, "and resting HR has no readings at all");
});

test("no wearable data at all leaves every delta null and nothing pushed toward rest", () => {
  const summary = repo.getRecoverySummary(14);
  assert.deepEqual(summary.delta, { sleep: null, hrv: null, rhr: null });
  const state = repo.planningSignalState({ date: TODAY(), recovery: summary });
  assert.notEqual(state.action.posture, "rest");
  assert.equal(state.action.directives.training, "proceed");
});

test("a thin-data morning still reads as a day to train, and carries no recovery caution", () => {
  // Exactly the episodic shape: two post-run mornings, both looking "bad" in
  // isolation, and nothing else. This must not become a caution.
  day(0, { hrv_ms: 38, resting_hr: 64 });
  day(1, { hrv_ms: 39, resting_hr: 65 });
  for (let i = 20; i <= 26; i++) day(i, { hrv_ms: 62, resting_hr: 51 });

  const summary = repo.getRecoverySummary(14);
  assert.equal(summary.delta.hrv, null);
  assert.equal(summary.delta.rhr, null);

  const state = repo.planningSignalState({ date: TODAY(), recovery: summary });
  const fields = state.dimensions.recovery_capacity.evidence.map((item) => item.field);
  assert.ok(!fields.includes("hrv"), `a thin HRV series must produce no evidence, got ${fields.join(", ")}`);
  assert.ok(!fields.includes("resting_hr"), `nor a thin resting-HR one, got ${fields.join(", ")}`);
  assert.notEqual(state.action.posture, "rest");
  assert.equal(state.action.directives.training, "proceed");
});

// ---- the run plan: thin evidence never trims mileage -------------------------

// A runner with a real base and a race far enough out that no taper is in play —
// the ordinary build week, which is the one a recovery read can ease.
function seedRunner() {
  const raceDate = new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10);
  repo.setProfile({
    age: 44,
    primary_discipline: "strength",
    endurance_sport: "running",
    training_intent: {
      priorities: ["longevity", "muscle", "leanness", "endurance"],
      endurance_role: "supporting",
      endurance_capacity: { sport: "running", target_duration_min: 120 },
    },
    endurance_goal: {
      mode: "race",
      event: "Test Half Marathon",
      date: raceDate,
      distance_km: 21.1,
      weekly_km: 35,
      weekly_sessions: 5,
      target: "Sub 1:45",
    },
  });
  for (let week = 0; week < 6; week++) {
    for (const offset of [1, 3, 5]) {
      repo.addActivity({ type: "run", date: localDaysAgo(week * 7 + offset), duration_min: 55, distance_km: 9 });
    }
  }
}

test("a thin recovery series does not ease the run week, while a covered one does", () => {
  seedRunner();
  // Covered: a full month of resting HR, this week clearly raised against it.
  for (let i = 0; i <= 6; i++) day(i, { resting_hr: 60 });
  for (let i = 7; i <= 29; i++) day(i, { resting_hr: 52 });
  const covered = repo.getRecoverySummary(14);
  assert.ok(covered.delta.rhr != null && covered.delta.rhr > 2, "the control really does read recovery-down");
  const easedPlan = repo.weeklyRunPlan(TODAY(), { recovery: covered });
  assert.ok(
    easedPlan.rationale.some((line) => /Recovery's down/i.test(line)),
    `the covered case must still ease: ${JSON.stringify(easedPlan.rationale)}`
  );

  // Same story, episodic sampling: two raised mornings against seven older ones.
  resetTables("daily_metrics");
  day(0, { resting_hr: 60 });
  day(1, { resting_hr: 61 });
  for (let i = 10; i <= 16; i++) day(i, { resting_hr: 52 });
  const thin = repo.getRecoverySummary(14);
  assert.equal(thin.delta.rhr, null);
  const thinPlan = repo.weeklyRunPlan(TODAY(), { recovery: thin });
  assert.ok(
    !thinPlan.rationale.some((line) => /Recovery's down/i.test(line)),
    `thin evidence must not trim volume: ${JSON.stringify(thinPlan.rationale)}`
  );
});

// ---- cadence: how the athlete actually wears the thing -----------------------

test("quality carries a per-field wear cadence over the last 90 days", () => {
  // A run every ten days, watch on for each one, nothing in between.
  for (let i = 0; i < 8; i++) day(i * 10, { hrv_ms: 55, resting_hr: 52 });
  const summary = repo.getRecoverySummary(14);
  const cadence = summary.quality.hrv_ms.cadence;
  assert.equal(cadence.pattern, "spot_check");
  assert.equal(cadence.readings, 8);
  assert.equal(cadence.window_days, 90);
  assert.equal(cadence.median_gap_days, 10);
  assert.equal(cadence.last_reading_date, TODAY());
  // Sleep was never measured — absence classifies as none, not as a thin habit.
  assert.equal(summary.quality.sleep_min.cadence.pattern, "none");
});

test("a daily wearer classifies as continuous", () => {
  for (let i = 0; i < 60; i++) day(i, { hrv_ms: 58 });
  assert.equal(repo.getRecoverySummary(14).quality.hrv_ms.cadence.pattern, "continuous");
});

test("readings that cluster on training days are annotated, and the annotation changes nothing", () => {
  // Three readings this week, all on days with logged work.
  for (const back of [0, 2, 4]) {
    seedTrainingDay(localDaysAgo(back));
    day(back, { hrv_ms: 44, resting_hr: 60 });
  }
  for (let i = 15; i <= 22; i++) day(i, { hrv_ms: 60, resting_hr: 51 });

  const summary = repo.getRecoverySummary(14);
  assert.equal(summary.quality.hrv_ms.training_day_biased, true);
  assert.equal(summary.quality.resting_hr.training_day_biased, true);
  // Sleep is never annotated: a night is measured while asleep, not while training.
  assert.equal(summary.quality.sleep_min.training_day_biased, undefined);
  // The annotation is exactly that — the deltas themselves are unchanged by it.
  assert.ok(summary.delta.hrv != null, "coverage cleared, so the comparison still happens");
  const state = repo.planningSignalState({ date: TODAY(), recovery: summary });
  assert.notEqual(state.action.posture, "rest");
});

test("a continuous wearer is never flagged as training-day biased", () => {
  for (let i = 0; i < 60; i++) day(i, { hrv_ms: 58, resting_hr: 52 });
  for (const back of [0, 1, 2, 3, 4, 5, 6]) seedTrainingDay(localDaysAgo(back));
  const summary = repo.getRecoverySummary(14);
  assert.equal(summary.quality.hrv_ms.training_day_biased, false);
});

// ---- latestSleep: the age law moved inside ----------------------------------

test("latestSleep returns null past its required max age, and the night itself inside it", () => {
  day(5, { sleep_min: 430, hrv_ms: 60 });
  assert.equal(repo.latestSleep(SENSOR_MAX_AGE_DAYS.sleep), null, "a five-day-old night is not last night");
  const generous = repo.latestSleep(14);
  assert.ok(generous, "a caller that deliberately widens the bound still sees it");
  assert.equal(generous.date, localDaysAgo(5));
});

test("latestSleep reads relative to the day being read, not only to today", () => {
  day(5, { sleep_min: 430, hrv_ms: 60 });
  const asOf = repo.latestSleep(SENSOR_MAX_AGE_DAYS.sleep, localDaysAgo(4));
  assert.ok(asOf, "one day after that night, it IS last night");
  assert.equal(asOf.date, localDaysAgo(5));
  // And a night dated after the day being read is invisible rather than negative-aged.
  day(0, { sleep_min: 400 });
  assert.equal(repo.latestSleep(SENSOR_MAX_AGE_DAYS.sleep, localDaysAgo(4)).date, localDaysAgo(5));
});

test("latestSleep withholds the norm comparison until the norm has five nights behind it", () => {
  // Four prior nights of HRV: a number, but not a norm.
  for (let i = 2; i <= 5; i++) garminDay(i, { sleep_min: 440, hrv_ms: 65 });
  garminDay(1, { sleep_min: 400, hrv_ms: 45 });
  const thin = repo.latestSleep(SENSOR_MAX_AGE_DAYS.sleep);
  assert.ok(thin);
  assert.equal(thin.hrv_vs_baseline, null);
  assert.match(thin.text, /HRV 45ms/, "the reading itself still reports");
  assert.ok(!/norm/.test(thin.text), `no norm claim off four nights: ${thin.text}`);
  assert.ok(!/steady/.test(thin.text), `and no "steady" either — that is the same claim, calmer`);

  // A fifth prior night makes it a norm.
  garminDay(6, { sleep_min: 440, hrv_ms: 65 });
  const ready = repo.latestSleep(SENSOR_MAX_AGE_DAYS.sleep);
  assert.ok(ready.hrv_vs_baseline != null);
  assert.match(ready.text, /below your norm/);
});

// ---- the prompt speaks with its sample counts --------------------------------

function recoveryBlock(summary) {
  return renderConnectedBrain({ recovery: summary, now: { date: TODAY() } });
}

test("the DATA block prints sample counts beside its averages", () => {
  for (let i = 0; i < 4; i++) day(i, { sleep_min: 420, hrv_ms: 58, resting_hr: 52 });
  const text = recoveryBlock(repo.getRecoverySummary(14));
  assert.match(text, /avg sleep ~420 min \[4 readings\/14d\]/);
  assert.match(text, /resting HR ~52 \[4 readings\/14d\]/);
  assert.match(text, /HRV ~58 ms \[4 readings\/14d\]/);
});

test("the vs-norm block renders only the fields whose delta survived the floor", () => {
  // Sleep covered; HRV episodic.
  for (let i = 0; i <= 29; i++) day(i, { sleep_min: i < 7 ? 330 : 430 });
  day(0, { hrv_ms: 40 });
  day(1, { hrv_ms: 41 });
  const text = recoveryBlock(repo.getRecoverySummary(14));
  assert.match(text, /RECOVERY vs THEIR NORM/);
  assert.match(text, /sleep \d+ min vs ~\d+ norm \([-+]?\d+, \d+ vs \d+ readings\)/);
  assert.ok(!/HRV \d[\d.]* vs ~/.test(text), `a thin HRV series must not be compared: ${text}`);
});

test("the vs-norm block disappears entirely when nothing has the coverage for it", () => {
  day(0, { hrv_ms: 40, resting_hr: 60, sleep_min: 400 });
  day(1, { hrv_ms: 41, resting_hr: 61, sleep_min: 405 });
  const text = recoveryBlock(repo.getRecoverySummary(14));
  assert.ok(!/RECOVERY vs THEIR NORM/.test(text), `nothing to compare, so nothing is said: ${text}`);
});

test("the DATA block names an episodic wearer's cadence in plain machine register", () => {
  for (let i = 0; i < 8; i++) day(i * 10, { hrv_ms: 55, resting_hr: 52 });
  const text = recoveryBlock(repo.getRecoverySummary(14));
  assert.match(text, /WEARABLE CADENCE/);
  assert.match(text, /HRV on 8 of the last 90 days, typically every 10 days/);
  assert.match(text, /resting HR on 8 of the last 90 days/);
  assert.ok(!/sleep on \d+ of the last 90 days/.test(text), "a metric never measured is absent, not episodic");
});

test("a continuous wearer gets no cadence caveat at all", () => {
  for (let i = 0; i < 60; i++) day(i, { hrv_ms: 58, resting_hr: 52, sleep_min: 430 });
  const text = recoveryBlock(repo.getRecoverySummary(14));
  assert.ok(!/WEARABLE CADENCE/.test(text), `a daily record needs no caveat: ${text}`);
});

test("the DATA block flags training-day clustering, and tells the agent not to rest on it", () => {
  for (const back of [0, 2, 4]) {
    seedTrainingDay(localDaysAgo(back));
    day(back, { hrv_ms: 44, resting_hr: 60 });
  }
  for (let i = 15; i <= 22; i++) day(i, { hrv_ms: 60, resting_hr: 51 });
  const text = recoveryBlock(repo.getRecoverySummary(14));
  assert.match(text, /SAMPLING NOTE: recent HRV and resting HR readings cluster on days with logged training/);
  assert.match(text, /do NOT let this alone move the day toward rest/);
});
