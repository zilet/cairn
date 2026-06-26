// iCal plan export (G1) — buildPlanICS turns the weekly training template into a
// subscribe-able VCALENDAR (pull-not-push). Deterministic via an injected `now`.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

beforeEach(() => {
  db.prepare("DELETE FROM plan_items").run();
  db.prepare("DELETE FROM plan_days").run();
  // Clear logged_sets + sessions BEFORE exercises — a prior test file may have left
  // logged sets that reference exercises, and DELETE FROM exercises would otherwise
  // fail the foreign key. Order matters (children first).
  db.prepare("DELETE FROM logged_sets").run();
  db.prepare("DELETE FROM sessions").run();
  // Exercises now self-dedup by normalized name (a comma/casing variant folds onto an
  // existing movement), so isolate them too — else one test's "Bench Press" would
  // absorb another's "Bench, Press" and defeat its fixture.
  db.prepare("DELETE FROM exercises").run();
});

// Parse the first DTSTART back to a JS weekday so assertions don't hardcode which
// calendar date is a Monday.
function dtstartWeekday(ics) {
  const m = /DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/.exec(ics);
  assert.ok(m, "has a DTSTART date");
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay();
}

test("emits a valid VCALENDAR with one weekly VEVENT per plan day", () => {
  repo.savePlanDay(1, "Day A", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 10 },
  ]);
  repo.savePlanDay(2, "Day B", "Pull", [{ exercise: "Deadlift", sets: 1, rep_low: 5, rep_high: 5 }]);

  const ics = repo.buildPlanICS({ now: new Date(2026, 5, 15, 9, 0, 0) });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.ok(ics.includes("\r\n"), "CRLF line endings");
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2, "two events");
  assert.equal((ics.match(/RRULE:FREQ=WEEKLY/g) || []).length, 2, "both recur weekly");
  assert.match(ics, /SUMMARY:Push/);
  assert.match(ics, /SUMMARY:Pull/);
  assert.match(ics, /Bench Press 3×5-8/, "description lists exercises with rep ranges");
  assert.match(ics, /UID:cairn-plan-day-1@cairn/, "stable per-day UID");
});

test("Day 1 maps to Monday by default; start_weekday shifts it", () => {
  repo.savePlanDay(1, "Day A", "Legs", [{ exercise: "Squat", sets: 5, rep_low: 5, rep_high: 5 }]);
  const def = repo.buildPlanICS({ now: new Date(2026, 5, 15, 9, 0, 0) });
  assert.equal(dtstartWeekday(def), 1, "default → Monday");
  const tue = repo.buildPlanICS({ now: new Date(2026, 5, 15, 9, 0, 0), startWeekday: 2 });
  assert.equal(dtstartWeekday(tue), 2, "start=2 → Tuesday");
});

test("escapes commas/semicolons in summary and description per RFC 5545", () => {
  repo.savePlanDay(1, "Day A", "Push, hard; intense", [{ exercise: "Bench, Press", sets: 3, rep_low: 5, rep_high: 5 }]);
  const ics = repo.buildPlanICS({ now: new Date(2026, 5, 15) });
  assert.match(ics, /SUMMARY:Push\\, hard\\; intense/);
  assert.match(ics, /Bench\\, Press/);
});

test("a timed exercise renders seconds, not load", () => {
  repo.savePlanDay(1, "Core", "Core", [{ exercise: "Plank", sets: 3, target_seconds: 60, mode: "timed" }]);
  const ics = repo.buildPlanICS({ now: new Date(2026, 5, 15) });
  assert.match(ics, /Plank 3×60s/);
});
