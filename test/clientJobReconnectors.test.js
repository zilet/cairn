import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function namedFactory(name) {
  const fn = () => ({ name });
  fn.factoryName = name;
  return fn;
}

function loadJobReconnectors() {
  const registrations = [];
  const context = {
    Object,
    registrations,
    registerJobReconnector: (kind, factory) => registrations.push({ kind, factoryName: factory.factoryName }),
    reconnectSessionSuggest: namedFactory("reconnectSessionSuggest"),
    reconnectMealPlan: namedFactory("reconnectMealPlan"),
    reconnectMealSwap: namedFactory("reconnectMealSwap"),
    reconnectRecipe: namedFactory("reconnectRecipe"),
    reconnectDayReadOverride: namedFactory("reconnectDayReadOverride"),
    reconnectNutritionCheckin: namedFactory("reconnectNutritionCheckin"),
    reconnectInsight: namedFactory("reconnectInsight"),
    reconnectProposal: namedFactory("reconnectProposal"),
    reconnectHealthReview: namedFactory("reconnectHealthReview"),
    reconnectHealthDedupeCheck: namedFactory("reconnectHealthDedupeCheck"),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/app-job-reconnectors.js"), "utf8"), context);
  return context;
}

test("app job reconnector module registers every factory in boot order", () => {
  const context = loadJobReconnectors();
  assert.equal(typeof context.registerAppJobReconnectors, "function");
  assert.equal(context.window.registerAppJobReconnectors, context.registerAppJobReconnectors);
  assert.deepEqual(context.registrations, []);

  context.registerAppJobReconnectors();

  assert.deepEqual(context.registrations, [
    { kind: "session_suggest", factoryName: "reconnectSessionSuggest" },
    { kind: "meal_plan", factoryName: "reconnectMealPlan" },
    { kind: "meal_swap", factoryName: "reconnectMealSwap" },
    { kind: "recipe", factoryName: "reconnectRecipe" },
    { kind: "day_read_override", factoryName: "reconnectDayReadOverride" },
    { kind: "nutrition_checkin", factoryName: "reconnectNutritionCheckin" },
    { kind: "insight", factoryName: "reconnectInsight" },
    { kind: "proposal", factoryName: "reconnectProposal" },
    { kind: "health_review", factoryName: "reconnectHealthReview" },
    { kind: "health_dedupe_check", factoryName: "reconnectHealthDedupeCheck" },
  ]);
});

test("the registration pass reports only NEW factories, so a lazy bundle's re-run knows whether to sweep", () => {
  const context = loadJobReconnectors();
  const healthReview = context.reconnectHealthReview;
  const healthDedupe = context.reconnectHealthDedupeCheck;
  delete context.reconnectHealthReview; // lives in the lazy me-health bundle
  delete context.reconnectHealthDedupeCheck; // so does Records' duplicate check

  assert.equal(context.registerAppJobReconnectors(), 8, "boot registers every eager factory");
  assert.equal(context.registerAppJobReconnectors(), 0, "a re-run with nothing new adds nothing");

  context.reconnectHealthReview = healthReview; // the lazy bundle lands
  context.reconnectHealthDedupeCheck = healthDedupe;
  assert.equal(context.registerAppJobReconnectors(), 2, "the lazy bundle's factories are new");
  assert.equal(context.registerAppJobReconnectors(), 0);
});
