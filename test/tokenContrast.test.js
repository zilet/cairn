// Every text token clears WCAG AA (4.5:1) on every neutral it can sit on, in both
// themes, computed from src/styles/foundation/tokens.css itself (docs/DESIGN.md
// "Accessibility minimums"). A palette nudge that drops a pair under AA fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles/foundation/tokens.css", import.meta.url), "utf8");

function block(open) {
  const start = css.indexOf(open);
  assert.ok(start >= 0, `tokens.css has ${open}`);
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
  }
  throw new Error(`unclosed ${open}`);
}

function declarations(body) {
  const out = {};
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = declarations(block(":root{"));
const darkForced = declarations(block(':root[data-theme="dark"]{'));
const darkSystem = declarations(block(':root:not([data-theme="light"]){'));
const dark = { ...light, ...darkForced };

function hex(value) {
  const h = value.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
}

/** A token's colour as [r,g,b], following var() and srgb color-mix(). */
function resolve(tokens, value, depth = 0) {
  assert.ok(depth < 10, `token cycle at ${value}`);
  const v = value.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return resolve(tokens, tokens[ref[1]], depth + 1);
  if (/^#[0-9a-f]{3,6}$/i.test(v)) return hex(v);
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+(\d+(?:\.\d+)?)%,\s*(.+)\)$/.exec(v);
  if (mix) {
    const p = Number(mix[2]) / 100;
    const a = resolve(tokens, mix[1], depth + 1);
    const b = resolve(tokens, mix[3], depth + 1);
    return a.map((c, i) => Math.round(c * p + b[i] * (1 - p)));
  }
  throw new Error(`cannot resolve ${v}`);
}

function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(tokens, fg, bg) {
  const a = luminance(resolve(tokens, `var(${fg})`));
  const b = luminance(resolve(tokens, `var(${bg})`));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const THEMES = { light, dark };
const NEUTRALS = ["--ground", "--surface", "--surface2", "--well"];
const TEXT = [
  "--ink",
  "--ink2",
  "--muted",
  "--dawn",
  "--dawn-deep",
  "--dawn-ink",
  "--sage-text",
  "--gold-deep",
  "--d-strength",
  "--d-endurance",
  "--d-recovery",
  "--d-fuel",
  "--d-body",
  "--d-heart",
];

test("the two dark blocks are identical", () => {
  assert.deepEqual(darkSystem, darkForced);
});

test("every text token clears AA on every neutral, in both themes", () => {
  const misses = [];
  for (const [theme, tokens] of Object.entries(THEMES)) {
    for (const fg of TEXT) {
      for (const bg of NEUTRALS) {
        const r = ratio(tokens, fg, bg);
        if (r < 4.5) misses.push(`${theme} ${fg} on ${bg}: ${r.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(misses, []);
});

function washRgb(tokens) {
  const base = resolve(tokens, "var(--ground)");
  const wash = tokens["--dawn-wash"];
  const m = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(wash);
  assert.ok(m, `dawn wash parses: ${wash}`);
  const alpha = Number(m[4]);
  const ink = [Number(m[1]), Number(m[2]), Number(m[3])];
  return base.map((c, i) => Math.round(c * (1 - alpha) + ink[i] * alpha));
}

test("today's weekday ink clears AA on the dawn wash", () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    const fg = luminance(resolve(tokens, "var(--dawn-ink)"));
    const bg = luminance(washRgb(tokens));
    const r = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    assert.ok(r >= 4.5, `${theme} --dawn-ink on the dawn wash: ${r.toFixed(2)}`);
  }
});

test("text on an accent fill clears AA in both themes", () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    for (const fill of ["--dawn", "--dawn-deep"]) {
      const r = ratio(tokens, "--on-accent", fill);
      assert.ok(r >= 4.5, `${theme} --on-accent on ${fill}: ${r.toFixed(2)}`);
    }
  }
});

// prefers-contrast: more firms --line (and so --well, which mixes it) in a11y.css;
// the text it lifts must still clear AA on the firmer neutrals, and the two dark
// high-contrast blocks must agree.
test("high-contrast overrides keep text tokens at AA on every neutral", () => {
  const a11y = readFileSync(new URL("../src/styles/foundation/a11y.css", import.meta.url), "utf8");
  const hcStart = a11y.indexOf("@media (prefers-contrast: more){");
  assert.ok(hcStart >= 0, "a11y.css has the prefers-contrast block");
  const hc = a11y.slice(hcStart);
  const grab = (open) => {
    const at = hc.indexOf(open);
    assert.ok(at >= 0, `a11y.css has ${open}`);
    return declarations(hc.slice(hc.indexOf("{", at) + 1, hc.indexOf("}", at)));
  };
  const hcLight = grab(":root{");
  const hcDarkForced = grab(':root[data-theme="dark"]{');
  const hcDarkSystem = grab(':root:not([data-theme="light"]){');
  assert.deepEqual(hcDarkSystem, hcDarkForced);
  const themes = { light: { ...light, ...hcLight }, dark: { ...dark, ...hcDarkForced } };
  const misses = [];
  for (const [theme, tokens] of Object.entries(themes)) {
    for (const fg of ["--ink", "--ink2", "--muted"]) {
      for (const bg of NEUTRALS) {
        const r = ratio(tokens, fg, bg);
        if (r < 4.5) misses.push(`high-contrast ${theme} ${fg} on ${bg}: ${r.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(misses, []);
});
