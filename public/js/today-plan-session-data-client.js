(() => {
// @ts-check
// Today plan/session data loading: cache-aware last sets, adaptive
// prescriptions, and cardio context for the pure session preparer.
(() => {
    function recordValue(value) {
        return value && typeof value === "object" ? value : {};
    }
    async function loadLastSets(names, loggedByEx, deps) {
        const needLast = [...new Set(names)].filter((name) => !(loggedByEx[name] && loggedByEx[name].length));
        const lastSets = {};
        await Promise.all(needLast.map(async (name) => {
            const key = "last-set:" + name;
            const peek = deps.peekCached(key);
            if (peek) {
                lastSets[name] = peek.data;
                deps.cachedApi("/last-set?exercise=" + encodeURIComponent(name), { key }).catch(() => { });
                return;
            }
            try {
                lastSets[name] = await deps.cachedApi("/last-set?exercise=" + encodeURIComponent(name), { key });
            }
            catch {
                lastSets[name] = null;
            }
        }));
        return lastSets;
    }
    async function loadPrescriptions(day, planEx, deps) {
        const rxByEx = {};
        if (day == null || !planEx.length)
            return rxByEx;
        try {
            const list = await deps.cachedApi("/program/progression?day=" + encodeURIComponent(day), {
                key: `program:progression:${day}`,
                freshFor: 15000,
            });
            if (Array.isArray(list)) {
                for (const raw of list) {
                    const rx = recordValue(raw);
                    if (rx.exercise)
                        rxByEx[String(rx.exercise).toLowerCase()] = rx;
                }
            }
        }
        catch { }
        return rxByEx;
    }
    async function loadCardioContext(dayItems, isToday, deps) {
        const allCardio = dayItems.filter(deps.isCardioItem);
        const strengthPlanned = dayItems.some((item) => !deps.isCardioItem(item) && item.exercise);
        const couldHaveRun = allCardio.length > 0 || (isToday && !strengthPlanned);
        let cardioEfforts = [];
        let todaySettings = null;
        if (couldHaveRun) {
            [cardioEfforts, todaySettings] = await Promise.all([
                deps.api("/cardio?date=" + deps.state.logDate).catch(() => []),
                deps.api("/settings").then((result) => recordValue(result).settings || null).catch(() => null),
            ]);
            cardioEfforts = Array.isArray(cardioEfforts) ? cardioEfforts : [];
        }
        return { allCardio, cardioEfforts, todaySettings };
    }
    const CAIRN_TODAY_PLAN_SESSION_DATA = {
        loadLastSets,
        loadPrescriptions,
        loadCardioContext,
    };
    Object.assign(globalThis, { CairnTodayPlanSessionData: CAIRN_TODAY_PLAN_SESSION_DATA });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayPlanSessionData: CAIRN_TODAY_PLAN_SESSION_DATA });
    }
})();
})();
