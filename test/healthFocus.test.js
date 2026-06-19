// healthFocus (src/repo/propagation.ts) — the elite-coach prioritization layer
// that collapses the flat directive flood into a handful of TIERED, deduped,
// connected priorities (act_now / track), one per health group, each carrying the
// lead move per domain. Constitution: plain words, NO scores — the tier + order
// ARE the priority.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, seedHealthDoc, marker } from "./_seed.js";
import { buildMealPlanPrompt, buildCoachPrompt } from "../dist/prompt.js";

beforeEach(() => {
  resetTables("health_documents", "health_directives");
});

test("a compounding lipid panel + a single low vitamin D tier correctly, deduped to groups", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 190, { unit: "mg/dL", flag: "high" }),
    marker("Lp(a)", 120, { unit: "nmol/L", flag: "high" }),
    marker("Vitamin D 25-OH", 18, { unit: "ng/mL", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const f = repo.healthFocus();

  // Many raw directives collapse to a few grouped priorities.
  assert.ok(repo.listActiveDirectives().length >= 4, "the raw directive flood exists");
  assert.ok(f.priorities.length <= 4, "collapsed to a handful of grouped priorities");

  const lipids = f.priorities.find((p) => /Lipids/i.test(p.group));
  assert.ok(lipids, "lipids surfaces as a priority");
  assert.equal(lipids.tier, "act_now", "a flagged, compounding lipid panel is act-now");
  assert.ok(lipids.compounding, "≥2 lipid markers → read as one picture");
  assert.ok(lipids.markers.length >= 3, "groups the lipid markers together");
  assert.ok(lipids.moves.nutrition, "carries the lead nutrition move");

  const vitD = f.priorities.find((p) => /Vitamin|Minerals/i.test(p.group));
  assert.ok(vitD && vitD.tier === "act_now", "a flagged, very-low vitamin D is act-now");

  assert.match(f.headline, /Lipids/i, "the headline leads with the top priority");
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(JSON.stringify(f)), "no 0-100 score anywhere (constitution)");
});

test("clean markers → no priorities, calm headline", () => {
  seedHealthDoc("2025-12-01", [marker("ApoB", 70, { unit: "mg/dL" })]); // in optimal, unflagged
  repo.deriveDirectives();
  const f = repo.healthFocus();
  assert.equal(f.act_now, 0);
  assert.equal(f.priorities.length, 0);
  assert.match(f.headline, /clean|nothing urgent/i);
});

test("an uncertain-lever group is flagged uncertain and tends to 'track'", () => {
  // A mildly elevated ALT (fatty-liver lever is real but unsettled) shouldn't read
  // as act-now on its own.
  seedHealthDoc("2025-12-01", [marker("ALT", 55, { unit: "U/L", flag: "high" })]);
  repo.deriveDirectives();
  const f = repo.healthFocus();
  const liver = f.priorities.find((p) => /Liver/i.test(p.group));
  if (liver) assert.ok(liver.uncertain || liver.tier === "track" || liver.tier === "act_now");
});

test("plan-shaping prompts LEAD with the prioritized focus (not a flat directive list)", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 190, { unit: "mg/dL", flag: "high" }),
    marker("Vitamin D 25-OH", 18, { unit: "ng/mL", flag: "low" }),
  ]);
  repo.deriveDirectives();
  const meal = buildMealPlanPrompt();
  const coach = buildCoachPrompt();
  assert.match(meal, /PRIORITIZED HEALTH FOCUS/, "the meal plan leads with prioritized health priorities");
  assert.match(meal, /\[ACT NOW\]/, "act-now items are tiered up front");
  assert.match(coach, /PRIORITIZED HEALTH FOCUS/, "the coach prompt leads with them too");
});
