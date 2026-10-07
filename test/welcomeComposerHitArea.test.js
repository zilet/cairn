import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Every .qlmic carries a 44px tap target as an absolutely positioned ::before sized to
// 100% of its containing block (foundation/a11y.css). A mic that is not itself
// positioned hands that overlay the nearest positioned ancestor instead — on the
// welcome composer that was the whole form, so every tap on the text box hit the mic.
test("the welcome mic is its own containing block, so its tap target stays on the mic", () => {
  const css = fs.readFileSync(new URL("../src/styles/welcome/welcome.css", import.meta.url), "utf8");
  const rule = css.match(/\.wel-mic\{([^}]*)\}/);
  assert.ok(rule, "the .wel-mic rule exists");
  assert.match(rule[1], /position:(relative|absolute)/);
});
