import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function classList() {
  const values = new Set();
  return {
    add: (...items) => items.forEach((item) => values.add(item)),
    remove: (...items) => items.forEach((item) => values.delete(item)),
    contains: (item) => values.has(item),
  };
}

function loadUiFeedback({ reduced = true } = {}) {
  const context = {
    Object,
    String,
    Number,
    Math,
    setInterval,
    clearInterval,
    escHtml,
    CairnUi: {
      loadingStateHtml: ({ label }) => `<div class="loadstate">${escHtml(label)}</div>`,
    },
    matchMedia: () => ({ matches: reduced }),
    segBar: (active, items) => `<nav data-active="${escHtml(active)}" data-items="${items.length}"></nav>`,
    view: { querySelectorAll: () => [] },
    switchTab: () => {},
    performance: { now: () => 0 },
    requestAnimationFrame: (fn) => fn(750),
  };
  context.window = context;
  const source = readFileSync(join(root, "src/client/ui-feedback-client.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      alwaysStrict: false,
      ignoreDeprecations: "6.0",
      module: ts.ModuleKind.None,
      moduleDetection: ts.ModuleDetectionKind.Legacy,
      removeComments: false,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "src/client/ui-feedback-client.ts",
    reportDiagnostics: true,
  }).outputText;
  vm.runInNewContext(`(() => {\n${compiled.trimEnd()}\n})();\n`, context);
  return context;
}

test("UI feedback exports compatibility globals and a namespaced facade", () => {
  const context = loadUiFeedback();

  assert.equal(context.CairnUiFeedback.loadingState("<labs>"), `<div class="loadstate">&lt;labs&gt;</div>`);
  assert.equal(context.loadingState("<labs>"), `<div class="loadstate">&lt;labs&gt;</div>`);
  assert.equal(context.stagger(99), "--i:12");
  assert.equal(context.fmtK(12450), "12.5k");
  assert.equal(context.CairnUiFeedback, context.window.CairnUiFeedback);
  assert.equal(context.btnBusy, context.CairnUiFeedback.btnBusy);
});

test("skeleton helpers compose shared segmented nav and shimmer primitives", () => {
  const context = loadUiFeedback();

  const seg = context.segSkeleton("energy", [["energy", "Energy"]], 1);
  assert.match(seg, /<nav data-active="energy" data-items="1"><\/nav>/);
  assert.match(seg, /class="skel-region"/);
  assert.equal((seg.match(/class="skel-card"/g) || []).length, 2);

  const today = context.todaySkeleton();
  assert.match(today, /today-wrap today-skel/);
  assert.match(today, /aria-busy="true"/);
});

test("button busy state freezes footprint, escapes labels, and restores once", () => {
  const context = loadUiFeedback();
  const button = {
    innerHTML: "<b>Save</b>",
    textContent: "Save",
    disabled: false,
    offsetWidth: 88,
    style: { minWidth: "" },
    classList: classList(),
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  };

  const restore = context.btnBusy(button, "Save <now>", { ghost: true });
  assert.equal(button.disabled, true);
  assert.equal(button.style.minWidth, "88px");
  assert.equal(button.attributes.get("aria-busy"), "true");
  assert.equal(button.classList.contains("btn-busy"), true);
  assert.match(button.innerHTML, /aspin-ghost/);
  assert.match(button.innerHTML, /Save &lt;now&gt;/);

  restore();
  restore();
  assert.equal(button.disabled, false);
  assert.equal(button.style.minWidth, "");
  assert.equal(button.innerHTML, "<b>Save</b>");
  assert.equal(button.classList.contains("btn-busy"), false);
  assert.equal(button.attributes.has("aria-busy"), false);
});

test("count-up runner can snap final values without animation churn", () => {
  const context = loadUiFeedback();
  const rows = [
    { dataset: { cu: "12500", cufmt: "k" }, textContent: "" },
    { dataset: { cu: "42" }, textContent: "" },
  ];
  const scope = { querySelectorAll: () => rows };

  context.runCountUps(scope, { snap: true });

  assert.equal(rows[0].textContent, "12.5k");
  assert.equal(rows[1].textContent, "42");
});

test("thinking caption uses reduced-motion static copy and class hook", () => {
  const context = loadUiFeedback({ reduced: true });
  const el = {
    textContent: "",
    isConnected: true,
    offsetWidth: 10,
    style: { animation: "" },
    classList: classList(),
  };

  const stop = context.thinkingCaption(el, "meal_swap");
  assert.equal(el.textContent, "Reading the meal…");
  assert.equal(el.classList.contains("typing-cap"), true);
  assert.equal(typeof stop, "function");
  stop();
});
