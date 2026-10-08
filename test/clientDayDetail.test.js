// The ONE day view (day-detail-{model,client,controller}.ts, the lazy "calendar" bundle):
// Horizon's week and Train's week ahead open it through the day view, Today's "What's
// ahead" strip (today-strip-{client,controller}.ts) opens it inline. The view frames
// the server's read — the hero, the anchor first, every movement with its sets × reps
// and load, the run's structure drawn to scale in zone colour, what to watch, what was
// done — and escapes every caller string. The movement row is shared with the Program
// gallery. The Horizon week rows say a rest day quietly, tick a finished day, and
// name the plan day today stands in for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHost, flush, loadClientModule, renderHtml } from "./_dom.mjs";
import { createNav } from "./_nav.mjs";

function navGlobals(start) {
  const nav = createNav(start);
  return { location: nav.location, history: nav.history };
}

const TODAY = "2026-10-06";

function load(globals = {}) {
  return loadClientModule(
    [
      "html-utils",
      "ui-format",
      "format-utils",
      "ui-format",
      "ui-actions-client",
      "ui-reads",
      "day-detail-model",
      "day-glance-model",
      "day-detail-run-client",
      "day-detail-client",
      "day-glance-view",
      "day-detail-controller",
    ],
    { globals }
  );
}

function exercise(over = {}) {
  return {
    name: "Romanian Deadlift",
    muscle_group: "posterior",
    mode: "reps",
    sets: 3,
    rep_low: 8,
    rep_high: 10,
    target_seconds: null,
    prescription: "3 × 8–10",
    load: { weight: 135, text: "135 lb", source: "progression", change: "+1 rep", action: "overload" },
    anchor: false,
    note: null,
    ...over,
  };
}

function detail(over = {}) {
  return {
    date: "2026-10-08",
    weekday: "Thu",
    today: TODAY,
    status: "upcoming",
    placed: true,
    focus: "Lower B · Threshold intervals",
    headline: "A Lower B day, then threshold intervals.",
    why: "Build week · 4 weeks to Coastal half marathon. A new weekly high — sharpen rather than add.",
    week: {
      week_start: "2026-10-05",
      race: { event: "Coastal half marathon", kind: "build", word: "Build week", focus: "", weeks_to_race: 4 },
      block: { phase: "accumulation", focus: "strength", week_index: 2, total_weeks: 6 },
    },
    lift: {
      day_number: 3,
      title: "Lower B",
      focus: null,
      intent: "Romanian Deadlift leads, then Leg Curl.",
      point: "The step is on Romanian Deadlift; everything else holds.",
      anchor: "Romanian Deadlift",
      exercises: [
        exercise({ anchor: true }),
        exercise({
          name: "Leg Curl",
          muscle_group: "hamstrings",
          prescription: "3 × 12",
          load: { weight: 140, text: "140 lb", source: "progression", change: "hold 140 lb", action: "hold" },
        }),
      ],
      total_sets: 6,
      heavy_lower: true,
      today_line: null,
      suggestion: null,
    },
    run: {
      kind: "quality",
      label: "Threshold intervals",
      status: "open",
      km: 9.5,
      mi: 5.9,
      run_units: "km",
      zone: { key: "Z4", label: "Threshold", low_bpm: 158, high_bpm: 168, feel: null, text: "Z4" },
      pace: { key: "threshold", label: "Threshold", text: "5:05–5:15 /km", slow_sec_per_km: 315, fast_sec_per_km: 305 },
      hr_ceiling_bpm: null,
      structure: [
        {
          part: "warm_up",
          label: "Warm-up",
          text: "2 km easy",
          km: 2,
          mi: 1.2,
          reps: null,
          on: null,
          off: null,
          zone: "Z2",
          hr: null,
          pace: null,
        },
        {
          part: "main",
          label: "Threshold",
          text: "5 × 1 km at threshold",
          km: 5.5,
          mi: 3.4,
          reps: 5,
          on: "1km",
          off: "60s jog",
          zone: "Z4",
          hr: { low_bpm: 158, high_bpm: 168 },
          pace: { text: "5:05–5:15 /km", slow_sec_per_km: 315, fast_sec_per_km: 305 },
        },
        {
          part: "cool_down",
          label: "Cool-down",
          text: "2 km easy",
          km: 2,
          mi: 1.2,
          reps: null,
          on: null,
          off: null,
          zone: "Z1",
          hr: null,
          pace: null,
        },
      ],
      session: null,
      short: false,
      race: false,
      adjusted: null,
      point: "Controlled, honest effort.",
      completed: null,
    },
    watch: [{ kind: "symptom", exercise: null, text: "Right knee: ease off if it speaks up." }],
    stack: {
      text: "Wednesday's legs will still be there.",
      neighbours: [{ date: "2026-10-07", weekday: "Wed", what: "Lower A", kind: "heavy_lower" }],
    },
    done: null,
    caveats: [],
    run_units: "km",
    ...over,
  };
}

