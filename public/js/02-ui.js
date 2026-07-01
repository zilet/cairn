(() => {
// @ts-check
// ==== 02-ui.js ====
function uiRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function uiRows(value) {
    return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
}
function uiString(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
}
function uiNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
// ---------- header date control (Today) ----------
// On the Today tab the big header title IS the date control — change the date to
// review OR log a past workout. A REAL full-size (transparent) date input overlays
// the title, so a genuine tap opens the native picker on every browser (the old
// showPicker()-over-a-1px-hidden-input failed silently where showPicker throws).
// Other tabs set headerTitle via textContent, which removes this input automatically.
function setTodayHeaderTitle() {
    headerTitle.innerHTML =
        `${escHtml(dateLabel(state.logDate))}<span class="hdr-chev" aria-hidden="true">▾</span>` +
            `<input type="date" class="hdr-datepick" aria-label="Choose a date to view or log a past workout">`;
    headerTitle.classList.add("hdr-tappable");
    const inp = headerTitle.querySelector(".hdr-datepick");
    if (!inp)
        return;
    inp.value = state.logDate || localISO();
    inp.max = localISO();
    // Desktop: a click on a date input only focuses it (the calendar indicator is
    // hidden by appearance:none) — showPicker opens the calendar. Mobile taps open
    // the native picker on their own. Either way the change handler reloads Today.
    inp.addEventListener("click", () => { try {
        inp.showPicker?.();
    }
    catch { /* unsupported → native focus */ } });
    inp.addEventListener("change", () => {
        if (!inp.value)
            return;
        state.logDate = inp.value;
        state.day = null;
        state.dayPicked = false;
        if (typeof syncRouteFromState === "function")
            syncRouteFromState();
        renderToday();
    });
}
// On Today the header pins to the top so the date control is always reachable.
// At rest it's the full editorial header; once the page scrolls past a few px it
// condenses into a slim blurred band (CSS scoped to body[data-tab="today"]).
function updateHeaderCondense() {
    const on = state.tab === "today" && window.scrollY > 6;
    document.querySelector("header")?.classList.toggle("condensed", on);
}
window.addEventListener("scroll", updateHeaderCondense, { passive: true });
// toast(msg) — fire-and-forget pill. toast(msg, {action, onAction}) — actionable
// variant (e.g. UNDO) that lingers longer and accepts one tap.
let _toastTimer = null;
function toast(msg, opts = {}) {
    let t = document.querySelector(".toast");
    if (!t) {
        t = document.createElement("div");
        t.className = "toast";
        document.body.appendChild(t);
    }
    if (_toastTimer)
        clearTimeout(_toastTimer);
    if (opts.action) {
        t.textContent = "";
        const span = document.createElement("span");
        span.textContent = String(msg);
        const btn = document.createElement("button");
        btn.className = "toast-act";
        btn.textContent = opts.action;
        btn.addEventListener("click", () => {
            if (_toastTimer)
                clearTimeout(_toastTimer);
            t.classList.remove("show", "toast-actionable");
            opts.onAction && opts.onAction();
        });
        t.append(span, btn);
        t.classList.add("toast-actionable");
    }
    else {
        t.textContent = String(msg);
        t.classList.remove("toast-actionable");
    }
    t.classList.add("show");
    _toastTimer = setTimeout(() => t.classList.remove("show", "toast-actionable"), opts.action ? 5000 : 1400);
}
// ---------- one destructive-confirm pattern: the two-tap armed × ----------
// Every delete in the app uses THIS: first tap arms the × into a "remove?" chip,
// a second tap (within ~3s, or until blur) confirms; otherwise it disarms. One
// idiom across Memory / Life / Family / Health docs / session-set edits — never a
// blocking dialog, never an immediate destructive click. `onConfirm` runs on the
// confirming tap; it owns the actual delete + any toast/UI update.
function armDelete(btn, onConfirm, { label = "remove?" } = {}) {
    if (!btn)
        return;
    const target = btn;
    if (target.dataset.armed) {
        onConfirm();
        return;
    }
    if (!target.dataset.restGlyph)
        target.dataset.restGlyph = target.textContent || "×";
    target.dataset.armed = "1";
    target.classList.add("armed");
    target.textContent = label;
    const reset = () => {
        delete target.dataset.armed;
        target.classList.remove("armed");
        target.textContent = target.dataset.restGlyph || "×";
        clearTimeout(t);
    };
    const t = setTimeout(reset, 3000);
    target.addEventListener("blur", reset, { once: true });
}
// ---------- detail controllers (exercise + food full-screen overlays) ----------
function exerciseDetailDeps() {
    return {
        root: view,
        state,
        api,
        art,
        artImg,
        closeDetail,
        escapeHtml: escHtml,
        exerciseDetail: CairnExerciseDetail,
        fmtDur,
        fmtWeight,
        gotoChatWith,
        mountDetail,
        openDetailFrom,
        postExerciseMode,
        renderToday,
        runCountUps,
        sparklineSvg,
        toast,
        wireDetailCommon,
    };
}
function wireGuides(scope) {
    CairnExerciseDetailController.wireGuides(scope, exerciseDetailDeps());
}
function exerciseExplanation(d) {
    return CairnExerciseDetailController.exerciseExplanation(d, exerciseDetailDeps());
}
function exerciseExplanationHtml(d, explanation) {
    return CairnExerciseDetailController.exerciseExplanationHtml(d, explanation, exerciseDetailDeps());
}
function replaceExerciseExplanation(el, d, explanation) {
    CairnExerciseDetailController.replaceExerciseExplanation(el, d, explanation, exerciseDetailDeps());
}
function foodDetailDeps() {
    return {
        state,
        api,
        art,
        artEnabled: () => artEnabled,
        artImg,
        closeDetail,
        escapeHtml: escHtml,
        foodNote: CairnFoodNote,
        foodNum,
        formatFoodNum,
        mountDetail,
        openDetailFrom,
        runCountUps,
        toast,
        wireDetailCommon,
        withToken,
    };
}
async function openFoodDetail(note, fromTile) {
    return CairnFoodDetailController.openFoodDetail(note, fromTile, foodDetailDeps());
}
function gotoChatWith(text) {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    const t = document.querySelector('.tab[data-tab="chat"]');
    if (t)
        t.classList.add("active");
    state.tab = "chat";
    document.body.dataset.tab = "chat"; // keep the header's Today-scoped styling off
    if (typeof syncRouteFromState === "function")
        syncRouteFromState();
    Promise.resolve(renderChat()).then(() => {
        const i = $("#chatInput");
        if (i) {
            i.value = text;
            autosizeChatInput(i);
            i.focus();
        }
    });
}
// segmented sub-nav: items = [[key,label]]; handlers = {key: renderFn}
// Emits a sliding ink thumb (.seg-thumb) behind the active button; sub-view swaps
// go through a view transition so the thumb glides between renders. Wrapped in a
// sticky .segwrap band so the sub-nav stays pinned to the top while you scroll a
// long sub-view — one tap back to another section, never lost from focus.
function segBar(active, items) {
    return CairnUi.segmentedNavHtml({ active, items });
}
function wireSeg(handlers) {
    view.querySelectorAll(".segbtn").forEach((b, _i) => b.addEventListener("click", () => {
        const f = handlers[String(b.dataset.seg || "")];
        if (!f)
            return;
        // slide the thumb immediately, then swap the sub-view inside a transition
        const seg = b.closest(".seg");
        if (seg) {
            const idx = [...seg.querySelectorAll(".segbtn")].indexOf(b);
            seg.style.setProperty("--segi", String(idx));
        }
        withViewTransition(() => Promise.resolve(f()).then(() => {
            if (typeof syncRouteFromState === "function")
                syncRouteFromState();
            return viewEnter();
        }));
    }));
    view.querySelectorAll(".seg").forEach(fitSeg);
}
// Pill / segment bars stay on ONE line and SCROLL when they don't fit, rather than
// clipping the last pill (e.g. "Calendar" on a narrow phone). Measure with
// content-width pills (the .seg-scroll layout); if that overflows, keep scroll mode
// — the sliding ink thumb assumes equal-width segments, so it yields to the solid
// active-pill background — and center the active pill. Otherwise drop back to the
// equal-width thumb. Adapts per-bar and per-viewport; no fixed breakpoint.
function fitSeg(seg) {
    if (!seg)
        return;
    const el = seg;
    el.classList.add("seg-scroll");
    const overflow = el.scrollWidth > el.clientWidth + 1;
    seg.classList.toggle("seg-scroll", overflow);
    if (overflow) {
        const active = el.querySelector(".segbtn.active");
        if (active)
            el.scrollLeft = active.offsetLeft - (el.clientWidth - active.offsetWidth) / 2;
    }
}
let _segFitRaf = 0;
window.addEventListener("resize", () => {
    cancelAnimationFrame(_segFitRaf);
    _segFitRaf = requestAnimationFrame(() => view.querySelectorAll(".seg").forEach(fitSeg));
});
const PROGRESS_SEG = [["sessions", "History"], ["trend", "1RM"], ["volume", "Volume"], ["endurance", "Endurance"], ["weight", "Weight"], ["calendar", "Calendar"], ["program", "Program"], ["energy", "Energy"]];
const PROGRESS_HANDLERS = { trend: () => renderProgress(), volume: () => renderVolume(), endurance: () => renderEndurance(), weight: () => renderWeight(), calendar: () => renderCalendar(), sessions: () => renderHistory(), program: () => renderProgram(), energy: () => renderEnergy() };
// The Plan sub-nav is dynamic: a runner/hybrid (or anyone with an endurance goal)
// gets a dedicated ENDURANCE tab — the home for the periodized ramp, this week's
// prescribed runs, and shaping the running plan. A pure strength athlete with no
// running goal never sees it (calm, no empty surface).
function planSeg() {
    const routedToEndurance = state.planSeg === "endurance" || state.planJump === "endurance";
    return showEnduranceTab() || routedToEndurance
        ? [["edit", "Training"], ["endurance", "Endurance"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]]
        : [["edit", "Training"], ["food", "Food"], ["meals", "Meals"], ["coach", "Coach"]];
}
const PLAN_HANDLERS = { edit: () => renderPlanEditor(), endurance: () => renderPlanEndurance(), food: () => renderFoodJournal(), meals: () => renderMeals(), coach: () => renderCoach() };
// ---------- view transition utilities ----------
// Subtle fade+rise re-triggered whenever #view's content is swapped wholesale
// (tab switches + segmented sub-view swaps). No-op under reduced motion.
function viewEnter() {
    if (reducedMotion())
        return;
    view.classList.remove("view-in");
    void view.offsetWidth; // force reflow so the animation restarts
    view.classList.add("view-in");
}
// Soft fade for the skeleton→content swap: replace the busy skeleton with real
// content inside a view transition so the skeleton crossfades out as the content
// fades in, instead of a hard pop. Falls back to an instant swap when view
// transitions aren't supported or under reduced motion — exactly today's behavior.
// `fn` performs the actual `view.innerHTML = …` swap. When this render is ALREADY
// running inside a transition (a seg-tap wraps the handler in one, and finishes with
// viewEnter()), we DON'T nest a second one — stacking startViewTransition() aborts the
// outer and flickers. We just swap and let the surrounding fade carry it.
function skelSwap(fn) {
    if (_vtActive) {
        return Promise.resolve(fn());
    }
    return withViewTransition(fn);
}
// Run a DOM-swapping fn inside a shared-element view transition when supported.
// `_vtActive` guards against accidentally nesting a transition inside another
// (which the browser would resolve by aborting the outer one).
let _vtActive = false;
function isViewTransitionAbort(err) {
    const row = err instanceof Error ? { name: err.name, message: err.message } : uiRecord(err);
    const name = String(row.name || "");
    const msg = String(row.message || err || "");
    return name === "AbortError" || (name === "InvalidStateError" && /transition/i.test(msg));
}
function withViewTransition(fn) {
    const run = () => {
        try {
            return Promise.resolve(fn());
        }
        catch (err) {
            return Promise.reject(err);
        }
    };
    const quietTransitionPromise = (promise) => Promise.resolve(promise).catch((err) => {
        if (!isViewTransitionAbort(err))
            throw err;
    });
    const quietSecondaryTransitionPromise = (promise) => Promise.resolve(promise).catch((err) => {
        if (!isViewTransitionAbort(err))
            setTimeout(() => { throw err; }, 0);
    });
    if (document.startViewTransition && !reducedMotion() && !_vtActive) {
        try {
            _vtActive = true;
            const tx = document.startViewTransition(run);
            const done = tx.updateCallbackDone || tx.finished || Promise.resolve();
            if (tx.ready)
                quietSecondaryTransitionPromise(tx.ready);
            if (tx.finished && tx.finished !== done)
                quietSecondaryTransitionPromise(tx.finished);
            return quietTransitionPromise(done)
                .finally(() => { _vtActive = false; });
        }
        catch {
            _vtActive = false; /* fall through */
        }
    }
    return Promise.resolve(run());
}
// Primary training discipline ('strength'|'endurance'|'hybrid'), read once from the
// profile and used for a GENTLE emphasis reframe — never to hide a surface. Default
// 'strength' so a profile that never set it behaves exactly as before. Refreshed by
// the profile loader (renderToday/renderMeProfile) and on a profile save.
let primaryDiscipline = "strength";
Object.defineProperty(globalThis, "primaryDiscipline", {
    configurable: true,
    get: () => primaryDiscipline,
    set: (value) => { primaryDiscipline = String(value || "strength"); },
});
function setDiscipline(d) {
    primaryDiscipline = d === "endurance" || d === "hybrid" ? d : "strength";
    return primaryDiscipline;
}
const isEndurance = () => primaryDiscipline === "endurance";
const isHybrid = () => primaryDiscipline === "hybrid";
// Whether the athlete has an endurance OBJECTIVE on file (a race or a standing
// readiness target). Primed from the profile alongside the discipline (warm-load +
// on save). Used to surface the Plan → Endurance tab even when the discipline label
// is 'strength' — setting a running goal is a clear signal you want a running plan.
let enduranceGoalSet = false;
Object.defineProperty(globalThis, "enduranceGoalSet", {
    configurable: true,
    get: () => enduranceGoalSet,
    set: (value) => { enduranceGoalSet = !!value; },
});
function setEnduranceGoalSet(present) { enduranceGoalSet = !!present; return enduranceGoalSet; }
// A runner home is warranted when the athlete trains endurance OR has set a goal.
const showEnduranceTab = () => isEndurance() || isHybrid() || enduranceGoalSet;
// tiny inline sparkline (numbers only — safe for innerHTML)
function sparklineSvg(vals, w = 132, h = 30) {
    const v = (Array.isArray(vals) ? vals : []).map(Number).filter((x) => !Number.isNaN(x));
    if (v.length < 2)
        return "";
    const min = Math.min(...v), max = Math.max(...v);
    const x = (i) => 2 + (i * (w - 4)) / (v.length - 1);
    const y = (n) => max === min ? h / 2 : h - 3 - ((n - min) / (max - min)) * (h - 6);
    const pts = v.map((n, i) => `${x(i).toFixed(1)},${y(n).toFixed(1)}`).join(" ");
    const last = v[v.length - 1];
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="currentColor"/>
    </svg>`;
}
// ---------- background enrichment (poll a row until its status settles) ----------
// pollToken is bumped on every full re-render so in-flight polls can detect a stale tab and bail.
let pollToken = 0;
function setPollTokenForClassicScripts(value) {
    pollToken = value;
    return pollToken;
}
Object.defineProperty(globalThis, "pollToken", {
    configurable: true,
    get: () => pollToken,
    set: (value) => { pollToken = Number(value) || 0; },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function enrichmentActive(status) {
    return status === "pending" || status === "in_progress";
}
// Poll GET path/:id every ~1.5s up to ~10 tries. onUpdate(row) runs per fetch while the tab
// is still current; resolves once status leaves the active states (or the cap is hit). Returns the last row.
async function pollEnrichment(path, id, { tab, token, onUpdate, tries = 10, interval = 1500 } = {}) {
    let row = null;
    for (let i = 0; i < tries; i++) {
        await sleep(interval);
        if (token !== pollToken || state.tab !== tab)
            return null; // navigated away / re-rendered
        try {
            row = uiRecord(await api(`${path}/${id}`));
        }
        catch {
            continue;
        }
        if (!row || row.error)
            continue;
        if (token !== pollToken || state.tab !== tab)
            return null;
        onUpdate && onUpdate(row);
        if (!enrichmentActive(row.enrichment_status))
            return row;
    }
    return row;
}
// Status badge: a quiet spinner ONLY while the coach is still refining a just-logged
// entry. Once it settles there's NO permanent tag — the refined entry itself is the
// result, and the capture toast already confirmed the log at the moment of action.
// (A persistent "✦ noted" used to sit on every entry forever; that was pure noise.)
function enrichBadge(status) {
    if (enrichmentActive(status))
        return `<span class="enr enr-pending">enriching...</span>`;
    return ""; // done / skipped / failed / undefined -> no lingering tag
}
// One-line description of an activity row from its (possibly refined) fields.
function activityLine(a) {
    const bits = [
        a.type,
        a.duration_min ? `${a.duration_min} min` : null,
        a.distance_km ? `${a.distance_km} km` : null,
        a.pace || null,
        a.rpe != null ? `RPE ${a.rpe}` : null,
    ].filter(Boolean).join(" · ");
    return bits || uiString(a.raw_text) || uiString(a.notes);
}
const CAIRN_UI_SHELL_GLOBALS = {
    setTodayHeaderTitle,
    updateHeaderCondense,
    toast,
    armDelete,
    wireGuides,
    exerciseExplanation,
    exerciseExplanationHtml,
    replaceExerciseExplanation,
    gotoChatWith,
    openFoodDetail,
    segBar,
    wireSeg,
    fitSeg,
    PROGRESS_SEG,
    PROGRESS_HANDLERS,
    planSeg,
    PLAN_HANDLERS,
    viewEnter,
    withViewTransition,
    skelSwap,
    setDiscipline,
    isEndurance,
    isHybrid,
    setEnduranceGoalSet,
    showEnduranceTab,
    sparklineSvg,
    setPollTokenForClassicScripts,
    enrichmentActive,
    pollEnrichment,
    enrichBadge,
    activityLine,
};
Object.assign(globalThis, CAIRN_UI_SHELL_GLOBALS);
if (typeof window !== "undefined") {
    Object.assign(window, CAIRN_UI_SHELL_GLOBALS);
}
})();
