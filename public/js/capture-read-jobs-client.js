(() => {
// @ts-check
// Quiet generation gates and reconnect handlers for Capture reads.
function createCaptureReadJobsController(deps) {
    const storage = deps.storage || null;
    const lastGate = (key) => {
        try {
            return Number(storage?.getItem(key) || 0);
        }
        catch {
            return 0;
        }
    };
    const burnGate = (key) => {
        try {
            storage?.setItem(key, String(Date.now()));
        }
        catch { }
    };
    const insightFailed = (r) => !r || r.ok === false || !r.insight;
    function maybeGenerateInsight() {
        const target = deps.slot("#insightSlot");
        if (!target)
            return;
        if (Date.now() - lastGate("cairn:lastInsightGen") < 20 * 3600 * 1000)
            return;
        deps.runOp("insight", {}, {
            path: "/insights/generate",
            anchor: "#insightSlot",
            guard: () => !deps.slot("#insightSlot")?.isConnected,
            isFail: (r) => insightFailed(r),
            render: (r) => {
                const result = r;
                burnGate("cairn:lastInsightGen");
                if (deps.state.tab !== "today")
                    return;
                const s = deps.slot("#insightSlot");
                if (s && result.insight)
                    deps.renderInsightInSlot(s, result.insight);
            },
            onFail: (err) => {
                if (err)
                    burnGate("cairn:lastInsightGen");
            },
        });
    }
    function maybeGenerateWeekly() {
        const target = deps.slot("#weeklySlot");
        if (!target)
            return;
        const dow = new Date().getDay(); // 0 Sun ... 6 Sat
        if (!(dow === 0 || dow === 5 || dow === 6))
            return;
        if (Date.now() - lastGate("cairn:lastWeeklyGen") < 6 * 24 * 3600 * 1000)
            return;
        deps.runOp("weekly_read", { kind: "weekly_read" }, {
            path: "/insights/generate",
            anchor: "#weeklySlot",
            guard: () => !deps.slot("#weeklySlot")?.isConnected,
            isFail: (r) => insightFailed(r),
            render: (r) => {
                const result = r;
                burnGate("cairn:lastWeeklyGen");
                if (deps.state.tab !== "today")
                    return;
                const s = deps.slot("#weeklySlot");
                if (s && result.insight)
                    deps.renderWeeklyInSlot(s, result.insight);
            },
            onFail: (err) => {
                if (err)
                    burnGate("cairn:lastWeeklyGen");
            },
        });
    }
    function reconnectInsight() {
        if (deps.state.tab !== "today")
            return null;
        const target = deps.slot("#insightSlot");
        if (!target)
            return null;
        return {
            guard: () => !deps.slot("#insightSlot")?.isConnected,
            onDone: (r) => {
                const result = r;
                if (insightFailed(result)) {
                    burnGate("cairn:lastInsightGen");
                    return;
                }
                burnGate("cairn:lastInsightGen");
                if (deps.state.tab !== "today")
                    return;
                const s = deps.slot("#insightSlot");
                if (s && result?.insight)
                    deps.renderInsightInSlot(s, result.insight);
            },
            onError: () => { },
            onCanceled: () => { },
        };
    }
    return {
        maybeGenerateInsight,
        maybeGenerateWeekly,
        reconnectInsight,
    };
}
const CAIRN_CAPTURE_READ_JOBS = {
    createController: createCaptureReadJobsController,
};
Object.assign(globalThis, { CairnCaptureReadJobs: CAIRN_CAPTURE_READ_JOBS });
if (typeof window !== "undefined") {
    Object.assign(window, { CairnCaptureReadJobs: CAIRN_CAPTURE_READ_JOBS });
}
})();