test("a day ahead: the hero, the anchor first, the shared rows with load and step, the run drawn to scale", () => {
  const w = load();
  const host = renderHtml(w.CairnDayDetailView.dayDetailHtml(detail()));
  assert.equal(host.querySelector(".ddv-kicker").textContent, "In 2 days · Planned");
  assert.equal(host.querySelector(".ddv-title").textContent, "A Lower B day, then threshold intervals.");
  assert.match(host.querySelector(".ddv-point").textContent, /The step is on Romanian Deadlift/);
  assert.match(
    host.querySelector(".ddv-context").textContent,
    /Build week · 4 weeks to Coastal half marathon · Block week 2 of 6/
  );
  // The why foot drops the lead the context line already says.
  assert.equal(host.querySelector(".ddv-why-t").textContent, "A new weekly high — sharpen rather than add.");
  // The anchor leads, and the movement rows are the shared .prog-row.
  assert.equal(host.querySelector(".ddv-anchor-name").textContent, "Romanian Deadlift");
  const rows = host.querySelectorAll(".ddv-moves .prog-row");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].classList.contains("is-anchor"));
  assert.equal(rows[0].querySelector(".prog-row-name").getAttribute("data-guide"), "Romanian%20Deadlift");
  assert.equal(rows[0].querySelector(".prog-row-wt").textContent, "135 lb");
  assert.equal(rows[0].querySelector(".prog-row-step").textContent, "+1 rep");
  assert.equal(rows[1].querySelector(".prog-row-step"), null, "a hold reads as the load, never as a step");
  // The run: three parts in proportion, the work as five reps, zone fills by class.
  const segs = Array.from(host.querySelectorAll(".ddv-seg"));
  assert.equal(segs.length, 3);
  assert.ok(
    segs[0].classList.contains("is-z2") && segs[1].classList.contains("is-z4") && segs[2].classList.contains("is-z1")
  );
  const widths = segs.map((s) => Number(String(s.getAttribute("style")).match(/--w:([\d.]+)%/)[1]));
  assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 100) < 0.5, "the parts fill the bar");
  assert.ok(widths[1] > widths[0] * 2, "the work is drawn to its distance");
  assert.equal(segs[1].querySelectorAll(".ddv-rep").length, 5);
  assert.match(
    host.querySelector(".ddv-strip").getAttribute("aria-label"),
    /Warm-up 2 km Z2, then Threshold 5\.5 km Z4/
  );
  const facts = Array.from(host.querySelectorAll(".ddv-fact dd")).map((d) => d.textContent);
  assert.deepEqual(facts, ["Z4 · Threshold", "158–168 bpm", "5:05–5:15 /km"]);
  assert.match(host.querySelector(".ddv-stack-t").textContent, /Wednesday's legs/);
  assert.equal(host.querySelector(".ddv-watch-k").textContent, "On watch");
  assert.equal(host.querySelector(".ddv-done"), null, "a day ahead has nothing done");
});

test("a miles athlete reads distances and paces in miles", () => {
  const w = load();
  const d = detail({ run_units: "mi" });
  d.run.run_units = "mi";
  const host = renderHtml(w.CairnDayDetailView.dayDetailHtml(d));
  assert.match(host.querySelector(".ddv-run .ddv-mast-m").textContent, /5\.9 mi/);
  // 305 s/km → 8:11 /mi, 315 s/km → 8:27 /mi.
  assert.equal(host.querySelectorAll(".ddv-fact dd")[2].textContent, "8:11–8:27 /mi");
});

