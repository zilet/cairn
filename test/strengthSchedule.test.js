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

// A hybrid athlete's week: five strength days (numbered 1,2,3,4,6) and an empty editor
// scaffold. Plan days hold strength only — runs and rest are the calendar's, so the
// weekend is not a plan row at all.
const LIVE_RING = [
  { day_number: 1, day_type: "training", names: ["Back Squat"] },
  { day_number: 2, day_type: "training", names: ["Barbell Bench Press"] },
  { day_number: 3, day_type: "training", names: ["Barbell Row"] },
  { day_number: 4, day_type: "training", names: ["Romanian Deadlift"] },
  { day_number: 5, day_type: "training", names: [] },
  { day_number: 6, day_type: "training", names: ["Goblet Squat"] },
];

test("weekdayPlanDayMap lays the stated week: Mon-Fri lift, the weekend is the calendar's", () => {
  const map = weekdayPlanDayMap(LIVE_RING, [1, 2, 3, 4, 5]);
  // The five strength days land on the five stated lifting weekdays, in ring order.
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((dow) => map.get(dow).day_number),
    [1, 2, 3, 4, 6],
    "Mon..Fri take the plan's strength days 1,2,3,4,6 in order — the empty scaffold is skipped"
  );
  // The law: no unstated weekday is handed a plan day. Saturday's run and Sunday's rest
  // are calendar facts (calendarDayRead), never a mapped row.
  assert.equal(map.size, 5, "only the lifting weekdays are mapped");
  for (const dow of [0, 6]) {
    assert.equal(map.has(dow), false, `dow ${dow} is never handed a plan day`);
  }
});

test("weekdayPlanDayMap is inert with no stated schedule and cycles a short pool", () => {
  assert.equal(weekdayPlanDayMap(LIVE_RING, []).size, 0, "unstated -> empty map -> positional ring");
  assert.equal(weekdayPlanDayMap(LIVE_RING, null).size, 0);

  // Three strength days against five stated lifting weekdays: every stated day still
  // carries a strength session, the pool wrapping rather than going quiet.
  const short = [
    { day_number: 1, day_type: "training", names: ["Back Squat"] },
    { day_number: 2, day_type: "training", names: ["Barbell Bench Press"] },
    { day_number: 3, day_type: "training", names: ["Barbell Row"] },
    { day_number: 4, day_type: "training", names: [] },
  ];
  const map = weekdayPlanDayMap(short, [1, 2, 3, 4, 5]);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((dow) => map.get(dow).day_number),
    [1, 2, 3, 1, 2]
  );
  assert.equal(map.has(0), false, "Sunday is never a lift");
  assert.equal(map.has(6), false, "Saturday is never a lift");
  // The ring's phase: a strength start deals the pool from that offset.
  const phased = weekdayPlanDayMap(short, [1, 2, 3, 4, 5], 1);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((dow) => phased.get(dow).day_number),
    [2, 3, 1, 2, 3]
  );
  // A plan with no strength day has nothing honest to put on a lifting weekday.
  assert.equal(weekdayPlanDayMap([{ day_number: 1, day_type: "training", names: [] }], [1, 3]).size, 0);
});

