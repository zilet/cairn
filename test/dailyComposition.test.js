import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { composeDailySession } from "../dist/coachOps.js";
import { deterministicComposedSession, normalizeComposedSession } from "../dist/repo/daily-composition.js";
import { addDaysISO, localDateISO } from "../dist/repo/shared.js";
import { db, repo, resetTables } from "./_seed.js";

const DATE = "2031-07-01";

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
