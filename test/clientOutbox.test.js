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

test("outbox trims to the max, dropping the oldest", () => {
  const { createOutbox } = loadOutbox();
  const box = createOutbox({ storage: fakeStorage(), max: 3 });
  for (let i = 1; i <= 5; i++) box.enqueue({ kind: "set", path: "/sets", body: { n: i } });
  const items = box.list();
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((it) => it.body.n),
    [3, 4, 5],
    "keeps the newest 3"
  );
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
