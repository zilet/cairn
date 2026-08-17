// A PENDING CHANGE IS JUDGED AGAINST THE EVIDENCE IN FORCE ON THE DAY IT APPLIES.
//
// A nutrition target never lands the moment it is decided — it waits for a natural
// food-day boundary so a partly-lived day is never changed underneath the athlete.
// Live, that wait is where a ratchet hid: each step was bounded and each step was
// judged against the step before it, and nothing re-asked whether the destination was
// still somewhere the record supported. The target walked past measured maintenance
// with a further raise to 2,800 already queued and waiting for its boundary.
//
// So the boundary pass re-derives the cut anchor and re-applies the same law the
// check-in does (capProtectiveRaise: protection buys maintenance, never a surplus).
// A raise the evidence has outrun entirely is SET ASIDE with a receipt; a raise that
// merely overshoots lands at maintenance instead, and the ledger says so.
//
// Two things that law leans on are pinned here as hard as the law itself, because a
// review found the live system failing both while the law looked like it held:
//   - MEASURED maintenance is the only maintenance that can lift the ceiling. On a
//     record too thin to ground, the anchor still reports a number — the formula
//     prior — and reading it as headroom is what let the raise land anyway.
//   - A refusal is not an error, and a four-calorie "change" is not a change.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { repo, resetTables, localDaysAgo } from "./_seed.js";
import { applyDueAnnouncedDecisions, applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
import { localDateISO } from "../dist/repo/shared.js";

// The live athlete's shape: mid-cut, a goal below the current weight, and no open
// goal check-in — so cutReaffirmation reads the cut as the athlete's own.
function seedReaffirmedCut() {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 168,
    start_weight_lb: 183,
    start_date: localDaysAgo(60),
    goal_mode: "lose",
    goal_weight_lb: 164,
  });
}

// The record that makes the energy-balance read admissible: complete logged days
// (morning food AND evening food) across the trailing window, plus a weigh-in habit.
// Without it `deriveCutTarget` falls back to the Mifflin prior, which is a different
// test — see "a formula prior is not headroom" below.
function seedGroundedRecord() {
  for (let i = 1; i <= 20; i++) {
    repo.addFoodNote("breakfast", "", { kcal: 700, protein_g: 50 }, undefined, { date: localDaysAgo(i) });
    repo.addFoodNote("dinner", "", { kcal: 1_100, protein_g: 60 }, undefined, { date: localDaysAgo(i) });
    if (i % 2 === 0) repo.logWeight(168 + i * 0.05, localDaysAgo(i));
  }
}

// `extra` carries the provenance a real check-in draft is stamped with
// (personalizeNutritionCheckinTarget): the target it measured its step from, and the
// step it believed it was taking. Both describe the day the draft was WRITTEN.
function targetProposal(instruction, kcal, extra = {}) {
  return repo.createProposal("stub", instruction, "", {
    kind: "nutrition_target",
    summary: `A protective step to ${kcal} kcal while endurance load is heavy`,
    nutrition: {
      target_kcal: kcal,
      protein_g: 175,
      reason: "Recent endurance load reads as under-fuelled.",
      ...extra,
    },
  });
}

const activeKcal = () => Number(repo.getActiveNutritionTarget()?.target_kcal);

beforeEach(() => {
  resetTables(
    "profile",
    "nutrition_targets",
    "plan_proposals",
    "brain_decisions",
    "brain_expectations",
    "attention_schedule",
    "journey_phases",
    "bodyweight_log",
    "app_state",
    "food_notes"
  );
});

