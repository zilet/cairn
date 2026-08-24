import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadMealFuelContext(apiImpl) {
  const calls = [];
  const context = {
    Number,
    String,
    Math,
    Promise,
    api: (path, opts) => {
      calls.push({ path, opts });
      return apiImpl(path, opts);
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/meal-fuel-context-client.js"), "utf8"), context);
  return { ctx: context.CairnMealFuelContext, calls };
}

test("remainingFuelKcal reads /nutrition/day's remaining.kcal when known", async () => {
  const { ctx, calls } = loadMealFuelContext(async () => ({
    known: { kcal: true },
    remaining: { kcal: 612.4 },
  }));

  const remaining = await ctx.remainingFuelKcal();
  assert.equal(remaining, 612);
  assert.equal(calls[0].path, "/nutrition/day");
});

test("remainingFuelKcal renders nothing for an absent/incomplete day — never 'behind'", async () => {
  const { ctx } = loadMealFuelContext(async () => ({ known: { kcal: false }, remaining: null }));
  assert.equal(await ctx.remainingFuelKcal(), null);

  const { ctx: ctx2 } = loadMealFuelContext(async () => ({ known: { kcal: true }, remaining: null }));
  assert.equal(await ctx2.remainingFuelKcal(), null);

  const { ctx: ctx3 } = loadMealFuelContext(async () => {
    throw new Error("offline");
  });
  assert.equal(await ctx3.remainingFuelKcal(), null);
});

test("remainingFuelKcal caches within its short TTL — a second call in the same tick skips the fetch", async () => {
  const { ctx, calls } = loadMealFuelContext(async () => ({ known: { kcal: true }, remaining: { kcal: 300 } }));
  await ctx.remainingFuelKcal();
  await ctx.remainingFuelKcal();
  assert.equal(calls.length, 1);
});

test("mealFuelFitLine renders nothing when remaining is unknown", () => {
  const { ctx } = loadMealFuelContext(async () => ({}));
  assert.equal(ctx.mealFuelFitLine(500, null), "");
});

test("mealFuelFitLine is a plain context line with no candidate kcal (the swap panel's case)", () => {
  const { ctx } = loadMealFuelContext(async () => ({}));
  assert.equal(ctx.mealFuelFitLine(undefined, 400), "today's remaining ~400 kcal");
  assert.equal(ctx.mealFuelFitLine(0, 400), "today's remaining ~400 kcal");
});

test("mealFuelFitLine names fit vs over-budget once a candidate kcal is known", () => {
  const { ctx } = loadMealFuelContext(async () => ({}));
  assert.equal(ctx.mealFuelFitLine(350, 400), "fits today's remaining ~400 kcal");
  assert.equal(ctx.mealFuelFitLine(400, 400), "fits today's remaining ~400 kcal");
  assert.equal(ctx.mealFuelFitLine(450, 400), "runs past today's remaining ~400 kcal");
});

test("loadMealFuelLine fills a [data-fuel-line] slot and hides it when there is nothing to say", async () => {
  const { ctx } = loadMealFuelContext(async () => ({ known: { kcal: true }, remaining: { kcal: 300 } }));
  let hidden = true;
  let text = "";
  const slot = {
    isConnected: true,
    set hidden(v) { hidden = v; },
    get hidden() { return hidden; },
    set textContent(v) { text = v; },
    get textContent() { return text; },
  };
  const scope = { querySelector: (sel) => (sel === "[data-fuel-line]" ? slot : null) };

  await ctx.loadMealFuelLine(scope, 250);
  assert.equal(hidden, false);
  assert.equal(text, "fits today's remaining ~300 kcal");
});

test("loadMealFuelLine no-ops when the slot has left the document (a stale async resolve)", async () => {
  const { ctx } = loadMealFuelContext(async () => ({ known: { kcal: true }, remaining: { kcal: 300 } }));
  const slot = { isConnected: false, hidden: true, textContent: "" };
  const scope = { querySelector: () => slot };

  await ctx.loadMealFuelLine(scope, 250);
  assert.equal(slot.hidden, true);
  assert.equal(slot.textContent, "");
});
