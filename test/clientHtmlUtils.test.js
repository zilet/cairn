import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadHtmlUtils() {
  const context = { String };
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  return context;
}

test("client HTML escaping helpers preserve the established text and attribute contract", () => {
  const utils = loadHtmlUtils();

  assert.equal(utils.escHtml(`<b>AT&T</b> "ok"`), "&lt;b&gt;AT&amp;T&lt;/b&gt; \"ok\"");
  assert.equal(utils.escHtml(null), "");
  assert.equal(utils.escAttr(`<img alt="x">`), "&lt;img alt=&quot;x&quot;&gt;");
});
