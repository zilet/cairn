// weekMapKeyRuns.test.js — the lifting week keeps its leg day off the key runs, and a
// plan day's stored focus never states a calendar the week no longer has.
//
// The live week of 2026-10-19 (shape only, no real data): lifts Mon–Fri, runs Thursday
// (quality, a threshold session) / Friday (easy) / Sunday (long). Plan: 1 Push A,
// 2 Lower ("the week's one leg day"), 3 Upper back & arms, 4 Push B, 5 Pull. Last week
// ended on Push A Thursday and Lower Friday, and this Monday logged Upper back & arms,
// so the log-anchored ring deals Mon=3, Tue=4, Wed=5, Thu=1, Fri=2 — Lower on Friday,
// the morning after the threshold run and the same day as the easy run. The placement
// trades it onto Tuesday (the only lifting weekday clear of every key run: Monday is the
// day after the long run, Wednesday the eve of the quality run) and Push B onto Friday.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import {
  heavyLowerWeekdaySlots,
  keyRunAwarePlacement,
  planDayCandidates,
  selectAdaptivePlanDay,
  strengthPlanDayOn,
  thisWeekPlanDayMap,
  weekdayPlanDayMap,
} from "../dist/repo/plan-selection.js";
import {
  calendarFocusPhrase,
  datedPlanDayFocus,
  hasCalendarClaim,
  stripCalendarClaims,
} from "../dist/repo/plan-day-focus.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { raceBuild } from "../dist/repo/race-build.js";

// 2031-07-14 is a Monday.
const LAST_THU = "2031-07-10";
const LAST_FRI = "2031-07-11";
const MON = "2031-07-14";
const TUE = "2031-07-15";
const WED = "2031-07-16";
const THU = "2031-07-17";
const FRI = "2031-07-18";
const NEXT_MON = "2031-07-21";
const WEEK = [MON, TUE, WED, THU, FRI];

const LOWER_FOCUS =
  "The week's one leg day — squat, hinge and single-leg work, two clear days from Thursday's threshold run and Sunday's long run. Nothing on the legs before Thursday.";
const PUSH_B_FOCUS = "Upper body only on the threshold-run day.";
const UPPER_FOCUS = "Upper back and arms, the day after deadlifts.";

const lift = (exercise, extra = {}) => ({ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight: 100, ...extra });

function seedPlan() {
  for (const [name, muscle_group] of [
    ["Barbell Bench Press", "chest"],
    ["Triceps Pushdown", "triceps"],
    ["Back Squat", "quads"],
    ["Deadlift", "hamstrings"],
    ["Bulgarian Split Squat", "quads"],
    ["Standing Calf Raise", "calves"],
    ["Barbell Row", "back"],
    ["Barbell Curl", "biceps"],
    ["Incline Dumbbell Press", "chest"],
    ["Overhead Press", "shoulders"],
    ["Lat Pulldown", "back"],
    ["Face Pull", "shoulders"],
  ])
    repo.upsertExercise({ name, muscle_group, mode: "reps" });
  repo.savePlanDay(1, "Push A", "Chest and triceps", [lift("Barbell Bench Press"), lift("Triceps Pushdown")]);
  repo.savePlanDay(2, "Lower", LOWER_FOCUS, [
    lift("Back Squat"),
    lift("Deadlift"),
    lift("Bulgarian Split Squat"),
    lift("Standing Calf Raise"),
  ]);
  repo.savePlanDay(3, "Upper back & arms", UPPER_FOCUS, [lift("Barbell Row"), lift("Barbell Curl")]);
  repo.savePlanDay(4, "Push B", PUSH_B_FOCUS, [lift("Incline Dumbbell Press"), lift("Overhead Press")]);
  repo.savePlanDay(5, "Pull", "Lats and rear delts", [lift("Lat Pulldown"), lift("Face Pull")]);
}

