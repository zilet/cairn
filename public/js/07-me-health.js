(() => {
// ==== 07-me-health.js ====
{
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
    function meHealthDepsContext() {
        return CairnMeHealthDependencies.context({
            root: view,
            state,
            segments: ME_SEG,
            handlers: ME_HANDLERS,
            document,
            headerTitle,
            api,
            cachedApi,
            peekCached,
            markRefreshing,
            swrInvalidate,
            runOp,
            toast,
            armDelete,
            activateTab: (tab) => activateTab(tab),
            escapeAttr: escAttr,
            escapeHtml: escHtml,
            invalidatePoll: () => { pollToken++; },
            mountSaveBar,
            primaryDiscipline: () => primaryDiscipline,
            renderMe,
            renderProfile: () => renderMeProfile(),
            segBar,
            segSkeleton,
            setDiscipline,
            setEnduranceGoalSet,
            skeletonSwap: skelSwap,
            wireSeg,
            fitSeg,
            syncRouteFromState: typeof syncRouteFromState === "function" ? syncRouteFromState : undefined,
            withViewTransition,
            select: $,
            relTime,
            relAge,
            stagger,
            reducedMotion,
            pollToken: () => pollToken,
            switchHealthSeg,
            onHealthReadView,
            loadHealthPicture: (token, docsPromise) => loadHealthPicture(token, docsPromise),
            paintHealthPicture,
            healthDocsKnownEmpty,
            paintRead: paintHealthReadTab,
            paintMarkers: paintHealthMarkersTab,
            paintRecords: paintHealthRecordsTab,
            paintShare: paintHealthShareTab,
            paintLearned: paintHealthLearnedTab,
            activityEntryHtml: (activity) => actEntryHtml(activity),
            openFoodDetail,
            loadDexaTargeting: typeof loadDexaTargeting === "function" ? loadDexaTargeting : undefined,
            storage: typeof localStorage !== "undefined" ? localStorage : null,
        });
    }
    function meProfileDeps() {
        return CairnMeHealthDependencies.profile(meHealthDepsContext());
    }
    async function renderMeProfile() {
        return CairnMeProfileController.renderProfile(meProfileDeps());
    }
    // Pure food-note parsing/rendering lives in food-note-client.js; the food detail
    // modal is owned by food-detail-controller.js.
    function meHealthLogRenderer() {
        return globalThis.CairnMeHealthLogRenderer;
    }
    function meHealthLogDeps() {
        return CairnMeHealthDependencies.log(meHealthDepsContext());
    }
    // tap a note card → full-screen food detail (zooming from its art tile)
    function wireNoteCard(el) {
        meHealthLogRenderer().wireNoteCard(el, meHealthLogDeps());
    }
    function renderNotes(notes) {
        meHealthLogRenderer().renderNotes(notes, meHealthLogDeps());
    }
    function renderActs(acts) {
        meHealthLogRenderer().renderActs(acts, meHealthLogDeps());
    }
    function meMemoryDeps() {
        return CairnMeHealthDependencies.memory(meHealthDepsContext());
    }
    async function renderMemory() {
        return CairnMeMemoryController.render(meMemoryDeps());
    }
    // ---------- Me: Health — the whole picture (review · markers · records) ----------
    function healthReadDeps() {
        return CairnMeHealthDependencies.read(meHealthDepsContext());
    }
    function healthPictureDeps() {
        return CairnMeHealthDependencies.picture(meHealthDepsContext());
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
        return CairnMeHealthDependencies.markers(meHealthDepsContext());
    }
    function loadHealthMarkers(token) {
        CairnHealthMarkersController.load(healthMarkersDeps(), token);
    }
    const HEALTH_SEG = CairnMeHealthTabsController.HEALTH_SEG;
    // Health is the lab-DATA + whole-picture-read home. Fold every legacy analysis/brain/
    // standing key onto Read (where that content now lives) so a returning client never
    // lands on a dead inner tab.
    function normalizeHealthSeg(seg) {
        return CairnMeHealthTabsController.normalizeHealthSeg(seg);
    }
    function meHealthTabsDeps() {
        return CairnMeHealthDependencies.tabs(meHealthDepsContext());
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
        await CairnMeHealthTabsController.renderHealth(meHealthTabsDeps());
    }
    // Slide the inner seg thumb + flip the active button to `seg` (no repaint).
    function setHealthSegActive(seg) {
        CairnMeHealthTabsController.setHealthSegActive(seg, meHealthTabsDeps());
    }
    // Programmatic inner-tab switch from a CTA. openPicker keeps the .click() in the
    // same user gesture (so the file dialog isn't blocked) — hence no view transition.
    function switchHealthSeg(seg, opts = {}) {
        CairnMeHealthTabsController.switchHealthSeg(seg, meHealthTabsDeps(), opts);
    }
    // Repaint #hContent for the active inner tab. Bumps pollToken so any enrichment
    // poll from the tab we're leaving stops cleanly (Records resumes on return).
    function paintHealthTab() {
        CairnMeHealthTabsController.paintHealthTab(meHealthTabsDeps());
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
    function healthStandingDeps() {
        return CairnMeHealthDependencies.standing(meHealthDepsContext());
    }
    function renderHealthStanding(data) {
        CairnHealthStandingController.render(data, healthStandingDeps());
    }
    function openBpSheet() {
        CairnHealthStandingController.openBpSheet(healthStandingDeps());
    }
    function loadHealthStanding(token, refAge) {
        CairnHealthStandingController.load(healthStandingDeps(), token, refAge);
    }
    function paintStandingReview() {
        CairnHealthStandingController.paintReview(healthStandingDeps());
    }
    function openHealthRead(opts = {}) {
        CairnHealthStandingController.openRead(healthStandingDeps(), opts);
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
