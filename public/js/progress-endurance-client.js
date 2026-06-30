// @ts-check
// Progress endurance helpers shared by the Program read.
function enduranceStatusWord(status) {
    if (status === "building")
        return "Building";
    if (status === "maintaining")
        return "Ticking over";
    if (status === "detraining")
        return "Fading";
    if (status === "spiking")
        return "Load spiked";
    return "";
}
function enduranceBlockHtml(end, idx) {
    if (!end)
        return "";
    const figs = [];
    if (end.last_week_km != null)
        figs.push(`${fmtKm(end.last_week_km)} km last week`);
    if (end.longest_km_4wk != null)
        figs.push(`${fmtKm(end.longest_km_4wk)} km longest · 4wk`);
    const statusWord = enduranceStatusWord(end.status);
    return `<div class="pend reveal" style="${stagger(idx)}">
    <div class="pend-head lbl">Endurance</div>
    ${statusWord ? `<div class="pend-status">${escHtml(statusWord)}</div>` : ""}
    ${figs.length ? `<div class="pend-figs lbl">${escHtml(figs.join(" · "))}</div>` : ""}
    ${end.why ? `<div class="pend-why">${escHtml(end.why)}</div>` : ""}
  </div>`;
}
const CAIRN_PROGRESS_ENDURANCE = {
    enduranceStatusWord,
    enduranceBlockHtml,
};
Object.assign(globalThis, {
    CairnProgressEndurance: CAIRN_PROGRESS_ENDURANCE,
    enduranceStatusWord,
    enduranceBlockHtml,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressEndurance: CAIRN_PROGRESS_ENDURANCE,
        enduranceStatusWord,
        enduranceBlockHtml,
    });
}
