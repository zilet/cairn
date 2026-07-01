(() => {
// @ts-check
// Progress Program summary renderers: lift rows, volume rows, mesocycle, and adaptations.
function asProgramLift(lift) {
    return lift ?? null;
}
function liftStatusWord(lift) {
    const row = asProgramLift(lift);
    if (!row)
        return "";
    const status = row.status;
    const weeksStatic = row.weeks_static;
    if (status === "progressing")
        return "climbing";
    if (status === "plateaued") {
        const weeks = Number(weeksStatic);
        const label = weeksStatic != null && Number.isFinite(weeks) && weeks > 0 ? `~${weeksStatic} wk` : null;
        return label ? `stalled ${label}` : "stalled";
    }
    if (status === "regressing")
        return "trending down";
    if (status === "maintaining")
        return "holding";
    if (status === "new")
        return "building baseline";
    return "";
}
function liftTrendFig(lift) {
    const row = asProgramLift(lift);
    if (!row)
        return "";
    const raw = row.trend_per_wk;
    if (raw == null)
        return "";
    const trend = Number(raw);
    if (!Number.isFinite(trend))
        return "";
    if (row.mode === "timed") {
        const seconds = Math.round(Math.abs(trend));
        return seconds === 0 ? "" : `${trend > 0 ? "+" : "−"}${seconds} sec/wk`;
    }
    const pounds = Math.abs(Math.round(trend * 10) / 10);
    return pounds === 0 ? "" : `${trend > 0 ? "+" : "−"}${pounds} lb/wk`;
}
function liftBestFig(lift) {
    const row = asProgramLift(lift);
    if (!row)
        return "";
    if (row.mode === "timed" && row.best_seconds != null)
        return fmtDur(row.best_seconds);
    if (row.est_1rm != null)
        return `${Math.round(Number(row.est_1rm))} lb`;
    return "";
}
function sortLifts(lifts) {
    const rank = (lift) => {
        if (lift.status === "plateaued" || lift.status === "regressing")
            return 0;
        if (lift.status === "progressing")
            return 1;
        return 2;
    };
    return Array.isArray(lifts) ? lifts.slice().sort((a, b) => rank(a) - rank(b)) : [];
}
function volBandWord(band) {
    if (band === "low")
        return "below productive range";
    if (band === "productive")
        return "in the productive zone";
    if (band === "high")
        return "above ideal range";
    return band ? String(band) : "";
}
function volTrendGlyph(trend) {
    if (trend === "rising")
        return " ↑";
    if (trend === "falling")
        return " ↓";
    return "";
}
function phaseWord(phase) {
    if (phase === "accumulation")
        return "Accumulation";
    if (phase === "intensification")
        return "Intensification";
    if (phase === "deload-due")
        return "Deload due";
    if (phase === "deload")
        return "Deload";
    return "";
}
function liftRowHtml(lift, index) {
    const row = asProgramLift(lift);
    if (!row)
        return "";
    const statusWord = liftStatusWord(row);
    const trendFig = liftTrendFig(row);
    const bestFig = liftBestFig(row);
    const isBad = row.status === "plateaued" || row.status === "regressing";
    const isGood = row.status === "progressing";
    const modCls = isBad ? " prow-stalled" : isGood ? " prow-good" : "";
    const figBits = [bestFig, trendFig].filter(Boolean);
    return `<div class="prow reveal${modCls}" style="${stagger(index)}">
    <div class="prow-head">
      <span class="prow-name">${escHtml(row.exercise)}</span>
      <span class="prow-status${isBad ? " prow-status-warn" : isGood ? " prow-status-ok" : ""}">${escHtml(statusWord)}</span>
    </div>
    ${figBits.length ? `<div class="prow-figs lbl">${escHtml(figBits.join(" · "))}</div>` : ""}
    ${row.why ? `<div class="prow-why">${escHtml(row.why)}</div>` : ""}
  </div>`;
}
function volumeBlockHtml(volume, startIdx) {
    if (!Array.isArray(volume) || !volume.length)
        return "";
    const rows = volume.map((value, index) => {
        const row = value;
        const bandWord = volBandWord(row.band);
        const glyph = volTrendGlyph(row.trend);
        const bandCls = row.band === "high" ? " pvol-high" : row.band === "low" ? " pvol-low" : " pvol-ok";
        return `<div class="pvol-row reveal" style="${stagger(startIdx + index)}">
      <span class="pvol-name">${escHtml(row.muscle_group)}</span>
      <span class="pvol-meta lbl"><b>${escHtml(String(row.weekly_sets))}</b> sets/wk<span class="pvol-band${bandCls}">${escHtml(`${glyph} ${bandWord}`)}</span></span>
    </div>`;
    }).join("");
    return `<div class="pvol-card">${rows}</div>`;
}
function mesoBlockHtml(meso, index) {
    if (!meso)
        return "";
    const row = meso;
    const phase = phaseWord(row.phase);
    const bits = [];
    if (phase)
        bits.push(phase);
    if (row.weeks_since_deload != null)
        bits.push(`${row.weeks_since_deload} wk since deload`);
    return `<div class="pmeso reveal" style="${stagger(index)}">
    ${bits.length ? `<div class="pmeso-phase lbl">${escHtml(bits.join(" · "))}</div>` : ""}
    <div class="pmeso-note">${escHtml(row.note || "")}</div>
  </div>`;
}
function adaptationsHtml(adaptations, index) {
    if (!Array.isArray(adaptations) || !adaptations.length)
        return "";
    const items = adaptations.map((adaptation) => `<li class="padapt-item">${escHtml(adaptation)}</li>`).join("");
    return `<div class="padapt reveal" style="${stagger(index)}">
    <div class="padapt-head lbl">What to evolve next</div>
    <ul class="padapt-list">${items}</ul>
  </div>`;
}
const CAIRN_PROGRESS_PROGRAM_SUMMARY = {
    liftStatusWord,
    liftTrendFig,
    liftBestFig,
    sortLifts,
    volBandWord,
    volTrendGlyph,
    phaseWord,
    liftRowHtml,
    volumeBlockHtml,
    mesoBlockHtml,
    adaptationsHtml,
};
Object.assign(globalThis, {
    CairnProgressProgramSummary: CAIRN_PROGRESS_PROGRAM_SUMMARY,
    liftStatusWord,
    liftTrendFig,
    liftBestFig,
    sortLifts,
    volBandWord,
    volTrendGlyph,
    phaseWord,
    liftRowHtml,
    volumeBlockHtml,
    mesoBlockHtml,
    adaptationsHtml,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressProgramSummary: CAIRN_PROGRESS_PROGRAM_SUMMARY,
        liftStatusWord,
        liftTrendFig,
        liftBestFig,
        sortLifts,
        volBandWord,
        volTrendGlyph,
        phaseWord,
        liftRowHtml,
        volumeBlockHtml,
        mesoBlockHtml,
        adaptationsHtml,
    });
}
})();
