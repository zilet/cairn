import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appStartup = readFileSync(path.join(root, "public/js/app-startup.js"), "utf8");
const mobileViewport = readFileSync(path.join(root, "public/js/app-mobile-viewport.js"), "utf8");
const styles = readFileSync(path.join(root, "public/styles.css"), "utf8");

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

test("mobile chat pins the composer on real keyboard geometry, not intent", () => {
  // STRUCTURAL layout (tab bar slide, chat re-anchor to bottom:0) is gated on real
  // keyboard geometry — an intent tap that summons no keyboard must not bounce the bar.
  assert.match(styles, /body\.chat-mode \.chatview[\s\S]*position:fixed/);
  assert.match(styles, /body\.chat-mode\.kb-geometry-open \.chatview\{bottom:0\}/);
  assert.match(styles, /body\.chat-mode\.kb-geometry-open \.tabbar\{transform:translateY\(110%\);pointer-events:none\}/);
  // and the composer re-anchor is transition-matched to the 220ms tab-bar slide
  assert.match(styles, /body\.chat-mode \.chatview\{[\s\S]*transition:bottom \.22s ease/);
});
