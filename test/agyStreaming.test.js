// agy streams chat. Antigravity ran one-shot, so a chat turn on it showed nothing until
// the whole reply was done (~20 s on a Pi). agy 1.3.x has `--output-format stream-json`:
// step_update events carry `text_delta`s of the reply, a final `result` restates it.
// Shapes below are agy 1.3.4's own lines, verified live (2026-10-13).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invalidateAgentConfigured, runAgentStreaming, streamDelta, streamFinalText } from "../dist/agents.js";
import { structuredErrorText } from "../dist/agentFailureTail.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conv = "df5a26af-30e1-4266-a45b-a465656b60b8";
const step = (fields) => JSON.stringify({ event: "step_update", step_update: { conversation_id: conv, ...fields } });
const LINES = {
  init: JSON.stringify({ event: "init", conversation_id: conv, init: { cwd: "/tmp", tools: ["view_file"] } }),
  input: step({ step_index: 0, state: "DONE", step_type: "user_input" }),
  delta1: step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Running builds endurance" }),
  delta2: step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: " and clears the mind." }),
  done: step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\n", duration_seconds: 3.1 }),
  result: JSON.stringify({
    event: "result",
    result: { conversation_id: conv, status: "SUCCESS", response: "Running builds endurance and clears the mind.\n" },
  }),
};

test("streamDelta(agy): the reply's text deltas, nothing from init, input or result", () => {
  assert.equal(streamDelta("agy", LINES.init), null);
  assert.equal(streamDelta("agy", LINES.input), null);
  assert.equal(streamDelta("agy", LINES.delta1), "Running builds endurance");
  assert.equal(streamDelta("agy", LINES.done), "\n");
  assert.equal(streamDelta("agy", LINES.result), null);
  assert.equal(streamDelta("agy", "not json"), null);
});

test("streamFinalText(agy): only a SUCCESS result restates the reply", () => {
  assert.equal(streamFinalText("agy", LINES.result), "Running builds endurance and clears the mind.\n");
  assert.equal(streamFinalText("agy", LINES.delta1), null);
  assert.equal(streamFinalText("claude", LINES.result), null);
  const failed = JSON.stringify({
    event: "result",
    result: { status: "ERROR", error: { message: "quota exhausted" } },
  });
  assert.equal(streamFinalText("agy", failed), null);
});

test("a failed agy result is lifted out as the run's error text", () => {
  const failed = JSON.stringify({
    event: "result",
    result: { status: "ERROR", error: { message: "Resource exhausted" } },
  });
  assert.equal(structuredErrorText([LINES.init, LINES.input, failed].join("\n")), "Resource exhausted");
  assert.equal(structuredErrorText([LINES.init, LINES.delta1, LINES.result].join("\n")), "");
});

test("agents.json streams antigravity's chat, with the prompt slot and its stdin fallback intact", () => {
  const def = JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf8")).antigravity;
  assert.equal(def.stream.format, "agy");
  assert.ok(def.stream.args.includes("stream-json"));
  assert.ok(!def.stream.args.includes("{schema_args}"), "a streamed op is prose-first");
  assert.equal(def.large_prompt.via, "stdin_plain");
});

async function withFakeAgy(lines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-agy-stream-"));
  const cli = path.join(dir, "fake-agy");
  fs.writeFileSync(cli, `#!${process.execPath}\nfor (const l of ${JSON.stringify(lines)}) console.log(l);\n`);
  fs.chmodSync(cli, 0o755);
  const configPath = path.join(dir, "agents.json");
  const shipped = JSON.parse(fs.readFileSync(path.join(root, "agents.json"), "utf8")).antigravity;
  fs.writeFileSync(configPath, JSON.stringify({ antigravity: { ...shipped, command: cli, install: undefined } }));
  const previous = process.env.AGENTS_CONFIG;
  process.env.AGENTS_CONFIG = configPath;
  invalidateAgentConfigured();
  try {
    return await fn();
  } finally {
    if (previous == null) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = previous;
    invalidateAgentConfigured();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a streamed agy run hands each delta over as it lands, and the reply once", async () => {
  await withFakeAgy(Object.values(LINES), async () => {
    const deltas = [];
    const out = await runAgentStreaming("antigravity", "Say something.", {
      onDelta: (d) => deltas.push(d),
      timeoutMs: 10_000,
    });
    assert.equal(out.code, 0);
    assert.deepEqual(deltas, ["Running builds endurance", " and clears the mind.", "\n"]);
    assert.equal(out.raw, "Running builds endurance and clears the mind.\n", "the result never doubles it");
  });
});

test("an agy run that answered in one piece still reads, from its result", async () => {
  await withFakeAgy([LINES.init, LINES.input, LINES.result], async () => {
    const out = await runAgentStreaming("antigravity", "Say something.", { timeoutMs: 10_000 });
    assert.equal(out.raw, "Running builds endurance and clears the mind.\n");
  });
});
