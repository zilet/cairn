(() => {
// @ts-check
// Today plan/logging surface renderer: done card, session surface, card ordering,
// pending off-plan cards, finish affordance, and skipped line.
(() => {
    function orderedSurfaceItems(options, deps) {
        if (options.isRunDay || options.cardioItems.length > 1 || (options.cardioItems.length && options.strengthItems.length)) {
            return [
                ...options.activeItems.filter(deps.isCardioItem),
                ...options.activeItems.filter((item) => !deps.isCardioItem(item)),
            ];
        }
        return options.activeItems;
    }
    function pendingPrefill(last) {
        if (!last)
            return { weight: null, reps: null, rir: null, duration_sec: null };
        return {
            weight: last.weight,
            reps: last.reps,
            rir: last.rir,
            duration_sec: last.duration_sec ?? null,
        };
    }
    function buildHtml(options, deps) {
        if (options.showDone) {
            return deps.sessionDoneCard(options.session, options.day, { isToday: options.isToday });
        }
        if (!options.showPlan)
            return "";
        const surfaceDeps = deps.planSurfaceDeps();
        let html = `<div class="plansurface reveal" style="--i:2">`;
        if (!options.focus) {
            html += deps.planSurface.sessionHeadHtml({
                isRunDay: options.isRunDay,
                isToday: options.isToday,
                cardioItems: options.cardioItems,
                day: options.day,
                exDone: options.exDone,
                exTotal: options.exTotal,
                hasSyncedCardioToday: options.hasSyncedCardioToday,
            }, surfaceDeps);
        }
        html += deps.planSurface.daySwitchHtml(options.plan, options.activeDay, surfaceDeps);
        html += deps.planSurface.rxBannerHtml(options.rxByEx, options.activeDay, surfaceDeps);
        const garmin = options.session && typeof options.session === "object" ? options.session.garmin : null;
        if (options.hasGarmin)
            html += deps.garminSessionCard(garmin);
        let cardIdx = 0;
        let syncLineUsed = false;
        for (const item of orderedSurfaceItems(options, deps)) {
            if (deps.isCardioItem(item)) {
                const matched = options.matchedCardio.get(item) || null;
                const line = (!matched && !syncLineUsed) ? options.syncedLine : "";
                if (line)
                    syncLineUsed = true;
                html += deps.cardioPlanCard(item, cardIdx++, matched, line);
                continue;
            }
            const exerciseName = String(item.exercise || "");
            html += deps.exCard({ ...item, fromPlan: true }, options.loggedByEx[exerciseName] || [], options.prefillFor(item), cardIdx++, options.rxFor(exerciseName));
        }
        for (const exercise of options.offPlanEx) {
            const logged = options.loggedByEx[exercise] || [];
            const latest = logged[logged.length - 1];
            html += deps.exCard({ exercise, fromPlan: false }, logged, { weight: latest?.weight, reps: latest?.reps, rir: latest?.rir }, cardIdx++, options.rxFor(exercise));
        }
        for (const pending of options.pendingOffPlan) {
            html += deps.exCard({ exercise: pending.name, fromPlan: false, mode: pending.mode || null }, [], pendingPrefill(options.lastSets[pending.name]), cardIdx++, options.rxFor(pending.name));
        }
        html += deps.planSurface.addExerciseFormHtml();
        if (options.hasLoggedSets) {
            html += deps.planSurface.finishHtml(options.session || {}, { isToday: options.isToday, logDate: options.logDate }, surfaceDeps);
        }
        html += deps.skipLineHtml(options.skippedItems.map((item) => (deps.isCardioItem(item) ? deps.cardioLabel(item) : String(item.exercise || ""))));
        html += `</div>`;
        return html;
    }
    const CAIRN_TODAY_PLAN_SURFACE_RENDERER = {
        buildHtml,
    };
    Object.assign(globalThis, { CairnTodayPlanSurfaceRenderer: CAIRN_TODAY_PLAN_SURFACE_RENDERER });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayPlanSurfaceRenderer: CAIRN_TODAY_PLAN_SURFACE_RENDERER });
    }
})();
})();
