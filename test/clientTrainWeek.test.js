// Train's landing, This week (train-week-client.ts), and Today's evening "Tomorrow: …"
// line (train-week-tomorrow-client.ts): the next session opened up, the week a row a day
// through the ONE shared row component (CairnDayGlanceView.rowHtml, Program's week ahead
// draws the same), next week behind a fold; every row and the card open their day
// through `data-open-day`, and every caller string is escaped. Nothing new is read: the
// week Today's strip reads, Program's look-ahead, and the next day's detail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";

const TODAY = "2026-10-21"; // a Wednesday

const strengthLine = {
  date: TODAY,
  day_number: 3,
  title: "Upper back & arms",
  focus: null,
  role: "strength",
  state: "not_started",
  suggestion: null,
  caveat: "Keep the <rows> smooth.",
  run_in: null,
  reshaped: false,
  original: [],
  text: "Upper back & arms · not started",
};

const lift = (day_number, name) => ({ day_number, name, focus: null, purpose: null, day_type: "training", role: "strength", out_of_order: false });
const run = (kind, label, km, status = "open", date = null) => ({
  kind,
  label,
  status,
  suggested_date: date,
  completion_date: status === "completed" ? date : null,
  km,
});

function planWeek(overrides = {}) {
  return {
    as_of: TODAY,
    week_start: "2026-10-19",
    summary: null,
    run_units: "km",
    strength_line: strengthLine,
    layout: { clean: true, suggestion: null },
    schedule: { lift_days: [], lift_days_source: "stated", run_days: [] },
    progress: { lift_days_done: 2, lift_days_planned: 5, runs_done: 1, run_km: 6.2, longest_run_km: 6.2, runs_open: [], prs: 0, line: "Two of five <lifting> days are in." },
    days: [
      { date: "2026-10-19", weekday: "Mon", dow: 1, status: "done", plan_day: lift(1, "Push A"), session: { id: 1, title: "Push A", date: "2026-10-19", finished: true }, run: null, hard: false },
      { date: "2026-10-20", weekday: "Tue", dow: 2, status: "done", plan_day: lift(2, "Lower"), session: { id: 2, title: "Lower", date: "2026-10-20", finished: true }, run: run("easy", "Easy run", 6.2, "completed", "2026-10-20"), hard: false },
      { date: TODAY, weekday: "Wed", dow: 3, status: "today", plan_day: lift(3, "Upper back & arms"), session: null, run: null, hard: false },
      { date: "2026-10-22", weekday: "Thu", dow: 4, status: "upcoming", plan_day: lift(4, "Push B"), session: null, run: run("quality", "Threshold intervals", 9, "open", "2026-10-22"), hard: true },
      { date: "2026-10-23", weekday: "Fri", dow: 5, status: "upcoming", plan_day: lift(5, "Pull"), session: null, run: run("easy", "Easy run", 6, "open", "2026-10-23"), hard: false },
      { date: "2026-10-24", weekday: "Sat", dow: 6, status: "rest", plan_day: null, session: null, run: null, hard: false },
      { date: "2026-10-25", weekday: "Sun", dow: 0, status: "upcoming", plan_day: null, session: null, run: run("long", "Long run", 14, "open", "2026-10-25"), hard: false },
    ],
    ...overrides,
  };
}

const lookLift = (title, lifts, more = 0) => ({ title, focus: null, lifts, more, done: false });

