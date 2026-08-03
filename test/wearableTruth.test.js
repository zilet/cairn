// Wearable truth (src/garmin.ts + src/repo/coach.ts + src/migrate.ts v84).
//
// The live failure this pins: the athlete stopped wearing the watch overnight, so
// Garmin's DAILY SUMMARY started reporting a "resting" heart rate derived from the
// quietest daytime minute — 94 and 118 against a real 52–60 baseline. Those two
// values dragged the mean-based 7d-vs-30d resting-HR delta to roughly +16, and the
// signal state turned that into a "resting heart rate is above the athlete's norm"
// caution every single morning.
//
// The product ruling behind every assertion here: wearable data is an OPTIONAL
// input. Its absence, and its garbage, must be neutral — never a caution.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { credibleSummaryRestingHr, foldDailySummary, foldSleep } from "../dist/garmin.js";
import { MIGRATIONS } from "../dist/migrate.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("garmin_daily_metrics", "garmin_sources", "daily_metrics", "sessions", "logged_sets", "checkins");
});

// ---- ingest: precedence + credibility ----------------------------------------

test("a sleep-derived resting HR always beats the daily summary's", () => {
  const m = { date: "2026-07-30" };
  foldSleep({ dailySleepDTO: { sleepTimeSeconds: 27000 }, restingHeartRate: 55 }, m);
  foldDailySummary({ restingHeartRate: 94, minHeartRate: 78 }, m);
  assert.equal(m.resting_hr, 55);
});

test("a summary resting HR is kept only when the day shows real rest coverage", () => {
  // Watch worn overnight but the sleep endpoint returned nothing: min HR proves a
  // rest window existed, so the summary figure is trustworthy.
  const worn = { date: "2026-07-30" };
  foldDailySummary({ restingHeartRate: 56, minHeartRate: 51 }, worn);
  assert.equal(worn.resting_hr, 56);

  // Daytime-only wear: min HR never dropped to a resting level, so the "resting"
  // HR is the quietest desk minute. Absence, not signal.
  const daytime = { date: "2026-07-30" };
  foldDailySummary({ restingHeartRate: 94, minHeartRate: 78 }, daytime);
  assert.equal(daytime.resting_hr, null);

  const alsoDaytime = { date: "2026-07-30" };
  foldDailySummary({ restingHeartRate: 118, minHeartRate: 70 }, alsoDaytime);
  assert.equal(alsoDaytime.resting_hr, null);

  // No HR trace at all cannot vouch for anything.
  const blind = { date: "2026-07-30" };
  foldDailySummary({ restingHeartRate: 58 }, blind);
  assert.equal(blind.resting_hr, null);
});

test("credibleSummaryRestingHr rejects physiologically implausible values", () => {
  assert.equal(credibleSummaryRestingHr(56, 50), 56);
  assert.equal(credibleSummaryRestingHr(28, 25), null); // below the plausible floor
  assert.equal(credibleSummaryRestingHr(95, 60), null); // above the plausible ceiling
  assert.equal(credibleSummaryRestingHr(null, 50), null);
});

// The guard's WITNESS is the half that was itself unguarded. min_hr is what proves a
// rest window existed, and a `-1` no-data sentinel or a 0 from a dropped trace clears
// the "at or below 65" bar arithmetically while proving the exact opposite — so it
// used to vouch for a junk summary RHR sitting right in the 66–90 band.
test("a junk min HR cannot vouch for a summary resting HR", () => {
  assert.equal(credibleSummaryRestingHr(88, -1), null, "a no-data sentinel is not a rest window");
  assert.equal(credibleSummaryRestingHr(88, 0), null, "a dropped HR trace is not a rest window");
  assert.equal(credibleSummaryRestingHr(88, 20), null, "below the plausible floor is not a rest window");
  assert.equal(credibleSummaryRestingHr(88, 44), 88, "a real low minute still vouches");

  const m = { date: "2026-07-30" };
  foldDailySummary({ restingHeartRate: 88, minHeartRate: -1, maxHeartRate: -1 }, m);
  assert.equal(m.resting_hr, null, "the sentinel must be rejected at ingest, not stored as a low reading");
  assert.equal(m.min_hr, null);
  assert.equal(m.max_hr, null);
});

