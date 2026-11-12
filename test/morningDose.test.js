// WHAT A MORNING'S BODY READINGS MAY CONCLUDE (owner rulings 2026-11-12, morning-dose.ts).
//
//   A. The composite readiness score alone never decides REST: an easy day on an unstated
//      day, a dosed training day on a stated lifting / key-run day.
//   B. One low HRV night after hard endurance, resting HR in band, is a caveat plus the dose.
//   C. A second consecutive low morning means easy, never rest.
//   D. One short night eases (dosed on a stated day); two in a row mean easy.
//   E. Resting HR above the athlete's band: after hard endurance, easy at most; without a
//      hard day, or for a second reading, it reads as possible illness — rest.
//   F. REST is reserved for the floors the engine owns plus E's pattern and a sustained
//      rolling HRV decline beside a log-confirmed shortfall.
//   G. A good check-in lifts a readiness-only caution one step, intensity held, and says
//      plainly that the athlete's report and the watch disagreed.
// Race morning never reads rest.
//
// The thresholds are PROVISIONAL and live in MORNING_DOSE_POLICY; every case below reads
// them from there, so a revised value changes a fixture, never a test.
// Synthetic fixtures only; no real data.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { DAY_READ_WHY_VARIANTS, dayReadProseIdentity } from "../dist/repo/day-read-prose.js";
import { buildDailySessionDecision, gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { getCachedDayRead } from "../dist/repo/day-read-cache.js";
import { rollingBandRead } from "../dist/repo/overnight-band.js";
import {
  CHECKIN_LIFT_STEP,
  MORNING_DOSE_POLICY,
  checkinLiftsRead,
  classifyMorning,
} from "../dist/repo/morning-dose.js";

const POLICY = MORNING_DOSE_POLICY;

beforeEach(() => {
  resetTables(
    "activities",
    "garmin_activities",
    "garmin_daily_metrics",
    "garmin_sources",
    "daily_metrics",
    "context_events",
    "sessions",
    "logged_sets",
    "exercises",
    "plan_items",
    "plan_days",
    "program_blocks",
    "brain_decisions",
    "brain_expectations",
    "day_reads",
    "suggestions",
    "checkins",
    "training_symptom_events",
    "symptom_reports",
    "health_directives",
    "app_state",
    "settings",
    "profile"
  );
});

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

// Tuesday 2026-10-20, local noon.
function onTuesday(t) {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 9, 20, 12, 0, 0) });
  const today = localDateISO();
  assert.equal(dowOf(today), 2);
  return today;
}

// A lifter with supporting endurance and a band of his own nights (HRV 48–56 ms, resting
// HR 50–54, a full night, readiness that is ordinary). `stated` makes Mon–Fri his stated
// lifting week; otherwise the week is unstated.
function athlete(today, { stated = true } = {}) {
  repo.savePlanDay(1, "Pull", "Back", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 12 },
  ]);
  repo.savePlanDay(2, "Lower", "Legs", [{ exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 8 }]);
  repo.setProfile({
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["muscle", "strength", "endurance"], endurance_role: "supporting" },
    ...(stated ? { strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" } } : {}),
  });
  for (let back = 1; back <= 24; back++) {
    repo.upsertGarminDailyMetric({
      date: addDays(today, -back),
      hrv_ms: [48, 50, 52, 54, 56][back % 5],
      resting_hr: [50, 51, 52, 53, 54][back % 5],
      sleep_min: 460,
      training_readiness: 70,
    });
  }
}

// Yesterday's big endurance day: long enough to be hard on its length alone, and to load
// the legs through the acute gate.
const bigDayYesterday = (today) =>
  repo.addActivity({ type: "run", duration_min: 150, distance_km: 24, date: addDays(today, -1) });

// The incident's morning: rest-grade readiness, last night's HRV below the athlete's band
// for ONE night, resting HR at norm, a full night of sleep.
const LOW_MORNING = { hrv_ms: 36, resting_hr: 52, sleep_min: 460, training_readiness: 12 };
const tonight = (today, night) => repo.upsertGarminDailyMetric({ date: today, ...night });

const decisionFor = (today) => buildDailySessionDecision(gatherDailyDecisionSnapshot(today));

// ══ the pure classifier: every rule, against the policy ══════════════════════════════

