// Bundled offline "trusted guidelines pack" (src/guidelines.ts) — the OFFLINE FLOOR
// for citations. With this pack a directive note can carry a real, recognized-body
// citation with NO network and research disabled. Invariants:
//   - guidelineFor() resolves the markers the connected brain reasons about
//     (incl. normalized / aliased / expanded names), longest-match-wins
//   - an unknown topic → null
//   - every entry's source URL passes the shared http(s) scheme guard
//   - the pack carries NO numeric scores/grades and NO prescriptive medical-advice
//     phrasing — every statement is descriptive + informational (constitution)
import { test } from "node:test";
import assert from "node:assert/strict";
import { guidelineFor, allGuidelines } from "../dist/guidelines.js";
import { isPlausibleSourceUrl } from "../dist/repo/evidence.js";

test("guidelineFor resolves known markers to a real-sourced entry", () => {
  for (const name of [
    "ApoB",
    "LDL-C",
    "Triglycerides",
    "hs-CRP",
    "HbA1c",
    "Fasting glucose",
    "Ferritin",
    "Vitamin D",
    "eGFR",
    "Lp(a)",
    "Systolic BP",
  ]) {
    const g = guidelineFor(name);
    assert.ok(g, `expected a guideline for ${name}`);
    assert.ok(typeof g.body === "string" && g.body.trim().length > 0, `${name} has a body`);
    assert.ok(typeof g.source === "string" && g.source.trim().length > 0, `${name} names a source`);
    assert.ok(isPlausibleSourceUrl(g.url), `${name} URL passes the http(s) guard: ${g.url}`);
  }
});

test("guidelineFor handles aliased / expanded / case-variant names", () => {
  // marker-canon-style expansions and lab-style names still resolve.
  assert.equal(guidelineFor("Apolipoprotein B (ApoB)")?.key, "apob");
  assert.equal(guidelineFor("25-OH Vitamin D")?.key, "vitamin d");
  assert.equal(guidelineFor("Estimated Glomerular Filtration Rate")?.key, "egfr");
  assert.equal(guidelineFor("Lipoprotein (a)")?.key, "lpa");
  assert.equal(guidelineFor("hemoglobin a1c")?.key, "hba1c");
  // longest-match-wins: "non-hdl" must NOT collapse to the "hdl"/"ldl" family.
  const nonHdl = guidelineFor("Non-HDL-C");
  assert.equal(nonHdl?.key, "non-hdl");
});

test("guidelineFor returns null for unknown / empty topics", () => {
  assert.equal(guidelineFor("zorptForriumQ"), null);
  assert.equal(guidelineFor(""), null);
  assert.equal(guidelineFor("   "), null);
  assert.equal(guidelineFor(null), null);
  assert.equal(guidelineFor(undefined), null);
});

test("every guideline URL passes the http(s) scheme guard", () => {
  const all = allGuidelines();
  assert.ok(all.length >= 8, "the pack should have a handful of entries");
  for (const g of all) {
    assert.ok(isPlausibleSourceUrl(g.url), `bad source URL: ${g.url}`);
    const u = new URL(g.url);
    assert.ok(u.protocol === "https:" || u.protocol === "http:", `non-http(s) scheme: ${g.url}`);
  }
});

test("no scores/grades and no prescriptive medical-advice phrasing", () => {
  const all = allGuidelines();
  // No numeric 0-100 grade anywhere in the body text (the constitution bans scores).
  const scoreLike = /\b(score|grade|\d{1,3}\s*\/\s*100|0-100|out of 100)\b/i;
  // No prescriptive / dosing / individualized-instruction phrasing — these are
  // generic, descriptive statements, never "you should take/start/stop X".
  const prescriptive =
    /\byou should\b|\bwe recommend\b|\btake \d|\bstart taking\b|\bstop taking\b|\bmg\/day\b|\bprescrib/i;
  for (const g of all) {
    // "low-grade" / "high-grade" inflammation is a standard clinical descriptor, NOT
    // a banned 0-100 grade or score — strip that compound before the score-like check.
    const body = g.body.replace(/\b(?:low|high)[- ]grade\b/gi, "");
    assert.ok(!scoreLike.test(body), `score-like phrasing in ${g.key}: ${g.body}`);
    assert.ok(!prescriptive.test(g.body), `prescriptive phrasing in ${g.key}: ${g.body}`);
  }
  // Affirmatively assert a few entries READ as descriptive (defensive: catches a
  // future edit that swaps a sentence for an instruction).
  assert.match(guidelineFor("ApoB").body, /reflects|marker|recognized/i);
  assert.match(guidelineFor("Vitamin D").body, /status|assessed|generally/i);
  assert.match(guidelineFor("eGFR").body, /measure|interpreted|recognized/i);
});
