import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("hidden save bar is also hidden from assistive tech", () => {
  const saveBar = readFileSync(new URL("../public/js/save-bar.js", import.meta.url), "utf8");
  assert.match(saveBar, /bar\.setAttribute\("aria-hidden", "true"\)/, "save bar starts hidden to accessibility");
  assert.match(saveBar, /bar\.removeAttribute\("aria-hidden"\)/, "dirty save bar becomes available when shown");
});
