import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadProposal() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    String,
    fmtWeight: (weight) => `${weight} lb`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/proposal-client.js"), "utf8"), context);
  return context.CairnProposal;
}

test("proposal helper renders escaped status badges", () => {
  const proposal = loadProposal();

  assert.match(proposal.statusBadge("applied"), /mp-badge ok/);
  assert.match(proposal.statusBadge("discarded"), /mp-badge off/);
  assert.match(proposal.statusBadge("superseded"), /mp-badge muted/);
  assert.match(proposal.statusBadge("<draft>"), /&lt;draft&gt;/);
});

test("proposal helper maps apply results honestly", () => {
  const proposal = loadProposal();

  assert.equal(proposal.applyResultMessage(null).failed, true);
  assert.equal(proposal.applyResultMessage(null).message, "Couldn't apply — try again");
  assert.equal(proposal.applyResultMessage({ ok: false, error: "No plan day" }).message, "No plan day");
  assert.equal(proposal.applyResultMessage({ ok: true, clamped: [{}] }).message, "Applied · adjusted to a safe step");
  assert.equal(proposal.applyResultMessage({ ok: true, added: [{}, {}] }).message, "Added 2 movements to your plan");
  assert.equal(proposal.applyResultMessage({ ok: true, restructured: true }).message, "Plan restructured");
  assert.equal(proposal.applyResultMessage({ ok: true }).message, "Applied");
});

test("proposal helper renders clamp and verified transparency", () => {
  const proposal = loadProposal();
  const clamp = proposal.clampNoteHtml([
    { exercise: "Squat <heavy>", requested: 300, applied: 275, reason: "safe <step>" },
  ]);
  const verified = proposal.verifiedBadgeHtml({ checked: true, adjustments: ["protein <floor>"] });

  assert.match(clamp, /adjusted to a safe step/);
  assert.match(clamp, /Squat &lt;heavy&gt;/);
  assert.match(clamp, /safe &lt;step&gt;/);
  assert.match(verified, /Checked against your floors/);
  assert.match(verified, /protein &lt;floor&gt;/);
  assert.equal(proposal.clampNoteHtml([]), "");
  assert.equal(proposal.verifiedBadgeHtml({ checked: false }), "");
});

test("proposal helper renders strength and run prescriptions without Dundefined", () => {
  const proposal = loadProposal();
  const strength = proposal.strengthChangeHtml({
    exercise: "Bench <Press>",
    day_number: 2,
    target_weight: 155,
    rep_low: 5,
    rep_high: 8,
    reason: "earned it",
  });
  const timed = proposal.strengthChangeHtml({ exercise: "Dead hang", target_seconds: 45, note: "hold steady" });

  assert.match(strength, /Day 2/);
  assert.match(strength, /Bench &lt;Press&gt;/);
  assert.match(strength, /155 lb/);
  assert.match(strength, /× 5–8/);
  assert.match(timed, /Dead hang/);
  assert.match(timed, /45s/);
  assert.doesNotMatch(timed, /undefined/);
  assert.equal(proposal.runTargetText({ target_distance_km: 8, target_duration_min: 45, target_zone: "Z2" }), "8 km · 45 min · Z2");
  assert.equal(proposal.runTargetText({}), "run");
});

test("proposal helper classifies open work conservatively", () => {
  const proposal = loadProposal();

  assert.equal(proposal.isOpenProposal({ status: "draft", parsed: { changes: [{}] } }), true);
  assert.equal(proposal.isOpenProposal({ status: "draft", parsed: { cardio: [{}] } }), true);
  assert.equal(proposal.isOpenProposal({ status: "draft", parsed: { days: [{}] } }), true);
  assert.equal(proposal.isOpenProposal({ status: "draft", parsed: { nutrition_target: {} } }), false);
  assert.equal(proposal.isOpenProposal({ status: "applied", parsed: { changes: [{}] } }), false);
});
