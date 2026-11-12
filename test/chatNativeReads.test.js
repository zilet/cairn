// A chat turn over the NATIVE coach-read transport (src/chatTurns.ts + src/coachReadMcp.ts
// + src/brain/read-transport.ts), driven offline: the listener and the CLI are injected
// (no socket, no spawn). Pins: the native run gets the attach args and the coach_reads
// policy, reads inside ONE run and records them; pre-marker tool chatter never reaches
// the bubble; a failed attach falls back ONCE to the prompt loop on the same agent;
// "full" context and photo turns never go native; a busy host stops the rotation instead
// of failing over; the whole turn stores its reads on the assistant message's meta and
// in agent_runs. Plus the routing order (native first, explicit choices untouched).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "./_seed.js";
import { db, repo, resetTables } from "./_seed.js";
import { chatCoachReadOrder, chatTurnPinsAgent, runChatCompletion, runQueuedChatTurn, onTurnEvent } from "../dist/chatTurns.js";
import { buildChatProviderOrder } from "../dist/chat-routing-runtime.js";
import { createCoachReadGate, gatedCoachRead } from "../dist/coachReadMcp.js";
import {
  AGENT_BUSY_MAX_DEFERRALS,
  AgentBusyError,
  isAgentBusyError,
  resetAgentBusyDeferralsForTest,
} from "../dist/agent-busy.js";
import { streamDelta } from "../dist/agents.js";
import { orderChatForCoachReads } from "../dist/repo/settings.js";

const FAKE_URL = "http://127.0.0.1:40404/mcp/abcdefghijklmnopqrstuvwxyz012345";
const NATIVE = {
  transport: "native_mcp",
  spec: { transport: "native_mcp", attach_args: ["--attach", "{mcp_url}", "--allow", "{allowed_tools}"], allowed_tool_template: "t__{tool}" },
};
const readResult = (tool) => ({ tool, data: { events: [] }, rows_returned: 0, truncated: false });

function nativeHarness({ listenerFails = false } = {}) {
  const state = { gate: null, starts: 0, closes: 0 };
  return {
    state,
    resolveReadTransport: () => NATIVE,
    startReadListener: async (opts) => {
      state.starts++;
      if (listenerFails) throw new Error("listen EADDRINUSE");
      state.gate = createCoachReadGate(opts.budget);
      return {
        url: FAKE_URL,
        token: "t",
        gate: state.gate,
        rearm: () => {},
        close: async () => {
          state.closes++;
        },
      };
    },
  };
}

// A streamed CLI run that, when attached, "calls" reads through the gate the way the
// MCP server would, narrates a step before the marker, then replies.
function nativeStream(harness, calls, { reads = ["read_training_window"], reply = "Squat moved up 10 lb since September." } = {}) {
  return async (name, prompt, opts) => {
    calls.push({ name, prompt, opts });
    if (opts.mcpConfigArgs?.includes(FAKE_URL) && harness.state.gate) {
      harness.state.gate.requests += 2; // initialize + tools/list
      for (const tool of reads) gatedCoachRead(harness.state.gate, tool, {}, { run_id: "t", op: "chat" }, () => readResult(tool));
    }
    const raw = `Let me check your training history first.\n===CAIRN_REPLY===\n${reply}\n`;
    for (const piece of raw.match(/[\s\S]{1,9}/g) ?? [raw]) opts.onDelta?.(piece);
    return { code: 0, raw, stderr: "", usage: {} };
  };
}

function turnFixture(overrides = {}) {
  return { id: 5151, agent: "stub", message: "How has my squat moved over the last two months?", image_path: null, routing: null, ...overrides };
}

beforeEach(() => {
  resetTables("chat_turns", "chat_messages", "agent_runs");
  repo.setSettings({ chat_context: "lean" });
});

