import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appStartup = readFileSync(path.join(root, "public/js/app-startup.js"), "utf8");
const mobileViewport = readFileSync(path.join(root, "public/js/app-mobile-viewport.js"), "utf8");
const styles = readFileSync(path.join(root, "public/styles.css"), "utf8");

// A tiny scroller that clamps scrollTop like a real element and fires "scroll".
function makeLog({ scrollHeight, clientHeight, scrollTop }) {
  const handlers = {};
  return {
    scrollHeight,
    clientHeight,
    _scrollTop: scrollTop,
    get scrollTop() { return this._scrollTop; },
    set scrollTop(v) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      this._scrollTop = Math.min(Math.max(0, v), max);
      for (const fn of handlers.scroll || []) fn();
    },
    addEventListener(type, fn) { (handlers[type] ||= []).push(fn); },
    scrollTo() {},
  };
}

// Run the generated chat-layout module in a fake mobile DOM so we can exercise
// measureChatTop's keyboard re-pin against a real (clamping) scroll model.
function loadChatLayout(log) {
  const source = readFileSync(path.join(root, "public/js/chat-layout-client.js"), "utf8");
  const style = new Map();
  const bodyClasses = new Set();
  const nodes = {
    ".chatview": { style: { height: "" } },
    header: { getBoundingClientRect: () => ({ height: 60, bottom: 60 }) },
    ".tabbar": { getBoundingClientRect: () => ({ height: 64 }) },
    "#chatlog": log,
  };
  const document = {
    querySelector: (sel) => nodes[sel] ?? null,
    body: { classList: { contains: (n) => bodyClasses.has(n) } },
    documentElement: { style: { setProperty: (k, v) => style.set(k, v) } },
  };
  const window = { innerHeight: 800, visualViewport: { height: 540, offsetTop: 0 } };
  const context = {
    document,
    window,
    matchMedia: () => ({ matches: false }), // force the mobile branch
    reducedMotion: () => false,
    Math,
    globalThis: null,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "chat-layout-client.js" });
  return { api: context.CairnChatLayout, bodyClasses };
}

