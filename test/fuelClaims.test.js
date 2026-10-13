// "You're eating under your target" is the fuel read's call. Live (2026-10-13), two CLIs
// read a 21-day intake average against a target set that morning and told a well-fuelled
// athlete to eat closer to target, while the fuel read itself said insufficient_signal.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_seed.js";
import { claimsUnderEating, underEatingSupported, FUEL_CLAIM_RULE } from "../dist/repo/fuel-claims.js";
import { insightVerdict, weeklyReadVerdict } from "../dist/coachOps/memory.js";
import { buildInsightPrompt, buildWeeklyReadPrompt } from "../dist/prompt/day.js";

test("the claims the live runs made are caught; ordinary food talk is not", () => {
  for (const said of [
    "Lately you've also been eating well under your own target, so there's less food coming in.",
    "You've been eating well under your cut target for a few weeks.",
    "Maybe eat closer to your target, with red meat at breakfast.",
    "Your logged meals have come in noticeably lighter than the target you set.",
    "You might be under-fuelling the long runs.",
    "It looks like you're not eating enough on lift days.",
  ]) {
    assert.ok(claimsUnderEating(said), said);
  }
  for (const said of [
    "A lighter dinner works fine tonight.",
    "Your iron stores have dipped with each draw since the trail miles went up.",
    "Protein has been steady around 180 g.",
    "Keep the target where it is; the weight trend is right on pace.",
    "Add lentils to the post-lift breakfast for iron.",
  ]) {
    assert.equal(claimsUnderEating(said), false, said);
  }
});

test("only the read's own short states back the claim", () => {
  for (const state of ["execution_gap", "prescription_strain", "persistent_strain"]) {
    assert.equal(underEatingSupported({ state }), true, state);
  }
  for (const state of ["insufficient_signal", "near_target", "settling", "uncertain"]) {
    assert.equal(underEatingSupported({ state }), false, state);
  }
  assert.equal(underEatingSupported(null), false);
});

const CLAIM = {
  found: true,
  kind: "connection",
  text: "You've been eating well under your cut target, and the lifts are still climbing.",
  rationale: "Recent days averaged well below the intake you set.",
  next_step: "Add a savory breakfast after the lift.",
};

test("an insight claiming under-eating the read does not back is the calm silence", () => {
  const base = { parsed: CLAIM, kind: "insight", keyCorpus: [], recentTexts: [] };
  assert.deepEqual(insightVerdict({ ...base, underEatingSupported: false }), { accept: false, agent_ran: true });
  assert.equal(insightVerdict({ ...base, underEatingSupported: true }).accept, true, "backed by the read, it may be said");
  assert.equal(insightVerdict(base).accept, true, "an unreadable fuel read judges nothing");
  const iron = { ...CLAIM, text: "Your iron stores dipped as the trail miles grew.", rationale: "Ferritin fell each draw.", next_step: "Lentils at breakfast." };
  assert.equal(insightVerdict({ ...base, parsed: iron, underEatingSupported: false }).accept, true);
  assert.deepEqual(weeklyReadVerdict({ parsed: { ...CLAIM }, recentTexts: [], underEatingSupported: false }), {
    accept: false,
    agent_ran: true,
  });
});

test("the prompts that carry intake numbers carry the rule", () => {
  assert.ok(buildInsightPrompt().includes(FUEL_CLAIM_RULE));
  assert.ok(buildWeeklyReadPrompt().includes(FUEL_CLAIM_RULE));
});
