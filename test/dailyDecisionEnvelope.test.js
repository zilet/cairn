import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { buildDailySessionDecision, dailyDecisionFingerprint } from "../dist/repo/daily-decision.js";

// A minimal, valid decision snapshot. Tests override just the slice they exercise
// so each scenario is isolated and the fixture stays readable.
function snapshot(overrides = {}) {
  return {
    date: "2031-05-01",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
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
      { exercise: "Back Squat", muscle_group: "quads", equipment: "barbell", mode: "reps", kind: "strength" },
      {
        exercise: "Romanian Deadlift",
        muscle_group: "hamstrings",
        equipment: "barbell",
        mode: "reps",
        kind: "strength",
      },
    ],
    ...overrides,
  };
}

const NOW = "2031-05-01T12:00:00.000Z";

function stableJson(value) {
  if (value === undefined) return "null";
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}

test("same snapshot yields identical fingerprint and envelope content", () => {
  const snap = snapshot();
  const a = buildDailySessionDecision(snap, { now: NOW });
  const b = buildDailySessionDecision(snap, { now: NOW });
  assert.equal(a.input_fingerprint, b.input_fingerprint);
  assert.equal(a.input_fingerprint, dailyDecisionFingerprint(snap));
  assert.deepEqual(a, b);
  assert.equal(a.policy_version, "daily_decision_v5");
});

test("fingerprint is stable across object key insertion order", () => {
  const base = snapshot();
  const reordered = snapshot();
  // Rebuild the request object with keys in a different order.
  reordered.request = { minutes: null, goal: null, override: null, train_anyway: false, equipment: null };
  assert.equal(dailyDecisionFingerprint(base), dailyDecisionFingerprint(reordered));
});

test("fingerprint changes when a load-bearing input changes", () => {
  const a = dailyDecisionFingerprint(snapshot());
  const b = dailyDecisionFingerprint(
    snapshot({ request: { override: "train anyway", train_anyway: true, equipment: null, minutes: null, goal: null } })
  );
  assert.notEqual(a, b);
});

test("v5 policy identity cannot collide with the legacy snapshot-only v4 fingerprint", () => {
  const snap = snapshot();
  const legacyV4 = createHash("sha256").update(stableJson(snap)).digest("hex");
  const current = dailyDecisionFingerprint(snap);
  assert.notEqual(current, legacyV4);
  assert.equal(buildDailySessionDecision(snap, { now: NOW }).policy_version, "daily_decision_v5");
});

test("healthy training day carries the plan with progression reason codes", () => {
  const snap = snapshot();
  snap.progression[0] = {
    ...snap.progression[0],
    current_target: {
      mode: "reps",
      sets: 3,
      rep_low: 5,
      rep_high: 7,
      target_weight: 225,
      target_seconds: null,
    },
    suggested_target: {
      mode: "reps",
      sets: 3,
      rep_low: 5,
      rep_high: 7,
      target_weight: 230,
      target_seconds: null,
    },
    evidence: {
      delta_text: "+5 lb",
      why: "Two clean sessions",
      reground: false,
      autoregulated: false,
      movement_response: "insufficient",
      rep_step: false,
      dose_eligibility: { linked_outcome: true, eligible: true, reason: "full_comparable" },
    },
  };
  const env = buildDailySessionDecision(snap, { now: NOW });
  assert.equal(env.kind, "train");
  assert.equal(env.template.intent, "template");
  assert.equal(env.caps.volume, "normal");
  assert.equal(env.caps.intensity, "normal");
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "overload");
  assert.equal(squat.reason_code, "progression_overload");
  assert.equal(squat.current_target.target_weight, 225);
  assert.equal(squat.authorized_target.target_weight, 230);
  assert.equal(squat.progression_evidence.delta_text, "+5 lb");
  assert.equal(squat.progression_evidence.dose_eligibility.reason, "full_comparable");
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

test("an exact injured exercise is excluded even when no muscle area was classified", () => {
  const env = buildDailySessionDecision(
    snapshot({
      constraints: {
        injuries: [{ title: "Movement-specific restriction", areas: [], exercises: ["Back Squat"] }],
        illness: false,
        travel: false,
      },
    }),
    { now: NOW }
  );
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "exclude");
  assert.equal(squat.reason_code, "injury_exclusion");
});

