// Durable chat-turn lifecycle (src/repo.ts) + offline action application
// (src/chatTurns.ts). These back the non-blocking chat queue: a turn persisted
// here is what lets a follow-up queued mid-think — or a turn interrupted by a
// reload/restart — survive. The agent itself never runs in the harness (offline,
// deterministic), so we exercise the state machine and applyChatActions with a
// hand-built parsed payload, no CLI:
//   - createChatTurn → queued; round-trips message/image/agent
//   - listActiveChatTurns: queued+running only, oldest-first
//   - markChatTurnRunning is guarded (won't revive a canceled-while-queued turn)
//   - finish / fail / cancel state transitions + meta hydration
//   - recoverChatTurns: interrupted 'running' → error (+ recovery note), queued re-listed
//   - listChatMessagesBefore excludes the current + later messages
//   - applyChatActions: safe actions apply; a signal-backed plan_update lands quietly
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { db, repo } from "./_seed.js";
import {
  applyChatActions,
  classifyChatAgentResult,
  clinicalLineageForTurn,
  clinicalPlanProvenance,
  hasExplicitDecisionRevertIntent,
  hasExplicitPlanEditIntent,
  reconcileChatPlanReply,
  shouldCreatePhotoFoodPlaceholder,
} from "../dist/chatTurns.js";
import { localDateISO } from "../dist/repo/shared.js";
import { currentTrainingDataVersion } from "../dist/repo/training-cache.js";

beforeEach(() => {
  for (const t of ["chat_turns", "chat_messages", "memory", "plan_proposals", "food_notes", "body_measurements"]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
});

test("createChatTurn opens a queued turn and round-trips its fields", () => {
  const userMsg = repo.addChatMessage("user", "how's my week?", null);
  const t = repo.createChatTurn({ message: "how's my week?", agent: "stub", user_message_id: userMsg.id });
  assert.equal(t.status, "queued");
  assert.equal(t.phase, "queued");
  assert.equal(t.message, "how's my week?");
  assert.equal(t.agent, "stub");
  assert.equal(t.user_message_id, userMsg.id);
  assert.equal(t.started_at, null);
  assert.deepEqual(repo.getChatTurn(t.id).message, "how's my week?");
});

test("chat classifies CLI login banners as auth failures, not replies", () => {
  const attempt = classifyChatAgentResult("codex", {
    code: 0,
    raw: "Not logged in · Please run /login",
    stderr: "",
    parsed: null,
  });
  assert.equal(attempt.ok, false);
  assert.equal(attempt.status, "auth_required");
  assert.equal(attempt.error_class, "auth_required");
  assert.equal(attempt.agent, "codex");
  assert.equal(attempt.error_message, "Not connected");
});

test("listActiveChatTurns returns queued+running oldest-first, excludes terminal", () => {
  const a = repo.createChatTurn({ message: "a" });
  const b = repo.createChatTurn({ message: "b" });
  const c = repo.createChatTurn({ message: "c" });
  repo.markChatTurnRunning(a.id); // running
  repo.finishChatTurn(c.id, { reply: "done" }); // terminal → excluded
  const active = repo.listActiveChatTurns();
  assert.deepEqual(
    active.map((t) => t.id),
    [a.id, b.id],
    "running a + queued b, in id order; finished c gone"
  );
  assert.equal(active[0].status, "running");
  assert.equal(active[1].status, "queued");
});

test("markChatTurnRunning is guarded — a canceled-while-queued turn is never revived", () => {
  const t = repo.createChatTurn({ message: "stop me" });
  repo.cancelChatTurn(t.id);
  assert.equal(repo.getChatTurn(t.id).status, "canceled");
  repo.markChatTurnRunning(t.id); // no-op: only flips from 'queued'
  assert.equal(repo.getChatTurn(t.id).status, "canceled", "still canceled — the worker can't pick it up");
});

test("finishChatTurn stamps done + hydrates meta; setChatTurnPhase only moves a running turn", () => {
  const t = repo.createChatTurn({ message: "draft me a plan" });
  repo.setChatTurnPhase(t.id, "applying"); // ignored while still queued
  assert.equal(repo.getChatTurn(t.id).phase, "queued");
  repo.markChatTurnRunning(t.id);
  assert.ok(repo.getChatTurn(t.id).started_at, "started_at stamped on run");
  repo.setChatTurnPhase(t.id, "applying");
  assert.equal(repo.getChatTurn(t.id).phase, "applying");
  const meta = { applied: [{ type: "add_memory" }], drafts: [] };
  const done = repo.finishChatTurn(t.id, { reply: "here you go", chosen_agent: "stub", meta });
  assert.equal(done.status, "done");
  assert.equal(done.reply, "here you go");
  assert.equal(done.chosen_agent, "stub");
  assert.deepEqual(done.meta, meta, "meta JSON round-trips hydrated");
  assert.ok(done.finished_at);
});

test("cancelChatTurn flips a running turn; returns null once terminal", () => {
  const t = repo.createChatTurn({ message: "x" });
  repo.markChatTurnRunning(t.id);
  const canceled = repo.cancelChatTurn(t.id);
  assert.equal(canceled.status, "canceled");
  assert.equal(repo.cancelChatTurn(t.id), null, "cancel is a no-op on an already-terminal turn");
});

test("recoverChatTurns errors interrupted runs (+ thread note) and re-lists queued ones", () => {
  const interrupted = repo.createChatTurn({
    message: "was running",
    user_message_id: repo.addChatMessage("user", "was running").id,
  });
  repo.markChatTurnRunning(interrupted.id);
  const queued = repo.createChatTurn({ message: "still queued" });

  const before = repo.listChatMessages(50).length;
  const { requeue, interrupted: n } = repo.recoverChatTurns();

  assert.equal(n, 1, "one interrupted run");
  assert.deepEqual(requeue, [queued.id], "the queued turn is handed back to re-drain");
  assert.equal(
    repo.getChatTurn(interrupted.id).status,
    "error",
    "interrupted run marked error (actions may have partially applied)"
  );
  const after = repo.listChatMessages(50);
  assert.equal(after.length, before + 1, "a calm recovery note was added to the thread");
  assert.match(after[after.length - 1].content, /interrupted by a restart/i);
});

test("listChatMessagesBefore excludes the current message and anything after it", () => {
  repo.addChatMessage("user", "first");
  repo.addChatMessage("assistant", "reply to first");
  const m3 = repo.addChatMessage("user", "second (the turn we're building)");
  repo.addChatMessage("user", "third — queued after, must not leak in");
  const history = repo.listChatMessagesBefore(m3.id, 20);
  assert.deepEqual(
    history.map((h) => h.content),
    ["first", "reply to first"],
    "only what preceded m3"
  );
});

test("applyChatActions applies a signal-backed plan_update quietly and keeps dated rationale in provenance", () => {
  repo.savePlanDay(1, "Lower", "legs", [{ exercise: "Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 190 }]);
  const parsed = {
    reply: "logged + drafted",
    actions: [
      { type: "add_memory", content: "prefers evening training", kind: "preference" },
      {
        type: "plan_update",
        summary: "bump squat",
        changes: [
          {
            day_number: 1,
            exercise: "Squat",
            target_weight: 200,
            reason: "Three crisp sessions at the top of the range.",
          },
        ],
      },
    ],
  };
  const { applied, drafts } = applyChatActions(parsed, { agent: "stub", message: "My squat felt easy again today." });
  assert.equal(applied.length, 2, "the memory and small plan adjustment applied immediately");
  assert.equal(applied[0].type, "add_memory");
  assert.equal(applied[1].type, "plan_update");
  assert.equal(applied[1].result.background, true);
  assert.equal(applied[1].result.tier, "quiet_apply", "ordinary load progression keeps the existing autonomy path");
  assert.equal(drafts.length, 0, "small plan adjustments do not interrupt chat with a draft");
  const prop = repo.getProposal(applied[1].result.proposal_id);
  assert.equal(prop.status, "applied");
  const squat = repo.getPlanDay(1).items.find((item) => item.exercise === "Squat");
  assert.equal(squat.target_weight, 200);
  assert.equal(squat.note, null, "unproven relative prose is never frozen into a timeless plan note");
  assert.match(squat.brain_change_reason, /Three crisp sessions/);
  assert.equal(squat.brain_change_reason_provenance.reason_code, "training_evidence");
  assert.match(squat.brain_change_reason_provenance.evidence_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(
    squat.brain_change_reason_provenance.evidence_date,
    squat.brain_change_reason_provenance.as_of_date
  );
  const decision = repo.getBrainDecision(applied[1].result.decision.id);
  assert.match(decision.rationale, /Three crisp sessions/);
  assert.deepEqual(
    decision.action.changes[0].reason_provenance,
    squat.brain_change_reason_provenance
  );
  assert.ok(
    repo.listMemory(10).some((m) => /evening training/.test(m.content)),
    "memory landed in the store"
  );
});

test("an MRI-driven plan change is clinician-held even when Lead mode and the model request quiet apply", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);

  const out = applyChatActions(
    {
      actions: [
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
    },
    { agent: "stub", message: "Please adjust my lower session based on yesterday's MRI." }
  );

  const result = out.applied[0].result;
  assert.equal(result.applied, false);
  assert.equal(result.persisted, false);
  assert.equal(result.review_required, true);
  assert.equal(result.tier, "clinician");
  assert.equal(result.decision.autonomy_tier, "clinician");
  assert.equal(result.decision.risk_class, "clinical");
  assert.equal(result.decision.context.review_reason_code, "clinical_ceiling");
  assert.equal(result.decision.context.clinical_provenance.server_owned, true);
  assert.ok(result.decision.context.clinical_provenance.detected_from.includes("study_reference"));
  assert.equal(repo.getProposal(result.proposal_id).status, "draft");
  assert.equal(repo.getPlanDay(1).items[0].sets, 3, "the clinical change did not quiet-apply");
});

test("an attached ad-hoc image is sufficient clinical provenance for a plan change", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);

  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "Make today's session safer",
          changes: [
            {
              day_number: 1,
              exercise: "Back Squat",
              remove: true,
              reason: "Adjust the session based on the attached picture.",
            },
          ],
        },
      ],
    },
    {
      agent: "stub",
      message: "Adjust this based on the picture.",
      imagePath: "/tmp/chat-clinical-image.jpg",
    }
  );

  const result = out.applied[0].result;
  assert.equal(result.tier, "clinician");
  assert.equal(result.review_required, true);
  assert.equal(result.persisted, false);
  assert.equal(result.decision.context.clinical_provenance.attached_image, true);
  assert.ok(result.decision.context.clinical_provenance.detected_from.includes("attached_chat_image"));
  assert.deepEqual(result.decision.context.clinical_provenance.signals, [], "no clinical keyword was required");
  assert.equal(repo.getPlanDay(1).items.length, 1, "the image-derived clinical edit stayed out of the live plan");
});

