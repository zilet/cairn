// The Body "where you stand" figure: deterministic region derivation (which body
// area glows) + the SVG it produces. The lever glows the waist; a muscle site
// growing while the waist holds glows sage. No scores, escaped aria.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadBodyMetrics() {
  const ctx = {
    console, Date, Math, Number, Object, String, JSON, Array,
    escHtml: (v) => String(v ?? ""),
    escAttr: (v) => String(v ?? "").replaceAll('"', "&quot;"),
    localISO: () => "2026-07-02",
    sparklineSvg: () => "",
    toast: () => {},
    api: () => Promise.resolve({}),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInNewContext(readFileSync(join(root, "public/js/body-metrics-client.js"), "utf8"), ctx);
  return ctx.CairnBodyMetrics;
}

const trends = (dirs) => ({
  window_days: 180,
  sites: Object.entries(dirs).map(([key, direction]) => ({ key, direction })),
  weight: { key: "weight", direction: null },
});

test("deriveFigureRegions maps the central-fat lever to the waist", () => {
  const bm = loadBodyMetrics();
  for (const key of ["whtr", "whr", "bodyfat"]) {
    assert.equal(bm.deriveFigureRegions({ focus: { key } }, undefined).focus, "waist", `${key} → waist`);
  }
  // BMI is whole-body, not a waist region; no lever glow.
  assert.equal(bm.deriveFigureRegions({ focus: { key: "bmi" } }, undefined).focus, null);
  assert.equal(bm.deriveFigureRegions({ focus: null }, undefined).focus, null);
});

test("a muscle site growing while the waist holds glows sage; a rising waist suppresses it", () => {
  const bm = loadBodyMetrics();
  // Recomposition: arms + thighs up, waist down → arms + legs win.
  const recomp = bm.deriveFigureRegions(
    { focus: { key: "whtr" } },
    trends({ waist_in: "down", upper_arm_in: "up", thigh_in: "up" })
  );
  assert.equal(recomp.focus, "waist");
  assert.equal([...recomp.wins].sort().join(","), "arms,legs");

  // Gaining everywhere (waist ALSO up) is not "winning" — no sage.
  const bulk = bm.deriveFigureRegions(
    { focus: null },
    trends({ waist_in: "up", upper_arm_in: "up", thigh_in: "up" })
  );
  assert.equal(bulk.wins.length, 0);

  // Chest/shoulder growth maps to the chest region.
  const upper = bm.deriveFigureRegions({ focus: null }, trends({ shoulder_in: "up" }));
  assert.equal([...upper.wins].join(","), "chest");
});

test("bodyFigureSvg glows the focus terracotta and marks wins, and never leaks a score", () => {
  const bm = loadBodyMetrics();
  const svg = bm.bodyFigureSvg("waist", ["arms"]);
  assert.match(svg, /<svg[^>]*class="bm-figure"/);
  assert.match(svg, /clipPath id="bmfig-clip"/);
  assert.match(svg, /#b4552d/, "focus glow uses the terracotta accent");
  assert.match(svg, /#5a6a4a/, "win chevron uses deep sage");
  assert.match(svg, /aria-label="[^"]*waist[^"]*"/i);
  // Neutral state: base body only, no focus/win colors.
  const neutral = bm.bodyFigureSvg(null, []);
  assert.doesNotMatch(neutral, /#b4552d|#5a6a4a/);
  assert.doesNotMatch(svg, /\b\d{1,3}\s*\/\s*100\b/, "no x/100 grade");
});
