// Deleting an activity: a hand-logged row (a mis-entry, a chat capture that should
// never have been an activity) can be removed from REST and MCP alike, while a
// watch-imported row is refused — the next sync would only bring it back.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, repo, resetTables } from "./_seed.js";
import { trainingLogRouter } from "../dist/routes/training-log.js";
import { registerTrainingLogTools } from "../dist/surfaces/mcp/training-log.js";

beforeEach(() => {
  resetTables("garmin_activities", "activities", "garmin_sources");
});

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use("/api", trainingLogRouter);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        resolve(await fn(base));
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

function mcpTools() {
  const tools = new Map();
  registerTrainingLogTools({ tool: (name, _d, _s, handler) => tools.set(name, handler) });
  return async (name, args) => JSON.parse((await tools.get(name)(args)).content[0].text);
}

function activityCount() {
  return db.prepare(`SELECT COUNT(*) AS n FROM activities`).get().n;
}

test("removeActivity deletes a hand-logged row and refuses what it cannot", () => {
  const manual = repo.addActivity({ text: "173", date: "2026-06-10", enrichment_status: null });
  assert.deepEqual(repo.removeActivity(manual.id), { ok: true, id: manual.id, date: "2026-06-10" });
  assert.equal(repo.getActivity(manual.id), null);

  const again = repo.removeActivity(manual.id);
  assert.equal(again.ok, false);
  assert.equal(again.code, "not_found");
  assert.equal(repo.removeActivity(0).code, "invalid_id");
  assert.equal(repo.removeActivity(Number.NaN).code, "invalid_id");
});

test("a watch-imported activity is refused, and stays", () => {
  const garmin = repo.upsertGarminActivity({
    external_id: "watch-run-1",
    date: "2026-06-10",
    type: "run",
    name: "Morning run",
    duration_min: 30,
    distance_km: 5,
  });
  const row = db.prepare(`SELECT id FROM activities WHERE source = 'garmin' AND external_id = 'watch-run-1'`).get();
  assert.ok(row, JSON.stringify(garmin));
  const refused = repo.removeActivity(row.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "watch_imported");
  assert.match(refused.error, /next sync would bring it back/);
  assert.ok(repo.getActivity(row.id), "the watch row is still there");

  // Any externally keyed row is refused the same way, whatever its source label.
  const imported = repo.addActivity({ date: "2026-06-10", type: "ride", source: "import", external_id: "x-1" });
  assert.equal(repo.removeActivity(imported.id).code, "watch_imported");
});

test("DELETE /api/activities/:id mirrors the repo, with a status per refusal", async () => {
  const manual = repo.addActivity({ text: "Let's start a push session", enrichment_status: null });
  const garmin = repo.addActivity({ date: "2026-06-10", type: "run", source: "garmin", external_id: "g-1" });
  await withServer(async (base) => {
    const ok = await fetch(`${base}/api/activities/${manual.id}`, { method: "DELETE" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);

    const missing = await fetch(`${base}/api/activities/${manual.id}`, { method: "DELETE" });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, "not_found");

    const refused = await fetch(`${base}/api/activities/${garmin.id}`, { method: "DELETE" });
    assert.equal(refused.status, 409);
    const body = await refused.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "watch_imported");

    const bad = await fetch(`${base}/api/activities/abc`, { method: "DELETE" });
    assert.equal(bad.status, 400);
  });
  assert.equal(activityCount(), 1, "only the watch row remains");
});

test("the delete_activity MCP tool is the near-mirror of the route", async () => {
  const call = mcpTools();
  const manual = repo.addActivity({ text: "walked the dog", enrichment_status: null });
  const garmin = repo.addActivity({ date: "2026-06-10", type: "run", source: "garmin", external_id: "g-2" });
  assert.deepEqual(await call("delete_activity", { id: manual.id }), {
    ok: true,
    id: manual.id,
    date: manual.date,
  });
  const refused = await call("delete_activity", { id: garmin.id });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "watch_imported");
  assert.equal((await call("delete_activity", { id: manual.id })).code, "not_found");
  assert.equal(activityCount(), 1);
});

// Correcting an activity (2026-11-07): PATCH /api/activities/:id and MCP update_activity
// share correctActivity — a hand log's sport or length changes, a watch row is refused.
test("PATCH /activities/:id and update_activity correct a hand log; status codes say why not", async () => {
  const manual = repo.addActivity({
    text: "10 min session",
    type: "other",
    date: "2026-06-10",
    enrichment_status: null,
  });
  await withServer(async (base) => {
    const patch = (id, body) =>
      fetch(`${base}/api/activities/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await patch(manual.id, { type: "boxing" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).activity.type, "boxing");
    assert.equal((await patch(manual.id, { duration_min: "" })).status, 400);
    assert.equal((await patch(999999, { type: "run" })).status, 404);
    const garmin = repo.upsertGarminActivity({
      external_id: "watch-fix-1",
      date: "2026-06-10",
      type: "run",
      name: "Run",
    });
    const watchId = repo.listActivities(50).find((a) => a.external_id === "watch-fix-1")?.id ?? garmin?.activity_id;
    assert.equal((await patch(watchId, { type: "ride" })).status, 409);
  });
  const call = mcpTools();
  const viaMcp = await call("update_activity", { id: manual.id, type: "martial_arts", duration_min: 30 });
  assert.equal(viaMcp.ok, true);
  assert.equal(viaMcp.activity.type, "martial_arts");
  assert.equal(viaMcp.activity.duration_min, 30);
});
