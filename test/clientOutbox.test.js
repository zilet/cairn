import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Load the compiled api-client (which carries the outbox) in a bare context — no
// window/document/navigator/setTimeout, so the runtime side effects (boot flush,
// online listener, affordance render) all self-gate off and we're left with the
// pure createOutbox core to exercise.
function loadOutbox() {
  const context = { Date, JSON, Math, Array, Object, String, Number, Promise };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/api-client.js"), "utf8"), context);
  return context.CairnOutbox;
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    _map: map,
  };
}

test("outbox enqueue appends items and reports count in FIFO order", () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  assert.equal(box.count(), 0);

  box.enqueue({ kind: "activity", path: "/activities", body: { text: "ran 5k" } });
  box.enqueue({ kind: "food", path: "/food-notes", body: { meal: "lunch", text: "salad" } });

  const items = box.list();
  assert.equal(box.count(), 2);
  assert.equal(items[0].kind, "activity");
  assert.equal(items[1].kind, "food");
  assert.deepEqual(items[0].body, { text: "ran 5k" });
  assert.ok(items[0].id && items[1].id && items[0].id !== items[1].id, "unique ids");
});

test("outbox accepts one validated preallocated identity and rejects invalid or duplicate keys", () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  const stable = box.enqueue({ id: "session-mutation:44.1", kind: "finish", path: "/sessions/44/finish", body: {} });

  assert.equal(stable.id, "session-mutation:44.1");
  assert.equal(
    box.enqueue({ id: "session-mutation:44.1", kind: "set", path: "/sets", body: {} }),
    null,
    "a preallocated identity is consumed at most once",
  );
  assert.equal(
    box.enqueue({ id: "bad\nheader", kind: "set", path: "/sets", body: {} }),
    null,
    "unsafe header material is rejected rather than replaced by a second identity",
  );
});

test("expired claim takeover rejects stale pending and attention settlements by generation", () => {
  const { createOutbox } = loadOutbox();
  let clock = 1_000;
  const box = createOutbox({ storage: fakeStorage(), now: () => clock });
  const item = box.enqueue({
    kind: "set",
    path: "/sets",
    body: { date: "2026-06-30", exercise: "Bench", reps: 5 },
    session_date: "2026-06-30",
    group_id: "session:44",
  });

  const first = box.claimNext().item;
  assert.equal(first.id, item.id);
  assert.equal(first.state, "sending");
  assert.equal(typeof first.claim_token, "string");
  clock = first.in_flight_until + 1;
  const takeover = box.claimNext().item;
  assert.equal(takeover.id, item.id);
  assert.notEqual(takeover.claim_token, first.claim_token, "every takeover owns a fresh generation");
  const takeoverDeadline = takeover.in_flight_until;

  assert.equal(box.settle(item.id, first.claim_token, "pending"), false);
  assert.equal(box.list()[0].claim_token, takeover.claim_token);
  assert.equal(box.list()[0].in_flight_until, takeoverDeadline);
  assert.equal(box.settle(item.id, first.claim_token, "attention", 409), false);
  assert.equal(box.list()[0].state, "sending");
  assert.equal(box.list()[0].claim_token, takeover.claim_token);
  assert.equal(box.list()[0].in_flight_until, takeoverDeadline);
  assert.equal(box.review().length, 0, "a stale claimant cannot expose Retry while takeover delivery is active");

  assert.equal(box.settle(item.id, takeover.claim_token, "delivered"), true);
  assert.equal(box.count(), 0);
  assert.equal(box.settle(item.id, first.claim_token, "delivered"), false, "late success after delivery is harmless");
});

test("review never exposes a currently sending generation behind group attention", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage(), now: () => 1_000 });
  const failed = box.enqueue({
    kind: "set",
    path: "/sets",
    body: { n: 1 },
    group_id: "session:44",
  });
  box.enqueue({
    kind: "finish",
    path: "/sessions/44/finish",
    body: { notes: "done" },
    group_id: "session:44",
    state: "sending",
    in_flight_until: 31_000,
    claim_token: "claim:active:2",
  });
  await box.drain(async (item) => item.id === failed.id ? "needs_attention" : undefined);

  const review = box.review();
  assert.equal(review.length, 1);
  assert.equal(review[0].item.id, failed.id);
  assert.equal(review[0].role, "attention");
});

