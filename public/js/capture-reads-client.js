(() => {
// @ts-check
// Quiet Today reads controller for Capture.
function captureReadDateApi() {
    return globalThis.CairnCaptureReadDate;
}
function captureReadCardsApi() {
    return globalThis.CairnCaptureReadCards;
}
function captureReadJobsApi() {
    return globalThis.CairnCaptureReadJobs;
}
function captureReadsWeekRangeLabel(iso) {
    return captureReadDateApi().weekRangeLabel(iso);
}
function createCaptureReadsController(deps) {
    const slot = (selector) => deps.root.querySelector(selector);
    const cardDeps = {
        api: deps.api,
        toast: deps.toast,
        collapseEl: deps.collapseEl,
        escapeHtml: deps.escapeHtml,
        weekRangeLabel: captureReadsWeekRangeLabel,
    };
    const cards = captureReadCardsApi();
    const renderInsightInSlot = (target, insight) => cards.renderInsightInSlot(target, insight, cardDeps);
    const renderWeeklyInSlot = (target, insight) => cards.renderWeeklyInSlot(target, insight, cardDeps);
    const jobs = captureReadJobsApi().createController({
        state: deps.state,
        runOp: deps.runOp,
        storage: deps.storage,
        slot,
        renderInsightInSlot,
        renderWeeklyInSlot,
    });
    // One fetch of GET /api/insights, split into two calm surfaces under the Brief:
    // the WEEKLY READ ("how the week went + the one change") and the one-at-a-time
    // CONNECTION insight. Empty means nothing renders; producers stay backgrounded.
    async function loadTodayReads() {
        const wSlot = slot("#weeklySlot");
        const iSlot = slot("#insightSlot");
        if (!wSlot && !iSlot)
            return;
        let list = [];
        try {
            list = await deps.api("/insights");
        }
        catch {
            list = [];
        }
        if (deps.state.tab !== "today")
            return;
        const arr = Array.isArray(list) ? list : [];
        if (wSlot && wSlot.isConnected) {
            const weekly = arr.find((i) => i && i.kind === "weekly_read");
            if (weekly)
                renderWeeklyInSlot(wSlot, weekly);
            else {
                wSlot.innerHTML = "";
                jobs.maybeGenerateWeekly();
            }
        }
        if (iSlot && iSlot.isConnected) {
            const conn = arr.find((i) => i && i.kind !== "weekly_read");
            if (conn)
                renderInsightInSlot(iSlot, conn);
            else {
                iSlot.innerHTML = "";
                jobs.maybeGenerateInsight();
            }
        }
    }
    return {
        weekRangeLabel: captureReadsWeekRangeLabel,
        loadTodayReads,
        reconnectInsight: jobs.reconnectInsight,
    };
}
const CAIRN_CAPTURE_READS = {
    createController: createCaptureReadsController,
    weekRangeLabel: captureReadsWeekRangeLabel,
};
Object.assign(globalThis, {
    CairnCaptureReads: CAIRN_CAPTURE_READS,
    weekRangeLabel: captureReadsWeekRangeLabel,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnCaptureReads: CAIRN_CAPTURE_READS,
        weekRangeLabel: captureReadsWeekRangeLabel,
    });
}
})();
