// A physiology brake needs a MEANINGFUL miss, and the morning's readiness is the
// morning's (owner ruling 2026-09-29, "ground in best practices in coaching").
//
//   • a night a hair past the athlete's own line is a caveat — never harm, never a
//     brake; past it by the smallest worthwhile change (half the band's own width) it
//     brakes alone, and two consecutive readings past the line brake as one;
//   • the harm arms and the run morning's floor judge the night the same way;
//   • when Cairn has no morning read of its own from before the first training, the
//     watch's wake-up readiness (the raw payload's AFTER_WAKEUP_RESET entry stamped
//     before the work) is the morning's readiness — never the post-workout sync.
//
// Synthetic fixtures mirroring the live shapes; no real data.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables, localDaysAgo } from "./_seed.js";
import {
  harmEvidenceOnDay,
  harmVerdictOnDay,
  watchWakeReadiness,
  withMorningReadiness,
} from "../dist/repo/brain/read-adherence.js";
import { nightPastBand, overnightBrakes, personalBand } from "../dist/repo/overnight-band.js";
import { SWC_SD_FRACTION } from "../dist/repo/recovery-science.js";
import { SUPPORTIVE_READINESS } from "../dist/repo/readiness-bands.js";
import { bumpTrainingDataVersion } from "../dist/repo/training-cache.js";

beforeEach(() => {
  resetTables(
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "daily_metrics",
    "sessions",
    "logged_sets",
    "brain_decisions",
    "brain_expectations",
    "context_events",
    "profile",
    "app_state"
  );
});

const OWN = [38, 41, 43, 45, 48]; // the athlete's ordinary nights, ms
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// `n` nights before `morning`, cycling through `values`, skipping any date in `skip`.
function ownNights(morning, n, values = OWN, skip = []) {
  for (let back = 1; back <= n; back++) {
    const date = addDays(morning, -back);
    if (skip.includes(date)) continue;
    repo.upsertGarminDailyMetric({ date, hrv_ms: values[back % values.length] });
  }
}

function liftedOn(date) {
  repo.upsertExercise({ name: "Test Row", muscle_group: "back" });
  repo.logSetByName({ date, exercise: "Test Row", weight: 100, reps: 8 });
}

// The band the harm arm will read for `morning`: every seeded night before it.
function bandFor(morning) {
  const values = db
    .prepare(`SELECT hrv_ms FROM garmin_daily_metrics WHERE date < ? AND date >= ? AND hrv_ms IS NOT NULL`)
    .all(morning, addDays(morning, -30))
    .map((r) => Number(r.hrv_ms));
  return personalBand(values, "hrv_ms");
}

// ── the pure rule ───────────────────────────────────────────────────────────────

test("the band carries a meaningful line one smallest worthwhile change past its own line", () => {
  const band = personalBand([...OWN, ...OWN, ...OWN], "hrv_ms");
  assert.ok(band.width > 0);
  assert.equal(
    Math.round((band.line - band.meaningful_line) * 1000) / 1000,
    Math.round(band.width * SWC_SD_FRACTION * 1000) / 1000
  );
  assert.equal(nightPastBand(band.line + 0.1, band, "hrv_ms"), null);
  assert.equal(nightPastBand(band.line - 0.2, band, "hrv_ms"), "marginal");
  assert.equal(nightPastBand(band.line - band.width, band, "hrv_ms"), "meaningful");
  // Resting HR mirrors it upward.
  const rhr = personalBand([50, 51, 52, 53, 54, 50, 51, 52, 53, 54, 52], "resting_hr");
  assert.equal(nightPastBand(rhr.line + 0.2, rhr, "resting_hr"), "marginal");
  assert.equal(nightPastBand(rhr.meaningful_line + 0.1, rhr, "resting_hr"), "meaningful");
  // One marginal night never brakes; corroborated, it does; a meaningful one does alone.
  assert.equal(overnightBrakes("marginal", null), false);
  assert.equal(overnightBrakes("marginal", "marginal"), true);
  assert.equal(overnightBrakes("meaningful", null), true);
  assert.equal(overnightBrakes(null, "meaningful"), false, "the night before can never brake a morning alone");
});

// ── the harm arm ────────────────────────────────────────────────────────────────

test("a night 0.2 ms under the athlete's own line is a caveat, not harm", () => {
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  liftedOn(day);
  ownNights(morning, 20);
  const band = bandFor(morning);
  // The night before it sat at their mean: nothing to corroborate.
  repo.upsertGarminDailyMetric({ date: day, hrv_ms: Math.round(band.mean) });
  const fresh = bandFor(morning);
  repo.upsertGarminDailyMetric({ date: morning, hrv_ms: Math.round((fresh.line - 0.2) * 10) / 10 });
  assert.equal(nightPastBand(fresh.line - 0.2, fresh, "hrv_ms"), "marginal");
  assert.equal(harmEvidenceOnDay(day), null);
});