test("outbox persists across controller instances over the same storage", () => {
  const { createOutbox } = loadOutbox();
  const storage = fakeStorage();
  const first = createOutbox({ storage });
  first.enqueue({ kind: "set", path: "/sets", body: { exercise: "Squat", weight: 225, reps: 5 } });

  // A "reload" — a fresh controller over the same durable storage sees the queue.
  const second = createOutbox({ storage });
  assert.equal(second.count(), 1);
  assert.equal(second.list()[0].body.exercise, "Squat");
});

test("outbox drain replays in order, drops delivered items, keeps the rest", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  box.enqueue({ kind: "set", path: "/sets", body: { n: 1 } });
  box.enqueue({ kind: "set", path: "/sets", body: { n: 2 } });
  box.enqueue({ kind: "set", path: "/sets", body: { n: 3 } });

  const seen = [];
  // Deliver 1 and 2, then a transient failure on 3 stops the drain.
  const result = await box.drain(async (item) => {
    seen.push(item.body.n);
    if (item.body.n === 3) throw new Error("network down");
  });

  assert.deepEqual(seen, [1, 2, 3], "attempts oldest-first, stops at the failure");
  assert.equal(result.sent, 2);
  assert.equal(result.remaining, 1);
  assert.equal(box.count(), 1);
  assert.equal(box.list()[0].body.n, 3, "the unsent item stays at the head");
});

test("outbox drain clears the queue when everything delivers", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  box.enqueue({ kind: "activity", path: "/activities", body: { text: "a" } });
  box.enqueue({ kind: "activity", path: "/activities", body: { text: "b" } });

  const result = await box.drain(async () => {});
  assert.equal(result.sent, 2);
  assert.equal(result.remaining, 0);
  assert.equal(box.count(), 0);
});

test("outbox drain preserves items enqueued mid-replay (dropped again offline)", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  box.enqueue({ kind: "set", path: "/sets", body: { n: 1 } });

  // The first delivery succeeds but the network drops again, queueing a new set.
  const result = await box.drain(async (item) => {
    if (item.body.n === 1) box.enqueue({ kind: "set", path: "/sets", body: { n: 2 } });
  });

  assert.equal(result.sent, 1);
  assert.equal(box.count(), 1, "the item added during the drain survives");
  assert.equal(box.list()[0].body.n, 2);
});

test("outbox persists and replays an explicit DELETE method", async () => {
  const { createOutbox } = loadOutbox();
  const storage = fakeStorage();
  const first = createOutbox({ storage });
  first.enqueue({
    kind: "restore",
    path: "/sessions/skip",
    method: "DELETE",
    body: { date: "2026-06-30", exercise: "Squat" },
  });
  const reloaded = createOutbox({ storage });
  const seen = [];

  await reloaded.drain(async (item) => seen.push({ method: item.method, kind: item.kind }));

  assert.deepEqual(seen, [{ method: "DELETE", kind: "restore" }]);
  assert.equal(reloaded.count(), 0);
});

test("outbox rejects new independent items at the cap without evicting confirmed logs", () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage(), max: 3 });
  const results = [];
  for (let i = 1; i <= 5; i++) results.push(box.enqueue({ kind: "set", path: "/sets", body: { n: i } }));
  const items = box.list();
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((it) => it.body.n),
    [1, 2, 3],
    "keeps every previously confirmed item"
  );
  assert.equal(results[3], null);
  assert.equal(results[4], null);
});

test("outbox is resilient to corrupt storage", () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage({ "cairn.outbox.v1": "{not json" }) });
  assert.equal(box.count(), 0);
  // A corrupt blob is simply overwritten by the next good write.
  box.enqueue({ kind: "food", path: "/food-notes", body: { text: "eggs" } });
  assert.equal(box.count(), 1);
});

test("outbox remove and clear prune the queue", () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  const a = box.enqueue({ kind: "set", path: "/sets", body: { n: 1 } });
  box.enqueue({ kind: "set", path: "/sets", body: { n: 2 } });
  box.remove(a.id);
  assert.equal(box.count(), 1);
  assert.equal(box.list()[0].body.n, 2);
  box.clear();
  assert.equal(box.count(), 0);
});

