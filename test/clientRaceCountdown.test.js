// The race countdown (race-countdown-{model,client}.ts, mounted by the race view's
// controller from GET /api/race-build/days) and the coach's changes on the day they
// adapted: the day view's "The coach adapted this day" block with the feed's Undo, and
// the Changes feed row's link to that day. Every word of a run, a pace or a change is
// the server's; caller strings are escaped; no score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const RACE_MODULES = [
  "html-utils",
  "ui-components",
  "ui-actions-client",
  "ui-chart",
  "format-utils",
  "ui-format",
  "race-week-model",
  "race-week-runs-model",
  "race-ladder-model",
  "race-view-model",
  "race-estimate-client",
  "race-ladder-client",
  "race-countdown-model",
  "race-countdown-client",
  "race-view-client",
  "race-view-controller",
];

const SCORE = /score|\/\s*100|\d\s*%|percent|grade|rating/i;

function change(over = {}) {
  return {
    decision_id: 41,
    title: "Lighter leg work for the race",
    why: "The race is close, so the Lower day keeps its movements at fewer sets.",
    state: "applied",
    status_line: "Landed today",
    reversible: true,
    undo: { available: true, label: "Restore the previous Lower day" },
    ...over,
  };
}

function day(date, over = {}) {
  return {
    date,
    weekday: "Mon",
    days_out: 13,
    today: false,
    race_day: false,
    status: "upcoming",
    run: null,
    lift: null,
    rest: false,
    travel: null,
    changes: [],
    ...over,
  };
}

function daysRead(over = {}) {
  return {
    available: true,
    reason: null,
    as_of: "2026-10-19",
    run_units: "mi",
    race: {
      event: "Cambridge Half",
      date: "2026-11-01",
      days_to_race: 13,
      distance_text: "13.1 mi",
      target_text: "sub-1:45",
      pace_text: "7:58–8:06 /mi",
    },
    weeks: [
      {
        week_start: "2026-10-19",
        stage_word: "Taper week",
        kind: "taper",
        focus_short: "Sharp, not tired",
        focus: "Keep the quality short and the legs fresh.",
        with_lifting: "Taper week: leg work stays on the card with fewer sets.",
        days: [
          day("2026-10-19", {
            today: true,
            status: "today",
            lift: { day_number: 3, name: "Upper back & arms", heavy_lower: false, legs_lighter: false, done: false },
          }),
          day("2026-10-22", {
            weekday: "Thu",
            days_out: 10,
            run: {
              kind: "quality",
              label: "Threshold intervals",
              status: "open",
              km: 8.4,
              mi: 5.2,
              distance_text: "5.2 mi",
              pace_text: "8:49–9:01 /mi",
              structure_text: "1.2 mi easy · 3.1 mi threshold 8:49–9:01 /mi · 1 mi easy",
              race: false,
            },
            lift: { day_number: 1, name: "Push A", heavy_lower: false, legs_lighter: false, done: false },
          }),
          day("2026-10-23", {
            weekday: "Fri",
            days_out: 9,
            run: {
              kind: "easy",
              label: "Easy run",
              status: "open",
              km: 5,
              mi: 3.1,
              distance_text: "3.1 mi",
              pace_text: "9:50–10:30 /mi",
              structure_text: null,
              race: false,
            },
            lift: { day_number: 2, name: "Lower <b>", heavy_lower: true, legs_lighter: true, done: false },
            travel: { label: "Clearwater FL" },
            changes: [change()],
          }),
          day("2026-10-24", { weekday: "Sat", days_out: 8, rest: true }),
        ],
      },
      {
        week_start: "2026-10-26",
        stage_word: "Race week",
        kind: "race",
        focus_short: "Easy runs and strides",
        focus: "Short easy runs and a few strides.",
        with_lifting: null,
        days: [
          day("2026-11-01", {
            weekday: "Sun",
            days_out: 0,
            race_day: true,
            run: {
              kind: "long",
              label: "Race day — Cambridge Half",
              status: "open",
              km: 21.1,
              mi: 13.1,
              distance_text: "13.1 mi",
              pace_text: "7:58–8:06 /mi",
              structure_text: null,
              race: true,
            },
          }),
        ],
      },
    ],
    ...over,
  };
}

