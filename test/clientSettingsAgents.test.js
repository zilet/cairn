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
  assert.match(html, /data-toggle="Gemini">OFF/);
  assert.match(html, /Not in rotation until connected — tap Connect/);
  assert.match(html, /No models reported/);
  assert.match(html, /data-up="Claude &lt;main&gt;" disabled/);
  assert.match(html, /data-down="Gemini" disabled/);
});
