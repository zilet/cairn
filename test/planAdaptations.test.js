import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProposalWithAutonomy, expirePlanAdaptations, revertDecision } from "../dist/domain/brain/autonomy-service.js";
import { savePlanDayByPerson } from "../dist/domain/training/plan-save-use-case.js";
import {
  activePlanAdaptations,
  planAdaptationTitle,
  planDayAdaptations,
} from "../dist/repo/plan-adaptations.js";
import { patchBrainDecision } from "../dist/repo/brain-decisions.js";
import { brainChangesRead } from "../dist/domain/brain/changes-feed.js";
import { db, localDaysAgo, repo, savePlanDaySettled } from "./_seed.js";

// The live incident (2026-10-19): a taper edit took Back Squat, Deadlift, Bulgarian Split
// Squat and Calf Raise off the week's one leg day PERMANENTLY, two weeks before a half
// marathon, for an athlete whose primary goal is lifting. A change scoped to the race
// carries `until`; it lands now and the day after it the regular plan comes back by itself.

const UNTIL = localDaysAgo(-3);
const DAY_AFTER = localDaysAgo(-4);

const LOWER = [
  { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 155 },
  { exercise: "Barbell Deadlift", sets: 3, rep_low: 5, rep_high: 8, target_weight: 210 },
  { exercise: "Bulgarian Split Squat", sets: 2, rep_low: 8, rep_high: 10, target_weight: 80 },
  { exercise: "Lying Leg Curl", sets: 3, rep_low: 10, rep_high: 12, target_weight: 70 },
  { exercise: "Standing Calf Raise", sets: 3, rep_low: 10, rep_high: 15, target_weight: 90 },
];

function seedLower() {
  repo.setSettings({ lead_mode: "lead" });
  savePlanDaySettled(1, "Push A", "Chest and shoulders", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 },
  ]);
  savePlanDaySettled(2, "Lower", "The week's one leg day", LOWER);
}

function lowerItems() {
  return (repo.getPlanDay(2)?.items ?? []).map((item) => ({
    exercise: item.exercise,
    sets: item.sets,
    rep_low: item.rep_low,
    rep_high: item.rep_high,
    target_weight: item.target_weight,
  }));
}

function taperDraft(changes) {
  return repo.createProposal("stub", "background: chat signal", "", {
    summary: "Clear heavy leg lifts from Tuesday for taper before the half marathon",
    rationale: "Taper week: dropping heavy squat to keep legs fresh.",
    changes,
  });
}

function decisionForProposal(id) {
  return repo
    .listBrainDecisions({ limit: 50 })
    .find((row) => row.source_ref_type === "plan_proposal" && row.source_ref_key === String(id));
}

test("a change with `until` lands now and is remembered as an adaptation, in its own words", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Taper week: dropping heavy squat" },
    { day_number: 2, exercise: "Barbell Deadlift", remove: true, until: UNTIL, reason: "Taper: removing the hinge" },
    { day_number: 2, exercise: "Standing Calf Raise", target_weight: 70, until: UNTIL, reason: "Sparing calves" },
  ]);
  const result = repo.applyProposal(Number(proposal.id));
  assert.equal(result.ok, true, JSON.stringify(result));

  const names = lowerItems().map((item) => item.exercise);
  assert.equal(names.includes("Back Squat"), false, "the change itself lands at once");
  assert.equal(names.includes("Barbell Deadlift"), false);
  assert.ok(lowerItems().find((item) => item.exercise === "Standing Calf Raise").target_weight < 90);

  const active = activePlanAdaptations();
  assert.equal(active.length, 3);
  assert.deepEqual(active.map((row) => row.kind).sort(), ["removed", "removed", "updated"]);
  assert.ok(active.every((row) => row.until === UNTIL && row.day_number === 2));
  assert.equal(planDayAdaptations(2).length, 3, "the day-detail hook reads the same rows");
  assert.equal(planDayAdaptations(1).length, 0);

  const decision = decisionForProposal(proposal.id);
  assert.ok(decision, "the apply is on the ledger");
  assert.ok(active.every((row) => row.decision_id === decision.id), "each adaptation points at its decision");
  assert.match(decision.summary, /adapted (for the race )?until /);
  assert.doesNotMatch(decision.summary, /remov|dropp/i);
  assert.doesNotMatch(decision.rationale, /remov|dropp/i, "the coach's reasons are said in this path's words");
  assert.equal(decision.action.plan_adaptation.until, UNTIL);
  const title = planAdaptationTitle(decision.action);
  assert.match(title, /adapted (for the race )?until /);
  assert.doesNotMatch(title, /remov|dropp/i);
});