function build(daysToRace) {
  return {
    available: true,
    as_of: "2026-10-19",
    race: {
      event: "Cambridge Half",
      date: "2026-11-01",
      distance_km: 21.1,
      days_to_race: daysToRace,
      weeks_to_race: 2,
      phase: "taper",
      target: { sec: 6299, pace_sec_per_km: 298, raw: "sub-1:45", kind: "time" },
      target_raw: "sub-1:45",
    },
    prediction: null,
    paces: null,
    this_week: null,
    weeks: [
      {
        week_start: "2026-10-19",
        weeks_to_race: 1,
        phase: "taper",
        kind: "taper",
        km: 30,
        long_km: 13,
        quality_hint: "",
        strength_hint: "",
        focus: "Keep the quality short.",
        focus_short: "Sharp, not tired",
        with_lifting: "Taper week.",
        current: true,
      },
      {
        week_start: "2026-10-26",
        weeks_to_race: 0,
        phase: "taper",
        kind: "race",
        km: 28,
        long_km: 21.1,
        quality_hint: "",
        strength_hint: "",
        focus: "Short easy runs.",
        focus_short: "Easy runs and strides",
        with_lifting: "Race week.",
        current: false,
      },
    ],
    leg_map: [],
    strength: null,
    ride: null,
    review: { weeks: [], longest_recent_km: 13, volume_word: "steady" },
    why: "",
    reason: null,
  };
}

// ---------- the model and the view ----------

test("the countdown model: a week's heading in its own words, a row a day, the date and days out", () => {
  const w = loadClientModule(RACE_MODULES);
  const M = w.CairnRaceCountdownModel;
  assert.equal(M.shows(build(13)), true);
  assert.equal(M.shows(build(21)), true);
  assert.equal(M.shows(build(22)), false, "farther out the ladder leads");
  assert.equal(M.shows({ available: false, race: null }), false);
  assert.equal(M.outText({ days_out: 13, race_day: false, today: true }), "Today · 13 days out");
  assert.equal(M.outText({ days_out: 1, race_day: false, today: false }), "Tomorrow");
  // The server's one wording leads when the read carries it (raceCountdown, byDay).
  assert.equal(M.outText({ days_out: 5, race_day: false, today: false, out_words: "5 days out" }), "5 days out");
  assert.equal(M.outText({ days_out: 12, race_day: false, today: true, out_words: "12 days out" }), "Today · 12 days out");
  assert.equal(M.outText({ days_out: 0, race_day: true, today: false }), "Race day");
  // The eve, seen ON the eve: today's row never pairs "Today" with a word naming another day.
  assert.equal(M.outText({ days_out: 1, race_day: false, today: true, out_words: "Tomorrow" }), "Today · 1 day out");
  assert.equal(M.outText({ days_out: 1, race_day: false, today: true }), "Today · 1 day out");
  assert.equal(M.outText({ days_out: 1, race_day: false, today: false, out_words: "Tomorrow" }), "Tomorrow");
  assert.equal(M.dayDate("2026-10-23"), "Fri Oct 23");

  const model = M.countdownModel(daysRead());
  assert.equal(model.weeks.length, 2);
  assert.equal(model.weeks[0].title, "Taper week · Sharp, not tired");
  assert.equal(model.weeks[0].focus, "Keep the quality short and the legs fresh.");
  const fri = model.weeks[0].rows.find((r) => r.date === "2026-10-23");
  assert.equal(fri.run.figure, "3.1 mi · 9:50–10:30 /mi");
  assert.deepEqual([...fri.lift.marks], ["legs lighter"]);
  assert.equal(fri.travel, "Travelling · Clearwater FL");
  assert.deepEqual([...fri.adapted], ["Lighter leg work for the race"]);
  assert.equal(M.countdownModel(daysRead({ available: false, race: null, weeks: [] })), null);
  assert.equal(M.countdownModel(null), null);
});

