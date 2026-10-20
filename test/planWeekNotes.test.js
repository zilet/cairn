// planWeekNotes.test.js — the Plan strip says WHY a day differs from its usual slot
// (src/domain/training/plan-week.ts, `plan_day.note`).
//
// Live (2026-10-20): Tuesday's strip cell read "Push B" where the week had Lower, because a
// 6.6 km run was logged that morning and today's line swapped Push B in; Lower moved to
// Friday, a trip day in the race build's taper week. The strip showed only a different
// name. Now each such cell carries one server-authored line, in priority
// swap/after_run > moved > taper > trip, every reason READ from the source that decided it.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { stressBudgetCalendarTrim } from "../dist/repo/stress-budget.js";
import { violatesReadingGrammar } from "../dist/repo/day-read-grammar.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { legTrimFocus } from "../dist/repo/plan-day-focus.js";
import { createBlock } from "../dist/repo/program-blocks.js";

beforeEach(() =>
  resetTables(
    "logged_sets",
    "sessions",
    "activities",
    "plan_items",
    "plan_days",
    "app_state",
    "profile",
    "day_reads",
    "context_events",
    "daily_session_decisions",
    "daily_session_compositions",
    "exercises",
    "program_blocks"
  )
);

const TUE = "2026-04-21"; // the week starts Monday 2026-04-20

function seedWeekdayPlan() {
  for (const [name, muscle_group] of [
    ["Bench Press", "chest"],
    ["Barbell Row", "back"],
    ["Back Squat", "quads"],
    ["Romanian Deadlift", "hamstrings"],
    ["Incline DB Press", "chest"],
    ["Lat Pulldown", "back"],
  ])
    repo.upsertExercise({ name, muscle_group, mode: "reps" });
  repo.savePlanDay(1, "Push A", "Chest & shoulders", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  repo.savePlanDay(2, "Lower", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8 },
  ]);
  repo.savePlanDay(3, "Pull", "Back", [{ exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8 }]);
  repo.savePlanDay(4, "Push B", "Incline", [{ exercise: "Incline DB Press", sets: 3, rep_low: 8, rep_high: 10 }]);
  repo.savePlanDay(5, "Back B", "Lats", [{ exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 10 }]);
  repo.setProfile({
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete", updated_at: TUE },
  });
}

// Today's selection hands the morning to a day the map laid later in the week.
function adaptToday(reason) {
  const plain = planWeek(TUE);
  const mapped = plain.days.find((d) => d.date === TUE).plan_day;
  const later = plain.days.find((d) => d.date > TUE && d.plan_day && d.plan_day.day_number !== mapped.day_number);
  assert.ok(later, "the fixture's week holds another lift day later on");
  db.prepare(
    `INSERT INTO day_reads (date, kind, headline, why, focus, signals, source) VALUES (?, 'train', 'x', 'y', NULL, ?, 'deterministic')`
  ).run(
    TUE,
    JSON.stringify({
      plan_selection: {
        selected: { day_number: later.plan_day.day_number },
        adapted: true,
        ...(reason ? { reason } : {}),
      },
    })
  );
  return { mapped, laterDate: later.date, adaptedTo: later.plan_day };
}

const WEEKDAY = (iso) =>
  ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
    new Date(`${iso}T12:00:00Z`).getUTCDay()
  ];

test("a swap says why on today's cell and where the bumped day went — on both cells", () => {
  seedWeekdayPlan();
  const { mapped, laterDate, adaptedTo } = adaptToday(
    "you're giving legs another day and training what's fresher instead, while your usual lower day would overlap legs, still recovering"
  );
  const week = planWeek(TUE);
  const today = week.days.find((d) => d.date === TUE);
  assert.equal(today.plan_day.day_number, adaptedTo.day_number);
  assert.equal(today.plan_day.note.kind, "swap");
  const text = today.plan_day.note.text;
  assert.ok(text.includes(adaptedTo.name), text);
  assert.ok(text.includes(mapped.name), text);
  assert.match(text, /giving legs another day/, "the selection's own reason, read — never re-derived");
  assert.doesNotMatch(text, /while your usual/, "the lead clause only: a cell names why, not an inventory");
  assert.ok(text.includes(WEEKDAY(laterDate)), `names the bumped day's new weekday: ${text}`);

  const moved = week.days.find((d) => d.date === laterDate);
  assert.equal(moved.plan_day.day_number, mapped.day_number, "the two days traded places");
  assert.equal(moved.plan_day.note.kind, "moved");
  assert.ok(moved.plan_day.note.text.includes(mapped.name));
  assert.ok(moved.plan_day.note.text.includes("Tuesday"), moved.plan_day.note.text);

  // Every other cell reads as itself.
  for (const cell of week.days.filter((d) => d.date !== TUE && d.date !== laterDate)) {
    assert.equal(cell.plan_day?.note ?? null, null, cell.date);
  }
  for (const note of [today.plan_day.note, moved.plan_day.note]) {
    assert.ok(!violatesReadingGrammar(note.text), note.text);
  }
});

