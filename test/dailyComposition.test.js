import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { composeDailySession } from "../dist/coachOps.js";
import {
  deterministicComposedSession,
  EASED_TODAY_NOTES,
  HOLD_TARGET_NOTES,
  normalizeComposedSession,
  REDUCED_AREA_NOTES,
} from "../dist/repo/daily-composition.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import { KEY_RUN_EVE_ITEM_NOTES, RACE_TAPER_ITEM_NOTES } from "../dist/repo/stress-budget.js";
import { REACH_NO_ROOM_WHY } from "../dist/repo/daily-decision.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-07-01";
const DESCRIPTIVE_TEMPO_NOTE =
  "Continuous tempo at Z3. Hold a controlled effort throughout and finish with relaxed strides.";

beforeEach(() => {
  resetTables(
    "daily_session_decisions",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "day_reads",
    "plan_items",
    "plan_days",
    "exercises",
    "context_events",
    "checkins",
    "activities"
  );
});

function envelope(overrides = {}) {
  return {
    policy_version: "daily_decision_v2",
    input_fingerprint: "test-fp",
    generated_at: "2031-01-01T00:00:00.000Z",
    date: DATE,
    kind: "train",
    baseline_kind: "train",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: { day_number: null, plan_day_id: null, focus: "Lower body", intent: "custom" },
    muscles: { required: [], allowed: [], reduced: [], excluded: [] },
    caps: { volume: "normal", intensity: "normal", duration_min: 60 },
    candidates: [],
    hard_constraints: [],
    soft_preferences: [],
    rationale: [{ code: "template_rotation", text: "Training day." }],
    precedence: [],
    ...overrides,
  };
}

function agentSession(items, extra = {}) {
  return {
    name: "Composed session",
    focus: "Lower body",
    why: "Fits the envelope today.",
    est_minutes: 55,
    items,
    ...extra,
  };
}

test("an item loading an excluded group is dropped", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
    ]),
    envelope({ muscles: { required: [], allowed: [], reduced: [], excluded: ["quads"] } })
  );
  assert.ok(session);
  const names = session.items.map((i) => i.exercise);
  assert.ok(!names.includes("Back Squat"));
  assert.ok(names.includes("Bench Press"));
  assert.ok(validation.rejected.some((r) => r.exercise === "Back Squat" && r.reason === "excluded_group"));
});

test("a composed session is already in effect order", () => {
  // Tiers only: prep → primary → isolation. Isolation peers keep the agent's
  // relative order, so Cable Curl (listed first) stays ahead of Leg Extension.
  repo.upsertExercise({ name: "Ankle Rocker", muscle_group: "mobility", mode: "reps" });
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Leg Extension", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Cable Curl", muscle_group: "biceps", mode: "reps" });
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Cable Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 30 },
      { exercise: "Leg Extension", sets: 3, rep_low: 12, rep_high: 12, target_weight: 100 },
      { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
      { exercise: "Ankle Rocker", sets: 2, rep_low: 10, rep_high: 10 },
    ]),
    envelope()
  );
  assert.deepEqual(
    session.items.map((item) => item.exercise),
    ["Ankle Rocker", "Back Squat", "Cable Curl", "Leg Extension"]
  );
});

test("at most one novel movement is admitted, with no precise load and a baseline label", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
      { exercise: "Zercher Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
      { exercise: "Jefferson Deadlift", sets: 3, rep_low: 5, rep_high: 5, target_weight: 205 },
    ]),
    envelope()
  );
  assert.ok(session);
  assert.equal(validation.novel_introduced, 1);
  const names = session.items.map((i) => i.exercise);
  assert.ok(names.includes("Zercher Squat"));
  assert.ok(!names.includes("Jefferson Deadlift"));
  assert.ok(validation.rejected.some((r) => r.reason === "extra_novel_movement"));
  const novel = session.items.find((i) => i.exercise === "Zercher Squat");
  assert.equal(novel.target_weight, null);
  assert.match(novel.note, /baseline/i);
});

test("a novel movement is refused entirely when the envelope has any excluded group (canon items kept)", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
      { exercise: "Zercher Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
    ]),
    // quads excluded — a novel (unknown muscle_group) movement cannot be verified to
    // avoid it, so it is dropped even though it would otherwise be the one allowed novel.
    envelope({ muscles: { required: [], allowed: [], reduced: [], excluded: ["quads"] } })
  );
  assert.ok(session);
  const names = session.items.map((i) => i.exercise);
  assert.ok(names.includes("Bench Press"), "the known-canon item is kept");
  assert.ok(!names.includes("Zercher Squat"), "the novel item is refused under exclusions");
  assert.equal(validation.novel_introduced, 0);
  assert.ok(validation.rejected.some((r) => r.exercise === "Zercher Squat" && r.reason === "novel_blocked_by_exclusions"));
});

test("a novel movement is still admitted when the envelope has NO exclusions", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
      { exercise: "Zercher Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
    ]),
    envelope() // no excluded groups
  );
  assert.ok(session);
  assert.equal(validation.novel_introduced, 1);
  assert.ok(session.items.some((i) => i.exercise === "Zercher Squat"));
});

test("caps clamp item count and duration", () => {
  for (const n of ["A", "B", "C", "D", "E", "F"]) {
    repo.upsertExercise({ name: `Move ${n}`, muscle_group: "chest", mode: "reps" });
  }
  repo.savePlanDay(
    1,
    "Cap anchors",
    "Known targets",
    ["A", "B", "C", "D", "E", "F"].map((n) => ({
      exercise: `Move ${n}`,
      sets: 3,
      rep_low: 8,
      rep_high: 10,
      target_weight: 50,
    }))
  );
  const { session, validation } = normalizeComposedSession(
    agentSession(
      ["A", "B", "C", "D", "E", "F"].map((n) => ({
        exercise: `Move ${n}`,
        sets: 3,
        rep_low: 8,
        rep_high: 10,
        target_weight: 50,
      })),
      { est_minutes: 90 }
    ),
    envelope({ caps: { volume: "minimal", intensity: "easy", duration_min: 30 } })
  );
  assert.ok(session);
  assert.ok(session.items.length <= 4);
  assert.ok(session.items.every((item) => item.sets <= 2), "minimal volume changes per-item sets");
  assert.ok(session.items.every((item) => item.target_weight === 40), "easy intensity changes known loads");
  assert.equal(session.est_minutes, 30);
  assert.equal(validation.capped, true);
});

test("easy intensity shortens a known timed prescription", () => {
  repo.upsertExercise({ name: "Front Plank", muscle_group: "core", mode: "timed" });
  repo.savePlanDay(1, "Core", "Known timed target", [
    { exercise: "Front Plank", sets: 3, target_seconds: 60, mode: "timed" },
  ]);
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Front Plank", sets: 3, target_seconds: 60, mode: "timed" },
    ]),
    envelope({ caps: { volume: "reduced", intensity: "easy", duration_min: 30 } })
  );
  assert.ok(session);
  assert.equal(session.items[0].target_seconds, 48);
  assert.equal(validation.capped, true);
});

test("easy caps preserve negative assisted loads rather than making the exercise harder", () => {
  repo.upsertExercise({ name: "Assisted Pull-Up", muscle_group: "back", mode: "reps" });
  repo.savePlanDay(1, "Pull", "Assistance anchor", [
    { exercise: "Assisted Pull-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -30 },
  ]);
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Assisted Pull-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -30 }]),
    envelope({ caps: { volume: "reduced", intensity: "easy", duration_min: 30 } })
  );
  assert.equal(session.items[0].target_weight, -30);
});

test("recognized dumbbells-only capability rejects barbell work and keeps the compatible movement", () => {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "DB Row", muscle_group: "back", mode: "reps" });
  db.prepare(`UPDATE exercises SET equipment = 'barbell' WHERE name = 'Barbell Bench Press'`).run();
  db.prepare(`UPDATE exercises SET equipment = 'dumbbells' WHERE name = 'DB Row'`).run();
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
      { exercise: "DB Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: null },
    ]),
    envelope({
      request: { override: null, train_anyway: false, equipment: "dumbbells only", minutes: null, goal: null },
    })
  );
  assert.deepEqual(session.items.map((item) => item.exercise), ["DB Row"]);
  assert.equal(session.items[0].target_weight, null, "the compatible fallback never invents load");
  assert.ok(validation.rejected.some((item) => item.exercise === "Barbell Bench Press" && item.reason === "equipment_incompatible"));
});

test("explicit exercise equipment outranks ambiguous movement-name heuristics", () => {
  repo.upsertExercise({ name: "DB Hip Thrust", muscle_group: "glutes", mode: "reps" });
  db.prepare(`UPDATE exercises SET equipment = 'dumbbells' WHERE name = 'DB Hip Thrust'`).run();
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "DB Hip Thrust", sets: 3, rep_low: 8, rep_high: 10, target_weight: null },
    ]),
    envelope({
      request: { override: null, train_anyway: false, equipment: "dumbbells only", minutes: null, goal: null },
    })
  );
  assert.equal(validation.ok, true);
  assert.deepEqual(session.items.map((item) => item.exercise), ["DB Hip Thrust"]);
});

test("rest envelopes reject uncapped strength unless train_anyway is server-owned", () => {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  const restEnvelope = envelope({
    kind: "rest",
    baseline_kind: "rest",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    caps: { volume: "minimal", intensity: "easy", duration_min: 20 },
  });
  const blocked = normalizeComposedSession(
    agentSession([{ exercise: "Barbell Bench Press", sets: 6, rep_low: 3, rep_high: 5, target_weight: 155 }]),
    restEnvelope
  );
  assert.equal(blocked.session, null);
  assert.ok(blocked.validation.rejected.some((item) => item.reason === "rest_requires_train_anyway"));
});

test("rest envelopes reject cardio too and the deterministic composition is itemless", () => {
  const restEnvelope = envelope({
    kind: "rest",
    baseline_kind: "rest",
    request: { override: null, train_anyway: false, equipment: null, minutes: null, goal: null },
    template: { day_number: null, plan_day_id: null, focus: "Recovery", intent: "custom" },
    caps: { volume: "minimal", intensity: "easy", duration_min: 20 },
  });
  const blocked = normalizeComposedSession(
    agentSession([
      {
        kind: "cardio",
        exercise: "VO2 max intervals",
        target_duration_min: 45,
        target_distance_km: 8,
        target_zone: "Z5",
        interval: { repeats: 8, work_sec: 120, rest_sec: 60 },
        note: "All-out repeats",
      },
    ]),
    restEnvelope
  );
  assert.equal(blocked.session, null);
  assert.equal(blocked.validation.reason, "rest_requires_train_anyway");
  assert.deepEqual(deterministicComposedSession(restEnvelope).items, []);
});

test("easy and explicit train-anyway envelopes remove hard-cardio directives", () => {
  const hardCardio = agentSession(
    [
      {
        kind: "cardio",
        exercise: "VO2 max run intervals",
        target_duration_min: 60,
        target_distance_km: 12,
        target_zone: "Z5",
        interval: { repeats: 8, work_sec: 180, rest_sec: 90 },
        note: "Push every repeat hard at race pace",
      },
    ],
    {
      name: "Hard interval session",
      focus: "Threshold speed",
      why: "Push VO2 max with all-out repeats.",
    }
  );
  for (const decision of [
    envelope({ caps: { volume: "reduced", intensity: "easy", duration_min: 20 } }),
    envelope({ caps: { volume: "reduced", intensity: "deload", duration_min: 25 } }),
    envelope({
      baseline_kind: "rest",
      request: { override: null, train_anyway: true, equipment: null, minutes: null, goal: null },
      caps: { volume: "reduced", intensity: "normal", duration_min: 30 },
    }),
  ]) {
    const { session, validation } = normalizeComposedSession(hardCardio, decision);
    assert.ok(session);
    assert.equal(session.est_minutes, decision.caps.duration_min);
    assert.equal(session.items[0].exercise, "Easy run");
    assert.equal(session.items[0].target_duration_min, decision.caps.duration_min);
    assert.equal(session.items[0].target_distance_km, null);
    assert.equal(session.items[0].target_zone, "easy");
    assert.equal(session.items[0].interval, null);
    assert.equal(session.items[0].note, "Easy conversational effort; no intervals today");
    assert.equal(session.name, "Easy session");
    assert.equal(session.focus, "Easy movement");
    assert.equal(session.why, decision.rationale[0].text);
    assert.equal(validation.capped, true);
  }
});

test("hold candidates clamp positive, assisted, bodyweight, and timed targets to exact anchors", () => {
  repo.savePlanDay(1, "Hold anchors", "No progression today", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
    { exercise: "Assisted Pull-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -30 },
    { exercise: "Push-Up", sets: 3, rep_low: 8, rep_high: 12, target_weight: null },
    { exercise: "Front Plank", sets: 3, target_seconds: 60, mode: "timed" },
  ]);
  const candidates = ["Bench Press", "Assisted Pull-Up", "Push-Up", "Front Plank"].map((exercise) => ({
    exercise,
    muscle_group: null,
    action: "hold",
    reason_code: "progression_hold",
    substitution_for: null,
    note: null,
  }));
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 110 },
      { exercise: "Assisted Pull-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -20 },
      { exercise: "Push-Up", sets: 3, rep_low: 8, rep_high: 12, target_weight: 25 },
      { exercise: "Front Plank", sets: 3, target_seconds: 70, mode: "timed" },
    ]),
    envelope({
      template: { day_number: 1, plan_day_id: repo.getPlanDay(1).id, focus: "Hold anchors", intent: "template" },
      candidates,
    })
  );
  assert.ok(session);
  const byExercise = new Map(session.items.map((item) => [item.exercise, item]));
  assert.equal(byExercise.get("Bench Press").target_weight, 100);
  assert.equal(byExercise.get("Assisted Pull-Up").target_weight, -30);
  assert.equal(byExercise.get("Push-Up").target_weight, null);
  assert.equal(byExercise.get("Front Plank").target_weight, null);
  assert.equal(byExercise.get("Front Plank").target_seconds, 60);
  assert.ok(
    session.items.every((item) => HOLD_TARGET_NOTES.includes(item.note)),
    "a hold with no existing why still gets one rotated hold sentence"
  );
  assert.equal(validation.capped, true);
});

