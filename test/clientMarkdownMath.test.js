import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadMarkdown() {
  const context = { Object, RegExp, String };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/markdown-client.js"), "utf8"), context);
  return context.CairnMarkdown;
}

const md = loadMarkdown();
const math = (inner) => `<span class="md-math">${inner}</span>`;

test("the real Katch-McArdle and Cunningham sentences read as typeset text", () => {
  const html = md.mdToHtml(
    "Katch-McArdle (standard DEXA lean-mass equation: $370 + 21.6 \\times \\text{FFM}_{\\text{kg}}$)\n" +
      "Cunningham Equation (athletic/lifting-adjusted: $500 + 22 \\times \\text{FFM}_{\\text{kg}}$)",
  );
  assert.equal(
    html,
    `<p>Katch-McArdle (standard DEXA lean-mass equation: ${math("370 + 21.6 × FFM<sub>kg</sub>")})<br>` +
      `Cunningham Equation (athletic/lifting-adjusted: ${math("500 + 22 × FFM<sub>kg</sub>")})</p>`,
  );
});

test("money is never eaten as math", () => {
  for (const text of ["$5 and $10", "costs $370 + $20", "$1,546", "It is $5 or $10 each", "pay $5_a and $6"]) {
    const html = md.mdToHtml(text);
    assert.doesNotMatch(html, /md-math/, text);
  }
  assert.equal(md.mdToHtml("$5 and $10"), "<p>$5 and $10</p>");
  assert.equal(md.mdToHtml("costs $370 + $20"), "<p>costs $370 + $20</p>");
  assert.equal(md.mdToHtml("$1,546"), "<p>$1,546</p>");
});

test("TeX subset converts to Unicode and sub/sup", () => {
  const cases = [
    ["$a \\cdot b \\div c \\pm d$", "a · b ÷ c ± d"],
    ["$x \\approx y \\sim z \\le 1 \\leq 2 \\ge 3 \\geq 4 \\ne 5 \\neq 6$", "x ≈ y ~ z ≤ 1 ≤ 2 ≥ 3 ≥ 4 ≠ 5 ≠ 6"],
    ["$a \\rightarrow b \\to c$", "a → b → c"],
    ["\\(50\\% \\text{of} \\$5\\)", "50% of $5"],
    ["$a\\,b\\;c\\ d\\quad e$", "a b c d  e"],
    ["$\\alpha + \\beta + \\Delta + \\mu$", "α + β + Δ + μ"],
    ["$\\mathbf{x}^2 + \\mathrm{y}_i$", "x<sup>2</sup> + y<sub>i</sub>"],
    ["$\\frac{a}{b}$", "a/b"],
    ["$\\frac{a+b}{c d}$", "(a+b)/(c d)"],
    ["$\\sqrt{x}$", "√(x)"],
    ["$\\left( x^{2n} \\right)$", "( x<sup>2n</sup> )"],
    ["$\\foo{x} + {y}_1$", "foox + y<sub>1</sub>"],
  ];
  for (const [src, want] of cases) assert.equal(md.mdToHtml(src), `<p>${math(want)}</p>`, src);
});

test("math inside a list item and a table cell", () => {
  const li = md.mdToHtml("- bmr $a_b$ here");
  assert.equal(li, `<ul><li>bmr ${math("a<sub>b</sub>")} here</li></ul>`);
  const table = md.mdToHtml("| Eq | Val |\n| --- | --- |\n| $x^2$ | 5 |");
  assert.match(table, new RegExp(`<td>${math("x<sup>2</sup>").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</td>`));
});

test("math is not re-processed as emphasis", () => {
  const html = md.mdToHtml("$a_b * c_d$ and *real* and _real too_");
  assert.equal(html, `<p>${math("a<sub>b</sub> * c<sub>d</sub>")} and <em>real</em> and <em>real too</em></p>`);
  assert.doesNotMatch(md.mdToHtml("$x_1 + y_2$"), /<em>/);
});

test("code spans and fences are left alone", () => {
  assert.equal(md.mdToHtml("use `$a_b$` here"), "<p>use <code>$a_b$</code> here</p>");
  assert.equal(md.mdToHtml("`$x^2$` and $y^2$"), `<p><code>$x^2$</code> and ${math("y<sup>2</sup>")}</p>`);
  const fenced = md.mdToHtml("```\n$$\nx^2\n$$\n```");
  assert.equal(fenced, "<pre><code>$$\nx^2\n$$</code></pre>");
});

