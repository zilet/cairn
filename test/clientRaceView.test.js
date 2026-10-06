// The race view (race-view-model/-client/-controller, race-ladder-client,
// race-estimate-client; docs/V2-PLAN.md wave 4). A read over GET /api/race-build and
// never a second engine: the ladder's weeks and kilometres ARE the fixture build's,
// the taper and race week read as the server's kinds, run volume is km per week
// whatever the pace units, and the finish estimate is a fit word — never a score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";
import { repo, resetTables } from "./_seed.js";
import { raceBuild } from "../dist/repo/race-build.js";

const MODULES = [
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
  "race-view-client",
  "race-view-controller",
];

function load(globals = {}) {
  return loadClientModule(MODULES, { globals });
}

const WEEKS = [
  ["2026-09-14", 7, "build", "build", 32, 13, true],
  ["2026-09-21", 6, "build", "down", 26, 13, false],
  ["2026-09-28", 5, "build", "build", 35.5, 15, false],
  ["2026-10-05", 4, "sharpen", "build", 38, 16, false],
  ["2026-10-12", 3, "sharpen", "peak", 40, 18, false],
  ["2026-10-19", 2, "taper", "peak", 36, 16, false],
  ["2026-10-26", 1, "taper", "taper", 28, 12, false],
  ["2026-11-02", 0, "taper", "race", 30, 21.1, false],
].map(([week_start, weeks_to_race, phase, kind, km, long_km, current]) => ({
  week_start,
  weeks_to_race,
  phase,
  kind,
  km,
  long_km,
  quality_hint: "One quality session.",
  strength_hint: "Heavy legs early in the week.",
  focus: kind === "race" ? "Short easy runs and a few strides." : `The ${kind} week's focus.`,
  focus_short: kind === "race" ? "Easy runs and strides" : `${kind} focus`,
  with_lifting:
    kind === "taper"
      ? "Taper week: leg work stays on the card with fewer sets at a lighter weight."
      : kind === "race"
        ? "Race week: heavy leg work sits out."
        : "Lower B on Friday is the last lift before Sunday's long run.",
  current,
}));

function build(overrides = {}) {
  return {
    available: true,
    as_of: "2026-09-16",
    race: {
      event: "Riverside Half",
      date: "2026-11-08",
      distance_km: 21.1,
      days_to_race: 53,
      // The server's rounded-up day count (ceil(53 / 7)); the ladder's calendar count is 7.
      weeks_to_race: 8,
      phase: "build",
      target: { sec: 7199, pace_sec_per_km: 341, raw: "sub-2:00", kind: "time" },
      target_raw: "sub-2:00",
    },
    prediction: {
      estimate_sec: 7470,
      estimate_pace_sec_per_km: 354,
      basis: "watch_predictor",
      basis_detail: "the watch's race predictor",
      as_of: "2026-09-15",
      trend: { delta_sec: -130, since: "2026-08-18", word: "faster" },
      gap_sec: 271,
      fit: "stretch",
    },
    paces: {
      anchored_on: "estimate",
      race_pace_sec_per_km: 341,
      bands: [
        { key: "race", label: "Race pace", slow_sec_per_km: 345, fast_sec_per_km: 338, text: "5:38–5:45 /km" },
        {
          key: "easy",
          label: "Easy",
          slow_sec_per_km: 420,
          fast_sec_per_km: 390,
          text: "6:30–7:00 /km",
          hr_ceiling_bpm: 150,
        },
      ],
    },
    this_week: { week_start: "2026-09-14", km: 32, long_km: 13, logged_km: 18, quality: null, why: "Build week." },
    weeks: WEEKS,
    leg_map: [],
    strength: {
      heavy_lower_days: ["Monday"],
      principle: "Heavy legs stay two days off the long run.",
      layout: null,
      clean: true,
    },
    ride: null,
    review: { weeks: [], longest_recent_km: 13, volume_word: "steady" },
    // The server's why carries the estimate sentence, gap and all; the view never prints it.
    why: "8 weeks to Riverside Half: this week is 32 km with a 13 km long run. Current shape reads about 2:04:30 (5:54 /km), 2 min faster over the last month — 4:31 off the 1:59:59 target, a stretch the build can close.",
    reason: null,
    ...overrides,
  };
}

const SCORE = /score|\/\s*100|\d\s*%|percent|grade|rating|\bA\+|\bB-/i;

function paint(win, data, opts = {}) {
  const model = win.CairnRaceViewModel.viewModel(data, opts);
  return renderHtml(win.CairnRaceView.viewHtml(model, opts), { document: win.document });
}

// ---------- the ladder ----------

test("the ladder's weeks and km equal the build's own weeks, in order", () => {
  const win = load();
  const host = paint(win, build());
  const rows = host.querySelectorAll(".race-ladder-row");
  assert.equal(rows.length, WEEKS.length);
  rows.forEach((row, i) => {
    assert.equal(row.getAttribute("data-race-week"), WEEKS[i].week_start);
    const km = WEEKS[i].km;
    // The live week reads what the log holds of its plan; every other week its plan.
    assert.equal(row.querySelector(".race-ladder-km").textContent, WEEKS[i].current ? `18 of ${km} km` : `${km} km`);
    // Each bar is that week's km against the ladder's longest week (40 km here).
    assert.equal(Number(row.style.getPropertyValue("--frac")), Math.round((km / 40) * 1000) / 1000);
  });
  assert.equal(rows[0].querySelector(".race-ladder-out").textContent, "7 wk out");
  assert.equal(rows[rows.length - 1].querySelector(".race-ladder-out").textContent, "Race week");
});

test("the current week is marked in words and by aria-current, and carries what has been run", () => {
  const win = load();
  const host = paint(win, build());
  const current = host.querySelectorAll("[aria-current]");
  assert.equal(current.length, 1);
  const row = current[0];
  assert.ok(row.classList.contains("is-current"));
  assert.equal(row.querySelector(".race-ladder-here").textContent, "This week");
  // The row speaks its focus in a few words; what has been run lives in THIS WEEK.
  assert.equal(row.querySelector(".race-ladder-foot").textContent, "build focus");
  assert.equal(Number(row.querySelector(".race-ladder-logged").style.getPropertyValue("--frac")), 0.45);
  // Only this week has a logged fill.
  assert.equal(host.querySelectorAll(".race-ladder-logged").length, 1);
});

