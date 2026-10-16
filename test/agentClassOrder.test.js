// Tier-aware ("smart") model and agent selection, all of it opt-in:
//   - model_class_bindings[provider].coach: chat's coach lane MODEL only, falling back to
//     that provider's `fast` binding, so nothing changes for anyone who never sets it.
//   - agent_class_order { fast?, deep? }: the agents tried FIRST for an op of that model
//     class, never exclusive — the strategy order stays the fallthrough tail; an
//     agent_routes pin still wins; accuracy tasks keep their claude -> codex floor.
//   - agy refuses an effort-suffixed model name beside --effort, so such a name runs alone.
// Offline: cfg-injected orders, pure resolvers and runChatCompletion's injected runner.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { db, repo, resetTables } from "./_seed.js";
import {
  CHAT_LANE_MODEL_CLASS,
  chatLaneBindingClass,
  classBoundChatModel,
  resolveChatProfile,
} from "../dist/chatRouting.js";
import { buildAgentLaunch, loadAgents, resolveAgentExecutionProfile } from "../dist/agents.js";
import { buildChatProviderOrder, runChatCompletion } from "../dist/chatTurns.js";

beforeEach(() => {
  resetTables("chat_turns", "chat_messages");
  db.prepare("DELETE FROM settings WHERE id = 1").run();
  repo.setSettings({ enrich_enabled: false, chat_routing_mode: "adaptive" });
});

// ---------- 1. the coach model class ----------

test("the coach lane reads its own `coach` binding, else the provider's fast one; other lanes never read it", () => {
  assert.equal(chatLaneBindingClass("coach"), "coach");
  assert.equal(chatLaneBindingClass("capture"), "fast");
  assert.equal(chatLaneBindingClass("deep"), "deep");
  // The agent-order class is unchanged: coach is everyday work.
  assert.deepEqual(CHAT_LANE_MODEL_CLASS, { capture: "fast", coach: "fast", deep: "deep" });

  const fastOnly = { claude: { fast: "sonnet", deep: "opus" } };
  assert.equal(classBoundChatModel("claude", "coach", fastOnly), "sonnet", "unbound coach falls back to fast");
  assert.deepEqual(resolveChatProfile("coach", "claude", {}, fastOnly), { model: "sonnet", reasoning: "medium" });

  const withCoach = { claude: { fast: "sonnet", coach: "opus", deep: "opus" } };
  assert.deepEqual(resolveChatProfile("coach", "claude", {}, withCoach), { model: "opus", reasoning: "medium" });
  assert.deepEqual(resolveChatProfile("capture", "claude", {}, withCoach), { model: "sonnet", reasoning: "low" });
  assert.deepEqual(resolveChatProfile("deep", "claude", {}, withCoach), { model: "opus", reasoning: "high" });
  // A coach binding alone (no fast) reaches only the coach lane.
  const coachOnly = { claude: { coach: "opus" } };
  assert.deepEqual(resolveChatProfile("coach", "claude", {}, coachOnly), { model: "opus", reasoning: "medium" });
  assert.deepEqual(resolveChatProfile("capture", "claude", {}, coachOnly), { reasoning: "low" });
  assert.equal(classBoundChatModel("claude", "fast", coachOnly), undefined);
  // No bindings at all: the CLI default, exactly as before.
  assert.deepEqual(resolveChatProfile("coach", "claude", {}, {}), { reasoning: "medium" });
  // The per-lane advanced override still outranks it.
  assert.deepEqual(resolveChatProfile("coach", "claude", { claude: { coach: { model: "haiku" } } }, withCoach), {
    model: "haiku",
    reasoning: "medium",
  });
});

test("a coach binding saves, survives an unrelated save and a UI-shaped resave, and never reaches an op", () => {
  repo.setSettings({ model_class_bindings: { claude: { fast: "sonnet", coach: "opus", turbo: "x" }, nope: { coach: "y" } } });
  assert.deepEqual(repo.getSettings().model_class_bindings, { claude: { fast: "sonnet", coach: "opus" } });
  repo.setSettings({ art_enabled: false });
  assert.deepEqual(repo.getSettings().model_class_bindings, { claude: { fast: "sonnet", coach: "opus" } });
  // The Settings screen re-sends the whole working model it was handed (GET -> PUT).
  repo.setSettings({ agent_strategy: "priority", model_class_bindings: repo.getSettings().model_class_bindings });
  assert.deepEqual(repo.getSettings().model_class_bindings, { claude: { fast: "sonnet", coach: "opus" } });
  // Ops resolve by their own class (fast|deep) only: coach is chat's alone.
  const insight = repo.resolveTaskExecutionProfile("insight", "claude", {
    bindings: {},
    classBindings: { claude: { coach: "opus" } },
    risk: null,
  });
  assert.equal(insight.model, undefined);
});

