import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const styles = readFileSync(join(root, "public/styles.css"), "utf8");

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
  // The Progress bars are built by the shared segmented control (CairnUi.segmentedHtml).
  for (const file of ["public/js/html-utils.js", "public/js/ui-components.js", "public/js/train-nav-client.js"]) {
    vm.runInNewContext(readFileSync(join(root, file), "utf8"), context);
  }
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
    renderTrainWeek: () => calls.push(["renderTrainWeek"]),
    renderTrainOverview: () => calls.push(["renderTrainOverview"]),
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
    activateTab: (name) => calls.push(["activateTab", name]),
    ...overrides.deps,
  };
  const controller = context.CairnUiSegments.create(deps);
  return { calls, controller, resizeListeners, state, view };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function segmentKeys(segments) {
  return Array.from(segments, ([key]) => key);
}

function segmentLabels(segments) {
  return Array.from(segments, ([, label]) => label);
}

test("UI segments expose compatibility globals and the endurance visibility state", () => {
  const context = loadSegments();
  const { controller } = createController(context);

  assert.equal(context.CairnUiSegments, context.window.CairnUiSegments);
  // The Plan seg bar is gone: every Plan section wears its own home's chrome.
  assert.equal(Object.hasOwn(controller, "planSeg"), false);
  assert.equal(Object.hasOwn(controller, "planHandlers"), false);
  assert.equal(context.CairnUiSegments.showEnduranceTab(), false);

  context.CairnUiSegments.setDiscipline("hybrid");
  assert.equal(context.primaryDiscipline, "hybrid");
  assert.equal(context.CairnUiSegments.isHybrid(), true);
  assert.equal(context.CairnUiSegments.showEnduranceTab(), true);

  context.CairnUiSegments.setDiscipline("strength");
  context.CairnUiSegments.setEnduranceGoalSet(true);
  assert.equal(context.enduranceGoalSet, true);
  assert.equal(context.CairnUiSegments.showEnduranceTab(), true);

  context.CairnUiSegments.setEnduranceGoalSet(false);
  assert.equal(context.CairnUiSegments.showEnduranceTab(), false);

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
});

test("Train's Plan leaf and the editor's Progress leaves are cross-view navigations", async () => {
  const context = loadSegments();
  const state = { planSeg: "food", planJump: "food", progressSeg: "overview" };
  const leaf = (key) => ({
    dataset: { seg: key },
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    closest() {
      return null;
    },
  });
  const planBtn = leaf("plan");
  const historyBtn = leaf("sessions");
  const view = {
    querySelectorAll(selector) {
      return selector === ".segbtn" ? [planBtn, historyBtn] : [];
    },
  };
  const { calls, controller } = createController(context, { view, state });

  // From Train: Program → Plan opens the editor through activateTab, bare (no
  // second transition, no extra route sync: activateTab owns both).
  controller.wireSeg(controller.progressHandlers);
  planBtn.listeners.click();
  await flush();
  assert.equal(state.planSeg, "edit");
  assert.equal(state.planJump, null);
  assert.deepEqual(plain(calls), [["activateTab", "plan"]]);

  // From the editor: a Progress leaf returns to the Progress view on that leaf.
  calls.length = 0;
  controller.wireSeg(controller.progressLinkHandlers);
  historyBtn.listeners.click();
  await flush();
  assert.equal(state.progressSeg, "sessions");
  assert.deepEqual(plain(calls), [["activateTab", "progress"]]);
  assert.equal(Object.hasOwn(controller.progressLinkHandlers, "plan"), true);
});

