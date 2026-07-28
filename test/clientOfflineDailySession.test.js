import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function storage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    key: (index) => [...data.keys()][index] ?? null,
  };
}

function loadClient(sharedStorage) {
  const context = {
    Array,
    Date,
    Error,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    encodeURIComponent,
    localStorage: sharedStorage,
    state: { tab: "session" },
    document: { body: { classList: { toggle() {} } } },
  };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/api-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/swr-cache.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-suggest-controller.js"), "utf8"), context);
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadOutboxRuntime({ responses }) {
  const sharedStorage = storage();
  const cache = new Map();
  const invalidations = [];
  const requests = [];
  const context = {
    Array,
    Date,
    Error,
    Intl,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Set,
    String,
    encodeURIComponent,
    localStorage: sharedStorage,
    navigator: { onLine: true },
    fetch: async (url, init) => {
      requests.push({ url, init });
      const response = responses.shift();
      if (!response) throw new Error("missing fake response");
      if (typeof response === "function") return response({ url, init });
      return {
        status: response.status,
        headers: { get: () => null },
        json: async () => response.body,
      };
    },
    swrSet: (key, value) => cache.set(key, plain(value)),
    peekCached: (key) => cache.has(key) ? { data: cache.get(key), fresh: true } : null,
    swrInvalidate: (key) => {
      invalidations.push(key);
      if (key.endsWith(":")) {
        for (const cachedKey of [...cache.keys()]) if (cachedKey.startsWith(key)) cache.delete(cachedKey);
      } else cache.delete(key);
    },
    toast() {},
  };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/api-client.js"), "utf8"), context);
  return { context, cache, invalidations, requests };
}

function savedPlanRecovery(date = "2026-06-30") {
  const client = loadClient(storage());
  const accepted = {
    date,
    source: "manual_plan",
    plan_day_id: 22,
    title: "Upper",
    focus: "Push",
    why: "Explicit plan-day override: Day 2.",
    est_minutes: 42,
    constraints: { equipment: ["rack", "bench"], readiness: { shoulder: "easy" } },
    provenance: { entry: "today_launch" },
    items: [{
      position: 0,
      exercise: "Bench",
      sets: 3,
      rep_low: 5,
      rep_high: 8,
      interval: { work_sec: 30, rest_sec: 60 },
    }],
  };
  const request = {
    date,
    source: "manual_plan",
    day_number: 2,
    replace: false,
    constraints: accepted.constraints,
    provenance: accepted.provenance,
  };
  const recovery = client.CairnTodaySessionSuggestController.snapshotRecovery(accepted, request);
  return { accepted, request, recovery };
}

test("offline first workout stages, persists, queues prepare before logs, and replays without identity drift", async () => {
  const sharedStorage = storage();
  const first = loadClient(sharedStorage);
  const box = first.CairnOutbox.createOutbox({ storage: sharedStorage, now: () => 1000 });
  const request = {
    date: "2026-06-30",
    source: "manual_plan",
    day_number: 2,
    replace: false,
    constraints: {},
    provenance: { entry: "pwa" },
  };
  const plan = [
    {
      id: 22,
      day_number: 2,
      name: "Upper",
      focus: "Push",
      items: [{ exercise: "Bench", sets: 3, rep_low: 5, rep_high: 8 }],
    },
  ];

  // This is the openSession transient-failure sequence: exact prepare first,
  // then a locally paired view, then later gym-floor mutations in the same FIFO.
  const prepare = box.enqueue({ kind: "daily_session_prepare", path: "/daily-session/prepare", body: request });
  const staged = first.CairnTodaySessionSuggestController.stagedPrepareResponse({
    date: request.date,
    request,
    plan,
    selectedDay: 2,
    localPrepareId: prepare.id,
  });
  first.swrSet(`today:session:${request.date}`, staged.session);
  first.swrSet(`today:daily-session:${request.date}`, staged.daily_session);
  assert.equal(first.outboxSessionDependency(request.date), prepare.id);
  box.enqueue({
    kind: "set",
    path: "/sets",
    body: { date: request.date, exercise: "Bench", weight: 185, reps: 5, day_number: 2 },
    depends_on: prepare.id,
  });

  assert.deepEqual(
    box.list().map((item) => item.kind),
    ["daily_session_prepare", "set"]
  );
  assert.deepEqual(plain(box.list()[0].body), request, "the queued prepare body is the exact attempted POST");
  assert.equal(box.list()[1].depends_on, prepare.id);
  assert.equal(Object.hasOwn(staged.session, "id"), false);
  assert.equal(Object.hasOwn(staged.daily_session, "id"), false);
  assert.equal(Object.hasOwn(staged.daily_session, "session_id"), false);

  // A cold client over the same localStorage reopens the exact paired staging
  // records without requiring a network read or inventing a server ID.
  const reloaded = loadClient(sharedStorage);
  const cachedSession = reloaded.peekCached(`today:session:${request.date}`).data;
  const cachedDaily = reloaded.peekCached(`today:daily-session:${request.date}`).data;
  const continuation = reloaded.CairnTodaySessionSuggestController.cachedContinuation(
    cachedSession,
    cachedDaily,
    false
  );
  assert.equal(continuation.reused, true);
  assert.equal(continuation.session._local_prepare_id, prepare.id);
  assert.equal(continuation.daily_session._local_prepare_id, prepare.id);

  const replayed = [];
  await box.drain(async (item) => replayed.push({ kind: item.kind, path: item.path, body: plain(item.body) }));
  assert.deepEqual(
    replayed.map((item) => item.kind),
    ["daily_session_prepare", "set"]
  );
  assert.deepEqual(replayed[0], {
    kind: "daily_session_prepare",
    path: "/daily-session/prepare",
    body: request,
  });
  assert.deepEqual(
    plain(continuation.daily_session.items.map((item) => item.exercise)),
    ["Bench"],
    "reload and replay preserve the staged prescription identity"
  );
  assert.equal(box.count(), 0);
});

test("successful runtime prepare replay replaces staged caches with canonical server identity", async () => {
  const date = "2026-06-30";
  const canonicalDaily = { id: 81, session_id: 44, date, source: "manual_plan", status: "active", items: [] };
  const canonicalSession = { id: 44, date, sets: [], daily_session: canonicalDaily };
  const runtime = loadOutboxRuntime({
    responses: [{ status: 200, body: { ok: true, reused: false, daily_session: canonicalDaily, session: canonicalSession } }],
  });
  runtime.cache.set(`today:session:${date}`, { _staged_offline: true, _local_prepare_id: "stale" });
  runtime.cache.set(`today:daily-session:${date}`, { _staged_offline: true, _local_prepare_id: "stale" });
  await runtime.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    { date, source: "manual_plan", day_number: 2, replace: false },
    { prepareIntent: { date, source: "manual_plan", plan_day_id: null, title: null, focus: null, est_minutes: null, items: [] } }
  );

  await runtime.context.flushOutbox();

  assert.equal(runtime.context.CairnOutbox.count(), 0);
  assert.deepEqual(runtime.cache.get(`today:session:${date}`), canonicalSession);
  assert.deepEqual(runtime.cache.get(`today:daily-session:${date}`), canonicalDaily);
  assert.ok(runtime.invalidations.includes("today:session:"));
  assert.ok(runtime.invalidations.includes("today:daily-session:"));
  assert.equal(runtime.requests[0].url, "/api/daily-session/prepare");
  assert.equal(runtime.requests[0].init.headers["X-Idempotency-Key"].length > 0, true);
});