test("display math is its own block", () => {
  const one = md.mdToHtml("before\n\n$$ E = mc^2 $$\n\nafter");
  assert.equal(one, '<p>before</p><div class="md-math md-math-block">E = mc<sup>2</sup></div><p>after</p>');
  const multi = md.mdToHtml("$$\n\\frac{a}{b}\n\\times 2\n$$");
  assert.equal(multi, '<div class="md-math md-math-block">a/b \\times 2</div>'.replace("\\times", "×"));
  assert.equal(md.mdToHtml("\\[ x \\approx 3 \\]"), '<div class="md-math md-math-block">x ≈ 3</div>');
});

test("an unclosed delimiter renders literally and swallows nothing", () => {
  assert.equal(md.mdToHtml("so $370 + 21.6 \\times \\text{FFM"), "<p>so $370 + 21.6 \\times \\text{FFM</p>");
  assert.equal(md.mdToHtml("$$\nx^2 and **bold**"), "<p>$$<br>x^2 and <strong>bold</strong></p>");
  assert.equal(md.mdToHtml("a \\(x_1 and *em*"), "<p>a \\(x_1 and <em>em</em></p>");
});

test("math content stays escaped", () => {
  const html = md.mdToHtml("$\\text{<img src=x onerror=1>}_{a}$");
  assert.doesNotMatch(html, /<img/);
  assert.equal(html, `<p>${math("&lt;img src=x onerror=1&gt;<sub>a</sub>")}</p>`);
  const sub = md.mdToHtml("$x_{<script>alert(1)</script>}$");
  assert.doesNotMatch(sub, /<script/);
});

test("other common chat markdown renders", () => {
  assert.equal(md.mdToHtml("~~old~~ new"), "<p><del>old</del> new</p>");
  assert.equal(md.mdToHtml("***both***"), "<p><strong><em>both</em></strong></p>");
  assert.equal(md.mdToHtml("**3 * 4 = 12**"), "<p><strong>3 * 4 = 12</strong></p>");
  assert.equal(md.mdToHtml("**a** and *b*"), "<p><strong>a</strong> and <em>b</em></p>");
});

test("nested and continued list items", () => {
  assert.equal(
    md.mdToHtml("- one\n  - inner a\n  - inner b\n- two"),
    "<ul><li>one<ul><li>inner a</li><li>inner b</li></ul></li><li>two</li></ul>",
  );
  assert.equal(md.mdToHtml("1. step\n   still step\n2. next"), "<ol><li>step<br>still step</li><li>next</li></ol>");
  assert.equal(md.mdToHtml("- a\n  1. x\n  2. y"), "<ul><li>a<ol><li>x</li><li>y</li></ol></li></ul>");
  assert.equal(md.mdToHtml("- a\n1. b"), "<ul><li>a</li></ul><ol><li>b</li></ol>");
  assert.equal(md.mdToHtml("- a\nplain"), "<ul><li>a</li></ul><p>plain</p>");
});

test("a held code or math span never lands inside an attribute", () => {
  for (const src of [
    '![a](https://e.com/`x" onerror="alert(1)`)',
    '![`x" onerror="alert(1)`](https://e.com/i.png)',
    '[a](https://e.com/`x" onmouseover="alert(1)`)',
    "[see](https://e.com/$a_b$)",
  ]) {
    const html = md.mdToHtml(src);
    assert.doesNotMatch(html, /<(img|a)\b[^>]*\bon\w+=/, src);
    assert.doesNotMatch(html, /(src|href|alt)="[^"]*</, src);
  }
  assert.equal(
    md.mdToHtml("[`code` link](https://e.com/x)"),
    '<p><a href="https://e.com/x" target="_blank" rel="noopener noreferrer"><code>code</code> link</a></p>',
  );
});

test("shell variables and stray dollars are not math, and long unclosed input stays fast", () => {
  assert.equal(md.mdToHtml("run $HOME_DIR/$USER now"), "<p>run $HOME_DIR/$USER now</p>");
  assert.equal(md.mdToHtml("$$\nplain words\nmore words\n$$"), "<p>$$<br>plain words<br>more words<br>$$</p>");
  const started = Date.now();
  md.mdToHtml("\\(".repeat(20000));
  assert.ok(Date.now() - started < 400);
  assert.match(md.mdToHtml("$`a`\\alpha$"), /<code>a<\/code>α/);
});
