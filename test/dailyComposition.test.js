import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { composeDailySession } from "../dist/coachOps.js";
import { deterministicComposedSession, normalizeComposedSession } from "../dist/repo/daily-composition.js";
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
  assert.ok(session.items.every((item) => /Holding the current target today/.test(item.note)));
  assert.equal(validation.capped, true);
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

for (const area of ["knee", "ankle", "hip"]) {
  test(`protective ${area} constraints flow through cardio gather, decision, and composition`, () => {
    repo.upsertExercise({ name: "Bench Press", muscle_group: "chest", mode: "reps" });
    repo.savePlanDay(1, "Hybrid", "Run plus upper", [
      {
        exercise: "Tempo run",
        kind: "cardio",
        note: DESCRIPTIVE_TEMPO_NOTE,
        target_duration_min: 40,
        target_zone: "Z3",
      },
      { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
    ]);
    repo.addContextEvent({
      kind: "injury",
      title: `Protective ${area}`,
      start_date: DATE,
      meta: { area, severity: "moderate" },
    });

    const snapshot = repo.gatherDailyDecisionSnapshot(DATE);
    const cardio = snapshot.plan_items.find((item) => item.kind === "cardio");
    assert.equal(cardio.exercise, "Tempo run", "descriptive prose derives a movement-bearing run identity");
    assert.equal(repo.getPlanDay(1).items[0].note, DESCRIPTIVE_TEMPO_NOTE, "athlete-facing detail remains stored");
    const decision = repo.buildDailySessionDecision(snapshot, { now: "2031-07-01T12:00:00.000Z" });
    assert.ok(decision.protective_exclusions.some((item) => item.areas.includes(area)));
    assert.equal(
      decision.candidates.find((item) => item.exercise === "Tempo run")?.action,
      "exclude",
      "the pure decision routes the derived run identity through pain relevance"
    );

    const session = deterministicComposedSession(decision);
    assert.deepEqual(session.items.map((item) => item.exercise), ["Bench Press"]);
  });
}

test("descriptive tempo survives save, gather, decision, and composition under unrelated shoulder protection", () => {
  repo.savePlanDay(1, "Run", "Endurance", [
    {
      exercise: "Tempo run",
      kind: "cardio",
      note: DESCRIPTIVE_TEMPO_NOTE,
      target_duration_min: 40,
      target_zone: "Z3",
    },
  ]);
  repo.addContextEvent({
    kind: "injury",
    title: "Protective shoulder",
    start_date: DATE,
    meta: { area: "shoulder", severity: "moderate" },
  });

  const snapshot = repo.gatherDailyDecisionSnapshot(DATE);
  const cardio = snapshot.plan_items.find((item) => item.kind === "cardio");
  assert.equal(cardio.exercise, "Tempo run");
  const decision = repo.buildDailySessionDecision(snapshot, { now: "2031-07-01T12:00:00.000Z" });
  assert.notEqual(decision.candidates.find((item) => item.exercise === "Tempo run")?.action, "exclude");
  const session = deterministicComposedSession(decision);
  assert.equal(session.items[0].exercise, "Tempo run");
  assert.equal(session.items[0].note, DESCRIPTIVE_TEMPO_NOTE);
});

test("descriptive tempo is excluded through save, gather, decision, and composition for recent left-knee pain", () => {
  repo.savePlanDay(1, "Hybrid", "Run plus upper", [
    {
      exercise: "Tempo run",
      kind: "cardio",
      note: DESCRIPTIVE_TEMPO_NOTE,
      target_duration_min: 40,
      target_zone: "Z3",
    },
    { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
  ]);
  db.prepare(`INSERT INTO sessions (date, joint_pain, kind) VALUES (?, 'left knee', 'strength')`).run(
    addDaysISO(DATE, -1)
  );

  const snapshot = repo.gatherDailyDecisionSnapshot(DATE);
  assert.equal(snapshot.feedback.joint_pain, "left knee");
  assert.equal(snapshot.plan_items.find((item) => item.kind === "cardio").exercise, "Tempo run");
  const decision = repo.buildDailySessionDecision(snapshot, { now: "2031-07-01T12:00:00.000Z" });
  assert.equal(decision.candidates.find((item) => item.exercise === "Tempo run")?.action, "exclude");
  assert.deepEqual(deterministicComposedSession(decision).items.map((item) => item.exercise), ["Bench Press"]);
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
  assert.match(squat.note, /carrying recent work/i, "and it is said in plain words");
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
