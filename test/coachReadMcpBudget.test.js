// The native coach-read listener holds the budget SERVER-side (src/coachReadMcp.ts): a
// call past the cap, or a result past the per-call or total byte budget, gets a plain
// tool error telling the model to answer with what it has; every call is recorded
// {tool, args_digest, ms, bytes, ok} and never its arguments or result. The gate is
// tested directly (deterministic, no socket); one end-to-end call through the real
// loopback listener runs where the sandbox permits listen(2).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./_seed.js";
import { seedDemo } from "../dist/demoSeed.js";
import { COACH_READ_TOOL_NAMES } from "../dist/brain/read-tools.js";
import { CoachReadToolExecutionError } from "../dist/brain/read-tool-runtime.js";
import {
  NATIVE_COACH_READ_BUDGET,
  clampListenerTtl,
  createCoachReadGate,
  gatedCoachRead,
  registerCoachReadTools,
  startCoachReadMcpListener,
} from "../dist/coachReadMcp.js";

const ctx = { run_id: "budget-test", op: "chat" };
const smallResult = (tool) => ({ tool, data: { ok: true }, rows_returned: 0, truncated: false });

test("the native budget raises the call cap and keeps the prompt loop's total", () => {
  assert.equal(NATIVE_COACH_READ_BUDGET.maxCalls, 12);
  assert.equal(NATIVE_COACH_READ_BUDGET.maxTotalBytes, 256 * 1024);
  assert.ok(NATIVE_COACH_READ_BUDGET.maxCallBytes <= NATIVE_COACH_READ_BUDGET.maxTotalBytes);
});

test("calls past the cap return the tool error and execute nothing", () => {
  const gate = createCoachReadGate({ maxCalls: 3 });
  let executed = 0;
  const execute = (request) => {
    executed++;
    return smallResult(request.tool);
  };
  for (let i = 0; i < 3; i++) {
    const out = gatedCoachRead(gate, "read_training_window", { weeks: 4 + i }, ctx, execute);
    assert.ok(!out.isError);
    assert.deepEqual(JSON.parse(out.content[0].text).tool, "read_training_window");
  }
  const over = gatedCoachRead(gate, "read_marker_history", { marker: "Ferritin" }, ctx, execute);
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /answer now with what you already have/i);
  assert.equal(executed, 3, "the over-cap call never reached the runtime");
  assert.equal(gate.calls.length, 4);
  assert.deepEqual(
    gate.calls.map((call) => [call.tool, call.ok, call.refused ?? null]),
    [
      ["read_training_window", true, null],
      ["read_training_window", true, null],
      ["read_training_window", true, null],
      ["read_marker_history", false, "call_budget"],
    ]
  );
});

test("a result past the per-call or total byte budget is refused, and recorded without its content", () => {
  const big = (tool) => ({ tool, data: { blob: "x".repeat(6_000) }, rows_returned: 1, truncated: false });
  const perCall = createCoachReadGate({ maxCallBytes: 2_000 });
  const refused = gatedCoachRead(perCall, "read_recovery_window", { days: 30 }, ctx, big);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /larger than this reply's remaining read budget/);
  assert.deepEqual(
    { ok: perCall.calls[0].ok, bytes: perCall.calls[0].bytes, refused: perCall.calls[0].refused },
    { ok: false, bytes: 0, refused: "byte_budget" }
  );

  const total = createCoachReadGate({ maxTotalBytes: 10_000 });
  assert.ok(!gatedCoachRead(total, "read_recovery_window", { days: 30 }, ctx, big).isError);
  const second = gatedCoachRead(total, "read_recovery_window", { days: 60 }, ctx, big);
  assert.equal(second.isError, true, "the second result would cross the turn's total");
  assert.equal(total.totalBytes, total.calls[0].bytes);
  assert.ok(total.calls[0].bytes > 6_000);

  // What is kept is counts and a digest — never the arguments or the result.
  const serialized = JSON.stringify([...perCall.calls, ...total.calls]);
  assert.doesNotMatch(serialized, /xxxx|"days"|blob/);
  for (const call of total.calls) assert.match(call.args_digest, /^[0-9a-f]{12}$/);
  assert.notEqual(total.calls[0].args_digest, total.calls[1].args_digest, "different arguments, different digests");
});

