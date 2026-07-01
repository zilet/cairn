import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

class FakeClassList {
  constructor(values = []) {
    this.values = new Set(values);
  }

  add(name) {
    this.values.add(name);
  }

  remove(name) {
    this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {}

class FakeImage extends FakeElement {}

class FakeInput extends FakeElement {
  constructor(document) {
    super();
    this.document = document;
    this.blurCount = 0;
  }

  blur() {
    this.blurCount += 1;
    if (this.document.activeElement === this) this.document.activeElement = this.document.body;
  }
}

function loadAttachment() {
  const source = readFileSync(new URL("../public/js/chat-attachment-client.js", import.meta.url), "utf8");
  const events = [];
  const rafs = [];
  const timers = [];
  const document = {
    activeElement: null,
    body: { classList: new FakeClassList() },
    dispatchEvent: (event) => {
      events.push({ type: event.type, detail: event.detail });
      return true;
    },
    createElement: () => ({}),
  };
  document.activeElement = document.body;

  const context = {
    document,
    Element: FakeElement,
    Error,
    File: class {},
    HTMLImageElement: FakeImage,
    Image: FakeImage,
    Object,
    Promise,
    URL: {
      createObjectURL: () => "blob:fake",
      revokeObjectURL: () => {},
    },
    CustomEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    CairnChatClient: {
      CHAT_IMAGE_EDGE_STEPS: [1280],
      CHAT_IMAGE_QUALITY_STEPS: [0.82],
      CHAT_IMAGE_MAX_BYTES: 4 * 1024 * 1024,
      imagePayload: () => ({ dataUrl: "data:image/jpeg;base64,AA==", base64: "AA==", mime: "image/jpeg", bytes: 1 }),
    },
    globalThis: null,
    requestAnimationFrame: (fn) => {
      rafs.push(fn);
      return rafs.length;
    },
    setTimeout: (fn, delay) => {
      timers.push({ fn, delay });
      return timers.length;
    },
    window: null,
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(source, context, { filename: "chat-attachment-client.js" });

  return {
    attachment: context.CairnChatAttachment,
    context,
    document,
    events,
    rafs,
    timers,
    input: new FakeInput(document),
    fileInput: new FakeInput(document),
  };
}

test("chat attachment soft-keyboard reset blurs active picker participants and clears kb-open", () => {
  const env = loadAttachment();

  env.document.body.classList.add("kb-open");
  env.document.body.classList.add("kb-geometry-open");
  env.document.activeElement = env.input;
  env.attachment.resetFocusAfterNativePicker({
    input: env.input,
    fileInput: env.fileInput,
    isSoftKeyboard: () => true,
  });

  assert.equal(env.input.blurCount, 1);
  assert.equal(env.fileInput.blurCount, 0);
  assert.equal(env.document.body.classList.contains("kb-open"), false);
  assert.equal(env.document.body.classList.contains("kb-geometry-open"), false);

  env.document.body.classList.add("kb-open");
  env.document.body.classList.add("kb-geometry-open");
  env.document.activeElement = env.fileInput;
  env.attachment.resetFocusAfterNativePicker({
    input: env.input,
    fileInput: env.fileInput,
    isSoftKeyboard: () => true,
  });

  assert.equal(env.fileInput.blurCount, 1);
  assert.equal(env.document.body.classList.contains("kb-open"), false);
  assert.equal(env.document.body.classList.contains("kb-geometry-open"), false);
});

test("chat attachment non-soft reset leaves focus and keyboard class untouched", () => {
  const env = loadAttachment();

  env.document.body.classList.add("kb-open");
  env.document.activeElement = env.input;
  env.attachment.resetFocusAfterNativePicker({
    input: env.input,
    fileInput: env.fileInput,
    isSoftKeyboard: () => false,
  });

  assert.equal(env.input.blurCount, 0);
  assert.equal(env.document.activeElement, env.input);
  assert.equal(env.document.body.classList.contains("kb-open"), true);
});

test("chat attachment settle dispatches focus-grace event and suppresses delayed inactive measures", () => {
  const env = loadAttachment();
  let active = true;
  let measures = 0;

  env.attachment.settleAfterNativePicker({
    isActive: () => active,
    measure: () => { measures += 1; },
    graceMs: 1300,
  });

  assert.equal(env.events.length, 1);
  assert.equal(env.events[0].type, "cairn:keyboard-settle");
  assert.equal(env.events[0].detail.chatFocusGraceMs, 1300);
  assert.equal(measures, 1, "settle measures immediately");
  assert.equal(env.rafs.length, 1);
  env.rafs.shift()();
  assert.equal(env.rafs.length, 1);
  env.rafs.shift()();
  assert.equal(measures, 2, "settle measures again after double requestAnimationFrame");

  active = false;
  for (const timer of env.timers) timer.fn();
  assert.equal(measures, 2, "inactive delayed timers do not remeasure");
  assert.deepEqual(env.timers.map((timer) => timer.delay), [120, 280, 520, 900]);
});

test("chat attachment preview helper returns images only", () => {
  const env = loadAttachment();
  const img = new FakeImage();

  assert.equal(env.attachment.previewImage(img), img);
  assert.equal(env.attachment.previewImage(new FakeElement()), null);
  assert.equal(env.attachment.previewImage(null), null);
});