function seedAthlete({ race = false } = {}) {
  seedPlan();
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: {
      priorities: ["longevity", "muscle", "strength", "leanness", "endurance"],
      endurance_role: "supporting",
    },
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 4, kind: "quality" },
        { dow: 5, kind: "easy" },
        { dow: 0, kind: "long" },
      ],
      quality: { type: "threshold" },
      source: "athlete",
    },
    ...(race
      ? { endurance_goal: { mode: "race", event: "Harbour Half", date: "2031-08-31", distance_km: 21.1 } }
      : {}),
  });
}

const first = { "Push A": "Barbell Bench Press", Lower: "Back Squat", "Upper back & arms": "Barbell Row", "Push B": "Incline Dumbbell Press", Pull: "Lat Pulldown" };
const DAY_NAME = { 1: "Push A", 2: "Lower", 3: "Upper back & arms", 4: "Push B", 5: "Pull" };

function logDay(date, dayNumber) {
  const exercise = first[DAY_NAME[dayNumber]];
  for (let i = 0; i < 3; i++) repo.logSetByName({ date, exercise, weight: 100, reps: 7, day_number: dayNumber });
}

/** The incident's log: last week ended Push A Thursday, Lower Friday; this Monday did Upper back & arms. */
function seedIncidentLog() {
  logDay(LAST_THU, 1);
  logDay(LAST_FRI, 2);
  logDay(MON, 3);
}

const byDow = (week) => Object.fromEntries([...week.map].map(([dow, day]) => [dow, day.day_number]));

// ---------- the pure placement ----------

const day = (day_number, lower = false) => ({ day_number, names: ["x"], lower });
const isLower = (d) => d.lower;
const ring = (entries) => new Map(entries.map(([dow, d]) => [dow, d]));

test("pure: the incident deal trades Friday's Lower onto Tuesday and Push B onto Friday", () => {
  const dealt = ring([
    [1, day(3)],
    [2, day(4)],
    [3, day(5)],
    [4, day(1)],
    [5, day(2, true)],
  ]);
  const { map, swaps } = keyRunAwarePlacement(dealt, { keyRunDows: [4, 0], open: [2, 3, 4, 5], isLower });
  assert.deepEqual(
    [...map].map(([dow, d]) => [dow, d.day_number]),
    [
      [1, 3],
      [2, 2],
      [3, 5],
      [4, 1],
      [5, 4],
    ]
  );
  assert.deepEqual(swaps, [{ day_number: 2, from_dow: 5, to_dow: 2 }]);
  assert.equal(dealt.get(5).day_number, 2, "the input map is never mutated");
});

test("pure: no clean slot, no trade — the stack stays the voice", () => {
  // Lifts Mon/Wed/Fri around Tue easy, Thu quality, Sun long: every lifting weekday sits
  // on or beside a key run.
  const dealt = ring([
    [1, day(1)],
    [3, day(2, true)],
    [5, day(3)],
  ]);
  const { map, swaps } = keyRunAwarePlacement(dealt, { keyRunDows: [4, 0], open: [1, 3, 5], isLower });
  assert.deepEqual(swaps, []);
  assert.equal(map.get(3).day_number, 2);
});

test("pure: a closed day neither gives nor takes", () => {
  const dealt = ring([
    [1, day(1)],
    [2, day(2, true)],
    [3, day(3)],
  ]);
  // Wednesday is a quality day, so Tuesday's Lower is its eve; Monday is the clean slot.
  const open = keyRunAwarePlacement(dealt, { keyRunDows: [3], open: [1, 2, 3], isLower });
  assert.deepEqual(open.swaps, [{ day_number: 2, from_dow: 2, to_dow: 1 }]);
  // Monday already lived: nothing is left to trade with, and Monday keeps its day.
  const lived = keyRunAwarePlacement(dealt, { keyRunDows: [3], open: [2, 3], isLower });
  assert.deepEqual(lived.swaps, []);
  assert.equal(lived.map.get(1).day_number, 1);
  assert.equal(lived.map.get(2).day_number, 2);
});

