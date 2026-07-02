(() => {
// @ts-check
// ==== settings-screen.js ====
{
    function requiredEl(selector) {
        const el = $(selector);
        if (!el)
            throw new Error(`Missing Settings element: ${selector}`);
        return el;
    }
    function optionalEl(selector) {
        return $(selector);
    }
    function settingsDelay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    const SET_SEG = CairnSettingsSurface.SET_SEG;
    const settingsStatus = CairnSettingsSurface.statusHelpers({ relTime, absDate });
    const { garminStatusLine, agentHealthCard, agentOpLabel, agentActivityCard, noticedCard, agentChipState } = settingsStatus;
    async function renderSettings() {
        headerTitle.textContent = "Settings";
        const [rawData, rawArtStats, agentStats, learnings] = await Promise.all([
            api("/settings"),
            api("/art/stats").catch(() => null),
            api("/agent-stats").catch(() => null), // 404s on a backend without telemetry → degrade silently
            api("/learnings").catch(() => null), // F2: outcome learnings → "What Cairn has noticed"; absent on an older backend
        ]);
        const data = CairnSettingsSurface.settingsData(rawData);
        const artStats = rawArtStats ? rawArtStats : null;
        const s = data.settings;
        const agents = data.agents; // ordered: {name, description, env_ok, enabled, configured?, present?, version?, can_login?, models_list?, usable?}
        // ---- ONE in-memory working model, built once on entry. Every editable control
        // mirrors into this on change; persistSettings() serializes from HERE (never from
        // DOM elements, which may not be mounted in the active slice). Switching sub-tabs
        // re-renders a slice FROM the model — no refetch, no lost edits.
        const wm = CairnSettingsSurface.workingModel(data);
        const meta = Object.fromEntries(agents.map((a) => [a.name, a])); // name → declarative fields
        // lazily-fetched per-agent detail (version/model/update + models list), cached so a
        // re-render of the Agents slice doesn't re-hit the network for what we already have.
        const agentInfo = {}; // name → {version, model_current, update_available}
        const agentModels = {}; // name → [..]
        // Side cards (built once; folded into the Agents slice). All degrade to "" when the
        // backing endpoint is absent/empty.
        const agentHealthHtml = agentHealthCard(agentStats);
        const agentActivityHtml = agentActivityCard(agentStats);
        const noticedHtml = noticedCard(learnings);
        const artSpendHtml = artStats ? CairnSettingsSurface.artSpendCardHtml(artStats) : "";
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const routeTasks = typeof settingsRouteTasks === "function" ? settingsRouteTasks(data) : [];
        const inStandaloneApp = (() => {
            try {
                if (isStandalonePWA())
                    return true;
                if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)
                    return true;
                if (navigator.standalone)
                    return true;
            }
            catch { }
            return false;
        })();
        if (!state.setSeg || !SET_SEG.some(([k]) => k === state.setSeg))
            state.setSeg = "agents";
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
        const persistSettings = async () => {
            const body = {
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
            if (wm.gemini_api_key.trim())
                body.gemini_api_key = wm.gemini_api_key.trim();
            if (wm.garmin_password.trim())
                body.garmin_password = wm.garmin_password.trim();
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
        const slice = () => requiredEl("#setSlice");
        function settingsAgentsDeps() {
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
                openAgentLoginModal: () => globalThis.openAgentLoginModal,
            };
        }
        function renderAgentsSlice() {
            CairnSettingsAgentsController.render(settingsAgentsDeps());
        }
        function settingsSourcesAutomationDeps() {
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
        function updateCardHtml(st) {
            return CairnSettingsClient.updateCardHtml(st, { updateCheckEnabled: wm.update_check_enabled });
        }
        function settingsDataDeps() {
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
        // "You" — the about-you & context home (Profile, Family, Life, Memory). These are
        // low-frequency, set-once surfaces; they open their existing detail views.
        function renderYouSlice() {
            const slot = view.querySelector("#setSlice");
            if (!slot)
                return;
            const item = (seg, title, sub) => `<button class="set-you-card" data-you="${seg}" type="button">
        <span class="set-you-t">${title}</span><span class="set-you-s">${sub}</span>
        <span class="set-you-arw" aria-hidden="true">›</span>
      </button>`;
            slot.innerHTML = `<div class="set-you reveal">
        ${item("profile", "Profile", "About you, goals, discipline & bodyweight")}
        ${item("family", "Family", "The people your coach plans around")}
        ${item("life", "Life", "Trips, injuries & events on your timeline")}
        ${item("memory", "Memory", "What Cairn remembers about you")}
      </div>`;
            slot.querySelectorAll("[data-you]").forEach((b) => b.addEventListener("click", () => {
                state.meSeg = (b.dataset.you || "profile");
                activateTab("me");
            }));
        }
        const SLICES = { you: renderYouSlice, agents: renderAgentsSlice, sources: renderSourcesSlice, automation: renderAutomationSlice, data: renderDataSlice };
        const paintSlice = (key) => (SLICES[key || "agents"] || renderAgentsSlice)();
        // Sub-tab switch: slide the thumb, swap ONLY #setSlice from the working model (no
        // refetch, edits preserved), keep the save bar mounted on the stable sentinel.
        view.querySelectorAll(".segbtn").forEach((b) => b.addEventListener("click", () => {
            const key = b.dataset.seg;
            if (!key || !SLICES[key] || key === state.setSeg)
                return;
            state.setSeg = key;
            const seg = b.closest(".seg");
            if (seg) {
                // Slide the ink thumb AND move the .active state (paper text) with it — the
                // shell persists across slice swaps, so without this the active class stays
                // stuck on the first tab (cream-on-cream, invisible) while the thumb is
                // elsewhere. Mirrors setHealthSegActive.
                const btns = [...seg.querySelectorAll(".segbtn")];
                seg.style.setProperty("--segi", String(btns.indexOf(b)));
                btns.forEach((x) => x.classList.toggle("active", x === b));
            }
            if (typeof syncRouteFromState === "function")
                syncRouteFromState();
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
})();