test("the adaptive ring points an unanchored weekend at the calendar's run and rest, never a lift", () => {
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
  ]);

  const SATURDAY = "2026-04-25";
  const SUNDAY = "2026-04-26";
  // Positional, with nothing stated: Saturday is just the ring's next slot.
  const before = repo.selectAdaptivePlanDay(SATURDAY);
  assert.ok(before);

  repo.setProfile({ strength_schedule: WORKDAYS, endurance_schedule: { days: [{ dow: 6, kind: "long" }] } });
  const after = repo.selectAdaptivePlanDay(SATURDAY);
  assert.ok(after);
  assert.equal(after.day_number, null, "Saturday is the stated long-run day -> no plan day at all");
  assert.equal(after.day_type, "run");
  assert.deepEqual(after.selection.calendar, { kind: "run", run_kind: "long" });
  assert.equal(repo.selectedPlanDayForDate(SATURDAY), null, "the Today door hands no lift on the run day");

  const sunday = repo.selectAdaptivePlanDay(SUNDAY);
  assert.equal(sunday.day_number, null);
  assert.equal(sunday.day_type, "rest", "Sunday is neither lifted nor run -> the calendar's rest day");
  assert.equal(sunday.selection.rest_day, true);

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
// The same athlete's ring: five strength days. (Their rest day and long run are the
// calendar's — a weekday neither lifted nor run on, and a stated run weekday — so they
// are not plan rows; day 5 was the retired rest row, hence the gap.)
const LIVE_PLAN = [
  strengthDay(1, "Lower A", "Back Squat"),
  strengthDay(2, "Push", "Barbell Bench Press"),
  strengthDay(3, "Pull", "Barbell Row"),
  strengthDay(4, "Lower B", "Romanian Deadlift"),
  strengthDay(6, "Full Body", "Goblet Squat"),
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
  assert.equal(saturday.day_number, null, "Saturday is the stated long-run day, never a lift");
  assert.equal(saturday.day_type, "run");
  assert.equal(saturday.selection.calendar.run_kind, "long");
  // Sunday is a stated EASY run day in this week, so it reads run too — rest is only a
  // weekday with neither.
  const sunday = repo.selectAdaptivePlanDay("2026-04-26");
  assert.equal(sunday.day_number, null, "Sunday is never a lift");
  assert.equal(sunday.day_type, "run");
  assert.equal(sunday.selection.calendar.run_kind, "easy");

  // Monday is the next stated LIFTING weekday, and it takes the strength day that
  // follows the one actually logged (day 4 -> day 6, the next strength day).
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
  ]);
  repo.setProfile({ strength_schedule: WORKDAYS, endurance_schedule: { days: [{ dow: 6, kind: "long" }] } });

  // An unanchored week deals the pool from its first day: S1..S5, and S6 waits.
  assert.deepEqual(picks(WEEK_1.slice(0, 5)), [1, 2, 3, 4, 5]);
  // The athlete lifts S5 on Friday, closing the week where the plan said it would.
  repo.logSetByName({ date: "2026-04-24", exercise: "Overhead Press", weight: 95, reps: 8 });
  assert.deepEqual(picks(WEEK_2.slice(0, 5)), [6, 1, 2, 3, 4], "S6 opens the following Monday");

  // The law, over the whole fortnight: a weekend day is the long run (Saturday) or the
  // calendar's rest (Sunday) — never a plan day.
  for (const weekend of [WEEK_1[5], WEEK_1[6], WEEK_2[5], WEEK_2[6]]) {
    const picked = repo.selectAdaptivePlanDay(weekend);
    assert.equal(picked.day_number, null, `${weekend} must never be handed a strength day`);
  }
  assert.equal(repo.selectAdaptivePlanDay(WEEK_1[5]).day_type, "run");
  assert.equal(repo.selectAdaptivePlanDay(WEEK_1[6]).day_type, "rest");
});