test("a saturated-group stand-in's own logged working weight is exempt from the hold clamp", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Cable Row", muscle_group: "back", mode: "reps" });
  repo.savePlanDay(2, "Pull", "Back", [
    { exercise: "Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 120 },
  ]);
  repo.logSetByName({ date: "2031-06-20", exercise: "Cable Row", weight: 135, reps: 10, day_number: null });

  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 }]),
    envelope({
      caps: { volume: "normal", intensity: "hold", duration_min: 60 },
      muscles: { required: [], allowed: ["back"], reduced: [], excluded: [], saturated: ["quads"] },
    }),
    { substituteSaturated: true }
  );
  assert.ok(session);
  const item = session.items[0];
  assert.equal(item.exercise, "Cable Row");
  assert.equal(item.target_weight, 135, "the stand-in keeps its own logged working weight, unclamped");
});

test("a saturated-group stand-in that falls back to its plan target goes through the normal hold clamp", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Cable Row", muscle_group: "back", mode: "reps" });
  repo.savePlanDay(2, "Pull", "Back", [
    { exercise: "Cable Row", sets: 3, rep_low: 8, rep_high: 12, target_weight: 120 },
  ]);
  // No logged set for Cable Row anywhere — its load can only come from the plan
  // target, which is a number nobody has proven on this movement.

  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 }]),
    envelope({
      caps: { volume: "normal", intensity: "hold", duration_min: 60 },
      muscles: { required: [], allowed: ["back"], reduced: [], excluded: [], saturated: ["quads"] },
    }),
    { substituteSaturated: true }
  );
  assert.ok(session);
  const item = session.items[0];
  assert.equal(item.exercise, "Cable Row");
  assert.equal(
    item.target_weight,
    null,
    "an unproven plan-target load is cleared by the ordinary hold clamp rather than shipped"
  );
});

test("a group saturated by prior LIFTING (no run, no endurance conflict) still substitutes", () => {
  // Ruling (CLAUDE.md / ARCHITECTURE.md): substitutionGroups reads muscles.saturated
  // whatever put the work there. acuteGate is the one "is this muscle recovering"
  // question, and it does not ask what loaded the muscle — so neither does this law.
  repo.upsertExercise({ name: "Leg Press", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Face Pull", muscle_group: "shoulders", mode: "reps" });
  repo.savePlanDay(2, "Shoulders", "Rear delts", [
    { exercise: "Face Pull", sets: 3, rep_low: 12, rep_high: 15, target_weight: 40 },
  ]);

  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Leg Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 300 }]),
    envelope({
      // No endurance_lower_conflict in precedence/soft_preferences: the quads read
      // saturated purely because a lifting session loaded them, not a run.
      muscles: { required: [], allowed: ["shoulders"], reduced: [], excluded: [], saturated: ["quads"] },
    }),
    { substituteSaturated: true }
  );
  assert.ok(session);
  assert.equal(
    session.items[0].exercise,
    "Face Pull",
    "a lifting-caused saturation substitutes exactly like a run-caused one"
  );
  assert.equal(session.items[0].substitution_for, "Leg Press");
});

// "Allowed" is not "fresh". The morning after Push, chest is still carrying the
// bench work, so a saturated-back Pull card must not reach for a chest press — the
// live card opened with bench and carries the day after Push.
test("the day after Push, a saturated-back Pull card never takes a chest press", () => {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Pendlay Row", muscle_group: "back", mode: "reps" });
  repo.upsertExercise({ name: "Face Pull", muscle_group: "shoulders", mode: "reps" });
  repo.savePlanDay(1, "Push", "Push", [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 12 }]);
  repo.savePlanDay(2, "Pull", "Pull", [{ exercise: "Pendlay Row", sets: 3, rep_low: 8, rep_high: 10 }]);
  repo.savePlanDay(3, "Shoulders", "Shoulders", [{ exercise: "Face Pull", sets: 3, rep_low: 12, rep_high: 15 }]);
  for (let i = 0; i < 3; i++)
    repo.logSetByName({ date: "2031-06-30", exercise: "Barbell Bench Press", weight: 115, reps: 10, day_number: null });

  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Pendlay Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 145 }]),
    envelope({
      muscles: { required: [], allowed: ["chest", "shoulders"], reduced: [], excluded: [], saturated: ["back"] },
    }),
    { substituteSaturated: true }
  );
  assert.ok(session);
  const names = session.items.map((item) => item.exercise);
  assert.ok(!names.includes("Barbell Bench Press"), `yesterday's chest is not today's stand-in (${JSON.stringify(names)})`);
  assert.equal(session.items[0].exercise, "Face Pull");
});

test("an isolation slot takes an upper isolation stand-in, never a squat", () => {
  repo.upsertExercise({ name: "Cable Overhead Triceps Extension", muscle_group: "triceps", mode: "reps" });
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Rope Hammer Curl", muscle_group: "biceps", mode: "reps" });
  repo.savePlanDay(1, "Lower", "Lower", [{ exercise: "Back Squat", sets: 3, rep_low: 8, rep_high: 10 }]);
  repo.savePlanDay(2, "Arms", "Arms", [{ exercise: "Rope Hammer Curl", sets: 2, rep_low: 10, rep_high: 12 }]);

  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Cable Overhead Triceps Extension", sets: 2, rep_low: 10, rep_high: 12, target_weight: 60 }]),
    envelope({
      // quads lead the allowed order (the old pick), biceps trail it.
      muscles: { required: [], allowed: ["quads", "biceps"], reduced: [], excluded: [], saturated: ["triceps"] },
    }),
    { substituteSaturated: true }
  );
  assert.ok(session);
  assert.equal(session.items[0].exercise, "Rope Hammer Curl");
  assert.equal(session.items[0].substitution_for, "Cable Overhead Triceps Extension");
});

test("composition drops a second same-angle press from an agent session", () => {
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Dumbbell Bench Press", sets: 2, rep_low: 8, rep_high: 11, target_weight: 55 },
      { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 12, target_weight: 125 },
    ]),
    envelope({
      candidates: [{ exercise: "Barbell Bench Press", action: "hold" }],
    })
  );
  assert.ok(session);
  assert.deepEqual(
    session.items.map((item) => item.exercise),
    ["Barbell Bench Press"],
    "the template's bench stays; the extra flat press does not"
  );
  assert.ok(validation.rejected.some((entry) => entry.reason === "duplicate_press_angle"));
});

test("flat plus incline still compose together", () => {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Incline Dumbbell Press", muscle_group: "chest", mode: "reps" });
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 12, target_weight: 125 },
      { exercise: "Incline Dumbbell Press", sets: 2, rep_low: 8, rep_high: 10, target_weight: 50 },
    ]),
    envelope()
  );
  assert.ok(session);
  assert.deepEqual(
    session.items.map((item) => item.exercise),
    ["Barbell Bench Press", "Incline Dumbbell Press"]
  );
});

test("a saturated stand-in does not add a second flat bench already on the card", () => {
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Chest-Supported Row", muscle_group: "back", mode: "reps" });
  repo.savePlanDay(1, "Push", "Push", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 12, target_weight: 125 },
  ]);
  repo.savePlanDay(4, "Upper", "Chest and back", [
    { exercise: "Dumbbell Bench Press", sets: 2, rep_low: 8, rep_high: 11, target_weight: 55 },
    { exercise: "Chest-Supported Row", sets: 2, rep_low: 10, rep_high: 12, target_weight: 35 },
  ]);

  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Dumbbell Bench Press", sets: 2, rep_low: 8, rep_high: 11, target_weight: 55 },
      { exercise: "Chest-Supported Row", sets: 2, rep_low: 10, rep_high: 12, target_weight: 35 },
    ]),
    envelope({
      muscles: {
        required: ["chest"],
        allowed: ["chest"],
        reduced: [],
        excluded: [],
        saturated: ["back"],
      },
    }),
    { substituteSaturated: true }
  );
  assert.ok(session);
  const names = session.items.map((item) => item.exercise);
  assert.equal(
    names.filter((name) => /bench press/i.test(name)).length,
    1,
    `one flat press, not a pile (got ${JSON.stringify(names)})`
  );
  assert.ok(names.includes("Dumbbell Bench Press"));
  assert.ok(!names.includes("Barbell Bench Press"), "the other day's bench stays off this card");
  assert.ok(names.includes("Chest-Supported Row"), "the row stays light rather than becoming a second bench");
});

test("authoritative overload targets survive deterministic fallback and clamp agent output exactly", () => {
  repo.savePlanDay(1, "Authority", "Server-owned next targets", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
    { exercise: "Assisted Pull-Up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -30 },
    { exercise: "Push-Up", sets: 3, rep_low: 8, rep_high: 12, target_weight: null },
    { exercise: "Front Plank", sets: 3, target_seconds: 60, mode: "timed" },
  ]);
  const targets = new Map([
    ["Bench Press", { mode: "reps", sets: 3, rep_low: 6, rep_high: 8, target_weight: 105, target_seconds: null }],
    ["Assisted Pull-Up", { mode: "reps", sets: 3, rep_low: 6, rep_high: 8, target_weight: -25, target_seconds: null }],
    ["Push-Up", { mode: "reps", sets: 3, rep_low: 8, rep_high: 12, target_weight: null, target_seconds: null }],
    ["Front Plank", { mode: "timed", sets: 3, rep_low: null, rep_high: null, target_weight: null, target_seconds: 66 }],
  ]);
  const candidates = [...targets].map(([exercise, authorized_target]) => ({
    exercise,
    muscle_group: null,
    action: "overload",
    reason_code: "progression_overload",
    substitution_for: null,
    note: "Earned",
    authorized_target,
  }));
  const authorityEnvelope = envelope({
    template: { day_number: 1, plan_day_id: repo.getPlanDay(1).id, focus: "Authority", intent: "template" },
    candidates,
  });

  const deterministic = deterministicComposedSession(authorityEnvelope);
  const deterministicByExercise = new Map(deterministic.items.map((item) => [item.exercise, item]));
  for (const [exercise, target] of targets) {
    assert.equal(deterministicByExercise.get(exercise).target_weight, target.target_weight, exercise);
    assert.equal(deterministicByExercise.get(exercise).target_seconds, target.target_seconds, exercise);
  }

  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Bench Press", sets: 5, rep_low: 3, rep_high: 4, target_weight: 180 },
      { exercise: "Assisted Pull-Up", sets: 5, rep_low: 3, rep_high: 4, target_weight: -5 },
      { exercise: "Push-Up", sets: 5, rep_low: 3, rep_high: 4, target_weight: 45 },
      { exercise: "Front Plank", sets: 5, target_seconds: 180, mode: "timed" },
    ]),
    authorityEnvelope
  );
  assert.equal(validation.ok, true);
  const agentByExercise = new Map(session.items.map((item) => [item.exercise, item]));
  for (const [exercise, target] of targets) {
    assert.equal(
      agentByExercise.get(exercise).sets,
      5,
      `${exercise} keeps the accepted daily volume while challenge stays server-owned`
    );
    assert.equal(agentByExercise.get(exercise).target_weight, target.target_weight, exercise);
    assert.equal(agentByExercise.get(exercise).target_seconds, target.target_seconds, exercise);
  }
});

test("authoritative deload targets are not reduced twice and cardio keeps accountable metadata", () => {
  repo.savePlanDay(1, "Deload authority", "Exact reduced targets", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
    { exercise: "Front Plank", sets: 3, target_seconds: 60, mode: "timed" },
  ]);
  const decisionMeta = {
    brain_decision_id: 77,
    brain_change_summary: "Easy ride was adjusted.",
    brain_change_reason: "Recovery context.",
    brain_change_reversible: true,
  };
  const decision = envelope({
    template: { day_number: 1, plan_day_id: repo.getPlanDay(1).id, focus: "Deload authority", intent: "template" },
    candidates: [
      {
        exercise: "Bench Press",
        muscle_group: null,
        action: "deload",
        reason_code: "progression_deload",
        substitution_for: null,
        note: null,
        authorized_target: {
          mode: "reps",
          sets: 3,
          rep_low: 6,
          rep_high: 8,
          target_weight: 90,
          target_seconds: null,
        },
      },
      {
        exercise: "Front Plank",
        muscle_group: null,
        action: "deload",
        reason_code: "progression_deload",
        substitution_for: null,
        note: null,
        authorized_target: {
          mode: "timed",
          sets: 3,
          rep_low: null,
          rep_high: null,
          target_weight: null,
          target_seconds: 54,
        },
      },
      {
        exercise: "Easy ride",
        muscle_group: null,
        action: "hold",
        reason_code: "progression_hold",
        substitution_for: null,
        note: null,
        ...decisionMeta,
      },
    ],
  });
  const { session } = normalizeComposedSession(
    {
      name: "Exact deload",
      why: "Use the server-owned reduced targets.",
      items: [
        { exercise: "Bench Press", sets: 3, rep_low: 3, rep_high: 4, target_weight: 140 },
        { exercise: "Front Plank", sets: 3, target_seconds: 120, mode: "timed" },
        { kind: "cardio", exercise: "Easy ride", target_duration_min: 20, target_zone: "easy" },
      ],
    },
    decision
  );
  const byExercise = new Map(session.items.map((item) => [item.exercise, item]));
  assert.equal(byExercise.get("Bench Press").target_weight, 90);
  assert.equal(byExercise.get("Front Plank").target_seconds, 54);
  assert.equal(byExercise.get("Easy ride").brain_decision_id, 77);
  assert.equal(byExercise.get("Easy ride").brain_change_reversible, true);
});

