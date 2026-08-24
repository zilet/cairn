// dayRead (src/repo.ts) is the deterministic floor under the Brief. The
// constitution says it SUGGESTS, never gates — these cases pin the three reads
// and the two protect-recovery triggers (earned rest, clearly-low recovery).
// dayRead(date, recovery) takes an explicit recovery object, letting us drive the
// low-sleep branch without coupling to wall-clock "now".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  db,
  repo,
  resetTables,
  seedSleep,
  seedTrainingDay,
  seedRecoveryDay,
  isoDaysAgo,
  localDaysAgo,
} from "./_seed.js";
import {
  DAY_READ_CAVEAT_CONCEPT,
  DAY_READ_CAVEAT_VARIANTS,
  DAY_READ_EARN_PATH_VARIANTS,
  DAY_READ_DRIVE_FOCUS_HEADLINE_VARIANTS,
  DAY_READ_DRIVE_HEADLINE_VARIANTS,
  DAY_READ_FOCUS_HEADLINE_VARIANTS,
  DAY_READ_HEADLINE_CONCEPT,
  DAY_READ_HEADLINE_VARIANTS,
  DAY_READ_LEAD_CONCEPT,
  DAY_READ_LEAD_VARIANTS,
  DAY_READ_OUTCOMES,
  DAY_READ_POLICY_REASON_VARIANTS,
  DAY_READ_REQUIRED_CONCEPT,
  DAY_READ_WHY_VARIANTS,
  PUSH_DRIVE_WHY,
  QUIET_STREAK_GUARDED_WHY,
  QUIET_STREAK_WHY,
  RECOVERY_WEEK_SOFTEN_WHY,
  dayReadHeadline,
  quietOrdinal,
  violatesReadingGrammar,
} from "../dist/repo/day-read.js";
import { UNPROGRAMMED_EASY_DAY, pickDayVariant } from "../dist/repo/brain/day-read-rules.js";
import { SIGNAL_VOICE_REGISTRY, signalVoice } from "../dist/repo/signal-state.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A reference date well clear of the recovery window so an empty recovery fetch
// can't accidentally flip the read.
const REF = "2026-03-15";
const dayBefore = (base, n) => new Date(new Date(base + "T00:00:00Z").getTime() - n * 864e5).toISOString().slice(0, 10);

// A 14-day sleep mean only speaks once it has the same sample floor as the
// neighbouring delta block, and a current night so the window is not a stale leftover.
function sleepMean(avgMin, extra = {}) {
  return {
    has_data: true,
    recovery: { avg_sleep_min: avgMin, ...(extra.recovery || {}) },
    quality: {
      sleep_min: { sample_count: extra.samples ?? 5, expected_days: 14, window_days: 14, freshness: "fresh" },
      ...(extra.quality || {}),
    },
    ...(extra.delta ? { delta: extra.delta } : {}),
  };
}
function seedCurrentNight(date, minutes = 420) {
  return seedSleep(dayBefore(date, 1), minutes);
}

// Every rule now speaks in SEVERAL calm phrasings of the same judgement, rotated by
// calendar day (a stable input used to print one literal forever). So a case pins the
// rule's whole vocabulary, not the sentence that happened to land on this date.
const saysOneOf = (text, code) =>
  assert.ok((DAY_READ_WHY_VARIANTS[code] ?? []).includes(text), `${code}: unexpected wording ${JSON.stringify(text)}`);

// The same idea for the planned-training caveats, which are FRAGMENTS spliced into a
// composed sentence rather than the whole `why` — so membership is a substring test.
// Returns the phrasing that landed, so a caller can assert about what surrounds it.
const saysOneCaveat = (text, key) => {
  const landed = (DAY_READ_CAVEAT_VARIANTS[key] ?? []).find((variant) => text.includes(variant));
  assert.ok(landed, `${key}: no registered phrasing found in ${JSON.stringify(text)}`);
  return landed;
};

// The movement work-around names the injury in the athlete's own register and rotates
// by calendar day like every other sentence (it used to splice the machine-facing
// evidence summary behind one fixed lead-in), so a case pins the whole set. Returns the
// phrasing that landed, so a caller can assert about what follows it.
const injurySentence = (text, title) => {
  const landed = signalVoice({ key: "active_injury", subject: title.toLowerCase() }).find((variant) =>
    text.includes(variant)
  );
  assert.ok(landed, `expected the injury work-around, got ${JSON.stringify(text)}`);
  return landed;
};

beforeEach(() => {
  resetTables(
    "logged_sets",
    "sessions",
    "session_skips",
    "plan_items",
    "plan_days",
    "checkins",
    "daily_metrics",
    "activities",
    "context_events"
  );
});

test("REST on >=3 consecutive training days ending the day before", () => {
  for (let i = 1; i <= 3; i++) seedTrainingDay(dayBefore(REF, i));
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
  saysOneOf(r.why, "accumulated_load_rest");
});

// ---------- the training drive: a PREFERENCE that selects, never one that decides ----------
// `settings.training_drive = 'push'` lets the athlete answer the ONE rest that is about
// rhythm rather than about a signal — stacked loading days — with a targeted session for
// what is actually due. These cases pin both halves of that: the day it produces, and the
// far longer list of mornings where the preference changes nothing at all because the
// evidence still decides. The reference date is TODAY, like test/dayReadPushLadder.js,
// because the backed tier and the acute due-gate both read freshness off the wall clock.
const DRIVE_REF = localDaysAgo(0);
const DRIVE_WORLD = [
  "checkins",
  "daily_metrics",
  "garmin_daily_metrics",
  "garmin_sources",
  "context_events",
  "sessions",
  "logged_sets",
  "activities",
  "plan_items",
  "plan_days",
  "exercises",
  "profile",
  "day_reads",
  "training_symptom_events",
];

// A stacked-days morning with something genuinely due. The loading days are all squat
// work, so quads/glutes come back saturated and only the programmed-but-untrained pull
// survives the acute gate — which is exactly the shape the read has to name.
function seedDriveMorning({ days = 3, rated = true, due = true } = {}) {
  resetTables(...DRIVE_WORLD);
  if (due) {
    repo.upsertExercise({ name: "Barbell Row", muscle_group: "back" });
    repo.savePlanDay(1, "Pull", "Pull", [{ exercise: "Barbell Row", sets: 3, rep_low: 5, rep_high: 8 }]);
  }
  for (let i = 1; i <= days; i++) seedTrainingDay(localDaysAgo(i));
  if (rated) {
    repo.setSessionFeedback(localDaysAgo(1), { performance: 5 });
    repo.setSessionFeedback(localDaysAgo(2), { performance: 4 });
  }
}

// Fresh, solid readiness — the wearable half of the green-evidence gate.
const readiness = (value) => ({
  has_data: true,
  recovery: { training_readiness: value, avg_training_readiness: value },
  quality: { training_readiness: { latest_date: DRIVE_REF, source: "garmin", freshness: "fresh", sample_count: 1 } },
});

test("the steady drive is the default, and it leaves the stacked-days rest exactly where it is", () => {
  seedDriveMorning();
  assert.equal(repo.getSettings().training_drive, "steady");
  const r = repo.dayRead(DRIVE_REF);
  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
  assert.equal(r.signals.training_drive, "steady");
  assert.equal(r.signals.training_drive_push, undefined);
  // The evidence that WOULD satisfy the push gate is all present — so this case is
  // pinning the preference, not the absence of a green morning.
  assert.equal(r.signals.signal_state.action.support?.level, "backed");
});

test("the push drive turns a stacked-days rest into a targeted train day for what is due", () => {
  seedDriveMorning();
  repo.setSettings({ training_drive: "push" });
  const r = repo.dayRead(DRIVE_REF);

  assert.equal(r.kind, "train");
  assert.equal(r.decision.rule_code, "push_drive_targeted_training");
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.equal(r.focus, "Back");
  assert.equal(r.est_minutes, 60);
  // The whole set, rendered with the group that actually landed — the registered form
  // in DAY_READ_WHY_VARIANTS carries a sample argument, like every other templated set.
  assert.ok(
    PUSH_DRIVE_WHY.map((render) => render("back")).includes(r.why),
    `unexpected wording ${JSON.stringify(r.why)}`
  );
  // It names the group it is targeting, and only the one the acute gate left standing:
  // the squats of the last three days flattened quads and glutes.
  assert.match(r.why, /\bback\b/);
  assert.deepEqual(r.signals.training_drive_push.due, ["back"]);
  assert.equal(r.signals.training_drive_push.backed_by, "logged_sessions");
  assert.equal(r.signals.training_drive, "push");
  // Its own headline set, so a day that exists in PLACE of a rest does not borrow the
  // backed day's "go after it" voice.
  const headline = dayReadHeadline(r, DRIVE_REF);
  assert.ok(
    DAY_READ_DRIVE_FOCUS_HEADLINE_VARIANTS.some((variant) => variant.replace("Lower body", "Back") === headline),
    `unexpected headline ${JSON.stringify(headline)}`
  );
});

test("a fresh, solid readiness reading with a real night behind it earns the drive read on its own", () => {
  // No rated sessions anywhere, so the backed tier is unavailable: this is the wearable
  // corroboration path, and it has to clear a bar well above "nothing is alarming".
  seedDriveMorning({ rated: false });
  seedSleep(DRIVE_REF, 470);
  repo.setSettings({ training_drive: "push" });

  const r = repo.dayRead(DRIVE_REF, readiness(72));
  assert.equal(r.signals.signal_state.action.support, null, "the backed tier is not what earned this");
  assert.equal(r.kind, "train");
  assert.equal(r.decision.rule_code, "push_drive_targeted_training");
  assert.equal(r.signals.training_drive_push.backed_by, "recovery_reading");
});

test("a middling readiness reading does NOT earn the drive read, even though it never triggered a rest", () => {
  seedDriveMorning({ rated: false });
  seedSleep(DRIVE_REF, 470);
  repo.setSettings({ training_drive: "push" });

  const r = repo.dayRead(DRIVE_REF, readiness(45));
  assert.notEqual(r.kind, "train");
  assert.notEqual(r.decision.rule_code, "push_drive_targeted_training");
});

test("a solid readiness reading with a short night behind it does NOT earn the drive read", () => {
  seedDriveMorning({ rated: false });
  seedSleep(DRIVE_REF, 300); // 5h
  repo.setSettings({ training_drive: "push" });

  const r = repo.dayRead(DRIVE_REF, readiness(72));
  assert.notEqual(r.decision.rule_code, "push_drive_targeted_training");
});

test("silence is not corroboration: no night at all leaves the wearable path shut", () => {
  seedDriveMorning({ rated: false });
  repo.setSettings({ training_drive: "push" });

  const r = repo.dayRead(DRIVE_REF, readiness(72));
  assert.equal(r.signals.last_night, null);
  assert.notEqual(r.decision.rule_code, "push_drive_targeted_training");
});

test("the drive read has a hard ceiling: at five loading days running the rest stands", () => {
  seedDriveMorning({ days: 5 });
  repo.setSettings({ training_drive: "push" });
  const r = repo.dayRead(DRIVE_REF);
  assert.equal(r.signals.consecutive_training_days, 5);
  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
  assert.equal(r.signals.training_drive_push, undefined);
  // Four is still inside the ceiling, so the bound is pinned from both sides.
  seedDriveMorning({ days: 4 });
  repo.setSettings({ training_drive: "push" });
  const four = repo.dayRead(DRIVE_REF);
  assert.equal(four.signals.consecutive_training_days, 4);
  assert.equal(four.decision.rule_code, "push_drive_targeted_training");
});

test("a low readiness reading keeps its rest whatever the drive says", () => {
  seedDriveMorning();
  repo.setSettings({ training_drive: "push" });
  const r = repo.dayRead(DRIVE_REF, readiness(20));
  assert.notEqual(r.kind, "train");
  assert.notEqual(r.decision.rule_code, "push_drive_targeted_training");
});

test("a run-down check-in keeps its rest whatever the drive says", () => {
  seedDriveMorning();
  repo.addCheckin(DRIVE_REF, { energy: 1, sleep_feel: 2 });
  repo.setSettings({ training_drive: "push" });
  const r = repo.dayRead(DRIVE_REF);
  assert.notEqual(r.kind, "train");
  assert.notEqual(r.decision.rule_code, "push_drive_targeted_training");
});

test("anything clinical keeps its rest whatever the drive says", () => {
  seedDriveMorning();
  repo.addContextEvent({ kind: "injury", title: "Shoulder strain", start_date: DRIVE_REF });
  repo.setSettings({ training_drive: "push" });
  const r = repo.dayRead(DRIVE_REF);
  assert.notEqual(r.kind, "train");
  assert.notEqual(r.decision.rule_code, "push_drive_targeted_training");
});

test("with nothing genuinely due the drive read has nothing to offer, so the rest stands", () => {
  // Every group the last three days touched is saturated, and there is no programmed
  // work waiting behind them — a targeted day with no target is just a rest day.
  seedDriveMorning({ due: false });
  repo.setSettings({ training_drive: "push" });
  const r = repo.dayRead(DRIVE_REF);
  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
});

test("flipping the drive changes the decision fingerprint, so the warm read cannot survive it", () => {
  seedDriveMorning();
  const steady = repo.dayRead(DRIVE_REF);
  repo.setSettings({ training_drive: "push" });
  const push = repo.dayRead(DRIVE_REF);
  assert.notEqual(steady.input_fingerprint, push.input_fingerprint);
});

// The wearable path is two fields wide — a readiness number and a sleep total — and it
// can open a training day with no rated session behind it at all. It therefore has to
// answer the SAME brake question the backed tier answers about itself, or the athlete
// gets the least-evidenced version of the read on the most-caveated morning.
test("a fresh caution anywhere shuts the wearable path, even with green readiness and a full night", () => {
  seedDriveMorning({ rated: false });
  seedSleep(DRIVE_REF, 470);
  // Bad hotel beds abroad: a fresh routine disruption AND fresh schedule pressure, in
  // two different dimensions, neither of which is severe enough on its own to move the
  // posture off "train" — which is exactly why checking the posture was not enough.
  repo.addContextEvent({
    kind: "travel",
    title: "Overseas trip, bad hotel beds",
    start_date: localDaysAgo(2),
    end_date: DRIVE_REF,
  });
  repo.setSettings({ training_drive: "push" });

  const r = repo.dayRead(DRIVE_REF, readiness(61));
  const brakes = Object.values(r.signals.signal_state.dimensions)
    .flatMap((dimension) => dimension.evidence ?? [])
    .filter((item) => item.direction === "caution" || item.direction === "constraint");
  assert.ok(brakes.length > 0, "the case is only meaningful with a brake actually on the board");
  assert.equal(r.signals.signal_state.action.posture, "train", "no brake was severe enough to move the posture");
  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
  assert.equal(r.signals.training_drive_push, undefined);
});

// SENSOR_MAX_AGE_DAYS.sleep is 2, so a night from the day before yesterday is still
// current enough for the read to VOICE — but it is not corroboration for this morning,
// and the wearable path is the one that needs corroborating.
test("the night before last does not corroborate the drive read, however good it was", () => {
  seedDriveMorning({ rated: false });
  seedSleep(localDaysAgo(2), 480);
  repo.setSettings({ training_drive: "push" });

  const r = repo.dayRead(DRIVE_REF, readiness(72));
  assert.ok(r.signals.last_night, "the night is still visible — its AGE is what shuts the path, not its absence");
  assert.equal(r.signals.last_night.date, localDaysAgo(2));
  assert.notEqual(r.decision.rule_code, "push_drive_targeted_training");

  // Last night's own sleep, same everything else, does earn it.
  seedSleep(localDaysAgo(1), 480);
  const fresh = repo.dayRead(DRIVE_REF, readiness(72));
  assert.equal(fresh.decision.rule_code, "push_drive_targeted_training");
});

// A commitment on the calendar registers as a fresh caution on life_capacity, so it
// shuts BOTH halves of the green-evidence gate before the clock is ever consulted. The
// compression the read carries for it is therefore belt-and-braces; what the athlete
// actually gets on a committed morning is the rest, not a compressed targeted day.
test("a commitment on the calendar keeps the stacked-days rest rather than compressing the drive read", () => {
  seedDriveMorning();
  repo.addContextEvent({
    kind: "family_event",
    title: "School pickup and evening event",
    start_date: DRIVE_REF,
    end_date: DRIVE_REF,
  });
  repo.setSettings({ training_drive: "push" });

  const r = repo.dayRead(DRIVE_REF);
  assert.equal(r.signals.signal_state.action.directives.schedule, "compress");
  assert.equal(r.signals.signal_state.action.support, null, "the commitment is itself a brake");
  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
});

// The drive read's `focus` is the RENDERED due list, and the due list is consumed as the
// session is logged. Hashing it discarded the warm Brief and queued a fresh agent call
// mid-session on a decision that had not moved at all.
test("logging through a drive session does not churn the read's fingerprint", () => {
  resetTables(...DRIVE_WORLD);
  repo.upsertExercise({ name: "Barbell Row", muscle_group: "back" });
  repo.upsertExercise({ name: "Barbell Curl", muscle_group: "biceps" });
  repo.savePlanDay(1, "Pull", "Pull", [{ exercise: "Barbell Row", sets: 3, rep_low: 5, rep_high: 8 }]);
  for (let i = 1; i <= 3; i++) seedTrainingDay(localDaysAgo(i));
  repo.setSessionFeedback(localDaysAgo(1), { performance: 5 });
  repo.setSessionFeedback(localDaysAgo(2), { performance: 4 });
  repo.setSettings({ training_drive: "push" });

  const session = repo.getOrCreateSession(DRIVE_REF);
  const logSet = (exercise) => repo.logSetByName({ session_id: session.id, exercise, weight: 95, reps: 5 });

  // The first set is allowed to move the hash: it flips `trained_today` and lifts
  // `today_load` off "none", both of which are banded decision inputs of long standing
  // and are hashed for EVERY read. From there the day's grade holds at "easy" and
  // nothing about the decision changes, so nothing about the hash may either.
  logSet("Barbell Row");
  const first = repo.dayRead(DRIVE_REF);
  assert.equal(first.decision.rule_code, "push_drive_targeted_training");

  logSet("Barbell Row");
  const second = repo.dayRead(DRIVE_REF);
  assert.equal(second.input_fingerprint, first.input_fingerprint);

  // Now log a different group, which is what actually shifts the rendered due list.
  logSet("Barbell Curl");
  logSet("Barbell Curl");
  const third = repo.dayRead(DRIVE_REF);
  assert.equal(third.decision.rule_code, "push_drive_targeted_training");
  assert.equal(third.signals.today_load, first.signals.today_load, "still the same load grade");
  assert.notEqual(third.focus, first.focus, "the due list really did move — that is the case being pinned");
  assert.equal(third.input_fingerprint, first.input_fingerprint);
});

