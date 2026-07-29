import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import {
  applyChatActions,
  hasExplicitSymptomReportIntent,
  hasExplicitSymptomResolveIntent,
} from "../dist/chatTurns.js";
import { buildMcpServer } from "../dist/mcp.js";
import { trainingLogRouter } from "../dist/routes/training-log.js";
import { db, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables(
    "movement_tolerance_observations",
    "training_symptom_events",
    "daily_session_compositions",
    "logged_sets",
    "session_skips",
    "sessions",
    "plan_items",
    "plan_days",
    "exercises"
  );
  repo.findOrCreateExercise("Back Squat", "quads");
  repo.findOrCreateExercise("Bench Press", "chest");
});

function routerRequest(method, url, { body = undefined, query = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = { method, url, originalUrl: url, body, query, headers: {} };
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
    trainingLogRouter.handle(request, response, (error) => {
      reject(error ?? new Error(`no training route handled ${method} ${url}`));
    });
  });
}

async function mcpHarness() {
  const server = buildMcpServer();
  const client = new Client({ name: "training-symptom-surface-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function toolJson(result) {
  const text = result.content.find((entry) => entry.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

test("REST exposes idempotent report, exact-movement tolerance, resolve, and recurrence", async () => {
  const session = repo.getOrCreateSession("2035-01-01");
  const exercise = repo.findExercise("Back Squat");
  const reportBody = {
    area_text: "left <knee>",
    onset_on: "2035-01-01",
    source_session_id: session.id,
    source_kind: "session_feedback",
  };
  const reported = await routerRequest("POST", "/training-symptoms", { body: reportBody });
  const retry = await routerRequest("POST", "/training-symptoms", { body: reportBody });
  assert.equal(reported.status, 200);
  assert.equal(retry.body.id, reported.body.id);

  const bad = await routerRequest("POST", "/training-symptoms", { body: { area_text: "x".repeat(301) } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /300 characters or fewer/);

  for (const observed_on of ["2035-01-02", "2035-01-03"]) {
    const exposureSession = repo.getOrCreateSession(observed_on);
    const tolerance = await routerRequest(
      "POST",
      `/training-symptoms/${reported.body.id}/tolerance`,
      {
        body: {
          movement: "untrusted display text",
          exercise_id: exercise.id,
          observed_on,
          session_id: exposureSession.id,
          pain_free: true,
        },
      }
    );
    assert.equal(tolerance.status, 200);
  }
  const listed = await routerRequest("GET", "/training-symptoms", {
    query: { on: "2035-01-03", include_resolved: "1" },
  });
  assert.equal(listed.body[0].movement_readiness[0].movement_name, "Back Squat");
  assert.equal(listed.body[0].movement_readiness[0].trial_ready, true);
  assert.equal(listed.body[0].status, "active");

  const resolved = await routerRequest("POST", `/training-symptoms/${reported.body.id}/resolve`, {
    body: { on: "2035-01-04" },
  });
  assert.equal(resolved.body.status, "resolved");
  const recurred = await routerRequest("POST", `/training-symptoms/${reported.body.id}/recur`, {
    body: { on: "2035-01-05", movement: "ignored", exercise_id: exercise.id },
  });
  assert.equal(recurred.body.status, "active");
  assert.equal(recurred.body.movement_readiness[0].trial_ready, false);
});

test("REST rejects impossible dates and lifecycle writes that precede their episode boundary", async () => {
  const impossible = await routerRequest("POST", "/training-symptoms", {
    body: { area_text: "left knee", onset_on: "2035-02-30" },
  });
  assert.equal(impossible.status, 400);
  assert.match(impossible.body.error, /real YYYY-MM-DD/);

  const reported = await routerRequest("POST", "/training-symptoms", {
    body: { area_text: "left knee", onset_on: "2035-04-10" },
  });
  const earlyTolerance = await routerRequest(
    "POST",
    `/training-symptoms/${reported.body.id}/tolerance`,
    {
      body: { movement: "Back Squat", observed_on: "2035-04-09", pain_free: true },
    }
  );
  assert.equal(earlyTolerance.status, 400);
  assert.match(earlyTolerance.body.error, /before symptom onset/);
  const earlyResolve = await routerRequest("POST", `/training-symptoms/${reported.body.id}/resolve`, {
    body: { on: "2035-04-09" },
  });
  assert.equal(earlyResolve.status, 400);
  assert.match(earlyResolve.body.error, /before symptom onset/);

  await routerRequest("POST", `/training-symptoms/${reported.body.id}/resolve`, {
    body: { on: "2035-04-12" },
  });
  const earlyRecurrence = await routerRequest("POST", `/training-symptoms/${reported.body.id}/recur`, {
    body: { on: "2035-04-11", movement: "Back Squat" },
  });
  assert.equal(earlyRecurrence.status, 400);
  assert.match(earlyRecurrence.body.error, /before the current episode resolution/);

  const impossibleList = await routerRequest("GET", "/training-symptoms", {
    query: { on: "2035-04-31" },
  });
  assert.equal(impossibleList.status, 400);
  assert.match(impossibleList.body.error, /real YYYY-MM-DD/);
});

test("exercise-card observation binds canonical movement to the requested session date with no partial writes", async () => {
  const logged = repo.logSetByName({
    exercise: "Back Squat",
    weight: 100,
    reps: 5,
    date: "2035-05-01",
  });
  const mismatch = await routerRequest("POST", "/training-symptoms/observation", {
    body: {
      date: "2035-05-02",
      session_id: logged.session_id,
      movement: "back squat",
      area_text: "left knee",
      outcome: "pain_present",
    },
  });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body.error, /session_id must match date/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n, 0);

  const unrelated = await routerRequest("POST", "/training-symptoms/observation", {
    body: {
      date: "2035-05-01",
      session_id: logged.session_id,
      movement: "Bench Press",
      area_text: "left shoulder",
      outcome: "pain_present",
    },
  });
  assert.equal(unrelated.status, 400);
  assert.match(unrelated.body.error, /not part of this session exposure/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, 0);

  const created = await routerRequest("POST", "/training-symptoms/observation", {
    body: {
      date: "2035-05-01",
      session_id: logged.session_id,
      movement: "back squat",
      area_text: "left knee",
      outcome: "pain_present",
    },
  });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.exercise, {
    id: repo.findExercise("Back Squat").id,
    name: "Back Squat",
    muscle_group: "quads",
  });
  assert.equal(created.body.symptom.source_session_id, logged.session_id);
  assert.equal(created.body.outcome, "pain_present");

  const retry = await routerRequest("POST", "/training-symptoms/observation", {
    body: {
      date: "2035-05-01",
      session_id: logged.session_id,
      movement: "Back Squat",
      area_text: "left knee",
      outcome: "pain_present",
    },
  });
  assert.equal(retry.body.symptom.id, created.body.symptom.id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n, 1);
});

test("new pain-present observation rolls back its symptom when the movement write fails", async () => {
  const logged = repo.logSetByName({
    exercise: "Back Squat",
    weight: 105,
    reps: 5,
    date: "2035-05-03",
  });
  db.exec(`
    CREATE TEMP TRIGGER fail_exercise_card_observation
    BEFORE INSERT ON movement_tolerance_observations
    BEGIN
      SELECT RAISE(ABORT, 'forced observation failure');
    END
  `);
  try {
    const failed = await routerRequest("POST", "/training-symptoms/observation", {
      body: {
        date: "2035-05-03",
        session_id: logged.session_id,
        movement: "Back Squat",
        area_text: "left knee",
        outcome: "pain_present",
      },
    });
    assert.equal(failed.status, 400);
    assert.match(failed.body.error, /forced observation failure/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n, 0);
  } finally {
    db.exec(`DROP TRIGGER fail_exercise_card_observation`);
  }
});

test("explicit-symptom pain-present rolls back the whole epoch mutation when the event update fails", async () => {
  const date = "2035-05-12";
  const logged = repo.logSetByName({
    exercise: "Back Squat",
    weight: 105,
    reps: 5,
    date,
  });
  const symptom = repo.reportTrainingSymptom({
    area_text: "left knee",
    onset_on: date,
    source_session_id: logged.session_id,
    source_kind: "surface_test",
  });
  db.exec(`
    CREATE TEMP TRIGGER fail_explicit_symptom_update
    BEFORE UPDATE ON training_symptom_events
    WHEN OLD.id = ${symptom.id}
    BEGIN
      SELECT RAISE(ABORT, 'forced symptom update failure');
    END
  `);
  try {
    const failed = await routerRequest("POST", "/training-symptoms/observation", {
      body: {
        date,
        session_id: logged.session_id,
        movement: "Back Squat",
        symptom_event_id: symptom.id,
        outcome: "pain_present",
      },
    });
    assert.equal(failed.status, 400);
    assert.match(failed.body.error, /forced symptom update failure/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n, 0);
    assert.deepEqual(
      {
        ...db
          .prepare(
            `SELECT last_reported_on, recurrence_count, evidence_epoch
             FROM training_symptom_events WHERE id = ?`
          )
          .get(symptom.id),
      },
      {
        last_reported_on: date,
        recurrence_count: 0,
        evidence_epoch: 1,
      }
    );
  } finally {
    db.exec(`DROP TRIGGER fail_explicit_symptom_update`);
  }
});

test("pain-free needs an explicit active relevant symptom and never clears it", async () => {
  const logged = repo.logSetByName({
    exercise: "Back Squat",
    weight: 110,
    reps: 5,
    date: "2035-05-04",
  });
  const missing = await routerRequest("POST", "/training-symptoms/observation", {
    body: {
      date: "2035-05-04",
      session_id: logged.session_id,
      movement: "Back Squat",
      outcome: "pain_free",
    },
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /explicit symptom_event_id/);

  const irrelevant = repo.reportTrainingSymptom({
    area_text: "left shoulder",
    onset_on: "2035-05-04",
    source_session_id: logged.session_id,
    source_kind: "surface_test",
  });
  const rejected = await routerRequest("POST", "/training-symptoms/observation", {
    body: {
      date: "2035-05-04",
      session_id: logged.session_id,
      movement: "Back Squat",
      symptom_event_id: irrelevant.id,
      outcome: "pain_free",
    },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /not relevant/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n, 0);

  const relevant = repo.reportTrainingSymptom({
    area_text: "left knee",
    onset_on: "2035-05-04",
    source_session_id: logged.session_id,
    source_kind: "surface_test",
  });
  const recorded = await routerRequest("POST", "/training-symptoms/observation", {
    body: {
      date: "2035-05-04",
      session_id: logged.session_id,
      movement: "Back Squat",
      symptom_event_id: relevant.id,
      outcome: "pain_free",
    },
  });
  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.symptom.status, "active");
  assert.equal(recorded.body.symptom.resolved_on, null);
});

test("pain-present wins a contradictory same-exposure order and exact retry stays stable", async () => {
  const logged = repo.logSetByName({
    exercise: "Back Squat",
    weight: 115,
    reps: 5,
    date: "2035-05-05",
  });
  const symptom = repo.reportTrainingSymptom({
    area_text: "left knee",
    onset_on: "2035-05-05",
    source_session_id: logged.session_id,
    source_kind: "surface_test",
  });
  const base = {
    date: "2035-05-05",
    session_id: logged.session_id,
    movement: "Back Squat",
    symptom_event_id: symptom.id,
  };
  const free = await routerRequest("POST", "/training-symptoms/observation", {
    body: { ...base, outcome: "pain_free" },
  });
  assert.equal(free.body.outcome, "pain_free");

  const present = await routerRequest("POST", "/training-symptoms/observation", {
    body: { ...base, outcome: "pain_present" },
  });
  assert.equal(present.body.outcome, "pain_present");
  assert.equal(present.body.symptom.relevant_pain_free_exposures, 0);
  const observations = db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n;
  const retry = await routerRequest("POST", "/training-symptoms/observation", {
    body: { ...base, outcome: "pain_present" },
  });
  assert.equal(retry.body.symptom.id, present.body.symptom.id);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n, observations);

  const contradictoryRetry = await routerRequest("POST", "/training-symptoms/observation", {
    body: { ...base, outcome: "pain_free" },
  });
  assert.equal(contradictoryRetry.body.outcome, "pain_present");
  assert.equal(contradictoryRetry.body.symptom.relevant_pain_free_exposures, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n, observations);
});

test("movement-filtered symptom GET returns only active relevant episodes", async () => {
  const session = repo.getOrCreateSession("2035-05-06");
  const activeKnee = repo.reportTrainingSymptom({
    area_text: "left knee",
    onset_on: "2035-05-06",
    source_session_id: session.id,
    source_kind: "knee_active",
  });
  repo.reportTrainingSymptom({
    area_text: "left shoulder",
    onset_on: "2035-05-06",
    source_session_id: session.id,
    source_kind: "shoulder_active",
  });
  const resolvedKnee = repo.reportTrainingSymptom({
    area_text: "right knee",
    onset_on: "2035-05-06",
    source_session_id: session.id,
    source_kind: "knee_resolved",
  });
  repo.resolveTrainingSymptom(resolvedKnee.id, "2035-05-06");

  const filtered = await routerRequest("GET", "/training-symptoms", {
    query: { on: "2035-05-06", movement: "back squat", include_resolved: "1" },
  });
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.body.map((row) => row.id), [activeKnee.id]);
});

test("session exposure accepts an accepted composition, linked plan, logged set, or current skip", async () => {
  const exercise = repo.findExercise("Back Squat");
  const dates = ["2035-05-07", "2035-05-08", "2035-05-09", "2035-05-10"];
  const compositionSession = repo.getOrCreateSession(dates[0]);
  db.prepare(
    `INSERT INTO daily_session_compositions
      (version, session_id, date, source, status, title, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'manual_plan', 'active', 'Test', ?, ?)`
  ).run(compositionSession.id, dates[0], JSON.stringify([{ exercise: "Back Squat" }]), "symptom-composition");

  const day = db.prepare(`INSERT INTO plan_days (day_number, name) VALUES (91, 'Test')`).run();
  db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets) VALUES (?, 0, ?, 1)`
  ).run(day.lastInsertRowid, exercise.id);
  const linkedSession = db
    .prepare(`INSERT INTO sessions (date, plan_day_id) VALUES (?, ?)`)
    .run(dates[1], day.lastInsertRowid);

  const logged = repo.logSetByName({ exercise: "Back Squat", weight: 95, reps: 5, date: dates[2] });
  const skippedSession = repo.getOrCreateSession(dates[3]);
  db.prepare(`INSERT INTO session_skips (session_id, exercise) VALUES (?, ?)`).run(
    skippedSession.id,
    "Back Squat"
  );

  const sessionIds = [
    compositionSession.id,
    Number(linkedSession.lastInsertRowid),
    logged.session_id,
    skippedSession.id,
  ];
  for (let index = 0; index < dates.length; index++) {
    const result = await routerRequest("POST", "/training-symptoms/observation", {
      body: {
        date: dates[index],
        session_id: sessionIds[index],
        movement: "Back Squat",
        area_text: `left knee ${index}`,
        outcome: "pain_present",
      },
    });
    assert.equal(result.status, 200, `${dates[index]} should accept its exposure source`);
  }
});

test("an active accepted composition excludes source-plan movements and malformed items fail closed", async () => {
  const squat = repo.findExercise("Back Squat");
  const day = db.prepare(`INSERT INTO plan_days (day_number, name) VALUES (92, 'Exclusive source')`).run();
  db.prepare(
    `INSERT INTO plan_items (plan_day_id, position, exercise_id, sets) VALUES (?, 0, ?, 1)`
  ).run(day.lastInsertRowid, squat.id);

  const excludedDate = "2035-05-13";
  const excludedSession = db
    .prepare(`INSERT INTO sessions (date, plan_day_id) VALUES (?, ?)`)
    .run(excludedDate, day.lastInsertRowid);
  db.prepare(
    `INSERT INTO daily_session_compositions
      (version, session_id, date, source, status, plan_day_id, title, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'manual_plan', 'active', ?, 'Exclusive', ?, ?)`
  ).run(
    excludedSession.lastInsertRowid,
    excludedDate,
    day.lastInsertRowid,
    JSON.stringify([{ exercise: "Bench Press" }]),
    "exclusive-composition"
  );
  const excluded = await routerRequest("POST", "/training-symptoms/observation", {
    body: {
      date: excludedDate,
      session_id: Number(excludedSession.lastInsertRowid),
      movement: "Back Squat",
      area_text: "left knee",
      outcome: "pain_present",
    },
  });
  assert.equal(excluded.status, 400);
  assert.match(excluded.body.error, /not part of this session exposure/);

  const malformedDate = "2035-05-14";
  const malformedSession = db
    .prepare(`INSERT INTO sessions (date, plan_day_id) VALUES (?, ?)`)
    .run(malformedDate, day.lastInsertRowid);
  db.prepare(
    `INSERT INTO daily_session_compositions
      (version, session_id, date, source, status, plan_day_id, title, items_json, request_fingerprint)
     VALUES (1, ?, ?, 'manual_plan', 'active', ?, 'Malformed', ?, ?)`
  ).run(
    malformedSession.lastInsertRowid,
    malformedDate,
    day.lastInsertRowid,
    "{not-json",
    "malformed-composition"
  );
  const malformed = await routerRequest("POST", "/training-symptoms/observation", {
    body: {
      date: malformedDate,
      session_id: Number(malformedSession.lastInsertRowid),
      movement: "Back Squat",
      area_text: "left knee",
      outcome: "pain_present",
    },
  });
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.error, /not part of this session exposure/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM movement_tolerance_observations`).get().n, 0);
});

