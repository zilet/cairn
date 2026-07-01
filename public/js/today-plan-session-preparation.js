(() => {
// @ts-check
// Today plan/session preparation: selected day, skips, cardio matches, last-set
// prefill, pending off-plan cards, and adaptive prescriptions.
(() => {
    const todayPlanSessionModel = globalThis.CairnTodayPlanSessionModel;
    const todayPlanSessionData = globalThis.CairnTodayPlanSessionData;
    async function preparePlanSession(deps) {
        const loggedByEx = todayPlanSessionModel.groupLoggedSets(deps.session);
        const revealBlank = !!(deps.state.planReveal && deps.state.planReveal.date === deps.state.logDate && deps.state.planReveal.on && deps.state.planReveal.blank);
        const hasSelectedDay = deps.state.plan.some((day) => day.day_number === deps.state.day);
        if (revealBlank && !deps.state.dayPicked) {
            deps.state.day = null;
        }
        else if (!deps.state.dayPicked || deps.state.day === null || !hasSelectedDay) {
            deps.state.day = await deps.suggestedPlanDayNumber(deps.session, deps.isToday);
            deps.state.dayPicked = false;
        }
        const day = todayPlanSessionModel.selectedPlanDay(deps.state, revealBlank);
        const items = todayPlanSessionModel.planItems(day);
        const { allCardio, cardioEfforts, todaySettings } = await todayPlanSessionData.loadCardioContext(items, deps.isToday, deps);
        const matchedCardio = todayPlanSessionModel.matchCardioEfforts(allCardio, cardioEfforts, deps.cardioEffortMatches);
        const { planNames, activeItems, skippedItems, cardioItems, strengthItems, planEx, offPlanEx, } = todayPlanSessionModel.itemGroups({
            items,
            loggedByEx,
            matchedCardio,
            skips: (deps.session && deps.session.skips) || [],
            isCardioItem: deps.isCardioItem,
            cardioLabel: deps.cardioLabel,
        });
        const pendingOffPlan = todayPlanSessionModel.prunePendingOffPlan(deps.state, planNames, loggedByEx);
        const lastSets = await todayPlanSessionData.loadLastSets([...planEx, ...pendingOffPlan.map((item) => item.name)], loggedByEx, deps);
        const rxByEx = await todayPlanSessionData.loadPrescriptions(deps.state.day, planEx, deps);
        const rxFor = (name) => (name ? rxByEx[String(name).toLowerCase()] || null : null);
        const prefillFor = (item) => todayPlanSessionModel.prefillFor(item, loggedByEx, lastSets);
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
        groupLoggedSets: todayPlanSessionModel.groupLoggedSets,
        matchCardioEfforts: todayPlanSessionModel.matchCardioEfforts,
        preparePlanSession,
    };
    Object.assign(globalThis, { CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayPlanSessionPreparation: CAIRN_TODAY_PLAN_SESSION_PREPARATION });
    }
})();
})();
