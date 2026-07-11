// Streaming for the prose-bearing JOB ops — the pure, offline-testable pieces of the
// job-delta layer (mirrors test/streaming.test.js for chat). No agent runs:
//   - createJobStreamFilter buffers until the reply marker, streams the prose, stops at
//     the data marker (pre-marker narration never leaks; nothing to retract → no reset).
//   - extractMarkedJson pulls the op's JSON from the clean tail after the data marker,
//     immune to a stray brace in the prose, and stays backward-compatible with a
//     marker-less (bare-JSON) reply.
//   - runChosenStreaming streams on a stream-capable first agent, else / on any failure
//     falls back to the one-shot rotation (injected deps keep it hermetic).
//   - the job bus carries `delta` events to an onJobEvent subscriber for the four
//     prose kinds only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createJobStreamFilter } from "../dist/jobStreamFilter.js";
import {
  extractMarkedJson,
  renderStreamingContract,
  CHAT_ACTION_SENTINEL,
  CHAT_REPLY_SENTINEL,
} from "../dist/prompt.js";
import { runChosen, runChosenStreaming } from "../dist/runChosen.js";
import { AgentFallbackError, extractJson, runAgentWithFallback } from "../dist/agents.js";
import { onJobEvent, emitJobDelta, jobStreamsDeltas, STREAM_DELTA_KINDS } from "../dist/agentJobs.js";

function collectFilter() {
  const chunks = [];
  const filter = createJobStreamFilter((c) => chunks.push(c));
  return { filter, text: () => chunks.join(""), chunks };
}

// ---------------- createJobStreamFilter ----------------

test("job filter: pre-marker tool narration is suppressed, prose after the marker streams", () => {
  const { filter, text } = collectFilter();
  filter.push("I will query the health_documents table to read the labs.\n");
  assert.equal(text(), "", "nothing before the reply marker ever streams");
  filter.push(`${CHAT_REPLY_SENTINEL}\nYour lipids are the thing to watch.`);
  filter.finish();
  assert.equal(text().trim(), "Your lipids are the thing to watch.");
  assert.doesNotMatch(text(), /query the health_documents table/);
});

test("job filter: streaming stops at the data marker — the JSON never reaches the card", () => {
  const { filter, text } = collectFilter();
  filter.push(
    `${CHAT_REPLY_SENTINEL}\nLipids lead; leaner body comp is the lever.\n${CHAT_ACTION_SENTINEL}\n{"headline":"Lipids","story":"..."}`
  );
  filter.finish();
  assert.equal(text().trim(), "Lipids lead; leaner body comp is the lever.");
  assert.doesNotMatch(text(), /headline|CAIRN_ACTIONS/, "neither the data marker nor the JSON is streamed");
});

test("job filter: the reply marker is detected even when split across chunks", () => {
  const { filter, text } = collectFilter();
  filter.push("===CAIRN_RE");
  filter.push("PLY===\nHere is your ");
  filter.push("session read.");
  filter.finish();
  assert.equal(text().trim(), "Here is your session read.");
});

test("job filter: a marker-less (bare-JSON) reply streams nothing — no prose to show", () => {
  const { filter, text } = collectFilter();
  filter.push('{"headline":"x","story":"y","found":true}');
  filter.finish();
  assert.equal(text(), "", "an agent that ignored the contract streams no deltas (the card fills on done)");
});

test("job filter: leading whitespace after the marker is swallowed (no blank opening line)", () => {
  const { filter, chunks } = collectFilter();
  filter.push(`${CHAT_REPLY_SENTINEL}\n\n   Ready to go.`);
  filter.finish();
  assert.equal(chunks.join(""), "Ready to go.", "the first emitted chunk has no leading blank/space");
});

// ---------------- extractMarkedJson ----------------

test("extractMarkedJson: JSON is parsed from the clean tail after the data marker", () => {
  // The prose deliberately contains a brace — extractJson over the whole text could be
  // fooled, but slicing after the data marker is immune.
  const raw = `${CHAT_REPLY_SENTINEL}\nYour plan { with a note } reads well.\n${CHAT_ACTION_SENTINEL}\n{"items":[1,2],"why":"fits today"}`;
  assert.deepEqual(extractMarkedJson(raw), { items: [1, 2], why: "fits today" });
});

test("extractMarkedJson: backward-compatible with a bare-JSON reply (no markers)", () => {
  assert.deepEqual(extractMarkedJson('{"found":false}'), { found: false });
  assert.deepEqual(extractMarkedJson('prose then {"change":false,"summary":"hold"}'), {
    change: false,
    summary: "hold",
  });
});

test("extractMarkedJson: a reply marker with no data marker still finds the JSON", () => {
  assert.deepEqual(extractMarkedJson(`${CHAT_REPLY_SENTINEL}\nthoughts then {"a":1}`), { a: 1 });
});