test("a raise the record has outrun by its boundary is set aside, not applied", () => {
  seedReaffirmedCut();
  seedGroundedRecord();
  const anchor = repo.deriveCutTarget(localDateISO());
  assert.equal(anchor.tdee_basis, "logged_reality", "the fixture grounds the anchor in the record");
  assert.ok(anchor, "the fixture derives a cut anchor");
  // The end of the live ratchet: the target already in force sits ABOVE measured
  // maintenance, and one more bounded step is queued behind it.
  const inForce = anchor.tdee_kcal + 350;
  repo.setNutritionTarget({ target_kcal: inForce, protein_g: 175, source: "checkin" });
  const proposal = targetProposal("one more protective step", inForce + 200);

  const scheduled = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(scheduled.pending, true, "nutrition always waits for a food-day boundary");
  assert.equal(activeKcal(), inForce, "and nothing moved when it was decided");

  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, [], "the boundary applied nothing");
  assert.deepEqual(due.set_aside, [scheduled.decision.id], "the waiting decision reached a terminal state");
  assert.deepEqual(due.failed, [], "and a refusal is never reported as a failure — nothing here went wrong");
  assert.equal(activeKcal(), inForce, "the target in force is untouched");
  assert.equal(repo.getProposal(proposal.id).status, "superseded", "and the draft is retired, not left to re-offer");

  // The receipt: a ledger row the athlete can read, saying what was set aside and why.
  const receipt = repo
    .listBrainDecisions({ kind: "nutrition_target", limit: 20 })
    .find((decision) => decision.context?.boundary_revalidation_receipt === true);
  assert.ok(receipt, "a set-aside receipt was recorded");
  assert.equal(receipt.status, "superseded");
  assert.equal(receipt.context.proposed_kcal, inForce + 200);
  assert.equal(receipt.context.ceiling_kcal, inForce, "capped to the number already in force, never below it");
  assert.match(receipt.rationale, /maintenance/i, "and it says why in the athlete's register");
  assert.equal(receipt.effective_date, scheduled.effective_date, "filed under the day the pass judged, not today");

  // ONE row, not two: the supersede that retires the draft must not file a second,
  // vaguer entry beside the receipt that already explains it.
  const rows = repo
    .listBrainDecisions({ kind: "nutrition_target", limit: 20 })
    .filter((decision) => String(decision.source_ref_key) === String(proposal.id) && decision.status === "superseded");
  assert.equal(rows.length, 1, `one superseded row for this draft, got ${rows.length}`);

  const waiting = repo.getBrainDecision(scheduled.decision.id);
  assert.equal(waiting.status, "canceled", "the pending decision no longer waits");
  assert.equal(waiting.context.boundary_revalidation.outcome, "set_aside");
});

test("a raise that merely overshoots lands at maintenance, and the ledger says so", () => {
  seedReaffirmedCut();
  seedGroundedRecord();
  const anchor = repo.deriveCutTarget(localDateISO());
  assert.ok(anchor);
  assert.equal(anchor.tdee_basis, "logged_reality");
  // Below maintenance now, so protection genuinely has room — and enough of it that
  // what survives the cap is a real step rather than a rounding remnant.
  const inForce = anchor.tdee_kcal - 150;
  repo.setNutritionTarget({ target_kcal: inForce, protein_g: 175, source: "checkin" });
  const proposal = targetProposal("a protective step that overshoots", inForce + 200, {
    prev_target_kcal: inForce,
    delta_kcal: 200,
  });

  const scheduled = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(scheduled.pending, true);

  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, [scheduled.decision.id], "the reduced change still lands");
  assert.equal(activeKcal(), anchor.tdee_kcal, "at maintenance, not at the number the draft carried");

  const landed = repo.getBrainDecision(scheduled.decision.id);
  assert.equal(landed.status, "applied");
  assert.equal(landed.context.boundary_revalidation.outcome, "reduced");
  assert.equal(landed.context.boundary_revalidation.from_kcal, inForce + 200);
  assert.equal(landed.context.boundary_revalidation.to_kcal, anchor.tdee_kcal);

  // NO PROSE ON THE APPLIED ROW MAY QUOTE A NUMBER THAT NEVER HAPPENED. The draft
  // wrote its summary AND its reason about the kcal it asked for; a row whose headline
  // says one number and whose reason underneath says another reads as two different
  // changes, which is worse than either mistake alone. Every athlete-or-operator
  // readable string on this decision, plus the stored target note, is checked together.
  const asked = String(inForce + 200);
  const landedKcal = String(anchor.tdee_kcal);
  const storedTarget = repo.getActiveNutritionTarget();
  for (const [field, text] of [
    ["summary", landed.summary],
    ["rationale", landed.rationale],
    ["nutrition_targets.note", storedTarget.note],
  ]) {
    assert.ok(text, `${field} is present`);
    assert.ok(!String(text).includes(asked), `${field} quotes the un-applied ${asked}: ${text}`);
    assert.ok(String(text).includes(landedKcal), `${field} should name the ${landedKcal} that landed: ${text}`);
  }
  // The asked-for number survives in exactly one place: the STRUCTURED revalidation
  // receipt, which is an audit trail rather than a sentence claiming anything, and on
  // the plan_proposals row that still holds the draft's original wording.
  assert.equal(landed.context.boundary_revalidation.from_kcal, inForce + 200);
  assert.match(repo.getProposal(proposal.id).parsed.nutrition.reason, /under-fuelled/, "the draft keeps its own words");

  // The prediction this change is judged against is built on the move that happened.
  const [expectation] = repo.listBrainExpectations({ decisionId: scheduled.decision.id });
  assert.ok(expectation, "the applied change carries a falsifiable expectation");
  assert.equal(
    expectation.baseline.target_delta_kcal,
    anchor.tdee_kcal - inForce,
    "the baseline delta is the step that actually landed, not the one the draft asked for"
  );
});

