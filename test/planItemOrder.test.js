// planItemOrder.test.js — pure effect-order ladder for plan items.
// Offline — no DB required for the orderer itself; imports dist after pretest build.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderPlanItemsForEffect,
  planItemsOutOfOrder,
  planItemEffectTier,
  PLAN_ITEM_EFFECT_TIER,
  orderPlanDaysForEffect,
} from "../dist/domain/training/plan-item-order.js";
import { inferEquipment, equipmentLoadRank } from "../dist/repo/exercise-variations.js";

test("inferEquipment: curated Back Squat is barbell", () => {
  assert.equal(inferEquipment("Back Squat"), "barbell");
  assert.equal(equipmentLoadRank(inferEquipment("Back Squat")), 0);
});

test("inferEquipment: Leg Press is machine", () => {
  assert.equal(inferEquipment("Leg Press"), "machine");
});

test("primary compounds sort before isolation and core", () => {
  const items = [
    { exercise: "Cable Curl", kind: "strength" },
    { exercise: "Back Squat", kind: "strength" },
    { exercise: "Plank", kind: "strength" },
    { exercise: "Bench Press", kind: "strength" },
  ];
  const ordered = orderPlanItemsForEffect(items).map((i) => i.exercise);
  assert.deepEqual(ordered, ["Back Squat", "Bench Press", "Cable Curl", "Plank"]);
});

test("cardio lands after all strength", () => {
  const items = [
    { kind: "cardio", exercise: "Easy run", note: "Easy run", target_distance_km: 5 },
    { exercise: "Romanian Deadlift", kind: "strength" },
    { exercise: "Leg Curl", kind: "strength" },
  ];
  const ordered = orderPlanItemsForEffect(items);
  assert.equal(ordered[0].exercise, "Romanian Deadlift");
  assert.equal(ordered[1].exercise, "Leg Curl");
  assert.equal(ordered[2].kind, "cardio");
});

test("primaries are peers whatever the tool — the athlete's order among them stands", () => {
  const items = [
    { exercise: "Leg Press", kind: "strength" },
    { exercise: "Back Squat", kind: "strength" },
    { exercise: "Front Squat", kind: "strength" },
  ];
  const ordered = orderPlanItemsForEffect(items).map((i) => i.exercise);
  // No equipment tie-break: inferred tools default unknown names to dumbbell and
  // let a machine row overtake a dumbbell bench on a real plan. Same tier, same order.
  assert.deepEqual(ordered, ["Leg Press", "Back Squat", "Front Squat"]);
  assert.equal(planItemsOutOfOrder(items), false);
});

test("pull-ups before a barbell row is in order (bodyweight compound is a primary peer)", () => {
  const items = [
    { exercise: "Neutral-Grip Pull-Up", kind: "strength" },
    { exercise: "Pendlay Row", kind: "strength" },
    { exercise: "Reverse Pec Deck", kind: "strength" },
    { exercise: "Rope Hammer Curl", kind: "strength" },
    { exercise: "Pallof Press", kind: "strength" },
  ];
  assert.equal(planItemsOutOfOrder(items), false);
});

test("mobility prep stays ahead of the compound it warms up", () => {
  const items = [
    {
      exercise: "Ankle Rocker",
      kind: "strength",
      note: "Mobility prep, not working volume: 3–4 minutes before squats.",
    },
    { exercise: "Back Squat", kind: "strength" },
    { exercise: "Leg Extension", kind: "strength" },
    { exercise: "Romanian Deadlift", kind: "strength" },
  ];
  assert.equal(planItemEffectTier(items[0]), PLAN_ITEM_EFFECT_TIER.prep);
  const ordered = orderPlanItemsForEffect(items).map((i) => i.exercise);
  assert.deepEqual(ordered, ["Ankle Rocker", "Back Squat", "Romanian Deadlift", "Leg Extension"]);
  // A note alone can say prep, with a name that says nothing.
  assert.equal(
    planItemEffectTier({ exercise: "Hip Circles", note: "Warm-up drill before the first working set" }),
    PLAN_ITEM_EFFECT_TIER.prep
  );
  assert.equal(planItemEffectTier({ exercise: "Leg Press" }), PLAN_ITEM_EFFECT_TIER.primary);
  // The name alone is enough — no note required.
  assert.equal(planItemEffectTier({ exercise: "Ankle Rocker" }), PLAN_ITEM_EFFECT_TIER.prep);
  assert.equal(planItemEffectTier({ exercise: "World's Greatest Stretch" }), PLAN_ITEM_EFFECT_TIER.prep);
});

test("hip thrust (secondary) sits between compounds and isolation", () => {
  const items = [
    { exercise: "Dumbbell Curl", kind: "strength" },
    { exercise: "Hip Thrust", kind: "strength" },
    { exercise: "Back Squat", kind: "strength" },
  ];
  const ordered = orderPlanItemsForEffect(items).map((i) => i.exercise);
  assert.deepEqual(ordered, ["Back Squat", "Hip Thrust", "Dumbbell Curl"]);
});

test("planItemsOutOfOrder is false when already optimal", () => {
  const items = [
    { exercise: "Back Squat", kind: "strength" },
    { exercise: "Leg Curl", kind: "strength" },
    { kind: "cardio", exercise: "Easy", note: "Easy" },
  ];
  assert.equal(planItemsOutOfOrder(items), false);
  assert.equal(planItemsOutOfOrder(orderPlanItemsForEffect(items)), false);
});

test("planItemsOutOfOrder detects curl-before-squat", () => {
  const items = [
    { exercise: "Cable Curl", kind: "strength" },
    { exercise: "Back Squat", kind: "strength" },
  ];
  assert.equal(planItemsOutOfOrder(items), true);
});

test("orderPlanDaysForEffect maps every day", () => {
  const days = [
    {
      day_number: 1,
      items: [
        { exercise: "Cable Curl", kind: "strength" },
        { exercise: "Bench Press", kind: "strength" },
      ],
    },
  ];
  const out = orderPlanDaysForEffect(days);
  assert.equal(out[0].items[0].exercise, "Bench Press");
  assert.equal(out[0].items[1].exercise, "Cable Curl");
});

test("tiers: prep < primary < secondary < isolation < core < cardio", () => {
  assert.ok(PLAN_ITEM_EFFECT_TIER.prep < PLAN_ITEM_EFFECT_TIER.primary);
  assert.ok(PLAN_ITEM_EFFECT_TIER.primary < PLAN_ITEM_EFFECT_TIER.secondary);
  assert.ok(PLAN_ITEM_EFFECT_TIER.secondary < PLAN_ITEM_EFFECT_TIER.isolation);
  assert.ok(PLAN_ITEM_EFFECT_TIER.isolation < PLAN_ITEM_EFFECT_TIER.core);
  assert.ok(PLAN_ITEM_EFFECT_TIER.core < PLAN_ITEM_EFFECT_TIER.cardio);
  assert.equal(planItemEffectTier({ exercise: "Back Squat" }), PLAN_ITEM_EFFECT_TIER.primary);
  assert.equal(planItemEffectTier({ exercise: "Plank" }), PLAN_ITEM_EFFECT_TIER.core);
  assert.equal(planItemEffectTier({ kind: "cardio", exercise: "Run" }), PLAN_ITEM_EFFECT_TIER.cardio);
});
