// The grounded cut target (src/repo/cut-target.ts) — maintenance derived from the
// athlete's OWN logged intake and weight trend, a bounded deficit on top of it,
// and a goal date that moves rather than a pace that crashes.
//
// Constitution-critical properties pinned here:
//   - absent data never PARKS the derivation; it lowers confidence and says so;
//   - a physiologically implausible outcome is clamped, not obeyed;
//   - the deficit ceiling is what a too-soon goal date runs into, so the DATE
//     adapts and the pace never does;
//   - a safety (leanness) ceiling only ever narrows the pace band, never widens it;
//   - while a cut the athlete has affirmed is running, the system does not
//     volunteer a diet break on a calendar;
//   - every athlete-facing sentence passes the shared reading grammar.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { localDaysAgo, repo, resetTables } from "./_seed.js";
import { violatesReadingGrammar } from "../dist/repo/day-read.js";
import {
  CUT_DEFICIT_MAX_KCAL,
  CUT_DEFICIT_MIN_KCAL,
  CUT_PACE_MAX_PCT,
  GROUNDED_MIN_INTAKE_DAYS,
  GROUNDED_MIN_SPAN_DAYS,
  GROUNDED_MIN_WEIGH_INS,
  cutEvidenceIsGrounded,
  cutReaffirmation,
  cutTargetBody,
  cutTargetDecision,
  cutTargetGrammarPool,
  mayProposeEaseFromCut,
} from "../dist/repo/cut-target.js";

const TODAY = "2026-08-17";

