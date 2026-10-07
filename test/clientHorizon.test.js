// The Horizon timeline (horizon-model/-client/-controller/-screen; docs/V2-PLAN.md
// wave 5, "Horizon"): three lanes on one line of time — the race (a read over
// GET /api/race-build through the race view's own model, never a second engine), the
// goal line (the journey read and the road-ahead timeline) and labs and scans (past
// draws from GET /api/health-docs/draws, one row per draw, what is ahead in the
// checkup's own words). Every lab row routes into You's Health pages; no lane ever sits
// empty, and nothing reads as a score. The Week landing (the default view) has its own
// file, clientHorizonWeek.test.js. Synthetic fixtures only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule } from "./_dom.mjs";

const MODULES = [
  "html-utils",
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
  // The calendar bundle horizon reaches through train: the day's glance and rows, and the
  // shared time objects (milestone row, goal row, frame line, the week's model and shape).
  "day-detail-model",
  "day-detail-client",
  "milestone-row-model",
  "milestone-row-client",
  "goal-row-model",
  "goal-row-client",
  "frame-line-client",
  "week-model",
  "week-strip-client",
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
  return loadClientModule(MODULES, { globals: { localISO: () => TODAY, ...globals } });
}

const TODAY = "2026-09-16";
// Values built inside the client sandbox, compared as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const SCORE = /score|\/\s*100|\d\s*%|percent|grade|rating/i;

const WEEKS = [
  ["2026-09-07", 8, "build", 30, 12, false],
  ["2026-09-14", 7, "build", 32, 13, true],
  ["2026-09-21", 6, "down", 26, 13, false],
  ["2026-09-28", 5, "build", 35.5, 15, false],
  ["2026-10-05", 4, "build", 38, 16, false],
  ["2026-10-12", 3, "peak", 40, 18, false],
  ["2026-10-19", 2, "peak", 36, 16, false],
  ["2026-10-26", 1, "taper", 28, 12, false],
  ["2026-11-02", 0, "race", 30, 21.1, false],
].map(([week_start, weeks_to_race, kind, km, long_km, current]) => ({
  week_start,
  weeks_to_race,
  phase: "build",
  kind,
  km,
  long_km,
  quality_hint: "",
  strength_hint: "",
  focus: `The ${kind} week's focus.`,
  focus_short: `${kind} focus`,
  with_lifting: "",
  current,
}));

function build(overrides = {}) {
  return {
    available: true,
    as_of: TODAY,
    race: {
      event: "Riverside Half",
      date: "2026-11-08",
      distance_km: 21.1,
      days_to_race: 53,
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
      as_of: TODAY,
      trend: null,
      gap_sec: 271,
      fit: "stretch",
    },
    paces: null,
    this_week: { week_start: "2026-09-14", km: 32, long_km: 13, logged_km: 18, quality: null, why: "" },
    weeks: WEEKS,
    leg_map: [],
    strength: null,
    ride: null,
    review: { weeks: [], longest_recent_km: 13, volume_word: "steady" },
    why: "4:31 off the target",
    reason: null,
    ...overrides,
  };
}

function journey() {
  return {
    profile: {
      start_weight_lb: 205,
      start_date: "2026-06-01",
      goal_weight_lb: 180,
      goal_bodyfat_pct: null,
      goal_mode: "lose",
    },
    body_fat: null,
    active_phase: { kind: "cut", start_date: "2026-06-01", target_weight_lb: 180 },
    proposed_phases: [],
    transition_suggestion: null,
    milestones: [],
    recomposition: {
      stage: { kind: "mid_cut", label: "Mid-cut" },
      progress: {
        current_weight_lb: 195.4,
        goal_weight_lb: 180,
        remaining_lb: 15.4,
        robust_trend_lb_wk: -0.84,
        progress_fraction: 0.4,
      },
      scale: {
        state: "trend_clear",
        line: "The completed-day trend is about -0.84 lb per week across the robust energy window.",
      },
    },
    goal_consistency: null,
  };
}

function timeline() {
  return [
    { id: "past", kind: "retest", when: { date: "2026-09-01" }, label: "Bench re-test", detail: null, basis: "" },
    { id: "recheck:ldl", kind: "recheck", when: { date: "2026-10-01" }, label: "LDL recheck", detail: null, basis: "" },
    {
      id: "rescan:dexa",
      kind: "rescan",
      when: { window: { start: "2026-10-20", end: "2026-11-17" } },
      label: "DEXA re-scan window",
      detail: null,
      basis: "",
    },
    { id: "block", kind: "block", when: { date: "2026-10-05" }, label: "Block ends", detail: "Week 6 of 6", basis: "" },
    {
      id: "goal",
      kind: "goal",
      when: { date: "2026-11-15" },
      label: "Goal weight",
      detail: null,
      basis: "declared goal",
    },
    { id: "std", kind: "milestone", when: {}, label: "Bodyweight bench on the horizon", detail: null, basis: "" },
  ];
}

/** GET /api/health-docs/draws: one row per (kind, date), the uploads and their panels folded server-side. */
function docs() {
  const draw = (doc_id, kind, date, label, doc_ids = [doc_id]) => ({
    date,
    date_words: `words(${date})`,
    kind,
    label,
    doc_id,
    doc_ids,
  });
  return [
    draw(11, "bloodwork", "2026-08-02", "Bloodwork", [11, 17, 18]),
    // a kind that is no draw, and a draw dated after today, are left out
    draw(12, "visit_note", "2026-08-20", "Visit note"),
    draw(13, "dexa", "2026-07-10", "DEXA scan"),
    draw(14, "bloodwork", "2026-03-02", "Bloodwork"),
    draw(15, "imaging", "2026-05-01", "Imaging"),
    draw(16, "bloodwork", "2026-10-30", "Bloodwork"),
    // the same draw twice is still one row
    draw(17, "bloodwork", "2026-08-02", "Bloodwork"),
  ];
}

function checkup(overrides = {}) {
  return {
    lede: "The window for a LDL-C recheck is open.",
    due_now: [
      {
        signal_key: "lab:ldl",
        label: "LDL-C",
        kind: "lab",
        next_due: "2026-09-10",
        when_text: "window is open",
        why: "",
      },
    ],
    upcoming: [
      {
        signal_key: "dexa",
        label: "DEXA re-scan",
        kind: "dexa",
        next_due: "2026-10-20",
        when_text: "worth considering around late October",
        why: "",
      },
      {
        signal_key: "lab:a1c",
        label: "HbA1c",
        kind: "lab",
        next_due: "2026-12-01",
        when_text: "opens in about ten weeks",
        why: "",
      },
      {
        signal_key: "lab:tsh",
        label: "TSH",
        kind: "lab",
        next_due: "2027-01-01",
        when_text: "opens in about fifteen weeks",
        why: "",
      },
    ],
    follow_through: [],
    prep: { ordered_labs: [], bring: [], questions: [] },
    has_content: true,
    frame: "",
    ...overrides,
  };
}

// ---------- the race lane ----------