test("soft-recheck injuries remain movement-specific holds and never become hard exclusions", () => {
  const env = buildDailySessionDecision(
    snapshot({
      constraints: {
        injuries: [
          {
            title: "Knee recheck",
            constraint_level: "soft_recheck",
            areas: ["knee"],
            exercises: ["Back Squat"],
          },
        ],
        illness: false,
        travel: false,
      },
    }),
    { now: NOW }
  );
  assert.deepEqual(env.muscles.excluded, []);
  assert.ok(!env.hard_constraints.some((item) => item.code === "injury_exclusion"));
  assert.ok(env.soft_preferences.some((item) => item.code === "injury_recheck"));
  assert.equal(env.candidates.find((item) => item.exercise === "Back Squat").action, "hold");
  assert.notEqual(
    env.candidates.find((item) => item.exercise === "Romanian Deadlift").reason_code,
    "injury_recheck"
  );
  assert.equal(
    env.candidates.find((item) => item.exercise === "Back Squat").reason_code,
    "injury_recheck"
  );
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
      feedback: { soreness: 4, performance: 2, joint_pain: null, low_performance_count: 1 },
    }),
    { now: NOW }
  );
  assert.equal(env.kind, "easy");
  assert.equal(env.caps.volume, "reduced");
  assert.equal(env.caps.intensity, "easy");
  assert.ok(env.precedence.includes("high_soreness"));
  assert.ok(env.precedence.includes("recent_underperformance"));
  assert.ok(!env.precedence.includes("repeated_underperformance"));
});

test("deload-due is rationale only; only an active deload/recovery phase forces deload intensity", () => {
  const env = buildDailySessionDecision(
    snapshot({ program: { ...snapshot().program, mesocycle_phase: "deload-due" } }),
    { now: NOW }
  );
  assert.equal(env.caps.intensity, "normal");
  const dueSquat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(dueSquat.action, "overload");

  const active = buildDailySessionDecision(
    snapshot({ program: { ...snapshot().program, mesocycle_phase: "deload" } }),
    { now: NOW }
  );
  assert.equal(active.caps.intensity, "deload");
  const recovery = buildDailySessionDecision(
    snapshot({ program: { ...snapshot().program, mesocycle_phase: "recovery" } }),
    { now: NOW }
  );
  assert.equal(recovery.caps.intensity, "deload");
  const squat = active.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "deload");
});

test("two distinct low-performance observations enable repeated-underperformance deload", () => {
  const env = buildDailySessionDecision(
    snapshot({
      feedback: { soreness: null, performance: 2, joint_pain: null, low_performance_count: 2 },
    }),
    { now: NOW }
  );
  assert.equal(env.caps.intensity, "deload");
  assert.ok(env.precedence.includes("repeated_underperformance"));
  const squat = env.candidates.find((c) => c.exercise === "Back Squat");
  assert.equal(squat.action, "deload");
});

test("one low-performance observation produces only a hold and is never called repeated", () => {
  const env = buildDailySessionDecision(
    snapshot({
      feedback: { soreness: null, performance: 2, joint_pain: null, low_performance_count: 1 },
    }),
    { now: NOW }
  );
  assert.equal(env.caps.intensity, "hold");
  assert.ok(env.precedence.includes("recent_underperformance"));
  assert.ok(!env.precedence.includes("repeated_underperformance"));
  assert.equal(env.candidates.find((c) => c.exercise === "Back Squat").action, "hold");
});

