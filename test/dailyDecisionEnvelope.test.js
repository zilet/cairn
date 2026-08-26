import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  buildDailySessionDecision,
  dailyDecisionFingerprint,
  REACH_NO_ROOM_WHY,
  REACH_PUSH_WHY,
  REACH_TRIMMED_WHY,
} from "../dist/repo/daily-decision.js";
import { REACH_AMRAP_NOTES, REACH_TOP_SET_NOTES } from "../dist/repo/daily-composition.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";

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
  assert.equal(a.policy_version, "daily_decision_v6");
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

test("v6 policy identity cannot collide with the legacy snapshot-only v4 fingerprint", () => {
  const snap = snapshot();
  const legacyV4 = createHash("sha256").update(stableJson(snap)).digest("hex");
  const current = dailyDecisionFingerprint(snap);
  assert.notEqual(current, legacyV4);
  assert.equal(buildDailySessionDecision(snap, { now: NOW }).policy_version, "daily_decision_v6");
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

// ---- learned plan-complexity ease ----
//
// `plan_complexity` is the learned default earned from repeatedly-missed plan days.
// It is declared with `max: 1`, so it can only ever hold or ease. These pin that it
// biases what Stage 3 OFFERS (the volume cap) and touches nothing else about the day.
function envelopeOf(overrides) {
  return buildDailySessionDecision(snapshot(overrides), { now: NOW });
}

test("a plan_complexity below the threshold prefers the simpler shape", () => {
  const eased = envelopeOf({ personal_response: { plan_complexity: 0.9 } });
  assert.equal(eased.caps.volume, "reduced");
  assert.ok(eased.precedence.includes("personal_response_ease"));
  const soft = eased.soft_preferences.find((entry) => entry.code === "personal_response_ease");
  assert.ok(soft, "the ease should record why it fired");
  assert.ok(soft.detail.trim().length > 0);
  // A bias on what is offered, never a limit on what the athlete may do.
  assert.equal(eased.kind, "train");
  assert.ok(!eased.hard_constraints.some((entry) => entry.code === "personal_response_ease"));
});

test("a plan_complexity at or above the threshold leaves the standard shape alone", () => {
  for (const scale of [0.96, 1]) {
    const held = envelopeOf({ personal_response: { plan_complexity: scale } });
    assert.equal(held.caps.volume, "normal", `scale ${scale} should not soften volume`);
    assert.ok(!held.precedence.includes("personal_response_ease"));
  }
});

test("a holding plan_complexity decides exactly what an absent one decides", () => {
  const absent = envelopeOf({});
  const holding = envelopeOf({ personal_response: { plan_complexity: 1 } });
  // Fingerprints differ (the snapshots genuinely differ); the DECISION must not.
  const { input_fingerprint: _a, ...absentContent } = absent;
  const { input_fingerprint: _b, ...holdingContent } = holding;
  assert.deepEqual(holdingContent, absentContent);
});

test("an absent plan_complexity leaves the fingerprint exactly where it was", () => {
  // The gather path spreads the key in only when an easing modifier exists, so a
  // snapshot with nothing learned must hash identically to one that never knew the
  // field. Writing the key as null instead would have moved every fingerprint.
  const bare = snapshot();
  const explicitlyAbsent = snapshot();
  delete explicitlyAbsent.personal_response;
  assert.equal(dailyDecisionFingerprint(bare), dailyDecisionFingerprint(explicitlyAbsent));
  assert.notEqual(
    dailyDecisionFingerprint(bare),
    dailyDecisionFingerprint(snapshot({ personal_response: { plan_complexity: 0.9 } })),
    "a learned ease must move the fingerprint so the decision is recomputed"
  );
});

test("the learned ease stays silent on a rest day, where volume is already minimal", () => {
  const resting = envelopeOf({
    day_read: {
      kind: "rest",
      focus: null,
      est_minutes: null,
      consecutive_training_days: 0,
      recovery_week: false,
      trained_today: false,
    },
    personal_response: { plan_complexity: 0.9 },
  });
  assert.equal(resting.caps.volume, "minimal");
  assert.ok(!resting.precedence.includes("personal_response_ease"));
});

test("a malformed plan_complexity is ignored rather than trusted", () => {
  for (const scale of [Number.NaN, "0.9", null, undefined]) {
    const envelope = envelopeOf({ personal_response: { plan_complexity: scale } });
    assert.equal(envelope.caps.volume, "normal", `scale ${String(scale)} should not soften volume`);
  }
});

// ── a peak week is TWO tiers, and the envelope used to describe one ───────────
// On a realization/peak day the progression engine puts the BACK-OFF block in
// `suggested` and the heavy single in `top_set`. That default is right — a
// consumer that knows nothing about peak weeks must land on a real, lighter
// session rather than on one near-maximal single with the rest of the work
// missing. The cost was that the single survived only as prose inside `why`, so
// the envelope described a session the athlete was not actually being asked to do.

const PEAK_TOP_SET = { weight: 275, reps: 1, backoff: { sets: 3, weight: 225, rep_low: 5, rep_high: 5 } };

function peakSnapshot(over = {}) {
  const snap = snapshot();
  snap.progression[0] = {
    ...snap.progression[0],
    action: "overload",
    current_target: { mode: "reps", sets: 3, rep_low: 5, rep_high: 7, target_weight: 215, target_seconds: null },
    suggested_target: { mode: "reps", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225, target_seconds: null },
    top_set: PEAK_TOP_SET,
    ...over,
  };
  return snap;
}

const squat = (envelope) => envelope.candidates.find((c) => c.exercise === "Back Squat");

test("the heavy single reaches the envelope as data, beside its own back-off block", () => {
  const envelope = buildDailySessionDecision(peakSnapshot(), { now: NOW });
  const candidate = squat(envelope);
  assert.deepEqual(candidate.top_set, { weight: 275, reps: 1 }, "the top tier, as numbers");
  assert.equal(candidate.authorized_target.target_weight, 225, "and the back-off block underneath it");
  assert.equal(candidate.authorized_target.sets, 3);
  assert.equal(candidate.action, "overload");
});

test("an ordinary day carries no top_set key at all, so every old fingerprint still holds", () => {
  const plain = snapshot();
  const envelope = buildDailySessionDecision(plain, { now: NOW });
  assert.ok(!("top_set" in squat(envelope)), "absent means absent — never a null field");
  // The snapshot itself must serialize byte-for-byte as it did before the field
  // existed, or every fingerprint on the planet moves the day this ships.
  assert.ok(!JSON.stringify(plain).includes("top_set"));
  assert.equal(dailyDecisionFingerprint(plain), dailyDecisionFingerprint(snapshot()));
});

test("a day that steps back withdraws the single along with the load", () => {
  // Recent underperformance turns the overload into a hold. `authorized_target`
  // falls back to the CURRENT target, and a near-maximal single must not outlive
  // the decision that authorized it.
  const snap = peakSnapshot();
  snap.feedback = { soreness: 4, performance: 2, joint_pain: null, low_performance_count: 2 };
  const candidate = squat(buildDailySessionDecision(snap, { now: NOW }));
  assert.notEqual(candidate.action, "overload", "the day stepped the lift back");
  assert.ok(!("top_set" in candidate), "so the peak protocol goes with it");
});

test("a deload day never authorizes a peak single", () => {
  const snap = peakSnapshot();
  snap.program = { ...snap.program, mesocycle_phase: "deload" };
  const candidate = squat(buildDailySessionDecision(snap, { now: NOW }));
  assert.equal(candidate.action, "deload");
  assert.ok(!("top_set" in candidate));
});

test("a malformed top set is simply no top set, never a zero-rep prescription", () => {
  for (const bad of [{ weight: 275 }, { weight: null, reps: 1 }, { weight: 275, reps: 0 }, {}]) {
    const candidate = squat(buildDailySessionDecision(peakSnapshot({ top_set: bad }), { now: NOW }));
    assert.ok(!("top_set" in candidate), `${JSON.stringify(bad)} describes no protocol`);
  }
});

test("the peak single never becomes a plan target — it rides the candidate only", () => {
  const envelope = buildDailySessionDecision(peakSnapshot(), { now: NOW });
  // The envelope's own plan-shaped surface (the authorized target) still carries
  // the back-off numbers, which is what any plan write would read.
  assert.equal(squat(envelope).authorized_target.target_weight, 225);
  assert.notEqual(squat(envelope).authorized_target.target_weight, PEAK_TOP_SET.weight);
});

function pushSupport(over = {}) {
  return {
    training_drive: "push",
    backed: true,
    backed_by: ["session_quality"],
    training_directive: "proceed",
    fresh_brake: false,
    ...over,
  };
}

test("a backed push morning reaches inside the session", () => {
  const env = buildDailySessionDecision(snapshot({ signal_support: pushSupport() }), { now: NOW });
  assert.equal(env.reach.level, "push");
  assert.deepEqual(env.reach.backed_by, ["session_quality"]);
  assert.ok(REACH_PUSH_WHY.includes(env.reach.why), `unexpected reach why ${JSON.stringify(env.reach.why)}`);
  assert.ok(env.precedence.includes("backed_day_reach"));
  assert.equal(env.caps.intensity, "normal", "reach is not a sixth intensity value");
  assert.equal(env.kind, "train");
});

test("hold_aggression keeps reach push and trims only the challenge", () => {
  const env = buildDailySessionDecision(
    snapshot({ signal_support: pushSupport({ training_directive: "hold_aggression" }) }),
    { now: NOW }
  );
  assert.equal(env.reach.level, "push");
  assert.ok(REACH_TRIMMED_WHY.includes(env.reach.why));
  assert.ok(env.precedence.includes("reach_trimmed_by_fueling"));
  assert.ok(!env.precedence.includes("backed_day_reach"));
});

test("a fresh brake withdraws reach", () => {
  const env = buildDailySessionDecision(
    snapshot({ signal_support: pushSupport({ fresh_brake: true }) }),
    { now: NOW }
  );
  assert.equal(env.reach.level, null);
  assert.equal(env.reach.why, "");
  assert.ok(!env.precedence.includes("backed_day_reach"));
});

test("drive off leaves reach null", () => {
  const env = buildDailySessionDecision(
    snapshot({ signal_support: pushSupport({ training_drive: "steady" }) }),
    { now: NOW }
  );
  assert.equal(env.reach.level, null);
});

test("an ordinary snapshot with no signal_support never reaches", () => {
  const env = buildDailySessionDecision(snapshot(), { now: NOW });
  assert.equal(env.reach.level, null);
  assert.deepEqual(env.reach.backed_by, []);
});

test("a saturated main lift group withdraws reach", () => {
  const env = buildDailySessionDecision(
    snapshot({
      signal_support: pushSupport(),
      muscle_load: [{ group: "quads", days_ago: 1, saturated: true, source: "strength" }],
    }),
    { now: NOW }
  );
  assert.equal(env.reach.level, null);
  assert.ok(env.precedence.includes("muscle_saturated"));
  assert.ok(env.muscles.saturated.includes("quads"));
});

test("a snapshot with no muscle group still licenses reach — composition refuses the host", () => {
  const env = buildDailySessionDecision(
    snapshot({
      signal_support: pushSupport(),
      plan_items: [{ exercise: "Mystery Lift", muscle_group: null, equipment: null, mode: "reps", kind: "strength" }],
    }),
    { now: NOW }
  );
  assert.equal(env.reach.level, "push", "missing group is not an envelope-level veto");
});

test("modify and recover directives never license a reach", () => {
  for (const training_directive of ["modify", "recover"]) {
    const env = buildDailySessionDecision(
      snapshot({ signal_support: pushSupport({ training_directive }) }),
      { now: NOW }
    );
    assert.equal(env.reach.level, null, training_directive);
  }
});

test("an easy or rest kind never reaches even when the day is backed", () => {
  const rest = buildDailySessionDecision(
    snapshot({
      signal_support: pushSupport(),
      day_read: {
        kind: "rest",
        focus: null,
        est_minutes: null,
        consecutive_training_days: 1,
        recovery_week: false,
        trained_today: false,
      },
    }),
    { now: NOW }
  );
  assert.equal(rest.kind, "rest");
  assert.equal(rest.reach.level, null);
});

test("reach why and notes hold the reading grammar", () => {
  for (const line of [
    ...REACH_PUSH_WHY,
    ...REACH_TRIMMED_WHY,
    ...REACH_NO_ROOM_WHY,
    ...REACH_TOP_SET_NOTES,
    ...REACH_AMRAP_NOTES,
  ]) {
    assert.equal(violatesReadingGrammar(line), null, line);
  }
});
