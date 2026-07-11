import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/client/coach-meals-screen.ts"), "utf8");

test("Plan Changes is history-first and keeps manual reviews secondary", () => {
  assert.match(source, /headerTitle\.textContent = "Changes"/);
  assert.match(source, /Program change history/);
  assert.match(source, /Meal-plan change history/);
  assert.match(source, /<details class="changes-manual"/);
  assert.match(source, /<summary class="lbl">Manual review<\/summary>/);
  assert.ok(source.indexOf("Program change history") < source.indexOf("Manual review"));
  assert.match(source, /state\.planSeg = "coach"/, "the internal review route remains stable");
});

test("meal-plan Hold and Undo use the durable decision rollback path", () => {
  assert.match(source, /\[data-meal-decision-hold\]/);
  assert.match(source, /\[data-meal-decision-undo\]/);
  assert.match(source, /\/brain\/decisions\/\$\{decisionId\}\/revert/);
  assert.match(source, /swrInvalidate\(MEALS_KEY\)/);
  assert.match(source, /await renderMeals\(\)/);
  assert.match(source, /Undo recorded — showing your current meals/);
  assert.doesNotMatch(source, /Put back the previous meal plan/);
});