test("race lane: a glance at the build through the race view's own model — voice, terrain, this week, the fit", () => {
  const win = load();
  const lane = win.CairnHorizonModel.raceLane(build());
  assert.equal(lane.key, "race");
  assert.equal(lane.state, "set");
  assert.equal(lane.headline, "Riverside Half");
  assert.match(lane.when, /^7 weeks to race · Sunday, Nov 8$/);
  assert.equal(lane.fit, "stretch");
  assert.equal(lane.fit_word, "Stretch");
  // One serif line from the ladder's own count, and the race named under it.
  assert.equal(lane.voice, "Seven weeks of build, then the half.");
  assert.equal(lane.lede, "Riverside Half, Sunday, Nov 8.");
  // The ladder is the race page's depth, never repeated here.
  assert.equal(lane.ladder, undefined);
  // This week in one row: the stage, what the log holds of the week's volume, the focus.
  const glance = plain(lane.this_week);
  const picked = Object.fromEntries(
    ["stage_word", "done_km", "target_km", "done_text", "target_text", "frac", "banked", "long_text", "focus"].map(
      (k) => [k, glance[k]]
    )
  );
  // The race page's card words ride along (the kicker, without the weeks out the page's
  // head already says); the glance reads only these.
  assert.equal(glance.kicker, "This week · Build");
  assert.deepEqual(picked, {
    stage_word: "Build",
    done_km: 18,
    target_km: 32,
    done_text: "18",
    target_text: "32 km",
    frac: 0.563,
    banked: false,
    long_text: "Long run 13 km",
    focus: "The build week's focus.",
  });
  // The terrain carries the ladder, each week with its stage and long run.
  assert.equal(lane.terrain.weeks.length, WEEKS.length);
  assert.equal(lane.terrain.race_label, "Half · Nov 8");
  const now = lane.terrain.weeks.find((w) => w.current);
  assert.deepEqual(plain([now.stage, now.long_km, now.logged_km]), ["Build", 13, 18]);
  assert.deepEqual(plain(lane.links[0].target), { tab: "plan", section: "endurance" });
});

test("race lane: no race and nothing run is a calm 'No race on the calendar' with the way to set one", () => {
  const win = load();
  const lane = win.CairnHorizonModel.raceLane({ available: false, race: null, weeks: [], reason: "" });
  assert.equal(lane.state, "none");
  assert.equal(lane.title, "Race");
  assert.equal(lane.headline, "No race on the calendar");
  assert.match(lane.lede, /You → Profile/);
  assert.equal(lane.links.length, 1);
  assert.equal(lane.links[0].label, "Set a race");
  assert.deepEqual(plain(lane.links[0].target), { tab: "me", section: "profile" });
  // The server's own reason wins when it has one.
  const reasoned = win.CairnHorizonModel.raceLane({
    available: false,
    race: null,
    weeks: [],
    reason: "The race is past.",
  });
  assert.equal(reasoned.lede, "The race is past.");
});

test("race lane, a runner with no race: the running week and the last weeks, never a ladder or an estimate", () => {
  const win = load();
  const read = {
    available: false,
    running: "runs",
    race: null,
    weeks: [],
    leg_map: [],
    prediction: null,
    this_week: { week_start: "2026-09-14", km: 24, long_km: 10, logged_km: 8, quality: null, why: "" },
    review: {
      weeks: [
        { week_start: "2026-08-17", km: 18, runs: 3 },
        { week_start: "2026-08-24", km: 0, runs: 0 },
        { week_start: "2026-08-31", km: 22, runs: 3 },
        { week_start: "2026-09-07", km: 24, runs: 3 },
      ],
      longest_recent_km: 10,
      volume_word: "rising",
    },
    reason: "No dated race yet. Set one and the build lays out week by week.",
  };
  const lane = win.CairnHorizonModel.raceLane(read, "mi");
  assert.equal(lane.state, "none");
  assert.equal(lane.title, "Running");
  assert.equal(lane.this_week.stage_word, "");
  assert.equal(lane.this_week.done_text, "5");
  assert.equal(lane.this_week.target_text, "14.9 mi");
  assert.deepEqual(plain(lane.volume.map((w) => w.km_text)), ["11.2 mi", "—", "13.7 mi", "14.9 mi"]);
  assert.deepEqual(plain(lane.links.map((l) => l.label)), ["Set a race", "Your runs"]);
  assert.equal(lane.fit, null);
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.laneHtml(lane);
  assert.equal(host.querySelector(".horizon-lane-kicker").textContent, "Running");
  assert.equal(host.querySelector(".horizon-tw-num").textContent, "5 of 14.9 mi");
  assert.equal(host.querySelectorAll(".horizon-vol-week").length, 4);
  assert.equal(host.querySelector(".hz-terrain"), null);
  assert.equal(host.querySelector(".race-ladder"), null);
  assert.equal(host.querySelector(".race-estimate-word"), null);
  assert.doesNotMatch(host.textContent, /\bkm\b/);
});

test("race lane, a lifting-only athlete: no lane at all, and Horizon drops the race view", async () => {
  const win = load();
  const read = { available: false, running: "none", race: null, weeks: [], leg_map: [], reason: "" };
  const lane = win.CairnHorizonModel.raceLane(read);
  assert.equal(lane.state, "absent");
  assert.equal(win.CairnHorizon.laneHtml(lane), "");
  // The shell can leave the race view out entirely.
  const bare = createHost(win.document);
  bare.innerHTML = win.CairnHorizon.shellHtml("race", { race: false });
  assert.deepEqual(plain(bare.querySelectorAll('[role="tab"]').map((t) => t.textContent)), ["Week", "Season"]);
  assert.equal(bare.querySelector('[data-horizon-panel="race"]'), null);
  assert.equal(bare.querySelector("[data-horizon]").getAttribute("data-horizon-view"), "week");
  // Mounted, the first race read removes the view; Horizon is on the week.
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  const { load: loader } = reads({ extra: { "/race-build": read } });
  win.CairnHorizonController.mount(root, { today: TODAY, load: loader, navigate: () => {} });
  await root.querySelector('[data-horizon-seg="race"]').click();
  await flush();
  await flush();
  assert.equal(root.querySelector('[data-horizon-seg="race"]'), null);
  assert.equal(root.getAttribute("data-horizon-view"), "week");
  // The next open this session is framed without it from the start.
  assert.deepEqual(plain(win.CairnHorizonController.shellOptions()), { view: "week", race: false, raceLabel: "" });
});

