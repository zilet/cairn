// Stated LIFTING weekdays (`strength_schedule` on profile, v102) — the parser, the
// profile write paths (REST/MCP shape + chat), the weekday ring that lays the plan's
// days onto the weekdays the athlete actually named, and the prompt line that tells
// the agent about them. Mirrors test/enduranceSchedule.test.js, its run-day sibling.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import { weekdayPlanDayMap } from "../dist/repo/plan-selection.js";
import { observedLiftDows, strengthScheduleRead } from "../dist/repo/strength-schedule.js";
import { renderStrengthSchedule } from "../dist/prompt/shared.js";
import { MIGRATIONS } from "../dist/migrate.js";
import { weekLayoutRead } from "../dist/domain/training/week-layout.js";

// Mon–Fri lifting, Sat/Sun + Tue/Thu running — the athlete's stated week.
const WORKDAYS = { days: [{ dow: 1 }, { dow: 2 }, { dow: 3 }, { dow: 4 }, { dow: 5 }], source: "athlete" };

function resetAll() {
  resetTables(
    "logged_sets",
    "sessions",
    "plan_items",
    "plan_days",
    "exercises",
    "app_state",
    "chat_turns",
    "chat_messages",
    "profile"
  );
}

// A fixed week to read the six-week window from, so the fixture never drifts. AS_OF is
// the SUNDAY that closes it, not a mid-week day: a weekday later in the current week has
// not happened yet, and the read will not count a session that is still in the future.
const WEEK_MONDAY = "2026-04-20"; // Monday
const AS_OF = "2026-04-26"; // the Sunday closing that week — the whole week is behind us
const back = (weeks, dow) => {
  // The Monday `weeks` back, then forward to `dow` (0 = Sunday, which lands at the END
  // of that week — the same Monday-first order the rest of the module reads in).
  const monday = new Date(`${WEEK_MONDAY}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - 7 * weeks + ((dow + 6) % 7));
  return monday.toISOString().slice(0, 10);
};

// A real strength session: a logged set makes it count, finishing it makes it count
// twice over. `weeks` is how many weeks back from AS_OF, 0 being AS_OF's own week.
function liftOn(date, { finish = true } = {}) {
  repo.logSetByName({ date, exercise: "Barbell Bench Press", weight: 135, reps: 8 });
  if (finish) {
    const session = repo.getOrCreateSession(date);
    repo.finishSession(session.id, null);
  }
}

beforeEach(resetAll);

// ---------------------------------------------------------------------------
// the column
// ---------------------------------------------------------------------------

test("v102 adds strength_schedule_json, and a fresh database already has it", () => {
  const v102 = MIGRATIONS.find((m) => m.version === 102);
  assert.ok(v102, "migration v102 must exist");
  assert.equal(v102.name, "profile-strength-schedule");
  const columns = db.prepare(`PRAGMA table_info(profile)`).all();
  assert.ok(
    columns.find((c) => c.name === "strength_schedule_json"),
    "a fresh database's profile must already carry strength_schedule_json"
  );
  // Idempotent: the ALTER is a try/catch add, so re-running over a column that exists
  // is a no-op rather than a throw.
  v102.up(db);
});

// ---------------------------------------------------------------------------
// the parser
// ---------------------------------------------------------------------------

test("normalizeStrengthSchedule round-trips, sorts, dedupes, and carries no kind", () => {
  const normalized = repo.normalizeStrengthSchedule({
    days: [{ dow: 5 }, { dow: 1 }, { dow: 3 }, { dow: 1 }],
    note: "workdays",
  });
  assert.ok(normalized);
  assert.deepEqual(
    normalized.days.map((d) => d.dow),
    [1, 3, 5]
  );
  assert.equal(
    normalized.days.every((d) => !("kind" in d)),
    true,
    "a lifting day has no kind"
  );
  assert.equal(normalized.note, "workdays");
  assert.equal(normalized.source, "athlete");
  assert.ok(normalized.updated_at);
  // A serialized schedule parses back to the same days.
  assert.deepEqual(
    repo.normalizeStrengthSchedule(JSON.stringify(normalized)).days.map((d) => d.dow),
    [1, 3, 5]
  );
});

test("one bad entry is dropped, a whole-garbage payload is rejected, days: [] clears", () => {
  const partial = repo.normalizeStrengthSchedule({ days: [{ dow: 1 }, { dow: 9 }, { dow: "nope" }, 5] });
  assert.deepEqual(
    partial.days.map((d) => d.dow),
    [1, 5],
    "a typo'd day must not erase the days typed correctly beside it"
  );
  assert.equal(repo.normalizeStrengthSchedule({ days: [{ dow: 9 }] }), null, "nothing understood -> reject");
  assert.equal(repo.normalizeStrengthSchedule({ note: "I lift" }), null, "no days array is not a schedule");
  assert.equal(repo.normalizeStrengthSchedule(null), null);
  const cleared = repo.normalizeStrengthSchedule({ days: [] });
  assert.ok(cleared, "an explicit days: [] is a real (empty) schedule, not a rejection");
  assert.equal(cleared.days.length, 0);
});

// ---------------------------------------------------------------------------
// the profile write path (the shape REST PUT /api/profile and MCP set_profile pass)
// ---------------------------------------------------------------------------

test("setProfile stores, reads back, and never lets a malformed payload erase one", () => {
  assert.equal(repo.getStrengthSchedule(), null);
  assert.equal(repo.isStatedLiftDay("2026-04-20"), null, "unset reads as 'no opinion', not false");

  repo.setProfile({ strength_schedule: WORKDAYS });
  const stored = repo.getStrengthSchedule();
  assert.ok(stored);
  assert.deepEqual(repo.statedLiftDows(), [1, 2, 3, 4, 5]);
  assert.equal(repo.isStatedLiftDay("2026-04-20"), true, "2026-04-20 is a Monday");
  assert.equal(repo.isStatedLiftDay("2026-04-25"), false, "2026-04-25 is a Saturday");
  assert.equal(repo.formatStrengthScheduleDays(stored), "Monday, Tuesday, Wednesday, Thursday, Friday");

  // Non-destructive: an unusable non-null shape preserves what is stored.
  repo.setProfile({ strength_schedule: { days: [{ dow: 42 }] } });
  assert.deepEqual(repo.statedLiftDows(), [1, 2, 3, 4, 5]);

  // Omitted leaves intact; explicit null clears; the run schedule is untouched either way.
  repo.setProfile({ endurance_schedule: { days: [{ dow: 6, kind: "long" }] } });
  repo.setProfile({ name: "unrelated edit" });
  assert.deepEqual(repo.statedLiftDows(), [1, 2, 3, 4, 5]);
  repo.setProfile({ strength_schedule: null });
  assert.equal(repo.getStrengthSchedule(), null);
  assert.deepEqual(repo.statedRunDows(), [6], "clearing lifting days leaves the run days alone");
});

// ---------------------------------------------------------------------------
// the chat write path
// ---------------------------------------------------------------------------

test("chat set_strength_schedule writes the weekdays the athlete named", () => {
  const written = applyChatActions(
    {
      actions: [{ type: "set_strength_schedule", days: [{ dow: 1 }, { dow: 2 }, { dow: 3 }, { dow: 4 }, { dow: 5 }] }],
    },
    {
      agent: "stub",
      message: "My strength trainings are on all workdays (mon-fri) and then long runs and mtbs for weekend",
    }
  );
  assert.equal(written.applied[0]?.type, "set_strength_schedule");
  assert.equal(written.applied[0]?.error, undefined);
  const stored = repo.getStrengthSchedule();
  assert.ok(stored);
  assert.equal(stored.source, "chat");
  assert.deepEqual(
    stored.days.map((d) => d.dow),
    [1, 2, 3, 4, 5]
  );
});

test("chat maps only the weekdays named, and a message naming none writes nothing", () => {
  const mwf = normalizeChatAction({ type: "set_strength_schedule", days: [{ dow: 1 }, { dow: 3 }, { dow: 5 }] });
  assert.ok(mwf);
  assert.deepEqual(
    mwf.days.map((d) => d.dow),
    [1, 3, 5],
    "'I lift Monday, Wednesday and Friday' is 1, 3 and 5 — no fourth day invented"
  );

  // A turn that names no weekday has no days array to emit, so nothing survives
  // normalization and nothing reaches the profile.
  assert.equal(normalizeChatAction({ type: "set_strength_schedule", note: "I lift a lot" }), null);
  const nothing = applyChatActions(
    { actions: [{ type: "set_strength_schedule", note: "I lift a lot" }] },
    { agent: "stub", message: "I try to get to the gym pretty often these days" }
  );
  assert.equal(nothing.applied.length, 0, "a malformed action is dropped before any write");
  assert.equal(repo.getStrengthSchedule(), null);
});

test("chat CAN clear a stated schedule with an explicit empty days: []", () => {
  repo.setProfile({ strength_schedule: WORKDAYS });
  assert.equal(repo.getStrengthSchedule().days.length, 5);
  const cleared = applyChatActions(
    { actions: [{ type: "set_strength_schedule", days: [] }] },
    { agent: "stub", message: "forget my lifting days, let the coach pick" }
  );
  assert.equal(cleared.applied[0]?.error, undefined, "an explicit clear is not an error");
  const after = repo.getStrengthSchedule();
  assert.ok(after);
  assert.equal(after.days.length, 0);
  assert.equal(repo.isStatedLiftDay("2026-04-20"), null, "an emptied schedule reads exactly like unset");
});

// ---------------------------------------------------------------------------
// the weekday ring
// ---------------------------------------------------------------------------

// The athlete's live week: five strength days, a rest day, and an endurance-only day.
const LIVE_RING = [
  { day_number: 1, day_type: "training", names: ["Back Squat"], cardio: [] },
  { day_number: 2, day_type: "training", names: ["Barbell Bench Press"], cardio: [] },
  { day_number: 3, day_type: "training", names: ["Barbell Row"], cardio: [] },
  { day_number: 4, day_type: "training", names: ["Romanian Deadlift"], cardio: [] },
  { day_number: 5, day_type: "rest", names: [], cardio: [] },
  { day_number: 6, day_type: "training", names: ["Goblet Squat"], cardio: [] },
  { day_number: 7, day_type: "training", names: [], cardio: ["Long Run"] },
];

test("weekdayPlanDayMap lays the stated week: Mon-Fri lift, Sat runs, Sun rests", () => {
  const map = weekdayPlanDayMap(LIVE_RING, [1, 2, 3, 4, 5], [0, 2, 4, 6]);
  // The five strength days land on the five stated lifting weekdays, in ring order.
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((dow) => map.get(dow).day_number),
    [1, 2, 3, 4, 6],
    "Mon..Fri take the plan's strength days 1,2,3,4,6 in order — the rest day is skipped"
  );
  // Tue/Thu are BOTH lifting and running days, so lifting wins the slot (the run rides
  // alongside); Saturday is the one run-only weekday and takes the Long Run.
  assert.equal(map.get(6).day_number, 7, "Saturday takes the endurance-only day");
  // Sunday is also a stated run day, but the plan authored ONE long run. It is consumed,
  // not repeated, so Sunday falls through to the rest day rather than inventing a
  // second long run out of a week that has one.
  assert.equal(map.get(0).day_number, 5, "Sunday takes the rest day");
  // The law: no unstated weekday is handed a strength day.
  for (const dow of [0, 6]) {
    assert.equal(map.get(dow).names.length, 0, `dow ${dow} is never a strength day`);
  }
});

test("weekdayPlanDayMap is inert with no stated schedule and cycles a short pool", () => {
  assert.equal(weekdayPlanDayMap(LIVE_RING, [], [0, 6]).size, 0, "unstated -> empty map -> positional ring");
  assert.equal(weekdayPlanDayMap(LIVE_RING, null, null).size, 0);

  // Three strength days against five stated lifting weekdays: every stated day still
  // carries a strength session, the pool wrapping rather than going quiet.
  const short = [
    { day_number: 1, day_type: "training", names: ["Back Squat"], cardio: [] },
    { day_number: 2, day_type: "training", names: ["Barbell Bench Press"], cardio: [] },
    { day_number: 3, day_type: "training", names: ["Barbell Row"], cardio: [] },
    { day_number: 4, day_type: "rest", names: [], cardio: [] },
  ];
  const map = weekdayPlanDayMap(short, [1, 2, 3, 4, 5], [0, 6]);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((dow) => map.get(dow).day_number),
    [1, 2, 3, 1, 2]
  );
  assert.equal(map.get(0).day_number, 4, "Sunday still gets the rest day");
  assert.equal(map.get(6).day_number, 4, "Saturday has no endurance day authored -> rest, never a lift");
});

test("the adaptive ring points an unanchored Saturday at rest, not at a lift", () => {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Lower A",
      items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 }],
    },
    {
      day_number: 2,
      name: "Push",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 }],
    },
    {
      day_number: 3,
      name: "Pull",
      items: [{ exercise: "Barbell Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95 }],
    },
    {
      day_number: 4,
      name: "Lower B",
      items: [{ exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 }],
    },
    {
      day_number: 5,
      name: "Full Body",
      items: [{ exercise: "Goblet Squat", sets: 3, rep_low: 8, rep_high: 12, target_weight: 50 }],
    },
    { day_number: 6, name: "Rest", focus: null, day_type: "rest", items: [] },
    { day_number: 7, name: "Long Run", items: [{ kind: "cardio", exercise: "Long Run", target_minutes: 75 }] },
  ]);

  const SATURDAY = "2026-04-25";
  // Positional, with nothing stated: Saturday is slot 6 — the Rest day here.
  const before = repo.selectAdaptivePlanDay(SATURDAY);
  assert.ok(before);

  repo.setProfile({ strength_schedule: WORKDAYS, endurance_schedule: { days: [{ dow: 6, kind: "long" }] } });
  const after = repo.selectAdaptivePlanDay(SATURDAY);
  assert.ok(after);
  assert.equal(after.day_number, 7, "Saturday is the stated long-run day -> the endurance-only plan day");

  const MONDAY = "2026-04-20";
  const monday = repo.selectAdaptivePlanDay(MONDAY);
  assert.ok(monday);
  assert.equal(monday.day_type, "training");
});

// ---------------------------------------------------------------------------
// the weekday ring END TO END — the lifting week against the session anchor
// ---------------------------------------------------------------------------
//
// The map above is pure, and passing it in isolation proved nothing about whether the
// selector ever asked it. It did not: `recentSessionAnchors` reads the last 20 sessions
// with logged sets and no date window, so for any athlete with history an anchor always
// resolved and the rotation was decided positionally before the week was consulted.
// These four cases drive `selectAdaptivePlanDay` / `selectedPlanDayForDate` themselves.

const strengthDay = (day_number, name, exercise) => ({
  day_number,
  name,
  items: [{ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }],
});
const restDay = (day_number) => ({ day_number, name: "Rest", focus: null, day_type: "rest", items: [] });
const longRunDay = (day_number) => ({
  day_number,
  name: "Long Run",
  items: [{ kind: "cardio", exercise: "Long Run", target_minutes: 75 }],
});

// The athlete's live ring: five strength days, a rest day, an endurance-only day.
const LIVE_PLAN = [
  strengthDay(1, "Lower A", "Back Squat"),
  strengthDay(2, "Push", "Barbell Bench Press"),
  strengthDay(3, "Pull", "Barbell Row"),
  strengthDay(4, "Lower B", "Romanian Deadlift"),
  restDay(5),
  strengthDay(6, "Full Body", "Goblet Squat"),
  longRunDay(7),
];
// Easy Sunday, quality Tuesday/Thursday, long Saturday — Tue/Thu double up with lifting.
const RUN_WEEK = {
  days: [
    { dow: 0, kind: "easy" },
    { dow: 2, kind: "quality" },
    { dow: 4, kind: "quality" },
    { dow: 6, kind: "long" },
  ],
};

// A fixed fortnight, Monday to Sunday twice over.
const WEEK_1 = ["2026-04-20", "2026-04-21", "2026-04-22", "2026-04-23", "2026-04-24", "2026-04-25", "2026-04-26"];
const WEEK_2 = ["2026-04-27", "2026-04-28", "2026-04-29", "2026-04-30", "2026-05-01", "2026-05-02", "2026-05-03"];
const picks = (dates) => dates.map((date) => repo.selectAdaptivePlanDay(date).day_number);

test("the stated lifting week outranks the session anchor; the anchor only sets the ring's phase", () => {
  repo.replacePlan(LIVE_PLAN);
  repo.setProfile({ strength_schedule: WORKDAYS, endurance_schedule: RUN_WEEK });
  // One logged set on Friday — the anchor every athlete with history carries. It used
  // to decide the pick outright, and every day after it read "Lower B" whatever weekday
  // it was.
  repo.logSetByName({ date: "2026-04-24", exercise: "Romanian Deadlift", weight: 155, reps: 8 });

  const saturday = repo.selectAdaptivePlanDay("2026-04-25");
  assert.equal(saturday.day_number, 7, "Saturday is the stated long-run day, never a lift");
  assert.equal(repo.selectAdaptivePlanDay("2026-04-26").day_type, "rest", "Sunday is neither -> the rest day");

  // Monday is the next stated LIFTING weekday, and it takes the strength day that
  // follows the one actually logged (day 4 -> day 6; day 5 is the programmed rest).
  const monday = repo.selectAdaptivePlanDay("2026-04-27");
  assert.equal(monday.selection.rotation.day_number, 6, "the ring's phase survives the weekend");
  assert.equal(monday.day_number, 6);
  assert.equal(monday.focus, "Full Body");
  // The same answer through the canonical Today door, not just the selector.
  assert.equal(repo.selectedPlanDayForDate("2026-04-27").day_number, 6);
  // And the week rolls on, one strength day per stated lifting weekday.
  assert.deepEqual(picks(WEEK_2.slice(1, 5)), [1, 2, 3, 4]);
});

test("more strength days than lifting weekdays: the surplus opens the NEXT week, never the weekend", () => {
  // Six strength days against five stated lifting weekdays. The sixth is neither
  // dropped nor smuggled onto Saturday.
  repo.replacePlan([
    strengthDay(1, "S1", "Back Squat"),
    strengthDay(2, "S2", "Barbell Bench Press"),
    strengthDay(3, "S3", "Barbell Row"),
    strengthDay(4, "S4", "Romanian Deadlift"),
    strengthDay(5, "S5", "Overhead Press"),
    strengthDay(6, "S6", "Goblet Squat"),
    restDay(7),
    longRunDay(8),
  ]);
  repo.setProfile({ strength_schedule: WORKDAYS, endurance_schedule: { days: [{ dow: 6, kind: "long" }] } });

  // An unanchored week deals the pool from its first day: S1..S5, and S6 waits.
  assert.deepEqual(picks(WEEK_1.slice(0, 5)), [1, 2, 3, 4, 5]);
  // The athlete lifts S5 on Friday, closing the week where the plan said it would.
  repo.logSetByName({ date: "2026-04-24", exercise: "Overhead Press", weight: 95, reps: 8 });
  assert.deepEqual(picks(WEEK_2.slice(0, 5)), [6, 1, 2, 3, 4], "S6 opens the following Monday");

  // The law, over the whole fortnight: a weekend day is the rest day or the long run.
  for (const weekend of [WEEK_1[5], WEEK_1[6], WEEK_2[5], WEEK_2[6]]) {
    const picked = repo.selectAdaptivePlanDay(weekend);
    assert.ok([7, 8].includes(picked.day_number), `${weekend} must never be handed a strength day`);
  }
});

test("fewer strength days than lifting weekdays: the ring repeats so every one of them lifts", () => {
  repo.replacePlan([
    strengthDay(1, "S1", "Back Squat"),
    strengthDay(2, "S2", "Barbell Bench Press"),
    strengthDay(3, "S3", "Barbell Row"),
    restDay(4),
  ]);
  repo.setProfile({ strength_schedule: WORKDAYS });
  repo.logSetByName({ date: "2026-04-24", exercise: "Barbell Bench Press", weight: 100, reps: 8 });

  // Three days over five weekdays: the pool wraps inside the week rather than going
  // quiet on Thursday and Friday.
  assert.deepEqual(picks(WEEK_1.slice(0, 5)), [1, 2, 3, 1, 2]);
  // And the wrap is CONTINUOUS across the week boundary — Monday picks up after the S2
  // the athlete logged on Friday rather than restarting at S1.
  assert.deepEqual(picks(WEEK_2.slice(0, 5)), [3, 1, 2, 3, 1]);
  for (const weekend of [WEEK_1[5], WEEK_1[6], WEEK_2[5], WEEK_2[6]]) {
    assert.equal(repo.selectAdaptivePlanDay(weekend).day_type, "rest", `${weekend} has no lift to give`);
  }
});

test("a recovering split day walks forward to the next fresh day, not a distant mash-up", () => {
  // The live Monday: ring said Lower B after Friday's Upper, legs were still
  // carrying Sunday's long run, and the scorer jumped to Thursday's Upper —
  // then composition stole Monday's bench onto it. Elite skip is the NEXT
  // fresh day in the split (Push), not the highest-scoring day anywhere.
  resetTables("logged_sets", "sessions", "plan_items", "plan_days", "exercises", "activities", "profile");
  repo.replacePlan([
    {
      day_number: 1,
      name: "Push",
      focus: "Shoulders, chest, triceps",
      items: [
        { exercise: "Barbell Overhead Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 75 },
        { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 12, target_weight: 125 },
      ],
    },
    strengthDay(2, "Pull", "Pendlay Row"),
    strengthDay(3, "Lower A", "Back Squat"),
    {
      day_number: 4,
      name: "Upper Body & Arms",
      focus: "Chest, back, arms & forearms",
      items: [
        { exercise: "Dumbbell Bench Press", sets: 2, rep_low: 8, rep_high: 11, target_weight: 55 },
        { exercise: "Chest-Supported Row", sets: 2, rep_low: 10, rep_high: 12, target_weight: 35 },
        { exercise: "Barbell Curl", sets: 1, rep_low: 12, rep_high: 12, target_weight: 80 },
      ],
    },
    strengthDay(5, "Lower B", "Barbell Deadlift"),
    restDay(6),
    longRunDay(7),
  ]);
  repo.setProfile({
    strength_schedule: WORKDAYS,
    endurance_schedule: { days: [{ dow: 0, kind: "long" }] },
  });
  repo.logSetByName({ date: "2026-04-24", exercise: "Chest-Supported Row", weight: 35, reps: 10 });
  repo.addActivity({
    type: "run",
    duration_min: 90,
    distance_km: 16,
    date: "2026-04-26",
    text: "Long run",
  });

  const monday = repo.selectAdaptivePlanDay("2026-04-27");
  assert.equal(monday.selection.rotation.day_number, 5, "the ring still points at Lower B after Friday's Upper");
  assert.equal(monday.day_number, 1, "the skip lands on Push, the next fresh day in the split");
  assert.equal(monday.selection.adapted, true);
});

test("with nothing stated and nothing observed the ring stays positional and the anchor rules", () => {
  repo.replacePlan(LIVE_PLAN);
  // The athlete this ring was written for. A bare week reads straight down the
  // day-number -> weekday line: Monday day 1, Sunday day 7.
  assert.deepEqual(picks(WEEK_1), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(
    WEEK_1.map((date) => repo.selectedPlanDayForDate(date).day_number),
    [1, 2, 3, 4, 5, 6, 7]
  );

  // And one logged session re-anchors the rotation positionally, the weekday stopping
  // mattering from there — the pre-existing behavior this fix deliberately leaves alone
  // for an athlete who has told us nothing.
  repo.logSetByName({ date: "2026-04-22", exercise: "Barbell Bench Press", weight: 135, reps: 8 });
  assert.deepEqual(picks([...WEEK_1.slice(3), ...WEEK_2.slice(0, 3)]), [3, 3, 3, 3, 3, 3, 3]);
});

// ---------------------------------------------------------------------------
// the prompt line
// ---------------------------------------------------------------------------

test("renderStrengthSchedule prints the stated lifting days and is quiet when unstated", () => {
  assert.equal(renderStrengthSchedule({}), "");
  assert.equal(renderStrengthSchedule({ strength_schedule: { days: [] } }), "");

  const line = renderStrengthSchedule({
    strength_schedule: { days: [{ dow: 3 }, { dow: 1 }, { dow: 5 }, { dow: 2 }, { dow: 4 }] },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "quality" },
        { dow: 6, kind: "long" },
      ],
    },
  });
  assert.match(line, /STATED LIFTING DAYS: Monday, Tuesday, Wednesday, Thursday, Friday\./);
  assert.match(line, /never place a strength session on an unstated weekday/);
  assert.match(line, /Tuesday is BOTH a lifting day and a run day/);
  assert.match(line, /never the week's heavy squat\/hinge day/);

  // Sunday sorts LAST — the week is read Monday-first, the way the athlete says it.
  const withSunday = renderStrengthSchedule({ strength_schedule: { days: [{ dow: 0 }, { dow: 1 }] } });
  assert.match(withSunday, /STATED LIFTING DAYS: Monday, Sunday\./);
});

test("week_layout names the stated lifting and running weekdays, and stays neutral without them", () => {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Lower A",
      items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 }],
    },
    {
      day_number: 2,
      name: "Push",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 }],
    },
  ]);
  repo.setProfile({
    primary_discipline: "hybrid",
    strength_schedule: WORKDAYS,
    endurance_schedule: {
      days: [
        { dow: 6, kind: "long" },
        { dow: 0, kind: "easy" },
      ],
    },
  });
  const layout = weekLayoutRead("2026-04-20", {
    strengthDows: repo.statedLiftDows(),
    enduranceDows: repo.statedRunDows(),
  });
  assert.deepEqual(layout.lift_days, ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]);
  assert.deepEqual(layout.run_days, ["Saturday", "Sunday"], "Sunday sorts last in weekday order");
  // Absence stays neutral: an athlete who has said nothing gets empty lists, not a guess.
  const unstated = weekLayoutRead("2026-04-20");
  assert.deepEqual(unstated.lift_days, []);
  assert.deepEqual(unstated.run_days, []);
});

// ---------------------------------------------------------------------------
// the OBSERVED week — what they do, when they have not said
// ---------------------------------------------------------------------------

test("observedLiftDows reads 3-of-6-weeks off the log and ignores thinner habits", () => {
  // Mon/Wed in five of the six weeks; Saturday in exactly two (a habit that is not one).
  for (let w = 0; w < 5; w++) {
    liftOn(back(w, 1));
    liftOn(back(w, 3));
  }
  liftOn(back(0, 6));
  liftOn(back(1, 6));

  const observed = observedLiftDows(AS_OF);
  assert.deepEqual(observed.dows, [1, 3], "two weeks of Saturdays is an outing, not a lifting day");
  assert.equal(observed.weeks_seen, 5, "the thinnest NAMED weekday sets the number the sentence may claim");

  // Exactly three weeks is the threshold, and it is inclusive.
  liftOn(back(2, 6));
  assert.deepEqual(observedLiftDows(AS_OF).dows, [1, 3, 6], "three of six weeks makes a habit");
  assert.equal(observedLiftDows(AS_OF).weeks_seen, 3);
});

test("the observed read only counts REAL strength sessions", () => {
  // Seven weeks back is outside the six-week window.
  for (let w = 0; w < 6; w++) liftOn(back(w + 1, 2));
  assert.deepEqual(observedLiftDows(AS_OF).dows, [2], "five of those six weeks are still in window");

  // An opened-but-empty session is not a lifting day, however many weeks it repeats.
  for (let w = 0; w < 6; w++) repo.getOrCreateSession(back(w, 4));
  assert.deepEqual(observedLiftDows(AS_OF).dows, [2], "a session with no sets and no finish is not a lifting day");

  // Neither is a cardio session.
  for (let w = 0; w < 6; w++) {
    const session = repo.getOrCreateSession(back(w, 5));
    db.prepare(`UPDATE sessions SET kind = 'cardio', finished_at = datetime('now') WHERE id = ?`).run(session.id);
  }
  assert.deepEqual(observedLiftDows(AS_OF).dows, [2], "a logged run is not a lifting day");
});

test("strengthScheduleRead prefers what they SAID, and an explicit clear is a real silence", () => {
  for (let w = 0; w < 4; w++) {
    liftOn(back(w, 1));
    liftOn(back(w, 3));
  }
  const observed = strengthScheduleRead(AS_OF);
  assert.equal(observed.source, "observed");
  assert.deepEqual(
    observed.days.map((d) => d.dow),
    [1, 3]
  );
  assert.equal(observed.weeks_window, 6);
  assert.ok(observed.weeks_seen >= 3);

  repo.setProfile({ strength_schedule: WORKDAYS });
  const stated = strengthScheduleRead(AS_OF);
  assert.equal(stated.source, "stated", "the athlete's own words outrank the pattern");
  assert.deepEqual(
    stated.days.map((d) => d.dow),
    [1, 2, 3, 4, 5]
  );
  assert.equal(stated.weeks_seen, 0, "a stated week asserts no week count");

  // "Stop assuming my lifting days" must not fall back to the log and start assuming again.
  repo.setProfile({ strength_schedule: { days: [] } });
  const cleared = strengthScheduleRead(AS_OF);
  assert.equal(cleared.source, null);
  assert.deepEqual(cleared.days, []);

  // Clearing the column entirely reopens the observed read.
  repo.setProfile({ strength_schedule: null });
  assert.equal(strengthScheduleRead(AS_OF).source, "observed");
});

test("with nothing said and nothing recurring, the read is silent and the ring is positional", () => {
  assert.deepEqual(strengthScheduleRead(AS_OF), { days: [], source: null, weeks_seen: 0, weeks_window: 6 });
  liftOn(back(0, 2));
  liftOn(back(1, 2));
  assert.equal(strengthScheduleRead(AS_OF).source, null, "two weeks is not yet a week");
});

test("the observed week drives the ring and week_layout, labelled as observed", () => {
  repo.replacePlan([
    {
      day_number: 1,
      name: "Lower A",
      items: [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 }],
    },
    {
      day_number: 2,
      name: "Push",
      items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 }],
    },
    { day_number: 3, name: "Rest", focus: null, day_type: "rest", items: [] },
  ]);
  for (let w = 0; w < 4; w++) {
    liftOn(back(w, 1));
    liftOn(back(w, 2));
  }
  const layout = weekLayoutRead(AS_OF, {
    strengthDows: repo.strengthScheduleRead(AS_OF).days.map((d) => d.dow),
    liftDaysSource: repo.strengthScheduleRead(AS_OF).source,
  });
  assert.deepEqual(layout.lift_days, ["Monday", "Tuesday"]);
  assert.equal(layout.lift_days_source, "observed");

  const map = weekdayPlanDayMap(
    [
      { day_number: 1, day_type: "training", names: ["Back Squat"], cardio: [] },
      { day_number: 2, day_type: "training", names: ["Barbell Bench Press"], cardio: [] },
      { day_number: 3, day_type: "rest", names: [], cardio: [] },
    ],
    [1, 2],
    []
  );
  assert.deepEqual(
    [1, 2].map((dow) => map.get(dow).day_number),
    [1, 2]
  );
  assert.equal(map.get(0).day_number, 3, "an unobserved weekday gets the rest day, never a lift");
});

test("renderStrengthSchedule says OBSERVED when it is reading the log, never STATED", () => {
  const line = renderStrengthSchedule({
    strength_schedule: { days: [{ dow: 1 }, { dow: 3 }], source: "observed", weeks_seen: 4, weeks_window: 6 },
  });
  assert.match(line, /OBSERVED LIFTING DAYS \(from the log, 4 of the last 6 weeks/);
  assert.match(line, /Monday, Wednesday\./);
  assert.match(line, /never tell them they asked for it/);
  assert.doesNotMatch(line, /STATED LIFTING DAYS/);

  const said = renderStrengthSchedule({ strength_schedule: { days: [{ dow: 1 }], source: "stated" } });
  assert.match(said, /STATED LIFTING DAYS: Monday\./);
  assert.doesNotMatch(said, /OBSERVED/);
});
