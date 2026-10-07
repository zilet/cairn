// Horizon's Week, the designed landing (docs/IA.md "Horizon landing"): the frame hero,
// the week's shape (seven columns sized by the server's planned dose, said in words),
// still open, next up (the milestone row the Season shares) and the goals (the goal row
// the Season shares), all from ONE GET /api/week read (WeekRead). Week is ALWAYS the
// first view; a column tap peeks the day through CairnDrill; the Season lists one row
// per lab draw (GET /api/health-docs/draws). Rendered HTML through the shared DOM
// harness, synthetic fixtures in miles + pounds and in kilometres + kilograms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const TODAY = "2026-10-06";
const MODULES = [
  "html-utils",
  "date-utils",
  "ui-components",
  "ui-reads",
  "ui-actions-client",
  "ui-chart",
  "format-utils",
  "ui-format",
  "journey-progress-client",
  "journey-timeline-client",
  "race-week-model",
  "race-week-runs-model",
  "race-ladder-model",
  "race-view-model",
  "race-estimate-client",
  "race-ladder-client",
  "race-view-client",
  // the calendar bundle horizon reaches through train
  "day-detail-model",
  "day-detail-client",
  "milestone-row-model",
  "milestone-row-client",
  "goal-row-model",
  "goal-row-client",
  "frame-line-client",
  "week-model",
  "week-strip-client",
  // the horizon bundle
  "horizon-model",
  "horizon-labs-model",
  "horizon-terrain-client",
  "horizon-chart-client",
  "horizon-week-client",
  "horizon-week-controller",
  "horizon-client",
  "horizon-controller",
];

function load(globals = {}) {
  return loadClientModule(MODULES, { globals: { Intl, localISO: () => TODAY, ...globals } });
}

const plain = (value) => JSON.parse(JSON.stringify(value));
const ISO_IN_TEXT = /\b\d{4}-\d{2}-\d{2}\b/;
const DOUBLE_UNIT = /\b(lb|kg|km|mi)\s*\1\b|\dlb lb|\d(?:lb|kg)\s+(?:lb|kg)\b/i;
const SCORE = /score|\/\s*100|\d\s*%|percent|grade|rating/i;

// ---------- the WeekRead fixture (src/contracts/week-read.ts) ----------

const DOSE = {
  rest: ["Rest", 0.08],
  easy: ["Easy", 0.3],
  moderate: ["Moderate", 0.55],
  hard: ["Hard", 0.8],
  big: ["Big day", 1],
};

/** Words the server writes in the athlete's units (display-words.ts). */
function words(units) {
  const mi = units.distance === "mi";
  const kg = units.weight === "kg";
  return {
    easy: mi ? "3.7 mi" : "6 km",
    quality: mi ? "5 mi" : "8 km",
    long: mi ? "9.3 mi" : "15 km",
    summary: mi
      ? "Sharpen week: 1 of 4 lifting days and 3.7 of 19.3 mi in, the long run still ahead on Sun, Oct 11."
      : "Sharpen week: 1 of 4 lifting days and 6 of 31 km in, the long run still ahead on Sun, Oct 11.",
    weightNow: kg ? "72.4 kg" : "159.6 lb",
    weightGoal: kg ? "69.9 kg" : "154 lb",
    weightLine: kg ? "Trending −0.4 kg/wk — on pace for Nov 15." : "Trending −0.9 lb/wk — on pace for Nov 15.",
    liftNow: kg ? "129.3 kg" : "285 lb",
    liftGoal: kg ? "154.2 kg" : "340 lb",
    liftRate: kg ? "+1.9 kg/wk" : "+4.2 lb/wk",
  };
}

