// The one "reveal the focused field" helper (app/mobile-viewport.ts, CairnFocusReveal):
// its geometry against stubbed rects and a stubbed visualViewport, and its settle watch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDocument, createFakeTimers, createHost, fire, loadClientModule } from "./_dom.mjs";

// Values cross the vm realm: compare them as plain data.
const same = (actual, expected, message) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const FIELD = { left: 20, right: 370 };
const rect = (top, bottom, extra = {}) => ({ ...FIELD, top, bottom, height: bottom - top, width: 350, x: 20, y: top, ...extra });

// A phone: layout viewport 844 tall; the keyboard, when up, leaves 0..vvHeight visible.
function phone({ html, vvHeight = 844, reduced = false, timers = null, scrollY = 0, vv = {} } = {}) {
  const document = createDocument();
  // MutationObserver stand-in: `mutate(el)` delivers an attribute record to live observers.
  const observers = [];
  class FakeMutationObserver {
    constructor(cb) { this.cb = cb; this.live = false; observers.push(this); }
    observe() { this.live = true; }
    disconnect() { this.live = false; }
  }
  const mutate = (el) => observers.filter((o) => o.live).forEach((o) => o.cb([{ target: el, type: "attributes" }]));
  const host = createHost(document, { html });
  const styles = new Map();
  const windowScrolls = [];
  const globals = {
    getComputedStyle: (el) => ({ position: "static", overflowY: "visible", display: "block", visibility: "visible", opacity: "1", top: "auto", bottom: "auto", ...(styles.get(el) || {}) }),
    matchMedia: () => ({ matches: false }),
    reducedMotion: () => reduced,
    innerHeight: 844,
    scrollY,
    visualViewport: { height: vvHeight, offsetTop: 0, scale: 1, addEventListener() {}, ...vv },
    state: { tab: "today" },
    scrollBy: (opts) => windowScrolls.push(opts),
    MutationObserver: FakeMutationObserver,
  };
  if (timers) Object.assign(globals, timers, { requestAnimationFrame: timers.requestAnimationFrame });
  const win = loadClientModule("app-mobile-viewport", { globals, document });
  const at = (selector, r, style) => {
    const el = host.querySelector(selector);
    el.getBoundingClientRect = () => r;
    if (style) styles.set(el, style);
    return el;
  };
  return { win, document, host, at, styles, windowScrolls, mutate, reveal: win.CairnFocusReveal };
}

// ---------- pure geometry ----------

test("a field already comfortably visible never moves", () => {
  const { reveal } = phone();
  assert.equal(reveal.revealDelta(rect(300, 340), { top: 0, bottom: 500 }), 0);
  same(reveal.planReveal(rect(300, 340), { top: 0, bottom: 500 }, [{ top: -Infinity, bottom: Infinity, at: 0, max: Infinity }]), [0]);
});

test("obscured by the keyboard: scrolled up by the overlap plus a breath, no more", () => {
  const { reveal } = phone();
  assert.equal(reveal.revealDelta(rect(600, 640), { top: 0, bottom: 500 }), 152);
  // Above the band (scrolled past): the least move down, landing just under its top.
  assert.equal(reveal.revealDelta(rect(-80, -40), { top: 0, bottom: 500 }), -92);
  // Taller than what is visible: its top leads.
  assert.equal(reveal.revealDelta(rect(40, 640), { top: 0, bottom: 500 }), 28);
});

test("the rest timer and a stuck header shrink the visible band; a header still in the flow does not", () => {
  const { reveal } = phone();
  const viewport = { top: 0, bottom: 500 };
  const restBar = { side: "bottom", pinned: true, rect: rect(440, 500, { left: 0, right: 390 }) };
  const stuckHeader = { side: "top", pinned: true, rect: rect(0, 64, { left: 0, right: 390 }) };
  const inFlowHeader = { side: "top", pinned: false, rect: rect(200, 260, { left: 0, right: 390 }) };
  same(reveal.occludedBand(viewport, [restBar, stuckHeader, inFlowHeader]), { top: 64, bottom: 440 });
  // A misdeclared whole layer: ignored.
  const layer = { side: "bottom", pinned: true, rect: rect(100, 500, { left: 0, right: 390 }) };
  same(reveal.occludedBand(viewport, [layer]), viewport);
});

