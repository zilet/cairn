// The LAB LOOP (wave/lab-loop): applying a plan/meal change while a marker-sourced
// directive is active anchors a falsifiable marker-direction expectation to THAT
// intervention, and a matured verdict builds a bounded, humble learned "marker response"
// surfaced as one calm line in the health-review prompt.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { localDaysAgo, repo, resetTables, seedHealthDoc, completeMealWeek } from "./_seed.js";
import { evaluateMatureExpectations } from "../dist/brainEvaluator.js";
import { buildHealthReviewPrompt } from "../dist/prompt/health.js";

beforeEach(() => {
  resetTables(
    "brain_evaluations",
    "brain_expectations",
    "brain_decisions",
    "brain_tool_calls",
    "health_directives",
    "health_documents",
    "meal_plans",
    "nutrition_targets",
    "plan_proposals",
    "plan_items",
    "plan_days",
    "context_events",
    "app_state",
    "profile"
  );
});

const isoInDays = (n) => localDaysAgo(-n);

function interventionMarkerExpectation(decisionKinds) {
  const decisions = repo.listBrainDecisions({ limit: 50 }).filter((d) => decisionKinds.includes(d.kind));
  for (const decision of decisions) {
    const expectations = repo.listBrainExpectations({ decisionId: decision.id });
    const marker = expectations.find((row) => row.metric_key === "marker_direction");
    if (marker) return { decision, expectation: marker };
  }
  return null;
}

test("an applied training change anchors a marker-direction expectation to the active training directive", () => {
  // Low ferritin propagates a TRAINING directive ("hold endurance volume while low").
  seedHealthDoc("2026-01-10", [{ name: "Ferritin", value: 20, unit: "ng/mL", flag: "low" }]);
  repo.deriveDirectives();
  const trainingDirective = repo.listActiveDirectives().find((d) => d.domain === "training" && d.marker === "Ferritin");
  assert.ok(trainingDirective, "low ferritin should raise a training directive");

  repo.savePlanDay(1, "Endurance base", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  const proposal = repo.createProposal("stub", "progress the squat", "raw", {
    summary: "Progress the squat.",
    changes: [{ day_number: 1, exercise: "Back Squat", target_weight: 190, reason: "two clean exposures" }],
  });
  assert.equal(repo.applyProposal(proposal.id).ok, true);

  const found = interventionMarkerExpectation(["training_target", "training_structure", "exercise_rotation"]);
  assert.ok(found, "the applied training decision should carry a marker-direction expectation");
  assert.equal(found.expectation.subject_key, "Ferritin");
  assert.equal(found.expectation.direction, "increase", "low ferritin should move UP toward optimal");
  assert.equal(found.expectation.confounder_policy, "next_draw");
  assert.deepEqual(found.expectation.minimum_data, { draws: 2 });
  assert.equal(found.expectation.baseline.value, 20, "the baseline is the trigger value when the directive was raised");
  assert.equal(found.expectation.confidence, "tentative", "an applied plan is an indirect lever — a soft anchor");
  // 180-day lab horizon.
  const start = Date.parse(found.expectation.window_start);
  const end = Date.parse(found.expectation.window_end);
  assert.equal(Math.round((end - start) / 864e5), 180);
  // The primary driver is stamped into the decision context as an audit trail.
  assert.equal(found.decision.context.marker_anchor.anchored_marker, "Ferritin");
});

test("the primary driver is the highest-priority active directive; the rest ride along in meta", () => {
  // Two flagged, actionable NUTRITION markers. ApoB at 145 sits much further from its
  // optimal band than a mildly-low vitamin D, so it must be the primary driver.
  seedHealthDoc("2026-01-10", [
    { name: "ApoB", value: 145, unit: "mg/dL", flag: "high" },
    { name: "Vitamin D", value: 34, unit: "ng/mL", flag: "low" },
  ]);
  repo.deriveDirectives();
  const nutritionDirectives = repo.listActiveDirectives().filter((d) => d.domain === "nutrition" && d.marker);
  const markers = new Set(nutritionDirectives.map((d) => d.marker));
  assert.ok(markers.has("ApoB") && markers.has("Vitamin D"), "both markers should raise nutrition directives");

  // The expected primary = the directive marker that ranks first in the priority snapshot.
  const priorityOrder = repo.prioritizeMarkers().markers.map((m) => repo.canonicalDirectiveMarker(m.name));
  const expectedPrimary = priorityOrder.find((label) => markers.has(label));

  const recording = repo.markerInterventionRecording("nutrition", localDaysAgo(0));
  assert.ok(recording, "an active nutrition directive should produce a recording");
  assert.equal(recording.primary.marker, expectedPrimary);
  assert.equal(recording.expectation.subject_key, expectedPrimary);
  assert.equal(recording.others.length, markers.size - 1);
  assert.ok(recording.others.includes([...markers].find((m) => m !== expectedPrimary)));
  assert.deepEqual(new Set(recording.meta.anchored_markers), markers);
});

test("an ordinary apply with no active marker directive keeps today's behavior", () => {
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Front Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 155 },
  ]);
  const proposal = repo.createProposal("stub", "progress the squat", "raw", {
    summary: "Progress the squat.",
    changes: [{ day_number: 1, exercise: "Front Squat", target_weight: 160, reason: "ready" }],
  });
  assert.equal(repo.applyProposal(proposal.id).ok, true);

  // No health directive is active, so NO marker-direction expectation is created and the
  // decision context carries no marker anchor — exactly the prior behavior (marker: null).
  assert.equal(repo.markerInterventionRecording("training", localDaysAgo(0)), null);
  const anchored = interventionMarkerExpectation(["training_target", "training_structure", "exercise_rotation"]);
  assert.equal(anchored, null);
});