test("a native turn reads inside one run, records the reads, and streams only the reply", async () => {
  const events = [];
  const off = onTurnEvent(5151, (e) => events.push(e));
  const harness = nativeHarness();
  const calls = [];
  const out = await runChatCompletion(5151, turnFixture(), [], new AbortController().signal, {
    ...harness,
    supportsStream: () => true,
    runAgentStreaming: nativeStream(harness, calls, { reads: ["read_exercise_history", "read_training_window"] }),
  });
  off();

  assert.equal(calls.length, 1, "one CLI run, however many reads");
  const { opts, prompt } = calls[0];
  assert.equal(opts.tools, "coach_reads");
  assert.deepEqual(opts.mcpConfigArgs.slice(0, 2), ["--attach", FAKE_URL]);
  assert.match(opts.mcpConfigArgs[3], /^t__read_exercise_history,/);
  assert.match(prompt, /=== COACH READS: YOUR TOOLS ===/);
  assert.doesNotMatch(prompt, /"kind":"coach_read"/, "no JSON protocol on the native path");
  assert.equal(harness.state.starts, 1);
  assert.equal(harness.state.closes, 1, "the listener is closed when the run ends");

  assert.equal(out.reads.transport, "native_mcp");
  assert.deepEqual(
    out.reads.calls.map((c) => [c.tool, c.ok]),
    [
      ["read_exercise_history", true],
      ["read_training_window", true],
    ]
  );
  assert.equal(out.reads.rounds, 1);
  assert.ok(out.reads.total_bytes > 0);
  assert.ok(out.promptBytes > 0);
  const final = out.attempts.at(-1);
  assert.deepEqual([final.status, final.read_transport, final.read_calls], ["ok", "native_mcp", 2]);

  const bubble = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.match(bubble, /Squat moved up 10 lb/);
  assert.doesNotMatch(bubble, /Let me check/, "pre-marker tool chatter never reaches the bubble");
});

test("claude's stream-json tool events are never text: only text deltas reach the reply", () => {
  const lines = [
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "mcp__cairn-coach-read__read_training_window" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"weeks":6}' } } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__cairn-coach-read__read_training_window", input: { weeks: 6 } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: '{"events":[]}' }] } },
  ];
  for (const line of lines) assert.equal(streamDelta("claude", JSON.stringify(line)), null);
  assert.equal(
    streamDelta("claude", JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } })),
    "Hi"
  );
});

