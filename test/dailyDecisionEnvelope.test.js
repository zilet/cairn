import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDailySessionDecision, dailyDecisionFingerprint } from "../dist/repo/daily-decision.js";

// A minimal, valid decision snapshot. Tests override just the slice they exercise
// so each scenario is isolated and the fixture stays readable.
function snapshot(overrides = {}) {
  return {
    date: "2031-05-01",
    request: { override: null, equipment: null, minutes: null, goal: null },
    plan: {
      day_number: 1,
      focus: "Lower body",
      plan_day_id: 10,
      source: "adaptive",
      reason: "Legs are due",
      due: ["quads"],
      over: [],
    },
    day_read: {
      kind: "train",
      focus: "Lower body",
      est_minutes: 55,
      consecutive_training_days: 1,
      recovery_week: false,
      trained_today: false,
    },
    recovery: { has_data: true, readiness: "high", hrv_drift: "flat", rhr_drift: "flat", sleep_drift: "flat" },
    muscle_load: [],
    endurance: [],
    checkin: null,
    feedback: null,
    constraints: { injuries: [], illness: false, travel: false },
    program: { mesocycle_phase: "accumulation", adaptations_due: [], volume_low_groups: [], volume_high_groups: [] },
    progression: [
      { exercise: "Back Squat", muscle_group: null, action: "overload", why: "Two clean sessions" },
      { exercise: "Romanian Deadlift", muscle_group: null, action: "hold", why: "Reps not consolidated" },
    ],
    plan_items: [
      { exercise: "Back Squat", muscle_group: "quads", mode: "reps", kind: "strength" },
      { exercise: "Romanian Deadlift", muscle_group: "hamstrings", mode: "reps", kind: "strength" },
    ],
    ...overrides,
  };
}

const NOW = "2031-05-01T12:00:00.000Z";

test("same snapshot yields identical fingerprint and envelope content", () => {
  const snap = snapshot();
  const a = buildDailySessionDecision(snap, { now: NOW });
  const b = buildDailySessionDecision(snap, { now: NOW });
  assert.equal(a.input_fingerprint, b.input_fingerprint);
  assert.equal(a.input_fingerprint, dailyDecisionFingerprint(snap));
  assert.deepEqual(a, b);
  assert.equal(a.policy_version, "daily_decision_v1");
});

test("fingerprint is stable across object key insertion order", () => {
  const base = snapshot();
  const reordered = snapshot();
  // Rebuild the request object with keys in a different order.
  reordered.request = { minutes: null, goal: null, override: null, equipment: null };
  assert.equal(dailyDecisionFingerprint(base), dailyDecisionFingerprint(reordered));
});

test("fingerprint changes when a load-bearing input changes", () => {
  const a = dailyDecisionFingerprint(snapshot());
  const b = dailyDecisionFingerprint(
    snapshot({ request: { override: "train anyway", equipment: null, minutes: null, goal: null } })
  );
  assert.notEqual(a, b);
});

test("healthy training day carries the plan with progression reason codes", () => {
  const env = buildDailySessionDecision(snapshot(), { now: NOW });
  assert.equal(env.kind, "train");
  assert.equal(env.template.intent, "template");
  assert.equal(env.caps.volume, "normal");
  assert.equal(env.caps.intensity, "normal");
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "overload");
  assert.equal(squat.reason_code, "progression_overload");
  assert.ok(env.muscles.required.includes("quads"));
});

test("injury excludes the injured group and drops the loaded candidate", () => {
  const env = buildDailySessionDecision(
    snapshot({
      constraints: {
        injuries: [{ title: "Left knee tendinitis", areas: ["quads"], exercises: ["Back Squat"] }],
        illness: false,
        travel: false,
      },
    }),
    { now: NOW }
  );
  assert.ok(env.muscles.excluded.includes("quads"));
  assert.ok(!env.muscles.required.includes("quads"));
  assert.ok(env.hard_constraints.some((c) => c.code === "injury_exclusion"));
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "exclude");
  assert.equal(squat.reason_code, "injury_exclusion");
  assert.ok(env.precedence.includes("injury_exclusion"));
});

