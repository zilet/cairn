// A pinned model the account can't use, and the failed attempt that used to leave no trace.
//
// Live incident: a fresh hosted install, a new Claude subscription, `claude auth status`
// green — and the first chat turn died in ~1.4 s as "Agent process exited", with nothing
// in the server log. The chat lane pins `--model <alias> --effort <level>` from the
// execution profile; a plan tier that can't use that alias makes the CLI refuse before
// the model says a word. These pin the fix against REAL subprocesses (a fake CLI that
// refuses a pin and answers without one): the classifier reads each CLI's wording, the
// spawn retries once on the CLI's default and remembers the refusal, a failed attempt
// writes ONE redacted warn line, and a busy host is still only ever "busy".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAgent, runAgentStreaming, runAgentWithFallback } from "../dist/agents.js";
import { classifyAgentFailure, modelAccessCulprit } from "../dist/agentAvailability.js";
import { failureTail, redactCliText, structuredErrorText } from "../dist/agentFailureTail.js";
import { clearRefusedPins, refusedPinSnapshot } from "../dist/agentModelPins.js";
import { isAgentBusyError } from "../dist/agent-busy.js";
import { classifyChatAgentResult } from "../dist/chatTurns.js";
import { recordAgentRun } from "../dist/repo/agent-telemetry.js";
import { db } from "../dist/db.js";

const CLAUDE_MODEL_REFUSAL =
  "There's an issue with the selected model (fable). It may not exist or you may not have access to it. Run /model to pick a different model.";

// ---------- the classifier ----------

const failed = (text, where = "stderr") => ({
  code: 1,
  raw: where === "raw" ? text : "",
  stderr: where === "stderr" ? text : "",
});

test("each CLI's model-refusal wording reads as model_unavailable", () => {
  const samples = [
    CLAUDE_MODEL_REFUSAL,
    'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-fable-9"}}',
    "The 'gpt-5.6' model is not supported when using Codex with a ChatGPT account.",
    "The model `gpt-9` does not exist or you do not have access to it.",
    '{"error":{"code":"model_not_found","message":"no such model"}}',
    "models/gemini-9-pro is not found for API version v1beta, or is not supported for generateContent.",
    "Error: Requested entity was not found.",
    "Model not found: grok-9",
    "The model grok-9 does not exist or your team does not have access to it.",
    "Error: unknown model 'fable'",
    "Your account does not have access to model opus",
  ];
  for (const text of samples) {
    const f = classifyAgentFailure("x", failed(text), new Date());
    assert.equal(f?.state, "model_unavailable", text);
    // The same words on stdout of a failed run read the same way.
    assert.equal(classifyAgentFailure("x", failed(text, "raw"), new Date())?.state, "model_unavailable", text);
  }
});

test("an effort refusal is model_unavailable with the EFFORT named as the culprit", () => {
  const effort = [
    "error: option '--effort <level>' argument 'max' is invalid. Allowed choices are low, medium, high.",
    `{"error":{"message":"Unsupported value: 'xhigh' is not supported with the 'gpt-5' model.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"}}`,
    "invalid reasoning effort: ultra",
  ];
  for (const text of effort) {
    assert.equal(modelAccessCulprit(text), "reasoning", text);
    const f = classifyAgentFailure("x", failed(text), new Date());
    assert.equal(f?.state, "model_unavailable", text);
    assert.match(f.detail, /effort/);
  }
  assert.equal(modelAccessCulprit(CLAUDE_MODEL_REFUSAL), "model");
  assert.equal(modelAccessCulprit("Not logged in"), null);
});

