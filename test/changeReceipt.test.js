// changeReceipt.test.js — one uniform receipt for a change the server made
// (src/repo/change-receipt.ts, src/contracts/change-receipt.ts): built from a
// brain_decisions row or a plan_adaptations row, carried by every Changes feed item and
// by the chat reply for exactly the changes that landed that turn, and re-read against
// the ledger so an Undo pressed since reads as undone.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDueAnnouncedDecisions,
  applyProposalWithAutonomy,
  revertDecision,
} from "../dist/domain/brain/autonomy-service.js";
import { brainChangesRead } from "../dist/domain/brain/changes-feed.js";
import {
  brainDecisionIdFloor,
  brainDecisionIdsAfter,
  receiptFromBrainDecision,
  receiptFromPlanAdaptation,
  receiptUntilWords,
  refreshChangeReceipts,
  withChangeReceipts,
} from "../dist/repo/change-receipt.js";
import { applyChatActions } from "../dist/chatTurns.js";
import { chatChangeReceipts } from "../dist/chat-reconcile.js";
import * as repo from "../dist/repo.js";
import { saveBrainRollback } from "../dist/repo/brain-decisions.js";
import { db } from "../dist/db.js";

const PRESS = "ZReceipt Press";

function seedPress(weight = 100) {
  repo.savePlanDay(1, "Push", "chest", [{ exercise: PRESS, sets: 3, rep_low: 6, rep_high: 8, target_weight: weight }]);
}

function pressDraft(targetWeight = 105) {
  return repo.createProposal("stub", "auto: press step", "", {
    summary: `Raise the ${PRESS} to ${targetWeight}`,
    rationale: "Every set landed at the top of the range last week, so the load steps up.",
    changes: [{ day_number: 1, exercise: PRESS, target_weight: targetWeight, reason: "top of the range" }],
  });
}

let fingerprint = 0;
function decisionRow(overrides = {}) {
  return repo.recordDecision({
    effective_date: null,
    kind: "training_target",
    domain: "training",
    summary: "Bench press target raised",
    rationale: null,
    source: "test",
    source_ref_type: null,
    source_ref_key: null,
    status: "applied",
    autonomy_tier: "quiet_apply",
    risk_class: "low",
    reversible: true,
    input_fingerprint: `receipt-test-${++fingerprint}`,
    context: null,
    action: null,
    specialist: null,
    applied_at: new Date().toISOString(),
    reverted_at: null,
    superseded_by: null,
    evaluator_version: null,
    ...overrides,
  }).decision;
}

test("a decision's receipt mirrors what Undo would take right now: announced holds, applied restores, put back is undone", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const routed = applyProposalWithAutonomy(Number(pressDraft(105).id), { requested_tier: "ask" });
  const id = Number(routed.decision.id);

  let receipt = receiptFromBrainDecision(repo.getBrainDecision(id));
  assert.equal(receipt.key, `decision:${id}`);
  assert.equal(receipt.status, "scheduled", "announced: decided, landing on its own");
  assert.match(receipt.status_words, /^Lands (soon|today|tomorrow|[A-Z][a-z]+)/, "the feed's words, never 'Waiting on you'");
  assert.doesNotMatch(receipt.status_words, /waiting/i);
  assert.deepEqual(receipt.undo, { kind: "brain_decision", id }, "the hold is its Undo");
  assert.ok(receipt.what);

  applyDueAnnouncedDecisions(routed.effective_date);
  receipt = receiptFromBrainDecision(repo.getBrainDecision(id));
  assert.equal(receipt.status, "applied");
  assert.deepEqual(receipt.undo, { kind: "brain_decision", id }, "the snapshot exists, so Undo restores");
  assert.match(receipt.when, /^\d{4}-\d{2}-\d{2}$/, "the day it applies from");

  assert.equal(receipt.status_words, null, "an applied change needs no state words");

  assert.equal(revertDecision(id, "user undo").ok, true);
  receipt = receiptFromBrainDecision(repo.getBrainDecision(id));
  assert.equal(receipt.status, "undone");
  assert.equal(receipt.status_words, "Put back");
  assert.equal(receipt.undo, null);
});

test("a scheduled receipt says the feed's own landing words for the same decision", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const routed = applyProposalWithAutonomy(Number(pressDraft(105).id), { requested_tier: "ask" });
  const [row] = brainChangesRead().days.flatMap((d) => d.changes);
  assert.equal(row.id, Number(routed.decision.id));
  assert.equal(row.state, "announced");
  assert.equal(row.receipt.status, "scheduled");
  assert.equal(row.receipt.status_words, row.status_line, "one wording, never forked");
});