test("a generic confirmation inherits the immediately prior unresolved clinical proposal across durable turn storage", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);

  const firstUser = repo.addChatMessage("user", "Adjust my lower session around the MRI findings.", null);
  const firstTurn = repo.createChatTurn({ message: firstUser.content, user_message_id: firstUser.id });
  repo.markChatTurnRunning(firstTurn.id);
  const first = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "MRI-informed lower-day change",
          changes: [{ day_number: 1, exercise: "Back Squat", sets: 2, reason: "MRI-informed constraint" }],
        },
      ],
    },
    { agent: "stub", message: firstUser.content }
  );
  const firstLineage = clinicalLineageForTurn(first.applied, firstTurn.id);
  assert.ok(firstLineage);
  const firstAssistant = repo.addChatMessage("assistant", "I can hold that change for clinical review.", "stub", {
    applied: first.applied,
    clinical_lineage: firstLineage,
  });
  repo.finishChatTurn(firstTurn.id, {
    reply: firstAssistant.content,
    assistant_message_id: firstAssistant.id,
    meta: { applied: first.applied, clinical_lineage: firstLineage },
  });

  const followupUser = repo.addChatMessage("user", "Yes, make that change.", null);
  const followupTurn = repo.createChatTurn({ message: followupUser.content, user_message_id: followupUser.id });
  const followup = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "Make the discussed change",
          changes: [{ day_number: 1, exercise: "Back Squat", sets: 2, reason: "As discussed" }],
        },
      ],
    },
    {
      agent: "stub",
      message: followupUser.content,
      turnId: followupTurn.id,
      userMessageId: followupUser.id,
    }
  );

  const result = followup.applied[0].result;
  assert.equal(result.tier, "clinician");
  assert.equal(result.review_required, true);
  assert.equal(result.persisted, false);
  assert.equal(result.decision.context.clinical_provenance.source, "chat_clinical_lineage");
  assert.deepEqual(result.decision.context.clinical_provenance.lineage, {
    turn_id: firstTurn.id,
    proposal_id: first.applied[0].result.proposal_id,
    decision_id: first.applied[0].result.decision.id,
  });
  assert.equal(repo.getPlanDay(1).items[0].sets, 3);

  const followupLineage = clinicalLineageForTurn(followup.applied, followupTurn.id);
  const followupAssistant = repo.addChatMessage("assistant", "That remains held for clinical review.", "stub", {
    applied: followup.applied,
    clinical_lineage: followupLineage,
  });
  repo.finishChatTurn(followupTurn.id, {
    reply: followupAssistant.content,
    assistant_message_id: followupAssistant.id,
    meta: { applied: followup.applied, clinical_lineage: followupLineage },
  });

  const ordinaryUser = repo.addChatMessage("user", "My squat felt easy again today.", null);
  const ordinaryTurn = repo.createChatTurn({ message: ordinaryUser.content, user_message_id: ordinaryUser.id });
  const ordinary = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "Routine earned load progression",
          changes: [{ day_number: 1, exercise: "Back Squat", target_weight: 190, reason: "Repeated crisp sets" }],
        },
      ],
    },
    {
      agent: "stub",
      message: ordinaryUser.content,
      turnId: ordinaryTurn.id,
      userMessageId: ordinaryUser.id,
    }
  );
  assert.equal(ordinary.applied[0].result.tier, "quiet_apply", "an unrelated later turn is not permanently tainted");
  assert.equal(ordinary.applied[0].result.persisted, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190);
});