test("offline agent suggestion reconciles against its canonical job context without false drift", async () => {
  const date = "2026-06-30";
  const constraints = { minutes: 35, equipment: "barbell", constraints: "easy shoulder" };
  const provenance = {
    verification: "verified_agent_job",
    operation: "session_suggest",
    agent_job_id: 145,
    agent: "codex",
    tried: [{ agent: "codex", ok: true }],
    verified: { sources: 2 },
  };
  const stagedDaily = {
    date,
    source: "agent_suggest",
    plan_day_id: null,
    title: "Coach session",
    focus: "Posterior chain",
    why: "Matches today's constraints.",
    est_minutes: 35,
    constraints,
    provenance,
    items: [{ position: 0, exercise: "Deadlift", sets: 3, rep_low: 4, rep_high: 6 }],
  };
  const canonicalDaily = {
    ...stagedDaily,
    id: 82,
    session_id: 45,
    status: "active",
    constraints: { constraints: "easy shoulder", equipment: "barbell", minutes: 35 },
    provenance: {
      server_trace: "canonical",
      verified: { sources: 2 },
      tried: [{ ok: true, agent: "codex" }],
      agent: "codex",
      agent_job_id: 145,
      operation: "session_suggest",
      verification: "verified_agent_job",
    },
  };
  const canonicalSession = { id: 45, date, sets: [], daily_session: canonicalDaily };
  const runtime = loadOutboxRuntime({
    responses: [{ status: 200, body: { ok: true, daily_session: canonicalDaily, session: canonicalSession } }],
  });
  await runtime.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    {
      date,
      source: "agent_suggest",
      agent_job_id: 145,
      constraints,
      provenance,
      replace: true,
    },
    { prepareIntent: stagedDaily },
  );

  await runtime.context.flushOutbox();

  assert.equal(runtime.context.CairnOutbox.count(), 0);
  assert.deepEqual(runtime.cache.get(`today:daily-session:${date}`), canonicalDaily);
  assert.deepEqual(JSON.parse(runtime.requests[0].init.body), {
    date,
    source: "agent_suggest",
    agent_job_id: 145,
    constraints,
    provenance,
    replace: true,
  });
});