const FACTS = {
  rest_grade_today: false,
  low_readiness_mornings: 0,
  short_nights: 0,
  hrv_night: null,
  rhr_night: null,
  hard_endurance_recent: false,
  load_explained: [],
  hrv_rolling: { past_line: false, nights: 0, mornings_below: 0 },
  performance_shortfall: false,
  low_word: false,
  symptom_today: false,
};
const facts = (extra) => ({ ...FACTS, ...extra });
const rhrPast = { past: "meaningful", consecutive: 1 };

test("the classifier: every rule, read against MORNING_DOSE_POLICY", () => {
  // Nothing low: nothing concluded.
  assert.deepEqual(classifyMorning(FACTS, true), { kind: null, basis: null });
  // A: the readiness score alone — the dose on a stated day, easy otherwise, never rest.
  assert.deepEqual(classifyMorning(facts({ rest_grade_today: true, low_readiness_mornings: 1 }), true), {
    kind: "dose",
    basis: "readiness_rest_grade",
  });
  assert.equal(classifyMorning(facts({ rest_grade_today: true, low_readiness_mornings: 1 }), false).kind, "easy");
  // C: the persistence count of low mornings means easy, on any day.
  const persistent = facts({ rest_grade_today: true, low_readiness_mornings: POLICY.low_mornings_for_easy });
  assert.deepEqual(classifyMorning(persistent, true), { kind: "easy", basis: "consecutive_low_mornings" });
  // D: one short night eases; the short-night count means easy.
  assert.equal(classifyMorning(facts({ short_nights: 1 }), true).kind, "dose");
  assert.equal(classifyMorning(facts({ short_nights: 1 }), false).kind, "easy");
  assert.deepEqual(classifyMorning(facts({ short_nights: POLICY.short_nights_for_easy }), true), {
    kind: "easy",
    basis: "consecutive_short_nights",
  });
  // E: resting HR past the band — after hard endurance, easy at most; without, rest.
  const afterEndurance = classifyMorning(facts({ rhr_night: rhrPast, hard_endurance_recent: true }), true);
  assert.equal(afterEndurance.basis, "resting_hr_after_endurance");
  assert.notEqual(afterEndurance.kind, "rest");
  assert.equal(afterEndurance.kind, POLICY.rhr_after_endurance_on_stated_day === "dosed_train" ? "dose" : "easy");
  assert.equal(classifyMorning(facts({ rhr_night: rhrPast, hard_endurance_recent: true }), false).kind, "easy");
  assert.deepEqual(classifyMorning(facts({ rhr_night: rhrPast }), true), {
    kind: "rest",
    basis: "resting_hr_illness_pattern",
  });
  const twoReadings = { past: "marginal", consecutive: POLICY.rhr_illness_consecutive_readings };
  assert.equal(
    classifyMorning(facts({ rhr_night: twoReadings, hard_endurance_recent: true }), true).basis,
    "resting_hr_illness_pattern"
  );
  for (const extra of [{ low_word: true }, { symptom_today: true }])
    assert.equal(
      classifyMorning(facts({ rhr_night: rhrPast, hard_endurance_recent: true, ...extra }), true).kind,
      "rest"
    );
  // B: one low HRV night after hard endurance, resting HR in band — the dose, any day.
  const dip = facts({ hrv_night: { past: "meaningful", consecutive: 1 }, hard_endurance_recent: true });
  assert.deepEqual(classifyMorning(dip, false), { kind: "dose", basis: "overnight_dip_after_endurance" });
  // …without the endurance day behind it, one night concludes nothing here.
  assert.equal(classifyMorning(facts({ hrv_night: { past: "meaningful", consecutive: 1 } }), false).kind, null);
  // F: a sustained rolling decline rests only beside the log-confirmed shortfall.
  const decline = facts({
    hrv_rolling: { past_line: true, nights: 7, mornings_below: POLICY.hrv_sustained_decline_mornings },
  });
  assert.equal(classifyMorning(decline, true).kind, null);
  assert.deepEqual(classifyMorning({ ...decline, performance_shortfall: true }, true), {
    kind: "rest",
    basis: "hrv_decline_with_shortfall",
  });
});