test("a prose-only MRI turn keeps clinician lineage for 'add that exercise' after restart", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);

  const firstUser = repo.addChatMessage("user", "What exercises fit my MRI findings?", null);
  const firstTurn = repo.createChatTurn({ message: firstUser.content, user_message_id: firstUser.id });
  repo.markChatTurnRunning(firstTurn.id);
  const provenance = clinicalPlanProvenance({
    message: firstUser.content,
    action: {},
    imageAloneIsClinical: false,
  });
  const lineage = clinicalLineageForTurn([], firstTurn.id, provenance);
  assert.equal(lineage.proposal_id, null, "the server persists clinical context even before a proposal exists");
  const assistant = repo.addChatMessage("assistant", "A supported squat variation could be considered.", "stub", {
    applied: [],
    clinical_lineage: lineage,
  });
  repo.finishChatTurn(firstTurn.id, {
    reply: assistant.content,
    assistant_message_id: assistant.id,
    meta: { applied: [], clinical_lineage: lineage },
  });

  // No in-memory handoff is used below: the follow-up resolves lineage from the
  // completed chat_turn row, which is the same path used after a process restart.
  const followupUser = repo.addChatMessage("user", "Can you add that exercise to my plan?", null);
  const followupTurn = repo.createChatTurn({ message: followupUser.content, user_message_id: followupUser.id });
  const followup = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "Make the discussed exercise change",
          changes: [
            {
              day_number: 1,
              exercise: "Supported Split Squat",
              sets: 2,
              rep_low: 8,
              rep_high: 10,
              reason: "Add the exercise the coach just discussed",
            },
          ],
        },
      ],
    },
    {
      agent: "stub",
      message: followupUser.content,
      turnId: followupTurn.id,
      userMessageId: followupUser.id,
    }
  );
  assert.equal(followup.applied[0].result.tier, "clinician");
  assert.equal(followup.applied[0].result.review_required, true);
  assert.equal(followup.applied[0].result.decision.context.clinical_provenance.lineage.proposal_id, null);
  assert.equal(
    repo.getPlanDay(1).items.some((item) => item.exercise === "Supported Split Squat"),
    false,
    "the clinically linked exercise was not quietly added"
  );
});

function applyGenericPlanFollowupAfterProseOnlyMri(
  message,
  changes = [{ day_number: 1, exercise: "Back Squat", sets: 2 }]
) {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  const firstUser = repo.addChatMessage("user", "What exercises fit my MRI findings?", null);
  const firstTurn = repo.createChatTurn({ message: firstUser.content, user_message_id: firstUser.id });
  repo.markChatTurnRunning(firstTurn.id);
  const provenance = clinicalPlanProvenance({
    message: firstUser.content,
    action: {},
    imageAloneIsClinical: false,
  });
  const lineage = clinicalLineageForTurn([], firstTurn.id, provenance);
  const assistant = repo.addChatMessage("assistant", "I suggest reducing squat volume to two sets.", "stub", {
    applied: [],
    clinical_lineage: lineage,
  });
  repo.finishChatTurn(firstTurn.id, {
    reply: assistant.content,
    assistant_message_id: assistant.id,
    meta: { applied: [], clinical_lineage: lineage },
  });

  const followupUser = repo.addChatMessage("user", message, null);
  const followupTurn = repo.createChatTurn({ message: followupUser.content, user_message_id: followupUser.id });
  return applyChatActions(
    { actions: [{ type: "plan_update", changes }] },
    {
      agent: "stub",
      message: followupUser.content,
      turnId: followupTurn.id,
      userMessageId: followupUser.id,
    }
  );
}

test("'Change my plan accordingly' inherits clinician lineage from prose-only MRI context", () => {
  const out = applyGenericPlanFollowupAfterProseOnlyMri("Change my plan accordingly");
  assert.equal(out.applied[0].result.tier, "clinician");
  assert.equal(out.applied[0].result.review_required, true);
  assert.equal(out.applied[0].result.persisted, false);
  assert.equal(repo.getPlanDay(1).items[0].sets, 3);
});

test("'Update my plan with your suggestion' inherits clinician lineage from prose-only MRI context", () => {
  const out = applyGenericPlanFollowupAfterProseOnlyMri("Update my plan with your suggestion");
  assert.equal(out.applied[0].result.tier, "clinician");
  assert.equal(out.applied[0].result.review_required, true);
  assert.equal(out.applied[0].result.persisted, false);
  assert.equal(repo.getPlanDay(1).items[0].sets, 3);
});

test("a self-contained named plan request does not inherit unrelated MRI lineage", () => {
  const out = applyGenericPlanFollowupAfterProseOnlyMri("Increase my squat to 190 pounds.", [
    { day_number: 1, exercise: "Back Squat", target_weight: 190, reason: "independent load request" },
  ]);
  assert.equal(out.applied[0].result.tier, "quiet_apply");
  assert.equal(out.applied[0].result.persisted, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190);
});

test("an explicit topic change starts an unrelated plan request outside prior MRI lineage", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);

  const firstUser = repo.addChatMessage("user", "What exercises fit my MRI findings?", null);
  const firstTurn = repo.createChatTurn({ message: firstUser.content, user_message_id: firstUser.id });
  repo.markChatTurnRunning(firstTurn.id);
  const provenance = clinicalPlanProvenance({
    message: firstUser.content,
    action: {},
    imageAloneIsClinical: false,
  });
  const lineage = clinicalLineageForTurn([], firstTurn.id, provenance);
  const assistant = repo.addChatMessage("assistant", "A supported squat variation could be considered.", "stub", {
    applied: [],
    clinical_lineage: lineage,
  });
  repo.finishChatTurn(firstTurn.id, {
    reply: assistant.content,
    assistant_message_id: assistant.id,
    meta: { applied: [], clinical_lineage: lineage },
  });

  const nextUser = repo.addChatMessage("user", "Different topic: change my squat to two sets.", null);
  const nextTurn = repo.createChatTurn({ message: nextUser.content, user_message_id: nextUser.id });
  const next = applyChatActions(
    { actions: [{ type: "plan_update", changes: [{ day_number: 1, exercise: "Back Squat", sets: 2 }] }] },
    {
      agent: "stub",
      message: nextUser.content,
      turnId: nextTurn.id,
      userMessageId: nextUser.id,
    }
  );
  assert.equal(next.applied[0].result.tier, "quiet_apply");
  assert.equal(next.applied[0].result.persisted, true);
  assert.equal(repo.getPlanDay(1).items[0].sets, 2);
});

