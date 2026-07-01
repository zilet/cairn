(() => {
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
function paceTrendWord(trend) {
    const paceTrend = (trend ?? {});
    if (!paceTrend || paceTrend.dir == null || paceTrend.this_min_per_km == null)
        return "";
    if (paceTrend.dir === "steady")
        return "holding about the same pace as last week";
    if (paceTrend.prev_min_per_km == null)
        return `averaging ${fmtPaceKm(paceTrend.this_min_per_km)}/km`;
    const delta = Math.abs(Number(paceTrend.this_min_per_km) - Number(paceTrend.prev_min_per_km));
    const magnitude = delta < 0.15 ? "a touch" : delta < 0.5 ? "a little" : "noticeably";
    return paceTrend.dir === "faster" ? `${magnitude} faster than last week` : `${magnitude} easier than last week`;
}
function zoneBarHtml(zones) {
    const entries = Object.entries((zones ?? {}))
        .map(([key, seconds]) => ({
        zi: Math.min(5, Math.max(1, Number(String(key).replace(/\D/g, "")) || 1)),
        secs: Number(seconds) || 0,
    }))
        .filter((zone) => zone.secs > 0)
        .sort((a, b) => a.zi - b.zi);
    const total = entries.reduce((sum, zone) => sum + zone.secs, 0);
    if (total <= 0)
        return "";
    const colors = typeof HR_ZONE_COLORS !== "undefined" && HR_ZONE_COLORS
        ? HR_ZONE_COLORS
        : ["#cdd7c0", "#b9c79a", "#e6c87a", "#d98a4e", "#b4552d"];
    const segments = entries.map((zone) => {
        const pct = (zone.secs / total) * 100;
        const minutes = Math.round(zone.secs / 60);
        return `<span class="gz-seg" style="width:${pct.toFixed(1)}%;background:${colors[zone.zi - 1]}" title="Zone ${zone.zi} · ${minutes} min"></span>`;
    }).join("");
    return `<div class="end-zones reveal" style="${stagger(3)}">
      <div class="lbl" style="margin-bottom:6px">Time in heart-rate zones · this week</div>
      <div class="gz-bar">${segments}</div>
      <div class="gz-legend lbl">${entries.map((zone) => `Z${zone.zi} ${Math.round(zone.secs / 60)}m`).join(" · ")}</div>
    </div>`;
}
function enduranceBestRows(group) {
    if (!group)
        return [];
    const sport = group;
    const rows = [];
    if (sport.longest_km) {
        rows.push({
            label: "Longest distance",
            val: `${fmtKm(sport.longest_km.value)} km`,
            date: sport.longest_km.date,
            type: sport.longest_km.type,
        });
    }
    if (sport.longest_min) {
        rows.push({
            label: "Longest duration",
            val: `${Math.round(Number(sport.longest_min.value))} min`,
            date: sport.longest_min.date,
            type: sport.longest_min.type,
        });
    }
    if (sport.paced) {
        for (const bestPace of sport.best_pace || []) {
            rows.push({
                label: `Best ${prDistLabel(bestPace.distance_km)} pace`,
                val: `${fmtPaceKm(bestPace.min_per_km)}/km`,
                date: bestPace.date,
                type: bestPace.type,
            });
        }
    }
    else if (sport.best_speed_kmh) {
        rows.push({
            label: "Best speed",
            val: `${fmtSpeedKmh(sport.best_speed_kmh.value)} km/h`,
            date: sport.best_speed_kmh.date,
            type: sport.best_speed_kmh.type,
        });
    }
    return rows;
}
function enduranceSportCardHtml(group, idx) {
    if (!group)
        return "";
    const sport = group;
    const rows = enduranceBestRows(sport);
    if (!rows.length)
        return "";
    const body = rows.map((row, index) => `
    <div class="end-pr reveal" style="${stagger(idx + index)}">
      <div class="end-pr-id">
        <span class="end-pr-label">${escHtml(row.label)}</span>
        ${row.date ? `<span class="end-pr-when lbl" title="${escAttr(absDate(String(row.date)))}">${escHtml(relAge(String(row.date)))}${row.type ? ` · ${escHtml(row.type)}` : ""}</span>` : ""}
      </div>
      <span class="end-pr-val numeral">${escHtml(row.val)}</span>
    </div>`).join("");
    const head = sport.label ? `<div class="end-pr-sport reveal" style="${stagger(idx)}">${escHtml(sport.label)}</div>` : "";
    return `${head}<div class="end-pr-card">${body}</div>`;
}
const CAIRN_PROGRESS_ENDURANCE = {
    enduranceStatusWord,
    enduranceBlockHtml,
    paceTrendWord,
    zoneBarHtml,
    enduranceBestRows,
    enduranceSportCardHtml,
};
Object.assign(globalThis, {
    CairnProgressEndurance: CAIRN_PROGRESS_ENDURANCE,
    enduranceStatusWord,
    enduranceBlockHtml,
    paceTrendWord,
    zoneBarHtml,
    enduranceBestRows,
    enduranceSportCardHtml,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressEndurance: CAIRN_PROGRESS_ENDURANCE,
        enduranceStatusWord,
        enduranceBlockHtml,
        paceTrendWord,
        zoneBarHtml,
        enduranceBestRows,
        enduranceSportCardHtml,
    });
}
})();
