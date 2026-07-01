(() => {
// @ts-check
// Today plan-day selection: infer which plan day a session belongs to, then pick
// the next calm default when the athlete opens Today without explicitly choosing.
(() => {
    function planDayNumberForSession(session, plan) {
        const days = Array.isArray(plan) ? plan : [];
        if (!session || !(session.sets || []).length)
            return null;
        const byId = days.find((day) => Number(day.id) === Number(session.plan_day_id));
        if (byId)
            return byId.day_number;
        const loggedNames = new Set((session.sets || []).map((set) => set.exercise).filter(Boolean));
        let best = null;
        for (const day of days) {
            const plannedNames = new Set((day.items || []).map((item) => item.exercise));
            let hits = 0;
            loggedNames.forEach((name) => { if (plannedNames.has(name))
                hits++; });
            if (hits && (!best || hits > best.hits))
                best = { day_number: day.day_number, hits };
        }
        return best?.day_number ?? null;
    }
    function nextPlanDayNumber(dayNumber, plan) {
        const ordered = [...(Array.isArray(plan) ? plan : [])].sort((a, b) => a.day_number - b.day_number);
        if (!ordered.length)
            return null;
        const idx = ordered.findIndex((day) => day.day_number === dayNumber);
        return ordered[idx >= 0 ? (idx + 1) % ordered.length : 0].day_number;
    }
    async function suggestedPlanDayNumber(session, isToday, deps) {
        const plan = deps.state.plan || [];
        const currentLoggedDay = planDayNumberForSession(session, plan);
        if (currentLoggedDay)
            return currentLoggedDay;
        if (!isToday)
            return plan[0]?.day_number ?? 1;
        try {
            const recent = await deps.api("/sessions?limit=20");
            const rows = Array.isArray(recent) ? recent : [];
            const latest = rows.find((row) => row.date !== deps.state.logDate && planDayNumberForSession(row, plan));
            const latestDay = planDayNumberForSession(latest, plan);
            return latestDay ? (nextPlanDayNumber(latestDay, plan) ?? plan[0]?.day_number ?? 1) : (plan[0]?.day_number ?? 1);
        }
        catch {
            return plan[0]?.day_number ?? 1;
        }
    }
    const CAIRN_TODAY_PLAN_SELECTION = {
        nextPlanDayNumber,
        planDayNumberForSession,
        suggestedPlanDayNumber,
    };
    Object.assign(globalThis, { CairnTodayPlanSelection: CAIRN_TODAY_PLAN_SELECTION });
    if (typeof window !== "undefined") {
        window.CairnTodayPlanSelection = CAIRN_TODAY_PLAN_SELECTION;
    }
})();
})();
