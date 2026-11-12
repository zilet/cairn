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
import { db, repo, resetTables } from "./_seed.js";
import { localDateISO } from "../dist/repo/shared.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { DAY_READ_WHY_VARIANTS, MORNING_DOSE_CAUSE, dayReadProseIdentity } from "../dist/repo/day-read-prose.js";
import { buildDailySessionDecision, gatherDailyDecisionSnapshot } from "../dist/repo/daily-decision.js";
import { getCachedDayRead } from "../dist/repo/day-read-cache.js";
import { rollingBandRead } from "../dist/repo/overnight-band.js";
import {
  CHECKIN_LIFT_STEP,
  MORNING_DOSE_POLICY,
  checkinLiftsBrakes,
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

// ══ THE MORNING THAT MOTIVATED THIS WHOLE CHANGE SET ═══════════════════════════════════
// A stated lifting week; yesterday a long run (or a long ride); last night HRV well below
// the athlete's band, resting HR in band, an ordinary readiness reading. One low HRV night
// inside the endurance window is a held dose on ANY day with a session due, stated or not —
// loads held, no reach, yesterday's loaded regions lighter, the plan's sets otherwise —
// and the read says so. (Second review, item 1: the leg-only hybrid-interference brake on
// a pull day used to swallow the dose: planned_training, caps open, HRV never mentioned.)

const assertHeldHrvDose = (today, label) => {
  const r = repo.dayRead(today);
  const detail = `${label}: ${r.decision.rule_code}: ${r.why} ${JSON.stringify(r.signals.morning_dose)}`;
  assert.equal(r.kind, "train", detail);
  assert.equal(r.signals.morning_dose.basis, "overnight_dip_after_endurance", detail);
  assert.equal(r.signals.morning_dose.applied, true, detail);
  assert.ok(
    ["stated_lift_morning_dosed", "overnight_dip_dosed"].includes(r.decision.rule_code),
    `the held dose speaks: ${detail}`
  );
  assert.match(r.why, /\bHRV\b/, `the read names last night's HRV: ${r.why}`);
  assert.equal(r.signals.push_bias, undefined, "no reach on a held dose");
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
  const snapshot = gatherDailyDecisionSnapshot(today);
  assert.equal(snapshot.day_read.held_dose, "morning", label);
  const decision = buildDailySessionDecision(snapshot);
  assert.equal(decision.kind, "train", label);
  assert.notEqual(decision.caps.intensity, "normal", `${label}: loads held — ${decision.precedence}`);
  assert.equal(decision.caps.volume, "normal", `${label}: the plan's sets otherwise — ${decision.precedence}`);
  assert.notEqual(decision.reach?.level, "push", label);
  assert.ok(decision.precedence.includes("held_morning_dose"), `${label}: ${decision.precedence}`);
  return r;
};

for (const readiness of [70, 50])
  for (const [endurance, add] of [
    ["a 24 km run", (today) => bigDayYesterday(today)],
    ["a 3 h ride", (today) => repo.addActivity({ type: "ride", duration_min: 180, distance_km: 80, date: addDays(today, -1) })],
  ])
    test(`B, the incident morning: stated lifting week, ${endurance} yesterday, one low HRV night, readiness ${readiness} → a held dose that says HRV`, (t) => {
      const today = onTuesday(t);
      athlete(today);
      add(today);
      tonight(today, { hrv_ms: 36, resting_hr: 52, sleep_min: 460, training_readiness: readiness });
      assertHeldHrvDose(today, `stated, ${endurance}, readiness ${readiness}`);
    });

test("B, the incident morning with NO stated week is the same held dose", (t) => {
  const today = onTuesday(t);
  athlete(today, { stated: false });
  bigDayYesterday(today);
  tonight(today, { hrv_ms: 36, resting_hr: 52, sleep_min: 460, training_readiness: 70 });
  const r = assertHeldHrvDose(today, "unstated");
  assert.equal(r.decision.rule_code, "overnight_dip_dosed");
});

// ══ A: a worse readiness score never buys a more permissive day (second review, item 2) ══
// The composite score is an unvalidated input: it never cuts whole-session volume by
// itself, in either band, and on a stated day both bands are the SAME held dose.

const VOLUME_RANK = { normal: 0, reduced: 1, minimal: 2 };
const INTENSITY_RANK = { normal: 0, hold: 1, deload: 2, easy: 3 };
const READINESS_SWEEP = [95, 80, 66, 60, 50, 40, 39, 34, 30, 25, 20, 19, 12, 5];

for (const stated of [true, false])
  test(`A, monotone: sweeping readiness top to bottom on an otherwise identical ${stated ? "stated" : "unstated"} morning never makes the caps more permissive`, (t) => {
    const today = onTuesday(t);
    athlete(today, { stated });
    let prev = null;
    for (const readiness of READINESS_SWEEP) {
      tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 460, training_readiness: readiness });
      const r = repo.dayRead(today);
      const decision = decisionFor(today);
      const now = {
        readiness,
        code: r.decision.rule_code,
        volume: VOLUME_RANK[decision.caps.volume],
        intensity: INTENSITY_RANK[decision.caps.intensity],
        caps: decision.caps,
      };
      if (prev) {
        const detail = `${prev.readiness} (${prev.code} ${JSON.stringify(prev.caps)}) → ${readiness} (${now.code} ${JSON.stringify(now.caps)})`;
        assert.ok(now.volume >= prev.volume, `volume opened as readiness fell: ${detail}`);
        assert.ok(now.intensity >= prev.intensity, `intensity opened as readiness fell: ${detail}`);
      }
      prev = now;
    }
  });

