// Runs leave the strength plan (client side). A plan day holds lifts only; every run
// lives in Plan -> Endurance and reaches Today as one line from the rolling agenda,
// never as a line item inside the lift card or the session. The client tolerates a
// payload from before the server migration (cardio items, a rest row, a run-only
// "Long Run" day) by filtering them out of every strength surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plain = (value) => JSON.parse(JSON.stringify(value));
const read = (path) => readFileSync(join(root, path), "utf8");

function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function vmContext(extra = {}) {
  const context = { Object, String, Number, Array, Map, Set, Math, Promise, encodeURIComponent, ...extra };
  context.window = context;
  context.globalThis = context;
  return context;
}

function loadPreparation() {
  const context = vmContext();
  vm.runInNewContext(read("public/js/today-plan-session-model.js"), context);
  vm.runInNewContext(read("public/js/today-plan-session-data-client.js"), context);
  vm.runInNewContext(read("public/js/today-plan-session-preparation.js"), context);
  return context;
}

// An old-payload week: a lift day carrying a run, a rest row, a run-only day.
const BENCH = { kind: "strength", exercise: "Bench", sets: 3, rep_low: 5, rep_high: 5, target_weight: 185 };
const EASY_RUN = { kind: "cardio", exercise: "Easy run", note: "Easy run", target_distance_km: 6, target_zone: "Z2" };
const OLD_PLAN = [
  { id: 1, day_number: 1, name: "Pull", items: [BENCH, EASY_RUN] },
  { id: 6, day_number: 6, name: "Rest", day_type: "rest", items: [] },
  { id: 7, day_number: 7, name: "Long Run", items: [{ kind: "cardio", exercise: "Long run", target_distance_km: 16 }] },
];

function prepDeps(state, requests, { cardio = [] } = {}) {
  return {
    state,
    session: { skips: ["Easy run"], sets: [] },
    isToday: true,
    suggestedPlanDayNumber: async () => state.day,
    api: async (path) => {
      requests.push(path);
      if (path.startsWith("/cardio")) return cardio;
      return {};
    },
    peekCached: () => null,
    cachedApi: async () => null,
  };
}

test("the lift card and session never carry a run: a stale cardio item is dropped at the one item door", async () => {
  const context = loadPreparation();
  const model = context.CairnTodayPlanSessionModel;
  assert.deepEqual(plain(model.planItems(OLD_PLAN[0]).map((item) => item.exercise)), ["Bench"]);

  const requests = [];
  const state = { logDate: "2026-09-23", day: 1, dayPicked: true, plan: plain(OLD_PLAN), pendingOffPlan: {} };
  const result = await context.CairnTodayPlanSessionPreparation.preparePlanSession(prepDeps(state, requests));
  assert.deepEqual(plain(result.day.items.map((item) => item.exercise)), ["Bench"], "the prepared day is lifts only");
  assert.deepEqual(plain(result.activeItems.map((item) => item.exercise)), ["Bench"]);
  assert.equal(result.skippedItems.length, 0, "a skipped run is not a skipped lift");
  assert.equal(result.exTotal, 1);
  assert.equal(result.isRunDay, false);
  assert.ok(!requests.some((path) => path.startsWith("/cardio")), "a lift day never asks about a synced run");
});

test("an old run-only day is not startable, and only a real synced run names a lift-less day a run", async () => {
  const context = loadPreparation();
  const requests = [];
  const state = { logDate: "2026-09-23", day: 7, dayPicked: true, plan: plain(OLD_PLAN), pendingOffPlan: {} };
  const quiet = await context.CairnTodayPlanSessionPreparation.preparePlanSession(prepDeps(state, requests));
  assert.equal(quiet.day.items.length, 0, "a run-only day carries no lift to launch");
  assert.equal(quiet.activeItems.length, 0);
  assert.equal(quiet.isRunDay, false, "a planned run alone no longer turns the lift surface into a run hero");

  const synced = await context.CairnTodayPlanSessionPreparation.preparePlanSession(
    prepDeps({ ...state, plan: plain(OLD_PLAN) }, [], { cardio: [{ type: "run", distance_km: 6.1 }] })
  );
  assert.equal(synced.isRunDay, true);
  assert.equal(synced.hasSyncedCardioToday, true);
});

