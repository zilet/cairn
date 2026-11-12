// ONE TABLE FROM A WRITE TO THE CACHES IT MAKES STALE (src/client/write-invalidation-client.ts).
//
// A chat turn applies its actions server-side, long after the POST that queued it,
// and the PWA used to drop only "plan" when it finished — so a chat-logged meal left
// Fuel, the Brief and Train painting the pre-write day from cache. These tests hold
// the table complete against the server's own action list, hold every target to a
// cache a surface actually reads, and drive the invalidation end to end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { CHAT_ACTION_TYPES } from "../dist/chatActions.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function memoryStorage(seed = []) {
  const map = new Map(seed);
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function load(extra = {}) {
  const dropped = [];
  let apiCleared = 0;
  const context = {
    Object,
    Set,
    Map,
    Array,
    JSON,
    Number,
    String,
    Date,
    Promise,
    localStorage: memoryStorage(),
    swrInvalidate: (key) => dropped.push(key),
    apiInvalidate: () => {
      apiCleared += 1;
    },
    state: { brief: { headline: "cached" }, plan: [1] },
    ...extra,
  };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/write-invalidation-targets.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/write-invalidation-client.js"), "utf8"), context);
  return { api: context.CairnWriteInvalidation, dropped, context, apiCleared: () => apiCleared };
}

const CLIENT_SOURCE = readdirSync(join(root, "src/client"), { recursive: true })
  .filter((f) => String(f).endsWith(".ts") && !String(f).includes("write-invalidation"))
  .map((f) => readFileSync(join(root, "src/client", String(f)), "utf8"))
  .join("\n");

test("every chat action type the server can apply has a row, and no row names an unknown type", () => {
  const { api } = load();
  const table = Object.keys(api.CHAT_ACTION_TARGETS).sort();
  assert.deepEqual(table, [...CHAT_ACTION_TYPES].sort());
  for (const type of CHAT_ACTION_TYPES) {
    assert.ok(api.targetsForChatAction(type).length > 0, `${type} invalidates something`);
  }
});

test("every target is a cache some surface actually reads (or a registered snapshot)", () => {
  const { api } = load();
  const targets = new Set([
    ...Object.values(api.CHAT_ACTION_TARGETS).flat(),
    ...Object.values(api.WRITE_TARGETS).flat(),
  ]);
  for (const target of targets) {
    if (target.startsWith("@")) {
      const name = target.slice(1);
      if (name === "brief" || name === "plan") continue; // registered by the module itself
      assert.match(CLIENT_SOURCE, new RegExp(`register\\(\\s*"${name}"`), `${target} is registered by a surface`);
      continue;
    }
    // An exact key must appear as a whole literal; a prefix as the start of one.
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = target.endsWith(":") ? new RegExp(`["\`]${escaped}`) : new RegExp(`["\`]${escaped}["\`]`);
    assert.match(CLIENT_SOURCE, pattern, `${target} is a key some surface caches under`);
  }
});

test("the reads each write feeds are covered: food, sets, weight, check-ins, plan, runs", () => {
  const { api } = load();
  const has = (type, ...keys) => {
    const t = api.targetsForChatAction(type);
    for (const key of keys) assert.ok(t.includes(key), `${type} drops ${key}`);
  };
  has("log_food", "food:day:", "fuel:band:", "progress:intake", "progress:energy", "today:aggregate:", "@brief");
  has("log_set", "today:session:", "stats", "history:sessions", "progress:volume", "last-set:", "@train");
  has("log_weight", "progress:weight", "stats", "profile", "fuel:band:");
  has("log_checkin", "today:aggregate:", "today:stones:", "@brief");
  has("plan_update", "plan", "plan:", "progress:program", "program:progression:", "@train");
  has("set_run", "horizon:", "@endurance", "today:aggregate:");
  has("log_activity", "@endurance", "stats", "today:session:");
  has("revert_decision", "plan", "meals:plans", "food:day:", "brain:changes");
});

test("a finished chat turn's applied list drops every mapped key once, clears api()'s tier and the Brief", () => {
  const env = load();
  const done = env.api.invalidateChatApplied([
    { type: "log_food", result: { ok: true } },
    { type: "log_weight", error: "read-back failed" },
    { type: "not_a_type" },
    null,
  ]);
  assert.ok(env.dropped.includes("food:day:"));
  assert.ok(env.dropped.includes("progress:weight"));
  assert.equal(new Set(env.dropped).size, env.dropped.length, "each key dropped once");
  assert.equal(env.apiCleared(), 1);
  assert.equal(env.context.state.brief, null);
  assert.ok(done.includes("@brief"));
});

test("nothing applied invalidates nothing", () => {
  const env = load();
  assert.equal(env.api.invalidateChatApplied([]).length, 0);
  assert.equal(env.api.invalidateChatApplied(undefined).length, 0);
  assert.equal(env.apiCleared(), 0);
  assert.deepEqual(env.dropped, []);
});

test("a registered snapshot is cleared by its @target; keep spares a target", () => {
  const env = load();
  let trainCleared = 0;
  env.api.register("train", () => {
    trainCleared += 1;
  });
  env.api.invalidateWrite("session_finish", { keep: ["@brief"] });
  assert.equal(trainCleared, 1);
  assert.deepEqual(env.context.state.brief, { headline: "cached" }, "kept");
  assert.ok(!env.dropped.includes("today:session:"), "the session key the finish just primed survives");
  assert.ok(env.dropped.includes("progress:volume"));
});

