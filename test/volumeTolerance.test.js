// Volume: the plan's sets are the default, and tolerance is learned from the log (owner
// ruling, 2026-11-12). On a train read the sets come down only for a named, current
// reason; a standing preference never trims them; a precautionary trim stands down when
// the athlete's own recent sessions carried every planned set at a held-or-rising load;
// and nothing here ever adds a set past the bounds in volume-tolerance.ts.
// Synthetic fixtures only. Deterministic and offline (see test/run.mjs).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  buildDailySessionDecision,
  LOG_BACKS_FULL_SETS_DETAILS,
  LOG_BACKS_FULL_SETS_RATIONALE,
} from "../dist/repo/daily-decision.js";
import { deterministicComposedSession } from "../dist/repo/daily-composition.js";
import {
  habitualSetCount,
  perLiftSetCeiling,
  VOLUME_BOUNDS,
  volumeToleranceRead,
  weeklyGroupHasRoom,
} from "../dist/repo/volume-tolerance.js";
import { sessionCarriedPlannedVolume } from "../dist/repo/session-dose-log.js";
import { planDayProgression } from "../dist/repo/progression.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { db, localDaysAgo, repo, resetTables } from "./_seed.js";

const DATE = localDaysAgo(0);
const NOW = `${DATE}T12:00:00.000Z`;

beforeEach(() => {
  resetTables(
    "daily_session_outcomes",
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "plan_items",
    "plan_days",
    "exercises",
    "plan_proposals",
    "profile"
  );
});

// ---------- the envelope ----------

const UPPER = [
  ["Dumbbell Bench Press", "chest"],
  ["Chest-Supported Row", "back"],
  ["Dumbbell Shoulder Press", "shoulders"],
  ["Lat Pulldown", "lats"],
  ["Dumbbell Curl", "biceps"],
];

function seedUpperDay(sets = 4) {
  for (const [name, muscle_group] of UPPER) repo.upsertExercise({ name, muscle_group, mode: "reps" });
  repo.savePlanDay(
    1,
    "Upper",
    "Upper body",
    UPPER.map(([exercise]) => ({ exercise, sets, rep_low: 8, rep_high: 10, target_weight: 50 }))
  );
  return repo.getPlanDay(1);
}

function snapshot(overrides = {}) {
  return {
    date: DATE,
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    plan: {
      day_number: 1,
      focus: "Upper body",
      plan_day_id: overrides.plan_day_id ?? 1,
      day_type: "training",
      source: "adaptive",
      reason: null,
      due: [],
      over: [],
    },
    day_read: {
      kind: "train",
      focus: "Upper body",
      est_minutes: 60,
      consecutive_training_days: 1,
      recovery_week: false,
      trained_today: false,
    },
    recovery: { has_data: true, readiness: "high", hrv_drift: "flat", rhr_drift: "flat", sleep_drift: "flat" },
    recovery_cycle: null,
    muscle_load: [],
    endurance: [],
    checkin: null,
    feedback: null,
    constraints: { injuries: [], illness: false, travel: false },
    program: { mesocycle_phase: "accumulation", adaptations_due: [], volume_low_groups: [], volume_high_groups: [] },
    progression: [],
    plan_items: UPPER.map(([exercise, muscle_group]) => ({
      exercise,
      muscle_group,
      equipment: null,
      mode: "reps",
      kind: "strength",
      sets: 4,
    })),
    training_intent: {
      endurance_role: "supporting",
      priorities: ["strength", "muscle", "longevity"],
      source: "explicit",
    },
    ...overrides,
  };
}

const decide = (overrides) => buildDailySessionDecision(snapshot(overrides), { now: NOW });
const strengthSets = (session) => session.items.filter((item) => item.kind !== "cardio").map((item) => item.sets);

test("a plain train read with only a standing preference composes the plan's set counts", () => {
  const day = seedUpperDay(4);
  // Longevity leads and the days are stacked with no license: the old law read this as
  // "a calmer double-day dose" and trimmed every lift to three sets.
  const env = decide({
    plan_day_id: day.id,
    training_intent: {
      endurance_role: "supporting",
      priorities: ["longevity", "muscle", "strength"],
      source: "explicit",
    },
    day_read: { ...snapshot().day_read, consecutive_training_days: 3 },
  });
  assert.equal(env.kind, "train");
  assert.equal(env.caps.volume, "normal", "a preference never trims sets");
  assert.equal(env.caps.intensity, "hold", "the preference still holds the load");
  assert.ok(env.soft_preferences.some((p) => /Longevity-leading/.test(p.detail)));
  const session = deterministicComposedSession(env);
  assert.deepEqual(strengthSets(session), [4, 4, 4, 4, 4], "every lift keeps the plan's authored sets");

  // The same morning with a named, current reason (a low-recovery brake) still trims —
  // a brake on the board, not the readiness score alone (second review, item 2).
  const low = decide({
    plan_day_id: day.id,
    recovery: { has_data: true, readiness: "low", hrv_drift: "down", rhr_drift: "up", sleep_drift: "flat" },
    signal_support: {
      training_drive: "steady",
      backed: false,
      backed_by: [],
      training_directive: "proceed",
      fresh_brake: true,
    },
  });
  assert.equal(low.caps.volume, "reduced");
  assert.ok(strengthSets(deterministicComposedSession(low)).every((sets) => sets <= 3));
});

