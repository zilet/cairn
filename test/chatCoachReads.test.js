// Wave 6 (Option C) — chat coverage: the conversational loop can request bounded,
// server-owned reads BEFORE its reply. A read request is bare JSON with no reply marker,
// so the chat stream gate shows nothing for it; the read rounds run invisibly (with a
// calm "reviewing your history" progress caption) and only the final reply streams.
//
// The pure helpers are tested directly; the read-augmented completion loop is driven
// through runChatCompletion with an injected deps seam (fake stream runner + read
// executor) so no CLI/network runs. A stub-pinned turn makes `first` deterministic
// regardless of which CLIs happen to be installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_ACTION_SENTINEL, CHAT_REPLY_SENTINEL } from "../dist/prompt.js";
import {
  chatReadPromptSuffix,
  detectChatReadRequest,
  newChatReadState,
  onTurnEvent,
  runChatCompletion,
  runChatReadRound,
} from "../dist/chatTurns.js";
import "./_seed.js";

const trainingRequest = (weeks = 6) => ({ tool: "read_training_window", args: { end_date: null, weeks } });
const trainingResult = () => ({ tool: "read_training_window", data: { events: [] }, rows_returned: 0, truncated: false });
const coachReadRaw = (...requests) => JSON.stringify({ kind: "coach_read", requests });

// A fake stream runner replaying scripted raw turns, chunked through onDelta so the
// chat stream gate runs as it would live.
function scriptedStream(turns, log = {}) {
  let i = 0;
  log.calls = 0;
  return async (_name, _prompt, opts) => {
    const raw = turns[i++] ?? "===CAIRN_REPLY===\n(no more scripted turns)";
    log.calls++;
    for (const piece of raw.match(/[\s\S]{1,7}/g) ?? [raw]) opts.onDelta?.(piece);
    return { code: 0, raw, stderr: "", usage: {} };
  };
}

// A fake non-streaming runner (for the rotation path) replaying scripted raw turns.
function scriptedRun(turns, log = {}) {
  let i = 0;
  log.calls = 0;
  return async (_name, _prompt, _opts) => {
    const raw = turns[i++] ?? "===CAIRN_REPLY===\n(no more scripted turns)";
    log.calls++;
    return { code: 0, raw, stderr: "", usage: {} };
  };
}

function turnFixture(overrides = {}) {
  return { id: 4242, agent: "stub", message: "how is my training trending?", image_path: null, routing: null, ...overrides };
}

function collectEvents(id) {
  const events = [];
  const off = onTurnEvent(id, (e) => events.push(e));
  return { events, off };
}

// ---------- pure helpers ----------

test("detectChatReadRequest: bare coach_read JSON is a protocol turn; a reply (marker) is not", () => {
  assert.deepEqual(detectChatReadRequest(coachReadRaw(trainingRequest())), {
    kind: "coach_read",
    requests: [trainingRequest()],
  });
  // A reply marker anywhere means the agent chose to answer — never a protocol turn.
  assert.equal(detectChatReadRequest(`${CHAT_REPLY_SENTINEL}\n${coachReadRaw(trainingRequest())}`), null);
  assert.equal(detectChatReadRequest("Your training looks solid — hold the plan."), null);
  // Malformed / out-of-catalog requests do not normalize.
  assert.equal(detectChatReadRequest(JSON.stringify({ kind: "coach_read", requests: [{ tool: "delete_all", args: {} }] })), null);
  assert.equal(detectChatReadRequest(JSON.stringify({ kind: "coach_read", requests: [] })), null);
});

test("chatReadPromptSuffix: contract when unspent, contract+results after a round, empty when exhausted", () => {
  const state = newChatReadState();
  const fresh = chatReadPromptSuffix(state, false);
  assert.match(fresh, /LOOK SOMETHING UP FIRST/);
  assert.match(fresh, /read_training_window/);
  assert.doesNotMatch(fresh, /VERIFIED COACH READ RESULTS/);

  state.completed.push({ request: trainingRequest(), result: trainingResult() });
  state.calls = 1;
  const withResults = chatReadPromptSuffix(state, false);
  assert.match(withResults, /VERIFIED COACH READ RESULTS/);
  assert.match(withResults, /Reads remaining: 5/);

  assert.equal(chatReadPromptSuffix(state, true), "", "an exhausted budget drops the contract so the agent just replies");
});