test("extractMarkedJson: pure prose (no JSON at all) yields null", () => {
  assert.equal(extractMarkedJson(`${CHAT_REPLY_SENTINEL}\njust prose, nothing to parse`), null);
});

test("renderStreamingContract: emits both markers, the prose guide, the schema, and the empty-answer escape", () => {
  const c = renderStreamingContract("write the why", '{"x":1}', { emptyAnswer: '{"found": false}' });
  assert.ok(c.includes(CHAT_REPLY_SENTINEL), "carries the reply marker");
  assert.ok(c.includes(CHAT_ACTION_SENTINEL), "carries the data marker");
  assert.match(c, /write the why/, "carries the prose guide");
  assert.match(c, /"x":1/, "carries the op's JSON schema verbatim");
  assert.match(c, /"found": false/, "documents the no-prose escape hatch");
});

// ---------------- runChosenStreaming (fallback decision + delta forwarding) ----------------

function agentResult(raw, parsed = null) {
  return { code: 0, raw, stderr: "", parsed, usage: {} };
}

function streamingAgentResult(raw, opts, pieces) {
  // Feed the gate exactly as the real runAgentStreaming would, chunk by chunk.
  for (const p of pieces) opts.onDelta?.(p);
  return Promise.resolve(agentResult(raw));
}

test("runChosenStreaming: streams on a stream-capable first agent, forwards prose deltas, no fallback", async () => {
  const deltas = [];
  let oneShotCalled = false;
  const raw = `${CHAT_REPLY_SENTINEL}\nThis fits your recovery today.\n${CHAT_ACTION_SENTINEL}\n{"items":[{"exercise":"Squat"}],"why":"fits today"}`;
  const out = await runChosenStreaming(
    "claude",
    "PROMPT",
    { op: "session_suggest", onDelta: (c) => deltas.push(c) },
    {
      resolveOrder: () => ["claude"],
      supportsStream: () => true,
      runStreaming: (_name, _prompt, opts) =>
        streamingAgentResult(raw, opts, [
          `${CHAT_REPLY_SENTINEL}\n`,
          "This fits your ",
          "recovery today.\n",
          `${CHAT_ACTION_SENTINEL}\n`,
          '{"items":[{"exercise":"Squat"}],"why":"fits today"}',
        ]),
      runOneShot: async () => {
        oneShotCalled = true;
        throw new Error("must not fall back");
      },
    }
  );
  assert.equal(oneShotCalled, false, "a parseable streamed result never falls back");
  assert.equal(out.agent, "claude");
  assert.deepEqual(out.result.parsed, { items: [{ exercise: "Squat" }], why: "fits today" });
  assert.deepEqual(out.tried, []);
  assert.equal(deltas.join("").trim(), "This fits your recovery today.", "only the athlete-facing prose is forwarded");
});

test("runChosenStreaming: a non-streaming first agent goes straight to the one-shot rotation, no deltas", async () => {
  const deltas = [];
  let streamCalled = false;
  let oneShotArgs = null;
  const out = await runChosenStreaming(
    "stub",
    "PROMPT",
    { op: "health_synthesis", onDelta: (c) => deltas.push(c) },
    {
      resolveOrder: () => ["stub"],
      supportsStream: () => false, // stub can't stream
      runStreaming: async () => {
        streamCalled = true;
        return agentResult("");
      },
      runOneShot: async (agent, prompt, opts) => {
        oneShotArgs = { agent, prompt, opts };
        return { agent: "stub", result: agentResult('{"headline":"x"}'), tried: [] };
      },
    }
  );
  assert.equal(streamCalled, false, "no streaming attempt when the first agent can't stream");
  assert.deepEqual(deltas, [], "nothing streamed");
  assert.equal(out.agent, "stub");
  assert.equal(oneShotArgs.agent, "stub");
  assert.equal(oneShotArgs.opts.onDelta, undefined, "onDelta is stripped before delegating to runChosen");
});

test("runChosenStreaming: a streamed reply with no parseable JSON falls back to the one-shot rotation", async () => {
  let oneShotCalled = false;
  const out = await runChosenStreaming(
    "claude",
    "PROMPT",
    { op: "nutrition_checkin", onDelta: () => {} },
    {
      resolveOrder: () => ["claude"],
      supportsStream: () => true,
      // streams prose but never emits a data marker / JSON → unparseable
      runStreaming: (_name, _prompt, opts) =>
        streamingAgentResult(`${CHAT_REPLY_SENTINEL}\nall prose, no json`, opts, [
          `${CHAT_REPLY_SENTINEL}\nall prose, no json`,
        ]),
      runOneShot: async () => {
        oneShotCalled = true;
        return {
          agent: "codex",
          result: agentResult('{"change":false,"summary":"hold"}', { change: false, summary: "hold" }),
          tried: [{ agent: "claude", error: "x" }],
        };
      },
    }
  );
  assert.equal(oneShotCalled, true, "no parseable JSON from the stream → fall back");
  assert.equal(out.agent, "codex");
  assert.deepEqual(out.result.parsed, { change: false, summary: "hold" });
});