test("a swap with no reason on file still says what stands in for what", () => {
  seedWeekdayPlan();
  const { mapped, adaptedTo } = adaptToday(null);
  const today = planWeek(TUE).days.find((d) => d.date === TUE);
  assert.equal(today.plan_day.note.kind, "swap");
  assert.ok(today.plan_day.note.text.includes(adaptedTo.name));
  assert.ok(today.plan_day.note.text.includes(mapped.name));
});

test("a run logged today is the swap's reason: after_run, with the bumped day's weekday", () => {
  seedWeekdayPlan();
  const { mapped, laterDate } = adaptToday("today steps around legs, still carrying recent work");
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'running', 38, 6.6)`).run(TUE);
  const week = planWeek(TUE);
  const today = week.days.find((d) => d.date === TUE);
  assert.ok(week.strength_line.run_in, "the one strength line sees the run");
  assert.equal(today.plan_day.note.kind, "after_run");
  assert.match(today.plan_day.note.text, /run/i);
  assert.ok(today.plan_day.note.text.includes(`${mapped.name} `), today.plan_day.note.text);
  assert.ok(today.plan_day.note.text.includes(WEEKDAY(laterDate)), today.plan_day.note.text);
  assert.equal(week.days.find((d) => d.date === laterDate).plan_day.note.kind, "moved");
});

test("no swap, no trim, no trip: no cell carries a note", () => {
  seedWeekdayPlan();
  const week = planWeek(TUE);
  for (const cell of week.days) assert.equal(cell.plan_day?.note ?? null, null, cell.date);
});

test("a lift day inside a trip says it is the athlete's to skip; a done day says nothing", () => {
  seedWeekdayPlan();
  repo.addContextEvent({
    kind: "trip",
    title: "Clearwater FL",
    start_date: "2026-04-23",
    end_date: "2026-04-25",
    meta: { location: "Clearwater" },
  });
  const week = planWeek(TUE);
  const thu = week.days.find((d) => d.date === "2026-04-23");
  const fri = week.days.find((d) => d.date === "2026-04-24");
  for (const cell of [thu, fri]) {
    assert.ok(cell.travel, "the cell is inside the trip");
    assert.equal(cell.plan_day.note.kind, "trip");
    assert.match(cell.plan_day.note.text, /skip|catch-up/i);
    assert.ok(!violatesReadingGrammar(cell.plan_day.note.text), cell.plan_day.note.text);
  }
  // Saturday is inside the trip but holds no lift: no lift, no note.
  assert.equal(week.days.find((d) => d.date === "2026-04-25").plan_day?.note ?? null, null);
  // A lift already logged inside the trip is done — nothing to explain.
  repo.logSetByName({ date: "2026-04-23", exercise: "Barbell Row", weight: 135, reps: 8, day_number: 3 });
  const after = planWeek("2026-04-24").days.find((d) => d.date === "2026-04-23");
  assert.equal(after.status, "done");
  assert.equal(after.plan_day?.note ?? null, null);
});

// ---------- the race build's leg trim ----------

const RACE = "2026-11-01"; // a Sunday: taper week 10-19, race week 10-26
const RACE_TUE = "2026-10-20";

function seedRaceAthlete() {
  for (const [name, muscle_group] of [
    ["Barbell Bench Press", "chest"],
    ["Pendlay Row", "back"],
    ["Back Squat", "quads"],
    ["Leg Curl", "hamstrings"],
    ["Dumbbell Bench Press", "chest"],
    ["Deadlift", "hamstrings"],
    ["Bulgarian Split Squat", "quads"],
  ])
    repo.upsertExercise({ name, muscle_group, mode: "reps" });
  const item = (exercise, target_weight) => ({ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight });
  repo.replacePlan([
    { day_number: 1, name: "Push", items: [item("Barbell Bench Press", 135)] },
    { day_number: 2, name: "Pull", items: [item("Pendlay Row", 150)] },
    { day_number: 3, name: "Lower A", items: [item("Back Squat", 185), item("Leg Curl", 120)] },
    { day_number: 4, name: "Upper", items: [item("Dumbbell Bench Press", 55)] },
    { day_number: 5, name: "Lower B", items: [item("Deadlift", 225), item("Bulgarian Split Squat", 60)] },
  ]);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["strength", "muscle", "endurance"], endurance_role: "supporting" },
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
    },
    endurance_goal: { mode: "race", event: "Riverside Half", date: RACE, distance_km: 21.1, target: "sub-2:00" },
  });
}

function lowerCells(week) {
  return week.days.filter(
    (d) => d.date >= RACE_TUE && d.plan_day?.role === "strength" && /Lower/.test(d.plan_day.name) && d.status !== "done"
  );
}

test("taper week: a lift day ahead whose legs the stress budget trims says so; upper days stay quiet", () => {
  seedRaceAthlete();
  const week = planWeek(RACE_TUE);
  const lowers = lowerCells(week);
  assert.ok(lowers.length > 0, "the taper week holds a lower day still ahead");
  let trimmed = 0;
  for (const cell of lowers) {
    const items = repo.getPlanDay(cell.plan_day.day_number).items;
    const trim = stressBudgetCalendarTrim(cell.date, items, "supporting");
    if (!trim) continue;
    trimmed++;
    assert.equal(cell.plan_day.note?.kind, "taper", cell.date);
    assert.ok(cell.plan_day.note.text.includes(cell.plan_day.name), cell.plan_day.note.text);
    assert.match(cell.plan_day.note.text, /taper|lighter/i);
    assert.ok(!violatesReadingGrammar(cell.plan_day.note.text), cell.plan_day.note.text);
  }
  assert.ok(trimmed > 0, "the stress budget's own calendar half trims this week's legs");
  for (const cell of week.days.filter((d) => d.plan_day && !/Lower/.test(d.plan_day.name))) {
    assert.notEqual(cell.plan_day.note?.kind, "taper", `${cell.date} ${cell.plan_day.name}`);
  }
});

test("priority: a taper day inside a trip says taper; an upper day inside the trip says trip", () => {
  seedRaceAthlete();
  repo.addContextEvent({ kind: "trip", title: "Clearwater FL", start_date: "2026-10-21", end_date: "2026-10-25" });
  const week = planWeek(RACE_TUE);
  const tripLower = lowerCells(week).find((d) => d.travel && d.plan_day.note?.kind === "taper");
  assert.ok(tripLower, "a trimmed lower day inside the trip keeps the taper line");
  const tripUpper = week.days.find(
    (d) => d.travel && d.date >= RACE_TUE && d.plan_day?.role === "strength" && !/Lower/.test(d.plan_day.name)
  );
  assert.ok(tripUpper, "the trip holds an upper day too");
  assert.equal(tripUpper.plan_day.note?.kind, "trip");
});

test("today's taper comes from this morning's envelope when it was composed for today's day", () => {
  seedRaceAthlete();
  const week = planWeek("2026-10-21");
  const today = week.days.find((d) => d.date === "2026-10-21");
  assert.ok(today.plan_day, "Wednesday lifts");
  // An envelope for today naming the key-run eve on this plan day (the morning's own rule).
  db.prepare(
    `INSERT INTO daily_session_decisions (date, composition_id, policy_version, input_fingerprint, kind, envelope_json)
     VALUES (?, NULL, 'daily_decision_v7', 'fp-test', 'train', ?)`
  ).run(
    "2026-10-21",
    JSON.stringify({
      date: "2026-10-21",
      kind: "train",
      template: { day_number: today.plan_day.day_number },
      stress: { code: "key_run_eve", groups: ["hamstrings"], load_held: true },
    })
  );
  const again = planWeek("2026-10-21").days.find((d) => d.date === "2026-10-21");
  assert.equal(again.plan_day.note?.kind, "taper");
  assert.match(again.plan_day.note.text, /key run/i);
});

// ---------- a moved / swapped day that is ALSO trimmed ----------
//
// Live (2026-10-20, taper week): today's line swapped Push B in after a morning run and
// Lower moved to Friday — a trimmed day — but Friday's cell said only "Lower lands here
// this week — Tuesday went to Push B", while the day page said "Taper week: the legs go
// lighter." One note per cell stays; the move and the trim now share it.

// A taper-week morning whose mapped day is a trimmed Lower with an upper day later on.
function taperSwapFixture() {
  for (const d of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) {
    const plain = planWeek(d);
    const today = plain.days.find((c) => c.date === d);
    if (!today?.plan_day || !/Lower/.test(today.plan_day.name)) continue;
    const items = repo.getPlanDay(today.plan_day.day_number).items;
    if (!stressBudgetCalendarTrim(d, items, "supporting")) continue;
    const later = plain.days.find(
      (c) => c.date > d && c.plan_day?.role === "strength" && !/Lower/.test(c.plan_day.name)
    );
    if (!later) continue;
    db.prepare(
      `INSERT INTO day_reads (date, kind, headline, why, focus, signals, source) VALUES (?, 'train', 'x', 'y', NULL, ?, 'deterministic')`
    ).run(d, JSON.stringify({ plan_selection: { selected: { day_number: later.plan_day.day_number }, adapted: true } }));
    return { today: d, lower: today.plan_day, laterDate: later.date, upper: later.plan_day };
  }
  return null;
}

test("a moved day that is also trimmed says both in one sentence; its focus carries the trim", () => {
  seedRaceAthlete();
  const fx = taperSwapFixture();
  assert.ok(fx, "the taper week holds a trimmed Lower with an upper day after it");
  const week = planWeek(fx.today);
  const moved = week.days.find((d) => d.date === fx.laterDate);
  assert.equal(moved.plan_day.day_number, fx.lower.day_number, "Lower traded into the later weekday");
  assert.equal(moved.plan_day.note?.kind, "moved", "one note per cell: the move leads");
  const text = moved.plan_day.note.text;
  assert.ok(text.includes(fx.lower.name), text);
  assert.match(text, /taper|lighter/i, `the trim rides in the same line: ${text}`);
  assert.equal(text.split(/(?<=[.!?])\s+/).length, 1, `one calm sentence: ${text}`);
  assert.ok(!violatesReadingGrammar(text), text);

  // The cell's focus says the trim the way the day page does.
  assert.match(String(moved.plan_day.focus), /taper|lighter/i, String(moved.plan_day.focus));
  const detail = dayDetail(fx.laterDate, { today: fx.today });
  assert.equal(detail.lift.trim, "race_taper_legs");
  assert.equal(detail.lift.focus, moved.plan_day.focus, "Train's strip and the day page read one focus");

  // The swapped-in upper day carries no trim.
  const today = week.days.find((d) => d.date === fx.today);
  assert.equal(today.plan_day.day_number, fx.upper.day_number);
  assert.doesNotMatch(today.plan_day.note.text, /taper|lighter|leg sets/i, today.plan_day.note.text);
});

test("today's swapped day trimmed by the morning's envelope keeps the swap and says the trim", () => {
  seedRaceAthlete();
  const fx = taperSwapFixture();
  assert.ok(fx);
  db.prepare(
    `INSERT INTO daily_session_decisions (date, composition_id, policy_version, input_fingerprint, kind, envelope_json)
     VALUES (?, NULL, 'daily_decision_v7', 'fp-test', 'train', ?)`
  ).run(
    fx.today,
    JSON.stringify({
      date: fx.today,
      kind: "train",
      template: { day_number: fx.upper.day_number },
      stress: { code: "key_run_eve", groups: ["hamstrings"], load_held: true },
    })
  );
  const today = planWeek(fx.today).days.find((d) => d.date === fx.today);
  assert.equal(today.plan_day.note?.kind, "swap");
  assert.ok(today.plan_day.note.text.includes(fx.upper.name), today.plan_day.note.text);
  assert.match(today.plan_day.note.text, /key run/i, today.plan_day.note.text);
  assert.ok(!violatesReadingGrammar(today.plan_day.note.text), today.plan_day.note.text);
});

test("legTrimFocus is idempotent: a cell focus that already carries the trim never doubles it", () => {
  for (const trim of ["race_taper_legs", "race_week_legs", "key_run_eve"]) {
    for (const date of ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"]) {
      const once = legTrimFocus("Squat-led lower body.", trim, date);
      assert.equal(legTrimFocus(once, trim, date), once, `${trim} ${date}`);
    }
  }
});

test("a taper-trimmed day's point follows the race week, never the block's volume line", () => {
  seedRaceAthlete();
  createBlock({ goal: "Accumulation", focus: "hypertrophy", total_weeks: 6, week_index: 1, started_at: "2026-10-19" });
  const week = planWeek(RACE_TUE);
  const trimmed = lowerCells(week).find((cell) => cell.plan_day.note?.kind === "taper");
  assert.ok(trimmed, "a trimmed lower day ahead");
  const detail = dayDetail(trimmed.date, { today: RACE_TUE });
  assert.equal(detail.lift.trim, "race_taper_legs");
  assert.match(detail.lift.point, /taper/i, detail.lift.point);
  assert.doesNotMatch(detail.lift.point, /this block|Volume is the job|work capacity/i, detail.lift.point);
  assert.ok(!violatesReadingGrammar(detail.lift.point), detail.lift.point);
  // An upper day the trim does not touch keeps the block's own point.
  const upper = week.days.find((d) => d.date >= RACE_TUE && d.plan_day?.role === "strength" && !/Lower/.test(d.plan_day.name));
  const upperDetail = dayDetail(upper.date, { today: RACE_TUE });
  assert.equal(upperDetail.lift.trim, null);
  assert.doesNotMatch(upperDetail.lift.point, /taper/i);
});

// ---------- a LOGGED day in place of the map's day (live, 2026-10-20) ----------
//
// Tuesday's Lower was swapped for Push B after a morning run; Push B was then LOGGED, and the
// trade (which ran only for today's unlogged line) stopped: the strip read Mon Upper · Tue
// Push B · Wed Pull · Thu Push A · Fri Push B, Lower gone and Push B twice. The placement now
// re-places a day displaced by a logged session the same way, and Friday says why.

const LIVE_MON = "2026-10-19";
const LIVE_TUE = "2026-10-20";
const LIVE_FRI = "2026-10-23";

function seedLiveWeek() {
  for (const [name, muscle_group] of [
    ["Barbell Bench Press", "chest"],
    ["Overhead Press", "shoulders"],
    ["Back Squat", "quads"],
    ["Romanian Deadlift", "hamstrings"],
    ["Leg Curl", "hamstrings"],
    ["Pendlay Row", "back"],
    ["Barbell Curl", "biceps"],
    ["Lat Pulldown", "back"],
  ])
    repo.upsertExercise({ name, muscle_group, mode: "reps" });
  const item = (exercise, target_weight) => ({ exercise, sets: 3, rep_low: 6, rep_high: 8, target_weight });
  repo.replacePlan([
    { day_number: 1, name: "Push A", items: [item("Barbell Bench Press", 155)] },
    // The curl ahead of the squat: the stored order is not effect order (out_of_order).
    {
      day_number: 2,
      name: "Lower",
      items: [item("Leg Curl", 120), item("Back Squat", 185), item("Romanian Deadlift", 185)],
    },
    { day_number: 3, name: "Upper back & arms", items: [item("Pendlay Row", 150), item("Barbell Curl", 70)] },
    { day_number: 4, name: "Push B", items: [item("Overhead Press", 95)] },
    { day_number: 5, name: "Pull", items: [item("Lat Pulldown", 140)] },
  ]);
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    training_intent: { priorities: ["strength", "muscle", "endurance"], endurance_role: "supporting" },
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete" },
    endurance_schedule: {
      days: [
        { dow: 2, kind: "easy" },
        { dow: 4, kind: "quality" },
        { dow: 0, kind: "long" },
      ],
    },
    endurance_goal: { mode: "race", event: "Riverside Half", date: RACE, distance_km: 21.1, target: "sub-2:00" },
  });
  repo.addContextEvent({ kind: "trip", title: "Clearwater FL", start_date: LIVE_FRI, end_date: "2026-10-25" });
  // Last week ended on Lower, so this week deals from Upper — and the key-run trade keeps
  // Lower off Friday (the day after the threshold run): Mon Upper · Tue Lower · Wed Pull ·
  // Thu Push A · Fri Push B.
  logDay("2026-10-16", 2, [["Back Squat", 185]]);
}

function logDay(date, day_number, sets) {
  for (const [exercise, weight] of sets) repo.logSetByName({ date, exercise, weight, reps: 6, rir: 2, day_number });
  repo.finishSession(db.prepare(`SELECT id FROM sessions WHERE date = ?`).get(date).id);
}

const liftNumbers = (week) =>
  week.days.filter((d) => d.date && d.dow >= 1 && d.dow <= 5).map((d) => d.plan_day?.day_number ?? null);

test("live: Push B logged on Tuesday's Lower puts Lower on Friday, and Friday says it lands there lighter", () => {
  seedLiveWeek();
  assert.deepEqual(liftNumbers(planWeek(LIVE_MON)), [3, 2, 5, 1, 4], "the fixture's key-run-aware map");
  logDay(LIVE_MON, 3, [["Pendlay Row", 150]]);
  db.prepare(`INSERT INTO activities (date, type, duration_min, distance_km) VALUES (?, 'running', 38, 6.6)`).run(
    LIVE_TUE
  );
  logDay(LIVE_TUE, 4, [["Overhead Press", 95]]);

  const week = planWeek(LIVE_TUE);
  assert.deepEqual(liftNumbers(week), [3, 4, 5, 1, 2], "Lower is back in the week, on Friday");
  const lifted = liftNumbers(week).filter((n) => n != null);
  assert.equal(new Set(lifted).size, lifted.length, "no plan day twice");

  const fri = week.days.find((d) => d.date === LIVE_FRI);
  assert.equal(fri.plan_day.name, "Lower");
  assert.equal(fri.plan_day.out_of_order, true, "the moved day keeps its own order flag");
  assert.equal(fri.plan_day.note?.kind, "moved", JSON.stringify(fri.plan_day.note));
  const text = fri.plan_day.note.text;
  assert.ok(text.includes("Lower"), text);
  assert.match(text, /taper|lighter/i, `the taper trim rides in the move's sentence: ${text}`);
  assert.equal(text.split(/(?<=[.!?])\s+/).length, 1, `one calm sentence: ${text}`);
  assert.ok(!violatesReadingGrammar(text), text);
  assert.equal(dayDetail(LIVE_FRI, { today: LIVE_TUE }).lift.trim, "race_taper_legs");

  // Today's logged cell is done, and says nothing.
  const tue = week.days.find((d) => d.date === LIVE_TUE);
  assert.equal(tue.status, "done");
  assert.equal(tue.plan_day?.note ?? null, null);

  // Today's line: one calm sentence, never "Push B · logged · run in".
  const lineText = week.strength_line.text;
  assert.equal(week.strength_line.state, "logged");
  assert.ok(week.strength_line.run_in, "the run is seen");
  assert.ok(lineText.includes("Push B"), lineText);
  assert.match(lineText, /run/i, lineText);
  assert.doesNotMatch(lineText, / · /, lineText);
  assert.match(lineText, /\.$/, lineText);
  assert.ok(!violatesReadingGrammar(lineText), lineText);
});

test("a displaced day with no open slot is said on the week, never silently dropped", () => {
  seedLiveWeek();
  logDay(LIVE_MON, 3, [["Pendlay Row", 150]]);
  // Push A logged on Tuesday's Lower: Thursday's Push A is the only repeat — the quality run's day.
  logDay(LIVE_TUE, 1, [["Barbell Bench Press", 155]]);
  const week = planWeek(LIVE_TUE);
  assert.deepEqual(liftNumbers(week), [3, 1, 5, 1, 4], "Lower never lands on the quality-run day");
  assert.equal(week.unplaced.length, 1);
  const [u] = week.unplaced;
  assert.equal(u.day_number, 2);
  assert.equal(u.name, "Lower");
  assert.ok(u.text.includes("Lower"), u.text);
  assert.match(u.text, /key run/i, u.text);
  assert.ok(!violatesReadingGrammar(u.text), u.text);
  assert.doesNotMatch(u.text, /\bmust\b|\bshould\b|\bmissed\b/i, u.text);
});

test("a week with nothing displaced has no unplaced days", () => {
  seedWeekdayPlan();
  assert.deepEqual(planWeek(TUE).unplaced, []);
});
