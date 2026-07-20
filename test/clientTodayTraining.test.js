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
    cardioLabel: (it) => it.label || it.note || it.exercise || "Cardio",
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

test("Today cardio helpers classify efforts and build log phrases", () => {
  const today = loadTodayTraining();
  assert.equal(
    today.cardioDominantZone([
      { zone: 2, secs: 1800 },
      { zone: 4, secs: 600 },
    ]),
    "mostly Z2"
  );
  assert.equal(
    today.cardioDominantZone([
      { zone: 2, secs: 200 },
      { zone: 4, secs: 180 },
      { zone: 3, secs: 150 },
    ]),
    "Z2"
  );
  assert.equal(today.cardioDominantZone([]), "");

  assert.equal(today.cardioVerb("long run"), "run");
  assert.equal(today.cardioVerb("bike workout"), "ride");
  assert.equal(today.cardioVerb("pool swim"), "swim");
  assert.equal(today.cardioVerb("erg row"), "row");
  assert.equal(today.cardioVerb("trail hike"), "hike");
  assert.equal(today.cardioVerb("recovery walk"), "walk");
  assert.equal(today.cardioVerb("conditioning"), "effort");

  for (const [label, modality, phrase] of [
    ["Long ride", "ride", "rode 30 min"],
    ["Bike intervals", "ride", "rode 30 min"],
    ["Long swim", "swim", "swam 30 min"],
    ["Row intervals", "row", "rowed 30 min"],
  ]) {
    assert.equal(today.cardioVerb(label), modality);
    assert.equal(today.cardioLogPhrase({ exercise: label, target_duration_min: 30 }), phrase);
  }

  assert.equal(
    today.cardioLogPhrase({ label: "Long run", target_distance_km: 8.2, target_zone: "Z2" }),
    "ran 8.2 km (Z2)"
  );
  assert.equal(today.cardioLogPhrase({ label: "Easy ride", target_duration_min: 45 }), "rode 45 min");
  assert.equal(today.cardioLogPhrase({ exercise: "Trail hike", target_duration_min: 90 }), "hiked 90 min");
  assert.equal(today.cardioLogPhrase({ exercise: "Recovery walk", target_duration_min: 30 }), "walked 30 min");
});
