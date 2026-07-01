import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function classList() {
  const values = new Set();
  return {
    add: (...items) => items.forEach((item) => values.add(item)),
    toggle: (item, force) => {
      if (force) values.add(item);
      else values.delete(item);
    },
    contains: (item) => values.has(item),
  };
}

function loadSegments() {
  const context = { Object, Promise, String };
  context.globalThis = context;
  context.window = context;
  const source = readFileSync(join(root, "src/client/ui-segments-client.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      alwaysStrict: false,
      ignoreDeprecations: "6.0",
      module: ts.ModuleKind.None,
      moduleDetection: ts.ModuleDetectionKind.Legacy,
      removeComments: false,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "src/client/ui-segments-client.ts",
    reportDiagnostics: true,
  }).outputText;
  vm.runInNewContext(`(() => {\n${compiled.trimEnd()}\n})();\n`, context);
  return context;
}

function createController(context, overrides = {}) {
  const calls = [];
  const resizeListeners = [];
  const view = overrides.view || { querySelectorAll: () => [] };
  const state = overrides.state || {};
  const deps = {
    root: view,
    state,
    segmentedNavHtml: ({ active, items }) => `<seg data-active="${active}" data-items="${items.length}"></seg>`,
    withViewTransition: (fn) => {
      calls.push(["transition"]);
      return fn();
    },
    viewEnter: () => calls.push(["viewEnter"]),
    syncRouteFromState: () => calls.push(["syncRouteFromState"]),
    requestAnimationFrame: (fn) => {
      calls.push(["raf"]);
      fn();
      return 1;
    },
    cancelAnimationFrame: (handle) => calls.push(["cancelAnimationFrame", handle]),
    addResizeListener: (listener) => resizeListeners.push(listener),
    renderProgress: () => calls.push(["renderProgress"]),
    renderVolume: () => calls.push(["renderVolume"]),
    renderEndurance: () => calls.push(["renderEndurance"]),
    renderWeight: () => calls.push(["renderWeight"]),
    renderCalendar: () => calls.push(["renderCalendar"]),
    renderHistory: () => calls.push(["renderHistory"]),
    renderProgram: () => calls.push(["renderProgram"]),
    renderEnergy: () => calls.push(["renderEnergy"]),
    renderPlanEditor: () => calls.push(["renderPlanEditor"]),
    renderPlanEndurance: () => calls.push(["renderPlanEndurance"]),
    renderFoodJournal: () => calls.push(["renderFoodJournal"]),
    renderMeals: () => calls.push(["renderMeals"]),
    renderCoach: () => calls.push(["renderCoach"]),
    ...overrides.deps,
  };
  const controller = context.CairnUiSegments.create(deps);
  return { calls, controller, resizeListeners, state, view };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function segmentKeys(segments) {
  return Array.from(segments, ([key]) => key);
}

test("UI segments expose compatibility globals and Plan endurance visibility", () => {
  const context = loadSegments();
  const { controller, state } = createController(context);

  assert.equal(context.CairnUiSegments, context.window.CairnUiSegments);
  assert.deepEqual(segmentKeys(controller.planSeg()), ["edit", "food", "meals", "coach"]);

  context.CairnUiSegments.setDiscipline("hybrid");
  assert.equal(context.primaryDiscipline, "hybrid");
  assert.equal(context.CairnUiSegments.isHybrid(), true);
  assert.deepEqual(segmentKeys(controller.planSeg()), ["edit", "endurance", "food", "meals", "coach"]);

  context.CairnUiSegments.setDiscipline("strength");
  context.CairnUiSegments.setEnduranceGoalSet(true);
  assert.equal(context.enduranceGoalSet, true);
  assert.deepEqual(segmentKeys(controller.planSeg()), ["edit", "endurance", "food", "meals", "coach"]);

  context.CairnUiSegments.setEnduranceGoalSet(false);
  state.planJump = "endurance";
  assert.deepEqual(segmentKeys(controller.planSeg()), ["edit", "endurance", "food", "meals", "coach"]);

  context.primaryDiscipline = "custom";
  assert.equal(context.primaryDiscipline, "custom");
  assert.equal(context.CairnUiSegments.isEndurance(), false);
});

test("UI segments delegate rendering, click routing, resize fitting, and handlers", async () => {
  const context = loadSegments();
  const button = {
    dataset: { seg: "trend" },
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    closest() {
      return seg;
    },
  };
  const active = { offsetLeft: 80, offsetWidth: 20 };
  const seg = {
    classList: classList(),
    clientWidth: 100,
    scrollLeft: 0,
    scrollWidth: 220,
    style: {
      props: {},
      setProperty(name, value) {
        this.props[name] = value;
      },
    },
    querySelector(selector) {
      return selector === ".segbtn.active" ? active : null;
    },
    querySelectorAll(selector) {
      return selector === ".segbtn" ? [button] : [];
    },
  };
  const view = {
    querySelectorAll(selector) {
      if (selector === ".segbtn") return [button];
      if (selector === ".seg") return [seg];
      return [];
    },
  };
  const { calls, controller, resizeListeners } = createController(context, { view });

  assert.equal(controller.segBar("trend", [["trend", "1RM"]]), `<seg data-active="trend" data-items="1"></seg>`);
  assert.equal(resizeListeners.length, 1);

  controller.wireSeg(controller.progressHandlers);
  button.listeners.click();
  await flush();

  assert.equal(seg.style.props["--segi"], "0");
  assert.ok(calls.some((call) => call[0] === "transition"));
  assert.ok(calls.some((call) => call[0] === "renderProgress"));
  assert.ok(calls.some((call) => call[0] === "syncRouteFromState"));
  assert.ok(calls.some((call) => call[0] === "viewEnter"));

  controller.fitSeg(seg);
  assert.equal(seg.classList.contains("seg-scroll"), true);
  assert.equal(seg.scrollLeft, 40);

  resizeListeners[0]();
  assert.ok(calls.some((call) => call[0] === "cancelAnimationFrame"));
  assert.ok(calls.some((call) => call[0] === "raf"));

  controller.planHandlers.endurance();
  assert.ok(calls.some((call) => call[0] === "renderPlanEndurance"));
});

test("Progress nav groups the 8 views into 4 top groups with leaf sub-tabs", () => {
  const context = loadSegments();
  const { controller } = createController(context);
  const PROGRESS_SEG = context.CairnUiSegments.PROGRESS_SEG;

  // Leaf → group mapping surfaces the two flagship reads as their own top slots.
  assert.equal(context.CairnUiSegments.progressGroupOf("sessions"), "train");
  assert.equal(context.CairnUiSegments.progressGroupOf("program"), "performance");
  assert.equal(context.CairnUiSegments.progressGroupOf("energy"), "fuel");
  assert.equal(context.CairnUiSegments.progressGroupOf("weight"), "body");

  // A multi-leaf group (Train) renders a top group bar + a leaf sub-bar; the
  // Endurance leaf is hidden for a strength athlete.
  context.CairnUiSegments.setDiscipline("strength");
  const trainNav = controller.segBar("volume", PROGRESS_SEG);
  assert.match(trainNav, /data-proggroup="train"[^>]*aria-pressed="true"/);
  assert.match(trainNav, /class="segwrap prog-subwrap"/);
  assert.match(trainNav, /data-seg="volume"[^>]*aria-pressed="true"/);
  assert.match(trainNav, /data-seg="sessions"/);
  assert.doesNotMatch(trainNav, /data-seg="endurance"/);

  // A single-view flagship group (Fuel) is just the top bar — no sub-bar clutter.
  const fuelNav = controller.segBar("energy", PROGRESS_SEG);
  assert.match(fuelNav, /data-proggroup="fuel"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(fuelNav, /prog-subwrap/);

  // A non-Progress seg-set is untouched (still the flat sliding bar).
  assert.equal(controller.segBar("trend", [["trend", "1RM"]]), `<seg data-active="trend" data-items="1"></seg>`);
});

test("Progress endurance leaf appears for an endurance athlete or when it's active", () => {
  const context = loadSegments();
  const { controller } = createController(context);
  const PROGRESS_SEG = context.CairnUiSegments.PROGRESS_SEG;

  context.CairnUiSegments.setDiscipline("endurance");
  const nav = controller.segBar("endurance", PROGRESS_SEG);
  assert.match(nav, /data-proggroup="train"[^>]*aria-pressed="true"/);
  assert.match(nav, /data-seg="endurance"[^>]*aria-pressed="true"/);

  // A strength athlete deep-linked to Endurance still sees the tab (never stranded).
  context.CairnUiSegments.setDiscipline("strength");
  assert.match(controller.segBar("endurance", PROGRESS_SEG), /data-seg="endurance"/);
});

test("Progress top-group buttons route to the group's default leaf", async () => {
  const context = loadSegments();
  const groupBtn = {
    classList: classList(),
    dataset: { proggroup: "performance" },
    listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    closest() { return seg; },
  };
  const seg = {
    style: { setProperty() {} },
    querySelectorAll() { return [groupBtn]; },
  };
  const view = {
    querySelectorAll(selector) {
      if (selector === ".segbtn[data-proggroup]") return [groupBtn];
      if (selector === ".seg") return [];
      return [];
    },
  };
  const { calls, controller } = createController(context, { view });
  controller.wireSeg(controller.progressHandlers);
  groupBtn.listeners.click();
  await flush();

  assert.ok(calls.some((call) => call[0] === "renderProgram"), "Performance group opens the Program standing read");
  assert.ok(calls.some((call) => call[0] === "syncRouteFromState"));
});