function lookAhead() {
  return {
    as_of: TODAY,
    mode: "calendar",
    run_units: "km",
    strength_line: strengthLine,
    order: [],
    weeks: [
      {
        week_start: "2026-10-19",
        label: "This week",
        markers: [],
        days: [
          { date: TODAY, weekday: "Wed", today: true, lift: lookLift("Upper back & arms", ["Row", "Curl"]), run: null, rest: false, hard: false },
          { date: "2026-10-22", weekday: "Thu", today: false, lift: lookLift("Push B", ["Bench", "Overhead Press"], 1), run: { kind: "quality", label: "Threshold intervals", km: 9, done: false }, rest: false, hard: true },
          // The look-ahead naming another lift for a day: its key lifts never ride the week's row.
          { date: "2026-10-23", weekday: "Fri", today: false, lift: lookLift("Legs", ["Back Squat"]), run: null, rest: false, hard: false },
        ],
      },
      {
        week_start: "2026-10-26",
        label: "Next week",
        markers: [{ kind: "race_build", word: "Race <week>", note: null }],
        days: [{ date: "2026-10-26", weekday: "Mon", today: false, lift: lookLift("Push A", ["Bench"]), run: null, rest: false, hard: false }],
      },
    ],
  };
}

const detailToday = {
  date: TODAY,
  weekday: "Wed",
  today: TODAY,
  status: "today",
  run_units: "km",
  lift: {
    day_number: 3,
    title: "Upper back & arms",
    exercises: [
      { name: "Chest-supported Row", mode: "reps", prescription: "3 × 8–10", load: { text: "60 lb" }, anchor: true },
      { name: "Curl <EZ>", mode: "reps", prescription: "3 × 10–12", load: null, anchor: false },
    ],
  },
  run: null,
};

const detailThursday = {
  date: "2026-10-22",
  weekday: "Thu",
  today: TODAY,
  status: "upcoming",
  run_units: "km",
  lift: { day_number: 4, title: "Push B", exercises: [{ name: "Bench Press", mode: "reps", prescription: "4 × 5–8", load: { text: "185 lb" }, anchor: true }] },
  run: {
    kind: "quality",
    label: "Threshold intervals",
    status: "open",
    km: 9,
    mi: 5.6,
    run_units: "km",
    zone: { key: "Z4", label: "Threshold", low_bpm: 160, high_bpm: 170, feel: null, text: null },
    pace: { key: "threshold", label: "Threshold", text: "4:35–4:45 /km", slow_sec_per_km: 285, fast_sec_per_km: 275 },
    structure: [
      { part: "warm_up", label: "Warm-up", text: "", km: 2, mi: 1.2, reps: null, on: null, off: null, zone: "Z2", hr: null, pace: null },
      { part: "main", label: "Threshold", text: "5 × 1 km at threshold, 60 s easy jog between", km: 5, mi: 3.1, reps: 5, on: "1km", off: "60s jog", zone: "Z4", hr: null, pace: null },
      { part: "cool_down", label: "Cool-down", text: "", km: 2, mi: 1.2, reps: null, on: null, off: null, zone: "Z2", hr: null, pace: null },
    ],
    adjusted: null,
  },
};

const MODULES = [
  "html-utils",
  "format-utils",
  "ui-format",
  "ui-reads",
  "day-detail-model",
  "day-glance-model",
  "day-glance-view",
  "program-week-model",
  "program-week-client",
  "train-week-client",
];

function load(globals = {}) {
  return loadClientModule(MODULES, { globals: { localISO: () => TODAY, ...globals } });
}

const finishedToday = () =>
  planWeek({
    days: planWeek().days.map((d) =>
      d.date === TODAY ? { ...d, status: "done", session: { id: 3, title: "Upper back & arms", date: TODAY, finished: true } } : d
    ),
  });

