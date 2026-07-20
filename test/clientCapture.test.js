import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function loadCapture() {
  const context = {
    Date,
    Number,
    String,
    Array,
    Math,
    isNaN,
    localStorage: { getItem: () => null, setItem: () => {} },
    window: {},
    escHtml,
    escAttr: (v) => escHtml(v).replace(/"/g, "&quot;"),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-provenance-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-date-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-cards-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-jobs-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-reads-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/04-capture.js"), "utf8"), context);
  return context;
}

test("capture weekly range keeps the same Monday-Sunday framing", () => {
  const capture = loadCapture();

  assert.equal(capture.weekRangeLabel("2026-06-14T12:00:00Z"), "Jun 8–14");
  assert.equal(capture.weekRangeLabel("2026-07-01"), "Jun 29 – Jul 5");
  assert.equal(capture.weekRangeLabel("not-a-date"), "");
});

test("capture provenance line escapes directive and marker text", () => {
  const capture = loadCapture();
  const html = capture.provenanceLineHtml(
    {
      directive: `Tilt <easy> "today"`,
      marker: "ApoB <high>",
      uncertain: true,
    },
    `Training "why"`,
  );

  assert.match(html, /aria-label="Training &quot;why&quot;: Tilt &lt;easy&gt; &quot;today&quot;"/);
  assert.match(html, /Worth looking into/);
  assert.match(html, /Tilt &lt;easy&gt; "today"/);
  assert.match(html, /ApoB &lt;high&gt;/);
  assert.doesNotMatch(html, /Tilt <easy>/);
});

test("activity capture restores the text and does not enqueue a permanent rejection", async () => {
  const capture = loadCapture();
  const permanent = new Error("validation");
  const input = { value: "ran 5k" };
  const queued = [];
  const toasts = [];
  capture.document = { querySelector: (selector) => selector === "#qlInput" ? input : null };
  capture.view = { querySelector: () => null };
  capture.api = async () => { throw permanent; };
  capture.CairnApiCache = { isTransientApiFailure: (error) => error !== permanent };
  capture.outboxEnqueue = (...args) => queued.push(args);
  capture.toast = (message) => toasts.push(message);

  await capture.quickLog();

  assert.equal(input.value, "ran 5k");
  assert.equal(queued.length, 0);
  assert.deepEqual(toasts, ["Couldn't log that — try again."]);
});

test("activity capture surfaces device-storage failure instead of claiming an offline save", async () => {
  const capture = loadCapture();
  const input = { value: "ran 5k" };
  const toasts = [];
  capture.document = { querySelector: (selector) => selector === "#qlInput" ? input : null };
  capture.view = { querySelector: () => null };
  capture.api = async () => { throw new Error("offline"); };
  capture.CairnApiCache = { isTransientApiFailure: () => true };
  capture.outboxEnqueue = () => null;
  capture.toast = (message) => toasts.push(message);

  await capture.quickLog();

  assert.equal(input.value, "ran 5k", "the unsaved text remains recoverable in the input");
  assert.deepEqual(toasts, ["Couldn’t save that on this device — free storage and try again."]);
});

test("weight and frequent-food capture only enqueue transient failures", async () => {
  const capture = loadCapture();
  const permanent = new Error("forbidden");
  const queued = [];
  const toasts = [];
  let saveWeight;
  const input = {
    value: "181.5",
    addEventListener() {},
    focus() {},
    scrollIntoView() {},
  };
  const inline = { hidden: false };
  const go = { addEventListener: (_type, handler) => { saveWeight = handler; } };
  const chip = { querySelector: () => null, addEventListener() {} };
  const mini = { innerHTML: "", addEventListener() {} };
  const elements = new Map([
    ["#wtChip", chip], ["#wtChipMini", mini], ["#wtInline", inline],
    ["#wtInlineInput", input], ["#wtInlineGo", go],
  ]);
  capture.view = { querySelector: (selector) => elements.get(selector) || null };
  capture.api = async () => { throw permanent; };
  capture.CairnApiCache = { isTransientApiFailure: (error) => error !== permanent };
  capture.outboxEnqueue = (...args) => queued.push(args);
  capture.toast = (message) => toasts.push(message);

  capture.setupWeightChip();
  await saveWeight();

  const foodChip = { classList: { add() {}, remove() {} } };
  await capture.relogFrequent("oats and berries", foodChip);

  assert.equal(input.value, "181.5", "the rejected weight remains editable");
  assert.equal(queued.length, 0);
  assert.deepEqual(toasts, ["Couldn't log that — try again.", "Couldn't log that — try again."]);
});
