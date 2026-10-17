// sessionDayTruth.test.js — one answer to "which session was on which day"
// (src/repo/session-day.ts), on every surface that names a day's lift.
//
// The live week of 2026-10-12: Today's strip said Monday was "Pull — heavy row" and
// Wednesday "Lower"; Horizon's week said the reverse; the brain digest had the Pendlay
// rows on Wednesday. A mid-week redraw had rewritten the plan days IN PLACE (savePlanDay
// keeps the row id): the session titles held each session's frozen card against its
// link's NEW name, while the week cell's plan day came off what was lifted. The fixture
// replays that week: Lower Monday, Push Tuesday, Pull Wednesday (the Pendlay row), a
// redraw that swaps day 1 and day 3, Push Thursday, Lower Friday.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { weekRead } from "../dist/domain/training/week-read.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { dayRecord } from "../dist/domain/today/day-record.js";
import { planLookAhead } from "../dist/domain/training/plan-look-ahead.js";
import { todayStrengthLine } from "../dist/repo/today-strength-line.js";
import { loggedSessionDay } from "../dist/repo/session-day.js";
import { planDayDisplayName, planDayNameClaimsWeekCount } from "../dist/repo/plan-day-name.js";
import { replacePlan } from "../dist/repo/plan.js";
import { recentTraining, trainingOnDate } from "../dist/repo/activities.js";

const MON = "2026-04-20";
const TUE = "2026-04-21";
const WED = "2026-04-22";
const THU = "2026-04-23";
const FRI = "2026-04-24";
const LEG_NAME = "Lower — the week's one leg day";