// Every read now carries `signals.training_drive`. If the mere APPEARANCE of that key
// moved the hash, the first open after deploy would discard every warm agentic Brief on
// the estate and queue a fresh agent call for each — so the default posture is omitted
// from the hash entirely, exactly as `fuel` is kept out of it for the same reason.
test("the drive key's appearance does not invalidate a warm steady read", () => {
  seedDriveMorning();
  const steady = repo.dayRead(DRIVE_REF);
  assert.equal(steady.signals.training_drive, "steady");

  const preDeploy = { kind: steady.kind, focus: steady.focus, signals: { ...steady.signals } };
  delete preDeploy.signals.training_drive;
  assert.equal(
    repo.dayReadInputFingerprint(DRIVE_REF, preDeploy),
    repo.dayReadInputFingerprint(DRIVE_REF, { kind: steady.kind, focus: steady.focus, signals: steady.signals })
  );

  // A real flip still throws the warm read away (pinned above too, end to end).
  const pushed = { kind: steady.kind, focus: steady.focus, signals: { ...steady.signals, training_drive: "push" } };
  assert.notEqual(repo.dayReadInputFingerprint(DRIVE_REF, pushed), repo.dayReadInputFingerprint(DRIVE_REF, preDeploy));
});

test("does NOT force rest on only 2 consecutive training days", () => {
  for (let i = 1; i <= 2; i++) seedTrainingDay(dayBefore(REF, i));
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.notEqual(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 2);
});

test("an active dated obligation compresses a train day without changing its posture", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.addContextEvent({
    kind: "family_event",
    title: "School pickup and evening event",
    start_date: REF,
    end_date: REF,
  });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.est_minutes, 40);
  assert.equal(r.signals.signal_state.action.posture, "train");
  assert.equal(r.signals.signal_state.action.directives.schedule, "compress");
  // `evidence_reason` is the MACHINE register, named as such so no client render can
  // mistake observer prose for something to print; `voice` beside it is what a surface
  // an athlete reads must speak through (spokenSignalVoice).
  assert.deepEqual(r.signals.schedule, {
    directive: "compress",
    compressed: true,
    original_est_minutes: 60,
    est_minutes: 40,
    evidence_reason: "School pickup and evening event adds schedule pressure today.",
    voice: r.signals.signal_state.dimensions.life_capacity.voice,
  });
  assert.equal(r.signals.schedule.voice.key, "commitment_pressure");
  assert.equal(r.signals.signal_state.dimensions.life_capacity.voice.key, "commitment_pressure");
  saysOneCaveat(r.why, "planned_training:commitment_pressure");
});

// `schedule: "compress"` has two unrelated causes and only one of them is a calendar
// entry. `context.expect_worse_sleep` — a late night, a stressful stretch — sets the
// SAME directive from the SAME field, so reading the directive alone told an athlete
// with nothing but "Brutal week at work" on record that "you've got a commitment today
// that shortens the training window", and answered a recovery signal by cutting the
// session from 60 minutes to 40.
test("a stressful stretch is NOT a commitment: no calendar claim, and the clock is left alone", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.addContextEvent({ kind: "life_event", title: "Brutal week at work", start_date: REF, end_date: REF });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.signals.signal_state.action.posture, "train");
  // The signal state still says compress — the READ is what stopped over-reading it.
  assert.equal(r.signals.signal_state.action.directives.schedule, "compress");
  assert.equal(r.signals.signal_state.dimensions.life_capacity.voice.key, "schedule_pressure");

  assert.equal(r.est_minutes, 60, "thin recovery is a reason to hold intensity, not to shorten the day");
  assert.deepEqual(r.signals.schedule, {
    directive: "compress",
    compressed: false,
    original_est_minutes: 60,
    est_minutes: 60,
    evidence_reason: "A current commitment or stressful stretch is likely to compress recovery capacity.",
    voice: r.signals.signal_state.dimensions.life_capacity.voice,
  });
  assert.equal(r.signals.schedule.voice.key, "schedule_pressure");

  saysOneCaveat(r.why, "planned_training:life_pressure");
  // The false claim, in every phrasing the commitment set can produce.
  for (const variant of DAY_READ_CAVEAT_VARIANTS["planned_training:commitment_pressure"]) {
    assert.equal(r.why.includes(variant), false, `claimed a commitment that does not exist: ${JSON.stringify(r.why)}`);
  }
  assert.doesNotMatch(r.why, /\bcommitment\b|\bcalendar\b|\btraining window\b/i);
});

test("the two schedule-pressure caveats never claim each other's cause", () => {
  const commitment = DAY_READ_CAVEAT_VARIANTS["planned_training:commitment_pressure"];
  const life = DAY_READ_CAVEAT_VARIANTS["planned_training:life_pressure"];
  // Only a real dated row may talk about the clock; only thin recovery may talk about
  // recovery. Disjoint concepts are what keep the false claim from creeping back in.
  for (const variant of commitment) {
    assert.doesNotMatch(variant, /\brecovery\b|\bsleep\b/i, `a commitment caveat must not claim a recovery cause`);
  }
  for (const variant of life) {
    assert.doesNotMatch(variant, /\bcommitment\b|\bcalendar\b|\bwindow\b/i, `a life caveat must not claim a calendar`);
  }
});

test("poor recovery owns an injury-overlap day while the movement work-around survives", () => {
  repo.savePlanDay(1, "Upper", "Upper body", [{ exercise: "Overhead Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.addContextEvent({
    kind: "injury",
    title: "Shoulder strain",
    detail: "Overhead loading aggravates it",
    start_date: REF,
  });

  const r = repo.dayRead(REF, {
    has_data: true,
    recovery: { training_readiness: 20, avg_training_readiness: 50 },
    quality: {
      training_readiness: { latest_date: REF, source: "garmin", freshness: "fresh", sample_count: 1 },
    },
  });
  assert.equal(r.kind, "easy");
  assert.equal(r.signals.signal_state.action.posture, "easy");
  assert.equal(r.signals.signal_state.action.directives.training, "recover");
  assert.equal(r.signals.health_workaround.field, "active_injury");
  injurySentence(r.why, "Shoulder strain");
  assert.match(r.why, /shoulder/i);
  // The evidence summary is machine-facing and stays that way: what the athlete reads
  // is never the observer's note written about them.
  assert.doesNotMatch(r.why, /\bthe athlete\b/i);
});

test("a single short night does not claim a chronic sleep pattern", () => {
  // n=1 used to be a legal mean: one 5-hour night in a fortnight printed "sleeping
  // under six hours on average" and turned an unprogrammed day easy.
  seedSleep(dayBefore(REF, 1), 300);
  const r = repo.dayRead(REF, sleepMean(300, { samples: 1 }));
  assert.equal(r.signals.low_sleep, false);
  assert.notEqual(r.decision.rule_code, "chronic_sleep_watch");
  assert.notEqual(r.decision.rule_code, "acute_sleep_corroborated");
});

test("a short rolling sleep average is a chronic EASY watch when nothing is programmed", () => {
  // A 14-day pattern matters, but it is not fresh evidence about this morning.
  // Last night is current and NOT short, so the REST rule does not consume this.
  seedCurrentNight(REF);
  const r = repo.dayRead(REF, sleepMean(300)); // 5h mean, 7h last night
  assert.equal(r.kind, "easy");
  assert.equal(r.signals.low_sleep, true);
  assert.equal(r.decision.rule_code, "chronic_sleep_watch");
  saysOneOf(r.why, "chronic_sleep_watch");
});

test("a chronically short sleeper is still OFFERED a due plan day, with the sleep as a caveat", () => {
  // The watch used to sit ABOVE the plan-day rule, so anyone whose rolling average
  // ran under six hours was never offered their session at all — permanent rest
  // traded for permanent easy. It is a caveat on the train read now, like a volume
  // spike: the concern is voiced, the athlete still gets their day.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  seedCurrentNight(REF);
  const r = repo.dayRead(REF, sleepMean(300)); // 5h mean, 7h last night

  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Lower body");
  assert.equal(r.signals.low_sleep, true);
  assert.equal(r.decision.rule_code, "planned_training");
  // The caveat rotates by calendar day like every other athlete-facing string, so this
  // pins the whole set rather than the phrasing that happens to land on REF.
  saysOneCaveat(r.why, "planned_training:low_sleep");
});

// The hold lead used to speak `action.voice`, which on a ready/train day is drawn from
// SUPPORT evidence — so a hold day led with "by your own read, you slept fine" and then
// asked the athlete to hold, with the caveat's "until that settles" pointing at nothing.
// `directives.training_source` names the dimension whose status produced the hold, and
// its own voice is the brake.
// SINCE THE 2026-08-17 REBALANCE this fixture — one caution, alone on the board —
// no longer holds aggression; it takes the unseconded-caution branch instead, which
// speaks the same brake in the same place and leaves the day open (see
// brainRebalanceEarnPath.test.js for the bar itself, and for the hold branch's own
// version of this assertion). The DEFECT this case exists for is untouched and is
// still exactly reproducible here: the day is posture "train" / readiness "ready", so
// `action.voice` is drawn from SUPPORT evidence, and the branch must reach past it to
// the brake's own voice.
test("a caution-led train day leads with the BRAKE's voice, never a support voice, and rotates", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const brake = signalVoice({ key: "generic_activity_load", subject: "51 exercise minutes and 8.4 km of movement" });
  const support = signalVoice({ key: "sleep_feel_ok" });
  const leads = [];

  for (let back = 2; back >= 0; back--) {
    const date = dayBefore(REF, back);
    repo.addCheckin(date, { sleep_feel: 4 });
    const r = repo.dayRead(date, {
      has_data: true,
      recovery: { exercise_min: 51, distance_km: 8.4 },
      quality: {
        exercise_min: { latest_date: date, source: "apple", freshness: "fresh", sample_count: 1 },
        distance_km: { latest_date: date, source: "apple", freshness: "fresh", sample_count: 1 },
      },
    });

    assert.equal(r.kind, "train");
    assert.equal(r.decision.rule_code, "planned_training");
    const action = r.signals.signal_state.action;
    assert.equal(action.posture, "train");
    assert.equal(action.readiness, "ready");
    // The finding is still on the board in full; what it no longer does is stop the
    // week on its own.
    assert.equal(r.signals.signal_state.dimensions.training_load_tolerance.status, "watch");
    assert.equal(action.directives.training, "proceed");
    // The posture voice IS the support one — that is the whole defect, and it stays
    // true. What changed is which voice the branch reaches for.
    assert.equal(action.voice.key, "sleep_feel_ok");

    const lead = brake.find((variant) => r.why.startsWith(variant));
    assert.ok(lead, `expected the brake to lead the read, got ${JSON.stringify(r.why)}`);
    leads.push(lead);
    for (const variant of support) {
      assert.equal(r.why.includes(variant), false, `a support voice spoke on a braked day: ${JSON.stringify(r.why)}`);
    }
    assert.ok(
      DAY_READ_LEAD_VARIANTS["planned_training:noted_lead"].some((variant) => r.why.includes(variant)),
      `expected the noted lead, got ${JSON.stringify(r.why)}`
    );
    assert.match(r.why, /\.$/, "the composed read is still one finished sentence run");
  }
  assert.equal(new Set(leads).size, leads.length, "consecutive days must not repeat the brake's phrasing");
});

// The caveats are fragments joined with "; and " inside ONE sentence, so a stray
// capital or full stop in any phrasing breaks the sentence the athlete actually reads.
// Three at once is where that shows up.
test("three caveats at once still compose into one grammatical sentence", () => {
  for (let i = 1; i <= 2; i++) seedTrainingDay(dayBefore(REF, i));
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  seedCurrentNight(REF);
  const r = repo.dayRead(
    REF,
    sleepMean(300, {
      recovery: { exercise_min: 51, distance_km: 8.4 },
      delta: { rhr: 5 }, // recovery drifting the wrong way → the deload anticipation
      quality: {
        exercise_min: { latest_date: REF, source: "apple", freshness: "fresh", sample_count: 1 },
        distance_km: { latest_date: REF, source: "apple", freshness: "fresh", sample_count: 1 },
      },
    }),
    undefined,
    // The second watch the hold has needed since the 2026-08-17 ruling. Fuelling adds
    // no caveat of its own here, so this is still exactly three caveats composing.
    { state: "settling", rationale: "Fuel availability is still settling." }
  );

  assert.equal(r.kind, "train");
  assert.equal(r.decision.rule_code, "planned_training");
  saysOneCaveat(r.why, "planned_training:anticipate_deload");
  saysOneCaveat(r.why, "planned_training:low_sleep");
  saysOneCaveat(r.why, "planned_training:hold_aggression");
  assert.equal(r.why.split("; and ").length, 3, "three caveats, joined once each");

  // One finished sentence run: the only terminal stops are the brake's own lead, the
  // full stop that closes the caveat run, and — since the 2026-08-17 rebalance — the
  // earn path that closes the read. It is stripped first so the caveat run is held to
  // exactly the shape it always was.
  assert.match(r.why, /\.$/);
  assert.doesNotMatch(r.why, /\.\.|\s;|;\s*and\s*[A-Z]|—\s*[A-Z]/, `broken sentence: ${JSON.stringify(r.why)}`);
  const earn = Object.values(DAY_READ_EARN_PATH_VARIANTS)
    .flat()
    .find((variant) => r.why.endsWith(variant));
  assert.ok(earn, `a hold must say what lifts it: ${JSON.stringify(r.why)}`);
  const composed = r.why.slice(0, r.why.length - earn.length).trimEnd();
  const caveatRun = composed.slice(composed.indexOf(" — ") + 3);
  assert.equal(caveatRun.split(".").length, 2, `the caveat run must be one sentence: ${JSON.stringify(caveatRun)}`);
});

test("a fresh short night corroborating the short rolling average can suggest REST", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 300)`).run(dayBefore(REF, 1));

  const r = repo.dayRead(REF, sleepMean(330));

  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "acute_sleep_corroborated");
  assert.equal(
    r.decision.evidence.some((item) => item.date === dayBefore(REF, 1)),
    true
  );
  saysOneOf(r.why, "acute_sleep_corroborated");
});

test("a corroborated short night on an injury day still names the work-around", () => {
  // The gap that let the defect through: every injury case drove LOW READINESS, so the
  // protect rule always won and the movement work-around always got spoken. A short
  // night preempts that rule — and health constraints are exactly what drive the protect
  // posture, so the two co-occur constantly. The injury must survive the rule that wins.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.addContextEvent({
    kind: "injury",
    title: "Achilles tendinopathy",
    detail: "Running and jumping aggravate it",
    start_date: REF,
  });
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 300)`).run(dayBefore(REF, 1));

  const r = repo.dayRead(REF, sleepMean(330));

  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "acute_sleep_corroborated");
  // The sleep rule still leads with its own words...
  assert.ok(
    DAY_READ_WHY_VARIANTS.acute_sleep_corroborated.some((v) => r.why.startsWith(v)),
    `the sleep read should still lead, got ${JSON.stringify(r.why)}`
  );
  // ...and the injury is still named, in both registers.
  assert.equal(r.signals.health_workaround.field, "active_injury");
  injurySentence(r.why, "Achilles tendinopathy");
  assert.match(r.why, /achilles/i);
  // Whatever the continuity voice appends next lands after this, so the spliced
  // sentence has to close.
  assert.match(r.why, /[.!?]$/, "the read still closes as a sentence");
  // The machine-facing summary keeps the classifier line ("Achilles tendinopathy: an
  // active injury is worth easing or working around") for provenance; the athlete
  // hears the name once, in one voice.
  assert.match(r.signals.health_workaround.reason, /an active injury is worth easing/i);
  assert.doesNotMatch(r.why, /an active injury is worth easing/i);
});

test("low subjective check-in (low energy) forces REST", () => {
  // checkin is read by date inside dayRead (getCheckinByDate(d)); seed it on REF.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3 }]);
  repo.addCheckin(REF, { energy: 1, sleep_feel: 2, mood: 2, soreness: 4 });
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  // A low-energy check-in is a safety override, so the unified protect posture — not
  // the felt_run_down_rest rule — owns this read. Both speak the SAME words, because
  // one trigger reading in two voices depending on which rule won is the defect.
  assert.equal(r.decision.rule_code, "acute_signal_protection");
  saysOneOf(r.why, "acute_signal_protection:felt_energy_low");
  assert.deepEqual(
    [...DAY_READ_WHY_VARIANTS.felt_run_down_rest],
    [...DAY_READ_WHY_VARIANTS["acute_signal_protection:felt_energy_low"]]
  );
});

test("TRAIN when recovered, due, and a plan day exists", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Lower body");
  assert.equal(typeof r.est_minutes, "number");
});

test("EASY when nothing is programmed and recovery is unremarkable", () => {
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "unprogrammed_easy_day");
  saysOneOf(r.why, "unprogrammed_easy_day");
});

test("EASY after a LIGHT activity is already logged today", () => {
  // A short easy outing (a 25-min stroll — below the hard-cardio bar) reads as
  // 'covered', not a fresh session, but stays easy: it isn't real loading work.
  db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 25)`).run(REF);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
  assert.match(r.why, /already/i);
});

// ── PART 2: a genuinely HARD cardio day counts REGARDLESS of discipline ──────────
test("a HARD cardio day (40+ min run) reads DONE for a strength-primary athlete", () => {
  // A strength-primary lifter's genuinely hard run is real work: it reads DONE (a
  // solid run in, recover the rest of the day), not a fresh session and not merely
  // "keep it easy". Cardio is no longer invisible just because the discipline is strength.
  repo.setProfile({ primary_discipline: "strength" });
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 48, 9)`).run(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.equal(r.signals.trained_today, true);
  assert.equal(
    r.signals.today_load !== "none" && r.signals.today_load !== "easy",
    true,
    "hard cardio grades as loading"
  );
});

test("hard cardio stacks toward earned rest REGARDLESS of discipline", () => {
  // Three straight 45-min runs make a strength-primary athlete's Brief suggest rest,
  // exactly as three straight lifting days would — the streak counts hard cardio.
  repo.setProfile({ primary_discipline: "strength" });
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 45, 8)`).run(
      dayBefore(REF, i)
    );
  }
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 3);
});

test("an easy stroll never counts toward the loading streak (negative case)", () => {
  // Short 25-min walks are below every hard-cardio bar, so they break (never build)
  // the loading streak — no forced rest off strolls, no false 'done'.
  repo.setProfile({ primary_discipline: "strength" });
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 25)`).run(dayBefore(REF, i));
  }
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.notEqual(r.kind, "rest");
  assert.equal(r.signals.consecutive_training_days, 0);
});