test("the first day after `until` puts every slot back, in its original place, once", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Taper week" },
    { day_number: 2, exercise: "Bulgarian Split Squat", remove: true, until: UNTIL, reason: "Taper week" },
    { day_number: 2, exercise: "Standing Calf Raise", remove: true, until: UNTIL, reason: "Taper week" },
    { day_number: 2, exercise: "Barbell Deadlift", target_weight: 185, rep_low: 3, rep_high: 5, until: UNTIL },
  ]);
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  assert.deepEqual(
    lowerItems().map((item) => item.exercise),
    ["Barbell Deadlift", "Lying Leg Curl"]
  );

  const early = expirePlanAdaptations(UNTIL);
  assert.equal(early.restored.length, 0, "nothing comes back while the adaptation is in force");

  const back = expirePlanAdaptations(DAY_AFTER);
  assert.equal(back.restored.length, 4);
  assert.deepEqual(lowerItems(), LOWER, "the regular day, in its original order and numbers");
  assert.ok(back.decision, "the restore is on the ledger");
  assert.match(back.decision.summary, /^Back to the regular plan/);
  assert.doesNotMatch(back.decision.summary, /remov|dropp|\bday \d+\b/i);
  assert.equal(back.decision.reversible, true, "with its own one-tap Undo");
  assert.equal(back.decision.status, "applied");
  assert.equal(activePlanAdaptations(DAY_AFTER).length, 0);

  const again = expirePlanAdaptations(DAY_AFTER);
  assert.equal(again.restored.length, 0, "idempotent: a second pass finds nothing due");
  assert.equal(again.decision, null);
  assert.deepEqual(lowerItems(), LOWER);
  const rows = db.prepare(`SELECT status, restore_decision_id FROM plan_adaptations`).all();
  assert.ok(rows.every((row) => row.status === "restored" && row.restore_decision_id === back.decision.id));
});

test("a person's own edit of an adapted slot wins: that restore is skipped and said", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Barbell Deadlift", remove: true, until: UNTIL, reason: "Taper week" },
    { day_number: 2, exercise: "Standing Calf Raise", target_weight: 70, until: UNTIL, reason: "Taper week" },
  ]);
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);

  // The athlete sets the calf raise themselves in the editor.
  const edited = lowerItems().map((item) =>
    item.exercise === "Standing Calf Raise" ? { ...item, target_weight: 100 } : item
  );
  savePlanDayByPerson(2, "Lower", "The week's one leg day", edited, { quality_override: true });

  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.equal(outcome.restored.length, 1, "the deadlift the athlete never touched comes back");
  assert.equal(outcome.skipped.length, 1);
  assert.equal(outcome.skipped[0].exercise, "Standing Calf Raise");
  assert.match(outcome.skipped[0].note, /by hand/);
  const after = lowerItems();
  assert.equal(after.find((item) => item.exercise === "Standing Calf Raise").target_weight, 100, "theirs stands");
  assert.deepEqual(
    after.map((item) => item.exercise),
    LOWER.map((item) => item.exercise),
    "the deadlift is back where it stood"
  );
  assert.ok(
    (outcome.decision?.context?.skipped ?? []).some((row) => row.exercise === "Standing Calf Raise"),
    "the skip is noted on the restore's own record"
  );
});

test("an end date already behind us refuses the change instead of landing it for good", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Back Squat", remove: true, until: localDaysAgo(2), reason: "Taper week" },
  ]);
  const result = repo.applyProposal(Number(proposal.id));
  assert.equal(result.ok, false);
  assert.ok(lowerItems().some((item) => item.exercise === "Back Squat"), "nothing was saved");
  assert.equal(activePlanAdaptations().length, 0);
});

test("re-scoping an adapted slot still returns to the REGULAR plan, not the first trim", () => {
  seedLower();
  const first = taperDraft([{ day_number: 2, exercise: "Back Squat", target_weight: 135, until: UNTIL }]);
  assert.equal(repo.applyProposal(Number(first.id)).ok, true);
  const second = taperDraft([{ day_number: 2, exercise: "Back Squat", target_weight: 115, until: UNTIL }]);
  assert.equal(repo.applyProposal(Number(second.id)).ok, true);
  assert.equal(activePlanAdaptations().length, 1, "one live adaptation per slot");
  expirePlanAdaptations(DAY_AFTER);
  assert.equal(lowerItems().find((item) => item.exercise === "Back Squat").target_weight, 155);
});

