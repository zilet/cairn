import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(value) {
  return escHtml(value).replace(/"/g, "&quot;");
}

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.dataset = {};
    this.disabled = false;
    this.checked = false;
    this.isConnected = true;
    this.listeners = new Map();
    this.style = {};
    this.hidden = false;
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.textContent = "";
    this.value = "";
    this.html = "";
  }

  set innerHTML(value) {
    this.html = value;
  }

  get innerHTML() {
    return this.html;
  }

  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }

  async click() {
    const handler = this.listeners.get("click");
    if (handler) await handler({ currentTarget: this });
  }

  change() {
    const handler = this.listeners.get("change");
    if (handler) handler({ currentTarget: this });
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

class FakeAgentList extends FakeElement {
  set innerHTML(value) {
    this.html = value;
    this.buttons = [];
    const buttonRe = /<button[^>]+data-(toggle|up|down|connect|detail|models|install)="([^"]*)"/g;
    for (let match = buttonRe.exec(value); match; match = buttonRe.exec(value)) {
      const button = new FakeElement();
      button.dataset[match[1]] = match[2];
      this.buttons.push(button);
    }
  }

  get innerHTML() {
    return this.html;
  }

  querySelectorAll(selector) {
    const key = selector.match(/\[data-([^\]]+)\]/)?.[1];
    return key ? this.buttons.filter((button) => button.dataset[key] !== undefined) : [];
  }

  button(key, value) {
    const button = this.buttons.find((candidate) => candidate.dataset[key] === value);
    assert.ok(button, `expected [data-${key}="${value}"]`);
    return button;
  }
}

class FakeRoot extends FakeElement {
  set innerHTML(value) {
    this.html = value;
    this.children = new Map();
    this.routeSelects = [];

    for (const id of ["strat", "chatRoutingMode", "coachDay", "coachHour", "agentCliUpdateStatus", "agentCliUpdateLog"]) {
      this.children.set(`#${id}`, new FakeElement(id));
    }
    this.children.set("#agentlist", new FakeAgentList("agentlist"));

    const routeRe = /<select[^>]+data-route="([^"]*)"/g;
    for (let match = routeRe.exec(value); match; match = routeRe.exec(value)) {
      const select = new FakeElement();
      select.dataset.route = match[1];
      this.routeSelects.push(select);
    }
  }

  get innerHTML() {
    return this.html;
  }

  querySelector(selector) {
    return this.children.get(selector) || null;
  }

  querySelectorAll(selector) {
    if (selector === "[data-route]") return this.routeSelects;
    return [];
  }
}