test("a matured verdict builds a learned marker response surfaced as one calm line", () => {
  // Baseline: low vitamin D raises a NUTRITION directive.
  const today = localDaysAgo(0);
  seedHealthDoc(today, [{ name: "Vitamin D", value: 18, unit: "ng/mL", flag: "low" }]);
  repo.deriveDirectives();
  assert.ok(repo.listActiveDirectives().some((d) => d.domain === "nutrition" && d.marker === "Vitamin D"));

  // Apply a meal plan while the directive is active -> anchors marker_direction to Vitamin D.
  const plan = repo.createMealPlan(
    "stub",
    "",
    completeMealWeek({ summary: "Fiber + oily fish tilt", daily_kcal: 2200 })
  );
  repo.acceptMealPlan(plan.id);
  const anchored = interventionMarkerExpectation(["meal_plan"]);
  assert.ok(anchored, "the accepted meal plan should carry a marker-direction expectation");
  assert.equal(anchored.expectation.subject_key, "Vitamin D");

  // Before any verdict, the prompt stays silent — nothing learned yet.
  assert.equal(repo.markerResponseCoachLine(), null);
  assert.ok(!buildHealthReviewPrompt().includes("LEARNED (this athlete's own lab-loop history"));

  // A follow-up draw INSIDE the window shows vitamin D moved toward optimal.
  seedHealthDoc(isoInDays(30), [{ name: "Vitamin D", value: 45, unit: "ng/mL", flag: null }]);
  // Mature the 180-day window and evaluate.
  const summary = evaluateMatureExpectations(isoInDays(181), { limit: 200 });
  assert.ok(summary.evaluated > 0);

  const evaluation = repo.latestBrainEvaluation(anchored.expectation.id);
  assert.ok(evaluation, "the matured expectation should have an evaluation");
  assert.equal(evaluation.verdict, "aligned", "vitamin D rose toward optimal, so the anchor is aligned");

  // The learned pattern is built (humble, correlation-framed) and surfaced as ONE line.
  const learned = repo.learnedMarkerResponses();
  const vitD = learned.find((p) => p.marker === "Vitamin D");
  assert.ok(vitD, "a learned marker response for vitamin D should exist");
  assert.equal(vitD.verdict, "aligned");
  assert.equal(vitD.domain, "nutrition");
  assert.equal(vitD.confidence, "tentative", "a single verdict stays tentative");

  const line = repo.markerResponseCoachLine();
  assert.ok(line && line.includes("Vitamin D") && line.includes("toward optimal"));
  // Domain filtering works; a domain with no learned response stays silent.
  assert.equal(repo.markerResponseCoachLine({ domain: "nutrition" }), line);
  assert.equal(repo.markerResponseCoachLine({ domain: "training" }), null);

  // The health-review prompt now carries exactly that one calm line.
  const prompt = buildHealthReviewPrompt();
  assert.ok(prompt.includes("LEARNED (this athlete's own lab-loop history"));
  assert.ok(prompt.includes(line));
});

// --------------------------------------------------------------------------
// Anchor dedup — one lab draw is ONE evidence unit per marker + intervention kind.
// --------------------------------------------------------------------------

// The OPEN (unevaluated) meal-plan-anchored marker_direction expectations for a marker.
function openMealMarkerExpectations(markerName) {
  const wanted = markerName.toLowerCase();
  const decisions = repo
    .listBrainDecisions({ limit: 100 })
    .filter((d) => d.kind === "meal_plan" && d.status === "applied");
  const out = [];
  for (const decision of decisions) {
    for (const x of repo.listBrainExpectations({ decisionId: decision.id })) {
      if (
        x.metric_key === "marker_direction" &&
        String(x.subject_key).toLowerCase() === wanted &&
        !repo.latestBrainEvaluation(x.id)
      ) {
        out.push(x);
      }
    }
  }
  return out;
}