test("the next session is today's open lift, opened up: each movement with its sets × reps and load", () => {
  const win = load();
  const W = win.CairnTrainWeek;
  const next = W.nextOf(planWeek(), lookAhead());
  assert.equal(next.date, TODAY);
  const card = renderHtml(W.nextHtml(next, detailToday, TODAY, strengthLine), { document: win.document });
  assert.equal(card.querySelector(".twk-next-k").textContent, "Next · Today");
  assert.equal(card.querySelector(".twk-next-t").textContent, "Upper back & arms");
  const rows = card.querySelectorAll(".twk-ex");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].classList.contains("is-anchor"), "the day's anchor is marked");
  assert.match(rows[0].textContent, /Chest-supported Row/);
  assert.equal(rows[0].querySelector(".twk-ex-rx").textContent, "3 × 8–10 · 60 lb");
  assert.equal(rows[1].querySelector(".twk-ex-rx").textContent, "3 × 10–12", "no load is never invented");
  assert.equal(card.querySelector(".twk-caveat").textContent, "Keep the <rows> smooth.", "today's caveat, verbatim");
  assert.ok(card.querySelector("[data-twk-start]"), "today's session starts here");
  assert.equal(card.querySelector("[data-twk-start]").textContent, "Start Upper back & arms", "the one primary action names the session");
  assert.equal(card.querySelector(".twk-open").getAttribute("data-open-day"), TODAY);
  const html = W.nextHtml(next, detailToday, TODAY, strengthLine);
  assert.doesNotMatch(html, /<EZ>|<rows>/, "every caller string is escaped");
  assert.doesNotMatch(html, /\d+\s*%|score|grade/i, "no scores");
});

test("with today in, the next session is tomorrow's: the lift and the run with its zone, pace and parts", () => {
  const win = load();
  const W = win.CairnTrainWeek;
  const next = W.nextOf(finishedToday(), lookAhead());
  assert.equal(next.date, "2026-10-22");
  // Before the day's detail lands, the card says what the week knows.
  const cold = renderHtml(W.nextHtml(next, null, TODAY, strengthLine), { document: win.document });
  assert.equal(cold.querySelector(".twk-next-k").textContent, "Next · Tomorrow");
  assert.equal(cold.querySelector(".twk-lifts").textContent, "Bench · Overhead Press +1");
  assert.match(cold.querySelector(".twk-run").textContent, /Threshold intervals · 9 km/);
  const card = renderHtml(W.nextHtml(next, detailThursday, TODAY, strengthLine), { document: win.document });
  assert.equal(card.querySelector("[data-twk-start]"), null, "only today's session starts from Train");
  assert.equal(card.querySelector(".twk-caveat"), null, "today's caveat never rides another day");
  assert.equal(card.querySelector(".twk-ex-rx").textContent, "4 × 5–8 · 185 lb");
  const meta = card.querySelector(".twk-run-m").textContent;
  assert.match(meta, /^9 km · Z4 · Threshold · 4:35–4:45/);
  assert.match(card.querySelector(".twk-run-s").textContent, /^Warm-up 2 km → 5 × 1 km at threshold, 60 s easy jog between → Cool-down 2 km$/);
  assert.equal(card.querySelector(".twk-open").getAttribute("data-open-day"), "2026-10-22");
});

test("a day whose lift is in but whose run is open leads with the run, the lift said done", () => {
  const win = load();
  const W = win.CairnTrainWeek;
  const week = planWeek({
    days: planWeek().days.map((d) =>
      d.date === TODAY
        ? { ...d, status: "done", session: { id: 3, title: "Upper back & arms", date: TODAY, finished: true }, run: run("easy", "Easy run", 5, "open", TODAY) }
        : d
    ),
  });
  const next = W.nextOf(week, lookAhead());
  assert.equal(next.date, TODAY);
  const card = renderHtml(W.nextHtml(next, null, TODAY, strengthLine), { document: win.document });
  assert.equal(card.querySelector(".twk-next-t").textContent, "Easy run");
  assert.match(card.querySelector(".twk-done").textContent, /Upper back & arms/);
  assert.equal(card.querySelector("[data-twk-start]"), null);
});

test("nothing left this week or next says so calmly, with one door to the plan", () => {
  const win = load();
  const W = win.CairnTrainWeek;
  const done = planWeek({ days: planWeek().days.map((d) => (d.date >= TODAY ? { ...d, plan_day: null, run: null, session: null, status: "rest" } : d)) });
  assert.equal(W.nextOf(done, null), null);
  const html = W.nextHtml(null, null, TODAY, null);
  assert.match(html, /Nothing else is planned this week\./);
  assert.match(html, /data-pahead-edit/);
});