test("A, stated day: the low band and the rest-grade band are the SAME held dose — the score alone trims no sets", (t) => {
  const today = onTuesday(t);
  athlete(today);
  const seen = [];
  for (const readiness of [30, 12]) {
    tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 460, training_readiness: readiness });
    const r = repo.dayRead(today);
    const detail = `readiness ${readiness}: ${r.decision.rule_code}: ${r.why}`;
    assert.equal(r.kind, "train", detail);
    assert.equal(r.decision.rule_code, "stated_lift_morning_dosed", detail);
    assert.equal(r.signals.push_bias, undefined, detail);
    assert.equal(violatesReadingGrammar(r.why), null, r.why);
    assert.doesNotMatch(r.why, /\d/, r.why);
    const decision = decisionFor(today);
    assert.ok(decision.precedence.includes("held_morning_dose"), `${detail} ${decision.precedence}`);
    seen.push({ volume: decision.caps.volume, intensity: decision.caps.intensity });
    assert.equal(decision.caps.volume, "normal", `${detail}: the score alone trims no sets — ${decision.precedence}`);
    assert.equal(decision.caps.intensity, "hold", detail);
    assert.notEqual(decision.reach?.level, "push", detail);
  }
  assert.deepEqual(seen[0], seen[1], "both bands, one dose");
});

test("A: on a train read a low readiness score trims the sets only beside a corroborating deciding brake", (t) => {
  const today = onTuesday(t);
  athlete(today, { stated: false });
  tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 460, training_readiness: 80 });
  repo.dayRead(today);
  const base = gatherDailyDecisionSnapshot(today);
  assert.equal(base.day_read.kind, "train");
  const support = {
    training_drive: "steady",
    backed: false,
    backed_by: [],
    training_directive: "proceed",
    fresh_brake: true,
  };
  const low = { ...base, recovery: { ...base.recovery, readiness: "low" }, recovery_capacity: undefined };
  // The score alone (the board's only deciding brake): the plan's sets, the load held.
  const alone = buildDailySessionDecision({ ...low, signal_support: { ...support, readiness_brake_only: true } });
  assert.equal(alone.caps.volume, "normal", alone.precedence.join(","));
  assert.equal(alone.caps.intensity, "hold");
  // …with no brake on the board at all, the raw score is alone too.
  const raw = buildDailySessionDecision({ ...low, signal_support: undefined });
  assert.equal(raw.caps.volume, "normal", raw.precedence.join(","));
  // Beside a deciding brake of another kind (a short night, resting HR, the athlete's word):
  // a named, corroborated reason — the sets come down.
  const corroborated = buildDailySessionDecision({ ...low, signal_support: support });
  assert.equal(corroborated.caps.volume, "reduced", corroborated.precedence.join(","));
});

