// The Train, You -> Health and Session fan-ins (routes/screen-responses.ts,
// routes/today-responses.ts): one GET carries, in `responses`, the body every other
// read that screen makes would answer, keyed by the exact path the PWA asks with.
// Each entry must equal what its own route still answers (the fan-in is a request
// count optimization, never a second source of truth), a fan-in is never memoized
// past the reads it replaces, and the health-bearing ones are never stored.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { api, apiCacheControlFor } from "../dist/api.js";
import { resetResponseMemo } from "../dist/routes/response-memo.js";
import { localDateISO } from "../dist/repo/shared.js";
import { repo, isoDaysAgo, seedHealthDoc, marker } from "./_seed.js";

let server = null;
let base = "";

async function listener() {
  if (server) return base;
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
  const url = await listener();
  const res = await fetch(url + path);
  return { status: res.status, cc: res.headers.get("cache-control"), body: JSON.parse(await res.text()) };
}

// Bookkeeping stamps a read may move on its own first call ("seen" markers).
function comparable(body) {
  return JSON.parse(JSON.stringify(body), (key, value) =>
    key === "seen_through" || key === "updated_at" || key === "generated_at" ? undefined : value
  );
}

function seedAthlete() {
  repo.setProfile({ name: "Milo", weight_lb: 188, primary_discipline: "hybrid" });
  repo.savePlanDay(1, "Lift", "Strength", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 225 },
    { exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 5, target_weight: 165 },
  ]);
  for (const days of [14, 7]) {
    repo.logSetByName({ date: isoDaysAgo(days), day_number: 1, exercise: "Back Squat", weight: 215, reps: 5, rir: 2 });
    repo.logSetByName({ date: isoDaysAgo(days), day_number: 1, exercise: "Bench Press", weight: 155, reps: 5, rir: 2 });
  }
  seedHealthDoc(isoDaysAgo(30), [marker("LDL Cholesterol", 162, { unit: "mg/dL", flag: "H" }), marker("HbA1c", 5.4, { unit: "%" })]);
}

/** Every entry equals its own route's answer — asked AFTER the fan-in, so a read's own first-call side effects have settled. */
async function assertMirrorsRoutes(responses) {
  assert.ok(Object.keys(responses).length > 0, "the fan-in carries its reads");
  for (const [path, body] of Object.entries(responses)) {
    const own = await get(`/api${path}`);
    assert.equal(own.status, 200, path);
    assert.deepEqual(comparable(own.body), comparable(body), path);
  }
}

test("GET /train-home answers each view's reads, each exactly as its own route does", async () => {
  seedAthlete();
  const date = localDateISO();
  const expected = {
    overview: ["/stats", "/program/balance", "/muscle-trajectory", "/coaching-focus", "/muscle-load", "/training-load",
      "/program/adjustments", "/sessions?limit=3", "/journey", "/journey/milestones", "/journey/timeline",
      `/today-strength-line?date=${date}`],
    program: ["/coaching-focus", "/program-state", "/strength-journeys", "/strength-journey", "/performance",
      "/program/blocks/active", "/program/adjustments", "/test-week", "/muscle-trajectory", "/dexa-targeting",
      "/plan/look-ahead"],
    endurance: ["/stats", "/endurance-prs", "/endurance-goal", "/run-compliance", "/settings", "/run-plan", "/race-build",
      `/training-agenda?date=${date}`, "/program-state", `/calibration/status?date=${date}`],
    // Horizon's goal line and Today's Fuel ride the same fan-in.
    goal: ["/journey", "/journey/milestones", "/journey/timeline", `/today-path?date=${date}`],
    fuel: [`/nutrition/day?date=${date}`, `/nutrition/intake-band?date=${date}`, `/fuel/ideas?date=${date}&hour=9`,
      "/mealplans?limit=12"],
  };
  for (const [view, paths] of Object.entries(expected)) {
    const { body, cc } = await get(`/api/train-home?view=${view}&date=${date}${view === "fuel" ? "&hour=9" : ""}`);
    assert.deepEqual(Object.keys(body.responses).sort(), [...paths].sort(), view);
    assert.equal(cc, "private, no-cache");
    await assertMirrorsRoutes(body.responses);
  }
  // Fuel without a usable hour asks its ideas without one, exactly as the card would.
  const hourless = await get(`/api/train-home?view=fuel&date=${date}&hour=25`);
  assert.ok(`/fuel/ideas?date=${date}` in hourless.body.responses);
  await assertMirrorsRoutes(hourless.body.responses);
  // An unknown view is the home.
  const unknown = await get(`/api/train-home?view=nope&date=${date}`);
  assert.deepEqual(Object.keys(unknown.body.responses).sort(), [...expected.overview].sort());
});

test("GET /you-health answers the overview's reads plus the open leaf's, never stored", async () => {
  seedAthlete();
  const overview = ["/markers/priority", "/coaching-focus", "/body-metrics?unit=in", "/health/synthesis", "/insights",
    "/recovery", "/supplements", "/directives", "/health/next-checkup"];
  const leaves = {
    health: [],
    records: ["/health-docs"],
    markers: ["/health/evidence-wanted"],
    share: ["/health-report.json", "/symptom-links", "/health/visit-questions"],
  };
  for (const [leaf, extra] of Object.entries(leaves)) {
    const { body, cc } = await get(`/api/you-health?leaf=${leaf}`);
    assert.equal(cc, "private, no-store", "health data is never stored");
    assert.deepEqual(Object.keys(body.responses).sort(), [...overview, ...extra].sort(), leaf);
    await assertMirrorsRoutes(body.responses);
  }
  assert.ok(body_hasMarkers(await get("/api/you-health?leaf=markers")), "the seeded panel reaches the fan-in");
  assert.equal(apiCacheControlFor("/you-health"), "private, no-store");
});

function body_hasMarkers({ body }) {
  const priority = body.responses["/markers/priority"];
  return Array.isArray(priority?.markers) && priority.markers.length > 0;
}

test("GET /today?surface=session carries the Session's reads, computed on every open", async () => {
  seedAthlete();
  resetResponseMemo();
  const date = localDateISO();
  const first = await get(`/api/today?date=${date}&surface=session`);
  assert.equal(first.cc, "private, no-store", "the symptom rows ride along, so it is never stored");
  const { responses } = first.body;
  const day = first.body.progression_day;
  assert.equal(day, 1);
  for (const path of [`/today-strength-line?date=${date}`, `/today-plan-day?date=${date}`, "/strength-journey", "/settings",
    "/profile", `/program/progression?day=${day}`, `/session-primer?date=${date}&day=${day}`,
    `/training-symptoms?on=${date}&include_resolved=1`]) {
    assert.ok(path in responses, path);
  }
  await assertMirrorsRoutes(responses);
  // The aggregate proper is the plain /today body.
  const plain = await get(`/api/today?date=${date}`);
  const { responses: _r, ...proper } = first.body;
  assert.deepEqual(comparable(proper), comparable(plain.body));

  // Never answered from the response memo: a new symptom shows on the very next open.
  const symptomsPath = `/training-symptoms?on=${date}&include_resolved=1`;
  const before = JSON.stringify(first.body.responses[symptomsPath]);
  repo.reportTrainingSymptom({ area_text: "left knee", onset_on: date });
  const second = await get(`/api/today?date=${date}&surface=session`);
  const own = await get(`/api${symptomsPath}`);
  assert.notEqual(JSON.stringify(second.body.responses[symptomsPath]), before, "the new symptom is on the next open");
  assert.deepEqual(comparable(second.body.responses[symptomsPath]), comparable(own.body));
});
