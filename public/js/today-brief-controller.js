(() => {
// @ts-check
// Stateful Today Brief controller: fetch/cache and reconnect wiring.
(() => {
    // localStorage key holding the most recent REAL (agentic, no-override) day read
    // so a warm reopen paints the true sentence INSTANTLY — no invented placeholder,
    // no visible swap when nothing changed. Bumped if the shape ever changes.
    const BRIEF_LS_KEY = "cairn.brief.v1";
    function briefStore() {
        try {
            return typeof localStorage !== "undefined" ? localStorage : null;
        }
        catch {
            return null;
        }
    }
    // The stored real read IFF it's for exactly this date (a previous day's read must
    // never paint for today). Returns a clean read (no internal flags) or null.
    function readCachedBrief(date) {
        const store = briefStore();
        if (!store)
            return null;
        try {
            const raw = store.getItem(BRIEF_LS_KEY);
            if (!raw)
                return null;
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.date !== date || !parsed.read || !parsed.read.kind)
                return null;
            if (parsed.read._provisional)
                return null;
            return parsed.read;
        }
        catch {
            return null;
        }
    }
    // Persist the last-known real read. Only ever the canonical (no-override) read —
    // an override ("rough night") is transient and must not poison the next open —
    // and never a provisional/placeholder. Strips internal flags before storing.
    function persistCachedBrief(date, override, read) {
        if (override || !read || read._provisional || !read.kind)
            return;
        const store = briefStore();
        if (!store)
            return;
        try {
            const clean = { ...read };
            delete clean._provisional;
            delete clean._cached;
            store.setItem(BRIEF_LS_KEY, JSON.stringify({ date, read: clean }));
        }
        catch { }
    }
    function provisionalRead(_date) {
        return CairnTodayBrief.provisionalRead();
    }
    async function loadBrief(date, override, deps, opts = {}) {
        const cached = deps.state.brief;
        if (cached && cached.date === date && cached.override === (override || "") && !cached.read._provisional && !cached.read._cached)
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
            persistCachedBrief(date, override || "", read);
            return read;
        })();
        if (opts.fast) {
            // Instant truth: if we've seen today's REAL read before (and there's no
            // override steer), paint it NOW as a normal read and reconcile silently
            // against the fetch post-render. The invented placeholder is reserved for a
            // genuinely first-ever open with nothing cached for this date.
            if (!override) {
                const stored = readCachedBrief(date);
                if (stored) {
                    const instant = { ...stored, _cached: true };
                    deps.state._briefInflight = { date, override: "", promise: fetchRead };
                    deps.state.brief = { date, override: "", read: instant };
                    return instant;
                }
            }
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
        // What's painted right now: a `_cached` read reconciles SILENTLY (it's already
        // the true sentence, so no "thinking" flash and no swap unless content really
        // changed); a `_provisional` placeholder gets the visible thinking → settle.
        const shown = deps.state.brief && deps.state.brief.date === date ? deps.state.brief.read : null;
        const silent = !!(shown && shown._cached && !shown._provisional);
        const briefEl = deps.root.querySelector(".brief");
        if (briefEl && !silent && !deps.reducedMotion())
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
            // Refetch failed / not ready — keep whatever's painted (cached read stands).
            briefEl?.classList.remove("is-thinking");
            return;
        }
        // A cached paint that matches the network truth: adopt the fresh read into
        // state (drops the _cached flag) but touch ZERO DOM — no settle animation.
        if (silent && shown && !CairnTodayBrief.materiallyDiffers(shown, read)) {
            deps.state.brief = { date, override: inflight.override || read.override || "", read };
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
        loadBrief,
        paintBriefReshaping,
        provisionalRead,
        reconnectDayReadOverride,
        reshapeToday,
        upgradeBriefInPlace,
        wireBrief,
    };
    Object.assign(globalThis, { CairnTodayBriefController: CAIRN_TODAY_BRIEF_CONTROLLER });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayBriefController: CAIRN_TODAY_BRIEF_CONTROLLER });
    }
})();
})();