test("runChatReadRound: executes within budget, stops on the round cap, and honors the abort signal", async () => {
  const state = newChatReadState();
  const signal = new AbortController().signal;
  let calls = 0;
  const execute = () => {
    calls++;
    return trainingResult();
  };
  for (let r = 0; r < 3; r++) {
    assert.equal(await runChatReadRound(state, { kind: "coach_read", requests: [trainingRequest()] }, { runId: "r", signal, execute }), "ok");
  }
  assert.equal(state.rounds, 3);
  assert.equal(calls, 3);
  // A 4th round exceeds the round cap → stop, no further execution.
  assert.equal(await runChatReadRound(state, { kind: "coach_read", requests: [trainingRequest()] }, { runId: "r", signal, execute }), "stop");
  assert.equal(calls, 3, "the over-cap round executes nothing");

  // Call-cap: a single round asking for more than the remaining calls stops before executing.
  const wide = newChatReadState();
  const many = Array.from({ length: 7 }, () => trainingRequest());
  let wideCalls = 0;
  assert.equal(
    await runChatReadRound(wide, { kind: "coach_read", requests: many }, { runId: "r", signal, execute: () => {
          wideCalls++;
          return trainingResult();
        } }),
    "stop"
  );
  assert.equal(wideCalls, 0, "the whole batch validates against the budget before any execute");

  // Abort mid-round: the first read runs, the second request's pre-check throws.
  const ctrl = new AbortController();
  const aborting = newChatReadState();
  await assert.rejects(
    runChatReadRound(
      aborting,
      { kind: "coach_read", requests: [trainingRequest(6), trainingRequest(4)] },
      {
        runId: "r",
        signal: ctrl.signal,
        execute: () => {
          ctrl.abort();
          return trainingResult();
        },
      }
    ),
    /canceled/
  );
});

// ---------- the read-augmented completion loop ----------

test("chat: a read round runs invisibly, then the final reply streams a clean prose bubble + a phase caption", async () => {
  const { events, off } = collectEvents(4242);
  const log = {};
  const runAgentStreaming = scriptedStream(
    [coachReadRaw(trainingRequest()), `===CAIRN_REPLY===\nYour volume held steady across the block — keep the plan.\n`],
    log
  );
  let reads = 0;
  const out = await runChatCompletion(4242, turnFixture(), [], new AbortController().signal, {
    runAgentStreaming,
    supportsStream: () => true,
    executeCoachRead: () => {
      reads++;
      return trainingResult();
    },
  });
  off();

  assert.equal(reads, 1, "one bounded read executed");
  assert.equal(log.calls, 2, "the read-request turn AND the final reply turn both streamed");
  assert.equal(out.agent, "stub");
  assert.match(out.raw, /volume held steady/);
  // The read-request protocol turn is recorded but flagged ok (not a failed attempt).
  assert.ok(out.attempts.some((a) => a.status === "reading_data" && a.ok));

  const deltaText = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.match(deltaText, /volume held steady across the block/);
  assert.doesNotMatch(deltaText, /coach_read/, "the protocol JSON never reached the bubble");
  assert.doesNotMatch(deltaText, new RegExp(CHAT_ACTION_SENTINEL));
  assert.ok(
    events.some((e) => e.type === "progress" && /reviewing your history/i.test(e.text)),
    "a calm read phase was surfaced during the round"
  );
  assert.ok(events.some((e) => e.type === "reset"), "the empty protocol-turn bubble was reset before the reply streamed");
});

test("chat: a run that requests no reads behaves exactly as today (streams the reply, no phase, no reset)", async () => {
  const { events, off } = collectEvents(4242);
  const log = {};
  const runAgentStreaming = scriptedStream([`===CAIRN_REPLY===\nYou're recovered and due — a good day to train.`], log);
  let reads = 0;
  const out = await runChatCompletion(4242, turnFixture(), [], new AbortController().signal, {
    runAgentStreaming,
    supportsStream: () => true,
    executeCoachRead: () => {
      reads++;
      return trainingResult();
    },
  });
  off();

  assert.equal(reads, 0);
  assert.equal(log.calls, 1, "exactly one streamed turn");
  assert.match(out.raw, /good day to train/);
  assert.equal(events.filter((e) => e.type === "reset").length, 0, "no read round → no reset");
  assert.ok(!events.some((e) => e.type === "progress" && /reviewing your history/i.test(e.text)), "no read phase");
  const deltaText = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.match(deltaText, /good day to train/);
});