test("a ~43-min easy hike today does NOT flip a planned-lift day to DONE", () => {
  // Fix round: an easy hike (no wearable data) must not grade as loading — it reads as
  // "covered but easy", never DONE/recover, so it never suppresses the planned session.
  repo.setProfile({ primary_discipline: "strength" });
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'hike', 43, 4)`).run(REF);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.notEqual(r.kind, "done");
  assert.notEqual(r.kind, "rest");
});

test("prior ~43-min easy hikes do NOT stack toward earned rest (planned lift still suggested)", () => {
  repo.setProfile({ primary_discipline: "strength" });
  for (let i = 1; i <= 3; i++) {
    db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'hike', 43, 4)`).run(
      dayBefore(REF, i)
    );
  }
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 0, "easy hikes never stack loading days");
  assert.equal(r.kind, "train");
  assert.equal(r.focus, "Lower body");
});

test("DONE (not EASY) when a real loading session is already logged today", () => {
  // A hard session today is a FACT — the read must acknowledge it as DONE, never
  // mislabel it "easy". (This is the bug: a hard push session read "EASY DAY".)
  seedTrainingDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.match(r.why, /recovery/i);
  assert.equal(r.signals.trained_today, true);
});

test("DONE preempts REST: a hard session today wins over 3 prior hard days", () => {
  // The user's exact case — trained hard for days AND already trained again today. A
  // "Rest today" read would contradict the work already in (and the session sitting
  // below it). The day must read DONE (debrief), never tell them to rest after they've
  // already loaded. This is the done-before-earned-rest ordering.
  for (let i = 1; i <= 3; i++) seedTrainingDay(dayBefore(REF, i));
  seedTrainingDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.equal(r.kind, "done");
  assert.equal(r.signals.trained_today, true);
});

test("DONE 'why' names the session (not the run) when both land today", () => {
  // A lift + a run on the same day must not let the run's label erase the strength work
  // in the deterministic floor's why-line.
  seedTrainingDay(REF);
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', 40, 6)`).run(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "done");
  assert.match(r.why, /\bsession\b/i);
  assert.doesNotMatch(r.why, /\brun\b/i);
});

test("stale sleep is NOT treated as last night (no fabricated sleep read)", () => {
  // A wearable can stop syncing sleep for weeks; a ~month-old night is NOT last night.
  // dayRead must surface it as ABSENT so the Brief never asserts "you slept fine".
  resetTables("daily_metrics", "garmin_daily_metrics");
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 440)`).run(dayBefore(REF, 25));
  const stale = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(stale.signals.last_night, null);
  // A recent night (yesterday) IS surfaced as last night.
  resetTables("daily_metrics", "garmin_daily_metrics");
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 440)`).run(dayBefore(REF, 1));
  const fresh = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.ok(fresh.signals.last_night && fresh.signals.last_night.total_min === 440);
});

test("EASY (not DONE) when today's logged work was only light", () => {
  // A short mobility/recovery session graded 'easy' is NOT a completed training
  // day — keep it 'easy' (they may still want their real work), never 'done'.
  seedRecoveryDay(REF);
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
});

test("forwardLook points to the NEXT session's focus (the day-ahead heads-up)", () => {
  repo.savePlanDay(1, "Push", "Chest & shoulders", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  repo.savePlanDay(2, "Lower", "Lower body", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 225 },
  ]);
  // Trained Push (plan day 1) the day before REF → the forward look is plan day 2.
  const ex = repo.upsertExercise({ name: "Bench Press", muscle_group: "chest" });
  const day1Id = repo.getPlanDay(1).id; // the real plan_days row id (autoincrement varies in the shared DB)
  const sess = repo.getOrCreateSession(dayBefore(REF, 1), day1Id);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 135, 6, 2)`
  ).run(sess.id, ex.id);
  const fl = repo.forwardLook(REF);
  assert.equal(fl.next_focus, "Lower body");
  assert.match(fl.text, /Lower body/);
});

test("forwardLook is null-safe with no plan (degrades, never throws)", () => {
  const fl = repo.forwardLook(REF);
  assert.equal(fl.next_focus, null);
  assert.equal(fl.text, null);
});

test("absent signals never throw and never force rest (graceful degradation)", () => {
  // No recovery, no check-in, no sessions, no plan — must return a calm 'easy'.
  const r = repo.dayRead(isoDaysAgo(0));
  assert.equal(r.kind, "easy");
  assert.equal(r.signals.consecutive_training_days, 0);
});

test("enforceCompletionContract clamps completion facts in BOTH directions", async () => {
  const { enforceCompletionContract } = await import("../dist/dayread.js");

  // Agent claims "done" on a day the server says is not done → deterministic floor.
  const trainBaseline = { kind: "train", focus: "Lower body", why: "Recovered and due.", est_minutes: 60, signals: {} };
  const falseDone = enforceCompletionContract(
    {
      kind: "done",
      headline: "You're done.",
      why: "Great work!",
      focus: null,
      est_minutes: null,
      source: "agent",
      agent: "claude",
    },
    trainBaseline
  );
  assert.equal(falseDone.kind, "train", "an agent can never mark an untrained day done");
  assert.equal(falseDone.source, "deterministic");
  assert.equal(falseDone.agent, "claude", "provenance survives the clamp");

  // Agent downgrades a genuinely-done day → forced back to done, prospective residue stripped.
  const doneBaseline = { kind: "done", focus: null, why: "Solid run in.", est_minutes: null, signals: {} };
  const downgraded = enforceCompletionContract(
    { kind: "easy", headline: "Take it easy.", why: "Light day.", focus: "Easy", est_minutes: 30, source: "agent" },
    doneBaseline
  );
  assert.equal(downgraded.kind, "done");
  assert.equal(downgraded.focus, null);
  assert.equal(downgraded.est_minutes, null);

  // Agent voices done correctly → its warm prose survives, residue still nulled.
  const voiced = enforceCompletionContract(
    {
      kind: "done",
      headline: "Strong push session.",
      why: "The work is in — refuel well.",
      focus: "Push",
      est_minutes: 60,
      source: "agent",
    },
    doneBaseline
  );
  assert.equal(voiced.kind, "done");
  assert.equal(voiced.headline, "Strong push session.");
  assert.equal(voiced.focus, null);
  assert.equal(voiced.est_minutes, null);
});

test("agentic day-read posture cannot become more aggressive without an athlete override", async () => {
  const { enforceDayReadSafetyPosture, enforceCompletionContract } = await import("../dist/dayread.js");
  const restBaseline = {
    kind: "rest",
    focus: null,
    why: "Recovery signals say rest is the smart call.",
    est_minutes: null,
    signals: { low_sleep: true },
  };
  const aggressive = {
    kind: "train",
    headline: "Push hard today.",
    why: "The plan says legs.",
    focus: "Lower body",
    est_minutes: 60,
    signals: restBaseline.signals,
    source: "agent",
    agent: "claude",
    tried: ["claude"],
  };
  const clamped = enforceDayReadSafetyPosture(aggressive, restBaseline, false);
  assert.equal(clamped.kind, "rest");
  // The clamp writes a ROTATED headline (it used to write the literal "Rest today."
  // every single day), so this pins the registered set, not today's roll.
  assert.ok(
    DAY_READ_HEADLINE_VARIANTS.rest.includes(clamped.headline),
    `unexpected clamped headline ${JSON.stringify(clamped.headline)}`
  );
  assert.equal(clamped.why, restBaseline.why, "clamped prose must match the deterministic posture");
  assert.equal(clamped.focus, null);
  assert.equal(clamped.est_minutes, null);
  assert.equal(clamped.source, "deterministic");
  assert.equal(clamped.agent, "claude", "agent provenance survives the policy clamp");

  const easyBaseline = {
    kind: "easy",
    focus: "Easy movement",
    why: "Nothing programmed today.",
    est_minutes: 30,
    signals: {},
  };
  assert.equal(enforceDayReadSafetyPosture(aggressive, easyBaseline, false).kind, "easy");

  const conservative = { ...aggressive, kind: "rest", headline: "Rest today.", why: "Take the recovery." };
  assert.equal(
    enforceDayReadSafetyPosture(conservative, { ...easyBaseline, kind: "train" }, false),
    conservative,
    "the agent may always become more conservative"
  );

  assert.equal(
    enforceDayReadSafetyPosture(aggressive, restBaseline, true),
    aggressive,
    "an explicit athlete override preserves the bounded agent recommendation"
  );
  const falseDone = { ...aggressive, kind: "done", headline: "All done." };
  const overrideStillNotDone = enforceCompletionContract(
    enforceDayReadSafetyPosture(falseDone, restBaseline, true),
    restBaseline
  );
  assert.equal(overrideStillNotDone.kind, "rest", "completion remains non-negotiable under an override");
});

test("recovery-week prose policy prevents repeated non-loading days but preserves athlete control", async () => {
  const { enforceRecoveryWeekCadence } = await import("../dist/dayread.js");
  const recoveryWeek = { state: "applied", applied_on: "2026-03-12", until: "2026-03-19" };
  const baseline = {
    kind: "train",
    headline: "Reduced lower body.",
    focus: "Lower body",
    why: "Use the reduced prescription and keep every set crisp.",
    est_minutes: 45,
    signals: {
      recovery_week: recoveryWeek,
      recent_load: [{ date: "2026-03-14", load: "easy" }],
    },
    input_fingerprint: "stable",
  };
  const agentEasy = {
    kind: "easy",
    headline: "Take it easy.",
    focus: null,
    why: "Broad context says keep resting.",
    est_minutes: 20,
    source: "agent",
    agent: "stub",
  };
  const agentRest = { ...agentEasy, kind: "rest", headline: "Rest today.", est_minutes: null };

  for (const agentRead of [agentEasy, agentRest]) {
    const clamped = enforceRecoveryWeekCadence(agentRead, baseline, false);
    assert.equal(clamped.kind, "train", "a non-loading prior day returns to the reduced training dose");
    assert.equal(clamped.focus, "Lower body");
    assert.equal(clamped.decision.basis, "server_policy");
    assert.equal(clamped.decision.rule_code, "recovery_week_reduced_train_after_non_loading_day");
  }

  for (const recent_load of [[], [{ date: "2026-03-14", load: "none" }]]) {
    const noLoadBaseline = {
      ...baseline,
      signals: { ...baseline.signals, recent_load },
    };
    const clamped = enforceRecoveryWeekCadence(agentEasy, noLoadBaseline, false);
    assert.equal(clamped.kind, "train", "empty/none history is an explicit non-loading prior day");
    assert.equal(clamped.decision.rule_code, "recovery_week_reduced_train_after_non_loading_day");
  }

  const afterLoading = {
    ...baseline,
    signals: {
      ...baseline.signals,
      recent_load: [{ date: "2026-03-14", load: "moderate" }],
    },
  };
  const softened = enforceRecoveryWeekCadence(agentRest, afterLoading, false);
  assert.equal(softened.kind, "easy", "rest may soften only as far as easy immediately after real load");
  assert.equal(softened.decision.rule_code, "recovery_week_rest_softened_to_easy_after_loading_day");
  assert.equal(
    enforceRecoveryWeekCadence(agentEasy, afterLoading, false),
    agentEasy,
    "an agent easy day remains allowed immediately after a moderate day"
  );

  const acuteBaseline = {
    ...baseline,
    kind: "rest",
    focus: null,
    why: "A fresh acute signal calls for rest.",
    est_minutes: null,
  };
  assert.equal(
    enforceRecoveryWeekCadence(acuteBaseline, acuteBaseline, false),
    acuteBaseline,
    "the cadence policy never rewrites an acute deterministic rest baseline"
  );

  assert.equal(
    enforceRecoveryWeekCadence(agentRest, baseline, true),
    agentRest,
    "an explicit athlete override bypasses the recovery-week cadence clamp"
  );

  assert.ok(
    RECOVERY_WEEK_SOFTEN_WHY.includes(softened.why),
    `unexpected wording for the softened rest→easy day: ${JSON.stringify(softened.why)}`
  );
});

// The rest→easy softening clamp fires every day an applied recovery week follows a
// real loading day — exactly the path most likely to repeat verbatim for up to seven
// days straight (the original "rest after rest after rest" complaint this whole round
// exists to fix), so it rotates through pickDayVariant just like every other rule.
test("recovery-week rest→easy softening rotates day to day and stays stable per day", async () => {
  const { enforceRecoveryWeekCadence } = await import("../dist/dayread.js");
  const baselineFor = (date) => ({
    kind: "train",
    headline: "Reduced lower body.",
    focus: "Lower body",
    why: "Use the reduced prescription and keep every set crisp.",
    est_minutes: 45,
    signals: {
      recovery_week: { state: "applied", applied_on: dayBefore(date, 3), until: dayBefore(date, -4) },
      recent_load: [{ date: dayBefore(date, 1), load: "moderate" }],
    },
    input_fingerprint: "stable",
  });
  const agentRest = {
    kind: "rest",
    headline: "Rest today.",
    focus: null,
    why: "Broad context says keep resting.",
    est_minutes: null,
    source: "agent",
    agent: "stub",
  };

  const REASON_CODE = "recovery_week_rest_softened_to_easy_after_loading_day";
  const reasonVariants = DAY_READ_POLICY_REASON_VARIANTS[REASON_CODE];

  // Same day + same inputs ⇒ the same wording, every time — in BOTH registers (the
  // athlete-facing `why` and the ledger `decision.reason`, which rotates through the
  // same mechanism keyed on the same rule_code).
  const first = enforceRecoveryWeekCadence(agentRest, baselineFor(REF), false, REF);
  const again = enforceRecoveryWeekCadence(agentRest, baselineFor(REF), false, REF);
  assert.equal(again.why, first.why, "the same calendar day must not re-roll its wording");
  assert.equal(again.decision.reason, first.decision.reason, "the ledger reason must not re-roll either");
  // The two registers say something DIFFERENT on the same card, not the same idea
  // reworded — `why` narrates the day, `reason` explains the override.
  assert.notEqual(first.why, first.decision.reason, "why and reason must not restate each other");

  // Consecutive days always differ, and every day's wording stays within the set.
  const seen = [];
  for (let back = 6; back >= 0; back--) {
    const date = dayBefore(REF, back);
    const result = enforceRecoveryWeekCadence(agentRest, baselineFor(date), false, date);
    assert.ok(
      RECOVERY_WEEK_SOFTEN_WHY.includes(result.why),
      `${date}: unexpected wording ${JSON.stringify(result.why)}`
    );
    assert.ok(
      reasonVariants.includes(result.decision.reason),
      `${date}: unexpected reason ${JSON.stringify(result.decision.reason)}`
    );
    seen.push({ date, why: result.why, reason: result.decision.reason });
  }
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i].why, seen[i - 1].why, `${seen[i].date} repeated ${seen[i - 1].date} verbatim`);
    assert.notEqual(
      seen[i].reason,
      seen[i - 1].reason,
      `${seen[i].date} repeated ${seen[i - 1].date}'s reason verbatim`
    );
  }
  assert.ok(new Set(seen.map((s) => s.why)).size >= 3, "seven days must not cycle through only one or two sentences");
  assert.ok(new Set(seen.map((s) => s.reason)).size >= 3, "the ledger reason must vary the same way");
});

// The other four server-policy clamps in dayread.ts also populate decision.reason
// unconditionally (it's rendered on the Brief whenever non-empty), and each can fire
// on consecutive days the same way the recovery-week softening clamp can — so each
// rotates through pickDayVariant too, keyed on its own rule_code.
test("every other server-policy reason rotates day to day and stays within its own set", async () => {
  const { enforceCompletionContract, enforceDayReadSafetyPosture, enforceRecoveryWeekCadence } = await import(
    "../dist/dayread.js"
  );
  const scenarios = [
    {
      code: "completion_fact_not_logged",
      run: (date) =>
        enforceCompletionContract(
          { kind: "done", headline: "All done.", why: "Nice work.", agent: "stub", tried: ["stub"] },
          { kind: "easy", headline: "Take it easy.", why: "Nothing logged yet.", signals: {} },
          date
        ),
    },
    {
      code: "completion_fact_preserved",
      run: (date) =>
        enforceCompletionContract(
          { kind: "easy", headline: "Take it easy.", why: "Broad context.", agent: "stub", tried: ["stub"] },
          { kind: "done", headline: "You're done for today.", why: "That session is in the books.", signals: {} },
          date
        ),
    },
    {
      code: "deterministic_safety_floor",
      run: (date) =>
        enforceDayReadSafetyPosture(
          { kind: "train", headline: "Good to train.", why: "Go get it.", agent: "stub", tried: ["stub"] },
          { kind: "rest", headline: "Rest today.", why: "Several loading days back to back.", signals: {} },
          false,
          date
        ),
    },
    {
      code: "recovery_week_reduced_train_after_non_loading_day",
      run: (date) =>
        enforceRecoveryWeekCadence(
          { kind: "easy", headline: "Take it easy.", why: "Broad context.", agent: "stub", tried: ["stub"] },
          {
            kind: "train",
            headline: "Reduced lower body.",
            focus: "Lower body",
            why: "Use the reduced prescription.",
            est_minutes: 45,
            signals: {
              recovery_week: { state: "applied", applied_on: dayBefore(date, 3), until: dayBefore(date, -4) },
              recent_load: [{ date: dayBefore(date, 1), load: "easy" }],
            },
          },
          false,
          date
        ),
    },
  ];

  for (const { code, run } of scenarios) {
    const variants = DAY_READ_POLICY_REASON_VARIANTS[code];
    assert.ok(Array.isArray(variants) && variants.length >= 3, `${code} needs several phrasings`);

    const first = run(REF);
    assert.equal(first.decision.rule_code, code, `${code}: scenario fixture fired the wrong clamp`);
    const again = run(REF);
    assert.equal(again.decision.reason, first.decision.reason, `${code}: same day must not re-roll`);

    const seen = [];
    for (let back = 6; back >= 0; back--) {
      const date = dayBefore(REF, back);
      const result = run(date);
      assert.ok(
        variants.includes(result.decision.reason),
        `${code} ${date}: unexpected reason ${JSON.stringify(result.decision.reason)}`
      );
      seen.push({ date, reason: result.decision.reason });
    }
    for (let i = 1; i < seen.length; i++) {
      assert.notEqual(seen[i].reason, seen[i - 1].reason, `${code}: ${seen[i].date} repeated ${seen[i - 1].date}`);
    }
    assert.ok(new Set(seen.map((s) => s.reason)).size >= 3, `${code}: seven days must not cycle through one or two`);
  }
});

