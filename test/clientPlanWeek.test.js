// clientPlanWeek.test.js — Plan week strip HTML helpers.
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

function stagger() {
  return "";
}

function loadPlanWeek() {
  const context = { Object, Array, String, Map, Number, escHtml, escAttr, stagger };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-week-client.js"), "utf8"), context);
  return context.CairnPlanWeek;
}

test("Plan week strip renders calendar cells with escaped labels", () => {
  const week = loadPlanWeek();
  const html = week.stripHtml({
    as_of: "2026-04-20",
    week_start: "2026-04-20",
    days: [
      {
        date: "2026-04-20",
        weekday: "Mon",
        dow: 1,
        status: "today",
        plan_day: {
          day_number: 1,
          name: "Push <A>",
          focus: "Upper",
          purpose: null,
          day_type: "training",
          role: "strength",
          out_of_order: false,
        },
        session: null,
        run: null,
        hard: false,
      },
      {
        date: "2026-04-21",
        weekday: "Tue",
        dow: 2,
        status: "upcoming",
        plan_day: null,
        session: null,
        run: {
          kind: "easy",
          label: "Z2 <run>",
          status: "open",
          suggested_date: "2026-04-21",
          completion_date: null,
          km: 6,
        },
        hard: false,
      },
    ],
    summary: "Keep it <steady>",
    progress: {
      lift_days_done: 1,
      lift_days_planned: 3,
      runs_done: 0,
      run_km: 0,
      longest_run_km: null,
      runs_open: [],
      prs: 0,
      line: "One of three lifting days in. <grounded>",
    },
    layout: { clean: true, suggestion: null },
    schedule: { lift_days: ["Monday"], lift_days_source: "stated", run_days: [] },
  });

  assert.match(html, /This week/);
  assert.match(html, /pweek-lift/);
  assert.match(html, /pweek-run/);
  // The cell speaks the plan day's short NAME, not its focus sentence.
  assert.match(html, /Push &lt;A&gt;/);
  assert.doesNotMatch(html, /Upper/);
  assert.match(html, /Z2 &lt;run&gt; 6 km/);
  assert.match(html, /pweek-progress/);
  assert.match(html, /One of three lifting days in\. &lt;grounded&gt;/);
  assert.match(html, /Keep it &lt;steady&gt;/);
  assert.doesNotMatch(html, /Push <A>|Z2 <run>|Keep it <steady>/);
});

test("a done cell with a session speaks the session's title, with the run beside it", () => {
  const week = loadPlanWeek();
  const html = week.stripHtml({
    days: [
      {
        date: "2026-04-20",
        weekday: "Mon",
        dow: 1,
        status: "done",
        plan_day: {
          day_number: 2,
          name: "Push",
          focus: "Shoulders, chest, triceps",
          purpose: null,
          day_type: "training",
          role: "strength",
          out_of_order: false,
        },
        session: { id: 7, title: "Lower A", date: "2026-04-20" },
        run: {
          kind: "long",
          label: "Long run",
          status: "completed",
          suggested_date: null,
          completion_date: "2026-04-20",
          km: 9.8,
        },
        hard: true,
      },
    ],
    summary: null,
    progress: {
      lift_days_done: 1,
      lift_days_planned: 5,
      runs_done: 1,
      run_km: 9.8,
      longest_run_km: 9.8,
      runs_open: [],
      prs: 0,
      line: null,
    },
    layout: { clean: true, suggestion: null },
    schedule: { lift_days: [], lift_days_source: null, run_days: [] },
  });
  // The plan day's NAME leads (the resolved day), with the run beside it — never a focus sentence.
  assert.match(html, /Push · run in/);
  assert.doesNotMatch(html, /Shoulders, chest/);
  // The cell header already says the weekday; the status line does not repeat it.
  assert.match(html, /<span class="pweek-status lbl">Done<\/span>/);
});

