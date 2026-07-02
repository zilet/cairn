(() => {
// @ts-check
{
    function routeDefinitions() {
        const root = (typeof window !== "undefined" ? window : globalThis);
        return root.CairnRoutes?.routeDefinitions || null;
    }
    const ROUTE_TABS = [...(routeDefinitions()?.tabs || ["today"])];
    function itemKey(item) {
        return String(Array.isArray(item) ? item[0] : item);
    }
    function routeKey(key, items, fallback = null) {
        const s = String(key || "");
        return (items || []).some((item) => itemKey(item) === s) ? s : fallback;
    }
    function tabKey(tab) {
        const s = String(tab || "");
        return ROUTE_TABS.includes(s) ? s : "today";
    }
    // Legacy me/standing + me/health/* deep links redirect into the Stand tab, where
    // every health surface now lives first-class. Old bookmarks keep working.
    const LEGACY_HEALTH_TO_STAND = {
        read: null, // the overview IS the read
        markers: "markers",
        records: "records",
        share: "share",
        learned: "learned",
    };
    function applyRouteState(route, options) {
        if (!route)
            return "today";
        const { state } = options;
        if (route.date)
            state.logDate = route.date;
        const tab = tabKey(route.tab);
        if (tab === "plan") {
            const section = routeKey(route.section, options.routeApi?.planSections || options.planSections, "edit");
            state.planSeg = section;
            state.planJump = section === "edit" ? null : section;
        }
        else if (tab === "progress") {
            state.progressSeg = routeKey(route.section, options.progressSections, state.progressSeg || null);
        }
        else if (tab === "stand") {
            state.standSeg = routeKey(route.section, options.standSections, null);
            if (state.standSeg === "records")
                state.pendingHealthDocId = route.id || null;
        }
        else if (tab === "me") {
            // Match the RAW section for the legacy redirects — "standing"/"health" are
            // no longer Me seg-bar entries, so routeKey would fall back to profile.
            const rawSection = String(route.section || "");
            if (rawSection === "standing") {
                state.standSeg = "age";
                return "stand";
            }
            if (rawSection === "health") {
                const healthSection = routeKey(route.healthSection, options.healthSections, "read");
                state.standSeg = (LEGACY_HEALTH_TO_STAND[healthSection] ?? null);
                if (state.standSeg === "records")
                    state.pendingHealthDocId = route.id || null;
                return "stand";
            }
            state.meSeg = routeKey(route.section, options.meSections, "profile");
        }
        else if (tab === "settings") {
            state.setSeg = routeKey(route.section, options.settingsSections, state.setSeg || "agents");
        }
        else if (tab === "chat") {
            state.pendingChatSession = route.session || null;
        }
        return tab;
    }
    function currentRouteState(options) {
        const { state } = options;
        const tab = tabKey(state.tab);
        const route = { tab };
        if (tab === "today") {
            if (state.logDate)
                route.date = state.logDate;
        }
        else if (tab === "session") {
            if (state.logDate)
                route.date = state.logDate;
        }
        else if (tab === "plan") {
            const section = routeKey(state.planJump || state.planSeg, options.planSections, "edit");
            route.section = section;
            if (section === "food" && state.logDate)
                route.date = state.logDate;
        }
        else if (tab === "progress") {
            route.section = routeKey(state.progressSeg || options.defaultProgressSection, options.progressSections, options.defaultProgressSection);
        }
        else if (tab === "stand") {
            route.section = routeKey(state.standSeg, options.standSections, null);
            if (route.section === "records" && state.pendingHealthDocId)
                route.id = state.pendingHealthDocId;
        }
        else if (tab === "me") {
            route.section = routeKey(state.meSeg, options.meSections, "profile");
        }
        else if (tab === "settings") {
            route.section = routeKey(state.setSeg, options.settingsSections, "agents");
        }
        else if (tab === "chat" && state.pendingChatSession) {
            route.session = state.pendingChatSession;
        }
        return route;
    }
    function syncRouteFromState(options) {
        const routes = options.routes;
        const history = options.history;
        if (!routes || !history?.pushState)
            return null;
        const next = routes.routeToUrl(options.route);
        const current = `${options.location.pathname}${options.location.search}`;
        if (next === current)
            return null;
        const mode = options.mode === "replace" ? "replace" : "push";
        history[mode === "replace" ? "replaceState" : "pushState"]({ cairn: true }, "", next);
        return next;
    }
    const api = {
        ROUTE_TABS,
        routeKey,
        applyRouteState,
        currentRouteState,
        syncRouteFromState,
    };
    (typeof window !== "undefined" ? window : globalThis).CairnAppRouter = api;
}
})();