// The same plain-language contract as every athlete-facing `why` (VISION.md
// Amendment 2), applied to the server-policy `reason` vocabulary — the Brief renders
// decision.reason whenever it's non-empty, so it holds the same line.
test("every server-policy reason reads as calm plain language", () => {
  for (const [code, variants] of Object.entries(DAY_READ_POLICY_REASON_VARIANTS)) {
    assert.equal(new Set(variants).size, variants.length, `${code} has a duplicate phrasing`);
    for (const sentence of variants) {
      const label = `${code}: ${JSON.stringify(sentence)}`;
      assert.ok(sentence.length > 10, `${label} needs a real sentence`);
      assert.match(sentence, /[.!?]$/, `${label} should read as a finished sentence`);
      holdsTheConstitution(sentence, label);
    }
  }
});

// The same plain-language contract every other why-variant set holds to (VISION.md
// Amendment 2), applied directly since this set lives outside DAY_READ_WHY_VARIANTS
// (it's a server-policy clamp in dayread.ts, not one of dayRead()'s own rules).
test("the recovery-week softening variants read as calm plain language, distinct in shape", () => {
  assert.ok(RECOVERY_WEEK_SOFTEN_WHY.length >= 3, "needs several genuinely different phrasings");
  assert.equal(new Set(RECOVERY_WEEK_SOFTEN_WHY).size, RECOVERY_WEEK_SOFTEN_WHY.length, "no duplicate phrasing");
  for (const sentence of RECOVERY_WEEK_SOFTEN_WHY) {
    assert.ok(sentence.length > 10, `needs a real sentence, got ${JSON.stringify(sentence)}`);
    assert.match(sentence, /[.!?]$/, "should read as a finished sentence");
    holdsTheConstitution(sentence, "recovery-week softening");
  }
});

test("agent est_minutes is banded around the deterministic floor, not stored raw", async () => {
  const { clampAgentEstMinutes } = await import("../dist/dayread.js");

  // The compressed commitment day: floor 40, agent 90 is outside the band.
  assert.equal(clampAgentEstMinutes(90, 40, "train", "train"), 40);
  assert.equal(clampAgentEstMinutes(0, 40, "train", "train"), 40);
  assert.equal(clampAgentEstMinutes(-10, 40, "train", "train"), 40);
  assert.equal(clampAgentEstMinutes(null, 40, "train", "train"), 40);
  // Inside the band the agent's number is kept — an exact pin would make every
  // agentic read indistinguishable from the floor.
  assert.equal(clampAgentEstMinutes(45, 40, "train", "train"), 45);
  assert.equal(clampAgentEstMinutes(55, 60, "train", "train"), 55);
  // A conservative kind change keeps its own clock.
  assert.equal(clampAgentEstMinutes(20, 40, "easy", "train"), 20);
  assert.equal(clampAgentEstMinutes(90, 40, "rest", "train"), null);
  // Kind-mismatch still has an absolute band — 300-minute "easy" must not bypass.
  assert.equal(clampAgentEstMinutes(300, 40, "easy", "train"), 120);
  assert.equal(clampAgentEstMinutes(-10, 40, "easy", "train"), 40);
});

test("Today agent-result validation rejects parseable off-contract JSON", async () => {
  const { isValidDayReadAgentResult } = await import("../dist/dayread.js");

  assert.equal(isValidDayReadAgentResult({ kind: "rest", why: "Three loading days in a row." }), true);
  assert.equal(isValidDayReadAgentResult({ summary: "Rest today" }), false);
  assert.equal(isValidDayReadAgentResult({ kind: "rest", why: "" }), false);
  assert.equal(isValidDayReadAgentResult({ kind: "pause", why: "Take it easy." }), false);
  assert.equal(isValidDayReadAgentResult({ kind: "easy", why: "Keep it light.", est_minutes: "soon" }), false);
  assert.equal(
    isValidDayReadAgentResult({ kind: "done", why: "Your walk is in." }, { kind: "rest" }),
    false,
    "an easy activity cannot be promoted to completed training by the prose layer"
  );
  assert.equal(
    isValidDayReadAgentResult({ kind: "rest", why: "Recover." }, { kind: "done" }),
    false,
    "a completed training fact cannot be downgraded by the prose layer"
  );
  assert.equal(isValidDayReadAgentResult({ kind: "done", why: "Session logged." }, { kind: "done" }), true);
});

test("completed-load prose consistency rejects understatement but permits future easy advice", async () => {
  const { dayReadProseConsistencyIssue, isValidDayReadAgentResult } = await import("../dist/dayread.js");
  const baseline = {
    kind: "done",
    signals: { trained_today: true, today_load: "moderate" },
  };
  const contradiction = {
    kind: "done",
    headline: "Run complete.",
    why: "That run keeps your easy rhythm ticking along.",
  };
  const futureEasy = {
    kind: "done",
    headline: "Tempo work complete.",
    why: "That run was a solid moderate effort. Keep tomorrow's run easy so it can settle.",
  };

  assert.deepEqual(dayReadProseConsistencyIssue(contradiction, baseline.signals), {
    code: "completed_load_understated",
    classified_load: "moderate",
    evidence: contradiction.why,
  });
  assert.equal(isValidDayReadAgentResult(contradiction, baseline), false);
  assert.equal(dayReadProseConsistencyIssue(futureEasy, baseline.signals), null);
  assert.equal(isValidDayReadAgentResult(futureEasy, baseline), true);
});

// ---------- decision reasons: no parallel map, therefore no drift ----------
// The reason used to live in a `DECISION_REASONS` map in day-read.ts, keyed by
// the rule name with a `?? "Cairn's deterministic day policy selected this
// posture."` fallback — so the endurance volume-spike rule (added later, never
// added to the map) shipped engineering prose to the athlete. The reason now
// rides on the outcome the rule returns; these cases pin that contract.
// Every sentence the deterministic floor can say to the athlete, in both registers:
// the ledger `reason` on the outcome, and the read's own `why`. The wave-1 guarantee
// was "a rule cannot reach the athlete without words"; with several phrasings per
// rule it becomes "and every one of them holds the line".
function everyAthleteFacingSentence() {
  const rows = [];
  const outcomes = [...Object.entries(DAY_READ_OUTCOMES), ["unprogrammed_easy_day", UNPROGRAMMED_EASY_DAY]];
  for (const [key, outcome] of outcomes) {
    for (const reason of outcome.reasons) rows.push({ code: outcome.code, key, register: "reason", text: reason });
  }
  for (const [code, variants] of Object.entries(DAY_READ_WHY_VARIANTS)) {
    for (const why of variants) rows.push({ code, key: code, register: "why", text: why });
  }
  return rows;
}

test("every day-read outcome carries its own plain-language reasons", () => {
  const outcomes = [...Object.entries(DAY_READ_OUTCOMES), ["unprogrammed_easy_day", UNPROGRAMMED_EASY_DAY]];
  const codes = new Set();
  for (const [key, outcome] of outcomes) {
    assert.equal(outcome.code, key, `${key}: the table key IS the ledger code`);
    assert.equal(codes.has(outcome.code), false, `${key}: duplicate ledger code`);
    codes.add(outcome.code);
    // A stable input fires a stable rule, so one literal per rule printed the same
    // sentence to the athlete indefinitely. Each outcome now owns SEVERAL calm
    // phrasings of the same judgement. (The non-empty tuple type gets "at least one"
    // at compile time; this is the rest of the contract.)
    assert.ok(Array.isArray(outcome.reasons) && outcome.reasons.length >= 3, `${key} needs several phrasings`);
    assert.equal(new Set(outcome.reasons).size, outcome.reasons.length, `${key} has a duplicate phrasing`);
  }
  assert.equal(codes.size, outcomes.length);
});

// The constitution guards themselves. These used to be four regexes declared HERE, a
// third definition of a grammar that also lived in the day-read prompt and — nowhere
// at all — over the agent's own sentence. They now come from the source
// (violatesReadingGrammar), so the deterministic vocabulary below and the agent's
// headline/`why` in isValidDayReadAgentResult are held to ONE definition, and a rule
// added to it is instantly enforced on both registers.
const holdsTheConstitution = (text, label) => {
  const violated = violatesReadingGrammar(text);
  assert.equal(violated, null, `${label} breaks the reading grammar (${violated}): ${JSON.stringify(text)}`);
};

test("every phrasing of every rule reads as calm plain language, in both registers", () => {
  const sentences = everyAthleteFacingSentence();
  assert.ok(sentences.length >= 60, "the whole vocabulary is under test");
  for (const { key, register, text } of sentences) {
    const label = `${key} (${register})`;
    const sentence = String(text || "").trim();
    assert.ok(sentence.length > 10, `${label} needs a real sentence, got ${JSON.stringify(sentence)}`);
    assert.match(sentence, /[.!?]$/, `${label} should read as a finished sentence`);
    holdsTheConstitution(sentence, label);
  }
});

test("every phrasing carries the meaning its rule exists to convey", () => {
  // The drift guard. A single-literal case pinned semantics by accident; with several
  // variants the requirement has to be explicit, and it lives in the source next to
  // the prose (DAY_READ_REQUIRED_CONCEPT) so a new phrasing cannot quietly drop it.
  const declared = new Set(Object.keys(DAY_READ_REQUIRED_CONCEPT));
  for (const { code } of everyAthleteFacingSentence()) {
    assert.ok(declared.has(code), `${code} has no declared concept — every rule must say what it is about`);
  }
  for (const { key, register, text } of everyAthleteFacingSentence()) {
    assert.match(text, DAY_READ_REQUIRED_CONCEPT[key], `${key} (${register}) lost the rule's own meaning`);
  }
});

// ---------- the planned-training caveats: fragments, held to the same line ----------
// The planned-training rule fires on most mornings and composes its `why` from a lead
// plus a run of lowercase fragments. The leads rotated from the start; every fragment
// was a single hardcoded string, so a chronic short sleeper or anyone inside a recovery
// week read the identical clause every morning — the exact repetition this layer
// exists to remove. These hold the caveat vocabulary to the same standard as the `why`
// vocabulary, plus the two shape rules that come from being spliced mid-sentence.
test("every planned-training caveat is a calm lowercase fragment, several per set", () => {
  const sets = Object.entries(DAY_READ_CAVEAT_VARIANTS);
  assert.ok(sets.length >= 8, "the whole caveat vocabulary is under test");
  for (const [key, variants] of sets) {
    assert.ok(Array.isArray(variants) && variants.length >= 3, `${key} needs several phrasings`);
    assert.equal(new Set(variants).size, variants.length, `${key} has a duplicate phrasing`);
    for (const text of variants) {
      const fragment = String(text || "");
      assert.ok(fragment.length > 10, `${key} needs a real fragment, got ${JSON.stringify(fragment)}`);
      assert.equal(fragment, fragment.trim(), `${key} carries stray whitespace into the sentence`);
      // Spliced after "<lead> — " and joined with "; and ", so a leading capital or a
      // terminal stop would break the one sentence they all land inside.
      assert.match(fragment, /^[a-z]/, `${key} must start lowercase — it is spliced mid-sentence`);
      assert.doesNotMatch(fragment, /[.!?]$/, `${key} must not end a sentence it sits inside`);
      // The lead already ends with " — ", so a caveat carrying its own em-dash puts two
      // in one sentence ("You're good to train — you've got a sore knee to work around —
      // train around it…"). Use ", so" / ", since" instead. One shipped variant did this.
      assert.doesNotMatch(fragment, /—/, `${key} must not add a second em-dash to the lead's`);
      holdsTheConstitution(fragment, key);
    }
  }
});

test("every planned-training caveat carries the idea it exists to convey", () => {
  assert.deepEqual(
    Object.keys(DAY_READ_CAVEAT_CONCEPT).sort(),
    Object.keys(DAY_READ_CAVEAT_VARIANTS).sort(),
    "every caveat set declares exactly one concept, and every concept has a set"
  );
  for (const [key, variants] of Object.entries(DAY_READ_CAVEAT_VARIANTS)) {
    for (const text of variants) {
      assert.match(text, DAY_READ_CAVEAT_CONCEPT[key], `${key} lost the caveat's own meaning`);
    }
  }
});

// Balanced-paren scan of the argument to every `caveats.push(...)` in the rule. A
// NINTH caveat added later as a bare literal has to fail HERE rather than slip through
// unregistered — which is precisely how all eight of these came to be literals.
function caveatPushArguments(src) {
  const marker = "caveats.push(";
  const args = [];
  let at = src.indexOf(marker);
  while (at !== -1) {
    let depth = 1;
    let i = at + marker.length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    args.push(
      src
        .slice(at + marker.length, i - 1)
        .replace(/\s+/g, " ")
        .trim()
    );
    at = src.indexOf(marker, i);
  }
  return args;
}

test("every caveat the planned-training rule pushes rotates through a registered set", () => {
  const src = fs.readFileSync(path.join(repoRoot, "src", "repo", "day-read.ts"), "utf8");
  const pushed = caveatPushArguments(src);
  assert.ok(pushed.length >= 8, `expected the rule's caveat pushes, found ${pushed.length}`);

  // The one dynamic caveat: the adaptive plan-selection reason, composed elsewhere
  // (plan-selection.ts selectionReason) rather than authored here.
  const dynamic = "String(sd.selection.reason)";
  const seen = new Set();
  for (const arg of pushed) {
    if (arg === dynamic) continue;
    const keys = [...arg.matchAll(/"(planned_training:[a-z_]+)"/g)].map((match) => match[1]);
    assert.ok(keys.length > 0, `caveats.push(${arg}) is a literal — every caveat must rotate through a variant set`);
    for (const key of keys) {
      assert.ok(key in DAY_READ_CAVEAT_VARIANTS, `${key} is pushed but not registered in DAY_READ_CAVEAT_VARIANTS`);
      seen.add(key);
    }
    // A rotation key alongside a hardcoded fragment would pass the check above while
    // still printing one literal. Prose is long; the short literals that legitimately
    // appear here are fallback subjects like "an injury", not caveats.
    for (const [, literal] of arg.matchAll(/"([^"]*)"/g)) {
      assert.ok(
        literal.startsWith("planned_training:") || literal.length <= 24,
        `caveats.push(${arg}) still carries a hardcoded fragment: ${JSON.stringify(literal)}`
      );
    }
  }
  assert.deepEqual(
    [...seen].sort(),
    Object.keys(DAY_READ_CAVEAT_VARIANTS).sort(),
    "every registered caveat set is actually reachable from the rule"
  );
});

// ---------- the LEADS: the third register, previously unregistered ----------
// A composed planned-training `why` is "<lead> — <fragment>; and <fragment>." The
// fragments were registered; the two LEADS were not, and they fit neither existing
// registry — they open with a capital (they open the sentence) and carry no terminal
// punctuation (a caveat run follows). So nothing held them to the constitution and a
// new lead phrasing could skip it entirely.
test("every planned-training lead is a calm capitalised opener, several per set", () => {
  const sets = Object.entries(DAY_READ_LEAD_VARIANTS);
  assert.deepEqual(
    Object.keys(DAY_READ_LEAD_VARIANTS).sort(),
    [
      // the green-light lead, and the hold lead…
      "planned_training:caveats",
      "planned_training:hold_lead",
      // …plus the two the 2026-08-17 rebalance added: the lead for a caution that is
      // real but unseconded, and the lead for a backed day carrying only bookkeeping.
      "planned_training:noted_lead",
      "planned_training:push_caveats",
    ].sort()
  );
  for (const [key, variants] of sets) {
    assert.ok(Array.isArray(variants) && variants.length >= 3, `${key} needs several phrasings`);
    assert.equal(new Set(variants).size, variants.length, `${key} has a duplicate phrasing`);
    for (const text of variants) {
      const lead = String(text || "");
      assert.ok(lead.length > 10, `${key} needs a real opener, got ${JSON.stringify(lead)}`);
      assert.equal(lead, lead.trim(), `${key} carries stray whitespace into the sentence`);
      // It OPENS the sentence, so it capitalises...
      assert.match(lead, /^[A-Z]/, `${key} must open the sentence with a capital`);
      // ...and the " — <caveats>." run closes it, so the lead must not.
      assert.doesNotMatch(lead, /[.!?]$/, `${key} must not close the sentence its caveats finish`);
      // The composition already supplies the em-dash after the lead.
      assert.doesNotMatch(lead, /—/, `${key} must not add a second em-dash`);
      holdsTheConstitution(lead, key);
    }
  }
});

test("every planned-training lead carries the idea it exists to convey", () => {
  assert.deepEqual(
    Object.keys(DAY_READ_LEAD_CONCEPT).sort(),
    Object.keys(DAY_READ_LEAD_VARIANTS).sort(),
    "every lead set declares exactly one concept, and every concept has a set"
  );
  for (const [key, variants] of Object.entries(DAY_READ_LEAD_VARIANTS)) {
    for (const text of variants) assert.match(text, DAY_READ_LEAD_CONCEPT[key], `${key} lost the lead's own meaning`);
  }
});

// The same drift guard the caveat pushes get: a rotation key that reaches the athlete
// through this rule has to be REGISTERED somewhere, so a new lead or fragment cannot
// be introduced as a bare literal with a key nobody tests.
test("every planned-training rotation key in the source is registered", () => {
  const src = fs.readFileSync(path.join(repoRoot, "src", "repo", "day-read.ts"), "utf8");
  const registered = new Set([
    ...Object.keys(DAY_READ_CAVEAT_VARIANTS),
    ...Object.keys(DAY_READ_LEAD_VARIANTS),
    ...Object.keys(DAY_READ_EARN_PATH_VARIANTS),
    // The brake's own spoken sentence rotates through the signal-voice registry, which
    // has its own guards (and its own entries in DAY_READ_WHY_VARIANTS). `noted` is the
    // same sentence on the unseconded-caution branch.
    "planned_training:hold",
    "planned_training:noted",
  ]);
  const used = new Set([...src.matchAll(/"(planned_training:[a-z_]+)"/g)].map((match) => match[1]));
  assert.ok(used.size >= 10, `expected the rule's rotation keys, found ${used.size}`);
  for (const key of used) assert.ok(registered.has(key), `${key} rotates in the source but is registered nowhere`);
});