test("the change's own Undo cancels its adaptations — nothing is restored twice", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Standing Calf Raise", target_weight: 70, until: UNTIL, reason: "Taper week" },
  ]);
  const applied = applyProposalWithAutonomy(Number(proposal.id), { explicit_user_request: true });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.applied === false, false, "it landed now");
  assert.equal(activePlanAdaptations().length, 1);
  const undone = revertDecision(Number(applied.decision.id));
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(activePlanAdaptations().length, 0);
  assert.equal(db.prepare(`SELECT status FROM plan_adaptations`).get().status, "cancelled");
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.equal(outcome.restored.length, 0);
  assert.equal(lowerItems().find((item) => item.exercise === "Standing Calf Raise").target_weight, 90);
});

// ---------- the plan moving under an adaptation (fix round) ----------

function rowsByExercise() {
  return Object.fromEntries(
    db.prepare(`SELECT exercise, status, resolution_note FROM plan_adaptations ORDER BY id`).all().map((row) => [row.exercise, row])
  );
}

test("a restructure between the change and its end supersedes it: nothing comes back into the rebuilt day", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Taper week" },
    { day_number: 2, exercise: "Standing Calf Raise", target_weight: 70, until: UNTIL, reason: "Taper week" },
  ]);
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  assert.equal(activePlanAdaptations().length, 2);

  // A new split: day 2 is an upper day now.
  repo.replacePlan(
    [
      { day_number: 1, name: "Push A", focus: "Chest and shoulders", items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 }] },
      { day_number: 2, name: "Upper", focus: "Back and arms", items: [{ exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 10, target_weight: 135 }, { exercise: "Standing Calf Raise", sets: 3, rep_low: 10, rep_high: 15, target_weight: 80 }] },
    ],
    { by: "restructure" }
  );
  assert.equal(activePlanAdaptations().length, 0, "the rebuilt day holds no live adaptation");
  const rows = rowsByExercise();
  assert.equal(rows["Back Squat"].status, "superseded");
  assert.match(rows["Back Squat"].resolution_note, /rebuilt as Upper/);

  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.equal(outcome.restored.length, 0);
  const items = repo.getPlanDay(2).items;
  assert.equal(items.some((item) => item.exercise === "Back Squat"), false, "no squat reinserted into an Upper day");
  assert.equal(items.find((item) => item.exercise === "Standing Calf Raise").target_weight, 80, "the new prescription stands");
});

test("a same-name restructure that rewrites the day supersedes what it rewrote, and keeps what it left alone", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Taper week" },
    { day_number: 2, exercise: "Standing Calf Raise", target_weight: 70, until: UNTIL, reason: "Taper week" },
    { day_number: 2, exercise: "Lying Leg Curl", target_weight: 60, until: UNTIL, reason: "Taper week" },
  ]);
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  const current = lowerItems().filter((item) => item.exercise !== "Barbell Deadlift");
  // The rewrite drops the deadlift (the day's movement set moved) and rewrites the calf
  // raise; the leg curl is left exactly as the adaptation wrote it.
  repo.replacePlan(
    [
      { day_number: 1, name: "Push A", focus: "Chest and shoulders", items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 135 }] },
      {
        day_number: 2,
        name: "Lower",
        focus: "The week's one leg day",
        items: current.map((item) => (item.exercise === "Standing Calf Raise" ? { ...item, target_weight: 95 } : item)),
      },
    ],
    { by: "restructure" }
  );
  const rows = rowsByExercise();
  assert.equal(rows["Back Squat"].status, "superseded", "a lift set aside does not come back into a rewritten day");
  assert.equal(rows["Standing Calf Raise"].status, "superseded", "a rewritten slot is the new plan's");
  assert.equal(rows["Lying Leg Curl"].status, "active", "an untouched slot keeps its adaptation");
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.deepEqual(outcome.restored.map((row) => row.exercise), ["Lying Leg Curl"]);
  const after = lowerItems();
  assert.equal(after.find((item) => item.exercise === "Lying Leg Curl").target_weight, 70);
  assert.equal(after.find((item) => item.exercise === "Standing Calf Raise").target_weight, 95);
  assert.equal(after.some((item) => item.exercise === "Back Squat"), false);
});