test("the week reads Mon–Sun as the shared day rows: done with what was logged, today washed, rest calm", () => {
  const win = load();
  const W = win.CairnTrainWeek;
  const host = renderHtml(W.daysHtml(planWeek(), lookAhead()), { document: win.document });
  const rows = host.querySelectorAll(".pahead-day");
  assert.equal(rows.length, 7);
  assert.deepEqual(
    rows.map((r) => r.getAttribute("data-open-day")),
    ["2026-10-19", "2026-10-20", TODAY, "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]
  );
  assert.ok(rows[0].classList.contains("is-past") && rows[0].classList.contains("is-done"), "a lived day reads settled");
  assert.ok(rows[0].querySelector(".pahead-tick"), "done is ticked");
  assert.match(rows[1].textContent, /Lower/);
  assert.match(rows[1].textContent, /Easy run · 6\.2 km/, "what was logged");
  assert.ok(rows[2].classList.contains("is-today"));
  assert.equal(rows[2].getAttribute("aria-current"), "date");
  assert.match(rows[2].textContent, /Upper back & arms · not started/, "today speaks the server's one line");
  assert.match(rows[3].textContent, /Push B/);
  assert.match(rows[3].textContent, /Bench · Overhead Press \+1/, "a day ahead names its key lifts");
  assert.match(rows[3].textContent, /A harder day/);
  assert.match(rows[4].textContent, /Pull/);
  assert.doesNotMatch(rows[4].textContent, /Back Squat/, "key lifts only from a look-ahead naming the same lift");
  assert.ok(rows[5].classList.contains("is-rest"));
  assert.equal(rows[5].querySelector(".pahead-rest").textContent, "Rest");
  assert.match(rows[6].textContent, /Long run · 14 km/);
  // The week's one progress line, said once, escaped.
  const lines = host.querySelectorAll(".twk-line");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].textContent, "Two of five <lifting> days are in.");
  assert.doesNotMatch(W.daysHtml(planWeek(), lookAhead()), /<lifting>/);
});

test("no calendar on the week read falls back to the look-ahead's rows, then its order or empty state", () => {
  const win = load();
  const W = win.CairnTrainWeek;
  const undated = planWeek({ days: planWeek().days.map((d) => ({ ...d, date: null })) });
  const host = renderHtml(W.daysHtml(undated, lookAhead()), { document: win.document });
  assert.equal(host.querySelectorAll(".pahead-day").length, 3);
  const empty = W.daysHtml(undated, { ...lookAhead(), mode: "empty", weeks: [] });
  assert.match(empty, /Nothing planned yet/);
});

test("next week rides one fold of the same rows, its marker escaped; none means no fold", () => {
  const win = load();
  const W = win.CairnTrainWeek;
  const html = W.nextWeekHtml(lookAhead());
  const host = renderHtml(`<details>${html}</details>`, { document: win.document });
  assert.match(host.querySelector(".twk-fold-sum").textContent, /Next week/);
  assert.equal(host.querySelector(".pahead-mark").textContent, "Race <week>");
  assert.equal(host.querySelectorAll(".pahead-day").length, 1);
  assert.equal(host.querySelector(".pahead-day").getAttribute("data-open-day"), "2026-10-26");
  assert.doesNotMatch(html, /<week>/);
  assert.equal(W.nextWeekHtml({ ...lookAhead(), weeks: [lookAhead().weeks[0]] }), "");
  assert.equal(W.nextWeekHtml(null), "");
});