test("an authorized null target remains null instead of fabricating a thin-history load", () => {
  repo.savePlanDay(1, "Baseline", "No load anchor", [
    { exercise: "New Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: null },
  ]);
  const candidate = {
    exercise: "New Row",
    muscle_group: null,
    action: "hold",
    reason_code: "progression_hold",
    substitution_for: null,
    note: "Establish the baseline",
    authorized_target: {
      mode: "reps",
      sets: 3,
      rep_low: 8,
      rep_high: 10,
      target_weight: null,
      target_seconds: null,
    },
  };
  const bounded = normalizeComposedSession(
    agentSession([{ exercise: "New Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 80 }]),
    envelope({
      template: { day_number: 1, plan_day_id: repo.getPlanDay(1).id, focus: "Baseline", intent: "template" },
      candidates: [candidate],
    })
  ).session;
  assert.equal(bounded.items[0].target_weight, null);
  assert.equal(
    deterministicComposedSession(
      envelope({
        template: { day_number: 1, plan_day_id: repo.getPlanDay(1).id, focus: "Baseline", intent: "template" },
        candidates: [candidate],
      })
    ).items[0].target_weight,
    null
  );
});

test("real knee injury impacts feed the daily envelope through affected.exercise and canonical area mapping", () => {
  const date = localDateISO();
  repo.upsertExercise({ name: "Back Squat", muscle_group: "legs", mode: "reps" });
  repo.upsertExercise({ name: "DB Row", muscle_group: "back", mode: "reps" });
  repo.savePlanDay(1, "Lower", "Legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
    { exercise: "DB Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 50 },
  ]);
  repo.addContextEvent({
    kind: "injury",
    title: "Right knee",
    start_date: date,
    meta: { area: "knee", severity: "moderate" },
  });

  const impacts = repo.getInjuryImpacts();
  assert.ok(impacts.injuries[0].affected.some((item) => item.exercise === "Back Squat"));
  const { envelope: decision } = repo.decideDailySession(date);
  assert.ok(decision.muscles.excluded.includes("quads"));
  assert.equal(decision.candidates.find((item) => item.exercise === "Back Squat")?.action, "exclude");
});

// Plan days hold strength only (runs are the calendar's), so a descriptive tempo run
// reaches the day's card as an agent-composed item — and the LIVE gather → decision
// envelope is what certifies it against protective areas and reported joint pain.
function descriptiveTempoItem() {
  return {
    exercise: "Tempo run",
    kind: "cardio",
    note: DESCRIPTIVE_TEMPO_NOTE,
    target_duration_min: 40,
    target_zone: "Z3",
  };
}

function hybridPlanWithTempoRow() {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  // The cardio row is stripped on save: the plan day holds the bench alone.
  repo.savePlanDay(1, "Hybrid", "Run plus upper", [
    descriptiveTempoItem(),
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
  ]);
}

for (const area of ["knee", "ankle", "hip"]) {
  test(`protective ${area} constraints flow through gather, decision, and cardio composition`, () => {
    hybridPlanWithTempoRow();
    repo.addContextEvent({
      kind: "injury",
      title: `Protective ${area}`,
      start_date: DATE,
      meta: { area, severity: "moderate" },
    });

    const snapshot = repo.gatherDailyDecisionSnapshot(DATE);
    assert.deepEqual(
      snapshot.plan_items.map((item) => item.exercise),
      ["Bench Press"],
      "the plan day carries no run — runs are the calendar's"
    );
    const decision = repo.buildDailySessionDecision(snapshot, { now: "2031-07-01T12:00:00.000Z" });
    assert.ok(decision.protective_exclusions.some((item) => item.areas.includes(area)));

    const { session, validation } = normalizeComposedSession(
      agentSession([
        descriptiveTempoItem(),
        { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
      ]),
      decision
    );
    assert.deepEqual(session.items.map((item) => item.exercise), ["Bench Press"]);
    assert.ok(
      validation.rejected.some(
        (entry) => entry.exercise === "Tempo run" && entry.reason === "cardio_uncertified_under_exclusions"
      ),
      "the descriptive run identity is routed through pain relevance against the live protective areas"
    );
    assert.deepEqual(deterministicComposedSession(decision).items.map((item) => item.exercise), ["Bench Press"]);
  });
}

test("descriptive tempo survives gather, decision, and composition under unrelated shoulder protection", () => {
  hybridPlanWithTempoRow();
  repo.addContextEvent({
    kind: "injury",
    title: "Protective shoulder",
    start_date: DATE,
    meta: { area: "shoulder", severity: "moderate" },
  });

  const snapshot = repo.gatherDailyDecisionSnapshot(DATE);
  assert.equal(snapshot.plan_items.some((item) => item.kind === "cardio"), false);
  const decision = repo.buildDailySessionDecision(snapshot, { now: "2031-07-01T12:00:00.000Z" });
  assert.ok(decision.protective_exclusions.some((item) => item.areas.includes("shoulder")));
  const { session, validation } = normalizeComposedSession(agentSession([descriptiveTempoItem()]), decision);
  assert.ok(!validation.rejected.some((entry) => entry.exercise === "Tempo run"));
  assert.equal(session.items[0].exercise, "Tempo run");
  assert.equal(session.items[0].note, DESCRIPTIVE_TEMPO_NOTE, "athlete-facing detail rides on the card");
});

test("descriptive tempo is excluded through gather, decision, and composition for recent left-knee pain", () => {
  hybridPlanWithTempoRow();
  db.prepare(`INSERT INTO sessions (date, joint_pain, kind) VALUES (?, 'left knee', 'strength')`).run(
    addDaysISO(DATE, -1)
  );

  const snapshot = repo.gatherDailyDecisionSnapshot(DATE);
  assert.equal(snapshot.feedback.joint_pain, "left knee");
  assert.equal(snapshot.plan_items.some((item) => item.kind === "cardio"), false);
  const decision = repo.buildDailySessionDecision(snapshot, { now: "2031-07-01T12:00:00.000Z" });
  assert.equal(decision.reported_joint_pain, "left knee");
  const { session, validation } = normalizeComposedSession(
    agentSession([
      descriptiveTempoItem(),
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
    ]),
    decision
  );
  assert.deepEqual(session.items.map((item) => item.exercise), ["Bench Press"]);
  assert.ok(
    validation.rejected.some((entry) => entry.exercise === "Tempo run" && entry.reason === "cardio_pain_relevant")
  );
});

test("agent-authored descriptive tempo is canonicalized before candidate and protective-area checks", () => {
  const raw = agentSession([
    {
      kind: "cardio",
      exercise: DESCRIPTIVE_TEMPO_NOTE,
      target_duration_min: 40,
      target_zone: "Z3",
      note: DESCRIPTIVE_TEMPO_NOTE,
    },
  ]);
  const shoulder = envelope({
    hard_constraints: [{ code: "injury_exclusion", detail: "Working around shoulder irritation" }],
    protective_exclusions: [{ areas: ["shoulder"], exercises: [] }],
    muscles: { required: [], allowed: [], reduced: [], excluded: ["shoulders"] },
    candidates: [
      {
        exercise: "Tempo run",
        muscle_group: null,
        action: "carry",
        reason_code: null,
        substitution_for: null,
        note: null,
      },
    ],
  });
  const safe = normalizeComposedSession(raw, shoulder);
  assert.equal(safe.session.items[0].exercise, "Tempo run");
  assert.equal(safe.session.items[0].note, DESCRIPTIVE_TEMPO_NOTE);

  const knee = normalizeComposedSession(raw, {
    ...shoulder,
    protective_exclusions: [{ areas: ["knee"], exercises: [] }],
    muscles: { required: [], allowed: [], reduced: [], excluded: ["quads"] },
  });
  assert.equal(knee.session, null);
  assert.ok(
    knee.validation.rejected.some(
      (item) => item.exercise === "Tempo run" && item.reason === "cardio_uncertified_under_exclusions"
    )
  );
});

test("legacy hard-exclusion envelopes fail closed for cardio without structured provenance", () => {
  const { session, validation } = normalizeComposedSession(
    agentSession([{ kind: "cardio", exercise: "Easy run", target_duration_min: 25, target_zone: "easy" }]),
    envelope({
      hard_constraints: [{ code: "injury_exclusion", detail: "Working around an active injury" }],
    })
  );
  assert.equal(session, null);
  assert.ok(validation.rejected.some((item) => item.reason === "cardio_uncertified_under_exclusions"));
});

test("the database-backed low-performance seam requires two distinct normal sessions before repeated labeling", () => {
  const date = localDateISO();
  repo.savePlanDay(1, "Strength", "Full body", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  db.prepare(`INSERT INTO sessions (date, performance, kind) VALUES (?, 2, 'strength')`).run(
    addDaysISO(date, -1)
  );
  const one = repo.decideDailySession(date).envelope;
  assert.ok(one.precedence.includes("recent_underperformance"));
  assert.ok(!one.precedence.includes("repeated_underperformance"));

  db.prepare(`INSERT INTO sessions (date, performance, kind) VALUES (?, 2, 'strength')`).run(
    addDaysISO(date, -2)
  );
  const two = repo.decideDailySession(date).envelope;
  assert.ok(two.precedence.includes("repeated_underperformance"));
  assert.ok(!two.precedence.includes("recent_underperformance"));
});

test("when every item is excluded the composition is rejected for fallback", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  const { session, validation } = normalizeComposedSession(
    agentSession([{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 }]),
    envelope({ muscles: { required: [], allowed: [], reduced: [], excluded: ["chest"] } })
  );
  assert.equal(session, null);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "all_items_excluded");
});

test("unparseable agent output yields a null session", () => {
  const { session, validation } = normalizeComposedSession({ garbage: true }, envelope());
  assert.equal(session, null);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "unparseable");
});

test("deterministic fallback builds from the template day, honoring exclusions", () => {
  repo.savePlanDay(1, "Lower body", "Quads and hinge", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
  ]);
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  const session = deterministicComposedSession(
    envelope({
      template: { day_number: 1, plan_day_id: null, focus: "Lower body", intent: "template" },
      muscles: { required: [], allowed: [], reduced: [], excluded: ["quads"] },
    })
  );
  assert.ok(session.items.length >= 1);
  assert.ok(!session.items.some((i) => i.exercise === "Back Squat"));
  assert.ok(session.items.some((i) => i.exercise === "Bench Press"));
});

test("deterministic fallback executes a candidate substitution without inheriting the old load", () => {
  repo.savePlanDay(1, "Lower body", "Squat pattern", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
  ]);
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Front Squat", muscle_group: "quads", mode: "reps" });
  const session = deterministicComposedSession(
    envelope({
      template: { day_number: 1, plan_day_id: repo.getPlanDay(1).id, focus: "Lower body", intent: "template" },
      candidates: [
        {
          exercise: "Front Squat",
          muscle_group: "quads",
          action: "vary",
          reason_code: "progression_vary",
          substitution_for: "Back Squat",
          note: "Rotate the pattern",
        },
      ],
    })
  );
  assert.equal(session.items[0].exercise, "Front Squat");
  assert.equal(session.items[0].target_weight, null);
  assert.match(session.items[0].note, /baseline/i);
});

test("deterministic fallback for a rest/custom envelope returns no workout", () => {
  const session = deterministicComposedSession(
    envelope({
      kind: "rest",
      template: { day_number: null, plan_day_id: null, focus: null, intent: "custom" },
      caps: { volume: "minimal", intensity: "easy", duration_min: 20 },
    })
  );
  assert.deepEqual(session.items, []);
  assert.equal(session.est_minutes, null);
});

test("composeDailySession degrades to a deterministic session when no agent is usable and never persists", async () => {
  repo.savePlanDay(1, "Lower body", "Quads and hinge", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
    { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 185 },
  ]);
  // The offline stub returns a plan-proposal shape — the wrong contract for a
  // session — so the rotation is exhausted and the deterministic fallback runs.
  const result = await composeDailySession("stub", { date: DATE });
  assert.equal(result.ok, true);
  assert.ok(result.session);
  assert.ok(result.session.items.length >= 1);
  assert.ok(result.fallback, "a degraded run should record a fallback reason");
  assert.ok(result.envelope);
  // Preview-only: nothing is persisted or applied.
  const compositions = db.prepare(`SELECT COUNT(*) AS n FROM daily_session_compositions`).get();
  assert.equal(compositions.n, 0);
});

test("a completed session_compose job is acceptable via prepare(agent_suggest)", () => {
  repo.savePlanDay(1, "Lower body", "Quads and hinge", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
  ]);
  const session = agentSession([
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
    { exercise: "Walking Lunge", sets: 3, rep_low: 10, rep_high: 12, target_weight: null },
  ]);
  const job = repo.createAgentJob({ kind: "session_compose", input: { date: DATE } });
  repo.finishAgentJob(job.id, {
    chosen_agent: "codex",
    result: { ok: true, session, agent: "codex", tried: [{ agent: "codex" }] },
  });
  const prepared = repo.prepareDailySession({ date: DATE, source: "agent_suggest", agent_job_id: job.id });
  assert.equal(prepared.reused, false);
  assert.equal(prepared.daily_session.source, "agent_suggest");
  assert.equal(prepared.daily_session.plan_day_id, repo.getPlanDay(1).id);
  assert.ok(prepared.daily_session.items.length >= 1);
});