test("the surface renderer draws lifts only, even when handed a cardio item", () => {
  const context = vmContext();
  vm.runInNewContext(read("public/js/today-plan-surface-renderer.js"), context);
  const drawn = [];
  const skipped = [];
  const items = [BENCH, EASY_RUN];
  context.CairnTodayPlanSurfaceRenderer.buildHtml(
    {
      showDone: false,
      showPlan: true,
      focus: true,
      session: null,
      day: { day_number: 1, name: "Pull", items },
      isToday: true,
      plan: [],
      activeDay: 1,
      logDate: "2026-09-23",
      strengthItems: [BENCH],
      activeItems: items,
      skippedItems: [EASY_RUN],
      loggedByEx: {},
      offPlanEx: [],
      pendingOffPlan: [],
      lastSets: {},
      rxByEx: {},
      strengthJourney: null,
      exDone: 0,
      exTotal: 1,
      hasSyncedCardioToday: false,
      hasLoggedSets: false,
      hasGarmin: false,
      isRunDay: false,
      prefillFor: () => ({}),
      rxFor: () => null,
    },
    {
      planSurface: {
        sessionHeadHtml: () => "",
        daySwitchHtml: () => "",
        rxBannerHtml: () => "",
        addExerciseFormHtml: () => "",
        finishHtml: () => "",
      },
      planSurfaceDeps: () => ({}),
      exCard: (item) => {
        drawn.push(item.exercise);
        return "";
      },
      garminSessionCard: () => "",
      sessionDoneCard: () => "",
      skipLineHtml: (labels) => {
        skipped.push(...labels);
        return "";
      },
    }
  );
  assert.deepEqual(drawn, ["Bench"]);
  assert.deepEqual(skipped, [], "a run is never named in the lift list's skip line");
});

