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
  "day-glance-model",
  "day-detail-client",
  "day-glance-view",
  "milestone-row-model",
  "milestone-row-client",
  "goal-row-model",
  "goal-lifts-client",
  "goal-row-client",
  "frame-line-client",
  "journey-trail-client",
  "week-model",
  "week-strip-client",
  "proof-band-client",
  "ahead-strip-client",
  "team-seats-client",
  // the horizon bundle
  "horizon-model",
  "horizon-labs-model",
  "horizon-terrain-client",
  "horizon-chart-client",
  "horizon-week-client",
  "horizon-week-controller",
  "horizon-behind-client",
  "horizon-client",
  "horizon-controller",
];

function load(globals = {}) {
  return loadClientModule(MODULES, {
    globals: { Intl, localISO: () => TODAY, withBundle: (_name, fn) => fn(), ...globals },
  });
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
  const lift = opts.lift ? { day_number: 1, title: opts.lift, heavy_lower: !!opts.heavy, suggestion: null } : null;
  const run = opts.run || null;
  const parts = [lift?.title, run ? `${run.label}${run.distance_words ? `, ${run.distance_words}` : ""}` : ""].filter(
    Boolean
  );
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
      block: { week: 6, of: 6, words: "block week 6 of 6", ends_at_race: true },
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
      {
        kind: "long",
        label: "Long run",
        date: "2026-10-11",
        date_words: "Sun, Oct 11",
        words: "Long run · Sun, Oct 11",
      },
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
      {
        kind: "peak_week",
        label: "Peak week",
        date: "2026-10-12",
        end_date: "2026-10-18",
        date_words: "Oct 12 – Oct 18",
        detail: null,
      },
      {
        kind: "race",
        label: "Cambridge Half",
        date: "2026-11-01",
        end_date: null,
        date_words: "Nov 1",
        detail: "Half marathon",
      },
      {
        kind: "goal",
        label: "Goal weight",
        date: "2026-11-15",
        end_date: null,
        date_words: "Nov 15",
        detail: w.weightGoal,
      },
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
      {
        key: "weight",
        label: "Weight",
        now_text: w.weightNow,
        goal_text: w.weightGoal,
        progress: 0.62,
        line: w.weightLine,
      },
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

test("the landing (mi + lb), an older read: hero, shape, ahead as milestone rows and goals from one WeekRead", () => {
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
  assert.match(
    host.querySelector(".hwk-summary").textContent,
    /^Sharpen week: 1 of 4 lifting days and 3\.7 of 19\.3 mi in/
  );
  // The days fold as rows that open each day's page (Program's own row words).
  const rows = host.querySelectorAll(".hwk-days .pahead-day");
  assert.equal(rows.length, 7);
  assert.equal(rows[3].getAttribute("data-open-day"), "2026-10-08");
  // 3. "Still open" is gone: the hollow columns already mark the open key sessions.
  assert.equal(host.querySelectorAll(".hwk-open-row").length, 0);
  assert.equal(!!host.querySelector(".hwk-sec.is-open"), false);
  // The masthead carries the totals words; an older read without `sub` keeps the summary.
  assert.equal(host.querySelector(".hwk-sec.is-shape .hwk-aside").textContent, "1 of 4 lifting days");
  // 4. Ahead, with no journey marks (an older shape): the next milestone rows (the Season's
  // own row), then the way to the season.
  const next = host.querySelectorAll(".hwk-sec.is-ahead .msrow");
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
  // The tag wears the day's own stone: the lift's, or on a run-only day the run's.
  assert.ok(cols[4].querySelector(".wkshape-tag").classList.contains("stone-strength"));
  assert.equal(cols[6].querySelector(".wkshape-tag").textContent, "LR");
  assert.ok(cols[6].querySelector(".wkshape-tag").classList.contains("stone-endurance"));
  assert.equal(cols[5].querySelector(".wkshape-tag").textContent, "", "a rest day names nothing");
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
  assert.deepEqual(asked, [
    ["/week", "plan:week-read"],
    ["/team-week?drain=0", "horizon:team-week"],
  ]);
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
  assert.ok(
    CairnDrill.calls.some((c) => c.closed),
    "the second tap closes the peek through the drill"
  );
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
    {
      week_start: "2026-10-05",
      weeks_to_race: 3,
      phase: "build",
      kind: "build",
      km: 31,
      long_km: 15,
      current: true,
      focus: "Sharpen.",
    },
    {
      week_start: "2026-10-12",
      weeks_to_race: 2,
      phase: "build",
      kind: "peak",
      km: 38,
      long_km: 18,
      current: false,
      focus: "",
    },
    {
      week_start: "2026-10-19",
      weeks_to_race: 1,
      phase: "build",
      kind: "taper",
      km: 22,
      long_km: 12,
      current: false,
      focus: "",
    },
    {
      week_start: "2026-10-26",
      weeks_to_race: 0,
      phase: "build",
      kind: "race",
      km: 10,
      long_km: 21.1,
      current: false,
      focus: "",
    },
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
  assert.equal(
    !!race.querySelector(".horizon-lane-title.is-voice"),
    false,
    "the build's own voice gave way to the frame"
  );
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
    {
      date: "2026-08-24",
      date_words: "Aug 24",
      kind: "bloodwork",
      label: "Bloodwork",
      doc_id: 41,
      doc_ids: [41, 42, 43],
    },
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
  await root.querySelector('[data-horizon-seg="season"]').click(); // the Season's reads wait for it
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

// ---------- the journey trail (a module Week no longer composes) and the starter ----------

function journey() {
  return {
    start_date: "2026-09-08",
    start_words: "Sep 8",
    today: TODAY,
    marks: [
      {
        kind: "peak_week",
        label: "Peak week · 48 km",
        date: "2026-10-12",
        end_date: "2026-10-18",
        date_words: "Oct 12 – Oct 18",
        detail: "Long run 18 km.",
        short: "48 km",
        days_away: 6,
        days_words: "in 6 days",
        summit: false,
        href: "/app/day/2026-10-12",
      },
      {
        kind: "race",
        label: "Cambridge Half",
        date: "2026-11-01",
        end_date: null,
        date_words: "Nov 1",
        detail: "Reads 1:52:10, inside sub-1:55.",
        short: "Half",
        days_away: 26,
        days_words: "in 4 weeks",
        summit: false,
        href: "/app/horizon/race",
      },
      {
        kind: "goal",
        label: "Goal weight · 154 lb",
        date: "2026-12-15",
        end_date: null,
        date_words: "Dec 15",
        detail: null,
        short: "154 lb",
        days_away: 70,
        days_words: "in 10 weeks",
        summit: true,
        href: null,
      },
    ],
    behind: [
      { key: "race", words: "Race estimate 4 min faster since Sep 8" },
      { key: "weight", words: "−2.1 lb since Aug 30" },
    ],
    line: "28 days on this road so far. Next, the peak week in 6 days; your goal weight in 10 weeks.",
  };
}

function trail(win, j, opts = {}) {
  return renderHtml(win.CairnJourneyTrail.trailHtml(j, opts), { document: win.document });
}

test("the journey trail module still draws to scale; Week no longer composes it", () => {
  const win = load();
  const road = trail(win, journey());
  assert.equal(road.querySelector(".hjour-line").textContent, journey().line);
  assert.equal(road.querySelectorAll(".hjour-node[data-hjour-node]").length, 2);
  assert.ok(road.querySelector(".hjour-node.is-summit .hjour-cairn"));
  assert.ok(road.querySelector(".hjour-band"), "a peak week is lit along the trail");
  const summit = road.querySelector(".hjour-lbl.is-summit");
  assert.equal(summit.querySelector("b").textContent, "154 lb");
  assert.match(
    road.querySelector(".hjour-plot").getAttribute("aria-label"),
    /from Sep 8 through today to Goal weight · 154 lb, Dec 15/
  );
  // Week shows the Ahead strip in its place.
  const host = landing(win, { ...weekRead(), journey: journey() });
  assert.equal(!!host.querySelector(".hjour-plot"), false, "the trail is not on Week");
  assert.ok(host.querySelector(".hwk-sec.is-ahead .ahead-strip"));
  assertClean(road, "the trail");
});

test("the journey trail: server words stay text; the summit is the mark the road ends at", () => {
  const win = load();
  const j = journey();
  j.marks[1].short = "<img src=x>";
  j.line = "<script>x</script>";
  const road = trail(win, j);
  assert.equal(!!road.querySelector("img"), false);
  assert.equal(!!road.querySelector("script"), false);
  const k = journey();
  k.marks = [
    { ...k.marks[0], date: "2026-10-12", end_date: "2026-10-18", summit: true },
    {
      kind: "checkpoint",
      label: "Strength checkpoint",
      date: "2026-10-14",
      end_date: null,
      date_words: "Oct 14",
      detail: null,
      short: "Test",
      days_away: 8,
      days_words: "in 8 days",
      summit: false,
    },
  ];
  const peak = trail(win, k);
  assert.match(peak.querySelector(".hjour-plot").getAttribute("aria-label"), /to Peak week · 48 km, Oct 12 – Oct 18$/);
  assert.equal(peak.querySelectorAll(".hjour-node.is-summit").length, 1);
});

test("ahead, starter: nothing dated ahead opens chat with a first sentence, never sent", async () => {
  const state = { chatPrefill: null };
  const tabs = [];
  const win = load({ CairnDrill: drillStub(), state, activateTab: (name) => tabs.push(name) });
  // No goals at all: the road starts here, with openers and the plain way in (just log).
  const fresh = landing(win, { ...weekRead(), next_milestones: [], goals: [], journey: null });
  assert.equal(fresh.querySelector(".hwk-sec.is-ahead .hwk-k").textContent, "Ahead");
  assert.equal(fresh.querySelector(".hwk-sec.is-ahead .hjour-start-h").textContent, "Your road starts here");
  assert.deepEqual(
    fresh.querySelectorAll("[data-hjour-ask]").map((b) => b.textContent),
    ["A race", "A weight goal", "A stronger lift", "Not sure yet"]
  );
  assert.match(fresh.querySelector(".hjour-hint").textContent, /log today/);
  // Goals set but none dated: the ask is a date.
  const undated = landing(win, { ...weekRead(), next_milestones: [], journey: null });
  assert.equal(undated.querySelector(".hjour-start-h").textContent, "Give a goal a date");
  // Another week than this one draws no starter.
  const other = landing(win, { ...weekRead(), next_milestones: [], this_week: false, journey: null });
  assert.equal(!!other.querySelector(".hjour"), false);
  assert.equal(!!other.querySelector(".hwk-sec.is-ahead"), false);

  const slot = createHost(win.document);
  win.CairnHorizonWeekController.mount(slot, {
    peek: () => null,
    load: () => Promise.resolve({ ...weekRead(), next_milestones: [], goals: [], journey: null }),
  });
  await flush();
  await flush();
  await slot.querySelector("[data-hjour-ask]").click();
  assert.match(String(state.chatPrefill), /^I'm training for a race\./);
  assert.deepEqual(tabs, ["chat"]);
});

// ---------- the redesigned landing (docs/IA.md "Horizon landing") ----------

function proof() {
  return [
    {
      key: "weight",
      stone: "body",
      label: "Weight",
      before_text: "183 lb",
      after_text: "153.9 lb",
      since_words: "since Jun 6",
      series: [1, 0.7, 0.45, 0.2, 0],
      series_kind: "line",
      href: "/app/horizon/goal",
    },
    {
      key: "strength",
      stone: "strength",
      label: "Bench press",
      before_text: "115 lb × 10",
      after_text: "145 lb × 6",
      since_words: "since Jul 2",
      series: [0, 0, 0.33, 0.66, 1],
      series_kind: "steps",
      href: null,
    },
    {
      key: "race_done",
      stone: "endurance",
      label: "Running",
      before_text: null,
      after_text: "First half marathon · 2:10:18",
      since_words: null,
      series: [0.4, 0.2, 0.8, 1],
      series_kind: "columns",
      href: "/app/horizon/behind?id=3",
    },
  ];
}

function trackedGoals() {
  return [
    {
      key: "weight",
      label: "Weight",
      now_text: "153.9 lb",
      goal_text: "148 lb",
      progress: 0.83,
      line: "Trending −0.4 lb/wk — on pace for Feb 14.",
      id: "weight",
      start_text: "183 lb · Jun 6",
      goal_words: "148 lb · Feb 14",
      track: { start: 0, now: 0.83, goal: 1, ago: 0.75, ago_words: "4 weeks ago" },
      direction: "toward",
      direction_words: "On pace",
      move_words: "0.4 lb a week, 0.5 needed",
      href: "/app/horizon/goal",
    },
    {
      key: "race",
      label: "5K time trial",
      now_text: "22:50",
      goal_text: "20:00",
      progress: 0.2,
      line: "Reads 22:50.",
      fit: "beyond_horizon",
      id: "race",
      start_text: "23:33 · Oct 19",
      goal_words: "20:00 · May 16",
      // Four weeks ago it stood where it started: no ring.
      track: { start: 0, now: 0.2, goal: 1, ago: 0, ago_words: "4 weeks ago" },
      direction: "toward",
      direction_words: "Moving toward",
      move_words: "43 s faster in four weeks",
      href: "/app/horizon/race",
    },
    {
      key: "strength",
      label: "Overhead press",
      now_text: "89 lb",
      goal_text: "105 lb",
      progress: 0.2,
      line: "Est. 1RM 89 lb.",
      id: "strength:overhead-press",
      start_text: "100 lb · Aug 3",
      goal_words: "105 lb",
      // Now has fallen behind its start.
      track: { start: 0.75, now: 0.2, goal: 1, ago: 0.33, ago_words: "Oct 19" },
      direction: "back",
      direction_words: "Drifting back",
      move_words: "0.7 lb a week",
      href: null,
    },
  ];
}

function newRead() {
  const r = weekRead();
  r.frame = {
    ...r.frame,
    block: { week: 5, of: 6, words: "block week 5 of 6" },
    countdown: {
      days: 181,
      event: "5K time trial",
      race_date: "2027-04-05",
      race_date_words: "Apr 5",
      words: "181 days to 5K time trial",
      far_words: "5K time trial in 26 weeks",
    },
    purpose: "Build the engine. Keep the press moving.",
    lead: "purpose",
    headline: "Build the engine. Keep the press moving.",
    sub: "One lift in of four, two key runs ahead. 5K time trial in 26 weeks.",
  };
  r.totals = { ...r.totals, run_words: "3.7 of 19.3 mi" };
  r.proof = proof();
  r.goals = trackedGoals();
  r.journey = journey();
  return r;
}

function teamRead() {
  return {
    lead: "",
    did: [],
    flagged: [],
    watching: [],
    landed: [],
    insights: [],
    seats: [
      {
        seat: "strength",
        role: "Strength",
        did: "Bench moved to 145 lb today.",
        expects: "Expects every set at six or more by Nov 30.",
        landed: null,
        when: "today",
      },
      {
        seat: "endurance",
        role: "Run",
        did: "A base week: 16.6 mi, the long run easy on Sunday.",
        expects: null,
        landed: "Last call landed as expected.",
        when: "Mon",
      },
      {
        seat: "fuel",
        role: "Fuel",
        did: "Holding the cut pace.",
        expects: "Will raise it before Nov 30.",
        landed: "Landed early.",
        when: "Tue",
      },
      { seat: "heart", role: "Heart", did: "A fourth seat is never drawn.", expects: null, landed: null, when: "Wed" },
    ],
    link: {
      seats: ["fuel", "strength"],
      text: "Two anchor lifts are sliding while your weight drops.",
      ask: "What if I ease the cut a little?",
    },
    changes_count: 7,
  };
}

test("the hero leads with the purpose, says the other once under it, and the ribbon ends at a race only inside its block", () => {
  const win = load();
  const host = landing(win, newRead());
  assert.equal(host.querySelector(".frameline-h").textContent, "Build the engine. Keep the press moving.");
  assert.equal(
    host.querySelector(".frameline-l").textContent,
    "One lift in of four, two key runs ahead. 5K time trial in 26 weeks."
  );
  assert.equal(
    host.querySelector(".frameline-k").textContent,
    "This week · Oct 5 – Oct 11 · Sharpen · block week 5 of 6 · push through Nov 15"
  );
  // No `ends_at_race`: a race 26 weeks out never ends a six-week ribbon.
  assert.equal(host.querySelectorAll(".frameline-step").length, 6);
  assert.equal(!!host.querySelector(".frameline-end"), false);
  // The summary is folded into `sub` by the server: never said twice.
  assert.equal(!!host.querySelector(".hwk-summary"), false);
  assert.equal(host.querySelector(".hwk-sec.is-shape .hwk-aside").textContent, "1 of 4 lifting days · 3.7 of 19.3 mi");
  // Section order: stand, week, ahead.
  assert.deepEqual(
    host.querySelectorAll(".hwk-sec").map((s) => s.querySelector(".hwk-k").textContent),
    ["Since you started", "Where you stand", "This week's shape", "Ahead"]
  );
  // An older frame (no sub) keeps its line and plain kicker; the race end needs the flag.
  const old = landing(win, weekRead());
  assert.equal(old.querySelector(".frameline-l").textContent, "Sharpen · block week 6 of 6 · push through Nov 15");
  assert.equal(old.querySelector(".frameline-k").textContent, "This week · Oct 5 – Oct 11");
  const noFlag = weekRead();
  delete noFlag.frame.block.ends_at_race;
  assert.equal(!!landing(win, noFlag).querySelector(".frameline-end"), false);
  assertClean(host, "the new landing");
});

test("since you started: three hairline rows, a picture each, before → after, links where a page exists", () => {
  const win = load();
  const host = landing(win, newRead());
  const rows = host.querySelectorAll(".hwk-sec.is-proof .proof-row");
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.querySelector(".proof-label").textContent),
    ["Weightsince Jun 6", "Bench presssince Jul 2", "Running"]
  );
  assert.ok(rows[0].classList.contains("stone-body"));
  // Before → after, the after in the display face; a single fact prints its after alone.
  assert.equal(rows[0].querySelector(".proof-after").textContent, "153.9 lb");
  assert.match(rows[0].querySelector(".proof-ba").textContent, /^183 lb → +to +153\.9 lb$/);
  assert.equal(rows[2].querySelector(".proof-ba").textContent, "First half marathon · 2:10:18");
  // The pictures: a line with an end dot, steps, columns with the last in the deep hue.
  const line = rows[0].querySelector("svg.proof-svg");
  assert.equal(line.getAttribute("aria-hidden"), "true");
  assert.ok(line.classList.contains("is-line"));
  assert.ok(rows[0].querySelector("path.proof-line") && rows[0].querySelector("path.proof-end"));
  assert.match(rows[1].querySelector("path.proof-line").getAttribute("d"), /H.*V/);
  const cols = rows[2].querySelectorAll("rect.proof-col");
  assert.equal(cols.length, 4);
  assert.deepEqual(
    cols.map((c) => c.classList.contains("is-last")),
    [false, false, false, true]
  );
  // No colour is written into the picture: the stone class carries it.
  assert.doesNotMatch(host.querySelector(".proof-band").outerHTML || "", /#[0-9a-f]{3,6}\b|fill="|stroke="/i);
  // A row with a page is a real link Horizon routes; one without stays plain.
  assert.equal(rows[0].querySelector("a.proof-link").getAttribute("href"), "/app/horizon/goal");
  assert.ok(rows[0].querySelector("a.proof-link").hasAttribute("data-horizon-href"));
  assert.equal(!!rows[1].querySelector("a"), false);
  // "Behind you ›" on the masthead (shown by CSS only while that segment exists).
  assert.equal(host.querySelector(".hwk-sec.is-proof [data-hwk-behind]").textContent, "Behind you ›");
  // A cold paint draws the pictures once; a warm one does not.
  const cold = renderHtml(win.CairnHorizonWeek.landingHtml(win.CairnWeekModel.landing(newRead()), { enter: true }), {
    document: win.document,
  });
  assert.ok(cold.querySelector(".proof-band.is-drawing"));
  assert.equal(!!host.querySelector(".proof-band.is-drawing"), false);
  // Absent, empty or unusable: the section is left out.
  for (const value of [undefined, [], [{ key: "weight", label: "", after_text: "x" }]]) {
    const r = newRead();
    r.proof = value;
    assert.equal(!!landing(win, r).querySelector(".hwk-sec.is-proof"), false);
  }
  assertClean(host, "proof band");
});

test("the proof picture is drawn to scale within its own span", () => {
  const win = load();
  const { BOX, seriesPoints, seriesSvg } = win.CairnProofBand;
  const pts = seriesPoints([0, 0.5, 1]);
  assert.deepEqual(plain(pts.map((p) => p.x)), [BOX.P, BOX.W / 2, BOX.W - BOX.P]);
  assert.equal(pts[0].y, BOX.H - BOX.P, "the lowest value sits on the floor");
  assert.equal(pts[2].y, BOX.P, "the highest at the top");
  assert.equal(pts[1].y, BOX.H / 2);
  assert.equal(seriesSvg([0.5], "line"), "", "one value draws nothing");
  assert.equal(seriesSvg([], "columns"), "");
  // A server series out of range is held to the span, never drawn outside it.
  assert.equal(seriesPoints([-2, 3])[0].y, BOX.H - BOX.P);
});

test("server text in the proof band and the team stays text", () => {
  const win = load();
  const r = newRead();
  r.proof[0].label = "<img src=x onerror=boom()>";
  r.proof[0].after_text = "<b>153</b>";
  r.proof[0].href = 'javascript:alert(1)"';
  const host = landing(win, r);
  assert.equal(!!host.querySelector(".proof-band img"), false);
  assert.equal(!!host.querySelector(".proof-band b b"), false);
  assert.match(host.querySelector(".proof-label").textContent, /<img/);
  assert.equal(!!host.querySelectorAll(".proof-row")[0].querySelector("a"), false, "a non-app href is no link");
  const team = teamRead();
  team.seats[0].did = "<script>x</script>";
  team.link.text = "<img src=y>";
  team.link.ask = '"><img src=z>';
  const model = win.CairnTeamSeats.model(team);
  const html = renderHtml(
    win.CairnHorizonWeek.teamHtml(model, "/app/ask/coach") + win.CairnHorizonWeek.linkNoteHtml(model),
    { document: win.document }
  );
  assert.equal(!!html.querySelector("script"), false);
  assert.equal(!!html.querySelector("img"), false);
  assert.match(html.querySelector(".seat-did").textContent, /<script>/);
  assert.equal(html.querySelector("[data-hwk-ask]").getAttribute("data-hwk-ask"), '"><img src=z>');
});

test("where you stand: each goal draws start, four weeks ago, now and goal, and says its direction in words", () => {
  const win = load();
  const host = landing(win, newRead());
  const rows = host.querySelectorAll(".hwk-sec.is-goals .goalrow");
  assert.deepEqual(
    rows.map((g) => g.getAttribute("data-goal-row")),
    ["weight", "race", "strength"]
  );
  const [weight, race, press] = rows;
  // The words line: the direction in the stone's deep hue, then the measure.
  assert.equal(weight.querySelector(".goalrow-dir").textContent, "On pace");
  assert.equal(weight.querySelector(".goalrow-words").textContent, "On pace · 0.4 lb a week, 0.5 needed");
  assert.equal(race.querySelector(".goalrow-words").textContent, "Moving toward · 43 s faster in four weeks");
  assert.ok(press.querySelector(".goalrow-dir").classList.contains("is-back"));
  // The race never leads with its fit word once the read says a direction.
  assert.doesNotMatch(race.textContent, /Beyond horizon/);
  // The track: start and goal ticks, a ring four weeks back, the dot at now; ends in mono words.
  const at = (el) => Number(/--x:([\d.]+)/.exec(el.getAttribute("style"))[1]);
  assert.equal(at(weight.querySelector(".goalrow-tick.is-start")), 0);
  assert.equal(at(weight.querySelector(".goalrow-tick.is-goal")), 100);
  assert.equal(at(weight.querySelector(".goalrow-ring")), 75);
  assert.equal(at(weight.querySelector(".goalrow-now")), 83);
  assert.deepEqual(
    weight.querySelectorAll(".goalrow-ends span").map((s) => s.textContent),
    ["183 lb · Jun 6", "148 lb · Feb 14"]
  );
  assert.equal(!!race.querySelector(".goalrow-ring"), false, "a ring on the start says nothing: omitted");
  // Now behind its start: the fill spans now → start and grows from the start's side (right).
  const fill = press.querySelector(".goalrow-tfill");
  assert.ok(fill.classList.contains("is-from-right"));
  assert.match(fill.getAttribute("style"), /--l:20;--w:55/);
  assert.ok(weight.querySelector(".goalrow-tfill").classList.contains("is-from-left"));
  // Said in words, never a percent.
  assert.equal(
    weight.querySelector(".goalrow-thread").getAttribute("aria-label"),
    "Weight: started at 183 lb · Jun 6; now 153.9 lb; goal 148 lb · Feb 14; on pace compared with 4 weeks ago, 0.4 lb a week, 0.5 needed"
  );
  assert.equal(
    press.querySelector(".goalrow-thread").getAttribute("aria-label"),
    "Overhead press: started at 100 lb · Aug 3; now 89 lb; goal 105 lb; drifting back compared with Oct 19, 0.7 lb a week"
  );
  // Rows with a page are real links with a chevron; one without stays a plain row.
  const link = weight.querySelector("a.goalrow-link");
  assert.equal(link.getAttribute("href"), "/app/horizon/goal");
  assert.ok(link.hasAttribute("data-horizon-href"));
  assert.equal(link.querySelector(".goalrow-chev").textContent, "›");
  assert.equal(race.querySelector("a.goalrow-link").getAttribute("href"), "/app/horizon/race");
  assert.equal(!!press.querySelector("a"), false);
  assertClean(host, "goal tracks");
});

test("the goal track's geometry, including a thread now behind its start", () => {
  const win = load();
  const g = win.CairnGoalRowModel.trackGeometry;
  assert.deepEqual(plain(g({ start: 0, now: 0.5, goal: 1, ago: 0.25 })), {
    start: 0,
    now: 50,
    goal: 100,
    ago: 25,
    fill_left: 0,
    fill_width: 50,
    origin: "left",
  });
  assert.deepEqual(plain(g({ start: 0.6, now: 0.1, goal: 1, ago: null })), {
    start: 60,
    now: 10,
    goal: 100,
    ago: null,
    fill_left: 10,
    fill_width: 50,
    origin: "right",
  });
  // The served axis is held to 0..1, and an `ago` on the start is dropped by the model.
  const row = win.CairnGoalRowModel.fromWeekRead({
    key: "strength",
    label: "Squat",
    now_text: "225 lb",
    goal_text: "275 lb",
    progress: 0.4,
    track: { start: -0.2, now: 1.4, goal: 1, ago: 0, ago_words: "4 weeks ago" },
  });
  assert.deepEqual(plain(row.track), { start: 0, now: 1, goal: 1, ago: null });
});

test("an older read keeps the meter and its place word; the Season's goal row still draws", () => {
  const win = load();
  const r = newRead();
  r.goals = weekRead().goals; // no track, no direction
  const host = landing(win, r);
  const goals = host.querySelectorAll(".goalrow");
  assert.equal(
    goals[0].querySelector(".goalrow-word").textContent,
    "Fits",
    "the fit word stands in when no direction is said"
  );
  assert.ok(goals[1].querySelector(".goalrow-track .goalrow-fill"));
  assert.equal(!!host.querySelector(".goalrow-thread"), false);
  assert.equal(!!host.querySelector(".goalrow a"), false);
  // A track with no direction words keeps the older words line beside the track.
  const mixed = newRead();
  delete mixed.goals[0].direction_words;
  const row = landing(win, mixed).querySelector(".goalrow");
  assert.ok(row.querySelector(".goalrow-thread"));
  assert.match(
    row.querySelector(".goalrow-name small").textContent,
    /^Trending −0\.4 lb\/wk — on pace for Feb 14\. · Most of the way$/
  );
});

test("ahead: the next four weeks take half the strip, then to the furthest mark; every mark a row", () => {
  const win = load();
  const { aheadPosition, aheadLayout } = win.CairnAheadStrip;
  // The broken axis: day 14 at a quarter, day 28 at the middle, the furthest at the end.
  for (const far of [70, 181]) {
    assert.equal(aheadPosition(14, far), 0.25);
    assert.equal(aheadPosition(28, far), 0.5);
    assert.equal(aheadPosition(far, far), 1);
    assert.equal(aheadPosition(0, far), 0);
  }
  assert.equal(aheadPosition(49, 70), 0.75);
  // All within four weeks: one linear four-week axis, no break.
  assert.equal(aheadPosition(14, 20), 0.5);
  assert.equal(aheadPosition(7, 20), 0.25);
  const host = landing(win, newRead());
  const sec = host.querySelector(".hwk-sec.is-ahead");
  const strip = sec.querySelector(".ahead-strip");
  assert.ok(strip.classList.contains("is-broken"));
  assert.ok(strip.querySelector(".ahead-break"));
  assert.ok(strip.querySelector(".ahead-today"));
  assert.equal(strip.querySelector(".ahead-lab.is-near").textContent, "Next four weeks");
  assert.equal(strip.querySelector(".ahead-lab.is-far").textContent, "then to Dec");
  // A window draws as a bar from its start to its end; marks wear their kind's stone.
  const marks = strip.querySelectorAll(".ahead-mark");
  assert.equal(marks.length, 3);
  assert.ok(marks[0].classList.contains("is-window") && marks[0].classList.contains("stone-endurance"));
  assert.match(marks[0].getAttribute("style"), /--x:10\.7;--x2:21\.4/);
  assert.match(marks[2].getAttribute("style"), /--x:100/);
  assert.ok(marks[2].classList.contains("stone-body"));
  assert.equal(
    strip.getAttribute("aria-label"),
    "Ahead: Peak week · 48 km in 6 days; Cambridge Half in 4 weeks; Goal weight · 154 lb in 10 weeks"
  );
  const layout = aheadLayout(win.CairnWeekModel.landing(newRead()).ahead);
  assert.equal(layout.broken, true);
  assert.equal(layout.furthest, 70);
  // Every mark a milestone row; a mark with a page is a link with a chevron, one without stays plain.
  const rows = sec.querySelectorAll(".msrow");
  assert.deepEqual(
    rows.map((r) => r.querySelector(".msrow-label").textContent),
    ["Peak week · 48 km", "Cambridge Half", "Goal weight · 154 lb"]
  );
  assert.equal(rows[1].querySelector("a").getAttribute("data-horizon-href"), "/app/horizon/race");
  assert.equal(rows[1].querySelector(".msrow-arw").textContent, "›");
  assert.equal(!!rows[2].querySelector("a"), false);
  assert.equal(!!sec.querySelector("[data-hwk-season]"), false, "five or fewer: nothing hidden, no more link");
  assert.equal(!!host.querySelector(".hwk-sec.is-next"), false, "Next up merged into Ahead");
  assertClean(host, "ahead");
});

test("ahead: more than five marks show five and '+N more ›'; a near-only road is one unbroken axis", () => {
  const win = load();
  const r = newRead();
  const base = journey().marks[1];
  r.journey.marks = Array.from({ length: 7 }, (_, i) => ({
    ...base,
    label: `Mark ${i + 1}`,
    date: `2026-10-${String(10 + i).padStart(2, "0")}`,
    date_words: `Oct ${10 + i}`,
    days_away: 4 + i,
    days_words: `in ${4 + i} days`,
    summit: i === 6,
    href: null,
  }));
  const host = landing(win, r);
  const sec = host.querySelector(".hwk-sec.is-ahead");
  assert.equal(sec.querySelectorAll(".msrow").length, 5);
  assert.equal(sec.querySelectorAll(".ahead-mark").length, 7, "the strip shows every mark");
  assert.equal(sec.querySelector("[data-hwk-season]").textContent, "+2 more ›");
  const strip = sec.querySelector(".ahead-strip");
  assert.equal(strip.classList.contains("is-broken"), false);
  assert.equal(!!strip.querySelector(".ahead-break"), false);
  assert.equal(!!strip.querySelector(".ahead-lab.is-far"), false);
});

test("your team: up to three seats fill their own slot when the team read lands; the link note sits under the goals", async () => {
  const state = { chatPrefill: null };
  const tabs = [];
  const win = load({ CairnDrill: drillStub(), state, activateTab: (name) => tabs.push(name) });
  const slot = createHost(win.document);
  let releaseTeam;
  const team = new Promise((resolve) => {
    releaseTeam = resolve;
  });
  const went = [];
  win.CairnHorizonWeekController.mount(slot, {
    peek: () => null,
    load: (path) => (path === "/team-week?drain=0" ? team : Promise.resolve(newRead())),
    changesHref: "/app/ask/coach",
    onChanges: () => went.push("changes"),
  });
  await flush();
  await flush();
  assert.ok(slot.querySelector(".hwk .frameline-h"), "the landing never waits on the team");
  assert.equal(slot.querySelector("[data-hwk-team-slot]").innerHTML, "");
  const shape = slot.querySelector(".wkshape");
  releaseTeam(teamRead());
  await flush();
  await flush();
  assert.equal(slot.querySelector(".wkshape"), shape, "the landing is not repainted");
  const seats = slot.querySelectorAll(".hwk-sec.is-team .seat");
  assert.equal(seats.length, 3, "three seats at most");
  assert.deepEqual(
    seats.map((s) => s.querySelector(".seat-role").textContent),
    ["Strength", "Run", "Fuel"]
  );
  assert.ok(seats[0].classList.contains("stone-strength"));
  assert.equal(seats[0].querySelector(".seat-tail").textContent, "Expects every set at six or more by Nov 30.");
  assert.equal(seats[2].querySelector(".seat-tail").textContent, "Will raise it before Nov 30. Landed early.");
  const changes = slot.querySelector("[data-hwk-changes]");
  assert.equal(changes.textContent, "7 changes this week ›");
  assert.equal(changes.getAttribute("href"), "/app/ask/coach");
  await changes.click();
  assert.deepEqual(went, ["changes"]);
  // The link note: under the goals, a dawn rule, the two seats named, a chip that prefills chat.
  const note = slot.querySelector("[data-hwk-link-slot] .hwk-linknote");
  assert.equal(note.querySelector(".hwk-linknote-k").textContent, "Fuel and Strength, together");
  assert.equal(
    note.querySelector(".hwk-linknote-t").textContent,
    "Two anchor lifts are sliding while your weight drops."
  );
  await note.querySelector("[data-hwk-ask]").click();
  assert.equal(state.chatPrefill, "What if I ease the cut a little?");
  assert.deepEqual(tabs, ["chat"]);
  assertClean(slot, "team");
});

test("your team: a failed or older team read simply leaves both sections out", async () => {
  for (const team of [
    Promise.reject(new Error("offline")),
    Promise.resolve({ lead: "", did: [] }),
    Promise.resolve(null),
  ]) {
    team.catch(() => {});
    const win = load({ CairnDrill: drillStub() });
    const slot = createHost(win.document);
    win.CairnHorizonWeekController.mount(slot, {
      peek: () => null,
      load: (path) => (path === "/team-week?drain=0" ? team : Promise.resolve(newRead())),
    });
    await flush();
    await flush();
    await flush();
    assert.ok(slot.querySelector(".hwk .wkshape"));
    assert.equal(!!slot.querySelector(".hwk-sec.is-team"), false);
    assert.equal(!!slot.querySelector(".hwk-linknote"), false);
  }
  // One change reads in the singular; none prints no aside.
  const win = load();
  const one = win.CairnTeamSeats.model({ ...teamRead(), changes_count: 1 });
  assert.match(win.CairnTeamSeats.changesHtml(one, "#"), /1 change this week ›/);
  assert.equal(win.CairnTeamSeats.changesHtml({ ...one, changes: 0 }, "#"), "");
});

test("a thread's link routes through Horizon's openHref; Behind you and To the race show only when they hold something", async () => {
  const win = load({ CairnDrill: drillStub() });
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml(win.CairnHorizonController.shellOptions().view);
  const root = host.querySelector("[data-horizon]");
  const opened = [];
  const shownSegs = () =>
    root
      .querySelectorAll("[data-horizon-seg]")
      .filter((b) => !b.hidden)
      .map((b) => b.textContent);
  win.CairnHorizonController.mount(root, {
    today: TODAY,
    load: reads({
      extra: {
        "/week": newRead(),
        "/race-build": { ...RACE, race: { ...RACE.race, days_to_race: 181 } },
        "/goal-reviews": {
          reviews: [{ id: 3, title: "Cambridge Half", achieved_on: "2026-11-01", date_text: "Nov 1", status: "ready" }],
        },
      },
    }).load,
    navigate: () => {},
    openHref: (href) => {
      opened.push(href);
      return true;
    },
  });
  await flush();
  await flush();
  await flush();
  // The race is 181 days out: no "To the race" segment; something is behind: "Behind you" shows.
  assert.deepEqual(shownSegs(), ["Week", "Season", "Behind you"]);
  assert.ok(root.hasAttribute("data-horizon-behind-shown"));
  const bar = root.querySelector(".horizon-seg");
  assert.ok(bar.classList.contains("seg-sliding") && bar.querySelector(".seg-thumb"));
  assert.match(bar.getAttribute("style"), /--segn:\s*3/);
  await root.querySelector('.goalrow[data-goal-row="race"] a.goalrow-link').click();
  assert.deepEqual(opened, ["/app/horizon/race"]);
  // "Behind you ›" on the proof band switches to the segment.
  await root.querySelector("[data-hwk-behind]").click();
  assert.equal(root.getAttribute("data-horizon-view"), "behind");
  assert.match(bar.getAttribute("style"), /--segi:\s*2/);
  assert.equal(root.querySelector('[data-horizon-panel="behind"]').hidden, false);
});

function liftsGoal() {
  return {
    key: "strength",
    label: "Strength",
    now_text: "3 lifts",
    goal_text: null,
    progress: null,
    line: "",
    move_words: "One rising, one holding, one drifting back",
    track: null,
    direction: null,
    href: "/app/train/program",
    lifts: [
      {
        id: "strength:deadlift",
        label: "Deadlift",
        now_text: "285 lb",
        goal_text: "405 lb",
        track: { start: 0.1, now: 0.5, goal: 1, ago: 0.4, ago_words: "4 weeks ago" },
        direction: "toward",
        direction_words: "Moving toward",
        move_words: "1.2 lb a week up",
      },
      {
        id: "strength:press",
        label: "Overhead Press <b>x</b>",
        now_text: "95 lb",
        goal_text: "135 lb",
        track: { start: 0.5, now: 0.3, goal: 1, ago: 0.45, ago_words: "4 weeks ago" },
        direction: "back",
        direction_words: "Drifting back",
        move_words: null,
      },
      {
        id: "strength:squat",
        label: "Front Squat",
        now_text: "150 lb",
        goal_text: "200 lb",
        track: null,
        direction: null,
        direction_words: null,
        move_words: null,
      },
    ],
  };
}

test("where you stand: a strength row with several lifts stacks one mini track per lift under one header", () => {
  const win = load();
  const r = newRead();
  r.goals = [...trackedGoals().slice(0, 2), liftsGoal()];
  const host = landing(win, r);
  const rows = host.querySelectorAll(".hwk-sec.is-goals .goalrow");
  assert.equal(rows.length, 3, "nested lifts are not goal rows");
  const row = rows[2];
  assert.equal(row.querySelector(".goalrow-num").textContent, "3 lifts›");
  assert.equal(row.querySelector(".goalrow-words").textContent, "One rising, one holding, one drifting back");
  assert.equal(row.querySelector("a.goalrow-link").getAttribute("href"), "/app/train/program");
  assert.equal(!!row.querySelector(".goalrow-thread"), false, "the single track gives way to the stack");
  const list = row.querySelector("ul.goallift-list");
  const items = list.querySelectorAll("li.goallift");
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((li) => li.querySelector(".goallift-num").textContent),
    ["285 lb", "95 lb", "150 lb"]
  );
  assert.deepEqual(
    items.map((li) => li.querySelector(".sr-only").textContent),
    [
      "Deadlift, 285 lb, goal 405 lb, moving toward, 1.2 lb a week up. ",
      "Overhead Press <b>x</b>, 95 lb, goal 135 lb, drifting back. ",
      "Front Squat, 150 lb, goal 200 lb. ",
    ]
  );
  assert.equal(items[0].querySelector(".goallift-dir").textContent, "Moving toward");
  assert.ok(items[1].querySelector(".goallift-dir").classList.contains("is-back"));
  assert.equal(items[2].querySelector(".goallift-dir"), null);
  assert.equal(items[0].querySelectorAll(".goalrow-tick").length, 2);
  assert.ok(items[0].querySelector(".goalrow-ring"));
  assert.ok(items[0].querySelector(".goalrow-now"));
  assert.equal(items[0].querySelector(".goalrow-tfill").getAttribute("style"), "--l:10;--w:40");
  assert.ok(items[0].querySelector(".goalrow-tfill").classList.contains("is-from-left"));
  // A lift behind its start fills leftwards from the start.
  const back = items[1].querySelector(".goalrow-tfill");
  assert.ok(back.classList.contains("is-from-right"));
  assert.equal(back.getAttribute("style"), "--l:30;--w:20");
  // No track: an empty slot, no marks.
  assert.equal(items[2].querySelector(".goalrow-now"), null);
  assert.equal(host.querySelectorAll(".goallift-thread").length, 3);
  // Server text stays text.
  assert.equal(!!list.querySelector("b"), false);
});

test("a goal with no lifts, or an empty list, renders exactly as before", () => {
  const win = load();
  const before = landing(win, newRead()).innerHTML;
  const empty = newRead();
  empty.goals = empty.goals.map((g) => ({ ...g, lifts: [] }));
  const host = landing(win, empty);
  assert.equal(host.innerHTML, before);
  assert.equal(!!host.querySelector(".goallift-list"), false);
  assert.ok(host.querySelector(".goalrow-thread"));
});