test("runChosenStreaming: parseable JSON outside the operation contract falls back too", async () => {
  let oneShotArgs = null;
  const invalid = `${CHAT_REPLY_SENTINEL}\nDrafted.\n${CHAT_ACTION_SENTINEL}\n{"change":true,"summary":"add fuel"}`;
  const out = await runChosenStreaming(
    "claude",
    "PROMPT",
    {
      op: "nutrition_checkin",
      onDelta: () => {},
      acceptParsed: (parsed) => parsed?.change === false || Number.isFinite(parsed?.nutrition?.target_kcal),
    },
    {
      resolveOrder: () => ["claude", "codex"],
      supportsStream: () => true,
      runStreaming: (_name, _prompt, opts) => streamingAgentResult(invalid, opts, [invalid]),
      runOneShot: async (agent, prompt, opts) => {
        oneShotArgs = { agent, prompt, opts };
        return {
          agent: "codex",
          result: agentResult('{"change":false,"summary":"hold"}', { change: false, summary: "hold" }),
          tried: [{ agent: "claude", error: "invalid contract" }],
        };
      },
    }
  );
  assert.equal(out.agent, "codex");
  assert.match(out.tried[0].error, /streamed JSON missed the operation contract/);
  assert.equal(typeof oneShotArgs.opts.acceptParsed, "function", "the semantic contract survives streaming fallback");
  assert.equal(oneShotArgs.opts.acceptParsed(out.result.parsed), true);
});

test("runChosenStreaming: with no onDelta it delegates straight to runChosen (byte-for-byte)", async () => {
  let streamCalled = false;
  let oneShotArgs = null;
  await runChosenStreaming(
    "stub",
    "PROMPT",
    { op: "weekly_read", timeoutMs: 1234 },
    {
      resolveOrder: () => ["claude"], // stream-capable, but no onDelta → never consulted
      supportsStream: () => true,
      runStreaming: async () => {
        streamCalled = true;
        return agentResult("");
      },
      runOneShot: async (agent, prompt, opts) => {
        oneShotArgs = { agent, prompt, opts };
        return { agent, result: agentResult("{}"), tried: [] };
      },
    }
  );
  assert.equal(streamCalled, false, "no onDelta → no streaming attempt at all");
  assert.equal(oneShotArgs.agent, "stub");
  assert.equal(oneShotArgs.prompt, "PROMPT");
  assert.equal(oneShotArgs.opts.timeoutMs, 1234, "the op options pass through unchanged");
  assert.equal("onDelta" in oneShotArgs.opts, false);
});

test("runChosenStreaming: a Stop (aborted signal) during streaming rethrows and never falls back", async () => {
  const ac = new AbortController();
  ac.abort();
  let oneShotCalled = false;
  await assert.rejects(
    () =>
      runChosenStreaming(
        "claude",
        "PROMPT",
        { op: "session_suggest", signal: ac.signal, onDelta: () => {} },
        {
          resolveOrder: () => ["claude"],
          supportsStream: () => true,
          runStreaming: async () => {
            throw new Error('agent "claude" canceled');
          },
          runOneShot: async () => {
            oneShotCalled = true;
            return { agent: "x", result: agentResult("{}"), tried: [] };
          },
        }
      ),
    /canceled/
  );
  assert.equal(oneShotCalled, false, "a deliberate Stop is never retried on another agent");
});

test("runChosenStreaming: a streaming transport error (not aborted) falls back to the one-shot rotation", async () => {
  let oneShotCalled = false;
  const out = await runChosenStreaming(
    "claude",
    "PROMPT",
    { op: "session_suggest", onDelta: () => {} },
    {
      resolveOrder: () => ["claude"],
      supportsStream: () => true,
      runStreaming: async () => {
        throw new Error("failed to launch");
      },
      runOneShot: async () => {
        oneShotCalled = true;
        return { agent: "codex", result: agentResult('{"items":[1]}'), tried: [] };
      },
    }
  );
  assert.equal(oneShotCalled, true, "a transport failure degrades to the one-shot rotation");
  assert.equal(out.agent, "codex");
});

// ---------------- job bus delta forwarding ----------------

