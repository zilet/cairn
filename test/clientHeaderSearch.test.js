// The header's search entry: one 44px icon button on every tab but You, which lands on the
// You home with its search row focused. The hint is one-shot and in memory; a missing row
// just leaves you on You.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

test("the header carries one labelled Search button, a real button", () => {
  const html = read("public/index.html");
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  const buttons = header.match(/<button[^>]*id="hdrSearch"[^>]*>/g) || [];
  assert.equal(buttons.length, 1);
  assert.match(buttons[0], /type="button"/);
  assert.match(buttons[0], /aria-label="Search"/);
});

test("the button is 44px, ringed on focus, token-coloured, and absent on You", () => {
  const css = read("src/styles/shell/nav.css");
  const rule = css.match(/\.hdr-search\{[^}]*\}/)?.[0] || "";
  assert.match(rule, /width:44px/);
  assert.match(rule, /height:44px/);
  assert.match(rule, /env\(safe-area-inset-top\)/);
  assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,6}\b|rgb\(/, "token colours only");
  assert.match(css, /\.hdr-search:focus-visible\{outline:2px solid var\(--dawn\)/);
  assert.match(css, /body:is\(\[data-tab="you"\][^)]*\) \.hdr-search\{display:none\}/);
});

test("the shell routes the tap to You through the hint, never touching the lazy bundle", () => {
  const shell = read("src/client/ui-shell.ts");
  const fn = shell.slice(shell.indexOf("function openHeaderSearch"), shell.indexOf("function gotoChatWith"));
  assert.match(fn, /CairnYouSearchFocus\?\.request\(\)/);
  assert.match(fn, /activateTab\("you"\)/);
  assert.doesNotMatch(fn, /withBundle|CairnRecordsSearch|CairnStandScreen/);
});

function loadYou({ hasRow = true } = {}) {
  const focused = [];
  const row = { focus: (o) => focused.push(o) };
  const context = {
    Object,
    Date,
    String,
    state: { youSeg: null, youStone: null },
    headerTitle: { textContent: "" },
    view: {
      innerHTML: "",
      querySelectorAll: () => [],
      querySelector: (sel) => (sel === ".you-search" && hasRow ? row : null),
    },
    escAttr: String,
    escHtml: String,
    localISO: () => "2026-10-17",
    reducedMotion: () => false,
    CairnStoneDetailModel: { isStone: () => false },
    CairnStackController: { mount: () => () => {} },
    document: { addEventListener() {} },
  };
  context.globalThis = context;
  vm.runInNewContext(read("public/js/you-screen.js"), context);
  return { context, focused };
}

test("a header-search request focuses the You search row once, and only once", () => {
  const { context, focused } = loadYou();
  context.CairnYouSearchFocus.request();
  context.renderYou();
  assert.equal(focused.length, 1);
  context.renderYou(); // a later visit is a plain visit
  assert.equal(focused.length, 1);
});

test("a plain You visit never steals focus, and a missing row still lands on You", () => {
  const plain = loadYou();
  plain.context.renderYou();
  assert.equal(plain.focused.length, 0);
  const missing = loadYou({ hasRow: false });
  missing.context.CairnYouSearchFocus.request();
  missing.context.renderYou();
  assert.equal(missing.context.headerTitle.textContent, "You");
});
