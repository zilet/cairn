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
    stagger: (index) => `--i:${index}`,
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
  assert.equal(
    proposal.runTargetText({ target_distance_km: 8, target_duration_min: 45, target_zone: "Z2" }),
    "8 km · 45 min · Z2"
  );
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

test("proposal helper renders Coach proposal list with actions, folds, and escaping", () => {
  const proposal = loadProposal();
  const html = proposal.coachProposalListHtml(
    [
      {
        id: "draft<1>",
        status: "draft",
        agent: "coach<script>",
        created_at: "now",
        parsed: {
          summary: "Push <carefully>",
          changes: [{ exercise: "Bench <Press>", day_number: 2, target_weight: 155, reason: "earned <it>" }],
          cardio: [
            { day_number: 3, label: "Easy <run>", target_distance_km: 5, target_zone: "Z2", reason: "base <work>" },
          ],
          notes: "Hold <form>",
        },
      },
      {
        id: 2,
        status: "applied",
        agent: "stub",
        created_at: "later",
        parsed: { summary: "Done" },
      },
      {
        id: 3,
        status: "discarded",
        agent: "stub",
        created_at: "earlier",
        raw_output: "<bad json>",
      },
    ],
    {
      2: [{ exercise: "Squat <heavy>", requested: 300, applied: 275, reason: "safe <step>" }],
    }
  );

  assert.match(html, /data-apply="draft&lt;1&gt;"/);
  assert.match(html, /data-discard="draft&lt;1&gt;"/);
  assert.match(html, /coach&lt;script&gt;/);
  assert.match(html, /Push &lt;carefully&gt;/);
  assert.match(html, /Bench &lt;Press&gt;/);
  assert.match(html, /D3 Easy &lt;run&gt;/);
  assert.match(html, /Applied to your plan/);
  assert.match(html, /Squat &lt;heavy&gt;/);
  assert.match(html, /Show earlier proposals \(1\)/);
  assert.doesNotMatch(html, /coach<script>|Push <carefully>|<bad json>/);
});

test("proposal helper renders Coach proposal empty state", () => {
  const proposal = loadProposal();

  assert.match(proposal.coachProposalListHtml([]), /No program decisions yet/);
  assert.match(proposal.coachProposalListHtml(null), /adapt bounded details in the background/);
});

test("proposal helper treats an autonomy-scheduled draft as upcoming, not Apply work", () => {
  const proposal = loadProposal();
  const html = proposal.coachProposalCardHtml(
    {
      id: 9,
      status: "draft",
      agent: "team",
      parsed: { summary: "A lighter week", days: [{ day_number: 1 }] },
      autonomy: { status: "announced", effective_date: "2026-07-13" },
    },
    0
  );
  assert.match(html, /Scheduled for 2026-07-13/);
  assert.doesNotMatch(html, /data-apply/);
});

test("an autonomy-owned draft chip reads the scheduled truth, not a dead DRAFT", () => {
  const proposal = loadProposal();
  const announced = proposal.coachProposalCardHtml(
    {
      id: 9,
      status: "draft",
      agent: "team",
      parsed: { summary: "A bounded change", changes: [{ exercise: "Bench", target_weight: 155 }] },
      autonomy: { status: "pending", effective_date: "2026-07-14" },
    },
    0
  );
  // Sage-toned scheduled chip (the accepted/applied family), never the draft chip, and no Apply.
  assert.match(announced, /mp-badge ok">LANDS 2026-07-14/);
  assert.doesNotMatch(announced, /mp-badge draft/);
  assert.doesNotMatch(announced, /data-apply/);

  // An autonomy-owned draft with no effective_date falls back to a plain SCHEDULED chip.
  const noDate = proposal.coachProposalCardHtml(
    {
      id: 10,
      status: "draft",
      agent: "team",
      parsed: { summary: "A bounded change", changes: [{ exercise: "Bench", target_weight: 155 }] },
      autonomy: { status: "pending", effective_date: null },
    },
    0
  );
  assert.match(noDate, /mp-badge ok">SCHEDULED/);
  assert.doesNotMatch(noDate, /mp-badge draft/);
});

test("a plain draft still renders a DRAFT chip and an Apply button", () => {
  const proposal = loadProposal();
  const html = proposal.coachProposalCardHtml(
    {
      id: 11,
      status: "draft",
      agent: "team",
      parsed: { summary: "A bounded change", changes: [{ exercise: "Bench", target_weight: 155 }] },
      autonomy: null,
    },
    0
  );
  assert.match(html, /mp-badge draft">draft/);
  assert.match(html, /data-apply="11"/);
  assert.doesNotMatch(html, /LANDS|SCHEDULED/);
});