// A recovery week always pushes its own caveat, so the planned-training `why` chain's
// third arm (`recoveryWeek ? RECOVERY_WEEK_TRAIN_WHY : …`) sat BELOW `caveats.length`
// and could never be reached — while the sentence a reduced week actually printed was
// registered nowhere. The dead arm is retired; this pins what that day really says.
test("a recovery-week train day speaks through the registered lead and caveat", () => {
  resetTables("proposals", "app_state");
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const appliedOn = dayBefore(REF, 2);
  const proposal = repo.createProposal("stub", repo.RECOVERY_WEEK_INSTRUCTION, "", {
    summary: "Reduced recovery prescription.",
    days: repo.getPlan(),
  });
  repo.setProposalStatus(proposal.id, "applied");
  repo.setAppState("recovery_week_applied", JSON.stringify({ applied_on: appliedOn, proposal_id: proposal.id }));

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });

  assert.equal(r.kind, "train");
  assert.equal(r.decision.rule_code, "planned_reduced_training");
  const lead = DAY_READ_LEAD_VARIANTS["planned_training:caveats"].find((variant) => r.why.startsWith(variant));
  assert.ok(lead, `a registered lead must open the read, got ${JSON.stringify(r.why)}`);
  saysOneCaveat(r.why, "planned_training:recovery_week");
  // The retired set is gone from the vocabulary too — a registered phrasing nobody can
  // reach is worse than no entry, because the guards then vouch for dead prose.
  assert.equal(
    DAY_READ_WHY_VARIANTS.planned_reduced_training,
    undefined,
    "the unreachable recovery-week why set must not stay registered"
  );
  // ...but the rule's ledger reasons still exist, and still declare their concept.
  assert.ok(DAY_READ_OUTCOMES.planned_reduced_training.reasons.includes(r.decision.reason));
});

// ---------- the general guarantee behind the work-around probe ----------
// A constraint in `health_constraints` is a safety_override: it changes the posture,
// the training directive, or both. Whichever field carries it and whichever route it
// arrives by, the athlete has to be TOLD — a day that gets quietly modified and then
// explained as "you're recovered and due" is worse than a day that says nothing.
//
// The probe used to match `field === "active_injury"`, a CONTEXT-EVENT field, and every
// other constraint fell through it: an illness lost its guidance to the quiet-streak
// escalation, and session-reported joint pain — which flips the read to
// `training: "modify"` — was never spoken at all. Matching on the DIMENSION is what
// closes the class rather than the two instances; this case is what keeps a fifth field
// from silently reopening it.
function logJointPain(areas, on) {
  const day = repo.getPlanDay(1);
  const ex = repo.findExercise("Squat") ?? repo.upsertExercise({ name: "Squat", muscle_group: "quads" });
  const session = repo.getOrCreateSession(on, day.id);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 185, 5, 2)`
  ).run(session.id, ex.id);
  repo.setSessionFeedback(on, { joint_pain: areas });
}

test("a health constraint that changes the day is always spoken, whatever its source", () => {
  const scenarios = [
    {
      label: "context event · injury",
      field: "active_injury",
      names: /shoulder strain/i,
      seed: (date) =>
        repo.addContextEvent({
          kind: "injury",
          title: "Shoulder strain",
          detail: "Overhead loading aggravates it",
          start_date: date,
        }),
    },
    {
      label: "context event · illness",
      field: "illness",
      names: /head cold/i,
      seed: (date) => repo.addContextEvent({ kind: "illness", title: "Head cold", start_date: date }),
    },
    {
      // The route the context path cannot see. It reaches the read through
      // trainingSignals.autoregulation, so `reduceItem` is null and every caveat the
      // rule knew how to push was keyed on a context event.
      label: "session feedback · joint pain",
      field: "joint_pain",
      names: /left knee/i,
      seed: (date) => logJointPain("left knee", dayBefore(date, 3)),
    },
  ];

  for (const { label, field, names, seed } of scenarios) {
    resetTables("logged_sets", "sessions", "plan_items", "plan_days", "checkins", "activities", "context_events");
    repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
    seed(REF);

    const r = repo.dayRead(REF, { has_data: false, recovery: {} });
    const state = r.signals.signal_state;

    // The constraint really did change the day...
    assert.equal(state.dimensions.health_constraints.status, "constrained", `${label}: not a constraint`);
    assert.notEqual(state.action.directives.training, "proceed", `${label}: the day was not actually modified`);
    // ...the probe saw it, by whichever field carries it...
    assert.equal(r.signals.health_workaround.field, field, `${label}: the work-around probe missed it`);
    // ...and the athlete is told what today is modified FOR.
    assert.match(r.why, names, `${label}: the day changed silently — ${JSON.stringify(r.why)}`);
    // The specific regression: a constrained day must never read as an unqualified
    // green light. That is what a joint-pain train day printed.
    for (const clear of DAY_READ_WHY_VARIANTS.planned_training) {
      assert.equal(r.why.includes(clear), false, `${label}: a constrained day read as clear — ${clear}`);
    }
  }
});

// The joint-pain fragment is its own set rather than INJURY_CAVEAT reused: an injury is
// a NAMED condition from a context event ("a sore left knee"), joint pain is a bare list
// of areas from session feedback ("left knee"), and forcing one phrasing over both
// produced "you've got left knee to work around" — a noun phrase missing its article.
test("session-reported joint pain is voiced as a pain-free substitution, naming the areas", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  logJointPain("left knee", dayBefore(REF, 3));

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });

  assert.equal(r.kind, "train", "a work-around is a caveat on the session, never a reason to withhold it");
  assert.equal(r.decision.rule_code, "planned_training");
  const landed = saysOneCaveat(r.why, "planned_training:joint_pain");
  assert.match(landed, /left knee/, "the caveat must name the sore areas, not gesture at them");
  // It composes like every other caveat: one lead, one sentence, one full stop.
  assert.ok(
    DAY_READ_LEAD_VARIANTS["planned_training:caveats"].some((lead) => r.why.startsWith(lead)),
    `a registered lead must open the read, got ${JSON.stringify(r.why)}`
  );
  assert.match(r.why, /\.$/);
  assert.doesNotMatch(r.why, /\.\.|\s;|;\s*and\s*[A-Z]|—\s*[A-Z]/, `broken sentence: ${JSON.stringify(r.why)}`);
  // Several areas arrive joined, so no phrasing may carry a verb that agrees with one.
  resetTables("logged_sets", "sessions");
  logJointPain("left knee, right shoulder", dayBefore(REF, 2));
  const many = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.match(many.why, /left knee, right shoulder/);
});

// ---------- the reading grammar: ONE definition, both registers ----------
// Every phrasing the deterministic floor can say, in every register, rendered with the
// real arguments each templated set takes. This is the proof set for the predicate:
// it is the prose the product has shipped and reviewed, so a predicate that rejects
// ANY of it is too strict to put in front of the agent.
function everyRegisteredPhrasing() {
  const rows = [];
  const push = (source, texts) => {
    for (const text of texts) rows.push({ source, text });
  };
  for (const [code, variants] of Object.entries(DAY_READ_WHY_VARIANTS)) push(`why:${code}`, variants);
  for (const [key, variants] of Object.entries(DAY_READ_CAVEAT_VARIANTS)) push(`caveat:${key}`, variants);
  for (const [key, variants] of Object.entries(DAY_READ_LEAD_VARIANTS)) push(`lead:${key}`, variants);
  for (const [code, variants] of Object.entries(DAY_READ_POLICY_REASON_VARIANTS)) push(`reason:${code}`, variants);
  for (const [kind, variants] of Object.entries(DAY_READ_HEADLINE_VARIANTS)) push(`headline:${kind}`, variants);
  push("headline:train_focus", DAY_READ_FOCUS_HEADLINE_VARIANTS);
  push("headline:train_drive", DAY_READ_DRIVE_HEADLINE_VARIANTS);
  push("headline:train_focus_drive", DAY_READ_DRIVE_FOCUS_HEADLINE_VARIANTS);
  push("recovery_week_soften_why", RECOVERY_WEEK_SOFTEN_WHY);
  for (const [key, outcome] of [...Object.entries(DAY_READ_OUTCOMES), ["unprogrammed_easy_day", UNPROGRAMMED_EASY_DAY]])
    push(`outcome:${key}`, outcome.reasons);
  for (const [key, entry] of Object.entries(SIGNAL_VOICE_REGISTRY)) push(`voice:${key}`, entry.variants);
  // The templated sets, rendered across every argument they can actually take.
  for (let n = 3; n <= 8; n++) {
    push(
      `quiet_streak:${n}`,
      QUIET_STREAK_WHY.map((render) => render(quietOrdinal(n)))
    );
    push(
      `quiet_streak_guarded:${n}`,
      QUIET_STREAK_GUARDED_WHY.map((render) => render(quietOrdinal(n)))
    );
  }
  for (const groups of ["back", "quads and back"]) {
    push(
      `push_drive:${groups}`,
      PUSH_DRIVE_WHY.map((render) => render(groups))
    );
  }
  push(
    "quiet_streak:fallback",
    [...QUIET_STREAK_WHY, ...QUIET_STREAK_GUARDED_WHY].map((render) => render(quietOrdinal(99)))
  );
  // And the COMPOSED planned-training sentence, which is where a lead, several
  // fragments and a spoken brake all land inside one string.
  for (const [key, variants] of Object.entries(DAY_READ_CAVEAT_VARIANTS)) {
    for (const lead of DAY_READ_LEAD_VARIANTS["planned_training:caveats"]) {
      push(`composed:${key}`, [`${lead} — ${variants.join("; and ")}.`]);
    }
  }
  return rows;
}

test("the reading grammar rejects NOTHING the deterministic floor already says", () => {
  const rows = everyRegisteredPhrasing();
  assert.ok(rows.length >= 200, `the whole vocabulary is under test, got ${rows.length}`);
  const rejected = rows
    .map(({ source, text }) => ({ source, text, rule: violatesReadingGrammar(text) }))
    .filter((row) => row.rule);
  assert.deepEqual(rejected, [], "the predicate the agent is held to must accept every shipped phrasing");
});

test("the reading grammar also clears every sentence the live floor composes", () => {
  // The registries are the authored vocabulary; these are the strings dayRead actually
  // assembles from them, subject substitution and all.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.addContextEvent({
    kind: "injury",
    title: "Shoulder strain",
    detail: "Overhead loading aggravates it",
    start_date: REF,
  });
  const reads = [
    repo.dayRead(REF, { has_data: false, recovery: {} }),
    repo.dayRead(REF, sleepMean(300)),
    repo.dayRead(dayBefore(REF, 1), { has_data: true, recovery: { training_readiness: 20 } }),
  ];
  for (const read of reads) {
    assert.equal(violatesReadingGrammar(read.why), null, `live why broke the grammar: ${JSON.stringify(read.why)}`);
    assert.equal(violatesReadingGrammar(read.decision.reason), null, `live reason: ${read.decision.reason}`);
    assert.equal(violatesReadingGrammar(dayReadHeadline(read, REF)), null, "live headline");
  }
});

// The whole point: the guard used to cover the layer that CANNOT violate the
// constitution and was withheld from the layer that can. The agent's sentence is what
// the athlete reads on most mornings, and it went to the Brief unchecked.
test("the agent's prose is held to the same constitution as the floor", async () => {
  const { isValidDayReadAgentResult } = await import("../dist/dayread.js");
  const baseline = { kind: "train", signals: { today_load: "none", trained_today: false } };

  // The exact payload that used to validate and render verbatim as the Brief's
  // headline and `why`: a 0-100 score and a hard gate, both explicitly forbidden.
  assert.equal(
    isValidDayReadAgentResult(
      {
        kind: "rest",
        headline: "Readiness 38/100 — rest.",
        why: "Your recovery score is 38/100, so you must not train today. Do not lift.",
      },
      baseline
    ),
    false
  );

  // Each rule, in each of the two fields the athlete reads.
  const violations = [
    "Your readiness signal came in low today.",
    "You scored 42% on recovery this morning.",
    "You must sit today out.",
    "Do not train today.",
    "The deterministic baseline selected a rest posture.",
  ];
  for (const text of violations) {
    assert.equal(isValidDayReadAgentResult({ kind: "rest", why: text }, baseline), false, `why: ${text}`);
    assert.equal(
      isValidDayReadAgentResult({ kind: "rest", headline: text, why: "Rest is the kinder call today." }, baseline),
      false,
      `headline: ${text}`
    );
  }

  // ...and calm, compliant prose still passes, in both fields.
  assert.equal(
    isValidDayReadAgentResult(
      {
        kind: "rest",
        headline: "Rest today.",
        why: "You've stacked three real training days — let today consolidate.",
      },
      baseline
    ),
    true
  );
});

// The "score" rule's "%" branch used to fire on ANY digit+percent, so a factual
// percentage of a real, named quantity ("you're at 80% of your protein target")
// broke the grammar right alongside an actual grade ("Readiness 38%."). The fix
// excuses only "N% of <thing>" — a fraction of a stated quantity — and keeps
// catching a bare or dangling percentage, "/100", "N points", and "N score(s)".
// Both directions are pinned here so a future edit cannot silently widen or
// narrow the carve-out without a test noticing.
test("the score rule still rejects every grade-like construction", () => {
  const mustReject = [
    "Readiness 38/100 — rest.",
    "Your recovery score is 38/100, so ease off today.",
    "You scored 42% on recovery this morning.",
    "Recovery is at 65% today.",
    "42% readiness this morning.",
    "You earned 85 points today.",
    "A 42 score this morning, so take it easy.",
    "That's an 85/100 morning.",
  ];
  for (const text of mustReject) {
    assert.equal(violatesReadingGrammar(text), "score", `should reject as score-like: ${JSON.stringify(text)}`);
  }
});

test("the score rule passes a factual percentage of a real, named quantity", () => {
  const mustPass = [
    "You're at 80% of your protein target.",
    "You hit 92% of your goal calories yesterday.",
    "That's 60% of planned volume banked this week.",
    "Fiber lands around 75% of the daily target most days.",
    "You're already at 100% of your protein target for today.",
  ];
  for (const text of mustPass) {
    assert.equal(violatesReadingGrammar(text), null, `should pass as a real quantity: ${JSON.stringify(text)}`);
  }
});

// ---------- the headline: the most prominent string, previously a literal ----------
test("every headline phrasing reads as a calm finished sentence, several per kind", () => {
  const kinds = Object.keys(DAY_READ_HEADLINE_VARIANTS).sort();
  assert.deepEqual(kinds, ["done", "easy", "rest", "train"], "every read kind owns a headline set");
  assert.deepEqual(Object.keys(DAY_READ_HEADLINE_CONCEPT).sort(), kinds, "and declares exactly one concept");
  for (const [kind, variants] of Object.entries(DAY_READ_HEADLINE_VARIANTS)) {
    assert.ok(variants.length >= 3, `${kind} needs several phrasings`);
    assert.equal(new Set(variants).size, variants.length, `${kind} has a duplicate phrasing`);
    for (const text of variants) {
      assert.ok(text.length > 10, `${kind} needs a real sentence, got ${JSON.stringify(text)}`);
      assert.match(text, /^[A-Z]/, `${kind} should open as a sentence: ${JSON.stringify(text)}`);
      assert.match(text, /[.!?]$/, `${kind} should read as a finished sentence: ${JSON.stringify(text)}`);
      assert.match(text, DAY_READ_HEADLINE_CONCEPT[kind], `${kind} lost the kind's own meaning`);
      holdsTheConstitution(text, `headline:${kind}`);
    }
  }
  // The train-with-focus form is its own set: the focus IS the headline, so every
  // phrasing has to still name it (and still close as a sentence).
  assert.ok(DAY_READ_FOCUS_HEADLINE_VARIANTS.length >= 3, "the focus form needs several phrasings");
  for (const text of DAY_READ_FOCUS_HEADLINE_VARIANTS) {
    assert.match(text, /Lower body/, `the focus form must name the focus: ${JSON.stringify(text)}`);
    assert.match(text, /[.!?]$/, "the focus form should read as a finished sentence");
    holdsTheConstitution(text, "headline:train_focus");
  }
  // The training-drive read is a third flavour of `train` and owns its own two forms —
  // held to the same shape rules, and required to read as a NARROWER day rather than as
  // the backed day's invitation to reach for more.
  assert.ok(DAY_READ_DRIVE_HEADLINE_VARIANTS.length >= 3, "the drive form needs several phrasings");
  for (const text of DAY_READ_DRIVE_HEADLINE_VARIANTS) {
    assert.match(text, /^[A-Z]/, `the drive headline should open as a sentence: ${JSON.stringify(text)}`);
    assert.match(text, /[.!?]$/, "the drive headline should read as a finished sentence");
    holdsTheConstitution(text, "headline:train_drive");
  }
  for (const text of DAY_READ_DRIVE_FOCUS_HEADLINE_VARIANTS) {
    assert.match(text, /Lower body/, `the drive focus form must name the focus: ${JSON.stringify(text)}`);
    assert.match(text, /[.!?]$/, "the drive focus form should read as a finished sentence");
    holdsTheConstitution(text, "headline:train_focus_drive");
  }
});

test("the headline rotates day to day, stays stable per day, and keeps the focus form", () => {
  // Stable per day: todayBriefMateriallyDiffers compares `headline` to decide whether
  // to repaint, and the clamp paths rewrite it on EVERY call — a non-deterministic pick
  // would repaint the Brief on every poll.
  for (const kind of ["done", "rest", "easy", "train"]) {
    assert.equal(dayReadHeadline({ kind }, REF), dayReadHeadline({ kind }, REF), `${kind} re-rolled within a day`);
    const seen = [];
    for (let back = 6; back >= 0; back--) {
      const date = dayBefore(REF, back);
      const headline = dayReadHeadline({ kind }, date);
      assert.ok(DAY_READ_HEADLINE_VARIANTS[kind].includes(headline), `${kind} ${date}: ${JSON.stringify(headline)}`);
      seen.push({ date, headline });
    }
    for (let i = 1; i < seen.length; i++) {
      assert.notEqual(seen[i].headline, seen[i - 1].headline, `${kind}: ${seen[i].date} repeated ${seen[i - 1].date}`);
    }
    assert.ok(new Set(seen.map((s) => s.headline)).size >= 3, `${kind}: a week must not cycle through one or two`);
  }
  // A train day that knows its focus still leads with the focus, in every phrasing.
  for (let back = 3; back >= 0; back--) {
    const date = dayBefore(REF, back);
    assert.match(dayReadHeadline({ kind: "train", focus: "Lower body" }, date), /Lower body/);
  }
  // The plain train form is the fallback when no focus is known, and an unknown kind
  // degrades there too rather than to an empty headline.
  assert.ok(DAY_READ_HEADLINE_VARIANTS.train.includes(dayReadHeadline({ kind: "train", focus: "" }, REF)));
  assert.ok(DAY_READ_HEADLINE_VARIANTS.train.includes(dayReadHeadline({ kind: "unknown" }, REF)));
});