test("coaching prose that mentions a model is never a refusal; earlier arms still win", () => {
  // A clean exit with a real reply: "model" words are coaching, not a CLI refusal.
  const reply = "Your personal HR model is not available yet — two more easy runs and it will be.";
  assert.notEqual(
    classifyAgentFailure("x", { code: 0, raw: reply, stderr: "" }, new Date())?.state,
    "model_unavailable"
  );
  // A long failed reply is only trusted through stderr, never its prose.
  const longProse = `${"word ".repeat(300)} the model is not available`;
  assert.notEqual(
    classifyAgentFailure("x", { code: 1, raw: longProse, stderr: "" }, new Date())?.state,
    "model_unavailable"
  );
  // Limits, auth and the server's own resources keep their meaning.
  assert.equal(
    classifyAgentFailure("x", failed("You've hit your weekly limit · resets 8am (UTC)"), new Date())?.state,
    "quota_exhausted"
  );
  assert.equal(
    classifyAgentFailure("x", failed("Not logged in · Please run /login"), new Date())?.state,
    "auth_required"
  );
  assert.equal(classifyAgentFailure("x", failed("ENOSPC: no space left on device"), new Date())?.state, "disk_full");
  // Unrecognised words are still the honest floor.
  assert.equal(classifyAgentFailure("x", failed("segfault in libfoo"), new Date())?.state, "process_error");
});

test("a streamed run's error report (error_text) is read by the classifier", () => {
  const ndjson = [
    JSON.stringify({ type: "system", subtype: "init", model: "fable", tools: ["Read"] }),
    JSON.stringify({ type: "result", subtype: "success", is_error: true, result: CLAUDE_MODEL_REFUSAL }),
  ].join("\n");
  const errorText = structuredErrorText(ndjson);
  assert.match(errorText, /issue with the selected model/);
  assert.equal(
    classifyAgentFailure("claude", { code: 1, raw: "", stderr: "", error_text: errorText }, new Date())?.state,
    "model_unavailable"
  );
  // A healthy stream carries no error report.
  const ok = [
    JSON.stringify({ type: "system", subtype: "init", model: "sonnet" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "fine" }),
  ].join("\n");
  assert.equal(structuredErrorText(ok), "");
});

// ---------- redaction ----------

test("the failure tail is single-lined, bounded, keeps the END, and redacts credentials", () => {
  const prior = process.env.CAIRN_AUTH_TOKEN;
  process.env.CAIRN_AUTH_TOKEN = "cairn-master-token-value-123";
  try {
    const text = [
      "starting up",
      "Authorization: Bearer abcdefghijklmnopqrstuv",
      "key sk-ant-api03-SECRETSECRETSECRETSECRET and xai-ABCDEFGHIJKLMNOP",
      "header token=hunter2-is-the-password",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "hex 0123456789abcdef0123456789abcdef0123",
      "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NTY3ODk=",
      "visit https://example.com/cb?code=abc123&state=xyz",
      "mail someone@example.com",
      "the env token cairn-master-token-value-123 leaked",
      "fatal: the real error is here",
    ].join("\n");
    const scrubbed = redactCliText(text);
    for (const secret of [
      "abcdefghijklmnopqrstuv",
      "SECRETSECRETSECRETSECRET",
      "ABCDEFGHIJKLMNOP",
      "hunter2-is-the-password",
      "eyJhbGciOiJIUzI1NiJ9",
      "0123456789abcdef0123456789abcdef0123",
      "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVph",
      "code=abc123",
      "someone@example.com",
      "cairn-master-token-value-123",
    ]) {
      assert.ok(!scrubbed.includes(secret), `redacted: ${secret}`);
    }
    const tail = failureTail({ stderr: text });
    assert.ok(tail.length <= 400);
    assert.ok(!tail.includes("\n"), "single line");
    assert.match(tail, /fatal: the real error is here$/, "the end survives");
    // stderr first, then the structured error, then stdout; nothing at all is null.
    assert.equal(failureTail({ stderr: "", stdout: "out words", error_text: "the error" }), "the error");
    assert.equal(failureTail({ stderr: "", stdout: "out words" }), "out words");
    assert.equal(failureTail({ stderr: " ", stdout: "" }), null);
    const long = failureTail({ stderr: `${"x ".repeat(1000)}END` });
    assert.ok(long.startsWith("…") && long.endsWith("END") && long.length <= 400);
  } finally {
    if (prior == null) delete process.env.CAIRN_AUTH_TOKEN;
    else process.env.CAIRN_AUTH_TOKEN = prior;
  }
});

