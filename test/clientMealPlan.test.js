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
    JSON,
    Math,
    Number,
    Object,
    String,
    art: (_kind, text) => `art:${text}`,
    artImg: (_kind, text, className) => `<span class="${testEsc(className)}">${testEsc(text)}</span>`,
    statusBadge: (status) => `<span class="status">${testEsc(status)}</span>`,
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
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
