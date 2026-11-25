// Holds that exist only because the system could not make up its mind
// (autonomy-service.ts resolveUndecidedHolds, run inside adoptOrphanedDrafts):
//   - a `stale_snapshot` hold gets the thaw's answer even when an older pass stamped it:
//     its producer reads it again ONCE (attemptStaleDraftRegeneration, allowRebase), or
//     it is retired quietly with its receipt — never re-stamped by hand, so plan drift, a
//     nutrition draft or an unverified legacy draft never lands on stale evidence;
//   - a `requested_review` hold (a caller's requested ask, never a person's) on a bounded
//     change is re-decided once — under lead only;
//   - the clinician floor, a lock, a refused clamp and review_everything keep their holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptOrphanedDrafts, applyProposalWithAutonomy } from "../dist/domain/brain/autonomy-service.js";
import { db, localDaysAgo, repo } from "./_seed.js";

function backdateHours(id, hoursAgo) {
  const iso = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE plan_proposals SET created_at = ? WHERE id = ?").run(iso, Number(id));
}

function seedPlan() {
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest" });
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 75 },
  ]);
}

function draft(changes, extra = {}) {
  return repo.createProposal("stub", "a coach read", "", {
    summary: "Nudge the press",
    rationale: "Top of the range.",
    changes,
    ...extra,
  });
}

/** The plan moves under the draft (another day), so its snapshot reads stale. */
function movePlan() {
  repo.savePlanDay(3, "Pull", "back", [
    { exercise: "Barbell Row", sets: 3, rep_low: 6, rep_high: 8, target_weight: 135 },
  ]);
}

/** A set logged yesterday: only the TRAINING evidence moves, never the plan. */
function logYesterday() {
  const ex = repo.findExercise("Barbell Bench Press");
  const session = repo.getOrCreateSession(localDaysAgo(1), null);
  db.prepare(
    `INSERT INTO logged_sets (session_id, exercise_id, set_number, weight, reps, rir) VALUES (?, ?, 1, 135, 8, 2)`
  ).run(session.id, ex.id);
}

function staleHold(p, input = {}, move = movePlan) {
  move();
  const held = applyProposalWithAutonomy(Number(p.id), input);
  assert.equal(held.review_reason_code, "stale_snapshot", JSON.stringify(held));
  backdateHours(p.id, 3);
  return held;
}

const liveHolds = () => repo.listBrainDecisions({ status: "review", limit: 50 });
const decisionsFor = (id) => repo.listBrainDecisions({ limit: 50 }).filter((d) => d.source_ref_key === String(id));
const benchLoad = () => repo.getPlanDay(1).items.find((i) => i.exercise === "Barbell Bench Press").target_weight;

test("a stale hold whose PLAN moved is never re-stamped: it is retired quietly, nothing applied", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlan();
  const p = draft([{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 140 }]);
  staleHold(p);
  const before = repo.listProposals(50).length;
  const sweep = adoptOrphanedDrafts();
  assert.ok(sweep.undecided >= 1);
  assert.equal(repo.getProposal(p.id).status, "superseded");
  assert.equal(repo.listProposals(50).length, before, "no copy written");
  assert.equal(benchLoad(), 135, "nothing landed on stale evidence");
  assert.equal(liveHolds().length, 0, "nothing waits on the athlete");
  const receipt = decisionsFor(p.id).find((d) => d.status === "superseded" && d.context?.thaw_receipt === true);
  assert.ok(receipt, "a readable receipt");
});

test("a stale hold only the training log moved is read again by its producer, once, and lands", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlan();
  const p = draft([{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 140 }]);
  staleHold(p, {}, logYesterday);
  adoptOrphanedDrafts();
  assert.equal(repo.getProposal(p.id).status, "superseded");
  const replacement = repo.listProposals(20).find((row) => row.agent === "stub" && Number(row.id) !== Number(p.id));
  assert.ok(replacement, "rebased against today");
  assert.equal(replacement.status, "applied");
  assert.equal(benchLoad(), 140);
  assert.equal(liveHolds().length, 0);
  // Never a second time: the sweep after finds nothing to do.
  const count = repo.listProposals(50).length;
  adoptOrphanedDrafts();
  assert.equal(repo.listProposals(50).length, count);
});

test("the plan moving AFTER a training-only stale hold was written still retires it", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlan();
  const p = draft([{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 140 }]);
  staleHold(p, {}, logYesterday);
  // The plan itself moves on after the hold: the bench has since stepped past the draft.
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 145 },
    { exercise: "Overhead Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 75 },
  ]);
  const before = repo.listProposals(50).length;
  adoptOrphanedDrafts();
  assert.equal(repo.getProposal(p.id).status, "superseded");
  assert.equal(repo.listProposals(50).length, before, "no rebased copy");
  assert.equal(benchLoad(), 145, "the draft never takes the load back");
  assert.equal(liveHolds().length, 0);
});

