(() => {
// @ts-check
// Pure Today Lately/Garmin reaction render helpers.
const TODAY_LATELY_ZONE_COLORS = ["#cdd7c0", "#b9c79a", "#e6c87a", "#d98a4e", "#b4552d"];
(() => {
    function latelyRecord(value) {
        return value && typeof value === "object" ? value : {};
    }
    function latelyNum(value) {
        return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
    }
    function latelyZoneColors() {
        return typeof HR_ZONE_COLORS !== "undefined" && Array.isArray(HR_ZONE_COLORS) && HR_ZONE_COLORS.length
            ? HR_ZONE_COLORS
            : TODAY_LATELY_ZONE_COLORS;
    }
    function latelyZoneBar(zonesValue) {
        const zones = (Array.isArray(zonesValue) ? zonesValue : [])
            .map((zone) => latelyRecord(zone))
            .filter((zone) => latelyNum(zone.secs) != null && (latelyNum(zone.secs) ?? 0) > 0)
            .sort((a, b) => (latelyNum(a.zone) || 0) - (latelyNum(b.zone) || 0));
        const total = zones.reduce((sum, zone) => sum + (latelyNum(zone.secs) || 0), 0);
        if (total <= 0)
            return "";
        const colors = latelyZoneColors();
        const segs = zones.map((zone) => {
            const zi = Math.min(5, Math.max(1, latelyNum(zone.zone) || 1));
            const pct = ((latelyNum(zone.secs) || 0) / total) * 100;
            const mins = Math.round((latelyNum(zone.secs) || 0) / 60);
            return `<span class="gz-seg" style="width:${pct.toFixed(1)}%;background:${colors[zi - 1]}" title="Zone ${zi} · ${mins} min"></span>`;
        }).join("");
        return `<div class="gz-bar">${segs}</div><div class="gz-legend lbl">time in HR zones</div>`;
    }
    function garminSessionCard(value) {
        const g = latelyRecord(value);
        if (!Object.keys(g).length)
            return "";
        const tiles = [];
        const tile = (val, lbl) => {
            tiles.push(`<span class="wear-cell"><span class="wear-n numeral">${escHtml(val)}</span><span class="wear-l lbl">${escHtml(lbl)}</span></span>`);
        };
        const dur = latelyNum(g.duration_min);
        if (dur != null)
            tile(`${Math.round(dur * 10) / 10}`, "min");
        const ahr = latelyNum(g.avg_hr);
        if (ahr != null)
            tile(`${Math.round(ahr)}`, "avg hr");
        const mhr = latelyNum(g.max_hr);
        if (mhr != null)
            tile(`${Math.round(mhr)}`, "max hr");
        const kcal = latelyNum(g.calories);
        if (kcal != null)
            tile(`${Math.round(kcal)}`, "kcal");
        const te = latelyNum(g.training_effect);
        if (te != null)
            tile(`${Math.round(te * 10) / 10}`, "effect");
        const bar = latelyZoneBar(g.hr_zones);
        if (!tiles.length && !bar && !g.summary)
            return "";
        const tag = g.extrapolated ? `<span class="garmin-tag">✦ logged from Garmin</span>` : "";
        return `<div class="garmin-card reveal" style="--i:2">
      <div class="garmin-card-h"><span class="lbl">Garmin · body's reaction</span>${tag}</div>
      ${tiles.length ? `<div class="garmin-tiles">${tiles.join("")}</div>` : ""}
      ${bar}
      ${g.summary ? `<div class="garmin-sum">${escHtml(g.summary)}</div>` : ""}
    </div>`;
    }
    function latelyWhen(value) {
        const row = latelyRecord(value);
        if (row.at) {
            const t = Date.parse(String(row.at));
            if (t) {
                const ageH = (Date.now() - t) / 3600000;
                if (ageH >= 0 && ageH < 22)
                    return relTime(String(row.at));
                const clock = new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                    .toLowerCase().replace(/\s/g, "");
                return `${humanDate(String(row.date))} · ${clock}`;
            }
        }
        return humanDate(String(row.date || ""));
    }
    function latelyDetail(value) {
        const d = latelyRecord(value);
        if (!Object.keys(d).length)
            return "";
        const tiles = [];
        const tile = (val, lbl) => {
            tiles.push(`<span class="wear-cell"><span class="wear-n numeral">${escHtml(val)}</span><span class="wear-l lbl">${escHtml(lbl)}</span></span>`);
        };
        const ahr = latelyNum(d.avg_hr);
        if (ahr != null)
            tile(Math.round(ahr), "avg hr");
        const mhr = latelyNum(d.max_hr);
        if (mhr != null)
            tile(Math.round(mhr), "max hr");
        const te = latelyNum(d.training_effect);
        if (te != null)
            tile(Math.round(te * 10) / 10, "effect");
        const vo2 = latelyNum(d.vo2max);
        if (vo2 != null)
            tile(Math.round(vo2), "vo₂max");
        const kcal = latelyNum(d.calories);
        if (kcal != null)
            tile(Math.round(kcal), "kcal");
        const temp = latelyNum(d.avg_temp);
        if (temp != null)
            tile(`${Math.round(temp)}°`, "temp");
        const bar = latelyZoneBar(d.hr_zones);
        if (!tiles.length && !bar)
            return "";
        return `<div class="lately-body">${tiles.length ? `<div class="garmin-tiles">${tiles.join("")}</div>` : ""}${bar}</div>`;
    }
    function latelyMovements(value) {
        if (!Array.isArray(value) || !value.length)
            return "";
        const moves = value.map((move) => latelyRecord(move));
        const rows = moves.map((move) => `<div class="lately-mv">
       <span class="lately-mv-name">${escHtml(move.name)}</span>
       <span class="lately-mv-best numeral">${escHtml(move.best || "")}${Number(move.sets) > 1 ? `<span class="lbl lately-mv-sets"> · ${Number(move.sets)}×</span>` : ""}</span>
     </div>`).join("");
        return `<div class="lately-moves">${rows}</div>`;
    }
    function latelyRow(value) {
        const row = latelyRecord(value);
        const title = String(row.title || "");
        const isStrength = row.kind === "strength";
        const tile = isStrength
            ? artImg("exercise", "", "artile-sm lately-art", art("exercise", title))
            : artImg("activity", actArtText({ id: 0, type: title }), "artile-sm lately-art", art("activity", title));
        const detailHtml = (isStrength ? latelyMovements(row.movements) : "") + (row.detail ? latelyDetail(row.detail) : "");
        const expandable = !!detailHtml;
        return `<div class="lately-row${isStrength ? " lately-strength" : ""}">
      <div class="lately-head"${expandable ? ' role="button" tabindex="0" aria-expanded="false"' : ""}>
        ${tile}
        <div class="lately-main">
          <div class="lately-top">
            <span class="lately-title">${escHtml(title)}</span>
            <span class="lately-when lbl">${escHtml(latelyWhen(row))}</span>
          </div>
          ${row.stats ? `<div class="lately-stats">${escHtml(row.stats)}</div>` : ""}
          ${row.note ? `<div class="lately-note">${escHtml(row.note)}</div>` : ""}
        </div>
        ${expandable ? `<span class="lately-chev" aria-hidden="true">▾</span>` : ""}
      </div>
      ${expandable ? `<div class="lately-detail" hidden>${detailHtml}</div>` : ""}
    </div>`;
    }
    const CAIRN_TODAY_LATELY = {
        garminSessionCard,
        when: latelyWhen,
        detailHtml: latelyDetail,
        movementsHtml: latelyMovements,
        rowHtml: latelyRow,
    };
    Object.assign(globalThis, { CairnTodayLately: CAIRN_TODAY_LATELY });
    if (typeof window !== "undefined") {
        Object.assign(window, { CairnTodayLately: CAIRN_TODAY_LATELY });
    }
})();
})();