test("runtime permanent prepare rejection remains a non-discardable dependency barrier until retry succeeds", async () => {
  const date = "2026-06-30";
  const canonicalDaily = { id: 91, session_id: 54, date, source: "manual_plan", status: "active", items: [] };
  const canonicalSession = { id: 54, date, sets: [], daily_session: canonicalDaily };
  let resolveRetry;
  const responses = [
    { status: 409, body: { ok: false, error: "daily session is locked" } },
    () => new Promise((resolve) => {
      resolveRetry = () => resolve({
        status: 200,
        headers: { get: () => null },
        json: async () => ({ ok: true, daily_session: canonicalDaily, session: canonicalSession }),
      });
    }),
    { status: 200, body: { id: 101, session_id: 54, date, exercise: "Bench", reps: 5 } },
  ];
  const runtime = loadOutboxRuntime({ responses });
  const prepare = await runtime.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    { date, source: "manual_plan", day_number: 2, replace: false },
    { prepareIntent: { date, source: "manual_plan", plan_day_id: null, title: null, focus: null, est_minutes: null, items: [] } }
  );
  await runtime.context.outboxEnqueue(
    "set",
    "/sets",
    { date, exercise: "Bench", reps: 5 },
    { dependsOn: prepare.id }
  );
  const stagedDaily = {
    _staged_offline: true,
    _local_prepare_id: prepare.id,
    date,
    source: "manual_plan",
    status: "active",
    items: [],
  };
  runtime.cache.set(`today:session:${date}`, {
    _staged_offline: true,
    _local_prepare_id: prepare.id,
    date,
    daily_session: stagedDaily,
  });
  runtime.cache.set(`today:daily-session:${date}`, stagedDaily);

  await runtime.context.flushOutbox();
  assert.deepEqual(runtime.requests.map((request) => request.url), ["/api/daily-session/prepare"]);
  assert.equal(runtime.context.CairnOutbox.list()[0].state, "needs_attention");
  assert.equal(await runtime.context.CairnOutbox.discard(prepare.id), false);
  assert.equal(runtime.context.CairnOutbox.count(), 2);

  const retrying = runtime.context.CairnOutbox.retry(prepare.id);
  for (let i = 0; i < 12 && runtime.context.CairnOutbox.list()[0].id === prepare.id; i++) {
    await Promise.resolve();
  }
  const rekeyed = runtime.context.CairnOutbox.list()[0];
  assert.notEqual(rekeyed.id, prepare.id);
  assert.equal(runtime.cache.get(`today:session:${date}`)._local_prepare_id, rekeyed.id);
  assert.equal(runtime.cache.get(`today:session:${date}`).daily_session._local_prepare_id, rekeyed.id);
  assert.equal(runtime.cache.get(`today:daily-session:${date}`)._local_prepare_id, rekeyed.id);
  assert.equal(runtime.context.CairnOutbox.list()[1].depends_on, rekeyed.id);
  for (let i = 0; i < 12 && typeof resolveRetry !== "function"; i++) await Promise.resolve();
  resolveRetry();
  await retrying;
  assert.deepEqual(runtime.requests.map((request) => request.url), [
    "/api/daily-session/prepare",
    "/api/daily-session/prepare",
    "/api/sets",
  ]);
  assert.equal(JSON.parse(runtime.requests[0].init.body).replace, false);
  assert.equal(JSON.parse(runtime.requests[1].init.body).replace, true, "Use saved session promotes explicit replacement");
  assert.notEqual(
    runtime.requests[1].init.headers["X-Idempotency-Key"],
    runtime.requests[0].init.headers["X-Idempotency-Key"],
    "explicit recovery uses a fresh idempotency identity",
  );
  assert.equal(runtime.context.CairnOutbox.count(), 0);
});

