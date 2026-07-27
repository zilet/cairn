import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { normalizeChatAction } from "../dist/chatActions.js";
import { applyChatActions, hasExplicitSymptomReportIntent } from "../dist/chatTurns.js";
import { buildMcpServer } from "../dist/mcp.js";
import { trainingLogRouter } from "../dist/routes/training-log.js";
import { db, repo, resetTables } from "./_seed.js";

beforeEach(() => {
  resetTables("movement_tolerance_observations", "training_symptom_events", "logged_sets", "sessions", "exercises");
  repo.findOrCreateExercise("Back Squat", "quads");
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
  assert.equal(
    normalizeChatAction({ type: "report_training_symptom", area_text: "x".repeat(301) }),
    null
  );

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
  assert.match(feedback, /data-tolerance="free"/);
  assert.match(feedback, /exercise_id/);
  assert.match(feedback, /\/training-symptoms\?on=\$\{viewedDate\}&include_resolved=1/);
  assert.match(status, /data-symptom-lifecycle/);
  assert.doesNotMatch(feedback, /\b(?:cleared|clearance|diagnos(?:e|is))\b/i);
});
