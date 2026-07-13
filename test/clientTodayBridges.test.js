import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

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

function loadBridge() {
  const calls = [];
  const depCalls = [];
  const requests = [];
  let dependencyFactoryCalls = 0;
  const sentinels = {
    brief: { kind: "brief-deps" },
    sessionSuggest: { kind: "session-suggest-deps" },
    session: { kind: "session-deps" },
    progression: { kind: "progression-deps" },
    addExercise: { kind: "add-exercise-deps" },
    sideLoaders: { kind: "side-loader-deps" },
  };
  const deps = {
    brief: () => { depCalls.push("brief"); return sentinels.brief; },
    sessionSuggest: () => { depCalls.push("sessionSuggest"); return sentinels.sessionSuggest; },
    session: () => { depCalls.push("session"); return sentinels.session; },
    progression: () => { depCalls.push("progression"); return sentinels.progression; },
    addExercise: () => { depCalls.push("addExercise"); return sentinels.addExercise; },
    sideLoaders: () => { depCalls.push("sideLoaders"); return sentinels.sideLoaders; },
  };

  const context = {
    Object,
    Promise,
    JSON,
    globalThis: null,
    window: null,
    CairnTodaySessionSuggestController: {
      reconnectSessionSuggest: (job, bridgeDeps) => {
        calls.push({ kind: "reconnectSessionSuggest", job, deps: bridgeDeps });
        return { reconnected: true };
      },
      revealSessionComposer: (bridgeDeps) => {
        calls.push({ kind: "revealSessionComposer", deps: bridgeDeps });
      },
      askForSession: async (opts, bridgeDeps) => {
        calls.push({ kind: "askForSession", opts, deps: bridgeDeps });
      },
    },
    CairnTodaySessionStatus: {
      sessionDoneCardHtml: (session, day, options) => {
        calls.push({ kind: "sessionDoneCardHtml", session, day, options });
        return `done:${options.isToday}`;
      },
    },
    CairnTodaySessionController: {
      wireLogRow: (row, bridgeDeps) => {
        calls.push({ kind: "wireLogRow", row, deps: bridgeDeps });
      },
      wireSkips: (bridgeDeps) => {
        calls.push({ kind: "wireSkips", deps: bridgeDeps });
      },
    },
    CairnTodayBriefController: {
      wireBrief: (read, options, bridgeDeps) => {
        calls.push({ kind: "wireBrief", read, options, deps: bridgeDeps });
      },
      reconnectDayReadOverride: (job, bridgeDeps) => {
        calls.push({ kind: "reconnectDayReadOverride", job, deps: bridgeDeps });
        return { override: true };
      },
    },
    CairnTodayProgressionController: {
      scheduleRxRefresh: (bridgeDeps) => {
        calls.push({ kind: "scheduleRxRefresh", deps: bridgeDeps });
      },
      invalidateTodayProgression: (bridgeDeps) => {
        calls.push({ kind: "invalidateTodayProgression", deps: bridgeDeps });
      },
      refreshAdaptedRx: async (bridgeDeps) => {
        calls.push({ kind: "refreshAdaptedRx", deps: bridgeDeps });
      },
    },
    CairnTodayAddExerciseController: {
      setupAddExercise: async (bridgeDeps) => {
        calls.push({ kind: "setupAddExercise", deps: bridgeDeps });
      },
      appendOffPlanCard: async (name, mode, bridgeDeps) => {
        calls.push({ kind: "appendOffPlanCard", name, mode, deps: bridgeDeps });
      },
    },
    CairnTodaySideLoaders: {
      garminSessionCard: (value) => {
        calls.push({ kind: "garminSessionCard", value });
        return "garmin-card";
      },
      loadWearable: async (isToday, bridgeDeps) => {
        calls.push({ kind: "loadWearable", isToday, deps: bridgeDeps });
      },
      loadTableHint: async (bridgeDeps) => {
        calls.push({ kind: "loadTableHint", deps: bridgeDeps });
      },
      loadContextBanner: async (bridgeDeps) => {
        calls.push({ kind: "loadContextBanner", deps: bridgeDeps });
      },
      loadHealthFocusBanner: async (bridgeDeps) => {
        calls.push({ kind: "loadHealthFocusBanner", deps: bridgeDeps });
      },
    },
  };
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(`(() => {\n${compileClientSource("src/client/today-compatibility-bridges.ts").trimEnd()}\n})();\n`, context);

  const bridge = context.CairnTodayCompatibilityBridges.create({
    api: async (path, opts) => {
      requests.push({ path, opts });
      return { ok: true };
    },
    dependencies: () => {
      dependencyFactoryCalls += 1;
      return deps;
    },
  });

  return {
    bridge,
    calls,
    depCalls,
    requests,
    sentinels,
    dependencyFactoryCalls: () => dependencyFactoryCalls,
    context,
  };
}

