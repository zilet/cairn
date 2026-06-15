// Prose-first chat contract (parseChatReply) + per-CLI streaming adapters
// (streamDelta) — the two pure, offline-testable pieces of the token-streaming
// layer. No agent runs: parseChatReply splits a finished reply into prose +
// actions, and streamDelta maps one NDJSON line from a streaming CLI to the
// assistant text it carries. Schemas: claude verified live, grok from xAI's ACP
// docs; an unknown shape must yield null (no garbage → the worker falls back).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChatReply, CHAT_ACTION_SENTINEL } from "../dist/prompt.js";
import { streamDelta } from "../dist/agents.js";

test("parseChatReply: prose before the sentinel is the reply; JSON after is the actions", () => {
  const out = `Nice work — your squat's moving. I'd hold volume steady this week.
${CHAT_ACTION_SENTINEL}
{"actions": [{"type": "add_memory", "content": "prefers evening lifts", "kind": "preference"}]}`;
  const { reply, actions } = parseChatReply(out);
  assert.equal(reply, "Nice work — your squat's moving. I'd hold volume steady this week.");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "add_memory");
});

test("parseChatReply: pure prose (no sentinel) → whole text is the reply, no actions", () => {
  const { reply, actions } = parseChatReply("You're recovered and due — good to train today.");
  assert.equal(reply, "You're recovered and due — good to train today.");
  assert.deepEqual(actions, []);
});

test("parseChatReply: a malformed actions block keeps the reply, drops the actions", () => {
  const out = `Logged it.\n${CHAT_ACTION_SENTINEL}\n{"actions": [ {oops not json `;
  const { reply, actions } = parseChatReply(out);
  assert.equal(reply, "Logged it.");
  assert.deepEqual(actions, []);
});

test("parseChatReply: backward-compatible with the legacy {reply, actions} JSON shape", () => {
  const legacy = `{"reply": "Bumped your bench.", "actions": [{"type": "log_set", "exercise": "Bench", "weight": 140, "reps": 5}]}`;
  const { reply, actions } = parseChatReply(legacy);
  assert.equal(reply, "Bumped your bench.");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].exercise, "Bench");
});

test("streamDelta(claude): extracts text_delta chunks, ignores non-text events", () => {
  const delta = `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}}`;
  assert.equal(streamDelta("claude", delta), "hello");
  // a thinking delta is not assistant text
  assert.equal(streamDelta("claude", `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}`), null);
  // the system/init and result envelope lines carry no streamable text
  assert.equal(streamDelta("claude", `{"type":"system","subtype":"init"}`), null);
  assert.equal(streamDelta("claude", `{"type":"result","subtype":"success","result":"hello"}`), null);
});

test("streamDelta(grok): extracts {type:text} chunks, ignores thought/end (verified live, 0.2.51)", () => {
  assert.equal(streamDelta("grok", `{"type":"text","data":"on pace"}`), "on pace");
  // reasoning deltas and the terminal event are not assistant text
  assert.equal(streamDelta("grok", `{"type":"thought","data":"the user is asking"}`), null);
  assert.equal(streamDelta("grok", `{"type":"end","stopReason":"EndTurn","sessionId":"abc"}`), null);
  // still tolerates the older xAI ACP shape as a fallback
  assert.equal(streamDelta("grok", `{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"text":"hi"}}}}`), "hi");
});

test("streamDelta: junk / unknown shapes yield null, never garbage", () => {
  assert.equal(streamDelta("claude", "not json at all"), null);
  assert.equal(streamDelta("claude", ""), null);
  assert.equal(streamDelta("grok", `{"unrelated":true}`), null);
  assert.equal(streamDelta("codex", `{"type":"item.completed","item":{"type":"agent_message","text":"x"}}`), null); // codex is one-shot, not a stream format
});
