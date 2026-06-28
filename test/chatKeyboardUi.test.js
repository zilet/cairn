import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boot = readFileSync(path.join(root, "public/js/10-boot.js"), "utf8");
const styles = readFileSync(path.join(root, "public/styles.css"), "utf8");

test("mobile chat keyboard state is geometry-led with a short focus/tap intent bridge", () => {
  assert.match(boot, /let\s+keyboardIntentUntil\s*=\s*0/);
  assert.match(boot, /const\s+keyboardGeometryOpen\s*=\s*\(\)\s*=>/);
  assert.match(boot, /vvMax\s*-\s*vv\.height/);
  assert.match(boot, /Date\.now\(\)\s*<\s*keyboardIntentUntil/);
  assert.match(boot, /document\.addEventListener\("pointerdown"/);
  assert.match(boot, /document\.addEventListener\("focusin"/);
});

test("mobile chat releases stale textarea focus after iOS dismisses the keyboard", () => {
  assert.match(boot, /function|const\s+releaseStaleChatFocus/);
  assert.match(boot, /document\.body\.classList\.contains\("chat-mode"\)/);
  assert.match(boot, /\.closest\?\.\(".chatview"\)/);
  assert.match(boot, /\.blur\(\)/);
});

test("mobile chat still pins the composer to viewport geometry while typing", () => {
  assert.match(styles, /body\.chat-mode \.chatview[\s\S]*position:fixed/);
  assert.match(styles, /body\.chat-mode\.kb-open \.chatview\{bottom:0\}/);
  assert.match(styles, /body\.chat-mode\.kb-open \.tabbar\{transform:translateY\(110%\);pointer-events:none\}/);
});