test("resolved clinical review lineage cannot be reused by a generic confirmation", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  const firstUser = repo.addChatMessage("user", "Adjust this from my MRI.", null);
  const firstTurn = repo.createChatTurn({ message: firstUser.content, user_message_id: firstUser.id });
  repo.markChatTurnRunning(firstTurn.id);
  const first = applyChatActions(
    { actions: [{ type: "plan_update", changes: [{ day_number: 1, exercise: "Back Squat", sets: 2 }] }] },
    { agent: "stub", message: firstUser.content }
  );
  const lineage = clinicalLineageForTurn(first.applied, firstTurn.id);
  const assistant = repo.addChatMessage("assistant", "Held for review.", "stub", { clinical_lineage: lineage });
  repo.finishChatTurn(firstTurn.id, {
    reply: assistant.content,
    assistant_message_id: assistant.id,
    meta: { clinical_lineage: lineage },
  });
  repo.transitionBrainDecision(first.applied[0].result.decision.id, "rejected");

  const followupUser = repo.addChatMessage("user", "Yes, make that change.", null);
  const followupTurn = repo.createChatTurn({ message: followupUser.content, user_message_id: followupUser.id });
  const followup = applyChatActions(
    { actions: [{ type: "plan_update", changes: [{ day_number: 1, exercise: "Back Squat", sets: 2 }] }] },
    {
      agent: "stub",
      message: followupUser.content,
      turnId: followupTurn.id,
      userMessageId: followupUser.id,
    }
  );
  assert.equal(followup.applied[0].result.tier, "quiet_apply");
  assert.equal(followup.applied[0].result.persisted, true);
});

test("an explicit same-day chat edit bypasses the surprise budget, applies the whole prescription, and verifies read-back", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [{ exercise: "Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 190 }]);
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Incline DB Press", sets: 2, rep_low: 8, rep_high: 10, target_weight: 40 },
    { exercise: "Incline Bench Press", sets: 2, rep_low: 8, rep_high: 10, target_weight: 95 },
    { exercise: "Barbell Overhead Press", sets: 2, rep_low: 8, rep_high: 10, target_weight: 60 },
  ]);

  const background = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "earned squat bump",
          changes: [{ day_number: 1, exercise: "Squat", target_weight: 200, reason: "Repeated crisp sessions." }],
        },
      ],
    },
    { agent: "stub", message: "My squat felt easy again today." }
  );
  assert.equal(background.applied[0].result.verified, true, "the first change consumes the weekly surprise budget");

  repo.saveDayRead(localDateISO(), {
    kind: "train",
    headline: "Push",
    focus: "Push",
    signals: { plan_selection: { selected: { day_number: 2 } } },
    source: "deterministic",
  });

  const message = "Can you adjust today's Push session plan to be optimal?";
  assert.equal(hasExplicitPlanEditIntent(message), true);
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "remove the duplicate incline pattern and keep reset volume honest",
          changes: [
            { day_number: 2, exercise: "Incline Bench Press", remove: true, reason: "duplicate incline pattern" },
            {
              day_number: 2,
              exercise: "Barbell Bench Press",
              sets: 2,
              rep_low: 8,
              rep_high: 10,
              target_weight: 105,
              reason: "one flat main press",
            },
            {
              day_number: 2,
              exercise: "Incline DB Press",
              sets: 1,
              rep_low: 8,
              rep_high: 10,
              target_weight: 40,
              reason: "one light incline set",
            },
            {
              day_number: 2,
              exercise: "Barbell Overhead Press",
              sets: 1,
              rep_low: 8,
              rep_high: 10,
              target_weight: 60,
              reason: "reset volume",
            },
          ],
        },
      ],
    },
    { agent: "stub", message }
  );

  const result = out.applied[0].result;
  assert.equal(result.ok, true);
  assert.equal(result.verified, true, "stored day matches the requested final state");
  assert.equal(repo.getProposal(result.proposal_id).status, "applied");
  const day = repo.getPlanDay(2);
  const names = day.items.map((item) => item.exercise);
  assert.deepEqual(names, ["Incline DB Press", "Barbell Overhead Press", "Barbell Bench Press"]);
  assert.equal(day.items.find((item) => item.exercise === "Incline DB Press").sets, 1);
  assert.equal(day.items.find((item) => item.exercise === "Barbell Overhead Press").sets, 1);
  const flat = day.items.find((item) => item.exercise === "Barbell Bench Press");
  assert.deepEqual(
    [flat.sets, flat.rep_low, flat.rep_high, flat.target_weight],
    [2, 8, 10, null],
    "a newly added lift has no model-invented load until exact history exists"
  );

  const reply = reconcileChatPlanReply("I've now updated the live Push plan.", message, out.applied, out.drafts);
  assert.match(reply, /saved and verified plan day 2/i);
  assert.match(
    reply,
    /target weight from 105 to no prescribed load/i,
    "chat tells the athlete the stored safe adjustment"
  );
});

test("an explicit today edit binds a one-day model action to Today's canonical plan day", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 105 },
  ]);
  repo.saveDayRead(localDateISO(), {
    kind: "train",
    headline: "Push",
    focus: "Push",
    signals: { plan_selection: { selected: { day_number: 2 } } },
    source: "deterministic",
  });

  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "make today's bench volume lighter",
          // The model emitted the wrong template day. The server owns "today".
          changes: [{ day_number: 1, exercise: "Barbell Bench Press", sets: 2 }],
        },
      ],
    },
    { agent: "stub", message: "Please adjust today's session to two bench sets." }
  );

  assert.equal(out.applied[0].result.verified, true);
  assert.equal(repo.getPlanDay(1).items[0].sets, 3, "the model's arbitrary day was not edited");
  assert.equal(repo.getPlanDay(2).items[0].sets, 2, "the canonical Today session was edited");
  assert.equal(repo.getProposal(out.applied[0].result.proposal_id).parsed.changes[0].day_number, 2);
});

test("an explicitly named future/day edit is not rebound to Today", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Lower", "legs", [
    { exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
  ]);
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 105 },
  ]);
  repo.saveDayRead(localDateISO(), {
    kind: "train",
    headline: "Push",
    focus: "Push",
    signals: { plan_selection: { selected: { day_number: 2 } } },
    source: "deterministic",
  });

  const out = applyChatActions(
    { actions: [{ type: "plan_update", changes: [{ day_number: 1, exercise: "Back Squat", sets: 2 }] }] },
    { agent: "stub", message: "Leave today alone; change day 1 to two squat sets for tomorrow." }
  );
  assert.equal(out.applied[0].result.verified, true);
  assert.equal(repo.getPlanDay(1).items[0].sets, 2);
  assert.equal(repo.getPlanDay(2).items[0].sets, 3);
});