function addDaysISO(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// The shape this derivation is built for: mid-cut at 168 lb with 164 as the goal, and a record
// thick enough for the energy-balance read to lead.
function grounded(extra = {}) {
  return {
    today: TODAY,
    weight_lb: 168,
    goal_weight_lb: 164,
    goal_date: null,
    body_fat_pct: null,
    outcome_tdee: 2_800,
    prior_tdee: 2_600,
    plausible_tdee_min: 1_500,
    plausible_tdee_max: 4_200,
    coverage: { window_days: 28, intake_days: 22, weigh_ins: 10, weigh_in_span_days: 26 },
    protein_floor_g: 175,
    ...extra,
  };
}

beforeEach(() => {
  resetTables("profile", "attention_schedule", "journey_phases", "bodyweight_log", "garmin_daily_metrics");
});

// ---- rule 1: maintenance comes off the record when the record supports it ----

test("a thick record makes the energy-balance outcome the maintenance estimate", () => {
  const out = cutTargetDecision(grounded());
  assert.ok(out, "a derivation is produced");
  assert.equal(out.tdee_basis, "logged_reality");
  assert.equal(out.tdee_kcal, 2_800, "the outcome anchor, not the prior");
  assert.equal(out.confidence, "high");
  assert.equal(out.target_kcal, 2_800 - out.deficit_kcal);
  assert.ok(
    out.deficit_kcal >= CUT_DEFICIT_MIN_KCAL && out.deficit_kcal <= CUT_DEFICIT_MAX_KCAL,
    `deficit ${out.deficit_kcal} sits inside the bounded band`
  );
});

test("the grounding gate is exactly the stated evidence floor", () => {
  const enough = {
    window_days: 28,
    intake_days: GROUNDED_MIN_INTAKE_DAYS,
    weigh_ins: GROUNDED_MIN_WEIGH_INS,
    weigh_in_span_days: GROUNDED_MIN_SPAN_DAYS,
  };
  assert.equal(cutEvidenceIsGrounded(enough, 2_800), true);
  assert.equal(cutEvidenceIsGrounded({ ...enough, weigh_ins: GROUNDED_MIN_WEIGH_INS - 1 }, 2_800), false);
  assert.equal(cutEvidenceIsGrounded({ ...enough, weigh_in_span_days: GROUNDED_MIN_SPAN_DAYS - 1 }, 2_800), false);
  assert.equal(cutEvidenceIsGrounded({ ...enough, intake_days: GROUNDED_MIN_INTAKE_DAYS - 1 }, 2_800), false);
  assert.equal(cutEvidenceIsGrounded(enough, null), false, "no outcome at all is never grounded");
});

// ---- the intake-coverage law: a partial day is absent, never low -------------

test("only COMPLETE logged days count toward the grounding floor", () => {
  // A fortnight of logged breakfasts is not a fortnight of logged days. The state
  // assembler now hands the floor only complete days, so a window of partial ones
  // arrives here as what it is: no admissible intake evidence.
  const partialOnly = cutTargetDecision(
    grounded({ coverage: { window_days: 28, intake_days: 0, weigh_ins: 10, weigh_in_span_days: 26 } })
  );
  assert.ok(partialOnly, "the derivation still produces a number (rule 2)");
  assert.equal(partialOnly.tdee_basis, "formula_estimate", "grounded flips to estimate when no day is complete");
  assert.equal(partialOnly.confidence, "low");
});

test("cutTargetState counts complete days only, and says so when the plate is quiet", () => {
  resetTables("food_notes", "bodyweight_log");
  seedCut();
  // Fourteen days of breakfast-only logs plus a real weigh-in habit: every day is
  // observed, no day is complete.
  for (let i = 1; i <= 20; i++) {
    repo.addFoodNote("breakfast", "", { kcal: 700, protein_g: 50 }, undefined, { date: localDaysAgo(i) });
    if (i % 2 === 0) repo.logWeight(168 - i * 0.05, localDaysAgo(i));
  }
  const state = repo.cutTargetState(localDaysAgo(0));
  assert.equal(state.coverage.intake_days, 0, "breakfast-only days are absent evidence, not logged intake days");
  assert.equal(state.intake_mode, "quiet");

  const derivation = repo.cutTargetDecision(state);
  assert.ok(derivation);
  assert.equal(derivation.tdee_basis, "formula_estimate");
  assert.match(derivation.reason, /weight trend and a metabolic prior/);
  assert.doesNotMatch(derivation.reason, /not yet thick enough/, "a quiet log is not a record that failed to thicken");
});

test("a quiet log gets its own words, and they never ask for more logging", () => {
  const quiet = cutTargetDecision(
    grounded({
      coverage: { window_days: 28, intake_days: 0, weigh_ins: 10, weigh_in_span_days: 26 },
      intake_mode: "quiet",
    })
  );
  const settling = cutTargetDecision(
    grounded({
      coverage: { window_days: 28, intake_days: 3, weigh_ins: 10, weigh_in_span_days: 26 },
      intake_mode: "occasional",
    })
  );
  const quietBody = cutTargetBody(quiet, TODAY);
  const settlingBody = cutTargetBody(settling, TODAY);
  assert.notEqual(quietBody, settlingBody, "the two registers must not share a sentence");
  assert.match(quietBody, /scale|weigh-in|weight trend|tape/i, "quiet says what it actually stood on");
  assert.doesNotMatch(quietBody, /a few more logged days|logs and weigh-ins accumulate/i);
});

// ---- rule 2: absent data estimates and moves, it never parks -----------------

test("one weigh-in falls back to the formula estimate at LOW confidence, never to silence", () => {
  const out = cutTargetDecision(
    grounded({ coverage: { window_days: 28, intake_days: 22, weigh_ins: 1, weigh_in_span_days: 0 } })
  );
  assert.ok(out, "the derivation still produces a number");
  assert.equal(out.tdee_basis, "formula_estimate");
  assert.equal(out.tdee_kcal, 2_600, "the prior, since the outcome is not admissible");
  assert.equal(out.confidence, "low");
  assert.equal(out.target_kcal, 2_600 - out.deficit_kcal);
});

test("a thin intake log does the same — lower confidence, never a refusal", () => {
  const out = cutTargetDecision(
    grounded({ coverage: { window_days: 28, intake_days: 3, weigh_ins: 10, weigh_in_span_days: 26 } })
  );
  assert.ok(out);
  assert.equal(out.tdee_basis, "formula_estimate");
  assert.equal(out.confidence, "low");
});

test("no maintenance anchor of any kind is the ONLY silence", () => {
  assert.equal(cutTargetDecision(grounded({ outcome_tdee: null, prior_tdee: null })), null);
  assert.equal(cutTargetDecision(grounded({ weight_lb: null })), null);
  assert.equal(cutTargetDecision(grounded({ goal_weight_lb: 170 })), null, "at or below goal there is no cut to fuel");
});

// ---- the outlier clamp ------------------------------------------------------

test("an implausibly high outcome is pulled to the band edge and drops to LOW confidence", () => {
  const out = cutTargetDecision(grounded({ outcome_tdee: 7_400 }));
  assert.ok(out);
  assert.equal(out.outlier_clamped, true);
  assert.equal(out.tdee_kcal, 4_200, "clamped to plausible_tdee_max");
  assert.equal(out.confidence, "low", "a clamped reading never leads at full confidence");
});

test("an implausibly low outcome is clamped the same way", () => {
  const out = cutTargetDecision(grounded({ outcome_tdee: 700 }));
  assert.ok(out);
  assert.equal(out.outlier_clamped, true);
  assert.equal(out.tdee_kcal, 1_500);
});

// ---- rule 3 + 4: the pace law and the date that gives -----------------------

test("a goal date needing a faster pace than the law allows moves the DATE, not the deficit", () => {
  // 4 lb to lose with only two weeks on the clock wants ~2 lb/wk — far past both
  // the pace band and the deficit ceiling.
  const out = cutTargetDecision(grounded({ goal_date: addDaysISO(TODAY, 14) }));
  assert.ok(out);
  assert.equal(out.pace_capped, true, "the requested pace was refused");
  assert.ok(
    out.deficit_kcal <= CUT_DEFICIT_MAX_KCAL,
    `deficit ${out.deficit_kcal} never exceeds the ceiling to hit a date`
  );
  assert.ok(out.goal_date_adaptation, "the date adapts instead");
  assert.equal(out.goal_date_adaptation.from, addDaysISO(TODAY, 14));
  assert.ok(
    out.goal_date_adaptation.to > out.goal_date_adaptation.from,
    "the adapted date is later than the one that could not be met"
  );
  assert.ok(out.goal_date_adaptation.weeks_added > 0);
});

test("a goal date already reachable at the lawful pace adapts nothing", () => {
  const out = cutTargetDecision(grounded({ goal_date: addDaysISO(TODAY, 365) }));
  assert.ok(out);
  assert.equal(out.goal_date_adaptation, null);
  assert.equal(out.pace_capped, false);
});

test("a goal date in the past is treated as 'faster than allowed', never as an infinite deficit", () => {
  const out = cutTargetDecision(grounded({ goal_date: addDaysISO(TODAY, -30) }));
  assert.ok(out);
  assert.ok(out.deficit_kcal <= CUT_DEFICIT_MAX_KCAL);
  assert.ok(out.goal_date_adaptation, "an unreachable past date still yields an honest new one");
});

test("the leanness ceiling only ever NARROWS the pace band", () => {
  // At 12% body fat the leanness taper allows ~0.35% BW/wk, well below the band
  // floor — the derived deficit must follow the SAFETY number, not the band.
  const lean = cutTargetDecision(grounded({ body_fat_pct: 12, goal_date: addDaysISO(TODAY, 14) }));
  const ordinary = cutTargetDecision(grounded({ body_fat_pct: 30, goal_date: addDaysISO(TODAY, 14) }));
  assert.ok(lean && ordinary);
  assert.ok(
    lean.deficit_kcal < ordinary.deficit_kcal,
    `lean deficit ${lean.deficit_kcal} must be gentler than ordinary ${ordinary.deficit_kcal}`
  );
  assert.ok(lean.pace_lb_wk <= CUT_PACE_MAX_PCT * 168 + 0.01);
});

test("the reported pace is what the target actually buys, after every clamp", () => {
  const out = cutTargetDecision(grounded());
  assert.ok(out);
  const impliedDeficit = out.tdee_kcal - out.target_kcal;
  assert.equal(out.deficit_kcal, impliedDeficit, "the deficit is read back off the surviving number");
  assert.ok(Math.abs(out.pace_lb_wk - (impliedDeficit * 7) / 3_500) < 0.02);
});

test("the absolute kcal floor still wins over the deficit", () => {
  const out = cutTargetDecision(
    grounded({ outcome_tdee: 1_600, prior_tdee: 1_600, plausible_tdee_min: 1_200, plausible_tdee_max: 4_200 })
  );
  assert.ok(out);
  assert.ok(out.target_kcal >= 1_500, "never advises below the absolute floor");
  assert.equal(out.deficit_kcal, out.tdee_kcal - out.target_kcal);
});

test("protein is carried forward, never trimmed as a side effect of a calorie change", () => {
  assert.equal(cutTargetDecision(grounded()).protein_g, 175);
  assert.equal(cutTargetDecision(grounded({ protein_floor_g: null })).protein_g, null);
});

// ---- rule 5: the next step of the deficit waits for an ordinary week ---------

// A week the block is peaking in, and a target already in force ABOVE the step this
// week's derivation wants — i.e. a scheduled deepening.
function highDemand(extra = {}) {
  return grounded({
    active_target_kcal: 2_500,
    training_demand: { high: true, basis: ["block_phase"], phase: "intensification" },
    ...extra,
  });
}

test("a scheduled deepening HOLDS during a high-demand week", () => {
  const stepped = cutTargetDecision(grounded({ active_target_kcal: 2_500 }));
  const held = cutTargetDecision(highDemand());
  assert.ok(stepped && held);
  assert.equal(stepped.deepening_held, false, "an ordinary week steps as it always did");
  assert.equal(held.deepening_held, true);
  assert.equal(held.target_kcal, 2_500, "the target stays exactly where the athlete already had it");
  assert.ok(held.target_kcal > stepped.target_kcal, "the step this week wanted was deeper than the hold");
  assert.match(held.reason, /holding at the 2500 kcal already in force/);
  assert.equal(held.training_demand.basis[0], "block_phase");
});

test("the hold defers the increment; it never cancels the deficit", () => {
  const held = cutTargetDecision(highDemand());
  assert.ok(held.deficit_kcal > 0, `a held target still eats at a deficit; got ${held.deficit_kcal}`);
  assert.equal(held.deficit_kcal, held.tdee_kcal - held.target_kcal);
  assert.ok(held.target_kcal < held.tdee_kcal, "a hold is never a surplus");
});

test("the hold never carries the target past MEASURED maintenance", () => {
  // A target already sitting above maintenance cannot be held there: the same
  // ceiling capProtectiveRaise puts on protection binds this hold too.
  const held = cutTargetDecision(highDemand({ active_target_kcal: 3_000 }));
  assert.ok(held);
  assert.equal(held.target_kcal, 2_800, "capped at the measured maintenance the record produced");
  assert.equal(held.deepening_held, true);
});

test("a formula_estimate anchor cannot buy the hold either", () => {
  // Grounding fails, so maintenance is the prior. An unmeasured maintenance is not
  // headroom for a protective raise, and it is not headroom for this hold.
  const thin = { window_days: 28, intake_days: 2, weigh_ins: 1, weigh_in_span_days: 0 };
  const held = cutTargetDecision(highDemand({ coverage: thin }));
  const stepped = cutTargetDecision(grounded({ active_target_kcal: 2_500, coverage: thin }));
  assert.ok(held && stepped);
  assert.equal(held.tdee_basis, "formula_estimate");
  assert.equal(held.deepening_held, false);
  assert.equal(held.target_kcal, stepped.target_kcal, "the high-demand week changed nothing it could not measure");
});

test("only a DEEPENING waits — a hold or a raise passes straight through", () => {
  const raise = cutTargetDecision(highDemand({ active_target_kcal: 2_000 }));
  assert.ok(raise);
  assert.equal(raise.deepening_held, false);
  assert.equal(raise.target_kcal, cutTargetDecision(grounded()).target_kcal);
});

test("an unreadable or absent training week is an ORDINARY week, never a hold", () => {
  for (const demand of [null, undefined, { high: false, basis: [], phase: "accumulation" }]) {
    const out = cutTargetDecision(grounded({ active_target_kcal: 2_500, training_demand: demand }));
    assert.equal(out.deepening_held, false);
  }
  // And with no accepted target there is nothing a deepening could be measured
  // against, so the derivation behaves exactly as it did before rule 5.
  assert.equal(cutTargetDecision(highDemand({ active_target_kcal: null })).deepening_held, false);
});

test("the held week gets its own words, and they never blame the athlete", () => {
  const held = cutTargetDecision(highDemand());
  const body = cutTargetBody(held, TODAY);
  assert.notEqual(body, cutTargetBody(cutTargetDecision(grounded()), TODAY));
  assert.equal(violatesReadingGrammar(body), null);
  const rotated = new Set();
  for (let i = 0; i < 8; i++) rotated.add(cutTargetBody(held, addDaysISO(TODAY, i)));
  assert.ok(rotated.size >= 3, `the hold rotates its wording; saw ${rotated.size}`);
});

test("cutTargetState reads the active block's phase as the training week", () => {
  seedCut();
  repo.setNutritionTarget(
    { effective_date: localDaysAgo(3), target_kcal: 2_500, protein_g: 175 },
    { recordDecision: false }
  );
  repo.createBlock({ goal: "peak", focus: "peak", phase: "realization", total_weeks: 4 });
  const state = repo.cutTargetState(localDaysAgo(0));
  assert.equal(state.active_target_kcal, 2_500, "the accepted row is what a deepening is measured against");
  assert.equal(state.training_demand.high, true);
  assert.deepEqual(state.training_demand.basis, ["block_phase"]);
  assert.equal(state.training_demand.phase, "realization");
});

test("an accumulation block is an ordinary week", () => {
  seedCut();
  repo.createBlock({ goal: "build", focus: "hypertrophy", phase: "accumulation", total_weeks: 6 });
  const state = repo.cutTargetState(localDaysAgo(0));
  assert.equal(state.training_demand.high, false);
  assert.deepEqual(state.training_demand.basis, []);
});

// ---- rule 1 of the owner ruling: the diet break is not a default lane --------

function seedCut(extra = {}) {
  return repo.setProfile({
    sex: "male",
    age: 44,
    height_cm: 178,
    weight_lb: 168,
    goal_weight_lb: 164,
    goal_mode: "lose",
    activity_factor: 1.5,
    ...extra,
  });
}

test("a cut nobody has been asked about is still the athlete's own — it reads as reaffirmed", () => {
  seedCut();
  const read = cutReaffirmation(TODAY);
  assert.equal(read.reaffirmed, true);
  assert.equal(read.source, "never_asked");
  assert.equal(mayProposeEaseFromCut(TODAY), false, "the system may not volunteer maintenance");
});

test("a live, unanswered 'is this still your goal?' opens the question again", () => {
  seedCut();
  // Seed the ladder, then age it so the ask is due and unanswered today.
  repo.confirmGoalCheckin();
  const entry = repo.getAttentionSchedule("journey:goal-checkin");
  assert.ok(entry?.next_due);
  const asOf = addDaysISO(entry.next_due, 1);
  const read = cutReaffirmation(asOf);
  assert.equal(read.reaffirmed, false);
  assert.equal(read.source, "open_question");
  assert.equal(mayProposeEaseFromCut(asOf), true, "while the goal is in question a transition may be offered");
});

test("answering the check-in re-closes the question", () => {
  seedCut();
  repo.confirmGoalCheckin();
  const read = cutReaffirmation(TODAY);
  assert.equal(read.reaffirmed, true);
  assert.equal(read.source, "answered");
});

test("no cut at all is not a reaffirmed cut", () => {
  seedCut({ goal_mode: "maintain", goal_weight_lb: null });
  const read = cutReaffirmation(TODAY);
  assert.equal(read.reaffirmed, false);
  assert.equal(read.source, "not_a_cut");
  assert.equal(mayProposeEaseFromCut(TODAY), true);
});

test("journeyTransitionSuggestion stops volunteering a diet break during a reaffirmed cut", () => {
  seedCut();
  // An eight-week-old cut phase is exactly what the calendar rule used to fire on.
  const phase = repo.createJourneyPhase({
    kind: "cut",
    start_date: addDaysISO(new Date().toISOString().slice(0, 10), -70),
    target_weight_lb: 164,
    status: "proposed",
  });
  repo.activateJourneyPhase(phase.id);

  const suppressed = repo.journeyTransitionSuggestion();
  assert.ok(
    suppressed == null || suppressed.kind !== "diet_break",
    `a reaffirmed cut must not be handed a diet break; got ${suppressed && suppressed.kind}`
  );

  // The same phase, once the goal check-in is openly asking, may be offered one.
  repo.confirmGoalCheckin();
  const entry = repo.getAttentionSchedule("journey:goal-checkin");
  const asOf = addDaysISO(entry.next_due, 1);
  const offered = repo.journeyTransitionSuggestion(asOf);
  assert.equal(offered?.kind, "diet_break", "the calendar rule is gated, not deleted");
});

test("reaching goal weight still proposes maintenance — arrival is grounded evidence", () => {
  seedCut({ weight_lb: 163.5 });
  const suggestion = repo.journeyTransitionSuggestion();
  assert.equal(suggestion?.kind, "maintenance");
});

// ---- the words a person reads ------------------------------------------------

test("every athlete-facing phrasing passes the shared reading grammar", () => {
  for (const line of cutTargetGrammarPool()) {
    assert.equal(violatesReadingGrammar(line), null, `"${line}" must read as coaching prose`);
  }
});

test("the body rotates rather than printing one literal, and is adherence-neutral", () => {
  const seen = new Set();
  const derivation = cutTargetDecision(grounded());
  for (let i = 0; i < 8; i++) seen.add(cutTargetBody(derivation, addDaysISO(TODAY, i)));
  assert.ok(seen.size >= 4, `a stable derivation must rotate its wording; saw ${seen.size}`);
  for (const line of cutTargetGrammarPool()) {
    assert.doesNotMatch(line, /\b(fail|failed|slack|behind|missed|should have|lazy|excuse)\b/i);
  }
});

test("a thin record is described as an estimate, a thick one as a measurement", () => {
  const thin = cutTargetDecision(
    grounded({ coverage: { window_days: 28, intake_days: 2, weigh_ins: 1, weigh_in_span_days: 0 } })
  );
  const thick = cutTargetDecision(grounded());
  const thinBody = cutTargetBody(thin, TODAY);
  const thickBody = cutTargetBody(thick, TODAY);
  assert.notEqual(thinBody, thickBody, "the two registers must not share a sentence");
  assert.match(thinBody, /estimate|sharpen|tighten|wider picture/i);
});
