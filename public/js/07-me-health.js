(() => {
// ==== 07-me-health.js ====
{
    function healthScreenRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function healthScreenRows(value) {
        return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
    }
    function healthInput(selector, root = document) {
        return root.querySelector(selector);
    }
    function healthInputValue(selector, root = document) {
        return healthInput(selector, root)?.value ?? "";
    }
    // ---------- Me (segmented: Profile / Memory / Health / Life) ----------
    // Standing leads — Me opens to the REVIEW (where you stand + where to focus), not a
    // data-entry form. The lab DATA (Health), identity (Profile), life, family and the
    // curated Memory follow it: review first, entering/updating second.
    const ME_SEG = [["standing", "Standing"], ["profile", "Profile"], ["health", "Health"], ["life", "Life"], ["family", "Family"], ["memory", "Memory"]];
    // Lazy handler refs (arrow-wrapped like PROGRESS_HANDLERS/PLAN_HANDLERS): renderLife and
    // renderFamily live in a later-loaded module, so bare references would resolve at parse
    // time — before that script runs — and throw. Arrows defer resolution to call time, by
    // which point every module is loaded. wireSeg/renderMe call handlers with no args.
    const ME_HANDLERS = { standing: () => renderMeStanding(), profile: () => renderMeProfile(), memory: () => renderMemory(), health: () => renderHealth(), life: () => renderLife(), family: () => renderFamily() };
    function renderMe() {
        headerTitle.textContent = "Me";
        pollToken++; // invalidate in-flight enrichment polls
        if (!state.meSeg)
            state.meSeg = "standing";
        return (ME_HANDLERS[state.meSeg] || renderMeStanding)();
    }
    // True when the Health → Read depth view is live — the whole-picture loaders
    // (picture/synthesis/recovery/directives/markers/supplements) gate on this so a
    // late async response never paints into a sibling tab.
    function onHealthReadView() {
        return state.tab === "me" && state.meSeg === "health" && state.healthSeg === "read";
    }
    // The Standing review — the FIRST thing Me opens to. It leads with the conductor's
    // whole-athlete "Where to focus" card (the cross-domain lead, tapping through to the
    // plan), then the detailed where-you-stand health read below.
    async function renderMeStanding() {
        headerTitle.textContent = "Me";
        state.meSeg = "standing";
        pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
        view.innerHTML = segBar("standing", ME_SEG)
            + `<div class="cfocus-slot cfocus-standing-slot" id="cfocusStandingSlot"></div>`
            + `<div id="hContent"></div>`;
        wireSeg(ME_HANDLERS);
        loadCoachingFocus("#cfocusStandingSlot", view); // the whole-athlete lead → planning
        paintStandingReview(); // the detailed where-you-stand health read
    }
    function healthNumberValue(selector, root = document) {
        const raw = healthInputValue(selector, root);
        if (!raw)
            return null;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
    }
    function healthTextAreaValue(selector, root = document) {
        return root.querySelector(selector)?.value ?? "";
    }
    function meProfileDeps() {
        return {
            root: view,
            state,
            segments: ME_SEG,
            handlers: ME_HANDLERS,
            headerTitle,
            api,
            activateTab,
            escapeAttr: escAttr,
            escapeHtml: escHtml,
            inputValue: healthInputValue,
            invalidatePoll: () => { pollToken++; },
            mountSaveBar,
            numberValue: healthNumberValue,
            primaryDiscipline: () => primaryDiscipline,
            renderMe,
            renderProfile: () => renderMeProfile(),
            segBar,
            segSkeleton,
            setDiscipline,
            setEnduranceGoalSet,
            skeletonSwap: skelSwap,
            swrInvalidate,
            textAreaValue: healthTextAreaValue,
            toast,
            wireSeg,
            select: $,
        };
    }
    async function renderMeProfile() {
        return CairnMeProfileController.renderProfile(meProfileDeps());
    }
    // Pure food-note parsing/rendering lives in food-note-client.js; the food detail
    // modal is owned by food-detail-controller.js.
    // tap a note card → full-screen food detail (zooming from its art tile)
    function wireNoteCard(el) {
        const card = el;
        if (!card || card._wired)
            return;
        card._wired = true;
        card.addEventListener("click", (e) => {
            const target = e.target instanceof Element ? e.target : null;
            if (target?.closest("button, a, input"))
                return;
            const n = (state._notesById || {})[card.dataset.noteid || ""];
            if (n)
                openFoodDetail(n, card.querySelector(".artile"));
        });
    }
    function renderNotes(notes) {
        const wrap = $("#notelist");
        if (!wrap)
            return;
        const rows = healthScreenRows(notes);
        if (!rows.length) {
            wrap.innerHTML = `<div class="empty">Nothing logged yet. Snap a plate or jot a meal in Chat and it shows up here.</div>`;
            return;
        }
        state._notesById = Object.fromEntries(rows.map((n) => [String(n.id), n]));
        wrap.innerHTML = rows.map((n, i) => CairnFoodNote.noteEntryHtml(n, i)).join("");
        wrap.querySelectorAll(".fnent").forEach(wireNoteCard);
    }
    function renderActs(acts) {
        const wrap = $("#actlist");
        if (!wrap)
            return;
        const rows = healthScreenRows(acts);
        if (!rows.length) {
            wrap.innerHTML = `<div class="empty">Nothing logged yet. Log a ride, run, or walk on Today and it lands here.</div>`;
            return;
        }
        wrap.innerHTML = rows.map((a) => actEntryHtml(a)).join("");
    }
    function meMemoryDeps() {
        return {
            view,
            state,
            segments: ME_SEG,
            handlers: ME_HANDLERS,
            headerTitle,
            api,
            armDelete,
            escapeAttr: escAttr,
            invalidatePoll: () => { pollToken++; },
            segBar,
            toast,
            wireSeg,
        };
    }
    async function renderMemory() {
        return CairnMeMemoryController.render(meMemoryDeps());
    }
    // ---------- Me: Health — the whole picture (review · markers · records) ----------
    let _hReadSpy = null; // scroll-spy IntersectionObserver for the Read tab's sticky nav
    function healthReadDeps() {
        return {
            root: view,
            state,
            api,
            cachedApi,
            peekCached,
            markRefreshing,
            swrInvalidate,
            runOp,
            toast,
            pollToken: () => pollToken,
            select: $,
            escapeAttr: escAttr,
            escapeHtml: escHtml,
            relTime,
            stagger,
            reducedMotion,
            switchHealthSeg,
            isHealthReviewRunning: () => CairnHealthPictureController.isHealthReviewRunning(),
            loadHealthPicture: (token, docsPromise) => loadHealthPicture(token, docsPromise),
            paintHealthPicture,
            setReadSpy: (spy) => { _hReadSpy = spy; },
            teardownReadSpy: () => {
                if (_hReadSpy) {
                    _hReadSpy.disconnect();
                    _hReadSpy = null;
                }
            },
        };
    }
    function healthPictureDeps() {
        return {
            root: view,
            state,
            api,
            toast,
            switchHealthSeg,
            onHealthReadView,
            pollToken: () => pollToken,
            escapeHtml: escHtml,
            storage: typeof localStorage !== "undefined" ? localStorage : null,
        };
    }
    function getHealthPictureCache() {
        return CairnHealthPictureController.getHealthPictureCache();
    }
    function setHealthPictureCache(cache) {
        return CairnHealthPictureController.setHealthPictureCache(cache);
    }
    function parsedReview(r) {
        return CairnHealthPicture.parsedReview(r);
    }
    function healthDotClass(flag) {
        return CairnHealthPicture.healthDotClass(flag);
    }
    function reviewBusyHtml() {
        return CairnHealthPicture.reviewBusyHtml();
    }
    function healthHeroHtml(err) {
        return CairnHealthPicture.healthHeroHtml(err);
    }
    function buildPictureHtml(err, docCount) {
        return CairnHealthPicture.buildPictureHtml(err, docCount);
    }
    function reviewHtml(review, stale, err) {
        return CairnHealthPicture.reviewHtml(review, stale, err);
    }
    function paintHealthPicture() {
        CairnHealthPictureController.paintHealthPicture(healthPictureDeps());
    }
    async function runHealthReview() {
        await CairnHealthPictureController.runHealthReview(healthPictureDeps());
    }
    async function loadHealthPicture(token, docsP) {
        await CairnHealthPictureController.loadHealthPicture(token, docsP, healthPictureDeps());
    }
    function healthMarkersDeps() {
        return {
            root: view,
            cachedApi,
            peekCached,
            markRefreshing,
            pollToken: () => pollToken,
            relAge,
            select: $,
            stagger,
            switchHealthSeg,
            escapeHtml: escHtml,
        };
    }
    function loadHealthMarkers(token) {
        CairnHealthMarkersController.load(healthMarkersDeps(), token);
    }
    // Health's inner views. The whole-picture DEPTH (synthesis + connected brain) used to
    // be inlined under the top-level Standing review, ballooning it to ~8 screens. It now
    // lives here as its own "Read" sub-tab, one tap from the review, with an in-page jump
    // nav so you can land on what you want instead of scrolling the whole story:
    //   • read    — "Read": the whole-picture synthesis + the connected-brain directives,
    //               recovery, what-matters-now markers, symptom links and supplements,
    //               with a jump-chip nav across them.
    //   • markers — "Markers": the rich trends catalog (the ONE detailed markers home).
    //   • records — "Records": upload + the document list.
    //   • share   — "Share": doctor report, structured export, and data-alignment actions.
    //   • learned — "Learned": the quiet record of what Cairn has come to understand.
    const HEALTH_SEG = [["read", "Read"], ["markers", "Markers"], ["records", "Records"], ["share", "Share"], ["learned", "Learned"]];
    // Health is the lab-DATA + whole-picture-read home. Fold every legacy analysis/brain/
    // standing key onto Read (where that content now lives) so a returning client never
    // lands on a dead inner tab.
    function normalizeHealthSeg(seg) {
        if (seg === "analysis" || seg === "brain" || seg === "standing")
            return "read";
        return typeof seg === "string" && HEALTH_SEG.some(([k]) => k === seg) ? seg : "read";
    }
    // True when we positively know there are zero health documents — from this session's
    // last load (cache.docCount) or this device's last visit (persisted). Used to open a
    // brand-new user on Records (where they upload) instead of an empty Standing read.
    // Returns false when the count is unknown, so we only override on a confident zero.
    function healthDocsKnownEmpty() {
        return CairnHealthPictureController.healthDocsKnownEmpty(healthPictureDeps());
    }
    // Health is a one-level inner view: the Me seg picks "Health", then a single inner
    // seg picks Read / Markers / Records / Share. Splitting these bounds each view's scroll and
    // keeps it focused — and the connected brain now lives on the default Read view, so
    // it's reachable in one nav step (Me → Health) instead of buried behind a second seg.
    async function renderHealth() {
        headerTitle.textContent = "Me";
        state.meSeg = "health";
        state.healthSeg = normalizeHealthSeg(state.healthSeg);
        // New user with nothing uploaded yet → open on Records (where you add a document),
        // not the Read view that can only say "this will sharpen". Respect any explicit
        // tab choice made this session, and only override on a confident zero doc count.
        if (!state.healthSegPicked && state.healthSeg === "read" && healthDocsKnownEmpty()) {
            state.healthSeg = "records";
        }
        pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
        const idx = Math.max(0, HEALTH_SEG.findIndex(([k]) => k === state.healthSeg));
        view.innerHTML = segBar("health", ME_SEG)
            + `<div class="segwrap hsegwrap"><div class="seg seg-sliding hseg" style="--segn:${HEALTH_SEG.length};--segi:${idx}">`
            + `<span class="seg-thumb"></span>`
            + HEALTH_SEG.map(([k, l]) => `<button class="segbtn${k === state.healthSeg ? " active" : ""}" data-hseg="${k}">${l}</button>`).join("")
            + `</div></div>`
            + `<div id="hContent"></div>`;
        wireSeg(ME_HANDLERS);
        const hseg = view.querySelector(".hseg");
        if (!hseg)
            return;
        hseg.querySelectorAll(".segbtn").forEach((b) => b.addEventListener("click", () => {
            const next = normalizeHealthSeg(b.dataset.hseg);
            if (next === state.healthSeg)
                return;
            setHealthSegActive(next);
            if (typeof syncRouteFromState === "function")
                syncRouteFromState();
            withViewTransition(() => paintHealthTab());
        }));
        paintHealthTab();
    }
    // Slide the inner seg thumb + flip the active button to `seg` (no repaint).
    function setHealthSegActive(seg) {
        state.healthSeg = seg;
        state.healthSegPicked = true; // a deliberate tab choice — don't auto-default to Records again
        const hseg = view.querySelector(".hseg");
        if (!hseg)
            return;
        const btns = [...hseg.querySelectorAll(".segbtn")];
        const target = btns.find((b) => b.dataset.hseg === seg);
        if (!target)
            return;
        hseg.style.setProperty("--segi", String(btns.indexOf(target)));
        btns.forEach((x) => x.classList.toggle("active", x === target));
        fitSeg(hseg); // keep the active pill centered when the bar is in scroll mode
    }
    // Programmatic inner-tab switch from a CTA. openPicker keeps the .click() in the
    // same user gesture (so the file dialog isn't blocked) — hence no view transition.
    function switchHealthSeg(seg, opts = {}) {
        if (state.tab !== "me" || state.meSeg !== "health")
            return;
        setHealthSegActive(seg);
        if (typeof syncRouteFromState === "function")
            syncRouteFromState();
        if (opts.openPicker) {
            paintHealthTab();
            const f = $("#hFile");
            if (f)
                f.click();
        }
        else {
            withViewTransition(() => paintHealthTab());
        }
    }
    // Repaint #hContent for the active inner tab. Bumps pollToken so any enrichment
    // poll from the tab we're leaving stops cleanly (Records resumes on return).
    function paintHealthTab() {
        pollToken++;
        if (state.healthSeg === "records") {
            paintHealthRecordsTab();
            return;
        }
        if (state.healthSeg === "share") {
            paintHealthShareTab();
            return;
        }
        if (state.healthSeg === "learned") {
            paintHealthLearnedTab();
            return;
        }
        if (state.healthSeg === "markers") {
            paintHealthMarkersTab();
            return;
        }
        paintHealthReadTab();
    }
    // ME → Health → Read: the whole-picture depth that used to balloon the Standing tab.
    // A STICKY jump-chip nav heads it (pinned under the Health seg) so you can land on the
    // connections, recovery, markers or supplements from anywhere in the long read; below
    // it the same id-keyed slots the loaders fill. Single editorial column (no broken
    // two-column gutter), capped width on desktop. The targets carry scroll-margin-top so a
    // jump lands below the sticky chrome, and a scroll-spy highlights the section you're in.
    function paintHealthReadTab() {
        CairnHealthReadController.paintTab(healthReadDeps());
    }
    // ---- Standing tab: percentiles, signal age, and point-in-time BP ----
    function renderHealthStanding(data) {
        const wrap = $("#hStanding");
        if (!wrap)
            return;
        wrap.innerHTML = CairnHealthStanding.renderHealthStandingHtml(data, { referenceAge: state.healthStandingRef });
        // Don't stack two competing "single most important thing" surfaces: if the conductor's
        // "Where to focus" card already led above, drop this health "one lever" section (the
        // Program view de-dupes the same way via suppressLever). Order-independent — the
        // conductor loader does the mirror removal if it lands after this paint.
        if (view.querySelector("#cfocusStandingSlot .cfocus"))
            wrap.querySelector(".hstand-lever")?.remove();
        wrap.querySelectorAll("[data-refage]").forEach((b) => b.addEventListener("click", () => {
            state.healthStandingRef = Number(b.dataset.refage || 20);
            loadHealthStanding(pollToken, state.healthStandingRef);
        }));
        // This lever lives on the top-level Standing tab (meSeg="standing"), so switchHealthSeg
        // would bail (it guards meSeg==="health"). Route into Health → Markers directly.
        wrap.querySelector("[data-lever-go]")?.addEventListener("click", () => {
            state.meSeg = "health";
            state.healthSeg = "markers";
            state.healthSegPicked = true;
            activateTab("me");
        });
        $("#bpLogOpen")?.addEventListener("click", () => openBpSheet());
        // "From your DEXA — what to focus on next", co-located with the regional read.
        // Shared renderer defined in 05-progress.js (loaded earlier); null-safe + quiet.
        if (typeof loadDexaTargeting === "function")
            loadDexaTargeting("hDexaSlot");
    }
    // The relocated BP capture: a compact sheet behind a tap, so the Standing read stays a
    // reading surface (the user's "why am I entering BP in the analysis view?"). Reuses the
    // same POST /blood-pressure wiring as before.
    function openBpSheet() {
        if (document.getElementById("bpSheetOv"))
            return;
        const ov = document.createElement("div");
        ov.id = "bpSheetOv";
        ov.className = "bpsheet-ov";
        ov.innerHTML = `<div class="bpsheet" role="dialog" aria-modal="true" aria-label="Log blood pressure">
      <div class="bpsheet-hd"><h3>Log a reading</h3><button class="bpsheet-x" type="button" aria-label="Close">✕</button></div>
      <form id="bpSheetForm" class="bpsheet-form">
        <div class="bpsheet-row">
          <label>Systolic<input id="bpSys" class="form-input" type="number" inputmode="numeric" min="60" max="260" placeholder="120" required></label>
          <label>Diastolic<input id="bpDia" class="form-input" type="number" inputmode="numeric" min="35" max="160" placeholder="80" required></label>
          <label>Pulse<input id="bpPulse" class="form-input" type="number" inputmode="numeric" min="25" max="240" placeholder="60"></label>
        </div>
        <label class="bpsheet-when">When<input id="bpAt" class="form-input" type="datetime-local" value="${escAttr(CairnHealthStanding.localDateTimeInputValue())}"></label>
        <div class="bpsheet-row">
          <label>Position<input id="bpPosition" class="form-input" type="text" maxlength="40" placeholder="Seated"></label>
          <label>Note<input id="bpNote" class="form-input" type="text" maxlength="240" placeholder="Optional"></label>
        </div>
        <div class="bpsheet-ft"><button class="ghostbtn" type="button" data-close>Cancel</button><button class="logbtn" type="submit">Save</button></div>
      </form>
    </div>`;
        document.body.appendChild(ov);
        const onKey = (e) => { if (e.key === "Escape")
            teardown(); };
        const teardown = () => { document.removeEventListener("keydown", onKey); ov.remove(); };
        document.addEventListener("keydown", onKey);
        ov.querySelector(".bpsheet-x")?.addEventListener("click", teardown);
        ov.querySelector("[data-close]")?.addEventListener("click", teardown);
        ov.addEventListener("click", (e) => { if (e.target === ov)
            teardown(); });
        $("#bpSheetForm")?.addEventListener("submit", async (e) => {
            e.preventDefault();
            const form = e.currentTarget instanceof HTMLFormElement ? e.currentTarget : null;
            const submit = form?.querySelector("button[type='submit']") || null;
            if (submit)
                submit.disabled = true;
            const payload = {
                systolic: healthInputValue("#bpSys"), diastolic: healthInputValue("#bpDia"), pulse: healthInputValue("#bpPulse"),
                measured_at: healthInputValue("#bpAt"), position: healthInputValue("#bpPosition"), note: healthInputValue("#bpNote"), source: "manual",
            };
            try {
                const res = await api("/blood-pressure", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
                if (!res || res.error) {
                    toast(res?.error || "Couldn't log BP");
                    if (submit)
                        submit.disabled = false;
                    return;
                }
                toast("BP logged");
                swrInvalidate("markers:");
                teardown();
                loadHealthStanding(pollToken, state.healthStandingRef || 20);
            }
            catch {
                toast("Couldn't log BP");
                if (submit)
                    submit.disabled = false;
            }
        });
        setTimeout(() => $("#bpSys")?.focus(), 30);
    }
    function loadHealthStanding(token, refAge) {
        const ref = Number(refAge || state.healthStandingRef || 20);
        state.healthStandingRef = ref;
        api(`/health/standing?reference_age=${encodeURIComponent(String(ref))}`)
            .then((data) => { if (token === pollToken)
            renderHealthStanding(data || null); })
            .catch(() => {
            if (token !== pollToken)
                return;
            const wrap = $("#hStanding");
            if (wrap)
                wrap.innerHTML = `<div class="hstand hstand-panel"><div class="empty">Couldn't load health standing right now.</div></div>`;
        });
    }
    // The Standing tab is the calm REVIEW — where you stand + where to focus. It stays
    // short and scannable: the conductor "Where to focus" (rendered above #hContent), then
    // the momentum-led structured read (#hStanding — hero, momentum, the one lever, and the
    // collapsed Full standing: live body comp, BP, percentiles). The whole-picture depth
    // (synthesis, recovery, picture, the connected-brain directives/markers/supplements)
    // now lives one tap away in Health → Read, reachable from the jump-off below — so this
    // page no longer stacks ~8 screens of analysis on top of the review.
    function paintStandingReview() {
        const c = $("#hContent");
        if (!c)
            return;
        c.innerHTML = `<div id="hStanding"><div class="hstand hstand-busy"><div class="hshimmer hshimmer-lg"></div><div class="hshimmer"></div><div class="hshimmer hshimmer-sm"></div></div></div>
    <button type="button" class="hread-jump" id="hStandingToRead">
      <span class="hread-jump-main">
        <span class="lbl">Your whole picture</span>
        <span class="hread-jump-title">The full health read</span>
        <span class="hread-jump-sub">Synthesis, the connected-brain list, recovery, markers and supplements — read as one story.</span>
      </span>
      <span class="hread-jump-arrow" aria-hidden="true">→</span>
    </button>`;
        loadHealthStanding(pollToken, state.healthStandingRef || 20);
        $("#hStandingToRead")?.addEventListener("click", () => openHealthRead());
    }
    // Jump from the Standing review into the relocated depth (Health → Read). Switches the
    // Me seg to Health and the inner seg to Read in one step, then paints.
    function openHealthRead(opts = {}) {
        state.meSeg = "health";
        state.healthSeg = "read";
        state.healthSegPicked = true;
        if (opts.scroll)
            state.pendingHealthScroll = opts.scroll;
        activateTab("me");
    }
    function scrollHealthRailIntoView(sel) {
        CairnHealthReadController.scrollHealthRailIntoView(healthReadDeps(), sel);
    }
    function loadHealthSynthesis(token) {
        CairnHealthReadController.loadSynthesis(healthReadDeps(), token);
    }
    function triggerHealthSynthesis() {
        CairnHealthReadController.triggerSynthesis(healthReadDeps());
    }
    function renderHealthSynthesis(data, token) {
        CairnHealthReadController.renderSynthesis(data, healthReadDeps(), token);
    }
    async function loadSymptomLinks(token) {
        await CairnHealthReadController.loadSymptomLinks(healthReadDeps(), token);
    }
    function loadSupplements(token) {
        CairnHealthReadController.loadSupplements(healthReadDeps(), token);
    }
    function renderSupplements(list, token) {
        CairnHealthReadController.renderSupplements(list, healthReadDeps(), token);
    }
    async function understandSupplementsFromInput() {
        await CairnHealthReadController.understandSupplementsFromInput(healthReadDeps());
    }
    async function removeSupplement(id) {
        await CairnHealthReadController.removeSupplement(id, healthReadDeps());
    }
    function loadRecoverySummary(token, sel) {
        CairnHealthReadController.loadRecoverySummary(healthReadDeps(), token, sel);
    }
    function loadPriorityMarkers(token) {
        CairnHealthReadController.loadPriorityMarkers(healthReadDeps(), token);
    }
    // ---- Cross-domain directives, grouped by domain (the review side) ----
    // Pure directive grouping and card rendering live in health-client.js.
    Object.assign(globalThis, {
        HEALTH_SEG,
        ME_HANDLERS,
        ME_SEG,
        buildPictureHtml,
        getHealthPictureCache,
        healthDotClass,
        healthDocsKnownEmpty,
        healthHeroHtml,
        loadHealthMarkers,
        loadHealthPicture,
        loadHealthStanding,
        loadHealthSynthesis,
        loadPriorityMarkers,
        loadRecoverySummary,
        loadSupplements,
        loadSymptomLinks,
        normalizeHealthSeg,
        onHealthReadView,
        openBpSheet,
        openHealthRead,
        paintHealthPicture,
        paintHealthReadTab,
        paintHealthTab,
        paintStandingReview,
        parsedReview,
        renderActs,
        renderHealth,
        renderHealthStanding,
        renderHealthSynthesis,
        renderMe,
        renderMeProfile,
        renderMeStanding,
        renderMemory,
        renderNotes,
        renderSupplements,
        reviewBusyHtml,
        reviewHtml,
        runHealthReview,
        scrollHealthRailIntoView,
        setHealthSegActive,
        setHealthPictureCache,
        switchHealthSeg,
        triggerHealthSynthesis,
        understandSupplementsFromInput,
        wireNoteCard,
    });
    if (typeof window !== "undefined") {
        Object.assign(window, {
            renderMe,
            renderMemory,
            switchHealthSeg,
            loadHealthMarkers,
            paintHealthPicture,
        });
    }
}
})();