test("a lift set aside stays out when the day's movements changed since — and the restore says why", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Taper week" },
    { day_number: 2, exercise: "Standing Calf Raise", target_weight: 70, until: UNTIL, reason: "Taper week" },
  ]);
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  // The athlete puts a leg press where the squat stood, by hand.
  const edited = [...lowerItems(), { exercise: "Leg Press", sets: 3, rep_low: 8, rep_high: 12, target_weight: 200 }];
  savePlanDayByPerson(2, "Lower", "The week's one leg day", edited, { quality_override: true });

  const outcome = expirePlanAdaptations(DAY_AFTER);
  const squat = outcome.skipped.find((row) => row.exercise === "Back Squat");
  assert.ok(squat, "the squat's return is skipped");
  assert.match(squat.note, /changed since/);
  assert.deepEqual(outcome.restored.map((row) => row.exercise), ["Standing Calf Raise"], "the untouched slot still comes back");
  const after = lowerItems();
  assert.equal(after.some((item) => item.exercise === "Back Squat"), false);
  assert.ok(after.some((item) => item.exercise === "Leg Press"), "theirs stands");
  assert.ok(
    (outcome.decision?.context?.skipped ?? []).some((row) => row.exercise === "Back Squat"),
    "the skip is on the restore's record"
  );
});

test("undoing the after-the-race restore keeps the adaptation one more week, then it ends by itself", () => {
  seedLower();
  const proposal = taperDraft([{ day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Taper week" }]);
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  const back = expirePlanAdaptations(DAY_AFTER);
  assert.equal(back.restored.length, 1);
  assert.match(back.decision.rationale, /Undo keeps the (race )?adaptation one more week/);
  assert.ok(lowerItems().some((item) => item.exercise === "Back Squat"));
  const feedRow = brainChangesRead()
    .days.flatMap((day) => day.changes)
    .find((row) => row.id === back.decision.id);
  assert.deepEqual(feedRow?.undo, { available: true, label: "Keep the race adaptation one more week" });

  const undone = revertDecision(Number(back.decision.id));
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.match(undone.message, /^Kept the (race )?adaptation one more week/);
  assert.match(undone.decision.rationale, /^Kept the (race )?adaptation one more week/);
  const weekOn = localDaysAgo(-7);
  assert.equal(undone.kept_until, weekOn);
  assert.equal(lowerItems().some((item) => item.exercise === "Back Squat"), false, "the adaptation is back in force");
  const live = activePlanAdaptations();
  assert.equal(live.length, 1);
  assert.equal(live[0].until, weekOn, "for one more week from today");

  assert.equal(expirePlanAdaptations(weekOn).restored.length, 0, "still in force on its new last day");
  const again = expirePlanAdaptations(localDaysAgo(-8));
  assert.equal(again.restored.length, 1, "and it ends by itself the day after");
  assert.deepEqual(lowerItems(), LOWER);
});

test("a proposal mixing scoped and lasting changes says each as what it is", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Taper week" },
    { day_number: 2, exercise: "Lying Leg Curl", target_weight: 75, reason: "Leg curl has been moving well" },
  ]);
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  assert.equal(activePlanAdaptations().length, 1, "only the scoped part is an adaptation");
  const decision = decisionForProposal(proposal.id);
  assert.match(decision.summary, /^Back Squat adapted (for the race )?until /);
  assert.match(decision.summary, /it returns to the regular plan/);
  assert.match(decision.summary, /Lying Leg Curl changes for good\./);
  assert.doesNotMatch(decision.summary, /every lift/);
  assert.match(decision.rationale, /The change to Lying Leg Curl is a lasting one\./);
  assert.match(decision.rationale, /Leg curl has been moving well\./);
  assert.doesNotMatch(decision.rationale, /every lift goes back/, "a lasting change is never called temporary");

  expirePlanAdaptations(DAY_AFTER);
  assert.equal(lowerItems().find((item) => item.exercise === "Lying Leg Curl").target_weight, 75, "the lasting change stays");
  assert.ok(lowerItems().some((item) => item.exercise === "Back Squat"));
});