test("race lane: a failed read says so in one calm line", () => {
  const win = load();
  const lane = win.CairnHorizonModel.raceLane(null);
  assert.equal(lane.state, "unread");
  assert.match(lane.headline, /couldn't be read just now/);
});

// ---------- the goal line ----------

test("goal line: the phase read, the bodyweight toward the goal, and the non-lab rows still ahead", () => {
  const win = load();
  const lane = win.CairnHorizonModel.goalLane(journey(), timeline(), TODAY);
  assert.equal(lane.state, "set");
  // One sentence at headline size, never the depth view's dot- or slash-joined fragments.
  assert.equal(lane.headline, "Mid-cut since Jun 1, toward 180 lb.");
  assert.equal(
    lane.lede,
    "195.4 lb now, 180 lb the goal. The completed-day trend is about -0.84 lb per week across the robust energy window."
  );
  const labels = lane.rows.map((row) => row.label);
  // Lab rows belong to the labs lane; a past re-test and an undated standard stay off.
  assert.deepEqual(plain(labels), ["Block ends", "Goal weight"]);
  assert.ok(lane.rows.every((row) => row.side === "ahead"));
  assert.deepEqual(plain(lane.links[0].target), { tab: "horizon", section: "goal" });
});

test("goal line: the scale speaks in the server's words; no journey and no road is 'No goal line yet'", () => {
  const win = load();
  const read = journey();
  // A trend number the renderer could turn into a pace word stays unspoken; the server's line is the voice.
  read.recomposition.progress.robust_trend_lb_wk = 0.4;
  read.recomposition.scale = { state: "settling", line: "The trend is still settling." };
  assert.equal(win.CairnHorizonModel.weightLine(read), "195.4 lb now, 180 lb the goal. The trend is still settling.");
  delete read.recomposition.scale;
  assert.equal(win.CairnHorizonModel.weightLine(read), "195.4 lb now, 180 lb the goal.");
  const none = win.CairnHorizonModel.goalLane(null, [], TODAY);
  assert.equal(none.state, "none");
  assert.equal(none.headline, "No goal line yet");
  assert.deepEqual(plain(none.links[0].target), { tab: "me", section: "profile" });
  const unread = win.CairnHorizonModel.goalLane(null, null, TODAY);
  assert.equal(unread.state, "unread");
});

// ---------- labs and scans ----------

test("labs lane: the newest three draws and scans behind today, oldest first, each opening its record", () => {
  const win = load();
  const lane = win.CairnHorizonLabsModel.labsLane(docs(), checkup(), timeline(), TODAY);
  const behind = lane.rows.filter((row) => row.side === "behind");
  // A visit note is not a draw; a draw dated after today is not behind it; one draw is one row.
  assert.deepEqual(plain(behind.map((row) => row.label)), ["Imaging", "DEXA scan", "Bloodwork"]);
  // The draw's own date words, never a date built here.
  assert.deepEqual(plain(behind.map((row) => row.when)), ["words(2026-05-01)", "words(2026-07-10)", "words(2026-08-02)"]);
  assert.deepEqual(plain(behind.map((row) => row.target)), [
    { tab: "stand", section: "records", id: "15" },
    { tab: "stand", section: "records", id: "13" },
    { tab: "stand", section: "records", id: "11" },
  ]);
});

test("labs lane: what is ahead is the checkup's own words, capped, with a DEXA row opening Body", () => {
  const win = load();
  const lane = win.CairnHorizonLabsModel.labsLane(docs(), checkup(), timeline(), TODAY);
  const ahead = lane.rows.filter((row) => row.side === "ahead");
  assert.deepEqual(plain(ahead.map((row) => [row.label, row.when])), [
    ["LDL-C", "window is open"],
    ["DEXA re-scan", "worth considering around late October"],
    ["HbA1c", "opens in about ten weeks"],
  ]);
  assert.deepEqual(plain(ahead[0].target), { tab: "stand", section: "checkup" });
  assert.deepEqual(plain(ahead[1].target), { tab: "stand", section: "body" });
  assert.equal(lane.lede, "The window for a LDL-C recheck is open.");
  // Behind rows lead, ahead rows follow: one line of time.
  const sides = lane.rows.map((row) => row.side);
  assert.equal(sides.lastIndexOf("behind") < sides.indexOf("ahead"), true);
});

test("labs lane: with no checkup read, the timeline's own rechecks stand in", () => {
  const win = load();
  const lane = win.CairnHorizonLabsModel.labsLane(docs(), null, timeline(), TODAY);
  const ahead = lane.rows.filter((row) => row.side === "ahead");
  assert.deepEqual(plain(ahead.map((row) => row.label)), ["LDL recheck", "DEXA re-scan window"]);
  assert.equal(ahead[1].target.section, "body");
  assert.equal(lane.lede, "");
});

test("labs lane: nothing yet is a way to add them; a failed read is one calm line", () => {
  const win = load();
  const none = win.CairnHorizonLabsModel.labsLane(
    [],
    checkup({ due_now: [], upcoming: [], has_content: false }),
    [],
    TODAY
  );
  assert.equal(none.state, "none");
  assert.equal(none.headline, "No labs or scans yet");
  assert.equal(none.links[0].label, "Add labs or scan");
  assert.deepEqual(plain(none.links[0].target), { tab: "stand", section: null });
  const unread = win.CairnHorizonLabsModel.labsLane(null, null, null, TODAY);
  assert.equal(unread.state, "unread");
});

// ---------- the view ----------

function lanes(win) {
  const m = win.CairnHorizonModel;
  return [
    m.raceLane(build()),
    m.goalLane(journey(), timeline(), TODAY),
    win.CairnHorizonLabsModel.labsLane(docs(), checkup(), timeline(), TODAY),
  ];
}

test("each lane paints its words, the race lane the ladder, and every row a real link", () => {
  const win = load();
  const hrefFor = (t) => `/app/${t.tab}${t.section ? `/${t.section}` : ""}${t.id ? `?id=${t.id}` : ""}`;
  const host = createHost(win.document);
  host.innerHTML = lanes(win)
    .map((lane) => win.CairnHorizon.laneHtml(lane, { hrefFor }))
    .join("");
  const cards = host.querySelectorAll(".horizon-lane-card");
  assert.equal(cards.length, 3);
  // The race build as a glance: its serif line, the terrain with its key, this week, the fit.
  assert.equal(cards[0].querySelector(".horizon-lane-title").textContent, "Seven weeks of build, then the half.");
  assert.ok(cards[0].querySelector(".hz-terrain"));
  assert.match(cards[0].querySelector(".horizon-chart-key").textContent, /Planned/);
  assert.equal(cards[0].querySelectorAll(".horizon-week").length, 0, "the ladder is the race page's");
  assert.equal(cards[0].querySelector(".horizon-tw-kicker").textContent, "This week · Build");
  assert.equal(cards[0].querySelector(".horizon-tw-num").textContent, "18 of 32 km");
  assert.equal(cards[0].querySelector("a.horizon-tw").getAttribute("href"), "/app/plan/endurance");
  assert.equal(cards[0].querySelector(".race-estimate-word").textContent, "Stretch");
  // The rail is milestone rows (the row Week's "Next up" draws), labs as diamonds.
  const labRows = cards[2].querySelectorAll(".msrow-link");
  assert.equal(labRows.length, 6);
  assert.equal(labRows[0].getAttribute("href"), "/app/stand/records?id=15");
  assert.equal(labRows[0].getAttribute("data-horizon-go"), "labs:row:0");
  assert.ok(cards[2].querySelector(".msrow").classList.contains("is-mark-diamond"));
  // The rail carries one Today mark between behind and ahead.
  assert.equal(cards[2].querySelectorAll(".msrow-now").length, 1);
  assert.doesNotMatch(host.textContent, SCORE);
  // Never the server's why (its gap-as-verdict clause).
  assert.doesNotMatch(host.textContent, /off the target/);
});

test("server text stays text", () => {
  const win = load();
  const read = build({ race: { ...build().race, event: '<img src=x onerror="boom()">' } });
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.laneHtml(win.CairnHorizonModel.raceLane(read));
  assert.equal(host.querySelector("img"), null);
  assert.match(host.querySelector(".horizon-lane-lede").textContent, /<img/);
});

// ---------- the controller ----------

function reads({ fail = [], extra = {} } = {}) {
  const table = {
    "/race-build": build(),
    "/journey": journey(),
    "/journey/timeline": timeline(),
    "/health-docs/draws": docs(),
    "/health/next-checkup": checkup(),
    ...extra,
  };
  const calls = [];
  const load = (path) => {
    calls.push(path);
    if (fail.includes(path)) return Promise.reject(new Error("offline"));
    return Promise.resolve(table[path] ?? null);
  };
  return { load, calls };
}

test("the timeline paints the three lane skeletons, then each lane as its reads land", async () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  assert.equal(root.querySelectorAll(".horizon-lane-card.is-loading").length, 3);
  const { load: loader, calls } = reads();
  win.CairnHorizonController.mount(root, { today: TODAY, load: loader, navigate: () => {} });
  await flush();
  await flush();
  assert.equal(root.querySelectorAll(".is-loading").length, 0);
  assert.match(root.querySelector('[data-horizon-lane="race"] .horizon-lane-title').textContent, /weeks of build/);
  assert.match(root.querySelector('[data-horizon-lane="goal"] .horizon-lane-title').textContent, /Mid-cut/);
  assert.equal(root.querySelector('[data-horizon-lane="labs"] .horizon-lane-title').textContent, "What's next");
  // The timeline is read once and shared by both lanes that need it.
  assert.equal(calls.filter((p) => p === "/journey/timeline").length, 1);
  assert.equal(root.querySelector(".horizon-lane-card").classList.contains("settle-in"), true);
});