test("THIS WEEK: the kicker, the stage as the headline, the focus as its one detail, the volume, the runs", () => {
  const win = load();
  const host = paint(win, build(), { sessionsHtml: `<ol class="race-runs"><li>Thursday tempo</li></ol>` });
  const card = host.querySelector(".race-week");
  assert.ok(card, "the one focal card");
  // The head already says "7 weeks to race": the kicker does not say it again.
  assert.equal(card.querySelector(".race-week-head .lbl").textContent, "This week · Build");
  // No server sentence in this payload: the stage word is the headline, the focus the detail.
  assert.equal(card.querySelector(".race-week-stage").textContent, "Build");
  assert.equal(card.querySelector(".race-week-focus").textContent, "The build week's focus.");
  assert.equal(card.querySelector(".race-week-num").textContent, "18 km · plan 32");
  // No runs to split the log by: one plain segment of it, the plan's tick at the end.
  const segs = card.querySelectorAll(".race-week-seg");
  assert.equal(segs.length, 1);
  assert.equal(Number(segs[0].style.getPropertyValue("--frac")), 0.563);
  assert.equal(Number(card.querySelector(".race-week-tick").style.getPropertyValue("--frac")), 1);
  assert.equal(card.querySelector(".race-week-long").textContent, "Long run 13 km");
  // The page hands in the week's runs; the card places them under the volume.
  assert.match(card.querySelector(".race-runs").textContent, /Thursday tempo/);
  // It comes first: before the ladder, the lifting and the estimate.
  const order = ["race-week", "race-ladder", "race-lifting", "race-estimate"].map((cls) =>
    host.innerHTML.indexOf(`class="${cls}`)
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order
  );
  assert.ok(order.every((i) => i >= 0));
});

test("a week run past its plan shows the overflow; nothing run yet says nothing (never a zero)", () => {
  const win = load();
  const banked = paint(win, build({ this_week: { ...build().this_week, logged_km: 33.4 } }));
  assert.equal(banked.querySelector(".race-week-num").textContent, "33.4 km · plan 32");
  // The bar scales to the bigger of the two, so the plan's tick sits inside it.
  assert.ok(banked.querySelector(".race-week-bar.is-over"));
  assert.equal(Number(banked.querySelector(".race-week-tick").style.getPropertyValue("--frac")), 0.958);
  assert.equal(Number(banked.querySelector(".race-ladder-logged").style.getPropertyValue("--frac")), 0.835);
  assert.equal(banked.querySelector(".is-current .race-ladder-km").textContent, "33.4 of 32 km");
  const none = paint(win, build({ this_week: { ...build().this_week, logged_km: 0 } }));
  // The target is named as the plan, never "32 km this week" over an empty bar (which
  // read as done).
  assert.equal(none.querySelector(".race-week-num").textContent, "32 km planned");
  assert.equal(none.querySelector(".race-week-seg"), null);
  assert.equal(none.querySelector(".race-ladder-logged"), null);
  assert.doesNotMatch(none.querySelector(".race-week").textContent, /\b0 (of|km)\b/);
  assert.doesNotMatch(none.querySelector(".is-current").textContent, /\b0 km\b/);
});

test("with your lifting: a run of weeks saying the same thing is one row; taper and race week their own", () => {
  const win = load();
  const host = paint(win, build());
  const rows = host.querySelectorAll(".race-lifting-row");
  assert.deepEqual(
    rows.map((row) => row.querySelector(".race-lifting-when").textContent),
    ["This week – Oct 19", "Oct 26 · Taper", "Nov 2 · Race"]
  );
  assert.ok(rows[0].classList.contains("is-current"));
  assert.match(rows[1].textContent, /fewer sets at a lighter weight/);
  // A running-only athlete (no lifting lines) gets no section at all.
  const bare = paint(win, build({ weeks: WEEKS.map((w) => ({ ...w, with_lifting: "" })) }));
  assert.equal(bare.querySelector(".race-lifting"), null);
});

test("the taper and race week read as the server's kinds, with race day on race week", () => {
  const win = load();
  const host = paint(win, build());
  const kinds = host
    .querySelectorAll(".race-ladder-row")
    .map((row) => row.querySelector(".race-ladder-word").textContent);
  // A turning point by its kind, a build week by its phase (the stage word).
  assert.deepEqual(kinds, ["Build", "Down week", "Build", "Sharpen", "Peak", "Peak", "Taper", "Race"]);
  const taper = host.querySelectorAll(".race-ladder-row.is-taper");
  assert.equal(taper.length, 1);
  assert.equal(taper[0].getAttribute("data-race-week"), "2026-10-26");
  const race = host.querySelector(".race-ladder-row.is-race");
  assert.equal(race.querySelector(".race-ladder-foot").textContent, "Race day, Sunday, Nov 8");
  assert.match(host.querySelector(".race-ladder-taper").textContent, /taper starts the week of Oct 26/);
});

test("a taper week that is this week says so", () => {
  const win = load();
  const weeks = WEEKS.slice(6).map((w, i) => ({ ...w, current: i === 0 }));
  const host = paint(win, build({ weeks, this_week: { ...build().this_week, km: 28, logged_km: 5 } }));
  assert.match(host.querySelector(".race-ladder-taper").textContent, /This week is the taper/);
});

test("run volume and paces both follow the athlete's run units", () => {
  const win = load();
  const host = paint(win, build(), { units: "mi" });
  for (const km of host.querySelectorAll(".race-ladder-km"))
    assert.match(km.textContent, /^(\d+(\.\d)? of )?\d+(\.\d)? mi$/);
  assert.equal(host.querySelector(".race-week-num").textContent, "11.2 mi · plan 19.9");
  assert.equal(host.querySelector(".race-week-long").textContent, "Long run 8.1 mi");
  assert.doesNotMatch(host.querySelector(".race-week").textContent, /\bkm\b/);
  assert.equal(host.querySelector("[data-run-units]"), null, "no per-surface unit switch: Settings owns units");
  assert.doesNotMatch(host.querySelector(".race-ladder").textContent, /\bkm\b/);
  assert.equal(host.querySelector(".race-ladder-unit").textContent, "mi per week");
  assert.match(host.querySelector(".race-view-pace dd").textContent, /\/mi/);
  const metric = paint(win, build());
  assert.equal(metric.querySelector(".race-ladder-unit").textContent, "km per week");
  for (const km of metric.querySelectorAll(".race-ladder-km"))
    assert.match(km.textContent, /^(\d+(\.\d)? of )?\d+(\.\d)? km$/);
});

test("a bigger week set aside is said above the ladder, in the athlete's units", () => {
  const win = load();
  const capacity = {
    floor_km: 23.4,
    floor_week_start: "2026-09-07",
    best_week_km: 32.5,
    set_aside: [{ week_start: "2026-09-14", km: 32.5, kind: "physiology_brake" }],
    note: "Your 32.5 km week had a rough night after it, with HRV well under your usual, so the build climbs from your 23.4 km week.",
  };
  const metric = paint(win, build({ capacity }));
  const line = metric.querySelector(".race-ladder-capacity");
  assert.equal(line.textContent, capacity.note);
  assert.doesNotMatch(line.textContent, SCORE);
  const miles = paint(win, build({ capacity }), { units: "mi" });
  assert.equal(
    miles.querySelector(".race-ladder-capacity").textContent,
    "Your 20.2 mi week had a rough night after it, with HRV well under your usual, so the build climbs from your 14.5 mi week."
  );
  // Nothing set aside, nothing said — and an older payload without the field says nothing.
  assert.equal(
    paint(win, build({ capacity: { ...capacity, set_aside: [], note: "" } })).querySelector(".race-ladder-capacity"),
    null
  );
  assert.equal(paint(win, build()).querySelector(".race-ladder-capacity"), null);
});