test("the rolling HRV read says nothing below its night floor (absence never brakes)", () => {
  const asOf = "2026-10-20";
  const series = [];
  for (let back = POLICY.hrv_rolling_window_days; back < POLICY.hrv_rolling_window_days + 24; back++)
    series.push({ date: addDays(asOf, -back), value: [48, 50, 52, 54, 56][back % 5] });
  const opts = {
    windowDays: POLICY.hrv_rolling_window_days,
    minNights: POLICY.hrv_rolling_min_nights,
    baselineDays: POLICY.hrv_baseline_days,
  };
  const thin = [...series];
  for (let back = 0; back < POLICY.hrv_rolling_min_nights - 1; back++)
    thin.push({ date: addDays(asOf, -back), value: 30 });
  const few = rollingBandRead(thin, "hrv_ms", asOf, opts);
  assert.equal(few.value, null);
  assert.equal(few.past_line, false, "too few nights in the window: HRV says nothing");
  const full = [...series];
  for (let back = 0; back < POLICY.hrv_rolling_min_nights; back++) full.push({ date: addDays(asOf, -back), value: 30 });
  assert.equal(rollingBandRead(full, "hrv_ms", asOf, opts).past_line, true);
});

test("the check-in lift bar is the policy's", () => {
  const bar = POLICY.checkin_lift_energy_min;
  assert.equal(checkinLiftsRead({ energy: bar }), true);
  assert.equal(checkinLiftsRead({ energy: bar - 1 }), false);
  assert.equal(checkinLiftsRead({ energy: bar, sleep_feel: POLICY.checkin_lift_sleep_feel_veto_max }), false);
  assert.equal(checkinLiftsRead(null), false);
  assert.equal(CHECKIN_LIFT_STEP.easy, "train_held");
});

// ══ A + B: the incident morning on a stated lifting day ══════════════════════════════

test("stated lifting day: rest-grade reading after a big endurance day, one low HRV night, resting HR in band → train, dosed", (t) => {
  const today = onTuesday(t);
  athlete(today);
  bigDayYesterday(today);
  tonight(today, LOW_MORNING);
  const r = repo.dayRead(today);
  const detail = `${r.decision.rule_code}: ${r.why} ${JSON.stringify(r.signals.morning_dose)}`;
  assert.equal(r.kind, "train", detail);
  assert.equal(r.decision.rule_code, "stated_lift_morning_dosed", detail);
  assert.ok(r.focus, "the session that is due is named");
  assert.equal(r.signals.push_bias, undefined, "no reach on a dosed day");
  assert.equal(r.signals.morning_dose.applied, true);
  assert.ok(r.signals.morning_dose.load_explained.length > 0, "provenance names what explained the morning");
  assert.equal(r.signals.calendar_dose.morning, "readiness_rest_grade");
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
  assert.doesNotMatch(r.why, /\d/, "no readiness number reaches the athlete");

  // The daily decision mirrors it: a training day, the load held, no reach, and the
  // regions yesterday's work loaded on the reduced list.
  const snapshot = gatherDailyDecisionSnapshot(today);
  assert.equal(snapshot.day_read.held_dose, "morning");
  const decision = buildDailySessionDecision(snapshot);
  assert.equal(decision.kind, "train");
  assert.notEqual(decision.caps.intensity, "normal", "no load raises");
  assert.notEqual(decision.reach?.level, "push");
  assert.ok(decision.precedence.includes("held_morning_dose"));
  const loaded = snapshot.muscle_load.filter((m) => m.saturated && m.days_ago <= 1).map((m) => m.group);
  for (const group of loaded)
    assert.ok(
      decision.muscles.reduced.includes(group) || decision.muscles.excluded.includes(group),
      `${group}, loaded yesterday, goes lighter`
    );
});

test("E: the same morning with resting HR also past the band after the big day is easy at most — never rest", (t) => {
  const today = onTuesday(t);
  athlete(today);
  bigDayYesterday(today);
  tonight(today, { ...LOW_MORNING, resting_hr: 64 });
  const r = repo.dayRead(today);
  assert.notEqual(r.kind, "rest", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.signals.morning_dose.basis, "resting_hr_after_endurance");
});

test("E: resting HR past the band with no hard day behind it reads as possible illness — rest", (t) => {
  const today = onTuesday(t);
  athlete(today);
  tonight(today, { hrv_ms: 52, resting_hr: 64, sleep_min: 460, training_readiness: 60 });
  const r = repo.dayRead(today);
  assert.equal(r.kind, "rest", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.decision.rule_code, "resting_hr_illness_pattern");
  assert.equal(violatesReadingGrammar(r.why), null);
});

