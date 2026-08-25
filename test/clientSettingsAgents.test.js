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

function loadSettingsAgents() {
  const context = {
    Array,
    Object,
    Set,
    String,
    escHtml,
    escAttr,
    CairnSettingsClient: {
      agentChipState(agent) {
        if (agent.present === false) return { cls: "agent-chip-absent", label: "Not installed" };
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
  return context.CairnSettingsAgents;
}

test("settings agents slice renders route summary, strategy, and timezone-aware weekly review cadence", () => {
  const settingsAgents = loadSettingsAgents();
  const html = settingsAgents.agentsSliceHtml({
    agentStrategy: "priority",
    routeSummary: "Route <tasks> to agents · 2 pinned",
    routeRowsHtml: `<div data-route="chat">Claude</div>`,
    agentHealthHtml: `<div class="agenthealth">health</div>`,
    agentActivityHtml: `<div class="agentactivity">activity</div>`,
    noticedHtml: `<div class="noticed">noticed</div>`,
    coachDay: 2,
    coachHour: 14,
    timeZone: "America/New_York",
    dayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  });

  assert.match(html, /Selection strategy/);
  assert.match(html, /value="priority" selected/);
  assert.match(html, /Route &lt;tasks&gt; to agents · 2 pinned/);
  assert.match(html, /data-route="chat"/);
  assert.match(html, /agenthealth/);
  assert.match(html, /agentactivity/);
  assert.match(html, /noticed/);
  assert.doesNotMatch(html, /coachEnabled|Draft a proposal automatically/);
  assert.match(html, /Weekly review cadence/);
  assert.match(html, /America\/New_York/);
  assert.match(html, /value="2" selected>Tue/);
  assert.match(html, /value="14" selected>14:00/);
});

test("adaptive chat profiles escape provider/model values and honor declared reasoning capabilities", () => {
  const settingsAgents = loadSettingsAgents();
  const html = settingsAgents.agentsSliceHtml({
    agentStrategy: "round_robin",
    routeSummary: "Route tasks to agents",
    routeRowsHtml: "",
    agentHealthHtml: "",
    agentActivityHtml: "",
    noticedHtml: "",
    coachDay: 1,
    coachHour: 8,
    timeZone: "UTC",
    dayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    chatRoutingMode: "adaptive",
    chatProfileBindings: { '<provider>': { capture: { model: 'tiny <model>', reasoning: "low" } } },
    chatProfileAgents: [{ name: "<provider>", capabilities: { model: true, reasoning: ["low", "high"] } }],
  });

  assert.match(html, /Adaptive · recommended/);
  assert.match(html, /Routine capture uses low reasoning/);
  assert.match(html, /&lt;provider&gt;/);
  assert.match(html, /value="tiny &lt;model&gt;"/);
  assert.match(html, /value="low" selected/);
  assert.match(html, /value="high"/);
  assert.doesNotMatch(html, /value="medium"/);

  const defaults = settingsAgents.agentsSliceHtml({
    agentStrategy: "round_robin", routeSummary: "Route tasks", routeRowsHtml: "", agentHealthHtml: "", agentActivityHtml: "", noticedHtml: "",
    coachDay: 1, coachHour: 8, timeZone: "UTC", dayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    chatRoutingMode: "adaptive", chatProfileBindings: {},
    chatProfileAgents: [{ name: "Provider", capabilities: { model: true, reasoning: ["low", "medium", "high"] } }],
  });
  assert.match(defaults, /value="low" selected/);
  assert.match(defaults, /value="medium" selected/);
  assert.match(defaults, /value="high" selected/);
});

test("single profile copy keeps saved bindings visibly inactive", () => {
  const settingsAgents = loadSettingsAgents();
  const html = settingsAgents.agentsSliceHtml({
    agentStrategy: "round_robin", routeSummary: "Route tasks", routeRowsHtml: "", agentHealthHtml: "", agentActivityHtml: "", noticedHtml: "",
    coachDay: 1, coachHour: 8, timeZone: "UTC", dayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    chatRoutingMode: "single", chatProfileBindings: {}, chatProfileAgents: [],
  });
  assert.match(html, /Single profile · legacy/);
  assert.match(html, /Saved profiles stay ready, but are inactive/);
});

test("settings agent list renders escaped cards with state, controls, details, and models", () => {
  const settingsAgents = loadSettingsAgents();
  const html = settingsAgents.agentListHtml({
    order: ["Claude <main>", "Gemini"],
    disabled: new Set(["Gemini"]),
    meta: {
      "Claude <main>": { name: "Claude <main>", description: "fast <coach>", configured: true, can_login: true, models_list: true },
      Gemini: { name: "Gemini", description: "fallback", configured: false, can_login: true, models_list: true },
    },
    agentInfo: {
      "Claude <main>": { version: "1.2.3", model_current: "sonnet <4>", update_available: true },
    },
    agentModels: {
      "Claude <main>": ["sonnet <4>", "opus"],
      Gemini: [],
    },
    stagger: (index) => `--d:${index * 20}ms`,
  });

  assert.match(html, /agent-card reveal/);
  assert.match(html, /Claude &lt;main&gt;/);
  assert.match(html, /fast &lt;coach&gt;/);
  assert.match(html, /agent-chip-ok/);
  assert.match(html, /data-connect="Claude &lt;main&gt;"/);
  assert.match(html, /CLI v1\.2\.3 · model: sonnet &lt;4&gt; · <span class="agent-upd">update available<\/span>/);
  assert.match(html, /<li>sonnet &lt;4&gt;<\/li>/);
  assert.match(html, /agent-card off/);
  assert.match(html, /data-toggle="Gemini"[^>]*>OFF/);
  assert.match(html, /Not in rotation until connected — tap Connect/);
  assert.match(html, /No models reported/);
  assert.match(html, /data-up="Claude &lt;main&gt;" disabled/);
  assert.match(html, /data-down="Gemini" disabled/);
});

test("the Agents slice keeps login/toggle affordances outside the collapsed operator fold", () => {
  const settingsAgents = loadSettingsAgents();
  const html = settingsAgents.agentsSliceHtml({
    agentStrategy: "priority",
    routeSummary: "Route tasks to agents · 2 pinned",
    routeRowsHtml: `<div data-route="chat">Claude</div>`,
    agentHealthHtml: `<div class="agenthealth">health</div>`,
    agentActivityHtml: `<div class="agentactivity">activity</div>`,
    noticedHtml: `<div class="noticed">noticed</div>`,
    coachDay: 2,
    coachHour: 14,
    timeZone: "America/New_York",
    dayNames: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    chatRoutingMode: "adaptive",
    chatProfileBindings: {},
    chatProfileAgents: [],
  });

  // Collapsed by default: exactly one top-level fold, unopened.
  assert.match(html, /<details class="route-card" style="margin-top:18px">/);
  assert.doesNotMatch(html, /<details class="route-card" style="margin-top:18px" open>/);
  assert.match(html, /Under the hood/);

  const foldStart = html.indexOf("Under the hood");
  assert.ok(foldStart > -1, "fold summary present");

  // Essential, always-visible controls (login/connect/order/enable state, plus the
  // agent-facing insight card and the weekly review schedule) sit BEFORE the fold.
  const agentListIndex = html.indexOf('id="agentlist"');
  const noticedIndex = html.indexOf("noticed");
  const weeklyIndex = html.indexOf("Weekly review cadence");
  assert.ok(agentListIndex > -1 && agentListIndex < foldStart, "#agentlist stays above the fold");
  assert.ok(noticedIndex > -1 && noticedIndex < foldStart, "the noticed card stays above the fold");
  assert.ok(weeklyIndex > -1 && weeklyIndex < foldStart, "weekly review cadence stays above the fold");

  // Operator content — selection strategy, adaptive chat, CLI install stream, health &
  // activity cards (incl. brain diagnostics), route pinning, and per-lane model pins —
  // all move inside the fold.
  const stratIndex = html.indexOf('id="strat"');
  const chatModeIndex = html.indexOf('id="chatRoutingMode"');
  const cliStatusIndex = html.indexOf('id="agentCliUpdateStatus"');
  const cliLogIndex = html.indexOf('id="agentCliUpdateLog"');
  const healthIndex = html.indexOf("agenthealth");
  const activityIndex = html.indexOf("agentactivity");
  const routeSummaryIndex = html.indexOf("Route tasks to agents");
  const modelProfilesIndex = html.indexOf("Advanced model profiles");
  for (const index of [stratIndex, chatModeIndex, cliStatusIndex, cliLogIndex, healthIndex, activityIndex, routeSummaryIndex, modelProfilesIndex]) {
    assert.ok(index > foldStart, `operator control at ${index} is inside the fold (fold starts at ${foldStart})`);
  }
});

test("an uninstalled provider is always Off and cannot be enabled before install", () => {
  const settingsAgents = loadSettingsAgents();
  const html = settingsAgents.agentListHtml({
    order: ["antigravity"],
    disabled: new Set(),
    meta: {
      antigravity: { name: "antigravity", present: false, configured: null, can_login: true, installable: true },
    },
    agentInfo: {},
    agentModels: {},
  });

  assert.match(html, /agent-card off/);
  assert.match(html, /data-toggle="antigravity" disabled aria-disabled="true">OFF/);
  assert.match(html, /data-install="antigravity">Install/);
  assert.doesNotMatch(html, /data-connect="antigravity"/);
});