// Persist a backdated APPLIED meal-plan decision carrying one marker_direction expectation,
// so read-side tests can craft distinct/duplicate follow-up draws (acceptMealPlan always
// stamps window_start = today, which can't express a multi-month draw history in one process).
function craftMealAnchor({ markerName, baseline, direction = "increase", windowStartDaysAgo, windowLenDays = 180 }) {
  const expectation = {
    metric_key: "marker_direction",
    subject_key: markerName,
    direction,
    baseline: { value: baseline },
    target: {},
    window_start: localDaysAgo(windowStartDaysAgo),
    window_end: localDaysAgo(windowStartDaysAgo - windowLenDays),
    minimum_data: { marker_draws: 2 },
    confounder_policy: "next_draw",
    confidence: "tentative",
    evaluator: "marker_direction",
    evaluator_version: "intervention-marker-v1",
  };
  return repo.recordDecision(
    {
      kind: "meal_plan",
      domain: "nutrition",
      summary: `meal plan anchored ${windowStartDaysAgo}d ago`,
      autonomy_tier: "ask",
      risk_class: "low",
      reversible: false,
      status: "applied",
      effective_date: localDaysAgo(windowStartDaysAgo),
      applied_at: new Date(Date.now() - windowStartDaysAgo * 864e5).toISOString(),
    },
    [expectation]
  );
}

test("repeated meal-plan applies against one standing directive within a draw window anchor ONE expectation", () => {
  const today = localDaysAgo(0);
  seedHealthDoc(today, [{ name: "Vitamin D", value: 18, unit: "ng/mL", flag: "low" }]);
  repo.deriveDirectives();
  assert.ok(repo.listActiveDirectives().some((d) => d.domain === "nutrition" && d.marker === "Vitamin D"));

  // First accepted plan anchors the marker-direction expectation.
  const plan1 = repo.createMealPlan("stub", "", completeMealWeek({ summary: "Fiber + oily fish", daily_kcal: 2100 }));
  repo.acceptMealPlan(plan1.id);
  assert.ok(interventionMarkerExpectation(["meal_plan"]), "the first accepted plan anchors a marker expectation");
  assert.equal(openMealMarkerExpectations("Vitamin D").length, 1);

  // A weekly re-draft against the SAME standing directive with no new lab in between must NOT
  // mint a second, near-identical expectation — the next draw is one outcome, counted once.
  const repeat = repo.markerInterventionRecording("nutrition", today, "meal_plan");
  assert.ok(repeat, "the directive is still active, so a recording is still produced");
  assert.equal(repeat.expectation, null, "the same-draw repeat suppresses a duplicate expectation");
  assert.equal(repeat.meta.deduped, true, "the anchor still rides in meta, flagged as deduped");
  assert.equal(repeat.meta.anchored_marker, "Vitamin D", "meta still names the marker for the audit trail");

  // Accepting the second plan confirms the suppression on the real path: still ONE open anchor.
  const plan2 = repo.createMealPlan("stub", "", completeMealWeek({ summary: "More fiber", daily_kcal: 2050 }));
  repo.acceptMealPlan(plan2.id);
  assert.equal(
    openMealMarkerExpectations("Vitamin D").length,
    1,
    "a standing directive across weekly re-drafts yields exactly one open marker anchor"
  );
});

test("a new lab reading between applies makes a second expectation legitimate", () => {
  const today = localDaysAgo(0);
  seedHealthDoc(today, [{ name: "Vitamin D", value: 18, unit: "ng/mL", flag: "low" }]);
  repo.deriveDirectives();

  const plan1 = repo.createMealPlan("stub", "", completeMealWeek({ summary: "Fiber tilt", daily_kcal: 2100 }));
  repo.acceptMealPlan(plan1.id);
  assert.equal(openMealMarkerExpectations("Vitamin D").length, 1);

  // A genuinely NEW draw lands after the open anchor was created (still off-optimal, so the
  // directive stays active). A later apply is now a distinct draw and earns its own anchor.
  seedHealthDoc(localDaysAgo(-2), [{ name: "Vitamin D", value: 25, unit: "ng/mL", flag: "low" }]);
  const recording = repo.markerInterventionRecording("nutrition", localDaysAgo(-2), "meal_plan");
  assert.ok(recording && recording.expectation, "a new reading since the open anchor lifts the dedup");
  assert.ok(!recording.meta.deduped, "not flagged as a dedup — this is a legitimately distinct draw");
  assert.equal(recording.expectation.subject_key, "Vitamin D");
});

