import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCorpus, runBenchmark } from "../scripts/benchmark-chat-routing.mjs";

test("adaptive chat routing benchmark corpus is broad and internally valid", () => {
  const corpus = loadCorpus();
  assert.ok(corpus.cases.length >= 60);
  const expectedLanes = new Set(corpus.cases.map((benchmarkCase) => benchmarkCase.expectedLane));
  assert.deepEqual(expectedLanes, new Set(["capture", "coach", "deep"]));
  const categories = new Set(corpus.cases.flatMap((benchmarkCase) => benchmarkCase.requiredReasons));
  for (const category of ["food", "activity", "weight", "supplement", "photo", "current_information", "clinical_safety", "goal_structure", "multi_constraint", "explicit_deep", "explicit_fast", "adversarial"]) {
    assert.ok(categories.has(category), `missing required benchmark category: ${category}`);
  }
  for (const benchmarkCase of corpus.cases) {
    assert.match(benchmarkCase.id, /.+/);
    assert.ok(["capture", "coach", "deep"].includes(benchmarkCase.expectedLane));
    assert.ok(benchmarkCase.requiredReasons.length > 0);
  }
});

test("benchmark harness reports deterministic lane and reason policy misses", () => {
  const corpus = { schemaVersion: 1, cases: [{ id: "one", input: {}, expectedLane: "capture", requiredReasons: ["direct_log", "food"] }] };
  const pass = runBenchmark({ classifier: () => ({ lane: "capture", reason_codes: ["explicit_food_log"] }), corpus });
  assert.equal(pass.failed, 0);
  assert.equal(pass.passed, 1);

  const fail = runBenchmark({ classifier: () => ({ lane: "coach", reason_codes: [] }), corpus });
  assert.equal(fail.failed, 1);
  assert.equal(fail.failures[0].actualLane, "coach");
  assert.deepEqual(fail.failures[0].missingReasons, ["explicit_food_log"]);
});