test("a server sentence restates a range whole in miles, never half of it", () => {
  const { runWords } = load().CairnRaceViewModel;
  assert.equal(runWords("easy at 5:10–5:40 /km", "mi"), "easy at 8:19–9:07 /mi");
  assert.equal(runWords("tempo 6:10-6:40/km", "mi"), "tempo 9:55-10:44 /mi");
  assert.equal(runWords("a long run of 10–12 km", "mi"), "a long run of 6.2–7.5 mi");
  assert.equal(runWords("your 16 km run (5:10 /km)", "mi"), "your 9.9 mi run (8:19 /mi)");
  assert.equal(runWords("easy at 5:10–5:40 /km", "km"), "easy at 5:10–5:40 /km", "km reads as written");
});

// ---------- the live week: Cambridge Half, Sunday 2026-10-04 ----------

// The athlete's real read on the morning of Oct 4, trimmed to what the page reads: a
// 19.5 km plan, 35.8 km run over four runs (one the agenda matched to nothing), the
// long run shortened to 8 km by the morning's call and run as 13.5.
const CAMBRIDGE_WEEKS = [
  ["2026-09-28", 4, "sharpen", "build", 19.5, 10.7, "Threshold work, volume holds", true],
  ["2026-10-05", 3, "sharpen", "build", 32.1, 16.8, "Race-pace work", false],
  ["2026-10-12", 2, "sharpen", "peak", 36.3, 19.5, "A new weekly high", false],
  ["2026-10-19", 1, "taper", "taper", 23.2, 10.7, "Less volume, speed kept", false],
  ["2026-10-26", 0, "taper", "race", 10.4, 5.7, "Easy runs and strides", false],
].map(([week_start, weeks_to_race, phase, kind, km, long_km, focus_short, current]) => ({
  week_start,
  weeks_to_race,
  phase,
  kind,
  km,
  long_km,
  quality_hint: "",
  strength_hint: "",
  focus:
    kind === "build" && current ? "Sharpen rather than add: threshold work while the volume holds." : `${focus_short}.`,
  focus_short,
  with_lifting: "",
  current,
}));

function cambridge(overrides = {}) {
  return build({
    as_of: "2026-10-04",
    race: {
      event: "Cambridge Half Marathon",
      date: "2026-11-01",
      distance_km: 21.1,
      days_to_race: 28,
      weeks_to_race: 4,
      phase: "sharpen",
      target: { sec: 7200, pace_sec_per_km: 341, raw: "sub-2:00 target; 1:50 stretch", kind: "time" },
      target_raw: "sub-2:00 target; 1:50 stretch",
    },
    prediction: {
      estimate_sec: 6842,
      estimate_pace_sec_per_km: 324,
      basis: "watch_predictor",
      basis_detail: "your watch's half-marathon prediction, adjusted to 21.1 km",
      as_of: "2026-10-04",
      trend: { delta_sec: -769, since: "2026-09-06", word: "faster" },
      gap_sec: -358,
      fit: "fits",
    },
    this_week: { week_start: "2026-09-28", km: 19.5, long_km: 10.7, logged_km: 35.8, quality: null, why: "" },
    weeks: CAMBRIDGE_WEEKS,
    leg_map: [
      {
        day_number: 2,
        weekday: "Tuesday",
        run: { kind: "easy", label: "Easy run", km: 4.8 },
        strength: null,
        ride: false,
        hard: false,
      },
      {
        day_number: 4,
        weekday: "Thursday",
        run: { kind: "quality", label: "Short threshold", km: 4 },
        strength: null,
        ride: false,
        hard: true,
      },
      {
        day_number: 7,
        weekday: "Sunday",
        run: { kind: "long", label: "Long run", km: 10.7 },
        strength: null,
        ride: false,
        hard: true,
      },
    ],
    capacity: { floor_km: 32.5, floor_week_start: "2026-09-14", best_week_km: 32.5, set_aside: [], note: "" },
    review: {
      weeks: [
        { week_start: "2026-08-31", km: 10.9, runs: 2 },
        { week_start: "2026-09-07", km: 23.4, runs: 3 },
        { week_start: "2026-09-14", km: 32.5, runs: 3 },
        { week_start: "2026-09-21", km: 19.5, runs: 3 },
      ],
      longest_recent_km: 17.7,
      volume_word: "rising",
    },
    ...overrides,
  });
}

// The agenda as it reads today: three intents closed by the watch's grading (every run
// "quality"), Friday's hill sprints matched to nothing and so absent.
const CAMBRIDGE_AGENDA = {
  available: true,
  week_start: "2026-09-28",
  week_end: "2026-10-04",
  as_of: "2026-10-04",
  intents: [
    {
      id: "e",
      kind: "easy",
      label: "Easy run",
      status: "completed",
      provisional_day_number: 2,
      target_distance_km: 4.8,
      completion: {
        activity_id: 111,
        date: "2026-09-30",
        duration_min: 39.9,
        distance_km: 6.63,
        intensity: "quality",
        signals: ["watch effort: tempo"],
      },
    },
    {
      id: "q",
      kind: "quality",
      label: "Short threshold",
      status: "completed",
      provisional_day_number: 4,
      target_distance_km: 4,
      completion: {
        activity_id: 110,
        date: "2026-09-29",
        duration_min: 53.9,
        distance_km: 9.68,
        intensity: "quality",
        signals: ["watch effort: lactate threshold"],
      },
    },
    {
      id: "l",
      kind: "long",
      label: "Long run · shorter",
      status: "completed",
      provisional_day_number: 7,
      target_distance_km: 8,
      completion: {
        activity_id: 114,
        date: "2026-10-04",
        duration_min: 83.8,
        distance_km: 13.54,
        intensity: "quality",
        signals: ["watch effort: tempo"],
      },
      adjustment: {
        date: "2026-10-04",
        planned_kind: "long",
        planned_dose: "full",
        kind: "long",
        dose: "shortened",
        target_distance_km: 8,
        reason_code: "floor:hrv_below_own_band",
        changed: true,
        why: "HRV is still settling below your usual — a shorter, easy long run today.",
      },
    },
  ],
  next: null,
  today_guidance: "complete",
  why: "",
};

// A sandbox value as a plain host value (deepEqual compares prototypes).
const plain = (value) => JSON.parse(JSON.stringify(value));

function paintLive(win, data, opts = {}) {
  const model = win.CairnRaceViewModel.viewModel(data, { agenda: CAMBRIDGE_AGENDA, ...opts });
  return renderHtml(win.CairnRaceView.viewHtml(model, opts), { document: win.document });
}

