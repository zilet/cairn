// planWeek.test.js — Plan-tab week projection (calendar when scheduled, template otherwise).
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { planWeek } from "../dist/domain/training/plan-week.js";

const REF = "2026-04-20"; // a Monday

function reset() {
  resetTables("logged_sets", "sessions", "activities", "plan_items", "plan_days", "app_state", "profile");
}
beforeEach(reset);

function pushDay(dayNumber, name, focus, items, dayType = "training") {
  repo.savePlanDay(dayNumber, name, focus, items, { day_type: dayType });
}

function setStrengthSchedule(dows) {
  repo.setProfile({
    strength_schedule: {
      days: dows.map((dow) => ({ dow })),
      source: "athlete",
      updated_at: REF,
    },
  });
}

test("empty plan returns empty days", () => {
  const week = planWeek(REF);
  assert.equal(week.as_of, REF);
  assert.equal(week.week_start, REF);
  assert.deepEqual(week.days, []);
  assert.equal(week.layout.clean, true);
});

test("no schedule → template order with weekday null", () => {
  pushDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  pushDay(2, "Pull", "Pull", [{ exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8 }]);
  const week = planWeek(REF);
  assert.equal(week.days.length, 2);
  assert.equal(week.days[0].weekday, null);
  assert.equal(week.days[0].dow, null);
  assert.equal(week.days[0].plan_day.day_number, 1);
  assert.equal(week.days[1].plan_day.day_number, 2);
  assert.ok(week.summary == null || typeof week.summary === "string");
});

test("stated lift days → calendar Mon–Sun with weekdays", () => {
  // Mon/Wed/Fri lift (dow 1,3,5)
  pushDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  pushDay(2, "Pull", "Pull", [{ exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8 }]);
  pushDay(3, "Legs", "Legs", [{ exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 6 }]);
  setStrengthSchedule([1, 3, 5]);
  const week = planWeek(REF);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].weekday, "Mon");
  assert.equal(week.days[0].date, REF);
  assert.equal(week.schedule.lift_days_source, "stated");
  assert.ok(week.schedule.lift_days.length >= 3);
  // Monday should carry a strength plan day
  assert.ok(week.days[0].plan_day);
  assert.equal(week.days[0].plan_day.role, "strength");
});

test("logged session marks the day done", () => {
  pushDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  setStrengthSchedule([1, 3, 5]);
  repo.logSetByName({ date: REF, exercise: "Bench Press", weight: 135, reps: 5, day_number: 1 });
  const sessionId = planWeek(REF).days.find((d) => d.date === REF).session.id;
  repo.finishSession(sessionId, null);
  const week = planWeek(REF);
  const mon = week.days.find((d) => d.date === REF);
  assert.ok(mon);
  assert.equal(mon.status, "done");
  assert.ok(mon.session);
  assert.equal(mon.session.date, REF);
  assert.equal(mon.session.finished, true);
});

// Regression: one set logged of five, finish not yet tapped. The strip read the cell
// "Done" while the today line printed under it — and Today, and the Session header —
// said "in progress". An open session on the as-of day is today's work, not done.
test("an in-progress session today reads as today, never done, and agrees with the today line", () => {
  pushDay(1, "Lower A", "Quad-dominant strength", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 6 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 6, rep_high: 8 },
  ]);
  setStrengthSchedule([1, 3, 5]);
  repo.logSetByName({ date: REF, exercise: "Back Squat", weight: 225, reps: 5, day_number: 1 });
  const week = planWeek(REF);
  const mon = week.days.find((d) => d.date === REF);
  assert.equal(mon.status, "today", JSON.stringify(mon));
  assert.ok(mon.session, "the logged work still owns the cell");
  assert.equal(mon.session.finished, false);
  assert.equal(week.strength_line?.state, "in_progress");
  assert.equal(week.progress.lift_days_done, 0, "an open session is not a lifting day in yet");

  // Finishing it closes the cell, in the same words the line then uses.
  repo.finishSession(mon.session.id, null);
  const after = planWeek(REF);
  assert.equal(after.days.find((d) => d.date === REF).status, "done");
  assert.equal(after.strength_line?.state, "logged");

  // A past day's unfinished session is done: the day is over and the log is the truth.
  repo.logSetByName({ date: "2026-04-22", exercise: "Back Squat", weight: 225, reps: 5, day_number: 1 });
  const later = planWeek("2026-04-23");
  assert.equal(later.days.find((d) => d.date === "2026-04-22").status, "done");
});

test("rest day status is rest when no session", () => {
  // Rest is a calendar fact, not a plan row: a weekday neither lifted nor run on.
  pushDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  assert.throws(() => pushDay(2, "Rest", null, [], "rest"), /Rest days aren't plan days/);
  setStrengthSchedule([1]); // only Monday lifts
  const week = planWeek(REF);
  const restCells = week.days.filter((d) => d.status === "rest");
  assert.ok(restCells.length >= 1, "expected at least one rest cell");
  for (const cell of restCells) {
    assert.equal(cell.plan_day, null, "a rest cell borrows no plan row");
    assert.equal(cell.run, null);
    assert.notEqual(cell.dow, 1, "the lifting weekday is never rest");
  }
  assert.equal(week.days.find((d) => d.dow === 1)?.plan_day?.role, "strength");
});

test("out_of_order is true when curl precedes squat on the plan day", () => {
  pushDay(1, "Mixed", "Mixed", [
    { exercise: "Cable Curl", sets: 3, rep_low: 10, rep_high: 12 },
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 6 },
  ]);
  const withPurpose = repo.getPlanWithPurpose(REF);
  assert.equal(withPurpose[0].out_of_order, true);
  const week = planWeek(REF);
  assert.equal(week.days[0].plan_day.out_of_order, true);
});