test("a covered template run day says where the run landed", () => {
  const week = loadPlanWeek();
  const html = week.stripHtml({
    days: [
      {
        date: "2026-04-25",
        weekday: "Sat",
        dow: 6,
        status: "open",
        plan_day: {
          day_number: 7,
          name: "Long Run",
          focus: "Aerobic endurance",
          purpose: null,
          day_type: "training",
          role: "endurance",
          out_of_order: false,
        },
        session: null,
        run: {
          kind: "long",
          label: "Long run",
          status: "completed",
          suggested_date: null,
          completion_date: "2026-04-23",
          km: 9.8,
        },
        hard: true,
      },
    ],
    summary: null,
    progress: {
      lift_days_done: 0,
      lift_days_planned: null,
      runs_done: 1,
      run_km: 9.8,
      longest_run_km: 9.8,
      runs_open: [],
      prs: 0,
      line: null,
    },
    layout: { clean: true, suggestion: null },
    schedule: { lift_days: [], lift_days_source: null, run_days: [] },
  });
  assert.match(html, /Long run 9\.8 km · done Thu/);
  assert.match(html, /<span class="pweek-status lbl">Covered<\/span>/);
  assert.doesNotMatch(html, /Up next/);
});

test("Plan week strip omits empty weeks", () => {
  const week = loadPlanWeek();
  assert.equal(week.stripHtml(null), "");
  assert.equal(week.stripHtml({ days: [] }), "");
});

test("annotationsByDayNumber prefers today/done for a repeated day", () => {
  const week = loadPlanWeek();
  const map = week.annotationsByDayNumber({
    days: [
      { weekday: "Mon", status: "upcoming", plan_day: { day_number: 1 } },
      { weekday: "Thu", status: "today", plan_day: { day_number: 1 } },
    ],
  });
  assert.equal(map.get(1).status, "today");
  assert.equal(map.get(1).weekday, "Thu");
});

test("layout suggestion surfaces when unclean", () => {
  const week = loadPlanWeek();
  const html = week.stripHtml({
    days: [
      {
        date: "2026-04-20",
        weekday: "Mon",
        dow: 1,
        status: "open",
        plan_day: {
          day_number: 1,
          name: "Legs",
          focus: "Lower",
          purpose: null,
          day_type: "training",
          role: "strength",
          out_of_order: false,
        },
        session: null,
        run: null,
        hard: true,
      },
    ],
    summary: null,
    layout: { clean: false, suggestion: "Move Legs off Saturday's long run." },
    schedule: { lift_days: [], lift_days_source: null, run_days: [] },
  });
  assert.match(html, /Move Legs off Saturday/);
  assert.match(html, /is-hard/);
});

function liftDay(date, weekday, dow, dayNumber, name, status, run = null) {
  return {
    date,
    weekday,
    dow,
    status,
    plan_day: {
      day_number: dayNumber,
      name,
      focus: `${name} focus sentence`,
      purpose: null,
      day_type: "training",
      role: "strength",
      out_of_order: false,
    },
    session: null,
    run,
    hard: false,
  };
}

test("a lift day that also holds a run names both; only the first upcoming day is 'Up next'", () => {
  const week = loadPlanWeek();
  const easy = {
    kind: "easy",
    label: "Easy run",
    status: "open",
    suggested_date: "2026-04-23",
    completion_date: null,
    km: 7.4,
  };
  const days = [
    liftDay("2026-04-21", "Tue", 2, 2, "Pull", "today", {
      kind: "logged",
      label: "Run",
      status: "completed",
      suggested_date: null,
      completion_date: "2026-04-21",
      km: 4.1,
    }),
    liftDay("2026-04-22", "Wed", 3, 3, "Lower A", "upcoming"),
    liftDay("2026-04-23", "Thu", 4, 4, "Upper Body & Arms", "upcoming", easy),
  ];
  const html = week.stripHtml({ days, progress: { line: null }, layout: { clean: true } });
  // Today's run sits on today's cell, and the lift is still named.
  assert.match(html, /Pull · run in/);
  // The run never hides the lift it shares a day with.
  assert.match(html, /Upper Body &amp; Arms \+ easy run/);
  assert.equal(
    (html.match(/<span class="pweek-status lbl">Up next<\/span>/g) || []).length,
    1,
    "one 'Up next' cell, on Wednesday"
  );
  const ann = week.annotationsByDayNumber({ days });
  assert.equal(ann.get(3).status, "upcoming");
  assert.equal(ann.get(4).status, "open", "a later day names its weekday, not 'Up next'");
});

