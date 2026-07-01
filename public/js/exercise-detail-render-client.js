(() => {
// @ts-check
// Exercise detail modal HTML rendering.
function missingExerciseDetailHtml(name, svg, deps) {
    return `
        <div class="detail-art"><div class="detail-art-zoom">${deps.artImg("exercise", name, "artile-xl", svg)}</div></div>
        <h2 class="detail-title">${deps.escapeHtml(name)}</h2>
        <div class="empty">No data for this exercise yet.</div>
        <div class="detail-actions"><button class="pillbtn" data-close>Close</button></div>`;
}
function exerciseDetailModalHtml(row, fallbackName, svg, view, explanationHtml, deps) {
    const displayName = row.name || fallbackName;
    return `
      <div class="detail-art"><div class="detail-art-zoom">${deps.artImg("exercise", displayName, "artile-xl", svg)}</div></div>
      <h2 class="detail-title">${deps.escapeHtml(displayName)}</h2>
      <div class="detail-ctx lbl">${deps.escapeHtml(row.muscle_group || "exercise")}${view.hasPR ? ` <span class="prbadge">PR</span>` : ""}</div>
      ${view.heroVal ? `<div class="detail-kcal"><span class="numeral detail-num" ${view.timed ? "" : `data-cu="${view.heroVal}"`}>${view.timed ? view.heroTxt : "0"}</span><span class="detail-unit lbl">${view.heroLbl}</span></div>` : ""}
      ${view.sparkVals.length > 1 ? `<div class="detail-spark">${deps.sparklineSvg(view.sparkVals)}</div>` : ""}
      ${row.constraint_note ? `<div class="ex-flag">${deps.escapeHtml(row.constraint_note)}</div>` : ""}
      ${explanationHtml}
      ${row.cues ? `<div class="detail-section"><div class="lbl">Form cues</div><div class="detail-body">${deps.escapeHtml(row.cues)}</div></div>` : ""}
      ${view.appears ? `<div class="detail-section"><div class="lbl">In your plan</div><div class="detail-body">${view.appears}</div></div>` : ""}
      <div class="detail-section"><div class="lbl">Recent sets</div>
        ${view.recentLines || `<div class="detail-body" style="color:var(--muted)">None logged yet.</div>`}</div>
      <div class="detail-section detail-manage">
        <div class="lbl">This exercise</div>
        <div class="manage-row">
          <button class="pillbtn pill-sm" id="exType">Make ${view.timed ? "reps-based" : "timed (hold)"}</button>
          <button class="pillbtn pill-sm pill-warn" id="exDelete">Delete</button>
        </div>
      </div>
      <div class="detail-actions">
        <button class="pillbtn" id="askForm">Ask coach</button>
        <button class="pillbtn" data-close>Close</button>
      </div>`;
}
const CAIRN_EXERCISE_DETAIL_RENDER = {
    missingHtml: missingExerciseDetailHtml,
    modalHtml: exerciseDetailModalHtml,
};
Object.assign(globalThis, { CairnExerciseDetailRender: CAIRN_EXERCISE_DETAIL_RENDER });
if (typeof window !== "undefined") {
    window.CairnExerciseDetailRender = CAIRN_EXERCISE_DETAIL_RENDER;
}
})();
