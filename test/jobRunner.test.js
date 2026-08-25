// The shared serial-queue mechanics behind the durable chat/agent-job engines
// (src/jobRunner.ts). The property under test here is the one the HTTP surfaces
// depend on: enqueue HANDS OFF work — it never runs any of it on the caller's
// stack. `drain()` is async, but an async function still executes synchronously
// up to its first await, and a real processor (a chat turn) reaches its first
// await only after building the whole coach context — seconds of synchronous
// SQLite that used to land inside POST /api/chat, whose entire contract is to
// persist and return immediately.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgressBus, createSerialRunner } from "../dist/jobRunner.js";
import { activeTimeZone, runWithTimeZone } from "../dist/tz.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("enqueue never runs the processor on the caller's stack", async () => {
  const started = [];
  const runner = createSerialRunner(
    async (id) => {
      started.push(id); // synchronous prologue: exactly what used to block the request
      await tick();
    },
    () => {}
  );

  runner.enqueue(1);
  assert.deepEqual(started, [], "nothing ran before enqueue returned");
  await tick();
  await tick();
  assert.deepEqual(started, [1]);
});

test("the deferred kick still drains strictly serially, in order", async () => {
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const runner = createSerialRunner(
    async (id) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(`start:${id}`);
      await tick();
      order.push(`end:${id}`);
      concurrent -= 1;
    },
    () => {}
  );

  runner.enqueue(1);
  runner.enqueue(2);
  runner.enqueue(3);
  assert.deepEqual(order, [], "three enqueues, zero work on the caller's stack");
  for (let i = 0; i < 12; i += 1) await tick();
  assert.equal(maxConcurrent, 1, "strictly one at a time");
  assert.deepEqual(order, ["start:1", "end:1", "start:2", "end:2", "start:3", "end:3"]);
});

test("an item enqueued mid-drain joins the same loop rather than starting a second one", async () => {
  const order = [];
  let runner;
  runner = createSerialRunner(
    async (id) => {
      order.push(id);
      if (id === 1) runner.enqueue(2);
      await tick();
    },
    () => {}
  );

  runner.enqueue(1);
  for (let i = 0; i < 12; i += 1) await tick();
  assert.deepEqual(order, [1, 2]);
});

test("a throwing item reaches the backstop and never wedges the queue", async () => {
  const seen = [];
  const failures = [];
  const runner = createSerialRunner(
    async (id) => {
      seen.push(id);
      if (id === 1) throw new Error("processor exploded");
    },
    (id, error) => failures.push([id, error.message])
  );

  runner.enqueue(1);
  runner.enqueue(2);
  for (let i = 0; i < 12; i += 1) await tick();
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(failures, [[1, "processor exploded"]]);
});

test("the async-local timezone established around enqueue survives the deferred kick", async () => {
  // processChatTurn re-establishes the device zone from the persisted row, so it
  // does not depend on this — but the hop must not silently drop async-local
  // context for anything that does. AsyncLocalStorage propagates through
  // setImmediate; this pins that, so a future change to the kick cannot quietly
  // move the worker out of the athlete's calendar.
  const seen = [];
  const runner = createSerialRunner(
    async () => {
      seen.push(activeTimeZone());
    },
    () => {}
  );

  runWithTimeZone("Pacific/Honolulu", () => {
    runner.enqueue(1);
  });
  assert.deepEqual(seen, []);
  for (let i = 0; i < 8; i += 1) await tick();
  assert.deepEqual(seen, ["Pacific/Honolulu"]);
});

test("the progress bus delivers per-entity events and unsubscribes cleanly", () => {
  const bus = createProgressBus("test");
  const seen = [];
  const off = bus.on(7, (event) => seen.push(event));
  bus.emit(7, { type: "phase" });
  bus.emit(8, { type: "phase" }); // a different entity, same bus
  off();
  bus.emit(7, { type: "done" });
  assert.deepEqual(seen, [{ type: "phase" }]);
});