test("day pills offer lift days only, and the session head never names a planned run", () => {
  const context = vmContext();
  vm.runInNewContext(read("public/js/today-plan-surface-client.js"), context);
  const surface = context.CairnTodayPlanSurface;
  const pills = surface.daySwitchHtml(plain(OLD_PLAN), 1, { escapeHtml: escHtml });
  assert.match(pills, /data-day="1"/);
  assert.doesNotMatch(pills, /data-day="6"|data-day="7"|Long Run|Rest/);

  const deps = { escapeHtml: escHtml, escapeAttr: escHtml, stagger: () => "", rxMoveCount: () => 0, setsTonnage: () => 0 };
  const head = surface.sessionHeadHtml(
    { isRunDay: false, isToday: true, day: { name: "Pull" }, exDone: 0, exTotal: 1, hasSyncedCardioToday: false },
    deps
  );
  assert.match(head, /TODAY'S SESSION/);
  assert.doesNotMatch(head, /LIFT \+ RUN|A RUN/);
  // A run already SYNCED today is still named — a cross-reference in the kicker, not a card.
  const hybrid = surface.sessionHeadHtml(
    { isRunDay: false, isToday: true, day: { name: "Pull" }, exDone: 0, exTotal: 1, hasSyncedCardioToday: true },
    deps
  );
  assert.match(hybrid, /LIFT \+ RUN/);
});

test("today's run is one line from the agenda, outside the lift card, and only for a run opened today", () => {
  const context = vmContext();
  vm.runInNewContext(read("public/js/today-plan-surface-client.js"), context);
  const surface = context.CairnTodayPlanSurface;
  const agenda = {
    available: true,
    intents: [
      { kind: "easy", label: "Easy <run>", status: "open", suggested_date: "2026-09-23", target_distance_km: 6, target_zone: "Z2" },
      { kind: "long", label: "Long run", status: "open", suggested_date: "2026-09-27", target_distance_km: 16, target_zone: "Z2" },
    ],
  };
  const deps = { escapeHtml: escHtml, formatDistance: (km, units) => (units === "mi" ? `${km} mi?` : `${km} km`) };
  const line = surface.runLineHtml(agenda, { date: "2026-09-23", syncLine: '<div data-cardio-sync></div>' }, deps);
  assert.match(line, /data-today-run/);
  assert.match(line, /Today · Easy/);
  assert.match(line, /Easy &lt;run&gt;/);
  assert.doesNotMatch(line, /Easy <run>/);
  assert.match(line, /6 km · Z2/);
  assert.match(line, /data-today-run-go/);
  assert.match(line, /Endurance/);
  assert.match(line, /data-cardio-sync/, "the stale-sync nudge rides the run line now");
  assert.doesNotMatch(line, /Long run/, "a run suggested for another day stays in the week strip and Endurance");

  assert.equal(surface.runLineHtml(agenda, { date: "2026-09-24" }, deps), "", "nothing opened today, nothing said");
  const done = { available: true, intents: [{ ...agenda.intents[0], status: "completed" }] };
  assert.equal(surface.runLineHtml(done, { date: "2026-09-23" }, deps), "", "a run already in speaks in the Brief line");
  assert.equal(surface.runLineHtml(null, { date: "2026-09-23" }, deps), "");
  assert.equal(surface.runLineHtml({ available: false, intents: [] }, { date: "2026-09-23" }, deps), "");

  // Wired into Today OUTSIDE the plan region: its own slot after the lift card /
  // plan surface and before the week fold, fed by /training-agenda for the date.
  const today = read("src/client/today-screen.ts");
  assert.match(today, /\/training-agenda\?date=\$\{encodeURIComponent\(todayState\.logDate\)\}/);
  const slot = today.indexOf('id="todayRunSlot"');
  const launch = today.indexOf("sessionLaunchCardHtml({");
  const fold = today.indexOf("todayMainShell.weekFoldHtml(todayCompass");
  assert.ok(slot > launch && slot < fold, "the run slot sits after the lift card and before the week fold");
  assert.match(today, /todayState\.planJump = "endurance";[\s\S]{0,40}activateTab\("plan"\)/);
});

test("the strength editor models, draws and saves lift days only, and points runs to Endurance", () => {
  const context = vmContext({
    art: () => "",
    artImg: () => "",
    fmtDur: (seconds) => `${seconds}s`,
    fmtWeight: (weight) => `${weight} lb`,
    stagger: () => "",
  });
  vm.runInNewContext(read("public/js/html-utils.js"), context);
  vm.runInNewContext(read("public/js/cardio-plan-client.js"), context);
  vm.runInNewContext(read("public/js/plan-editor-client.js"), context);
  vm.runInNewContext(read("public/js/plan-editor-form-client.js"), context);
  const editor = context.CairnPlanEditor;

  const days = context.strengthPlanDays(plain(OLD_PLAN));
  assert.deepEqual(plain(days.map((day) => day.name)), ["Pull"], "rest and run-only days never reach the editor");
  const model = days.map((day) => editor.dayModelFromPlan(day));
  assert.deepEqual(plain(model[0].items.map((item) => item.exercise)), ["Bench"]);

  const read_ = editor.progDayHtml(OLD_PLAN[0], 0);
  const edit = editor.pdayHtml(OLD_PLAN[0], 0);
  for (const html of [read_, edit]) {
    assert.doesNotMatch(html, /Easy run|cardio|data-addcardio|data-restday|data-pikind|rest day/i);
  }
  assert.match(edit, /data-additem="0"/);

  const saved = context.CairnPlanEditorForm.serializeDays([{ ...model[0], items: [...model[0].items, { ...EASY_RUN }] }]);
  assert.deepEqual(plain(saved[0].items.map((item) => item.kind)), ["strength"], "a save never writes a run back");
  assert.equal(saved[0].day_type, "training");

  assert.match(editor.runsElsewhereHtml(), /your runs live in Endurance/);
  const controller = read("src/client/plan-editor-controller.ts");
  assert.match(controller, /strengthPlanDays\(/);
  assert.match(controller, /\[data-plan-runs\][\s\S]{0,120}renderPlanEndurance\(\)/);
  assert.doesNotMatch(controller, /data-addcardio|data-restday|data-pikind|blankCardio/);
});

test("Endurance reads runs only from the run endpoints — never by scanning the lift plan", () => {
  const source = read("src/client/plan-endurance-client.ts");
  for (const endpoint of ["/run-plan", "/training-agenda", "/race-build", "/run-compliance"]) {
    assert.ok(source.includes(`"${endpoint}`) || source.includes(`\`${endpoint}`), `${endpoint} still feeds the tab`);
  }
  assert.doesNotMatch(source, /api\("\/plan"\)/);
  assert.doesNotMatch(source, /endEditRuns|Edit in Training/);
  const model = read("src/client/plan-endurance-model.ts");
  assert.doesNotMatch(model, /isCardioItem|planEnduranceRuns/);
});
