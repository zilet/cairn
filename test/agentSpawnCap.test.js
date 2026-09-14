// The process-wide cap on concurrent agent CLI subprocesses.
//
// Six lanes spawn coaching CLIs — chat, the agent-job runner, the enrichment queue, the
// proactive pass, the day-read precompute and the day-read refresh — and each only ever
// knew about itself. Nothing counted the total, so a quiet morning could put four
// Node-based CLIs on a Pi's four cores at once, with the athlete's own chat turn last
// in line for the memory. One semaphore at the one point every lane passes through (the
// spawn) fixes that, and these pin it against real subprocesses rather than a mock.
//
// The fixture agents append their own start/end marker to a shared log, so the
// concurrency asserted here is the number of processes that were genuinely alive
// together, not the counter's opinion of itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentSlotStats, runAgent, runAgentWithFallback } from "../dist/agents.js";
import { isAgentBusyError } from "../dist/agent-busy.js";

const SLEEP_SEC = "0.25";

// Build an agents.json whose every entry is a slow, self-logging shell. `input: "arg"`
// with no {prompt} slot is the bundled stub's own shape: the prompt is irrelevant here,
// only the process lifetime is.
function fixture(names, logPath) {
  const agents = {};
  for (const name of names) {
    agents[name] = {
      command: "sh",
      args: [
        "-c",
        `printf 'start %s\\n' '${name}' >> '${logPath}'; sleep ${SLEEP_SEC}; ` +
          `printf 'end %s\\n' '${name}' >> '${logPath}'; printf '%s' '{"ok":true}'`,
      ],
      input: "arg",
      description: "Slow fixture agent for the spawn-cap test.",
      env_required: [],
      login: null,
      status_check: null,
      auth_state: null,
      models_list: null,
      model_flag: ["--model", "{model}"],
      capabilities: { model: false, reasoning: [], execution_profile_noop: true },
      reasoning_flag: null,
    };
  }
  return agents;
}

// Replay the log and report the high-water mark of simultaneously-live processes, plus
// the order they actually started in.
function readLog(logPath) {
  const lines = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  let live = 0;
  let peak = 0;
  const startOrder = [];
  for (const line of lines) {
    const [event, name] = line.split(" ");
    if (event === "start") {
      startOrder.push(name);
      live++;
      peak = Math.max(peak, live);
    } else {
      live--;
    }
  }
  return { peak, startOrder, lines };
}

