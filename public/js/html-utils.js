// @ts-check
// Shared HTML escaping helpers for string-built UI. Keep these tiny and boring:
// callers decide whether a value is text content or an attribute value.

/**
 * @param {unknown} value
 * @returns {string}
 */
function escHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function escAttr(value) {
  return escHtml(value).replace(/"/g, "&quot;");
}