test("an envelope-backed composition is revalidated against the current decision fingerprint", () => {
  repo.savePlanDay(1, "Lower body", "Quads and hinge", [
    { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
  ]);
  const plan = repo.getPlanDay(1);
  const decision = envelope({
    input_fingerprint: "compose-plan-fingerprint",
    template: { day_number: 1, plan_day_id: plan.id, focus: "Lower body", intent: "template" },
  });
  const session = agentSession([
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 },
  ]);
  const job = repo.createAgentJob({ kind: "session_compose", input: { date: DATE } });
  repo.finishAgentJob(job.id, {
    chosen_agent: "codex",
    result: {
      ok: true,
      session,
      envelope: decision,
      session_normalization: "daily_session_v1",
      agent: "codex",
      tried: [{ agent: "codex" }],
    },
  });

  const prepared = repo.prepareDailySession({ date: DATE, source: "agent_suggest", agent_job_id: job.id });
  assert.equal(prepared.daily_session.plan_day_id, plan.id);
  assert.notEqual(prepared.daily_session.decision.input_fingerprint, decision.input_fingerprint);
  assert.equal(
    prepared.daily_session.provenance.daily_decision.input_fingerprint,
    prepared.daily_session.decision.input_fingerprint
  );
  assert.equal(
    db.prepare(`SELECT composition_id FROM daily_session_decisions WHERE input_fingerprint = ?`).get(
      prepared.daily_session.decision.input_fingerprint
    ).composition_id,
    prepared.daily_session.id
  );
});

// ── `reduced` is enforced, not merely requested ──────────────────────────────
// The verifier enforced `excluded` and nothing else; `reduced` reached the agent
// as a line in the prompt and was never checked, so an agent that ignored it was
// never corrected — a hole in the law that safety logic is deterministic and
// agents only phrase it. It CLAMPS rather than rejects: reduced means less, not
// none, and the envelope still allows the area.

const reducedEnvelope = (groups, extra = {}) =>
  envelope({ muscles: { required: [], allowed: [], reduced: groups, excluded: [] }, ...extra });

// A plan-day anchor, so the composed target survives normalization and the
// intensity clamp is observable as a number rather than as a null.
function anchorPlan(items) {
  repo.savePlanDay(1, "Lower", "Lower", items);
  return repo.getPlan().find((d) => d.day_number === 1);
}

test("a reduced area keeps its movement but comes down in sets and target", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  anchorPlan([{ exercise: "Back Squat", sets: 5, rep_low: 5, rep_high: 7, target_weight: 200 }]);
  const { session, validation } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 5, rep_low: 5, rep_high: 7, target_weight: 200 }]),
    reducedEnvelope(["quads"])
  );
  assert.ok(session);
  const squat = session.items.find((i) => i.exercise === "Back Squat");
  assert.ok(squat, "the movement is kept — reduced is not exclusion");
  assert.equal(squat.sets, 2, "sets are clamped to the reduced per-item cap");
  assert.equal(squat.target_weight, 180, "and the target is eased by the reduced factor");
  assert.equal(validation.capped, true, "the clamp is reported");
  assert.equal(validation.rejected.length, 0, "nothing is thrown away");
  assert.ok(REDUCED_AREA_NOTES.includes(squat.note), "and it is said in plain words from the reduced set");
});

// An eased target is a load a bar, a pair of dumbbells or a stack can be set to: the
// factor's load rounded DOWN onto the lift's own increment (5 lb compound, 2.5 lb
// isolation, never under 5 lb on a pinned stack). Assistance is never multiplied.
test("an eased load lands on the lift's own grid: barbell, dumbbell, stack, assisted", () => {
  const lifts = [
    ["Back Squat", "quads", 185, 165], // 166.5 → the barbell's 5 lb grid
    ["Dumbbell Curl", "biceps", 25, 22.5], // an isolation dumbbell keeps its 2.5 lb grid
    ["Rope Pushdown", "triceps", 57.5, 50], // 51.75 → a pinned stack's 5 lb floor
    ["Dumbbell Bench Press", "chest", 55, 50], // 49.5: the floor (45) cuts too deep, so the nearest step under
    ["Cable Lateral Raise", "shoulders", 20, 20], // no stack step under 20 lands near 18: the prescription holds
    ["Assisted Pull-Up", "back", -30, -30], // assistance is never multiplied toward harder
  ];
  for (const [name, group] of lifts) repo.upsertExercise({ name, muscle_group: group, mode: "reps" });
  const items = lifts.map(([exercise, , target_weight]) => ({
    exercise,
    sets: 3,
    rep_low: 8,
    rep_high: 10,
    target_weight,
  }));
  anchorPlan(items);
  const { session } = normalizeComposedSession(
    agentSession(items.map((i) => ({ ...i }))),
    reducedEnvelope(["quads", "biceps", "triceps", "chest", "shoulders", "back"], {
      caps: { volume: "normal", intensity: "normal", duration_min: 90 },
    })
  );
  for (const [name, , , eased] of lifts) {
    const item = session.items.find((i) => i.exercise === name);
    assert.ok(item, name);
    assert.equal(item.target_weight, eased, name);
  }
});

test("an easy day's eased load also lands on the grid", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  anchorPlan([{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 }]);
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 }]),
    envelope({ caps: { volume: "reduced", intensity: "easy", duration_min: 30 } })
  );
  assert.equal(session.items[0].target_weight, 120, "155 × 0.8 = 124, down onto the 5 lb grid");
});

// A group only the race build's stress budget reduced (`stress.sole_reduced`) is FRESH:
// its note says the build's reason, never the generic "still carrying recent work".
const stressEnvelope = (stress, extra = {}) =>
  reducedEnvelope(stress.sole_reduced, {
    stress: { groups: stress.sole_reduced, ...stress },
    ...extra,
  });

test("a taper-only reduced item says the taper's reason, not fatigue", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  anchorPlan([{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 185 }]);
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 185 }]),
    stressEnvelope({ code: "race_taper_legs", sole_reduced: ["quads"] })
  );
  const squat = session.items[0];
  assert.equal(squat.sets, 2);
  assert.equal(squat.target_weight, 165);
  assert.ok(RACE_TAPER_ITEM_NOTES.includes(squat.note), squat.note);
  assert.ok(!REDUCED_AREA_NOTES.includes(squat.note), squat.note);
});

test("a key-run eve trim says fewer sets at the same weight; the day's own easing takes the day's words", () => {
  repo.upsertExercise({ name: "Romanian Deadlift", muscle_group: "hamstrings", mode: "reps" });
  const rdl = { exercise: "Romanian Deadlift", sets: 3, rep_low: 8, rep_high: 10, target_weight: 205 };
  anchorPlan([rdl]);
  const eve = { code: "key_run_eve", sole_reduced: ["hamstrings"], load_held: true };
  const held = normalizeComposedSession(agentSession([{ ...rdl }]), stressEnvelope(eve)).session.items[0];
  assert.equal(held.sets, 2);
  assert.equal(held.target_weight, 205, "the eve holds the load");
  assert.ok(KEY_RUN_EVE_ITEM_NOTES.includes(held.note), held.note);

  const eased = normalizeComposedSession(
    agentSession([{ ...rdl }]),
    stressEnvelope(eve, { caps: { volume: "reduced", intensity: "easy", duration_min: 30 } })
  ).session.items[0];
  assert.equal(eased.target_weight, 160, "205 × 0.8 on the grid");
  assert.ok(EASED_TODAY_NOTES.includes(eased.note), eased.note);
  assert.ok(!KEY_RUN_EVE_ITEM_NOTES.includes(eased.note), "never 'same weight' on an eased load");
  assert.ok(!REDUCED_AREA_NOTES.includes(eased.note), eased.note);
});

test("an untouched area in the same session keeps the volume it was composed with", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  anchorPlan([
    { exercise: "Back Squat", sets: 5, rep_low: 5, rep_high: 7, target_weight: 200 },
    { exercise: "Bench Press", sets: 4, rep_low: 6, rep_high: 8, target_weight: 155 },
  ]);
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Back Squat", sets: 5, rep_low: 5, rep_high: 7, target_weight: 200 },
      { exercise: "Bench Press", sets: 4, rep_low: 6, rep_high: 8, target_weight: 155 },
    ]),
    reducedEnvelope(["quads"])
  );
  const bench = session.items.find((i) => i.exercise === "Bench Press");
  assert.equal(bench.sets, 4, "the fresh area keeps its volume");
  assert.equal(bench.target_weight, 155, "and its target, untouched");
  assert.equal(bench.note ?? null, null, "and says nothing about being eased");
});

test("a reduced TIMED movement is eased in seconds, never given a load", () => {
  repo.upsertExercise({ name: "Plank", muscle_group: "core", mode: "timed" });
  anchorPlan([{ exercise: "Plank", sets: 4, mode: "timed", target_seconds: 120 }]);
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Plank", sets: 4, mode: "timed", target_seconds: 120 }]),
    reducedEnvelope(["core"])
  );
  const plank = session.items.find((i) => i.exercise === "Plank");
  assert.ok(plank);
  assert.equal(plank.sets, 2);
  assert.equal(plank.target_seconds, 108, "seconds come down by the reduced factor");
  assert.equal(plank.target_weight ?? null, null, "a timed movement is never given load");
});

test("the reduced clamp composes with a deeper day-level easing rather than loosening it", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  anchorPlan([{ exercise: "Back Squat", sets: 5, rep_low: 5, rep_high: 7, target_weight: 200 }]);
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 5, rep_low: 5, rep_high: 7, target_weight: 200 }]),
    reducedEnvelope(["quads"], { caps: { volume: "normal", intensity: "easy", duration_min: 60 } })
  );
  const squat = session.items.find((i) => i.exercise === "Back Squat");
  // "easy" is the deeper cut; the reduced factor must never pull it back up.
  assert.equal(squat.target_weight, 160, "the deeper easing still governs");
});

test("the deterministic fallback honors reduced too — it is not an agent-only rule", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  anchorPlan([{ exercise: "Back Squat", sets: 5, rep_low: 5, rep_high: 7, target_weight: 200 }]);
  const session = deterministicComposedSession(
    reducedEnvelope(["quads"], {
      template: { day_number: 1, plan_day_id: null, focus: "Lower", intent: "template" },
    })
  );
  const squat = session.items.find((i) => i.exercise === "Back Squat");
  assert.ok(squat, "the deterministic session still programs the movement");
  assert.equal(squat.sets, 2, "and clamps it the same way");
  assert.equal(squat.target_weight, 180);
});

test("a reduced group that is ALSO excluded is still dropped — exclusion wins", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  const { validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Back Squat", sets: 4, rep_low: 5, rep_high: 7, target_weight: 225 },
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
    ]),
    envelope({ muscles: { required: [], allowed: [], reduced: ["quads"], excluded: ["quads"] } })
  );
  assert.ok(validation.rejected.some((r) => r.exercise === "Back Squat" && r.reason === "excluded_group"));
});

// ── the peak week's heavy single, rendered as its own line ───────────────────
// The gap this closes: `authorized_target` describes ONE tier, and on a peak day
// that tier is the BACK-OFF block. So the composed session the athlete read was
// the back-off work alone, with the heavy single surviving only as prose inside
// the candidate's note. The single is now inserted server-side, in the normalizer
// both composition paths already run through, so neither the agent nor the
// deterministic fallback can author, forge, or lose it.

const PEAK_CANDIDATE = {
  exercise: "Back Squat",
  muscle_group: "quads",
  action: "overload",
  reason_code: null,
  substitution_for: null,
  note: null,
  current_target: { mode: "reps", sets: 3, rep_low: 5, rep_high: 7, target_weight: 215, target_seconds: null },
  authorized_target: { mode: "reps", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225, target_seconds: null },
  top_set: { weight: 275, reps: 1 },
};

const peakEnvelope = (over = {}) => envelope({ candidates: [PEAK_CANDIDATE], ...over });
const backoffItem = () => ({ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 });

function seedSquat() {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
}

test("a peak day renders BOTH tiers: the heavy single ahead of its back-off block", () => {
  seedSquat();
  const { session } = normalizeComposedSession(agentSession([backoffItem()]), peakEnvelope());
  assert.ok(session);
  assert.equal(session.items.length, 2, "two entries, not one line with the single hidden in a note");

  const [top, block] = session.items;
  assert.equal(top.exercise, "Back Squat");
  assert.equal(top.target_weight, 275, "the heavy single leads");
  assert.equal(top.sets, 1);
  assert.equal(top.rep_low, 1);
  assert.equal(top.rep_high, 1);
  assert.equal(top.mode, "reps");
  assert.match(top.note, /\S/, "and it says what to do with it");
  assert.equal(top.reach.weight, 275);
  assert.equal(top.reach.reps, 1);

  assert.equal(block.target_weight, 225, "the back-off block follows, untouched");
  assert.equal(block.sets, 3);

  // Positions are rewritten so the two tiers read in the order they are done.
  assert.deepEqual(session.items.map((i) => i.position), [0, 1]);
});

test("an ordinary day is byte-for-byte what it always was", () => {
  seedSquat();
  const plain = { ...PEAK_CANDIDATE };
  delete plain.top_set;
  const { session } = normalizeComposedSession(agentSession([backoffItem()]), envelope({ candidates: [plain] }));
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].target_weight, 225);
});

