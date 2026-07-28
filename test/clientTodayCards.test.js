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

function loadTodayCards() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    String,
    encodeURIComponent,
    escHtml,
    escAttr,
    fmtDur: (seconds) => `${seconds}s`,
    fmtWeight: (weight) => (weight == null ? "BW" : `${weight} lb`),
    fmtKm: (km) => Number(km).toFixed(1),
    stagger: (index) => `--i:${index}`,
    art: (kind, q) => `<svg data-art="${escAttr(`${kind}:${q}`)}"></svg>`,
    artImg: (kind, q, className, svg) =>
      `<span class="${escAttr(className)}" data-kind="${escAttr(kind)}" data-q="${escAttr(q)}">${svg || ""}</span>`,
    cardioArtPhrase: (item) => item.note || item.exercise || "run",
    cardioLabel: (item) => item.label || item.note || item.exercise || "Cardio",
    cardioDescription: (item) => item.description || "",
    cardioPrescription: (item) => item.prescription || "",
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/date-utils.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/ui-components.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-training-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-status-client.js"), "utf8"), context);
  // The "beat this" quiet target line: exerciseCardHtml renders it via
  // CairnTodayPlanSurface.lastSetLineHtml, formatted by CairnTodaySessionSetModel.lastSetLineText.
  vm.runInNewContext(readFileSync(join(root, "public/js/today-plan-surface-client.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-session-set-model.js"), "utf8"), context);
  vm.runInNewContext(readFileSync(join(root, "public/js/today-cards-client.js"), "utf8"), context);
  return context.CairnTodayCards;
}

test("Today exercise card helper preserves selectors, escaping, and timed mode", () => {
  const cards = loadTodayCards();

  const html = cards.exerciseCardHtml(
    {
      fromPlan: true,
      exercise: "Press <heavy>",
      sets: 3,
      rep_low: 5,
      rep_high: 8,
      target_weight: 95,
      note: "keep ribs <down>",
      constraint_note: "elbow <quiet>",
    },
    [{ id: 'set"1', set_number: 1, weight: 90, reps: 5, rir: "<2" }],
    { weight: 95, reps: 5, rir: 2 },
    2,
    { action: "overload", suggested: { sets: 3, rep_low: 5, rep_high: 8, weight: 100 }, why: "earned <move>" },
    { day: 4, exModes: { "Press <heavy>": "timed" } }
  );

  assert.match(html, /class="ex reveal"/);
  assert.match(html, /data-card="Press &lt;heavy&gt;"/);
  assert.match(html, /data-mode="timed"/);
  assert.match(html, /data-day="4"/);
  assert.match(html, /class="in-dur"/);
  assert.match(html, /class="in-dur"[^>]*aria-label="Press &lt;heavy&gt; duration"/);
  assert.match(html, /class="timerbtn"[^>]*data-stopwatch-state="idle"[^>]*aria-label="Start Press &lt;heavy&gt; stopwatch"[^>]*aria-pressed="false"/);
  assert.match(html, /Press &lt;heavy&gt;/);
  assert.match(html, /keep ribs &lt;down&gt;/);
  assert.match(html, /elbow &lt;quiet&gt;/);
  assert.match(html, /earned &lt;move&gt;/);
  assert.match(html, /data-logged/);
  assert.match(html, /data-movement-check/);
  assert.match(html, /data-movement="Press &lt;heavy&gt;"/);
  assert.match(html, />Movement check</);
  assert.doesNotMatch(html, /Press <heavy>|keep ribs <down>|elbow <quiet>|earned <move>/);
});

test("Today exercise card exposes Movement check only for prescribed/session strength cards", () => {
  const cards = loadTodayCards();
  const base = { exercise: "Row & <pull>", sets: 3, rep_low: 8, rep_high: 10 };

  const planned = cards.exerciseCardHtml({ ...base, fromPlan: true }, [], {}, null, null, {});
  const session = cards.exerciseCardHtml({ ...base, fromSession: true }, [], {}, null, null, {});
  const offPlan = cards.exerciseCardHtml({ ...base, fromPlan: false, fromSession: false }, [], {}, null, null, {});
  const cardio = cards.cardioPlanCardHtml({ label: "Easy row" }, null, null, "");

  assert.match(planned, /data-movement-check/);
  assert.match(session, /data-movement-check/);
  assert.match(planned, /data-movement="Row &amp; &lt;pull&gt;"/);
  assert.doesNotMatch(offPlan, /data-movement-check|Movement check/);
  assert.doesNotMatch(cardio, /data-movement-check|Movement check/);
});

test("Today exercise card stopwatch control is timed-only", () => {
  const cards = loadTodayCards();
  const shared = { fromPlan: true, exercise: "Plank", sets: 3, rep_low: 8, rep_high: 12 };

  const timed = cards.exerciseCardHtml({ ...shared, mode: "timed", target_seconds: 60 }, [], {}, null, null, {});
  const reps = cards.exerciseCardHtml(shared, [], { weight: 20, reps: 8, rir: 2 }, null, null, {});

  assert.match(timed, /class="timerbtn"/);
  assert.match(timed, /aria-label="Start Plank stopwatch"/);
  assert.doesNotMatch(reps, /timerbtn|stopwatch/);
});

