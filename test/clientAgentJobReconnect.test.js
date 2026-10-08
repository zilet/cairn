// jobReconnect (agent-job-client.ts): the boot sweep reads /agent-jobs; a sweep a lazy
// bundle owes moments later (app/lazy-bundles.ts) reuses that list instead of asking
// again — the duplicate GET a cold You -> Health open used to make. A plain sweep, or
// one past the reuse window, always asks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function load(apiImpl) {
  let now = 50_000;
  const asked = [];
  const streams = [];
  const context = {
    Array, Map, Math, Number, Object, Promise, Set, String, JSON,
    Date: { now: () => now },
    api: apiImpl || (async (path) => {
      asked.push(path);
      return { jobs: [{ id: 7, kind: "health_review", status: "running" }] };
    }),
    EventSource: class {
      constructor(url) {
        streams.push(url);
      }
      addEventListener() {}
      close() {}
    },
    withToken: (u) => u,
    encodeURIComponent,
  };
  context.globalThis = context;
  for (const file of ["public/js/agent-job-records-client.js", "public/js/agent-job-client.js"]) {
    vm.runInNewContext(readFileSync(join(root, file), "utf8"), context, { filename: file });
  }
  return { context, asked, streams, advance: (ms) => (now += ms) };
}

test("an owed sweep seconds after the boot sweep reuses its list; a later or plain sweep asks again", async () => {
  const { context, asked, advance } = load();
  const made = [];
  await context.jobReconnect();
  assert.deepEqual(asked, ["/agent-jobs"]);
  // A lazy bundle brings the reconnector for that job, then pays its owed sweep.
  context.registerJobReconnector("health_review", (job) => {
    made.push(job.id);
    return {};
  });
  advance(1500);
  await context.jobReconnect({ reuseWithinMs: 10_000 });
  assert.deepEqual(asked, ["/agent-jobs"], "no second read");
  assert.deepEqual(made, [7], "the reused list still reattaches the job");
  advance(10_000);
  await context.jobReconnect({ reuseWithinMs: 10_000 });
  assert.equal(asked.length, 2, "past the window it asks");
  await context.jobReconnect();
  assert.equal(asked.length, 3, "a plain sweep always asks");
});

test("a failed /agent-jobs read hands the first-week status its own single read; a good one adds none", async () => {
  const calls = { ingest: 0, refresh: 0 };
  const week = { ingest: () => calls.ingest++, refresh: async () => void calls.refresh++ };
  const ok = load();
  ok.context.CairnFirstWeek = week;
  await ok.context.jobReconnect();
  assert.deepEqual(calls, { ingest: 1, refresh: 0 }, "the success path adds no request");

  const bad = load(async () => {
    throw new Error("offline");
  });
  bad.context.CairnFirstWeek = week;
  await bad.context.jobReconnect();
  await bad.context.jobReconnect();
  assert.deepEqual(calls, { ingest: 1, refresh: 1 }, "refreshed once, not per failed sweep");
});
