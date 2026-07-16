// The Today salience arbiter (Era 2, §12 item 1) — src/repo/today-agenda.ts.
// ONE deterministic ranking + budget pass over the whole Today surface: the Brief
// is always the hero, the top TODAY_PRIMARY_MAX candidates render inline (primary),
// the rest collapse behind one quiet "more". Constitution-critical invariants:
//   - empty data → ONLY the hero (no card invented to fill space)
//   - a candidate whose data is empty is OMITTED (priority <= 0 never surfaces)
//   - more than TODAY_PRIMARY_MAX candidates → exactly MAX in primary, rest in more
//   - everything is sorted by priority desc (primary holds the highest)
//   - one producer throwing never breaks the agenda (each read is isolated)
// todayAgenda is imported via the repo barrel (integrator wires the export);
// app_state + profile are reset so the two sibling Era-2 producers (since-last /
// goal-checkin) stay silent and the candidate set under test is fully controlled.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  completeMealWeek,
  db,
  isoDaysAgo,
  localDaysAgo,
  repo,
  resetTables,
  seedHealthDoc,
  seedIntake,
  marker,
} from "./_seed.js";
import { applyDueAnnouncedDecisions, applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";

// Tables every candidate producer reads — wiped to a known floor each case so the
// arbiter sees exactly (and only) what each test seeds.
beforeEach(() => {
  resetTables(
    "food_notes",
    "insights",
    "meal_plans",
    "plan_proposals",
    "health_directives",
    "garmin_activities",
    "garmin_sources",
    "sessions",
    "logged_sets",
    "activities",
    "plan_days",
    "plan_items",
    "bodyweight_log",
    "app_state",
    "profile",
    "day_reads",
    "brain_evaluations",
    "brain_expectations",
    "brain_decisions"
  );
});

test("an announced structural change proceeds automatically with an exact-id Coach discussion path", () => {
  const decision = repo.recordDecision({
    effective_date: localDaysAgo(-3),
    kind: "training_structure",
    domain: "training",
    summary: "Shift the next block toward dumbbell pressing.",
    rationale: "Your recent barbell pattern is stalled while the chest wall is still sensitive.",
    source: "test",
    source_ref_type: "plan_proposal",
    source_ref_key: "42",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: true,
    input_fingerprint: null,
    context: null,
    action: { proposal_id: 42 },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
  const agenda = repo.todayAgenda();
  const card = [...agenda.primary, ...agenda.more].find((item) => item.id === `announced-decision-${decision.id}`);
  assert.equal(card?.kicker, "NEXT BOUNDARY");
  assert.equal(card?.action?.label, "Discuss with coach");
  assert.equal(card?.action?.kind, "chat-decision");
  assert.match(String(card?.action?.payload), new RegExp(`decision #${decision.id}\\b`));
  assert.match(String(card?.action?.payload), /Shift the next block toward dumbbell pressing/);
  assert.match(String(card?.action?.payload), /recent barbell pattern is stalled/);
  assert.match(String(card?.action?.payload), new RegExp(String(decision.effective_date)));
  assert.match(String(card?.action?.payload), /explain how this fits my current data/i);
  assert.doesNotMatch(String(card?.action?.payload), /\b(?:cancel|undo|revert|hold)\b/i);
});

test("an announced change keeps a deterministic one-tap Hold beside the Coach path", () => {
  const decision = repo.recordDecision({
    effective_date: localDaysAgo(-3),
    kind: "training_structure",
    domain: "training",
    summary: "Shift the next block toward dumbbell pressing.",
    rationale: "Your recent barbell pattern is stalled while the chest wall is still sensitive.",
    source: "test",
    source_ref_type: "plan_proposal",
    source_ref_key: "42",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: true,
    input_fingerprint: null,
    context: null,
    action: { proposal_id: 42 },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;
  const agenda = repo.todayAgenda();
  const card = [...agenda.primary, ...agenda.more].find((item) => item.id === `announced-decision-${decision.id}`);
  // The conversational primary stays put...
  assert.equal(card?.action?.kind, "chat-decision");
  // ...and a quieter deterministic Hold sits beside it, carrying the exact
  // decision id so cancelling never depends on an agent being reachable.
  assert.equal(card?.secondary_action?.label, "Hold this");
  assert.equal(card?.secondary_action?.kind, "hold-decision");
  assert.equal(card?.secondary_action?.payload, decision.id);
});

test("an upcoming meal-plan change uses calm automatic copy and concise daily targets", () => {
  const plan = repo.createMealPlan(
    "stub",
    "",
    completeMealWeek({
      summary: "A verbose agent summary that should not reach Today.",
      rationale: "A long rationale that should stay in the detail view rather than filling the Today agenda.",
      daily_kcal: 2075,
      daily_protein_g: 175,
      days: [],
    })
  );
  const tomorrow = localDaysAgo(-1);
  const decision = repo.recordDecision({
    effective_date: tomorrow,
    kind: "meal_plan",
    domain: "nutrition",
    summary: "A verbose agent summary that should not reach Today.",
    rationale: "A long rationale that should stay in the detail view rather than filling the Today agenda.",
    source: "test",
    source_ref_type: "meal_plan",
    source_ref_key: String(plan.id),
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: null,
    action: { meal_plan_id: plan.id },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;

  const agenda = repo.todayAgenda(localDaysAgo(0));
  const card = [...agenda.primary, ...agenda.more].find((item) => item.id === `announced-decision-${decision.id}`);
  assert.equal(card?.kicker, "COMING UP");
  assert.equal(card?.title, "Tomorrow — your meal plan refreshes automatically");
  assert.equal(card?.body, "Daily plan: 2,075 kcal · 175 g protein.");
  assert.doesNotMatch(`${card?.title} ${card?.body}`, /verbose|long rationale/i);
  assert.equal(card?.action?.label, "Discuss with coach");
  assert.equal(card?.action?.kind, "chat-decision");
  assert.match(String(card?.action?.payload), new RegExp(`decision #${decision.id}\\b`));
});

test("an upcoming meal-plan change degrades calmly when target specifics are unavailable", () => {
  const decision = repo.recordDecision({
    effective_date: localDaysAgo(-3),
    kind: "meal_plan",
    domain: "nutrition",
    summary: "Agent output should remain out of the compact card.",
    rationale: "Likewise this rationale.",
    source: "test",
    source_ref_type: "meal_plan",
    source_ref_key: "9999",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: null,
    action: { meal_plan_id: 9999 },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  }).decision;

  const agenda = repo.todayAgenda(localDaysAgo(0));
  const card = [...agenda.primary, ...agenda.more].find((item) => item.id === `announced-decision-${decision.id}`);
  assert.equal(card?.body, "Your next week of meals is ready.");
  assert.ok(card?.title?.includes("your meal plan refreshes automatically"));
});

test("every live announced change remains reachable across primary and more", () => {
  const mealPlan = repo.createMealPlan(
    "stub",
    "",
    completeMealWeek({
      daily_kcal: 2150,
      daily_protein_g: 175,
      days: [],
    })
  );
  const base = {
    effective_date: localDaysAgo(-1),
    source: "test",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: null,
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  };
  const meal = repo.recordDecision({
    ...base,
    kind: "meal_plan",
    domain: "nutrition",
    summary: "Meals refresh.",
    rationale: "The next food week is ready.",
    source_ref_type: "meal_plan",
    source_ref_key: String(mealPlan.id),
    action: { meal_plan_id: mealPlan.id },
  }).decision;
  const training = repo.recordDecision({
    ...base,
    kind: "training_structure",
    domain: "training",
    summary: "The next training block changes shape.",
    rationale: "Recent performance supports a different split.",
    source_ref_type: "plan_proposal",
    source_ref_key: "41",
    action: { proposal_id: 41 },
  }).decision;
  const recovery = repo.recordDecision({
    ...base,
    effective_date: localDaysAgo(-2),
    kind: "recovery_adjustment",
    domain: "recovery",
    summary: "The next recovery week gets an easier opening.",
    rationale: "Recent fatigue is worth absorbing.",
    source_ref_type: "plan_proposal",
    source_ref_key: "42",
    action: { proposal_id: 42 },
  }).decision;

  const agenda = repo.todayAgenda(localDaysAgo(0));
  const announced = [...agenda.primary, ...agenda.more].filter((item) => item.id.startsWith("announced-decision-"));
  assert.deepEqual(
    new Set(announced.map((item) => item.id)),
    new Set([meal, training, recovery].map((decision) => `announced-decision-${decision.id}`))
  );
  assert.equal(announced.length, 3, "no standing announcement is duplicated or hidden");
  assert.ok(
    agenda.more.some((item) => item.id.startsWith("announced-decision-")),
    "overflow remains quietly reachable behind more"
  );
  assert.ok(
    announced.some((item) => item.id === `announced-decision-${meal.id}` && item.kicker === "COMING UP"),
    "a newer cross-domain announcement does not hide the meal heads-up"
  );
});

test("live announcements do not appear on a routed historical agenda", () => {
  repo.recordDecision({
    effective_date: localDaysAgo(-1),
    kind: "training_structure",
    domain: "training",
    summary: "A live future change.",
    rationale: "This belongs only to the live Today view.",
    source: "test",
    source_ref_type: "plan_proposal",
    source_ref_key: "42",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "low",
    reversible: true,
    input_fingerprint: null,
    context: null,
    action: { proposal_id: 42 },
    specialist: null,
    applied_at: null,
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
  });

  const agenda = repo.todayAgenda(localDaysAgo(7));
  assert.ok(
    ![...agenda.primary, ...agenda.more].some((item) => item.id.startsWith("announced-decision-")),
    "historical Today stays archival instead of relabeling a live boundary"
  );
});

// ---- the hero is always the Brief; an empty day surfaces nothing else ----
test("a completely empty day → only the Brief hero, nothing else", () => {
  const a = repo.todayAgenda();
  assert.ok(a.hero, "there is always a hero");
  assert.equal(a.hero.id, "brief");
  assert.equal(a.hero.kind, "training");
  assert.equal(a.hero.tier, "hero");
  assert.equal(a.hero.client_card, "brief");
  assert.deepEqual(a.primary, [], "no primary candidates on a quiet day");
  assert.deepEqual(a.more, [], "no more candidates on a quiet day");
  assert.equal(a.total, 0, "total counts only surfaced non-hero candidates");
});

// ---- an empty-data source is omitted (priority <= 0 never surfaces) ----
test("the fuel candidate is omitted when nothing is logged (no 'log something' nudge)", () => {
  // No food logged today → getDayIntake count 0 → fuel must NOT surface. (This is the
  // canonical arbiter principle: the fuel surface is an evaluation glance, never a
  // capture prompt.)
  const a = repo.todayAgenda();
  assert.ok(!a.primary.some((c) => c.id === "fuel"), "fuel absent from primary");
  assert.ok(!a.more.some((c) => c.id === "fuel"), "fuel absent from more");
});

test("the fuel candidate surfaces once there's logged food to evaluate", () => {
  seedIntake(0, 600, { protein_g: 40 }); // one logged item today
  const a = repo.todayAgenda();
  const all = [...a.primary, ...a.more];
  const fuel = all.find((c) => c.id === "fuel");
  assert.ok(fuel, "fuel surfaces when something is logged");
  assert.equal(fuel.client_card, "fuel");
  assert.ok(fuel.priority > 0);
});

// ---- the budget: more than MAX candidates → exactly MAX primary, rest in more,
//      sorted by priority desc ----
test("more than TODAY_PRIMARY_MAX candidates → exactly MAX primary, rest in more, sorted", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  const MAX = repo.TODAY_PRIMARY_MAX;
  assert.ok(MAX >= 1, "the budget is at least one");

  // Seed FOUR distinct candidates of clearly-separated priority:
  //   reconcile  (~86) — a Garmin lift the watch logged, unlinked to a session
  //   draft      (~78) — a plan change waiting for review
  //   weekly     (~54) — a weekly read waiting in-app
  //   connection (~44) — a quiet cross-domain insight
  // Garmin strength activity with no linked session (isStrengthGarminType matches
  // 'strength_training'); date is today so it falls in the 30-day window. Foreign
  // keys are ON, so seed a real source first and reference its id.
  const today = new Date().toISOString().slice(0, 10);
  const src = repo.upsertGarminSource({ label: "default" });
  db.prepare(
    `INSERT INTO garmin_activities (source_id, external_id, type, name, date, session_id)
     VALUES (?, 'ext-9001', 'strength_training', 'Strength', ?, NULL)`
  ).run(src.id, today);
  repo.createProposal("stub", "auto: weekly review", "", { changes: [] }); // draft (default status)
  repo.addInsight({ kind: "weekly_read", text: "Solid week — held three sessions." });
  repo.addInsight({ kind: "connection", text: "Your easy runs cluster after short-sleep nights." });

  const a = repo.todayAgenda();
  assert.equal(a.total, 4, "all four are surfaced");
  assert.equal(a.primary.length, MAX, "exactly MAX render inline");
  assert.equal(a.more.length, 4 - MAX, "the rest collapse behind 'more'");

  // primary holds the highest-priority candidates; every primary outranks every more.
  const minPrimary = Math.min(...a.primary.map((c) => c.priority));
  const maxMore = a.more.length ? Math.max(...a.more.map((c) => c.priority)) : -Infinity;
  assert.ok(minPrimary >= maxMore, "the budget keeps the most important inline");

  // each list is itself sorted by priority desc (stable).
  for (const list of [a.primary, a.more]) {
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].priority >= list[i].priority, "candidates are priority-sorted");
    }
  }
  // the top surface today is the reconcile card (it has the highest deterministic priority).
  assert.equal(a.primary[0].id, "garmin-reconcile");
  // every surfaced candidate carries a positive priority (the omit rule held).
  assert.ok([...a.primary, ...a.more].every((c) => c.priority > 0));
});

// ---- the arbiter only DEMOTES: a candidate's final tier matches its bucket ----
test("surfaced candidates carry the tier of their bucket (primary vs more)", () => {
  repo.addInsight({ kind: "weekly_read", text: "A calm week." });
  repo.addInsight({ kind: "connection", text: "A small connection." });
  seedIntake(0, 500, { protein_g: 30 });
  const a = repo.todayAgenda();
  assert.ok(a.primary.every((c) => c.tier === "primary"));
  assert.ok(a.more.every((c) => c.tier === "more"));
  assert.equal(a.total, a.primary.length + a.more.length);
});

test("review posture renders agenda-only draft, health, and running candidates as generic cards", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  repo.createProposal("stub", "auto: weekly review", "", { changes: [] });
  repo.savePlanDay(1, "Run", "Endurance", [{ kind: "cardio", exercise: "Long run", target_distance_km: 16 }]);
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 190, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();
  repo.saveDayRead(localDaysAgo(0), { kind: "train", headline: "Train", why: "normal plan day" });

  const agenda = repo.todayAgenda();
  const all = [...agenda.primary, ...agenda.more];
  const byId = (id) => all.find((c) => c.id === id);

  assert.equal(byId("draft-proposals")?.client_card, undefined, "drafts must not name an unmounted rail slot");
  assert.equal(byId("draft-proposals")?.action?.kind, "plan-coach");
  assert.equal(byId("draft-proposals")?.kicker, "NEEDS YOUR DECISION");
  assert.ok(byId("draft-proposals")?.title);

  assert.equal(byId("health-focus")?.client_card, undefined, "health focus must render as generic agenda copy");
  assert.equal(byId("health-focus")?.action?.kind, "me-health-read");
  assert.ok(byId("health-focus")?.title);
  assert.ok(byId("health-focus")?.revision, "health attention is versioned by its material content");
  assert.equal(byId("health-focus")?.dismissible, true);

  assert.equal(byId("run-compliance")?.client_card, undefined, "run compliance must render as generic agenda copy");
  assert.equal(byId("run-compliance")?.action?.kind, "plan-endurance");
  assert.ok(byId("run-compliance")?.title);
});

// ---- the needs-your-decision rail must honor the autonomy ledger (VISION Amendment
// 1). A bounded change the brain already scheduled under lead mode stays a `draft`
// while its pending/announced decision carries it to a natural boundary with one-tap
// Undo — filtering on status alone re-nagged the athlete for a decision the team
// already made. Only a genuinely-unowned draft (the ask path) is the athlete's call. --
function nutritionCheckinDraft() {
  return repo.createProposal("stub", "nutrition: adaptive check-in", "", {
    kind: "nutrition_target",
    summary: "Small measured intake adjustment",
    nutrition: { target_kcal: 2_250, protein_g: 170, reason: "The measured trend missed its band." },
  });
}

function agendaDraftCandidate() {
  const agenda = repo.todayAgenda();
  return [...agenda.primary, ...agenda.more].find((c) => c.id === "draft-proposals");
}

test("a bounded nutrition check-in the brain scheduled under lead mode is not a needs-your-decision draft", () => {
  repo.setSettings({ lead_mode: "lead" });
  const proposal = nutritionCheckinDraft();
  const routed = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(routed.pending, true, "a bounded nutrition target quiet-applies at the next food-day boundary");
  assert.equal(repo.getProposal(proposal.id).status, "draft", "the proposal stays a draft while the ledger carries it");
  assert.equal(repo.getProposal(proposal.id).autonomy?.status, "pending", "the pending decision owns the draft");
  assert.equal(agendaDraftCandidate(), undefined, "an autonomy-owned draft never nags as a decision on Today");
});

test("bare duplicate training drafts never create a Today review wall in lead or announce-first posture", () => {
  for (const lead_mode of ["lead", "announce_first"]) {
    repo.setSettings({ lead_mode });
    repo.createProposal("stub", "auto: first training read", "", { summary: "First read", changes: [] });
    repo.createProposal("stub", "auto: second training read", "", { summary: "Second read", changes: [] });
    assert.equal(
      agendaDraftCandidate(),
      undefined,
      `${lead_mode} must not turn orphan cleanup into an athlete review task`
    );
    resetTables("plan_proposals", "brain_decisions", "brain_expectations", "brain_evaluations", "app_state");
  }
});

test("a genuinely-unowned draft still surfaces as a needs-your-decision item (review posture preserved)", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  const proposal = nutritionCheckinDraft();
  const routed = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  assert.equal(routed.tier, "ask", "review-everything still asks");
  assert.equal(repo.getProposal(proposal.id).autonomy?.status, "review", "the explicit ask reason is persisted");
  assert.equal(repo.getProposal(proposal.id).autonomy?.review_reason_code, "review_posture");
  const draft = agendaDraftCandidate();
  assert.ok(draft, "a draft awaiting the athlete's call is still surfaced");
  assert.equal(draft.kicker, "NEEDS YOUR DECISION");
  assert.equal(
    draft.body,
    "Small measured intake adjustment",
    "the card shows the draft's own athlete-facing summary, not the internal instruction"
  );
});

test("four bare same-intent legacy chat drafts never create a Today review wall in coach-led postures", () => {
  for (const lead_mode of ["lead", "announce_first"]) {
    repo.setSettings({ lead_mode });
    for (let i = 0; i < 4; i++) {
      repo.createProposal("claude", "chat: optimize bench reset", "", {
        summary: `Bench reset ${i + 1}`,
        changes: [
          { day_number: 1, exercise: "Flat Barbell Bench Press", sets: 2, target_weight: 105 + i },
          { day_number: 1, exercise: "Incline Barbell Bench Press", remove: true },
        ],
      });
    }
    assert.equal(
      agendaDraftCandidate(),
      undefined,
      `${lead_mode} keeps legacy chat repair off the athlete's Today rail`
    );
    resetTables("plan_proposals", "brain_decisions", "brain_expectations", "brain_evaluations", "app_state");
  }
});

test("review-everything preserves a bare chat draft as an explicit Review item", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  repo.createProposal("claude", "chat: restructure", "", { summary: "The split we discussed", days: [] });
  const draft = agendaDraftCandidate();
  assert.ok(draft);
  assert.equal(draft.kicker, "NEEDS YOUR DECISION");
  assert.equal(draft.body, "The split we discussed");
});