test("an easy run day is not a key run: Lower on the easy-run Tuesday stays put", () => {
  seedAthlete();
  repo.setProfile({
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 6, kind: "long" },
      ],
      source: "athlete",
    },
  });
  // No session logged: the ring deals from Push A, so Lower lands on Tuesday.
  const week = thisWeekPlanDayMap(MON);
  assert.equal(week.map.get(2)?.day_number, 2);
  assert.equal(week.key_run_swaps, undefined);
});

test("pure: a slot beside another leg day is no slot", () => {
  // Lower A Wednesday, Lower B Friday the eve of Saturday's long run. Thursday and Tuesday
  // are closer to Friday, but both sit beside Lower A — Monday takes Lower B.
  const dealt = ring([
    [1, day(1)],
    [2, day(2)],
    [3, day(3, true)],
    [4, day(4)],
    [5, day(5, true)],
  ]);
  const { map, swaps } = keyRunAwarePlacement(dealt, { keyRunDows: [6], open: [1, 2, 3, 4, 5], isLower });
  assert.deepEqual(swaps, [{ day_number: 5, from_dow: 5, to_dow: 1 }]);
  assert.equal(map.get(5).day_number, 1);
  // With Monday lived, the only partners left sit beside Lower A: no trade at all.
  const lived = keyRunAwarePlacement(dealt, { keyRunDows: [6], open: [2, 3, 4, 5], isLower });
  assert.deepEqual(lived.swaps, []);
});

// ---------- the live week ----------

test("the incident week: Lower moves to Tuesday, Push B to Friday, Monday stays as logged", () => {
  seedAthlete();
  seedIncidentLog();
  const week = thisWeekPlanDayMap(TUE);
  assert.deepEqual(byDow(week), { 1: 3, 2: 2, 3: 5, 4: 1, 5: 4 });
  assert.deepEqual(week.key_run_swaps, [{ day_number: 2, from_dow: 5, to_dow: 2 }]);
  // The raw deal is what it was: the ring's phase is untouched.
  const raw = weekdayPlanDayMap(planDayCandidates(), [1, 2, 3, 4, 5], week.strength_start);
  assert.deepEqual(
    [...raw].map(([dow, d]) => [dow, d.day_number]),
    [
      [1, 3],
      [2, 4],
      [3, 5],
      [4, 1],
      [5, 2],
    ]
  );
});

test("every read of the week agrees, whichever date in it asks", () => {
  seedAthlete();
  seedIncidentLog();
  const expected = { [MON]: 3, [TUE]: 2, [WED]: 5, [THU]: 1, [FRI]: 4 };
  for (const asker of [TUE, WED, THU, FRI]) {
    const week = thisWeekPlanDayMap(asker);
    for (const date of WEEK.filter((d) => d >= asker)) {
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      assert.equal(week.map.get(dow)?.day_number, expected[date], `${date} asked from ${asker}`);
    }
  }
  for (const date of [TUE, WED, THU, FRI]) {
    assert.equal(strengthPlanDayOn(date)?.day_number, expected[date], `strengthPlanDayOn ${date}`);
  }
  // The run engine's leg slots (Mon = 1) and the selector's own weekday answer.
  assert.deepEqual([...heavyLowerWeekdaySlots(TUE)], [2]);
  assert.equal(selectAdaptivePlanDay(TUE).selection.weekday_schedule.day_number, 2);
  assert.equal(selectAdaptivePlanDay(FRI).selection.weekday_schedule.day_number, 4);
  // The Plan tab's strip and the day detail read the same weekdays.
  const strip = planWeek(TUE);
  for (const date of [WED, THU, FRI]) {
    const cell = strip.days.find((d) => d.date === date);
    assert.equal(cell?.plan_day?.day_number, expected[date], `strip ${date}`);
    assert.equal(dayDetail(date, { today: TUE })?.lift?.day_number, expected[date], `day detail ${date}`);
  }
});