test("MCP mirrors the shared symptom lifecycle and keeps trial readiness as evidence only", async () => {
  const exercise = repo.findExercise("Back Squat");
  const { client, server } = await mcpHarness();
  try {
    const reported = toolJson(
      await client.callTool({
        name: "report_training_symptom",
        arguments: { area_text: "left knee", onset_on: "2035-02-01" },
      })
    );
    for (const observed_on of ["2035-02-02", "2035-02-03"]) {
      await client.callTool({
        name: "record_movement_tolerance",
        arguments: {
          symptom_event_id: reported.id,
          movement: "Back Squat",
          exercise_id: exercise.id,
          observed_on,
          pain_free: true,
        },
      });
    }
    const rows = toolJson(
      await client.callTool({
        name: "list_training_symptoms",
        arguments: { on: "2035-02-03", include_resolved: true },
      })
    );
    assert.equal(rows[0].trial_ready, true);
    assert.equal(rows[0].status, "active");
    const resolved = toolJson(
      await client.callTool({
        name: "resolve_training_symptom",
        arguments: { id: reported.id, on: "2035-02-04" },
      })
    );
    assert.equal(resolved.status, "resolved");
    const recurred = toolJson(
      await client.callTool({
        name: "recur_training_symptom",
        arguments: { id: reported.id, on: "2035-02-05", exercise_id: exercise.id },
      })
    );
    assert.equal(recurred.status, "active");
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP exposes the same canonical exercise-card observation use case", async () => {
  const logged = repo.logSetByName({
    exercise: "Back Squat",
    weight: 120,
    reps: 5,
    date: "2035-05-11",
  });
  const { client, server } = await mcpHarness();
  try {
    const result = toolJson(
      await client.callTool({
        name: "record_exercise_symptom_observation",
        arguments: {
          date: "2035-05-11",
          session_id: logged.session_id,
          movement: "back squat",
          area_text: "left knee",
          outcome: "pain_present",
        },
      })
    );
    assert.equal(result.ok, true);
    assert.equal(result.exercise.name, "Back Squat");
    assert.equal(result.session_id, logged.session_id);
  } finally {
    await client.close();
    await server.close();
  }
});

test("chat only records a symptom behind explicit athlete write intent", () => {
  assert.equal(hasExplicitSymptomReportIntent("My left knee hurts during squats."), false);
  assert.equal(hasExplicitSymptomReportIntent("Could you log my left knee pain?"), true);
  assert.equal(hasExplicitSymptomReportIntent("Please record that my knee still hurts."), true);
  for (const message of [
    "Please log that my knee pain is gone.",
    "Record that my knee no longer hurts.",
    "Note that the soreness resolved.",
    "Track that my knee is not hurting.",
    "Please log that my knee doesn't hurt anymore.",
    "Record that my knee isn't sore anymore.",
    "Note that my knee pain went away.",
    "Track that I am not in pain now.",
    "Don't report my knee pain.",
  ]) {
    assert.equal(hasExplicitSymptomReportIntent(message), false, message);
  }
  // Chat's input bound matches the MCP symptom tools (120); the repo still
  // normalizes to a 60-char label. Chat must not be the loose surface.
  assert.equal(normalizeChatAction({ type: "report_training_symptom", area_text: "x".repeat(121) }), null);
  assert.equal(normalizeChatAction({ type: "resolve_training_symptom", area_text: "x".repeat(121) }), null);
  assert.ok(normalizeChatAction({ type: "report_training_symptom", area_text: "x".repeat(120) }));
  assert.ok(normalizeChatAction({ type: "resolve_training_symptom", area_text: "x".repeat(120) }));

  const inferred = applyChatActions(
    { actions: [{ type: "report_training_symptom", area_text: "left knee", onset_on: "2035-03-01" }] },
    { agent: "stub", message: "My left knee hurts during squats." }
  );
  assert.deepEqual(inferred.applied, []);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, 0);

  const explicit = applyChatActions(
    { actions: [{ type: "report_training_symptom", area_text: "left knee", onset_on: "2035-03-01" }] },
    { agent: "stub", message: "Please log my left knee pain." }
  );
  assert.equal(explicit.applied[0].type, "report_training_symptom");
  assert.equal(repo.listTrainingSymptoms({ on: "2035-03-01" }).length, 1);

  for (const message of [
    "Please log that my knee pain is gone.",
    "Record that my knee no longer hurts.",
    "Note that the soreness resolved.",
    "Track that my knee is not hurting.",
    "Please log that my knee doesn't hurt anymore.",
    "Record that my knee isn't sore anymore.",
    "Note that my knee pain went away.",
    "Track that I am not in pain now.",
    "Don't report my knee pain.",
  ]) {
    const negative = applyChatActions(
      { actions: [{ type: "report_training_symptom", area_text: "left knee", onset_on: "2035-03-02" }] },
      { agent: "stub", message }
    );
    assert.deepEqual(negative.applied, [], message);
  }
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n,
    1,
    "resolution or negation language never creates another active symptom"
  );
});