test("the deterministic fallback renders both tiers too — agent absence loses nothing", () => {
  seedSquat();
  db.prepare(`INSERT INTO plan_days (day_number, name, focus) VALUES (1, 'Lower', 'Lower body')`).run();
  const planDayId = db.prepare(`SELECT id FROM plan_days WHERE day_number = 1`).get().id;
  const exId = db.prepare(`SELECT id FROM exercises WHERE name = 'Back Squat'`).get().id;
  db.prepare(
    `INSERT INTO plan_items (plan_day_id, exercise_id, position, sets, rep_low, rep_high, target_weight, kind)
     VALUES (?, ?, 1, 3, 5, 5, 225, 'strength')`,
  ).run(planDayId, exId);

  const session = deterministicComposedSession(
    peakEnvelope({ template: { day_number: 1, plan_day_id: planDayId, focus: "Lower body", intent: "template" } })
  );
  const squats = session.items.filter((i) => i.exercise === "Back Squat");
  assert.equal(squats.length, 2, "the fallback is a real peak session, not the back-off block alone");
  assert.equal(squats[0].target_weight, 275);
  assert.equal(squats[1].target_weight, 225);
});

test("an agent cannot forge a heavy single of its own", () => {
  seedSquat();
  // The agent asks for a 315 single on a day with no peak protocol authorized.
  const plain = { ...PEAK_CANDIDATE };
  delete plain.top_set;
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Back Squat", sets: 1, rep_low: 1, rep_high: 1, target_weight: 315 },
      backoffItem(),
    ]),
    envelope({ candidates: [plain] })
  );
  assert.ok(session);
  for (const item of session.items) {
    assert.equal(item.target_weight, 225, "every squat entry is clamped to the authorized target");
  }
});

test("an eased day withdraws the single even when the lift itself never stepped back", () => {
  // caps.intensity is a DAY-level brake the candidate gate never sees, so the
  // top set is asked about a second time here.
  seedSquat();
  for (const caps of [
    { volume: "normal", intensity: "easy", duration_min: 60 },
    { volume: "normal", intensity: "deload", duration_min: 60 },
    { volume: "normal", intensity: "hold", duration_min: 60 },
    { volume: "minimal", intensity: "normal", duration_min: 60 },
  ]) {
    const { session } = normalizeComposedSession(agentSession([backoffItem()]), peakEnvelope({ caps }));
    assert.ok(session);
    assert.ok(
      !session.items.some((i) => i.target_weight === 275),
      `${caps.intensity}/${caps.volume} is no day for a near-maximal single`,
    );
  }
});

test("an active recovery cycle withdraws it as well", () => {
  seedSquat();
  const { session } = normalizeComposedSession(
    agentSession([backoffItem()]),
    peakEnvelope({ recovery_cycle: { effective_status: "active", working_set_fraction: 0.6 } })
  );
  assert.ok(session);
  assert.ok(!session.items.some((i) => i.target_weight === 275));
});

test("a single at or under the block it leads into is a broken payload, not a protocol", () => {
  seedSquat();
  for (const weight of [225, 200]) {
    const { session } = normalizeComposedSession(
      agentSession([backoffItem()]),
      envelope({ candidates: [{ ...PEAK_CANDIDATE, top_set: { weight, reps: 1 } }] })
    );
    assert.equal(session.items.length, 1, `a "top" set of ${weight} over a 225 block leads nothing`);
  }
});

test("the heavy set is one working set and is paid for out of the day's budget", () => {
  seedSquat();
  const { session } = normalizeComposedSession(
    agentSession([backoffItem()]),
    peakEnvelope({ caps: { volume: "reduced", intensity: "normal", duration_min: 60 } })
  );
  assert.ok(session);
  const total = session.items.reduce((sum, i) => sum + (Number(i.sets) || 0), 0);
  // A reduced day allows 12 working sets; the single plus its clamped block must
  // sit inside that, and the single itself counts as one.
  assert.ok(total <= 12, `${total} sets is inside the reduced budget`);
  assert.equal(session.items[0].sets, 1);
});

test("a fully-budgeted day never renders more items than its own cap, even with a heavy single available on every lift", () => {
  // "reduced" volume caps the day at 7 items. Seed exactly 7 distinct lifts, each
  // one eligible for its own top set (block below the candidate's top_set weight).
  // A prefix check on withTopSets.length re-arms after every insertion and would
  // seat several singles before finally refusing one — rendering more than 7 items
  // on a day whose own cap says 7. The fix must stop BEFORE the first insertion
  // that would push the final list past the cap.
  const names = ["Squat A", "Squat B", "Squat C", "Squat D", "Squat E", "Squat F", "Squat G"];
  const candidates = [];
  const items = [];
  for (const name of names) {
    repo.upsertExercise({ name, muscle_group: "quads", mode: "reps" });
    candidates.push({
      exercise: name,
      muscle_group: "quads",
      action: "overload",
      reason_code: null,
      substitution_for: null,
      note: null,
      current_target: { mode: "reps", sets: 1, rep_low: 5, rep_high: 5, target_weight: 100, target_seconds: null },
      authorized_target: { mode: "reps", sets: 1, rep_low: 5, rep_high: 5, target_weight: 100, target_seconds: null },
      top_set: { weight: 150, reps: 1 },
    });
    items.push({ exercise: name, sets: 1, rep_low: 5, rep_high: 5, target_weight: 100 });
  }
  const { session, validation } = normalizeComposedSession(
    agentSession(items),
    envelope({ candidates, caps: { volume: "reduced", intensity: "normal", duration_min: 90 } })
  );
  assert.ok(session);
  assert.ok(session.items.length <= 7, `expected at most the day's cap of 7 items, got ${session.items.length}`);
  // By design a fully-budgeted day (exactly cap items already) has no room left for
  // any top set at all — dropped, never displacing the back-off work to make room.
  assert.equal(session.items.length, 7, "no top set fits once the day is already at its own cap");
  assert.ok(!session.items.some((i) => i.target_weight === 150), "no heavy single was seated on a full day");
  assert.equal(validation.ok, true);
});

function reachCandidate(exercise, target_weight, extra = {}) {
  return {
    exercise,
    muscle_group: extra.muscle_group ?? null,
    action: extra.action ?? "overload",
    reason_code: extra.reason_code ?? null,
    substitution_for: null,
    note: null,
    current_target: {
      mode: "reps",
      sets: extra.sets ?? 3,
      rep_low: extra.rep_low ?? 5,
      rep_high: extra.rep_high ?? 7,
      target_weight,
      target_seconds: null,
    },
    authorized_target: {
      mode: "reps",
      sets: extra.sets ?? 3,
      rep_low: extra.rep_low ?? 5,
      rep_high: extra.rep_high ?? 7,
      target_weight,
      target_seconds: null,
    },
  };
}

function reachEnvelope(over = {}) {
  return envelope({
    reach: {
      level: "push",
      backed_by: ["session_quality"],
      why: "You've earned a heavier look at this one today",
    },
    ...over,
  });
}

function logWorking(exercise, weight, date = "2031-06-20") {
  repo.logSetByName({ date, exercise, weight, reps: 5 });
}

function logBodyweight(exercise, date = "2031-06-20") {
  repo.logSetByName({ date, exercise, reps: 8 });
}

test("a rotated chest/shoulder day with sore legs still seats a reach on the first fresh compound", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Overhead Press", muscle_group: "shoulders", mode: "reps" });
  logWorking("Bench Press", 155);
  logWorking("Overhead Press", 95);
  const env = reachEnvelope({
    caps: { volume: "normal", intensity: "normal", duration_min: 60 },
    muscles: {
      required: ["chest", "shoulders"],
      allowed: ["chest", "shoulders"],
      reduced: ["quads", "hamstrings"],
      excluded: [],
      saturated: ["quads", "hamstrings"],
    },
    candidates: [
      reachCandidate("Bench Press", 155, { muscle_group: "chest" }),
      reachCandidate("Overhead Press", 95, { muscle_group: "shoulders" }),
    ],
  });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 7, target_weight: 155 },
      { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 95 },
    ]),
    env
  );
  assert.ok(session);
  const benches = session.items.filter((i) => i.exercise === "Bench Press");
  assert.equal(benches.length, 2, "the first fresh compound splits into reach + working");
  assert.equal(benches[0].sets, 1);
  assert.ok(benches[0].reach);
  assert.equal(validation.reach_landed, true);
  assert.equal(env.reach.level, "push");
  assert.ok(!env.soft_preferences.some((e) => e.code === "reach_no_room"));
});

test("a reach day injects exactly one top set on the first compound", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  logWorking("Back Squat", 225);
  logWorking("Bench Press", 155);
  const env = reachEnvelope({
    candidates: [
      reachCandidate("Back Squat", 225, { muscle_group: "quads" }),
      reachCandidate("Bench Press", 155, { muscle_group: "chest", rep_low: 6, rep_high: 8 }),
    ],
  });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 },
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
    ]),
    env
  );
  assert.ok(session);
  const squats = session.items.filter((i) => i.exercise === "Back Squat");
  assert.equal(squats.length, 2, "the first compound splits into reach + working");
  assert.equal(squats[0].sets, 1);
  // One earned step above the logged 225 × 5, at the reps the lift's own estimate
  // (225 × 5 → e1RM 262.5) says 230 holds with a rep in hand: 30 × (262.5/230 − 1) − 1.
  assert.equal(squats[0].target_weight, 230, "one earned step above the logged working weight");
  assert.equal(squats[0].rep_low, 3);
  assert.equal(squats[0].rep_high, 3);
  assert.equal(squats[0].reach.weight, 230);
  assert.equal(squats[0].reach.reps, 3);
  assert.equal(squats[1].target_weight, 225);
  assert.equal(squats[1].sets, 3);
  assert.equal(session.items.filter((i) => i.exercise === "Bench Press").length, 1, "later lifts stay one card");
  assert.equal(validation.reach_landed, true);
  assert.equal(env.reach.level, "push");
  assert.ok(!env.soft_preferences.some((e) => e.code === "reach_no_room"));
});

test("an assisted lift on a reach day gets an AMRAP note, not a positive load", () => {
  repo.upsertExercise({ name: "Pull-up", muscle_group: "lats", mode: "reps" });
  logWorking("Pull-up", -30);
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Pull-up", sets: 3, rep_low: 6, rep_high: 8, target_weight: -30 }]),
    reachEnvelope({
      candidates: [reachCandidate("Pull-up", -30, { muscle_group: "lats", rep_low: 6, rep_high: 8 })],
    })
  );
  assert.ok(session);
  assert.equal(session.items.length, 1, "no extra item — the last working set is the reach");
  assert.equal(session.items[0].target_weight, -30, "assistance is unchanged");
  assert.match(session.items[0].note, /last set|clean reps|one in reserve|one left in the tank/i);
  assert.equal(session.items[0].reach.amrap, true);
});

test("a bodyweight lift on a reach day also gets the AMRAP note", () => {
  repo.upsertExercise({ name: "Push-up", muscle_group: "chest", mode: "reps" });
  logBodyweight("Push-up");
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Push-up", sets: 3, rep_low: 8, rep_high: 12, target_weight: null }]),
    reachEnvelope({
      candidates: [reachCandidate("Push-up", null, { muscle_group: "chest", rep_low: 8, rep_high: 12 })],
    })
  );
  assert.ok(session);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].target_weight, null);
  assert.equal(session.items[0].reach.amrap, true);
});

test("a reduced first item never hosts — reach lands on the next compound", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  logWorking("Bench Press", 155);
  logWorking("Back Squat", 225);
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Bench Press", sets: 4, rep_low: 6, rep_high: 8, target_weight: 155 },
      { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 },
    ]),
    reachEnvelope({
      muscles: { required: [], allowed: [], reduced: ["chest"], excluded: [] },
      candidates: [
        reachCandidate("Bench Press", 155, { muscle_group: "chest", rep_low: 6, rep_high: 8 }),
        reachCandidate("Back Squat", 225, { muscle_group: "quads" }),
      ],
    })
  );
  assert.ok(session);
  const bench = session.items.filter((i) => i.exercise === "Bench Press");
  const squats = session.items.filter((i) => i.exercise === "Back Squat");
  assert.equal(bench.length, 1, "the reduced lift stays one card");
  assert.equal(bench[0].sets, 2, "and is still clamped");
  assert.equal(bench[0].reach, undefined, "it does not host");
  assert.equal(squats.length, 2, "reach lands on the next eligible compound");
  assert.equal(squats[0].sets, 1);
  assert.equal(squats[0].reach.weight, 230);
});

test("when no eligible host remains, no reach item is injected", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  logWorking("Bench Press", 155);
  const env = reachEnvelope({
    muscles: { required: [], allowed: [], reduced: ["chest"], excluded: [] },
    candidates: [reachCandidate("Bench Press", 155, { muscle_group: "chest", rep_low: 6, rep_high: 8 })],
  });
  const { session, validation } = normalizeComposedSession(
    agentSession([{ exercise: "Bench Press", sets: 4, rep_low: 6, rep_high: 8, target_weight: 155 }]),
    env
  );
  assert.ok(session);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].reach, undefined);
  assert.equal(validation.reach_landed, false);
  assert.equal(env.reach.level, "push");
  assert.ok(REACH_NO_ROOM_WHY.includes(env.reach.why));
  assert.ok(env.soft_preferences.some((e) => e.code === "reach_no_room"));
  assert.ok(!env.precedence.includes("backed_day_reach"));
  assert.ok(!env.precedence.includes("reach_no_room"), "no-room is soft-only");
});

