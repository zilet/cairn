// Payload-trim routes over loopback: GET /mealplans?fields=summary (slim meal-plan
// list, src/routes/nutrition.ts) and GET /garmin/daily's raw_json opt-in via ?raw=1
// (src/routes/garmin.ts). Both are additive — the default response of each route is
// unchanged — so the express wiring, query parsing, and status codes are under test
// rather than the repo functions those already have their own coverage.
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { completeMealWeek, db, repo, resetTables } from "./_seed.js";
import { nutritionRouter } from "../dist/routes/nutrition.js";
import { garminRouter } from "../dist/routes/garmin.js";

let server = null;
let base = "";

async function listener() {
  if (server) return base;
  const app = express();
  app.use(express.json());
  app.use("/api", nutritionRouter);
  app.use("/api", garminRouter);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
  return base;
}

async function get(path) {
  const url = await listener();
  const res = await fetch(`${url}${path}`);
  return { status: res.status, body: await res.json() };
}

after(() => server?.close());

beforeEach(() => resetTables("meal_plans", "garmin_sources", "garmin_daily_metrics"));

test("GET /mealplans (default) still carries the full plan, but ?fields=summary trims it", async () => {
  db.prepare(`INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json, status) VALUES (?, ?, ?, ?, ?)`).run(
    "2026-01-02",
    "stub",
    "agent narration",
    JSON.stringify(completeMealWeek({})),
    "accepted"
  );

  const full = await get("/mealplans?limit=6");
  assert.equal(full.status, 200);
  assert.ok(full.body[0].parsed, "the default response is unchanged — still carries parsed");
  assert.ok(full.body[0].raw_output, "and raw_output");

  const summary = await get("/mealplans?limit=6&fields=summary");
  assert.equal(summary.status, 200);
  assert.equal(summary.body[0].parsed, undefined, "the summary drops parsed");
  assert.equal(summary.body[0].raw_output, undefined, "and raw_output");
  assert.equal(summary.body[0].days[0].meals[0].name, "Meal-plan fixture");
  assert.equal(typeof summary.body[0].adequate, "boolean");
});

test("GET /garmin/daily drops raw_json by default; ?raw=1 restores it", async () => {
  repo.upsertGarminDailyMetric({ date: "2026-01-02", steps: 8000, resting_hr: 52 }, undefined, {
    // raw_json is only set on the wire-shaped write path; write it directly here.
  });
  db.prepare(`UPDATE garmin_daily_metrics SET raw_json = ? WHERE date = ?`).run(
    JSON.stringify({ some: "device payload" }),
    "2026-01-02"
  );

  const trimmed = await get("/garmin/daily?limit=1");
  assert.equal(trimmed.status, 200);
  assert.equal(trimmed.body[0].date, "2026-01-02");
  assert.equal(trimmed.body[0].steps, 8000);
  assert.equal(trimmed.body[0].raw_json, undefined, "raw_json is dropped by default");
  assert.equal(trimmed.body[0].raw, undefined);

  const raw = await get("/garmin/daily?limit=1&raw=1");
  assert.equal(raw.status, 200);
  assert.deepEqual(raw.body[0].raw, { some: "device payload" }, "?raw=1 restores the parsed payload");
});
