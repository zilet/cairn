import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadPlanEnduranceClient() {
  const context = {
    Array,
    Object,
    String,
    runTargetText: (run) => `${run.target_distance_km || 0} km @ ${run.target_zone || "easy"}`,
    stagger: (index) => `--i:${index}`,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-model.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-client.js"), "utf8"), context);
  return context.CairnPlanEndurance;
}

// A minimal fake element good enough to drive paintPlanEndurance(): innerHTML
// stores/returns the painted string, querySelector/querySelectorAll are inert
// (the module's post-paint wiring null-checks or forEach()s over them).
class FakePaintElement {
  constructor() {
    this._html = "";
  }

  set innerHTML(value) {
    this._html = value;
  }

  get innerHTML() {
    return this._html;
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }
}

// Loads the real module (model + client) plus every other global
// paintPlanEndurance touches, so `paintPlanEndurance` can be invoked directly
// against a fake #endPlanBody and its painted HTML inspected.
function loadPlanEnduranceForPaint({ raceBuildCard } = {}) {
  const body = new FakePaintElement();
  const view = { querySelector: (selector) => (selector === "#endPlanBody" ? body : null) };
  const context = {
    Array,
    Object,
    String,
    Number,
    view,
    stagger: (index) => `--i:${index}`,
    humanDate: (iso) => String(iso || ""),
    cardioLabel: (item) => String(item?.label || "Run"),
    cardioPrescription: (item) => String(item?.target_distance_km ? `${item.target_distance_km} km` : ""),
    fmtKm: (km) => String(km),
    enduranceGoalCard: (goal) => `<div class="end-goal">${String(goal?.event || "")}</div>`,
    trainingAgendaCard: () => "",
    runComplianceLine: () => "",
    cardioSyncLine: undefined,
    wireCardioSync: undefined,
    loadPlanUpcomingNote: undefined,
    ...(raceBuildCard !== undefined ? { raceBuildCard } : {}),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/html-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-model.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-endurance-client.js"), "utf8"), context);
  return { context, body };
}

const RACE_GOAL = { mode: "race", phase: "build", event: "Fall 10K", weeks_to_race: 4 };

test("plan endurance paints the race build card and drops the generic ramp when a build is available", () => {
  const calls = [];
  const { context, body } = loadPlanEnduranceForPaint({
    raceBuildCard: (build, opts) => {
      calls.push(opts);
      return build?.available !== false && build?.race ? '<div data-race-build class="wrun-card rbuild"></div>' : "";
    },
  });

  context.paintPlanEndurance(RACE_GOAL, null, null, [], {}, { available: true, race: { weeks_to_race: 4, phase: "build" } });

  assert.match(body.innerHTML, /data-race-build/);
  assert.doesNotMatch(body.innerHTML, /class="end-ramp reveal"/);
  // The goal card directly above this one already states the countdown +
  // phase — Plan must ask for the card's short head, not the full one.
  // The stub records opts born in the module's own realm, so compare by value.
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.underGoal, true);
});

test("plan endurance keeps today's ramp when the race build is unavailable or the fetch failed", () => {
  const { context, body } = loadPlanEnduranceForPaint({
    raceBuildCard: (build) => (build?.available !== false && build?.race ? '<div data-race-build></div>' : ""),
  });

  context.paintPlanEndurance(RACE_GOAL, null, null, [], {}, { available: false });

  assert.doesNotMatch(body.innerHTML, /data-race-build/);
  assert.match(body.innerHTML, /class="end-ramp reveal"/);
});

test("plan endurance keeps today's ramp when the race-build fetch rejected (raceBuild is null)", () => {
  const { context, body } = loadPlanEnduranceForPaint({
    raceBuildCard: (build) => (build?.available !== false && build?.race ? '<div data-race-build></div>' : ""),
  });

  context.paintPlanEndurance(RACE_GOAL, null, null, [], {}, null);

  assert.doesNotMatch(body.innerHTML, /data-race-build/);
  assert.match(body.innerHTML, /class="end-ramp reveal"/);
});

test("plan endurance never crashes when raceBuildCard is not yet loaded (a different bundle)", () => {
  // raceBuildCard is defined in progress-run-plan-client.ts, a different
  // bundle — plan-endurance-client.ts must guard with typeof, never assume
  // the global exists.
  const { context, body } = loadPlanEnduranceForPaint();

  context.paintPlanEndurance(RACE_GOAL, null, null, [], {}, { available: true, race: { weeks_to_race: 4, phase: "build" } });

  assert.doesNotMatch(body.innerHTML, /data-race-build/);
  assert.match(body.innerHTML, /class="end-ramp reveal"/);
});

test("plan endurance helper renders the current race phase ramp", () => {
  const endurance = loadPlanEnduranceClient();

  assert.equal(endurance.rampHtml({ mode: "standing", phase: "build" }), "");
  const html = endurance.rampHtml({ mode: "race", phase: "build" });
  assert.match(html, /The ramp to race day/);
  assert.match(html, /class="ramp-step is-done"/);
  assert.match(html, /class="ramp-step is-current"/);
  assert.match(html, /You're here/);
  assert.match(html, /--i:1/);
});

test("plan endurance helper chooses race and standing presets", () => {
  const endurance = loadPlanEnduranceClient();
  const race = endurance.presets({ mode: "race" }).map((item) => item.t);
  const standing = endurance.presets({ mode: "standing" }).map((item) => item.t);

  assert.equal(JSON.stringify(race), '["Plan this week\'s runs","Progress my long run","Ease back — feeling flat"]');
  assert.equal(JSON.stringify(standing), '["Plan this week\'s runs","Keep me race-ready","Ease back this week"]');
});

test("plan endurance draft card escapes runs and preserves apply controls", () => {
  const endurance = loadPlanEnduranceClient();
  const html = endurance.draftCardHtml({
    id: '12" onclick="bad',
    agent: "auto <coach>",
    parsed: {
      summary: "Build week <steady>",
      cardio: [
        {
          day_number: "3",
          label: "Tempo <run>",
          target_distance_km: 8,
          target_zone: "Z3 <controlled>",
          reason: "race prep <now>",
        },
      ],
    },
  });

  assert.match(html, /auto &lt;coach&gt; · #12" onclick="bad/);
  assert.match(html, /Build week &lt;steady&gt;/);
  assert.match(html, /Tempo &lt;run&gt;/);
  assert.match(html, /8 km @ Z3 &lt;controlled&gt;/);
  assert.match(html, /race prep &lt;now&gt;/);
  assert.match(html, /data-egapply="12&quot; onclick=&quot;bad"/);
  assert.match(html, /data-egdiscard="12&quot; onclick=&quot;bad"/);
  assert.doesNotMatch(html, /<coach>|<steady>|<run>|data-egapply="12" onclick|data-egdiscard="12" onclick/);
});

test("plan endurance orchestration uses the rolling agenda and movable anchor language", () => {
  const source = readFileSync(join(root, "src/client/plan-endurance-client.ts"), "utf8");
  assert.match(source, /api\(`\/training-agenda\?date=/);
  assert.match(source, /trainingAgendaCard\(agenda\)/);
  assert.match(source, /Suggested anchor/);
  assert.match(source, /movable weekly intentions/);
  assert.doesNotMatch(source, /each run lands on its day|>Day \$\{|tempo on Thursday/);
});

test("plan endurance fetches the race build alongside the rest of the segment's reads", () => {
  const source = readFileSync(join(root, "src/client/plan-endurance-client.ts"), "utf8");
  assert.match(source, /api\("\/race-build"\)\.catch\(\(\) => null\)/);
  assert.match(source, /typeof raceBuildCard === "function"/);
  assert.match(source, /the build to race day, this week's runs/);
});