test("live week, an older payload: the card says what was run against the plan, overflow and all", () => {
  const win = load();
  const host = paintLive(win, cambridge());
  assert.equal(host.querySelector(".race-view-when").textContent, "4 weeks to race · Sunday, Nov 1");
  assert.equal(
    host.querySelector(".race-view-fit").textContent,
    "Reads about 1:54 · inside sub-2:00 · 13 min faster in the last month"
  );
  const card = host.querySelector(".race-week");
  assert.equal(card.querySelector(".race-week-head .lbl").textContent, "This week · Sharpen");
  assert.equal(card.querySelector(".race-week-stage").textContent, "Sharpen");
  assert.equal(card.querySelector(".race-week-num").textContent, "35.8 km · plan 19.5");
  // One segment per run the agenda holds, in its tone, and the part no read took (Friday's
  // 6 km) still fills its share: the log is the truth for the total.
  const segs = card.querySelectorAll(".race-week-seg");
  assert.deepEqual(
    segs.map((seg) => [...seg.classList].filter((c) => c.startsWith("is-")).join(" ")),
    ["is-quality", "is-easy", "is-long", "is-easy is-extra"]
  );
  const sum = segs.reduce((total, seg) => total + Number(seg.style.getPropertyValue("--frac")), 0);
  assert.ok(Math.abs(sum - 1) < 0.01, `the segments fill the bar (${sum})`);
  const bar = card.querySelector(".race-week-bar");
  assert.ok(bar.classList.contains("is-over"));
  assert.equal(bar.getAttribute("role"), "img");
  assert.match(
    bar.getAttribute("aria-label"),
    /^35\.8 km, plan 19\.5: Tue 9\.7 km quality; Wed 6\.6 km easy; Sun 13\.5 km long$/
  );
  assert.equal(Number(card.querySelector(".race-week-tick").style.getPropertyValue("--frac")), 0.545);
  // Colour is never the only cue: the tones drawn are named in words, the unmatched part too.
  assert.deepEqual(
    card.querySelectorAll(".race-week-key-item").map((item) => item.textContent),
    ["easy", "quality", "long", "extra"]
  );
  // Runs are in, so the planned long run is the rows' to say, not the card's.
  assert.equal(card.querySelector(".race-week-long"), null);
  // The watch's grade never reaches the page.
  assert.doesNotMatch(host.textContent, /tempo|lactate|watch effort/);
});

test("live week: the runs are actual first, the plan second, the morning's call said honestly", () => {
  const win = load();
  const runs = win.CairnRaceWeekRuns.weekRuns(cambridge(), CAMBRIDGE_AGENDA, "km");
  assert.deepEqual(
    plain(
      runs.map((run) => [
        run.when,
        run.km_text,
        run.pace_text,
        run.tone,
        run.planned_text,
        run.adjust_text,
        run.effort_word,
      ])
    ),
    [
      ["Tue", "9.7 km", "5:34/km", "quality", "planned: quality 4 km", "", ""],
      ["Wed", "6.6 km", "6:01/km", "easy", "planned: easy 4.8 km", "", ""],
      ["Sun", "13.5 km", "6:11/km", "long", "planned: long 10.7 km", "shortened to 8 km this morning", ""],
    ]
  );
  const miles = win.CairnRaceWeekRuns.weekRuns(cambridge(), CAMBRIDGE_AGENDA, "mi");
  assert.equal(miles[2].adjust_text, "shortened to 5 mi this morning");
  assert.equal(miles[2].pace_text, "9:58/mi");
});

