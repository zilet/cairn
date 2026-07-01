(() => {
// @ts-check
// Exercise detail data normalization and display model helpers.
function exerciseDetailDataRecord(value) {
    return value && typeof value === "object" ? value : {};
}
function exerciseDetailDataRows(value) {
    return Array.isArray(value) ? value.filter((row) => !!row && typeof row === "object") : [];
}
function exerciseDetailDataNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}
function exerciseDetailView(row, deps) {
    const recent = exerciseDetailDataRows(row.recent);
    const timed = row.mode === "timed" || recent.some((set) => set.duration_sec != null);
    const points = exerciseDetailDataRows(row.progress?.points);
    const latest = points.slice(-1)[0];
    const hasPR = recent.some((set) => set.pr);
    let heroVal = 0;
    let heroLbl = "";
    let heroTxt = "";
    let sparkVals = [];
    if (timed) {
        const durations = recent.filter((set) => set.duration_sec != null).map((set) => exerciseDetailDataNumber(set.duration_sec));
        const best = durations.length ? Math.max(...durations) : 0;
        heroVal = best;
        heroLbl = "best duration";
        heroTxt = deps.fmtDur(best);
        sparkVals = durations.slice().reverse();
    }
    else if (latest) {
        heroVal = exerciseDetailDataNumber(latest.best1rm);
        heroLbl = `est 1RM · ${deps.escapeHtml(row.unit || "lb")} · epley`;
        sparkVals = points.map((point) => point.best1rm);
    }
    const appears = exerciseDetailDataRows(row.appears)
        .map((appearance) => `D${appearance.day_number} ${deps.escapeHtml(appearance.day_name)}`)
        .join(" · ");
    const recentLines = recent.map((set) => {
        const fig = set.duration_sec != null
            ? deps.fmtDur(set.duration_sec)
            : `${deps.fmtWeight(set.weight)}×${deps.escapeHtml(set.reps)}${set.rir != null ? ` @${deps.escapeHtml(set.rir)}` : ""}`;
        return `<div class="detail-setline"><span>${deps.escapeHtml(set.date || "")}</span><span class="numeral">${fig}${set.pr ? ` <span class="prbadge">PR</span>` : ""}</span></div>`;
    }).join("");
    return { timed, heroVal, heroLbl, heroTxt, sparkVals, hasPR, appears, recentLines };
}
const CAIRN_EXERCISE_DETAIL_DATA = {
    number: exerciseDetailDataNumber,
    record: exerciseDetailDataRecord,
    rows: exerciseDetailDataRows,
    view: exerciseDetailView,
};
Object.assign(globalThis, { CairnExerciseDetailData: CAIRN_EXERCISE_DETAIL_DATA });
if (typeof window !== "undefined") {
    window.CairnExerciseDetailData = CAIRN_EXERCISE_DETAIL_DATA;
}
})();
