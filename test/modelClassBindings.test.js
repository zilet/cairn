// The model a CLI runs is its OWN default unless the person picks one (Settings ->
// Agents: Everyday = the fast class, Deep work = the deep class). One setting,
// settings.model_class_bindings, governs both the ops (TASK_EXECUTION_PROFILES) and
// chat (each lane maps to a class); chat_profile_bindings stays the advanced per-lane
// override that wins over it. Effort stays server policy throughout.
//
// Offline: the chat loop runs through runChatCompletion's injected runner seam, so no
// CLI is ever spawned.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import { CHAT_LANE_MODEL_CLASS, classBoundChatModel, resolveChatProfile } from "../dist/chatRouting.js";
import { listAgents, parseModelsOutput } from "../dist/agents.js";
import { runChatCompletion } from "../dist/chatTurns.js";

beforeEach(() => {
  resetTables("chat_turns", "chat_messages");
  db.prepare("DELETE FROM settings WHERE id = 1").run();
  repo.setSettings({ enrich_enabled: false, chat_routing_mode: "adaptive" });
});

// ---------- chat profile resolution (pure) ----------

test("each chat lane belongs to a model class: capture and coach are everyday, deep is deep", () => {
  assert.deepEqual(CHAT_LANE_MODEL_CLASS, { capture: "fast", coach: "fast", deep: "deep" });
  const classes = { claude: { fast: "sonnet", deep: "opus" } };
  assert.equal(classBoundChatModel("claude", "deep", classes), "opus");
  assert.equal(classBoundChatModel("codex", "deep", classes), undefined);
  assert.equal(classBoundChatModel("", "fast", classes), undefined);
  assert.equal(classBoundChatModel("claude", "fast", null), undefined);
});

test("a chat lane takes no model by default, follows the class binding, and a per-lane override wins", () => {
  // Default: the CLI's own model, lane effort only.
  assert.deepEqual(resolveChatProfile("coach", "claude", {}, {}), { reasoning: "medium" });
  assert.deepEqual(resolveChatProfile("deep", "claude", {}), { reasoning: "high" });
  const classes = { claude: { fast: "sonnet", deep: "opus" } };
  assert.deepEqual(resolveChatProfile("capture", "claude", {}, classes), { model: "sonnet", reasoning: "low" });
  assert.deepEqual(resolveChatProfile("coach", "claude", {}, classes), { model: "sonnet", reasoning: "medium" });
  assert.deepEqual(resolveChatProfile("deep", "claude", {}, classes), { model: "opus", reasoning: "high" });
  // A class binding for one provider never reaches another.
  assert.deepEqual(resolveChatProfile("deep", "grok", {}, classes), { reasoning: "high" });
  // The advanced per-lane override (chat_profile_bindings) outranks the class binding.
  const lanes = { claude: { deep: { model: "fable" }, coach: { reasoning: "high" } } };
  assert.deepEqual(resolveChatProfile("deep", "claude", lanes, classes), { model: "fable", reasoning: "high" });
  // A reasoning-only lane override keeps the class model.
  assert.deepEqual(resolveChatProfile("coach", "claude", lanes, classes), { model: "sonnet", reasoning: "high" });
});

// ---------- the chat loop actually spawns with it ----------

const coachDecision = (lane) => ({ policy_version: "chat-routing-v1", lane, reason_codes: ["routine_coaching"] });

async function chatSpawnOpts(turnOverrides = {}) {
  const seen = [];
  const out = await runChatCompletion(
    7777,
    {
      id: 7777,
      agent: "claude",
      message: "how is my week going?",
      image_path: null,
      routing: coachDecision("coach"),
      ...turnOverrides,
    },
    [],
    new AbortController().signal,
    {
      supportsStream: () => true,
      runAgentStreaming: async (name, _prompt, opts) => {
        seen.push({ name, model: opts.model, reasoning: opts.reasoning });
        const raw = "===CAIRN_REPLY===\nSteady week.";
        opts.onDelta?.(raw);
        return { code: 0, raw, stderr: "", usage: {} };
      },
      executeCoachRead: () => ({ tool: "x", data: {}, rows_returned: 0, truncated: false }),
    }
  );
  assert.equal(out.agent, "claude");
  return seen[0];
}

test("chat spawns with NO --model when nothing is chosen, only the lane's effort", async () => {
  const spawn = await chatSpawnOpts();
  assert.equal(spawn.model, undefined);
  assert.equal(spawn.reasoning, "medium");
});

test("chat follows the person's class choice: coach -> Everyday, deep -> Deep work", async () => {
  repo.setSettings({ model_class_bindings: { claude: { fast: "sonnet", deep: "opus" } } });
  assert.deepEqual(await chatSpawnOpts(), { name: "claude", model: "sonnet", reasoning: "medium" });
  assert.deepEqual(await chatSpawnOpts({ routing: coachDecision("deep") }), {
    name: "claude",
    model: "opus",
    reasoning: "high",
  });
});

test("a chat_profile_bindings lane override wins over the class binding", async () => {
  repo.setSettings({
    model_class_bindings: { claude: { fast: "sonnet", deep: "opus" } },
    chat_profile_bindings: { claude: { coach: { model: "haiku" } } },
  });
  assert.deepEqual(await chatSpawnOpts(), { name: "claude", model: "haiku", reasoning: "medium" });
});

