(() => {
// @ts-check
// Stateful Today Brief controller: fetch/cache, focus state, and reconnect wiring.
(() => {
    function provisionalRead(_date) {
        return CairnTodayBrief.provisionalRead();
    }
    async function loadBrief(date, override, deps, opts = {}) {
        const cached = deps.state.brief;
        if (cached && cached.date === date && cached.override === (override || "") && !cached.read._provisional)
            return cached.read;
        const fetchRead = (async () => {
            let read = null;
            try {
                const qs = new URLSearchParams({ date, agent: "auto" });
                if (override)
                    qs.set("override", override);
                read = await deps.api("/today-read?" + qs.toString());
            }
            catch {
                read = null;
            }
            if (!read || !read.kind)
                read = provisionalRead(date);
            return read;
        })();
        if (opts.fast) {
            const timeout = 1200;
            const raced = await Promise.race([
                fetchRead.then((r) => ({ r })),
                new Promise((resolve) => setTimeout(() => resolve(null), timeout)),
            ]);
            if (raced && raced.r && !raced.r._provisional) {
                deps.state.brief = { date, override: override || raced.r.override || "", read: raced.r };
                return raced.r;
            }
            deps.state._briefInflight = { date, override: override || "", promise: fetchRead };
            const prov = (raced && raced.r) || provisionalRead(date);
            deps.state.brief = { date, override: override || "", read: prov };
            return prov;
        }
        deps.state._briefInflight = null;
        const read = await fetchRead;
        deps.state.brief = { date, override: override || read.override || "", read };
        return read;
    }
    async function upgradeBriefInPlace(date, isToday, deps) {
        const inflight = deps.state._briefInflight;
        if (!inflight || inflight.date !== date)
            return;
        const briefEl = deps.root.querySelector(".brief");
        if (briefEl && !deps.reducedMotion())
            briefEl.classList.add("is-thinking");
        let read = null;
        try {
            read = await inflight.promise;
        }
        catch {
            read = null;
        }
        if (deps.state.tab !== "today" || deps.state.logDate !== date)
            return;
        if (deps.state._briefInflight === inflight)
            deps.state._briefInflight = null;
        if (!read || read._provisional) {
            briefEl?.classList.remove("is-thinking");
            return;
        }
        deps.state.brief = { date, override: inflight.override || read.override || "", read };
        const live = deps.root.querySelector(".brief");
        if (!live)
            return;
        const day = deps.state.plan.find((d) => d.day_number === deps.state.day) || deps.state.plan[0] || { items: [] };
        const hasPlanDay = (day.items || []).length > 0;
        const showPlan = !!deps.root.querySelector(".plansurface");
        const tmp = document.createElement("div");
        tmp.innerHTML = briefHtml(read, { showPlan, hasPlanDay, isToday }, deps);
        const fresh = tmp.firstElementChild;
        if (!fresh) {
            live.classList.remove("is-thinking");
            return;
        }
        fresh.classList.add(deps.reducedMotion() ? "" : "brief-settle");
        live.replaceWith(fresh);
        wireBrief(read, { isToday }, deps);
        deps.runCountUps(fresh);
        if (showPlan)
            deps.loadTrainingProvenance(isToday);
    }
    async function reshapeToday(deps) {
        deps.state.brief = null;
        deps.invalidate("today:session:" + deps.state.logDate);
        deps.invalidate("stats");
        deps.invalidate("progress:energy");
        if (deps.state.tab !== "today")
            return;
        await loadBrief(deps.state.logDate, "", deps);
        if (deps.state.tab !== "today")
            return;
        const morph = !deps.reducedMotion();
        if (morph) {
            deps.root.querySelector(".brief")?.classList.add("brief-morph");
            deps.state._briefMorph = true;
        }
        try {
            await deps.withViewTransition(() => deps.renderToday());
        }
        finally {
            deps.state._briefMorph = false;
            deps.root.querySelector(".brief")?.classList.remove("brief-morph");
        }
    }
    function briefHtml(read, options = {}, deps) {
        const activeOverride = deps.state.brief && deps.state.brief.date === deps.state.logDate ? deps.state.brief.override : "";
        return CairnTodayBrief.briefHtml(read, {
            showPlan: !!options.showPlan,
            isToday: !!options.isToday,
            activeOverride,
            morph: !!deps.state._briefMorph,
            reducedMotion: deps.reducedMotion(),
            offlineDismissed: CairnTodayBriefActionsClient.offlineDismissed(),
        });
    }
    function focusEngaged(date, options, deps) {
        if (!options.showPlan)
            return false;
        const f = deps.state.focus;
        if (f && f.date === date)
            return f.on;
        return !!(options.isToday && options.hasLoggedSets);
    }
    function setFocus(date, on, deps) {
        deps.state.focus = { date, on };
    }
    function focusBarHtml(read, day, options) {
        return CairnTodayBrief.focusBarHtml(read, day, { ...options, isToday: !!options.isToday });
    }
    function briefSignalsText(read) {
        return CairnTodayBrief.signalsText(read);
    }
    function wireBrief(read, options, deps) {
        CairnTodayBriefActionsClient.wireBriefActions(read, options, deps);
    }
    function paintBriefReshaping(brief, chip, deps) {
        CairnTodayBriefOverrideClient.paintBriefReshaping(brief, chip, deps);
    }
    function dayReadOverrideOpOpts(args = {}, deps) {
        return CairnTodayBriefOverrideClient.dayReadOverrideOpOpts(args, deps);
    }
    function reconnectDayReadOverride(job, deps) {
        return CairnTodayBriefOverrideClient.reconnectDayReadOverride(job, deps);
    }
    const CAIRN_TODAY_BRIEF_CONTROLLER = {
        briefHtml,
        briefSignalsText,
        dayReadOverrideOpOpts,
        focusBarHtml,
        focusEngaged,
        loadBrief,
        paintBriefReshaping,
        provisionalRead,
        reconnectDayReadOverride,
        reshapeToday,
        setFocus,
        upgradeBriefInPlace,
        wireBrief,
    };
    Object.assign(globalThis, { CairnTodayBriefController: CAIRN_TODAY_BRIEF_CONTROLLER });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayBriefController: CAIRN_TODAY_BRIEF_CONTROLLER });
    }
})();
})();