// Every server-policy clamp REWRITES the headline, and each can fire on consecutive
// days — the recovery-week softening clamp most of all, which is where the literal
// "Take it easy." sat directly above the `why` that had already been fixed for exactly
// this reason. Rotation has to survive the clamps, not just the pure helper.
test("the server-policy clamps write a rotating headline, never a literal", async () => {
  const { enforceDayReadSafetyPosture, enforceRecoveryWeekCadence, enforceCompletionContract } = await import(
    "../dist/dayread.js"
  );
  const agentRest = {
    kind: "rest",
    headline: "Rest today.",
    focus: null,
    why: "Broad context says keep resting.",
    est_minutes: null,
    source: "agent",
    agent: "stub",
  };
  const clamps = [
    {
      label: "deterministic_safety_floor",
      kind: "rest",
      run: (date) =>
        enforceDayReadSafetyPosture(
          { kind: "train", headline: "Good to train.", why: "Go get it.", agent: "stub" },
          { kind: "rest", focus: null, why: "Several loading days back to back.", signals: {} },
          false,
          date
        ),
    },
    {
      label: "recovery_week_rest_softened_to_easy_after_loading_day",
      kind: "easy",
      run: (date) =>
        enforceRecoveryWeekCadence(
          agentRest,
          {
            kind: "train",
            focus: "Lower body",
            why: "Use the reduced prescription.",
            est_minutes: 45,
            signals: {
              recovery_week: { state: "applied", applied_on: dayBefore(date, 3), until: dayBefore(date, -4) },
              recent_load: [{ date: dayBefore(date, 1), load: "moderate" }],
            },
          },
          false,
          date
        ),
    },
    {
      label: "completion_fact_preserved",
      kind: "done",
      run: (date) =>
        enforceCompletionContract(
          { kind: "easy", headline: "Take it easy.", why: "Broad context.", agent: "stub" },
          { kind: "done", focus: null, why: "That session is in the books.", signals: {} },
          date
        ),
    },
  ];

  for (const { label, kind, run } of clamps) {
    assert.equal(run(REF).headline, run(REF).headline, `${label}: same day must not re-roll`);
    const seen = [];
    for (let back = 6; back >= 0; back--) {
      const date = dayBefore(REF, back);
      const headline = run(date).headline;
      assert.ok(
        DAY_READ_HEADLINE_VARIANTS[kind].includes(headline),
        `${label} ${date}: unexpected headline ${JSON.stringify(headline)}`
      );
      seen.push({ date, headline });
    }
    for (let i = 1; i < seen.length; i++) {
      assert.notEqual(seen[i].headline, seen[i - 1].headline, `${label}: ${seen[i].date} repeated ${seen[i - 1].date}`);
    }
    assert.ok(new Set(seen.map((s) => s.headline)).size >= 3, `${label}: seven days must not cycle through one or two`);
  }
});

// The fifth athlete-facing `decision.reason` and the only one the rotation missed: it
// is written in computeDayRead's agent branch rather than by a policyDecision() clamp,
// so it kept its literal while every sibling moved into the map. The Brief renders it
// on exactly the rest/easy shape `conservative` can take.
test("the agent's conservative adjustment rotates like every other decision reason", async () => {
  const { dayReadPolicyReason } = await import("../dist/repo/day-read.js");
  const CODE = "agent_conservative_adjustment";
  const variants = DAY_READ_POLICY_REASON_VARIANTS[CODE];
  assert.ok(Array.isArray(variants) && variants.length >= 3, `${CODE} needs several phrasings`);

  assert.equal(dayReadPolicyReason(CODE, REF), dayReadPolicyReason(CODE, REF), "same day must not re-roll");
  const seen = [];
  for (let back = 6; back >= 0; back--) {
    const date = dayBefore(REF, back);
    const reason = dayReadPolicyReason(CODE, date);
    assert.ok(variants.includes(reason), `${date}: unexpected reason ${JSON.stringify(reason)}`);
    seen.push({ date, reason });
  }
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i].reason, seen[i - 1].reason, `${seen[i].date} repeated ${seen[i - 1].date}`);
  }
  assert.ok(new Set(seen.map((s) => s.reason)).size >= 3, "seven days must not cycle through one or two");
  // An unregistered code stays EMPTY — the Brief renders a reason only when there is a
  // specific one, and narrating internals is worse than saying nothing.
  assert.equal(dayReadPolicyReason("agent_day_read", REF), "");

  // ...and the agent branch reads it from the map rather than carrying its own literal.
  const src = fs.readFileSync(path.join(repoRoot, "src", "dayread.ts"), "utf8");
  assert.match(src, new RegExp(`reason: conservative \\? dayReadPolicyReason\\("${CODE}"`));
  for (const variant of variants) {
    assert.equal(src.includes(variant), false, `${CODE} is still hardcoded in dayread.ts: ${JSON.stringify(variant)}`);
  }
});

// ---------- the unified protect path: the dominant rest read ----------
// A check-in with low felt sleep or high soreness is a safety override, so the protect
// posture — not any of the rules above — decides most rest/easy mornings. It used to
// assign the winning evidence's machine-facing `summary` to the Brief's headline: the
// third person, about the athlete, in ONE literal per signal, printed verbatim for as
// long as the input held. These pin the second vocabulary that replaced it.
test("every athlete-facing phrasing of the signal state speaks to the athlete, not about them", () => {
  const rows = Object.entries(SIGNAL_VOICE_REGISTRY).flatMap(([key, entry]) =>
    entry.variants.map((text) => ({ key, text }))
  );
  assert.ok(rows.length >= 60, "the whole signal vocabulary is under test");
  for (const { key, text } of rows) {
    assert.doesNotMatch(text, /\bthe athlete\b/i, `${key} talks about the athlete instead of to them`);
    assert.doesNotMatch(text, /\bthey (?:feel|felt|report|reports)\b/i, `${key} reads as an observer's note`);
    // Every one of them is also registered in DAY_READ_WHY_VARIANTS, so the plain
    // language / no-score / no-gate guards above already cover this path.
    assert.ok(
      (DAY_READ_WHY_VARIANTS[`acute_signal_protection:${key}`] ?? []).includes(text),
      `${key} is not registered with the rest of the Brief's vocabulary`
    );
  }
});

test("a felt-recovery check-in leads the Brief in the athlete's own voice, and rotates", () => {
  const seen = [];
  for (let back = 4; back >= 0; back--) {
    const date = dayBefore(REF, back);
    repo.addCheckin(date, { sleep_feel: 1, energy: 3, mood: 3 });
    const read = repo.dayRead(date, { has_data: false, recovery: {} });
    assert.equal(read.kind, "rest");
    assert.equal(read.decision.rule_code, "acute_signal_protection");
    assert.equal(read.signals.signal_state.action.voice.key, "sleep_feel_low");
    saysOneOf(read.why, "acute_signal_protection:sleep_feel_low");
    // The exact string the reviewer found on the Brief.
    assert.doesNotMatch(read.why, /The athlete feels poorly recovered/i);
    seen.push(read.why);
  }
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i], seen[i - 1], "the dominant rest path repeated itself day over day");
  }
  assert.ok(new Set(seen).size >= 3, "five days must not cycle through two sentences");
});

test("the protect read never prints the machine-facing evidence summary", () => {
  repo.addCheckin(REF, { soreness: 5, energy: 3, sleep_feel: 3, mood: 3 });
  const r = repo.dayRead(REF, { has_data: false, recovery: {} });

  assert.equal(r.decision.rule_code, "acute_signal_protection");
  saysOneOf(r.why, "acute_signal_protection:soreness_high");
  // …while the coach context and the provenance trail still see the summary, verbatim.
  const state = r.signals.signal_state;
  assert.equal(state.action.reason, "The athlete reports high soreness today.");
  assert.equal(state.dimensions.training_load_tolerance.reason, "The athlete reports high soreness today.");
  assert.notEqual(state.action.reason, r.why);
});

// ---------- prose variety (the "rest after rest after rest" complaint) ----------
test("variant selection is stable per day and never repeats on consecutive days", () => {
  const variants = ["a", "b", "c", "d"];
  // Same day + same key ⇒ the same text, every time.
  for (let i = 0; i < 5; i++) {
    assert.equal(pickDayVariant(variants, REF, "rule"), pickDayVariant(variants, REF, "rule"));
  }
  // Consecutive days ⇒ different text, for 30 days straight.
  for (let back = 0; back < 30; back++) {
    const today = dayBefore(REF, back);
    const yesterday = dayBefore(REF, back + 1);
    assert.notEqual(
      pickDayVariant(variants, today, "rule"),
      pickDayVariant(variants, yesterday, "rule"),
      `${yesterday} → ${today} repeated itself`
    );
  }
  // Degenerate + malformed inputs stay safe.
  assert.equal(pickDayVariant(["only"], REF, "rule"), "only");
  assert.equal(pickDayVariant(variants, "not-a-date", "rule"), variants[pickIndexFor("rule", variants.length)]);
});

// The offset half of pickDayVariant, mirrored so the malformed-date case above can
// assert a concrete value rather than "it didn't throw".
function pickIndexFor(key, span) {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash % 9973) % span;
}

// The cross-day cases run on REAL recent dates on purpose: saveDayRead prunes rows
// older than 21 days, so a fixed historical REF would delete its own history.
const CHRONIC_SHORT_SLEEP = sleepMean(300); // 5h nightly mean, sample-gated

// Live the same unchanging day `n` times in a row, persisting each read the way the
// real Brief does so the next morning can read yesterday back.
function liveConsecutiveDays(n, recovery = CHRONIC_SHORT_SLEEP) {
  const reads = [];
  for (let back = n - 1; back >= 0; back--) {
    const date = localDaysAgo(back);
    // A current night that is NOT short, so the REST rule does not consume the
    // chronic mean — the watch is about the pattern, not last night.
    seedSleep(date, 420);
    const read = repo.dayRead(date, recovery);
    repo.saveDayRead(date, { ...read, headline: "Take it easy.", source: "deterministic", override: null });
    reads.push({ date, read });
  }
  return reads;
}

test("five identical days for a chronic short sleeper do NOT print the same Brief", () => {
  // The actual complaint: nothing read yesterday's read, so a stable input — a
  // chronically short sleeper with nothing programmed — yielded a verbatim-identical
  // Brief indefinitely. Taking the rest never changes the input, so the read never
  // changed. Nothing anywhere covered this.
  const seen = liveConsecutiveDays(5).map(({ date, read }) => ({
    date,
    kind: read.kind,
    why: read.why,
    reason: read.decision.reason,
  }));

  assert.deepEqual(
    seen.map((s) => s.kind),
    ["easy", "easy", "easy", "easy", "easy"],
    "the POSTURE is stable — only the words move"
  );
  for (let i = 1; i < seen.length; i++) {
    assert.notEqual(seen[i].why, seen[i - 1].why, `${seen[i].date} repeated ${seen[i - 1].date} verbatim`);
  }
  assert.ok(new Set(seen.map((s) => s.why)).size >= 4, "five days must not cycle through two sentences");
  assert.ok(new Set(seen.map((s) => s.reason)).size >= 3, "the ledger reason varies too");
});

test("the third consecutive quiet day says something materially different", () => {
  const reads = liveConsecutiveDays(5).map((entry) => entry.read);

  // Day 1 argues the case for an easier day; day 2 repeats it but says so plainly...
  saysOneOf(reads[0].why, "chronic_sleep_watch");
  assert.equal(reads[0].signals.continuity.quiet_streak, 0);
  assert.ok(
    DAY_READ_WHY_VARIANTS.chronic_sleep_watch.some((v) => reads[1].why.startsWith(v)),
    `day 2 should still lead with the read, got ${JSON.stringify(reads[1].why)}`
  );
  assert.equal(reads[1].signals.continuity.quiet_streak, 1);
  // ...day 3 onward stops re-arguing it and offers the smallest thing worth doing.
  for (const read of reads.slice(2)) {
    assert.ok(read.signals.continuity.quiet_streak >= 2);
    assert.match(read.why, /quiet day/i);
    assert.equal(
      (DAY_READ_WHY_VARIANTS.chronic_sleep_watch ?? []).includes(read.why),
      false,
      "the third quiet day must not re-assert the same read"
    );
    // Still a suggestion, never a gate, never a nag, never a score.
    assert.match(read.why, /\b(?:walk|mobility|easy|small|rest)\b/i);
    assert.doesNotMatch(read.why, /\bmust\b|\bshould\b|\d+\s*(?:\/\s*100|%)/i);
    assert.equal(read.kind, "easy", "escalating the WORDS never escalates the posture");
  }
  assert.equal(reads[2].signals.continuity.quiet_streak, 2);
  assert.equal(reads[4].signals.continuity.quiet_streak, 4);
  assert.notEqual(reads[3].why, reads[2].why, "even the escalation rotates day over day");
});

test("the longest quiet run the Brief can see still reads as English", () => {
  // dayReadContinuity walks recentDayReads(date, 7), so the streak tops out at 7 and the
  // escalation asks for the ordinal of day 8 — one past where the ordinal table ended.
  // It fell through to the "another" fallback and printed "That's your another quiet day
  // in a row", reachable in exactly the scenario this layer exists to fix.
  const reads = liveConsecutiveDays(8).map((entry) => entry.read);
  const last = reads[reads.length - 1];

  assert.equal(last.signals.continuity.quiet_streak, 7, "the window itself caps the streak at 7");
  assert.ok(
    QUIET_STREAK_WHY.map((render) => render("eighth")).includes(last.why),
    `day 8 should name its own ordinal, got ${JSON.stringify(last.why)}`
  );
  assert.doesNotMatch(last.why, /\b(?:your|the)\s+another\b/i, "a determiner where the ordinal belongs");
});

test("the quiet-day ordinal covers every reachable streak and falls back to a word that fits every sentence", () => {
  // 3..8 is the whole reachable range (the escalation starts at a streak of 2, and the
  // continuity window caps it at 7). Beyond that the fallback has to be a WORD, not a
  // determiner — "your another quiet day" was grammatical nonsense in three of the four
  // templates, so widening the window would have broken the sentence all over again.
  for (let n = 3; n <= 8; n++) {
    assert.match(quietOrdinal(n), /^(?:third|fourth|fifth|sixth|seventh|eighth)$/, `streak ordinal ${n}`);
  }
  const fallback = quietOrdinal(99);
  for (const render of [...QUIET_STREAK_WHY, ...QUIET_STREAK_GUARDED_WHY]) {
    const sentence = render(fallback);
    assert.doesNotMatch(
      sentence,
      /\b(?:your|the)\s+(?:another|each|every|some|any)\b/i,
      `the fallback reads as a determiner here: ${JSON.stringify(sentence)}`
    );
    assert.match(sentence, /^[A-Z]/, `should still open as a sentence: ${JSON.stringify(sentence)}`);
    assert.match(sentence, /\bquiet days?\b/i, `should still be about the quiet stretch: ${JSON.stringify(sentence)}`);
  }
});

test("a quiet stretch with an injury never prescribes what the work-around just ruled out", () => {
  // The escalation is appended AFTER the injury caveat, so the read's last and most
  // memorable sentence was "ten easy minutes on your feet is plenty" — for someone who
  // had just been told to stay off it. Date-keyed variants made it contradict itself on
  // some days and not others.
  repo.addContextEvent({
    kind: "injury",
    title: "Achilles tendinopathy",
    detail: "Walking and running aggravate it",
    start_date: localDaysAgo(6),
  });
  const reads = liveConsecutiveDays(4).map((entry) => entry.read);

  for (const read of reads.slice(2)) {
    assert.ok(["easy", "rest"].includes(read.kind), `still a protective read, got ${read.kind}`);
    assert.equal(read.signals.health_workaround.field, "active_injury");
    // The caveat survives...
    const caveat = injurySentence(read.why, "Achilles tendinopathy");
    // ...the escalation still follows it, from the guarded set...
    const escalation = QUIET_STREAK_GUARDED_WHY.map((render) =>
      render(quietOrdinal(read.signals.continuity.quiet_streak + 1))
    );
    assert.ok(
      escalation.some((text) => read.why.endsWith(text)),
      `expected a guarded escalation to close the read, got ${JSON.stringify(read.why)}`
    );
    // ...and nothing after it sends an athlete with a lower-limb injury out on their feet.
    assert.doesNotMatch(read.why.slice(read.why.indexOf(caveat)), /on your feet|walk|mobility|steps/i);
  }
  assert.notEqual(reads[3].why, reads[2].why, "the guarded escalation rotates day over day too");
});

// The guarded escalation existed precisely so a day carrying a constraint is never told
// a walk beats resting — but it was selected off `health_workaround`, which was
// populated for `active_injury` ALONE. An illness is an equal safety_override and the
// very thing driving the rest posture, so a head cold got the UNGUARDED escalation: on
// the third quiet day the Brief dropped the illness entirely and argued "a gentle walk
// today would do more for you than another full stop".
test("an illness keeps its guidance through the quiet-streak escalation", () => {
  repo.addContextEvent({ kind: "illness", title: "Head cold", detail: "Chesty cough", start_date: localDaysAgo(6) });
  const reads = liveConsecutiveDays(4, { has_data: false, recovery: {} }).map((entry) => entry.read);

  for (const read of reads) {
    assert.ok(["easy", "rest"].includes(read.kind), `still a protective read, got ${read.kind}`);
    assert.equal(read.signals.health_workaround.field, "illness", "an illness is a work-around like any other");
    // The illness is named on every day of the stretch, in the athlete's own register.
    assert.ok(
      signalVoice({ key: "illness", subject: "Head cold" }).some((variant) => read.why.includes(variant)),
      `the illness should still be named, got ${JSON.stringify(read.why)}`
    );
    // ...and never twice: the protect rule already speaks this voice, so the appended
    // work-around sentence must not restate it in a second phrasing.
    const spoken = signalVoice({ key: "illness", subject: "Head cold" }).filter((variant) =>
      read.why.includes(variant)
    );
    assert.equal(spoken.length, 1, `the illness was voiced twice: ${JSON.stringify(read.why)}`);
  }

  for (const read of reads.slice(2)) {
    assert.ok(read.signals.continuity.quiet_streak >= 2);
    const escalation = QUIET_STREAK_GUARDED_WHY.map((render) =>
      render(quietOrdinal(read.signals.continuity.quiet_streak + 1))
    );
    assert.ok(
      escalation.some((text) => read.why.endsWith(text)),
      `expected a GUARDED escalation to close the read, got ${JSON.stringify(read.why)}`
    );
    // The unguarded set is what used to land here, and three of its four phrasings
    // offer time on your feet to someone who should be recovering.
    for (const render of QUIET_STREAK_WHY) {
      const text = render(quietOrdinal(read.signals.continuity.quiet_streak + 1));
      assert.equal(read.why.includes(text), false, `the unguarded escalation spoke over an illness`);
    }
  }
  assert.notEqual(reads[3].why, reads[2].why, "the guarded escalation still rotates day over day");
});