test("explicit plan-edit intent recognizes concise natural commands without broad background inference", () => {
  assert.equal(hasExplicitPlanEditIntent("remove Incline Bench"), true);
  assert.equal(hasExplicitPlanEditIntent("skip the run"), true);
  assert.equal(hasExplicitPlanEditIntent("make today optimal"), true);
  assert.equal(
    hasExplicitPlanEditIntent("My bench felt easy today"),
    false,
    "a training signal alone still obeys surprise policy"
  );
});

test("a multi-change chat correction rolls back completely when one removal cannot apply", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(2, "Push", "chest", [
    { exercise: "Incline DB Press", sets: 2, rep_low: 8, rep_high: 10, target_weight: 40 },
  ]);
  const message = "Adjust today's session: one incline set and remove the extra incline barbell press.";
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          changes: [
            { day_number: 2, exercise: "Incline DB Press", sets: 1 },
            { day_number: 2, exercise: "Incline Barbell Press", remove: true },
          ],
        },
      ],
    },
    { agent: "stub", message }
  );
  const result = out.applied[0].result;
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.equal(repo.getPlanDay(2).items[0].sets, 2, "the earlier edit was rolled back");
  assert.equal(repo.getProposal(result.proposal_id).status, "draft");
});

test("multiple off-contract plan actions report partial success when a later action commits", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 105 },
  ]);
  repo.saveDayRead(localDateISO(), {
    kind: "train",
    headline: "Push",
    focus: "Push",
    signals: {},
    source: "deterministic",
  });
  const message = "Remove the incline press and make today's bench two sets.";
  const out = applyChatActions(
    {
      actions: [
        { type: "plan_update", changes: [{ day_number: 1, exercise: "Incline Bench Press", remove: true }] },
        { type: "plan_update", changes: [{ day_number: 1, exercise: "Barbell Bench Press", sets: 2 }] },
      ],
    },
    { agent: "stub", message }
  );

  assert.equal(out.applied[0].result.verified, false);
  assert.equal(out.applied[0].result.persisted, false);
  assert.equal(out.applied[1].result.verified, true);
  assert.equal(out.applied[1].result.persisted, true);
  assert.equal(repo.getPlanDay(1).items[0].sets, 2, "the later verified action is live");
  assert.equal(repo.getCachedDayRead(localDateISO()), null, "a committed partial result invalidates Today");
  const reply = reconcileChatPlanReply("I've updated everything.", message, out.applied, out.drafts);
  assert.match(reply, /part of that request is live/i);
  assert.match(reply, /saved and verified/i);
  assert.match(reply, /was not saved/i);
  assert.doesNotMatch(reply, /current plan is unchanged/i);
});

test("the chat client invalidates plan cache on confirmed persistence without loosening server verification prose", () => {
  const client = readFileSync(new URL("../src/client/chat-turn-client.ts", import.meta.url), "utf8");
  assert.match(client, /result\.verified === true \|\| result\.persisted === true \|\| result\.committed === true/);
  assert.match(client, /swrInvalidate\("plan"\)/);
  const server = readFileSync(new URL("../src/chatTurns.ts", import.meta.url), "utf8");
  assert.match(server, /const verified = results\.length > 0 && verifiedResults\.length === results\.length/);
});

test("out-of-range chat volume is bounded, verified, and reported as saved rather than unchanged", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 105 },
  ]);
  const message = "Update today's bench to 999 sets.";
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          changes: [{ day_number: 1, exercise: "Barbell Bench Press", sets: 999 }],
        },
      ],
    },
    { agent: "stub", message }
  );
  const result = out.applied[0].result;
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(repo.getPlanDay(1).items[0].sets, 20);
  assert.ok(result.clamped.some((entry) => entry.field === "sets" && entry.requested === 999 && entry.applied === 20));
  const reply = reconcileChatPlanReply("I've updated today's plan.", message, out.applied, out.drafts);
  assert.match(reply, /saved and verified/i);
  assert.match(reply, /sets from 999 to 20/i);
  assert.doesNotMatch(reply, /unchanged/i);
});

test("swap prescriptions use the same safety bounds and verify the complete stored replacement", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Incline DB Press", sets: 2, rep_low: 8, rep_high: 10, target_weight: 40 },
  ]);
  const message = "Swap today's incline DB press to incline bench press, 999 sets at 500 pounds.";
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          changes: [
            {
              day_number: 1,
              swap: { from: "Incline DB Press", to: "Incline Bench Press" },
              sets: 999,
              rep_low: 8,
              rep_high: 10,
              target_weight: 500,
              mode: "reps",
            },
          ],
        },
      ],
    },
    { agent: "stub", message }
  );
  const result = out.applied[0].result;
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  const item = repo.getPlanDay(1).items[0];
  assert.equal(item.exercise, "Incline Bench Press");
  assert.deepEqual(
    [item.sets, item.rep_low, item.rep_high, item.target_weight, item.target_seconds, item.mode],
    [20, 8, 10, null, null, "reps"]
  );
  assert.ok(
    result.clamped.some((entry) => entry.field === "target_weight" && entry.requested === 500 && entry.applied === null)
  );
  assert.ok(result.verification.checks[0].ok, "from/to and the complete canonical prescription read back exactly");
});

test("an alias-backed swap verifies the canonical stored exercise and invalidates training reads", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.upsertExercise({ name: "Barbell Bench Press", muscle_group: "chest", mode: "reps" });
  repo.setExerciseAlias("flat bench", "Barbell Bench Press", "test");
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Incline DB Press", sets: 2, rep_low: 8, rep_high: 10, target_weight: 40 },
  ]);
  const before = currentTrainingDataVersion();
  const message = "Swap today's incline DB press to flat bench.";
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          changes: [
            {
              day_number: 1,
              swap: { from: "Incline DB Press", to: "flat bench" },
              sets: 2,
              rep_low: 8,
              rep_high: 10,
              mode: "reps",
            },
          ],
        },
      ],
    },
    { agent: "stub", message }
  );

  const result = out.applied[0].result;
  assert.equal(result.ok, true);
  assert.equal(result.verified, true, "the receipt's canonical identity, not the raw alias, is read back");
  assert.equal(repo.getPlanDay(1).items[0].exercise, "Barbell Bench Press");
  assert.ok(currentTrainingDataVersion() > before, "the successful alias swap invalidates training caches");
  assert.match(reconcileChatPlanReply("I'll make that swap.", message, out.applied, out.drafts), /saved and verified/i);
});

test("post-action reconciliation removes a false success claim when autonomy keeps the edit for review", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  repo.savePlanDay(1, "Push", "chest", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 8, rep_high: 10, target_weight: 105 },
  ]);
  const message = "Please adjust today's plan to two bench sets.";
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          changes: [{ day_number: 1, exercise: "Barbell Bench Press", sets: 2 }],
        },
      ],
    },
    { agent: "stub", message }
  );
  assert.equal(out.applied[0].result.tier, "ask");
  assert.equal(out.applied[0].result.verified, false);
  const reply = reconcileChatPlanReply(
    "I’ve now pushed the updated Push session directly to the app.",
    message,
    out.applied,
    out.drafts
  );
  assert.doesNotMatch(reply, /I’ve now pushed/i);
  assert.match(reply, /not live/i);
  assert.match(reply, /unchanged/i);
  assert.equal(repo.getPlanDay(1).items[0].sets, 3);
});

