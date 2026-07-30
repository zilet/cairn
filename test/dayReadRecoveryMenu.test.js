// The guided recovery menu (Track D) as it actually reaches the wire: attached
// by attachDayReadContext alongside forward/arc, never persisted, present only
// on a rest/easy Brief. See src/repo/recovery-menu.ts for the unit-level
// coverage of the menu's own rules (determinism, guarding, grammar).
import assert from "node:assert/strict";
import test from "node:test";
import { readToday } from "../dist/domain/brain/day-read-use-case.js";
import { configureDayReadRefresh } from "../dist/dayread-refresh.js";
import { localDaysAgo, repo, resetTables } from "./_seed.js";

test("readToday carries a recovery menu on a naturally-easy day with no plan", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "training_symptom_events"
  );
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });

  const read = await readToday({ date });

  assert.equal(read.kind, "easy");
  assert.ok(read.recovery, "expected a recovery menu on an easy read");
  assert.ok(read.recovery.options.length >= 2 && read.recovery.options.length <= 3);
});

test("readToday carries no recovery menu on a train day", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "training_symptom_events"
  );
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  repo.savePlanDay(1, "Lower", "Lower body", [{ exercise: "Squat", sets: 3, rep_low: 5, rep_high: 8 }]);

  const read = await readToday({ date });

  assert.equal(read.kind, "train");
  assert.equal(read.recovery, undefined, "a train day must not carry a recovery menu key at all");
});

test("readToday's recovery menu steers around a flagged area end to end", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "training_symptom_events"
  );
  const date = localDaysAgo(0);
  configureDayReadRefresh({ today: () => date, setTimer: () => 0, clearTimer: () => {} });
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: date });

  const read = await readToday({ date });

  assert.equal(read.kind, "easy");
  assert.ok(read.recovery);
  assert.equal(read.recovery.options.length, 2);
  assert.ok(read.recovery.options.some((o) => /knee/i.test(o.detail)));
});

// The menu is an invitation to move NOW, grounded in today's live symptom and load
// state. On a routed past date it would invite a session that day is over for — and
// it would be grounded in today's symptoms rather than that day's. `attention`, the
// other derived-per-response key beside it, declines past dates for the same reason.
test("a routed past date carries no recovery menu", async () => {
  resetTables(
    "day_reads",
    "suggestions",
    "plan_days",
    "plan_items",
    "sessions",
    "logged_sets",
    "training_symptom_events"
  );
  const today = localDaysAgo(0);
  const past = localDaysAgo(4);
  configureDayReadRefresh({ today: () => today, setTimer: () => 0, clearTimer: () => {} });

  const read = await readToday({ date: past });

  assert.equal(read.kind, "easy", "the same read that carries a menu when it is today");
  assert.equal(read.recovery, undefined, "a finished day must not carry a recovery menu key at all");
});
