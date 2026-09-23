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

function loadTodayCardsContext() {
  const context = {
    Array,
    Math,
    Number,
    Object,
    String,
    encodeURIComponent,
    decodeURIComponent,
    escHtml,
    escAttr,
    fmtDur: (seconds) => `${seconds}s`,
    fmtWeight: (weight) => (weight == null ? "BW" : `${weight} lb`),
    fmtKm: (km) => Number(km).toFixed(1),
    stagger: (index) => `--i:${index}`,
    art: (kind, q) => `<svg data-art="${escAttr(`${kind}:${q}`)}"></svg>`,
    artImg: (kind, q, className, svg) =>
      `<span class="${escAttr(className)}" data-kind="${escAttr(kind)}" data-q="${escAttr(q)}">${svg || ""}</span>`,
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
  return context;
}

function loadTodayCards() {
  return loadTodayCardsContext().CairnTodayCards;
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

// Runs left the strength plan: a planned run is never a card inside Today's lift
// list (it is a line on the agenda, and it lives in Plan -> Endurance), so the run
// card, its done state and the plan-item/effort matcher are gone with it.
test("Today's card renderers draw lifts only — the planned-run card is gone", () => {
  const cards = loadTodayCards();
  assert.equal(cards.cardioPlanCardHtml, undefined);
  assert.equal(cards.cardioDoneCardHtml, undefined);
  assert.equal(cards.cardioEffortMatches, undefined);
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

test("typed RIR on a real rendered card reaches the POST body", () => {
  const context = loadTodayCardsContext();
  const html = context.CairnTodayCards.exerciseCardHtml(
    { fromPlan: true, exercise: "Bench Press", sets: 3, rep_low: 5, rep_high: 8, target_weight: 185 },
    [],
    { weight: 185, reps: 5, rir: "" },
    null,
    null,
    {},
  );
  assert.match(html, /class="in-rir"/, "the renderer emits the class logPayloadFromRow reads");
  assert.doesNotMatch(html, /data-mode="timed"/);

  const logrow = html.match(/<div class="logrow"[^>]*>[\s\S]*?<\/div>/)?.[0] || "";
  assert.match(logrow, /class="in-rir"/);
  const dataEx = logrow.match(/data-ex="([^"]*)"/)?.[1] || "";
  const dataDay = logrow.match(/data-day="([^"]*)"/)?.[1] ?? "";

  function inputEl(className, value) {
    return {
      className,
      value,
      classList: { contains: (name) => className.split(/\s+/).includes(name) },
    };
  }
  const children = [
    inputEl("in-w", "185"),
    inputEl("in-r", "5"),
    inputEl("in-rir", "3"),
  ];
  const row = {
    dataset: { ex: dataEx, day: dataDay },
    querySelector(selector) {
      const cls = selector.startsWith(".") ? selector.slice(1) : "";
      return children.find((el) => el.classList.contains(cls)) || null;
    },
  };
  const payload = context.CairnTodaySessionSetModel.logPayloadFromRow(row, {
    state: { logDate: "2026-06-30" },
    parseDur: () => null,
    fmtDur: (seconds) => String(seconds),
  });
  assert.equal(payload.ok, true);
  assert.equal(payload.body.rir, 3, "a typed RIR from the rendered .in-rir field reaches the POST body");
  assert.equal(payload.body.weight, 185);
  assert.equal(payload.body.reps, 5);
  assert.equal(payload.body.exercise, "Bench Press");
});

test("a reach card renders a calm Reach line above the set rows", () => {
  const cards = loadTodayCards();
  const html = cards.exerciseCardHtml(
    {
      fromSession: true,
      exercise: "Back Squat",
      sets: 1,
      rep_low: 3,
      rep_high: 5,
      target_weight: 240,
      note: "If the warm-ups move well, take one heavier single-set reach here — stop with a rep in hand",
      reach: {
        weight: 240,
        reps: 3,
        note: "If the warm-ups move well, take one heavier single-set reach here — stop with a rep in hand",
      },
    },
    [],
    { weight: 240, reps: 3, rir: null },
    0,
    null
  );
  assert.match(html, />Reach · 240 lb × 3–5 — If the warm-ups move well/);
  assert.match(html, /class="ex-note">Reach/);
  assert.ok(html.indexOf("Reach") < html.indexOf('data-logged'), "Reach sits above the set rows");
  assert.doesNotMatch(html, /you must/i);
});

test("rx.top_set also draws the Reach line when the composition did not split the card", () => {
  const cards = loadTodayCards();
  const html = cards.exerciseCardHtml(
    { fromPlan: true, exercise: "Back Squat", sets: 3, rep_low: 5, rep_high: 7, target_weight: 225 },
    [],
    { weight: 240, reps: 3 },
    0,
    {
      action: "overload",
      suggested: { sets: 3, rep_low: 5, rep_high: 7, weight: 225 },
      top_set: { weight: 240, reps: 3, note: "You've earned a heavier look at this one today" },
    }
  );
  assert.match(html, />Reach · 240 lb × 3 — You've earned a heavier look at this one today/);
});

test("a 1-set sibling card with a note is not labeled Reach", () => {
  const cards = loadTodayCards();
  const html = cards.exerciseCardHtml(
    {
      fromSession: true,
      exercise: "Back Squat",
      cardKey: "Back Squat::1",
      sets: 1,
      rep_low: 5,
      rep_high: 5,
      target_weight: 225,
      note: "Brace first",
    },
    [],
    { weight: 225, reps: 5 },
    0,
    null
  );
  assert.doesNotMatch(html, />Reach/);
  assert.match(html, /class="ex-note">Brace first/);
});

test("a card does not print the week's split or a copied fueling sentence", () => {
  const cards = loadTodayCards();
  const essay =
    "Your weekly split is redrawn directly around the days you actually train: lifting Monday through Friday and reserving the weekend for endurance and recovery.";
  const rdl = cards.exerciseCardHtml(
    {
      fromPlan: true,
      exercise: "Romanian Deadlift",
      sets: 2,
      rep_low: 8,
      rep_high: 10,
      target_weight: 185,
      brain_decision_id: 9,
      brain_change_summary: "Redrawn the week around the days you train.",
      brain_change_reason: essay,
      brain_change_reversible: true,
      constraint_note: "New lift — start light; add straps if grip is the limiter.",
      note: "Straps from set 2 if grip/elbow flags.",
    },
    [],
    { weight: 185, reps: 8 },
    0,
    null
  );
  assert.doesNotMatch(rdl, /weekly split is redrawn/i);
  assert.doesNotMatch(rdl, /Monday through Friday/);
  assert.doesNotMatch(rdl, /data-decision-undo/);
  assert.doesNotMatch(rdl, /Your team adjusted this exercise/);
  assert.match(rdl, /Straps from set 2/);
  assert.match(rdl, /New lift — start light/);

  const rocker = cards.exerciseCardHtml(
    {
      fromPlan: true,
      exercise: "Ankle Rocker",
      sets: 2,
      rep_low: 10,
      rep_high: 10,
      brain_decision_id: 9,
      brain_change_summary: "Loads moved up where the log earned them.",
      brain_change_reason: "You already lifted this; the weight goes up because of that, and fueling can catch up around it.",
      brain_change_reversible: true,
    },
    [],
    {},
    0,
    null
  );
  assert.doesNotMatch(rocker, /already lifted this/i);
  assert.doesNotMatch(rocker, /fueling can catch up/i);
  assert.doesNotMatch(rocker, /data-decision-undo/);

  const calf = cards.exerciseCardHtml(
    {
      fromPlan: true,
      exercise: "Standing Calf Raise",
      sets: 1,
      rep_low: 15,
      rep_high: 15,
      target_weight: 77.5,
      note: "You already lifted this; the weight goes up because of that, and fueling can catch up around it.",
    },
    [],
    { weight: 90, reps: 12 },
    0,
    null
  );
  assert.doesNotMatch(calf, /already lifted this/i);
  assert.doesNotMatch(calf, /fueling can catch up/i);
});

test("Reach line escapes athlete-authored note text", () => {
  const cards = loadTodayCards();
  const html = cards.exerciseCardHtml(
    {
      fromSession: true,
      exercise: "Press <heavy>",
      sets: 1,
      rep_low: 3,
      rep_high: 3,
      target_weight: 100,
      reach: { weight: 100, reps: 3, note: "go <after> it" },
    },
    [],
    { weight: 100, reps: 3 },
    0,
    null
  );
  assert.match(html, /go &lt;after&gt; it/);
  assert.doesNotMatch(html, /go <after> it/);
});
