// The HTTP response memo (src/routes/response-memo.ts) and its freshness key
// (src/repo/response-freshness.ts): a repeat GET whose inputs have not moved answers
// the stored body — and If-None-Match answers 304 — BEFORE the read is computed; and
// every write the athlete makes (a set, a meal, a weigh-in, an Undo, a directive
// flipped) plus a day rollover moves the ETag and the body. Freshness beats speed.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { api, apiCacheControlFor } from "../dist/api.js";
import { memoizedRead, memoizedValue, resetResponseMemo } from "../dist/routes/response-memo.js";
import { responseFreshnessKey } from "../dist/repo/response-freshness.js";
import { applyProposalWithAutonomy, revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { setDirectiveStatusByUser } from "../dist/repo/propagation.js";
import { setAppState } from "../dist/repo/app-state.js";
import { localDateISO } from "../dist/repo/shared.js";
import * as repo from "../dist/repo.js";
import { db } from "../dist/db.js";
import { invalidateAgentConfigured, settleAgentLoginChecks } from "../dist/agents.js";
import { getAgentConfig } from "../dist/repo/settings.js";

let server = null;
let base = "";
let computes = 0;
let hits = 0;

async function listener() {
  if (server) return base;
  const app = express();
  app.use(express.json());
  // A counting read beside the real API, so a test can prove a hit never computed.
  app.get(
    "/probe/read",
    memoizedRead("probe", (req) => {
      computes++;
      return { n: repo.getPlan().length, q: req.query.q ?? null };
    })
  );
  app.get(
    "/probe/fail",
    memoizedRead("probe-fail", () => {
      computes++;
      return { ok: false, error: "no agent" };
    })
  );
  app.get(
    "/probe/hit",
    memoizedRead("probe-hit", () => ({ n: repo.getPlan().length }), { onHit: () => hits++ })
  );
  app.use("/api", api);
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

after(() => server?.close());

async function get(path, etag) {
  const url = await listener();
  const res = await fetch(url + path, { headers: etag ? { "If-None-Match": etag } : {} });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get("etag"), cc: res.headers.get("cache-control"), text };
}

const PRESS = "ZMemo Press";

function seedPlan(weight = 100) {
  repo.savePlanDay(1, "Push", "chest", [{ exercise: PRESS, sets: 3, rep_low: 6, rep_high: 8, target_weight: weight }]);
}

// ---------- the memo itself ----------

// /settings peeks the CLI probes and fills them in the background; warm them first so a
// probe landing mid-test never moves the agent-state generation or a fan-in's body.
before(async () => {
  getAgentConfig({ loginProbe: "peek" });
  await settleAgentLoginChecks(10_000);
});

test("a repeat read is served from the memo and If-None-Match answers 304 without computing", async () => {
  resetResponseMemo();
  computes = 0;
  const first = await get("/probe/read?q=a");
  assert.equal(first.status, 200);
  assert.ok(first.etag, "an ETag rides every memoized response");
  // The very first compute may have written bookkeeping; the second settles it.
  await get("/probe/read?q=a");
  const settled = computes;
  const again = await get("/probe/read?q=a");
  assert.equal(again.status, 200);
  assert.equal(again.text, first.text);
  assert.equal(computes, settled, "a hit never runs the read again");
  const revalidated = await get("/probe/read?q=a", again.etag);
  assert.equal(revalidated.status, 304);
  assert.equal(revalidated.text, "");
  assert.equal(computes, settled, "a 304 is answered before the read");
  // A different query is a different slot.
  await get("/probe/read?q=b");
  assert.equal(computes, settled + 1);
});

test("any write the read could see forces a recompute and a new ETag", async () => {
  resetResponseMemo();
  computes = 0;
  await get("/probe/read");
  const before = await get("/probe/read");
  const settled = computes;
  seedPlan();
  const after = await get("/probe/read", before.etag);
  assert.equal(after.status, 200, "a stale ETag is never answered 304");
  assert.equal(computes, settled + 1);
  assert.notEqual(after.etag, before.etag);
  assert.notEqual(after.text, before.text);
});

test("a designed {ok:false} failure is never remembered", async () => {
  resetResponseMemo();
  computes = 0;
  await get("/probe/fail");
  await get("/probe/fail");
  await get("/probe/fail");
  assert.equal(computes, 3);
});

test("the freshness key moves on bookkeeping a read consults, and ignores the heartbeat", () => {
  const k0 = responseFreshnessKey();
  assert.ok(k0);
  setAppState("scheduler_heartbeat", new Date().toISOString());
  assert.equal(responseFreshnessKey(), k0, "liveness bookkeeping is not news");
  setAppState("today_last_seen", "2026-01-01T00:00:00Z");
  const k1 = responseFreshnessKey();
  assert.notEqual(k1, k0, "a seen stamp is");
  setAppState("today_last_seen", "2026-01-01T00:00:00Z");
  assert.equal(responseFreshnessKey(), k1, "re-writing the same value is not");
});

test("the freshness key moves when the in-memory agent state does (a CLI login, install or update)", async () => {
  const k0 = responseFreshnessKey();
  invalidateAgentConfigured();
  assert.notEqual(responseFreshnessKey(), k0, "/settings and agent_status read that state");
  // Re-warm what it cleared, so no later test races a background probe.
  getAgentConfig({ loginProbe: "peek" });
  await settleAgentLoginChecks(10_000);
});

test("onHit replays a read's side effects on a memo hit, and only then", async () => {
  resetResponseMemo();
  hits = 0;
  await get("/probe/hit");
  assert.equal(hits, 0, "the compute ran its own side effects");
  await get("/probe/hit");
  await get("/probe/hit");
  assert.equal(hits, 2, "every hit re-kicks what the skipped compute would have");
});

test("memoizedValue keeps a value only while the freshness key holds, and never an {ok:false}", () => {
  resetResponseMemo();
  let n = 0;
  const read = () => memoizedValue("probe-value", () => ({ n: ++n, plan: repo.getPlan().length }));
  read(); // may carry first-read bookkeeping
  const settled = read();
  assert.equal(read(), settled, "an unmoved key answers the kept value without computing");
  seedPlan();
  const moved = read();
  assert.notEqual(moved, settled, "any write the value could see recomputes it");
  assert.equal(moved.plan, 1);
  let fails = 0;
  const fail = () => memoizedValue("probe-value-fail", () => ({ ok: false, n: ++fails }));
  fail();
  fail();
  assert.equal(fails, 2, "a designed failure is never kept");
});

// ---------- the real routes: every athlete write moves the ETag and the body ----------

async function settledToday(path) {
  await get(path); // may carry the agenda's first "seen" stamp
  return get(path);
}

test("GET /today: a logged set moves the ETag and the body", async () => {
  resetResponseMemo();
  seedPlan();
  const date = localDateISO();
  const path = `/api/today?date=${date}`;
  const before = await settledToday(path);
  assert.equal((await get(path, before.etag)).status, 304, "unchanged → 304");
  repo.logSetByName({ exercise: PRESS, weight: 100, reps: 8, date });
  const after = await get(path, before.etag);
  assert.equal(after.status, 200);
  assert.notEqual(after.etag, before.etag);
  assert.notEqual(JSON.parse(after.text).session, JSON.parse(before.text).session);
  assert.equal(JSON.parse(after.text).session.sets.length, 1);
});

test("GET /today?surface=session: its aggregate half is kept like /today's, and a logged set moves it", async () => {
  resetResponseMemo();
  seedPlan();
  const date = localDateISO();
  const path = `/api/today?date=${date}&surface=session`;
  await get(path);
  const before = await get(path);
  const again = await get(path);
  assert.equal(again.status, 200, "the Session surface is never answered 304");
  assert.equal(again.text, before.text, "an unmoved read answers the same body");
  repo.logSetByName({ exercise: PRESS, weight: 100, reps: 8, date });
  const after = JSON.parse((await get(path)).text);
  assert.equal(after.session.sets.length, 1, "the kept aggregate never outlives a logged set");
  assert.ok(after.responses, "the Session's own reads still ride along");
});

test("GET /today-read: a logged set moves it; /daily-session/preview: a plan edit moves it", async () => {
  resetResponseMemo();
  seedPlan();
  const date = localDateISO();
  const readPath = `/api/today-read?date=${date}&agent=auto`;
  const read = await settledToday(readPath);
  repo.logSetByName({ exercise: PRESS, weight: 100, reps: 8, date });
  const readAfter = await get(readPath, read.etag);
  assert.equal(readAfter.status, 200);
  assert.notEqual(readAfter.etag, read.etag);

  const previewPath = `/api/daily-session/preview?date=${date}`;
  const preview = await settledToday(previewPath);
  seedPlan(140);
  const previewAfter = await get(previewPath, preview.etag);
  assert.equal(previewAfter.status, 200);
  assert.notEqual(previewAfter.etag, preview.etag);
  assert.notEqual(previewAfter.text, preview.text);
});

test("a meal and a weigh-in each move the Today fan-in", async () => {
  resetResponseMemo();
  const date = localDateISO();
  const todayPath = `/api/today?date=${date}&surface=today`;
  const today = await settledToday(todayPath);
  repo.addFoodNote("lunch", "", { items: [{ name: "rice bowl", kcal: 900, protein_g: 50 }], kcal: 900, protein_g: 50 });
  const afterMeal = await get(todayPath, today.etag);
  assert.equal(afterMeal.status, 200, "a meal is news");
  assert.notEqual(afterMeal.etag, today.etag);
  assert.notEqual(afterMeal.text, today.text);

  // A weigh-in moves the aggregate's stats/profile read of today's weight.
  const settled = await get(todayPath);
  repo.logWeight(176.4, date);
  const afterWeight = await get(todayPath, settled.etag);
  assert.equal(afterWeight.status, 200, "a weigh-in is news");
  assert.notEqual(afterWeight.etag, settled.etag);
  assert.notEqual(afterWeight.text, settled.text);

  // The expenditure read is memoized on the same key: a weigh-in forces its recompute
  // (a partial or thin window may legitimately answer the same body — then a 304).
  const path = "/api/nutrition/expenditure";
  const exp = await settledToday(path);
  assert.equal((await get(path, exp.etag)).status, 304);
  repo.logWeight(175.2, addDays(date, -1));
  const again = await get(path);
  assert.equal(again.status, 200);
});

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

test("GET /today?surface=today: an Undo and a directive flip each move the fan-in", async () => {
  resetResponseMemo();
  repo.setSettings({ lead_mode: "lead" });
  seedPlan(100);
  const draft = repo.createProposal("stub", "auto: press step", "", {
    summary: `Raise the ${PRESS} to 105`,
    rationale: "Every set landed at the top of the range last week, so the load steps up.",
    changes: [{ day_number: 1, exercise: PRESS, target_weight: 105, reason: "top of the range" }],
  });
  const routed = applyProposalWithAutonomy(Number(draft.id), { requested_tier: "ask" });
  db.prepare(
    `INSERT INTO health_directives (source, domain, marker, directive_key, directive, rationale, status)
     VALUES ('markers', 'watch', 'Ferritin', 'ferritin-recheck', 'Recheck after a meaningful interval.', 'Confirm direction.', 'active')`
  ).run();
  const date = localDateISO();
  const path = `/api/today?date=${date}&surface=today`;
  const before = await settledToday(path);
  const beforeBody = JSON.parse(before.text);
  assert.ok(beforeBody.responses, "the Today surface carries the fan-in");
  assert.ok(`/today-plan-day?date=${date}` in beforeBody.responses);
  assert.ok("/brain/changes" in beforeBody.responses);

  assert.equal(revertDecision(Number(routed.decision.id), "user hold").ok, true);
  const afterUndo = await get(path, before.etag);
  assert.equal(afterUndo.status, 200);
  assert.notEqual(afterUndo.etag, before.etag, "an Undo is news");
  assert.notDeepEqual(JSON.parse(afterUndo.text).responses["/brain/changes"], beforeBody.responses["/brain/changes"]);

  const settled = await get(path);
  const id = db.prepare(`SELECT id FROM health_directives WHERE directive_key = 'ferritin-recheck'`).get().id;
  setDirectiveStatusByUser(Number(id), "dismissed");
  const afterDirective = await get(path, settled.etag);
  assert.equal(afterDirective.status, 200);
  assert.notEqual(afterDirective.etag, settled.etag, "a directive flip is news");
  assert.notDeepEqual(
    JSON.parse(afterDirective.text).responses["/directives"],
    JSON.parse(settled.text).responses["/directives"]
  );
});

test("GET /today: the day rolling over moves the ETag and the body", async (t) => {
  resetResponseMemo();
  seedPlan();
  // Late evening, then just past midnight, in the server's own zone.
  const late = new Date();
  late.setHours(23, 58, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now: late.getTime() });
  const before = await settledToday("/api/today");
  const dayOne = JSON.parse(before.text).date;
  t.mock.timers.tick(5 * 60 * 1000);
  const after = await get("/api/today", before.etag);
  assert.equal(after.status, 200);
  assert.notEqual(after.etag, before.etag);
  assert.notEqual(JSON.parse(after.text).date, dayOne, "a new day reads as the new day");
  t.mock.timers.reset();
});

