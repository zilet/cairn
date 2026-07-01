import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeInput {
  constructor(document) {
    this.document = document;
    this.isConnected = true;
    this.listeners = new Map();
    this.blurCount = 0;
    this.focusCalls = [];
  }

  addEventListener(type, fn, options) {
    const list = this.listeners.get(type) || [];
    list.push({ fn, options });
    this.listeners.set(type, list);
  }

  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener.fn({ type });
  }

  focus(options) {
    this.focusCalls.push(options);
    this.document.activeElement = this;
  }

  blur() {
    this.blurCount += 1;
    if (this.document.activeElement === this) this.document.activeElement = this.document.body;
  }
}

function loadComposerFocus() {
  const source = readFileSync(new URL("../public/js/chat-composer-focus-client.js", import.meta.url), "utf8");
  const rafs = [];
  const timers = [];
  const document = { activeElement: null, body: {} };
  document.activeElement = document.body;
  const context = {
    document,
    Object,
    requestAnimationFrame: (fn) => {
      rafs.push(fn);
      return rafs.length;
    },
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    globalThis: null,
    window: null,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(source, context, { filename: "chat-composer-focus-client.js" });
  return { composerFocus: context.CairnChatComposerFocus, context, document, rafs, timers };
}

test("chat composer focus release clears stale active textarea before a mobile retap", () => {
  const env = loadComposerFocus();
  const input = new FakeInput(env.document);
  let measures = 0;

  env.document.activeElement = input;
  env.composerFocus.releaseStaleInputFocus({
    input,
    isSoftKeyboard: () => true,
    isKeyboardGeometryOpen: () => false,
    measure: () => { measures += 1; },
  });

  assert.equal(input.blurCount, 1);
  assert.equal(env.document.activeElement, env.document.body);
  assert.equal(measures, 1);

  env.document.activeElement = input;
  env.composerFocus.releaseStaleInputFocus({
    input,
    isSoftKeyboard: () => true,
    isKeyboardGeometryOpen: () => true,
    measure: () => { measures += 1; },
  });

  assert.equal(input.blurCount, 1, "open keyboard geometry is not force-blurred");
  assert.equal(env.document.activeElement, input);
});

test("chat composer focus recovery focuses synchronously from the tap gesture", () => {
  const env = loadComposerFocus();
  const input = new FakeInput(env.document);
  let measures = 0;

  env.composerFocus.recoverInputFocusFromTap({
    input,
    isActive: () => true,
    isSoftKeyboard: () => true,
    measure: () => { measures += 1; },
  });

  assert.equal(input.focusCalls.length, 1);
  assert.equal(input.focusCalls[0].preventScroll, true);
  assert.equal(env.document.activeElement, input);
  assert.equal(measures, 1, "layout settling starts immediately after the gesture focus");
  assert.deepEqual(env.timers.map((timer) => timer.delay), [80, 160, 260, 380, 520]);

  for (const timer of env.timers) timer.fn();
  assert.equal(input.focusCalls.length, 1, "delayed timers only measure, they do not reopen focus outside the gesture");
});

test("chat composer focus wiring turns a stale mobile textarea into a tappable composer", () => {
  const env = loadComposerFocus();
  const input = new FakeInput(env.document);
  let measures = 0;

  env.composerFocus.wireFocus({
    input,
    isActive: () => true,
    isSoftKeyboard: () => true,
    isKeyboardGeometryOpen: () => false,
    measure: () => { measures += 1; },
  });

  env.document.activeElement = input;
  input.dispatch("pointerdown");
  assert.equal(input.blurCount, 1);
  assert.equal(env.document.activeElement, env.document.body);

  input.dispatch("pointerup");
  assert.equal(input.focusCalls.length, 1);
  assert.equal(env.document.activeElement, input);

  input.dispatch("click");
  assert.equal(input.focusCalls.length, 2);
  assert.ok(measures >= 3);
});
