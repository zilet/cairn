(() => {
// @ts-check
// Today render-state decisions: derive the high-level visible mode for the day
// before the screen assembles markup.
(() => {
    function derive(input) {
        const hasLoggedSets = !!(input.session && (input.session.sets || []).length);
        const hasPlanDay = !!(input.day?.items || []).length;
        const revealOn = !!(input.planReveal &&
            input.planReveal.date === input.logDate &&
            input.planReveal.on);
        const isFinished = !!(input.session && input.session.finished_at);
        const hasGarmin = !!(input.session && input.session.garmin);
        const showPlan = !input.isToday || hasLoggedSets || hasGarmin || revealOn || input.read?.kind === "train";
        const showDone = isFinished && input.isToday && !revealOn;
        return {
            hasLoggedSets,
            hasPlanDay,
            revealOn,
            isFinished,
            hasGarmin,
            showPlan,
            showDone,
        };
    }
    const CAIRN_TODAY_RENDER_STATE = { derive };
    Object.assign(globalThis, { CairnTodayRenderState: CAIRN_TODAY_RENDER_STATE });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayRenderState: CAIRN_TODAY_RENDER_STATE });
    }
})();
})();