// ══ the pure classifier: every rule, against the policy ══════════════════════════════

const FACTS = {
  rest_grade_today: false,
  low_readiness_mornings: 0,
  short_nights: 0,
  last_night_min: null,
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
// One night past the athlete's own established band, on a reading its own row vouches for.
const rhrPast = { past: "meaningful", consecutive: 1, consecutive_days: 1, established_band: true, verified: true };
const hrvLow = { past: "meaningful", consecutive: 1, consecutive_days: 1, established_band: true, verified: true };

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
  // D: one short night is the dose on ANY day (the session due keeps its place, held);
  // the short-night count means easy, and so does one severely short night.
  assert.equal(classifyMorning(facts({ short_nights: 1, last_night_min: 300 }), true).kind, "dose");
  assert.deepEqual(classifyMorning(facts({ short_nights: 1, last_night_min: 300 }), false), {
    kind: "dose",
    basis: "short_night",
  });
  assert.deepEqual(
    classifyMorning(facts({ short_nights: 1, last_night_min: POLICY.severe_short_night_max_min - 1 }), true),
    { kind: "easy", basis: "severe_short_night" }
  );
  assert.deepEqual(classifyMorning(facts({ short_nights: POLICY.short_nights_for_easy }), true), {
    kind: "easy",
    basis: "consecutive_short_nights",
  });
  // E: resting HR past the band — after hard endurance, easy at most (on EVERY day, stated
  // or not); without, rest.
  const afterEndurance = classifyMorning(facts({ rhr_night: rhrPast, hard_endurance_recent: true }), true);
  assert.equal(afterEndurance.basis, "resting_hr_after_endurance");
  assert.equal(afterEndurance.kind, "easy", "resting HR past the band after hard endurance is easy on a stated day too");
  assert.equal(classifyMorning(facts({ rhr_night: rhrPast, hard_endurance_recent: true }), false).kind, "easy");
  // …and HRV past the band beside it is a second, independent witness: never a training day.
  assert.equal(
    classifyMorning(facts({ rhr_night: rhrPast, hrv_night: hrvLow, hard_endurance_recent: true }), true).kind,
    "easy"
  );
  assert.deepEqual(classifyMorning(facts({ rhr_night: rhrPast }), true), {
    kind: "rest",
    basis: "resting_hr_illness_pattern",
  });
  const twoReadings = {
    ...rhrPast,
    past: "marginal",
    consecutive: POLICY.rhr_illness_consecutive_readings,
    consecutive_days: POLICY.rhr_illness_consecutive_readings,
  };
  assert.equal(
    classifyMorning(facts({ rhr_night: twoReadings, hard_endurance_recent: true }), true).basis,
    "resting_hr_illness_pattern"
  );
  // "Twice running" is two consecutive CALENDAR mornings: readings days apart are not.
  const apart = { ...twoReadings, consecutive_days: 1 };
  assert.notEqual(
    classifyMorning(facts({ rhr_night: apart, hard_endurance_recent: true }), true).kind,
    "rest",
    "two readings days apart are not a repeat"
  );
  // One night rests only on an established band of the athlete's own AND a vouched reading;
  // otherwise it is a caution, easy at most.
  for (const thin of [
    { ...rhrPast, established_band: false },
    { ...rhrPast, verified: false },
  ])
    assert.deepEqual(classifyMorning(facts({ rhr_night: thin }), true), {
      kind: "easy",
      basis: "resting_hr_unconfirmed",
    });
  for (const extra of [{ low_word: true }, { symptom_today: true }])
    assert.equal(
      classifyMorning(facts({ rhr_night: rhrPast, hard_endurance_recent: true, ...extra }), true).kind,
      "rest"
    );
  // B: one low HRV night after hard endurance, resting HR in band — the dose, any day.
  const dip = facts({ hrv_night: hrvLow, hard_endurance_recent: true });
  assert.deepEqual(classifyMorning(dip, false), { kind: "dose", basis: "overnight_dip_after_endurance" });
  // …without the endurance day behind it, one night concludes nothing here.
  assert.equal(classifyMorning(facts({ hrv_night: hrvLow }), false).kind, null);
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

test("the rolling HRV read needs a recent night: old nights alone never make a decline", () => {
  const asOf = "2026-10-20";
  const series = [];
  for (let back = POLICY.hrv_rolling_window_days; back < POLICY.hrv_rolling_window_days + 24; back++)
    series.push({ date: addDays(asOf, -back), value: [48, 50, 52, 54, 56][back % 5] });
  const opts = {
    windowDays: POLICY.hrv_rolling_window_days,
    minNights: POLICY.hrv_rolling_min_nights,
    baselineDays: POLICY.hrv_baseline_days,
    recentNightDays: POLICY.hrv_rolling_recent_night_days,
  };
  // Enough low nights in the window — but every one of them older than the anchor.
  const stale = [...series];
  for (let back = POLICY.hrv_rolling_recent_night_days; back < POLICY.hrv_rolling_window_days; back++)
    stale.push({ date: addDays(asOf, -back), value: 30 });
  assert.equal(rollingBandRead(stale, "hrv_ms", asOf, opts).past_line, false, "no night in the last two days");
  // One valid night inside the anchor and the same window speaks.
  const anchored = [...stale, { date: asOf, value: 30 }];
  assert.equal(rollingBandRead(anchored, "hrv_ms", asOf, opts).past_line, true);
});

test("the check-in lift bar is the policy's", () => {
  const bar = POLICY.checkin_lift_energy_min;
  assert.equal(checkinLiftsRead({ energy: bar }), true);
  assert.equal(checkinLiftsRead({ energy: bar - 1 }), false);
  assert.equal(checkinLiftsRead({ energy: bar, sleep_feel: POLICY.checkin_lift_sleep_feel_veto_max }), false);
  assert.equal(checkinLiftsRead(null), false);
  assert.equal(CHECKIN_LIFT_STEP.easy, "train_held");
});

test("G: a tap lifts only the readiness score or a single low HRV night — never acute load, resting HR or sleep", () => {
  const lifts = new Set([...POLICY.checkin_liftable_brakes, ...POLICY.checkin_lift_tolerated_brakes]);
  assert.deepEqual([...POLICY.checkin_liftable_brakes].sort(), ["hrv", "training_readiness"]);
  for (const never of ["acute_load", "resting_hr", "sleep", "sleep_trend"])
    assert.equal(lifts.has(never), false, `${never} is never a tap's to lift`);
  // The comparison the read makes, exactly.
  assert.equal(checkinLiftsBrakes(["training_readiness"], false), true);
  assert.equal(checkinLiftsBrakes(["training_readiness", "hybrid_interference"], false), true);
  assert.equal(checkinLiftsBrakes(["training_readiness", "acute_load"], false), false, "acute load holds the read");
  assert.equal(checkinLiftsBrakes(["training_readiness", "resting_hr"], false), false);
  assert.equal(checkinLiftsBrakes(["training_readiness", "sleep"], false), false);
  assert.equal(checkinLiftsBrakes(["hrv"], true), true, "a single low HRV night lifts");
  assert.equal(checkinLiftsBrakes(["hrv"], false), false, "a run of low HRV nights does not");
  assert.equal(checkinLiftsBrakes(["hybrid_interference"], false), false, "something liftable must be there");
});

// ══ 6: every phrasing is true of the morning it prints on ═══════════════════════════════

test("no morning-dose sentence states a single night as settled fact", () => {
  for (const set of Object.values(MORNING_DOSE_CAUSE))
    for (const line of set) assert.doesNotMatch(line, /\bexpected response\b|\bnot a warning\b/i, line);
});

test("a rest-grade reading with nothing behind it never blames yesterday, and promises no lighter areas", (t) => {
  const today = onTuesday(t);
  athlete(today);
  // No work yesterday at all: the readiness number alone.
  tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 460, training_readiness: 12 });
  const r = repo.dayRead(today);
  assert.equal(r.decision.rule_code, "stated_lift_morning_dosed", `${r.decision.rule_code}: ${r.why}`);
  assert.deepEqual(r.signals.morning_dose.load_explained, []);
  assert.doesNotMatch(r.why, /\byesterday\b|\bbig day\b|\bhard day\b/i, r.why);
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
});

