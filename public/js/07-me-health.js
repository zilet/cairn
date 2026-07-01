(() => {
function healthPictureCacheRoot() {
    return globalThis;
}
function getHealthPictureCache() {
    return healthPictureCacheRoot()._hPic ?? null;
}
function setHealthPictureCache(cache) {
    healthPictureCacheRoot()._hPic = cache;
    return cache;
}
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
    // ---------- Me: Memory (what the coach remembers) ----------
    // Pure Memory option and row renderers live in memory-client.js.
    async function renderMemory() {
        headerTitle.textContent = "Me";
        state.meSeg = "memory";
        pollToken++; // invalidate in-flight enrichment polls from a sibling sub-view
        view.innerHTML = segBar("memory", ME_SEG) + `
    <div class="sess"><div class="sess-line" style="color:var(--muted)">
      Facts and preferences the coach carries between sessions. Edit or remove anything that's stale.
    </div></div>
    <h1 class="lbl" style="margin:20px 0 8px">What the coach remembers</h1>
    <div class="memadd">
      <select id="memKind">${CairnMemory.memoryKindOptionsHtml()}</select>
      <input id="memInput" type="text" placeholder="Add something to remember…">
      <button id="memAdd" class="logbtn">+</button>
    </div>
    <div id="memlist" style="margin-top:12px"></div>`;
        wireSeg(ME_HANDLERS);
        const addBtn = $("#memAdd"), input = $("#memInput");
        const kindSelect = $("#memKind");
        if (!addBtn || !input || !kindSelect)
            return;
        const add = async () => {
            const content = input.value.trim();
            if (!content) {
                input.focus();
                return;
            }
            const kind = kindSelect.value;
            input.value = "";
            try {
                await api("/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content, kind }) });
            }
            catch {
                toast("Couldn't save that — try again.");
                return;
            }
            toast("Remembered");
            loadMemory();
        };
        addBtn.addEventListener("click", add);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter")
            add(); });
        loadMemory();
    }
    async function loadMemory() {
        const wrap = $("#memlist");
        if (!wrap)
            return;
        let items = [];
        try {
            const data = await api("/memory");
            items = Array.isArray(data) ? data : data && typeof data === "object" ? [data] : [];
        }
        catch {
            items = [];
        }
        if (state.tab !== "me" || state.meSeg !== "memory" || !wrap.isConnected)
            return;
        if (!items || !items.length) {
            wrap.innerHTML = `<div class="empty">Nothing remembered yet. As you chat and log, the coach keeps the facts and preferences that matter — they'll gather here.</div>`;
            return;
        }
        wrap.innerHTML = items.map((m, i) => CairnMemory.memoryRowHtml(m, i)).join("");
        wrap.querySelectorAll("[data-memedit]").forEach((b) => b.addEventListener("click", () => startMemEdit(b.closest(".memrow"))));
        wrap.querySelectorAll("[data-memdel]").forEach((b) => b.addEventListener("click", () => startMemDelete(b)));
    }
    // inline edit: swap the content line for an input + save/cancel
    function startMemEdit(row) {
        if (!row || row.querySelector(".memedit-box"))
            return;
        const id = row.dataset.mem;
        const contentEl = row.querySelector("[data-memcontent]");
        if (!id || !contentEl)
            return;
        const current = contentEl.textContent;
        contentEl.hidden = true;
        const box = document.createElement("div");
        box.className = "memedit-box";
        box.innerHTML = `<input class="memedit-in" type="text" value="${escAttr(current)}">
    <button class="iconbtn memok" title="save">✓</button>
    <button class="iconbtn" data-memcancel title="cancel">×</button>`;
        contentEl.after(box);
        const inp = box.querySelector(".memedit-in");
        if (!inp)
            return;
        inp.focus();
        inp.setSelectionRange(current.length, current.length);
        const cancel = () => { box.remove(); contentEl.hidden = false; };
        const save = async () => {
            const content = inp.value.trim();
            if (!content) {
                inp.focus();
                return;
            }
            try {
                await api(`/memory/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
            }
            catch {
                toast("Couldn't save that — try again.");
                return;
            }
            toast("Updated");
            loadMemory();
        };
        box.querySelector(".memok")?.addEventListener("click", save);
        box.querySelector("[data-memcancel]")?.addEventListener("click", cancel);
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter")
            save();
        else if (e.key === "Escape")
            cancel(); });
    }
    // two-tap armed × — the one destructive-confirm pattern (see armDelete in 02-ui.js)
    function startMemDelete(btn) {
        const row = btn.closest(".memrow");
        const id = row?.dataset.mem;
        if (!id)
            return;
        armDelete(btn, () => {
            api(`/memory/${id}`, { method: "DELETE" }).then(() => { toast("Removed"); loadMemory(); }).catch(() => toast("Couldn't remove that — try again."));
        });
    }
    // ---------- Me: Health — the whole picture (review · markers · records) ----------
    // The shared health-picture cache keeps Records and Health coordinated across
    // generated IIFEs; the in-flight
    // review run lives at module level so it survives sub-view re-renders (the POST can
    // take minutes — an agent CLI run) and quietly lands wherever the user is.
    let _hReviewRun = null; // in-flight POST /health/review promise
    let _hReviewErr = null; // gentle inline message after a failed run
    let _hReadSpy = null; // scroll-spy IntersectionObserver for the Read tab's sticky nav
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
    // Paint #hPicture from the shared cache + the in-flight run state. Safe to call anytime —
    // bails unless the Health sub-view is live.
    function paintHealthPicture() {
        const wrap = $("#hPicture");
        if (!wrap || !onHealthReadView() || !wrap.isConnected)
            return;
        if (_hReviewRun) {
            wrap.innerHTML = reviewBusyHtml();
            return;
        }
        const pic = getHealthPictureCache() ?? {};
        const err = _hReviewErr ? `<div class="hpic-err">${escHtml(_hReviewErr)}</div>` : "";
        const p = parsedReview(pic.review);
        if (!p && !((pic.docCount ?? 0) > 0)) {
            // nothing shared yet → inviting hero; CTA jumps to the Records tab + file picker
            wrap.innerHTML = healthHeroHtml(err);
            const b = $("#hHeroShare");
            if (b)
                b.addEventListener("click", () => switchHealthSeg("records", { openPicker: true }));
            return;
        }
        if (!p) {
            // records exist but no review yet → primary "build" action
            wrap.innerHTML = buildPictureHtml(err, pic.docCount ?? 0);
            const b = $("#hRevBtn");
            if (b)
                b.addEventListener("click", runHealthReview);
            return;
        }
        const review = (pic.review || {});
        const rT = Date.parse(String(review.created_at || "")) || 0;
        const dT = Date.parse(pic.newestDocAt || "") || 0;
        wrap.innerHTML = reviewHtml(review, rT > 0 && dT > rT, err);
        const b = $("#hRevBtn");
        if (b)
            b.addEventListener("click", runHealthReview);
    }
    // POST /api/health/review — an agent run that can take minutes. One in-flight run
    // max; the shimmer card holds the slot, and ok:false lands as a gentle inline note.
    async function runHealthReview() {
        if (_hReviewRun)
            return;
        _hReviewErr = null;
        _hReviewRun = api("/health/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
            .then((res) => (res && typeof res === "object" ? res : null))
            .catch(() => null);
        paintHealthPicture();
        const res = await _hReviewRun;
        _hReviewRun = null;
        if (res && res.ok && res.review) {
            state.healthReview = res.review;
            setHealthPictureCache({ ...(getHealthPictureCache() || {}), review: res.review });
            toast("Your picture is ready");
        }
        else {
            _hReviewErr = res && res.error
                ? `The review didn't finish: ${res.error}`
                : "The review didn't come back — give it another try in a bit.";
        }
        paintHealthPicture();
    }
    async function loadHealthPicture(token, docsP) {
        let review = null, docs = [], docsOk = false;
        try {
            const rawReview = await api("/health/review");
            review = rawReview && typeof rawReview === "object" ? rawReview : null;
        }
        catch {
            review = null;
        }
        try {
            docs = healthScreenRows(await docsP);
            docsOk = true;
        }
        catch {
            docs = [];
        }
        if (review && review.error)
            review = null;
        if (review)
            state.healthReview = review;
        if (token !== pollToken)
            return; // navigated away / re-rendered
        const newest = docs.reduce((m, d) => (d.created_at && (!m || d.created_at > m) ? d.created_at : m), null);
        setHealthPictureCache({ review, docCount: docs.length, newestDocAt: newest });
        // Persist the count so a returning new-user (a fresh page load resets the cache) still
        // opens Health on Records until they've added a document — see healthDocsKnownEmpty.
        // Only on a real fetch: a transient offline [] must never cache a false zero.
        if (docsOk) {
            try {
                localStorage.setItem("cairn:healthDocCount", String(docs.length));
            }
            catch { }
        }
        paintHealthPicture();
    }
    // ---- markers (trends) ----
    function fmtMkNum(v) {
        return CairnHealthMarkers.formatMarkerNumber(v);
    }
    function sparkDateLabel(d) {
        return CairnHealthMarkers.sparkDateLabel(d);
    }
    function markerTrendWord(m) {
        return CairnHealthMarkers.markerTrendWord(m);
    }
    function markerSpanWord(days) {
        return CairnHealthMarkers.markerSpanWord(days);
    }
    function markerChartSvg(m) {
        return CairnHealthMarkers.markerChartSvg(m);
    }
    function wireMarkerChart(svg) {
        if (!(svg instanceof SVGElement))
            return;
        CairnHealthMarkers.wireMarkerChart(svg);
    }
    function markerPanelHtml(m) {
        return CairnHealthMarkers.markerPanelHtml(m);
    }
    function hmkRowHtml(m, i) {
        return CairnHealthMarkers.hmkRowHtml(m, i);
    }
    function orderHealthMarkersForDisplay(groupKey, list) {
        return CairnHealthClient.orderMarkersForDisplay(groupKey, list);
    }
    function healthMarkerSubgroup(groupKey, name) {
        return CairnHealthClient.markerSubgroup(groupKey, name);
    }
    function lipidGroupNoteHtml(list) {
        return CairnHealthClient.lipidGroupNoteHtml(list, { relAge });
    }
    // SWR over /markers/priority (key shared with the Health → Read priority view): a
    // warm re-entry paints the grouped marker list instantly, then revalidates and
    // re-paints only if the payload changed. The render is unchanged — SWR only
    // changes WHEN the data arrives.
    function loadHealthMarkers(token) {
        const wrap = $("#hMarkers");
        if (!wrap || !wrap.isConnected)
            return;
        // /markers/priority is the superset: it carries the optimal bands (for the chart) plus
        // group + trend on top of the flat marker shape /health/markers returns.
        const paint = (res) => {
            if (token !== pollToken || !wrap.isConnected)
                return;
            const data = healthScreenRecord(res);
            const markers = healthScreenRows(data.markers);
            if (!markers.length) {
                wrap.innerHTML = CairnHealthClient.markersEmptyHtml(CairnHealthClient.HEALTH_HERO_ART);
                const b = wrap.querySelector("#hMkToRecords");
                if (b)
                    b.addEventListener("click", () => switchHealthSeg("records", { openPicker: true }));
                return;
            }
            // Server `groups` is the canonical ordered list of groups that hold ≥1 marker; render
            // headers in that order. Most groups preserve server priority order; lipids get a
            // clinician-style scan order so LDL variants and particle markers don't read as one pile.
            // Degrade gracefully if the backend hasn't shipped grouping yet: derive an ordered list
            // from the markers themselves, falling everything ungrouped into a single "Markers" bucket.
            let groups = healthScreenRows(data.groups).filter((g) => !!g.key);
            if (!groups.length) {
                const seen = new Set(), derived = [];
                for (const m of markers) {
                    const key = typeof m.group === "string" && m.group ? m.group : "other";
                    if (!seen.has(key)) {
                        seen.add(key);
                        derived.push({ key, label: m.group_label || (m.group ? m.group : "Markers") });
                    }
                }
                groups = derived;
            }
            const byGroup = new Map(groups.map((g) => [g.key, []]));
            for (const m of markers) {
                const groupKey = typeof m.group === "string" ? m.group : "";
                const key = byGroup.has(groupKey) ? groupKey : (groups[0] && groups[0].key);
                if (key && byGroup.has(key))
                    byGroup.get(key)?.push(m);
            }
            let i = 0;
            const sections = groups.map((g, gi) => {
                const list = (typeof orderHealthMarkersForDisplay === "function")
                    ? orderHealthMarkersForDisplay(g.key, byGroup.get(g.key) || [])
                    : (byGroup.get(g.key) || []);
                if (!list.length)
                    return "";
                let lastSub = "";
                const rows = list.map((m) => {
                    const subgroup = typeof healthMarkerSubgroup === "function"
                        ? healthMarkerSubgroup(g.key, m.name || m.key || "")
                        : "";
                    const subhead = subgroup && subgroup !== lastSub
                        ? `<div class="hmk-subhead">${escHtml(subgroup)}</div>`
                        : "";
                    if (subgroup)
                        lastSub = subgroup;
                    return subhead + hmkRowHtml(m, i++);
                }).join("");
                const head = `<div class="hmk-grouphead lbl reveal" style="${stagger(gi)}">${escHtml(g.label || g.key)}</div>`;
                const note = g.key === "lipids" && typeof lipidGroupNoteHtml === "function"
                    ? lipidGroupNoteHtml(list)
                    : "";
                return `<section class="hmk-section">${head}${note}<div class="hmk-card">${rows}</div></section>`;
            }).join("");
            // The clinical report + portable export live on their own Share sub-tab, so the
            // catalog doesn't repeat a "share with your doctor" footer here.
            wrap.innerHTML = `<div class="hmk-groups">${sections}</div>`;
            wrap.querySelectorAll(".hmk-x .hmk-row").forEach((b) => b.addEventListener("click", () => {
                const item = b.closest(".hmk");
                if (!item)
                    return;
                const open = item.classList.toggle("open");
                b.setAttribute("aria-expanded", open ? "true" : "false");
            }));
            wrap.querySelectorAll("svg.hchart").forEach(wireMarkerChart);
        };
        const peek = peekCached("markers:priority");
        if (peek) {
            paint(peek.data);
            if (!peek.fresh)
                markRefreshing(true);
        }
        cachedApi("/markers/priority", {
            key: "markers:priority",
            onUpgrade: (data, { changed }) => { if (peek && !peek.fresh)
                markRefreshing(false); if (changed || !peek)
                paint(data); },
            // No cached read + a thrown fetch (offline / parse failure): clear the
            // "Loading markers…" placeholder to the calm empty state, never a stuck loader.
        }).catch(() => { if (peek && !peek.fresh)
            markRefreshing(false); if (!peek)
            paint(null); });
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
        const pic = getHealthPictureCache();
        if (pic && Number.isFinite(pic.docCount))
            return pic.docCount === 0;
        try {
            const cached = localStorage.getItem("cairn:healthDocCount");
            if (cached != null)
                return Number(cached) === 0;
        }
        catch { }
        return false;
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
        const c = $("#hContent");
        if (!c)
            return;
        if (_hReadSpy) {
            _hReadSpy.disconnect();
            _hReadSpy = null;
        } // drop a prior tab's observer
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
        const chips = [...c.querySelectorAll(".hread-chip")];
        const setActiveChip = (id) => chips.forEach((ch) => ch.classList.toggle("active", ch.dataset.jump === id));
        // Jump chips: scroll the target slot into view; scroll-margin-top (CSS) keeps it clear
        // of the sticky seg + nav. Mark it active immediately so the tap reads as a selection.
        chips.forEach((b) => b.addEventListener("click", () => {
            const el = b.dataset.jump ? view.querySelector("#" + b.dataset.jump) : null;
            if (el)
                el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
            setActiveChip(b.dataset.jump);
        }));
        // Scroll-spy: highlight the chip for whichever section sits under the sticky nav. The
        // band (rootMargin) starts below the pinned chrome; the topmost section in it wins.
        // Sections WITHOUT their own chip (the picture reads under "The read", symptom links
        // under "Connections") map to the owning chip so no scroll position is left unlit.
        if ("IntersectionObserver" in window) {
            const spy = [["hSynthesis", "hSynthesis"], ["hPicture", "hSynthesis"], ["hbDirectives", "hbDirectives"], ["hbSymptomLinks", "hbDirectives"], ["hRecovery", "hRecovery"], ["hbMarkers", "hbMarkers"], ["hbSupplements", "hbSupplements"]];
            const owner = new Map(spy);
            const order = spy.map(([id]) => id);
            const visible = new Set();
            _hReadSpy = new IntersectionObserver((entries) => {
                for (const e of entries) {
                    if (e.isIntersecting)
                        visible.add(e.target.id);
                    else
                        visible.delete(e.target.id);
                }
                const top = order.find((id) => visible.has(id));
                if (top)
                    setActiveChip(owner.get(top));
            }, { rootMargin: "-104px 0px -55% 0px", threshold: 0 });
            const spyObserver = _hReadSpy;
            order.forEach((id) => { const el = document.getElementById(id); if (el && spyObserver)
                spyObserver.observe(el); });
        }
        loadHealthSynthesis(pollToken);
        loadRecoverySummary(pollToken, "#hRecovery");
        loadPriorityMarkers(pollToken);
        const directivesLoaded = CairnHealthDirectiveLoader.load(pollToken);
        loadSymptomLinks(pollToken);
        loadSupplements(pollToken);
        // A provenance "why" deep-link can ask to land on the referenced directive rather
        // than the top. The directives rail hydrates async, so wait for it to render, then
        // scroll it into view. Consumed once; a normal entry never scrolls.
        if (state.pendingHealthScroll === "hbDirectives") {
            const token = pollToken;
            state.pendingHealthScroll = null;
            void directivesLoaded.then(() => { if (token === pollToken)
                scrollHealthRailIntoView("#hbDirectives"); });
        }
        if (_hReviewRun) {
            paintHealthPicture();
            return;
        } // a run is still cooking
        loadHealthPicture(pollToken, api("/health-docs"));
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
    // Bring a Standing-tab connected-brain rail target into view once it has real content
    // (the rail loads async, so wait for its "Gathering…" placeholder to be replaced
    // before scrolling). pollToken-guarded so switching sub-views cancels it cleanly.
    function scrollHealthRailIntoView(sel) {
        const token = pollToken;
        let tries = 0;
        const onRead = () => state.tab === "me" && state.meSeg === "health" && state.healthSeg === "read";
        const tick = () => {
            if (token !== pollToken || !onRead())
                return;
            const el = view.querySelector(sel);
            const ready = el && !el.querySelector(".hb-load"); // directives rendered (placeholder gone)
            if (ready || tries > 20) {
                if (el)
                    el.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
                return;
            }
            tries++;
            setTimeout(tick, 80);
        };
        setTimeout(tick, 80);
    }
    // ---- the elite-coach synthesis: the whole picture, read as ONE prioritized story ----
    // Leads the Read tab as a tight narrative: headline + connected story + the 2-3
    // priorities + the one change. The deterministic act-now / worth-tracking TIERS it
    // used to repeat are now carried by the actionable connected-brain list (#hbDirectives)
    // rendered directly below, so we no longer duplicate them here. Pull: it waits here; a
    // refresh regenerates it as a streamed job. No scores; informational, never a verdict.
    function renderHealthSynthesis(data, token) {
        const wrap = $("#hSynthesis");
        if (!wrap || !wrap.isConnected || (token != null && token !== pollToken))
            return;
        const payload = healthScreenRecord(data);
        const s = payload.synthesis && typeof payload.synthesis === "object" ? payload.synthesis : null;
        const focus = healthScreenRecord(payload.focus);
        const hasFocus = Array.isArray(focus.priorities) && focus.priorities.length;
        if (!s && !hasFocus) {
            wrap.innerHTML = "";
            return;
        } // nothing to synthesize yet — stay quiet
        // Newer labs landed since this read was written? Warn calmly, the same way the
        // review card does — so the narrative never silently contradicts the fresh
        // connected-brain list below it. Read defensively for both response shapes.
        const stale = payload.stale ?? (s && s.stale) ?? false;
        const prios = s && Array.isArray(s.priorities) ? healthScreenRows(s.priorities).filter((p) => p.label || p.the_move) : [];
        let body;
        if (s && s.headline) {
            body = `
      <h3 class="hsyn-headline">${escHtml(s.headline)}</h3>
      ${s.story ? `<p class="hsyn-story">${escHtml(s.story)}</p>` : ""}
      ${prios.length ? `<div class="hsyn-prios">${prios.map((p) => `
        <div class="hsyn-prio">
          <span class="hsyn-plabel">${escHtml(p.label || "")}</span>
          ${p.the_move ? `<span class="hsyn-pmove">${escHtml(p.the_move)}</span>` : ""}
          ${p.recheck ? `<span class="hsyn-precheck lbl">${escHtml(p.recheck)}</span>` : ""}
        </div>`).join("")}</div>` : ""}
      ${s.one_change ? `<div class="hsyn-onechange"><span class="lbl">If you change one thing</span><span>${escHtml(s.one_change)}</span></div>` : ""}
      <div class="hsyn-foot"><span class="lbl">${s.generated_at ? `read ${escHtml(relTime(s.generated_at))}` : ""}</span>${stale
                ? `<button id="hsynRefresh" class="hpic-refresh hpic-refresh-stale" type="button" title="New results since this read"><span class="hdot hdot-warn"></span>New results — refresh</button>`
                : `<button class="linkbtn" id="hsynRefresh" type="button">refresh</button>`}</div>`;
        }
        else {
            body = `
      <p class="hsyn-invite">Your labs, training, recovery and nutrition — read as one connected, prioritized picture.</p>
      <button class="draftbtn hsyn-gen" id="hsynGen" type="button">Read my whole picture</button>`;
        }
        wrap.innerHTML = `<div class="hsyn reveal"><div class="hsyn-kicker lbl">Your health — one picture</div>${body}</div>`;
        $("#hsynRefresh")?.addEventListener("click", triggerHealthSynthesis);
        $("#hsynGen")?.addEventListener("click", triggerHealthSynthesis);
    }
    function loadHealthSynthesis(token) {
        const wrap = $("#hSynthesis");
        if (!wrap || !wrap.isConnected)
            return;
        api("/health/synthesis")
            .then((data) => renderHealthSynthesis(data || {}, token))
            .catch(() => { });
    }
    // Regenerate the synthesis — a streamed background job (reads the whole picture;
    // can take ~30-90s), reconnects across reloads via runOp.
    function triggerHealthSynthesis() {
        const wrap = $("#hSynthesis");
        if (!wrap)
            return;
        const card = wrap.querySelector(".hsyn");
        if (card && !card.querySelector(".job-cap")) {
            const cap = document.createElement("div");
            cap.className = "job-cap lbl hsyn-cap";
            card.appendChild(cap);
        }
        runOp("health_synthesis", {}, {
            path: "/health/synthesis",
            anchor: "#hSynthesis .hsyn",
            caption: ["reading your labs", "connecting it to your training & recovery", "finding what matters most", "writing your picture"],
            guard: () => !$("#hSynthesis")?.isConnected,
            render: (result) => {
                const payload = healthScreenRecord(result);
                if (payload.synthesis)
                    renderHealthSynthesis(payload, pollToken);
                else
                    loadHealthSynthesis(pollToken);
                swrInvalidate("plan:coach");
            },
            onFail: () => { toast("Couldn't read the picture right now — try again in a bit."); loadHealthSynthesis(pollToken); },
        });
    }
    // ---- Supplements: UNDERSTANDING, not a daily log ----
    // Say it once in plain words ("creatine daily, omega-3, some D, whey occasionally")
    // → the system approximates each into name · dose · cadence and folds it into the
    // connected brain. No rows-per-day, no check-offs — just what you're taking.
    // Symptom ↔ marker connections — a quiet "worth mentioning to your doctor" read when
    // something the athlete logged (a life event, a check-in note) lines up with an
    // out-of-range marker. Pull-only, informational, never diagnostic. Renders nothing
    // when there's no genuine co-occurrence (the common, calm case).
    async function loadSymptomLinks(token) {
        const wrap = $("#hbSymptomLinks");
        if (!wrap || !wrap.isConnected)
            return;
        let r = null;
        try {
            r = await api("/symptom-links");
        }
        catch {
            r = null;
        }
        if ((token != null && token !== pollToken) || !wrap.isConnected)
            return;
        const links = healthScreenRows(r?.links);
        if (!links.length) {
            wrap.innerHTML = "";
            return;
        }
        const cards = links.slice(0, 3).map((l) => {
            const mk = Array.isArray(l.markers)
                ? healthScreenRows(l.markers).map((m) => `${escHtml(m.name)}${m.value != null ? ` ${escHtml(String(m.value))}` : ""}${m.unit ? ` ${escHtml(m.unit)}` : ""}`).join(", ")
                : "";
            return `<div class="symlink">
        <div class="symlink-note">${escHtml(l.note || "")}</div>
        ${mk ? `<div class="symlink-mk lbl">${mk}</div>` : ""}
      </div>`;
        }).join("");
        wrap.innerHTML = `<div class="hb-section symlink-card reveal">
      <span class="lbl">Worth mentioning to your doctor</span>
      <p class="symlink-sub">Something you noted lines up with one of your lab markers. Informational only — a question for your clinician, never a diagnosis.</p>
      ${cards}
    </div>`;
    }
    function loadSupplements(token) {
        const wrap = $("#hbSupplements");
        if (!wrap || !wrap.isConnected)
            return;
        const peek = peekCached("supplements");
        if (peek)
            renderSupplements(peek.data, token);
        cachedApi("/supplements", {
            key: "supplements",
            onUpgrade: (data, { changed }) => { if (changed || !peek)
                renderSupplements(data, token); },
        }).catch(() => { if (!peek)
            renderSupplements([], token); });
    }
    function renderSupplements(list, token) {
        const wrap = $("#hbSupplements");
        if (!wrap || !wrap.isConnected || (token != null && token !== pollToken))
            return;
        const items = healthScreenRows(list);
        const chips = items.map((s) => {
            const bits = [s.dose, s.frequency].filter(Boolean).map(escHtml).join(" · ");
            return `<div class="supp-chip" title="${escAttr(s.note || s.name)}">
        <span class="supp-name">${escHtml(s.name)}</span>${bits ? `<span class="supp-meta">${bits}</span>` : ""}
        <button class="supp-x" data-suppx="${s.id}" aria-label="Remove ${escAttr(s.name)}">×</button>
      </div>`;
        }).join("");
        wrap.innerHTML = `<div class="hb-section supp-card reveal" style="${stagger(3)}">
      <span class="lbl">What you're taking</span>
      <p class="supp-sub">Say it once in plain words — I'll approximate the rest and fold it into your picture.</p>
      ${items.length ? `<div class="supp-chips">${chips}</div>` : `<p class="supp-empty">Nothing yet. Tell me below, or just mention it in chat.</p>`}
      <div class="supp-input">
        <input id="suppText" type="text" placeholder="e.g. creatine daily, omega-3…" autocomplete="off" />
        <button id="suppAdd" class="ghostbtn">Add</button>
      </div>
    </div>`;
        const input = $("#suppText");
        const submit = () => understandSupplementsFromInput();
        $("#suppAdd")?.addEventListener("click", submit);
        input?.addEventListener("keydown", (e) => { if (e.key === "Enter") {
            e.preventDefault();
            submit();
        } });
        wrap.querySelectorAll("[data-suppx]").forEach((b) => b.addEventListener("click", () => removeSupplement(Number(b.dataset.suppx))));
    }
    async function understandSupplementsFromInput() {
        const input = $("#suppText");
        const text = (input?.value || "").trim();
        if (!text)
            return;
        const btn = $("#suppAdd");
        if (btn) {
            btn.disabled = true;
            btn.textContent = "Reading…";
        }
        try {
            await api("/supplements/understand", {
                method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
            });
            swrInvalidate("supplements");
            loadSupplements(pollToken);
        }
        catch {
            if (btn) {
                btn.disabled = false;
                btn.textContent = "Add";
            }
        }
    }
    async function removeSupplement(id) {
        try {
            await api(`/supplements/${id}`, { method: "DELETE" });
            swrInvalidate("supplements");
            loadSupplements(pollToken);
        }
        catch { }
    }
    // ---- Recovery (calm, plain-language; never a score) ----
    // Render a quiet line about how recovery's been over the window. ONE home now: the
    // top of the Read view (#hRecovery). Bails to nothing / a quiet hint when there's
    // no wearable or check-in data.
    // SWR over /recovery?days=14 (key recovery:14): a warm re-entry paints the recovery
    // read instantly, then revalidates. `sel` targets which slot this call paints.
    function loadRecoverySummary(token, sel) {
        const wrap = $(sel);
        if (!wrap || !wrap.isConnected)
            return;
        const paint = (r) => {
            const summary = healthScreenRecord(r);
            const w = $(sel);
            if (token !== pollToken || !w || !w.isConnected)
                return;
            if (!summary.has_data) {
                // quiet hint, not a nag — capture is offered, never demanded
                w.innerHTML = CairnHealthRead.recoveryNoDataHtml();
                return;
            }
            w.innerHTML = CairnHealthRead.recoveryHtml(summary);
        };
        const peek = peekCached("recovery:14");
        if (peek) {
            paint(peek.data);
            if (!peek.fresh)
                markRefreshing(true);
        }
        cachedApi("/recovery?days=14", {
            key: "recovery:14",
            onUpgrade: (data, { changed }) => { if (peek && !peek.fresh)
                markRefreshing(false); if (changed || !peek)
                paint(data); },
        }).catch(() => { if (peek && !peek.fresh)
            markRefreshing(false); });
    }
    // ---- Priority markers (optimal-zone framing, never a score) ----
    // Phrase each marker in plain language against its optimal zone: "ApoB — above
    // optimal", "HbA1c — in your optimal range", "Ferritin — below optimal". Order
    // comes from the server (impact_score); we NEVER render that number.
    // SWR over /markers/priority (key shared with the Markers tab): a warm re-entry
    // into the Health → Read view paints "what matters now" instantly, then revalidates.
    function loadPriorityMarkers(token) {
        const wrap = $("#hbMarkers");
        if (!wrap || !wrap.isConnected)
            return;
        const paint = (res) => {
            if (token !== pollToken || !wrap.isConnected)
                return;
            const markers = healthScreenRows(healthScreenRecord(res).markers);
            wrap.innerHTML = CairnHealthRead.priorityMarkersSectionHtml(markers);
            $("#hbToMarkers")?.addEventListener("click", () => switchHealthSeg("markers"));
        };
        const peek = peekCached("markers:priority");
        if (peek) {
            paint(peek.data);
            if (!peek.fresh)
                markRefreshing(true);
        }
        cachedApi("/markers/priority", {
            key: "markers:priority",
            onUpgrade: (data, { changed }) => { if (peek && !peek.fresh)
                markRefreshing(false); if (changed || !peek)
                paint(data); },
            // No cached read + a thrown fetch (offline / parse failure): clear the
            // "Reading what matters most…" placeholder to the calm empty state instead
            // of leaving the loader stuck forever.
        }).catch(() => { if (peek && !peek.fresh)
            markRefreshing(false); if (!peek)
            paint(null); });
    }
    // ---- Cross-domain directives, grouped by domain (the review side) ----
    // Pure directive grouping and card rendering live in health-client.js.
    Object.assign(globalThis, {
        HEALTH_SEG,
        ME_HANDLERS,
        ME_SEG,
        buildPictureHtml,
        fmtMkNum,
        getHealthPictureCache,
        healthDotClass,
        healthDocsKnownEmpty,
        healthHeroHtml,
        healthMarkerSubgroup,
        hmkRowHtml,
        lipidGroupNoteHtml,
        loadHealthMarkers,
        loadHealthPicture,
        loadHealthStanding,
        loadHealthSynthesis,
        loadPriorityMarkers,
        loadRecoverySummary,
        loadSupplements,
        loadSymptomLinks,
        markerChartSvg,
        markerPanelHtml,
        markerSpanWord,
        markerTrendWord,
        normalizeHealthSeg,
        onHealthReadView,
        openBpSheet,
        openHealthRead,
        orderHealthMarkersForDisplay,
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
        sparkDateLabel,
        startMemDelete,
        startMemEdit,
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
