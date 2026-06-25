import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("hidden save bar is also hidden from assistive tech", () => {
  const ui = readFileSync(new URL("../public/js/02-ui.js", import.meta.url), "utf8");
  assert.match(ui, /bar\.setAttribute\("aria-hidden", "true"\)/, "save bar starts hidden to accessibility");
  assert.match(ui, /bar\.removeAttribute\("aria-hidden"\)/, "dirty save bar becomes available when shown");
});
