(() => {
// @ts-check
// Progress Volume balance presentation helpers.
// The canonical taxonomy's first-class volume patterns. Mobility is intentionally
// excluded because it is non-volume-counting and would be a false "missing" signal.
const VOLUME_PATTERN_WORD = { core: "core", forearms: "grip" };
function capWord(input) {
    const value = String(input || "");
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
function volBalanceHtml(balance) {
    if (!balance || !Array.isArray(balance.groups) || !balance.groups.length)
        return "";
    const due = Array.isArray(balance.due) ? balance.due : [];
    const over = Array.isArray(balance.over) ? balance.over : [];
    const trained = new Set(balance.groups.map((group) => String(group.group).toLowerCase()));
    const missing = Object.keys(VOLUME_PATTERN_WORD).filter((pattern) => !trained.has(pattern));
    const chip = (label, cls) => `<span class="vbal-chip ${cls}">${escHtml(label)}</span>`;
    const dueShown = balance.broad_low ? due.slice(0, 4) : due;
    const dueMore = due.length - dueShown.length;
    const dueChips = dueShown.map((group) => chip(capWord(group), "vbal-due")).join("") +
        (dueMore > 0 ? chip(`+${dueMore} more`, "vbal-miss") : "");
    const overChips = over.map((group) => chip(capWord(group), "vbal-high")).join("");
    const missingChips = missing.map((pattern) => chip(VOLUME_PATTERN_WORD[pattern], "vbal-miss")).join("");
    const rows = [];
    if (dueShown.length) {
        rows.push(`<div class="vbal-row"><span class="vbal-lead lbl">Due</span><span class="vbal-chips">${dueChips}</span></div>`);
    }
    if (overChips) {
        rows.push(`<div class="vbal-row"><span class="vbal-lead lbl">Running high</span><span class="vbal-chips">${overChips}</span></div>`);
    }
    if (missingChips) {
        rows.push(`<div class="vbal-row"><span class="vbal-lead lbl">Not programmed</span><span class="vbal-chips">${missingChips}</span></div>`);
    }
    const summary = balance.summary ? `<div class="vbal-summary">${escHtml(balance.summary)}</div>` : "";
    if (!rows.length && !summary)
        return "";
    return `<div class="vbal">
      <div class="vbal-head lbl">Balance</div>
      ${summary}
      ${rows.join("")}
    </div>`;
}
const CAIRN_PROGRESS_VOLUME = {
    capWord,
    volBalanceHtml,
};
Object.assign(globalThis, {
    CairnProgressVolume: CAIRN_PROGRESS_VOLUME,
    capWord,
    volBalanceHtml,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressVolume: CAIRN_PROGRESS_VOLUME,
        capWord,
        volBalanceHtml,
    });
}
})();
