(() => {
(() => {
    function controllerRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function controllerRows(value) {
        return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
    }
    function select(deps, selector) {
        return deps.root.querySelector(selector) || deps.select(selector);
    }
    function paintHealthReadTab(deps) {
        const c = select(deps, "#hContent");
        if (!c)
            return;
        deps.teardownReadSpy();
        c.innerHTML = `<div class="hread">
      <nav class="hread-nav" aria-label="Jump to a section">
        <button type="button" class="hread-chip" data-jump="hSynthesis">The read</button>
        <button type="button" class="hread-chip" data-jump="hbDirectives">Connections</button>
        <button type="button" class="hread-chip" data-jump="hRecovery">Recovery</button>
        <button type="button" class="hread-chip" data-jump="hbMarkers">Markers</button>
        <button type="button" class="hread-chip" data-jump="hbSupplements">Supplements</button>
      </nav>
      <div class="hbrain-intro sess"><div class="sess-line" style="color:var(--muted)">
        One brain across your whole picture. A finding in your labs can quietly shape your meals, your training, and what to keep an eye on. It's here to inform — never medical advice — and nothing changes your plan on its own.
      </div></div>
      <div id="hSynthesis"></div>
      <div id="hPicture">
        <div class="hpic hpic-busy"><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div><div class="hshimmer hshimmer-sm"></div></div>
      </div>
      <div id="hbDirectives"><div class="hb-load">Gathering connections…</div></div>
      <div id="hbSymptomLinks"></div>
      <div id="hRecovery"></div>
      <div id="hbMarkers"><div class="hb-load">Reading what matters most…</div></div>
      <div id="hbSupplements"></div>
    </div>`;
        wireReadNav(deps, c);
        CairnHealthReadSynthesis.load(deps, deps.pollToken());
        loadRecoverySummary(deps, deps.pollToken(), "#hRecovery");
        loadPriorityMarkers(deps, deps.pollToken());
        const directivesLoaded = CairnHealthDirectiveLoader.load(deps.pollToken());
        void loadSymptomLinks(deps, deps.pollToken());
        loadSupplements(deps, deps.pollToken());
        if (deps.state.pendingHealthScroll === "hbDirectives") {
            const token = deps.pollToken();
            deps.state.pendingHealthScroll = null;
            void directivesLoaded.then(() => {
                if (token === deps.pollToken())
                    scrollHealthRailIntoView(deps, "#hbDirectives");
            });
        }
        if (deps.isHealthReviewRunning()) {
            deps.paintHealthPicture();
            return;
        }
        void deps.loadHealthPicture(deps.pollToken(), deps.api("/health-docs"));
    }
    function wireReadNav(deps, root) {
        const chips = [...root.querySelectorAll(".hread-chip")];
        const setActiveChip = (id) => chips.forEach((chip) => chip.classList.toggle("active", chip.dataset.jump === id));
        chips.forEach((button) => button.addEventListener("click", () => {
            const el = button.dataset.jump ? deps.root.querySelector("#" + button.dataset.jump) : null;
            if (el)
                el.scrollIntoView({ behavior: deps.reducedMotion() ? "auto" : "smooth", block: "start" });
            setActiveChip(button.dataset.jump);
        }));
        if (!("IntersectionObserver" in window))
            return;
        const spy = [
            ["hSynthesis", "hSynthesis"],
            ["hPicture", "hSynthesis"],
            ["hbDirectives", "hbDirectives"],
            ["hbSymptomLinks", "hbDirectives"],
            ["hRecovery", "hRecovery"],
            ["hbMarkers", "hbMarkers"],
            ["hbSupplements", "hbSupplements"],
        ];
        const owner = new Map(spy);
        const order = spy.map(([id]) => id);
        const visible = new Set();
        const readSpy = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting)
                    visible.add(entry.target.id);
                else
                    visible.delete(entry.target.id);
            }
            const top = order.find((id) => visible.has(id));
            if (top)
                setActiveChip(owner.get(top));
        }, { rootMargin: "-104px 0px -55% 0px", threshold: 0 });
        deps.setReadSpy(readSpy);
        order.forEach((id) => {
            const el = document.getElementById(id);
            if (el)
                readSpy.observe(el);
        });
    }
    async function loadSymptomLinks(deps, token) {
        const wrap = select(deps, "#hbSymptomLinks");
        if (!wrap || !wrap.isConnected)
            return;
        let result = null;
        try {
            result = await deps.api("/symptom-links");
        }
        catch {
            result = null;
        }
        if ((token != null && token !== deps.pollToken()) || !wrap.isConnected)
            return;
        const links = controllerRows(result?.links);
        if (!links.length) {
            wrap.innerHTML = "";
            return;
        }
        const cards = links.slice(0, 3).map((link) => {
            const markers = Array.isArray(link.markers)
                ? controllerRows(link.markers).map((marker) => `${deps.escapeHtml(marker.name)}${marker.value != null ? ` ${deps.escapeHtml(String(marker.value))}` : ""}${marker.unit ? ` ${deps.escapeHtml(marker.unit)}` : ""}`).join(", ")
                : "";
            return `<div class="symlink">
        <div class="symlink-note">${deps.escapeHtml(link.note || "")}</div>
        ${markers ? `<div class="symlink-mk lbl">${markers}</div>` : ""}
      </div>`;
        }).join("");
        wrap.innerHTML = `<div class="hb-section symlink-card reveal">
      <span class="lbl">Worth mentioning to your doctor</span>
      <p class="symlink-sub">Something you noted lines up with one of your lab markers. Informational only — a question for your clinician, never a diagnosis.</p>
      ${cards}
    </div>`;
    }
    function loadSupplements(deps, token) {
        CairnHealthReadSupplements.load(deps, token);
    }
    function renderSupplements(list, deps, token) {
        CairnHealthReadSupplements.render(list, deps, token);
    }
    async function understandSupplementsFromInput(deps) {
        await CairnHealthReadSupplements.understandFromInput(deps);
    }
    async function removeSupplement(id, deps) {
        await CairnHealthReadSupplements.remove(id, deps);
    }
    function loadRecoverySummary(deps, token, selector) {
        const wrap = select(deps, selector);
        if (!wrap || !wrap.isConnected)
            return;
        const paint = (result) => {
            const summary = controllerRecord(result);
            const target = select(deps, selector);
            if (token !== deps.pollToken() || !target || !target.isConnected)
                return;
            target.innerHTML = summary.has_data
                ? CairnHealthRead.recoveryHtml(summary)
                : CairnHealthRead.recoveryNoDataHtml();
        };
        const peek = deps.peekCached("recovery:14");
        if (peek) {
            paint(peek.data);
            if (!peek.fresh)
                deps.markRefreshing(true);
        }
        deps.cachedApi("/recovery?days=14", {
            key: "recovery:14",
            onUpgrade: (data, { changed }) => {
                if (peek && !peek.fresh)
                    deps.markRefreshing(false);
                if (changed || !peek)
                    paint(data);
            },
        }).catch(() => {
            if (peek && !peek.fresh)
                deps.markRefreshing(false);
        });
    }
    function loadPriorityMarkers(deps, token) {
        const wrap = select(deps, "#hbMarkers");
        if (!wrap || !wrap.isConnected)
            return;
        const paint = (result) => {
            if (token !== deps.pollToken() || !wrap.isConnected)
                return;
            const markers = controllerRows(controllerRecord(result).markers);
            wrap.innerHTML = CairnHealthRead.priorityMarkersSectionHtml(markers);
            select(deps, "#hbToMarkers")?.addEventListener("click", () => deps.switchHealthSeg("markers"));
        };
        const peek = deps.peekCached("markers:priority");
        if (peek) {
            paint(peek.data);
            if (!peek.fresh)
                deps.markRefreshing(true);
        }
        deps.cachedApi("/markers/priority", {
            key: "markers:priority",
            onUpgrade: (data, { changed }) => {
                if (peek && !peek.fresh)
                    deps.markRefreshing(false);
                if (changed || !peek)
                    paint(data);
            },
        }).catch(() => {
            if (peek && !peek.fresh)
                deps.markRefreshing(false);
            if (!peek)
                paint(null);
        });
    }
    function scrollHealthRailIntoView(deps, selector) {
        const token = deps.pollToken();
        let tries = 0;
        const onRead = () => deps.state.tab === "me" && deps.state.meSeg === "health" && deps.state.healthSeg === "read";
        const tick = () => {
            if (token !== deps.pollToken() || !onRead())
                return;
            const el = deps.root.querySelector(selector);
            const ready = el && !el.querySelector(".hb-load");
            if (ready || tries > 20) {
                if (el)
                    el.scrollIntoView({ behavior: deps.reducedMotion() ? "auto" : "smooth", block: "start" });
                return;
            }
            tries++;
            setTimeout(tick, 80);
        };
        setTimeout(tick, 80);
    }
    const CAIRN_HEALTH_READ_CONTROLLER = {
        loadPriorityMarkers,
        loadRecoverySummary,
        loadSupplements,
        loadSymptomLinks,
        loadSynthesis: CairnHealthReadSynthesis.load,
        paintTab: paintHealthReadTab,
        removeSupplement,
        renderSupplements,
        renderSynthesis: CairnHealthReadSynthesis.render,
        scrollHealthRailIntoView,
        triggerSynthesis: CairnHealthReadSynthesis.trigger,
        understandSupplementsFromInput,
    };
    Object.assign(globalThis, { CairnHealthReadController: CAIRN_HEALTH_READ_CONTROLLER });
    if (typeof window !== "undefined") {
        window.CairnHealthReadController = CAIRN_HEALTH_READ_CONTROLLER;
    }
})();
})();
