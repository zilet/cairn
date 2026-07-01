import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class FakeElement {
  constructor() {
    this.innerHTML = "";
    this.textContent = "";
  }

  querySelector() {
    return null;
  }
}

class FakeView extends FakeElement {
  set innerHTML(value) {
    this.html = value;
    this.endBody = value.includes('id="endBody"') ? new FakeElement() : null;
  }

  get innerHTML() {
    return this.html || "";
  }

  querySelector(selector) {
    return selector === "#endBody" ? this.endBody : null;
  }
}

function loadProgressEnduranceController() {
  const context = {
    Object,
    window: {},
    enduranceGoalCard: () => "",
    runComplianceLine: () => "",
    weeklyRunPlanCard: () => "",
    enduranceCoachLine: () => "",
    cardioSyncLine: undefined,
    wireCardioSync: undefined,
    fmtKm: (value) => String(value),
    fmtPaceKm: (value) => String(value),
    escHtml: (value) => String(value ?? "").replace(/[&<>]/g, ""),
    stagger: (index) => `--i:${index}`,
    paceTrendWord: () => "",
    zoneBarHtml: () => "",
    enduranceBestRows: () => [],
    enduranceSportCardHtml: () => "",
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/progress-endurance-controller.js"), "utf8"), context);
  return context.CairnProgressEnduranceController;
}

function controllerDeps(overrides = {}) {
  const apiCalls = [];
  let token = 0;
  const view = new FakeView();
  const deps = {
    view,
    headerTitle: { textContent: "" },
    state: { tab: "progress", progressSeg: "sessions" },
    api: async (path) => {
      apiCalls.push(path);
      if (path === "/stats") return { endurance: null };
      if (path === "/endurance-prs") return { sports: [], longest_km: null, longest_min: null, best_pace: [] };
      if (path === "/settings") return { settings: {} };
      return null;
    },
    nextToken: () => {
      token += 1;
      return token;
    },
    isCurrent: (value) => value === token,
    segmentHtml: (active) => `seg:${active}`,
    wireSegments: () => {
      deps.wired = (deps.wired || 0) + 1;
    },
    loading: (message) => `loading:${message}`,
    empty: (image, message) => `empty:${image}:${message}`,
    hero: (title, stats) => `hero:${title}:${stats.length}`,
    art: (kind, label) => `art:${kind}:${label}`,
    runCountUps: () => {
      deps.counted = true;
    },
    renderSelf: () => {
      deps.renderedSelf = true;
    },
    ...overrides,
  };
  return { deps, apiCalls, view };
}

test("progress endurance controller fans out reads and paints the empty endurance state", async () => {
  const controller = loadProgressEnduranceController();
  const { deps, apiCalls, view } = controllerDeps();

  await controller.render(deps);

  assert.equal(deps.headerTitle.textContent, "Progress");
  assert.equal(deps.state.progressSeg, "endurance");
  assert.equal(deps.wired, 1);
  assert.deepEqual(apiCalls, ["/stats", "/endurance-prs", "/endurance-goal", "/run-compliance", "/settings", "/run-plan"]);
  assert.match(view.querySelector("#endBody").innerHTML, /hero:Endurance:0/);
  assert.match(view.querySelector("#endBody").innerHTML, /No runs or rides logged yet/);
});

test("progress endurance controller keeps stale reads from repainting", async () => {
  const controller = loadProgressEnduranceController();
  const { deps, view } = controllerDeps({ isCurrent: () => false });

  await controller.render(deps);

  assert.equal(view.querySelector("#endBody").innerHTML, "");
});