test("Undo, proposal apply and meal edits each name their caches", () => {
  const { api } = load();
  assert.ok(api.targetsForWrite("decision_revert").includes("plan"));
  assert.ok(api.targetsForWrite("proposal_apply").includes("plan:"));
  assert.ok(api.targetsForWrite("meal_edit").includes("meals:plans"));
  assert.equal(api.targetsForWrite("nope").length, 0);
});

test("the chat turn, Undo, finish, proposal apply and meal edits all route through the table", () => {
  const read = (f) => readFileSync(join(root, "src/client", f), "utf8");
  assert.match(read("chat-turn-client.ts"), /settleTurn\(/);
  assert.match(read("food-composer-turn-controller.ts"), /settleTurn\(current\)/);
  assert.match(read("decision-undo-controller.ts"), /invalidateWrite\(\s*"decision_revert"/);
  assert.match(read("today-session-controller.ts"), /invalidateWrite\("session_finish"/);
  assert.match(read("coach-proposal-controller.ts"), /invalidateWrite\("proposal_apply"\)/);
  assert.match(read("chat-message-client.ts"), /invalidateWrite\("proposal_apply"\)/);
  assert.match(read("meal-swap-controller.ts"), /invalidateWrite\("meal_edit"\)/);
});


test("the Brief target also drops the last-known Brief the fast path paints from", () => {
  const storage = memoryStorage([["cairn.brief.v1", '{"date":"2026-09-26"}'], ["other", "1"]]);
  const env = load({ localStorage: storage });
  env.api.invalidateChatApplied([{ type: "log_checkin" }]);
  assert.equal(storage.getItem("cairn.brief.v1"), null);
  assert.equal(storage.getItem("other"), "1");
  // The key is the Brief cache's own (today-brief-cache-client.ts).
  assert.match(readFileSync(join(root, "src/client/today-brief-cache-client.ts"), "utf8"), /BRIEF_LS_KEY = "cairn\.brief\.v1"/);
});

test("a plan write resets the in-memory plan; meal edits no longer name a dead shop: target", () => {
  const env = load();
  env.api.invalidateChatApplied([{ type: "plan_update" }]);
  assert.deepEqual([...env.context.state.plan], []);
  assert.ok(!env.api.targetsForWrite("meal_edit").includes("shop:"));
});

// ---- following a chat turn nobody on screen follows any more ----

function watchEnv({ storage = memoryStorage(), turns = {} } = {}) {
  const timers = [];
  const calls = [];
  const env = load({
    localStorage: storage,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    document: { visibilityState: "visible", addEventListener() {} },
    api: async (path) => {
      calls.push(path);
      const id = Number(path.split("/").pop());
      const turn = typeof turns[id] === "function" ? turns[id]() : turns[id];
      if (turn instanceof Error) throw turn;
      return turn === undefined ? null : turn;
    },
  });
  // Run the timers pending NOW (one watch tick), not the ones a tick reschedules.
  const flush = async () => {
    const due = timers.splice(0);
    for (const fn of due) fn();
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return { ...env, storage, calls, timers, flush };
}

test("a turn left running when the athlete walks away from Chat still retires its caches", async () => {
  let status = "running";
  const env = watchEnv({
    turns: { 7: () => ({ id: 7, status, meta: status === "done" ? { applied: [{ type: "log_food" }] } : null }) },
  });
  env.api.trackTurn({ id: 7 }, { owned: true });
  // Chat's monitor owns it: nothing polls.
  await env.flush();
  assert.deepEqual(env.calls, []);
  // Leaving Chat hands it over.
  env.api.releaseTurn(7);
  await env.flush(); // still running: one poll, reschedules
  assert.deepEqual(env.calls, ["/chat/turns/7"]);
  assert.deepEqual(env.dropped, []);
  status = "done";
  await env.flush();
  assert.ok(env.dropped.includes("food:day:"));
  assert.ok(env.dropped.includes("today:aggregate:"));
  assert.equal(env.apiCleared(), 1);
  assert.equal(env.context.state.brief, null);
  assert.deepEqual([...env.api.watchedTurns()], []);
  assert.equal(env.storage.getItem("cairn.turnwatch.v1"), null);
});

test("a turn is settled once, whoever sees it finish first", async () => {
  const env = watchEnv();
  env.api.trackTurn(9, { owned: true });
  const turn = { id: 9, status: "done", meta: { applied: [{ type: "log_weight" }] } };
  assert.ok(env.api.settleTurn(turn).includes("progress:weight"));
  const first = env.dropped.length;
  assert.deepEqual([...env.api.settleTurn(turn)], []);
  assert.equal(env.dropped.length, first);
  env.api.trackTurn(9); // a late re-track of a settled turn is ignored
  assert.deepEqual([...env.api.watchedTurns()], []);
});

test("a turn a previous page left unfinished is settled on the next open", async () => {
  const storage = memoryStorage([["cairn.turnwatch.v1", JSON.stringify([[11, Date.now()]])]]);
  const env = watchEnv({ storage, turns: { 11: { id: 11, status: "done", meta: { applied: [{ type: "log_set" }] } } } });
  env.api.resumeTurns();
  await env.flush();
  assert.deepEqual(env.calls, ["/chat/turns/11"]);
  assert.ok(env.dropped.includes("history:sessions"));
  assert.equal(storage.getItem("cairn.turnwatch.v1"), null);
});

test("offline polls keep the turn; a turn the server forgot is dropped", async () => {
  const env = watchEnv({ turns: { 3: new TypeError("offline"), 4: null } });
  env.api.trackTurn(3);
  env.api.trackTurn(4);
  await env.flush();
  // One tick ran; 3 is kept for the next try, 4 is gone.
  assert.ok(env.api.watchedTurns().includes(3));
  assert.ok(!env.api.watchedTurns().includes(4));
  assert.deepEqual(env.dropped, []);
});