test("a nested scroller reveals inside its own clip first, and only as far as it can scroll", () => {
  const { reveal } = phone();
  const band = { top: 0, bottom: 500 };
  const inner = { top: 100, bottom: 300, at: 50, max: 400 };
  const page = { top: -Infinity, bottom: Infinity, at: 0, max: Infinity };
  same(reveal.planReveal(rect(350, 380), band, [inner, page]), [92, 0]);
  // The inner scroller is nearly at its end: it does what it can, the page the rest.
  const nearEnd = { ...inner, at: 380 };
  same(reveal.planReveal(rect(350, 380), band, [nearEnd, page]), [20, 0]);
  // A field hidden under the keyboard inside a scroller that is itself partly hidden.
  same(reveal.planReveal(rect(560, 590), { top: 0, bottom: 400 }, [{ top: 100, bottom: 700, at: 0, max: 1000 }, page]), [202, 0]);
});

// ---------- the DOM side ----------

const SESSION = `<div class="ex"><div class="logrow"><input class="in-w"><input class="in-r"><button class="logbtn">Log</button></div></div>
  <div class="rest" data-occludes="bottom"></div>`;

test("the focused set field is revealed above the keyboard AND clear of the rest timer", () => {
  const env = phone({ html: SESSION, vvHeight: 470 });
  env.at(".logrow", rect(400, 446));
  const field = env.at(".in-r", rect(402, 444));
  env.at(".rest", rect(410, 470, { left: 0, right: 390 }), { position: "fixed" });
  const deltas = env.reveal.revealNow(field);
  // Visible band 0..470 minus the bar (410..470) = 0..410: the row's bottom (446) lands 12px above the bar.
  same(deltas, [48]);
  same(env.windowScrolls, [{ top: 48, behavior: "smooth" }]);
});

test("visible, clear of the keyboard and the timer: nothing scrolls", () => {
  const env = phone({ html: SESSION, vvHeight: 470 });
  env.at(".logrow", rect(200, 246));
  const field = env.at(".in-r", rect(202, 244));
  env.at(".rest", rect(410, 470), { position: "fixed" });
  same(env.reveal.revealNow(field), [0]);
  assert.equal(env.windowScrolls.length, 0);
});

// Measured on an iPhone (iOS 27 Safari): with the keyboard up scrollY and the visual
// viewport's offsetTop/pageTop all read 268, and client rects are visual-relative, so the
// visible band starts at 0. Reading offsetTop as the band's top put a field iOS had just
// shown "above" the band and scrolled it back down on every tap: the bounce.
test("iOS: a field iOS already placed above the keyboard is left where it is", () => {
  const env = phone({ html: SESSION, vvHeight: 391, scrollY: 268, vv: { offsetTop: 268, pageTop: 268 } });
  env.at(".logrow", rect(150, 214));
  const field = env.at(".in-w", rect(174, 214));
  same(env.reveal.revealNow(field), [0]);
  assert.equal(env.windowScrolls.length, 0);
});

test("Chrome: a pinch-panned visual viewport still offsets the band by its offsetTop", () => {
  const env = phone({ html: SESSION, vvHeight: 400, scrollY: 500, vv: { offsetTop: 100, pageTop: 600 } });
  env.at(".logrow", rect(40, 86));
  const field = env.at(".in-w", rect(42, 84));
  // Band 100..500: the row (40) sits above it, so it moves down to land 12px under the top.
  same(env.reveal.revealNow(field), [-72]);
});

test("a nested scroll container is scrolled, not the window", () => {
  const html = `<div class="pane"><form><input class="deep"></form></div>`;
  const env = phone({ html, vvHeight: 500 });
  const pane = env.at(".pane", rect(80, 480), { overflowY: "auto" });
  Object.defineProperty(pane, "scrollHeight", { value: 2000 });
  Object.defineProperty(pane, "clientHeight", { value: 400 });
  Object.defineProperty(pane, "clientTop", { value: 0 });
  pane.scrollTop = 100;
  const scrolled = [];
  pane.scrollBy = (opts) => scrolled.push(opts);
  const field = env.at(".deep", rect(600, 640));
  same(env.reveal.revealNow(field), [172, 0]);
  same(scrolled, [{ top: 172, behavior: "smooth" }]);
  assert.equal(env.windowScrolls.length, 0, "the page itself stays put");
});

test("a field inside a fixed layer never scrolls the page, and occluders outside the layer do not count", () => {
  const html = `<div class="sheet"><textarea class="note"></textarea></div><nav class="tabbar" data-occludes="bottom"></nav>`;
  const env = phone({ html, vvHeight: 844 });
  env.at(".sheet", rect(300, 844), { position: "fixed" });
  env.at(".tabbar", rect(780, 844), { position: "fixed" });
  const field = env.at(".note", rect(760, 820));
  same(env.reveal.revealNow(field), []);
  assert.equal(env.windowScrolls.length, 0);
});