test("an explicit chat restructure is announced for its natural boundary with Discuss and Undo in lead mode", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Full Body", "strength", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
  ]);
  const message = "Move me to a two-day upper/lower split.";
  assert.equal(hasExplicitPlanEditIntent(message), true);
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_restructure",
          summary: "Move to a two-day upper/lower split",
          days: [
            {
              day_number: 1,
              name: "Upper",
              focus: "Upper",
              items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }],
            },
            {
              day_number: 2,
              name: "Lower",
              focus: "Lower",
              items: [{ exercise: "Back Squat", sets: 3, rep_low: 6, rep_high: 8, target_weight: 180 }],
            },
          ],
        },
      ],
    },
    { agent: "stub", message }
  );

  assert.deepEqual(out.drafts, [], "current chat restructures never become bare review drafts");
  const result = out.applied[0].result;
  assert.equal(result.announced, true);
  assert.equal(result.scheduled, true);
  assert.equal(result.decision.status, "announced");
  assert.equal(
    result.decision.reversible,
    false,
    "the scheduled decision can be canceled, but does not claim rollback reversibility before it lands"
  );
  assert.equal(repo.getBrainRollback(result.decision.id), null);
  assert.equal(repo.getProposal(result.proposal_id).autonomy.status, "announced");
  const card = [...repo.todayAgenda().primary, ...repo.todayAgenda().more].find(
    (item) => item.id === `announced-decision-${result.decision.id}`
  );
  assert.equal(card.action.label, "Discuss with coach");
  const reply = reconcileChatPlanReply("I will reshape that split.", message, out.applied, out.drafts);
  assert.match(reply, /scheduled for/i);
  assert.match(reply, /Discuss with coach/i);
  assert.match(reply, /Undo/i);
  assert.doesNotMatch(reply, /draft for review/i);

  const undone = applyChatActions(
    { actions: [{ type: "revert_decision", id: result.decision.id, reason: "Keep the current split." }] },
    { agent: "stub", message: "Undo that split change." }
  );
  assert.equal(undone.applied[0].result.ok, true);
  assert.equal(repo.getBrainDecision(result.decision.id).status, "canceled");
});

test("a model restructure action cannot mutate or schedule from a non-edit training question", () => {
  repo.setSettings({ lead_mode: "lead" });
  repo.savePlanDay(1, "Full Body", "strength", [
    { exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 },
  ]);
  const message = "How does my current training split look?";
  assert.equal(hasExplicitPlanEditIntent(message), false);
  const beforePlan = repo.getPlan();
  const beforeProposalCount = repo.listProposals(100).length;
  const beforeDecisionCount = repo.listBrainDecisions({ limit: 100 }).length;
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_restructure",
          summary: "Model-invented two-day split",
          days: [{ day_number: 1, name: "Upper", focus: "Upper", items: [] }],
        },
      ],
    },
    { agent: "stub", message }
  );

  assert.deepEqual(out.applied, [], "the off-contract structural action is ignored");
  assert.deepEqual(out.drafts, []);
  assert.deepEqual(repo.getPlan(), beforePlan, "the active plan is unchanged");
  assert.equal(repo.listProposals(100).length, beforeProposalCount, "no proposal is created");
  assert.equal(repo.listBrainDecisions({ limit: 100 }).length, beforeDecisionCount, "no announcement is recorded");
  const advice = "Your current split is balanced, with one recovery tradeoff worth watching.";
  assert.equal(
    reconcileChatPlanReply(advice, message, out.applied, out.drafts),
    advice,
    "advice-only prose remains intact"
  );
  assert.match(
    reconcileChatPlanReply("I changed your program to two days.", message, out.applied, out.drafts),
    /haven't changed or scheduled/i,
    "an off-contract success claim is corrected truthfully"
  );
});

test("review-everything still holds a current chat restructure as an explicit review decision", () => {
  repo.setSettings({ lead_mode: "review_everything" });
  const message = "Move me to a two-day upper/lower split.";
  const out = applyChatActions(
    {
      actions: [
        {
          type: "plan_restructure",
          summary: "Move to two days",
          days: [
            {
              day_number: 1,
              name: "Upper",
              focus: "Upper",
              items: [{ exercise: "Barbell Bench Press", sets: 3, rep_low: 6, rep_high: 8, target_weight: 100 }],
            },
          ],
        },
      ],
    },
    { agent: "stub", message }
  );
  const result = out.applied[0].result;
  assert.equal(result.review_required, true);
  assert.equal(result.decision.status, "review");
  assert.equal(result.decision.context.review_reason_code, "review_posture");
  assert.equal(repo.getProposal(result.proposal_id).status, "draft");
  assert.ok([...repo.todayAgenda().primary, ...repo.todayAgenda().more].some((item) => item.id === "draft-proposals"));
  const reply = reconcileChatPlanReply("I changed it.", message, out.applied, out.drafts);
  assert.match(reply, /held for review/i);
  assert.doesNotMatch(reply, /is scheduled|scheduled for|draft for review/i);
});

test("chat put-it-back reverts the exact autonomous decision in the same turn", () => {
  repo.savePlanDay(1, "Lower", "legs", [{ exercise: "Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 190 }]);
  const first = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "small squat progression",
          changes: [{ day_number: 1, exercise: "Squat", target_weight: 200, reason: "Repeated crisp sessions." }],
        },
      ],
    },
    { agent: "stub", message: "Squats have been crisp for several sessions." }
  );
  const decisionId = first.applied[0].result.decision.id;
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 200);

  const undone = applyChatActions(
    {
      actions: [{ type: "revert_decision", id: decisionId, reason: "That did not feel right." }],
    },
    { agent: "stub", message: "That did not work for me. Put it back." }
  );

  assert.equal(undone.applied[0].result.ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190);
  assert.equal(repo.getBrainDecision(decisionId).status, "reverted");
});

test("a model cannot turn decision discussion or explanation questions into Undo", () => {
  const announced = repo.recordDecision({
    effective_date: localDateISO(),
    kind: "training_structure",
    domain: "training",
    summary: "Move the next block to upper/lower",
    rationale: "Match the current recovery envelope.",
    source: "test",
    source_ref_type: "plan_proposal",
    source_ref_key: "77",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: true,
    action: { proposal_id: 77 },
  }).decision;
  const hallucinated = { actions: [{ type: "revert_decision", id: announced.id, reason: "model guessed veto" }] };
  const neutral = `Discuss scheduled Cairn decision #${announced.id}. Please explain how this fits my current data.`;
  for (const message of [
    neutral,
    "Why is this scheduled?",
    "Discuss this with me.",
    "What would undo do?",
    "Can you explain the change?",
    "Could you undo this if I decide to?",
    "Undo sounds useful; can you explain it?",
  ]) {
    assert.equal(hasExplicitDecisionRevertIntent(message, announced.id), false, message);
    assert.deepEqual(applyChatActions(hallucinated, { agent: "stub", message }).applied, [], message);
    assert.equal(repo.getBrainDecision(announced.id).status, "announced", message);
  }
});

