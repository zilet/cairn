// Chat honours provider holds the way the job rotation does: a held provider is not
// spawned while its hold is live, a turn with EVERY provider held fails fast with the
// calm "couldn't reach" reply (no spawn), and once a hold lapses the next turn probes
// that provider again. Live, four whole days of chat spawned every held CLI just to
// print "Couldn't reach a coaching agent. Tried …".
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { loadAgents } from "../dist/agents.js";
import { runChatCompletion } from "../dist/chatTurns.js";

beforeEach(() => {
  resetTables("chat_turns", "chat_messages");
  db.prepare("DELETE FROM agent_availability").run();
  db.prepare("DELETE FROM settings WHERE id = 1").run();
  repo.setSettings({ enrich_enabled: false });
});

const WEEKLY = (resetsAt) => ({ state: "quota_exhausted", window: "7d", resets_at: resetsAt, detail: "Weekly limit" });

function turn(agent) {
  return { id: 9191, agent, message: "how is my week going?", image_path: null, routing: null };
}

function spawnCounter() {
  const seen = [];
  const reply = async (name, _prompt, opts) => {
    seen.push(name);
    const raw = "===CAIRN_REPLY===\nSteady week.";
    opts?.onDelta?.(raw);
    return { code: 0, raw, stderr: "", usage: {} };
  };
  return { seen, deps: { supportsStream: () => true, runAgentStreaming: reply, runAgent: reply } };
}

test("every provider held: the turn fails fast with the calm reply and spawns nothing", async () => {
  const resetsAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
  for (const name of Object.keys(loadAgents())) repo.noteAgentFailure(name, WEEKLY(resetsAt), "chat");
  const { seen, deps } = spawnCounter();
  await assert.rejects(
    () => runChatCompletion(9191, turn("claude"), [], new AbortController().signal, deps),
    (err) => {
      assert.equal(err.name, "ChatCompletionError");
      assert.ok(err.attempts.length >= 1);
      for (const a of err.attempts) {
        assert.equal(a.ok, false);
        assert.equal(a.status, "quota_exhausted");
        assert.match(a.error_message, /^weekly limit, resets /);
      }
      return true;
    }
  );
  assert.deepEqual(seen, [], "no CLI was spawned for an all-held turn");
});

test("a held provider sits out while another answers, and is probed again once its hold lapses", async () => {
  // claude held until tomorrow: the turn must route around it without spawning it.
  repo.noteAgentFailure("claude", WEEKLY(new Date(Date.now() + 86_400_000).toISOString()), "chat");
  const first = spawnCounter();
  const out = await runChatCompletion(9191, turn("claude"), [], new AbortController().signal, first.deps).catch(
    (e) => e
  );
  assert.ok(!first.seen.includes("claude"), `claude was spawned while held: ${first.seen.join(",")}`);
  // With no other usable provider in this offline table the turn may fail — but never
  // by spawning the held one.
  void out;

  // The hold lapses (its reset passed): the next turn probes claude first again.
  repo.clearAgentAvailability("claude");
  repo.noteAgentFailure("claude", WEEKLY(null), "chat", new Date(Date.now() - 3 * 86_400_000));
  assert.equal(repo.getAgentAvailability("claude"), null);
  const second = spawnCounter();
  const ok = await runChatCompletion(9191, turn("claude"), [], new AbortController().signal, second.deps);
  assert.equal(ok.agent, "claude");
  assert.equal(second.seen[0], "claude");
});
