(() => {
// @ts-check
// Today adapted-prescription refresh wiring for set logging.
(() => {
    let rxRefreshTimer = null;
    function progressionKey(day) {
        return `program:progression:${day}`;
    }
    function scheduleRxRefresh(deps) {
        if (deps.state.day == null)
            return;
        if (rxRefreshTimer != null)
            clearTimeout(rxRefreshTimer);
        rxRefreshTimer = setTimeout(() => {
            void refreshAdaptedRx(deps);
        }, 600);
    }
    function invalidateTodayProgression(deps) {
        if (deps.state.day != null)
            deps.invalidate(progressionKey(deps.state.day));
    }
    async function refreshAdaptedRx(deps) {
        if (deps.state.tab !== "today" || deps.state.day == null)
            return;
        const day = deps.state.day;
        const date = deps.state.logDate;
        let list;
        try {
            list = await deps.cachedApi("/program/progression?day=" + encodeURIComponent(day), {
                key: progressionKey(day),
                freshFor: 15000,
            });
        }
        catch {
            return;
        }
        if (deps.state.tab !== "today" || deps.state.day !== day || deps.state.logDate !== date)
            return;
        if (!Array.isArray(list))
            return;
        const rxByEx = {};
        for (const rx of list) {
            const row = rx && typeof rx === "object" ? rx : null;
            if (row?.exercise)
                rxByEx[String(row.exercise).toLowerCase()] = row;
        }
        deps.root.querySelectorAll(".ex[data-card]").forEach((card) => {
            const name = (card.dataset.card || "").toLowerCase();
            const rx = name ? rxByEx[name] || null : null;
            const complete = card.classList.contains("ex-complete");
            const existing = card.querySelector(".ex-rx");
            const html = complete ? "" : deps.exRxLineHtml(rx);
            if (existing) {
                if (!html) {
                    existing.remove();
                    return;
                }
                const tpl = document.createElement("template");
                tpl.innerHTML = html.trim();
                const fresh = tpl.content.firstChild;
                if (fresh)
                    existing.replaceWith(fresh);
            }
            else if (html) {
                const tpl = document.createElement("template");
                tpl.innerHTML = html.trim();
                const fresh = tpl.content.firstChild;
                const loggedWrap = card.querySelector("[data-logged]");
                if (fresh && loggedWrap)
                    card.insertBefore(fresh, loggedWrap);
            }
        });
        const banner = deps.root.querySelector(".rx-banner");
        if (banner) {
            const moves = deps.moveCount(rxByEx);
            if (moves === 0)
                banner.remove();
            else {
                const heading = banner.querySelector(".rx-banner-h");
                if (heading)
                    heading.textContent = `${moves === 1 ? "One lift has a new target" : `${moves} lifts have new targets`} from what you logged`;
            }
        }
        deps.loadProgramAdjustmentsBanner();
    }
    const CAIRN_TODAY_PROGRESSION_CONTROLLER = {
        invalidateTodayProgression,
        refreshAdaptedRx,
        scheduleRxRefresh,
    };
    Object.assign(globalThis, { CairnTodayProgressionController: CAIRN_TODAY_PROGRESSION_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnTodayProgressionController = CAIRN_TODAY_PROGRESSION_CONTROLLER;
    }
})();
})();
