// Fueling ADVICE is not a brake (2026-09-22). In a cut, "fuel-protect" fires after ANY
// heavy or long endurance day — every weekly long run — and it used to be the only fresh
// "brake" that turned a run of loading days into a REST. It now rides the Brief as a
// caveat; only when the underfueling read itself shows strain does it keep its weight.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedTrainingDay } from "./_seed.js";
import {
  dimensionIsAdviceOnly,
  hasFreshBrake,
  hasFreshDecidingBrake,
  planningSignalState,
} from "../dist/repo/signal-state.js";
import { DAY_READ_CAVEAT_VARIANTS } from "../dist/repo/day-read-prose.js";

const REF = "2031-06-11";
const dayBefore = (n) => new Date(Date.parse(`${REF}T00:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
const FUEL_PROTECT = { hybrid: { status: "fuel-protect", headline: "Yesterday's long run raises fueling needs." } };

beforeEach(() => {
  resetTables("logged_sets", "sessions", "exercises", "plan_items", "plan_days", "day_reads", "activities");
});

const state = (underfueling) =>
  planningSignalState({
    date: REF,
    programState: FUEL_PROTECT,
    underfueling,
    recovery: { has_data: false, recovery: {} },
  });

test("fuel-protect without underfueling strain is advice: it speaks, it holds nothing", () => {
  const advice = state({ state: "uncertain" });
  assert.equal(advice.dimensions.energy_fueling.status, "watch", "the advice is still on the board");
  assert.equal(dimensionIsAdviceOnly(advice.dimensions.energy_fueling), true);
  assert.equal(hasFreshBrake(advice.dimensions), false, "it cannot hold the push back");
  assert.equal(hasFreshDecidingBrake(advice.dimensions), false, "nor decide the day");

  const strained = state({ state: "persistent_strain", action: { training: "hold_aggression" } });
  const fuel = strained.dimensions.energy_fueling.evidence.find((item) => item.field === "hybrid_fuel");
  assert.equal(fuel.direction, "constraint", "corroborated by the underfueling read, it keeps its weight");
  assert.equal(hasFreshDecidingBrake(strained.dimensions), true);
});

test("a run of loading days after a long run in a cut reads train with the fuel caveat, not rest", () => {
  repo.savePlanDay(1, "Upper", "Upper body", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  for (let i = 1; i <= 4; i++) seedTrainingDay(dayBefore(i));
  const read = repo.dayRead(REF, { has_data: false, recovery: {} }, state({ state: "uncertain" }));
  // Before: REST via accumulated_load_rest, the fuel advice its only corroboration.
  assert.equal(read.kind, "train", `advice alone must not corroborate a rest (${read.decision.rule_code})`);
  assert.ok(
    DAY_READ_CAVEAT_VARIANTS["planned_training:fuel_around"].some((variant) => read.why.includes(variant)),
    `the fuel advice rides as a caveat: ${read.why}`
  );
});

test("the same run with the underfueling read in persistent strain stays quiet", () => {
  repo.savePlanDay(1, "Upper", "Upper body", [{ exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 }]);
  for (let i = 1; i <= 4; i++) seedTrainingDay(dayBefore(i));
  const read = repo.dayRead(
    REF,
    { has_data: false, recovery: {} },
    state({ state: "persistent_strain", action: { training: "hold_aggression" } })
  );
  // Corroborated strain keeps its deciding weight: the day is protected (the protect
  // rule's easy outranks the stacked rest here), never opened to train.
  assert.ok(["rest", "easy"].includes(read.kind), `${read.kind} ${read.decision.rule_code}`);
});
