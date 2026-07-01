(() => {
// @ts-check
// Shared DOM motion helpers for the vanilla PWA.
function motionReduced() {
    if (typeof reducedMotion === "function")
        return reducedMotion();
    return typeof window !== "undefined" && "matchMedia" in window && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function motionElement(el) {
    return el instanceof HTMLElement ? el : null;
}
function clearMotionStyles(el) {
    ["height", "overflow", "transition", "opacity", "transform", "margin-bottom", "padding-top", "padding-bottom"].forEach((prop) => {
        el.style.removeProperty(prop);
    });
}
// Smooth in-flow collapse: the element's box eases to zero with a fade, then done()
// fires. Cancellable: expandEl() on the same element reverses from wherever it is.
function collapseEl(input, done) {
    const el = motionElement(input);
    if (!el) {
        if (done)
            done();
        return;
    }
    el._collapsed = true;
    clearTimeout(el._animTimer);
    if (motionReduced()) {
        if (done)
            done();
        return;
    }
    el._h = el.offsetHeight;
    el.style.height = `${el._h}px`;
    el.style.overflow = "hidden";
    void el.offsetHeight;
    el.style.transition =
        "height var(--dur-2) var(--ease),opacity var(--dur-1) ease,margin var(--dur-2) var(--ease),padding var(--dur-2) var(--ease),transform var(--dur-2) var(--ease)";
    el.style.height = "0px";
    el.style.opacity = "0";
    el.style.transform = "scale(.97)";
    el.style.marginBottom = "0px";
    el.style.paddingTop = "0px";
    el.style.paddingBottom = "0px";
    el._animTimer = setTimeout(() => {
        if (el._collapsed && done)
            done();
    }, 380);
}
function expandEl(input) {
    const el = motionElement(input);
    if (!el)
        return;
    clearTimeout(el._animTimer);
    el._collapsed = false;
    if (motionReduced()) {
        clearMotionStyles(el);
        return;
    }
    void el.offsetHeight;
    el.style.height = `${el._h || el.scrollHeight}px`;
    el.style.opacity = "";
    el.style.transform = "";
    el.style.marginBottom = "";
    el.style.paddingTop = "";
    el.style.paddingBottom = "";
    el._animTimer = setTimeout(() => clearMotionStyles(el), 380);
}
const CAIRN_UI_MOTION = {
    collapseEl,
    expandEl,
};
Object.assign(globalThis, {
    CairnUiMotion: CAIRN_UI_MOTION,
    collapseEl,
    expandEl,
});
if (typeof window !== "undefined") {
    Object.assign(window, {
        CairnUiMotion: CAIRN_UI_MOTION,
        collapseEl,
        expandEl,
    });
}
})();
