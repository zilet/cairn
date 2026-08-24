import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function testEsc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadMealPlan() {
  const context = {
    Array,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Set,
    String,
    art: (_kind, text) => `art:${text}`,
    artImg: (_kind, text, className) => `<span class="${testEsc(className)}">${testEsc(text)}</span>`,
    statusBadge: (status) => `<span class="status">${testEsc(status)}</span>`,
    verifiedBadgeHtml: (verified) =>
      verified ? `<span class="verified">${testEsc(JSON.stringify(verified))}</span>` : "",
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/meal-row-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/meal-plan-client.js"), "utf8"), context);
  return context.CairnMealPlan;
}

test("meal-plan helper derives meal slots conservatively", () => {
  const meals = loadMealPlan();

  assert.equal(meals.mealSlotFor("Post-workout breakfast bowl", 2), "breakfast");
  assert.equal(meals.mealSlotFor("Training plate", 0), "breakfast");
  assert.equal(meals.mealSlotFor("Training plate", 1), "lunch");
  assert.equal(meals.mealSlotFor("Training plate", 2), "dinner");
  assert.equal(meals.mealSlotFor("Training plate", 3), "snack");
});

test("meal-plan helper renders planner rows with stable selectors and escaped payloads", () => {
  const meals = loadMealPlan();
  const html = meals.mealRowHtml(
    {
      name: "Lunch <bowl>",
      items: ["rice", "fish <salmon>"],
      kcal: 520,
      protein_g: 42,
      carbs_g: 64,
      fat_g: 12,
    },
    0,
    { di: 2, count: 2 }
  );

  assert.match(html, /data-di="2" data-mi="0"/);
  assert.match(html, /data-mlog="/);
  assert.match(html, /\+ Log it/);
  assert.match(html, /data-mswap/);
  assert.match(html, /meal-swap" hidden data-di="2" data-mi="0"/);
  assert.match(html, /aria-label="Move up" disabled/);
  assert.match(html, /Lunch &lt;bowl&gt;/);
  assert.match(html, /fish &lt;salmon&gt;/);
  assert.doesNotMatch(html, /Lunch <bowl>|fish <salmon>/);
});

test("meal-plan helper renders history cards, actions, and folded settled plans", () => {
  const meals = loadMealPlan();
  const html = meals.mealPlanListHtml([
    {
      id: "draft<1>",
      status: "draft",
      agent: "chef<script>",
      parsed: {
        daily_kcal: 2400,
        daily_protein_g: 180,
        summary: "Build <lean>",
        days: [{ day: "Monday", meals: [{ name: "Breakfast", items: "eggs <toast>", kcal: 500, protein_g: 35 }] }],
        notes: "Prep <ahead>",
      },
    },
    {
      id: 2,
      status: "kept",
      agent: "stub",
      parsed: { daily_kcal: 2300, daily_protein_g: 170, days: [] },
    },
    {
      id: 3,
      status: "discarded",
      agent: "stub",
      raw_output: "<bad json>",
    },
  ]);

  assert.match(html, /data-accept="draft&lt;1&gt;"/);
  assert.match(html, /data-discard="draft&lt;1&gt;"/);
  assert.match(html, /class="pillbtn pill-accent" data-accept=/);
  assert.match(html, />Use this plan</);
  assert.match(html, /class="pillbtn" data-discard=/);
  assert.match(html, />Discard</);
  assert.doesNotMatch(html, /USE THIS PLAN|DISCARD|class="logbtn"/);
  assert.match(html, /chef&lt;script&gt;/);
  assert.match(html, /Build &lt;lean&gt;/);
  assert.match(html, /eggs &lt;toast&gt;/);
  assert.match(html, /Show earlier meal plans \(1\)/);
  assert.match(html, /Unparseable output/);
  assert.doesNotMatch(html, /chef<script>|Build <lean>|eggs <toast>|<bad json>/);
});

test("meal-plan helper renders planner days with totals and target bar", () => {
  const meals = loadMealPlan();
  const html = meals.mealDayHtml(
    {
      day: "Tuesday",
      note: "lift <later>",
      meals: [
        { name: "Breakfast", items: "oats", kcal: 500, protein_g: 40, carbs_g: 70, fat_g: 10 },
        { name: "Lunch", items: "chicken", kcal: 700, protein_g: 55, carbs_g: 80, fat_g: 15 },
      ],
    },
    1,
    { weekOf: "2026-06-30", targetKcal: 2400, todayName: "tue" }
  );

  assert.match(html, /mealday mealday-today/);
  assert.match(html, /data-mday="1"/);
  assert.match(html, /data-cu="1200"/);
  assert.match(html, /95g protein/);
  assert.match(html, /width:50%/);
  assert.match(html, /mealday-note/);
  assert.match(html, /lift &lt;later&gt;/);
  assert.match(html, /data-di="1" data-mi="0"/);
  assert.match(html, /data-di="1" data-mi="1"/);
});

test("meal-plan helper caps the target bar at 100% width but flags a meaningfully over-target day", () => {
  const meals = loadMealPlan();

  const onTarget = meals.mealDayHtml(
    { day: "Wednesday", meals: [{ name: "Lunch", items: "chicken", kcal: 2400, protein_g: 175 }] },
    2,
    { weekOf: "2026-06-30", targetKcal: 2400, todayName: "wed" }
  );
  assert.match(onTarget, /mealday-bar-fill barfill" style="width:100%"/);
  assert.doesNotMatch(onTarget, /over-target/);

  // 3200 of 2400 kcal = ~133% of target — well past the ~105% over-target line.
  const overTarget = meals.mealDayHtml(
    { day: "Thursday", meals: [{ name: "Dinner", items: "steak", kcal: 3200, protein_g: 220 }] },
    3,
    { weekOf: "2026-06-30", targetKcal: 2400, todayName: "thu" }
  );
  assert.match(overTarget, /mealday-bar-fill barfill over-target" style="width:100%"/);
  // The bar's fill can't exceed 100% of the track, but the real numbers still
  // show in the adjacent total, so the over-target amount isn't hidden.
  assert.match(overTarget, /data-cu="3200"/);
  assert.match(overTarget, /220g protein/);

  // Just past target but under the ~105% line — capped width, no over-target flag.
  const barelyOver = meals.mealDayHtml(
    { day: "Friday", meals: [{ name: "Lunch", items: "salad", kcal: 2472, protein_g: 175 }] },
    4,
    { weekOf: "2026-06-30", targetKcal: 2400, todayName: "fri" }
  );
  assert.match(barelyOver, /mealday-bar-fill barfill" style="width:100%"/);
  assert.doesNotMatch(barelyOver, /over-target/);
});

test("meal-plan helper renders planner preferences and empty state safely", () => {
  const meals = loadMealPlan();
  const prefsHtml = meals.mealPrefsHtml("Fasted <AM>", 1);
  const emptyHtml = meals.mealPlanEmptyHtml("fish & rice");

  assert.match(prefsHtml, /id="mealPrefs"/);
  assert.match(prefsHtml, /id="mealPrefsToggle" aria-expanded="false"/);
  assert.match(prefsHtml, /Fasted &lt;AM&gt;/);
  assert.match(prefsHtml, /data-pref="Fasted AM training"/);
  assert.doesNotMatch(prefsHtml, /Fasted <AM>/);
  assert.match(emptyHtml, /No meal plan yet/);
  assert.match(emptyHtml, /id="mealDraftBtn"/);
  assert.match(emptyHtml, /class="pillbtn pill-accent"/);
  assert.match(emptyHtml, /Ask team to plan this week/);
  assert.doesNotMatch(emptyHtml, /ASK TEAM TO PLAN THIS WEEK|logbtn meals-cta/);
  assert.match(emptyHtml, /fish &amp; rice/);
});

test("meal-plan helper selects and renders the current weekly planner shell", () => {
  const meals = loadMealPlan();
  const fullDays = Array.from({ length: 7 }, (_, index) => ({
    day: index === 0 ? "Tuesday" : `Day ${index + 1}`,
    meals: [{ name: index === 0 ? "Breakfast" : "Daily plate", items: "oats", kcal: 2400, protein_g: 180 }],
  }));
  const plans = [
    {
      id: 1,
      status: "draft",
      agent: "stub",
      parsed: { daily_kcal: 2200, days: [] },
    },
    {
      id: "kept<2>",
      status: "accepted",
      agent: "chef<script>",
      week_of: "2026-06-30",
      parsed: {
        daily_kcal: 2400,
        daily_protein_g: 180,
        summary: "steady <week>",
        days: fullDays,
        shopping: ["oats", "berries<script>"],
        notes: "Prep <ahead>",
      },
    },
  ];
  const current = meals.currentMealPlan(plans);
  const painted = meals.mealPlannerBodyHtml(current, "fasted <AM>", {
    checkedShopping: new Set([1]),
    now: { getDay: () => 2 },
  });

  assert.equal(current.id, "kept<2>");
  assert.equal(painted.context.weekOf, "2026-06-30");
  assert.equal(painted.context.targetKcal, 2400);
  assert.equal(painted.context.todayName, "tue");
  assert.match(painted.html, /mealhero/);
  assert.match(painted.html, /Week of 2026-06-30 · chef&lt;script&gt;/);
  assert.match(painted.html, /steady &lt;week&gt;/);
  assert.match(painted.html, /fasted &lt;AM&gt;/);
  assert.match(painted.html, /mealday mealday-today/);
  assert.match(painted.html, /shop-chip chip-done" data-shop="1"/);
  assert.match(painted.html, /berries&lt;script&gt;/);
  assert.match(painted.html, /Prep &lt;ahead&gt;/);
  assert.doesNotMatch(painted.html, /chef<script>|steady <week>|berries<script>|Prep <ahead>/);
});

test("meal-plan helper excludes unsafe legacy drafts from the current fallback", () => {
  const meals = loadMealPlan();
  const legacy = {
    id: 1,
    status: "draft",
    parsed: {
      daily_kcal: 2600,
      daily_protein_g: 170,
      days: [{ day: "Mon", meals: [{ name: "Legacy bowl", kcal: 650, protein_g: 45 }] }],
    },
  };
  assert.equal(meals.currentMealPlan([legacy]), null);

  const valid = {
    id: 2,
    status: "accepted",
    parsed: {
      daily_kcal: 2300,
      daily_protein_g: 175,
      days: Array.from({ length: 7 }, (_, index) => ({
        day: `Day ${index + 1}`,
        meals: [{ name: "Daily plate", kcal: 2300, protein_g: 175 }],
      })),
    },
  };
  assert.equal(meals.currentMealPlan([legacy, valid]).id, 2);
});

test("meal-plan helper explains a hard-constraint conflict and suppresses actionable meals", () => {
  const meals = loadMealPlan();
  const parsed = {
    daily_kcal: 2200,
    daily_protein_g: 170,
    notes: "Prep the chicken tonight",
    shopping: ["chicken", "rice"],
    constraint_state: {
      status: "refresh_needed",
      conflicts: [{ kind: "dietary", detail: "contains <chicken> under the saved vegan constraint" }],
    },
    days: Array.from({ length: 7 }, (_, index) => ({
      day: `Day ${index + 1}`,
      meals: [{ name: "Chicken bowl", kcal: 2200, protein_g: 170 }],
    })),
  };
  const plan = { id: 7, status: "accepted", parsed, constraint_state: parsed.constraint_state };
  const painted = meals.mealPlannerBodyHtml(plan, "", { now: { getDay: () => 1 } });

  assert.match(painted.html, /MEALS NEED A REFRESH/);
  assert.match(painted.html, /contains &lt;chicken&gt;/);
  assert.match(painted.html, /Ask the team to refresh meals/);
  assert.doesNotMatch(painted.html, /Chicken bowl|Prep the chicken tonight|data-shop/);

  const staleDraft = meals.mealPlanHeroHtml({ ...plan, id: "draft<7>", status: "draft" });
  assert.match(staleDraft, /REFRESH REQUIRED/);
  assert.match(staleDraft, /data-mdiscard="draft&lt;7&gt;"/);
  assert.doesNotMatch(staleDraft, /Use this plan|data-mkeep/);
});

test("meal-plan helper preserves draft actions in the planner shell", () => {
  const meals = loadMealPlan();
  const painted = meals.mealPlannerBodyHtml(
    {
      id: "draft<1>",
      status: "draft",
      agent: "chef",
      created_at: "2026-06-30T12:00:00Z",
      parsed: {
        daily_kcal: 2300,
        daily_protein_g: 170,
        days: [],
      },
    },
    "",
    { verified: { source: "test<ok>" }, now: { getDay: () => 1 } }
  );

  assert.match(painted.html, /data-mkeep="draft&lt;1&gt;"/);
  assert.match(painted.html, /data-mdiscard="draft&lt;1&gt;"/);
  assert.match(painted.html, /test&lt;ok&gt;/);
  assert.equal(painted.context.weekOf, "2026-06-30");
  assert.equal(painted.context.todayName, "mon");
});

test("meal-plan helper presents an autonomy-scheduled week as upcoming without Accept", () => {
  const meals = loadMealPlan();
  const upcoming = {
    id: 12,
    status: "draft",
    agent: "team",
    parsed: { summary: "Fuel the next block", daily_kcal: 2300, daily_protein_g: 175, days: [] },
    autonomy: {
      id: "decision<12>",
      status: "announced",
      effective_date: "2026-07-13",
      summary: "Meals realigned around the next training block.",
    },
  };
  const history = meals.mealPlanCardHtml(upcoming, 0);
  const painted = meals.mealPlannerBodyHtml(
    {
      id: 11,
      status: "accepted",
      agent: "team",
      parsed: { daily_kcal: 2400, daily_protein_g: 175, days: [] },
    },
    "",
    { upcoming }
  );

  assert.match(history, /automatic and reversible/);
  assert.match(history, />coming<\/span>/);
  assert.doesNotMatch(history, />draft<\/span>/);
  assert.doesNotMatch(history, /data-accept|data-discard/);
  assert.match(painted.html, /COMING NEXT/);
  assert.match(painted.html, /Monday, Jul 13<\/span> — your meals refresh automatically/);
  assert.match(painted.html, /2,300 kcal · 175 g protein/);
  assert.match(painted.html, /100 kcal less · protein stays at 175 g/);
  assert.match(painted.html, /<summary>Preview changes<\/summary>/);
  assert.match(painted.html, /Meals realigned around the next training block/);
  assert.match(painted.html, /data-meal-decision-hold="decision&lt;12&gt;"/);
  assert.doesNotMatch(painted.html, />Apply<|No Apply step/);
  assert.doesNotMatch(painted.html, /data-mkeep|data-mdiscard/);
});

test("meal-plan helper keeps review-required and applied states distinct", () => {
  const meals = loadMealPlan();
  const review = meals.mealPlanHeroHtml({
    id: "review<2>",
    status: "draft",
    agent: "team",
    parsed: { daily_kcal: 2200, daily_protein_g: 170, days: [] },
  });
  const applied = meals.mealPlanHeroHtml(
    {
      id: 13,
      status: "accepted",
      agent: "team",
      parsed: { daily_kcal: 2300, daily_protein_g: 175, days: [] },
      autonomy: {
        id: "decision<13>",
        status: "applied",
        effective_date: "2026-07-11",
        reversible: true,
        summary: "Meals now support the next training block.",
        rationale: "Training volume rose while protein remains anchored.",
      },
    },
    undefined,
    new Date(2026, 6, 12)
  );

  assert.match(review, /REVIEW · Week/);
  assert.match(review, /NEEDS YOUR DECISION/);
  assert.match(review, /Nothing changes until you choose/);
  assert.match(review, />review<\/span>/);
  assert.doesNotMatch(review, />draft<\/span>/);
  assert.match(review, /data-mkeep="review&lt;2&gt;"/);
  assert.doesNotMatch(review, /data-meal-decision-undo|CURRENT PLAN/);
  assert.match(applied, /CURRENT PLAN · Week/);
  assert.match(applied, /RECENTLY UPDATED/);
  assert.match(applied, /<summary>Why<\/summary>/);
  assert.match(applied, /Training volume rose while protein remains anchored/);
  assert.match(applied, /data-meal-decision-undo="decision&lt;13&gt;"/);
  assert.doesNotMatch(applied, /data-mkeep|NEEDS YOUR DECISION/);

  const noLongerRecent = meals.mealPlanHeroHtml(
    {
      id: 15,
      status: "accepted",
      parsed: { daily_kcal: 2300, days: [] },
      autonomy: { id: 15, status: "applied", effective_date: "2026-06-01", reversible: true },
    },
    undefined,
    new Date(2026, 6, 12)
  );
  assert.doesNotMatch(noLongerRecent, /RECENTLY UPDATED|data-meal-decision-undo/);

  const delayedButJustApplied = meals.mealPlanHeroHtml(
    {
      id: 16,
      status: "accepted",
      parsed: { daily_kcal: 2300, days: [] },
      autonomy: {
        id: 16,
        status: "applied",
        effective_date: "2026-06-01",
        applied_at: "2026-07-12T08:30:00Z",
        reversible: true,
        summary: "The delayed boundary change just landed.",
      },
    },
    undefined,
    new Date(2026, 6, 12, 12)
  );
  assert.match(delayedButJustApplied, /RECENTLY UPDATED/);
  assert.match(delayedButJustApplied, /The delayed boundary change just landed/);
  assert.match(delayedButJustApplied, /data-meal-decision-undo="16"/);

  const locked = meals.mealPlanHeroHtml({
    id: 14,
    status: "accepted",
    parsed: { daily_kcal: 2300, days: [] },
    autonomy: { id: 14, status: "applied", reversible: false, summary: "A protected update." },
  });
  assert.match(locked, /RECENTLY UPDATED/);
  assert.doesNotMatch(locked, /data-meal-decision-undo/);
});