test("the race build's leg map lays the same week", () => {
  seedAthlete({ race: true });
  for (const [date, km] of [
    ["2031-06-12", 8],
    ["2031-06-15", 12],
    ["2031-06-19", 8],
    ["2031-06-22", 13],
    ["2031-06-26", 8],
    ["2031-06-29", 13],
    ["2031-07-03", 8],
    ["2031-07-06", 14],
    ["2031-07-10", 8],
    ["2031-07-13", 14],
  ])
    repo.addActivity({ type: "run", distance_km: km, duration_min: Math.round(km * 6), date });
  seedIncidentLog();
  const out = raceBuild(TUE);
  const strength = (n) => out.leg_map.find((d) => d.day_number === n)?.strength ?? null;
  assert.equal(out.leg_map.length, 7, out.reason);
  assert.equal(strength(2)?.name, "Lower");
  assert.equal(strength(2)?.heavy_lower, true);
  assert.equal(strength(5)?.name, "Push B");
  assert.equal(strength(5)?.heavy_lower, false);
});

test("a logged day never moves: Monday's Lower stands, and the rest of the week continues from it", () => {
  seedAthlete();
  // Last week ended on Push A Friday, so the ring deals Lower onto Monday — the morning
  // after the long run. Seen from Monday itself (nothing logged yet) it trades to Tuesday.
  logDay(LAST_FRI, 1);
  assert.deepEqual(byDow(thisWeekPlanDayMap(MON)), { 1: 3, 2: 2, 3: 4, 4: 5, 5: 1 });
  // He lifted Lower on Monday anyway: the log is the truth for Monday, and the week
  // re-phases off it — no second Lower, and nothing moves onto the day he lived.
  logDay(MON, 2);
  const week = thisWeekPlanDayMap(TUE);
  assert.deepEqual(byDow(week), { 1: 2, 2: 3, 3: 4, 4: 5, 5: 1 });
  assert.equal(week.key_run_swaps, undefined);
});

test("following the traded week keeps it: Tuesday's Lower logged, Wednesday on is unchanged", () => {
  seedAthlete();
  seedIncidentLog();
  logDay(TUE, 2);
  assert.deepEqual(byDow(thisWeekPlanDayMap(WED)), { 1: 3, 2: 2, 3: 5, 4: 1, 5: 4 });
});

test("next week's phase continues from what was actually logged", () => {
  seedAthlete();
  seedIncidentLog();
  logDay(TUE, 2);
  logDay(WED, 5);
  logDay(THU, 1);
  logDay(FRI, 4);
  const next = thisWeekPlanDayMap(NEXT_MON);
  // Friday logged Push B (day 4), so next Monday takes Pull (day 5) — pool index 4.
  assert.equal(next.strength_start, 4);
  const raw = weekdayPlanDayMap(planDayCandidates(), [1, 2, 3, 4, 5], next.strength_start);
  assert.deepEqual(
    [...raw].map(([dow, d]) => [dow, d.day_number]),
    [
      [1, 5],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 4],
    ],
    "the ring itself is the log's"
  );
  // …and its Lower, dealt onto Wednesday (the quality run's eve), trades onto Tuesday.
  assert.deepEqual(byDow(next), { 1: 5, 2: 2, 3: 1, 4: 3, 5: 4 });
});

// ---------- the focus, read for its date ----------

