// Wave 4: the interactive coaching ops now get depth-on-demand reads via the bounded
// coach-read loop. Two wiring shapes are covered here:
//  - The NON-streaming ops (the agentic Brief compute in dayread.ts, runHealthReview
//    in coachOps.ts) route straight through runChosenWithCoachReads (mode "ordinary").
//  - The STREAMING ops (session-suggest, nutrition-checkin, insight/weekly-read) pass
//    `boundedReads:true` to runChosenStreaming, which is the SINGLE source of truth for
//    "would this run stream": a run that streams is byte-for-byte unchanged, while a run
//    that does not stream (no delta sink / non-stream-capable first agent) takes its
//    terminal through the bounded loop instead of a plain runChosen.
// These cases pin: (1) each op's exact success predicate flows THROUGH the loop, so a
// coach_read round-trip terminating in a valid op payload is accepted, budget exhaustion
// falls back to the untouched snapshot, and the forwarded acceptParsed admits only the
// op's real contract; (2) the streaming router picks the right terminal per would-stream
// state; (3) the ops still degrade calmly end-to-end against the offline stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runChosenWithCoachReads, runChosenStreaming } from "../dist/runChosen.js";
import { computeDayRead, isValidDayReadAgentResult } from "../dist/dayread.js";
import { isHealthReviewResult, isInsightResult } from "../dist/agent-contracts.js";
import "./_seed.js";

function chosen(parsed, agent = "terra") {
  return {
    agent,
    result: { code: 0, raw: JSON.stringify(parsed), stderr: "", parsed, usage: {} },
    tried: [],
  };
}

const trainingRequest = (weeks = 6) => ({ tool: "read_training_window", args: { end_date: null, weeks } });
const trainingResult = (data = { events: [] }) => ({
  tool: "read_training_window",
  data,
  rows_returned: 0,
  truncated: false,
});

// ---- Day read: the exact predicate flows through the bounded loop ----

test("day-read: a coach_read round-trip terminating in a valid day-read payload is accepted", async () => {
  const finalRead = { kind: "train", why: "Recovery held through the block — good to train.", headline: "Good to train." };
  const executions = [];
  const turns = [chosen({ kind: "coach_read", requests: [trainingRequest()] }), chosen(finalRead)];
  const out = await runChosenWithCoachReads(
    "auto",
    "DAY READ SNAPSHOT",
    {
      op: "day_read",
      mode: "ordinary",
      timeoutMs: 5_000,
      acceptParsed: (parsed) => isValidDayReadAgentResult(parsed),
    },
    {},
    {
      run: async (_agent, _prompt, opts) => {
        // The forwarded predicate must admit a coach_read turn AND the op's real
        // final contract, while still rejecting a wrong (health-review) shape.
        assert.equal(opts.acceptParsed({ kind: "coach_read", requests: [trainingRequest()] }), true);
        assert.equal(opts.acceptParsed(finalRead), true);
        assert.equal(opts.acceptParsed({ headline: "not a day read but a review" }), false);
        return turns.shift();
      },
      execute: (request, context) => {
        executions.push({ request, context });
        return trainingResult({ events: [{ date: "2026-07-01", load: 42 }] });
      },
      createRunId: () => "run-dayread-depth",
    }
  );

  assert.deepEqual(out.result.parsed, finalRead);
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0].context, { run_id: "run-dayread-depth", op: "day_read" });
});

test("day-read: an over-budget request degrades to the untouched snapshot-only run", async () => {
  let executions = 0;
  const finalRead = { kind: "easy", why: "Take it easy today." };
  // 7 requests exceeds the ordinary cap of 6 → fall back to the snapshot-only call.
  const turns = [
    chosen({ kind: "coach_read", requests: Array.from({ length: 7 }, () => trainingRequest()) }),
    chosen(finalRead),
  ];
  const prompts = [];
  const out = await runChosenWithCoachReads(
    "auto",
    "DAY READ SNAPSHOT",
    { op: "day_read", mode: "ordinary", timeoutMs: 5_000, acceptParsed: (p) => isValidDayReadAgentResult(p) },
    {},
    {
      run: async (_agent, prompt) => {
        prompts.push(prompt);
        return turns.shift();
      },
      execute: () => {
        executions++;
        return trainingResult();
      },
      createRunId: () => "run-dayread-cap",
    }
  );
  assert.equal(executions, 0, "no read executes when the batch overflows the budget");
  assert.deepEqual(out.result.parsed, finalRead);
  assert.equal(prompts.at(-1), "DAY READ SNAPSHOT", "the fallback strips the query-loop contract");
});

