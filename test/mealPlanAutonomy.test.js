import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDueAnnouncedDecisions,
  applyMealPlanWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import * as repo from "../dist/repo.js";
import { db } from "./_seed.js";

function week(summary, kcal = 2200) {
  return {
    summary,
    daily_kcal: kcal,
    daily_protein_g: 175,
    days: Array.from({ length: 7 }, (_, index) => ({
      day: `Day ${index + 1}`,
      meals: [
        { name: `${summary} breakfast`, items: "eggs and oats", kcal: 800, protein_g: 70, carbs_g: 65, fat_g: 18 },
        {
          name: `${summary} dinner`,
          items: "salmon and potatoes",
          kcal: kcal - 800,
          protein_g: 105,
          carbs_g: 80,
          fat_g: 24,
        },
      ],
    })),
  };
}

test("lead mode announces a meal plan, keeps today's plan, lands tomorrow, and undoes exactly", () => {
  repo.setSettings({ lead_mode: "lead" });
  const current = repo.createMealPlan("stub", "", week("Current", 2250));
  repo.acceptMealPlan(current.id);
  const next = repo.createMealPlan("stub", "", week("Next", 2300));

  const scheduled = applyMealPlanWithAutonomy(next.id);
  assert.equal(scheduled.ok, true);
  assert.equal(scheduled.announced, true);
  assert.equal(scheduled.tier, "announce");
  assert.equal(repo.currentMealPlan().id, current.id, "an upcoming plan does not replace today's meals");
  assert.equal(repo.getMealPlan(next.id).autonomy.status, "announced");

  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, [scheduled.decision.id]);
  assert.equal(repo.currentMealPlan().id, next.id);
  assert.equal(repo.currentMealPlan().autonomy.status, "applied");
  assert.equal(repo.currentMealPlan().autonomy.reversible, true);
  assert.match(repo.currentMealPlan().autonomy.rationale, /Refreshed against/);
  assert.ok(repo.currentMealPlan().autonomy.applied_at);
  assert.equal(repo.getMealPlan(current.id).status, "superseded");
  assert.equal(repo.getBrainDecision(scheduled.decision.id).context.rollback_available, true);
  assert.equal(repo.getBrainRollback(scheduled.decision.id).kind, "meal_plan");

  const undone = revertDecision(scheduled.decision.id, "keep the prior week");
  assert.equal(undone.ok, true);
  assert.equal(repo.currentMealPlan().id, current.id);
  assert.equal(repo.getMealPlan(next.id).status, "superseded");
  assert.equal(repo.getBrainDecision(scheduled.decision.id).status, "reverted");
});

// The athlete has opened the app since the queued draft appeared, so that draft is a
// week they may remember being offered — retiring it has to leave a receipt.
function markQueuedDraftsSeen() {
  repo.setAppState(
    repo.TODAY_LAST_SEEN_KEY,
    new Date(Date.now() + 60_000).toISOString().slice(0, 19).replace("T", " ")
  );
}

test("a fresher queued meal week supersedes a SEEN older queue and Hold prevents landing", () => {
  repo.setSettings({ lead_mode: "lead" });
  const first = repo.createMealPlan("stub", "", week("First"));
  const firstScheduled = applyMealPlanWithAutonomy(first.id, { coordinated_update: true });
  markQueuedDraftsSeen();
  const second = repo.createMealPlan("stub", "", week("Second"));
  const secondScheduled = applyMealPlanWithAutonomy(second.id, { coordinated_update: true });

  assert.equal(repo.getMealPlan(first.id).status, "superseded");
  assert.equal(repo.getBrainDecision(firstScheduled.decision.id).status, "superseded");
  assert.notEqual(secondScheduled.decision.id, firstScheduled.decision.id, "a seen week is retired, not rewritten");
  assert.equal(repo.getMealPlan(second.id).autonomy.status, "announced");

  const held = revertDecision(secondScheduled.decision.id, "travel changed");
  assert.equal(held.ok, true);
  assert.equal(repo.getMealPlan(second.id).status, "superseded");
  assert.equal(repo.getBrainDecision(secondScheduled.decision.id).status, "canceled");
  assert.deepEqual(applyDueAnnouncedDecisions(secondScheduled.effective_date).applied, []);
});