test("calendar claims are found and dropped; movement words are not", () => {
  for (const claim of [
    PUSH_B_FOCUS,
    "the day after the long run",
    "two clear days from Thursday's threshold run and Sunday's long run",
    "on the shakeout day",
    "the day after deadlifts",
    "Nothing on the legs before Thursday",
  ])
    assert.ok(hasCalendarClaim(claim), claim);
  for (const plain of ["Chest and triceps", "Squat, hinge and single-leg work", "Lats and rear delts", "Upper back and arms"])
    assert.equal(hasCalendarClaim(plain), false, plain);

  assert.deepEqual(stripCalendarClaims(LOWER_FOCUS), {
    text: "The week's one leg day — squat, hinge and single-leg work.",
    stripped: true,
  });
  assert.deepEqual(stripCalendarClaims(UPPER_FOCUS), { text: "Upper back and arms.", stripped: true });
  assert.deepEqual(stripCalendarClaims(PUSH_B_FOCUS), { text: "", stripped: true });
  assert.deepEqual(stripCalendarClaims("Chest and triceps"), { text: "Chest and triceps", stripped: false });
});

test("the real calendar's phrase takes the claim's place, and only when one was dropped", () => {
  const friday = { today: "easy", yesterday: "quality", tomorrow: null, quality_noun: "threshold run" };
  const out = datedPlanDayFocus(PUSH_B_FOCUS, FRI, { calendar: friday });
  assert.ok(["Day after the threshold run.", "The threshold run is the day before."].includes(out), out);
  const thursday = { today: "quality", yesterday: null, tomorrow: "easy", quality_noun: "threshold run" };
  assert.match(datedPlanDayFocus(PUSH_B_FOCUS, THU, { calendar: thursday }), /threshold run/i);
  const tuesday = { today: null, yesterday: null, tomorrow: null, quality_noun: "threshold run" };
  assert.equal(
    datedPlanDayFocus(LOWER_FOCUS, TUE, { calendar: tuesday }),
    "The week's one leg day — squat, hinge and single-leg work."
  );
  assert.equal(datedPlanDayFocus(PUSH_B_FOCUS, TUE, { calendar: tuesday }), null, "nothing left, nothing said");
  // A focus with no calendar claim comes back exactly as stored, even beside a key run.
  assert.equal(datedPlanDayFocus("Chest and triceps", THU, { calendar: thursday }), "Chest and triceps");
  assert.equal(datedPlanDayFocus(null, THU), null);
  // Every phrase holds the reading grammar and says no number.
  for (let i = 0; i < 14; i++) {
    const date = `2031-07-${String(10 + i).padStart(2, "0")}`;
    for (const calendar of [friday, thursday, { ...friday, today: null }, { ...tuesday, tomorrow: "long" }]) {
      const phrase = calendarFocusPhrase(date, calendar);
      if (!phrase) continue;
      assert.equal(violatesReadingGrammar(phrase), null, phrase);
      assert.doesNotMatch(phrase, /\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i, phrase);
    }
  }
});

test("every surface that prints a focus for a date prints the date's truth, never the stored claim", () => {
  seedAthlete();
  seedIncidentLog();
  const strip = planWeek(TUE);
  const cell = (date) => strip.days.find((d) => d.date === date);
  assert.equal(cell(TUE).plan_day?.day_number, 2);
  assert.doesNotMatch(String(cell(TUE).plan_day?.focus ?? ""), /thursday|sunday|clear days/i);
  assert.match(String(cell(TUE).plan_day?.focus ?? ""), /one leg day/);
  const friday = String(cell(FRI).plan_day?.focus ?? "");
  assert.doesNotMatch(friday, /threshold-run day/, "Push B on Friday is not on the threshold-run day");
  assert.match(friday, /day after|day before/i, friday);
  assert.equal(dayDetail(FRI, { today: TUE })?.lift?.focus, cell(FRI).plan_day.focus, "the day detail reads the strip's words");
  // The stored row is never rewritten.
  assert.equal(repo.getPlanDay(4).focus, PUSH_B_FOCUS);
  assert.equal(repo.getPlanDay(2).focus, LOWER_FOCUS);
  // The selector's focus for a date reads the same way.
  assert.doesNotMatch(String(selectAdaptivePlanDay(FRI).selection.rotation.focus), /threshold-run day/);
});

// ---------- a leg session already logged this week ----------

