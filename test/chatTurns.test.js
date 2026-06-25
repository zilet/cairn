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
//   - applyChatActions: a safe action applies; a plan_update becomes a DRAFT proposal
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";
import { applyChatActions, shouldCreatePhotoFoodPlaceholder } from "../dist/chatTurns.js";

beforeEach(() => {
  for (const t of ["chat_turns", "chat_messages", "memory", "plan_proposals", "food_notes"]) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
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

test("listActiveChatTurns returns queued+running oldest-first, excludes terminal", () => {
  const a = repo.createChatTurn({ message: "a" });
  const b = repo.createChatTurn({ message: "b" });
  const c = repo.createChatTurn({ message: "c" });
  repo.markChatTurnRunning(a.id);                 // running
  repo.finishChatTurn(c.id, { reply: "done" });   // terminal → excluded
  const active = repo.listActiveChatTurns();
  assert.deepEqual(active.map((t) => t.id), [a.id, b.id], "running a + queued b, in id order; finished c gone");
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
  const interrupted = repo.createChatTurn({ message: "was running", user_message_id: repo.addChatMessage("user", "was running").id });
  repo.markChatTurnRunning(interrupted.id);
  const queued = repo.createChatTurn({ message: "still queued" });

  const before = repo.listChatMessages(50).length;
  const { requeue, interrupted: n } = repo.recoverChatTurns();

  assert.equal(n, 1, "one interrupted run");
  assert.deepEqual(requeue, [queued.id], "the queued turn is handed back to re-drain");
  assert.equal(repo.getChatTurn(interrupted.id).status, "error", "interrupted run marked error (actions may have partially applied)");
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
  assert.deepEqual(history.map((h) => h.content), ["first", "reply to first"], "only what preceded m3");
});

test("applyChatActions applies a safe action and turns a plan_update into a DRAFT proposal", () => {
  const parsed = {
    reply: "logged + drafted",
    actions: [
      { type: "add_memory", content: "prefers evening training", kind: "preference" },
      { type: "plan_update", summary: "bump squat", changes: [{ exercise: "Squat", target_weight: 230 }] },
    ],
  };
  const { applied, drafts } = applyChatActions(parsed, { agent: "stub" });
  assert.equal(applied.length, 1, "the memory applied immediately");
  assert.equal(applied[0].type, "add_memory");
  assert.equal(drafts.length, 1, "the plan change became a draft, not an immediate apply");
  // The draft is a real persisted proposal in 'draft' status (never auto-applied).
  const prop = repo.getProposal(drafts[0].id);
  assert.equal(prop.status, "draft");
  assert.ok(repo.listMemory(10).some((m) => /evening training/.test(m.content)), "memory landed in the store");
});

test("applyChatActions ignores unknown action types without throwing", () => {
  const { applied, drafts } = applyChatActions({ actions: [{ type: "nonsense" }, "not-an-object"] }, { agent: "stub" });
  assert.deepEqual(applied, []);
  assert.deepEqual(drafts, []);
});

test("applyChatActions can correct an existing food note instead of duplicating it", () => {
  const row = repo.addFoodNote("breakfast", "", { summary: "Turkey toast", kcal: 310, protein_g: 28 });
  const { applied } = applyChatActions({
    actions: [
      { type: "update_food_note", id: row.id, summary: "Turkey sourdough plate", kcal: 400, protein_g: 52, meal: "breakfast" },
    ],
  }, { agent: "stub" });

  assert.equal(applied.length, 1);
  assert.equal(applied[0].type, "update_food_note");
  const rows = repo.listFoodNotes(10);
  assert.equal(rows.length, 1, "the correction updated the existing row; it did not log a second breakfast");
  assert.equal(rows[0].parsed.summary, "Turkey sourdough plate");
  assert.equal(rows[0].parsed.kcal, 400);
  assert.equal(rows[0].parsed.protein_g, 52);
});

test("photo food placeholder is created only for food-intent photo turns", () => {
  assert.equal(shouldCreatePhotoFoodPlaceholder(""), true, "photo-only keeps the plate-capture path");
  assert.equal(shouldCreatePhotoFoodPlaceholder("Lunch plate for today"), true);
  assert.equal(shouldCreatePhotoFoodPlaceholder("look at the physique check-in"), false, "non-food images do not become food notes");
});
