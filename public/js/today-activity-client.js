// @ts-check
// Shared activity-row rendering for Today, capture, and Health history.
// Bare activity types make ambiguous image prompts ("ride" can mean horseback),
// so generated photos get explicit phrases while the SVG fallback keeps the raw type.
const ACT_ART_PHRASE = {
    ride: "riding a road bicycle",
    bike: "riding a road bicycle",
    cycl: "riding a road bicycle",
    run: "running",
    jog: "jogging",
    hike: "hiking with a backpack",
    walk: "walking briskly",
    swim: "swimming freestyle",
    row: "rowing on a rowing machine",
    yoga: "holding a yoga pose",
    climb: "climbing an indoor wall",
    ski: "cross-country skiing",
};
function actArtText(activity) {
    const type = String(activity.type || "").toLowerCase();
    for (const key in ACT_ART_PHRASE)
        if (type.includes(key))
            return ACT_ART_PHRASE[key];
    return String(activity.type || activity.raw_text || "");
}
function actEntryHtml(activity) {
    const tile = artImg("activity", actArtText(activity), "artile-sm qlent-art", art("activity", String(activity.type || "")));
    return `<div class="qlent" data-actid="${escAttr(activity.id)}">
      ${tile}
      <div class="qlent-line">${escHtml(activityLine(activity))}</div>
      <div class="qlent-badge">${enrichBadge(activity.enrichment_status)}</div>
    </div>`;
}
function updateActEntry(el, row) {
    const line = el.querySelector(".qlent-line");
    if (line)
        line.textContent = activityLine(row);
    const badge = el.querySelector(".qlent-badge");
    if (badge)
        badge.innerHTML = enrichBadge(row.enrichment_status);
    const tileEl = el.querySelector(".qlent-art");
    if (tileEl) {
        const tile = artImg("activity", actArtText(row), "artile-sm qlent-art", art("activity", String(row.type || "")));
        if (tile)
            tileEl.outerHTML = tile;
    }
    if (row.enrichment_status === "done")
        el.classList.add("qlent-done");
}
const CAIRN_TODAY_ACTIVITY = {
    ACT_ART_PHRASE,
    actArtText,
    actEntryHtml,
    updateActEntry,
};
Object.assign(globalThis, {
    CairnTodayActivity: CAIRN_TODAY_ACTIVITY,
    ACT_ART_PHRASE,
    actArtText,
    actEntryHtml,
    updateActEntry,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnTodayActivity: CAIRN_TODAY_ACTIVITY,
        ACT_ART_PHRASE,
        actArtText,
        actEntryHtml,
        updateActEntry,
    });
}
