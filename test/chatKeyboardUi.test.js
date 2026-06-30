import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boot = readFileSync(path.join(root, "public/js/10-boot.js"), "utf8");
const mobileViewport = readFileSync(path.join(root, "public/js/app-mobile-viewport.js"), "utf8");
const styles = readFileSync(path.join(root, "public/styles.css"), "utf8");

test("mobile chat keyboard state is geometry-led with a short focus/tap intent bridge", () => {
  assert.match(boot, /installMobileViewportGuards\(\)/);
  assert.match(mobileViewport, /let\s+keyboardIntentUntil\s*=\s*0/);
  assert.match(mobileViewport, /const\s+keyboardGeometryOpen\s*=\s*\(\)\s*=>/);
  assert.match(mobileViewport, /vvMax\s*-\s*vv\.height/);
  assert.match(mobileViewport, /Date\.now\(\)\s*<\s*keyboardIntentUntil/);
  assert.match(mobileViewport, /document\.addEventListener\("pointerdown"/);
  assert.match(mobileViewport, /document\.addEventListener\("focusin"/);
});

test("mobile chat releases stale textarea focus after iOS dismisses the keyboard", () => {
  assert.match(mobileViewport, /function|const\s+releaseStaleChatFocus/);
  assert.match(mobileViewport, /document\.body\.classList\.contains\("chat-mode"\)/);
  assert.match(mobileViewport, /\.closest\?\.\(".chatview"\)/);
  assert.match(mobileViewport, /\.blur\(\)/);
});

test("mobile bottom inset never publishes a negative safe-area correction", () => {
  assert.match(mobileViewport, /const\s+rawVvb\s*=\s*window\.innerHeight\s*-\s*\(vv\.offsetTop\s*\+\s*vv\.height\)/);
  assert.match(mobileViewport, /const\s+vvb\s*=\s*kbOpen\s*\?\s*0\s*:\s*Math\.max\(0,\s*rawVvb\)/);
  assert.match(mobileViewport, /"cairn:keyboard-settle"/);
  assert.match(mobileViewport, /keyboardIntentUntil\s*=\s*0/);
});

test("mobile chat still pins the composer to viewport geometry while typing", () => {
  assert.match(styles, /body\.chat-mode \.chatview[\s\S]*position:fixed/);
  assert.match(styles, /body\.chat-mode\.kb-open \.chatview\{bottom:0\}/);
  assert.match(styles, /body\.chat-mode\.kb-open \.tabbar\{transform:translateY\(110%\);pointer-events:none\}/);
});