test("a different intervention KIND is a separate evidence unit, not deduped against the meal plan", () => {
  const today = localDaysAgo(0);
  seedHealthDoc(today, [{ name: "Vitamin D", value: 18, unit: "ng/mL", flag: "low" }]);
  repo.deriveDirectives();

  // An accepted meal plan opens a 'meal-plan tilt' anchor for Vitamin D.
  const plan = repo.createMealPlan("stub", "", completeMealWeek({ summary: "Fiber + oily fish", daily_kcal: 2100 }));
  repo.acceptMealPlan(plan.id);
  assert.ok(interventionMarkerExpectation(["meal_plan"]), "the meal plan anchors a Vitamin D expectation");

  // A nutrition-TARGET change is a different intervention ('nutrition change') than the meal
  // plan, so its anchor must NOT be suppressed by the open meal-plan expectation — even with no
  // new lab and the same marker + domain. Dedup is per marker + intervention KIND, not domain.
  const targetChange = repo.markerInterventionRecording("nutrition", today, "nutrition_target");
  assert.ok(targetChange && targetChange.expectation, "a distinct intervention kind gets its own anchor");
  assert.ok(!targetChange.meta.deduped);
});

test("duplicate anchors resolving against one follow-up draw collapse to a single evidence unit", () => {
  // Two NON-overlapping anchors (no mutual confounder) whose reads BOTH close on the same
  // latest draw (100 days ago) — the over-count path the read-side collapse must neutralize.
  seedHealthDoc(localDaysAgo(400), [{ name: "Vitamin D", value: 18, unit: "ng/mL", flag: "low" }]);
  seedHealthDoc(localDaysAgo(150), [{ name: "Vitamin D", value: 30, unit: "ng/mL", flag: "low" }]);
  seedHealthDoc(localDaysAgo(100), [{ name: "Vitamin D", value: 45, unit: "ng/mL", flag: null }]);
  craftMealAnchor({ markerName: "Vitamin D", baseline: 18, windowStartDaysAgo: 400 }); // [400d, 220d]
  craftMealAnchor({ markerName: "Vitamin D", baseline: 18, windowStartDaysAgo: 200 }); // [200d, 20d]

  const summary = evaluateMatureExpectations(localDaysAgo(0), { limit: 200 });
  assert.ok(summary.evaluated >= 2, "both mature expectations are evaluated");

  const vitD = repo.learnedMarkerResponses().find((p) => p.marker === "Vitamin D");
  assert.ok(vitD, "a learned response is still built");
  assert.equal(vitD.verdict, "aligned");
  assert.equal(vitD.evidence_n, 1, "the shared follow-up draw collapses both verdicts to one unit");
  assert.equal(vitD.confidence, "tentative", "two verdicts from ONE real draw never reach 'observed'");
});

test("two genuinely distinct follow-up draws agreeing reach 'observed'", () => {
  // Four dated readings; two NON-overlapping anchors each evaluated when a DIFFERENT draw was
  // the latest (E1 as of 200 days ago, E2 now) — two real outcomes, each toward optimal.
  seedHealthDoc(localDaysAgo(400), [{ name: "Vitamin D", value: 18, unit: "ng/mL", flag: "low" }]);
  seedHealthDoc(localDaysAgo(250), [{ name: "Vitamin D", value: 30, unit: "ng/mL", flag: "low" }]);
  seedHealthDoc(localDaysAgo(150), [{ name: "Vitamin D", value: 38, unit: "ng/mL", flag: "low" }]);
  seedHealthDoc(localDaysAgo(100), [{ name: "Vitamin D", value: 45, unit: "ng/mL", flag: null }]);
  craftMealAnchor({ markerName: "Vitamin D", baseline: 18, windowStartDaysAgo: 400, windowLenDays: 150 }); // [400d, 250d]
  craftMealAnchor({ markerName: "Vitamin D", baseline: 30, windowStartDaysAgo: 200, windowLenDays: 150 }); // [200d, 50d]

  // Phase 1: only E1 is mature (as of 200 days ago); it lands aligned against the 250d draw.
  const first = evaluateMatureExpectations(localDaysAgo(200), { limit: 200 });
  assert.ok(first.evaluated >= 1, "the first anchor matures and evaluates");
  // Phase 2: E2 matures now; E1 already holds a decisive verdict, so it is not re-evaluated.
  evaluateMatureExpectations(localDaysAgo(0), { limit: 200 });

  const vitD = repo.learnedMarkerResponses().find((p) => p.marker === "Vitamin D");
  assert.ok(vitD, "a learned response is built");
  assert.equal(vitD.verdict, "aligned");
  assert.equal(vitD.evidence_n, 2, "two distinct draws stay two evidence units");
  assert.equal(vitD.confidence, "observed", "only >=2 genuinely distinct draws agreeing earns 'observed'");
});