test("a stored receipt whose change was later refused or held for a look reads not-landed, calmly", () => {
  const decision = decisionRow({ status: "announced", applied_at: null, effective_date: "2026-10-23" });
  const stored = receiptFromBrainDecision(repo.getBrainDecision(decision.id), { asOf: "2026-10-20" });
  assert.equal(stored.status, "scheduled");
  assert.equal(stored.status_words, "Lands Friday");
  for (const status of ["rejected", "observed", "review"]) {
    db.prepare(`UPDATE brain_decisions SET status = ? WHERE id = ?`).run(status, decision.id);
    const [again] = refreshChangeReceipts([stored]);
    assert.equal(again.status, "not_landed", status);
    assert.equal(again.status_words, "Didn't land");
    assert.equal(again.undo, null);
    assert.equal(again.what, stored.what, "the words stay as they were said");
  }
  // A record that is gone keeps its words and loses its Undo (unchanged).
  const [gone] = refreshChangeReceipts([{ ...stored, key: "decision:999999" }]);
  assert.equal(gone.status, "scheduled");
  assert.equal(gone.undo, null);
  // A receipt stored under the old name for a scheduled change still reads.
  const [legacy] = refreshChangeReceipts([{ ...stored, key: "decision:999998", status: "waiting" }]);
  assert.equal(legacy.status, "scheduled");
});

test("no receipt for a change that neither landed nor waits; no Undo without a snapshot", () => {
  for (const status of ["observed", "review", "rejected"]) {
    assert.equal(receiptFromBrainDecision(decisionRow({ status, applied_at: null })), null, status);
  }
  const bare = receiptFromBrainDecision(decisionRow());
  assert.equal(bare.status, "applied");
  assert.equal(bare.undo, null, "an applied change with no stored snapshot offers no Undo");
  assert.equal(bare.what, "Bench press target raised");
  const irreversible = receiptFromBrainDecision(decisionRow({ reversible: false }));
  assert.equal(irreversible.undo, null);
});

test("a race adaptation's receipt carries its end in words", () => {
  repo.setProfile({
    endurance_goal: { mode: "race", event: "Riverside Half", date: "2026-11-01", distance_km: 21.1 },
  });
  const scoped = receiptFromBrainDecision(
    decisionRow({
      summary: "Back Squat adapted for the race until Nov 1",
      action: {
        changes: [{ day_number: 3, exercise: "Back Squat", sets: 2, until: "2026-11-01" }],
        plan_adaptation: { until: "2026-11-01", for_race: true },
      },
    }),
    { what: "Back Squat adapted for the race until Nov 1" }
  );
  assert.equal(scoped.until, "2026-11-01");
  assert.equal(scoped.until_words, "Ends after the race (Nov 1)");
  assert.equal(receiptUntilWords("2026-11-14", false), "Ends after Nov 14");
});

test("an adaptation row's receipt: in force reads applied with its decision's Undo; ended reads undone", () => {
  const decision = decisionRow({ summary: "Lower legs lighter for the race" });
  assert.equal(saveBrainRollback(decision.id, "training_plan", []), true);
  const insert = db.prepare(
    `INSERT INTO plan_adaptations (proposal_id, decision_id, day_number, exercise, kind, until_date, status, before_json)
     VALUES (NULL, ?, 3, ?, ?, '2026-11-01', ?, ?)`
  );
  const active = Number(
    insert.run(decision.id, "Leg Press", "swapped", "active", JSON.stringify({ exercise: "Back Squat" }))
      .lastInsertRowid
  );
  const ended = Number(insert.run(decision.id, "Leg Curl", "updated", "restored", null).lastInsertRowid);
  const kept = Number(insert.run(decision.id, "Hip Thrust", "updated", "kept", null).lastInsertRowid);
  const cancelled = Number(insert.run(decision.id, "Calf Raise", "updated", "cancelled", null).lastInsertRowid);

  const live = receiptFromPlanAdaptation(active);
  assert.equal(live.key, `adaptation:${active}`);
  assert.equal(live.status, "applied");
  assert.match(live.what, /^Leg Press in place of Back Squat, adapted/);
  assert.equal(live.until, "2026-11-01");
  assert.match(live.until_words, /^Ends after/);
  assert.deepEqual(live.undo, { kind: "brain_decision", id: decision.id });

  const over = receiptFromPlanAdaptation(ended);
  assert.equal(over.status, "undone");
  assert.equal(over.status_words, "Ended", "it ran its course — nobody put it back");
  assert.equal(over.undo, null);

  // An asked return settled to KEEPING the change: the change stays, so it reads applied.
  const stays = receiptFromPlanAdaptation(kept);
  assert.equal(stays.status, "applied");
  assert.equal(stays.status_words, null);
  assert.deepEqual(stays.undo, { kind: "brain_decision", id: decision.id });
  assert.equal(receiptFromPlanAdaptation(cancelled).status_words, "Put back");

  // The decision that made them now names the latest end of what it left in force.
  assert.equal(receiptFromBrainDecision(repo.getBrainDecision(decision.id)).until, "2026-11-01");
});

