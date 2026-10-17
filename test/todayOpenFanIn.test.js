// The Today open, server side (routes/today-responses.ts, repo/since-last.ts): the
// Fuel glance under the Brief draws on every Today open for today, so its two reads —
// the day's intake and the ideas for the device's hour — ride the /today fan-in, each
// exactly as its own route answers; a reader that throws leaves only its own path out;
// and the "seen" stamp the aggregate writes mid-request no longer retires the reads the
// request memoized before it (while the HTTP response memo still hears it).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { api } from "../dist/api.js";
import { settleAgentLoginChecks } from "../dist/agents.js";
import { runWithBrainSnapshot } from "../dist/brain/snapshot.js";
import { markTodayAgendaSeen } from "../dist/domain/today/index.js";
import { getProgramState } from "../dist/repo/program-state.js";
import { activeRequestMemoStats } from "../dist/repo/request-memo.js";
import { responseFreshnessKey } from "../dist/repo/response-freshness.js";
import { getAgentConfig } from "../dist/repo/settings.js";
import { localDateISO } from "../dist/repo/shared.js";
import { resetResponseMemo } from "../dist/routes/response-memo.js";
import { todaySurfaceResponses } from "../dist/routes/today-responses.js";
import { db, repo, isoDaysAgo } from "./_seed.js";

let server = null;
let base = "";

async function listener() {
  if (server) return base;
  // /settings peeks the CLI probes; warm them so the fan-in and the route agree.
  getAgentConfig({ loginProbe: "peek" });
  await settleAgentLoginChecks(10_000);
  const app = express();
  app.use(express.json());
  app.use("/api", api);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

after(() => server?.close());

async function get(path) {
  const res = await fetch((await listener()) + path);
  assert.equal(res.status, 200, path);
  return JSON.parse(await res.text());
}

// Bookkeeping stamps a read may move on its own first call.
function comparable(body) {
  return JSON.parse(JSON.stringify(body), (key, value) =>
    key === "seen_through" || key === "updated_at" || key === "generated_at" ? undefined : value
  );
}

function seedDay() {
  repo.setProfile({ name: "Milo", weight_lb: 188, primary_discipline: "hybrid" });
  repo.savePlanDay(1, "Lift", "Strength", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
  ]);
  repo.addFoodNote("lunch", "", { items: [{ name: "rice bowl", kcal: 900, protein_g: 50 }], kcal: 900, protein_g: 50 });
}

/** Today at 10:20 in the process zone: a fixed hour, so the glance's key cannot roll over mid-test. */
function midMorning() {
  const at = new Date();
  at.setHours(10, 20, 0, 0);
  return at.getTime();
}

test("a Today open carries the Fuel glance's day and ideas, each as its own route answers", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: midMorning() });
  resetResponseMemo();
  seedDay();
  const date = localDateISO();
  const dayPath = `/nutrition/day?date=${date}`;
  const ideasPath = `/fuel/ideas?date=${date}&hour=10`;

  const { responses } = await get(`/api/today?date=${date}&surface=today`);
  // Whatever the agenda's rail names: the glance draws on every Today open.
  assert.ok(dayPath in responses, dayPath);
  assert.ok(ideasPath in responses, ideasPath);
  assert.equal(responses[dayPath].count, 1, "the day's own meal is in it");
  for (const path of [dayPath, ideasPath]) {
    assert.deepEqual(comparable(await get(`/api${path}`)), comparable(responses[path]), path);
  }

  // A past day has no glance: its ideas are never computed for it.
  const past = isoDaysAgo(2);
  const earlier = (await get(`/api/today?date=${past}&surface=today`)).responses;
  assert.equal(
    Object.keys(earlier).some((path) => path.startsWith("/fuel/ideas")),
    false
  );
  t.mock.timers.reset();
});

test("the seen stamp never retires what the request already read, and is still news to the response memo", () => {
  seedDay();
  const date = localDateISO();
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('today_last_seen_at', datetime('now', '-2 hours'), datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run();
  const stamp = () => db.prepare(`SELECT value FROM app_state WHERE key = 'today_last_seen_at'`).get()?.value;
  const before = stamp();

  runWithBrainSnapshot(() => {
    const first = getProgramState();
    const computed = activeRequestMemoStats().computes.program_state;
    assert.ok(computed >= 1, "the read is memoized in this request");
    const key = responseFreshnessKey();

    markTodayAgendaSeen(date); // the first open after the debounce: the stamp advances
    assert.notEqual(stamp(), before, "the stamp moved");
    assert.notEqual(responseFreshnessKey(), key, "the response memo hears it, so this open is never stored");

    assert.deepEqual(getProgramState(), first);
    const stats = activeRequestMemoStats();
    assert.equal(stats.computes.program_state, computed, "the read the request already held is not recomputed");
    assert.equal(stats.stale, 0);

    // A write a read can see still retires it.
    repo.logWeight(186.2, date);
    getProgramState();
    assert.ok(activeRequestMemoStats().computes.program_state > computed, "a real write recomputes");
  });
});

// Last in the file: it shadows a table for one call (a TEMP table wins name lookup).
test("a fan-in reader that throws leaves only its own path out", () => {
  seedDay();
  const date = localDateISO();
  const opts = { agenda: null, progressionDay: null, coachingFocus: null, strengthJourney: null };
  const hour = new Date().getHours();
  const dayPath = `/nutrition/day?date=${date}`;
  const ideasPath = `/fuel/ideas?date=${date}&hour=${hour}`;

  db.exec(`CREATE TEMP TABLE food_notes (id INTEGER PRIMARY KEY)`);
  let broken;
  try {
    broken = runWithBrainSnapshot(() => todaySurfaceResponses(date, opts));
  } finally {
    db.exec(`DROP TABLE temp.food_notes`);
  }
  assert.equal(dayPath in broken, false, "the failed day read falls back to the glance's own request");
  assert.equal(ideasPath in broken, false);
  for (const path of ["/settings", "/profile", "/context-tags/vocab", `/today-plan-day?date=${date}`]) {
    assert.ok(path in broken, path);
  }

  const whole = runWithBrainSnapshot(() => todaySurfaceResponses(date, opts));
  if (new Date().getHours() === hour)
    assert.ok(ideasPath in whole && dayPath in whole, "once the table answers, both are back");
});
