import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import assert from "node:assert/strict";

test("composer reuses request_id and retains text/photo until enqueue succeeds", async () => {
  const listeners = new Map();
  const image = { dataUrl: "data:image/jpeg;base64,YQ==", base64: "YQ==", mime: "image/jpeg", bytes: 1 };
  const input = { value: "Log this lunch photo", isConnected: true, addEventListener() {}, focus() {} };
  const fileInput = {
    value: "photo.jpg",
    files: [{}],
    addEventListener(type, fn) { listeners.set(`file:${type}`, fn); },
    click() {},
  };
  const imgEl = { src: "" };
  const preview = { hidden: true, querySelector(selector) { return selector === "img" ? imgEl : null; } };
  const attachBtn = { classList: { add() {}, remove() {} }, addEventListener() {} };
  const sendBtn = { addEventListener() {} };
  const bodies = [];
  let calls = 0;
  const context = {
    console,
    Date,
    Math,
    crypto: { randomUUID: () => "123e4567-e89b-12d3-a456-426614174000" },
    matchMedia: () => ({ matches: true }),
    document: {
      body: { classList: { contains: () => false } },
      addEventListener() {},
      removeEventListener() {},
    },
    CairnChatAttachment: {
      compressImage: async () => image,
      previewImage: () => imgEl,
      resetFocusAfterNativePicker() {},
      settleAfterNativePicker() {},
    },
    CairnChatComposerFocus: { wireFocus() {} },
  };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(process.cwd(), "public/js/chat-composer-controller.js"), "utf8"), context);
  const handle = context.CairnChatComposerController.wire({
    token: 1,
    state: { tab: "chat", chatPrefill: null },
    input,
    fileInput,
    preview,
    attachBtn,
    sendBtn,
    api: async (_path, opts) => {
      bodies.push(JSON.parse(opts.body));
      calls++;
      if (calls === 1) throw new Error("lost response");
      return { turn: { id: 9 } };
    },
    toast() {},
    appendMsg: () => ({ remove() {} }),
    rememberFuelContext() {},
    loadFuel: async () => {},
    saveDraft() {},
    loadDraft: () => "",
    autosizeInput() {},
    measure() {},
    spawnPendingBubble() {},
    ensureMonitor() {},
  });
  listeners.get("file:change")();
  await Promise.resolve();

  await handle.send();
  assert.equal(input.value, "Log this lunch photo");
  assert.equal(preview.hidden, false);
  await handle.send();
  assert.equal(bodies[0].request_id, bodies[1].request_id);
  assert.equal(bodies[1].image_base64, "YQ==");
  assert.equal(preview.hidden, true);
});

test("composer recreation restores session-scoped retry text and idempotency key before a lost request can duplicate", async () => {
  const sessionStorage = new Map();
  const localStorage = new Map();
  let ids = 0;
  const baseContext = () => {
    const context = {
      console,
      Date,
      Math,
      crypto: { randomUUID: () => `request-${++ids}` },
      localStorage: { getItem: (key) => localStorage.get(key) || null, setItem: (key, value) => localStorage.set(key, value), removeItem: (key) => localStorage.delete(key) },
      sessionStorage: { getItem: (key) => sessionStorage.get(key) || null, setItem: (key, value) => sessionStorage.set(key, value), removeItem: (key) => sessionStorage.delete(key) },
      matchMedia: () => ({ matches: true }),
      document: { body: { classList: { contains: () => false } }, addEventListener() {}, removeEventListener() {} },
      CairnChatAttachment: { previewImage: () => null, resetFocusAfterNativePicker() {}, settleAfterNativePicker() {} },
      CairnChatComposerFocus: { wireFocus() {} },
    };
    context.globalThis = context;
    vm.runInNewContext(readFileSync(join(process.cwd(), "public/js/chat-turn-records-client.js"), "utf8"), context);
    vm.runInNewContext(readFileSync(join(process.cwd(), "public/js/chat-composer-controller.js"), "utf8"), context);
    return context;
  };
  const makeDeps = (context, input, api) => ({
    token: 1, state: { tab: "chat", chatPrefill: null }, input,
    fileInput: { value: "", files: null, addEventListener() {}, click() {} },
    preview: { hidden: true, querySelector() { return null; } },
    attachBtn: { classList: { add() {}, remove() {} }, addEventListener() {} }, sendBtn: { addEventListener() {} }, api,
    toast() {}, appendMsg: () => ({ remove() {} }), rememberFuelContext() {}, loadFuel: async () => {},
    saveDraft() {}, loadDraft: () => "", autosizeInput() {}, measure() {}, spawnPendingBubble() {}, ensureMonitor() {},
  });

  const first = baseContext();
  const firstInput = { value: "Please log my lunch", isConnected: true, addEventListener() {}, focus() {} };
  const firstHandle = first.CairnChatComposerController.wire(makeDeps(first, firstInput, async () => { throw new Error("response lost"); }));
  await firstHandle.send();
  assert.match(sessionStorage.get("cairn.chat.retry.v1"), /request-1/);
  assert.equal(localStorage.has("cairn.chat.retry.v1"), false);

  const second = baseContext();
  const secondInput = { value: "", isConnected: true, addEventListener() {}, focus() {} };
  const bodies = [];
  const secondHandle = second.CairnChatComposerController.wire(makeDeps(second, secondInput, async (_path, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { turn: { id: 42 } };
  }));
  assert.equal(secondInput.value, "Please log my lunch");
  await secondHandle.send();
  assert.equal(bodies[0].request_id, "request-1");
  assert.equal(bodies[0].message, "Please log my lunch");
  assert.equal(sessionStorage.has("cairn.chat.retry.v1"), false);
});

test("retry envelope expires from session storage without touching the durable draft store", () => {
  const session = new Map();
  const local = new Map();
  const timers = new Map();
  let timerId = 0;
  let now = 1_000;
  const context = {
    Date: { now: () => now },
    JSON,
    sessionStorage: { getItem: (key) => session.get(key) || null, setItem: (key, value) => session.set(key, value), removeItem: (key) => session.delete(key) },
    localStorage: { getItem: (key) => local.get(key) || null, setItem: (key, value) => local.set(key, value), removeItem: (key) => local.delete(key) },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(process.cwd(), "public/js/chat-turn-records-client.js"), "utf8"), context);
  const records = context.CairnChatTurnRecords;
  records.saveDraft("durable draft");
  records.saveRetry({ requestId: "retry-1", text: "retry text", hasImage: false, expiresAt: 2_000 });
  assert.match(session.get("cairn.chat.retry.v1"), /retry-1/);
  assert.equal(local.get("cairn.chat.draft"), "durable draft");
  assert.equal(local.has("cairn.chat.retry.v1"), false);
  now = 2_000;
  for (const { fn } of [...timers.values()]) fn();
  assert.equal(session.has("cairn.chat.retry.v1"), false);
  assert.equal(records.loadRetry(), null);
});
