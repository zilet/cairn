// Bundled, offline evidence pack (src/evidencePack.ts) + its wiring into the health
// review prompt (src/prompt/health.ts). The pack makes cited grounding REACHABLE with
// no web access: each entry maps a guideline the connected brain cites to a one-line
// target/threshold. Two invariants matter — every source must PASS verifyCitation (so a
// directive citing it keeps its citation), and the pack must actually reach the review
// prompt. All offline, no agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./_seed.js";
import { EVIDENCE_PACK, renderEvidencePack } from "../dist/evidencePack.js";
import { buildHealthReviewPrompt } from "../dist/prompt.js";

test("the evidence pack loads and every entry is well-formed", () => {
  assert.ok(Array.isArray(EVIDENCE_PACK) && EVIDENCE_PACK.length >= 8, "a non-trivial pack loads");
  const ids = new Set();
  for (const e of EVIDENCE_PACK) {
    assert.equal(typeof e.id, "string");
    assert.ok(e.id.length, "entry has a stable id");
    assert.ok(!ids.has(e.id), `id ${e.id} is unique`);
    ids.add(e.id);
    assert.equal(typeof e.source, "string");
    assert.ok(e.source.trim().length, "entry names a source");
    assert.ok(Array.isArray(e.markers) && e.markers.length, "entry lists at least one marker");
    assert.ok(e.markers.every((m) => typeof m === "string" && m.length), "markers are labels");
    assert.equal(typeof e.summary, "string");
    assert.ok(e.summary.trim().length, "entry carries a one-line summary");
  }
});

test("every pack source verifies (so a directive citing it keeps its citation offline)", () => {
  for (const e of EVIDENCE_PACK) {
    const v = repo.verifyCitation(e.source);
    assert.equal(v.verified, true, `"${e.source}" is a recognized guideline body`);
    assert.equal(v.uncertain, false, `"${e.source}" is not downgraded to uncertain`);
    assert.ok(v.citation, "the citation string is kept");
  }
});

test("renderEvidencePack renders the whole pack by default, one line per entry", () => {
  const block = renderEvidencePack();
  assert.ok(block.length, "non-empty block");
  assert.equal(block.split("\n").length, EVIDENCE_PACK.length, "one line per entry");
  assert.match(block, /WHO 2020 Ferritin Guideline/);
  assert.match(block, /ACC\/AHA/);
});

test("renderEvidencePack filters to the analytes asked for, and falls back to full when none match", () => {
  const ferritinOnly = renderEvidencePack(["Ferritin"]);
  assert.match(ferritinOnly, /Ferritin/);
  assert.doesNotMatch(ferritinOnly, /ApoB/, "unrelated entries are filtered out");

  const fallback = renderEvidencePack(["Not A Real Marker"]);
  assert.equal(fallback, renderEvidencePack(), "no match → the full pack, never empty");
});

test("buildHealthReviewPrompt threads the bundled evidence in (reachable offline, no grounding passed)", () => {
  const prompt = buildHealthReviewPrompt();
  assert.match(prompt, /BUNDLED EVIDENCE/, "the offline evidence block is present");
  assert.match(prompt, /WHO 2020 Ferritin Guideline/, "a real guideline target is reachable in the prompt");
  assert.match(prompt, /cite them by name/i, "the agent is told it may cite these offline");
});