test("live week: the ladder sets the closed weeks above this one, solid, with a quiet now between", () => {
  const win = load();
  const host = paintLive(win, cambridge());
  const rows = host.querySelectorAll(".race-ladder-row");
  assert.deepEqual(
    rows.map((row) => row.getAttribute("data-race-week")),
    ["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]
  );
  const done = rows.filter((row) => row.classList.contains("is-done"));
  assert.deepEqual(
    done.map((row) => row.querySelector(".race-ladder-km").textContent),
    ["23.4 km", "32.5 km", "19.5 km"]
  );
  // A closed week is an actual: a solid bar, no plan outline, its runs counted.
  assert.ok(done[1].querySelector(".race-ladder-logged"));
  assert.equal(done[1].querySelector(".race-ladder-bar"), null);
  assert.equal(done[1].querySelector(".race-ladder-meta").textContent, "3 runs");
  // The divider sits between the last closed week and this one.
  const list = host.querySelector(".race-ladder-list");
  assert.ok(list.innerHTML.indexOf("race-ladder-now") > list.innerHTML.indexOf('data-race-week="2026-09-21"'));
  assert.ok(list.innerHTML.indexOf("race-ladder-now") < list.innerHTML.indexOf('data-race-week="2026-09-28"'));
  // This week never sets a plan figure beside its actual bar alone: logged of planned.
  const current = host.querySelector(".race-ladder-row.is-current");
  assert.equal(current.querySelector(".race-ladder-km").textContent, "35.8 of 19.5 km");
  assert.equal(
    current.querySelector(".race-ladder-track").getAttribute("aria-label"),
    "Week of Sep 28: 35.8 km run of 19.5 km planned"
  );
  // The kind is a word with a mark, never the bar's colour.
  const peak = host.querySelector(".race-ladder-row.is-peak");
  assert.ok(peak.querySelector(".race-ladder-mark.is-peak[aria-hidden='true']"));
  assert.equal(peak.querySelector(".race-ladder-word").textContent, "Peak");
  // Every bar is drawn to one scale: the biggest week on the page (Oct 12's 36.3).
  assert.equal(Number(current.querySelector(".race-ladder-logged").style.getPropertyValue("--frac")), 0.986);
});

// The server's own reads, shaped as src/contracts/client-api.ts ClientRaceWeekRunActual:
// the runs graded by the personal model, extras in the same list, the lines in km.
function serverRun(overrides) {
  return {
    activity_id: 1,
    weekday: "",
    title: null,
    duration_min: null,
    avg_hr: null,
    stated_easy: false,
    intent_id: null,
    extra: false,
    planned: null,
    adjustment: null,
    actual_line: "",
    plan_line: "",
    ...overrides,
  };
}

function cambridgeClosed() {
  return cambridge({
    adapted: "The weeks ahead now read from the 35.8 km you ran rather than the 19.5 km planned.",
    weeks: CAMBRIDGE_WEEKS.map((week) => (week.current ? { ...week, km: 35.8, planned_km: 19.5, closed: true } : week)),
    this_week: {
      ...cambridge().this_week,
      closed: true,
      closed_reason: "last_run_day_logged",
      headline: "35.8 km over four runs, well past the 19.5 planned.",
      detail: "35.8 km over four runs, well past the 19.5 km planned: three easy and one hard, with the long run in.",
      runs: [
        serverRun({
          date: "2026-09-29",
          km: 9.68,
          pace_sec_per_km: 334,
          intensity: "steady",
          intensity_word: "steady",
          kind: "easy",
          planned: { kind: "easy", label: "Easy run", km: 4.8 },
          actual_line: "9.7 km · 5:34/km · steady",
          plan_line: "Planned easy run 4.8 km.",
        }),
        serverRun({
          date: "2026-09-30",
          title: "<b>Lunch run</b>",
          km: 6.63,
          pace_sec_per_km: 361,
          intensity: "easy",
          intensity_word: "easy",
          kind: null,
          extra: true,
          actual_line: "6.6 km · 6:01/km · easy",
        }),
        serverRun({
          date: "2026-10-02",
          title: "Hill Sprints",
          km: 5.97,
          pace_sec_per_km: 352,
          intensity: "quality",
          intensity_word: "hard",
          kind: "quality",
          planned: { kind: "quality", label: "Short threshold", km: 4 },
          actual_line: "6 km · 5:52/km · hard",
          plan_line: "Planned short threshold 4 km.",
        }),
        serverRun({
          date: "2026-10-04",
          km: 13.54,
          pace_sec_per_km: 371,
          intensity: "easy",
          intensity_word: "easy",
          kind: "long",
          planned: { kind: "long", label: "Long run", km: 10.7 },
          adjustment: "shortened to 8 km this morning",
          actual_line: "13.5 km · 6:11/km · easy",
          plan_line: "Planned long run 10.7 km, shortened to 8 km this morning.",
        }),
      ],
    },
    review: {
      ...cambridge().review,
      weeks: [...cambridge().review.weeks.slice(1), { week_start: "2026-09-28", km: 35.8, runs: 4 }],
      includes_this_week: true,
    },
  });
}

test("live week, the server's reads: its sentence, the runs it graded, the extra, a closed week's recap", () => {
  const win = load();
  const data = cambridgeClosed();
  const host = paintLive(win, data);
  const card = host.querySelector(".race-week");
  assert.ok(card.classList.contains("is-closed"));
  assert.equal(
    card.querySelector(".race-week-stage").textContent,
    "35.8 km over four runs, well past the 19.5 planned."
  );
  assert.equal(
    card.querySelector(".race-week-focus").textContent,
    "35.8 km over four runs, well past the 19.5 km planned: three easy and one hard, with the long run in."
  );
  assert.equal(card.querySelector(".race-week-num").textContent, "35.8 km · plan 19.5");
  const segs = card.querySelectorAll(".race-week-seg");
  assert.equal(segs.length, 4);
  assert.deepEqual(
    segs.map((seg) => seg.classList.contains("is-extra")),
    [false, true, false, false],
    "the extra sits on its own day, marked beyond its colour"
  );
  // The server's grade, never the watch's: Wednesday was easy, Friday's sprints hard. Each
  // segment says the tone it is drawn in (long, extra) as well as its effort, so the cues
  // the bar draws beyond colour reach a screen reader too.
  assert.match(
    card.querySelector(".race-week-bar").getAttribute("aria-label"),
    /Tue 9\.7 km easy, steady; Wed 6\.6 km extra, easy; Fri 6 km quality, hard; Sun 13\.5 km long, easy$/
  );
  assert.deepEqual(
    card.querySelectorAll(".race-week-key-item").map((item) => item.textContent),
    ["easy", "quality", "long", "extra"]
  );
  // The closed week: its actual alone (the rung's km IS the week as run), its recap in
  // place of the plan focus, no long-run plan — and its plan outline still the plan's.
  const current = host.querySelector(".race-ladder-row.is-current");
  assert.ok(current.classList.contains("is-closed"));
  assert.equal(current.querySelector(".race-ladder-km").textContent, "35.8 km");
  assert.equal(current.querySelector(".race-ladder-foot").textContent, "4 runs · plan 19.5 km");
  assert.equal(current.querySelector(".race-ladder-meta"), null);
  assert.equal(Number(current.style.getPropertyValue("--frac")), Math.round((19.5 / 36.3) * 1000) / 1000);
  // The review's own row for this week is this week, never a closed week above it too.
  assert.equal(host.querySelectorAll('[data-race-week="2026-09-28"]').length, 1);
  assert.deepEqual(
    host.querySelectorAll(".race-ladder-row.is-done").map((row) => row.getAttribute("data-race-week")),
    ["2026-09-07", "2026-09-14", "2026-09-21"]
  );
  assert.equal(
    host.querySelector(".race-ladder-adapted").textContent,
    "The weeks ahead now read from the 35.8 km you ran rather than the 19.5 km planned."
  );
  const runs = win.CairnRaceWeekRuns.weekRuns(data, null, "km");
  assert.deepEqual(plain(runs.map((run) => [run.when, run.extra, run.title, run.actual_text, run.planned_text])), [
    ["Tue", false, "", "9.7 km · 5:34/km · steady", "Planned easy run 4.8 km."],
    ["Wed", true, "<b>Lunch run</b>", "6.6 km · 6:01/km · easy", ""],
    ["Fri", false, "Hill Sprints", "6 km · 5:52/km · hard", "Planned short threshold 4 km."],
    ["Sun", false, "", "13.5 km · 6:11/km · easy", "Planned long run 10.7 km, shortened to 8 km this morning."],
  ]);
  // The plan line already says the morning's call: it is never said twice.
  assert.equal(runs[3].adjust_text, "");
  // The server's lines are in km; miles restate them, the words as written.
  const miles = win.CairnRaceWeekRuns.weekRuns(data, null, "mi");
  assert.equal(miles[3].actual_text, "8.4 mi · 9:57 /mi · easy");
  assert.equal(miles[3].planned_text, "Planned long run 6.6 mi, shortened to 5 mi this morning.");
  assert.doesNotMatch(host.textContent, SCORE);
});

test("an agenda graded by the personal model lends its words; a watch-graded one lends none", () => {
  const win = load();
  const graded = {
    ...CAMBRIDGE_AGENDA,
    intents: CAMBRIDGE_AGENDA.intents.map((intent) => ({
      ...intent,
      completion: {
        ...intent.completion,
        intensity: "easy",
        intensity_word: "easy",
        intensity_basis: "personal_model",
      },
    })),
    extras: [
      {
        activity_id: 112,
        date: "2026-10-02",
        duration_min: 35,
        distance_km: 5.97,
        intensity: "quality",
        intensity_word: "hard",
        intensity_basis: "personal_model",
        title: "Hill Sprints",
        signals: [],
      },
    ],
  };
  const runs = win.CairnRaceWeekRuns.weekRuns(cambridge(), graded, "km");
  assert.deepEqual(plain(runs.map((run) => [run.when, run.extra, run.tone, run.effort_word])), [
    ["Tue", false, "quality", "easy"],
    ["Wed", false, "easy", "easy"],
    ["Fri", true, "quality", "hard"],
    ["Sun", false, "long", "easy"],
  ]);
  const watch = {
    ...graded,
    extras: graded.extras.map((run) => ({ ...run, intensity_basis: "watch", intensity_word: "hard" })),
  };
  const fri = win.CairnRaceWeekRuns.weekRuns(cambridge(), watch, "km")[2];
  assert.equal(fri.effort_word, "");
  assert.equal(fri.tone, "easy");
});

test("next week is its own section after the card, never inside it", () => {
  const win = load();
  const model = win.CairnRaceViewModel.viewModel(cambridge(), { agenda: CAMBRIDGE_AGENDA });
  const host = renderHtml(
    win.CairnRaceView.viewHtml(model, {
      sessionsHtml: `<ol class="race-runs"><li>Tue run</li></ol>`,
      nextWeekHtml: `<section class="race-section race-next"><span class="lbl">Next week</span></section>`,
    }),
    { document: win.document }
  );
  assert.ok(host.querySelector(".race-next"));
  assert.equal(host.querySelector(".race-week .race-next"), null);
  const html = host.innerHTML;
  assert.ok(html.indexOf("race-next") > html.indexOf('class="race-week'));
  assert.ok(html.indexOf("race-next") < html.indexOf('class="race-ladder'));
  assert.equal(win.CairnRaceWeekRuns.nextWeekText(cambridge(), "km"), "32.1 km planned");
  assert.equal(win.CairnRaceWeekRuns.nextWeekText(cambridge(), "mi"), "19.9 mi planned");
});

// ---------- the head and the estimate ----------

test("the head frames the race: its name, the ladder's own weeks to race, and race day", () => {
  const win = load();
  const host = paint(win, build());
  assert.equal(host.querySelector(".race-view-event").textContent, "Riverside Half");
  // The current rung's calendar count (7), never the rounded-up day count (8).
  assert.equal(host.querySelector(".race-view-when").textContent, "7 weeks to race · Sunday, Nov 8");
  assert.equal(host.querySelector(".is-current .race-ladder-out").textContent, "7 wk out");
  // The kicker names the page; the week's stage is THIS WEEK's to say, once.
  assert.equal(host.querySelector(".race-view-head .lbl").textContent, "Race");
  const at = (i) => WEEKS.map((w, j) => ({ ...w, current: j === i }));
  // Race week on a Tuesday: 5 days out, the server's ceil says 1, the ladder says race week.
  const week = paint(win, build({ weeks: at(7), race: { ...build().race, weeks_to_race: 1, days_to_race: 5 } }));
  assert.match(week.querySelector(".race-view-when").textContent, /^Race week/);
  // The taper Monday: 13 days out, the server's ceil says 2, the ladder says 1 wk out.
  const one = paint(win, build({ weeks: at(6), race: { ...build().race, weeks_to_race: 2, days_to_race: 13 } }));
  assert.match(one.querySelector(".race-view-when").textContent, /^1 week to race/);
  // No rung is this week: the race's own count is the fallback.
  const none = paint(win, build({ weeks: [], race: { ...build().race, weeks_to_race: 3, days_to_race: 20 } }));
  assert.match(none.querySelector(".race-view-when").textContent, /^3 weeks to race/);
  const today = paint(win, build({ weeks: at(7), race: { ...build().race, weeks_to_race: 0, days_to_race: 0 } }));
  assert.match(today.querySelector(".race-view-when").textContent, /^Race day is today/);
  const unnamed = paint(win, build({ race: { ...build().race, event: null } }));
  assert.equal(unnamed.querySelector(".race-view-event").textContent, "Your half marathon");
});

test("the head carries the estimate in one line: where it reads, its place against the target, the trend", () => {
  const win = load();
  const host = paint(win, build());
  const line = host.querySelector(".race-view-head .race-view-fit");
  assert.equal(line.textContent, "Reads about 2:05 · a stretch to sub-2:00 · 2 min faster in the last month");
  assert.ok(line.classList.contains("is-stretch"));
  const words = {
    fits: "inside sub-2:00",
    stretch: "a stretch to sub-2:00",
    beyond_horizon: "sub-2:00 stays the reach",
  };
  for (const [fit, phrase] of Object.entries(words)) {
    const one = paint(win, build({ prediction: { ...build().prediction, fit } }));
    assert.match(one.querySelector(".race-view-fit").textContent, new RegExp(` · ${phrase} · `));
    assert.doesNotMatch(one.textContent, SCORE);
  }
  // The live shape: 1:54:02 against a 2:00:00 target, 13 min faster since early September.
  const live = paint(
    win,
    build({
      race: {
        ...build().race,
        target: { sec: 7200, pace_sec_per_km: 341, raw: "sub-2:00 target; 1:50 stretch", kind: "time" },
      },
      prediction: {
        ...build().prediction,
        estimate_sec: 6842,
        trend: { delta_sec: -769, since: "2026-09-06", word: "faster" },
        fit: "fits",
      },
    })
  );
  assert.equal(
    live.querySelector(".race-view-fit").textContent,
    "Reads about 1:54 · inside sub-2:00 · 13 min faster in the last month"
  );
  // The gap is not printed as a verdict, and the section below does not say the fit twice.
  assert.doesNotMatch(host.textContent, /4:31|off the/);
  assert.equal(host.querySelector(".race-estimate-word"), null);
});

test("the estimate section shrinks to its basis and the paces", () => {
  const win = load();
  const host = paint(win, build());
  const estimate = host.querySelector(".race-estimate");
  assert.equal(estimate.querySelector(".race-estimate-source").textContent, "From the watch's race predictor.");
  assert.equal(estimate.querySelector(".race-estimate-line"), null, "the fit is the head's to say");
  // The goal milestone says the race pace, so the bands do not say it twice.
  const paces = estimate.querySelectorAll(".race-view-pace").map((row) => row.querySelector("dt").textContent);
  assert.deepEqual(paces, ["Easy"]);
  assert.match(estimate.querySelectorAll(".race-view-pace")[0].querySelector("dd").textContent, /under 150 bpm/);
  // With no target there is no goal milestone, and the race band stays.
  const noTarget = paint(win, build({ race: { ...build().race, target: null } }));
  assert.deepEqual(
    noTarget.querySelectorAll(".race-view-pace").map((row) => row.querySelector("dt").textContent),
    ["Race pace", "Easy"]
  );
});

test("the finish milestones: the goal, today's shape and the stretch, each a clock with its pace", () => {
  const win = load();
  const finishes = (host) =>
    host.querySelectorAll(".race-finish").map((row) => ({
      label: row.querySelector("dt").textContent,
      clock: row.querySelector(".race-finish-clock").textContent,
      pace: row.querySelector(".race-finish-pace")?.textContent ?? "",
      note: row.querySelector(".race-finish-note")?.textContent ?? "",
    }));
  // The live shape: sub-2:00 with a 1:50 stretch, reading 1:54.
  const live = paint(
    win,
    build({
      race: {
        ...build().race,
        target: { sec: 7200, pace_sec_per_km: 341.2, raw: "sub-2:00 target; 1:50 stretch", kind: "time" },
        stretch: { sec: 6600, pace_sec_per_km: 312.8, raw: "1:50 stretch", kind: "time", fit: "stretch" },
      },
      prediction: { ...build().prediction, estimate_sec: 6842, estimate_pace_sec_per_km: 324, fit: "fits" },
    })
  );
  assert.deepEqual(finishes(live), [
    { label: "Goal", clock: "sub-2:00", pace: "5:41 /km", note: "Inside it now" },
    { label: "Today's shape", clock: "1:54", pace: "5:24 /km", note: "" },
    { label: "Stretch", clock: "1:50", pace: "5:13 /km", note: "Within reach" },
  ]);
  assert.ok(live.querySelector(".race-finish.is-now"));
  assert.doesNotMatch(live.querySelector(".race-finishes").textContent, SCORE);
  // In miles, the paces follow the run units; the clocks do not move.
  const miles = paint(
    win,
    build({ prediction: { ...build().prediction, estimate_pace_sec_per_km: 354 } }),
    { units: "mi" }
  );
  assert.match(finishes(miles)[0].pace, /\/mi$/);
  // No stretch named: two milestones. No estimate: the goal alone, with no place word.
  assert.deepEqual(finishes(paint(win, build())).map((f) => f.label), ["Goal", "Today's shape"]);
  const noEstimate = finishes(paint(win, build({ prediction: null })));
  assert.deepEqual(noEstimate, [{ label: "Goal", clock: "sub-2:00", pace: "5:41 /km", note: "" }]);
});

test("no target reads the estimate alone; no estimate says where one comes from", () => {
  const win = load();
  const noTarget = paint(
    win,
    build({ race: { ...build().race, target: null }, prediction: { ...build().prediction, fit: null } })
  );
  assert.equal(
    noTarget.querySelector(".race-view-fit").textContent,
    "Reads about 2:05 · 2 min faster in the last month"
  );
  assert.match(noTarget.querySelector(".race-estimate-line").textContent, /No target time/);
  const noEstimate = paint(win, build({ prediction: null }));
  assert.equal(noEstimate.querySelector(".race-view-fit"), null);
  assert.ok(noEstimate.querySelector(".race-estimate.is-empty"));
  assert.match(noEstimate.querySelector(".race-estimate-line").textContent, /No finish estimate yet/);
});

test("nothing on the view is a score", () => {
  const win = load();
  const host = paint(win, build());
  assert.doesNotMatch(host.textContent, SCORE);
});

test("caller strings are escaped", () => {
  const win = load();
  const host = paint(
    win,
    build({
      race: { ...build().race, event: "<b>Half</b>" },
      strength: { ...build().strength, layout: "<i>why</i>" },
    })
  );
  assert.equal(host.querySelector(".race-view-event b"), null);
  assert.equal(host.querySelector(".race-view-event").textContent, "<b>Half</b>");
  assert.equal(host.querySelector(".race-view-note i"), null);
});

test("the week's layout sits behind a 44px fold, and nothing folds when there is nothing to say", () => {
  const win = load();
  const host = paint(
    win,
    build({ strength: { ...build().strength, layout: "Heavy legs Monday, two days off the long run." } })
  );
  const more = host.querySelector("details.race-view-more");
  assert.ok(more);
  assert.equal(more.hasAttribute("open"), false);
  assert.deepEqual(
    host.querySelectorAll(".race-view-note").map((p) => p.textContent),
    ["Heavy legs Monday, two days off the long run."]
  );
  // The server's why is never in it: its estimate clause prints the gap as a verdict.
  assert.doesNotMatch(more.textContent, /off the [0-9:]+ target|4:31/);
  assert.equal(paint(win, build()).querySelector("details.race-view-more"), null);
});

// ---------- against the real server read ----------

// A real raceBuild(asOf), through the JSON the route sends, painted as-is: the rows,
// km, kinds and the current rung are the server's, and the head counts what the
// ladder counts. Riverside Half is Sunday 2026-11-01, so the rounded-up day count and
// the ladder's calendar count disagree on every day but Monday.
const REAL_RACE = "2026-11-01";
const shiftDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 864e5).toISOString().slice(0, 10);

