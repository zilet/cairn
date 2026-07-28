import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../dist/mcp.js";
import { dayCoachRouter } from "../dist/routes/day-coach.js";
import { db, repo } from "./_seed.js";

function session(name = "Surface session") {
  return {
    name,
    why: "A bounded functional surface fixture.",
    items: [{ exercise: "Surface Squat", sets: 3, rep_low: 5, rep_high: 8 }],
  };
}

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
    dayCoachRouter.handle(request, response, (error) => {
      reject(error ?? new Error(`no day-coach route handled ${method} ${url}`));
    });
  });
}

function completedSuggestionJob(date, canonicalSession = session("Canonical agent session")) {
  const job = repo.createAgentJob({ kind: "session_suggest", input: { date, focus: "canonical focus" } });
  return repo.finishAgentJob(job.id, {
    chosen_agent: "codex",
    result: { ok: true, session: canonicalSession, agent: "codex", tried: [{ agent: "codex" }] },
  });
}

test("daily-session REST routes functionally cover null/read, success, coded refusal, and canonical jobs", async () => {
  const date = "2032-03-02";

  assert.deepEqual((await routerRequest("GET", "/daily-session", { query: { date } })).body, null);
  const created = await routerRequest("POST", "/daily-session/prepare", {
    body: { date, source: "athlete_override", session: session() },
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.session.id, created.body.daily_session.session_id);
  assert.equal(
    (await routerRequest("GET", "/daily-session", { query: { date } })).body.id,
    created.body.daily_session.id
  );
  const asserted = await routerRequest("POST", "/daily-session/prepare", {
    body: { date, expected_active_id: created.body.daily_session.id },
  });
  assert.equal(asserted.status, 200);
  assert.equal(asserted.body.reused, true);
  assert.equal(asserted.body.daily_session.id, created.body.daily_session.id);
  assert.equal(asserted.body.session.id, created.body.session.id);
  const changed = await routerRequest("POST", "/daily-session/prepare", {
    body: { date, expected_active_id: created.body.daily_session.id + 1 },
  });
  assert.equal(changed.status, 400);
  assert.equal(changed.body.code, "daily_session_changed");
  const missing = await routerRequest("POST", "/daily-session/prepare", {
    body: { date: "2032-03-20", expected_active_id: created.body.daily_session.id },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "daily_session_missing");
  assert.deepEqual(
    db
      .prepare(`SELECT version, status FROM daily_session_compositions WHERE date = ? ORDER BY version`)
      .all(date)
      .map((row) => ({ ...row })),
    [{ version: 1, status: "active" }]
  );

  repo.logSetByName({ date, exercise: "Surface Squat", weight: 135, reps: 5, day_number: null });
  const locked = await routerRequest("POST", "/daily-session/prepare", {
    body: { date, source: "athlete_override", replace: true, session: session("Replacement") },
  });
  assert.equal(locked.status, 400);
  assert.equal(locked.body.code, "daily_session_locked");

  const agentDate = "2032-03-03";
  const missingJob = await routerRequest("POST", "/daily-session/prepare", {
    body: { date: agentDate, source: "agent_suggest", session: session("Inline spoof") },
  });
  assert.equal(missingJob.status, 400);
  assert.equal(missingJob.body.code, "agent_job_required");

  const job = completedSuggestionJob(agentDate);
  const canonical = await routerRequest("POST", "/daily-session/prepare", {
    body: {
      date: agentDate,
      source: "agent_suggest",
      agent_job_id: job.id,
      session: session("Inline spoof"),
    },
  });
  assert.equal(canonical.status, 200);
  assert.equal(canonical.body.daily_session.title, "Canonical agent session");
  assert.equal(canonical.body.daily_session.provenance.agent_job_id, job.id);
});

async function mcpHarness() {
  const server = buildMcpServer();
  const client = new Client({ name: "cairn-functional-test", version: "1.0.0" });
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

test("registered MCP daily-session tools use the shared prepare behavior for success and coded errors", async () => {
  const date = "2032-03-04";
  const { client, server } = await mcpHarness();
  try {
    assert.deepEqual(toolJson(await client.callTool({ name: "get_daily_session", arguments: { date } })), null);
    const created = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: { date, source: "athlete_override", session: session("MCP session") },
      })
    );
    assert.equal(created.ok, true);
    assert.equal(created.session.id, created.daily_session.session_id);
    assert.equal(
      toolJson(await client.callTool({ name: "get_daily_session", arguments: { date } })).id,
      created.daily_session.id
    );
    const asserted = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: { date, expected_active_id: created.daily_session.id },
      })
    );
    assert.equal(asserted.ok, true);
    assert.equal(asserted.reused, true);
    assert.equal(asserted.daily_session.id, created.daily_session.id);
    assert.equal(asserted.session.id, created.session.id);
    const changed = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: { date, expected_active_id: created.daily_session.id + 1 },
      })
    );
    assert.equal(changed.code, "daily_session_changed");
    const missing = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: { date: "2032-03-21", expected_active_id: created.daily_session.id },
      })
    );
    assert.equal(missing.code, "daily_session_missing");
    assert.deepEqual(
      db
        .prepare(`SELECT version, status FROM daily_session_compositions WHERE date = ? ORDER BY version`)
        .all(date)
        .map((row) => ({ ...row })),
      [{ version: 1, status: "active" }]
    );

    repo.logSetByName({ date, exercise: "Surface Squat", weight: 135, reps: 5, day_number: null });
    const locked = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: { date, source: "athlete_override", replace: true, session: session("MCP replacement") },
      })
    );
    assert.equal(locked.code, "daily_session_locked");

    const agentDate = "2032-03-05";
    const missingJob = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: { date: agentDate, source: "agent_suggest", session: session("Inline spoof") },
      })
    );
    assert.equal(missingJob.code, "agent_job_required");

    const job = completedSuggestionJob(agentDate, session("MCP canonical session"));
    const canonical = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: {
          date: agentDate,
          source: "agent_suggest",
          agent_job_id: job.id,
          session: session("Inline spoof"),
        },
      })
    );
    assert.equal(canonical.ok, true);
    assert.equal(canonical.daily_session.title, "MCP canonical session");
    assert.equal(canonical.daily_session.provenance.agent_job_id, job.id);

    const invalid = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: { date: "2032-02-31", source: "athlete_override", session: session() },
      })
    );
    assert.equal(invalid.code, "daily_session_invalid");
  } finally {
    await client.close();
    await server.close();
  }
});

