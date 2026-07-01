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
    verifiedBadgeHtml: (verified) => verified ? `<span class="verified">${testEsc(JSON.stringify(verified))}</span>` : "",
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
  assert.match(emptyHtml, /fish &amp; rice/);
});

test("meal-plan helper selects and renders the current weekly planner shell", () => {
  const meals = loadMealPlan();
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
        days: [
          {
            day: "Tuesday",
            meals: [{ name: "Breakfast", items: "oats", kcal: 500, protein_g: 40 }],
          },
        ],
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
