import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function compileClientSource(file) {
  const source = readFileSync(join(root, file), "utf8");
  return ts.transpileModule(source, {
    compilerOptions: {
      alwaysStrict: false,
      ignoreDeprecations: "6.0",
      module: ts.ModuleKind.None,
      moduleDetection: ts.ModuleDetectionKind.Legacy,
      removeComments: false,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
    reportDiagnostics: true,
  }).outputText;
}

function loadDependencies() {
  const context = {
    Object,
    Number,
    Math,
    String,
    document: {
      querySelector() {
        throw new Error("dependency factories should receive explicit selectors/helpers");
      },
    },
    CairnFoodNote: {
      noteEntryHtml(note, index) {
        return `note:${index}:${note.title}`;
      },
    },
    CairnHealthPictureController: {
      isHealthReviewRunning() {
        return true;
      },
    },
  };
  context.window = context;
  for (const file of [
    "src/client/me-health-controller-deps.ts",
    "src/client/me-health-dependencies.ts",
  ]) {
    vm.runInNewContext(compileClientSource(file), context, { filename: file });
  }
  return context;
}

function elementMap(values) {
  return {
    querySelector(selector) {
      return values[selector] ?? null;
    },
  };
}

function makeContextInput(overrides = {}) {
  const rootNode = elementMap({
    "#name": { value: "Alex" },
    "#age": { value: "42" },
    "#empty": { value: "" },
    "#about": { value: "Long-term health" },
  });
  return {
    root: rootNode,
    state: { healthSeg: "read", meSeg: "health" },
    segments: [["standing", "Standing"]],
    handlers: { standing() {} },
    document: { body: "doc" },
    headerTitle: { textContent: "" },
    api: async () => ({ ok: true }),
    cachedApi: async () => ({ ok: true }),
    peekCached: () => null,
    markRefreshing() {},
    swrInvalidate() {},
    runOp: async () => ({ ok: true }),
    toast() {},
    armDelete() {},
    activateTab(tab) { return tab; },
    escapeAttr(value) { return String(value ?? ""); },
    escapeHtml(value) { return String(value ?? ""); },
    invalidatePoll() {},
    mountSaveBar() { return { destroy() {} }; },
    primaryDiscipline() { return "hybrid"; },
    renderMe() {},
    renderProfile() {},
    segBar() { return "<nav></nav>"; },
    segSkeleton() { return "<div></div>"; },
    setDiscipline(value) { return String(value ?? ""); },
    setEnduranceGoalSet() {},
    skeletonSwap(fn) { return fn(); },
    wireSeg() {},
    fitSeg() {},
    syncRouteFromState() {},
    withViewTransition(fn) { return fn(); },
    select(selector) { return rootNode.querySelector(selector); },
    relTime(iso) { return `rel:${iso}`; },
    relAge(iso) { return `age:${iso ?? ""}`; },
    stagger(index) { return `--i:${index ?? 0}`; },
    reducedMotion() { return false; },
    pollToken() { return 7; },
    switchHealthSeg(seg) { return seg; },
    onHealthReadView() { return true; },
    loadHealthPicture: async () => {},
    paintHealthPicture() {},
    healthDocsKnownEmpty() { return false; },
    paintRead() {},
    paintMarkers() {},
    paintRecords() {},
    paintShare() {},
    paintLearned() {},
    activityEntryHtml(activity) { return `activity:${activity.name}`; },
    openFoodDetail(note) { return note; },
    loadDexaTargeting() {},
    storage: null,
    ...overrides,
  };
}

test("Me Health public dependency API delegates controller factories without API drift", () => {
  const context = loadDependencies();
  const api = context.CairnMeHealthDependencies;
  const input = makeContextInput();
  const depsContext = api.context(input);

  assert.deepEqual(Object.keys(api).sort(), [
    "context",
    "inputValue",
    "log",
    "markers",
    "memory",
    "numberValue",
    "picture",
    "profile",
    "read",
    "standing",
    "tabs",
    "textAreaValue",
  ].sort());
  assert.equal(context.CairnMeHealthControllerDeps, context.window.CairnMeHealthControllerDeps);
  assert.equal(depsContext.root, input.root);
  assert.equal(depsContext.state, input.state);

  const profile = api.profile(depsContext);
  assert.equal(profile.inputValue("#name", input.root), "Alex");
  assert.equal(profile.numberValue("#age", input.root), 42);
  assert.equal(profile.numberValue("#empty", input.root), null);
  assert.equal(profile.textAreaValue("#about", input.root), "Long-term health");
  assert.equal(profile.select("#name"), input.root.querySelector("#name"));

  const log = api.log(depsContext);
  assert.equal(log.noteEntryHtml({ title: "breakfast" }, 3), "note:3:breakfast");
  assert.equal(log.activityEntryHtml({ name: "run" }), "activity:run");
});

test("Me Health read dependency factory owns spy teardown lifecycle", () => {
  const context = loadDependencies();
  const depsContext = context.CairnMeHealthDependencies.context(makeContextInput());
  const read = context.CairnMeHealthDependencies.read(depsContext);

  let disconnected = 0;
  read.setReadSpy({ disconnect() { disconnected += 1; } });
  assert.equal(read.isHealthReviewRunning(), true);

  read.teardownReadSpy();
  read.teardownReadSpy();
  assert.equal(disconnected, 1);
});

test("Me Health controller factory accepts explicit selector helpers", () => {
  const context = loadDependencies();
  const depsContext = context.CairnMeHealthDependencies.context(makeContextInput());
  const profile = context.CairnMeHealthControllerDeps.profile(depsContext, {
    inputValue: () => "manual",
    numberValue: () => 12,
    textAreaValue: () => "explicit",
  });

  assert.equal(profile.inputValue("#name"), "manual");
  assert.equal(profile.numberValue("#age"), 12);
  assert.equal(profile.textAreaValue("#about"), "explicit");
});