test("a night a full band-width under their line brakes on its own", () => {
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  liftedOn(day);
  ownNights(morning, 20);
  repo.upsertGarminDailyMetric({ date: day, hrv_ms: 45 });
  const band = bandFor(morning);
  repo.upsertGarminDailyMetric({ date: morning, hrv_ms: Math.round((band.line - band.width) * 10) / 10 });
  const harm = harmEvidenceOnDay(day);
  assert.equal(harm?.kind, "physiology_brake");
  assert.match(harm.detail, /below own band/);
});

test("two consecutive marginal nights brake, charged once to the day before the second", () => {
  const d1 = localDaysAgo(4);
  const d2 = localDaysAgo(3);
  const m1 = d2; // the morning after d1
  const m2 = localDaysAgo(2); // the morning after d2
  liftedOn(d1);
  liftedOn(d2);
  ownNights(localDaysAgo(4), 20);
  repo.upsertGarminDailyMetric({ date: d1, hrv_ms: 45 });
  const band = bandFor(m1);
  const marginal = Math.round((band.line - 0.2) * 10) / 10;
  repo.upsertGarminDailyMetric({ date: m1, hrv_ms: marginal });
  assert.equal(nightPastBand(marginal, band, "hrv_ms"), "marginal");
  // Each night is judged against the band as it stood on its own morning — the second
  // band already holds the first dip night.
  const band2 = bandFor(m2);
  const marginal2 = Math.round((band2.line - 0.2) * 10) / 10;
  assert.equal(nightPastBand(marginal2, band2, "hrv_ms"), "marginal");
  repo.upsertGarminDailyMetric({ date: m2, hrv_ms: marginal2 });

  assert.equal(harmEvidenceOnDay(d1), null, "one marginal night alone is a caveat");
  const harm = harmEvidenceOnDay(d2);
  assert.equal(harm?.kind, "physiology_brake", "the second consecutive reading past the line brakes");
  assert.equal(harm.date, d2);
});

// ── the watch's wake-up readiness ───────────────────────────────────────────────

// Garmin's raw readiness list, newest first, GMT stamps — the live shape.
function readinessPayload(date, entries) {
  return entries.map(([hhmm, context, score]) => ({
    calendarDate: date,
    timestamp: `${date}T${hhmm}:00.0`,
    timestampLocal: `${date}T${hhmm}:00.0`,
    inputContext: context,
    score,
  }));
}