test("a done cell belongs to the session that was logged, not the projected ring", () => {
  // Mon–Fri lifting, three-day pool: the ring forecasts Mon=Push, Tue=Pull, Wed=Legs.
  pushDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  pushDay(2, "Pull", "Pull", [{ exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8 }]);
  pushDay(3, "Legs", "Legs", [{ exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 6 }]);
  setStrengthSchedule([1, 2, 3, 4, 5]);
  // The athlete lifted Legs on Monday and Push on Tuesday — the log outranks the forecast.
  repo.logSetByName({ date: REF, exercise: "Back Squat", weight: 225, reps: 5, day_number: 3 });
  repo.logSetByName({ date: "2026-04-21", exercise: "Bench Press", weight: 135, reps: 5, day_number: 1 });
  const week = planWeek("2026-04-21");
  const mon = week.days.find((d) => d.date === REF);
  const tue = week.days.find((d) => d.date === "2026-04-21");
  assert.equal(mon.status, "done");
  assert.equal(mon.plan_day.day_number, 3, "Monday's cell names the Legs day that was trained");
  assert.equal(tue.plan_day.day_number, 1);
  assert.equal(tue.session.date, "2026-04-21");
  // The progress line counts what was done and says nothing it cannot ground. Today's
  // session is still open, so only Monday is in until it is finished.
  assert.equal(week.progress.lift_days_done, 1);
  assert.equal(week.progress.lift_days_planned, 5);
  assert.match(String(week.progress.line), /One of five lifting days in/);
  repo.finishSession(tue.session.id, null);
  const finished = planWeek("2026-04-21");
  assert.equal(finished.progress.lift_days_done, 2);
  assert.match(String(finished.progress.line), /Two of five lifting days in/);
  assert.equal(week.progress.runs_done, 0);
});

test("a run logged on the week counts toward progress and marks its cell done", () => {
  pushDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  setStrengthSchedule([1, 3, 5]);
  repo.addActivity({ type: "run", date: "2026-04-21", duration_min: 40, distance_km: 7 });
  const week = planWeek("2026-04-22");
  assert.equal(week.progress.runs_done, 1);
  assert.equal(week.progress.run_km, 7);
  assert.match(String(week.progress.line), /7 km run over one run/);
});

test("an empty week carries no progress line", () => {
  const week = planWeek(REF);
  assert.equal(week.progress.line, null);
  assert.equal(week.progress.lift_days_done, 0);
});

test("a stated run day whose run already landed elsewhere reads covered, never up next", () => {
  // The long run comes from the stated run days, never a plan row.
  pushDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  setStrengthSchedule([1, 3, 5]);
  repo.setProfile({ endurance_schedule: { days: [{ dow: 6, kind: "long" }], source: "athlete", updated_at: REF } });
  // The long run happened Tuesday, not Saturday.
  repo.addActivity({ type: "run", date: "2026-04-21", duration_min: 55, distance_km: 9 });
  const week = planWeek("2026-04-22");
  const sat = week.days.find((d) => d.date === "2026-04-25");
  assert.ok(sat);
  assert.equal(sat.plan_day, null, "a stated run weekday carries no plan row");
  assert.notEqual(sat.status, "upcoming", JSON.stringify(sat));
  assert.equal(sat.run?.status, "completed");
  assert.equal(sat.run?.completion_date, "2026-04-21");
});

// Regression: template mode (no stated lift schedule) crowned two cells "today" —
// the one whose own unfinished session was dated today, AND whichever day number
// the ring's forecast (todayDayNumber) separately pointed at. The log outranks the
// forecast everywhere else in this file; the "today" cell must be no exception.
test("template mode: at most one cell reads today when an unfinished session disagrees with the ring's forecast", () => {
  pushDay(1, "Push", "Push", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  pushDay(2, "Pull", "Pull", [{ exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8 }]);
  // A finished session on day 1 a few days ago sets the ring's phase forward —
  // its forecast for today lands on a different day number than what actually
  // got logged today.
  repo.logSetByName({ date: "2026-04-18", exercise: "Bench Press", weight: 135, reps: 5, day_number: 1 });
  const priorWeek = planWeek("2026-04-18");
  repo.finishSession(priorWeek.days.find((d) => d.plan_day?.day_number === 1).session.id, null);
  // Today the athlete freestyles day 1 again instead of following the ring; the
  // session is left unfinished (still training).
  repo.logSetByName({ date: REF, exercise: "Bench Press", weight: 140, reps: 5, day_number: 1 });

  const week = planWeek(REF);
  const todayCells = week.days.filter((d) => d.status === "today");
  assert.equal(todayCells.length, 1, JSON.stringify(week.days));
  assert.equal(
    todayCells[0].plan_day.day_number,
    1,
    "the cell tied to the actual logged session is the one that reads today"
  );
});