// ---------- the fan-ins answer exactly what each route answers ----------

// Two fields are clocks, not data: the Changes feed's `seen_through` is the instant
// of the read (so a later mark-seen never swallows a change that landed after it),
// and the settings row's `updated_at` is bookkeeping a GET elsewhere may stamp.
function comparable(body) {
  return JSON.parse(JSON.stringify(body), (key, value) =>
    key === "seen_through" || key === "updated_at" ? undefined : value
  );
}

test("every /today?surface=today response is byte-identical to its own route", async () => {
  resetResponseMemo();
  seedPlan();
  const date = localDateISO();
  const fan = JSON.parse((await settledToday(`/api/today?date=${date}&surface=today`)).text).responses;
  for (const [path, body] of Object.entries(fan)) {
    // Side-effecting reads compare after their own first call settled too.
    const own = JSON.parse((await settledToday(`/api${path}`)).text);
    assert.deepEqual(comparable(own), comparable(body), path);
  }
});

test("GET /horizon-race carries this week and each asked Monday, each as its own route answers", async () => {
  resetResponseMemo();
  const res = await get("/api/horizon-race?dates=2026-10-05,2026-10-12,not-a-date");
  const { responses } = JSON.parse(res.text);
  for (const path of ["/profile", "/endurance-goal", "/run-compliance", "/settings", "/race-build", "/run-plan", "/plan/upcoming"]) {
    assert.ok(path in responses, path);
  }
  for (const d of ["2026-10-05", "2026-10-12"]) {
    for (const route of ["/training-agenda", "/run-plan", "/race-build"]) assert.ok(`${route}?date=${d}` in responses);
  }
  assert.ok(!Object.keys(responses).some((k) => k.includes("not-a-date")));
  for (const [path, body] of Object.entries(responses)) {
    assert.deepEqual(comparable(JSON.parse((await get(`/api${path}`)).text)), comparable(body), path);
  }
});

