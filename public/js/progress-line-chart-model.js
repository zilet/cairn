(() => {
// @ts-check
// Pure Progress line-chart geometry helpers.
const PROGRESS_LINE_CHART_PADDING = {
    left: 36,
    right: 16,
    top: 30,
    bottom: 28,
};
function progressLineChartPadding(padding) {
    return {
        ...PROGRESS_LINE_CHART_PADDING,
        ...(padding || {}),
    };
}
function progressLineChartDomain(values, goal) {
    const allValues = goal != null ? [...values, Number(goal)] : values;
    let min = Math.min(...allValues);
    let max = Math.max(...allValues);
    if (max === min) {
        max += 1;
        min -= 1;
    }
    const spread = max - min;
    min -= spread * 0.14;
    max += spread * 0.2;
    return { min, max };
}
function progressLineChartSlopes(xs, ys) {
    const count = ys.length;
    const slopes = new Array(count).fill(0);
    if (count <= 1)
        return slopes;
    const deltas = [];
    for (let index = 0; index < count - 1; index++) {
        deltas.push((ys[index + 1] - ys[index]) / (xs[index + 1] - xs[index]));
    }
    slopes[0] = deltas[0];
    slopes[count - 1] = deltas[count - 2];
    for (let index = 1; index < count - 1; index++) {
        slopes[index] = deltas[index - 1] * deltas[index] <= 0 ? 0 : (deltas[index - 1] + deltas[index]) / 2;
    }
    for (let index = 0; index < count - 1; index++) {
        if (deltas[index] === 0) {
            slopes[index] = 0;
            slopes[index + 1] = 0;
            continue;
        }
        const a = slopes[index] / deltas[index];
        const b = slopes[index + 1] / deltas[index];
        const hyp = Math.hypot(a, b);
        if (hyp > 3) {
            slopes[index] = ((3 * a) / hyp) * deltas[index];
            slopes[index + 1] = ((3 * b) / hyp) * deltas[index];
        }
    }
    return slopes;
}
function progressLineChartPeakIndex(values) {
    let peakIndex = 0;
    values.forEach((value, index) => {
        if (value > values[peakIndex])
            peakIndex = index;
    });
    return peakIndex;
}
function buildProgressLineChartModel(pts, options) {
    const points = Array.isArray(pts) ? pts : [];
    const count = points.length;
    if (!count)
        return null;
    const padding = progressLineChartPadding(options.padding);
    const values = points.map((point) => Number(point.v));
    const { min, max } = progressLineChartDomain(values, options.goal);
    const { width, height } = options;
    const x = (index) => count === 1
        ? (padding.left + width - padding.right) / 2
        : padding.left + (index * (width - padding.left - padding.right)) / (count - 1);
    const y = (value) => height - padding.bottom - ((value - min) / (max - min)) * (height - padding.top - padding.bottom);
    const xs = values.map((_, index) => x(index));
    const ys = values.map((value) => y(value));
    return {
        points,
        values,
        min,
        max,
        xs,
        ys,
        slopes: progressLineChartSlopes(xs, ys),
        padding,
        peakIndex: progressLineChartPeakIndex(values),
        x,
        y,
    };
}
function nearestProgressLineChartIndex(axis, pixelX) {
    if (!axis || !axis.length)
        return null;
    let index = 0;
    let best = Infinity;
    for (let candidate = 0; candidate < axis.length; candidate++) {
        const distance = Math.abs(axis[candidate] - pixelX);
        if (distance < best) {
            best = distance;
            index = candidate;
        }
    }
    return index;
}
const CAIRN_PROGRESS_LINE_CHART_MODEL = {
    buildModel: buildProgressLineChartModel,
    nearestIndex: nearestProgressLineChartIndex,
};
Object.assign(globalThis, {
    CairnProgressLineChartModel: CAIRN_PROGRESS_LINE_CHART_MODEL,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressLineChartModel: CAIRN_PROGRESS_LINE_CHART_MODEL,
    });
}
})();