// ---------- the fake CLI ----------

// One script, several behaviours, chosen by the template (so no env var has to survive
// the spawn's env sanitising). Every invocation appends its flags (never the prompt) to
// a log so a test can count spawns and see which pins each one carried.
const FAKE_CLI = `
import fs from "node:fs";
const [logPath, mode, ...rest] = process.argv.slice(2);
const flags = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "-p") { i++; continue; }
  flags.push(rest[i]);
}
fs.appendFileSync(logPath, JSON.stringify(flags) + "\\n");
const stream = flags.includes("--stream");
const hasModel = flags.includes("--model");
const hasEffort = flags.includes("--effort");
const REFUSAL = ${JSON.stringify(CLAUDE_MODEL_REFUSAL)};
function refuse() {
  if (stream) {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", model: "fable" }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: REFUSAL }) + "\\n");
  } else {
    process.stderr.write(REFUSAL + "\\n");
  }
  process.exit(1);
}
function succeed() {
  if (stream) {
    for (const t of ["Hello ", "there."]) {
      process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: t } } }) + "\\n");
    }
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Hello there." }) + "\\n");
  } else {
    process.stdout.write('{"ok":true}');
  }
  process.exit(0);
}
if (mode === "refuse-model") (hasModel ? refuse : succeed)();
else if (mode === "refuse-always") refuse();
else if (mode === "refuse-effort") {
  if (hasEffort) {
    process.stderr.write("error: option '--effort <level>' argument 'high' is invalid. Allowed choices are low, medium.\\n");
    process.exit(1);
  }
  succeed();
} else if (mode === "crash") {
  process.stderr.write("panic: boom\\nAuthorization: Bearer abcdefghijklmnopqrstuv sk-ant-api03-SECRETSECRETSECRETSECRET\\n");
  process.exit(3);
} else if (mode === "slow") setTimeout(succeed, 300);
else succeed();
`;

function agentDef(script, logPath, mode) {
  return {
    command: process.execPath,
    args: [script, logPath, mode, "{model_args}", "{reasoning_args}", "-p", "{prompt}"],
    input: "arg",
    label: "Fake",
    description: "Fake CLI for the model-access tests.",
    env_required: [],
    login: null,
    status_check: null,
    auth_state: null,
    models_list: null,
    model_flag: ["--model", "{model}"],
    reasoning_flag: ["--effort", "{reasoning}"],
    model_classes: { fast: "sonnet", deep: "fable" },
    capabilities: { model: true, reasoning: ["low", "medium", "high"] },
    stream: {
      format: "claude",
      args: [script, logPath, mode, "{model_args}", "{reasoning_args}", "--stream", "-p", "{prompt}"],
    },
  };
}