function seedRealBuild(asOf) {
  resetTables("activities", "garmin_activities", "garmin_daily_metrics", "profile", "app_state");
  repo.setProfile({
    age: 40,
    sex: "male",
    primary_discipline: "hybrid",
    endurance_sport: "running",
    endurance_goal: { mode: "race", event: "Riverside Half", date: REAL_RACE, distance_km: 21.1, target: "sub-2:00" },
  });
  // Six weeks of Tue / Thu / Sat running, all before the as-of.
  for (let wk = 1; wk <= 6; wk++) {
    const base = shiftDays(asOf, -7 * wk);
    repo.addActivity({ type: "run", duration_min: 48, distance_km: 8, date: shiftDays(base, 1) });
    repo.addActivity({ type: "run", duration_min: 42, distance_km: 7.5, date: shiftDays(base, 3) });
    repo.addActivity({ type: "run", duration_min: 84, distance_km: 13, date: shiftDays(base, 5) });
  }
  return JSON.parse(JSON.stringify(raceBuild(asOf)));
}

for (const [asOf, head, currentOut] of [
  ["2026-09-16", "6 weeks to race", "6 wk out"], // a Wednesday: ceil(46 / 7) would say 7
  ["2026-10-19", "1 week to race", "1 wk out"], // the taper Monday: ceil(13 / 7) would say 2
  ["2026-10-27", "Race week", "Race week"], // race week, Tuesday: ceil(5 / 7) would say 1
]) {
  test(`a real raceBuild(${asOf}) paints its own ladder, and the head counts what the ladder counts`, () => {
    const data = seedRealBuild(asOf);
    assert.equal(data.available, true, data.reason);
    const win = load();
    const host = paint(win, data);
    // The ladder's own weeks; the closed weeks above them are the review's.
    const rows = host.querySelectorAll(".race-ladder-row").filter((row) => !row.classList.contains("is-done"));
    assert.equal(rows.length, data.weeks.length);
    assert.ok(rows.length > 0);
    rows.forEach((row, i) => {
      const week = data.weeks[i];
      assert.equal(row.getAttribute("data-race-week"), week.week_start);
      if (!week.current)
        assert.equal(row.querySelector(".race-ladder-km").textContent, win.CairnRaceViewModel.kmText(week.km));
      assert.equal(row.querySelector(".race-ladder-word").textContent, win.CairnRaceViewModel.stageWord(week));
      assert.equal(
        row.querySelector(".race-ladder-foot").textContent,
        week.kind === "race" ? row.querySelector(".race-ladder-foot").textContent : week.focus_short
      );
      assert.ok(row.classList.contains(`is-${week.kind}`) || !["taper", "race"].includes(week.kind));
      assert.equal(row.classList.contains("is-current"), week.current === true);
    });
    const here = data.weeks.findIndex((week) => week.current);
    assert.ok(here >= 0);
    assert.equal(rows[here].querySelector(".race-ladder-out").textContent, currentOut);
    assert.match(host.querySelector(".race-view-when").textContent, new RegExp(`^${head} · Sunday, Nov 1$`));
    // Never the server's why (its rounded-up count and its gap-as-verdict clause).
    assert.doesNotMatch(host.textContent, /off the .* target|weeks to Riverside Half/);
  });
}