test("explicit cancel and rollback commands retain exact server-owned Undo behavior", () => {
  const announced = repo.recordDecision({
    effective_date: localDateISO(),
    kind: "training_structure",
    domain: "training",
    summary: "Replace the current split next week",
    rationale: "A bounded block change.",
    source: "test",
    source_ref_type: "plan_proposal",
    source_ref_key: "78",
    status: "announced",
    autonomy_tier: "announce",
    risk_class: "moderate",
    reversible: true,
    action: { proposal_id: 78 },
  }).decision;
  assert.equal(hasExplicitDecisionRevertIntent("Keep my current split.", announced.id), true);
  assert.equal(hasExplicitDecisionRevertIntent("Stop this scheduled change.", announced.id), true);
  assert.equal(hasExplicitDecisionRevertIntent("Should I cancel the scheduled change?", announced.id), false);
  const cancelMessage = `Cancel the scheduled change in decision #${announced.id}.`;
  assert.equal(hasExplicitDecisionRevertIntent(cancelMessage, announced.id), true);
  const canceled = applyChatActions(
    { actions: [{ type: "revert_decision", id: announced.id, reason: "Keep the current split." }] },
    { agent: "stub", message: cancelMessage }
  );
  assert.equal(canceled.applied[0].result.ok, true);
  assert.equal(repo.getBrainDecision(announced.id).status, "canceled");

  repo.savePlanDay(1, "Lower", "legs", [{ exercise: "Squat", sets: 3, rep_low: 8, rep_high: 10, target_weight: 190 }]);
  const changed = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "small squat progression",
          changes: [{ day_number: 1, exercise: "Squat", target_weight: 200, reason: "Repeated crisp sessions." }],
        },
      ],
    },
    { agent: "stub", message: "Squats have been crisp for several sessions." }
  );
  const appliedId = changed.applied[0].result.decision.id;
  const rolledBack = applyChatActions(
    { actions: [{ type: "revert_decision", id: appliedId, reason: "Put it back." }] },
    { agent: "stub", message: `Revert decision #${appliedId}.` }
  );
  assert.equal(rolledBack.applied[0].result.ok, true);
  assert.equal(repo.getPlanDay(1).items[0].target_weight, 190);
  assert.equal(repo.getBrainDecision(appliedId).status, "reverted");
});

test("revert intent cannot redirect ids and invalid or nonreversible decisions remain unchanged", () => {
  const locked = repo.recordDecision({
    effective_date: localDateISO(),
    kind: "health_directive",
    domain: "health",
    summary: "Keep the clinical observation immutable.",
    rationale: "It is evidence, not a reversible plan write.",
    source: "test",
    source_ref_type: "directive",
    source_ref_key: "locked-1",
    status: "applied",
    autonomy_tier: "ask",
    risk_class: "clinical",
    reversible: false,
    action: null,
  }).decision;
  assert.equal(hasExplicitDecisionRevertIntent(`Undo decision #${locked.id + 1}.`, locked.id), false);
  assert.deepEqual(
    applyChatActions(
      { actions: [{ type: "revert_decision", id: locked.id, reason: "wrong model id" }] },
      { agent: "stub", message: `Undo decision #${locked.id + 1}.` }
    ).applied,
    []
  );
  const nonreversible = applyChatActions(
    { actions: [{ type: "revert_decision", id: locked.id, reason: "explicit request" }] },
    { agent: "stub", message: `Undo decision #${locked.id}.` }
  );
  assert.equal(nonreversible.applied[0].result.ok, false);
  assert.equal(repo.getBrainDecision(locked.id).status, "applied");

  const missingId = locked.id + 10_000;
  const missing = applyChatActions(
    { actions: [{ type: "revert_decision", id: missingId, reason: "explicit request" }] },
    { agent: "stub", message: `Undo decision #${missingId}.` }
  );
  assert.equal(missing.applied[0].result.ok, false);
  assert.equal(repo.getBrainDecision(locked.id).status, "applied");
});

test("applyChatActions ignores a plan update hallucinated during a food-only turn", () => {
  const { applied, drafts } = applyChatActions(
    {
      actions: [
        {
          type: "plan_update",
          summary: "unrelated",
          changes: [{ day_number: 1, exercise: "Squat", target_weight: 230 }],
        },
      ],
    },
    { agent: "stub", message: "Lunch today: double chicken salad, no dressing. Estimate it." }
  );
  assert.deepEqual(applied, []);
  assert.deepEqual(drafts, []);
});

test("food-only turns cannot restructure training or mutate goal identity", () => {
  repo.setProfile({ weight_lb: 180, goal_weight_lb: 170 });
  const { applied, drafts } = applyChatActions(
    {
      actions: [
        { type: "set_profile", weight_lb: 179, goal_weight_lb: 150, primary_discipline: "endurance" },
        {
          type: "set_training_intent",
          priorities: ["endurance", "longevity"],
          endurance_role: "primary",
          endurance_capacity: { sport: "running", target_duration_min: 120 },
        },
        { type: "set_endurance_goal", mode: "race", event: "Surprise Marathon", date: "2026-11-01" },
        {
          type: "plan_restructure",
          summary: "unrelated split",
          days: [{ day_number: 1, name: "Only running", items: [] }],
        },
      ],
    },
    { agent: "stub", message: "Lunch today: double chicken salad, no dressing. Estimate it." }
  );

  assert.equal(applied.length, 1, "the reported weight remains a safe capture");
  assert.equal(repo.getProfile().weight_lb, 179);
  assert.equal(repo.getProfile().goal_weight_lb, 170);
  assert.notEqual(repo.getProfile().primary_discipline, "endurance");
  assert.equal(repo.getProfile().training_intent_json, null);
  assert.equal(repo.getEnduranceGoal(), null);
  assert.deepEqual(drafts, []);
});

