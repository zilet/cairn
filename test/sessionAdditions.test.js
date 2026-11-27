import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  appendDailySessionItems,
  prepareDailySession,
  removeAddedDailySessionItem,
} from "../dist/repo/adaptive-session.js";
import {
  buildMidSessionSnapshot,
  deterministicSessionAdditions,
  normalizeSessionAdditionsResult,
} from "../dist/repo/session-additions.js";
import { reconcileDailySession } from "../dist/repo/daily-reconciliation.js";
import { suggestSessionAdditions } from "../dist/coachOps/training.js";
import { SESSION_ADDITIONS_SCHEMA, isSessionAdditionsResult } from "../dist/agent-contracts.js";
import { stripStrictNulls, toOpenAiStrictSchema } from "../dist/schema-dialects.js";
import { matchesJsonSchema } from "../dist/json-schema.js";
import { dayCoachRouter } from "../dist/routes/day-coach.js";
import { registerDayCoachTools } from "../dist/surfaces/mcp/day-coach.js";

const DATE = "2026-06-15";
const NEXT_DAY = "2026-06-16";

beforeEach(() => {
  resetTables(
    "logged_sets",
    "session_skips",
    "sessions",
    "daily_session_compositions",
    "daily_session_outcomes",
    "daily_session_decisions",
    "activities",
    "plan_items",
    "plan_days",
    "training_symptom_events",
    "context_events",
    "agent_jobs",
    "exercises",
    "app_state",
    "profile"
  );
  repo.setProfile({ name: "Test Athlete", primary_discipline: "strength", units: "lb" });
  repo.replacePlan([
    {
      day_number: 1,
      name: "Push",
      focus: "Chest & shoulders",
      items: [
        { exercise: "Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 165 },
        { exercise: "Overhead Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 95 },
      ],
    },
  ]);
  repo.findOrCreateExercise("Bench Press", "chest", undefined, "reps");
  repo.findOrCreateExercise("Overhead Press", "shoulders", undefined, "reps");
  repo.findOrCreateExercise("Face Pull", "rear delts", undefined, "reps");
  repo.findOrCreateExercise("Hammer Curl", "biceps", undefined, "reps");
  repo.findOrCreateExercise("Dead Hang", "forearms", undefined, "timed");
  repo.findOrCreateExercise("Back Squat", "quads", undefined, "reps");
});

function routerRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const request = { method, url, originalUrl: url, body, query: {}, headers: {} };
    const response = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        resolve({ status: this.statusCode, body: value });
        return this;
      },
    };
    dayCoachRouter.handle(request, response, (error) => reject(error ?? new Error(`unhandled ${method} ${url}`)));
  });
}

test("appendDailySessionItems appends onto an already-started session without touching the weekly plan", () => {
  const prepared = prepareDailySession({ date: DATE, source: "manual_plan", day_number: 1 });
  const beforePlan = repo.getPlan();
  repo.logSetByName({ date: DATE, exercise: "Bench Press", weight: 165, reps: 8 });

  const appended = appendDailySessionItems({
    date: DATE,
    origin: "ideation_add",
    source_job_id: 42,
    items: [
      {
        exercise: "Face Pull",
        mode: "reps",
        sets: 3,
        rep_low: 12,
        rep_high: 15,
        target_weight: 35,
        note: "Smooth pull to forehead",
      },
      {
        exercise: "Dead Hang",
        mode: "timed",
        sets: 2,
        target_seconds: 40,
      },
    ],
  });

  assert.equal(appended.ok, true);
  assert.equal(appended.added.length, 2);
  assert.equal(appended.skipped_duplicates.length, 0);
  assert.equal(appended.daily_session.id, prepared.daily_session.id);
  assert.equal(appended.daily_session.items.length, 4);
  assert.equal(appended.added[0].exercise, "Face Pull");
  assert.equal(appended.added[0].added_mid_session, true);
  assert.equal(appended.added[0].added_origin, "ideation_add");
  assert.equal(appended.added[0].added_job_id, 42);
  assert.equal(appended.added[1].exercise, "Dead Hang");
  assert.equal(appended.added[1].mode, "timed");
  assert.equal(appended.added[1].target_seconds, 40);

  // Deduplicates already-present movements without throwing.
  const dup = appendDailySessionItems({
    date: DATE,
    origin: "ideation_add",
    items: [{ exercise: "Bench Press", mode: "reps", sets: 3, rep_low: 8, rep_high: 10 }],
  });
  assert.equal(dup.added.length, 0);
  assert.deepEqual(dup.skipped_duplicates, ["Bench Press"]);

  // Rejects cardio items cleanly.
  assert.throws(
    () => appendDailySessionItems({ date: DATE, items: [{ kind: "cardio", exercise: "Easy run", target_duration_min: 20 }] }),
    /only strength exercises/i
  );

  // Refuses appending onto a finished session.
  db.prepare(`UPDATE sessions SET finished_at = datetime('now') WHERE id = ?`).run(prepared.session_id);
  assert.throws(
    () =>
      appendDailySessionItems({
        date: DATE,
        origin: "ideation_add",
        items: [{ exercise: "Tricep Pushdown", mode: "reps", sets: 3, rep_low: 10, rep_high: 12 }],
      }),
    /already finished/i
  );

  // Weekly plan is untouched.
  assert.deepEqual(repo.getPlan(), beforePlan);
});