test("one lane's failed read is that lane's calm line; the others still paint; reduced motion paints still", async () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  const { load: loader } = reads({ fail: ["/race-build"] });
  win.CairnHorizonController.mount(root, { today: TODAY, load: loader, navigate: () => {}, reducedMotion: () => true });
  await flush();
  await flush();
  const race = root.querySelector('[data-horizon-lane="race"] .horizon-lane-card');
  assert.ok(race.classList.contains("is-unread"));
  assert.match(race.textContent, /couldn't be read just now/);
  assert.match(root.querySelector('[data-horizon-lane="goal"]').textContent, /Mid-cut/);
  assert.equal(root.querySelectorAll(".settle-in").length, 0);
});

test("a lab row routes into Health through navigate; a modified click keeps the link", async () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  const went = [];
  const { load: loader } = reads();
  win.CairnHorizonController.mount(root, { today: TODAY, load: loader, navigate: (t) => went.push(t) });
  await flush();
  await flush();
  const rows = root.querySelectorAll('[data-horizon-lane="labs"] .msrow-link');
  await rows[0].click();
  assert.deepEqual(plain(went), [{ tab: "stand", section: "records", id: "15" }]);
  const goal = root.querySelector('[data-horizon-lane="goal"] .horizon-lane-link');
  await goal.click();
  assert.deepEqual(plain(went.at(-1)), { tab: "horizon", section: "goal" });
});

test("reads that land after the timeline was left write nothing", async () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const teardown = win.CairnHorizonController.mount(root, {
    today: TODAY,
    load: (path) => gate.then(() => (path === "/race-build" ? build() : null)),
    navigate: () => {},
  });
  teardown();
  release();
  await flush();
  await flush();
  assert.equal(root.querySelectorAll(".is-loading").length, 3);
});

// ---------- the season line ----------

function pace(points, goal = { weight_lb: 180, date: "2026-11-15" }) {
  return { points: points.map(([date, weight_lb]) => ({ date, weight_lb })), goal };
}

const WEIGH_INS = [
  ["2026-08-20", 190.2],
  ["2026-09-01", 188.6],
  ["2026-08-10", 191.4],
  ["2026-09-16", 186.9],
  ["2026-09-10", null],
];

function seasonTimeline() {
  return [
    ...timeline(),
    {
      id: "phase:projection",
      kind: "phase",
      when: { window: { start: "2026-11-01", end: "2026-11-29" } },
      label: "Likely",
    },
    { id: "goal:endurance-race", kind: "race", when: { date: "2026-11-08" }, label: "Riverside Half" },
  ];
}

test("season: weigh-ins sorted and cleaned, the goal, the window, race day, and draws and rechecks as marks", () => {
  const win = load();
  const season = plain(win.CairnHorizonLabsModel.season(pace(WEIGH_INS), seasonTimeline(), docs(), checkup(), TODAY));
  assert.deepEqual(
    season.points.map((p) => p.date),
    ["2026-08-10", "2026-08-20", "2026-09-01", "2026-09-16"]
  );
  assert.equal(season.goal_lb, 180);
  assert.equal(season.goal_date, "2026-11-15");
  assert.deepEqual(season.fan, { start: "2026-11-01", end: "2026-11-29" });
  assert.deepEqual(season.race, { date: "2026-11-08", label: "Riverside Half" });
  // Only draws inside the weigh-in window and not in the future sit behind.
  const behind = season.marks.filter((m) => m.side === "behind");
  assert.equal(behind.length, 0, "the draws on the fixture all predate the first weigh-in or are ahead");
  // A due-now recheck whose date has passed stands on today's line; upcoming ones at their own date.
  const ahead = season.marks.filter((m) => m.side === "ahead");
  assert.deepEqual(
    ahead.map((m) => [m.date, m.label]),
    [
      [TODAY, "LDL-C"],
      ["2026-10-20", "DEXA re-scan"],
      ["2026-12-01", "HbA1c"],
      ["2027-01-01", "TSH"],
    ]
  );
});

test("season: a draw inside the window sits behind; fewer than two weigh-ins is no line", () => {
  const win = load();
  const season = win.CairnHorizonLabsModel.season(
    pace(WEIGH_INS),
    timeline(),
    [
      { date: "2026-08-25", date_words: "Aug 25", kind: "bloodwork", label: "Bloodwork", doc_id: 1, doc_ids: [1, 3] },
      { date: "2026-08-26", date_words: "Aug 26", kind: "visit_note", label: "Visit note", doc_id: 2, doc_ids: [2] },
      // the same draw again is still one mark
      { date: "2026-08-25", date_words: "Aug 25", kind: "bloodwork", label: "Bloodwork", doc_id: 3, doc_ids: [3] },
    ],
    null,
    TODAY
  );
  assert.deepEqual(plain(season.marks), [
    { date: "2026-08-25", label: "Bloodwork", kind: "bloodwork", side: "behind" },
  ]);
  assert.equal(season.fan, null);
  assert.equal(season.race, null);
  assert.equal(win.CairnHorizonLabsModel.season(pace([["2026-09-16", 186]]), [], [], null, TODAY), null);
  assert.equal(win.CairnHorizonLabsModel.season(null, [], [], null, TODAY), null);
});

function seasonOf(_win, points, overrides = {}) {
  return {
    points: points.map(([date, lb]) => ({ date, lb })),
    goal_lb: 180,
    goal_date: "2026-11-15",
    fan: { start: "2026-11-01", end: "2026-11-29" },
    race: null,
    marks: [],
    today: TODAY,
    ...overrides,
  };
}

