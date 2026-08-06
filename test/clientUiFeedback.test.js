import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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

// ---------- the caption registry ----------
// Four call sites used to pass their lines INLINE as an array instead of naming a
// registered script — evolve-program, the recovery week, and the whole-picture read
// from each of its two entry points. thinkingCaption looks a script up by
// `String(op)`, so an array stringified to a comma-joined key, missed, and fell
// through to the "Thinking…" fallback. Authored copy that never once reached a
// screen, and nothing failed: an unregistered key degrades exactly like a
// legitimately unlisted op. The union that allowed it is gone from the contract;
// these pin the runtime side, which is what the athlete actually sees.
function captionProbe() {
  return { textContent: "", isConnected: true, offsetWidth: 10, style: { animation: "" }, classList: classList() };
}

test("the evolve and recovery scripts render their own copy, not the fallback", () => {
  const context = loadUiFeedback({ reduced: true });

  const evolve = captionProbe();
  context.thinkingCaption(evolve, "evolve_program");
  assert.equal(evolve.textContent, "Reading how your lifts are trending…");
  assert.notEqual(evolve.textContent, "Thinking…", "the authored evolve copy actually reaches the screen");

  const recovery = captionProbe();
  context.thinkingCaption(recovery, "recovery_week");
  assert.equal(recovery.textContent, "Reading the load you've accumulated…");

  // Both health-synthesis entry points wrote the same four lines independently;
  // one registry entry now serves both.
  const synthesis = captionProbe();
  context.thinkingCaption(synthesis, "health_synthesis");
  assert.equal(synthesis.textContent, "Reading your labs…");

  // An op with no script still degrades calmly — that is the fallback's real job.
  const unknown = captionProbe();
  context.thinkingCaption(unknown, "no_such_op");
  assert.equal(unknown.textContent, "Thinking…");
});

test("every caption key the built client passes resolves to a registered script", () => {
  const context = loadUiFeedback({ reduced: true });
  const dir = join(root, "public/js");
  const keys = new Set();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(join(dir, file), "utf8");
    // `caption: "key"` and the defaulted `caption: opts.caption || "key"`.
    for (const match of source.matchAll(/caption:\s*(?:[\w.]+\s*\|\|\s*)?"([a-z0-9_]+)"/g)) keys.add(match[1]);
  }
  assert.ok(keys.size >= 10, `expected the client's caption keys, found ${keys.size}`);
  assert.ok(keys.has("evolve_program"), "evolve passes a registered key, not inline lines");
  for (const key of [...keys].sort()) {
    const el = captionProbe();
    context.thinkingCaption(el, key);
    assert.notEqual(el.textContent, "Thinking…", `caption "${key}" has no script in THINKING_SCRIPTS`);
  }
});