// ---- Health review: same guarantee for its predicate ----

test("health-review: a coach_read round-trip terminating in a valid review is accepted", async () => {
  const finalReview = { headline: "Your lipids are trending toward the optimal zone." };
  const executions = [];
  const turns = [chosen({ kind: "coach_read", requests: [trainingRequest()] }), chosen(finalReview)];
  const out = await runChosenWithCoachReads(
    "auto",
    "HEALTH REVIEW SNAPSHOT",
    { op: "health_review", mode: "ordinary", timeoutMs: 5_000, acceptParsed: isHealthReviewResult },
    {},
    {
      run: async (_agent, _prompt, opts) => {
        assert.equal(opts.acceptParsed({ kind: "coach_read", requests: [trainingRequest()] }), true);
        assert.equal(opts.acceptParsed(finalReview), true);
        assert.equal(opts.acceptParsed({ kind: "train", why: "a day read, not a review" }), false);
        return turns.shift();
      },
      execute: (request, context) => {
        executions.push({ request, context });
        return trainingResult();
      },
      createRunId: () => "run-review-depth",
    }
  );
  assert.deepEqual(out.result.parsed, finalReview);
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0].context, { run_id: "run-review-depth", op: "health_review" });
});

// ---- End-to-end: the ops still degrade calmly against the offline stub ----

test("day-read still yields a deterministic read when the (stub) agent returns the wrong contract", async () => {
  // The stub returns a plan-proposal, which is not a valid day-read; the bounded
  // loop treats it as a non-coach_read turn whose acceptParsed fails, exhausts the
  // one-agent rotation, and computeDayRead falls back to the deterministic floor —
  // exactly as it did under plain runChosen.
  const out = await computeDayRead({ agent: "stub", date: "2026-03-15" });
  assert.equal(out.source, "deterministic");
  assert.ok(["train", "easy", "rest", "done"].includes(out.kind));
  assert.equal(typeof out.why, "string");
  assert.ok(out.why.trim().length > 0);
});

// ---- Streaming ops: runChosenStreaming is the single would-stream source of truth ----
//
// The three streaming ops pass boundedReads:true. These cases drive runChosenStreaming
// with injected deps so no CLI/network runs, asserting it selects the RIGHT terminal for
// each would-stream state without any op-level duplication of the check.

const streamedRes = (parsed) => ({ code: 0, raw: JSON.stringify(parsed), stderr: "", usage: {} });

function routingHarness(overrides = {}) {
  const calls = { streamed: 0, oneShot: 0, bounded: 0 };
  let boundedOpts = null;
  const deps = {
    resolveOrder: () => ["codex"],
    supportsStream: () => false,
    runStreaming: async () => {
      calls.streamed++;
      return streamedRes({ found: true, text: "streamed reply" });
    },
    runOneShot: async () => {
      calls.oneShot++;
      return chosen({ found: false }, "codex");
    },
    runBounded: async (_agent, _prompt, opts) => {
      calls.bounded++;
      boundedOpts = opts;
      return chosen({ found: true, text: "bounded reply" }, "codex");
    },
    ...overrides,
  };
  return { calls, deps, boundedOpts: () => boundedOpts };
}

test("streaming router: no delta sink → bounded-read terminal, not a plain one-shot", async () => {
  const { calls, deps } = routingHarness();
  const out = await runChosenStreaming("auto", "PROMPT", { op: "insight", boundedReads: true }, deps);
  assert.equal(calls.bounded, 1);
  assert.equal(calls.oneShot, 0);
  assert.equal(calls.streamed, 0);
  assert.deepEqual(out.result.parsed, { found: true, text: "bounded reply" });
});

test("streaming router: onDelta present but first agent not stream-capable → bounded terminal", async () => {
  const { calls, deps } = routingHarness({ supportsStream: () => false });
  await runChosenStreaming(
    "auto",
    "PROMPT",
    { op: "nutrition_checkin", boundedReads: true, onDelta: () => {} },
    deps
  );
  assert.equal(calls.streamed, 0, "a non-stream-capable first agent never enters the streaming branch");
  assert.equal(calls.bounded, 1);
  assert.equal(calls.oneShot, 0);
});