test("each named, current reason still reduces volume, even with the log vouching", () => {
  const vouched = { personal_response: { plan_complexity: 0.9 }, volume_tolerance: { sessions: 3 } };
  const brake = {
    training_drive: "steady",
    backed: false,
    backed_by: [],
    training_directive: "proceed",
    fresh_brake: true,
  };
  const cases = {
    "a fresh low-recovery brake": {
      recovery: { has_data: true, readiness: "low", hrv_drift: "down", rhr_drift: "up", sleep_drift: "flat" },
      // …a brake on the board beside the score (second review, item 2).
      signal_support: brake,
    },
    "soreness reported today": { checkin: { soreness: 5, energy: 3, sleep_feel: 3 } },
    "a recovery week": { day_read: { ...snapshot().day_read, recovery_week: true } },
    "an easy read": { day_read: { ...snapshot().day_read, kind: "easy" } },
    "train-anyway over a rest read with a brake": {
      day_read: { ...snapshot().day_read, kind: "rest" },
      request: { override: null, train_anyway: true, equipment: null, minutes: null, goal: null },
      signal_support: brake,
    },
    "a lift reopened after the run while a deciding brake stands": {
      day_read: { ...snapshot().day_read, kind: "rest" },
      lift_day_open: { after: "run" },
      signal_support: brake,
    },
    "the days after a race": {
      stress_budget: { race_recovery: { day_index: 2, days: 4, back_on: "2099-01-01", event: "Test Race" } },
    },
  };
  for (const [label, over] of Object.entries(cases)) {
    const env = decide({ ...vouched, ...over });
    assert.equal(env.caps.volume, "reduced", label);
    assert.ok(!env.precedence.includes("log_backs_full_sets"), `${label}: the log answers a precaution, never this`);
  }
});

test("the log answers a precautionary trim and says so; without it the learned ease stands", () => {
  const eased = decide({ personal_response: { plan_complexity: 0.9 } });
  assert.equal(eased.caps.volume, "reduced");
  assert.ok(eased.precedence.includes("personal_response_ease"));

  const answered = decide({ personal_response: { plan_complexity: 0.9 }, volume_tolerance: { sessions: 3 } });
  assert.equal(answered.caps.volume, "normal", "the plan's sets stand");
  assert.equal(answered.caps.intensity, "normal", "and nothing else moved");
  assert.ok(answered.precedence.includes("log_backs_full_sets"));
  assert.ok(!answered.precedence.includes("personal_response_ease"), "the trim it answered is not said");
  assert.ok(answered.soft_preferences.some((p) => p.code === "log_backs_full_sets"));
  const line = answered.rationale.find((r) => r.code === "log_backs_full_sets");
  assert.ok(line && LOG_BACKS_FULL_SETS_RATIONALE.includes(line.text), JSON.stringify(answered.rationale));
  assert.notEqual(answered.rationale[0].code, "log_backs_full_sets", "the day's own read keeps the headline");

  // With nothing to answer, the record changes nothing.
  const idle = decide({ volume_tolerance: { sessions: 3 } });
  assert.equal(idle.caps.volume, "normal");
  assert.ok(!idle.precedence.includes("log_backs_full_sets"));
});

test("every log-backs phrasing reads clean: no grammar breach, no number", () => {
  for (const text of [...LOG_BACKS_FULL_SETS_DETAILS, ...LOG_BACKS_FULL_SETS_RATIONALE]) {
    assert.equal(violatesReadingGrammar(text), null, text);
    assert.doesNotMatch(text, /\d/, text);
  }
  assert.ok(new Set(LOG_BACKS_FULL_SETS_RATIONALE).size >= 3);
});

// ---------- the log ----------

