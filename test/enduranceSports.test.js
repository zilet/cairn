import { test } from "node:test";
import assert from "node:assert/strict";
import { activitySportWhere, canonicalEnduranceSport, enduranceSportPatterns } from "../dist/repo/endurance-sports.js";

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

test("canonicalEnduranceSport buckets a raw type with the right pace-relevance", () => {
  // Foot sports are paced (min/km is the metric); wheels/water are not.
  assert.deepEqual(canonicalEnduranceSport("treadmill_running"), { key: "run", label: "Running", paced: true });
  assert.deepEqual(canonicalEnduranceSport("trail running"), { key: "run", label: "Running", paced: true });
  assert.deepEqual(canonicalEnduranceSport("mountain_biking"), { key: "ride", label: "Cycling", paced: false });
  assert.deepEqual(canonicalEnduranceSport("cycling"), { key: "ride", label: "Cycling", paced: false });
  assert.equal(canonicalEnduranceSport("lap_swimming").key, "swim");
  assert.equal(canonicalEnduranceSport("lap_swimming").paced, false);
  assert.deepEqual(canonicalEnduranceSport("hiking"), { key: "walk", label: "Walking & Hiking", paced: true });
  // Unknown type → Title-Cased label, treated as a distance sport.
  assert.deepEqual(canonicalEnduranceSport("kite_surfing"), { key: "kite surfing", label: "Kite Surfing", paced: false });
});