test("chat's coach lane spawns on the coach model; capture stays on fast", async () => {
  repo.setSettings({ model_class_bindings: { claude: { fast: "sonnet", coach: "opus", deep: "opus" } } });
  const spawnFor = async (lane) => {
    const seen = [];
    await runChatCompletion(
      7778,
      {
        id: 7778,
        agent: "claude",
        message: "how is my week going?",
        image_path: null,
        routing: { policy_version: "chat-routing-v1", lane, reason_codes: ["routine_coaching"] },
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
    return seen[0];
  };
  assert.deepEqual(await spawnFor("coach"), { name: "claude", model: "opus", reasoning: "medium" });
  // capture is a receipt: it stays on the everyday model at low effort
  assert.deepEqual(await spawnFor("capture"), { name: "claude", model: "sonnet", reasoning: "low" });
});

// ---------- 2. the class-aware agent order ----------

const ALL = ["claude", "grok", "antigravity", "codex"];

test("no class order: every task's order is exactly the policy order (byte-for-byte default)", () => {
  for (const task of [...repo.ROUTABLE_TASKS, ...repo.PROFILE_TASKS]) {
    const order = repo.pickAgentOrderForTask(task, { enabled: ["grok", "antigravity", "codex", "claude"], routes: {} });
    const accuracy = repo.TASK_POLICY[task] === "accuracy";
    assert.deepEqual(
      order,
      accuracy ? ["claude", "codex", "grok", "antigravity"] : ["grok", "antigravity", "codex", "claude"],
      task
    );
    // An explicit empty class order is the same thing.
    assert.deepEqual(
      repo.pickAgentOrderForTask(task, { enabled: ["grok", "antigravity", "codex", "claude"], routes: {}, classOrder: {} }),
      order,
      task
    );
  }
});

test("a rotation task tries its class's agents first, then every other agent as the fallthrough tail", () => {
  const classOrder = { fast: ["antigravity"], deep: ["claude", "antigravity"] };
  // insight / day_read / enrich run at fast.
  for (const task of ["insight", "day_read", "enrich", "week_ahead"]) {
    assert.deepEqual(repo.pickAgentOrderForTask(task, { enabled: ALL, routes: {}, classOrder }), [
      "antigravity",
      "claude",
      "grok",
      "codex",
    ]);
  }
  // session_suggest / meal_plan / proposal (incl. evolve_program's class) run at deep.
  for (const task of ["session_suggest", "meal_plan", "proposal", "session_verify"]) {
    assert.deepEqual(repo.pickAgentOrderForTask(task, { enabled: ["grok", "antigravity", "codex", "claude"], routes: {}, classOrder }), [
      "claude",
      "antigravity",
      "grok",
      "codex",
    ]);
  }
  // An op with no profile (chat, an unknown op) has no class: the plain order.
  assert.deepEqual(repo.pickAgentOrderForTask("chat", { enabled: ALL, routes: {}, classOrder }), ALL);
  assert.deepEqual(repo.pickAgentOrderForTask("made_up", { enabled: ALL, routes: {}, classOrder }), ALL);
});

test("a preferred agent that is dead, disabled or signed out is skipped, never a hard failure", () => {
  const classOrder = { fast: ["codex", "antigravity"] };
  // codex is not usable: the order starts at the next preferred agent, the rest follow.
  assert.deepEqual(repo.pickAgentOrderForTask("insight", { enabled: ["claude", "antigravity", "grok"], routes: {}, classOrder }), [
    "antigravity",
    "claude",
    "grok",
  ]);
  // None of the preferred agents is usable: the plain order, not an empty one.
  assert.deepEqual(repo.pickAgentOrderForTask("insight", { enabled: ["claude", "grok"], routes: {}, classOrder }), ["claude", "grok"]);
  assert.deepEqual(repo.pickAgentOrderForTask("insight", { enabled: [], routes: {}, classOrder }), []);
});

test("an agent_routes pin still wins: exclusive for a rotation task", () => {
  const classOrder = { fast: ["antigravity"], deep: ["antigravity"] };
  assert.deepEqual(repo.pickAgentOrderForTask("insight", { enabled: ALL, routes: { insight: "grok" }, classOrder }), ["grok"]);
  assert.deepEqual(repo.pickAgentOrderForTask("session_suggest", { enabled: ALL, routes: { session_suggest: "codex" }, classOrder }), [
    "codex",
  ]);
  // A pin to an unusable agent falls back to the class-ordered rotation.
  assert.deepEqual(repo.pickAgentOrderForTask("insight", { enabled: ["claude", "antigravity"], routes: { insight: "grok" }, classOrder }), [
    "antigravity",
    "claude",
  ]);
});

test("accuracy tasks keep claude -> codex as the floor; a deep class order reorders only the tail", () => {
  const classOrder = { deep: ["antigravity", "claude"], fast: ["grok"] };
  const enabled = ["grok", "antigravity", "codex", "claude"];
  for (const task of ["health", "health_review", "health_synthesis", "brain_review"]) {
    assert.deepEqual(repo.pickAgentOrderForTask(task, { enabled, routes: {}, classOrder }), [
      "claude",
      "codex",
      "antigravity",
      "grok",
    ]);
    // A pin leads, the floor follows, the class-ordered tail after it.
    assert.deepEqual(repo.pickAgentOrderForTask(task, { enabled, routes: { [task]: "grok" }, classOrder }), [
      "grok",
      "claude",
      "codex",
      "antigravity",
    ]);
  }
  // With neither floor agent usable the class order shapes the whole list.
  assert.deepEqual(repo.pickAgentOrderForTask("health_review", { enabled: ["grok", "antigravity"], routes: {}, classOrder }), [
    "antigravity",
    "grok",
  ]);
});

test("agent_class_order is validated, persisted, kept by an unrelated save, read by the resolver, and cleared by {}", () => {
  assert.deepEqual(repo.getSettings().agent_class_order, {}, "default: none");
  const saved = repo.setSettings({
    agent_class_order: { fast: ["antigravity", "bogus", " antigravity ", "claude"], deep: ["claude"], coach: ["grok"], junk: 3 },
  });
  assert.deepEqual(saved.agent_class_order, { fast: ["antigravity", "claude"], deep: ["claude"] });
  repo.setSettings({ art_enabled: false, model_class_bindings: {} });
  assert.deepEqual(repo.getSettings().agent_class_order, { fast: ["antigravity", "claude"], deep: ["claude"] });
  // The resolver reads the stored order when the caller injects none.
  assert.deepEqual(repo.pickAgentOrderForTask("insight", { enabled: ["grok", "claude", "antigravity"], routes: {} }), [
    "antigravity",
    "claude",
    "grok",
  ]);
  // A malformed stored value reads as no order rather than breaking selection.
  db.prepare("UPDATE settings SET agent_class_order = ? WHERE id = 1").run("{not json");
  assert.deepEqual(repo.getSettings().agent_class_order, {});
  repo.setSettings({ agent_class_order: { fast: ["claude"] } });
  repo.setSettings({ agent_class_order: {} });
  assert.deepEqual(repo.getSettings().agent_class_order, {});
});

test("chat's provider order follows the lane's class order; a selected provider still leads", () => {
  const auto = ["claude", "grok", "antigravity"];
  assert.deepEqual(buildChatProviderOrder(null, auto, { classFirst: ["antigravity"] }), ["antigravity", "claude", "grok"]);
  assert.deepEqual(buildChatProviderOrder("auto", auto, { classFirst: ["codex", "antigravity"] }), [
    "antigravity",
    "claude",
    "grok",
  ]);
  assert.deepEqual(buildChatProviderOrder("grok", auto, { classFirst: ["antigravity"] }), ["grok", "antigravity", "claude"]);
  // Absent or empty: unchanged.
  assert.deepEqual(buildChatProviderOrder(null, auto, {}), auto);
  assert.deepEqual(buildChatProviderOrder(null, auto, { classFirst: [] }), auto);
  // A current-research turn still starts on a web-capable provider.
  const definitions = { claude: { web_access: true } };
  assert.deepEqual(buildChatProviderOrder(null, auto, { classFirst: ["antigravity"], preferWeb: true, definitions }), [
    "claude",
    "antigravity",
    "grok",
  ]);
});

// ---------- 3. agy: an effort-suffixed model never travels with --effort ----------

test("agy passes an alias with --effort, and an effort-suffixed name WITHOUT it", () => {
  const agy = loadAgents().antigravity;
  const plain = resolveAgentExecutionProfile(agy, { model: "gemini-4-argon", reasoning: "medium" });
  assert.deepEqual(plain.effective, { model: "gemini-4-argon", reasoning: "medium" });
  const suffixed = resolveAgentExecutionProfile(agy, { model: "gemini-4-argon-low", reasoning: "high" });
  assert.deepEqual(suffixed.effective, { model: "gemini-4-argon-low" });
  assert.match(suffixed.adjustments.join(" "), /names its own effort/);

  const argv = (model, reasoning) => buildAgentLaunch(agy, agy.args, "hello", { model, reasoning }).args;
  const flash = argv("gemini-3.8-flash", "low");
  assert.deepEqual(flash.slice(flash.indexOf("--model"), flash.indexOf("--model") + 4), [
    "--model",
    "gemini-3.8-flash",
    "--effort",
    "low",
  ]);
  const baked = argv("gemini-4-argon-medium", "low");
  assert.ok(baked.includes("gemini-4-argon-medium"));
  assert.equal(baked.includes("--effort"), false, "never --model X-medium --effort low");

  // Other CLIs keep their effort whatever the model is called.
  const claude = loadAgents().claude;
  assert.deepEqual(resolveAgentExecutionProfile(claude, { model: "my-model-high", reasoning: "low" }).effective, {
    model: "my-model-high",
    reasoning: "low",
  });
});