// A reconciled outcome row for one session, the shape daily-reconciliation writes.
function seedOutcome(date, doses, { skipped = [], constraints = null, provenance = null } = {}) {
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  const session = repo.getOrCreateSession(date, null);
  const composition = db
    .prepare(
      `INSERT INTO daily_session_compositions
        (version, session_id, date, source, status, plan_day_id, title, items_json, request_fingerprint, constraints_json, provenance_json)
       VALUES (1, ?, ?, 'athlete_override', 'active', NULL, 'Fixture', '[]', ?, ?, ?)`
    )
    .run(
      session.id,
      date,
      `vt-${date}`,
      constraints ? JSON.stringify(constraints) : null,
      provenance ? JSON.stringify(provenance) : null
    );
  const facts = {
    schema_version: 4,
    dose_context: { comparable: true, non_comparable_reasons: [] },
    dose_evidence: doses,
    skipped,
  };
  db.prepare(
    `INSERT INTO daily_session_outcomes (composition_id, session_id, date, status, facts_json)
     VALUES (?, ?, ?, 'completed', ?)`
  ).run(composition.lastInsertRowid, session.id, date, JSON.stringify(facts));
  return session.id;
}

// One lift's dose: `planned` sets prescribed at `target`, `done` sets landed at `top` for
// `reps` reps, against a recent working weight of `recent` (the full-load reference).
// `authored` is the plan item's own set count (the full-load reference), which a trimmed
// card's prescription can sit under.
function dose(
  exercise,
  { planned = 3, done = planned, target = 100, top = target, reps = 8, recent = target, authored = planned } = {}
) {
  return {
    exercise,
    prescribed: { sets: planned, rep_low: 6, rep_high: 8, target_weight: target, target_seconds: null },
    achieved: {
      sets: done,
      top_weight: top,
      top_reps: reps,
      top_seconds: null,
      sets_detail: Array.from({ length: done }, () => ({ weight: top, reps, duration_sec: null })),
    },
    comparable: true,
    non_comparable_reasons: [],
    challenge_verdict: "met",
    full_load_reference: {
      sets: authored,
      target_weight: target,
      target_seconds: null,
      rep_low: 6,
      recent_working_weight: recent,
      recent_working_seconds: null,
    },
  };
}

test("a log of met and exceeded sets at a held or rising load vouches; a falling load does not", () => {
  // Three sessions: one at the plan, one a set past it, one a step heavier than last time.
  seedOutcome(localDaysAgo(6), [dose("Dumbbell Bench Press"), dose("Chest-Supported Row")]);
  seedOutcome(localDaysAgo(4), [dose("Dumbbell Bench Press", { done: 4 }), dose("Chest-Supported Row")]);
  const rising = seedOutcome(localDaysAgo(2), [dose("Dumbbell Bench Press", { target: 105, top: 105, recent: 100 })]);
  assert.equal(sessionCarriedPlannedVolume(rising), true);
  const read = volumeToleranceRead(DATE);
  assert.deepEqual(read, { sessions: 3 });
  // …and that record is what answers the precautionary trim.
  const env = decide({ personal_response: { plan_complexity: 0.9 }, volume_tolerance: read });
  assert.equal(env.caps.volume, "normal");

  // The same log with one session's load slipping under the lift's own recent working
  // weight: a sustained performance decrease is the marker, so the record is withheld.
  resetTables("daily_session_outcomes", "daily_session_compositions", "sessions");
  seedOutcome(localDaysAgo(6), [dose("Dumbbell Bench Press"), dose("Chest-Supported Row")]);
  seedOutcome(localDaysAgo(4), [dose("Dumbbell Bench Press", { done: 4 }), dose("Chest-Supported Row")]);
  const falling = seedOutcome(localDaysAgo(2), [dose("Dumbbell Bench Press", { target: 90, top: 90, recent: 100 })]);
  assert.equal(sessionCarriedPlannedVolume(falling), false);
  assert.equal(volumeToleranceRead(DATE), null);
  const held = decide({ personal_response: { plan_complexity: 0.9 } });
  assert.equal(held.caps.volume, "reduced", "with no record the precaution stands");
});