test("a saturated surviving host is skipped even when it is not reduced", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  logWorking("Back Squat", 225);
  logWorking("Bench Press", 155);
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 },
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
    ]),
    reachEnvelope({
      muscles: { required: [], allowed: [], reduced: [], excluded: [], saturated: ["quads"] },
      candidates: [
        reachCandidate("Back Squat", 225, { muscle_group: "quads" }),
        reachCandidate("Bench Press", 155, { muscle_group: "chest", rep_low: 6, rep_high: 8 }),
      ],
    })
  );
  assert.ok(session);
  assert.equal(session.items.filter((i) => i.exercise === "Back Squat").length, 1, "saturated squat does not host");
  const benches = session.items.filter((i) => i.exercise === "Bench Press");
  assert.equal(benches.length, 2, "the next unsaturated compound hosts");
  assert.equal(benches[0].reach.weight, 160, "one earned step above the logged 155");
});

test("a host with no muscle group is skipped — unknown is not safe", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  logWorking("Bench Press", 155);
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Mystery Lift", sets: 3, rep_low: 8, rep_high: 10, target_weight: null },
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
    ]),
    reachEnvelope({
      candidates: [reachCandidate("Bench Press", 155, { muscle_group: "chest", rep_low: 6, rep_high: 8 })],
    })
  );
  assert.ok(session);
  assert.equal(
    session.items.filter((i) => i.exercise === "Mystery Lift").length,
    1,
    "the novel movement is kept"
  );
  const benches = session.items.filter((i) => i.exercise === "Bench Press");
  assert.equal(benches.length, 2, "reach waits for a known group");
  assert.ok(benches[0].reach);
});

test("reach load comes from logged working weight, not the stale plan number", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.logSetByName({ date: "2031-06-20", exercise: "Back Squat", weight: 50, reps: 10 });
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 27 }]),
    reachEnvelope({
      candidates: [reachCandidate("Back Squat", 27, { muscle_group: "quads" })],
    })
  );
  assert.ok(session);
  assert.equal(session.items[0].target_weight, 55, "one earned step above the logged 50");
  assert.equal(session.items[0].reach.weight, 55);
  assert.equal(session.items[0].reach.reps, 5, "50 × 10 carries 55 for the block's floor with a rep in hand");
  assert.equal(session.items[1].target_weight, 27, "the working block keeps the item target");
});

test("a heavier look that does not exceed the item target is skipped", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  logWorking("Back Squat", 100);
  const env = reachEnvelope({
    candidates: [reachCandidate("Back Squat", 110, { muscle_group: "quads" })],
  });
  const { session, validation } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 110 }]),
    env
  );
  assert.ok(session);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].target_weight, 110);
  assert.equal(session.items[0].reach, undefined);
  assert.equal(validation.reach_landed, false);
  assert.ok(REACH_NO_ROOM_WHY.includes(env.reach.why));
});

test("a first eligible host that cannot seat a heavier look does not consume — the next compound hosts", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  logWorking("Back Squat", 100);
  logWorking("Bench Press", 155);
  const env = reachEnvelope({
    candidates: [
      reachCandidate("Back Squat", 110, { muscle_group: "quads" }),
      reachCandidate("Bench Press", 155, { muscle_group: "chest", rep_low: 6, rep_high: 8 }),
    ],
  });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 110 },
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
    ]),
    env
  );
  assert.ok(session);
  const squats = session.items.filter((i) => i.exercise === "Back Squat");
  const benches = session.items.filter((i) => i.exercise === "Bench Press");
  assert.equal(squats.length, 1, "the first compound stays one card — one step above 100 is not above 110");
  assert.equal(squats[0].reach, undefined);
  assert.equal(benches.length, 2, "the next compound hosts the reach");
  assert.equal(benches[0].sets, 1);
  assert.equal(benches[0].target_weight, 160, "one earned step above the logged 155");
  assert.equal(benches[0].reach.weight, 160);
  assert.equal(validation.reach_landed, true);
  assert.ok(!env.soft_preferences.some((e) => e.code === "reach_no_room"));
});

test("a null-target loaded lift with no history is skipped, not AMRAP'd", () => {
  repo.upsertExercise({ name: "Incline Press", muscle_group: "chest", mode: "reps" });
  const env = reachEnvelope({
    candidates: [reachCandidate("Incline Press", null, { muscle_group: "chest" })],
  });
  const { session, validation } = normalizeComposedSession(
    agentSession([{ exercise: "Incline Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: null }]),
    env
  );
  assert.ok(session);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].target_weight, null);
  assert.equal(session.items[0].reach, undefined, "no AMRAP on an unlogged loaded lift");
  assert.equal(validation.reach_landed, false);
  assert.ok(REACH_NO_ROOM_WHY.includes(env.reach.why));
});

test("hold_aggression keeps reach but skips the challenge item", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 }]),
    reachEnvelope({
      candidates: [reachCandidate("Back Squat", 225, { muscle_group: "quads" })],
      precedence: ["reach_trimmed_by_fueling"],
      soft_preferences: [
        { code: "reach_trimmed_by_fueling", detail: "Fueling keeps today's reach to the working sets" },
      ],
    })
  );
  assert.ok(session);
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].target_weight, 225);
  assert.equal(session.items[0].reach, undefined);
});

test("a reach top set counts as one working set against the day's cap", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  logWorking("Back Squat", 225);
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 }]),
    reachEnvelope({
      candidates: [reachCandidate("Back Squat", 225, { muscle_group: "quads" })],
      caps: { volume: "reduced", intensity: "normal", duration_min: 60 },
    })
  );
  assert.ok(session);
  const total = session.items.reduce((sum, i) => sum + (Number(i.sets) || 0), 0);
  assert.ok(total <= 12, `${total} sets is inside the reduced budget`);
  assert.equal(session.items[0].sets, 1);
});

test("a fully-budgeted reach day keeps push and says the reach lives in the working sets", () => {
  const names = ["Lift A", "Lift B", "Lift C", "Lift D", "Lift E", "Lift F", "Lift G"];
  const candidates = [];
  const items = [];
  for (const name of names) {
    repo.upsertExercise({ name, muscle_group: "quads", mode: "reps" });
    logWorking(name, 100);
    candidates.push(reachCandidate(name, 100, { muscle_group: "quads", sets: 1, rep_low: 5, rep_high: 5 }));
    items.push({ exercise: name, sets: 1, rep_low: 5, rep_high: 5, target_weight: 100 });
  }
  const env = reachEnvelope({
    candidates,
    caps: { volume: "reduced", intensity: "normal", duration_min: 90 },
    precedence: ["backed_day_reach"],
    rationale: [
      { code: "template_rotation", text: "Training day." },
      { code: "backed_day_reach", text: "You've earned a heavier look at this one today" },
    ],
  });
  const { session, validation } = normalizeComposedSession(agentSession(items), env);
  assert.ok(session);
  assert.equal(session.items.length, 7, "no extra item fits once the day is already at its cap");
  assert.ok(!session.items.some((i) => i.reach), "no reach metadata on a card");
  assert.equal(validation.reach_landed, false);
  assert.equal(env.reach.level, "push");
  assert.ok(REACH_NO_ROOM_WHY.includes(env.reach.why));
  assert.ok(env.rationale.some((line) => line.code === "reach_no_room"));
  assert.ok(!env.rationale.some((line) => line.code === "backed_day_reach"));
  assert.doesNotMatch(env.reach.why, /heavier look|top set if the bar/i);
});

// ── one challenge top set a session, whoever authored it ────────────────────
// The agent's nested top_set and the server's own reach are two routes to the
// same thing: a heavy single on a card. The day gets ONE. And an agent single is
// not evidence the envelope's reach landed — its load comes through
// safeAgentWeight, which falls back to the lift's PLAN target when nothing is
// logged, and a prescription has never proved anything about what moves.

test("an agent's nested top set takes the day's one challenge slot — no second heavy single", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  logWorking("Back Squat", 225);
  logWorking("Bench Press", 155);
  const env = reachEnvelope({
    candidates: [
      reachCandidate("Back Squat", 225, { muscle_group: "quads" }),
      reachCandidate("Bench Press", 155, { muscle_group: "chest", rep_low: 6, rep_high: 8 }),
    ],
  });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      {
        exercise: "Back Squat",
        sets: 3,
        rep_low: 5,
        rep_high: 7,
        target_weight: 225,
        top_set: { sets: 1, reps: 3, target_weight: 240 },
      },
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
    ]),
    env
  );
  assert.ok(session);
  assert.equal(session.items.length, 3, "the squat splits into two cards; the bench stays one");
  assert.equal(
    session.items.filter((i) => i.exercise === "Bench Press").length,
    1,
    "the next compound does not host a second heavy single"
  );
  assert.equal(session.items[0].target_weight, 240, "the agent's single leads its own block");
  assert.equal(session.items[1].target_weight, 225);
  assert.equal(session.items[0].reach, undefined, "an agent-authored card never carries the envelope's reach");
  assert.equal(validation.reach_landed, true, "240 over a logged 225 is the heavier look");
  assert.ok(!env.soft_preferences.some((e) => e.code === "reach_no_room"));
});

test("an agent single built off a plan number is not the day's reach", () => {
  repo.upsertExercise({ name: "Incline Press", muscle_group: "chest", mode: "reps" });
  // A plan target and nothing logged: safeAgentWeight anchors on the prescription.
  repo.savePlanDay(1, "Push", "Upper push", [
    { exercise: "Incline Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 200 },
  ]);
  const env = reachEnvelope();
  const { session, validation } = normalizeComposedSession(
    agentSession([
      {
        exercise: "Incline Press",
        sets: 3,
        rep_low: 6,
        rep_high: 8,
        target_weight: 200,
        top_set: { sets: 1, reps: 3, target_weight: 240 },
      },
    ]),
    env
  );
  assert.ok(session);
  assert.equal(session.items.length, 2, "the agent's own single still renders");
  assert.equal(session.items[0].target_weight, 220, "one step off the plan number, not the asked-for 240");
  assert.equal(session.items[0].reach, undefined);
  assert.equal(session.items[1].reach, undefined);
  assert.equal(validation.reach_landed, false, "no logged working weight, so nothing was proved");
  assert.equal(env.reach.level, "push");
  assert.ok(REACH_NO_ROOM_WHY.includes(env.reach.why));
  assert.ok(env.soft_preferences.some((e) => e.code === "reach_no_room"));
});

test("two agent-nested top sets on one day still seat only one top-set card", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  logWorking("Back Squat", 225);
  logWorking("Bench Press", 155);
  const env = reachEnvelope({
    candidates: [
      reachCandidate("Back Squat", 225, { muscle_group: "quads" }),
      reachCandidate("Bench Press", 155, { muscle_group: "chest", rep_low: 6, rep_high: 8 }),
    ],
  });
  const { session } = normalizeComposedSession(
    agentSession([
      {
        exercise: "Back Squat",
        sets: 3,
        rep_low: 5,
        rep_high: 7,
        target_weight: 225,
        top_set: { sets: 1, reps: 3, target_weight: 240 },
      },
      {
        exercise: "Bench Press",
        sets: 3,
        rep_low: 6,
        rep_high: 8,
        target_weight: 155,
        top_set: { sets: 1, reps: 3, target_weight: 175 },
      },
    ]),
    env
  );
  assert.ok(session);
  assert.equal(session.items.length, 3, "the squat splits into two cards; the bench's own nested single is refused");
  assert.equal(session.items[0].exercise, "Back Squat");
  assert.equal(session.items[0].target_weight, 240, "the first item's nested single takes the day's one slot");
  assert.equal(session.items[1].target_weight, 225);
  assert.equal(
    session.items.filter((i) => i.exercise === "Bench Press").length,
    1,
    "the second item's own nested top_set is dropped, not seated as a second card"
  );
  assert.equal(session.items[2].target_weight, 155, "the bench renders as its plain working block only");
});

// ── stated run days bind every composed run ──────────────────────────────────
// Stated run days anchor the run engine, and plan days carry no runs at all
// (migration 110), so a composed run on a weekday the athlete did not name for
// running is dropped whoever authored it — there is no plan-prescribed exception.

const WEDNESDAY = "2031-07-02"; // DATE is a Tuesday; the day after is not a stated run day
const TUE_THU_SAT = {
  days: [
    { dow: 2, kind: "quality" },
    { dow: 4, kind: "easy" },
    { dow: 6, kind: "long" },
  ],
  source: "athlete",
};

function statedRunDaysProfile() {
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_schedule: TUE_THU_SAT,
  });
}

test("a plan day cannot prescribe a run, so an unscheduled weekday's run is dropped even on a template day", () => {
  statedRunDaysProfile();
  repo.savePlanDay(3, "Easy run", "Easy aerobic", [
    { kind: "cardio", exercise: "Easy run", target_distance_km: 6, target_zone: "easy" },
  ]);
  assert.deepEqual(repo.getPlanDay(3).items, [], "the cardio row is stripped on save");
  const env = () =>
    envelope({
      date: WEDNESDAY,
      template: { day_number: 3, plan_day_id: repo.getPlanDay(3).id, focus: "Easy aerobic", intent: "template" },
    });
  const { session, validation } = normalizeComposedSession(
    agentSession([{ kind: "cardio", exercise: "Easy run", target_distance_km: 6, target_zone: "easy" }]),
    env()
  );
  assert.ok(!session?.items.some((i) => i.kind === "cardio"), "Wednesday is not a stated run day");
  assert.ok(validation.rejected.some((r) => r.reason === "not_scheduled_run_day"));
  // The deterministic half of the same morning carries no run either — same normalizer.
  const deterministic = deterministicComposedSession(env());
  assert.ok(!deterministic.items.some((i) => i.kind === "cardio"));
});

