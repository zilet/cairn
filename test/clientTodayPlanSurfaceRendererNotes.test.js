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

function escAttr(value) {
  return escHtml(value).replaceAll('"', "&quot;");
}

function loadRenderer() {
  const context = { Array, Date, Map, Number, Object, String, window: null, globalThis: null };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-surface-renderer.js"), "utf8"), context);
  return context.CairnTodayPlanSurfaceRenderer;
}

function render(items, { logDate = "2026-07-29", extra = {} } = {}) {
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
      ...extra,
    },
    {
      planSurface: {
        sessionHeadHtml: () => "",
        daySwitchHtml: () => "",
        rxBannerHtml: () => "",
        addExerciseFormHtml: () => "",
        finishHtml: () => "",
      },
      planSurfaceDeps: () => ({ escapeHtml: escHtml, escapeAttr: escAttr }),
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

// The decision-level narration is the session's fact too, so it prints above the
// cards once per DECISION. It used to stop after two, so a session touched by a third
// decision silently lost that change from the surface entirely.
test("every decision narration reaches the surface, deduped but never capped", () => {
  const { html } = render([
    { exercise: "Back Squat", brain_decision_id: 1, brain_change_summary: "Held the squat load." },
    { exercise: "Bench Press", brain_decision_id: 1, brain_change_summary: "Held the squat load." },
    { exercise: "Seated Row", brain_decision_id: 2, brain_change_summary: "Rotated the row." },
    { exercise: "Curl", brain_decision_id: 3, brain_change_summary: "Trimmed a set from the curl." },
  ]);

  // Folded into one line now, but every decision is still in it.
  const lines = [...html.matchAll(/<li>([^<]*)/g)].map((m) => m[1]);
  assert.deepEqual(lines, ["Held the squat load.", "Rotated the row.", "Trimmed a set from the curl."]);
  assert.match(html, /<span class="session-brain-label">3 changes today<\/span>/);
});

test("Undo for a reversible decision lives once on the session line", () => {
  const { html } = render([
    {
      exercise: "Ankle Rocker",
      brain_decision_id: 42,
      brain_change_summary: "Updated 3 lifts from what you logged.",
      brain_change_reason: "You already lifted this; the weight goes up because of that, and fueling can catch up around it.",
      brain_change_reversible: true,
    },
    {
      exercise: "Standing Calf Raise",
      brain_decision_id: 42,
      brain_change_summary: "Updated 3 lifts from what you logged.",
      brain_change_reason: "You already lifted this; the weight goes up because of that, and fueling can catch up around it.",
      brain_change_reversible: true,
    },
  ]);
  assert.equal([...html.matchAll(/data-decision-undo="42"/g)].length, 1);
  assert.match(html, /Updated 3 lifts from what you logged\./);
});

// ---- applied-change notices fold into one compact line ----

test("several applied changes fold into one line, each Undo one tap in", () => {
  const { html } = render([
    {
      exercise: "Back Squat",
      brain_decision_id: 7,
      brain_change_summary:
        "Rebuilt your weekly training template around your request to keep the ankle work every lifting day. Two days moved.",
      brain_change_reversible: true,
    },
    {
      exercise: "Leg Press",
      brain_decision_id: 8,
      brain_change_summary: "Auto-progression for day 3 — 3 lifts",
      brain_change_reversible: true,
    },
  ]);
  assert.equal((html.match(/class="session-brain /g) || []).length, 1, "one notice line, not a stack");
  assert.match(html, /<details class="session-brain session-brain-fold sess-line" data-brain-fold="7,8"><summary>/);
  assert.match(html, /<span class="session-brain-label">2 changes today<\/span>/);
  assert.match(html, /<span class="sb-closed">see<\/span>/);
  // Every change keeps its full words and its own Undo inside the fold.
  assert.match(html, /<li>Rebuilt your weekly training template[^<]*Two days moved\. <button[^>]*data-decision-undo="7"/);
  assert.match(html, /<li>Auto-progression for day 3 — 3 lifts <button[^>]*data-decision-undo="8"/);
  assert.equal([...html.matchAll(/data-decision-undo=/g)].length, 2);
});

test("an open change fold stays open across a soft re-render", () => {
  const listeners = {};
  const context = { Array, Date, Map, Number, Object, Set, String, window: null, globalThis: null };
  context.document = { addEventListener: (type, fn) => (listeners[type] = fn) };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-surface-renderer.js"), "utf8"), context);
  const items = [
    { exercise: "Back Squat", brain_decision_id: 7, brain_change_summary: "Held the squat load.", brain_change_reversible: true },
    { exercise: "Leg Press", brain_decision_id: 8, brain_change_summary: "Rotated the press.", brain_change_reversible: true },
  ];
  const paint = () => {
    const html = [];
    const options = {
      showDone: false, showPlan: true, focus: true, session: null,
      day: { day_number: 1, name: "Full body", items }, isToday: true, plan: [], activeDay: 1,
      logDate: "2026-07-29", strengthItems: items, activeItems: items, skippedItems: [],
      loggedByEx: {}, offPlanEx: [], pendingOffPlan: [], lastSets: {}, rxByEx: {}, strengthJourney: null,
      exDone: 0, exTotal: 2, hasSyncedCardioToday: false, hasLoggedSets: false, hasGarmin: false,
      isRunDay: false, prefillFor: () => ({}), rxFor: () => null,
    };
    html.push(context.CairnTodayPlanSurfaceRenderer.buildHtml(options, {
      planSurface: { daySwitchHtml: () => "", rxBannerHtml: () => "", sessionHeadHtml: () => "", addExerciseFormHtml: () => "", finishHtml: () => "" },
      planSurfaceDeps: () => ({ escapeHtml: escHtml, escapeAttr: escAttr }),
      exCard: () => "", garminSessionCard: () => "", sessionDoneCard: () => "", skipLineHtml: () => "",
    }));
    return html.join("");
  };
  assert.doesNotMatch(paint(), /data-brain-fold="7,8" open/);
  const fold = { open: true, getAttribute: (name) => (name === "data-brain-fold" ? "7,8" : null) };
  listeners.toggle({ target: fold });
  assert.match(paint(), /data-brain-fold="7,8" open>/, "the re-render keeps it open");
  fold.open = false;
  listeners.toggle({ target: fold });
  assert.doesNotMatch(paint(), /data-brain-fold="7,8" open/);
});

test("one long change shows its short label with Undo, the full sentence folded under it", () => {
  const summary =
    "Rebuilt your weekly training template around your request to keep the ankle work every lifting day. Two days moved.";
  const { html } = render([
    { exercise: "Back Squat", brain_decision_id: 7, brain_change_summary: summary, brain_change_reversible: true },
  ]);
  const label = /<span class="session-brain-label">([^<]*)<\/span>/.exec(html)?.[1] ?? "";
  assert.ok(label.length > 0 && label.length <= 60, label);
  assert.ok(summary.startsWith(label.replace(/…$/, "")), label);
  assert.ok(html.includes(`<p class="session-brain-more">${summary}</p>`), "the full sentence is one tap away");
  // Undo sits on the line itself, outside the fold — no expansion needed to put it back.
  assert.match(html, /<\/details> <button class="linkbtn-quiet" type="button" data-decision-undo="7">Undo<\/button><\/div>/);
});


// ---- the cap has a sentence on the Train tab (Finding 9) ----

// The envelope's own athlete-facing reason, once, under the day header. Without it
// a capped day is a shorter plan with fewer sets and nothing saying why.
function renderWithHeader(extra) {
  return render([{ exercise: "Back Squat" }], {
    extra: { focus: false, ...extra },
  });
}

test("the plan surface renders the envelope's first rationale under the day header", () => {
  const { html } = renderWithHeader({
    session: {
      daily_session: {
        rationale: [
          { code: "run_intensity_caution", text: "Yesterday's run sat above your easy ceiling <b>, so today holds its load." },
          { code: "other", text: "Never rendered." },
        ],
      },
    },
  });

  assert.match(html, /class="session-cap sess-line"/);
  assert.match(html, /Yesterday's run sat above your easy ceiling &lt;b&gt;, so today holds its load\./);
  assert.doesNotMatch(html, /Never rendered/, "only the first entry — the day's read — is the line");
});

test("the plan surface renders nothing when the envelope carries no rationale", () => {
  assert.doesNotMatch(renderWithHeader({}).html, /session-cap/);
  assert.doesNotMatch(renderWithHeader({ session: { daily_session: { rationale: [] } } }).html, /session-cap/);
  assert.doesNotMatch(renderWithHeader({ session: { daily_session: { rationale: [{ text: "   " }] } } }).html, /session-cap/);
});

test("the plan surface takes an explicitly-passed cap line over the composition's", () => {
  const { html } = renderWithHeader({
    capRationale: "Shorter today on purpose.",
    session: { daily_session: { rationale: [{ text: "From the composition." }] } },
  });

  assert.match(html, /Shorter today on purpose\./);
  assert.doesNotMatch(html, /From the composition/);
});

test("the focused single-card view stays bare — no header, no cap line", () => {
  const { html } = render([{ exercise: "Back Squat" }], {
    extra: { session: { daily_session: { rationale: [{ text: "Held today." }] } } },
  });

  assert.doesNotMatch(html, /session-cap/);
});