test("the countdown view: every row opens its day; race day is its own row; strings are escaped", () => {
  const w = loadClientModule(RACE_MODULES);
  const model = w.CairnRaceCountdownModel.countdownModel(daysRead());
  const host = renderHtml(w.CairnRaceCountdown.countdownHtml(model), { document: w.document });
  const rows = Array.from(host.querySelectorAll(".race-cd-day"));
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((r) => r.querySelector(".race-cd-open").getAttribute("data-open-day")),
    ["2026-10-19", "2026-10-22", "2026-10-23", "2026-10-24", "2026-11-01"]
  );
  // The link target is the row's own block, focusable and named by the row's words.
  const open = rows[1].querySelector(".race-cd-open");
  assert.equal(open.getAttribute("role"), "link");
  assert.equal(open.getAttribute("tabindex"), "0");
  assert.ok(open.querySelector(".race-cd-body"), "the row's words sit inside its link");
  assert.ok(rows[0].classList.contains("is-today"));
  assert.equal(rows[0].getAttribute("aria-current"), "date");
  assert.equal(rows[0].querySelector(".race-cd-out").textContent, "Today · 13 days out");
  const thu = rows[1];
  assert.equal(thu.querySelector(".race-cd-run .race-cd-what").textContent, "Threshold intervals");
  assert.equal(thu.querySelector(".race-cd-parts").textContent, "1.2 mi easy · 3.1 mi threshold 8:49–9:01 /mi · 1 mi easy");
  const fri = rows[2];
  assert.ok(fri.classList.contains("is-adapted"));
  assert.equal(fri.querySelector(".race-cd-lift .race-cd-what").textContent, "Lower <b>", "escaped, never markup");
  assert.equal(fri.querySelector(".race-cd-lift b"), null);
  assert.equal(fri.querySelector(".race-cd-mark.is-lighter").textContent, "legs lighter");
  assert.equal(fri.querySelector(".race-cd-travel").textContent, "Travelling · Clearwater FL");
  assert.match(fri.querySelector(".race-cd-adapted").textContent, /Adapted\s+Lighter leg work for the race/);
  assert.equal(fri.querySelector("button"), null, "a row that opens a day holds no button (Undo lives on the day)");
  assert.ok(rows[3].classList.contains("is-rest"));
  assert.equal(rows[3].querySelector(".race-cd-rest").textContent, "Rest");
  const race = rows[4];
  assert.ok(race.classList.contains("is-race"));
  assert.equal(race.querySelector(".race-cd-out").textContent, "Race day");
  assert.equal(race.querySelector(".race-cd-race-name").textContent.trim(), "Cambridge Half");
  assert.deepEqual(
    Array.from(race.querySelectorAll(".race-cd-fact")).map((f) => f.textContent),
    ["13.1 mi", "Target sub-1:45", "Race pace 7:58–8:06 /mi"]
  );
  assert.doesNotMatch(host.textContent, SCORE);
  assert.doesNotMatch(host.textContent, /remov/i, "adapted, never removed");
});

// ---------- the controller ----------

test("within three weeks the race view leads with the countdown, read once, and next week stands down", async () => {
  const w = loadClientModule(RACE_MODULES);
  const host = createHost(w.document);
  let reads = 0;
  w.CairnRaceViewController.mount(host, {
    initial: build(13),
    load: async () => build(13),
    nextWeekHtml: `<section class="race-next">Next week</section>`,
    loadDays: async () => {
      reads++;
      return daysRead();
    },
  });
  const slot = host.querySelector("[data-race-countdown]");
  assert.ok(slot, "the slot sits under the race");
  assert.ok(host.querySelector(".race-next"), "next week shows until the countdown has painted");
  await flush();
  await flush();
  assert.equal(reads, 1);
  assert.equal(host.querySelector(".race-next"), null, "the countdown now says next week day by day");
  assert.equal(host.querySelectorAll(".race-cd-day").length, 5);
  const order = Array.from(host.querySelector(".race-view").children).map((el) => el.className);
  assert.ok(order[0].includes("race-view-head") && order[1].includes("race-countdown-slot"), "right under the race");
});

test("a countdown that cannot be read leaves next week standing", async () => {
  const w = loadClientModule(RACE_MODULES);
  const host = createHost(w.document);
  w.CairnRaceViewController.mount(host, {
    initial: build(13),
    load: async () => build(13),
    nextWeekHtml: `<section class="race-next">Next week</section>`,
    loadDays: async () => {
      throw new Error("offline");
    },
  });
  await flush();
  await flush();
  assert.equal(host.querySelector("[data-race-countdown]"), null);
  assert.ok(host.querySelector(".race-next"), "next week is not lost with the countdown");
});