// ---- the standing refresh lands instead of waiting for a ritual --------------
//
// Live, the weekly refresh drafted a week faster than the accept ritual ever ran.
// A refresh whose diff against the plan in force is bounded — same targets, same
// shape of week, different food in the slots — is the plan staying FRESH, so it is
// a quiet_apply-class decision that lands at tomorrow's food boundary with the
// one-tap undo. A refresh that moves the targets is a change, and announces.

// The same week, rotated: identical daily totals and identical structure.
function rotated(summary, kcal = 2200) {
  const plan = week(summary, kcal);
  plan.days = plan.days.map((day) => ({
    ...day,
    meals: day.meals.map((meal) => ({
      ...meal,
      name: `${meal.name} (rotated)`,
      items: "different food, same numbers",
    })),
  }));
  return plan;
}

test("the refresh classifier is conservative about what it cannot compare", () => {
  assert.equal(repo.mealPlanRefreshShape(week("Next", 2200), null).bounded, false, "a first plan is structural");
  assert.equal(repo.mealPlanRefreshShape(week("Next", 2200), week("Current", 2200)).bounded, true);
  // Per-meal rounding moves a weekly total by a few kcal; that is the same target.
  assert.equal(repo.mealPlanRefreshShape(week("Next", 2220), week("Current", 2200)).bounded, true);
  assert.equal(repo.mealPlanRefreshShape(week("Next", 2400), week("Current", 2200)).bounded, false);
});

// A week labelled by weekday and carrying the server's per-day split
// (meal-plan-day-energy.ts): `shifts` maps a weekday label to that day's move off the
// weekly average, laid onto the seven food days from `from`.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function splitWeek(summary, kcal, shifts, from = "2026-11-30") {
  const plan = week(summary, kcal);
  // Each moved day's meals are sized to its own number, as the server holds them to it.
  plan.days = plan.days.map((day, index) => {
    const shift = shifts[WEEKDAYS[index]] ?? 0;
    const meals = day.meals.map((meal, i) =>
      i === day.meals.length - 1 ? { ...meal, kcal: meal.kcal + shift } : meal
    );
    return { ...day, day: WEEKDAYS[index], meals };
  });
  const moved = Object.entries(shifts).map(([label, shift]) => {
    const offset = WEEKDAYS.indexOf(label); // `from` is a Monday
    const date = new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    return { date, kcal: kcal + shift, why: shift > 0 ? "the long run" : "a lighter day" };
  });
  if (moved.length) plan.day_energy = { version: 1, average_kcal: kcal, floor_kcal: 1500, from, days: moved };
  return plan;
}

test("a new per-day split under the same weekly target is a change, not a rotation", () => {
  const current = splitWeek("Current", 2200, { Sat: 300, Mon: -150, Tue: -150 });
  // Next week's plan, the same split on the same weekdays: still a rotation.
  const same = splitWeek("Next", 2200, { Sat: 300, Mon: -150, Tue: -150 }, "2026-12-07");
  assert.deepEqual(repo.mealPlanRefreshShape(same, current), { bounded: true, reasons: [] });

  // The long run moved to Sunday: the headline is unchanged, two days now eat differently.
  const moved = splitWeek("Next", 2200, { Sun: 300, Mon: -150, Tue: -150 }, "2026-12-07");
  const shape = repo.mealPlanRefreshShape(moved, current);
  assert.equal(shape.bounded, false);
  assert.deepEqual(shape.reasons, ["a day's own calorie number moved"]);

  // A flat week replaced by a split one (and back) is news too.
  assert.equal(repo.mealPlanRefreshShape(same, week("Current", 2200)).bounded, false, "flat to split");
  assert.equal(repo.mealPlanRefreshShape(week("Next", 2200), current).bounded, false, "split to flat");
});

test("a day's number within 50 kcal of last week's same day is rounding, not news", () => {
  const current = splitWeek("Current", 2200, { Sat: 300, Mon: -150, Tue: -150 });
  const noise = splitWeek("Next", 2200, { Sat: 340, Mon: -170, Tue: -170 }, "2026-12-07");
  assert.equal(repo.mealPlanRefreshShape(noise, current).bounded, true, "40 and 20 kcal apart");
  const exactlyFifty = splitWeek("Next", 2200, { Sat: 350, Mon: -175, Tue: -175 }, "2026-12-07");
  assert.equal(repo.mealPlanRefreshShape(exactlyFifty, current).bounded, true, "50 kcal is still the same day");
  const past = splitWeek("Next", 2200, { Sat: 360, Mon: -180, Tue: -180 }, "2026-12-07");
  assert.equal(repo.mealPlanRefreshShape(past, current).bounded, false, "60 kcal is a different day");
  // Days listed in another order are still compared Monday to Monday.
  const reordered = splitWeek("Next", 2200, { Sat: 300, Mon: -150, Tue: -150 }, "2026-12-07");
  reordered.days = [...reordered.days.slice(3), ...reordered.days.slice(0, 3)];
  assert.equal(repo.mealPlanRefreshShape(reordered, current).bounded, true);
});

