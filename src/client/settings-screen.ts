// @ts-check
// ==== settings-screen.js ====
{
type SettingsAgent = {
  name: string;
  description?: string;
  enabled?: boolean;
  configured?: boolean;
  can_login?: boolean;
  models_list?: boolean;
} & Record<string, unknown>;

type SettingsData = {
  settings: Record<string, unknown>;
  agents: SettingsAgent[];
  research_auto_eligible?: boolean | { eligible?: boolean; reason?: string };
};

type SettingsWorkingModel = {
  agent_strategy: string;
  order: string[];
  disabled: Set<string>;
  routes: Record<string, string>;
  enrich_enabled: boolean;
  art_enabled: boolean;
  research_enabled: boolean;
  gemini_api_key: string;
  garmin_username: string;
  garmin_password: string;
  coach_enabled: boolean;
  coach_day: number;
  coach_hour: number;
  update_check_enabled: boolean;
};

type SettingsPersistBody = {
  agent_strategy: string;
  agent_order: string[];
  disabled_agents: string[];
  enrich_enabled: boolean;
  art_enabled: boolean;
  research_enabled: boolean;
  garmin_username: string;
  coach_enabled: boolean;
  coach_day: number;
  coach_hour: number;
  agent_routes: Record<string, string>;
  update_check_enabled: boolean;
  gemini_api_key?: string;
  garmin_password?: string;
};

type AgentInfo = {
  version: unknown;
  model_current: unknown;
  update_available: boolean;
};

type CliUpdateStatus = {
  status?: string;
  started_at?: string;
  finished_at?: string;
  error?: string;
};

type AgentInfoResponse = import("../contracts/client-api.js").ClientAgentProbeResponse;
type AgentModelsResponse = import("../contracts/client-api.js").ClientAgentModelsResponse;
type ArtStats = import("../contracts/client-api.js").ClientArtStatsResponse;
type GarminSyncResponse = import("../contracts/client-api.js").ClientGarminSyncResponse;

type UpdateStatus = Record<string, unknown> | null;
type SettingsSliceKey = ClientSettingsSection;

function settingsScreenRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function settingsString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function settingsNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function settingsBool(value: unknown, fallback = false): boolean {
  return value == null ? fallback : !!value;
}

function settingsData(value: unknown): SettingsData {
  const row = settingsScreenRecord(value);
  const agents = Array.isArray(row.agents)
    ? row.agents.map((agent) => settingsScreenRecord(agent)).filter((agent): agent is SettingsAgent => typeof agent.name === "string")
    : [];
  const eligible = row.research_auto_eligible;
  return {
    settings: settingsScreenRecord(row.settings),
    agents,
    research_auto_eligible:
      typeof eligible === "boolean" || (eligible && typeof eligible === "object")
        ? (eligible as SettingsData["research_auto_eligible"])
        : undefined,
  };
}

function requiredEl<T extends Element = HTMLElement>(selector: string): T {
  const el = $<T>(selector);
  if (!el) throw new Error(`Missing Settings element: ${selector}`);
  return el;
}

function optionalEl<T extends Element = HTMLElement>(selector: string): T | null {
  return $<T>(selector);
}

function eventInput(event: Event): HTMLInputElement {
  return event.currentTarget as HTMLInputElement;
}

function eventSelect(event: Event): HTMLSelectElement {
  return event.currentTarget as HTMLSelectElement;
}

function routeEligible(data: SettingsData): { eligible?: boolean; reason?: string } | null {
  const eligible = data.research_auto_eligible;
  if (!eligible || typeof eligible !== "object") return null;
  return eligible;
}

// ---------- Settings (agent rotation + auto-coach) ----------
// Garmin sync status line: colored dot + relative time + the short result the
// server recorded ("ok: 12 activities · 14 daily" / "failed: …").
const garminStatusLine = (s: unknown, syncing: boolean): string => {
  return CairnSettingsClient.garminStatusLine(s, syncing, { relTime });
};

// Agent-health card — a small, calm read on the coaching brain's reliability:
// overall ok-rate + per-agent latency, mirroring the art-spend card's ledger
// style. NO scores, just plain words. Returns "" when the endpoint is absent or
// empty (Stream 1's GET /api/agent-stats may 404 on an older backend → silent).
const agentHealthCard = (st: unknown): string => {
  return CairnSettingsClient.agentHealthCard(st);
};

// Plain-language label for an agentic op key (from agent_runs.op) — the activity
// log reads in human words, never an internal token. Falls back to a tidied key.
const agentOpLabel = (op: unknown): string => {
  return CairnSettingsClient.agentOpLabel(op);
};

// "What Cairn did" — a calm activity log of recent agentic runs, built from
// GET /api/agent-stats recent[]. Transparency, NEVER a grade/score: each line is
// op · agent · relative time · "clean" or "needed a retry" (a fall-through to the
// next agent, or output that needed a repair). Renders nothing when empty/absent.
const agentActivityCard = (st: unknown): string => {
  return CairnSettingsClient.agentActivityCard(st, { relTime, absDate });
};

// "What Cairn has noticed" (F2) — the durable learnings drawn from comparing what
// the Brief / a session suggestion / a nutrition check-in PROPOSED against what
// actually happened (e.g. "tolerates higher training frequency than the read
// assumed"). Gentle observations only — pull-never-push, no scores, never a gate;
// they just season the coach's defaults. Renders nothing when there's nothing yet.
const noticedCard = (data: unknown): string => {
  return CairnSettingsClient.noticedCard(data, { relTime, absDate });
};

// Settings sub-nav: the long single-scroll tab is split into four calm sections,
// using the SAME sliding-thumb segmented switcher the Me/Progress/Plan tabs use
// (segBar/fitSeg). The slices read from ONE in-memory working model (built once on
// entry) so switching sub-tabs never refetches /settings and never loses an unsaved
// edit; the floating save bar (mounted once on a stable sentinel) persists the whole
// model regardless of which slice is on screen.
const SET_SEG: readonly ClientSegment[] = [["agents", "Agents"], ["sources", "Sources"], ["automation", "Automation"], ["data", "Data"]];

// A state chip for an agent connect-card, derived from the declarative fields the
// settings endpoint now supplies (present/configured/can_login/…). Calm, never
// alarming: "Not installed" when the CLI binary is missing; otherwise the connection
// state — Connected / Connect → / Installed. Returns {cls, label}.
const agentChipState = (a: Record<string, unknown> | null | undefined): { cls: string; label: string } => {
  return CairnSettingsClient.agentChipState(a || {});
};

async function renderSettings(): Promise<void> {
  headerTitle.textContent = "Settings";
  const [rawData, rawArtStats, agentStats, learnings] = await Promise.all([
    api("/settings"),
    api("/art/stats").catch(() => null),
    api("/agent-stats").catch(() => null), // 404s on a backend without telemetry → degrade silently
    api("/learnings").catch(() => null),   // F2: outcome learnings → "What Cairn has noticed"; absent on an older backend
  ]);
  const data = settingsData(rawData);
  const artStats = rawArtStats ? (rawArtStats as ArtStats) : null;
  const s = data.settings;
  const agents = data.agents; // ordered: {name, description, env_ok, enabled, configured?, present?, version?, can_login?, models_list?, usable?}

  // ---- ONE in-memory working model, built once on entry. Every editable control
  // mirrors into this on change; persistSettings() serializes from HERE (never from
  // DOM elements, which may not be mounted in the active slice). Switching sub-tabs
  // re-renders a slice FROM the model — no refetch, no lost edits.
  const wm: SettingsWorkingModel = {
    agent_strategy: settingsString(s.agent_strategy, "round_robin"),
    order: agents.map((a) => a.name),
    disabled: new Set(agents.filter((a) => !a.enabled).map((a) => a.name)),
    routes: { ...settingsScreenRecord(s.agent_routes) } as Record<string, string>,
    enrich_enabled: settingsBool(s.enrich_enabled),
    art_enabled: settingsBool(s.art_enabled, true),
    research_enabled: settingsBool(s.research_enabled),
    gemini_api_key: "",       // blank = preserve existing; only a typed value is sent
    garmin_username: settingsString(s.garmin_username),
    garmin_password: "",      // blank = preserve existing
    coach_enabled: settingsBool(s.coach_enabled),
    coach_day: settingsNumber(s.coach_day),
    coach_hour: settingsNumber(s.coach_hour),
    update_check_enabled: settingsBool(s.update_check_enabled, true),
  };
  const meta: Record<string, SettingsAgent> = Object.fromEntries(agents.map((a) => [a.name, a])); // name → declarative fields
  // lazily-fetched per-agent detail (version/model/update + models list), cached so a
  // re-render of the Agents slice doesn't re-hit the network for what we already have.
  const agentInfo: Record<string, AgentInfo> = {};   // name → {version, model_current, update_available}
  const agentModels: Record<string, unknown[]> = {}; // name → [..]
  let updateStatusCache: UpdateStatus = null; // {current, latest, update_available, html_url, checked_at, enabled, error}; lazily fetched in the Data slice

  // Side cards (built once; folded into the Agents slice). All degrade to "" when the
  // backing endpoint is absent/empty.
  const agentHealthHtml = agentHealthCard(agentStats);
  const agentActivityHtml = agentActivityCard(agentStats);
  const noticedHtml = noticedCard(learnings);
  let artSpendHtml = "";
  if (artStats) {
    const money = (v: unknown): string => { const n = Number(v) || 0; return "$" + (n && n < 0.005 ? n.toFixed(4) : n.toFixed(2)); };
    const t = artStats.since_enabled || {};
    const a = artStats.all_time || {};
    const since = artStats.enabled_at ? `since ${escHtml(String(artStats.enabled_at).slice(0, 10))}` : "all-time";
    artSpendHtml = `
    <div class="sess" style="margin-top:10px">
      <div class="sess-line"><b>${money(t.est_cost_usd)}</b> est. spend ${since} · ${t.images_generated} image${t.images_generated === 1 ? "" : "s"} generated · ${t.reused} reused (~${money(t.est_saved_usd)} saved)</div>
      <div class="sess-line" style="color:var(--muted)">All-time: ${money(a.est_cost_usd)} spent · ${a.images_generated} images · ${artStats.cached_assets} cached, served from cache forever after.</div>
    </div>`;
  }

  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const routeTasks = typeof settingsRouteTasks === "function" ? settingsRouteTasks(data) : [];
  const inStandaloneApp = (() => {
    try {
      if (isStandalonePWA()) return true;
      if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true;
      if ((navigator as Navigator & { standalone?: boolean }).standalone) return true;
    } catch {}
    return false;
  })();

  if (!state.setSeg || !SET_SEG.some(([k]) => k === state.setSeg)) state.setSeg = "agents";

  // ---- Stable shell. The sub-nav band + a #setSlice container persist across slice
  // swaps (only #setSlice's innerHTML changes), so the save-bar sentinel below — which
  // lives in the shell, NOT in a slice — stays connected and the bar survives a sub-tab
  // switch with edits pending. A full renderTab() re-render replaces the whole view,
  // disconnecting the sentinel, which correctly dismisses the bar.
  view.innerHTML = `
    <span id="setSaveSentinel" hidden></span>
    ${segBar(state.setSeg, SET_SEG)}
    <p class="set-lede">Everything here is optional — Cairn works out of the box. Connect an agent for coaching.</p>

    <div id="setSlice"></div>`;

  // ---- Persist EVERYTHING from the working model, regardless of the visible slice.
  const persistSettings = async (): Promise<boolean> => {
    const body: SettingsPersistBody = {
      agent_strategy: wm.agent_strategy,
      agent_order: wm.order,
      disabled_agents: [...wm.disabled],
      enrich_enabled: wm.enrich_enabled,
      art_enabled: wm.art_enabled,
      research_enabled: wm.research_enabled,
      garmin_username: wm.garmin_username.trim(),
      coach_enabled: wm.coach_enabled,
      coach_day: +wm.coach_day,
      coach_hour: +wm.coach_hour,
      agent_routes: wm.routes,
      update_check_enabled: wm.update_check_enabled,
    };
    // password / api-key fields: blank means "leave the configured value intact" — only
    // send a typed value (matches the old per-field placeholder behavior).
    if (wm.gemini_api_key.trim()) body.gemini_api_key = wm.gemini_api_key.trim();
    if (wm.garmin_password.trim()) body.garmin_password = wm.garmin_password.trim();
    await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    artEnabled = wm.art_enabled; // take effect on the next render, no reload
    return true;
  };
  // Floating save bar — mounted ONCE on the shell-level sentinel so it persists across
  // sub-tab switches (sentinel stays connected while only #setSlice swaps).
  const settingsBar = mountSaveBar({
    sentinel: optionalEl("#setSaveSentinel"),
    fields: view,
    onSave: persistSettings,
    onDiscard: () => renderSettings(),
  });

  // ---- Slice renderers. Each writes #setSlice and wires its own controls; all reads
  // come from `wm`, all writes go back into `wm` + settingsBar.markDirty().
  const slice = (): HTMLElement => requiredEl<HTMLElement>("#setSlice");

  function renderAgentsSlice() {
    const enabledAgents = wm.order
      .map((n) => meta[n])
      .filter((a): a is SettingsAgent => !!a && !wm.disabled.has(a.name));
    // Silently reconcile pins to agents/tasks that no longer exist so the selects
    // and pinned-count render clean. This runs on every full-slice render (mount,
    // sub-tab switch, discard) — NOT on a user edit — so it must NOT markDirty,
    // or opening Settings would spuriously show "Unsaved changes". A genuine route
    // edit dirties via the select's change handler below; the server also drops
    // stale pins on save, so a benign leftover never persists past the next save.
    if (typeof settingsPruneRoutes === "function") {
      wm.routes = settingsPruneRoutes(wm.routes, routeTasks, enabledAgents);
    }
    const pinnedRouteCount = Object.keys(wm.routes || {}).length;
    const routeSummary = `Route tasks to agents${pinnedRouteCount ? ` · ${pinnedRouteCount} pinned` : ""}`;
    const routeRowsHtml = typeof settingsRouteRowsHtml === "function"
      ? settingsRouteRowsHtml(routeTasks, enabledAgents, wm.routes)
      : "";

    slice().innerHTML = CairnSettingsAgents.agentsSliceHtml({
      agentStrategy: wm.agent_strategy,
      routeSummary,
      routeRowsHtml,
      agentHealthHtml,
      agentActivityHtml,
      noticedHtml,
      coachEnabled: wm.coach_enabled,
      coachDay: wm.coach_day,
      coachHour: wm.coach_hour,
      dayNames,
    });

    // strategy + coach fields → working model
    requiredEl<HTMLSelectElement>("#strat").addEventListener("change", (e) => { wm.agent_strategy = eventSelect(e).value; });
    requiredEl<HTMLInputElement>("#coachEnabled").addEventListener("change", (e) => { wm.coach_enabled = eventInput(e).checked; });
    requiredEl<HTMLSelectElement>("#coachDay").addEventListener("change", (e) => { wm.coach_day = +eventSelect(e).value; });
    requiredEl<HTMLSelectElement>("#coachHour").addEventListener("change", (e) => { wm.coach_hour = +eventSelect(e).value; });
    // per-task routing selects (mirror into the model; empty clears the pin → Auto)
    slice().querySelectorAll<HTMLSelectElement>("[data-route]").forEach((sel) => sel.addEventListener("change", () => {
      const task = sel.dataset.route || ""; const v = sel.value;
      if (v) wm.routes[task] = v; else delete wm.routes[task];
    }));

    renderAgentList();
    wireCliUpdate();
  }

  // Agent connect-cards: enable/disable + ordering (as before) PLUS a state chip, a
  // Connect button (when can_login), a lazily-fetched info line, and a "view models"
  // disclosure (when models_list). All visibility-only — no model picker; defaults rule.
  function renderAgentList() {
    const wrap = optionalEl<HTMLElement>("#agentlist");
    if (!wrap) return;
    wrap.innerHTML = CairnSettingsAgents.agentListHtml({ order: wm.order, disabled: wm.disabled, meta, agentInfo, agentModels, stagger });

    wrap.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((b) => b.addEventListener("click", () => {
      const n = b.dataset.toggle || "";
      wm.disabled.has(n) ? wm.disabled.delete(n) : wm.disabled.add(n);
      settingsBar.markDirty(); renderAgentList();
    }));
    wrap.querySelectorAll<HTMLButtonElement>("[data-up]").forEach((b) => b.addEventListener("click", () => {
      const i = wm.order.indexOf(b.dataset.up || "");
      if (i > 0) { [wm.order[i - 1], wm.order[i]] = [wm.order[i], wm.order[i - 1]]; settingsBar.markDirty(); renderAgentList(); }
    }));
    wrap.querySelectorAll<HTMLButtonElement>("[data-down]").forEach((b) => b.addEventListener("click", () => {
      const i = wm.order.indexOf(b.dataset.down || "");
      if (i < wm.order.length - 1) { [wm.order[i + 1], wm.order[i]] = [wm.order[i], wm.order[i + 1]]; settingsBar.markDirty(); renderAgentList(); }
    }));
    // Connect → hand off to the login modal provided by another module (guarded: it
    // exists after integration; until then the button is a calm no-op).
    wrap.querySelectorAll<HTMLButtonElement>("[data-connect]").forEach((b) => b.addEventListener("click", () => {
      const n = b.dataset.connect || "";
      const loginModal = (globalThis as { openAgentLoginModal?: (agentName: string) => unknown }).openAgentLoginModal;
      if (loginModal) loginModal(n);
      else toast("Agent connect is unavailable here");
    }));
    // Lazy detail (NOT fetched on paint — only on tap): version / current model /
    // update-available. Cached, so re-renders are free.
    wrap.querySelectorAll<HTMLButtonElement>("[data-detail]").forEach((b) => b.addEventListener("click", async () => {
      const n = b.dataset.detail || "";
      if (agentInfo[n]) return; // already shown
      b.disabled = true; b.textContent = "checking…";
      try {
        const r = await api(`/agents/${encodeURIComponent(n)}/info`) as AgentInfoResponse;
        if (r.ok) agentInfo[n] = { version: r.version ?? null, model_current: r.model_current ?? null, update_available: !!r.update_available };
        else agentInfo[n] = { version: null, model_current: null, update_available: false };
      } catch { agentInfo[n] = { version: null, model_current: null, update_available: false }; }
      renderAgentList();
    }));
    // "view models" disclosure (lazy, cached) — a plain list, no picker.
    wrap.querySelectorAll<HTMLButtonElement>("[data-models]").forEach((b) => b.addEventListener("click", async () => {
      const n = b.dataset.models || "";
      if (Array.isArray(agentModels[n])) { delete agentModels[n]; renderAgentList(); return; } // toggle off
      b.disabled = true; b.textContent = "loading…";
      try {
        const r = await api(`/agents/${encodeURIComponent(n)}/models`) as AgentModelsResponse;
        agentModels[n] = r && r.ok && Array.isArray(r.models) ? r.models : [];
      } catch { agentModels[n] = []; }
      renderAgentList();
    }));
  }

  // "Update CLI tools" — unchanged behavior, just wired from inside the Agents slice.
  function wireCliUpdate() {
    const renderCliStatus = (r: CliUpdateStatus | null) => {
      const el = optionalEl<HTMLElement>("#agentCliUpdateStatus");
      if (!el || !r) return;
      if (r.status === "running") el.textContent = `Updating since ${(r.started_at || "").replace("T", " ").slice(0, 16)}`;
      else if (r.status === "succeeded") el.textContent = `Updated ${(r.finished_at || "").replace("T", " ").slice(0, 16)}`;
      else if (r.status === "failed") el.textContent = `Update failed${r.error ? `: ${r.error}` : ""}`;
      else el.textContent = "";
    };
    const pollCliStatus = async () => {
      const btn = optionalEl<HTMLButtonElement>("#updateAgentClis");
      if (!btn) return;
      let r = (await api("/agent-clis/update")) as CliUpdateStatus;
      renderCliStatus(r);
      if (!btn.isConnected) return;
      btn.disabled = r.status === "running";
      while (r.status === "running") {
        await sleep(2000);
        r = (await api("/agent-clis/update")) as CliUpdateStatus;
        if (!optionalEl("#agentCliUpdateStatus")) return; // slice swapped away
        renderCliStatus(r);
        const b2 = optionalEl<HTMLButtonElement>("#updateAgentClis"); if (b2) b2.disabled = r.status === "running";
      }
    };
    requiredEl<HTMLButtonElement>("#updateAgentClis").addEventListener("click", async () => {
      const btn = requiredEl<HTMLButtonElement>("#updateAgentClis");
      btn.disabled = true;
      renderCliStatus({ status: "running", started_at: new Date().toISOString() });
      await api("/agent-clis/update", { method: "POST" });
      await pollCliStatus();
      toast("CLI update finished");
    });
    pollCliStatus().catch(() => {});
  }

  function renderSourcesSlice() {
    slice().innerHTML = `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">Where your recovery and activity data come in. Both are optional and gracefully absent.</p>

        <h1 class="lbl" style="margin:14px 0 8px">Garmin Connect</h1>
        <div class="field"><label>Garmin email</label>
          <input id="garminUsername" type="email" autocomplete="username" value="${escAttr(wm.garmin_username)}" placeholder="you@example.com">
        </div>
        <div class="field"><label>Garmin password</label>
          <input id="garminPassword" type="password" autocomplete="current-password" placeholder="${s.garmin_password_configured ? `Configured via ${escAttr(s.garmin_credentials_source)}` : "Optional: GARMIN_PASSWORD"}">
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Settings credentials override GARMIN_USERNAME / GARMIN_PASSWORD. Garmin remains an input source for coaching context.</div>
        <div class="syncrow">
          <div class="syncstatus" id="garminStatus">${garminStatusLine(s, false)}</div>
          <button id="garminSyncBtn" class="ghostbtn syncbtn">Sync now</button>
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Once configured, Cairn syncs automatically every ~6 hours.</div>

        <h1 class="lbl" style="margin:22px 0 8px">Apple Health (steps, sleep, recovery)</h1>
        <div class="sess-line" style="color:var(--muted)">
          An iOS Shortcut can post daily metrics straight to Cairn. Missing fields are fine; Cairn
          keeps working without wearable data.
        </div>
        <div class="ah-fields">
          <span>date</span><span>steps</span><span>sleep_min</span><span>resting_hr</span><span>hrv_ms</span><span>active_calories</span>
        </div>
        <div class="field" style="margin-top:12px"><label>POST URL</label>
          <div class="ah-url"><code id="ahUrl"></code><button id="ahUrlCopy" class="ghostbtn ah-copy" type="button">Copy</button></div>
        </div>
        <div class="ah-example">
          <span class="ah-example-lbl">Shortcut body</span>
          <code>[{"date":"2026-06-13","steps":8421,"resting_hr":52}]</code>
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:8px">Full Shortcut recipe: <code>docs/APPLE_HEALTH.md</code></div>
      </section>`;

    requiredEl<HTMLInputElement>("#garminUsername").addEventListener("input", (e) => { wm.garmin_username = eventInput(e).value; });
    requiredEl<HTMLInputElement>("#garminPassword").addEventListener("input", (e) => { wm.garmin_password = eventInput(e).value; });

    // Manual Garmin sync: pulse while the connector runs, then re-pull /settings so the
    // status line shows exactly what the server recorded.
    requiredEl<HTMLButtonElement>("#garminSyncBtn").addEventListener("click", async () => {
      const btn = requiredEl<HTMLButtonElement>("#garminSyncBtn");
      const status = requiredEl<HTMLElement>("#garminStatus");
      btn.disabled = true; btn.textContent = "Syncing…";
      status.innerHTML = garminStatusLine(null, true);
      let r: GarminSyncResponse | null = null;
      try { r = await api("/garmin/sync", { method: "POST" }); } catch {}
      let fresh: unknown = s;
      try { fresh = settingsData(await api("/settings")).settings; } catch {}
      if (!btn.isConnected) return; // slice/tab swapped while we waited
      status.innerHTML = garminStatusLine(fresh, false);
      btn.disabled = false; btn.textContent = "Sync now";
      toast(r && r.ok ? `Garmin synced · ${r.activities} activit${r.activities === 1 ? "y" : "ies"}` : "Garmin sync failed");
    });

    // Apple Health: page-origin POST URL + one-tap copy.
    const ahUrl = optionalEl<HTMLElement>("#ahUrl");
    if (ahUrl) ahUrl.textContent = location.origin + "/api/health-metrics";
    const ahCopy = optionalEl<HTMLButtonElement>("#ahUrlCopy");
    if (ahCopy) ahCopy.addEventListener("click", async () => {
      const url = location.origin + "/api/health-metrics";
      try { await navigator.clipboard.writeText(url); ahCopy.textContent = "Copied"; }
      catch { ahCopy.textContent = "Copy failed"; }
      setTimeout(() => { ahCopy.textContent = "Copy"; }, 1600);
    });
  }

  function renderAutomationSlice() {
    const researchEligible = routeEligible(data);
    slice().innerHTML = `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">Background touches that make logging effortless. Both fall back gracefully when off.</p>

        <h1 class="lbl" style="margin:14px 0 8px">Agentic enrichment</h1>
        <label class="toggle"><input type="checkbox" id="enrichEnabled" ${wm.enrich_enabled ? "checked" : ""}>
          <span>Refine free-text logs &amp; capture coaching notes via an agent</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Logs stay instant; an agent upgrades them in the background. Falls back to offline parsing when off.</div>

        <h1 class="lbl" style="margin:22px 0 8px">Artwork generation</h1>
        <label class="toggle"><input type="checkbox" id="artEnabled" ${wm.art_enabled ? "checked" : ""}>
          <span>Generate studio photos for foods, exercises &amp; activities</span></label>
        <div class="field" style="margin-top:10px"><label>Gemini API key</label>
          <input id="geminiApiKey" type="password" autocomplete="off" placeholder="${s.gemini_api_key_configured ? `Configured via ${escAttr(s.gemini_api_key_source)}` : "Optional: GOOGLE_AI_KEY / GEMINI_API_KEY"}">
        </div>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Settings key overrides GOOGLE_AI_KEY / GEMINI_API_KEY from the server environment. Blank preserves the current key.</div>
        ${artSpendHtml}

        <h1 class="lbl" style="margin:22px 0 8px">Research &amp; grounding</h1>
        <label class="toggle"><input type="checkbox" id="researchEnabled" ${wm.research_enabled ? "checked" : ""}>
          <span>Let Cairn research your findings and cite real sources</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">Cairn already cites trusted clinical guidelines (AHA/ACC, Endocrine Society, KDIGO…) <b>offline</b> on your directives — no network needed. Turn this on to also let a web-capable agent fetch fresh, cited sources and attach them behind each directive — open them under “see the evidence” in <b>Me → Health → Read</b>. Off by default; deterministic and offline when off. Informational, never medical advice.</div>
        ${(!wm.research_enabled && researchEligible?.eligible) ? `<div class="sess-line" id="researchSuggest" style="margin-top:6px">✦ ${researchEligible.reason === "web_agent_connected" ? "Your coach agent can browse — turn this on for live, cited research." : "An agent is connected — you can try live evidence research."}</div>` : ""}
      </section>`;

    requiredEl<HTMLInputElement>("#enrichEnabled").addEventListener("change", (e) => { wm.enrich_enabled = eventInput(e).checked; });
    requiredEl<HTMLInputElement>("#artEnabled").addEventListener("change", (e) => { wm.art_enabled = eventInput(e).checked; });
    requiredEl<HTMLInputElement>("#researchEnabled").addEventListener("change", (e) => { wm.research_enabled = eventInput(e).checked; });
    requiredEl<HTMLInputElement>("#geminiApiKey").addEventListener("input", (e) => { wm.gemini_api_key = eventInput(e).value; });
  }

  // The update card body, built from a fetched status + the (possibly unsaved) toggle.
  // Calm, operator-facing, copy-first. No version number is ever framed as a score.
  function updateCardHtml(st: UpdateStatus): string {
    return CairnSettingsClient.updateCardHtml(st, { updateCheckEnabled: wm.update_check_enabled });
  }

  function renderDataSlice() {
    slice().innerHTML = `
      <section class="set-group set-group--flush">
        <p class="set-group-sub">Keep an offline copy of everything, check for new versions, or start the first-time setup over.</p>
        ${CairnSettingsData.phoneAccessCardHtml({ inStandaloneApp })}

        <h1 class="lbl" style="margin:14px 0 8px">Cairn version</h1>
        <div id="updateCard" class="sess">${updateCardHtml(updateStatusCache)}</div>
        <label class="toggle" style="margin-top:12px"><input type="checkbox" id="updateCheckEnabled" ${wm.update_check_enabled ? "checked" : ""}>
          <span>Check for new Cairn releases</span></label>
        <div class="sess-line" style="color:var(--muted);margin-top:6px">A quiet daily check against the public GitHub Releases page — pull, never a notification. It sends nothing but an anonymous request; no data leaves your instance. Off keeps Cairn fully offline.</div>
        <button id="updateCheckNow" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:10px;${wm.update_check_enabled ? "" : "display:none"}">Check now</button>

        <h1 class="lbl" style="margin:22px 0 8px">Data &amp; backup</h1>
        <button id="dlJson" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Download JSON backup</button>
        <button id="dlDb" class="ghostbtn" style="width:100%;text-align:center;padding:11px;margin-top:8px">Download SQLite snapshot</button>

        <h1 class="lbl" style="margin:22px 0 8px">Setup</h1>
        <button id="rerunSetup" class="ghostbtn" style="width:100%;text-align:center;padding:11px">Re-run first-time setup</button>
      </section>`;

    CairnSettingsData.wirePhoneAccessCard({ api, toast });
    const refreshUpdateCard = (): void => { const el = optionalEl<HTMLElement>("#updateCard"); if (el) el.innerHTML = updateCardHtml(updateStatusCache); };

    requiredEl<HTMLInputElement>("#updateCheckEnabled").addEventListener("change", (e) => {
      wm.update_check_enabled = eventInput(e).checked;
      settingsBar.markDirty();
      const btn = optionalEl<HTMLElement>("#updateCheckNow"); if (btn) btn.style.display = wm.update_check_enabled ? "" : "none";
      refreshUpdateCard();
    });

    requiredEl<HTMLButtonElement>("#updateCheckNow").addEventListener("click", async () => {
      const btn = requiredEl<HTMLButtonElement>("#updateCheckNow");
      btn.disabled = true; btn.textContent = "Checking…";
      try { updateStatusCache = settingsScreenRecord(await api("/update-check", { method: "POST" })); }
      catch { /* leave the prior status; updateCardHtml shows what we have */ }
      if (!btn.isConnected) return; // slice/tab swapped away while we waited
      refreshUpdateCard();
      btn.disabled = false; btn.textContent = "Check now";
    });

    requiredEl<HTMLButtonElement>("#dlJson").addEventListener("click", () => downloadFile(withToken("/api/export")));
    requiredEl<HTMLButtonElement>("#dlDb").addEventListener("click", () => downloadFile(withToken("/api/export/db")));
    requiredEl<HTMLButtonElement>("#rerunSetup").addEventListener("click", async () => {
      await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ onboarded: false }) });
      location.reload();
    });

    // Lazy: pull the cached status (no network on the server side) on first entry
    // into the Data slice, then fill the card in place. Cached for re-entry.
    if (!updateStatusCache) {
      api("/update-status").then((st) => {
        if (!st) return;
        updateStatusCache = settingsScreenRecord(st);
        if (optionalEl("#updateCard")) refreshUpdateCard();
      }).catch(() => {});
    }
  }

  const SLICES: Record<SettingsSliceKey, () => void> = { agents: renderAgentsSlice, sources: renderSourcesSlice, automation: renderAutomationSlice, data: renderDataSlice };
  const paintSlice = (key: ClientSettingsSection | undefined): void => (SLICES[key || "agents"] || renderAgentsSlice)();

  // Sub-tab switch: slide the thumb, swap ONLY #setSlice from the working model (no
  // refetch, edits preserved), keep the save bar mounted on the stable sentinel.
  view.querySelectorAll<HTMLButtonElement>(".segbtn").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.seg as ClientSettingsSection | undefined;
    if (!key || !SLICES[key] || key === state.setSeg) return;
    state.setSeg = key;
    const seg = b.closest<HTMLElement>(".seg");
    if (seg) {
      // Slide the ink thumb AND move the .active state (paper text) with it — the
      // shell persists across slice swaps, so without this the active class stays
      // stuck on the first tab (cream-on-cream, invisible) while the thumb is
      // elsewhere. Mirrors setHealthSegActive.
      const btns = [...seg.querySelectorAll<HTMLButtonElement>(".segbtn")];
      seg.style.setProperty("--segi", String(btns.indexOf(b)));
      btns.forEach((x) => x.classList.toggle("active", x === b));
    }
    if (typeof syncRouteFromState === "function") syncRouteFromState();
    withViewTransition(() => { paintSlice(key); viewEnter(); });
  }));
  view.querySelectorAll(".seg").forEach(fitSeg);

  paintSlice(state.setSeg);
}

Object.assign(globalThis, {
  SET_SEG,
  garminStatusLine,
  agentHealthCard,
  agentOpLabel,
  agentActivityCard,
  noticedCard,
  agentChipState,
  renderSettings,
});

if (typeof window !== "undefined") {
  Object.assign(window, { renderSettings });
}
}