test("Today exercise card helper renders the quiet last-time line only before anything's logged today", () => {
  const cards = loadTodayCards();
  const item = {
    fromPlan: true,
    exercise: "Bench Press",
    sets: 3,
    rep_low: 5,
    rep_high: 8,
    target_weight: 95,
  };
  const prefill = { weight: 90, reps: 5, rir: 2 };
  const lastSet = { weight: 165, reps: 10, date: "2020-01-01" };

  const notLogged = cards.exerciseCardHtml(item, [], prefill, null, null, {}, lastSet);
  assert.match(notLogged, /class="ex-lastset"/);
  assert.match(notLogged, /Last time: 165 × 10/);

  const alreadyLogged = cards.exerciseCardHtml(
    item,
    [{ id: "set1", set_number: 1, weight: 165, reps: 10, rir: 1 }],
    prefill,
    null,
    null,
    {},
    lastSet
  );
  assert.doesNotMatch(alreadyLogged, /class="ex-lastset"/);
});

test("Today exercise card helper renders no last-time line without last-set data", () => {
  const cards = loadTodayCards();
  const item = { fromPlan: true, exercise: "Row", sets: 3, rep_low: 5, rep_high: 8 };

  const withoutLastSet = cards.exerciseCardHtml(item, [], { weight: null, reps: null, rir: null }, null, null, {});
  assert.doesNotMatch(withoutLastSet, /class="ex-lastset"/);

  const withNullLastSet = cards.exerciseCardHtml(
    item,
    [],
    { weight: null, reps: null, rir: null },
    null,
    null,
    {},
    null
  );
  assert.doesNotMatch(withNullLastSet, /class="ex-lastset"/);
});

test("Today exercise card renders only server-provided anchor/support context", () => {
  const cards = loadTodayCards();
  const base = { fromPlan: true, exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8 };
  const anchor = cards.exerciseCardHtml(
    { ...base, journey_role: "anchor", journey_line: "Anchor lift — hold or ease today." },
    [],
    {},
    null,
    null,
    {},
    null
  );
  assert.match(anchor, /data-journey-role="anchor"/);
  assert.match(anchor, /Anchor lift — hold or ease today/);

  const ordinary = cards.exerciseCardHtml(base, [], {}, null, null, {}, null);
  assert.doesNotMatch(ordinary, /ex-journey|data-journey-role/);
});

test("Today cardio card helper renders planned and done states safely", () => {
  const cards = loadTodayCards();

  const planned = cards.cardioPlanCardHtml(
    {
      note: "Long <run>",
      label: "Long <run>",
      description: "stay <easy>",
      prescription: "8.0 km",
      target_distance_km: 8,
      target_zone: "Z2",
    },
    1,
    null,
    '<span class="sync">synced</span>'
  );

  assert.match(planned, /data-cardio-card/);
  assert.match(planned, /Long &lt;run&gt;/);
  assert.match(planned, /stay &lt;easy&gt;/);
  assert.match(planned, /data-cardio-log="ran 8\.0 km \(Z2\)"/);
  assert.match(planned, /class="sync"/);
  assert.doesNotMatch(planned, /Long <run>|stay <easy>/);

  const done = cards.cardioPlanCardHtml(
    { note: "Easy run" },
    0,
    {
      type: "run",
      source: "garmin",
      distance_km: 5.2,
      duration_min: 31,
      avg_hr: 142,
      zones: [{ zone: 2, secs: 1200 }],
    },
    ""
  );
  assert.match(done, /ex-cardio-done/);
  assert.match(done, /Easy run/);
  assert.match(done, /5\.2 km/);
  assert.match(done, /mostly Z2/);
  assert.match(done, /synced from Garmin/);
});

test("Today cardio matching accepts compatible sports and generic efforts", () => {
  const cards = loadTodayCards();

  assert.equal(cards.cardioEffortMatches({ note: "tempo run" }, { type: "run" }), true);
  assert.equal(cards.cardioEffortMatches({ note: "tempo run" }, { type: "ride" }), false);
  assert.equal(cards.cardioEffortMatches({ note: "conditioning" }, { type: "walk" }), true);
  assert.equal(cards.cardioEffortMatches({ note: "row workout" }, null), false);
});

test("Today cardio cards and matching honor exercise-only generated modalities", () => {
  const cards = loadTodayCards();
  const ride = { kind: "cardio", exercise: "Easy ride", target_duration_min: 40, target_zone: "Z2" };
  const html = cards.cardioPlanCardHtml(ride, null, null, "");

  assert.match(html, /cardio-name-txt">Easy ride</);
  assert.match(html, /data-cardio-log="rode 40 min \(Z2\)"/);
  assert.equal(cards.cardioEffortMatches(ride, { type: "ride" }), true);
  assert.equal(cards.cardioEffortMatches(ride, { type: "run" }), false);
  assert.equal(cards.cardioEffortMatches({ kind: "cardio", exercise: "Pool swim" }, { type: "ride" }), false);
  assert.equal(cards.cardioEffortMatches({ kind: "cardio", exercise: "Erg row" }, { type: "row" }), true);
  assert.equal(cards.cardioEffortMatches({ kind: "cardio", exercise: "Trail hike" }, { type: "hike" }), true);
});

test("specific modality outranks long and interval modifiers for capture and synced matching", () => {
  const cards = loadTodayCards();
  for (const [exercise, modality, capture] of [
    ["Long ride", "ride", "rode 30 min"],
    ["Bike intervals", "ride", "rode 30 min"],
    ["Long swim", "swim", "swam 30 min"],
    ["Row intervals", "row", "rowed 30 min"],
  ]) {
    const item = { kind: "cardio", exercise, target_duration_min: 30 };
    const html = cards.cardioPlanCardHtml(item, null, null, "");
    assert.match(html, new RegExp(`cardio-name-txt">${exercise}`));
    assert.match(html, new RegExp(`data-cardio-log="${capture}"`));
    assert.equal(cards.cardioEffortMatches(item, { type: modality }), true);
    assert.equal(cards.cardioEffortMatches(item, { type: "run" }), false);
  }
});