test("canonical replay drift is marked for attention before dependent logs can attach", async () => {
  const date = "2026-06-30";
  const returnedDaily = {
    id: 92,
    session_id: 55,
    date,
    source: "manual_plan",
    status: "active",
    plan_day_id: 22,
    title: "Upper",
    focus: "Push",
    est_minutes: null,
    items: [{ position: 0, exercise: "Incline Bench", sets: 3, rep_low: 5, rep_high: 8 }],
  };
  const runtime = loadOutboxRuntime({
    responses: [{ status: 200, body: { ok: true, daily_session: returnedDaily, session: { id: 55, date } } }],
  });
  const prepare = await runtime.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    { date, source: "manual_plan", day_number: 2, replace: false },
    {
      prepareIntent: {
        date,
        source: "manual_plan",
        plan_day_id: 22,
        title: "Upper",
        focus: "Push",
        est_minutes: null,
        items: [{ position: 0, exercise: "Bench", sets: 3, rep_low: 5, rep_high: 8 }],
      },
    }
  );
  await runtime.context.outboxEnqueue(
    "set",
    "/sets",
    { date, exercise: "Bench", reps: 5 },
    { dependsOn: prepare.id }
  );

  await runtime.context.flushOutbox();

  assert.deepEqual(runtime.requests.map((request) => request.url), ["/api/daily-session/prepare"]);
  assert.equal(runtime.context.CairnOutbox.list()[0].state, "needs_attention");
  assert.equal(runtime.context.CairnOutbox.count(), 2);
});

test("queued adaptive fingerprint drift becomes attention and keeps dependent writes behind the barrier", async () => {
  const date = "2026-06-30";
  const fingerprint = "a".repeat(64);
  const runtime = loadOutboxRuntime({
    responses: [{
      status: 409,
      body: {
        ok: false,
        code: "daily_session_preview_stale",
        error: "Today’s session changed.",
        preview: { date, source: "adaptive_plan", input_fingerprint: "b".repeat(64) },
      },
    }],
  });
  const prepare = await runtime.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    { date, source: "adaptive_plan", expected_input_fingerprint: fingerprint, replace: false },
    {
      prepareIntent: {
        date,
        source: "adaptive_plan",
        plan_day_id: 22,
        title: "Upper",
        focus: "Push",
        est_minutes: 40,
        items: [{ position: 0, exercise: "Bench", sets: 3, rep_low: 5, rep_high: 8 }],
      },
    },
  );
  await runtime.context.outboxEnqueue(
    "set",
    "/sets",
    { date, exercise: "Bench", reps: 5 },
    { dependsOn: prepare.id },
  );

  await runtime.context.flushOutbox();
  await runtime.context.flushOutbox();

  assert.deepEqual(runtime.requests.map((request) => request.url), ["/api/daily-session/prepare"]);
  const queued = runtime.context.CairnOutbox.list();
  assert.equal(queued[0].state, "needs_attention");
  assert.equal(queued[0].failure_status, 409);
  assert.equal(queued[1].depends_on, queued[0].id);
  assert.equal(queued[1].state, undefined);
});

test("weekly-plan drift retries with the immutable saved composition and then releases its dependent log", async () => {
  const date = "2026-06-30";
  const { accepted, request, recovery } = savedPlanRecovery(date);
  const driftedDaily = {
    ...accepted,
    id: 92,
    session_id: 55,
    items: [{ ...accepted.items[0], exercise: "Incline Bench" }],
  };
  const recoveredDaily = {
    id: 93,
    session_id: 56,
    date,
    source: "athlete_override",
    status: "active",
    plan_day_id: null,
    title: "Upper",
    focus: "Push",
    why: "Explicit plan-day override: Day 2.",
    est_minutes: 42,
    items: [{
      position: 0,
      exercise: "Bench",
      sets: 3,
      rep_low: 5,
      rep_high: 8,
      interval: { rest_sec: 60, work_sec: 30 },
    }],
    constraints: { readiness: { shoulder: "easy" }, equipment: ["rack", "bench"] },
    provenance: {
      ...plain(recovery.intent.provenance),
      server_received_at: "2026-06-30T12:00:00Z",
    },
  };
  const runtime = loadOutboxRuntime({
    responses: [
      { status: 200, body: { ok: true, daily_session: driftedDaily, session: { id: 55, date } } },
      { status: 200, body: { ok: true, daily_session: recoveredDaily, session: { id: 56, date } } },
      { status: 200, body: { id: 101, session_id: 56, date, exercise: "Bench", reps: 5 } },
    ],
  });
  const prepare = await runtime.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    request,
    { prepareIntent: accepted, retryBody: recovery.body, retryIntent: recovery.intent },
  );
  await runtime.context.outboxEnqueue(
    "set",
    "/sets",
    { date, exercise: "Bench", reps: 5 },
    { dependsOn: prepare.id },
  );

  await runtime.context.flushOutbox();
  assert.equal(runtime.context.CairnOutbox.list()[0].state, "needs_attention");
  assert.deepEqual(runtime.requests.map((row) => row.url), ["/api/daily-session/prepare"]);

  await runtime.context.CairnOutbox.retry(prepare.id);

  assert.deepEqual(runtime.requests.map((row) => row.url), [
    "/api/daily-session/prepare",
    "/api/daily-session/prepare",
    "/api/sets",
  ]);
  assert.deepEqual(JSON.parse(runtime.requests[0].init.body), request, "ordinary replay stays replace:false");
  assert.deepEqual(JSON.parse(runtime.requests[1].init.body), plain(recovery.body));
  assert.equal(JSON.parse(runtime.requests[1].init.body).source, "athlete_override");
  assert.equal(JSON.parse(runtime.requests[1].init.body).replace, true);
  assert.equal(runtime.context.CairnOutbox.count(), 0);
});

