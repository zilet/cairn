// The composite Today side read (GET /today-side, src/routes/today-side.ts).
//
// Two things must hold for a fan-in endpoint that exists only to save round trips:
// every key has to say exactly what the individual route it replaces says (mealplans
// is the one deliberate exception — the slim listMealPlansSummary() projection), and
// one failing read has to cost that one key and nothing else.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { todaySideRead, TODAY_SIDE_READERS } from "../dist/routes/today-side.js";
import { listVisibleInsights, listDirectives, teamWeekRead } from "../dist/domain/brain/index.js";
import {
  annotateDirectiveFreshness,
  annotateDirectiveRecheck,
  getHealthSynthesisView,
  healthFocus,
  getRecoveryBaselineRead,
} from "../dist/domain/health/index.js";
import { listContextEvents } from "../dist/domain/person/index.js";
import { listGarminDailyMetrics } from "../dist/domain/training/index.js";
import { listMealPlans, listMealPlansSummary } from "../dist/domain/nutrition/index.js";
import { db, repo, resetTables, completeMealWeek } from "./_seed.js";

beforeEach(() => {
  resetTables("context_events", "meal_plans", "garmin_daily_metrics", "health_directives", "insights");
});

test("todaySideRead mirrors the individual routes key for key", () => {
  repo.addContextEvent({ kind: "travel", title: "Trip", start_date: "2026-01-01", end_date: "2026-01-09" });
  repo.upsertGarminDailyMetric({ date: "2026-01-02", steps: 8000, resting_hr: 52 });
  db.prepare(`INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json, status) VALUES (?, ?, ?, ?, ?)`).run(
    "2026-01-02",
    "stub",
    "{}",
    JSON.stringify(completeMealWeek({})),
    "accepted"
  );

  // listMealPlans back-stamps constraint provenance onto a legacy unstamped row the
  // first time it reads it, so settle that write before comparing two reads.
  listMealPlans(6);

  const side = todaySideRead("2026-01-02");

  assert.equal(side.date, "2026-01-02");
  assert.deepEqual(side.context_events, listContextEvents({ activeOnly: true }));
  assert.deepEqual(side.garmin_daily, listGarminDailyMetrics(1));
  assert.deepEqual(side.recovery_baseline, getRecoveryBaselineRead());
  // mealplans is the one other deliberate difference: the composite reads the slim
  // listMealPlansSummary() projection, not the full listMealPlans() payload — see
  // src/routes/today-side.ts.
  assert.deepEqual(side.mealplans, listMealPlansSummary(6));
  assert.deepEqual(side.insights, listVisibleInsights(20));
  assert.deepEqual(side.directives, {
    directives: annotateDirectiveRecheck(annotateDirectiveFreshness(listDirectives({ all: false }))),
  });
  const view = getHealthSynthesisView();
  assert.deepEqual(side.health_synthesis, {
    synthesis: view.synthesis,
    focus: healthFocus(),
    stale: view.stale,
    stale_reason: view.stale_reason,
  });
  // The one deliberate difference: the composite is a prefetch, so it reads the
  // team's week WITHOUT draining the unseen-insight backlog. GET /team-week is the
  // human-facing surface and stays the only place that drain fires.
  assert.deepEqual(side.team_week, teamWeekRead({ drainBacklog: false }));
});

test("todaySideRead falls back to a bad date the same way the individual routes do", () => {
  const side = todaySideRead("not-a-date");
  assert.match(side.date, /^\d{4}-\d{2}-\d{2}$/);
});

test("a reader that throws nulls its own key and leaves every other key intact", () => {
  const readers = {
    ...TODAY_SIDE_READERS,
    health_synthesis: () => {
      throw new Error("boom");
    },
  };
  const side = todaySideRead("2026-01-02", readers);

  assert.equal(side.health_synthesis, null, "the failing read is null, not an exception");
  for (const key of Object.keys(TODAY_SIDE_READERS)) {
    if (key === "health_synthesis") continue;
    assert.notEqual(side[key], undefined, `${key} still answered`);
  }
  assert.deepEqual(side.context_events, listContextEvents({ activeOnly: true }));
});

test("every response key is backed by a reader (no silently missing panel)", () => {
  const side = todaySideRead("2026-01-02");
  const keys = Object.keys(side).filter((key) => key !== "date");
  assert.deepEqual(keys.sort(), Object.keys(TODAY_SIDE_READERS).sort());
});
