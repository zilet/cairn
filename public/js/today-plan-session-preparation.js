(() => {
// @ts-check
// Today plan/session preparation: selected day, skips, cardio matches, last-set
// prefill, pending off-plan cards, and adaptive prescriptions.
(() => {
    function recordValue(value) {
        return value && typeof value === "object" ? value : {};
    }
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
    function pendingForDate(deps, planNames, loggedByEx) {
        const planLower = new Set([...planNames].map((name) => name.toLowerCase()));
        const loggedLower = new Set(Object.keys(loggedByEx).map((name) => name.toLowerCase()));
        const pending = deps.state.pendingOffPlan?.[deps.state.logDate] ?? [];
        const kept = pending.filter((item) => item && item.name && !planLower.has(item.name.toLowerCase()) && !loggedLower.has(item.name.toLowerCase()));
        if (deps.state.pendingOffPlan && deps.state.pendingOffPlan[deps.state.logDate])
            deps.state.pendingOffPlan[deps.state.logDate] = kept;
        return kept;
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
    async function preparePlanSession(deps) {
        const loggedByEx = groupLoggedSets(deps.session);
        const revealBlank = !!(deps.state.planReveal && deps.state.planReveal.date === deps.state.logDate && deps.state.planReveal.on && deps.state.planReveal.blank);
        const hasSelectedDay = deps.state.plan.some((day) => day.day_number === deps.state.day);
        if (revealBlank && !deps.state.dayPicked) {
            deps.state.day = null;
        }
        else if (!deps.state.dayPicked || deps.state.day === null || !hasSelectedDay) {
            deps.state.day = await deps.suggestedPlanDayNumber(deps.session, deps.isToday);
            deps.state.dayPicked = false;
        }
        const day = selectedPlanDay(deps.state, revealBlank);
        const items = planItems(day);
        const planNames = new Set(items.filter((item) => !deps.isCardioItem(item) && item.exercise).map((item) => String(item.exercise)));
        const { allCardio, cardioEfforts, todaySettings } = await loadCardioContext(items, deps.isToday, deps);
        const matchedCardio = matchCardioEfforts(allCardio, cardioEfforts, deps.cardioEffortMatches);
        const skippedSet = new Set(((deps.session && deps.session.skips) || []).map((name) => String(name).toLowerCase()));
        const isSkipped = (item) => deps.isCardioItem(item)
            ? skippedSet.has(deps.cardioLabel(item).toLowerCase()) && !matchedCardio.has(item)
            : !!item.exercise && skippedSet.has(String(item.exercise).toLowerCase()) && !(loggedByEx[String(item.exercise)] || []).length;
        const activeItems = items.filter((item) => !isSkipped(item));
        const skippedItems = items.filter(isSkipped);
        const cardioItems = activeItems.filter(deps.isCardioItem);
        const strengthItems = activeItems.filter((item) => !deps.isCardioItem(item));
        const planEx = activeItems.filter((item) => !deps.isCardioItem(item) && item.exercise).map((item) => String(item.exercise));
        const offPlanEx = Object.keys(loggedByEx).filter((name) => !planNames.has(name));
        const pendingOffPlan = pendingForDate(deps, planNames, loggedByEx);
        const lastSets = await loadLastSets([...planEx, ...pendingOffPlan.map((item) => item.name)], loggedByEx, deps);
        const rxByEx = await loadPrescriptions(deps.state.day, planEx, deps);
        const rxFor = (name) => (name ? rxByEx[String(name).toLowerCase()] || null : null);
        const prefillFor = (item) => {
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
        };
        const exDone = strengthItems.filter((item) => (loggedByEx[String(item.exercise)] || []).length).length;
        const exTotal = strengthItems.length;
        const hasSyncedCardioToday = cardioEfforts.length > 0;
        const isRunDay = (cardioItems.length > 0 || hasSyncedCardioToday) && exTotal === 0;
        const expectingRun = deps.isToday && cardioItems.length > 0 && !cardioItems.some((item) => matchedCardio.has(item));
        return {
            revealBlank,
            day,
            loggedByEx,
            planNames,
            allCardio,
            cardioEfforts,
            todaySettings,
            matchedCardio,
            activeItems,
            skippedItems,
            cardioItems,
            strengthItems,
            planEx,
            offPlanEx,
            pendingOffPlan,
            lastSets,
            rxByEx,
            rxFor,
            prefillFor,
            exDone,
            exTotal,
            hasSyncedCardioToday,
            isRunDay,
            expectingRun,
        };
    }
    const CAIRN_TODAY_PLAN_SESSION_PREPARATION = {
        groupLoggedSets,
        matchCardioEfforts,
        preparePlanSession,
    };
    Object.assign(globalThis, { CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION });
    }
})();
})();