test("farther out the weekly ladder leads and no countdown is read; an empty read takes the slot away", async () => {
  const w = loadClientModule(RACE_MODULES);
  const far = createHost(w.document);
  let reads = 0;
  w.CairnRaceViewController.mount(far, {
    initial: build(40),
    load: async () => build(40),
    nextWeekHtml: `<section class="race-next">Next week</section>`,
    loadDays: async () => {
      reads++;
      return daysRead();
    },
  });
  await flush();
  assert.equal(reads, 0);
  assert.equal(far.querySelector("[data-race-countdown]"), null);
  assert.ok(far.querySelector(".race-next"), "next week keeps its own section");

  const empty = createHost(w.document);
  w.CairnRaceViewController.mount(empty, {
    initial: build(13),
    load: async () => build(13),
    loadDays: async () => ({ available: false, reason: "The race has been run.", weeks: [], race: null }),
  });
  await flush();
  await flush();
  assert.equal(empty.querySelector("[data-race-countdown]"), null);
  assert.ok(empty.querySelector(".race-view"), "the rest of the page stands");
});

// ---------- the coach adapted this day ----------

function dayDetail(over = {}) {
  return {
    date: "2026-10-23",
    weekday: "Fri",
    today: "2026-10-19",
    status: "upcoming",
    placed: true,
    focus: "Lower · Easy run",
    headline: "A Lower day, then an easy run.",
    why: null,
    week: { week_start: "2026-10-19", race: null, block: null },
    lift: null,
    run: null,
    watch: [],
    stack: null,
    done: null,
    caveats: [],
    changes: [change({ title: "Lighter leg work <i>for</i> the race" })],
    run_units: "mi",
    ...over,
  };
}

function loadDay(globals = {}) {
  return loadClientModule(
    [
      "html-utils",
      "ui-format",
      "format-utils",
      "ui-actions-client",
      "ui-reads",
      "decision-undo-client",
      "decision-undo-controller",
      "day-detail-model",
      "day-glance-model",
      "day-detail-run-client",
      "day-detail-client",
    ],
    { globals }
  );
}

test("a day the coach adapted says so, in the feed's words, with the feed's Undo", () => {
  const w = loadDay();
  const host = renderHtml(w.CairnDayDetailView.dayDetailHtml(dayDetail()), { document: w.document });
  const block = host.querySelector(".ddv-adapted");
  assert.ok(block);
  assert.equal(block.querySelector(".ddv-h").textContent, "The coach adapted this day");
  assert.equal(block.querySelector(".ddv-stack-t").textContent, "Lighter leg work <i>for</i> the race");
  assert.equal(block.querySelector("i"), null, "escaped");
  assert.match(block.querySelector(".ddv-why-t").textContent, /fewer sets/);
  const undo = block.querySelector("[data-ddv-undo]");
  assert.equal(undo.getAttribute("data-ddv-undo"), "41");
  assert.equal(undo.textContent, "Restore the previous Lower day");
  assert.doesNotMatch(block.textContent, /remov/i);

  // Under Today's strip (and Horizon's peek) the button carries the same attribute: the day-detail controller wires it on its own host.
  const inline = renderHtml(w.CairnDayDetailView.dayDetailHtml(dayDetail(), { inline: true }), { document: w.document });
  assert.ok(inline.querySelector(".ddv-adapted [data-ddv-undo='41']"));
  assert.equal(inline.querySelector("[data-decision-undo]"), null, "Today's own Undo handler never double-takes it");

  // No change, or an Undo the server says is gone: no block / no button.
  const none = renderHtml(w.CairnDayDetailView.dayDetailHtml(dayDetail({ changes: [] })), { document: w.document });
  assert.equal(none.querySelector(".ddv-adapted"), null);
  const legacy = renderHtml(w.CairnDayDetailView.dayDetailHtml(dayDetail({ changes: undefined })), { document: w.document });
  assert.equal(legacy.querySelector(".ddv-adapted"), null, "an older read without the field");
  const gone = renderHtml(
    w.CairnDayDetailView.dayDetailHtml(dayDetail({ changes: [change({ undo: { available: false, label: null } })] })),
    { document: w.document }
  );
  assert.ok(gone.querySelector(".ddv-adapted"));
  assert.equal(gone.querySelector("[data-ddv-undo]"), null);
});