test("Today compatibility bridge exports a namespace without resolving deps eagerly", () => {
  const harness = loadBridge();

  assert.equal(harness.context.CairnTodayCompatibilityBridges, harness.context.window.CairnTodayCompatibilityBridges);
  assert.equal(harness.dependencyFactoryCalls(), 0);
});

test("Today compatibility bridge routes legacy wrappers through explicit deps", async () => {
  const harness = loadBridge();
  const job = { id: "job_1" };

  await harness.bridge.postExerciseMode("Dead hang", "timed");
  assert.deepEqual(plain(harness.requests), [{
    path: "/exercises",
    opts: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Dead hang", mode: "timed" }),
    },
  }]);
  assert.equal(harness.dependencyFactoryCalls(), 0);

  assert.deepEqual(harness.bridge.reconnectSessionSuggest(job), { reconnected: true });
  harness.bridge.revealSessionComposer();
  await harness.bridge.askForSession({ minutes: 25, focus: "upper" });
  assert.equal(harness.bridge.sessionDoneCard({ id: 1 }, { name: "Upper" }, { isToday: true }), "done:true");
  harness.bridge.wireLogRow({ row: true });
  harness.bridge.wireSkips();
  harness.bridge.wireBrief({ kind: "easy" }, { isToday: false });
  assert.deepEqual(harness.bridge.reconnectDayReadOverride(job), { override: true });
  harness.bridge.scheduleRxRefresh();
  harness.bridge.invalidateTodayProgression();
  await harness.bridge.refreshAdaptedRx();
  await harness.bridge.setupAddExercise();
  await harness.bridge.appendOffPlanCard("Carry", "timed");
  assert.equal(harness.bridge.garminSessionCard({ distance: 5 }), "garmin-card");
  await harness.bridge.loadWearable(true);
  await harness.bridge.loadTableHint();
  await harness.bridge.loadContextBanner();
  await harness.bridge.loadHealthFocusBanner();

  assert.deepEqual(harness.calls.map((call) => call.kind), [
    "reconnectSessionSuggest",
    "revealSessionComposer",
    "askForSession",
    "sessionDoneCardHtml",
    "wireLogRow",
    "wireSkips",
    "wireBrief",
    "reconnectDayReadOverride",
    "scheduleRxRefresh",
    "invalidateTodayProgression",
    "refreshAdaptedRx",
    "setupAddExercise",
    "appendOffPlanCard",
    "garminSessionCard",
    "loadWearable",
    "loadTableHint",
    "loadContextBanner",
    "loadHealthFocusBanner",
  ]);
  assert.deepEqual(harness.depCalls, [
    "sessionSuggest",
    "sessionSuggest",
    "sessionSuggest",
    "session",
    "session",
    "brief",
    "brief",
    "progression",
    "progression",
    "progression",
    "addExercise",
    "addExercise",
    "sideLoaders",
    "sideLoaders",
    "sideLoaders",
    "sideLoaders",
  ]);
  assert.equal(harness.calls[0].deps, harness.sentinels.sessionSuggest);
  assert.equal(harness.calls[4].deps, harness.sentinels.session);
  assert.equal(harness.calls[6].deps, harness.sentinels.brief);
  assert.equal(harness.calls[8].deps, harness.sentinels.progression);
  assert.equal(harness.calls[11].deps, harness.sentinels.addExercise);
  assert.equal(harness.calls[14].deps, harness.sentinels.sideLoaders);
});

test("Today screen delegates bridge functions while keeping legacy globals", () => {
  const source = readFileSync(join(root, "src/client/today-screen.ts"), "utf8");
  const runtimeSource = readFileSync(join(root, "src/client/today-screen-runtime.ts"), "utf8");
  const runtimeDepsSource = readFileSync(join(root, "src/client/today-screen-runtime-deps.ts"), "utf8");

  assert.match(source, /CairnTodayScreenRuntime\.create\(\{/);
  assert.match(runtimeSource, /CairnTodayCompatibilityBridges\.create\(\{\s*api: todayScreenRuntimeApi,\s*dependencies: deps,\s*\}\)/);
  assert.match(runtimeSource, /CairnTodayScreenRuntimeDeps\.create\(\{/);
  assert.match(runtimeDepsSource, /CairnTodayDependencies\.context\(\{/);
  assert.match(
    source,
    /Object\.assign\(globalThis,\s*\{[\s\S]*postExerciseMode[\s\S]*reconnectDayReadOverride[\s\S]*reconnectSessionSuggest[\s\S]*renderToday[\s\S]*reshapeToday[\s\S]*\}\)/,
  );
  assert.doesNotMatch(source, /function\s+(wireBrief|scheduleRxRefresh|setupAddExercise|loadWearable)\(/);
  assert.doesNotMatch(source, /CairnTodayBriefController\.reconnectDayReadOverride/);
  assert.doesNotMatch(source, /CairnTodaySessionSuggestController\.reconnectSessionSuggest/);
});
