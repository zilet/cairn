(() => {
// @ts-check
// Today rail salience wiring: agenda fetch, slot loaders, and generic-card actions.
(() => {
    function loaderMap(deps) {
        const loadTodayReads = () => deps.loadTodayReads();
        return {
            fuel: () => deps.loadFuelToday(deps.state.logDate),
            "week-ahead": () => deps.loadWeekAhead(),
            "program-adjustments": () => deps.loadProgramAdjustmentsBanner(),
            "weekly-read": loadTodayReads,
            "connection-insight": loadTodayReads,
            "garmin-reconcile": () => deps.loadGarminReconcile(),
            lately: () => deps.loadRecentActivities(),
        };
    }
    async function fetchTodayAgenda(date, deps) {
        try {
            const agenda = await deps.api("/today-agenda?date=" + encodeURIComponent(date || deps.state.logDate));
            const row = agenda && typeof agenda === "object" ? agenda : null;
            if (!row || !Array.isArray(row.primary) || !Array.isArray(row.more))
                return null;
            return row;
        }
        catch {
            return null;
        }
    }
    function railHtml(agenda, genericPending) {
        return CairnTodayAgenda.railHtml(agenda, genericPending);
    }
    function runAgendaRail(agenda, genericPending, deps) {
        const called = new Set();
        const loaders = loaderMap(deps);
        const buckets = CairnTodayAgenda.renderableBuckets(agenda);
        for (const candidate of [...buckets.primary, ...buckets.more]) {
            const key = candidate.client_card;
            if (!key)
                continue;
            const loader = loaders[key];
            if (!loader || called.has(loader))
                continue;
            called.add(loader);
            try {
                loader();
            }
            catch { }
        }
        wireGenericAgendaCards(genericPending, deps);
    }
    function wireGenericAgendaCards(pending, deps) {
        if (!pending.length)
            return;
        deps.root.querySelectorAll("[data-agenda-act]").forEach((button) => {
            if (button.dataset.wired)
                return;
            button.dataset.wired = "1";
            button.addEventListener("click", () => {
                const kind = button.getAttribute("data-agenda-act") || "";
                const id = button.getAttribute("data-agenda-id") || "";
                const candidate = pending.find((item) => item.id === id);
                const action = candidate?.action;
                const payload = action?.payload;
                if (kind.startsWith("chat")) {
                    deps.gotoChatWith(typeof payload === "string" ? payload : candidate?.title || "");
                    return;
                }
                if (kind === "plan-coach") {
                    deps.state.planJump = "coach";
                    deps.activateTab("plan");
                    return;
                }
                if (kind === "plan-endurance") {
                    deps.state.planJump = "endurance";
                    deps.activateTab("plan");
                    return;
                }
                if (kind === "me-health-standing") {
                    deps.state.meSeg = "standing";
                    deps.activateTab("me");
                    return;
                }
                if (kind === "me-health-read") {
                    deps.state.meSeg = "health";
                    deps.state.healthSeg = "read";
                    deps.state.healthSegPicked = true;
                    deps.activateTab("me");
                    return;
                }
                if (kind.startsWith("tab:"))
                    deps.activateTab(kind.slice(4));
            });
        });
        deps.root.querySelectorAll("[data-agenda-dismiss]").forEach((button) => {
            if (button.dataset.wired)
                return;
            button.dataset.wired = "1";
            button.addEventListener("click", () => {
                const card = button.closest(".agenda-card");
                if (card)
                    deps.collapseEl(card, () => card.remove());
                else
                    button.remove();
            });
        });
    }
    const CAIRN_TODAY_RAIL_CONTROLLER = {
        fetchTodayAgenda,
        railHtml,
        runAgendaRail,
        wireGenericAgendaCards,
    };
    Object.assign(globalThis, { CairnTodayRailController: CAIRN_TODAY_RAIL_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnTodayRailController = CAIRN_TODAY_RAIL_CONTROLLER;
    }
})();
})();
