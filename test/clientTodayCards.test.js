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
  assert.doesNotMatch(html, /Press <heavy>|keep ribs <down>|elbow <quiet>|earned <move>/);
});

// A card asks the athlete to train. It carries NO pain widget at all any more —
// pain is reported in words, in the session note or in chat, and the extraction
// lane reads it. Nothing on a card should ever ask them to fill in a form mid-set.
test("Today exercise card carries no per-movement pain widget", () => {
  const cards = loadTodayCards();
  const base = { exercise: "Row & <pull>", sets: 3, rep_low: 8, rep_high: 10 };
  const rendered = [
    cards.exerciseCardHtml({ ...base, fromPlan: true }, [], {}, null, null, {}),
    cards.exerciseCardHtml({ ...base, fromSession: true }, [], {}, null, null, {}),
    cards.exerciseCardHtml({ ...base, fromPlan: false, fromSession: false }, [], {}, null, null, {}),
    cards.cardioPlanCardHtml({ label: "Easy row" }, null, null, ""),
  ];
  for (const html of rendered) {
    assert.doesNotMatch(html, /data-movement-check|Movement check|data-tolerance|pain/i);
  }
});

test("Today exercise card leads with one authoritative dose", () => {
  const cards = loadTodayCards();
  const item = { fromPlan: true, exercise: "Back Squat", sets: 2, rep_low: 8, rep_high: 10 };
  const rx = {
    action: "deload",
    suggested: { sets: 2, rep_low: 8, rep_high: 10, weight: 70 },
    delta_text: "−5 lb",
    why: "you flagged knee pain",
  };

  // A composition target (already eased for this session) IS the number; the
  // standing verdict beside it explains, and prescribes nothing of its own.
  const eased = cards.exerciseCardHtml({ ...item, target_weight: 58.5 }, [], {}, null, rx, {});
  assert.match(eased, /data-dose="headline"/);
  assert.match(eased, /class="ex-target numeral">58\.5 lb/);
  assert.match(eased, /ex-rx-supporting/);
  assert.match(eased, /you flagged knee pain/);
  assert.doesNotMatch(eased, /ex-rx-target|ex-rx-delta/);
  assert.doesNotMatch(eased, /70 lb|−5 lb/);

  // No composition target → the rx suggestion is the number.
  const ungrounded = cards.exerciseCardHtml(item, [], {}, null, rx, {});
  assert.doesNotMatch(ungrounded, /data-dose="headline"/);
  assert.match(ungrounded, /ex-rx-target numeral">70 lb/);
  assert.match(ungrounded, /−5 lb/);
  assert.doesNotMatch(ungrounded, /ex-rx-supporting/);

  // Nothing left to explain beside the headline number → say nothing at all.
  const bare = cards.exerciseCardHtml(
    { ...item, target_weight: 58.5 },
    [],
    {},
    null,
    { action: "hold", suggested: { sets: 2, rep_low: 8, rep_high: 10, weight: 58.5 } },
    {}
  );
  assert.doesNotMatch(bare, /ex-rx/);

  // A timed card's prescribed dose is its own headline too.
  const timed = cards.exerciseCardHtml(
    { ...item, mode: "timed", target_seconds: 45 },
    [],
    {},
    null,
    { mode: "timed", action: "overload", suggested: { sets: 2, seconds: 60 }, why: "steady holds" },
    {}
  );
  assert.match(timed, /data-dose="headline"/);
  assert.match(timed, /ex-rx-supporting/);
  assert.doesNotMatch(timed, /ex-rx-target/);
});

// A stored target the athlete has already outgrown is stale, not authoritative:
// leading with it would put the one load nobody uses at the top of the card.
test("Today exercise card lets a re-grounding verdict lead instead of a stale target", () => {
  const cards = loadTodayCards();
  const reground = cards.exerciseCardHtml(
    { fromPlan: true, exercise: "Back Squat", sets: 2, rep_low: 8, rep_high: 10, target_weight: 27 },
    [],
    { weight: 50, reps: 8 },
    null,
    {
      action: "hold",
      reground: true,
      suggested: { sets: 2, rep_low: 8, rep_high: 10, weight: 50 },
      current: { sets: 2, rep_low: 8, rep_high: 10, weight: 50 },
      why: "caught up to what you're lifting",
    },
    {},
    { weight: 50, reps: 8 }
  );

  // The grounded number leads, and the stale one is nowhere on the card.
  assert.match(reground, /ex-rx-target numeral">50 lb/);
  assert.doesNotMatch(reground, /ex-target/);
  assert.doesNotMatch(reground, /27/);
  assert.doesNotMatch(reground, /data-dose="headline"/);
  assert.doesNotMatch(reground, /ex-rx-supporting/);
  // Still ONE dose: sets × reps stay in the header, the load lives only in the rx line.
  assert.match(reground, /class="ex-sets">2 × 8–10<\/span>/);
  assert.match(reground, /class="in-w"[^>]*value="50"/);

  // Without the reground flag the same stored target still leads, unchanged.
  const ordinary = cards.exerciseCardHtml(
    { fromPlan: true, exercise: "Back Squat", sets: 2, rep_low: 8, rep_high: 10, target_weight: 27 },
    [],
    { weight: 27, reps: 8 },
    null,
    { action: "hold", suggested: { sets: 2, rep_low: 8, rep_high: 10, weight: 27 }, why: "steady" },
    {}
  );
  assert.match(ordinary, /class="ex-target numeral">27 lb/);
  assert.match(ordinary, /data-dose="headline"/);
});

test("Today exercise card drops a fossilized start-light note once a real number exists", () => {
  const cards = loadTodayCards();
  const item = {
    fromPlan: true,
    exercise: "Incline Press",
    sets: 3,
    rep_low: 8,
    rep_high: 10,
    note: "New to this rotation. Start light, log your actual working weight.",
  };

  const grounded = cards.exerciseCardHtml({ ...item, target_weight: 95 }, [], {}, null, null, {});
  assert.match(grounded, /New to this rotation\./);
  assert.doesNotMatch(grounded, /Start light/);

  const fromLastSet = cards.exerciseCardHtml(item, [], {}, null, null, {}, { weight: 90, reps: 8 });
  assert.doesNotMatch(fromLastSet, /Start light/);

  const fromRx = cards.exerciseCardHtml(
    item,
    [],
    {},
    null,
    { action: "introduce", suggested: { weight: 85, sets: 3, rep_low: 8 } },
    {}
  );
  assert.doesNotMatch(fromRx, /Start light/);

  // With no number anywhere the instruction is still true — keep it.
  const ungrounded = cards.exerciseCardHtml(item, [], {}, null, null, {});
  assert.match(ungrounded, /Start light, log your actual working weight\./);

  // The cue usually hangs off a fact worth keeping — cut the clause, not the
  // sentence, so the rotation provenance survives.
  const rotated = {
    ...item,
    note: "Rotated in for Bench Press — start light, log your actual working value.",
  };
  const rotatedGrounded = cards.exerciseCardHtml(rotated, [], {}, null, null, {}, { weight: 90, reps: 8 });
  assert.match(rotatedGrounded, /Rotated in for Bench Press/);
  assert.doesNotMatch(rotatedGrounded, /start light|log your actual working value/i);

  // A hyphenated movement name is not a clause break.
  const hyphenated = cards.exerciseCardHtml(
    { ...item, note: "Swapped to Push-up — start light for now." },
    [], {}, null, null, {},
    { weight: 90, reps: 8 }
  );
  assert.match(hyphenated, /Swapped to Push-up\./);
  assert.doesNotMatch(hyphenated, /start light/i);
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

// On a peak day the same lift renders twice. The card key is what separates them
// in the DOM; `data-ex` stays the real lift name, because every logged set has to
// keep attributing to that lift for est-1RM and calibration.
test("Peak-day cards carry a per-card key while still logging under the real lift name", () => {
  const cards = loadTodayCards();
  const topSingle = cards.exerciseCardHtml(
    { fromPlan: true, exercise: "Back Squat", sets: 1, rep_low: 1, rep_high: 1, target_weight: 315, cardKey: "Back Squat#0", exerciseLogged: 1 },
    [{ id: "s1", set_number: 1, weight: 315, reps: 1, rir: 0 }],
    { weight: 315, reps: 1, rir: 0 },
    0,
    null
  );
  const backOff = cards.exerciseCardHtml(
    { fromPlan: true, exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 5, target_weight: 265, cardKey: "Back Squat#1", exerciseLogged: 1 },
    [],
    { weight: 265, reps: 5, rir: null },
    1,
    null
  );

  assert.match(topSingle, /data-exkey="Back%20Squat%230"/);
  assert.match(backOff, /data-exkey="Back%20Squat%231"/);
  // The identity differs; the exercise the set is logged against does not.
  assert.match(topSingle, /data-ex="Back%20Squat"/);
  assert.match(backOff, /data-ex="Back%20Squat"/);
  assert.match(topSingle, /data-card="Back Squat"/);

  // Each card counts only its own sets, so the back-off block does not read as
  // already done just because the single was hit.
  assert.match(topSingle, /data-prog[^>]*>1 \/ 1/);
  assert.match(backOff, /data-prog[^>]*>0 \/ 3/);
  assert.match(topSingle, /class="ex ex-complete/);
  assert.doesNotMatch(backOff, /ex-complete/);
  assert.match(backOff, /value="265"/, "the back-off card opens on its own dose");

  // A skip is recorded against the LIFT, by name — there is no per-card skip — so
  // once any set exists for it, neither card offers one the server could only refuse.
  assert.doesNotMatch(topSingle, /class="ex-skip"/);
  assert.doesNotMatch(backOff, /class="ex-skip"/);
});

// The ordinary day is the one that must not move: with a single card per exercise
// there is nothing to disambiguate, so no key is emitted at all.
test("A single card per exercise emits no card key and keeps its skip affordance", () => {
  const cards = loadTodayCards();
  const item = { fromPlan: true, exercise: "Row", sets: 3, rep_low: 8, rep_high: 10, target_weight: 135 };
  const plain = cards.exerciseCardHtml(item, [], { weight: 135, reps: 8, rir: null }, 0, null);

  assert.doesNotMatch(plain, /data-exkey/);
  assert.match(plain, /data-skip="Row"/);
  // Identical to what the same card rendered before per-card identity existed:
  // an unshared name passes cardKey === exercise and no exerciseLogged.
  const keyedSameName = cards.exerciseCardHtml(
    { ...item, cardKey: "Row", exerciseLogged: 0 },
    [],
    { weight: 135, reps: 8, rir: null },
    0,
    null
  );
  assert.equal(keyedSameName, plain);
});