async function withFakeAgents(modes, fn, { limit } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-model-access-"));
  const script = path.join(dir, "fake-cli.mjs");
  fs.writeFileSync(script, FAKE_CLI);
  const logPath = path.join(dir, "spawns.log");
  fs.writeFileSync(logPath, "");
  const agents = {};
  for (const [name, mode] of Object.entries(modes)) agents[name] = agentDef(script, logPath, mode);
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify(agents, null, 2));
  const priorConfig = process.env.AGENTS_CONFIG;
  const priorLimit = process.env.CAIRN_MAX_AGENT_PROCS;
  process.env.AGENTS_CONFIG = configPath;
  if (limit != null) process.env.CAIRN_MAX_AGENT_PROCS = String(limit);
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  clearRefusedPins();
  const spawns = () =>
    fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  try {
    await fn({ spawns, warnings });
  } finally {
    console.warn = realWarn;
    clearRefusedPins();
    if (priorConfig == null) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = priorConfig;
    if (priorLimit == null) delete process.env.CAIRN_MAX_AGENT_PROCS;
    else process.env.CAIRN_MAX_AGENT_PROCS = priorLimit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- the no-pin retry ----------

test("a refused model pin retries once on the CLI default, then is skipped up front", async () => {
  await withFakeAgents({ fake: "refuse-model" }, async ({ spawns, warnings }) => {
    const first = await runAgent("fake", "hi", { model: "fable", reasoning: "high", op: "day_read" });
    assert.equal(first.code, 0, "the retry answered");
    assert.deepEqual(first.parsed, { ok: true });
    assert.deepEqual(first.pin_dropped, ["model", "reasoning"]);
    const calls = spawns();
    assert.equal(calls.length, 2, "exactly one retry");
    assert.ok(calls[0].includes("--model") && calls[0].includes("fable"));
    assert.ok(!calls[1].includes("--model") && !calls[1].includes("--effort"), "the retry carries no pin");
    assert.deepEqual(
      refusedPinSnapshot().map(({ agent, field, value }) => ({ agent, field, value })),
      [{ agent: "fake", field: "model", value: "fable" }],
      "only the culprit is remembered"
    );
    assert.ok(warnings.some((w) => /refused the pinned model/.test(w) && /op=day_read/.test(w)));
    assert.ok(
      warnings.some((w) => /attempt failed/.test(w) && /exit=1/.test(w) && /issue with the selected model/.test(w)),
      "the failed attempt logged its tail"
    );

    // Next run: the refused model is dropped BEFORE spawning; the effort still rides.
    const second = await runAgent("fake", "hi", { model: "fable", reasoning: "high" });
    assert.equal(second.code, 0);
    assert.deepEqual(second.pin_dropped, ["model"]);
    const after = spawns();
    assert.equal(after.length, 3, "no failed first spawn this time");
    assert.ok(!after[2].includes("--model") && after[2].includes("--effort"));
  });
});

test("a refused effort pin is remembered as the effort, not the model", async () => {
  await withFakeAgents({ fake: "refuse-effort" }, async ({ spawns }) => {
    const res = await runAgent("fake", "hi", { model: "sonnet", reasoning: "high" });
    assert.equal(res.code, 0);
    assert.equal(spawns().length, 2);
    assert.deepEqual(
      refusedPinSnapshot().map(({ field, value }) => ({ field, value })),
      [{ field: "reasoning", value: "high" }]
    );
    await runAgent("fake", "hi", { model: "sonnet", reasoning: "high" });
    const third = spawns()[2];
    assert.ok(third.includes("--model") && !third.includes("--effort"), "the model pin is kept");
  });
});

test("the rotation and the profile resolver go through the same retry", async () => {
  await withFakeAgents({ fake: "refuse-model" }, async ({ spawns }) => {
    const fb = await runAgentWithFallback(["fake"], "hi", {
      op: "session_suggest",
      profile: () => ({ model: "fable", reasoning: "medium" }),
    });
    assert.equal(fb.agent, "fake");
    assert.deepEqual(fb.result.parsed, { ok: true });
    assert.equal(spawns().length, 2);
  });
});

test("a streamed chat run retries without the pin and its reply streams once", async () => {
  await withFakeAgents({ fake: "refuse-model" }, async ({ spawns }) => {
    const deltas = [];
    const res = await runAgentStreaming("fake", "hi", {
      model: "fable",
      reasoning: "high",
      op: "chat:coach",
      priority: "interactive",
      onDelta: (t) => deltas.push(t),
    });
    assert.equal(res.code, 0);
    assert.equal(res.raw, "Hello there.");
    assert.equal(deltas.join(""), "Hello there.", "the refused attempt streamed nothing");
    assert.equal(spawns().length, 2);
    assert.equal(classifyChatAgentResult("fake", res), null, "a reply, not a failure");
  });
});

test("when the no-pin retry is refused too, chat says the plan can't use the model", async () => {
  await withFakeAgents({ fake: "refuse-always" }, async ({ spawns }) => {
    const res = await runAgentStreaming("fake", "hi", { model: "fable", onDelta: () => {} });
    assert.equal(res.code, 1);
    assert.equal(spawns().length, 2, "one retry, never a loop");
    assert.match(res.error_text, /issue with the selected model/);
    const attempt = classifyChatAgentResult("fake", res);
    assert.equal(attempt.status, "model_unavailable");
    assert.match(attempt.error_message, /plan can't use the model/);
    assert.match(attempt.failure_tail, /issue with the selected model/);
  });
});

test("an unpinned run is never retried, and an unknown exit says where to look", async () => {
  await withFakeAgents({ fake: "refuse-always", boom: "crash" }, async ({ spawns, warnings }) => {
    const res = await runAgent("fake", "hi");
    assert.equal(res.code, 1);
    assert.equal(spawns().length, 1, "no pin, nothing to drop");

    const crash = await runAgent("boom", "hi", { op: "chat:coach" });
    assert.equal(crash.code, 3);
    assert.ok(!crash.failure_tail.includes("abcdefghijklmnopqrstuv"), "bearer redacted");
    assert.ok(!crash.failure_tail.includes("SECRETSECRET"), "key redacted");
    assert.match(crash.failure_tail, /panic: boom/);
    const line = warnings.find((w) => /boom attempt failed/.test(w));
    assert.ok(line, "one warn line for the failed attempt");
    assert.match(line, /op=chat:coach/);
    assert.match(line, /exit=3/);
    assert.match(line, /ms=\d+/);
    assert.ok(!line.includes("SECRETSECRET") && !line.includes("abcdefghijklmnopqrstuv"));
    assert.ok(!line.includes("hi\n") && !/NO_TOOLS|Everything you need/.test(line), "never the prompt");

    const attempt = classifyChatAgentResult("boom", crash);
    assert.equal(attempt.error_class, "process_exit");
    assert.equal(attempt.error_message, "stopped with an error; see the server log");
  });
});

test("busy is still only busy: no spawn, no refusal remembered, no retry", async () => {
  await withFakeAgents(
    { holder: "slow", fake: "refuse-model" },
    async ({ spawns }) => {
      const holder = runAgent("holder", "hi");
      await assert.rejects(runAgent("fake", "hi", { model: "fable", timeoutMs: 20 }), (e) => isAgentBusyError(e));
      await holder;
      assert.equal(spawns().length, 1, "only the holder ever ran");
      assert.deepEqual(refusedPinSnapshot(), [], "busy is not a refusal");
    },
    { limit: 1 }
  );
});

// ---------- the local agent_runs row ----------

test("a failed attempt keeps its redacted tail on agent_runs; a success keeps none", () => {
  recordAgentRun({
    op: "chat",
    agent: "claude",
    ok: false,
    parsed: false,
    latency_ms: 1400,
    tried_json: false,
    status: "error",
    error_class: "process_exit",
    failure_tail: "fatal Bearer abcdefghijklmnopqrstuv " + CLAUDE_MODEL_REFUSAL,
  });
  recordAgentRun({
    op: "chat",
    agent: "claude",
    ok: true,
    parsed: true,
    latency_ms: 900,
    tried_json: false,
    failure_tail: "should never be stored",
  });
  const rows = db.prepare("SELECT ok, error_message, failure_tail FROM agent_runs ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.match(rows[0].failure_tail, /issue with the selected model/);
  assert.ok(!rows[0].failure_tail.includes("abcdefghijklmnopqrstuv"));
  assert.equal(rows[0].error_message, "process_exit: agent attempt failed", "error_message stays taxonomy-only");
  assert.equal(rows[1].failure_tail, null);
});

test("model_unavailable is a first-class telemetry class", async () => {
  const { agentErrorClass } = await import("../dist/telemetry-privacy.js");
  assert.equal(agentErrorClass("model_unavailable", "model_unavailable"), "model_unavailable");
});
