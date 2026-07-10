import { test } from "node:test";
import assert from "node:assert/strict";
import * as repo from "../dist/repo.js";
import { flushBrainEventsForTest, resetBrainEventsForTest } from "../dist/brainEvents.js";

test("logged sets coalesce by session and finishing is the single review boundary", () => {
  for (let index = 0; index < 20; index++) {
    repo.logSetByName({
      exercise: "Bench Press",
      date: "2026-07-09",
      weight: 100,
      reps: 8,
    });
  }

  const setSignals = flushBrainEventsForTest(1_000, 0);
  assert.equal(setSignals.length, 1);
  assert.equal(setSignals[0].kind, "set_logged");
  assert.equal(setSignals[0].review, false);

  repo.finishSession(setSignals[0].entity_id);
  const finishSignals = flushBrainEventsForTest(2_000, 0);
  assert.equal(finishSignals.length, 1);
  assert.equal(finishSignals[0].kind, "session_finished");
  assert.equal(finishSignals[0].review, true);
});

test("session feedback and a new skip emit once after successful writes", () => {
  const feedback = repo.setSessionFeedback("2026-07-09", {
    soreness: 4,
    joint_pain: "left shoulder",
  });
  repo.skipExercise("Lat Pulldown", "2026-07-09");
  repo.skipExercise("Lat Pulldown", "2026-07-09");

  const signals = flushBrainEventsForTest(3_000, 0);
  assert.equal(signals.filter((event) => event.kind === "session_feedback").length, 1);
  assert.equal(signals.filter((event) => event.kind === "exercise_skipped").length, 1);
  assert.equal(signals.find((event) => event.kind === "session_feedback").entity_id, feedback.id);
});

test("activity and Garmin recovery writes emit cheap domain signals", () => {
  const activity = repo.addActivity({
    date: "2026-07-09",
    type: "hike",
    duration_min: 30,
    distance_km: 5,
  });
  repo.upsertGarminActivity({
    external_id: "garmin-run-1",
    date: "2026-07-09",
    type: "run",
    name: "Morning run",
    duration_min: 29,
    distance_km: 5,
  });
  // A richer re-sync updates the same authoritative row and coalesces with the
  // pending signal instead of creating a second review candidate.
  repo.upsertGarminActivity({
    external_id: "garmin-run-1",
    date: "2026-07-09",
    type: "run",
    name: "Morning run",
    duration_min: 29,
    distance_km: 5,
    avg_hr: 148,
  });
  repo.upsertGarminDailyMetric({
    date: "2026-07-09",
    sleep_min: 430,
    hrv_ms: 58,
    resting_hr: 51,
  });
  repo.recordDailyMetrics("apple", "2026-07-09", {
    sleep_min: 425,
    hrv_ms: 57,
  });

  const signals = flushBrainEventsForTest(4_000, 0);
  const activitySignals = signals.filter((event) => event.kind === "activity_synced");
  const recoverySignals = signals.filter((event) => event.kind === "recovery_metrics_changed");
  assert.equal(activitySignals.length, 2);
  assert.ok(activitySignals.some((event) => event.entity_id === activity.id));
  assert.ok(activitySignals.every((event) => event.review === false));
  assert.equal(recoverySignals.length, 2);
  assert.ok(recoverySignals.every((event) => event.domain === "recovery"));
  assert.ok(recoverySignals.every((event) => event.review === false));
});

test("health records emit separate clinical marker and medication signals", () => {
  const doc = repo.addHealthDocument({
    kind: "bloodwork",
    doc_date: "2026-07-08",
    parsed_json: {
      markers: [{ name: "Ferritin", value: 18, unit: "ng/mL", flag: "low" }],
      clinical_facts: [{ kind: "medication", name: "Atorvastatin", status: "active" }],
    },
    enrichment_status: "done",
  });

  const signals = flushBrainEventsForTest(5_000, 0);
  assert.deepEqual(signals.map((event) => event.kind).sort(), ["health_marker_changed", "medication_changed"]);
  assert.ok(signals.every((event) => event.entity_id === doc.id));
  assert.ok(signals.every((event) => event.clinical && event.review));
});

test("supplement CRUD emits clinical review signals only after successful writes", () => {
  const supplement = repo.addSupplement({
    name: "Creatine",
    dose: "5 g",
    frequency: "daily",
    category: "performance",
    related_markers: ["Creatinine", "eGFR"],
  });
  let signals = flushBrainEventsForTest(5_500, 0);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, "supplement_changed");
  assert.equal(signals[0].entity_id, supplement.id);
  assert.equal(signals[0].clinical, true);

  resetBrainEventsForTest();
  repo.updateSupplement(supplement.id, { dose: "3 g" });
  signals = flushBrainEventsForTest(5_600, 0);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].reason, "supplement updated");

  resetBrainEventsForTest();
  repo.deleteSupplement(supplement.id);
  signals = flushBrainEventsForTest(5_700, 0);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].reason, "supplement removed");
});

test("context changes request review without triggering any action", () => {
  const event = repo.addContextEvent({
    kind: "injury",
    title: "Shoulder irritation",
    start_date: "2026-07-09",
  });
  const added = flushBrainEventsForTest(6_000, 0);
  assert.equal(added.length, 1);
  assert.equal(added[0].kind, "context_changed");
  assert.equal(added[0].entity_id, event.id);
  assert.equal(added[0].review, true);
  assert.equal(added[0].clinical, true);

  resetBrainEventsForTest();
  repo.resolveContextEvent(event.id, "2026-07-10");
  const resolved = flushBrainEventsForTest(7_000, 0);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].reason, "context event resolved");
});

test("body, profile, and goal writes reach the signal router", () => {
  repo.logWeight(198.4, "2026-07-09");
  repo.addBodyMeasurement("2026-07-09", { waist_in: 33.5, chest_in: 41 });
  repo.setProfile({ goal_weight_lb: 185, goal_date: "2026-10-01" });
  repo.setProfile({ allergies: "peanuts" });
  // A no-op save and a bare weight sync must stay silent.
  repo.setProfile({ allergies: "peanuts" });
  repo.setProfile({ weight_lb: 198.2 });

  const signals = flushBrainEventsForTest(4_000, 0);
  const weight = signals.find((event) => event.kind === "weight_logged");
  assert.ok(weight, "a weigh-in emits");
  assert.equal(weight.domain, "body");
  const body = signals.find((event) => event.kind === "body_measurement_changed");
  assert.ok(body, "a tape measurement emits");
  assert.equal(body.review, true);
  assert.match(String(body.subject_key), /waist/);
  const goal = signals.find((event) => event.kind === "goal_changed");
  assert.ok(goal, "a goal change emits");
  assert.equal(goal.material, true);
  const profile = signals.filter((event) => event.kind === "profile_changed");
  assert.equal(profile.length, 1, "identity changes emit once; no-op saves and weight syncs stay silent");
  assert.equal(profile[0].material, true, "an allergy change is material");
});