function chip(date, weekday, status, opts = {}) {
  const [word, height] = DOSE[opts.dose || "rest"];
  const lift = opts.lift
    ? { day_number: 1, title: opts.lift, heavy_lower: !!opts.heavy, suggestion: null }
    : null;
  const run = opts.run || null;
  const parts = [lift?.title, run ? `${run.label}${run.distance_words ? `, ${run.distance_words}` : ""}` : ""].filter(Boolean);
  return {
    date,
    date_words: `${weekday}, Oct ${Number(date.slice(8))}`,
    weekday,
    status,
    today: date === TODAY,
    lift,
    run,
    rest: !lift && !run,
    hard: !!opts.hard,
    words: parts.join(" · ") || "Rest",
    load: { dose: opts.dose || "rest", word, height },
    href: `/app/day/${date}`,
  };
}

function runOf(kind, label, status, km, distanceWords) {
  return { kind, label, status, km, distance_words: distanceWords, rested: false, covered: false };
}

function weekRead(units = { distance: "mi", weight: "lb" }) {
  const w = words(units);
  return {
    as_of: TODAY,
    today: TODAY,
    week_start: "2026-10-05",
    week_end: "2026-10-11",
    range_words: "Oct 5 – Oct 11",
    this_week: true,
    units,
    frame: {
      stage: { key: "sharpen", word: "Sharpen", week_word: "Sharpen week", source: "race" },
      block: { week: 6, of: 6, words: "block week 6 of 6" },
      countdown: {
        days: 26,
        event: "Cambridge Half",
        race_date: "2026-11-01",
        race_date_words: "Nov 1",
        words: "26 days to Cambridge Half",
      },
      push: { until: "2026-11-15", until_words: "Nov 15", words: "push through Nov 15" },
      headline: "26 days to Cambridge Half",
      line: "Sharpen · block week 6 of 6 · push through Nov 15",
      glance: "26 days to Cambridge · Sharpen, wk 6 of 6",
    },
    summary: w.summary,
    totals: {
      lift_days_done: 1,
      lift_days_planned: 4,
      runs_done: 1,
      runs_planned: 4,
      run_km_done: 6,
      run_km_planned: 31,
      units: units.distance,
      lift_words: "1 of 4 lifting days",
      run_words: null,
    },
    days: [
      chip("2026-10-05", "Mon", "done", { lift: "Upper B", dose: "moderate" }),
      chip("2026-10-06", "Tue", "today", {
        lift: "Push",
        dose: "hard",
        run: runOf("easy", "Easy run", "completed", 6, w.easy),
      }),
      chip("2026-10-07", "Wed", "upcoming", { lift: "Push", dose: "moderate" }),
      chip("2026-10-08", "Thu", "upcoming", {
        lift: "Pull",
        dose: "big",
        hard: true,
        run: runOf("quality", "Threshold intervals", "open", 8, w.quality),
      }),
      chip("2026-10-09", "Fri", "upcoming", { lift: "Lower A", dose: "hard", heavy: true, hard: true }),
      chip("2026-10-10", "Sat", "rest"),
      chip("2026-10-11", "Sun", "upcoming", {
        dose: "big",
        hard: true,
        run: runOf("long", "Long run", "open", 15, w.long),
      }),
    ],
    layout_note: null,
    still_open: [
      { kind: "long", label: "Long run", date: "2026-10-11", date_words: "Sun, Oct 11", words: "Long run · Sun, Oct 11" },
      {
        kind: "quality",
        label: "Threshold intervals",
        date: "2026-10-08",
        date_words: "Thursday",
        words: "Threshold intervals · Thursday",
      },
      { kind: "lift", label: "Push", date: "2026-10-07", date_words: "tomorrow", words: "Push · Tomorrow" },
    ],
    next_milestones: [
      { kind: "peak_week", label: "Peak week", date: "2026-10-12", end_date: "2026-10-18", date_words: "Oct 12 – Oct 18", detail: null },
      { kind: "race", label: "Cambridge Half", date: "2026-11-01", end_date: null, date_words: "Nov 1", detail: "Half marathon" },
      { kind: "goal", label: "Goal weight", date: "2026-11-15", end_date: null, date_words: "Nov 15", detail: w.weightGoal },
      { kind: "checkup", label: "Checkup", date: "2026-12-01", end_date: null, date_words: "Dec 1", detail: null },
    ],
    goals: [
      {
        key: "race",
        label: "Cambridge Half",
        now_text: "1:52:10",
        goal_text: "sub-1:55",
        progress: 0.8,
        line: "Reads 1:52:10, inside sub-1:55.",
        fit: "fits",
      },
      { key: "weight", label: "Weight", now_text: w.weightNow, goal_text: w.weightGoal, progress: 0.62, line: w.weightLine },
      {
        key: "strength",
        label: "Deadlift",
        now_text: w.liftNow,
        goal_text: w.liftGoal,
        progress: 0.3,
        line: `Est. 1RM ${w.liftNow}, ${w.liftRate}.`,
      },
    ],
    weight_trend: null,
  };
}

