(() => {
// @ts-check
// Today compatibility bridges: small adapters that preserve legacy globals while
// the focused controllers own the behavior.
{
    function makeTodayCompatibilityBridges(input) {
        const deps = () => input.dependencies();
        const briefDeps = () => deps().brief();
        const sessionSuggestDeps = () => deps().sessionSuggest();
        const sessionDeps = () => deps().session();
        const progressionDeps = () => deps().progression();
        const addExerciseDeps = () => deps().addExercise();
        const sideLoaderDeps = () => deps().sideLoaders();
        return {
            briefDeps,
            sessionSuggestDeps,
            sessionDeps,
            postExerciseMode(name, mode) {
                return input.api("/exercises", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, mode }),
                });
            },
            reconnectSessionSuggest(job) {
                return CairnTodaySessionSuggestController.reconnectSessionSuggest(job, sessionSuggestDeps());
            },
            revealSessionComposer() {
                CairnTodaySessionSuggestController.revealSessionComposer(sessionSuggestDeps());
            },
            async askForSession(opts = {}) {
                await CairnTodaySessionSuggestController.askForSession(opts, sessionSuggestDeps());
            },
            sessionDoneCard(session, day, { isToday }) {
                return CairnTodaySessionStatus.sessionDoneCardHtml(session, day, { isToday });
            },
            wireLogRow(row) {
                CairnTodaySessionController.wireLogRow(row, sessionDeps());
            },
            wireSkips() {
                CairnTodaySessionController.wireSkips(sessionDeps());
            },
            wireBrief(read, options) {
                CairnTodayBriefController.wireBrief(read, options, briefDeps());
            },
            reconnectDayReadOverride(job) {
                return CairnTodayBriefController.reconnectDayReadOverride(job, briefDeps());
            },
            scheduleRxRefresh() {
                CairnTodayProgressionController.scheduleRxRefresh(progressionDeps());
            },
            invalidateTodayProgression() {
                CairnTodayProgressionController.invalidateTodayProgression(progressionDeps());
            },
            async refreshAdaptedRx() {
                await CairnTodayProgressionController.refreshAdaptedRx(progressionDeps());
            },
            async setupAddExercise() {
                await CairnTodayAddExerciseController.setupAddExercise(addExerciseDeps());
            },
            async appendOffPlanCard(name, mode) {
                await CairnTodayAddExerciseController.appendOffPlanCard(name, mode, addExerciseDeps());
            },
            garminSessionCard(value) {
                return CairnTodaySideLoaders.garminSessionCard(value);
            },
            async loadWearable(isToday) {
                await CairnTodaySideLoaders.loadWearable(isToday, sideLoaderDeps());
            },
            async loadTableHint() {
                await CairnTodaySideLoaders.loadTableHint(sideLoaderDeps());
            },
            async loadContextBanner() {
                await CairnTodaySideLoaders.loadContextBanner(sideLoaderDeps());
            },
            async loadDraftProposals() {
                await CairnTodaySideLoaders.loadDraftProposals(sideLoaderDeps());
            },
            async loadHealthFocusBanner() {
                await CairnTodaySideLoaders.loadHealthFocusBanner(sideLoaderDeps());
            },
        };
    }
    const CAIRN_TODAY_COMPATIBILITY_BRIDGES = {
        create: makeTodayCompatibilityBridges,
    };
    Object.assign(globalThis, { CairnTodayCompatibilityBridges: CAIRN_TODAY_COMPATIBILITY_BRIDGES });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayCompatibilityBridges: CAIRN_TODAY_COMPATIBILITY_BRIDGES });
    }
}
})();