test("renderTrainWeek paints from the cache at once, fills the next day's detail, and Start opens Today's session", async () => {
  const calls = [];
  const held = { "plan:week": { data: planWeek(), fresh: false } };
  const reads = {
    "/plan/week": planWeek(),
    "/plan/look-ahead": lookAhead(),
    [`/plan/day-detail?date=${TODAY}`]: detailToday,
  };
  const state = { tab: "progress", progressSeg: "week" };
  const win = load({
    state,
    PROGRESS_SEG: [],
    PROGRESS_HANDLERS: { plan: () => calls.push(["plan"]) },
    segBar: (active) => `<nav class="segwrap" data-active="${active}"></nav>`,
    wireSeg: () => calls.push(["wireSeg"]),
    peekCached: (key) => held[key] || null,
    cachedApi: (path, opts) => {
      calls.push(["cachedApi", path, opts?.key]);
      return Promise.resolve(reads[path] ?? null);
    },
    openSession: (date, opts) => {
      calls.push(["openSession", date, opts.source, opts.provenance.entry]);
      return Promise.resolve(true);
    },
    activateTab: (name) => calls.push(["activateTab", name]),
  });
  win.view = createHost(win.document);
  win.headerTitle = createHost(win.document, { tag: "h1" });
  const done = win.renderTrainWeek();
  // The held week paints before any read answers.
  assert.equal(win.headerTitle.textContent, "Train");
  assert.equal(state.progressSeg, "week");
  assert.equal(win.view.querySelector(".segwrap").getAttribute("data-active"), "week");
  assert.equal(win.view.querySelectorAll("[data-twk-days] .pahead-day").length, 7);
  assert.ok(win.view.querySelector("[data-train-deeper-slot]"), "the landing's deeper rows (Progress first) have their slot");
  await done;
  await flush();
  assert.ok(calls.some((c) => c[0] === "cachedApi" && c[1] === "/plan/week" && c[2] === "plan:week"), "the week Today's strip reads");
  assert.ok(calls.some((c) => c[0] === "cachedApi" && c[1] === "/plan/look-ahead" && c[2] === "plan:look-ahead"));
  assert.ok(calls.some((c) => c[0] === "cachedApi" && c[1] === `/plan/day-detail?date=${TODAY}` && c[2] === `plan:day-detail:${TODAY}`));
  assert.equal(win.view.querySelectorAll(".twk-ex").length, 2, "the next day's detail fills the card");
  const fold = win.view.querySelector("[data-twk-ahead]");
  assert.equal(fold.hasAttribute("hidden"), false);
  assert.equal(fold.querySelectorAll(".pahead-day").length, 1);
  await win.view.querySelector("[data-twk-start]").click();
  assert.deepEqual(
    calls.filter((c) => c[0] === "openSession").map((c) => [...c]),
    [["openSession", TODAY, "adaptive_plan", "train_week"]]
  );
});

test("a landing the athlete has left is never painted over", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const state = { tab: "progress", progressSeg: "week" };
  const win = load({
    state,
    PROGRESS_SEG: [],
    PROGRESS_HANDLERS: {},
    segBar: () => `<nav class="segwrap"></nav>`,
    wireSeg: () => {},
    peekCached: () => null,
    cachedApi: (path) => gate.then(() => (path === "/plan/week" ? planWeek() : lookAhead())),
  });
  win.view = createHost(win.document);
  win.headerTitle = createHost(win.document, { tag: "h1" });
  const done = win.renderTrainWeek();
  assert.ok(win.view.querySelector(".pahead-skel"), "a cold open shows the skeleton");
  state.progressSeg = "sessions";
  release();
  await done;
  await flush();
  assert.equal(win.view.querySelectorAll(".pahead-day").length, 0);
});

// ---- Today's evening look-ahead ----

function loadTomorrow(globals = {}) {
  return loadClientModule(["html-utils", "format-utils", "ui-format", "train-week-tomorrow-client"], { globals }).CairnTrainWeekTomorrow;
}
const at = (hour, day = 21) => new Date(2026, 9, day, hour, 0, 0);