function loadSettingsAgentsController() {
  const context = {
    Object,
    Array,
    Set,
    String,
    Date,
    encodeURIComponent,
    escHtml,
    escAttr,
    CairnSettingsClient: {
      agentChipState(agent) {
        if (agent.configured === true) return { cls: "agent-chip-ok", label: "Connected" };
        if (agent.configured === false) return { cls: "agent-chip-connect", label: "Connect" };
        return { cls: "agent-chip-installed", label: "Installed" };
      },
      agentAvailabilityNote(agent) {
        const availability = agent.availability || null;
        return availability ? `${availability.detail}. Cairn routes around it until then.` : "";
      },
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-agents-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-agents-controller.js"), "utf8"), context);
  return context.CairnSettingsAgentsController;
}

function makeDeps(overrides = {}) {
  const rootEl = new FakeRoot("root");
  const wm = {
    agent_strategy: "round_robin",
    order: ["claude", "codex"],
    disabled: new Set(["codex"]),
    routes: { chat: "missing", meal_plan: "claude" },
    chat_routing_mode: "adaptive",
    chat_profile_bindings: { hidden: { deep: { model: "keep" } } },
    coach_day: 1,
    coach_hour: 8,
    time_zone: "America/New_York",
  };
  const agentInfo = {};
  const agentModels = {};
  const calls = [];
  let dirty = 0;
  let connected = "";
  const toasts = [];
  let cliGets = 0;

  const deps = {
    root: rootEl,
    workingModel: wm,
    meta: {
      claude: { name: "claude", enabled: true, present: true, configured: true, usable: true, can_login: true, models_list: true, installable: true, capabilities: { model: true, reasoning: ["low", "medium", "high"] } },
      codex: { name: "codex", enabled: true, present: false, configured: null, can_login: true, models_list: false, installable: true },
    },
    routeTasks: [["chat", "Chat"], ["meal_plan", "Meal plan"]],
    agentInfo,
    agentModels,
    agentHealthHtml: "",
    agentActivityHtml: "",
    noticedHtml: "",
    dayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    api: async (path, opts = {}) => {
      calls.push([path, opts.method || "GET"]);
      if (path === "/agent-clis/update") {
        cliGets += 1;
        return cliGets === 1
          ? { status: "idle", agents: [] }
          : { status: "succeeded", agents: ["codex"], finished_at: "2026-07-01T10:30:00Z", stdout_tail: "ok: codex -> 1.2.3\n" };
      }
      if (path === "/agent-clis/codex/install" && opts.method === "POST") return { status: "running", agents: ["codex"] };
      if (path === "/agents") return [
        deps.meta.claude,
        { ...deps.meta.codex, present: true, configured: false },
      ];
      if (path === "/agents/claude/info") return { ok: true, version: "1.2.3", model_current: "sonnet", update_available: true };
      if (path === "/agents/claude/models") return { ok: true, models: ["sonnet", "opus"] };
      return { ok: true };
    },
    toast: (message) => toasts.push(message),
    sleep: async () => {},
    stagger: (index) => `--d:${index}ms`,
    markDirty: () => { dirty += 1; },
    pruneRoutes(routes, routeTasks, enabledAgents) {
      const taskKeys = new Set(routeTasks.map(([key]) => key));
      const agentNames = new Set(enabledAgents.map((agent) => agent.name));
      return Object.fromEntries(Object.entries(routes).filter(([task, agent]) => taskKeys.has(task) && agentNames.has(agent)));
    },
    routeRowsHtml(routeTasks, _enabledAgents, routes) {
      return routeTasks.map(([key]) => `<select data-route="${escAttr(key)}"><option value="${escAttr(routes[key] || "")}"></option></select>`).join("");
    },
    openAgentLoginModal: () => (agentName) => { connected = agentName; },
    ...overrides,
  };
  return {
    deps,
    get dirty() { return dirty; },
    get connected() { return connected; },
    calls,
    toasts,
  };
}

test("settings agents controller owns route pins and agent card actions", async () => {
  const controller = loadSettingsAgentsController();
  const harness = makeDeps();
  const { deps } = harness;

  controller.render(deps);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(deps.workingModel.routes, { meal_plan: "claude" });
  assert.match(deps.root.innerHTML, /1 pinned/);

  const strat = deps.root.querySelector("#strat");
  strat.value = "priority";
  strat.change();
  assert.equal(deps.workingModel.agent_strategy, "priority");

  const chatMode = deps.root.querySelector("#chatRoutingMode");
  chatMode.value = "single";
  chatMode.change();
  assert.equal(deps.workingModel.chat_routing_mode, "single");
  assert.deepEqual(deps.workingModel.chat_profile_bindings.hidden, { deep: { model: "keep" } });

  const route = deps.root.routeSelects.find((select) => select.dataset.route === "chat");
  route.value = "claude";
  route.change();
  assert.equal(deps.workingModel.routes.chat, "claude");
  route.value = "";
  route.change();
  assert.equal(deps.workingModel.routes.chat, undefined);

  const list = deps.root.querySelector("#agentlist");
  await list.button("toggle", "codex").click();
  assert.equal(deps.workingModel.disabled.has("codex"), false);
  assert.equal(harness.dirty, 2);

  await list.button("up", "codex").click();
  assert.deepEqual(deps.workingModel.order, ["codex", "claude"]);
  assert.equal(harness.dirty, 3);

  await list.button("connect", "claude").click();
  assert.equal(harness.connected, "claude");

  await list.button("detail", "claude").click();
  assert.equal(deps.agentInfo.claude.version, "1.2.3");
  assert.equal(deps.agentInfo.claude.model_current, "sonnet");
  assert.equal(deps.agentInfo.claude.update_available, true);

  await list.button("models", "claude").click();
  assert.deepEqual([...deps.agentModels.claude], ["sonnet", "opus"]);
  await list.button("models", "claude").click();
  assert.equal(deps.agentModels.claude, undefined);
});

test("settings agents controller owns per-agent lazy install polling", async () => {
  const controller = loadSettingsAgentsController();
  const harness = makeDeps();
  const { deps } = harness;

  controller.render(deps);
  await Promise.resolve();
  await Promise.resolve();

  const list = deps.root.querySelector("#agentlist");
  await list.button("install", "codex").click();

  assert.deepEqual(harness.calls.filter(([path]) => path.startsWith("/agent-clis") || path === "/agents"), [
    ["/agent-clis/update", "GET"],
    ["/agent-clis/codex/install", "POST"],
    ["/agent-clis/update", "GET"],
    ["/agents", "GET"],
  ]);
  assert.equal(deps.root.querySelector("#agentCliUpdateStatus").textContent, "codex ready · 2026-07-01 10:30");
  assert.equal(deps.root.querySelector("#agentCliUpdateLog").textContent, "ok: codex -> 1.2.3");
  assert.equal(deps.root.querySelector("#agentCliUpdateLog").hidden, false);
  assert.equal(deps.meta.codex.present, true);
  assert.deepEqual(harness.toasts, ["codex is ready to connect"]);
});
