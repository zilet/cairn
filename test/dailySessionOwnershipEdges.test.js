// The edges of the daily-session ownership contract the matrix
// (test/_dailySessionMatrix.mjs) does not reach: a date with no weekly plan at all, the
// chat "let's start today's session" door, the MCP twin's body, discard's conflicts, the
// finished-day rules, and the request-validation answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../dist/mcp.js";
import { dailySessionErrorBody } from "../dist/domain/training/adaptive-session-use-case.js";
import { applyChatStartSession, applyChatTodaySession } from "../dist/domain/training/chat-today-session.js";
import {
  DATE,
  OPEN_SESSION,
  OWNER_STATES,
  assertOpened,
  assertOwnerShape,
  assertReadable,
  chosenCard,
  prepareRoute,
  routerRequest,
  seedPlan,
  suggestionJob,
} from "./_dailySessionMatrix.mjs";
import { db, repo } from "./_seed.js";

const sessionRow = (id) => db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);
const logOne = () =>
  Number(repo.logSetByName({ date: DATE, exercise: "Barbell Row", weight: 115, reps: 8 }).session_id);

let savepoint = 0;
async function rolledBack(run) {
  const name = `edge_${++savepoint}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    return await run();
  } finally {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
  }
}

async function mcpHarness() {
  const server = buildMcpServer();
  const client = new Client({ name: "daily-session-edges", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

// ---- a date with no weekly plan --------------------------------------------------------

test("no plan: an open adaptive request still opens whatever the date holds", async () => {
  const job = suggestionJob("No-plan suggestion");
  const requests = {
    adaptive_plan: { source: "adaptive_plan" },
    agent_suggest: { source: "agent_suggest", agent_job_id: job.id },
    athlete_override: { source: "athlete_override", session: chosenCard("Typed card") },
  };
  // (manual_plan is pruned here: on a date with no plan it names a plan day that does
  // not exist, which is a malformed request.)
  const states = {
    none: () => null,
    legacy_unstarted: () => Number(db.prepare(`INSERT INTO sessions (date) VALUES (?)`).run(DATE).lastInsertRowid),
    legacy_started: () => logOne(),
    legacy_finished: () => {
      const id = logOne();
      repo.finishSession(id);
      return id;
    },
    override_items: () =>
      Number(
        repo.prepareDailySession({ date: DATE, source: "athlete_override", session: chosenCard("Owner") }).session_id
      ),
    override_empty: () =>
      Number(repo.prepareDailySession({ date: DATE, source: "athlete_override", session: OPEN_SESSION }).session_id),
  };
  for (const [stateName, setup] of Object.entries(states)) {
    for (const [source, request] of Object.entries(requests)) {
      await rolledBack(async () => {
        const label = `no plan · ${stateName} · ${source}`;
        const ownerId = setup();
        const before = ownerId ? { ...sessionRow(ownerId) } : null;
        const active = repo.getActiveDailySession(DATE);
        const res = await prepareRoute({ date: DATE, ...request });
        if (!ownerId && source === "adaptive_plan") {
          // Nothing on the date and nothing to build from: the honest absence, as before.
          assert.equal(res.status, 400, label);
          assert.equal(res.body.code, "daily_session_no_template", label);
          return;
        }
        assertOpened(res, label);
        if (!ownerId) return;
        assert.equal(Number(res.body.session.id), ownerId, `${label}: the date's own session`);
        if (active) {
          assert.equal(res.body.reused, true, label);
          assert.equal(res.body.daily_session.id, active.id, label);
        } else if (source === "adaptive_plan") {
          // Adopted as the athlete's open session — the one thing an open request can bind.
          assert.equal(res.body.daily_session.source, "athlete_override", label);
          assert.equal(res.body.daily_session.title, "Open session", label);
        }
        if (before && Number(before.id) && stateName !== "legacy_unstarted" && !active) {
          const after = sessionRow(ownerId);
          assert.equal(after.finished_at, before.finished_at, `${label}: a lived session keeps its finish stamp`);
          assert.equal(after.plan_day_id, before.plan_day_id, `${label}: and its plan-day link`);
        }
      });
    }
  }
});

