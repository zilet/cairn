// The dangling reaction_model_narrative slot, now wired end-to-end. The
// deterministic reaction-model (src/repo/reaction-model.ts) produces the PATTERNS;
// this covers the NARRATIVE written over them:
//   - repo.setReactionNarrative: trim / collapse / cap(600) / clear round-trip
//   - repo.saveReactionModel: every deterministic rebuild CLEARS prose tied to
//     the prior evidence set, whether or not the rebuilt model has patterns
//   - coachOps.refreshReactionNarrative: skip-on-empty (no agent call), success via
//     an INJECTED fake runner, and a wrong-shape reply (the real offline `stub`)
//     degrading to a no-op that leaves the prior narrative intact
//   - reactionModelForCoach surfaces the stored narrative on the CACHE path
// Deterministic + offline (the stub is `sh` printf — no network, no coaching CLI),
// full-DB wiped before each test by the harness (test/_isolate.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, localDaysAgo } from "./_seed.js";
import { refreshReactionNarrative } from "../dist/coachOps.js";

// Read the raw stored narrative value ("" when cleared, "" when absent).
function storedNarrative() {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = 'reaction_model_narrative'`).get();
  return row ? row.value : "";
}

// Fresh synced sleep silences the FIRST-CLASS data_gap pattern; with nothing else
// seeded the reaction model then has ZERO patterns (the "emptied model" case).
function seedFreshSleep() {
  repo.recordDailyMetrics("apple", localDaysAgo(0), { sleep_min: 430 });
  repo.recordDailyMetrics("apple", localDaysAgo(1), { sleep_min: 425 });
}

// ---------------------------------------------------------------------------
// repo.setReactionNarrative — trim / collapse / cap / clear
// ---------------------------------------------------------------------------
test("setReactionNarrative trims + collapses whitespace and round-trips", () => {
  repo.setReactionNarrative("  hello   world  ");
  assert.equal(storedNarrative(), "hello world");
});

test("setReactionNarrative caps the stored text at 600 chars", () => {
  repo.setReactionNarrative("x".repeat(1000));
  assert.equal(storedNarrative().length, 600);
});

test("setReactionNarrative(null) and (\"\") clear the slot", () => {
  repo.setReactionNarrative("something worth clearing");
  assert.ok(storedNarrative().length > 0);
  repo.setReactionNarrative(null);
  assert.equal(storedNarrative(), "");
  repo.setReactionNarrative("again");
  repo.setReactionNarrative("");
  assert.equal(storedNarrative(), "");
});

// ---------------------------------------------------------------------------
// repo.saveReactionModel — every deterministic rebuild invalidates prose
// ---------------------------------------------------------------------------
test("saveReactionModel CLEARS a stale narrative when the rebuilt model is empty", () => {
  seedFreshSleep(); // data_gap silent → no other seed → ZERO patterns
  repo.setReactionNarrative("a stale read of patterns that no longer hold");
  repo.saveReactionModel();
  assert.equal(storedNarrative(), "", "an emptied model clears its narrative");
  // And the cache read surfaces null (not an empty string) for the public contract.
  const read = repo.reactionModelForCoach();
  assert.equal(read.source, "cache");
  assert.equal(read.patterns.length, 0);
  assert.equal(read.narrative, null);
});

test("saveReactionModel CLEARS stale narrative even when the rebuilt model has patterns", () => {
  // Empty DB → the data_gap pattern fires (no synced recovery) → non-empty model.
  repo.setReactionNarrative("this prose describes the prior evidence set");
  repo.saveReactionModel();
  assert.equal(storedNarrative(), "");
  const read = repo.reactionModelForCoach();
  assert.ok(read.patterns.length >= 1, "expected at least the data_gap pattern");
  assert.equal(read.narrative, null);
});

// ---------------------------------------------------------------------------
// coachOps.refreshReactionNarrative — skip / success / degrade
// ---------------------------------------------------------------------------
test("refreshReactionNarrative SKIPS the agent when the model has no patterns", async () => {
  seedFreshSleep(); // → ZERO patterns
  let called = false;
  const spyRun = async () => { called = true; return { agent: "fake", result: { parsed: null }, tried: [] }; };
  const out = await refreshReactionNarrative(undefined, undefined, { run: spyRun });
  assert.equal(out.ok, true);
  assert.equal(out.skipped, true);
  assert.equal(called, false, "no agent call when there is nothing to narrate");
});

test("refreshReactionNarrative writes the narrative on a valid agent reply (injected runner)", async () => {
  // Empty DB → data_gap pattern exists → the op proceeds to the agent.
  const fakeRun = async (_agent, prompt, opts) => {
    assert.equal(opts.op, "reaction_narrative", "the run is labeled for telemetry/routing");
    assert.match(prompt, /HOW THIS USER'S BODY TENDS TO RESPOND/, "the reaction-narrative prompt is used");
    assert.match(prompt, /No synced sleep|recovery signal/i, "the model's patterns are folded into the prompt");
    return { agent: "fake", result: { parsed: { narrative: "  You tend to lean on how you feel when recovery data goes quiet.  " }, raw: "{}" }, tried: [] };
  };
  const out = await refreshReactionNarrative("auto", undefined, { run: fakeRun });
  assert.equal(out.ok, true);
  assert.equal(out.agent, "fake");
  assert.match(out.narrative, /lean on how you feel/);
  assert.equal(storedNarrative(), out.narrative, "the narrative is persisted (trimmed)");
});

test("refreshReactionNarrative degrades on a wrong-shape reply and leaves the prior narrative intact", async () => {
  // The offline `stub` agent returns a plan-proposal shape ({summary,changes,notes})
  // — no `narrative` field — so this exercises the real runChosen degrade path.
  repo.saveReactionModel(); // cache + the data_gap pattern
  repo.setReactionNarrative("Your prior narrative that must survive a bad run.");
  const out = await refreshReactionNarrative("stub");
  assert.equal(out.ok, false);
  assert.match(out.error, /no usable narrative/);
  const read = repo.reactionModelForCoach();
  assert.equal(read.source, "cache");
  assert.equal(read.narrative, "Your prior narrative that must survive a bad run.");
});

// ---------------------------------------------------------------------------
// reactionModelForCoach — the stored narrative on the cache path
// ---------------------------------------------------------------------------
test("reactionModelForCoach returns the stored narrative on the cache path", () => {
  repo.saveReactionModel(); // writes the reaction_model cache
  repo.setReactionNarrative("A calm read of how your body tends to respond.");
  const read = repo.reactionModelForCoach();
  assert.equal(read.source, "cache");
  assert.equal(read.narrative, "A calm read of how your body tends to respond.");
});