test("season chart: today's weigh-in says 'now' and the fan leaves it", () => {
  const win = load();
  const svg = win.CairnHorizonChart.seasonSvg(
    seasonOf(win, [
      ["2026-08-10", 191],
      ["2026-09-16", 187],
    ])
  );
  assert.match(svg, /187 now</);
  assert.match(svg, /class="hz-fan"/);
  assert.match(svg, /class="hz-fan-line"/);
  assert.doesNotMatch(svg, SCORE);
});

test("season chart: a stale weigh-in wears its own date, never 'now', and the fan does not leave it", () => {
  const win = load();
  const svg = win.CairnHorizonChart.seasonSvg(
    seasonOf(win, [
      ["2026-08-10", 191],
      ["2026-08-26", 180.3],
    ])
  );
  assert.doesNotMatch(svg, />[^<]*\bnow\b/);
  assert.match(svg, /180\.3 · AUG 26/);
  assert.match(svg, /hz-today is-past/);
  // The window still lies on the goal line; no triangle from the old weight.
  assert.match(svg, /hz-fan is-window/);
  assert.doesNotMatch(svg, /class="hz-fan-line"/);
  assert.match(svg, /aria-label="[^"]*on AUG 26/);
  // Within the anchor window the fan still leaves the latest weigh-in.
  const recent = win.CairnHorizonChart.seasonSvg(
    seasonOf(win, [
      ["2026-08-10", 191],
      ["2026-09-14", 186],
    ])
  );
  assert.match(recent, /class="hz-fan-line"/);
  assert.match(recent, /186 · SEP 14/);
});

test("season chart: a recheck far out is pinned at the edge, never squeezing the weight line", () => {
  const win = load();
  const xs = (svg) =>
    [...svg.matchAll(/class="hz-weight" d="([^"]+)"/g)][0][1].match(/[ML]([\d.]+)/g).map((t) => Number(t.slice(1)));
  const base = seasonOf(
    win,
    [
      ["2026-08-10", 191],
      ["2026-09-16", 187],
    ],
    { goal_date: null, fan: null }
  );
  const plainSvg = win.CairnHorizonChart.seasonSvg(base);
  const farSvg = win.CairnHorizonChart.seasonSvg({
    ...base,
    marks: [{ date: "2027-09-01", label: "TSH", kind: "lab", side: "ahead" }],
  });
  assert.deepEqual(xs(farSvg), xs(plainSvg));
  assert.match(farSvg, /hz-mark is-ahead is-kind-lab is-beyond/);
  // A mark within reach widens the span instead.
  const nearSvg = win.CairnHorizonChart.seasonSvg({
    ...base,
    marks: [{ date: "2026-10-01", label: "LDL", kind: "lab", side: "ahead" }],
  });
  assert.doesNotMatch(nearSvg, /is-beyond/);
  assert.ok(xs(nearSvg).at(-1) < xs(plainSvg).at(-1));
});

test("season key names only what was drawn", () => {
  const win = load();
  const html = (overrides) =>
    win.CairnHorizon.seasonHtml(
      seasonOf(
        win,
        [
          ["2026-08-10", 191],
          ["2026-09-16", 187],
        ],
        overrides
      )
    );
  const noGoal = html({ goal_lb: null });
  assert.doesNotMatch(noGoal, /Likely window/);
  assert.doesNotMatch(noGoal, /is-goal/);
  const full = html({
    race: { date: "2026-11-08", label: "Riverside Half" },
    marks: [
      { date: "2026-10-20", label: "DEXA", kind: "dexa", side: "ahead" },
      { date: "2026-10-01", label: "LDL", kind: "lab", side: "ahead" },
    ],
  });
  for (const word of ["Weight", "Goal", "Likely window", "Labs", "Body scans", "Race day"])
    assert.match(full, new RegExp(`>${word}<`));
  assert.match(full, /hz-mark is-ahead is-kind-dexa is-body/);
  const scansOnly = html({ marks: [{ date: "2026-10-20", label: "DEXA", kind: "dexa", side: "ahead" }] });
  assert.doesNotMatch(scansOnly, />Labs</);
  assert.match(scansOnly, />Body scans</);
  assert.equal(win.CairnHorizon.seasonHtml(null), "");
});

test("terrain chart: a mid-week race ends the ground the day after it", () => {
  const win = load();
  const weeks = [
    { week_start: "2026-09-14", km: 20, current: true },
    { week_start: "2026-09-21", km: 24, current: false },
    { week_start: "2026-09-28", km: 12, current: false },
  ];
  const svg = win.CairnHorizonChart.terrainSvg({ weeks, race_date: "2026-09-30", race_label: "10K", as_of: TODAY });
  // Race day stands a day short of the plot's right edge, not a sixth of the width short.
  const race = Number(svg.match(/class="hz-race" x1="([\d.]+)"/)[1]);
  assert.ok(race > 300, `race line at ${race}`);
  // Race week's column stands inside its short slot, never past race day.
  const layout = win.CairnHorizonTerrain.terrainLayout({
    weeks,
    race_date: "2026-09-30",
    race_label: "10K",
    as_of: TODAY,
  });
  const last = layout.columns[layout.columns.length - 1];
  assert.ok(last.x + last.width <= race, `race week column ends at ${last.x + last.width}`);
  assert.ok(last.slot_w < layout.columns[0].slot_w, "race week's slot is its days to race day");
  assert.equal(
    win.CairnHorizonChart.terrainSvg({ weeks: weeks.slice(0, 1), race_date: "", race_label: "", as_of: TODAY }),
    ""
  );
});

// ---------- the view switch ----------

test("the views are tabs over their own panels; Week opens first", () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const tabs = host.querySelectorAll('[role="tab"]');
  assert.deepEqual(plain(Array.from(tabs).map((tab) => tab.textContent)), ["Week", "To the race", "Season"]);
  for (const tab of tabs) {
    const panel = host.querySelector(`#${tab.getAttribute("aria-controls")}`);
    assert.ok(panel, "each tab controls a panel");
    assert.equal(panel.getAttribute("role"), "tabpanel");
    assert.equal(panel.getAttribute("aria-labelledby"), tab.getAttribute("id"));
  }
  assert.equal(host.querySelector('[data-horizon-panel="race"]').hidden, true);
  assert.equal(host.querySelector('[data-horizon-panel="season"]').hidden, true);
  assert.equal(host.querySelector('[data-horizon-panel="week"]').hidden, false);
  assert.ok(host.querySelector('[data-horizon-panel="season"] [data-horizon-lane="goal"]'));
  assert.ok(host.querySelector('[data-horizon-panel="season"] [data-horizon-lane="labs"]'));
});