test("emitJobDelta → onJobEvent delivers delta events; unsubscribe stops them; empty is ignored", () => {
  const id = 987654;
  const events = [];
  const off = onJobEvent(id, (e) => events.push(e));
  emitJobDelta(id, "Your ");
  emitJobDelta(id, ""); // empty chunk is a no-op
  emitJobDelta(id, "week held steady.");
  off();
  emitJobDelta(id, "after unsubscribe"); // must not be delivered
  assert.deepEqual(events, [
    { type: "delta", delta: "Your " },
    { type: "delta", delta: "week held steady." },
  ]);
});

test("jobStreamsDeltas: only the four prose-bearing kinds stream", () => {
  for (const k of ["health_synthesis", "session_suggest", "nutrition_checkin", "weekly_read"]) {
    assert.ok(jobStreamsDeltas(k), `${k} streams prose`);
  }
  for (const k of [
    "insight",
    "proposal",
    "meal_plan",
    "meal_swap",
    "recipe",
    "health_review",
    "evolve_program",
    "day_read_override",
    "chat_distill",
  ]) {
    assert.ok(!jobStreamsDeltas(k), `${k} does not stream`);
  }
  assert.equal(STREAM_DELTA_KINDS.size, 4);
});

// ---------------- the one-shot (non-streamed) path parses marker-aware too ----------------
// Post-integration review finding: the reshaped prompts invite free prose, and a stray
// `{` in that prose anchors plain extractJson's first-brace scan on a non-JSON span —
// blanking the parse even though the real JSON sits complete after the data marker.
// runChosen therefore threads extractMarkedJson through runAgentWithFallback via
// RunOpts.extract, so the contract is honored on EVERY call path, not just the one
// that streams. These tests pin both the failure mode and the plumbing.

test("a stray brace in the prose blanks plain extractJson but not extractMarkedJson", () => {
  const good = '{"change":false,"summary":"holding steady"}';
  const braceInProse = `${CHAT_REPLY_SENTINEL}\nYou sit in the {1800-2000} kcal window most days.\n${CHAT_ACTION_SENTINEL}\n${good}`;
  const braceInNarration = `I will query the {sessions} table first.\n${CHAT_REPLY_SENTINEL}\nSteady week.\n${CHAT_ACTION_SENTINEL}\n${good}`;
  for (const text of [braceInProse, braceInNarration]) {
    assert.equal(extractJson(text), null, "plain extractJson misses the real JSON (the regression this guards)");
    assert.deepEqual(extractMarkedJson(text), { change: false, summary: "holding steady" });
  }
});

test("runAgentWithFallback honors RunOpts.extract on a real (stub) run", async () => {
  // The stub CLI emits marker-less canned JSON; a sentinel extractor proves the
  // option reaches the parse point (and, having parsed, skips the repair retry).
  const fb = await runAgentWithFallback(["stub"], "ignored", { extract: () => ({ via: "custom-extract" }) });
  assert.equal(fb.agent, "stub");
  assert.deepEqual(fb.result.parsed, { via: "custom-extract" });
});

test("runAgentWithFallback repairs then rotates when parsed JSON misses the operation contract", async () => {
  let extracts = 0;
  const fb = await runAgentWithFallback(["stub", "stub"], "ignored", {
    extract: () => (++extracts <= 2 ? { wrong: true } : { kind: "rest", why: "Recovery first." }),
    acceptParsed: (parsed) => parsed?.kind === "rest" && typeof parsed?.why === "string",
  });

  assert.equal(fb.tried.length, 1, "the first agent must be rejected after its repair still misses the contract");
  assert.match(fb.tried[0].error, /outside the requested contract/);
  assert.deepEqual(fb.result.parsed, { kind: "rest", why: "Recovery first." });
});

test("runAgentWithFallback exposes a structured attempt ledger when every contract fails", async () => {
  await assert.rejects(
    runAgentWithFallback(["stub"], "ignored", { acceptParsed: () => false }),
    (error) => {
      assert.ok(error instanceof AgentFallbackError);
      assert.deepEqual(error.order, ["stub"]);
      assert.equal(error.tried.length, 1);
      assert.equal(error.tried[0].agent, "stub");
      assert.match(error.tried[0].error, /outside the requested contract/);
      return true;
    }
  );
});

test("runChosen forwards a caller extract and still parses the stub's bare JSON by default", async () => {
  const custom = await runChosen("stub", "ignored", { extract: () => ({ via: "runChosen" }) });
  assert.deepEqual(custom.result.parsed, { via: "runChosen" });
  // Default path: extractMarkedJson degrades to extractJson on marker-less output,
  // so the stub's canned proposal parses exactly as before the wiring change.
  const dflt = await runChosen("stub", "ignored");
  assert.equal(dflt.agent, "stub");
  assert.ok(dflt.result.parsed && Array.isArray(dflt.result.parsed.changes), "stub proposal parses via the default marker-aware extractor");
});