test("client lifecycle keeps athlete text escaped and uses evidence/recheck language", () => {
  const root = join(import.meta.dirname, "..");
  const feedback = readFileSync(join(root, "src/client/today-session-feedback-client.ts"), "utf8");
  const status = readFileSync(join(root, "src/client/today-session-status-client.ts"), "utf8");
  assert.match(feedback, /escHtml\(symptom\.area_text\)/);
  assert.match(feedback, /escHtml\(movement\.movement_name\)/);
  assert.match(feedback, /escAttr\(option\.name\)/);
  assert.match(feedback, /evidence for a careful movement recheck/);
  assert.match(feedback, /data-symptom-resolve/);
  assert.match(feedback, /data-symptom-recur/);
  assert.match(feedback, /Pain &amp; injury/);
  assert.match(feedback, /No active notes\./);
  // An imported note is framed as unconfirmed history, not as an ordinary watch.
  assert.match(feedback, /symptom-watching symptom-unconfirmed">Older note · unconfirmed/);
  assert.match(feedback, /Imported from an older session note/);
  // Resolved history says WHEN it closed.
  assert.match(feedback, /symptom-resolved-on">closed \$\{escHtml\(humanDate\(closed\)\)\}/);
  // The panel is reachable with no logged sets (rest day / before the first set).
  assert.match(feedback, /options\.hasLoggedSets === false/);
  assert.match(feedback, /symptom-watching">Watching/);
  assert.match(feedback, /<details class="symptom-history">/);
  assert.match(feedback, /data-report-symptom-toggle aria-expanded="false"/);
  assert.match(feedback, /data-report-symptom-cancel/);
  assert.match(feedback, /id="symptom-report-composer" hidden/);
  const resolvedRow = /if \(!active\) \{([\s\S]*?)\n    \}\n[\s\S]*?return `<article class="symptom-active-row/.exec(feedback)?.[1] ?? "";
  assert.match(resolvedRow, /data-symptom-recur-toggle/);
  assert.match(resolvedRow, /data-symptom-recur/);
  assert.match(resolvedRow, /class="symptom-recur-composer"[\s\S]*hidden/);
  assert.match(resolvedRow, /movementInputHtml\(symptom\.id, session\)/);
  assert.match(feedback, /data-symptom-movement/);
  assert.match(feedback, /movement: movement\?\.value\.trim\(\) \|\| undefined/);
  assert.match(feedback, /exercise_id: option\?\.dataset\.exerciseId/);
  assert.match(feedback, /class="pillbtn pill-sm" type="button" data-tolerance="free"/);
  assert.match(feedback, /class="pillbtn pill-sm" type="button" data-tolerance="present"/);
  assert.match(feedback, /data-tolerance="free"/);
  assert.match(feedback, /exercise_id/);
  assert.match(feedback, /\/training-symptoms\?on=\$\{viewedDate\}&include_resolved=1/);
  assert.match(status, /data-symptom-lifecycle/);
  assert.doesNotMatch(feedback, /\b(?:cleared|clearance|diagnos(?:e|is))\b/i);
});

// One relevance question for a whole session render, so no surface needs a client
// copy of the pain→movement map and no card asks on its own.
test("REST answers movement relevance for a whole session in one read, without writing", async () => {
  repo.findOrCreateExercise("Reverse Lunge", "quads");
  const knee = repo.reportTrainingSymptom({ area_text: "outside of left knee", onset_on: "2035-05-01" });
  const shoulder = repo.reportTrainingSymptom({ area_text: "right shoulder", onset_on: "2035-05-01" });
  const healed = repo.reportTrainingSymptom({ area_text: "left ankle", onset_on: "2035-05-01" });
  repo.resolveTrainingSymptom(healed.id, "2035-05-02");
  // An imported legacy row is absence of evidence and must never claim a movement.
  db.prepare(
    `INSERT INTO training_symptom_events
      (source_kind, area_text, status, onset_on, last_reported_on, legacy_unconfirmed)
     VALUES ('legacy_session_feedback', 'left knee', 'active', '2035-05-01', '2035-05-01', 1)`
  ).run();

  const batch = await routerRequest("GET", "/training-symptoms", {
    query: { on: "2035-05-03", seed_legacy: "0", movements: ["Back Squat", "Bench Press", "Reverse Lunge"] },
  });
  assert.equal(batch.status, 200);
  assert.deepEqual(
    batch.body.map((event) => [event.id, event.relevant_movements]).sort((a, b) => a[0] - b[0]),
    [
      [knee.id, ["Back Squat", "Reverse Lunge"]],
      [shoulder.id, ["Bench Press"]],
    ]
  );
  assert.equal(
    batch.body.every((event) => event.legacy_unconfirmed === false),
    true
  );

  // A name with no exercises row is answered, not rejected (the single-movement
  // lookup deliberately still insists on a real exercise).
  const unknown = await routerRequest("GET", "/training-symptoms", {
    query: { on: "2035-05-03", movements: ["Nonexistent Movement"] },
  });
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, []);
  const strict = await routerRequest("GET", "/training-symptoms", {
    query: { on: "2035-05-03", movement: "Nonexistent Movement" },
  });
  assert.equal(strict.status, 400);

  // A render read must not trigger the one-time legacy import as a side effect.
  db.prepare(`INSERT INTO sessions (date, joint_pain) VALUES ('2035-05-01', 'sore left elbow')`).run();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n;
  await routerRequest("GET", "/training-symptoms", {
    query: { on: "2035-05-03", seed_legacy: "0", movements: ["Back Squat"] },
  });
  await routerRequest("GET", "/training-symptoms", {
    query: { on: "2035-05-03", seed_legacy: "0", movement: "Back Squat" },
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, before);
  await routerRequest("GET", "/training-symptoms", { query: { on: "2035-05-03" } });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM training_symptom_events`).get().n, before + 1);
});

// Chat parity: it could OPEN a pain note but never close one, so the only way out
// of the loop was to leave the conversation and open the app.
test("chat closes a pain note only when the athlete says so, and only the area they named", () => {
  assert.equal(hasExplicitSymptomResolveIntent("My knee feels alright lately."), false);
  assert.equal(hasExplicitSymptomResolveIntent("Is my knee note resolved?"), false);
  assert.equal(hasExplicitSymptomResolveIntent("Don't close the knee note yet."), false);
  assert.equal(hasExplicitSymptomResolveIntent("Close the knee note, it's fine now."), true);
  assert.equal(hasExplicitSymptomResolveIntent("My left knee is healed, mark it resolved."), true);
  assert.equal(hasExplicitSymptomResolveIntent("The shoulder pain is gone."), true);

  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: "2035-04-01" });
  repo.reportTrainingSymptom({ area_text: "right shoulder", onset_on: "2035-04-01" });

  const inferred = applyChatActions(
    { actions: [{ type: "resolve_training_symptom", area_text: "left knee", on: "2035-04-05" }] },
    { agent: "stub", message: "Squats felt great today." }
  );
  assert.deepEqual(inferred.applied, [], "a good session is not permission to close a note");
  assert.equal(repo.listTrainingSymptoms({ on: "2035-04-05" }).length, 2);

  const explicit = applyChatActions(
    { actions: [{ type: "resolve_training_symptom", area_text: "left knee", on: "2035-04-05" }] },
    { agent: "stub", message: "My left knee is healed — mark it resolved." }
  );
  assert.equal(explicit.applied[0].type, "resolve_training_symptom");
  assert.equal(explicit.applied[0].result.status, "resolved");
  const open = repo.listTrainingSymptoms({ on: "2035-04-05" });
  assert.equal(open.length, 1, "the area they did not name stays open");
  assert.match(open[0].area_text, /shoulder/i);

  const missing = applyChatActions(
    { actions: [{ type: "resolve_training_symptom", area_text: "left elbow", on: "2035-04-06" }] },
    { agent: "stub", message: "My left elbow is healed — close that note." }
  );
  assert.match(String(missing.applied[0].result.error), /no open pain note/);
});