test("appendDailySessionItems adopts an uncomposed lived session and removeAddedDailySessionItem guards logged sets", () => {
  repo.logSetByName({ date: DATE, exercise: "Bench Press", weight: 165, reps: 8 });
  const appended = appendDailySessionItems({
    date: DATE,
    origin: "athlete_add",
    items: [{ exercise: "Hammer Curl", mode: "reps", sets: 3, rep_low: 10, rep_high: 12 }],
  });
  assert.equal(appended.ok, true);
  assert.equal(appended.daily_session.items.length, 1);
  assert.equal(appended.added[0].exercise, "Hammer Curl");

  const removed = removeAddedDailySessionItem({ date: DATE, exercise: "Hammer Curl" });
  assert.equal(removed.removed, "Hammer Curl");
  assert.equal(removed.daily_session.items.length, 0);

  appendDailySessionItems({
    date: DATE,
    origin: "athlete_add",
    items: [{ exercise: "Hammer Curl", mode: "reps", sets: 3, rep_low: 10, rep_high: 12 }],
  });
  repo.logSetByName({ date: DATE, exercise: "Hammer Curl", weight: 30, reps: 10 });
  assert.throws(() => removeAddedDailySessionItem({ date: DATE, exercise: "Hammer Curl" }), /already logged/i);
});

test("reconcileDailySession credits logged mid-session additions and never marks unlogged additions as skipped", () => {
  const prepared = prepareDailySession({ date: DATE, source: "manual_plan", day_number: 1 });
  repo.logSetByName({ date: DATE, exercise: "Bench Press", weight: 165, reps: 8 });
  repo.logSetByName({ date: DATE, exercise: "Overhead Press", weight: 95, reps: 10 });

  appendDailySessionItems({
    date: DATE,
    origin: "ideation_add",
    items: [
      { exercise: "Face Pull", mode: "reps", sets: 3, rep_low: 12, rep_high: 15 },
      { exercise: "Hammer Curl", mode: "reps", sets: 3, rep_low: 10, rep_high: 12 },
    ],
  });

  // Log Face Pull, skip doing Hammer Curl without touching skip button.
  repo.logSetByName({ date: DATE, exercise: "Face Pull", weight: 35, reps: 14 });
  const outcome = reconcileDailySession(prepared.session_id);
  assert.ok(outcome);
  assert.ok(outcome.facts.completed.includes("Face Pull"));
  assert.ok(!outcome.facts.substituted.includes("Face Pull"), "appended item is not treated as unplanned substitution");
  assert.ok(!outcome.facts.skipped.includes("Hammer Curl"), "unlogged mid-session addition does not read as skipped");
  assert.ok(outcome.facts.reason_codes.includes("completed_as_suggested"));
  const facePullDose = outcome.facts.dose_evidence.find((d) => d.exercise === "Face Pull");
  assert.equal(facePullDose?.added_mid_session, true);
});

