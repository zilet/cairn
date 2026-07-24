import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { composeDailySession } from "../dist/coachOps.js";
import { deterministicComposedSession, normalizeComposedSession } from "../dist/repo/daily-composition.js";
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
    "exercises"
  );
});

function envelope(overrides = {}) {
  return {
    policy_version: "daily_decision_v1",
    input_fingerprint: "test-fp",
    generated_at: "2031-01-01T00:00:00.000Z",
    date: DATE,
    kind: "train",
    template: { day_number: null, focus: "Lower body", intent: "custom" },
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
  assert.equal(session.est_minutes, 30);
  assert.equal(validation.capped, true);
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
      template: { day_number: 1, focus: "Lower body", intent: "template" },
      muscles: { required: [], allowed: [], reduced: [], excluded: ["quads"] },
    })
  );
  assert.ok(session.items.length >= 1);
  assert.ok(!session.items.some((i) => i.exercise === "Back Squat"));
  assert.ok(session.items.some((i) => i.exercise === "Bench Press"));
});

test("deterministic fallback for a rest/custom envelope returns a safe easy-movement session", () => {
  const session = deterministicComposedSession(
    envelope({
      kind: "rest",
      template: { day_number: null, focus: null, intent: "custom" },
      caps: { volume: "minimal", intensity: "easy", duration_min: 20 },
    })
  );
  assert.ok(session.items.length >= 1);
  assert.equal(session.items[0].kind, "cardio");
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
  assert.equal(prepared.daily_session.plan_day_id, null);
  assert.ok(prepared.daily_session.items.length >= 1);
});
