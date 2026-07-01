(() => {
// @ts-check
// Progress chart canvas lifecycle and scrub orchestration.
function drawLineChart(canvas, pts, opts = {}) {
    if (!canvas)
        return;
    const points = Array.isArray(pts) ? pts : [];
    const chartCanvas = canvas;
    const colors = CairnProgressChartDrawing.chartColors();
    const count = points.length;
    if (!count)
        return;
    const fmtVal = opts.fmt || ((value) => String(Math.round(value)));
    const dpr = window.devicePixelRatio || 1;
    const width = chartCanvas.clientWidth;
    const height = chartCanvas.clientHeight;
    chartCanvas.width = width * dpr;
    chartCanvas.height = height * dpr;
    const ctx = chartCanvas.getContext("2d");
    if (!ctx)
        return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const model = CairnProgressLineChartModel.buildModel(points, { goal: opts.goal, width, height });
    if (!model)
        return;
    const { xs, ys } = model;
    chartCanvas._chartXs = xs;
    const drawBase = () => {
        CairnProgressChartDrawing.drawBase(ctx, model, points, opts, colors, width, height);
    };
    const drawHighlight = (hx, hy, index, pop, withDate) => {
        CairnProgressChartDrawing.drawHighlight(ctx, {
            hx,
            hy,
            index,
            pop,
            withDate,
            model,
            points,
            options: opts,
            colors,
            width,
            height,
            formatValue: fmtVal,
        });
    };
    if (chartCanvas._raf) {
        cancelAnimationFrame(chartCanvas._raf);
        chartCanvas._raf = null;
    }
    const finalIndex = count - 1;
    const highlight = { x: xs[finalIndex], y: ys[finalIndex], pop: 0 };
    const target = { x: xs[finalIndex], y: ys[finalIndex], idx: finalIndex, scrubbing: false };
    chartCanvas._hl = highlight;
    const render = () => {
        drawBase();
        drawHighlight(highlight.x, highlight.y, target.idx, highlight.pop, target.scrubbing);
    };
    const tick = () => {
        highlight.x += (target.x - highlight.x) * 0.32;
        highlight.y += (target.y - highlight.y) * 0.32;
        highlight.pop *= 0.8;
        const settled = Math.abs(highlight.x - target.x) < 0.4 &&
            Math.abs(highlight.y - target.y) < 0.4 &&
            highlight.pop < 0.02;
        if (settled) {
            highlight.x = target.x;
            highlight.y = target.y;
            highlight.pop = 0;
        }
        render();
        chartCanvas._raf = settled ? null : requestAnimationFrame(tick);
    };
    chartCanvas._setTarget = (idx, scrubbing) => {
        const index = idx == null ? finalIndex : Math.max(0, Math.min(count - 1, idx));
        if (index !== target.idx)
            highlight.pop = 1;
        target.x = xs[index];
        target.y = ys[index];
        target.idx = index;
        target.scrubbing = !!scrubbing;
        if (reducedMotion()) {
            highlight.x = target.x;
            highlight.y = target.y;
            highlight.pop = 0;
            render();
            return;
        }
        if (!chartCanvas._raf)
            chartCanvas._raf = requestAnimationFrame(tick);
    };
    CairnProgressChartScrub.wire(chartCanvas);
    render();
}
const CAIRN_PROGRESS_CHART = {
    withAlpha: CairnProgressChartDrawing.withAlpha,
    chartColors: CairnProgressChartDrawing.chartColors,
    drawLineChart,
};
Object.assign(globalThis, {
    CairnProgressChart: CAIRN_PROGRESS_CHART,
    withAlpha: CairnProgressChartDrawing.withAlpha,
    chartColors: CairnProgressChartDrawing.chartColors,
    drawLineChart,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressChart: CAIRN_PROGRESS_CHART,
        withAlpha: CairnProgressChartDrawing.withAlpha,
        chartColors: CairnProgressChartDrawing.chartColors,
        drawLineChart,
    });
}
})();