test("a CLI that rejects the attach falls back ONCE to the prompt loop on the same agent", async () => {
  const harness = nativeHarness();
  const calls = [];
  let n = 0;
  const out = await runChatCompletion(5151, turnFixture(), [], new AbortController().signal, {
    ...harness,
    supportsStream: () => true,
    runAgentStreaming: async (name, prompt, opts) => {
      calls.push({ name, prompt, opts });
      if (n++ === 0) return { code: 2, raw: "", stderr: "error: unexpected argument '--attach' found", usage: {} };
      const raw = "===CAIRN_REPLY===\nHere is your squat trend.";
      opts.onDelta?.(raw);
      return { code: 0, raw, stderr: "", usage: {} };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, calls[1].name, "the same agent, not the next one");
  assert.equal(calls[1].opts.mcpConfigArgs, undefined, "the retry is not attached");
  assert.equal(calls[1].opts.tools, "none");
  assert.match(calls[1].prompt, /=== COACH READS: LOOK IT UP ===/);
  assert.match(calls[1].prompt, /"kind":"coach_read"/);
  assert.ok(out.attempts.some((a) => a.status === "read_attach_failed"));
  assert.equal(out.reads.transport, "prompt_loop");
  assert.equal(out.reads.native_fallback, true);
  assert.match(out.raw, /squat trend/);
});

test("a listener that will not start falls back to the prompt loop without launching attached", async () => {
  const harness = nativeHarness({ listenerFails: true });
  const calls = [];
  const out = await runChatCompletion(5151, turnFixture(), [], new AbortController().signal, {
    ...harness,
    supportsStream: () => true,
    runAgentStreaming: nativeStream(harness, calls),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.mcpConfigArgs, undefined);
  assert.equal(out.reads.transport, "prompt_loop");
  assert.equal(out.reads.native_fallback, true);
});

test("chat_context 'full' keeps today's path: full DATA, the old contract, no listener", async () => {
  repo.setSettings({ chat_context: "full" });
  const harness = nativeHarness();
  const calls = [];
  await runChatCompletion(5151, turnFixture(), [], new AbortController().signal, {
    ...harness,
    supportsStream: () => true,
    runAgentStreaming: nativeStream(harness, calls),
  });
  assert.equal(harness.state.starts, 0);
  assert.equal(calls[0].opts.mcpConfigArgs, undefined);
  assert.equal(calls[0].opts.tools, "none");
  assert.match(calls[0].prompt, /LOOK SOMETHING UP FIRST/);
  assert.match(calls[0].prompt, /You can SEE all their data/);
});

test("a photo turn never goes native (the CLI must open the file)", async () => {
  const harness = nativeHarness();
  const calls = [];
  await runChatCompletion(5151, turnFixture({ image_path: "/tmp/plate.jpg", message: "how does this fit my day?" }), [], new AbortController().signal, {
    ...harness,
    supportsStream: () => true,
    runAgentStreaming: nativeStream(harness, calls),
  });
  assert.equal(harness.state.starts, 0);
  assert.equal(calls[0].opts.mcpConfigArgs, undefined);
});

test("a busy host is not a failed provider: the rotation stops and the typed error goes up", async () => {
  const calls = [];
  await assert.rejects(
    runChatCompletion(5151, turnFixture(), [], new AbortController().signal, {
      supportsStream: () => true,
      runAgentStreaming: async (name, _prompt, opts) => {
        calls.push({ name, opts });
        throw new AgentBusyError(name, 1000);
      },
      runAgent: async (name) => {
        calls.push({ name, rotated: true });
        return { code: 0, raw: "===CAIRN_REPLY===\nshould not run", stderr: "", usage: {} };
      },
    }),
    (error) => isAgentBusyError(error)
  );
  assert.equal(calls.length, 1, "no other agent was tried for the same process-wide permit");
  const run = db.prepare(`SELECT status FROM agent_runs WHERE chat_turn_id = 5151 ORDER BY id DESC LIMIT 1`).get();
  assert.equal(run.status, "agent_busy");
});

test("a busy turn is DEFERRED back into the queue, bounded, and only then says it could not start", async () => {
  resetAgentBusyDeferralsForTest();
  const { turn } = repo.createChatRequest({ user_content: "How did my week go?", message: "How did my week go?", agent: "stub" });
  const busy = {
    supportsStream: () => true,
    // A very long rest: the test re-drives the turn itself; the real re-queue timer is unref'd.
    busyRetryMs: 3_600_000,
    runAgentStreaming: async (name) => {
      throw new AgentBusyError(name, 1000);
    },
  };
  for (let i = 1; i <= AGENT_BUSY_MAX_DEFERRALS; i++) {
    await runQueuedChatTurn(turn.id, busy);
    const stored = repo.getChatTurn(turn.id);
    assert.equal(stored.status, "queued", `deferral ${i}: the turn waits in line`);
    assert.equal(stored.phase, "queued");
    assert.equal(stored.assistant_message_id, null, "no failure reply was written");
  }
  // Deferrals spent: now it fails like anything else, with a calm "could not start".
  await runQueuedChatTurn(turn.id, busy);
  const failed = repo.getChatTurn(turn.id);
  assert.equal(failed.status, "error");
  const message = repo.getChatMessage(failed.assistant_message_id);
  assert.match(message.content, /couldn't start/);
  assert.doesNotMatch(message.content, /Settings/);
  assert.equal(message.meta.agent_busy, true);

  // And a deferred turn that then gets its permit runs normally, its count cleared.
  resetAgentBusyDeferralsForTest();
  const { turn: next } = repo.createChatRequest({ user_content: "And today?", message: "And today?", agent: "stub" });
  await runQueuedChatTurn(next.id, busy);
  assert.equal(repo.getChatTurn(next.id).status, "queued");
  const harness = nativeHarness();
  await runQueuedChatTurn(next.id, {
    ...harness,
    supportsStream: () => true,
    runAgentStreaming: nativeStream(harness, [], { reply: "Today is a training day." }),
  });
  assert.equal(repo.getChatTurn(next.id).status, "done");
});

test("a whole native turn stores its reads on the assistant message and in agent_runs", async () => {
  const { turn } = repo.createChatRequest({ user_content: "What was my last ApoB?", message: "What was my last ApoB?", agent: "stub" });
  const harness = nativeHarness();
  const calls = [];
  await runQueuedChatTurn(turn.id, {
    ...harness,
    supportsStream: () => true,
    runAgentStreaming: nativeStream(harness, calls, { reads: ["read_marker_history"], reply: "Your last ApoB was 98 mg/dL." }),
  });
  const stored = repo.getChatTurn(turn.id);
  assert.equal(stored.status, "done");
  const message = repo.getChatMessage(stored.assistant_message_id);
  assert.match(message.content, /ApoB was 98/);
  assert.equal(message.meta.reads.transport, "native_mcp");
  assert.deepEqual(message.meta.reads.calls.map((c) => c.tool), ["read_marker_history"]);
  assert.ok(message.meta.prompt_bytes > 0);
  assert.doesNotMatch(JSON.stringify(message.meta.reads), /ApoB/, "no athlete text in the read telemetry");
  const run = db
    .prepare(`SELECT read_transport, read_calls, prompt_bytes FROM agent_runs WHERE chat_turn_id = ? ORDER BY id DESC LIMIT 1`)
    .get(turn.id);
  assert.deepEqual({ ...run, prompt_bytes: run.prompt_bytes > 0 }, { read_transport: "native_mcp", read_calls: 1, prompt_bytes: true });
});

test("routing: native-capable agents first, explicit choices untouched, nothing held is lifted", () => {
  const native = (name) => name === "claude" || name === "codex";
  assert.deepEqual(orderChatForCoachReads(["grok", "claude", "antigravity", "codex"], { explicit: false, readsNatively: native }), [
    "claude",
    "codex",
    "grok",
    "antigravity",
  ]);
  // A named agent or a chat route pin is the person's choice for the turn.
  assert.deepEqual(orderChatForCoachReads(["grok", "claude"], { explicit: true, readsNatively: native }), ["grok", "claude"]);
  // The input is the open order — a held native agent is not in it and is never added.
  assert.deepEqual(orderChatForCoachReads(["grok", "antigravity"], { explicit: false, readsNatively: native }), ["grok", "antigravity"]);
  // A predicate that throws never reorders anything.
  assert.deepEqual(
    orderChatForCoachReads(["grok", "claude"], {
      explicit: false,
      readsNatively: () => {
        throw new Error("x");
      },
    }),
    ["grok", "claude"]
  );
});

// ---------- the NON-streaming native path (codex's real path) ----------

function nativeOneShot(harness, calls, { reads = ["read_training_window"], replies = ["===CAIRN_REPLY===\nYour run week has two easy runs and a long run."] } = {}) {
  let n = 0;
  return async (name, prompt, opts) => {
    calls.push({ name, prompt, opts });
    if (opts.mcpConfigArgs?.includes(FAKE_URL) && harness.state.gate) {
      opts.onPermit?.();
      harness.state.gate.requests += 2;
      for (const tool of reads) gatedCoachRead(harness.state.gate, tool, {}, { run_id: "t", op: "chat" }, () => readResult(tool));
    }
    const raw = replies[Math.min(n++, replies.length - 1)];
    return { code: 0, raw, stderr: "", usage: {} };
  };
}

test("non-streaming native: one attached run, reads recorded, the reply taken from stdout", async () => {
  const harness = nativeHarness();
  const calls = [];
  const out = await runChatCompletion(5151, turnFixture({ message: "What's my run plan this week and why?" }), [], new AbortController().signal, {
    ...harness,
    supportsStream: () => false,
    runAgent: nativeOneShot(harness, calls, { reads: ["read_run_week"] }),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.tools, "coach_reads");
  assert.ok(calls[0].opts.mcpConfigArgs.includes(FAKE_URL));
  assert.equal(typeof calls[0].opts.onPermit, "function", "the permit hook rides the launch");
  assert.equal(out.reads.transport, "native_mcp");
  assert.deepEqual(out.reads.calls.map((c) => c.tool), ["read_run_week"]);
  assert.match(out.raw, /two easy runs/);
  assert.equal(harness.state.closes, 1);
});

test("non-streaming native: connected but empty retries the SAME agent once on the prompt loop", async () => {
  const harness = nativeHarness();
  const calls = [];
  const out = await runChatCompletion(5151, turnFixture(), [], new AbortController().signal, {
    ...harness,
    supportsStream: () => false,
    runAgent: nativeOneShot(harness, calls, { replies: ["", "===CAIRN_REPLY===\nSquat is up 10 lb."] }),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, calls[1].name);
  assert.ok(calls[0].opts.mcpConfigArgs, "the first run was attached");
  assert.equal(calls[1].opts.mcpConfigArgs, undefined, "the retry is the prompt loop");
  assert.match(calls[1].prompt, /=== COACH READS: LOOK IT UP ===/);
  assert.ok(out.attempts.some((a) => a.status === "empty_reply" && a.read_transport === "native_mcp"));
  assert.equal(out.reads.native_fallback, true);
  assert.match(out.raw, /Squat is up/);
});

test("streaming native: connected but empty retries the SAME agent once on the prompt loop", async () => {
  const harness = nativeHarness();
  const calls = [];
  let n = 0;
  const out = await runChatCompletion(5151, turnFixture(), [], new AbortController().signal, {
    ...harness,
    supportsStream: () => true,
    runAgentStreaming: async (name, prompt, opts) => {
      calls.push({ name, prompt, opts });
      if (n++ === 0) {
        harness.state.gate.requests += 1;
        return { code: 0, raw: "", stderr: "", usage: {} };
      }
      const raw = "===CAIRN_REPLY===\nHere it is.";
      opts.onDelta?.(raw);
      return { code: 0, raw, stderr: "", usage: {} };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].name, calls[0].name);
  assert.equal(calls[1].opts.mcpConfigArgs, undefined);
  assert.match(out.raw, /Here it is/);
});

test("a native run that answers in the JSON protocol falls back on the budget it already spent", async () => {
  const harness = nativeHarness();
  const calls = [];
  const reads = Array.from({ length: 6 }, () => "read_training_window");
  const out = await runChatCompletion(5151, turnFixture(), [], new AbortController().signal, {
    ...harness,
    supportsStream: () => false,
    runAgent: nativeOneShot(harness, calls, {
      reads,
      replies: [JSON.stringify({ kind: "coach_read", requests: [{ tool: "read_training_window", args: { weeks: 4 } }] }), "===CAIRN_REPLY===\nDone."],
    }),
    executeCoachRead: () => {
      throw new Error("the spent budget must not allow another read");
    },
  });
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].prompt, /=== COACH READS: LOOK IT UP ===/, "six native reads spent the turn's budget: no contract");
  assert.equal(out.reads.calls.length, 6);
  assert.match(out.raw, /Done/);
});

test("a CLI that is not installed (spawn ENOENT) or not signed in is not an attach failure", async () => {
  for (const error of [new Error('failed to launch "codex": spawn codex ENOENT'), new Error("Not logged in · Please run /login")]) {
    const harness = nativeHarness();
    const calls = [];
    await assert.rejects(
      runChatCompletion(5151, turnFixture(), [], new AbortController().signal, {
        ...harness,
        supportsStream: () => false,
        runAgent: async (name, _prompt, opts) => {
          calls.push({ name, opts });
          throw error;
        },
      })
    );
    assert.equal(calls.length, 1, `${error.message}: no fallback launch was spent`);
  }
});

test("the listener's first TTL covers a permit wait, and the permit re-arms it for the run", async () => {
  const rearmed = [];
  let startTtl = null;
  const harness = {
    resolveReadTransport: () => NATIVE,
    startReadListener: async (opts) => {
      startTtl = opts.ttlMs;
      const gate = createCoachReadGate(opts.budget);
      return { url: FAKE_URL, token: "t", gate, rearm: (ms) => rearmed.push(ms), close: async () => {} };
    },
  };
  await runChatCompletion(5151, turnFixture(), [], new AbortController().signal, {
    ...harness,
    supportsStream: () => false,
    runAgent: async (_name, _prompt, opts) => {
      assert.ok(startTtl >= 2 * opts.timeoutMs, "the first TTL outlasts a full permit wait plus the run");
      opts.onPermit?.();
      return { code: 0, raw: "===CAIRN_REPLY===\nok", stderr: "", usage: {} };
    },
  });
  assert.equal(rearmed.length, 1);
  assert.ok(rearmed[0] > 0 && rearmed[0] < startTtl);
});

test("routing reorders for native only on a native-eligible turn", () => {
  const native = (name) => name === "claude";
  const open = ["grok", "claude"];
  const base = { leanReads: true, nativeEligible: true, explicit: false, readsNatively: native };
  assert.deepEqual(chatCoachReadOrder(open, base), ["claude", "grok"]);
  // A photo or current-research turn reads over the prompt loop: no reason to reorder.
  assert.deepEqual(chatCoachReadOrder(open, { ...base, nativeEligible: false }), ["grok", "claude"]);
  // "full" context (no lean reads) and an explicit choice leave the order alone too.
  assert.deepEqual(chatCoachReadOrder(open, { ...base, leanReads: false }), ["grok", "claude"]);
  assert.deepEqual(chatCoachReadOrder(open, { ...base, explicit: true }), ["grok", "claude"]);
});

test("a class order is a head preference: a native reader is lifted past it, a named agent or route pin is not", () => {
  const native = (name) => name === "claude" || name === "codex";
  // Settings → Agents class order {fast:["antigravity","claude"]}, auto-routed turn: the
  // open order arrives class-first. On a reading lane claude reads natively, so it leads.
  const classFirstOpen = buildChatProviderOrder("auto", ["grok", "claude", "codex", "antigravity"], {
    classFirst: ["antigravity", "claude"],
  });
  assert.deepEqual(classFirstOpen, ["antigravity", "claude", "grok", "codex"]);
  const pinned = chatTurnPinsAgent("auto", "auto");
  assert.equal(pinned, false, "a class order alone is not a per-turn choice");
  const base = { leanReads: true, nativeEligible: true, explicit: pinned, readsNatively: native };
  // Among several native agents the class/policy order stands (claude before codex).
  assert.deepEqual(chatCoachReadOrder(classFirstOpen, base), ["claude", "codex", "antigravity", "grok"]);
  // Capture lane (no lean reads), photo and current-research turns keep the class order.
  assert.deepEqual(chatCoachReadOrder(classFirstOpen, { ...base, leanReads: false }), classFirstOpen);
  assert.deepEqual(chatCoachReadOrder(classFirstOpen, { ...base, nativeEligible: false }), classFirstOpen);

  // A NAMED agent for the turn, or a chat route pin, still wins and is never reordered.
  assert.equal(chatTurnPinsAgent("antigravity", "antigravity"), true, "named for the turn");
  assert.equal(chatTurnPinsAgent("auto", "antigravity"), true, "chat route pin");
  assert.equal(chatTurnPinsAgent(undefined, "antigravity"), true, "route pin on a blank turn");
  assert.equal(chatTurnPinsAgent("", undefined), false);
  const pinOpen = buildChatProviderOrder("antigravity", ["grok", "claude"], { classFirst: ["antigravity", "claude"] });
  assert.deepEqual(chatCoachReadOrder(pinOpen, { ...base, explicit: chatTurnPinsAgent("auto", "antigravity") }), pinOpen);
});