test("an invalid or failing read is a calm tool error, recorded as refused", () => {
  const gate = createCoachReadGate();
  const invalid = gatedCoachRead(gate, "read_recovery_window", { days: 900 }, ctx, () => {
    throw new CoachReadToolExecutionError("invalid_request", "bad");
  });
  assert.equal(invalid.isError, true);
  const failed = gatedCoachRead(gate, "read_recovery_window", {}, ctx, () => {
    throw new Error("boom");
  });
  assert.equal(failed.isError, true);
  assert.deepEqual(
    gate.calls.map((call) => call.refused),
    ["invalid_request", "execution_failed"]
  );
});

test("parallel calls reserve their slot before executing, so a burst never overshoots the cap", async () => {
  const gate = createCoachReadGate({ maxCalls: 2 });
  const outs = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      Promise.resolve().then(() => gatedCoachRead(gate, "read_goal_progress", { i }, ctx, (r) => smallResult(r.tool)))
    )
  );
  assert.equal(outs.filter((out) => !out.isError).length, 2);
  assert.equal(outs.filter((out) => out.isError).length, 3);
});

test("the MCP adapter registers every catalog read, the new ones included, as read-only", () => {
  const registered = [];
  registerCoachReadTools(
    {
      tool(name, _description, schema, annotations) {
        registered.push({ name, schema, annotations });
      },
    },
    ctx,
    createCoachReadGate()
  );
  assert.deepEqual(registered.map((r) => r.name).sort(), [...COACH_READ_TOOL_NAMES].sort());
  for (const name of ["read_run_week", "read_health_summary", "read_strength_progress", "read_goal_progress"]) {
    const entry = registered.find((r) => r.name === name);
    assert.ok(entry, `${name} is served`);
    assert.deepEqual(Object.keys(entry.schema), [], `${name} takes no arguments`);
  }
  assert.ok(registered.every((r) => r.annotations?.readOnlyHint === true && r.annotations?.destructiveHint === false));
});

test("end to end: a real MCP client call through the loopback listener is gated and recorded", async (t) => {
  seedDemo();
  let listener;
  try {
    listener = await startCoachReadMcpListener({ run_id: "budget-e2e", op: "chat", ttlMs: 10_000, budget: { maxCalls: 1 } });
  } catch (error) {
    // Some deterministic test sandboxes deny every listen(2), including loopback.
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("this sandbox denies listen(2)");
      return;
    }
    throw error;
  }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "budget-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(listener.url)));
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "read_run_week"));
    const first = await client.callTool({ name: "read_run_week", arguments: {} });
    assert.ok(!first.isError);
    const payload = JSON.parse(first.content[0].text);
    assert.equal(payload.tool, "read_run_week");
    assert.ok(Object.hasOwn(payload.data, "run_plan"), "the run week carries the engine's plan");
    const second = await client.callTool({ name: "read_goal_progress", arguments: {} });
    assert.equal(second.isError, true, "the cap of one holds across stateless requests");
    assert.ok(listener.gate.requests > 0);
    assert.deepEqual(
      listener.gate.calls.map((call) => [call.tool, call.ok]),
      [
        ["read_run_week", true],
        ["read_goal_progress", false],
      ]
    );
  } finally {
    await client.close().catch(() => {});
    await listener.close();
  }
});

test("rearm restarts the listener's TTL from the permit, so a long queue wait cannot close it mid-run", async (t) => {
  let listener;
  try {
    listener = await startCoachReadMcpListener({ run_id: "ttl", op: "chat", ttlMs: 1_000 });
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("this sandbox denies listen(2)");
      return;
    }
    throw error;
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 600));
    listener.rearm(5_000); // the run just took its permit
    await new Promise((resolve) => setTimeout(resolve, 700)); // past the first TTL
    const res = await fetch(listener.url, { method: "GET" });
    assert.equal(res.status, 405, "still serving (a stateless server answers GET with 405)");
  } finally {
    await listener.close();
  }
  assert.equal(clampListenerTtl(10), 1_000);
  assert.equal(clampListenerTtl(99 * 60_000), 30 * 60_000);
});

test("a CLI failure tail never keeps the listener URL or its token", async () => {
  const { failureTail, redactCliText } = await import("../dist/agentFailureTail.js");
  const url = "http://127.0.0.1:43210/mcp/AbCdEf0123456789_-AbCdEf01234567";
  const text = `error: MCP server cairn-coach-read at ${url} refused (127.0.0.1:43210/mcp/AbCdEf0123456789_-AbCdEf01234567)`;
  assert.doesNotMatch(redactCliText(text), /AbCdEf|43210\/mcp/);
  assert.match(redactCliText(text), /\[coach-read listener\]/);
  assert.doesNotMatch(String(failureTail({ stderr: text })), /AbCdEf|\/mcp\//);
});
