// Meal-plan adherence: the read that lets "they didn't eat the plan" be a
// hypothesis, and the confounder it feeds into the intake→weight evaluator.
//
// The bug this pins: nothing compared currentMealPlan() with logged food, so a
// missed weight expectation had exactly one available explanation — the calorie
// target — and the evaluator returned a clean not_aligned that eases it. Each
// evaluator case below is an A/B against the SAME data with no plan present, so the
// verdict change is attributable to the adherence read and nothing else.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import { recordDecision } from "../dist/domain/brain/decision-service.js";
import { EVALUATOR_REGISTRY } from "../dist/brain/evaluators.js";
import { completeMealWeek, db, repo, localDaysAgo, resetTables } from "./_seed.js";

const PLAN_KCAL = 2_200;
const PLAN_PROTEIN = 170;

// Machine register, but still Cairn's register: an adherence read describes days,
// it never grades a person. A thin logging week lowers CONFIDENCE, full stop.
const BLAME_WORDS = /\b(fail(ed|ure)?|poor|bad|blame|lazy|excuse|noncomplian\w*|should have|didn'?t bother)\b/i;

function livePlan(overrides = {}) {
  return repo.createMealPlan(
    "stub",
    "",
    completeMealWeek({ summary: "Adherence fixture", daily_kcal: PLAN_KCAL, daily_protein_g: PLAN_PROTEIN, ...overrides })
  );
}

// A single generic "meal" note carries the whole day, which credibleDay accepts
// above 1,000 kcal — the shortest fixture that produces a CREDIBLE logged day.
function logDay(date, kcal, proteinG) {
  return repo.addFoodNote("meal", "", { kcal, protein_g: proteinG }, undefined, { date });
}

beforeEach(() => {
  resetTables("meal_plans", "food_notes", "bodyweight_log", "brain_decisions", "brain_expectations", "brain_evaluations");
});

// ── the classifier ──────────────────────────────────────────────────────────

test("with no live meal plan there is nothing to have followed — an absence, not a miss", () => {
  const read = repo.mealPlanAdherence(localDaysAgo(8), localDaysAgo(2));
  assert.equal(read.plan_id, null);
  assert.equal(read.confidence, "none");
  assert.equal(read.clearly_diverged, false, "no plan can never read as divergence");
  assert.doesNotMatch(read.summary, BLAME_WORDS);
});

test("days inside the plan's kcal and protein bands read as followed, with high confidence", () => {
  livePlan();
  for (let n = 8; n >= 2; n--) logDay(localDaysAgo(n), PLAN_KCAL, PLAN_PROTEIN + 5);

  const read = repo.mealPlanAdherence(localDaysAgo(8), localDaysAgo(2));
  assert.equal(read.calendar_days, 7);
  assert.equal(read.followed_days, 7);
  assert.equal(read.diverged_days, 0);
  assert.equal(read.unlogged_days, 0);
  assert.equal(read.confidence, "high");
  assert.equal(read.clearly_diverged, false);
  assert.doesNotMatch(read.summary, BLAME_WORDS);
});

test("a run of days well outside the kcal band reads as clearly diverged", () => {
  livePlan();
  for (let n = 8; n >= 2; n--) logDay(localDaysAgo(n), 3_600, PLAN_PROTEIN);

  const read = repo.mealPlanAdherence(localDaysAgo(8), localDaysAgo(2));
  assert.equal(read.diverged_days, 7);
  assert.equal(read.followed_days, 0);
  assert.equal(read.clearly_diverged, true);
  assert.doesNotMatch(read.summary, BLAME_WORDS, "divergence is described, never judged");
});

test("a day under the protein floor diverges even when its calories land in band", () => {
  livePlan();
  logDay(localDaysAgo(4), PLAN_KCAL, 60); // 60 g is far under 80% of 170 g
  logDay(localDaysAgo(3), PLAN_KCAL, PLAN_PROTEIN);

  const read = repo.mealPlanAdherence(localDaysAgo(4), localDaysAgo(3));
  assert.equal(read.followed_days, 1);
  assert.equal(read.diverged_days, 1);
});

test("a day whose protein was never estimated is judged on calories alone", () => {
  livePlan();
  // protein_g omitted entirely — an unlogged macro is not a missed one.
  repo.addFoodNote("meal", "", { kcal: PLAN_KCAL }, undefined, { date: localDaysAgo(3) });

  const read = repo.mealPlanAdherence(localDaysAgo(3), localDaysAgo(3));
  assert.equal(read.followed_days, 1, "an absent protein estimate cannot fail the protein floor");
});

test("a snack-only day is too thin to read — explicitly not a divergence", () => {
  livePlan();
  repo.addFoodNote("snack", "", { kcal: 300, protein_g: 5 }, undefined, { date: localDaysAgo(3) });

  const read = repo.mealPlanAdherence(localDaysAgo(3), localDaysAgo(3));
  assert.equal(read.too_thin_days, 1);
  assert.equal(read.diverged_days, 0);
  assert.equal(read.readable_days, 0);
  assert.equal(read.confidence, "none");
  assert.doesNotMatch(read.summary, BLAME_WORDS);
});

test("confidence degrades with thin logging instead of blaming it", () => {
  livePlan();
  // Two readable days across a fortnight: the read still works, it just stops
  // claiming to know much.
  logDay(localDaysAgo(9), PLAN_KCAL, PLAN_PROTEIN);
  logDay(localDaysAgo(4), PLAN_KCAL, PLAN_PROTEIN);

  const read = repo.mealPlanAdherence(localDaysAgo(15), localDaysAgo(2));
  assert.equal(read.readable_days, 2);
  assert.equal(read.followed_days, 2, "the two days that WERE logged still read as followed");
  assert.equal(read.confidence, "low");
  assert.equal(read.unlogged_days, 12);
  assert.match(read.summary, /confidence: low/i);
  assert.doesNotMatch(read.summary, BLAME_WORDS);
});

// Land a plan and pin exactly when it landed, so "which plan was live during the
// window" is a real question rather than an artifact of insertion order.
function landPlan(createdAt, overrides = {}) {
  const plan = livePlan(overrides);
  db.prepare(`UPDATE meal_plans SET status = 'accepted', created_at = ? WHERE id = ?`).run(createdAt, plan.id);
  return plan;
}

test("a window is judged against the plan that was live THEN, not a later re-draft", () => {
  // What the athlete was actually eating against, then a fresh plan drafted after the
  // window closed with a very different target.
  const during = landPlan("2026-01-02 09:00:00", { daily_kcal: PLAN_KCAL, daily_protein_g: PLAN_PROTEIN });
  const after = landPlan("2026-02-01 09:00:00", { daily_kcal: 3_000, daily_protein_g: 210 });
  for (let day = 3; day <= 12; day++) {
    logDay(`2026-01-${String(day).padStart(2, "0")}`, PLAN_KCAL, PLAN_PROTEIN);
  }

  const read = repo.mealPlanAdherence("2026-01-03", "2026-01-12");
  assert.equal(read.plan_id, during.id, "the newest plan is not automatically the right yardstick");
  assert.notEqual(read.plan_id, after.id);
  assert.equal(read.daily_kcal, PLAN_KCAL);
  assert.equal(read.followed_days, 10, "days eaten against the live plan read as followed");
  assert.equal(read.clearly_diverged, false, "a re-draft must not retroactively invent a divergence");
});

test("with no plan old enough to have covered the window, the current one is still the answer", () => {
  landPlan("2026-06-01 09:00:00");
  logDay("2026-01-05", PLAN_KCAL, PLAN_PROTEIN);

  const read = repo.mealPlanAdherence("2026-01-03", "2026-01-12");
  assert.ok(read.plan_id, "the fallback keeps a plan-less window from being invented");
  assert.equal(read.daily_kcal, PLAN_KCAL);
});

test("a plan carrying no headline calorie target confounds nothing — there was no target to diverge from", () => {
  // The legacy shape: a stored plan with days but no daily_kcal/daily_protein_g. It can
  // never be a yardstick, so it must not be reported as one either — evaluators.ts
  // treats a non-null plan_id as "a plan was live here", and handing one back for a
  // plan with no readable target confounded every intake window it touched.
  db.prepare(
    `INSERT INTO meal_plans (week_of, agent, raw_output, parsed_json, status, created_at)
     VALUES ('2026-01-01', 'legacy', '', ?, 'accepted', '2026-01-01 09:00:00')`
  ).run(JSON.stringify({ summary: "Legacy plan", days: [{ day: "Mon", meals: [{ name: "Meal", kcal: 700 }] }] }));

  const read = repo.mealPlanAdherence("2026-01-03", "2026-01-12");
  assert.equal(read.plan_id, null, "no readable target means no plan for adherence purposes");
  assert.equal(read.confidence, "none");
  assert.equal(read.clearly_diverged, false);

  // …and the evaluator therefore reads the window exactly as it would with no plan.
  seedWindow({ dayCount: 10, kcal: 3_600, minIntakeDays: 10 });
  const result = evaluateMatureExpectations(AS_OF);
  assert.equal(result.evaluations[0].verdict, "not_aligned");
  assert.equal(
    result.evaluations[0].confounders.some((item) => DIVERGED_CONFOUNDER.test(item) || UNREADABLE_CONFOUNDER.test(item)),
    false,
    "a plan with no target must not permanently confound the intake evaluation"
  );
});

// ── the evaluator verdict path ───────────────────────────────────────────────

const AS_OF = "2026-01-16";
const WINDOW = { start: "2026-01-01", end: "2026-01-15" };

// Flat weights against an expectation that predicted a cut: without a confounder
// this window is a decisive not_aligned, which is exactly the verdict that eases
// the calorie target.
const FLAT_WEIGHTS = [
  ["2026-01-01", 200],
  ["2026-01-04", 200.1],
  ["2026-01-07", 200.0],
  ["2026-01-10", 200.2],
  ["2026-01-13", 200.1],
  ["2026-01-15", 200.2],
];

function intakeDecision() {
  return {
    effective_date: WINDOW.start,
    kind: "nutrition_target",
    domain: "nutrition",
    summary: "Hold the target and read the response.",
    rationale: "A bounded change makes the response measurable.",
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: {},
    action: {},
    specialist: null,
    applied_at: `${WINDOW.start}T12:00:00.000Z`,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: "test-v1",
  };
}

function intakeExpectation(minIntakeDays) {
  return {
    metric_key: "intake_to_weight_response",
    subject_key: null,
    direction: "within_band",
    baseline: { target_kcal: PLAN_KCAL, predicted_trend_lb_wk: -0.5, recomposition_stage: "mid_cut" },
    target: { min: -1, max: -0.2 },
    window_start: WINDOW.start,
    window_end: WINDOW.end,
    minimum_data: { weigh_ins: 6, intake_days: minIntakeDays },
    confounder_policy: "none",
    confidence: "tentative",
    evaluator: EVALUATOR_REGISTRY.intake_to_weight_response.evaluator,
    evaluator_version: "test-v1",
  };
}

function seedWindow({ dayCount, kcal, minIntakeDays }) {
  const insert = db.prepare(`INSERT INTO bodyweight_log (date, weight_lb) VALUES (?, ?)`);
  for (const [date, weight] of FLAT_WEIGHTS) insert.run(date, weight);
  for (let day = 1; day <= dayCount; day++) {
    const date = `2026-01-${String(day).padStart(2, "0")}`;
    db.prepare(`INSERT INTO food_notes (date, meal, raw_output, parsed_json) VALUES (?, 'meal', '', ?)`).run(
      date,
      JSON.stringify({ kcal, protein_g: PLAN_PROTEIN })
    );
  }
  recordDecision(intakeDecision(), [intakeExpectation(minIntakeDays)]);
}

const DIVERGED_CONFOUNDER = /diverged from the live meal plan/i;
const UNREADABLE_CONFOUNDER = /tell whether the meal plan was followed/i;

test("without a meal plan the flat-weight window is still a decisive not_aligned", () => {
  seedWindow({ dayCount: 10, kcal: 3_600, minIntakeDays: 10 });

  const result = evaluateMatureExpectations(AS_OF);
  assert.equal(result.evaluations[0].verdict, "not_aligned");
  assert.equal(
    result.evaluations[0].confounders.some((item) => DIVERGED_CONFOUNDER.test(item)),
    false,
    "no plan means no adherence confounder"
  );
});

test("the same window becomes inconclusive once the logged food clearly diverged from the live plan", () => {
  livePlan();
  seedWindow({ dayCount: 10, kcal: 3_600, minIntakeDays: 10 });

  const result = evaluateMatureExpectations(AS_OF);
  const evaluation = result.evaluations[0];
  assert.equal(evaluation.verdict, "inconclusive", "an un-eaten plan cannot convict the calorie target");
  assert.ok(evaluation.confounders.some((item) => DIVERGED_CONFOUNDER.test(item)));
  assert.deepEqual(evaluation.evidence_keys, [], "an inconclusive verdict carries no supporting evidence");
});

test("a plan that WAS followed leaves the miss decisive — adherence never rescues a real one", () => {
  livePlan();
  seedWindow({ dayCount: 10, kcal: PLAN_KCAL, minIntakeDays: 10 });

  const result = evaluateMatureExpectations(AS_OF);
  assert.equal(result.evaluations[0].verdict, "not_aligned");
  assert.equal(
    result.evaluations[0].confounders.some((item) => DIVERGED_CONFOUNDER.test(item) || UNREADABLE_CONFOUNDER.test(item)),
    false
  );
});

test("too few readable days to judge adherence also confounds the verdict", () => {
  livePlan();
  // Four logged days across a fifteen-day window: enough for this expectation's own
  // minimum, nowhere near enough to say whether the plan was being eaten.
  seedWindow({ dayCount: 4, kcal: PLAN_KCAL, minIntakeDays: 3 });

  const result = evaluateMatureExpectations(AS_OF);
  assert.equal(result.evaluations[0].verdict, "inconclusive");
  assert.ok(result.evaluations[0].confounders.some((item) => UNREADABLE_CONFOUNDER.test(item)));
});

test("with no plan those same four days stay decisive, so the flip is the adherence read's doing", () => {
  seedWindow({ dayCount: 4, kcal: PLAN_KCAL, minIntakeDays: 3 });

  const result = evaluateMatureExpectations(AS_OF);
  assert.equal(result.evaluations[0].verdict, "not_aligned");
});
