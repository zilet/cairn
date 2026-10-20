import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProposalWithAutonomy, thawParkedReviewDecisions } from "../dist/domain/brain/autonomy-service.js";
import { clinicalAutonomyFromRevision, revisionHoldsClinicalFloor } from "../dist/domain/brain/conference-conflicts.js";
import { CONFERENCE_FLOOR_REREAD_VERSION } from "../dist/domain/brain/thaw-rereads.js";
import { repo } from "./_seed.js";

// Live (2026-10-19, brain_decisions 27824): the weekly review's "advance the upper lifts,
// hold Tuesday's legs, taper the runs" sat at tier `clinician`, review_reason_code
// `clinical_ceiling`. Not the settled flank pain its rationale mentions, and not a
// specialist's ceiling: the act-now marker list carried "Fat Mass (Total)" and "Lean Mass
// (Total)", whose qualifier "(Total)" became a marker term of its own — and the threshold
// run's note said "7.5–8.0 km total". A qualifier is never a marker's name.

const ACT_NOW = {
  clinicalAttention: true,
  clinicalLever: false,
  clinicalLevers: [],
  clinicalMarkers: [
    "Total Cholesterol",
    "LDL-C",
    "Apolipoprotein B (ApoB)",
    "LDL-C (Direct)",
    "Fat Mass (Total)",
    "Lean Mass (Total)",
    "Visceral Fat",
  ],
};

const TAPER_REVISION = {
  type: "plan_update",
  summary: "Advance the moving upper lifts, hold Tuesday's leg loads, and set the stated run days to taper week 1.",
  changes: [
    { day_number: 1, exercise: "Barbell Bench Press", target_weight: 140, sets: 3, rep_low: 8, rep_high: 8 },
    {
      day_number: 2,
      exercise: "Back Squat",
      target_weight: 155,
      reason: "Hold at 155 lb. The right-lateral flank pain that settled on Sep 28 does not change any load.",
    },
    {
      kind: "cardio",
      day_number: 4,
      exercise: "Threshold run",
      note: "3.5–4.0 km of threshold work inside 7.5–8.0 km total with an easy warm-up and cool-down. Direct effort, not a race.",
    },
  ],
};

test("a qualifier alias ('Total', 'Direct') is not a marker name: a taper week is not clinical", () => {
  assert.equal(clinicalAutonomyFromRevision(ACT_NOW, TAPER_REVISION), false);
  assert.equal(revisionHoldsClinicalFloor(ACT_NOW, TAPER_REVISION), false, "nor is a settled pain mention");
});

test("a revision that names an act-now marker still holds the floor", () => {
  const naming = (words) => ({ ...TAPER_REVISION, changes: [{ ...TAPER_REVISION.changes[0], reason: words }] });
  assert.equal(clinicalAutonomyFromRevision(ACT_NOW, naming("Watch ApoB before adding load.")), true, "an abbreviation alias");
  assert.equal(clinicalAutonomyFromRevision(ACT_NOW, naming("Total cholesterol is the reason.")), true, "a full name");
  assert.equal(clinicalAutonomyFromRevision(ACT_NOW, naming("Protect lean mass while cutting.")), true, "a bare name");
  assert.equal(revisionHoldsClinicalFloor(ACT_NOW, naming("Start the 10 mg medication first.")), true, "clinical words");
});

test("a row an older rule put on the floor for a bare 'total' is re-read once more and re-offered", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Push A", "Chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 8, target_weight: 135 },
  ]);
  const proposal = repo.createProposal("case_conference", "case conference: weekly team review", "", {
    summary: TAPER_REVISION.summary,
    changes: [
      { day_number: 1, exercise: "Barbell Bench Press", target_weight: 140, reason: "Next press step." },
      { kind: "cardio", day_number: 4, exercise: "Threshold run", note: "Inside 7.5–8.0 km total." },
    ],
  });
  const held = applyProposalWithAutonomy(Number(proposal.id), { clinical: true });
  assert.equal(held.tier, "clinician");
  // The 27824 state: conference-marked, and already re-read once by the v1 rule.
  repo.patchBrainDecision(Number(held.decision.id), {
    source: "case_conference",
    context: {
      ...held.decision.context,
      deterministic_clinical: true,
      unresolved_conflicts: ["clinical_autonomy"],
      floor_reread: { version: 1, at: "2026-10-19T00:12:37.812Z", clinical: true },
    },
  });
  assert.ok(CONFERENCE_FLOOR_REREAD_VERSION >= 2);

  const thaw = thawParkedReviewDecisions("lead", { conflictInputs: () => ACT_NOW });
  assert.equal(thaw.thawed, 1);
  const reread = repo.getBrainDecision(Number(held.decision.id));
  assert.equal(reread.context.floor_reread.clinical, false, "a body-composition 'total' governs no bench step");
  assert.equal(reread.context.floor_reread.version, CONFERENCE_FLOOR_REREAD_VERSION);
  assert.notEqual(reread.autonomy_tier, "clinician");
  assert.equal(repo.awaitingBrainDecisions().filter((row) => !row.for_clinician).length, 0, "nothing waits on a clinician");
});