test("mobile chat keyboard state is geometry-led with a short focus/tap intent bridge", () => {
  assert.match(appStartup, /installMobileViewportGuards\(\)/);
  assert.match(mobileViewport, /let\s+keyboardIntentUntil\s*=\s*0/);
  assert.match(mobileViewport, /const\s+keyboardGeometryOpen\s*=\s*\(\)\s*=>/);
  assert.match(mobileViewport, /vvMax\s*-\s*vv\.height/);
  assert.match(mobileViewport, /Date\.now\(\)\s*<\s*keyboardIntentUntil/);
  assert.match(mobileViewport, /document\.addEventListener\("pointerdown"/);
  assert.match(mobileViewport, /document\.addEventListener\("focusin"/);
});

test("mobile chat never blurs the composer by heuristic (refocus-only recovery)", () => {
  // iOS can dismiss the keyboard without blurring the textarea; a stale geometry
  // read used to blur the composer, dropping a keyboard that was actually up. The
  // guard must never blur — recovery is refocus-only on the next real tap.
  assert.doesNotMatch(mobileViewport, /\.blur\(\)/);
  assert.doesNotMatch(mobileViewport, /releaseStaleChatFocus/);
});

test("mobile chat re-baselines vvMax on resume only when the keyboard is down", () => {
  // Resume can leave the vvMax ratchet stale. Reseed to the current height — but
  // only when no text input is focused, so the tall baseline the PWA needs to keep
  // detecting an on-screen keyboard is never shrunk out from under an open keyboard.
  assert.match(mobileViewport, /const\s+reseedAndResync\s*=\s*\(\)\s*=>\s*\{\s*if\s*\(!focusedTextInput\(\)\)\s*vvMax\s*=\s*vv\.height/);
  assert.match(mobileViewport, /addEventListener\("pageshow",\s*reseedAndResync\)/);
});

test("mobile chat taps after native image pickers get a picker-suppress window", () => {
  assert.match(mobileViewport, /let\s+nativePickerFocusSuppressUntil\s*=\s*0/);
  assert.match(mobileViewport, /const\s+isChatTextInput\s*=/);
  assert.match(mobileViewport, /Date\.now\(\)\s*<\s*nativePickerFocusSuppressUntil/);
  assert.match(mobileViewport, /keyboardIntentUntil\s*=\s*Date\.now\(\)\s*\+\s*\(isChatTarget\s*\?\s*1500\s*:\s*900\)/);
  assert.match(mobileViewport, /nativePickerSuppressMs/);
  assert.match(mobileViewport, /Math\.min\(nativePickerSuppressMs,\s*1800\)/);
});

test("mobile bottom inset never publishes a negative safe-area correction", () => {
  assert.match(mobileViewport, /const\s+rawVvb\s*=\s*window\.innerHeight\s*-\s*\(vv\.offsetTop\s*\+\s*vv\.height\)/);
  // --vvb is the browser-toolbar correction, floored at 0 and NOT forced to 0 under
  // the keyboard (so a toast/rest-bar floats above it rather than snapping behind it).
  assert.match(mobileViewport, /Math\.round\(Math\.max\(0,\s*rawVvb\)\)/);
  assert.doesNotMatch(mobileViewport, /kbOpen\s*\?\s*0\s*:/);
  assert.match(mobileViewport, /"cairn:keyboard-settle"/);
  assert.match(mobileViewport, /keyboardIntentUntil\s*=\s*0/);
});

test("mobile chat lifts the composer onto the keyboard top on real geometry, not intent", () => {
  // STRUCTURAL layout (tab bar slide, chat lift) is gated on real keyboard geometry —
  // an intent tap that summons no keyboard must not bounce the bar.
  assert.match(styles, /body\.chat-mode \.chatview[\s\S]*position:fixed/);
  // A standalone iOS PWA shrinks only the VISUAL viewport, so a plain bottom:0 sits
  // BEHIND the keyboard; lift the column by the keyboard-occluded height (--vvb) so the
  // composer docks ON the keyboard top, and drop the ease so it tracks frame-for-frame.
  assert.match(styles, /body\.chat-mode\.kb-geometry-open \.chatview\{bottom:var\(--vvb,0px\);transition:none\}/);
  assert.doesNotMatch(styles, /body\.chat-mode\.kb-geometry-open \.chatview\{bottom:0\}/);
  assert.match(styles, /body\.chat-mode\.kb-geometry-open \.tabbar\{transform:translateY\(110%\);pointer-events:none\}/);
  // the keyboard-CLOSE return is still transition-matched to the 220ms tab-bar slide
  assert.match(styles, /body\.chat-mode \.chatview\{[\s\S]*transition:bottom \.22s ease/);
});

test("keyboard re-pin keeps the newest turn in view for a reader at the bottom", () => {
  // Reader parked on the newest message (off = 0), so wireJump marks near-bottom.
  const log = makeLog({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
  const { api, bodyClasses } = loadChatLayout(log);
  api.wireJump(log, { hidden: false, addEventListener() {} });
  // Keyboard opens: the CSS lift shrinks the log, and the browser keeps scrollTop —
  // so the newest turn is now ~100px below the fold (off = 1000 - 600 - 300).
  log.clientHeight = 300;
  bodyClasses.add("kb-geometry-open");
  api.measureTop();
  assert.equal(log.scrollTop, 700); // re-pinned to the very bottom (scrollHeight - clientHeight)
});

test("keyboard re-pin leaves a reader scrolled up untouched", () => {
  const log = makeLog({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
  const { api, bodyClasses } = loadChatLayout(log);
  api.wireJump(log, { hidden: false, addEventListener() {} });
  // Reader scrolls up to re-read (off = 500, well past the 200px proximity band).
  log.scrollTop = 100;
  // Keyboard opens.
  log.clientHeight = 300;
  bodyClasses.add("kb-geometry-open");
  api.measureTop();
  assert.equal(log.scrollTop, 100); // not yanked down
});

test("keyboard re-pin does nothing while the keyboard is down (class-gated)", () => {
  // Reader IS at the bottom (near-bottom true), but no kb-geometry-open class: the
  // re-pin must stay quiet so a normal resize/orientation change never forces a scroll.
  const log = makeLog({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
  const { api } = loadChatLayout(log);
  api.wireJump(log, { hidden: false, addEventListener() {} });
  log.clientHeight = 300; // a resize, but no keyboard (plain assignment, no scroll event)
  api.measureTop();
  assert.equal(log.scrollTop, 600); // untouched — re-pin is gated on kb-geometry-open
});