test("fewer strength days than lifting weekdays: the ring repeats so every one of them lifts", () => {
  repo.replacePlan([
    strengthDay(1, "S1", "Back Squat"),
    strengthDay(2, "S2", "Barbell Bench Press"),
    strengthDay(3, "S3", "Barbell Row"),
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

// A Wednesday with Push on Monday, Pull on Tuesday beside a run, and Lower A scheduled.
// Legs carried the week's running, the scorer only compared against the day before's
// session, and the Push day — "not just trained" — replaced Lower A. A week of two
// Push days and no legs is not an adaptation, it is a hole.
const PPL = [
  strengthDay(1, "Push", "Barbell Bench Press"),
  strengthDay(2, "Pull", "Pendlay Row"),
  strengthDay(3, "Lower A", "Back Squat"),
];

test("a strength day already trained this week never stands in for an untrained one", () => {
  repo.replacePlan(PPL);
  repo.setProfile({ strength_schedule: WORKDAYS });
  repo.logSetByName({ date: "2026-04-20", exercise: "Barbell Bench Press", weight: 135, reps: 8 });
  repo.logSetByName({ date: "2026-04-21", exercise: "Pendlay Row", weight: 135, reps: 8 });
  // A deep leg dose: Lower A is genuinely mostly recovering, the case the swap exists for.
  repo.addActivity({ type: "run", duration_min: 80, distance_km: 13, date: "2026-04-21", text: "Long run" });

  const wednesday = repo.selectAdaptivePlanDay("2026-04-22");
  assert.equal(wednesday.selection.rotation.day_number, 3, "the stated week puts Lower A on Wednesday");
  assert.equal(wednesday.day_number, 3, "Monday's Push is not an alternative while Lower A is still open");
  const push = wednesday.selection.scores.find((entry) => entry.day_number === 1);
  assert.equal(push.done_this_week, true);

  // Once every strength day has had its turn, the short pool repeats as designed.
  repo.logSetByName({ date: "2026-04-22", exercise: "Back Squat", weight: 185, reps: 5 });
  assert.equal(repo.selectAdaptivePlanDay("2026-04-23").day_number, 1, "Thursday wraps back to Push");
});

test("legs only just over their bar keep the scheduled lower day; only a deep dose swaps it", () => {
  // Friday carries Lower B, so Wednesday is not the week's LAST lower day — the weekly
  // lower guarantee (eliteLowerWeek.test.js) keeps a last one even under a deep dose.
  repo.replacePlan([
    ...PPL.slice(0, 3),
    strengthDay(4, "Upper", "Overhead Press"),
    strengthDay(5, "Lower B", "Romanian Deadlift"),
  ]);
  repo.setProfile({ strength_schedule: WORKDAYS });
  repo.logSetByName({ date: "2026-04-20", exercise: "Barbell Bench Press", weight: 135, reps: 8 });
  repo.logSetByName({ date: "2026-04-21", exercise: "Pendlay Row", weight: 135, reps: 8 });
  repo.addActivity({ type: "run", duration_min: 60, distance_km: 10, date: "2026-04-21", text: "Steady run" });

  const shallow = repo.selectAdaptivePlanDay("2026-04-22");
  assert.equal(shallow.day_number, 3, "an ordinary hybrid morning keeps Lower A");
  assert.equal(shallow.selection.adapted, false);

  resetTables("activities");
  repo.addActivity({ type: "run", duration_min: 100, distance_km: 16, date: "2026-04-21", text: "Long run" });
  const deep = repo.selectAdaptivePlanDay("2026-04-22");
  assert.equal(deep.day_number, 4, "a deep leg dose walks forward to the untrained Upper day");
  assert.equal(deep.selection.adapted, true);
});

test("with nothing stated and nothing observed the ring stays positional and the anchor rules", () => {
  repo.replacePlan(LIVE_PLAN);
  // The athlete this ring was written for. A bare week deals the strength pool straight
  // down the Mon -> Sun line (Monday the first strength day), wrapping when the pool
  // runs out — with no calendar known there is no run or rest day to answer instead.
  assert.deepEqual(picks(WEEK_1), [1, 2, 3, 4, 6, 1, 2]);
  assert.deepEqual(
    WEEK_1.map((date) => repo.selectedPlanDayForDate(date).day_number),
    [1, 2, 3, 4, 6, 1, 2]
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
      { day_number: 1, day_type: "training", names: ["Back Squat"] },
      { day_number: 2, day_type: "training", names: ["Barbell Bench Press"] },
    ],
    [1, 2]
  );
  assert.deepEqual(
    [1, 2].map((dow) => map.get(dow).day_number),
    [1, 2]
  );
  assert.equal(map.has(0), false, "an unobserved weekday gets no plan day, never a lift");

  // And the ring itself reads the observed week: the unobserved Sunday is the calendar's rest.
  const sunday = repo.selectAdaptivePlanDay(AS_OF);
  assert.equal(sunday.day_number, null);
  assert.equal(sunday.day_type, "rest");
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