test("streaming router (Option C): onDelta + stream-capable + boundedReads → streams THROUGH the bounded loop", async () => {
  // Under Option C the stream-capable bounded run no longer streams turn 1 at the
  // runChosenStreaming level. It routes to the bounded loop with a stream config; the
  // loop owns dispatch (streaming the final turn, suppressing read-request protocol turns).
  const { calls, deps, boundedOpts } = routingHarness({ supportsStream: () => true });
  const out = await runChosenStreaming(
    "auto",
    "PROMPT",
    { op: "session_suggest", boundedReads: true, onDelta: () => {}, acceptParsed: () => true },
    deps
  );
  assert.equal(calls.bounded, 1, "the bounded loop is the single dispatch site");
  assert.equal(calls.streamed, 0, "runChosenStreaming does not stream turn 1 itself for a bounded run");
  assert.equal(calls.oneShot, 0);
  const opts = boundedOpts();
  assert.ok(opts.stream, "the stream config is forwarded so the loop streams the final turn");
  assert.equal(opts.stream.first, "codex", "the already-resolved agent is threaded in (no re-resolve — cursor discipline)");
  assert.equal(typeof opts.stream.onDelta, "function");
  assert.equal(opts.mode, "ordinary");
  assert.deepEqual(out.result.parsed, { found: true, text: "bounded reply" });
});

test("streaming router: a NON-bounded stream attempt that fails preserves the exact one-shot fallback", async () => {
  // The legacy single-turn streaming path (no boundedReads) keeps its own one-shot
  // fallback on a transport failure. (Bounded runs fall back INSIDE the loop instead.)
  const { calls, deps } = routingHarness({
    supportsStream: () => true,
    runStreaming: async () => {
      calls.streamed++;
      throw new Error("transport blip");
    },
  });
  const out = await runChosenStreaming("auto", "PROMPT", { op: "insight", onDelta: () => {} }, deps);
  assert.equal(calls.streamed, 1);
  assert.equal(calls.oneShot, 1, "a would-stream run that failed keeps runChosen");
  assert.equal(calls.bounded, 0);
  assert.equal(out.tried.length, 1, "the streamed attempt is recorded in tried");
});

test("streaming router: a NON-bounded stream that succeeds streams turn 1 directly (legacy path preserved)", async () => {
  const { calls, deps } = routingHarness({ supportsStream: () => true });
  const out = await runChosenStreaming(
    "auto",
    "PROMPT",
    { op: "insight", onDelta: () => {}, acceptParsed: () => true },
    deps
  );
  assert.equal(calls.streamed, 1);
  assert.equal(calls.bounded, 0);
  assert.equal(calls.oneShot, 0);
  assert.deepEqual(out.result.parsed, { found: true, text: "streamed reply" });
});

test("streaming router: boundedReads unset → plain one-shot terminal (legacy behavior)", async () => {
  const { calls, deps } = routingHarness();
  await runChosenStreaming("auto", "PROMPT", { op: "insight" }, deps);
  assert.equal(calls.oneShot, 1);
  assert.equal(calls.bounded, 0);
  assert.equal(calls.streamed, 0);
});

// ---- Insight (a streaming op): its predicate flows through the bounded terminal ----

test("insight: a coach_read round-trip terminating in a valid insight is accepted, over-budget falls back", async () => {
  const finalInsight = { found: true, text: "Your easy runs are protecting your lifting numbers." };
  // Depth path: coach_read → verified results → the op's real final contract.
  const depthTurns = [chosen({ kind: "coach_read", requests: [trainingRequest()] }), chosen(finalInsight)];
  const depth = await runChosenWithCoachReads(
    "auto",
    "INSIGHT SNAPSHOT",
    { op: "insight", mode: "ordinary", timeoutMs: 5_000, acceptParsed: isInsightResult },
    {},
    {
      run: async (_a, _p, opts) => {
        assert.equal(opts.acceptParsed(finalInsight), true);
        assert.equal(opts.acceptParsed({ kind: "train", why: "wrong contract" }), false);
        return depthTurns.shift();
      },
      execute: () => trainingResult(),
      createRunId: () => "run-insight-depth",
    }
  );
  assert.deepEqual(depth.result.parsed, finalInsight);

  // Over-budget: the batch overflows the ordinary cap → untouched snapshot-only run.
  let executions = 0;
  const overTurns = [
    chosen({ kind: "coach_read", requests: Array.from({ length: 7 }, () => trainingRequest()) }),
    chosen(finalInsight),
  ];
  const capped = await runChosenWithCoachReads(
    "auto",
    "INSIGHT SNAPSHOT",
    { op: "insight", mode: "ordinary", timeoutMs: 5_000, acceptParsed: isInsightResult },
    {},
    {
      run: async () => overTurns.shift(),
      execute: () => {
        executions++;
        return trainingResult();
      },
      createRunId: () => "run-insight-cap",
    }
  );
  assert.equal(executions, 0);
  assert.deepEqual(capped.result.parsed, finalInsight);
});