test("an unchanged read says so plainly instead of re-deriving itself", () => {
  const [, today] = liveConsecutiveDays(2);

  assert.equal(today.read.signals.continuity.repeat_of_yesterday, true);
  assert.equal(today.read.signals.continuity.yesterday.rule_code, "chronic_sleep_watch");
  assert.match(
    today.read.why,
    /(?:nothing's really moved|unchanged from yesterday|same picture as yesterday|nothing new has come in)/i
  );
});

test("a quiet stretch stops being the subject once they have actually moved today", () => {
  // "Third quiet day — here's the smallest thing worth doing" would ignore the walk
  // they already took. The read is about what they just did.
  liveConsecutiveDays(3);
  const today = localDaysAgo(0);
  db.prepare(`INSERT INTO activities (date, type, duration_min) VALUES (?, 'walk', 25)`).run(today);

  const read = repo.dayRead(today, CHRONIC_SHORT_SLEEP);

  assert.equal(read.kind, "easy");
  assert.equal(read.decision.rule_code, "logged_light_work_today");
  assert.ok(read.signals.continuity.quiet_streak >= 2, "the streak is still tracked");
  saysOneOf(read.why, "logged_light_work_today");
  assert.doesNotMatch(read.why, /quiet day/i);
});

test("a day the Brief never saw breaks the quiet run (an unknown day is not a quiet day)", () => {
  seedSleep(localDaysAgo(0), 420);
  const read = repo.dayRead(localDaysAgo(0), CHRONIC_SHORT_SLEEP);
  assert.equal(read.signals.continuity.quiet_streak, 0);
  assert.equal(read.signals.continuity.yesterday, null);
  assert.equal(read.signals.continuity.repeat_of_yesterday, false);
  saysOneOf(read.why, "chronic_sleep_watch");
});

test("each reachable rule branch reports its own code and reason, never a generic fallback", () => {
  const generic = /deterministic day policy/i;
  const seen = new Map();
  const record = (read) => {
    seen.set(read.decision.rule_code, read.decision.reason);
    assert.doesNotMatch(read.decision.reason, generic, read.decision.rule_code);
    assert.ok(String(read.decision.reason).trim(), `${read.decision.rule_code} has no reason`);
    return read;
  };

  // No plan, nothing logged → the unprogrammed floor.
  const bare = record(repo.dayRead(REF, { has_data: false, recovery: {} }));
  assert.equal(bare.decision.rule_code, "unprogrammed_easy_day");
  assert.ok(UNPROGRAMMED_EASY_DAY.reasons.includes(bare.decision.reason));

  // Chronic short sleep with nothing programmed → the (demoted) sleep watch.
  seedCurrentNight(REF);
  const chronic = record(repo.dayRead(REF, sleepMean(300)));
  assert.equal(chronic.decision.rule_code, "chronic_sleep_watch");

  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  const planned = record(repo.dayRead(REF, { has_data: false, recovery: {} }));
  assert.equal(planned.decision.rule_code, "planned_training");

  // A corroborating fresh short night still reaches rest.
  seedSleep(dayBefore(REF, 1), 300);
  const acute = record(repo.dayRead(REF, sleepMean(330)));
  assert.equal(acute.decision.rule_code, "acute_sleep_corroborated");
  resetTables("daily_metrics");

  // Three stacked loading days → earned rest from accumulated load.
  for (let i = 1; i <= 3; i++) seedTrainingDay(dayBefore(REF, i));
  const stacked = record(repo.dayRead(REF, { has_data: false, recovery: {} }));
  assert.equal(stacked.decision.rule_code, "accumulated_load_rest");
  resetTables("logged_sets", "sessions");

  // A run-down check-in reaches rest through the unified protect posture, which
  // sits ABOVE earned rest — so the code that reaches the ledger describes the
  // rule that actually fired, not the one further down the list.
  repo.addCheckin(REF, { energy: 1, sleep_feel: 2 });
  const runDown = record(repo.dayRead(REF, { has_data: false, recovery: {} }));
  assert.equal(runDown.kind, "rest");
  assert.equal(runDown.decision.rule_code, "acute_signal_protection");
  resetTables("checkins");

  // Work already logged today (a real loading session) → the done acknowledgement.
  seedTrainingDay(REF);
  const done = record(repo.dayRead(REF, { has_data: false, recovery: {} }));
  assert.equal(done.kind, "done");
  assert.equal(done.decision.rule_code, "logged_loading_work_today");
  resetTables("logged_sets", "sessions");

  assert.ok(seen.size >= 6);
});

test("the endurance volume-spike rule reports a real reason (it had none at all)", () => {
  // The one rule whose code was genuinely absent from the old map: it fired and
  // told the athlete "Cairn's deterministic day policy selected this posture."
  repo.setProfile({ primary_discipline: "endurance", endurance_sport: "running" });
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  // A ramped week against a quiet chronic base. Two loading days is deliberate:
  // three would trip earned rest first and the spike rule would never be reached.
  const run = (daysBack, minutes, km) =>
    db
      .prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'run', ?, ?)`)
      .run(dayBefore(REF, daysBack), minutes, km);
  run(1, 55, 11);
  run(2, 85, 16);
  for (const back of [9, 16, 23]) run(back, 45, 8); // the quiet chronic base

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });

  assert.equal(r.signals.endurance_volume.volume_spike, true);
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "endurance_volume_spike");
  assert.ok(DAY_READ_OUTCOMES.endurance_volume_spike.reasons.includes(r.decision.reason));
  assert.doesNotMatch(r.decision.reason, /deterministic day policy/i);
});

test("sleep evidence speaks in hours, never raw minutes", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 412)`).run(dayBefore(REF, 1));

  const r = repo.dayRead(REF, { has_data: true, recovery: { avg_sleep_min: 412 } });
  const sleep = r.decision.evidence.find((item) => item.label === "Last night's sleep");

  assert.equal(sleep.value, "6h 52m");
  for (const item of r.decision.evidence) assert.doesNotMatch(item.value, /\d+\s*min\b/);
});

// ---------- the fingerprint is a DECISION fingerprint ----------
test("recovery telemetry that cannot move the decision leaves the fingerprint alone", () => {
  const base = {
    kind: "train",
    focus: "Lower body",
    signals: {
      recent_load: [{ date: dayBefore(REF, 1), load: "easy" }],
      today_load: "none",
      low_sleep: false,
      avg_sleep_min: 431,
      last_night: { date: dayBefore(REF, 1), total_min: 431, hrv_vs_baseline: 3 },
      fatigue: {
        anticipate_deload: false,
        low_readiness: false,
        acute_load: 210,
        hrv_vs_norm: -1,
        readiness: { current: 68, window_average: 61, sample_count: 9 },
      },
    },
  };
  const before = repo.dayReadInputFingerprint(REF, base);

  // A mid-day watch sync: every continuous number moves, no predicate flips.
  const resynced = {
    ...base,
    signals: {
      ...base.signals,
      avg_sleep_min: 437,
      last_night: { date: dayBefore(REF, 1), total_min: 448, hrv_vs_baseline: -2 },
      fatigue: {
        ...base.signals.fatigue,
        acute_load: 244,
        hrv_vs_norm: -4,
        readiness: { current: 71, window_average: 64, sample_count: 10 },
      },
    },
  };
  assert.equal(repo.dayReadInputFingerprint(REF, resynced), before, "telemetry noise must not invalidate the read");

  // But the predicates the rules actually branch on still do.
  const shortNight = {
    ...base,
    signals: { ...base.signals, last_night: { ...base.signals.last_night, total_min: 300 } },
  };
  assert.notEqual(repo.dayReadInputFingerprint(REF, shortNight), before);
  const chronic = { ...base, signals: { ...base.signals, low_sleep: true } };
  assert.notEqual(repo.dayReadInputFingerprint(REF, chronic), before);
  const lowReadiness = {
    ...base,
    signals: { ...base.signals, fatigue: { ...base.signals.fatigue, low_readiness: true } },
  };
  assert.notEqual(repo.dayReadInputFingerprint(REF, lowReadiness), before);
  const deload = {
    ...base,
    signals: { ...base.signals, fatigue: { ...base.signals.fatigue, anticipate_deload: true } },
  };
  assert.notEqual(repo.dayReadInputFingerprint(REF, deload), before);
  // The volume spike now participates at all — it used to be invisible here.
  const spike = {
    ...base,
    signals: { ...base.signals, endurance_volume: { last_week_km: 62, volume_spike: true } },
  };
  assert.notEqual(repo.dayReadInputFingerprint(REF, spike), before);
  // ...but its raw mileage does not.
  const mileageOnly = {
    ...base,
    signals: { ...base.signals, endurance_volume: { last_week_km: 41, volume_spike: false } },
  };
  assert.equal(repo.dayReadInputFingerprint(REF, mileageOnly), before);
});

test("recoveryDrift uses the same norm-relative RHR bar as signal-state", () => {
  for (let i = 1; i <= 2; i++) seedTrainingDay(dayBefore(REF, i));
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  // Shared bar is max(3, baseline * 0.05). A 50 bpm athlete's bar is 3 bpm; 2.5
  // used to trip the flat `> 2` while signal-state said nothing was wrong.
  const quiet = repo.dayRead(REF, {
    has_data: true,
    recovery: {},
    baseline: { rhr: 50 },
    delta: { rhr: 2.5 },
  });
  assert.equal(quiet.signals.fatigue.recovery_drift_signals, 0, "2.5 bpm is inside the shared bar");

  const drifted = repo.dayRead(REF, {
    has_data: true,
    recovery: {},
    baseline: { rhr: 50 },
    delta: { rhr: 4 },
  });
  assert.equal(drifted.signals.fatigue.recovery_drift_signals, 1, "4 bpm clears the shared 3 bpm floor");
});

test("hybrid lookahead truth participates in the cache identity without hashing narration", () => {
  const base = {
    kind: "train",
    focus: "Lower body",
    signals: {
      today_load: "none",
      hybrid: {
        cardio_today: false,
        hard_cardio_yesterday: false,
        protect_run_next: true,
        guidance: "A movable quality run is next.",
      },
    },
  };
  const before = repo.dayReadInputFingerprint(REF, base);
  const renarrated = {
    ...base,
    signals: {
      ...base.signals,
      hybrid: { ...base.signals.hybrid, guidance: "Different prose, same opening." },
    },
  };
  const movedOrCompleted = {
    ...base,
    signals: {
      ...base.signals,
      hybrid: { ...base.signals.hybrid, protect_run_next: false },
    },
  };
  assert.equal(repo.dayReadInputFingerprint(REF, renarrated), before);
  assert.notEqual(repo.dayReadInputFingerprint(REF, movedOrCompleted), before);
});

test("flexible agenda cache identity tracks rendered work facts but ignores narration", () => {
  const read = {
    kind: "train",
    focus: "Lower body",
    signals: { today_load: "none" },
  };
  const intent = {
    kind: "quality",
    status: "open",
    suggested_date: dayBefore(REF, -1),
    window_start: REF,
    window_end: dayBefore(REF, -6),
    target_distance_km: 7,
    target_duration_min: null,
    target_zone: "Z3",
    completion: null,
    label: "Tempo run",
    rationale: "Original rationale.",
  };
  const context = (entry, narration = {}) => ({
    program_block: null,
    flexible_training_agenda: {
      available: true,
      intents: [entry],
      why: narration.why ?? "Original why.",
      next: { guidance: narration.guidance ?? "Original guidance." },
    },
  });
  const base = repo.dayReadInputFingerprint(REF, read, context(intent));

  assert.equal(
    repo.dayReadInputFingerprint(
      REF,
      read,
      context(
        { ...intent, label: "Different label", rationale: "Different rationale." },
        { why: "Different why.", guidance: "Different guidance." }
      )
    ),
    base,
    "why/rationale/guidance copy cannot churn a warm read"
  );
  assert.notEqual(
    repo.dayReadInputFingerprint(REF, read, context({ ...intent, kind: "long" })),
    base,
    "quality becoming tomorrow's long run is material"
  );
  assert.notEqual(
    repo.dayReadInputFingerprint(REF, read, context({ ...intent, target_distance_km: 10 })),
    base,
    "an open target-dose change is material"
  );
  const completed = {
    ...intent,
    status: "completed",
    suggested_date: null,
    completion: {
      activity_id: 77,
      date: REF,
      duration_min: 40,
      distance_km: 7,
      intensity: "quality",
      signals: ["watch prose"],
    },
  };
  const completedFingerprint = repo.dayReadInputFingerprint(REF, read, context(completed));
  assert.notEqual(completedFingerprint, base, "completion changes the agenda truth");
  assert.notEqual(
    repo.dayReadInputFingerprint(
      REF,
      read,
      context({ ...completed, completion: { ...completed.completion, distance_km: 8 } })
    ),
    completedFingerprint,
    "completion dose evidence is material"
  );
  assert.equal(
    repo.dayReadInputFingerprint(
      REF,
      read,
      context({
        ...completed,
        completion: { ...completed.completion, activity_id: 99, signals: ["different narration"] },
      })
    ),
    completedFingerprint,
    "private identity and evidence narration stay out"
  );
});

// `directives` is selected field by field so `training_source` stays OUT of the hash.
// It names which dimension produced the directive, which is not itself a decision, and
// every input that can move it is hashed already — so the same hold changing hands
// between two dimensions must not discard a warm agentic read. The directives that ARE
// decisions still move it.
test("the brake's identity does not churn the fingerprint, but the directives do", () => {
  const withDirectives = (extra) => ({
    kind: "train",
    focus: "Lower body",
    signals: {
      today_load: "none",
      signal_state: {
        action: {
          posture: "train",
          reason: "The athlete slept well.",
          confidence: "medium",
          directives: {
            training: "hold_aggression",
            training_source: "recovery_capacity",
            fueling: "normal",
            schedule: "normal",
            ...extra,
          },
        },
      },
    },
  });
  const base = repo.dayReadInputFingerprint(REF, withDirectives({}));

  assert.equal(
    repo.dayReadInputFingerprint(REF, withDirectives({ training_source: "training_load_tolerance" })),
    base,
    "the same hold from a different brake is the same decision"
  );
  assert.equal(
    repo.dayReadInputFingerprint(REF, withDirectives({ training_source: null })),
    base,
    "and a row cached before the source existed must not churn on deploy"
  );

  // The decisions themselves still move it.
  assert.notEqual(repo.dayReadInputFingerprint(REF, withDirectives({ training: "recover" })), base);
  assert.notEqual(repo.dayReadInputFingerprint(REF, withDirectives({ fueling: "protect" })), base);
  assert.notEqual(repo.dayReadInputFingerprint(REF, withDirectives({ schedule: "compress" })), base);

  // And the narration around them still cannot.
  const renarrated = withDirectives({});
  renarrated.signals.signal_state.action.reason = "The athlete reports workable energy today.";
  renarrated.signals.signal_state.action.confidence = "high";
  assert.equal(repo.dayReadInputFingerprint(REF, renarrated), base, "narration is churn, not a decision");
});

test("a today_holds change moves the day-read fingerprint", () => {
  const base = {
    kind: "train",
    focus: "Lower body",
    signals: { today_load: "none", trained_today: null },
  };
  const before = repo.dayReadInputFingerprint(REF, base);
  const held = {
    ...base,
    signals: {
      ...base.signals,
      today_holds: [{ kind: "appointment", title: "Morning labs", claims_day: false, lab_draw: true }],
    },
  };
  assert.notEqual(repo.dayReadInputFingerprint(REF, held), before);
  // Title is narration: the same hold with a different label is the same decision.
  const renamed = {
    ...held,
    signals: {
      ...held.signals,
      today_holds: [{ kind: "appointment", title: "Bloodwork at 8am", claims_day: false, lab_draw: true }],
    },
  };
  assert.equal(repo.dayReadInputFingerprint(REF, renamed), repo.dayReadInputFingerprint(REF, held));
});

// ---------------------------------------------------------------------------
// The Brief must not be computed BLIND. planningSignalState takes nine optional
// inputs; the athlete-facing path used to pass seven, and the two it dropped
// (`trainingSignals`, `programState`) are where joint pain, the low-performance
// flag and a due deload enter — all as safety_override CONSTRAINTS. "Optional"
// means the thin call built a weaker state with no error and no warning, so on
// the same day the coach prompt was told to protect, the Brief said train. These
// reproduce the defect end to end through the REAL dayRead(date) with NO
// unifiedState argument — exactly how computeDayRead / readToday call it.
// ---------------------------------------------------------------------------

test("the bare dayRead sees logged joint pain (it used to be blind to it)", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  seedTrainingDay(dayBefore(REF, 3));
  repo.setSessionFeedback(dayBefore(REF, 3), { joint_pain: "left knee" });

  const r = repo.dayRead(REF); // no unifiedState — the athlete-facing call
  const state = r.signals.signal_state;
  assert.equal(state.dimensions.health_constraints.status, "constrained");
  assert.ok(
    state.dimensions.health_constraints.evidence.some((e) => e.field === "joint_pain"),
    "the joint-pain constraint has to reach the read the athlete is shown"
  );
  // Protective, not "proceed as planned": the thin state answered train/proceed.
  assert.notEqual(state.action.posture, "train");
  assert.equal(state.action.directives.training, "modify");
  assert.equal(state.action.directives.training_source, "health_constraints");
});

test("the bare dayRead sees the low-performance flag and reads protectively", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  seedTrainingDay(dayBefore(REF, 3));
  repo.setSessionFeedback(dayBefore(REF, 3), { performance: 2 });

  const r = repo.dayRead(REF);
  const state = r.signals.signal_state;
  assert.equal(state.dimensions.training_load_tolerance.status, "constrained");
  assert.ok(
    state.dimensions.training_load_tolerance.evidence.some((e) => e.field === "felt_fatigue"),
    "recent sessions feeling below par has to reach the read"
  );
  // EASY, not rest. A rated session that felt below par means "loading should ease",
  // and the observation carries a 7-day window — so on the old felt-protect rung,
  // which matched field names by SUBSTRING and caught `felt_fatigue` on "fatigue",
  // this three-day-old rating claimed the top of the posture ladder and returned a
  // full rest day every morning for a week. The observation, the constrained
  // dimension, the rule and the directive are all unchanged; the severity is now
  // proportional to the evidence behind it.
  assert.equal(state.action.posture, "easy");
  assert.equal(state.action.directives.training, "recover");
  // And the read itself follows — the plan day is no longer simply handed over.
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "acute_signal_protection");
});

