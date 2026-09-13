import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { normalizeSessionSuggestionResult } from "../dist/agent-contracts.js";
import { buildSessionPrompt } from "../dist/prompt.js";
import { normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { isoDaysAgo, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "logged_sets",
    "session_skips",
    "sessions",
    "plan_items",
    "plan_days",
    "exercises",
    "activities"
  );
});

function suggestion(items, extra = {}) {
  return {
    name: "Pull — re-test",
    focus: "back",
    why: "A heavier look, then the work.",
    est_minutes: 40,
    items,
    ...extra,
  };
}

function envelope(overrides = {}) {
  return {
    policy_version: "daily_decision_v2",
    input_fingerprint: "test-fp",
    generated_at: "2031-01-01T00:00:00.000Z",
    date: "2031-07-01",
    kind: "train",
    baseline_kind: "train",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: { day_number: null, plan_day_id: null, focus: "Pull", intent: "custom" },
    muscles: { required: [], allowed: [], reduced: [], excluded: [] },
    caps: { volume: "normal", intensity: "normal", duration_min: 60 },
    candidates: [],
    hard_constraints: [],
    protective_exclusions: [],
    soft_preferences: [],
    rationale: [{ code: "template_rotation", text: "Training day." }],
    precedence: [],
    recovery_cycle: null,
    reach: { level: "none" },
    ...overrides,
  };
}

test("the session-suggest prompt asks for one item per exercise with top_set", () => {
  const prompt = buildSessionPrompt(undefined, {});
  assert.match(
    prompt,
    /One item per exercise\. A heavier top set \/ re-test before back-off work belongs in that item's `top_set`, never as a second item/
  );
  assert.match(prompt, /"top_set":/);
});

test("two consecutive same-lift rows fold into one item with top_set", () => {
  const result = normalizeSessionSuggestionResult(
    suggestion([
      {
        exercise: "Barbell Bent-Over Row",
        sets: 1,
        rep_low: 3,
        rep_high: 3,
        note: "warm up in 3–4 steps, then one strong triple at RIR 1–2",
      },
      { exercise: "Barbell Bent-Over Row", sets: 2, rep_low: 6, rep_high: 6 },
    ]),
    { foldTopSets: true }
  );
  assert.ok(result);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.exercise, "Barbell Bent-Over Row");
  assert.equal(item.sets, 2);
  assert.equal(item.rep_low, 6);
  assert.equal(item.rep_high, 6);
  assert.equal(item.top_set.sets, 1);
  assert.equal(item.top_set.reps, 3);
  assert.match(item.top_set.note, /warm up in 3–4 steps/);
});

test("non-adjacent same-name rows, or timed vs reps, are not folded", () => {
  const split = normalizeSessionSuggestionResult(
    suggestion([
      { exercise: "Barbell Bent-Over Row", sets: 1, rep_low: 3, rep_high: 3 },
      { exercise: "Lat Pulldown", sets: 3, rep_low: 8, rep_high: 10 },
      { exercise: "Barbell Bent-Over Row", sets: 2, rep_low: 6, rep_high: 6 },
    ]),
    { foldTopSets: true }
  );
  assert.ok(split);
  assert.equal(split.items.length, 3, "a different lift in between keeps both row slots");

  const mixed = normalizeSessionSuggestionResult(
    suggestion([
      { exercise: "Barbell Bent-Over Row", mode: "timed", sets: 1, target_seconds: 30 },
      { exercise: "Barbell Bent-Over Row", sets: 2, rep_low: 6, rep_high: 6 },
    ]),
    { foldTopSets: true }
  );
  assert.ok(mixed);
  assert.equal(mixed.items.length, 2, "timed vs reps is a different movement, not a top set");
});

test("fold is opt-in; without foldTopSets two same-lift rows stay two rows", () => {
  const result = normalizeSessionSuggestionResult(
    suggestion([
      { exercise: "Barbell Bent-Over Row", sets: 1, rep_low: 3, rep_high: 3 },
      { exercise: "Barbell Bent-Over Row", sets: 2, rep_low: 6, rep_high: 6 },
    ])
  );
  assert.ok(result);
  assert.equal(result.items.length, 2, "composition-style normalize must not fold a heavy single into top_set");
});

test("fold requires the first row to be heavier, not merely fewer reps", () => {
  repo.upsertExercise({ name: "Barbell Bent-Over Row", muscle_group: "back", mode: "reps" });
  repo.upsertExercise({ name: "Neutral-Grip Pull-Up", muscle_group: "back", mode: "reps" });
  repo.logSetByName({
    date: isoDaysAgo(1),
    exercise: "Barbell Bent-Over Row",
    weight: 185,
    reps: 3,
    rir: 2,
  });

  const lighterFirst = normalizeSessionSuggestionResult(
    suggestion([
      { exercise: "Barbell Bent-Over Row", sets: 2, rep_low: 8, rep_high: 8, target_weight: 135 },
      { exercise: "Barbell Bent-Over Row", sets: 3, rep_low: 10, rep_high: 10, target_weight: 185 },
    ]),
    { foldTopSets: true }
  );
  assert.ok(lighterFirst);
  assert.equal(lighterFirst.items.length, 2, "2×8 @135 then 3×10 @185 is not a top set");

  const heavierFirst = normalizeSessionSuggestionResult(
    suggestion([
      { exercise: "Barbell Bent-Over Row", sets: 1, rep_low: 3, rep_high: 3, target_weight: 185 },
      { exercise: "Barbell Bent-Over Row", sets: 3, rep_low: 8, rep_high: 8, target_weight: 135 },
    ]),
    { foldTopSets: true }
  );
  assert.ok(heavierFirst);
  assert.equal(heavierFirst.items.length, 1);
  assert.equal(heavierFirst.items[0].top_set.target_weight, 185);
  assert.equal(heavierFirst.items[0].target_weight, 135);

  const nullThenLoaded = normalizeSessionSuggestionResult(
    suggestion([
      { exercise: "Barbell Bent-Over Row", sets: 1, rep_low: 3, rep_high: 3, target_weight: null },
      { exercise: "Barbell Bent-Over Row", sets: 3, rep_low: 8, rep_high: 8, target_weight: 135 },
    ]),
    { foldTopSets: true }
  );
  assert.ok(nullThenLoaded);
  assert.equal(nullThenLoaded.items.length, 2, "a null-load top set over a numbered backoff does not fold");

  const highRepBw = normalizeSessionSuggestionResult(
    suggestion([
      { exercise: "Neutral-Grip Pull-Up", sets: 2, rep_low: 8, rep_high: 8 },
      { exercise: "Neutral-Grip Pull-Up", sets: 3, rep_low: 10, rep_high: 10 },
    ]),
    { foldTopSets: true }
  );
  assert.ok(highRepBw);
  assert.equal(highRepBw.items.length, 2, "bodyweight fold needs a low-rep first row (rep_high ≤ 5)");
});