test("C: a second consecutive low morning is easy on a stated day — never dosed, never rest", (t) => {
  const today = onTuesday(t);
  athlete(today);
  // Two days back the big day; yesterday a low morning with nothing trained; today low again.
  repo.addActivity({ type: "run", duration_min: 150, distance_km: 24, date: addDays(today, -2) });
  repo.upsertGarminDailyMetric({
    date: addDays(today, -1),
    hrv_ms: 50,
    resting_hr: 52,
    sleep_min: 460,
    training_readiness: 14,
  });
  tonight(today, { hrv_ms: 50, resting_hr: 52, sleep_min: 460, training_readiness: 12 });
  const r = repo.dayRead(today);
  assert.equal(r.kind, "easy", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.decision.rule_code, "low_mornings_easy");
});

test("D: short nights in a row are easy on a stated day; one short night is the dose", (t) => {
  const today = onTuesday(t);
  athlete(today);
  tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 290, training_readiness: 60 });
  const one = repo.dayRead(today);
  assert.equal(one.kind, "train", `${one.decision.rule_code}: ${one.why}`);
  assert.equal(one.decision.rule_code, "stated_lift_morning_dosed");
  for (let back = 1; back < POLICY.short_nights_for_easy; back++)
    repo.upsertGarminDailyMetric({ date: addDays(today, -back), sleep_min: 290 });
  const many = repo.dayRead(today);
  assert.equal(many.kind, "easy", `${many.decision.rule_code}: ${many.why}`);
  assert.equal(many.decision.rule_code, "acute_sleep_corroborated");
});

test("the athlete's own low word, corroborated by the reading, is still rest", (t) => {
  const today = onTuesday(t);
  athlete(today);
  bigDayYesterday(today);
  tonight(today, LOW_MORNING);
  repo.addCheckin(today, { energy: 1 });
  const r = repo.dayRead(today);
  assert.equal(r.kind, "rest", `${r.decision.rule_code}: ${r.why}`);
});

test("A on an unstated day: the rest-grade reading alone reads easy, never rest and never a dosed train", (t) => {
  const today = onTuesday(t);
  athlete(today, { stated: false });
  bigDayYesterday(today);
  tonight(today, LOW_MORNING);
  const r = repo.dayRead(today);
  assert.equal(r.kind, "easy", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.decision.rule_code, "rest_grade_readiness");
  assert.ok(DAY_READ_WHY_VARIANTS.rest_grade_readiness.includes(r.why) || r.why.length > 0);
});

test("B on an unstated day: one low HRV night after a big endurance day keeps the session at a held dose", (t) => {
  const today = onTuesday(t);
  athlete(today, { stated: false });
  bigDayYesterday(today);
  tonight(today, { hrv_ms: 36, resting_hr: 52, sleep_min: 460, training_readiness: 62 });
  const r = repo.dayRead(today);
  assert.equal(r.kind, "train", `${r.decision.rule_code}: ${r.why} ${JSON.stringify(r.signals.morning_dose)}`);
  assert.equal(r.decision.rule_code, "overnight_dip_dosed");
  assert.equal(r.signals.push_bias, undefined);
  assert.notEqual(decisionFor(today).caps.intensity, "normal");
});

// ══ race morning ═════════════════════════════════════════════════════════════════════

test("race morning never reads rest — not off a stacked week, not off a rest-grade reading", (t) => {
  const today = onTuesday(t);
  athlete(today);
  repo.setProfile({ endurance_goal: { mode: "race", event: "City Half", date: today, distance_km: 21.1 } });
  for (let back = 1; back <= 4; back++)
    repo.addActivity({ type: "run", duration_min: 70, distance_km: 12, date: addDays(today, -back) });
  repo.addContextEvent({ kind: "travel", title: "Away for the race", start_date: today, end_date: today });
  tonight(today, LOW_MORNING);
  const r = repo.dayRead(today);
  assert.equal(r.kind, "train", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.decision.rule_code, "goal_race_day");
  assert.match(r.why, /\brace\b/i);
  assert.equal(violatesReadingGrammar(r.why), null);
});

// ══ G: the athlete's own good check-in ═══════════════════════════════════════════════