test("a day lived leads with what was done and folds the plan; hostile strings stay text", () => {
  const w = load();
  const d = detail({
    date: "2026-10-04",
    status: "done",
    headline: "Push <b>done</b>",
    stack: null,
    done: {
      session: {
        id: 1,
        title: "Lower <img>",
        finished: true,
        sets: 6,
        movements: [{ name: "RDL", sets: 3, best: "135 × 9" }],
        skipped: [],
        notes: null,
      },
      runs: [
        {
          id: 2,
          title: "run",
          run: true,
          distance_km: 9.6,
          duration_min: 52,
          pace: "5:25/km",
          note: null,
          source: null,
        },
      ],
      other: [],
    },
  });
  d.run.completed = {
    km: 9.6,
    mi: 6,
    duration_min: 52,
    pace_sec_per_km: 325,
    avg_hr: null,
    effort: "steady",
    title: null,
  };
  const host = renderHtml(w.CairnDayDetailView.dayDetailHtml(d));
  assert.equal(host.querySelector(".ddv-kicker").textContent, "2 days ago · Done");
  assert.equal(host.querySelector(".ddv-title").textContent, "Push <b>done</b>");
  assert.equal(host.querySelector(".ddv-title b"), null);
  const done = host.querySelectorAll(".ddv-done-row");
  assert.equal(done.length, 2);
  assert.equal(done[0].querySelector(".ddv-done-t").textContent, "Lower <img>");
  assert.equal(done[1].querySelector(".ddv-done-s").textContent, "9.6 km · 52 min · 5:25 /km · steady");
  assert.ok(host.querySelector("details.ddv-planned .ddv-lift"), "the plan waits in a fold");
});

test("a rest day: just the line, the week and its caveats", () => {
  const w = load();
  const host = renderHtml(
    w.CairnDayDetailView.dayDetailHtml(
      detail({
        status: "rest",
        headline: "A rest day.",
        lift: null,
        run: null,
        watch: [],
        stack: null,
        why: null,
        caveats: ["Trip"],
      })
    )
  );
  assert.equal(host.querySelector(".ddv-kicker").textContent, "In 2 days · Rest day");
  assert.equal(host.querySelector(".ddv-point"), null);
  assert.equal(host.querySelector(".ddv-lift"), null);
  assert.equal(host.querySelector(".ddv-run"), null);
  assert.equal(host.querySelector(".ddv-caveat").textContent, "Trip");
});

test("the movement row is one renderer: escaped, with its hints, load and anchor word", () => {
  const w = load();
  const host = renderHtml(
    w.CairnDayDetailView.exerciseRowHtml({
      name: "Squat <x>",
      prescription: "3 × 5",
      load: "225 lb",
      hints: ["2 warmup", null, "Belt <on>"],
      anchor: true,
    })
  );
  assert.equal(host.querySelector(".prog-row-name").textContent, "Squat <x>");
  assert.equal(host.querySelector(".prog-row-name").getAttribute("type"), "button");
  assert.match(host.querySelector(".prog-row-hint").textContent, /Anchor2 warmup · Belt <on>/);
  assert.equal(host.querySelector(".prog-row-hint b, .prog-row-hint on"), null);
});

test("the body figure lights the regions the day loads, the anchor's first", () => {
  const w = load();
  const tones = w.CairnDayDetailModel.muscleTones([
    exercise({ anchor: true, muscle_group: "legs" }),
    exercise({ muscle_group: "back" }),
    exercise({ muscle_group: "mystery" }),
  ]);
  assert.deepEqual({ ...tones.tones }, { quads: "high", glutes: "high", hamstrings: "high", back: "ok" });
  assert.ok(tones.front && tones.back);
});