test("no plan: an adaptive composition whose plan was removed still opens", async () => {
  seedPlan();
  const prepared = repo.prepareDailySession({ date: DATE, source: "adaptive_plan" });
  repo.deletePlanDay(1);
  repo.deletePlanDay(2);
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM plan_days`).get().n), 0);
  const res = await prepareRoute({ date: DATE, source: "adaptive_plan" });
  assertOpened(res, "plan removed");
  assert.equal(res.body.reused, true);
  assert.equal(res.body.daily_session.id, prepared.daily_session.id);
});

// ---- chat: "let's start today's session" ----------------------------------------------

test("chat start_session opens the owner of every state and never fails a day that has a session", async () => {
  seedPlan();
  const jobs = { owner: suggestionJob("Owner suggestion"), request: suggestionJob("Request suggestion") };
  for (const state of OWNER_STATES) {
    await rolledBack(async () => {
      const ownerId = state.setup(jobs);
      const active = repo.getActiveDailySession(DATE);
      const result = applyChatStartSession({ date: DATE });
      const label = `chat · ${state.name}`;
      assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
      assert.ok(result.open && result.open.kind === "session" && result.open.date === DATE, label);
      assert.match(result.open.label, /^(Start|Continue) /, label);
      assert.ok(Number.isInteger(result.daily_session_id), label);
      assert.equal(repo.getActiveDailySession(DATE).id, result.daily_session_id, `${label}: the day's composition`);
      if (ownerId) assert.equal(result.session_id, ownerId, `${label}: the owner's session`);
      if (active) {
        assert.equal(result.reused, true, label);
        assert.equal(result.daily_session_id, active.id, label);
      }
      if (ownerId) {
        const sets = Number(db.prepare(`SELECT COUNT(*) AS n FROM logged_sets WHERE session_id = ?`).get(ownerId).n);
        assert.equal(result.started, sets > 0, label);
        assert.match(result.open.label, sets > 0 ? /^Continue / : /^Start /, label);
      }
      assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE date = ?`).get(DATE).n), 1, label);
    });
  }
});

test("chat start_session with no plan: a logged day is adopted; an empty day is the honest absence", async () => {
  const empty = applyChatStartSession({ date: DATE });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, "daily_session_no_template");
  assert.equal(empty.open, null);

  const logged = logOne();
  const result = applyChatStartSession({ date: DATE });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.session_id, logged);
  assert.equal(result.started, true);
  assert.match(result.open.label, /^Continue /);
});

test("chat today_session refused over logged work still points at the session that holds it", () => {
  seedPlan();
  const logged = logOne();
  const result = applyChatTodaySession(
    {
      title: "Upper",
      items: [{ exercise: "Chest-Supported Row", sets: 3, rep_low: 8, rep_high: 12 }],
    },
    { date: DATE }
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, "daily_session_locked");
  assert.equal(result.session_id, logged);
  assert.equal(result.started, true);
  assert.equal(result.open?.kind, "session");
  assert.match(result.open.label, /^Continue /);
  // And chat's start_session then opens it.
  const started = applyChatStartSession({ date: DATE });
  assert.equal(started.ok, true);
  assert.equal(started.session_id, logged);
});

// ---- the MCP twin answers with the same body -----------------------------------------

test("every conflict body is the same on REST and MCP", async () => {
  seedPlan();
  const { client, server } = await mcpHarness();
  const mcp = async (args) =>
    JSON.parse((await client.callTool({ name: "prepare_daily_session", arguments: args })).content[0].text);
  try {
    // A session logged outside any composition.
    const legacy = logOne();
    const replace = { date: DATE, source: "athlete_override", replace: true, session: chosenCard("Other") };
    const lockedRest = await prepareRoute(replace);
    assert.equal(lockedRest.status, 409);
    assert.equal(lockedRest.body.code, "daily_session_locked");
    assert.deepEqual(lockedRest.body.owner, {
      daily_session_id: null,
      session_id: legacy,
      source: null,
      title: lockedRest.body.owner.title,
      set_count: 1,
      started: true,
    });
    assertReadable(lockedRest.body.error, "locked");
    assert.deepEqual(await mcp(replace), lockedRest.body);

    const missing = { date: DATE, expected_active_id: 4242 };
    const missingRest = await prepareRoute(missing);
    assert.equal(missingRest.body.code, "daily_session_missing");
    assert.equal(missingRest.body.owner.session_id, legacy);
    assert.deepEqual(await mcp(missing), missingRest.body);

    // The documented way to open it: the plain prepare adopts the row.
    const opened = await prepareRoute({ date: DATE, source: "adaptive_plan" });
    assertOpened(opened, "adopt");
    assert.equal(opened.body.session.id, legacy);

    const changed = { date: DATE, expected_active_id: opened.body.daily_session.id + 7 };
    const changedRest = await prepareRoute(changed);
    assert.equal(changedRest.body.code, "daily_session_changed");
    assertOwnerShape(changedRest.body.owner, "changed");
    assert.equal(changedRest.body.owner.daily_session_id, opened.body.daily_session.id);
    assert.deepEqual(await mcp(changed), changedRest.body);
  } finally {
    await client.close();
    await server.close();
  }
});

test("an adaptive request never takes the athlete's itemful card; REST and MCP agree", async () => {
  seedPlan();
  const card = repo.prepareDailySession({ date: DATE, source: "athlete_override", session: chosenCard("Mine") });
  const { client, server } = await mcpHarness();
  try {
    const body = { date: DATE, source: "adaptive_plan", replace: true };
    const rest = await prepareRoute(body);
    assert.equal(rest.status, 409);
    assert.equal(rest.body.code, "daily_session_active_changed");
    assert.equal(rest.body.owner.daily_session_id, card.daily_session.id);
    assertReadable(rest.body.error, "active_changed");
    const viaMcp = JSON.parse(
      (await client.callTool({ name: "prepare_daily_session", arguments: body })).content[0].text
    );
    assert.deepEqual(viaMcp, rest.body);
  } finally {
    await client.close();
    await server.close();
  }
});

// ---- discard ---------------------------------------------------------------------------

test("discard's conflicts carry the owner the client opens, in words a person reads", async () => {
  seedPlan();
  const legacy = logOne();
  const missing = await routerRequest("POST", "/daily-session/discard", { date: DATE, expected_active_id: 9 });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, "daily_session_missing");
  assert.equal(missing.body.owner.session_id, legacy);
  assert.equal(missing.body.owner.daily_session_id, null);
  assertReadable(missing.body.error, "discard missing");

  const opened = repo.prepareDailySession({ date: DATE, source: "adaptive_plan" });
  const locked = await routerRequest("POST", "/daily-session/discard", {
    date: DATE,
    expected_active_id: opened.daily_session.id,
  });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, "daily_session_locked");
  assert.equal(locked.body.owner.daily_session_id, opened.daily_session.id);
  assertReadable(locked.body.error, "discard locked");
  assert.ok(sessionRow(legacy), "logged work is never deleted");
});

test("discard of a free date says so, with no owner", async () => {
  const res = await routerRequest("POST", "/daily-session/discard", { date: DATE, expected_active_id: 9 });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "daily_session_missing");
  assert.equal(res.body.owner, undefined);
  assertReadable(res.body.error, "free");
});

// ---- finished days -------------------------------------------------------------------

test("a finished day: open returns it; a replace is refused with it; an empty finish starts over", async () => {
  seedPlan();
  const prepared = repo.prepareDailySession({ date: DATE, source: "manual_plan", day_number: 1 });
  const sessionId = Number(prepared.session_id);
  logOne();
  repo.finishSession(sessionId);
  const finishedAt = sessionRow(sessionId).finished_at;

  for (const source of ["adaptive_plan", "athlete_override"]) {
    const open = await prepareRoute({ date: DATE, source, session: chosenCard("Another") });
    assertOpened(open, `open ${source}`);
    assert.equal(open.body.reused, true);
    assert.equal(open.body.daily_session.id, prepared.daily_session.id);
    assert.equal(sessionRow(sessionId).finished_at, finishedAt, "opening never reopens or rewrites the day");
  }
  for (const body of [
    { source: "athlete_override", replace: true, session: chosenCard("Another") },
    { source: "adaptive_plan", replace: true, train_anyway: true },
  ]) {
    const refused = await prepareRoute({ date: DATE, ...body });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "daily_session_locked");
    assert.equal(refused.body.owner.daily_session_id, prepared.daily_session.id);
    assert.equal(refused.body.owner.started, true);
  }
  assert.equal(Number(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE date = ?`).get(DATE).n), 1);

  // A day finished with nothing logged (every lift skipped) holds no work: a replace
  // starts it over on the same row, and the finish stamp goes with the old card.
  await rolledBack(async () => {
    db.prepare(`DELETE FROM logged_sets WHERE session_id = ?`).run(sessionId);
    db.prepare(`UPDATE sessions SET duration_min = NULL WHERE id = ?`).run(sessionId);
    const over = await prepareRoute({
      date: DATE,
      source: "athlete_override",
      replace: true,
      session: chosenCard("Over"),
    });
    assertOpened(over, "start over");
    assert.equal(over.body.session.id, sessionId);
    assert.equal(sessionRow(sessionId).finished_at, null);
  });
});

