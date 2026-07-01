(() => {
// @ts-check
// Today plan/session model: deterministic selected-day, set grouping, item
// partitioning, pending off-plan pruning, and prefill decisions.
(() => {
    function planItems(day) {
        return Array.isArray(day?.items) ? day.items : [];
    }
    function groupLoggedSets(session) {
        const loggedByEx = {};
        if (session) {
            for (const set of session.sets || []) {
                if (!set?.exercise)
                    continue;
                (loggedByEx[set.exercise] ??= []).push(set);
            }
        }
        for (const key of Object.keys(loggedByEx)) {
            loggedByEx[key].sort((a, b) => (a.set_number ?? 0) - (b.set_number ?? 0));
        }
        return loggedByEx;
    }
    function selectedPlanDay(state, revealBlank) {
        if (revealBlank && state.day === null)
            return { day_number: 0, name: "", items: [] };
        return state.plan.find((day) => day.day_number === state.day) || state.plan[0] || { day_number: 0, name: "", items: [] };
    }
    function matchCardioEfforts(items, efforts, matches) {
        const matched = new Map();
        if (!items.length || !efforts.length)
            return matched;
        const pool = [...efforts];
        for (const item of items) {
            const index = pool.findIndex((effort) => matches(item, effort));
            if (index >= 0)
                matched.set(item, pool.splice(index, 1)[0]);
        }
        return matched;
    }
    function itemGroups(params) {
        const planNames = new Set(params.items.filter((item) => !params.isCardioItem(item) && item.exercise).map((item) => String(item.exercise)));
        const skippedSet = new Set((params.skips || []).map((name) => String(name).toLowerCase()));
        const isSkipped = (item) => params.isCardioItem(item)
            ? skippedSet.has(params.cardioLabel(item).toLowerCase()) && !params.matchedCardio.has(item)
            : !!item.exercise && skippedSet.has(String(item.exercise).toLowerCase()) && !(params.loggedByEx[String(item.exercise)] || []).length;
        const activeItems = params.items.filter((item) => !isSkipped(item));
        const skippedItems = params.items.filter(isSkipped);
        const cardioItems = activeItems.filter(params.isCardioItem);
        const strengthItems = activeItems.filter((item) => !params.isCardioItem(item));
        const planEx = activeItems.filter((item) => !params.isCardioItem(item) && item.exercise).map((item) => String(item.exercise));
        const offPlanEx = Object.keys(params.loggedByEx).filter((name) => !planNames.has(name));
        return { planNames, activeItems, skippedItems, cardioItems, strengthItems, planEx, offPlanEx };
    }
    function prunePendingOffPlan(state, planNames, loggedByEx) {
        const planLower = new Set([...planNames].map((name) => name.toLowerCase()));
        const loggedLower = new Set(Object.keys(loggedByEx).map((name) => name.toLowerCase()));
        const pending = state.pendingOffPlan?.[state.logDate] ?? [];
        const kept = pending.filter((item) => item && item.name && !planLower.has(item.name.toLowerCase()) && !loggedLower.has(item.name.toLowerCase()));
        if (state.pendingOffPlan && state.pendingOffPlan[state.logDate])
            state.pendingOffPlan[state.logDate] = kept;
        return kept;
    }
    function prefillFor(item, loggedByEx, lastSets) {
        const exercise = String(item.exercise || "");
        const logged = loggedByEx[exercise] || [];
        if (logged.length) {
            const set = logged[logged.length - 1];
            return { weight: set.weight, reps: set.reps, rir: set.rir, duration_sec: set.duration_sec ?? null };
        }
        const last = lastSets[exercise];
        if (last)
            return { weight: last.weight, reps: last.reps, rir: last.rir, duration_sec: last.duration_sec ?? null };
        return { weight: item.target_weight ?? null, reps: item.rep_low ?? null, rir: null, duration_sec: item.target_seconds ?? null };
    }
    const CAIRN_TODAY_PLAN_SESSION_MODEL = {
        planItems,
        groupLoggedSets,
        selectedPlanDay,
        matchCardioEfforts,
        itemGroups,
        prunePendingOffPlan,
        prefillFor,
    };
    Object.assign(globalThis, { CairnTodayPlanSessionModel: CAIRN_TODAY_PLAN_SESSION_MODEL });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayPlanSessionModel: CAIRN_TODAY_PLAN_SESSION_MODEL });
    }
})();
})();