test("a refresh that moves the day split announces under lead, with its reason recorded", () => {
  repo.setSettings({ lead_mode: "lead" });
  const current = repo.createMealPlan("stub", "", splitWeek("Current", 2200, { Sat: 300, Mon: -150, Tue: -150 }));
  repo.acceptMealPlan(current.id);
  const next = repo.createMealPlan(
    "stub",
    "",
    splitWeek("Next", 2200, { Sun: 300, Mon: -150, Tue: -150 }, "2026-12-07")
  );

  const scheduled = applyMealPlanWithAutonomy(next.id);
  assert.equal(scheduled.tier, "announce");
  const context = repo.getBrainDecision(scheduled.decision.id).context;
  assert.equal(context.refresh_bounded, false);
  assert.ok(
    context.refresh_reasons.includes("a day's own calorie number moved"),
    JSON.stringify(context.refresh_reasons)
  );
});

test("a bounded weekly refresh quiet-applies under lead, and Undo restores the prior week", () => {
  repo.setSettings({ lead_mode: "lead" });
  const current = repo.createMealPlan("stub", "", week("Current", 2200));
  repo.acceptMealPlan(current.id);
  const next = repo.createMealPlan("stub", "", rotated("Next", 2200));

  const scheduled = applyMealPlanWithAutonomy(next.id);
  assert.equal(scheduled.tier, "quiet_apply");
  assert.equal(scheduled.pending, true);
  assert.equal(scheduled.announced, undefined, "a rotation is not announced as a change");
  assert.equal(repo.getBrainDecision(scheduled.decision.id).context.refresh_bounded, true);
  assert.equal(repo.currentMealPlan().id, current.id, "and it still does not touch the food day under way");

  assert.deepEqual(applyDueAnnouncedDecisions(scheduled.effective_date).applied, [scheduled.decision.id]);
  assert.equal(repo.currentMealPlan().id, next.id, "the plan simply stayed fresh");
  assert.equal(repo.currentMealPlan().autonomy.reversible, true);

  const undone = revertDecision(scheduled.decision.id, "keep last week");
  assert.equal(undone.ok, true);
  assert.equal(repo.currentMealPlan().id, current.id);
});

test("a refresh that moves the targets is a change, and still announces", () => {
  repo.setSettings({ lead_mode: "lead" });
  const current = repo.createMealPlan("stub", "", week("Current", 2200));
  repo.acceptMealPlan(current.id);
  const next = repo.createMealPlan("stub", "", week("Next", 2600));

  const scheduled = applyMealPlanWithAutonomy(next.id);
  assert.equal(scheduled.tier, "announce");
  assert.equal(scheduled.announced, true);
  const context = repo.getBrainDecision(scheduled.decision.id).context;
  assert.equal(context.refresh_bounded, false);
  assert.ok(
    context.refresh_reasons.includes("the daily calorie target moved"),
    `the structural reason is recorded; got ${JSON.stringify(context.refresh_reasons)}`
  );
});

test("a week with a different shape of eating day is structural too", () => {
  repo.setSettings({ lead_mode: "lead" });
  const current = repo.createMealPlan("stub", "", week("Current", 2200));
  repo.acceptMealPlan(current.id);
  const restructured = week("Next", 2200);
  restructured.days = restructured.days.map((day) => ({
    ...day,
    meals: [
      { name: "One big meal", items: "everything at once", kcal: 2_200, protein_g: 175, carbs_g: 145, fat_g: 42 },
    ],
  }));
  const next = repo.createMealPlan("stub", "", restructured);

  const scheduled = applyMealPlanWithAutonomy(next.id);
  assert.equal(scheduled.tier, "announce");
  assert.equal(repo.getBrainDecision(scheduled.decision.id).context.refresh_bounded, false);
});