// ---- request validation ------------------------------------------------------------------

test("a malformed expected_active_id is a 400; null is the same as absent", async () => {
  seedPlan();
  for (const bad of [0, -3, 1.5, "abc"]) {
    const res = await prepareRoute({ date: DATE, expected_active_id: bad });
    assert.equal(res.status, 400, String(bad));
    assert.equal(res.body.code, "daily_session_invalid");
  }
  const res = await prepareRoute({ date: DATE, source: "adaptive_plan", expected_active_id: null });
  assertOpened(res, "null expected_active_id");
  for (const bad of [{ date: "2032-13-40" }, { date: DATE, source: "nonsense" }]) {
    const refused = await prepareRoute(bad);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "daily_session_invalid");
  }
});

test("a foreign error never leaks its code or message into the body", () => {
  const driver = Object.assign(new Error("SQLITE_BUSY: database is locked at /data/x.db"), {
    code: "ERR_SQLITE_ERROR",
  });
  const body = dailySessionErrorBody(driver);
  assert.equal(body.code, "daily_session_invalid");
  assert.doesNotMatch(body.error, /SQLITE|\/data/);
  assertReadable(body.error, "foreign");
  const plain = dailySessionErrorBody(new Error("date must be YYYY-MM-DD"));
  assert.deepEqual(plain, { ok: false, code: "daily_session_invalid", error: "date must be YYYY-MM-DD" });
});