test("safety and user-lock asks stay visible in lead posture with explicit persisted reasons", () => {
  for (const [input, reason] of [
    [{ clamp_refused: true }, "safety_floor"],
    [{ user_locked: true }, "user_lock"],
  ]) {
    repo.setSettings({ lead_mode: "lead" });
    const proposal = repo.createProposal("stub", "auto: bounded nutrition read", "", {
      kind: "nutrition_target",
      summary: `Held for ${reason}`,
      nutrition: { target_kcal: 2_250, protein_g: 170 },
    });
    const held = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply", ...input });
    assert.equal(held.tier, "ask");
    assert.equal(held.review_reason_code, reason);
    assert.equal(repo.getProposal(proposal.id).autonomy?.status, "review");
    assert.equal(repo.getProposal(proposal.id).autonomy?.review_reason_code, reason);
    assert.ok(agendaDraftCandidate(), `${reason} must reach Today under lead posture`);
    resetTables("plan_proposals", "brain_decisions", "brain_expectations", "brain_evaluations", "app_state");
  }
});

test("an older safety review survives newer automatic and legacy-chat orphan noise", () => {
  repo.setSettings({ lead_mode: "lead" });
  const heldProposal = repo.createProposal("stub", "auto: bounded nutrition read", "", {
    kind: "nutrition_target",
    summary: "Protect the safety floor",
    nutrition: { target_kcal: 2_250, protein_g: 170 },
  });
  const held = applyProposalWithAutonomy(heldProposal.id, {
    requested_tier: "quiet_apply",
    clamp_refused: true,
  });
  assert.equal(held.review_reason_code, "safety_floor");

  for (let i = 0; i < 8; i++) {
    repo.createProposal("stub", `auto: newer nutrition noise ${i}`, "", {
      kind: "nutrition_target",
      summary: `Automatic read ${i}`,
      nutrition: { target_kcal: 2_260 + i, protein_g: 170 },
    });
  }
  for (let i = 0; i < 4; i++) {
    repo.createProposal("claude", "chat: optimize bench reset", "", {
      summary: `Chat bench noise ${i}`,
      changes: [{ day_number: 1, exercise: "Barbell Bench Press", sets: 2 }],
    });
  }

  const draft = agendaDraftCandidate();
  assert.ok(draft, "a bounded recent-history scan must not erase a real review hold");
  assert.equal(draft.kicker, "NEEDS YOUR DECISION");
  assert.equal(draft.body, "Protect the safety floor");
});