test("pure: a slot beside a leg day already LOGGED this week is no slot", () => {
  // The incident deal, but Monday (dealt Upper) was lived as a leg session.
  const dealt = ring([
    [1, day(3)],
    [2, day(4)],
    [3, day(5)],
    [4, day(1)],
    [5, day(2, true)],
  ]);
  const unaware = keyRunAwarePlacement(dealt, { keyRunDows: [4, 0], open: [2, 3, 4, 5], isLower });
  assert.deepEqual(unaware.swaps, [{ day_number: 2, from_dow: 5, to_dow: 2 }], "the deal alone sees Tuesday as clean");
  const aware = keyRunAwarePlacement(dealt, {
    keyRunDows: [4, 0],
    open: [2, 3, 4, 5],
    isLower,
    lived: [1],
    loggedLower: [1],
  });
  assert.deepEqual(aware.swaps, [], "Tuesday sits beside Monday's logged leg day: no trade");
  assert.equal(aware.map.get(5).day_number, 2);
  // A lived day the deal called a leg day, but logged as something else, no longer blocks.
  const dealtLowerMonday = ring([
    [1, day(6, true)],
    [2, day(4)],
    [3, day(5)],
    [4, day(1)],
    [5, day(2, true)],
  ]);
  const livedUpper = keyRunAwarePlacement(dealtLowerMonday, {
    keyRunDows: [4, 0],
    open: [2, 3, 4, 5],
    isLower,
    lived: [1],
    loggedLower: [],
  });
  assert.deepEqual(livedUpper.swaps, [{ day_number: 2, from_dow: 5, to_dow: 2 }]);
});

test("the week's trade never lands beside an extra leg session logged on a non-lifting day", () => {
  // Lifts Mon/Wed/Thu/Sat, quality run Friday. Two leg days in the pool. Tuesday (not a
  // lifting weekday) he logged Lower A as an extra session; the ring then deals Wed=3,
  // Thu=4 (Lower B, the eve of the quality run), Sat=5. Wednesday is clear of the run
  // but the day after Tuesday's leg session — so there is no clean slot and no trade.
  for (const [name, muscle_group] of [
    ["Barbell Bench Press", "chest"],
    ["Back Squat", "quads"],
    ["Barbell Row", "back"],
    ["Deadlift", "hamstrings"],
    ["Lat Pulldown", "back"],
  ])
    repo.upsertExercise({ name, muscle_group, mode: "reps" });
  repo.savePlanDay(1, "Push", "Chest", [lift("Barbell Bench Press")]);
  repo.savePlanDay(2, "Lower A", "Squat day", [lift("Back Squat")]);
  repo.savePlanDay(3, "Upper", "Back", [lift("Barbell Row")]);
  repo.savePlanDay(4, "Lower B", "Hinge day", [lift("Deadlift")]);
  repo.savePlanDay(5, "Pull", "Lats", [lift("Lat Pulldown")]);
  repo.setProfile({
    strength_schedule: { days: [1, 3, 4, 6].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: { days: [{ dow: 5, kind: "quality" }], source: "athlete" },
  });
  const log = (date, dayNumber, exercise) => {
    for (let i = 0; i < 3; i++) repo.logSetByName({ date, exercise, weight: 100, reps: 7, day_number: dayNumber });
  };
  log("2031-07-12", 1, "Barbell Bench Press"); // last Saturday: Push
  log(MON, 1, "Barbell Bench Press");
  log(TUE, 2, "Back Squat"); // the extra leg session, on a non-lifting weekday
  // Read from Wednesday, the morning after it (without the logged session in view the
  // trade would put Lower B on Wednesday: clear of Friday's run, beside nothing dealt).
  const week = thisWeekPlanDayMap(WED);
  assert.equal(week.map.get(4)?.day_number, 4, "Lower B stays on Thursday rather than stacking onto Wednesday");
  assert.notEqual(week.map.get(3)?.day_number, 4);
  assert.equal(week.key_run_swaps, undefined);
});