test("load_basis: open for an unanchored barbell, BW for a pull-up, assisted, loaded", () => {
  repo.upsertExercise({ name: "Barbell Bent-Over Row", muscle_group: "back", mode: "reps" });
  repo.upsertExercise({ name: "Neutral-Grip Pull-Up", muscle_group: "back", mode: "reps" });
  repo.upsertExercise({ name: "Assisted Dip", muscle_group: "chest", mode: "reps" });
  repo.logSetByName({
    date: isoDaysAgo(1),
    exercise: "Barbell Bent-Over Row",
    weight: 115,
    reps: 6,
    rir: 2,
  });
  repo.logSetByName({
    date: isoDaysAgo(1),
    exercise: "Assisted Dip",
    weight: -30,
    reps: 8,
    rir: 2,
  });

  const open = normalizeSessionSuggestionResult(
    suggestion([{ exercise: "Barbell Bent-Over Row", sets: 3, rep_low: 6, rep_high: 8, target_weight: null }])
  );
  assert.equal(open.items[0].load_basis, "open");
  assert.equal(open.items[0].target_weight, null);

  const bw = normalizeSessionSuggestionResult(
    suggestion([{ exercise: "Neutral-Grip Pull-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: null }])
  );
  assert.equal(bw.items[0].load_basis, "bodyweight");

  const assisted = normalizeSessionSuggestionResult(
    suggestion([{ exercise: "Assisted Dip", sets: 3, rep_low: 8, rep_high: 10, target_weight: -30 }])
  );
  assert.equal(assisted.items[0].load_basis, "assisted");
  assert.equal(assisted.items[0].target_weight, -30);

  const loaded = normalizeSessionSuggestionResult(
    suggestion([{ exercise: "Barbell Bent-Over Row", sets: 3, rep_low: 6, rep_high: 8, target_weight: 115 }])
  );
  assert.equal(loaded.items[0].load_basis, "loaded");
  assert.equal(loaded.items[0].target_weight, 115);
});

test("accepting a nested top_set expands into two same-name cards and does not double a peak insert", () => {
  repo.upsertExercise({ name: "Barbell Bent-Over Row", muscle_group: "back", mode: "reps" });
  repo.logSetByName({
    date: isoDaysAgo(1),
    exercise: "Barbell Bent-Over Row",
    weight: 135,
    reps: 6,
    rir: 2,
  });
  const session = suggestion([
    {
      exercise: "Barbell Bent-Over Row",
      sets: 2,
      rep_low: 6,
      rep_high: 6,
      target_weight: 135,
      top_set: {
        sets: 1,
        reps: 3,
        target_weight: 145,
        note: "warm up in 3–4 steps, then one strong triple at RIR 1–2",
      },
    },
  ]);
  const { session: composed } = normalizeComposedSession(session, envelope());
  assert.ok(composed);
  assert.equal(composed.items.length, 2);
  assert.equal(composed.items[0].exercise, "Barbell Bent-Over Row");
  assert.equal(composed.items[1].exercise, "Barbell Bent-Over Row");
  assert.equal(composed.items[0].sets, 1);
  assert.equal(composed.items[0].rep_low, 3);
  assert.equal(composed.items[0].rep_high, 3);
  assert.equal(composed.items[1].sets, 2);
  assert.equal(composed.items[1].rep_low, 6);
  assert.ok(!composed.items[0].top_set);
  assert.ok(!composed.items[1].top_set);

  const peaked = normalizeComposedSession(
    session,
    envelope({
      candidates: [
        {
          exercise: "Barbell Bent-Over Row",
          muscle_group: "back",
          action: "overload",
          reason_code: null,
          substitution_for: null,
          note: null,
          current_target: {
            mode: "reps",
            sets: 2,
            rep_low: 6,
            rep_high: 6,
            target_weight: 135,
            target_seconds: null,
          },
          authorized_target: {
            mode: "reps",
            sets: 2,
            rep_low: 6,
            rep_high: 6,
            target_weight: 135,
            target_seconds: null,
          },
          top_set: { weight: 185, reps: 1 },
        },
      ],
    })
  ).session;
  assert.equal(peaked.items.length, 2, "peak insertion is skipped when the item already carries top_set");
  assert.equal(peaked.items[0].rep_low, 3, "the agent top set wins, not the envelope single");
});