// ---------- Cache-Control ----------

test("API reads revalidate; health reads are never stored", async () => {
  assert.equal(apiCacheControlFor("/today"), "private, no-cache");
  assert.equal(apiCacheControlFor("/health/markers"), "private, no-store");
  assert.equal(apiCacheControlFor("/markers/priority"), "private, no-store");
  assert.equal(apiCacheControlFor("/recovery/baseline"), "private, no-store");
  assert.equal(apiCacheControlFor("/records/search"), "private, no-store");
  assert.equal(apiCacheControlFor("/health-docs"), "private, no-store");
  assert.equal(apiCacheControlFor("/healthy-sounding-name"), "private, no-cache");
  // Reads that embed health data are held to the same no-store.
  assert.equal(apiCacheControlFor("/today-side"), "private, no-store");
  assert.equal(apiCacheControlFor("/directives"), "private, no-store");
  assert.equal(apiCacheControlFor("/today", { surface: "today" }), "private, no-store");
  assert.equal(apiCacheControlFor("/today", {}), "private, no-cache");
  assert.equal((await get("/api/profile")).cc, "private, no-cache");
  assert.equal((await get("/api/markers/priority")).cc, "private, no-store");
  assert.equal((await get("/api/recovery")).cc, "private, no-store");
  assert.equal((await get(`/api/today?date=${localDateISO()}&surface=today`)).cc, "private, no-store");
  assert.equal((await get(`/api/today?date=${localDateISO()}`)).cc, "private, no-cache");
});

mock.restoreAll();
