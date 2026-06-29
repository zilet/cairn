// @ts-check
// Shared HTML escaping helpers for string-built UI. Keep these tiny and boring:
// callers decide whether a value is text content or an attribute value.
function escHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(value) {
    return escHtml(value).replace(/"/g, "&quot;");
}
Object.assign(globalThis, {
    escHtml,
    escAttr,
});