test("outbox retry clears attention metadata without removing the saved log", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  const item = box.enqueue({ kind: "activity", path: "/activities", body: { text: "easy run" } });
  await box.drain(async (pending) => {
    pending.failure_status = 422;
    return "needs_attention";
  });

  assert.equal(box.list()[0].state, "needs_attention");
  assert.equal(box.list()[0].failure_status, 422);
  assert.equal(box.retry(item.id), true);
  assert.equal(box.count(), 1, "retry keeps the durable payload until replay succeeds");
  assert.notEqual(box.list()[0].id, item.id, "every explicit attention retry gets a fresh server identity");
  assert.equal(box.list()[0].state, undefined);
  assert.equal(box.list()[0].failure_status, undefined);
  assert.equal(box.retry("missing"), false);
});

test("outbox review summaries are bounded and never lead with internal request paths", () => {
  const outbox = loadOutbox();
  const summary = outbox.itemSummary({
    id: "legacy",
    ts: 1,
    kind: "finish",
    path: "/sessions/44/finish",
    body: { notes: "Strong session ".repeat(30) },
  });
  assert.match(summary, /^Finish session · Strong session/);
  assert.ok(summary.length <= 140);
  assert.doesNotMatch(summary, /\/sessions|\/api/);
});

test("outbox retains permanent failures as needs-attention without retry-looping", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  box.enqueue({ kind: "set", path: "/sets", body: { reps: 8 } });
  box.enqueue({ kind: "weight", path: "/bodyweight", body: { weight_lb: 180 } });
  let calls = 0;

  const first = await box.drain(async (item) => {
    calls++;
    if (item.kind === "set") return "needs_attention";
  });
  assert.equal(first.sent, 1);
  assert.equal(first.needsAttention, 1);
  assert.equal(box.list()[0].state, "needs_attention");

  const second = await box.drain(async () => {
    calls++;
  });
  assert.equal(second.sent, 0);
  assert.equal(second.needsAttention, 1);
  assert.equal(calls, 2, "the permanent failure was not sent again");
});

test("outbox stops on transient rejection and keeps FIFO items pending", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  box.enqueue({ kind: "activity", path: "/activities", body: {} });
  box.enqueue({ kind: "food", path: "/food-notes", body: {} });
  const result = await box.drain(async () => {
    throw new Error("network");
  });
  assert.equal(result.sent, 0);
  assert.equal(result.remaining, 2);
  assert.equal(result.needsAttention, 0);
});

test("a permanently rejected session prepare blocks dependent workout writes", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  const prepare = box.enqueue({
    kind: "daily_session_prepare",
    path: "/daily-session/prepare",
    body: { date: "2026-06-30", source: "manual_plan", day_number: 2 },
  });
  box.enqueue({
    kind: "set",
    path: "/sets",
    body: { date: "2026-06-30", exercise: "Bench", reps: 5 },
    depends_on: prepare.id,
  });
  box.enqueue({
    kind: "finish",
    path: "/sessions/42/finish",
    body: { notes: "done" },
    depends_on: prepare.id,
  });
  const seen = [];

  const first = await box.drain(async (item) => {
    seen.push(item.kind);
    if (item.kind === "daily_session_prepare") {
      item.failure_status = 409;
      return "needs_attention";
    }
  });
  assert.deepEqual(seen, ["daily_session_prepare"]);
  assert.equal(first.sent, 0);
  assert.equal(first.needsAttention, 1);
  assert.equal(box.list()[0].state, "needs_attention");
  assert.equal(box.remove(prepare.id), false, "a prepare with dependent logs cannot be discarded");

  await box.drain(async (item) => seen.push(item.kind));
  assert.deepEqual(seen, ["daily_session_prepare"], "later flushes keep dependent writes behind the barrier");
  assert.deepEqual(box.list().map((item) => item.kind), ["daily_session_prepare", "set", "finish"]);

  assert.equal(box.retry(prepare.id), true);
  const retriedPrepare = box.list()[0];
  assert.notEqual(retriedPrepare.id, prepare.id, "explicit recovery gets a fresh idempotency identity");
  assert.equal(retriedPrepare.body.replace, true, "explicit recovery may replace an unstarted conflicting session");
  assert.equal(
    box.list().slice(1).every((item) => item.depends_on === retriedPrepare.id),
    true,
    "all dependent writes are atomically rewired to the fresh prepare",
  );
  await box.drain(async (item) => seen.push(item.kind));
  assert.deepEqual(seen, ["daily_session_prepare", "daily_session_prepare", "set", "finish"]);
  assert.equal(box.count(), 0, "successful retry releases the group in exact FIFO order");
});

