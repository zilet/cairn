import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo } from "./_seed.js";

beforeEach(() => {
  db.prepare("DELETE FROM chat_messages").run();
});

test("archived chat sessions get a stable session_id for deep links", () => {
  const first = repo.addChatMessage("user", "Can you review today's run?", null);
  repo.addChatMessage("assistant", "Yes. Keep it easy today.", "stub");

  const archived = repo.archiveChat();

  assert.equal(archived.archived, 2);
  assert.equal(archived.session_id, `chat_${first.id}`);
  assert.deepEqual(repo.listChatMessages(), [], "archived messages leave the live thread");

  const sessions = repo.listArchivedSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].session_id, archived.session_id);
  assert.equal(sessions[0].count, 2);
  assert.match(sessions[0].preview, /today's run/);

  const bySession = repo.getArchivedConversation(archived.session_id);
  assert.deepEqual(bySession.map((m) => m.content), ["Can you review today's run?", "Yes. Keep it easy today."]);

  const byLegacyTime = repo.getArchivedConversation(sessions[0].archived_at);
  assert.deepEqual(byLegacyTime.map((m) => m.id), bySession.map((m) => m.id), "legacy archived_at links still resolve");
});

test("chat history search returns session_id for archived hits and null for live hits", () => {
  const archivedUser = repo.addChatMessage("user", "Find my magnesium note later", null);
  repo.addChatMessage("assistant", "Captured.", "stub");
  const archived = repo.archiveChat();
  repo.addChatMessage("user", "Live magnesium follow-up", null);

  const hits = repo.searchChatMessages("magnesium", 10);
  const archivedHit = hits.find((h) => h.id === archivedUser.id);
  const liveHit = hits.find((h) => /Live magnesium/.test(h.snippet));

  assert.equal(archivedHit?.session_id, archived.session_id);
  assert.ok(archivedHit?.archived_at, "archived hit keeps legacy timestamp for old clients");
  assert.equal(liveHit?.session_id, null);
  assert.equal(liveHit?.archived_at, null);
});
