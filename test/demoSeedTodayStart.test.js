import assert from "node:assert/strict";
import test from "node:test";
import { db } from "../dist/db.js";
import { seedDemo } from "../dist/demoSeed.js";
import { calendarDayRead, selectedPlanDayForDate } from "../dist/repo/plan-selection.js";
import { getCachedDayRead } from "../dist/repo/day-read-cache.js";
import { localDateISO } from "../dist/repo/shared.js";
import { previewAdaptiveDailySessionUseCase } from "../dist/domain/training/adaptive-session-use-case.js";

// The demo seed writes a CURATED "train" Brief (pinned — nothing recomputes it) over a
// training log dated relative to today, and the lifting week is read off that log
// (strengthScheduleRead's observed 3-of-6-weeks pattern). If the log's weekdays ever
// leave today out, the calendar reads today as rest: no plan day, an empty preview, and
// Today shows a train Brief with nothing to start (the browser smoke's "Today opens the
// Session destination" step). The seed is relative to today, so this must hold on EVERY
// weekday — pinned here across one whole Monday..Sunday week.
const WEEK = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

for (const date of WEEK) {
  test(`the seeded demo Today offers a start that matches its train Brief — ${date}`, (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: new Date(`${date}T12:00:00`) });
    seedDemo();
    const today = localDateISO();
    assert.equal(today, date);

    assert.equal(calendarDayRead(today)?.kind, "lift", "today is one of the demo's lifting weekdays");

    const read = getCachedDayRead(today);
    assert.equal(read?.kind, "train");
    const pinned = read.signals?.plan_selection?.selected?.day_number;
    assert.ok(Number.isInteger(pinned), "the curated Brief carries the selection it was written for");

    const selected = selectedPlanDayForDate(today);
    assert.equal(selected?.day_number, pinned, "the session card and the Brief name the same plan day");
    const day = db.prepare(`SELECT name FROM plan_days WHERE id = ?`).get(selected.plan_day_id);
    assert.match(read.headline, new RegExp(day.name), "the headline names the day there is to start");
    assert.equal(day.name, "Pull", "the ring is phased so the hand-written Pull prose is the day's own");

    const items = db.prepare(`SELECT COUNT(*) AS c FROM plan_items WHERE plan_day_id = ?`).get(selected.plan_day_id);
    assert.ok(items.c > 0, "the selected plan day carries lifts");
    const loggedToday = db
      .prepare(`SELECT COUNT(*) AS c FROM logged_sets l JOIN sessions s ON s.id = l.session_id WHERE s.date = ?`)
      .get(today);
    assert.equal(loggedToday.c, 0, "nothing is logged today, so the Brief offers a Start, not a Continue");

    const preview = previewAdaptiveDailySessionUseCase({ date: today, constraints: {} });
    assert.ok(Number(preview?.item_count) > 0, "the session preview behind the Start has items");
  });
}