test("a planned set left undone, a skipped lift, or too few sessions withhold the record", () => {
  seedOutcome(localDaysAgo(6), [dose("Dumbbell Bench Press")]);
  seedOutcome(localDaysAgo(4), [dose("Dumbbell Bench Press")]);
  assert.equal(volumeToleranceRead(DATE), null, "two sessions are not a pattern");
  const short = seedOutcome(localDaysAgo(2), [dose("Dumbbell Bench Press", { done: 2 })]);
  assert.equal(sessionCarriedPlannedVolume(short), false);
  assert.equal(volumeToleranceRead(DATE), null);

  resetTables("daily_session_outcomes", "daily_session_compositions", "sessions");
  seedOutcome(localDaysAgo(6), [dose("Dumbbell Bench Press")]);
  seedOutcome(localDaysAgo(4), [dose("Dumbbell Bench Press")]);
  const skipped = seedOutcome(localDaysAgo(2), [dose("Dumbbell Bench Press")], { skipped: ["Chest-Supported Row"] });
  assert.equal(sessionCarriedPlannedVolume(skipped), false);
  assert.equal(volumeToleranceRead(DATE), null);

  // Today's own session is never part of its own record.
  resetTables("daily_session_outcomes", "daily_session_compositions", "sessions");
  seedOutcome(localDaysAgo(4), [dose("Dumbbell Bench Press")]);
  seedOutcome(localDaysAgo(2), [dose("Dumbbell Bench Press")]);
  seedOutcome(DATE, [dose("Dumbbell Bench Press")]);
  assert.equal(volumeToleranceRead(DATE), null);
});

test("a trimmed card vouches only when the athlete logged the plan's AUTHORED sets — never its own trimmed count", () => {
  // The plan wrote four sets; the volume-reduced card prescribed three; the athlete
  // finished the three. That is not "every planned set", and three such sessions must not
  // cancel the trim they were composed under.
  const reduced = { daily_decision: { caps: { volume: "reduced", intensity: "hold" }, train_anyway: false } };
  const trimmed = (date) =>
    seedOutcome(date, [dose("Dumbbell Bench Press", { planned: 3, authored: 4 })], { constraints: reduced });
  trimmed(localDaysAgo(6));
  trimmed(localDaysAgo(4));
  const last = trimmed(localDaysAgo(2));
  assert.equal(sessionCarriedPlannedVolume(last), false, "the trimmed count is not the plan's");
  assert.equal(volumeToleranceRead(DATE), null, "a trimmed log never cancels its own trim");

  // The athlete logged the authored four on the trimmed card: that vouches.
  resetTables("daily_session_outcomes", "daily_session_compositions", "sessions");
  const full = seedOutcome(localDaysAgo(2), [dose("Dumbbell Bench Press", { planned: 3, done: 4, authored: 4 })], {
    constraints: reduced,
  });
  assert.equal(sessionCarriedPlannedVolume(full), true);

  // A train-anyway trimmed card with a lift whose authored count is unknown cannot vouch.
  resetTables("daily_session_outcomes", "daily_session_compositions", "sessions");
  const unknown = { ...dose("Dumbbell Bench Press"), full_load_reference: { ...dose("x").full_load_reference, sets: null } };
  const anyway = seedOutcome(localDaysAgo(2), [unknown], {
    constraints: { daily_decision: { caps: { volume: "normal", intensity: "hold" }, train_anyway: true } },
  });
  assert.equal(sessionCarriedPlannedVolume(anyway), false);

  // An ordinary card at the plan's own count still vouches exactly as before.
  resetTables("daily_session_outcomes", "daily_session_compositions", "sessions");
  const plain = seedOutcome(localDaysAgo(2), [dose("Dumbbell Bench Press", { planned: 4, authored: 4 })], {
    constraints: { daily_decision: { caps: { volume: "normal", intensity: "normal" }, train_anyway: false } },
  });
  assert.equal(sessionCarriedPlannedVolume(plain), true);
});

test("item 9: a card that deferred any plan-day lift never vouches, however the lifts left on it went", () => {
  // The day's budget deferred the curl; every lift left on the card landed its authored sets.
  const provenance = {
    daily_decision: { caps: { volume: "normal", intensity: "hold" }, train_anyway: false },
    plan_day_deferred: ["Dumbbell Curl"],
  };
  const carriedButDeferred = seedOutcome(localDaysAgo(2), [dose("Dumbbell Bench Press", { planned: 4, authored: 4 })], {
    provenance,
  });
  assert.equal(sessionCarriedPlannedVolume(carriedButDeferred), false, "the athlete did not carry the plan");
  // The same log with nothing deferred still vouches. (The composer's own record of the
  // deferral is pinned in test/planDayCompositionKeepsWork.test.js.)
  resetTables("daily_session_outcomes", "daily_session_compositions", "sessions");
  const carried = seedOutcome(localDaysAgo(2), [dose("Dumbbell Bench Press", { planned: 4, authored: 4 })], {
    provenance: { daily_decision: provenance.daily_decision },
  });
  assert.equal(sessionCarriedPlannedVolume(carried), true);
});

// ---------- the bounds ----------