test("a composed run on a stated run weekday survives the scheduled-day filter", () => {
  statedRunDaysProfile();
  const { session, validation } = normalizeComposedSession(
    agentSession([{ kind: "cardio", exercise: "Easy run", target_distance_km: 6, target_zone: "easy" }]),
    envelope({ date: DATE })
  );
  assert.ok(session);
  assert.equal(session.items.length, 1, "Tuesday is a stated run day");
  assert.equal(session.items[0].kind, "cardio");
  assert.ok(!validation.rejected.some((r) => r.reason === "not_scheduled_run_day"));
});

test("a run nobody planned is still dropped on an unscheduled weekday", () => {
  statedRunDaysProfile();
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  repo.savePlanDay(3, "Push", "Upper push", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
  ]);
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 155 },
      { kind: "cardio", exercise: "Easy run", target_distance_km: 6, target_zone: "easy" },
    ]),
    envelope({
      date: WEDNESDAY,
      template: { day_number: 3, plan_day_id: repo.getPlanDay(3).id, focus: "Upper push", intent: "template" },
    })
  );
  assert.ok(session);
  assert.ok(!session.items.some((i) => i.kind === "cardio"), "an engine-suggested run stays off an unnamed day");
  assert.ok(validation.rejected.some((r) => r.reason === "not_scheduled_run_day"));
});

test("a non-reach day is unchanged by the reach injection path", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 }]),
    envelope({ candidates: [reachCandidate("Back Squat", 225, { muscle_group: "quads" })] })
  );
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].target_weight, 225);
  assert.equal(session.items[0].reach, undefined);
});

test("composition notes are variant sets that hold the reading grammar", () => {
  const phrases = [...REDUCED_AREA_NOTES, ...EASED_TODAY_NOTES, ...HOLD_TARGET_NOTES];
  assert.ok(REDUCED_AREA_NOTES.length >= 4);
  assert.ok(EASED_TODAY_NOTES.length >= 4);
  assert.ok(HOLD_TARGET_NOTES.length >= 4);
  for (const phrase of phrases) {
    assert.equal(violatesReadingGrammar(phrase), null, `reading grammar: ${phrase}`);
    assert.doesNotMatch(
      phrase,
      /\b(?:comparable|dose evidence|non_comparable|envelope|cap|reground|snapshot)\b/i,
      phrase
    );
  }
});

test("eased-today variants remain a standalone sentence after the session prefix is stripped", () => {
  const EASED_PREFIX = /^eased for today[\s.,:;·—–-]*/i;
  assert.ok(EASED_TODAY_NOTES.length >= 4);
  for (const phrase of EASED_TODAY_NOTES) {
    const remainder = phrase.replace(EASED_PREFIX, "").trim();
    if (!remainder) continue;
    assert.match(remainder[0], /[A-Z]/, remainder);
    assert.match(remainder, /\.$/, remainder);
    assert.doesNotMatch(remainder, /every movement sits a notch lighter/i, remainder);
  }
});

test("a hold-day item with a progression why keeps exactly one hold sentence", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  repo.savePlanDay(1, "Hold anchors", "No progression today", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
  ]);
  const why = "Flat lately — hold the load and earn one more clean rep first.";
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100, note: why }]),
    envelope({
      template: { day_number: 1, plan_day_id: repo.getPlanDay(1).id, focus: "Hold anchors", intent: "template" },
      candidates: [
        {
          exercise: "Bench Press",
          muscle_group: "chest",
          action: "hold",
          reason_code: "progression_hold",
          substitution_for: null,
          note: why,
          progression_evidence: {
            delta_text: null,
            why,
            reground: false,
            autoregulated: false,
            movement_response: null,
            rep_step: false,
            dose_eligibility: null,
          },
        },
      ],
    })
  );
  assert.ok(session);
  const item = session.items.find((row) => row.exercise === "Bench Press");
  assert.equal(item.note, why, "composition does not prepend a second hold sentence");
  const holdSentences = String(item.note)
    .split(/\.\s+/)
    .map((part) => part.trim())
    .filter((part) => part && /hold/i.test(part));
  assert.equal(holdSentences.length, 1, "exactly one hold sentence reaches the card");
  assert.ok(!HOLD_TARGET_NOTES.some((line) => line !== why && String(item.note).includes(line)));
});

test("a reduced hold still says the area is carrying recent work", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  anchorPlan([{ exercise: "Back Squat", sets: 5, rep_low: 5, rep_high: 7, target_weight: 200 }]);
  const why = "Holding while you rebuild range on this one.";
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Back Squat", sets: 5, rep_low: 5, rep_high: 7, target_weight: 200, note: why }]),
    reducedEnvelope(["quads"], {
      template: {
        day_number: 1,
        plan_day_id: repo.getPlan().find((d) => d.day_number === 1).id,
        focus: "Lower",
        intent: "template",
      },
      candidates: [
        {
          exercise: "Back Squat",
          muscle_group: "quads",
          action: "hold",
          reason_code: "progression_hold",
          substitution_for: null,
          note: why,
          progression_evidence: {
            delta_text: null,
            why,
            reground: false,
            autoregulated: false,
            movement_response: null,
            rep_step: false,
            dose_eligibility: null,
          },
        },
      ],
    })
  );
  const squat = session.items.find((row) => row.exercise === "Back Squat");
  assert.ok(
    REDUCED_AREA_NOTES.some((line) => String(squat.note).startsWith(line)),
    "the area note is added because it is extra"
  );
  assert.match(squat.note, /rebuild range/);
  assert.ok(!HOLD_TARGET_NOTES.some((line) => String(squat.note).startsWith(line)), "no second generic hold prepend");
});

test("a plan coach note does not suppress the hold explanation", () => {
  repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
  repo.savePlanDay(1, "Hold anchors", "No progression today", [
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
  ]);
  const coachNote = "Keep the shoulder blades tucked.";
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100, note: coachNote }]),
    envelope({
      template: { day_number: 1, plan_day_id: repo.getPlanDay(1).id, focus: "Hold anchors", intent: "template" },
      candidates: [
        {
          exercise: "Bench Press",
          muscle_group: "chest",
          action: "hold",
          reason_code: "progression_hold",
          substitution_for: null,
          progression_evidence: {
            delta_text: null,
            why: null,
            reground: false,
            autoregulated: false,
            movement_response: null,
            rep_step: false,
            dose_eligibility: null,
          },
        },
      ],
    })
  );
  assert.ok(session);
  const item = session.items.find((row) => row.exercise === "Bench Press");
  assert.ok(
    HOLD_TARGET_NOTES.some((line) => String(item.note).startsWith(line)),
    "a plan coach note is not a progression why, so the hold sentence still lands"
  );
  assert.match(item.note, /shoulder blades/);
});

// The athlete's own note carries their safety cues, and a "sharp pain = stop" sits
// at the END of a long one. Composing the eased sentence in front of it used to
// slice the combined string to 500 chars, cutting the tail — so the longer eased
// variants silently deleted exactly the line that must survive. The server's
// sentence is the part that yields now.
const STOP_CUE = "If anything turns sharp, stop the set — sharp pain = stop.";
const LONG_ATHLETE_NOTE = `${"Brace hard and keep the ribs stacked over the pelvis on every rep. ".repeat(6).trim()} ${STOP_CUE}`;

test("an eased day never truncates the athlete's own note away from its stop cue", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  assert.ok(LONG_ATHLETE_NOTE.length > 400 && LONG_ATHLETE_NOTE.length < 500, "the live shape: long, but under the cap");
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225, note: LONG_ATHLETE_NOTE },
    ]),
    envelope({ caps: { volume: "normal", intensity: "easy", duration_min: 60 } })
  );
  assert.ok(session);
  const item = session.items.find((row) => row.exercise === "Back Squat");
  assert.ok(item.note.includes(STOP_CUE), "the stop cue survives verbatim");
  assert.ok(item.note.endsWith(STOP_CUE), "and it is still the last thing the athlete reads");
  assert.ok(item.note.includes(LONG_ATHLETE_NOTE), "the whole note the athlete wrote is intact, not trimmed");
});

test("an eased day still composes its sentence in front of a short athlete note", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  const { session } = normalizeComposedSession(
    agentSession([
      { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225, note: "Belt on for the top set." },
    ]),
    envelope({ caps: { volume: "normal", intensity: "easy", duration_min: 60 } })
  );
  const item = session.items.find((row) => row.exercise === "Back Squat");
  assert.match(item.note, /^Eased for today\./, "there is room, so the composition sentence still leads");
  assert.ok(item.note.endsWith("Belt on for the top set."), "and the athlete's note is untouched behind it");
});

// ---------- the reach law: a heavier look only where the engine is moving the lift ----------
// Synthetic numbers throughout. DATE is 2031-07-01.

test("a reach never lands on a lift the progression engine is holding, deloading, re-grounding or rotating", () => {
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.logSetByName({ date: "2031-06-24", exercise: "Dumbbell Bench Press", weight: 55, reps: 10 });
  for (const [action, extra] of [
    ["hold", {}],
    ["deload", {}],
    ["vary", {}],
    ["overload", { progression_evidence: { reground: true } }],
  ]) {
    const env = reachEnvelope({
      candidates: [{ ...reachCandidate("Dumbbell Bench Press", 55, { muscle_group: "chest", action, rep_low: 8, rep_high: 10 }), ...extra }],
    });
    const { session, validation } = normalizeComposedSession(
      agentSession([{ exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 }]),
      env
    );
    assert.equal(session.items.length, 1, `${action}${extra.progression_evidence ? " (reground)" : ""}: no top set card`);
    assert.equal(session.items[0].reach, undefined);
    assert.equal(validation.reach_landed, false);
    assert.ok(REACH_NO_ROOM_WHY.includes(env.reach.why), "the envelope does not promise a reach that is not on a card");
  }
});

test("a held first lift leaves the reach to the next lift the engine is moving", () => {
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Chest-Supported Row", muscle_group: "back", mode: "reps" });
  repo.logSetByName({ date: "2031-06-24", exercise: "Dumbbell Bench Press", weight: 55, reps: 10 });
  repo.logSetByName({ date: "2031-06-24", exercise: "Chest-Supported Row", weight: 100, reps: 12 });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 },
      { exercise: "Chest-Supported Row", sets: 3, rep_low: 10, rep_high: 12, target_weight: 100 },
    ]),
    reachEnvelope({
      candidates: [
        reachCandidate("Dumbbell Bench Press", 55, { muscle_group: "chest", action: "hold", rep_low: 8, rep_high: 10 }),
        reachCandidate("Chest-Supported Row", 100, { muscle_group: "back", rep_low: 10, rep_high: 12 }),
      ],
    })
  );
  assert.equal(session.items.filter((i) => i.exercise === "Dumbbell Bench Press").length, 1);
  const rows = session.items.filter((i) => i.exercise === "Chest-Supported Row");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].reach);
  assert.equal(validation.reach_landed, true);
});

test("a lift last done weeks ago has no current working weight to reach from", () => {
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  // 35 days before DATE — past the reach's three-week exposure window.
  repo.logSetByName({ date: "2031-05-27", exercise: "Dumbbell Bench Press", weight: 55, reps: 10 });
  const env = reachEnvelope({
    candidates: [reachCandidate("Dumbbell Bench Press", 55, { muscle_group: "chest", rep_low: 8, rep_high: 10 })],
  });
  const { session, validation } = normalizeComposedSession(
    agentSession([{ exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 }]),
    env
  );
  assert.equal(session.items.length, 1, "stale evidence seats no top set");
  assert.equal(validation.reach_landed, false);

  // The same lift done inside the window hosts.
  repo.logSetByName({ date: "2031-06-24", exercise: "Dumbbell Bench Press", weight: 55, reps: 10 });
  const fresh = normalizeComposedSession(
    agentSession([{ exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 }]),
    reachEnvelope({
      candidates: [reachCandidate("Dumbbell Bench Press", 55, { muscle_group: "chest", rep_low: 8, rep_high: 10 })],
    })
  );
  assert.equal(fresh.validation.reach_landed, true);
});

test("the reach is one earned step above the log, at the reps the lift's own estimate carries with one in hand", () => {
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.logSetByName({ date: "2031-06-24", exercise: "Dumbbell Bench Press", weight: 55, reps: 10 });
  const compose = () =>
    normalizeComposedSession(
      agentSession([{ exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 }]),
      reachEnvelope({
        candidates: [reachCandidate("Dumbbell Bench Press", 55, { muscle_group: "chest", rep_low: 8, rep_high: 10 })],
      })
    ).session;
  const [top, block] = compose().items;
  // 55 × 10 → Epley 73.3. At 60 that holds 6.7 reps; one left in hand → 5. The old
  // flat ×1.075 at 3–5 asked 60 × 3 — under the lift's own estimate.
  assert.equal(top.target_weight, 60);
  assert.equal(top.rep_low, 5);
  assert.equal(top.rep_high, 5);
  assert.deepEqual([top.reach.weight, top.reach.reps], [60, 5]);
  assert.ok(top.target_weight * (1 + (top.rep_low + 1) / 30) <= 55 * (1 + 10 / 30) + 1e-9, "never past the estimate with a rep in hand");
  assert.equal(block.target_weight, 55, "the block below keeps its own load");

  // Reps in reserve logged on the same set raise the estimate — and never past the block's floor.
  resetTables("logged_sets", "sessions");
  repo.logSetByName({ date: "2031-06-24", exercise: "Dumbbell Bench Press", weight: 55, reps: 10, rir: 2 });
  const [roomier] = compose().items;
  assert.deepEqual([roomier.target_weight, roomier.rep_low], [60, 7]);
  resetTables("logged_sets", "sessions");
  repo.logSetByName({ date: "2031-06-24", exercise: "Dumbbell Bench Press", weight: 55, reps: 15, rir: 3 });
  const [capped] = compose().items;
  assert.equal(capped.rep_low, 8, "the reach never asks for more reps than the block's floor");

  // A log with no rep to spare above it seats nothing.
  resetTables("logged_sets", "sessions");
  repo.logSetByName({ date: "2031-06-24", exercise: "Dumbbell Bench Press", weight: 55, reps: 1 });
  assert.equal(compose().items.length, 1, "no room for a heavier load with a rep in hand");
});