test("prepare attention blocks only its dependents while unrelated logs continue", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  const prepare = box.enqueue({
    kind: "daily_session_prepare",
    path: "/daily-session/prepare",
    body: { date: "2026-06-30", source: "manual_plan", day_number: 2 },
  });
  box.enqueue({
    kind: "set",
    path: "/sets",
    body: { date: "2026-06-30", exercise: "Bench", reps: 5 },
    depends_on: prepare.id,
    group_id: "date:2026-06-30",
  });
  box.enqueue({ kind: "weight", path: "/bodyweight", body: { weight_lb: 180 } });
  const seen = [];

  await box.drain(async (item) => {
    seen.push(item.kind);
    if (item.kind === "daily_session_prepare") return "needs_attention";
  });

  assert.deepEqual(seen, ["daily_session_prepare", "weight"]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(box.review().map(({ item, role }) => [item.kind, role]))),
    [["daily_session_prepare", "attention"], ["set", "blocked_dependent"]],
  );
  assert.deepEqual(box.list().map((item) => item.kind), ["daily_session_prepare", "set"]);
});

test("an already-started dependency group may exceed the cap without dropping any item", () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage(), max: 4 });
  box.enqueue({ kind: "activity", path: "/activities", body: { n: 1 } });
  box.enqueue({ kind: "weight", path: "/bodyweight", body: { n: 2 } });
  const prepare = box.enqueue({ kind: "daily_session_prepare", path: "/daily-session/prepare", body: { n: 3 } });
  box.enqueue({ kind: "set", path: "/sets", body: { n: 4 }, depends_on: prepare.id });
  box.enqueue({ kind: "finish", path: "/sessions/4/finish", body: { n: 5 }, depends_on: prepare.id });

  assert.deepEqual(box.list().map((item) => item.body.n), [1, 2, 3, 4, 5]);
  assert.equal(box.list().filter((item) => item.depends_on).every((item) => item.depends_on === prepare.id), true);
  assert.equal(box.list().some((item) => item.id === prepare.id), true);

  const food = box.enqueue({ kind: "food", path: "/food-notes", body: { n: 6 } });
  const retained = box.list();
  assert.equal(food, null);
  assert.deepEqual(retained.map((item) => item.body.n), [1, 2, 3, 4, 5]);
  assert.equal(
    retained.filter((item) => item.depends_on).every((item) => retained.some((candidate) => candidate.id === item.depends_on)),
    true,
    "cap eviction keeps the prerequisite with every retained dependent"
  );
});

test("oversized workout groups survive the cap and reject unrelated overflow without silent loss", () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage(), max: 2 });
  const prepare = box.enqueue({ kind: "daily_session_prepare", path: "/daily-session/prepare", body: {} });
  box.enqueue({ kind: "set", path: "/sets", body: { n: 1 }, depends_on: prepare.id });
  box.enqueue({ kind: "finish", path: "/sessions/1/finish", body: { n: 2 }, depends_on: prepare.id });

  assert.deepEqual(
    box.list().map((item) => item.kind),
    ["daily_session_prepare", "set", "finish"],
    "the live workout transaction may exceed the ordinary cap",
  );
  const unrelated = box.enqueue({ kind: "activity", path: "/activities", body: { n: 3 } });
  assert.equal(unrelated, null, "enqueue does not claim an unrelated overflow log was saved");
  assert.deepEqual(box.list().map((item) => item.kind), ["daily_session_prepare", "set", "finish"]);
});

test("attention review exposes blocked dependents for individual discard before its prepare barrier", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  const prepare = box.enqueue({ kind: "daily_session_prepare", path: "/daily-session/prepare", body: {} });
  const set = box.enqueue({ kind: "set", path: "/sets", body: { n: 1 }, depends_on: prepare.id });
  const finish = box.enqueue({ kind: "finish", path: "/sessions/1/finish", body: {}, depends_on: prepare.id });
  await box.drain(async () => "needs_attention");

  assert.deepEqual(
    JSON.parse(JSON.stringify(box.review().map((entry) => entry.role))),
    ["attention", "blocked_dependent", "blocked_dependent"],
  );
  assert.equal(box.remove(prepare.id), false, "the barrier cannot be silently discarded while logs depend on it");
  assert.equal(box.remove(set.id), true);
  assert.equal(box.remove(prepare.id), false, "one remaining dependent still protects the barrier");
  assert.equal(box.remove(finish.id), true);
  assert.equal(box.remove(prepare.id), true, "the barrier becomes discardable only after every dependent is gone");
});