// ---------- the controller ----------

test("a build in hand paints at once with one settle entrance; reduced motion paints still", async () => {
  const win = load();
  const loads = [];
  const host = createHost(win.document);
  win.CairnRaceViewController.mount(host, {
    initial: build(),
    load: () => {
      loads.push(1);
      return Promise.resolve(build());
    },
  });
  assert.equal(loads.length, 0, "no second read");
  const section = host.querySelector(".race-view");
  assert.ok(section.classList.contains("settle-in"));
  assert.ok(section.classList.contains("is-entering"));
  assert.equal(host.querySelectorAll(".race-ladder-row").length, WEEKS.length);

  const calm = createHost(win.document);
  win.CairnRaceViewController.mount(calm, { initial: build(), load: async () => build(), reducedMotion: () => true });
  const still = calm.querySelector(".race-view");
  assert.equal(still.classList.contains("settle-in"), false);
  assert.equal(still.classList.contains("is-entering"), false);
});

test("a cold mount shows the skeleton, then the view", async () => {
  const win = load();
  const host = createHost(win.document);
  let resolve;
  win.CairnRaceViewController.mount(host, { load: () => new Promise((r) => (resolve = r)) });
  await flush();
  assert.ok(host.querySelector(".race-view-skel[aria-busy='true']"));
  resolve(build());
  await flush();
  assert.equal(host.querySelector(".race-view-skel"), null);
  assert.equal(host.querySelectorAll(".race-ladder-row").length, WEEKS.length);
});