test("the strip prints the server's today line through the shared reading primitive", () => {
  const context = { Object, Array, String, Map, Number, escHtml, escAttr, stagger };
  context.window = context;
  const seen = [];
  context.CairnUiReads = {
    strengthLineHtml: (line, opts) => {
      seen.push([line, opts]);
      return `<div class="strength-line">${escHtml(line.text)}</div>`;
    },
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-week-client.js"), "utf8"), context);
  const line = { state: "not_started", title: "Pull", text: "Run in · Pull <still> open", caveat: null };
  const html = context.CairnPlanWeek.stripHtml({
    days: [liftDay("2026-04-21", "Tue", 2, 2, "Pull", "today")],
    progress: { line: null },
    layout: { clean: true },
    strength_line: line,
  });
  assert.match(html, /<div class="pweek-today"><div class="strength-line">Run in · Pull &lt;still&gt; open<\/div><\/div>/);
  assert.equal(seen[0][0], line, "the line object is handed over verbatim");
});

// Today's cell holding logged work the athlete has not finished says "In progress" —
// the today line's own word — never "Done" and never a bare "Today".
test("today's cell with an open session reads in progress, never done", () => {
  const week = loadPlanWeek();
  const wed = {
    ...liftDay("2026-04-22", "Wed", 3, 3, "Lower A", "today"),
    session: { id: 9, title: "Lower A", date: "2026-04-22", finished: false },
  };
  const html = week.stripHtml({ days: [wed], progress: { line: null }, layout: { clean: true } });
  assert.match(html, /<span class="pweek-status lbl">In progress<\/span>/);
  assert.match(html, /is-today/);
  assert.doesNotMatch(html, /is-done|>Done</);
  assert.equal(week.statusLine(wed), "In progress · Wed");
});

// ---- mobile dot strip + tap for detail ----

function mobileWeek() {
  const done = {
    ...liftDay("2026-04-20", "Mon", 1, 1, "Push", "done"),
    session: { id: 1, title: "Push", date: "2026-04-20", finished: true },
  };
  const today = {
    ...liftDay("2026-04-22", "Wed", 3, 3, "Lower A", "today"),
    session: { id: 2, title: "Lower A", date: "2026-04-22", finished: false },
  };
  const rest = { date: "2026-04-21", weekday: "Tue", dow: 2, status: "rest", plan_day: null, session: null, run: null, hard: false };
  const next = liftDay("2026-04-23", "Thu", 4, 4, "Upper <B>", "upcoming");
  return {
    week_start: "2026-04-20",
    days: [done, rest, today, next],
    progress: { line: null },
    layout: { clean: true },
    strength_line: { state: "in_progress", title: "Lower A", text: "Lower A · in progress", caveat: null },
  };
}

function loadWithReads() {
  const context = { Object, Array, String, Map, Number, escHtml, escAttr, stagger };
  context.window = context;
  context.CairnUiReads = {
    strengthLineHtml: (line, opts) =>
      `<div class="strength-line">${opts?.kicker ? `<span class="strength-line-k lbl">${escHtml(opts.kicker)}</span>` : ""}<span class="strength-line-t">${escHtml(line.text)}</span></div>`,
  };
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-week-client.js"), "utf8"), context);
  return context.CairnPlanWeek;
}

test("every day is a real button with a token, and today is selected by default", () => {
  const html = loadWithReads().stripHtml(mobileWeek());
  assert.equal((html.match(/<button type="button" class="pweek-day /g) || []).length, 4);
  assert.match(html, /data-plan-week data-pweek-week="2026-04-20" data-pweek-default="2"/);
  // Done is a check; rest keeps its quiet mark; the today cell is pressed.
  assert.match(html, /is-done[^>]*data-pweek-day="1"[^>]*>[\s\S]*?<span class="pweek-token" aria-hidden="true">✓<\/span>/);
  assert.match(html, /is-rest[^>]*>[\s\S]*?<span class="pweek-token" aria-hidden="true">·<\/span>/);
  assert.match(html, /is-today is-selected[^>]*data-pweek-i="2" data-pweek-day="3" aria-pressed="true" aria-label="Wed, Lower A, in progress"/);
  assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
  assert.match(html, /aria-label="Thu, Upper &lt;B&gt;, up next"/);
});

test("the detail line shows the selected day; today's speaks the server line once", () => {
  const html = loadWithReads().stripHtml(mobileWeek());
  const panels = html
    .split('<div class="pweek-detail" ')
    .slice(1)
    .map((chunk) => /^data-pweek-panel="(\d)"( hidden)?>([\s\S]*)$/.exec(chunk));
  assert.equal(panels.length, 4);
  assert.deepEqual(panels.filter((p) => !p[2]).map((p) => p[1]), ["2"], "only today's panel shows");
  const todayPanel = panels.find((p) => p[1] === "2")[3];
  assert.match(todayPanel, /<span class="pweek-detail-k lbl">Today · Wed<\/span>/);
  assert.match(todayPanel, /<span class="strength-line-t">Lower A · in progress<\/span>/);
  assert.doesNotMatch(todayPanel, /strength-line-k/, "the panel already names the day");
  const nextPanel = panels.find((p) => p[1] === "3")[3];
  assert.match(nextPanel, /<span class="pweek-detail-name">Upper &lt;B&gt;<\/span><span class="pweek-detail-status">Up next<\/span>/);
});

test("with no today, the next upcoming day is the default; template mode starts on day 1", () => {
  const week = loadWithReads();
  const calendar = mobileWeek();
  calendar.days = calendar.days.filter((d) => d.status !== "today");
  assert.match(week.stripHtml(calendar), /data-pweek-default="2"/);
  const template = {
    days: [
      { ...liftDay(null, null, null, 1, "Push", "upcoming") },
      { ...liftDay(null, null, null, 2, "Pull", "today") },
    ],
    progress: { line: null },
    layout: { clean: true },
  };
  const html = week.stripHtml(template);
  assert.match(html, /data-pweek-week="template" data-pweek-default="0"/);
  assert.match(html, /aria-label="Day 1, Push, up next"/);
});

function fakeRoot(html) {
  const buttons = [...html.matchAll(/data-pweek-i="(\d)"/g)].map((m) => {
    const classes = new Set();
    const attrs = { "data-pweek-i": m[1] };
    return {
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: (c) => classes.has(c) },
      getAttribute: (n) => attrs[n] ?? null,
      setAttribute: (n, v) => (attrs[n] = v),
      attrs,
    };
  });
  const panels = [...html.matchAll(/data-pweek-panel="(\d)"( hidden)?/g)].map((m) => {
    const attrs = { "data-pweek-panel": m[1] };
    if (m[2]) attrs.hidden = "";
    return { getAttribute: (n) => attrs[n] ?? null, setAttribute: (n, v) => (attrs[n] = v), removeAttribute: (n) => delete attrs[n], attrs };
  });
  const rootAttrs = {
    "data-pweek-week": /data-pweek-week="([^"]*)"/.exec(html)[1],
    "data-pweek-default": /data-pweek-default="([^"]*)"/.exec(html)[1],
  };
  return {
    buttons,
    panels,
    getAttribute: (n) => rootAttrs[n] ?? null,
    querySelectorAll: (sel) => (sel === "[data-pweek-i]" ? buttons : panels),
  };
}