test("REST and MCP expose the same additive athlete-facing completed outcome read", async () => {
  const date = "2032-03-06";
  const created = await routerRequest("POST", "/daily-session/prepare", {
    body: { date, source: "athlete_override", session: session("Outcome session") },
  });
  repo.logSetByName({ date, exercise: "Surface Squat", weight: 135, reps: 5, rir: 2, day_number: null });
  repo.logSetByName({ date, exercise: "Surface Squat", weight: 135, reps: 5, rir: 2, day_number: null });
  repo.logSetByName({ date, exercise: "Surface Squat", weight: 135, reps: 5, rir: 2, day_number: null });
  repo.finishSession(created.body.session.id, null);

  const rest = await routerRequest("GET", "/daily-session/outcome", {
    query: { session_id: String(created.body.session.id) },
  });
  assert.equal(rest.status, 200);
  assert.equal(rest.body.session_id, created.body.session.id);
  assert.equal(typeof rest.body.athlete_read.learning, "string");
  assert.equal(rest.body.athlete_read.next_exposure, null);
  assert.ok(rest.body.facts, "existing reconciliation facts remain available");

  for (const session_id of ["abc", "0"]) {
    const invalid = await routerRequest("GET", "/daily-session/outcome", {
      query: { session_id, date },
    });
    assert.equal(invalid.status, 400, session_id);
    assert.match(invalid.body.error, /session_id must be a positive integer/);
  }

  const { client, server } = await mcpHarness();
  try {
    const mcp = toolJson(
      await client.callTool({
        name: "get_daily_session_outcome",
        arguments: { session_id: created.body.session.id },
      })
    );
    assert.deepEqual(mcp, rest.body);
  } finally {
    await client.close();
    await server.close();
  }
});

