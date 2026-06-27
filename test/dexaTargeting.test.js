// DEXA-driven exercise targeting (src/repo/dexa-targeting.ts) — maps the rich
// regional body-scan read (standing.ts body_comp.regional) to concrete TRAINING and
// NUTRITION targets, each with a plain-language "path to move it by the next scan".
// These lock the mappings the coach must get right: low regional BMD → loaded/impact
// work (informational), low ALMI/regional lean → appendicular volume, high
// visceral/trunk fat → Z2 + a lean-safe deficit (nutrition); every target carries a
// path; it's quiet with no DEXA; and — constitution — T/Z-scores stay reference reads,
// never a Cairn-invented 0-100 score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";

const PROFILE = { sex: "male", primary_discipline: "hybrid", endurance_sport: "running" };
const NO_SCORE = (obj, label) => {
  const json = JSON.stringify(obj);
  assert.ok(!/impact_score/.test(json), `${label}: no impact_score leak`);
  assert.ok(!/"score"/.test(json), `${label}: no bare score field`);
  assert.ok(!/\b\d{1,3}\s*\/\s*100\b/.test(json), `${label}: no x/100 grade`);
};

// A rich regional fixture that lights every branch: light lean (low ALMI), low BMD
// (osteopenic T-score), centrally-distributed fat (high visceral), and legs light
// relative to the arms.
function richRegional() {
  return {
    visceral_fat_lbs: 6,
    almi: 6.5,
    ffmi: 18,
    bmd_total: 1.0,
    t_score: -2.0,
    z_score: -1.0,
    android_gynoid: 1.1,
    fat: { trunk: 30, arms: 16, legs: 20 },
    lean: { trunk: 55, arms: 16, legs: 32 },
  };
}

test("dexaTargeting maps a regional fixture to training + nutrition targets, each with a path", () => {
  const r = repo.dexaTargeting({ regional: richRegional(), profile: PROFILE });
  assert.equal(r.available, true);
  assert.ok(r.targets.length >= 2, "multiple targets derived from the scan");
  // every target carries a concrete plain-language "path to next scan".
  assert.ok(r.targets.every((t) => typeof t.path === "string" && t.path.length > 0), "each target has a path");
  // both domains are represented (training + a nutrition route for visceral fat).
  const domains = new Set(r.targets.map((t) => t.domain));
  assert.ok(domains.has("training"), "a training target");
  assert.ok(domains.has("nutrition"), "a nutrition target for central fat");
  // the lead is the single highest-leverage target, with a next-DEXA focus line.
  assert.ok(r.lead, "a lead target is surfaced");
  assert.ok(typeof r.next_dexa_focus === "string" && r.next_dexa_focus.length > 0, "a between-scans focus line");
});

test("dexaTargeting reads low BMD as loaded/impact work, framed as informational", () => {
  const r = repo.dexaTargeting({ regional: richRegional(), profile: PROFILE });
  const bone = r.targets.find((t) => /bone/i.test(t.area));
  assert.ok(bone, "a bone-density target");
  assert.equal(bone.domain, "training");
  assert.equal(bone.informational, true, "BMD guidance is informational, not a diagnosis");
  assert.ok(/clinician/i.test(bone.signal + " " + bone.path), "points back to the clinician");
  assert.ok(bone.moves.length > 0, "concrete loaded/impact moves offered");
});

test("dexaTargeting biases appendicular volume up when lean reads light (low ALMI)", () => {
  const r = repo.dexaTargeting({ regional: richRegional(), profile: PROFILE });
  const lean = r.targets.find((t) => /lean mass/i.test(t.area));
  assert.ok(lean, "a lean-mass target");
  assert.equal(lean.domain, "training");
  // targets bias real, set-counting muscle groups (mobility is non-counting).
  assert.ok(lean.groups.length > 0, "biases concrete muscle groups");
  assert.ok(lean.groups.includes("quads") || lean.groups.includes("hamstrings"), "biases leg/back volume");
});

test("dexaTargeting routes high visceral/central fat to a nutrition Z2 + lean-safe deficit target", () => {
  const r = repo.dexaTargeting({ regional: richRegional(), profile: PROFILE });
  const visc = r.targets.find((t) => /visceral|central fat/i.test(t.area));
  assert.ok(visc, "a visceral/central-fat target");
  assert.equal(visc.domain, "nutrition");
  assert.deepEqual(visc.groups, [], "a nutrition target biases no strength groups");
  assert.ok(/deficit|zone-2|zone 2/i.test(visc.bias + " " + visc.moves.join(" ")), "Z2 + lean-safe deficit");
});

test("dexaTargeting is quiet with no DEXA on record", () => {
  const r = repo.dexaTargeting({ regional: null, profile: PROFILE });
  assert.equal(r.available, false);
  assert.deepEqual(r.targets, []);
  assert.equal(r.lead, null);
});

test("constitution: the DEXA targeting read never leaks a 0-100 score", () => {
  const r = repo.dexaTargeting({ regional: richRegional(), profile: PROFILE });
  NO_SCORE(r, "dexaTargeting");
});