test("E: a first resting-HR reading never says 'again'; a second consecutive morning does", (t) => {
  const today = onTuesday(t);
  athlete(today);
  tonight(today, { hrv_ms: 52, resting_hr: 66, sleep_min: 460, training_readiness: 60 });
  const first = repo.dayRead(today);
  assert.equal(first.decision.rule_code, "resting_hr_illness_pattern");
  assert.ok(DAY_READ_WHY_VARIANTS.resting_hr_illness_pattern.includes(first.why), first.why);
  assert.doesNotMatch(first.why, /\bagain\b|\bin a row\b|\brunning\b/i);
  repo.upsertGarminDailyMetric({ date: addDays(today, -1), hrv_ms: 52, resting_hr: 66, sleep_min: 460 });
  const second = repo.dayRead(today);
  assert.equal(second.decision.rule_code, "resting_hr_illness_pattern");
  assert.ok(DAY_READ_WHY_VARIANTS["resting_hr_illness_pattern:repeat"].includes(second.why), second.why);
});

// ══ 11: a single-night illness REST needs a band of the athlete's own and a vouched reading ══

test("E: one high resting-HR reading on the watch's fallback average (no band of their own) is a caution, never rest", (t) => {
  const today = onTuesday(t);
  repo.savePlanDay(1, "Pull", "Back", [{ exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 }]);
  // A new user: two nights of history, so no personal band; the watch's 7-day average.
  for (let back = 1; back <= 2; back++)
    repo.upsertGarminDailyMetric({ date: addDays(today, -back), resting_hr: 55, hr_7d_avg: 55, sleep_min: 460 });
  tonight(today, { resting_hr: 62, hr_7d_avg: 55, sleep_min: 460, min_hr: 58 });
  const r = repo.dayRead(today);
  assert.notEqual(r.kind, "rest", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.signals.morning_dose.basis, "resting_hr_unconfirmed");
  assert.equal(r.decision.rule_code, "resting_hr_caution_easy");
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
});