test("a nutrition-only stale hold is never landed on stale evidence: it is retired", () => {
  repo.setSettings({ lead_mode: "lead" });
  const p = repo.createProposal("stub", "nutrition: a read", "", {
    kind: "nutrition_target",
    summary: "A little more food",
    nutrition: { target_kcal: 2300, protein_g: 170 },
  });
  // A legacy draft with no evidence snapshot: unverified, held stale at its first gate.
  db.prepare(`UPDATE plan_proposals SET parsed_json = json_remove(parsed_json, '$.proposal_truth') WHERE id = ?`).run(
    Number(p.id)
  );
  staleHold(p, {}, () => {});
  adoptOrphanedDrafts();
  assert.equal(repo.getProposal(p.id).status, "superseded");
  assert.equal(repo.getActiveNutritionTarget(), null, "no target landed");
  assert.equal(liveHolds().length, 0);
});

test("a locked or clamp-refused draft held stale never lands", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlan();
  for (const input of [{ user_locked: true }, { clamp_refused: true }]) {
    const p = draft([{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 140 }]);
    const held = staleHold(p, input, logYesterday);
    assert.equal(held.decision.context.policy_inputs[Object.keys(input)[0]], true, "the routing inputs ride the hold");
    adoptOrphanedDrafts();
    assert.equal(benchLoad(), 135, JSON.stringify(input));
    assert.equal(decisionsFor(p.id).filter((d) => d.status === "applied").length, 0);
    assert.equal(repo.getBrainDecision(held.decision.id).status, "review", "the floor keeps its hold");
  }
});

test("under review_everything a stale hold is left exactly as it is", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  seedPlan();
  const p = draft([{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 140 }]);
  const held = staleHold(p, {}, logYesterday);
  adoptOrphanedDrafts();
  assert.equal(repo.getProposal(p.id).status, "draft", "nothing set aside on their behalf");
  assert.equal(repo.getBrainDecision(held.decision.id).status, "review");
  assert.equal(benchLoad(), 135);
});

test("a clinical stale hold is left exactly as it is", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlan();
  const p = draft([{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 140 }]);
  const held = staleHold(p, { clinical: true });
  adoptOrphanedDrafts();
  assert.equal(repo.getProposal(p.id).status, "draft");
  const hold = repo.getBrainDecision(held.decision.id);
  assert.equal(hold.status, "review");
  assert.equal(hold.autonomy_tier, "clinician");
});

test("under lead a caller's requested review on a bounded change is re-decided once, announced", () => {
  repo.setSettings({ lead_mode: "lead" });
  const p = repo.createProposal("stub", "nutrition: a read", "", {
    kind: "nutrition_target",
    summary: "A little more food",
    nutrition: { target_kcal: 2300, protein_g: 170 },
  });
  const held = applyProposalWithAutonomy(Number(p.id), { requested_tier: "ask" });
  assert.equal(held.review_reason_code, "requested_review");
  backdateHours(p.id, 3);
  adoptOrphanedDrafts();
  assert.equal(liveHolds().length, 0, "not parked");
  assert.ok(
    decisionsFor(p.id).some((d) => d.status === "announced"),
    "announced with its heads-up — the caller's ask carried as announce, never landed quietly"
  );
});

test("announce_first keeps a model's requested review as documented", () => {
  repo.setSettings({ lead_mode: "announce_first" });
  seedPlan();
  const p = draft([{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 140 }]);
  const held = applyProposalWithAutonomy(Number(p.id), { requested_tier: "ask" });
  assert.equal(held.review_reason_code, "requested_review");
  backdateHours(p.id, 3);
  adoptOrphanedDrafts();
  assert.equal(repo.getBrainDecision(held.decision.id).status, "review");
  assert.equal(repo.getProposal(p.id).status, "draft");
  assert.equal(decisionsFor(p.id).some((d) => d.status === "announced"), false);
});

test("a lock is the person's own word: a user_lock hold is untouched", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPlan();
  const p = draft([{ day_number: 1, exercise: "Barbell Bench Press", target_weight: 140 }]);
  const held = applyProposalWithAutonomy(Number(p.id), { user_locked: true });
  assert.equal(held.review_reason_code, "user_lock");
  backdateHours(p.id, 3);
  adoptOrphanedDrafts();
  assert.equal(repo.getBrainDecision(held.decision.id).status, "review");
  assert.equal(repo.getProposal(p.id).status, "draft");
});
