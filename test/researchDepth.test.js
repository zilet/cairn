// Research is on by default, and its depth follows need: "auto" runs the fast pass
// and escalates once to the deep pass when no cited claim survives the firewall;
// "fast"/"deep" pin one pass. The offline stub returns no claims, so every pass
// here comes back empty — which is exactly the case that must escalate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { researchEnabled, researchEvidence } from "../dist/research.js";
import { TASK_EXECUTION_PROFILES } from "../dist/repo/settings.js";

test("research is on by default on a fresh install", () => {
  assert.equal(repo.getSettings().research_enabled, true);
  assert.equal(researchEnabled(), true);
});

test("the deep research profile is the deeper model at high effort", () => {
  assert.deepEqual(TASK_EXECUTION_PROFILES.research_deep, { model_class: "deep", reasoning: "high" });
});

test("auto depth escalates a thin fast pass to the deep pass", async () => {
  const r = await researchEvidence("ZTest ferritin lifestyle levers", [], { agent: "stub", force: true });
  assert.equal(r.ok, false);
  assert.equal(r.depth, "deep");
  assert.deepEqual(r.evidence, []);
});

test("a pinned fast pass never escalates", async () => {
  const r = await researchEvidence("ZTest ferritin lifestyle levers", [], { agent: "stub", force: true, depth: "fast" });
  assert.equal(r.ok, false);
  assert.equal(r.depth, "fast");
});

test("turned off, research never reaches an agent", async () => {
  repo.setSettings({ research_enabled: false });
  const r = await researchEvidence("ZTest ferritin lifestyle levers", [], { agent: "stub", force: true });
  assert.equal(r.enabled, false);
  assert.equal(r.depth, undefined);
  assert.equal(r.error, "research disabled");
});