test("an older safety review survives nine newer generic requested-review decisions before the SQL limit", () => {
  repo.setSettings({ lead_mode: "lead" });
  const safety = repo.createProposal("stub", "auto: safety floor", "", {
    kind: "nutrition_target",
    summary: "Keep the safety-floor decision visible",
    nutrition: { target_kcal: 2_200, protein_g: 170 },
  });
  const held = applyProposalWithAutonomy(safety.id, {
    requested_tier: "quiet_apply",
    clamp_refused: true,
  });
  assert.equal(held.review_reason_code, "safety_floor");

  for (let i = 0; i < 9; i++) {
    const generic = repo.createProposal("stub", `auto: generic review ${i}`, "", {
      kind: "nutrition_target",
      summary: `Generic requested review ${i}`,
      nutrition: { target_kcal: 2_250 + i, protein_g: 170 },
    });
    const routed = applyProposalWithAutonomy(generic.id, { requested_tier: "ask" });
    assert.equal(routed.review_reason_code, "requested_review");
  }

  const draft = agendaDraftCandidate();
  assert.ok(draft, "attention-bearing review reasons are filtered before Today's bounded query");
  assert.equal(draft.body, "Keep the safety-floor decision visible");
});

test("a weekly budget hold is persisted but waits quietly off the Today rail under lead posture", () => {
  repo.setSettings({ lead_mode: "lead" });
  const first = nutritionCheckinDraft();
  assert.equal(applyProposalWithAutonomy(first.id, { requested_tier: "quiet_apply" }).pending, true);
  const second = repo.createProposal("stub", "auto: follow-up nutrition read", "", {
    kind: "nutrition_target",
    summary: "A second change needs a decision",
    nutrition: { target_kcal: 2_300, protein_g: 170 },
  });

  const held = applyProposalWithAutonomy(second.id, { requested_tier: "quiet_apply" });
  assert.equal(held.review_reason_code, "budget_review");
  assert.equal(repo.getProposal(second.id).autonomy?.review_reason_code, "budget_review");
  // Ruling B: a budget hold is a WAIT, not an ask — it lands automatically when the
  // surprise-budget week rolls (orphan adoption re-offers it), so it never interrupts Today.
  assert.equal(agendaDraftCandidate(), undefined, "a budget hold never nags as a decision on Today");
});