test("E: one high resting-HR reading its own row cannot vouch for (no floor, no night) is a caution, never rest", (t) => {
  const today = onTuesday(t);
  athlete(today);
  // A phone row: resting HR, no min_hr and no night beside it.
  db.prepare(`INSERT INTO daily_metrics (source, date, resting_hr) VALUES ('apple', ?, 66)`).run(today);
  const r = repo.dayRead(today);
  assert.notEqual(r.kind, "rest", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.signals.morning_dose.basis, "resting_hr_unconfirmed");
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
  // One source of truth: the read promised the plan's sets everywhere but the regions
  // yesterday loaded — the low readiness the dose answered is not a whole-session trim.
  assert.equal(decision.caps.volume, "normal", `the held dose trims no whole session: ${decision.precedence}`);
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
  // A stated lifting day, HRV AND resting HR past the band, a rest-grade reading: two
  // independent witnesses after the hard day — easy, never a training day, never rest.
  assert.equal(r.kind, "easy", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.signals.morning_dose.basis, "resting_hr_after_endurance");
  assert.equal(r.decision.rule_code, "resting_hr_after_endurance_easy", "spoken in its own voice");
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
});

test("E: resting HR alone past the band after hard endurance is easy on a stated day too", (t) => {
  const today = onTuesday(t);
  athlete(today);
  bigDayYesterday(today);
  tonight(today, { hrv_ms: 52, resting_hr: 64, sleep_min: 460, training_readiness: 60 });
  const r = repo.dayRead(today);
  assert.equal(r.kind, "easy", `${r.decision.rule_code}: ${r.why}`);
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

const raceToday = (today) =>
  repo.setProfile({ endurance_goal: { mode: "race", event: "City Half", date: today, distance_km: 21.1 } });

test("race morning over the resting-HR illness pattern still reads the race, says what the body shows, and lets the start line decide", (t) => {
  const today = onTuesday(t);
  athlete(today);
  raceToday(today);
  // Nothing hard in the taper; resting HR far above the athlete's band.
  tonight(today, { hrv_ms: 52, resting_hr: 66, sleep_min: 460, training_readiness: 60 });
  const r = repo.dayRead(today);
  assert.equal(r.kind, "train", `${r.decision.rule_code}: ${r.why}`);
  assert.equal(r.decision.rule_code, "goal_race_day");
  assert.equal(r.signals.morning_dose.basis, "resting_hr_illness_pattern");
  assert.match(r.why, /\bresting heart rate\b/i, `it says what the body is showing: ${r.why}`);
  assert.match(r.why, /\bstart\b/i, `how they feel at the start decides: ${r.why}`);
  assert.equal(violatesReadingGrammar(r.why), null, r.why);
  assert.doesNotMatch(r.why, /\d/);
});

test("race morning: the daily decision composes no lifting card and reports no open lifting caps", async (t) => {
  const { deterministicComposedSession } = await import("../dist/repo/daily-composition.js");
  const today = onTuesday(t);
  athlete(today);
  raceToday(today);
  tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 460, training_readiness: 70 });
  const r = repo.dayRead(today);
  assert.equal(r.decision.rule_code, "goal_race_day");
  const snapshot = gatherDailyDecisionSnapshot(today);
  assert.equal(snapshot.day_read.race_day, true);
  const decision = buildDailySessionDecision(snapshot);
  assert.ok(decision.precedence.includes("goal_race_day"), decision.precedence.join(","));
  assert.ok(
    !(decision.caps.volume === "normal" && decision.caps.intensity === "normal"),
    `race day reports no open lifting caps: ${JSON.stringify(decision.caps)}`
  );
  assert.notEqual(decision.reach?.level, "push");
  const card = deterministicComposedSession(decision);
  assert.equal(card.items.length, 0, "no lifting card on race morning");
  assert.match(card.name, /\brace\b/i);
});

test("race morning never overrides the athlete's own low word or a symptom stated today", (t) => {
  const today = onTuesday(t);
  athlete(today);
  raceToday(today);
  tonight(today, { hrv_ms: 52, resting_hr: 52, sleep_min: 460, training_readiness: 70 });
  repo.addCheckin(today, { energy: 1 });
  const word = repo.dayRead(today);
  assert.notEqual(word.decision.rule_code, "goal_race_day", `${word.decision.rule_code}: ${word.why}`);
  repo.addCheckin(today, { energy: 4 });
  repo.reportTrainingSymptom({ area_text: "left calf", onset_on: today });
  const symptom = repo.dayRead(today);
  assert.notEqual(symptom.decision.rule_code, "goal_race_day", `${symptom.decision.rule_code}: ${symptom.why}`);
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
  // One short night is the dose (morning-dose.ts, D): the session due keeps its place,
  // held — the short night's own read, never the tap's.
  assert.equal(short.decision.rule_code, "short_night_dosed", `${short.decision.rule_code}: ${short.why}`);
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
