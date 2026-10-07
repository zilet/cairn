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
    localISO: () => "2026-09-29",
    window: {},
    escHtml,
    escAttr: (v) => escHtml(v).replace(/"/g, "&quot;"),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-format.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-provenance-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-date-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-cards-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-read-jobs-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-reads-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/capture-checkin-client.js"), "utf8"), context);
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

test("weight capture only enqueues transient failures", async () => {
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

  assert.equal(input.value, "181.5", "the rejected weight remains editable");
  assert.equal(queued.length, 0);
  assert.deepEqual(toasts, ["Couldn't log that — try again."]);
  // A transient failure queues the weigh-in WITH its day, so a replay after midnight
  // never files it on the next one.
  capture.api = async () => { throw new Error("offline"); };
  await saveWeight();
  assert.deepEqual(JSON.parse(JSON.stringify(queued.at(-1))), ["weight", "/bodyweight", { weight_lb: 181.5, date: "2026-09-29" }]);
});

test("the Brief's training line never speaks for a watch's overnight reading, and names its source", async () => {
  const capture = loadCapture();
  const slot = { isConnected: true, innerHTML: "", querySelectorAll: () => [] };
  capture.view = { querySelector: (selector) => (selector === "#briefProvenance" ? slot : null) };
  capture.state = { tab: "today" };
  capture.api = async () => ({
    directives: [
      // HRV is Body & recovery's (last night against the athlete's own band): never here.
      { id: 1, domain: "training", marker: "HRV", directive: "Keep intensity easy while HRV sits low", status: "active" },
      { id: 2, domain: "watch", marker: "ApoB", directive: "Keep regular aerobic work in the week", status: "active" },
    ],
  });
  await capture.loadTrainingProvenance(true);
  assert.doesNotMatch(slot.innerHTML, /HRV/);
  assert.match(slot.innerHTML, /aria-label="Training shaped by your labs: Keep regular aerobic work in the week"/);
  assert.equal(capture.CairnCaptureProvenance.trainingProvenanceLabel({ marker: "VO2max" }), "Training shaped by your VO2max");
});

test("a kg athlete types kg; the weigh-in is stored in canonical lb at the write edge", async () => {
  const capture = loadCapture();
  capture.CairnFmt.set({ weight_units: "kg" });
  let saveWeight;
  const posted = [];
  const mini = { innerHTML: "", addEventListener() {} };
  const inline = { hidden: false };
  const input = { value: "80", dataset: { unit: "kg" }, addEventListener() {}, focus() {}, scrollIntoView() {} };
  const go = { addEventListener: (_type, handler) => { saveWeight = handler; } };
  const elements = new Map([["#wtChipMini", mini], ["#wtInline", inline], ["#wtInlineInput", input], ["#wtInlineGo", go]]);
  capture.view = { querySelector: (selector) => elements.get(selector) || null };
  capture.api = async (_path, init) => {
    posted.push(JSON.parse(init.body));
    return { ok: true };
  };
  capture.swrInvalidate = () => {};
  capture.toast = () => {};
  capture.setupWeightChip();
  await saveWeight();
  assert.equal(posted[0].weight_lb, 176.37);
  // Painted back in the athlete's own unit, never the stored pounds.
  assert.match(mini.innerHTML, /^80<span class="wt-mini-unit">kg/);
});

test("bodyweight quick-add updates both the always-reachable chip and folded tile", async () => {
  const capture = loadCapture();
  let saveWeight;
  const value = { innerHTML: "" };
  const chip = { querySelector: (selector) => selector === "[data-wtval]" ? value : null, addEventListener() {} };
  const mini = { innerHTML: "", addEventListener() {} };
  const inline = { hidden: false };
  const input = { value: "172.6", addEventListener() {}, focus() {}, scrollIntoView() {} };
  const go = { addEventListener: (_type, handler) => { saveWeight = handler; } };
  const elements = new Map([
    ["#wtChip", chip], ["#wtChipMini", mini], ["#wtInline", inline],
    ["#wtInlineInput", input], ["#wtInlineGo", go],
  ]);
  capture.view = { querySelector: (selector) => elements.get(selector) || null };
  capture.api = async () => ({ ok: true });
  capture.swrInvalidate = () => {};
  capture.toast = () => {};

  capture.setupWeightChip();
  await saveWeight();

  assert.match(value.innerHTML, /^172\.6/);
  assert.match(mini.innerHTML, /^172\.6<span class="wt-mini-unit">lb/);
  assert.equal(input.value, "");
  assert.equal(inline.hidden, true);
});