test("buildMidSessionSnapshot, normalizeSessionAdditionsResult, and deterministic fallback honor exclusions and safety", () => {
  prepareDailySession({ date: DATE, source: "manual_plan", day_number: 1 });
  repo.logSetByName({ date: DATE, exercise: "Bench Press", weight: 165, reps: 8 });
  repo.skipExercise("Overhead Press", DATE);

  // Active knee symptom excludes quad-loading suggestions.
  db.prepare(
    `INSERT INTO training_symptom_events (source_kind, area_text, status, scope, onset_on, last_reported_on)
     VALUES ('chat', 'right knee', 'active', 'area', ?, ?)`
  ).run(DATE, DATE);

  const snapshot = buildMidSessionSnapshot(DATE, { exclude: ["Hammer Curl"] });
  assert.equal(snapshot.logged.length, 1);
  assert.equal(snapshot.logged[0].exercise, "Bench Press");
  assert.ok(snapshot.skipped.includes("Overhead Press"));
  assert.ok(snapshot.exclude_keys.includes("bench press"));
  assert.ok(snapshot.exclude_keys.includes("overhead press"));
  assert.ok(snapshot.exclude_keys.includes("hammer curl"));
  assert.ok(snapshot.excluded_muscles.includes("quads"));

  const normalized = normalizeSessionAdditionsResult(
    {
      why: "Rounds out your upper body while keeping your knee out of it.",
      suggestions: [
        { exercise: "Bench Press", mode: "reps", sets: 3, rep_low: 8, rep_high: 10, fit: "Duplicate should drop" },
        { exercise: "Back Squat", mode: "reps", sets: 3, rep_low: 6, rep_high: 8, fit: "Injured knee should drop" },
        { exercise: "Face Pull", mode: "reps", sets: 3, rep_low: 12, rep_high: 15, target_weight: 40, fit: "Upper back balance" },
        { exercise: "Dead Hang", mode: "timed", sets: 2, target_seconds: 40, fit: "Grip & shoulder decompression" },
      ],
    },
    snapshot
  );
  assert.ok(normalized);
  assert.deepEqual(
    normalized.suggestions.map((s) => s.exercise),
    ["Face Pull", "Dead Hang"]
  );
  // Face Pull has no prior working load, so safeAgentWeight keeps target_weight null (open).
  assert.equal(normalized.suggestions[0].target_weight, null);
  assert.equal(normalized.suggestions[1].mode, "timed");

  const fallback = deterministicSessionAdditions(snapshot, { focus: "arms" });
  assert.ok(fallback.suggestions.length >= 1);
  assert.ok(fallback.suggestions.every((s) => !["Bench Press", "Overhead Press", "Hammer Curl", "Back Squat"].includes(s.exercise)));
});

test("SESSION_ADDITIONS_SCHEMA survives OpenAI strict-mode derivation and stripStrictNulls", () => {
  const strict = toOpenAiStrictSchema(SESSION_ADDITIONS_SCHEMA);
  assert.ok(strict, "SESSION_ADDITIONS_SCHEMA must be expressible in OpenAI strict mode");
  assert.equal(strict.additionalProperties, false);
  const strictReply = {
    why: "Adds clean posterior-chain and arm volume.",
    suggestions: [
      {
        exercise: "Face Pull",
        mode: null,
        sets: 3,
        rep_low: 12,
        rep_high: 15,
        target_reps: null,
        target_weight: null,
        target_seconds: null,
        fit: "Balances pressing volume",
        note: null,
      },
    ],
  };
  const stripped = stripStrictNulls(strictReply, SESSION_ADDITIONS_SCHEMA);
  assert.ok(matchesJsonSchema(SESSION_ADDITIONS_SCHEMA, stripped, { coerce: true }));
  assert.equal(isSessionAdditionsResult(stripped), true);
});