test("once today's training is in, one line names tomorrow and opens its day", () => {
  const T = loadTomorrow();
  const html = T.html(finishedToday(), at(9));
  const host = renderHtml(html);
  const btn = host.querySelector(".brief-tomorrow");
  assert.equal(btn.getAttribute("data-open-day"), "2026-10-22");
  assert.equal(btn.querySelector(".brief-forward-txt").textContent, "Tomorrow: Push B · Threshold intervals · 9 km");
  assert.equal(T.html(planWeek(), at(20)), "", "today's lift still open: no look-ahead, whatever the hour");
  assert.equal(T.html(null, at(20)), "");
});

test("a rest day says tomorrow from the evening on; a Sunday reads Monday off the held look-ahead", () => {
  const T = loadTomorrow();
  const saturday = planWeek({ as_of: "2026-10-24" });
  assert.equal(T.html(saturday, at(15, 24)), "", "a rest day waits for the evening");
  assert.match(T.html(saturday, at(17, 24)), /Tomorrow: Long run · 14 km/);
  const friday = planWeek({ as_of: "2026-10-23", days: planWeek().days.map((d) => (d.date === "2026-10-23" ? { ...d, plan_day: null, run: null, status: "rest" } : d)) });
  assert.match(T.html(friday, at(18, 23)), /Tomorrow: a rest day/, "a rest tomorrow reads as rest, calmly");
  const sunday = planWeek({ as_of: "2026-10-25", days: planWeek().days.map((d) => (d.date === "2026-10-25" ? { ...d, run: null, status: "rest" } : d)) });
  assert.match(T.html(sunday, at(19, 25), lookAhead()), /data-open-day="2026-10-26"[^>]*>.*Tomorrow: Push A/);
  assert.equal(T.html(sunday, at(19, 25), null), "", "nothing known about tomorrow says nothing");
});

test("the Brief carries the held line in its own slot ahead of the week strip", () => {
  const T = loadTomorrow({ peekCached: (key) => (key === "plan:week" ? { data: finishedToday(), fresh: true } : null) });
  assert.match(T.heldHtml(at(9)), /Tomorrow: Push B/);
  assert.equal(T.heldHtml(at(9, 22)), "", "a week held from yesterday names no tomorrow");
  const brief = loadClientModule(["html-utils", "ui-reads", "today-brief-voice-client", "today-brief-client"], {
    globals: { CairnTrainWeekTomorrow: { heldHtml: () => `<button class="brief-tomorrow">Tomorrow: x</button>` } },
  }).CairnTodayBrief;
  const html = brief.briefHtml({ kind: "done", headline: "In.", signals: {} }, { isToday: true });
  const slot = html.indexOf("data-brief-tomorrow");
  assert.ok(slot >= 0 && slot < html.indexOf('id="todayStripSlot"'), "the line leads the week strip");
  assert.match(html, /data-brief-tomorrow><button class="brief-tomorrow">Tomorrow: x<\/button><\/div>/);
  const other = brief.briefHtml({ kind: "done", headline: "In.", signals: {} }, { isToday: false });
  assert.doesNotMatch(other, /data-brief-tomorrow/, "only today's own Brief looks ahead");
});

// ---------- wave 2: the day's note, and the one primary action ----------

const withNote = (date, text) => ({
  ...planWeek(),
  days: planWeek().days.map((d) => (d.date === date ? { ...d, plan_day: { ...d.plan_day, note: { kind: "after_run", text } } } : d)),
});

test("a day's note prints verbatim under its row, escaped; a day without one prints nothing", () => {
  const win = load();
  const W = win.CairnTrainWeek;
  const week = withNote("2026-10-22", "Push B today — you ran this <morning>. Lower moves to Fri.");
  const list = renderHtml(W.daysHtml(week, lookAhead()), { document: win.document });
  const notes = list.querySelectorAll(".pahead-note");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].textContent, "Push B today — you ran this <morning>. Lower moves to Fri.");
  assert.ok(notes[0].closest("[data-open-day]").getAttribute("data-open-day") === "2026-10-22", "the note sits inside its own day's row");
  assert.doesNotMatch(W.daysHtml(week, lookAhead()), /<morning>/);
  assert.equal(renderHtml(W.daysHtml(planWeek(), lookAhead()), { document: win.document }).querySelector(".pahead-note"), null);
});