test("review_everything still asks, however bounded the refresh is", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  const current = repo.createMealPlan("stub", "", week("Current", 2200));
  repo.acceptMealPlan(current.id);
  const next = repo.createMealPlan("stub", "", rotated("Next", 2200));

  const scheduled = applyMealPlanWithAutonomy(next.id);
  assert.equal(scheduled.tier, "ask");
  assert.equal(scheduled.applied, false);
  assert.equal(repo.getMealPlan(next.id).status, "draft");
});

test("announce_first hears about a bounded refresh rather than having it land quietly", () => {
  repo.setSettings({ lead_mode: "announce_first" });
  const current = repo.createMealPlan("stub", "", week("Current", 2200));
  repo.acceptMealPlan(current.id);
  const next = repo.createMealPlan("stub", "", rotated("Next", 2200));

  assert.equal(applyMealPlanWithAutonomy(next.id).tier, "announce");
});

test("a refresh REPLACES a draft nobody has seen instead of stacking history", () => {
  repo.setSettings({ lead_mode: "lead" });
  const current = repo.createMealPlan("stub", "", week("Current", 2200));
  repo.acceptMealPlan(current.id);
  const first = repo.createMealPlan("stub", "", rotated("First", 2200));
  const firstScheduled = applyMealPlanWithAutonomy(first.id);
  // No app open between the two refreshes: the first week was never in front of anyone.
  const second = repo.createMealPlan("stub", "", rotated("Second", 2200));
  const secondScheduled = applyMealPlanWithAutonomy(second.id);

  assert.equal(secondScheduled.decision.id, firstScheduled.decision.id, "the standing entry was re-pointed");
  assert.equal(repo.getMealPlan(first.id).status, "superseded");
  assert.equal(repo.getMealPlan(second.id).autonomy.id, firstScheduled.decision.id);
  assert.equal(
    repo.listBrainDecisions({ kind: "meal_plan", limit: 50 }).filter((d) => d.status === "superseded").length,
    0,
    "no retired ledger row is left behind for a week nobody saw"
  );
  assert.equal(
    repo.getBrainDecision(secondScheduled.decision.id).context.replaced_unseen_draft_decision_id,
    firstScheduled.decision.id
  );

  // And the replacement is still a live decision that lands at the boundary.
  assert.deepEqual(applyDueAnnouncedDecisions(secondScheduled.effective_date).applied, [secondScheduled.decision.id]);
  assert.equal(repo.currentMealPlan().id, second.id);
});

test("review-everything keeps a meal plan as a plain draft", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  const plan = repo.createMealPlan("stub", "", week("Review"));
  const result = applyMealPlanWithAutonomy(plan.id);

  assert.equal(result.ok, true);
  assert.equal(result.applied, false);
  assert.equal(result.tier, "ask");
  assert.equal(repo.getMealPlan(plan.id).status, "draft");
  assert.equal(repo.getMealPlan(plan.id).autonomy, null);
});

test("autonomy refuses a legacy unsafe complete week before announcing it", () => {
  repo.setSettings({ lead_mode: "lead" });
  const unsafe = week("Unsafe", 2300);
  unsafe.days = unsafe.days.map((day) => ({
    ...day,
    meals: [{ name: "Tiny dinner", kcal: 900, protein_g: 60 }],
  }));
  const inserted = db
    .prepare(`INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json) VALUES (date('now'), 'legacy', '', ?) `)
    .run(JSON.stringify(unsafe));

  const result = applyMealPlanWithAutonomy(Number(inserted.lastInsertRowid));
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.match(result.error, /Day 1 totals 900 kcal and 60 g protein/);
  assert.equal(repo.getMealPlan(Number(inserted.lastInsertRowid)).autonomy, null, "no announcement was recorded");
});

test("bounded meal-plan history always carries the canonical current plan", () => {
  const current = repo.createMealPlan("stub", "", week("Current"));
  repo.acceptMealPlan(current.id);
  for (let index = 0; index < 5; index += 1) {
    const history = repo.createMealPlan("stub", "", week(`History ${index}`));
    repo.setMealPlanStatus(history.id, "superseded", { recordDecision: false });
  }

  const bounded = repo.listMealPlans(3);
  assert.equal(bounded.length, 4, "the requested history stays bounded plus one canonical current row");
  assert.ok(bounded.some((plan) => plan.id === current.id));
  assert.equal(repo.currentMealPlan().id, current.id);
});