test("a started-session conflict keeps immutable recovery and dependent logs locked for attention", async () => {
  const date = "2026-06-30";
  const { accepted, request, recovery } = savedPlanRecovery(date);
  const driftedDaily = {
    ...accepted,
    id: 94,
    session_id: 57,
    items: [{ ...accepted.items[0], exercise: "Incline Bench" }],
  };
  const runtime = loadOutboxRuntime({
    responses: [
      { status: 200, body: { ok: true, daily_session: driftedDaily, session: { id: 57, date } } },
      { status: 409, body: { ok: false, error: "daily session is locked" } },
    ],
  });
  const prepare = await runtime.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    request,
    { prepareIntent: accepted, retryBody: recovery.body, retryIntent: recovery.intent },
  );
  await runtime.context.outboxEnqueue(
    "set",
    "/sets",
    { date, exercise: "Bench", reps: 5 },
    { dependsOn: prepare.id },
  );

  await runtime.context.flushOutbox();
  await runtime.context.CairnOutbox.retry(prepare.id);

  const queued = runtime.context.CairnOutbox.list();
  assert.deepEqual(runtime.requests.map((row) => row.url), [
    "/api/daily-session/prepare",
    "/api/daily-session/prepare",
  ]);
  assert.deepEqual(JSON.parse(runtime.requests[1].init.body), plain(recovery.body));
  assert.equal(queued.length, 2);
  assert.equal(queued[0].state, "needs_attention");
  assert.equal(queued[1].depends_on, queued[0].id);
  assert.equal(queued[1].kind, "set");
});

test("canonical replay refuses drift in promised constraints or stable provenance", async () => {
  const date = "2026-06-30";
  for (const [label, expectedContext, actualContext] of [
    [
      "constraints",
      { constraints: { equipment: ["rack"], readiness: { shoulder: "easy" } } },
      { constraints: { readiness: { shoulder: "hard" }, equipment: ["rack"] } },
    ],
    [
      "provenance",
      { provenance: { entry: "offline_snapshot_recovery", recovered_from_source: "manual_plan" } },
      { provenance: { recovered_from_source: "adaptive_plan", entry: "offline_snapshot_recovery", server_field: true } },
    ],
  ]) {
    const daily = {
      id: 95,
      session_id: 58,
      date,
      source: "athlete_override",
      plan_day_id: null,
      title: "Saved",
      focus: null,
      why: null,
      est_minutes: null,
      items: [],
      ...actualContext,
    };
    const runtime = loadOutboxRuntime({
      responses: [{ status: 200, body: { ok: true, daily_session: daily, session: { id: 58, date } } }],
    });
    await runtime.context.outboxEnqueue(
      "daily_session_prepare",
      "/daily-session/prepare",
      { date, source: "athlete_override", replace: true, session: { name: "Saved", items: [] } },
      {
        prepareIntent: {
          date,
          source: "athlete_override",
          plan_day_id: null,
          title: "Saved",
          focus: null,
          why: null,
          est_minutes: null,
          items: [],
          ...expectedContext,
        },
      },
    );

    await runtime.context.flushOutbox();
    assert.equal(runtime.context.CairnOutbox.list()[0].state, "needs_attention", label);
  }
});

