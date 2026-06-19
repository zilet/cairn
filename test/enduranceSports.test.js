import { test } from "node:test";
import assert from "node:assert/strict";
import { activitySportWhere, enduranceSportPatterns } from "../dist/repo/endurance-sports.js";

test("endurance sport patterns default to running and classify common disciplines", () => {
  assert.deepEqual(enduranceSportPatterns(), ["run", "running", "jog", "jogging"]);
  assert.deepEqual(enduranceSportPatterns("road cycling"), ["cycling", "cycle", "bike", "biking", "ride", "riding", "mtb", "gravel", "cyclocross"]);
  assert.deepEqual(enduranceSportPatterns("triathlon"), ["run", "running", "jog", "jogging", "cycling", "cycle", "bike", "biking", "ride", "riding", "mtb", "gravel", "cyclocross", "swim", "swimming", "triathlon", "multisport"]);
  assert.deepEqual(enduranceSportPatterns("rowing erg"), ["row", "rowing", "erg"]);
});

test("activity sport WHERE helper returns token-aware parameterized SQL", () => {
  const where = activitySportWhere("a", ["run", "jog"]);
  assert.match(where.sql, /LOWER\(COALESCE\(a\.type,''\)\)/);
  assert.match(where.sql, /LIKE \? OR/);
  assert.deepEqual(where.params, ["% run %", "% jog %"]);
});

test("activity sport WHERE helper normalizes old wildcard patterns to tokens", () => {
  const where = activitySportWhere("a", ["%bike%"]);
  assert.deepEqual(where.params, ["% bike %"]);
});