/** Text nodes only: tags dropped, attributes (hrefs, data-*) never read. */
function textOf(host) {
  return String(host.textContent).replace(/\s+/g, " ").trim();
}

function assertClean(host, label) {
  const text = textOf(host);
  assert.doesNotMatch(text, ISO_IN_TEXT, `${label}: a raw ISO date reached a text node`);
  assert.doesNotMatch(text, DOUBLE_UNIT, `${label}: a unit is printed twice`);
  assert.doesNotMatch(text, SCORE, `${label}: something reads as a score`);
  for (const el of host.querySelectorAll("[aria-label]")) {
    const said = el.getAttribute("aria-label");
    assert.doesNotMatch(said, ISO_IN_TEXT, `${label}: a raw ISO date in a label`);
    assert.doesNotMatch(said, SCORE, `${label}: a label reads as a score`);
  }
}

function landing(win, read = weekRead()) {
  return renderHtml(win.CairnHorizonWeek.landingHtml(win.CairnWeekModel.landing(read)), { document: win.document });
}

// ---------- the landing ----------

test("the landing (mi + lb): hero, shape, still open, next up and goals from one WeekRead", () => {
  const win = load();
  const host = landing(win);
  // 1. The frame hero, verbatim, with the block ribbon (this week ringed) and race day.
  assert.equal(host.querySelector(".frameline-h").textContent, "26 days to Cambridge Half");
  assert.equal(host.querySelector(".frameline-l").textContent, "Sharpen · block week 6 of 6 · push through Nov 15");
  assert.equal(host.querySelector(".frameline-k").textContent, "This week · Oct 5 – Oct 11");
  assert.equal(host.querySelectorAll(".frameline-step").length, 6);
  assert.equal(host.querySelectorAll(".frameline-step.is-done").length, 5);
  assert.ok(host.querySelectorAll(".frameline-step")[5].classList.contains("is-now"));
  assert.equal(host.querySelector(".frameline-steps").getAttribute("aria-label"), "Block week 6 of 6");
  assert.equal(host.querySelector(".frameline-end").textContent, "Race · Nov 1");
  // 2. The shape: seven real buttons, the week's ONE sentence under it.
  assert.equal(host.querySelectorAll("button.wkshape-day").length, 7);
  assert.match(host.querySelector(".hwk-summary").textContent, /^Sharpen week: 1 of 4 lifting days and 3\.7 of 19\.3 mi in/);
  // The days fold as rows that open each day's page (Program's own row words).
  const rows = host.querySelectorAll(".hwk-days .pahead-day");
  assert.equal(rows.length, 7);
  assert.equal(rows[3].getAttribute("data-open-day"), "2026-10-08");
  // 3. Still open: two lines at most, each opening its day.
  const open = host.querySelectorAll(".hwk-open-row");
  assert.deepEqual(
    open.map((r) => r.querySelector(".hwk-open-t").textContent),
    ["Long run · Sun, Oct 11", "Threshold intervals · Thursday"]
  );
  assert.equal(open[0].getAttribute("data-open-day"), "2026-10-11");
  // 4. Next up: three milestone rows (the Season's own row), then the way to the season.
  const next = host.querySelectorAll(".hwk-sec.is-next .msrow");
  assert.equal(next.length, 3);
  assert.deepEqual(
    next.map((r) => [r.querySelector(".msrow-when").textContent, r.querySelector(".msrow-label").textContent]),
    [
      ["Oct 12 – Oct 18", "Peak week"],
      ["Nov 1", "Cambridge Half"],
      ["Nov 15", "Goal weight"],
    ]
  );
  assert.ok(next[1].classList.contains("stone-endurance"));
  assert.ok(next[2].classList.contains("stone-body"));
  assert.equal(host.querySelector("[data-hwk-season]").textContent, "All of the season ›");
  // 5. Goals: the race estimate WITH its time, the weight, the anchor lift; meters in words.
  const goals = host.querySelectorAll(".goalrow");
  assert.deepEqual(
    goals.map((g) => [g.getAttribute("data-goal-row"), g.querySelector(".goalrow-num").textContent]),
    [
      ["race", "1:52:10"],
      ["weight", "159.6 lb"],
      ["strength", "285 lb"],
    ]
  );
  assert.equal(goals[0].querySelector(".goalrow-word").textContent, "Fits");
  assert.equal(goals[1].querySelector(".goalrow-word").textContent, "Past halfway");
  assert.equal(goals[2].querySelector(".goalrow-word").textContent, "On the way");
  assert.equal(goals[1].querySelector(".goalrow-fill").getAttribute("style"), "--w:0.62");
  assert.equal(
    goals[1].querySelector(".goalrow-track").getAttribute("aria-label"),
    "Weight: 159.6 lb now, goal 154 lb, past halfway"
  );
  assert.match(goals[1].querySelector(".goalrow-name small").textContent, /−0\.9 lb\/wk/);
  assertClean(host, "landing (mi)");
  assert.doesNotMatch(textOf(host), /\bkm\b|\/km/, "a miles athlete never reads km");
});