test("a stored receipt is re-read against the ledger; a message lifts its receipts out of meta", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const routed = applyProposalWithAutonomy(Number(pressDraft(105).id), { requested_tier: "ask" });
  const id = Number(routed.decision.id);
  applyDueAnnouncedDecisions(routed.effective_date);
  const stored = [receiptFromBrainDecision(repo.getBrainDecision(id), { what: "Press up a step" }), { junk: true }];
  const message = repo.addChatMessage("assistant", "Done.", "stub", { applied: [], receipts: stored });

  let lifted = withChangeReceipts(repo.getChatMessage(message.id));
  assert.equal(lifted.receipts.length, 1, "malformed entries are dropped");
  assert.equal(lifted.receipts[0].status, "applied");
  assert.equal(lifted.receipts[0].what, "Press up a step", "the words stay as they were said");

  assert.equal(revertDecision(id, "user undo").ok, true);
  lifted = withChangeReceipts(repo.getChatMessage(message.id));
  assert.equal(lifted.receipts[0].status, "undone", "the status is the ledger's now");
  assert.equal(lifted.receipts[0].undo, null);
  assert.deepEqual(refreshChangeReceipts(null), []);

  const plain = repo.addChatMessage("assistant", "Hello.", "stub", { applied: [] });
  assert.equal("receipts" in withChangeReceipts(repo.getChatMessage(plain.id)), false);
});

test("every Changes feed item carries the same change as a receipt", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const routed = applyProposalWithAutonomy(Number(pressDraft(105).id), { requested_tier: "ask" });
  const [row] = brainChangesRead().days.flatMap((d) => d.changes);
  assert.ok(row.receipt, "the feed row has its receipt");
  assert.equal(row.receipt.key, `decision:${row.id}`);
  assert.equal(row.receipt.what, row.title, "one change, one title, in both places");
  assert.equal(row.receipt.status, "scheduled");
  assert.equal(!!row.receipt.undo, row.undo.available, "the receipt's Undo is the feed's Undo");
  assert.equal(row.id, Number(routed.decision.id));
});

// ---------- chat: receipts only for what landed ----------

function turn(actions, message) {
  const floor = brainDecisionIdFloor();
  const out = applyChatActions({ actions }, { agent: "stub", message });
  return { ...out, receipts: chatChangeReceipts(out.applied, brainDecisionIdsAfter(floor)) };
}

test("chat: a plan_update that landed this turn earns exactly one applied receipt with its Undo", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  const out = turn(
    [{ type: "plan_update", changes: [{ day_number: 1, exercise: "Back Squat", sets: 2 }] }],
    "Change my squat to two sets."
  );
  const result = out.applied[0].result;
  assert.equal(result.persisted, true);
  assert.equal(out.receipts.length, 1);
  const [receipt] = out.receipts;
  assert.equal(receipt.key, `decision:${result.decision.id}`);
  assert.equal(receipt.status, "applied");
  assert.ok(receipt.what);
  assert.equal(receipt.undo?.kind, "brain_decision");
  assert.equal(receipt.undo?.id, Number(result.decision.id));
});

test("chat: a change held for clinical review, or refused by its date, earns no receipt", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  const held = turn(
    [
      {
        type: "plan_update",
        summary: "Modify lower day from lumbar MRI findings",
        imaging_study_id: "lumbar-mri-2026-07-18",
        changes: [
          {
            day_number: 1,
            exercise: "Back Squat",
            sets: 1,
            reason: "Lumbar MRI reports a disc protrusion; keep this as a clinician-directed rehab constraint.",
          },
        ],
      },
    ],
    "Please adjust my lower session based on yesterday's MRI."
  );
  assert.notEqual(held.applied[0].result.persisted, true, "nothing landed");
  assert.deepEqual(held.receipts, []);

  const refused = turn(
    [{ type: "plan_update", changes: [{ date: "2020-01-01", exercise: "Back Squat", sets: 2 }] }],
    "Change my squat to two sets on Jan 1 2020."
  );
  assert.equal(refused.applied[0].result.ok, false);
  assert.deepEqual(refused.receipts, []);

  const failed = chatChangeReceipts([{ type: "plan_update", error: "boom" }], []);
  assert.deepEqual(failed, []);
});

test("chat: this turn's own Undo reads undone; a row cancelled elsewhere is not news", () => {
  repo.setSettings({ lead_mode: "lead" });
  seedPress(100);
  const routed = applyProposalWithAutonomy(Number(pressDraft(105).id), { requested_tier: "ask" });
  const id = Number(routed.decision.id);
  const reverted = revertDecision(id, "user undo");
  assert.equal(reverted.ok, true);
  const receipts = chatChangeReceipts([{ type: "revert_decision", result: reverted }], []);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].status, "undone");
  assert.equal(receipts[0].undo, null);
  // The same cancelled row, merely written during the turn, is not a receipt.
  assert.deepEqual(chatChangeReceipts([], [id]), []);
});