test("the controller paints warm from the cache, then the read; a cold failure says so in one line", async () => {
  const w = load({ wireGuides: () => {} });
  const host = createHost(w.document);
  const calls = [];
  const warm = detail();
  w.CairnDayDetailController.mount(host, {
    date: "2026-10-08",
    peek: (key) => {
      calls.push(key);
      return { data: warm, fresh: false };
    },
    load: (path, opts) => {
      calls.push(path, opts.key);
      return Promise.resolve(detail({ headline: "Fresh line." }));
    },
    inline: true,
  });
  assert.equal(host.querySelector(".ddv-title").textContent, warm.headline);
  assert.ok(host.querySelector(".ddv.ddv-inline"));
  await flush();
  assert.equal(host.querySelector(".ddv-title").textContent, "Fresh line.");
  assert.deepEqual(calls, [
    "plan:day-detail:2026-10-08",
    "/plan/day-detail?date=2026-10-08",
    "plan:day-detail:2026-10-08",
  ]);

  const cold = createHost(w.document);
  w.CairnDayDetailController.mount(cold, {
    date: "2026-10-08",
    peek: () => null,
    load: () => Promise.reject(new Error("offline")),
  });
  assert.ok(cold.querySelector(".ddv-pending"), "the skeleton holds the space");
  await flush();
  assert.match(cold.textContent, /couldn't be opened just now/);
});

// ---- Today's "What's ahead" strip ----

function week() {
  const day = (date, status, plan, run, session) => ({
    date,
    weekday: null,
    dow: null,
    status,
    plan_day: plan
      ? {
          day_number: 1,
          name: plan,
          focus: null,
          purpose: null,
          day_type: "training",
          role: "strength",
          out_of_order: false,
          ...(date === TODAY ? { swapped_from: { day_number: 3, name: "Lower B" } } : {}),
        }
      : null,
    session: session ? { id: 1, title: plan, date, finished: true } : null,
    run,
    hard: false,
  });
  return {
    days: [
      day("2026-10-05", "done", "Push", null, true),
      day(TODAY, "today", "Pull <i>", null, false),
      day("2026-10-07", "rest", null, null),
      day("2026-10-08", "upcoming", "Lower B", { kind: "quality", label: "Threshold", status: "open", km: 9.5 }),
      day("2026-10-09", "upcoming", "Full Body", null),
      day("2026-10-10", "upcoming", null, { kind: "long", label: "Long run", status: "open", km: 16 }),
      day("2026-10-11", "upcoming", "Lower A", null),
    ],
    strength_line: {
      date: TODAY,
      state: "not_started",
      text: "Pull · not started",
      title: "Pull",
      caveat: null,
      reshaped: false,
      original: [],
    },
  };
}

// The strip draws the day view's chips and peeks through the drill (the "calendar"
// bundle today-ahead depends on); a test stubs only the detail's controller.
function loadStrip(globals = {}) {
  return loadClientModule(
    [
      "html-utils",
      "ui-format",
      "ui-actions-client",
      "ui-reads",
      "day-detail-model",
      "day-glance-model",
      "day-detail-run-client",
      "day-detail-client",
      "day-glance-view",
      "drill-controller",
      "today-strip-client",
      "today-strip-controller",
    ],
    {
      globals: { ...navGlobals(), ...globals },
    }
  );
}

test("the strip: seven real buttons, today ringed, done ticked, lift short names and run bars", () => {
  const w = loadStrip();
  const host = renderHtml(w.CairnTodayStrip.stripHtml(week(), TODAY));
  const days = Array.from(host.querySelectorAll("button.tstrip-day"));
  assert.equal(days.length, 7);
  assert.ok(days.every((b) => b.getAttribute("type") === "button" && b.getAttribute("aria-expanded") === "false"));
  assert.ok(days[1].classList.contains("is-today"));
  assert.equal(days[1].getAttribute("aria-current"), "date");
  assert.ok(days[0].classList.contains("is-done") && days[0].querySelector(".tstrip-tick"));
  assert.ok(days[2].classList.contains("is-rest"));
  assert.equal(days[3].querySelector(".tstrip-lift").textContent, "LB");
  assert.ok(days[3].querySelector(".tstrip-run.is-quality"));
  assert.ok(days[5].querySelector(".tstrip-run.is-long"));
  assert.match(days[1].getAttribute("aria-label"), /^Tuesday 6, today: Pull <i>, planned/);
  assert.equal(host.querySelector(".tstrip-lift i"), null, "names are escaped");
  // Today's strength line is the Brief's (said once, right above the strip): the strip
  // only adds the swap, quietly.
  assert.doesNotMatch(host.querySelector(".tstrip-now").textContent, /not started/);
  assert.equal(host.querySelector(".tstrip-now .strength-line"), null);
  assert.match(host.querySelector(".tstrip-swap").textContent, /Pull <i> in place of Lower B/);
  assert.equal(
    w.CairnTodayStrip.stripHtml({ days: week().days.slice(0, 5) }, TODAY),
    "",
    "no strip outside calendar mode"
  );
  assert.equal(w.CairnTodayStrip.abbr("Full Body"), "FB");
  assert.equal(w.CairnTodayStrip.abbr("Pull"), "Pull");
});

test("tapping a day peeks it through the drill: ?peek= in history, one 'Open day ›', Back folds it", async () => {
  const mounts = [];
  const opened = [];
  const nav = createNav("/app/today");
  const w = loadStrip({
    location: nav.location,
    history: nav.history,
    withBundle: (name, fn) => {
      opened.push(name);
      return fn();
    },
    CairnDayDetailController: {
      mount: (host, deps) => {
        mounts.push(deps);
        host.innerHTML = `<p class="probe">${deps.date}</p>`;
        return () => mounts.push("torn");
      },
    },
  });
  nav.onPop = () => w.CairnDrill.popped();
  const slot = createHost(w.document);
  w.CairnTodayStripController.mount(slot, {
    date: TODAY,
    peek: () => ({ data: week(), fresh: true }),
    load: () => Promise.resolve(week()),
  });
  const thu = slot.querySelector('[data-tstrip-day="2026-10-08"]');
  await thu.click();
  assert.equal(thu.getAttribute("aria-expanded"), "true");
  const fold = slot.querySelector("[data-tstrip-fold]");
  assert.ok(fold.classList.contains("is-open"));
  assert.equal(fold.hasAttribute("inert"), false);
  assert.deepEqual(opened, ["calendar"]);
  assert.equal(mounts[0].date, "2026-10-08");
  assert.equal(mounts[0].inline, true, "the compact variant");
  // The peek is in history, and ends with exactly one deeper link.
  assert.equal(nav.url(), "/app/today?peek=2026-10-08");
  assert.equal(nav.history.length, 2);
  const full = slot.querySelectorAll("[data-drill-full]");
  assert.equal(full.length, 1);
  assert.equal(full[0].textContent, "Open day ›");
  assert.equal(slot.querySelector("[data-tstrip-horizon]"), null, "no 'Open in Horizon' any more");
  // A revalidated week keeps the open day open.
  await flush();
  assert.equal(slot.querySelector('[data-tstrip-day="2026-10-08"]').getAttribute("aria-expanded"), "true");
  // Another day moves the peek: the entry is replaced, never stacked.
  await slot.querySelector('[data-tstrip-day="2026-10-09"]').click();
  assert.equal(nav.url(), "/app/today?peek=2026-10-09");
  assert.equal(nav.history.length, 2);
  // The phone's Back closes it (and nothing else).
  nav.history.back();
  assert.equal(nav.url(), "/app/today");
  assert.equal(slot.querySelector('[aria-expanded="true"]'), null);
  assert.ok(fold.hasAttribute("inert"));
  assert.ok(mounts.includes("torn"));
  // Tapping a day, then tapping it again, folds it through history too.
  await slot.querySelector('[data-tstrip-day="2026-10-08"]').click();
  assert.equal(nav.url(), "/app/today?peek=2026-10-08");
  await slot.querySelector('[data-tstrip-day="2026-10-08"]').click();
  assert.equal(nav.url(), "/app/today");
  assert.equal(slot.querySelector('[data-tstrip-day="2026-10-08"]').getAttribute("aria-expanded"), "false");
  // …and its own Close does the same.
  await slot.querySelector('[data-tstrip-day="2026-10-10"]').click();
  await slot.querySelector("[data-drill-close]").click();
  assert.equal(nav.url(), "/app/today");
  assert.equal(slot.querySelector('[aria-expanded="true"]'), null);
});

test("'Open day ›' opens the day's page under Today; Back returns to Today with the peek open", async () => {
  const nav = createNav("/app/today");
  const tabs = [];
  const w = loadStrip({
    location: nav.location,
    history: nav.history,
    withBundle: (_n, fn) => fn(),
    localISO: () => TODAY,
    state: { tab: "today" },
    activateTab: (tab) => {
      tabs.push(tab);
      w.state.tab = tab;
      if (tab === "day") nav.history.pushState({ cairn: true, from: w.state.drillFrom, drill: 1 }, "", `/app/day/${w.state.dayDate}`);
    },
    CairnRoutes: { homeOf: (tab) => tab, routeToUrl: (r) => `/app/day/${r.date}` },
    CairnDayDetailController: { mount: () => () => {} },
  });
  w.scrollTo = () => {};
  nav.onPop = () => w.CairnDrill.popped();
  const slot = createHost(w.document);
  const deps = { date: TODAY, peek: () => ({ data: week(), fresh: true }), load: () => Promise.resolve(week()) };
  w.CairnTodayStripController.mount(slot, deps);
  await slot.querySelector('[data-tstrip-day="2026-10-08"]').click();
  await slot.querySelector("[data-drill-full]").click();
  assert.deepEqual(tabs, ["day"]);
  assert.equal(w.state.dayDate, "2026-10-08");
  assert.equal(w.state.drillFrom, "today", "the opener's tab stays lit");
  assert.equal(w.CairnDrill.fromLabel(), "Today");
  assert.equal(nav.url(), "/app/day/2026-10-08");
  // Back: the page's entry gives way to the peek's, which is a navigation (Today repaints)…
  nav.history.back();
  assert.equal(nav.url(), "/app/today?peek=2026-10-08");
  assert.equal(w.CairnDrill.popped(), false, "not the drill's to swallow: Today re-renders");
  // …and the repainted Today's strip opens the day the address names.
  const entries = nav.history.length;
  slot.remove();
  const again = createHost(w.document);
  w.CairnTodayStripController.mount(again, deps);
  assert.equal(again.querySelector('[data-tstrip-day="2026-10-08"]').getAttribute("aria-expanded"), "true");
  assert.equal(nav.history.length, entries, "re-opening the named peek adds no entry");
});

test("a day left open survives Today repainting the strip; a closed one stays closed", async () => {
  const mounts = [];
  const nav = createNav("/app/today");
  const w = loadStrip({
    location: nav.location,
    history: nav.history,
    withBundle: (_name, fn) => fn(),
    CairnDayDetailController: {
      mount: (_host, deps) => {
        mounts.push(deps.date);
        return () => {};
      },
    },
  });
  nav.onPop = () => w.CairnDrill.popped();
  const deps = {
    date: TODAY,
    peek: () => ({ data: week(), fresh: true }),
    load: () => Promise.resolve(week()),
  };
  const first = createHost(w.document);
  w.CairnTodayStripController.mount(first, deps);
  await first.querySelector('[data-tstrip-day="2026-10-09"]').click();
  // Today repaints: a fresh slot, a fresh mount — the open day opens again.
  first.remove();
  const again = createHost(w.document);
  w.CairnTodayStripController.mount(again, deps);
  assert.equal(again.querySelector('[data-tstrip-day="2026-10-09"]').getAttribute("aria-expanded"), "true");
  assert.deepEqual(mounts, ["2026-10-09", "2026-10-09"]);
  await again.querySelector("[data-drill-close]").click();
  const third = createHost(w.document);
  w.CairnTodayStripController.mount(third, deps);
  assert.equal(third.querySelector('[aria-expanded="true"]'), null);
});

test("a tap on a strip Today is replacing reaches the strip that replaces it", async () => {
  const nav = createNav("/app/today");
  const w = loadStrip({
    location: nav.location,
    history: nav.history,
    withBundle: (_name, fn) => fn(),
    CairnDayDetailController: { mount: () => () => {} },
  });
  nav.onPop = () => w.CairnDrill.popped();
  const deps = {
    date: TODAY,
    peek: () => ({ data: week(), fresh: true }),
    load: () => Promise.resolve(week()),
  };
  const old = createHost(w.document);
  const next = createHost(w.document);
  w.CairnTodayStripController.mount(old, deps);
  w.CairnTodayStripController.mount(next, deps);
  await old.querySelector('[data-tstrip-day="2026-10-11"]').click();
  old.remove();
  assert.equal(next.querySelector('[data-tstrip-day="2026-10-11"]').getAttribute("aria-expanded"), "true");
  assert.equal(nav.history.length, 2, "one peek, one entry");
  await next.querySelector("[data-drill-close]").click();
  assert.equal(next.querySelector('[aria-expanded="true"]'), null);
  assert.equal(nav.url(), "/app/today");
});

// The warm-reload case: the strip mounts on an EMPTY slot (the week read still in
// flight), the Brief then upgrades in place, and the week lands after the swap. The
// slot rides the swap (carryBriefSlots), so the paint lands on screen and is wired.
test("the strip re-wires across the Brief's in-place upgrade: a week that lands after the swap paints a live strip", async () => {
  const opened = [];
  const w = loadClientModule(
    [
      "html-utils",
      "ui-format",
      "ui-actions-client",
      "ui-reads",
      "today-main-shell-client",
      "day-detail-model",
      "day-glance-model",
      "day-detail-run-client",
      "day-detail-client",
      "day-glance-view",
      "drill-controller",
      "today-strip-client",
      "today-strip-controller",
    ],
    {
      globals: {
        ...navGlobals(),
        withBundle: (_name, fn) => fn(),
        CairnDayDetailController: { mount: (_h, deps) => (opened.push(deps.date), () => {}) },
      },
    }
  );
  const view = createHost(w.document, {
    html: `<section class="brief"><div id="todayStripSlot" class="tstrip-slot"></div><div id="briefProvenance"></div></section>`,
  });
  let land;
  const pending = new Promise((resolve) => (land = resolve));
  const slot = view.querySelector("#todayStripSlot");
  w.CairnTodayStripController.mount(slot, {
    date: TODAY,
    peek: () => null,
    load: () => pending,
  });
  assert.equal(slot.innerHTML, "", "nothing painted yet");
  // The Brief upgrades in place before the week arrives.
  const old = view.querySelector(".brief");
  const carry = w.CairnTodayMainShell.carryBriefSlots(old);
  const tmp = w.document.createElement("div");
  tmp.innerHTML = `<section class="brief"><div id="todayStripSlot" class="tstrip-slot"></div><div id="briefProvenance"></div></section>`;
  const fresh = tmp.firstElementChild;
  old.replaceWith(fresh);
  carry(fresh);
  land(week());
  await flush();
  const live = view.querySelector("#todayStripSlot");
  assert.equal(live, slot);
  assert.equal(live.querySelectorAll("button.tstrip-day").length, 7, "the strip painted on screen");
  await live.querySelector('[data-tstrip-day="2026-10-08"]').click();
  assert.deepEqual(opened, ["2026-10-08"], "and it answers a tap");
});

test("a held (snapshot) copy is never left standing: the first paint owns the whole slot", async () => {
  const w = loadStrip({ withBundle: (_n, fn) => fn(), CairnDayDetailController: { mount: () => () => {} } });
  const slot = createHost(w.document, {
    html: `<section class="tstrip" data-wired inert aria-busy="true"><ol data-tstrip-days><li>stale</li></ol></section>`,
  });
  w.CairnTodayStripController.mount(slot, {
    date: TODAY,
    peek: () => ({ data: week(), fresh: true }),
    load: () => Promise.resolve(week()),
  });
  assert.doesNotMatch(slot.innerHTML, /stale/);
  const section = slot.querySelector(".tstrip");
  assert.equal(section.hasAttribute("inert"), false, "live, not the frozen snapshot copy");
  assert.equal(slot.querySelectorAll("button.tstrip-day").length, 7);
});

test("the strip is a glance: no summary line; a recovery week lands later and repaints only the header", async () => {
  const w = loadStrip({ withBundle: (_n, fn) => fn(), CairnDayDetailController: { mount: () => () => {} } });
  const progress = { lift_days_done: 2, lift_days_planned: 5, runs_done: 1, run_km: 6.1, longest_run_km: 6.1, runs_open: [], prs: 3, line: "Two of five lifting days are in." };
  const data = { ...week(), progress, summary: "Two of five lifting days are in." };
  const slot = createHost(w.document);
  w.CairnTodayStripController.mount(slot, {
    date: TODAY,
    peek: () => ({ data, fresh: true }),
    load: () => Promise.resolve(data),
  });
  const days = slot.querySelector("[data-tstrip-days]");
  // The week's sentence and counts are Horizon's (one home per fact): none of them here.
  assert.equal(slot.querySelector(".tstrip-tally"), null);
  assert.doesNotMatch(slot.textContent, /lifting days|new best|Two of five/);
  assert.equal(w.CairnTodayStrip.tallyText, undefined);
  assert.equal(slot.querySelector("[data-tstrip-block]").textContent, "");
  w.CairnTodayStripController.setHeader(slot, { block: "Recovery week · day 2 of 7" });
  assert.equal(slot.querySelector("[data-tstrip-block]").textContent, "Recovery week · day 2 of 7");
  assert.equal(slot.querySelector("[data-tstrip-days]"), days, "the days were not rewritten");
});

// ---- Horizon's week rows ----

test("Horizon's week rows are this view's row variant over GET /api/week: rest is quiet, a done day ticked, each opens its page", () => {
  const w = loadClientModule([
    "html-utils",
    "ui-format",
    "ui-reads",
    "day-detail-model",
    "day-glance-model",
    "day-detail-client",
    "day-glance-view",
    "milestone-row-model",
    "goal-row-model",
    "week-model",
  ]);
  const chip = (date, status, lift, run) => ({
    date,
    date_words: date,
    weekday: "Mon",
    status,
    today: date === TODAY,
    lift: lift ? { day_number: 1, title: lift, heavy_lower: false, suggestion: null } : null,
    run,
    rest: !lift && !run,
    hard: false,
    words: lift || "Rest",
    load: { dose: lift ? "moderate" : "rest", word: lift ? "Moderate" : "Rest", height: lift ? 0.55 : 0.08 },
    href: null,
  });
  const read = {
    today: TODAY,
    units: { distance: "km", weight: "lb" },
    frame: {},
    days: [
      chip("2026-10-05", "done", "Upper B", null),
      chip(TODAY, "today", "Push", null),
      chip("2026-10-07", "rest", null, null),
      chip("2026-10-08", "upcoming", null, {
        kind: "quality",
        label: "Threshold intervals",
        status: "open",
        km: 8,
        distance_words: "8 km",
        rested: false,
        covered: false,
      }),
    ],
  };
  const view = w.CairnWeekModel.landing(read);
  const host = renderHtml(view.glances.map((g) => w.CairnDayGlanceView.rowHtml(g)).join(""));
  const rows = host.querySelectorAll(".pahead-day");
  assert.equal(rows.length, 4);
  assert.ok(rows[0].querySelector(".pahead-tick"), "a done day is ticked");
  assert.ok(rows[2].classList.contains("is-rest"));
  assert.equal(rows[1].getAttribute("aria-current"), "date");
  assert.match(rows[3].textContent, /Threshold intervals · 8 km/);
  assert.equal(rows[3].getAttribute("data-open-day"), "2026-10-08");
});

// ---- the day view composing it ----

test("the day view opens the shared detail, and a past day keeps its record's fuel and read under it", () => {
  const w = loadClientModule(
    [
      "html-utils",
      "ui-format",
      "format-utils",
      "ui-format",
      "ui-reads",
      "day-detail-model",
      "day-glance-model",
      "day-detail-run-client",
      "day-detail-client",
      "day-glance-view",
      "day-detail-controller",
      "day-record-client",
    ],
    {
      globals: {
        CairnUiHeader: { shortDate: (iso) => `short(${iso})`, setEyebrowTitle: () => {} },
        localISO: () => TODAY,
      },
    }
  );
  const opts = { backLabel: "Horizon", date: "2026-10-08", today: TODAY };
  const ahead = renderHtml(w.CairnDayRecord.composedHtml(null, detail(), opts));
  assert.equal(ahead.querySelector("[data-day-back]").textContent.trim(), "‹ Horizon");
  assert.equal(ahead.querySelectorAll(".dayrec-step-btn").length, 2, "the ‹ › stepper still steps");
  assert.equal(ahead.querySelector("#dayrecTitle").textContent, "A Lower B day, then threshold intervals.");
  assert.equal(ahead.querySelector(".dayrec-sec"), null, "a day ahead carries no record sections");

  const record = {
    date: "2026-10-04",
    relation: "past",
    today: TODAY,
    run_units: "km",
    session: null,
    activities: [],
    intake: { coverage: "complete", entries: 1, kcal: 2100, protein_g: 150, carbs_g: null, fat_g: null, meals: [] },
    read: { kind: "train", headline: "A Push day.", why: null },
    weight_lb: null,
    lift: null,
    run: null,
    rest: false,
    caveats: [],
    line: "Push.",
  };
  const past = renderHtml(
    w.CairnDayRecord.composedHtml(record, detail({ date: "2026-10-04", status: "done", stack: null }), {
      ...opts,
      date: "2026-10-04",
    })
  );
  assert.match(past.textContent, /2,100 kcal · 150 g protein/);
  assert.match(past.textContent, /The read that day/);
  assert.ok(past.querySelector("[data-day-log]"));
  // Past next week's end there is no detail read: the record stands alone, as before.
  const alone = renderHtml(w.CairnDayRecord.composedHtml(record, null, opts));
  assert.match(alone.querySelector(".dayrec-kicker").textContent, /the day's record/);
});
