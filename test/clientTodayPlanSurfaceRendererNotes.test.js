import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function loadRenderer() {
  const context = { Array, Date, Map, Number, Object, String, window: null, globalThis: null };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-surface-renderer.js"), "utf8"), context);
  return context.CairnTodayPlanSurfaceRenderer;
}

function render(items, { logDate = "2026-07-29" } = {}) {
  const renderer = loadRenderer();
  const carded = [];
  const html = renderer.buildHtml(
    {
      showDone: false,
      showPlan: true,
      focus: true,
      session: null,
      day: { day_number: 1, name: "Full body", items },
      isToday: true,
      plan: [],
      activeDay: 1,
      logDate,
      cardioItems: [],
      strengthItems: items,
      activeItems: items,
      skippedItems: [],
      matchedCardio: new Map(),
      syncedLine: "",
      loggedByEx: {},
      offPlanEx: [],
      pendingOffPlan: [],
      lastSets: {},
      rxByEx: {},
      strengthJourney: null,
      exDone: 0,
      exTotal: items.length,
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
      planSurfaceDeps: () => ({ escapeHtml: escHtml }),
      isCardioItem: (item) => item.kind === "cardio",
      cardioLabel: () => "",
      cardioPlanCard: () => "",
      exCard: (item) => {
        carded.push(item);
        return `<div>${item.exercise}</div>`;
      },
      garminSessionCard: () => "",
      sessionDoneCard: () => "",
      skipLineHtml: () => "",
    }
  );
  return { html, carded };
}

// One fact repeated on every card is the session's fact, not the card's. Say it
// once above the cards and let each card keep only what is its own.
test("a session eased across the board states it once and strips the per-card repetition", () => {
  const { html, carded } = render([
    { exercise: "Back Squat", note: "Eased for today. Keep the ribs stacked." },
    { exercise: "Bench Press", note: "Eased for today." },
    { exercise: "Seated Row", note: "eased for today — hold the squeeze." },
  ]);

  assert.match(html, /class="session-eased sess-line"/);
  assert.match(html, /eased/i);
  assert.equal(carded[0].note, "Keep the ribs stacked.");
  assert.equal(carded[1].note, "");
  assert.equal(carded[2].note, "hold the squeeze.");
});

test("a single eased card keeps its own note and a mixed session is left alone", () => {
  const alone = render([{ exercise: "Back Squat", note: "Eased for today." }]);
  assert.doesNotMatch(alone.html, /session-eased/);
  assert.equal(alone.carded[0].note, "Eased for today.");

  const mixed = render([
    { exercise: "Back Squat", note: "Eased for today." },
    { exercise: "Bench Press", note: "Hold this load one more week." },
  ]);
  assert.doesNotMatch(mixed.html, /session-eased/);
  assert.equal(mixed.carded[0].note, "Eased for today.");
  assert.equal(mixed.carded[1].note, "Hold this load one more week.");

  const none = render([{ exercise: "Back Squat" }, { exercise: "Bench Press" }]);
  assert.doesNotMatch(none.html, /session-eased/);
  assert.equal(none.carded[0].note, undefined);
});

// A sentence the athlete reads every eased morning must not be one literal.
test("the session easing line rotates by date and stays stable within a day", () => {
  const items = [
    { exercise: "Back Squat", note: "Eased for today." },
    { exercise: "Bench Press", note: "Eased for today." },
  ];
  const seen = new Set();
  for (const logDate of ["2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01"]) {
    const first = render(items, { logDate }).html;
    const again = render(items, { logDate }).html;
    assert.equal(first, again, "the same date always reads the same");
    seen.add(/<div class="session-eased sess-line">([^<]*)</.exec(first)?.[1] ?? "");
  }
  assert.equal(seen.size, 4, "four consecutive eased mornings never repeat a sentence");
  assert.equal([...seen].every((line) => line.length > 0), true);
});