test("recent heavy lower-body endurance reduces conflicting leg volume", () => {
  const env = buildDailySessionDecision(
    snapshot({
      endurance: [
        { type: "run", days_ago: 0, intensity: "hard", load: "heavy", regions: ["quads", "hamstrings", "calves"] },
      ],
    }),
    { now: NOW }
  );
  assert.ok(env.muscles.reduced.includes("quads"));
  assert.ok(env.soft_preferences.some((s) => s.code === "endurance_lower_conflict"));
  assert.ok(env.precedence.includes("endurance_lower_conflict"));
  // A reduced group holds rather than overloads today.
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "hold");
});

test("low recovery + high soreness softens volume and holds intensity", () => {
  const env = buildDailySessionDecision(
    snapshot({
      day_read: { ...snapshot().day_read, kind: "easy" },
      recovery: { has_data: true, readiness: "low", hrv_drift: "down", rhr_drift: "up", sleep_drift: "down" },
      feedback: { soreness: 4, performance: 2, joint_pain: null },
    }),
    { now: NOW }
  );
  assert.equal(env.kind, "easy");
  assert.equal(env.caps.volume, "reduced");
  assert.equal(env.caps.intensity, "easy");
  assert.ok(env.precedence.includes("high_soreness"));
  assert.ok(env.precedence.includes("repeated_underperformance"));
});

test("deload mesocycle phase forces deload intensity", () => {
  const env = buildDailySessionDecision(
    snapshot({ program: { ...snapshot().program, mesocycle_phase: "deload-due" } }),
    { now: NOW }
  );
  assert.equal(env.caps.intensity, "deload");
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "deload");
});

test("joint pain reduces the joint's groups as a soft nudge", () => {
  const env = buildDailySessionDecision(
    snapshot({ feedback: { soreness: null, performance: null, joint_pain: "left knee" } }),
    { now: NOW }
  );
  assert.ok(env.muscles.excluded.includes("quads"));
  assert.ok(env.soft_preferences.some((s) => s.code === "joint_pain_reduce"));
});

test("athlete override 'train anyway' wins the kind but stays conservative", () => {
  const env = buildDailySessionDecision(
    snapshot({
      day_read: { ...snapshot().day_read, kind: "rest" },
      request: { override: "train anyway", equipment: null, minutes: null, goal: null },
    }),
    { now: NOW }
  );
  assert.equal(env.kind, "train");
  assert.ok(env.precedence.includes("athlete_override"));
});

test("athlete override 'rest today' wins the kind", () => {
  const env = buildDailySessionDecision(
    snapshot({ request: { override: "I want to rest today", equipment: null, minutes: null, goal: null } }),
    { now: NOW }
  );
  assert.equal(env.kind, "rest");
  assert.equal(env.caps.volume, "minimal");
  assert.equal(env.candidates.length, 0);
});

test("short-on-time override caps duration without forcing an easy day", () => {
  const env = buildDailySessionDecision(
    snapshot({ request: { override: "short on time", equipment: null, minutes: 30, goal: null } }),
    { now: NOW }
  );
  assert.equal(env.kind, "train");
  assert.ok(env.caps.duration_min <= 35);
  assert.ok(env.hard_constraints.some((c) => c.code === "time_constrained"));
});

test("no plan day degrades to a custom-intent envelope without candidates", () => {
  const env = buildDailySessionDecision(
    snapshot({
      plan: { day_number: null, focus: null, plan_day_id: null, source: null, reason: null, due: [], over: [] },
      plan_items: [],
      progression: [],
    }),
    { now: NOW }
  );
  assert.equal(env.template.intent, "custom");
  assert.equal(env.candidates.length, 0);
  assert.equal(env.kind, "train");
});