test("Today's strip says the note for today in place of the bare swap line", () => {
  const win = loadClientModule(["html-utils", "format-utils", "ui-format", "day-detail-model", "day-glance-model", "day-glance-view", "today-strip-client"], {
    globals: { localISO: () => TODAY },
  });
  const S = win.CairnTodayStrip;
  const week = withNote(TODAY, "Trip day — lift if you can, skip it freely.");
  const cells = S.cellsOf(week, TODAY);
  const now = renderHtml(S.nowHtml(week, cells), { document: win.document });
  assert.equal(now.querySelector(".tstrip-note").textContent, "Trip day — lift if you can, skip it freely.");
  assert.equal(S.nowHtml(planWeek(), S.cellsOf(planWeek(), TODAY)), "", "no note, no swap: nothing");
});

test("the primary action follows the state as served: start, resume, log the run, or just open the day", () => {
  const win = load();
  const W = win.CairnTrainWeek;
  const html = (week, detail, line = strengthLine) => {
    const next = W.nextOf(week, lookAhead());
    return renderHtml(W.nextHtml(next, detail, TODAY, line), { document: win.document });
  };
  assert.equal(html(planWeek(), detailToday).querySelectorAll(".twk-acts .btn-solid").length, 1, "exactly one primary action");
  const live = planWeek({
    days: planWeek().days.map((d) => (d.date === TODAY ? { ...d, status: "today", session: { id: 3, title: "Upper back & arms", date: TODAY, finished: false } } : d)),
  });
  assert.equal(html(live, detailToday).querySelector("[data-twk-start]").textContent, "Resume session");
  const runOnly = planWeek({
    days: planWeek().days.map((d) =>
      d.date === TODAY
        ? { ...d, status: "done", session: { id: 3, title: "Upper back & arms", date: TODAY, finished: true }, run: run("easy", "Easy run", 5, "open", TODAY) }
        : d
    ),
  });
  const logRun = html(runOnly, null);
  assert.equal(logRun.querySelector(".btn-solid").textContent, "Log this run");
  assert.equal(logRun.querySelector(".btn-solid").getAttribute("data-open-day"), TODAY);
  assert.equal(logRun.querySelectorAll("[data-open-day]").length, 1, "no second 'Open day' beside it");
  const rest = { ...strengthLine, state: "rest_day", text: "Rest day — nothing to lift today <b>." };
  const later = html(finishedToday(), detailThursday, rest);
  assert.equal(later.querySelector(".btn-solid"), null, "a later day only opens");
  assert.equal(later.querySelector(".twk-done").textContent, "Rest day — nothing to lift today <b>.");
});

test("a day that did not fit this week is said under the strip, verbatim and escaped", () => {
  const win = load();
  const W = win.CairnTrainWeek;
  const text = "Lower didn't fit this week — the key runs took its <days>. Say the word and I'll find it a spot.";
  const html = W.daysHtml(planWeek({ unplaced: [{ day_number: 2, name: "Lower", text }] }), lookAhead());
  const host = renderHtml(html, { document: win.document });
  const said = host.querySelectorAll("[data-twk-unplaced]");
  assert.equal(said.length, 1);
  assert.equal(said[0].textContent, text);
  assert.doesNotMatch(html, /<days>/, "escaped");
  assert.equal(
    renderHtml(W.daysHtml(planWeek(), lookAhead()), { document: win.document }).querySelector("[data-twk-unplaced]"),
    null,
    "nothing displaced, nothing said"
  );
});
