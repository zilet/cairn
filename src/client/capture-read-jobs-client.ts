// @ts-check
// Quiet generation gates and reconnect handlers for Capture reads.

function createCaptureReadJobsController(deps: CaptureReadJobsDeps): CaptureReadJobsController {
  const storage = deps.storage || null;
  const lastGate = (key: string) => {
    try {
      return Number(storage?.getItem(key) || 0);
    } catch {
      return 0;
    }
  };
  const burnGate = (key: string) => {
    try {
      storage?.setItem(key, String(Date.now()));
    } catch {}
  };
  const insightFailed = (r: CaptureInsightResult | null) => !r || r.ok === false || !r.insight;

  function maybeGenerateInsight(): void {
    const target = deps.slot("#insightSlot");
    if (!target) return;
    if (Date.now() - lastGate("cairn:lastInsightGen") < 20 * 3600 * 1000) return;
    deps.runOp("insight", {}, {
      path: "/insights/generate",
      anchor: "#insightSlot",
      guard: () => !deps.slot("#insightSlot")?.isConnected,
      isFail: (r: unknown) => insightFailed(r as CaptureInsightResult | null),
      render: (r: unknown) => {
        const result = r as CaptureInsightResult;
        burnGate("cairn:lastInsightGen");
        if (deps.state.tab !== "today") return;
        const s = deps.slot("#insightSlot");
        if (s && result.insight) deps.renderInsightInSlot(s, result.insight);
      },
      onFail: (err: unknown) => {
        if (err) burnGate("cairn:lastInsightGen");
      },
    });
  }

  function maybeGenerateWeekly(): void {
    const target = deps.slot("#weeklySlot");
    if (!target) return;
    const dow = new Date().getDay(); // 0 Sun ... 6 Sat
    if (!(dow === 0 || dow === 5 || dow === 6)) return;
    if (Date.now() - lastGate("cairn:lastWeeklyGen") < 6 * 24 * 3600 * 1000) return;
    deps.runOp("weekly_read", { kind: "weekly_read" }, {
      path: "/insights/generate",
      anchor: "#weeklySlot",
      // The weekly read is prose — stream it into the slot as the coach writes it;
      // done swaps in the final weekly card. (A connection insight is JSON-only, so
      // maybeGenerateInsight below does NOT stream.)
      stream: true,
      guard: () => !deps.slot("#weeklySlot")?.isConnected,
      isFail: (r: unknown) => insightFailed(r as CaptureInsightResult | null),
      render: (r: unknown) => {
        const result = r as CaptureInsightResult;
        burnGate("cairn:lastWeeklyGen");
        if (deps.state.tab !== "today") return;
        const s = deps.slot("#weeklySlot");
        if (s && result.insight) deps.renderWeeklyInSlot(s, result.insight);
      },
      onFail: (err: unknown) => {
        if (err) burnGate("cairn:lastWeeklyGen");
      },
    });
  }

  function reconnectInsight(): ClientAgentOpHandlers | null {
    if (deps.state.tab !== "today") return null;
    const target = deps.slot("#insightSlot");
    if (!target) return null;
    return {
      guard: () => !deps.slot("#insightSlot")?.isConnected,
      onDone: (r: unknown) => {
        const result = r as CaptureInsightResult | null;
        if (insightFailed(result)) {
          burnGate("cairn:lastInsightGen");
          return;
        }
        burnGate("cairn:lastInsightGen");
        if (deps.state.tab !== "today") return;
        const s = deps.slot("#insightSlot");
        if (s && result?.insight) deps.renderInsightInSlot(s, result.insight);
      },
      onError: () => {},
      onCanceled: () => {},
    };
  }

  return {
    maybeGenerateInsight,
    maybeGenerateWeekly,
    reconnectInsight,
  };
}

const CAIRN_CAPTURE_READ_JOBS: CaptureReadJobsApi = {
  createController: createCaptureReadJobsController,
};

Object.assign(globalThis, { CairnCaptureReadJobs: CAIRN_CAPTURE_READ_JOBS });

if (typeof window !== "undefined") {
  Object.assign(window, { CairnCaptureReadJobs: CAIRN_CAPTURE_READ_JOBS });
}
