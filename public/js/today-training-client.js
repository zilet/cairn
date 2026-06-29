// @ts-check
// Pure Today training/cardio helpers for the vanilla PWA.
const TODAY_RX_ACTION = {
    overload: { word: "next up", cls: "ex-rx-up" },
    hold: { word: "hold", cls: "ex-rx-hold" },
    deload: { word: "ease off", cls: "ex-rx-down" },
    vary: { word: "switch it up", cls: "ex-rx-vary" },
    introduce: { word: "new", cls: "ex-rx-up" },
};
function finiteNumber(value) {
    return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
}
function rxTargetText(rx) {
    const suggested = rx && typeof rx.suggested === "object" && rx.suggested ? rx.suggested : {};
    if (rx?.mode === "timed") {
        const seconds = finiteNumber(suggested.seconds);
        const secs = seconds != null ? fmtDur(Math.round(seconds)) : "time";
        return `${suggested.sets ?? "?"} × ${secs}`;
    }
    const lo = suggested.rep_low;
    const hi = suggested.rep_high;
    const reps = lo != null && hi != null ? (lo === hi ? `${lo}` : `${lo}–${hi}`) : (lo ?? hi ?? "");
    const weight = finiteNumber(suggested.weight);
    let load;
    if (weight == null)
        load = "BW";
    else if (weight < 0)
        load = `${-weight} assist`;
    else
        load = fmtWeight(weight);
    return `${load}${reps ? ` · ${suggested.sets ?? "?"} × ${reps}` : ""}`;
}
function exRxVaryMenuHtml(rx) {
    const opts = Array.isArray(rx?.vary_options)
        ? rx.vary_options.filter((o) => o && typeof o === "object" && o.name)
        : [];
    if (!opts.length)
        return "";
    const chips = opts
        .slice(0, 3)
        .map((opt) => `<span class="ex-rx-opt"${opt.why ? ` title="${escAttr(opt.why)}"` : ""}>${escHtml(opt.name)}</span>`)
        .join("");
    return `<div class="ex-rx-vary-menu"><span class="ex-rx-vary-lbl lbl">rotate one in</span><div class="ex-rx-opts">${chips}</div></div>`;
}
function exRxLineHtml(rx) {
    if (!rx)
        return "";
    const action = rx.action && Object.hasOwn(TODAY_RX_ACTION, rx.action) ? rx.action : "hold";
    const meta = TODAY_RX_ACTION[action];
    const delta = rx.delta_text ? escHtml(rx.delta_text) : "";
    const target = escHtml(rxTargetText(rx));
    return `<div class="ex-rx ${meta.cls}">
      <div class="ex-rx-line">
        <span class="ex-rx-tag lbl">${escHtml(meta.word)}</span>
        <span class="ex-rx-target numeral">${target}</span>
        ${delta ? `<span class="ex-rx-delta">${delta}</span>` : ""}
      </div>
      ${rx.why ? `<div class="ex-rx-why">${escHtml(rx.why)}</div>` : ""}
      ${rx.action === "vary" ? exRxVaryMenuHtml(rx) : ""}
    </div>`;
}
function rxMoveCount(rxByExercise) {
    return Object.values(rxByExercise || {}).filter((rx) => rx && rx.action && rx.action !== "hold").length;
}
function cardioDominantZone(zones) {
    const rows = (Array.isArray(zones) ? zones : [])
        .map((z) => {
        const row = z && typeof z === "object" ? z : {};
        return {
            zi: Math.min(5, Math.max(1, finiteNumber(row.zone) || 0)),
            secs: finiteNumber(row.secs) || 0,
        };
    })
        .filter((z) => z.zi >= 1 && z.secs > 0);
    if (!rows.length)
        return "";
    const total = rows.reduce((t, z) => t + z.secs, 0);
    if (total <= 0)
        return "";
    const top = rows.reduce((a, b) => (b.secs > a.secs ? b : a));
    return top.secs / total >= 0.5 ? `mostly Z${top.zi}` : `Z${top.zi}`;
}
function cardioVerb(label) {
    const l = String(label || "").toLowerCase();
    if (/run|jog|tempo|interval|long/.test(l))
        return "run";
    if (/ride|bike|cycl|spin/.test(l))
        return "ride";
    if (/swim/.test(l))
        return "swim";
    if (/row/.test(l))
        return "row";
    return "effort";
}
function cardioLogPhrase(item) {
    const label = item.label || item.note || item.exercise || "";
    const verb = cardioVerb(label);
    const v = verb === "run" ? "ran" : verb === "ride" ? "rode" : verb === "swim" ? "swam" : verb === "row" ? "rowed" : "did";
    const bits = [];
    if (item.target_distance_km != null)
        bits.push(`${fmtKm(item.target_distance_km)} km`);
    else if (item.target_duration_min != null)
        bits.push(`${Math.round(Number(item.target_duration_min))} min`);
    if (item.target_zone)
        bits.push(`(${item.target_zone})`);
    return `${v} ${bits.join(" ")}`.trim() || `${v} my planned ${verb}`;
}
Object.assign(globalThis, {
    CairnTodayTraining: {
        RX_ACTION: TODAY_RX_ACTION,
        rxTargetText,
        exRxVaryMenuHtml,
        exRxLineHtml,
        rxMoveCount,
        cardioDominantZone,
        cardioVerb,
        cardioLogPhrase,
    },
});