test("a Changes feed row links the day it adapted, when the server knows it", () => {
  const w = loadClientModule([
    "html-utils",
    "ui-components",
    "ui-actions-client",
    "decision-undo-client",
    "decision-undo-controller",
    "changes-feed-client",
  ]);
  const row = {
    id: 41,
    day: "2026-10-19",
    state: "applied",
    domain: "training",
    title: "Lighter leg work for the race",
    why: null,
    status_line: "Landed today",
    lands_on: null,
    outcome: { key: "too_early", phrase: "we can't tell yet" },
    confidence: "tentative",
    undo: { available: false, label: null },
    new: false,
  };
  const linked = renderHtml(w.CairnChangesFeed.rowHtml({ ...row, open_day: "2026-10-23" }), { document: w.document });
  const link = linked.querySelector("[data-open-day]");
  assert.equal(link.getAttribute("data-open-day"), "2026-10-23");
  assert.equal(link.textContent, "See Friday, Oct 23");
  const plain = renderHtml(w.CairnChangesFeed.rowHtml(row), { document: w.document });
  assert.equal(plain.querySelector("[data-open-day]"), null);
  const bad = renderHtml(w.CairnChangesFeed.rowHtml({ ...row, open_day: "<x>" }), { document: w.document });
  assert.equal(bad.querySelector("[data-open-day]"), null);
});

// ---------- wave 2: "What if I move this?" on the countdown's days ----------

test("each upcoming day offers 'What if I move this?', which opens Ask with the question started; race, rest and done days do not", async () => {
  const asked = [];
  const w = loadClientModule(RACE_MODULES, { globals: { gotoChatWith: (text) => asked.push(text) } });
  const host = createHost(w.document);
  w.CairnRaceViewController.mount(host, { initial: build(13), load: async () => build(13), loadDays: async () => daysRead() });
  await flush();
  await flush();
  const buttons = host.querySelectorAll("button[data-race-whatif]");
  assert.equal(buttons.length, 3, "today, Thursday and Friday; not Saturday's rest nor race day");
  const thursday = host.querySelector('.race-cd-day[data-race-cd-day="2026-10-22"] button[data-race-whatif]');
  // A sibling of the day's link, never a control nested inside an element with role="link".
  assert.equal(thursday.closest('[role="link"]'), null);
  assert.equal(thursday.closest("[data-open-day]"), null);
  assert.equal(host.querySelectorAll('[role="link"] button').length, 0);
  assert.equal(thursday.textContent, "What if I move this?");
  assert.equal(thursday.getAttribute("aria-label"), "What if I move Thursday Threshold intervals?");
  let opened = 0;
  w.document.addEventListener("click", () => opened++);
  await thursday.click();
  assert.deepEqual(asked, ["What if I move Thursday Threshold intervals to …?"]);
  assert.equal(opened, 0, "the tap stays on the button; it does not also open the day");
});

test("a whole-week layout is said once, on the week's heading — never on each day", () => {
  const w = loadClientModule(RACE_MODULES);
  const read = daysRead();
  read.weeks[0].changes = [change({ decision_id: 77, title: "Reshaped <your> training week" })];
  const model = w.CairnRaceCountdownModel.countdownModel(read);
  assert.deepEqual([...model.weeks[0].adapted], ["Reshaped <your> training week"]);
  assert.deepEqual([...model.weeks[1].adapted], [], "another week never carries it");
  const host = renderHtml(w.CairnRaceCountdown.countdownHtml(model), { document: w.document });
  const heads = Array.from(host.querySelectorAll(".race-cd-week-head .race-cd-adapted"));
  assert.equal(heads.length, 1);
  assert.match(heads[0].textContent, /Adapted Reshaped <your> training week/, "escaped, never markup");
  const dayLines = Array.from(host.querySelectorAll(".race-cd-day .race-cd-adapted")).map((n) => n.textContent);
  assert.ok(!dayLines.some((t) => /Reshaped/.test(t)), "no day row repeats the week's change");
});
