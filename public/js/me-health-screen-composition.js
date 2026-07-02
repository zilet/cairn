(() => {
// @ts-check
// Me + Health screen composition: section routing, dependency assembly, and
// controller delegation for the classic-script PWA surface.
const ME_HEALTH_SCREEN_SEGMENTS = [["standing", "Standing"], ["profile", "Profile"], ["health", "Health"], ["life", "Life"], ["family", "Family"], ["memory", "Memory"]];
function createMeHealthScreenComposition(input) {
    const handlers = {
        standing: () => screen.renderMeStanding(),
        profile: () => screen.renderMeProfile(),
        memory: () => screen.renderMemory(),
        health: () => screen.renderHealth(),
        life: () => input.renderLife(),
        family: () => input.renderFamily(),
    };
    function context() {
        return CairnMeHealthDependencies.context({
            root: input.root,
            state: input.state,
            segments: ME_HEALTH_SCREEN_SEGMENTS,
            handlers,
            document: input.document,
            headerTitle: input.headerTitle,
            api: input.api,
            cachedApi: input.cachedApi,
            peekCached: input.peekCached,
            markRefreshing: input.markRefreshing,
            swrInvalidate: input.swrInvalidate,
            runOp: input.runOp,
            toast: input.toast,
            armDelete: input.armDelete,
            activateTab: input.activateTab,
            escapeAttr: input.escapeAttr,
            escapeHtml: input.escapeHtml,
            invalidatePoll: input.invalidatePoll,
            mountSaveBar: input.mountSaveBar,
            primaryDiscipline: input.primaryDiscipline,
            renderMe: () => screen.renderMe(),
            renderProfile: () => screen.renderMeProfile(),
            segBar: input.segBar,
            segSkeleton: input.segSkeleton,
            setDiscipline: input.setDiscipline,
            setEnduranceGoalSet: input.setEnduranceGoalSet,
            skeletonSwap: input.skeletonSwap,
            wireSeg: input.wireSeg,
            fitSeg: input.fitSeg,
            syncRouteFromState: input.syncRouteFromState(),
            withViewTransition: input.withViewTransition,
            select: input.select,
            relTime: input.relTime,
            relAge: input.relAge,
            stagger: input.stagger,
            reducedMotion: input.reducedMotion,
            pollToken: input.pollToken,
            switchHealthSeg: (seg, opts) => screen.switchHealthSeg(seg, opts),
            onHealthReadView: () => screen.onHealthReadView(),
            loadHealthPicture: (token, docsPromise) => screen.loadHealthPicture(token, docsPromise),
            paintHealthPicture: () => screen.paintHealthPicture(),
            healthDocsKnownEmpty: () => screen.healthDocsKnownEmpty(),
            paintRead: () => screen.paintHealthReadTab(),
            paintMarkers: () => input.paintHealthMarkersTab(),
            paintRecords: () => input.paintHealthRecordsTab(),
            paintShare: () => input.paintHealthShareTab(),
            paintLearned: () => input.paintHealthLearnedTab(),
            activityEntryHtml: input.activityEntryHtml,
            openFoodDetail: input.openFoodDetail,
            loadDexaTargeting: input.loadDexaTargeting(),
            storage: input.storage(),
        });
    }
    function healthReadDeps() {
        return CairnMeHealthDependencies.read(context());
    }
    function healthPictureDeps() {
        return CairnMeHealthDependencies.picture(context());
    }
    function healthStandingDeps() {
        return CairnMeHealthDependencies.standing(context());
    }
    const screen = {
        get HEALTH_SEG() {
            return CairnMeHealthTabsController.HEALTH_SEG;
        },
        handlers,
        segments: ME_HEALTH_SCREEN_SEGMENTS,
        buildPictureHtml: (err, docCount) => CairnHealthPicture.buildPictureHtml(err, docCount),
        context,
        getHealthPictureCache: () => CairnHealthPictureController.getHealthPictureCache(),
        healthDotClass: (flag) => CairnHealthPicture.healthDotClass(flag),
        healthDocsKnownEmpty: () => CairnHealthPictureController.healthDocsKnownEmpty(healthPictureDeps()),
        healthHeroHtml: (err) => CairnHealthPicture.healthHeroHtml(err),
        healthMarkersDeps: () => CairnMeHealthDependencies.markers(context()),
        healthPictureDeps,
        healthReadDeps,
        healthStandingDeps,
        loadHealthMarkers: (token) => {
            CairnHealthMarkersController.load(screen.healthMarkersDeps(), token);
        },
        loadHealthPicture: async (token, docsPromise) => {
            await CairnHealthPictureController.loadHealthPicture(token, docsPromise, healthPictureDeps());
        },
        loadHealthStanding: (token, refAge) => {
            CairnHealthStandingController.load(healthStandingDeps(), token, refAge);
        },
        loadHealthSynthesis: (token) => {
            CairnHealthReadController.loadSynthesis(healthReadDeps(), token);
        },
        loadPriorityMarkers: (token) => {
            CairnHealthReadController.loadPriorityMarkers(healthReadDeps(), token);
        },
        loadRecoverySummary: (token, sel) => {
            CairnHealthReadController.loadRecoverySummary(healthReadDeps(), token, sel);
        },
        loadSupplements: (token) => {
            CairnHealthReadController.loadSupplements(healthReadDeps(), token);
        },
        loadSymptomLinks: async (token) => {
            await CairnHealthReadController.loadSymptomLinks(healthReadDeps(), token);
        },
        meHealthLogDeps: () => CairnMeHealthDependencies.log(context()),
        meHealthLogRenderer: () => globalThis.CairnMeHealthLogRenderer,
        meHealthTabsDeps: () => CairnMeHealthDependencies.tabs(context()),
        meMemoryDeps: () => CairnMeHealthDependencies.memory(context()),
        meProfileDeps: () => CairnMeHealthDependencies.profile(context()),
        normalizeHealthSeg: (seg) => CairnMeHealthTabsController.normalizeHealthSeg(seg),
        onHealthReadView: () => input.state.tab === "me" && input.state.meSeg === "health" && input.state.healthSeg === "read",
        openBpSheet: () => {
            CairnHealthStandingController.openBpSheet(healthStandingDeps());
        },
        openHealthRead: (opts = {}) => {
            CairnHealthStandingController.openRead(healthStandingDeps(), opts);
        },
        paintHealthPicture: () => {
            CairnHealthPictureController.paintHealthPicture(healthPictureDeps());
        },
        paintHealthReadTab: () => {
            CairnHealthReadController.paintTab(healthReadDeps());
        },
        paintHealthTab: () => {
            CairnMeHealthTabsController.paintHealthTab(screen.meHealthTabsDeps());
        },
        paintStandingReview: () => {
            CairnHealthStandingController.paintReview(healthStandingDeps());
        },
        parsedReview: (r) => CairnHealthPicture.parsedReview(r),
        renderActs: (acts) => {
            screen.meHealthLogRenderer().renderActs(acts, screen.meHealthLogDeps());
        },
        renderHealth: async () => {
            await CairnMeHealthTabsController.renderHealth(screen.meHealthTabsDeps());
        },
        renderHealthStanding: (data) => {
            CairnHealthStandingController.render(data, healthStandingDeps());
        },
        renderHealthSynthesis: (data, token) => {
            CairnHealthReadController.renderSynthesis(data, healthReadDeps(), token);
        },
        renderMe: () => {
            input.headerTitle.textContent = "Me";
            input.invalidatePoll();
            // Standing + Health moved to the Stand tab; Me is now the about-you home,
            // reached from Settings → You, so it opens to Profile by default.
            if (!input.state.meSeg)
                input.state.meSeg = "profile";
            return (handlers[input.state.meSeg] || screen.renderMeProfile)();
        },
        renderMeProfile: async () => {
            await CairnMeProfileController.renderProfile(screen.meProfileDeps());
        },
        renderMeStanding: async () => {
            input.headerTitle.textContent = "Me";
            input.state.meSeg = "standing";
            input.invalidatePoll();
            input.root.innerHTML = input.segBar("standing", ME_HEALTH_SCREEN_SEGMENTS)
                + `<div class="cfocus-slot cfocus-standing-slot" id="cfocusStandingSlot"></div>`
                + `<div id="hContent"></div>`;
            input.wireSeg(handlers);
            input.loadCoachingFocus("#cfocusStandingSlot", input.root);
            screen.paintStandingReview();
        },
        renderMemory: async () => {
            await CairnMeMemoryController.render(screen.meMemoryDeps());
        },
        renderNotes: (notes) => {
            screen.meHealthLogRenderer().renderNotes(notes, screen.meHealthLogDeps());
        },
        renderSupplements: (list, token) => {
            CairnHealthReadController.renderSupplements(list, healthReadDeps(), token);
        },
        reviewBusyHtml: () => CairnHealthPicture.reviewBusyHtml(),
        reviewHtml: (review, stale, err) => CairnHealthPicture.reviewHtml(review, stale, err),
        runHealthReview: async () => {
            await CairnHealthPictureController.runHealthReview(healthPictureDeps());
        },
        scrollHealthRailIntoView: (sel) => {
            CairnHealthReadController.scrollHealthRailIntoView(healthReadDeps(), sel);
        },
        setHealthPictureCache: (cache) => CairnHealthPictureController.setHealthPictureCache(cache),
        setHealthSegActive: (seg) => {
            CairnMeHealthTabsController.setHealthSegActive(seg, screen.meHealthTabsDeps());
        },
        switchHealthSeg: (seg, opts = {}) => {
            CairnMeHealthTabsController.switchHealthSeg(seg, screen.meHealthTabsDeps(), opts);
        },
        triggerHealthSynthesis: () => {
            CairnHealthReadController.triggerSynthesis(healthReadDeps());
        },
        understandSupplementsFromInput: async () => {
            await CairnHealthReadController.understandSupplementsFromInput(healthReadDeps());
        },
        removeSupplement: async (id) => {
            await CairnHealthReadController.removeSupplement(id, healthReadDeps());
        },
        wireNoteCard: (el) => {
            screen.meHealthLogRenderer().wireNoteCard(el, screen.meHealthLogDeps());
        },
    };
    return screen;
}
const CairnMeHealthScreenComposition = {
    create: createMeHealthScreenComposition,
};
Object.assign(globalThis, { CairnMeHealthScreenComposition });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnMeHealthScreenComposition });
}
})();