test("with no race set Horizon still opens on Week, and a picked view is never remembered", async () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  const noRace = { "/race-build": { available: false, race: null, weeks: [], reason: "" } };
  const { load: loader } = reads({ extra: noRace });
  const teardown = win.CairnHorizonController.mount(root, { today: TODAY, load: loader, navigate: () => {} });
  await flush();
  await flush();
  assert.equal(root.getAttribute("data-horizon-view"), "week");
  assert.equal(root.querySelector('[data-horizon-seg="week"]').getAttribute("aria-selected"), "true");
  // The athlete picks the race view; the next open is Week again.
  await root.querySelector('[data-horizon-seg="race"]').click();
  assert.equal(root.getAttribute("data-horizon-view"), "race");
  teardown();
  assert.equal(win.CairnHorizonController.shellOptions().view, "week");
  host.innerHTML = win.CairnHorizon.shellHtml(win.CairnHorizonController.shellOptions().view);
  const again = host.querySelector("[data-horizon]");
  win.CairnHorizonController.mount(again, { today: TODAY, load: reads({ extra: noRace }).load, navigate: () => {} });
  await flush();
  await flush();
  assert.equal(again.getAttribute("data-horizon-view"), "week");
  assert.equal(again.querySelector('[data-horizon-panel="race"]').hidden, true);
  assert.equal("pickView" in win.CairnHorizonController, false, "no session memory to pick a view into");
});

test("the goal line's held slot takes the season line, or goes when there is none", async () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  const { load: loader } = reads({ extra: { "/nutrition/goal-pace?days=180": pace(WEIGH_INS) } });
  win.CairnHorizonController.mount(root, { today: TODAY, load: loader, navigate: () => {} });
  await flush();
  await flush();
  const slot = root.querySelector("[data-horizon-season]");
  assert.ok(slot);
  assert.equal(slot.classList.contains("is-pending"), false);
  assert.equal(slot.getAttribute("aria-busy"), null);
  assert.ok(slot.querySelector("svg.hz-season"));

  const bare = load();
  const host2 = createHost(bare.document);
  host2.innerHTML = bare.CairnHorizon.shellHtml();
  const root2 = host2.querySelector("[data-horizon]");
  bare.CairnHorizonController.mount(root2, { today: TODAY, load: reads().load, navigate: () => {} });
  await flush();
  await flush();
  assert.equal(root2.querySelector("[data-horizon-season]"), null);
  assert.match(root2.querySelector('[data-horizon-lane="goal"]').textContent, /Mid-cut/);
});

// ---------- the screen ----------

// The /today-path read's progress board, as Horizon's goal line shows it in full.
const GOALS_PATH = {
  as_of: TODAY,
  board: [
    {
      key: "strength",
      id: "strength:deadlift",
      label: "Deadlift, est. 1RM",
      start_text: "245 lb",
      now_text: "285 lb",
      goal_text: "340 lb",
      progress: 0.42,
      reached: false,
      note: "+4.2 lb/wk",
      direction: null,
      movement: 0.2,
    },
    {
      key: "marker",
      id: "marker:apob",
      label: "ApoB",
      start_text: null,
      now_text: "134 mg/dL",
      goal_text: null,
      progress: null,
      reached: false,
      note: "Falling · Recheck opens Nov 16",
      direction: "toward",
      movement: 0,
    },
  ],
};

test("Horizon's landing is the timeline; its goal section is the journey story with a back link to the timeline", async () => {
  const document = (await import("./_dom.mjs")).createDocument();
  const view = createHost(document);
  const headerTitle = { textContent: "" };
  const state = { horizonSeg: null };
  const tabs = [];
  const win = loadClientModule([...MODULES, "horizon-screen"], {
    document,
    globals: {
      view,
      headerTitle,
      state,
      pollToken: 0,
      stagger: (i) => `--i:${i}`,
      loadingState: () => `<p class="loading">Reading…</p>`,
      localISO: () => TODAY,
      reducedMotion: () => true,
      homeBackHtml: (home, label) =>
        `<button class="home-back" type="button" data-home-back="${home}">‹ ${label}</button>`,
      activateTab: (name) => tabs.push(name),
      applyRouteState: (route) => {
        state.routed = route;
        return route.tab;
      },
      routeApi: () => null,
      api: (path) => reads({ extra: { [`/today-path?date=${TODAY}`]: GOALS_PATH } }).load(path),
    },
  });
  win.renderHorizon();
  assert.equal(headerTitle.textContent, "Horizon");
  assert.ok(view.querySelector("[data-horizon]"));

  state.horizonSeg = "goal";
  await win.renderHorizon();
  assert.equal(headerTitle.textContent, "Goal line");
  // All goals leads the goal line: every thread Today's Path card links here for.
  const goals = view.querySelector("#horizonGoalBody .horizon-goals");
  assert.ok(goals, "All goals is on Horizon's goal line");
  assert.equal(view.querySelector("#horizonGoalBody").firstElementChild, goals);
  assert.deepEqual(
    goals.querySelectorAll(".thd-row").map((row) => row.getAttribute("data-thd-row")),
    ["strength:deadlift", "marker:apob"]
  );
  assert.match(goals.textContent, /Deadlift, est\. 1RM245 lb → 285 lb · goal 340 lb/);
  assert.match(goals.textContent, /\+4\.2 lb\/wk/);
  assert.match(goals.textContent, /ApoB134 mg\/dL/);
  assert.ok(view.querySelector(".jprog-card"));
  assert.ok(view.querySelector(".ftl-card"));
  await view.querySelector("[data-home-back]").click();
  assert.equal(state.horizonSeg, null, "back is the timeline, never the goal section again");
  assert.deepEqual(tabs, ["horizon"]);

  // A lab row goes through the app's router, so Health's lazy bundle loads on arrival.
  win.horizonNavigate({ tab: "stand", section: "records", id: "11" });
  assert.equal(state.routed.tab, "stand");
  assert.equal(state.routed.section, "records");
  assert.equal(state.routed.id, "11");
  assert.deepEqual(tabs, ["horizon", "stand"]);
});

// ---------- wave 6B: the race build as the Horizon phone draws it ----------

test("race voice: build weeks, then the taper, then race week, in the ladder's own count", () => {
  const win = load();
  const m = win.CairnRaceViewModel;
  const ladder = (kind, out) => ({ rows: [{ kind, weeks_to_race: out, current: true }], max_km: 0, taper_text: "" });
  const race = (km, days = 20) => ({ ...build().race, distance_km: km, days_to_race: days });
  assert.equal(m.buildVoice(ladder("build", 1), race(21.1)), "One week of build, then the half.");
  assert.equal(m.buildVoice(ladder("down", 14), race(42.2)), "14 weeks of build, then the marathon.");
  assert.equal(m.buildVoice(ladder("taper", 1), race(10)), "The taper, then the 10K.");
  assert.equal(m.buildVoice(ladder("race", 0), race(15)), "Race week, then race day on Sunday.");
  assert.equal(m.buildVoice(ladder("race", 0), race(21.1, 0)), "Race day is today.");
});

