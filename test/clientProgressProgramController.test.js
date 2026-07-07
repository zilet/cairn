import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fakeElement(tag = "div") {
  return {
    tag,
    className: "",
    removed: false,
    children: [],
    style: {},
    isConnected: true,
    remove() {
      this.removed = true;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    querySelector() {
      return null;
    },
  };
}

function fakeButton() {
  return {
    listeners: {},
    parentElement: null,
    closest() {
      return null;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
  };
}

function loadProgramController() {
  const calls = [];
  const context = {
    Array,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    String,
    document: {
      createElement: fakeElement,
      querySelector() {
        return null;
      },
      getElementById() {
        return null;
      },
    },
    calls,
    stagger(index) {
      return `--i:${index}`;
    },
    enduranceBlockHtml(endurance, index) {
      return `<div class="endurance" data-i="${index}">${String(endurance?.headline || "")}</div>`;
    },
    hybridLoadCardHtml(hybrid, index) {
      return `<div class="hybrid" data-i="${index}">${String(hybrid?.headline || "")}</div>`;
    },
    loadPerformance() {
      calls.push("performance");
    },
    loadProgramBlock() {
      calls.push("block");
    },
    loadProgramAdjustments() {
      calls.push("adjustments");
    },
    loadTestWeek() {
      calls.push("test-week");
    },
    loadMuscleTrajectory() {
      calls.push("muscle");
    },
    loadDexaTargeting(slot) {
      calls.push(`dexa:${slot}`);
    },
    coachingFocusCardHtml(focus) {
      return focus?.show ? `<section class="focus-card">FOCUS CARD</section>` : "";
    },
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/format-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-program-summary-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-program-controller.js"), "utf8"), context);
  return context;
}

function depsFor(_context, overrides = {}) {
  const view = overrides.view || {
    innerHTML: "",
    querySelector() {
      return null;
    },
  };
  const invalidated = [];
  const toasts = [];
  const busyCalls = [];
  const deps = {
    view,
    headerTitle: { textContent: "" },
    state: { tab: "progress", progressSeg: "sessions" },
    api: async () => ({}),
    runOp: async () => undefined,
    nextToken: () => 1,
    isCurrent: () => true,
    peekCached: () => null,
    paintSWR: async () => undefined,
    segmentHtml: (active) => `<nav>${active}</nav>`,
    skeletonHtml: (active, cards) => `<div class="skeleton">${active}:${cards}</div>`,
    wireSegments: () => {
      deps.wired = true;
    },
    hero: (title, stats) => `<section class="hero">${title}:${stats.map((row) => row[0]).join("|")}</section>`,
    empty: (_image, message) => `<div class="empty">${message}</div>`,
    art: (kind, label) => `${kind}:${label}`,
    busy: (_btn, text) => {
      busyCalls.push(text);
      return () => busyCalls.push("restore");
    },
    toast: (message) => {
      toasts.push(message);
    },
    invalidate: (key) => {
      invalidated.push(key);
    },
    runCountUps: () => {
      deps.countUps = true;
    },
    renderSelf: () => {
      deps.renderedSelf = true;
    },
    wired: false,
    countUps: false,
    renderedSelf: false,
    invalidated,
    toasts,
    busyCalls,
    ...overrides,
  };
  return deps;
}

const programState = {
  headline: "Keep pressure on the main lift <safely>",
  lifts: [
    { exercise: "Bench <press>", status: "progressing", est_1rm: 185, trend_per_wk: 2.5, why: "Top set moved well" },
    { exercise: "Deadlift", status: "plateaued", weeks_static: 2, est_1rm: 315, trend_per_wk: 0, why: "Stalled twice" },
  ],
  volume: [{ muscle_group: "Chest", weekly_sets: 12, band: "productive", trend: "rising" }],
  mesocycle: { phase: "intensification", weeks_since_deload: 4, note: "One hard week left" },
  endurance: { headline: "Keep the easy base" },
  adaptations_due: ["Add carries <grip>"],
};

test("progress program controller renders the empty state through the route shell", () => {
  const context = loadProgramController();
  const deps = depsFor(context);

  context.CairnProgressProgramController.paint(
    { headline: "", lifts: [], volume: [], mesocycle: null, endurance: null, adaptations_due: [] },
    deps,
  );

  assert.match(deps.view.innerHTML, /<nav>program<\/nav>/);
  assert.match(deps.view.innerHTML, /Not enough data yet/);
  assert.equal(deps.wired, true);
  assert.deepEqual(context.calls, []);
});

test("progress program controller paints stacked program read and wires actions", () => {
  const context = loadProgramController();
  const evolve = fakeButton();
  const tidy = fakeButton();
  const deps = depsFor(context, {
    view: {
      innerHTML: "",
      querySelector(selector) {
        if (selector === "#progEvolveBtn") return evolve;
        if (selector === "#progTidyBtn") return tidy;
        return null;
      },
    },
  });

  context.CairnProgressProgramController.paint(programState, deps);

  assert.match(deps.view.innerHTML, /Keep pressure on the main lift &lt;safely&gt;/);
  assert.match(deps.view.innerHTML, /Bench &lt;press&gt;/);
  assert.match(deps.view.innerHTML, /Weekly volume by muscle/);
  assert.match(deps.view.innerHTML, /Add carries &lt;grip&gt;/);
  assert.doesNotMatch(deps.view.innerHTML, /<safely>|<press>|<grip>|The full read/);
  assert.equal(typeof evolve.listeners.click, "function");
  assert.equal(typeof tidy.listeners.click, "function");
  assert.deepEqual(context.calls, ["performance", "block", "adjustments", "test-week", "muscle", "dexa:progDexaSlot"]);
});

test("progress program controller repaints with the conductor when focus arrives", async () => {
  const context = loadProgramController();
  const deps = depsFor(context, {
    api: async (path) => {
      assert.equal(path, "/coaching-focus");
      return { show: true };
    },
    nextToken: () => 7,
    isCurrent: (token) => token === 7,
    peekCached: () => ({ data: programState, fresh: true }),
    paintSWR: async (options) => {
      options.render(programState, { warm: true });
      return programState;
    },
  });

  await context.CairnProgressProgramController.render(deps);
  await Promise.resolve();

  assert.equal(deps.headerTitle.textContent, "Program");
  assert.equal(deps.state.progressSeg, "program");
  assert.match(deps.view.innerHTML, /FOCUS CARD/);
  assert.match(deps.view.innerHTML, /<summary>The full read<\/summary>/);
  assert.ok(deps.view.innerHTML.indexOf("Bench &lt;press&gt;") < deps.view.innerHTML.indexOf("The full read"));
});

test("progress program controller tidies exercise names and refreshes on merge", async () => {
  const context = loadProgramController();
  const deps = depsFor(context, {
    api: async (path, options) => {
      assert.equal(path, "/exercises/reconcile-names");
      assert.equal(options.method, "POST");
      return { ok: true, aligned: 2 };
    },
  });

  await context.CairnProgressProgramController.tidyExerciseNames(fakeButton(), deps);

  assert.deepEqual(deps.busyCalls, ["tidying…", "restore"]);
  assert.deepEqual(deps.toasts, ["Tidied 2 exercise names"]);
  assert.deepEqual(deps.invalidated, ["progress:program"]);
  assert.equal(deps.renderedSelf, true);
});

test("progress program controller drafts evolved plans through runOp", async () => {
  const context = loadProgramController();
  const foot = fakeElement("div");
  const button = fakeButton();
  button.closest = (selector) => selector === ".prog-evolve-foot" ? foot : null;
  const deps = depsFor(context, {
    runOp: async (kind, body, options) => {
      assert.equal(kind, "evolve_program");
      assert.equal(JSON.stringify(body), "{}");
      assert.equal(options.path, "/program/evolve");
      assert.equal(options.anchor, ".prog-evolve-foot");
      options.render({});
    },
  });

  await context.CairnProgressProgramController.triggerProgramEvolve(button, deps);

  assert.deepEqual(deps.busyCalls, ["Drafting your plan…", "restore"]);
  assert.deepEqual(deps.toasts, ["Drafted — review it in your Plan"]);
  assert.deepEqual(deps.invalidated, ["progress:program", "plan:coach", "plan:proposals"]);
  assert.equal(deps.renderedSelf, true);
});