test("legacy single-profile chat takes only the everyday model, and only when chosen", async () => {
  repo.setSettings({ chat_routing_mode: "single" });
  assert.deepEqual(await chatSpawnOpts({ routing: null }), { name: "claude", model: undefined, reasoning: undefined });
  repo.setSettings({ model_class_bindings: { claude: { fast: "sonnet", deep: "opus" } } });
  assert.deepEqual(await chatSpawnOpts({ routing: null }), { name: "claude", model: "sonnet", reasoning: undefined });
});

// ---------- what Settings is offered ----------

test("agents expose curated model_choices (aliases) for the Everyday / Deep work selects", () => {
  const claude = listAgents().find((a) => a.name === "claude");
  assert.deepEqual(claude.model_choices, ["sonnet", "opus", "fable", "haiku"]);
  for (const name of ["codex", "antigravity", "grok", "stub"]) {
    assert.deepEqual(listAgents().find((a) => a.name === name).model_choices, [], `${name}: live catalog only`);
  }
  const config = repo.getAgentConfig().find((a) => a.name === "claude");
  assert.deepEqual(config.model_choices, ["sonnet", "opus", "fable", "haiku"]);
  assert.equal(listAgents().find((a) => a.name === "codex").models_list, true, "codex now lists its catalog");
});

test("parseModelsOutput reads codex's JSON catalog, keeping only listed slugs", () => {
  const json = JSON.stringify({
    models: [
      { slug: "gpt-6-sol", visibility: "list" },
      { slug: "gpt-5.6-terra", visibility: "list" },
      { slug: "codex-auto-review", visibility: "hide" },
      { slug: "gpt-6-sol", visibility: "list" },
      { display_name: "no slug" },
    ],
  });
  const raw = `${json}\nWARNING: proceeding, even though we could not create PATH aliases: Operation not permitted (os error 1)`;
  assert.deepEqual(parseModelsOutput(raw, "codex_json"), ["gpt-6-sol", "gpt-5.6-terra"]);
  assert.deepEqual(parseModelsOutput("error: unrecognized subcommand 'models'", "codex_json"), []);
  assert.deepEqual(parseModelsOutput("", "codex_json"), []);
});

test("parseModelsOutput drops CLI log noise so it never becomes a dropdown entry", () => {
  const raw = [
    "You are logged in with grok.com.",
    "Default model: grok-4.7",
    "Available models:",
    "  * grok-4.7 (default)",
    "  - grok-4.7-build-fast",
    "\u001b[2m2026-10-08T12:21:36.244735Z\u001b[0m \u001b[31mERROR\u001b[0m export failed",
    "I1008 08:21:36.531977      25 server.go:1625] Starting language server process with pid 9123",
    "E1008 08:21:36.555938     105 errorreport.go:224] error getting token source",
    "ERROR: logging before google.Init: failed",
    "WARNING: something",
  ].join("\n");
  assert.deepEqual(parseModelsOutput(raw), ["grok-4.7", "grok-4.7-build-fast"]);
});

test("the live catalog is read without blocking, cached, and re-read after the CLI changes", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-model-catalog-"));
  try {
    const listFile = path.join(dir, "models.txt");
    fs.writeFileSync(listFile, "model-a\nmodel-b\n");
    const config = {
      fake: {
        command: process.execPath,
        args: ["{model_args}", "-p", "{prompt}"],
        models_list: ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(listFile)}, 'utf8'))`],
        model_flag: ["--model", "{model}"],
        capabilities: { model: true, reasoning: [] },
      },
    };
    const configPath = path.join(dir, "agents.json");
    fs.writeFileSync(configPath, JSON.stringify(config));
    const agentsUrl = pathToFileURL(path.join(root, "dist", "agents.js")).href;
    const runner = [
      `import { listAgentModelsAsync, cachedAgentModels, invalidateAgentConfigured } from ${JSON.stringify(agentsUrl)};`,
      `import fs from "node:fs";`,
      "const out = {};",
      "out.before = cachedAgentModels('fake');",
      "const [one, two] = await Promise.all([listAgentModelsAsync('fake'), listAgentModelsAsync('fake')]);",
      "out.first = one; out.shared = two;",
      `fs.writeFileSync(${JSON.stringify(listFile)}, "model-c\\n");`,
      "out.cached = await listAgentModelsAsync('fake');",
      "invalidateAgentConfigured('fake');",
      "out.afterUpdate = await listAgentModelsAsync('fake');",
      "out.peek = cachedAgentModels('fake');",
      "process.stdout.write('__CATALOG__' + JSON.stringify(out));",
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", runner], {
      cwd: root,
      env: { ...process.env, AGENTS_CONFIG: configPath, DATA_DIR: dir, DB_PATH: path.join(dir, "cairn.db") },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout.slice(res.stdout.lastIndexOf("__CATALOG__") + "__CATALOG__".length));
    assert.equal(out.before, null, "nothing is read until asked");
    assert.deepEqual(out.first, ["model-a", "model-b"]);
    assert.deepEqual(out.shared, ["model-a", "model-b"]);
    assert.deepEqual(out.cached, ["model-a", "model-b"], "cached until the CLI changes");
    assert.deepEqual(out.afterUpdate, ["model-c"], "an install/update/sign-in drops the cache");
    assert.deepEqual(out.peek, ["model-c"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
