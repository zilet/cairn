(() => {
// @ts-check
// Health Read orchestration: jump nav, async loaders, synthesis job, symptom links,
// supplements, recovery, and priority-marker rails.
{
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
            loadHealthSynthesis(deps, deps.pollToken());
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
        function renderHealthSynthesis(data, deps, token) {
            const wrap = select(deps, "#hSynthesis");
            if (!wrap || !wrap.isConnected || (token != null && token !== deps.pollToken()))
                return;
            const payload = controllerRecord(data);
            const s = payload.synthesis && typeof payload.synthesis === "object" ? payload.synthesis : null;
            const focus = controllerRecord(payload.focus);
            const hasFocus = Array.isArray(focus.priorities) && focus.priorities.length;
            if (!s && !hasFocus) {
                wrap.innerHTML = "";
                return;
            }
            const stale = payload.stale ?? (s && s.stale) ?? false;
            const prios = s && Array.isArray(s.priorities)
                ? controllerRows(s.priorities).filter((p) => p.label || p.the_move)
                : [];
            let body;
            if (s && s.headline) {
                body = `
      <h3 class="hsyn-headline">${deps.escapeHtml(s.headline)}</h3>
      ${s.story ? `<p class="hsyn-story">${deps.escapeHtml(s.story)}</p>` : ""}
      ${prios.length ? `<div class="hsyn-prios">${prios.map((p) => `
        <div class="hsyn-prio">
          <span class="hsyn-plabel">${deps.escapeHtml(p.label || "")}</span>
          ${p.the_move ? `<span class="hsyn-pmove">${deps.escapeHtml(p.the_move)}</span>` : ""}
          ${p.recheck ? `<span class="hsyn-precheck lbl">${deps.escapeHtml(p.recheck)}</span>` : ""}
        </div>`).join("")}</div>` : ""}
      ${s.one_change ? `<div class="hsyn-onechange"><span class="lbl">If you change one thing</span><span>${deps.escapeHtml(s.one_change)}</span></div>` : ""}
      <div class="hsyn-foot"><span class="lbl">${s.generated_at ? `read ${deps.escapeHtml(deps.relTime(s.generated_at))}` : ""}</span>${stale
                    ? `<button id="hsynRefresh" class="hpic-refresh hpic-refresh-stale" type="button" title="New results since this read"><span class="hdot hdot-warn"></span>New results — refresh</button>`
                    : `<button class="linkbtn" id="hsynRefresh" type="button">refresh</button>`}</div>`;
            }
            else {
                body = `
      <p class="hsyn-invite">Your labs, training, recovery and nutrition — read as one connected, prioritized picture.</p>
      <button class="draftbtn hsyn-gen" id="hsynGen" type="button">Read my whole picture</button>`;
            }
            wrap.innerHTML = `<div class="hsyn reveal"><div class="hsyn-kicker lbl">Your health — one picture</div>${body}</div>`;
            select(deps, "#hsynRefresh")?.addEventListener("click", () => triggerHealthSynthesis(deps));
            select(deps, "#hsynGen")?.addEventListener("click", () => triggerHealthSynthesis(deps));
        }
        function loadHealthSynthesis(deps, token) {
            const wrap = select(deps, "#hSynthesis");
            if (!wrap || !wrap.isConnected)
                return;
            deps.api("/health/synthesis")
                .then((data) => renderHealthSynthesis(data || {}, deps, token))
                .catch(() => { });
        }
        function triggerHealthSynthesis(deps) {
            const wrap = select(deps, "#hSynthesis");
            if (!wrap)
                return;
            const card = wrap.querySelector(".hsyn");
            if (card && !card.querySelector(".job-cap")) {
                const cap = document.createElement("div");
                cap.className = "job-cap lbl hsyn-cap";
                card.appendChild(cap);
            }
            void deps.runOp("health_synthesis", {}, {
                path: "/health/synthesis",
                anchor: "#hSynthesis .hsyn",
                caption: ["reading your labs", "connecting it to your training & recovery", "finding what matters most", "writing your picture"],
                guard: () => !select(deps, "#hSynthesis")?.isConnected,
                render: (result) => {
                    const payload = controllerRecord(result);
                    if (payload.synthesis)
                        renderHealthSynthesis(payload, deps, deps.pollToken());
                    else
                        loadHealthSynthesis(deps, deps.pollToken());
                    deps.swrInvalidate("plan:coach");
                },
                onFail: () => {
                    deps.toast("Couldn't read the picture right now — try again in a bit.");
                    loadHealthSynthesis(deps, deps.pollToken());
                },
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
            const wrap = select(deps, "#hbSupplements");
            if (!wrap || !wrap.isConnected)
                return;
            const peek = deps.peekCached("supplements");
            if (peek)
                renderSupplements(peek.data, deps, token);
            deps.cachedApi("/supplements", {
                key: "supplements",
                onUpgrade: (data, { changed }) => {
                    if (changed || !peek)
                        renderSupplements(data, deps, token);
                },
            }).catch(() => {
                if (!peek)
                    renderSupplements([], deps, token);
            });
        }
        function renderSupplements(list, deps, token) {
            const wrap = select(deps, "#hbSupplements");
            if (!wrap || !wrap.isConnected || (token != null && token !== deps.pollToken()))
                return;
            const items = controllerRows(list);
            const chips = items.map((supplement) => {
                const bits = [supplement.dose, supplement.frequency].filter(Boolean).map(deps.escapeHtml).join(" · ");
                return `<div class="supp-chip" title="${deps.escapeAttr(supplement.note || supplement.name)}">
        <span class="supp-name">${deps.escapeHtml(supplement.name)}</span>${bits ? `<span class="supp-meta">${bits}</span>` : ""}
        <button class="supp-x" data-suppx="${supplement.id}" aria-label="Remove ${deps.escapeAttr(supplement.name)}">×</button>
      </div>`;
            }).join("");
            wrap.innerHTML = `<div class="hb-section supp-card reveal" style="${deps.stagger(3)}">
      <span class="lbl">What you're taking</span>
      <p class="supp-sub">Say it once in plain words — I'll approximate the rest and fold it into your picture.</p>
      ${items.length ? `<div class="supp-chips">${chips}</div>` : `<p class="supp-empty">Nothing yet. Tell me below, or just mention it in chat.</p>`}
      <div class="supp-input">
        <input id="suppText" type="text" placeholder="e.g. creatine daily, omega-3…" autocomplete="off" />
        <button id="suppAdd" class="ghostbtn">Add</button>
      </div>
    </div>`;
            const input = select(deps, "#suppText");
            const submit = () => { void understandSupplementsFromInput(deps); };
            select(deps, "#suppAdd")?.addEventListener("click", submit);
            input?.addEventListener("keydown", (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    submit();
                }
            });
            wrap.querySelectorAll("[data-suppx]").forEach((button) => button.addEventListener("click", () => { void removeSupplement(Number(button.dataset.suppx), deps); }));
        }
        async function understandSupplementsFromInput(deps) {
            const input = select(deps, "#suppText");
            const text = (input?.value || "").trim();
            if (!text)
                return;
            const btn = select(deps, "#suppAdd");
            if (btn) {
                btn.disabled = true;
                btn.textContent = "Reading…";
            }
            try {
                await deps.api("/supplements/understand", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text }),
                });
                deps.swrInvalidate("supplements");
                loadSupplements(deps, deps.pollToken());
            }
            catch {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = "Add";
                }
            }
        }
        async function removeSupplement(id, deps) {
            try {
                await deps.api(`/supplements/${id}`, { method: "DELETE" });
                deps.swrInvalidate("supplements");
                loadSupplements(deps, deps.pollToken());
            }
            catch { }
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
            loadSynthesis: loadHealthSynthesis,
            paintTab: paintHealthReadTab,
            removeSupplement,
            renderSupplements,
            renderSynthesis: renderHealthSynthesis,
            scrollHealthRailIntoView,
            triggerSynthesis: triggerHealthSynthesis,
            understandSupplementsFromInput,
        };
        Object.assign(globalThis, { CairnHealthReadController: CAIRN_HEALTH_READ_CONTROLLER });
        if (typeof window !== "undefined") {
            window.CairnHealthReadController = CAIRN_HEALTH_READ_CONTROLLER;
        }
    })();
}
})();
