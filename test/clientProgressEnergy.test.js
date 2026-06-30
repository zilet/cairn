import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnergy() {
  const context = { Math, Number, Object, String };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-energy-client.js"), "utf8"), context);
  return context.CairnProgressEnergy;
}

test("progress energy read stays quiet without enough data", () => {
  const energy = loadEnergy();
  const read = energy.energyRead({ confidence: "none" });

  assert.equal(read.tone, "quiet");
  assert.match(read.lead, /Not enough logged/);
  assert.match(read.body, /Keep logging meals/);
  assert.equal(energy.kcalFmt(2432.7), "2,433");
  assert.equal(energy.CONF_WORD.high, "well-established");
});

test("progress energy read summarizes intake and trend", () => {
  const energy = loadEnergy();

  const read = energy.energyRead({ tdee: 2800, confidence: "high", intake_avg_kcal: 2300, trend_lb_wk: -0.26 });
  assert.equal(read.lead, "Eating ~2,300 kcal/day, trending down about 0.3 lb/week.");
  assert.equal(read.body, "");
  assert.equal(read.tone, "read");
  assert.equal(read.dir, "down");
  assert.equal(energy.energyRead({ tdee: 2700, confidence: "medium", trend_lb_wk: 0.01 }).lead, "Holding steady.");
  assert.equal(energy.energyRead({ tdee: 2700, confidence: "medium", trend_lb_wk: 0.12 }).dir, "up");
});