test("an unavailable build is the empty state with the server's own reason", async () => {
  const win = load();
  const host = createHost(win.document);
  const reason = "No dated race yet. Set one and the build lays out week by week.";
  win.CairnRaceViewController.mount(host, { load: async () => ({ available: false, reason, weeks: [] }) });
  await flush();
  assert.equal(host.querySelector(".race-ladder"), null);
  assert.equal(host.querySelector(".empty-state-line").textContent, "No race build yet");
  assert.equal(host.querySelector(".hpic-hero-sub").textContent, reason);
});

test("a failed read says so in one line and tries again on tap", async () => {
  const win = load();
  const host = createHost(win.document);
  let calls = 0;
  const unmount = win.CairnRaceViewController.mount(host, {
    load: () => (++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(build())),
  });
  await flush();
  assert.match(host.querySelector(".race-view-error-line").textContent, /couldn't be read just now/);
  const retry = host.querySelector("[data-race-view-retry]");
  assert.equal(retry.getAttribute("type"), "button");
  await retry.click();
  await flush();
  assert.equal(calls, 2);
  assert.equal(host.querySelectorAll(".race-ladder-row").length, WEEKS.length);
  unmount();
});

test("a remount replaces the listener, so one tap reads once", async () => {
  const win = load();
  const host = createHost(win.document);
  let calls = 0;
  const deps = {
    load: () => {
      calls++;
      return Promise.reject(new Error("offline"));
    },
  };
  win.CairnRaceViewController.mount(host, deps);
  win.CairnRaceViewController.mount(host, deps);
  await flush();
  assert.equal(calls, 2);
  await host.querySelector("[data-race-view-retry]").click();
  await flush();
  assert.equal(calls, 3);
});

test("a view the athlete has left is never painted", async () => {
  const win = load();
  const host = createHost(win.document);
  let resolve;
  win.CairnRaceViewController.mount(host, { load: () => new Promise((r) => (resolve = r)) });
  await flush();
  host.remove();
  resolve(build());
  await flush();
  assert.equal(host.querySelector(".race-ladder"), null);
});

// ---------- the race page holds the depth, Horizon the glance ----------

test("the race page draws no chart: the terrain is Horizon's glance, the ladder here is its table", () => {
  const win = loadClientModule(
    [...MODULES.slice(0, -2), "horizon-terrain-client", "horizon-chart-client", ...MODULES.slice(-2)],
    {
      globals: {},
    }
  );
  const host = paint(win, build());
  assert.equal(host.querySelector(".hz-terrain"), null);
  assert.equal(host.querySelector("details.race-view-weeks"), null);
  assert.equal(host.querySelectorAll(".race-ladder-row").length, 8);
});

// ---------- review fixes: a hard extra, an unplanned closed week, a target said as set ----------

test("a hard extra keeps its hatch under the extra's dots: both cues drawn, both said", async () => {
  const win = load();
  const data = cambridgeClosed();
  const hard = {
    ...data,
    this_week: {
      ...data.this_week,
      runs: data.this_week.runs.map((run) =>
        run.extra ? { ...run, intensity: "quality", intensity_word: "hard", actual_line: "6.6 km · 6:01/km · hard" } : run
      ),
    },
  };
  const card = paintLive(win, hard).querySelector(".race-week");
  const seg = card.querySelectorAll(".race-week-seg")[1];
  assert.deepEqual([...seg.classList].filter((c) => c.startsWith("is-")), ["is-quality", "is-extra"]);
  assert.match(card.querySelector(".race-week-bar").getAttribute("aria-label"), /Wed 6\.6 km extra, hard/);
  // The stylesheet layers the dots OVER the hatch for that pair, never in its place.
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../src/styles/horizon/race.css", import.meta.url), "utf8");
  const rule = css.match(/\.race-week-seg\.is-quality\.is-extra\{([^}]*)\}/);
  assert.ok(rule, "a rule for a hard extra");
  assert.match(rule[1], /radial-gradient[\s\S]*repeating-linear-gradient/);
});

test("a closed week with no prescription behind it draws its actual alone: no plan outline, no 'plan' figure", () => {
  const win = load();
  const data = cambridgeClosed();
  const unplanned = {
    ...data,
    weeks: data.weeks.map((week) => (week.current ? { ...week, planned_km: null } : week)),
  };
  const model = win.CairnRaceLadderModel.ladderModel(unplanned, "km");
  const row = model.rows.find((r) => r.current);
  assert.equal(row.closed, true);
  assert.equal(row.km_text, "35.8 km");
  assert.equal(row.frac, 0, "no plan outline at the logged length");
  assert.ok(row.logged_frac > 0, "the logged solid stays");
  assert.doesNotMatch(row.recap_text, /plan/);
  assert.doesNotMatch(row.bar_label, /planned/);
});

test("the head says the target as the athlete set it, to the second when it is not on a minute", () => {
  const win = load();
  const host = paint(
    win,
    build({
      race: { ...build().race, target: { sec: 6750, pace_sec_per_km: 320, raw: "1:52:30", kind: "time" } },
      prediction: { ...build().prediction, estimate_sec: 6720, fit: "fits" },
    })
  );
  assert.match(host.querySelector(".race-view-fit").textContent, /^Reads about 1:52 · inside 1:52:30/);
  // A target on the minute stays to the minute.
  assert.match(paint(win, build()).querySelector(".race-view-fit").textContent, /sub-2:00 ·/);
});
