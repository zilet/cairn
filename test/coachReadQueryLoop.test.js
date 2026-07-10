import { test } from "node:test";
import assert from "node:assert/strict";
import { COACH_READ_STRICT_MCP_ARGS, runChosenWithCoachReads } from "../dist/runChosen.js";

function chosen(parsed, agent = "terra") {
  return {
    agent,
    result: { code: 0, raw: JSON.stringify(parsed), stderr: "", parsed, usage: {} },
    tried: [],
  };
}

function trainingRequest(weeks = 6) {
  return { tool: "read_training_window", args: { end_date: null, weeks } };
}

function trainingResult(data = { events: [] }) {
  return { tool: "read_training_window", data, rows_returned: 0, truncated: false };
}

test("coach-read query loop keeps the snapshot baseline and does no tool work when the first answer is final", async () => {
  const calls = [];
  let executions = 0;
  const out = await runChosenWithCoachReads(
    "auto",
    "SNAPSHOT BASELINE",
    { op: "weekly_read", timeoutMs: 5_000 },
    {},
    {
      run: async (agent, prompt, opts) => {
        calls.push({ agent, prompt, opts });
        return chosen({ headline: "Hold steady" });
      },
      execute: () => {
        executions++;
        return trainingResult();
      },
      createRunId: () => "run-final",
    }
  );

  assert.deepEqual(out.result.parsed, { headline: "Hold steady" });
  assert.equal(calls.length, 1);
  assert.equal(executions, 0);
  assert.deepEqual(calls[0].opts.mcpConfigArgs, [...COACH_READ_STRICT_MCP_ARGS]);
  assert.match(calls[0].prompt, /^SNAPSHOT BASELINE/);
  assert.match(calls[0].prompt, /authoritative baseline/);
  assert.match(calls[0].prompt, /read_exercise_history/);
  assert.doesNotMatch(calls[0].prompt, /update_plan|delete_everything/);
});

test("coach-read query loop validates, executes, and returns a final answer from the same chosen agent", async () => {
  const calls = [];
  const executions = [];
  const phases = [];
  const turns = [
    chosen({ kind: "coach_read", requests: [trainingRequest()] }),
    chosen({ headline: "Recovery held through the volume block" }),
  ];
  const out = await runChosenWithCoachReads(
    "auto",
    "BASE DATA",
    { op: "case_conference", mode: "conference", timeoutMs: 5_000 },
    { onPhase: (phase, meta) => phases.push({ phase, meta }) },
    {
      run: async (agent, prompt, opts) => {
        calls.push({ agent, prompt, opts });
        return turns.shift();
      },
      execute: async (request, context) => {
        executions.push({ request, context });
        return trainingResult({ events: [{ date: "2026-07-01", load: 42 }] });
      },
      createRunId: () => "run-depth",
    }
  );

  assert.deepEqual(out.result.parsed, { headline: "Recovery held through the volume block" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].agent, "auto");
  assert.equal(calls[1].agent, "terra", "follow-up stays with the provider that requested the read");
  assert.match(calls[1].prompt, /^BASE DATA/);
  assert.match(calls[1].prompt, /VERIFIED COACH READ RESULTS/);
  assert.match(calls[1].prompt, /2026-07-01/);
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0].request, trainingRequest());
  assert.deepEqual(executions[0].context, { run_id: "run-depth", op: "case_conference" });
  assert.ok(phases.some((entry) => entry.phase === "coach_read_query"));
  assert.ok(phases.some((entry) => entry.phase === "coach_read_done"));
});

test("malformed, empty, and over-budget requests degrade to the untouched snapshot-only run", async (t) => {
  const cases = [
    { name: "unknown tool", query: { kind: "coach_read", requests: [{ tool: "update_plan", args: {} }] } },
    { name: "empty request list", query: { kind: "coach_read", requests: [] } },
    {
      name: "ordinary call cap",
      query: { kind: "coach_read", requests: Array.from({ length: 7 }, () => trainingRequest()) },
    },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const prompts = [];
      let executions = 0;
      const turns = [chosen(fixture.query), chosen({ answer: "snapshot" }, "sol")];
      const out = await runChosenWithCoachReads(
        undefined,
        "ORIGINAL SNAPSHOT",
        { op: "weekly_read", timeoutMs: 5_000 },
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
          createRunId: () => `run-${fixture.name}`,
        }
      );
      assert.deepEqual(out.result.parsed, { answer: "snapshot" });
      assert.equal(executions, 0, "all requests in a batch validate before any execute");
      assert.equal(prompts.length, 2);
      assert.equal(prompts[1], "ORIGINAL SNAPSHOT", "fallback removes the query-loop contract and results");
    });
  }
});