test("a concrete progression variation becomes an executable substitution candidate", () => {
  const env = buildDailySessionDecision(
    snapshot({
      progression: [
        {
          exercise: "Back Squat",
          muscle_group: null,
          action: "vary",
          why: "Rotate the pattern",
          vary_to: "Front Squat",
        },
      ],
    }),
    { now: NOW }
  );
  const candidate = env.candidates.find((c) => c.substitution_for === "Back Squat");
  assert.equal(candidate.exercise, "Front Squat");
  assert.equal(candidate.action, "vary");
  assert.equal(candidate.reason_code, "progression_vary");
});

test("joint pain reduces the joint's groups as a soft nudge", () => {
  const env = buildDailySessionDecision(
    snapshot({ feedback: { soreness: null, performance: null, joint_pain: "left knee" } }),
    { now: NOW }
  );
  assert.ok(env.muscles.excluded.includes("quads"));
  assert.ok(env.soft_preferences.some((s) => s.code === "joint_pain_reduce"));
});

test("joint pain routes a note-backed cardio label through movement relevance", () => {
  const env = buildDailySessionDecision(
    snapshot({
      feedback: { soreness: null, performance: null, joint_pain: "left knee" },
      plan_items: [
        ...snapshot().plan_items,
        {
          exercise: "Easy run",
          muscle_group: null,
          equipment: null,
          mode: "reps",
          kind: "cardio",
          target_duration_min: 30,
          target_zone: "easy",
        },
      ],
    }),
    { now: NOW }
  );
  const run = env.candidates.find((candidate) => candidate.exercise === "Easy run");
  assert.equal(run.action, "exclude");
  assert.equal(run.reason_code, "joint_pain_reduce");
  assert.equal(env.reported_joint_pain, "left knee");
});

test("athlete override 'train anyway' wins the kind but stays conservative", () => {
  const env = buildDailySessionDecision(
    snapshot({
      day_read: { ...snapshot().day_read, kind: "rest" },
      request: { override: null, train_anyway: true, equipment: null, minutes: null, goal: null },
    }),
    { now: NOW }
  );
  assert.equal(env.kind, "train");
  assert.equal(env.baseline_kind, "rest");
  assert.equal(env.request.train_anyway, true);
  assert.equal(env.caps.volume, "reduced");
  assert.equal(env.caps.intensity, "deload");
  assert.ok(env.caps.duration_min <= 40);
  assert.ok(env.precedence.includes("athlete_override"));
  assert.match(env.rationale[0].text, /Training by choice/);
});

test("every recognized train-intent override on a rest read persists train_anyway and conservative caps", () => {
  for (const override of ["train", "lift", "push", "full session", "I still want to train anyway"]) {
    const env = buildDailySessionDecision(
      snapshot({
        day_read: { ...snapshot().day_read, kind: "rest" },
        request: { override, train_anyway: false, equipment: null, minutes: null, goal: null },
      }),
      { now: NOW }
    );
    assert.equal(env.kind, "train", override);
    assert.equal(env.request.train_anyway, true, override);
    assert.equal(env.caps.volume, "reduced", override);
    assert.equal(env.caps.intensity, "deload", override);
    assert.ok(env.caps.duration_min <= 40, override);
  }
});

test("athlete override 'rest today' wins the kind", () => {
  const env = buildDailySessionDecision(
    snapshot({
      request: { override: "I want to rest today", train_anyway: false, equipment: null, minutes: null, goal: null },
    }),
    { now: NOW }
  );
  assert.equal(env.kind, "rest");
  assert.equal(env.caps.volume, "minimal");
  assert.equal(env.candidates.length, 0);
  assert.equal(env.template.intent, "custom");
  assert.equal(env.template.day_number, null);
});

test("short-on-time override caps duration without forcing an easy day", () => {
  const env = buildDailySessionDecision(
    snapshot({
      request: { override: "short on time", train_anyway: false, equipment: null, minutes: 30, goal: null },
    }),
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