test("an adaptation made around pain asks for its return instead of re-loading the area by itself", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Knee pain on deep squats; resting it for the race" },
  ]);
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.equal(outcome.restored.length, 0, "nothing re-loaded silently");
  assert.equal(outcome.asked.length, 1);
  assert.equal(lowerItems().some((item) => item.exercise === "Back Squat"), false);
  assert.ok(outcome.ask, "an ask is on the ledger");
  assert.equal(outcome.ask.status, "review");
  assert.equal(outcome.ask.autonomy_tier, "ask");
  assert.match(outcome.ask.summary, /bring Back Squat back to the regular plan\?/);
  assert.doesNotMatch(outcome.ask.summary, /remov|dropp/i);
  assert.equal(db.prepare(`SELECT status FROM plan_adaptations`).get().status, "asked");
  assert.equal(activePlanAdaptations(DAY_AFTER).length, 0);
  assert.equal(expirePlanAdaptations(localDaysAgo(-5)).ask ?? null, null, "asked once, not every morning");

  // The athlete says yes: the squat comes back with its regular sets and reps (its load
  // is grounded the way any movement added back is — off the log, never a stale number).
  const yes = repo.applyProposal(Number(outcome.ask.source_ref_key));
  assert.equal(yes.ok, true, JSON.stringify(yes));
  const squat = lowerItems().find((item) => item.exercise === "Back Squat");
  assert.ok(squat, "the squat is back on the day");
  assert.deepEqual([squat.sets, squat.rep_low, squat.rep_high], [3, 5, 8]);
});

test("a clinical-tier decision asks too, whatever its reason says", () => {
  seedLower();
  const proposal = taperDraft([
    { day_number: 2, exercise: "Barbell Deadlift", remove: true, until: UNTIL, reason: "Taper week" },
  ]);
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true);
  const decision = decisionForProposal(proposal.id);
  patchBrainDecision(decision.id, { risk_class: "clinical" });
  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.equal(outcome.restored.length, 0);
  assert.equal(outcome.asked.length, 1);
  assert.equal(outcome.ask?.status, "review");
});

test("a person's later request through chat on the same slot supersedes its restore; the rest still comes back", () => {
  seedLower();
  const taper = taperDraft([
    { day_number: 2, exercise: "Back Squat", remove: true, until: UNTIL, reason: "Taper week" },
    { day_number: 2, exercise: "Standing Calf Raise", target_weight: 70, until: UNTIL, reason: "Taper week" },
  ]);
  assert.equal(repo.applyProposal(Number(taper.id)).ok, true);
  // "Put my calf raise at 80" — the athlete's own words, a permanent change.
  const chat = repo.createProposal("stub", "chat: plan_update", "", {
    summary: "Calf raise to 80",
    rationale: "The athlete asked for it.",
    changes: [{ day_number: 2, exercise: "Standing Calf Raise", target_weight: 80, reason: "You asked for 80" }],
  });
  const applied = applyProposalWithAutonomy(Number(chat.id), { explicit_user_request: true });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const rows = rowsByExercise();
  assert.equal(rows["Standing Calf Raise"].status, "superseded");
  assert.match(rows["Standing Calf Raise"].resolution_note, /at your request/);
  assert.equal(rows["Back Squat"].status, "active");

  const outcome = expirePlanAdaptations(DAY_AFTER);
  assert.deepEqual(outcome.restored.map((row) => row.exercise), ["Back Squat"]);
  const after = lowerItems();
  assert.equal(after.find((item) => item.exercise === "Standing Calf Raise").target_weight, 80, "theirs stands");
  assert.ok(after.some((item) => item.exercise === "Back Squat"));
});

test("a coaching change that is not the athlete's request does not win over the restore", () => {
  seedLower();
  const taper = taperDraft([
    { day_number: 2, exercise: "Standing Calf Raise", target_weight: 70, until: UNTIL, reason: "Taper week" },
  ]);
  assert.equal(repo.applyProposal(Number(taper.id)).ok, true);
  const step = repo.createProposal("auto-progression", "progression", "", {
    summary: "Calf raise step",
    changes: [{ day_number: 2, exercise: "Standing Calf Raise", target_weight: 75, reason: "Earned step" }],
  });
  assert.equal(repo.applyProposal(Number(step.id)).ok, true);
  assert.equal(rowsByExercise()["Standing Calf Raise"].status, "active");
  expirePlanAdaptations(DAY_AFTER);
  assert.equal(lowerItems().find((item) => item.exercise === "Standing Calf Raise").target_weight, 90);
});

test("a one-day adaptation (until = today) lands now and the regular plan returns tomorrow", () => {
  seedLower();
  const today = localDaysAgo(0);
  const proposal = taperDraft([{ day_number: 2, exercise: "Back Squat", remove: true, until: today, reason: "Legs saturated" }]);
  assert.equal(repo.applyProposal(Number(proposal.id)).ok, true, "today is a valid end date");
  assert.equal(activePlanAdaptations(today).length, 1);
  assert.equal(expirePlanAdaptations(today).restored.length, 0, "in force through today");
  assert.equal(expirePlanAdaptations(localDaysAgo(-1)).restored.length, 1, "back the day after");
  assert.deepEqual(lowerItems(), LOWER);
});