test("a failed workout member blocks later siblings while independent logs continue, then retry preserves FIFO", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  const group = "daily:81";
  const set1 = box.enqueue({
    kind: "set",
    path: "/sets",
    body: { n: 1 },
    group_id: group,
    session_date: "2026-06-30",
  });
  box.enqueue({ kind: "set", path: "/sets", body: { n: 2 }, group_id: group });
  box.enqueue({ kind: "finish", path: "/sessions/1/finish", body: {}, group_id: group });
  box.enqueue({ kind: "weight", path: "/bodyweight", body: { weight_lb: 180 } });
  const seen = [];

  await box.drain(async (item) => {
    seen.push(item.kind === "set" ? `set${item.body.n}` : item.kind);
    if (item.id === set1.id) {
      item.failure_status = 400;
      return "needs_attention";
    }
  });

  assert.deepEqual(seen, ["set1", "weight"]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(box.review().map(({ item, role }) => [item.kind, role]))),
    [["set", "attention"], ["set", "blocked_dependent"], ["finish", "blocked_dependent"]],
  );
  assert.equal(box.retry(set1.id), true);
  const retried = box.list()[0];
  assert.notEqual(retried.id, set1.id);
  assert.equal(retried.group_id, group);
  assert.equal(retried.session_date, "2026-06-30");
  assert.deepEqual(JSON.parse(JSON.stringify(retried.body)), { n: 1 });

  await box.drain(async (item) => seen.push(item.kind === "set" ? `set${item.body.n}` : item.kind));

  assert.deepEqual(seen, ["set1", "weight", "set1", "set2", "finish"]);
  assert.equal(box.count(), 0);
});

test("discarding a failed workout member explicitly releases its remaining siblings in order", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage() });
  const group = "daily:81";
  const set1 = box.enqueue({ kind: "set", path: "/sets", body: { n: 1 }, group_id: group });
  box.enqueue({ kind: "skip", path: "/sessions/skip", body: { exercise: "Squat" }, group_id: group });
  box.enqueue({
    kind: "restore",
    path: "/sessions/skip",
    method: "DELETE",
    body: { exercise: "Squat" },
    group_id: group,
  });
  box.enqueue({ kind: "finish", path: "/sessions/1/finish", body: {}, group_id: group });
  const seen = [];

  await box.drain(async (item) => {
    seen.push(item.kind);
    if (item.id === set1.id) return "needs_attention";
  });
  assert.deepEqual(seen, ["set"]);
  assert.equal(box.remove(set1.id), true);

  await box.drain(async (item) => seen.push(item.kind));

  assert.deepEqual(seen, ["set", "skip", "restore", "finish"]);
  assert.equal(box.count(), 0);
});

test("assertion attention retry switches to its saved replacement intent under a fresh identity", async () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage(), now: () => 5000 });
  const assertion = box.enqueue({
    kind: "daily_session_prepare",
    path: "/daily-session/prepare",
    body: { date: "2026-06-30", expected_active_id: 81 },
    prepare_intent: { date: "2026-06-30", source: "manual_plan", title: "Upper", items: [] },
    retry_body: {
      date: "2026-06-30",
      source: "athlete_override",
      session: { name: "Upper", items: [] },
      replace: true,
    },
    retry_intent: { date: "2026-06-30", source: "athlete_override", title: "Upper", items: [] },
  });
  await box.drain(async () => "needs_attention");

  assert.equal(box.retry(assertion.id), true);
  const retried = box.list()[0];
  assert.notEqual(retried.id, assertion.id);
  assert.deepEqual(JSON.parse(JSON.stringify(retried.body)), {
    date: "2026-06-30",
    source: "athlete_override",
    session: { name: "Upper", items: [] },
    replace: true,
  });
  assert.equal(retried.prepare_intent.source, "athlete_override");
});

test("enqueue reports storage quota failure and preserves the previously durable queue", () => {
  const { createOutbox } = loadOutbox();
  const storage = fakeStorage();
  const box = createOutbox({ storage });
  const first = box.enqueue({ kind: "activity", path: "/activities", body: { n: 1 } });
  const durable = storage.getItem("cairn.outbox.v1");
  storage.setItem = () => { throw new Error("quota exceeded"); };

  const rejected = box.enqueue({ kind: "weight", path: "/bodyweight", body: { n: 2 } });

  assert.ok(first);
  assert.equal(rejected, null);
  assert.equal(storage.getItem("cairn.outbox.v1"), durable);
  assert.deepEqual(box.list().map((item) => item.body.n), [1]);
});
