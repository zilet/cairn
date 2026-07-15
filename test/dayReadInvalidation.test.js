// Repo-layer Brief invalidation (Wave B / B2). The cached day-read must be busted by
// EVERY surface that changes what today should be — not just the chat path. These pin
// that each repo mutation deletes today's cached read, so an applied restructure / a
// new injury / a session-feedback tap / a resolve never leaves a stale Brief behind.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, localDaysAgo } from "./_seed.js";

const TODAY = () => localDaysAgo(0);

beforeEach(() =>
  resetTables(
    "context_events", "sessions", "logged_sets", "exercises",
    "plan_items", "plan_days", "plan_proposals", "day_reads",
    "bodyweight_log", "profile",
  ),
);

// Seed a cached read for today, then run `mutate`, then assert the cache is gone.
function bustsCache(mutate) {
  repo.saveDayRead(TODAY(), { kind: "train", headline: "Old read", why: "stale" });
  assert.ok(repo.getCachedDayRead(TODAY()), "precondition: a read is cached");
  mutate();
  assert.equal(repo.getCachedDayRead(TODAY()), null, "the cached Brief was busted");
}

test("addContextEvent busts today's Brief", () => {
  bustsCache(() => repo.addContextEvent({ kind: "injury", title: "Tweaked knee" }));
});

test("updateContextEvent busts today's Brief", () => {
  const ev = repo.addContextEvent({ kind: "trip", title: "Boston" });
  bustsCache(() => repo.updateContextEvent(ev.id, { title: "Boston work trip" }));
});

test("resolveContextEvent busts today's Brief", () => {
  const ev = repo.addContextEvent({ kind: "injury", title: "Sore wrist" });
  bustsCache(() => repo.resolveContextEvent(ev.id));
});

test("setSessionFeedback busts today's Brief", () => {
  bustsCache(() => repo.setSessionFeedback(TODAY(), { soreness: 3 }));
});

test("logWeight busts today's Brief (A2 — the last unwired brain signal)", () => {
  bustsCache(() => repo.logWeight(181.4, TODAY()));
});

test("savePlanDay busts today's Brief", () => {
  bustsCache(() => repo.savePlanDay(1, "Lower", "legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8 }]));
});

test("replacePlan busts today's Brief", () => {
  bustsCache(() => repo.replacePlan([{ day_number: 1, name: "Full Body", items: [{ exercise: "Deadlift", sets: 3, rep_low: 5, rep_high: 5 }] }]));
});

test("applyProposal (target change) busts today's Brief", () => {
  // A plan day must exist for the change to land (and setup itself busts the cache).
  repo.savePlanDay(1, "Lower", "legs", [{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 }]);
  const p = repo.createProposal("stub", "bump squat", "", {
    summary: "progress the squat",
    changes: [{ day_number: 1, exercise: "Back Squat", target_weight: 195, reason: "earned it" }],
  });
  bustsCache(() => {
    const r = repo.applyProposal(p.id);
    assert.equal(r.ok, true, "the proposal applied");
  });
});

test("direct target updates and plan-day deletion cannot leave Today on a stale Brief", () => {
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  bustsCache(() => repo.updateTarget(1, "Bench Press", 140));

  repo.saveDayRead(TODAY(), { kind: "train", headline: "Old push", why: "stale", focus: "Push" });
  assert.ok(repo.getCachedDayRead(TODAY()));
  const deleted = repo.deletePlanDay(1);
  assert.equal(deleted.deleted, 1);
  assert.equal(repo.getCachedDayRead(TODAY()), null, "deleting the selected day clears its persisted text/selection");
});

test("a rolled-back multi-change proposal preserves the persisted Brief", () => {
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 75 },
  ]);
  repo.saveDayRead(TODAY(), {
    kind: "train",
    headline: "Stored push read",
    why: "this must survive a rejected transaction",
    focus: "Push",
    signals: { selected_plan_day: 1 },
  });
  const p = repo.createProposal("stub", "rollback", "", {
    changes: [
      { day_number: 1, exercise: "Bench Press", target_weight: 145 },
      { day_number: 1, exercise: "Overhead Press", target_seconds: 30 },
    ],
  });

  const result = repo.applyProposal(p.id);
  assert.equal(result.ok, false);
  assert.equal(repo.getPlanDay(1).items.find((item) => item.exercise === "Bench Press").target_weight, 135);
  assert.equal(repo.getCachedDayRead(TODAY()).headline, "Stored push read");
});
