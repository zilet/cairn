// The enrichment queue is ONE serial FIFO, and some of its work is slow on purpose: a
// Garmin outage catching up is seven export jobs at 90 seconds each plus strength jobs
// at 120. Behind that backlog sat the one job an athlete is actually sitting in chat
// waiting for — a photographed meal, a sentence about a sore knee — for something like
// ten minutes. Those go ahead of the backlog now. Nothing else is reordered, and
// nothing interrupts the job already running.
//
// Everything here is a phantom id against a queue whose handlers all no-op with
// enrichment off: the ORDER is the whole subject, and no agent is ever spawned.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { enqueueEnrich, pendingEnrichJobsForTests } from "../dist/enrich.js";
import { repo } from "./_seed.js";

before(() => {
  repo.setSettings({ enrich_enabled: false, garmin_export_strength: false });
});

// One test, because the drain loop's progress is inherently asynchronous: comparing a
// single before/after snapshot keeps the assertion about ordering alone.
test("waited-on work jumps a Garmin backlog; nothing else is reordered", () => {
  const mine = (jobs) => jobs.filter((job) => job.id >= 9000).map((job) => `${job.kind}#${job.id}`);

  enqueueEnrich("garmin_export", 9001);
  enqueueEnrich("garmin_export", 9002);
  enqueueEnrich("garmin_strength", 9003);
  enqueueEnrich("activity", 9004);
  // 9001 may already be draining; whatever is still waiting is in arrival order.
  const backlog = mine(pendingEnrichJobsForTests());
  assert.ok(backlog.includes("garmin_strength#9003"), "the slow strength job is genuinely queued");
  assert.ok(backlog.indexOf("garmin_strength#9003") < backlog.indexOf("activity#9004"), "in arrival order");

  enqueueEnrich("food_photo", 9005, { front: true });
  enqueueEnrich("symptom", 9006, { front: true });
  enqueueEnrich("garmin_export", 9007);

  const after = mine(pendingEnrichJobsForTests());
  assert.deepEqual(
    after.slice(0, 2),
    ["food_photo#9005", "symptom#9006"],
    "both waited-on jobs sit at the head, in the order they arrived"
  );
  assert.deepEqual(
    after.slice(2),
    [...backlog, "garmin_export#9007"],
    "and the background backlog keeps its own FIFO order behind them"
  );

  // The de-dupe is unchanged, front or not.
  enqueueEnrich("food_photo", 9005, { front: true });
  assert.equal(mine(pendingEnrichJobsForTests()).filter((job) => job === "food_photo#9005").length, 1);
});

// The mechanism is only worth anything if the real writers ask for it. The symptom
// lane registers its enqueue as a hook at engine startup, so storing an athlete's own
// sentence exercises the actual production call site.
test("a stored symptom report enqueues its extraction ahead of the backlog", () => {
  const before = pendingEnrichJobsForTests().length;
  const report = repo.recordSymptomReport({
    text: "left knee has been aching on the stairs since Tuesday",
    source_kind: "chat",
  });
  assert.ok(report?.id, "the athlete's words are stored verbatim first");

  const queued = pendingEnrichJobsForTests();
  assert.ok(queued.length > before, "the extraction was queued");
  const at = queued.findIndex((job) => job.kind === "symptom" && job.id === report.id);
  const firstBackground = queued.findIndex((job) => job.kind === "garmin_export");
  assert.ok(at >= 0, "the symptom job is in the queue");
  assert.ok(firstBackground >= 0, "and the Garmin backlog from the previous test is still there");
  assert.ok(at < firstBackground, "it sits ahead of the backlog rather than behind it");
});