test("tapping a token swaps the detail, tapping it again returns to today, and a re-render keeps the pick", () => {
  const week = loadWithReads();
  const payload = mobileWeek();
  const root = fakeRoot(week.stripHtml(payload));
  week.pickDay(root, 3);
  assert.equal(root.buttons[3].attrs["aria-pressed"], "true");
  assert.equal(root.buttons[2].attrs["aria-pressed"], "false");
  assert.equal("hidden" in root.panels[3].attrs, false);
  assert.equal("hidden" in root.panels[2].attrs, true);
  // A soft re-render of the same week keeps Thursday selected.
  assert.match(week.stripHtml(payload), /is-selected[^>]*data-pweek-i="3"[^>]*aria-pressed="true"/);
  // Tapping the selected one again returns to the default (today).
  week.pickDay(root, 3);
  assert.equal(root.buttons[2].attrs["aria-pressed"], "true");
  assert.equal("hidden" in root.panels[2].attrs, false);
  assert.match(week.stripHtml(payload), /is-today is-selected/);
});

// ---- the aria-pressed toggle is honest about doing nothing at ≥720px ----
// CSS hides .pweek-token/.pweek-under/.pweek-details at 720px+ (every cell already
// prints its own weekday/glyph/label/status there), so a tap that reached pickDay
// on a desktop layout would flip aria-pressed without anything on screen actually
// changing. The delegated click handler must not call pickDay outside the mobile
// layout matchMedia reports.
test("the delegated tap only reaches pickDay in the mobile layout; the desktop layout is inert", () => {
  class Element {}
  class FakeEl extends Element {
    constructor(attrs, parent = null) {
      super();
      this.attrs = attrs;
      this.parent = parent;
    }
    getAttribute(n) {
      return this.attrs[n] ?? null;
    }
    setAttribute(n, v) {
      this.attrs[n] = v;
    }
    closest(sel) {
      let el = this;
      while (el) {
        if (sel === "[data-pweek-i]" && "data-pweek-i" in el.attrs) return el;
        if (sel === "[data-plan-week]" && "data-plan-week" in el.attrs) return el;
        el = el.parent;
      }
      return null;
    }
  }

  let clickHandler = null;
  const fakeDocument = {
    addEventListener(type, handler) {
      if (type === "click") clickHandler = handler;
    },
  };
  let mobileMatches = false;
  const context = {
    Object,
    Array,
    String,
    Map,
    Number,
    escHtml,
    escAttr,
    stagger,
    Element,
    document: fakeDocument,
    matchMedia: (query) => ({ matches: query.includes("max-width") ? mobileMatches : false }),
  };
  context.window = context;
  vm.runInNewContext(readFileSync(join(root, "public/js/plan-week-client.js"), "utf8"), context);
  const week = context.CairnPlanWeek;
  assert.equal(typeof clickHandler, "function", "the delegated click listener registered");

  const rootEl = new FakeEl({ "data-plan-week": "1", "data-pweek-week": "2026-04-20", "data-pweek-default": "0" });
  let queried = false;
  rootEl.querySelectorAll = () => {
    queried = true;
    return [];
  };
  const btn = new FakeEl({ "data-pweek-i": "1" }, rootEl);

  mobileMatches = false;
  clickHandler({ target: btn });
  assert.equal(queried, false, "a desktop tap never reaches pickDay — nothing on screen would change");
  assert.equal(week.isMobilePweekLayout(), false);

  mobileMatches = true;
  clickHandler({ target: btn });
  assert.equal(queried, true, "a mobile tap still swaps the detail");
  assert.equal(week.isMobilePweekLayout(), true);
});