test("reduced motion: the same minimal scroll, without the animation", () => {
  const env = phone({ html: SESSION, vvHeight: 470, reduced: true });
  env.at(".logrow", rect(500, 546));
  const field = env.at(".in-r", rect(502, 544));
  env.at(".rest", rect(900, 960), { position: "fixed" }); // hidden below the screen
  env.reveal.revealNow(field);
  same(env.windowScrolls, [{ top: 88, behavior: "auto" }]);
});

test("a whole <form> is never the reveal box: the field itself leads", () => {
  const html = `<form class="settings"><input class="a"><input class="b"></form>`;
  const env = phone({ html, vvHeight: 400 });
  env.at(".settings", rect(-600, 900));
  const field = env.at(".b", rect(420, 460));
  same(env.reveal.revealNow(field), [72]);
});

// ---------- the settle watch ----------

test("focus reveals once the viewport has settled, and again when the rest timer slides in over the field", () => {
  const timers = createFakeTimers();
  const env = phone({ html: SESSION, vvHeight: 844, timers });
  env.win.installMobileViewportGuards();
  env.at(".logrow", rect(600, 646));
  const field = env.at(".in-r", rect(602, 644));
  const bar = env.at(".rest", rect(900, 960), { position: "fixed" });

  field.focus();
  timers.tick(100);
  assert.equal(env.windowScrolls.length, 0, "nothing moves before things are quiet");
  timers.tick(60);
  assert.equal(env.windowScrolls.length, 0, "already visible on focus: nothing moves");

  // A set is logged: the bar (data-occludes, fixed) gains .show and lands over the row.
  bar.classList.add("show");
  bar.getBoundingClientRect = () => rect(590, 650, { left: 0, right: 390 });
  env.mutate(bar);
  timers.tick(200);
  same(env.windowScrolls, [{ top: 68, behavior: "smooth" }], "re-revealed 12px above the timer");
});

test("once the athlete scrolls by hand, an occluder change no longer pulls them back", () => {
  const timers = createFakeTimers();
  const env = phone({ html: SESSION, vvHeight: 844, timers });
  env.win.installMobileViewportGuards();
  env.at(".logrow", rect(600, 646));
  const field = env.at(".in-r", rect(602, 644));
  const bar = env.at(".rest", rect(900, 960), { position: "fixed" });
  field.focus();
  timers.tick(1000);
  fire(env.document, "touchstart", { touches: [{ clientY: 500 }] });
  bar.getBoundingClientRect = () => rect(590, 650, { left: 0, right: 390 });
  env.mutate(bar);
  timers.tick(1000);
  assert.equal(env.windowScrolls.length, 0, "the athlete's hand wins");
  // A new focus reveals again.
  field.blur?.();
  field.focus();
  timers.tick(1000);
  same(env.windowScrolls, [{ top: 68, behavior: "smooth" }]);
});

// ---------- the rest bar while typing ----------

test("typing a set with the keyboard up, the rest bar steps away visually and nothing reflows", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/styles/session/exercise.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = css.match(/html\.kb-up \.rest\.show\{([^}]*)\}/);
  assert.ok(rule, "html.kb-up hides the shown bar");
  assert.match(rule[1], /opacity:0/);
  assert.match(rule[1], /visibility:hidden/, "its buttons leave the tab order and the reveal stops counting it");
  assert.match(rule[1], /pointer-events:none/);
  assert.doesNotMatch(rule[1], /display:none|bottom:|height:/, "a fade, never a layout change");
  assert.doesNotMatch(css, /html\.kb-up[^{]*body\.resting|html\.kb-up[^{]*\.resting\b/, "the page keeps its clearance: the focused row never moves");
  // The built stylesheet carries it.
  const built = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(built, /html\.kb-up \.rest\.show\{opacity:0/);
});

test("a hidden occluder (the rest bar faded out while typing) is not subtracted", () => {
  const env = phone({ html: SESSION, vvHeight: 470 });
  env.at(".logrow", rect(400, 446));
  const field = env.at(".in-r", rect(402, 444));
  env.at(".rest", rect(410, 470, { left: 0, right: 390 }), { position: "fixed", visibility: "hidden", opacity: "0" });
  assert.deepEqual(env.reveal.revealNow(field).length, 1);
  same(env.windowScrolls, []);
});
