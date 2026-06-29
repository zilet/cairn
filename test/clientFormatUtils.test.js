import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadFormatUtils() {
  const context = { String, Number, Math };
  vm.runInNewContext(readFileSync(join(root, "public/js/format-utils.js"), "utf8"), context);
  return context;
}

test("client format helpers keep training, endurance, and macro display stable", () => {
  const utils = loadFormatUtils();

  assert.equal(utils.fmtWeight(null), "BW");
  assert.equal(utils.fmtWeight(-35), "35 assist");
  assert.equal(utils.fmtWeight("185.0"), "185.0");

  assert.equal(utils.parseDur("1:30"), 90);
  assert.equal(utils.parseDur("2m"), 120);
  assert.equal(utils.parseDur("45s"), 45);
  assert.equal(utils.parseDur("garbage"), null);
  assert.equal(utils.fmtDur(90), "1:30");

  assert.equal(utils.fmtPaceKm(4.5), "4:30");
  assert.equal(utils.fmtPaceKm(4.999), "5:00");
  assert.equal(utils.fmtKm(10.04), "10");
  assert.equal(utils.fmtKm(10.06), "10.1");
  assert.equal(utils.fmtSpeedKmh(32.04), "32");
  assert.equal(utils.prDistLabel(21.0975), "Half");

  assert.equal(utils.foodNum("12.5"), 12.5);
  assert.equal(utils.foodNum(""), null);
  assert.equal(utils.formatFoodNum(12.04), "12");
  assert.equal(utils.formatFoodNum(12.06), "12.1");
});