test("Garmin's negative no-data sentinels are stored as absence, not as low readings", () => {
  const m = { date: "2026-07-30" };
  foldDailySummary(
    {
      averageStressLevel: -1,
      maxStressLevel: -1,
      bodyBatteryHighestValue: -1,
      bodyBatteryLowestValue: -2,
      averageSpo2Value: -1,
      lowestRespirationValue: -1,
      totalSteps: -1,
      activeKilocalories: -1,
      moderateIntensityMinutes: -1,
    },
    m
  );
  assert.equal(m.stress_avg, null);
  assert.equal(m.stress_max, null);
  assert.equal(m.body_battery_max, null);
  assert.equal(m.body_battery_min, null);
  assert.equal(m.spo2_avg, null);
  // respiration_* fold with `?? m.x`, so an unset field stays undefined.
  assert.equal(m.respiration_min ?? null, null);
  assert.equal(m.steps, null);
  assert.equal(m.active_calories, null);
  assert.equal(m.intensity_min_moderate, null);
  // The derived mid-point must not be invented out of two sentinels.
  assert.equal(m.body_battery_avg ?? null, null);
});

test("real zero values survive the sentinel guard", () => {
  const m = { date: "2026-07-30" };
  foldDailySummary({ averageStressLevel: 0, totalSteps: 0, vigorousIntensityMinutes: 0 }, m);
  assert.equal(m.stress_avg, 0);
  assert.equal(m.steps, 0);
  assert.equal(m.intensity_min_vigorous, 0);
});

// ---- deltas: one junk day must not move the window --------------------------

function seedRhrSeries({ junk = true } = {}) {
  // 30 days of a true 52–60 resting HR, with the two live junk days inside the
  // most recent week. Written straight to the table because these rows model what
  // ALREADY sits in the DB (pre-repair) — the ingest guard is tested above.
  const source = repo.upsertGarminSource({ label: "test" });
  for (let i = 0; i < 30; i++) {
    const date = localDaysAgo(i);
    let rhr = 52 + (i % 9);
    if (junk && i === 2) rhr = 94;
    if (junk && i === 4) rhr = 118;
    db.prepare(`INSERT INTO garmin_daily_metrics (source_id, date, resting_hr, sleep_min) VALUES (?, ?, ?, ?)`).run(
      source.id,
      date,
      rhr,
      i === 2 || i === 4 ? null : 420
    );
  }
}

test("two junk resting-HR days cannot manufacture an above-your-norm caution", () => {
  seedRhrSeries();
  const recovery = repo.getRecoverySummary(30);
  assert.ok(recovery.delta.rhr != null, "the delta should still be computed");
  assert.ok(
    Math.abs(recovery.delta.rhr) <= 3,
    `median-based delta should stay inside the caution threshold, got ${recovery.delta.rhr}`
  );

  const state = repo.planningSignalState({ date: localDaysAgo(0), recovery });
  const rhrEvidence = state.dimensions.recovery_capacity.evidence.filter((item) => item.field === "resting_hr");
  assert.ok(
    rhrEvidence.every((item) => item.direction !== "caution"),
    "no resting-HR caution should survive two junk days"
  );
});

test("absent wearable data is neutral: no resting-HR evidence and nothing pushed toward rest", () => {
  // Nothing seeded at all — the watch simply was not worn.
  const recovery = repo.getRecoverySummary(30);
  assert.equal(recovery.delta.rhr, null);

  const state = repo.planningSignalState({ date: localDaysAgo(0), recovery });
  const fields = state.dimensions.recovery_capacity.evidence.map((item) => item.field);
  assert.ok(!fields.includes("resting_hr"), `absence must not produce evidence, got ${fields.join(", ")}`);
  assert.notEqual(state.action.posture, "rest");
  assert.equal(state.action.directives.training, "proceed");
});

// ---- READING_TRUST: whose witness, and is the number even possible? ----------
//
// The rule: a reading is verified when its OWN source also provided evidence that
// its own sampling covered a rest window — a coherent same-source min HR, or a
// same-source night of at least two hours — and the value itself is possible.
// Absent that, uncorroborated. Only a same-source min HR may contradict.

