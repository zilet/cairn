// @ts-check
// ==== settings-screen.js ====
{
function requiredEl<T extends Element = HTMLElement>(selector: string): T {
  const el = $<T>(selector);
  if (!el) throw new Error(`Missing Settings element: ${selector}`);
  return el;
}

function optionalEl<T extends Element = HTMLElement>(selector: string): T | null {
  return $<T>(selector);
}

function settingsDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SET_SEG = CairnSettingsSurface.SET_SEG;
const settingsStatus = CairnSettingsSurface.statusHelpers({ relTime, absDate });
const { garminStatusLine, agentHealthCard, agentOpLabel, agentActivityCard, noticedCard, agentChipState } = settingsStatus;
const SETTINGS_SCREEN_CACHE_KEY = "settings:screen";

async function fetchSettingsBundle(): Promise<SettingsScreenBundle> {
  const [rawData, rawArtStats, agentStats, learnings, brainDiagnostics] = await Promise.all([
    api("/settings"),
    api("/art/stats").catch(() => null),
    api("/agent-stats?recent=12&days=7").catch(() => null), // explicit seven-day health window
    api("/learnings").catch(() => null),   // outcome learnings -> "What Cairn has noticed"; absent on older backends
    api("/brain-diagnostics").catch(() => null), // operator-only accountable brain/tool trace
  ]);
  return { rawData, rawArtStats, agentStats, learnings, brainDiagnostics };
}

function settingsBundleSame(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

async function renderSettings(): Promise<void> {
  headerTitle.textContent = "Settings";
  const token = ++pollToken;
  const peek = peekCached<SettingsScreenBundle>(SETTINGS_SCREEN_CACHE_KEY);
  if (peek) {
    renderSettingsBundle(peek.data);
    if (!peek.fresh) markRefreshing(true);
    void fetchSettingsBundle()
      .then((bundle) => {
        swrSet(SETTINGS_SCREEN_CACHE_KEY, bundle);
        if (token !== pollToken || state.tab !== "settings") return;
        markRefreshing(false);
        if (document.body.classList.contains("savebar-open")) return;
        if (!settingsBundleSame(peek.data, bundle)) skelSwap(() => renderSettingsBundle(bundle));
      })
      .catch(() => {
        if (token === pollToken && state.tab === "settings") markRefreshing(false);
      });
    return;
  }

  if (!view.querySelector("#setSlice")) view.innerHTML = loadingState("Opening Settings…");
  const bundle = await fetchSettingsBundle();
  swrSet(SETTINGS_SCREEN_CACHE_KEY, bundle);
  if (token !== pollToken || state.tab !== "settings") return;
  renderSettingsBundle(bundle);
}

function renderSettingsBundle(bundle: SettingsScreenBundle): void {
  const { rawData, rawArtStats, agentStats, learnings, brainDiagnostics } = bundle;
  const data = CairnSettingsSurface.settingsData(rawData);
  const artStats = rawArtStats ? (rawArtStats as SettingsScreenArtStats) : null;
  const s = data.settings;
  const agents = data.agents; // ordered: {name, description, env_ok, enabled, configured?, present?, version?, can_login?, models_list?, usable?}

  // ---- ONE in-memory working model, built once on entry. Every editable control
  // mirrors into this on change; persistSettings() serializes from HERE (never from
  // DOM elements, which may not be mounted in the active slice). Switching sub-tabs
  // re-renders a slice FROM the model — no refetch, no lost edits.
  const wm = CairnSettingsSurface.workingModel(data);
  const meta: Record<string, SettingsScreenAgent> = Object.fromEntries(agents.map((a) => [a.name, a])); // name → declarative fields
  // lazily-fetched per-agent detail (version/model/update + models list), cached so a
  // re-render of the Agents slice doesn't re-hit the network for what we already have.
  const agentInfo: Record<string, SettingsScreenAgentInfo> = {};   // name → {version, model_current, update_available}
  const agentModels: Record<string, unknown[]> = {}; // name → [..]
  const diagnosticsState: SettingsDiagnosticsUiState = {
    status: "idle",
    data: null,
    readinessStatus: "idle",
    readiness: null,
    days: 7,
    source: "all",
    severity: "all",
    issuePage: 0,
    recentPage: 0,
    requestToken: 0,
  };

  // Side cards (built once; folded into the Agents slice). All degrade to "" when the
  // backing endpoint is absent/empty.
  const agentHealthHtml = agentHealthCard(agentStats);
  const agentActivityHtml =
    agentActivityCard(agentStats) +
    CairnSettingsClient.brainDiagnosticsCard(brainDiagnostics);
  const noticedHtml = noticedCard(learnings);
  const artSpendHtml = artStats ? CairnSettingsSurface.artSpendCardHtml(artStats) : "";

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
    const body: SettingsScreenPersistBody = {
      agent_strategy: wm.agent_strategy,
      agent_order: wm.order,
      disabled_agents: [...wm.disabled],
      enrich_enabled: wm.enrich_enabled,
      art_enabled: wm.art_enabled,
      research_enabled: wm.research_enabled,
      garmin_username: wm.garmin_username.trim(),
      coach_day: +wm.coach_day,
      coach_hour: +wm.coach_hour,
      agent_routes: wm.routes,
      update_check_enabled: wm.update_check_enabled,
      lead_mode: wm.lead_mode,
    };
    // password / api-key fields: blank means "leave the configured value intact" — only
    // send a typed value (matches the old per-field placeholder behavior).
    if (wm.gemini_api_key.trim()) body.gemini_api_key = wm.gemini_api_key.trim();
    if (wm.garmin_password.trim()) body.garmin_password = wm.garmin_password.trim();
    await api("/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    swrInvalidate(SETTINGS_SCREEN_CACHE_KEY);
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

  function settingsAgentsDeps(): ClientSettingsAgentsControllerDeps {
    return {
      root: slice(),
      workingModel: wm,
      meta,
      routeTasks,
      agentInfo,
      agentModels,
      agentHealthHtml,
      agentActivityHtml,
      noticedHtml,
      dayNames,
      api,
      toast,
      sleep: settingsDelay,
      stagger,
      markDirty: () => settingsBar.markDirty(),
      pruneRoutes: typeof settingsPruneRoutes === "function" ? settingsPruneRoutes : undefined,
      routeRowsHtml: typeof settingsRouteRowsHtml === "function" ? settingsRouteRowsHtml : undefined,
      openAgentLoginModal: () => (globalThis as { openAgentLoginModal?: (agentName: string) => unknown }).openAgentLoginModal,
    };
  }

  function renderAgentsSlice() {
    CairnSettingsAgentsController.render(settingsAgentsDeps());
  }

  function settingsSourcesAutomationDeps(): ClientSettingsSourcesAutomationControllerDeps {
    return {
      root: slice(),
      workingModel: wm,
      settings: s,
      data,
      artSpendHtml,
      garminStatusLine,
      api,
      toast,
    };
  }

  function renderSourcesSlice() {
    CairnSettingsSourcesAutomationController.renderSources(settingsSourcesAutomationDeps());
  }

  function renderAutomationSlice() {
    CairnSettingsSourcesAutomationController.renderAutomation(settingsSourcesAutomationDeps());
  }

  // The update card body, built from a fetched status + the (possibly unsaved) toggle.
  // Calm, operator-facing, copy-first. No version number is ever framed as a score.
  function updateCardHtml(st: unknown): string {
    return CairnSettingsClient.updateCardHtml(st, { updateCheckEnabled: wm.update_check_enabled });
  }

  function settingsDataDeps(): ClientSettingsDataControllerDeps {
    return {
      root: slice(),
      workingModel: wm,
      api,
      toast,
      markDirty: () => settingsBar.markDirty(),
      updateCardHtml,
      withToken,
      downloadFile,
      reload: () => location.reload(),
      inStandaloneApp,
    };
  }

  function renderDataSlice() {
    CairnSettingsDataController.render(settingsDataDeps());
  }

  async function loadSystemDiagnostics(): Promise<void> {
    const requestToken = ++diagnosticsState.requestToken;
    const days = diagnosticsState.days;
    const [diagnosticsResult, readinessResult] = await Promise.allSettled([
      api(`/diagnostics?recent=100&days=${days}`, { cache: "no-store" }),
      api("/ready", { cache: "no-store", acceptErrorBody: true }),
    ]);
    if (requestToken !== diagnosticsState.requestToken) return;
    if (diagnosticsResult.status === "fulfilled") {
      diagnosticsState.data = diagnosticsResult.value as import("../contracts/client-api.js").ClientDiagnosticsResponse;
      diagnosticsState.status = "ready";
    } else {
      diagnosticsState.data = null;
      diagnosticsState.status = "unavailable";
    }
    if (readinessResult.status === "fulfilled") {
      const readiness = readinessResult.value as import("../contracts/client-api.js").ClientReadinessResponse;
      if (readiness && typeof readiness.ok === "boolean" && (readiness.database === "ok" || readiness.database === "unavailable")) {
        diagnosticsState.readiness = readiness;
        diagnosticsState.readinessStatus = "ready";
      } else {
        diagnosticsState.readiness = null;
        diagnosticsState.readinessStatus = "unavailable";
      }
    } else {
      diagnosticsState.readiness = null;
      diagnosticsState.readinessStatus = "unavailable";
    }
    if (state.tab === "settings" && state.setSeg === "system") renderSystemSlice();
  }

  function renderSystemSlice(): void {
    const slot = slice();
    if (diagnosticsState.status === "idle") {
      diagnosticsState.status = "loading";
      diagnosticsState.readinessStatus = "loading";
      void loadSystemDiagnostics();
    }
    slot.innerHTML = `<div class="reveal">${CairnSettingsClient.diagnosticsCard(diagnosticsState.data, {
      status: diagnosticsState.status,
      readinessStatus: diagnosticsState.readinessStatus === "idle" ? "loading" : diagnosticsState.readinessStatus,
      readiness: diagnosticsState.readiness,
      days: diagnosticsState.days,
      source: diagnosticsState.source,
      severity: diagnosticsState.severity,
      issuePage: diagnosticsState.issuePage,
      recentPage: diagnosticsState.recentPage,
      relTime,
      absDate,
    })}</div>`;
    slot.querySelectorAll<HTMLButtonElement>("[data-diag-days]").forEach((button) =>
      button.addEventListener("click", () => {
        const days = Number(button.dataset.diagDays);
        if (days !== 1 && days !== 7 && days !== 30) return;
        diagnosticsState.days = days;
        diagnosticsState.source = "all";
        diagnosticsState.severity = "all";
        diagnosticsState.issuePage = 0;
        diagnosticsState.recentPage = 0;
        diagnosticsState.data = null;
        diagnosticsState.status = "loading";
        diagnosticsState.readiness = null;
        diagnosticsState.readinessStatus = "loading";
        renderSystemSlice();
        void loadSystemDiagnostics();
      }),
    );
    optionalEl<HTMLSelectElement>("#sysDiagSource")?.addEventListener("change", (event) => {
      diagnosticsState.source = (event.currentTarget as HTMLSelectElement).value || "all";
      diagnosticsState.issuePage = 0;
      diagnosticsState.recentPage = 0;
      renderSystemSlice();
    });
    optionalEl<HTMLSelectElement>("#sysDiagSeverity")?.addEventListener("change", (event) => {
      diagnosticsState.severity = (event.currentTarget as HTMLSelectElement).value || "all";
      diagnosticsState.issuePage = 0;
      diagnosticsState.recentPage = 0;
      renderSystemSlice();
    });
    slot.querySelectorAll<HTMLButtonElement>("[data-system-retry]").forEach((button) =>
      button.addEventListener("click", () => {
        diagnosticsState.status = "loading";
        diagnosticsState.readinessStatus = "loading";
        renderSystemSlice();
        void loadSystemDiagnostics();
      }),
    );
    slot.querySelectorAll<HTMLButtonElement>("[data-diag-page]").forEach((button) =>
      button.addEventListener("click", () => {
        const delta = Number(button.dataset.diagDelta) || 0;
        if (button.dataset.diagPage === "issues") diagnosticsState.issuePage = Math.max(0, diagnosticsState.issuePage + delta);
        if (button.dataset.diagPage === "recent") diagnosticsState.recentPage = Math.max(0, diagnosticsState.recentPage + delta);
        renderSystemSlice();
      }),
    );
    slot.querySelectorAll<HTMLButtonElement>("[data-copy-request]").forEach((button) =>
      button.addEventListener("click", async () => {
        const requestId = button.dataset.copyRequest || "";
        if (!requestId) return;
        try {
          await navigator.clipboard.writeText(requestId);
          toast("Request ID copied");
        } catch {
          toast("Select the request ID to copy it");
        }
      }),
    );
  }

  // "You" — the about-you & context home (Profile, Family, Life, Memory). These are
  // low-frequency, set-once surfaces; they open their existing detail views.
  function renderYouSlice() {
    const slot = view.querySelector<HTMLElement>("#setSlice");
    if (!slot) return;
    const item = (seg: string, title: string, sub: string) =>
      `<button class="set-you-card" data-you="${seg}" type="button">
        <span class="set-you-t">${title}</span><span class="set-you-s">${sub}</span>
        <span class="set-you-arw" aria-hidden="true">›</span>
      </button>`;
    slot.innerHTML = `<div class="set-you reveal">
        ${item("profile", "Profile", "About you, goals, discipline & bodyweight")}
        ${item("family", "Family", "The people your coach plans around")}
        ${item("life", "Life", "Trips, injuries & events on your timeline")}
        ${item("memory", "Memory", "What Cairn remembers about you")}
      </div>`;
    slot.querySelectorAll<HTMLElement>("[data-you]").forEach((b) =>
      b.addEventListener("click", () => {
        state.meSeg = (b.dataset.you || "profile") as ClientMeSection;
        activateTab("me");
      }));
  }

  const SLICES: Record<SettingsScreenSliceKey, () => void> = { you: renderYouSlice, agents: renderAgentsSlice, system: renderSystemSlice, sources: renderSourcesSlice, automation: renderAutomationSlice, data: renderDataSlice };
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