test("an overload that already steps the load is the day's reach — no second heavier set on top", () => {
  repo.upsertExercise({ name: "Barbell Curl", muscle_group: "biceps", mode: "reps" });
  repo.logSetByName({ date: "2031-06-24", exercise: "Barbell Curl", weight: 80, reps: 10, rir: 2 });
  const env = reachEnvelope({
    candidates: [reachCandidate("Barbell Curl", 82.5, { muscle_group: "biceps", rep_low: 8, rep_high: 10 })],
  });
  const { session, validation } = normalizeComposedSession(
    agentSession([{ exercise: "Barbell Curl", sets: 2, rep_low: 8, rep_high: 10, target_weight: 82.5 }]),
    env
  );
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].target_weight, 82.5);
  assert.equal(validation.reach_landed, false);
});

// ---------- composition never moves the prescription on its own ----------

test("a day-level hold keeps the plan's stepped-up target, not an older logged weight", () => {
  repo.upsertExercise({ name: "Chest-Supported Row", muscle_group: "back", mode: "reps" });
  repo.logSetByName({ date: "2031-06-24", exercise: "Chest-Supported Row", weight: 35, reps: 10, rir: 4 });
  repo.logSetByName({ date: "2031-06-24", exercise: "Chest-Supported Row", weight: 35, reps: 10, rir: 4 });
  const target = { mode: "reps", sets: 3, rep_low: 10, rep_high: 12, target_weight: 40, target_seconds: null };
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Chest-Supported Row", sets: 3, rep_low: 10, rep_high: 12, target_weight: 40 }]),
    envelope({
      caps: { volume: "normal", intensity: "hold", duration_min: 60 },
      candidates: [
        { ...reachCandidate("Chest-Supported Row", 40, { muscle_group: "back", rep_low: 10, rep_high: 12 }), current_target: target, authorized_target: target },
      ],
    })
  );
  assert.equal(session.items[0].target_weight, 40, "the hold keeps the prescription, it does not drag it back to 35");

  // A held lift with no progression read (an agent's own movement) still anchors on the log.
  const bare = normalizeComposedSession(
    agentSession([{ exercise: "Chest-Supported Row", sets: 3, rep_low: 10, rep_high: 12, target_weight: 50 }]),
    envelope({ caps: { volume: "normal", intensity: "hold", duration_min: 60 } })
  );
  assert.equal(bare.session.items[0].target_weight, 35);
});

test("a card whose number moved off the plan's never keeps a reason that names the old number", () => {
  repo.upsertExercise({ name: "Barbell Curl", muscle_group: "biceps", mode: "reps" });
  const stepped = { mode: "reps", sets: 2, rep_low: 8, rep_high: 10, target_weight: 82.5, target_seconds: null };
  const candidate = {
    ...reachCandidate("Barbell Curl", 82.5, { muscle_group: "biceps", rep_low: 8, rep_high: 10 }),
    authorized_target: stepped,
    progression_evidence: { why: "Stepping up from your real working weight (80 lb)." },
    brain_change_reason: "Resetting to 75 lb so every set is winnable.",
    brain_decision_id: 41,
    brain_change_reason_provenance: { reason_code: "training_evidence" },
    brain_change_reversible: true,
  };
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Barbell Curl", sets: 2, rep_low: 8, rep_high: 10, target_weight: 75 }]),
    envelope({ candidates: [candidate] })
  );
  assert.equal(session.items[0].target_weight, 82.5);
  // The stale sentence goes with its decision link; the verdict is not repeated
  // here because the card's rx line already carries it.
  assert.equal(session.items[0].brain_change_reason, null);
  assert.equal(session.items[0].brain_decision_id, null);
  assert.equal(session.items[0].brain_change_reason_provenance, null);

  // Eased below the authorized target: a verdict naming another load is dropped too.
  const eased = normalizeComposedSession(
    agentSession([{ exercise: "Barbell Curl", sets: 2, rep_low: 8, rep_high: 10, target_weight: 75 }]),
    envelope({ caps: { volume: "normal", intensity: "easy", duration_min: 60 }, candidates: [candidate] })
  );
  assert.ok(eased.session.items[0].target_weight < 82.5);
  assert.equal(eased.session.items[0].brain_change_reason, null);
});

test("an earned floor that raises the card says so in its own reason", () => {
  repo.upsertExercise({ name: "Barbell Deadlift", muscle_group: "hamstrings", mode: "reps" });
  const held = { mode: "reps", sets: 3, rep_low: 6, rep_high: 8, target_weight: 165, target_seconds: null };
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Barbell Deadlift", sets: 3, rep_low: 6, rep_high: 8, target_weight: 165 }]),
    envelope({
      candidates: [
        {
          ...reachCandidate("Barbell Deadlift", 165, { muscle_group: "hamstrings", action: "hold", rep_low: 6, rep_high: 8 }),
          current_target: held,
          authorized_target: held,
          earned_floor: 195,
          brain_change_reason: "Resetting to 165 lb.",
          brain_decision_id: 7,
        },
      ],
    })
  );
  assert.equal(session.items[0].target_weight, 195);
  assert.equal(session.items[0].brain_decision_id, null, "the floor is not the plan decision's number");
  assert.match(session.items[0].brain_change_reason, /195 lb/);
  assert.doesNotMatch(session.items[0].brain_change_reason, /165/);
});

test("a manual plan snapshot adds and raises nothing — no reach, no earned floor, no step above what was written", () => {
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Barbell Curl", muscle_group: "biceps", mode: "reps" });
  repo.upsertExercise({ name: "Chest-Supported Row", muscle_group: "back", mode: "reps" });
  repo.logSetByName({ date: "2031-06-24", exercise: "Dumbbell Bench Press", weight: 55, reps: 10 });
  repo.logSetByName({ date: "2031-06-24", exercise: "Barbell Curl", weight: 80, reps: 10, rir: 2 });
  repo.logSetByName({ date: "2031-06-24", exercise: "Chest-Supported Row", weight: 35, reps: 10, rir: 4 });
  const t = (w, lo = 8, hi = 10) => ({ mode: "reps", sets: 3, rep_low: lo, rep_high: hi, target_weight: w, target_seconds: null });
  const env = reachEnvelope({
    candidates: [
      reachCandidate("Dumbbell Bench Press", 55, { muscle_group: "chest", rep_low: 8, rep_high: 10 }),
      { ...reachCandidate("Barbell Curl", 82.5, { muscle_group: "biceps" }), authorized_target: t(82.5) },
      { ...reachCandidate("Chest-Supported Row", 35, { muscle_group: "back", action: "hold" }), authorized_target: t(35, 10, 12), earned_floor: 45 },
    ],
  });
  const raw = agentSession([
    { exercise: "Dumbbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 55 },
    { exercise: "Barbell Curl", sets: 2, rep_low: 8, rep_high: 10, target_weight: 75 },
    { exercise: "Chest-Supported Row", sets: 3, rep_low: 10, rep_high: 12, target_weight: 40 },
  ]);
  const { session, validation } = normalizeComposedSession(raw, env, { planSnapshot: true });
  const byName = Object.fromEntries(session.items.map((i) => [i.exercise, i]));
  assert.equal(session.items.length, 3, "no top set card");
  assert.equal(validation.reach_landed, false);
  assert.equal(byName["Barbell Curl"].target_weight, 75, "a progression step above the written load is not taken");
  assert.equal(byName["Chest-Supported Row"].target_weight, 35, "a lowering hold still applies");
  assert.ok(!session.items.some((i) => i.reach));

  // The adaptive path over the same envelope takes the step and seats the reach.
  const adaptive = normalizeComposedSession(raw, reachEnvelope({ candidates: env.candidates }));
  assert.equal(adaptive.session.items.find((i) => i.exercise === "Barbell Curl").target_weight, 82.5);
  assert.equal(adaptive.validation.reach_landed, true);
});

test("a kilogram figure in a reason is never read as the card's pound load", () => {
  repo.upsertExercise({ name: "Barbell Curl", muscle_group: "biceps", mode: "reps" });
  repo.logSetByName({ date: "2031-06-24", exercise: "Barbell Curl", weight: 80, reps: 10 });
  const candidate = {
    ...reachCandidate("Barbell Curl", 80, { muscle_group: "biceps" }),
    brain_change_reason: "Your 36 kg sets carried the range — setting the plan there.",
    brain_decision_id: 9,
  };
  const { session } = normalizeComposedSession(
    agentSession([{ exercise: "Barbell Curl", sets: 2, rep_low: 8, rep_high: 10, target_weight: 80 }]),
    envelope({ candidates: [candidate] })
  );
  assert.equal(session.items[0].brain_change_reason, candidate.brain_change_reason);
  assert.equal(session.items[0].brain_decision_id, 9);
});

test("a rotated-in substitute on a hold day never inherits the replaced lift's target", () => {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.upsertExercise({ name: "Dumbbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.logSetByName({ date: "2031-06-28", exercise: "Barbell Bench Press", weight: 185, reps: 6 });
  const t = { mode: "reps", sets: 3, rep_low: 6, rep_high: 8, target_weight: 185, target_seconds: null };
  const candidate = {
    exercise: "Dumbbell Bench Press",
    muscle_group: "chest",
    action: "vary",
    reason_code: null,
    substitution_for: "Barbell Bench Press",
    note: null,
    current_target: t,
    authorized_target: null,
  };
  for (const [intensity, requested] of [["hold", null], ["hold", 60]]) {
    const { session } = normalizeComposedSession(
      agentSession([{ exercise: "Dumbbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: requested }]),
      envelope({ caps: { volume: "normal", intensity, duration_min: 60 }, candidates: [candidate] })
    );
    const weight = session.items[0].target_weight;
    assert.ok(weight == null || weight < 185, `${intensity}/${requested}: no barbell number on the dumbbell card (${weight})`);
  }
});

test("an agent's nested top set is dropped over a lift the engine is holding, and marks its block when kept", () => {
  repo.upsertExercise({ name: "Back Squat", muscle_group: "quads", mode: "reps" });
  repo.logSetByName({ date: "2031-06-24", exercise: "Back Squat", weight: 225, reps: 5 });
  const raw = () =>
    agentSession([
      {
        exercise: "Back Squat",
        sets: 3,
        rep_low: 5,
        rep_high: 7,
        target_weight: 225,
        top_set: { sets: 1, reps: 2, target_weight: 235 },
      },
    ]);
  for (const [action, extra] of [["hold", {}], ["deload", {}], ["overload", { progression_evidence: { reground: true } }]]) {
    const { session } = normalizeComposedSession(
      raw(),
      envelope({ candidates: [{ ...reachCandidate("Back Squat", 225, { muscle_group: "quads", action }), ...extra }] })
    );
    assert.equal(session.items.length, 1, `${action}: the agent single is dropped`);
  }
  const { session } = normalizeComposedSession(
    raw(),
    envelope({ candidates: [reachCandidate("Back Squat", 225, { muscle_group: "quads" })] })
  );
  assert.equal(session.items.length, 2);
  assert.equal(session.items[0].sets, 1);
  assert.equal(session.items[0].top_set_of, "Back Squat", "the single names the block it leads");
  assert.equal(session.items[0].reach, undefined, "and is never a reach");
});

test("a reach only ever lands on a compound — a curl never hosts", () => {
  repo.upsertExercise({ name: "Barbell Curl", muscle_group: "biceps", mode: "reps" });
  repo.upsertExercise({ name: "Chest-Supported Row", muscle_group: "back", mode: "reps" });
  repo.logSetByName({ date: "2031-06-24", exercise: "Barbell Curl", weight: 60, reps: 12 });
  repo.logSetByName({ date: "2031-06-24", exercise: "Chest-Supported Row", weight: 100, reps: 12 });
  const { session, validation } = normalizeComposedSession(
    agentSession([
      { exercise: "Barbell Curl", sets: 2, rep_low: 8, rep_high: 10, target_weight: 60 },
      { exercise: "Chest-Supported Row", sets: 3, rep_low: 10, rep_high: 12, target_weight: 100 },
    ]),
    reachEnvelope({
      candidates: [
        reachCandidate("Barbell Curl", 60, { muscle_group: "biceps", rep_low: 8, rep_high: 10 }),
        reachCandidate("Chest-Supported Row", 100, { muscle_group: "back", rep_low: 10, rep_high: 12 }),
      ],
    })
  );
  assert.equal(session.items.filter((i) => i.exercise === "Barbell Curl").length, 1, "the curl stays one card");
  assert.equal(session.items.filter((i) => i.exercise === "Chest-Supported Row").length, 2, "the row hosts");
  assert.equal(validation.reach_landed, true);
});