test("the bare dayRead sees a due deload from the program state", () => {
  const today = localDaysAgo(0);
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  // Nine straight loaded weeks with no reset (every third day, so no earned-rest
  // streak and no week light enough to read as a deload) → mesocycle deload-due.
  // Program state is keyed to the CURRENT week, so this fixture is dated off today.
  for (let n = 3; n <= 63; n += 3) seedTrainingDay(dayBefore(today, n));

  const r = repo.dayRead(today);
  const state = r.signals.signal_state;
  assert.equal(state.dimensions.training_load_tolerance.status, "constrained");
  assert.ok(
    state.dimensions.training_load_tolerance.evidence.some((e) => e.field === "mesocycle"),
    "the anticipated reset has to reach the read"
  );
  assert.notEqual(state.action.posture, "train");
  assert.equal(state.action.directives.training, "recover");
  assert.equal(r.decision.rule_code, "acute_signal_protection");
});

// ---------- the outcome loop: a rest the athlete keeps overruling softens ----------
// Every rule above reads only TODAY's inputs, which is how a stable picture came to
// suggest rest for eleven mornings running while the athlete trained through six of
// them and rated those sessions well. The disagreement was recorded and reconciled
// the whole time; nothing read it back. These pin the one place that now does — and,
// more importantly, every place it must NOT.

// A morning the Brief said rest. Written through saveDayRead because that is what
// records the MORNING ledger row readAdherenceModel reads back (day_reads holds
// end-of-day state and answers a different question).
const seedMorningRead = (date, kind, signals = {}) =>
  repo.saveDayRead(date, {
    kind,
    headline: `${kind} today.`,
    why: "A calm sentence about the day.",
    focus: null,
    est_minutes: kind === "rest" ? null : 45,
    signals,
    source: "deterministic",
    override: null,
  });

// A morning the Brief eased from rest to easy. `applied` is what marks it — `active`
// merely says the pattern exists, and is just as true on a morning nothing was eased.
const seedSoftenedEasy = (date, { trained = true } = {}) => {
  seedMorningRead(date, "easy", { outcome_feedback: { active: true, applied: true } });
  if (trained) seedTrainingDay(date);
};

// ...and they trained anyway, and it went fine (their own 1-5 read of the session).
const seedOverriddenRest = (date, performance = 4) => {
  seedMorningRead(date, "rest");
  seedTrainingDay(date);
  if (performance != null) repo.setSessionFeedback(date, { performance });
};

test("three rest mornings trained through without cost soften today's earned rest to easy", () => {
  for (let i = 1; i <= 3; i++) seedOverriddenRest(dayBefore(REF, i));

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });

  // The same three loading days that used to produce a flat rest...
  assert.equal(r.signals.consecutive_training_days, 3);
  // ...now produce an easy day, carrying the softening's own ledger code so the
  // decision trail and repeat_of_yesterday key on the softening, not on the rule it
  // replaced.
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "outcome_feedback_soften");
  assert.equal(r.est_minutes, 20);
  saysOneOf(r.why, "outcome_feedback_soften");
  assert.ok(DAY_READ_OUTCOMES.outcome_feedback_soften.reasons.includes(r.decision.reason));
  assert.equal(violatesReadingGrammar(r.why), null, `softened why broke the grammar: ${r.why}`);
  assert.equal(violatesReadingGrammar(r.decision.reason), null, `softened reason: ${r.decision.reason}`);
  // And the evidence rides in signals, so the prompt and the audit trail can both see
  // WHY it softened rather than being told to trust it.
  assert.equal(r.signals.outcome_feedback.active, true);
  assert.equal(r.signals.outcome_feedback.overridden_and_fine.length, 3);
  assert.equal(r.signals.outcome_feedback.last_honored_rest, null);
});

test("it softens ONE step — never past easy into a training day", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  for (let i = 1; i <= 4; i++) seedOverriddenRest(dayBefore(REF, i));

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy", "a due plan day must not turn a softened rest into a session");
  assert.equal(r.focus, null);
});

test("two divergences are a coincidence, not a pattern — the rest stands", () => {
  // Three loading days (so the earned-rest rule still fires), but only two of those
  // mornings actually read rest.
  seedOverriddenRest(dayBefore(REF, 1));
  seedOverriddenRest(dayBefore(REF, 2));
  seedMorningRead(dayBefore(REF, 3), "train");
  seedTrainingDay(dayBefore(REF, 3));

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.consecutive_training_days, 3);
  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
  assert.equal(r.signals.outcome_feedback.active, false);
});

test("a rest they actually TOOK resets the count — older divergences no longer speak", () => {
  // Three rest mornings trained through a week ago...
  for (let i = 5; i <= 7; i++) seedOverriddenRest(dayBefore(REF, i));
  // ...then a rest morning they honored, which is the athlete agreeing with the read.
  seedMorningRead(dayBefore(REF, 4), "rest");
  // ...and three ordinary training days since, on mornings that read train.
  for (let i = 1; i <= 3; i++) {
    seedMorningRead(dayBefore(REF, i), "train");
    seedTrainingDay(dayBefore(REF, i));
  }

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest", "an honored rest starts the count over");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
  assert.equal(r.signals.outcome_feedback.active, false);
  assert.equal(r.signals.outcome_feedback.last_honored_rest, dayBefore(REF, 4));
  assert.deepEqual(r.signals.outcome_feedback.overridden_and_fine, []);
});

test("sessions that went badly are not evidence that overruling the read was fine", () => {
  for (let i = 1; i <= 3; i++) seedOverriddenRest(dayBefore(REF, i), 2);

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  // Sessions felt below par latch the low-performance signal, so the protect posture
  // owns this morning — a softenable rule. The read this case is about is `applied`:
  // nothing was softened, because the evidence the softening rests on (overrides that
  // went WELL) is exactly what is missing here.
  //
  // `easy` rather than `rest` is the low-performance flag now sitting on the rung that
  // matches what it means, and it is NOT the softening — the assertions below are what
  // separate the two, and they are the point of the case.
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "acute_signal_protection");
  assert.equal(r.signals.outcome_feedback.active, false);
  assert.equal(r.signals.outcome_feedback.applied, false, "no rest was eased away — this easy is the read's own");
  assert.deepEqual(r.signals.outcome_feedback.overridden_and_fine, []);
});

test("an unrated session still counts — silence is not evidence of harm", () => {
  for (let i = 1; i <= 3; i++) seedOverriddenRest(dayBefore(REF, i), null);

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "outcome_feedback_soften");
});

test("a corroborated short night is fresh evidence about TODAY — history cannot soften it", () => {
  for (let i = 1; i <= 3; i++) seedOverriddenRest(dayBefore(REF, i));
  db.prepare(`INSERT INTO daily_metrics (source, date, sleep_min) VALUES ('apple', ?, 300)`).run(dayBefore(REF, 1));

  const r = repo.dayRead(REF, sleepMean(330));
  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "acute_sleep_corroborated");
  assert.equal(r.signals.outcome_feedback.active, true, "the pattern is there; the rule is simply out of reach");
});

test("the clinical floor is absolute — an active injury is never softened away", () => {
  for (let i = 1; i <= 3; i++) seedOverriddenRest(dayBefore(REF, i));
  repo.addContextEvent({
    kind: "injury",
    title: "Achilles tendinopathy",
    detail: "Running and jumping aggravate it",
    start_date: REF,
  });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.equal(r.decision.rule_code, "accumulated_load_rest");
  assert.equal(r.signals.health_workaround.field, "active_injury");
  assert.equal(r.signals.outcome_feedback.active, true);
});

test("an illness holds the same line", () => {
  for (let i = 1; i <= 3; i++) seedOverriddenRest(dayBefore(REF, i));
  repo.addContextEvent({ kind: "illness", title: "Head cold", start_date: REF });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "rest");
  assert.notEqual(r.decision.rule_code, "outcome_feedback_soften");
});

test("a felt-signal rest softens too, since that is the read they keep overruling", () => {
  // A low-energy check-in reaches rest through the unified protect posture, whose
  // evidence is recovery_capacity — nothing clinical, so the pattern applies.
  for (let i = 1; i <= 3; i++) seedOverriddenRest(dayBefore(REF, i));
  repo.addCheckin(REF, { energy: 1, sleep_feel: 3, mood: 3, soreness: 2 });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.signal_state.action.posture, "rest");
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "outcome_feedback_soften");
});

test("softening never touches a day that already reads train, easy or done", () => {
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  for (let i = 5; i <= 7; i++) seedOverriddenRest(dayBefore(REF, i));

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.outcome_feedback.active, true);
  assert.equal(r.kind, "train", "a clear day is still a training day, not a softened one");
  assert.equal(r.decision.rule_code, "planned_training");
});

// ---------- and the softening has to SUSTAIN, or it is a ten-day oscillation ----------
// The first cut counted only rest mornings as evidence. Once it activated the read
// stopped saying rest, so nothing new could accrue, the qualifying days aged out of
// the window, and the read relapsed to rest — cycling back to the exact defect the
// rule exists to fix. A softened easy morning trained through without harm is the
// same evidence restated under the new read; honoring one resets, like an honored rest.

test("softened easy mornings trained through hold the read open after the rest evidence ages out", () => {
  // Nothing inside the window is a rest morning any more — the read has been easy for
  // a week, and the athlete has trained through every one of those days.
  for (let i = 1; i <= 5; i++) seedSoftenedEasy(dayBefore(REF, i));

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  // The five loading days still earn a rest from the rules...
  assert.ok(r.signals.consecutive_training_days >= 3);
  // ...and the softening is still standing on its own evidence, so it stays an easy day.
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "outcome_feedback_soften");
  assert.equal(r.signals.outcome_feedback.active, true);
  assert.equal(r.signals.outcome_feedback.applied, true);
  assert.equal(r.signals.outcome_feedback.overridden_and_fine.length, 5);
});

test("a softened easy day they actually TOOK sends the next morning back to rest", () => {
  // Three rest mornings trained through, then the eased day they simply took.
  for (let i = 6; i >= 4; i--) seedOverriddenRest(dayBefore(REF, i));
  seedSoftenedEasy(dayBefore(REF, 3), { trained: false });
  // A low-energy check-in reaches rest through the protect posture (nothing clinical),
  // so the only question left is whether the softening still has evidence to spend.
  repo.addCheckin(REF, { energy: 1, sleep_feel: 3, mood: 3, soreness: 2 });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.signals.signal_state.action.posture, "rest");
  assert.equal(r.kind, "rest", "honoring the eased day is the athlete agreeing with the read");
  assert.notEqual(r.decision.rule_code, "outcome_feedback_soften");
  assert.equal(r.signals.outcome_feedback.active, false);
  assert.equal(r.signals.outcome_feedback.applied, false);
  assert.equal(r.signals.outcome_feedback.last_honored_rest, dayBefore(REF, 3));
});

test("the same week with that eased day trained through stays soft", () => {
  for (let i = 6; i >= 4; i--) seedOverriddenRest(dayBefore(REF, i));
  seedSoftenedEasy(dayBefore(REF, 3));
  repo.addCheckin(REF, { energy: 1, sleep_feel: 3, mood: 3, soreness: 2 });

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "easy");
  assert.equal(r.decision.rule_code, "outcome_feedback_soften");
  assert.equal(r.signals.outcome_feedback.applied, true);
});

test("`applied` is the fact, `active` only the argument for it", () => {
  // The pattern is established, but a due plan day means the read never was a rest —
  // so nothing was eased, and the signal must not claim otherwise.
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);
  for (let i = 5; i <= 7; i++) seedOverriddenRest(dayBefore(REF, i));

  const r = repo.dayRead(REF, { has_data: false, recovery: {} });
  assert.equal(r.kind, "train");
  assert.equal(r.signals.outcome_feedback.active, true);
  assert.equal(r.signals.outcome_feedback.applied, false);
});

// ---- the OTHER direction of the same guard -----------------------------------
//
// Twice on a live deployment the agent opened the Brief by asserting the lifts had
// felt heavier than they should — on a morning whose freshest rated session was the
// athlete's own "that came back strong", with no low-performance brake anywhere.
// The rollup that knew this shipped in DATA as a flag and was never rendered in
// words (fixed in renderTrainingSignals), and nothing rejected the sentence.
test("felt-quality prose consistency: strong recent feedback cannot be described as heavy or flat", async () => {
  const { dayReadProseConsistencyIssue, isValidDayReadAgentResult } = await import("../dist/dayread.js");
  // The rollup, passed directly — the same two flags the signal state carries.
  const strong = {
    session_quality: { strong_flag: true, strong_date: "2026-08-01", rated_sessions: 2 },
    autoregulation: null,
  };
  const braked = {
    session_quality: { strong_flag: true, strong_date: "2026-08-01", rated_sessions: 2 },
    autoregulation: { low_performance_flag: true },
  };

  const understated = {
    kind: "train",
    headline: "Take it steady.",
    why: "Your recent sessions felt heavier than they should, so keep the load conservative.",
  };
  assert.deepEqual(dayReadProseConsistencyIssue(understated, null, strong), {
    code: "felt_quality_understated",
    evidence: understated.why,
  });
  assert.equal(isValidDayReadAgentResult({ ...understated, focus: null }, { kind: "train", signals: null }, strong), false);

  // A brake ON the board is the athlete telling us the same thing — the guard has no
  // business rejecting prose that agrees with it.
  assert.equal(dayReadProseConsistencyIssue(understated, null, braked), null);
  // And with no positive evidence at all, the guard is silent.
  assert.equal(dayReadProseConsistencyIssue(understated, null, null), null);

  // Prose that AGREES with the strong read passes, and so does the denial of a heavy
  // day — "nothing felt heavy" must not read as the claim it refutes.
  for (const why of [
    "That work is landing — the last session came back strong.",
    "Nothing about the recent sets felt heavy, so today has room in it.",
    "Keep the bar a touch lighter on the last set if you want to.",
    "Today's session is due and the recent work has been landing well.",
  ]) {
    assert.equal(dayReadProseConsistencyIssue({ kind: "train", why }, null, strong), null, why);
  }
});

// A guard this blunt costs the athlete calm, correct prose. The claim set had the
// present-tense copulas `is`/`are` in it, so "today's session is heavier than last
// week" — a description of the PLAN, and the ordinary way to say load went up — was
// rejected as a complaint about how the work came back. Four of five legitimate
// sentences failed. These nine pin both edges of the seam at once.
test("felt-quality guard: prescribed heaviness passes, degraded work still flags", async () => {
  const { dayReadProseConsistencyIssue } = await import("../dist/dayread.js");
  const strong = { session_quality: { strong_flag: true, rated_sessions: 2 }, autoregulation: null };
  const flagged = (why) => !!dayReadProseConsistencyIssue({ kind: "train", why }, null, strong);

  // Still wrong: each of these asserts the work came back worse than usual, on a
  // morning whose freshest rating was the athlete's own "that came back strong".
  for (const why of [
    "Recent work has felt heavier than it should, so keep the load conservative.",
    "Your last sessions came back flat.",
    "That lift felt sluggish.",
    "These sets landed harder than usual.",
  ])
    assert.equal(flagged(why), true, `should still flag: ${why}`);

  // Legitimate: a plan getting heavier, said in the present tense or vetoed as
  // deliberate — plus the denial the negation veto already covered.
  for (const why of [
    "Today's session is heavier than last week, so take the warm-up seriously.",
    "These sets are heavier now — a good sign.",
    "The work is heavier today by design.",
    "The bar is heavier this block, which is what progression looks like.",
    "Nothing about the recent sets felt heavy, so today has room in it.",
  ])
    assert.equal(flagged(why), false, `should pass: ${why}`);
});

test("felt-quality guard reads the two flags off the signal state the server acted on", async () => {
  const { dayReadProseConsistencyIssue } = await import("../dist/dayread.js");
  const withFields = (fields) => ({
    signal_state: { dimensions: { training_load_tolerance: { coverage: { active_fields: fields } } } },
  });
  const understated = { kind: "train", why: "Those lifts felt flat, so ease the loading today." };

  assert.equal(dayReadProseConsistencyIssue(understated, withFields(["session_quality"]))?.code, "felt_quality_understated");
  // The brake's own field on the board withdraws the guard.
  assert.equal(dayReadProseConsistencyIssue(understated, withFields(["session_quality", "felt_fatigue"])), null);
  assert.equal(dayReadProseConsistencyIssue(understated, withFields(["felt_fatigue"])), null);
  assert.equal(dayReadProseConsistencyIssue(understated, withFields([])), null);
  // A stale strong week has aged out of active_fields and stops licensing the guard.
  assert.equal(dayReadProseConsistencyIssue(understated, { signal_state: { dimensions: {} } }), null);
});

// ---- the athlete's own push setting reaches the agent, not just the floor ----
//
// `training_drive_push` is set only after the deterministic gate has passed on a day
// the athlete deliberately set their drive to push. Nothing in the prompt said so, and
// enforceDayReadSafetyPosture only ever clamps DOWN — so one model sentence could
// quietly revert a setting they went and flipped, and no layer would object.
test("the prompt tells the agent the athlete CHOSE to push, on a drive day only", async () => {
  const { buildDayReadPrompt } = await import("../dist/prompt.js");

  seedDriveMorning();
  const steady = buildDayReadPrompt(undefined, { date: DRIVE_REF, baseline: repo.dayRead(DRIVE_REF) });
  assert.doesNotMatch(steady, /THEY HAVE ASKED TO PUSH/, "an ordinary day carries no drive block");

  repo.setSettings({ training_drive: "push" });
  const baseline = repo.dayRead(DRIVE_REF);
  assert.ok(baseline.signals.training_drive_push, "the fixture is a real drive morning");
  const drive = buildDayReadPrompt(undefined, { date: DRIVE_REF, baseline });

  assert.match(drive, /THEY HAVE ASKED TO PUSH/);
  // It must name the athlete's own choice, what is due, and the terms of disagreement.
  assert.match(drive, /standing choice/i);
  assert.match(drive, /what's due: back/i);
  assert.match(drive, /naming the CONCRETE thing/);
  // And it stays inside the same rules as every neighbouring block.
  assert.match(drive, /no score, no gate/);
});