test("chat: budget exhaustion mid-chat drops the read contract and falls back to a clean reply", async () => {
  const { events, off } = collectEvents(4242);
  const log = {};
  // Four read requests: rounds 1-3 execute, the 4th trips the round cap (readExhausted),
  // then the contract-free re-prompt yields the reply.
  const runAgentStreaming = scriptedStream(
    [
      coachReadRaw(trainingRequest()),
      coachReadRaw(trainingRequest()),
      coachReadRaw(trainingRequest()),
      coachReadRaw(trainingRequest()),
      `===CAIRN_REPLY===\nBased on the last several weeks, hold your current volume.`,
    ],
    log
  );
  let reads = 0;
  const out = await runChatCompletion(4242, turnFixture(), [], new AbortController().signal, {
    runAgentStreaming,
    supportsStream: () => true,
    executeCoachRead: () => {
      reads++;
      return trainingResult();
    },
  });
  off();

  assert.equal(reads, 3, "the round cap bounds executed reads at three");
  assert.equal(log.calls, 5, "three read turns + the cap-tripping turn + the final reply");
  assert.match(out.raw, /hold your current volume/);
  const deltaText = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.match(deltaText, /hold your current volume/);
  assert.doesNotMatch(deltaText, /coach_read/);
});

test("chat: a coach_read with an INVALID tool is never accepted as the reply (streaming) — re-asks for clean prose", async () => {
  const { events, off } = collectEvents(4242);
  const log = {};
  // A coach_read-SHAPED turn whose tool is out of catalog: normalization fails, so it
  // must NOT be persisted as the reply. The loop drops the read contract and re-streams.
  const runAgentStreaming = scriptedStream(
    [coachReadRaw({ tool: "delete_all", args: {} }), `===CAIRN_REPLY===\nYour training looks steady — hold the plan.`],
    log
  );
  let reads = 0;
  const out = await runChatCompletion(4242, turnFixture(), [], new AbortController().signal, {
    runAgentStreaming,
    supportsStream: () => true,
    executeCoachRead: () => {
      reads++;
      return trainingResult();
    },
  });
  off();

  assert.equal(reads, 0, "a malformed read never executes");
  assert.equal(log.calls, 2, "the malformed turn + the re-asked reply (bounded)");
  assert.match(out.raw, /hold the plan/);
  assert.doesNotMatch(out.raw, /coach_read/, "the raw protocol JSON is not the persisted reply");
  assert.ok(out.attempts.some((a) => a.status === "read_malformed"));
  const deltaText = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assert.doesNotMatch(deltaText, /coach_read/, "malformed protocol JSON never reached the bubble");
  assert.match(deltaText, /hold the plan/);
});

test("chat: an EMPTY-requests coach_read is not accepted as the reply (streaming)", async () => {
  const { off } = collectEvents(4242);
  const log = {};
  const runAgentStreaming = scriptedStream(
    [JSON.stringify({ kind: "coach_read", requests: [] }), `===CAIRN_REPLY===\nAll good — keep going.`],
    log
  );
  const out = await runChatCompletion(4242, turnFixture(), [], new AbortController().signal, {
    runAgentStreaming,
    supportsStream: () => true,
    executeCoachRead: () => {
      throw new Error("no read should run for an empty-requests coach_read");
    },
  });
  off();

  assert.equal(log.calls, 2, "the malformed turn + the re-asked reply");
  assert.match(out.raw, /keep going/);
  assert.doesNotMatch(out.raw, /coach_read/);
  assert.ok(out.attempts.some((a) => a.status === "read_malformed"));
});

test("chat (rotation path): a malformed coach_read re-asks the same agent for a plain reply", async () => {
  const log = {};
  const runAgent = scriptedRun(
    [coachReadRaw({ tool: "delete_all", args: {} }), `===CAIRN_REPLY===\nSteady week — no change needed.`],
    log
  );
  const out = await runChatCompletion(4242, turnFixture(), [], new AbortController().signal, {
    runAgent,
    supportsStream: () => false,
    executeCoachRead: () => {
      throw new Error("no read should run for a malformed coach_read");
    },
  });

  assert.equal(log.calls, 2, "the malformed turn + the re-asked reply on the same agent");
  assert.match(out.raw, /no change needed/);
  assert.doesNotMatch(out.raw, /coach_read/);
  assert.ok(out.attempts.some((a) => a.status === "read_malformed"));
});

test("chat: a cancel mid-read-round aborts the turn without a broken bubble", async () => {
  const ctrl = new AbortController();
  const runAgentStreaming = scriptedStream([coachReadRaw(trainingRequest(6), trainingRequest(4)), `===CAIRN_REPLY===\nunreached`]);
  await assert.rejects(
    runChatCompletion(4242, turnFixture(), [], ctrl.signal, {
      runAgentStreaming,
      supportsStream: () => true,
      executeCoachRead: () => {
        ctrl.abort();
        return trainingResult();
      },
    }),
    /canceled/
  );
});