test("the bounds live in one place: about 1.2x the habitual per-lift count, about 20 weekly sets a group", () => {
  assert.equal(VOLUME_BOUNDS.PER_LIFT_HABITUAL_FACTOR, 1.2);
  assert.equal(VOLUME_BOUNDS.WEEKLY_EFFECTIVE_SETS_PER_GROUP, 20);
  assert.equal(perLiftSetCeiling(3), 3);
  assert.equal(perLiftSetCeiling(4), 4);
  assert.equal(perLiftSetCeiling(5), 6);
  assert.equal(perLiftSetCeiling(10), 12);
  assert.equal(habitualSetCount([4, 5]), 4.5);
  assert.equal(habitualSetCount([3, 4, 6]), 4);
  assert.equal(habitualSetCount([]), null);
  assert.equal(weeklyGroupHasRoom(19, 1), true);
  assert.equal(weeklyGroupHasRoom(19.5, 1), false);
  assert.equal(weeklyGroupHasRoom(20, 1), false);
  assert.equal(weeklyGroupHasRoom(null, 1), true, "an unreadable week is not a reason to refuse");
});

// The set catch-up (progression.ts setCatchUp): the plan's count stepping toward the log.
function logSets(name, date, sets) {
  const ex = repo.findExercise(name);
  const session = repo.getOrCreateSession(date, null);
  sets.forEach(([weight, reps], i) => {
    db.prepare(
      `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, ?, ?, ?, NULL)`
    ).run(session.id, ex.id, i + 1, weight, reps);
  });
}

function seedCurlWeek(otherBicepsSets) {
  for (const [name, group] of [
    ["Dumbbell Curl", "biceps"],
    ["Hammer Curl", "biceps"],
    ["Cable Curl", "biceps"],
    ["Preacher Curl", "biceps"],
  ])
    repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  repo.savePlanDay(1, "Arms", null, [
    { exercise: "Dumbbell Curl", sets: 2, rep_low: 10, rep_high: 12, target_weight: 40 },
  ]);
  const others = ["Hammer Curl", "Cable Curl", "Preacher Curl"];
  repo.savePlanDay(
    2,
    "Arms B",
    null,
    others.map((exercise, i) => ({
      exercise,
      sets: Math.floor(otherBicepsSets / 3) + (i < otherBicepsSets % 3 ? 1 : 0),
      rep_low: 10,
      rep_high: 12,
      target_weight: 30,
    }))
  );
  db.prepare(`UPDATE plan_items SET prescribed_at = NULL`).run();
  for (const back of [9, 5])
    logSets("Dumbbell Curl", localDaysAgo(back), [
      [40, 11],
      [40, 11],
      [40, 11],
    ]);
}

const curlStep = () =>
  planDayProgression(1, { forNextSession: true }).find((p) => p.exercise === "Dumbbell Curl")?.set_step;

test("the set catch-up stops at about 20 weekly sets for the group", () => {
  seedCurlWeek(15);
  assert.deepEqual(curlStep(), { from: 2, to: 3 }, "17 planned biceps sets: room for one more");
  resetTables("logged_sets", "sessions", "plan_items", "plan_days", "exercises");
  seedCurlWeek(18);
  assert.equal(curlStep(), undefined, "20 planned biceps sets: the week is full");
});

test("the 1.2x per-lift bound reads the athlete's habit from the weeks BEFORE the exposures it answers", () => {
  // Weeks of two-set curls, then two recent exposures of three: 1.2 x 2 is 2, so the
  // plan does not step to three on the strength of the very exposures it would follow.
  seedCurlWeek(6);
  for (const back of [40, 33, 26, 19])
    logSets("Dumbbell Curl", localDaysAgo(back), [
      [40, 11],
      [40, 11],
    ]);
  assert.equal(curlStep(), undefined, "a habit of two sets bounds the catch-up at two");

  // A habit of three sets in those weeks: 1.2 x 3 is 3, so the step to three is in bounds.
  resetTables("logged_sets", "sessions", "plan_items", "plan_days", "exercises");
  seedCurlWeek(6);
  for (const back of [40, 33, 26, 19])
    logSets("Dumbbell Curl", localDaysAgo(back), [
      [40, 11],
      [40, 11],
      [40, 11],
    ]);
  assert.deepEqual(curlStep(), { from: 2, to: 3 });
});

test("an affirmed cut never adds sets beyond the plan", () => {
  seedCurlWeek(6);
  assert.deepEqual(curlStep(), { from: 2, to: 3 }, "the fixture steps outside a cut");
  repo.setProfile({ goal_mode: "lose", weight_lb: 200, goal_weight_lb: 180 });
  assert.equal(curlStep(), undefined, "inside an affirmed cut the plan's count holds");
});