const apple = (daysAgo, metrics) => repo.recordDailyMetrics("apple_health", localDaysAgo(daysAgo), metrics);
function garminDay(daysAgo, cols) {
  db.prepare("INSERT OR IGNORE INTO garmin_sources (id, provider, mode) VALUES (1, 'garmin', 'unofficial')").run();
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, ${keys.join(", ")})
     VALUES (1, ?, ${keys.map(() => "?").join(", ")})`
  ).run(localDaysAgo(daysAgo), ...keys.map((k) => cols[k]));
}
const verifiedDates = (summary) => summary.verified.resting_hr.readings.map((r) => r.date);

test("an Apple night verifies the Apple resting HR that sits beside it", () => {
  apple(0, { sleep_min: 430, resting_hr: 52 });
  const summary = repo.getRecoverySummary(30);
  assert.deepEqual(verifiedDates(summary), [localDaysAgo(0)]);
  assert.equal(summary.verified.resting_hr.latest_trust, "verified");
});

test("an Apple resting HR with no night is uncorroborated, and still counts toward the trend", () => {
  for (let i = 0; i < 6; i++) apple(i, { resting_hr: 52 + (i % 3) });
  const summary = repo.getRecoverySummary(30);
  assert.deepEqual(verifiedDates(summary), [], "nothing certified it, so nothing may open the excursion path");
  assert.equal(summary.verified.resting_hr.latest_trust, "uncorroborated");
  // Absence of corroboration is not contradiction: the readings keep counting.
  assert.equal(summary.quality.resting_hr.recent_n, 6);
  assert.ok(summary.recent.rhr != null, "the median still describes the readings it has");
});

test("a Garmin min HR cannot contradict an Apple resting HR from another feed", () => {
  // Watch on the charger overnight, phone on the wrist-free athlete: two devices
  // legitimately disagree about the day's floor. That is not self-contradiction.
  apple(0, { resting_hr: 52 });
  garminDay(0, { min_hr: 61 });
  const summary = repo.getRecoverySummary(30);
  assert.equal(summary.verified.resting_hr.latest_trust, "uncorroborated");
  assert.equal(summary.verified.resting_hr.latest_trustworthy_date, localDaysAgo(0));
  assert.deepEqual(verifiedDates(summary), []);
});

test("a twenty-minute Sleep-Focus window is not a night and certifies nothing", () => {
  apple(0, { sleep_min: 25, resting_hr: 84 });
  const summary = repo.getRecoverySummary(30);
  assert.equal(
    summary.verified.resting_hr.latest_trust,
    "uncorroborated",
    "a nap is thin evidence, not counter-evidence"
  );
  assert.deepEqual(verifiedDates(summary), []);
});

test("a resting HR outside human resting range can never be verified, whatever vouches for it", () => {
  apple(0, { sleep_min: 430, resting_hr: 105 });
  apple(1, { sleep_min: 430, resting_hr: 28 });
  const summary = repo.getRecoverySummary(30);
  assert.deepEqual(verifiedDates(summary), []);
  // It stays in the display/trend series — we keep storing what the phone said.
  assert.equal(summary.verified.resting_hr.latest_value, 105);
  assert.equal(summary.quality.resting_hr.sample_count, 2);
});

// An IMPLAUSIBLE reading beside a same-source floor is contradicted, not merely
// uncorroborated — the classification order matters. 105 with a min HR of 50 on the
// same row is the exact shape of Garmin's mid-day provisional estimate, and only
// `contradicted` is withheld from the trend windows. Checking the 30-90 band first
// would call it uncorroborated and let it into the median, which is the bug this pins.
test("an implausible resting HR contradicted by its own row's floor is dropped from the trend", () => {
  garminDay(2, { resting_hr: 52, min_hr: 50 });
  garminDay(1, { resting_hr: 53, min_hr: 51 });
  garminDay(0, { resting_hr: 105, min_hr: 50 });
  const summary = repo.getRecoverySummary(30);
  assert.equal(summary.verified.resting_hr.latest_trust, "contradicted", "its own floor argues with it");
  assert.equal(summary.quality.resting_hr.recent_n, 2, "the contradicted row is excluded from the trend windows");
  assert.equal(summary.recent.rhr, 52.5, "and so cannot move the median");
  assert.deepEqual(verifiedDates(summary), [localDaysAgo(1), localDaysAgo(2)]);
});

test("the same implausible value with only a sleep witness stays uncorroborated, not contradicted", () => {
  // Nothing from its own source can argue with it — no min HR — so the band may only
  // DEMOTE it out of `verified`. It keeps counting toward the trend, as every
  // uncorroborated reading does.
  apple(0, { sleep_min: 430, resting_hr: 105 });
  const summary = repo.getRecoverySummary(30);
  assert.equal(summary.verified.resting_hr.latest_trust, "uncorroborated");
  assert.deepEqual(verifiedDates(summary), [], "and the excursion path stays shut");
  assert.equal(summary.quality.resting_hr.recent_n, 1);
});

// Unchanged at a floor of 50 (where the old flat 5 bpm and the relative margin agree
// exactly) and deliberately WIDER above it: the margin is max(5, 0.10 * floor), so a
// higher-floor athlete is no longer told their own physiology argues with itself.
test("the live Garmin coherence behaviour is unchanged at floors up to 50, wider above", () => {
  garminDay(0, { resting_hr: 68, min_hr: 50 });
  let summary = repo.getRecoverySummary(30);
  assert.equal(summary.verified.resting_hr.latest_trust, "contradicted", "18 bpm above the day's floor is not resting");

  resetTables("garmin_daily_metrics", "garmin_sources", "daily_metrics");
  garminDay(0, { resting_hr: 54, min_hr: 50 });
  summary = repo.getRecoverySummary(30);
  assert.equal(summary.verified.resting_hr.latest_trust, "verified");
});

test("the coherence margin is relative, and identical to the old flat 5 at a floor of 50", () => {
  const trustAt = (restingHr, minHr) => {
    resetTables("garmin_daily_metrics", "garmin_sources", "daily_metrics");
    garminDay(0, { resting_hr: restingHr, min_hr: minHr });
    return repo.getRecoverySummary(30).verified.resting_hr.latest_trust;
  };
  assert.equal(trustAt(55, 50), "verified", "5 above a floor of 50 — the old calibration, bit for bit");
  assert.equal(trustAt(56, 50), "contradicted", "6 above a floor of 50 — still contradicted");
  // A higher-floor athlete is no longer told their own physiology argues with itself.
  assert.equal(trustAt(77, 70), "verified");
});

// ---- migration v84: repair what is already stored ---------------------------

const V84 = MIGRATIONS.find((m) => m.version === 84);

test("migration 84 nulls junk resting HR and negative sentinels, idempotently", () => {
  assert.ok(V84, "migration 84 must exist");
  const source = repo.upsertGarminSource({ label: "test" });
  const insert = db.prepare(
    `INSERT INTO garmin_daily_metrics (source_id, date, resting_hr, sleep_min, min_hr, max_hr, stress_avg, body_battery_min, steps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // 1: daytime-only wear, high min HR -> junk. 2: no sleep and no HR trace -> junk.
  // 3: overnight wear with a genuine rest window -> keep. 4: sleep recorded -> keep.
  // 5: a SENTINEL min HR vouching for a summary RHR in the 66–90 band -> junk, and
  //    the sentinel trace itself must not survive as an impossibly low heart rate.
  insert.run(source.id, "2026-07-22", 94, null, 78, 150, -1, -2, -1);
  insert.run(source.id, "2026-07-23", 118, null, null, null, 30, 12, 8000);
  insert.run(source.id, "2026-07-24", 56, null, 51, 148, 28, 10, 9000);
  insert.run(source.id, "2026-07-25", 55, 420, 49, 151, 26, 15, 7000);
  insert.run(source.id, "2026-07-26", 88, null, -1, -1, 22, 14, 6000);

  const rows = () =>
    db
      .prepare(
        `SELECT date, resting_hr, min_hr, max_hr, stress_avg, body_battery_min, steps
           FROM garmin_daily_metrics ORDER BY date`
      )
      .all();

  V84.up(db);
  const after = rows();
  assert.equal(after[0].resting_hr, null);
  assert.equal(after[0].stress_avg, null);
  assert.equal(after[0].body_battery_min, null);
  assert.equal(after[0].steps, null);
  assert.equal(after[1].resting_hr, null);
  assert.equal(after[2].resting_hr, 56, "a credible summary-derived value must be preserved");
  assert.equal(after[2].min_hr, 51, "a real HR trace must survive the sentinel sweep");
  assert.equal(after[3].resting_hr, 55, "a sleep-backed value must be preserved");
  assert.equal(after[4].resting_hr, null, "a sentinel min HR cannot vouch for a summary RHR");
  assert.equal(after[4].min_hr, null);
  assert.equal(after[4].max_hr, null);

  V84.up(db);
  assert.deepEqual(rows(), after, "the repair must be idempotent");
});
