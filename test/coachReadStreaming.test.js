// Wave 6 (Option C): the bounded coach-read loop can STREAM its final turn token by
// token while keeping the read-request protocol turns invisible. A coach_read turn is
// bare JSON with NO reply marker, so the marker-aware job gate emits nothing for it —
// only the operation's final prose/JSON streams to the surface. These cases drive
// runChosenWithCoachReads with an injected stream config (fake runStreaming + the real
// job gate) so no CLI/network runs, pinning: read-round-then-streamed-final, a no-read
// run that streams turn 1 directly, and a streaming failure that falls to the loop's
// non-streaming rotation for that turn — all preserving the loop's budget + acceptParsed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runChosenWithCoachReads } from "../dist/runChosen.js";
import { CHAT_ACTION_SENTINEL, CHAT_REPLY_SENTINEL } from "../dist/prompt.js";
import { isValidDayReadAgentResult } from "../dist/dayread.js";
import "./_seed.js";

const trainingRequest = (weeks = 6) => ({ tool: "read_training_window", args: { end_date: null, weeks } });
const trainingResult = (data = { events: [] }) => ({
  tool: "read_training_window",
  data,
  rows_returned: 0,
  truncated: false,
});

const dayRead = { kind: "train", why: "Recovery held through the block — good to train.", headline: "Good to train." };
const finalReply = (payload) =>
  `===CAIRN_REPLY===\nGood to train — recovery held through the block.\n${CHAT_ACTION_SENTINEL}\n${JSON.stringify(payload)}`;

// A fake stream runner that replays scripted raw turns, emitting each turn's text in
// small chunks through onDelta (so the marker-aware gate is exercised as it would be live).
function scriptedStream(turns, log = {}) {
  let i = 0;
  log.calls = 0;
  return async (_name, _prompt, opts) => {
    const raw = turns[i++];
    log.calls++;
    for (const piece of raw.match(/[\s\S]{1,7}/g) ?? [raw]) opts.onDelta?.(piece);
    return { code: 0, raw, stderr: "", usage: {} };
  };
}

test("streaming bounded loop: a coach_read turn streams nothing, then the final reply streams token by token", async () => {
  const deltas = [];
  const log = {};
  const runStreaming = scriptedStream([JSON.stringify({ kind: "coach_read", requests: [trainingRequest()] }), finalReply(dayRead)], log);
  let baseRunCalls = 0;
  const out = await runChosenWithCoachReads(
    "auto",
    "DAY READ SNAPSHOT",
    {
      op: "day_read",
      mode: "ordinary",
      timeoutMs: 5_000,
      acceptParsed: isValidDayReadAgentResult,
      stream: { onDelta: (c) => deltas.push(c), first: "claude", runStreaming, supportsStream: () => true },
    },
    {},
    {
      run: async () => {
        baseRunCalls++;
        throw new Error("the non-streaming rotation must not run when streaming succeeds");
      },
      execute: () => trainingResult({ events: [{ date: "2026-07-01", load: 42 }] }),
      createRunId: () => "run-stream-depth",
    }
  );

  assert.deepEqual(out.result.parsed, dayRead, "the streamed final turn re-parses to the op's payload");
  assert.equal(log.calls, 2, "the read-request turn AND the final turn each streamed");
  assert.equal(baseRunCalls, 0, "streaming success never touches the non-streaming rotation");
  const streamed = deltas.join("");
  assert.equal(streamed.trim(), "Good to train — recovery held through the block.");
  assert.doesNotMatch(streamed, /coach_read/, "the protocol turn never leaked to the surface");
  assert.doesNotMatch(streamed, new RegExp(CHAT_ACTION_SENTINEL), "the trailing JSON never streamed");
});

test("streaming bounded loop: a run that requests no reads streams turn 1 directly (byte-for-byte streaming path)", async () => {
  const deltas = [];
  const log = {};
  const runStreaming = scriptedStream([finalReply(dayRead)], log);
  const out = await runChosenWithCoachReads(
    "auto",
    "DAY READ SNAPSHOT",
    {
      op: "day_read",
      mode: "ordinary",
      timeoutMs: 5_000,
      acceptParsed: isValidDayReadAgentResult,
      stream: { onDelta: (c) => deltas.push(c), first: "claude", runStreaming, supportsStream: () => true },
    },
    {},
    {
      run: async () => {
        throw new Error("no fallback when the first streamed turn is already the final answer");
      },
      execute: () => trainingResult(),
      createRunId: () => "run-stream-noread",
    }
  );
  assert.deepEqual(out.result.parsed, dayRead);
  assert.equal(log.calls, 1, "exactly one streamed turn, no read round");
  assert.equal(deltas.join("").trim(), "Good to train — recovery held through the block.");
});

test("streaming bounded loop: a streaming transport failure falls to the loop's non-streaming rotation for that turn", async () => {
  const deltas = [];
  let baseRunCalls = 0;
  const runStreaming = async () => {
    throw new Error("transport blip");
  };
  const out = await runChosenWithCoachReads(
    "auto",
    "DAY READ SNAPSHOT",
    {
      op: "day_read",
      mode: "ordinary",
      timeoutMs: 5_000,
      acceptParsed: isValidDayReadAgentResult,
      stream: { onDelta: (c) => deltas.push(c), first: "claude", runStreaming, supportsStream: () => true },
    },
    {},
    {
      run: async () => {
        baseRunCalls++;
        return {
          agent: "codex",
          result: { code: 0, raw: JSON.stringify(dayRead), stderr: "", parsed: dayRead, usage: {} },
          tried: [],
        };
      },
      execute: () => trainingResult(),
      createRunId: () => "run-stream-fail",
    }
  );
  assert.deepEqual(out.result.parsed, dayRead, "the non-streaming rotation produced the final answer");
  assert.equal(baseRunCalls, 1, "the loop fell back to the injected non-streaming run exactly once");
  assert.equal(deltas.join(""), "", "a failed stream emitted no partial reply");
});

test("streaming bounded loop: a mid-round budget overflow still degrades to the untouched snapshot (streamed)", async () => {
  const deltas = [];
  const log = {};
  // 7 requests overflow the ordinary cap of 6 → the loop discards the read turn and
  // re-runs the plain snapshot prompt, which (still streaming) yields the final reply.
  const runStreaming = scriptedStream(
    [
      JSON.stringify({ kind: "coach_read", requests: Array.from({ length: 7 }, () => trainingRequest()) }),
      finalReply(dayRead),
    ],
    log
  );
  let executions = 0;
  const prompts = [];
  const out = await runChosenWithCoachReads(
    "auto",
    "DAY READ SNAPSHOT",
    {
      op: "day_read",
      mode: "ordinary",
      timeoutMs: 5_000,
      acceptParsed: isValidDayReadAgentResult,
      stream: {
        onDelta: (c) => deltas.push(c),
        first: "claude",
        runStreaming: async (name, prompt, opts) => {
          prompts.push(prompt);
          return runStreaming(name, prompt, opts);
        },
        supportsStream: () => true,
      },
    },
    {},
    {
      execute: () => {
        executions++;
        return trainingResult();
      },
      createRunId: () => "run-stream-cap",
    }
  );
  assert.equal(executions, 0, "no read executes when the batch overflows the budget");
  assert.deepEqual(out.result.parsed, dayRead);
  assert.equal(prompts.at(-1), "DAY READ SNAPSHOT", "the snapshot fallback strips the read contract and still streams");
  assert.equal(deltas.join("").trim(), "Good to train — recovery held through the block.");
  assert.ok(!CHAT_REPLY_SENTINEL.includes("x"));
});