test("Train → Fuel lists This week's menu, a cross-view row into the week menu on Today", async () => {
  const context = loadSegments();
  const api = context.CairnUiSegments;
  const rows = api.progressDeeperHtml("intake");
  assert.match(rows, /data-train-leaf="energy"/);
  assert.match(rows, /data-train-leaf="menu"/);
  assert.match(rows, /This week's menu/);
  assert.ok(rows.indexOf('data-train-leaf="energy"') < rows.indexOf('data-train-leaf="menu"'), "the trends first");
  assert.equal(api.progressGroupOf("menu"), "fuel");
  assert.equal(api.progressIsLanding("menu"), false);
  // Only the Fuel group carries it.
  for (const landing of ["week", "program", "weight"]) assert.doesNotMatch(api.progressDeeperHtml(landing), /data-train-leaf="menu"/);

  const state = { planSeg: "edit", planJump: null, progressSeg: "intake" };
  const row = {
    dataset: { trainLeaf: "menu" },
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    closest() {
      return null;
    },
  };
  const view = { querySelectorAll: (selector) => (selector === "[data-train-leaf]" ? [row] : []) };
  const { calls, controller } = createController(context, { view, state });
  controller.wireSeg(controller.progressHandlers);
  row.listeners.click();
  await flush();
  // A cross-view navigation: activateTab owns the transition and the route sync.
  assert.equal(state.planSeg, "meals");
  assert.equal(state.planJump, "meals");
  assert.deepEqual(plain(calls), [["activateTab", "plan"]]);
});

test("Train nav is one level: landings wear the group bar, deeper leaves a step back", () => {
  const context = loadSegments();
  const { controller } = createController(context);
  const PROGRESS_SEG = context.CairnUiSegments.PROGRESS_SEG;
  const api = context.CairnUiSegments;

  // Leaf → group mapping: Program holds the program you run (the plan editor and
  // the program read); Fuel the nutrition trends.
  assert.deepEqual(segmentKeys(api.PROGRESS_GROUPS), ["train", "program", "fuel", "body"]);
  assert.deepEqual(segmentLabels(api.PROGRESS_GROUPS), ["Train", "Program", "Intake", "Body"]);
  assert.equal(api.progressGroupOf("sessions"), "train");
  assert.equal(api.progressGroupOf("program"), "program");
  assert.equal(api.progressGroupOf("plan"), "program");
  assert.equal(api.progressGroupOf("energy"), "fuel");
  assert.equal(api.progressGroupOf("intake"), "fuel");
  assert.equal(api.progressGroupOf("weight"), "body");
  for (const leaf of ["week", "program", "intake", "weight"]) assert.equal(api.progressIsLanding(leaf), true, leaf);
  // The old landing, the overview, is Train's Progress leaf now (its URL unchanged).
  assert.equal(api.progressGroupOf("overview"), "train");
  for (const leaf of ["overview", "sessions", "trend", "volume", "calendar", "endurance", "plan", "energy", "measurements"]) {
    assert.equal(api.progressIsLanding(leaf), false, leaf);
  }

  // A landing: the group bar, and never a second row of tabs.
  api.setDiscipline("strength");
  const weekNav = controller.segBar("week", PROGRESS_SEG);
  assert.match(weekNav, /data-proggroup="train"[^>]*aria-pressed="true"/);
  assert.match(weekNav, /data-train-landing="week"/);
  assert.doesNotMatch(weekNav, /data-seg=|prog-subwrap/);
  // Progress (the overview) is one tap deeper, with its step back to This week.
  assert.match(controller.segBar("overview", PROGRESS_SEG), /class="home-back linkbtn linkbtn-plain train-crumb"[^>]*data-train-leaf="week">‹ Train</);

  // A deeper leaf: no bar at all, one step back to its landing.
  const volumeNav = controller.segBar("volume", PROGRESS_SEG);
  assert.doesNotMatch(volumeNav, /data-proggroup|data-seg=/);
  assert.match(volumeNav, /class="home-back linkbtn linkbtn-plain train-crumb"[^>]*data-train-leaf="week">‹ Train</);
  assert.match(controller.segBar("energy", PROGRESS_SEG), /data-train-leaf="intake">‹ Intake</);
  assert.match(controller.segBar("measurements", PROGRESS_SEG), /data-train-leaf="weight">‹ Body</);
  // The editor paints the same nav: one step back to the Program read.
  assert.match(controller.segBar("plan", PROGRESS_SEG), /data-train-leaf="program">‹ Program</);

  // Each landing lists every deeper leaf of its group as a row, one tap away;
  // Endurance only for an athlete who runs.
  const trainRows = api.progressDeeperHtml("week");
  for (const leaf of ["overview", "sessions", "trend", "volume", "calendar"]) assert.match(trainRows, new RegExp(`data-train-leaf="${leaf}"`));
  assert.ok(trainRows.indexOf('data-train-leaf="overview"') < trainRows.indexOf('data-train-leaf="sessions"'), "Progress is the first row");
  assert.match(trainRows, />Progress</);
  assert.doesNotMatch(trainRows, /data-train-leaf="endurance"/);
  assert.match(api.progressDeeperHtml("program"), /data-train-leaf="plan"/);
  assert.match(api.progressDeeperHtml("intake"), /data-train-leaf="energy"/);
  assert.match(api.progressDeeperHtml("intake"), /More in Intake/);
  assert.match(api.progressDeeperHtml("weight"), /data-train-leaf="measurements"/);
  assert.equal(api.progressDeeperHtml("volume"), "");

  // A non-Progress seg-set is untouched (still the flat sliding bar).
  assert.equal(controller.segBar("trend", [["trend", "1RM"]]), `<seg data-active="trend" data-items="1"></seg>`);
});

test("wireSeg lays a landing's deeper rows once and wires rows and the step back", async () => {
  const context = loadSegments();
  const inserted = [];
  const historyRow = {
    dataset: { trainLeaf: "sessions" },
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    closest() {
      return null;
    },
  };
  let laid = false;
  const view = {
    querySelector(selector) {
      if (selector === "[data-train-landing]") return { dataset: { trainLanding: "week" } };
      if (selector === ".train-deeper") return laid ? {} : null;
      return null;
    },
    insertAdjacentHTML(where, html) {
      inserted.push([where, html]);
      laid = true;
    },
    querySelectorAll(selector) {
      return selector === "[data-train-leaf]" ? [historyRow] : [];
    },
  };
  const { calls, controller } = createController(context, { view });
  controller.wireSeg(controller.progressHandlers);
  controller.wireSeg(controller.progressHandlers);
  assert.equal(inserted.length, 1, "a repaint that kept the rows never doubles them");
  assert.equal(inserted[0][0], "beforeend");
  assert.match(inserted[0][1], /class="train-deeper"/);

  historyRow.listeners.click();
  await flush();
  assert.ok(calls.some((call) => call[0] === "renderHistory"));
  assert.ok(calls.some((call) => call[0] === "syncRouteFromState"));
});

test("A scrolling segmented rail fades the edge that still has more behind it", () => {
  assert.match(styles, /\.seg\.seg-scroll\.seg-fade-l\{--seg-fl:28px\}/);
  assert.match(styles, /\.seg\.seg-scroll\.seg-fade-r\{--seg-fr:28px\}/);
  assert.doesNotMatch(styles, /prog-subseg/, "Train's leaf sub-bar is gone");
});

test("Progress endurance leaf appears for an endurance athlete or when it's active", () => {
  const context = loadSegments();
  const { controller } = createController(context);
  const PROGRESS_SEG = context.CairnUiSegments.PROGRESS_SEG;

  context.CairnUiSegments.setDiscipline("endurance");
  assert.match(context.CairnUiSegments.progressDeeperHtml("week"), /data-train-leaf="endurance"/);
  // A deep link to Endurance always has its way back to Train's landing.
  context.CairnUiSegments.setDiscipline("strength");
  assert.match(controller.segBar("endurance", PROGRESS_SEG), /data-train-leaf="week">‹ Train</);
});

test("Progress top-group buttons route to the group's default leaf", async () => {
  const context = loadSegments();
  const groupBtn = {
    classList: classList(),
    dataset: { proggroup: "program" },
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    closest() {
      return seg;
    },
  };
  const seg = {
    style: { setProperty() {} },
    querySelectorAll() {
      return [groupBtn];
    },
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

  assert.ok(
    calls.some((call) => call[0] === "renderProgram"),
    "the Program group opens the Program read, staying in the view it was tapped from"
  );
  assert.ok(calls.some((call) => call[0] === "syncRouteFromState"));
});

test("Train's Intake group carries a primary Log a meal button and composer slot under the header", () => {
  const context = loadSegments();
  const { controller } = createController(context);
  const PROGRESS_SEG = context.CairnUiSegments.PROGRESS_SEG;
  for (const leaf of ["intake", "energy"]) {
    const html = controller.segBar(leaf, PROGRESS_SEG);
    assert.match(html, /<button class="btn btn-solid train-fuel-log-btn" type="button" data-intake-log-btn aria-expanded="false" aria-controls="intakeLogSlot">Log a meal<\/button>/, leaf);
    assert.match(html, /id="intakeLogSlot" class="train-fuel-log-slot" data-intake-log-slot/, leaf);
    assert.doesNotMatch(html, /Log food on Today's Fuel|train-fuel-link/, leaf);
  }
  for (const leaf of ["week", "overview", "sessions", "program", "weight"]) {
    assert.doesNotMatch(controller.segBar(leaf, PROGRESS_SEG), /data-intake-log-btn/, leaf);
  }
});

test("Train lands on This week; the overview's route is the Progress leaf", async () => {
  const context = loadSegments();
  const { calls, controller } = createController(context);
  const keys = segmentKeys(context.CairnUiSegments.PROGRESS_SEG);
  assert.deepEqual(keys.slice(0, 2), ["week", "overview"]);
  assert.deepEqual(segmentLabels(context.CairnUiSegments.PROGRESS_SEG).slice(0, 2), ["This week", "Progress"]);
  await controller.progressHandlers.week();
  await controller.progressHandlers.overview();
  assert.deepEqual(
    calls.filter((call) => /^renderTrain/.test(call[0])).map((call) => call[0]),
    ["renderTrainWeek", "renderTrainOverview"]
  );
});
