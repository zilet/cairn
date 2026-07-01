(() => {
// @ts-check
// Stateful Today Brief controller: fetch/cache, steer jobs, focus state, and reconnect wiring.
(() => {
    let agentOfflineDismissed = false;
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
    function wireAgentOffline(scope, deps) {
        (scope || deps.root).querySelectorAll("[data-agentoffx]").forEach((button) => button.addEventListener("click", () => {
            agentOfflineDismissed = true;
            const el = button.closest(".agent-offline");
            if (el)
                deps.collapseEl(el, () => el.remove());
            else
                button.remove();
        }));
    }
    function briefHtml(read, options = {}, deps) {
        const activeOverride = deps.state.brief && deps.state.brief.date === deps.state.logDate ? deps.state.brief.override : "";
        return CairnTodayBrief.briefHtml(read, {
            showPlan: !!options.showPlan,
            isToday: !!options.isToday,
            activeOverride,
            morph: !!deps.state._briefMorph,
            reducedMotion: deps.reducedMotion(),
            offlineDismissed: agentOfflineDismissed,
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
        const brief = deps.root.querySelector(".brief");
        if (!brief)
            return;
        wireAgentOffline(brief, deps);
        brief.querySelectorAll("[data-override]").forEach((button) => button.addEventListener("click", () => {
            const intent = button.dataset.override || "";
            if (brief.classList.contains("is-thinking"))
                return;
            paintBriefReshaping(brief, button, deps);
            deps.state.brief = null;
            deps.runOp("day_read_override", { date: deps.state.logDate, override: intent, agent: "auto" }, dayReadOverrideOpOpts({ intent, prevFocus: read.focus }, deps));
        }));
        brief.querySelectorAll("[data-redirect]").forEach((button) => button.addEventListener("click", () => {
            const action = button.dataset.redirect;
            if (action === "ask-session") {
                deps.revealSessionComposer();
                return;
            }
            if (action === "view-week") {
                deps.activateTab("plan");
                return;
            }
            if (action === "view-program") {
                deps.state.progressSeg = "program";
                deps.activateTab("progress");
                return;
            }
            if (action === "start-session") {
                deps.revealPlanThen(() => {
                    const surface = deps.root.querySelector(".plansurface") || deps.root.querySelector(".addex");
                    surface?.scrollIntoView({ behavior: deps.reducedMotion() ? "auto" : "smooth", block: "start" });
                });
                return;
            }
            if (action === "reveal-plan") {
                deps.state.planReveal = { date: deps.state.logDate, on: true };
                deps.renderToday();
                return;
            }
            if (action === "pull-plan") {
                deps.state.planReveal = { date: deps.state.logDate, on: true };
                deps.state.dayPicked = true;
                deps.renderToday();
            }
        }));
        const steerReset = brief.querySelector("[data-steerreset]");
        if (steerReset)
            steerReset.addEventListener("click", async () => {
                if (brief.classList.contains("is-thinking"))
                    return;
                brief.querySelectorAll(".brief-steer-opt").forEach((chip) => { chip.disabled = true; });
                if (steerReset instanceof HTMLButtonElement)
                    steerReset.disabled = true;
                steerReset.innerHTML = `<span class="aspin aspin-xs"></span>back to today's read`;
                brief.classList.add("is-thinking");
                const note = document.createElement("div");
                note.className = "athinking-note chip-in";
                note.textContent = "Reading the day again...";
                (steerReset.closest(".brief-steer") || steerReset.parentElement)?.after(note);
                deps.state.brief = null;
                try {
                    const qs = new URLSearchParams({ date: deps.state.logDate, agent: "auto", reset: "1" });
                    const fresh = await deps.api("/today-read?" + qs.toString());
                    deps.state.brief = {
                        date: deps.state.logDate,
                        override: fresh && fresh.override ? fresh.override : "",
                        read: fresh && fresh.kind ? fresh : { kind: "train", headline: "Today", why: "", focus: null, est_minutes: null, signals: {}, source: "deterministic" },
                    };
                }
                catch {
                    deps.state.brief = null;
                }
                if (deps.state.tab !== "today")
                    return;
                const morph = !deps.reducedMotion();
                if (morph) {
                    brief.classList.add("brief-morph");
                    deps.state._briefMorph = true;
                }
                try {
                    await deps.withViewTransition(() => deps.renderToday());
                }
                finally {
                    deps.state._briefMorph = false;
                    deps.root.querySelector(".brief")?.classList.remove("brief-morph");
                }
            });
        const whyBtn = brief.querySelector("[data-briefwhy]");
        if (whyBtn && read.signals && Object.keys(read.signals).length) {
            whyBtn.hidden = false;
            whyBtn.addEventListener("click", () => {
                if (brief.querySelector(".brief-signals")) {
                    brief.querySelector(".brief-signals")?.remove();
                    whyBtn.textContent = "tap to see why";
                    return;
                }
                const sig = document.createElement("p");
                sig.className = "brief-signals chip-in";
                sig.textContent = briefSignalsText(read);
                whyBtn.before(sig);
                whyBtn.textContent = "hide";
            });
        }
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
