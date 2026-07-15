import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { publicTodayPlanDay } from "../dist/routes/today.js";

const REF = "2026-07-15";
const before = (days) => new Date(new Date(REF + "T00:00:00Z").getTime() - days * 864e5).toISOString().slice(0, 10);

beforeEach(() => {
  resetTables(
    "logged_sets",
    "session_skips",
    "sessions",
    "activities",
    "plan_items",
    "plan_days",
    "day_reads",
    "suggestions",
    "brain_decisions",
    "daily_metrics",
    "checkins",
    "profile"
  );
});

function seedAdaptiveSplit() {
  repo.setProfile({ primary_discipline: "strength" });
  repo.savePlanDay(1, "Pull", "Pull", [
    { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "Seated Cable Row", sets: 3, rep_low: 8, rep_high: 12 },
    { exercise: "EZ Bar Curl", sets: 3, rep_low: 10, rep_high: 15 },
  ]);
  repo.savePlanDay(2, "Push", "Push", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 10 },
    { exercise: "Triceps Pushdown", sets: 3, rep_low: 10, rep_high: 15 },
  ]);
  repo.savePlanDay(3, "Lower", "Lower", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }]);

  repo.logSetByName({
    exercise: "Back Squat",
    weight: 225,
    reps: 5,
    rir: 2,
    date: before(3),
    day_number: 3,
  });
  repo.addActivity({ type: "row", duration_min: 60, distance_km: 10, date: before(1) });
}

test("canonical Today plan day stays in parity with the Brief's adaptive selection", () => {
  seedAdaptiveSplit();

  const brief = repo.dayRead(REF, { has_data: false, recovery: {} });
  const selected = repo.selectedPlanDayForDate(REF);

  assert.equal(brief.signals.plan_selection.adapted, true);
  assert.equal(selected.day_number, brief.signals.plan_selection.selected.day_number);
  assert.equal(selected.focus, brief.focus);
  assert.equal(selected.source, "adaptive");
});

test("public Today plan-day DTO never exposes adaptive scores or internal load arrays", () => {
  seedAdaptiveSplit();
  const selected = publicTodayPlanDay(REF);
  assert.ok(selected);
  assert.deepEqual(Object.keys(selected).sort(), ["day_number", "focus", "reason", "source"]);
  assert.doesNotMatch(JSON.stringify(selected), /\b(?:score|scores|recent_load|plan_day_id|selection)\b/i);
});

test("canonical Today plan day reuses the persisted Brief selection and rejects deleted cached days", () => {
  seedAdaptiveSplit();
  const brief = repo.dayRead(REF, { has_data: false, recovery: {} });
  repo.saveDayRead(REF, { ...brief, headline: "Push.", source: "deterministic" });

  const cached = repo.selectedPlanDayForDate(REF);
  assert.equal(cached.day_number, brief.signals.plan_selection.selected.day_number);
  assert.equal(cached.source, "cached-day-read");

  db.prepare(`DELETE FROM plan_items WHERE plan_day_id = ?`).run(cached.plan_day_id);
  db.prepare(`DELETE FROM plan_days WHERE id = ?`).run(cached.plan_day_id);
  const afterDelete = repo.selectedPlanDayForDate(REF);
  assert.notEqual(afterDelete?.day_number, cached.day_number);
  assert.equal(afterDelete?.source, "adaptive");
});

test("implicit session creation binds the canonical Today day while a manual day stays authoritative", () => {
  seedAdaptiveSplit();
  const selected = repo.selectedPlanDayForDate(REF);

  repo.logSetByName(repo.resolveImplicitPlanDay({ exercise: "Bench Press", weight: 105, reps: 8, rir: 3, date: REF }));
  const implicit = repo.getSessionByDate(REF);
  assert.equal(implicit.plan_day_id, selected.plan_day_id);

  const manualDate = "2026-07-16";
  repo.logSetByName(
    repo.resolveImplicitPlanDay({
      exercise: "Lat Pulldown",
      weight: 100,
      reps: 10,
      rir: 2,
      date: manualDate,
      day_number: 1,
    })
  );
  const manualDayId = db.prepare(`SELECT id FROM plan_days WHERE day_number = 1`).get().id;
  assert.equal(repo.getSessionByDate(manualDate).plan_day_id, manualDayId);
  const existing = repo.selectedPlanDayForDate(manualDate);
  assert.equal(existing.day_number, 1);
  assert.equal(existing.source, "existing-session");
  assert.equal(repo.resolveImplicitPlanDay({ exercise: "Curls", day_number: null }).day_number, null);
});