test("terrain: the closed weeks the log holds lead the ridge, quieter; the stages ride under it; labels are selective", () => {
  const win = load();
  const review = {
    weeks: [
      { week_start: "2026-08-17", km: 0, runs: 0 },
      { week_start: "2026-08-24", km: 22, runs: 3 },
      { week_start: "2026-08-31", km: 26.4, runs: 3 },
      { week_start: "2026-09-07", km: 28, runs: 3 },
    ],
    longest_recent_km: 12,
    volume_word: "rising",
  };
  const lane = win.CairnHorizonModel.raceLane(build({ weeks: WEEKS.slice(1), review }));
  const logged = lane.terrain.weeks.filter((w) => w.logged);
  // From the first week with running in it; the empty week before is not ground.
  assert.deepEqual(plain(logged.map((w) => [w.week_start, w.km])), [
    ["2026-08-24", 22],
    ["2026-08-31", 26.4],
    ["2026-09-07", 28],
  ]);
  const svg = win.CairnHorizonChart.terrainSvg(lane.terrain);
  // One column per calendar week: the log's in ink, the ladder's in the plan tone.
  assert.equal((svg.match(/class="hz-col is-logged"/g) || []).length, 3);
  assert.equal((svg.match(/class="hz-cap"/g) || []).length, WEEKS.slice(1).length);
  // No curve between weeks: a weekly figure is a column, never a spline.
  assert.doesNotMatch(svg, /hz-terrain-line|hz-terrain-fill|hz-contour| C[\d.]+,/);
  // Selective labels: this week in the race page's words, and the peak — never a number on every week.
  const nums = [...svg.matchAll(/class="hz-num[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(nums, ["18 of 32 km", "peak 40"]);
  // The stage ribbon: one band per run of weeks, the current one deeper, named where it fits.
  assert.match(svg, /class="hz-stage is-current"/);
  assert.match(svg, /class="hz-stage is-logged"/);
  assert.match(svg, />BUILD</);
  // A long-run tick for every ladder week that has one, and hit targets that say the week.
  // (race week has none: race day is the long run)
  assert.equal((svg.match(/class="hz-long"/g) || []).length, WEEKS.slice(1).filter((w) => w.kind !== "race").length);
  assert.match(svg, /<title>SEP 14 · Build · 18 of 32 km · long run 13 km<\/title>/);
  // This week's run so far is the filled part of its planned column.
  assert.match(svg, /class="hz-col is-logged is-done"/);
  // Recessive grid: solid hairlines, never dashed.
  assert.doesNotMatch(svg, /stroke-dasharray/);
  assert.match(svg, /aria-label="Logged: AUG 24 22 km/);
  // The key names only what was drawn.
  const key = win.CairnHorizonChart.terrainKeyHtml(lane.terrain);
  for (const word of ["Planned", "Logged", "Long run"]) assert.match(key, new RegExp(`>${word}<`));
  const bare = win.CairnHorizonChart.terrainKeyHtml({
    ...lane.terrain,
    weeks: lane.terrain.weeks.filter((w) => !w.logged).map((w) => ({ ...w, long_km: null, logged_km: null })),
  });
  assert.doesNotMatch(bare, /Long run|Logged/);
  assert.match(bare, />Planned</);
  // The wash follows a picked week; "" washes none.
  const picked = win.CairnHorizonChart.terrainSvg(lane.terrain, { selected: "2026-10-12" });
  const none = win.CairnHorizonChart.terrainSvg(lane.terrain, { selected: "" });
  assert.notEqual(picked.match(/class="hz-wash" x="([\d.]+)"/)[1], svg.match(/class="hz-wash" x="([\d.]+)"/)[1]);
  assert.doesNotMatch(none, /hz-wash/);
});

test("terrain: with the log's weeks ahead of a full ladder, every stage band still says its stage", () => {
  const win = load();
  const review = {
    weeks: ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"].map((week_start, i) => ({
      week_start,
      km: 20 + i,
      runs: 3,
    })),
    longest_recent_km: 12,
    volume_word: "rising",
  };
  const lane = win.CairnHorizonModel.raceLane(build({ weeks: WEEKS, review }));
  assert.equal(lane.terrain.weeks.length, 13, "four logged weeks and the nine of the ladder");
  const svg = win.CairnHorizonChart.terrainSvg(lane.terrain);
  const bands = (svg.match(/<rect class="hz-stage[ "]/g) || []).length;
  const words = [...svg.matchAll(/class="hz-stage-word[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.equal(words.length, bands, `a word on every band: ${words.join(" ")}`);
  // One-week bands are too narrow for the whole word: the taper and race week still read.
  assert.ok(words.includes("TAPER") || words.includes("TPR"), words.join(" "));
  assert.ok(words.includes("RACE") || words.includes("R"), words.join(" "));
  assert.ok(words.includes("PEAK") || words.includes("PK"), words.join(" "));
});

test("terrain layout: one column per calendar week, every top a real week's figure, this week filled in", () => {
  const win = load();
  const review = {
    weeks: [
      { week_start: "2026-08-24", km: 22, runs: 3 },
      { week_start: "2026-08-31", km: 26.4, runs: 3 },
      { week_start: "2026-09-07", km: 28, runs: 3 },
    ],
    longest_recent_km: 12,
    volume_word: "rising",
  };
  const lane = win.CairnHorizonModel.raceLane(build({ weeks: WEEKS.slice(1), review }));
  const layout = plain(win.CairnHorizonTerrain.terrainLayout(lane.terrain));
  const weeks = lane.terrain.weeks;
  const data = weeks.map((w) => w.km);
  const [lo, hi] = [Math.min(...data), Math.max(...data)];
  const Y = (v) => layout.base - (v / layout.top) * (layout.base - layout.ceil);
  // One column per week, in its own week's slot; the slots tile the time axis with no gap.
  assert.equal(layout.columns.length, weeks.length);
  layout.columns.forEach((c, i) => {
    assert.equal(c.week_start, weeks[i].week_start);
    assert.ok(c.x >= c.slot_x && c.x + c.width <= c.slot_x + c.slot_w + 1e-9, `${c.week_start} sits in its slot`);
    assert.ok(c.width <= 22, "a thin mark");
    if (i) {
      const prev = layout.columns[i - 1];
      assert.ok(Math.abs(prev.slot_x + prev.slot_w - c.slot_x) < 1e-6, "slots are contiguous calendar weeks");
      assert.ok(c.x > prev.x + prev.width, "air between columns");
    }
  });
  // Every column's top IS its week's figure: nothing above the largest week, nothing
  // below the smallest, and no ramp up from zero before the first week.
  for (const c of layout.columns) {
    assert.ok(c.value >= lo && c.value <= hi, `${c.week_start} ${c.value} within [${lo}, ${hi}]`);
    assert.ok(Math.abs(c.top - Y(c.value)) < 1e-6);
    assert.ok(c.top >= Y(hi) - 1e-6 && c.top <= layout.base);
  }
  assert.equal(layout.columns[0].value, 22, "the first column stands at the first logged week");
  assert.equal(layout.max, hi);
  // The drawn marks carry no y above the tallest week and none below the ground.
  const svg = win.CairnHorizonTerrain.terrainSvg(lane.terrain);
  for (const [, d] of svg.matchAll(/class="hz-(?:col|cap)[^"]*" d="([^"]+)"/g)) {
    // Every y the path visits: its move/arc end points and its vertical runs.
    const ys = [
      ...[...d.matchAll(/(?:M|0 0 1 )(-?[\d.]+),(-?[\d.]+)/g)].map((m) => Number(m[2])),
      ...[...d.matchAll(/V(-?[\d.]+)/g)].map((m) => Number(m[1])),
    ];
    assert.ok(ys.length >= 2);
    for (const y of ys) assert.ok(y >= Y(hi) - 0.06 && y <= layout.base + 0.06, `y ${y} in [${Y(hi)}, ${layout.base}]`);
  }
  // This week: the planned column, its logged part filled from the ground in proportion.
  const now = layout.columns.find((c) => c.current);
  assert.equal(now.value, 32);
  assert.equal(now.done, 18);
  assert.ok(now.done_top > now.top && now.done_top < layout.base);
  assert.ok(Math.abs((layout.base - now.done_top) / (layout.base - now.top) - 18 / 32) < 1e-9);
  assert.deepEqual(
    layout.labels.map((l) => [l.kind, l.text]),
    [
      ["week", "18 of 32 km"],
      ["peak", "peak 40"],
    ]
  );
  for (const l of layout.labels) assert.ok(l.x >= layout.L && l.x <= layout.R);
  // Long-run ticks sit on their own week's column, at the long run.
  for (const c of layout.columns.filter((col) => col.long != null)) {
    assert.ok(Math.abs(c.long_y - Y(c.long)) < 1e-6 && c.long <= c.value);
  }
  assert.ok(layout.columns.filter((c) => c.logged).every((c) => c.long == null && c.done == null));

  // In miles the same columns, restated; the words match the race page's THIS WEEK.
  const mi = plain(win.CairnHorizonTerrain.terrainLayout({ ...lane.terrain, units: "mi" }));
  assert.equal(mi.labels[0].text, "11.2 of 19.9 mi");
  const m = win.CairnRaceViewModel;
  assert.equal(mi.labels[0].text, `${m.distNum(18, "mi")} of ${m.kmText(32, "mi")}`);
  const miNow = mi.columns.find((c) => c.current);
  const frac = (c, l) => (l.base - c.done_top) / (l.base - c.top);
  assert.ok(Math.abs(frac(miNow, mi) - frac(now, layout)) < 1e-9, "units restate, never reshape");
});

test("terrain layout: nothing run yet says the week planned; a week run past its plan stands taller", () => {
  const win = load();
  const weeks = [
    { week_start: "2026-09-14", km: 30, current: true, stage: "Build", long_km: 12, logged_km: 0 },
    { week_start: "2026-09-21", km: 34, current: false, stage: "Peak", long_km: 14 },
    { week_start: "2026-09-28", km: 21.1, current: false, stage: "Race" },
  ];
  const terrain = { weeks, race_date: "2026-10-04", race_label: "Half · Oct 4", as_of: TODAY };
  const fresh = plain(win.CairnHorizonTerrain.terrainLayout(terrain));
  assert.equal(fresh.labels[0].text, "30 km planned");
  assert.equal(fresh.columns[0].done, null);
  assert.doesNotMatch(win.CairnHorizonTerrain.terrainSvg(terrain), /is-done/);
  const over = plain(
    win.CairnHorizonTerrain.terrainLayout({ ...terrain, weeks: [{ ...weeks[0], logged_km: 36 }, ...weeks.slice(1)] })
  );
  const c = over.columns[0];
  assert.equal(over.max, 36, "the axis holds the log's figure");
  assert.ok(c.done_top < c.top, "the log outranks the plan");
  assert.equal(over.labels[0].text, "36 of 30 km");
  // The peak word yields or steps up rather than sitting on this week's words.
  const [week, peak] = over.labels;
  if (peak) assert.ok(Math.abs(week.y - peak.y) >= 12 || Math.abs(week.x - peak.x) > 40);
});

// ---------- run units (settings.run_units) ----------

test("run units: miles restate every distance on the race lane, the chart and the week; bars still scale on km", () => {
  const win = load();
  const read = build({
    prediction: {
      ...build().prediction,
      basis_detail: "your 16 km run on Sep 10 (5:10 /km), extended to race distance",
    },
  });
  const km = win.CairnHorizonModel.raceLane(read);
  const mi = win.CairnHorizonModel.raceLane(read, "mi");
  assert.equal(mi.this_week.target_text, "19.9 mi");
  assert.equal(mi.this_week.done_km, 18); // the engine's kilometres, untouched
  assert.equal(mi.this_week.frac, km.this_week.frac);
  assert.equal(mi.units, "mi");
  assert.equal(mi.terrain.units, "mi");
  assert.equal(km.units, "km");
  // The ladder rows the race page draws restate the same way; bars still scale on km.
  const ladder = win.CairnRaceViewModel.ladderModel(read, "mi");
  const now = ladder.rows.findIndex((row) => row.current);
  assert.equal(ladder.rows[now].km, 32);
  // The live week reads what the log holds of its plan, both in miles.
  assert.equal(ladder.rows[now].km_text, "11.2 of 19.9 mi");
  assert.equal(ladder.rows[now].long_text, "long 8.1 mi");
  assert.equal(ladder.rows[now].frac, win.CairnRaceViewModel.ladderModel(read).rows[now].frac);
  assert.equal(win.CairnRaceViewModel.kmText(21.0975, "mi"), "13.1 mi");
  assert.equal(win.CairnRaceViewModel.kmText(21.0975), "21.1 km");
  assert.equal(
    win.CairnRaceViewModel.runWords("your 16 km run on Sep 10 (5:10 /km), extended", "mi"),
    "your 9.9 mi run on Sep 10 (8:19 /mi), extended"
  );
  assert.equal(win.CairnRaceViewModel.runWords("your 16 km run (5:10 /km)", "km"), "your 16 km run (5:10 /km)");

  const svg = win.CairnHorizonChart.terrainSvg(mi.terrain);
  assert.match(svg, /MI PER WEEK/);
  assert.match(svg, /Miles per week to race day/);
  assert.doesNotMatch(svg, / km[,"]/);

  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.laneHtml(mi);
  // Units are Settings' alone: no per-surface km / mi switch on the lane.
  assert.equal(host.querySelector("[data-horizon-units]"), null);
  assert.doesNotMatch(host.querySelector(".horizon-tw").textContent, /\bkm\b/);
  assert.doesNotMatch(host.querySelector(".horizon-chart-key").textContent, /\bkm\b/);
  // (The Week landing's words arrive in the athlete's units from GET /api/week:
  // clientHorizonWeek.test.js renders it in miles + pounds and in km + kg.)
});

test("run units: the controller reads settings; there is no per-surface km/mi switch", async () => {
  const win = load();
  const host = createHost(win.document);
  host.innerHTML = win.CairnHorizon.shellHtml();
  const root = host.querySelector("[data-horizon]");
  const { load: loader } = reads({ extra: { "/settings": { settings: { run_units: "mi" } } } });
  const saved = [];
  win.CairnHorizonController.mount(root, {
    today: TODAY,
    load: loader,
    navigate: () => {},
  });
  await flush();
  await flush();
  const km = () => root.querySelector('[data-horizon-lane="race"] .horizon-tw-num').textContent;
  assert.match(km(), / mi$/);
  // No switch to flip: the lane follows settings.run_units and nothing else.
  assert.equal(root.querySelector("[data-horizon-units]"), null);
  assert.deepEqual(saved, []);
});
