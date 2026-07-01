(() => {
// @ts-check
// Today data loader: cache peeks, cold skeleton paint, primary data fetch, and
// soft SWR refresh gating. Rendering stays in today-screen.
(() => {
    async function loadInner(opts, deps) {
        const soft = !!opts?.soft;
        const token = deps.nextPollToken();
        if (!deps.state.logDate)
            deps.state.logDate = deps.localISO();
        deps.setTodayHeaderTitle();
        const sessKey = "today:session:" + deps.state.logDate;
        const peeks = {
            plan: deps.state.plan.length ? { data: deps.state.plan, fresh: true } : deps.peekCached("plan"),
            session: deps.peekCached(sessKey),
            stats: deps.peekCached("stats"),
            profile: deps.peekCached("profile"),
            exercises: deps.peekCached("exercises"),
        };
        const statsPromise = peeks.stats ? Promise.resolve(peeks.stats.data) : deps.api("/stats");
        const profilePromise = peeks.profile ? Promise.resolve(peeks.profile.data) : deps.api("/profile").catch(() => null);
        const exercisesPromise = peeks.exercises ? Promise.resolve(peeks.exercises.data) : deps.api("/exercises").catch(() => []);
        const warm = Object.values(peeks).every(Boolean);
        let anyChanged = false;
        const revalidations = [];
        const revalidate = (path, key) => {
            revalidations.push(deps.cachedApi(path, {
                key,
                onUpgrade: (_data, { changed }) => {
                    if (changed)
                        anyChanged = true;
                },
            }).catch(() => { }));
        };
        if (!warm && !deps.root.querySelector(".today-wrap"))
            deps.root.innerHTML = deps.todaySkeleton();
        if (!deps.state.plan.length)
            deps.state.plan = (peeks.plan ? peeks.plan.data : await deps.api("/plan"));
        revalidate("/plan", "plan");
        const isToday = deps.state.logDate === deps.localISO();
        const session = peeks.session ? peeks.session.data : await deps.api("/sessions?date=" + deps.state.logDate);
        revalidate("/sessions?date=" + deps.state.logDate, sessKey);
        const [stats, profile, exercises] = await Promise.all([statsPromise, profilePromise, exercisesPromise]);
        revalidate("/stats", "stats");
        revalidate("/profile", "profile");
        revalidate("/exercises", "exercises");
        return {
            soft,
            token,
            isToday,
            session,
            stats,
            profile,
            exercises,
            revalidations,
            changed: () => anyChanged,
        };
    }
    function scheduleSoftRepaint(result, deps) {
        if (!result.revalidations.length)
            return;
        Promise.all(result.revalidations).then(() => {
            if (!result.changed())
                return;
            if (!deps.isCurrentPoll(result.token) || deps.state.tab !== "today")
                return;
            const active = document.activeElement;
            if (active && (active.closest?.(".ex") ||
                active.closest?.(".quicklog") ||
                active.closest?.(".addex") ||
                active.closest?.(".wt-inline")))
                return;
            if (deps.root.querySelector(".brief.is-thinking"))
                return;
            deps.renderToday({ soft: true });
        });
    }
    const CAIRN_TODAY_DATA_LOADER = {
        load: loadInner,
        scheduleSoftRepaint,
    };
    Object.assign(globalThis, { CairnTodayDataLoader: CAIRN_TODAY_DATA_LOADER });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayDataLoader: CAIRN_TODAY_DATA_LOADER });
    }
})();
})();