test("a raise the evidence still supports crosses its boundary untouched", () => {
  seedReaffirmedCut();
  seedGroundedRecord();
  const anchor = repo.deriveCutTarget(localDateISO());
  assert.ok(anchor);
  assert.equal(anchor.tdee_basis, "logged_reality");
  const inForce = anchor.tdee_kcal - 500;
  repo.setNutritionTarget({ target_kcal: inForce, protein_g: 175, source: "checkin" });
  const proposal = targetProposal("a step well inside maintenance", inForce + 200);

  const scheduled = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, [scheduled.decision.id]);
  assert.equal(activeKcal(), inForce + 200, "exactly the reviewed number");
  assert.equal(
    repo.getBrainDecision(scheduled.decision.id).context.boundary_revalidation,
    undefined,
    "and no revalidation receipt is stamped when nothing needed re-clamping"
  );
});

test("with no reaffirmed cut there is no maintenance to cap against, and the change lands as decided", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.55,
    weight_lb: 168,
    goal_mode: "maintain",
    goal_weight_lb: null,
  });
  repo.setNutritionTarget({ target_kcal: 2_600, protein_g: 175, source: "checkin" });
  const proposal = targetProposal("a step with no cut behind it", 2_800);

  const scheduled = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, [scheduled.decision.id]);
  assert.equal(activeKcal(), 2_800, "the boundary cap is a cut rule, and this is not a cut");
});

// ---- a formula prior is not headroom -----------------------------------------
//
// The reviewer's reproduction of the LIVE failure, and the reason the law above was
// not actually holding. With meals logged only at the front of the day, grounding
// fails and the anchor reports the Mifflin prior instead — a number derived from
// height, weight and an activity factor, which knows nothing whatsoever about what
// this athlete eats. The cap read it as measured maintenance, found 2,898 kcal of
// headroom above the 2,600 in force, and waved the queued 2,800 straight through.

test("a formula prior is not headroom — a raise is held on an unmeasured maintenance", () => {
  seedReaffirmedCut();
  // Breakfast-only days: every day observed, no day complete, so the grounding floor
  // sees no admissible intake evidence at all.
  for (let i = 1; i <= 28; i++) {
    repo.addFoodNote("breakfast", "", { kcal: 700, protein_g: 50 }, undefined, { date: localDaysAgo(i) });
    if (i % 2 === 0) repo.logWeight(168 + i * 0.05, localDaysAgo(i));
  }
  const anchor = repo.deriveCutTarget(localDateISO());
  assert.equal(anchor.tdee_basis, "formula_estimate", "the fixture reproduces the ungrounded anchor");
  assert.ok(anchor.tdee_kcal > 2_600, `the prior sits above the target in force (${anchor.tdee_kcal})`);

  repo.setNutritionTarget({ target_kcal: 2_600, protein_g: 175, source: "checkin" });
  const proposal = targetProposal("one more protective step", 2_800);
  const scheduled = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  const due = applyDueAnnouncedDecisions(scheduled.effective_date);

  assert.deepEqual(due.applied, [], "the raise does not land on a maintenance nobody measured");
  assert.deepEqual(due.set_aside, [scheduled.decision.id]);
  assert.equal(activeKcal(), 2_600, "the target in force is held, not raised and not cut");
});

// ---- a four-calorie change is not a change -----------------------------------

