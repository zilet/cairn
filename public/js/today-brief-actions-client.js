(() => {
// @ts-check
// Today Brief DOM actions: steer chips, redirects, reset, and small disclosures.
(() => {
    let agentOfflineDismissed = false;
    function offlineDismissed() {
        return agentOfflineDismissed;
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
    function handleBriefRedirect(action, deps) {
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
    }
    async function resetBriefRead(brief, steerReset, deps) {
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
    }
    function wireBriefActions(read, _options, deps) {
        const brief = deps.root.querySelector(".brief");
        if (!brief)
            return;
        wireAgentOffline(brief, deps);
        brief.querySelectorAll("[data-override]").forEach((button) => button.addEventListener("click", () => {
            const intent = button.dataset.override || "";
            if (brief.classList.contains("is-thinking"))
                return;
            CairnTodayBriefOverrideClient.paintBriefReshaping(brief, button, deps);
            deps.state.brief = null;
            deps.runOp("day_read_override", { date: deps.state.logDate, override: intent, agent: "auto" }, CairnTodayBriefOverrideClient.dayReadOverrideOpOpts({ intent, prevFocus: read.focus }, deps));
        }));
        brief.querySelectorAll("[data-redirect]").forEach((button) => button.addEventListener("click", () => {
            handleBriefRedirect(button.dataset.redirect, deps);
        }));
        const steerReset = brief.querySelector("[data-steerreset]");
        if (steerReset)
            steerReset.addEventListener("click", () => {
                void resetBriefRead(brief, steerReset, deps);
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
                sig.textContent = CairnTodayBrief.signalsText(read);
                whyBtn.before(sig);
                whyBtn.textContent = "hide";
            });
        }
    }
    const CAIRN_TODAY_BRIEF_ACTIONS_CLIENT = {
        offlineDismissed,
        wireBriefActions,
    };
    Object.assign(globalThis, { CairnTodayBriefActionsClient: CAIRN_TODAY_BRIEF_ACTIONS_CLIENT });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayBriefActionsClient: CAIRN_TODAY_BRIEF_ACTIONS_CLIENT });
    }
})();
})();
