(() => {
// @ts-check
// Shared Progress view presentation helpers.
function progressShortDate(iso) {
    const [y, m, d] = String(iso || "").split("-").map(Number);
    if (!y || !m || !d)
        return String(iso || "");
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function progressHeroHtml(title, stats) {
    const cells = (stats || [])
        .filter((stat) => !!stat)
        .map(([label, value, opts = {}]) => {
        const fig = opts.text
            ? `<span class="phero-n numeral${String(value).length > 6 ? " phero-n-sm" : ""}">${escHtml(String(value))}</span>`
            : `<span class="phero-n numeral" data-cu="${Number(value) || 0}"${opts.k ? ` data-cufmt="k"` : ""}>0</span>`;
        return `<div class="phero-stat">${fig}<span class="lbl">${escHtml(label)}</span></div>`;
    })
        .join("");
    return `<div class="phero reveal" style="${stagger(0)}">
      <h2 class="phero-title">${escHtml(title)}</h2>
      ${cells ? `<div class="phero-stats">${cells}</div>` : ""}
    </div>`;
}
function progressEmptyStateHtml(svg, line) {
    return `<div class="empty-state reveal" style="${stagger(1)}">
      <div class="artile artile-lg">${svg || art("exercise", "")}</div>
      <div class="empty-state-line">${escHtml(line)}</div>
    </div>`;
}
const CAIRN_PROGRESS_COMPONENTS = {
    fmtShortDate: progressShortDate,
    progressHero: progressHeroHtml,
    emptyStateHtml: progressEmptyStateHtml,
};
Object.assign(globalThis, {
    CairnProgressComponents: CAIRN_PROGRESS_COMPONENTS,
    fmtShortDate: progressShortDate,
    progressHero: progressHeroHtml,
    emptyStateHtml: progressEmptyStateHtml,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnProgressComponents: CAIRN_PROGRESS_COMPONENTS,
        fmtShortDate: progressShortDate,
        progressHero: progressHeroHtml,
        emptyStateHtml: progressEmptyStateHtml,
    });
}
})();