test("suggestSessionAdditions degrades cleanly to deterministic fallback when no agent is reachable", async () => {
  prepareDailySession({ date: DATE, source: "manual_plan", day_number: 1 });
  repo.logSetByName({ date: DATE, exercise: "Bench Press", weight: 165, reps: 8 });
  const result = await suggestSessionAdditions(undefined, { date: DATE, constraints: "feeling strong" });
  assert.equal(result.ok, true);
  assert.equal(result.source, "deterministic");
  assert.ok(Array.isArray(result.suggestions) && result.suggestions.length >= 1);
});

async function waitForJob(id, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = repo.getAgentJob(id);
    if (row && ["done", "error", "canceled"].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`agent job ${id} did not finish within ${timeoutMs}ms`);
}

test("REST endpoints (/session-additions and /daily-session/items) and MCP tools wire through cleanly", async () => {
  const resIdeas = await routerRequest("POST", "/session-additions", {
    date: DATE,
    constraints: "arms",
  });
  assert.equal(resIdeas.status, 200);
  const queued = resIdeas.body;
  assert.equal(queued.ok, true);
  assert.equal(queued.job?.kind, "session_additions");
  assert.ok(Number.isInteger(queued.job?.id));

  const finished = await waitForJob(queued.job.id);
  assert.equal(finished.status, "done");
  assert.equal(finished.result?.ok, true);
  assert.ok(finished.result?.suggestions?.length >= 1);

  const pick = finished.result.suggestions[0];
  const resAdd = await routerRequest("POST", "/daily-session/items", {
    date: DATE,
    origin: "ideation_add",
    source_job_id: queued.job.id,
    items: [pick],
  });
  assert.equal(resAdd.status, 200);
  const added = resAdd.body;
  assert.equal(added.ok, true);
  assert.equal(added.added.length, 1);
  assert.equal(added.added[0].exercise, pick.exercise);
  assert.equal(added.added[0].added_job_id, queued.job.id);

  // Verify REST DELETE /daily-session/items removes an unlogged mid-session addition.
  const resRemove = await routerRequest("DELETE", "/daily-session/items", {
    date: DATE,
    exercise: pick.exercise,
  });
  assert.equal(resRemove.status, 200);
  assert.equal(resRemove.body.ok, true);
  assert.equal(resRemove.body.removed, pick.exercise);

  // Verify MCP tool registration includes all three new tools and remove_daily_session_item works/guards.
  const registered = new Map();
  registerDayCoachTools({
    tool(name, description, schema, handler) {
      registered.set(name, { description, schema, handler });
    },
  });
  assert.ok(registered.has("suggest_session_additions"));
  assert.ok(registered.has("append_daily_session_items"));
  assert.ok(registered.has("remove_daily_session_item"));
  const mcpAdd = await registered.get("append_daily_session_items").handler({
    date: NEXT_DAY,
    origin: "ideation_add",
    items: [{ exercise: "Face Pull", mode: "reps", sets: 3, rep_low: 12, rep_high: 15 }],
  });
  const parsed = JSON.parse(mcpAdd.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.added[0].exercise, "Face Pull");

  const mcpRemove = await registered.get("remove_daily_session_item").handler({
    date: NEXT_DAY,
    exercise: "Face Pull",
  });
  const parsedRemove = JSON.parse(mcpRemove.content[0].text);
  assert.equal(parsedRemove.ok, true);
  assert.equal(parsedRemove.removed, "Face Pull");
});

test("buildMidSessionSnapshot excludes alias spellings of logged lifts via liftAlternatives", () => {
  repo.findOrCreateExercise("Dumbbell Biceps Curl", "biceps", undefined, "reps");
  prepareDailySession({ date: DATE, source: "manual_plan", day_number: 1 });
  repo.logSetByName({ date: DATE, exercise: "DB Bicep Curl", weight: 30, reps: 10 });
  const snapshot = buildMidSessionSnapshot(DATE);
  const candidateNames = snapshot.candidate_pool.map((c) => c.exercise.toLowerCase());
  assert.ok(!candidateNames.includes("dumbbell biceps curl"));
  assert.ok(!candidateNames.includes("db bicep curl"));
});