function garminRunOn(date, startGmt, km = 8) {
  repo.addActivity({
    type: "run",
    distance_km: km,
    duration_min: km * 6,
    date,
    source: "garmin",
    external_id: `r-${date}`,
  });
  const act = db.prepare(`SELECT id FROM activities WHERE date = ? ORDER BY id DESC LIMIT 1`).get(date);
  const src = db
    .prepare(`INSERT INTO garmin_sources (provider, mode, label) VALUES ('garmin','unofficial',?)`)
    .run(`src-${date}`);
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, activity_id, date, type, raw_json)
     VALUES (?, ?, ?, ?, 'running', ?)`
  ).run(
    src.lastInsertRowid,
    `r-${date}`,
    act.id,
    date,
    JSON.stringify({ startTimeGMT: `${date} ${startGmt}:00`, beginTimestamp: Date.parse(`${date}T${startGmt}:00Z`) })
  );
}

test("the wake-up reading before the first training is the morning; the post-workout sync is not", () => {
  const morning = localDaysAgo(2);
  // A run at 10:30 GMT; the watch woke at 10:17, reset after the run, recomputed later.
  garminRunOn(morning, "10:30");
  repo.upsertGarminDailyMetric({
    date: morning,
    training_readiness: 32, // the stored LAST sync — post-workout
    raw: {
      trainingReadiness: readinessPayload(morning, [
        ["20:20", "UPDATE_REALTIME_VARIABLES", 30],
        ["11:30", "AFTER_POST_EXERCISE_RESET", 32],
        ["10:17", "AFTER_WAKEUP_RESET", 64],
        ["06:26", "UPDATE_REALTIME_VARIABLES", 62],
      ]),
    },
  });
  assert.equal(watchWakeReadiness(morning), 64);
});

test("a wake-up reset stamped after the first training is not the morning", () => {
  const morning = localDaysAgo(2);
  garminRunOn(morning, "09:00");
  repo.upsertGarminDailyMetric({
    date: morning,
    training_readiness: 40,
    raw: {
      trainingReadiness: readinessPayload(morning, [
        ["11:42", "AFTER_WAKEUP_RESET", 70], // a second wake, after the run
        ["08:45", "AFTER_WAKEUP_RESET", 27],
      ]),
    },
  });
  assert.equal(watchWakeReadiness(morning), 27, "the latest wake-up reset strictly before the work");
});

test("a run whose start cannot be placed makes the wake-up ordering unknowable", () => {
  const morning = localDaysAgo(2);
  repo.addActivity({ type: "run", distance_km: 5, duration_min: 30, date: morning }); // hand-logged: a date, no time
  repo.upsertGarminDailyMetric({
    date: morning,
    raw: { trainingReadiness: readinessPayload(morning, [["10:17", "AFTER_WAKEUP_RESET", 64]]) },
  });
  assert.equal(watchWakeReadiness(morning), null);
});

test("a hard run the next morning's wake-up reading vouches for is not harm", () => {
  // The hard day, then a morning with no Cairn read and training on it: the wake-up
  // reading is the only honest morning value.
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  garminRunOn(day, "10:30");
  db.prepare(`UPDATE garmin_activities SET aerobic_te = 4.2, te_label = 'threshold' WHERE date = ?`).run(day);
  liftedOn(morning); // training on the judging morning: the stored value is post-workout
  repo.upsertGarminDailyMetric({
    date: morning,
    training_readiness: 25,
    raw: {
      trainingReadiness: readinessPayload(morning, [
        ["23:50", "AFTER_POST_EXERCISE_RESET", 25],
        ["10:17", "AFTER_WAKEUP_RESET", SUPPORTIVE_READINESS + 4],
      ]),
    },
  });
  // The lifted set is stamped now (UTC) — well after a 10:17 wake on a past date.
  assert.equal(watchWakeReadiness(morning), SUPPORTIVE_READINESS + 4);
  assert.equal(harmEvidenceOnDay(day), null, "the body's own morning answered the hard day");
  // Without the payload the morning is unknowable, and the hard day stays harm.
  db.prepare(`UPDATE garmin_daily_metrics SET raw_json = NULL WHERE date = ?`).run(morning);
  bumpTrainingDataVersion(); // the memo keys on the training-data version production writes bump
  assert.equal(harmEvidenceOnDay(day)?.kind, "hard_cardio");
});

test("the recompute after training reads the wake-up reading, not the afternoon's", () => {
  const today = localDaysAgo(0);
  liftedOn(today);
  repo.upsertGarminDailyMetric({
    date: today,
    training_readiness: 32,
    raw: {
      // Woken an hour before the set was logged (stamped now, UTC).
      trainingReadiness: [
        {
          calendarDate: today,
          timestamp: new Date(Date.now() - 3600e3).toISOString().replace("Z", ""),
          inputContext: "AFTER_WAKEUP_RESET",
          score: 77,
        },
      ],
    },
  });
  const summary = {
    recovery: { training_readiness: 32, readiness_band: "low" },
    quality: { training_readiness: { latest_date: today, latest_value: 32, freshness: "fresh" } },
  };
  const patched = withMorningReadiness(summary, today);
  assert.equal(patched.recovery.training_readiness, 77);
  assert.notEqual(patched.recovery.readiness_band, "low");
});

// ── a wake-up reading that only restates the workout's load ─────────────────────
// Garmin's recovery time is computed from the previous workout's own load; on a night
// with no valid sleep a low score driven by it is that load restated, not the body's
// answer — so it is never harm evidence against that workout (owner ruling 2026-09-29).

function wakeEntry(date, score, factors) {
  return {
    calendarDate: date,
    timestamp: `${date}T10:22:00.0`,
    inputContext: "AFTER_WAKEUP_RESET",
    score,
    ...factors,
  };
}

// The live shape: factors the watch could not read report 0 with feedback NONE.
const NO_SLEEP_RECOVERY_DRIVEN = {
  validSleep: false,
  sleepScoreFactorPercent: 0,
  sleepScoreFactorFeedback: "NONE",
  stressHistoryFactorPercent: 0,
  stressHistoryFactorFeedback: "NONE",
  acwrFactorFeedback: "GOOD",
  hrvFactorFeedback: "MODERATE",
  recoveryTimeFactorPercent: 28,
  recoveryTimeFactorFeedback: "POOR",
  acwrFactorPercent: 82,
  hrvFactorPercent: 49,
};

test("a no-sleep wake-up score driven by recovery time is not harm: the long run counts as taken well", async () => {
  const { demonstratedLongKm, runningHarmOnDay } = await import("../dist/repo/run-capacity.js");
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  garminRunOn(day, "11:00", 17.7);
  repo.upsertGarminDailyMetric({
    date: morning,
    training_readiness: 17,
    raw: { trainingReadiness: [wakeEntry(morning, 17, NO_SLEEP_RECOVERY_DRIVEN)] },
  });
  assert.equal(watchWakeReadiness(morning), 17, "the plain score still reads for the day's own plan");
  assert.equal(harmEvidenceOnDay(day), null);
  assert.equal(runningHarmOnDay(day), null);
  assert.equal(demonstratedLongKm(localDaysAgo(1), [{ date: day, km: 17.7 }]), 17.7);
});

test("a no-sleep wake-up score driven by HRV status still counts as harm", () => {
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  garminRunOn(day, "11:00", 17.7);
  repo.upsertGarminDailyMetric({
    date: morning,
    training_readiness: 17,
    raw: {
      trainingReadiness: [
        wakeEntry(morning, 17, {
          ...NO_SLEEP_RECOVERY_DRIVEN,
          recoveryTimeFactorPercent: 70,
          recoveryTimeFactorFeedback: "GOOD",
          hrvFactorPercent: 12,
          hrvFactorFeedback: "POOR",
        }),
      ],
    },
  });
  assert.equal(harmEvidenceOnDay(day)?.kind, "readiness_rest_grade");
});

test("a wake-up score of 17 with a valid sleep still counts as harm, recovery time or not", () => {
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  garminRunOn(day, "11:00", 17.7);
  repo.upsertGarminDailyMetric({
    date: morning,
    training_readiness: 17,
    raw: {
      trainingReadiness: [
        wakeEntry(morning, 17, {
          ...NO_SLEEP_RECOVERY_DRIVEN,
          validSleep: true,
          sleepScoreFactorPercent: 60,
          sleepScoreFactorFeedback: "MODERATE",
        }),
      ],
    },
  });
  assert.equal(harmEvidenceOnDay(day)?.kind, "readiness_rest_grade");
});

test("a no-sleep wake-up score of 77 still vouches for a hard day; a restated 17 neither harms nor vouches", () => {
  const day = localDaysAgo(3);
  const morning = localDaysAgo(2);
  garminRunOn(day, "11:00", 8);
  db.prepare(`UPDATE garmin_activities SET aerobic_te = 4.2, te_label = 'threshold' WHERE date = ?`).run(day);
  repo.upsertGarminDailyMetric({
    date: morning,
    raw: { trainingReadiness: [wakeEntry(morning, 77, NO_SLEEP_RECOVERY_DRIVEN)] },
  });
  assert.equal(harmEvidenceOnDay(day), null, "a good score despite the recovery-time penalty vouches");
  db.prepare(`UPDATE garmin_daily_metrics SET raw_json = ? WHERE date = ?`).run(
    JSON.stringify({ trainingReadiness: [wakeEntry(morning, 17, NO_SLEEP_RECOVERY_DRIVEN)] }),
    morning
  );
  bumpTrainingDataVersion();
  const harm = harmEvidenceOnDay(day);
  assert.equal(harm?.kind, "hard_cardio", "absent never vouches, so the hard day stands on its own");
});

// ── the verdict: 24 AND 48 hours, and an unmeasured morning is unknown (2026-10-16) ──

test("a meaningful miss on the SECOND morning is harm when the morning between went unmeasured", () => {
  const day = localDaysAgo(5);
  const second = localDaysAgo(3);
  liftedOn(day);
  ownNights(day, 20);
  const band = bandFor(second);
  repo.upsertGarminDailyMetric({ date: second, hrv_ms: Math.round((band.line - band.width) * 10) / 10 });
  assert.equal(harmEvidenceOnDay(day), null, "the next-morning arm alone cannot see it");
  const verdict = harmVerdictOnDay(day);
  assert.equal(verdict.status, "harm");
  assert.equal(verdict.window, "48h");
});

test("a hair-past second morning is a caveat there too — never harm, and it still speaks clean", () => {
  const day = localDaysAgo(5);
  const second = localDaysAgo(3);
  liftedOn(day);
  ownNights(day, 20);
  const band = bandFor(second);
  repo.upsertGarminDailyMetric({ date: second, hrv_ms: Math.round((band.line - 0.2) * 10) / 10 });
  const verdict = harmVerdictOnDay(day);
  assert.equal(verdict.status, "clean", JSON.stringify(verdict));
});

test("with a wearing habit and nothing after the day, the verdict is unknown — never harm, never clean", () => {
  const day = localDaysAgo(5);
  liftedOn(day);
  ownNights(day, 20);
  const verdict = harmVerdictOnDay(day);
  assert.equal(verdict.status, "unknown");
  assert.equal(verdict.evidence, null);
  assert.equal(harmEvidenceOnDay(day), null);
});