test("G: a good check-in lifts a readiness-only easy read one step, held, and says the two disagreed", (t) => {
  const today = onTuesday(t);
  athlete(today, { stated: false });
  bigDayYesterday(today);
  tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 460, training_readiness: 12 });
  const before = repo.dayRead(today);
  assert.equal(before.kind, "easy", `${before.decision.rule_code}: ${before.why}`);

  repo.addCheckin(today, { energy: POLICY.checkin_lift_energy_min, sleep_feel: 4 });
  const r = repo.dayRead(today);
  assert.equal(
    r.kind,
    "train",
    `${r.decision.rule_code}: ${r.why} ${JSON.stringify(r.signals.checkin_lift)} ${JSON.stringify(r.signals.deciding_brakes)}`
  );
  assert.equal(r.decision.rule_code, "checkin_lifted_train");
  assert.ok(
    DAY_READ_WHY_VARIANTS.checkin_lifted_train.some((variant) => r.why.endsWith(variant)),
    `the why says what the tap bought: ${r.why}`
  );
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
  assert.notEqual(decisionFor(today).caps.intensity, "normal", "the lifted day keeps its intensity held");
  assert.notEqual(dayReadProseIdentity(today, r), dayReadProseIdentity(today, before), "a genuine new identity");
});

test("G: the check-in lifts nothing but the readiness score — a short night or the illness pattern stand", (t) => {
  const today = onTuesday(t);
  athlete(today, { stated: false });
  tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 290, training_readiness: 60 });
  repo.addCheckin(today, { energy: 5, sleep_feel: 4 });
  const short = repo.dayRead(today);
  // The short night eases the day (through the protect posture, whose sleep constraint
  // it is); the tap does not lift it.
  assert.equal(short.kind, "easy", `${short.decision.rule_code}: ${short.why}`);
  assert.notEqual(short.decision.rule_code, "checkin_lifted_train");
  assert.equal(short.signals.checkin_lift?.applied ?? false, false);

  tonight(today, { hrv_ms: 52, resting_hr: 64, sleep_min: 460, training_readiness: 60 });
  const ill = repo.dayRead(today);
  assert.equal(ill.kind, "rest", `${ill.decision.rule_code}: ${ill.why}`);
  assert.equal(ill.decision.rule_code, "resting_hr_illness_pattern");
});

test("G: a neutral tap (below the lift bar) changes nothing", (t) => {
  const today = onTuesday(t);
  athlete(today, { stated: false });
  bigDayYesterday(today);
  tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 460, training_readiness: 12 });
  const before = repo.dayRead(today);
  repo.addCheckin(today, { energy: POLICY.checkin_lift_energy_min - 1 });
  const after = repo.dayRead(today);
  assert.equal(after.kind, before.kind);
  assert.equal(after.decision.rule_code, before.decision.rule_code);
  assert.equal(after.signals.checkin_lift, undefined);
});

test("G: a positive check-in re-reads the day — the cached read is retired and the lift is spoken", (t) => {
  const today = onTuesday(t);
  athlete(today, { stated: false });
  bigDayYesterday(today);
  tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 460, training_readiness: 12 });
  const before = repo.dayRead(today);
  repo.saveDayRead(today, { ...before, headline: "Easy today.", source: "deterministic", override: null });
  assert.ok(getCachedDayRead(today), "a warm read is cached");
  repo.addCheckin(today, { energy: 5, sleep_feel: 4 });
  assert.equal(getCachedDayRead(today), null, "the check-in write retired the cached read");
  const after = repo.dayRead(today);
  assert.equal(after.decision.rule_code, "checkin_lifted_train");
  assert.notEqual(after.input_fingerprint, before.input_fingerprint, "the decision fingerprint moved");
});

test("the agent may not read a reserved morning all the way to rest (its steer may)", async () => {
  const { enforceRestReservation } = await import("../dist/dayread.js");
  const baseline = {
    kind: "train",
    focus: "Race day",
    why: "Race day.",
    decision: { rule_code: "goal_race_day" },
    signals: {},
  };
  const agentRest = { kind: "rest", source: "agent", why: "Rest today.", agent: "stub", tried: [] };
  const clamped = enforceRestReservation(agentRest, baseline, false, "2026-10-20");
  assert.equal(clamped.kind, "train");
  assert.equal(clamped.decision.rule_code, "agent_rest_reserved");
  assert.equal(enforceRestReservation(agentRest, baseline, true, "2026-10-20").kind, "rest", "the athlete's steer wins");
  const easier = { ...agentRest, kind: "easy" };
  assert.equal(enforceRestReservation(easier, baseline, false, "2026-10-20").kind, "easy", "quieter is still allowed");
  const ownRest = { ...baseline, kind: "easy", decision: { rule_code: "felt_low_easy" } };
  assert.equal(enforceRestReservation(agentRest, ownRest, false, "2026-10-20").kind, "rest");
});