test("conference mode permits twelve calls while ordinary mode stays capped at six", async () => {
  const requests = Array.from({ length: 12 }, () => trainingRequest());
  let executions = 0;
  const turns = [chosen({ kind: "coach_read", requests }), chosen({ answer: "conference synthesis" })];
  const out = await runChosenWithCoachReads(
    "terra",
    "BASE",
    { op: "case_conference", mode: "conference", timeoutMs: 5_000 },
    {},
    {
      run: async () => turns.shift(),
      execute: () => {
        executions++;
        return trainingResult();
      },
      createRunId: () => "run-conference",
    }
  );
  assert.equal(executions, 12);
  assert.deepEqual(out.result.parsed, { answer: "conference synthesis" });
});

test("a fourth query round, a tool failure, or total result-byte overflow falls back safely", async (t) => {
  await t.test("round cap", async () => {
    const turns = [
      chosen({ kind: "coach_read", requests: [trainingRequest(1)] }),
      chosen({ kind: "coach_read", requests: [trainingRequest(2)] }),
      chosen({ kind: "coach_read", requests: [trainingRequest(3)] }),
      chosen({ kind: "coach_read", requests: [trainingRequest(4)] }),
      chosen({ answer: "snapshot" }),
    ];
    let executions = 0;
    const out = await runChosenWithCoachReads(
      "auto",
      "BASE",
      { timeoutMs: 5_000 },
      {},
      {
        run: async () => turns.shift(),
        execute: (request) => {
          executions++;
          return trainingResult({ weeks: request.args.weeks });
        },
        createRunId: () => "run-rounds",
      }
    );
    assert.equal(executions, 3);
    assert.deepEqual(out.result.parsed, { answer: "snapshot" });
  });

  await t.test("tool failure", async () => {
    const prompts = [];
    const turns = [chosen({ kind: "coach_read", requests: [trainingRequest()] }), chosen({ answer: "snapshot" })];
    const out = await runChosenWithCoachReads(
      "auto",
      "BASE",
      { timeoutMs: 5_000 },
      {},
      {
        run: async (_agent, prompt) => {
          prompts.push(prompt);
          return turns.shift();
        },
        execute: () => {
          throw new Error("read unavailable");
        },
        createRunId: () => "run-failure",
      }
    );
    assert.deepEqual(out.result.parsed, { answer: "snapshot" });
    assert.equal(prompts.at(-1), "BASE");
  });

  await t.test("byte cap", async () => {
    const turns = [chosen({ kind: "coach_read", requests: [trainingRequest()] }), chosen({ answer: "snapshot" })];
    const out = await runChosenWithCoachReads(
      "auto",
      "BASE",
      { timeoutMs: 5_000 },
      {},
      {
        run: async () => turns.shift(),
        execute: () => trainingResult({ payload: "x".repeat(300 * 1024) }),
        createRunId: () => "run-bytes",
      }
    );
    assert.deepEqual(out.result.parsed, { answer: "snapshot" });
  });
});

test("the total deadline and caller cancellation remain hard boundaries", async (t) => {
  await t.test("deadline", async () => {
    let clock = 0;
    await assert.rejects(
      runChosenWithCoachReads(
        "auto",
        "BASE",
        { timeoutMs: 10 },
        {},
        {
          now: () => clock,
          run: async () => {
            clock = 11;
            return chosen({ kind: "coach_read", requests: [trainingRequest()] });
          },
          execute: () => trainingResult(),
          createRunId: () => "run-timeout",
        }
      ),
      /timed out/
    );
  });

  await t.test("AbortSignal", async () => {
    const controller = new AbortController();
    await assert.rejects(
      runChosenWithCoachReads(
        "auto",
        "BASE",
        { timeoutMs: 5_000, signal: controller.signal },
        {},
        {
          run: async () => {
            controller.abort();
            return chosen({ kind: "coach_read", requests: [trainingRequest()] });
          },
          execute: () => trainingResult(),
          createRunId: () => "run-abort",
        }
      ),
      /canceled/
    );
  });
});
