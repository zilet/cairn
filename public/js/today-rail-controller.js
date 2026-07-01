(() => {
// @ts-check
// Today rail salience wiring: agenda fetch, slot loaders, and generic-card actions.
(() => {
    function loaderMap(deps) {
        const loadTodayReads = () => deps.loadTodayReads();
        return {
            fuel: () => loadFuelToday(deps.state.logDate, deps),
            "week-ahead": () => loadWeekAhead(deps),
            "program-adjustments": () => loadProgramAdjustmentsBanner(deps),
            "weekly-read": loadTodayReads,
            "connection-insight": loadTodayReads,
            "garmin-reconcile": () => loadGarminReconcile(deps),
            lately: () => loadRecentActivities(deps),
        };
    }
    function isCurrentToday(deps) {
        return !deps.state.tab || deps.state.tab === "today";
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
    function fallbackRailHtml(isToday) {
        return `<aside class="today-rail">
    ${isToday ? `<div id="weekAheadSlot" class="weekahead-slot"></div>` : ""}
    ${isToday ? `<div id="adjustSlot" class="adjust-slot"></div>` : ""}
    <div id="weeklySlot" class="weekly-slot"></div>
    <div id="insightSlot" class="insight-slot"></div>
    ${isToday ? `<div id="garminReconcileSlot" class="garmin-reconcile-slot"></div>` : ""}
    <div id="qlRecent" class="ql-recent lately-slot"></div>
  </aside>`;
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
    function runFallbackRail(isToday, deps) {
        loadRecentActivities(deps);
        if (!isToday)
            return;
        try {
            deps.loadTodayReads();
        }
        catch { }
        loadGarminReconcile(deps);
        loadWeekAhead(deps);
        loadProgramAdjustmentsBanner(deps);
    }
    async function loadFuelToday(date, deps) {
        const slot = deps.root.querySelector("#fuelSlot");
        if (!slot)
            return;
        let day = null;
        try {
            day = await deps.api(`/nutrition/day?date=${encodeURIComponent(date || deps.state.logDate)}`);
        }
        catch {
            return;
        }
        if (!isCurrentToday(deps) || !slot.isConnected)
            return;
        const count = day && typeof day === "object" ? Number(day.count) : 0;
        if (!(count > 0)) {
            slot.innerHTML = "";
            return;
        }
        slot.innerHTML = CairnTodayAgenda.fuelCardHtml(day);
        const card = slot.querySelector("#fuelCard");
        if (card)
            card.addEventListener("click", () => { deps.state.planJump = "food"; deps.activateTab("plan"); });
        deps.runCountUps(slot);
    }
    async function loadWeekAhead(deps) {
        const slot = deps.root.querySelector("#weekAheadSlot");
        if (!slot)
            return;
        let response = null;
        try {
            response = await deps.api("/week-ahead");
        }
        catch {
            return;
        }
        if (!isCurrentToday(deps) || !slot.isConnected)
            return;
        slot.innerHTML = CairnTodayWeekAhead.cardHtml(response);
    }
    async function loadProgramAdjustmentsBanner(deps) {
        const slot = deps.root.querySelector("#adjustSlot");
        if (!slot)
            return;
        let rows = null;
        try {
            rows = await deps.api("/program/adjustments");
        }
        catch {
            rows = null;
        }
        if (!isCurrentToday(deps) || !slot.isConnected)
            return;
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) {
            slot.innerHTML = "";
            return;
        }
        const more = CairnTodayProgramAdjustments.extraCount(list);
        slot.innerHTML = CairnTodayProgramAdjustments.bannerHtml(list);
        const card = slot.querySelector(".adjust-card");
        if (!card)
            return;
        card.addEventListener("click", (e) => {
            const target = e.target instanceof Element ? e.target : null;
            const act = target?.closest(".adjust-act");
            if (act) {
                deps.state.chatPrefill = act.getAttribute("data-req") || "";
                deps.activateTab("chat");
                return;
            }
            if (target?.closest("#adjustAll")) {
                deps.activateTab("plan");
                return;
            }
            const moreBtn = target?.closest("#adjustMore");
            if (moreBtn) {
                const open = card.classList.toggle("adjust-open");
                moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
                moreBtn.textContent = open ? "Show less" : `+${more} more in your program`;
                return;
            }
            const item = target?.closest(".adjust-item");
            if (item) {
                const open = item.getAttribute("aria-expanded") === "true";
                item.setAttribute("aria-expanded", open ? "false" : "true");
                const detail = item.parentElement?.querySelector(".adjust-detail");
                if (detail)
                    detail.hidden = open;
            }
        });
    }
    async function loadRecentActivities(deps) {
        const wrap = deps.root.querySelector("#qlRecent");
        if (!wrap)
            return;
        let rows = [];
        try {
            rows = await deps.api("/recent-training?limit=6");
        }
        catch {
            rows = [];
        }
        if (!isCurrentToday(deps) || !wrap.isConnected)
            return;
        if (!rows || !rows.length) {
            wrap.innerHTML = "";
            return;
        }
        wrap.innerHTML =
            `<div class="lately-h"><span class="ql-recent-h lbl">Lately</span>` +
                `<button class="lately-all lbl" id="latelyAll" type="button">see all →</button></div>` +
                rows.map((row) => CairnTodayLately.rowHtml(row)).join("");
        const allBtn = wrap.querySelector("#latelyAll");
        if (allBtn)
            allBtn.addEventListener("click", () => deps.activateTab("progress"));
        wrap.querySelectorAll('.lately-head[role="button"]').forEach((head) => {
            const toggle = () => {
                const row = head.closest(".lately-row");
                const detail = row && row.querySelector(".lately-detail");
                if (!detail)
                    return;
                const open = detail.hidden !== false;
                detail.hidden = !open;
                row.classList.toggle("lately-open", open);
                head.setAttribute("aria-expanded", open ? "true" : "false");
            };
            head.addEventListener("click", toggle);
            head.addEventListener("keydown", (e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle();
                }
            });
        });
    }
    async function loadGarminReconcile(deps) {
        await CairnTodayGarminReconciliation.load({
            root: deps.root,
            date: deps.state.logDate,
            isCurrentToday: () => isCurrentToday(deps),
            api: deps.api,
            escapeHtml: deps.escapeHtml,
            toast: deps.toast,
            invalidate: deps.invalidate,
            refreshToday: deps.refreshToday,
        });
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
        fallbackRailHtml,
        runAgendaRail,
        runFallbackRail,
        loadFuelToday,
        loadWeekAhead,
        loadProgramAdjustmentsBanner,
        loadRecentActivities,
        loadGarminReconcile,
        wireGenericAgendaCards,
    };
    Object.assign(globalThis, { CairnTodayRailController: CAIRN_TODAY_RAIL_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnTodayRailController = CAIRN_TODAY_RAIL_CONTROLLER;
    }
})();
})();
