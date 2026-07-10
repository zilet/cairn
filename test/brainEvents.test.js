import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brainEventNeedsReview,
  emitBrainEvent,
  flushBrainEventsForTest,
  onBrainEvent,
  resetBrainEventsForTest,
} from "../dist/brainEvents.js";

test("set writes coalesce and remain cheap until the finished-session boundary", () => {
  resetBrainEventsForTest();
  const observed = [];
  onBrainEvent((event) => observed.push(event));
  for (let index = 0; index < 20; index++) {
    emitBrainEvent({
      kind: "set_logged",
      domain: "training",
      date: "2026-07-09",
      entity_id: 9,
      subject_key: "bench-press",
    });
  }
  const routed = flushBrainEventsForTest(1000, 0);
  assert.equal(routed.length, 1);
  assert.equal(observed.length, 1);
  assert.equal(routed[0].review, false);

  emitBrainEvent({ kind: "session_finished", domain: "training", date: "2026-07-09", entity_id: 9 });
  assert.equal(flushBrainEventsForTest(2000, 0)[0].review, true);
});

test("food capture does not trigger an unrelated coaching review", () => {
  resetBrainEventsForTest();
  const routed = brainEventNeedsReview({ kind: "food_logged", domain: "nutrition", date: "2026-07-09" });
  assert.equal(routed, false);
});

test("material and clinical signals always request review", () => {
  assert.equal(
    brainEventNeedsReview({ kind: "weight_logged", domain: "body", date: "2026-07-09", material: true }),
    true
  );
  assert.equal(
    brainEventNeedsReview({ kind: "health_marker_changed", domain: "health", date: "2026-07-09", clinical: true }),
    true
  );
});

test("cooldown deduplicates repeated scheduler-equivalent signals", () => {
  resetBrainEventsForTest();
  const input = { kind: "plan_changed", domain: "training", date: "2026-07-09", entity_id: 3 };
  emitBrainEvent(input);
  assert.equal(flushBrainEventsForTest(10_000, 60_000).length, 1);
  emitBrainEvent(input);
  assert.equal(flushBrainEventsForTest(20_000, 60_000).length, 0);
  emitBrainEvent(input);
  assert.equal(flushBrainEventsForTest(80_001, 60_000).length, 1);
});

test("invalid events are rejected at the trust boundary", () => {
  resetBrainEventsForTest();
  assert.equal(emitBrainEvent({ kind: "delete_everything", domain: "training", date: "2026-07-09" }), null);
  assert.equal(emitBrainEvent({ kind: "set_logged", domain: "training", date: "tomorrow" }), null);
  assert.equal(flushBrainEventsForTest().length, 0);
});