test("cached assertion replay blocks dependents when the server active composition changed", async () => {
  const date = "2026-06-30";
  const expectedDaily = {
    id: 81,
    session_id: 44,
    date,
    source: "manual_plan",
    status: "active",
    plan_day_id: 22,
    title: "Upper",
    focus: "Push",
    est_minutes: 45,
    items: [{ position: 0, exercise: "Bench", sets: 3 }],
  };
  const changedDaily = { ...expectedDaily, id: 82, session_id: 45, title: "Changed elsewhere" };
  const runtime = loadOutboxRuntime({
    responses: [{
      status: 200,
      body: { ok: true, daily_session: changedDaily, session: { id: 45, date, daily_session: changedDaily } },
    }],
  });
  const prepare = await runtime.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    { date, expected_active_id: 81 },
    { prepareIntent: expectedDaily },
  );
  await runtime.context.outboxEnqueue(
    "set",
    "/sets",
    { date, exercise: "Bench", reps: 5 },
    { dependsOn: prepare.id },
  );

  await runtime.context.flushOutbox();

  assert.deepEqual(runtime.requests.map((request) => request.url), ["/api/daily-session/prepare"]);
  assert.deepEqual(JSON.parse(runtime.requests[0].init.body), { date, expected_active_id: 81 });
  assert.equal(runtime.context.CairnOutbox.list()[0].state, "needs_attention");
  assert.equal(runtime.context.CairnOutbox.list()[1].kind, "set");
});

test("discarding a staged prepare clears only its matching SWR pair", async () => {
  const date = "2026-06-30";
  const otherDate = "2026-07-01";
  const runtime = loadOutboxRuntime({ responses: [] });
  const prepare = await runtime.context.outboxEnqueue(
    "daily_session_prepare",
    "/daily-session/prepare",
    { date, source: "athlete_override", replace: false, session: { name: "Open", items: [] } },
    { prepareIntent: { date, source: "athlete_override", plan_day_id: null, title: "Open", focus: null, why: null, est_minutes: null, items: [] } },
  );
  const daily = { _staged_offline: true, _local_prepare_id: prepare.id, date, status: "active", items: [] };
  runtime.cache.set(`today:session:${date}`, {
    _staged_offline: true,
    _local_prepare_id: prepare.id,
    date,
    daily_session: daily,
  });
  runtime.cache.set(`today:daily-session:${date}`, daily);
  runtime.cache.set(`today:session:${otherDate}`, { id: 99, date: otherDate });
  const set = await runtime.context.outboxEnqueue(
    "set",
    "/sets",
    { date, exercise: "Bench", reps: 5 },
    { dependsOn: prepare.id },
  );

  assert.equal(await runtime.context.CairnOutbox.discard(prepare.id), false);
  assert.equal(runtime.cache.has(`today:session:${date}`), true);
  assert.equal(await runtime.context.CairnOutbox.discard(set.id), true);
  assert.equal(await runtime.context.CairnOutbox.discard(prepare.id), true);

  assert.equal(runtime.cache.has(`today:session:${date}`), false);
  assert.equal(runtime.cache.has(`today:daily-session:${date}`), false);
  assert.deepEqual(runtime.cache.get(`today:session:${otherDate}`), { id: 99, date: otherDate });
});

test("phantom staged cache is refused and cleared when its prerequisite disappeared", () => {
  const date = "2026-06-30";
  const runtime = loadOutboxRuntime({ responses: [] });
  const daily = { _staged_offline: true, _local_prepare_id: "missing", date, status: "active", items: [] };
  runtime.cache.set(`today:session:${date}`, {
    _staged_offline: true,
    _local_prepare_id: "missing",
    date,
    daily_session: daily,
  });
  runtime.cache.set(`today:daily-session:${date}`, daily);

  assert.deepEqual(
    plain(runtime.context.outboxSessionPrerequisite(date)),
    { status: "blocked", id: null, reason: "phantom" },
  );
  assert.equal(runtime.cache.has(`today:session:${date}`), false);
  assert.equal(runtime.cache.has(`today:daily-session:${date}`), false);
  assert.deepEqual(
    plain(runtime.context.outboxSessionPrerequisite(date)),
    { status: "blocked", id: null, reason: "phantom" },
    "the still-mounted stale surface remains blocked after cache cleanup",
  );
  runtime.context.outboxResolveSessionPrerequisite(date);
  assert.deepEqual(plain(runtime.context.outboxSessionPrerequisite(date)), { status: "none", id: null });
});
