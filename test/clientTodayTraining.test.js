import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function escHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(v) {
  return escHtml(v).replace(/"/g, "&quot;");
}

function loadTodayTraining(overrides = {}) {
  const context = {
    Math,
    Number,
    String,
    Object,
    Array,
    escHtml,
    escAttr,
    fmtDur: (sec) => {
      const n = Number(sec) || 0;
      return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
    },
    fmtWeight: (lb) => `${Number(lb)} lb`,
    fmtKm: (km) => Number(km).toFixed(1),
    ...overrides,
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-components.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-training-client.js"), "utf8"), context);
  return context.CairnTodayTraining;
}

test("Today training prescription text handles timed, bodyweight, and assisted loads", () => {
  const today = loadTodayTraining();

  assert.equal(today.rxTargetText({ mode: "timed", suggested: { sets: 3, seconds: 90 } }), "3 × 1:30");
  assert.equal(today.rxTargetText({ suggested: { sets: 2, rep_low: 8, rep_high: 10, weight: null } }), "BW · 2 × 8–10");
  assert.equal(
    today.rxTargetText({ suggested: { sets: 3, rep_low: 5, rep_high: 5, weight: -30 } }),
    "30 assist · 3 × 5"
  );
  assert.equal(
    today.rxTargetText({ suggested: { sets: 4, rep_low: 6, rep_high: 8, weight: 185 } }),
    "185 lb · 4 × 6–8"
  );
});

test("Today training prescription line escapes why, delta, and variation chips", () => {
  const today = loadTodayTraining();
  const html = today.exRxLineHtml({
    action: "vary",
    delta_text: `+5 <lb>`,
    why: `avoid <elbow>`,
    suggested: { sets: 3, rep_low: 8, rep_high: 10, weight: 50 },
    vary_options: [
      { name: "Incline <press>", why: `same "pattern"` },
      { name: "DB press" },
      { name: "Push-up" },
      { name: "Hidden fourth" },
    ],
  });

  assert.match(html, /switch it up/);
  assert.match(html, /\+5 &lt;lb&gt;/);
  assert.match(html, /avoid &lt;elbow&gt;/);
  assert.match(html, /Incline &lt;press&gt;/);
  assert.match(html, /title="same &quot;pattern&quot;"/);
  assert.doesNotMatch(html, /Hidden fourth/);
  assert.match(html, /update a future session/);
});

test("variation swap updates only future-plan state and preserves the accepted Today snapshot", async () => {
  const requests = [];
  const invalidations = [];
  const toasts = [];
  let sessionRenders = 0;
  let todayRenders = 0;
  const accepted = { id: 41, items: [{ exercise: "Bench" }] };
  const state = { tab: "session", plan: [{ day_number: 2 }], brief: { kind: "train" }, accepted };
  const today = loadTodayTraining({
    state,
    api: async (path, init) => {
      requests.push({ path, init });
      return { ok: true };
    },
    toast: (message) => toasts.push(message),
    swrInvalidate: (key) => invalidations.push(key),
    renderSession: () => { sessionRenders += 1; },
    reshapeToday: () => { todayRenders += 1; },
  });

  await today.requestRxSwap("Bench", "Incline Bench", 2);

  assert.deepEqual(JSON.parse(requests[0].init.body), { day: 2, from: "Bench", to: "Incline Bench" });
  assert.deepEqual(invalidations, ["plan", "program:progression:2"]);
  assert.equal(sessionRenders, 0);
  assert.equal(todayRenders, 0);
  assert.equal(state.accepted, accepted);
  assert.deepEqual(state.brief, { kind: "train" });
  assert.equal(state.plan.length, 0);
  assert.deepEqual(toasts, ["Weekly plan updated — today’s accepted session stays the same."]);
});

test("Today training move count ignores holds", () => {
  const today = loadTodayTraining();
  assert.equal(
    today.rxMoveCount({
      squat: { action: "hold" },
      bench: { action: "overload" },
      row: { action: "vary" },
    }),
    2
  );
});

// The cardio verb / log-phrase / dominant-zone helpers served only the run card
// inside Today's lift list. Runs left the strength plan (they live in Plan ->
// Endurance), so that card and its helpers are gone.
test("Today training helpers no longer carry the retired run-card helpers", () => {
  const today = loadTodayTraining();
  assert.equal(today.cardioDominantZone, undefined);
  assert.equal(today.cardioVerb, undefined);
  assert.equal(today.cardioLogPhrase, undefined);
});

// Supporting mode is what keeps a card to ONE authoritative number: the header
// already carries today's dose, so the verdict explains it and prescribes nothing.
test("Today training prescription line drops its own number in supporting mode", () => {
  const today = loadTodayTraining();
  const rx = {
    action: "deload",
    delta_text: "−5 lb",
    why: "your knee flared on Tuesday",
    suggested: { sets: 2, rep_low: 8, rep_high: 10, weight: 70 },
  };

  const supporting = today.exRxLineHtml(rx, { supporting: true });
  assert.match(supporting, /ex-rx-supporting/);
  assert.match(supporting, /ease off/);
  assert.match(supporting, /your knee flared on Tuesday/);
  assert.doesNotMatch(supporting, /ex-rx-target|ex-rx-delta|70 lb|−5 lb/);

  // Nothing left to explain → a lone verdict word beside the number is noise.
  assert.equal(today.exRxLineHtml({ action: "hold", suggested: { sets: 3, weight: 100 } }, { supporting: true }), "");

  // A rotation offer is still an action, not a competing prescription — keep it.
  const vary = today.exRxLineHtml(
    { action: "vary", suggested: { sets: 3, weight: 50 }, exercise: "Bench", day_number: 2, vary_options: [{ name: "DB press" }] },
    { supporting: true }
  );
  assert.match(vary, /ex-rx-supporting/);
  assert.match(vary, /DB press/);
  assert.doesNotMatch(vary, /ex-rx-target/);

  // Default (no options) is unchanged: the suggestion IS the number.
  const full = today.exRxLineHtml(rx);
  assert.match(full, /ex-rx-target/);
  assert.match(full, /70 lb/);
  assert.doesNotMatch(full, /ex-rx-supporting/);
});