test("the landing (km + kg): every figure in the athlete's units, never the other ones", () => {
  const win = load();
  const host = landing(win, weekRead({ distance: "km", weight: "kg" }));
  assert.match(host.querySelector(".hwk-summary").textContent, /6 of 31 km in/);
  assert.equal(host.querySelectorAll(".goalrow-num")[1].textContent, "72.4 kg");
  assert.match(
    host.querySelectorAll(".goalrow")[1].querySelector(".goalrow-track").getAttribute("aria-label"),
    /72\.4 kg now, goal 69\.9 kg/
  );
  // The folded day rows restate the run in the same units the server spoke.
  assert.match(host.querySelector('.hwk-days [data-open-day="2026-10-11"]').textContent, /Long run · 15 km/);
  assertClean(host, "landing (km)");
  assert.doesNotMatch(textOf(host), /\bmi\b|\blb\b/, "a metric athlete never reads miles or pounds");
});

test("the shape: bar heights are the server's relative dose, labels are its words, never a number", () => {
  const win = load();
  const read = weekRead();
  const host = landing(win, read);
  const cols = host.querySelectorAll("button.wkshape-day");
  cols.forEach((col, i) => {
    const day = read.days[i];
    const bar = col.querySelector(".wkshape-bar");
    const h = Number(/--h:([\d.]+)/.exec(bar.getAttribute("style"))[1]);
    assert.equal(h, day.load.height, `${day.weekday}'s bar is its dose's height`);
    const said = col.getAttribute("aria-label");
    assert.ok(said.startsWith(day.date_words), `${day.weekday}: the label says the day in words`);
    if (day.load.dose !== "rest") assert.match(said, new RegExp(`${day.load.word} load`));
    assert.doesNotMatch(said, /0\.\d|\d+\s*%/, "the height is a drawing aid, never said");
    // The face is a picture: the button's label carries it.
    assert.equal(col.querySelector(".wkshape-face").getAttribute("aria-hidden"), "true");
  });
  // Heights stand in proportion: the big day is the tallest, rest the lowest.
  const hs = cols.map((c) => Number(/--h:([\d.]+)/.exec(c.querySelector(".wkshape-bar").getAttribute("style"))[1]));
  assert.equal(Math.max(...hs), hs[3]);
  assert.equal(Math.min(...hs), hs[5]);
  // Today outlined, done ticked, open key sessions hollow, a rest day a stub.
  assert.equal(cols[1].getAttribute("aria-current"), "date");
  assert.ok(cols[1].classList.contains("is-today"));
  assert.ok(cols[0].classList.contains("is-done") && cols[0].querySelector(".wkshape-tick"));
  assert.deepEqual(
    cols.map((c) => c.classList.contains("is-key")),
    [false, false, false, true, true, false, true]
  );
  assert.ok(cols[5].classList.contains("is-rest") && cols[5].querySelector(".wkshape-seg.is-rest"));
  // A day with a lift and a run wears both stones, the lift below the run.
  assert.deepEqual(
    cols[3].querySelectorAll(".wkshape-seg").map((s) => s.getAttribute("class")),
    ["wkshape-seg stone-strength", "wkshape-seg stone-endurance"]
  );
  assert.equal(cols[4].querySelector(".wkshape-tag").textContent, "LA");
  // A week in plan order (no dates) is a still picture, never a dead button.
  const template = weekRead();
  template.days = template.days.map((d) => ({ ...d, date: null, date_words: null, weekday: null, href: null }));
  const still = landing(win, template);
  assert.equal(still.querySelectorAll("button.wkshape-day").length, 0);
  assert.equal(still.querySelectorAll('.wkshape-day.is-static[role="img"]').length, 7);
  assert.equal(still.querySelector(".wkshape-dow").textContent, "DAY");
});