const LOWER = [
  { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 6 },
  { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8 },
];
const PUSH = [
  { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
  { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8 },
];
const PULL = [
  { exercise: "Pendlay Row", sets: 3, rep_low: 6, rep_high: 8 },
  { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 },
];

beforeEach(() =>
  resetTables(
    "logged_sets",
    "session_skips",
    "sessions",
    "daily_session_compositions",
    "daily_session_outcomes",
    "activities",
    "plan_items",
    "plan_days",
    "app_state",
    "profile"
  )
);

function dayId(dayNumber) {
  return db.prepare(`SELECT id FROM plan_days WHERE day_number = ?`).get(dayNumber).id;
}

/** A session linked to `dayNumber`, its items logged, and the plan-built card it was lifted from. */
/**
 * A session linked to `dayNumber` (null: no link), its items logged, and the card it was
 * lifted from — by default the plan-built card for that day.
 */
function liftDay(date, dayNumber, items, { source = "adaptive_plan", title = "The day as composed" } = {}) {
  const planDayId = dayNumber == null ? null : dayId(dayNumber);
  const session = repo.getOrCreateSession(date, planDayId);
  for (const item of items) repo.logSetByName({ date, exercise: item.exercise, weight: 135, reps: 6 });
  // The card the day was lifted from — the only active one for the date.
  db.prepare(`DELETE FROM daily_session_compositions WHERE date = ?`).run(date);
  db.prepare(
    `INSERT INTO daily_session_compositions
       (version, session_id, date, source, status, plan_day_id, title, focus, items_json, request_fingerprint)
     VALUES (1, ?, ?, ?, 'active', ?, ?, NULL, ?, ?)`
  ).run(
    Number(session.id),
    date,
    source,
    source === "adaptive_plan" ? planDayId : null,
    title,
    JSON.stringify(items),
    `fp-${date}`
  );
  return Number(session.id);
}

/** Template mode (no lifting weekdays): Lower / Push / Pull, day 1 and day 3 later swapped in place. */
function layTemplatePlan() {
  repo.savePlanDay(1, "Lower", "Squat and hinge", LOWER);
  repo.savePlanDay(2, "Push A", "Press", PUSH);
  repo.savePlanDay(3, "Pull", "Row and pull", PULL);
}
function swapDaysOneAndThree() {
  repo.savePlanDay(1, "Pull", "Row and pull", PULL);
  repo.savePlanDay(3, "Lower", "Squat and hinge", LOWER);
}

function layTheWeek() {
  repo.savePlanDay(1, LEG_NAME, "Squat and hinge", LOWER);
  repo.savePlanDay(2, "Push A", "Press", PUSH);
  repo.savePlanDay(3, "Pull — heavy row", "Row and pull", PULL);
  repo.setProfile({
    strength_schedule: { days: [1, 2, 3, 4, 5].map((dow) => ({ dow })), source: "athlete", updated_at: MON },
  });
  const ids = {};
  ids[MON] = liftDay(MON, 1, LOWER);
  ids[TUE] = liftDay(TUE, 2, PUSH);
  ids[WED] = liftDay(WED, 3, PULL);
  // The mid-week redraw: day 1 becomes the Pull day and day 3 the leg day, each row
  // rewritten where it stands — Monday's session still links day 1, Wednesday's day 3.
  repo.savePlanDay(1, "Pull — heavy row", "Row and pull", PULL);
  repo.savePlanDay(3, LEG_NAME, "Squat and hinge", LOWER);
  ids[THU] = liftDay(THU, 2, PUSH);
  ids[FRI] = liftDay(FRI, 3, LOWER);
  for (const id of Object.values(ids)) repo.finishSession(id, null);
  return ids;
}

const EXPECTED = {
  [MON]: "Lower",
  [TUE]: "Push A",
  [WED]: "Pull — heavy row",
  [THU]: "Push A",
  [FRI]: "Lower",
};

test("the fixture is the live week: the links still point at the rewritten rows", () => {
  const ids = layTheWeek();
  const link = (id) => db.prepare(`SELECT plan_day_id FROM sessions WHERE id = ?`).get(id).plan_day_id;
  assert.equal(link(ids[MON]), dayId(1), "Monday's Lower session links day 1, now the Pull day");
  assert.equal(link(ids[WED]), dayId(3), "Wednesday's Pull session links day 3, now the leg day");
});

test("every surface names the same session on every day of the week — the log is the truth", () => {
  const ids = layTheWeek();
  const today = FRI;

  // The one resolver.
  for (const [date, title] of Object.entries(EXPECTED)) {
    const s = db.prepare(`SELECT id, plan_day_id FROM sessions WHERE id = ?`).get(ids[date]);
    assert.equal(loggedSessionDay(s.id, s.plan_day_id).title, title, `resolver on ${date}`);
  }

  const week = planWeek(today);
  const read = weekRead(MON, { today });
  const recent = repo.getRecentSessions(10);
  const feed = recentTraining(10);
  for (const [date, title] of Object.entries(EXPECTED)) {
    // Today's strip (GET /api/plan/week): the cell's session title, its plan day agreeing.
    const cell = week.days.find((d) => d.date === date);
    assert.equal(cell.status, "done", `${date} is done`);
    assert.equal(cell.session.title, title, `strip cell ${date}`);
    if (cell.plan_day) assert.equal(cell.plan_day.name, title, `strip cell plan day ${date}`);
    // Horizon's week (GET /api/week).
    const chip = read.days.find((d) => d.date === date);
    assert.equal(chip.lift?.title, title, `Horizon chip ${date}`);
    // Train's latest sessions (GET /api/sessions) and the training feed.
    assert.equal(recent.find((s) => s.date === date)?.title, title, `recent sessions ${date}`);
    assert.equal(feed.find((r) => r.kind === "strength" && r.date === date)?.title, title, `feed ${date}`);
    assert.equal(trainingOnDate(date).find((r) => r.kind === "strength")?.title, title, `day feed ${date}`);
    // The session by date, the day record and the day view.
    assert.equal(repo.getSessionByDate(date).title, title, `session by date ${date}`);
    assert.equal(dayRecord(date, { today }).session?.title, title, `day record ${date}`);
    const detail = dayDetail(date, { today });
    assert.equal(detail?.lift?.title, title, `day view lift ${date}`);
  }

  // Today (Friday, logged): the strength line and the Program look-ahead's today row.
  const line = todayStrengthLine(today);
  assert.equal(line.title, EXPECTED[FRI]);
  assert.equal(line.state, "logged");
  const ahead = planLookAhead(today);
  const todayRow = ahead.weeks.flatMap((w) => w.days).find((d) => d.date === today);
  assert.equal(todayRow?.lift?.title, EXPECTED[FRI], "look-ahead today row");
});

test("Monday — a log that differs from what its plan-day link now prescribes — names what was lifted", () => {
  const ids = layTheWeek();
  const mon = loggedSessionDay(ids[MON], dayId(1));
  assert.equal(mon.title, "Lower");
  assert.equal(mon.day_number, 3, "the day it IS, not the row its link now holds");
  const cell = planWeek(FRI).days.find((d) => d.date === MON);
  assert.equal(cell.plan_day?.day_number, 3);
});

test("a week that lands the leg day twice never prints 'the week's one leg day' on a dated surface", () => {
  layTheWeek();
  const week = planWeek(FRI);
  const read = weekRead(MON, { today: FRI });
  const said = [
    ...week.days.flatMap((d) => [d.session?.title, d.plan_day?.name]),
    ...read.days.flatMap((d) => [d.lift?.title, d.words]),
    ...repo.getRecentSessions(10).map((s) => s.title),
  ].filter(Boolean);
  assert.ok(said.length > 0);
  for (const words of said) assert.doesNotMatch(String(words), /one leg day/i, words);
  // The stored name is the agent's/athlete's data and is left as it was written.
  assert.equal(db.prepare(`SELECT name FROM plan_days WHERE day_number = 3`).get().name, LEG_NAME);
});

test("a session with no plan day to resolve to shows as itself, never a borrowed plan-day name", () => {
  repo.savePlanDay(1, "Push A", "Press", PUSH);
  repo.setProfile({ strength_schedule: { days: [{ dow: 1 }], source: "athlete", updated_at: MON } });
  const session = repo.getOrCreateSession(MON, dayId(1));
  repo.logSetByName({ date: MON, exercise: "90/90 Hip Switch", reps: 8 });
  repo.logSetByName({ date: MON, exercise: "Dead Bug", reps: 10 });
  const logged = loggedSessionDay(Number(session.id), dayId(1));
  assert.equal(logged.day_number, null);
  const cell = planWeek(TUE).days.find((d) => d.date === MON);
  assert.equal(cell.session.title, logged.title);
  assert.equal(cell.plan_day, null, "no plan day is borrowed for a session that was not it");
  const chip = weekRead(MON, { today: TUE }).days.find((d) => d.date === MON);
  assert.equal(chip.lift?.title, logged.title);
  assert.equal(repo.getSessionByDate(MON).title, logged.title);
});

test("planDayDisplayName drops only a subtitle that counts the week", () => {
  assert.equal(planDayDisplayName("Lower — the week's one leg day"), "Lower");
  assert.equal(planDayDisplayName("Lower – the only leg day this week"), "Lower");
  assert.equal(planDayDisplayName("Full Body (twice a week)"), "Full Body");
  assert.equal(planDayDisplayName("Upper A: first of two this week"), "Upper A");
  // An em or en dash starts a subtitle with or without spaces; a hyphen only when spaced.
  assert.equal(planDayDisplayName("Lower—the week's one leg day"), "Lower");
  assert.equal(planDayDisplayName("Lower–the only leg day this week"), "Lower");
  assert.equal(planDayDisplayName("Lower - once a week"), "Lower");
  assert.equal(planDayDisplayName("Pull—heavy row"), "Pull—heavy row");
  assert.equal(planDayDisplayName("Push-Pull (once a week)"), "Push-Pull");
  // Kept verbatim: no count, a week NUMBER, a subtitle that says nothing of the week.
  assert.equal(planDayDisplayName("Pull — heavy row"), "Pull — heavy row");
  assert.equal(planDayDisplayName("Lower — the week's heavy squat day"), "Lower — the week's heavy squat day");
  assert.equal(planDayDisplayName("Push A"), "Push A");
  assert.equal(planDayDisplayName("Lower (week 3)"), "Lower (week 3)");
  assert.equal(planDayDisplayName("Upper B — one-arm rows"), "Upper B — one-arm rows");
  // A name that is nothing but the claim has no other name to say.
  assert.equal(planDayDisplayName("The week's one leg day"), "The week's one leg day");
  assert.equal(planDayNameClaimsWeekCount(LEG_NAME), true);
  assert.equal(planDayNameClaimsWeekCount("Pull — heavy row"), false);
});

test("a restructure keeps the name the agent wrote; only the display drops the week count", () => {
  replacePlan(
    [
      { day_number: 1, name: LEG_NAME, focus: "Squat and hinge", items: LOWER },
      { day_number: 2, name: "Push A", focus: "Press", items: PUSH },
    ],
    { by: "restructure" }
  );
  assert.equal(db.prepare(`SELECT name FROM plan_days WHERE day_number = 1`).get().name, LEG_NAME, "stored as written");
  const week = planWeek(MON);
  assert.equal(week.days.find((d) => d.plan_day?.day_number === 1)?.plan_day.name, "Lower", "said without the count");
});

test("a 'Day N' plan day reads by ONE label on the strip, the session lists and the today line", () => {
  repo.savePlanDay(1, "Day 1", "Squat and hinge", LOWER);
  repo.setProfile({ strength_schedule: { days: [{ dow: 1 }], source: "athlete", updated_at: MON } });
  const id = liftDay(MON, 1, LOWER);
  repo.finishSession(id, null);
  const cell = planWeek(MON).days.find((d) => d.date === MON);
  const line = todayStrengthLine(MON);
  assert.equal(line.title, "Squat and hinge");
  assert.equal(cell.plan_day?.name, line.title);
  assert.equal(cell.session.title, line.title);
  assert.equal(repo.getSessionByDate(MON).title, line.title);
  assert.equal(repo.getRecentSessions(5)[0].title, line.title);
});

// ---- template mode: where a session SITS is the day it resolves to; what it is CALLED is the log ----

test("template mode: a session behind a stale link sits on the day it resolves to, named by its own card", () => {
  layTemplatePlan();
  // Monday: the athlete's own squat card, linked to day 1 (then Lower).
  const id = liftDay(MON, 1, [...LOWER, { exercise: "Leg Extension" }], {
    source: "athlete_override",
    title: "Squat focus",
  });
  repo.finishSession(id, null);
  swapDaysOneAndThree(); // day 1 is now the Pull day; the link still names it
  const week = planWeek(TUE);
  assert.equal(
    week.days.some((d) => d.date),
    false,
    "template mode: no invented weekdays"
  );
  const holding = week.days.filter((d) => d.session?.id === id);
  assert.equal(holding.length, 1, "the session sits on exactly one cell");
  assert.equal(
    holding[0].plan_day?.day_number,
    3,
    "the day the work resolves to, not the rewritten row its link holds"
  );
  assert.equal(holding[0].session.title, "Squat focus", "named by what was lifted");
  assert.equal(holding[0].status, "done");
  assert.equal(week.days.find((d) => d.plan_day?.day_number === 1)?.session, null, "the Pull row borrows nothing");
});

test("template mode: a session with no plan-day link still sits on the day it resolves to", () => {
  layTemplatePlan();
  const id = liftDay(MON, null, [...LOWER, { exercise: "Leg Extension" }], {
    source: "athlete_override",
    title: "Squat focus",
  });
  repo.finishSession(id, null);
  const week = planWeek(TUE);
  const holding = week.days.filter((d) => d.session?.id === id);
  assert.equal(holding.length, 1, "never vanishes from the week");
  assert.equal(holding[0].plan_day?.day_number, 1);
  assert.equal(holding[0].session.title, "Squat focus");
});

test("template mode: today's unfinished session the plan cannot place still is today's cell", () => {
  layTemplatePlan();
  const session = repo.getOrCreateSession(TUE, null);
  repo.logSetByName({ date: TUE, exercise: "90/90 Hip Switch", reps: 8 });
  repo.logSetByName({ date: TUE, exercise: "Dead Bug", reps: 10 });
  const week = planWeek(TUE);
  const todayCells = week.days.filter((d) => d.status === "today");
  assert.equal(todayCells.length, 1, JSON.stringify(week.days.map((d) => [d.plan_day?.name, d.status])));
  assert.equal(todayCells[0].session?.id, Number(session.id), "the session itself is today, shown as itself");
  assert.equal(todayCells[0].plan_day, null);
  assert.equal(todayCells[0].session.title, loggedSessionDay(Number(session.id), null).title);
});

// ---- the today strength line: every title it prints follows the same display rule ----

/** Today's accepted card, nothing lifted yet. */
function todayCard(date, source, title, items) {
  const session = repo.getOrCreateSession(date, null);
  db.prepare(`DELETE FROM daily_session_compositions WHERE date = ?`).run(date);
  db.prepare(
    `INSERT INTO daily_session_compositions
       (version, session_id, date, source, status, plan_day_id, title, focus, items_json, request_fingerprint)
     VALUES (1, ?, ?, ?, 'active', NULL, ?, NULL, ?, ?)`
  ).run(Number(session.id), date, source, title, JSON.stringify(items), `fp-${date}`);
  return Number(session.id);
}

test("today line: an accepted suggestion's title (agent-authored) drops the week count", () => {
  repo.savePlanDay(1, "Push A", "Press", PUSH);
  todayCard(MON, "agent_suggest", LEG_NAME, LOWER);
  const line = todayStrengthLine(MON);
  assert.equal(line.state, "not_started");
  assert.equal(line.title, "Lower");
  assert.doesNotMatch(line.text, /one leg day/);
  assert.match(line.text, /^Lower · not started/);
});

test("today line: a title the athlete typed on their own override is printed exactly as typed", () => {
  repo.savePlanDay(1, "Push A", "Press", PUSH);
  const id = todayCard(MON, "athlete_override", LEG_NAME, LOWER);
  const line = todayStrengthLine(MON);
  assert.equal(line.title, LEG_NAME, "the athlete's own words");
  // Lifted, the session lists say the same words the line does.
  for (const item of LOWER) repo.logSetByName({ date: MON, exercise: item.exercise, weight: 135, reps: 6 });
  assert.equal(todayStrengthLine(MON).title, LEG_NAME);
  assert.equal(repo.getSessionByDate(MON).id, id);
  assert.equal(repo.getSessionByDate(MON).title, LEG_NAME);
});

test("today line: a plan day's stored name drops the week count", () => {
  repo.savePlanDay(1, LEG_NAME, "Squat and hinge", LOWER);
  repo.setProfile({ strength_schedule: { days: [{ dow: 1 }], source: "athlete", updated_at: MON } });
  const line = todayStrengthLine(MON);
  assert.equal(line.day_number, 1);
  assert.equal(line.title, "Lower");
  assert.equal(planWeek(MON).days.find((d) => d.date === MON)?.plan_day?.name, line.title);
});
