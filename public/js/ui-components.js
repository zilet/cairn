(() => {
// @ts-check
// Tiny typed UI primitives for the vanilla PWA. Components are pure HTML
// renderers: no fetching, no global state mutation beyond the compatibility export.
function mergeAttrs(defaults, attrs) {
    const row = attrs && typeof attrs === "object" ? attrs : {};
    return { ...defaults, ...row };
}
function uiAttrsHtml(attrs) {
    const row = attrs && typeof attrs === "object" ? attrs : {};
    return Object.entries(row)
        .map(([key, value]) => {
        if (value == null)
            return "";
        const safeKey = /^[a-zA-Z][a-zA-Z0-9_:.:-]*$/.test(key) ? key : "";
        if (!safeKey)
            return "";
        const isAria = safeKey.toLowerCase().startsWith("aria-");
        if (value === false)
            return isAria ? ` ${safeKey}="false"` : "";
        if (value === true)
            return isAria ? ` ${safeKey}="true"` : ` ${safeKey}`;
        return ` ${safeKey}="${escAttr(value)}"`;
    })
        .join("");
}
function actionButtonHtml(action) {
    if (!action || !String(action.label ?? "").trim())
        return "";
    const id = action.id ? ` id="${escAttr(action.id)}"` : "";
    const cls = ` class="${escAttr(action.className || "logbtn")}"`;
    return `<button${id}${cls} type="button"${uiAttrsHtml(action.attrs)}>${escHtml(action.label)}</button>`;
}
function textChipHtml(options) {
    if (!String(options.label ?? "").trim())
        return "";
    const className = options.className || "chip";
    const title = options.title == null || !String(options.title).trim() ? "" : ` title="${escAttr(options.title)}"`;
    return `<span class="${escAttr(className)}"${title}${uiAttrsHtml(options.attrs)}>${escHtml(options.label)}</span>`;
}
function loadingStateHtml(options) {
    const className = options.className || "loadstate";
    const live = options.live === false ? "" : ` aria-live="polite"`;
    return `<div class="${escAttr(className)}" role="status"${live}>
    <span class="aspin aspin-sm" aria-hidden="true"></span>
    <div class="loadstate-label">${escHtml(options.label)}</div>
  </div>`;
}
function segmentedNavHtml(options) {
    const items = Array.isArray(options.items) ? options.items : [];
    const idx = Math.max(0, items.findIndex(([key]) => key === options.active));
    const buttons = items
        .map(([key, label]) => {
        const activeClass = key === options.active ? " active" : "";
        const pressed = key === options.active ? "true" : "false";
        return `<button class="segbtn${activeClass}" type="button" data-seg="${escAttr(key)}" aria-pressed="${pressed}">${escHtml(label)}</button>`;
    })
        .join("");
    return `<div class="segwrap"><div class="seg seg-sliding" role="group" aria-label="Section navigation" style="--segn:${items.length};--segi:${idx}"><span class="seg-thumb" aria-hidden="true"></span>${buttons}</div></div>`;
}
function jobCaptionHtml(options = {}) {
    const tag = options.tag === "div" ? "div" : "span";
    const className = options.className || "job-cap";
    const text = options.text == null ? "" : escHtml(options.text);
    const attrs = mergeAttrs({ role: "status", "aria-live": "polite", "aria-atomic": "true" }, options.attrs);
    return `<${tag} class="${escAttr(className)}"${uiAttrsHtml(attrs)}>${text}</${tag}>`;
}
function sheetChipHtml(options) {
    const label = options.label == null ? "" : String(options.label);
    const value = options.value == null ? "" : String(options.value);
    if (!label.trim() && !value.trim())
        return "";
    const className = options.className || "sheet-chip";
    const valueHtml = value.trim()
        ? `<span class="${escAttr(options.valueClassName || "numeral")}">${escHtml(value)}</span>`
        : "";
    const labelHtml = label.trim()
        ? `<span class="${escAttr(options.labelClassName || "lbl")}">${escHtml(label)}</span>`
        : "";
    return `<span class="${escAttr(className)}"${uiAttrsHtml(options.attrs)}>${valueHtml}${labelHtml}</span>`;
}
function emptyStateHtml(options) {
    const className = options.className || "empty-state reveal";
    const style = options.style ? ` style="${escAttr(options.style)}"` : "";
    const art = options.artHtml
        ? `<div class="artile artile-lg" style="margin:0 auto 14px">${options.artHtml}</div>`
        : "";
    const bodyClass = options.bodyClassName || "hpic-hero-sub";
    const body = options.body ? `<div class="${escAttr(bodyClass)}">${escHtml(options.body)}</div>` : "";
    const action = actionButtonHtml(options.action);
    return `<div class="${escAttr(className)}" role="status" aria-live="polite"${style}>
    ${art}
    <div class="empty-state-line">${escHtml(options.title)}</div>
    ${body}
    ${action}
  </div>`;
}
const CAIRN_UI = {
    attrsHtml: uiAttrsHtml,
    actionButtonHtml,
    textChipHtml,
    loadingStateHtml,
    segmentedNavHtml,
    jobCaptionHtml,
    sheetChipHtml,
    emptyStateHtml,
};
Object.assign(globalThis, { CairnUi: CAIRN_UI });
if (typeof window !== "undefined") {
    window.CairnUi = CAIRN_UI;
}
})();
