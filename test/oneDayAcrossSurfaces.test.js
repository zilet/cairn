// oneDayAcrossSurfaces.test.js — TODAY's lift is one answer on every surface, end to end,
// on the live-shaped week (offline, synthetic): lifts Monday–Friday, runs Tuesday / Thursday
// / Sunday, a recurring Saturday ride, a seven-day streak, this morning's run in, the lift
// still open, and a dated push stance in force.
//
// For three different weekdays playing "today" (the week laid relative to the real clock),
//   planWeek(today)'s today cell  ==  todayStrengthLine(today)
//   ==  dayDetail(today).lift     ==  the Brief (attachDayReadContext over the day read)
//   ==  the coach context's day read.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables } from "./_seed.js";
import { addDaysISO } from "../dist/lib/dates.js";
import { todayStrengthLine } from "../dist/repo/today-strength-line.js";
import { planWeek } from "../dist/domain/training/plan-week.js";
import { dayDetail } from "../dist/domain/training/day-detail.js";
import { attachDayReadContext } from "../dist/domain/brain/day-read-use-case.js";
import { setTrainingDrive } from "../dist/domain/training/training-drive.js";
import { trainingDriveState } from "../dist/repo/training-drive.js";
import { getCoachContext } from "../dist/repo/coach.js";
import { WORLD, REF, ROLE, layOwnWeek } from "./_ownWeekFixture.js";

beforeEach(() => resetTables(...WORLD));

for (const [name, role] of [
  ["Tuesday (the stated easy-run day)", ROLE.tue],
  ["Wednesday (a run the week did not plan — the log is truth)", ROLE.wed],
  ["Thursday (the stated quality day)", ROLE.thu],
]) {
  test(`one lift for today on every surface — today plays ${name}`, () => {
    layOwnWeek({ role });
    const stance = setTrainingDrive({ drive: "push", until: addDaysISO(REF, 10), words: "push me" });
    assert.equal(stance.ok, true, stance.error);
    assert.equal(trainingDriveState(REF).drive, "push", "the precondition: the push stance is in force");

    // The ONE line.
    const line = todayStrengthLine(REF);
    assert.equal(line.role, "strength", JSON.stringify(line));
    assert.equal(line.state, "not_started");
    assert.ok(line.run_in, "the run is in");
    assert.ok(line.day_number != null && line.title, "a plan day is named");
    assert.match(line.text, new RegExp(`^Run in · ${line.title} still open`));

    // The Brief.
    const read = repo.dayRead(REF);
    assert.ok(read.signals.consecutive_training_days >= 5, `the streak (${read.signals.consecutive_training_days})`);
    assert.ok(read.signals.lift_day_open_after, "the read knows the run left the lift open");
    const brief = attachDayReadContext(REF, { ...read });
    assert.equal(brief.strength_line?.day_number, line.day_number, "Brief strength line");
    assert.equal(brief.strength_line?.text, line.text);
    const briefPick = read.signals.plan_selection?.selected?.day_number;
    assert.equal(briefPick, line.day_number, `the Brief's plan pick (${read.kind}, ${read.decision.rule_code})`);
    if (read.kind === "train") assert.equal(read.focus, line.focus, "the train read's focus is the plan day's own");

    // The plan week's today cell.
    const week = planWeek(REF);
    const cell = week.days.find((d) => d.date === REF);
    assert.equal(cell?.status, "today");
    assert.equal(cell.plan_day?.day_number, line.day_number, "the week strip's today cell");
    assert.equal(cell.plan_day?.name, line.title);
    assert.equal(week.strength_line?.day_number, line.day_number);

    // The day detail.
    const detail = dayDetail(REF, { today: REF });
    assert.equal(detail?.lift?.day_number, line.day_number, "the day detail's lift");
    assert.equal(detail.lift.title, line.title);
    assert.equal(detail.lift.today_line, line.text, "the day detail prints the line verbatim");

    // The coach context.
    const ctx = getCoachContext();
    assert.equal(
      ctx.day_read?.signals?.plan_selection?.selected?.day_number,
      line.day_number,
      "the coach context reads the same plan day"
    );
    assert.equal(ctx.day_read?.kind, read.kind, "and the same kind of day");
  });
}