test("goal identity changes require an explicit athlete statement", () => {
  repo.setProfile({ goal_weight_lb: 170 });
  const inferred = applyChatActions(
    {
      actions: [
        { type: "set_profile", goal_weight_lb: 160 },
        {
          type: "set_training_intent",
          priorities: ["endurance", "longevity"],
          endurance_role: "primary",
        },
        { type: "set_endurance_goal", mode: "standing", label: "10k-ready" },
      ],
    },
    { agent: "stub", message: "What should my goal weight and running target be?" }
  );
  assert.deepEqual(inferred.applied, []);
  assert.equal(repo.getProfile().goal_weight_lb, 170);
  assert.equal(repo.getProfile().training_intent_json, null);
  assert.equal(repo.getEnduranceGoal(), null);

  const explicit = applyChatActions(
    {
      actions: [{ type: "set_profile", goal_weight_lb: 165 }],
    },
    { agent: "stub", message: "Set my goal weight to 165." }
  );
  assert.equal(explicit.applied.length, 1);
  assert.equal(repo.getProfile().goal_weight_lb, 165);

  const race = applyChatActions(
    {
      actions: [
        { type: "set_endurance_goal", mode: "race", event: "Cambridge Half", date: "2026-11-01", distance_km: 21.1 },
      ],
    },
    { agent: "stub", message: "I want to run the Cambridge Half on November 1." }
  );
  assert.equal(race.applied.length, 1);
  assert.equal(repo.getEnduranceGoal().event, "Cambridge Half");

  const hierarchy = applyChatActions(
    {
      actions: [
        {
          type: "set_training_intent",
          priorities: ["longevity", "muscle", "leanness", "endurance"],
          endurance_role: "supporting",
          endurance_capacity: {
            sport: "mountain biking",
            target_duration_min: 120,
            context: "technical trails in the Fells",
          },
        },
      ],
    },
    {
      agent: "stub",
      message:
        "My goals are longevity, building muscle and staying lean; endurance supports 2-hour mountain-bike rides.",
    }
  );
  assert.equal(hierarchy.applied.length, 1);
  assert.deepEqual(JSON.parse(repo.getProfile().training_intent_json), {
    priorities: ["longevity", "muscle", "leanness", "endurance"],
    endurance_role: "supporting",
    endurance_capacity: {
      sport: "mountain biking",
      target_duration_min: 120,
      context: "technical trails in the Fells",
    },
  });
});

test("applyChatActions ignores unknown action types without throwing", () => {
  const { applied, drafts } = applyChatActions({ actions: [{ type: "nonsense" }, "not-an-object"] }, { agent: "stub" });
  assert.deepEqual(applied, []);
  assert.deepEqual(drafts, []);
});

test("applyChatActions rejects malformed write actions before repo calls", () => {
  const { applied, drafts } = applyChatActions(
    {
      actions: [
        { type: "add_memory" },
        { type: "update_memory", id: "not-a-number", content: "bad id" },
        { type: "update_food_note", summary: "missing id" },
        { type: "plan_update", summary: "missing changes" },
        { type: "plan_restructure", days: [] },
      ],
    },
    { agent: "stub" }
  );
  assert.deepEqual(applied, []);
  assert.deepEqual(drafts, []);
  assert.deepEqual(repo.listMemory(10), []);
  assert.deepEqual(repo.listProposals(), []);
});

test("applyChatActions can correct an existing food note instead of duplicating it", () => {
  const row = repo.addFoodNote("breakfast", "", { summary: "Turkey toast", kcal: 310, protein_g: 28 });
  const { applied } = applyChatActions(
    {
      actions: [
        {
          type: "update_food_note",
          id: row.id,
          summary: "Turkey sourdough plate",
          kcal: 400,
          protein_g: 52,
          meal: "breakfast",
        },
      ],
    },
    { agent: "stub" }
  );

  assert.equal(applied.length, 1);
  assert.equal(applied[0].type, "update_food_note");
  const rows = repo.listFoodNotes(10);
  assert.equal(rows.length, 1, "the correction updated the existing row; it did not log a second breakfast");
  assert.equal(rows[0].parsed.summary, "Turkey sourdough plate");
  assert.equal(rows[0].parsed.kcal, 400);
  assert.equal(rows[0].parsed.protein_g, 52);
});

test("applyChatActions logs a bounded stated weigh-in and rejects malformed weight actions", () => {
  const { applied, drafts } = applyChatActions(
    { actions: [{ type: "log_weight", weight_lb: "178.4", date: "2026-07-22", note: "morning" }] },
    { agent: "stub", message: "I weighed in at 178.4 lb this morning." }
  );
  assert.deepEqual(drafts, []);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].type, "log_weight");
  assert.equal(repo.listWeight(10).at(-1).weight_lb, 178.4);
  assert.equal(repo.listWeight(10).at(-1).date, "2026-07-22");

  const rejected = applyChatActions(
    { actions: [{ type: "log_weight", weight_lb: "not-a-weight" }, { type: "log_weight", weight_lb: 0 }, { type: "log_weight", weight_lb: 701 }] },
    { agent: "stub", message: "ignore these" }
  );
  assert.deepEqual(rejected.applied, []);
  assert.equal(repo.listWeight(10).length, 1);
});

test("weight logging rejects invalid ranges and non-canonical or future dates without mutation", () => {
  repo.setProfile({ weight_lb: 180 });
  const beforeRows = repo.listWeight(10);
  const beforeProfile = repo.getProfile().weight_lb;
  for (const [weight, date] of [
    [49.9, undefined],
    [700.1, undefined],
    [180, "2026-7-2"],
    [180, "2026-02-30"],
    [180, "9999-01-01"],
  ]) {
    assert.throws(() => repo.logWeight(weight, date));
    assert.deepEqual(repo.listWeight(10), beforeRows);
    assert.equal(repo.getProfile().weight_lb, beforeProfile);
  }

  const historical = repo.logWeight(179.5, "2020-02-29", "valid historical leap day");
  assert.equal(historical.date, "2020-02-29");
  assert.equal(historical.weight_lb, 179.5);
});

test("applyChatActions logs at-home body measurements immediately", () => {
  const { applied, drafts } = applyChatActions(
    {
      actions: [{ type: "log_measurement", waist_in: 34, chest_in: 42, upper_arm_in: 15, source: "chat" }],
    },
    { agent: "stub" }
  );
  assert.equal(drafts.length, 0, "a measurement is a safe capture, not a draft");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].type, "log_measurement");
  assert.ok(applied[0].result?.ok, "the measurement applied");
  const latest = repo.latestBodyMeasurement();
  assert.equal(latest.waist_in, 34);
  assert.equal(latest.chest_in, 42);
  assert.equal(latest.upper_arm_in, 15);
});

test("applyChatActions drops an empty log_measurement before any repo write", () => {
  const { applied, drafts } = applyChatActions(
    {
      actions: [{ type: "log_measurement", note: "no numbers", source: "chat" }],
    },
    { agent: "stub" }
  );
  assert.deepEqual(applied, [], "nothing measurable → dropped by normalize");
  assert.deepEqual(drafts, []);
  assert.equal(repo.latestBodyMeasurement(), null);
});

test("photo food placeholder is created only for food-intent photo turns", () => {
  assert.equal(shouldCreatePhotoFoodPlaceholder(""), false, "photo-only waits for a vision log_food decision");
  assert.equal(shouldCreatePhotoFoodPlaceholder("Lunch plate for today"), true);
  assert.equal(
    shouldCreatePhotoFoodPlaceholder("look at the physique check-in"),
    false,
    "non-food images do not become food notes"
  );
});
