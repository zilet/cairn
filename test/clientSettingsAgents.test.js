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
      agentQuotaNote(agent) {
        const quota = Array.isArray(agent.quota) ? agent.quota : [];
        return quota.length ? `Gemini · week ${Math.round(quota[0].remaining_fraction * 100)}% left` : "";
      },
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-agent-models.js"), "utf8"), context);
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
      "Claude <main>": {
        name: "Claude <main>",
        description: "fast <coach>",
        configured: true,
        can_login: true,
        models_list: true,
        quota: [{ group: "Gemini <Models>", window: "weekly", remaining_fraction: 0.956, reset_time: null }],
      },
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
  // The provider-reported usage line rides under a CONNECTED card only.
  assert.match(html, /<div class="agent-card-note">Gemini · week 96% left<\/div>/);
  assert.equal((html.match(/week 96% left/g) || []).length, 1, "a not-connected card shows no usage line");
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

// v2 wave 7: where the agent layer stands NOW lives here, one quiet line, not on the
// Brief. It follows the newest attempt (/agent-stats `current`), so it clears itself.
test("Settings > Agents speaks the agent layer's current state and clears itself", () => {
  const settings = loadSettingsAgents();
  const now = new Date("2026-09-29T15:00:00Z");
  const connected = [{ name: "claude", usable: true, enabled: true, configured: true }];

  const none = settings.agentStateLine({}, [{ name: "claude", usable: false }], now);
  assert.match(none, /agent-state is-none/);
  assert.match(none, /No agent is connected yet/);

  const failing = settings.agentStateLine(
    {
      current: {
        state: "failing",
        failing_since: "2026-09-29T08:30:00Z",
        last_ok_at: "2026-09-28T09:00:00Z",
        error_class: "auth_required",
      },
    },
    connected,
    now
  );
  assert.match(failing, /is-failing/);
  assert.match(failing, /needs its sign-in renewed/);
  assert.match(failing, /clears by itself after the next good run/);
  assert.doesNotMatch(failing, /✕|dismiss/i, "a state, never a notice to dismiss");

  const ok = settings.agentStateLine(
    { current: { state: "ok", failing_since: null, last_ok_at: "2026-09-29T14:00:00Z", error_class: null } },
    connected,
    now
  );
  assert.match(ok, /is-ok/);
  assert.match(ok, /Agents are answering · last good run today/);
  assert.doesNotMatch(ok, /haven't answered/);

  const escaped = settings.agentStateLine(
    { current: { state: "failing", failing_since: "<x>", error_class: "<b>" } },
    connected,
    now
  );
  assert.doesNotMatch(escaped, /<b>|<x>/);
});

test("an install in flight makes its card busy, says the server's phase, and locks the rest", () => {
  const settingsAgents = loadSettingsAgents();
  const meta = {
    claude: { name: "claude", installable: true, present: false },
    codex: { name: "codex", installable: true, present: true, can_login: true },
  };
  const base = { order: ["claude", "codex"], disabled: new Set(), meta, agentInfo: {}, agentModels: {} };
  const cli = { status: "running", action: "install", agents: ["claude"], phase: "downloading", elapsed_sec: 40, seen_at: 1_000 };
  const html = settingsAgents.agentListHtml({ ...base, cli, now: 3_000 });
  assert.match(html, /aria-busy="true"[^>]*>Installing…|Installing…/);
  assert.match(html, /role="status" aria-live="polite"><span class="agent-cli-phase">Downloading and installing…<\/span>/);
  assert.match(html, /data-cli-elapsed aria-hidden="true">0:42</);
  // the other card cannot start a second run or be connected-over
  const codex = html.slice(html.indexOf('data-install="codex"'));
  assert.match(codex, /data-install="codex" disabled/);
  assert.match(codex, /data-remove="codex" disabled/);
  // a progress re-render does not replay the entrance
  assert.doesNotMatch(settingsAgents.agentListHtml({ ...base, cli, now: 3_000, reveal: false }), /agent-card[^"]* reveal/);
});

test("a remove in flight and a failed install read from the same card state", () => {
  const settingsAgents = loadSettingsAgents();
  assert.deepEqual(
    JSON.parse(JSON.stringify(settingsAgents.cliCardState({ status: "running", action: "remove", agents: ["grok"], elapsed_sec: 3, seen_at: 0 }, "grok", 1000))),
    { kind: "busy", action: "remove", phase: "removing", label: "Removing…", elapsed: "0:04" }
  );
  assert.equal(settingsAgents.cliCardState({ status: "running", action: "remove", agents: ["grok"] }, "claude", 0), null);
  const failed = settingsAgents.cliCardState(
    { status: "failed", action: "install", agents: ["claude"], failure: { reason: "disk_full", message: "The server's disk is full." } },
    "claude",
    0
  );
  assert.equal(failed.kind, "failed");
  assert.equal(failed.headline, "The server's disk is full.");
  const html = settingsAgents.agentListHtml({
    order: ["claude"], disabled: new Set(), agentInfo: {}, agentModels: {},
    meta: { claude: { name: "claude", installable: true, present: false } },
    cli: { status: "failed", action: "install", agents: ["claude"], failure: { reason: "disk_full", message: "Disk <full>" } },
  });
  assert.match(html, /agent-cli-status is-failed" role="status" aria-live="polite">Disk &lt;full&gt;</);
  assert.doesNotMatch(html, /Installing…/);
  // unknown phases fall back to starting; clock formats m:ss
  assert.equal(settingsAgents.cliCardState({ status: "running", agents: ["x"], phase: "weird" }, "x", 0).phase, "starting");
  assert.equal(settingsAgents.cliClock(125), "2:05");
});

function loadAgentModels() {
  const context = { Array, Object, String, escHtml, escAttr };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/settings-agent-models.js"), "utf8"), context);
  return context.CairnSettingsAgentModels;
}

// ---- Everyday / Deep work model (settings.model_class_bindings) ----

function modelCard(overrides = {}) {
  return {
    order: ["claude"],
    disabled: new Set(),
    meta: {
      claude: {
        name: "claude",
        present: true,
        configured: true,
        capabilities: { model: true, reasoning: ["low", "high"] },
        model_choices: ["sonnet", "opus", "fable", "haiku"],
      },
    },
    agentInfo: {},
    agentModels: {},
    ...overrides,
  };
}

test("a provider card offers Everyday and Deep work selects, CLI default first and selected by default", () => {
  const settingsAgents = loadSettingsAgents();
  const html = settingsAgents.agentListHtml(modelCard());
  assert.match(html, /<label for="agent-model-claude-fast">Everyday model<\/label>/);
  assert.match(html, /<label for="agent-model-claude-deep">Deep work model<\/label>/);
  const selects = html.match(/<select id="agent-model-claude-(fast|deep)"[^>]*>([\s\S]*?)<\/select>/g) || [];
  assert.equal(selects.length, 2);
  for (const select of selects) {
    assert.match(
      select,
      /^<select[^>]*><option value="" selected>CLI default<\/option><option value="sonnet">sonnet<\/option><option value="opus">opus<\/option><option value="fable">fable<\/option><option value="haiku">haiku<\/option><option value="__other__">Other…<\/option><\/select>$/
    );
  }
  assert.match(html, /CLI default uses whatever your plan gives you\. Pick a model only if your plan includes it\./);
  assert.match(html, /role="group" aria-label="claude models"/);
  assert.match(html, /data-model-other="fast"[^>]*hidden[^>]*aria-label="Everyday model: model name"/);
});

test("a bound class is selected; a custom id the list does not show is still offered and selected", () => {
  const settingsAgents = loadSettingsAgents();
  const html = settingsAgents.agentListHtml(
    modelCard({ modelClassBindings: { claude: { fast: "sonnet", deep: "claude-opus-x-1" } } })
  );
  assert.match(html, /<option value="sonnet" selected>sonnet<\/option>/);
  assert.match(html, /<option value="claude-opus-x-1" selected>claude-opus-x-1<\/option><option value="__other__">/);
  assert.doesNotMatch(html, /<option value="" selected>CLI default/);
});

test("the live catalog replaces the curated list once it arrives; entries are escaped", () => {
  const settingsAgents = loadSettingsAgents();
  const models = loadAgentModels();
  const card = modelCard();
  card.meta.claude.model_choices = [];
  card.meta.claude.models_list = true;
  // Still loading (null) and empty: only CLI default + Other.
  let html = settingsAgents.agentListHtml({ ...card, agentCatalog: { claude: null } });
  assert.match(html, /<option value="" selected>CLI default<\/option><option value="__other__">Other…<\/option>/);
  html = settingsAgents.agentListHtml({
    ...card,
    agentCatalog: { claude: ["grok-4.7", 'Gemini <3.5> "Flash"'] },
  });
  assert.match(html, /<option value="grok-4\.7">grok-4\.7<\/option>/);
  assert.match(html, /<option value="Gemini &lt;3\.5&gt; &quot;Flash&quot;">Gemini &lt;3\.5&gt; "Flash"<\/option>/);
  assert.deepEqual([...models.modelChoices({ name: "x", model_choices: ["a"] }, ["b", "b", ""])], ["b"]);
  assert.deepEqual([...models.modelChoices({ name: "x", model_choices: ["a"] }, [])], ["a"]);
});

test("the model selects hide for a provider that takes no model, the offline stub, and an absent CLI", () => {
  const settingsAgents = loadSettingsAgents();
  const card = modelCard({ order: ["stub", "nomodel", "absent"] });
  card.meta = {
    stub: { name: "stub", present: true, capabilities: { model: false, execution_profile_noop: true } },
    nomodel: { name: "nomodel", present: true, capabilities: { model: false, reasoning: ["low"] } },
    absent: { name: "absent", present: false, capabilities: { model: true }, model_choices: ["x"] },
  };
  assert.doesNotMatch(settingsAgents.agentListHtml(card), /agent-model-pick/);
});

test("applyModelChoice sets, clears and validates a class choice without touching other providers", () => {
  const models = loadAgentModels();
  const bindings = { codex: { deep: "gpt-6-sol" } };
  assert.equal(models.applyModelChoice(bindings, "claude", "deep", "opus", ["sonnet", "opus"]), true);
  assert.deepEqual(JSON.parse(JSON.stringify(bindings)), { codex: { deep: "gpt-6-sol" }, claude: { deep: "opus" } });
  assert.equal(models.applyModelChoice(bindings, "claude", "deep", "opus", ["opus"]), false, "unchanged");
  assert.equal(
    models.applyModelChoice(bindings, "claude", "deep", "__other__"),
    false,
    "Other… is not a value"
  );
  assert.equal(models.applyModelChoice(bindings, "claude", "turbo", "opus", ["opus"]), false, "unknown class");
  assert.equal(models.applyModelChoice(bindings, "claude", "fast", "two words"), false, "malformed free text");
  // A live-catalog entry with spaces is accepted because it was offered.
  assert.equal(
    models.applyModelChoice(bindings, "claude", "fast", "Gemini 3.5 Flash", ["Gemini 3.5 Flash"]),
    true
  );
  assert.equal(
    models.applyModelChoice(bindings, "claude", "fast", "my-model:v2/x_1.0"),
    true,
    "well-formed free text"
  );
  assert.equal(models.applyModelChoice(bindings, "claude", "fast", ""), true, "CLI default clears");
  assert.equal(models.applyModelChoice(bindings, "claude", "deep", ""), true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(bindings)),
    { codex: { deep: "gpt-6-sol" } },
    "an empty provider is removed"
  );
  assert.equal(models.applyModelChoice(bindings, "claude", "deep", ""), false, "already the default");
  assert.equal(models.modelIdValid("sonnet"), true);
  assert.equal(models.modelIdValid("x".repeat(81)), false);
  assert.equal(models.modelIdValid("<script>"), false);
  assert.equal(models.modelBinding(bindings, "codex", "deep"), "gpt-6-sol");
  assert.equal(models.modelBinding(bindings, "codex", "fast"), "");
});