test("REST and MCP mirror the explicit Train-anyway decision and accepted fingerprint", async () => {
  repo.savePlanDay(1, "Surface strength", "Full body", [
    { exercise: "Surface Squat", sets: 4, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);

  const restDate = "2032-03-12";
  repo.addCheckin(restDate, { sleep_feel: 1, energy: 3, mood: 3 });
  const restDecision = await routerRequest("GET", "/daily-session/decision", { query: { date: restDate } });
  assert.equal(restDecision.body.kind, "rest");

  const restPrepared = await routerRequest("POST", "/daily-session/prepare", {
    body: { date: restDate, source: "adaptive_plan" },
  });
  assert.equal(restPrepared.body.daily_session.decision.kind, "rest");
  assert.ok(restPrepared.body.daily_session.items.every((item) => item.kind === "cardio"));

  const trainDate = "2032-03-13";
  repo.addCheckin(trainDate, { sleep_feel: 1, energy: 3, mood: 3 });
  const restBaseline = await routerRequest("GET", "/daily-session/decision", { query: { date: trainDate } });
  assert.equal(restBaseline.body.kind, "rest");
  const restFingerprint = restBaseline.body.input_fingerprint;
  const trainDecision = await routerRequest("GET", "/daily-session/decision", {
    query: { date: trainDate, train_anyway: "true" },
  });
  assert.equal(trainDecision.body.kind, "train");
  assert.equal(trainDecision.body.baseline_kind, "rest");
  assert.equal(trainDecision.body.request.train_anyway, true);
  assert.notEqual(trainDecision.body.input_fingerprint, restFingerprint);

  const trainPrepared = await routerRequest("POST", "/daily-session/prepare", {
    body: { date: trainDate, source: "adaptive_plan", train_anyway: true },
  });
  assert.equal(
    trainPrepared.body.daily_session.decision.input_fingerprint,
    trainDecision.body.input_fingerprint
  );

  const mcpDate = "2032-03-14";
  repo.addCheckin(mcpDate, { sleep_feel: 1, energy: 3, mood: 3 });
  const { client, server } = await mcpHarness();
  try {
    const mcpDecision = toolJson(
      await client.callTool({
        name: "get_daily_session_decision",
        arguments: { date: mcpDate, train_anyway: true },
      })
    );
    const mcpPrepared = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: { date: mcpDate, source: "adaptive_plan", train_anyway: true },
      })
    );
    assert.equal(mcpDecision.kind, "train");
    assert.equal(mcpDecision.baseline_kind, "rest");
    assert.equal(
      mcpPrepared.daily_session.decision.input_fingerprint,
      mcpDecision.input_fingerprint
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("REST and MCP share the read-only preview and stale compare-and-set truth", async () => {
  const date = "2032-03-18";
  repo.savePlanDay(1, "Surface strength", "Full body", [
    { exercise: "Surface Squat", sets: 4, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  const before = {
    decisions: db.prepare(`SELECT COUNT(*) AS n FROM daily_session_decisions`).get().n,
    compositions: db.prepare(`SELECT COUNT(*) AS n FROM daily_session_compositions`).get().n,
    sessions: db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
  };
  const restPreview = await routerRequest("GET", "/daily-session/preview", {
    query: { date, override: "short on time" },
  });
  assert.equal(restPreview.status, 200);

  const { client, server } = await mcpHarness();
  try {
    const mcpPreview = toolJson(
      await client.callTool({
        name: "preview_daily_session",
        arguments: { date, override: "short on time" },
      })
    );
    assert.deepEqual(mcpPreview, restPreview.body);
    assert.deepEqual(
      {
        decisions: db.prepare(`SELECT COUNT(*) AS n FROM daily_session_decisions`).get().n,
        compositions: db.prepare(`SELECT COUNT(*) AS n FROM daily_session_compositions`).get().n,
        sessions: db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      },
      before,
      "neither preview surface writes"
    );

    repo.savePlanDay(1, "Changed surface strength", "Updated full body", [
      { exercise: "Surface Squat", sets: 2, rep_low: 8, rep_high: 10, target_weight: 115 },
    ]);
    const staleRest = await routerRequest("POST", "/daily-session/prepare", {
      body: {
        date,
        source: "adaptive_plan",
        constraints: { day_read_override: "short on time" },
        expected_input_fingerprint: restPreview.body.input_fingerprint,
      },
    });
    assert.equal(staleRest.status, 409);
    assert.equal(staleRest.body.code, "daily_session_preview_stale");
    assert.notEqual(staleRest.body.preview.input_fingerprint, restPreview.body.input_fingerprint);

    const staleMcp = toolJson(
      await client.callTool({
        name: "prepare_daily_session",
        arguments: {
          date,
          source: "adaptive_plan",
          constraints: { day_read_override: "short on time" },
          expected_input_fingerprint: restPreview.body.input_fingerprint,
        },
      })
    );
    assert.equal(staleMcp.code, "daily_session_preview_stale");
    assert.deepEqual(staleMcp.preview, staleRest.body.preview);
    assert.deepEqual(
      {
        decisions: db.prepare(`SELECT COUNT(*) AS n FROM daily_session_decisions`).get().n,
        compositions: db.prepare(`SELECT COUNT(*) AS n FROM daily_session_compositions`).get().n,
        sessions: db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n,
      },
      before,
      "stale REST and MCP compare-and-set calls write nothing"
    );

    const accepted = await routerRequest("POST", "/daily-session/prepare", {
      body: {
        date,
        source: "adaptive_plan",
        constraints: { day_read_override: "short on time" },
        expected_input_fingerprint: staleRest.body.preview.input_fingerprint,
      },
    });
    assert.equal(accepted.status, 200);
    assert.equal(
      accepted.body.daily_session.decision.input_fingerprint,
      staleRest.body.preview.input_fingerprint
    );
  } finally {
    await client.close();
    await server.close();
  }
});