test("server text stays text; an empty week says so; a failed read is one calm line", () => {
  const win = load();
  const read = weekRead();
  read.frame.headline = '<img src=x onerror="boom()">';
  read.goals[0].label = "<b>Half</b>";
  read.next_milestones[0].label = "<script>x</script>";
  const host = landing(win, read);
  // (Compared as booleans: a found element is never handed to the assertion's inspector.)
  assert.equal(!!host.querySelector("img"), false);
  assert.equal(!!host.querySelector(".goalrow-name b"), false);
  assert.equal(!!host.querySelector("script"), false);
  assert.match(host.querySelector(".frameline-h").textContent, /<img/);
  assert.match(host.querySelector(".goalrow-name").textContent, /<b>Half<\/b>/);
  assert.match(host.querySelector(".msrow-label").textContent, /<script>/);
  const empty = landing(win, { ...weekRead(), days: [], still_open: [], next_milestones: [], goals: [] });
  assert.match(empty.querySelector(".hwk-empty").textContent, /Nothing planned this week yet/);
  assert.equal(win.CairnWeekModel.landing(null), null);
  assert.equal(win.CairnWeekModel.landing({ ok: false }), null);
  assert.match(win.CairnHorizonWeek.errorHtml(), /couldn't be read just now/);
});

// ---------- the controller: SWR, the peek through CairnDrill ----------

function drillStub() {
  const calls = [];
  let owner = null;
  const stub = {
    calls,
    open(kind, id, opts = {}) {
      calls.push({ kind, id, mode: opts.mode, from: opts.from, host: opts.host });
      owner = opts.host || null;
      return () => calls.push({ teardown: id });
    },
    owns: (host) => !!owner && owner === host,
    closePeek() {
      calls.push({ closed: true });
      owner = null;
    },
    release(host) {
      if (owner === host) owner = null;
    },
    peeked: () => null,
  };
  return stub;
}

test("a column tap peeks the day through CairnDrill (from Horizon); a second tap folds it", async () => {
  const CairnDrill = drillStub();
  const win = load({ CairnDrill });
  const slot = createHost(win.document);
  const asked = [];
  win.CairnHorizonWeekController.mount(slot, {
    peek: () => null,
    load: (path, opts) => {
      asked.push([path, opts.key]);
      return Promise.resolve(weekRead());
    },
  });
  assert.ok(slot.querySelector('.hwk.is-pending[aria-busy="true"]'), "a cold open shows the skeleton");
  await flush();
  await flush();
  assert.deepEqual(asked, [["/week", "plan:week-read"]]);
  const thu = slot.querySelector('[data-week-day="2026-10-08"]');
  await thu.click();
  const open = CairnDrill.calls.find((c) => c.id === "2026-10-08");
  assert.equal(open.kind, "day");
  assert.equal(open.mode, "peek");
  assert.equal(open.from, "horizon");
  assert.equal(open.host, slot.querySelector("[data-hwk-peek]"));
  assert.equal(thu.getAttribute("aria-expanded"), "true");
  const fold = slot.querySelector("[data-hwk-fold]");
  assert.ok(fold.classList.contains("is-open"));
  assert.equal(fold.hasAttribute("inert"), false);
  await slot.querySelector('[data-week-day="2026-10-08"]').click();
  assert.ok(CairnDrill.calls.some((c) => c.closed), "the second tap closes the peek through the drill");
});

test("the week paints its last-known read at once and repaints only on a change", async () => {
  const win = load({ CairnDrill: drillStub() });
  const slot = createHost(win.document);
  const read = weekRead();
  let painted = 0;
  win.CairnHorizonWeekController.mount(slot, {
    peek: (key) => (key === "plan:week-read" ? { data: read, fresh: false } : null),
    load: () => Promise.resolve(JSON.parse(JSON.stringify(read))),
    onRead: () => painted++,
  });
  assert.equal(slot.querySelector(".frameline-h").textContent, "26 days to Cambridge Half", "warm paint, no skeleton");
  await flush();
  await flush();
  assert.equal(painted, 1, "an unchanged revalidation repaints nothing");
});

// ---------- Horizon: Week is the landing, always ----------

function reads({ extra = {}, fail = [] } = {}) {
  const table = {
    "/race-build": { available: false, race: null, weeks: [], reason: "" },
    "/journey": null,
    "/journey/timeline": [],
    "/health-docs/draws": [],
    "/health/next-checkup": null,
    "/week": weekRead(),
    ...extra,
  };
  const calls = [];
  const loader = (path) => {
    calls.push(path);
    if (fail.includes(path)) return Promise.reject(new Error("offline"));
    return Promise.resolve(table[path] ?? null);
  };
  return { load: loader, calls };
}

test("Week is the default on a cold route and after another view was picked", async () => {
  const win = load({ CairnDrill: drillStub() });
  assert.equal(win.CairnHorizonController.shellOptions().view, "week");
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml(win.CairnHorizonController.shellOptions().view);
  const root = host.querySelector("[data-horizon]");
  assert.equal(root.querySelector('[data-horizon-panel="week"]').hidden, false);
  assert.equal(root.querySelector('[data-horizon-panel="race"]').hidden, true);
  const { load: loader, calls } = reads();
  const teardown = win.CairnHorizonController.mount(root, { today: TODAY, load: loader, navigate: () => {} });
  await flush();
  await flush();
  assert.equal(root.getAttribute("data-horizon-view"), "week");
  assert.ok(calls.includes("/week"), "the landing reads GET /api/week at once");
  assert.equal(root.querySelector(".hwk .frameline-h").textContent, "26 days to Cambridge Half");
  // The athlete picks the season; the next open is Week again, never the remembered view.
  await root.querySelector('[data-horizon-seg="season"]').click();
  assert.equal(root.getAttribute("data-horizon-view"), "season");
  teardown();
  assert.equal(win.CairnHorizonController.shellOptions().view, "week");
  host.innerHTML = win.CairnHorizon.shellHtml(win.CairnHorizonController.shellOptions().view);
  const again = host.querySelector("[data-horizon]");
  win.CairnHorizonController.mount(again, { today: TODAY, load: reads().load, navigate: () => {} });
  await flush();
  assert.equal(again.getAttribute("data-horizon-view"), "week");
  assert.equal(again.querySelector('[data-horizon-panel="week"]').hidden, false);
});

test("'All of the season ›' opens the Season view", async () => {
  const win = load({ CairnDrill: drillStub() });
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  win.CairnHorizonController.mount(root, { today: TODAY, load: reads().load, navigate: () => {} });
  await flush();
  await flush();
  await root.querySelector("[data-hwk-season]").click();
  assert.equal(root.getAttribute("data-horizon-view"), "season");
  assert.equal(root.querySelector('[data-horizon-panel="season"]').hidden, false);
});

test("a failed week read says so, and the next tap on Week asks again", async () => {
  const win = load({ CairnDrill: drillStub() });
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  let fail = true;
  const asked = [];
  const base = reads().load;
  const loader = (path) => {
    if (path === "/week") {
      asked.push(path);
      if (fail) return Promise.reject(new Error("offline"));
    }
    return base(path);
  };
  win.CairnHorizonController.mount(root, { today: TODAY, load: loader, navigate: () => {} });
  await flush();
  await flush();
  assert.match(root.querySelector("[data-horizon-weekview]").textContent, /couldn't be read just now/);
  fail = false;
  await root.querySelector('[data-horizon-seg="week"]').click();
  await flush();
  await flush();
  assert.equal(asked.length, 2);
  assert.ok(root.querySelector(".wkshape"));
});

// ---------- To the race wears the frame line; the Season shares the rows ----------

const RACE = {
  available: true,
  as_of: TODAY,
  race: {
    event: "Cambridge Half",
    date: "2026-11-01",
    distance_km: 21.1,
    days_to_race: 26,
    weeks_to_race: 3,
    phase: "build",
    target: { sec: 6899, pace_sec_per_km: 327, raw: "sub-1:55", kind: "time" },
    target_raw: "sub-1:55",
  },
  prediction: null,
  paces: null,
  this_week: { week_start: "2026-10-05", km: 31, long_km: 15, logged_km: 6, quality: null, why: "" },
  weeks: [
    { week_start: "2026-10-05", weeks_to_race: 3, phase: "build", kind: "build", km: 31, long_km: 15, current: true, focus: "Sharpen." },
    { week_start: "2026-10-12", weeks_to_race: 2, phase: "build", kind: "peak", km: 38, long_km: 18, current: false, focus: "" },
    { week_start: "2026-10-19", weeks_to_race: 1, phase: "build", kind: "taper", km: 22, long_km: 12, current: false, focus: "" },
    { week_start: "2026-10-26", weeks_to_race: 0, phase: "build", kind: "race", km: 10, long_km: 21.1, current: false, focus: "" },
  ],
  leg_map: [],
  strength: null,
  ride: null,
  review: { weeks: [], longest_recent_km: 15, volume_word: "steady" },
  why: "",
  reason: null,
};

const JOURNEY = {
  profile: { start_weight_lb: 170, start_date: "2026-06-01", goal_weight_lb: 154, goal_mode: "lose" },
  active_phase: { kind: "lean_out", start_date: "2026-09-25", target_weight_lb: 154 },
  recomposition: {
    stage: { kind: "lean_out", label: "Leaning-out phase" },
    progress: { current_weight_lb: 159.6, goal_weight_lb: 154 },
    scale: { line: "The completed-day trend is about -0.87 lb per week." },
  },
  milestones: [],
};

test("To the race: the hero is the shared frame line, and no km/mi switch is left", async () => {
  const win = load({ CairnDrill: drillStub() });
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  win.CairnHorizonController.mount(root, {
    today: TODAY,
    load: reads({ extra: { "/race-build": RACE, "/settings": { settings: { run_units: "mi" } } } }).load,
    navigate: () => {},
  });
  await flush();
  await flush();
  await flush();
  const race = root.querySelector('[data-horizon-lane="race"] .horizon-lane-card');
  assert.equal(race.querySelector(".frameline-h").textContent, "26 days to Cambridge Half");
  assert.equal(race.querySelector(".frameline-l").textContent, "Sharpen · block week 6 of 6 · push through Nov 15");
  assert.equal(race.querySelector(".frameline-k").textContent, "Race");
  assert.equal(!!race.querySelector(".horizon-lane-title.is-voice"), false, "the build's own voice gave way to the frame");
  assert.ok(race.querySelector(".hz-terrain"), "the ladder chart stays");
  assert.equal(race.getAttribute("aria-labelledby"), race.querySelector(".frameline-h").getAttribute("id"));
  for (const sel of ["[data-horizon-units]", ".end-units", ".horizon-units"]) {
    assert.equal(!!root.querySelector(sel), false, `no ${sel} switch on Horizon`);
  }
  // The lane's model, alone, keeps its own voice: the frame is the week read's.
  const bare = win.CairnHorizonModel.withWeek(win.CairnHorizonModel.raceLane(RACE), null);
  assert.equal(bare.frame, undefined);
});

test("Season: labs read GET /health-docs/draws, one row per draw; the goal line shares the goal and milestone rows", async () => {
  const win = load({ CairnDrill: drillStub() });
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  const draws = [
    { date: "2026-08-24", date_words: "Aug 24", kind: "bloodwork", label: "Bloodwork", doc_id: 41, doc_ids: [41, 42, 43] },
    // a repeat of the same draw never prints twice
    { date: "2026-08-24", date_words: "Aug 24", kind: "bloodwork", label: "Bloodwork", doc_id: 42, doc_ids: [42] },
    { date: "2026-07-10", date_words: "Jul 10", kind: "dexa", label: "DEXA scan", doc_id: 30, doc_ids: [30] },
  ];
  const timeline = [
    { id: "goal:weight", kind: "goal", when: { date: "2026-11-15" }, label: "Goal weight", detail: null },
  ];
  const { load: loader, calls } = reads({
    extra: { "/health-docs/draws": draws, "/journey": JOURNEY, "/journey/timeline": timeline },
  });
  win.CairnHorizonController.mount(root, { today: TODAY, load: loader, navigate: () => {} });
  await flush();
  await flush();
  await flush();
  assert.ok(calls.includes("/health-docs/draws"));
  assert.equal(calls.includes("/health-docs"), false, "the old per-document list is never read");
  const labs = root.querySelector('[data-horizon-lane="labs"]');
  const rows = labs.querySelectorAll(".msrow");
  assert.deepEqual(
    rows.map((r) => [r.querySelector(".msrow-when").textContent, r.querySelector(".msrow-label").textContent]),
    [
      ["Jul 10", "DEXA scan"],
      ["Aug 24", "Bloodwork"],
    ]
  );
  assert.ok(rows[0].classList.contains("is-mark-diamond"));
  assert.equal(rows[1].querySelector("a").getAttribute("data-horizon-go"), "labs:row:1");
  // The goal line: one sentence for the phase (never slash- or dot-joined fragments),
  // the weight as the week read's goal row (the one weight trend), its dates as milestone rows.
  const goal = root.querySelector('[data-horizon-lane="goal"]');
  assert.equal(goal.querySelector(".horizon-lane-title").textContent, "Leaning-out phase since Sep 25, toward 154 lb.");
  const weight = goal.querySelector(".goalrow");
  assert.equal(weight.getAttribute("data-goal-row"), "weight");
  assert.match(weight.textContent, /−0\.9 lb\/wk/);
  assert.doesNotMatch(goal.textContent, /-0\.87/, "never a second weight rate");
  assert.equal(goal.querySelector(".msrow .msrow-label").textContent, "Goal weight");
  // The same two components the Week page draws.
  const week = root.querySelector('[data-horizon-panel="week"]');
  assert.ok(week.querySelector(".msrow") && week.querySelector(".goalrow"));
  assertClean(root, "Horizon (all views)");
});