async function withFixture(names, limit, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-spawn-cap-"));
  const logPath = path.join(dir, "spawns.log");
  fs.writeFileSync(logPath, "");
  const configPath = path.join(dir, "agents.json");
  fs.writeFileSync(configPath, JSON.stringify(fixture(names, logPath), null, 2));
  const priorConfig = process.env.AGENTS_CONFIG;
  const priorLimit = process.env.CAIRN_MAX_AGENT_PROCS;
  process.env.AGENTS_CONFIG = configPath;
  if (limit == null) delete process.env.CAIRN_MAX_AGENT_PROCS;
  else process.env.CAIRN_MAX_AGENT_PROCS = String(limit);
  try {
    return await fn({ logPath, read: () => readLog(logPath) });
  } finally {
    if (priorConfig === undefined) delete process.env.AGENTS_CONFIG;
    else process.env.AGENTS_CONFIG = priorConfig;
    if (priorLimit === undefined) delete process.env.CAIRN_MAX_AGENT_PROCS;
    else process.env.CAIRN_MAX_AGENT_PROCS = priorLimit;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("six concurrent runs never put more than the limit of CLIs on the host", async () => {
  const names = Array.from({ length: 6 }, (_, i) => `slow-${i}`);
  await withFixture(names, 2, async ({ read }) => {
    const results = await Promise.all(names.map((name) => runAgent(name, "ignored prompt")));
    assert.equal(results.length, 6);
    for (const r of results) assert.deepEqual(r.parsed, { ok: true }, "every run still completed normally");

    const { peak, startOrder, lines } = read();
    assert.equal(lines.length, 12, "six starts and six ends were logged");
    assert.ok(peak <= 2, `at most 2 CLIs alive together, saw ${peak}`);
    assert.equal(peak, 2, "and the cap is used, not merely respected");
    assert.deepEqual(startOrder, names, "waiting is FIFO — no lane overtakes an earlier one");
  });
});

test("the cap is read from the environment, so a bigger host can be told so", async () => {
  const names = Array.from({ length: 4 }, (_, i) => `one-${i}`);
  await withFixture(names, 1, async ({ read }) => {
    assert.equal(agentSlotStats().limit, 1);
    await Promise.all(names.map((name) => runAgent(name, "ignored prompt")));
    assert.equal(read().peak, 1, "a limit of 1 serializes the lanes completely");
  });
});

test("a nonsense limit falls back to the default of 2", async () => {
  await withFixture(["unused"], "not-a-number", async () => {
    assert.equal(agentSlotStats().limit, 2);
  });
  await withFixture(["unused"], null, async () => {
    assert.equal(agentSlotStats().limit, 2);
  });
  await withFixture(["unused"], 0, async () => {
    assert.equal(agentSlotStats().limit, 1, "the floor is one permit, never zero");
  });
  await withFixture(["unused"], "", async () => {
    assert.equal(agentSlotStats().limit, 2, "a blank value is unset, not zero");
  });
});

test("Stop drops a QUEUED run out of the line without ever spawning it", async () => {
  const names = ["holder", "queued"];
  await withFixture(names, 1, async ({ read }) => {
    const controller = new AbortController();
    const holder = runAgent("holder", "ignored prompt");
    const queued = runAgent("queued", "ignored prompt", { signal: controller.signal });
    // The holder took the only permit synchronously, so `queued` is waiting, not running.
    assert.equal(agentSlotStats().active, 1);
    assert.equal(agentSlotStats().waiting, 1);

    controller.abort();
    await assert.rejects(queued, /canceled/);
    await holder;

    const { startOrder } = read();
    assert.deepEqual(startOrder, ["holder"], "the canceled run never became a process");
    assert.equal(agentSlotStats().active, 0, "and it left no permit behind");
    assert.equal(agentSlotStats().waiting, 0);
  });
});

test("every permit is released, whatever the run did", async () => {
  await withFixture(["slow-0"], 2, async () => {
    await runAgent("slow-0", "ignored prompt");
    await assert.rejects(runAgent("no-such-agent", "ignored prompt"), /Unknown agent/);
    await assert.rejects(runAgent("slow-0", "ignored prompt", { timeoutMs: 20 }), /timed out/);
    assert.equal(agentSlotStats().active, 0);
    assert.equal(agentSlotStats().waiting, 0);
  });
});

// ---------- priority: the athlete's own turn never queues behind batch work ----------
// The cap alone starved the one lane a person is actually watching: two background
// holders (a deep proposal job, an enrichment drain) left a chat turn queued with its
// SSE stream open and no tokens on it, and since the turn's timeout is armed only after
// the permit is taken, the wait could not even fail. So an interactive run jumps the
// queue AND may take one permit reserved above the cap, and every wait is bounded.

test("an athlete's turn takes the reserved permit instead of queueing behind batch work", async () => {
  await withFixture(["job", "enrich", "batch", "chat"], 2, async ({ read }) => {
    const job = runAgent("job", "ignored prompt");
    const enrich = runAgent("enrich", "ignored prompt");
    const batch = runAgent("batch", "ignored prompt"); // background — the cap is full, so it waits
    assert.equal(agentSlotStats().active, 2);
    assert.equal(agentSlotStats().waiting, 1);

    const chat = runAgent("chat", "ignored prompt", { priority: "interactive" });
    assert.equal(agentSlotStats().active, 3, "the reserved permit sits ABOVE the cap, not inside it");
    assert.equal(agentSlotStats().waiting, 1, "and the queued background run keeps its place in line");
    assert.equal(agentSlotStats().waitingInteractive, 0, "the athlete's turn never waited at all");

    await Promise.all([job, enrich, batch, chat]);
    const { peak, startOrder } = read();
    assert.equal(peak, 3, "the cap plus the one interactive permit — never more");
    assert.deepEqual(startOrder.slice(0, 3).sort(), ["chat", "enrich", "job"]);
    assert.equal(startOrder[3], "batch", "background work still waited its turn");
    assert.equal(agentSlotStats().active, 0);
  });
});

test("a waiting interactive run is served before a background one that queued first", async () => {
  await withFixture(["bg-hold", "chat-hold", "batch", "chat"], 1, async ({ read }) => {
    const bgHold = runAgent("bg-hold", "ignored prompt"); // takes the cap
    const chatHold = runAgent("chat-hold", "ignored prompt", { priority: "interactive" }); // takes the reserve
    assert.equal(agentSlotStats().active, 2);

    const batch = runAgent("batch", "ignored prompt"); // queues FIRST
    const chat = runAgent("chat", "ignored prompt", { priority: "interactive" }); // queues second
    assert.equal(agentSlotStats().waiting, 2);
    assert.equal(agentSlotStats().waitingInteractive, 1);

    await Promise.all([bgHold, chatHold, batch, chat]);
    const { peak, startOrder } = read();
    assert.equal(peak, 2, "one cap permit plus the one reserved permit");
    assert.equal(startOrder[2], "chat", "the interactive waiter jumped the line");
    assert.equal(startOrder[3], "batch");
  });
});

test("a waiter that cannot get a permit fails as busy rather than hanging", async () => {
  await withFixture(["holder", "queued", "chat-0", "chat-1", "chat-2"], 1, async ({ read }) => {
    const holder = runAgent("holder", "ignored prompt");
    // The wait is bounded by the run's OWN timeout budget, spent on the queue instead
    // of deducted from the run: 20 ms of waiting here, then a named failure.
    await assert.rejects(runAgent("queued", "ignored prompt", { timeoutMs: 20 }), /busy/);
    await holder;
    assert.deepEqual(read().startOrder, ["holder"], "the busy run never became a process");

    // The reserve is one permit, not an exemption — an interactive run is bounded too.
    const a = runAgent("chat-0", "ignored prompt", { priority: "interactive" });
    const b = runAgent("chat-1", "ignored prompt", { priority: "interactive" });
    assert.equal(agentSlotStats().active, 2, "the cap of one, plus the reserved permit");
    await assert.rejects(
      runAgent("chat-2", "ignored prompt", { priority: "interactive", timeoutMs: 20 }),
      /busy/
    );
    await Promise.all([a, b]);
    assert.equal(agentSlotStats().active, 0, "every permit came back");
    assert.equal(agentSlotStats().waiting, 0);
  });
});

test("busy never rotates to the next agent — the permit is process-wide", async () => {
  await withFixture(["holder", "first", "second"], 1, async ({ read }) => {
    const holder = runAgent("holder", "ignored prompt");
    // The rotation would normally try `second` when `first` fails. It must not here:
    // the second agent would queue for the SAME permit, wait exactly as long, and fail
    // exactly as hard — spending another whole budget to learn what we already know.
    await assert.rejects(
      runAgentWithFallback(["first", "second"], "ignored prompt", { timeoutMs: 20 }),
      (error) => isAgentBusyError(error) && /busy/.test(String(error.message))
    );
    await holder;
    assert.deepEqual(read().startOrder, ["holder"], "neither candidate was ever spawned");
    assert.equal(agentSlotStats().waiting, 0, "and neither is still in the queue");
  });
});