test("acknowledging a scheduled nutrition target drops it out of the Today rail", () => {
  repo.setSettings({ lead_mode: "lead" });
  const proposal = nutritionCheckinDraft();
  const routed = applyProposalWithAutonomy(proposal.id, { requested_tier: "quiet_apply" });
  applyDueAnnouncedDecisions(routed.effective_date);
  assert.equal(repo.getProposal(proposal.id).status, "applied", "the boundary applies the target");
  assert.equal(agendaDraftCandidate(), undefined, "an applied target is no longer a waiting decision");
});

test("opening a health read retires only that revision until material evidence changes", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 190, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();

  const first = repo.todayAgenda();
  const health = [...first.primary, ...first.more].find((item) => item.id === "health-focus");
  assert.ok(health?.revision);
  assert.doesNotMatch(health.title, /worth reading/i);

  const ack = repo.acknowledgeTodayAgendaCandidate("health-focus", health.revision);
  assert.equal(ack.ok, true);
  const quiet = repo.todayAgenda();
  assert.ok(![...quiet.primary, ...quiet.more].some((item) => item.id === "health-focus"));
  assert.ok(
    (repo.listActiveDirectives() || []).length > 0,
    "presentation acknowledgement never resolves plan-shaping directives"
  );

  // A materially different trigger value produces a new semantic revision and is
  // allowed back onto Today once; a simple reload/re-derive of identical content is not.
  seedHealthDoc(localDaysAgo(0), [
    marker("ApoB", 155, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 220, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();
  const changed = repo.todayAgenda();
  const resurfaced = [...changed.primary, ...changed.more].find((item) => item.id === "health-focus");
  assert.ok(resurfaced?.revision);
  assert.notEqual(resurfaced.revision, health.revision);
});

test("health attention never appears on a historical Today date", () => {
  seedHealthDoc("2025-12-01", [marker("LDL-C", 190, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  const agenda = repo.todayAgenda("2026-01-07");
  assert.ok(![...agenda.primary, ...agenda.more].some((item) => item.id === "health-focus"));
});

test("rest or easy Brief suppresses plan-forward agenda cards", () => {
  repo.savePlanDay(1, "Run", "Endurance", [{ kind: "cardio", exercise: "Easy run", target_distance_km: 10 }]);
  repo.savePlanDay(2, "Push", "Shoulders", [
    { exercise: "Lateral Raise", sets: 3, rep_low: 12, rep_high: 15, target_weight: 20 },
  ]);
  repo.saveDayRead(localDaysAgo(0), { kind: "train", headline: "Train", why: "normal plan day" });

  const openAgenda = repo.todayAgenda(localDaysAgo(0));
  const openIds = [...openAgenda.primary, ...openAgenda.more].map((c) => c.id);
  assert.ok(openIds.includes("week-ahead"), "precondition: plan-forward cards can surface on a normal plan day");
  assert.ok(openIds.includes("run-compliance"), "precondition: running compliance can surface on a normal plan day");

  for (const kind of ["rest", "easy"]) {
    resetTables("day_reads");
    repo.saveDayRead(localDaysAgo(0), { kind, headline: kind, why: "athlete chose recovery" });
    const agenda = repo.todayAgenda(localDaysAgo(0));
    const ids = [...agenda.primary, ...agenda.more].map((c) => c.id);

    assert.equal(agenda.hero.id, "brief", "the Brief still leads the day");
    assert.ok(!ids.includes("program-adjustments"), `${kind} day omits program adjustments`);
    assert.ok(!ids.includes("week-ahead"), `${kind} day omits the week-ahead training card`);
    assert.ok(!ids.includes("run-compliance"), `${kind} day omits running compliance`);
  }
});

test("cold same-day Brief cache does not speculate with plan-forward agenda cards", () => {
  repo.savePlanDay(1, "Run", "Endurance", [{ kind: "cardio", exercise: "Easy run", target_distance_km: 10 }]);
  resetTables("day_reads");

  const agenda = repo.todayAgenda(localDaysAgo(0));
  const ids = [...agenda.primary, ...agenda.more].map((c) => c.id);

  assert.equal(agenda.hero.id, "brief");
  assert.ok(!ids.includes("week-ahead"));
  assert.ok(!ids.includes("run-compliance"));
});

test("a routed Today date anchors weekly producers to that week", () => {
  repo.savePlanDay(1, "Run", "Endurance", [{ kind: "cardio", exercise: "Easy run", target_distance_km: 10 }]);
  repo.addActivity({ type: "run", date: isoDaysAgo(0), duration_min: 50, distance_km: 10 });

  const pastAgenda = repo.todayAgenda("2026-01-07");
  const past = [...pastAgenda.primary, ...pastAgenda.more];
  const pastRun = past.find((c) => c.id === "run-compliance");

  assert.equal(pastRun?.title, "0 of 10 km this week", "past Today links do not borrow the current week's run");
  assert.ok(!past.some((c) => c.id === "lately"), "past Today links do not surface current-week activity as lately");

  repo.saveDayRead(localDaysAgo(0), { kind: "train", headline: "Train", why: "normal plan day" });
  const liveAgenda = repo.todayAgenda(isoDaysAgo(0));
  const liveRun = [...liveAgenda.primary, ...liveAgenda.more].find((c) => c.id === "run-compliance");
  assert.equal(liveRun?.title, "10 of 10 km this week", "the live week still reads the current run");
});

// ---- one producer throwing never breaks the agenda (each read is isolated) ----
test("a throwing producer is isolated — the agenda still returns the rest", () => {
  // Seed two healthy candidates from INDEPENDENT sources, then force ONE producer to
  // genuinely throw by dropping a table it reads. The reconcile producer reads
  // garmin_activities; with that table gone its SQL throws, and the arbiter's
  // per-producer try/catch (safe()) must still return the hero + the other candidates.
  seedIntake(0, 700, { protein_g: 45 }); // fuel — independent of garmin
  repo.addInsight({ kind: "connection", text: "A genuine connection." }); // insight — independent

  // Capture the exact CREATE statement so we can restore the table verbatim after —
  // never poisoning the other test files that share this one DB process.
  const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='garmin_activities'`).get();
  db.exec(`DROP TABLE IF EXISTS garmin_activities`);
  try {
    const a = repo.todayAgenda(); // listUnreconciledGarminStrength throws inside safe()
    assert.ok(a.hero && a.hero.id === "brief", "the hero is always present");
    assert.ok(Array.isArray(a.primary) && Array.isArray(a.more), "the agenda still returns lists");
    // The two healthy candidates survived — one failing source can't sink the rest.
    const ids = [...a.primary, ...a.more].map((c) => c.id);
    assert.ok(ids.includes("fuel"), "fuel still surfaced");
    assert.ok(ids.includes("connection-insight"), "the insight still surfaced");
    // The reconcile candidate (whose source threw) is simply absent — never a crash.
    assert.ok(!ids.includes("garmin-reconcile"), "the throwing source is omitted, not fatal");
  } finally {
    if (ddl && ddl.sql) db.exec(ddl.sql); // restore the table verbatim for sibling suites
  }
});

// ---- the surprise budget: one NEW attention item inline per day -------------
test("the surprise budget introduces at most one brand-new attention item inline per day", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  // Seed three first-time attention items that would all like a Today slot:
  // a pressing health revision (~80), a waiting plan draft (~78), a weekly read (~54).
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 190, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();
  repo.createProposal("stub", "auto: weekly review", "", { changes: [] });
  repo.addInsight({ kind: "weekly_read", text: "Solid week — held three sessions." });

  const NEWCOMERS = ["health-focus", "draft-proposals", "weekly-read"];
  const first = repo.todayAgenda();
  const inlineNew = first.primary.map((c) => c.id).filter((id) => NEWCOMERS.includes(id));
  assert.deepEqual(inlineNew, ["health-focus"], "exactly the highest-priority newcomer is introduced inline");
  // The deferred newcomers still exist — waiting behind the quiet disclosure, never gone.
  const allIds = [...first.primary, ...first.more].map((c) => c.id);
  assert.ok(allIds.includes("draft-proposals") && allIds.includes("weekly-read"));

  // A second fetch the same day: the introduced item keeps its slot; the others
  // still wait (one new thing per DAY, not per fetch).
  const second = repo.todayAgenda();
  const secondNew = second.primary.map((c) => c.id).filter((id) => NEWCOMERS.includes(id));
  assert.deepEqual(secondNew, ["health-focus"]);
});

test("the surprise budget never shapes a routed historical date", () => {
  seedHealthDoc("2025-12-01", [marker("LDL-C", 190, { unit: "mg/dL", flag: "high" })]);
  repo.deriveDirectives();
  repo.createProposal("stub", "auto: weekly review", "", { changes: [] });

  // A historical route renders archival state; nothing is introduced or deferred,
  // and the intro ledger stays untouched.
  repo.todayAgenda("2026-01-07");
  assert.equal(repo.getAppState("today_agenda_intro"), null, "no introductions recorded for a routed date");
});

test("markIntroduced:false computes the same agenda without spending the day's allowance", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 190, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();

  // An agent's MCP read must not mark the newcomer introduced...
  const agentView = repo.todayAgenda(undefined, { markIntroduced: false });
  assert.ok(
    [...agentView.primary, ...agentView.more].some((c) => c.id === "health-focus"),
    "the agent still sees the same agenda shape"
  );
  assert.equal(repo.getAppState("today_agenda_intro"), null, "no ledger write from a read-only pass");

  // ...so the human's next open still gets the introduction.
  const humanView = repo.todayAgenda();
  assert.ok(
    humanView.primary.some((c) => c.id === "health-focus"),
    "the human open introduces the newcomer inline"
  );
  assert.ok(repo.getAppState("today_agenda_intro"), "the human pass records the introduction");
});

test("a genuinely-new item behind the disclosure is stamped waiting; the introduced one is not", () => {
  seedHealthDoc("2025-12-01", [
    marker("ApoB", 130, { unit: "mg/dL", flag: "high" }),
    marker("LDL-C", 190, { unit: "mg/dL", flag: "high" }),
  ]);
  repo.deriveDirectives();
  repo.addInsight({ kind: "weekly_read", text: "Solid week — held three sessions." });

  const a = repo.todayAgenda();
  const introduced = a.primary.find((c) => c.id === "health-focus");
  const deferredWeekly = a.more.find((c) => c.id === "weekly-read");
  assert.ok(introduced, "the day's one newcomer is inline");
  assert.equal(introduced.waiting, undefined, "an introduced item never reads as waiting");
  assert.equal(deferredWeekly?.waiting, true, "the deferred newcomer whispers from behind the disclosure");

  // A routed historical date renders archival state — nothing waits there.
  const past = repo.todayAgenda("2026-01-07");
  assert.ok([...past.primary, ...past.more].every((c) => !c.waiting));
});