test("a cap that leaves less than one step behind sets the change aside instead", () => {
  seedReaffirmedCut();
  seedGroundedRecord();
  const anchor = repo.deriveCutTarget(localDateISO());
  assert.equal(anchor.tdee_basis, "logged_reality");
  // Four calories of headroom. Applying it would write a nutrition_targets row, spend
  // the week's nutrition budget and open a follow-through window, for a number nobody
  // could feel — which is exactly what the live pass was doing.
  const inForce = anchor.tdee_kcal - 4;
  repo.setNutritionTarget({ target_kcal: inForce, protein_g: 175, source: "checkin" });
  const proposal = targetProposal("a protective step with nowhere to go", inForce + 200);

  const scheduled = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  const due = applyDueAnnouncedDecisions(scheduled.effective_date);
  assert.deepEqual(due.applied, []);
  assert.deepEqual(due.set_aside, [scheduled.decision.id]);
  assert.equal(activeKcal(), inForce, "the target did not move");
});

// ---- the re-clamp reads the number actually in force -------------------------
//
// A review-due target is NOT the intake in force. Once its adaptive window elapses
// `getActiveNutritionTarget` returns null AND `computeGoalCheck().effective_target`
// falls back to the formula — so the formula is what the athlete is now eating to,
// and the stale accepted row is history. The boundary has to see the same number the
// check-in seam sees, in the same precedence order, or the clamp's floor lands BELOW
// what is in force and "the raise isn't supported" quietly becomes a cut.

test("a review-due target is not the number in force — the boundary reads the effective one", () => {
  repo.setSettings({ lead_mode: "lead" });
  // The stale row was accepted when the athlete was lighter and less active.
  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.2,
    weight_lb: 150,
    start_weight_lb: 160,
    start_date: localDaysAgo(120),
    goal_mode: "lose",
    goal_weight_lb: 145,
  });
  const staleKcal = 1_500;
  repo.setNutritionTarget({
    target_kcal: staleKcal,
    protein_g: 150,
    source: "checkin",
    effective_date: localDaysAgo(60),
  });
  // They are much heavier and more active now, so the formula target has risen well
  // above that stale row — and their logged record puts measured maintenance BELOW it.
  repo.setProfile({
    age: 40,
    height_cm: 178,
    sex: "male",
    activity_factor: 1.725,
    weight_lb: 215,
    start_weight_lb: 230,
    start_date: localDaysAgo(120),
    goal_mode: "lose",
    goal_weight_lb: 200,
  });
  for (let i = 1; i <= 28; i++) {
    repo.addFoodNote("breakfast", "", { kcal: 800, protein_g: 60 }, undefined, { date: localDaysAgo(i) });
    repo.addFoodNote("dinner", "", { kcal: 1_050, protein_g: 80 }, undefined, { date: localDaysAgo(i) });
    if (i % 2 === 0) repo.logWeight(215, localDaysAgo(i));
  }

  assert.equal(repo.getActiveNutritionTarget(), null, "the stale row is genuinely past its review window");
  assert.equal(Number(repo.getLatestNutritionTarget()?.target_kcal), staleKcal);
  const effective = Number(repo.computeGoalCheck()?.effective_target?.target_kcal);
  const anchor = repo.deriveCutTarget(localDateISO());
  assert.equal(anchor.tdee_basis, "logged_reality");
  assert.ok(
    effective > staleKcal && effective > anchor.tdee_kcal,
    `the fixture needs the formula in force (${effective}) above both the stale row and maintenance (${anchor.tdee_kcal})`
  );

  const proposed = effective + 250;
  const proposal = targetProposal("a protective step measured from the formula in force", proposed, {
    prev_target_kcal: effective,
    delta_kcal: 250,
  });
  const scheduled = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  const due = applyDueAnnouncedDecisions(scheduled.effective_date);

  // Reading the STALE row as `previous` put the ceiling at measured maintenance, which
  // sits below the formula in force — so a proposal that only ever asked to ADD landed
  // as a cut. The clamp may hold the athlete where they are; it may never move them down.
  assert.deepEqual(due.applied, [], "nothing lands");
  assert.deepEqual(due.set_aside, [scheduled.decision.id], "the raise is refused, with a receipt");
  const after = repo.getActiveNutritionTarget() ?? repo.getLatestNutritionTarget();
  assert.equal(Number(after?.target_kcal), staleKcal, "no new target row was written at all");
  assert.equal(
    Number(repo.computeGoalCheck()?.effective_target?.target_kcal),
    effective,
    "and the number the athlete actually eats to is untouched — a refused raise is never a cut"
  );
});
